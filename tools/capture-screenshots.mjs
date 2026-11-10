#!/usr/bin/env node
/**
 * Capture the README images from a running, isolated DSH Web GUI.
 *
 * Everything on screen is produced for the capture: the conversation is one
 * scripted turn answered by the local mock model (tools/mock-llm.mjs), and the
 * suggestions are the mock's scripted candidates. Only regions that belong to
 * this plugin or to that conversation are captured; the session list in the
 * sidebar is never part of an image.
 *
 * Output (default docs/images/):
 *   demo.png            animated PNG: suggestion appears -> another one -> Tab fills it in
 *   suggestion.png      the conversation with a suggestion in the empty input box
 *   modes.png           the "mode" card of the settings page
 *   sidebar-entry.png   the entry in the left sidebar
 *   page-header.png     the top of the settings page: title, version, sidebar button, basics
 *   settings.png        the whole settings page
 *
 * Usage (scratch profile and mock model already running, see docs/DEVELOPMENT.md):
 *   node tools/capture-screenshots.mjs --url "<scratch URL>" [--out docs/images] [--mock http://127.0.0.1:3091]
 *                                      [--frames <dir>]   also write the animation frames one by one
 *
 * The plugin config of the scratch profile and the mock's replies are put back
 * afterwards. The scripted conversation stays in the session list.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { crc32 } from 'node:zlib'

import { browserPath, loadChromium, repoRoot } from './lib/local-env.mjs'
import { PRESETS, RECOMMENDED_ROUTE } from '../src/shared/presets.js'

const args = process.argv.slice(2)
const argOf = (name, fallback) => {
  const i = args.indexOf(name)
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback
}
const url = argOf('--url', '')
if (url === '') {
  console.error('--url is required (the scratch Web GUI URL, including its token)')
  process.exit(2)
}
const outDir = path.resolve(argOf('--out', path.join(repoRoot, 'docs', 'images')))
const mockBase = argOf('--mock', 'http://127.0.0.1:3091')
/** Optional: also write the animation's frames as separate files, to look at them one by one. */
const framesDir = argOf('--frames', '')
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// ── the scripted conversation ───────────────────────────────────────────────
// Turn 1 is typed; its suggestion is accepted with Tab and sent, which makes it
// the user message of turn 2. The images show turn 2.
const OPENING_MESSAGE = '先看一下登录页现在的表单是怎么写的'
const OPENING_REPLY = '登录表单在 src/components/LoginForm.tsx：两个输入框加一个提交按钮，目前没有任何校验，空表单也能提交。'
const USER_MESSAGE = '给登录表单加上校验：邮箱格式和密码长度'
const ASSISTANT_REPLY =
  '已在 LoginForm 里加上校验：邮箱用正则检查格式，密码要求至少 8 位，不通过时在输入框下方给出提示。改动在 src/components/LoginForm.tsx，还没有运行测试。'
const SUGGESTIONS = ['跑一下测试，确认没有回归', '把改动的代码给我看一下', '再补上对应的单元测试']

const VIEWPORT = { width: 1280, height: 820 }
/** Short window for the conversation shots, so the chat reaches down to the input box. */
const CHAT_VIEWPORT = { width: 1280, height: 600 }

async function mockControl(patch) {
  const response = await fetch(`${mockBase}/control`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) })
  if (!response.ok) throw new Error(`mock control failed: HTTP ${response.status}`)
}

/**
 * Join PNG frames of identical size into one animated PNG (APNG).
 * A viewer without APNG support shows the first frame.
 * @param {Buffer[]} frames
 * @param {number[]} delaysMs - how long each frame stays on screen.
 */
