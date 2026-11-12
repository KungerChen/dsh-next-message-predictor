// Unreleased (after 0.4.0): honest accounting of calls whose usage never
// arrived, and per-turn call counts that survive a restart of the Host half.
// See the "未发布" section of CHANGELOG.md.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DEFAULT_CONFIG } from '../src/shared/config.js'
import { estimateTokens } from '../src/shared/prompt.js'
import { chargeForCall, createPersistentLedger, dayKey } from '../src/host/budget-ledger.js'
import { createModelProvider } from '../src/host/model-provider.js'
import { createPredictorService } from '../src/host/predictor-service.js'

const CLOCK = Date.parse('2026-11-11T08:00:00Z')
const TODAY = dayKey(CLOCK, 'UTC')
const LIMITS = { dailyRequestLimit: 200, dailyTokenBudget: 500000 }

async function withHome(run) {
  const home = await mkdtemp(join(tmpdir(), 'nmp-v041-'))
  try {
    await run(home)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
}

function openLedger(home, overrides) {
  const lines = []
  const ledger = createPersistentLedger({
    homeDir: home,
    now: () => CLOCK,
    getTimeZone: () => 'UTC',
    getLimits: () => LIMITS,
    logger: (line) => lines.push(String(line)),
    ...(overrides ?? {}),
  })
  ledger.lines = lines
  return ledger
}

async function writeLedgerFile(home, value) {
  const dir = join(home, 'next-message-predictor')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'ledger.json'), JSON.stringify(value), 'utf8')
}

async function readLedgerFile(ledger) {
  return JSON.parse(await readFile(ledger.filePath, 'utf8'))
}

// ── the charge for one call ───────────────────────────────────────────────

test('charge: a call with complete reported usage is measured, nothing is estimated', () => {
  const charge = chargeForCall({
    reservedTokens: 1096, inputTokens: 1000, maxOutputTokens: 96, finishKind: 'stop',
    usage: { inputTokens: 600, cacheReadTokens: 100, outputTokens: 12, reasoningTokens: 0 },
  })
  assert.deepEqual(charge, { inputTokens: 700, outputTokens: 12, reasoningTokens: 0, estimatedTokens: 0, estimated: false })
})

test('charge: each way a call can end without (full) usage', () => {
  const base = { reservedTokens: 1096, inputTokens: 1000, maxOutputTokens: 96, observedOutputTokens: 10 }
  const cases = [
    // [label, facts, measured input, estimated]
    ['finished normally, no usage, no reasoning: the text it returned is the output', { finishKind: 'stop', reasoningRuledOut: true }, 0, 1000 + 10],
    ['finished normally, no usage, reasoning possible: unseen reasoning is bounded by the cap', { finishKind: 'stop', reasoningRuledOut: false }, 0, 1000 + 96],
    ['cut off at the output limit: the output is the cap', { finishKind: 'max-tokens' }, 0, 1000 + 96],
    ['timed out or cancelled (aborted finish)', { finishKind: 'aborted' }, 0, 1000 + 96],
    ['provider reported an error finish', { finishKind: 'error' }, 0, 1000 + 96],
    ['stream ended without a finish', { finishKind: 'missing' }, 0, 1000 + 96],
    ['stream threw, nothing reported', { finishKind: 'threw' }, 0, 1000 + 96],
    ['stream threw after the input was reported: input measured, output estimated',
      { finishKind: 'threw', partialUsage: { inputTokens: 640, cacheReadTokens: 60 } }, 700, 96],
    ['aborted with an input-only usage report', { finishKind: 'aborted', usage: { inputTokens: 700, outputTokens: 0 } }, 700, 96],
    ['more text arrived than the cap allows for: the observed amount counts', { finishKind: 'threw', observedOutputTokens: 150 }, 0, 1000 + 150],
    ['a process that died mid-call left nothing but the reservation', { finishKind: 'orphaned' }, 0, 1000 + 96],
  ]
  for (const [label, facts, measuredInput, estimated] of cases) {
    const charge = chargeForCall({ ...base, ...facts })
    assert.equal(charge.inputTokens, measuredInput, label)
    assert.equal(charge.outputTokens, 0, label)
    assert.equal(charge.estimatedTokens, estimated, label)
    assert.equal(charge.estimated, true, label)
  }
  // A partial report never counts as the output: an output figure in it is ignored.
  const partial = chargeForCall({ ...base, finishKind: 'threw', partialUsage: { inputTokens: 700, outputTokens: 3 } })
  assert.equal(partial.outputTokens, 0)
  assert.equal(partial.estimatedTokens, 96)
  // An aborted finish that did report output is measured.
  const reported = chargeForCall({ ...base, finishKind: 'aborted', usage: { inputTokens: 700, outputTokens: 40 } })
  assert.deepEqual(reported, { inputTokens: 700, outputTokens: 40, reasoningTokens: 0, estimatedTokens: 0, estimated: false })
})

