/**
 * Tests for the tools/execute injection phase (issue #1) plus regression
 * coverage for the existing llm/stream behavior.
 *
 * Run with: node --test test/
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../index.js'

/** Record every fetch the plugin (and the code under test) performs. */
function installFetchRecorder() {
  const calls = []
  const original = globalThis.fetch
  const fn = async (input, init) => {
    const headers = new Headers(input instanceof Request ? input.headers : undefined)
    if (init?.headers !== undefined) {
      for (const [key, value] of new Headers(init.headers)) headers.set(key, value)
    }
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.href : input?.url
    calls.push({ url, headers })
    return new Response('ok', { status: 200 })
  }
  globalThis.fetch = fn
  return {
    fn,
    original,
    calls,
    restore() {
      globalThis.fetch = original
    },
  }
}

/** Cordis-like context stub: captures on() handlers, runs effect() setup. */
function makeContext() {
  const handlers = new Map()
  const disposers = []
  const ctx = {
    logger: { warn() {} },
    on(event, handler) {
      handlers.set(event, handler)
    },
    effect(fn) {
      disposers.push(fn())
    },
  }
  return { ctx, handlers, disposers }
}

/** Install recorder, apply plugin, and wire automatic cleanup. */
function boot(t, config = {}) {
  const recorder = installFetchRecorder()
  const { ctx, handlers, disposers } = makeContext()
  apply(ctx, config)
  t.after(() => {
    for (const dispose of disposers) dispose?.()
    recorder.restore()
  })
  return { ctx, handlers, recorder }
}

