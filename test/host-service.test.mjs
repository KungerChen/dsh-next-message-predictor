// Host predictor-service tests with a fake adapter (no DSH runtime, no network).
import test from 'node:test'
import assert from 'node:assert/strict'

import { DEFAULT_CONFIG } from '../src/shared/config.js'
import { createPredictorService } from '../src/host/predictor-service.js'

function baseConfig(overrides) {
  return {
    ...DEFAULT_CONFIG,
    enabled: true,
    fakeSuggestion: '固定测试建议',
    ...(overrides ?? {}),
  }
}

function fakeAdapter(overrides) {
  const state = {
    sessionKnown: true,
    persisted: null,
    capabilities: { connectionFetch: true, configEditor: true, sessionStore: true, agentRegistry: true },
    ...(overrides ?? {}),
  }
  return {
    state,
    connectionAvailable: true,
    configEditorAvailable: true,
    capabilities: () => state.capabilities,
    sessionKnown: () => state.sessionKnown,
    async persistConfig(patch) {
      state.persisted = { ...(state.persisted ?? {}), ...patch }
      return { ok: true, config: { ...baseConfig(), ...state.persisted }, restarted: true }
    },
    registerRoute: () => ({ ok: true, dispose: () => {}, route: '/api/next-message-predictor/rpc' }),
  }
}

function createService(overrides, adapterOverrides) {
  const adapter = fakeAdapter(adapterOverrides)
  const service = createPredictorService({
    config: baseConfig(overrides),
    configErrors: [],
    adapter,
    contextReader: {
      verifyAnchor: async (anchor) => adapter.sessionKnown(anchor.sessionId) === false
        ? { ok: false, reason: 'unknown-session' }
        : { ok: true, isCurrent: () => true },
    },
    now: () => Date.now(),
    randomId: () => 'sug-fixed-1',
  })
  return { service, adapter }
}

function anchor(overrides) {
  return {
    sessionId: 'session-1',
    branchEpoch: 'v1',
    turnId: 'a7',
    completedEventSeq: 0,
    contextRevision: '9:7',
    ...(overrides ?? {}),
  }
}

function request(overrides) {
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

async function call(service, body) {
  const response = await service.handle(body)
  return response
}

test('predict returns the fixed suggestion as an offer', async () => {
  const { service } = createService()
  const response = await call(service, request())
  assert.equal(response.status, 200)
  assert.equal(response.body.result.kind, 'offer')
  assert.equal(response.body.result.text, '固定测试建议')
  assert.equal(response.body.result.suggestionId, 'sug-fixed-1')
  assert.ok(response.body.result.expiresAt > Date.now())
  assert.deepEqual(response.body.anchor, anchor())
})

test('predict abstains without a configured suggestion and does not invent text', async () => {
  const { service } = createService({ fakeSuggestion: '' })
  const response = await call(service, request())
  assert.equal(response.body.result.kind, 'abstain')
  assert.equal(response.body.result.reason, 'no-test-suggestion-configured')
})

test('predict rejects malformed envelopes with HTTP 400', async () => {
  const { service } = createService()
  const response = await call(service, request({ anchor: { ...anchor(), turnId: '' } }))
  assert.equal(response.status, 400)
  assert.equal(response.body.ok, false)
})

test('disabled config returns unavailable', async () => {
  const { service } = createService({ enabled: false })
  const response = await call(service, request())
  assert.equal(response.body.result.kind, 'unavailable')
  assert.equal(response.body.result.reason, 'disabled')
})

test('unknown session is stale', async () => {
  const { service } = createService(undefined, { sessionKnown: false })
  const response = await call(service, request())
  assert.equal(response.body.result.kind, 'stale')
  assert.equal(response.body.result.reason, 'unknown-session')
})

test('one automatic production per turn; cached offer is reused for later views', async () => {
  const { service } = createService()
  const first = await call(service, request())
  assert.equal(first.body.result.kind, 'offer')
  const duplicate = await call(service, request())
  assert.deepEqual(duplicate.body, first.body)
  // A new view/request for the same finished turn reuses the cached offer
  // instead of starting a second production task.
  const secondView = await call(service, request({ requestId: 'req-2', viewId: 'view-2' }))
  assert.equal(secondView.body.result.kind, 'offer')
  assert.equal(secondView.body.result.suggestionId, first.body.result.suggestionId)
  const status = await call(service, { schemaVersion: 1, operation: 'status' })
  assert.equal(status.body.value.diagnostics.counters.productionTasks, 1)
  assert.equal(status.body.value.diagnostics.counters.cacheHits, 1)
})

test('cached offer is reused across views without another production', async () => {
  const { service } = createService()
  const first = await call(service, request())
  const otherView = await call(service, request({ requestId: 'req-view-2', viewId: 'view-2', trigger: 'manual' }))
  assert.equal(otherView.body.result.kind, 'offer')
  assert.equal(otherView.body.result.suggestionId, first.body.result.suggestionId)
})

test('manual production is allowed three times per turn after an auto abstain', async () => {
  const { service } = createService({ fakeSuggestion: '' })
  const auto = await call(service, request())
  assert.equal(auto.body.result.kind, 'abstain')
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const manual = await call(service, request({ requestId: `req-manual-${attempt}`, trigger: 'manual', attempt }))
    assert.equal(manual.body.result.kind, 'abstain', `attempt ${attempt}`)
  }
  const fourth = await call(service, request({ requestId: 'req-manual-3', trigger: 'manual', attempt: 3 }))
  assert.equal(fourth.body.result.kind, 'stale')
  assert.equal(fourth.body.result.reason, 'already-requested')
})

