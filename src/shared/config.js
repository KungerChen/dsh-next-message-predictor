// Shared configuration contract for dsh-next-message-predictor.
//
// This module is imported by the Host half as normal ESM and concatenated into
// the browser bundle by scripts/build-client.mjs (which strips `export `
// keywords). Keep it free of Node, DOM and React APIs and use plain
// declarations only.

import { countGraphemes, normalizePhraseKey, utf8ByteLength, validateSuggestionText } from './output-validation.js'

/** Locale namespace and settings-section identity. */
export const NS = 'next-message-predictor'

/** The single plugin route; the Host enforces protocol shape and auth. */
export const ROUTE = '/api/next-message-predictor/rpc'

/** Wire protocol version carried by every request. */
export const SCHEMA_VERSION = 1

/** Loader entry id this plugin expects; the settings namespace form uses it. */
export const ENTRY_ID = 'next-message-predictor'

/**
 * Id of this plugin's global panel: the `main` keyed-slot key and the
 * `sidebar.panellist` entry id (DSH pairs the two by this id).
 */
export const PANEL_ID = 'next-message-predictor'

/**
 * Interface languages this plugin ships (`src/client/locales/<id>.js`), in the
 * order the Settings page lists them.
 */
export const LANGUAGE_IDS = Object.freeze(['zh', 'en', 'ja', 'ko', 'es', 'fr', 'de', 'ru', 'pt'])

/** `language` value that means "use the language DSH is set to". */
export const LANGUAGE_AUTO = 'auto'

/** Upper bound for a single user-visible suggestion, in grapheme clusters (O02: 中文 ≤40 字 / 英文 ≤12 词). */
export const DEFAULT_MAX_SUGGESTION_GRAPHEMES = 60

/**
 * How long a produced suggestion may be offered, in milliseconds（B06）.
 * 展示有效期到“下一回合开始”为止，另设 2 小时上限；Host 缓存与客户端恢复都用它。
 */
export const OFFER_TTL_MS = 2 * 60 * 60 * 1000

/**
 * Default effective configuration.
 *
 * Only a subset is exercised by the P0/P1 build. `fakeSuggestion` is the fixed
 * suggestion the P1 no-model path returns; P2 replaces the provider while the
 * rest of the contract stays the same. Default `enabled: false` is deliberate:
 * a fresh install never spends tokens or paints anything until the user turns
 * the feature on once.
 */
