// Unreleased: one candidate ring with a source per entry (model candidates, then
// the user's own phrases: session habit phrases and pinned phrases), the
// `pinnedPhrases` option, the manual fallback to local phrases, credits that are
// only spent on a model call, results by source, pending results that survive a
// restart of the Host half, and AltGr. See the "未发布" section of CHANGELOG.md.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  CONFIG_SET_MIN_BODY_BYTES,
  DEFAULT_CONFIG,
  LOCAL_PHRASES_MAX,
  PINNED_PHRASES_MAX,
  PINNED_PHRASE_MAX_BYTES,
  checkConfigField,
  configRevision,
  eventMatchesShortcut,
  isAltGraphEvent,
  normalizeConfig,
  parseShortcut,
  pinnedPhraseProblem,
  sanitizeConfigPatch,
  shortcutFromEvent,
} from '../src/shared/config.js'
import { acceptedChoice, offerRing, validateResponseForClient } from '../src/shared/protocol.js'
import { countGraphemes, normalizePhraseKey, utf8ByteLength } from '../src/shared/output-validation.js'
import { createPersistentLedger } from '../src/host/budget-ledger.js'
import { findHabitPhrases } from '../src/host/context-builder.js'
import { createPredictorService } from '../src/host/predictor-service.js'
import { createResultsLog, hashId } from '../src/host/results-log.js'
import { apply } from '../src/host/index.js'
import { createClientRuntime } from '../src/client/controller.js'
import { nmpShortcutKeyAction } from '../src/client/settings.js'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const COMBINING_ACUTE = String.fromCharCode(0x301)

