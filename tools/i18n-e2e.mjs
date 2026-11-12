#!/usr/bin/env node
/**
 * Interface-language end-to-end check for dsh-next-message-predictor.
 *
 * Drives the isolated scratch-profile Web GUI (same conventions as p1-e2e.mjs)
 * and verifies, in the real DSH, that the plugin option `language: auto`
 * follows the language DSH itself is set to:
 *
 *   for each target language (default en, ja, ru), in DSH's own Settings dialog:
 *     - switch DSH's language and, WITHOUT reloading, sample every 20 ms how
 *       long the plugin takes to follow: <html lang>, __nextMessagePredictor
 *       .language(), the plugin's entry name in the Settings navigation and in
 *       the left sidebar, the title of the plugin's page (open as a panel), and
 *       the text of the "Predict" button in the empty input box;
 *     - open the plugin's Settings page and read its title;
 *     - reload the page and read the same things again, and trace from the first
 *       moment of the document (every 10 ms) how long a label in another language
 *       is on screen before the right one replaces it;
 *   then back to Chinese (same checks), then:
 *     - an explicit plugin language (ko, which DSH does not offer) wins over
 *       DSH's language, also while DSH changes language and after a reload;
 *     - going back to `auto` follows DSH again.
 *   Finally DSH is put back to Chinese and the plugin options (`language`,
 *   `sidebarEntry`) are restored to the values below.
 *
 * Expected texts are read from src/client/locales (the shipped dictionaries).
 * The report holds language ids, timings and UI labels only.
 *
 * Usage:
 *   node tools/i18n-e2e.mjs --url "<scratch URL>" [--out scratch/evidence] [--tag i18n]
 *                           [--languages en,ja,ru] [--browser-locale zh-CN] [--settle 6000] [--timeout 30000] [--headful]
 *
 * Requires: the scratch instance and the mock model running, a session open with
 * an empty composer (the "Predict" button shows there), DSH currently in Chinese.
 */
import { browserPath, loadChromium, loadPlaywright } from './lib/local-env.mjs'
import { NMP_DICTIONARIES } from '../src/client/i18n.js'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..')

/** Order of the entries in DSH's language menu. */
const DSH_MENU = ['zh', 'en', 'ja', 'es', 'fr', 'de', 'ru', 'pt']
/** Plugin options restored at the end. */
const RESTORE = { language: 'auto', sidebarEntry: false }

function parseArgs(argv) {
  const opts = { url: '', out: '', tag: 'i18n', languages: ['en', 'ja', 'ru'], browserLocale: 'zh-CN', settle: 6000, timeout: 30000, headless: true }
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
      case '--languages': opts.languages = next().split(',').map((s) => s.trim()).filter(Boolean); break
      case '--browser-locale': opts.browserLocale = next(); break
      case '--settle': opts.settle = Number(next()); break
      case '--timeout': opts.timeout = Number(next()); break
      case '--headful': opts.headless = false; break
      default: throw new Error(`unknown argument: ${a}`)
    }
  }
  if (!opts.url) throw new Error('--url is required')
  for (const id of opts.languages) {
    if (!DSH_MENU.includes(id) || id === 'zh') throw new Error(`--languages: "${id}" is not a non-Chinese DSH language`)
  }
  if (!opts.out) opts.out = path.join(repoRoot, 'scratch', 'evidence')
  return opts
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** What the plugin should show in a language. */
const expectedTexts = (id) => ({
  nav: NMP_DICTIONARIES[id]['settings.nav'],
  title: NMP_DICTIONARIES[id]['settings.title'],
  predict: NMP_DICTIONARIES[id]['ghost.predict'],
})

/**
 * Installed before every page load: from the first moment of the document it records,
 * every 10 ms and only on change, <html lang>, the plugin's language and the label of the
 * plugin's entry in the left sidebar and of the "Predict" button (to see what flashes while loading).
 */
const LOAD_TRACE = `(() => {
  const trace = []
  window.__loadTrace = trace
  let last = ''
  setInterval(() => {
    try {
      const row = [...document.querySelectorAll('button[class*="panelRow"]')].find((b) => b.querySelector('svg[focusable="false"]'))
      const api = window.__nextMessagePredictor
      const o = {
        lang: document.documentElement.lang,
        plugin: api && api.language ? api.language() : null,
        sidebar: row ? (row.getAttribute('aria-label') || row.textContent.trim()) : null,
        predict: (document.querySelector('[data-nmp-predict]') || {}).textContent || null,
      }
      const key = JSON.stringify(o)
      if (key !== last) { last = key; trace.push({ t: Math.round(performance.now()), ...o }) }
    } catch (e) { /* the page is still starting */ }
  }, 10)
})()`