export const DEFAULT_CONFIG = {
  enabled: false,
  // P2 model route. O04: 默认固定快模型并关闭推理；固定路由不可用时回退到会话模型。
  // `modelMode: 'fixed'` + `provider: 'fixed-test'` 仍是显式的离线测试路径。
  modelMode: 'fixed',
  provider: 'deepseek-official',
  model: 'deepseek-flash',
  /** Reasoning effort id; O04 默认关闭推理，空 = 模型 advertised 的低成本档位。 */
  reasoningEffort: 'off',
  // Trigger / transport limits.
  /**
   * 手动模式：为 true 时回答结束后不再自动预测，只有用户在空输入框里按
   * Alt+\ 才预测一次。为 false 时自动预测照常，快捷键也仍然可用。
   */
  manualOnly: false,
  /** 输入框为空时，在右侧显示一个“预测”按钮（等同于按 Alt+\）。 */
  showPredictButton: true,
  /** 一次模型调用给出最多 3 条候选，“换一条”先在本地切换，切完才再调用模型。 */
  multiCandidates: true,
  /**
   * 常说的话：用户在本次对话里说过两次以上的短句，排在模型建议之后，
   * 用“换一条”切换可达。不调用模型、不占预算，内容不离开本机，也不发给模型。
   * 第一条建议总是来自模型（自动预测每次都调用模型）。
   */
  habitSuggestions: true,
  /**
   * 固定短语：用户在设置页维护的列表（最多 PINNED_PHRASES_MAX 条），和常说的话一样
   * 排在模型建议之后。只在本机使用，从不发给模型。模式切换不改它。
   */
  pinnedPhrases: Object.freeze([]),
  /** “立刻预测 / 换一条”的快捷键，写法见 parseShortcut。 */
  predictShortcut: 'Alt+Backslash',
  /** 每次回答最多调用模型做几次手动预测（第一次 + “换一条”）。 */
  manualLimit: 3,
  /** 多条候选开启时，一次手动预测最多返回几条。 */
  candidateCount: 3,
  /** 常用短句：同一会话内至少出现几次才作为建议。 */
  habitMinCount: 2,
  /** 回答结束后多少分钟内允许自动预测（含窗口失焦后的补发）。手动预测不受限。 */
  autoWindowMinutes: 30,
  /** 随对话片段附带一行上一回合的统计（工具调用、文件修改、测试命令的次数，不含正文）。 */
  includeTurnFacts: true,
  /**
   * 发送前遮蔽疑似密钥、令牌和邮箱。关闭后对话片段原样发送给预测模型，
   * 设置页会给出风险提示并要求二次确认。
   */
  redactSecrets: true,
  triggerDelayMs: 250,
  timeoutMs: 8000,
  requestBodyLimitBytes: 8192,
  // Context limits (P2 extraction; kept here as the single source of truth).
  contextMessages: 12,
  maxContextCodePoints: 6000,
  targetInputTokens: 2000,
  // O02/O04: 建议更短，输出预算降到 96 token 足够。
  maxOutputTokens: 96,
  // Result limits.
  maxSuggestionGraphemes: DEFAULT_MAX_SUGGESTION_GRAPHEMES,
  // Budget limits.
  dailyRequestLimit: 200,
  dailyTokenBudget: 500000,
  /**
   * 预算日历日时区。空字符串表示“跟随系统时区”（B09a）：由 normalizeConfig
   * 在加载时解析为具体 IANA 时区，避免新机器上默认写死 America/Chicago。
   */
  budgetTimeZone: '',
  // Presentation.
  announceSuggestions: true,
  /**
   * 在 DSH 首页左侧栏的面板入口列表里显示本插件的入口（点击打开设置与统计面板）。
   * 默认关闭：左侧栏是用户自己的空间，由用户在设置页一键添加或移除。
   */
  sidebarEntry: false,
  /**
   * Language of this plugin's own texts: `auto` follows DSH, otherwise one of
   * LANGUAGE_IDS. It never changes the language of the suggestions.
   */
  language: LANGUAGE_AUTO,
  // P1 fixed-suggestion provider (no model call, no credentials).
  fakeSuggestion: '',
  fakeSuggestionDelayMs: 0,
}

/** Numeric field policy: [min, max, integer?]. */
const NUMBER_FIELDS = {
  triggerDelayMs: [0, 30000, true],
  timeoutMs: [1000, 60000, true],
  requestBodyLimitBytes: [1024, 1024 * 1024, true],
  contextMessages: [1, 40, true],
  maxContextCodePoints: [200, 60000, true],
  targetInputTokens: [100, 16000, true],
  maxOutputTokens: [1, 2048, true],
  maxSuggestionGraphemes: [1, 400, true],
  dailyRequestLimit: [1, 5000, true],
  dailyTokenBudget: [1000, 20000000, true],
  fakeSuggestionDelayMs: [0, 30000, true],
  manualLimit: [1, 5, true],
  candidateCount: [2, 5, true],
  habitMinCount: [2, 5, true],
  autoWindowMinutes: [5, 240, true],
}

/**
 * 设置页里数值项的范围、步长和风险阈值（范围不超过上面的存储校验范围）。
 * warnAbove：超过该值时设置页显示风险提示（费用或发送内容增加）。
 */
