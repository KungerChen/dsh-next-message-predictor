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
//
// 候选环里每一条都有来源：模型（model）、会话里重复发过的短消息（habit）、固定
// 短语（pinned）。落盘的只有各来源的条数和采纳的是哪一条；匹配分数只和模型的
// 候选比较，采纳率和延迟分位数也只统计模型。
//
// 保存设置会让插件在同一进程里重启：index.js 用 shareWithinProcess 让新旧实例
// 共用内存里的待匹配建议，屏幕上那条建议的去向和匹配不因重启而丢失。

import { appendFile, mkdir, readFile, readdir, rename, stat, unlink } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'

import { normalizePhraseKey } from '../shared/output-validation.js'

const HASH_SALT = 'dsh-next-message-predictor/results/v1'
const MAX_BYTES = 5 * 1024 * 1024
const KEEP_DAYS = 14
const PENDING_TTL_MS = 2 * 60 * 60 * 1000
const MAX_PENDING = 200
const MAX_SUMMARY_LINES = 50000
/** 汇总时每解析这么多行让出一次事件循环。 */
const SUMMARY_YIELD_EVERY = 4000
/** 汇总结果的缓存时间；期间有新记录写入就作废。 */
const SUMMARY_CACHE_MS = 15000

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

/** `events.2026-11-10T18-01-34-123Z.jsonl` -> 轮换时刻（毫秒）；认不出时返回 null。 */
function rotationTime(name) {
  const match = /^events\.(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z\.jsonl$/u.exec(name)
  if (match === null) return null
  const time = Date.parse(`${match[1]}T${match[2]}:${match[3]}:${match[4]}.${match[5]}Z`)
  return Number.isFinite(time) ? time : null
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


/** 同一进程内按文件路径共用的状态（插件重启 = 同一进程里重新 apply）。 */
const SHARED_RESULTS_STORES = Symbol.for('dsh-next-message-predictor.results-stores.v1')

/** Where a candidate came from; anything else in a record is read as the model. */
const SOURCES = ['model', 'habit', 'pinned']

function newResultsStore() {
  return {
    /** @type {Map<string, object>} suggestionId -> in-memory pending offer (正文只在内存) */
    pending: new Map(),
    bytes: -1,
    /** 已写入的行数；汇总缓存用它判断“之后有没有新记录”。 */
    writeCount: 0,
    summaryCache: null,
    queue: Promise.resolve(),
    lastCleanup: 0,
    initialized: false,
  }
}

function sharedResultsStore(filePath) {
  let stores = globalThis[SHARED_RESULTS_STORES]
  if (!(stores instanceof Map)) {
    stores = new Map()
    globalThis[SHARED_RESULTS_STORES] = stores
  }
  let store = stores.get(filePath)
  if (store === undefined) {
    store = newResultsStore()
    stores.set(filePath, store)
  }
  return store
}

/** The candidate ring as recorded: model candidates first, then the user's own phrases. */
function ringOf(input) {
  const ring = []
  const push = (text, source) => {
    if (typeof text !== 'string' || text === '' || ring.some((entry) => entry.text === text)) return
    ring.push({ text, source })
  }
  if (input.fallback !== true) {
    push(input.text, 'model')
    for (const text of Array.isArray(input.alternatives) ? input.alternatives : []) push(text, 'model')
  }
  for (const entry of Array.isArray(input.local) ? input.local : []) {
    if (entry !== null && typeof entry === 'object' && (entry.source === 'habit' || entry.source === 'pinned')) push(entry.text, entry.source)
  }
  return ring
}

/**
 * @param {object} options
 * @param {string} options.homeDir
 * @param {() => number} [options.now]
 * @param {() => string} [options.getTimeZone]
 * @param {(line: string) => void} [options.logger]
 * @param {number} [options.maxBytes] - 测试可覆盖轮换阈值。
 * @param {boolean} [options.shareWithinProcess] - 同一进程里对同一文件的实例共用内存状态
 *   （待匹配的建议、写队列、文件大小）。保存任何设置都会让宿主在同一进程里重新 apply
 *   本插件；共用之后，屏幕上那条建议的“已显示”、去向和用户下一条消息的匹配不会因为
 *   重启而丢失，两个实例也不会各自计算文件大小。测试默认不共用，以便模拟进程重启。
 */
export function createResultsLog(options) {
  const homeDir = options.homeDir
  const now = typeof options.now === 'function' ? options.now : Date.now
  const getTimeZone = typeof options.getTimeZone === 'function' ? options.getTimeZone : () => 'UTC'
  const logger = typeof options.logger === 'function' ? options.logger : () => {}
  const maxBytes = Math.max(1024, Number(options.maxBytes) || MAX_BYTES)
  const dir = join(homeDir, 'next-message-predictor')
  const filePath = join(dir, 'events.jsonl')
  const store = options.shareWithinProcess === true ? sharedResultsStore(filePath) : newResultsStore()
  const pending = store.pending

  async function initialize() {
    if (store.initialized) return
    try {
      const info = await stat(filePath)
      store.bytes = info.size
    } catch {
      store.bytes = 0
    }
    store.initialized = true
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
    if (now() - store.lastCleanup < 60 * 60 * 1000) return
    store.lastCleanup = now()
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
    if (store.bytes < 0) await initialize()
    if (store.bytes === 0) return
    if (store.bytes + lineBytes <= maxBytes) return
    const stamp = new Date(now()).toISOString().replace(/[:.]/g, '-')
    try {
      await rename(filePath, join(dir, `events.${stamp}.jsonl`))
      store.bytes = 0
    } catch (error) {
      // 没轮换成：文件还在原处继续变大，计数不能清零，下一行会再试一次。
      logger(`[next-message-predictor] results rotate failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** 追加一行；串行化（同一进程的实例共用一个队列）、失败只记日志。 */
  function append(record) {
    store.queue = store.queue
      .then(async () => {
        await mkdir(dir, { recursive: true })
        const line = `${JSON.stringify({ t: now(), ...record })}\n`
        const lineBytes = Buffer.byteLength(line)
        await rotateIfNeeded(lineBytes)
        await appendFile(filePath, line, 'utf8')
        store.bytes = Math.max(0, store.bytes) + lineBytes
        store.writeCount += 1
        void cleanupOldFiles()
      })
      .catch((error) => {
        logger(`[next-message-predictor] results append failed: ${error instanceof Error ? error.message : String(error)}`)
      })
    return store.queue
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
   * @param {string} [input.reason] - 回退 offer 时是模型没有给出建议的原因。
   * @param {string} [input.text] - 模型的第一条候选，只进内存，不落盘。
   * @param {string[]} [input.alternatives] - 模型的其他候选，只进内存。
   * @param {{text: string, source: string}[]} [input.local] - 本机短语，只进内存；落盘的只有条数。
   * @param {boolean} [input.fallback] - 只含本机短语的 offer（模型没有给出建议）。
   * @param {boolean} [input.cached] - 结果来自缓存，这次请求没有经过生产任务。
   * @param {object} [input.route]
   * @param {number} [input.latencyMs]
   * @param {object} [input.usage]
   * @param {number} [input.suggestionGraphemes]
   */
  function recordRequest(input) {
    if (input === null || typeof input !== 'object') return
    prunePending()
    const suggestionId = typeof input.suggestionId === 'string' ? input.suggestionId : ''
    const isOffer = input.outcome === 'offer'
    const ring = isOffer ? ringOf(input) : []
    const modelCount = ring.filter((entry) => entry.source === 'model').length
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
    if (isOffer) {
      // How the ring is made up, as counts only: model candidates, habit phrases, pinned phrases.
      record.nm = modelCount
      record.nh = ring.filter((entry) => entry.source === 'habit').length
      record.np = ring.filter((entry) => entry.source === 'pinned').length
      if (input.fallback === true) record.fb = true
    }
    if (input.cached === true) record.cached = true
    if (suggestionId !== '') record.g = hashId(suggestionId)
    const appendPromise = append(record)
    // A second request that receives the same suggestion (another view waiting on
    // the same production, a cache hit, a retry) must not start its record over:
    // "shown" and the outcome already reported would be lost, and the page reports
    // "shown" only once per suggestion.
    if (suggestionId !== '' && ring.length > 0 && !pending.has(suggestionId)) {
      pending.set(suggestionId, {
        hash: hashId(suggestionId),
        ring,
        sessionId: typeof input.sessionId === 'string' ? input.sessionId : '',
        at: now(),
        shown: false,
        disposition: null,
        accepted: null,
        matched: false,
      })
    }
    return appendPromise
  }

  /** 客户端确认建议真正显示在输入框上。 */
  function markShown(suggestionId) {
    if (typeof suggestionId !== 'string' || suggestionId === '') return Promise.resolve()
    const entry = pending.get(suggestionId)
    if (entry !== undefined && entry.shown) return Promise.resolve()
    if (entry !== undefined) entry.shown = true
    return append({ kind: 'level', g: entry?.hash ?? hashId(suggestionId), event: 'shown' })
  }

  /**
   * 客户端回报最终去向：accepted|dismissed|overwritten|expired|closed。
   *
   * “shown” 不是去向而是“建议真正显示过”这一事实：交给 markShown。否则它会占掉
   * 这条建议唯一的去向位置，之后的 accepted/dismissed 在汇总里全部被忽略
   * （采纳数恒为 0），用户下一条消息的匹配分数也永远不会写入。
   *
   * 采纳时记下采纳的是环里的哪一条（index）以及它的来源（model / habit / pinned）。
   * 来源以本机记下的环为准；记录已经不在内存里时（超过 2 小时）才用页面报的来源。
   * 内存里没有这条建议时照样写一行：哈希可以重新算出，汇总只认每条建议的第一个去向。
   * @param {{index: number, source?: string} | null} [choice]
   */
  function recordOutcome(suggestionId, event, reason, choice) {
    if (typeof suggestionId !== 'string' || suggestionId === '') return Promise.resolve()
    if (event === 'shown') return markShown(suggestionId)
    const entry = pending.get(suggestionId)
    if (entry !== undefined && entry.disposition === event) return Promise.resolve()
    const line = {
      kind: 'outcome',
      g: entry?.hash ?? hashId(suggestionId),
      event: typeof event === 'string' ? event.slice(0, 24) : 'unknown',
      reason: typeof reason === 'string' ? reason.slice(0, 60) : '',
    }
    if (event === 'accepted') {
      const index = Number.isInteger(choice?.index) && choice.index >= 0 ? choice.index : 0
      const fromRing = entry?.ring?.[index]?.source
      const source = SOURCES.includes(fromRing) ? fromRing : SOURCES.includes(choice?.source) ? choice.source : entry === undefined ? 'model' : entry.ring[0]?.source ?? 'model'
      line.source = source
      line.index = index
      if (entry !== undefined) entry.accepted = { index, source }
    }
    if (entry !== undefined) {
      // 采纳和按 Esc 隐藏都只能发生在显示出来的建议上；“已显示”的回报丢了也补记。
      if ((event === 'accepted' || event === 'dismissed') && !entry.shown) void markShown(suggestionId)
      entry.disposition = event
    }
    return append(line)
  }

  /**
   * 用户发出下一条消息时计算与最近展示建议的匹配度（只写分数）。
   *
   * 分数只和模型的候选比：用户自己的短语不算模型的功劳。采纳的是模型的某一条时
   * 只和那一条比，否则取模型候选里最接近的一条。消息和某条本机短语相同（按
   * normalizePhraseKey）时另记它的来源。整条环都是本机短语时（回退）不打模型分数。
   * @returns {{matched:boolean, exact?:boolean, prefixChars?:number, editRatio?:number, local?:string}}
   */
  function noteUserMessage(sessionId, text) {
    prunePending()
    if (typeof sessionId !== 'string' || sessionId === '' || typeof text !== 'string' || text.trim() === '') {
      return { matched: false }
    }
    let chosen = null
    for (const [id, entry] of pending) {
      if (entry.sessionId !== sessionId || entry.matched || !entry.shown) continue
      if (chosen === null || entry.at > chosen.entry.at) chosen = { id, entry }
    }
    if (chosen === null) return { matched: false }
    const entry = chosen.entry
    const modelTexts = entry.ring.filter((candidate) => candidate.source === 'model').map((candidate) => candidate.text)
    const acceptedModel = entry.accepted !== null && entry.accepted.source === 'model' ? entry.ring[entry.accepted.index]?.text : undefined
    let score = null
    for (const candidate of typeof acceptedModel === 'string' ? [acceptedModel] : modelTexts) {
      const next = matchScore(candidate, text)
      if (score === null || (next.exact && !score.exact) || (!score.exact && next.editRatio > score.editRatio)) score = next
    }
    const key = normalizePhraseKey(text)
    const localHit = entry.ring.find((candidate) => candidate.source !== 'model' && normalizePhraseKey(candidate.text) === key)
    entry.matched = true
    const line = { kind: 'match', g: entry.hash }
    if (score === null) {
      line.nomodel = true
      line.ulen = Array.from(text.replace(/\s+/gu, ' ').trim()).length
    } else {
      line.exact = score.exact
      line.prefix = score.prefixChars
      line.edit = Math.round(score.editRatio * 1000) / 1000
      line.ulen = score.userGraphemes
      line.slen = score.suggestionGraphemes
    }
    if (localHit !== undefined) line.local = localHit.source
    void append(line)
    return { matched: true, ...(score ?? {}), ...(localHit !== undefined ? { local: localHit.source } : {}) }
  }

  /**
   * 读取 events 文件（当前 + 修改时间落在统计窗口内的轮换文件）并解析。
   * 每解析一批就让出一次事件循环：文件接近 5 MB 时一口气解析会让 Host 卡住几秒。
   * @param {number} windowStart - 早于这个时间就不再写入的轮换文件直接跳过。
   */
  async function readAllLines(windowStart) {
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
    // 当前文件最后读：行数触顶时保住的是最新的记录。
    candidates.sort((a, b) => Number(a.current) - Number(b.current) || (a.name < b.name ? -1 : 1))
    for (const candidate of candidates) {
      const path = join(dir, candidate.name)
      let text
      try {
        // 轮换文件名里带着轮换时刻：那之后它不再有新记录，早于窗口的整份跳过。
        if (!candidate.current && Number.isFinite(windowStart)) {
          const rotatedAt = rotationTime(candidate.name)
          if (rotatedAt !== null && rotatedAt < windowStart) continue
        }
        text = await readFile(path, 'utf8')
      } catch {
        continue
      }
      let sinceYield = 0
      for (const line of text.split('\n')) {
        if (line === '' || line.length > 4096) continue
        try {
          lines.push(JSON.parse(line))
        } catch {
          /* 损坏行忽略 */
        }
        sinceYield += 1
        if (sinceYield >= SUMMARY_YIELD_EVERY) {
          sinceYield = 0
          await new Promise((resolve) => setImmediate(resolve))
        }
      }
    }
    // 超过上限时丢掉最早的，不是最新的。
    return lines.length > MAX_SUMMARY_LINES ? lines.slice(lines.length - MAX_SUMMARY_LINES) : lines
  }

  /**
   * 7 天汇总（PLAN O01）：展示率、采纳率、采纳后未修改率、弃权原因分布、
   * P50/P95 延迟、日 token。只依赖哈希与分数，不含正文。
   */
  async function summary(days = 7) {
    const windowDays = Math.max(1, Math.min(30, Number(days) || 7))
    // 设置页每次打开和点“刷新”都会要一次汇总；几秒内重复请求直接用上一次的结果。
    const cache = store.summaryCache
    if (cache !== null && cache.days === windowDays && now() - cache.at < SUMMARY_CACHE_MS && cache.writes === store.writeCount) {
      return cache.value
    }
    const value = await computeSummary(windowDays)
    store.summaryCache = { days: windowDays, at: now(), writes: store.writeCount, value }
    return value
  }

  async function computeSummary(days) {
    const windowStart = now() - days * 24 * 60 * 60 * 1000
    const lines = await readAllLines(windowStart)
    /** @type {Map<string, object>} */
    const offers = new Map()
    const outcomes = { shown: 0, accepted: 0, dismissed: 0, overwritten: 0, expired: 0, closed: 0 }
    const acceptedBySource = { model: 0, habit: 0, pinned: 0 }
    const abstainReasons = new Map()
    const latencies = []
    const dayTokens = new Map()
    let shownWithModel = 0
    const markOfferShown = (entry) => {
      if (entry === undefined || entry.shown) return
      entry.shown = true
      outcomes.shown += 1
      if (entry.modelCount > 0) shownWithModel += 1
    }
    let requests = 0
    let offerRequests = 0
    let localFallbacks = 0
    let abstainRequests = 0
    let unavailable = 0
    let stale = 0
    let cancelled = 0
    for (const line of lines) {
      if (line === null || typeof line !== 'object' || typeof line.t !== 'number' || line.t < windowStart) continue
      if (line.kind === 'request') {
        requests += 1
        // 延迟只统计真正调用了模型的请求：早退、禁用、缓存命中、上下文读取失败
        // 没有路由（provider 为空）；0.4.x 及更早把“常说的话”记成 provider 'habit'，
        // 那是本机读取，也不算。
        const provider = typeof line.provider === 'string' ? line.provider : ''
        if (
          typeof line.latencyMs === 'number' && line.latencyMs > 0 && (line.outcome === 'offer' || line.outcome === 'abstain') &&
          provider !== '' && provider !== 'habit' && line.cached !== true
        ) {
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
          // The same suggestion handed to a second waiter or served from the cache is one offer, not two.
          if (typeof line.g === 'string' && offers.has(line.g)) continue
          offerRequests += 1
          if (line.fb === true) localFallbacks += 1
          if (typeof line.g === 'string') {
            const legacyHabit = provider === 'habit'
            offers.set(line.g, {
              shown: false,
              disposition: null,
              acceptedSource: null,
              // Older lines carry no counts: a habit offer of 0.4.x had no model candidate.
              modelCount: Number.isInteger(line.nm) ? line.nm : legacyHabit ? 0 : 1,
              defaultSource: legacyHabit ? 'habit' : Number.isInteger(line.nm) && line.nm === 0 ? (line.nh > 0 ? 'habit' : 'pinned') : 'model',
              exact: null,
              prefix: null,
              edit: null,
              scored: false,
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
          if (line.event === 'accepted') {
            const source = SOURCES.includes(line.source) ? line.source : entry.defaultSource
            entry.acceptedSource = source
            acceptedBySource[source] += 1
          }
          // 采纳/隐藏意味着建议显示过，采纳率的分母不能比分子小。
          if (line.event === 'accepted' || line.event === 'dismissed') markOfferShown(entry)
        }
      } else if (line.kind === 'match' && typeof line.g === 'string') {
        const entry = offers.get(line.g)
        if (entry !== undefined && line.nomodel !== true) {
          entry.scored = true
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
    // Only the model's own suggestions: a phrase of the user's that was accepted says nothing about the model.
    const acceptedWithMatch = [...offers.values()].filter((entry) => entry.acceptedSource === 'model' && entry.scored)
    const acceptedUnaltered = acceptedWithMatch.filter((entry) => entry.exact === true).length
    const matchedPrefixes = acceptedWithMatch.map((entry) => entry.prefix).filter((value) => typeof value === 'number')
    return {
      windowDays: days,
      generatedAt: now(),
      file: '<DSH_HOME>/next-message-predictor/events.jsonl',
      requests,
      offers: offerRequests,
      localFallbacks,
      abstains: abstainRequests,
      unavailable,
      stale,
      cancelled,
      shown: outcomes.shown,
      shownWithModel,
      accepted: outcomes.accepted,
      acceptedBySource,
      dismissed: outcomes.dismissed,
      overwritten: outcomes.overwritten,
      expired: outcomes.expired,
      closed: outcomes.closed,
      showRate: offerRequests === 0 ? null : Math.round((outcomes.shown / offerRequests) * 1000) / 10,
      // Model suggestions only: accepted model candidates over shown offers that had one.
      acceptRate: shownWithModel === 0 ? null : Math.round((acceptedBySource.model / shownWithModel) * 1000) / 10,
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
    flush: () => store.queue,
    _pending: pending,
  }
}
