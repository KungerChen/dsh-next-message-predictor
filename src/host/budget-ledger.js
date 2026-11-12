// 持久化派发账本与每日预算（Host）。
//
// 为什么是插件私有 JSON（方案 §六 取舍）：
// - `ctx.storageDomain` 依赖 `@deepseek-ai/dsh-storage-domain` 与 zod 的跨包
//   schema 身份，P0 未验证；linked 插件当前无法解析这些包；
// - 参考实现使用 `<DSH_HOME>/<name>.json` + temp+rename 已是生产可用路径。
//   本插件使用 `<DSH_HOME>/next-message-predictor/ledger.json`，不写 storages/ 或 sessions/。
//
// 语义（方案 §六 / §八）：
// - 派发前先持久记录“派发标记 + 预算预留 + 本回合调用次数”，写入失败则不调用模型；
// - 自动派发账本保留 24 小时（不保存正文），重启后不会无依据重算旧回合；
// - 每回合的模型调用次数（自动、手动）同样落盘，保留 24 小时，重启后不重新计数；
// - 每日聚合按配置时区的日历日，保留 7 天；
// - 不承诺提供商侧精确一次计费，也不能跨物理尝试精确计费。
//
// 每日 token 分三类，每日上限按三者之和计算：
// - 实测（inputTokens / outputTokens / reasoningTokens）：服务商报告的用量；
// - 估算（estimatedTokens）：已经结束、但用量没有（完整）报告的调用。能拿到的
//   部分按实测记，只估算缺的部分，规则见 chargeForCall；
// - 预留（reservedTokens）：正在进行的调用。结算时转成实测或估算。
// 加载账本时没有任何调用在进行（同一进程内的多个实例共用一份状态，见
// shareWithinProcess），所以文件里残留的预留都属于上一个进程：转成估算并记日志。
//
// 并发假设：DSH 单 Host 进程、预测服务全局并发 1；本模块串行写。多实例共享
// DSH_HOME 时没有跨进程锁（已知限制，写入是原子替换，最坏情况是账本被后写者覆盖）。

import { copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const DISPATCH_TTL_MS = 24 * 60 * 60 * 1000
/** 回合调用次数的保留时间：与派发标记相同。 */
const TURN_TTL_MS = DISPATCH_TTL_MS
/** 回合记录的数量上限（每日请求数上限之外的第二道边界）。 */
const MAX_TURNS = 2000
const BUDGET_KEEP_DAYS = 7
/** 同一回合未展示时可重派发的最大物理尝试数（B05）。 */
const MAX_UNSHOWN_ATTEMPTS = 2
/** 自动预测每回合最多几次模型调用：一次，加上 B05 允许的一次补发。 */
export const MAX_AUTO_CALLS_PER_TURN = MAX_UNSHOWN_ATTEMPTS
/** 与 request-registry 的默认值一致。 */
const DEFAULT_MANUAL_LIMIT = 3
const SCHEMA_VERSION = 2
/** 这些推理档位不产生推理 token。 */
export const NO_REASONING_EFFORTS = new Set(['off', 'none', 'no-thinking', 'disabled'])
/** 调用已经开始、但流没有走到 finish 的结束方式。 */
const INTERRUPTED_FINISH = new Set(['threw', 'missing', 'orphaned'])

/** 同一进程内按文件路径共用的状态（插件重启 = 同一进程里重新 apply）。 */
const SHARED_STORES = Symbol.for('dsh-next-message-predictor.ledger-stores.v2')

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

function count(value) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : 0
}

function isObject(value) {
  return value !== null && typeof value === 'object'
}

