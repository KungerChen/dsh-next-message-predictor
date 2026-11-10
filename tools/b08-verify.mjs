#!/usr/bin/env node
/**
 * B08 专项验证（scratch profile）：
 * 长建议（约 200 字）不再整条隐藏，而是两行省略显示；Tab 仍把完整建议写入草稿；
 * 不产生任何 prompt 请求/发送。
 */
import { browserPath, loadChromium, repoRoot } from './lib/local-env.mjs'
import { mkdir, writeFile } from 'node:fs/promises'
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
if (url === '') throw new Error('--url is required')
await mkdir(outDir, { recursive: true })
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const LONG = `这是一条很长的固定测试建议，用来验证超过两行时不再整条隐藏。${'请把这句话完整保留下来，不要只显示开头。'.repeat(8)}`

const browser = await chromium.launch({ executablePath: browserPath(), headless: true })
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
const page = await context.newPage()
page.setDefaultTimeout(60000)
const report = { ok: false, url, longGraphemes: Array.from(LONG).length, steps: {} }

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
    if (await page.evaluate(() => Boolean(document.querySelector('[data-composer-input]')?.isContentEditable))) return
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
      const s = window.__nextMessagePredictor?.state()
      return s ? { status: s.assist.status, text: s.assist.text, suggestionId: s.assist.suggestionId, env: s.env ? { running: s.env.running, turnId: s.env.turnId, draft: s.env.draft } : null } : null
    } catch {
      return null
    }
  })
const dom = () =>
  page.evaluate(() => {
    const input = document.querySelector('[data-composer-input]')
    const ghost = document.querySelector('[data-nmp-ghost]')
    const ghostVisible = ghost !== null && ghost.getBoundingClientRect().width > 0 && getComputedStyle(ghost).visibility !== 'hidden'
    return { draft: input ? input.textContent : null, ghost: ghost !== null, ghostVisible, ghostText: ghost ? ghost.textContent : null }
  })
async function sendTurn(text) {
  await ensureComposer()
  const input = page.locator('[data-composer-input]').first()
  await input.click({ force: true })
  await sleep(200)
  await page.keyboard.press('Control+A')
  await page.keyboard.press('Delete')
  await sleep(100)
  const before = await state()
  const turnBefore = before?.env?.turnId ?? ''
  await page.keyboard.type(text, { delay: 10 })
  if ((await page.evaluate(() => document.querySelector('[data-composer-input]')?.textContent ?? '')) === '') {
    await input.click({ force: true })
    await page.keyboard.type(text, { delay: 10 })
  }
  await page.keyboard.press('Enter')
  for (let i = 0; i < 150; i += 1) {
    if ((await state())?.env?.running === true) break
    await sleep(100)
  }
  for (let i = 0; i < 400; i += 1) {
    const s = await state()
    if (s?.env?.running === false && s.env.turnId !== turnBefore && s.env.turnId !== '') return s
    await sleep(100)
  }
  throw new Error('turn did not finish')
}

try {
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => Boolean(window.__nextMessagePredictor), undefined, { timeout: 30000 })
  await ensureComposer()
  await sendTurn('请只回复：收到')
  for (let i = 0; i < 300; i += 1) {
    const s = await state()
    if (s?.status === 'offered') break
    await sleep(100)
  }
  const injected = await page.evaluate((text) => {
    const api = window.__nextMessagePredictor
    return api.suggest(text)
  }, LONG)
  assertTrue(injected === true, 'debug suggest accepted')
  const deadline = Date.now() + 20000
  let view = null
  while (Date.now() < deadline) {
    const s = await state()
    const d = await dom()
    view = { s, d }
    if (s?.status === 'offered' && s.text === LONG && d.ghost === true && d.ghostVisible) break
    await sleep(100)
  }
  assertTrue(view?.s?.text === LONG, 'long suggestion is active')
  assertTrue(view?.d?.ghostVisible === true, 'long suggestion is visible instead of hidden')
  assertTrue((view?.d?.ghostText ?? '').includes('请把这句话完整保留下来'), 'ghost displays the suggestion text')
  await page.screenshot({ path: path.join(outDir, 'b08-01-long-ghost.png') })
  report.steps.ghost = { visible: view.d.ghostVisible, textLength: (view.d.ghostText ?? '').length }
  const beforeRequests = []
  page.on('request', (request) => {
    if (/session\/prompt/.test(request.url())) beforeRequests.push(request.url())
  })
  await page.locator('[data-composer-input]').first().click({ force: true })
  await sleep(200)
  await page.keyboard.press('Tab')
  await sleep(400)
  const adopted = await dom()
  const after = await state()
  assertTrue(adopted.ghost === false, 'ghost disappears after adoption')
  assertTrue(adopted.draft === LONG, 'Tab inserts the complete suggestion')
  assertTrue(beforeRequests.length === 0, 'no prompt request was made')
  await page.screenshot({ path: path.join(outDir, 'b08-02-long-adopted.png') })
  report.steps.adopted = { draftLength: (adopted.draft ?? '').length, promptRequests: beforeRequests.length, status: after?.status }
  report.ok = true
} catch (error) {
  report.error = String(error?.stack ?? error)
  await page.screenshot({ path: path.join(outDir, 'b08-99-failure.png') }).catch(() => {})
} finally {
  await browser.close().catch(() => {})
  const reportPath = path.join(outDir, 'b08-verify-report.json')
  await writeFile(reportPath, JSON.stringify(report, null, 2), 'utf8')
  console.log(JSON.stringify({ ok: report.ok, out: reportPath, steps: report.steps, error: report.error ?? null }, null, 2))
  if (!report.ok) process.exitCode = 1
}

function assertTrue(value, message) {
  if (!value) throw new Error(`assertion failed: ${message}`)
}