function buildApng(frames, delaysMs) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const chunk = (type, data) => {
    const head = Buffer.alloc(8)
    head.writeUInt32BE(data.length, 0)
    head.write(type, 4, 'latin1')
    const tail = Buffer.alloc(4)
    tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0)
    return Buffer.concat([head, data, tail])
  }
  const parse = (png) => {
    if (!png.subarray(0, 8).equals(signature)) throw new Error('not a PNG')
    let ihdr
    const idat = []
    for (let offset = 8; offset < png.length; ) {
      const length = png.readUInt32BE(offset)
      const type = png.toString('latin1', offset + 4, offset + 8)
      const data = png.subarray(offset + 8, offset + 8 + length)
      if (type === 'IHDR') ihdr = Buffer.from(data)
      else if (type === 'IDAT') idat.push(data)
      offset += 12 + length
    }
    return { ihdr, data: Buffer.concat(idat) }
  }
  const parsed = frames.map(parse)
  const first = parsed[0]
  for (const frame of parsed) {
    if (!frame.ihdr.equals(first.ihdr)) throw new Error('frames differ in size or pixel format')
  }
  const width = first.ihdr.readUInt32BE(0)
  const height = first.ihdr.readUInt32BE(4)
  const animation = Buffer.alloc(8)
  animation.writeUInt32BE(frames.length, 0)
  animation.writeUInt32BE(0, 4) // loop forever
  const parts = [signature, chunk('IHDR', first.ihdr), chunk('acTL', animation)]
  let sequence = 0
  parsed.forEach((frame, index) => {
    const control = Buffer.alloc(26)
    control.writeUInt32BE(sequence++, 0)
    control.writeUInt32BE(width, 4)
    control.writeUInt32BE(height, 8)
    control.writeUInt16BE(Math.round(delaysMs[index] ?? 1000), 20) // delay numerator
    control.writeUInt16BE(1000, 22) // delay denominator: milliseconds
    parts.push(chunk('fcTL', control))
    if (index === 0) parts.push(chunk('IDAT', frame.data))
    else {
      const head = Buffer.alloc(4)
      head.writeUInt32BE(sequence++, 0)
      parts.push(chunk('fdAT', Buffer.concat([head, frame.data])))
    }
  })
  parts.push(chunk('IEND', Buffer.alloc(0)))
  return Buffer.concat(parts)
}

await mkdir(outDir, { recursive: true })
const browser = await loadChromium().launch({ executablePath: browserPath(), headless: true, args: ['--disable-gpu', '--no-first-run', '--no-default-browser-check'] })
const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 2, locale: 'zh-CN' })
const page = await context.newPage()
page.setDefaultTimeout(30000)

const rpc = (body) =>
  page.evaluate(async (payload) => {
    const response = await fetch('/api/next-message-predictor/rpc', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) })
    return response.json()
  }, body)
const assist = () => page.evaluate(() => window.__nextMessagePredictor.state().assist)
const setConfig = async (patch) => {
  const result = await rpc({ schemaVersion: 1, operation: 'config.set', patch })
  if (result.ok !== true) throw new Error(`config.set failed: ${JSON.stringify(result.error)}`)
  // The write restarts the Host half of the plugin; wait for it to answer again.
  await sleep(1500)
  await page.evaluate(() => window.__nextMessagePredictor.reloadConfig())
  await sleep(800)
}

async function dismissDialogs() {
  for (let i = 0; i < 6; i += 1) {
    const button = page.locator('[role="dialog"] button', { hasText: /继续|Continue/ })
    if ((await button.count()) === 0) return
    await button.first().click({ force: true }).catch(() => {})
    await sleep(600)
  }
}
async function ensureComposer() {
  for (let i = 0; i < 12; i += 1) {
    await dismissDialogs()
    const ready = await page.evaluate(() => document.querySelector('[data-composer-input]')?.isContentEditable === true)
    if (ready) return
    const picker = page.locator('[role="textbox"][contenteditable="false"]').first()
    if (await picker.count()) {
      await picker.click({ force: true }).catch(() => {})
      await sleep(700)
      const options = page.locator('[role="presentation"] button')
      if (await options.count()) await options.first().click({ force: true }).catch(() => {})
      await sleep(900)
    }
    await sleep(300)
  }
  throw new Error('the composer is not ready')
}
async function waitFor(describe, predicate, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await sleep(120)
  }
  throw new Error(`timed out waiting for ${describe}`)
}
const ghostShows = (text) => async () => {
  const state = await assist()
  const visible = await page.evaluate(() => (document.querySelector('[data-nmp-ghost]')?.getBoundingClientRect().width ?? 0) > 0)
  return visible && state.status === 'offered' && (text === undefined || state.text === text)
}