test('charge: callers that say nothing about the ending keep the old meaning', () => {
  assert.equal(chargeForCall({ reservedTokens: 356 }).estimatedTokens, 356)
  assert.equal(chargeForCall({ reservedTokens: 356, usage: { inputTokens: 30, outputTokens: 5 } }).inputTokens, 30)
})

// ── the three categories and the daily limit ──────────────────────────────

test('ledger: an unknown call moves from "reserved" to "estimated" when it ends', async () => {
  await withHome(async (home) => {
    const ledger = openLedger(home)
    const reservation = await ledger.reserve({ dispatchKey: 'k1', estimate: { inputTokens: 1000, maxOutputTokens: 96 } })
    assert.equal(reservation.ok, true)
    assert.equal(reservation.inputTokens, 1000)
    assert.equal(reservation.maxOutputTokens, 96)
    let snapshot = ledger.snapshot()
    assert.equal(snapshot.reservedTokens, 1096)
    assert.equal(snapshot.inflightDispatches, 1)
    assert.equal((await readLedgerFile(ledger)).dispatches.k1.reserved, 1096, 'the reservation is recorded on the call')

    await ledger.settle({ ...reservation, dispatchKey: 'k1', finishKind: 'threw', partialUsage: { inputTokens: 800 } })
    snapshot = ledger.snapshot()
    assert.equal(snapshot.reservedTokens, 0)
    assert.equal(snapshot.inputTokens, 800, 'what was reported is measured')
    assert.equal(snapshot.estimatedTokens, 96, 'only the missing output is estimated')
    assert.equal(snapshot.unknownUsage, 1)
    assert.equal(snapshot.usedTokens, 896)
    assert.equal(snapshot.inflightDispatches, 0)
    assert.equal((await readLedgerFile(ledger)).dispatches.k1.reserved, 0)
  })
})

test('ledger: the daily token limit counts measured + estimated + in-flight, and nothing else', async () => {
  await withHome(async (home) => {
    const ledger = openLedger(home, { getLimits: () => ({ dailyRequestLimit: 100, dailyTokenBudget: 1000 }) })
    const measured = await ledger.reserve({ dispatchKey: 'measured', estimate: { inputTokens: 250, maxOutputTokens: 50 } })
    await ledger.settle({ ...measured, dispatchKey: 'measured', finishKind: 'stop', usage: { inputTokens: 250, outputTokens: 30, reasoningTokens: 20 } })
    const unknown = await ledger.reserve({ dispatchKey: 'unknown', estimate: { inputTokens: 150, maxOutputTokens: 50 } })
    await ledger.settle({ ...unknown, dispatchKey: 'unknown', finishKind: 'aborted' })
    const running = await ledger.reserve({ dispatchKey: 'running', estimate: { inputTokens: 250, maxOutputTokens: 50 } })
    assert.equal(running.ok, true)
    const snapshot = ledger.snapshot()
    assert.equal(snapshot.measuredTokens, 300)
    assert.equal(snapshot.estimatedTokens, 200)
    assert.equal(snapshot.reservedTokens, 300)
    assert.equal(snapshot.usedTokens, 800)
    // 200 tokens are left, exactly.
    assert.equal(ledger.canReserve({ inputTokens: 150, maxOutputTokens: 50 }).ok, true)
    assert.deepEqual(ledger.canReserve({ inputTokens: 151, maxOutputTokens: 50 }), { ok: false, reason: 'daily-token-budget' })
    const refused = await ledger.reserve({ dispatchKey: 'over', estimate: { inputTokens: 151, maxOutputTokens: 50 } })
    assert.equal(refused.reason, 'daily-token-budget')
  })
})

