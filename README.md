# dsh-session-header

English | [中文](README.zh.md)

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that injects an `x-session-id` HTTP header onto **every LLM provider request** the harness sends, carrying the **harness session id of that exact call**.

## Why

The harness has no per-request header seam — `GenerateOptions` has no headers field and every adapter builds its own wire headers internally. If your model gateway (or an intermediary proxy) keys routing, caching, or auditing on a session header, the harness cannot send one by itself.

This plugin closes that gap with the two official interception points composed together:

- the **`llm/stream` waterfall** names the calls that are LLM calls and carries `options.sessionId`;
- a **`globalThis.fetch` patch** adds the header, so every fetch-based adapter (`llm-deepseek`, `llm-pi-ai`, and any SDK whose transport bottoms out in global fetch) is covered without touching adapter code.

Context propagation uses `AsyncLocalStorage`: only fetches that happen inside an LLM call's stream are touched; unrelated fetches (web RPC, telemetry, tool traffic) pass through untouched. A header anyone else already set is never overwritten (case-insensitive, per HTTP semantics). Unloading the plugin restores the original `fetch`.

Semantics of the value:

- default: `GenerateOptions.sessionId` of the call in flight, with the harness's `session-` branding prefix stripped (a plain UUID is sent) — main-session turns, compaction/title helper calls, and in-process subagent children each report **their own** session id (subagents get their own child session ids);
- `value` config: a fixed value for every call instead (sent verbatim, no prefix stripping);
- calls with neither get no header.

## Install

Requires the `dsh` CLI and Node ≥ 22.

### As a bundle (recommended)

```sh
dsh plugin --profile <name> add github:homily707/dsh-session-header
```

This package is plain JavaScript with no build scripts, so the pnpm ≥ 10 build allowance is not needed. Verify the layer and boot:

```sh
dsh --profile <name> --dump-config   # look for the "# == dsh-session-header" layer
dsh --profile <name>
```

### As a `--patch` overlay from a local checkout

```yaml
# my-overlay.yml — plugin rows need an absolute module path here
- insert:
    - id: session-header
      name: /absolute/path/to/dsh-session-header/index.js
      config:
        header: x-session-id
        # value: my-fixed-session-id
```

```sh
dsh --patch ./my-overlay.yml
```

## Configuration

| field | type | default | meaning |
| --- | --- | --- | --- |
| `header` | string | `x-session-id` | header name to inject; case-insensitive on the wire |
| `value` | string | — | fixed value; unset = the harness session id of the call in flight |
| `toolEndpoints` | string[] | `[]` | URL prefixes matched during tool execution. When non-empty, fetches inside a `tools/execute` waterfall — e.g. a gateway web-search Messages API called from a tool — get the header only when their URL starts with one of these prefixes; third-party tool targets (web_fetch of arbitrary pages, GitHub, MCP servers) stay untouched. Empty (default) keeps the upstream LLM-only injection. |
| `overwriteHeaders` | string[] | `[]` | Header names this plugin may overwrite when they already carry a value. Everything else keeps the "never overwrite" rule. Some official providers hard-code placeholder values (e.g. `dsh-web-search-deepseek` sends `x-opencode-session: dsh-web-search`), which gateways reject as missing; list the header here (`overwriteHeaders: [x-opencode-session]`) so the live session id replaces that placeholder. Case-insensitive. |

## Verify it

Point a provider's `baseURL` at a logging gateway (or any endpoint that echoes request headers) and start a session:

```
x-session-id: ba104306-a748-4052-a6e3-ab60be2e4c1f
```

Every request of the same conversation carries the same id; a spawned subagent's requests carry the child session id.

## Notes

- The `llm-deepseek` adapter already sends its own `x-deepseek-harness-session-id` on every request; this plugin is provider-neutral and intentional about not overwriting existing headers.
- `attributionHeaders()` (the harness User-Agent attribution contract) is never touched.
- Concurrent sessions are handled correctly: the header value is resolved per call through AsyncLocalStorage, not through shared mutable state.

## License

[MIT](LICENSE)
