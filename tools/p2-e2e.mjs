#!/usr/bin/env node
/**
 * P2 端到端验证（真实 DSH 模型层 + 本地 mock provider）。
 *
 * 覆盖：
 *   1. 插件进入 model 模式且路由 = mock/mock-1；
 *   2. 完成一个真实回合后，Host 读取权威上下文、写持久派发账本与预算、调用一次
 *      ctx.llm.stream，并严格解析 mock 返回的 JSON → ghost 出现；
 *   3. Tab 采纳（零发送）与 Ctrl+Z 撤销；
 *   4. 非法 JSON 注入 → 弃权、不上屏；
 *   5. 模型慢响应 + 小超时 → 超时弃权、不重试（mock 只收到一次预测请求）；
 *   6. 预算耗尽（dailyRequestLimit=1）→ 不调用模型、无 ghost；
 *   7. 证据：mock 日志、ledger.json、Host status diagnostics、截图。
 *
 * 用法：
 *   node tools/p2-e2e.mjs --url "<scratch URL>" [--out scratch/evidence] [--tag p2] [--mock-log <path>]
 */
import { browserPath, loadChromium } from './lib/local-env.mjs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const chromium = loadChromium()

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..')
const args = process.argv.slice(2)
const argOf = (name, fallback) => {
  const i = args.indexOf(name)
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback
}
const url = argOf('--url', '')
const out = argOf('--out', path.join(repoRoot, 'scratch', 'evidence'))
const tag = argOf('--tag', 'p2')
const MOCK_BASE = argOf('--mock', 'http://127.0.0.1:3091')
const mockLog = argOf('--mock-log', path.join(repoRoot, 'scratch', 'logs', 'mock-llm.out.log'))
// Same default as tools/launch-scratch-web.ps1: the scratch host keeps its ledger apart from ~/.dsh.
const dshHome = process.env.NMP_DATA_HOME ?? path.join(repoRoot, 'scratch', 'data-home')
const ledgerFile = path.join(dshHome, 'next-message-predictor', 'ledger.json')
if (!url) throw new Error('--url is required')
await mkdir(out, { recursive: true })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const report = { ok: false, url, mockBase: MOCK_BASE, startedAt: new Date().toISOString(), steps: {}, console: [], pageErrors: [] }

async function mockControl(patch) {
  const response = await fetch(`${MOCK_BASE}/control`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  })
  return response.json()
}
async function mockState() {
  const response = await fetch(`${MOCK_BASE}/state`)
  return response.json()
}
async function readMockLogTail(lines = 40) {
  try {
    const text = await readFile(mockLog, 'utf8')
    return text.split('\n').slice(-lines).join('\n')
  } catch {
    return ''
  }
}
async function readLedger() {
  try {
    return JSON.parse(await readFile(ledgerFile, 'utf8'))
  } catch (error) {
    return { error: String(error?.code ?? error?.message ?? error) }
  }
}

const browser = await chromium.launch({
  executablePath: browserPath(),
  headless: true,
  args: ['--disable-gpu', '--no-first-run', '--no-default-browser-check'],
})
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
const page = await context.newPage()
page.setDefaultTimeout(30000)
page.on('console', (m) => {
  if (report.console.length < 300) report.console.push({ type: m.type(), text: m.text().slice(0, 1200) })
})
page.on('pageerror', (e) => report.pageErrors.push(String(e).slice(0, 3000)))
const network = { requests: [], framesSent: [] }
page.on('request', (request) => {
  if (network.requests.length < 600) {
    network.requests.push({ at: Date.now(), method: request.method(), url: request.url().slice(0, 400), body: (request.postData() ?? '').slice(0, 1200) })
  }
})
page.on('websocket', (ws) => {
  ws.on('framesent', (frame) => {
    const payload = typeof frame.payload === 'string' ? frame.payload : ''
    if (network.framesSent.length < 600) network.framesSent.push({ at: Date.now(), payload: payload.slice(0, 1500) })
  })
})
await context.newCDPSession(page)

const state = () =>
  page.evaluate(() => {
    try {
      const api = window.__nextMessagePredictor
      if (!api) return { present: false }
      const s = api.state()
      return {
        present: true,
        status: s.assist.status,
        reason: s.assist.reason,
        text: s.assist.text,
        suggestionId: s.assist.suggestionId,
        env: s.env
          ? { turnId: s.env.turnId, running: s.env.running, hasFinalText: s.env.hasFinalText, draft: s.env.draft }
          : null,
        config: {
          ready: s.config.ready,
          enabled: s.config.config ? s.config.config.enabled : null,
          modelMode: s.config.config ? s.config.config.modelMode : null,
          timeoutMs: s.config.config ? s.config.config.timeoutMs : null,
          dailyRequestLimit: s.config.config ? s.config.config.dailyRequestLimit : null,
          revision: s.config.revision,
          route: s.config.route,
          mode: s.config.mode,
          promptVersion: s.config.promptVersion,
        },
      }
    } catch (error) {
      return { present: true, error: String(error) }
    }
  })

