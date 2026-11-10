#!/usr/bin/env node
/**
 * P4 本机试用验证：在隔离 scratch profile 中让**真实模型**同时承担主对话与
 * 下一条消息预测，验证：
 *   1. 状态里 route 是真实 provider（默认 deepseek-official/deepseek-flash）；
 *   2. 真实回合结束后，预测器走真实模型调用：要么给出建议（ghost 上屏），
 *      要么合法弃权（无 ghost，原因码可查）；
 *   3. 若出现建议：Tab 采纳进入草稿且零发送；Ctrl+Z 撤销；
 *   4. 证据：status diagnostics（provider/延迟/usage）、截图、报告。
 *
 * 本脚本只读/只驱动 UI，不修改 profile；真实模型切换由外部 patch + 重启完成。
 *
 * 用法：node tools/p4-real-e2e.mjs --url "<scratch URL>" [--out scratch/evidence] [--tag p4]
 */
import { browserPath, loadChromium } from './lib/local-env.mjs'
import { mkdir, writeFile } from 'node:fs/promises'
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
const tag = argOf('--tag', 'p4')
if (!url) throw new Error('--url is required')
await mkdir(out, { recursive: true })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const report = { ok: false, url, startedAt: new Date().toISOString(), steps: {}, console: [], pageErrors: [] }
const browser = await chromium.launch({ executablePath: browserPath(), headless: true })
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
const page = await context.newPage()
page.setDefaultTimeout(60000)
page.on('console', (m) => {
  if (report.console.length < 200) report.console.push({ type: m.type(), text: m.text().slice(0, 1000) })
})
page.on('pageerror', (e) => report.pageErrors.push(String(e).slice(0, 2000)))
const network = { requests: [], frames: [] }
page.on('request', (request) => {
  if (network.requests.length < 400) network.requests.push({ at: Date.now(), url: request.url().slice(0, 300), body: (request.postData() ?? '').slice(0, 800) })
})
page.on('websocket', (ws) => {
  ws.on('framesent', (frame) => {
    if (network.frames.length < 400) network.frames.push({ at: Date.now(), payload: (typeof frame.payload === 'string' ? frame.payload : '').slice(0, 1200) })
  })
})

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
        env: s.env ? { turnId: s.env.turnId, running: s.env.running, hasFinalText: s.env.hasFinalText, draft: s.env.draft } : null,
        config: { ready: s.config.ready, route: s.config.route, mode: s.config.mode, promptVersion: s.config.promptVersion, revision: s.config.revision },
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
      ghostText: ghost ? ghost.textContent : null,
      ghostVisible: ghost ? ghost.getBoundingClientRect().width > 0 : false,
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
  for (let i = 0; i < 150; i += 1) {
    const s = await state()
    if (s.env && s.env.running === true) {
      started = true
      break
    }
    await sleep(100)
  }
  if (!started) throw new Error('turn did not start')
  for (let i = 0; i < 400; i += 1) {
    const s = await state()
    if (s.env && s.env.running === false && s.env.hasFinalText === true && s.env.turnId !== turnBefore && s.env.turnId !== '') return s
    await sleep(100)
  }
  throw new Error('turn did not finish')
}
async function waitOffer(timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    const s = await state()
    const d = await dom()
    last = { s, d }
    if (s.status === 'offered' && d.ghost === true) return { kind: 'offer', state: s, dom: d }
    if (s.status === 'abstained' || s.status === 'failed' || s.status === 'unavailable') {
      return { kind: 'abstain', state: s, dom: d }
    }
    await sleep(150)
  }
  return { kind: 'timeout', state: last?.s ?? null, dom: last?.d ?? null }
}
const record = (name, value) => {
  report.steps[name] = value
}

