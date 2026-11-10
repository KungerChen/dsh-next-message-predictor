#!/usr/bin/env node
/**
 * “换一条”评测（本机真实会话，真实模型；报告只写计数和长度，不写对话或建议正文）。
 *
 * 每个样本依次调用：
 *   A  自动预测的输入（不带手动说明）
 *   M  第一次手动（带 buildManualSuffix([])）
 *   R1 换一条（带 buildManualSuffix([第一条])）
 *   R2 再换一条（带 buildManualSuffix([第一条, 第二条])）
 * 另外用 --old-suffix 可以对照旧说明（“想不出就返回 null”）下 R1 的弃权率。
 *
 * 用法：node eval/regen-eval.mjs --url "<scratch URL>" [--limit 15] [--old-suffix]
 */
import { browserPath, loadChromium } from '../tools/lib/local-env.mjs'
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'

import { extractHumanAndAssistant, redactSecrets, textOfContent, trimMessages } from '../src/host/context-builder.js'
import { buildManualSuffix, buildPredictionInput, buildSystemPrompt, PROMPT_VERSION } from '../src/shared/prompt.js'
import { parsePredictionJson } from '../src/shared/output-validation.js'
import { DEFAULT_CONFIG } from '../src/shared/config.js'

const chromium = loadChromium()

const here = path.dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const argOf = (name, fallback) => { const i = args.indexOf(name); return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback }
const url = argOf('--url', '')
if (url === '') throw new Error('--url is required')
const limit = Math.max(1, Number(argOf('--limit', '15')) || 15)
const sessionsRoot = argOf('--sessions-root', path.join(homedir(), '.dsh', 'sessions'))
const oldSuffix = args.includes('--old-suffix')
const OLD = (earlier) => ['', '', '用户看过下面这些建议后要求换一条。不要重复它们，也不要只改几个字；换一个不同但同样合理的下一句。想不出就返回 null。', ...earlier.map((t) => `- ${t}`)].join('\n')

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

/** 每个真实会话取最后一个已完成回合的上下文（与生产同款裁剪和脱敏）。 */
function collect() {
  const files = []
  const walk = (dir, depth) => {
    if (depth > 3) return
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full, depth + 1)
      else if (entry.name === 'session.v4.jsonl.zstd') files.push(full)
    }
  }
  walk(sessionsRoot, 0)
  files.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
  const samples = []
  for (const file of files) {
    if (samples.length >= limit) break
    if (Date.now() - statSync(file).mtimeMs > 14 * 86400e3) continue
    let lines
    try { lines = decode(readFileSync(file)).split('\n').filter(Boolean) } catch { continue }
    let header
    try { header = JSON.parse(lines[0]) } catch { continue }
    if (header?.type !== 'session' || Number(header.delegationDepth) > 0) continue
    if (/AppData[\\/]Local[\\/]Temp/i.test(String(header.cwd ?? ''))) continue
    const events = []
    for (const line of lines) { try { const value = JSON.parse(line); if (typeof value?.type === 'string') events.push(value) } catch { /* skip */ } }
    if (events.some((e) => e.type === 'assistant/message' && /^(mock|fixed-test)$/i.test(String(e.data?.message?.source?.provider ?? '')))) continue
    const end = events.findLast((e) => e.type === 'turn/end' && e.data?.reason?.kind === 'completed')
    if (end === undefined) continue
    const raw = extractHumanAndAssistant(events.filter((e) => typeof e.seq !== 'number' || e.seq <= end.seq))
    if (raw.length === 0 || raw.at(-1).role !== 'assistant' || !raw.some((m) => m.role === 'user')) continue
    if (raw.filter((m) => m.role === 'user').some((m) => Array.from(m.text).length > 1000)) continue
    const trimmed = trimMessages(raw.map((m) => ({ role: m.role, text: redactSecrets(m.text).text })), {
      maxMessages: DEFAULT_CONFIG.contextMessages,
      maxCodePoints: DEFAULT_CONFIG.maxContextCodePoints,
      targetInputTokens: DEFAULT_CONFIG.targetInputTokens,
      systemReserveTokens: 600,
    })
    if (trimmed.messages.length === 0 || trimmed.messages.at(-1).role !== 'assistant') continue
    samples.push({ input: buildPredictionInput(trimmed.messages) })
  }
  void textOfContent
  return samples
}

