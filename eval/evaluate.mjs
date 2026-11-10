#!/usr/bin/env node
/**
 * P3 质量与成本评测 runner。
 *
 * 评测对象是冻结的预测提示词 + 严格输出校验（与插件生产路径同一份
 * src/shared/prompt.js 与 output-validation.js）。通过仅在 predictor-scratch
 * profile 安装的 eval host 调用 DSH 模型层，对 120 条去标识合成样本逐条请求；
 * dev 集用于调参，holdout 集用于最终评估。
 *
 * 用法：
 *   node eval/evaluate.mjs --url "<scratch URL>" --mode probe
 *   node eval/evaluate.mjs --url "<scratch URL>" --mode run --provider deepseek-official --model deepseek-flash --group all --tag p3
 *
 * 说明：
 * - 无法自动得出“人工可接受率”；报告给出结构指标 + 启发式辅助初评，人工评分清单
 *   在报告末尾，需人工复核后才能宣称质量达标。
 * - 没有文本 token 价格 API，只报告 usage，不估算金额。
 */
import { browserPath, loadChromium } from '../tools/lib/local-env.mjs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { buildPredictionInput, buildSystemPrompt, PROMPT_VERSION } from '../src/shared/prompt.js'
import { parsePredictionJson } from '../src/shared/output-validation.js'

const chromium = loadChromium()

const here = path.dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const argOf = (name, fallback) => {
  const i = args.indexOf(name)
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback
}
const url = argOf('--url', '')
const mode = argOf('--mode', 'run')
const provider = argOf('--provider', '')
const model = argOf('--model', '')
const group = argOf('--group', 'all')
const tag = argOf('--tag', 'p3')
const limit = Number(argOf('--limit', '0'))
const fixturesPath = path.join(here, 'fixtures.deidentified.jsonl')
if (!url) throw new Error('--url is required')

const rows = (await readFile(fixturesPath, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
const selected = rows.filter((row) => group === 'all' || row.group === group).slice(0, limit > 0 ? limit : undefined)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const browser = await chromium.launch({ executablePath: browserPath(), headless: true })
const page = await browser.newPage()
page.setDefaultTimeout(120000)

async function evalCall(payload) {
  return page.evaluate(async (request) => {
    try {
      const response = await fetch('/api/nmp-eval/rpc', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request),
      })
      return { httpStatus: response.status, json: await response.json() }
    } catch (error) {
      return { error: String(error) }
    }
  }, payload)
}

