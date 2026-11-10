// Browser-side controller for dsh-next-message-predictor.
//
// Owns the per-view state machine (inactive → waiting → requesting → offered →
// accepted/dismissed/suppressed/abstained/failed), the per-turn dedupe, the
// trigger delay, and every ownership check around a response. The React overlay
// is a thin renderer over these stores; the Settings section uses the same
// runtime API so there is exactly one writer.
//
// P1 has no model call. The Host answers from a fixed suggestion; this module
// never sends a draft or triggers a submission.

import {
  DEFAULT_CONFIG,
  OFFER_TTL_MS,
  ROUTE,
  SCHEMA_VERSION,
} from '../shared/config.js'
import {
  OPERATION_ACCEPTED,
  OPERATION_CONFIG_SET,
  OPERATION_DISMISS,
  OPERATION_OUTCOME,
  OPERATION_PREDICT,
  OPERATION_RELEASE,
  OPERATION_RESULTS,
  OPERATION_STATUS,
  validateResponseForClient,
} from '../shared/protocol.js'

/** Tiny observable store with the snapshot identity the renderer needs. */
export function createStore(initial) {
  let state = initial
  const listeners = new Set()
  return {
    getSnapshot: () => state,
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    set(patch) {
      const next = typeof patch === 'function' ? patch(state) : { ...state, ...patch }
      if (next === state) return
      state = next
      for (const listener of listeners) listener()
    },
  }
}

const EMPTY_CONFIG = { ...DEFAULT_CONFIG }

const NO_CANDIDATES = Object.freeze([])

const INITIAL_ASSIST = {
  status: 'idle',
  text: '',
  /** All suggestions from this prediction; `text` is candidates[candidateIndex]. */
  candidates: NO_CANDIDATES,
  candidateIndex: 0,
  suggestionId: '',
  turnKey: '',
  turnId: '',
  sessionId: '',
  completedEventSeq: 0,
  contextRevision: '',
  configRevision: 0,
  offerDraftRev: -1,
  expiresAt: 0,
  reason: '',
  error: '',
}

/**
 * Feedback for a manual trigger, shown in the composer: 'predicting' while the
 * request runs, 'none' when it ended without a suggestion (with the reason).
 * Kept apart from the assist state, which sync() resets freely.
 */
const INITIAL_NOTICE = { kind: '', reason: '', sessionId: '', at: 0 }

const INITIAL_CONFIG_STATE = {
  ready: false,
  config: EMPTY_CONFIG,
  revision: 0,
  configErrors: [],
  capabilities: {},
  diagnostics: null,
  provider: '',
  hostError: '',
  route: null,
  budget: null,
  promptVersion: '',
  mode: '',
  /** Version the Host half reports; '' until known (or from a Host older than 0.3.0). */
  hostVersion: '',
}

/**
 * What the DSH shell offers this page: whether the global panel is registered
 * and whether there is a left sidebar to add the entry to. Written by the
 * client entry, read by Settings.
 */
const INITIAL_SHELL_STATE = { panelAvailable: false, sidebarAvailable: false }

/**
 * @param {object} options
 * @param {(operation: string, payload?: object, signal?: AbortSignal) => Promise<any>} options.rpc
 * @param {() => number} [options.now]
 */
