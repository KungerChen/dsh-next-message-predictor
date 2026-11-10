// Unit tests for the shared config/protocol/output validation contract.
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  DEFAULT_CONFIG,
  configRevision,
  normalizeConfig,
  sanitizeConfigPatch,
  checkConfigField,
  isValidTimeZone,
  resolveSystemTimeZone,
} from '../src/shared/config.js'
import {
  validatePredictRequest,
  validateResponseForClient,
  validateTurnAnchor,
} from '../src/shared/protocol.js'
import { countGraphemes, parsePredictionJson, validateSuggestionText } from '../src/shared/output-validation.js'
import { buildPredictionInput, buildSystemPrompt, estimateTokens, PROMPT_VERSION } from '../src/shared/prompt.js'

const ANCHOR = {
  sessionId: 'session-1',
  branchEpoch: 'v1',
  turnId: 'a7',
  completedEventSeq: 0,
  contextRevision: '9:7',
}

function predictRequest(overrides) {
  return {
    schemaVersion: 1,
    operation: 'predict',
    requestId: 'req-1',
    viewId: 'view-1',
    anchor: { ...ANCHOR },
    expectedConfigRevision: 1,
    trigger: 'auto',
    ...overrides,
  }
}

test('default config is disabled and model-free', () => {
  assert.equal(DEFAULT_CONFIG.enabled, false)
  assert.equal(DEFAULT_CONFIG.fakeSuggestion, '')
  assert.equal(DEFAULT_CONFIG.triggerDelayMs, 250)
  // O04: 默认固定快模型、关闭推理、更短的输出预算。
  assert.equal(DEFAULT_CONFIG.modelMode, 'fixed')
  assert.equal(DEFAULT_CONFIG.provider, 'deepseek-official')
  assert.equal(DEFAULT_CONFIG.model, 'deepseek-flash')
  assert.equal(DEFAULT_CONFIG.reasoningEffort, 'off')
  assert.equal(DEFAULT_CONFIG.maxOutputTokens, 96)
})

test('normalizeConfig applies defaults and reports unknown/invalid fields', () => {
  const { config, errors } = normalizeConfig({ enabled: 'yes', triggerDelayMs: 300, nope: 1 })
  assert.equal(config.enabled, false)
  assert.equal(config.triggerDelayMs, 300)
  assert.ok(errors.some((error) => error.includes('enabled')))
  assert.ok(errors.some((error) => error.includes('nope')))
})

test('normalizeConfig tolerates missing/undefined loader config', () => {
  assert.deepEqual(normalizeConfig(undefined).errors, [])
  assert.equal(normalizeConfig(null).config.enabled, false)
})

test('sanitizeConfigPatch rejects unknown keys and out-of-range values', () => {
  assert.equal(sanitizeConfigPatch({}).ok, false)
  assert.equal(sanitizeConfigPatch({ nope: 1 }).ok, false)
  assert.equal(sanitizeConfigPatch({ triggerDelayMs: 40000 }).ok, false)
  assert.equal(sanitizeConfigPatch({ triggerDelayMs: 1.5 }).ok, false)
  const ok = sanitizeConfigPatch({ enabled: true, fakeSuggestion: '继续' })
  assert.equal(ok.ok, true)
  assert.deepEqual(ok.patch, { enabled: true, fakeSuggestion: '继续' })
})

test('checkConfigField validates enum, boolean and time zone', () => {
  assert.equal(checkConfigField('modelMode', 'fixed').ok, true)
  assert.equal(checkConfigField('modelMode', 'cheap').ok, false)
  assert.equal(checkConfigField('announceSuggestions', 1).ok, false)
  assert.equal(isValidTimeZone('America/Chicago'), true)
  assert.equal(isValidTimeZone('Not/AZone'), false)
})

