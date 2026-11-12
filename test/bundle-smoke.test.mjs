// Smoke test of the shipped browser bundle (lib/client.js), wired to a real
// Host service in-process.
//
// `node --check` only proves the bundle parses. This loads it the way DSH does
// (ModuleLoader factory + host React), applies the plugin against a fake slot
// registry, renders the Settings page with a minimal React stand-in and clicks
// through the features. A missing function, a missing locale key or a
// registration that never happens fails here instead of in the user's window.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { DEFAULT_CONFIG, LANGUAGE_IDS, PANEL_ID, ROUTE } from '../src/shared/config.js'
import { NMP_DICTIONARIES, NMP_LANGUAGE_NAMES } from '../src/client/i18n.js'
import { matchPreset } from '../src/shared/presets.js'
import { PLUGIN_VERSION } from '../src/shared/version.js'
import { createPredictorService } from '../src/host/predictor-service.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms))

// ── a React stand-in: enough to call the components and walk their output ──
const react = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useLayoutEffect: () => {},
  useMemo: (factory) => factory(),
  useRef: (value) => ({ current: value }),
  useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot(),
}

/**
 * A React stand-in that keeps state between renders, for clicking through a
 * form: hooks are stored per component function in call order (instances of
 * the same small component share their slots, which is enough here). Effects
 * run only when a render asks for them.
 */
function createStatefulReact() {
  const slots = new Map()
  let current = null
  let cursor = 0
  const pendingEffects = []
  const slotList = () => {
    let list = slots.get(current)
    if (list === undefined) {
      list = []
      slots.set(current, list)
    }
    return list
  }
  const stateful = {
    createElement: react.createElement,
    useState(initial) {
      const list = slotList()
      const index = cursor++
      if (!(index in list)) list[index] = typeof initial === 'function' ? initial() : initial
      return [list[index], (value) => { list[index] = typeof value === 'function' ? value(list[index]) : value }]
    },
    useEffect(effect, deps) {
      const list = slotList()
      const index = cursor++
      const previous = list[index]
      if (previous === undefined || deps === undefined || deps.length !== previous.length || deps.some((dep, k) => dep !== previous[k])) {
        list[index] = deps ?? []
        pendingEffects.push(effect)
      }
    },
    useLayoutEffect: () => {},
    useMemo: (factory) => factory(),
    useRef: (value) => ({ current: value }),
    useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot(),
  }
  function expandStateful(node) {
    if (node === null || node === undefined || typeof node === 'boolean') return []
    if (typeof node === 'string' || typeof node === 'number') return [String(node)]
    if (Array.isArray(node)) return node.flatMap(expandStateful)
    if (typeof node.type === 'function') {
      const saved = [current, cursor]
      current = node.type
      cursor = 0
      const output = node.type({ ...node.props, children: node.children })
      ;[current, cursor] = saved
      return expandStateful(output)
    }
    return [{ type: node.type, props: node.props, children: node.children.flatMap(expandStateful) }]
  }
  return {
    react: stateful,
    expand: (node, options) => {
      pendingEffects.length = 0
      const out = expandStateful(node)
      if (options?.effects === true) for (const effect of pendingEffects.splice(0)) effect()
      return out
    },
  }
}

/** Call function components until only host elements and strings are left. */
function expand(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return []
  if (typeof node === 'string' || typeof node === 'number') return [String(node)]
  if (Array.isArray(node)) return node.flatMap(expand)
  if (typeof node.type === 'function') return expand(node.type({ ...node.props, children: node.children }))
  return [{ type: node.type, props: node.props, children: node.children.flatMap(expand) }]
}
function walk(nodes, visit) {
  for (const node of nodes) {
    if (typeof node === 'string') continue
    visit(node)
    walk(node.children, visit)
  }
}
function textOf(nodes) {
  return nodes.map((node) => (typeof node === 'string' ? node : textOf(node.children))).join('')
}
/** Every string the user can read or hear: text plus labelling attributes. */
function readableStrings(nodes) {
  const out = []
  const collect = (list) => {
    for (const node of list) {
      if (typeof node === 'string') out.push(node)
      else {
        for (const name of ['aria-label', 'title', 'placeholder']) if (typeof node.props[name] === 'string') out.push(node.props[name])
        collect(node.children)
      }
    }
  }
  collect(nodes)
  return out
}
function find(nodes, attribute, value) {
  let hit = null
  walk(nodes, (node) => {
    if (hit === null && node.props[attribute] !== undefined && (value === undefined || node.props[attribute] === value)) hit = node
  })
  return hit
}

