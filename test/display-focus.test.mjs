import test from 'node:test'
import assert from 'node:assert/strict'

import { createClientRuntime } from '../src/client/controller.js'
import { nmpAdoptSuggestion, nmpClaimAndAdopt } from '../src/client/overlay.js'
import { popupChangedDuringSend } from '../src/client/dom.js'
import { DEFAULT_CONFIG } from '../src/shared/config.js'

function fixture(t, requireInputFocus = false) {
  const calls = []
  const timeline = []
  const attributes = new Map()
  const popups = []
  const runtime = createClientRuntime({
    rpc: async (operation) => {
      calls.push(operation)
      return { ok: true, value: { config: { ...DEFAULT_CONFIG, enabled: true, requireInputFocus }, capabilities: { connectionFetch: true } } }
    },
  })
  const env = {
    sessionId: 's1',
    turnId: 't1',
    branchEpoch: 'v1',
    completedEventSeq: 1,
    contextRevision: '4:1',
    hasFinalText: true,
    canEdit: true,
    draft: '',
    draftRev: 2,
    phase: 'plain',
    windowVisible: true,
    windowFocused: true,
    focused: false,
  }
  function show() {
    runtime.sync(env)
    assert.equal(runtime.debugApi().suggest('继续验证'), true)
    return runtime.assistStore.getSnapshot()
  }
  const input = {
    isConnected: true,
    isContentEditable: true,
    textContent: '',
    getAttribute: (name) => attributes.get(name) ?? null,
    hasAttribute: (name) => attributes.has(name),
    focus(opts) {
      assert.fail('adoption must not move focus')
    },
  }
  const away = {}
  const selection = { anchorNode: input, anchorOffset: 0, focusNode: input, focusOffset: 0, rangeCount: 1 }
  input.ownerDocument = { getSelection: () => selection }
  const oldDocument = globalThis.document
  const oldWindow = globalThis.window
  globalThis.document = { activeElement: away, visibilityState: 'visible', hasFocus: () => true, querySelectorAll: () => popups }
  globalThis.window = {
    getComputedStyle: (node) => ({ visibility: node.visibility }),
  }
  t.after(() => {
    globalThis.document = oldDocument
    globalThis.window = oldWindow
    runtime.dispose()
  })
  const card = { querySelector: () => input, querySelectorAll: () => [] }
  const span = { start: 0, end: 0, draftRev: 2 }
  const actions = {
    captureInsertion() {
      timeline.push('capture')
      return span
    },
    insertText(text, providedSpan) {
      assert.equal(text, '继续验证')
      assert.equal(providedSpan, span)
      timeline.push('insert')
      return true
    },
  }
  function adopt(painted) {
    return nmpAdoptSuggestion({ runtime, painted, card, actions })
  }
  return { runtime, env, show, timeline, input, attributes, adopt, calls, away, popups, span, selection, card, actions }
}

function editorWithHistory(f, overrides = {}) {
  const state = { isEmpty: () => false }
  const editor = {
    constructor: { version: '0.49.0+prod.esm' },
    getRootElement: () => f.input,
    getEditorState: () => state,
    isEditable: () => true,
    isComposing: () => false,
    read(mode, callback) {
      assert.equal(mode, 'force-commit')
      f.timeline.push('flush')
      callback()
    },
    update(callback, options) {
      assert.equal(options.discrete, true)
      assert.equal(options.skipTransforms, true)
      assert.deepEqual(options.tag, ['history-merge', 'skip-dom-selection'])
      f.timeline.push('merge')
      callback()
      options.onUpdate()
    },
    ...overrides,
  }
  f.input.__lexicalEditor = editor
  return editor
}

test('an unfocused suggestion is display-only, actual focus allows one native insertion', async (t) => {
  const f = fixture(t)
  await f.runtime.loadStatus()
  const painted = f.show()
  assert.equal(f.runtime.canDisplayOffer(f.env), true)
  assert.equal(document.activeElement, f.away)
  assert.equal(f.adopt(painted), false)
  assert.deepEqual(f.timeline, [])
  document.activeElement = f.input
  assert.equal(f.adopt(painted), true)
  assert.deepEqual(f.timeline, ['capture', 'insert'])
  assert.deepEqual(f.calls, ['status', 'accepted'])
  assert.equal(f.adopt(painted), false)
})

test('focus-only mode refuses a stale click after the editor has blurred', async (t) => {
  const f = fixture(t, true)
  await f.runtime.loadStatus()
  const painted = f.show()
  assert.equal(f.adopt(painted), false)
  assert.equal(document.activeElement, f.away)
  assert.deepEqual(f.timeline, [])
  document.activeElement = f.input
  assert.equal(f.adopt(painted), true)
  assert.deepEqual(f.timeline, ['capture', 'insert'])
})