/** The last exchange plus the input box: from the last user message down to the composer. */
async function exchangeClip() {
  return page.evaluate((message) => {
    const card = document.querySelector('[data-composer-card]').getBoundingClientRect()
    const bubbles = [...document.querySelectorAll('*')].filter(
      (element) => element.children.length === 0 && element.textContent.trim() === message && !element.closest('[data-composer-card]'),
    )
    const last = bubbles.at(-1)
    const margin = 28
    const top = Math.max(0, (last ? last.getBoundingClientRect().top : card.top - 260) - 26)
    // Stop right under the input box: the status line below it is not part of the story.
    return { x: Math.max(0, card.left - margin), y: top, width: card.width + margin * 2, height: Math.min(window.innerHeight, card.bottom + 8) - top }
  }, USER_MESSAGE)
}
/** Wait until the assistant has answered the message just sent. */
async function turnFinished(previousTurnId) {
  await waitFor('the reply', async () => {
    const env = await page.evaluate(() => window.__nextMessagePredictor.state().env)
    return env !== null && env.running === false && env.hasFinalText === true && env.turnId !== '' && env.turnId !== previousTurnId
  }, 60000)
}
const currentTurnId = () => page.evaluate(() => window.__nextMessagePredictor.state().env?.turnId ?? '')

