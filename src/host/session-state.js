import { randomUUID } from 'node:crypto'
import { isAbsolute, normalize } from 'node:path'
import { OFFER_TTL_MS } from '../shared/config.js'

const SESSION_STORES = Symbol.for('dsh-next-message-predictor.session-stores.v1')
const MAX_PAUSE_SESSIONS = 4096
const MAX_TERMINALS = 4096
const MAX_OFFERS = 8192
const MAX_SEND_CLAIMS = 65536

/**
 * Uses the Host's profile identity across reloads. The connection is a fallback
 * in compositions without a profile. The plugin never writes this to disk.
 */
export function sessionStateForHost(connection, profileDir) {
  // Even the imported module can be reloaded during settings reconciliation.
  const stores = globalThis[SESSION_STORES] ??= { profiles: new Map(), connections: new WeakMap() }
  const hasProfile = typeof profileDir === 'string' && isAbsolute(profileDir)
  if (!hasProfile && (connection == null || typeof connection !== 'object')) return createSessionState()
  const key = hasProfile ? normalize(profileDir) : connection
  const states = hasProfile ? stores.profiles : stores.connections
  let state = states.get(key)
  if (state === undefined) {
    state = createSessionState()
    states.set(key, state)
  }
  return state
}

export function createSessionState({ now = Date.now } = {}) {
  const hostId = randomUUID()
  const pauses = new Map()
  const terminals = new Map()
  const projectedOffers = new Map()
  // A granted turn is never reopened by an expiring offer, a disconnect, or a plugin reload.
  const sendClaims = new Set()
  const listeners = new Set()
  /** Global monotonic sequence for the lifetime of this Host authority. */
  let sequence = 0

  function terminalKey(sessionId, turn) {
    return JSON.stringify([sessionId, turn])
  }

  function snapshot(sessionId, turn = '') {
    const pause = pauses.get(sessionId)
    const terminal = terminals.get(terminalKey(sessionId, turn))
    const active = terminal?.expiresAt > now() ? terminal : undefined
    return {
      sessionId, hostId,
      paused: pause?.paused ?? false,
      pauseRevision: pause?.revision ?? 0,
      turnRevision: active?.revision ?? 0,
      terminal: active?.event ?? '',
      stateRevision: sequence,
    }
  }

  function publish(sessionId, turn) {
    for (const listener of listeners) {
      try {
        listener(sessionId, turn)
      } catch {
        // The state change is authoritative even if a stale subscriber failed.
      }
    }
  }

  function changePause(sessionId, turn, paused, expectedHostId, expectedPauseRevision) {
    const current = snapshot(sessionId, turn)
    if (current.hostId !== expectedHostId || current.pauseRevision !== expectedPauseRevision) return { reason: 'session-state-changed' }
    if (current.paused !== paused) {
      if (!pauses.has(sessionId) && pauses.size >= MAX_PAUSE_SESSIONS) return { reason: 'session-pause-capacity' }
      pauses.set(sessionId, { paused, revision: ++sequence, resumedAt: paused ? 0 : now() })
      publish(sessionId, '')
    }
    return { state: snapshot(sessionId, turn) }
  }

  function prune(map) {
    const timestamp = now()
    for (const [key, entry] of map) {
      if (entry.expiresAt <= timestamp) map.delete(key)
    }
  }

  function registerOffer(offer, sessionId, turn, state, anchor, configRevision) {
    if (projectedOffers.has(offer.suggestionId)) return true
    prune(projectedOffers)
    prune(terminals)
    const key = terminalKey(sessionId, turn)
    const previous = terminals.get(key)
    // Keep the terminal slot available for every live offer. Releasing a
    // slot early could let a late prediction replay an old cached offer.
    if (projectedOffers.size >= MAX_OFFERS || (previous === undefined && terminals.size >= MAX_TERMINALS)) return false
    terminals.set(key, { ...previous, expiresAt: Math.max(previous?.expiresAt ?? 0, offer.expiresAt) })
    projectedOffers.set(offer.suggestionId, {
      sessionId, turn, anchor, configRevision, expiresAt: offer.expiresAt, pauseRevision: state.pauseRevision, turnRevision: state.turnRevision,
    })
    return true
  }

  function sendableOffer(suggestionId, sessionId, expected, configRevision) {
    const offer = projectedOffers.get(suggestionId)
    if (offer?.sessionId !== sessionId || offer.anchor == null || offer.expiresAt <= now() ||
      offer.configRevision !== configRevision) return null
    const current = snapshot(sessionId, offer.turn)
    if (current.hostId !== expected.hostId || current.paused || current.terminal === 'accepted' ||
      current.pauseRevision !== expected.pauseRevision || current.turnRevision !== expected.turnRevision ||
      current.pauseRevision !== offer.pauseRevision || current.turnRevision !== offer.turnRevision ||
      sendClaims.has(terminalKey(sessionId, offer.turn))) return null
    return offer
  }

  function claimSend(suggestionId, sessionId, expected, configRevision) {
    const offer = sendableOffer(suggestionId, sessionId, expected, configRevision)
    if (offer === null || sendClaims.size >= MAX_SEND_CLAIMS) return false
    sendClaims.add(terminalKey(sessionId, offer.turn))
    return true
  }

  function finishOffer(suggestionId, sessionId, event) {
    const offer = projectedOffers.get(suggestionId)
    if (offer === undefined || (sessionId !== undefined && offer.sessionId !== sessionId) || offer.expiresAt <= now()) return null
    const current = snapshot(offer.sessionId, offer.turn)
    if (current.paused || current.pauseRevision !== offer.pauseRevision || current.terminal === 'accepted') return null
    const key = terminalKey(offer.sessionId, offer.turn)
    const previous = terminals.get(key)
    // A click that committed before a concurrent Esc wins even if the Host
    // sees the Esc first. Later Esc reports cannot replace an adoption.
    const concurrentAcceptance = event === 'accepted' && previous?.event === 'dismissed' &&
      previous.previousRevision === offer.turnRevision && previous.pauseRevision === offer.pauseRevision
    if (current.turnRevision !== offer.turnRevision && !concurrentAcceptance) return null
    terminals.set(key, {
      event, revision: ++sequence, previousRevision: offer.turnRevision, pauseRevision: offer.pauseRevision,
      expiresAt: Math.max(previous?.expiresAt ?? 0, now() + OFFER_TTL_MS),
    })
    publish(offer.sessionId, offer.turn)
    return { state: snapshot(offer.sessionId, offer.turn), turn: offer.turn }
  }

  return {
    snapshot,
    resumedAt: (sessionId) => pauses.get(sessionId)?.resumedAt ?? 0,
    changePause,
    registerOffer,
    sendableOffer,
    claimSend,
    finishOffer,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}