test('live DOM gates stop adoption despite focus, including a portal popup', async (t) => {
  const f = fixture(t)
  await f.runtime.loadStatus()
  const painted = f.show()
  document.activeElement = f.input
  for (const [key, value] of [
    ['aria-readonly', 'true'], ['aria-disabled', 'true'], ['data-phase', 'sending'], ['data-composer-composing', ''],
  ]) {
    f.attributes.set(key, value)
    assert.equal(f.adopt(painted), false, key)
    f.attributes.delete(key)
  }
  f.input.textContent = 'new text'
  assert.equal(f.adopt(painted), false)
  f.input.textContent = ''
  f.popups.push({ closest: () => null, getClientRects: () => [{}], visibility: 'visible' })
  assert.equal(f.adopt(painted), false)
  assert.deepEqual(f.timeline, [])
  f.popups[0].visibility = 'hidden'
  assert.equal(f.adopt(painted), true)
  assert.deepEqual(f.timeline, ['capture', 'insert'])
})

for (const invalidation of ['attachment', 'session', 'read-only', 'native-draft', 'popup', 'blur', 'window', 'candidate', 'dismiss']) {
  test(`adoption rechecks ${invalidation} against the painted candidate`, async (t) => {
    const f = fixture(t)
    await f.runtime.loadStatus()
    const painted = f.show()
    document.activeElement = f.input
    if (invalidation === 'attachment') f.runtime.sync({ ...f.env, attachmentCount: 1 })
    if (invalidation === 'session') f.runtime.sync({ ...f.env, sessionId: 's2' })
    if (invalidation === 'read-only') f.attributes.set('aria-readonly', 'true')
    if (invalidation === 'native-draft') f.span.draftRev += 1
    if (invalidation === 'popup') f.popups.push({ closest: () => null, getClientRects: () => [{}], visibility: 'visible' })
    if (invalidation === 'blur') document.activeElement = f.away
    if (invalidation === 'window') document.visibilityState = 'hidden'
    if (invalidation === 'candidate') f.runtime.assistStore.set({ candidateIndex: 1 })
    if (invalidation === 'dismiss') f.runtime.assistStore.set({ status: 'dismissed' })
    assert.equal(f.adopt(painted), false)
    assert.deepEqual(f.timeline, invalidation === 'native-draft' ? ['capture'] : [])
    assert.deepEqual(f.calls, ['status'])
  })
}

test('a supported editor merges the empty state before exactly one native insertion', async (t) => {
  const f = fixture(t)
  await f.runtime.loadStatus()
  editorWithHistory(f)
  const painted = f.show()
  document.activeElement = f.input
  assert.equal(f.adopt(painted), true)
  assert.deepEqual(f.timeline, ['capture', 'flush', 'capture', 'merge', 'capture', 'insert'])
  assert.deepEqual(f.calls, ['status', 'accepted'])
})

test('a flush that commits pending user content never receives the history-merge tag', async (t) => {
  const f = fixture(t)
  await f.runtime.loadStatus()
  editorWithHistory(f, {
    read(mode, callback) {
      assert.equal(mode, 'force-commit')
      f.timeline.push('user-edit')
      f.span.draftRev += 1
      callback()
    },
  })
  const painted = f.show()
  document.activeElement = f.input
  assert.equal(f.adopt(painted), false)
  assert.deepEqual(f.timeline, ['capture', 'user-edit', 'capture'])
  assert.deepEqual(f.calls, ['status'])
})

for (const mode of ['selection', 'focus', 'attachment', 'reference', 'session', 'editor', 'subsequent-change', 'async', 'error']) {
  test(`a history update followed by ${mode} cannot insert a stale suggestion`, async (t) => {
    const f = fixture(t)
    await f.runtime.loadStatus()
    editorWithHistory(f, {
      update(callback, options) {
        f.timeline.push('merge')
        callback()
        if (mode === 'selection') f.selection.anchorOffset += 1
        if (mode === 'focus') document.activeElement = f.away
        if (mode === 'attachment') f.runtime.sync({ ...f.env, attachmentCount: 1 })
        if (mode === 'reference') f.runtime.sync({ ...f.env, occurrencesCount: 1 })
        if (mode === 'session') f.runtime.sync({ ...f.env, sessionId: 's2' })
        if (mode === 'editor') delete f.input.__lexicalEditor
        if (mode === 'subsequent-change') f.span.draftRev += 1
        if (mode === 'error') throw new Error('editor changed')
        if (mode !== 'async') options.onUpdate()
      },
    })
    const painted = f.show()
    document.activeElement = f.input
    assert.equal(f.adopt(painted), false)
    assert.equal(f.timeline.includes('insert'), false)
    assert.deepEqual(f.calls, ['status'])
  })
}

