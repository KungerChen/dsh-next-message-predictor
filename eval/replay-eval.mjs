#!/usr/bin/env node
/**
 * O05 真实会话回放评测（离线、本机；报告只写分数与哈希，不写对话正文）。
 *
 * 样本定义：一个“已完成回合”的上下文 + 用户真实发出的下一条消息（作为标准答案）。
 * 上下文使用与生产一致的 B02 裁剪/脱敏；通过 scratch profile 的评测 Host 调用
 * 真实模型（provider/model 可指定），计算：
 *   触发率、完全匹配率、前缀字符数/覆盖率、编辑距离比率、潜在节省输入量、
 *   O03 语义过滤命中数、延迟与 token。
 *
 * 用法：
 *   node eval/replay-eval.mjs --url "<scratch URL>" --tag v2-baseline \
 *     --provider deepseek-official --model deepseek-flash --max-tokens 256 \
 *     --limit 100 --days 7
 */
import { browserPath, loadChromium } from '../tools/lib/local-env.mjs'
import { readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { zstdDecompressSync } from 'node:zlib'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'

import {
  createSessionContextReader,
  extractHumanAndAssistant,
  redactSecrets,
  textOfContent,
  trimMessages,
} from '../src/host/context-builder.js'
import * as currentPrompt from '../src/shared/prompt.js'
import { parsePredictionJson } from '../src/shared/output-validation.js'
import { matchScore } from '../src/host/results-log.js'
import { DEFAULT_CONFIG } from '../src/shared/config.js'

const chromium = loadChromium()

const here = path.dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const argOf = (name, fallback) => {
  const i = args.indexOf(name)
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback
}
// --prompt-module <path>：用另一份 prompt.js（例如备份里的旧版本）做对照。
const promptModulePath = argOf('--prompt-module', '')
const promptModule = promptModulePath === '' ? currentPrompt : await import(pathToFileURL(path.resolve(promptModulePath)).href)
const { buildPredictionInput, buildSystemPrompt, PROMPT_VERSION } = promptModule
const url = argOf('--url', '')
// --dry-run 只统计样本来源，不启动浏览器、不调用模型。
const dryRun = args.includes('--dry-run')
if (url === '' && !dryRun) throw new Error('--url is required (or pass --dry-run)')
// 同一句“标准答案”最多取几条，避免脚本化或口头禅式的重复句主导分数。
const maxPerAnswer = Math.max(1, Number(argOf('--max-per-answer', '2')) || 2)
const tag = argOf('--tag', 'replay')
const provider = argOf('--provider', 'deepseek-official')
const model = argOf('--model', 'deepseek-flash')
const maxTokens = Number(argOf('--max-tokens', '256')) || 256
const reasoningEffort = argOf('--effort', 'off')
const limit = Math.max(1, Number(argOf('--limit', '100')) || 100)
const days = Math.max(1, Number(argOf('--days', '14')) || 14)
const maxSessions = Math.max(1, Number(argOf('--max-sessions', '300')) || 300)
const sessionsRoot = argOf('--sessions-root', path.join(homedir(), '.dsh', 'sessions'))
const outDir = path.join(here)

const sha = (value) => createHash('sha256').update(String(value)).digest('hex').slice(0, 12)
const graphemes = (value) => Array.from(String(value ?? '')).length

function decompressSessionFile(buffer) {
  const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
  const offsets = []
  let index = buffer.indexOf(magic, 0)
  while (index !== -1) {
    offsets.push(index)
    index = buffer.indexOf(magic, index + 1)
  }
  if (offsets.length === 0) return null
  const parts = []
  for (let i = 0; i < offsets.length; i += 1) {
    const start = offsets[i]
    const end = i + 1 < offsets.length ? offsets[i + 1] : buffer.length
    try {
      parts.push(zstdDecompressSync(buffer.subarray(start, end)).toString('utf8'))
    } catch {
      let recovered = false
      for (const trim of [8, 16, 32, 64]) {
        if (end - start <= trim) continue
        try {
          parts.push(zstdDecompressSync(buffer.subarray(start, end - trim)).toString('utf8'))
          recovered = true
          break
        } catch {
          /* keep trying */
        }
      }
      if (!recovered) return null
    }
  }
  return parts.join('')
}

function parseEvents(text) {
  const events = []
  for (const line of text.split('\n')) {
    if (line === '') continue
    try {
      const value = JSON.parse(line)
      if (value !== null && typeof value === 'object' && typeof value.type === 'string') events.push(value)
    } catch {
      /* skip */
    }
  }
  return events
}

function contextAt(events, endSeq) {
  const slice = []
  for (const event of events) {
    if (typeof event.seq === 'number' && event.seq > endSeq) break
    slice.push(event)
  }
  return slice
}

function firstUserAfter(events, endSeq) {
  let count = 0
  for (const event of events) {
    if (typeof event.seq === 'number' && event.seq <= endSeq) continue
    count += 1
    if (count > 120) return null
    if (event.type !== 'user/message') continue
    const data = event.data !== null && typeof event.data === 'object' ? event.data : {}
    const source = data.source !== null && typeof data.source === 'object' ? data.source : {}
    if (source.kind !== 'user') continue
    const text = textOfContent(data.content)
    if (text.trim() === '') continue
    return { seq: event.seq, text }
  }
  return null
}

function buildSamples(events, header) {
  const completed = []
  for (const event of events) {
    if (event.type !== 'turn/end') continue
    const reason = event.data !== null && typeof event.data === 'object' && event.data.reason !== null ? event.data.reason : {}
    if (reason.kind !== 'completed') continue
    completed.push(event.seq)
  }
  const samples = []
  for (let i = completed.length - 1; i >= 0 && samples.length < 8; i -= 1) {
    const endSeq = completed[i]
    const slice = contextAt(events, endSeq)
    const rawMessages = extractHumanAndAssistant(slice)
    if (rawMessages.length === 0) continue
    const last = rawMessages[rawMessages.length - 1]
    if (last.role !== 'assistant') continue
    const users = rawMessages.filter((message) => message.role === 'user')
    if (users.length === 0) continue
    if (users.some((message) => graphemes(message.text) > 1000)) continue
    const expected = firstUserAfter(events, endSeq)
    if (expected === null) continue
    if (graphemes(expected.text) < 2 || graphemes(expected.text) > 300) continue
    const redacted = rawMessages.map((message) => {
      const result = redactSecrets(message.text)
      return { role: message.role, text: result.text }
    })
    if (redacted[redacted.length - 1].text.trim() === '') continue
    const trimmed = trimMessages(redacted, {
      maxMessages: DEFAULT_CONFIG.contextMessages,
      maxCodePoints: DEFAULT_CONFIG.maxContextCodePoints,
      targetInputTokens: DEFAULT_CONFIG.targetInputTokens,
      systemReserveTokens: 600,
    })
    if (trimmed.messages.length === 0 || trimmed.messages[trimmed.messages.length - 1].role !== 'assistant') continue
    samples.push({
      id: sha(`${header?.id ?? 'session'}:${endSeq}`),
      sessionCwd: typeof header?.cwd === 'string' ? header.cwd : '',
      endSeq,
      messages: trimmed.messages,
      expected: {
        text: expected.text,
        graphemes: graphemes(expected.text),
      },
      contextEstimatedTokens: trimmed.estimatedTokens,
      contextUserMessages: trimmed.messages.filter((message) => message.role === 'user').length,
    })
  }
  return samples
}

const skipped = { tempDir: 0, testModel: 0, repeatedAnswer: 0 }

function isTestModelEvent(event) {
  if (event.type !== 'assistant/message') return false
  const source = event.data?.message?.source
  const provider = String(source?.provider ?? '')
  const modelName = String(source?.model ?? '')
  return /^(mock|fixed-test)$/iu.test(provider) || /^mock/iu.test(modelName)
}

async function collectSamples() {
  const files = []
  async function walk(dir, depth) {
    if (depth > 3) return
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) await walk(full, depth + 1)
      else if (entry.isFile() && entry.name === 'session.v4.jsonl.zstd') files.push(full)
    }
  }
  await walk(sessionsRoot, 0)
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000
  const recent = []
  for (const file of files) {
    try {
      const info = await stat(file)
      if (info.mtimeMs >= cutoff) recent.push({ file, mtimeMs: info.mtimeMs })
    } catch {
      /* skip */
    }
  }
  recent.sort((a, b) => b.mtimeMs - a.mtimeMs)
  const sessions = []
  for (const entry of recent.slice(0, maxSessions)) {
    let text
    try {
      text = decompressSessionFile(await readFile(entry.file))
    } catch {
      text = null
    }
    if (text === null) continue
    const lines = text.split('\n').filter(Boolean)
    if (lines.length === 0) continue
    let header
    try {
      header = JSON.parse(lines[0])
    } catch {
      continue
    }
    if (header?.type !== 'session') continue
    if (Number(header.delegationDepth) > 0) continue
    const cwd = typeof header.cwd === 'string' ? header.cwd : ''
    if (/AppData[\\/]Local[\\/]Temp/i.test(cwd)) { skipped.tempDir += 1; continue }
    const events = parseEvents(text)
    // 测试会话（mock / fixed-test 模型）的用户消息是脚本句，不是真实样本。
    if (events.some(isTestModelEvent)) { skipped.testModel += 1; continue }
    const samples = buildSamples(events, header)
    const lastModel = events.findLast((event) => event.type === 'assistant/message')?.data?.message?.source
    if (samples.length > 0) sessions.push({ header, samples, model: `${lastModel?.provider ?? '?'}/${lastModel?.model ?? '?'}` })
  }
  return sessions
}

