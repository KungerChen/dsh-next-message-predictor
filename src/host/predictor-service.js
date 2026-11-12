// Host 侧预测服务：协议校验、资格与预算、去重与共享等待者、上下文读取、
// 辅助模型调用、严格输出解析与结果缓存。
//
// P1（无模型）模式仍保留为显式测试路径：当没有注入 modelProvider，或配置为
// `modelMode:'fixed'` + `provider:'fixed-test'` 时，使用固定测试建议，不调用模型。
// 生产路径：复核完成事件，读取 `ctx.sessionQuery.readSurface` 权威上下文 →
// `ctx.llm.stream` 一次辅助调用 → 严格 JSON 解析 → 校验后 offer。
//
// 硬规则：本模块不调用任何会话提交/发送 API；不向会话 append；不传 sessionId 给模型。

import {
  LOCAL_PHRASES_MAX,
  OFFER_TTL_MS,
  isPlainObject,
  normalizeConfig,
  sanitizeConfigPatch,
  configRevision,
} from '../shared/config.js'
import {
  OPERATION_ACCEPTED,
  OPERATION_CONFIG_GET,
  OPERATION_CONFIG_SET,
  OPERATION_DISMISS,
  OPERATION_OUTCOME,
  OPERATION_PREDICT,
  OPERATION_RELEASE,
  OPERATION_RESULTS,
  OPERATION_STATUS,
  RESULT_ABSTAIN,
  RESULT_OFFER,
  RESULT_STALE,
  RESULT_UNAVAILABLE,
  SOURCE_HABIT,
  SOURCE_PINNED,
  acceptedChoice,
  validatePredictRequest,
} from '../shared/protocol.js'
import { normalizePhraseKey, parseCandidatesJson, validateSuggestionText } from '../shared/output-validation.js'
import { buildManualSuffix, buildSystemPrompt, estimateTokens, PROMPT_VERSION } from '../shared/prompt.js'
import { PLUGIN_VERSION } from '../shared/version.js'
import { NO_REASONING_EFFORTS } from './budget-ledger.js'
import { produceFixedSuggestion, PROVIDER_KIND as FIXED_PROVIDER_KIND } from './fake-provider.js'
import { createDiagnostics } from './diagnostics.js'
import { createRequestRegistry } from './request-registry.js'
import { semanticViolation } from './semantic-filter.js'

const REQUEST_MEMORY_MS = 30 * 1000
const MAX_REQUEST_MEMORY = 200
const MAX_RESULT_CACHE = 100
/** B01: 只允许对最近 30 分钟内完成的回合补发（Host 侧最终限制）。 */
const COMPLETION_RESEND_WINDOW_MS = 30 * 60 * 1000
/** B09d：内存集合上限，避免长会话无限增长。 */
const MAX_TRACKED = 500
/** 多条候选开启时，一次模型调用最多要几条。 */
const MAX_CANDIDATES = 3
/** 每条候选按约 65 token 预留输出预算（三条 ≈ 200）。 */
const OUTPUT_TOKENS_PER_CANDIDATE = 65
const MULTI_CANDIDATE_OUTPUT_TOKENS = 200

/** 配置的候选条数（2–5），缺省 3。 */
function candidateLimit(config) {
  const value = Number(config?.candidateCount)
  return Number.isInteger(value) && value >= 2 && value <= 5 ? value : MAX_CANDIDATES
}
/**
 * 手动预测时模型没有给出建议，哪些结果可以改为给出本机短语。会话已经往前走、
 * 请求被取消、后台忙（页面会自己重试）或功能关闭时不给。
 */
const NO_FALLBACK_REASONS = new Set(['stale-context', 'stale-view', 'cancelled', 'busy', 'disabled', 'config-changed', 'turn-accepted', 'turn-dismissed'])
function fallbackEligible(result) {
  if (result === null || typeof result !== 'object') return false
  if (NO_FALLBACK_REASONS.has(result.reason)) return false
  if (result.kind === RESULT_ABSTAIN || result.kind === RESULT_UNAVAILABLE) return true
  // 本回合的手动次数已经用完：模型不会再被调用，但用户的短语照样可以给。
  return result.kind === RESULT_STALE && result.reason === 'already-requested'
}
/** O01：客户端可回报的建议终态。 */
const OUTCOME_EVENTS = new Set(['shown', 'overwritten', 'expired', 'closed'])
export const FIXED_TEST_PROVIDER = 'fixed-test'

/** 有界 Set：超过上限时淘汰最旧元素。 */
function boundedSet(limit = MAX_TRACKED) {
  const set = new Set()
  return {
    add(value) {
      set.add(value)
      while (set.size > limit) {
        const oldest = set.values().next().value
        if (oldest === undefined) break
        set.delete(oldest)
      }
      return set
    },
    has: (value) => set.has(value),
    delete: (value) => set.delete(value),
    clear: () => set.clear(),
    values: () => set.values(),
    get size() {
      return set.size
    },
  }
}

/** 有界 Map：超过上限时淘汰最旧键。 */
function boundedMap(limit = MAX_TRACKED) {
  const map = new Map()
  return {
    set(key, value) {
      map.delete(key)
      map.set(key, value)
      while (map.size > limit) {
        const oldest = map.keys().next().value
        if (oldest === undefined) break
        map.delete(oldest)
      }
      return map
    },
    get: (key) => map.get(key),
    delete: (key) => map.delete(key),
    get size() {
      return map.size
    },
  }
}

/** 空实现：未注入时的安全降级。 */
const ABSENT_CONTEXT_READER = {
  async verifyAnchor() {
    return { ok: false, reason: 'unverified-completion' }
  },
  async read() {
    return { ok: false, reason: 'no-context-reader' }
  },
}

/**
 * @param {object} options
 * @param {object} options.config - 归一化后的生效配置。
 * @param {string[]} [options.configErrors]
 * @param {object} options.adapter - dsh-adapter。
 * @param {object} [options.contextReader] - createSessionContextReader 实例（P2）。
 * @param {object} [options.modelProvider] - createModelProvider 实例（P2）。
 * @param {object} [options.ledger] - createPersistentLedger 实例（P2）。
 * @param {(config: object) => void} [options.onConfigChange] - 生效配置在进程内被替换时调用。
 * @param {number} [options.now]
 * @param {() => string} [options.randomId]
 */
