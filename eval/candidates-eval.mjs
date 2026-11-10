#!/usr/bin/env node
/**
 * 多条候选与常用句评测（本机真实会话；报告只写计数、长度和分数，不写正文）。
 *
 * A. 多条候选（真实模型）：同一批样本，单条提示词 vs 多条提示词。比较
 *    给出建议的比例、输出是否合法、候选条数、第一条与单条结果是否相同、
 *    以及“用户真实下一条”和任一候选的最接近程度。
 * B. 常用句（不调用模型）：每个“已完成回合 + 用户真实下一条”样本上，
 *    findHabitPhrases 有没有给出短句、给出的和真实下一条是否一致。
 *
 * 用法：node eval/candidates-eval.mjs --url "<scratch URL>" [--limit 40] [--sessions-root <dir>] [--habits-only]
 */
import { browserPath, loadChromium } from '../tools/lib/local-env.mjs'
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'

import { extractHumanAndAssistant, findHabitPhrases, redactSecrets, textOfContent, trimMessages } from '../src/host/context-builder.js'
import { buildPredictionInput, buildSystemPrompt } from '../src/shared/prompt.js'
import { parseCandidatesJson } from '../src/shared/output-validation.js'
import { matchScore } from '../src/host/results-log.js'
import { DEFAULT_CONFIG } from '../src/shared/config.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const argOf = (name, fallback) => { const i = args.indexOf(name); return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback }
const url = argOf('--url', '')
const habitsOnly = args.includes('--habits-only')
if (url === '' && !habitsOnly) throw new Error('--url is required (or pass --habits-only)')
const limit = Math.max(1, Number(argOf('--limit', '40')) || 40)
const roots = argOf('--sessions-root', '') !== '' ? [argOf('--sessions-root', '')] : [path.join(homedir(), '.dsh', 'sessions'), ...(process.env.DSH_HOME ? [path.join(process.env.DSH_HOME, 'sessions')] : [])]

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
function decode(buffer) {
  const offsets = []
  for (let i = buffer.indexOf(MAGIC); i !== -1; i = buffer.indexOf(MAGIC, i + 1)) offsets.push(i)
  const parts = []
  for (let k = 0; k < offsets.length; k += 1) {
    try { parts.push(zstdDecompressSync(buffer.subarray(offsets[k], k + 1 < offsets.length ? offsets[k + 1] : buffer.length))) } catch { /* false magic hit */ }
  }
  return Buffer.concat(parts).toString('utf8')
}

/** 样本：一个已完成回合、之前的用户消息原文、以及用户真实发出的下一条。 */
function collect() {
  const samples = []
  const seenSessions = new Set()
  for (const root of roots) {
    const files = []
    const walk = (dir, depth) => {
      if (depth > 3) return
      let entries
      try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
      for (const entry of entries) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) walk(full, depth + 1)
        else if (entry.name === 'session.v4.jsonl.zstd') files.push(full)
      }
    }
    walk(root, 0)
    for (const file of files) {
      if (Date.now() - statSync(file).mtimeMs > 14 * 86400e3 || statSync(file).size > 2e7) continue
      let lines
      try { lines = decode(readFileSync(file)).split('\n').filter(Boolean) } catch { continue }
      let header
      try { header = JSON.parse(lines[0]) } catch { continue }
      if (header?.type !== 'session' || Number(header.delegationDepth) > 0 || seenSessions.has(header.id)) continue
      if (/AppData[\\/]Local[\\/]Temp/i.test(String(header.cwd ?? ''))) continue
      const events = []
      for (const line of lines) { try { const value = JSON.parse(line); if (typeof value?.type === 'string') events.push(value) } catch { /* skip */ } }
      if (events.some((e) => e.type === 'assistant/message' && /^(mock|fixed-test)$/i.test(String(e.data?.message?.source?.provider ?? '')))) continue
      seenSessions.add(header.id)
      const isUser = (e) => e.type === 'user/message' && e.data?.source?.kind === 'user' && textOfContent(e.data.content).trim() !== ''
      for (const end of events.filter((e) => e.type === 'turn/end' && e.data?.reason?.kind === 'completed')) {
        const next = events.find((e) => e.seq > end.seq && isUser(e))
        if (next === undefined) continue
        const expected = textOfContent(next.data.content).trim()
        if (Array.from(expected).length < 2 || Array.from(expected).length > 300) continue
        const before = events.filter((e) => typeof e.seq !== 'number' || e.seq <= end.seq)
        const raw = extractHumanAndAssistant(before)
        if (raw.length === 0 || raw.at(-1).role !== 'assistant' || !raw.some((m) => m.role === 'user')) continue
        if (raw.filter((m) => m.role === 'user').some((m) => Array.from(m.text).length > 1000)) continue
        const trimmed = trimMessages(raw.map((m) => ({ role: m.role, text: redactSecrets(m.text).text })), {
          maxMessages: DEFAULT_CONFIG.contextMessages, maxCodePoints: DEFAULT_CONFIG.maxContextCodePoints,
          targetInputTokens: DEFAULT_CONFIG.targetInputTokens, systemReserveTokens: 600,
        })
        if (trimmed.messages.length === 0 || trimmed.messages.at(-1).role !== 'assistant') continue
        samples.push({ input: buildPredictionInput(trimmed.messages), expected, userTexts: before.filter(isUser).map((e) => textOfContent(e.data.content)) })
      }
    }
  }
  return samples
}