test('configRevision is stable and changes with config', () => {
  const a = normalizeConfig({ enabled: true }).config
  const b = normalizeConfig({ enabled: true }).config
  const c = normalizeConfig({ enabled: true, triggerDelayMs: 500 }).config
  assert.equal(configRevision(a), configRevision(b))
  assert.notEqual(configRevision(a), configRevision(c))
})

test('validateTurnAnchor requires identities', () => {
  assert.equal(validateTurnAnchor(ANCHOR), '')
  assert.notEqual(validateTurnAnchor({ ...ANCHOR, sessionId: '' }), '')
  assert.notEqual(validateTurnAnchor({ ...ANCHOR, completedEventSeq: -1 }), '')
})

test('validatePredictRequest accepts a well-formed request', () => {
  const result = validatePredictRequest(predictRequest())
  assert.equal(result.ok, true)
  assert.equal(result.request.anchor.sessionId, 'session-1')
})

test('validatePredictRequest rejects schema, operation and oversized ids', () => {
  assert.equal(validatePredictRequest(predictRequest({ schemaVersion: 2 })).ok, false)
  assert.equal(validatePredictRequest(predictRequest({ operation: 'status' })).ok, false)
  assert.equal(validatePredictRequest(predictRequest({ requestId: '' })).ok, false)
  assert.equal(validatePredictRequest(predictRequest({ trigger: 'timer' })).ok, false)
  assert.equal(validatePredictRequest(predictRequest({ anchor: { ...ANCHOR, turnId: 'x'.repeat(300) } })).ok, false)
})

test('validateResponseForClient checks request/anchor identity', () => {
  const expected = { requestId: 'req-1', anchor: ANCHOR }
  const response = {
    requestId: 'req-1',
    anchor: { ...ANCHOR },
    configRevision: 1,
    result: { kind: 'offer', suggestionId: 's1', text: '继续', expiresAt: 1 },
  }
  assert.equal(validateResponseForClient(response, expected).ok, true)
  const wrongSession = { ...response, anchor: { ...ANCHOR, sessionId: 'other' } }
  assert.equal(validateResponseForClient(wrongSession, expected).ok, false)
  const wrongTurn = { ...response, anchor: { ...ANCHOR, turnId: 'a8' } }
  assert.equal(validateResponseForClient(wrongTurn, expected).ok, false)
  const noText = { ...response, result: { kind: 'offer', suggestionId: 's1', text: '', expiresAt: 1 } }
  assert.equal(validateResponseForClient(noText, expected).ok, false)
  const abstain = { ...response, result: { kind: 'abstain', reason: 'no-basis' } }
  assert.equal(validateResponseForClient(abstain, expected).ok, true)
})

test('countGraphemes never splits emoji or combining marks', () => {
  assert.equal(countGraphemes('abc'), 3)
  assert.equal(countGraphemes('你好'), 2)
  assert.equal(countGraphemes('👩‍💻'), 1)
  assert.equal(countGraphemes('e\u0301'), 1)
})

test('validateSuggestionText accepts one short user line', () => {
  const result = validateSuggestionText('继续第二项')
  assert.equal(result.ok, true)
  assert.equal(result.text, '继续第二项')
  const trimmed = validateSuggestionText('  再详细解释一下原因  ')
  assert.equal(trimmed.text, '再详细解释一下原因')
})

test('validateSuggestionText rejects multiline, control, HTML, protocol and overlong output', () => {
  assert.equal(validateSuggestionText('a\nb').ok, false)
  assert.equal(validateSuggestionText('a\rb').ok, false)
  assert.equal(validateSuggestionText('a\u0000b').ok, false)
  assert.equal(validateSuggestionText('<b>hi</b>').ok, false)
  assert.equal(validateSuggestionText('<|endoftext|>').ok, false)
  assert.equal(validateSuggestionText('').ok, false)
  const long = '好'.repeat(161)
  assert.equal(validateSuggestionText(long).ok, false)
  assert.equal(validateSuggestionText('好'.repeat(160)).ok, true)
})

