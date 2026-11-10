# P0 Client Contract — `dsh-next-message-predictor`

Target: **DSH Desktop 0.2.2-rc.1** (installed build `<DSH install dir>\resources\app.asar`, 213,202,918 bytes; package versions verified in `dsh/node_modules/@deepseek-ai/*/package.json`).
Date: 2026-11-09.
Deliverable of P0; the client half of P1 must be implementable from this document alone.

**Status legend** — `confirmed`: direct code/JSDoc/README evidence in the installed build; `partial`: derived from side effects, identity or DOM, must be re-checked at runtime/E2E; `unsatisfied`: no client-side capability exists (must degrade or do host-side).

---

## 0. P1 verdict in one table

| P1 requirement | Verdict | Exact API / mechanism | Evidence |
|---|---|---|---|
| Ghost text in empty composer after assistant turn | **possible** | `ctx.slots.inject('conversation.input.overlay', () => ctx.slots.register({name,id,order,locale,inject}, Component))`; component renders inside `[data-composer-overlay]` anchor of its own `[data-composer-card]` | CONV 22958–22969, 22025–22029; RENDERER 663–702 |
| Tab adopts via native insertion (not `setDraft`) | **possible** | `inputActions.captureInsertion()` → `inputActions.insertText(text, span)`; both on the `inputActions` standard prop | CONV 15370–15378; CONV_README 183 |
| Ctrl+Z undoes only the insertion | **likely, needs E2E** | `insertText` → `insertAsyncText` applies one discrete edit tagged `Co = "paste"` (own history boundary), plain-text path sanitizes chip placeholders | CONV 15119–15126, 7692, 15065–15084, 14863–14869 |
| Esc dismisses | **possible** | DOM capture `keydown`, same guards as Tab; consume only while offer visible and no menu/IME | CONV 21203–21215; TRIGGER 1174–1218; REF 1483–1519 |
| IME guard | **partial (marker confirmed, no hook)** | `[data-composer-composing]` attribute on the editor root, toggled by `registerComposerKeymap`; plus `event.isComposing` / `keyCode===229` / `aria` state | CONV 21164–21198; REF 288–297 |
| Menus / dialogs / approval / question / plan guard | **slash-menu confirmed; popup/dialog partial; structured panels confirmed** | `[data-trigger-menu]` for `/`+`@`; `useSessionStatus(map => map.get(sessionId)?.pendingInteraction)` for approval/question/plan-review; composer takeover unmounts the overlay | TRIGGER 1732–1735; SESSION 992–1008; APPROVAL 468–474; QUESTIONS 185, 2249–2269 |
| Multiple inputs | **partial** | identify own composer from the component's own DOM (`ref.closest('[data-composer-card]')`) and require `document.activeElement === card.querySelector('[data-composer-input]')`; no global active-composer API | CONV 22025–22029; REF 819–823 |
| Clean uninstall / HMR | **possible** | all listeners/observers/styles through `ctx.effect(...)` / `ctx.slots.inject(...)`; entry teardown runs those disposers, then evicts the module + owned styles | MODULES_README 47; HMR_README 36, 48, 66 |

**Hard blocker found: none that invalidates P1.** Type declarations are not shipped (see §11.2), live client Inspect queries time out (§1.3), and `turn/end.reason.kind` is not exposed client-side (§6.4) — all three have documented workarounds below.

---

## 1. Evidence base and method

### 1.1 Path legend (all archive paths relative to `<DSH install dir>\resources\app.asar\`)

| Alias | Archive path | Notes |
|---|---|---|
| `CONV` | `dsh/node_modules/@deepseek-ai/dsh-client-ui-conversation/lib/client.js` | 23,145 lines; the composer/input/slot owner |
| `CONV_README` | `.../dsh-client-ui-conversation/README.md` | package reference shipped in the archive |
| `SESSION` | `.../dsh-client-ui-session/lib/client.js` | `uiSession` provider, `sessionStatus` |
| `CHAT` | `.../dsh-client-ui-chat/lib/client.js` | `useChat` provider, legacy node projection |
| `TRIGGER` / `TRIGGER_README` | `.../dsh-client-ui-input-trigger/lib/client.js` / `README.md` | `/`+`@` candidate menu (`slash-menu` overlay entry) |
| `COMMANDS` | `.../dsh-client-ui-commands/lib/client.js` | `command-popup` overlay entry |
| `FEEDBACK` | `.../dsh-client-ui-message-feedback/lib/client.js` | `feedback-dialog` overlay entry |
| `QUESTIONS` | `.../dsh-client-ui-user-questions/lib/client.js` | `PendingQuestion`, composer takeover |
| `APPROVAL` | `.../dsh-client-ui-approval/lib/client.js` | `PendingApproval`, composer takeover |
| `PLAN` | `.../dsh-client-ui-plan/lib/client.js` | plan chip, plan-review |
| `SESSCTRL` | `.../dsh-api-session-controller/lib/client.js` | `SessionSnapshot` builder |
| `RENDERER` | `.../dsh-client-ui-renderer/lib/client.js` | slot runtime (standard props, renderSlot, error boundaries) |
| `MODULES` / `MODULES_README` | `.../dsh-client-modules/lib/index.js` / `README.md` | client manifest + `window.__ModuleLoader__` boot graph |
| `CONN` / `CONN_README` | `.../dsh-client-connection/lib/client.browser.js` / `README.md` | `ctx.connection`, RPC, auth/cookie |
| `LOCALE_README` | `.../dsh-client-locale/README.md` | `ctx.locale.register`, `t` seat |
| `SHORTCUTS_README` | `.../dsh-client-shortcuts/README.md` | app-level shortcuts service (not the composer keymap) |
| `HMR_README` | `.../dsh-client-hmr/README.md` | rebuild/remount/unload behavior |
| `REF` / `REF_README` | `<DSH_HOME>\profiles\desktop\node_modules\dsh-composer-prediction\lib\client.js` / `README.md` | **MIT prior art, not a DSH contract**; installed 0.7.8, README says verified on 0.2.1-rc.2 |
| `DESIGN` | `DSH预测消息插件优化完整方案.md` (not in this repository) | the approved design |

Grep-friendly byte-identical copies of the archive files exist in `.dsh-recon\dsh\node_modules\@deepseek-ai\...` (a local read-only extraction outside this repository; line numbers match the archive reads used here).

### 1.2 What is *not* in the installed build

- **No `.d.ts` files at all** in the archive (0 matches for `*.d.ts`), and **no `src/`** for client UI packages. The only type-like evidence is JSDoc in the built bundles plus the shipped package READMEs. `package.json` declares `lib/types/index.d.ts`, but the file does not exist in the archive.
- **`@deepseek-ai/dsh-client-ui-slots` is a platform-seeded module**, not a package on disk: bundles `require("@deepseek-ai/dsh-client-ui-slots")`, and the implementation is bundled in the shell (`dsh-web-frontend/dist/assets/index-*.js`, where the module table maps it to `MI`). Its type declarations are unavailable; the slot option/prop contract below is reconstructed from every shipped registration + the renderer that consumes it (RENDERER) — mark option-level details `partial`.
- No `app.asar.unpacked` copies of DSH client packages (only native modules), so the archive itself is the only source.

### 1.3 Live introspection status

Live client Inspect queries were tried 4 times for `Slots.listSubTree` (root `conversation.input.overlay`) and once each for client `Service.listService`, `Event.listEvents`, `Builtin.listBuiltins`: **all timed out after 10 s** ("Slots.listSubTree: Client inspect query timed out after 10000ms"). The desktop page did not answer Inspect queries in this setup. **All client claims in this document are static-evidence claims**; host-side claims live in the other P0 document (`p0-host-contract.md`). The client Inspect query can be repeated from the GUI's own session if a dynamic double-check is wanted; nothing in P1 depends on it.

---

## 2. Slot contract: `conversation.input.overlay`

### 2.1 Declaration

`CONV` declares the composer bar and its child overlay slot:

```
22958  const registerComposerBar = () => slots.register({
22959    name: "conversation.composer.bar",
22960    locale: NS,
22961    children: {
...
22966      "conversation.input.overlay": {
22967        kind: "list",
22968        scope: "session"
22969      },
```

It is a **list slot, scope `session`**, child of `conversation.composer.bar` (itself `session-maybe`). Parent factory declaration at `CONV 22808–22815` (`conversation.composer` chain and `conversation.composer.bar` single under `conversation.content`).

The overlay is anchored in the real composer card, one anchor per mounted `InputBar`:

```
22014  <div ref={cardRef} ... "data-composer-card": true ...>
22025    sessionId !== void 0 && <div className={...overlayAnchor} "data-composer-overlay": true>
22028      {renderSlot("conversation.input.overlay", {})}
```

CSS (in the InputBar module stylesheet, `CONV 21701`): `[data-composer-overlay]` → `.GRgSLq_overlayAnchor{height:0;position:absolute;inset:0 0 auto}`; the card is `position:relative` (`...card{...display:flex;position:relative}`). So overlay entries paint in card coordinates, full width, zero height, and must position themselves absolutely (the anchor contributes no height).

