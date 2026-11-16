// Two real client runtimes talking to one real service and session authority.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createClientRuntime } from '../src/client/controller.js'
import { createPredictorService } from '../src/host/predictor-service.js'
import { DEFAULT_CONFIG } from '../src/shared/config.js'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(predicate, message, timeout = 3500) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) { if (predicate()) return; await sleep(10) }
  assert.fail(message)
}
function env(overrides = {}) {
  return { sessionId: 's1', turnId: 'a1', completedEventSeq: 1, branchEpoch: 'v1', contextRevision: '1:1',
    running: false, hasFinalText: true, sessionBlank: false, sessionRemoved: false, awaitingFirstTurn: false,
    canEdit: true, draft: '', draftRev: 0, occurrencesCount: 0, attachmentCount: 0, queuedCount: 0,
    claimed: false, phase: 'plain', composing: false, pendingInteraction: false, menuOpen: false,
    windowVisible: true, windowFocused: true, focused: true, inputMissing: false, ...overrides }
}
function fixture(rpcWrapper = (call) => call, config = {}) {
  const initialCompletedAt = Date.now()
  const adapter = { connectionAvailable: true, configEditorAvailable: true, sessionKnown: () => true,
    capabilities: () => ({ connectionFetch: true, configEditor: true, sessionStore: true, agentRegistry: true }) }
  let nextId = 0
  const service = createPredictorService({
    config: { ...DEFAULT_CONFIG, enabled: true, fakeSuggestion: '测试建议', triggerDelayMs: 0, ...config }, configErrors: [], adapter,
    contextReader: { verifyAnchor: async (anchor) => ({ ok: true, completedAt: anchor.completedEventSeq <= 1 ? initialCompletedAt : Date.now() + 1, isCurrent: () => true }) },
    now: Date.now, randomId: () => `offer-${++nextId}`,
  })
  const clients = []
  const create = (wrap = rpcWrapper) => {
    const call = async (operation, payload) => (await service.handle({ schemaVersion: 1, operation, ...payload })).body
    const runtime = createClientRuntime({ rpc: wrap(call) })
    clients.push(runtime)
    return runtime
  }
  return { service, create, close() { for (const runtime of clients) runtime.dispose(); service.dispose() } }
}
async function prepare(runtime, view) {
  await runtime.loadStatus()
  runtime.sync(view)
  await until(() => runtime.sessionStore.getSnapshot().available, 'session authority not available')
}
async function complete(runtime, view = env()) {
  runtime.sync({ ...view, running: true, turnId: 'previous', completedEventSeq: 0 })
  await sleep(20)
  runtime.sync(view)
}

test('two views share production and propagate accepted terminal', async () => {
  const f = fixture()
  try {
    const a = f.create(), b = f.create(), view = env()
    await Promise.all([prepare(a, view), prepare(b, view)])
    await Promise.all([complete(a, view), complete(b, view)])
    await until(() => a.assistStore.getSnapshot().status === 'offered' && b.assistStore.getSnapshot().status === 'offered', 'both views should receive shared offer')
    assert.equal(a.assistStore.getSnapshot().suggestionId, b.assistStore.getSnapshot().suggestionId)
    assert.equal(f.service.statusValue().diagnostics.counters.productionTasks, 1)
    for (const operation of ['accepted', 'dismiss']) {
      await f.service.handle({ schemaVersion: 1, operation, suggestionId: a.assistStore.getSnapshot().suggestionId, sessionId: 's2' })
      assert.equal(a.sessionStore.getSnapshot().terminal, '')
      const foreign = await f.service.handle({ schemaVersion: 1, operation: 'session.state', sessionId: 's2' })
      assert.equal(foreign.body.value.terminal, '')
    }
    const offer = a.prepareAdoption(view)
    assert.ok(offer)
    a.markAccepted(offer)
    await until(() => b.sessionStore.getSnapshot().terminal === 'accepted', 'acceptance should reach the other view')
    assert.notEqual(b.assistStore.getSnapshot().status, 'offered')
  } finally { f.close() }
})

