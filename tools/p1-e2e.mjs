#!/usr/bin/env node
/**
 * P1 end-to-end interaction matrix for dsh-next-message-predictor.
 *
 * Drives the isolated scratch-profile Web GUI with playwright-core (located by
 * tools/lib/local-env.mjs) and verifies, against a real
 * finished assistant turn produced by the local mock LLM:
 *
 *   1. auto trigger paints exactly one ghost suggestion after a turn finishes;
 *   2. Tab adopts via the native captureInsertion/insertText path into the draft
 *      (ghost is not editor content, nothing is sent);
 *   3. Ctrl+Z removes only the insertion and does not resurrect the offer;
 *   4. Esc dismisses and does not revive the offer for that turn;
 *   5. IME composition hides the ghost and blocks adoption;
 *   6. the `/` menu hides the ghost and Tab keeps native menu behavior;
 *   7. a second (dummy) focused input is not served; refocusing the composer
 *      restores the still-valid offer;
 *   8. uninstall leaves no anchor/global/route (separate --mode uninstalled run);
 *   9. code path + network + host counters prove zero send/prompt calls.
 *
 * Usage:
 *   node tools/p1-e2e.mjs --url "<scratch URL>" [--out scratch/evidence] [--tag p1]
 *                         [--mode matrix|uninstalled] [--headful] [--timeout 30000]
 *                         [--keep-open] [--fake "鍥哄畾娴嬭瘯寤鸿"]
 *
 * Environment: the mock LLM (tools/mock-llm.mjs) must be running and the
 * predictor-scratch profile must route agent-default-model to it.
 */
