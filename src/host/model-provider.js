// 辅助模型调用（Host）。
//
// 约束（P0 契约 §5 已核实）：
// - `ctx.llm.stream(GenerateOptions)` 直连调用不会自动重试：一次调用 ≈ 一次
//   provider dispatch（方案“自动模型重试 0”）；
// - 不传 `sessionId`/`tools`/`toolHistory`：这不是会话请求，不能触发 checkpoint、
//   标题或工具相关中间件；
// - `reasoningEffort` 只能传模型 `resolveModelInfo().reasoning.efforts` 里的 id；
//   默认取列表首项（参考实现做法）并记录实际值，用户可显式配置；
// - `finish.kind !== 'stop'`（max-tokens/aborted/error）一律弃权，不解析半截输出；
// - usage 可能缺失；取消不视为零成本，由预算层保守处理。
//
// 本模块只依赖注入的 getter，便于单测替换。

import { estimateTokens } from '../shared/prompt.js'

/** 低成本档位偏好（B09f）：优先 off/none/minimal，再退回模型 advertised 首项。 */
const PREFERRED_EFFORTS = ['off', 'none', 'minimal', 'no-thinking', 'disabled', 'low']

/** 判断 prepare 错误是否属于“路由不可用”（O04 才回退会话模型）。 */
function isRouteUnavailableError(message) {
  if (/unsupported-reasoning-effort/i.test(message)) return false
  return /(provider|model|route|not.?configured|not.?found|unknown|no such|invalid)/i.test(message)
}

/**
 * 选择要传的 reasoning effort：显式配置优先且必须被模型支持；否则优先低成本档位。
 *
 * @param {{strict?: boolean}} [options] - strict（默认）：显式配置的档位不被支持时
 *   报错，不静默切换。strict:false 用于“不是用户为它填写档位的那个模型”
 *   （跟随会话模型、固定路由不可用时回退的会话模型）：设置页在这些情况下不显示
 *   档位输入框，默认值 `off` 又不是每个模型都有，报错只会让预测一直不可用，
 *   所以退回自动选择（低成本档位优先）。
 */
export function pickReasoningEffort(modelInfo, configured, options) {
  const efforts = modelInfo !== null && modelInfo !== undefined && modelInfo.reasoning !== undefined && Array.isArray(modelInfo.reasoning.efforts)
    ? modelInfo.reasoning.efforts
    : []
  const ids = efforts
    .map((effort) => (effort !== null && typeof effort === 'object' && typeof effort.id === 'string' ? effort.id : undefined))
    .filter((id) => typeof id === 'string')
  const explicit = typeof configured === 'string' ? configured.trim() : ''
  if (explicit !== '') {
    if (ids.includes(explicit)) return { ok: true, effort: explicit, reason: 'explicit' }
    // 显式配置了不受支持的档位：不静默切换，返回可解释的错误。
    if (options?.strict !== false) return { ok: false, reason: `unsupported-reasoning-effort:${explicit}`, supported: ids }
  }
  if (ids.length > 0) {
    const preferred = PREFERRED_EFFORTS.find((id) => ids.includes(id))
    return { ok: true, effort: preferred ?? ids[0], reason: preferred === undefined ? 'lowest-advertised' : 'preferred-low-cost' }
  }
  return { ok: true, effort: undefined, reason: 'model-default' }
}

/**
 * @param {object} deps
 * @param {() => object | undefined} deps.getLlm
 * @param {() => {provider?: string, model?: string, reasoningEffort?: string} | undefined} deps.getDefaultModel
 * @param {(event: object) => void} [deps.onEvent] - 诊断回调（不含正文）。
 */
