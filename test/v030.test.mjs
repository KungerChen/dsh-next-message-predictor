// 0.3.0: version, one-click modes, sidebar entry option, readable reason codes,
// and the bugs fixed in the same release (see CHANGELOG.md).
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { DEFAULT_CONFIG, PANEL_ID, SETTING_LIMITS, checkConfigField, configRevision, normalizeConfig, sanitizeConfigPatch } from '../src/shared/config.js'
import { PRESETS, PRESET_IDS, RECOMMENDED_PRESET, RECOMMENDED_ROUTE, isPresetId, matchPreset, presetPatch } from '../src/shared/presets.js'
import { PLUGIN_VERSION } from '../src/shared/version.js'
import { NMP_DICTIONARIES } from '../src/client/i18n.js'
import { nmpCodeLabel, nmpLookupCode } from '../src/client/labels.js'
import { createClientRuntime } from '../src/client/controller.js'
import { createModelProvider, pickReasoningEffort } from '../src/host/model-provider.js'
import { createPredictorService } from '../src/host/predictor-service.js'
import { createResultsLog } from '../src/host/results-log.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

// ── version ────────────────────────────────────────────────────────────────

test('version: source, package.json and the built bundle agree', async () => {
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  assert.equal(PLUGIN_VERSION, pkg.version)
  assert.match(PLUGIN_VERSION, /^\d+\.\d+\.\d+$/)
  const bundle = await readFile(join(root, 'lib', 'client.js'), 'utf8')
  assert.ok(bundle.includes(`const PLUGIN_VERSION = '${pkg.version}'`), 'lib/client.js is stale: run `npm run build`')
  const entry = await import('../lib/index.js')
  assert.equal(entry.VERSION, pkg.version)
})

test('version: the Host reports it in status and the page keeps it', async () => {
  const service = createPredictorService({
    config: { ...DEFAULT_CONFIG },
    adapter: { capabilities: () => ({ connectionFetch: true, configEditor: true }), connectionAvailable: true, configEditorAvailable: true },
  })
  const status = await service.handle({ schemaVersion: 1, operation: 'status' })
  assert.equal(status.body.value.version, PLUGIN_VERSION)

  const runtime = createClientRuntime({ rpc: async () => status.body })
  assert.equal(runtime.configStore.getSnapshot().hostVersion, '')
  await runtime.loadStatus()
  assert.equal(runtime.configStore.getSnapshot().hostVersion, PLUGIN_VERSION)

  // A Host from before 0.3.0 sends no version: the page must read that as "unknown".
  const old = createClientRuntime({ rpc: async () => ({ ok: true, value: { config: {}, configRevision: 1 } }) })
  await old.loadStatus()
  assert.equal(old.configStore.getSnapshot().hostVersion, '')
})

// ── sidebar entry ──────────────────────────────────────────────────────────

test('sidebarEntry: a boolean option, off by default, part of the revision', () => {
  assert.equal(DEFAULT_CONFIG.sidebarEntry, false)
  assert.equal(checkConfigField('sidebarEntry', true).ok, true)
  assert.equal(checkConfigField('sidebarEntry', 'yes').ok, false)
  assert.equal(sanitizeConfigPatch({ sidebarEntry: true }).ok, true)
  assert.equal(normalizeConfig({ sidebarEntry: true }).config.sidebarEntry, true)
  assert.notEqual(configRevision({ ...DEFAULT_CONFIG }), configRevision({ ...DEFAULT_CONFIG, sidebarEntry: true }))
  assert.equal(PANEL_ID, 'next-message-predictor')
})

test('shell store: starts with no panel and no sidebar, and can be updated', () => {
  const runtime = createClientRuntime({ rpc: async () => ({}) })
  assert.deepEqual(runtime.shellStore.getSnapshot(), { panelAvailable: false, sidebarAvailable: false, language: '' })
  let notified = 0
  runtime.shellStore.subscribe(() => { notified += 1 })
  runtime.shellStore.set({ sidebarAvailable: true })
  assert.equal(runtime.shellStore.getSnapshot().sidebarAvailable, true)
  assert.equal(notified, 1)
})

