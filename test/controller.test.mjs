// Controller state-machine tests (no DOM, no real network).
import test from 'node:test'
import assert from 'node:assert/strict'

import { DEFAULT_CONFIG } from '../src/shared/config.js'
import { createClientRuntime } from '../src/client/controller.js'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function statusValue(overrides) {
  return {
    ok: true,
    value: {
      config: {
        ...DEFAULT_CONFIG,
        enabled: true,
        triggerDelayMs: 0,
        fakeSuggestion: '固定测试建议',
        ...(overrides ?? {}),
      },
      configRevision: 1,
      configErrors: [],
      capabilities: { connectionFetch: true, sessionStore: true, configEditor: true },
      diagnostics: { counters: {} },
      provider: 'fixed-test-suggestion',
      ...(overrides && overrides.capabilities ? { capabilities: overrides.capabilities } : {}),
    },
  }
}

/** Build an env snapshot with all eligibility fields. */
function makeEnv(overrides) {
  return {
    sessionId: 's1',
    turnId: 'a1',
    completedEventSeq: 0,
    branchEpoch: 'v1',
    contextRevision: '4:1',
    running: false,
    hasFinalText: true,
    sessionBlank: false,
    sessionRemoved: false,
    awaitingFirstTurn: false,
    canEdit: true,
    draft: '',
    draftRev: 0,
    occurrencesCount: 0,
    attachmentCount: 0,
    queuedCount: 0,
    claimed: false,
    phase: 'plain',
    composing: false,
    pendingInteraction: false,
    menuOpen: false,
    windowVisible: true,
    windowFocused: true,
    focused: true,
    inputMissing: false,
    ...(overrides ?? {}),
  }
}

function makeRuntime(handler) {
  const calls = []
  const runtime = createClientRuntime({
    rpc: async (operation, payload, signal) => {
      calls.push({ operation, payload })
      return handler(operation, payload, calls, signal)
    },
  })
  return { runtime, calls }
}

async function readyRuntime(handler) {
  const built = makeRuntime(handler)
  const result = await built.runtime.loadStatus()
  assert.equal(result.ok, true)
  return built
}

function offerResponse(payload, overrides) {
  return {
    requestId: payload.requestId,
    anchor: payload.anchor,
    configRevision: 1,
    result: { kind: 'offer', suggestionId: 'sug-1', text: '固定测试建议', expiresAt: Date.now() + 600000 },
    ...(overrides ?? {}),
  }
}

test('auto trigger fires only on an observed running -> idle transition', async () => {
  const { runtime, calls } = await readyRuntime((operation, payload) =>
    operation === 'predict' ? offerResponse(payload) : statusValue(),
  )
  runtime.sync(makeEnv({ running: true, turnId: 'a0' }))
  runtime.sync(makeEnv())
  await sleep(20)
  const predicts = calls.filter((call) => call.operation === 'predict')
  assert.equal(predicts.length, 1)
  assert.equal(predicts[0].payload.trigger, 'auto')
  assert.equal(runtime.assistStore.getSnapshot().status, 'offered')
  assert.equal(runtime.assistStore.getSnapshot().text, '固定测试建议')
})

test('mounting an already-idle old turn never auto-predicts', async () => {
  const { runtime, calls } = await readyRuntime((operation, payload) =>
    operation === 'predict' ? offerResponse(payload) : statusValue(),
  )
  runtime.sync(makeEnv())
  runtime.sync(makeEnv())
  await sleep(20)
  assert.equal(calls.filter((call) => call.operation === 'predict').length, 0)
})

test('completion is anchored on turnId change, not on the first idle frame', async () => {
  const { runtime, calls } = await readyRuntime((operation, payload) =>
    operation === 'predict' ? offerResponse(payload) : statusValue(),
  )
  // 真实模型下 session.running 先变 false，chat 投影（turnId/turnEnds）稍后才更新。
  runtime.sync(makeEnv({ running: true, turnId: 'a0' }))
  runtime.sync(makeEnv({ running: false, turnId: 'a0' }))
  await sleep(20)
  assert.equal(calls.filter((call) => call.operation === 'predict').length, 0, 'must not predict on the stale turn')
  assert.notEqual(runtime.assistStore.getSnapshot().status, 'offered')
  // 投影更新到新完成回合后才触发一次。
  runtime.sync(makeEnv({ running: false, turnId: 'a1' }))
  await sleep(20)
  assert.equal(calls.filter((call) => call.operation === 'predict').length, 1)
  assert.equal(runtime.assistStore.getSnapshot().status, 'offered')
})

