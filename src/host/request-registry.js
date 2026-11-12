// In-memory request/production registry for dsh-next-message-predictor.
//
// One result key has exactly one production task with any number of waiters.
// A network retry of the same requestId re-attaches instead of re-producing.
// The last waiter leaving aborts the production task.
//
// The per-turn credits here live in memory and cover this plugin instance,
// including productions still running. They are forgotten when the Host half
// restarts (saving any setting restarts it), so the persistent ledger keeps
// its own per-turn count of model calls (budget-ledger `turns`), written in
// the same atomic write as the dispatch reservation. The service checks both.

/**
 * @typedef {object} Production
 * @property {Promise<{kind: string, text?: string, reason?: string}>} result
 * @property {Set<() => boolean>} waiters
 * @property {AbortController} abort
 * @property {boolean} settled
 */

/** 每次回答最多手动预测几次（第一次 + “换一条”）。客户端用同一个上限。 */
export const MAX_MANUAL_PER_TURN = 3

/** Create one registry instance for one plugin fiber. */
export function createRequestRegistry() {
  /** @type {Map<string, Production>} cacheKey -> production */
  const productions = new Map()
  /** @type {Map<string, {production:Production, waiters:Set<() => boolean>}>} */
  const byRequest = new Map()
  /** @type {Map<string, {autoUsed: boolean, manualCount: number}>} turn key -> ledger */
  const turnLedger = new Map()

  /** Per-turn dispatch ledger: one automatic production, up to MAX_MANUAL_PER_TURN manual ones. */
  function ledgerFor(turnKey) {
    let entry = turnLedger.get(turnKey)
    if (entry === undefined) {
      entry = { autoUsed: false, manualCount: 0 }
      turnLedger.set(turnKey, entry)
      // Bounded: keep the newest 500 turns and drop the oldest.
      if (turnLedger.size > 500) {
        const oldest = turnLedger.keys().next().value
        if (oldest !== undefined) turnLedger.delete(oldest)
      }
    }
    return entry
  }

  /** Whether the trigger still has production credit for this turn. */
  function hasCredit(turnKey, trigger, manualLimit) {
    const entry = ledgerFor(turnKey)
    const limit = Number.isInteger(manualLimit) && manualLimit > 0 ? manualLimit : MAX_MANUAL_PER_TURN
    return trigger === 'auto' ? !entry.autoUsed : entry.manualCount < limit
  }

  /** Consume one production credit before dispatch. */
  function consumeCredit(turnKey, trigger) {
    const entry = ledgerFor(turnKey)
    if (trigger === 'auto') entry.autoUsed = true
    else entry.manualCount += 1
  }

  /**
   * Give back a credit that bought nothing: the production ended without a
   * model call (context read failed, the budget ledger could not be written or
   * the daily allowance is used up, the model route could not be prepared, the
   * turn went stale or the request was cancelled before the call, the call
   * failed before its stream started). The service refunds whenever its
   * production did not reach the model. Without this a transient failure would
   * use up the turn's only automatic prediction.
   */
  function refundCredit(turnKey, trigger) {
    const entry = turnLedger.get(turnKey)
    if (entry === undefined) return
    if (trigger === 'auto') entry.autoUsed = false
    else entry.manualCount = Math.max(0, entry.manualCount - 1)
  }

  /** Existing production for one result key, if any. */
  function findProduction(cacheKey) {
    const production = productions.get(cacheKey)
    return production?.abort.signal.aborted === false ? production : undefined
  }

  /**
   * Start one production task.
   * @param {string} cacheKey - result cache key.
   * @param {(signal: AbortSignal) => Promise<{kind: string, text?: string, reason?: string}>} run
   * @returns {Production}
   */
  function startProduction(cacheKey, run) {
    /** @type {Production} */
    const production = {
      waiters: new Set(),
      abort: new AbortController(),
      settled: false,
      result: Promise.resolve(),
    }
    productions.set(cacheKey, production)
    production.result = Promise.resolve()
      .then(() => run(production.abort.signal))
      .catch(() => ({ kind: 'unavailable', reason: production.abort.signal.aborted ? 'cancelled' : 'internal-error' }))
      .finally(() => {
        production.settled = true
        if (productions.get(cacheKey) === production) productions.delete(cacheKey)
      })
    return production
  }

  /** Wait independently for a shared result. A released waiter gets no offer. */
  function attach(production, requestId, signal) {
    let group = byRequest.get(requestId)
    if (group === undefined) {
      group = { production, waiters: new Set() }
      byRequest.set(requestId, group)
    } else if (group.production !== production) {
      return Promise.resolve({ kind: 'stale', reason: 'request-id-reused' })
    }
    const { promise, resolve } = Promise.withResolvers()
    const detach = () => {
      signal?.removeEventListener('abort', cancel)
      production.waiters.delete(cancel)
      group.waiters.delete(cancel)
      if (group.waiters.size === 0 && byRequest.get(requestId) === group) byRequest.delete(requestId)
    }
    const cancel = () => {
      detach()
      resolve({ kind: 'unavailable', reason: 'cancelled' })
      if (production.settled || production.waiters.size > 0) return false
      production.abort.abort()
      return true
    }
    production.waiters.add(cancel)
    group.waiters.add(cancel)
    if (signal?.aborted) cancel()
    else signal?.addEventListener('abort', cancel, { once: true })
    return Promise.race([production.result, promise]).finally(detach)
  }

  /**
   * Release one request's interest.
   * @returns {boolean} whether the shared production was aborted
   */
  function release(requestId) {
    const group = byRequest.get(requestId)
    if (group === undefined) return false
    let aborted = false
    for (const cancel of group.waiters) {
      if (cancel()) aborted = true
    }
    return aborted
  }

  /** Abort every live production (plugin unload / disable). */
  function dispose() {
    for (const requestId of byRequest.keys()) release(requestId)
    for (const production of productions.values()) {
      production.abort.abort()
    }
    productions.clear()
    byRequest.clear()
    turnLedger.clear()
  }

  /** Number of live production tasks (B07: already-aborted tasks do not count). */
  function activeCount() {
    let count = 0
    for (const production of productions.values()) {
      if (production.abort.signal.aborted !== true) count += 1
    }
    return count
  }

  return {
    hasCredit,
    consumeCredit,
    refundCredit,
    findProduction,
    startProduction,
    attach,
    release,
    dispose,
    activeCount,
  }
}