let originalConfig = null
try {
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => Boolean(window.__nextMessagePredictor), undefined, { timeout: 30000 })
  await ensureComposer()
  await page.evaluate(() => window.__nextMessagePredictor.reloadConfig())
  originalConfig = await page.evaluate(() => ({ ...window.__nextMessagePredictor.config().config }))

  // Follow the session model (the mock), predict automatically, three candidates on request.
  await setConfig({
    enabled: true, manualOnly: false, showPredictButton: true, modelMode: 'session', reasoningEffort: '',
    multiCandidates: true, candidateCount: 3, manualLimit: 3, habitSuggestions: false, sidebarEntry: true, triggerDelayMs: 250,
  })
  // The scratch profile also loads a marker plugin used by the load test; it is not part of DSH or of this plugin.
  await page.addStyleTag({ content: '[data-testid="predictor-hello-marker"] { display: none !important; }' })
  await page.setViewportSize(CHAT_VIEWPORT)

  // ── turn 1: typed; its suggestion is accepted and sent ──
  await mockControl({ reply: OPENING_REPLY, predictMode: 'json', predictReply: JSON.stringify({ suggestion: USER_MESSAGE }) })
  await ensureComposer()
  await page.locator('[data-composer-input]').first().click({ force: true })
  let turnBefore = await currentTurnId()
  await page.keyboard.type(OPENING_MESSAGE, { delay: 6 })
  await page.keyboard.press('Enter')
  await turnFinished(turnBefore)
  await waitFor('the first suggestion', ghostShows(USER_MESSAGE), 45000)
  await sleep(600)
  await mockControl({ reply: ASSISTANT_REPLY, predictReply: JSON.stringify({ suggestions: SUGGESTIONS }) })
  turnBefore = await currentTurnId()
  await page.keyboard.press('Tab')
  await waitFor('the accepted draft', async () => (await page.evaluate(() => document.querySelector('[data-composer-input]').textContent)).includes(USER_MESSAGE))
  await sleep(300)
  await page.keyboard.press('Enter')

  // ── turn 2: the one in the images ──
  await turnFinished(turnBefore)
  await waitFor('the suggestion', ghostShows(SUGGESTIONS[0]), 45000)
  await sleep(700)

  const clip = await exchangeClip()
  const frames = []
  const delays = []
  const frame = async (delayMs) => {
    frames.push(await page.screenshot({ clip }))
    delays.push(delayMs)
  }
  await page.screenshot({ path: path.join(outDir, 'suggestion.png'), clip })
  await frame(2200)

  // "Another one": the first manual prediction brings three candidates, then stepping is local.
  await page.keyboard.press('Alt+Backslash')
  await waitFor('the candidates', async () => (await ghostShows(SUGGESTIONS[0])()) && (await assist()).candidates.length === 3, 30000)
  await page.keyboard.press('Alt+Backslash')
  await waitFor('candidate 2', ghostShows(SUGGESTIONS[1]))
  await sleep(250)
  await frame(1700)
  await page.keyboard.press('Alt+Backslash')
  await waitFor('candidate 3', ghostShows(SUGGESTIONS[2]))
  await sleep(250)
  await frame(1700)

  // Tab fills the suggestion in. Nothing is sent.
  await page.keyboard.press('Tab')
  await waitFor('the filled draft', async () => (await page.evaluate(() => document.querySelector('[data-composer-input]').textContent)).includes(SUGGESTIONS[2]))
  await sleep(350)
  await frame(2600)
  await writeFile(path.join(outDir, 'demo.png'), buildApng(frames, delays))
  if (framesDir !== '') {
    await mkdir(path.resolve(framesDir), { recursive: true })
    for (const [index, data] of frames.entries()) await writeFile(path.join(path.resolve(framesDir), `demo-frame-${index + 1}.png`), data)
  }

  // Leave the draft empty again.
  await page.keyboard.press('Control+A')
  await page.keyboard.press('Delete')

  // ── settings page, in the recommended mode ──
  await page.setViewportSize(VIEWPORT)
  await setConfig({ ...PRESETS.balanced, provider: RECOMMENDED_ROUTE.provider, model: RECOMMENDED_ROUTE.model, reasoningEffort: RECOMMENDED_ROUTE.reasoningEffort, habitSuggestions: true, sidebarEntry: true })
  await page.evaluate(() => window.__nextMessagePredictor.openPanel())
  await page.waitForSelector('[data-nmp-panel] [data-nmp-setting="presets"]')
  await sleep(600)

  // The entry in the left sidebar: the navigation rows only, never the session list below them.
  const entryClip = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('button[aria-current], button[aria-label]')].filter((button) => /panelRow/.test(button.className))
    const boxes = rows.map((row) => row.getBoundingClientRect())
    const right = Math.max(...boxes.map((box) => box.right))
    return { x: 0, y: 0, width: right + 12, height: Math.max(...boxes.map((box) => box.bottom)) + 8 }
  })
  await page.screenshot({ path: path.join(outDir, 'sidebar-entry.png'), clip: entryClip })

  // The top of the page it opens: title, version, the sidebar button and the basics card.
  const headerClip = await page.evaluate(() => {
    const header = document.querySelector('[data-nmp-panel] [data-nmp-setting="header"]').getBoundingClientRect()
    const basics = document.querySelector('[data-nmp-panel] [data-nmp-setting="keys"]').parentElement.getBoundingClientRect()
    const margin = 16
    return { x: header.left - margin, y: Math.max(0, header.top - margin), width: header.width + margin * 2, height: basics.bottom - Math.max(0, header.top - margin) + margin }
  })
  await page.screenshot({ path: path.join(outDir, 'page-header.png'), clip: headerClip })

  await page.locator('[data-nmp-panel] [data-nmp-setting="presets"]').screenshot({ path: path.join(outDir, 'modes.png') })

  // The whole page: make the window tall enough that nothing is scrolled away.
  const fullHeight = await page.evaluate(() => Math.ceil(document.querySelector('[data-nmp-panel] > div').getBoundingClientRect().height) + 120)
  await page.setViewportSize({ width: VIEWPORT.width, height: Math.max(VIEWPORT.height, fullHeight) })
  await sleep(500)
  await page.locator('[data-nmp-panel] > div').screenshot({ path: path.join(outDir, 'settings.png') })

  for (const name of ['demo.png', 'suggestion.png', 'sidebar-entry.png', 'page-header.png', 'modes.png', 'settings.png']) {
    const size = (await readFile(path.join(outDir, name))).length
    console.log(`${name}  ${(size / 1024).toFixed(0)} KB`)
  }
} finally {
  // Put the scratch profile and the mock back the way they were.
  try {
    if (originalConfig !== null) {
      const restore = {}
      for (const key of [
        'enabled', 'manualOnly', 'showPredictButton', 'modelMode', 'provider', 'model', 'reasoningEffort', 'multiCandidates', 'candidateCount',
        'manualLimit', 'habitSuggestions', 'sidebarEntry', 'triggerDelayMs', 'contextMessages', 'targetInputTokens', 'maxContextCodePoints',
        'maxOutputTokens', 'timeoutMs', 'dailyRequestLimit', 'dailyTokenBudget',
      ]) restore[key] = originalConfig[key]
      await rpc({ schemaVersion: 1, operation: 'config.set', patch: restore })
    }
    await mockControl({ reply: '收到（mock-1）', predictMode: 'json', predictReply: '{"suggestion":"继续第二项"}' })
  } catch (error) {
    console.error(`restore failed: ${error instanceof Error ? error.message : String(error)}`)
  }
  await browser.close()
}