test('empty draft is required; typing suppresses the turn and clearing does not revive it', async () => {
  const { runtime, calls } = await readyRuntime((operation, payload) =>
    operation === 'predict' ? offerResponse(payload) : statusValue(),
  )
  runtime.sync(makeEnv({ running: true, turnId: 'a0' }))
  runtime.sync(makeEnv({ draft: 'x', draftRev: 1 }))
  runtime.sync(makeEnv())
  await sleep(20)
  assert.equal(calls.filter((call) => call.operation === 'predict').length, 0)
  assert.notEqual(runtime.assistStore.getSnapshot().status, 'offered')
})

test('auto dispatch is deduped to one production per turn', async () => {
  const { runtime, calls } = await readyRuntime((operation, payload) =>
    operation === 'predict' ? offerResponse(payload) : statusValue(),
  )
  runtime.sync(makeEnv({ running: true, turnId: 'a0' }))
  runtime.sync(makeEnv())
  await sleep(20)
  // A new render of the same finished turn must not ask again.
  runtime.sync(makeEnv())
  runtime.sync(makeEnv())
  await sleep(20)
  assert.equal(calls.filter((call) => call.operation === 'predict').length, 1)
})

test('Esc dismisses, reports to the Host and never revives that turn', async () => {
  const { runtime, calls } = await readyRuntime((operation, payload) => {
    if (operation === 'predict') return offerResponse(payload)
    if (operation === 'status') return statusValue()
    return { ok: true, value: {} }
  })
  runtime.sync(makeEnv({ running: true, turnId: 'a0' }))
  runtime.sync(makeEnv())
  await sleep(20)
  assert.equal(runtime.assistStore.getSnapshot().status, 'offered')
  const env = makeEnv()
  assert.equal(runtime.dismissCurrent(env), true)
  assert.equal(runtime.assistStore.getSnapshot().status, 'dismissed')
  const dismiss = calls.find((call) => call.operation === 'dismiss')
  assert.ok(dismiss)
  assert.equal(dismiss.payload.suggestionId, 'sug-1')
  // Even a remount of the same turn stays dismissed.
  runtime.sync(makeEnv())
  await sleep(20)
  assert.equal(runtime.assistStore.getSnapshot().status, 'dismissed')
  assert.equal(calls.filter((call) => call.operation === 'predict').length, 1)
})

test('prepareAdoption refuses stale draft revisions and non-empty drafts', async () => {
  const { runtime } = await readyRuntime((operation, payload) =>
    operation === 'predict' ? offerResponse(payload) : statusValue(),
  )
  runtime.sync(makeEnv({ running: true, turnId: 'a0' }))
  runtime.sync(makeEnv())
  await sleep(20)
  assert.equal(runtime.prepareAdoption(makeEnv({ draftRev: 1 })), null)
  assert.equal(runtime.prepareAdoption(makeEnv({ draft: 'x', draftRev: 1 })), null)
  assert.equal(runtime.prepareAdoption(makeEnv({ composing: true })), null)
  const offer = runtime.prepareAdoption(makeEnv())
  assert.ok(offer)
  assert.equal(offer.text, '固定测试建议')
  assert.equal(offer.draftRev, 0)
})

test('markAccepted is terminal for the turn and reports to the Host', async () => {
  const { runtime, calls } = await readyRuntime((operation, payload) => {
    if (operation === 'predict') return offerResponse(payload)
    if (operation === 'status') return statusValue()
    return { ok: true, value: {} }
  })
  runtime.sync(makeEnv({ running: true, turnId: 'a0' }))
  runtime.sync(makeEnv())
  await sleep(20)
  const offer = runtime.prepareAdoption(makeEnv())
  assert.ok(offer)
  runtime.markAccepted(offer)
  assert.equal(runtime.assistStore.getSnapshot().status, 'accepted')
  assert.ok(calls.find((call) => call.operation === 'accepted'))
  runtime.sync(makeEnv())
  await sleep(20)
  assert.equal(runtime.assistStore.getSnapshot().status, 'accepted')
  assert.equal(runtime.prepareAdoption(makeEnv()), null)
})

