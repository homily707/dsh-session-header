/**
 * Inject one HTTP header (default `x-session-id`) onto every LLM provider
 * request the harness sends, carrying the harness session id of that exact
 * call — so turns, compaction/title helper calls, and in-process subagent
 * children each report their own session.
 *
 * The harness has no per-request header seam: `GenerateOptions` carries no
 * headers field, and each adapter builds its own wire headers inside
 * `stream()`. The two official interception points compose into one here:
 *
 * - the `llm/stream` waterfall names the calls that are LLM calls and carries
 *   `options.sessionId`, and
 * - a `globalThis.fetch` patch adds the header, so every fetch-based adapter
 *   (llm-deepseek, llm-pi-ai, and any SDK whose transport bottoms out in
 *   global fetch) is covered without touching adapter code.
 *
 * Context propagation uses AsyncLocalStorage: each `iterator.next()` resumes
 * the adapter's stream inside `als.run()`, so the adapter's internal `fetch`
 * lands in the store, while unrelated fetches (web RPC, telemetry, tools)
 * see no store and pass through untouched.
 *
 * A fixed value can be configured instead of the live session id (sent
 * verbatim); the live id's `session-` branding prefix is stripped so a plain
 * UUID goes on the wire. Calls with neither a configured value nor a session
 * id get no header. A header anyone else already set is never overwritten
 * (`Headers` matching is case-insensitive, the same rule the wire uses).
 * Unloading the plugin restores the original fetch.
 *
 * @module dsh-session-header
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import Schema from '@deepseek-ai/schemastery'

export const name = 'dsh-session-header'

// Hard dependency: nothing to do until the llm runtime exists.
export const inject = ['llm']

export const Config = Schema.object({
  /** Header name to inject; HTTP field names are case-insensitive on the wire. */
  header: Schema.string().default('x-session-id'),
  /**
   * Fixed header value. Unset means "use the harness session id of the call
   * in flight" (`GenerateOptions.sessionId`); calls with neither get no header.
   */
  value: Schema.string(),
  /**
   * URL prefixes matched during tool execution. When non-empty, fetches that
   * happen inside a `tools/execute` waterfall (tool calls such as a web-search
   * Messages API against your model gateway) get the header ONLY when their
   * URL starts with one of these prefixes. Third-party tool targets (web_fetch
   * of arbitrary pages, GitHub, MCP servers, ...) stay untouched. Empty (the
   * default) keeps the upstream single-scope behavior: only LLM provider
   * requests are injected.
   */
  toolEndpoints: Schema.array(Schema.string()).default([]),
  /**
   * Header names this plugin is allowed to OVERWRITE when they already carry a
   * value. Everything else keeps the "never overwrite" rule. Some official
   * providers hard-code placeholder values (e.g. dsh-web-search-deepseek sends
   * `x-opencode-session: dsh-web-search`), which a gateway rejects as missing;
   * listing the header here lets the live session id replace that placeholder.
   * Case-insensitive match, default empty = never overwrite.
   */
  overwriteHeaders: Schema.array(Schema.string()).default([]),
})

/**
 * Plugin entry. `config.header` names the header, `config.value` optionally
 * fixes its value; per call, the AsyncLocalStorage store carries both plus the
 * resolved value, and a present store marks "this is an LLM fetch".
 */