function heuristicAcceptable(suggestion) {
  if (typeof suggestion !== 'string' || suggestion === '') return false
  if (suggestion.length > 80) return false
  if (/^(sure|certainly|of course|here(?:'s| is)|好的[，,].{0,4}(已|我)|已完成|已修复|我来)/i.test(suggestion)) return false
  if (/[`*#]|```/.test(suggestion)) return false
  return true
}

function percentile(values, p) {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[index]
}

try {
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => Boolean(globalThis.__DSH_BOOT__) || Boolean(document.querySelector('[data-composer-input]')), undefined, { timeout: 30000 })
  const providers = await evalCall({ operation: 'providers' })
  if (mode === 'probe') {
    const value = providers.json?.value ?? null
    console.log(JSON.stringify({ providers: value }, null, 2))
    const sample = selected[0]
    const probe = await evalCall({
      operation: 'run',
      provider: provider || value?.selection?.provider,
      model: model || value?.selection?.model,
      system: buildSystemPrompt(),
      input: buildPredictionInput(sample.messages),
      maxTokens: 256,
    })
    console.log(JSON.stringify({ probe: { id: sample.id, result: probe.json } }, null, 2))
    await browser.close()
    process.exit(0)
  }

  const results = []
  const chunkSize = 10
  for (let start = 0; start < selected.length; start += chunkSize) {
    const chunk = selected.slice(start, start + chunkSize)
    const batch = chunk.map((row) => ({
      id: row.id,
      group: row.group,
      category: row.category,
      expect: row.expect,
      forbid: Array.isArray(row.forbid) ? row.forbid : [],
      messages: row.messages,
      system: buildSystemPrompt(),
      input: buildPredictionInput(row.messages),
      provider: provider || undefined,
      model: model || undefined,
      maxTokens: 256,
    }))
    const responses = await page.evaluate(async (requests) => {
      const out = []
      for (const request of requests) {
        const started = Date.now()
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
            }),
          })
          const json = await response.json()
          out.push({ id: request.id, wallMs: Date.now() - started, response: json })
        } catch (error) {
          out.push({ id: request.id, wallMs: Date.now() - started, error: String(error) })
        }
        await new Promise((resolve) => setTimeout(resolve, 120))
      }
      return out
    }, batch)
    for (let i = 0; i < batch.length; i += 1) {
      const request = batch[i]
      const response = responses[i]
      const value = response?.response?.ok === true ? response.response.value : null
      const error = response?.error ?? (response?.response?.ok === false ? response.response.error : undefined)
      let parsed = { ok: false, reason: 'no-response' }
      if (value !== null) parsed = parsePredictionJson(value.text, { maxGraphemes: 160 })
      const forbidden = request.forbid ?? []
      const violation = parsed.ok === true && typeof parsed.suggestion === 'string'
        ? forbidden.some((word) => parsed.suggestion.includes(word))
        : false
      results.push({
        id: request.id,
        group: request.group,
        category: request.category,
        expect: request.expect,
        forbid: forbidden,
        raw: value === null ? null : value.text,
        finish: value === null ? null : value.finish,
        usage: value === null ? null : value.usage,
        elapsedMs: value === null ? response?.wallMs ?? null : value.elapsedMs,
        error: error ?? null,
        parser: parsed,
        suggestion: parsed.ok === true ? parsed.suggestion : null,
        violation,
        acceptableHint: parsed.ok === true && typeof parsed.suggestion === 'string' ? heuristicAcceptable(parsed.suggestion) : false,
      })
    }
    console.log(`evaluated ${Math.min(start + chunkSize, selected.length)}/${selected.length}`)
  }
  await browser.close()

  // ---- metrics -------------------------------------------------------------
  const byGroup = (name) => results.filter((row) => row.group === name)
  const invalid = (row) => row.parser.ok !== true
  const abstained = (row) => row.parser.ok === true && row.parser.suggestion === null
  const offered = (row) => row.parser.ok === true && typeof row.parser.suggestion === 'string'
  const nonStop = (row) => row.finish !== null && row.finish !== 'stop'

  function summarize(rowsSubset) {
    const offerExpected = rowsSubset.filter((row) => row.expect === 'offer')
    const abstainExpected = rowsSubset.filter((row) => row.expect === 'abstain')
    const eitherExpected = rowsSubset.filter((row) => row.expect === 'either')
    const latencies = rowsSubset.map((row) => row.elapsedMs).filter((value) => typeof value === 'number')
    const usage = rowsSubset.reduce(
      (sum, row) => {
        if (row.usage !== null && typeof row.usage === 'object') {
          sum.input += Number(row.usage.inputTokens) || 0
          sum.output += Number(row.usage.outputTokens) || 0
          sum.reasoning += Number(row.usage.reasoningTokens) || 0
        } else {
          sum.unknown += 1
        }
        return sum
      },
      { input: 0, output: 0, reasoning: 0, unknown: 0 },
    )
    const violations = rowsSubset.filter((row) => row.violation === true)
    const failures = rowsSubset
      .filter(
        (row) =>
          (row.expect === 'offer' && !offered(row)) ||
          (row.expect === 'abstain' && offered(row) && !row.violation) ||
          row.violation ||
          invalid(row) ||
          nonStop(row),
      )
      .map((row) => ({
        id: row.id,
        category: row.category,
        expect: row.expect,
        got: invalid(row) ? `invalid:${row.parser.reason}` : abstained(row) ? 'abstain' : 'offer',
        suggestion: row.suggestion,
        violation: row.violation,
        finish: row.finish,
        error: row.error,
        elapsedMs: row.elapsedMs,
      }))
    const round1 = (value) => (value === null ? null : Math.round(value * 10) / 10)
    const offeredRows = rowsSubset.filter(offered)
    return {
      count: rowsSubset.length,
      offerExpected: offerExpected.length,
      offerCoverage: offerExpected.length === 0 ? null : round1((offerExpected.filter(offered).length / offerExpected.length) * 100),
      abstainExpected: abstainExpected.length,
      abstainStrict: abstainExpected.length === 0 ? null : round1((abstainExpected.filter(abstained).length / abstainExpected.length) * 100),
      abstainAcceptable: abstainExpected.length === 0
        ? null
        : round1((abstainExpected.filter((row) => abstained(row) || (offered(row) && !row.violation)).length / abstainExpected.length) * 100),
      either: eitherExpected.length,
      violationCount: violations.length,
      violationRate: rowsSubset.length === 0 ? null : round1((violations.length / rowsSubset.length) * 100),
      violations: violations.map((row) => ({ id: row.id, category: row.category, suggestion: row.suggestion, forbid: row.forbid })),
      invalidRate: rowsSubset.length === 0 ? null : round1((rowsSubset.filter(invalid).length / rowsSubset.length) * 100),
      nonStopRate: rowsSubset.length === 0 ? null : round1((rowsSubset.filter(nonStop).length / rowsSubset.length) * 100),
      acceptableHintRate: round1((offeredRows.filter((row) => row.acceptableHint).length / Math.max(1, offeredRows.length)) * 100),
      latencyP50: percentile(latencies, 50),
      latencyP95: percentile(latencies, 95),
      usage,
      failures,
    }
  }

  const report = {
    runner: 'eval/evaluate.mjs',
    generatedAt: new Date().toISOString(),
    model: { provider: provider || '(session default)', model: model || '(session default)' },
    promptVersion: PROMPT_VERSION,
    fixtures: { file: 'eval/fixtures.deidentified.jsonl', total: rows.length, selected: selected.length, group },
    summary: { all: summarize(results), dev: summarize(byGroup('dev')), holdout: summarize(byGroup('holdout')) },
    results,
  }
  await mkdir(here, { recursive: true })
  const jsonPath = path.join(here, `report-${tag}.json`)
  await writeFile(jsonPath, JSON.stringify(report, null, 2), 'utf8')
  const md = renderMarkdown(report)
  const mdPath = path.join(here, `report-${tag}.md`)
  await writeFile(mdPath, md, 'utf8')
  console.log(JSON.stringify({ ok: true, report: jsonPath, markdown: mdPath, summary: report.summary }, null, 2))
} catch (error) {
  await browser.close().catch(() => {})
  console.error(JSON.stringify({ ok: false, error: String(error?.stack ?? error) }, null, 2))
  process.exit(1)
}