test('parsePredictionJson accepts exactly one suggestion field', () => {
  assert.deepEqual(parsePredictionJson('{"suggestion":"继续第二项"}'), { ok: true, suggestion: '继续第二项' })
  assert.deepEqual(parsePredictionJson('  {"suggestion":null}  '), { ok: true, suggestion: null })
})

test('parsePredictionJson rejects malformed or repaired output', () => {
  for (const [raw, reason] of [
    ['', 'empty-response'],
    ['not json', 'invalid-json'],
    ['```json\n{"suggestion":"x"}\n```', 'invalid-json'],
    ['[]', 'root-not-object'],
    ['{"suggestion":"x","extra":1}', 'unexpected-fields'],
    ['{"other":"x"}', 'unexpected-fields'],
    ['{"suggestion":42}', 'suggestion-not-string'],
    ['{"suggestion":"a\\nb"}', 'multiline'],
    ['{"suggestion":"<b>x</b>"}', 'html-tag'],
    [`{"suggestion":"${'好'.repeat(200)}"}`, 'too-long'],
    [`{"suggestion":"${'x'.repeat(9000)}"}`, 'response-too-large'],
  ]) {
    const result = parsePredictionJson(raw)
    assert.equal(result.ok, false, raw.slice(0, 40))
    assert.equal(result.reason, reason, raw.slice(0, 40))
  }
})

test('B09a: empty budgetTimeZone resolves to the host system zone', () => {
  const systemZone = resolveSystemTimeZone()
  assert.equal(typeof systemZone, 'string')
  assert.ok(systemZone.length > 0)
  assert.equal(normalizeConfig({}).config.budgetTimeZone, systemZone)
  assert.equal(normalizeConfig({ budgetTimeZone: '' }).config.budgetTimeZone, systemZone)
  assert.equal(normalizeConfig({ budgetTimeZone: 'UTC' }).config.budgetTimeZone, 'UTC')
})

test('prompt builder is frozen and versioned', () => {
  assert.equal(PROMPT_VERSION, 'nmp-p2-v3')
  const system = buildSystemPrompt()
  assert.ok(system.includes('下一条用户消息预测器'))
  assert.ok(system.includes('{"suggestion":null}'))
  assert.ok(system.includes('不得表态倾向'))
  const input = buildPredictionInput([
    { role: 'user', text: '你好' },
    { role: 'assistant', text: '收到' },
  ])
  assert.ok(input.includes('[用户] 你好'))
  assert.ok(input.includes('[助手] 收到'))
  assert.ok(estimateTokens('你好世界') > 0)
})

test('O08: buildPredictionInput appends a turn-facts line when provided', () => {
  const messages = [{ role: 'user', text: 'q' }, { role: 'assistant', text: 'a' }]
  const plain = buildPredictionInput(messages)
  assert.ok(!plain.includes('turn-facts-test'))
  const withFacts = buildPredictionInput(messages, { turnFacts: 'turn-facts-test 12 calls' })
  assert.ok(withFacts.includes('turn-facts-test 12 calls'))
  assert.ok(withFacts.includes('turn-facts-test'))
})

test('manualOnly is a boolean config field that defaults to off', async () => {
  const { DEFAULT_CONFIG, checkConfigField } = await import('../src/shared/config.js')
  assert.equal(DEFAULT_CONFIG.manualOnly, false)
  assert.equal(checkConfigField('manualOnly', true).ok, true)
  assert.equal(checkConfigField('manualOnly', 'yes').ok, false)
})

test('manual suffix asks for a suggestion and lists earlier ones when regenerating', async () => {
  const { buildManualSuffix } = await import('../src/shared/prompt.js')
  const first = buildManualSuffix([])
  assert.ok(first.includes('主动按快捷键'))
  assert.ok(first.includes('不要因为把握不大就返回 null'))
  assert.ok(!first.includes('换一条'))
  const again = buildManualSuffix(['先跑测试', '', '看下 diff'])
  assert.ok(again.includes('主动要求换一条'))
  assert.ok(again.includes('- 先跑测试'))
  assert.ok(again.includes('- 看下 diff'))
  assert.ok(again.includes('不要因为把握不大就返回 null'))
  // The privacy and approval floor stays in both.
  for (const text of [first, again]) assert.ok(text.includes('私人信息') && text.includes('授权审批'))
})

