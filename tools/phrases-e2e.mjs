#!/usr/bin/env node
/**
 * End-to-end verification of 0.5.0: pinned phrases, the suggestion ring, the
 * manual fallback and the statistics (isolated scratch profile + mock model).
 *
 * Steps (each is recorded under its own name in the JSON report):
 *   settings-edit        add three pinned phrases in the settings page, move one, remove one,
 *                        unsaved hint and counter, Save -> exactly one config.set
 *   settings-reload      after a page reload the list is as saved
 *   settings-discard     "放弃修改" throws the draft away, no config.set
 *   settings-errors      empty, duplicate, leading "/", 41 characters, an 11th phrase
 *   ring-auto            fresh session, a short message sent twice (habit phrase); the automatic
 *                        suggestion is the model's (one model call); the chip shows the position
 *   ring-walk            Alt+\ walks model -> habit -> pinned, marks and tooltips, no model call
 *   tab-pinned           Tab on a pinned phrase fills exactly that text, nothing is sent
 *   stats-own            "近 7 天统计" shows the own-phrase count
 *   auto-unusable        automatic prediction with an unusable model reply shows nothing
 *   manual-fallback      Alt+\ with an unusable reply offers a local phrase; a model call is spent
 *   manual-exhausted     daily request limit used up: Alt+\ offers a local phrase, no model call
 *   narrow-marked        narrow input box with a marked entry on screen: chips neither overflow nor wrap
 *   save-keeps-stats     saving a setting with a suggestion on screen does not lose its statistics
 *   no-local             no pinned phrases, habit switch off: model candidates only, no marks
 *   altgr-synthetic      a synthetic AltGr keydown does not trigger a prediction (synthetic event only)
 *   restore              plugin config and mock put back
 *
 * The report holds counts, flags and shortcuts only: no conversation text, no
 * suggestion text, no access token.
 *
 * Usage:
 *   node tools/phrases-e2e.mjs --url "<scratch URL>" [--out scratch/evidence] [--tag phrases]
 *                              [--mock http://127.0.0.1:3091] [--mock-log <path>]
 */
import { browserPath, loadChromium } from './lib/local-env.mjs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { NMP_LOCALE_ZH as ZH } from '../src/client/locales/zh.js'

const chromium = loadChromium()
const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..')
const args = process.argv.slice(2)
const argOf = (name, fallback) => {
  const i = args.indexOf(name)
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback
}
const url = argOf('--url', '')
const out = argOf('--out', path.join(repoRoot, 'scratch', 'evidence'))
const tag = argOf('--tag', 'phrases')
const MOCK_BASE = argOf('--mock', 'http://127.0.0.1:3091')
const mockLog = argOf('--mock-log', path.join(repoRoot, 'scratch', 'logs', 'mock-llm.out.log'))
const dataHome = process.env.NMP_DATA_HOME ?? path.join(repoRoot, 'scratch', 'data-home')
const eventsFile = path.join(dataHome, 'next-message-predictor', 'events.jsonl')
if (!url) throw new Error('--url is required')
await mkdir(out, { recursive: true })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const report = {
  driver: 'tools/phrases-e2e.mjs',
  ok: false,
  url: url.replace(/([?&]token=)[^&#]*/u, '$1<hidden>'),
  mockBase: MOCK_BASE,
  startedAt: new Date().toISOString(),
  steps: {},
  console: [],
  pageErrors: [],
}

// ── test data (not conversation text: fixed strings made up for this script) ──
const HABIT = '好的继续'
const P1 = '继续'
const P2 = '跑一下测试'
const P3 = '把改动给我看看'
const LONG_PINNED = '把刚才改动的每一个文件逐个解释给我听一下谢谢' // 22 characters, wraps in a narrow box
const MODEL_TEXT = '继续第二项' // the mock's default prediction
const CHAT_REPLY = '收到（mock-1）'
const DEFAULT_PREDICT = '{"suggestion":"继续第二项"}'

async function mockControl(patch) {
  const response = await fetch(`${MOCK_BASE}/control`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) })
  return response.json()
}
async function mockPredictCount() {
  try {
    const text = await readFile(mockLog, 'utf8')
    return text.match(/predictor-request/g)?.length ?? 0
  } catch {
    return 0
  }
}
async function eventsLines() {
  try {
    return (await readFile(eventsFile, 'utf8')).split('\n').filter((line) => line.trim() !== '')
  } catch {
    return []
  }
}

const browser = await chromium.launch({ executablePath: browserPath(), headless: true, args: ['--disable-gpu', '--no-first-run', '--no-default-browser-check'] })
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN' })
const page = await context.newPage()
page.setDefaultTimeout(30000)
page.on('console', (m) => {
  if (report.console.length < 300) report.console.push({ type: m.type(), text: m.text().slice(0, 600) })
})
page.on('pageerror', (e) => report.pageErrors.push(String(e).slice(0, 1500)))
const net = { configSets: 0, promptish: 0, predicts: 0 }
page.on('request', (request) => {
  const body = request.postData() ?? ''
  if (/api\/next-message-predictor\/rpc/.test(request.url())) {
    if (body.includes('"config.set"')) net.configSets += 1
    if (body.includes('"predict"')) net.predicts += 1
  }
  if (/session\/prompt|beginSubmission/i.test(request.url() + ' ' + body)) net.promptish += 1
})
page.on('websocket', (ws) => {
  ws.on('framesent', (frame) => {
    const payload = typeof frame.payload === 'string' ? frame.payload : ''
    if (/session\/prompt|beginSubmission/i.test(payload)) net.promptish += 1
  })
})

