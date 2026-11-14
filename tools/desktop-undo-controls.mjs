#!/usr/bin/env node
// Compare native typing and focused Tab adoption on a disposable Desktop.
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { loadPlaywright } from './lib/local-env.mjs'
const args = process.argv.slice(2)
const arg = (key) => { const i = args.indexOf(key); return i < 0 ? '' : args[i + 1] ?? '' }
const cdp = arg('--cdp'), out = arg('--out')
if (!cdp || !out || !args.includes('--isolated-desktop') || new URL(cdp).hostname !== '127.0.0.1') throw new Error('Specify loopback --cdp, --out and --isolated-desktop')
await mkdir(out, { recursive: true })
const browser = await loadPlaywright().module.chromium.connectOverCDP(cdp)
const report = { layer: 'native Electron, Playwright CDP input', checks: [], error: null }
const check = (name, condition) => { report.checks.push({ name, pass: Boolean(condition) }); assert.ok(condition, name) }
try {
  const page = browser.contexts().flatMap((context) => context.pages()).find((item) => item.url().startsWith('dsh-app:'))
  assert.ok(page)
  await page.waitForFunction(() => window.__nextMessagePredictor?.state()?.session?.available)
  check('isolated mock selected', await page.getByRole('button', { name: /Select model, current Mock 1|选择模型.*Mock 1/i }).count() > 0)
  const input = page.locator('[data-composer-input]').first()
  const sendTurn = async () => {
    const previousTurn = await page.evaluate(() => window.__nextMessagePredictor.state().env?.turnId ?? '')
    await input.click()
    await page.keyboard.press('Control+a')
    await page.keyboard.type('Reply for undo control')
    await page.keyboard.press('Enter')
    await page.waitForFunction((previous) => {
      const state = window.__nextMessagePredictor.state()
      return state.env?.turnId !== previous && state.assist.status === 'offered' && state.assist.turnId === state.env.turnId
    }, previousTurn, { timeout: 30000 })
  }
  await sendTurn()
  check('new turn auto predicts', await page.locator('[data-nmp-ghost]').isVisible())
  await input.click()
  await page.keyboard.type('typed control')
  const typed = await input.textContent()
  await page.keyboard.press('Control+z')
  await page.waitForTimeout(300)
  const afterUndo = await input.textContent()
  report.typingLengths = { before: typed.length, after: afterUndo.length }
  check('ordinary typing after send is changed by undo', afterUndo.length < typed.length)
  await sendTurn()
  await input.click()
  const offer = await page.evaluate(() => window.__nextMessagePredictor.state().assist.text)
  await page.keyboard.press('Tab')
  await page.waitForFunction((text) => document.querySelector('[data-composer-input]')?.textContent === text, offer)
  check('focused Tab inserts exact suggestion', (await input.textContent()) === offer && offer.length > 0)
  await page.keyboard.press('Control+z')
  await page.waitForTimeout(300)
  check('focused Tab insertion can be undone', (await input.textContent()).trim() === '')
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error)
  process.exitCode = 1
} finally {
  await writeFile(join(out, 'desktop-undo-controls.json'), JSON.stringify(report, null, 2))
  await browser.close()
}