export function createPredictorService(options) {
  const adapter = options.adapter
  const now = typeof options.now === 'function' ? options.now : Date.now
  const randomId = typeof options.randomId === 'function' ? options.randomId : defaultRandomId
  const diagnostics = createDiagnostics({ now })
  const registry = createRequestRegistry()
  const contextReader = options.contextReader !== undefined && options.contextReader !== null ? options.contextReader : ABSENT_CONTEXT_READER
  const modelProvider = options.modelProvider !== undefined && options.modelProvider !== null ? options.modelProvider : null
  const ledger = options.ledger !== undefined && options.ledger !== null ? options.ledger : null
  /** O01：持久化结果记录（可缺省，测试注入）。 */
  const results = options.results !== undefined && options.results !== null ? options.results : null

  let effective = normalizeConfig(options.config)
  let revision = configRevision(effective.config)
  let lastRoute = null
  // 调用方传入的是同一份配置的校验结果；合并去重，写入新配置后整体替换。
  let configErrors = [...new Set([...(Array.isArray(options.configErrors) ? options.configErrors : []), ...effective.errors])]
  if (ledger !== null && typeof ledger.ensureLoaded === 'function') {
    void ledger.ensureLoaded().catch(() => {})
  }

  /** @type {Map<string, {at:number, response:object}>} */
  const requestMemory = new Map()
  /** @type {Map<string, object>} */
  const resultCache = new Map()
  const dismissedIds = boundedSet()
  const acceptedIds = boundedSet()
  const dismissedTurns = boundedSet()
  const releasedRequests = boundedSet()
  /** suggestionId -> dispatchKey（B05/O01 关联；有界）。 */
  const suggestionDispatches = boundedMap()
  /**
   * 回合 -> 已经给出过的建议正文（只在内存，有界）。用户按 Alt+\ “换一条”时，
   * 把它们告诉模型，避免换来换去还是同一句。
   */
  const offeredTexts = boundedMap(200)
  /**
   * 每个生产任务自己的计量信息（路由、耗时、用量），按结果键存放，有界。
   * 不用一个全局“最近一次”变量：被取消的任务完成时会覆盖它，另一条请求的
   * 结果记录就会带上别人的模型和耗时。
   */
  const productionMeta = boundedMap(100)
  let disposed = false

  diagnostics.record('service-ready', {
    enabled: effective.config.enabled,
    configRevision: revision,
    configErrors: configErrors.length,
    mode: providerMode(effective.config),
    modelMode: effective.config.modelMode,
  })

  /** 是否使用固定测试建议（P1 回归/离线调试）。 */
  function isFixedTestMode(config) {
    if (modelProvider === null) return true
    return config.modelMode === 'fixed' && config.provider === FIXED_TEST_PROVIDER
  }

  function providerMode(config) {
    return isFixedTestMode(config) ? FIXED_PROVIDER_KIND : 'model'
  }

  function currentConfigStatus() {
    return { config: effective.config, configRevision: revision, configErrors: [...configErrors] }
  }

  function operationResult(operation, value) {
    return { status: 200, body: { operation, ok: true, value } }
  }

  function operationError(operation, code, message, status) {
    return { status: typeof status === 'number' ? status : 200, body: { operation, ok: false, error: { code, message } } }
  }

  function predictResponse(request, result) {
    return { requestId: request.requestId, anchor: request.anchor, configRevision: revision, result }
  }

  function remember(requestId, response) {
    requestMemory.set(requestId, { at: now(), response })
    if (requestMemory.size > MAX_REQUEST_MEMORY) {
      const oldest = requestMemory.keys().next().value
      if (oldest !== undefined) requestMemory.delete(oldest)
    }
  }

  function pruneRequestMemory() {
    const cutoff = now() - REQUEST_MEMORY_MS
    for (const [key, entry] of requestMemory) {
      if (entry.at < cutoff) requestMemory.delete(key)
    }
  }

  function cacheOffer(cacheKey, offer) {
    resultCache.set(cacheKey, offer)
    if (resultCache.size > MAX_RESULT_CACHE) {
      const oldest = resultCache.keys().next().value
      if (oldest !== undefined) resultCache.delete(oldest)
    }
  }

  function cachedOffer(cacheKey) {
    const entry = resultCache.get(cacheKey)
    if (entry === undefined) return undefined
    if (entry.expiresAt <= now()) {
      resultCache.delete(cacheKey)
      return undefined
    }
    return entry
  }

  /** 权威身份键：会话 + 完成事件 seq + 客户端回合标识 + 触发方式（B05：自动/手动各一次）。 */
  function dispatchKeyFor(request) {
    const { anchor } = request
    const base = `${anchor.sessionId}\u0000${anchor.branchEpoch}\u0000${anchor.completedEventSeq}\u0000${anchor.turnId}\u0000${request.trigger}`
    // “换一条”是同一回合的第 2、3 次手动预测，各自记账、各自缓存。
    return request.trigger === 'manual' && request.attempt > 0 ? `${base}\u0000r${request.attempt}` : base
  }

  function cacheKeyFor(request) {
    return [
      dispatchKeyFor(request),
      revision,
      PROMPT_VERSION,
      providerMode(effective.config),
    ].join('\u0000')
  }

  function turnKeyFor(request) {
    const { anchor } = request
    return [anchor.sessionId, anchor.branchEpoch, anchor.turnId].join('\u0000')
  }

  /** 记录模型 usage 到诊断（不含正文）。 */
  function countUsage(usage) {
    if (usage === null || usage === undefined || typeof usage !== 'object') {
      diagnostics.count('unknownUsage')
      return
    }
    diagnostics.count('inputTokens', Math.max(0, Number(usage.inputTokens) || 0))
    diagnostics.count('outputTokens', Math.max(0, Number(usage.outputTokens) || 0))
    diagnostics.count('reasoningTokens', Math.max(0, Number(usage.reasoningTokens) || 0))
    diagnostics.count('cacheReadTokens', Math.max(0, Number(usage.cacheReadTokens) || 0))
    diagnostics.count('cacheWriteTokens', Math.max(0, Number(usage.cacheWriteTokens) || 0))
  }

  /**
   * 本机短语：会话里重复发过的短消息（habitSuggestions）和固定短语（pinnedPhrases），
   * 按这个顺序，跟在模型候选之后。和模型候选、彼此之间按 normalizePhraseKey 去重，
   * 最多 LOCAL_PHRASES_MAX 条。每一条都过 validateSuggestionText。只读本机会话，
   * 从不发给模型，也不进入 offeredTexts（那份列表会告诉模型“已经给过什么”）。
   * @param {object} request
   * @param {string[]} modelTexts - 同一条结果里模型给出的候选。
   * @returns {Promise<{text: string, source: string}[]>}
   */
  async function localPhrases(request, modelTexts) {
    const config = effective.config
    const taken = new Set(modelTexts.map((text) => normalizePhraseKey(text)))
    const out = []
    const add = (text, source) => {
      if (out.length >= LOCAL_PHRASES_MAX || typeof text !== 'string') return
      const validated = validateSuggestionText(text, { maxGraphemes: config.maxSuggestionGraphemes })
      if (!validated.ok) return
      const key = normalizePhraseKey(validated.text)
      if (key === '' || taken.has(key)) return
      taken.add(key)
      out.push({ text: validated.text, source })
    }
    if (config.habitSuggestions === true && typeof contextReader.habitPhrases === 'function') {
      let habits = []
      try {
        habits = await contextReader.habitPhrases(request.anchor, {
          maxGraphemes: config.maxSuggestionGraphemes,
          minCount: config.habitMinCount,
          maxPhrases: LOCAL_PHRASES_MAX,
        })
      } catch {
        habits = []
      }
      for (const text of Array.isArray(habits) ? habits : []) add(text, SOURCE_HABIT)
    }
    for (const text of Array.isArray(config.pinnedPhrases) ? config.pinnedPhrases : []) add(text, SOURCE_PINNED)
    return out
  }

  /**
   * 手动预测、模型没有给出建议时的回退：只含本机短语的 offer（`fallback: true`，
   * `text` 是第一条短语）。没有短语时返回 null，照原样回答“没有建议”。
   * 这里不调用模型、不碰账本，所以不占用次数也不计入每日额度。
   */
  async function localFallback(request, result, staleReason) {
    if (request.trigger !== 'manual' || !fallbackEligible(result)) return null
    const local = await localPhrases(request, [])
    if (local.length === 0 || staleReason() !== '') return null
    diagnostics.count('localFallbacks')
    diagnostics.record('local-fallback', { phrases: local.length, modelResult: result.kind, reason: result.reason })
    return {
      kind: RESULT_OFFER,
      suggestionId: randomId(),
      text: local[0].text,
      expiresAt: now() + OFFER_TTL_MS,
      local,
      fallback: true,
      // Why the model gave nothing (for the results log; the page may ignore it).
      modelReason: typeof result.reason === 'string' ? result.reason : '',
    }
  }

  /**
   * 生产任务主体：权威上下文 → 预算/派发账本 → 辅助模型 → 解析。
   * 返回 {kind:'offer',text,meta} | {kind:'abstain',reason} | {kind:'unavailable',reason}。
   * `spend.called` 在真正向模型（或离线测试建议）发出调用时置为 true；调用没有发出
   * （流开始前就失败）时再置回 false。调用方据此决定这一次是否占用本回合的预测机会。
   */
  async function runProduction(request, signal, verification, staleReason, setMeta, spend) {
    const config = effective.config
    const dispatchKey = dispatchKeyFor(request)
    const invalidated = () => signal.aborted ? 'cancelled' : staleReason()
    let reason = invalidated()
    if (reason) return { kind: RESULT_STALE, reason }
    // B01: 补发窗口以 Host 观察到的 turn/end 时间为准（与客户端缓存无关）。
    // 手动触发不受这个窗口限制：用户可以回到一个较早结束的回合主动要一条建议。
    if (request.trigger !== 'manual' && verification !== null && verification !== undefined && typeof verification.completedAt === 'number' && verification.completedAt > 0) {
      const windowMs = Number.isFinite(config.autoWindowMinutes) && config.autoWindowMinutes > 0 ? config.autoWindowMinutes * 60 * 1000 : COMPLETION_RESEND_WINDOW_MS
      if (now() - verification.completedAt > windowMs) {
        diagnostics.count('stale')
        diagnostics.record('stale', { reason: 'completion-too-old' })
        return { kind: RESULT_STALE, reason: 'completion-too-old' }
      }
    }
    diagnostics.count('attempts')
    if (ledger !== null) {
      const already = ledger.hasDispatch(dispatchKey)
      if (already) {
        diagnostics.count('duplicateDispatches')
        return { kind: 'abstain', reason: 'already-dispatched' }
      }
    }
    // 第一条建议总是来自模型：常说的话和固定短语不再代替模型调用，而是在结果
    // 出来之后作为本机短语接在模型候选后面（见 localPhrases / localFallback）。
    if (isFixedTestMode(config)) {
      // 离线测试建议代替模型：按一次调用计，和真实模型路径一样占用本回合的次数。
      spend.called = true
      diagnostics.count('providerCalls')
      const fixedStarted = Date.now()
      const fixed = await produceFixedSuggestion({ config, now: now(), signal })
      if (fixed.kind === 'offer') {
        diagnostics.count('offers')
        setMeta({ route: { provider: FIXED_TEST_PROVIDER }, latencyMs: Date.now() - fixedStarted })
        return { kind: 'offer', text: fixed.text, meta: { provider: FIXED_TEST_PROVIDER } }
      }
      diagnostics.count('abstains')
      if (fixed.reason === 'cancelled') return { kind: 'unavailable', reason: 'cancelled' }
      return fixed
    }
    const started = Date.now()
    // 1) 权威上下文。
    const context = await contextReader.read(request.anchor, config, verification)
    reason = invalidated()
    if (reason) return { kind: RESULT_STALE, reason }
    if (context.ok !== true) {
      diagnostics.count('contextFailures')
      diagnostics.record('context-abstain', { reason: context.reason })
      return { kind: 'abstain', reason: context.reason }
    }
    diagnostics.count('contextBuilds')
    diagnostics.record('context-built', {
      source: context.source,
      messages: context.messages.length,
      codePoints: context.codePoints,
      estimatedTokens: context.estimatedTokens,
      truncated: context.truncated,
      hardCapped: context.hardCapped === true ? true : undefined,
      overBudget: context.overBudget === true ? true : undefined,
      redactions: context.redactions,
    })
    // 2) 路由 + 预算预留（先写盘再调用模型）。
    const route = modelProvider.resolveRoute(config, context.modelSelection)
    if (route.ok !== true) {
      diagnostics.count('unavailable')
      return { kind: 'unavailable', reason: route.reason }
    }
    // 多条候选：一次调用要最多 3 条，输出预算相应放宽（三条各 40 字约 150 token）。
    // 只用于手动触发（第一次手动和“换一条”）。自动预测保持单条：真实模型对照里，
    // 多条格式让模型几乎不再弃权（30 个样本里给出建议的从 18 个变成 27 个），
    // 准确度没有提高，会把“没把握就沉默”这一点抹掉（eval/candidates-eval.json）。
    const candidateCount = config.multiCandidates === true && request.trigger === 'manual' ? candidateLimit(config) : 1
    const callConfig = candidateCount > 1
      ? { ...config, maxOutputTokens: Math.max(Number(config.maxOutputTokens) || 0, MULTI_CANDIDATE_OUTPUT_TOKENS, candidateCount * OUTPUT_TOKENS_PER_CANDIDATE) }
      : config
    // “换一条”：把这一回合已经给过的建议列给模型，要求换一个方向。
    const earlier = request.trigger === 'manual' ? offeredTexts.get(turnKeyFor(request)) ?? [] : []
    // 手动触发（包括第一次）都追加说明：用户主动要，就尽量给，不要沉默。
    const input = request.trigger === 'manual' ? `${context.input}${buildManualSuffix(earlier)}` : context.input
    const system = buildSystemPrompt({ candidates: candidateCount })
    // 预留按真正要发送的内容估算：手动预测追加的说明和多条候选的提示词也算在内
    // （上下文的估算只含单条提示词和对话片段，是裁剪用的）。
    const estimate = {
      inputTokens: Math.max(Number(context.estimatedTokens) || 0, estimateTokens(system) + estimateTokens(input) + 24),
      maxOutputTokens: Math.max(1, Number(callConfig.maxOutputTokens) || 256),
    }
    let reservation
    if (ledger !== null) {
      const reserve = await ledger.reserve({
        dispatchKey,
        estimate,
        trigger: request.trigger,
        // 本回合的调用次数和派发标记、预留在同一次写盘里记下，重启后仍然有效。
        turnKey: turnKeyFor(request),
        manualLimit: config.manualLimit,
        provider: route.provider,
        model: route.model,
        configRevision: revision,
      })
      if (reserve.ok !== true) {
        if (reserve.reason === 'turn-limit') {
          // 持久记录显示这一回合的次数已经用完（例如插件重启前用掉的）。
          diagnostics.count('stale')
          return { kind: RESULT_STALE, reason: 'already-requested' }
        }
        diagnostics.count('ledgerFailures')
        if (reserve.reason === 'already-dispatched') return { kind: 'abstain', reason: 'already-dispatched' }
        diagnostics.record('reserve-failed', { reason: reserve.reason })
        if (reserve.reason === 'daily-request-limit' || reserve.reason === 'daily-token-budget') {
          return { kind: 'unavailable', reason: reserve.reason, retryAfterMs: 60000 }
        }
        // 账本没写成（磁盘满、文件被占用）：没有调用模型，这次机会不算用掉（spend.called 仍为 false）。
        return { kind: 'unavailable', reason: reserve.reason }
      }
      diagnostics.count('reservations')
      reservation = reserve
    }
    reason = invalidated()
    if (reason) {
      if (reservation) await ledger.settle({ ...reservation, dispatchKey, notDispatched: true }).catch(() => {})
      return { kind: RESULT_STALE, reason }
    }
    // 3) 一次辅助模型调用（超时由 AbortSignal.timeout 叠加；不重试）。
    const timeoutSignal = typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(config.timeoutMs) : undefined
    const combinedSignal = signal === undefined || signal === null
      ? timeoutSignal
      : timeoutSignal === undefined
        ? signal
        : AbortSignal.any([signal, timeoutSignal])
    diagnostics.count('providerCalls')
    lastRoute = route
    spend.called = true
    let outcome
    try {
      outcome = await modelProvider.produce({
        system,
        input,
        config: callConfig,
        route,
        signal: combinedSignal,
      })
    } catch {
      outcome = { kind: 'unavailable', reason: 'provider-threw', finishKind: 'threw' }
    }
    // 流开始之前就失败（服务不可用、路由准备失败、已取消）：什么都没发给服务商，
    // 预留整笔退回、派发标记撤销，这次机会也还给本回合。其余情况按已知的用量结算，
    // 缺的部分估算（budget-ledger 的 chargeForCall），不当作零成本。
    const neverDispatched = outcome.dispatched === false
    if (neverDispatched) spend.called = false
    if (reservation) {
      await ledger.settle(neverDispatched
        ? { ...reservation, dispatchKey, notDispatched: true }
        : {
            ...reservation,
            dispatchKey,
            usage: outcome.usage,
            partialUsage: outcome.partialUsage,
            finishKind: finishKindOf(outcome),
            observedOutputTokens: typeof outcome.observedOutputTokens === 'number'
              ? outcome.observedOutputTokens
              : typeof outcome.text === 'string' && outcome.text !== '' ? estimateTokens(outcome.text) : 0,
            reasoningRuledOut: typeof outcome.effort === 'string' && NO_REASONING_EFFORTS.has(outcome.effort),
            markUnknown: outcome.usage == null,
          },
      ).catch(() => {})
    }
    if (!neverDispatched) countUsage(outcome.usage)
    reason = invalidated()
    if (reason) return { kind: RESULT_STALE, reason }
    const elapsedMs = Date.now() - started
    setMeta({
      // A call that ended without naming its route (timeout, error) still went to
      // the resolved one; the results log needs it to count the call's latency.
      route: outcome.route !== undefined && outcome.route !== null
        ? { provider: outcome.route.provider, model: outcome.route.model }
        : neverDispatched ? undefined : { provider: route.provider, model: route.model },
      usage: outcome.usage ?? null,
      latencyMs: elapsedMs,
    })
    if (outcome.kind === 'raw') {
      lastRoute = { ...route, reasoningEffort: outcome.effort }
      diagnostics.record('model-finished', {
        finish: outcome.finishKind,
        elapsedMs,
        provider: outcome.route.provider,
        model: outcome.route.model,
        effort: outcome.effort ?? 'default',
        usage: outcome.usage === undefined ? 'unknown' : 'reported',
      })
      // 单条和多条共用一个解析：单条时最多取 1 条，行为与原来一致。
      const parsed = parseCandidatesJson(outcome.text, { maxGraphemes: config.maxSuggestionGraphemes, maxCandidates: candidateCount })
      if (parsed.ok !== true) {
        diagnostics.count('outputRejects')
        diagnostics.record('output-reject', { reason: parsed.reason })
        return { kind: 'abstain', reason: `output-${parsed.reason}` }
      }
      if (parsed.suggestions.length === 0) {
        diagnostics.record('model-abstained', { elapsedMs })
        return { kind: 'abstain', reason: 'model-abstained' }
      }
      // O03: 严格 JSON 之后再做保守语义过滤；每一条单独判断，命中的那条丢弃。
      const finalAssistantText = context.messages.length > 0 && context.messages[context.messages.length - 1].role === 'assistant'
        ? context.messages[context.messages.length - 1].text
        : ''
      let firstViolation = null
      const passed = []
      for (const candidate of parsed.suggestions) {
        const violation = semanticViolation(candidate, finalAssistantText)
        if (violation !== null) {
          if (firstViolation === null) firstViolation = violation
          continue
        }
        passed.push(candidate)
      }
      if (passed.length === 0) {
        diagnostics.count('outputRejects')
        diagnostics.record('output-reject', { reason: `semantic-${firstViolation}` })
        return { kind: 'abstain', reason: `semantic-${firstViolation}` }
      }
      // 明确的“换一条”（第 2、3 次手动）只保留没给过的；全都给过就当作没有新建议。
      // 第一次手动不这样处理：之前那条可能是自动预测出来、用户根本没看到的。
      const fresh = request.attempt > 0 ? passed.filter((candidate) => !earlier.includes(candidate)) : passed
      if (fresh.length === 0) {
        diagnostics.record('model-abstained', { elapsedMs, reason: 'repeated' })
        return { kind: 'abstain', reason: 'repeated-suggestion' }
      }
      diagnostics.count('offers')
      return {
        kind: 'offer',
        text: fresh[0],
        alternatives: fresh.slice(1),
        meta: { provider: outcome.route.provider, model: outcome.route.model, effort: outcome.effort, elapsedMs },
      }
    }
    if (outcome.kind === 'abstain') {
      diagnostics.count('abstains')
      diagnostics.record('model-abstain', { reason: outcome.reason, elapsedMs })
      return { kind: 'abstain', reason: outcome.reason }
    }
    diagnostics.count('unavailable')
    diagnostics.record('model-unavailable', { reason: outcome.reason, elapsedMs })
    return { kind: 'unavailable', reason: outcome.reason }
  }

  /** 把生产任务结果落成协议 result（offer 需要 suggestionId/expiresAt）。 */
  function materialize(outcome) {
    if (outcome.kind === 'offer') {
      const alternatives = Array.isArray(outcome.alternatives) ? outcome.alternatives.filter((text) => typeof text === 'string' && text !== '' && text !== outcome.text) : []
      return {
        kind: RESULT_OFFER,
        suggestionId: randomId(),
        text: outcome.text,
        expiresAt: now() + OFFER_TTL_MS,
        ...(alternatives.length > 0 ? { alternatives } : {}),
      }
    }
    if (outcome.kind === 'unavailable') {
      return {
        kind: RESULT_UNAVAILABLE,
        reason: outcome.reason || 'unavailable',
        ...(typeof outcome.retryAfterMs === 'number' ? { retryAfterMs: outcome.retryAfterMs } : {}),
      }
    }
    return { kind: outcome.kind === RESULT_STALE ? RESULT_STALE : RESULT_ABSTAIN, reason: outcome.reason || 'abstained' }
  }

  /**
   * O01：每次请求写一行结果记录（不含正文）。失败只影响观测，不影响预测。
   * @param {{cached?: boolean}} [extra] - cached：结果来自缓存，这次请求没有经过生产任务。
   */
  function recordResult(result, request, dispatchKey, startedAt, meta, extra) {
    if (results === null) return
    const isOffer = result.kind === RESULT_OFFER
    const fallback = isOffer && result.fallback === true
    const suggestionId = isOffer && typeof result.suggestionId === 'string' ? result.suggestionId : ''
    if (suggestionId !== '' && !fallback) suggestionDispatches.set(suggestionId, dispatchKey)
    try {
      void results.recordRequest({
        requestId: request.requestId,
        suggestionId,
        sessionId: request.anchor.sessionId,
        turnKey: turnKeyFor(request),
        trigger: request.trigger,
        outcome: isOffer ? 'offer' : result.kind,
        // A fallback offer keeps why the model gave nothing.
        reason: fallback ? (typeof result.modelReason === 'string' ? result.modelReason : '') : typeof result.reason === 'string' ? result.reason : '',
        // Model candidates and local phrases are kept apart: only the former are scored as the model's.
        text: isOffer && !fallback ? result.text : undefined,
        alternatives: isOffer && !fallback && Array.isArray(result.alternatives) ? result.alternatives : undefined,
        local: isOffer && Array.isArray(result.local) ? result.local : undefined,
        fallback,
        cached: extra?.cached === true,
        route: meta?.route,
        latencyMs: meta?.latencyMs ?? Math.max(0, Date.now() - startedAt),
        usage: meta?.usage ?? undefined,
        suggestionGraphemes: isOffer && !fallback && typeof result.text === 'string' ? Array.from(result.text).length : undefined,
      })
    } catch {
      /* 记录失败静默 */
    }
  }

  async function handlePredict(raw, signal) {
    pruneRequestMemory()
    const validation = validatePredictRequest(raw)
    if (!validation.ok) {
      diagnostics.count('requestsRejected')
      diagnostics.record('reject', { reason: 'bad-request' })
      return { status: 400, body: { ok: false, error: { code: 'bad-request', message: validation.error } } }
    }
    const request = validation.request
    // 后台重启后，窗口不知道这一回合之前手动预测过几次，会从第 0 次重新数；
    // 但持久账本还记得，原样处理会回一个“已预测过”，用户白按一次。
    // 账本记得、内存里又没有对应结果或进行中的任务时，顺延到下一个没用过的次数。
    if (request.trigger === 'manual' && ledger !== null) {
      while (
        request.attempt < 9 &&
        cachedOffer(cacheKeyFor(request)) === undefined &&
        registry.findProduction(cacheKeyFor(request)) === undefined &&
        ledger.hasDispatch(dispatchKeyFor(request))
      ) {
        request.attempt += 1
      }
    }
    const requestStartedAt = Date.now()
    diagnostics.count('requestsReceived')
    const dispatchKey = dispatchKeyFor(request)
    /** 这条请求实际等到的那个生产任务的计量信息；没有经过生产任务时为空。 */
    let meta
    const respond = (result, extra) => {
      recordResult(result, request, dispatchKey, requestStartedAt, meta, extra)
      const response = predictResponse(request, result)
      if (result.reason !== 'cancelled') remember(request.requestId, response)
      return { status: 200, body: response }
    }
    if (!effective.config.enabled) {
      diagnostics.count('unavailable')
      return respond({ kind: RESULT_UNAVAILABLE, reason: 'disabled' })
    }
    if (request.expectedConfigRevision !== undefined && request.expectedConfigRevision !== revision) {
      diagnostics.count('stale')
      diagnostics.record('stale', { reason: 'config-changed' })
      return respond({ kind: RESULT_STALE, reason: 'config-changed' })
    }
    const isReleased = () => signal?.aborted || releasedRequests.has(request.requestId)
    if (isReleased()) return respond({ kind: RESULT_UNAVAILABLE, reason: 'cancelled' })
    const requestRevision = revision
    const verification = await contextReader.verifyAnchor(request.anchor)
    if (!verification.ok) {
      diagnostics.count('stale')
      diagnostics.record('stale', { reason: verification.reason })
      return respond({ kind: RESULT_STALE, reason: verification.reason })
    }
    const turnKey = turnKeyFor(request)
    const staleReason = () => {
      if (disposed || !effective.config.enabled || requestRevision !== revision) return 'config-changed'
      if (!verification.isCurrent()) return 'stale-context'
      // 按过 Esc 的回合不再自动预测；用户主动按 Alt+\ 仍然可以。
      if (request.trigger !== 'manual' && dismissedTurns.has(turnKey)) return 'turn-dismissed'
      return ''
    }
    const before = staleReason()
    if (before) return respond({ kind: RESULT_STALE, reason: before })
    if (isReleased()) return respond({ kind: RESULT_UNAVAILABLE, reason: 'cancelled' })
    const cacheKey = cacheKeyFor(request)
    const remembered = requestMemory.get(request.requestId)?.response
    if (remembered?.configRevision === revision) {
      const oldAnchor = remembered.anchor
      if (
        oldAnchor.sessionId !== request.anchor.sessionId || oldAnchor.completedEventSeq !== request.anchor.completedEventSeq ||
        oldAnchor.turnId !== request.anchor.turnId || oldAnchor.branchEpoch !== request.anchor.branchEpoch ||
        oldAnchor.contextRevision !== request.anchor.contextRevision
      ) return operationError(OPERATION_PREDICT, 'request-id-reused', 'request id already belongs to a different anchor', 400)
      if (remembered.result.kind === RESULT_OFFER && acceptedIds.has(remembered.result.suggestionId)) {
        return respond({ kind: RESULT_STALE, reason: 'turn-accepted' })
      }
      return { status: 200, body: remembered }
    }
    const cached = cachedOffer(cacheKey)
    if (cached !== undefined) {
      if (acceptedIds.has(cached.suggestionId)) return respond({ kind: RESULT_STALE, reason: 'turn-accepted' })
      diagnostics.count('cacheHits')
      diagnostics.record('offer', { trigger: request.trigger, source: 'cache' })
      return respond(cached, { cached: true })
    }
    let production = registry.findProduction(cacheKey)
    if (production === undefined) {
      // 内存里的次数管本进程（含进行中的任务）；账本里的次数在插件重启后仍然有效
      // （保存设置就会重启插件）。两者取更严的一个；账本在预留时还会再核对一次。
      const persistedCredit = ledger === null || typeof ledger.turnCredit !== 'function' ||
        ledger.turnCredit(turnKey, request.trigger, effective.config.manualLimit)
      if (!persistedCredit || !registry.hasCredit(turnKey, request.trigger, effective.config.manualLimit)) {
        diagnostics.count('stale')
        const refused = { kind: RESULT_STALE, reason: 'already-requested' }
        // The user asked, the model will not be called again on this reply: their own phrases still can be offered.
        const fallback = await localFallback(request, refused, staleReason)
        if (isReleased()) return respond({ kind: RESULT_UNAVAILABLE, reason: 'cancelled' })
        return respond(fallback ?? refused)
      }
      if (registry.activeCount() >= 1) {
        diagnostics.count('unavailable')
        return respond({ kind: RESULT_UNAVAILABLE, reason: 'busy', retryAfterMs: 500 })
      }
      registry.consumeCredit(turnKey, request.trigger)
      diagnostics.count('productionTasks')
      diagnostics.record('production-start', {
        trigger: request.trigger,
        turnId: request.anchor.turnId,
        completedEventSeq: request.anchor.completedEventSeq,
      })
      production = registry.startProduction(cacheKey, async (productionSignal) => {
        const spend = { called: false }
        let outcome
        try {
          outcome = await runProduction(request, productionSignal, verification, staleReason, (value) => productionMeta.set(cacheKey, value), spend)
        } finally {
          // 没有调用模型就结束的任务不占用本回合的预测机会：上下文读取失败、路由
          // 不可用、账本没写成、每日额度已满、回合在调用前过期或被取消、调用在流开始
          // 前失败，以及意外抛错，都把内存里的次数退回。账本里的回合次数只在预留成功
          // 时增加，调用没有发出时由 settle(notDispatched) 减回，两层保持一致。
          if (!spend.called) registry.refundCredit(turnKey, request.trigger)
        }
        const reason = staleReason()
        if (reason) return { kind: RESULT_STALE, reason }
        if (productionSignal.aborted) return { kind: RESULT_UNAVAILABLE, reason: 'cancelled' }
        let result = materialize(outcome)
        if (result.kind === RESULT_OFFER) {
          // The user's own phrases go behind the model's candidates.
          const local = await localPhrases(request, [result.text, ...(result.alternatives ?? [])])
          const after = staleReason()
          if (after) return { kind: RESULT_STALE, reason: after }
          if (productionSignal.aborted) return { kind: RESULT_UNAVAILABLE, reason: 'cancelled' }
          if (local.length > 0) result = { ...result, local }
          // Only model candidates are remembered for "another one": the model is told
          // what it already said, never the user's phrases.
          const earlier = offeredTexts.get(turnKey) ?? []
          const added = [result.text, ...(result.alternatives ?? [])].filter((text) => !earlier.includes(text))
          if (added.length > 0) offeredTexts.set(turnKey, [...earlier, ...added].slice(-9))
        } else {
          const fallback = await localFallback(request, result, staleReason)
          if (productionSignal.aborted) return { kind: RESULT_UNAVAILABLE, reason: 'cancelled' }
          if (fallback !== null) result = fallback
        }
        if (result.kind === RESULT_OFFER) cacheOffer(cacheKey, result)
        return result
      })
    }
    const result = await registry.attach(production, request.requestId, signal)
    meta = productionMeta.get(cacheKey)
    if (isReleased()) return respond({ kind: RESULT_UNAVAILABLE, reason: 'cancelled' })
    const after = staleReason()
    return respond(after ? { kind: RESULT_STALE, reason: after } : result)
  }

  async function handle(body, signal) {
    if (disposed) return operationError('unknown', 'disposed', 'plugin is not active')
    if (!isPlainObject(body)) {
      return { status: 400, body: { ok: false, error: { code: 'bad-body', message: 'body must be a JSON object' } } }
    }
    const operation = typeof body.operation === 'string' ? body.operation : ''
    try {
      return await dispatch(operation, body, signal)
    } catch (error) {
      // 任何依赖抛错都回一个可解析的 JSON 错误；不让宿主把它变成“400 + 空响应体”。
      const message = error instanceof Error ? error.message : String(error)
      diagnostics.count('requestsRejected')
      diagnostics.record('internal-error', { operation: operation === '' ? 'unknown' : operation, reason: message.slice(0, 120) })
      return operationError(operation === '' ? 'unknown' : operation, 'internal-error', 'the plugin failed to handle this request', 500)
    }
  }

  async function dispatch(operation, body, signal) {
    switch (operation) {
      case OPERATION_PREDICT:
        return handlePredict(body, signal)
      case OPERATION_RELEASE:
        return handleRelease(body)
      case OPERATION_DISMISS:
        return handleDismiss(body)
      case OPERATION_ACCEPTED:
        return handleAccepted(body)
      case OPERATION_OUTCOME:
        return handleOutcome(body)
      case OPERATION_RESULTS:
        return handleResults()
      case OPERATION_STATUS:
        return operationResult(operation, statusValue())
      case OPERATION_CONFIG_GET:
        return operationResult(operation, { ...currentConfigStatus(), restarted: false })
      case OPERATION_CONFIG_SET:
        return handleConfigSet(body)
      default:
        diagnostics.count('requestsRejected')
        return operationError(operation === '' ? 'unknown' : operation, 'unknown-operation', 'unsupported operation', 400)
    }
  }

  function handleRelease(body) {
    const requestId = typeof body.requestId === 'string' ? body.requestId : ''
    if (requestId === '') return operationError(OPERATION_RELEASE, 'bad-request', 'requestId is required', 400)
    releasedRequests.add(requestId)
    if (releasedRequests.size > MAX_REQUEST_MEMORY) releasedRequests.delete(releasedRequests.values().next().value)
    const aborted = registry.release(requestId)
    diagnostics.count('releases')
    if (aborted) diagnostics.record('production-abort', { reason: 'last-waiter-left' })
    return operationResult(OPERATION_RELEASE, { released: true, aborted })
  }

  function handleDismiss(body) {
    const suggestionId = typeof body.suggestionId === 'string' ? body.suggestionId : ''
    if (suggestionId === '') return operationError(OPERATION_DISMISS, 'bad-request', 'suggestionId is required', 400)
    dismissedIds.add(suggestionId)
    if (typeof body.turnKey === 'string' && body.turnKey !== '') dismissedTurns.add(body.turnKey)
    if (results !== null) void results.recordOutcome(suggestionId, 'dismissed').catch(() => {})
    diagnostics.count('dismisses')
    return operationResult(OPERATION_DISMISS, { dismissed: true })
  }

  function handleAccepted(body) {
    const suggestionId = typeof body.suggestionId === 'string' ? body.suggestionId : ''
    if (suggestionId === '') return operationError(OPERATION_ACCEPTED, 'bad-request', 'suggestionId is required', 400)
    acceptedIds.add(suggestionId)
    // Which ring entry was taken (index, and the source the page saw). A page
    // older than this Host sends neither; the results log then assumes the first entry.
    const choice = acceptedChoice(body)
    if (results !== null) void Promise.resolve(results.recordOutcome(suggestionId, 'accepted', '', choice)).catch(() => {})
    diagnostics.count('accepts')
    return operationResult(OPERATION_ACCEPTED, { accepted: true })
  }

  /** O01 + B05：客户端回报展示/覆盖/过期/关闭；展示后账本标记 shown。 */
  function handleOutcome(body) {
    const suggestionId = typeof body.suggestionId === 'string' ? body.suggestionId : ''
    const event = typeof body.event === 'string' ? body.event : ''
    if (suggestionId === '' || !OUTCOME_EVENTS.has(event)) {
      return operationError(OPERATION_OUTCOME, 'bad-request', 'suggestionId and a valid event are required', 400)
    }
    if (results !== null) {
      // “已显示”是一个事实，不是最终去向：分开记录（见 results-log.recordOutcome）。
      const write = event === 'shown' && typeof results.markShown === 'function'
        ? results.markShown(suggestionId)
        : results.recordOutcome(suggestionId, event)
      void Promise.resolve(write).catch(() => {})
    }
    if (event === 'shown') {
      const dispatchKey = suggestionDispatches.get(suggestionId)
      if (dispatchKey !== undefined && ledger !== null && typeof ledger.markShown === 'function') {
        void Promise.resolve(ledger.markShown(dispatchKey)).catch(() => {})
      }
    }
    return operationResult(OPERATION_OUTCOME, { recorded: true })
  }

  /** O01：近 7 天汇总（展示率/采纳率/未修改率/弃权原因/延迟/token，不含正文）。 */
  async function handleResults() {
    if (results === null || typeof results.summary !== 'function') {
      return operationResult(OPERATION_RESULTS, { available: false, summary: null })
    }
    try {
      return operationResult(OPERATION_RESULTS, { available: true, summary: await results.summary(7) })
    } catch (error) {
      diagnostics.record('results-failed', { reason: error instanceof Error ? error.message.slice(0, 80) : 'summary-failed' })
      return operationResult(OPERATION_RESULTS, { available: false, summary: null })
    }
  }

  async function handleConfigSet(body) {
    const sanitized = sanitizeConfigPatch(body.patch)
    if (!sanitized.ok) {
      diagnostics.count('requestsRejected')
      return operationError(OPERATION_CONFIG_SET, 'invalid-config', sanitized.error, 400)
    }
    diagnostics.record('config-write', { fields: Object.keys(sanitized.patch).join(',') })
    if (adapter.configEditorAvailable !== true) {
      return operationError(OPERATION_CONFIG_SET, 'config-editor-unavailable', 'this composition cannot persist plugin config')
    }
    const persisted = await adapter.persistConfig(sanitized.patch)
    if (!persisted.ok) {
      diagnostics.record('config-write-failed', { reason: persisted.error })
      return operationError(OPERATION_CONFIG_SET, 'config-write-failed', persisted.error)
    }
    const candidate = normalizeConfig(persisted.config)
    const nextRevision = configRevision(candidate.config)
    if (nextRevision !== revision) lastRoute = null
    effective = candidate
    revision = nextRevision
    configErrors = [...candidate.errors]
    // 宿主若没有重启本插件（配置写入通常会重启），预算上限与时区也要跟着新配置走。
    if (typeof options.onConfigChange === 'function') {
      try {
        options.onConfigChange(effective.config)
      } catch {
        /* 观察者失败不影响配置写入 */
      }
    }
    return operationResult(OPERATION_CONFIG_SET, { ...currentConfigStatus(), restarted: persisted.restarted === true })
  }

  function statusValue() {
    const capabilities = typeof adapter.capabilities === 'function'
      ? adapter.capabilities()
      : { connectionFetch: adapter.connectionAvailable, configEditor: adapter.configEditorAvailable }
    let route = null
    try {
      if (modelProvider !== null && !isFixedTestMode(effective.config)) {
        const resolved = lastRoute ?? modelProvider.previewRoute(effective.config)
        route = resolved.ok === true
          ? { provider: resolved.provider, model: resolved.model, source: resolved.source, reasoningEffort: resolved.reasoningEffort ?? '' }
          : { error: resolved.reason }
      }
    } catch {
      route = { error: 'route-unavailable' }
    }
    return {
      ...currentConfigStatus(),
      // The page compares this with its own bundle version (restart pending?).
      version: PLUGIN_VERSION,
      enabled: effective.config.enabled,
      mode: providerMode(effective.config),
      route,
      modelMode: effective.config.modelMode,
      promptVersion: PROMPT_VERSION,
      capabilities,
      budget: ledger !== null && typeof ledger.snapshot === 'function' ? ledger.snapshot() : null,
      diagnostics: diagnostics.snapshot(),
      offerTtlMs: OFFER_TTL_MS,
      inflight: registry.activeCount(),
      dismissed: dismissedIds.size,
      accepted: acceptedIds.size,
    }
  }

  function dispose() {
    disposed = true
    registry.dispose()
    diagnostics.record('service-dispose')
  }

  return { handle, statusValue, dispose, get revision() { return revision } }
}

/**
 * 模型调用是怎样结束的（结算用）：走到 finish 时是 finish 的种类，流中途抛错是
 * 'threw'，没有任何说明时按 'missing'（没有走到 finish，保守处理）。
 */
function finishKindOf(outcome) {
  if (typeof outcome?.finishKind === 'string' && outcome.finishKind !== '') return outcome.finishKind
  if (outcome?.kind === 'raw') return 'stop'
  const match = typeof outcome?.reason === 'string' ? /^finish-([a-z-]+)/.exec(outcome.reason) : null
  return match !== null ? match[1] : 'missing'
}

function defaultRandomId() {
  try {
    if (typeof crypto === 'object' && crypto !== null && typeof crypto.randomUUID === 'function') {
      return `nmp-${crypto.randomUUID()}`
    }
  } catch {
    /* fall through */
  }
  return `nmp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}
