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
  GHOST_MARKER,
  editorHasFocus,
  eventInsideCard,
  findCard,
  findInput,
  findPlaceholder,
  hasOpenMenuOrDialog,
  isComposingEvent,
  lastCompletedTurn,
  measureEditor,
  pageFocused,
  pageVisible,
  readCanEdit,
  readComposing,
  readEditorWritable,
} from './dom.js'
import { DEFAULT_PREDICT_SHORTCUT, eventMatchesShortcut, formatShortcut, parseShortcut } from '../shared/config.js'
import { nmpLookupCode } from './labels.js'
import { nmpPrepareComposerUndo } from './editor-history.js'

const EMPTY_NODES = []

/** Commit only the painted candidate and only through the native synchronous edit. */
export function nmpAdoptSuggestion({ runtime, painted, card, actions }) {
  const input = findInput(card)
  if (!painted || input === null || !input.isConnected) return false
  if (!editorHasFocus(input)) return false
  if (typeof actions?.captureInsertion !== 'function' || typeof actions?.insertText !== 'function') return false
  const readOffer = () => {
    const env = runtime.getLatestEnv()
    if (env === null || env.sessionId !== painted.sessionId) return null
    const offer = runtime.prepareAdoption({
      ...env,
      canEdit: env.canEdit === true && readEditorWritable(input) && input.textContent === '' &&
        (input.getAttribute('data-phase') ?? 'plain') === 'plain',
      composing: runtime.signalsStore.getSnapshot().composing === true || readComposing(input),
      menuOpen: env.pendingInteraction === true || hasOpenMenuOrDialog(card),
      windowVisible: pageVisible(),
      windowFocused: pageFocused(),
      focused: editorHasFocus(input),
    })
    return offer?.suggestionId === painted.suggestionId && offer.index === painted.candidateIndex ? offer : null
  }
  const offer = readOffer()
  if (offer === null) return false
  let span = actions.captureInsertion()
  if (span == null || span.start !== span.end) return false
  if (span.draftRev !== offer.draftRev) {
    runtime.markInsertRejected(offer)
    return false
  }
  if (span.start === 0 && !nmpPrepareComposerUndo(input, () => {
    if (!input.isConnected || findInput(card) !== input || runtime.assistStore.getSnapshot() !== painted ||
      readOffer() === null) return false
    const currentSpan = actions.captureInsertion()
    if (currentSpan?.draftRev !== offer.draftRev || currentSpan.start !== 0 || currentSpan.end !== 0) return false
    span = currentSpan
    return true
  })) return false
  if (actions.insertText(offer.text, span) !== true) {
    runtime.markInsertRejected(offer)
    return false
  }
  runtime.markAccepted(offer)
  return true
}

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
    const visibleRef = useRef(null)
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
    const sessionState = useStore(react, runtime.sessionStore)
    const signals = useStore(react, runtime.signalsStore)
    const notice = useStore(react, runtime.noticeStore)
    // Subscribed for the interface language: render again when it changes.
    useStore(react, runtime.shellStore)
    // Strings name the predict shortcut as `{key}`; show whatever the user set.
    const keyLabel = formatShortcut(configState.config.predictShortcut)
    const tk = (key) => t(key).split('{key}').join(keyLabel)

    // Observe editor changes within the composer. Portal changes refresh the
    // snapshot only when the visible menu state changes.
    useEffect(() => {
      const card = findCard(anchorRef.current)
      if (card === null) return undefined
      let scheduled
      let portalScheduled
      let compositionEndTimer
      let menuOpen = hasOpenMenuOrDialog(card)
      const syncComposing = () => runtime.noteComposing(readComposing(findInput(card)))
      const onMutation = () => {
        if (scheduled !== undefined) return
        scheduled = setTimeout(() => {
          scheduled = undefined
          menuOpen = hasOpenMenuOrDialog(card)
          syncComposing()
          runtime.noteDomMutation()
        }, 80)
      }
      const onPortalMutation = () => {
        if (portalScheduled !== undefined) return
        portalScheduled = setTimeout(() => {
          portalScheduled = undefined
          const nextMenuOpen = hasOpenMenuOrDialog(card)
          if (menuOpen === nextMenuOpen) return
          menuOpen = nextMenuOpen
          runtime.noteDomMutation()
        }, 80)
      }
      let observer
      let portalObserver
      if (typeof MutationObserver === 'function') {
        observer = new MutationObserver(onMutation)
        observer.observe(card, {
          attributes: true,
          attributeFilter: ['data-composer-composing', 'aria-expanded', 'aria-modal', 'role', 'aria-disabled', 'aria-readonly', 'contenteditable'],
          childList: true,
          subtree: true,
        })
        if (document.body) {
          portalObserver = new MutationObserver(onPortalMutation)
          portalObserver.observe(document.body, {
            attributes: true,
            attributeFilter: ['role', 'aria-modal', 'hidden', 'inert', 'aria-hidden'],
            childList: true,
            subtree: true,
          })
        }
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
      syncComposing()
      return () => {
        if (observer !== undefined) observer.disconnect()
        portalObserver?.disconnect()
        if (scheduled !== undefined) clearTimeout(scheduled)
        if (portalScheduled !== undefined) clearTimeout(portalScheduled)
        clearTimeout(compositionEndTimer)
        document.removeEventListener('compositionstart', onCompositionStart, true)
        document.removeEventListener('compositionend', onCompositionEnd, true)
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
        canManageSession: subagent === null && !sessionRemoved,
        draft: typeof draft === 'string' ? draft : '',
        draftRev: typeof draftRev === 'number' ? draftRev : 0,
        occurrencesCount: Array.isArray(occurrences) ? occurrences.length : 0,
        attachmentCount: Array.isArray(attachmentIds) ? attachmentIds.length : 0,
        claimed: claim !== undefined && claim !== null,
        phase: typeof phase === 'string' ? phase : 'plain',
        queuedCount: Array.isArray(queue) ? queue.length : 0,
        composing: signals.composing === true || readComposing(input),
        pendingInteraction: pendingInteraction !== undefined && pendingInteraction !== null,
        menuOpen:
          (pendingInteraction !== undefined && pendingInteraction !== null) || hasOpenMenuOrDialog(card),
        windowVisible: pageVisible(),
        windowFocused: pageFocused(),
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
      runtime.canDisplayOffer(env)

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
      sessionState.available === true &&
      sessionState.sessionId === sessionId &&
      !sessionState.paused &&
      !sessionState.pending &&
      sessionState.terminal !== 'accepted' &&
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

    // The suggestion owns Tab once it has been measured and painted (`showGhost`).
    // A long one is not hidden any more: it is clamped to two lines with an
    // ellipsis and Tab still fills in the complete text (B08). Measuring goes on
    // while it shows, so resizing the composer repaints it in place.
    useLayoutEffect(() => {
      if (!visible || geometry === null) {
        setFit(null)
        return
      }
      setFit({ suggestionId: assist.suggestionId, geometry })
    }, [visible, geometry, assist.text, assist.suggestionId])

    const showGhost = visible && fit !== null && fit.suggestionId === assist.suggestionId && fit.geometry === geometry
    visibleRef.current = showGhost ? assist : null
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

    const adopt = (event, painted = visibleRef.current) => {
      if (painted === null || visibleRef.current !== painted) return
      const inserted = nmpAdoptSuggestion({
        runtime, painted, card: findCard(anchorRef.current), actions: inputActionsRef.current,
      })
      if (inserted && event !== undefined) {
        event.preventDefault()
        event.stopPropagation()
      }
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
          const state = runtime.sessionStore.getSnapshot()
          if (state.paused || state.pending) return
          if (readComposing(input) || hasOpenMenuOrDialog(ownCard) || runtime.getLatestEnv()?.pendingInteraction === true) return
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
    // Which source the entry on screen comes from. The user's own phrases (habit,
    // pinned) are marked on the chip; the mark's slot is kept for the whole ring
    // so stepping through it never shifts the layout, even in a narrow composer.
    const sources = Array.isArray(assist.sources) ? assist.sources : []
    const currentSource = sources[assist.candidateIndex] ?? 'model'
    const ringHasLocal = sources.some((source) => source !== 'model')
    const localHint = currentSource === 'habit' ? t('ghost.localHabit') : currentSource === 'pinned' ? t('ghost.localPinned') : ''
    const anotherTitle = anotherAvailable ? tk('ghost.anotherHint') : t('ghost.anotherNone')
    const chipTitle = localHint === '' ? anotherTitle : `${localHint} ${anotherTitle}`
    const ghost = visible && geometry !== null
      ? h(
          'div',
          {
            'data-nmp-ghost': showGhost ? '' : undefined,
            'data-nmp-source': currentSource,
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
          env.focused ? h(
            'button',
            {
              type: 'button',
              'data-nmp-adopt': '',
              title: t('ghost.adoptHint'),
              'aria-label': t('ghost.adoptHint'),
              tabIndex: -1,
              onMouseDown: (event) => event.preventDefault(),
              onClick: () => adopt(undefined, assist),
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
          ) : h('span', {
            'data-nmp-focus-hint': '',
            style: {
              maxWidth: '45%',
              flexShrink: 1,
              textAlign: 'end',
              overflowWrap: 'anywhere',
              color: 'var(--dsw-alias-label-secondary)',
              fontSize: '11px',
              lineHeight: '15px',
            },
          }, t('ghost.focusToAdopt')),
          // "Another one": same as pressing Alt+\ while the suggestion is showing.
          h(
            'button',
            {
              type: 'button',
              'data-nmp-another': '',
              title: chipTitle,
              'aria-label': chipTitle,
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
                display: 'inline-flex',
                alignItems: 'center',
                gap: '3px',
                whiteSpace: 'nowrap',
              },
            },
            ringHasLocal ? nmpSourceMark(h, currentSource, localHint) : null,
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

/** A compact, keyboard-accessible control in the Host's composer toolbar. */
export function createSessionPauseComponent(react, runtime, t) {
  const { createElement: h } = react
  return function SessionPauseControl({ sessionId }) {
    const configState = useStore(react, runtime.configStore)
    const state = useStore(react, runtime.sessionStore)
    const control = useStore(react, runtime.sessionControlStore)
    useStore(react, runtime.shellStore)
    if (!configState.config.enabled || control.sessionId !== sessionId || !control.show || state.sessionId !== sessionId) return null
    const action = t(state.paused ? 'ghost.sessionResume' : 'ghost.sessionPause')
    const error = state.reason === '' ? '' : nmpLookupCode(t, 'reason', state.reason)
    const disabled = state.pending || !state.available || !control.canEdit
    const hint = error || t(state.paused ? 'ghost.sessionResumeHint' : 'ghost.sessionPauseHint')
    return h('span', { style: { position: 'relative', display: 'inline-flex', flex: 'none' } },
      h('button', {
        type: 'button',
        'aria-label': action,
        'aria-pressed': state.paused,
        'aria-busy': state.pending || undefined,
        'data-nmp-session-toggle': '',
        'data-nmp-session-state': state.pending ? 'pending' : !state.available ? 'unavailable' : state.paused ? 'paused' : 'active',
        title: hint,
        disabled,
        onMouseDown: (event) => event.preventDefault(),
        onClick: () => void runtime.toggleSessionPause(sessionId),
        style: {
          display: 'inline-grid',
          placeItems: 'center',
          width: '26px',
          height: '26px',
          padding: 0,
          border: '1px solid var(--dsw-alias-border-l2)',
          borderRadius: '6px',
          background: state.paused ? 'var(--dsw-alias-interactive-bg-hover)' : 'transparent',
          color: 'var(--dsw-alias-label-secondary)',
          opacity: disabled ? 0.5 : 1,
          cursor: disabled ? 'default' : 'pointer',
        },
      }, h('svg', {
        width: 15, height: 15, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor',
        strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true,
      }, state.paused ? h('path', { d: 'M5.5 3.5l7 4.5-7 4.5z' }) : h('path', { d: 'M6 4v8m4-8v8' }))),
      error === '' ? null : h('span', {
        role: 'status',
        style: {
          position: 'absolute', width: '1px', height: '1px', overflow: 'hidden', clipPath: 'inset(50%)',
        },
      }, error),
    )
  }
}

/**
 * 11 px mark on the "another" chip for one of the user's own phrases: a pin
 * for a pinned phrase, a loop arrow for a message repeated in this session.
 * For a model candidate the slot stays, invisible, so the chip keeps its width.
 */
function nmpSourceMark(h, source, label) {
  const local = source === 'habit' || source === 'pinned'
  return h(
    'span',
    {
      'data-nmp-source-mark': local ? source : '',
      title: local ? label : undefined,
      style: { display: 'inline-flex', width: '11px', height: '11px', flex: 'none', visibility: local ? 'visible' : 'hidden' },
    },
    h(
      'svg',
      { width: 11, height: 11, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true', focusable: 'false' },
      source === 'pinned'
        ? h('path', { d: 'M6 2.5h4M7 2.5v4L4.5 9h7L9 6.5v-4M8 9v4.5' })
        : h('path', { d: 'M3 8a5 5 0 0 1 8.6-3.5M13 8a5 5 0 0 1-8.6 3.5M11.8 2.2v2.5H9.3M4.2 13.8v-2.5h2.5' }),
    ),
  )
}

function sameEnv(previous, next) {
  if (previous === next) return true
  if (previous === null || next === null) return false
  for (const key of Object.keys(next)) {
    if (previous[key] !== next[key]) return false
  }
  return true
}