test('other Lexical versions and unrestorable editor states keep native insertion', async (t) => {
  const f = fixture(t)
  await f.runtime.loadStatus()
  const editor = editorWithHistory(f, { constructor: { version: '0.50.0+prod.esm' } })
  const first = f.show()
  document.activeElement = f.input
  assert.equal(f.adopt(first), true)
  assert.deepEqual(f.timeline, ['capture', 'insert'])

  editor.constructor.version = '0.49.0+prod.esm'
  editor.getEditorState = () => ({ isEmpty: () => true })
  const second = f.show()
  f.timeline.length = 0
  assert.equal(f.adopt(second), true)
  assert.deepEqual(f.timeline, ['capture', 'flush', 'capture', 'insert'])
})

test('an incompatible DOM bridge getter does not interfere with native insertion', async (t) => {
  const f = fixture(t)
  await f.runtime.loadStatus()
  Object.defineProperty(f.input, '__lexicalEditor', { get() { throw new Error('incompatible bridge') } })
  const painted = f.show()
  document.activeElement = f.input
  assert.equal(f.adopt(painted), true)
  assert.deepEqual(f.timeline, ['capture', 'insert'])
})

for (const outcome of ['grant', 'denied', 'unavailable', 'insert-refused', 'submit-throws', 'lost-focus', 'type-and-clear', 'revoked']) {
  test(`claim then adopt issues no more than one native submission: ${outcome}`, async (t) => {
    const f = fixture(t)
    await f.runtime.loadStatus()
    document.activeElement = f.input
    f.env.focused = true
    const painted = f.show()
    const aborter = new AbortController()
    let complete
    f.runtime.claimSend = () => new Promise((resolve) => { complete = resolve })
    const attempt = nmpClaimAndAdopt({
      runtime: f.runtime, painted, card: f.card, input: f.input, actions: f.actions,
      signal: aborter.signal, isCurrent: () => f.runtime.assistStore.getSnapshot() === painted,
    })
    f.actions.submit = () => {
      f.timeline.push('submit')
      if (outcome === 'submit-throws') throw Error('native submission outcome unknown')
    }
    if (outcome === 'insert-refused') f.actions.insertText = () => false
    if (outcome === 'lost-focus') document.activeElement = f.away
    if (outcome === 'revoked') aborter.abort()
    if (outcome === 'type-and-clear') {
      f.runtime.sync({ ...f.env, draftRev: 3, draft: 'user edit' })
      f.runtime.sync({ ...f.env, draftRev: 4, draft: '' })
    }
    complete(outcome === 'denied' ? 'session-state-changed' : outcome === 'unavailable' ? 'send-unavailable' : '')
    await attempt
    assert.equal(f.timeline.filter((x) => x === 'submit').length, ['grant', 'submit-throws'].includes(outcome) ? 1 : 0)
    assert.equal(f.timeline.filter((x) => x === 'insert').length, ['grant', 'submit-throws', 'unavailable'].includes(outcome) ? 1 : 0)
    if (outcome === 'submit-throws') assert.equal(f.runtime.noticeStore.getSnapshot().reason, 'send-outcome-unknown')
  })
}

test('a popup inserted and removed before observer delivery revokes a pending send', () => {
  const popup = { matches: (selector) => selector.includes('[role="dialog"]') }
  const records = [{ type: 'childList', addedNodes: [popup], removedNodes: [] },
    { type: 'childList', addedNodes: [], removedNodes: [popup] }]
  assert.equal(popupChangedDuringSend(records, {}), true)
  assert.equal(popupChangedDuringSend([{ type: 'childList', addedNodes: [{}], removedNodes: [{}] }], {}), false)
})

test('display diagnostics report eligibility and retain the last blocked observation after navigation', async (t) => {
  const { runtime, show, env } = fixture(t, true)
  await runtime.loadStatus()
  show()
  assert.equal(runtime.displayBlocker(env), 'input-not-focused')
  assert.equal(runtime.displayBlocker({ ...env, windowFocused: false }), 'window-inactive')
  assert.equal(runtime.displayBlocker({ ...env, composing: true }), 'composing')
  assert.equal(runtime.displayBlocker({ ...env, menuOpen: true }), 'menu-open')
  assert.equal(runtime.displayBlocker({ ...env, draft: 'typing' }), 'draft-not-empty')
  runtime.sync({ ...env, draft: 'typing', draftRev: 3 })
  assert.deepEqual(runtime.displayStore.getSnapshot(), { reason: 'draft-not-empty', shown: false, detached: false })
  runtime.detachView(env.sessionId)
  assert.deepEqual(runtime.displayStore.getSnapshot(), { reason: 'draft-not-empty', shown: false, detached: true })
})
