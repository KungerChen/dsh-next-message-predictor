import test from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createPredictorService } from '../src/host/predictor-service.js'
import { createSessionState, sessionStateForHost } from '../src/host/session-state.js'
import { OFFER_TTL_MS } from '../src/shared/config.js'

const anchor = { sessionId: 's1', branchEpoch: 'v1', turnId: 't1a1', completedEventSeq: 2, contextRevision: '2:1' }
const stateQuery = { sessionId: anchor.sessionId, anchor }

function fixture(t, options = {}) {
  let time = Date.now()
  let completedAt = time - 100
  const service = createPredictorService({
    config: { enabled: true, fakeSuggestion: '继续验证', fakeSuggestionDelayMs: 0, ...options },
    adapter: { connectionAvailable: true, sessionKnown: (id) => id === 's1' || id === 's2' },
    contextReader: { verifyAnchor: async () => ({ ok: true, isCurrent: () => true, completedAt }) },
    now: () => time,
  })
  t.after(service.dispose)
  function call(operation, payload) {
    return service.handle({ schemaVersion: 1, operation, ...payload })
  }
  const setPause = (previous, paused, payload = stateQuery) => call('session.pause', {
    ...payload, paused, expectedHostId: previous.hostId, expectedPauseRevision: previous.pauseRevision,
  })
  const predict = (requestId, state, overrides = {}) => call('predict', {
    requestId, viewId: 'v1', anchor, trigger: 'auto',
    ...(state === undefined ? {} : { sessionVersion: state }),
    ...overrides,
  })
  const readState = async (payload = stateQuery) => (await call('session.state', payload)).body.value
  return { service, call, setPause, predict, readState, advance: () => { time += 100 }, finish: () => { completedAt = time } }
}

test('session pause is validated and Host-authoritative through resume, including direct requests', async (t) => {
  const f = fixture(t)
  for (const payload of [
    { sessionId: '../not-an-id' },
    { sessionId: 'missing' },
    { sessionId: 's1', anchor: { ...anchor, sessionId: 's2' } },
    { ...stateQuery, schemaVersion: 0 },
  ]) assert.equal((await f.call('session.state', payload)).body.ok, false)
  const initial = await f.readState()
  assert.equal(initial.paused, false)
  const paused = (await f.setPause(initial, true, { sessionId: 's1' })).body.value
  assert.equal(paused.paused, true, 'a blank composer need not supply a completed turn')
  assert.ok(paused.pauseRevision > initial.pauseRevision)
  assert.equal((await f.setPause(initial, false)).status, 409)
  assert.equal((await f.setPause({ ...paused, hostId: 'foreign-host' }, false)).status, 409)
  assert.equal((await f.predict('blocked-auto', initial)).body.result.reason, 'session-paused')
  assert.equal((await f.predict('blocked-direct', undefined, { trigger: 'manual' })).body.result.reason, 'session-paused')
  const resumed = (await f.setPause(paused, false)).body.value
  assert.ok(resumed.pauseRevision > paused.pauseRevision)
  assert.equal((await f.predict('late-old-manual', initial, { trigger: 'manual' })).body.result.reason, 'session-state-changed')
  assert.equal((await f.predict('no-automatic-replay', resumed)).body.result.reason, 'session-state-changed')
  assert.equal((await f.predict('explicit-manual', resumed, { trigger: 'manual' })).body.result.kind, 'offer')
  f.advance()
  f.finish()
  const nextAnchor = { ...anchor, turnId: 't2a3', completedEventSeq: 4, contextRevision: '4:3' }
  assert.equal((await f.predict('new-completion', resumed, { anchor: nextAnchor })).body.result.kind, 'offer')
})

test('dismissal uses the recorded completed event, allows a fresh manual offer and cannot override adoption', async (t) => {
  const f = fixture(t)
  const initial = await f.readState()
  const first = (await f.predict('auto', initial)).body.result
  const dismiss = await f.call('dismiss', { suggestionId: first.suggestionId, sessionId: 's1', turnKey: 'made-up' })
  assert.equal(dismiss.body.value.dismissed, true)
  const dismissed = await f.readState()
  assert.equal(dismissed.terminal, 'dismissed')
  assert.ok(dismissed.stateRevision > initial.stateRevision)
  assert.equal((await f.predict('old-manual', initial, { trigger: 'manual' })).body.result.reason, 'session-state-changed')
  assert.equal((await f.predict('old-auto', dismissed)).body.result.reason, 'turn-dismissed')
  const fresh = (await f.predict('new-manual', dismissed, { trigger: 'manual' })).body.result
  assert.equal(fresh.kind, 'offer')
  assert.notEqual(fresh.suggestionId, first.suggestionId)
  assert.equal((await f.call('accepted', { suggestionId: first.suggestionId, sessionId: 's2' })).body.value.accepted, false)
  assert.equal((await f.call('accepted', { suggestionId: first.suggestionId, sessionId: 's1' })).body.value.accepted, true)
  assert.equal((await f.call('dismiss', { suggestionId: fresh.suggestionId, sessionId: 's1' })).body.value.dismissed, false)
  const accepted = await f.readState()
  assert.equal(accepted.terminal, 'accepted')
  assert.equal((await f.predict('after-accepted', accepted, { trigger: 'manual' })).body.result.reason, 'turn-accepted')
  const otherAnchor = { ...anchor, sessionId: 's2' }
  assert.equal((await f.readState({ sessionId: 's2', anchor: otherAnchor })).terminal, '')
})

