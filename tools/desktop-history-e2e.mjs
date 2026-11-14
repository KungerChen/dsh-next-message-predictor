#!/usr/bin/env node
// Preserve pre-existing user history when adopting in a disposable Desktop.
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { loadPlaywright } from './lib/local-env.mjs'
const args = process.argv.slice(2), arg = (key) => { const i = args.indexOf(key); return i < 0 ? '' : args[i + 1] ?? '' }
const cdp = arg('--cdp'), out = arg('--out')
if (!cdp || !out || !args.includes('--isolated-desktop') || new URL(cdp).hostname !== '127.0.0.1') throw new Error('Use isolated loopback Desktop')
await mkdir(out, { recursive: true })
const browser = await loadPlaywright().module.chromium.connectOverCDP(cdp)
const report = { layer: 'native Electron, CDP input', checks: [], error: null }
const check = (name, condition) => { report.checks.push({ name, pass: Boolean(condition) }); assert.ok(condition, name) }
try {
  const page = browser.contexts().flatMap((context) => context.pages()).find((item) => item.url().startsWith('dsh-app:'))
  assert.ok(page)
  await page.bringToFront()
  await page.waitForFunction(() => window.__nextMessagePredictor?.state()?.session?.available)
  const saved = await page.evaluate(async () => {
    const r = await fetch('/api/next-message-predictor/rpc', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ schemaVersion: 1, operation: 'config.set', patch: { requireInputFocus: false } }) })
    return (await r.json()).ok
  })
  check('configuration saved', saved)
  await page.waitForTimeout(1000)
  await page.evaluate(() => window.__nextMessagePredictor.reloadConfig())
  await page.waitForFunction(() => window.__nextMessagePredictor.state().session.available)
  const input = page.locator('[data-composer-input]').first()
  const previousTurn = await page.evaluate(() => window.__nextMessagePredictor.state().env?.turnId ?? '')
  await input.click()
  await page.keyboard.press('Control+a')
  await page.keyboard.type('Reply for history baseline')
  await page.keyboard.press('Enter')
  await page.waitForFunction((old) => { const state = window.__nextMessagePredictor.state(); return state.env?.turnId !== old && state.assist.status === 'offered' && state.assist.turnId === state.env.turnId }, previousTurn, { timeout: 30000 })
  await input.click()
  await page.keyboard.press('Control+a')
  await page.keyboard.press('Backspace')
  await page.keyboard.type('history-control', { delay: 25 })
  await page.waitForTimeout(500)
  await page.keyboard.press('Control+a')
  await page.keyboard.press('Backspace')
  check('user draft was cleared', await input.textContent() === '')
  await page.keyboard.press('Control+z')
  await page.waitForTimeout(200)
  check('prior deletion is independently undoable', await input.textContent() === 'history-control')
  await page.keyboard.press('Control+Shift+z')
  await page.waitForTimeout(200)
  check('prior deletion is independently redoable', await input.textContent() === '')
  const predicted = await page.evaluate(() => window.__nextMessagePredictor.predictNow())
  check('manual prediction requested', predicted.ok === true)
  await page.waitForFunction(() => window.__nextMessagePredictor.state().assist.status === 'offered', undefined, { timeout: 30000 })
  const offer = await page.evaluate(() => window.__nextMessagePredictor.state().assist.text)
  await input.evaluate((node) => node.blur())
  await input.click()
  await page.locator('[data-nmp-adopt]').click()
  await page.waitForFunction((text) => document.querySelector('[data-composer-input]')?.textContent === text, offer)
  check('suggestion inserted exactly', await input.textContent() === offer && offer.length > 0)
  await page.keyboard.press('Control+z')
  await page.waitForTimeout(200)
  check('first undo removes suggestion', await input.textContent() === '')
  await page.keyboard.press('Control+z')
  await page.waitForTimeout(200)
  check('second undo restores previous draft without extra history step', await input.textContent() === 'history-control')
  await page.keyboard.press('Control+Shift+z')
  await page.waitForTimeout(200)
  check('first redo restores cleared state', await input.textContent() === '')
  await page.keyboard.press('Control+Shift+z')
  await page.waitForTimeout(200)
  check('second redo restores suggestion', await input.textContent() === offer)
} catch (error) { report.error = error instanceof Error ? error.message : String(error); process.exitCode = 1 }
finally { await writeFile(join(out, 'desktop-history.json'), JSON.stringify(report, null, 2)); await browser.close() }