// ── modes ──────────────────────────────────────────────────────────────────

test('modes: every value is a valid config value inside the settings range', () => {
  assert.deepEqual([...PRESET_IDS], ['balanced', 'saver', 'quality'])
  assert.ok(isPresetId(RECOMMENDED_PRESET))
  const fields = Object.keys(PRESETS.balanced).sort()
  for (const id of PRESET_IDS) {
    // Same fields in every mode: switching is exact, and matchPreset is unambiguous.
    assert.deepEqual(Object.keys(PRESETS[id]).sort(), fields, id)
    for (const [key, value] of Object.entries(PRESETS[id])) {
      assert.equal(checkConfigField(key, value).ok, true, `${id}.${key}`)
      const limits = SETTING_LIMITS[key]
      if (limits !== undefined) assert.ok(value >= limits.min && value <= limits.max, `${id}.${key} outside the settings range`)
    }
    assert.equal(sanitizeConfigPatch(PRESETS[id]).ok, true)
    // The character cap follows the token target, as the settings page keeps it.
    assert.equal(PRESETS[id].maxContextCodePoints, PRESETS[id].targetInputTokens * 3)
  }
})

test('modes: never touch the master switch, privacy, shortcut, sidebar entry or language', () => {
  for (const id of PRESET_IDS) {
    for (const key of ['enabled', 'redactSecrets', 'includeTurnFacts', 'predictShortcut', 'sidebarEntry', 'language', 'announceSuggestions', 'habitSuggestions', 'fakeSuggestion']) {
      assert.equal(key in PRESETS[id], false, `${id} must not set ${key}`)
      assert.equal(key in presetPatch(id, { ...DEFAULT_CONFIG, showPredictButton: false, provider: '', model: '' }), false, `${id} patch must not set ${key}`)
    }
  }
})

test('modes: the shipped defaults are the recommended mode; edits make it custom', () => {
  assert.equal(matchPreset(DEFAULT_CONFIG), 'balanced')
  assert.equal(matchPreset({ ...DEFAULT_CONFIG, manualOnly: true }), '')
  assert.equal(matchPreset({ ...DEFAULT_CONFIG, contextMessages: 13 }), '')
  // Options a mode does not own do not make the config "custom".
  assert.equal(matchPreset({ ...DEFAULT_CONFIG, enabled: true, redactSecrets: false, sidebarEntry: true, provider: 'my-provider', model: 'my-model' }), 'balanced')
  assert.equal(matchPreset(null), '')
  for (const id of PRESET_IDS) {
    const applied = { ...DEFAULT_CONFIG, ...presetPatch(id, DEFAULT_CONFIG) }
    assert.equal(matchPreset(applied), id)
    assert.equal(normalizeConfig(applied).errors.length, 0)
  }
})

test('modes: switching keeps the user\'s model and repairs an unusable setup', () => {
  // A route the user entered survives a fixed-model mode.
  const custom = { ...DEFAULT_CONFIG, provider: 'my-provider', model: 'my-model', reasoningEffort: 'low' }
  const saver = presetPatch('saver', custom)
  assert.equal('provider' in saver, false)
  assert.equal('model' in saver, false)
  assert.equal('reasoningEffort' in saver, false)
  // An empty or offline-test route is replaced by the recommended one.
  for (const broken of [{ provider: '', model: '' }, { provider: 'fixed-test', model: 'x' }, { provider: 'p', model: '  ' }]) {
    const patch = presetPatch('balanced', { ...DEFAULT_CONFIG, ...broken })
    assert.equal(patch.provider, RECOMMENDED_ROUTE.provider)
    assert.equal(patch.model, RECOMMENDED_ROUTE.model)
    assert.equal(patch.reasoningEffort, RECOMMENDED_ROUTE.reasoningEffort)
  }
  // The session-model mode never needs a route.
  assert.equal('provider' in presetPatch('quality', { ...DEFAULT_CONFIG, provider: '', model: '' }), false)
  // Manual-only needs a visible trigger.
  assert.equal(presetPatch('saver', { ...DEFAULT_CONFIG, showPredictButton: false }).showPredictButton, true)
  assert.equal('showPredictButton' in presetPatch('saver', DEFAULT_CONFIG), false)
  assert.equal('showPredictButton' in presetPatch('balanced', { ...DEFAULT_CONFIG, showPredictButton: false }), false)
  assert.equal(presetPatch('nope', DEFAULT_CONFIG), null)
})