async function withHome(run) {
  const home = await mkdtemp(join(tmpdir(), 'nmp-v050-'))
  try {
    await run(home)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
}

// ── pinnedPhrases: the config field ───────────────────────────────────────

test('pinnedPhrases: an empty list by default, any list of usable phrases up to the limit', () => {
  assert.deepEqual([...DEFAULT_CONFIG.pinnedPhrases], [])
  assert.equal(Object.isFrozen(DEFAULT_CONFIG.pinnedPhrases), true, 'the shared default cannot be changed by accident')
  assert.deepEqual(checkConfigField('pinnedPhrases', ['继续', 'Run the tests']), { ok: true, value: ['继续', 'Run the tests'] })
  assert.equal(checkConfigField('pinnedPhrases', []).ok, true)
  assert.equal(checkConfigField('pinnedPhrases', Array.from({ length: PINNED_PHRASES_MAX }, (_, i) => `p${i}`)).ok, true)
  assert.equal(checkConfigField('pinnedPhrases', Array.from({ length: PINNED_PHRASES_MAX + 1 }, (_, i) => `p${i}`)).ok, false)
  assert.equal(checkConfigField('pinnedPhrases', 'continue').ok, false)
  assert.equal(checkConfigField('pinnedPhrases', [1]).ok, false)
  assert.equal(checkConfigField('pinnedPhrases', { 0: 'x' }).ok, false)
  // The stored value is a copy, never the caller's array.
  const input = ['继续']
  assert.notEqual(checkConfigField('pinnedPhrases', input).value, input)
})

test('pinnedPhrases: each phrase is one trimmed line, 1-40 characters, no command prefix, no duplicate', () => {
  const cases = [
    ['', 'empty'],
    ['   ', 'empty'],
    [' 继续', 'not-trimmed'],
    ['继续 ', 'not-trimmed'],
    ['/compact', 'command'],
    ['@file.txt', 'command'],
    ['好'.repeat(41), 'too-long'],
    // One "character" carrying many combining marks: within 40 graphemes, over the byte cap.
    [`e${COMBINING_ACUTE.repeat(100)}`, 'too-many-bytes'],
    ['第一行\n第二行', 'invalid'],
    ['<b>继续</b>', 'invalid'],
    [`a${String.fromCharCode(7)}b`, 'invalid'],
    [`a${String.fromCharCode(0xd800)}b`, 'invalid'],
  ]
  for (const [text, problem] of cases) assert.equal(pinnedPhraseProblem(text, []), problem, JSON.stringify(text))
  assert.equal(pinnedPhraseProblem('好'.repeat(40), []), '')
  assert.equal(pinnedPhraseProblem('a', []), '')
  // Duplicates under the habit normalisation: case, spaces, trailing punctuation.
  assert.equal(pinnedPhraseProblem('继续。', ['继续']), 'duplicate')
  assert.equal(pinnedPhraseProblem('Go  on!', ['go on']), 'duplicate')
  assert.equal(pinnedPhraseProblem('go on now', ['go on']), '')
  assert.equal(checkConfigField('pinnedPhrases', ['继续', '继续！']).ok, false)
  assert.equal(normalizePhraseKey('  Go   On!! '), 'go on')
})

test('pinnedPhrases: patches, normalisation and the config revision', () => {
  assert.deepEqual(sanitizeConfigPatch({ pinnedPhrases: ['继续'] }), { ok: true, patch: { pinnedPhrases: ['继续'] } })
  assert.equal(sanitizeConfigPatch({ pinnedPhrases: ['/x'] }).ok, false)
  const bad = normalizeConfig({ pinnedPhrases: ['ok', 'ok'] })
  assert.deepEqual(bad.config.pinnedPhrases, [], 'an invalid list falls back to the default')
  assert.equal(bad.errors.length, 1)
  assert.ok(bad.errors[0].includes('pinnedPhrases'))
  const a = normalizeConfig({ pinnedPhrases: ['一', '二'] }).config
  const b = normalizeConfig({ pinnedPhrases: ['二', '一'] }).config
  assert.notEqual(configRevision(a), configRevision(b), 'the order of the list is part of the configuration')
  assert.notEqual(configRevision(a), configRevision(normalizeConfig({}).config))
})

/** Ten phrases at the per-phrase limits that grow the most when written as JSON. */
function worstCasePinnedList() {
  return Array.from({ length: PINNED_PHRASES_MAX }, (_, i) => {
    const clusters = [String.fromCharCode(65 + i) + COMBINING_ACUTE.repeat(2)]
    for (let k = 0; k < 39; k += 1) clusters.push(k < 29 ? `"${COMBINING_ACUTE.repeat(2)}` : '"')
    return clusters.join('')
  })
}

test('pinnedPhrases: the largest valid list fits the config-write allowance even at the smallest body limit', () => {
  const list = worstCasePinnedList()
  for (const phrase of list) {
    assert.equal(pinnedPhraseProblem(phrase, []), '', 'each phrase is valid')
    assert.equal(countGraphemes(phrase), 40)
    assert.equal(utf8ByteLength(phrase), PINNED_PHRASE_MAX_BYTES)
  }
  assert.equal(checkConfigField('pinnedPhrases', list).ok, true)
  const body = JSON.stringify({ schemaVersion: 1, operation: 'config.set', patch: { pinnedPhrases: list } })
  const size = utf8ByteLength(body)
  assert.ok(size > 1024, `the list alone is larger than the smallest body limit (${size})`)
  assert.ok(size < CONFIG_SET_MIN_BODY_BYTES, `but within the config-write allowance (${size} < ${CONFIG_SET_MIN_BODY_BYTES})`)
})

// ── the Host route: config.set may exceed a small body limit, nothing else may ──

function fakeHostContext(home, entryConfig) {
  const routes = new Map()
  const effects = []
  const listeners = new Map()
  const state = { sessions: { s1: { id: 's1', seq: 8 } }, entryConfig }
  const ctx = {
    fiber: { entry: { id: 'next-message-predictor', options: { id: 'next-message-predictor', config: state.entryConfig } } },
    get(name) {
      if (name === 'connection') return { fetch: { register: (route) => { routes.set(route.path, route); return () => routes.delete(route.path) } } }
      if (name === 'configEditor') {
        return { async edit(entry, change) { state.entryConfig = change(state.entryConfig, {}) } }
      }
      if (name === 'sessions') return { get: (id) => state.sessions[id] }
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
  const emit = (event) => {
    for (const listener of listeners.get('session/event') ?? []) listener(state.sessions.s1, event)
  }
  const dispose = () => {
    for (const disposer of effects.splice(0)) if (typeof disposer === 'function') disposer()
    listeners.clear()
  }
  return { ctx, routes, state, emit, dispose }
}

const ROUTE = '/api/next-message-predictor/rpc'
const post = (route, body) =>
  route.fetch(new Request(`http://127.0.0.1:1${ROUTE}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }))

test('route: with requestBodyLimitBytes at 1024 the whole pinned list still saves; other operations keep the limit', async () => {
  await withHome(async (home) => {
    process.env.DSH_HOME = home
    delete process.env.NMP_DATA_HOME
    const host = fakeHostContext(home, { enabled: true, modelMode: 'fixed', provider: 'fixed-test', fakeSuggestion: 'x', requestBodyLimitBytes: 1024 })
    apply(host.ctx, host.state.entryConfig)
    try {
      const route = host.routes.get(ROUTE)
      const saved = await post(route, { schemaVersion: 1, operation: 'config.set', patch: { pinnedPhrases: worstCasePinnedList() } })
      assert.equal(saved.status, 200)
      const body = await saved.json()
      assert.equal(body.ok, true, JSON.stringify(body))
      assert.deepEqual(body.value.config.pinnedPhrases, worstCasePinnedList())
      const padded = await post(route, { schemaVersion: 1, operation: 'status', pad: 'x'.repeat(1500) })
      assert.equal(padded.status, 413)
      const huge = await post(route, { schemaVersion: 1, operation: 'config.set', patch: { fakeSuggestion: 'x'.repeat(5000) } })
      assert.equal(huge.status, 413, 'the allowance has an end')
    } finally {
      host.dispose()
    }
  })
})

// ── the Host: one ring per offer, local phrases behind the model ───────────

function fakeLedger(overrides) {
  const dispatches = new Set()
  return {
    dispatches,
    reserveCalls: 0,
    settleCalls: [],
    hasDispatch: (key) => dispatches.has(key),
    async ensureLoaded() {},
    async reserve(input) {
      this.reserveCalls += 1
      if (overrides?.reserveError) return { ok: false, reason: overrides.reserveError }
      dispatches.add(input.dispatchKey)
      return { ok: true, reservedTokens: 100 }
    },
    async settle(input) {
      this.settleCalls.push(input)
      return true
    },
    async markShown() {
      return true
    },
    snapshot: () => ({ day: '2026-11-11', requests: 0 }),
  }
}

function contextReaderWith(habits, overrides) {
  return {
    reads: 0,
    habitCalls: [],
    async verifyAnchor() {
      return { ok: true, isCurrent: () => true, completedAt: Date.now() }
    },
    async read() {
      this.reads += 1
      if (typeof overrides?.read === 'function') return overrides.read(this.reads)
      return {
        ok: true,
        messages: [{ role: 'user', text: '请检查原因' }, { role: 'assistant', text: '原因是配置缺失' }],
        input: '[用户] 请检查原因\n\n[助手] 原因是配置缺失',
        modelSelection: { provider: 'p', model: 'm' },
        truncated: false, codePoints: 30, estimatedTokens: 120, redactions: 0, source: 'test',
      }
    },
    async habitPhrases(anchor, options) {
      this.habitCalls.push(options)
      return habits
    },
  }
}

function modelSaying(factory) {
  const resolveRoute = () => ({ ok: true, provider: 'p', model: 'm', source: 'session' })
  return {
    calls: [],
    resolveRoute,
    previewRoute: resolveRoute,
    async produce(call) {
      this.calls.push(call)
      const text = factory(this.calls.length, call)
      return { kind: 'raw', text, usage: { inputTokens: 40, outputTokens: 6 }, finishKind: 'stop', route: { provider: 'p', model: 'm' }, effort: 'off' }
    },
  }
}
const say = (suggestion) => JSON.stringify({ suggestion })

function makeService(parts) {
  let serial = 0
  return createPredictorService({
    config: { ...DEFAULT_CONFIG, enabled: true, ...(parts.config ?? {}) },
    configErrors: [],
    adapter: {
      connectionAvailable: true,
      configEditorAvailable: true,
      capabilities: () => ({ connectionFetch: true, configEditor: true, sessionStore: true }),
      persistConfig: async (patch) => ({ ok: true, config: { ...DEFAULT_CONFIG, enabled: true, ...patch }, restarted: true }),
    },
    contextReader: parts.contextReader,
    modelProvider: parts.modelProvider,
    ledger: parts.ledger ?? fakeLedger(),
    results: parts.results,
    randomId: () => `sug-${(serial += 1)}`,
  })
}

const ANCHOR = { sessionId: 's1', branchEpoch: 'v1', turnId: 't1a17', completedEventSeq: 20, contextRevision: '6:17' }
const TURN_KEY = 's1\u0000v1\u0000t1a17'
const predict = (requestId, overrides) => ({ schemaVersion: 1, operation: 'predict', requestId, viewId: 'v', anchor: ANCHOR, trigger: 'auto', ...(overrides ?? {}) })

test('ring: model candidates first, then habit phrases, then pinned phrases, de-duplicated and capped', async () => {
  const contextReader = contextReaderWith(['继续。', '跑一下测试', '<b>坏</b>', '先跑测试'])
  const modelProvider = modelSaying(() => say('先跑测试'))
  const service = makeService({
    contextReader,
    modelProvider,
    config: { pinnedPhrases: ['继续', 'Commit it', 'Push it', 'Tag it', 'Ship it'] },
  })
  const response = await service.handle(predict('r1'))
  const result = response.body.result
  assert.equal(result.kind, 'offer')
  assert.equal(result.text, '先跑测试', 'the first suggestion is the model\'s')
  assert.equal(result.fallback, undefined)
  assert.deepEqual(result.local, [
    { text: '继续。', source: 'habit' },
    { text: '跑一下测试', source: 'habit' },
    // "继续" is the habit phrase again, "先跑测试" the model's own, "<b>坏</b>" fails the suggestion rules.
    { text: 'Commit it', source: 'pinned' },
    { text: 'Push it', source: 'pinned' },
    { text: 'Tag it', source: 'pinned' },
  ])
  assert.equal(result.local.length, LOCAL_PHRASES_MAX)
  assert.equal(contextReader.habitCalls[0].maxPhrases, LOCAL_PHRASES_MAX)
  assert.equal(modelProvider.calls.length, 1)
  assert.equal(validateResponseForClient(response.body, { requestId: 'r1', anchor: ANCHOR }).ok, true)
  assert.deepEqual(offerRing(result).map((entry) => entry.source), ['model', 'habit', 'habit', 'pinned', 'pinned', 'pinned'])
  // "Another one": the model is told its own earlier suggestion, never the user's phrases.
  await service.handle(predict('r2', { trigger: 'manual' }))
  const input = modelProvider.calls[1].input
  assert.ok(input.includes('- 先跑测试'))
  for (const text of ['Commit it', 'Push it', 'Tag it', 'Ship it', '跑一下测试']) assert.equal(input.includes(text), false, text)
  for (const call of modelProvider.calls) assert.equal(call.system.includes('Commit it'), false)
})

test('ring: the habit switch off leaves only pinned phrases; neither switch means no local entries', async () => {
  const off = makeService({ contextReader: contextReaderWith(['继续']), modelProvider: modelSaying(() => say('先跑测试')), config: { habitSuggestions: false, pinnedPhrases: ['Ship it'] } })
  assert.deepEqual((await off.handle(predict('a'))).body.result.local, [{ text: 'Ship it', source: 'pinned' }])
  const none = makeService({ contextReader: contextReaderWith([]), modelProvider: modelSaying(() => say('先跑测试')) })
  assert.equal((await none.handle(predict('b'))).body.result.local, undefined)
})

test('habit phrases pass the same suggestion rules as a model suggestion', () => {
  assert.deepEqual(findHabitPhrases(['<b>好的</b>', '<b>好的</b>', '继续', '继续']), ['继续'])
  assert.deepEqual(findHabitPhrases(['A<|im_end|>', 'A<|im_end|>']), [])
})

// ── the manual fallback ───────────────────────────────────────────────────

test('fallback: a manual prediction the model has nothing for offers the local phrases; automatic stays silent', async () => {
  const modelProvider = modelSaying(() => say(null))
  const service = makeService({ contextReader: contextReaderWith(['继续', '继续'.repeat(1)]), modelProvider, config: { pinnedPhrases: ['Ship it'] } })
  const auto = await service.handle(predict('auto'))
  assert.deepEqual(auto.body.result, { kind: 'abstain', reason: 'model-abstained' })
  const manual = await service.handle(predict('manual', { trigger: 'manual' }))
  const result = manual.body.result
  assert.equal(result.kind, 'offer')
  assert.equal(result.fallback, true)
  assert.equal(result.text, '继续')
  assert.deepEqual(result.local, [{ text: '继续', source: 'habit' }, { text: 'Ship it', source: 'pinned' }])
  assert.equal(result.alternatives, undefined)
  assert.equal(result.modelReason, 'model-abstained')
  assert.equal(validateResponseForClient(manual.body, { requestId: 'manual', anchor: ANCHOR }).ok, true)
  assert.equal(modelProvider.calls.length, 2, 'the model was asked both times')
  // No local phrases: the manual prediction says "no suggestion" as before.
  const bare = makeService({ contextReader: contextReaderWith([]), modelProvider: modelSaying(() => say(null)) })
  assert.deepEqual((await bare.handle(predict('m', { trigger: 'manual' }))).body.result, { kind: 'abstain', reason: 'model-abstained' })
})

test('fallback: not when the conversation moved on', async () => {
  const contextReader = contextReaderWith(['继续'], { read: () => ({ ok: false, reason: 'stale-context' }) })
  const service = makeService({ contextReader, modelProvider: modelSaying(() => say('x')), config: { pinnedPhrases: ['Ship it'] } })
  assert.deepEqual((await service.handle(predict('m', { trigger: 'manual' }))).body.result, { kind: 'abstain', reason: 'stale-context' })
})

function openLedger(home, limits) {
  return createPersistentLedger({ homeDir: home, now: Date.now, getTimeZone: () => 'UTC', getLimits: () => limits.current })
}

test('fallback: no model call means no credit and no allowance used, and the exact counts of 0.4.1 hold', async () => {
  await withHome(async (home) => {
    const limits = { current: { dailyRequestLimit: 1, dailyTokenBudget: 500000 } }
    const ledger = openLedger(home, limits)
    const modelProvider = modelSaying((call) => say(`建议${call}`))
    const service = makeService({ contextReader: contextReaderWith([]), modelProvider, ledger, config: { pinnedPhrases: ['Ship it'], manualLimit: 2 } })
    assert.equal((await service.handle(predict('a0'))).body.result.kind, 'offer')
    assert.equal(ledger.snapshot().requests, 1, 'the daily request limit is now reached')
    for (const [requestId, attempt] of [['m0', 0], ['m1', 1]]) {
      const response = await service.handle(predict(requestId, { trigger: 'manual', attempt }))
      assert.equal(response.body.result.fallback, true, JSON.stringify(response.body.result))
      assert.equal(response.body.result.modelReason, 'daily-request-limit')
    }
    assert.equal(modelProvider.calls.length, 1, 'the model was not called for the fallbacks')
    assert.equal(ledger.snapshot().requests, 1, 'the daily allowance is untouched')
    assert.deepEqual(ledger.turnCalls(TURN_KEY), { auto: 1, manual: 0 }, 'no manual call is counted on disk')
    // Both manual credits are still there in memory: once the allowance allows it, the model is asked.
    limits.current = { dailyRequestLimit: 200, dailyTokenBudget: 500000 }
    const third = await service.handle(predict('m2', { trigger: 'manual', attempt: 2 }))
    assert.equal(third.body.result.kind, 'offer')
    assert.equal(third.body.result.fallback, undefined, 'a model suggestion this time')
    assert.equal(modelProvider.calls.length, 2)
    assert.deepEqual(ledger.turnCalls(TURN_KEY), { auto: 1, manual: 1 })
  })
})

test('fallback: once the model was asked, the call was spent even if the user then gets their own phrases', async () => {
  const modelProvider = modelSaying(() => say(null))
  const service = makeService({ contextReader: contextReaderWith([]), modelProvider, config: { pinnedPhrases: ['Ship it'], manualLimit: 1 } })
  assert.equal((await service.handle(predict('m0', { trigger: 'manual' }))).body.result.fallback, true)
  const second = await service.handle(predict('m1', { trigger: 'manual', attempt: 1 }))
  // The single manual call is used up; the phrases are still offered, without another model call.
  assert.equal(second.body.result.fallback, true)
  assert.equal(second.body.result.modelReason, 'already-requested')
  assert.equal(modelProvider.calls.length, 1)
})

// ── C1: a credit is only spent on a model call ────────────────────────────

test('credits: a production that ends without a model call gives the turn its chance back', async () => {
  // Context read fails once (no model call), then works: the automatic prediction is still available.
  const contextReader = contextReaderWith([], {
    read: (count) => count === 1
      ? { ok: false, reason: 'context-read-failed' }
      : { ok: true, messages: [{ role: 'assistant', text: 'x' }], input: 'x', modelSelection: {}, truncated: false, codePoints: 1, estimatedTokens: 10, redactions: 0, source: 'test' },
  })
  const modelProvider = modelSaying(() => say('先跑测试'))
  const service = makeService({ contextReader, modelProvider })
  assert.deepEqual((await service.handle(predict('a0'))).body.result, { kind: 'abstain', reason: 'context-read-failed' })
  const again = await service.handle(predict('a1'))
  assert.equal(again.body.result.kind, 'offer', JSON.stringify(again.body.result))
  assert.equal(modelProvider.calls.length, 1)
  // Once the model was called, the automatic chance is gone.
  const third = await service.handle(predict('a2'))
  assert.equal(third.body.result.kind === 'offer' && third.body.result.suggestionId !== again.body.result.suggestionId, false)
  assert.equal(modelProvider.calls.length, 1)
})

test('credits: a daily limit reached before the call does not use up the automatic chance', async () => {
  const ledger = fakeLedger({ reserveError: 'daily-request-limit' })
  const modelProvider = modelSaying(() => say('先跑测试'))
  const service = makeService({ contextReader: contextReaderWith([]), modelProvider, ledger })
  for (const id of ['a0', 'a1']) {
    const response = await service.handle(predict(id))
    assert.equal(response.body.result.reason, 'daily-request-limit', 'refused by the allowance, not by "already requested"')
  }
  assert.equal(ledger.reserveCalls, 2)
  assert.equal(modelProvider.calls.length, 0)
})

// ── results by source ─────────────────────────────────────────────────────

function modelOffer(suggestionId, overrides) {
  return {
    requestId: `req-${suggestionId}`,
    suggestionId,
    sessionId: 'session-1',
    turnKey: 'turn',
    trigger: 'auto',
    outcome: 'offer',
    text: '先跑测试',
    alternatives: ['看下 diff'],
    local: [{ text: '继续', source: 'habit' }, { text: 'Ship it', source: 'pinned' }],
    route: { provider: 'p', model: 'm' },
    latencyMs: 1000,
    ...(overrides ?? {}),
  }
}

test('results: accepted suggestions are counted by source; the rate and latency cover the model only', async () => {
  await withHome(async (home) => {
    const log = createResultsLog({ homeDir: home, now: () => 1_800_000_000_000 })
    // 1: the model's second candidate taken.
    await log.recordRequest(modelOffer('s1', { latencyMs: 1000 }))
    await log.markShown('s1')
    await log.recordOutcome('s1', 'accepted', '', { index: 1, source: 'model' })
    // 2: a pinned phrase taken from behind the model's candidates.
    await log.recordRequest(modelOffer('s2', { latencyMs: 3000 }))
    await log.markShown('s2')
    await log.recordOutcome('s2', 'accepted', '', { index: 3, source: 'pinned' })
    // 3: a manual fallback (no model suggestion), its habit phrase taken by a page that sends no index.
    await log.recordRequest(modelOffer('s3', { trigger: 'manual', text: undefined, alternatives: undefined, fallback: true, local: [{ text: '继续', source: 'habit' }], reason: 'model-abstained', latencyMs: 2000 }))
    await log.markShown('s3')
    await log.recordOutcome('s3', 'accepted')
    // 4: shown, not taken.
    await log.recordRequest(modelOffer('s4', { latencyMs: 5000 }))
    await log.markShown('s4')
    // 5: the same suggestion handed to a second view from the cache: not a second offer, not a latency.
    await log.recordRequest(modelOffer('s4', { requestId: 'req-s4-b', cached: true, latencyMs: 1, route: undefined }))
    await log.flush()
    const summary = await log.summary(7)
    assert.equal(summary.offers, 4)
    assert.equal(summary.localFallbacks, 1)
    assert.equal(summary.shown, 4)
    assert.equal(summary.shownWithModel, 3)
    assert.equal(summary.accepted, 3)
    assert.deepEqual(summary.acceptedBySource, { model: 1, habit: 1, pinned: 1 })
    assert.equal(summary.acceptRate, Math.round((1 / 3) * 1000) / 10, 'model suggestions accepted / shown offers that had one')
    assert.equal(summary.latencyP50, 2000)
    assert.equal(summary.latencyP95, 5000)
    // Nothing but counts on disk.
    const text = await readFile(log.filePath, 'utf8')
    for (const secret of ['先跑测试', '看下 diff', '继续', 'Ship it', 'session-1', 's1"']) assert.equal(text.includes(secret), false, secret)
    assert.ok(text.includes('"source":"pinned"') && text.includes('"index":3'))
    assert.ok(text.includes('"nm":2') && text.includes('"nh":1') && text.includes('"np":1'))
  })
})

test('results: request lines of earlier versions with provider "habit" are habit offers, outside latency and the model rate', async () => {
  await withHome(async (home) => {
    const t = 1_800_000_000_000
    const old = hashId('old-habit')
    // Lines exactly as 0.4.x wrote them: no counts on the request, no source on the acceptance.
    const lines = [
      { t, kind: 'request', r: 'a', s: 'b', k: 'c', trigger: 'auto', outcome: 'offer', reason: '', provider: 'habit', model: 'local', latencyMs: 4, in: null, out: null, reasoning: null, len: 2, shown: false, g: old },
      { t, kind: 'level', g: old, event: 'shown' },
      { t, kind: 'outcome', g: old, event: 'accepted', reason: '' },
      { t, kind: 'request', r: 'd', s: 'b', k: 'e', trigger: 'auto', outcome: 'offer', reason: '', provider: 'p', model: 'm', latencyMs: 1500, in: 100, out: 5, reasoning: 0, len: 4, shown: false, g: hashId('model') },
    ]
    const { mkdir, writeFile } = await import('node:fs/promises')
    await mkdir(join(home, 'next-message-predictor'), { recursive: true })
    await writeFile(join(home, 'next-message-predictor', 'events.jsonl'), `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`, 'utf8')
    const fresh = createResultsLog({ homeDir: home, now: () => t })
    const summary = await fresh.summary(7)
    assert.deepEqual(summary.acceptedBySource, { model: 0, habit: 1, pinned: 0 })
    assert.equal(summary.acceptRate, null, 'no model suggestion was shown')
    assert.equal(summary.latencyP50, 1500, 'the 4 ms habit line is not a latency')
  })
})

test('results: the match with the next message scores the model only; the user\'s phrase is noted apart', async () => {
  await withHome(async (home) => {
    const log = createResultsLog({ homeDir: home, now: () => 1_800_000_000_000 })
    await log.recordRequest(modelOffer('s1'))
    await log.markShown('s1')
    await log.recordOutcome('s1', 'accepted', '', { index: 2, source: 'habit' })
    const match = log.noteUserMessage('session-1', '继续')
    assert.equal(match.matched, true)
    assert.equal(match.exact, false, 'the model said something else')
    assert.equal(match.local, 'habit')
    // A model candidate taken and sent unchanged: scored against that candidate.
    await log.recordRequest(modelOffer('s2'))
    await log.markShown('s2')
    await log.recordOutcome('s2', 'accepted', '', { index: 1, source: 'model' })
    assert.equal(log.noteUserMessage('session-1', '看下 diff').exact, true)
    // A fallback has no model candidate to score.
    await log.recordRequest(modelOffer('s3', { text: undefined, alternatives: undefined, fallback: true, local: [{ text: 'Ship it', source: 'pinned' }] }))
    await log.markShown('s3')
    const none = log.noteUserMessage('session-1', 'Ship it!')
    assert.equal(none.matched, true)
    assert.equal(none.exact, undefined)
    assert.equal(none.local, 'pinned')
    await log.flush()
    const summary = await log.summary(7)
    assert.equal(summary.acceptedUnalteredRate, 100, 'only the accepted model candidate is in the unaltered rate')
  })
})

test('results: a second request for the same suggestion does not wipe what was already reported', async () => {
  await withHome(async (home) => {
    const log = createResultsLog({ homeDir: home, now: () => 1_800_000_000_000 })
    await log.recordRequest(modelOffer('s1'))
    await log.markShown('s1')
    await log.recordRequest(modelOffer('s1', { requestId: 'other-view', cached: true }))
    assert.equal(log.noteUserMessage('session-1', '先跑测试').matched, true, 'still known to be shown')
    await log.flush()
    const summary = await log.summary(7)
    assert.equal(summary.offers, 1)
    assert.equal(summary.shown, 1)
    assert.equal(summary.requests, 2)
  })
})

// ── C2: pending results survive a restart of the Host half ────────────────

test('restart: with the process-wide store a new instance still knows the suggestion on screen', async () => {
  await withHome(async (home) => {
    const before = createResultsLog({ homeDir: home, now: () => 1_800_000_000_000, shareWithinProcess: true })
    await before.recordRequest(modelOffer('s1'))
    await before.markShown('s1')
    // Saving a setting re-applies the plugin in the same process.
    const after = createResultsLog({ homeDir: home, now: () => 1_800_000_000_000, shareWithinProcess: true })
    await after.recordOutcome('s1', 'accepted', '', { index: 0, source: 'model' })
    const match = after.noteUserMessage('session-1', '先跑测试')
    assert.equal(match.matched, true)
    assert.equal(match.exact, true)
    await after.flush()
    const summary = await after.summary(7)
    assert.deepEqual([summary.shown, summary.accepted, summary.acceptedUnalteredRate], [1, 1, 100])
    // Without sharing (a new process) the text is gone, as intended: it is never written to disk.
    const process2 = createResultsLog({ homeDir: home, now: () => 1_800_000_000_000 })
    assert.equal(process2.noteUserMessage('session-1', '先跑测试').matched, false)
  })
})

test('restart: through apply(), a suggestion shown before a settings save is matched with the next user message', async () => {
  await withHome(async (home) => {
    process.env.DSH_HOME = home
    delete process.env.NMP_DATA_HOME
    const config = { enabled: true, modelMode: 'fixed', provider: 'fixed-test', fakeSuggestion: '继续第二项' }
    const first = fakeHostContext(home, config)
    apply(first.ctx, config)
    first.emit({ type: 'turn/end', seq: 7, data: { turn: 1, reason: { kind: 'completed' } } })
    const route = first.routes.get(ROUTE)
    const anchor = { sessionId: 's1', branchEpoch: 'v1', turnId: 't1a3', completedEventSeq: 7, contextRevision: '4:3' }
    const offered = await (await post(route, { schemaVersion: 1, operation: 'predict', requestId: 'r1', viewId: 'v', anchor, trigger: 'auto' })).json()
    const suggestionId = offered.result.suggestionId
    assert.equal(offered.result.text, '继续第二项')
    await post(route, { schemaVersion: 1, operation: 'outcome', suggestionId, event: 'shown' })
    // The user saves a setting: DSH disposes the plugin and applies it again in the same process.
    await post(route, { schemaVersion: 1, operation: 'config.set', patch: { announceSuggestions: false } })
    first.dispose()
    const second = fakeHostContext(home, first.state.entryConfig)
    apply(second.ctx, second.state.entryConfig)
    await post(second.routes.get(ROUTE), { schemaVersion: 1, operation: 'outcome', suggestionId, event: 'closed' })
    second.emit({ type: 'user/message', seq: 9, data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '继续第二项' }] } })
    await sleep(50)
    const lines = (await readFile(join(home, 'next-message-predictor', 'events.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
    const g = hashId(suggestionId)
    assert.ok(lines.some((line) => line.kind === 'outcome' && line.g === g && line.event === 'closed'), 'the outcome after the restart is recorded')
    const match = lines.find((line) => line.kind === 'match' && line.g === g)
    assert.ok(match, 'the next user message is matched after the restart')
    assert.equal(match.exact, true)
    second.dispose()
  })
})

// ── the page: one ring, walked locally ────────────────────────────────────

function statusValue(overrides) {
  return {
    ok: true,
    value: {
      config: { ...DEFAULT_CONFIG, enabled: true, triggerDelayMs: 0, ...(overrides ?? {}) },
      configRevision: 1,
      configErrors: [],
      capabilities: { connectionFetch: true, sessionStore: true, configEditor: true },
      diagnostics: { counters: {} },
    },
  }
}

function makeEnv(overrides) {
  return {
    sessionId: 's1', turnId: 'a1', completedEventSeq: 0, branchEpoch: 'v1', contextRevision: '4:1', running: false, hasFinalText: true,
    sessionBlank: false, sessionRemoved: false, awaitingFirstTurn: false, canEdit: true, draft: '', draftRev: 0, occurrencesCount: 0,
    attachmentCount: 0, queuedCount: 0, claimed: false, phase: 'plain', composing: false, pendingInteraction: false, menuOpen: false,
    windowVisible: true, windowFocused: true, focused: true, inputMissing: false, ...(overrides ?? {}),
  }
}

async function pageWith(answer, config) {
  const calls = []
  const runtime = createClientRuntime({
    rpc: async (operation, payload) => {
      calls.push({ operation, payload })
      if (operation === 'status') return statusValue(config)
      if (operation === 'predict') return { requestId: payload.requestId, anchor: payload.anchor, configRevision: 1, result: answer(payload, calls) }
      return { ok: true, value: {} }
    },
  })
  await runtime.loadStatus()
  return { runtime, calls, state: () => runtime.assistStore.getSnapshot(), predicts: () => calls.filter((call) => call.operation === 'predict').length }
}

test('page: the ring has a source per entry; "another one" walks the local phrases without a request', async () => {
  const page = await pageWith(() => ({
    kind: 'offer', suggestionId: 'sug-1', text: '先跑测试', alternatives: ['看下 diff'], expiresAt: Date.now() + 600000,
    local: [{ text: '继续', source: 'habit' }, { text: 'Ship it', source: 'pinned' }],
  }))
  page.runtime.sync(makeEnv({ running: true, turnId: 'a0' }))
  page.runtime.sync(makeEnv())
  await sleep(20)
  assert.deepEqual(page.state().candidates, ['先跑测试', '看下 diff', '继续', 'Ship it'])
  assert.deepEqual(page.state().sources, ['model', 'model', 'habit', 'pinned'])
  assert.equal(page.runtime.canOfferAnother(), true)
  page.runtime.predictNow()
  page.runtime.predictNow()
  assert.deepEqual([page.state().text, page.state().sources[page.state().candidateIndex], page.predicts()], ['继续', 'habit', 1])
  // Accepting reports which entry was taken.
  const offer = page.runtime.prepareAdoption(makeEnv())
  assert.deepEqual([offer.index, offer.source, offer.text], [2, 'habit', '继续'])
  page.runtime.markAccepted(offer)
  const accepted = page.calls.find((call) => call.operation === 'accepted')
  assert.deepEqual([accepted.payload.suggestionId, accepted.payload.index, accepted.payload.source], ['sug-1', 2, 'habit'])
})

test('page: past the last local phrase the model is asked, as before; with no calls left the walk goes round', async () => {
  let serial = 0
  const page = await pageWith(() => {
    serial += 1
    return { kind: 'offer', suggestionId: `sug-${serial}`, text: `批${serial}`, expiresAt: Date.now() + 600000, local: [{ text: 'Ship it', source: 'pinned' }] }
  }, { manualLimit: 1 })
  page.runtime.sync(makeEnv({ running: true, turnId: 'a0' }))
  page.runtime.sync(makeEnv())
  await sleep(20)
  assert.deepEqual(page.runtime.predictNow(), { ok: true, local: true })
  assert.equal(page.state().text, 'Ship it')
  assert.equal(page.runtime.predictNow().ok, true)
  await sleep(20)
  assert.deepEqual([page.state().text, page.predicts()], ['批2', 2])
  page.runtime.predictNow()
  assert.deepEqual(page.runtime.predictNow(), { ok: true, local: true })
  assert.deepEqual([page.state().text, page.predicts()], ['批2', 2], 'round to the first entry, no third request')
})

test('page: a manual fallback is shown when nothing was on screen; it does not replace a suggestion that already held the phrases', async () => {
  const fallback = (id) => ({ kind: 'offer', suggestionId: id, text: 'Ship it', fallback: true, modelReason: 'model-abstained', expiresAt: Date.now() + 600000, local: [{ text: 'Ship it', source: 'pinned' }] })
  // Nothing on screen: the user's phrase is offered instead of "no suggestion".
  const empty = await pageWith(() => fallback('fb-1'), { manualOnly: true })
  empty.runtime.sync(makeEnv())
  assert.equal(empty.runtime.predictNow().ok, true)
  await sleep(20)
  assert.deepEqual([empty.state().status, empty.state().text, empty.state().sources], ['offered', 'Ship it', ['pinned']])
  assert.equal(empty.runtime.noticeStore.getSnapshot().kind, '')

  // A suggestion whose ring already ended with that phrase: "another one" brings it back.
  let serial = 0
  const shown = await pageWith((payload) => {
    serial += 1
    return payload.trigger === 'auto'
      ? { kind: 'offer', suggestionId: 'sug-1', text: '先跑测试', expiresAt: Date.now() + 600000, local: [{ text: 'Ship it', source: 'pinned' }] }
      : fallback(`fb-${serial}`)
  })
  shown.runtime.sync(makeEnv({ running: true, turnId: 'a0' }))
  shown.runtime.sync(makeEnv())
  await sleep(20)
  shown.runtime.predictNow()
  assert.equal(shown.state().text, 'Ship it')
  assert.equal(shown.runtime.predictNow().ok, true)
  await sleep(20)
  assert.deepEqual([shown.state().status, shown.state().suggestionId, shown.state().candidates], ['offered', 'sug-1', ['先跑测试', 'Ship it']])
  const closed = shown.calls.find((call) => call.operation === 'outcome' && call.payload.event === 'closed')
  assert.equal(closed.payload.suggestionId, 'fb-2', 'the unused fallback is closed')
})

// ── wire format ───────────────────────────────────────────────────────────

test('protocol: local entries and fallbacks are checked before the page paints them', () => {
  const envelope = (result) => ({ requestId: 'r', anchor: ANCHOR, configRevision: 1, result })
  const check = (result) => validateResponseForClient(envelope(result), { requestId: 'r', anchor: ANCHOR })
  const base = { kind: 'offer', suggestionId: 's', text: 'a', expiresAt: 1 }
  assert.equal(check({ ...base, local: [{ text: 'b', source: 'habit' }] }).ok, true)
  assert.equal(check({ ...base, local: [{ text: 'b', source: 'model' }] }).ok, false)
  assert.equal(check({ ...base, local: [{ text: '', source: 'pinned' }] }).ok, false)
  assert.equal(check({ ...base, local: 'b' }).ok, false)
  assert.equal(check({ ...base, fallback: true, local: [{ text: 'a', source: 'pinned' }] }).ok, true)
  assert.equal(check({ ...base, fallback: true, local: [{ text: 'b', source: 'pinned' }] }).ok, false)
  assert.equal(check({ ...base, fallback: true }).ok, false)
  assert.equal(check({ ...base, fallback: true, alternatives: ['x'], local: [{ text: 'a', source: 'pinned' }] }).ok, false)
  // An offer from an older Host has neither field: one model entry.
  assert.deepEqual(offerRing(base), [{ text: 'a', source: 'model' }])
  assert.deepEqual(acceptedChoice({ index: 2, source: 'pinned' }), { index: 2, source: 'pinned' })
  assert.deepEqual(acceptedChoice({ index: 0 }), { index: 0, source: '' })
  assert.equal(acceptedChoice({}), null)
  assert.equal(acceptedChoice({ index: 1, source: 'other' }), null)
})

test('service: the accepted entry and its source reach the results log', async () => {
  const outcomes = []
  const results = {
    recordRequest() {},
    recordOutcome: async (...args) => { outcomes.push(args) },
  }
  const service = makeService({ contextReader: contextReaderWith([]), modelProvider: modelSaying(() => say('x')), results })
  await service.handle({ schemaVersion: 1, operation: 'accepted', suggestionId: 'sug-9', index: 3, source: 'pinned' })
  await service.handle({ schemaVersion: 1, operation: 'accepted', suggestionId: 'sug-10' })
  assert.deepEqual(outcomes, [['sug-9', 'accepted', '', { index: 3, source: 'pinned' }], ['sug-10', 'accepted', '', null]])
})

// ── AltGr ─────────────────────────────────────────────────────────────────
// Synthetic events only: this has not been tried on a real AltGr keyboard layout.

const keyEvent = (code, mods, altGraph) => ({
  code,
  key: 'x',
  ctrlKey: mods.includes('Ctrl'),
  altKey: mods.includes('Alt'),
  shiftKey: false,
  metaKey: false,
  ...(altGraph === undefined ? {} : { getModifierState: (name) => name === 'AltGraph' && altGraph === true }),
})

test('AltGr: a key typed with AltGr never matches a Ctrl+Alt shortcut and is never recorded', () => {
  const shortcut = parseShortcut('Ctrl+Alt+KeyQ')
  assert.ok(shortcut, 'Ctrl+Alt+Q can be set')
  // Windows reports AltGr+Q (@ on a German layout) as Ctrl+Alt+Q.
  assert.equal(eventMatchesShortcut(keyEvent('KeyQ', ['Ctrl', 'Alt'], true), shortcut), false)
  assert.equal(isAltGraphEvent(keyEvent('KeyQ', ['Ctrl', 'Alt'], true)), true)
  // Left Ctrl + left Alt is not AltGr.
  assert.equal(eventMatchesShortcut(keyEvent('KeyQ', ['Ctrl', 'Alt'], false), shortcut), true)
  // No getModifierState (as in tests and some synthetic events): the modifiers decide, nothing throws.
  assert.equal(eventMatchesShortcut(keyEvent('KeyQ', ['Ctrl', 'Alt']), shortcut), true)
  const throwing = { ...keyEvent('KeyQ', ['Ctrl', 'Alt']), getModifierState: () => { throw new Error('no') } }
  assert.equal(isAltGraphEvent(throwing), false)
  // Recording.
  assert.equal(shortcutFromEvent(keyEvent('KeyQ', ['Ctrl', 'Alt'], true)), '')
  assert.equal(shortcutFromEvent(keyEvent('KeyQ', ['Ctrl', 'Alt'], false)), 'Ctrl+Alt+KeyQ')
  assert.deepEqual(nmpShortcutKeyAction(keyEvent('KeyQ', ['Ctrl', 'Alt'], true)), { kind: 'altgr' })
  assert.deepEqual(nmpShortcutKeyAction(keyEvent('KeyQ', ['Ctrl', 'Alt'], false)), { kind: 'ok', shortcut: 'Ctrl+Alt+KeyQ' })
  assert.deepEqual(nmpShortcutKeyAction({ ...keyEvent('AltRight', [], true), key: 'AltGraph' }), { kind: 'altgr' })
  assert.deepEqual(nmpShortcutKeyAction({ ...keyEvent('Escape', []), key: 'Escape' }), { kind: 'cancel' })
  assert.deepEqual(nmpShortcutKeyAction(keyEvent('ControlLeft', ['Ctrl'])), { kind: 'wait' })
  assert.deepEqual(nmpShortcutKeyAction(keyEvent('KeyV', ['Ctrl'])), { kind: 'invalid' })
  // The default Alt+\ is unaffected.
  assert.equal(eventMatchesShortcut(keyEvent('Backslash', ['Alt'], false), parseShortcut('Alt+Backslash')), true)
})