// ── reservations left by a previous process ───────────────────────────────

test('orphans: a reservation left by a crashed process becomes an estimate on load, and is logged', async () => {
  await withHome(async (home) => {
    const before = openLedger(home)
    await before.reserve({ dispatchKey: 'mid-call', estimate: { inputTokens: 1000, maxOutputTokens: 96 } })
    // The process dies here: no settle.
    const after = openLedger(home)
    await after.ensureLoaded()
    const snapshot = after.snapshot()
    assert.equal(snapshot.reservedTokens, 0, 'nothing is in flight in a fresh process')
    assert.equal(snapshot.estimatedTokens, 1096, 'nothing is known about the call, so the whole reservation is charged')
    assert.equal(snapshot.unknownUsage, 1)
    assert.equal(snapshot.orphanedCalls, 1)
    assert.equal(snapshot.usedTokens, 1096, 'the daily total is unchanged')
    assert.equal(snapshot.requests, 1)
    assert.ok(after.lines.some((line) => /1 call\(s\) were still running/.test(line) && /1096/.test(line)), after.lines.join('\n'))

    // Loading the same file again gives the same numbers (the conversion is not applied twice) ...
    const again = openLedger(home)
    await again.ensureLoaded()
    assert.equal(again.snapshot().estimatedTokens, 1096)
    assert.equal(again.snapshot().unknownUsage, 1)
    // ... and once a converted ledger has been written, there is nothing left to convert.
    await again.reserve({ dispatchKey: 'next', estimate: { inputTokens: 10, maxOutputTokens: 10 } })
    await again.settle({ dispatchKey: 'next', day: TODAY, reservedTokens: 20, inputTokens: 10, maxOutputTokens: 10, finishKind: 'stop', usage: { inputTokens: 10, outputTokens: 2 } })
    const third = openLedger(home)
    await third.ensureLoaded()
    assert.equal(third.snapshot().estimatedTokens, 1096)
    assert.equal(third.snapshot().orphanedCalls, 1)
    assert.equal(third.lines.length, 0, 'nothing to report')
  })
})

test('orphans: within one process a restarted plugin shares the ledger, so a running call is not mistaken for an orphan', async () => {
  await withHome(async (home) => {
    const old = openLedger(home, { shareWithinProcess: true })
    const reservation = await old.reserve({ dispatchKey: 'running', estimate: { inputTokens: 1000, maxOutputTokens: 96 } })
    // Saving a setting re-applies the plugin: a second instance on the same file.
    const fresh = openLedger(home, { shareWithinProcess: true })
    await fresh.ensureLoaded()
    assert.equal(fresh.snapshot().reservedTokens, 1096, 'still in flight')
    assert.equal(fresh.snapshot().estimatedTokens, 0)
    // The old instance's call finishes and is settled with its real usage.
    await old.settle({ ...reservation, dispatchKey: 'running', finishKind: 'stop', usage: { inputTokens: 900, outputTokens: 20 } })
    const snapshot = fresh.snapshot()
    assert.equal(snapshot.reservedTokens, 0)
    assert.equal(snapshot.estimatedTokens, 0)
    assert.equal(snapshot.inputTokens, 900)
    assert.equal(snapshot.outputTokens, 20)
    assert.equal(fresh.lines.length + old.lines.length, 0)
  })
})

// ── ledgers written by 0.4.0 and earlier ──────────────────────────────────