test('accepted state survives the non-empty draft created by the insertion', async () => {
  const { runtime } = await readyRuntime((operation, payload) =>
    operation === 'predict' ? offerResponse(payload) : statusValue(),
  )
  runtime.sync(makeEnv({ running: true, turnId: 'a0' }))
  runtime.sync(makeEnv())
  await sleep(20)
  const offer = runtime.prepareAdoption(makeEnv())
  assert.ok(offer)
  runtime.markAccepted(offer)
  // The native insertion publishes a new InputState with non-empty draft right
  // after acceptance; that must not overwrite the terminal state.
  runtime.sync(makeEnv({ draft: offer.text, draftRev: 8 }))
  runtime.sync(makeEnv({ draft: offer.text, draftRev: 8 }))
  assert.equal(runtime.assistStore.getSnapshot().status, 'accepted')
  assert.equal(runtime.assistStore.getSnapshot().text, '')
  assert.equal(runtime.prepareAdoption(makeEnv({ draft: offer.text, draftRev: 8 })), null)
})

test('queued inbox input suppresses eligibility', async () => {
  const { runtime, calls } = await readyRuntime((operation, payload) =>
    operation === 'predict' ? offerResponse(payload) : statusValue(),
  )
  runtime.sync(makeEnv({ running: true, turnId: 'a0' }))
  runtime.sync(makeEnv({ queuedCount: 1 }))
  runtime.sync(makeEnv({ queuedCount: 1 }))
  await sleep(20)
  assert.equal(calls.filter((call) => call.operation === 'predict').length, 0)
})

test('insert rejection withdraws the offer and leaves the key native', async () => {
  const { runtime } = await readyRuntime((operation, payload) =>
    operation === 'predict' ? offerResponse(payload) : statusValue(),
  )
  runtime.sync(makeEnv({ running: true, turnId: 'a0' }))
  runtime.sync(makeEnv())
  await sleep(20)
  const offer = runtime.prepareAdoption(makeEnv())
  assert.ok(offer)
  runtime.markInsertRejected(offer)
  const state = runtime.assistStore.getSnapshot()
  assert.equal(state.status, 'failed')
  assert.equal(state.reason, 'insert-rejected')
  assert.equal(state.text, '')
  assert.equal(runtime.prepareAdoption(makeEnv()), null)
})

test('IME composition suppresses the turn', async () => {
  const { runtime, calls } = await readyRuntime((operation, payload) =>
    operation === 'predict' ? offerResponse(payload) : statusValue(),
  )
  runtime.sync(makeEnv({ running: true, turnId: 'a0' }))
  runtime.sync(makeEnv({ composing: true }))
  runtime.sync(makeEnv())
  await sleep(20)
  assert.equal(calls.filter((call) => call.operation === 'predict').length, 0)
})

test('a response for another session is never painted', async () => {
  const { runtime } = await readyRuntime((operation, payload) =>
    operation === 'predict'
      ? offerResponse(payload, { anchor: { ...payload.anchor, sessionId: 'other-session' } })
      : statusValue(),
  )
  runtime.sync(makeEnv({ running: true, turnId: 'a0' }))
  runtime.sync(makeEnv())
  await sleep(20)
  assert.notEqual(runtime.assistStore.getSnapshot().status, 'offered')
})

test('a draft typed during the request hides the late offer', async () => {
  let releasePredict
  const gate = new Promise((resolve) => {
    releasePredict = resolve
  })
  const { runtime } = await readyRuntime(async (operation, payload) => {
    if (operation === 'predict') {
      await gate
      return offerResponse(payload)
    }
    return statusValue()
  })
  runtime.sync(makeEnv({ running: true, turnId: 'a0' }))
  runtime.sync(makeEnv())
  await sleep(10)
  runtime.sync(makeEnv({ draft: '用户已经开始输入', draftRev: 2 }))
  releasePredict()
  await sleep(20)
  assert.notEqual(runtime.assistStore.getSnapshot().status, 'offered')
})