export const SETTING_LIMITS = {
  triggerDelayMs: { min: 0, max: 30000, step: 50 },
  autoWindowMinutes: { min: 5, max: 240, step: 5 },
  manualLimit: { min: 1, max: 5, step: 1, warnAbove: 3 },
  candidateCount: { min: 2, max: 5, step: 1 },
  habitMinCount: { min: 2, max: 5, step: 1 },
  contextMessages: { min: 2, max: 40, step: 1, warnAbove: 20 },
  targetInputTokens: { min: 1000, max: 16000, step: 100, warnAbove: 4000 },
  maxSuggestionGraphemes: { min: 20, max: 400, step: 10 },
  maxOutputTokens: { min: 32, max: 2048, step: 16, warnAbove: 512 },
  timeoutMs: { min: 2000, max: 60000, step: 500 },
  dailyRequestLimit: { min: 1, max: 5000, step: 10, warnAbove: 500 },
  dailyTokenBudget: { min: 10000, max: 20000000, step: 10000, warnAbove: 1000000 },
}

const STRING_FIELDS = {
  modelMode: 20,
  provider: 120,
  model: 120,
  reasoningEffort: 60,
  budgetTimeZone: 80,
  fakeSuggestion: 2000,
  predictShortcut: 40,
  language: 10,
}

/** 默认的“立刻预测 / 换一条”快捷键。 */
export const DEFAULT_PREDICT_SHORTCUT = 'Alt+Backslash'