test('pause releases all waiters of its production immediately and leaves other productions alone', async (t) => {
  const f = fixture(t, { fakeSuggestionDelayMs: 500 })
  const initial = await f.readState()
  const first = f.predict('one', initial)
  const second = f.predict('two', initial, { viewId: 'v2' })
  await new Promise(setImmediate)
  assert.equal(f.service.statusValue().inflight, 1)
  assert.equal(f.service.statusValue().diagnostics.counters.productionTasks, 1)

  const otherQuery = { sessionId: 's2', anchor: { ...anchor, sessionId: 's2' } }
  const otherState = await f.readState(otherQuery)
  assert.equal((await f.setPause(otherState, true, otherQuery)).body.value.paused, true)
  assert.equal(f.service.statusValue().inflight, 1)

  assert.equal((await f.setPause(initial, true)).body.value.paused, true)
  assert.equal(f.service.statusValue().inflight, 0, 'pause must abort upstream without awaiting its result')
  for (const response of await Promise.all([first, second])) {
    assert.equal(response.body.result.kind, 'stale')
    assert.equal(response.body.result.reason, 'session-paused')
  }
})

test('modern acceptance with unknown or foreign identity does not reach the statistics', async (t) => {
  const outcomes = []
  const service = createPredictorService({
    config: { enabled: true, fakeSuggestion: '继续验证' },
    adapter: { sessionKnown: () => true },
    contextReader: { verifyAnchor: async () => ({ ok: true, isCurrent: () => true }) },
    results: {
      recordRequest() {},
      async recordOutcome(...args) { outcomes.push(args) },
    },
  })
  t.after(service.dispose)
  const response = await service.handle({
    schemaVersion: 1, operation: 'predict', requestId: 'one', viewId: 'view', anchor, trigger: 'manual',
  })
  const offer = response.body.result.suggestionId
  assert.ok(offer)
  for (const [suggestionId, sessionId] of [[offer, 's2'], ['unknown', 's1']]) {
    const accepted = await service.handle({ schemaVersion: 1, operation: 'accepted', suggestionId, sessionId })
    assert.equal(accepted.body.value.accepted, false)
  }
  assert.deepEqual(outcomes, [])
  const accepted = await service.handle({ schemaVersion: 1, operation: 'accepted', suggestionId: offer, sessionId: 's1' })
  assert.equal(accepted.body.value.accepted, true)
  assert.equal(outcomes.length, 1)
})

test('session authority is isolated by Host and a failing listener cannot roll back a commit', () => {
  const a = {}
  const b = {}
  const one = sessionStateForHost(a)
  const other = sessionStateForHost(b)
  assert.equal(sessionStateForHost(a), one)
  assert.notEqual(one.snapshot('s1').hostId, other.snapshot('s1').hostId)
  one.subscribe(() => { throw new Error('failed subscriber') })
  const paused = one.changePause('s1', '', true, one.snapshot('s1').hostId, 0).state
  assert.equal(paused.paused, true)
  assert.equal(other.snapshot('s1').paused, false)
})

test('a profile stays paused across module re-evaluation and new connection wrappers', async () => {
  const profile = join(tmpdir(), 'nmp-session-state-test', 'profile-a')
  const otherProfile = join(tmpdir(), 'nmp-session-state-test', 'profile-b')
  const connection = {}
  const authority = sessionStateForHost(connection, profile)
  const initial = authority.snapshot('s1')
  authority.changePause('s1', '', true, initial.hostId, 0)

  const reloaded = await import('../src/host/session-state.js?fixture-reload')
  const after = reloaded.sessionStateForHost({}, profile).snapshot('s1')
  assert.equal(after.hostId, initial.hostId)
  assert.equal(after.paused, true)
  assert.equal(reloaded.sessionStateForHost(connection, otherProfile).snapshot('s1').paused, false)
  assert.equal(reloaded.sessionStateForHost({}, 'ambiguous-relative-profile').snapshot('s1').paused, false)
})

test('an expired terminal cannot revive its offer and pause survives the offer retention window', () => {
  let time = Date.now()
  const state = createSessionState({ now: () => time })
  const initial = state.snapshot('s1', 'first')
  assert.equal(state.registerOffer({ suggestionId: 'offer', expiresAt: time + OFFER_TTL_MS }, 's1', 'first', initial), true)
  assert.ok(state.finishOffer('offer', 's1', 'dismissed'))
  state.changePause('s1', 'first', true, initial.hostId, initial.pauseRevision)
  time += OFFER_TTL_MS + 1
  assert.equal(state.snapshot('s1', 'first').terminal, '')
  assert.equal(state.snapshot('s1', 'first').paused, true)
  assert.equal(state.finishOffer('offer', 's1', 'accepted'), null)
})