export function apply(ctx, config) {
  const als = new AsyncLocalStorage()
  const originalFetch = globalThis.fetch

  // Pre-compile toolEndpoints into origin-anchored matchers so the whitelist
  // can never match a sibling domain: `https://gateway.example.com` must not
  // match `https://gateway.example.com.evil.io/x`. The URL parser normalizes
  // host casing and default ports; the path comparison then enforces a
  // boundary character so `/zen/go/v1` matches `/zen/go/v1/messages` but not
  // `/zen/go/v10`. Unparseable or non-http(s) prefixes are dropped (fail
  // closed: a broken prefix simply never matches, so no header is sent).
  const endpointMatchers = (config.toolEndpoints ?? [])
    .map((prefix) => {
      let parsed
      try {
        parsed = new URL(prefix)
      } catch {
        ctx.logger.warn(`dsh-session-header: ignoring unparseable toolEndpoint ${JSON.stringify(prefix)}`)
        return undefined
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        ctx.logger.warn(`dsh-session-header: ignoring non-http(s) toolEndpoint ${JSON.stringify(prefix)}`)
        return undefined
      }
      return { origin: parsed.origin, path: parsed.pathname }
    })
    .filter((entry) => entry !== undefined)

  const urlMatchesEndpoint = (input) => {
    let target
    try {
      const raw =
        typeof input === 'string' ? input : input instanceof URL ? input.href : input?.url
      if (typeof raw !== 'string') return false
      target = new URL(raw)
    } catch {
      return false
    }
    return endpointMatchers.some(({ origin, path }) => {
      if (target.origin !== origin) return false
      if (path === '/') return true
      const pathname = target.pathname
      return (
        pathname === path ||
        (pathname.startsWith(path) &&
          (path.endsWith('/') || pathname[path.length] === '/' || pathname[path.length] === '?' || pathname[path.length] === '#'))
      )
    })
  }

  const patchedFetch = (input, init) => {
    const injection = als.getStore()
    if (injection === undefined || injection.value === undefined) {
      return originalFetch(input, init)
    }
    // Tool-phase scopes carry the whitelist gate; skip fetches that do not
    // target one of the configured endpoints so the session id never leaks to
    // third-party hosts the tools talk to.
    if (injection.match !== undefined && !urlMatchesEndpoint(input)) {
      return originalFetch(input, init)
    }
    // Collect headers from both fetch() spellings: a Request object carries
    // its own, and init.headers overrides them per the fetch standard.
    const headers = new Headers(input instanceof Request ? input.headers : undefined)
    if (init?.headers !== undefined) {
      for (const [key, value] of new Headers(init.headers)) headers.set(key, value)
    }
    // Inject only when absent — unless the header is explicitly listed in
    // `overwriteHeaders`, in which case the live session id replaces whatever
    // placeholder value another layer (an official provider) hard-coded.
    const overwriteList = injection.overwrite ?? []
    if (
      headers.has(injection.header) &&
      !overwriteList.some((name) => name.toLowerCase() === injection.header.toLowerCase())
    ) {
      return originalFetch(input, init)
    }
    headers.set(injection.header, injection.value)
    // A bare Request input owns its headers; rebuild it so the original —
    // which may be reused by the caller — keeps arriving providers without us.
    if (input instanceof Request && init === undefined) {
      return originalFetch(new Request(input, { headers }))
    }
    return originalFetch(input, { ...init, headers })
  }

  globalThis.fetch = patchedFetch
  // cordis `ctx.effect`: the callback runs IMMEDIATELY (setup); its RETURN
  // VALUE is the disposer collected for fiber unload. v0.1.0 ran the restore
  // in the callback body — undoing the patch in the same tick — so the fix
  // returns the restore as the disposer.
  ctx.effect(() => () => {
    if (globalThis.fetch === patchedFetch) {
      globalThis.fetch = originalFetch
    } else {
      // Someone else replaced fetch after we loaded; their patch fronts ours,
      // so restoring ours would silently drop theirs.
      ctx.logger.warn('dsh-session-header: global fetch was replaced after load; not restoring')
    }
  })

  ctx.on('llm/stream', async function* (options, next) {
    const inner = next()
    const iterator = inner[Symbol.asyncIterator]()
    const scope = {
      header: config.header,
      value:
        config.value ??
        (options.sessionId !== undefined ? String(options.sessionId).replace(/^session-/, '') : undefined),
      overwrite: config.overwriteHeaders ?? [],
    }
    let exhausted = false
    try {
      while (true) {
        // Each adapter step runs inside the store, so its internal fetch
        // (whenever in the call it happens) sees this call's injection facts.
        const result = await als.run(scope, () => iterator.next())
        if (result.done) {
          exhausted = true
          return
        }
        yield result.value
      }
    } finally {
      if (!exhausted) await iterator.return?.()
    }
  })

  // Tool execution happens BETWEEN two streamed turns — outside any
  // `llm/stream` scope — so gateway calls made from inside a tool (e.g. an
  // Anthropic-compatible web-search Messages API against the same baseURL)
  // used to miss the header entirely. The `tools/execute` waterfall carries
  // `exec.agent.id` = the harness session id of the agent running the tool
  // (main session, compaction/title helpers, and in-process subagents each
  // report their own). Cover the whole promise chain in a scope so every
  // fetch the tool awaits is a candidate — then let the whitelist decide.
  ctx.on('tools/execute', async (exec, next) => {
    const endpoints = config.toolEndpoints ?? []
    const agentId = exec.agent?.id
    // Empty agent id (not just missing) also means "no session to report":
    // both scopes share the same no-value ⇒ no-header semantics.
    if (
      agentId === undefined ||
      typeof agentId !== 'string' ||
      agentId.length === 0 ||
      endpoints.length === 0
    ) {
      return next()
    }
    const scope = {
      header: config.header,
      value:
        config.value ?? String(agentId).replace(/^session-/, ''),
      match: endpoints,
      overwrite: config.overwriteHeaders ?? [],
    }
    return als.run(scope, () => next())
  })
}