`renderSlot(..., {})` passes **no owner props** → an overlay entry receives only the framework **standard props** (§2.3) plus whatever its own `inject` returns. The slot is absent when there is no Session: the whole anchor is gated by `sessionId !== void 0` (`CONV 22025`) — no ghost on the blank/hero composer, matching DESIGN §五.1.

### 2.2 Registration options (list slot)

Shipped occupants and their registrations (this is the authoritative catalog for this build):

| `id` | `order` | registrant | evidence |
|---|---|---|---|
| `slash-menu` | 0 | ui-input-trigger | TRIGGER 1991–1995 |
| `command-popup` | 1 | ui-commands | COMMANDS 2295–2299 |
| `feedback-dialog` | 2 | ui-message-feedback | FEEDBACK 985–989 |

Reference (MIT, non-contract) registration: `{name, id: 'composer-predict-ghost', order: 300, locale: NS, inject: () => ({hooks:{...}, api:{...}})}` (REF 1410–1423).

Reconstructed option set for this list slot (renderer reads them; `id`/`order`/`locale`/`inject` are `confirmed` by usage, the rest `partial`):

```ts
ctx.slots.inject('conversation.input.overlay', () =>
  ctx.slots.register(
    {
      name: 'conversation.input.overlay',   // must equal the slot key
      id: 'next-message-predictor',         // stable entry identity; all shipped/working entries pass it
      order: 100,                           // ascending render order; builtins are 0/1/2
      locale: 'next-message-predictor',     // optional: gives the component a `t` prop for this namespace
      inject: () => ({}),                   // optional per-entry face: plain props spread; `hooks:{...}` become use<Name> hooks
    },
    GhostOverlay,                            // React component (function/class); rendered inside SlotErrorBoundary
  ),
)
```

Renderer contract for what `inject` may return (RENDERER 435–459): `{ hooks?: Record<string, ObservableSource>, keyedHooks?: Record<string, (defaultKey) => ObservableSource>, ...plainProps }`; plain properties spread as props, `hooks.foo` becomes prop `useFoo`, `keyedHooks.foo` becomes prop `useFoo` accepting a key first. A thrown `inject` or render is contained per-entry by `SlotErrorBoundary` (`RENDERER 631–646`, error face `[data-slot-error="<slot>"]`).

### 2.3 Standard props available to a session-scoped list entry

Standard props are **root binding merged with the session-scope binding**; hook sources named `x` become prop `useX`, plain props spread verbatim (`RENDERER 663–702`, doc `724–739`).

Root binding (provided by `ui-session`, `SESSION 1120–1129`): `hooks:{ sessions, sessionStatus }`, `keyedHooks:{ sessionRetainInfo, sessionAccess }`.

Session binding providers:
- `ui-session` `BUILTIN_SOURCE`: `hooks:["session"]`, `keyedHooks:["projection"]`, `props:["sessionId"]` (`SESSION 755–764`) → `useSession`, `useProjection(key, selector)`, `sessionId`.
- `ui-session` access keyed hook: `keyedHooks:["access"]` (`SESSION 1131–1134`) → `useAccess(action)`.
- `ui-conversation`: `hooks:["conversation","input"]`, `props:["inputActions"]` (`CONV 22775–22791`) → `useConversation`, `useInput`, `inputActions`.
- `ui-chat`: `hooks:["chat"]` (`CHAT 15328–15330`) → `useChat`.
- `t` comes from the registration's `locale` option (locale seat; `LOCALE_README 38–40`, `RENDERER 533–539` comment: `t` is memoized per `(face, namespace, revision)`).

Therefore, for an overlay entry in 0.2.2-rc.1, the usable set is:

```ts
{
  sessionId: string                                   // session scope prop
  useSession: SelectorHook<SessionSnapshot>           // selector over session snapshot
  useSessions: SelectorHook<SessionsListSnapshot>     // root
  useSessionStatus: SelectorHook<Map<string, SessionStatusEntry>> // root
  useProjection: KeyedHook                            // useProjection('plan'|'goal'|'imageLimits'|'todos'…, sel)
  useAccess: (action: string) => boolean | undefined  // e.g. 'session/prompt'
  useConversation: SelectorHook<ConversationSnapshot>
  useInput: SelectorHook<InputState>
  inputActions: InputActions
  useChat: SelectorHook<ChatSnapshot>
  t?: (key: string, vars?: object) => string          // only when locale: <ns> is registered
}
```

`CONV_README 14` states the package "contributes the `useConversation`, `useInput`, and `inputActions` standard props through `ctx.uiSession`"; `CONV_README 101` repeats that `uiSession.provide()` "supplies `inputActions` as a stable standard prop". The session-standard mechanism above is the proof for the rest. **Feature-detect** (`typeof useChat === 'function'`, etc.) like REF 708–717 does, and degrade to "unsupported version" instead of crashing.

### 2.4 What the entry must not assume

- No owner props arrive via `renderSlot(..., {})` — do not read `props.variant`, `props.placeholder`.
- No `keyboard`/`editor` prop: the live `Lexical` editor is only injected into the `conversation.composer.bar` entry (`CONV 21757`, `CONV 23097`), not into overlay children. Use `inputActions` + DOM.
- `inputActions`/`useInput` identity is stable per Session binding (`CONV 15367` "one stable identity per session"); they become `undefined` only outside a session scope.
- `insertText`/`captureInsertion` are safe to call from a DOM event handler; they do not require React state.

---

## 3. `InputState` and `InputActions` — exact types and semantics

### 3.1 `InputState` (the published composer snapshot)

The published store value is produced by `compose()` (`CONV 16048–16058`) and published by `publish()` (`CONV 16060–16068`); it is what `useInput` selects over (`CONV 22786` `input: shell.state`; store created at `CONV 15429`).

```ts
type InputPhase = 'plain' | 'claimed' | 'adjudicating' | 'submitting' | 'sending'

interface InputState {
  /** Semantic clipboard text: reference/quote chips appear as their clipboard token, never as DOM markup. */
  draft: string
  /** Draft attachment ids (images/files staged for the next message). */
  attachmentIds: readonly string[]
  /** Monotonic content revision; increments only when content changes (not on selection/caret moves). */
  draftRev: number
  phase: InputPhase
  /** Present once a leading `/command` chip claims the draft. */
  claim?: { token: string; name: string; hint?: string /* other fields exist */ }
  /** Reference chips in clipboard coordinates. */
  occurrences: readonly {
    occurrenceId: number
    source: string
    ref: unknown
    offset: number
    length: number
    label: string
    appearance?: unknown
    clipboardText: string
    invalid?: boolean
  }[]
  /** `next-turn` inbox rows: messages queued/steering, i.e. pending user input. */
  queue: readonly unknown[]
}
```

Evidence: `draft: this.projection.clipboardText`, `attachmentIds`, `draftRev: this.rev`, `phase: core.phase`, `claim` spread when present, `occurrences: this.projection.occurrences`, `queue: inbox?.["next-turn"] ?? []` (`CONV 16048–16058`). Phase values `plain|claimed|adjudicating|submitting|sending` from the state machine (`CONV 15319–15330`, `CONV 15540`, `CONV 15617`). Occurrence shape from `$projectComposer` (`CONV 14736–14783`). `draftRev` increments only on content change: `projectionContentChanged` excludes selection/caret (`CONV 15332–15344`, increment at `CONV 15437`).

**Not in `InputState`** (derive; see §3.3): `focused`, `composing`, `canEdit`, `quotes` (the editor projection has `quotes` at `CONV 14779` but `compose()` omits it — see §11.3), `menuOpen`, `sessionId`, `bindingGeneration`.

### 3.2 `InputActions` (stable public action face)

`CONV 15357–15395` (comment: "The public provide-channel action face (one stable identity per session)"):

```ts
interface InsertionSpan { start: number; end: number; draftRev: number }

interface InputActions {
  insertQuote(text: string): boolean
  /** Captures the live draft selection + current revision. Coordinates are detect-coordinates (chips = 1 placeholder char). */
  captureInsertion(): InsertionSpan
  /** Inserts one undoable plain-text edit only while `span.draftRev` is current and the editor permits editing. */
  insertText(text: string, span: InsertionSpan): boolean
  /** Whole-draft replace. NOT acceptable for adoption (DESIGN §二/§五; destroys references/undo intent). */
  setDraft(text: string): void
  persistDraft(): void
  addAttachments(ids: readonly string[]): boolean
  removeAttachment(id: string): boolean
  pruneAttachments(ids: readonly string[]): void
  /** Submits the current draft through the normal Enter path (mode "queue"). Never call for adoption. */
  submit(): void
}
```

Exact implementation (quoted):

```
15370  captureInsertion: () => ({
15371    ...this.caretSpan(),
15372    draftRev: this.rev
15373  }),
15374  insertText: (text, span) => {
15375    if (frozen(this.snapshot.phase) || this.disposed) return false;
15376    if (span.draftRev !== this.rev) return false;
15377    return this.draftEditor.insertAsyncText(span, text);
15378  },
```