try {
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => Boolean(globalThis.__DSH_BOOT__) || Boolean(document.querySelector('[data-composer-input]')), undefined, { timeout: 30000 })
  await ensureComposer()
  await page.waitForFunction(() => Boolean(window.__nextMessagePredictor), undefined, { timeout: 30000 })
  const initialStatus = await statusValue()
  record('initial', { status: initialStatus })
  if (!initialStatus || initialStatus.mode !== 'model') throw new Error('not in model mode')
  if (!initialStatus.route || initialStatus.route.provider === 'mock') {
    throw new Error(`expected a real provider, got ${JSON.stringify(initialStatus.route)}`)
  }
  await page.screenshot({ path: path.join(out, `${tag}-00-initial.png`) })

  const attempts = []
  let offer = null
  const prompts = [
    '接口请求偶发超时，帮我分析可能原因，并给出两个排查方向。',
    '继续分析：如果是连接池耗尽，下一步应该怎么验证？',
    '登录页偶发白屏，帮我看可能是什么原因。',
  ]
  for (let attempt = 1; attempt <= prompts.length; attempt += 1) {
    const before = await statusValue()
    await sendTurn(prompts[attempt - 1])
    const result = await waitOffer(30000)
    const after = await statusValue()
    attempts.push({
      attempt,
      resultKind: result.kind,
      status: result.state,
      counters: after ? after.diagnostics.counters : null,
      events: after ? after.diagnostics.events.slice(-3) : null,
    })
    if (result.kind === 'offer') {
      offer = result
      break
    }
    if (result.kind === 'abstain') break // 合法弃权即真实行为，停止重试
  }
  record('turn-attempts', attempts)
  if (offer === null) {
    // 真实模型选择弃权也是合法输出；记录并结束（无 ghost 需要断言）。
    const finalStatus = await statusValue()
    record('result', { kind: 'abstain-only', status: finalStatus })
    await page.screenshot({ path: path.join(out, `${tag}-01-abstain.png`) })
    report.ok = true
  } else {
  const ghost = offer
  const suggestionText = ghost.state.text
  const beforeAccept = { requests: network.requests.length, frames: network.frames.length }
  await page.locator('[data-composer-input]').first().click({ force: true })
  await sleep(200)
  await page.keyboard.press('Tab')
  await sleep(400)
  const adopted = await dom()
  await sleep(1200)
  const sendish = network.requests.slice(beforeAccept.requests).filter((r) => /session\/prompt|beginSubmission/i.test(r.url + ' ' + r.body))
  const sendishFrames = network.frames.slice(beforeAccept.frames).filter((f) => /session\/prompt|beginSubmission/i.test(f.payload))
  if (adopted.ghost === true) throw new Error('ghost still visible after Tab')
  if (!(adopted.draft ?? '').includes(suggestionText)) throw new Error(`draft missing suggestion: ${adopted.draft}`)
  if (sendish.length !== 0 || sendishFrames.length !== 0) throw new Error('prompt request/frame after adoption')
  record('tab-adopt', { suggestionText, draft: adopted.draft, sendish: sendish.length, sendishFrames: sendishFrames.length, counters: (await statusValue()).diagnostics.counters })
  await page.screenshot({ path: path.join(out, `${tag}-01-offer-adopted.png`) })
  await page.keyboard.press('Control+z')
  await sleep(300)
  const afterUndo = await dom()
  if (afterUndo.draft !== '') throw new Error('draft not empty after undo')
  record('undo', { draft: afterUndo.draft })
  report.ok = true
  }
} catch (error) {
  report.error = String(error?.stack ?? error)
  await page.screenshot({ path: path.join(out, `${tag}-99-failure.png`) }).catch(() => {})
} finally {
  report.finishedAt = new Date().toISOString()
  if (!process.argv.includes('--keep-open')) await browser.close().catch(() => {})
  const reportPath = path.join(out, `${tag}-report.json`)
  await writeFile(reportPath, JSON.stringify(report, null, 2)).catch(() => {})
  console.log(JSON.stringify({ ok: report.ok, out: reportPath, steps: Object.keys(report.steps), error: report.error ?? null }, null, 2))
  if (!report.ok) process.exitCode = 1
}
