#!/usr/bin/env node
/**
 * 第 1 批专项验证（scratch profile，mock 模型）：
 * - B05 手动重试：完成回合自动派发后，用额外请求以 trigger=manual 再次预测，
 *   应真的再调用一次模型并返回 offer（派发键含触发方式）。
 * - O01 结果记录：Host 写 events.jsonl（无正文/无原文 id），results.summary
 *   返回展示率/采纳率等聚合；脚本检查落盘行不含对话、建议正文、会话 id。
 *
 * 只驱动 scratch Web GUI，不修改 profile。
 */
import { browserPath, loadChromium, repoRoot } from './lib/local-env.mjs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import process from 'node:process'

const chromium = loadChromium()

const args = process.argv.slice(2)
const argOf = (name, fallback) => {
  const i = args.indexOf(name)
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback
}
const url = argOf('--url', '')
const outDir = argOf('--out', path.join(repoRoot, 'scratch', 'evidence'))
const tag = argOf('--tag', 'batch1')
if (url === '') throw new Error('--url is required')
await mkdir(outDir, { recursive: true })
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const browser = await chromium.launch({ executablePath: browserPath(), headless: true })
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
const page = await context.newPage()
page.setDefaultTimeout(60000)
const report = { ok: false, url, steps: {} }

async function dismissPreview() {
  const dialogs = page.locator('[role="dialog"]')
  for (let i = 0; i < (await dialogs.count()); i += 1) {
    const dialog = dialogs.nth(i)
    const text = await dialog.innerText().catch(() => '')
    if (text.includes('预览版说明') || text.toLowerCase().includes('preview')) {
      const button = dialog.locator('button', { hasText: /继续|Continue/ }).first()
      if (await button.count()) {
        await button.click({ force: true })
        await sleep(600)
        return
      }
    }
  }
}
async function ensureComposer() {
  await dismissPreview()
  for (let i = 0; i < 20; i += 1) {
    const ready = await page.evaluate(() => {
      const input = document.querySelector('[data-composer-input]')
      return Boolean(input && input.isContentEditable === true)
    })
    if (ready) return
    const picker = page.locator('[role="textbox"][contenteditable="false"]').first()
    if (await picker.count()) {
      await picker.click({ force: true }).catch(() => {})
      await sleep(700)
      const options = page.locator('[role="presentation"] button')
      if (await options.count()) {
        await options.first().click({ force: true }).catch(() => {})
        await sleep(900)
      }
    }
    await sleep(400)
  }
  throw new Error('composer is not ready')
}
const state = () =>
  page.evaluate(() => {
    try {
      const api = window.__nextMessagePredictor
      if (!api) return null
      const s = api.state()
      return {
        status: s.assist.status,
        suggestionId: s.assist.suggestionId,
        text: s.assist.text,
        completedEventSeq: s.assist.completedEventSeq,
        turnId: s.assist.turnId,
        sessionId: s.assist.sessionId,
        configRevision: s.config.revision,
        env: s.env
          ? { sessionId: s.env.sessionId, turnId: s.env.turnId, completedEventSeq: s.env.completedEventSeq, contextRevision: s.env.contextRevision, running: s.env.running, hasFinalText: s.env.hasFinalText, draft: s.env.draft, branchEpoch: s.env.branchEpoch }
          : null,
      }
    } catch {
      return null
    }
  })
const rpc = (body) =>
  page.evaluate(async (payload) => {
    try {
      const response = await fetch('/api/next-message-predictor/rpc', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      })
      return { status: response.status, json: await response.json() }
    } catch (error) {
      return { error: String(error) }
    }
  }, body)
const statusValue = async () => {
  const response = await rpc({ schemaVersion: 1, operation: 'status' })
  return response.json && response.json.ok === true ? response.json.value : null
}
async function sendTurn(text) {
  await ensureComposer()
  const input = page.locator('[data-composer-input]').first()
  await input.click({ force: true })
  await sleep(250)
  await page.keyboard.press('Control+A')
  await page.keyboard.press('Delete')
  await sleep(150)
  const before = await state()
  const turnBefore = before?.env?.turnId ?? ''
  await page.keyboard.type(text, { delay: 12 })
  const typed = await page.evaluate(() => document.querySelector('[data-composer-input]')?.textContent ?? '')
  if (typed.trim() === '') {
    await input.click({ force: true })
    await sleep(150)
    await page.keyboard.type(text, { delay: 12 })
  }
  await page.keyboard.press('Enter')
  let started = false
  for (let i = 0; i < 150; i += 1) {
    const current = await state()
    if (current?.env?.running === true) {
      started = true
      break
    }
    await sleep(100)
  }
  if (!started) throw new Error('turn did not start')
  for (let i = 0; i < 400; i += 1) {
    const current = await state()
    if (current?.env?.running === false && current.env.hasFinalText === true && current.env.turnId !== turnBefore && current.env.turnId !== '') return current
    await sleep(100)
  }
  throw new Error('turn did not finish')
}
async function waitGhost(timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const current = await state()
    const ghost = await page.evaluate(() => Boolean(document.querySelector('[data-nmp-ghost]')))
    if (current?.status === 'offered' && ghost) return current
    if (current?.status === 'abstained' || current?.status === 'failed' || current?.status === 'unavailable') return current
    await sleep(150)
  }
  return null
}