// ── reason codes ───────────────────────────────────────────────────────────

test('reason codes: whole code, detail-less code, then family', () => {
  const dictionary = {
    'reason.manual-limit': 'limit',
    'reason.config-changed': 'changed',
    'reason.prepare-failed': 'prepare',
    'reason.unsupported-reasoning-effort': 'effort',
    'reason.finish': 'finish',
    'reason.finish-max-tokens': 'max tokens',
    'reason.output': 'output',
    'reason.semantic': 'semantic',
    'reason.no-route-fixed-route-incomplete': 'incomplete',
    'reason.finish-aborted-aborted': 'cancelled',
    'state.offered': 'showing',
  }
  const t = (key) => dictionary[key] ?? key
  assert.equal(nmpCodeLabel(t, 'reason', 'manual-limit'), 'limit')
  assert.equal(nmpCodeLabel(t, 'reason', 'stale:config-changed'), 'changed')
  assert.equal(nmpCodeLabel(t, 'reason', 'prepare-failed:provider "x" not found'), 'prepare')
  assert.equal(nmpCodeLabel(t, 'reason', 'prepare-failed:unsupported-reasoning-effort:off'), 'effort')
  assert.equal(nmpCodeLabel(t, 'reason', 'finish-max-tokens'), 'max tokens')
  assert.equal(nmpCodeLabel(t, 'reason', 'finish-error:rate_limited'), 'finish')
  assert.equal(nmpCodeLabel(t, 'reason', 'finish-aborted:aborted'), 'cancelled')
  assert.equal(nmpCodeLabel(t, 'reason', 'output-too-long'), 'output')
  assert.equal(nmpCodeLabel(t, 'reason', 'semantic-praise-or-thanks'), 'semantic')
  assert.equal(nmpCodeLabel(t, 'reason', 'no-route:fixed-route-incomplete'), 'incomplete')
  assert.equal(nmpCodeLabel(t, 'state', 'offered'), 'showing')
  // Unknown codes are shown as they are, never hidden.
  assert.equal(nmpCodeLabel(t, 'reason', 'something-new'), 'something-new')
  assert.equal(nmpLookupCode(t, 'reason', 'something-new'), '')
  assert.equal(nmpCodeLabel(t, 'reason', ''), '')
  assert.equal(nmpCodeLabel(t, 'reason', undefined), '')
})

test('reason codes: every code family the Host can send has wording in every language', () => {
  const dictionaries = NMP_DICTIONARIES
  assert.ok(Object.keys(dictionaries.en).length > 200)
  for (const language of Object.keys(dictionaries)) {
    const t = (key) => dictionaries[language][key] ?? key
    for (const code of [
      'prepare-failed:x', 'fallback-failed:x', 'stream-failed:x', 'finish-max-tokens', 'finish-error:x', 'finish-aborted:timeout',
      'output-invalid-json', 'output-multiline', 'semantic-meta-talk', 'fixed-suggestion-too-long', 'invalid-response:turn mismatch',
      'insert-rejected', 'internal-error', 'unknown-session', 'session-removed', 'manual-limit', 'daily-token-budget',
      'timeout', 'transport', 'ledger-write-failed', 'host-unavailable',
      'prepare-failed:unsupported-reasoning-effort:off', 'stale:turn-dismissed', 'no-route:no-session-selection',
    ]) {
      assert.notEqual(nmpLookupCode(t, 'reason', code), '', `${language}: no wording for "${code}"`)
    }
    for (const id of PRESET_IDS) {
      assert.ok(typeof dictionaries[language][`preset.${id}.name`] === 'string' && dictionaries[language][`preset.${id}.name`] !== '')
      assert.ok(typeof dictionaries[language][`preset.${id}.desc`] === 'string' && dictionaries[language][`preset.${id}.desc`] !== '')
    }
  }
})

