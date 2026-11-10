// 持久化结果记录（O01）。
//
// 每次预测请求写一行 `<DSH_HOME>/next-message-predictor/events.jsonl`，不含正文：
// 时间、会话/回合/建议的哈希、触发方式、结果与原因、延迟、token、建议长度，
// 以及客户端回报的展示与最终去向；用户发出下一条消息时只把匹配分数写盘。
//
// 约束（PLAN O01）：
// - 文件 5 MB 轮换为 events.<timestamp>.jsonl，保留 14 天；
// - 不写建议正文、对话内容、会话 id 原文（只用稳定哈希）；
// - 写入失败只记日志，绝不影响预测本身；
// - 汇总提供 7 天展示率、采纳率、采纳后未修改率、弃权原因、延迟与日 token。
//
// 建议正文只在内存里短暂保留（最多 2 小时、最多 200 条），用于计算用户下一条
// 消息与建议的匹配度；写出后即丢弃，不落盘。

import { appendFile, mkdir, readFile, readdir, rename, stat, unlink } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'

const HASH_SALT = 'dsh-next-message-predictor/results/v1'
const MAX_BYTES = 5 * 1024 * 1024
const KEEP_DAYS = 14
const PENDING_TTL_MS = 2 * 60 * 60 * 1000
const MAX_PENDING = 200
const MAX_SUMMARY_LINES = 50000

/** 稳定、不可逆的短哈希（只用于关联，不是安全边界）。 */
export function hashId(value) {
  try {
    return createHash('sha256').update(HASH_SALT).update('\u0000').update(String(value)).digest('hex').slice(0, 16)
  } catch {
    return 'hash-error'
  }
}

/** 归一化文本后计算完全匹配与公共前缀字符数（grapheme 感知）。 */
export function matchScore(suggestion, message) {
  const normalize = (text) => Array.from(String(text ?? '').replace(/\s+/gu, ' ').trim())
  const a = normalize(suggestion)
  const b = normalize(message)
  if (a.length === 0 || b.length === 0) return { exact: false, prefixChars: 0, editRatio: 1, suggestionGraphemes: a.length, userGraphemes: b.length }
  const shortest = Math.min(a.length, b.length)
  let prefixChars = 0
  while (prefixChars < shortest && a[prefixChars] === b[prefixChars]) prefixChars += 1
  const maxLength = Math.max(a.length, b.length)
  // 只在前缀相同或长度接近时计算编辑距离，避免长文本 O(n²) 开销。
  const editRatio = 1 - levenshteinBounded(a, b, Math.min(maxLength, 400)) / maxLength
  return {
    exact: a.length === b.length && prefixChars === a.length,
    prefixChars,
    editRatio: Math.max(0, Math.min(1, editRatio)),
    suggestionGraphemes: a.length,
    userGraphemes: b.length,
  }
}

function levenshteinBounded(a, b, limit) {
  if (Math.abs(a.length - b.length) > limit) return limit
  const previous = new Uint16Array(b.length + 1)
  const current = new Uint16Array(b.length + 1)
  for (let j = 0; j <= b.length; j += 1) previous[j] = j
  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i
    let rowMin = current[0]
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost)
      if (current[j] < rowMin) rowMin = current[j]
    }
    if (rowMin > limit) return limit + 1
    previous.set(current)
  }
  return Math.min(limit, previous[b.length])
}

function dayKey(nowMs, timeZone) {
  const date = new Date(nowMs)
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: typeof timeZone === 'string' && timeZone !== '' ? timeZone : 'UTC',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(date)
  } catch {
    return date.toISOString().slice(0, 10)
  }
}

/**
 * @param {object} options
 * @param {string} options.homeDir
 * @param {() => number} [options.now]
 * @param {() => string} [options.getTimeZone]
 * @param {(line: string) => void} [options.logger]
 * @param {number} [options.maxBytes] - 测试可覆盖轮换阈值。
 */
