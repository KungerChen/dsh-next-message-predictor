// Turning machine codes into words the user can read.
//
// The Host and the controller report states and reasons as short codes
// (`manual-limit`, `stale:config-changed`, `prepare-failed:model not found`).
// Settings and the composer notice both show them, so the lookup lives here.
// This file is concatenated into the browser bundle: plain declarations only.

/** Key form of a code: lower case, every run of other characters becomes "-". */
export function nmpCodeKey(code) {
  return code.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase()
}

/**
 * Translate a machine code under a prefix (`reason`, `state`).
 *
 * Lookup order, first hit wins:
 *   0. a named special case         `…unsupported-reasoning-effort…`
 *   1. the whole code               `no-route:fixed-route-incomplete`
 *   2. the part before the detail   `prepare-failed:<provider message>` -> `prepare-failed`
 *   3. the code family              `finish-max-tokens` -> `finish`, `output-too-long` -> `output`
 * `stale:<reason>` is how the client marks a Host "too late" answer; the reason
 * itself is what matters, so the marker is dropped first.
 *
 * @param {(key: string) => string} t - translate; returns the key itself when missing.
 * @returns {string} the translation, or '' when there is none (callers choose the fallback).
 */
export function nmpLookupCode(t, prefix, code) {
  if (typeof code !== 'string' || code === '') return ''
  const bare = code.replace(/^stale:/, '')
  const candidates = [bare]
  // An effort level the model does not offer is a settings problem with its own wording.
  if (bare.includes('unsupported-reasoning-effort')) candidates.unshift('unsupported-reasoning-effort')
  const colon = bare.indexOf(':')
  if (colon > 0) candidates.push(bare.slice(0, colon))
  const family = /^(semantic|finish|output|fixed-suggestion|invalid-response|conflict)\b/.exec(bare)
  if (family !== null) candidates.push(family[1])
  for (const candidate of candidates) {
    const key = `${prefix}.${nmpCodeKey(candidate)}`
    const text = t(key)
    if (typeof text === 'string' && text !== '' && text !== key) return text
  }
  return ''
}

/** Translate a machine code; fall back to the raw code so nothing is hidden. */
export function nmpCodeLabel(t, prefix, code) {
  if (typeof code !== 'string' || code === '') return ''
  const text = nmpLookupCode(t, prefix, code)
  return text === '' ? code : text
}