export function createClientRuntime(options) {
  const rpc = options.rpc
  const now = typeof options.now === 'function' ? options.now : Date.now
  const configStore = createStore(INITIAL_CONFIG_STATE)
  const assistStore = createStore(INITIAL_ASSIST)
  const signalsStore = createStore({ composing: false, menuTick: 0 })
  const noticeStore = createStore(INITIAL_NOTICE)
  const shellStore = createStore(INITIAL_SHELL_STATE)
  // A manual request is running: follow the assist state to its end.
  assistStore.subscribe(() => {
    const notice = noticeStore.getSnapshot()
    if (notice.kind !== 'predicting') return
    const state = assistStore.getSnapshot()
    if (state.status === 'requesting' || state.status === 'waiting') return
    if (state.status === 'abstained' || state.status === 'unavailable' || state.status === 'failed') {
      noticeStore.set({ kind: 'none', reason: state.reason, sessionId: notice.sessionId, at: now() })
    } else {
      noticeStore.set(INITIAL_NOTICE)
    }
  })
  /** The composer calls this once a 'none' notice has been on screen long enough. */
  function clearNotice() {
    if (noticeStore.getSnapshot().kind !== '') noticeStore.set(INITIAL_NOTICE)
  }

  let disposed = false
  /** O07: non-empty when another ghost-text plugin owns the composer. */
  let conflictSource = ''
  let latestEnv = null
  let boundSessionId = ''
  const viewId = `nmp-view-${Math.random().toString(36).slice(2, 10)}`
  let sequence = 0
  let timer
  let activeRequest = null
  /** @type {Set<string>} turn keys auto-served this session */
  const servedAuto = new Set()
  /** @type {Map<string, number>} turn key -> manual predictions asked on it (first + "another one") */
  const servedManual = new Map()
  /** @type {Set<string>} user began editing / IME composition on this turn */
  const suppressedTurns = new Set()
  /** @type {Set<string>} user pressed Esc on this turn */
  const dismissedTurns = new Set()
  /** @type {Set<string>} user adopted on this turn */
  const acceptedTurns = new Set()
  /**
   * 完成回合触发锚点。真实模型下 session.running 与 chat 投影的更新不同步：
   * running 可能先变 false，而新 turnId/turnEnds 稍后才到。因此不能用
   * “上一帧 running=true”直接触发，而要等待 running 由 true 变 false 后
   * **观察到 turnId 变化**再触发（并在超时后清理，避免永久 armed）。
   * @type {{ turnIdAtArm: string, idleAt: number | null } | null}
   */
  let completionArm = null
  /** @type {Set<string>} suggestions already announced to assistive tech */
  const announced = new Set()
  /** O01：已上报的建议终态，避免重复 RPC（suggestionId -> Set<event>）。 */
  const reportedOutcomes = new Map()
  /** B09d：客户端集合上限（长会话不无限增长）。 */
  const CLIENT_SET_LIMIT = 500
  /** B01/B06：跨会话缓存与补发窗口。 */
  const SESSION_CACHE_LIMIT = 40
  const RESEND_WINDOW_MS = 30 * 60 * 1000
  const RETRY_DELAY_MS = 500
  /** Manual predictions per turn (first + "another one"); the Host enforces the same number. */
  const DEFAULT_MANUAL_LIMIT = 3
  /** 待补发：sessionId -> {turnKey, turnId, completedEventSeq, contextRevision, at} */
  const pendingBySession = new Map()
  /** 切会话恢复：sessionId -> {record, at} */
  const offersBySession = new Map()
  /** 输入后清空草稿恢复：turnKey -> {record, at} */
  const suspendedOffers = new Map()

  function addBounded(set, value) {
    set.add(value)
    while (set.size > CLIENT_SET_LIMIT) {
      const oldest = set.values().next().value
      if (oldest === undefined) break
      set.delete(oldest)
    }
  }

  /** B01：记下“回合已完成但当时窗口不可见/无焦点”的待补发标记。 */
  function rememberPending(state) {
    if (state === null || state === undefined || state.sessionId === '' || state.turnId === '') return
    pendingBySession.delete(state.sessionId)
    pendingBySession.set(state.sessionId, {
      turnKey: state.turnKey,
      turnId: state.turnId,
      completedEventSeq: state.completedEventSeq,
      contextRevision: state.contextRevision,
      at: now(),
    })
    while (pendingBySession.size > SESSION_CACHE_LIMIT) pendingBySession.delete(pendingBySession.keys().next().value)
  }

  /** B06：把当前建议按会话保存，切回时恢复（不再请求 Host）。 */
  function rememberOffer(state, env) {
    if (state === null || env === null || state.status !== 'offered' || state.suggestionId === '') return
    const record = {
      text: state.text,
      candidates: state.candidates,
      candidateIndex: state.candidateIndex,
      suggestionId: state.suggestionId,
      expiresAt: state.expiresAt,
      sessionId: state.sessionId,
      turnId: state.turnId,
      turnKey: state.turnKey,
      completedEventSeq: state.completedEventSeq,
      contextRevision: state.contextRevision,
    }
    offersBySession.delete(state.sessionId)
    offersBySession.set(state.sessionId, { record, at: now() })
    while (offersBySession.size > SESSION_CACHE_LIMIT) offersBySession.delete(offersBySession.keys().next().value)
  }

  /** B06：切回会话时恢复缓存中的建议（草稿为空、回合未变、未终结、未过期）。 */
  function restoreCachedOffer(env) {
    if (env === null || !env.sessionId || env.turnId === '' || env.running || !semanticEmpty(env) || env.composing) return false
    const cached = offersBySession.get(env.sessionId)
    if (cached === undefined) return false
    const record = cached.record
    if (record.expiresAt <= now() || record.turnId !== env.turnId || record.completedEventSeq !== env.completedEventSeq || record.contextRevision !== env.contextRevision) {
      offersBySession.delete(env.sessionId)
      return false
    }
    const tkey = turnKeyOf(env)
    if (acceptedTurns.has(tkey) || dismissedTurns.has(tkey) || suppressedTurns.has(tkey)) {
      offersBySession.delete(env.sessionId)
      return false
    }
    offersBySession.delete(env.sessionId)
    showOffer(env, { ...record, offerDraftRev: env.draftRev })
    return true
  }

  /** O01：把建议的展示/被覆盖/过期/关闭上报给 Host（不含正文）。 */
  function noteOutcome(event) {
    const state = assistStore.getSnapshot()
    const suggestionId = state.suggestionId
    if (suggestionId === '' || suggestionId.startsWith('debug-')) return
    const seen = reportedOutcomes.get(suggestionId)
    if (seen !== undefined && seen.has(event)) return
    const set = seen ?? new Set()
    set.add(event)
    reportedOutcomes.set(suggestionId, set)
    while (reportedOutcomes.size > CLIENT_SET_LIMIT) {
      const oldest = reportedOutcomes.keys().next().value
      if (oldest === undefined) break
      reportedOutcomes.delete(oldest)
    }
    void rpc(OPERATION_OUTCOME, {
      schemaVersion: SCHEMA_VERSION,
      operation: OPERATION_OUTCOME,
      suggestionId,
      sessionId: state.sessionId,
      event,
    }).catch(() => {})
  }

  /** The ghost actually became visible: report "shown" exactly once. */
  function noteShown() {
    const state = assistStore.getSnapshot()
    if (state.status !== 'offered' || state.suggestionId === '') return
    noteOutcome('shown')
  }

  /** O01: read the Host's 7-day result summary for the settings page. */
  async function loadResults() {
    try {
      const body = await rpc(OPERATION_RESULTS, {})
      return body !== null && typeof body === 'object' && body.ok === true && body.value !== null ? body.value : { available: false, summary: null }
    } catch {
      return { available: false, summary: null }
    }
  }
  /** @type {object | null} last chat projection digest, diagnostics only */
  let legacySnapshot = null

  /**
   * Record a bounded digest of the chat projection for diagnostics/debugging.
   * Never includes message text.
   */
  function noteLegacy(nodes, turnEnds) {
    const list = Array.isArray(nodes) ? nodes : []
    const digest = {
      nodeCount: list.length,
      nodes: list.slice(-8).map((node) => ({
        kind: node !== null && typeof node === 'object' ? node.kind : typeof node,
        turn: node !== null && typeof node === 'object' ? node.turn : undefined,
        seq: node !== null && typeof node === 'object' ? node.seq : undefined,
        interrupted: node !== null && typeof node === 'object' ? node.interrupted : undefined,
        blockKinds:
          node !== null && typeof node === 'object' && Array.isArray(node.blocks)
            ? node.blocks.map((block) => (block !== null && typeof block === 'object' ? block.kind : typeof block))
            : undefined,
      })),
      turnEnds:
        turnEnds !== null && turnEnds !== undefined && typeof turnEnds.entries === 'function'
          ? list.slice(-8).map((node) => [node?.turn, turnEnds.get(node?.turn)])
          : turnEnds === undefined
            ? 'undefined'
            : typeof turnEnds,
    }
    legacySnapshot = digest
  }

  /** Turn identity shared with the Host for dismiss/accepted correlation. */
  function turnKeyOf(env) {
    return env.sessionId + '\u0000' + env.branchEpoch + '\u0000' + env.turnId
  }

  function sameAnchor(first, second) {
    return first !== null && second !== null && turnKeyOf(first) === turnKeyOf(second) &&
      first.completedEventSeq === second.completedEventSeq && first.contextRevision === second.contextRevision
  }

  function setAssist(patch) {
    assistStore.set(patch)
  }

  function clearTimer() {
    if (timer !== undefined) {
      clearTimeout(timer)
      timer = undefined
    }
  }

  /** Cancel the current in-flight request, if any, and release its waiter slot. */
  function abortInflight() {
    if (activeRequest === null) return
    sequence += 1
    const { id, abort } = activeRequest
    activeRequest = null
    abort.abort()
    void rpc(OPERATION_RELEASE, { requestId: id }).catch(() => {})
  }

  /** Clear the visible offer and optionally keep a terminal status for the turn. */
  function clearOffer(status, outcome) {
    const nextStatus = typeof status === 'string' ? status : 'idle'
    const state = assistStore.getSnapshot()
    if (state.status === 'offered' && typeof outcome === 'string') noteOutcome(outcome)
    if (state.text === '' && state.suggestionId === '' && state.status === nextStatus) return
    setAssist({ ...INITIAL_ASSIST, status: nextStatus, sessionId: state.sessionId, turnKey: state.turnKey, turnId: state.turnId })
  }

  function clearWork(status, outcome) {
    clearTimer()
    abortInflight()
    clearOffer(status, outcome)
  }

  function showOffer(env, result) {
    clearTimer()
    // A fresh Host result carries `alternatives`; a restored record carries the
    // full `candidates` list and where the user had got to.
    const candidates = Array.isArray(result.candidates) && result.candidates.length > 0
      ? result.candidates
      : [result.text, ...(Array.isArray(result.alternatives) ? result.alternatives : [])].filter((text, index, list) => typeof text === 'string' && text !== '' && list.indexOf(text) === index)
    const candidateIndex = Number.isInteger(result.candidateIndex) && result.candidateIndex >= 0 && result.candidateIndex < candidates.length ? result.candidateIndex : 0
    setAssist({
      ...INITIAL_ASSIST,
      status: 'offered',
      text: candidates[candidateIndex] ?? result.text,
      candidates,
      candidateIndex,
      suggestionId: result.suggestionId,
      expiresAt: result.expiresAt,
      sessionId: env.sessionId,
      turnId: env.turnId,
      turnKey: turnKeyOf(env),
      completedEventSeq: env.completedEventSeq,
      contextRevision: env.contextRevision,
      configRevision: configStore.getSnapshot().revision,
      offerDraftRev: env.draftRev,
    })
    timer = setTimeout(() => {
      timer = undefined
      if (assistStore.getSnapshot().suggestionId === result.suggestionId) clearOffer('idle', 'expired')
    }, Math.max(0, result.expiresAt - now()))
    timer?.unref?.()
  }

  /** Fetch effective config + diagnostics from the Host. */
  async function loadStatus() {
    try {
      const body = await rpc(OPERATION_STATUS, {})
      if (disposed) return { ok: false, error: 'disposed' }
      if (!body || body.ok !== true || body.value === null || typeof body.value !== 'object') {
        const message = body && body.error && body.error.message ? body.error.message : 'status unavailable'
        configStore.set({ ...INITIAL_CONFIG_STATE, ready: true, hostError: String(message) })
        return { ok: false, error: String(message) }
      }
      const value = body.value
      configStore.set({
        ready: true,
        config: { ...EMPTY_CONFIG, ...(value.config ?? {}) },
        revision: typeof value.configRevision === 'number' ? value.configRevision : 0,
        configErrors: Array.isArray(value.configErrors) ? value.configErrors : [],
        capabilities: value.capabilities ?? {},
        diagnostics: value.diagnostics ?? null,
        provider: typeof value.provider === 'string' ? value.provider : '',
        hostError: '',
        route: value.route ?? null,
        budget: value.budget ?? null,
        promptVersion: typeof value.promptVersion === 'string' ? value.promptVersion : '',
        mode: typeof value.mode === 'string' ? value.mode : '',
        hostVersion: typeof value.version === 'string' ? value.version : '',
      })
      return { ok: true, value }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      configStore.set({ ...INITIAL_CONFIG_STATE, ready: true, hostError: message })
      return { ok: false, error: message }
    }
  }

  /** Persist a partial config through the Host config editor. */
  async function saveConfig(patch) {
    try {
      const body = await rpc(OPERATION_CONFIG_SET, { patch })
      if (!body || body.ok !== true) {
        const message = body && body.error && typeof body.error.message === 'string' ? body.error.message : ''
        return { ok: false, error: message }
      }
      const value = body.value ?? {}
      configStore.set({
        ...configStore.getSnapshot(),
        ready: true,
        config: { ...EMPTY_CONFIG, ...(value.config ?? {}) },
        revision: typeof value.configRevision === 'number' ? value.configRevision : 0,
        configErrors: Array.isArray(value.configErrors) ? value.configErrors : [],
        hostError: '',
        route: value.route ?? configStore.getSnapshot().route,
        budget: value.budget ?? configStore.getSnapshot().budget,
        promptVersion: typeof value.promptVersion === 'string' ? value.promptVersion : configStore.getSnapshot().promptVersion,
        mode: typeof value.mode === 'string' ? value.mode : configStore.getSnapshot().mode,
      })
      // The write restarts the Host plugin; refresh capabilities lazily.
      void loadStatus()
      return { ok: true, value }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  /** Evaluate whether this exact view could be offered a suggestion right now. */
  function eligibility(env) {
    const configState = configStore.getSnapshot()
    if (!configState.ready) return { ok: false, reason: 'config-loading' }
    if (configState.hostError !== '') return { ok: false, reason: 'host-unavailable' }
    if (configState.config.enabled !== true) return { ok: false, reason: 'disabled' }
    if (configState.capabilities.connectionFetch !== true) return { ok: false, reason: 'host-route-unavailable' }
    if (env === null || env === undefined) return { ok: false, reason: 'no-view' }
    if (!env.sessionId) return { ok: false, reason: 'no-session' }
    if (env.turnId === '') return { ok: false, reason: 'no-completed-turn' }
    if (env.running) return { ok: false, reason: 'turn-running' }
    if (env.hasFinalText !== true) return { ok: false, reason: 'no-final-assistant-text' }
    if (env.sessionBlank === true) return { ok: false, reason: 'blank-session' }
    if (env.sessionRemoved === true) return { ok: false, reason: 'session-removed' }
    if (env.awaitingFirstTurn === true) return { ok: false, reason: 'awaiting-first-turn' }
    if (env.canEdit !== true) return { ok: false, reason: 'not-editable' }
    if (!semanticEmpty(env)) return { ok: false, reason: 'draft-not-empty' }
    if (env.phase !== 'plain') return { ok: false, reason: 'input-frozen' }
    if (env.composing) return { ok: false, reason: 'composing' }
    if (env.pendingInteraction === true) return { ok: false, reason: 'pending-interaction' }
    if (env.menuOpen) return { ok: false, reason: 'menu-open' }
    if (!env.windowVisible || !env.windowFocused) return { ok: false, reason: 'window-inactive' }
    return { ok: true }
  }

  /** Semantic emptiness: no text, no whitespace-only text, no chips/attachments/claim/queued input. */
  function semanticEmpty(env) {
    if (env.draft !== '') return false
    if ((env.occurrencesCount ?? 0) > 0) return false
    if ((env.attachmentCount ?? 0) > 0) return false
    if ((env.queuedCount ?? 0) > 0) return false
    if (env.claimed === true) return false
    return true
  }

  function scheduleAuto(env, tkey) {
    clearTimer()
    setAssist({
      ...INITIAL_ASSIST,
      status: 'waiting',
      sessionId: env.sessionId,
      turnId: env.turnId,
      turnKey: tkey,
      completedEventSeq: env.completedEventSeq,
      contextRevision: env.contextRevision,
      configRevision: configStore.getSnapshot().revision,
    })
    const delay = Math.max(0, Number(configStore.getSnapshot().config.triggerDelayMs) || 0)
    timer = setTimeout(() => {
      timer = undefined
      const current = latestEnv
      if (disposed || current === null) return
      if (!sameAnchor(current, env) || current.draftRev !== env.draftRev) {
        clearOffer('idle')
        return
      }
      const check = eligibility(current)
      if (!check.ok) {
        setAssist({ ...INITIAL_ASSIST, status: 'abstained', reason: check.reason, sessionId: current.sessionId })
        return
      }
      if (suppressedTurns.has(turnKeyOf(current)) || dismissedTurns.has(turnKeyOf(current)) || acceptedTurns.has(turnKeyOf(current))) {
        return
      }
      void requestPrediction('auto', current)
    }, delay)
  }

  function makeRequestId() {
    return `nmp-${now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  }

  /** Dispatch one predict request and validate the answer against this view. */
  async function requestPrediction(trigger, env, retryCount = 0, attempt = 0) {
    if (disposed) return
    const mySequence = ++sequence
    const tkey = turnKeyOf(env)
    if (trigger === 'auto') addBounded(servedAuto, tkey)
    else if (retryCount === 0) {
      servedManual.delete(tkey)
      servedManual.set(tkey, attempt + 1)
      while (servedManual.size > CLIENT_SET_LIMIT) servedManual.delete(servedManual.keys().next().value)
    }
    const id = makeRequestId()
    const abort = new AbortController()
    activeRequest = { id, abort }
    const requestedRevision = configStore.getSnapshot().revision
    const anchor = {
      sessionId: env.sessionId,
      branchEpoch: env.branchEpoch,
      turnId: env.turnId,
      completedEventSeq: typeof env.completedEventSeq === 'number' ? env.completedEventSeq : 0,
      contextRevision: env.contextRevision,
    }
    setAssist({
      ...INITIAL_ASSIST,
      status: 'requesting',
      sessionId: env.sessionId,
      turnId: env.turnId,
      turnKey: tkey,
      configRevision: requestedRevision,
    })
    let body
    try {
      body = await rpc(OPERATION_PREDICT, {
        schemaVersion: SCHEMA_VERSION,
        operation: OPERATION_PREDICT,
        requestId: id,
        viewId,
        anchor,
        expectedConfigRevision: requestedRevision,
        trigger,
        ...(trigger === 'manual' && attempt > 0 ? { attempt } : {}),
      }, abort.signal)
    } catch (error) {
      if (mySequence !== sequence || disposed) return
      activeRequest = null
      // B07: 传输失败允许自动重试一次；模型/内容失败不重试。
      if (retryCount < 1) {
        setAssist({ ...INITIAL_ASSIST, status: 'waiting', sessionId: env.sessionId, turnId: env.turnId, turnKey: tkey })
        timer = setTimeout(() => {
          timer = undefined
          if (!disposed) void requestPrediction(trigger, env, 1, attempt)
        }, RETRY_DELAY_MS)
        timer?.unref?.()
        return
      }
      setAssist({ ...INITIAL_ASSIST, status: 'failed', reason: 'transport', error: textOf(error), sessionId: env.sessionId })
      return
    }
    if (disposed || mySequence !== sequence) return
    activeRequest = null
    if (body === null || body === undefined || typeof body !== 'object') {
      setAssist({ ...INITIAL_ASSIST, status: 'failed', reason: 'bad-response', sessionId: env.sessionId })
      return
    }
    const validation = validateResponseForClient(body, { requestId: id, anchor })
    if (!validation.ok) {
      setAssist({ ...INITIAL_ASSIST, status: 'failed', reason: `invalid-response:${validation.error}`, sessionId: env.sessionId })
      return
    }
    const current = latestEnv
    // The view moved on while the Host was answering: never paint this result.
    if (
      !sameAnchor(current, env) || current.draftRev !== env.draftRev || !eligibility(current).ok ||
      configStore.getSnapshot().revision !== requestedRevision
    ) {
      setAssist({ ...INITIAL_ASSIST, status: 'abstained', reason: 'stale-view', sessionId: env.sessionId })
      return
    }
    const result = body.result
    if (result.kind === 'offer') {
      if (body.configRevision !== requestedRevision || result.expiresAt <= now()) {
        clearOffer('idle')
        if (body.configRevision !== requestedRevision) void loadStatus()
        return
      }
      showOffer(current, result)
      return
    }
    if (result.kind === 'stale') {
      if (result.reason === 'config-changed') void loadStatus()
      setAssist({ ...INITIAL_ASSIST, status: 'abstained', reason: `stale:${result.reason}`, sessionId: env.sessionId })
      return
    }
    if (result.kind === 'abstain') {
      setAssist({ ...INITIAL_ASSIST, status: 'abstained', reason: result.reason, sessionId: env.sessionId })
      return
    }
    // B07: Host 并发忙时按 retryAfterMs 自动重试一次；模型失败不重试。
    if (result.kind === 'unavailable' && retryCount < 1 && (result.reason === 'busy' || typeof result.retryAfterMs === 'number')) {
      setAssist({ ...INITIAL_ASSIST, status: 'waiting', sessionId: env.sessionId, turnId: env.turnId, turnKey: tkey })
      const delay = Math.max(RETRY_DELAY_MS, Number(result.retryAfterMs) || 0)
      timer = setTimeout(() => {
        timer = undefined
        if (!disposed) void requestPrediction(trigger, env, 1, attempt)
      }, delay)
      timer?.unref?.()
      return
    }
    setAssist({
      ...INITIAL_ASSIST,
      status: 'unavailable',
      reason: result.reason,
      hintMs: result.retryAfterMs,
      sessionId: env.sessionId,
    })
  }

  /**
   * Reconcile the controller with the current view snapshot.
   * Called by the overlay after every render; cheap and idempotent.
   */
  function sync(env) {
    if (disposed) return
    const previous = latestEnv
    latestEnv = env
    const configState = configStore.getSnapshot()
    if (!configState.ready) return
    // O07: another ghost-text plugin owns the composer; stay out of its way.
    if (conflictSource !== '') {
      clearTimer()
      abortInflight()
      if (assistStore.getSnapshot().status !== 'conflict') {
        setAssist({ ...INITIAL_ASSIST, status: 'conflict', reason: `conflict:${conflictSource}` })
      }
      return
    }
    if (configState.config.enabled !== true) {
      if (assistStore.getSnapshot().status !== 'disabled') {
        clearWork('closed', 'closed')
        completionArm = null
        setAssist({ ...INITIAL_ASSIST, status: 'disabled' })
      }
      return
    }
    if (!configState.capabilities || configState.capabilities.connectionFetch !== true) {
      if (assistStore.getSnapshot().status !== 'unsupported') {
        clearWork('closed', 'closed')
        completionArm = null
        setAssist({ ...INITIAL_ASSIST, status: 'unsupported', reason: 'host-route-unavailable' })
      }
      return
    }
    if (!env.sessionId) {
      clearWork('closed', 'closed')
      completionArm = null
      return
    }
    if (env.sessionId !== boundSessionId) {
      const previousState = assistStore.getSnapshot()
      if (previous !== null && previous.sessionId !== env.sessionId) {
        // B06/B01：离开会话前保存建议与未请求的完成回合，切回时可恢复。
        if (previousState.status === 'offered') rememberOffer(previousState, previous)
        if (previousState.status === 'waiting') rememberPending(previousState)
      }
      boundSessionId = env.sessionId
      clearWork('closed', 'closed')
      completionArm = null
      suppressedTurns.clear()
      dismissedTurns.clear()
      acceptedTurns.clear()
      servedAuto.clear()
      servedManual.clear()
    }
    if (env.running === true) {
      if (completionArm === null || completionArm.idleAt !== null) {
        completionArm = { turnIdAtArm: env.turnId, idleAt: null }
      }
      clearWork('idle', 'overwritten')
      return
    }
    if (completionArm !== null) {
      completionArm.idleAt ??= now()
      if (now() - completionArm.idleAt > 5000) completionArm = null
    }
    if (!env.turnId) {
      clearWork('closed', 'closed')
      return
    }
    const tkey = turnKeyOf(env)
    const arm = completionArm
    const armedCompletion = arm !== null && env.turnId !== arm.turnIdAtArm
    const stateBefore = assistStore.getSnapshot()
    const terminalSameTurn =
      (stateBefore.status === 'accepted' || stateBefore.status === 'dismissed' || stateBefore.status === 'failed') &&
      stateBefore.turnKey === tkey
    // User edit or IME composition starts: hide now and never auto-revive this
    // turn. A terminal state for the same turn is never overwritten by this
    // branch (accepting inserts text, which necessarily makes the draft non-empty).
    if (!semanticEmpty(env) || env.composing) {
      // B06：用户开始输入时保留这条建议，草稿清空后可以恢复（不重新请求）。
      const active = assistStore.getSnapshot()
      if (active.status === 'offered' && active.suggestionId !== '') {
        suspendedOffers.delete(tkey)
        suspendedOffers.set(tkey, {
          record: {
            text: active.text,
            candidates: active.candidates,
            candidateIndex: active.candidateIndex,
            suggestionId: active.suggestionId,
            expiresAt: active.expiresAt,
            sessionId: active.sessionId,
            turnId: active.turnId,
            turnKey: active.turnKey,
            completedEventSeq: active.completedEventSeq,
            contextRevision: active.contextRevision,
          },
          at: now(),
        })
        while (suspendedOffers.size > SESSION_CACHE_LIMIT) suspendedOffers.delete(suspendedOffers.keys().next().value)
      }
      addBounded(suppressedTurns, tkey)
      if (armedCompletion) completionArm = null
      if (!terminalSameTurn) clearWork('suppressed', 'overwritten')
      return
    }
    // B06：草稿已清空 → 恢复用户开始输入前的那条建议。
    {
      const suspended = suspendedOffers.get(tkey)
      if (suspended !== undefined) {
        const active = assistStore.getSnapshot()
        if (suspended.record.expiresAt <= now() || suspended.record.turnId !== env.turnId) {
          suspendedOffers.delete(tkey)
        } else if (
          active.status !== 'offered' && active.status !== 'requesting' && active.status !== 'accepted' && active.status !== 'dismissed' &&
          !acceptedTurns.has(tkey) && !dismissedTurns.has(tkey)
        ) {
          suspendedOffers.delete(tkey)
          showOffer(env, { ...suspended.record, offerDraftRev: env.draftRev })
          return
        }
      }
    }
    const state = assistStore.getSnapshot()
    if (state.status === 'offered') {
      if (!offerMatches(state, env)) clearWork('idle', 'closed')
      return
    }
    if (state.status === 'requesting' || state.status === 'waiting') {
      if (
        !sameAnchor(previous, env) || previous.draftRev !== env.draftRev ||
        state.configRevision !== configState.revision || !eligibility(env).ok
      ) {
        // B01：窗口不可见/失焦导致 waiting 被取消时，记下待补发。
        if (state.status === 'waiting' && eligibility(env).reason === 'window-inactive') rememberPending(state)
        clearWork('idle')
      }
      return
    }
    if (suppressedTurns.has(tkey) || dismissedTurns.has(tkey) || acceptedTurns.has(tkey)) {
      clearTimer()
      if (state.status !== 'accepted' && state.status !== 'dismissed') clearOffer('idle')
      return
    }
    // B06：切回会话后恢复缓存建议（不重新请求）。
    if (restoreCachedOffer(env)) return
    // B01：回合完成时窗口不可见/无焦点 → 回到可见/聚焦后补发一次。
    const pending = pendingBySession.get(env.sessionId)
    if (pending !== undefined) {
      const windowMinutes = Number(configState.config.autoWindowMinutes)
      const resendWindowMs = Number.isFinite(windowMinutes) && windowMinutes > 0 ? windowMinutes * 60 * 1000 : RESEND_WINDOW_MS
      if (now() - pending.at > resendWindowMs || env.turnId !== pending.turnId) {
        pendingBySession.delete(env.sessionId)
      } else if (configState.config.manualOnly === true) {
        // 手动模式下不补发自动预测。
        pendingBySession.delete(env.sessionId)
      } else if ((state.status === 'idle' || state.status === 'closed') && !servedAuto.has(pending.turnKey) && eligibility(env).ok) {
        pendingBySession.delete(env.sessionId)
        scheduleAuto(env, pending.turnKey)
        return
      }
    }
    // Automatic trigger only when this mounted view observed a running -> idle
    // transition AND the chat projection has moved to a new completed turn.
    // Never trigger from remounting an old session.
    if (armedCompletion && !servedAuto.has(tkey)) {
      completionArm = null
      // 手动模式：回答结束后不自动预测，等用户按 Alt+\。
      if (configState.config.manualOnly === true) return
      const check = eligibility(env)
      if (check.ok) scheduleAuto(env, tkey)
      // B01：失焦/不可见时先记下，聚焦后补发（Host 仍有 30 分钟窗口）。
      else if (check.reason === 'window-inactive') rememberPending({ ...env, turnKey: tkey })
    }
  }

  /** Model calls allowed per reply for manual predictions; the Host enforces the same setting. */
  function manualLimit() {
    const configured = Number(configStore.getSnapshot().config.manualLimit)
    return Number.isInteger(configured) && configured >= 1 ? configured : DEFAULT_MANUAL_LIMIT
  }

  /**
   * Whether "another one" can still do something for the suggestion on screen:
   * step to another candidate already in hand, or ask the model again. The
   * composer greys the chip out when it cannot, instead of ignoring the click.
   */
  function canOfferAnother() {
    const state = assistStore.getSnapshot()
    if (state.status !== 'offered') return false
    if (state.candidates.length > 1) return true
    if (acceptedTurns.has(state.turnKey)) return false
    return (servedManual.get(state.turnKey) ?? 0) < manualLimit()
  }

  /**
   * Manual trigger (Alt+\ in the composer, the "another one" chip, debug surface).
   * Up to MANUAL_LIMIT per turn: the first press predicts, a press while a
   * suggestion is showing (or after one ended) asks for a different one.
   * The user asked explicitly, so a turn they typed in or dismissed earlier is
   * still allowed; only a turn whose suggestion was already accepted is closed.
   * A refusal goes to the notice store so the composer can say why.
   */
  function predictNow() {
    const env = latestEnv
    const sessionId = env !== null && env !== undefined && typeof env.sessionId === 'string' ? env.sessionId : ''
    const status = assistStore.getSnapshot().status
    const refuse = (reason) => {
      // A running request or a visible suggestion already answers the key press.
      if (status !== 'requesting' && status !== 'offered') noticeStore.set({ kind: 'none', reason, sessionId, at: now() })
      return { ok: false, reason }
    }
    const check = eligibility(env)
    if (!check.ok) return refuse(check.reason)
    if (status === 'requesting') return { ok: false, reason: 'prediction-active' }
    const tkey = turnKeyOf(env)
    const used = servedManual.get(tkey) ?? 0
    const MANUAL_LIMIT = manualLimit()
    // A suggestion is showing and this prediction brought more than one: step
    // through them locally first. No request, no wait.
    if (status === 'offered') {
      const state = assistStore.getSnapshot()
      const total = state.candidates.length
      const next = state.candidateIndex + 1
      // Past the last one: ask the model for more if any manual predictions are
      // left on this reply, otherwise go round to the first again.
      const target = next < total ? next : used >= MANUAL_LIMIT && total > 1 ? 0 : -1
      if (target >= 0) {
        setAssist({ ...state, text: state.candidates[target], candidateIndex: target })
        return { ok: true, local: true }
      }
    }
    if (used >= MANUAL_LIMIT) return refuse('manual-limit')
    if (acceptedTurns.has(tkey)) return refuse('turn-closed')
    // Asking for another one replaces the suggestion on screen.
    if (status === 'offered') clearOffer('idle', 'closed')
    suppressedTurns.delete(tkey)
    dismissedTurns.delete(tkey)
    suspendedOffers.delete(tkey)
    clearTimer()
    completionArm = null
    noticeStore.set({ kind: 'predicting', reason: '', sessionId, at: now() })
    void requestPrediction('manual', env, 0, used)
    return { ok: true }
  }

  /**
   * Reserve the visible offer for adoption. The overlay performs the native
   * captureInsertion/insertText pair and calls markAccepted only on success.
   */
  function offerMatches(state, env) {
    return env != null && state.turnKey === turnKeyOf(env) &&
      state.completedEventSeq === env.completedEventSeq && state.contextRevision === env.contextRevision &&
      state.configRevision === configStore.getSnapshot().revision && state.offerDraftRev === env.draftRev &&
      state.expiresAt > now()
  }

  function prepareAdoption(env) {
    const state = assistStore.getSnapshot()
    if (state.status !== 'offered' || state.text === '') return null
    if (!offerMatches(state, env) || !eligibility(env).ok || !env.focused) return null
    return {
      text: state.text,
      suggestionId: state.suggestionId,
      turnKey: state.turnKey,
      draftRev: state.offerDraftRev,
      sessionId: state.sessionId,
      turnId: state.turnId,
    }
  }

  /** Finalize a successful native insertion. */
  function markAccepted(offer) {
    addBounded(acceptedTurns, offer.turnKey)
    clearTimer()
    setAssist({
      ...INITIAL_ASSIST,
      status: 'accepted',
      suggestionId: offer.suggestionId,
      turnKey: offer.turnKey,
      turnId: offer.turnId ?? '',
      sessionId: offer.sessionId ?? '',
    })
    void rpc(OPERATION_ACCEPTED, {
      schemaVersion: SCHEMA_VERSION,
      operation: OPERATION_ACCEPTED,
      suggestionId: offer.suggestionId,
      sessionId: offer.sessionId ?? '',
    }).catch(() => {})
  }

  /** The native insertion refused our span; hide the stale offer, keep the key native. */
  function markInsertRejected(offer) {
    console.warn('[next-message-predictor] insertion rejected (stale draft or frozen editor); offer withdrawn', {
      suggestionId: offer.suggestionId,
    })
    noteOutcome('closed')
    clearTimer()
    setAssist({
      ...INITIAL_ASSIST,
      status: 'failed',
      reason: 'insert-rejected',
      sessionId: offer.sessionId ?? '',
      turnKey: offer.turnKey,
      turnId: offer.turnId ?? '',
    })
  }

  /** Esc / explicit dismiss for the current turn. */
  function dismissCurrent(env) {
    const state = assistStore.getSnapshot()
    if (state.status !== 'offered' || !prepareAdoption(env)) return false
    addBounded(dismissedTurns, state.turnKey)
    clearTimer()
    setAssist({ ...INITIAL_ASSIST, status: 'dismissed', suggestionId: state.suggestionId, turnKey: state.turnKey, turnId: state.turnId, sessionId: state.sessionId })
    void rpc(OPERATION_DISMISS, {
      schemaVersion: SCHEMA_VERSION,
      operation: OPERATION_DISMISS,
      suggestionId: state.suggestionId,
      sessionId: state.sessionId,
      turnKey: state.turnKey,
    }).catch(() => {})
    return true
  }

  /** O07: another ghost plugin was detected; step aside until it disappears. */
  function noteConflict(source) {
    if (typeof source !== 'string' || source === '') return
    if (conflictSource === source) return
    conflictSource = source
    clearWork('conflict')
    setAssist({ ...INITIAL_ASSIST, status: 'conflict', reason: `conflict:${source}` })
  }

  /** O07: the other plugin disappeared; resume normal behavior. */
  function clearConflict() {
    if (conflictSource === '') return
    conflictSource = ''
    clearWork('idle')
  }

  /** Whether assistive technology should announce the current offer once. */
  function takeAnnouncement() {
    const state = assistStore.getSnapshot()
    if (state.status !== 'offered' || state.suggestionId === '') return false
    if (announced.has(state.suggestionId)) return false
    addBounded(announced, state.suggestionId)
    return true
  }

  function noteComposing(composing) {
    if (signalsStore.getSnapshot().composing === composing) return
    signalsStore.set({ composing })
  }

  function noteDomMutation() {
    const current = signalsStore.getSnapshot()
    signalsStore.set({ menuTick: (current.menuTick + 1) % 1000000 })
  }

  /** Debug surface exposed on window for manual verification (never sends). */
  function debugApi() {
    return {
      state() {
        return {
          assist: assistStore.getSnapshot(),
          config: configStore.getSnapshot(),
          env: latestEnv,
        }
      },
      config: () => configStore.getSnapshot(),
      legacy: () => legacySnapshot,
      predictNow,
      /** Paint a local fake offer without the Host; P1 manual smoke-test path. */
      suggest(text) {
        const env = latestEnv
        if (env === null || !env.sessionId) return false
        const clean = typeof text === 'string' ? text.trim() : ''
        if (clean === '') return false
        abortInflight()
        showOffer(env, {
          text: clean,
          suggestionId: `debug-${now().toString(36)}`,
          expiresAt: now() + OFFER_TTL_MS,
        })
        return true
      },
      clear() {
        clearWork('closed', 'closed')
      },
      reloadConfig: loadStatus,
      /** O01: 7-day result summary (settings page). */
      loadResults,
    }
  }

  function dispose() {
    disposed = true
    clearTimer()
    abortInflight()
  }

  function detachView(sessionId) {
    if (latestEnv?.sessionId !== sessionId) return
    latestEnv = null
    completionArm = null
    clearWork('closed', 'closed')
  }

  return {
    configStore,
    assistStore,
    signalsStore,
    noticeStore,
    shellStore,
    clearNotice,
    loadStatus,
    saveConfig,
    sync,
    detachView,
    eligibility,
    predictNow,
    canOfferAnother,
    prepareAdoption,
    markAccepted,
    markInsertRejected,
    dismissCurrent,
    takeAnnouncement,
    noteShown,
    loadResults,
    noteConflict,
    clearConflict,
    noteComposing,
    noteDomMutation,
    noteLegacy,
    debugApi,
    dispose,
    getViewId: () => viewId,
    getLatestEnv: () => latestEnv,
  }
}

/** One HTTP RPC over the authenticated plugin route. */
export function createRouteRpc() {
  return async function rpc(operation, payload, signal) {
    const body = { schemaVersion: SCHEMA_VERSION, operation, ...(payload === undefined ? {} : payload) }
    const response = await fetch(ROUTE, {
      method: 'POST',
      credentials: 'same-origin',
      signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (response.status === 404) throw new Error('route-missing')
    let json
    try {
      json = await response.json()
    } catch {
      throw new Error(`invalid-json (HTTP ${response.status})`)
    }
    return json
  }
}

function textOf(error) {
  if (error instanceof Error) return error.message
  return String(error)
}