/** Everything observable at one moment, as plain data. Runs in the page. */
const OBSERVE = `(() => {
  const text = (el) => (el ? (el.innerText ?? el.textContent ?? '').trim() : null)
  const dialog = document.querySelector('[role="dialog"][data-shortcut-modal="settings"]')
  // The plugin's own icon is the only svg with focusable="false" in a nav button / sidebar row.
  const navButton = dialog ? [...dialog.querySelectorAll('nav button')].find((b) => b.querySelector('svg[focusable="false"]')) : null
  const row = [...document.querySelectorAll('button[class*="panelRow"]')].find((b) => b.querySelector('svg[focusable="false"]'))
  const panelTitle = document.querySelector('[data-nmp-panel] [data-nmp-setting="header"] h2')
  const sectionTitle = dialog ? dialog.querySelector('[data-nmp-setting="header"] h2') : null
  const predict = document.querySelector('[data-nmp-predict]')
  const api = window.__nextMessagePredictor
  return {
    htmlLang: document.documentElement.lang,
    plugin: api && api.language ? api.language() : null,
    nav: text(navButton),
    sidebar: row ? (row.getAttribute('aria-label') ?? text(row)) : null,
    panelTitle: text(panelTitle),
    sectionTitle: text(sectionTitle),
    predict: text(predict),
    dshNav: dialog ? text(dialog.querySelectorAll('nav button')[1]) : null,
  }
})()`

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  await mkdir(opts.out, { recursive: true })
  const report = {
    driver: 'tools/i18n-e2e.mjs',
    startedAt: new Date().toISOString(),
    settleMs: opts.settle,
    browserLocale: opts.browserLocale,
    steps: {},
    console: [],
    pageErrors: [],
    ok: false,
  }

  const chromium = loadChromium()
  report.playwrightCore = loadPlaywright().version
  const browser = await chromium.launch({
    executablePath: browserPath(),
    headless: opts.headless,
    args: ['--disable-gpu', '--no-first-run', '--no-default-browser-check'],
  })
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, locale: opts.browserLocale })
  const page = await context.newPage()
  page.setDefaultTimeout(opts.timeout)
  await page.addInitScript(LOAD_TRACE)
  page.on('console', (msg) => {
    if (report.console.length < 200 && (msg.type() === 'error' || msg.type() === 'warning')) {
      report.console.push({ type: msg.type(), text: msg.text().slice(0, 500) })
    }
  })
  page.on('pageerror', (err) => report.pageErrors.push(String(err).slice(0, 2000)))

  const assert = (condition, message, details) => {
    if (!condition) {
      const error = new Error(`assertion failed: ${message}`)
      error.details = details
      throw error
    }
  }
  /** A failed step is recorded and the run goes on: one language failing must not hide the others. */
  const step = async (name, fn) => {
    const started = Date.now()
    try {
      const value = await fn()
      const failed = value && value.ok === false
      report.steps[name] = { ok: !failed, ms: Date.now() - started, value: value ?? null }
    } catch (error) {
      report.steps[name] = { ok: false, ms: Date.now() - started, error: String(error?.stack ?? error).slice(0, 3000), details: error?.details ?? null }
    }
    return report.steps[name]
  }

  const observe = () => page.evaluate(OBSERVE)
  const rpc = (body) =>
    page.evaluate(async (payload) => {
      const response = await fetch('/api/next-message-predictor/rpc', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      })
      return response.json()
    }, body)
  const setPluginConfig = async (patch) => {
    const result = await rpc({ schemaVersion: 1, operation: 'config.set', patch })
    assert(result.ok === true, `config.set ${JSON.stringify(patch)}`, result)
    await sleep(1500)
    await page.evaluate(() => window.__nextMessagePredictor?.reloadConfig?.()).catch(() => {})
    await sleep(800)
  }
  const pluginConfig = () => page.evaluate(() => window.__nextMessagePredictor?.config?.()?.config ?? null)

  const load = async () => {
    await page.goto(opts.url, { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(() => Boolean(window.__nextMessagePredictor), undefined, { timeout: opts.timeout })
    // The input box (and with it the "Predict" button) comes a little later than the plugin.
    await page.waitForSelector('[data-composer-input]', { timeout: opts.timeout }).catch(() => {})
    await sleep(2500)
  }
  const dialogOpen = () => page.locator('[role="dialog"][data-shortcut-modal="settings"]').count().then((n) => n > 0)
  const openSettings = async () => {
    if (await dialogOpen()) return
    await page.keyboard.press('Control+Alt+,')
    await sleep(600)
    if (!(await dialogOpen())) {
      // Fallback: the account menu at the bottom of the sidebar, first item.
      await page.locator('button[aria-haspopup="menu"][class*="trigger"]').last().click()
      await page.locator('[role="menuitem"]').first().click()
    }
    await page.waitForSelector('[role="dialog"][data-shortcut-modal="settings"]')
    await sleep(400)
  }
  const closeSettings = async () => {
    if (!(await dialogOpen())) return
    await page.keyboard.press('Escape')
    await sleep(500)
    if (await dialogOpen()) await page.locator('[role="dialog"] button[class*="close"]').first().click()
    await sleep(400)
  }
  /** nav index: 0 account, 1 general; the plugin's entry is found by its icon. */
  const openGeneral = async () => {
    await openSettings()
    await page.locator('[role="dialog"] nav button').nth(1).click()
    await sleep(500)
  }
  const openPluginSection = async () => {
    await openSettings()
    await page.locator('[role="dialog"] nav button:has(svg[focusable="false"])').first().click()
    await page.waitForSelector('[role="dialog"] [data-nmp-setting="header"]')
    await sleep(400)
  }
  const openPanel = async () => {
    const opened = await page.evaluate(() => window.__nextMessagePredictor?.openPanel?.() === true)
    await sleep(600)
    return opened
  }

  /** Back to the conversation (the input box is where "Predict" lives) when the plugin's panel is open. */
  const leavePanel = async () => {
    if ((await page.locator('[data-nmp-panel]').count()) === 0) return
    await page.locator('button[class*="panelRow"]:has(svg[focusable="false"])').first().click().catch(() => {})
    await sleep(700)
    if ((await page.locator('[data-nmp-panel]').count()) === 0) {
      report.leavePanel.sidebarToggle += 1
      return
    }
    report.leavePanel.reload += 1
    await load()
  }

  /** Pick the plugin's own language in its settings page (the real user path); ms until language() shows it. */
  const chooseInPlugin = async (value, expectLanguage) => {
    await openPanel()
    const select = page.locator('[data-nmp-panel] [data-nmp-setting="language"]')
    await select.waitFor()
    const t0 = Date.now()
    await select.selectOption(value)
    let followedAt = null
    for (let i = 0; i < 320 && followedAt === null; i += 1) {
      const language = await page.evaluate(() => window.__nextMessagePredictor?.language?.() ?? null).catch(() => null)
      if (language === expectLanguage) followedAt = Date.now() - t0
      else await sleep(25)
    }
    // The write restarts the plugin's Host half; let that finish before the next step.
    await sleep(3500)
    return followedAt
  }

  /**
   * Choose a language in DSH's own Settings dialog and watch the plugin follow.
   * Samples every 20 ms for `settle` ms after the click and keeps every change.
   */
  const switchDsh = async (id) => {
    await openGeneral()
    await page.locator('[role="dialog"] button[aria-haspopup="menu"]').nth(1).click()
    await sleep(300)
    const items = page.locator('[role="menuitem"]')
    assert((await items.count()) === DSH_MENU.length, 'DSH language menu has 8 entries', { count: await items.count() })
    // Armed: t0 is stamped by the very click that picks the language.
    await page.evaluate(
      ({ sample, settle, observeSource }) => {
        const probe = { t0: null, langAt: null, atLang: null, series: [], done: false }
        window.__i18nProbe = probe
        document.addEventListener('click', () => { probe.t0 = performance.now() }, { capture: true, once: true })
        // The exact moment <html lang> changes (the plugin's observer sees the same event).
        new MutationObserver(() => {
          if (probe.t0 === null || probe.langAt !== null) return
          probe.langAt = Math.round(performance.now() - probe.t0)
          // The plugin's own observer on <html lang> was registered earlier, so it has run by now.
          try { probe.atLang = (0, eval)(observeSource) } catch { probe.atLang = null }
        }).observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] })
        let last = ''
        const timer = setInterval(() => {
          if (probe.t0 === null) return
          try {
            const snap = (0, eval)(observeSource)
            const text = JSON.stringify(snap)
            const now = Math.round(performance.now() - probe.t0)
            if (text !== last) {
              last = text
              probe.series.push({ at: now, ...snap })
            }
            if (now >= settle) {
              probe.done = true
              clearInterval(timer)
            }
          } catch (error) {
            probe.series.push({ at: -1, error: String(error) })
            probe.done = true
            clearInterval(timer)
          }
        }, sample)
      },
      { sample: 20, settle: opts.settle, observeSource: OBSERVE },
    )
    const before = await observe()
    await items.nth(DSH_MENU.indexOf(id)).click()
    await page.waitForFunction(() => window.__i18nProbe?.done === true, undefined, { timeout: opts.settle + 10000 })
    const probe = await page.evaluate(() => ({ series: window.__i18nProbe.series, langAt: window.__i18nProbe.langAt, atLang: window.__i18nProbe.atLang }))
    return { before, series: probe.series, langAt: probe.langAt, atLang: probe.atLang }
  }

  /** First time (ms after the click) a field of the series equals a value; null when never. */
  const firstAt = (series, field, value) => {
    const hit = series.find((s) => s[field] === value)
    return hit ? hit.at : null
  }
  const lastOf = (series) => series[series.length - 1] ?? null

  /** Compare an observation with the expected plugin texts, for the fields listed in `require`. */
  const matches = (obs, id, require) => {
    const want = expectedTexts(id)
    const table = {
      plugin: obs.plugin === id,
      nav: obs.nav === want.nav,
      sidebar: obs.sidebar === want.nav,
      panelTitle: obs.panelTitle === want.title,
      sectionTitle: obs.sectionTitle === want.title,
      predict: obs.predict === want.predict,
    }
    const checks = Object.fromEntries(require.map((name) => [name, table[name]]))
    return { checks, all: Object.values(checks).every(Boolean) }
  }

  const stepName = (kind, dsh, plugin) => `${kind}-${dsh}${plugin === dsh ? '' : `-plugin-${plugin}`}`

  /** DSH switches language; the plugin is watched live, then read again without a reload. */
  const liveStep = (dsh, plugin) =>
    step(stepName('live', dsh, plugin), async () => {
      await leavePanel()
      const { before, series, langAt, atLang } = await switchDsh(dsh)
      const end = lastOf(series)
      const want = expectedTexts(plugin)
      const live = matches(end, plugin, ['plugin', 'nav', 'sidebar', 'predict'])
      // When the plugin keeps its own language (explicit option) nothing may change at all.
      const unchanged = plugin !== dsh ? series.every((entry) => entry.plugin === plugin) : true
      const followedAtMs = {
        htmlLang: langAt,
        plugin: firstAt(series, 'plugin', plugin),
        nav: firstAt(series, 'nav', want.nav),
        sidebar: firstAt(series, 'sidebar', want.nav),
        predict: firstAt(series, 'predict', want.predict),
      }
      // Still without a reload: the plugin's page inside the Settings dialog, then as a panel.
      await openPluginSection()
      const sectionTitle = (await observe()).sectionTitle
      await closeSettings()
      await openPanel()
      const panelTitle = (await observe()).panelTitle
      const later = matches({ ...end, sectionTitle, panelTitle }, plugin, ['sectionTitle', 'panelTitle'])
      return {
        ok: live.all && later.all && unchanged && String(end.htmlLang).startsWith(dsh),
        dshLanguage: dsh,
        expectedPlugin: plugin,
        before: { htmlLang: before.htmlLang, plugin: before.plugin },
        afterSettle: { htmlLang: end.htmlLang, plugin: end.plugin, dshNav: end.dshNav, nav: end.nav, sidebar: end.sidebar, predict: end.predict, sectionTitle, panelTitle },
        checks: { ...live.checks, ...later.checks },
        followedAtMs,
        pluginAtTheMomentHtmlLangChanged: atLang ? { plugin: atLang.plugin, nav: atLang.nav, sidebar: atLang.sidebar, predict: atLang.predict } : null,
        pluginKeptItsOwnLanguage: plugin !== dsh ? unchanged : undefined,
        changesInSeries: series.length,
        ...(live.all && later.all ? {} : { series }),
      }
    })

  /** Reload the page and read the same things; also how long until the plugin shows the right language. */
  const reloadStep = (dsh, plugin) =>
    step(stepName('reload', dsh, plugin), async () => {
      const want = expectedTexts(plugin)
      const t0 = Date.now()
      await page.goto(opts.url, { waitUntil: 'domcontentloaded' })
      const seen = []
      let rightAtMs = null
      for (let i = 0; i < 100; i += 1) {
        const o = await page.evaluate(() => ({ plugin: window.__nextMessagePredictor?.language?.() ?? null, predict: document.querySelector('[data-nmp-predict]')?.textContent ?? null })).catch(() => null)
        if (o) {
          const tag = `${o.plugin ?? '-'}`
          if (seen.length === 0 || seen[seen.length - 1].plugin !== tag) seen.push({ at: Date.now() - t0, plugin: tag })
          if (o.plugin === plugin && o.predict === want.predict && rightAtMs === null) rightAtMs = Date.now() - t0
        }
        if (rightAtMs !== null && Date.now() - t0 > rightAtMs + 1500) break
        await sleep(100)
      }
      await sleep(1500)
      const trace = await page.evaluate(() => window.__loadTrace ?? [])
      const shownAt = (field, pick) => trace.find((entry) => entry[field] !== null && entry[field] !== '' && pick(entry))?.t ?? null
      const firstSidebar = shownAt('sidebar', () => true)
      const firstPredict = shownAt('predict', () => true)
      const idle = await observe()
      await openSettings()
      const withDialog = await observe()
      await openPluginSection()
      const sectionTitle = (await observe()).sectionTitle
      await closeSettings()
      await openPanel()
      const panelTitle = (await observe()).panelTitle
      const verdict = matches({ ...withDialog, predict: idle.predict, sectionTitle, panelTitle }, plugin, ['plugin', 'nav', 'sidebar', 'predict', 'sectionTitle', 'panelTitle'])
      return {
        ok: verdict.all && String(idle.htmlLang).startsWith(dsh),
        dshLanguage: dsh,
        expectedPlugin: plugin,
        htmlLang: idle.htmlLang,
        checks: verdict.checks,
        observed: { plugin: idle.plugin, nav: withDialog.nav, sidebar: withDialog.sidebar, predict: idle.predict, sectionTitle, panelTitle },
        languagesSeenWhileLoading: seen,
        rightAfterDomContentMs: rightAtMs,
        // From the start of the page: when the label first showed, when it was the right one.
        // wrongMs > 0 means a label in another language was on screen in between.
        sidebarEntry: { firstShownAtMs: firstSidebar, rightAtMs: shownAt('sidebar', (e) => e.sidebar === want.nav) },
        predictButton: { firstShownAtMs: firstPredict, rightAtMs: shownAt('predict', (e) => e.predict === want.predict) },
        wrongLabelOnScreenMs: {
          sidebarEntry: firstSidebar === null ? null : Math.max(0, (shownAt('sidebar', (e) => e.sidebar === want.nav) ?? firstSidebar) - firstSidebar),
          predictButton: firstPredict === null ? null : Math.max(0, (shownAt('predict', (e) => e.predict === want.predict) ?? firstPredict) - firstPredict),
        },
        loadTrace: trace.slice(0, 10),
        pluginLanguageSeen: [...new Set(trace.map((entry) => entry.plugin).filter(Boolean))],
      }
    })

  report.leavePanel = { sidebarToggle: 0, reload: 0 }

  let original = null
  try {
    await load()
    original = await pluginConfig()
    assert(original !== null, 'plugin config readable')
    report.original = { language: original.language, sidebarEntry: original.sidebarEntry }
    report.pluginVersion = await page.evaluate(() => window.__nextMessagePredictor.version)

    await step('setup', async () => {
      await setPluginConfig({ language: 'auto', sidebarEntry: true })
      await load()
      const obs = await observe()
      assert(obs.predict !== null, 'the "Predict" button shows in the empty input box (open a session with an empty draft)', obs)
      assert(obs.sidebar !== null, 'the sidebar entry shows', obs)
      assert(/^zh/.test(obs.htmlLang), 'DSH starts in Chinese', obs)
      return { ok: true, htmlLang: obs.htmlLang, plugin: obs.plugin, sidebar: obs.sidebar, predict: obs.predict }
    })

    // ---- auto follows DSH: each target language, live then reloaded ----
    for (const id of [...opts.languages, 'zh']) {
      await liveStep(id, id)
      await reloadStep(id, id)
      await leavePanel()
    }

    // ---- auto reads DSH's language itself, not just <html lang> ----
    await step('auto-ignores-html-lang', async () => {
      const before = await observe()
      await page.evaluate(() => document.documentElement.setAttribute('lang', 'fr'))
      await sleep(2600)
      const during = await observe()
      await page.evaluate(() => document.documentElement.setAttribute('lang', 'zh-CN'))
      await sleep(300)
      const after = await observe()
      return {
        ok: before.plugin === 'zh' && during.plugin === 'zh' && after.plugin === 'zh',
        plugin: { before: before.plugin, whileHtmlLangWasFr: during.plugin, after: after.plugin },
      }
    })

    // ---- an explicit plugin language wins over DSH ----
    const other = opts.languages[0]
    await step('explicit-ko-over-zh', async () => {
      const followedAt = await chooseInPlugin('ko', 'ko')
      await leavePanel()
      await openSettings()
      const obs = await observe()
      await openPluginSection()
      const sectionTitle = (await observe()).sectionTitle
      await closeSettings()
      const idle = await observe()
      const verdict = matches({ ...obs, predict: idle.predict, sectionTitle }, 'ko', ['plugin', 'nav', 'sidebar', 'predict', 'sectionTitle'])
      return { ok: followedAt !== null && verdict.all && /^zh/.test(obs.htmlLang), followedAfterChoiceMs: followedAt, htmlLang: obs.htmlLang, checks: verdict.checks, observed: { plugin: obs.plugin, nav: obs.nav, sidebar: obs.sidebar, predict: idle.predict, sectionTitle } }
    })
    await liveStep(other, 'ko')
    await reloadStep(other, 'ko')
    await leavePanel()

    // ---- back to auto: follows DSH (now `other`) again ----
    await step('back-to-auto', async () => {
      const followedAt = await chooseInPlugin('auto', other)
      await leavePanel()
      const idle = await observe()
      await openSettings()
      const withDialog = await observe()
      await closeSettings()
      const verdict = matches({ ...withDialog, predict: idle.predict }, other, ['plugin', 'nav', 'sidebar', 'predict'])
      return { ok: followedAt !== null && verdict.all, followedAfterChoiceMs: followedAt, checks: verdict.checks, htmlLang: idle.htmlLang, plugin: idle.plugin }
    })

    // ---- put DSH back to Chinese ----
    await step('dsh-back-to-zh', async () => {
      const { series } = await switchDsh('zh')
      const end = lastOf(series)
      await closeSettings()
      return { ok: end.plugin === 'zh' && /^zh/.test(end.htmlLang), final: { htmlLang: end.htmlLang, plugin: end.plugin } }
    })
  } catch (error) {
    report.error = String(error?.stack ?? error).slice(0, 4000)
    await page.screenshot({ path: path.join(opts.out, `${opts.tag}-99-failure.png`) }).catch(() => {})
  } finally {
    // Restore: DSH Chinese, plugin options as the task defines them.
    await step('restore', async () => {
      await closeSettings().catch(() => {})
      const now = await observe().catch(() => null)
      if (!now || !/^zh/.test(now.htmlLang)) await switchDsh('zh').catch(() => {})
      await closeSettings().catch(() => {})
      await setPluginConfig(RESTORE)
      await page.reload({ waitUntil: 'domcontentloaded' })
      await page.waitForFunction(() => Boolean(window.__nextMessagePredictor), undefined, { timeout: opts.timeout })
      await sleep(2500)
      const cfg = await pluginConfig()
      const obs = await observe()
      return {
        ok: cfg?.language === RESTORE.language && cfg?.sidebarEntry === RESTORE.sidebarEntry && /^zh/.test(obs.htmlLang) && obs.plugin === 'zh',
        language: cfg?.language,
        sidebarEntry: cfg?.sidebarEntry,
        htmlLang: obs.htmlLang,
        plugin: obs.plugin,
      }
    }).catch(() => {})
    report.ok = !report.error && Object.keys(report.steps).length > 0 && Object.values(report.steps).every((s) => s.ok !== false)
    report.finishedAt = new Date().toISOString()
    await browser.close().catch(() => {})
    const reportPath = path.join(opts.out, `${opts.tag}-report.json`)
    await writeFile(reportPath, JSON.stringify(report, null, 2)).catch(() => {})
    console.log(
      JSON.stringify(
        {
          ok: report.ok,
          out: reportPath,
          steps: Object.fromEntries(Object.entries(report.steps).map(([name, value]) => [name, value?.ok ?? null])),
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