Supporting implementation:
- `caretSpan()` returns the live selection as `{start,end}` or a collapsed span at the document end; detect coordinates (`CONV 15092–15099`; shell proxy `CONV 15682–15684`).
- `insertAsyncText(span, text)` — "Insert an asynchronous text result as one independent undo operation … @returns whether the range mapped and the edit applied" — strips `REFERENCE_PLACEHOLDER_RE = /[\uE100-\uE11D\uFFFC]/gu`, runs `$replaceDetectSpanWithText` inside one discrete update tagged `Co` (`CONV 15113–15126`, 14891, 14986–14996).
- `Co = "paste"` ("PASTE_TAG makes the paste its own history boundary, so one undo never removes both the paste and typing inside the merge window", `CONV 7692`, `CONV 15065–15084`) → the insertion is its own undo unit; no extra work needed beyond checking `insertText`'s return value.
- `$replaceDetectSpanWithText` returns `false` when the span no longer maps (`selectSpan` validates `0 <= start <= end <= detectLength`), `true` after inserting (`CONV 14844–14868`).
- `frozen(phase)` = `adjudicating || submitting || sending` (`CONV 15327–15330`); "plain" and "claimed" are editable. `disposed` is set by shell teardown (`CONV 15803–15812`).
- `insertText` is **synchronous** and returns before the next React render; it triggers the editor update → `rev += 1` → store publish synchronously for discrete edits (`CONV 15434–15445`, `14986–14996`).

**Failure conditions to handle** (all return `false`, never throw):
1. `span.draftRev !== current draftRev` (user typed/pasted/attached since the offer was shown);
2. phase frozen (a send/claim transaction started);
3. shell disposed (session binding torn down);
4. span fails to map (should not happen with `{0,0}` on an empty draft);
5. `captureInsertion` itself cannot fail; it returns `{start,end,draftRev}` — always compare both revision **and** `start === end` (collapsed) before inserting.

`insertText` sanitizes chip placeholders; do not pre-sanitize beyond the design's output validation. It does **not** validate that the draft is empty — that is the plugin's job from `InputState`.

### 3.3 Derived composer predicates (no native API; implement in adapter)

| Predicate | Exact rule | Evidence | Status |
|---|---|---|---|
| `semanticallyEmpty` | `input.draft === '' && input.attachmentIds.length === 0 && input.occurrences.length === 0 && input.phase === 'plain' && input.claim === undefined && input.queue.length === 0` | fields CONV 16048–16058; DESIGN §四 requires text/spaces/newlines/attachments/references/command tokens; whitespace counts as content (`draft === ''`, not `.trim()`) | confirmed fields, rule is design |
| `canEdit` | `!frozen(input.phase) && session !== undefined && !session.removed && (session.subagent === null || session.subagent.address.mode === 'continuable')` — plus DOM `input.phase` reflects machine; do **not** trust DOM `contenteditable` alone | `frozen` CONV 15327–15330; InputBar `disabled := removed \|\| inert \|\| !live \|\| blocked \|\| parentOffline` and `editable := live && !locked && !machineBusy` CONV 21826–21833 | partial (compose the two) |
| `focused` | `document.activeElement === card.querySelector('[data-composer-input]')` (the contenteditable root); `[data-composer-card]` may hold focus in inert/hero states | `data-composer-input` CONV 20980; `data-composer-card` CONV 22018; composer focus effects `CONV 21847–21869` | partial (DOM) |
| `composing` | element carries `data-composer-composing` (marker set before the first composed char; removed on compositionend/commit) **or** `event.isComposing` / `event.keyCode === 229` on a keydown | CONV 21164–21198; REF 288–297; CONV_README 97 ("Command hints and ordinary placeholders remain hidden throughout IME composition") | partial (marker confirmed) |
| `menuOrDialogOpen` | `[data-trigger-menu]` present **or** `pendingInteraction !== undefined` **or** overlay entry unmounted (structured takeover) **or** activeElement not the composer input (modal/popup focus) | §5 | mixed (see §5) |

---

## 4. Composer DOM contract (stable markers only)

| Marker | Meaning | Evidence | Status |
|---|---|---|---|
| `[data-composer-card]` | the composer card (`position:relative`, tabIndex -1); overlay entries live inside it | CONV 22014–22018 | confirmed |
| `[data-composer-overlay]` | overlay anchor, first child of the card, `position:absolute;height:0;inset:0 0 auto`; hosts `conversation.input.overlay` | CONV 22025–22028; CSS CONV 21701 | confirmed |
| `[data-composer-input]` | the single contenteditable editor root (`role="textbox"`, `aria-multiline`, `contentEditable` = editable, `data-phase`, `data-placeholder`, `aria-disabled` when locked) | CONV 20974–20982, 21027–21040 | confirmed |
| `[data-composer-placeholder]` | native placeholder `<div aria-hidden>`; **sibling immediately after** the contenteditable; exists only when `draft === '' && attachments.length === 0 && !claimActive` | CONV 21041–21046, 22051–22064 | confirmed |
| `[data-input-scroll]` | scrollport wrapping the editor + placeholder | CONV 21020–21023 | confirmed |
| `[data-composer-composing]` | IME composition in progress; toggled on the editor root | CONV 21169, 21192, 21196–21198 | confirmed |
| `[data-composer-chip]`, `[data-composer-command]`, `[data-composer-quote]`, `[data-composer-text-ref]`, `[data-composer-chip-selected]` | chip DOM inside the editor (do not touch) | CONV 14026, 14451, 13819, 14315, 14561 | confirmed |
| `[data-composer-ghost="<plugin>"]` | **convention from prior art only** — opt-in marker on a painted ghost node for cross-plugin deference; do not treat as a host contract | REF_README 192–198 | not a contract |

CSS facts for layout/placeholder work (from the InputBar module stylesheet, `CONV 21701`):
- `.placeholder{color:var(--dsw-alias-label-caption);white-space:nowrap;text-overflow:ellipsis;pointer-events:none;user-select:none;position:absolute;inset:4px 8px auto 14px;overflow:hidden}`
- `.input[data-composer-composing]+.placeholder{visibility:hidden}` (native IME hiding is a CSS rule, not inline style)
- `.overlayAnchor{height:0;position:absolute;inset:0 0 auto}`
- `.input{box-sizing:border-box;min-height:36px;font:inherit;white-space:pre-wrap;...;padding:4px 8px 0 14px}`
- `.scroll{max-height:var(--dsh-composer-text-max-height);margin-right:4px;overflow-y:auto}`, `.grow{position:relative}`

**Safe placeholder hide/restore while the ghost is visible (required: styles are module-hashed, design forbids class matching):**

```ts
function hideNativePlaceholder(card: HTMLElement): () => void {
  const el = card.querySelector<HTMLElement>('[data-composer-placeholder]')
  if (el === null) return () => {}
  const previous = el.style.visibility          // "" unless another writer set inline style
  el.style.visibility = 'hidden'
  el.setAttribute('data-next-predict-placeholder', '')   // our marker, for diagnostics/tests
  return () => {
    if (!el.isConnected) return
    el.style.visibility = previous                // restore the value we found, never blindly ""
    el.removeAttribute('data-next-predict-placeholder')
  }
}
```

Do **not** hard-code `visibility:hidden` via stylesheet scoped to a hashed class, do not match `className.includes('placeholder')` (REF 840–845 does this; it is fragile and the design explicitly forbids class-name dependence, DESIGN §十), and do not remove/re-create the placeholder element (React owns it; only inline style is unmanaged).

**Geometry**: mirror the editor box; measure from `[data-composer-input]`'s `getBoundingClientRect()` + `getComputedStyle` font family/size/weight/line-height/letter-spacing, and paint relative to the card rect; re-measure via `ResizeObserver(input)` + `ResizeObserver(card)` + `window resize` + capture-phase `scroll` (REF 813–864 is a working pattern; note it measures from the anchor and restores visibility; copy the approach, not the class matching). Ghost node should be `position:absolute; pointer-events:none; user-select:none; white-space:pre-wrap` and must render **outside** the contenteditable (the overlay anchor is outside it), so it never enters the draft, clipboard, or send payload.

---

## 5. IME, menu, dialog and structured-interaction detection

### 5.1 Detection matrix (recommended priority order)

