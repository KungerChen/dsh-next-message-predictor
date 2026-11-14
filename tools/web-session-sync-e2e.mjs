#!/usr/bin/env node
// Two independent browser windows, one disposable Web Host; never use a daily profile.
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { browserPath, loadChromium } from './lib/local-env.mjs'
const args = process.argv.slice(2), arg = (key) => { const i = args.indexOf(key); return i < 0 ? '' : args[i + 1] ?? '' }
const urlFile = arg('--url-file'), out = arg('--out'), mockLog = arg('--mock-log')
if (!urlFile || !out || !mockLog || !args.includes('--isolated-web')) throw new Error('Specify --url-file, --mock-log, --out and --isolated-web for a disposable Host')
const address = (await readFile(urlFile, 'utf8')).replace(/^\uFEFF/, '').trim()
const url = new URL(address)
if (url.hostname !== '127.0.0.1' || url.protocol !== 'http:') throw new Error('Web Host must be loopback HTTP')
await mkdir(out, { recursive: true })
const headless = args.includes('--headless')
const browser = await loadChromium().launch({ executablePath: browserPath(), headless })
const report = { layer: `two independent ${headless ? 'headless ' : ''}pages in one authenticated browser context, isolated Web Host`, checks: [], error: null }
const check = (name, condition) => { report.checks.push({ name, pass: Boolean(condition) }); assert.ok(condition, name) }
try {
  const context = await browser.newContext()
  const a = await context.newPage(), b = await context.newPage()
  await a.goto(address)
  await a.waitForFunction(() => Boolean(window.__nextMessagePredictor))
  const continueButton = a.getByRole('button', { name: /继续|Continue|知道了|OK/ }).first()
  if (await continueButton.count()) await continueButton.click().catch(() => {})
  await a.waitForTimeout(1000)
  const input = a.locator('[data-composer-input]').first()
  if (await input.getAttribute('contenteditable') !== 'true') {
    await input.click({ force: true })
    const option = a.locator('[role="presentation"] button').first()
    await option.waitFor({ state: 'visible' })
    await option.click({ force: true })
  }
  await a.waitForFunction(() => document.querySelector('[data-composer-input]')?.isContentEditable === true)
  const saved = await a.evaluate(async () => {
    const r = await fetch('/api/next-message-predictor/rpc', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ schemaVersion: 1, operation: 'config.set', patch: { enabled: true, modelMode: 'session', requireInputFocus: false, fakeSuggestion: '' } }) })
    return (await r.json()).ok
  })
  check('configuration saved on isolated Host', saved)
  await a.waitForTimeout(1000)
  await a.evaluate(() => window.__nextMessagePredictor.reloadConfig())
  await a.waitForTimeout(1000)
  await input.click()
  await a.keyboard.type('Reply for isolated two-window test')
  await a.keyboard.press('Enter')
  await a.waitForFunction(() => window.__nextMessagePredictor.state().assist.status === 'offered', undefined, { timeout: 30000 })
  const session = await a.evaluate(() => window.__nextMessagePredictor.state().env.sessionId)
  const requestCount = ((await readFile(mockLog, 'utf8')).match(/\[mock-llm\] predictor-request /g) ?? []).length
  check('first window got an offer from mock', requestCount > 0)
  await b.goto(a.url())
  await b.screenshot({ path: join(out, 'second-window-initial.png') })
  await b.waitForFunction(() => Boolean(window.__nextMessagePredictor))
  await b.waitForFunction((expected) => window.__nextMessagePredictor.state().env?.sessionId === expected, session, { timeout: 15000 })
  check('both windows show the same synthetic session', true)
  await b.bringToFront()
  await b.waitForFunction(() => window.__nextMessagePredictor.state().session.available)
  await b.locator('[data-nmp-session-toggle]').click()
  await b.waitForFunction(() => window.__nextMessagePredictor.state().session.paused)
  await a.bringToFront()
  await a.waitForFunction(() => window.__nextMessagePredictor.state().session.paused, undefined, { timeout: 3000 })
  check('pause propagates to the other window', true)
  check('other window withdraws offer', await a.locator('[data-nmp-ghost]').count() === 0)
  await a.locator('[data-nmp-session-toggle]').click()
  await a.waitForFunction(() => !window.__nextMessagePredictor.state().session.paused)
  await b.bringToFront()
  await b.waitForFunction(() => !window.__nextMessagePredictor.state().session.paused, undefined, { timeout: 3000 })
  check('resume propagates to the other window', true)
  const currentPredictCount = async () => ((await readFile(mockLog, 'utf8')).match(/\[mock-llm\] predictor-request /g) ?? []).length
  const sharedOffer = async () => {
    await a.bringToFront()
    const before = await a.evaluate(() => window.__nextMessagePredictor.state().env?.turnId)
    const calls = await currentPredictCount()
    await input.click()
    await a.keyboard.type('Reply for shared candidate')
    await a.keyboard.press('Enter')
    await a.waitForFunction((old) => {
      const state = window.__nextMessagePredictor.state()
      return state.env?.turnId !== old && state.assist.status === 'offered' && state.assist.turnId === state.env.turnId
    }, before, { timeout: 30000 })
    const offer = await a.evaluate(() => ({ id: window.__nextMessagePredictor.state().assist.suggestionId, turn: window.__nextMessagePredictor.state().env.turnId }))
    await b.bringToFront()
    await b.waitForFunction((turn) => window.__nextMessagePredictor.state().env?.turnId === turn && window.__nextMessagePredictor.state().session.available, offer.turn, { timeout: 10000 })
    await b.locator('[data-composer-input]').click()
    if (!await b.evaluate((turn) => { const state = window.__nextMessagePredictor.state(); return state.assist.status === 'offered' && state.assist.turnId === turn }, offer.turn)) {
      await b.keyboard.press('Alt+Backslash')
    }
    await b.waitForFunction((turn) => { const state = window.__nextMessagePredictor.state(); return state.assist.status === 'offered' && state.assist.turnId === turn }, offer.turn, { timeout: 10000 })
    check('both pages have an offer for the same turn', await b.evaluate((turn) => window.__nextMessagePredictor.state().assist.turnId === turn, offer.turn))
    report.predictionCallsForTurns ??= []
    report.predictionCallsForTurns.push((await currentPredictCount()) - calls)
  }
  await sharedOffer()
  await a.bringToFront()
  await input.click()
  await a.keyboard.press('Tab')
  await b.bringToFront()
  await b.waitForFunction(() => window.__nextMessagePredictor.state().session.terminal === 'accepted', undefined, { timeout: 5000 })
  check('acceptance reaches other page and withdraws old offer', await b.locator('[data-nmp-ghost]').count() === 0)
  await a.bringToFront()
  await input.click()
  await a.keyboard.press('Control+a')
  await a.keyboard.press('Backspace')
  await sharedOffer()
  await a.bringToFront()
  await input.click()
  await a.keyboard.press('Escape')
  await b.bringToFront()
  await b.waitForFunction(() => window.__nextMessagePredictor.state().session.terminal === 'dismissed', undefined, { timeout: 5000 })
  check('dismissal reaches other page and withdraws old offer', await b.locator('[data-nmp-ghost]').count() === 0)
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error)
  process.exitCode = 1
} finally {
  await writeFile(join(out, 'web-session-sync.json'), JSON.stringify(report, null, 2))
  await browser.close()
}