// ── page helpers ─────────────────────────────────────────────────────────────
const assistState = () =>
  page.evaluate(() => {
    const api = window.__nextMessagePredictor
    if (!api) return { present: false }
    const s = api.state()
    return {
      present: true,
      status: s.assist.status,
      reason: s.assist.reason,
      text: s.assist.text,
      candidates: [...(s.assist.candidates ?? [])],
      sources: [...(s.assist.sources ?? [])],
      candidateIndex: s.assist.candidateIndex,
      env: s.env ? { turnId: s.env.turnId, running: s.env.running, hasFinalText: s.env.hasFinalText } : null,
    }
  })
const dom = () =>
  page.evaluate(() => {
    const input = document.querySelector('[data-composer-input]')
    const ghost = document.querySelector('[data-nmp-ghost]')
    const another = document.querySelector('[data-nmp-another]')
    const mark = document.querySelector('[data-nmp-source-mark]')
    const notice = document.querySelector('[data-nmp-notice]')
    return {
      editable: input ? input.isContentEditable : false,
      draft: input ? input.textContent : null,
      ghost: Boolean(ghost),
      ghostVisible: ghost ? ghost.getBoundingClientRect().width > 0 && ghost.style.visibility !== 'hidden' : false,
      ghostSource: ghost ? ghost.getAttribute('data-nmp-source') : null,
      chipText: another ? another.textContent : null,
      chipTitle: another ? another.getAttribute('title') : null,
      markKind: mark ? mark.getAttribute('data-nmp-source-mark') : null,
      markVisible: mark ? getComputedStyle(mark).visibility === 'visible' : false,
      markTitle: mark ? mark.getAttribute('title') : null,
      markCount: document.querySelectorAll('[data-nmp-source-mark]').length,
      notice: notice ? notice.getAttribute('data-nmp-notice') : null,
      noticeText: notice ? notice.textContent : null,
    }
  })
const rpc = (body) =>
  page.evaluate(async (payload) => {
    try {
      const response = await fetch('/api/next-message-predictor/rpc', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) })
      return { httpStatus: response.status, json: await response.json() }
    } catch (error) {
      return { error: String(error) }
    }
  }, body)
const statusValue = async () => {
  const r = await rpc({ schemaVersion: 1, operation: 'status' })
  return r.json && r.json.ok === true ? r.json.value : null
}
const counters = async () => (await statusValue())?.diagnostics?.counters ?? {}
const summary = async () => {
  const r = await rpc({ schemaVersion: 1, operation: 'results.summary' })
  return r.json?.value?.summary ?? null
}
const reloadConfig = async () => {
  await page.evaluate(() => window.__nextMessagePredictor?.reloadConfig?.()).catch(() => {})
  await sleep(1000)
}
const setConfig = async (patch) => {
  const r = await rpc({ schemaVersion: 1, operation: 'config.set', patch })
  if (!r.json || r.json.ok !== true) throw new Error(`config.set failed: ${JSON.stringify(r.json?.error ?? r.error)}`)
  await sleep(1500)
  await reloadConfig()
}
const currentConfig = () => page.evaluate(() => ({ ...window.__nextMessagePredictor.config().config }))