/** Boot the bundle against fake shell services and a real Host service. */
async function boot(options) {
  const language = options?.language ?? 'zh'
  let hostConfig = { ...DEFAULT_CONFIG, ...(options?.config ?? {}) }
  const writes = []
  const makeService = () =>
    createPredictorService({
      config: hostConfig,
      adapter: {
        capabilities: () => ({ connectionFetch: true, configEditor: true, sessionStore: true }),
        connectionAvailable: true,
        configEditorAvailable: true,
        persistConfig: async (patch) => {
          writes.push(patch)
          hostConfig = { ...hostConfig, ...patch }
          return { ok: true, config: hostConfig, restarted: true }
        },
      },
      ...(options?.ledger !== undefined ? { ledger: options.ledger } : {}),
      ...(options?.results !== undefined ? { results: options.results } : {}),
    })
  const host = options?.stateful === true ? createStatefulReact() : { react, expand }
  const service = makeService()

  const listeners = []
  const storage = () => {
    const map = new Map()
    return { getItem: (key) => (map.has(key) ? map.get(key) : null), setItem: (key, value) => map.set(key, String(value)), removeItem: (key) => map.delete(key) }
  }
  const windowStub = {
    addEventListener: (type) => listeners.push(type),
    removeEventListener: () => {},
    __ModuleLoader__: { load: (module) => { windowStub.loaded = module } },
  }
  globalThis.window = windowStub
  globalThis.document = {
    addEventListener: () => {},
    removeEventListener: () => {},
    querySelectorAll: () => [],
    querySelector: () => null,
    hasFocus: () => true,
    visibilityState: 'visible',
    documentElement: { lang: options?.pageLanguage ?? '' },
  }
  globalThis.localStorage = options?.localStorage ?? storage()
  globalThis.sessionStorage = storage()
  globalThis.fetch = async (url, init) => {
    assert.equal(url, ROUTE)
    const result = await service.handle(JSON.parse(init.body), init.signal)
    return { status: result.status, json: async () => JSON.parse(JSON.stringify(result.body)) }
  }

  const bundle = await readFile(join(root, 'lib', 'client.js'), 'utf8')
  new Function('window', bundle)(windowStub)
  assert.equal(windowStub.loaded.id, 'dsh-next-message-predictor')
  const client = windowStub.loaded.factory((name) => {
    assert.equal(name, 'react')
    return host.react
  })

  /** @type {{options: object, Component: Function}[]} */
  const registry = []
  /** Every registration ever made, by slot name (the registry only holds the live ones). */
  const registered = []
  const dictionaries = {}
  let activePanelId = null
  const panelListeners = new Set()
  const selectPanel = (id) => {
    if (id !== null && !registry.some((entry) => entry.options.name === 'main' && entry.options.key === id)) {
      throw new Error(`main panel "${id}" is not registered`)
    }
    activePanelId = id
    for (const listener of panelListeners) listener()
  }
  const services = {
    slots: {
      // Every slot is "declared" in this shell: the callback runs at once.
      inject: (key, callback) => callback(),
      register: (entryOptions, Component) => {
        const entry = { options: entryOptions, Component }
        registry.push(entry)
        registered.push(entryOptions.name)
        return () => {
          const index = registry.indexOf(entry)
          if (index >= 0) registry.splice(index, 1)
          // Like DSH: losing the selected main panel returns to the conversation.
          if (entryOptions.name === 'main' && activePanelId === entryOptions.key) selectPanel(null)
        }
      },
    },
    locale: {
      register: (namespace, value) => {
        dictionaries[namespace] = value
        return () => {}
      },
      bind: (namespace) => (key) => dictionaries[namespace]?.[language]?.[key] ?? key,
    },
    connection: {},
    layout: {
      selectPanel,
      panelInfo: {
        getSnapshot: () => ({ activePanelId }),
        subscribe: (listener) => {
          panelListeners.add(listener)
          return () => panelListeners.delete(listener)
        },
      },
    },
  }
  const disposers = []
  const ctx = {
    get: (name) => services[name],
    effect: (setup) => {
      const dispose = setup()
      disposers.push(typeof dispose === 'function' ? dispose : () => {})
      return dispose
    },
  }
  assert.deepEqual(client.inject, ['slots', 'locale', 'connection'])
  client.apply(ctx)
  await tick(5) // the status request
  const entry = (name, id) => registry.find((item) => item.options.name === name && (id === undefined || item.options.id === id || item.options.key === id))
  const render = (name, id, renderOptions) => host.expand(react.createElement(entry(name, id).Component, null), renderOptions)
  return {
    registry,
    entry,
    render,
    writes,
    api: () => windowStub.__nextMessagePredictor,
    dictionaries,
    registrations: (name) => registered.filter((value) => value === name).length,
    localStorage: globalThis.localStorage,
    hostConfig: () => hostConfig,
    activePanel: () => activePanelId,
    selectPanel,
    windowStub,
    dispose: () => {
      for (const dispose of disposers.splice(0).reverse()) dispose()
    },
  }
}

