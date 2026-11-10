// P2 持久账本测试（临时目录，无网络）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createPersistentLedger, dayKey } from '../src/host/budget-ledger.js'

async function tempHome() {
  return mkdtemp(join(tmpdir(), 'nmp-ledger-'))
}

function limits(overrides) {
  return { dailyRequestLimit: 200, dailyTokenBudget: 500000, ...(overrides ?? {}) }
}

test('reserve persists dispatch and budget, survives reload', async () => {
  const home = await tempHome()
  try {
    const now = () => 1700000000000
    const ledger = createPersistentLedger({ homeDir: home, now, getTimeZone: () => 'UTC', getLimits: () => limits() })
    const result = await ledger.reserve({
      dispatchKey: 's1\u0000v1\u00001\u0000a7',
      estimate: { inputTokens: 100, maxOutputTokens: 256 },
      trigger: 'auto',
      provider: 'p',
      model: 'm',
      configRevision: 7,
    })
    assert.equal(result.ok, true)
    // B05：新派发尚未展示，不算“已派发”，允许重启后补发一次。
    assert.equal(ledger.hasDispatch('s1\u0000v1\u00001\u0000a7'), false)
    assert.equal(ledger.snapshot().unshownDispatches, 1)
    const snapshot = ledger.snapshot()
    assert.equal(snapshot.requests, 1)
    assert.equal(snapshot.reservedTokens, 356)
    const onDisk = JSON.parse(await readFile(ledger.filePath, 'utf8'))
    assert.ok(onDisk.dispatches['s1\u0000v1\u00001\u0000a7'])
    // 展示后账本标记 shown，同一回合不再补发。
    await ledger.markShown('s1\u0000v1\u00001\u0000a7')
    assert.equal(ledger.hasDispatch('s1\u0000v1\u00001\u0000a7'), true)
    // 新实例（模拟重启）能读到派发记录与展示状态。
    const reloaded = createPersistentLedger({ homeDir: home, now, getTimeZone: () => 'UTC', getLimits: () => limits() })
    await reloaded.ensureLoaded()
    assert.equal(reloaded.hasDispatch('s1\u0000v1\u00001\u0000a7'), true)
    assert.equal(reloaded.snapshot().requests, 1)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('B05: unshown dispatch may be retried once, shown or used-up dispatch is refused', async () => {
  const home = await tempHome()
  try {
    const ledger = createPersistentLedger({ homeDir: home, getLimits: () => limits() })
    const first = await ledger.reserve({ dispatchKey: 'k1', estimate: { inputTokens: 1, maxOutputTokens: 1 } })
    assert.equal(first.ok, true)
    // 未展示：允许一次（模拟 Host 重启后补发）。
    const retry = await ledger.reserve({ dispatchKey: 'k1', estimate: { inputTokens: 1, maxOutputTokens: 1 } })
    assert.equal(retry.ok, true)
    // 重试额度用尽。
    const third = await ledger.reserve({ dispatchKey: 'k1', estimate: { inputTokens: 1, maxOutputTokens: 1 } })
    assert.equal(third.ok, false)
    assert.equal(third.reason, 'already-dispatched')
    // 已展示的派发：立刻拒绝任何重派。
    const shownKey = 'k2'
    assert.equal((await ledger.reserve({ dispatchKey: shownKey, estimate: { inputTokens: 1, maxOutputTokens: 1 } })).ok, true)
    await ledger.markShown(shownKey)
    const afterShown = await ledger.reserve({ dispatchKey: shownKey, estimate: { inputTokens: 1, maxOutputTokens: 1 } })
    assert.equal(afterShown.ok, false)
    assert.equal(afterShown.reason, 'already-dispatched')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('B05: legacy dispatch records without shown are treated as shown', async () => {
  const home = await tempHome()
  try {
    const dir = join(home, 'next-message-predictor')
    const { mkdir } = await import('node:fs/promises')
    await mkdir(dir, { recursive: true })
    const now = 1700000000000
    await writeFile(
      join(dir, 'ledger.json'),
      JSON.stringify({
        schemaVersion: 1,
        dispatches: { old: { at: now, day: '2023-11-14', trigger: 'auto', provider: 'p', model: 'm', configRevision: 1 } },
        budgetDays: {},
        updatedAt: now,
      }),
      'utf8',
    )
    const ledger = createPersistentLedger({ homeDir: home, now: () => now, getTimeZone: () => 'UTC', getLimits: () => limits() })
    await ledger.ensureLoaded()
    assert.equal(ledger.hasDispatch('old'), true)
    assert.equal((await ledger.reserve({ dispatchKey: 'old', estimate: { inputTokens: 1, maxOutputTokens: 1 } })).ok, false)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('daily request and token limits refuse without writing', async () => {
  const home = await tempHome()
  try {
    const ledger = createPersistentLedger({
      homeDir: home,
      getLimits: () => limits({ dailyRequestLimit: 1, dailyTokenBudget: 500 }),
    })
    const first = await ledger.reserve({ dispatchKey: 'k1', estimate: { inputTokens: 100, maxOutputTokens: 100 } })
    assert.equal(first.ok, true)
    const requestLimited = await ledger.reserve({ dispatchKey: 'k2', estimate: { inputTokens: 1, maxOutputTokens: 1 } })
    assert.equal(requestLimited.ok, false)
    assert.equal(requestLimited.reason, 'daily-request-limit')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
  const home2 = await tempHome()
  try {
    const ledger = createPersistentLedger({
      homeDir: home2,
      getLimits: () => limits({ dailyRequestLimit: 100, dailyTokenBudget: 300 }),
    })
    const result = await ledger.reserve({ dispatchKey: 'big', estimate: { inputTokens: 200, maxOutputTokens: 200 } })
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'daily-token-budget')
  } finally {
    await rm(home2, { recursive: true, force: true })
  }
})

test('settle records reported usage and counts unknown usage conservatively', async () => {
  const home = await tempHome()
  try {
    const ledger = createPersistentLedger({ homeDir: home, getLimits: () => limits() })
    await ledger.reserve({ dispatchKey: 'k1', estimate: { inputTokens: 50, maxOutputTokens: 50 } })
    await ledger.settle({ reservedTokens: 100, usage: { inputTokens: 30, outputTokens: 5, reasoningTokens: 2 } })
    let snapshot = ledger.snapshot()
    assert.equal(snapshot.inputTokens, 30)
    assert.equal(snapshot.outputTokens, 5)
    assert.equal(snapshot.reasoningTokens, 2)
    assert.equal(snapshot.reservedTokens, 0)
    await ledger.reserve({ dispatchKey: 'k2', estimate: { inputTokens: 50, maxOutputTokens: 50 } })
    await ledger.settle({ reservedTokens: 100, usage: undefined, markUnknown: true })
    snapshot = ledger.snapshot()
    assert.equal(snapshot.unknownUsage, 1)
    assert.equal(snapshot.reservedTokens, 100)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('settlement after midnight applies usage and reservations to the dispatch day', async () => {
  const home = await tempHome()
  try {
    // 05:59:59Z is one second before midnight in America/Chicago (UTC-6 in November).
    let instant = Date.parse('2026-11-10T05:59:59Z')
    const ledger = createPersistentLedger({ homeDir: home, now: () => instant, getTimeZone: () => 'America/Chicago' })
    const previous = await ledger.reserve({ dispatchKey: 'before-midnight', estimate: { inputTokens: 50, maxOutputTokens: 50 } })
    instant += 2000
    const next = await ledger.reserve({ dispatchKey: 'after-midnight', estimate: { inputTokens: 50, maxOutputTokens: 50 } })
    await ledger.settle({ ...previous, usage: { inputTokens: 30, outputTokens: 5 } })
    assert.equal(ledger.snapshot().reservedTokens, 100)
    assert.equal(ledger.snapshot().inputTokens, 0)
    const { budgetDays } = JSON.parse(await readFile(ledger.filePath, 'utf8'))
    assert.equal(budgetDays[previous.day].reservedTokens, 0)
    assert.equal(budgetDays[previous.day].inputTokens, 30)
    await ledger.settle({ ...next, dispatchKey: 'after-midnight', notDispatched: true })
    assert.equal(ledger.snapshot().requests, 0)
    assert.equal(ledger.snapshot().reservedTokens, 0)
    assert.equal(ledger.hasDispatch('after-midnight'), false)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('stale dispatches and old budget days are pruned on load', async () => {
  const home = await tempHome()
  try {
    const ledger = createPersistentLedger({ homeDir: home, getLimits: () => limits() })
    await ledger.ensureLoaded()
    const { mkdir } = await import('node:fs/promises')
    await mkdir(join(home, 'next-message-predictor'), { recursive: true })
    const oldAt = Date.now() - 48 * 60 * 60 * 1000
    const oldDay = dayKey(Date.now() - 10 * 24 * 60 * 60 * 1000, 'UTC')
    await writeFile(
      ledger.filePath,
      JSON.stringify({
        schemaVersion: 1,
        dispatches: {
          old: { at: oldAt },
          fresh: { at: Date.now() },
        },
        budgetDays: {
          [oldDay]: { requests: 5, inputTokens: 1, outputTokens: 1, reasoningTokens: 0, unknownUsage: 0, reservedTokens: 0 },
        },
      }),
      'utf8',
    )
    const reloaded = createPersistentLedger({ homeDir: home, getLimits: () => limits() })
    await reloaded.ensureLoaded()
    assert.equal(reloaded.hasDispatch('old'), false)
    assert.equal(reloaded.hasDispatch('fresh'), true)
    assert.equal(reloaded.snapshot().requests, 0)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('dayKey follows the configured IANA time zone', () => {
  const instant = Date.parse('2026-11-10T02:00:00Z')
  assert.equal(dayKey(instant, 'UTC'), '2026-11-10')
  assert.equal(dayKey(instant, 'America/Chicago'), '2026-11-09')
  assert.equal(dayKey(instant, 'Not/AZone'), '2026-11-10')
})