import { browserPath, loadChromium, loadPlaywright } from './lib/local-env.mjs'
import { mkdir, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'


const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..')

function parseArgs(argv) {
  const opts = {
    url: '',
    out: '',
    tag: 'p1',
    mode: 'matrix',
    headless: true,
    timeout: 30000,
    keepOpen: false,
    fake: '',
  }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`missing value for ${a}`)
      return argv[++i]
    }
    switch (a) {
      case '--url': opts.url = next(); break
      case '--out': opts.out = next(); break
      case '--tag': opts.tag = next(); break
      case '--mode': opts.mode = next(); break
      case '--headful': opts.headless = false; break
      case '--timeout': opts.timeout = Number(next()); break
      case '--keep-open': opts.keepOpen = true; break
      case '--fake': opts.fake = next(); break
      default: throw new Error(`unknown argument: ${a}`)
    }
  }
  if (!opts.url) throw new Error('--url is required')
  if (!['matrix', 'uninstalled'].includes(opts.mode)) throw new Error(`invalid --mode ${opts.mode}`)
  if (!opts.out) opts.out = path.join(repoRoot, 'scratch', 'evidence')
  return opts
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Static proof that the browser half has no send/submit code path. */
function codePathCheck() {
  const forbidden = [
    /\.submit\s*\(/u,
    /session\/prompt/u,
    /sendSession/u,
    /beginSubmission/u,
    /submitMessage/u,
  ]
  const files = [
    'src/client/controller.js',
    'src/client/overlay.js',
    'src/client/settings.js',
    'src/client/index.js',
    'src/client/dom.js',
    'src/shared/protocol.js',
    'src/shared/config.js',
    'src/shared/output-validation.js',
  ]
  const hits = []
  for (const rel of files) {
    const text = readFileSync(path.join(repoRoot, rel), 'utf8')
    for (const pattern of forbidden) {
      if (pattern.test(text)) hits.push({ file: rel, pattern: String(pattern) })
    }
  }
  return { ok: hits.length === 0, hits, files }
}

function readStateExpr() {
  return `(() => {
    try {
      const api = window.__nextMessagePredictor
      if (!api) return { present: false }
      const state = api.state()
      return {
        present: true,
        status: state.assist.status,
        reason: state.assist.reason,
        text: state.assist.text,
        suggestionId: state.assist.suggestionId,
        sessionId: state.assist.sessionId,
        turnId: state.assist.turnId,
        env: state.env
          ? {
              sessionId: state.env.sessionId,
              turnId: state.env.turnId,
              running: state.env.running,
              hasFinalText: state.env.hasFinalText,
              draft: state.env.draft,
              canEdit: state.env.canEdit,
              focused: state.env.focused,
              composing: state.env.composing,
              menuOpen: state.env.menuOpen,
              queuedCount: state.env.queuedCount,
              phase: state.env.phase,
            }
          : null,
        config: {
          ready: state.config.ready,
          enabled: state.config.config ? state.config.config.enabled : null,
          revision: state.config.revision,
          hostError: state.config.hostError,
        },
      }
    } catch (error) {
      return { present: true, error: String(error) }
    }
  })()`
}

function domStateExpr() {
  return `(() => {
    const input = document.querySelector('[data-composer-input]')
    const card = input ? input.closest('[data-composer-card]') : null
    const ghost = document.querySelector('[data-nmp-ghost]')
    const anchor = document.querySelector('[data-nmp-anchor]')
    const placeholder = card ? card.querySelector('[data-composer-placeholder]') : null
    const ghostRect = ghost ? ghost.getBoundingClientRect() : null
    return {
      inputPresent: Boolean(input),
      inputEditable: input ? input.isContentEditable : false,
      inputPhase: input ? input.getAttribute('data-phase') : null,
      inputAriaDisabled: input ? input.getAttribute('aria-disabled') : null,
      draftText: input ? input.textContent : null,
      activeIsInput: input ? document.activeElement === input : false,
      activeTag: document.activeElement ? document.activeElement.tagName : null,
      ghostPresent: Boolean(ghost),
      ghostVisible: ghostRect ? ghostRect.width > 0 && ghostRect.height > 0 : false,
      ghostText: ghost ? ghost.textContent : null,
      ghostMarker: ghost ? ghost.getAttribute('data-composer-ghost') : null,
      ghostInsideEditor: input && ghost ? input.contains(ghost) : null,
      anchorPresent: Boolean(anchor),
      placeholderPresent: Boolean(placeholder),
      placeholderHiddenByUs: placeholder ? placeholder.hasAttribute('data-nmp-placeholder') : null,
      placeholderVisibility: placeholder ? placeholder.style.visibility : null,
      triggerMenuOpen: Boolean(document.querySelector('[data-trigger-menu]')),
    }
  })()`
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  await mkdir(opts.out, { recursive: true })
  const report = {
    driver: 'tools/p1-e2e.mjs',
    mode: opts.mode,
    url: opts.url,
    startedAt: new Date().toISOString(),
    codePath: codePathCheck(),
    steps: {},
    console: [],
    pageErrors: [],
    network: { requests: [], framesSent: [], framesReceived: [] },
    ok: false,
  }

  const chromium = loadChromium()
  report.playwrightCore = loadPlaywright().version

  const browser = await chromium.launch({
    executablePath: browserPath(),
    headless: opts.headless,
    args: ['--disable-gpu', '--no-first-run', '--no-default-browser-check'],
  })
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 })
  const page = await context.newPage()
  page.setDefaultTimeout(opts.timeout)
  page.on('console', (msg) => {
    if (report.console.length < 400) report.console.push({ type: msg.type(), text: msg.text().slice(0, 2000) })
  })
  page.on('pageerror', (err) => report.pageErrors.push(String(err).slice(0, 4000)))
  page.on('request', (request) => {
    if (report.network.requests.length < 500) {
      report.network.requests.push({
        at: Date.now(),
        method: request.method(),
        url: request.url().slice(0, 500),
        body: (request.postData() ?? '').slice(0, 2000),
      })
    }
  })
  page.on('websocket', (ws) => {
    ws.on('framesent', (frame) => {
      const payload = typeof frame.payload === 'string' ? frame.payload : Buffer.from(frame.payload).toString('utf8')
      if (report.network.framesSent.length < 500) {
        report.network.framesSent.push({ at: Date.now(), payload: payload.slice(0, 3000) })
      }
    })
    ws.on('framereceived', (frame) => {
      const payload = typeof frame.payload === 'string' ? frame.payload : Buffer.from(frame.payload).toString('utf8')
      if (report.network.framesReceived.length < 500) {
        report.network.framesReceived.push({ at: Date.now(), payload: payload.slice(0, 2000) })
      }
    })
  })

  const cdp = await context.newCDPSession(page)
  const state = () => page.evaluate(readStateExpr())
  const dom = () => page.evaluate(domStateExpr())
  const shot = async (name) => {
    const file = path.join(opts.out, `${opts.tag}-${name}.png`)
    await page.screenshot({ path: file })
    return file
  }
  const assert = (condition, message, details) => {
    if (!condition) {
      const error = new Error(`assertion failed: ${message}`)
      error.details = details
      throw error
    }
  }
  const step = async (name, fn) => {
    const started = Date.now()
    try {
      const value = await fn()
      report.steps[name] = { ok: true, ms: Date.now() - started, value: value ?? null }
      return value
    } catch (error) {
      report.steps[name] = {
        ok: false,
        ms: Date.now() - started,
        error: String(error?.stack ?? error).slice(0, 4000),
        details: error?.details ?? null,
      }
      throw error
    }
  }

  // ---- shared UI helpers ---------------------------------------------------
  const dismissPreview = async () => {
    const dialogs = page.locator('[role="dialog"]')
    const count = await dialogs.count()
    for (let i = 0; i < count; i += 1) {
      const dialog = dialogs.nth(i)
      const text = (await dialog.innerText().catch(() => '')) ?? ''
      if (!/棰勮鐗堣鏄巪preview/i.test(text)) continue
      const continueButton = dialog.locator('button', { hasText: /\u7ee7\u7eed|Continue|OK|\u77e5\u9053\u4e86/ }).first()
      if (await continueButton.count()) {
        await continueButton.click({ force: true })
        await sleep(600)
        return true
      }
    }
    // Fallback: any modal with a continue-style button.
    return false
  }

  const ensureComposer = async () => {
    await dismissPreview()
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const d = await dom()
      if (d.inputPresent && d.inputEditable) return d
      // Enable the composer through the workspace picker when it is disabled.
      const picker = page.locator('[role="textbox"][contenteditable="false"]').first()
      if (await picker.count()) {
        await picker.click({ force: true }).catch(() => {})
        await sleep(700)
        await dismissPreview()
        const options = page.locator('[role="presentation"] button')
        const n = await options.count()
        if (n > 0) {
          // Prefer an option whose text does not look like "create new".
          let clicked = false
          for (let i = 0; i < n; i += 1) {
            const text = ((await options.nth(i).innerText().catch(() => '')) ?? '').trim()
            if (text !== '' && !/鏂板缓|鍒涘缓|new|create|閫夋嫨|choose/i.test(text)) {
              await options.nth(i).click({ force: true }).catch(() => {})
              clicked = true
              break
            }
          }
          if (!clicked) await options.first().click({ force: true }).catch(() => {})
          await sleep(900)
          await dismissPreview()
        }
      }
      await sleep(400)
    }
    const d = await dom()
    assert(d.inputPresent && d.inputEditable, 'composer input is editable', d)
    return d
  }

  const focusComposer = async () => {
    await page.locator('[data-composer-input]').first().click({ force: true })
    await sleep(150)
    const d = await dom()
    assert(d.activeIsInput === true, 'composer input holds focus', d)
  }

  const clearDraft = async () => {
    await focusComposer()
    await page.keyboard.press('Control+A')
    await page.keyboard.press('Delete')
    await sleep(150)
  }

  /** Send one message and wait for the turn to start and finish. */
  const sendTurn = async (label) => {
    await ensureComposer()
    await focusComposer()
    await clearDraft()
    const before = await state()
    const turnBefore = before.env ? before.env.turnId : ''
    await page.keyboard.type(label, { delay: 8 })
    await page.keyboard.press('Enter')
    // Wait for running to become true (turn started)
    let sawRunning = false
    for (let i = 0; i < 80; i += 1) {
      const s = await state()
      if (s.env && s.env.running === true) {
        sawRunning = true
        break
      }
      await sleep(100)
    }
    assert(sawRunning, `turn started for "${label}"`, await state())
    // 鈥hen wait for the assistant turn to finish and the client to see it.
    let finished = null
    for (let i = 0; i < 200; i += 1) {
      const s = await state()
      if (s.env && s.env.running === false && s.env.turnId !== '' && s.env.turnId !== turnBefore && s.env.hasFinalText === true) {
        finished = s
        break
      }
      await sleep(100)
    }
    assert(finished !== null, `turn finished with final assistant text for "${label}"`, await state())
    return finished
  }

  /** Wait until the offered ghost is painted with visible text. */
  const waitForGhost = async (expectText) => {
    let last = null
    for (let i = 0; i < 120; i += 1) {
      const s = await state()
      const d = await dom()
      last = { state: s, dom: d }
      const suggestion = typeof s.text === 'string' ? s.text : ''
      if (
        d.ghostPresent === true &&
        d.ghostVisible === true &&
        s.status === 'offered' &&
        suggestion !== '' &&
        (d.ghostText ?? '').includes(suggestion) &&
        (expectText === undefined || suggestion.includes(expectText))
      ) {
        return last
      }
      await sleep(100)
    }
    throw Object.assign(new Error('ghost suggestion did not appear'), { details: last })
  }

  const wait = async (ms) => sleep(ms)

  try {
    // ---- code path check ---------------------------------------------------
    report.steps.codePath = report.codePath
    assert(report.codePath.ok, 'no send/submit code path in the browser half', report.codePath)

    // ---- 0. load -----------------------------------------------------------
    await step('load', async () => {
      const response = await page.goto(opts.url, { waitUntil: 'domcontentloaded', timeout: opts.timeout })
      await page.waitForFunction(
        () =>
          Boolean(globalThis.__DSH_BOOT__) ||
          Boolean(document.querySelector('[data-composer-input]')) ||
          Boolean(document.querySelector('[role="textbox"]')),
        undefined,
        { timeout: opts.timeout },
      )
      if (opts.mode === 'uninstalled') {
        // 卸载态下不依赖 composer/插件运行时，只确认应用已启动。
        await sleep(800)
        return { status: response?.status() ?? null, url: page.url() }
      }
      const ready = await ensureComposer()
      await sleep(600)
      const s = await state()
      assert(s.present === true, 'predictor client runtime is mounted', s)
      assert(s.config && s.config.ready === true, 'predictor config loaded from Host', s)
      return {
        status: response?.status() ?? null,
        url: page.url(),
        input: ready,
        assist: { status: s.status, config: s.config },
      }
    })
    await shot('00-loaded')

    if (opts.mode === 'uninstalled') {
      // ---- uninstall cleanup ----------------------------------------------
      await step('uninstalled', async () => {
        await sleep(500)
        const d = await dom()
        const s = await state()
        assert(d.anchorPresent === false, 'no overlay anchor after uninstall', d)
        assert(d.ghostPresent === false, 'no ghost after uninstall', d)
        assert(s.present === false, 'no debug global after uninstall', s)
        const route = await page.evaluate(async () => {
          try {
            const response = await fetch('/api/next-message-predictor/rpc', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ schemaVersion: 1, operation: 'status' }),
            })
            return { status: response.status }
          } catch (error) {
            return { status: 0, error: String(error) }
          }
        })
        assert(route.status === 404, 'plugin route is gone after uninstall', route)
        return { dom: d, route }
      })
      await shot('99-uninstalled')
      report.ok = true
      return
    }

    // ---- 1. auto trigger + ghost ------------------------------------------
    await step('auto-trigger', async () => {
      const expected = opts.fake || ''
      const finished = await sendTurn('\u8bf7\u56de\u590d\uff1a\u6536\u5230')
      const ghost = await waitForGhost()
      // The ghost node also contains the adoption hint button; the suggestion
      // body is the controller's offer text.
      const text = ghost.state.text
      assert(text !== '', 'ghost has suggestion text', ghost)
      assert((ghost.dom.ghostText ?? '').includes(text), 'painted ghost shows the suggestion text', {
        ghostText: ghost.dom.ghostText,
        text,
      })
      assert(ghost.dom.ghostInsideEditor === false, 'ghost is outside the contenteditable', ghost)
      assert(ghost.dom.ghostMarker === 'dsh-next-message-predictor', 'citizen ghost marker set', ghost)
      assert(ghost.dom.placeholderHiddenByUs === true, 'native placeholder hidden while ghost visible', ghost)
      assert(ghost.dom.inputAriaDisabled !== 'true', 'editor is editable', ghost)
      const suggestionCount = await page.evaluate(
        () => document.querySelectorAll('[data-nmp-ghost]').length,
      )
      assert(suggestionCount === 1, 'exactly one ghost suggestion', { suggestionCount })
      if (expected !== '') assert(text.includes(expected), `ghost text matches configured fake suggestion`, { text, expected })
      report.fakeSuggestion = text
      return { text, turnId: finished.env.turnId, placeholderHidden: ghost.dom.placeholderHiddenByUs }
    })
    await shot('01-ghost-visible')

    // ---- 2. Tab adopts into the draft, nothing sent ------------------------
    await step('tab-adopt', async () => {
      const before = await dom()
      const networkBefore = {
        requests: report.network.requests.length,
        framesSent: report.network.framesSent.length,
      }
      const countersBefore = await page.evaluate(async () => {
        const response = await fetch('/api/next-message-predictor/rpc', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ schemaVersion: 1, operation: 'status' }),
        })
        const body = await response.json()
        return body?.value?.diagnostics?.counters ?? null
      })
      await focusComposer()
      const ghostBefore = await dom()
      assert(ghostBefore.ghostVisible === true, 'ghost still visible after refocus', ghostBefore)
      await page.keyboard.press('Tab')
      await sleep(250)
      const after = await dom()
      assert(after.ghostPresent === false, 'ghost removed after Tab', after)
      assert(
        (after.draftText ?? '').includes(report.fakeSuggestion ?? ''),
        'suggestion inserted into the draft',
        { draft: after.draftText, suggestion: report.fakeSuggestion },
      )
      const s = await state()
      assert(s.status === 'accepted', 'controller recorded acceptance', s)
      // Wait past any accidental submit path, then prove nothing was sent.
      await wait(1200)
      const countersAfter = await page.evaluate(async () => {
        const response = await fetch('/api/next-message-predictor/rpc', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ schemaVersion: 1, operation: 'status' }),
        })
        const body = await response.json()
        return body?.value?.diagnostics?.counters ?? null
      })
      const newRequests = report.network.requests.slice(networkBefore.requests)
      const newFrames = report.network.framesSent.slice(networkBefore.framesSent)
      const sendish = newRequests.filter((r) => /session\/prompt|\/prompt\b|submissions/i.test(r.url + ' ' + r.body))
      const sendishFrames = newFrames.filter((f) => /session\/prompt|"prompt"|beginSubmission/i.test(f.payload))
      assert(sendish.length === 0, 'no HTTP prompt/send request after adoption', { sendish })
      assert(sendishFrames.length === 0, 'no prompt/send frame after adoption', { sendishFrames })
      assert(countersAfter !== null && countersAfter.sendCalls === 0, 'host sendCalls counter is zero', countersAfter)
      assert(
        countersAfter !== null && countersAfter.accepts >= 1,
        'host recorded one acceptance',
        { countersAfter, countersBefore },
      )
      const placeholder = await dom()
      return {
        draft: after.draftText,
        countersBefore,
        countersAfter,
        newRequestCount: newRequests.length,
        newFrameCount: newFrames.length,
      }
    })
    await shot('02-tab-adopted')

    // ---- 3. Ctrl+Z removes only the insertion ------------------------------
    await step('undo', async () => {
      await focusComposer()
      await page.keyboard.press('Control+z')
      await sleep(250)
      const after = await dom()
      await sleep(400)
      const later = await dom()
      assert(after.draftText === '', 'undo returned the draft to empty', after)
      assert(later.ghostPresent === false, 'undo does not resurrect the accepted offer', later)
      const s = await state()
      assert(s.status === 'accepted', 'acceptance stays terminal after undo', s)
      return { draft: after.draftText }
    })
    await shot('03-undo-empty')

    // ---- 4. Esc dismisses and never revives that turn ----------------------
    await step('esc-dismiss', async () => {
      await sendTurn('请回复：收到')
      const ghost = await waitForGhost()
      const dismissText = ghost.state.text
      await focusComposer()
      await page.keyboard.press('Escape')
      await sleep(250)
      const after = await dom()
      assert(after.ghostPresent === false, 'Esc removed the ghost', after)
      await sleep(900)
      const later = await dom()
      assert(later.ghostPresent === false, 'Esc does not revive the offer for the turn', later)
      const s = await state()
      assert(s.status === 'dismissed', 'controller recorded dismissal', s)
      return { dismissedText: dismissText, after }
    })
    await shot('04-esc-dismissed')

    // ---- 5. IME composition hides the ghost and blocks adoption ------------
    await step('ime', async () => {
      await sendTurn('请再回复：收到')
      const ghost = await waitForGhost()
      const suggestionText = ghost.state.text
      await focusComposer()
      await cdp.send('Input.imeSetComposition', {
        text: '棰勬祴',
        selectionStart: 2,
        selectionEnd: 2,
        replacementStart: 0,
        replacementEnd: 0,
      })
      await sleep(250)
      const composing = await dom()
      const composingState = await state()
      assert(composing.ghostPresent === false, 'ghost hidden during IME composition', composing)
      const draftDuringComposition = composing.draftText ?? ''
      await page.keyboard.press('Tab')
      await sleep(200)
      const afterTab = await dom()
      assert(
        (afterTab.draftText ?? '').includes(suggestionText) === false,
        'Tab during composition never inserts the suggestion',
        { draft: afterTab.draftText, suggestionText },
      )
      // Commit the composition text, then clear. B06：清空草稿后恢复同一条建议。
      await cdp.send('Input.insertText', { text: '预测' })
      await sleep(200)
      await clearDraft()
      await sleep(500)
      const afterClear = await dom()
      assert(afterClear.ghostPresent === true, 'clearing the draft revives the same suggestion (B06)', afterClear)
      void draftDuringComposition
      void composingState
      return { composing: composingState.env ? composingState.env.composing : null, draftDuringComposition }
    })
    await shot('05-ime-suppressed')

    // ---- 6. `/` menu hides the ghost and keeps native menu behavior --------
    await step('menu', async () => {
      await sendTurn('请第三次回复：收到')
      const ghost = await waitForGhost()
      const suggestionText = ghost.state.text
      await focusComposer()
      await page.keyboard.type('/')
      await sleep(400)
      const opened = await dom()
      assert(opened.triggerMenuOpen === true, '/ menu opened', opened)
      assert(opened.ghostPresent === false, 'ghost hidden while the / menu is open', opened)
      await page.keyboard.press('Tab')
      await sleep(200)
      const afterTab = await dom()
      assert(
        (afterTab.draftText ?? '').includes(suggestionText) === false,
        'Tab in the / menu never inserts the suggestion',
        { draft: afterTab.draftText, suggestionText },
      )
      await page.keyboard.press('Escape')
      await sleep(200)
      await clearDraft()
      return { opened: opened.triggerMenuOpen, draftAfterTab: afterTab.draftText }
    })
    await shot('06-menu-guard')

    // ---- 7. second focused input is not served -----------------------------
    await step('multi-input', async () => {
      await sendTurn('请第四次回复：收到')
      const ghost = await waitForGhost()
      const suggestionText = ghost.state.text
      await page.evaluate(() => {
        const existing = document.querySelector('[data-test-dummy-input]')
        if (existing !== null) return
        const input = document.createElement('input')
        input.type = 'text'
        input.setAttribute('data-test-dummy-input', '')
        input.style.position = 'fixed'
        input.style.left = '20px'
        input.style.bottom = '20px'
        input.style.zIndex = '99999'
        document.body.appendChild(input)
      })
      await page.locator('[data-test-dummy-input]').click()
      await sleep(300)
      const otherFocused = await dom()
      assert(otherFocused.activeIsInput === false, 'dummy input holds focus', otherFocused)
      assert(otherFocused.ghostPresent === false, 'ghost hidden while another input is active', otherFocused)
      await page.keyboard.press('Tab')
      await sleep(200)
      const afterTab = await dom()
      assert(
        (afterTab.draftText ?? '').includes(suggestionText) === false,
        'Tab in another input never inserts the suggestion',
        { draft: afterTab.draftText, suggestionText },
      )
      await focusComposer()
      await sleep(400)
      const refocused = await dom()
      assert(refocused.ghostVisible === true, 'focusing the composer restores the valid offer', refocused)
      await page.keyboard.press('Escape')
      await sleep(200)
      await page.evaluate(() => document.querySelector('[data-test-dummy-input]')?.remove())
      return { suggestionText, refocused: refocused.ghostVisible }
    })
    await shot('07-multi-input')

    // ---- 8. placeholder restored after offers end --------------------------
    await step('placeholder-restore', async () => {
      await clearDraft()
      await sleep(400)
      const d = await dom()
      assert(d.placeholderHiddenByUs === false, 'placeholder not left hidden by us', d)
      assert(d.placeholderPresent === true || d.draftText !== '', 'placeholder element restored in empty composer', d)
      return d.placeholderVisibility
    })

    await step('narrow-composer', async () => {
      await sendTurn('请再回复一次：收到')
      await waitForGhost()
      const selector = '[data-composer-input]'
      const editor = page.locator(selector).first()
      const originalWidth = await editor.evaluate((input) => input.style.maxWidth)
      const longSuggestion = '请按刚才的方案逐项检查并整理结果。'.repeat(4)
      try {
        await editor.evaluate((input) => { input.style.maxWidth = '200px' })
        await page.evaluate((text) => window.__nextMessagePredictor.suggest(text), longSuggestion)
        await page.waitForFunction(() => document.querySelector('[data-nmp-ghost]') !== null)
        assert((await dom()).draftText === '', 'long suggestion stays out of the draft', await dom())
      } finally {
        await editor.evaluate((input, width) => { input.style.maxWidth = width }, originalWidth)
      }
      await focusComposer()
      const restored = await waitForGhost()
      assert(restored.state.text === longSuggestion, 'widening the composer restores the same suggestion')
      await shot('08-resized-ghost')
      await page.keyboard.press('Tab')
      await sleep(250)
      const adoptedNarrow = await dom()
      assert(adoptedNarrow.draftText === longSuggestion, 'Tab fills the complete suggestion (B08)', adoptedNarrow)
      await clearDraft()
      return { draft: (await dom()).draftText }
    })

    await step('arrow-adopt', async () => {
      await sendTurn('Reply once more: received')
      const ghost = await waitForGhost()
      const suggestionText = ghost.state.text
      await focusComposer()
      await sleep(150)
      const before = await dom()
      assert(before.draftText === '', 'draft starts empty before ArrowRight', before)
      await page.keyboard.press('ArrowRight')
      await sleep(300)
      const adopted = await dom()
      assert(adopted.draftText === suggestionText, 'ArrowRight fills the complete suggestion', adopted)
      assert(adopted.ghostPresent === false, 'ghost disappears after ArrowRight adoption', adopted)
      await clearDraft()
      return { draft: (await dom()).draftText }
    })
    await shot('09-arrow-adopt')

    await step('conflict-yield', async () => {
      await sendTurn('Reply once more: received again')
      const ghost = await waitForGhost()
      assert(ghost.state.status === 'offered', 'offer exists before conflict injection', ghost.state)
      await page.evaluate(() => {
        const marker = document.createElement('div')
        marker.setAttribute('data-composer-ghost', 'other-plugin')
        marker.style.display = 'none'
        document.body.appendChild(marker)
      })
      let status = ''
      for (let i = 0; i < 20; i += 1) {
        const current = await state()
        status = current?.status ?? ''
        if (status === 'conflict') break
        await sleep(300)
      }
      assert(status === 'conflict', 'plugin steps aside when another ghost plugin appears', { status })
      await sleep(300)
      const hidden = await dom()
      assert(hidden.ghostPresent === false, 'ghost is removed in conflict mode', hidden)
      await page.evaluate(() => {
        for (const node of document.querySelectorAll('[data-composer-ghost="other-plugin"]')) node.remove()
      })
      let recovered = false
      for (let i = 0; i < 20; i += 1) {
        const current = await state()
        if (current?.status !== 'conflict') {
          recovered = true
          break
        }
        await sleep(300)
      }
      assert(recovered === true, 'plugin recovers after the other ghost plugin disappears')
      await clearDraft()
      return { conflictStatus: status }
    })
    await shot('10-conflict-yield')

    report.ok = report.steps && Object.values(report.steps).every((s) => s.ok !== false)
  } catch (error) {
    report.error = String(error?.stack ?? error).slice(0, 8000)
    report.ok = false
    await shot('99-failure').catch(() => {})
  } finally {
    report.finishedAt = new Date().toISOString()
    if (!opts.keepOpen) await browser.close().catch(() => {})
    const reportPath = path.join(opts.out, `${opts.tag}-report.json`)
    await writeFile(reportPath, JSON.stringify(report, null, 2)).catch(() => {})
    console.log(
      JSON.stringify(
        {
          ok: report.ok,
          mode: report.mode,
          out: reportPath,
          steps: Object.fromEntries(
            Object.entries(report.steps).map(([name, value]) => [name, value?.ok ?? null]),
          ),
          error: report.error ?? null,
        },
        null,
        2,
      ),
    )
    if (!report.ok) process.exitCode = 1
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, fatal: String(error?.stack ?? error) }, null, 2))
  process.exit(1)
})