export function createResultsLog(options) {
  const homeDir = options.homeDir
  const now = typeof options.now === 'function' ? options.now : Date.now
  const getTimeZone = typeof options.getTimeZone === 'function' ? options.getTimeZone : () => 'UTC'
  const logger = typeof options.logger === 'function' ? options.logger : () => {}
  const maxBytes = Math.max(1024, Number(options.maxBytes) || MAX_BYTES)
  const dir = join(homeDir, 'next-message-predictor')
  const filePath = join(dir, 'events.jsonl')
  /** @type {Map<string, object>} suggestionId -> in-memory pending offer (正文只在内存) */
  const pending = new Map()
  let bytes = -1
  let queue = Promise.resolve()
  let lastCleanup = 0
  let initialized = false

  async function initialize() {
    if (initialized) return
    try {
      const info = await stat(filePath)
      bytes = info.size
    } catch {
      bytes = 0
    }
    initialized = true
  }

  function prunePending() {
    const cutoff = now() - PENDING_TTL_MS
    for (const [id, entry] of pending) {
      if (entry.at < cutoff) pending.delete(id)
    }
    while (pending.size > MAX_PENDING) {
      const oldest = pending.keys().next().value
      if (oldest === undefined) break
      pending.delete(oldest)
    }
  }

  async function cleanupOldFiles() {
    if (now() - lastCleanup < 60 * 60 * 1000) return
    lastCleanup = now()
    try {
      const names = await readdir(dir)
      const cutoff = now() - KEEP_DAYS * 24 * 60 * 60 * 1000
      for (const name of names) {
        if (!/^events\..+\.jsonl$/u.test(name)) continue
        const path = join(dir, name)
        try {
          const info = await stat(path)
          if (info.mtimeMs < cutoff) await unlink(path)
        } catch {
          /* 单个文件失败忽略 */
        }
      }
    } catch {
      /* 清理失败不影响写入 */
    }
  }

  /** 轮换到 events.<ISO>.jsonl（文件名时间戳只含安全字符）。 */
  async function rotateIfNeeded(lineBytes) {
    if (bytes < 0) await initialize()
    if (bytes === 0) return
    if (bytes + lineBytes <= maxBytes) return
    const stamp = new Date(now()).toISOString().replace(/[:.]/g, '-')
    try {
      await rename(filePath, join(dir, `events.${stamp}.jsonl`))
    } catch (error) {
      logger(`[next-message-predictor] results rotate failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    bytes = 0
  }

  /** 追加一行；串行化、失败只记日志。 */
  function append(record) {
    queue = queue
      .then(async () => {
        await mkdir(dir, { recursive: true })
        const line = `${JSON.stringify({ t: now(), ...record })}\n`
        const lineBytes = Buffer.byteLength(line)
        await rotateIfNeeded(lineBytes)
        await appendFile(filePath, line, 'utf8')
        bytes = Math.max(0, bytes) + lineBytes
        void cleanupOldFiles()
      })
      .catch((error) => {
        logger(`[next-message-predictor] results append failed: ${error instanceof Error ? error.message : String(error)}`)
      })
    return queue
  }

  /**
   * 记录一次请求的最终结果（由 Host 在返回响应前调用）。
   * @param {object} input
   * @param {string} input.requestId
   * @param {string} input.suggestionId - offer 时才有；弃权也记录 requestId。
   * @param {string} input.sessionId
   * @param {string} input.turnKey
   * @param {string} input.trigger
   * @param {string} input.outcome - offer|abstain|unavailable|stale|cancelled
   * @param {string} [input.reason]
   * @param {string} [input.text] - 只进内存，不落盘。
   * @param {object} [input.route]
   * @param {number} [input.latencyMs]
   * @param {object} [input.usage]
   * @param {number} [input.suggestionGraphemes]
   */
  function recordRequest(input) {
    if (input === null || typeof input !== 'object') return
    prunePending()
    const suggestionId = typeof input.suggestionId === 'string' ? input.suggestionId : ''
    const record = {
      kind: 'request',
      r: hashId(input.requestId ?? ''),
      s: hashId(input.sessionId ?? ''),
      k: hashId(input.turnKey ?? ''),
      trigger: typeof input.trigger === 'string' ? input.trigger : '',
      outcome: typeof input.outcome === 'string' ? input.outcome : 'unknown',
      reason: typeof input.reason === 'string' ? input.reason.slice(0, 80) : '',
      provider: typeof input.route?.provider === 'string' ? input.route.provider : '',
      model: typeof input.route?.model === 'string' ? input.route.model : '',
      latencyMs: Number.isFinite(input.latencyMs) ? Math.max(0, Math.round(input.latencyMs)) : null,
      in: Number.isFinite(input.usage?.inputTokens) ? Math.max(0, Math.round(input.usage.inputTokens)) : null,
      out: Number.isFinite(input.usage?.outputTokens) ? Math.max(0, Math.round(input.usage.outputTokens)) : null,
      reasoning: Number.isFinite(input.usage?.reasoningTokens) ? Math.max(0, Math.round(input.usage.reasoningTokens)) : null,
      len: Number.isFinite(input.suggestionGraphemes) ? Math.max(0, Math.round(input.suggestionGraphemes)) : null,
      shown: false,
    }
    if (suggestionId !== '') record.g = hashId(suggestionId)
    const appendPromise = append(record)
    if (suggestionId !== '' && typeof input.text === 'string' && input.text !== '') {
      pending.set(suggestionId, {
        hash: hashId(suggestionId),
        text: input.text,
        // 同一次预测的其他候选：用户可能切到其中一条再发出，匹配时一并比较。
        alternatives: Array.isArray(input.alternatives) ? input.alternatives.filter((value) => typeof value === 'string' && value !== '') : [],
        sessionId: typeof input.sessionId === 'string' ? input.sessionId : '',
        at: now(),
        shown: false,
        disposition: null,
        matched: false,
      })
    }
    return appendPromise
  }

  /** 客户端确认建议真正显示在输入框上。 */
  function markShown(suggestionId) {
    const entry = pending.get(suggestionId)
    if (entry === undefined || entry.shown) return Promise.resolve()
    entry.shown = true
    return append({ kind: 'level', g: entry.hash, event: 'shown' })
  }

  /**
   * 客户端回报最终去向：accepted|dismissed|overwritten|expired|closed。
   *
   * “shown” 不是去向而是“建议真正显示过”这一事实：交给 markShown。否则它会占掉
   * 这条建议唯一的去向位置，之后的 accepted/dismissed 在汇总里全部被忽略
   * （采纳数恒为 0），用户下一条消息的匹配分数也永远不会写入。
   */
  function recordOutcome(suggestionId, event, reason) {
    if (typeof suggestionId !== 'string' || suggestionId === '') return Promise.resolve()
    if (event === 'shown') return markShown(suggestionId)
    const entry = pending.get(suggestionId)
    if (entry === undefined) return Promise.resolve()
    if (entry.disposition === event) return Promise.resolve()
    // 采纳和按 Esc 隐藏都只能发生在显示出来的建议上；“已显示”的回报丢了也补记。
    if ((event === 'accepted' || event === 'dismissed') && !entry.shown) void markShown(suggestionId)
    entry.disposition = event
    return append({
      kind: 'outcome',
      g: entry.hash,
      event: typeof event === 'string' ? event.slice(0, 24) : 'unknown',
      reason: typeof reason === 'string' ? reason.slice(0, 60) : '',
    })
  }

  /**
   * 用户发出下一条消息时计算与最近展示建议的匹配度（只写分数）。
   * @returns {{matched:boolean, exact?:boolean, prefixChars?:number, editRatio?:number}}
   */
  function noteUserMessage(sessionId, text) {
    prunePending()
    if (typeof sessionId !== 'string' || sessionId === '' || typeof text !== 'string' || text.trim() === '') {
      return { matched: false }
    }
    let chosen = null
    for (const [id, entry] of pending) {
      if (entry.sessionId !== sessionId || entry.matched || !entry.shown || text === '') continue
      if (chosen === null || entry.at > chosen.entry.at) chosen = { id, entry }
    }
    if (chosen === null) return { matched: false }
    // 多条候选时取最接近的那一条来打分。
    let score = matchScore(chosen.entry.text, text)
    for (const alternative of chosen.entry.alternatives ?? []) {
      const other = matchScore(alternative, text)
      if ((other.exact && !score.exact) || (!score.exact && other.editRatio > score.editRatio)) score = other
    }
    chosen.entry.matched = true
    void append({
      kind: 'match',
      g: chosen.entry.hash,
      exact: score.exact,
      prefix: score.prefixChars,
      edit: Math.round(score.editRatio * 1000) / 1000,
      ulen: score.userGraphemes,
      slen: score.suggestionGraphemes,
    })
    return { matched: true, ...score }
  }

  /** 读取 events 文件（当前 + 保留期内的轮换文件）并解析。 */
  async function readAllLines() {
    const lines = []
    let names = []
    try {
      names = await readdir(dir)
    } catch {
      return lines
    }
    const candidates = []
    for (const name of names) {
      if (name === 'events.jsonl') candidates.push({ name, current: true })
      else if (/^events\..+\.jsonl$/u.test(name)) candidates.push({ name, current: false })
    }
    for (const candidate of candidates) {
      const path = join(dir, candidate.name)
      let text
      try {
        text = await readFile(path, 'utf8')
      } catch {
        continue
      }
      for (const line of text.split('\n')) {
        if (line === '' || line.length > 4096) continue
        try {
          lines.push(JSON.parse(line))
        } catch {
          /* 损坏行忽略 */
        }
        if (lines.length >= MAX_SUMMARY_LINES) return lines
      }
    }
    return lines
  }

  /**
   * 7 天汇总（PLAN O01）：展示率、采纳率、采纳后未修改率、弃权原因分布、
   * P50/P95 延迟、日 token。只依赖哈希与分数，不含正文。
   */
  async function summary(days = 7) {
    const windowStart = now() - Math.max(1, Math.min(30, Number(days) || 7)) * 24 * 60 * 60 * 1000
    const lines = await readAllLines()
    /** @type {Map<string, object>} */
    const offers = new Map()
    const outcomes = { shown: 0, accepted: 0, dismissed: 0, overwritten: 0, expired: 0, closed: 0 }
    const abstainReasons = new Map()
    const latencies = []
    const dayTokens = new Map()
    const markOfferShown = (entry) => {
      if (entry === undefined || entry.shown) return
      entry.shown = true
      outcomes.shown += 1
    }
    let requests = 0
    let offerRequests = 0
    let abstainRequests = 0
    let unavailable = 0
    let stale = 0
    let cancelled = 0
    for (const line of lines) {
      if (line === null || typeof line !== 'object' || typeof line.t !== 'number' || line.t < windowStart) continue
      if (line.kind === 'request') {
        requests += 1
        // 只把真正经过上下文/模型的请求计入延迟，早退/禁用请求的 0ms 会污染分位数。
        if (typeof line.latencyMs === 'number' && line.latencyMs > 0 && (line.outcome === 'offer' || line.outcome === 'abstain')) {
          latencies.push(line.latencyMs)
        }
        const day = dayKey(line.t, getTimeZone())
        const dayEntry = dayTokens.get(day) ?? { requests: 0, input: 0, output: 0, reasoning: 0 }
        dayEntry.requests += 1
        dayEntry.input += Number(line.in) || 0
        dayEntry.output += Number(line.out) || 0
        dayEntry.reasoning += Number(line.reasoning) || 0
        dayTokens.set(day, dayEntry)
        if (line.outcome === 'offer') {
          offerRequests += 1
          if (typeof line.g === 'string') {
            offers.set(line.g, {
              shown: false,
              disposition: null,
              exact: null,
              prefix: null,
              edit: null,
            })
          }
        } else if (line.outcome === 'abstain') {
          abstainRequests += 1
          const reason = typeof line.reason === 'string' && line.reason !== '' ? line.reason : 'unknown'
          abstainReasons.set(reason, (abstainReasons.get(reason) ?? 0) + 1)
        } else if (line.outcome === 'unavailable') unavailable += 1
        else if (line.outcome === 'stale') stale += 1
        else if (line.outcome === 'cancelled') cancelled += 1
      } else if ((line.kind === 'level' || line.kind === 'outcome') && line.event === 'shown' && typeof line.g === 'string') {
        // 0.2.x 把 “shown” 写成了 outcome 行；两种写法都按“已显示”统计，旧记录因此也能正确汇总。
        markOfferShown(offers.get(line.g))
      } else if (line.kind === 'outcome' && typeof line.g === 'string' && typeof line.event === 'string') {
        const entry = offers.get(line.g)
        if (entry !== undefined && entry.disposition === null) {
          entry.disposition = line.event
          if (line.event in outcomes) outcomes[line.event] += 1
          // 采纳/隐藏意味着建议显示过，采纳率的分母不能比分子小。
          if (line.event === 'accepted' || line.event === 'dismissed') markOfferShown(entry)
        }
      } else if (line.kind === 'match' && typeof line.g === 'string') {
        const entry = offers.get(line.g)
        if (entry !== undefined) {
          entry.exact = line.exact === true
          entry.prefix = Number.isFinite(line.prefix) ? line.prefix : null
          entry.edit = Number.isFinite(line.edit) ? line.edit : null
        }
      }
    }
    const sortedLatencies = [...latencies].sort((a, b) => a - b)
    const percentile = (p) => {
      if (sortedLatencies.length === 0) return null
      const index = Math.min(sortedLatencies.length - 1, Math.max(0, Math.ceil((p / 100) * sortedLatencies.length) - 1))
      return sortedLatencies[index]
    }
    const acceptedWithMatch = [...offers.values()].filter((entry) => entry.disposition === 'accepted' && entry.exact !== null)
    const acceptedUnaltered = acceptedWithMatch.filter((entry) => entry.exact === true).length
    const matchedPrefixes = acceptedWithMatch.map((entry) => entry.prefix).filter((value) => typeof value === 'number')
    return {
      windowDays: days,
      generatedAt: now(),
      file: '<DSH_HOME>/next-message-predictor/events.jsonl',
      requests,
      offers: offerRequests,
      abstains: abstainRequests,
      unavailable,
      stale,
      cancelled,
      shown: outcomes.shown,
      accepted: outcomes.accepted,
      dismissed: outcomes.dismissed,
      overwritten: outcomes.overwritten,
      expired: outcomes.expired,
      closed: outcomes.closed,
      showRate: offerRequests === 0 ? null : Math.round((outcomes.shown / offerRequests) * 1000) / 10,
      acceptRate: outcomes.shown === 0 ? null : Math.round((outcomes.accepted / outcomes.shown) * 1000) / 10,
      acceptedUnalteredRate: acceptedWithMatch.length === 0 ? null : Math.round((acceptedUnaltered / acceptedWithMatch.length) * 1000) / 10,
      averagePrefixChars: matchedPrefixes.length === 0
        ? null
        : Math.round((matchedPrefixes.reduce((sum, value) => sum + value, 0) / matchedPrefixes.length) * 10) / 10,
      latencyP50: percentile(50),
      latencyP95: percentile(95),
      tokenDays: [...dayTokens.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([day, entry]) => ({ day, ...entry })),
      abstainReasons: [...abstainReasons.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([reason, count]) => ({ reason, count })),
    }
  }

  return {
    recordRequest,
    markShown,
    recordOutcome,
    noteUserMessage,
    summary,
    filePath,
    flush: () => queue,
    _pending: pending,
  }
}