test('losing window focus cancels an in-flight prediction, including its HTTP request', async () => {
  const pending = Promise.withResolvers()
  const started = Promise.withResolvers()
  const { runtime, calls } = await readyRuntime((operation, payload, allCalls, signal) => {
    if (operation !== 'predict') return statusValue()
    started.resolve(signal)
    return pending.promise.then(() => offerResponse(payload))
  })
  runtime.sync(makeEnv({ running: true, turnId: 'a0' }))
  runtime.sync(makeEnv())
  const signal = await started.promise
  runtime.sync(makeEnv({ windowFocused: false }))
  assert.equal(signal.aborted, true)
  assert.equal(calls.filter((call) => call.operation === 'release').length, 1)
  pending.resolve()
  runtime.sync(makeEnv())
  await sleep(20)
  assert.equal(runtime.assistStore.getSnapshot().status, 'idle')
  assert.equal(calls.filter((call) => call.operation === 'predict').length, 1)
})

test('focus can restore the same offer while context and draft revisions still match', async () => {
  const { runtime } = await readyRuntime((operation, payload) =>
    operation === 'predict' ? offerResponse(payload) : statusValue(),
  )
  runtime.sync(makeEnv({ running: true, turnId: 'a0' }))
  runtime.sync(makeEnv())
  await sleep(20)
  const blurred = makeEnv({ focused: false })
  runtime.sync(blurred)
  assert.equal(runtime.prepareAdoption(blurred), null)
  runtime.sync(makeEnv())
  assert.ok(runtime.prepareAdoption(makeEnv()))
  runtime.sync(makeEnv({ contextRevision: '5:1' }))
  assert.equal(runtime.assistStore.getSnapshot().status, 'idle')
  assert.equal(runtime.prepareAdoption(makeEnv({ contextRevision: '5:1' })), null)
})

test('disabled config turns the runtime off and hides offers', async () => {
  const { runtime, calls } = await readyRuntime((operation, payload) =>
    operation === 'predict' ? offerResponse(payload) : statusValue({ enabled: false }),
  )
  runtime.sync(makeEnv({ running: true, turnId: 'a0' }))
  runtime.sync(makeEnv())
  await sleep(20)
  assert.equal(runtime.assistStore.getSnapshot().status, 'disabled')
  assert.equal(calls.filter((call) => call.operation === 'predict').length, 0)
})

test('manual trigger: pressing again asks for another one, three per turn at most', async () => {
  let serial = 0
  const { runtime, calls } = await readyRuntime((operation, payload) => {
    if (operation !== 'predict') return statusValue()
    serial += 1
    return offerResponse(payload, {
      result: { kind: 'offer', suggestionId: `sug-${serial}`, text: `建议 ${serial}`, expiresAt: Date.now() + 600000 },
    })
  })
  runtime.sync(makeEnv({ running: true, turnId: 'a0' }))
  runtime.sync(makeEnv())
  await sleep(20)
  assert.equal(runtime.assistStore.getSnapshot().text, '建议 1')
  // Three manual presses while a suggestion is showing: each replaces it.
  for (let press = 0; press < 3; press += 1) {
    assert.equal(runtime.predictNow().ok, true, `press ${press}`)
    await sleep(20)
    assert.equal(runtime.assistStore.getSnapshot().status, 'offered')
    assert.equal(runtime.assistStore.getSnapshot().text, `建议 ${press + 2}`)
  }
  const fourth = runtime.predictNow()
  assert.equal(fourth.ok, false)
  assert.equal(fourth.reason, 'manual-limit')
  // The suggestion on screen stays.
  assert.equal(runtime.assistStore.getSnapshot().text, '建议 4')
  const predicts = calls.filter((call) => call.operation === 'predict')
  assert.equal(predicts.length, 4)
  assert.deepEqual(predicts.map((call) => call.payload.trigger), ['auto', 'manual', 'manual', 'manual'])
  assert.deepEqual(predicts.slice(1).map((call) => call.payload.attempt ?? 0), [0, 1, 2])
})