test('migration: a 0.4.0 ledger loads, its held tokens become estimates and the daily total stays the same', async () => {
  await withHome(async (home) => {
    await writeLedgerFile(home, {
      schemaVersion: 1,
      dispatches: {
        'old-shown': { at: CLOCK - 60000, day: TODAY, trigger: 'auto', provider: 'p', model: 'm', configRevision: 1, shown: true, attempt: 1 },
        'old-legacy': { at: CLOCK - 60000, day: TODAY, trigger: 'auto', provider: 'p', model: 'm', configRevision: 1 },
      },
      budgetDays: {
        [TODAY]: { requests: 3, inputTokens: 1000, outputTokens: 40, reasoningTokens: 5, unknownUsage: 1, reservedTokens: 2192 },
      },
      updatedAt: CLOCK - 60000,
    })
    const ledger = openLedger(home, { getLimits: () => ({ dailyRequestLimit: 200, dailyTokenBudget: 4000 }) })
    await ledger.ensureLoaded()
    const snapshot = ledger.snapshot()
    assert.equal(snapshot.requests, 3)
    assert.equal(snapshot.measuredTokens, 1045)
    assert.equal(snapshot.reservedTokens, 0)
    assert.equal(snapshot.estimatedTokens, 2192)
    assert.equal(snapshot.usedTokens, 1045 + 2192, 'the total the limit compares against is unchanged')
    assert.equal(snapshot.unknownUsage, 1, 'not recounted: 0.4.0 already counted its unknown calls')
    assert.equal(snapshot.orphanedCalls, 0)
    assert.ok(ledger.lines.some((line) => /earlier version/.test(line) && /2192/.test(line)), ledger.lines.join('\n'))
    // Dispatch records keep their meaning (B05: a record without "shown" counts as shown).
    assert.equal(ledger.hasDispatch('old-shown'), true)
    assert.equal(ledger.hasDispatch('old-legacy'), true)
    // The limit still holds: 4000 - 3237 = 763 left.
    assert.equal(ledger.canReserve({ inputTokens: 700, maxOutputTokens: 63 }).ok, true)
    assert.equal(ledger.canReserve({ inputTokens: 700, maxOutputTokens: 64 }).ok, false)
    // The next write is in the new format.
    await ledger.reserve({ dispatchKey: 'new', estimate: { inputTokens: 10, maxOutputTokens: 10 } })
    const onDisk = await readLedgerFile(ledger)
    assert.equal(onDisk.schemaVersion, 2)
    assert.equal(onDisk.budgetDays[TODAY].estimatedTokens, 2192)
    assert.equal(onDisk.budgetDays[TODAY].reservedTokens, 20)
    assert.deepEqual(onDisk.turns, {})
  })
})

test('migration: a 0.4.0 ledger with nothing held loads silently', async () => {
  await withHome(async (home) => {
    await writeLedgerFile(home, {
      schemaVersion: 1,
      dispatches: {},
      budgetDays: { [TODAY]: { requests: 1, inputTokens: 100, outputTokens: 4, reasoningTokens: 0, unknownUsage: 0, reservedTokens: 0 } },
      updatedAt: CLOCK,
    })
    const ledger = openLedger(home)
    await ledger.ensureLoaded()
    assert.equal(ledger.snapshot().usedTokens, 104)
    assert.equal(ledger.snapshot().estimatedTokens, 0)
    assert.deepEqual(ledger.lines, [])
  })
})

// ── per-turn call counts on disk ──────────────────────────────────────────