export function createModelProvider(deps) {
  const getLlm = deps.getLlm
  const onEvent = typeof deps.onEvent === 'function' ? deps.onEvent : () => {}

  /** 解析路由：跟随当前会话或固定 provider/model。 */
  function resolveRoute(config, selection) {
    if (config.modelMode === 'fixed') {
      const provider = typeof config.provider === 'string' ? config.provider.trim() : ''
      const model = typeof config.model === 'string' ? config.model.trim() : ''
      if (provider === '' || model === '') return { ok: false, reason: 'no-route:fixed-route-incomplete' }
      return { ok: true, provider, model, source: 'fixed' }
    }
    if (typeof selection?.provider !== 'string' || !selection.provider || typeof selection.model !== 'string' || !selection.model) {
      return { ok: false, reason: 'no-route:no-session-selection' }
    }
    return {
      ok: true,
      provider: selection.provider,
      model: selection.model,
      source: 'session',
    }
  }

  function previewRoute(config) {
    const route = resolveRoute(config, config.modelMode === 'session' ? deps.getDefaultModel?.() : undefined)
    return route.ok && route.source === 'session' ? { ...route, source: 'default' } : route
  }

  /**
   * 调用辅助模型。
   * @param {{input: string, config: object, route: object, signal?: AbortSignal}} call
   * @returns {Promise<{kind:'raw', text:string, usage?:object, finishKind:string, route:object, effort?:string, elapsedMs:number}
   *   | {kind:'abstain', reason:string, detail?:string}
   *   | {kind:'unavailable', reason:string, detail?:string}>}
   */
  async function produce(call) {
    const started = Date.now()
    const llm = getLlm()
    // `dispatched: false` on every return before the stream starts: nothing was
    // sent to the provider, so the caller may release the budget reservation.
    if (llm === undefined || llm === null) return { kind: 'unavailable', reason: 'llm-service-unavailable', dispatched: false }
    let route = call.route
    if (!route.ok) return { kind: 'unavailable', reason: route.reason, dispatched: false }
    const maxTokens = Math.max(1, Number(call.config.maxOutputTokens) || 256)
    const signal = call.signal
    if (signal?.aborted) return { kind: 'unavailable', reason: 'cancelled', dispatched: false }
    let prepared
    try {
      prepared = await llm.prepareCall({ provider: route.provider, model: route.model, maxTokens }, signal, (controls, model) => {
        // 档位是为“指定模型”填写的；跟随会话模型时只当作偏好。
        const picked = pickReasoningEffort(model, call.config.reasoningEffort, { strict: route.source === 'fixed' })
        if (picked.ok === false) throw new Error(picked.reason)
        if (picked.effort === undefined) return controls
        return { ...controls, reasoningEffort: picked.effort }
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      onEvent({ kind: 'llm-prepare-failed', reason: message.slice(0, 200) })
      // O04: 固定路由不可用时回退到会话模型（只回退一次，不是模型重试）。
      // 只对“路由不可用”类错误回退；显式配置错误（如不支持的 reasoning effort）直接报告。
      const routeUnavailable = route.source === 'fixed' && isRouteUnavailableError(message)
      if (routeUnavailable) {
        const fallback = deps.getDefaultModel?.()
        if (
          fallback !== undefined && fallback !== null &&
          typeof fallback.provider === 'string' && fallback.provider !== '' &&
          typeof fallback.model === 'string' && fallback.model !== '' &&
          (fallback.provider !== route.provider || fallback.model !== route.model)
        ) {
          onEvent({ kind: 'route-fallback', from: `${route.provider}/${route.model}`, to: `${fallback.provider}/${fallback.model}` })
          try {
            prepared = await llm.prepareCall({ provider: fallback.provider, model: fallback.model, maxTokens }, signal, (controls, model) => {
              const picked = pickReasoningEffort(model, call.config.reasoningEffort, { strict: false })
              if (picked.ok === false) throw new Error(picked.reason)
              if (picked.effort === undefined) return controls
              return { ...controls, reasoningEffort: picked.effort }
            })
            route = { ok: true, provider: fallback.provider, model: fallback.model, source: 'fallback-session' }
          } catch (fallbackError) {
            const fallbackMessage = fallbackError instanceof Error ? fallbackError.message : String(fallbackError)
            return { kind: 'unavailable', reason: `fallback-failed:${fallbackMessage.slice(0, 120)}`, dispatched: false }
          }
        } else {
          return { kind: 'unavailable', reason: `prepare-failed:${message.slice(0, 120)}`, dispatched: false }
        }
      } else {
        return { kind: 'unavailable', reason: `prepare-failed:${message.slice(0, 120)}`, dispatched: false }
      }
    }
    if (signal?.aborted) return { kind: 'unavailable', reason: 'cancelled', dispatched: false }
    if (prepared === null || typeof prepared !== 'object' || typeof prepared.stream !== 'function') {
      return { kind: 'unavailable', reason: 'prepare-failed:no stream', dispatched: false }
    }
    const preparedConfig = prepared.config !== null && typeof prepared.config === 'object' ? prepared.config : {}
    const effort = preparedConfig.reasoningEffort
    onEvent({
      kind: 'llm-dispatch',
      provider: route.provider,
      model: route.model,
      effort: effort ?? 'default',
      maxTokens: preparedConfig.maxTokens ?? maxTokens,
      routeSource: route.source,
    })
    let text = ''
    let usage
    let finishKind = 'missing'
    let failure
    try {
      for await (const chunk of prepared.stream({
        ...preparedConfig,
        system: call.system,
        messages: [{ role: 'user', content: [{ type: 'text', text: call.input }] }],
        signal,
      })) {
        if (chunk === null || typeof chunk !== 'object') continue
        if (chunk.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
        else if (
          chunk.type === 'usage' && chunk.usage &&
          ['inputTokens', 'outputTokens', 'reasoningTokens', 'cacheReadTokens', 'cacheWriteTokens']
            .some((field) => Number.isFinite(chunk.usage[field]) && chunk.usage[field] > 0)
        ) usage = chunk.usage
        else if (chunk.type === 'finish') {
          finishKind = chunk.reason !== null && typeof chunk.reason === 'object' && typeof chunk.reason.kind === 'string'
            ? chunk.reason.kind
            : 'unknown'
          if (chunk.reason !== null && typeof chunk.reason === 'object' && chunk.reason.failure !== undefined) {
            failure = chunk.reason.failure
          }
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      onEvent({ kind: 'llm-threw', reason: message.slice(0, 200) })
      // 流中途断开：已经收到的用量（常见的是先报告的输入 token）和已收到的文字交给
      // 预算层，只估算缺的部分。这份用量不完整，所以不放进 usage。
      return {
        kind: 'unavailable',
        reason: `stream-failed:${message.slice(0, 120)}`,
        finishKind: 'threw',
        ...(usage !== undefined ? { partialUsage: usage } : {}),
        observedOutputTokens: estimateTokens(text),
      }
    }
    const elapsedMs = Date.now() - started
    onEvent({ kind: 'llm-finish', finish: finishKind, elapsedMs, usage: usage === undefined ? 'unknown' : 'reported' })
    if (finishKind !== 'stop') {
      const reasonCode = failure !== undefined && failure !== null && typeof failure.code === 'string' ? failure.code : ''
      return {
        kind: 'abstain',
        reason: `finish-${finishKind}${reasonCode === '' ? '' : `:${reasonCode}`}`,
        usage,
        finishKind,
        observedOutputTokens: estimateTokens(text),
        detail: failure !== undefined && failure !== null && typeof failure.message === 'string' ? failure.message.slice(0, 160) : undefined,
      }
    }
    return { kind: 'raw', text, usage, finishKind, route: { provider: route.provider, model: route.model }, effort, elapsedMs }
  }

  return { produce, resolveRoute, previewRoute, pickReasoningEffort }
}