const RAW_KEY = /^(settings|preset|help|state|reason|unit|warn|ghost)\.[A-Za-z]/

test('bundle: registers every contribution and reports its version', async () => {
  const app = await boot()
  try {
    assert.equal(app.api().version, PLUGIN_VERSION)
    assert.equal(app.api().config().hostVersion, PLUGIN_VERSION)
    assert.ok(app.entry('conversation.input.overlay'))
    assert.ok(app.entry('settings.section', 'next-message-predictor'))
    assert.ok(app.entry('settings.section.icon', 'next-message-predictor'))
    assert.ok(app.entry('main', PANEL_ID), 'the global panel is always registered')
    assert.equal(app.entry('sidebar.panellist'), undefined, 'no sidebar entry until the user adds it')
    assert.equal(app.entry('settings.section').options.label(), '消息预测')
  } finally {
    app.dispose()
  }
})

for (const language of LANGUAGE_IDS) {
  test(`settings page (${language}): renders with version, modes and no untranslated key`, async () => {
    // The language is chosen in the plugin; DSH itself stays in Chinese.
    const app = await boot({ language: 'zh', config: { language } })
    try {
      assert.equal(app.api().language(), language)
      assert.equal(app.entry('settings.section').options.label(), NMP_DICTIONARIES[language]['settings.nav'])
      const page = app.render('settings.section')
      const text = textOf(page)
      assert.ok(text.includes(NMP_DICTIONARIES[language]['settings.title']), 'the title is in the chosen language')
      assert.ok(text.includes(NMP_DICTIONARIES[language]['preset.saver.name']))
      // The language list names every language in its own words.
      const select = find(page, 'data-nmp-setting', 'language')
      assert.equal(select.props.value, language)
      const options = select.children.map((option) => [option.props.value, textOf([option])])
      assert.deepEqual(options, [['auto', NMP_DICTIONARIES[language]['settings.languageAuto']], ...LANGUAGE_IDS.map((id) => [id, NMP_LANGUAGE_NAMES[id]])])
      assert.ok(text.includes(`v${PLUGIN_VERSION}`), 'the version is in the header')
      assert.equal(textOf([find(page, 'data-nmp-setting', 'version')]), `v${PLUGIN_VERSION}`)
      assert.equal(find(page, 'data-nmp-setting', 'versionMismatch'), null)
      assert.ok(find(page, 'data-nmp-setting', 'sidebarEntry'), 'the add-to-sidebar button is offered')
      for (const id of ['balanced', 'saver', 'quality']) assert.ok(find(page, 'data-nmp-preset', id), `mode ${id}`)
      assert.equal(find(page, 'data-nmp-preset', 'balanced').props['aria-pressed'], true)
      assert.equal(find(page, 'data-nmp-preset', 'saver').props['aria-pressed'], false)
      for (const name of ['enabled', 'manualOnly', 'showPredictButton', 'predictShortcut', 'habitSuggestions', 'pinned', 'pinnedInput', 'pinnedAdd', 'pinnedEmpty', 'multiCandidates', 'modelMode', 'advanced', 'restoreAdvanced']) {
        assert.ok(find(page, 'data-nmp-setting', name), `control ${name}`)
      }
      const leaked = readableStrings(page).filter((value) => RAW_KEY.test(value.trim()))
      assert.deepEqual(leaked, [], 'locale keys shown instead of text')
      assert.equal(/\{(key|name|n|version|host)\}/.test(readableStrings(page).join('\n')), false, 'a placeholder was left unfilled')
      // The panel shows the same page.
      const panel = app.render('main', PANEL_ID)
      assert.equal(find(panel, 'data-nmp-panel').props['data-nmp-panel'], PANEL_ID)
      assert.equal(textOf(panel), text)
    } finally {
      app.dispose()
    }
  })
}