const samples = collect()
// B. 常用句：全部样本，不调用模型。
const habitRows = samples.map((sample) => {
  const phrases = findHabitPhrases(sample.userTexts)
  const scores = phrases.map((phrase) => matchScore(phrase, sample.expected))
  return { offered: phrases.length > 0, count: phrases.length, firstExact: scores[0]?.exact === true, anyExact: scores.some((s) => s.exact), bestEdit: scores.reduce((best, s) => Math.max(best, s.editRatio), 0) }
})
const habit = {
  samples: habitRows.length,
  offered: habitRows.filter((r) => r.offered).length,
  firstExact: habitRows.filter((r) => r.firstExact).length,
  anyExact: habitRows.filter((r) => r.anyExact).length,
  bestEditAtLeastHalf: habitRows.filter((r) => r.offered && r.bestEdit >= 0.5).length,
}
let report = { runner: 'eval/candidates-eval.mjs', generatedAt: new Date().toISOString(), habit }

if (!habitsOnly) {
  const browser = await loadChromium().launch({ executablePath: browserPath(), headless: true })
  const page = await browser.newPage()
  page.setDefaultTimeout(60000)
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(() => Boolean(document.querySelector('[data-composer-input]')), undefined, { timeout: 30000 })
    const call = async (system, input, maxTokens, maxCandidates) => {
      const json = await page.evaluate(async (body) => (await fetch('/api/nmp-eval/rpc', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json(), {
        operation: 'run', provider: 'deepseek-official', model: 'deepseek-flash', system, input, maxTokens, reasoningEffort: 'off',
      })
      if (json?.ok !== true) return { error: true, suggestions: [] }
      const parsed = parseCandidatesJson(json.value.text, { maxGraphemes: DEFAULT_CONFIG.maxSuggestionGraphemes, maxCandidates })
      return { suggestions: parsed.ok === true ? parsed.suggestions : [], invalid: parsed.ok !== true, elapsedMs: json.value.elapsedMs, out: json.value.usage?.outputTokens ?? 0, finish: json.value.finish }
    }
    // Spread the model sample across sessions: take every k-th sample.
    const step = Math.max(1, Math.floor(samples.length / limit))
    const picked = samples.filter((_, index) => index % step === 0).slice(0, limit)
    const rows = []
    for (const sample of picked) {
      const single = await call(buildSystemPrompt(), sample.input, DEFAULT_CONFIG.maxOutputTokens, 1)
      const multi = await call(buildSystemPrompt({ candidates: 3 }), sample.input, 200, 3)
      const best = (list) => list.map((text) => matchScore(text, sample.expected)).reduce((acc, s) => ({ exact: acc.exact || s.exact, edit: Math.max(acc.edit, s.editRatio) }), { exact: false, edit: 0 })
      rows.push({
        single: single.suggestions.length, multi: multi.suggestions.length, singleInvalid: single.invalid === true, multiInvalid: multi.invalid === true,
        sameFirst: single.suggestions.length > 0 && multi.suggestions[0] === single.suggestions[0],
        singleBest: best(single.suggestions), multiBest: best(multi.suggestions), multiFirst: best(multi.suggestions.slice(0, 1)),
        singleMs: single.elapsedMs, multiMs: multi.elapsedMs, singleOut: single.out, multiOut: multi.out, multiFinish: multi.finish,
      })
      console.log(`evaluated ${rows.length}/${picked.length}`)
    }
    const count = (f) => rows.filter(f).length
    const median = (list) => { const s = list.filter((v) => typeof v === 'number').sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null }
    report.candidates = {
      samples: rows.length,
      single: { offered: count((r) => r.single > 0), invalid: count((r) => r.singleInvalid), exact: count((r) => r.singleBest.exact), editAtLeastHalf: count((r) => r.singleBest.edit >= 0.5), medianMs: median(rows.map((r) => r.singleMs)), medianOutputTokens: median(rows.map((r) => r.singleOut)) },
      multi: {
        offered: count((r) => r.multi > 0), invalid: count((r) => r.multiInvalid), cutOff: count((r) => r.multiFinish !== 'stop' && r.multiFinish !== undefined && r.multiFinish !== null && typeof r.multiFinish === 'string' && r.multiFinish !== 'stop'),
        one: count((r) => r.multi === 1), two: count((r) => r.multi === 2), three: count((r) => r.multi === 3),
        firstExact: count((r) => r.multiFirst.exact), anyExact: count((r) => r.multiBest.exact), anyEditAtLeastHalf: count((r) => r.multiBest.edit >= 0.5),
        sameFirstAsSingle: count((r) => r.sameFirst), medianMs: median(rows.map((r) => r.multiMs)), medianOutputTokens: median(rows.map((r) => r.multiOut)),
      },
    }
  } finally {
    await browser.close().catch(() => {})
  }
}
writeFileSync(path.join(here, 'candidates-eval.json'), JSON.stringify(report, null, 2), 'utf8')
console.log(JSON.stringify(report, null, 2))