test('turns: the call count is written with the reservation, refunded with it, and read back after a restart', async () => {
  await withHome(async (home) => {
    const ledger = openLedger(home)
    const turn = 's1\u0000v1\u0000t1'
    const first = await ledger.reserve({ dispatchKey: 'm0', trigger: 'manual', turnKey: turn, manualLimit: 2, estimate: { inputTokens: 1, maxOutputTokens: 1 } })
    assert.equal(first.ok, true)
    assert.deepEqual(ledger.turnCalls(turn), { auto: 0, manual: 1 })
    assert.deepEqual((await readLedgerFile(ledger)).turns[turn], { at: CLOCK, auto: 0, manual: 1 })
    // A call that never reached the model gives its count back.
    const second = await ledger.reserve({ dispatchKey: 'm1', trigger: 'manual', turnKey: turn, manualLimit: 2, estimate: { inputTokens: 1, maxOutputTokens: 1 } })
    await ledger.settle({ ...second, dispatchKey: 'm1', notDispatched: true })
    assert.deepEqual(ledger.turnCalls(turn), { auto: 0, manual: 1 })
    await ledger.reserve({ dispatchKey: 'm1', trigger: 'manual', turnKey: turn, manualLimit: 2, estimate: { inputTokens: 1, maxOutputTokens: 1 } })
    assert.equal(ledger.turnCredit(turn, 'manual', 2), false)
    const third = await ledger.reserve({ dispatchKey: 'm2', trigger: 'manual', turnKey: turn, manualLimit: 2, estimate: { inputTokens: 1, maxOutputTokens: 1 } })
    assert.deepEqual(third, { ok: false, reason: 'turn-limit' })

    const restarted = openLedger(home)
    await restarted.ensureLoaded()
    assert.deepEqual(restarted.turnCalls(turn), { auto: 0, manual: 2 })
    assert.equal(restarted.turnCredit(turn, 'manual', 2), false)
    assert.equal(restarted.turnCredit(turn, 'manual', 3), true, 'a higher limit set afterwards applies')
    assert.equal(restarted.turnCredit(turn, 'auto', 2), true, 'automatic and manual are counted apart')
  })
})

test('turns: a failed write leaves the count untouched (fail closed, credit not used)', async () => {
  await withHome(async (home) => {
    const ledger = openLedger(home)
    await ledger.ensureLoaded()
    const dir = join(home, 'next-message-predictor')
    await rm(dir, { recursive: true, force: true })
    await writeFile(dir, 'blocked', 'utf8')
    const turn = 's1\u0000v1\u0000t1'
    const failed = await ledger.reserve({ dispatchKey: 'm0', trigger: 'manual', turnKey: turn, manualLimit: 1, estimate: { inputTokens: 1, maxOutputTokens: 1 } })
    assert.deepEqual(failed, { ok: false, reason: 'ledger-write-failed' })
    assert.deepEqual(ledger.turnCalls(turn), { auto: 0, manual: 0 })
    assert.equal(ledger.snapshot().requests, 0)
    assert.equal(ledger.snapshot().reservedTokens, 0)
    await rm(dir, { force: true })
    const retried = await ledger.reserve({ dispatchKey: 'm0', trigger: 'manual', turnKey: turn, manualLimit: 1, estimate: { inputTokens: 1, maxOutputTokens: 1 } })
    assert.equal(retried.ok, true)
    assert.deepEqual(ledger.turnCalls(turn), { auto: 0, manual: 1 })
  })
})

test('turns: records older than a day are dropped, and the number kept is bounded', async () => {
  await withHome(async (home) => {
    const turns = { old: { at: CLOCK - 25 * 60 * 60 * 1000, auto: 1, manual: 3 }, recent: { at: CLOCK - 60 * 60 * 1000, auto: 1, manual: 2 } }
    for (let i = 0; i < 2100; i += 1) turns[`bulk-${i}`] = { at: CLOCK - 2 * 60 * 60 * 1000 - (2100 - i), auto: 0, manual: 1 }
    await writeLedgerFile(home, { schemaVersion: 2, dispatches: {}, turns, budgetDays: {}, updatedAt: CLOCK })
    const ledger = openLedger(home)
    await ledger.ensureLoaded()
    assert.deepEqual(ledger.turnCalls('old'), { auto: 0, manual: 0 }, 'a day later the turn is forgotten')
    assert.deepEqual(ledger.turnCalls('recent'), { auto: 1, manual: 2 })
    assert.equal(ledger.snapshot().trackedTurns, 2000)
    assert.deepEqual(ledger.turnCalls('bulk-0'), { auto: 0, manual: 0 }, 'the oldest go first')
    assert.deepEqual(ledger.turnCalls('bulk-2099'), { auto: 0, manual: 1 })
    await ledger.reserve({ dispatchKey: 'x', estimate: { inputTokens: 1, maxOutputTokens: 1 } })
    const onDisk = await readLedgerFile(ledger)
    assert.equal(Object.keys(onDisk.turns).length, 2000)
    assert.equal('old' in onDisk.turns, false)
  })
})