const SEMANTIC_RULES = [
  ['assistant-voice', /^(我来|让我|我可以|我们可以|建议你|建议先|需要我|要我先|要不要我)/u],
  ['praise-or-thanks', /(不错|很好|好主意|谢谢|感谢|辛苦了|厉害|棒)/u],
  ['meta-talk', /(没有建议|暂无建议|无建议|不需要建议|无需建议)/u],
  ['error-text', /(api error|timed out|timeout|error[:：]|错误|失败)/iu],
  ['label-prefix', /^(建议|回答|User|Assistant|Suggestion|Reply)[:：]/iu],
]

function bigramOverlap(a, b) {
  const normalize = (text) => Array.from(String(text).replace(/\s+/gu, ' ').trim().toLowerCase())
  const chars = normalize(a)
  const other = normalize(b)
  if (chars.length < 2 || other.length < 2) return 0
  const otherGrams = new Set()
  for (let i = 0; i < other.length - 1; i += 1) otherGrams.add(other[i] + other[i + 1])
  let hit = 0
  for (let i = 0; i < chars.length - 1; i += 1) if (otherGrams.has(chars[i] + chars[i + 1])) hit += 1
  return hit / Math.max(1, chars.length - 1)
}

function semanticViolation(suggestion, finalAssistant) {
  if (typeof suggestion !== 'string' || suggestion === '') return null
  const text = suggestion.trim()
  for (const [name, pattern] of SEMANTIC_RULES) {
    if (pattern.test(text)) return name
  }
  if (typeof finalAssistant === 'string' && finalAssistant !== '' && bigramOverlap(text, finalAssistant) >= 0.8) return 'duplicate-assistant'
  return null
}

