// Plugin-entry integration tests: apply() over a fake Cordis context.
//
// Covers the Host wiring that unit tests of the service cannot: route
// registration through ctx.connection.fetch.register (streaming body), the
// 413 bounded-read path, config persistence through configEditor.edit, and
// ctx.effect disposal.
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply } from '../src/host/index.js'

// 隔离 DSH_HOME：apply() 会创建真实 ledger/results 写入目录，测试必须用临时目录。
const testHome = await mkdtemp(join(tmpdir(), 'nmp-host-test-'))
process.env.DSH_HOME = testHome
delete process.env.NMP_DATA_HOME
after(async () => {
  await rm(testHome, { recursive: true, force: true }).catch(() => {})
})

const ROUTE = '/api/next-message-predictor/rpc'

function fakeContext(options) {
  const routes = new Map()
  const effects = []
  const edits = []
  const listeners = new Map()
  const state = {
    sessions: options?.sessions ?? { s1: { id: 's1', seq: 8 } },
    allowConfigEditor: options?.allowConfigEditor !== false,
    entryConfig: options?.entryConfig ?? {},
  }
  const ctx = {
    fiber: { entry: { id: 'next-message-predictor', options: { id: 'next-message-predictor', config: state.entryConfig } } },
    get(name) {
      if (name === 'connection') {
        return {
          fetch: {
            register(route) {
              routes.set(route.path, route)
              return () => routes.delete(route.path)
            },
          },
        }
      }
      if (name === 'configEditor') {
        if (!state.allowConfigEditor) return undefined
        return {
          async edit(entry, change) {
            const next = change(state.entryConfig, {})
            state.entryConfig = next
            edits.push(next)
            return undefined
          },
        }
      }
      if (name === 'sessions') {
        return { get: (id) => state.sessions[id] }
      }
      return undefined
    },
    effect(fn) {
      const disposer = fn()
      effects.push(disposer)
      return disposer
    },
    on(name, listener) {
      const list = listeners.get(name) ?? []
      list.push(listener)
      listeners.set(name, list)
    },
  }
  const finishTurn = (kind = 'completed') => {
    for (const listener of listeners.get('session/event') ?? []) {
      listener(state.sessions.s1, { type: 'turn/end', seq: 7, data: { turn: 1, reason: { kind } } })
    }
  }
  const emitEvent = (event) => {
    for (const listener of listeners.get('session/event') ?? []) {
      listener(state.sessions.s1, event)
    }
  }
  return { ctx, routes, effects, edits, state, finishTurn, emitEvent }
}