// ── through the service ───────────────────────────────────────────────────

function predictBody(requestId, overrides) {
  return {
    schemaVersion: 1,
    operation: 'predict',
    requestId,
    viewId: 'view-1',
    anchor: { sessionId: 'sess-1', branchEpoch: 'v1', turnId: 't1a3', completedEventSeq: 5, contextRevision: 'r1' },
    trigger: 'auto',
    ...(overrides ?? {}),
  }
}
const TURN_KEY = 'sess-1\u0000v1\u0000t1a3'

function serviceParts(produce) {
  return {
    adapter: {
      connectionAvailable: true,
      configEditorAvailable: true,
      capabilities: () => ({ connectionFetch: true, configEditor: true, sessionStore: true, agentRegistry: true }),
      sessionKnown: () => true,
      persistConfig: async (patch) => ({ ok: true, config: { ...DEFAULT_CONFIG, enabled: true, ...patch } }),
    },
    contextReader: {
      verifyAnchor: async () => ({ ok: true, isCurrent: () => true, completedAt: Date.now() }),
      read: async () => ({
        ok: true,
        messages: [{ role: 'user', text: '帮我看看这个 bug' }, { role: 'assistant', text: '原因可能是配置缺失。' }],
        input: '[用户] 帮我看看这个 bug\n\n[助手] 原因可能是配置缺失。\n',
        modelSelection: { provider: 'p', model: 'm' },
        truncated: false, codePoints: 30, estimatedTokens: 120, redactions: 0, source: 'test',
      }),
    },
    modelProvider: {
      calls: [],
      resolveRoute: () => ({ ok: true, provider: 'p', model: 'm', source: 'session' }),
      previewRoute: () => ({ ok: true, provider: 'p', model: 'm', source: 'session' }),
      async produce(call) {
        this.calls.push(call)
        return produce(this.calls.length, call)
      },
    },
  }
}
const offer = (text) => ({ kind: 'raw', text: JSON.stringify({ suggestion: text }), usage: { inputTokens: 120, outputTokens: 8, reasoningTokens: 0 }, finishKind: 'stop', route: { provider: 'p', model: 'm' }, effort: 'off', elapsedMs: 5 })
const TEXTS = ['先跑测试', '看下 diff', '提交吧', '再查一次日志', '改一下配置']
const CONFIG = { ...DEFAULT_CONFIG, enabled: true, multiCandidates: false, habitSuggestions: false }

function makeService(ledger, parts, config) {
  return createPredictorService({ config: { ...CONFIG, ...(config ?? {}) }, ...parts, ledger, results: null })
}

for (const [label, shared] of [['a DSH restart', false], ['a settings save (Host half restarted in the same process)', true]]) {
  test(`credits: manual predictions used before ${label} still count`, async () => {
    await withHome(async (home) => {
      const options = { now: Date.now, shareWithinProcess: shared }
      const parts = serviceParts((call) => offer(TEXTS[call - 1]))
      const first = makeService(openLedger(home, options), parts)
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const response = await first.handle(predictBody(`m${attempt}`, { trigger: 'manual', attempt }), new AbortController().signal)
        assert.equal(response.body.result.kind, 'offer', JSON.stringify(response.body.result))
      }
      assert.equal(parts.modelProvider.calls.length, 3)
      const fourth = await first.handle(predictBody('m3', { trigger: 'manual', attempt: 3 }), new AbortController().signal)
      assert.equal(fourth.body.result.reason, 'already-requested')
      first.dispose()

      // The restarted Host has empty memory; the page starts counting from zero again.
      const ledger = openLedger(home, options)
      const second = makeService(ledger, parts)
      for (const [requestId, attempt] of [['after-0', 0], ['after-1', 1], ['after-5', 5]]) {
        const response = await second.handle(predictBody(requestId, { trigger: 'manual', attempt }), new AbortController().signal)
        assert.equal(response.body.result.kind, 'stale', JSON.stringify(response.body.result))
        assert.equal(response.body.result.reason, 'already-requested')
      }
      assert.equal(parts.modelProvider.calls.length, 3, 'no model call after the restart')
      assert.deepEqual(ledger.turnCalls(TURN_KEY), { auto: 0, manual: 3 })
      second.dispose()
    })
  })
}

