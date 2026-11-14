#!/usr/bin/env node
// Read-only baseline-code comparison on a disposable Desktop profile.
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { loadPlaywright } from './lib/local-env.mjs'
const args = process.argv.slice(2), arg = (key) => { const i = args.indexOf(key); return i < 0 ? '' : args[i + 1] ?? '' }
const cdp = arg('--cdp'), out = arg('--out')
if (!cdp || !out || !args.includes('--isolated-desktop') || new URL(cdp).hostname !== '127.0.0.1') throw new Error('Use isolated loopback Desktop')
await mkdir(out, { recursive: true })
const browser = await loadPlaywright().module.chromium.connectOverCDP(cdp)
const report = { layer: 'archived baseline, native Electron, CDP input', attempts: [], error: null }
try {
  const page = browser.contexts().flatMap((context) => context.pages()).find((item) => item.url().startsWith('dsh-app:'))
  assert.ok(page)
  await page.waitForFunction(() => Boolean(window.__nextMessagePredictor))
  const config = await page.evaluate(async () => {
    const r = await fetch('/api/next-message-predictor/rpc', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ schemaVersion: 1, operation: 'config.set', patch: { enabled: true, modelMode: 'session', fakeSuggestion: '' } }) })
    return (await r.json()).ok
  })
  assert.equal(config, true)
  await page.waitForTimeout(1000)
  await page.evaluate(() => window.__nextMessagePredictor.reloadConfig())
  const input = page.locator('[data-composer-input]').first()
  for (const method of ['button', 'tab']) {
    const previousTurn = await page.evaluate(() => window.__nextMessagePredictor.state().env?.turnId ?? '')
    await input.click()
    await page.keyboard.press('Control+a')
    await page.keyboard.type('Reply for baseline undo')
    await page.keyboard.press('Enter')
    await page.getByRole('button', { name: /Open right sidebar|打开右侧边栏/ }).focus()
    await page.waitForFunction((old) => { const state = window.__nextMessagePredictor.state(); return state.env?.turnId !== old && !state.env?.running && state.env?.hasFinalText }, previousTurn, { timeout: 30000 })
    await page.evaluate(() => { const button = document.createElement('button'); button.id = 'nmp-test-other-focus'; button.textContent = 'Test focus'; document.body.append(button); button.focus() })
    await page.keyboard.press('Tab')
    await page.evaluate(() => document.querySelector('#nmp-test-other-focus')?.remove())
    await input.click()
    await page.waitForFunction((old) => {
      const state = window.__nextMessagePredictor.state()
      return state.env?.turnId !== old && state.assist.status === 'offered' && state.assist.turnId === state.env.turnId
    }, previousTurn, { timeout: 30000 })
    const text = await page.evaluate(() => window.__nextMessagePredictor.state().assist.text)
    if (method === 'button') await page.locator('[data-nmp-adopt]').click()
    else await page.keyboard.press('Tab')
    await page.waitForFunction((expected) => document.querySelector('[data-composer-input]')?.textContent === expected, text)
    await page.keyboard.press('Control+z')
    await page.waitForTimeout(300)
    report.attempts.push({ method, insertedExactly: true, undoRemoved: (await input.textContent()) === '' })
  }
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error)
  process.exitCode = 1
} finally {
  await writeFile(join(out, 'desktop-undo-baseline.json'), JSON.stringify(report, null, 2))
  await browser.close()
}