test('showPredictButton is a boolean config field that defaults to on', async () => {
  const { DEFAULT_CONFIG, checkConfigField } = await import('../src/shared/config.js')
  assert.equal(DEFAULT_CONFIG.showPredictButton, true)
  assert.equal(checkConfigField('showPredictButton', false).ok, true)
  assert.equal(checkConfigField('showPredictButton', 0).ok, false)
})

test('predict shortcut: parse, format, match and validate', async () => {
  const { DEFAULT_CONFIG, DEFAULT_PREDICT_SHORTCUT, checkConfigField, eventMatchesShortcut, formatShortcut, parseShortcut, shortcutFromEvent } =
    await import('../src/shared/config.js')
  assert.equal(DEFAULT_CONFIG.predictShortcut, DEFAULT_PREDICT_SHORTCUT)
  assert.deepEqual(parseShortcut('Alt+Backslash'), { ctrl: false, alt: true, shift: false, meta: false, code: 'Backslash' })
  assert.deepEqual(parseShortcut('Ctrl+Shift+KeyK'), { ctrl: true, alt: false, shift: true, meta: false, code: 'KeyK' })
  // Needs Ctrl/Alt/Meta; reserved keys and junk are refused.
  for (const bad of ['KeyK', 'Shift+KeyK', 'Alt+Tab', 'Ctrl+Enter', 'Alt+Escape', 'Alt+ArrowRight', 'Alt+Alt+KeyK', 'Alt+', 'Alt+AltLeft', 'Foo+KeyK', '', 42]) {
    assert.equal(parseShortcut(bad), null, String(bad))
  }
  assert.equal(formatShortcut('Alt+Backslash'), 'Alt+\\')
  assert.equal(formatShortcut('Ctrl+Shift+KeyK'), 'Ctrl+Shift+K')
  assert.equal(formatShortcut('Ctrl+Digit1'), 'Ctrl+1')
  assert.equal(formatShortcut('not a shortcut'), 'Alt+\\')
  const event = { code: 'KeyK', ctrlKey: true, altKey: false, shiftKey: true, metaKey: false }
  assert.equal(shortcutFromEvent(event), 'Ctrl+Shift+KeyK')
  assert.equal(shortcutFromEvent({ code: 'ControlLeft', ctrlKey: true }), '')
  assert.equal(eventMatchesShortcut(event, parseShortcut('Ctrl+Shift+KeyK')), true)
  assert.equal(eventMatchesShortcut(event, parseShortcut('Ctrl+KeyK')), false)
  assert.equal(eventMatchesShortcut({ ...event, altKey: true }, parseShortcut('Ctrl+Shift+KeyK')), false)
  assert.equal(checkConfigField('predictShortcut', 'Ctrl+Shift+KeyK').ok, true)
  assert.equal(checkConfigField('predictShortcut', 'KeyK').ok, false)
})