| Signal | How to read it | Coexists with empty draft? | Evidence | Status |
|---|---|---|---|---|
| IME composition | `[data-composer-input][data-composer-composing]` present; also `event.isComposing \|\| event.keyCode === 229` on keydown; a host-side `recentlyComposing` window of 10 ms exists internally (`composingUntil = Date.now()+10`, `isComposingEvent`) | **yes** (draft is usually still empty during composition) → must gate | CONV 21155–21198; REF 288–297 | confirmed marker, partial API |
| `/` `@` candidate menu | `document.querySelector('[data-trigger-menu]') !== null`; closed state renders null, overlay entry stays mounted | **yes** (typed `/`/`@` fills the draft in most paths, but launcher-opened menus and drill/pick sequences can leave it empty) → must gate | TRIGGER 1662–1664, 1691, 1732–1735, 1991–2001 | confirmed |
| Command popup (`PopupSelectView`) | no stable data marker; entry id `command-popup`, order 1; open state renders `MenuSurface` with `role="listbox"` and an `<input>` that takes focus on desktop; closed renders null | yes | COMMANDS 1793–1806, 1864, 1927–1983, 2295–2305 | partial (focus + overlay-children) |
| Feedback dialog | entry id `feedback-dialog`, order 2; the Modal **portals to `document.body`** (not inside the overlay anchor); no stable marker | yes | FEEDBACK 30–40, 985–1009 | partial (focus/role dialog) |
| Approval pending | `useSessionStatus(map => map.get(sessionId)?.pendingInteraction)` is a `PendingApproval`; composer is replaced by a takeover via `conversation.composer` chain (priority 1) → **our overlay unmounts** | takeover means no composer bar → overlay gone | SESSION 992–1008; APPROVAL 468–474; CONV 20583 | confirmed |
| Question form / plan review | same `pendingInteraction`, `PendingQuestion` (`.kind` = `"question"` or `"plan-review"`); composer chain takeover selection `instanceof PendingQuestion`; DOM markers `[data-question-key]`, `[data-plan-review-key]` | takeover → overlay unmounts | QUESTIONS 135–193 (kind 185), 544, 1043, 2249–2269; CONV 20583 | confirmed |
| Plan mode chip / plan review | plan mode: `useProjection('plan', plan => plan !== undefined && (plan.pending ? !plan.active : plan.active))` (InputBar uses it for placeholder/hints); review pending shows up as `pendingInteraction.kind === 'plan-review'` | yes (plan-active composer is still an editable composer; the plan chip occupies `conversation.input.plan`, DESIGN says pause auto prediction for plan confirm) | CONV 21775; PLAN 820–829; QUESTIONS 185, 2249 | partial |
| Composer block / takeover reason | `useComposerBlock(block => block)` is injected only into `conversation.content` children (`CONV 20488, 22842`), **not** into overlay entries; the block replaces composer placeholder with `block.reason` and passes `blocked` to the bar (`CONV 20566–20568, 21826`) | if a block exists the bar is still mounted with `blocked`; our overlay is mounted (anchor gated only on sessionId) → detect via takeover unmount / DOM placeholder change is unreliable; see §11.7 | CONV 5162–5182, 20488, 20566–20568, 22842 | partial (not available to overlay) |
| Slash-trigger with empty draft | launcher-opened menu (`inputTriggers.launcher`) has no separate DOM marker but opens the same `MenuView` → `[data-trigger-menu]` covers it | yes | TRIGGER 983–987, 1083–1104, 1662–1691 | partial |

### 5.2 Practical guard set for P1 (all cheap, all safe to over-apply)

```ts
function interactionBusy(opts: {
  sessionStatus: SessionStatusEntry | undefined
  input: InputState | undefined
  card: HTMLElement | null
  doc: Document
}): boolean {
  const { sessionStatus, input, card, doc } = opts
  if (sessionStatus?.pendingInteraction !== undefined) return true    // approval / question / plan-review
  if (doc.querySelector('[data-trigger-menu]') !== null) return true   // / and @ menu
  // Composer takeover or modal/popup focus: our anchor's own editor is no longer the focused control.
  const editor = card?.querySelector<HTMLElement>('[data-composer-input]') ?? null
  if (editor !== null && doc.activeElement !== editor) return true
  // Any dialog/menu rendered by the shell (feedback modal portals to body).
  if (doc.querySelector('[role="dialog"][aria-modal="true"]') !== null) return true
  // Quoted from CONV's own stop-shortcut guard, which treats these as "not the composer":
  //   target.closest("[data-approval-key], iframe, .xterm, [inert]")
  // and from the card's mousedown ignore list: [data-composer-overlay] children are ours/builtins.
  return false
}
```

Rules of thumb:
- **Never** consume a key while any condition above is true; fail open to the native behavior.
- `event.defaultPrevented` only reflects handlers that already ran; DOM capture handlers run before Lexical, so it will normally be `false`. Do still check it (DESIGN §五.6).
- The structured interactions are the strongest guard: when they are pending the composer bar is replaced (`renderSlotChain('conversation.composer', …)`, `CONV 20583`), so **the cleanest behavior is that the overlay simply unmounts**. Confirm in E2E; if it does not unmount for a given panel, the `pendingInteraction` check still suppresses auto-prediction and Tab/Esc.

---

## 6. Sessions, chat transcript, and finished-turn identity

### 6.1 `useSessionStatus` (root hook) — the cheapest turn signal

`SESSION 992–1008` publishes `Map<sessionId, {running, pendingInteraction, completionUnread}>`:

```ts
interface SessionStatusEntry {
  running: boolean | undefined
  pendingInteraction: unknown | undefined   // PendingApproval | PendingQuestion; undefined when none
  completionUnread: boolean
}
```

Used by core as `useSessionStatus(snapshot => sessionId === void 0 ? undefined : snapshot.get(sessionId)?.pendingInteraction)` (`CONV 20484`). `completionUnread` is set when a non-main session's running goes true→false (`SESSION 964–971`), cleared when it becomes main (`SESSION 989–991`) — for the **active** session it is `false`, so do not use it as the trigger.

### 6.2 `useSession` (session hook) — exact `SessionSnapshot` fields

`SESSCTRL 2913–2936 buildSnapshot()`:

```ts
interface SessionSnapshot {
  sessionId: string
  pendingSubmissions: readonly unknown[]
  running: boolean
  subagent: null | {
    address: { mode: 'unknown'|'one-shot'|'continuable'; /* other address fields */ }
    parentAvailable?: boolean
  }
  removed: boolean
  openState: 'idle'|'opening'|'ready'|'error'|string
  openError: unknown | undefined
  hasMore: boolean
  loadingOlder: boolean
  promptError: null | { error: { code: string; message: string; details?: unknown } }
  blank: boolean
  lastAgentError: unknown | null
  promptAttempted: boolean
  awaitingFirstTurn: boolean
}
```

Elite facts for eligibility: skip when `blank === true`, `removed === true`, `subagent !== null` (DESIGN §五.1 excludes subagents), `awaitingFirstTurn === true`, `promptError` irrelevant, `running === true` (no prediction mid-turn). InputBar itself reads `s.promptError`, `s.running`, `s.subagent`, `s.removed` (`CONV 21771–21774`).

### 6.3 `useChat` snapshot — `legacy` projection (stable, built for compatibility)

`EMPTY_CHAT_SNAPSHOT` documents the shape (`CHAT 120–143`); snapshot keys are `{order, nodes, locations, navigation, timeline, legacy}` (`CHAT 11503–11511`).

```ts
interface ChatSnapshot {
  order: readonly string[]
  nodes: { get(key): ChatNode|undefined; values(): ChatNode[]; ... }
  locations: { getTurn(turn): readonly string[]; getStep(...): readonly string[] }
  navigation: { items(): readonly {turn, anchorKey?...}[] }
  timeline: { turnOrder: readonly number[]; turns: Map<number, TurnLocation> }
  legacy: {
    nodes: readonly LegacyNodeData[]          // finalized nodes sorted by seq
    turnTimings: Map<number, {startTime:number; endTime?:number}>
    turnEnds: Map<number, number>             // turn -> turn/end event seq
    partial: null | { turn:number; step:number; blocks: AssistantBlock[] }
    runningCalls: readonly unknown[]
  }
}
```

Evidence: `legacyContribution` mapping node kinds (`CHAT 11220–11292`), `LegacySliceBuilder` (`11296–11384`; `updateTimeline` fills `turnTimings`/`turnEnds` at `11361–11375`, `snapshot()` at `11376–11384`).

**Legacy node data shapes** (each `data` is what appears in `legacy.nodes`):

| kind | shape (relevant fields) | evidence |
|---|---|---|
| `user` | `{kind:'user', messageId, seq, time, content, source}` | CHAT 11985–11992 |
| `steering` | `{kind:'steering', messageId, seq, time, content, source, batchStart?}` | CHAT 11977–11984 |
| `context` | `{kind:'context', seq, time, content, source, producer, form}` (includes injected/runtime context; never treat as human text) | CHAT 11927–11936 |
| `assistant` (final) | `{kind:'assistant', seq, messageId, time, turn, step, blocks, usage, timing:{stepStartTime,firstTokenTime,completedTime}, interrupted?}` — `blocks` are `{kind:'text',text}` / `{kind:'reasoning',text}` / `{kind:'tool-call',...}` | CHAT 10111–10146 (`finalNode()`), 10173–10186 |
| `tool-call` | settled tool root data (not a message) | CHAT 11259–11272 |
| `turn-error` | `{kind:'turn-error', seq, time, turn, step, message, code?}` — present only for `error` / `aborted(signed-out)` / `interrupted` turn ends | CHAT 12582–12721 |
| `turn-max-tokens` | truncation notice for `turn/end.reason.kind === 'max-tokens'` | CHAT 12682–12701 |
| `compaction`, `command`, `manual-compaction`, `model-retry`, `unknown` | enumerated, not needed for P1 | CHAT 11220–11292 |
| `turn-tail` | **view node only**, not in `legacy.nodes`; data `{turn, seq: turn/end seq, time, closing, branchUnavailable, tokenUsage?}` | CHAT 13258–13328; `legacyContribution` returns empty for `turn-tail` (`11288–11290`) |

