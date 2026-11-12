// Host half entry for dsh-next-message-predictor (DSH 0.2.2-rc.1).
//
// 生产路径：
//   configEditor/loader config → 复核 turn/end 和权威会话上下文
//   → 预算预留与派发账本写盘 → ctx.llm.stream 一次辅助调用（不重试）
//   → 严格 JSON 解析与输出校验 → offer/abstain。
//
// 显式测试路径（P1 回归/离线）：`modelMode:'fixed'` 且 `provider:'fixed-test'` 时
// 使用配置中的固定测试建议，不调用模型、不读上下文。
//
// 不导出 Config schema 的原因见 docs/COMPATIBILITY.md §5（linked 插件无法解析
// schemastery/zod；P4 再引入 volatile Config）。设置写入走 configEditor.edit。

import { homedir } from 'node:os'
import { join } from 'node:path'

import { CONFIG_SET_MIN_BODY_BYTES, normalizeConfig } from '../shared/config.js'
import { PLUGIN_VERSION } from '../shared/version.js'
import { createHostAdapter } from './dsh-adapter.js'
import { createSessionContextReader, textOfContent } from './context-builder.js'
import { createModelProvider } from './model-provider.js'
import { createPersistentLedger } from './budget-ledger.js'
import { createResultsLog } from './results-log.js'
import { createPredictorService } from './predictor-service.js'

/**
 * Required host service: the browser HTTP carrier. Declaring it makes the
 * loader wait for `ctx.connection` (and its `fetch` face) before `apply`.
 * The loader unwraps `exports.default ?? exports`, so the default object at the
 * bottom of this file must carry the same `apply`/`inject` surface.
 */
export const inject = ['connection']

/** 解析 DSH home（与宿主一致：优先 DSH_HOME，否则 ~/.dsh）。 */
function resolveHomeDir() {
  const env = typeof process === 'object' && process !== null && typeof process.env === 'object' ? process.env : {}
  // 测试环境（tools/launch-scratch-web.ps1）用 NMP_DATA_HOME 把账本和结果记录
  // 写到独立目录，避免 mock 流量混进真实的“近 7 天效果”和每日预算。
  if (typeof env.NMP_DATA_HOME === 'string' && env.NMP_DATA_HOME !== '') return env.NMP_DATA_HOME
  const fromEnv = env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv !== '') return fromEnv
  return join(homedir(), '.dsh')
}

/**
 * Cordis plugin entry.
 * @param {object} ctx - plugin fiber context.
 * @param {object} [rawConfig] - loader row config.
 */
