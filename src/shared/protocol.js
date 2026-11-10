// Shared wire protocol for dsh-next-message-predictor.
//
// The browser sends only identities and limits: it never supplies the model,
// a system prompt, or transcript content. The Host builds the authoritative
// request from its own session state (P2). P1 answers from a fixed suggestion.
// This file is concatenated into the browser bundle: plain declarations only.

export const OPERATION_PREDICT = 'predict'
export const OPERATION_RELEASE = 'release'
export const OPERATION_DISMISS = 'dismiss'
export const OPERATION_ACCEPTED = 'accepted'
export const OPERATION_STATUS = 'status'
export const OPERATION_CONFIG_GET = 'config.get'
export const OPERATION_CONFIG_SET = 'config.set'
/** O01：客户端回报建议真正展示/被覆盖/过期/视图关闭。 */
export const OPERATION_OUTCOME = 'outcome'
/** O01：近 7 天结果汇总（不含正文）。 */
export const OPERATION_RESULTS = 'results.summary'

export const TRIGGER_AUTO = 'auto'
export const TRIGGER_MANUAL = 'manual'

export const RESULT_OFFER = 'offer'
export const RESULT_ABSTAIN = 'abstain'
export const RESULT_STALE = 'stale'
export const RESULT_UNAVAILABLE = 'unavailable'

const MAX_ID_LENGTH = 200
const MAX_ANCHOR_STRING = 200

/** Whether a value is a non-array plain object. */
export function isPlainRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_LENGTH
}

/**
 * Validate one TurnAnchor.
 * `completedEventSeq`/`contextRevision` are advanced identities that P2 fills;
 * P1 keeps them optional-safe so older views and P1 client builds interoperate.
 */
export function validateTurnAnchor(anchor) {
  if (!isPlainRecord(anchor)) return 'anchor must be a plain object'
  if (!isId(anchor.sessionId)) return 'anchor.sessionId is required'
  if (typeof anchor.branchEpoch !== 'string' || anchor.branchEpoch.length > MAX_ANCHOR_STRING) {
    return 'anchor.branchEpoch must be a string'
  }
  if (!isId(anchor.turnId)) return 'anchor.turnId is required'
  if (!Number.isSafeInteger(anchor.completedEventSeq) || anchor.completedEventSeq < 0) {
    return 'anchor.completedEventSeq must be a non-negative integer'
  }
  if (typeof anchor.contextRevision !== 'string' || anchor.contextRevision.length > MAX_ANCHOR_STRING) {
    return 'anchor.contextRevision must be a string'
  }
  return ''
}

/**
 * Validate a browser request envelope.
 * @returns {{ok: true, request: object} | {ok: false, error: string}}
 */
export function validatePredictRequest(raw) {
  if (!isPlainRecord(raw)) return { ok: false, error: 'request must be a plain object' }
  if (raw.schemaVersion !== 1) return { ok: false, error: 'schemaVersion must be 1' }
  if (raw.operation !== OPERATION_PREDICT) return { ok: false, error: 'operation must be "predict"' }
  if (!isId(raw.requestId)) return { ok: false, error: 'requestId is required' }
  if (typeof raw.viewId !== 'string' || raw.viewId.length > MAX_ID_LENGTH) return { ok: false, error: 'viewId is required' }
  const anchorError = validateTurnAnchor(raw.anchor)
  if (anchorError !== '') return { ok: false, error: anchorError }
  if (raw.expectedConfigRevision !== undefined) {
    if (typeof raw.expectedConfigRevision !== 'number' || !Number.isFinite(raw.expectedConfigRevision)) {
      return { ok: false, error: 'expectedConfigRevision must be a number' }
    }
  }
  if (raw.trigger !== TRIGGER_AUTO && raw.trigger !== TRIGGER_MANUAL) {
    return { ok: false, error: 'trigger must be "auto" or "manual"' }
  }
  // 手动触发的第几次（0 = 第一次，之后是“换一条”）。自动触发恒为 0。
  if (raw.attempt !== undefined && (!Number.isInteger(raw.attempt) || raw.attempt < 0 || raw.attempt > 9)) {
    return { ok: false, error: 'attempt must be an integer between 0 and 9' }
  }
  return {
    ok: true,
    request: {
      schemaVersion: 1,
      operation: OPERATION_PREDICT,
      requestId: raw.requestId,
      viewId: raw.viewId,
      anchor: {
        sessionId: raw.anchor.sessionId,
        branchEpoch: raw.anchor.branchEpoch,
        turnId: raw.anchor.turnId,
        completedEventSeq: raw.anchor.completedEventSeq,
        contextRevision: raw.anchor.contextRevision,
      },
      expectedConfigRevision: raw.expectedConfigRevision,
      trigger: raw.trigger,
      attempt: raw.trigger === TRIGGER_MANUAL && Number.isInteger(raw.attempt) ? raw.attempt : 0,
    },
  }
}