test('B01: completion while the window is inactive is requested once after focus returns', async () => {
  const { runtime, calls } = await readyRuntime((operation, payload) =>
    operation === 'predict' ? offerResponse(payload) : statusValue(),
  )
  runtime.sync(makeEnv({ running: true, turnId: 'a0' }))
  runtime.sync(makeEnv({ windowFocused: false }))
  await sleep(30)
  assert.equal(calls.filter((call) => call.operation === 'predict').length, 0)
  runtime.sync(makeEnv())
  await sleep(30)
  assert.equal(calls.filter((call) => call.operation === 'predict').length, 1)
  // 只允许一次重试。
  runtime.sync(makeEnv())
  await sleep(30)
  assert.equal(calls.filter((call) => call.operation === 'predict').length, 1)
  assert.equal(runtime.assistStore.getSnapshot().status, 'offered')
})

test('B01: switching to another session and back requests the pending turn once', async () => {
  const { runtime, calls } = await readyRuntime((operation, payload) =>
    operation === 'predict' ? offerResponse(payload) : statusValue(),
  )
  runtime.sync(makeEnv({ running: true, turnId: 'a0' }))
  runtime.sync(makeEnv({ windowFocused: false }))
  await sleep(20)
  assert.equal(calls.filter((call) => call.operation === 'predict').length, 0)
  runtime.sync(makeEnv({ sessionId: 's2', turnId: 'b1', completedEventSeq: 5, contextRevision: '2:1' }))
  await sleep(20)
  runtime.sync(makeEnv())
  await sleep(30)
  assert.equal(calls.filter((call) => call.operation === 'predict').length, 1)
})

test('B06: leaving and returning to a session restores the cached offer without a new request', async () => {
  const { runtime, calls } = await readyRuntime((operation, payload) =>
    operation === 'predict' ? offerResponse(payload) : statusValue(),
  )
  runtime.sync(makeEnv({ running: true, turnId: 'a0' }))
  runtime.sync(makeEnv())
  await sleep(20)
  assert.equal(runtime.assistStore.getSnapshot().status, 'offered')
  const predicts = calls.filter((call) => call.operation === 'predict').length
  runtime.sync(makeEnv({ sessionId: 's2', turnId: 'b1', completedEventSeq: 5, contextRevision: '2:1' }))
  runtime.sync(makeEnv())
  await sleep(20)
  assert.equal(runtime.assistStore.getSnapshot().status, 'offered')
  assert.equal(runtime.assistStore.getSnapshot().text, '固定测试建议')
  assert.equal(calls.filter((call) => call.operation === 'predict').length, predicts)
})

test('B06: typing then clearing the draft restores the same offer without re-requesting', async () => {
  const { runtime, calls } = await readyRuntime((operation, payload) =>
    operation === 'predict' ? offerResponse(payload) : statusValue(),
  )
  runtime.sync(makeEnv({ running: true, turnId: 'a0' }))
  runtime.sync(makeEnv())
  await sleep(20)
  assert.equal(runtime.assistStore.getSnapshot().status, 'offered')
  runtime.sync(makeEnv({ draft: 'x', draftRev: 1 }))
  assert.equal(runtime.assistStore.getSnapshot().status, 'suppressed')
  runtime.sync(makeEnv({ draft: 'xy', draftRev: 2 }))
  runtime.sync(makeEnv({ draft: '', draftRev: 3 }))
  await sleep(20)
  assert.equal(runtime.assistStore.getSnapshot().status, 'offered')
  assert.equal(runtime.assistStore.getSnapshot().text, '固定测试建议')
  assert.equal(calls.filter((call) => call.operation === 'predict').length, 1)
})

test('B07: busy from the Host is retried once and then succeeds', async () => {
  let predictCalls = 0
  const { runtime, calls } = await readyRuntime((operation, payload) => {
    if (operation !== 'predict') return statusValue()
    predictCalls += 1
    if (predictCalls === 1) {
      return { requestId: payload.requestId, anchor: payload.anchor, configRevision: 1, result: { kind: 'unavailable', reason: 'busy', retryAfterMs: 0 } }
    }
    return offerResponse(payload)
  })
  runtime.sync(makeEnv({ running: true, turnId: 'a0' }))
  runtime.sync(makeEnv())
  await sleep(700)
  assert.equal(calls.filter((call) => call.operation === 'predict').length, 2)
  assert.equal(runtime.assistStore.getSnapshot().status, 'offered')
})

