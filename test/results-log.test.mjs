// O01 持久化结果记录测试（临时目录，无 DSH 运行时）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createResultsLog, hashId, matchScore } from '../src/host/results-log.js'

async function tempHome() {
  return mkdtemp(join(tmpdir(), 'nmp-results-'))
}

function offerInput(overrides) {
  return {
    requestId: 'req-1',
    suggestionId: 'sug-1',
    sessionId: 'session-secret-1',
    turnKey: 'session-secret-1\u0000v1\u0000t1a17',
    trigger: 'auto',
    outcome: 'offer',
    reason: '',
    text: '继续第二项',
    route: { provider: 'deepseek-official', model: 'deepseek-flash' },
    latencyMs: 1500,
    usage: { inputTokens: 500, outputTokens: 12, reasoningTokens: 0 },
    suggestionGraphemes: 5,
    ...(overrides ?? {}),
  }
}

test('matchScore computes exact, prefix and edit ratio', () => {
  assert.equal(matchScore('继续第二项', '继续第二项').exact, true)
  const prefix = matchScore('继续第二项', '继续第二')
  assert.equal(prefix.exact, false)
  assert.equal(prefix.prefixChars, 4)
  assert.ok(prefix.editRatio < 1)
  assert.equal(matchScore('', 'x').exact, false)
})

test('request + shown + accepted + match writes privacy-safe lines and summary', async () => {
  const home = await tempHome()
  try {
    let clock = 1_800_000_000_000
    const log = createResultsLog({ homeDir: home, now: () => clock, getTimeZone: () => 'UTC' })
    await log.recordRequest(offerInput())
    await log.markShown('sug-1')
    await log.recordOutcome('sug-1', 'accepted')
    clock += 10_000
    const match = log.noteUserMessage('session-secret-1', '继续第二项')
    assert.equal(match.matched, true)
    assert.equal(match.exact, true)
    await log.flush()
    const summary = await log.summary(7)
    assert.equal(summary.requests, 1)
    assert.equal(summary.offers, 1)
    assert.equal(summary.shown, 1)
    assert.equal(summary.accepted, 1)
    assert.equal(summary.showRate, 100)
    assert.equal(summary.acceptRate, 100)
    assert.equal(summary.acceptedUnalteredRate, 100)
    assert.equal(summary.latencyP50, 1500)
    assert.equal(summary.tokenDays.length, 1)
    assert.equal(summary.tokenDays[0].input, 500)
    // 落盘行不得包含建议正文、会话 id、request/suggestion id 原文
    const dir = join(home, 'next-message-predictor')
    const names = await readdir(dir)
    assert.ok(names.includes('events.jsonl'))
    const text = await readFile(join(dir, 'events.jsonl'), 'utf8')
    assert.ok(!text.includes('继续第二项'))
    assert.ok(!text.includes('session-secret-1'))
    assert.ok(!text.includes('sug-1'))
    assert.ok(!text.includes('req-1'))
    assert.ok(text.includes(hashId('sug-1')))
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('abstain reasons and latency percentiles are summarised', async () => {
  const home = await tempHome()
  try {
    const log = createResultsLog({ homeDir: home, now: () => 1_800_000_000_000, getTimeZone: () => 'UTC' })
    for (let i = 0; i < 10; i += 1) {
      await log.recordRequest(offerInput({ requestId: `r-${i}`, suggestionId: '', outcome: 'abstain', reason: 'model-abstained', latencyMs: 100 + i * 10, text: undefined }))
    }
    await log.flush()
    const summary = await log.summary(7)
    assert.equal(summary.requests, 10)
    assert.equal(summary.abstains, 10)
    assert.equal(summary.abstainReasons[0].reason, 'model-abstained')
    assert.equal(summary.abstainReasons[0].count, 10)
    assert.equal(summary.latencyP50, 140)
    assert.equal(summary.latencyP95, 190)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('rotation creates an archived events file and keeps writing', async () => {
  const home = await tempHome()
  try {
    const log = createResultsLog({ homeDir: home, now: () => 1_800_000_000_000, getTimeZone: () => 'UTC', maxBytes: 600 })
    for (let i = 0; i < 5; i += 1) {
      await log.recordRequest(offerInput({ requestId: `r-${i}`, suggestionId: `s-${i}`, text: `x${i}` }))
    }
    await log.flush()
    const names = await readdir(join(home, 'next-message-predictor'))
    const archived = names.filter((name) => /^events\..+\.jsonl$/u.test(name))
    assert.ok(archived.length >= 1, `expected archived rotation file, got ${names.join(',')}`)
    assert.ok(names.includes('events.jsonl'))
    const summary = await log.summary(7)
    assert.equal(summary.requests, 5)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('old archived files are pruned by mtime', async () => {
  const home = await tempHome()
  try {
    const dir = join(home, 'next-message-predictor')
    await writeFile(join(dir, 'events.2000-01-01T00-00-00-000Z.jsonl'), '{}\n', 'utf8').catch(async () => {
      const { mkdir } = await import('node:fs/promises')
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, 'events.2000-01-01T00-00-00-000Z.jsonl'), '{}\n', 'utf8')
    })
    const old = new Date('2000-01-01T00:00:00Z')
    await utimes(join(dir, 'events.2000-01-01T00-00-00-000Z.jsonl'), old, old)
    const log = createResultsLog({ homeDir: home, now: () => 1_800_000_000_000, getTimeZone: () => 'UTC' })
    await log.recordRequest(offerInput())
    await log.flush()
    // cleanup 为异步触发，给事件循环一个机会
    await new Promise((resolve) => setTimeout(resolve, 50))
    const names = await readdir(dir)
    assert.ok(!names.includes('events.2000-01-01T00-00-00-000Z.jsonl'))
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('messages from another session or unseen offers do not match', async () => {
  const home = await tempHome()
  try {
    const log = createResultsLog({ homeDir: home, now: () => 1_800_000_000_000, getTimeZone: () => 'UTC' })
    await log.recordRequest(offerInput())
    // 未 shown 的建议不参与匹配
    assert.equal(log.noteUserMessage('session-secret-1', '继续第二项').matched, false)
    await log.markShown('sug-1')
    assert.equal(log.noteUserMessage('other-session', '继续第二项').matched, false)
    assert.equal(log.noteUserMessage('session-secret-1', '继续第二项').matched, true)
    // 已匹配的建议不会被第二条消息再次匹配
    assert.equal(log.noteUserMessage('session-secret-1', '继续第二项').matched, false)
    await log.flush()
    const summary = await log.summary(7)
    assert.equal(summary.acceptedUnalteredRate, null)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})