try {
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => Boolean(window.__nextMessagePredictor), undefined, { timeout: 30000 })
  await ensureComposer()
  report.steps.initial = { status: await statusValue() }
  const autoState = await sendTurn('请只回复：收到')
  const offered = await waitGhost(30000)
  report.steps.auto = { status: offered?.status ?? null, suggestion: offered?.text ?? null, ghost: Boolean(offered && offered.status === 'offered') }
  if (offered?.status !== 'offered') throw new Error(`auto prediction not offered: ${offered?.status}`)
  const s = await state()
  const before = await statusValue()
  const anchor = {
    sessionId: s.sessionId || s.env.sessionId,
    branchEpoch: s.env.branchEpoch ?? 'v1',
    turnId: s.turnId || s.env.turnId,
    completedEventSeq: s.completedEventSeq,
    contextRevision: s.env.contextRevision,
  }
  const manual = await rpc({
    schemaVersion: 1,
    operation: 'predict',
    requestId: 'batch1-manual-retry',
    viewId: 'batch1-verify',
    anchor,
    expectedConfigRevision: s.configRevision,
    trigger: 'manual',
  })
  const after = await statusValue()
  report.steps.manual = {
    result: manual.json?.result ?? null,
    providerCallsBefore: before?.diagnostics?.counters?.providerCalls ?? null,
    providerCallsAfter: after?.diagnostics?.counters?.providerCalls ?? null,
    requestsReceivedAfter: after?.diagnostics?.counters?.requestsReceived ?? null,
    sendCalls: after?.diagnostics?.counters?.sendCalls ?? null,
  }
  const summaryResponse = await rpc({ schemaVersion: 1, operation: 'results.summary' })
  report.steps.summary = summaryResponse.json?.value?.summary ?? null
  // 隐私检查：events.jsonl 不得含对话正文、建议正文、会话原文 id、suggestionId。
  const eventsPath = path.join(process.env.NMP_DATA_HOME ?? path.join(repoRoot, 'scratch', 'data-home'), 'next-message-predictor', 'events.jsonl')
  let eventsText = ''
  try {
    eventsText = await readFile(eventsPath, 'utf8')
  } catch {
    report.steps.summaryReadable = false
  }
  const needles = ['请只回复：收到', anchor.sessionId, s.suggestionId].filter((value) => typeof value === 'string' && value !== '')
  const leaks = needles.filter((needle) => eventsText.includes(needle))
  report.steps.eventsFile = {
    path: eventsPath,
    lines: eventsText === '' ? 0 : eventsText.trim().split('\n').length,
    leaked: leaks,
  }
  const manualResult = manual.json?.result
  if (manualResult?.kind !== 'offer') throw new Error(`manual retry did not offer: ${JSON.stringify(manualResult)}`)
  if (!(after.diagnostics.counters.providerCalls > before.diagnostics.counters.providerCalls)) {
    throw new Error('manual retry did not trigger another model call')
  }
  if (leaks.length > 0) throw new Error(`events log leaked raw text: ${leaks.join(',')}`)
  if (after.diagnostics.counters.sendCalls !== 0) throw new Error('sendCalls must stay zero')
  report.ok = true
} catch (error) {
  report.error = String(error?.stack ?? error)
  await page.screenshot({ path: path.join(outDir, `${tag}-99-failure.png`) }).catch(() => {})
} finally {
  report.finishedAt = new Date().toISOString()
  await browser.close().catch(() => {})
  const reportPath = path.join(outDir, `${tag}-verify-report.json`)
  await writeFile(reportPath, JSON.stringify(report, null, 2), 'utf8')
  console.log(JSON.stringify({ ok: report.ok, out: reportPath, steps: report.steps, error: report.error ?? null }, null, 2))
  if (!report.ok) process.exitCode = 1
}