test('language "auto" follows the language DSH is showing', async () => {
  for (const language of ['ja', 'de', 'pt', 'zh']) {
    const app = await boot({ language })
    try {
      assert.equal(app.hostConfig().language, 'auto')
      assert.equal(app.api().language(), language)
      const page = app.render('settings.section')
      assert.ok(textOf(page).includes(NMP_DICTIONARIES[language]['settings.title']))
      assert.equal(find(page, 'data-nmp-setting', 'language').props.value, 'auto')
      // DSH was handed the languages it offers, zh and en among them.
      const registered = Object.keys(app.dictionaries['next-message-predictor']).sort()
      assert.deepEqual(registered, ['de', 'en', 'es', 'fr', 'ja', 'pt', 'ru', 'zh'])
    } finally {
      app.dispose()
    }
  }
  // DSH in a language it cannot name: the page language decides, then English.
  const page = await boot({ language: 'xx', pageLanguage: 'ko-KR' })
  try {
    assert.equal(page.api().language(), 'ko')
  } finally {
    page.dispose()
  }
})

test('one choice in the language list switches the page, and the choice is remembered', async () => {
  const app = await boot({ language: 'zh' })
  let memory
  try {
    let page = app.render('settings.section')
    assert.ok(textOf(page).includes('下一条消息预测'))
    find(page, 'data-nmp-setting', 'language').props.onChange({ target: { value: 'fr' } })
    await tick(5)
    assert.deepEqual(app.writes.at(-1), { language: 'fr' })
    assert.equal(app.api().language(), 'fr')
    page = app.render('settings.section')
    assert.ok(textOf(page).includes(NMP_DICTIONARIES.fr['settings.title']))
    assert.equal(textOf(page).includes('下一条消息预测'), false)
    assert.equal(app.entry('settings.section').options.label(), NMP_DICTIONARIES.fr['settings.nav'])
    // Choosing the language already in use writes nothing.
    const before = app.writes.length
    find(page, 'data-nmp-setting', 'language').props.onChange({ target: { value: 'fr' } })
    await tick(5)
    assert.equal(app.writes.length, before)
    memory = app.localStorage
    assert.equal(memory.getItem('dsh-next-message-predictor.language'), 'fr')
  } finally {
    app.dispose()
  }

  // Next page load, Host slow to answer: the page already starts in French.
  const slow = await boot({ language: 'zh', localStorage: memory, config: { language: 'fr' } })
  try {
    const state = slow.api().config()
    const saved = { ready: state.ready }
    state.ready = false
    assert.equal(slow.api().language(), 'fr')
    state.ready = saved.ready
  } finally {
    slow.dispose()
  }
})