/**
 * 一次已派发调用应计入每日额度的 token：实测部分与估算部分分开。
 *
 * 输入：
 * - inputTokens / maxOutputTokens：预留时的输入估算与输出上限（预留 = 两者之和）；
 * - usage：服务商报告的用量（可能不完整）；partialUsage：流中断前收到的用量；
 * - finishKind：'stop' | 'max-tokens' | 'aborted' | 'error' | 'unknown'（流走到了 finish）
 *   或 'threw' | 'missing' | 'orphaned'（没有走到）；缺省表示旧调用方，见下；
 * - observedOutputTokens：已收到的输出文字的估算 token；
 * - reasoningRuledOut：本次调用的推理档位确定不产生推理 token。
 *
 * 规则：
 * - 输入：服务商报告了（输入 + 缓存读写 > 0）就按实测，否则按预留时的估算；
 * - 输出：流走到 finish 且报告了输出 token 就按实测（含推理）；
 *   否则正常结束（stop）且确定没有推理时，按收到的文字估算；
 *   其余情况（被截断、超时、取消、出错、中途断开）按输出上限计，且不少于已收到的部分——
 *   看不到的推理、服务商已生成但没送达的部分只有上限能兜住。
 * - 旧调用方（没有 finishKind）：有 usage 按实测，没有按整笔预留估算。
 *
 * @returns {{inputTokens:number, outputTokens:number, reasoningTokens:number, estimatedTokens:number, estimated:boolean}}
 */
export function chargeForCall(input) {
  const reserved = count(input?.reservedTokens)
  const usage = isObject(input?.usage) ? input.usage : isObject(input?.partialUsage) ? input.partialUsage : null
  const finishKind = typeof input?.finishKind === 'string' ? input.finishKind : ''
  if (finishKind === '') {
    if (usage !== null) {
      return {
        inputTokens: count(usage.inputTokens) + count(usage.cacheReadTokens) + count(usage.cacheWriteTokens),
        outputTokens: count(usage.outputTokens),
        reasoningTokens: count(usage.reasoningTokens),
        estimatedTokens: 0,
        estimated: false,
      }
    }
    return { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, estimatedTokens: reserved, estimated: true }
  }
  const cap = Number.isFinite(Number(input?.maxOutputTokens)) ? count(input.maxOutputTokens) : 0
  const inputEstimate = Number.isFinite(Number(input?.inputTokens)) && input?.inputTokens !== undefined
    ? count(input.inputTokens)
    : Math.max(0, reserved - cap)
  const observed = count(input?.observedOutputTokens)
  const finished = !INTERRUPTED_FINISH.has(finishKind)
  const result = { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, estimatedTokens: 0, estimated: false }

  const reportedInput = usage === null ? 0 : count(usage.inputTokens) + count(usage.cacheReadTokens) + count(usage.cacheWriteTokens)
  if (reportedInput > 0) result.inputTokens = reportedInput
  else result.estimatedTokens += inputEstimate

  const outputReported = usage !== null && usage === input?.usage && usage.outputTokens !== undefined && usage.outputTokens !== null && Number.isFinite(Number(usage.outputTokens))
  if (finished && outputReported && (count(usage.outputTokens) > 0 || finishKind === 'stop')) {
    result.outputTokens = count(usage.outputTokens)
    result.reasoningTokens = count(usage.reasoningTokens)
  } else if (finishKind === 'stop' && input?.reasoningRuledOut === true) {
    result.estimatedTokens += observed
  } else {
    result.estimatedTokens += Math.max(cap, observed)
  }
  result.estimated = reportedInput === 0 || result.estimatedTokens > 0
  return result
}

function emptyState() {
  return { schemaVersion: SCHEMA_VERSION, dispatches: {}, turns: {}, budgetDays: {}, updatedAt: 0 }
}

