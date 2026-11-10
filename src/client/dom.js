// Browser-side DOM helpers for dsh-next-message-predictor.
//
// Selector knowledge for the host composer lives here. Verified against
// DSH 0.2.2-rc.1 client (dsh-client-ui-conversation lib/client.js):
//   [data-composer-card]        composer card (position:relative container)
//   [data-composer-overlay]     zero-height anchor that hosts this slot
//   [data-composer-input]       shell-owned Lexical contenteditable
//   [data-composer-placeholder] native placeholder div (sibling AFTER the editor)
//   [data-composer-composing]   IME marker toggled on the editor root
//   [data-trigger-menu]         / and @ candidate menu (when open)
//   [role="dialog"][aria-modal="true"] shell modal (feedback dialog portals to body)
// This file is concatenated into the browser bundle: plain declarations only.

export const CARD_SELECTOR = '[data-composer-card]'
export const INPUT_SELECTOR = '[data-composer-input]'
export const PLACEHOLDER_SELECTOR = '[data-composer-placeholder]'
export const COMPOSING_ATTR = 'data-composer-composing'

/** Nearest composer card for one rendered anchor element, or null. */
export function findCard(anchor) {
  if (anchor === null || anchor === undefined) return null
  if (typeof anchor.closest !== 'function') return null
  return anchor.closest(CARD_SELECTOR)
}

/** The editable element inside one composer card, or null. */
export function findInput(card) {
  if (card === null || card === undefined) return null
  if (typeof card.querySelector !== 'function') return null
  return card.querySelector(INPUT_SELECTOR)
}

/** Whether the editor root carries the host IME composition marker. */
export function readComposing(input) {
  if (input === null || input === undefined) return false
  return typeof input.hasAttribute === 'function' && input.hasAttribute(COMPOSING_ATTR)
}

/** Whether a keyboard event belongs to an IME composition. */
export function isComposingEvent(event) {
  if (event === null || event === undefined) return false
  return event.isComposing === true || event.keyCode === 229
}

/** Whether the event target is inside this composer card. */
export function eventInsideCard(event, card) {
  if (event === null || event === undefined) return false
  if (card === null || card === undefined) return false
  const target = event.target
  if (target === null || target === undefined) return false
  if (typeof card.contains === 'function' && card.contains(target)) return true
  return target === card
}

/** Whether the editor itself is the focused control. */
export function editorHasFocus(input) {
  if (input === null || input === undefined) return false
  if (typeof document === 'undefined') return false
  return document.activeElement === input
}

/** Whether the editor is writable (DOM-level check; InputActions re-checks). */
export function readEditorWritable(input) {
  if (input === null || input === undefined) return false
  if (typeof input.getAttribute === 'function' && input.getAttribute('aria-disabled') === 'true') return false
  if (typeof input.isContentEditable === 'boolean' && input.isContentEditable === false) return false
  return true
}

/** Menus/popups rendered inside one composer card. */
const CARD_MENU_SELECTORS = [
  '[role="listbox"]',
  '[role="menu"]',
  '[role="alertdialog"]',
  '[aria-haspopup][aria-expanded="true"]',
]

/** Shell-level dialogs (feedback modal portals to the document body). */
const PAGE_DIALOG_SELECTORS = [
  '[data-trigger-menu]',
  '[role="dialog"][aria-modal="true"]',
  '[role="alertdialog"]',
]

/**
 * Heuristic "a menu / popup / modal occupies the interaction".
 *
 * The / and @ candidate menu uses `[data-trigger-menu]`. Command popup and
 * feedback dialog have no stable data marker; they move focus away from the
 * editor (handled by the caller's focus requirement) and may render a listbox
 * or a modal. Over-applying the guard only suppresses an offer, never steals a
 * key, so the check stays conservative.
 */
export function hasOpenMenuOrDialog(card) {
  if (typeof document === 'undefined' || document === null) return false
  if (card !== null && card !== undefined && typeof card.querySelector === 'function') {
    for (const selector of CARD_MENU_SELECTORS) {
      if (card.querySelector(selector) !== null) return true
    }
  }
  for (const selector of PAGE_DIALOG_SELECTORS) {
    if (document.querySelector(selector) !== null) return true
  }
  return false
}

/** Whether the page is currently visible (not a hidden tab / minimized window). */
export function pageVisible() {
  if (typeof document === 'undefined' || document === null) return false
  if (document.visibilityState === 'hidden') return false
  return true
}

/** Find the native placeholder element inside one card. */
export function findPlaceholder(card) {
  if (card === null || card === undefined) return null
  if (typeof card.querySelector !== 'function') return null
  return card.querySelector(PLACEHOLDER_SELECTOR)
}

/**
 * Read the editor font/style geometry the ghost must mirror.
 * @returns {object | null} null when the editor cannot be measured yet.
 */