test('a language learnt after registration renames the Settings and sidebar entries', async () => {
  // The page remembers Spanish from the last visit, but the Host now says German
  // (changed from another window, or in the profile file).
  const memory = (() => {
    const map = new Map([['dsh-next-message-predictor.language', 'es']])
    return { getItem: (key) => (map.has(key) ? map.get(key) : null), setItem: (key, value) => map.set(key, String(value)), removeItem: (key) => map.delete(key) }
  })()
  const app = await boot({ language: 'zh', localStorage: memory, config: { language: 'de', sidebarEntry: true } })
  try {
    assert.equal(app.api().language(), 'de')
    assert.equal(memory.getItem('dsh-next-message-predictor.language'), 'de')
    const labels = (name) => app.registry.filter((item) => item.options.name === name).map((item) => item.options.label())
    assert.deepEqual(labels('settings.section'), [NMP_DICTIONARIES.de['settings.nav']], 'one Settings entry, registered again in German')
    assert.deepEqual(labels('sidebar.panellist'), [NMP_DICTIONARIES.de['settings.nav']], 'one sidebar entry, registered again in German')
    assert.equal(app.registrations('settings.section') >= 2, true, 'the Settings entry was registered again')
    assert.ok(app.entry('main', PANEL_ID))
  } finally {
    app.dispose()
  }
  assert.equal(app.registry.length, 0, 'unloading still removes every contribution')
})

test('the composer overlay speaks the chosen language too', async () => {
  const app = await boot({ language: 'zh', config: { language: 'es' } })
  try {
    assert.equal(app.api().language(), 'es')
    assert.equal(app.entry('conversation.input.overlay').options.locale, 'next-message-predictor')
  } finally {
    app.dispose()
  }
})

test('settings page: a Host on another version is called out', async () => {
  const app = await boot()
  try {
    const store = app.api().config
    // Simulate "page refreshed after an update, DSH not restarted yet".
    const runtimeState = store()
    runtimeState.hostVersion = '0.2.1'
    const text = textOf(app.render('settings.section'))
    assert.ok(text.includes('v0.2.1') && text.includes('重启 DSH'), text.slice(0, 200))
    runtimeState.hostVersion = ''
    assert.ok(textOf(app.render('settings.section')).includes('旧版本'))
    runtimeState.hostVersion = PLUGIN_VERSION
  } finally {
    app.dispose()
  }
})

test('settings page: the daily allowance adds up measured, estimated and in-flight tokens and names the last two', async () => {
  const budget = {
    day: '2026-11-11', timeZone: 'UTC', requests: 4, dailyRequestLimit: 200, dailyTokenBudget: 500000,
    inputTokens: 1000, outputTokens: 50, reasoningTokens: 0, estimatedTokens: 1096, reservedTokens: 300, unknownUsage: 1, orphanedCalls: 0,
  }
  const ledger = { ensureLoaded: async () => {}, hasDispatch: () => false, snapshot: () => ({ ...budget }) }
  const app = await boot({ config: { language: 'en' }, ledger })
  try {
    const en = NMP_DICTIONARIES.en
    let text = textOf(app.render('settings.section'))
    // 1,000 + 50 measured, 1,096 estimated, 300 in flight.
    assert.ok(text.includes('2,446 / 500,000 token'), text)
    assert.ok(text.includes(en['settings.budgetReserved'].split('{n}').join('1,096')))
    assert.ok(text.includes(en['settings.budgetInFlight'].split('{n}').join('300')))
    // Nothing estimated, nothing running: the measured figure alone, no notes.
    app.api().config().budget = { ...budget, estimatedTokens: 0, reservedTokens: 0 }
    text = textOf(app.render('settings.section'))
    assert.ok(text.includes('1,050 / 500,000 token'), text)
    assert.equal(text.includes(en['settings.budgetReserved'].split('{n}')[0]), false)
    assert.equal(text.includes(en['settings.budgetInFlight'].split('{n}')[0]), false)
  } finally {
    app.dispose()
  }
})