const browser = await chromium.launch({ executablePath: browserPath(), headless: true })
const page = await browser.newPage()
page.setDefaultTimeout(60000)
try {
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => Boolean(document.querySelector('[data-composer-input]')), undefined, { timeout: 30000 })
  const system = buildSystemPrompt()
  const call = async (input) => {
    const json = await page.evaluate(async (body) => (await fetch('/api/nmp-eval/rpc', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json(), {
      operation: 'run', provider: 'deepseek-official', model: 'deepseek-flash', system, input, maxTokens: DEFAULT_CONFIG.maxOutputTokens, reasoningEffort: 'off',
    })
    if (json?.ok !== true) return { error: true }
    const parsed = parsePredictionJson(json.value.text, { maxGraphemes: DEFAULT_CONFIG.maxSuggestionGraphemes })
    return { suggestion: parsed.ok === true ? parsed.suggestion : null, invalid: parsed.ok !== true, elapsedMs: json.value.elapsedMs }
  }
  const samples = collect()
  const suffix = oldSuffix ? OLD : buildManualSuffix
  const rows = []
  for (const sample of samples) {
    const auto = await call(sample.input)
    const manual = await call(`${sample.input}${buildManualSuffix([])}`)
    const first = manual.suggestion ?? auto.suggestion
    let r1 = { skipped: true }
    let r2 = { skipped: true }
    if (typeof first === 'string') {
      r1 = await call(`${sample.input}${suffix([first])}`)
      if (typeof r1.suggestion === 'string') r2 = await call(`${sample.input}${suffix([first, r1.suggestion])}`)
    }
    const len = (value) => (typeof value === 'string' ? Array.from(value).length : null)
    rows.push({
      auto: len(auto.suggestion), manual: len(manual.suggestion), r1: len(r1.suggestion), r2: len(r2.suggestion),
      r1Skipped: r1.skipped === true, r2Skipped: r2.skipped === true,
      r1Distinct: typeof r1.suggestion === 'string' && r1.suggestion !== first,
      r2Distinct: typeof r2.suggestion === 'string' && r2.suggestion !== first && r2.suggestion !== r1.suggestion,
      invalid: [auto, manual, r1, r2].filter((x) => x.invalid === true).length,
    })
    console.log(`evaluated ${rows.length}/${samples.length}`)
  }
  const count = (f) => rows.filter(f).length
  const asked1 = count((r) => !r.r1Skipped)
  const asked2 = count((r) => !r.r2Skipped)
  const report = {
    runner: 'eval/regen-eval.mjs', generatedAt: new Date().toISOString(), promptVersion: PROMPT_VERSION, suffix: oldSuffix ? 'old' : 'current',
    samples: rows.length,
    autoOffered: count((r) => r.auto !== null),
    manualOffered: count((r) => r.manual !== null),
    anotherAsked: asked1, anotherOffered: count((r) => r.r1 !== null), anotherDistinct: count((r) => r.r1Distinct),
    thirdAsked: asked2, thirdOffered: count((r) => r.r2 !== null), thirdDistinct: count((r) => r.r2Distinct),
    invalidOutputs: rows.reduce((t, r) => t + r.invalid, 0),
    rows,
  }
  writeFileSync(path.join(here, `regen-${oldSuffix ? 'old' : 'current'}.json`), JSON.stringify(report, null, 2), 'utf8')
  console.log(JSON.stringify({ ...report, rows: undefined }, null, 2))
} finally {
  await browser.close().catch(() => {})
}
