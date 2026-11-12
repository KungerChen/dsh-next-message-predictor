// Host 诊断记录器。
//
// 隐私规则（方案 §九）：只保留原因码、耗时、模型标识和聚合用量；不记录上下文、
// 建议正文、Cookie、Key 或完整用户消息。格式化集中在此文件，便于审查。
//
// 诊断是内存实现：进程结束即消失。持久指标（每日 token/请求）由 budget-ledger 负责。

const MAX_EVENTS = 60

/** 计数器初值；`count()` 只累加已知计数键。 */
function emptyCounters() {
  return {
    requestsReceived: 0,
    requestsRejected: 0,
    productionTasks: 0,
    attempts: 0,
    reservations: 0,
    ledgerFailures: 0,
    duplicateDispatches: 0,
    contextBuilds: 0,
    contextFailures: 0,
    providerCalls: 0,
    offers: 0,
    /** Manual predictions answered with the user's own phrases only (no model suggestion). */
    localFallbacks: 0,
    abstains: 0,
    outputRejects: 0,
    stale: 0,
    unavailable: 0,
    cacheHits: 0,
    releases: 0,
    dismisses: 0,
    accepts: 0,
    sendCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    unknownUsage: 0,
  }
}

/** Create one diagnostics recorder per plugin instance. */
export function createDiagnostics(options) {
  const now = options && typeof options.now === 'function' ? options.now : Date.now
  const log = options && typeof options.log === 'function' ? options.log : defaultLog
  const events = []
  const counters = emptyCounters()

  /** Append one reason-coded event; never includes user-visible content. */
  function record(kind, details) {
    const event = { at: now(), kind, ...(details === undefined ? {} : details) }
    events.push(event)
    if (events.length > MAX_EVENTS) events.shift()
    log(`[next-message-predictor] ${kind}${describe(details)}`)
    return event
  }

  /** Record a counter without logging content. */
  function count(key, delta) {
    if (typeof counters[key] === 'number') counters[key] += delta === undefined ? 1 : delta
  }

  /** Read-only diagnostics snapshot for Settings and tests. */
  function snapshot() {
    return {
      counters: { ...counters },
      events: events.slice(),
      sendCalls: 0,
    }
  }

  return { record, count, snapshot }
}

function describe(details) {
  if (details === undefined) return ''
  const parts = []
  for (const key of Object.keys(details)) {
    const value = details[key]
    if (value === undefined || value === null || value === '') continue
    parts.push(`${key}=${short(value)}`)
  }
  return parts.length === 0 ? '' : ` ${parts.join(' ')}`
}

function short(value) {
  const text = String(value)
  return text.length > 100 ? `${text.slice(0, 97)}...` : text
}

function defaultLog(line) {
  try {
    console.info(line)
  } catch {
    /* console unavailable */
  }
}