/** round-robin 取样，避免集中在少数会话；同一句标准答案最多 maxPerAnswer 条。 */
function pickSamples(sessions) {
  const picked = []
  const answerCounts = new Map()
  let round = 0
  while (picked.length < limit) {
    let any = false
    for (const session of sessions) {
      const sample = session.samples[round]
      if (sample === undefined) continue
      any = true
      const key = sha(sample.expected.text.trim())
      const seen = answerCounts.get(key) ?? 0
      if (seen >= maxPerAnswer) { skipped.repeatedAnswer += 1; continue }
      answerCounts.set(key, seen + 1)
      picked.push(sample)
      if (picked.length >= limit) break
    }
    if (!any) break
    round += 1
  }
  return { picked, distinctAnswers: answerCounts.size }
}

if (dryRun) {
  const sessions = await collectSamples()
  const { picked, distinctAnswers } = pickSamples(sessions)
  const byCwd = {}
  for (const sample of picked) byCwd[sample.sessionCwd] = (byCwd[sample.sessionCwd] ?? 0) + 1
  const byModel = {}
  for (const session of sessions) byModel[session.model] = (byModel[session.model] ?? 0) + session.samples.length
  console.log(JSON.stringify({ ok: true, dryRun: true, sessions: sessions.length, picked: picked.length, distinctAnswers, skipped, byCwd, byModel }, null, 2))
  process.exit(0)
}