test('late initial state cannot overwrite a newer terminal for the same turn', async () => {
  let hold = false, captured = false, release
  const gate = new Promise((resolve) => { release = resolve })
  const f = fixture()
  try {
    const a = f.create(), b = f.create((call) => async (operation, payload) => {
      const response = await call(operation, payload)
      if (hold && operation === 'session.state' && response.value?.turnRevision === 0) {
        hold = false
        captured = true
        await gate // Deliberately ignore abort to simulate a late transport response.
      }
      return response
    })
    const view = env()
    await Promise.all([prepare(a, view), prepare(b, view)])
    await Promise.all([complete(a, view), complete(b, view)])
    await until(() => b.assistStore.getSnapshot().status === 'offered', 'view should have an offer')
    hold = true
    b.sync({ ...view, windowFocused: false })
    b.sync(view)
    await until(() => captured, 'old state read should be held')
    assert.equal(b.dismissCurrent(view), true)
    await until(() => b.sessionStore.getSnapshot().terminal === 'dismissed', 'dismissal should become authoritative')
    await until(() => a.sessionStore.getSnapshot().terminal === 'dismissed', 'dismissal should reach the other view')
    const revision = b.sessionStore.getSnapshot().turnRevision
    assert.ok(revision > 0)
    release()
    await sleep(100)
    assert.equal(b.sessionStore.getSnapshot().terminal, 'dismissed')
    assert.equal(b.sessionStore.getSnapshot().turnRevision, revision)
    assert.equal(b.sessionStore.getSnapshot().available, true)
    assert.equal(b.predictNow().ok, true)
    await until(() => b.assistStore.getSnapshot().status === 'offered', 'manual prediction after dismissal should work')
    await sleep(1000)
    assert.equal(b.assistStore.getSnapshot().status, 'offered', 'poll should not discard the new manual offer')
  } finally { release(); f.close() }
})

test('pausing an in-flight turn and resuming does not replay it', async () => {
  const f = fixture(undefined, { fakeSuggestionDelayMs: 700 })
  try {
    const a = f.create(), b = f.create(), view = env()
    await Promise.all([prepare(a, view), prepare(b, view)])
    await Promise.all([complete(a, view), complete(b, view)])
    await until(() => a.assistStore.getSnapshot().status === 'requesting', 'prediction should be in flight')
    assert.equal(await a.toggleSessionPause('s1'), true)
    await until(() => b.sessionStore.getSnapshot().paused, 'pause should reach second view')
    assert.equal(await a.toggleSessionPause('s1'), true)
    await until(() => !b.sessionStore.getSnapshot().paused, 'resume should reach second view')
    await sleep(900)
    assert.notEqual(a.assistStore.getSnapshot().status, 'offered')
    assert.notEqual(b.assistStore.getSnapshot().status, 'offered')
    assert.equal(f.service.statusValue().diagnostics.counters.productionTasks, 1)
    assert.equal(a.predictNow().ok, true, 'resume permits explicit prediction for the previous turn')
    await until(() => a.assistStore.getSnapshot().status === 'offered', 'manual prediction after resume should work')
    const next = env({ turnId: 'a2', completedEventSeq: 2, contextRevision: '2:1' })
    await complete(b, next)
    await until(() => b.assistStore.getSnapshot().status === 'offered', 'new completion should auto predict after resume')
  } finally { f.close() }
})

test('pause and resume cancel a completion waiting for a frozen composer', async () => {
  const f = fixture()
  try {
    const a = f.create(), b = f.create(), view = env()
    await Promise.all([prepare(a, view), prepare(b, view)])
    await complete(a, { ...view, phase: 'sending' })
    await until(() => a.sessionStore.getSnapshot().available, 'new turn session state')
    assert.equal(await b.toggleSessionPause('s1'), true)
    await until(() => a.sessionStore.getSnapshot().paused, 'pause reaches frozen view')
    assert.equal(await b.toggleSessionPause('s1'), true)
    await until(() => !a.sessionStore.getSnapshot().paused, 'resume reaches frozen view')
    a.sync(view)
    await sleep(100)
    assert.equal(f.service.statusValue().diagnostics.counters.productionTasks, 0)
    assert.notEqual(a.assistStore.getSnapshot().status, 'offered')
  } finally { f.close() }
})

test('pause propagates to same session but does not pause another session', async () => {
  const f = fixture()
  try {
    const a = f.create(), b = f.create(), other = f.create(), view = env(), otherView = env({ sessionId: 's2' })
    await Promise.all([prepare(a, view), prepare(b, view), prepare(other, otherView)])
    assert.equal(await a.toggleSessionPause('s1'), true)
    await until(() => b.sessionStore.getSnapshot().paused, 'pause should reach the other view')
    assert.equal(other.sessionStore.getSnapshot().paused, false)
    assert.equal(await a.toggleSessionPause('s1'), true)
    await until(() => !b.sessionStore.getSnapshot().paused, 'resume should reach the other view')
  } finally { f.close() }
})

test('a disconnected view fails closed and refreshes authority after reconnection', async () => {
  let disconnected = false
  const f = fixture()
  try {
    const a = f.create(), b = f.create((call) => async (operation, payload) => {
      if (disconnected && operation === 'session.state') throw new Error('offline')
      return call(operation, payload)
    })
    const view = env()
    await Promise.all([prepare(a, view), prepare(b, view)])
    disconnected = true
    b.sync({ ...view, windowFocused: false })
    b.sync(view)
    await until(() => !b.sessionStore.getSnapshot().available, 'disconnected state must fail closed')
    assert.equal(await a.toggleSessionPause('s1'), true)
    disconnected = false
    await until(() => b.sessionStore.getSnapshot().available && b.sessionStore.getSnapshot().paused, 'reconnected view should refresh pause state')
  } finally { f.close() }
})