function emptyDay() {
  return {
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    /** 用量（全部或部分）是估算的调用数。 */
    unknownUsage: 0,
    /** 正在进行的调用的预留。 */
    reservedTokens: 0,
    /** 已结束、用量没有（完整）报告的调用的估算。 */
    estimatedTokens: 0,
    /** 其中由上一个进程遗留的预留转成估算的调用数。 */
    orphanedCalls: 0,
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
        reserved: count(value.reserved),
      }
    }
  }
  if (raw.turns !== null && typeof raw.turns === 'object') {
    for (const [key, value] of Object.entries(raw.turns)) {
      if (value === null || typeof value !== 'object' || typeof value.at !== 'number') continue
      state.turns[key] = {
        at: value.at,
        auto: Number.isSafeInteger(value.auto) && value.auto > 0 ? value.auto : 0,
        manual: Number.isSafeInteger(value.manual) && value.manual > 0 ? value.manual : 0,
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

function newStore() {
  return {
    state: emptyState(),
    /** dispatchKey -> 被本次 reserve 覆盖的旧记录与回合（用于 notDispatched 回滚）。 */
    reserveBackups: new Map(),
    loaded: false,
    loadPromise: null,
    mutations: Promise.resolve(),
  }
}

function sharedStore(filePath) {
  let stores = globalThis[SHARED_STORES]
  if (!(stores instanceof Map)) {
    stores = new Map()
    globalThis[SHARED_STORES] = stores
  }
  let store = stores.get(filePath)
  if (store === undefined) {
    store = newStore()
    stores.set(filePath, store)
  }
  return store
}

/**
 * @param {object} options
 * @param {string} options.homeDir - DSH home（`$DSH_HOME` 或 `~/.dsh`）。
 * @param {() => number} [options.now]
 * @param {() => string} [options.getTimeZone]
 * @param {() => {dailyRequestLimit:number, dailyTokenBudget:number}} [options.getLimits]
 * @param {(line:string) => void} [options.logger]
 * @param {boolean} [options.shareWithinProcess] - 同一进程里对同一文件的实例共用状态与写队列。
 *   插件在保存设置后会在同一进程里重新 apply；共用状态让新实例看到旧实例仍在进行的调用
 *   （不误当作遗留预留），也避免两个实例互相覆盖文件。测试默认不共用，以便模拟进程重启。
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
  const store = options.shareWithinProcess === true ? sharedStore(filePath) : newStore()

  async function ensureLoaded() {
    if (store.loaded) return
    if (store.loadPromise !== null) return store.loadPromise
    store.loadPromise = (async () => {
      let text
      try {
        text = await readFile(filePath, 'utf8')
      } catch (error) {
        if (error !== null && typeof error === 'object' && error.code !== 'ENOENT') {
          logger(`[next-message-predictor] ledger load failed: ${String(error.code ?? error.message)}`)
        }
        text = undefined
      }
      store.state = emptyState()
      let sourceVersion = SCHEMA_VERSION
      if (text !== undefined) {
        try {
          const raw = JSON.parse(text)
          sourceVersion = isObject(raw) && typeof raw.schemaVersion === 'number' ? raw.schemaVersion : 1
          store.state = normalizeState(raw)
        } catch {
          // 文件损坏（写到一半断电、被别的程序改坏）：账本只能从空开始，但把坏文件
          // 留一份副本，并明确记一条日志——今天的用量和派发记录从此处重新计数。
          const backup = `${filePath}.corrupt-${new Date(now()).toISOString().replace(/[:.]/g, '-')}`
          await copyFile(filePath, backup).catch(() => {})
          logger(`[next-message-predictor] ledger file is not valid JSON; starting from an empty ledger (damaged file kept as ${backup.slice(homeDir.length + 1)})`)
        }
      }
      recoverReservations(sourceVersion)
      store.loaded = true
      prune()
    })()
    return store.loadPromise
  }

  /**
   * 加载时把文件里的预留转成估算：此刻本进程没有任何调用在进行，残留的预留都属于
   * 上一个进程（崩溃、DSH 退出时调用还没结束）。转换不改变每日上限的计算结果。
   * 0.4.0 及更早的账本（schemaVersion 1）把“进行中的预留”和“用量未知调用的估算”
   * 混在 reservedTokens 里，也一并转成估算；那时用量未知的调用已计入 unknownUsage，
   * 崩溃遗留的调用则无法再区分，不补计数。
   */
  function recoverReservations(sourceVersion) {
    const state = store.state
    const orphans = new Map()
    for (const record of Object.values(state.dispatches)) {
      if (record.reserved > 0) {
        orphans.set(record.day, (orphans.get(record.day) ?? 0) + 1)
        record.reserved = 0
      }
    }
    let tokens = 0
    for (const entry of Object.values(state.budgetDays)) {
      if (entry.reservedTokens > 0) {
        entry.estimatedTokens += entry.reservedTokens
        tokens += entry.reservedTokens
        entry.reservedTokens = 0
      }
    }
    let calls = 0
    for (const [day, number] of orphans) {
      const entry = state.budgetDays[day]
      if (entry === undefined) continue
      entry.unknownUsage += number
      entry.orphanedCalls += number
      calls += number
    }
    if (sourceVersion < SCHEMA_VERSION) {
      if (tokens > 0) logger(`[next-message-predictor] ledger from an earlier version: ${tokens} reserved tokens are now counted as estimated usage (the daily total is unchanged)`)
    } else if (tokens > 0 || calls > 0) {
      logger(`[next-message-predictor] ledger: ${calls} call(s) were still running when the previous process ended; their ${tokens} reserved tokens are now counted as estimated usage`)
    }
  }

  function today() {
    return dayKey(now(), getTimeZone())
  }

  function dayEntry(day) {
    if (store.state.budgetDays[day] === undefined) store.state.budgetDays[day] = emptyDay()
    return store.state.budgetDays[day]
  }

  function prune() {
    const state = store.state
    const cutoff = now() - DISPATCH_TTL_MS
    for (const [key, entry] of Object.entries(state.dispatches)) {
      if (entry.at < cutoff) delete state.dispatches[key]
    }
    const turnCutoff = now() - TURN_TTL_MS
    for (const [key, entry] of Object.entries(state.turns)) {
      if (entry.at < turnCutoff) delete state.turns[key]
    }
    const turnKeys = Object.keys(state.turns)
    if (turnKeys.length > MAX_TURNS) {
      turnKeys.sort((a, b) => state.turns[a].at - state.turns[b].at)
      for (const key of turnKeys.slice(0, turnKeys.length - MAX_TURNS)) delete state.turns[key]
    }
    const keepDays = new Set()
    for (let i = 0; i < BUDGET_KEEP_DAYS + 1; i += 1) keepDays.add(dayKey(now() - i * 24 * 60 * 60 * 1000, getTimeZone()))
    for (const day of Object.keys(state.budgetDays)) {
      if (!keepDays.has(day)) delete state.budgetDays[day]
    }
  }

  /** Atomically replace the ledger within a serialized mutation. */
  async function persist() {
    const snapshot = JSON.stringify({ ...store.state, schemaVersion: SCHEMA_VERSION, updatedAt: now() })
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
      const pending = store.mutations.then(() => action(input))
      store.mutations = pending.catch(() => {})
      return pending
    }
  }

  /**
   * 某个回合是否已有“已展示或已用尽重试额度”的派发记录（跨重启）。
   * 未展示且仍有重试额度的记录不算，允许 B05 的“重启后补发一次”。
   */
  function hasDispatch(key) {
    if (typeof key !== 'string') return false
    const record = store.state.dispatches[key]
    if (record === undefined || record.at < now() - DISPATCH_TTL_MS) return false
    return record.shown === true || (Number(record.attempt) || 1) >= MAX_UNSHOWN_ATTEMPTS
  }

  function manualLimitOf(value) {
    return Number.isInteger(value) && value > 0 ? value : DEFAULT_MANUAL_LIMIT
  }

  /** 某回合已经花掉的模型调用次数（跨重启；只读）。 */
  function turnCalls(turnKey) {
    const record = typeof turnKey === 'string' ? store.state.turns[turnKey] : undefined
    if (record === undefined || record.at < now() - TURN_TTL_MS) return { auto: 0, manual: 0 }
    return { auto: record.auto, manual: record.manual }
  }

  /** 按持久记录，这一回合是否还能为该触发方式调用模型。 */
  function turnCredit(turnKey, trigger, manualLimit) {
    const calls = turnCalls(turnKey)
    return trigger === 'manual' ? calls.manual < manualLimitOf(manualLimit) : calls.auto < MAX_AUTO_CALLS_PER_TURN
  }

  /** 预算是否允许一次新派发（基于内存聚合，不做写盘）。 */
  function canReserve(estimate, day = today()) {
    const entry = store.state.budgetDays[day] ?? emptyDay()
    const limits = getLimits()
    const inputTokens = count(estimate?.inputTokens)
    const maxOutputTokens = count(estimate?.maxOutputTokens)
    const reserved = inputTokens + maxOutputTokens
    if (entry.requests + 1 > limits.dailyRequestLimit) return { ok: false, reason: 'daily-request-limit' }
    if (committedTokens(entry) + reserved > limits.dailyTokenBudget) {
      return { ok: false, reason: 'daily-token-budget' }
    }
    return { ok: true, reservedTokens: reserved, inputTokens, maxOutputTokens }
  }

  /**
   * 派发前持久化：派发标记 + 预算预留 + 本回合调用次数，一次原子写入。
   * 写盘失败时全部回滚，次数不被占用。
   * @returns {Promise<{ok:true, reservedTokens:number, inputTokens:number, maxOutputTokens:number, day:string} | {ok:false, reason:string}>}
   */
  async function reserve(input) {
    await ensureLoaded()
    prune()
    const key = typeof input?.dispatchKey === 'string' ? input.dispatchKey : ''
    if (key === '') return { ok: false, reason: 'bad-dispatch-key' }
    if (hasDispatch(key)) return { ok: false, reason: 'already-dispatched' }
    const trigger = typeof input.trigger === 'string' ? input.trigger : ''
    const turnKey = typeof input.turnKey === 'string' ? input.turnKey : ''
    if (turnKey !== '' && !turnCredit(turnKey, trigger, input.manualLimit)) return { ok: false, reason: 'turn-limit' }
    const day = today()
    const check = canReserve(input.estimate, day)
    if (!check.ok) return check
    const previous = JSON.parse(JSON.stringify(store.state))
    const state = store.state
    const existing = state.dispatches[key]
    const shown = existing?.shown === true
    const attempt = existing === undefined ? 1 : (Number(existing.attempt) || 1) + 1
    state.dispatches[key] = {
      at: now(),
      day,
      trigger,
      provider: typeof input.provider === 'string' ? input.provider : '',
      model: typeof input.model === 'string' ? input.model : '',
      configRevision: typeof input.configRevision === 'number' ? input.configRevision : 0,
      shown,
      attempt,
      reserved: check.reservedTokens,
    }
    if (turnKey !== '') {
      const record = state.turns[turnKey] !== undefined && state.turns[turnKey].at >= now() - TURN_TTL_MS
        ? state.turns[turnKey]
        : { at: 0, auto: 0, manual: 0 }
      if (trigger === 'manual') record.manual += 1
      else record.auto += 1
      record.at = now()
      state.turns[turnKey] = record
    }
    const entry = dayEntry(day)
    entry.requests += 1
    entry.reservedTokens += check.reservedTokens
    const ok = await persist()
    if (ok === false) {
      store.state = previous
      return { ok: false, reason: 'ledger-write-failed' }
    }
    store.reserveBackups.set(key, { dispatch: existing === undefined ? undefined : { ...existing }, turnKey, trigger })
    return { ok: true, reservedTokens: check.reservedTokens, inputTokens: check.inputTokens, maxOutputTokens: check.maxOutputTokens, day }
  }

  /**
   * 完成后结算：预留转为实测或估算（chargeForCall）；notDispatched 时整笔撤销。
   * @returns {Promise<boolean>} 是否成功写盘（失败只记录，不影响本次响应）。
   */
  async function settle(input) {
    await ensureLoaded()
    const state = store.state
    const day = input?.day ?? today()
    const key = input?.dispatchKey
    const reserved = count(input?.reservedTokens)
    if (input?.notDispatched === true) {
      if (state.dispatches[key]?.day !== day) return false
      const entry = dayEntry(day)
      const backup = store.reserveBackups.get(key)
      if (backup?.dispatch === undefined) delete state.dispatches[key]
      else state.dispatches[key] = backup.dispatch
      if (backup !== undefined && backup.turnKey !== '' && state.turns[backup.turnKey] !== undefined) {
        const record = state.turns[backup.turnKey]
        const field = backup.trigger === 'manual' ? 'manual' : 'auto'
        record[field] = Math.max(0, record[field] - 1)
        if (record.auto === 0 && record.manual === 0) delete state.turns[backup.turnKey]
      }
      store.reserveBackups.delete(key)
      entry.requests = Math.max(0, entry.requests - 1)
      entry.reservedTokens = Math.max(0, entry.reservedTokens - reserved)
      return persist()
    }
    store.reserveBackups.delete(key)
    const entry = dayEntry(day)
    const record = typeof key === 'string' ? state.dispatches[key] : undefined
    if (record !== undefined) record.reserved = 0
    entry.reservedTokens = Math.max(0, entry.reservedTokens - reserved)
    // B09e: DSH 的 TokenUsage.totalTokens = inputTokens + outputTokens +
    // cacheReadTokens + cacheWriteTokens，说明 inputTokens 已不含缓存命中；
    // 因此相加不会重复计费（cache 单列也保留在诊断里）。
    const charge = chargeForCall(input)
    entry.inputTokens += charge.inputTokens
    entry.outputTokens += charge.outputTokens
    entry.reasoningTokens += charge.reasoningTokens
    entry.estimatedTokens += charge.estimatedTokens
    if (charge.estimated) entry.unknownUsage += 1
    return persist()
  }

  /** 只读快照，供 status/设置页展示。 */
  function snapshot() {
    const day = today()
    const entry = store.state.budgetDays[day] ?? emptyDay()
    const limits = getLimits()
    const measuredTokens = entry.inputTokens + entry.outputTokens + entry.reasoningTokens
    const live = Object.values(store.state.dispatches).filter((record) => record.at >= now() - DISPATCH_TTL_MS)
    return {
      day,
      timeZone: getTimeZone(),
      ...entry,
      measuredTokens,
      /** 每日上限比较的数字：实测 + 估算 + 进行中的预留。 */
      usedTokens: committedTokens(entry),
      dailyRequestLimit: limits.dailyRequestLimit,
      dailyTokenBudget: limits.dailyTokenBudget,
      dispatches: Object.keys(store.state.dispatches).length,
      unshownDispatches: live.filter((record) => record.shown !== true).length,
      inflightDispatches: live.filter((record) => record.reserved > 0).length,
      trackedTurns: Object.keys(store.state.turns).length,
      file: '<DSH_HOME>/next-message-predictor/ledger.json',
    }
  }

  /** Mark this dispatch as actually shown to the user (B05). */
  async function markShown(dispatchKey) {
    await ensureLoaded()
    const record = store.state.dispatches[dispatchKey]
    if (record === undefined || record.shown === true) return false
    record.shown = true
    const ok = await persist()
    return ok !== false
  }

  /** 所有派发键（诊断用，不含正文）。 */
  function dispatchKeys() {
    return Object.keys(store.state.dispatches)
  }

  return {
    ensureLoaded,
    hasDispatch,
    turnCalls,
    turnCredit,
    canReserve,
    reserve: serialize(reserve),
    settle: serialize(settle),
    markShown: serialize(markShown),
    snapshot,
    dispatchKeys,
    filePath,
  }
}

/** 计入每日上限的 token：实测 + 估算 + 进行中的预留。 */
function committedTokens(entry) {
  return entry.inputTokens + entry.outputTokens + entry.reasoningTokens + entry.estimatedTokens + entry.reservedTokens
}