export function measureEditor(anchor, card, input) {
  if (anchor === null || card === null || input === null) return null
  const hostRect = anchor.getBoundingClientRect()
  const inputRect = input.getBoundingClientRect()
  if (inputRect.width < 8) return null
  const style = window.getComputedStyle(input)
  const fontSizePx = Number.parseFloat(style.fontSize)
  const lineHeightPx = Number.parseFloat(style.lineHeight) || (Number.isFinite(fontSizePx) ? fontSizePx * 1.5 : 20)
  // B09g: 用编辑器实际内边距定位幽灵文字，不再写死 +4/+14 与 -22。
  const paddingTop = Number.parseFloat(style.paddingTop) || 0
  const paddingLeft = Number.parseFloat(style.paddingLeft) || 0
  const paddingRight = Number.parseFloat(style.paddingRight) || 0
  return {
    top: Math.round(inputRect.top - hostRect.top + paddingTop),
    left: Math.round(inputRect.left - hostRect.left + paddingLeft),
    width: Math.max(48, Math.round(inputRect.width - paddingLeft - paddingRight)),
    fontFamily: style.fontFamily,
    fontSize: style.fontSize,
    fontWeight: style.fontWeight,
    lineHeight: style.lineHeight,
    lineHeightPx,
    letterSpacing: style.letterSpacing,
  }
}

/** Text blocks of one assistant node, for "has final assistant text" checks. */
export function assistantText(node) {
  if (node === null || typeof node !== 'object') return ''
  const blocks = Array.isArray(node.blocks) ? node.blocks : []
  const parts = []
  for (const block of blocks) {
    if (block !== null && typeof block === 'object' && block.kind === 'text' && typeof block.text === 'string') {
      parts.push(block.text)
    }
  }
  return parts.join('\n').trim()
}

/**
 * Find the latest finished turn with visible assistant text.
 *
 * Client-visible limits (documented as a P1/P2 gap): the raw
 * `turn/end.reason.kind` is not exposed to slot components. `legacy.turnEnds`
 * gives the turn/end event sequence and non-completed turns additionally append
 * a `turn-error` / `turn-max-tokens` view node, so those derived rows are
 * excluded here. The Host also checks the raw completion event.
 *
 * @param {readonly any[]} nodes - `useChat(state => state.legacy.nodes)`.
 * @param {Map<number, number> | undefined} turnEnds - `useChat(state => state.legacy.turnEnds)`.
 * @returns {{turn:number, assistantSeq:number, completedEventSeq:number, text:string} | null}
 */
export function lastCompletedTurn(nodes, turnEnds) {
  if (!Array.isArray(nodes)) return null
  let sawUserTail = false
  for (let i = nodes.length - 1; i >= 0; i -= 1) {
    const node = nodes[i]
    if (node === null || typeof node !== 'object') continue
    if (node.kind === 'user' || node.kind === 'steering') {
      // A user message newer than the last assistant node means the next turn
      // already started; never attribute the older assistant text to it.
      sawUserTail = true
      continue
    }
    if (node.kind !== 'assistant') continue
    if (sawUserTail) return null
    if (node.interrupted === true) return null
    const text = assistantText(node)
    if (text === '') return null
    const turn = typeof node.turn === 'number' ? node.turn : 0
    const endSeq = turnEnds !== undefined && turnEnds !== null && typeof turnEnds.get === 'function'
      ? turnEnds.get(turn)
      : undefined
    if (typeof endSeq !== 'number') return null
    const failed = nodes.some(
      (other) =>
        other !== null &&
        typeof other === 'object' &&
        (other.kind === 'turn-error' || other.kind === 'turn-max-tokens') &&
        other.turn === turn,
    )
    if (failed) return null
    return {
      turn,
      assistantSeq: typeof node.seq === 'number' ? node.seq : 0,
      completedEventSeq: endSeq,
      text,
    }
  }
  return null
}

/** Whether the client can edit the composer right now (DOM + session facts). */
export function readCanEdit(input, session) {
  if (!readEditorWritable(input)) return false
  if (session === null || session === undefined) return false
  if (session.removed === true) return false
  if (session.subagent != null) return false
  return true
}

/** O07: the value this plugin writes to `data-composer-ghost`. */
export const GHOST_MARKER = 'dsh-next-message-predictor'

/**
 * O07: detect another ghost-text plugin in the composer.
 * `[data-composer-ghost]` with a different namespace, or the legacy
 * `window.__composerPredict` global, means this plugin should step aside.
 * Pure function over injected document/window so it can be unit-tested.
 * @returns {{source:string}|null}
 */
export function detectGhostConflict(doc, win, ownNamespace) {
  if (doc === null || doc === undefined || typeof doc.querySelectorAll !== 'function') return null
  const nodes = doc.querySelectorAll('[data-composer-ghost]')
  for (const node of nodes) {
    const value = node !== null && node !== undefined && typeof node.getAttribute === 'function'
      ? node.getAttribute('data-composer-ghost')
      : null
    if (value !== ownNamespace) return { source: `composer-ghost:${value ?? ''}` }
  }
  if (win !== null && win !== undefined && typeof win.__composerPredict !== 'undefined') {
    return { source: 'composer-predict-global' }
  }
  return null
}
