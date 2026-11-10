#!/usr/bin/env node
/** 诊断探针：完成一个 mock 回合后打印 state/legacy/dom 结构（不含消息正文）。 */
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
const out = argOf('--out', path.join(repoRoot, 'scratch', 'evidence'))
const text = argOf('--text', '请回复：收到')
if (!url) throw new Error('--url is required')
await mkdir(out, { recursive: true })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const browser = await chromium.launch({
  executablePath: browserPath(),
  headless: true,
  args: ['--disable-gpu', '--no-first-run'],
})
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
const page = await context.newPage()
page.setDefaultTimeout(30000)
page.on('console', (m) => {
  const t = m.text()
  if (t.includes('predictor')) console.log('[console]', m.type(), t.slice(0, 300))
})
page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 500)))

const state = () =>
  page.evaluate(() => {
    try {
      const api = window.__nextMessagePredictor
      if (!api) return { present: false }
      return { present: true, state: api.state(), legacy: api.legacy ? api.legacy() : 'no-legacy-api' }
    } catch (e) {
      return { present: true, error: String(e) }
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
      ghost: ghost ? ghost.textContent : null,
      anchor: Boolean(document.querySelector('[data-nmp-anchor]')),
    }
  })

try {
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => Boolean(globalThis.__DSH_BOOT__) || Boolean(document.querySelector('[data-composer-input]')), undefined, { timeout: 30000 })
  // 关闭欢迎弹窗
  const dialogs = page.locator('[role="dialog"]')
  for (let i = 0; i < (await dialogs.count()); i += 1) {
    const d = dialogs.nth(i)
    if (/预览版说明/.test(await d.innerText().catch(() => ''))) {
      const b = d.locator('button', { hasText: /继续/ }).first()
      if (await b.count()) {
        await b.click({ force: true })
        await sleep(600)
        break
      }
    }
  }
  // 确保 composer 可编辑
  for (let i = 0; i < 10; i += 1) {
    const d = await dom()
    if (d.input && d.editable) break
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
  await page.locator('[data-composer-input]').first().click({ force: true })
  await sleep(300)
  console.log('=== before send ===')
  console.log(JSON.stringify({ state: await state(), dom: await dom() }, null, 2))
  await page.keyboard.type(text, { delay: 8 })
  await page.keyboard.press('Enter')
  let sawRunning = false
  for (let i = 0; i < 100; i += 1) {
    const s = await state()
    if (s.state && s.state.env && s.state.env.running === true) {
      sawRunning = true
      break
    }
    await sleep(100)
  }
  console.log('sawRunning:', sawRunning)
  let last = null
  for (let i = 0; i < 200; i += 1) {
    last = await state()
    if (last.state && last.state.env && last.state.env.running === false && i > 3) break
    await sleep(100)
  }
  await sleep(500)
  const finalState = await state()
  const finalDom = await dom()
  await page.screenshot({ path: path.join(out, 'debug-probe-after-turn.png') })
  const result = { sawRunning, last, finalState, finalDom }
  await writeFile(path.join(out, 'debug-probe.json'), JSON.stringify(result, null, 2))
  console.log('=== after turn ===')
  console.log(JSON.stringify(result, null, 2))
} finally {
  await browser.close()
}