const SHORTCUT_MODIFIERS = ['Ctrl', 'Alt', 'Shift', 'Meta']
/** 这些键已经有固定用途（采纳、隐藏、发送、移动光标），不能当预测快捷键的主键。 */
const SHORTCUT_RESERVED_CODES = ['Tab', 'Escape', 'Enter', 'NumpadEnter', 'Backspace', 'Delete', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']
/** 与 Ctrl / Cmd 组合时属于编辑器或窗口的键：全选、复制、粘贴、剪切、撤销、重做、查找、保存、打印、刷新、关闭、新建、退出、地址栏。 */
const SHORTCUT_EDITING_CODES = ['KeyA', 'KeyC', 'KeyV', 'KeyX', 'KeyZ', 'KeyY', 'KeyF', 'KeyS', 'KeyP', 'KeyR', 'KeyW', 'KeyT', 'KeyN', 'KeyQ', 'KeyL']
const SHORTCUT_KEY_LABELS = {
  Backslash: '\\', Slash: '/', Period: '.', Comma: ',', Semicolon: ';', Quote: "'", BracketLeft: '[', BracketRight: ']',
  Minus: '-', Equal: '=', Backquote: '`', Space: 'Space', IntlBackslash: '\\',
}

/**
 * 解析快捷键字符串（规范写法 `Ctrl+Alt+Shift+Meta+<KeyboardEvent.code>`，例如
 * `Alt+Backslash`、`Ctrl+Shift+KeyK`）。用 code 而不是 key，换键盘布局或开着
 * 输入法时同一个物理键仍然有效。
 * 规则：必须带 Ctrl、Alt 或 Meta 之一（否则会和正常打字冲突）；主键不能是保留键；
 * Ctrl / Cmd 加编辑键（复制、粘贴、撤销等，见 SHORTCUT_EDITING_CODES）不能用。
 * @returns {{ctrl:boolean, alt:boolean, shift:boolean, meta:boolean, code:string} | null}
 */
export function parseShortcut(value) {
  if (typeof value !== 'string' || value === '' || value.length > 40) return null
  const parts = value.split('+')
  const code = parts.pop()
  if (typeof code !== 'string' || !/^[A-Za-z][A-Za-z0-9]*$/u.test(code)) return null
  if (SHORTCUT_RESERVED_CODES.includes(code) || /^(Control|Alt|Shift|Meta|OS)(Left|Right)?$/u.test(code)) return null
  const mods = { ctrl: false, alt: false, shift: false, meta: false }
  for (const part of parts) {
    if (!SHORTCUT_MODIFIERS.includes(part)) return null
    const name = part.toLowerCase()
    if (mods[name]) return null
    mods[name] = true
  }
  if (!mods.ctrl && !mods.alt && !mods.meta) return null
  // Ctrl/Cmd + an editing or window key belongs to the editor and the app. The
  // composer handler swallows the predict shortcut before anything else sees
  // it, so recording Ctrl+V here would silently break paste.
  if ((mods.ctrl || mods.meta) && !mods.alt && SHORTCUT_EDITING_CODES.includes(code)) return null
  return { ...mods, code }
}

/** 把一次按键事件写成规范的快捷键字符串；只按了修饰键时返回空串。 */
export function shortcutFromEvent(event) {
  if (event === null || typeof event !== 'object' || typeof event.code !== 'string' || event.code === '') return ''
  if (/^(Control|Alt|Shift|Meta|OS|AltGraph)(Left|Right)?$/u.test(event.code)) return ''
  // AltGr types a character; it is never recorded as Ctrl+Alt (see isAltGraphEvent).
  if (isAltGraphEvent(event)) return ''
  const parts = []
  if (event.ctrlKey) parts.push('Ctrl')
  if (event.altKey) parts.push('Alt')
  if (event.shiftKey) parts.push('Shift')
  if (event.metaKey) parts.push('Meta')
  parts.push(event.code)
  return parts.join('+')
}

/** 按键事件是否正好是这个快捷键（修饰键必须完全一致）。 */
export function eventMatchesShortcut(event, shortcut) {
  if (shortcut === null || shortcut === undefined || event === null || typeof event !== 'object') return false
  // A key pressed with AltGr is typing, whatever modifiers Windows reports with it.
  if (isAltGraphEvent(event)) return false
  return event.code === shortcut.code && Boolean(event.ctrlKey) === shortcut.ctrl && Boolean(event.altKey) === shortcut.alt &&
    Boolean(event.shiftKey) === shortcut.shift && Boolean(event.metaKey) === shortcut.meta
}

/** 给人看的写法：`Alt+Backslash` -> `Alt+\`，`Ctrl+Shift+KeyK` -> `Ctrl+Shift+K`。无效时显示默认键。 */
export function formatShortcut(value) {
  const parsed = parseShortcut(value) ?? parseShortcut(DEFAULT_PREDICT_SHORTCUT)
  const parts = []
  if (parsed.ctrl) parts.push('Ctrl')
  if (parsed.alt) parts.push('Alt')
  if (parsed.shift) parts.push('Shift')
  if (parsed.meta) parts.push('Win')
  const code = parsed.code
  const label = SHORTCUT_KEY_LABELS[code] ?? (/^Key[A-Z]$/u.test(code) ? code.slice(3) : /^Digit[0-9]$/u.test(code) ? code.slice(5) : /^Numpad/u.test(code) ? `Num${code.slice(6)}` : code)
  parts.push(label)
  return parts.join('+')
}

/**
 * AltGr on many keyboard layouts (German, French, Polish …) types characters
 * such as @, \ or €. Windows reports it as Ctrl+Alt, so without this check a
 * recorded Ctrl+Alt+<key> shortcut would swallow the character typed with
 * AltGr+<key>. `getModifierState` may be missing (synthetic events in tests).
 */
export function isAltGraphEvent(event) {
  if (event === null || typeof event !== 'object' || typeof event.getModifierState !== 'function') return false
  try {
    return event.getModifierState('AltGraph') === true
  } catch {
    return false
  }
}

/** 至多几条固定短语。 */
export const PINNED_PHRASES_MAX = 10
/** 每条固定短语的长度上限（字）。 */
export const PINNED_PHRASE_MAX_GRAPHEMES = 40
/**
 * 每条固定短语的字节上限（UTF-8）。40 个汉字是 120 字节；组合字符可以让一个“字”
 * 占很多字节，这个上限让整张列表的写入请求有确定的上界（见 CONFIG_SET_MIN_BODY_BYTES）。
 */
export const PINNED_PHRASE_MAX_BYTES = 160
/** 候选环里本地短语（常说的话 + 固定短语）最多几条，跟在模型候选之后。 */
export const LOCAL_PHRASES_MAX = 5
/**
 * `config.set` 请求体至少允许的大小。`requestBodyLimitBytes` 可以低到 1024，
 * 而一整张固定短语列表（10 条 × 160 字节，加上 JSON 转义和信封）最多约 2.1 KB；
 * 只对 config.set 放宽到这个值，设置页才不会因为请求体上限而保存失败。
 * 其他操作仍然按 requestBodyLimitBytes。
 */
export const CONFIG_SET_MIN_BODY_BYTES = 4096

/**
 * Why a phrase cannot be pinned, or '' when it can.
 * @param {unknown} text - the phrase exactly as it would be stored.
 * @param {string[]} [others] - phrases already in the list (duplicates are refused).
 * @returns {'' | 'empty' | 'not-trimmed' | 'too-long' | 'too-many-bytes' | 'command' | 'duplicate' | 'invalid'}
 */
export function pinnedPhraseProblem(text, others) {
  if (typeof text !== 'string') return 'invalid'
  if (text.trim() === '') return 'empty'
  if (text !== text.trim()) return 'not-trimmed'
  // Slash commands and @-mentions mean something else in the composer.
  if (text.startsWith('/') || text.startsWith('@')) return 'command'
  // A lone surrogate is not text; JSON would also inflate it to six bytes.
  if (/[\uD800-\uDFFF]/u.test(text)) return 'invalid'
  if (countGraphemes(text) > PINNED_PHRASE_MAX_GRAPHEMES) return 'too-long'
  if (utf8ByteLength(text) > PINNED_PHRASE_MAX_BYTES) return 'too-many-bytes'
  const validated = validateSuggestionText(text, { maxGraphemes: PINNED_PHRASE_MAX_GRAPHEMES })
  if (!validated.ok) return validated.reason === 'too-long' ? 'too-long' : 'invalid'
  const key = normalizePhraseKey(text)
  if (Array.isArray(others) && others.some((other) => typeof other === 'string' && normalizePhraseKey(other) === key)) return 'duplicate'
  return ''
}

/** List fields: each validates the whole array and returns a fresh copy. */
const LIST_FIELDS = {
  pinnedPhrases(key, value) {
    if (!Array.isArray(value)) return { ok: false, error: `${key} must be an array of strings` }
    if (value.length > PINNED_PHRASES_MAX) return { ok: false, error: `${key} must have at most ${PINNED_PHRASES_MAX} entries` }
    const accepted = []
    for (let index = 0; index < value.length; index += 1) {
      const problem = pinnedPhraseProblem(value[index], accepted)
      if (problem !== '') return { ok: false, error: `${key}[${index}] is not usable (${problem})` }
      accepted.push(value[index])
    }
    return { ok: true, value: accepted }
  },
}

const BOOLEAN_FIELDS = ['enabled', 'announceSuggestions', 'manualOnly', 'showPredictButton', 'multiCandidates', 'habitSuggestions', 'includeTurnFacts', 'redactSecrets', 'sidebarEntry']

/** Own-property test that also works for objects without a prototype. */
function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key)
}