test('tools/execute: injects header when URL matches a configured endpoint prefix', async (t) => {
  const { handlers, recorder } = boot(t, {
    header: 'x-opencode-session',
    toolEndpoints: ['https://gateway.example.com/'],
  })
  const exec = { agent: { id: 'session-uuid-123' } }
  const next = async () => {
    await fetch('https://gateway.example.com/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    })
  }
  await handlers.get('tools/execute')(exec, next)
  assert.equal(recorder.calls.length, 1)
  const headers = recorder.calls[0].headers
  assert.equal(headers.get('x-opencode-session'), 'uuid-123')
  assert.equal(headers.get('content-type'), 'application/json')
})

test('tools/execute: leaves third-party tool URLs untouched', async (t) => {
  const { handlers, recorder } = boot(t, {
    header: 'x-opencode-session',
    toolEndpoints: ['https://gateway.example.com/'],
  })
  const exec = { agent: { id: 'session-uuid-123' } }
  const next = async () => {
    await fetch('https://web.example.org/page', { headers: { a: 'b' } })
    await fetch('https://gateway.example.com/messages')
  }
  await handlers.get('tools/execute')(exec, next)
  assert.equal(recorder.calls.length, 2)
  assert.equal(recorder.calls[0].url, 'https://web.example.org/page')
  assert.equal(recorder.calls[0].headers.has('x-opencode-session'), false)
  assert.equal(recorder.calls[1].url, 'https://gateway.example.com/messages')
  assert.equal(recorder.calls[1].headers.get('x-opencode-session'), 'uuid-123')
})

test('tools/execute: default (no toolEndpoints) keeps upstream behavior — no injection', async (t) => {
  const { handlers, recorder } = boot(t, { header: 'x-opencode-session' })
  const exec = { agent: { id: 'session-uuid-123' } }
  let ran = false
  const next = async () => {
    ran = true
    await fetch('https://gateway.example.com/messages')
  }
  await handlers.get('tools/execute')(exec, next)
  assert.equal(ran, true)
  assert.equal(recorder.calls.length, 1)
  assert.equal(recorder.calls[0].headers.has('x-opencode-session'), false)
})

test('tools/execute: no agent session id means no injection even when matched', async (t) => {
  const { handlers, recorder } = boot(t, { toolEndpoints: ['https://gateway.example.com/'] })
  const exec = { agent: {} }
  const next = async () => {
    await fetch('https://gateway.example.com/messages')
  }
  await handlers.get('tools/execute')(exec, next)
  assert.equal(recorder.calls.length, 1)
  assert.equal(recorder.calls[0].headers.has('x-session-id'), false)
})

test('tools/execute: fixed config.value wins over the agent session id', async (t) => {
  const { handlers, recorder } = boot(t, {
    header: 'x-opencode-session',
    value: 'fixed-value',
    toolEndpoints: ['https://gateway.example.com/'],
  })
  const exec = { agent: { id: 'session-uuid-123' } }
  const next = async () => {
    await fetch('https://gateway.example.com/messages')
  }
  await handlers.get('tools/execute')(exec, next)
  assert.equal(recorder.calls.length, 1)
  assert.equal(recorder.calls[0].headers.get('x-opencode-session'), 'fixed-value')
})

test('tools/execute: URL object input is matched by prefix', async (t) => {
  const { handlers, recorder } = boot(t, {
    header: 'x-opencode-session',
    toolEndpoints: ['https://gateway.example.com/'],
  })
  const exec = { agent: { id: 'session-uuid-123' } }
  const next = async () => {
    await fetch(new URL('https://gateway.example.com/v1/messages'))
  }
  await handlers.get('tools/execute')(exec, next)
  assert.equal(recorder.calls.length, 1)
  assert.equal(recorder.calls[0].headers.get('x-opencode-session'), 'uuid-123')
})

// --- overwriteHeaders: replace placeholder values hard-coded by official plugins ---

test('tools/execute: overwriteHeaders replaces an existing placeholder header value', async (t) => {
  const { handlers, recorder } = boot(t, {
    header: 'x-opencode-session',
    overwriteHeaders: ['x-opencode-session'],
    toolEndpoints: ['https://gateway.example.com/'],
  })
  const exec = { agent: { id: 'session-uuid-123' } }
  const next = async () => {
    // Simulates dsh-web-search-deepseek's hard-coded placeholder header.
    await fetch('https://gateway.example.com/messages', {
      headers: { 'x-opencode-session': 'dsh-web-search' },
    })
  }
  await handlers.get('tools/execute')(exec, next)
  assert.equal(recorder.calls.length, 1)
  assert.equal(recorder.calls[0].headers.get('x-opencode-session'), 'uuid-123')
})

test('tools/execute: header NOT listed in overwriteHeaders stays untouched', async (t) => {
  const { handlers, recorder } = boot(t, {
    header: 'x-opencode-session',
    overwriteHeaders: ['another-header'],
    toolEndpoints: ['https://gateway.example.com/'],
  })
  const exec = { agent: { id: 'session-uuid-123' } }
  const next = async () => {
    await fetch('https://gateway.example.com/messages', {
      headers: { 'x-opencode-session': 'dsh-web-search' },
    })
  }
  await handlers.get('tools/execute')(exec, next)
  assert.equal(recorder.calls.length, 1)
  assert.equal(recorder.calls[0].headers.get('x-opencode-session'), 'dsh-web-search')
})

test('llm/stream: overwriteHeaders also applies in the LLM scope', async (t) => {
  const { handlers, recorder } = boot(t, {
    header: 'x-opencode-session',
    overwriteHeaders: ['x-opencode-session'],
  })
  async function* inner() {
    await fetch('https://llm.example.com/v1/messages', {
      headers: { 'x-opencode-session': 'placeholder' },
    })
    yield 'chunk-1'
  }
  const gen = handlers.get('llm/stream')({ sessionId: 'session-abc' }, () => inner())
  for await (const _ of gen) { /* drain */ }
  assert.equal(recorder.calls.length, 1)
  assert.equal(recorder.calls[0].headers.get('x-opencode-session'), 'abc')
})

// --- llm/stream regression (existing behavior must not change) ---

test('llm/stream: still injects unconditionally with the live session id', async (t) => {
  const { handlers, recorder } = boot(t, { header: 'x-session-id' })
  async function* inner() {
    await fetch('https://llm.example.com/v1/chat/completions')
    yield 'chunk-1'
    yield 'chunk-2'
  }
  const gen = handlers.get('llm/stream')({ sessionId: 'session-abc' }, () => inner())
  const chunks = []
  for await (const chunk of gen) chunks.push(chunk)
  assert.deepEqual(chunks, ['chunk-1', 'chunk-2'])
  assert.equal(recorder.calls.length, 1)
  assert.equal(recorder.calls[0].headers.get('x-session-id'), 'abc')
})

test('llm/stream: never overwrites a header someone else already set', async (t) => {
  const { handlers, recorder } = boot(t, { header: 'x-session-id' })
  async function* inner() {
    await fetch('https://llm.example.com/v1/chat', { headers: { 'x-session-id': 'already-set' } })
    yield 'chunk-1'
  }
  const gen = handlers.get('llm/stream')({ sessionId: 'session-abc' }, () => inner())
  for await (const _ of gen) { /* drain */ }
  assert.equal(recorder.calls.length, 1)
  assert.equal(recorder.calls[0].headers.get('x-session-id'), 'already-set')
})

test('unloading restores the fetch that was installed before apply', async (t) => {
  const recorder = installFetchRecorder()
  const { ctx, disposers } = makeContext()
  apply(ctx, {})
  const patched = globalThis.fetch
  assert.notEqual(patched, recorder.fn)
  for (const dispose of disposers) dispose?.()
  assert.equal(globalThis.fetch, recorder.fn)
  recorder.restore()
})

// --- review follow-ups: Request spelling, case-insensitive overwrite, boundary ---

test('tools/execute: Request input matching the whitelist is injected', async (t) => {
  const { handlers, recorder } = boot(t, {
    header: 'x-opencode-session',
    overwriteHeaders: ['x-opencode-session'],
    toolEndpoints: ['https://gateway.example.com/'],
  })
  const exec = { agent: { id: 'session-uuid-123' } }
  const next = async () => {
    const request = new Request('https://gateway.example.com/messages', {
      method: 'POST',
      headers: { 'x-opencode-session': 'dsh-web-search' },
    })
    await fetch(request)
  }
  await handlers.get('tools/execute')(exec, next)
  assert.equal(recorder.calls.length, 1)
  assert.equal(recorder.calls[0].headers.get('x-opencode-session'), 'uuid-123')
})

test('tools/execute: Request input NOT matching the whitelist passes through untouched', async (t) => {
  const { handlers, recorder } = boot(t, {
    header: 'x-opencode-session',
    toolEndpoints: ['https://gateway.example.com/'],
  })
  const exec = { agent: { id: 'session-uuid-123' } }
  const next = async () => {
    const request = new Request('https://other.example.org/messages', {
      method: 'POST',
      headers: { 'x-opencode-session': 'dsh-web-search' },
    })
    await fetch(request)
  }
  await handlers.get('tools/execute')(exec, next)
  assert.equal(recorder.calls.length, 1)
  assert.equal(recorder.calls[0].url, 'https://other.example.org/messages')
  assert.equal(recorder.calls[0].headers.get('x-opencode-session'), 'dsh-web-search')
})

test('tools/execute: sibling domain never matches (host boundary)', async (t) => {
  const { handlers, recorder } = boot(t, {
    header: 'x-opencode-session',
    toolEndpoints: ['https://gateway.example.com'], // no trailing slash on purpose
  })
  const exec = { agent: { id: 'session-uuid-123' } }
  const next = async () => {
    await fetch('https://gateway.example.com.evil.io/messages')
    await fetch('https://gateway.example.com/messages')
  }
  await handlers.get('tools/execute')(exec, next)
  assert.equal(recorder.calls.length, 2)
  assert.equal(recorder.calls[0].url, 'https://gateway.example.com.evil.io/messages')
  assert.equal(recorder.calls[0].headers.has('x-opencode-session'), false)
  assert.equal(recorder.calls[1].url, 'https://gateway.example.com/messages')
  assert.equal(recorder.calls[1].headers.get('x-opencode-session'), 'uuid-123')
})

test('tools/execute: path prefix respects boundaries (/v1 not /v10)', async (t) => {
  const { handlers, recorder } = boot(t, {
    header: 'x-opencode-session',
    toolEndpoints: ['https://gateway.example.com/zen/go/v1'],
  })
  const exec = { agent: { id: 'session-uuid-123' } }
  const next = async () => {
    await fetch('https://gateway.example.com/zen/go/v10/messages')
    await fetch('https://gateway.example.com/zen/go/v1/messages')
  }
  await handlers.get('tools/execute')(exec, next)
  assert.equal(recorder.calls.length, 2)
  assert.equal(recorder.calls[0].headers.has('x-opencode-session'), false)
  assert.equal(recorder.calls[1].headers.get('x-opencode-session'), 'uuid-123')
})

test('tools/execute: case-insensitive overwrite of a placeholder header', async (t) => {
  const { handlers, recorder } = boot(t, {
    header: 'x-opencode-session',
    overwriteHeaders: ['X-OPENCODE-SESSION'], // deliberately different case
    toolEndpoints: ['https://gateway.example.com/'],
  })
  const exec = { agent: { id: 'session-uuid-123' } }
  const next = async () => {
    await fetch('https://gateway.example.com/messages', {
      headers: { 'X-OPENCODE-SESSION': 'dsh-web-search' }, // different case on wire
    })
  }
  await handlers.get('tools/execute')(exec, next)
  assert.equal(recorder.calls.length, 1)
  assert.equal(recorder.calls[0].headers.get('x-opencode-session'), 'uuid-123')
})