test('one click adds the sidebar entry and one click removes it', async () => {
  const app = await boot()
  try {
    let page = app.render('settings.section')
    let button = find(page, 'data-nmp-setting', 'sidebarEntry')
    assert.equal(button.props['aria-pressed'], false)
    assert.ok(textOf([button]).includes('添加到左侧栏'))
    button.props.onClick()
    await tick(5)
    assert.deepEqual(app.writes.at(-1), { sidebarEntry: true })
    const entry = app.entry('sidebar.panellist', PANEL_ID)
    assert.ok(entry, 'the entry is in the sidebar panel list')
    assert.equal(entry.options.label(), '消息预测')
    assert.equal(typeof entry.Component, 'function')
    assert.ok(expand(react.createElement(entry.Component, { size: 16, active: false }))[0].type === 'svg')
    // The entry opens the panel of the same id.
    app.selectPanel(PANEL_ID)
    assert.equal(app.activePanel(), PANEL_ID)

    page = app.render('settings.section')
    button = find(page, 'data-nmp-setting', 'sidebarEntry')
    assert.equal(button.props['aria-pressed'], true)
    assert.ok(textOf([button]).includes('从左侧栏移除'))
    button.props.onClick()
    await tick(5)
    assert.deepEqual(app.writes.at(-1), { sidebarEntry: false })
    assert.equal(app.entry('sidebar.panellist'), undefined)
    assert.ok(app.entry('main', PANEL_ID), 'the page stays open after the entry is removed')
    assert.equal(app.activePanel(), PANEL_ID)
  } finally {
    app.dispose()
  }
})

test('a saved sidebar entry is registered on load, and unloading removes everything', async () => {
  const first = await boot({ config: { sidebarEntry: true } })
  assert.ok(first.entry('sidebar.panellist', PANEL_ID))
  first.dispose()
  assert.equal(first.registry.length, 0, 'unloading removes every contribution')
  assert.equal(first.api(), undefined)
})

test('reloading the plugin while its panel is open reopens the panel', async () => {
  const first = await boot({ config: { sidebarEntry: true } })
  first.selectPanel(PANEL_ID)
  first.dispose()
  const leftAt = first.windowStub.__nextMessagePredictorPanelReopen
  assert.equal(typeof leftAt, 'number', 'the unload remembers that the panel was open')

  // A panel that was not open is not reopened.
  const second = await boot()
  second.dispose()
  assert.equal(second.windowStub.__nextMessagePredictorPanelReopen, undefined)
})

test('one click switches the mode, and the switch can be read back', async () => {
  const app = await boot({ config: { enabled: true, showPredictButton: false, provider: 'my-provider', model: 'my-model' } })
  try {
    let page = app.render('settings.section')
    assert.equal(find(page, 'data-nmp-preset', 'balanced').props['aria-pressed'], true)
    find(page, 'data-nmp-preset', 'saver').props.onClick()
    await tick(5)
    assert.equal(matchPreset(app.hostConfig()), 'saver')
    assert.equal(app.hostConfig().manualOnly, true)
    assert.equal(app.hostConfig().showPredictButton, true, 'manual-only keeps a visible trigger')
    assert.equal(app.hostConfig().provider, 'my-provider', "the user's model is kept")
    assert.equal(app.hostConfig().enabled, true)

    page = app.render('settings.section')
    assert.equal(find(page, 'data-nmp-preset', 'saver').props['aria-pressed'], true)
    assert.ok(textOf([find(page, 'data-nmp-setting', 'presetNow')]).includes('省流'))
    // Clicking the mode in use writes nothing.
    const before = app.writes.length
    find(page, 'data-nmp-preset', 'saver').props.onClick()
    await tick(5)
    assert.equal(app.writes.length, before)

    find(page, 'data-nmp-preset', 'quality').props.onClick()
    await tick(5)
    assert.equal(matchPreset(app.hostConfig()), 'quality')
    assert.equal(app.hostConfig().modelMode, 'session')

    // Changing one option by hand makes it "custom".
    const auto = find(app.render('settings.section'), 'data-nmp-setting', 'manualOnly')
    auto.props.onClick()
    await tick(5)
    page = app.render('settings.section')
    assert.equal(matchPreset(app.hostConfig()), '')
    assert.ok(textOf([find(page, 'data-nmp-setting', 'presetNow')]).includes('自定义'))
    for (const id of ['balanced', 'saver', 'quality']) assert.equal(find(page, 'data-nmp-preset', id).props['aria-pressed'], false)
  } finally {
    app.dispose()
  }
})

