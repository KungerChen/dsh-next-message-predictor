// Ghost overlay component for dsh-next-message-predictor.
//
// Rendered into the session-scoped `conversation.input.overlay` slot. It owns
// presentation and the two composer gestures:
// - Tab: native captureInsertion()/insertText() adoption (never setDraft, never
//   submit) and only when the insertion really succeeded;
// - Esc: dismiss for this turn.
// Eligibility, dedupe and request lifecycle live in the controller. The ghost
// is an independent paint layer outside the contenteditable, so it never enters
// the draft, clipboard or send payload.
// This file is concatenated into the browser bundle: plain declarations only.

import {
  editorHasFocus,
  eventInsideCard,
  findCard,
  findInput,
  findPlaceholder,
  hasOpenMenuOrDialog,
  isComposingEvent,
  lastCompletedTurn,
  measureEditor,
  pageVisible,
  readCanEdit,
  readComposing,
} from './dom.js'
import { DEFAULT_PREDICT_SHORTCUT, eventMatchesShortcut, formatShortcut, parseShortcut } from '../shared/config.js'
import { nmpLookupCode } from './labels.js'

const EMPTY_NODES = []

/** Subscribe to a tiny store with the current snapshot. */
function useStore(react, store) {
  return react.useSyncExternalStore(store.subscribe, store.getSnapshot)
}

/**
 * Build the overlay component bound to one client runtime.
 * @param {object} react - host-provided React namespace.
 * @param {object} runtime - controller runtime.
 * @param {(key: string) => string} t - translate for the plugin namespace.
 */
