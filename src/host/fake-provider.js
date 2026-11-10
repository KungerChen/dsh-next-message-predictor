// P1 fixed-suggestion provider.
//
// This is the only "production" implementation in the P0/P1 build. It performs
// no network request, reads no credentials, starts no agent and never touches
// the composer: it returns the configured test suggestion (or abstains) so the
// whole interaction path can be wired end-to-end and verified. P2 replaces this
// module with a genuine auxiliary model call behind the same interface.

import { validateSuggestionText } from '../shared/output-validation.js'

/** Marker recorded in diagnostics so nobody mistakes a P1 run for a model run. */
export const PROVIDER_KIND = 'fixed-test-suggestion'

/**
 * Produce one candidate.
 * @param {{config: object, now: number, signal?: AbortSignal}} input
 * @returns {Promise<{kind: 'offer', text: string} | {kind: 'abstain', reason: string}>}
 */
export async function produceFixedSuggestion(input) {
  const { config, now, signal } = input
  const text = typeof config.fakeSuggestion === 'string' ? config.fakeSuggestion : ''
  if (text.trim() === '') {
    // No model is wired in P0/P1: without a configured test suggestion the
    // correct behavior is a legal abstain, never a fabricated message.
    return { kind: 'abstain', reason: 'no-test-suggestion-configured' }
  }
  const delay = typeof config.fakeSuggestionDelayMs === 'number' ? config.fakeSuggestionDelayMs : 0
  if (delay > 0) await abortableDelay(delay, signal, now)
  if (signal !== undefined && signal.aborted) return { kind: 'abstain', reason: 'cancelled' }
  const validated = validateSuggestionText(text, { maxGraphemes: config.maxSuggestionGraphemes })
  if (!validated.ok) return { kind: 'abstain', reason: `fixed-suggestion-${validated.reason}` }
  return { kind: 'offer', text: validated.text }
}

/** Delay that rejects promptly when the production task is cancelled. */
function abortableDelay(ms, signal, now) {
  return new Promise((resolve) => {
    if (signal !== undefined && signal.aborted) return resolve()
    const timer = setTimeout(() => {
      if (signal !== undefined) signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    // `now` is accepted for symmetry with future providers; nothing to compute.
    void now
    function onAbort() {
      clearTimeout(timer)
      resolve()
    }
    if (signal !== undefined) signal.addEventListener('abort', onAbort, { once: true })
  })
}