test('the model dropdown applies at once when the route is complete', async () => {
  const app = await boot()
  try {
    const select = find(app.render('settings.section'), 'data-nmp-setting', 'modelMode')
    select.props.onChange({ target: { value: 'session' } })
    await tick(5)
    assert.equal(app.hostConfig().modelMode, 'session')
    assert.equal(app.writes.at(-1).modelMode, 'session')
  } finally {
    app.dispose()
  }

  // No provider/model yet: choosing "specific model" must wait for the ids.
  const empty = await boot({ config: { modelMode: 'session', provider: '', model: '' } })
  try {
    const before = empty.writes.length
    find(empty.render('settings.section'), 'data-nmp-setting', 'modelMode').props.onChange({ target: { value: 'fixed' } })
    await tick(5)
    assert.equal(empty.writes.length, before)
  } finally {
    empty.dispose()
  }
})

test('pinned phrases: add, reorder and remove locally, then one Save writes exactly one config patch', async () => {
  const app = await boot({ stateful: true, config: { enabled: true, language: 'en' } })
  const en = NMP_DICTIONARIES.en
  try {
    const page = () => app.render('settings.section')
    const type = (text) => find(page(), 'data-nmp-setting', 'pinnedInput').props.onChange({ target: { value: text } })
    const add = () => find(page(), 'data-nmp-setting', 'pinnedAdd').props.onClick()
    const rows = () => {
      const texts = []
      walk(page(), (node) => {
        if (node.props['data-nmp-pinned-row'] !== undefined) texts.push(textOf([node.children[0]]))
      })
      return texts
    }
    assert.ok(find(page(), 'data-nmp-setting', 'pinnedEmpty'))
    assert.equal(textOf([find(page(), 'data-nmp-setting', 'pinnedCount')]), '0 / 10')

    for (const text of ['go on', '  Run the tests  ', 'Commit it']) {
      type(text)
      add()
    }
    assert.deepEqual(rows(), ['go on', 'Run the tests', 'Commit it'], 'trimmed and listed in order')
    assert.equal(find(page(), 'data-nmp-setting', 'pinnedInput').props.value, '', 'the field is cleared after adding')
    // Inline validation: nothing is added, the reason is shown.
    for (const [text, key] of [['Go on!', 'settings.pinnedErrorDuplicate'], ['/compact', 'settings.pinnedErrorCommand'], ['', 'settings.pinnedErrorEmpty'], ['x'.repeat(41), 'settings.pinnedErrorLong'], ['<b>x</b>', 'settings.pinnedErrorInvalid']]) {
      type(text)
      add()
      const error = find(page(), 'data-nmp-setting', 'pinnedError')
      assert.ok(error, text)
      assert.equal(textOf([error]), en[key].split('{n}').join('40'), text)
    }
    assert.equal(rows().length, 3)
    type('')

    // Reorder and remove.
    find(page(), 'data-nmp-pinned-down', '0').props.onClick()
    assert.deepEqual(rows(), ['Run the tests', 'go on', 'Commit it'])
    find(page(), 'data-nmp-pinned-up', '2').props.onClick()
    assert.deepEqual(rows(), ['Run the tests', 'Commit it', 'go on'])
    assert.equal(find(page(), 'data-nmp-pinned-up', '0').props.disabled, true)
    assert.equal(find(page(), 'data-nmp-pinned-down', '2').props.disabled, true)
    find(page(), 'data-nmp-pinned-remove', '0').props.onClick()
    assert.deepEqual(rows(), ['Commit it', 'go on'])

    // Nothing was written while editing; the page says there are unsaved changes.
    assert.equal(app.writes.length, 0)
    assert.equal(textOf([find(page(), 'data-nmp-setting', 'pinnedDirty')]), en['settings.unsaved'])
    find(page(), 'data-nmp-setting', 'pinnedSave').props.onClick()
    await tick(5)
    assert.deepEqual(app.writes, [{ pinnedPhrases: ['Commit it', 'go on'] }], 'exactly one config patch')
    assert.deepEqual(app.hostConfig().pinnedPhrases, ['Commit it', 'go on'])
    assert.equal(find(page(), 'data-nmp-setting', 'pinnedDirty'), null, 'saved: no pending changes')
    assert.deepEqual(rows(), ['Commit it', 'go on'])
    // The note offers to undo the whole list change.
    const message = find(page(), 'data-nmp-setting', 'message')
    assert.ok(textOf([message]).includes(en['settings.pinnedSaved']))
    find(page(), 'data-nmp-setting', 'undo').props.onClick()
    await tick(5)
    assert.deepEqual(app.writes.at(-1), { pinnedPhrases: [] })

    // Discard drops a draft without writing.
    type('Ship it')
    add()
    assert.ok(find(page(), 'data-nmp-setting', 'pinnedDirty'))
    find(page(), 'data-nmp-setting', 'pinnedDiscard').props.onClick()
    assert.deepEqual(rows(), [])
    assert.equal(app.writes.length, 2)
    // A full list refuses an eleventh phrase.
    for (let i = 0; i < 10; i += 1) {
      type(`phrase ${i}`)
      add()
    }
    assert.equal(find(page(), 'data-nmp-setting', 'pinnedAdd').props.disabled, true)
    type('one more')
    add()
    assert.equal(textOf([find(page(), 'data-nmp-setting', 'pinnedError')]), en['settings.pinnedErrorFull'].split('{n}').join('10'))
    assert.equal(rows().length, 10)
    // The modes do not write the list.
    find(page(), 'data-nmp-preset', 'saver').props.onClick()
    await tick(5)
    assert.equal('pinnedPhrases' in app.writes.at(-1), false)
  } finally {
    app.dispose()
  }
})