test('credits: what is left of the manual limit is still available after a restart', async () => {
  await withHome(async (home) => {
    const parts = serviceParts((call) => offer(TEXTS[call - 1]))
    const first = makeService(openLedger(home, { now: Date.now }), parts)
    const used = await first.handle(predictBody('m0', { trigger: 'manual' }), new AbortController().signal)
    assert.equal(used.body.result.kind, 'offer')
    first.dispose()
    const second = makeService(openLedger(home, { now: Date.now }), parts)
    const results = []
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const response = await second.handle(predictBody(`n${attempt}`, { trigger: 'manual', attempt: attempt + 1 }), new AbortController().signal)
      results.push(response.body.result.kind === 'offer' ? 'offer' : response.body.result.reason)
    }
    assert.deepEqual(results, ['offer', 'offer', 'already-requested', 'already-requested'])
    assert.equal(parts.modelProvider.calls.length, 3)
  })
})

test('credits: B05 is unchanged, an automatic prediction that was never shown may be sent once more after a restart', async () => {
  await withHome(async (home) => {
    const parts = serviceParts((call) => offer(TEXTS[call - 1]))
    const first = makeService(openLedger(home, { now: Date.now }), parts)
    assert.equal((await first.handle(predictBody('a0'), new AbortController().signal)).body.result.kind, 'offer')
    first.dispose()
    // Not shown (the page went away before it could report "shown").
    const second = makeService(openLedger(home, { now: Date.now }), parts)
    assert.equal((await second.handle(predictBody('a1'), new AbortController().signal)).body.result.kind, 'offer')
    second.dispose()
    const ledger = openLedger(home, { now: Date.now })
    const third = makeService(ledger, parts)
    const refused = await third.handle(predictBody('a2'), new AbortController().signal)
    assert.equal(refused.body.result.kind === 'offer', false)
    assert.equal(parts.modelProvider.calls.length, 2)
    assert.deepEqual(ledger.turnCalls(TURN_KEY), { auto: 2, manual: 0 })
  })
})

test('credits: a failed ledger write uses up neither the turn in memory nor on disk', async () => {
  await withHome(async (home) => {
    const ledger = openLedger(home, { now: Date.now })
    await ledger.ensureLoaded()
    const dir = join(home, 'next-message-predictor')
    await rm(dir, { recursive: true, force: true })
    await writeFile(dir, 'blocked', 'utf8')
    const parts = serviceParts((call) => offer(TEXTS[call - 1]))
    const service = makeService(ledger, parts, { manualLimit: 1 })
    const failed = await service.handle(predictBody('m0', { trigger: 'manual' }), new AbortController().signal)
    assert.equal(failed.body.result.reason, 'ledger-write-failed')
    assert.equal(parts.modelProvider.calls.length, 0)
    assert.deepEqual(ledger.turnCalls(TURN_KEY), { auto: 0, manual: 0 })
    await rm(dir, { force: true })
    const retried = await service.handle(predictBody('m0-retry', { trigger: 'manual' }), new AbortController().signal)
    assert.equal(retried.body.result.kind, 'offer', JSON.stringify(retried.body.result))
    assert.deepEqual(ledger.turnCalls(TURN_KEY), { auto: 0, manual: 1 })
  })
})