test('parseCandidatesJson accepts a list, drops bad entries and still reads the single form', async () => {
  const { parseCandidatesJson } = await import('../src/shared/output-validation.js')
  assert.deepEqual(parseCandidatesJson('{"suggestions":["先跑测试","看下 diff","先跑测试","继续"]}', { maxGraphemes: 60, maxCandidates: 3 }), { ok: true, suggestions: ['先跑测试', '看下 diff', '继续'] })
  // One entry is multi-line: it is dropped, the others stay.
  assert.deepEqual(parseCandidatesJson('{"suggestions":["第一行\\n第二行","继续"]}', { maxGraphemes: 60 }), { ok: true, suggestions: ['继续'] })
  assert.deepEqual(parseCandidatesJson('{"suggestions":[]}'), { ok: true, suggestions: [] })
  assert.deepEqual(parseCandidatesJson('{"suggestion":null}'), { ok: true, suggestions: [] })
  assert.deepEqual(parseCandidatesJson('{"suggestion":"继续"}', { maxCandidates: 1 }), { ok: true, suggestions: ['继续'] })
  assert.deepEqual(parseCandidatesJson('{"suggestions":["a","b","c"]}', { maxCandidates: 1 }), { ok: true, suggestions: ['a'] })
  for (const bad of ['{"suggestions":"继续"}', '{"suggestions":[1]}', '{"suggestions":["x"],"note":"y"}', 'not json', '{"suggestions":["第一行\\n第二行"]}']) {
    assert.equal(parseCandidatesJson(bad).ok, false, bad)
  }
})

test('system prompt: the single form is unchanged, the multi form asks for a list', async () => {
  const { buildSystemPrompt } = await import('../src/shared/prompt.js')
  const single = buildSystemPrompt()
  assert.equal(buildSystemPrompt({ candidates: 1 }), single)
  assert.ok(single.includes('{"suggestion":"一条完整的用户消息"}'))
  assert.ok(single.includes('给出多条候选'))
  const multi = buildSystemPrompt({ candidates: 3 })
  assert.ok(multi.includes('{"suggestions":['))
  assert.ok(multi.includes('最多 3 条'))
  assert.ok(!multi.includes('给出多条候选'))
  assert.ok(multi.includes('{"suggestion":null}'))
  // Every other rule is shared.
  assert.ok(multi.includes('需要用户填写私人信息、确认审批或回答未知事实时，返回 null。'))
})

test('multiCandidates and habitSuggestions are boolean config fields that default to on', async () => {
  const { DEFAULT_CONFIG, checkConfigField } = await import('../src/shared/config.js')
  assert.equal(DEFAULT_CONFIG.multiCandidates, true)
  assert.equal(DEFAULT_CONFIG.habitSuggestions, true)
  assert.equal(checkConfigField('multiCandidates', false).ok, true)
  assert.equal(checkConfigField('habitSuggestions', 'no').ok, false)
})

test('advanced options: new fields validate, and every settings range sits inside the stored range', async () => {
  const { DEFAULT_CONFIG, SETTING_LIMITS, checkConfigField } = await import('../src/shared/config.js')
  assert.deepEqual(
    [DEFAULT_CONFIG.manualLimit, DEFAULT_CONFIG.candidateCount, DEFAULT_CONFIG.habitMinCount, DEFAULT_CONFIG.autoWindowMinutes, DEFAULT_CONFIG.includeTurnFacts, DEFAULT_CONFIG.redactSecrets],
    [3, 3, 2, 30, true, true],
  )
  for (const [field, limits] of Object.entries(SETTING_LIMITS)) {
    assert.equal(checkConfigField(field, limits.min).ok, true, `${field} min`)
    assert.equal(checkConfigField(field, limits.max).ok, true, `${field} max`)
    assert.equal(checkConfigField(field, limits.max + 1).ok === false || field === 'triggerDelayMs' && false, true, `${field} above max`)
    assert.ok(DEFAULT_CONFIG[field] >= limits.min && DEFAULT_CONFIG[field] <= limits.max, `${field} default in range`)
    if (typeof limits.warnAbove === 'number') assert.ok(DEFAULT_CONFIG[field] <= limits.warnAbove, `${field} default is not in the warning zone`)
  }
  assert.equal(checkConfigField('redactSecrets', false).ok, true)
  assert.equal(checkConfigField('includeTurnFacts', 'yes').ok, false)
  assert.equal(checkConfigField('manualLimit', 0).ok, false)
  assert.equal(checkConfigField('manualLimit', 6).ok, false)
})