### 6.4 Detecting "a completed turn just finished" (robust recipe)

Observed `turn/end.reason.kind` values on this build (derived from the Chat projection, since the raw reason is not exposed to slots): `error`, `aborted`, `interrupted`, `max-tokens`, and a success path (no kind literal is exposed; the turn-tail/projections treat "not one of the above" as completed). Evidence: `endFailure(reason)` switch `CHAT 12592–12605`; `stateFrom` `reason.kind !== 'max-tokens'` `CHAT 12700–12701`; `interrupted` assistant node `CHAT 10129, 10137–10145`.

Recommended client algorithm (P1):

```ts
type TurnCandidate = {
  sessionId: string
  turn: number
  completedEventSeq: number   // legacy.turnEnds.get(turn): the turn/end event seq - not the same as session.seq
  lastAssistantSeq: number    // the assistant-message event seq, stable identity for the turn's final text
  text: string                // concatenated visible assistant text blocks
}

function lastCompletedTurn(nodes: readonly any[], turnEnds: Map<number, number>): TurnCandidate | null {
  // legacy.nodes is seq-ordered; walk from the end for the latest settled assistant text.
  for (let i = nodes.length - 1; i >= 0; i--) {
    const n = nodes[i]
    if (n.kind !== 'assistant') continue
    if (n.interrupted === true) return null
    const text = (n.blocks ?? [])
      .filter((b: any) => b.kind === 'text')
      .map((b: any) => b.text)
      .join('\n')
      .trim()
    if (text === '') return null
    const endSeq = turnEnds.get(n.turn)
    if (endSeq === undefined) return null            // turn/end not observed yet
    // Non-completed turns publish a terminal row of their own in legacy.nodes:
    const failed = nodes.some((x) =>
      (x.kind === 'turn-error' || x.kind === 'turn-max-tokens') && x.turn === n.turn)
    if (failed) return null
    return { sessionId: /* from slot prop */ '', turn: n.turn, completedEventSeq: endSeq, lastAssistantSeq: n.seq, text }
  }
  return null
}
```

Then trigger only when **all** hold (DESIGN §五 "自动触发资格"):