const dom = () =>
  page.evaluate(() => {
    const input = document.querySelector('[data-composer-input]')
    const ghost = document.querySelector('[data-nmp-ghost]')
    return {
      input: Boolean(input),
      editable: input ? input.isContentEditable : false,
      draft: input ? input.textContent : null,
      ghost: Boolean(ghost),
      ghostVisible: ghost ? ghost.getBoundingClientRect().width > 0 : false,
      ghostText: ghost ? ghost.textContent : null,
      activeIsInput: input ? document.activeElement === input : false,
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
      return { httpStatus: response.status, json: await response.json() }
    } catch (error) {
      return { error: String(error) }
    }
  }, body)

const statusValue = async () => {
  const result = await rpc({ schemaVersion: 1, operation: 'status' })
  return result.json && result.json.ok === true ? result.json.value : null
}
const reloadConfig = async () => {
  await page.evaluate(() => window.__nextMessagePredictor?.reloadConfig?.()).catch(() => {})
  await sleep(1200)
}

async function dismissPreview() {
  const dialogs = page.locator('[role="dialog"]')
  for (let i = 0; i < (await dialogs.count()); i += 1) {
    const d = dialogs.nth(i)
    const text = await d.innerText().catch(() => '')
    if (text.includes('预览版说明') || text.includes('preview')) {
      const b = d.locator('button', { hasText: /继续|Continue/ }).first()
      if (await b.count()) {
        await b.click({ force: true })
        await sleep(600)
        return
      }
    }
  }
}
async function ensureComposer() {
  await dismissPreview()
  for (let i = 0; i < 12; i += 1) {
    const d = await dom()
    if (d.input && d.editable) return d
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
    await sleep(300)
  }
  throw new Error('composer is not ready')
}
async function waitGhost(timeoutMs, expectText) {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    const s = await state()
    const d = await dom()
    last = { s, d }
    if (s.status === 'offered' && s.text !== '' && d.ghost === true && d.ghostVisible === true && (expectText === undefined || s.text.includes(expectText))) {
      return last
    }
    await sleep(100)
  }
  return last
}
async function sendTurn(text) {
  await ensureComposer()
  await page.locator('[data-composer-input]').first().click({ force: true })
  await sleep(150)
  await page.keyboard.press('Control+A')
  await page.keyboard.press('Delete')
  await sleep(150)
  const before = await state()
  const turnBefore = before.env ? before.env.turnId : ''
  await page.keyboard.type(text, { delay: 8 })
  await page.keyboard.press('Enter')
  let started = false
  for (let i = 0; i < 100; i += 1) {
    const s = await state()
    if (s.env && s.env.running === true) {
      started = true
      break
    }
    await sleep(100)
  }
  if (!started) throw new Error('turn did not start')
  for (let i = 0; i < 250; i += 1) {
    const s = await state()
    if (s.env && s.env.running === false && s.env.hasFinalText === true && s.env.turnId !== turnBefore && s.env.turnId !== '') {
      return s
    }
    await sleep(100)
  }
  throw new Error('turn did not finish')
}
const record = (name, value) => {
  report.steps[name] = value
}
const shot = async (name) => {
  const file = path.join(out, `${tag}-${name}.png`)
  await page.screenshot({ path: file })
  return file
}