function renderMarkdown(report) {
  const lines = []
  lines.push(`# P3 评测报告（${report.generatedAt}）`)
  lines.push('')
  lines.push(`- 提示词版本：\`${report.promptVersion}\``)
  lines.push(`- 模型：${report.model.provider} / ${report.model.model}`)
  lines.push(`- 样本：${report.fixtures.selected}/${report.fixtures.total}（group=${report.fixtures.group}）`)
  lines.push('')
  lines.push('## 汇总指标（自动）')
  lines.push('')
  lines.push('| 指标 | all | dev | holdout |')
  lines.push('|---|---:|---:|---:|')
  const keys = [
    ['样本数', 'count'],
    ['应预测覆盖率 %', 'offerCoverage'],
    ['应弃权严格弃权率 %（仅 suggestion:null）', 'abstainStrict'],
    ['应弃权可接受率 %（弃权或询问细节且不违规）', 'abstainAcceptable'],
    ['either 样本数（不强制弃权）', 'either'],
    ['违规建议数（命中 forbid 规则）', 'violationCount'],
    ['违规率 %', 'violationRate'],
    ['结构非法率 %', 'invalidRate'],
    ['非 stop finish 率 %', 'nonStopRate'],
    ['启发式可接受率 %（辅助）', 'acceptableHintRate'],
    ['延迟 P50 ms', 'latencyP50'],
    ['延迟 P95 ms', 'latencyP95'],
  ]
  for (const [label, key] of keys) {
    lines.push(`| ${label} | ${report.summary.all[key] ?? '-'} | ${report.summary.dev[key] ?? '-'} | ${report.summary.holdout[key] ?? '-'} |`)
  }
  lines.push('')
  lines.push('token 用量（all）：' + JSON.stringify(report.summary.all.usage) + '（无文本价格 API，不估算金额）')
  lines.push('')
  lines.push('## 违规建议（命中 forbid 规则，all）')
  lines.push('')
  if (report.summary.all.violations.length === 0) lines.push('无。')
  else {
    lines.push('| id | category | 建议 | 命中规则 |')
    lines.push('|---|---|---|---|')
    for (const row of report.summary.all.violations) {
      lines.push(`| ${row.id} | ${row.category} | ${(row.suggestion ?? '').replace(/\|/g, '\\|').slice(0, 80)} | ${row.forbid.join(' / ')} |`)
    }
  }
  lines.push('')
  lines.push('## 失败/待人工复核样本（all）')
  lines.push('')
  if (report.summary.all.failures.length === 0) lines.push('无。')
  else {
    lines.push('| id | category | 期望 | 实际 | finish | 延迟 | 建议 |')
    lines.push('|---|---|---|---|---|---:|---|')
    for (const row of report.summary.all.failures) {
      lines.push(`| ${row.id} | ${row.category} | ${row.expect} | ${row.got} | ${row.finish ?? '-'} | ${row.elapsedMs ?? '-'} | ${(row.suggestion ?? '').replace(/\|/g, '\\|').slice(0, 80)} |`)
    }
  }
  lines.push('')
  lines.push('## 人工评分清单（必须完成）')
  lines.push('')
  lines.push('自动指标不能代替方案 §十二 的人工评分。请从 `report-*.json` 的 `results` 中抽取：')
  lines.push('')
  lines.push('- [ ] 展示建议的人工可接受率（分母 = 实际给出建议的样本数），目标 ≥85%')
  lines.push('- [ ] 应弃权场景的弃权正确率（分母 = 应弃权样本数），目标 ≥90%')
  lines.push('- [ ] 可预测场景覆盖率单独报告，目标 ≥30%')
  lines.push('- [ ] 未授权批准、虚构用户事实、泄露敏感内容的保留集检查（目标：0 例，不等于零风险证明）')
  lines.push('- [ ] 每个失败样本的人工判断：提示词问题 / 上下文不足 / 模型能力 / 校验过严')
  lines.push('')
  return lines.join('\n')
}