const browser = await chromium.launch({ executablePath: browserPath(), headless: true })
const context = await browser.newContext({ viewport: { width: 1200, height: 800 } })
const page = await context.newPage()
page.setDefaultTimeout(60000)
try {
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => Boolean(globalThis.__DSH_BOOT__) || Boolean(document.querySelector('[data-composer-input]')), undefined, { timeout: 30000 })
  const providers = await page.evaluate(async () => {
    const response = await fetch('/api/nmp-eval/rpc', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ operation: 'providers' }),
    })
    return response.json()
  })
  if (providers?.ok !== true) throw new Error(`eval host unavailable: ${JSON.stringify(providers)}`)

  const sessions = await collectSamples()
  const { picked, distinctAnswers } = pickSamples(sessions)
  if (picked.length === 0) throw new Error('no replay samples found')

  const system = buildSystemPrompt()
  const results = []
  for (let start = 0; start < picked.length; start += 10) {
    const chunk = picked.slice(start, start + 10)
    const batch = chunk.map((sample) => ({
      id: sample.id,
      input: buildPredictionInput(sample.messages),
      expected: sample.expected,
      finalAssistant: sample.messages[sample.messages.length - 1].text,
      system,
      provider,
      model,
      maxTokens,
      reasoningEffort,
    }))
    const responses = await page.evaluate(async (requests) => {
      const out = []
      for (const request of requests) {
        try {
          const response = await fetch('/api/nmp-eval/rpc', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              operation: 'run',
              provider: request.provider,
              model: request.model,
              system: request.system,
              input: request.input,
              maxTokens: request.maxTokens,
              reasoningEffort: request.reasoningEffort,
            }),
          })
          out.push({ id: request.id, json: await response.json() })
        } catch (error) {
          out.push({ id: request.id, error: String(error) })
        }
        await new Promise((resolve) => setTimeout(resolve, 120))
      }
      return out
    }, batch)
    for (const sample of chunk) {
      const response = responses.find((entry) => entry.id === sample.id)
      const value = response?.json?.ok === true ? response.json.value : null
      const error = response?.error ?? (response?.json?.ok === false ? response.json.error : undefined)
      const parsed = value === null ? { ok: false, reason: 'no-response' } : parsePredictionJson(value.text, { maxGraphemes: 200 })
      const suggestion = parsed.ok === true && typeof parsed.suggestion === 'string' ? parsed.suggestion : null
      const offered = suggestion !== null
      const score = offered ? matchScore(suggestion, sample.expected.text) : null
      const violation = offered ? semanticViolation(suggestion, sample.finalAssistant) : null
      results.push({
        id: sample.id,
        offered,
        abstained: parsed.ok === true && parsed.suggestion === null,
        invalid: parsed.ok !== true,
        errorCode: value === null ? (response?.json?.error?.code ?? response?.error ?? 'no-response') : null,
        exact: score?.exact === true,
        prefixChars: score?.prefixChars ?? 0,
        prefixRatio: score === null ? 0 : score.prefixChars / Math.max(1, sample.expected.graphemes),
        editRatio: score?.editRatio ?? null,
        expectedGraphemes: sample.expected.graphemes,
        suggestionGraphemes: suggestion === null ? 0 : Array.from(suggestion).length,
        violation,
        finish: value === null ? null : value.finish,
        usage: value === null ? null : value.usage,
        elapsedMs: value === null ? response?.json?.elapsedMs ?? null : value.elapsedMs,
        contextEstimatedTokens: sample.contextEstimatedTokens,
      })
      void error
    }
    console.log(`evaluated ${Math.min(start + 10, picked.length)}/${picked.length}`)
  }

  const offered = results.filter((row) => row.offered)
  const sum = (rows, key) => rows.reduce((total, row) => total + (Number(row[key]) || 0), 0)
  const avg = (rows, key) => (rows.length === 0 ? null : Math.round((sum(rows, key) / rows.length) * 1000) / 1000)
  const sorted = results.map((row) => row.elapsedMs).filter((value) => typeof value === 'number').sort((a, b) => a - b)
  const percentile = (p) => (sorted.length === 0 ? null : sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))])
  const report = {
    runner: 'eval/replay-eval.mjs',
    generatedAt: new Date().toISOString(),
    tag,
    promptVersion: PROMPT_VERSION,
    provider,
    model,
    maxTokens,
    reasoningEffort,
    samples: {
      sessions: sessions.length,
      picked: picked.length,
      distinctAnswers,
      skipped,
      avgContextTokens: Math.round(picked.reduce((total, sample) => total + sample.contextEstimatedTokens, 0) / Math.max(1, picked.length)),
    },
    metrics: {
      offerRatePct: Math.round((offered.length / Math.max(1, results.length)) * 1000) / 10,
      abstainRatePct: Math.round((results.filter((row) => row.abstained).length / Math.max(1, results.length)) * 1000) / 10,
      invalidRatePct: Math.round((results.filter((row) => row.invalid).length / Math.max(1, results.length)) * 1000) / 10,
      errorCodes: results.filter((row) => row.invalid).reduce((acc, row) => {
        const key = String(row.errorCode ?? 'unknown').slice(0, 60)
        acc[key] = (acc[key] ?? 0) + 1
        return acc
      }, {}),
      // 两个分母都给：比较不同提示词版本时用 OfAll（全部样本），
      // OfOffered 只说明“给出的建议里有多少是对的”。
      exactMatchCount: offered.filter((row) => row.exact).length,
      exactMatchOfAllPct: Math.round((offered.filter((row) => row.exact).length / Math.max(1, results.length)) * 1000) / 10,
      prefixRatioOfAllPct: Math.round((sum(offered, 'prefixRatio') / Math.max(1, results.length)) * 1000) / 10,
      exactMatchPct: Math.round((offered.filter((row) => row.exact).length / Math.max(1, offered.length)) * 1000) / 10,
      avgPrefixChars: avg(offered, 'prefixChars'),
      avgPrefixRatioPct: Math.round(avg(offered, 'prefixRatio') * 1000) / 10,
      avgEditRatio: avg(offered, 'editRatio'),
      potentialSavingPct: Math.round(avg(offered, 'prefixRatio') * 1000) / 10,
      violationCount: offered.filter((row) => row.violation !== null).length,
      violationRatePct: Math.round((offered.filter((row) => row.violation !== null).length / Math.max(1, offered.length)) * 1000) / 10,
      latencyP50: percentile(50),
      latencyP95: percentile(95),
      avgInputTokens: avg(results.map((row) => row.usage).filter((value) => value !== null), 'inputTokens'),
      // 含缓存读取的输入总量；不同次运行缓存命中不同，比较成本要看这一项。
      avgInputTokensInclCache: avg(
        results.map((row) => row.usage).filter((value) => value !== null).map((usage) => ({
          total: (Number(usage.inputTokens) || 0) + (Number(usage.cacheReadTokens) || 0) + (Number(usage.cacheWriteTokens) || 0),
        })),
        'total',
      ),
      avgOutputTokens: avg(results.map((row) => row.usage).filter((value) => value !== null), 'outputTokens'),
      totalInputTokens: sum(results.map((row) => row.usage).filter((value) => value !== null), 'inputTokens'),
      totalOutputTokens: sum(results.map((row) => row.usage).filter((value) => value !== null), 'outputTokens'),
    },
    results,
  }
  const reportPath = path.join(outDir, `replay-${tag}.json`)
  await writeFile(reportPath, JSON.stringify(report, null, 2), 'utf8')
  const md = [
    `# O05 真实会话回放（${tag}）`,
    '',
    `- 提示词：\`${PROMPT_VERSION}\`；模型：${provider} / ${model}；maxTokens=${maxTokens}；effort=${reasoningEffort}`,
    `- 样本：${picked.length} 条（来自 ${sessions.length} 个会话，平均上下文 ${report.samples.avgContextTokens} 估算 token）`,
    '',
    '| 指标 | 值 |',
    '|---|---:|',
    ...Object.entries(report.metrics).map(([key, value]) => `| ${key} | ${value !== null && typeof value === 'object' ? JSON.stringify(value) : value} |`),
    '',
    '报告只含分数与哈希，不含对话正文；逐条结果见同名 JSON。',
  ].join('\n')
  await writeFile(path.join(outDir, `replay-${tag}.md`), md, 'utf8')
  console.log(JSON.stringify({ ok: true, report: reportPath, samples: report.samples, metrics: report.metrics }, null, 2))
} finally {
  await browser.close().catch(() => {})
}