function jsonRequest(body) {
  return new Request(`http://127.0.0.1:1${ROUTE}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

function anchor() {
  return {
    sessionId: 's1',
    branchEpoch: 'v1',
    turnId: 't1a3',
    completedEventSeq: 7,
    contextRevision: '4:3',
  }
}

function predictBody(overrides) {
  return {
    schemaVersion: 1,
    operation: 'predict',
    requestId: 'req-1',
    viewId: 'view-1',
    anchor: anchor(),
    expectedConfigRevision: undefined,
    trigger: 'auto',
    ...(overrides ?? {}),
  }
}

async function readJson(response) {
  return JSON.parse(await response.text())
}

test('apply registers the plugin route and handles predict', async () => {
  const { ctx, routes, finishTurn } = fakeContext()
  apply(ctx, { enabled: true, modelMode: 'fixed', provider: 'fixed-test', fakeSuggestion: '固定测试建议' })
  finishTurn()
  const route = routes.get(ROUTE)
  assert.ok(route, 'route registered')
  assert.equal(route.methods[0], 'POST')
  assert.equal(route.requestBody, 'streaming', 'bounded reads require streaming mode')
  const response = await route.fetch(jsonRequest(predictBody()))
  assert.equal(response.status, 200)
  const body = await readJson(response)
  assert.equal(body.result.kind, 'offer')
  assert.equal(body.result.text, '固定测试建议')
})

test('a blocked turn and an old cached turn are rejected at the HTTP entry point', async () => {
  const { ctx, routes, finishTurn, emitEvent } = fakeContext()
  apply(ctx, { enabled: true, modelMode: 'fixed', provider: 'fixed-test', fakeSuggestion: '测试建议' })
  const route = routes.get(ROUTE)
  finishTurn('blocked')
  const blocked = await readJson(await route.fetch(jsonRequest(predictBody())))
  assert.deepEqual(blocked.result, { kind: 'stale', reason: 'turn-not-completed' })
  finishTurn()
  const completed = await readJson(await route.fetch(jsonRequest(predictBody({ requestId: 'completed' }))))
  assert.equal(completed.result.kind, 'offer')
  // B04：回合结束后的标题事件不算过期，仍可预测。
  emitEvent({ type: 'session/title', seq: 8, data: { title: 'x', messageSeqs: [] } })
  const afterTitle = await readJson(await route.fetch(jsonRequest(predictBody({ requestId: 'after-title' }))))
  assert.equal(afterTitle.result.kind, 'offer')
  // 用户发出新消息后，旧回合上下文才算过期。
  emitEvent({
    type: 'user/message',
    seq: 9,
    data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '新消息' }] },
  })
  const replayed = await readJson(await route.fetch(jsonRequest(predictBody({ requestId: 'after-user' }))))
  assert.deepEqual(replayed.result, { kind: 'stale', reason: 'stale-context' })
})

test('apply works with an empty loader config (defaults, disabled)', async () => {
  const { ctx, routes } = fakeContext()
  apply(ctx, undefined)
  const route = routes.get(ROUTE)
  const response = await route.fetch(jsonRequest(predictBody()))
  const body = await readJson(response)
  assert.equal(body.result.kind, 'unavailable')
  assert.equal(body.result.reason, 'disabled')
})

test('unknown session is stale', async () => {
  const { ctx, routes } = fakeContext({ sessions: {} })
  apply(ctx, { enabled: true, modelMode: 'fixed', provider: 'fixed-test', fakeSuggestion: '固定测试建议' })
  const route = routes.get(ROUTE)
  const response = await route.fetch(jsonRequest(predictBody()))
  const body = await readJson(response)
  assert.equal(body.result.kind, 'stale')
  assert.equal(body.result.reason, 'unknown-session')
})

test('status operation reports capabilities and zero send calls', async () => {
  const { ctx, routes } = fakeContext()
  apply(ctx, { enabled: true, modelMode: 'fixed', provider: 'fixed-test', fakeSuggestion: 'x' })
  const route = routes.get(ROUTE)
  const response = await route.fetch(jsonRequest({ schemaVersion: 1, operation: 'status' }))
  const body = await readJson(response)
  assert.equal(body.ok, true)
  assert.equal(body.value.capabilities.connectionFetch, true)
  assert.equal(body.value.capabilities.configEditor, true)
  assert.equal(body.value.capabilities.sessionStore, true)
  assert.equal(body.value.diagnostics.counters.sendCalls, 0)
})

test('oversized body is rejected with 413 before JSON parsing', async () => {
  const { ctx, routes } = fakeContext()
  apply(ctx, { enabled: true, modelMode: 'fixed', provider: 'fixed-test', fakeSuggestion: 'x' })
  const route = routes.get(ROUTE)
  const huge = JSON.stringify({ schemaVersion: 1, operation: 'status', pad: 'x'.repeat(9000) })
  const response = await route.fetch(jsonRequest(huge))
  assert.equal(response.status, 413)
  const body = await readJson(response)
  assert.equal(body.error.code, 'request-too-large')
})

test('malformed JSON is rejected with 400', async () => {
  const { ctx, routes } = fakeContext()
  apply(ctx, { enabled: true, modelMode: 'fixed', provider: 'fixed-test', fakeSuggestion: 'x' })
  const route = routes.get(ROUTE)
  const response = await route.fetch(jsonRequest('{not json'))
  assert.equal(response.status, 400)
  const body = await readJson(response)
  assert.equal(body.error.code, 'bad-json')
})

test('config.set persists through configEditor.edit', async () => {
  const { ctx, routes, edits } = fakeContext()
  apply(ctx, { enabled: false, modelMode: 'fixed', provider: 'fixed-test', fakeSuggestion: 'x' })
  const route = routes.get(ROUTE)
  const response = await route.fetch(
    jsonRequest({ schemaVersion: 1, operation: 'config.set', patch: { enabled: true, fakeSuggestion: '继续' } }),
  )
  const body = await readJson(response)
  assert.equal(body.ok, true)
  assert.equal(body.value.config.enabled, true)
  assert.equal(body.value.config.fakeSuggestion, '继续')
  assert.equal(edits.length, 1)
  assert.equal(edits[0].enabled, true)
  assert.equal(edits[0].fakeSuggestion, '继续')
})

test('config.set reports config-editor-unavailable without an editor', async () => {
  const { ctx, routes } = fakeContext({ allowConfigEditor: false })
  apply(ctx, { enabled: false, modelMode: 'fixed', provider: 'fixed-test', fakeSuggestion: 'x' })
  const route = routes.get(ROUTE)
  const response = await route.fetch(jsonRequest({ schemaVersion: 1, operation: 'config.set', patch: { enabled: true } }))
  const body = await readJson(response)
  assert.equal(body.ok, false)
  assert.equal(body.error.code, 'config-editor-unavailable')
})

test('ctx.effect disposers remove the route', () => {
  const { ctx, routes, effects } = fakeContext()
  apply(ctx, { enabled: true, modelMode: 'fixed', provider: 'fixed-test', fakeSuggestion: 'x' })
  assert.equal(routes.size, 1)
  for (const disposer of effects) {
    if (typeof disposer === 'function') disposer()
  }
  assert.equal(routes.size, 0)
})