test('settings page: the results card names how many accepted suggestions were the user\'s own phrases', async () => {
  const summary = {
    requests: 6, offers: 5, abstains: 1, shown: 5, accepted: 3, acceptedBySource: { model: 1, habit: 1, pinned: 1 },
    acceptRate: 25, latencyP50: 1200, latencyP95: 2400, tokenDays: [], abstainReasons: [],
  }
  const results = { recordRequest() {}, recordOutcome: async () => {}, summary: async () => summary }
  for (const [language, expected] of [['en', ', 2 of them your own phrases, acceptance rate of model suggestions 25%'], ['zh', '，其中 2 条是你自己的短语，模型建议的采纳率 25%']]) {
    const app = await boot({ stateful: true, results, config: { language } })
    try {
      app.render('settings.section', undefined, { effects: true })
      await tick(10)
      const text = textOf([find(app.render('settings.section'), 'data-nmp-setting', 'results')])
      assert.ok(text.includes(expected), text)
    } finally {
      app.dispose()
    }
  }
  // Only model suggestions accepted: no extra phrase.
  const plain = { ...summary, accepted: 1, acceptedBySource: { model: 1, habit: 0, pinned: 0 } }
  const app = await boot({ stateful: true, results: { ...results, summary: async () => plain }, config: { language: 'en' } })
  try {
    app.render('settings.section', undefined, { effects: true })
    await tick(10)
    const text = textOf([find(app.render('settings.section'), 'data-nmp-setting', 'results')])
    assert.ok(text.includes('1, acceptance rate of model suggestions 25%'), text)
  } finally {
    app.dispose()
  }
})
