#!/usr/bin/env node
// Native Electron window bounds and webContents zoom in a disposable profile.
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { loadPlaywright } from './lib/local-env.mjs'
const args = process.argv.slice(2), arg = (key) => { const i = args.indexOf(key); return i < 0 ? '' : args[i + 1] ?? '' }
const exe = arg('--exe'), out = arg('--out')
if (!exe || !out || !args.includes('--isolated-desktop') || !process.env.NMP_DESKTOP_USERDATA || !process.env.DSH_HOME || !process.env.NMP_DATA_HOME) throw new Error('Specify --exe, --out, --isolated-desktop and isolated home/data/userData environment')
await mkdir(out, { recursive: true })
const report = { layer: 'native Electron BrowserWindow bounds and webContents zoom; not OS DPI', checks: [], observations: [], error: null }
const check = (name, condition) => { report.checks.push({ name, pass: Boolean(condition) }); assert.ok(condition, name) }
let app
try {
  const env = { ...process.env }
  for (const key of ['ELECTRON_RUN_AS_NODE', 'DSH_PROFILE', 'DSH_PROFILE_DIR', 'DSH_SESSION_ID']) delete env[key]
  app = await loadPlaywright().module._electron.launch({ executablePath: exe, args: [`--user-data-dir=${env.NMP_DESKTOP_USERDATA}`], env, timeout: 30000 })
  report.testPid = app.process().pid
  const page = await app.firstWindow()
  await page.waitForFunction(() => Boolean(window.__nextMessagePredictor) && Boolean(document.querySelector('[data-composer-input]')), undefined, { timeout: 30000 })
  const mockButton = page.getByRole('button', { name: /Select model, current Mock 1|选择模型.*Mock 1/i })
  await mockButton.first().waitFor({ state: 'visible', timeout: 15000 })
  check('local mock selected', await mockButton.count() > 0)
  const setWindow = async (width, zoom) => app.evaluate(({ BrowserWindow, screen }, opts) => {
    const w = BrowserWindow.getAllWindows().find((item) => item.webContents.getURL().startsWith('dsh-app:'))
    if (!w) throw new Error('native window not found')
    w.setBounds({ width: opts.width, height: 900 })
    w.webContents.setZoomFactor(opts.zoom)
    return { bounds: w.getBounds(), zoom: w.webContents.getZoomFactor(), screenScaleFactor: screen.getDisplayMatching(w.getBounds()).scaleFactor }
  }, { width, zoom })
  const languages = arg('--language') ? [arg('--language')] : ['en', 'zh']
  for (const language of languages) {
    const saved = await page.evaluate(async (language) => {
      const r = await fetch('/api/next-message-predictor/rpc', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ schemaVersion: 1, operation: 'config.set', patch: { language, enabled: true, modelMode: 'session', requireInputFocus: false } }) })
      return (await r.json()).ok
    }, language)
    check(`${language} configuration saved`, saved)
    await page.waitForTimeout(1000)
    await page.evaluate(() => window.__nextMessagePredictor.reloadConfig())
    await page.waitForFunction(() => window.__nextMessagePredictor.state().session.available)
    const input = page.locator('[data-composer-input]').first()
    const old = await page.evaluate(() => window.__nextMessagePredictor.state().env?.turnId ?? '')
    await input.click()
    await page.keyboard.press('Control+a')
    await page.keyboard.type('Reply for window layout')
    await page.keyboard.press('Enter')
    await page.getByRole('button', { name: /Open right sidebar|打开右侧边栏/ }).focus()
    await page.waitForFunction((previous) => { const s = window.__nextMessagePredictor.state(); return s.env?.turnId !== previous && s.assist.status === 'offered' && s.assist.turnId === s.env.turnId }, old, { timeout: 30000 })
    for (const [label, width, zoom] of [['normal', 1000, 1], ['narrow', 600, 1], ['narrow-zoom150', 600, 1.5]]) {
      const actual = await setWindow(width, zoom)
      check(`${language} ${label} native zoom applied`, Math.abs(actual.zoom - zoom) < 0.01)
      await page.waitForFunction(() => {
        const selectors = ['[data-nmp-ghost] > span', '[data-nmp-adopt], [data-nmp-focus-hint]', '[data-nmp-another]', '[data-nmp-session-toggle]']
        return selectors.every((selector) => { const r = document.querySelector(selector)?.getBoundingClientRect(); return r && r.width > 0 && r.height > 0 && r.x >= 0 && r.y >= 0 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1 })
      }, undefined, { timeout: 5000 })
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
      const geometry = await page.evaluate(async () => {
        const take = () => {
          const selectors = ['[data-nmp-ghost] > span', '[data-nmp-adopt], [data-nmp-focus-hint]', '[data-nmp-another]', '[data-nmp-session-toggle]']
          const boxes = selectors.map((selector) => {
            const node = document.querySelector(selector), r = node?.getBoundingClientRect(), style = node && getComputedStyle(node)
            return r ? { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height, visible: style.visibility === 'visible' && style.display !== 'none' && style.opacity !== '0' } : null
          })
          return { boxes, viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio } }
        }
        const first = take()
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
        return { first, last: take() }
      })
      const { boxes, viewport } = geometry.last
      const stable = JSON.stringify(geometry.first) === JSON.stringify(geometry.last)
      const within = boxes.every((box) => box && box.visible && box.width > 0 && box.height > 0 && box.x >= 0 && box.y >= 0 && box.right <= viewport.width + 1 && box.bottom <= viewport.height + 1)
      const separate = (a, b) => a.right <= b.x + 1 || b.right <= a.x + 1 || a.bottom <= b.y + 1 || b.bottom <= a.y + 1
      check(`${language} ${label} stable visible controls within viewport`, stable && within)
      check(`${language} ${label} text and controls do not overlap`, separate(boxes[0], boxes[1]) && separate(boxes[1], boxes[2]) && separate(boxes[2], boxes[3]))
      const png = await app.evaluate(async ({ BrowserWindow }) => {
        const w = BrowserWindow.getAllWindows().find((item) => item.webContents.getURL().startsWith('dsh-app:'))
        if (!w) throw new Error('native window not found for capture')
        return (await w.webContents.capturePage()).toPNG().toString('base64')
      })
      await writeFile(join(out, `${language}-${label}.png`), Buffer.from(png, 'base64'))
      report.observations.push({ language, label, actual, geometry: geometry.last })
    }
  }
} catch (error) { report.error = error instanceof Error ? error.message : String(error); process.exitCode = 1 }
finally { await writeFile(join(out, 'desktop-electron-layout.json'), JSON.stringify(report, null, 2)); if (app) await app.close() }
