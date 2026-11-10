#!/usr/bin/env node
/**
 * 合并 dev 与 holdout 两份评测报告为最终 P3 报告。
 * 要求两份报告使用同一 prompt 版本与同一模型。
 *
 * 用法：node eval/merge-reports.mjs --dev eval/report-p3-dev-v3.json --holdout eval/report-p3-holdout.json --tag p3-final
 */
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const argOf = (name, fallback) => {
  const i = args.indexOf(name)
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback
}
const devPath = path.resolve(argOf('--dev', path.join(here, 'report-p3-dev-v3.json')))
const holdoutPath = path.resolve(argOf('--holdout', path.join(here, 'report-p3-holdout.json')))
const tag = argOf('--tag', 'p3-final')

const dev = JSON.parse(await readFile(devPath, 'utf8'))
const holdout = JSON.parse(await readFile(holdoutPath, 'utf8'))
if (dev.promptVersion !== holdout.promptVersion) throw new Error('prompt version mismatch between reports')
if (dev.model.provider !== holdout.model.provider || dev.model.model !== holdout.model.model) {
  throw new Error('model mismatch between reports')
}
const results = [...dev.results, ...holdout.results]

const offered = (row) => row.parser.ok === true && typeof row.parser.suggestion === 'string'
const abstained = (row) => row.parser.ok === true && row.parser.suggestion === null
const invalid = (row) => row.parser.ok !== true
const nonStop = (row) => row.finish !== null && row.finish !== 'stop'
const percentile = (values, p) => {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[index]
}

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
  const failures = rowsSubset.filter(
    (row) =>
      (row.expect === 'offer' && !offered(row)) ||
      (row.expect === 'abstain' && offered(row) && !row.violation) ||
      row.violation ||
      invalid(row) ||
      nonStop(row),
  )
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
    invalidRate: round1((rowsSubset.filter(invalid).length / rowsSubset.length) * 100),
    nonStopRate: round1((rowsSubset.filter(nonStop).length / rowsSubset.length) * 100),
    acceptableHintRate: round1((offeredRows.filter((row) => row.acceptableHint).length / Math.max(1, offeredRows.length)) * 100),
    latencyP50: percentile(latencies, 50),
    latencyP95: percentile(latencies, 95),
    usage,
    failureCount: failures.length,
  }
}

const report = {
  runner: 'eval/merge-reports.mjs',
  generatedAt: new Date().toISOString(),
  model: dev.model,
  promptVersion: dev.promptVersion,
  fixtures: { file: 'eval/fixtures.deidentified.jsonl', total: 120, dev: dev.results.length, holdout: holdout.results.length },
  sources: { dev: path.basename(devPath), holdout: path.basename(holdoutPath) },
  summary: {
    all: summarize(results),
    dev: summarize(results.filter((row) => row.group === 'dev')),
    holdout: summarize(results.filter((row) => row.group === 'holdout')),
  },
  results,
}
const jsonPath = path.join(here, `report-${tag}.json`)
await writeFile(jsonPath, JSON.stringify(report, null, 2), 'utf8')

const machine = process.env.COMPUTERNAME ?? 'local'
const lines = []
lines.push(`# P3 质量与成本评测报告（最终）`)
lines.push('')
lines.push(`- 生成时间：${report.generatedAt}`)
lines.push(`- 机器：${machine}（DSH 0.2.2-rc.1，隔离 predictor-scratch profile）`)
lines.push(`- 提示词版本：\`${report.promptVersion}\`（冻结）`)
lines.push(`- 模型：${report.model.provider} / ${report.model.model}（通过 DSH \`ctx.llm\` 路由调用）`)
lines.push(`- 样本：${report.fixtures.total} 条去标识合成样本（dev ${report.fixtures.dev} / holdout ${report.fixtures.holdout}；应弃权 ${report.summary.all.abstainExpected} 条、either ${report.summary.all.either} 条）`)
lines.push('')
lines.push('## 自动指标')
lines.push('')
lines.push('| 指标 | all | dev | holdout |')
lines.push('|---|---:|---:|---:|')
const keys = [
  ['样本数', 'count'],
  ['应预测覆盖率 %', 'offerCoverage'],
  ['应弃权严格弃权率 %（仅 suggestion:null）', 'abstainStrict'],
  ['应弃权可接受率 %（弃权或询问细节且不违规）', 'abstainAcceptable'],
  ['违规建议数（命中 forbid 规则）', 'violationCount'],
  ['违规率 %', 'violationRate'],
  ['结构非法率 %', 'invalidRate'],
  ['非 stop finish 率 %', 'nonStopRate'],
  ['启发式可接受率 %（辅助，非人工）', 'acceptableHintRate'],
  ['延迟 P50 ms', 'latencyP50'],
  ['延迟 P95 ms', 'latencyP95'],
  ['未达预期样本数', 'failureCount'],
]
for (const [label, key] of keys) {
  lines.push(`| ${label} | ${report.summary.all[key] ?? '-'} | ${report.summary.dev[key] ?? '-'} | ${report.summary.holdout[key] ?? '-'} |`)
}
lines.push('')
lines.push(`token 用量（all）：${JSON.stringify(report.summary.all.usage)}。无文本 token 价格 API，不估算金额；按该用量可自行按 provider 单价换算。`)
lines.push('')
lines.push('## 结论边界')
lines.push('')
lines.push('- 以上全部为**自动指标**。')
lines.push('- 合成样本覆盖面有限（120 条、12 类、10 个主题），应预测覆盖率偏高不代表真实对话分布；不得用星数/仓库数等生态指标推导结论（方案 §十四）。')
lines.push('- `abstainAcceptable` 的“询问细节”判定依赖 forbid 关键词表，存在漏检；dev 集 1 例违规（missing-info-v5）与 holdout 若干“替用户表态”的建议说明该边界仍不够严。')
lines.push('- 无提供商侧精确计费证明；用法用量为 DSH 上报值。')
lines.push('')
lines.push('## 违规与待复核样本')
lines.push('')
if (report.summary.all.violations.length === 0) lines.push('无命中 forbid 规则的违规建议。')
else {
  lines.push('| id | category | 建议 | 命中规则 |')
  lines.push('|---|---|---|---|')
  for (const row of report.summary.all.violations) {
    lines.push(`| ${row.id} | ${row.category} | ${(row.suggestion ?? '').replace(/\|/g, '\\|').slice(0, 80)} | ${row.forbid.join(' / ')} |`)
  }
}
lines.push('')
lines.push('完整逐条结果（含 raw 输出、usage、延迟与 parser 结果）见同目录 `report-p3-final.json`；失败样本清单可用脚本过滤 `results` 得到。')
lines.push('')
const mdPath = path.join(here, `report-${tag}.md`)
await writeFile(mdPath, lines.join('\n'), 'utf8')
console.log(JSON.stringify({ ok: true, json: jsonPath, markdown: mdPath, summary: report.summary }, null, 2))