// ── "another one" availability ─────────────────────────────────────────────

function env(overrides) {
  return {
    sessionId: 's1', turnId: 'a1', completedEventSeq: 0, branchEpoch: 'v1', contextRevision: '4:1', running: false,
    hasFinalText: true, sessionBlank: false, sessionRemoved: false, awaitingFirstTurn: false, canEdit: true, draft: '',
    draftRev: 0, occurrencesCount: 0, attachmentCount: 0, queuedCount: 0, claimed: false, phase: 'plain', composing: false,
    pendingInteraction: false, menuOpen: false, windowVisible: true, windowFocused: true, focused: true, inputMissing: false,
    ...(overrides ?? {}),
  }
}

test('"another one" is offered only while it can still do something', async () => {
  let serial = 0
  const runtime = createClientRuntime({
    rpc: async (operation, payload) => {
      if (operation === 'status') {
        return {
          ok: true,
          value: {
            config: { ...DEFAULT_CONFIG, enabled: true, manualOnly: true, manualLimit: 2 },
            configRevision: 1,
            capabilities: { connectionFetch: true },
          },
        }
      }
      if (operation === 'predict') {
        serial += 1
        return {
          requestId: payload.requestId,
          anchor: payload.anchor,
          configRevision: 1,
          // First answer brings two candidates, the second a single one.
          result: serial === 1
            ? { kind: 'offer', suggestionId: 'sug-1', text: '甲', alternatives: ['乙'], expiresAt: Date.now() + 600000 }
            : { kind: 'offer', suggestionId: 'sug-2', text: '丙', expiresAt: Date.now() + 600000 },
        }
      }
      return { ok: true, value: {} }
    },
  })
  await runtime.loadStatus()
  runtime.sync(env())
  assert.equal(runtime.canOfferAnother(), false, 'nothing is showing yet')
  runtime.predictNow()
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(runtime.assistStore.getSnapshot().text, '甲')
  assert.equal(runtime.canOfferAnother(), true, 'a second candidate is in hand')
  assert.equal(runtime.predictNow().local, true)
  assert.equal(runtime.assistStore.getSnapshot().text, '乙')
  // Past the last candidate: the second (and last allowed) model call.
  runtime.predictNow()
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(runtime.assistStore.getSnapshot().text, '丙')
  assert.equal(serial, 2)
  assert.equal(runtime.canOfferAnother(), false, 'one candidate, no manual predictions left')
  assert.equal(runtime.predictNow().ok, false)
  assert.equal(runtime.assistStore.getSnapshot().text, '丙', 'the suggestion on screen stays')
  runtime.dispose()
})

// ── results: "shown" is a fact, not the final outcome ──────────────────────

function offerInput(overrides) {
  return {
    requestId: 'req-1', suggestionId: 'sug-1', sessionId: 'session-1', turnKey: 'session-1\u0000v1\u0000t1a17', trigger: 'auto',
    outcome: 'offer', reason: '', text: '继续第二项', route: { provider: 'p', model: 'm' }, latencyMs: 1500,
    usage: { inputTokens: 500, outputTokens: 12, reasoningTokens: 0 }, suggestionGraphemes: 5, ...(overrides ?? {}),
  }
}

