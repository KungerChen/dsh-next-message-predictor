#!/usr/bin/env node
// Independent focus-option check for an isolated Desktop.
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { loadPlaywright } from './lib/local-env.mjs'
const args = process.argv.slice(2), arg = (key) => { const i = args.indexOf(key); return i < 0 ? '' : args[i + 1] ?? '' }
const cdp = arg('--cdp'), out = arg('--out'), mockLog = arg('--mock-log')
if (!cdp || !out || !mockLog || !args.includes('--isolated-desktop') || new URL(cdp).hostname !== '127.0.0.1') throw new Error('Use isolated loopback Desktop')
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
    const r = await fetch('/api/next-message-predictor/rpc', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ schemaVersion: 1, operation: 'config.set', patch: { requireInputFocus: true } }) })
    return (await r.json()).ok
  })
  check('focus option saved', saved)
  await page.waitForTimeout(1000)
  await page.evaluate(() => window.__nextMessagePredictor.reloadConfig())
  await page.waitForFunction(() => window.__nextMessagePredictor.state().session.available)
  const before = await page.evaluate(() => window.__nextMessagePredictor.state().env?.turnId)
  const input = page.locator('[data-composer-input]').first()
  await input.click()
  await page.keyboard.press('Control+a')
  await page.keyboard.type('Reply for focus option')
  await page.keyboard.press('Enter')
  await page.getByRole('button', { name: /Open right sidebar|打开右侧边栏/ }).focus()
  await page.waitForFunction((old) => { const s = window.__nextMessagePredictor.state(); return s.env?.turnId !== old && s.assist.status === 'offered' && s.assist.turnId === s.env.turnId }, before, { timeout: 30000 })
  check('offered result is hidden while input blurred', await page.locator('[data-nmp-ghost]').count() === 0)
  const count = async () => ((await readFile(mockLog, 'utf8')).match(/\[mock-llm\] predictor-request /g) ?? []).length
  const prior = await count()
  await input.click()
  await page.waitForSelector('[data-nmp-ghost]')
  check('existing result becomes visible on focus', await page.locator('[data-nmp-ghost]').isVisible())
  check('focusing does not make a new model call', prior === await count())
} catch (error) { report.error = error instanceof Error ? error.message : String(error); process.exitCode = 1 }
finally { await writeFile(join(out, 'desktop-focus.json'), JSON.stringify(report, null, 2)); await browser.close() }
