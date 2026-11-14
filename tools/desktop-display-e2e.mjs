#!/usr/bin/env node
// Run only against a disposable Desktop process and its local mock model.
// Example: node tools/desktop-display-e2e.mjs --cdp http://127.0.0.1:9225 --out scratch/evidence/desktop --mock-log scratch/logs/mock-llm.out.log --isolated-desktop
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { loadPlaywright } from './lib/local-env.mjs'

const args = process.argv.slice(2)
const arg = (key) => { const i = args.indexOf(key); return i < 0 ? '' : args[i + 1] ?? '' }
const cdp = arg('--cdp')
const out = arg('--out')
const mockLog = arg('--mock-log')
if (!cdp || !out || !mockLog || !args.includes('--isolated-desktop')) throw new Error('Specify --cdp, --out, --mock-log and --isolated-desktop only for a disposable Desktop instance')
const url = new URL(cdp)
if (url.hostname !== '127.0.0.1' || url.protocol !== 'http:') throw new Error('CDP must be loopback HTTP')
await mkdir(out, { recursive: true })
const { chromium } = loadPlaywright().module
const browser = await chromium.connectOverCDP(cdp)
const report = { layer: 'native Electron, Playwright CDP input', checks: [], error: null }
const check = (name, condition) => { report.checks.push({ name, pass: Boolean(condition) }); assert.ok(condition, name) }
let page
try {
  page = browser.contexts().flatMap((context) => context.pages()).find((candidate) => candidate.url().startsWith('dsh-app:'))
  assert.ok(page, 'native dsh-app window')
  await page.waitForFunction(() => Boolean(window.__nextMessagePredictor) && Boolean(document.querySelector('[data-composer-input]')))
  const initial = await page.evaluate(() => window.__nextMessagePredictor.config())
  // Refuse to run unless the operator provisioned the disposable profile for this test.
  const mock = await page.getByRole('button', { name: /Select model, current Mock 1|选择模型.*Mock 1/i }).count()
  check('isolated mock model selected', mock > 0)
  const config = async (patch) => {
    const response = await page.evaluate(async (patch) => {
      const r = await fetch('/api/next-message-predictor/rpc', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ schemaVersion: 1, operation: 'config.set', patch }) })
      return r.json()
    }, patch)
    check('configuration saved', response.ok === true)
    await page.waitForTimeout(1000)
    await page.evaluate(() => window.__nextMessagePredictor.reloadConfig())
    await page.waitForTimeout(500)
    await page.waitForFunction(() => {
      const state = window.__nextMessagePredictor.state()
      return state.config.ready && (!state.env?.sessionId || (state.session?.available && !state.session?.pending))
    }, undefined, { timeout: 10000 })
  }
  const mockCalls = async () => ((await readFile(mockLog, 'utf8')).match(/\[mock-llm\] (?:request path=|predictor-request )/g) ?? []).length
  const conversation = () => page.evaluate(() => ({
    users: document.querySelectorAll('[data-chat-flow-kind="user"]').length,
    turns: new Set([...document.querySelectorAll('[data-chat-turn]')].map((node) => node.getAttribute('data-chat-turn'))).size,
  }))
  const turn = async (focusAway = false) => {
    await page.evaluate(() => window.__nextMessagePredictor.clear())
    const input = page.locator('[data-composer-input]').first()
    await input.click()
    await page.keyboard.press('Control+A')
    await page.keyboard.type('Reply received')
    await page.keyboard.press('Enter')
    if (focusAway) await page.getByRole('button', { name: 'Open right sidebar' }).focus()
    await page.waitForFunction(() => window.__nextMessagePredictor.state().assist.status === 'offered', undefined, { timeout: 30000 })
  }
  const control = async (predictMode) => {
    const response = await fetch('http://127.0.0.1:3091/control', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ predictMode }) })
    assert.ok(response.ok, 'local mock control')
  }
  await control('slow')
  await config({ enabled: true, modelMode: 'session', fakeSuggestion: '', requireInputFocus: false })
  await turn(true)
  check('focus remains away when delayed offer arrives', await page.getByRole('button', { name: 'Open right sidebar' }).evaluate((button) => document.activeElement === button))
  await page.locator('[data-composer-input]').evaluate((input) => input.blur())
  await page.waitForTimeout(300)
  check('default displays without input focus', await page.locator('[data-nmp-ghost]').isVisible())
  const textPaint = await page.evaluate(() => {
    const ghost = document.querySelector('[data-nmp-ghost]')
    const span = ghost?.querySelector('span')
    const style = span && getComputedStyle(span)
    const rect = span?.getBoundingClientRect()
    const range = document.createRange()
    if (span) range.selectNodeContents(span)
    const ink = span ? range.getBoundingClientRect() : null
    return { text: span?.textContent ?? '', expected: window.__nextMessagePredictor.state().assist.text,
      display: style?.display, visibility: style?.visibility, opacity: style?.opacity, color: style?.color,
      textFill: style?.webkitTextFillColor, lineHeight: style?.lineHeight, overflow: style?.overflow,
      contentVisibility: style?.contentVisibility, lineClamp: style?.webkitLineClamp,
      width: rect?.width ?? 0, height: rect?.height ?? 0, inkWidth: ink?.width ?? 0, inkHeight: ink?.height ?? 0,
      documentVisible: document.visibilityState, windowFocused: document.hasFocus() }
  })
  check('suggestion text has visible layout and matches offer', textPaint.text.length > 0 && textPaint.text === textPaint.expected && textPaint.visibility === 'visible' && textPaint.display !== 'none' && textPaint.opacity !== '0' && textPaint.width > 0 && textPaint.height > 0)
  report.textPaint = { ...textPaint, text: undefined, expected: undefined }
  await page.screenshot({ path: join(out, 'unfocused.png') })
  const textSpan = page.locator('[data-nmp-ghost] > span').first()
  const textBounds = await textSpan.boundingBox()
  const painted = await page.screenshot({ clip: textBounds })
  await textSpan.evaluate((node) => { node.dataset.nmpTestVisibility = node.style.visibility; node.style.visibility = 'hidden' })
  const withoutText = await page.screenshot({ clip: textBounds })
  await textSpan.evaluate((node) => { node.style.visibility = node.dataset.nmpTestVisibility; delete node.dataset.nmpTestVisibility })
  check('suggestion text contributes visible screenshot pixels', !painted.equals(withoutText))
  check('unfocused offer gives a focus hint and has no adopt button', await page.locator('[data-nmp-focus-hint]').isVisible() && await page.locator('[data-nmp-adopt]').count() === 0)
  await page.evaluate(() => {
    const button = document.createElement('button')
    button.id = 'nmp-test-other-focus'
    button.textContent = 'Test focus'
    document.body.append(button)
    button.focus()
  })
  await page.keyboard.press('Tab')
  check('Tab on another control does not adopt', (await page.locator('[data-composer-input]').textContent()).trim() === '')
  await page.evaluate(() => document.querySelector('#nmp-test-other-focus')?.remove())
  let sends = 0
  page.on('request', (request) => { if (/session\/prompt/.test(request.url())) sends += 1 })
  const before = await conversation()
  const callsBefore = await mockCalls()
  check('session projection and mock log contain test activity', before.users > 0 && before.turns > 0 && callsBefore > 0)
  const offeredText = await page.evaluate(() => window.__nextMessagePredictor.state().assist.text)
  await page.locator('[data-composer-input]').click()
  await page.waitForSelector('[data-nmp-adopt]')
  await page.evaluate(() => {
    const editor = document.querySelector('[data-composer-input]')
    const lexical = editor?.__lexicalEditor
    window.__nmpUndoProbe = { updates: [], selections: [], installed: Boolean(lexical?.registerUpdateListener) }
    lexical?.registerUpdateListener?.(({ tags, dirtyLeaves, dirtyElements, prevEditorState, editorState }) => {
      window.__nmpUndoProbe.updates.push({ tags: [...tags], dirtyLeaves: dirtyLeaves.size, dirtyElements: dirtyElements.size,
        previousSelection: prevEditorState?._selection?.constructor?.name ?? null, selection: editorState?._selection?.constructor?.name ?? null })
    })
    document.addEventListener('selectionchange', () => window.__nmpUndoProbe.selections.push({
      active: document.activeElement === editor, inside: editor?.contains(document.getSelection()?.anchorNode) === true,
    }))
  })
  await page.locator('[data-nmp-adopt]').click()
  await page.waitForFunction((text) => document.querySelector('[data-composer-input]')?.textContent === text, offeredText)
  check('click inserts exact offered text into draft', (await page.locator('[data-composer-input]').textContent()) === offeredText && offeredText.length > 0)
  check('click hides suggestion', await page.locator('[data-nmp-ghost]').count() === 0)
  await page.keyboard.press('Control+z')
  await page.waitForTimeout(300)
  check('undo removes insertion', (await page.locator('[data-composer-input]').textContent()).trim() === '')
  check('undo does not revive suggestion', await page.locator('[data-nmp-ghost]').count() === 0)
  await page.keyboard.press('Control+Shift+z')
  await page.waitForTimeout(200)
  check('redo restores exact suggestion', (await page.locator('[data-composer-input]').textContent()) === offeredText)
  await page.keyboard.type('x')
  await page.keyboard.press('Control+z')
  await page.waitForTimeout(200)
  check('undo subsequent typing preserves suggestion', (await page.locator('[data-composer-input]').textContent()) === offeredText)
  await page.keyboard.press('Control+z')
  await page.waitForTimeout(200)
  check('second undo removes suggestion without restoring sent text', (await page.locator('[data-composer-input]').textContent()) === '')
  check('no observed session prompt on adoption or undo', sends === 0)
  await page.waitForTimeout(700)
  const after = await conversation()
  check('adoption and undo add no user messages or turns', before.users === after.users && before.turns === after.turns)
  check('adoption and undo add no mock model calls', callsBefore === await mockCalls())
  await config({ requireInputFocus: true })
  await turn(true)
  await page.waitForTimeout(300)
  check('focus option hides offered result while blurred', await page.locator('[data-nmp-ghost]').count() === 0)
  const callsBeforeFocus = await mockCalls()
  await page.locator('[data-composer-input]').focus()
  await page.waitForTimeout(300)
  check('focus option restores on focus', await page.locator('[data-nmp-ghost]').isVisible())
  check('focusing does not call the model again', callsBeforeFocus === await mockCalls())
  report.initialConfigurationReadable = Boolean(initial)
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error)
  process.exitCode = 1
} finally {
  if (page) report.undoProbe = await page.evaluate(() => window.__nmpUndoProbe ?? null).catch(() => null)
  await fetch('http://127.0.0.1:3091/control', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ predictMode: 'json' }) }).catch(() => {})
  await writeFile(join(out, 'desktop-display.json'), JSON.stringify(report, null, 2))
  await browser.close()
}