/** Whether a value is a non-array plain object. */
export function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Validate one IANA time-zone id without throwing. */
export function isValidTimeZone(value) {
  if (typeof value !== 'string' || value.trim() === '') return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format(new Date(0))
    return true
  } catch {
    return false
  }
}

/** Resolve the host system IANA time zone (fallback UTC). */
export function resolveSystemTimeZone() {
  try {
    const zone = new Intl.DateTimeFormat().resolvedOptions().timeZone
    if (typeof zone === 'string' && zone !== '' && isValidTimeZone(zone)) return zone
  } catch {
    /* fall through */
  }
  return 'UTC'
}

/**
 * Coerce and validate a candidate config value.
 * @returns {{ok: true, value: unknown} | {ok: false, error: string}}
 */
export function checkConfigField(key, value) {
  // Own properties only: `toString`, `constructor` or `__proto__` sent as a
  // field name must be an unknown field, not a lookup on Object.prototype.
  if (hasOwn(NUMBER_FIELDS, key)) {
    const [min, max, integer] = NUMBER_FIELDS[key]
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return { ok: false, error: `${key} must be a finite number` }
    }
    if (integer && !Number.isInteger(value)) return { ok: false, error: `${key} must be an integer` }
    if (value < min || value > max) return { ok: false, error: `${key} must be within [${min}, ${max}]` }
    return { ok: true, value }
  }
  if (hasOwn(STRING_FIELDS, key)) {
    if (typeof value !== 'string') return { ok: false, error: `${key} must be a string` }
    if (value.length > STRING_FIELDS[key]) return { ok: false, error: `${key} is too long` }
    if (key === 'budgetTimeZone' && value !== '' && !isValidTimeZone(value)) {
      return { ok: false, error: `${key} must be an IANA time zone` }
    }
    if (key === 'modelMode' && value !== 'session' && value !== 'fixed') {
      return { ok: false, error: 'modelMode must be "session" or "fixed"' }
    }
    if (key === 'language' && value !== LANGUAGE_AUTO && !LANGUAGE_IDS.includes(value)) {
      return { ok: false, error: `language must be "${LANGUAGE_AUTO}" or one of ${LANGUAGE_IDS.join(', ')}` }
    }
    if (key === 'predictShortcut' && parseShortcut(value) === null) {
      return { ok: false, error: 'predictShortcut must be Ctrl/Alt/Meta plus one key, for example "Alt+Backslash"' }
    }
    return { ok: true, value }
  }
  if (BOOLEAN_FIELDS.includes(key)) {
    if (typeof value !== 'boolean') return { ok: false, error: `${key} must be a boolean` }
    return { ok: true, value }
  }
  if (hasOwn(LIST_FIELDS, key)) return LIST_FIELDS[key](key, value)
  return { ok: false, error: `unknown config field "${key}"` }
}