test('B07: a transport failure is retried once', async () => {
  let predictCalls = 0
  const { runtime, calls } = await readyRuntime((operation, payload) => {
    if (operation !== 'predict') return statusValue()
    predictCalls += 1
    if (predictCalls === 1) throw new Error('network down')
    return offerResponse(payload)
  })
  runtime.sync(makeEnv({ running: true, turnId: 'a0' }))
  runtime.sync(makeEnv())
  await sleep(700)
  assert.equal(calls.filter((call) => call.operation === 'predict').length, 2)
  assert.equal(runtime.assistStore.getSnapshot().status, 'offered')
})

test('B07: model abstains are not retried', async () => {
  const { runtime, calls } = await readyRuntime((operation, payload) => {
    if (operation !== 'predict') return statusValue()
    return { requestId: payload.requestId, anchor: payload.anchor, configRevision: 1, result: { kind: 'abstain', reason: 'model-abstained' } }
  })
  runtime.sync(makeEnv({ running: true, turnId: 'a0' }))
  runtime.sync(makeEnv())
  await sleep(700)
  assert.equal(calls.filter((call) => call.operation === 'predict').length, 1)
  assert.equal(runtime.assistStore.getSnapshot().status, 'abstained')
})

test('O07: another ghost plugin makes this runtime step aside until it disappears', async () => {
  const { runtime, calls } = await readyRuntime((operation, payload) =>
    operation === 'predict' ? offerResponse(payload) : statusValue(),
  )
  runtime.sync(makeEnv({ running: true, turnId: 'a0' }))
  runtime.sync(makeEnv())
  await sleep(20)
  assert.equal(runtime.assistStore.getSnapshot().status, 'offered')
  const predicts = calls.filter((call) => call.operation === 'predict').length
  runtime.noteConflict('composer-ghost:other-plugin')
  runtime.sync(makeEnv())
  assert.equal(runtime.assistStore.getSnapshot().status, 'conflict')
  await sleep(30)
  assert.equal(calls.filter((call) => call.operation === 'predict').length, predicts)
  runtime.clearConflict()
  runtime.sync(makeEnv())
  assert.notEqual(runtime.assistStore.getSnapshot().status, 'conflict')
})

test('manualOnly: a finished reply does not predict until predictNow is called', async () => {
  const { runtime, calls } = await readyRuntime((operation, payload) =>
    operation === 'predict' ? offerResponse(payload) : statusValue({ manualOnly: true }),
  )
  runtime.sync(makeEnv({ running: true, turnId: 'a0' }))
  runtime.sync(makeEnv())
  await sleep(30)
  assert.equal(calls.filter((call) => call.operation === 'predict').length, 0)
  // A second idle frame must not revive the automatic trigger either.
  runtime.sync(makeEnv())
  await sleep(30)
  assert.equal(calls.filter((call) => call.operation === 'predict').length, 0)
  const result = runtime.predictNow()
  assert.equal(result.ok, true)
  assert.equal(runtime.noticeStore.getSnapshot().kind, 'predicting')
  await sleep(30)
  const predicts = calls.filter((call) => call.operation === 'predict')
  assert.equal(predicts.length, 1)
  assert.equal(predicts[0].payload.trigger, 'manual')
  assert.equal(runtime.assistStore.getSnapshot().status, 'offered')
  assert.equal(runtime.noticeStore.getSnapshot().kind, '')
})

test('manualOnly: a window that was unfocused at completion does not auto-predict on focus', async () => {
  const { runtime, calls } = await readyRuntime((operation, payload) =>
    operation === 'predict' ? offerResponse(payload) : statusValue({ manualOnly: true }),
  )
  runtime.sync(makeEnv({ running: true, turnId: 'a0' }))
  runtime.sync(makeEnv({ windowFocused: false }))
  runtime.sync(makeEnv())
  await sleep(30)
  assert.equal(calls.filter((call) => call.operation === 'predict').length, 0)
})

