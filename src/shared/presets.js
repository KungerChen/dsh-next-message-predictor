// One-click modes ("presets") for dsh-next-message-predictor.
//
// A mode is a named set of option values. Choosing one in Settings writes all
// of them in a single config change, so the user does not have to understand
// each option to get a sensible setup.
//
// Rules a mode follows:
// - It never turns prediction on or off (`enabled` stays the user's switch).
// - It never touches privacy options (`redactSecrets`, `includeTurnFacts`),
//   the shortcut, the sidebar entry or the screen-reader option.
// - It sets the model *strategy* (`modelMode`), not the model: a provider and
//   model the user already entered are kept. Only an empty or offline-test
//   route is replaced by the recommended one.
// - Every mode sets the same fields, so switching between modes is exact and
//   "which mode is active" can be read back from the config.
//
// Imported by the Host as ESM (tests) and concatenated into the browser bundle
// by scripts/build-client.mjs: plain declarations only.

import { DEFAULT_CONFIG } from './config.js'

/** The model route this plugin ships with. */
export const RECOMMENDED_ROUTE = Object.freeze({
  modelMode: 'fixed',
  provider: DEFAULT_CONFIG.provider,
  model: DEFAULT_CONFIG.model,
  reasoningEffort: DEFAULT_CONFIG.reasoningEffort,
})

/** Provider id of the offline test path; never a real route. */
const OFFLINE_TEST_PROVIDER = 'fixed-test'

/** Display order in Settings. `balanced` equals the shipped defaults. */
export const PRESET_IDS = Object.freeze(['balanced', 'saver', 'quality'])

/** The mode Settings marks as recommended. */
export const RECOMMENDED_PRESET = 'balanced'

export const PRESETS = Object.freeze({
  // Automatic prediction with a fixed low-cost model: the shipped defaults.
  balanced: Object.freeze({
    manualOnly: DEFAULT_CONFIG.manualOnly,
    modelMode: 'fixed',
    multiCandidates: DEFAULT_CONFIG.multiCandidates,
    candidateCount: DEFAULT_CONFIG.candidateCount,
    manualLimit: DEFAULT_CONFIG.manualLimit,
    contextMessages: DEFAULT_CONFIG.contextMessages,
    targetInputTokens: DEFAULT_CONFIG.targetInputTokens,
    maxContextCodePoints: DEFAULT_CONFIG.maxContextCodePoints,
    maxOutputTokens: DEFAULT_CONFIG.maxOutputTokens,
    timeoutMs: DEFAULT_CONFIG.timeoutMs,
    dailyRequestLimit: DEFAULT_CONFIG.dailyRequestLimit,
    dailyTokenBudget: DEFAULT_CONFIG.dailyTokenBudget,
  }),
  // Predict only when asked, with a shorter excerpt and a lower daily ceiling.
  saver: Object.freeze({
    manualOnly: true,
    modelMode: 'fixed',
    multiCandidates: true,
    candidateCount: 3,
    manualLimit: 2,
    contextMessages: 6,
    targetInputTokens: 1000,
    maxContextCodePoints: 3000,
    maxOutputTokens: 96,
    timeoutMs: 8000,
    dailyRequestLimit: 60,
    dailyTokenBudget: 150000,
  }),
  // Follow the session model and send more of the conversation.
  quality: Object.freeze({
    manualOnly: false,
    modelMode: 'session',
    multiCandidates: true,
    candidateCount: 3,
    manualLimit: 3,
    contextMessages: 20,
    targetInputTokens: 4000,
    maxContextCodePoints: 12000,
    maxOutputTokens: 160,
    timeoutMs: 15000,
    dailyRequestLimit: 200,
    dailyTokenBudget: 1000000,
  }),
})

/** Whether a string names one of the modes. */
export function isPresetId(id) {
  return typeof id === 'string' && PRESET_IDS.includes(id)
}

/**
 * The mode the config currently equals, or '' when the options were changed by
 * hand ("custom"). Only the fields a mode owns are compared.
 */
export function matchPreset(config) {
  if (config === null || typeof config !== 'object') return ''
  for (const id of PRESET_IDS) {
    const values = PRESETS[id]
    if (Object.keys(values).every((key) => config[key] === values[key])) return id
  }
  return ''
}

/**
 * The config patch that switches to a mode.
 *
 * Besides the mode's own values this keeps the result usable:
 * - a fixed-model mode needs a route; an empty or offline-test route is filled
 *   with the recommended one, an existing route is left alone;
 * - a manual-only mode needs a visible trigger, so the "Predict" button is
 *   switched back on when it was hidden.
 * @returns {object | null} null for an unknown mode id.
 */
export function presetPatch(id, config) {
  if (!isPresetId(id)) return null
  const current = config !== null && typeof config === 'object' ? config : {}
  const patch = { ...PRESETS[id] }
  if (patch.modelMode === 'fixed') {
    const provider = typeof current.provider === 'string' ? current.provider.trim() : ''
    const model = typeof current.model === 'string' ? current.model.trim() : ''
    if (provider === '' || model === '' || provider === OFFLINE_TEST_PROVIDER) {
      patch.provider = RECOMMENDED_ROUTE.provider
      patch.model = RECOMMENDED_ROUTE.model
      patch.reasoningEffort = RECOMMENDED_ROUTE.reasoningEffort
    }
  }
  if (patch.manualOnly === true && current.showPredictButton === false) patch.showPredictButton = true
  return patch
}
