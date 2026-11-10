// Smoke test of the shipped browser bundle (lib/client.js), wired to a real
// Host service in-process.
//
// `node --check` only proves the bundle parses. This loads it the way DSH does
// (ModuleLoader factory + host React), applies the plugin against a fake slot
// registry, renders the Settings page with a minimal React stand-in and clicks
// through the 0.3.0 features. A missing function, a missing locale key or a
// registration that never happens fails here instead of in the user's window.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { DEFAULT_CONFIG, PANEL_ID, ROUTE } from '../src/shared/config.js'
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
    })
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
  }
  globalThis.localStorage = storage()
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
    return react
  })

  /** @type {{options: object, Component: Function}[]} */
  const registry = []
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
  const render = (name, id) => expand(react.createElement(entry(name, id).Component, null))
  return {
    registry,
    entry,
    render,
    writes,
    api: () => windowStub.__nextMessagePredictor,
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

for (const language of ['zh', 'en']) {
  test(`settings page (${language}): renders with version, modes and no untranslated key`, async () => {
    const app = await boot({ language })
    try {
      const page = app.render('settings.section')
      const text = textOf(page)
      assert.ok(text.includes(`v${PLUGIN_VERSION}`), 'the version is in the header')
      assert.equal(textOf([find(page, 'data-nmp-setting', 'version')]), `v${PLUGIN_VERSION}`)
      assert.equal(find(page, 'data-nmp-setting', 'versionMismatch'), null)
      assert.ok(find(page, 'data-nmp-setting', 'sidebarEntry'), 'the add-to-sidebar button is offered')
      for (const id of ['balanced', 'saver', 'quality']) assert.ok(find(page, 'data-nmp-preset', id), `mode ${id}`)
      assert.equal(find(page, 'data-nmp-preset', 'balanced').props['aria-pressed'], true)
      assert.equal(find(page, 'data-nmp-preset', 'saver').props['aria-pressed'], false)
      for (const name of ['enabled', 'manualOnly', 'showPredictButton', 'predictShortcut', 'habitSuggestions', 'multiCandidates', 'modelMode', 'advanced', 'restoreAdvanced']) {
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
