// 持久化派发账本与每日预算（Host）。
//
// 为什么是插件私有 JSON（方案 §六 取舍）：
// - `ctx.storageDomain` 依赖 `@deepseek-ai/dsh-storage-domain` 与 zod 的跨包
//   schema 身份，P0 未验证；linked 插件当前无法解析这些包；
// - 参考实现使用 `<DSH_HOME>/<name>.json` + temp+rename 已是生产可用路径。
//   本插件使用 `<DSH_HOME>/next-message-predictor/ledger.json`，不写 storages/ 或 sessions/。
//
// 语义（方案 §六 / §八）：
// - 派发前先持久记录“派发标记 + 预算预留”，写入失败则不调用模型；
// - 自动派发账本保留 24 小时（不保存正文），重启后不会无依据重算旧回合；
// - 每日聚合（请求数/token/未知 usage）按配置时区的日历日，保留 7 天；
// - 取消或异常导致 usage 缺失时保留保守预留并计为 unknown，不退回“零成本”；
// - 不承诺提供商侧精确一次计费，也不能跨物理尝试精确计费。
//
// 并发假设：DSH 单 Host 进程、预测服务全局并发 1；本模块串行写。多实例共享
// DSH_HOME 时没有跨进程锁（P2 已知限制，写入是原子替换，最坏情况是账本被后写者覆盖）。

import { copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const DISPATCH_TTL_MS = 24 * 60 * 60 * 1000
const BUDGET_KEEP_DAYS = 7
/** 同一回合未展示时可重派发的最大物理尝试数（B05）。 */
const MAX_UNSHOWN_ATTEMPTS = 2

/** 计算一个 IANA 时区下的日历日键（YYYY-MM-DD）。 */
export function dayKey(nowMs, timeZone) {
  const date = new Date(nowMs)
  try {
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: typeof timeZone === 'string' && timeZone !== '' ? timeZone : 'UTC',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
    return formatter.format(date)
  } catch {
    return date.toISOString().slice(0, 10)
  }
}

function emptyState() {
  return { schemaVersion: 1, dispatches: {}, budgetDays: {}, updatedAt: 0 }
}

function emptyDay() {
  return {
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    unknownUsage: 0,
    reservedTokens: 0,
  }
}

function normalizeState(raw) {
  const state = emptyState()
  if (raw === null || typeof raw !== 'object') return state
  if (raw.dispatches !== null && typeof raw.dispatches === 'object') {
    for (const [key, value] of Object.entries(raw.dispatches)) {
      if (value === null || typeof value !== 'object') continue
      if (typeof value.at !== 'number') continue
      // 旧账本没有 shown 字段：保守视为已展示，避免升级后重复花费。
      const shown = value.shown === false ? false : true
      state.dispatches[key] = {
        at: value.at,
        day: typeof value.day === 'string' ? value.day : '',
        trigger: typeof value.trigger === 'string' ? value.trigger : '',
        provider: typeof value.provider === 'string' ? value.provider : '',
        model: typeof value.model === 'string' ? value.model : '',
        configRevision: typeof value.configRevision === 'number' ? value.configRevision : 0,
        shown,
        attempt: Number.isSafeInteger(value.attempt) && value.attempt > 0 ? value.attempt : 1,
      }
    }
  }
  if (raw.budgetDays !== null && typeof raw.budgetDays === 'object') {
    for (const [day, value] of Object.entries(raw.budgetDays)) {
      if (value === null || typeof value !== 'object') continue
      const entry = emptyDay()
      for (const key of Object.keys(entry)) {
        if (typeof value[key] === 'number' && Number.isFinite(value[key]) && value[key] >= 0) entry[key] = value[key]
      }
      state.budgetDays[day] = entry
    }
  }
  if (typeof raw.updatedAt === 'number') state.updatedAt = raw.updatedAt
  return state
}

/**
 * @param {object} options
 * @param {string} options.homeDir - DSH home（`$DSH_HOME` 或 `~/.dsh`）。
 * @param {() => number} [options.now]
 * @param {() => string} [options.getTimeZone]
 * @param {() => {dailyRequestLimit:number, dailyTokenBudget:number}} [options.getLimits]
 * @param {(line:string) => void} [options.logger]
 */
export function createPersistentLedger(options) {
  const homeDir = options.homeDir
  const now = typeof options.now === 'function' ? options.now : Date.now
  const getTimeZone = typeof options.getTimeZone === 'function' ? options.getTimeZone : () => 'UTC'
  const getLimits = typeof options.getLimits === 'function'
    ? options.getLimits
    : () => ({ dailyRequestLimit: 200, dailyTokenBudget: 500000 })
  const logger = typeof options.logger === 'function' ? options.logger : () => {}
  const filePath = join(homeDir, 'next-message-predictor', 'ledger.json')
  let state = emptyState()
  /** dispatchKey -> 被本次 reserve 覆盖的旧记录（用于 notDispatched 回滚）。 */
  const reserveBackups = new Map()
  let loaded = false
  let loadPromise = null
  let mutations = Promise.resolve()

  async function ensureLoaded() {
    if (loaded) return
    if (loadPromise !== null) return loadPromise
    loadPromise = (async () => {
      let text
      try {
        text = await readFile(filePath, 'utf8')
      } catch (error) {
        if (error !== null && typeof error === 'object' && error.code !== 'ENOENT') {
          logger(`[next-message-predictor] ledger load failed: ${String(error.code ?? error.message)}`)
        }
        text = undefined
      }
      state = emptyState()
      if (text !== undefined) {
        try {
          state = normalizeState(JSON.parse(text))
        } catch {
          // 文件损坏（写到一半断电、被别的程序改坏）：账本只能从空开始，但把坏文件
          // 留一份副本，并明确记一条日志——今天的用量和派发记录从此处重新计数。
          const backup = `${filePath}.corrupt-${new Date(now()).toISOString().replace(/[:.]/g, '-')}`
          await copyFile(filePath, backup).catch(() => {})
          logger(`[next-message-predictor] ledger file is not valid JSON; starting from an empty ledger (damaged file kept as ${backup.slice(homeDir.length + 1)})`)
        }
      }
      loaded = true
      prune()
    })()
    return loadPromise
  }

  function today() {
    return dayKey(now(), getTimeZone())
  }

  function dayEntry(day) {
    if (state.budgetDays[day] === undefined) state.budgetDays[day] = emptyDay()
    return state.budgetDays[day]
  }

  function prune() {
    const cutoff = now() - DISPATCH_TTL_MS
    for (const [key, entry] of Object.entries(state.dispatches)) {
      if (entry.at < cutoff) delete state.dispatches[key]
    }
    const keepDays = new Set()
    for (let i = 0; i < BUDGET_KEEP_DAYS + 1; i += 1) keepDays.add(dayKey(now() - i * 24 * 60 * 60 * 1000, getTimeZone()))
    for (const day of Object.keys(state.budgetDays)) {
      if (!keepDays.has(day)) delete state.budgetDays[day]
    }
  }

  /** Atomically replace the ledger within a serialized mutation. */
  async function persist() {
    const snapshot = JSON.stringify({ ...state, updatedAt: now() })
    try {
      const dir = join(homeDir, 'next-message-predictor')
      await mkdir(dir, { recursive: true })
      const temp = `${filePath}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`
      await writeFile(temp, `${snapshot}\n`, 'utf8')
      await rename(temp, filePath)
      return true
    } catch (error) {
      logger(`[next-message-predictor] ledger write failed: ${error instanceof Error ? error.message : String(error)}`)
      return false
    }
  }

  function serialize(action) {
    return (input) => {
      const pending = mutations.then(() => action(input))
      mutations = pending.catch(() => {})
      return pending
    }
  }

  /** 某个回合是否已有自动派发记录（跨重启）。 */
  /**
   * 某个回合是否已有“已展示或已用尽重试额度”的派发记录（跨重启）。
   * 未展示且仍有重试额度的记录不算，允许 B05 的“重启后补发一次”。
   */
  function hasDispatch(key) {
    if (typeof key !== 'string') return false
    const record = state.dispatches[key]
    if (record === undefined || record.at < now() - DISPATCH_TTL_MS) return false
    return record.shown === true || (Number(record.attempt) || 1) >= MAX_UNSHOWN_ATTEMPTS
  }

  /** 预算是否允许一次新派发（基于内存聚合，不做写盘）。 */
  function canReserve(estimate, day = today()) {
    const entry = state.budgetDays[day] ?? emptyDay()
    const limits = getLimits()
    const reserved = Math.max(0, Number(estimate?.inputTokens) || 0) + Math.max(0, Number(estimate?.maxOutputTokens) || 0)
    if (entry.requests + 1 > limits.dailyRequestLimit) return { ok: false, reason: 'daily-request-limit' }
    if (entry.inputTokens + entry.outputTokens + entry.reasoningTokens + entry.reservedTokens + reserved > limits.dailyTokenBudget) {
      return { ok: false, reason: 'daily-token-budget' }
    }
    return { ok: true, reservedTokens: reserved }
  }

  /**
   * 派发前持久化：派发标记 + 预算预留。
   * @returns {Promise<{ok:true, reservedTokens:number, day:string} | {ok:false, reason:string}>}
   */
  async function reserve(input) {
    await ensureLoaded()
    prune()
    const key = typeof input?.dispatchKey === 'string' ? input.dispatchKey : ''
    if (key === '') return { ok: false, reason: 'bad-dispatch-key' }
    if (hasDispatch(key)) return { ok: false, reason: 'already-dispatched' }
    const day = today()
    const check = canReserve(input.estimate, day)
    if (!check.ok) return check
    const previous = JSON.parse(JSON.stringify(state))
    const existing = state.dispatches[key]
    const shown = existing?.shown === true
    const attempt = existing === undefined ? 1 : (Number(existing.attempt) || 1) + 1
    if (existing !== undefined) reserveBackups.set(key, { ...existing })
    state.dispatches[key] = {
      at: now(),
      day,
      trigger: typeof input.trigger === 'string' ? input.trigger : '',
      provider: typeof input.provider === 'string' ? input.provider : '',
      model: typeof input.model === 'string' ? input.model : '',
      configRevision: typeof input.configRevision === 'number' ? input.configRevision : 0,
      shown,
      attempt,
    }
    const entry = dayEntry(day)
    entry.requests += 1
    entry.reservedTokens += check.reservedTokens
    const ok = await persist()
    if (ok === false) {
      state = previous
      reserveBackups.delete(key)
      return { ok: false, reason: 'ledger-write-failed' }
    }
    return { ok: true, reservedTokens: check.reservedTokens, day }
  }

  /**
   * 完成后结算：按可用 usage 更新 token；缺失时保留保守预留并计 unknown。
   * @returns {Promise<boolean>} 是否成功写盘（失败只记录，不影响本次响应）。
   */
  async function settle(input) {
    await ensureLoaded()
    const day = input?.day ?? today()
    const entry = dayEntry(day)
    const reserved = Math.max(0, Number(input?.reservedTokens) || 0)
    const usage = input?.usage
    if (input?.notDispatched === true) {
      if (state.dispatches[input.dispatchKey]?.day !== day) return false
      const backup = reserveBackups.get(input.dispatchKey)
      if (backup === undefined) delete state.dispatches[input.dispatchKey]
      else state.dispatches[input.dispatchKey] = backup
      reserveBackups.delete(input.dispatchKey)
      entry.requests = Math.max(0, entry.requests - 1)
      entry.reservedTokens = Math.max(0, entry.reservedTokens - reserved)
    } else if (usage === null || usage === undefined || typeof usage !== 'object') {
      reserveBackups.delete(input?.dispatchKey)
      if (input?.markUnknown !== false) entry.unknownUsage += 1
    } else {
      reserveBackups.delete(input?.dispatchKey)
      entry.reservedTokens = Math.max(0, entry.reservedTokens - reserved)
      // B09e: DSH 的 TokenUsage.totalTokens = inputTokens + outputTokens +
      // cacheReadTokens + cacheWriteTokens，说明 inputTokens 已不含缓存命中；
      // 因此这里相加不会重复计费（cache 单列也保留在诊断里）。
      entry.inputTokens += Math.max(0, Number(usage.inputTokens) || 0) + Math.max(0, Number(usage.cacheReadTokens) || 0) + Math.max(0, Number(usage.cacheWriteTokens) || 0)
      entry.outputTokens += Math.max(0, Number(usage.outputTokens) || 0)
      entry.reasoningTokens += Math.max(0, Number(usage.reasoningTokens) || 0)
    }
    return persist()
  }

  /** 只读快照，供 status/设置页展示。 */
  function snapshot() {
    const day = today()
    const entry = state.budgetDays[day] ?? emptyDay()
    const limits = getLimits()
    return {
      day,
      timeZone: getTimeZone(),
      ...entry,
      dailyRequestLimit: limits.dailyRequestLimit,
      dailyTokenBudget: limits.dailyTokenBudget,
      dispatches: Object.keys(state.dispatches).length,
      unshownDispatches: Object.values(state.dispatches).filter((entry) => entry.shown !== true && entry.at >= now() - DISPATCH_TTL_MS).length,
      file: '<DSH_HOME>/next-message-predictor/ledger.json',
    }
  }

  /** Mark this dispatch as actually shown to the user (B05). */
  async function markShown(dispatchKey) {
    await ensureLoaded()
    const record = state.dispatches[dispatchKey]
    if (record === undefined || record.shown === true) return false
    record.shown = true
    const ok = await persist()
    return ok !== false
  }

  /** 所有派发键（诊断用，不含正文）。 */
  function dispatchKeys() {
    return Object.keys(state.dispatches)
  }

  return { ensureLoaded, hasDispatch, canReserve, reserve: serialize(reserve), settle: serialize(settle), markShown: serialize(markShown), snapshot, dispatchKeys, filePath }
}