/**
 * Build the effective config from a raw loader-row value.
 *
 * Invalid values never get silently replaced with a different *valid* value
 * that the user did not set: the default applies for that field and the
 * problem is reported through `errors` (shown in diagnostics and Settings).
 * @param raw - loader row config, possibly empty or malformed.
 */
export function normalizeConfig(raw) {
  const input = isPlainObject(raw) ? raw : {}
  const config = { ...DEFAULT_CONFIG }
  const errors = []
  if (!isPlainObject(raw)) {
    if (raw !== undefined && raw !== null) errors.push('config must be a plain object')
    return { config: withResolvedTimeZone(config), errors }
  }
  for (const key of Object.keys(DEFAULT_CONFIG)) {
    if (!hasOwn(input, key)) continue
    const result = checkConfigField(key, input[key])
    if (result.ok) config[key] = result.value
    else errors.push(result.error)
  }
  for (const key of Object.keys(input)) {
    if (!hasOwn(DEFAULT_CONFIG, key)) errors.push(`unknown config field "${key}"`)
  }
  return { config: withResolvedTimeZone(config), errors }
}

/** B09a：空 budgetTimeZone 跟随系统时区，其余值保持用户/配置显式选择。 */
function withResolvedTimeZone(config) {
  if (config.budgetTimeZone === '') config.budgetTimeZone = resolveSystemTimeZone()
  return config
}

/**
 * Validate a partial config patch from the browser.
 * @returns {{ok: true, patch: object} | {ok: false, error: string}}
 */
export function sanitizeConfigPatch(raw) {
  if (!isPlainObject(raw)) return { ok: false, error: 'config patch must be a plain object' }
  const keys = Object.keys(raw)
  if (keys.length === 0) return { ok: false, error: 'config patch must not be empty' }
  const patch = {}
  for (const key of keys) {
    const result = checkConfigField(key, raw[key])
    if (!result.ok) return { ok: false, error: result.error }
    patch[key] = result.value
  }
  return { ok: true, patch }
}

/**
 * Stable identity for one effective config, used for revision/CAS checks.
 * 32-bit FNV-1a over the sorted normalized JSON; collisions are not treated as
 * security boundaries, only as a change detector. List fields (`pinnedPhrases`)
 * take part in order: reordering the list is a change of configuration.
 */
export function configRevision(config) {
  const normalized = {}
  for (const key of Object.keys(DEFAULT_CONFIG).sort()) normalized[key] = config[key]
  const text = JSON.stringify(normalized)
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash >>> 0
}