export function createOverlayComponent(react, runtime, t) {
  const { createElement: h, useEffect, useLayoutEffect, useMemo, useRef, useState } = react
  let warnedMissingProps = false

  return function NextMessageGhostOverlay(props) {
    const { sessionId, useInput, inputActions, useSession, useChat, useSessionStatus } = props
    const anchorRef = useRef(null)
    const textRef = useRef(null)
    const inputActionsRef = useRef(inputActions)
    inputActionsRef.current = inputActions
    const visibleRef = useRef(false)
    const [geometry, setGeometry] = useState(null)
    const [fit, setFit] = useState(null)
    const [env, setEnv] = useState(null)

    if (typeof useChat !== 'function' || typeof useSession !== 'function' || typeof useInput !== 'function') {
      if (!warnedMissingProps) {
        warnedMissingProps = true
        console.warn('[next-message-predictor] conversation.input.overlay props are incomplete; ghost stays off')
      }
    }

    const draft = typeof useInput === 'function' ? useInput((state) => state.draft) : ''
    const draftRev = typeof useInput === 'function' ? useInput((state) => state.draftRev) : 0
    const occurrences = typeof useInput === 'function' ? useInput((state) => state.occurrences) : EMPTY_NODES
    const attachmentIds = typeof useInput === 'function' ? useInput((state) => state.attachmentIds) : EMPTY_NODES
    const claim = typeof useInput === 'function' ? useInput((state) => state.claim) : undefined
    const phase = typeof useInput === 'function' ? useInput((state) => state.phase) : 'plain'
    const queue = typeof useInput === 'function' ? useInput((state) => state.queue) : EMPTY_NODES
    const running = typeof useSession === 'function' ? useSession((state) => state.running === true) : false
    const sessionBlank = typeof useSession === 'function' ? useSession((state) => state.blank === true) : false
    const sessionRemoved = typeof useSession === 'function' ? useSession((state) => state.removed === true) : false
    const awaitingFirstTurn =
      typeof useSession === 'function' ? useSession((state) => state.awaitingFirstTurn === true) : false
    const subagent = typeof useSession === 'function' ? useSession((state) => state.subagent ?? null) : null
    const nodes = typeof useChat === 'function' ? useChat((state) => state.legacy?.nodes ?? EMPTY_NODES) : EMPTY_NODES
    const turnEnds = typeof useChat === 'function' ? useChat((state) => state.legacy?.turnEnds) : undefined
    const candidate = useMemo(() => lastCompletedTurn(nodes, turnEnds), [nodes, turnEnds])
    const pendingInteraction =
      typeof useSessionStatus === 'function' && typeof sessionId === 'string'
        ? useSessionStatus((map) => (map === undefined || map === null ? undefined : map.get(sessionId)?.pendingInteraction))
        : undefined
    const assist = useStore(react, runtime.assistStore)
    const configState = useStore(react, runtime.configStore)
    const signals = useStore(react, runtime.signalsStore)
    const notice = useStore(react, runtime.noticeStore)
    // Strings name the predict shortcut as `{key}`; show whatever the user set.
    const keyLabel = formatShortcut(configState.config.predictShortcut)
    const tk = (key) => t(key).split('{key}').join(keyLabel)

    // Scoped observers: keep IME state and menu-like DOM changes fresh without a
    // page-wide high-frequency scan. The card subtree is this composer's world.
    useEffect(() => {
      const card = findCard(anchorRef.current)
      if (card === null) return undefined
      let scheduled
      let compositionEndTimer
      const syncComposing = () => runtime.noteComposing(readComposing(findInput(card)))
      const onMutation = () => {
        if (scheduled !== undefined) return
        scheduled = setTimeout(() => {
          scheduled = undefined
          syncComposing()
          runtime.noteDomMutation()
        }, 80)
      }
      let observer
      if (typeof MutationObserver === 'function') {
        observer = new MutationObserver(onMutation)
        observer.observe(card, {
          attributes: true,
          attributeFilter: ['data-composer-composing', 'aria-expanded', 'aria-modal', 'role', 'aria-disabled'],
          childList: true,
          subtree: true,
        })
      }
      const onCompositionStart = (event) => {
        if (eventInsideCard(event, card)) runtime.noteComposing(true)
      }
      const onCompositionEnd = (event) => {
        if (!eventInsideCard(event, card)) return
        onMutation()
        clearTimeout(compositionEndTimer)
        compositionEndTimer = setTimeout(syncComposing, 0)
      }
      document.addEventListener('compositionstart', onCompositionStart, true)
      document.addEventListener('compositionend', onCompositionEnd, true)
      // B01：窗口重新获得焦点/可见时重算一轮快照，让失焦期间完成的回合补发预测。
      const onWindowActivity = () => runtime.noteDomMutation()
      window.addEventListener('focus', onWindowActivity)
      window.addEventListener('blur', onWindowActivity)
      document.addEventListener('visibilitychange', onWindowActivity)
      syncComposing()
      return () => {
        if (observer !== undefined) observer.disconnect()
        if (scheduled !== undefined) clearTimeout(scheduled)
        clearTimeout(compositionEndTimer)
        document.removeEventListener('compositionstart', onCompositionStart, true)
        document.removeEventListener('compositionend', onCompositionEnd, true)
        window.removeEventListener('focus', onWindowActivity)
        window.removeEventListener('blur', onWindowActivity)
        document.removeEventListener('visibilitychange', onWindowActivity)
      }
    }, [sessionId])

    useEffect(() => () => runtime.detachView(sessionId), [sessionId])
    useEffect(() => runtime.noteLegacy(nodes, turnEnds), [nodes, turnEnds])

    // Compute the current view snapshot from React-owned state plus DOM facts;
    // run after every render so the controller always sees the latest truth.
    useEffect(() => {
      const anchor = anchorRef.current
      const card = findCard(anchor)
      const input = findInput(card)
      const session = {
        blank: sessionBlank,
        removed: sessionRemoved,
        awaitingFirstTurn,
        subagent,
      }
      const nextEnv = {
        sessionId: typeof sessionId === 'string' ? sessionId : '',
        turnId: candidate === null ? '' : `t${candidate.turn}a${candidate.assistantSeq}`,
        completedEventSeq: candidate === null ? 0 : candidate.completedEventSeq,
        branchEpoch: 'v1',
        contextRevision: `${Array.isArray(nodes) ? nodes.length : 0}:${candidate === null ? 0 : candidate.assistantSeq}`,
        running,
        hasFinalText: candidate !== null,
        sessionBlank,
        sessionRemoved,
        awaitingFirstTurn,
        canEdit: readCanEdit(input, session),
        draft: typeof draft === 'string' ? draft : '',
        draftRev: typeof draftRev === 'number' ? draftRev : 0,
        occurrencesCount: Array.isArray(occurrences) ? occurrences.length : 0,
        attachmentCount: Array.isArray(attachmentIds) ? attachmentIds.length : 0,
        claimed: claim !== undefined && claim !== null,
        phase: typeof phase === 'string' ? phase : 'plain',
        queuedCount: Array.isArray(queue) ? queue.length : 0,
        composing: signals.composing === true,
        pendingInteraction: pendingInteraction !== undefined && pendingInteraction !== null,
        menuOpen:
          (pendingInteraction !== undefined && pendingInteraction !== null) || hasOpenMenuOrDialog(card),
        windowVisible: pageVisible(),
        windowFocused: typeof document.hasFocus === 'function' ? document.hasFocus() !== false : true,
        focused: editorHasFocus(input),
        inputMissing: input === null,
      }
      setEnv((previous) => (sameEnv(previous, nextEnv) ? previous : nextEnv))
      runtime.sync(nextEnv)
    })

    const visible =
      assist.status === 'offered' &&
      assist.text !== '' &&
      env !== null &&
      env.sessionId === sessionId &&
      !running &&
      candidate?.completedEventSeq === assist.completedEventSeq &&
      draft === '' &&
      draftRev === assist.offerDraftRev &&
      signals.composing !== true &&
      runtime.prepareAdoption(env) !== null

    // Manual trigger feedback: same grey text position as a suggestion, but it is
    // not a suggestion (no Tab, no ghost marker). Only for this session's empty input.
    let noticeText = ''
    if (!visible && notice.kind !== '' && notice.sessionId === sessionId && draft === '' && signals.composing !== true) {
      if (notice.kind === 'predicting') noticeText = t('ghost.predicting')
      else {
        // "The model had nothing to say" needs no further explanation.
        const reasonText = notice.reason === 'model-abstained' ? '' : nmpLookupCode(t, 'reason', notice.reason)
        noticeText = reasonText === '' ? t('ghost.none') : `${t('ghost.none')}${t('ghost.noneBecause')}${reasonText}`
      }
    }
    // A "no suggestion" notice leaves by itself; typing or a new turn clears it sooner.
    useEffect(() => {
      if (notice.kind !== 'none') return undefined
      const timer = setTimeout(() => runtime.clearNotice(), 3500)
      return () => clearTimeout(timer)
    }, [notice.kind, notice.at])
    useEffect(() => {
      if (notice.kind !== '' && (draft !== '' || notice.sessionId !== sessionId)) runtime.clearNotice()
    }, [notice.kind, draft, sessionId])

    // Always-there "predict" button at the right edge of the empty input: the
    // mouse equivalent of Alt+\. Hidden while typing (it would sit on the text),
    // while a suggestion shows (that has its own chips) and while a request runs.
    const wantButton =
      configState.ready === true &&
      configState.config.enabled === true &&
      configState.config.showPredictButton !== false &&
      !visible &&
      env !== null &&
      env.sessionId === sessionId &&
      draft === '' &&
      env.canEdit === true &&
      env.phase === 'plain' &&
      signals.composing !== true &&
      assist.status !== 'requesting' &&
      assist.status !== 'conflict' &&
      notice.kind !== 'predicting'

    // Measure the live editor and mirror its typography, including after resizing.
    useLayoutEffect(() => {
      if (!visible && noticeText === '' && !wantButton) {
        setGeometry(null)
        return undefined
      }
      const anchor = anchorRef.current
      const card = findCard(anchor)
      const input = findInput(card)
      if (anchor === null || card === null || input === null) return undefined
      const measure = () => {
        const next = measureEditor(anchor, card, input)
        setGeometry((previous) => sameEnv(previous, next) ? previous : next)
      }
      measure()
      const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null
      if (observer !== null) {
        observer.observe(input)
        observer.observe(card)
      }
      window.addEventListener('resize', measure)
      window.addEventListener('scroll', measure, true)
      return () => {
        if (observer !== null) observer.disconnect()
        window.removeEventListener('resize', measure)
        window.removeEventListener('scroll', measure, true)
        setGeometry(null)
      }
    }, [visible, noticeText !== '', wantButton, assist.text, assist.suggestionId, env === null ? '' : env.draft])

    // Only a fully visible suggestion owns Tab. Keep measuring a hidden
    // suggestion so widening the window can make it available again.
    // B08：超过两行不再整条隐藏；用两行省略号显示，Tab 仍填入完整建议。
    useLayoutEffect(() => {
      if (!visible || geometry === null) {
        setFit(null)
        return
      }
      setFit({ suggestionId: assist.suggestionId, geometry })
    }, [visible, geometry, assist.text, assist.suggestionId])

    const showGhost = visible && fit !== null && fit.suggestionId === assist.suggestionId && fit.geometry === geometry
    visibleRef.current = showGhost
    // O01: 只有真正画到输入框上的建议才上报 shown（用于展示率/采纳率）。
    const shownReportedRef = useRef('')
    useEffect(() => {
      if (!showGhost) return
      if (assist.suggestionId === '' || shownReportedRef.current === assist.suggestionId) return
      shownReportedRef.current = assist.suggestionId
      runtime.noteShown()
    }, [showGhost, assist.suggestionId, runtime])
    const showNotice = !showGhost && noticeText !== '' && geometry !== null
    useLayoutEffect(() => {
      if (!showGhost && !showNotice) return undefined
      const placeholder = findPlaceholder(findCard(anchorRef.current))
      if (placeholder === null) return undefined
      const previousVisibility = placeholder.style.visibility
      placeholder.style.visibility = 'hidden'
      placeholder.setAttribute('data-nmp-placeholder', '')
      return () => {
        placeholder.style.visibility = previousVisibility
        placeholder.removeAttribute('data-nmp-placeholder')
      }
    }, [showGhost, showNotice, sessionId])

    // Synchronous adoption: read the offer, verify every condition, then use the
    // native insertion API. Swallow the key only after insertText returns true.
    const adopt = (event) => {
      if (!visibleRef.current) return false
      const currentEnv = runtime.getLatestEnv()
      if (currentEnv === null) return false
      const actions = inputActionsRef.current
      if (actions === undefined || actions === null) return false
      if (typeof actions.captureInsertion !== 'function' || typeof actions.insertText !== 'function') return false
      const card = findCard(anchorRef.current)
      const input = findInput(card)
      if (card === null || input === null) return false
      if (!editorHasFocus(input)) return false
      if (readComposing(input)) return false
      if (hasOpenMenuOrDialog(card)) return false
      if (currentEnv.pendingInteraction === true) return false
      if (currentEnv.queuedCount > 0 || currentEnv.claimed === true) return false
      if (currentEnv.phase !== 'plain' || currentEnv.canEdit !== true) return false
      const offer = runtime.prepareAdoption(currentEnv)
      if (offer === null) return false
      const span = actions.captureInsertion()
      if (span === null || span === undefined) return false
      if (span.start !== span.end) return false
      if (span.draftRev !== offer.draftRev) {
        // The draft changed after the offer: hide it, but let the native key run.
        runtime.markInsertRejected(offer)
        return false
      }
      const inserted = actions.insertText(offer.text, span)
      if (inserted !== true) {
        runtime.markInsertRejected(offer)
        return false
      }
      if (event !== undefined && event !== null) {
        event.preventDefault()
        event.stopPropagation()
      }
      runtime.markAccepted(offer)
      return true
    }

    // Tab adopts, Esc dismisses — captured before the composer keymap and only
    // for this exact card/editor/offer. Any failure falls through untouched.
    useEffect(() => {
      const onKeyDown = (event) => {
        if (event.defaultPrevented === true || event.repeat === true) return
        // The predict shortcut (Alt+\ unless changed in settings) asks for one
        // prediction now; it is the only shortcut here that uses a modifier.
        const manualChord = eventMatchesShortcut(
          event,
          parseShortcut(runtime.configStore.getSnapshot().config.predictShortcut) ?? parseShortcut(DEFAULT_PREDICT_SHORTCUT),
        )
        if (!manualChord && (event.shiftKey || event.ctrlKey || event.altKey || event.metaKey)) return
        if (isComposingEvent(event)) return
        if (runtime.signalsStore.getSnapshot().composing === true) return
        const target = event.target
        if (target === null || target === undefined) return
        if (typeof target.isContentEditable !== 'boolean' || target.isContentEditable !== true) return
        const ownCard = findCard(anchorRef.current)
        if (ownCard === null) return
        if (!eventInsideCard(event, ownCard)) return
        const input = findInput(ownCard)
        if (!editorHasFocus(input) || !input.contains(target)) return
        if (manualChord) {
          // Off means off: with the feature disabled the key is left alone.
          if (runtime.configStore.getSnapshot().config.enabled !== true) return
          event.preventDefault()
          event.stopPropagation()
          runtime.predictNow()
          return
        }
        if (!visibleRef.current) return
        if (event.key === 'Tab') {
          adopt(event)
          return
        }
        // O06: 空草稿且光标在开头时，右方向键也可填入（不干扰正常光标移动）。
        if (event.key === 'ArrowRight' && input.textContent === '') {
          const selection = window.getSelection()
          if (selection !== null && selection.rangeCount > 0) {
            const range = selection.getRangeAt(0)
            if (range.collapsed && range.startOffset === 0 && input.contains(range.startContainer)) {
              adopt(event)
            }
          }
          return
        }
        if (event.key === 'Escape') {
          const currentEnv = runtime.getLatestEnv()
          if (!readComposing(input) && !hasOpenMenuOrDialog(ownCard) && runtime.dismissCurrent(currentEnv)) {
            event.preventDefault()
            event.stopPropagation()
          }
        }
      }
      document.addEventListener('keydown', onKeyDown, true)
      return () => document.removeEventListener('keydown', onKeyDown, true)
    }, [])

    const announce = configState.config.announceSuggestions !== false
    // Nothing left to switch to and no manual predictions left on this reply.
    const anotherAvailable = runtime.canOfferAnother()
    const ghost = visible && geometry !== null
      ? h(
          'div',
          {
            'data-nmp-ghost': showGhost ? '' : undefined,
            'data-composer-ghost': showGhost ? GHOST_MARKER : undefined,
            'aria-hidden': !showGhost ? 'true' : undefined,
            role: 'status',
            'aria-live': announce ? 'polite' : 'off',
            'aria-atomic': 'true',
            style: {
              position: 'absolute',
              top: `${geometry.top}px`,
              left: `${geometry.left}px`,
              width: `${geometry.width}px`,
              maxHeight: `${(geometry.lineHeightPx || 20) * 2}px`,
              display: 'flex',
              alignItems: 'flex-start',
              gap: '8px',
              visibility: showGhost ? 'visible' : 'hidden',
              fontFamily: geometry.fontFamily,
              fontSize: geometry.fontSize,
              fontWeight: geometry.fontWeight,
              lineHeight: geometry.lineHeight,
              letterSpacing: geometry.letterSpacing,
              color: 'var(--dsw-alias-label-caption)',
              whiteSpace: 'pre-wrap',
              overflow: 'hidden',
              pointerEvents: 'none',
              userSelect: 'none',
              zIndex: 2,
            },
          },
          h('span', {
            ref: textRef,
            style: {
              flex: 1,
              minWidth: 0,
              overflowWrap: 'anywhere',
              // B08: 超过两行显示省略号；Tab 采纳仍使用完整文本。
              display: '-webkit-box',
              WebkitLineClamp: 2,
              WebkitBoxOrient: 'vertical',
              overflow: 'hidden',
            },
          }, assist.text),
          h(
            'button',
            {
              type: 'button',
              'data-nmp-adopt': '',
              title: t('ghost.adoptHint'),
              'aria-label': t('ghost.adoptHint'),
              tabIndex: -1,
              onMouseDown: (event) => event.preventDefault(),
              onClick: () => {
                adopt(undefined)
              },
              style: {
                flex: 'none',
                pointerEvents: 'auto',
                border: '1px solid var(--dsw-alias-border-l2)',
                borderRadius: '6px',
                background: 'var(--dsw-alias-bg-layer-1)',
                color: 'var(--dsw-alias-label-tertiary)',
                font: 'inherit',
                fontSize: '11px',
                lineHeight: '18px',
                padding: '0 6px',
                cursor: 'pointer',
              },
            },
            t('ghost.adopt'),
          ),
          // "Another one": same as pressing Alt+\ while the suggestion is showing.
          h(
            'button',
            {
              type: 'button',
              'data-nmp-another': '',
              title: anotherAvailable ? tk('ghost.anotherHint') : t('ghost.anotherNone'),
              'aria-label': anotherAvailable ? tk('ghost.anotherHint') : t('ghost.anotherNone'),
              'aria-disabled': anotherAvailable ? undefined : 'true',
              tabIndex: -1,
              onMouseDown: (event) => event.preventDefault(),
              onClick: () => {
                if (anotherAvailable) runtime.predictNow()
              },
              style: {
                flex: 'none',
                pointerEvents: 'auto',
                border: '1px solid var(--dsw-alias-border-l2)',
                borderRadius: '6px',
                background: 'var(--dsw-alias-bg-layer-1)',
                color: 'var(--dsw-alias-label-tertiary)',
                font: 'inherit',
                fontSize: '11px',
                lineHeight: '18px',
                padding: '0 6px',
                cursor: anotherAvailable ? 'pointer' : 'default',
                opacity: anotherAvailable ? 1 : 0.45,
              },
            },
            // With several candidates in hand, say which one is showing.
            assist.candidates.length > 1 ? `${t('ghost.another')} ${assist.candidateIndex + 1}/${assist.candidates.length}` : t('ghost.another'),
          ),
        )
      : null

    const noticeNode = showNotice
      ? h(
          'div',
          {
            'data-nmp-notice': notice.kind,
            role: 'status',
            'aria-live': 'polite',
            style: {
              position: 'absolute',
              top: `${geometry.top}px`,
              left: `${geometry.left}px`,
              // Leave room for the predict button at the right edge.
              width: `${Math.max(40, geometry.width - (wantButton ? 64 : 0))}px`,
              fontFamily: geometry.fontFamily,
              fontSize: geometry.fontSize,
              fontWeight: geometry.fontWeight,
              lineHeight: geometry.lineHeight,
              letterSpacing: geometry.letterSpacing,
              color: 'var(--dsw-alias-label-caption)',
              fontStyle: 'italic',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              pointerEvents: 'none',
              userSelect: 'none',
              zIndex: 2,
            },
          },
          noticeText,
        )
      : null

    return h(
      'div',
      {
        ref: anchorRef,
        'data-nmp-anchor': '',
        style: { position: 'absolute', top: 0, left: 0, right: 0, height: 0, pointerEvents: 'none' },
      },
      ghost,
      noticeNode,
      wantButton && geometry !== null
        ? h(
            'button',
            {
              type: 'button',
              'data-nmp-predict': '',
              title: tk('ghost.predictHint'),
              'aria-label': tk('ghost.predictHint'),
              tabIndex: -1,
              // Keep the caret in the input: the click must not move focus.
              onMouseDown: (event) => event.preventDefault(),
              onClick: () => {
                runtime.predictNow()
              },
              style: {
                position: 'absolute',
                top: `${geometry.top}px`,
                // Right edge of the editor's text area, whatever the label's width.
                left: `${geometry.left + geometry.width}px`,
                transform: 'translateX(-100%)',
                pointerEvents: 'auto',
                border: '1px solid var(--dsw-alias-border-l2)',
                borderRadius: '6px',
                background: 'var(--dsw-alias-bg-layer-1)',
                color: 'var(--dsw-alias-label-tertiary)',
                fontFamily: geometry.fontFamily,
                fontSize: '11px',
                lineHeight: '18px',
                padding: '0 6px',
                cursor: 'pointer',
                whiteSpace: 'nowrap',
                zIndex: 2,
              },
            },
            t('ghost.predict'),
          )
        : null,
    )
  }
}

function sameEnv(previous, next) {
  if (previous === next) return true
  if (previous === null || next === null) return false
  for (const key of Object.keys(next)) {
    if (previous[key] !== next[key]) return false
  }
  return true
}