test('service: a timed-out call is charged its input estimate plus the output cap, and the status says so', async () => {
  await withHome(async (home) => {
    const ledger = openLedger(home, { now: Date.now })
    const parts = serviceParts(() => ({ kind: 'abstain', reason: 'finish-aborted' }))
    const service = makeService(ledger, parts)
    const response = await service.handle(predictBody('t0'), new AbortController().signal)
    assert.equal(response.body.result.reason, 'finish-aborted')
    const status = await service.handle({ schemaVersion: 1, operation: 'status' })
    const budget = status.body.value.budget
    assert.equal(budget.reservedTokens, 0)
    assert.equal(budget.measuredTokens, 0)
    assert.equal(budget.unknownUsage, 1)
    const call = parts.modelProvider.calls[0]
    const inputEstimate = estimateTokens(call.system) + estimateTokens(call.input) + 24
    assert.equal(budget.estimatedTokens, inputEstimate + CONFIG.maxOutputTokens)
    assert.equal(budget.usedTokens, budget.estimatedTokens)
  })
})

test('service: the reservation covers what is really sent, including the manual note and the candidate prompt', async () => {
  await withHome(async (home) => {
    const ledger = openLedger(home, { now: Date.now })
    const parts = serviceParts(() => ({ kind: 'abstain', reason: 'finish-error' }))
    const service = makeService(ledger, parts, { multiCandidates: true })
    await service.handle(predictBody('m0', { trigger: 'manual' }), new AbortController().signal)
    const call = parts.modelProvider.calls[0]
    const inputEstimate = estimateTokens(call.system) + estimateTokens(call.input) + 24
    assert.ok(inputEstimate > 120, 'more than the excerpt-only estimate the context reader reports')
    // Multiple candidates raise the output cap (three candidates: 200 tokens).
    assert.equal(call.config.maxOutputTokens, 200)
    assert.equal(ledger.snapshot().estimatedTokens, inputEstimate + 200)
  })
})

test('service: a stream that breaks after reporting its input is charged the measured input plus the output cap', async () => {
  await withHome(async (home) => {
    const ledger = openLedger(home, { now: Date.now })
    const llm = {
      async prepareCall(request) {
        return {
          config: { maxTokens: request.maxTokens },
          async *stream() {
            yield { type: 'usage', usage: { inputTokens: 900, cacheReadTokens: 50 } }
            yield { type: 'text-delta', text: '{"sugg' }
            throw new Error('socket hang up')
          },
        }
      },
    }
    const parts = serviceParts(() => {
      throw new Error('not used')
    })
    parts.modelProvider = createModelProvider({ getLlm: () => llm, getDefaultModel: () => undefined })
    const service = makeService(ledger, parts)
    const response = await service.handle(predictBody('s0'), new AbortController().signal)
    assert.equal(response.body.result.kind, 'unavailable')
    assert.match(response.body.result.reason, /^stream-failed/)
    const snapshot = ledger.snapshot()
    assert.equal(snapshot.inputTokens, 950, 'the reported input is measured')
    assert.equal(snapshot.outputTokens, 0)
    assert.equal(snapshot.estimatedTokens, CONFIG.maxOutputTokens, 'only the output is estimated')
    assert.equal(snapshot.reservedTokens, 0)
    assert.equal(snapshot.unknownUsage, 1)
  })
})

test('service: a call that finished but reported no usage, with reasoning off, is charged what it returned', async () => {
  await withHome(async (home) => {
    const ledger = openLedger(home, { now: Date.now })
    const text = JSON.stringify({ suggestion: '先跑测试' })
    const parts = serviceParts(() => ({ kind: 'raw', text, finishKind: 'stop', route: { provider: 'p', model: 'm' }, effort: 'off', elapsedMs: 5 }))
    const service = makeService(ledger, parts)
    const response = await service.handle(predictBody('u0'), new AbortController().signal)
    assert.equal(response.body.result.kind, 'offer')
    const call = parts.modelProvider.calls[0]
    const inputEstimate = estimateTokens(call.system) + estimateTokens(call.input) + 24
    assert.equal(ledger.snapshot().estimatedTokens, inputEstimate + estimateTokens(text))
    assert.ok(estimateTokens(text) < CONFIG.maxOutputTokens)
  })
})