/** Build an offer result. */
export function makeOffer(text, suggestionId, expiresAt) {
  return { kind: RESULT_OFFER, suggestionId, text, expiresAt }
}

/** Build a non-offer result. */
export function makeResult(kind, reason, extra) {
  return { kind, reason, ...(extra === undefined ? {} : extra) }
}

/** Validate the response envelope before the browser is allowed to paint it. */
export function validateResponseForClient(raw, expected) {
  if (!isPlainRecord(raw)) return { ok: false, error: 'response must be a plain object' }
  if (raw.requestId !== expected.requestId) return { ok: false, error: 'requestId mismatch' }
  if (!isPlainRecord(raw.result)) return { ok: false, error: 'result missing' }
  const anchorError = validateTurnAnchor(raw.anchor)
  if (anchorError !== '') return { ok: false, error: anchorError }
  if (raw.anchor.sessionId !== expected.anchor.sessionId) return { ok: false, error: 'session mismatch' }
  if (raw.anchor.turnId !== expected.anchor.turnId) return { ok: false, error: 'turn mismatch' }
  if (raw.anchor.branchEpoch !== expected.anchor.branchEpoch) return { ok: false, error: 'branch mismatch' }
  if (raw.anchor.completedEventSeq !== expected.anchor.completedEventSeq) return { ok: false, error: 'completion mismatch' }
  if (raw.anchor.contextRevision !== expected.anchor.contextRevision) return { ok: false, error: 'context mismatch' }
  if (!Number.isFinite(raw.configRevision)) return { ok: false, error: 'configRevision missing' }
  const result = raw.result
  switch (result.kind) {
    case RESULT_OFFER:
      if (typeof result.suggestionId !== 'string' || result.suggestionId === '') {
        return { ok: false, error: 'suggestionId missing' }
      }
      if (typeof result.text !== 'string' || result.text === '') return { ok: false, error: 'text missing' }
      if (typeof result.expiresAt !== 'number' || !Number.isFinite(result.expiresAt)) {
        return { ok: false, error: 'expiresAt missing' }
      }
      // 可选：同一次预测给出的其他候选，用户可以在本地切换。
      if (result.alternatives !== undefined) {
        if (!Array.isArray(result.alternatives) || result.alternatives.length > 9 || result.alternatives.some((entry) => typeof entry !== 'string' || entry === '')) {
          return { ok: false, error: 'alternatives invalid' }
        }
      }
      return { ok: true, result }
    case RESULT_ABSTAIN:
    case RESULT_STALE:
      if (typeof result.reason !== 'string') return { ok: false, error: 'reason missing' }
      return { ok: true, result }
    case RESULT_UNAVAILABLE:
      if (typeof result.reason !== 'string') return { ok: false, error: 'reason missing' }
      if (result.retryAfterMs !== undefined && (typeof result.retryAfterMs !== 'number' || result.retryAfterMs < 0)) {
        return { ok: false, error: 'retryAfterMs invalid' }
      }
      return { ok: true, result }
    default:
      return { ok: false, error: 'unknown result kind' }
  }
}

/** True when the last assistant sequence number can identify a finished turn. */
export function isTurnId(turnId) {
  return typeof turnId === 'string' && turnId.length > 0 && turnId.length <= MAX_ANCHOR_STRING
}