test('manual trigger works on an old turn and after the user typed and cleared the draft', async () => {
  const { runtime, calls } = await readyRuntime((operation, payload) =>
    operation === 'predict' ? offerResponse(payload) : statusValue(),
  )
  // Old session mounted idle: no automatic prediction, then the user types and clears.
  runtime.sync(makeEnv())
  runtime.sync(makeEnv({ draft: 'x', draftRev: 1 }))
  runtime.sync(makeEnv({ draft: '', draftRev: 2 }))
  await sleep(20)
  assert.equal(calls.filter((call) => call.operation === 'predict').length, 0)
  assert.equal(runtime.predictNow().ok, true)
  await sleep(30)
  assert.equal(calls.filter((call) => call.operation === 'predict').length, 1)
  assert.equal(runtime.assistStore.getSnapshot().status, 'offered')
})

test('manual trigger tells the composer why there is no suggestion', async () => {
  const { runtime } = await readyRuntime((operation, payload) =>
    operation === 'predict'
      ? { requestId: payload.requestId, anchor: payload.anchor, configRevision: 1, result: { kind: 'abstain', reason: 'model-abstained' } }
      : statusValue({ manualOnly: true }),
  )
  runtime.sync(makeEnv({ running: true, turnId: 'a0' }))
  runtime.sync(makeEnv())
  assert.equal(runtime.predictNow().ok, true)
  await sleep(30)
  assert.deepEqual(
    { kind: runtime.noticeStore.getSnapshot().kind, reason: runtime.noticeStore.getSnapshot().reason },
    { kind: 'none', reason: 'model-abstained' },
  )
  // Two more presses are allowed; the fourth is refused, with the reason on the notice.
  assert.equal(runtime.predictNow().ok, true)
  await sleep(30)
  assert.equal(runtime.predictNow().ok, true)
  await sleep(30)
  const fourth = runtime.predictNow()
  assert.equal(fourth.ok, false)
  assert.equal(runtime.noticeStore.getSnapshot().reason, 'manual-limit')
  runtime.clearNotice()
  assert.equal(runtime.noticeStore.getSnapshot().kind, '')
  // Not eligible (draft not empty): refused with that reason, nothing sent.
  runtime.sync(makeEnv({ turnId: 'a2', draft: 'hello', draftRev: 3 }))
  assert.equal(runtime.predictNow().reason, 'draft-not-empty')
})

test('candidates: "another one" steps through them locally before asking the model again', async () => {
  let serial = 0
  const { runtime, calls } = await readyRuntime((operation, payload) => {
    if (operation !== 'predict') return statusValue()
    serial += 1
    return offerResponse(payload, {
      result: { kind: 'offer', suggestionId: `sug-${serial}`, text: `批${serial}-A`, alternatives: [`批${serial}-B`, `批${serial}-C`], expiresAt: Date.now() + 600000 },
    })
  })
  const predicts = () => calls.filter((call) => call.operation === 'predict').length
  runtime.sync(makeEnv({ running: true, turnId: 'a0' }))
  runtime.sync(makeEnv())
  await sleep(20)
  const state = () => runtime.assistStore.getSnapshot()
  assert.deepEqual([state().text, state().candidateIndex, state().candidates.length], ['批1-A', 0, 3])
  // Two presses: no request, same suggestion id, next candidates.
  assert.deepEqual(runtime.predictNow(), { ok: true, local: true })
  assert.equal(state().text, '批1-B')
  assert.deepEqual(runtime.predictNow(), { ok: true, local: true })
  assert.deepEqual([state().text, state().suggestionId, predicts()], ['批1-C', 'sug-1', 1])
  // Past the last one: the model is asked (first manual prediction on this reply).
  assert.equal(runtime.predictNow().ok, true)
  await sleep(20)
  assert.deepEqual([state().text, predicts()], ['批2-A', 2])
  // Use up the manual predictions: 2 local steps + 1 request, twice more.
  for (let batch = 3; batch <= 4; batch += 1) {
    runtime.predictNow(); runtime.predictNow()
    assert.equal(runtime.predictNow().ok, true)
    await sleep(20)
    assert.deepEqual([state().text, predicts()], [`批${batch}-A`, batch])
  }
  // No manual predictions left: stepping past the end goes round to the first again, no request.
  runtime.predictNow(); runtime.predictNow()
  assert.equal(state().text, '批4-C')
  assert.deepEqual(runtime.predictNow(), { ok: true, local: true })
  assert.deepEqual([state().text, predicts()], ['批4-A', 4])
})