try {
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => Boolean(globalThis.__DSH_BOOT__) || Boolean(document.querySelector('[data-composer-input]')), undefined, { timeout: 30000 })
  await ensureComposer()
  await page.waitForFunction(() => Boolean(window.__nextMessagePredictor), undefined, { timeout: 30000 })
  await mockControl({ predictMode: 'json' })
  const initial = await state()
  const initialStatus = await statusValue()
  record('initial', { state: initial, status: initialStatus, mock: await mockState(), ledger: await readLedger() })
  if (!initialStatus || initialStatus.mode !== 'model') throw new Error(`expected model mode, got ${JSON.stringify(initialStatus?.mode)}`)
  if (!initialStatus.route || initialStatus.route.provider !== 'mock' || initialStatus.route.model !== 'mock-1') {
    throw new Error(`expected mock/mock-1 route, got ${JSON.stringify(initialStatus.route)}`)
  }
  await shot('00-initial')

  // 1) real turn -> authoritative context -> one model call -> strict JSON -> ghost
  const beforeLedger = await readLedger()
  const beforeCounters = initialStatus.diagnostics.counters
  let sharedResponse
  const rpcPattern = '**/api/next-message-predictor/rpc'
  const duplicatePrediction = async (route) => {
    const request = route.request().postDataJSON()
    if (request?.operation !== 'predict') return route.continue()
    const duplicate = { ...request, requestId: request.requestId + '-second', viewId: 'second-view' }
    const [primary, secondary] = await Promise.all([route.fetch(), route.fetch({ postData: duplicate })])
    sharedResponse = await secondary.json()
    await route.fulfill({ response: primary })
  }
  await page.route(rpcPattern, duplicatePrediction)
  const turn = await sendTurn('请回复：收到')
  const ghost = await waitGhost(25000, '继续第二项')
  await page.unroute(rpcPattern, duplicatePrediction)
  if (sharedResponse?.result?.kind !== 'offer' || sharedResponse.result.suggestionId !== ghost.s.suggestionId) {
    throw new Error('concurrent view did not receive the same offer')
  }
  record('model-ghost', {
    turnId: turn.env.turnId,
    state: ghost.s,
    dom: ghost.d,
    sharedOffer: true,
    mockLogTail: await readMockLogTail(12),
  })
  if (ghost.s.status !== 'offered' || ghost.d.ghost !== true) throw new Error('P2 ghost did not appear')
  const afterStatus = await statusValue()
  const afterLedger = await readLedger()
  const counters = afterStatus.diagnostics.counters
  record('evidence', {
    status: afterStatus,
    ledgerBefore: beforeLedger,
    ledgerAfter: afterLedger,
    counters,
  })
  if (counters.providerCalls - beforeCounters.providerCalls !== 1) throw new Error('concurrent views must share one provider call')
  if (afterStatus.route?.source !== 'session' || afterStatus.route.provider !== 'mock' || afterStatus.route.model !== 'mock-1') {
    throw new Error('predictor did not use the completed turn model')
  }
  if (!(counters.contextBuilds >= 1)) throw new Error('context was not built')
  if (!(counters.inputTokens > 0)) throw new Error('input tokens were not recorded')
  if (!(counters.offers >= 1)) throw new Error('no offer was produced')
  if (!(counters.contextFailures === 0)) throw new Error('unexpected context failures')
  const todayKey = Object.keys(afterLedger.budgetDays ?? {}).sort().pop()
  const today = todayKey === undefined ? undefined : afterLedger.budgetDays[todayKey]
  if (today === undefined) throw new Error('ledger has no daily budget entry')
  if (!(today.requests > 0)) throw new Error('ledger daily request counter missing')
  if (!(today.inputTokens + today.outputTokens > 0)) throw new Error('ledger did not record token usage')
  await shot('01-model-ghost')

  // 2) Tab adopt -> zero send -> undo
  const suggestionText = ghost.s.text
  const beforeAccept = { requests: network.requests.length, frames: network.framesSent.length }
  await page.locator('[data-composer-input]').first().click({ force: true })
  await sleep(200)
  await page.keyboard.press('Tab')
  await sleep(300)
  const adopted = await dom()
  const acceptedState = await state()
  if (adopted.ghost === true) throw new Error('ghost still present after adoption')
  if (!(adopted.draft ?? '').includes(suggestionText)) throw new Error(`draft missing suggestion: ${adopted.draft}`)
  if (acceptedState.status !== 'accepted') throw new Error(`accepted state missing: ${acceptedState.status}`)
  await sleep(1200)
  const newRequests = network.requests.slice(beforeAccept.requests)
  const sendish = newRequests.filter((r) => /session\/prompt|beginSubmission/i.test(r.url + ' ' + r.body))
  if (sendish.length !== 0) throw new Error('prompt request appeared after adoption')
  const newFrames = network.framesSent.slice(beforeAccept.frames).filter((f) => /session\/prompt|beginSubmission/i.test(f.payload))
  if (newFrames.length !== 0) throw new Error('prompt websocket frame appeared after adoption')
  record('tab-adopt', { suggestionText, draft: adopted.draft, newRequests: newRequests.length, sendish: sendish.length, frames: newFrames.length })
  await page.keyboard.press('Control+z')
  await sleep(300)
  const afterUndo = await dom()
  if (afterUndo.draft !== '') throw new Error('draft not empty after undo')
  record('undo', { draft: afterUndo.draft })
  await shot('02-tab-undo')

  // 3) invalid JSON -> abstain, no ghost
  await mockControl({ predictMode: 'invalid' })
  const rejectedBefore = (await statusValue()).diagnostics.counters.outputRejects
  await sendTurn('请再回复：收到')
  await sleep(2500)
  const afterInvalid = await dom()
  const rejectedAfter = (await statusValue()).diagnostics.counters.outputRejects
  if (afterInvalid.ghost === true) throw new Error('invalid JSON still painted a ghost')
  if (!(rejectedAfter > rejectedBefore)) throw new Error('outputRejects was not recorded')
  record('invalid-json', { ghost: afterInvalid.ghost, outputRejectsBefore: rejectedBefore, outputRejectsAfter: rejectedAfter, mockLogTail: await readMockLogTail(8) })

  // 4) slow response + tiny timeout -> timeout abstain, exactly one attempt
  await mockControl({ predictMode: 'slow' })
  const setTiny = await rpc({ schemaVersion: 1, operation: 'config.set', patch: { timeoutMs: 1000 } })
  if (!setTiny.json || setTiny.json.ok !== true) throw new Error(`failed to set timeoutMs: ${JSON.stringify(setTiny)}`)
  await reloadConfig()
  const timeoutCallsBefore = (await statusValue()).diagnostics.counters.providerCalls
  const mockBefore = (await readMockLogTail(300)).match(/predictor-request/g)?.length ?? 0
  await sendTurn('请第三次回复：收到')
  await sleep(3500)
  const afterTimeout = await dom()
  const timeoutCallsAfter = (await statusValue()).diagnostics.counters.providerCalls
  const mockAfter = (await readMockLogTail(300)).match(/predictor-request/g)?.length ?? 0
  if (afterTimeout.ghost === true) throw new Error('timeout still painted a ghost')
  if (!(timeoutCallsAfter > timeoutCallsBefore)) throw new Error('timeout path did not call the model')
  if (!(mockAfter - mockBefore === 1)) throw new Error(`mock predictor requests after timeout: ${mockAfter - mockBefore}`)
  const timeoutStatus = await statusValue()
  record('timeout', {
    ghost: afterTimeout.ghost,
    providerCalls: { before: timeoutCallsBefore, after: timeoutCallsAfter },
    mockPredictorRequests: mockAfter - mockBefore,
    lastEvents: timeoutStatus ? timeoutStatus.diagnostics.events.slice(-4) : null,
  })

  // 5) budget exhausted -> no model call, no ghost
  const dailyLimit = await rpc({ schemaVersion: 1, operation: 'config.set', patch: { dailyRequestLimit: 1, timeoutMs: 8000 } })
  if (!dailyLimit.json || dailyLimit.json.ok !== true) throw new Error('failed to set daily limit')
  await reloadConfig()
  const budgetMockBefore = (await readMockLogTail(300)).match(/predictor-request/g)?.length ?? 0
  await sendTurn('请第四次回复：收到')
  await sleep(3000)
  const afterBudget = await dom()
  const budgetMockAfter = (await readMockLogTail(300)).match(/predictor-request/g)?.length ?? 0
  if (afterBudget.ghost === true) throw new Error('budget exhaustion still painted a ghost')
  if (budgetMockAfter !== budgetMockBefore) throw new Error('budget exhaustion still called the model')
  const budgetStatus = await statusValue()
  record('budget-exhausted', { ghost: afterBudget.ghost, mockCalls: budgetMockAfter - budgetMockBefore, budget: budgetStatus ? budgetStatus.budget : null })
  await shot('03-budget-exhausted')

  // 6) restore defaults
  const restore = await rpc({
    schemaVersion: 1,
    operation: 'config.set',
    patch: { enabled: true, timeoutMs: 8000, dailyRequestLimit: 200, dailyTokenBudget: 500000, modelMode: 'session' },
  })
  if (!restore.json || restore.json.ok !== true) throw new Error('failed to restore config')
  await mockControl({ predictMode: 'json' })
  await reloadConfig()
  record('restore', { ok: true, status: await statusValue() })

  report.network = { requests: network.requests.length, framesSent: network.framesSent.length }
  report.ok = true
} catch (error) {
  report.error = String(error?.stack ?? error)
  await shot('99-failure').catch(() => {})
  report.steps.failure = { console: report.console.slice(-20), pageErrors: report.pageErrors }
} finally {
  report.finishedAt = new Date().toISOString()
  if (!process.argv.includes('--keep-open')) await browser.close().catch(() => {})
  const reportPath = path.join(out, `${tag}-report.json`)
  await writeFile(reportPath, JSON.stringify(report, null, 2)).catch(() => {})
  console.log(
    JSON.stringify(
      {
        ok: report.ok,
        out: reportPath,
        steps: Object.keys(report.steps),
        error: report.error ?? null,
      },
      null,
      2,
    ),
  )
  if (!report.ok) process.exitCode = 1
}