1. `useSessionStatus(...).pendingInteraction === undefined`;
2. session snapshot: `!blank`, `!removed`, `!running`, `subagent === null`, `!awaitingFirstTurn`;
3. transition observed: previous render had `running === true` (or a cold mount whose latest persisted turn is idle and unprocessed); dedupe by `(sessionId, lastAssistantSeq)` in a render-scoped `Set`/`Map` so remounts and session switches do not re-predict;
4. `lastCompletedTurn(...)` returns a candidate (reasons above filter aborted/error/max-tokens/interrupted; **aborted** turns without a signed-out error leave no terminal row — accept this as a P1 gap and additionally require the design's 250 ms quiet + "no new draft/turn" effect below);
5. composer `semanticallyEmpty` and `canEdit` and focused, no IME/menu/dialog (§3.3/§5.2);
6. wait `triggerDelayMs` (250 ms) and re-check before requesting;
7. on response, re-check session binding identity + `(turn, lastAssistantSeq)` + `draftRev` + focus/menu/IME.

**What is missing:** the raw `turn/end.reason` object is not exposed to slot components (`legacy.turnEnds` stores only the seq; the tail node is a view node). So the client cannot assert `reason.kind === 'completed'` literally; it can only exclude the derived failure/truncation/interruption rows. The host half must re-verify the authoritative turn/end reason from the session log before spending a model call (DESIGN §六 identity: client sends turn anchor, host reads session). Mark `partial` and put the authoritative check on the host.

**Session/branch identity on the client:** no numeric `bindingGeneration` is exposed to slots. Available identity signals:
- `sessionId` (prop) — binding changes are observable only through services;
- `useChat` node `seq` values + `turnEnds`;
- React component identity changes when the session binding changes (the slot re-renders with a new `sessionId`; a session switch is not atomic — REF 729–760 documents the same race and holds 400 ms until `legacy.nodes` changes).
- For a generation token, `apply(ctx)` may `ctx.inject(['sessions'], scope => …)` and compare `scope.sessions.binding(sessionId)` object identity (identity-stable per binding; used as `generation` by core, `CONV 22467–22479`; binding accessor `CONV 16127–16133`). Mark `partial` (service, not slot prop).

---

## 7. Keyboard arbitration: native behavior and the only safe interception point

### 7.1 Native composer keymap (Lexical commands, all priority 4)

`registerComposerKeymap(editor, handlers)` (`CONV 21158–21253`):
- composition: `compositionstart`/`compositionend` on the root plus `editor.isComposing()` drive `data-composer-composing` (`21171–21198`); `composingUntil = Date.now()+10` ("recently composing") `21175–21180`, `21155–21157`;
- **Tab / Shift+Tab** → `arrow(event.shiftKey ? "tabBack" : "tab")` → `handlers.arbitrate(key, inComposition)`; if verdict !== `"pass"` → `preventDefault()` and return handled (`21203, 21181–21188`);
- **Escape** → `handlers.dismissPopup()` first, then `handlers.arbitrate("escape", isComposingEvent(...))`; `"consumed"` → preventDefault/handled, else pass (`21204–21209`);
- **Enter** → composition/modifier guards, Shift+Enter returns false (native newline), then `handlers.arbitrate("enter", false)`; non-pass consumes, then submit path (`21217–21229`);
- Up/Down arrows, space, paste are similarly gated (`21210–21216, 21230–21252`).

`handlers.arbitrate` is wired to the input-trigger controller (`CONV 21346–21349` → `CONV 15651–15653`), whose verdict is `"pass" | "consumed" | "pick-highlighted"` (`TRIGGER 1174–1218`). So the native menu already owns Tab/Shift+Tab/Escape **while a `/`/`@` menu is open** — including "Tab with no highlight passes untouched, Shift+Tab leaves the menu without settling" (`TRIGGER 1204–1216`; TRIGGER_README 30–34).

### 7.2 There is no plugin hook into the composer keymap

- `keyboard` (the keyboard face with `editor`, `arbitrate`, `caretSpan`, `submit`, `focus`) is injected only into the `conversation.composer.bar` entry (`CONV 21757`, `CONV 23097`), not into `conversation.input.overlay` children, and is documented as "package-internal — handed through the composer-bar entry's inject, never across a plugin boundary" (`CONV 16235–16244`).
- `ctx.shortcuts` is app-level only (fixed commands + `observeFixedInput`), and its observers are not the editor keymap; Tab is not a shortcut (`SHORTCUTS_README 30–36`; Esc-Esc stop is a fixed action `CONV 22739–22756`, `22420–22489`).

### 7.3 The working interception pattern (same as prior art)

Attach **one capture-phase `keydown` listener on `document`**, installed/removed in a `ctx.effect`, and only act when *all* of the following hold (`REF 1483–1519` is the working precedent):

```ts
function onDocumentKeyDownCapture(event: KeyboardEvent): void {
  if (event.defaultPrevented || event.repeat) return
  if (event.isComposing || event.keyCode === 229) return
  const target = event.target
  if (!(target instanceof HTMLElement)) return
  if (!target.isContentEditable) return                     // 0.2.2 composer is contenteditable only
  const card = target.closest('[data-composer-card]')
  if (card === null || card !== ownCard) return             // only OUR composer
  if (dialogOrMenuOpen()) return                            // §5.2
  if (composingRef.current || ownCard.querySelector('[data-composer-composing]') !== null) return

  if (event.key === 'Tab') {
    if (event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) return   // leave Shift+Tab/accelerators native
    if (!offerVisible()) return
    if (!document.activeElement?.isContentEditable) return
    acceptOffer(event)                                       // §7.4; swallows only on success
    return
  }
  if (event.key === 'Escape') {
    if (!offerVisible()) return
    event.preventDefault()
    event.stopPropagation()                                  // first Esc consumes: dismiss (DESIGN §三)
    dismissOffer()
  }
}
```

Additional `ctx.effect` observer needed: a `MutationObserver` watching `attributeFilter: ['data-composer-composing']` on the editor root (or `subtree:true` on the document, as REF 1386–1408 does) to keep `composingRef` fresh; cap it to the owned card subtree, not the whole page, and disconnect on cleanup (DESIGN §十: "观测器随组件释放，不全页面高频扫描").

Why capture on `document` works: Lexical's editor command handlers are driven by DOM listeners on the editor root (bubble); a `document` capture handler runs first, so `preventDefault()+stopPropagation()` reliably wins. It is also why `event.defaultPrevented` will be `false` there — do not use it as the menu guard; check the DOM marker instead.

### 7.4 Accept routine (exact order; swallow only on proven success)

```ts
function tryAcceptOffer(event: KeyboardEvent): boolean {
  const offer = offerRef.current
  const actions = actionsRef.current
  const input = latestInputRef.current          // last published InputState from useInput
  if (offer === null || actions === null || input === undefined) return false
  if (input.draft !== '' || input.attachmentIds.length !== 0 || input.occurrences.length !== 0) return false
  if (input.phase !== 'plain' || input.claim !== undefined) return false
  if (document.activeElement === null || !ownCard?.contains(document.activeElement)) return false
  if (dialogOrMenuOpen() || composingRef.current) return false

  const span = actions.captureInsertion()      // {start,end,draftRev} - synchronous, no await
  if (span.start !== span.end) return false    // never replace a user selection
  if (span.draftRev !== offer.draftRev) {      // stale version => hide, do not swallow the key
    setStatus('stale'); hideOffer(); return false
  }
  const inserted = actions.insertText(offer.text, span)
  if (!inserted) {                             // frozen / disposed / unmapped
    setStatus('insert-failed'); hideOffer(); return false
  }
  event.preventDefault()
  event.stopPropagation()
  markAccepted(offer)                          // terminal for (sessionId, turn): never re-offer, even after undo
  void api.reportAccepted(offer.suggestionId)  // best-effort; failure never rolls back the draft
  return true
}
```

Rules:
- Do the whole check + insert **synchronously** in the keydown handler (DESIGN §六 "不跨 await 执行写入"). No network, no `await`, no React state read that requires a render.
- On **any** failure return `false` and let the native Tab/Escape run (DESIGN §六 "只有插入成功才吞掉 Tab；失败时保留原有按键行为"). This also preserves Shift+Tab navigation and tab-focus traversal when there is no offer.
- Do not use `setDraft` for adoption (DESIGN §二 explicitly rejects it: it replaces the whole draft and breaks references/undo semantics).
- After a successful insertion: `insertText` bumps `draftRev` and publishes a new `InputState`; expect the offer's `draftRev` to be stale immediately, which is why "accepted" must be a terminal state keyed by turn, not by draft content.
- Tab repeat: `event.repeat` guard + terminal accepted state → at most one insertion per offer (acceptance criterion).
- Esc: consume only while an offer is visible and no menu/IME/dialog; the first Esc becomes the dismissal, which also resets the Esc-Esc stop sequence (`CONV 22435` resets on `gesture.defaultPrevented`). Predicting only after a turn finished (not running) means stop-sequence interference is irrelevant in P1.

---

## 8. Multiple inputs / composer identity

### 8.1 How many composers exist?

- The slot value is **session-scoped**: entries are materialized per session binding; the overlay anchor is rendered by the `InputBar` of the currently bound session composer (`CONV 22025–22029`); `InputBar` itself is the single `conversation.composer.bar` entry under `conversation.content` (`CONV 20557`, `22812–22815`).
- One `SessionInputShell` owns **one Lexical editor per Session**; the package README states the design "does not support simultaneous editable roots for one Session" (`CONV_README 93`).
- Multiple composers in one page are therefore possible only through multiple **mounted conversation occurrences** (the content factory supports embedded occurrences that can replace views/omit handles, `CONV_README 101`) or multiple Sessions mounted at once; the main conversation mounts one. There is **no global "active composer" service** exposed to slots.
- In practice for Desktop 0.2.2-rc.1 the main window has exactly one editable composer; the app can have additional windows (each its own renderer/document).

### 8.2 Recommended identity logic (per overlay instance)

1. Keep a ref to the anchor element the component renders inside: `anchorRef.current?.closest('[data-composer-card]')` → `ownCard`. This is exactly the pattern prior art uses for measurement (`REF 819–823`), and it is the only reliable instance identity.
2. `ownEditor = ownCard.querySelector('[data-composer-input]')`.
3. "This composer is the active one" = `document.activeElement === ownEditor` **and** `ownCard.isConnected`. For display-only (ghost paint) decide whether focus is required: DESIGN §五.5 requires "输入框可编辑且语义为空" and the offer is only actionable by Tab when focused; safest: **paint only while focused or while focus was lost without typing** (DESIGN §五 table: "失焦只隐藏已经完成的建议；在同一版本下恢复焦点可重新展示"), and always require focus at accept time.
4. For Tab adoption, additionally verify the event target is inside `ownCard` (the document-capture handler sees every composer's keys; never accept for another instance).
5. If `document.querySelectorAll('[data-composer-input]').length > 1` (embedded/multi occurrence), never fall back to a global query — resolve everything from `ownCard`.

### 8.3 Slot scoping facts

- Overlay slot scope is `session` (`CONV 22966–22969`); entries are rendered only while the composer's session binding is the bound session; switching sessions re-renders/replaces the entry.
- A session switch is **not atomic** in React terms: the composer can render the new `sessionId` before the chat store swaps nodes (prior art explicitly holds 400 ms / until `legacy.nodes` changes, `REF 729–760`). Mirror this: on `sessionId` change, hide + abort in-flight offers immediately, and only re-enable after the new binding's `useChat` snapshot identity has changed.
- Entry `inject` receives the session id for session-scoped slots (`TRIGGER 1996–1999`, `COMMANDS 2300–2304`, `FEEDBACK 990`), but standard props also carry `sessionId`; use the standard prop.

---

## 9. Client plugin mechanics (packaging, locale, transport, cleanup)

### 9.1 `dsh.client` manifest

`MODULES 86–100 parseDshClient()` validates exactly:

```jsonc
// package.json
{
  "name": "dsh-next-message-predictor",
  "exports": { ".": { "default": "./lib/index.js" },
               "./client": { "default": "./lib/client.js" } },
  "dsh": {
    "client": {
      "platform": "web",            // required string (the only validated value used by shipped packages)
      "inject": ["@deepseek-ai/dsh-client-ui-slots"],   // optional string[] informational dependency edges (MODULES 91)
      "external": ["@deepseek-ai/dsh-client-ui-slots"], // optional string[] non-baseline module requests (MODULES 92)
      "immediately": true                               // optional boolean; load at boot instead of lazily (MODULES 93, 466)
    }
  }
}
```

Shipped evidence: ui-conversation declares `dsh.client = {inject:[9 packages], platform:"web"}` (`CONV package.json 29–44`). Host serves the bundle under `/plugins`; the browser loads lazily unless `immediately` (`MODULES_README 32–34, 41–48`); external requests must resolve against the platform seed table or another graph row — the seed table includes `react`, `react/jsx-runtime`, `react-dom`, `@deepseek-ai/cordis`, `zod`, `@deepseek-ai/dsh-client-store`, `@deepseek-ai/dsh-client-ui-slots`, `@deepseek-ai/dsh-client-ui-primitives`, `@deepseek-ai/dsh-client-ui-dockkit` (visible in the shell bundle module table, see §1.2). Add only what the client bundle actually requires.

### 9.2 Bundle format and exports

Every shipped client bundle is exactly:

```js
window.__ModuleLoader__.load({
  id: "@deepseek-ai/dsh-client-ui-conversation",
  factory: (require) => {
    var module = { exports: {} }; var exports = module.exports;
    ...
    exports.apply = apply; exports.inject = inject; exports.Config = Config;
    return module.exports;
  },
});
```

Evidence: `CONV 1–6`, `CONV 23127–23141`; prior art identical wrapper `REF 1–6, 1532–1539`. Semantics: executing the script only registers the factory; the module body runs at materialization, memoized, lazy-CJS, requires resolved against the seed table/boot graph (`MODULES 40–62`, `MODULES_README 77`). The Loader instantiates the plugin from the exports: `inject` (service dependency declaration) + `apply(ctx)` (plugin body) + optional `Config` schema (Cordis plugin convention; see any shipped `exports.apply/exports.inject/exports.Config`).

`apply(ctx)` responsibilities for us: `ctx.plugin(...)` if any sub-plugin, `ctx.effect(...)` registrations, `ctx.slots.inject(...)`, `ctx.locale.register(...)`, `ctx.inject([...], scope => ...)` for optional services. `ctx.effect(fn, label)` returns a disposer and ties cleanup to the plugin fiber; it is the documented cleanup mechanism for registered commands/observers/styles (SHORTCUTS_README 30; LOCALE_README 54–57).

### 9.3 Locale

`ctx.locale.register(ns, { zh, en, ja, es, fr, de, ru, pt })` inside `ctx.effect` (both `zh` and `en` are required baseline locales); `ctx.locale.bind(ns)` returns a translate thunk; the framework-injected `t` seat appears on a slot entry when its registration passes `locale: ns` (`LOCALE_README 38–40`; `RENDERER 533–539`; every shipped overlay entry sets `locale`). Unloading the plugin removes dictionaries through the effect (`LOCALE_README 68`).

### 9.4 Talking to the host (route/fetch)

Two supported client patterns, both same-origin and cookie-authenticated by the existing carrier:

1. **Plain same-origin `fetch` to a host-registered exact route** — what prior art does and what the design specifies (`/api/next-message-predictor/rpc`):

```ts
const ROUTE = '/api/next-message-predictor/rpc'
const res = await fetch(ROUTE, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ schemaVersion: 1, operation: 'predict', requestId, viewId, anchor, expectedConfigRevision, trigger }),
  signal,
})
const json = await res.json()
```

Browser auth is the page's signed cookie, minted by the Web carrier and required for every RPC/route; the connection README documents the auth/trust fence (`CONN_README 41–43, 47, 49`). Prior art proves this works from a client bundle (`REF 473–490`); note it also has a legacy fallback.

2. **`ctx.connection.rpc.call(channel, endpoint, payload, signal)`** (generic Connection unary RPC; available as `connection.rpc` on `ctx.connection`, `CONN 1387, 1421–1443`):

```ts
// channel must match /^\/[A-Za-z0-9._~-]+$/, endpoint /^[A-Za-z0-9_$.-]+$/
const result = await connection.rpc.call('/api', 'next-message-predictor.rpc', payload, signal)
```

It POSTs `${channel}/${endpoint}` with a `{type:'client-request', rpcId, method, payload}` envelope and validates the `rpcId` (`CONN 1200–1232`). The host must register a matching route/handler (host half's task). Do **not** invent a `/composer-predict`-style custom channel for new code; keep to `/api/...` routes owned by the host plugin.

Client fetch failures must be fail-quiet (`failed` state, DESIGN §五 table) and never block the composer.

### 9.5 Disposal / uninstall / HMR

- Disabling the plugin entry removes the Loader entry and the client module system "waits for its asynchronous effects before evicting unused modules and styles" (`MODULES_README 47`). HMR swap: invalidate old module → prefetch → delete runtime → drain old fiber → "removes owned styles" (`HMR_README 66`); rebuilt bundle re-executes and remounts with fresh state, React state is lost, session/connection state survives (`HMR_README 36, 48`).
- Consequences for implementation:
  - register document listeners / MutationObservers / ResizeObserver / style tags inside `ctx.effect` (or `useEffect` of a component that the slot unmounts) and return disposers;
  - do not stash cross-instance mutable state in module scope (it survives only until module eviction, and is shared by HMR in-flight old/new bundles; use `apply`-scoped state or a service);
  - for global markers (placeholder hiding, style tag), make cleanup idempotent and safe on repeated mount/unmount/HMR (save/restore exactly what you found);
  - uninstall must leave zero DOM residue: our own `data-*` markers must be removed in cleanup (acceptance scenario DESIGN §十二 "卸载、HMR … 监听器/observer/占用标记无残留").

---

## 10. Reference implementation notes (MIT prior art: copy patterns, not APIs)

What `dsh-composer-prediction@0.7.8` proves works on this slot (installed in `<DSH_HOME>\profiles\desktop`):

| Pattern | Where | Verdict for our plugin |
|---|---|---|
| `conversation.input.overlay` list entry `{name,id,order,locale,inject}` + always-mounted anchor div | REF 1410–1423, 866–873 | **copy** (order ≈ 100 instead of 300; both late) |
| props destructure `{sessionId,useInput,inputActions,useSession,useChat,t}` | REF 708–724 | **copy** (add `useSessionStatus`, feature-detect) |
| IME marker via `hasAttribute('data-composer-composing')` + MutationObserver | REF 288–297, 1386–1408 | **copy** (scope observer tighter) |
| tab accept uses `inputActions.setDraft(text)` | REF 550–560 | **do not copy** — DESIGN §二/§六 requires `captureInsertion`+`insertText` |
| placeholder hiding by class-name matching + `style.visibility=''` restore | REF 840–845, 856–863 | **do not copy** — use `[data-composer-placeholder]` + saved inline value |
| document capture keydown; swallow only on success | REF 1483–1519 | **copy** (+ menu/pendingInteraction guards) |
| cross-plugin deference via boot manifest / `entriesOfSlot` / ghost markers | REF 1314–1379 | optional P1; `entriesOfSlot` is undocumented (mark partial). Our `data-composer-ghost="dsh-next-message-predictor"` on the painted node is a good citizen marker |
| 400 ms session-switch hold until `legacy.nodes` changes | REF 729–760 | **copy** the idea (use node-list identity instead of a fixed timer where possible) |
| dedupe offer per `(session, turn)` and cancel in-flight on session switch/dismiss | REF 466–471, 518–529 | **copy** |
| host talk via same-origin fetch + legacy `connection.rpc.call` fallback | REF 473–490 | **copy** the fetch path; add abort signal and timeout |

Anti-patterns explicitly rejected by our design: `setDraft`, DOM mutation of the editor, class-name-based placeholder detection, module-scope singletons that leak across HMR, global `capture` of all keys without per-composer gating.

---

## 11. Gaps, unsatisfied capabilities, and risks

1. **Live client Inspect providers are unavailable from this session** (§1.3) — all client claims are static. Not a P1 blocker.
2. **No shipped `.d.ts` / `src`** — the plugin must ship its own `src/client/contract.d.ts` transcribed from §3/§6 and mark it internal; do not import types from `@deepseek-ai/dsh-client-ui-conversation/client` (the export target does not exist in the installed archive; only the built `lib/client.js` does).
3. **`InputState` has no `focused`/`composing`/`canEdit`/`quotes`** — derive from DOM + `phase` + session snapshot (§3.3). Quote-only drafts: `compose()` omits `projection.quotes`; a draft containing only quotes likely surfaces through `draft`/`occurrences` non-empty, but verify in E2E; if a quote-only draft can report `draft === ''`, treat "editor DOM has quote nodes" (`[data-composer-quote]` inside `[data-composer-input]`) as non-empty. **Risk, must test.**
4. **`turn/end.reason.kind` is not exposed to slots** (§6.4) — client can only exclude derived error/max-tokens/interrupted rows; aborted turns without a terminal row look "completed". Host must re-verify the authoritative reason before spending a call. Accept and document.
5. **No plugin hook into the composer keymap** (§7.2) — document-capture is the only route and carries upstream-change risk. Keep the handler fail-open, minimal, and covered by E2E.
6. **Command popup / feedback dialog have no stable `data-*` markers** (§5.1) — rely on focus/modal/overlay-children heuristics + failing open. If a concrete P1 test shows a leak (ghost visible/Tab stolen while such a popup is open), the safest fix is to also require `document.activeElement === ownEditor` for both paint and accept (both popups move focus away from the editor on desktop).
7. **`useComposerBlock` is not one of the overlay's standard props** (injected only into `conversation.content` children) — a `blocked` composer is still mounted, so the overlay can be mounted while the bar shows a block banner. Add a conservative guard: if `[data-composer-input]` has `aria-disabled` or `[data-phase]` is not `"plain"`, hide and never accept; and rely on `inputActions.insertText`'s frozen check as the last line of defense.
8. **Multi-composer identity is DOM-derived** (§8); no global active-composer service. Accept; test with one window.
9. **Undo independence is documented via the `paste` history tag** but not E2E-proven on this build; P1 must verify Ctrl+Z removes only the insertion and a second Ctrl+Z restores the empty draft (not the previous user text).
10. **Slot option types are inferred** (no `dsh-client-ui-slots` .d.ts, §1.2): `id`/`order`/`locale`/`inject` are `confirmed` by 4 shipped entries; other options (`key`, `select`, `store`, `children`, `priority`) belong to other slot kinds. Do not use undocumented options.
11. **Message/attachment-only empty state**: "semantically empty" must be re-checked from the published `InputState` right before insert; do not cache `empty` across an `await`.
12. **Desktop vs Web**: everything above is target-neutral client code; this document was verified against the installed Desktop build only (0.2.2-rc.1). Web compatibility is a separate validation (DESIGN §十 "Web 使用同一能力适配层，但必须完成单独验收").

---

## 12. Copy-paste contract types and adapter skeleton (recommended P1 shape)

### 12.1 `src/client/contract.d.ts` (transcribed from evidence; internal)

```ts
/** 0.2.2-rc.1 client contract actually used by the predictor. Verified 2026-11-09. */
export type SessionId = string
export type InputPhase = 'plain' | 'claimed' | 'adjudicating' | 'submitting' | 'sending'

export interface InsertionSpan { start: number; end: number; draftRev: number }

export interface InputState {
  draft: string
  attachmentIds: readonly string[]
  draftRev: number
  phase: InputPhase
  claim?: { token: string; name: string; hint?: string }
  occurrences: readonly {
    occurrenceId: number; source: string; ref: unknown; offset: number; length: number
    label: string; appearance?: unknown; clipboardText: string; invalid?: boolean
  }[]
  queue: readonly unknown[]
}

export interface InputActions {
  insertQuote(text: string): boolean
  captureInsertion(): InsertionSpan
  insertText(text: string, span: InsertionSpan): boolean
  setDraft(text: string): void
  persistDraft(): void
  addAttachments(ids: readonly string[]): boolean
  removeAttachment(id: string): boolean
  pruneAttachments(ids: readonly string[]): void
  submit(): void
}

export type SelectorHook<S> = <T>(selector: (snapshot: S) => T) => T
export type KeyedHook = <T>(key: string, selector: (snapshot: any) => T) => T

export interface SessionStatusEntry {
  running: boolean | undefined
  pendingInteraction: unknown | undefined
  completionUnread: boolean
}

export interface SessionSnapshot {
  sessionId: SessionId
  running: boolean
  removed: boolean
  blank: boolean
  awaitingFirstTurn: boolean
  subagent: null | { address: { mode: string }; parentAvailable?: boolean }
  promptError: null | { error: { code: string; message: string } }
  // ...other fields unused by the predictor
}

export type LegacyNode = { kind: string; seq: number; turn?: number; [key: string]: unknown }

export interface ChatSnapshot {
  legacy: {
    nodes: readonly LegacyNode[]
    turnTimings: Map<number, { startTime: number; endTime?: number }>
    turnEnds: Map<number, number>
    partial: null | { turn: number; step: number }
  }
  // order/nodes/locations/timeline exist; not needed for P1
}
```

### 12.2 `src/client/dsh-adapter.ts` — semantic reads

```ts
import type { InputActions, InputState, SessionSnapshot, SessionStatusEntry, ChatSnapshot } from './contract'

export interface ComposerView {
  card: HTMLElement
  editor: HTMLElement
  focused: boolean
  composing: boolean
  menuOpen: boolean
  editable: boolean
}

export function readComposerView(anchor: HTMLElement | null): ComposerView | null {
  const card = anchor?.closest<HTMLElement>('[data-composer-card]') ?? null
  if (card === null) return null
  const editor = card.querySelector<HTMLElement>('[data-composer-input]')
  if (editor === null) return null
  return {
    card,
    editor,
    focused: document.activeElement === editor,
    composing: editor.hasAttribute('data-composer-composing'),
    menuOpen: document.querySelector('[data-trigger-menu]') !== null,
    editable: editor.getAttribute('contenteditable') === 'true' && editor.getAttribute('aria-disabled') !== 'true',
  }
}

export function isSemanticallyEmpty(input: InputState | undefined): boolean {
  if (input === undefined) return false
  return input.draft === '' &&
    input.attachmentIds.length === 0 &&
    input.occurrences.length === 0 &&
    input.phase === 'plain' &&
    input.claim === undefined &&
    input.queue.length === 0
}

export function canEdit(input: InputState | undefined, session: SessionSnapshot | undefined): boolean {
  if (input === undefined || session === undefined) return false
  if (input.phase !== 'plain' && input.phase !== 'claimed') return false
  if (session.removed || session.blank) return false
  if (session.subagent !== null) return false
  return true
}

export function structuredInteractionOpen(status: SessionStatusEntry | undefined): boolean {
  return status?.pendingInteraction !== undefined
}
```

### 12.3 `src/client/index.ts` — plugin entry pattern

```ts
export const inject = ['slots', 'locale', 'connection'] as const

export function apply(ctx: any): void {
  const slots = ctx.get('slots')
  const locale = ctx.get('locale')
  if (slots === undefined || locale === undefined) return

  // 1) controller/services live in apply scope (survive only as long as the fiber)
  const controller = createPredictionController(ctx)      // owns stores, request state, dedupe maps

  ctx.effect(() => locale.register(NS, { zh, en }), 'next-predict: dictionaries')

  ctx.effect(() => {
    const off = slots.inject('conversation.input.overlay', () =>
      slots.register(
        {
          name: 'conversation.input.overlay',
          id: 'next-predict-ghost',
          order: 100,
          locale: NS,
          inject: () => ({ api: controller.face }), // plain prop: `api`
        },
        createGhostOverlay(react, controller),
      ),
    )
    return () => off()
  }, 'next-predict: overlay entry')

  ctx.effect(() => () => controller.dispose(), 'next-predict: controller')
}
```

`createGhostOverlay` renders: an always-mounted anchor `<div ref={anchorRef} data-next-predict-anchor="" />` positioned in the card, plus, when an offer is visible, an absolutely positioned ghost node with `data-next-predict-ghost=""` and the optional citizen marker `data-composer-ghost="dsh-next-message-predictor"`. The React component owns: selectors (`useInput`, `useSession`, `useSessionStatus`, `useChat`), the offer/turn state machine, the placeholder hide/restore effect, the ResizeObserver measurement effect, and the per-component `useEffect` for the document keydown capture (or one controller-level `document` listener that resolves `ownCard` from a registered map — either is acceptable if cleanup is complete).

### 12.4 Client-side state machine (mirrors DESIGN §五)

`inactive → waiting (turn finished, 250 ms quiet, all guards) → requesting → offered (client+host version check) → accepted | dismissed | suppressed | abstained | failed`, with the terminal states keyed by `(sessionId, turn, lastAssistantSeq)`. Hide rules: `offered` hides on any `InputState` content change (`draft`, attachments, occurrences, phase), IME, menu/pendingInteraction, focus loss (re-show allowed while version unchanged), session switch, plugin disable, or unmount. `accepted`/`dismissed` never re-show for that turn in that view (undo does not resurrect).

---

## 13. P1 test hooks (what the client half must be able to prove)

1. Ghost appears only after a completed turn, on a focused, semantically-empty composer, in the active session.
2. Tab inserts via `insertText` exactly once (single press; held Tab yields one insertion; failed insert does not swallow Tab).
3. `Ctrl+Z` removes only the inserted suggestion, second `Ctrl+Z` leaves the composer empty (no user text was present).
4. Esc dismisses; no repeat for the same turn; `Shift+Tab`/arrow/accelerators untouched.
5. IME: composition in progress → no ghost, no Tab interception; composition commit then re-check.
6. `/` and `@` menu open → ghost hidden, Tab handled by the menu; menu close → offer may re-show only if version unchanged.
7. Approval/question/plan-review pending → composer takeover, overlay unmounted, zero plugin requests.
8. Typing/paste/attachment/reference → ghost hidden immediately (same frame), no re-show for that turn.
9. Session switch A→B: no A content in B; stale response dropped; switching back restores a still-valid cached offer without a new model call.
10. Multi-window/multi-instance: Tab in window 2 acts only on window 2's offer; Esc in one view does not mutate another view's draft.
11. Disable/unload/HMR: no listener, observer, style tag, placeholder marker or ghost node remains; no console error.
12. The plugin never calls `setDraft`, `submit`, `send`/`session/prompt` for prediction: assert via spies on `inputActions` and zero prompt calls.

---

## 14. Quick reference: line-number index

| Fact | Path:line |
|---|---|
| overlay slot declaration (list/session) | CONV 22966–22969 |
| overlay anchor + `renderSlot` | CONV 22025–22029 |
| card DOM / overlay CSS | CONV 22014–22018; CONV 21701 |
| composer bar entry (keyboard inject source) | CONV 21757; CONV 23097 |
| InputBar reads (`running`, `subagent`, `removed`, plan, empty) | CONV 21771–21783 |
| `InputState` publish (`compose`) | CONV 16048–16058 |
| `InputActions` face | CONV 15357–15395 |
| `captureInsertion` / `insertText` | CONV 15370–15378 |
| `frozen` phases | CONV 15327–15330 |
| `insertAsyncText`, `$replaceDetectSpanWithText` | CONV 15113–15126; 14863–14869 |
| history tags (`Co = "paste"`) | CONV 7692; 15065–15084 |
| `registerComposerKeymap` (Tab/Esc/Enter, IME attr) | CONV 21158–21253 |
| editor contenteditable + placeholder JSX | CONV 20974–20982; 21019–21051 |
| `uiSession.provide` conversation/input/inputActions | CONV 22775–22791 |
| session standard source (`session`, `projection`, `sessionId`) | SESSION 755–764 |
| sessionStatus map (`running`, `pendingInteraction`, `completionUnread`) | SESSION 992–1008 |
| root standard hooks (`sessions`, `sessionStatus`) | SESSION 1120–1129 |
| `SessionSnapshot` builder | SESSCTRL 2913–2936 |
| legacy chat nodes / turns map | CHAT 11220–11384 |
| assistant final node | CHAT 10111–10146 |
| turn-error / max-tokens rows | CHAT 12582–12721 |
| turn-tail data (turn/end seq) | CHAT 13258–13328 |
| `/`+`@` menu entry + `data-trigger-menu` | TRIGGER 1991–2001; 1732–1735 |
| keymap arbitration verdicts | TRIGGER 1174–1218 |
| `command-popup` entry | COMMANDS 2295–2305 |
| `feedback-dialog` entry / body portal | FEEDBACK 985–1009; 30–40 |
| approval takeover + `[data-approval-key]` | APPROVAL 468–474; 79–83 |
| question/plan-review pending + DOM markers | QUESTIONS 2249–2269; 1043; 544; 185 |
| standard props assembly (root+scope, use<Name>) | RENDERER 663–702; 724–739; 435–459 |
| client manifest parser | MODULES 86–100 |
| lazy-CJS loader / `__ModuleLoader__` | MODULES 40–62; CONV 1–6 |
| connection RPC call + auth | CONN 1200–1232; 1421–1443; CONN_README 41–49 |
| locale register + `t` seat | LOCALE_README 38–40, 68 |
| cleanup on disable / HMR styles | MODULES_README 47; HMR_README 36, 48, 66 |
| prior-art working patterns | REF 281, 708–724, 866–873, 1386–1408, 1410–1432, 1483–1519, 1532–1539 |

*End of document. Anything marked `partial` must be re-validated by the P1 E2E matrix in §13 before the client half is declared complete.*
