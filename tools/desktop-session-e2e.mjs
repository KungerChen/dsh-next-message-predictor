#!/usr/bin/env node
// Only for an explicitly isolated Desktop and local mock profile.
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { loadPlaywright } from './lib/local-env.mjs'
const args = process.argv.slice(2)
const arg = (key) => { const i = args.indexOf(key); return i < 0 ? '' : args[i + 1] ?? '' }
const cdp = arg('--cdp'), out = arg('--out')
if (!cdp || !out || !args.includes('--isolated-desktop')) throw new Error('Specify --cdp, --out and --isolated-desktop for a disposable Desktop')
const url = new URL(cdp)
if (url.hostname !== '127.0.0.1' || url.protocol !== 'http:') throw new Error('CDP must be loopback HTTP')
await mkdir(out, { recursive: true })
const browser = await loadPlaywright().module.chromium.connectOverCDP(cdp)
const report = { layer: 'native Electron, Playwright CDP input', checks: [], error: null }
const check = (name, condition) => { report.checks.push({ name, pass: Boolean(condition) }); assert.ok(condition, name) }
try {
  const page = browser.contexts().flatMap((context) => context.pages()).find((candidate) => candidate.url().startsWith('dsh-app:'))
  assert.ok(page, 'native desktop page')
  await page.waitForFunction(() => window.__nextMessagePredictor?.state()?.session?.available && document.querySelector('[data-nmp-session-toggle]'))
  check('isolated mock selected', await page.getByRole('button', { name: /Select model, current Mock 1|选择模型.*Mock 1/i }).count() > 0)
  const button = page.locator('[data-nmp-session-toggle]')
  check('session starts unpaused', await button.getAttribute('aria-pressed') === 'false')
  await button.click()
  await page.waitForFunction(() => window.__nextMessagePredictor.state().session.paused === true)
  const pausedHost = await page.evaluate(() => window.__nextMessagePredictor.state().session.hostId)
  check('pause hides suggestion', await page.locator('[data-nmp-ghost]').count() === 0)
  report.pausedScreenshotCaptured = await page.screenshot({ path: join(out, 'paused.png'), timeout: 5000 }).then(() => true, () => false)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => window.__nextMessagePredictor?.state()?.session?.available && document.querySelector('[data-nmp-session-toggle]'), undefined, { timeout: 30000 })
  check('pause survives renderer reload', await button.getAttribute('aria-pressed') === 'true')
  report.sameAuthorityAfterReload = await page.evaluate((host) => window.__nextMessagePredictor.state().session.hostId === host, pausedHost)
  const saved = await page.evaluate(async () => {
    const current = window.__nextMessagePredictor.state().config.config.requireInputFocus
    const response = await fetch('/api/next-message-predictor/rpc', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ schemaVersion: 1, operation: 'config.set', patch: { requireInputFocus: !current } }) })
    return response.json()
  })
  check('configuration saved', saved.ok === true)
  await page.waitForTimeout(1000)
  await page.evaluate(() => window.__nextMessagePredictor.reloadConfig())
  await page.waitForFunction(() => window.__nextMessagePredictor.state().session.available && !window.__nextMessagePredictor.state().session.pending, undefined, { timeout: 15000 })
  await page.waitForTimeout(1000)
  report.sameAuthorityAfterSave = await page.evaluate((host) => window.__nextMessagePredictor.state().session.hostId === host, pausedHost)
  check('pause survives configuration re-apply', await button.getAttribute('aria-pressed') === 'true')
  await button.click()
  await page.waitForFunction(() => window.__nextMessagePredictor.state().session.paused === false)
  await page.waitForTimeout(1200)
  check('resume does not replay old turn', await page.locator('[data-nmp-ghost]').count() === 0)
  check('resume updates control', await button.getAttribute('aria-pressed') === 'false')
  const before = await page.evaluate(() => window.__nextMessagePredictor.state().env?.turnId)
  const input = page.locator('[data-composer-input]').first()
  await input.click()
  await page.keyboard.press('Control+a')
  await page.keyboard.type('Reply after resume')
  await page.keyboard.press('Enter')
  await page.waitForFunction((old) => { const s = window.__nextMessagePredictor.state(); return s.env?.turnId !== old && s.assist.status === 'offered' && s.assist.turnId === s.env.turnId }, before, { timeout: 30000 })
  check('new turn predicts automatically after resume', true)
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error)
  process.exitCode = 1
} finally {
  await writeFile(join(out, 'desktop-session.json'), JSON.stringify(report, null, 2))
  await browser.close()
}
