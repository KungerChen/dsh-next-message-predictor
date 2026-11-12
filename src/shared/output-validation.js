// Shared output acceptance for a model-produced or fixed suggestion.
//
// Both the P1 fixed provider and the future P2 model provider must pass their
// candidate through this module before the Host can return an offer. The rules
// follow the design's acceptance list: a complete single-line user-visible
// message or an abstain, never a repaired or truncated fragment.
// This file is concatenated into the browser bundle: plain declarations only.

/** Count user-visible grapheme clusters (never split emoji or CJK extensions). */
export function countGraphemes(text) {
  if (typeof text !== 'string' || text === '') return 0
  if (typeof Intl === 'object' && typeof Intl.Segmenter === 'function') {
    const segmenter = new Intl.Segmenter('zh', { granularity: 'grapheme' })
    let count = 0
    for (const _ of segmenter.segment(text)) count += 1
    return count
  }
  return Array.from(text).length
}

const CONTROL_RE = /[\u0000-\u0009\u000B\u000C\u000E-\u001F\u007F-\u009F]/u
const PROTOCOL_MARKER_RE = /<\|[^>]*\|>/u
const HTML_TAG_RE = /<\/?[A-Za-z][^>]*>/u

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * 严格解析模型输出（方案 §七 结果验收 1-5）：
 * - 只有完整正常结束的响应才进入解析（调用方保证 finish.kind === 'stop'）；
 * - 根对象只允许 `suggestion`，类型为 string 或 null；
 * - JSON 解析失败、字段多余、类型错误、多行、控制字符、HTML/协议标记、
 *   超过 grapheme 上限全部弃权；不做“取第一行/剥引号/截断”式修复。
 * @returns {{ok:true, suggestion: string | null} | {ok:false, reason: string}}
 */
export function parsePredictionJson(raw, options) {
  const maxGraphemes =
    options !== undefined && typeof options.maxGraphemes === 'number' ? options.maxGraphemes : 160
  if (typeof raw !== 'string') return { ok: false, reason: 'response-not-string' }
  const text = raw.trim()
  if (text === '') return { ok: false, reason: 'empty-response' }
  if (text.length > 8192) return { ok: false, reason: 'response-too-large' }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return { ok: false, reason: 'invalid-json' }
  }
  if (!isRecord(parsed)) return { ok: false, reason: 'root-not-object' }
  const keys = Object.keys(parsed)
  if (keys.length !== 1 || keys[0] !== 'suggestion') return { ok: false, reason: 'unexpected-fields' }
  if (parsed.suggestion === null) return { ok: true, suggestion: null }
  if (typeof parsed.suggestion !== 'string') return { ok: false, reason: 'suggestion-not-string' }
  const validated = validateSuggestionText(parsed.suggestion, { maxGraphemes })
  if (!validated.ok) return { ok: false, reason: validated.reason }
  return { ok: true, suggestion: validated.text }
}

/**
 * 多条候选的严格解析。接受两种根对象：
 *   {"suggestions":["…","…"]}（数组，只含字符串）或 {"suggestion": string | null}。
 * 每一条都按单条的规则校验；不合格的那一条被丢弃（不修复、不截断），重复的去掉。
 * 全部不合格视为解析失败；空数组或 null 视为弃权。
 * @returns {{ok:true, suggestions: string[]} | {ok:false, reason: string}}
 */
export function parseCandidatesJson(raw, options) {
  const maxGraphemes =
    options !== undefined && typeof options.maxGraphemes === 'number' ? options.maxGraphemes : 160
  const maxCandidates =
    options !== undefined && Number.isInteger(options.maxCandidates) ? Math.max(1, options.maxCandidates) : 3
  if (typeof raw !== 'string') return { ok: false, reason: 'response-not-string' }
  const text = raw.trim()
  if (text === '') return { ok: false, reason: 'empty-response' }
  if (text.length > 8192) return { ok: false, reason: 'response-too-large' }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return { ok: false, reason: 'invalid-json' }
  }
  if (!isRecord(parsed)) return { ok: false, reason: 'root-not-object' }
  const keys = Object.keys(parsed)
  if (keys.length !== 1 || (keys[0] !== 'suggestion' && keys[0] !== 'suggestions')) return { ok: false, reason: 'unexpected-fields' }
  if (keys[0] === 'suggestion') {
    const single = parsePredictionJson(text, { maxGraphemes })
    if (!single.ok) return single
    return { ok: true, suggestions: single.suggestion === null ? [] : [single.suggestion] }
  }
  const list = parsed.suggestions
  if (list === null) return { ok: true, suggestions: [] }
  if (!Array.isArray(list)) return { ok: false, reason: 'suggestions-not-array' }
  if (list.length > 10) return { ok: false, reason: 'too-many-suggestions' }
  if (list.some((entry) => typeof entry !== 'string')) return { ok: false, reason: 'suggestion-not-string' }
  if (list.length === 0) return { ok: true, suggestions: [] }
  const accepted = []
  let firstReason = ''
  for (const entry of list) {
    const validated = validateSuggestionText(entry, { maxGraphemes })
    if (!validated.ok) {
      if (firstReason === '') firstReason = validated.reason
      continue
    }
    if (!accepted.includes(validated.text)) accepted.push(validated.text)
    if (accepted.length >= maxCandidates) break
  }
  if (accepted.length === 0) return { ok: false, reason: firstReason || 'empty' }
  return { ok: true, suggestions: accepted }
}

/**
 * Comparison key for the user's own phrases (session habit phrases and pinned
 * phrases): surrounding whitespace, runs of spaces, trailing punctuation and
 * letter case do not make two phrases different. The candidate ring is
 * de-duplicated with it, and the habit detection counts repeats with it.
 */
export function normalizePhraseKey(text) {
  if (typeof text !== 'string') return ''
  return text.trim().replace(/[ \t　]+/gu, ' ').replace(/[。．.！!？?～~，,、；;：:\s]+$/u, '').toLowerCase()
}

/** UTF-8 size of a string in bytes (Node and browsers alike). */
export function utf8ByteLength(text) {
  if (typeof text !== 'string' || text === '') return 0
  if (typeof TextEncoder === 'function') return new TextEncoder().encode(text).length
  let bytes = 0
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4
  }
  return bytes
}

export function validateSuggestionText(raw, options) {
  const maxGraphemes =
    options !== undefined && typeof options.maxGraphemes === 'number' ? options.maxGraphemes : 160
  if (typeof raw !== 'string') return { ok: false, reason: 'non-string' }
  const text = raw.trim()
  if (text === '') return { ok: false, reason: 'empty' }
  // U+2028 / U+2029 / U+0085 也是换行：只查 \r\n 会放过“看起来一行、实际多行”的输出。
  if (/[\r\n\u0085\u2028\u2029]/u.test(text)) return { ok: false, reason: 'multiline' }
  if (CONTROL_RE.test(text)) return { ok: false, reason: 'control-character' }
  if (PROTOCOL_MARKER_RE.test(text)) return { ok: false, reason: 'protocol-marker' }
  if (HTML_TAG_RE.test(text)) return { ok: false, reason: 'html-tag' }
  // A long payload is rejected, never truncated: truncation can cut a negation,
  // an object, or a qualifier out of the candidate.
  if (countGraphemes(text) > maxGraphemes) return { ok: false, reason: 'too-long' }
  if (typeof Buffer === 'function' && typeof Buffer.byteLength === 'function' && Buffer.byteLength(text, 'utf8') > 4096) {
    return { ok: false, reason: 'too-many-bytes' }
  }
  return { ok: true, text }
}