export function apply(ctx, rawConfig) {
  const normalized = normalizeConfig(rawConfig)
  if (normalized.errors.length > 0) {
    console.warn(`[next-message-predictor] config problems: ${normalized.errors.join('; ')}`)
  }
  // 生效配置。写入设置通常会让宿主重启本插件（重新 apply）；若宿主没有重启，
  // service 会通过 onConfigChange 把新配置交回来，预算上限与时区随之更新。
  let liveConfig = normalized.config
  const adapter = createHostAdapter(ctx)

  // 只读的权威会话上下文。
  const contextReader = createSessionContextReader({
    getSessionQuery: () => safeGet(ctx, 'sessionQuery'),
    getSession: (sessionId) => {
      const sessions = safeGet(ctx, 'sessions')
      if (sessions === undefined || sessions === null || typeof sessions.get !== 'function') return undefined
      try {
        return sessions.get(sessionId)
      } catch {
        return undefined
      }
    },
  })
  ctx.on('session/event', contextReader.noteEvent)

  // 持久结果记录（O01）：每次请求一行，无正文；用户下一条消息只写匹配分数。
  const resultsLog = createResultsLog({
    homeDir: resolveHomeDir(),
    getTimeZone: () => liveConfig.budgetTimeZone,
    logger: (line) => console.warn(line),
    // 保存设置会让宿主在同一进程里重新 apply 本插件：新旧实例共用待匹配的建议，
    // 屏幕上那条建议的“已显示”、去向和用户下一条消息的匹配分数不会丢失。
    shareWithinProcess: true,
  })
  // 用户发出下一条消息（会话日志里 source.kind 为 user 的 user/message）时，只把匹配
  // 分数写盘。事件的 data 就是消息本身（与 dsh-session-title 读取的形状相同）。
  ctx.on('session/event', (session, event) => {
    try {
      if (event === null || typeof event !== 'object' || event.type !== 'user/message') return
      const data = event.data !== null && typeof event.data === 'object' ? event.data : {}
      const source = data.source !== null && typeof data.source === 'object' ? data.source : {}
      if (source.kind !== 'user') return
      const sessionId = typeof session?.id === 'string' ? session.id : typeof session?.sessionId === 'string' ? session.sessionId : ''
      const text = textOfContent(data.content)
      if (sessionId !== '' && text !== '') resultsLog.noteUserMessage(sessionId, text)
    } catch {
      /* 匹配失败不影响会话 */
    }
  })

  // 默认路由只用于设置页预览，实际调用使用完成回合的模型或固定路由。
  const modelProvider = createModelProvider({
    getLlm: () => safeGet(ctx, 'llm'),
    getDefaultModel: () => {
      const agentDefaultModel = safeGet(ctx, 'agentDefaultModel')
      if (agentDefaultModel === undefined || agentDefaultModel === null || typeof agentDefaultModel.currentSelection !== 'function') {
        return undefined
      }
      try {
        return agentDefaultModel.currentSelection()
      } catch {
        return undefined
      }
    },
    onEvent: (event) => {
      // 只记录原因码/用量类别；不含上下文与建议正文。
      if (event !== null && typeof event === 'object' && typeof event.kind === 'string') {
        console.debug(`[next-message-predictor] ${event.kind} ${JSON.stringify(stripUndefined(event))}`)
      }
    },
  })

  // 持久账本：<DSH_HOME>/next-message-predictor/ledger.json
  const ledger = createPersistentLedger({
    homeDir: resolveHomeDir(),
    getTimeZone: () => liveConfig.budgetTimeZone,
    getLimits: () => ({
      dailyRequestLimit: liveConfig.dailyRequestLimit,
      dailyTokenBudget: liveConfig.dailyTokenBudget,
    }),
    logger: (line) => console.warn(line),
    // 保存设置会让宿主在同一进程里重新 apply 本插件：新旧实例共用一份账本状态，
    // 旧实例还在进行的调用照常结算，不会被新实例当作上一个进程遗留的预留。
    shareWithinProcess: true,
  })

  const service = createPredictorService({
    config: normalized.config,
    configErrors: normalized.errors,
    adapter,
    contextReader,
    modelProvider,
    ledger,
    results: resultsLog,
    onConfigChange: (config) => {
      liveConfig = config
    },
  })

  const route = adapter.registerRoute((body, request) => service.handle(body, request.signal), {
    bodyLimitBytes: normalized.config.requestBodyLimitBytes,
    // A whole pinned-phrase list must always be savable, even at the smallest body limit.
    configSetMinBytes: CONFIG_SET_MIN_BODY_BYTES,
  })
  if (route.ok) {
    ctx.effect(() => route.dispose, 'next-message-predictor: rpc route')
    console.info(
      `[next-message-predictor] host ready v${PLUGIN_VERSION}: route=${route.route} enabled=${normalized.config.enabled} mode=${normalized.config.modelMode === 'fixed' && normalized.config.provider === 'fixed-test' ? 'fixed-test-suggestion' : 'model'} provider_route=${normalized.config.modelMode}`,
    )
  } else {
    console.warn(
      `[next-message-predictor] route unavailable (${route.error}); predictions stay disabled. Compatible Host versions provide ctx.connection.fetch.register.`,
    )
  }

  ctx.effect(
    () => () => {
      service.dispose()
    },
    'next-message-predictor: service',
  )
}

function safeGet(ctx, name) {
  try {
    return typeof ctx.get === 'function' ? ctx.get(name) : undefined
  } catch {
    return undefined
  }
}

function stripUndefined(value) {
  const output = {}
  for (const key of Object.keys(value)) {
    if (value[key] !== undefined) output[key] = value[key]
  }
  return output
}

// loader 归一化规则：`exports = exports.default ?? exports`。named `inject` 必须
// 同时出现在 default 对象里，否则会在 connection service 就绪前 apply。
export default { apply, inject }