test('results: shown reported through recordOutcome still lets accepted and the match count', async () => {
  const home = await mkdtemp(join(tmpdir(), 'nmp-v030-'))
  try {
    const clock = 1_800_000_000_000
    const log = createResultsLog({ homeDir: home, now: () => clock, getTimeZone: () => 'UTC' })
    await log.recordRequest(offerInput())
    // This is the path the service used before 0.3.0.
    await log.recordOutcome('sug-1', 'shown')
    await log.recordOutcome('sug-1', 'accepted')
    assert.equal(log.noteUserMessage('session-1', '继续第二项').matched, true)
    await log.flush()
    const summary = await log.summary(7)
    assert.equal(summary.shown, 1)
    assert.equal(summary.accepted, 1)
    assert.equal(summary.acceptRate, 100)
    assert.equal(summary.acceptedUnalteredRate, 100)
    const lines = (await readFile(log.filePath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
    assert.deepEqual(lines.map((line) => `${line.kind}:${line.event ?? line.outcome ?? ''}`), ['request:offer', 'level:shown', 'outcome:accepted', 'match:'])
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('results: accepting implies shown, and logs written by 0.2.x are summarised correctly', async () => {
  const home = await mkdtemp(join(tmpdir(), 'nmp-v030-'))
  try {
    const clock = 1_800_000_000_000
    const log = createResultsLog({ homeDir: home, now: () => clock, getTimeZone: () => 'UTC' })
    // The "shown" report was lost; the accept still counts as shown.
    await log.recordRequest(offerInput())
    await log.recordOutcome('sug-1', 'accepted')
    await log.flush()
    let summary = await log.summary(7)
    assert.equal(summary.shown, 1)
    assert.equal(summary.accepted, 1)
    // A second offer in the 0.2.x on-disk form: "shown" as an outcome line, then "accepted".
    const dir = join(home, 'next-message-predictor')
    await mkdir(dir, { recursive: true })
    const legacy = [
      { t: clock, kind: 'request', r: 'r2', s: 's', k: 'k', trigger: 'manual', outcome: 'offer', reason: '', g: 'legacy-g', latencyMs: 900 },
      { t: clock, kind: 'outcome', g: 'legacy-g', event: 'shown', reason: '' },
      { t: clock, kind: 'outcome', g: 'legacy-g', event: 'accepted', reason: '' },
      { t: clock, kind: 'request', r: 'r3', s: 's', k: 'k', trigger: 'manual', outcome: 'offer', reason: '', g: 'legacy-h', latencyMs: 900 },
      { t: clock, kind: 'outcome', g: 'legacy-h', event: 'shown', reason: '' },
      { t: clock, kind: 'outcome', g: 'legacy-h', event: 'closed', reason: '' },
    ]
    // Named like a file rotated at the test clock's "now", so it falls inside the 7-day window.
    await writeFile(join(dir, `events.${new Date(clock).toISOString().replace(/[:.]/g, '-')}.jsonl`), `${legacy.map((line) => JSON.stringify(line)).join('\n')}\n`, 'utf8')
    // A fresh instance, as after a restart: the running one caches its summary for a few seconds.
    summary = await createResultsLog({ homeDir: home, now: () => clock, getTimeZone: () => 'UTC' }).summary(7)
    assert.equal(summary.offers, 3)
    assert.equal(summary.shown, 3)
    assert.equal(summary.accepted, 2)
    assert.equal(summary.closed, 1)
    assert.equal(summary.acceptRate, 66.7)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('service: a "shown" report marks the offer shown instead of closing it', async () => {
  const calls = []
  const results = {
    recordRequest: async () => {},
    markShown: async (id) => { calls.push(['markShown', id]) },
    recordOutcome: async (id, event) => { calls.push(['recordOutcome', id, event]) },
  }
  const service = createPredictorService({
    config: { ...DEFAULT_CONFIG, enabled: true },
    adapter: { capabilities: () => ({}), connectionAvailable: true, configEditorAvailable: true },
    results,
  })
  await service.handle({ schemaVersion: 1, operation: 'outcome', suggestionId: 'sug-9', event: 'shown' })
  await service.handle({ schemaVersion: 1, operation: 'outcome', suggestionId: 'sug-9', event: 'expired' })
  assert.deepEqual(calls, [['markShown', 'sug-9'], ['recordOutcome', 'sug-9', 'expired']])
})

// ── model: an effort level belongs to the model it was entered for ─────────

test('reasoning effort: strict for the specific model, a preference otherwise', async () => {
  const model = { reasoning: { efforts: [{ id: 'low' }, { id: 'high' }] } }
  assert.equal(pickReasoningEffort(model, 'off').ok, false)
  assert.equal(pickReasoningEffort(model, 'off', { strict: true }).ok, false)
  assert.deepEqual(pickReasoningEffort(model, 'off', { strict: false }), { ok: true, effort: 'low', reason: 'preferred-low-cost' })
  assert.deepEqual(pickReasoningEffort(model, 'high', { strict: false }), { ok: true, effort: 'high', reason: 'explicit' })

  const calls = []
  const llm = {
    async prepareCall(callConfig, signal, configure) {
      // The specific model is not configured; the session model offers no "off".
      if (callConfig.provider === 'fixed-p') throw new Error('provider "fixed-p" is not configured')
      const controls = configure({ maxTokens: callConfig.maxTokens }, model)
      calls.push({ ...callConfig, ...controls })
      return {
        config: { ...callConfig, ...controls },
        stream: () => (async function* () {
          yield { type: 'text-delta', text: '{"suggestion":null}' }
          yield { type: 'finish', reason: { kind: 'stop' } }
        })(),
      }
    },
  }
  const provider = createModelProvider({ getLlm: () => llm, getDefaultModel: () => ({ provider: 'session-p', model: 'session-m' }) })

  // Follow the session model with the default effort "off" left in the config.
  const sessionConfig = { ...DEFAULT_CONFIG, modelMode: 'session', reasoningEffort: 'off' }
  const followed = await provider.produce({
    system: 's', input: 'i', config: sessionConfig, route: provider.resolveRoute(sessionConfig, { provider: 'session-p', model: 'session-m' }),
  })
  assert.equal(followed.kind, 'raw')
  assert.equal(calls.at(-1).reasoningEffort, 'low')

  // Specific model unavailable: the fallback to the session model must not fail on the effort either.
  const fixedConfig = { ...DEFAULT_CONFIG, modelMode: 'fixed', provider: 'fixed-p', model: 'fixed-m', reasoningEffort: 'off' }
  const fallback = await provider.produce({ system: 's', input: 'i', config: fixedConfig, route: provider.resolveRoute(fixedConfig) })
  assert.equal(fallback.kind, 'raw')
  assert.equal(calls.at(-1).provider, 'session-p')
  assert.equal(calls.at(-1).reasoningEffort, 'low')
})

// ── config change without a plugin restart ─────────────────────────────────

test('service: a saved config is handed to onConfigChange', async () => {
  const seen = []
  const service = createPredictorService({
    config: { ...DEFAULT_CONFIG },
    adapter: {
      capabilities: () => ({}),
      connectionAvailable: true,
      configEditorAvailable: true,
      persistConfig: async (patch) => ({ ok: true, config: { ...DEFAULT_CONFIG, ...patch }, restarted: false }),
    },
    onConfigChange: (config) => seen.push(config),
  })
  const response = await service.handle({ schemaVersion: 1, operation: 'config.set', patch: { dailyRequestLimit: 60, sidebarEntry: true } })
  assert.equal(response.body.ok, true)
  assert.equal(response.body.value.config.sidebarEntry, true)
  assert.equal(seen.length, 1)
  assert.equal(seen[0].dailyRequestLimit, 60)
})