async function dismissPreview() {
  const dialogs = page.locator('[role="dialog"]')
  for (let i = 0; i < (await dialogs.count()); i += 1) {
    const d = dialogs.nth(i)
    const text = await d.innerText().catch(() => '')
    if (text.includes('预览版说明') || /preview/i.test(text)) {
      const b = d.locator('button', { hasText: /继续|Continue/ }).first()
      if (await b.count()) {
        await b.click({ force: true })
        await sleep(600)
        return
      }
    }
  }
}
async function ensureComposer() {
  await dismissPreview()
  for (let i = 0; i < 14; i += 1) {
    const d = await dom()
    if (d.editable) return d
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
  throw new Error('composer is not ready')
}
async function loadApp() {
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => Boolean(window.__nextMessagePredictor), undefined, { timeout: 30000 })
  await ensureComposer()
  await page.waitForFunction(() => window.__nextMessagePredictor.config().ready === true, undefined, { timeout: 30000 })
}
async function newSession() {
  const button = page.locator('button', { hasText: '新会话' }).first()
  if (await button.count()) {
    await button.click({ force: true }).catch(() => {})
    await sleep(900)
  }
  await ensureComposer()
}
const clearDraft = async () => {
  await page.locator('[data-composer-input]').first().click({ force: true })
  await sleep(120)
  await page.keyboard.press('Control+A')
  await page.keyboard.press('Delete')
  await sleep(150)
}
async function sendTurn(text) {
  await ensureComposer()
  await clearDraft()
  const before = await assistState()
  const turnBefore = before.env ? before.env.turnId : ''
  await page.keyboard.type(text, { delay: 8 })
  await page.keyboard.press('Enter')
  let started = false
  for (let i = 0; i < 100; i += 1) {
    const s = await assistState()
    if (s.env && s.env.running === true) {
      started = true
      break
    }
    await sleep(100)
  }
  if (!started) throw new Error('turn did not start')
  for (let i = 0; i < 300; i += 1) {
    const s = await assistState()
    if (s.env && s.env.running === false && s.env.hasFinalText === true && s.env.turnId !== turnBefore && s.env.turnId !== '') return s
    await sleep(100)
  }
  throw new Error('turn did not finish')
}
async function waitGhost(timeoutMs = 25000, accept = () => true) {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    const s = await assistState()
    const d = await dom()
    last = { s, d }
    if (s.status === 'offered' && s.text !== '' && d.ghost && d.ghostVisible && accept(s, d)) return last
    await sleep(100)
  }
  throw new Error(`no matching suggestion on screen (last status ${last?.s?.status}, ${last?.s?.candidates?.length} candidates)`)
}
async function waitIdleNoGhost(ms) {
  await sleep(ms)
  const s = await assistState()
  const d = await dom()
  return { s, d }
}
async function press(key) {
  await page.locator('[data-composer-input]').first().click({ force: true })
  await sleep(120)
  await page.keyboard.press(key)
}
// Same key without a mouse click: in a very narrow box the centre of the input is where the chips sit.
async function pressFocused(key) {
  await page.evaluate(() => document.querySelector('[data-composer-input]').focus())
  await sleep(120)
  await page.keyboard.press(key)
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const assert = (cond, message, details) => {
  if (!cond) {
    const error = new Error(`assertion failed: ${message}`)
    error.details = details
    throw error
  }
}
const shot = async (name) => {
  await page.screenshot({ path: path.join(out, `${tag}-${name}.png`) }).catch(() => {})
}
async function step(name, fn) {
  const started = Date.now()
  try {
    const value = await fn()
    report.steps[name] = { ok: true, ms: Date.now() - started, value: value ?? null }
  } catch (error) {
    report.steps[name] = { ok: false, ms: Date.now() - started, error: String(error?.message ?? error).slice(0, 800), details: error?.details ?? null }
    await shot(`fail-${name}`)
  }
  return report.steps[name].ok
}

// ── settings page helpers ────────────────────────────────────────────────────
const panel = '[data-nmp-panel]'
const sel = (name) => `${panel} [data-nmp-setting="${name}"]`
async function openSettings() {
  await page.evaluate(() => window.__nextMessagePredictor.openPanel())
  await page.waitForSelector(sel('pinned'))
  await sleep(500)
}
const pinnedRows = () => page.$$eval(`${panel} [data-nmp-pinned-row] > span`, (nodes) => nodes.map((n) => n.textContent))
const pinnedCounter = () => page.locator(sel('pinnedCount')).innerText()
const dirtyShown = async () => (await page.locator(sel('pinnedDirty')).count()) > 0
const pinnedError = async () => ((await page.locator(sel('pinnedError')).count()) > 0 ? page.locator(sel('pinnedError')).innerText() : '')
async function addViaUi(text, { enter = false } = {}) {
  const input = page.locator(sel('pinnedInput'))
  await input.fill(text)
  if (enter) await input.press('Enter')
  else await page.locator(sel('pinnedAdd')).click()
  await sleep(150)
}
const fmt = (template, values) => Object.entries(values).reduce((acc, [k, v]) => acc.split(`{${k}}`).join(String(v)), template)

let baseline = null
let ringReady = false

try {
  await loadApp()
  await mockControl({ predictMode: 'json', predictReply: DEFAULT_PREDICT, reply: CHAT_REPLY })
  baseline = await currentConfig()
  report.baseline = { language: baseline.language, sidebarEntry: baseline.sidebarEntry, pinnedCount: baseline.pinnedPhrases.length, habitSuggestions: baseline.habitSuggestions }
  // Deterministic start: model of the session (the mock), Chinese texts, one candidate per call, no local phrases yet.
  await setConfig({
    enabled: true, modelMode: 'session', provider: '', model: '', reasoningEffort: '', language: 'zh', manualOnly: false, showPredictButton: true,
    multiCandidates: false, habitSuggestions: true, pinnedPhrases: [], manualLimit: 3, candidateCount: 3, timeoutMs: 8000,
    dailyRequestLimit: 200, dailyTokenBudget: 500000, triggerDelayMs: 250,
  })
  const eventsBefore = (await eventsLines()).length

  // ── 1. settings: edit the list ─────────────────────────────────────────────
  await step('settings-edit', async () => {
    await openSettings()
    assert(eq(await pinnedRows(), []), 'list starts empty')
    assert(!(await dirtyShown()), 'no unsaved hint before editing')
    assert((await pinnedCounter()).replace(/\s/g, '') === '0/10', 'counter 0 / 10', await pinnedCounter())
    await addViaUi(P1)
    await addViaUi(P2)
    await addViaUi(P3)
    assert(eq(await pinnedRows(), [P1, P2, P3]), 'three rows in the order added')
    assert(await dirtyShown(), 'unsaved hint shows after adding')
    assert((await pinnedCounter()).replace(/\s/g, '') === '3/10', 'counter 3 / 10', await pinnedCounter())
    await page.locator(`${panel} [data-nmp-pinned-up="2"]`).click() // third row up
    await sleep(150)
    assert(eq(await pinnedRows(), [P1, P3, P2]), 'row moved up')
    await page.locator(`${panel} [data-nmp-pinned-remove="0"]`).click() // remove the first
    await sleep(150)
    assert(eq(await pinnedRows(), [P3, P2]), 'row removed')
    assert((await pinnedCounter()).replace(/\s/g, '') === '2/10', 'counter 2 / 10', await pinnedCounter())
    assert(await dirtyShown(), 'unsaved hint still shows')
    const savedBefore = (await currentConfig()).pinnedPhrases
    assert(savedBefore.length === 0, 'nothing written before Save')
    const setsBefore = net.configSets
    await page.locator(sel('pinnedSave')).click()
    await page.waitForFunction((s) => !document.querySelector(`${s}`), sel('pinnedDirty'), { timeout: 15000 })
    await sleep(1500)
    await reloadConfig()
    const writes = net.configSets - setsBefore
    assert(writes === 1, `exactly one config.set for Save (saw ${writes})`)
    assert(eq((await currentConfig()).pinnedPhrases, [P3, P2]), 'config holds the saved list in order')
    assert(!(await dirtyShown()), 'unsaved hint gone after Save')
    const undoShown = (await page.locator(sel('undo')).count()) > 0
    assert(undoShown, 'undo is offered after saving')
    const messageText = (await page.locator(sel('message')).count()) > 0 ? await page.locator(sel('message')).innerText() : ''
    assert(messageText.includes(ZH['settings.pinnedSaved']), 'saved message shown', messageText)
    await shot('settings-saved')
    return { configSetsForSave: writes, savedCount: 2, undoShown, counter: '2/10' }
  })

  // ── 2. settings: after a reload ────────────────────────────────────────────
  await step('settings-reload', async () => {
    await loadApp()
    await openSettings()
    const rows = await pinnedRows()
    assert(eq(rows, [P3, P2]), 'list after reload is as saved', { count: rows.length })
    assert(!(await dirtyShown()), 'no unsaved hint after reload')
    assert((await pinnedCounter()).replace(/\s/g, '') === '2/10', 'counter after reload')
    return { rows: rows.length }
  })

  // ── 3. settings: discard ───────────────────────────────────────────────────
  await step('settings-discard', async () => {
    const setsBefore = net.configSets
    await addViaUi('临时一条')
    assert((await pinnedRows()).length === 3, 'draft has the extra row')
    assert(await dirtyShown(), 'unsaved hint shows')
    await page.locator(`${panel} [data-nmp-pinned-remove="0"]`).click()
    await sleep(100)
    assert((await pinnedRows()).length === 2, 'draft edits stack')
    await page.locator(sel('pinnedDiscard')).click()
    await sleep(200)
    assert(eq(await pinnedRows(), [P3, P2]), 'discard restores the saved list')
    assert(!(await dirtyShown()), 'hint gone after discard')
    assert(net.configSets === setsBefore, 'discard writes nothing')
    return { configSetsAfterDiscard: net.configSets - setsBefore }
  })

  // ── 4. settings: validation errors ─────────────────────────────────────────
  await step('settings-errors', async () => {
    const seen = {}
    const expectError = async (name, text, expected, options) => {
      await addViaUi(text, options)
      const got = await pinnedError()
      assert(got === expected, `${name}: error text`, { got: got.length, expected: expected.length })
      assert((await pinnedRows()).length === 2, `${name}: nothing added`)
      seen[name] = true
    }
    await expectError('empty', '', ZH['settings.pinnedErrorEmpty'])
    await expectError('duplicate', P2, ZH['settings.pinnedErrorDuplicate'])
    await expectError('duplicate-normalised', `${P2}。`, ZH['settings.pinnedErrorDuplicate'])
    await expectError('slash', '/compact', ZH['settings.pinnedErrorCommand'])
    await expectError('at', '@文件', ZH['settings.pinnedErrorCommand'])
    await expectError('too-long', '字'.repeat(41), fmt(ZH['settings.pinnedErrorLong'], { n: 40 }))
    // The 11th phrase: fill the draft up to ten, then try one more.
    for (let i = 0; i < 8; i += 1) await addViaUi(`第${i + 1}条测试短语${i}`)
    assert((await pinnedRows()).length === 10, 'draft is full at ten')
    assert((await pinnedCounter()).replace(/\s/g, '') === '10/10', 'counter 10 / 10')
    assert(await page.locator(sel('pinnedAdd')).isDisabled(), 'Add button is disabled when full')
    await page.locator(sel('pinnedInput')).fill('第十一条')
    await page.locator(sel('pinnedInput')).press('Enter')
    await sleep(150)
    const full = await pinnedError()
    assert(full === fmt(ZH['settings.pinnedErrorFull'], { n: 10 }), 'eleventh phrase: error text', full)
    assert((await pinnedRows()).length === 10, 'eleventh phrase not added')
    seen.eleventh = true
    await shot('settings-errors')
    await page.locator(sel('pinnedDiscard')).click()
    await sleep(200)
    assert(eq(await pinnedRows(), [P3, P2]), 'discard after errors restores the saved list')
    return seen
  })

  // ── 5. the ring: fresh session, habit phrase, model suggestion first ───────
  await step('ring-auto', async () => {
    await loadApp()
    await newSession()
    await sendTurn(HABIT)
    await sendTurn(HABIT)
    // The second turn's automatic suggestion was predicted with the habit phrase in the session.
    await sleep(500)
    const { s, d } = await waitGhost(25000, (st) => st.candidates.length > 1)
    ringReady = true
    // One model call for the second turn: count calls around a third, idle wait.
    assert(s.text === MODEL_TEXT, 'first suggestion is the model one')
    assert(eq(s.sources, ['model', 'habit', 'pinned', 'pinned']), 'ring order model, habit, pinned, pinned', s.sources)
    assert(s.candidateIndex === 0, 'ring starts at the first entry')
    assert(s.candidates[1] === HABIT && s.candidates[2] === P3 && s.candidates[3] === P2, 'ring entries are the habit and pinned phrases in order')
    assert(d.chipText.replace(/\s/g, '') === `${ZH['ghost.another']}1/4`, 'chip shows the position', d.chipText)
    assert(d.markCount === 1 && d.markVisible === false && d.ghostSource === 'model', 'model entry: mark slot reserved but hidden', d)
    await shot('ring-auto')
    return { ring: s.sources, chip: '1/4' }
  })
  await step('ring-model-calls', async () => {
    assert(ringReady, 'ring-auto ran')
    // A new turn: exactly one model call, the auto suggestion still comes from the model.
    await clearDraft()
    const mockBefore = await mockPredictCount()
    const c0 = await counters()
    await sendTurn(HABIT) // third time; still a habit phrase
    const { s } = await waitGhost(25000, (st) => st.candidates.length > 1)
    await sleep(800)
    const mockDelta = (await mockPredictCount()) - mockBefore
    const c1 = await counters()
    assert(mockDelta === 1, `one model request for the automatic prediction (saw ${mockDelta})`)
    assert(c1.providerCalls - c0.providerCalls === 1, 'providerCalls +1')
    assert(s.sources[0] === 'model' && s.text === MODEL_TEXT, 'automatic suggestion is the model one even though a habit phrase exists')
    return { mockRequests: mockDelta, providerCalls: c1.providerCalls - c0.providerCalls }
  })

  // ── 6. walk the ring with Alt+\ ────────────────────────────────────────────
  await step('ring-walk', async () => {
    assert(ringReady, 'ring-auto ran')
    const mockBefore = await mockPredictCount()
    const c0 = await counters()
    const b0 = (await statusValue()).budget.requests
    const seen = []
    const expect = [
      { text: HABIT, source: 'habit', hint: ZH['ghost.localHabit'], index: 1 },
      { text: P3, source: 'pinned', hint: ZH['ghost.localPinned'], index: 2 },
      { text: P2, source: 'pinned', hint: ZH['ghost.localPinned'], index: 3 },
    ]
    for (const want of expect) {
      await press('Alt+Backslash')
      await sleep(350)
      const s = await assistState()
      const d = await dom()
      assert(s.text === want.text && s.candidateIndex === want.index, `ring entry ${want.index}`, { index: s.candidateIndex })
      assert(d.ghostSource === want.source, 'ghost source attribute', d.ghostSource)
      assert(d.markKind === want.source && d.markVisible, 'mark shown for the entry', d)
      assert(d.markTitle === want.hint, 'mark tooltip text', d.markTitle)
      assert(d.chipTitle.startsWith(want.hint), 'chip tooltip leads with the local hint', d.chipTitle)
      assert(d.chipText.replace(/\s/g, '') === `${ZH['ghost.another']}${want.index + 1}/4`, 'chip position', d.chipText)
      seen.push({ source: want.source, position: `${want.index + 1}/4` })
    }
    const mockDelta = (await mockPredictCount()) - mockBefore
    const c1 = await counters()
    const b1 = (await statusValue()).budget.requests
    assert(mockDelta === 0, `no model request while inside the ring (saw ${mockDelta})`)
    assert(c1.providerCalls === c0.providerCalls, 'providerCalls unchanged')
    assert(b1 === b0, 'daily request count unchanged')
    await shot('ring-walk-last-entry')
    return { walked: seen, mockRequests: mockDelta, dailyRequestsDelta: b1 - b0 }
  })

  // ── 7. Tab on a pinned phrase ──────────────────────────────────────────────
  await step('tab-pinned', async () => {
    assert(ringReady, 'ring-auto ran')
    const s0 = await assistState()
    assert(s0.sources[s0.candidateIndex] === 'pinned', 'a pinned entry is on screen')
    const promptBefore = net.promptish
    await press('Tab')
    await sleep(400)
    const d = await dom()
    const s = await assistState()
    assert(d.draft === s0.text && d.draft === P2, 'the draft is exactly the pinned phrase')
    assert(!d.ghost, 'ghost gone after Tab')
    assert(s.status === 'accepted', 'status accepted', s.status)
    await sleep(1200)
    assert(net.promptish === promptBefore, 'nothing was sent')
    const stillThere = (await dom()).draft === P2
    assert(stillThere, 'the draft stays in the input box')
    await clearDraft()
    return { draftEqualsPinned: true, sent: net.promptish - promptBefore }
  })

  // ── 8. statistics: own-phrase count ────────────────────────────────────────
  await step('stats-own', async () => {
    assert(ringReady, 'ring-auto ran')
    const sum = await summary()
    assert(sum && sum.acceptedBySource && sum.acceptedBySource.pinned >= 1, 'summary counts a pinned acceptance', sum?.acceptedBySource)
    await openSettings()
    await page.locator(sel('refreshResults')).click().catch(() => {})
    await sleep(1200)
    const text = await page.locator(sel('results')).innerText()
    const own = fmt(ZH['settings.resultAcceptedOwn'], { n: sum.acceptedBySource.habit + sum.acceptedBySource.pinned })
    assert(text.includes(own.replace(/^，/, '')), 'results card names the own-phrase count', text.slice(0, 600).replace(/\d+/g, '#'))
    assert(text.includes(ZH['settings.resultAcceptedOf'].replace(/^，/, '').trim()), 'acceptance rate label says it is for model suggestions')
    await page.locator(sel('results')).scrollIntoViewIfNeeded().catch(() => {})
    await shot('stats-own')
    await loadApp() // back to the conversation
    return { ownAccepted: sum.acceptedBySource.habit + sum.acceptedBySource.pinned, acceptedBySource: sum.acceptedBySource }
  })

  // The reload above may land in another session: make the habit phrase exist in the one used from here on.
  await step('habit-session', async () => {
    await mockControl({ predictMode: 'json' })
    await newSession()
    await sendTurn(HABIT)
    await sendTurn(HABIT)
    const { s } = await waitGhost(25000, (st) => st.candidates.length > 1)
    assert(s.sources.includes('habit') && s.sources.includes('pinned'), 'ring has habit and pinned entries', s.sources)
    return { ring: s.sources }
  })

  // ── 9. automatic prediction, unusable reply: nothing on screen ─────────────
  await step('auto-unusable', async () => {
    await mockControl({ predictMode: 'invalid' })
    const c0 = await counters()
    const fb0 = c0.localFallbacks ?? 0
    await sendTurn('先看一下目录结构')
    const { s, d } = await waitIdleNoGhost(3500)
    const c1 = await counters()
    assert(c1.providerCalls - c0.providerCalls === 1, 'the automatic prediction called the model once')
    assert(c1.outputRejects - c0.outputRejects === 1, 'the reply was rejected')
    assert(!d.ghost && s.status !== 'offered', 'no suggestion on screen', { status: s.status })
    assert(d.notice === null, 'no "no suggestion" notice either', d.notice)
    assert((c1.localFallbacks ?? 0) === fb0, 'no local fallback for an automatic prediction')
    return { providerCalls: 1, outputRejects: 1, onScreen: false }
  })

  // ── 10. manual fallback after an unusable reply ────────────────────────────
  await step('manual-fallback', async () => {
    const mockBefore = await mockPredictCount()
    const c0 = await counters()
    const b0 = (await statusValue()).budget.requests
    await press('Alt+Backslash')
    const { s, d } = await waitGhost(15000)
    await sleep(500)
    const c1 = await counters()
    const b1 = (await statusValue()).budget.requests
    const mockDelta = (await mockPredictCount()) - mockBefore
    assert(s.sources.every((x) => x !== 'model'), 'ring holds local phrases only', s.sources)
    assert(s.text === HABIT && s.sources[0] === 'habit', 'first local phrase is offered', s.sources)
    assert(d.markVisible && d.markKind === 'habit' && d.markTitle === ZH['ghost.localHabit'], 'mark and tooltip on the local entry', d)
    assert(d.notice === null, 'no "no suggestion" notice', d.notice)
    assert(mockDelta === 1, `the manual call did reach the model (saw ${mockDelta})`)
    assert(c1.providerCalls - c0.providerCalls === 1, 'providerCalls +1')
    assert((c1.localFallbacks ?? 0) - (c0.localFallbacks ?? 0) === 1, 'localFallbacks +1')
    assert(b1 - b0 === 1, `daily request count +1 because the model was called (saw ${b1 - b0})`)
    await shot('manual-fallback')
    // Walking the fallback ring stays local.
    await press('Alt+Backslash')
    await sleep(350)
    const next = await assistState()
    assert(next.sources[next.candidateIndex] === 'pinned', 'Alt+\\ goes on to a pinned phrase locally')
    assert((await mockPredictCount()) - mockBefore === 1, 'walking the fallback ring makes no model call')
    return { ring: s.sources, mockRequests: mockDelta, dailyRequestsDelta: b1 - b0, localFallbacksDelta: 1 }
  })

  // ── 11. manual fallback with the daily limit used up ───────────────────────
  await step('manual-exhausted', async () => {
    await mockControl({ predictMode: 'json' })
    const used = (await statusValue()).budget.requests
    await setConfig({ dailyRequestLimit: Math.max(1, used) })
    try {
      const c0 = await counters()
      const mockBefore = await mockPredictCount()
      await sendTurn('再确认一下范围')
      const auto = await waitIdleNoGhost(2500)
      assert(!auto.d.ghost, 'automatic prediction over the limit shows nothing', auto.s.status)
      const b0 = (await statusValue()).budget.requests
      await press('Alt+Backslash')
      const { s, d } = await waitGhost(10000)
      await sleep(500)
      const c1 = await counters()
      const b1 = (await statusValue()).budget.requests
      assert(s.sources.every((x) => x !== 'model') && s.sources.length >= 2, 'local phrases offered', s.sources)
      assert(d.markVisible, 'mark shown', d)
      assert((await mockPredictCount()) === mockBefore, 'no model request at all')
      assert(c1.providerCalls === c0.providerCalls, 'providerCalls unchanged')
      assert(b1 === b0, 'daily request count unchanged')
      assert((c1.localFallbacks ?? 0) - (c0.localFallbacks ?? 0) === 1, 'localFallbacks +1')
      await shot('manual-exhausted')
      return { ring: s.sources, mockRequests: 0, dailyRequestsDelta: b1 - b0 }
    } finally {
      await setConfig({ dailyRequestLimit: 200 })
    }
  })

  // ── 12. narrow input box with a marked entry ───────────────────────────────
  await step('narrow-marked', async () => {
    await setConfig({ pinnedPhrases: [P3, P2, LONG_PINNED] })
    await sendTurn('请再回复一次：收到')
    await waitGhost(25000, (st) => st.candidates.length > 1)
    const editor = page.locator('[data-composer-input]').first()
    const originalWidth = await editor.evaluate((input) => input.style.maxWidth)
    const widths = []
    const check = async (label) => {
      const m = await page.evaluate(() => {
        const ghost = document.querySelector('[data-nmp-ghost]')
        const adopt = document.querySelector('[data-nmp-adopt]')
        const another = document.querySelector('[data-nmp-another]')
        const markEl = document.querySelector('[data-nmp-source-mark]')
        const card = document.querySelector('[data-composer-card]')
        const r = (el) => (el ? el.getBoundingClientRect() : null)
        const g = r(ghost), a = r(adopt), n = r(another), c = r(card), mk = r(markEl)
        return { g, a, n, c, mk, anotherLines: another ? Math.round(n.height / 18) : 0 }
      })
      assert(m.g && m.a && m.n && m.c, `${label}: ghost and both chips exist`)
      assert(m.n.right <= m.g.right + 0.5 && m.a.right <= m.n.left + 0.5, `${label}: chips stay inside the ghost row without overlapping`, { ghostRight: m.g.right, chipRight: m.n.right })
      assert(m.n.right <= m.c.right + 0.5 && m.n.left >= m.c.left - 0.5, `${label}: chip inside the composer card`)
      assert(m.n.height <= 26 && m.a.height <= 26, `${label}: chips are one line high`, { another: m.n.height, adopt: m.a.height })
      assert(m.mk && m.mk.width > 0 && m.mk.right <= m.n.right && m.mk.left >= m.n.left, `${label}: mark inside the chip`)
      widths.push(Math.round(m.n.width * 10) / 10)
      return { chipWidth: m.n.width, chipHeight: m.n.height, ghostWidth: m.g.width }
    }
    const rows = []
    try {
      await editor.evaluate((input) => { input.style.maxWidth = '200px' })
      await sleep(500)
      rows.push(await check('model entry'))
      for (let i = 1; i < 5; i += 1) {
        await pressFocused('Alt+Backslash')
        await sleep(400)
        const s = await assistState()
        if (i === 4) assert(s.text === LONG_PINNED && s.sources[s.candidateIndex] === 'pinned', 'long pinned entry on screen')
        rows.push(await check(`entry ${i + 1}`))
      }
      await shot('narrow-marked')
    } finally {
      await editor.evaluate((input, width) => { input.style.maxWidth = width }, originalWidth)
    }
    const spread = Math.max(...widths) - Math.min(...widths)
    assert(spread <= 2.5, `chip width does not jump while stepping (spread ${spread}px)`, widths)
    await clearDraft()
    return { entries: rows.length, chipWidthSpreadPx: spread, maxChipHeightPx: Math.max(...rows.map((r) => r.chipHeight)) }
  })

  // ── 13. statistics survive a settings save ─────────────────────────────────
  // Saving any setting restarts the Host half and changes the configuration revision, so the page
  // withdraws the suggestion on screen (it reports that as "closed"). What must survive the restart
  // is the Host's record of that suggestion: its closing is counted, and the next message is scored.
  await step('save-keeps-stats', async () => {
    await setConfig({ pinnedPhrases: [P3, P2] })
    await mockControl({ predictMode: 'json' })
    await sendTurn('接着往下做')
    const shown = await waitGhost(25000)
    assert(shown.s.sources[0] === 'model', 'a model suggestion is on screen')
    await sleep(900) // let the "shown" report reach the Host
    const before = await summary()
    const terminal = (x) => (x.dismissed ?? 0) + (x.overwritten ?? 0) + (x.expired ?? 0) + (x.closed ?? 0) + (x.accepted ?? 0)
    const eventsBeforeSave = (await eventsLines()).length
    await setConfig({ triggerDelayMs: 300 }) // any setting: restarts the Host half of the plugin
    const afterSave = await assistState()
    const withdrawn = afterSave.status !== 'offered'
    await sleep(1200)
    const mid = await summary()
    assert(terminal(mid) === terminal(before) + 1, `the suggestion's closing was recorded after the restart (before ${terminal(before)}, after ${terminal(mid)})`, { withdrawn })
    // The next message is compared with that suggestion.
    await sendTurn('接着往下做完')
    await sleep(1500)
    const lines = (await eventsLines()).slice(eventsBeforeSave)
    const matchLines = lines.filter((l) => l.includes('"kind":"match"')).length
    assert(matchLines >= 1, 'the next message was scored against the suggestion that was on screen during the save', { matchLines })
    const after = await summary()
    await setConfig({ triggerDelayMs: 250 })
    return {
      suggestionWithdrawnOnSave: withdrawn,
      closingRecorded: terminal(mid) - terminal(before),
      shownBefore: before.shown, shownAfterNextTurn: after.shown,
      matchLinesAfterSave: matchLines,
      note: 'accepting after the save is not possible: the page withdraws the offer when the configuration revision changes',
    }
  })

  // ── 14. nothing local: behaviour as before ─────────────────────────────────
  await step('no-local', async () => {
    await setConfig({ pinnedPhrases: [], habitSuggestions: false, multiCandidates: true, candidateCount: 3 })
    await mockControl({ predictMode: 'json', predictReply: JSON.stringify({ suggestions: ['先看测试结果', '再检查一遍边界', '把差异列出来'] }) })
    await sendTurn('好，继续吧')
    const first = await waitGhost(25000)
    assert(first.d.markCount === 0, 'no mark element at all', first.d.markCount)
    assert(first.s.sources.every((x) => x === 'model'), 'only model entries', first.s.sources)
    const mockBefore = await mockPredictCount()
    // The ring is the model's candidates only: stepping past them asks the model again.
    for (let i = 0; i < 6; i += 1) {
      await press('Alt+Backslash')
      await sleep(500)
      const d = await dom()
      assert(d.markCount === 0, 'still no mark while stepping')
      assert(d.ghostSource === 'model' || d.ghostSource === null, 'source stays model')
    }
    const s = await assistState()
    assert(s.sources.every((x) => x === 'model'), 'ring has model entries only after stepping', s.sources)
    const mockDelta = (await mockPredictCount()) - mockBefore
    assert(mockDelta >= 1, 'the model is asked for candidates (manual call)')
    assert(mockDelta <= 3, 'manual calls stay within the per-reply limit', mockDelta)
    await clearDraft()
    return { candidates: s.candidates.length, modelRequestsWhileStepping: mockDelta, marks: 0 }
  })

  // ── 15. AltGr (synthetic) ──────────────────────────────────────────────────
  await step('altgr-synthetic', async () => {
    await mockControl({ predictMode: 'json', predictReply: DEFAULT_PREDICT })
    await setConfig({ multiCandidates: false })
    await sendTurn('最后确认一下')
    await waitGhost(25000)
    await press('Escape')
    await sleep(500)
    const cfg = await currentConfig()
    assert(cfg.predictShortcut === 'Alt+Backslash', 'configured shortcut is the default', cfg.predictShortcut)
    assert(!(await dom()).ghost, 'suggestion dismissed before the test')
    const fire = (altGraph) =>
      page.evaluate((state) => {
        const input = document.querySelector('[data-composer-input]')
        input.focus()
        const event = new KeyboardEvent('keydown', { key: '\\', code: 'Backslash', altKey: true, ctrlKey: state, bubbles: true, cancelable: true })
        Object.defineProperty(event, 'getModifierState', { value: (name) => state && name === 'AltGraph' })
        input.dispatchEvent(event)
        return event.defaultPrevented
      }, altGraph)
    const mockBefore = await mockPredictCount()
    const c0 = await counters()
    const prevented = await fire(true)
    await sleep(1800)
    const c1 = await counters()
    const d = await dom()
    assert(prevented === false, 'the AltGr keydown was not swallowed')
    assert((await mockPredictCount()) === mockBefore && c1.providerCalls === c0.providerCalls, 'no model request from AltGr')
    assert(d.notice !== 'predicting' && !d.ghost, 'no prediction started', d.notice)
    // Control: the same event without AltGraph is the shortcut and does predict.
    const preventedPlain = await fire(false)
    await waitGhost(15000).catch(() => null)
    const c2 = await counters()
    assert(preventedPlain === true && c2.providerCalls - c1.providerCalls === 1, 'the control event (no AltGraph) did trigger a prediction', { preventedPlain })
    return { synthetic: true, altGraphPrevented: prevented, controlTriggered: true, note: 'synthetic KeyboardEvent; not verified on a real AltGr keyboard layout' }
  })

  // ── events.jsonl: counts only, and no text ─────────────────────────────────
  await step('events-file', async () => {
    const lines = (await eventsLines()).slice(eventsBefore)
    const texts = [HABIT, P1, P2, P3, LONG_PINNED, MODEL_TEXT, '先看测试结果']
    const leaked = lines.filter((line) => texts.some((text) => line.includes(text))).length
    const parsed = lines.map((line) => { try { return JSON.parse(line) } catch { return {} } })
    const count = (pred) => parsed.filter(pred).length
    assert(leaked === 0, 'no phrase or suggestion text in events.jsonl', leaked)
    const result = {
      lines: lines.length,
      requestsWithFallback: count((r) => r.kind === 'request' && r.fb === true),
      requestsWithPinned: count((r) => r.kind === 'request' && r.np > 0),
      requestsWithHabit: count((r) => r.kind === 'request' && r.nh > 0),
      acceptedBySource: {
        model: count((r) => r.kind === 'outcome' && r.event === 'accepted' && r.source === 'model'),
        habit: count((r) => r.kind === 'outcome' && r.event === 'accepted' && r.source === 'habit'),
        pinned: count((r) => r.kind === 'outcome' && r.event === 'accepted' && r.source === 'pinned'),
      },
      matchesWithNomodel: count((r) => r.kind === 'match' && r.nomodel === true),
      matchesWithLocal: count((r) => r.kind === 'match' && typeof r.local !== 'undefined'),
    }
    return result
  })
} catch (error) {
  report.error = String(error?.stack ?? error).slice(0, 2000)
  await shot('99-failure')
} finally {
  // ── restore ──
  try {
    if (baseline !== null) {
      await setConfig({
        pinnedPhrases: [], language: baseline.language ?? 'auto', sidebarEntry: baseline.sidebarEntry ?? false, habitSuggestions: baseline.habitSuggestions ?? true,
        multiCandidates: baseline.multiCandidates ?? true, candidateCount: baseline.candidateCount ?? 3, manualLimit: baseline.manualLimit ?? 3,
        dailyRequestLimit: baseline.dailyRequestLimit ?? 200, dailyTokenBudget: baseline.dailyTokenBudget ?? 500000, triggerDelayMs: baseline.triggerDelayMs ?? 250,
        timeoutMs: baseline.timeoutMs ?? 8000, manualOnly: baseline.manualOnly ?? false, showPredictButton: baseline.showPredictButton ?? true,
      })
      const now = await currentConfig()
      report.steps.restore = {
        ok: now.pinnedPhrases.length === 0 && now.language === (baseline.language ?? 'auto') && now.sidebarEntry === (baseline.sidebarEntry ?? false),
        pinnedPhrases: now.pinnedPhrases.length,
        language: now.language,
        sidebarEntry: now.sidebarEntry,
      }
    }
    await mockControl({ reply: CHAT_REPLY, predictMode: 'json', predictReply: DEFAULT_PREDICT })
  } catch (error) {
    report.steps.restore = { ok: false, error: String(error?.message ?? error).slice(0, 300) }
  }
  report.net = { configSets: net.configSets, predictRequests: net.predicts, promptRequests: net.promptish }
  report.ok = !report.error && Object.values(report.steps).length > 0 && Object.values(report.steps).every((s) => s.ok === true)
  report.finishedAt = new Date().toISOString()
  await browser.close().catch(() => {})
  const reportPath = path.join(out, `${tag}-report.json`)
  await writeFile(reportPath, JSON.stringify(report, null, 2)).catch(() => {})
  console.log(
    JSON.stringify(
      {
        ok: report.ok,
        out: reportPath,
        steps: Object.fromEntries(Object.entries(report.steps).map(([k, v]) => [k, v.ok])),
        failed: Object.entries(report.steps).filter(([, v]) => !v.ok).map(([k, v]) => `${k}: ${v.error}`),
        error: report.error ?? null,
      },
      null,
      2,
    ),
  )
  if (!report.ok) process.exitCode = 1
}