test('expectedConfigRevision mismatch is stale', async () => {
  const { service } = createService()
  const response = await call(service, request({ expectedConfigRevision: 123456 }))
  assert.equal(response.body.result.kind, 'stale')
  assert.equal(response.body.result.reason, 'config-changed')
})

test('esc dismiss marks the turn stale for other views', async () => {
  const { service } = createService()
  const offer = await call(service, request())
  const dismissed = await call(service, {
    schemaVersion: 1,
    operation: 'dismiss',
    suggestionId: offer.body.result.suggestionId,
    sessionId: 'session-1',
    turnKey: 'session-1\u0000v1\u0000a7',
  })
  assert.equal(dismissed.body.ok, true)
  const other = await call(service, request({ requestId: 'req-other', viewId: 'view-2' }))
  assert.equal(other.body.result.kind, 'stale')
  assert.equal(other.body.result.reason, 'turn-dismissed')
})

test('accepted is recorded and sendCalls stays zero', async () => {
  const { service } = createService()
  const offer = await call(service, request())
  const accepted = await call(service, {
    schemaVersion: 1,
    operation: 'accepted',
    suggestionId: offer.body.result.suggestionId,
    sessionId: 'session-1',
  })
  assert.equal(accepted.body.ok, true)
  const status = await call(service, { schemaVersion: 1, operation: 'status' })
  assert.equal(status.body.ok, true)
  assert.equal(status.body.value.diagnostics.counters.sendCalls, 0)
  assert.equal(status.body.value.diagnostics.counters.providerCalls, 1)
  assert.equal(status.body.value.diagnostics.counters.accepts, 1)
})

test('config.set validates and persists through the adapter', async () => {
  const { service, adapter } = createService()
  const bad = await call(service, { schemaVersion: 1, operation: 'config.set', patch: { triggerDelayMs: 'soon' } })
  assert.equal(bad.body.ok, false)
  assert.equal(adapter.state.persisted, null)
  const good = await call(service, {
    schemaVersion: 1,
    operation: 'config.set',
    patch: { fakeSuggestion: '新建议', triggerDelayMs: 500 },
  })
  assert.equal(good.body.ok, true)
  assert.equal(adapter.state.persisted.fakeSuggestion, '新建议')
  assert.equal(good.body.value.config.fakeSuggestion, '新建议')
})

test('unknown operation is rejected', async () => {
  const { service } = createService()
  const response = await call(service, { schemaVersion: 1, operation: 'nope' })
  assert.equal(response.status, 400)
  assert.equal(response.body.ok, false)
})

test('release aborts an in-flight production when the last waiter leaves', async () => {
  const { service } = createService({ fakeSuggestionDelayMs: 5000 })
  const pending = call(service, request())
  await new Promise((resolve) => setTimeout(resolve, 10))
  const released = await call(service, { schemaVersion: 1, operation: 'release', requestId: 'req-1' })
  assert.equal(released.body.ok, true)
  const outcome = await pending
  assert.equal(outcome.body.result.kind, 'unavailable')
  assert.equal(outcome.body.result.reason, 'cancelled')
})
