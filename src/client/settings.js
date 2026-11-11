// Settings section for dsh-next-message-predictor.
//
// Contributed through the shipped `settings.section` list slot (the same slot
// that hosts "Built-in plugins") and, when the user adds the sidebar entry,
// shown again as a global panel opened from the left sidebar. The header
// carries the plugin version and the add-to-sidebar button. Five cards are
// always open — basics, mode, suggestion sources, model, last 7 days — and
// everything rarely changed sits in one folded "advanced options" block. Every option carries a "?" help
// icon; numeric options are range-checked against SETTING_LIMITS and show a
// risk note above their warning threshold. Every write goes through the Host's
// config editor, so there is one authoritative config document.
// This file is concatenated into the browser bundle: plain declarations only.

import { DEFAULT_CONFIG, DEFAULT_PREDICT_SHORTCUT, LANGUAGE_AUTO, LANGUAGE_IDS, PANEL_ID, SETTING_LIMITS, formatShortcut, parseShortcut, shortcutFromEvent } from '../shared/config.js'
import { PRESETS, PRESET_IDS, RECOMMENDED_PRESET, RECOMMENDED_ROUTE, matchPreset, presetPatch } from '../shared/presets.js'
import { PLUGIN_VERSION } from '../shared/version.js'
import { NMP_LANGUAGE_NAMES, nmpBracket } from './i18n.js'
import { nmpCodeLabel } from './labels.js'

/** Subscribe to a tiny store with the current snapshot. */
function useStoreSettings(react, store) {
  return react.useSyncExternalStore(store.subscribe, store.getSnapshot)
}

const FIELD_STYLE = {
  boxSizing: 'border-box',
  width: '100%',
  height: '34px',
  padding: '0 10px',
  borderRadius: 'var(--dsw-radius-md, 8px)',
  border: '1px solid var(--dsw-alias-border-l2)',
  background: 'var(--dsw-alias-bg-layer-1)',
  color: 'var(--dsw-alias-label-primary)',
  fontFamily: 'inherit',
  fontSize: '13px',
  lineHeight: '20px',
}

const CARD_STYLE = {
  display: 'flex',
  flexDirection: 'column',
  gap: '12px',
  padding: '14px 16px',
  borderRadius: '12px',
  border: '1px solid var(--dsw-alias-border-l2)',
  background: 'var(--dsw-alias-bg-layer-2)',
}

const NMP_TITLE_STYLE = { fontSize: '14px', fontWeight: 600, color: 'var(--dsw-alias-label-primary)' }
const NMP_ROW_TITLE_STYLE = { fontSize: '13px', lineHeight: '20px', color: 'var(--dsw-alias-label-primary)' }
const NMP_HINT_STYLE = { fontSize: '12px', lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)' }
const NMP_GROUP_STYLE = { fontSize: '12px', fontWeight: 600, letterSpacing: '0.02em', color: 'var(--dsw-alias-label-secondary)' }
const NMP_LABEL_STYLE = { display: 'flex', flexDirection: 'column', gap: '6px', fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' }
const NMP_DIVIDER = '1px solid var(--dsw-alias-border-l2)'
const NMP_DANGER = 'var(--dsw-alias-accent-danger, #e5484d)'
const NMP_WARNING = 'var(--dsw-alias-accent-warning, #c77700)'
const NMP_ACCENT = 'var(--dsw-alias-accent-primary, #4d6bfe)'
const NMP_KBD_STYLE = {
  display: 'inline-block',
  padding: '0 6px',
  minWidth: '18px',
  textAlign: 'center',
  borderRadius: '5px',
  border: '1px solid var(--dsw-alias-border-l2)',
  borderBottomWidth: '2px',
  background: 'var(--dsw-alias-bg-layer-1)',
  color: 'var(--dsw-alias-label-secondary)',
  fontFamily: 'var(--ds-font-family-code, monospace)',
  fontSize: '11px',
  lineHeight: '18px',
  whiteSpace: 'nowrap',
}

/** Options that "restore defaults" in the advanced block puts back. */
const NMP_ADVANCED_FIELDS = [
  'triggerDelayMs', 'autoWindowMinutes', 'manualLimit', 'candidateCount', 'habitMinCount',
  'contextMessages', 'targetInputTokens', 'maxContextCodePoints', 'includeTurnFacts', 'redactSecrets',
  'maxSuggestionGraphemes', 'maxOutputTokens', 'timeoutMs', 'dailyRequestLimit', 'dailyTokenBudget', 'announceSuggestions',
]

/** 1234567 -> "1,234,567"; non-numbers -> "—". */
function nmpNumber(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return '—'
  return String(Math.round(number)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

/**
 * Milliseconds -> seconds with one decimal plus the unit ("1.5 s"); "—" alone
 * when there is nothing worth quoting.
 */
function nmpSeconds(value, unit) {
  const number = Number(value)
  // Under 50 ms is a cache hit or the offline test path, not a model call.
  return Number.isFinite(number) && number >= 50 ? `${(number / 1000).toFixed(1)}${unit}` : '—'
}

/**
 * Whether the advanced block is open. Saving an option makes the Host reload
 * the plugin, which remounts this page; without remembering it outside React
 * the block would fold shut after every change.
 */
const NMP_ADVANCED_OPEN_KEY = 'dsh-next-message-predictor.settings.advancedOpen'
function nmpReadAdvancedOpen() {
  try {
    return globalThis.sessionStorage?.getItem(NMP_ADVANCED_OPEN_KEY) === '1'
  } catch {
    return false
  }
}
function nmpWriteAdvancedOpen(open) {
  try {
    globalThis.sessionStorage?.setItem(NMP_ADVANCED_OPEN_KEY, open ? '1' : '0')
  } catch {
    /* storage unavailable: the block simply starts folded */
  }
}

/**
 * What the advanced block last opened itself for. It opens once per problem
 * (a config error, masking switched off); after the user folds it again it
 * stays folded across the page remounts every save causes, until the problem
 * changes.
 */
const NMP_ADVANCED_ATTENTION_KEY = 'dsh-next-message-predictor.settings.advancedAttention'
function nmpReadAdvancedAttention() {
  try {
    return globalThis.sessionStorage?.getItem(NMP_ADVANCED_ATTENTION_KEY) ?? ''
  } catch {
    return ''
  }
}
function nmpWriteAdvancedAttention(signature) {
  try {
    if (signature === '') globalThis.sessionStorage?.removeItem(NMP_ADVANCED_ATTENTION_KEY)
    else globalThis.sessionStorage?.setItem(NMP_ADVANCED_ATTENTION_KEY, signature)
  } catch {
    /* storage unavailable: the block opens again after a remount */
  }
}

/** "?" icon with a hover/focus tooltip. One per option. */
function createHelpComponent(react) {
  const { createElement: h, useState } = react
  return function NmpHelp(props) {
    const [open, setOpen] = useState(false)
    return h(
      'span',
      {
        'data-nmp-help': props.name,
        tabIndex: 0,
        role: 'button',
        'aria-label': props.text,
        onMouseEnter: () => setOpen(true),
        onMouseLeave: () => setOpen(false),
        onFocus: () => setOpen(true),
        onBlur: () => setOpen(false),
        style: {
          position: 'relative',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          flex: 'none',
          width: '15px',
          height: '15px',
          marginLeft: '6px',
          borderRadius: '50%',
          border: '1px solid var(--dsw-alias-border-l2)',
          color: open ? NMP_ACCENT : 'var(--dsw-alias-label-tertiary)',
          borderColor: open ? NMP_ACCENT : 'var(--dsw-alias-border-l2)',
          fontSize: '10px',
          lineHeight: 1,
          fontWeight: 600,
          cursor: 'help',
          verticalAlign: 'middle',
          outline: 'none',
        },
      },
      '?',
      open
        ? h(
            'span',
            {
              role: 'tooltip',
              style: {
                position: 'absolute',
                top: '21px',
                // A "?" near the right edge opens leftwards so the text stays on the page.
                ...(props.align === 'right' ? { right: '-10px' } : { left: '-10px' }),
                zIndex: 30,
                width: '300px',
                maxWidth: '70vw',
                padding: '8px 10px',
                borderRadius: '8px',
                border: '1px solid var(--dsw-alias-border-l2)',
                background: 'var(--dsw-alias-bg-layer-1)',
                boxShadow: '0 6px 20px rgba(0, 0, 0, 0.16)',
                color: 'var(--dsw-alias-label-secondary)',
                fontSize: '12px',
                lineHeight: '18px',
                fontWeight: 400,
                textAlign: 'left',
                whiteSpace: 'normal',
                cursor: 'default',
              },
            },
            props.text,
          )
        : null,
    )
  }
}

/**
 * @param {object} react - host-provided React namespace.
 * @param {object} runtime - client runtime (configStore/saveConfig/loadStatus).
 * @param {(key: string) => string} t - plugin namespace translate.
 */
export function createSettingsComponent(react, runtime, t) {
  const { createElement: h, useState, useEffect } = react
  const NmpHelp = createHelpComponent(react)

  return function NextMessagePredictorSettings() {
    const configState = useStoreSettings(react, runtime.configStore)
    const assist = useStoreSettings(react, runtime.assistStore)
    const [busy, setBusy] = useState(false)
    const [message, setMessage] = useState(null)
    const [fakeText, setFakeText] = useState(null)
    const [drafts, setDrafts] = useState({})
    const [fieldErrors, setFieldErrors] = useState({})
    const [modeText, setModeText] = useState(null)
    const [providerText, setProviderText] = useState(null)
    const [modelText, setModelText] = useState(null)
    const [effortText, setEffortText] = useState(null)
    const [results, setResults] = useState(null)
    const [resultsBusy, setResultsBusy] = useState(false)
    const [recording, setRecording] = useState(false)
    const [confirmRedact, setConfirmRedact] = useState(false)
    const [advancedOpen, setAdvancedOpen] = useState(nmpReadAdvancedOpen)
    const shell = useStoreSettings(react, runtime.shellStore)
    const config = configState.config
    const diagnostics = configState.diagnostics
    const counters = diagnostics && diagnostics.counters ? diagnostics.counters : null
    // Strings name the predict shortcut as `{key}`; show whatever is set.
    const keyLabel = formatShortcut(config.predictShortcut)
    const tk = (key) => t(key).split('{key}').join(keyLabel)

    const loadResultsNow = () => {
      setResultsBusy(true)
      void runtime.loadResults().then((value) => {
        setResults(value)
        setResultsBusy(false)
      })
    }
    useEffect(() => {
      loadResultsNow()
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])

    /**
     * Write a config patch and report the outcome under the header.
     * @param {object} patch
     * @param {string} successKey - locale key of the success note (`{key}` = shortcut).
     * @param {{text?: string, undo?: object}} [options] - `text` replaces the note;
     *   `undo` is the patch that puts the previous values back (offered as a button).
     */
    const save = async (patch, successKey, options) => {
      setBusy(true)
      setMessage(null)
      const result = await runtime.saveConfig(patch)
      setBusy(false)
      // A note about a shortcut that was just changed must name the new one.
      const label = typeof patch.predictShortcut === 'string' ? formatShortcut(patch.predictShortcut) : keyLabel
      setMessage(
        result.ok === true
          ? { ok: true, text: typeof options?.text === 'string' ? options.text : t(successKey).split('{key}').join(label), undo: options?.undo ?? null }
          : { ok: false, text: `${t('settings.saveFailed')}${t('settings.colon')}${nmpSaveError(t, result.error)}`, undo: null },
      )
      return result
    }

    // A success note leaves by itself (later when it offers "undo"); a failure
    // stays until the next action.
    useEffect(() => {
      if (message === null || message.ok !== true) return undefined
      const timer = setTimeout(() => setMessage(null), message.undo ? 10000 : 4000)
      return () => clearTimeout(timer)
    }, [message])

    // Something in the folded block needs attention (a config error, masking
    // switched off): open it once. The user can still fold it again.
    const attention = configState.ready !== true
      ? ''
      : [...(Array.isArray(configState.configErrors) ? configState.configErrors : []), config.redactSecrets === false ? 'redact-off' : ''].filter((part) => part !== '').join('|')
    useEffect(() => {
      if (configState.ready !== true) return
      if (attention === nmpReadAdvancedAttention()) return
      nmpWriteAdvancedAttention(attention)
      if (attention !== '') {
        nmpWriteAdvancedOpen(true)
        setAdvancedOpen(true)
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [attention, configState.ready])

    // Shortcut recorder: the next key combination becomes the predict shortcut.
    useEffect(() => {
      if (!recording) return undefined
      const onKeyDown = (event) => {
        event.preventDefault()
        event.stopPropagation()
        if (event.key === 'Escape') {
          setRecording(false)
          return
        }
        const candidate = shortcutFromEvent(event)
        if (candidate === '') return // only modifiers so far
        if (parseShortcut(candidate) === null) {
          setMessage({ ok: false, text: t('settings.shortcutInvalid') })
          return
        }
        setRecording(false)
        if (candidate !== config.predictShortcut) void save({ predictShortcut: candidate }, 'settings.shortcutSaved')
      }
      window.addEventListener('keydown', onKeyDown, true)
      return () => window.removeEventListener('keydown', onKeyDown, true)
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [recording, config.predictShortcut])

    const toggle = (field, nextValue, successKey) => {
      if (busy) return
      void save({ [field]: nextValue }, successKey)
    }

    const saveFake = () => {
      if (busy) return
      const value = fakeText === null ? config.fakeSuggestion : fakeText
      void save({ fakeSuggestion: value }, 'settings.saved').then((result) => {
        if (result.ok === true) setFakeText(null)
      })
    }

    /** Range-check one numeric option against SETTING_LIMITS, then save it. */
    const saveNumber = (field) => {
      const text = drafts[field]
      if (busy || text === undefined) return
      const clearDraft = () => setDrafts((previous) => { const next = { ...previous }; delete next[field]; return next })
      const setError = (value) => setFieldErrors((previous) => ({ ...previous, [field]: value }))
      if (text.trim() === String(config[field])) {
        clearDraft()
        setError('')
        return
      }
      const limits = SETTING_LIMITS[field]
      const value = Number(text)
      if (text.trim() === '' || !Number.isInteger(value) || value < limits.min || value > limits.max) {
        setError(`${t('settings.rangeError')}${nmpNumber(limits.min)} – ${nmpNumber(limits.max)}`)
        return
      }
      setError('')
      // The character cap follows the token target so the two limits never disagree.
      const patch = field === 'targetInputTokens' ? { targetInputTokens: value, maxContextCodePoints: Math.min(60000, value * 3) } : { [field]: value }
      void save(patch, 'settings.saved').then((result) => {
        if (result.ok === true) clearDraft()
      })
    }

    // Model route form: pending values fall back to the saved config.
    const pendingRoute = {
      modelMode: modeText === null ? config.modelMode : modeText,
      provider: (providerText === null ? config.provider : providerText).trim(),
      model: (modelText === null ? config.model : modelText).trim(),
      reasoningEffort: (effortText === null ? config.reasoningEffort : effortText).trim(),
    }
    const routeDirty =
      pendingRoute.modelMode !== config.modelMode ||
      pendingRoute.provider !== config.provider ||
      pendingRoute.model !== config.model ||
      pendingRoute.reasoningEffort !== config.reasoningEffort
    const routeIncomplete = pendingRoute.modelMode === 'fixed' && (pendingRoute.provider === '' || pendingRoute.model === '')
    const isRecommended = Object.keys(RECOMMENDED_ROUTE).every((key) => config[key] === RECOMMENDED_ROUTE[key])

    const resetRouteForm = () => {
      setModeText(null)
      setProviderText(null)
      setModelText(null)
      setEffortText(null)
    }

    const saveRoute = () => {
      if (busy || !routeDirty || routeIncomplete) return
      void save(pendingRoute, 'settings.saved').then((result) => {
        if (result.ok === true) resetRouteForm()
      })
    }

    /**
     * The mode dropdown applies at once, like the switches on this page, when
     * the resulting route is complete. A specific model without provider/model
     * ids stays pending so the fields can be filled in first.
     */
    const changeModelMode = (value) => {
      if (busy) return
      const next = { ...pendingRoute, modelMode: value }
      if (value === 'fixed' && (next.provider === '' || next.model === '')) {
        setModeText(value)
        return
      }
      void save(next, 'settings.saved').then((result) => {
        if (result.ok === true) resetRouteForm()
        else setModeText(value)
      })
    }

    /** One-click mode: write every option the mode owns, offer to undo. */
    const activePreset = matchPreset(config)
    const applyPreset = (id) => {
      if (busy || id === activePreset) return
      const patch = presetPatch(id, config)
      if (patch === null) return
      const undo = {}
      for (const key of Object.keys(patch)) undo[key] = config[key]
      const name = t(`preset.${id}.name`)
      const text = `${t('preset.applied').split('{name}').join(name)}${config.enabled === true ? '' : t('preset.appliedWhileOff')}`
      resetRouteForm()
      setDrafts({})
      setFieldErrors({})
      void save(patch, 'settings.saved', { text, undo })
    }
    const undoLast = () => {
      if (busy || message === null || !message.undo) return
      void save(message.undo, 'settings.undone')
    }

    /** One click adds this page to the left sidebar, or takes it off again. */
    const sidebarOn = config.sidebarEntry === true
    const toggleSidebarEntry = () => {
      if (busy) return
      void save({ sidebarEntry: !sidebarOn }, sidebarOn ? 'settings.sidebarRemoved' : 'settings.sidebarAdded')
    }

    /** Interface language: applies at once, like the switches. */
    const languageSetting = config.language === LANGUAGE_AUTO || LANGUAGE_IDS.includes(config.language) ? config.language : LANGUAGE_AUTO
    const changeLanguage = (value) => {
      if (busy || value === languageSetting) return
      // The note is worded after the save, so it is already in the new language.
      void save({ language: value }, 'settings.languageSaved', { undo: { language: languageSetting } })
    }

    /** The recommended route is complete and known: one click applies it, with undo. */
    const useRecommended = () => {
      if (busy) return
      const undo = { modelMode: config.modelMode, provider: config.provider, model: config.model, reasoningEffort: config.reasoningEffort }
      resetRouteForm()
      void save({ ...RECOMMENDED_ROUTE }, 'settings.routeRecommendedSaved', { undo })
    }

    const onEnter = (action) => (event) => {
      if (event.key === 'Enter') action()
    }

    const help = (name, align) => h(NmpHelp, { name, text: tk(`help.${name}`), align })

    /**
     * One option row: title + "?" on the left, a control on the right, and an
     * optional note under the title (current state, warning or error).
     */
    const row = (name, title, control, options) => {
      const opts = options ?? {}
      return h(
        'div',
        {
          key: name,
          'data-nmp-row': name,
          style: {
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '16px',
            paddingTop: opts.first ? 0 : '12px',
            borderTop: opts.first ? 'none' : NMP_DIVIDER,
            opacity: opts.dim ? 0.5 : 1,
          },
        },
        h(
          'div',
          { style: { minWidth: 0 } },
          h('div', { style: { ...(opts.strong ? NMP_TITLE_STYLE : NMP_ROW_TITLE_STYLE), display: 'flex', alignItems: 'center' } }, title, help(opts.help ?? name)),
          opts.note ? h('div', { 'data-nmp-note': name, style: { ...NMP_HINT_STYLE, color: opts.noteColor ?? NMP_HINT_STYLE.color } }, opts.note) : null,
        ),
        control,
      )
    }

    /** A numeric option: range from SETTING_LIMITS, saved on Enter or blur. */
    const numberRow = (field, options) => {
      const limits = SETTING_LIMITS[field]
      const opts = options ?? {}
      const current = Number(config[field])
      const error = fieldErrors[field] ?? ''
      const risky = error === '' && typeof limits.warnAbove === 'number' && current > limits.warnAbove
      return row(
        field,
        t(`settings.${field}`),
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: '6px', flex: 'none' } },
          h('input', {
            type: 'number',
            min: limits.min,
            max: limits.max,
            step: limits.step,
            'data-nmp-setting': field,
            'aria-label': t(`settings.${field}`),
            style: { ...FIELD_STYLE, width: '112px', borderColor: error !== '' ? NMP_DANGER : risky ? NMP_WARNING : FIELD_STYLE.border.split(' ').slice(2).join(' ') },
            value: drafts[field] === undefined ? String(config[field]) : drafts[field],
            disabled: busy,
            onChange: (event) => setDrafts((previous) => ({ ...previous, [field]: event.target.value })),
            onBlur: () => saveNumber(field),
            onKeyDown: onEnter(() => saveNumber(field)),
          }),
          h('span', { style: { ...NMP_HINT_STYLE, width: '34px' } }, t(`unit.${field}`)),
        ),
        {
          first: opts.first,
          dim: opts.dim,
          note: error !== '' ? error : risky ? t(`warn.${field}`) : `${t('settings.rangeLabel')}${nmpNumber(limits.min)} – ${nmpNumber(limits.max)}${t('settings.defaultLabel')}${nmpNumber(DEFAULT_CONFIG[field])}`,
          noteColor: error !== '' ? NMP_DANGER : risky ? NMP_WARNING : undefined,
        },
      )
    }

    const group = (key, first) => h('div', { key: `group-${key}`, style: { ...NMP_GROUP_STYLE, paddingTop: first ? 0 : '16px', borderTop: first ? 'none' : NMP_DIVIDER } }, t(`settings.group.${key}`))
    const kbd = (label, key) => h('kbd', { key, style: NMP_KBD_STYLE }, label)

    const rows = []
    // The Host answers `status` with its own version. A different one means the
    // page was refreshed after an update but DSH has not been restarted yet.
    const hostVersion = configState.hostVersion
    const versionMismatch = configState.ready === true && configState.hostError === '' && hostVersion !== PLUGIN_VERSION
    // Header: what this is, which version, and the one-click sidebar entry.
    rows.push(
      h(
        'div',
        { 'data-nmp-setting': 'header', style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap' } },
          h(
            'div',
            { style: { display: 'flex', alignItems: 'baseline', gap: '8px', minWidth: 0 } },
            h('h2', { style: { margin: 0, fontSize: '18px', fontWeight: 600, color: 'var(--dsw-alias-label-primary)' } }, t('settings.title')),
            h(
              'span',
              {
                'data-nmp-setting': 'version',
                title: `${t('settings.versionLabel')} ${PLUGIN_VERSION}`,
                'aria-label': `${t('settings.versionLabel')} ${PLUGIN_VERSION}`,
                style: {
                  padding: '0 7px',
                  borderRadius: '9px',
                  border: `1px solid ${versionMismatch ? NMP_WARNING : 'var(--dsw-alias-border-l2)'}`,
                  color: versionMismatch ? NMP_WARNING : 'var(--dsw-alias-label-tertiary)',
                  fontFamily: 'var(--ds-font-family-code, monospace)',
                  fontSize: '11px',
                  lineHeight: '18px',
                  whiteSpace: 'nowrap',
                },
              },
              `v${PLUGIN_VERSION}`,
            ),
          ),
          // Only offered where DSH has a left sidebar to add the entry to.
          configState.ready === true && shell.sidebarAvailable === true
            ? h(
                'div',
                { style: { display: 'flex', alignItems: 'center', flex: 'none' } },
                h(
                  'button',
                  {
                    type: 'button',
                    'data-nmp-setting': 'sidebarEntry',
                    'aria-pressed': sidebarOn,
                    disabled: busy || configState.hostError !== '',
                    onClick: toggleSidebarEntry,
                    style: {
                      ...buttonStyle(busy || configState.hostError !== ''),
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: '6px',
                      ...(sidebarOn ? {} : { borderColor: NMP_ACCENT, color: NMP_ACCENT }),
                    },
                  },
                  nmpPinIcon(h, sidebarOn),
                  t(sidebarOn ? 'settings.sidebarRemove' : 'settings.sidebarAdd'),
                ),
                help('sidebarEntry', 'right'),
              )
            : null,
        ),
        h('p', { style: { margin: 0, fontSize: '13px', lineHeight: '20px', color: 'var(--dsw-alias-label-tertiary)' } }, t('settings.desc')),
        versionMismatch
          ? h(
              'p',
              { 'data-nmp-setting': 'versionMismatch', role: 'status', style: { margin: 0, fontSize: '12px', lineHeight: '18px', color: NMP_WARNING } },
              (hostVersion === '' ? t('settings.versionHostOld') : t('settings.versionHostOther').split('{host}').join(hostVersion)).split('{version}').join(PLUGIN_VERSION),
            )
          : null,
      ),
    )

    if (configState.ready !== true) {
      rows.push(h('div', { style: { ...CARD_STYLE, fontSize: '13px', color: 'var(--dsw-alias-label-tertiary)' } }, t('settings.loading')))
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px', maxWidth: '720px' } }, rows)
    }

    if (configState.hostError !== '') {
      rows.push(
        h(
          'div',
          { style: { ...CARD_STYLE, gap: '4px', borderColor: NMP_DANGER, fontSize: '13px', color: NMP_DANGER } },
          h('div', null, t('settings.hostUnavailable')),
          h('div', { 'data-nmp-setting': 'hostError', style: { fontSize: '12px' } }, nmpCodeLabel(t, 'reason', configState.hostError)),
        ),
      )
    }

    // Save feedback sits right under the header so it is visible from every card.
    if (message !== null) {
      rows.push(
        h(
          'div',
          {
            role: 'status',
            'data-nmp-setting': 'message',
            style: {
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: '12px',
              padding: '8px 12px',
              borderRadius: '8px',
              fontSize: '13px',
              border: `1px solid ${message.ok ? 'var(--dsw-alias-border-l2)' : NMP_DANGER}`,
              color: message.ok ? 'var(--dsw-alias-label-secondary)' : NMP_DANGER,
            },
          },
          h('span', { style: { minWidth: 0, overflowWrap: 'anywhere' } }, message.text),
          message.ok && message.undo
            ? h(
                'button',
                { type: 'button', 'data-nmp-setting': 'undo', disabled: busy, onClick: undoLast, style: { ...buttonStyle(busy), height: '26px', flex: 'none' } },
                t('settings.undo'),
              )
            : null,
        ),
      )
    }

    // ── Card 1: basics ──────────────────────────────────────────────────────
    const enabled = config.enabled === true
    const autoPredict = config.manualOnly !== true
    const showButton = config.showPredictButton !== false
    const waitingStates = ['idle', 'closed']
    const stateText = !enabled
      ? t('state.disabled')
      : !autoPredict && waitingStates.includes(assist.status)
        ? tk('state.manualWaiting')
        : nmpCodeLabel(t, 'state', assist.status)
    // A conflict already says what is wrong; the detail worth adding is who the other plugin is.
    const stateReason = !enabled || !assist.reason
      ? ''
      : assist.status === 'conflict'
        ? assist.reason.replace(/^conflict:/, '')
        : nmpCodeLabel(t, 'reason', assist.reason)
    const stateLine = `${t('settings.stateNow')}${stateText}${stateReason !== '' && stateReason !== stateText ? nmpBracket(t.language(), stateReason) : ''}`
    const stateBad = enabled && (assist.status === 'conflict' || assist.status === 'failed')
    const isDefaultShortcut = (parseShortcut(config.predictShortcut) === null ? DEFAULT_PREDICT_SHORTCUT : config.predictShortcut) === DEFAULT_PREDICT_SHORTCUT

    rows.push(
      h(
        'div',
        { style: CARD_STYLE },
        row(
          'enabled',
          t('settings.enabled'),
          nmpSwitch(h, { name: 'enabled', checked: enabled, disabled: busy, label: t('settings.enabled'), onClick: () => toggle('enabled', !enabled, enabled ? 'settings.savedOff' : 'settings.savedOn') }),
          { first: true, strong: true, note: h('span', { 'data-nmp-setting': 'state' }, stateLine), noteColor: stateBad ? NMP_DANGER : undefined },
        ),
        row(
          'autoPredict',
          t('settings.autoPredict'),
          // The stored field is `manualOnly`; the switch shows its positive form.
          nmpSwitch(h, { name: 'manualOnly', checked: autoPredict, disabled: busy || !enabled, label: t('settings.autoPredict'), onClick: () => toggle('manualOnly', autoPredict, autoPredict ? 'settings.savedManual' : 'settings.savedAuto') }),
          { dim: !enabled },
        ),
        row(
          'predictButton',
          t('settings.predictButton'),
          nmpSwitch(h, { name: 'showPredictButton', checked: showButton, disabled: busy || !enabled, label: t('settings.predictButton'), onClick: () => toggle('showPredictButton', !showButton, 'settings.saved') }),
          { dim: !enabled },
        ),
        row(
          'shortcut',
          t('settings.shortcut'),
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: '8px', flex: 'none' } },
            !recording && !isDefaultShortcut
              ? h(
                  'button',
                  {
                    type: 'button',
                    'data-nmp-setting': 'shortcutReset',
                    disabled: busy,
                    onClick: () => toggle('predictShortcut', DEFAULT_PREDICT_SHORTCUT, 'settings.shortcutSaved'),
                    style: { ...buttonStyle(busy), border: 'none', background: 'transparent', color: 'var(--dsw-alias-label-tertiary)', padding: '0 4px' },
                  },
                  t('settings.shortcutReset'),
                )
              : null,
            h(
              'button',
              {
                type: 'button',
                'data-nmp-setting': 'predictShortcut',
                'aria-label': `${t('settings.shortcut')}: ${keyLabel}`,
                disabled: busy || !enabled,
                onClick: () => setRecording(!recording),
                style: {
                  ...buttonStyle(busy || !enabled),
                  minWidth: '96px',
                  fontFamily: recording ? 'inherit' : 'var(--ds-font-family-code, monospace)',
                  borderColor: recording ? NMP_ACCENT : 'var(--dsw-alias-border-l2)',
                  color: recording ? NMP_ACCENT : 'var(--dsw-alias-label-primary)',
                },
              },
              recording ? t('settings.shortcutPress') : keyLabel,
            ),
          ),
          { dim: !enabled, note: recording ? t('settings.shortcutRecording') : '', noteColor: NMP_ACCENT },
        ),
        row(
          'language',
          t('settings.language'),
          h(
            'select',
            {
              'data-nmp-setting': 'language',
              'aria-label': t('settings.language'),
              style: { ...FIELD_STYLE, width: '168px', flex: 'none' },
              value: languageSetting,
              disabled: busy,
              onChange: (event) => changeLanguage(event.target.value),
            },
            h('option', { value: LANGUAGE_AUTO }, t('settings.languageAuto')),
            // Each language under its own name, whatever language the page is in.
            LANGUAGE_IDS.map((id) => h('option', { key: id, value: id, lang: id }, NMP_LANGUAGE_NAMES[id])),
          ),
        ),
        // Key legend: everything the keyboard does, in one line.
        h(
          'div',
          {
            'data-nmp-setting': 'keys',
            style: { ...NMP_HINT_STYLE, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '6px 14px', paddingTop: '12px', borderTop: NMP_DIVIDER },
          },
          h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: '6px' } }, kbd('Tab', 'k1'), kbd('→', 'k2'), t('settings.keyAdopt')),
          h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: '6px' } }, kbd('Esc', 'k3'), t('settings.keyHide')),
          h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: '6px' } }, kbd(keyLabel, 'k4'), t('settings.keyPredict')),
        ),
      ),
    )

    // ── Card 2: one-click modes ─────────────────────────────────────────────
    const presetFacts = (id) => {
      const values = PRESETS[id]
      return [
        t(values.manualOnly ? 'preset.fact.manual' : 'preset.fact.auto'),
        t(values.modelMode === 'fixed' ? 'preset.fact.fixed' : 'preset.fact.session'),
        t('preset.fact.context').split('{n}').join(String(values.contextMessages)),
        t('preset.fact.daily').split('{n}').join(nmpNumber(values.dailyRequestLimit)),
      ].join(t('preset.fact.separator'))
    }
    rows.push(
      h(
        'div',
        { 'data-nmp-setting': 'presets', style: CARD_STYLE },
        h(
          'div',
          null,
          h('div', { style: { ...NMP_TITLE_STYLE, display: 'flex', alignItems: 'center' } }, t('preset.title'), help('presets')),
          h(
            'div',
            { 'data-nmp-setting': 'presetNow', style: NMP_HINT_STYLE },
            activePreset === '' ? t('preset.custom') : `${t('preset.current')}${t(`preset.${activePreset}.name`)}`,
          ),
        ),
        h(
          'div',
          { role: 'group', 'aria-label': t('preset.title'), style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '10px' } },
          PRESET_IDS.map((id) => {
            const active = id === activePreset
            return h(
              'button',
              {
                key: id,
                type: 'button',
                'data-nmp-preset': id,
                'aria-pressed': active,
                disabled: busy,
                onClick: () => applyPreset(id),
                style: {
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'stretch',
                  gap: '4px',
                  minWidth: 0,
                  padding: '10px 12px',
                  borderRadius: '10px',
                  border: `1px solid ${active ? NMP_ACCENT : 'var(--dsw-alias-border-l2)'}`,
                  boxShadow: active ? `inset 0 0 0 1px ${NMP_ACCENT}` : 'none',
                  background: 'var(--dsw-alias-bg-layer-1)',
                  color: 'var(--dsw-alias-label-primary)',
                  fontFamily: 'inherit',
                  textAlign: 'left',
                  cursor: busy ? 'default' : active ? 'default' : 'pointer',
                  opacity: busy ? 0.6 : 1,
                },
              },
              h(
                'span',
                { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' } },
                h(
                  'span',
                  { style: { display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '13px', lineHeight: '20px', fontWeight: 600 } },
                  t(`preset.${id}.name`),
                  id === RECOMMENDED_PRESET
                    ? h('span', { style: { padding: '0 5px', borderRadius: '4px', background: NMP_ACCENT, color: '#ffffff', fontSize: '10px', lineHeight: '16px', fontWeight: 600 } }, t('preset.recommended'))
                    : null,
                ),
                active ? h('span', { style: { fontSize: '11px', lineHeight: '18px', color: NMP_ACCENT, whiteSpace: 'nowrap' } }, t('preset.inUse')) : null,
              ),
              h('span', { style: { ...NMP_HINT_STYLE, color: 'var(--dsw-alias-label-secondary)' } }, tk(`preset.${id}.desc`)),
              h('span', { style: NMP_HINT_STYLE }, presetFacts(id)),
            )
          }),
        ),
      ),
    )

    // ── Card 3: where suggestions come from ─────────────────────────────────
    const multi = config.multiCandidates !== false
    const habits = config.habitSuggestions !== false
    rows.push(
      h(
        'div',
        { style: CARD_STYLE },
        h('div', { style: NMP_TITLE_STYLE }, t('settings.sourcesTitle')),
        row(
          'habits',
          t('settings.habits'),
          nmpSwitch(h, { name: 'habitSuggestions', checked: habits, disabled: busy || !enabled, label: t('settings.habits'), onClick: () => toggle('habitSuggestions', !habits, 'settings.saved') }),
          { first: true, dim: !enabled },
        ),
        row(
          'multi',
          t('settings.multi'),
          nmpSwitch(h, { name: 'multiCandidates', checked: multi, disabled: busy || !enabled, label: t('settings.multi'), onClick: () => toggle('multiCandidates', !multi, 'settings.saved') }),
          { dim: !enabled },
        ),
      ),
    )

    // ── Card 4: which model predicts ────────────────────────────────────────
    const route = configState.route
    const routeLabels = { session: 'settings.routeSession', default: 'settings.routeDefault', fixed: 'settings.routeFixed' }
    const fixedMode = pendingRoute.modelMode === 'fixed'
    const fixedTest = config.modelMode === 'fixed' && config.provider === 'fixed-test'
    let routeNow
    if (route !== null && route !== undefined && route.error !== undefined) {
      routeNow = h('div', { style: { fontSize: '12px', color: NMP_DANGER } }, `${t('settings.routeError')}${nmpCodeLabel(t, 'reason', route.error)}`)
    } else if (route === null || route === undefined) {
      routeNow = h('div', { style: NMP_HINT_STYLE }, fixedTest ? t('settings.routeFixedTest') : t('settings.routeUnknown'))
    } else {
      routeNow = h(
        'div',
        { style: NMP_HINT_STYLE },
        `${t(routeLabels[route.source] ?? 'settings.routeFixed')}${route.provider} / ${route.model}${route.reasoningEffort ? `${t('settings.routeEffortInline')}${route.reasoningEffort}` : ''}`,
      )
    }
    const routeField = (name, label, value, setter, placeholder) =>
      h(
        'label',
        { style: NMP_LABEL_STYLE },
        h('span', { style: { display: 'flex', alignItems: 'center' } }, label, help(name)),
        h('input', {
          type: 'text',
          'data-nmp-setting': name,
          style: FIELD_STYLE,
          value,
          placeholder,
          disabled: busy,
          onChange: (event) => setter(event.target.value),
          onKeyDown: onEnter(saveRoute),
        }),
      )
    rows.push(
      h(
        'div',
        { style: CARD_STYLE },
        h(
          'div',
          null,
          h('div', { style: { ...NMP_TITLE_STYLE, display: 'flex', alignItems: 'center' } }, t('settings.routeTitle'), help('modelMode')),
          routeNow,
        ),
        h(
          'select',
          {
            'data-nmp-setting': 'modelMode',
            'aria-label': t('settings.routeTitle'),
            style: FIELD_STYLE,
            value: pendingRoute.modelMode,
            disabled: busy,
            onChange: (event) => changeModelMode(event.target.value),
          },
          h('option', { value: 'fixed' }, t('settings.routeModeFixed')),
          h('option', { value: 'session' }, t('settings.routeModeSession')),
        ),
        fixedMode
          ? h(
              'div',
              { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '12px' } },
              routeField('provider', t('settings.routeProvider'), providerText === null ? config.provider : providerText, setProviderText, RECOMMENDED_ROUTE.provider),
              routeField('model', t('settings.routeModel'), modelText === null ? config.model : modelText, setModelText, RECOMMENDED_ROUTE.model),
              routeField('reasoningEffort', t('settings.routeEffort'), effortText === null ? config.reasoningEffort : effortText, setEffortText, t('settings.routeEffortAuto')),
            )
          : null,
        // The action row only appears when there is something to do.
        routeDirty || routeIncomplete || !isRecommended
          ? h(
              'div',
              { style: { display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '8px', flexWrap: 'wrap' } },
              routeIncomplete
                ? h('span', { style: { ...NMP_HINT_STYLE, color: NMP_DANGER, marginRight: 'auto' } }, t('settings.routeIncomplete'))
                : routeDirty
                  ? h('span', { 'data-nmp-setting': 'routeDirty', style: { ...NMP_HINT_STYLE, marginRight: 'auto' } }, t('settings.unsaved'))
                  : null,
              // Not while the form has edits of its own: one pending change at a time.
              !isRecommended && !routeDirty
                ? h(
                    'button',
                    { type: 'button', 'data-nmp-setting': 'recommendedRoute', disabled: busy, onClick: useRecommended, style: buttonStyle(busy) },
                    t('settings.routeRecommended'),
                  )
                : null,
              routeDirty
                ? h('button', { type: 'button', disabled: busy, onClick: resetRouteForm, style: buttonStyle(busy) }, t('settings.discard'))
                : null,
              routeDirty
                ? h(
                    'button',
                    {
                      type: 'button',
                      'data-nmp-setting': 'saveRoute',
                      disabled: busy || routeIncomplete,
                      onClick: saveRoute,
                      style: { ...buttonStyle(busy || routeIncomplete), borderColor: NMP_ACCENT, color: NMP_ACCENT },
                    },
                    t('settings.save'),
                  )
                : null,
            )
          : null,
      ),
    )

    // ── Card 5: results (last 7 days) + today's allowance ───────────────────
    const summary = results !== null && results.available === true && results.summary !== null && typeof results.summary === 'object'
      ? results.summary
      : null
    const resultRows = []
    let resultNote = ''
    if (summary !== null && Number(summary.requests) > 0) {
      const pct = (value) => (typeof value === 'number' ? `${value}%` : t('settings.noData'))
      const days = Array.isArray(summary.tokenDays) ? summary.tokenDays : []
      const totalInput = days.reduce((sum, day) => sum + (Number(day.input) || 0), 0)
      const totalOutput = days.reduce((sum, day) => sum + (Number(day.output) || 0), 0)
      resultRows.push([t('settings.resultRequests'), `${nmpNumber(summary.requests)}${t('settings.unitTimes')}`])
      resultRows.push([t('settings.resultShown'), `${nmpNumber(summary.shown ?? 0)}${t('settings.unitItems')}`])
      resultRows.push([t('settings.resultAccepted'), `${nmpNumber(summary.accepted ?? 0)}${t('settings.unitItems')}${t('settings.resultAcceptedOf')}${pct(summary.acceptRate)}`])
      const reasons = Array.isArray(summary.abstainReasons)
        ? summary.abstainReasons.slice(0, 3).map((entry) => `${nmpCodeLabel(t, 'reason', entry.reason)} ×${entry.count}`).join(t('settings.listSeparator'))
        : ''
      resultRows.push([t('settings.resultAbstains'), `${nmpNumber(summary.abstains ?? 0)}${t('settings.unitTimes')}${reasons !== '' ? `${t('settings.resultReasons')}${reasons}` : ''}`])
      resultRows.push([
        t('settings.resultLatency'),
        `${t('settings.resultLatencyTypical')}${nmpSeconds(summary.latencyP50, t('settings.unitSeconds'))}${t('settings.listSeparator')}${t('settings.resultLatencySlow')}${nmpSeconds(summary.latencyP95, t('settings.unitSeconds'))}`,
      ])
      resultRows.push([t('settings.resultTokens'), `${t('settings.tokensIn')}${nmpNumber(totalInput)}${t('settings.listSeparator')}${t('settings.tokensOut')}${nmpNumber(totalOutput)}`])
    } else if (summary !== null) {
      resultNote = t('settings.resultEmpty')
    } else if (results !== null) {
      resultNote = t('settings.resultUnavailable')
    } else {
      resultNote = t('settings.resultLoading')
    }
    const budget = configState.budget
    if (budget !== null && budget !== undefined) {
      // The daily limit counts tokens held back for calls whose real usage never
      // arrived, so the figure shown includes them and says how many they are.
      const reservedTokens = Math.max(0, Number(budget.reservedTokens) || 0)
      const usedTokens = (Number(budget.inputTokens) || 0) + (Number(budget.outputTokens) || 0) + (Number(budget.reasoningTokens) || 0) + reservedTokens
      resultRows.push([
        t('settings.budgetToday'),
        `${nmpNumber(budget.requests)} / ${nmpNumber(budget.dailyRequestLimit)}${t('settings.unitTimes')}${t('settings.listSeparator')}${nmpNumber(usedTokens)} / ${nmpNumber(budget.dailyTokenBudget)} token${reservedTokens > 0 ? t('settings.budgetReserved').split('{n}').join(nmpNumber(reservedTokens)) : ''}`,
      ])
    }
    rows.push(
      h(
        'div',
        { style: CARD_STYLE },
        h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' } },
          h('div', { style: { ...NMP_TITLE_STYLE, display: 'flex', alignItems: 'center' } }, t('settings.resultTitle'), help('results')),
          h('button', {
            type: 'button',
            'data-nmp-setting': 'refreshResults',
            disabled: resultsBusy,
            onClick: () => {
              if (resultsBusy) return
              loadResultsNow()
              void runtime.loadStatus()
            },
            style: buttonStyle(resultsBusy),
          }, t('settings.refresh')),
        ),
        resultNote !== '' ? h('div', { style: NMP_HINT_STYLE }, resultNote) : null,
        resultRows.length > 0
          ? h(
              'div',
              { 'data-nmp-setting': 'results', style: { display: 'grid', gridTemplateColumns: 'minmax(110px, max-content) 1fr', columnGap: '16px', rowGap: '6px', fontSize: '13px', lineHeight: '20px' } },
              resultRows.flatMap(([label, value], index) => [
                h('div', { key: `l${index}`, style: { color: 'var(--dsw-alias-label-tertiary)' } }, label),
                h('div', { key: `v${index}`, style: { color: 'var(--dsw-alias-label-primary)' } }, value),
              ]),
            )
          : null,
      ),
    )

    // ── Folded: advanced options ────────────────────────────────────────────
    const diagLines = []
    diagLines.push(`${t('settings.diagnosticState')}: ${assist.status}${assist.reason ? ` (${assist.reason})` : ''}`)
    if (assist.status === 'conflict') {
      diagLines.push(`${t('settings.conflictHint')}: ${assist.reason}`)
    }
    diagLines.push(`${t('settings.diagnosticRevision')}: ${configState.revision}`)
    diagLines.push(`${t('settings.diagnosticMode')}: ${configState.mode || 'n/a'} / ${configState.promptVersion || 'n/a'}`)
    if (counters !== null) {
      diagLines.push(
        `${t('settings.diagnosticCounters')}: ${t('settings.countRequests')}=${counters.requestsReceived} ${t('settings.countOffers')}=${counters.offers} ${t('settings.countProviderCalls')}=${counters.providerCalls} ${t('settings.countSendCalls')}=${counters.sendCalls}`,
      )
      diagLines.push(
        `${t('settings.diagnosticTokens')}: in=${counters.inputTokens} out=${counters.outputTokens} reasoning=${counters.reasoningTokens} cacheR=${counters.cacheReadTokens} unknown=${counters.unknownUsage}`,
      )
      diagLines.push(
        `${t('settings.diagnosticContext')}: built=${counters.contextBuilds} failed=${counters.contextFailures} outputRejects=${counters.outputRejects}`,
      )
    }
    if (budget !== null && budget !== undefined) {
      diagLines.push(
        `${t('settings.diagnosticBudget')}: ${budget.day} requests=${budget.requests}/${budget.dailyRequestLimit} tokens=${budget.inputTokens + budget.outputTokens + budget.reasoningTokens}/${budget.dailyTokenBudget} reserved=${budget.reservedTokens}`,
      )
    }
    const capabilities = configState.capabilities ?? {}
    diagLines.push(
      `${t('settings.diagnosticCapabilities')}: route=${String(capabilities.connectionFetch)} session=${String(capabilities.sessionStore)} configEditor=${String(capabilities.configEditor)}`,
    )
    if (configState.provider !== '') diagLines.push(`${t('settings.diagnosticProvider')}: ${configState.provider}`)
    const configErrors = Array.isArray(configState.configErrors) ? configState.configErrors : []
    if (configErrors.length > 0) {
      diagLines.push(`${t('settings.diagnosticConfigErrors')}: ${configErrors.join('; ')}`)
    }

    const redact = config.redactSecrets !== false
    const turnFacts = config.includeTurnFacts !== false
    const advancedChanged = NMP_ADVANCED_FIELDS.some((field) => config[field] !== DEFAULT_CONFIG[field])
    const restoreAdvanced = () => {
      if (busy) return
      const patch = {}
      for (const field of NMP_ADVANCED_FIELDS) patch[field] = DEFAULT_CONFIG[field]
      setDrafts({})
      setFieldErrors({})
      setConfirmRedact(false)
      void save(patch, 'settings.advancedRestored')
    }

    rows.push(
      h(
        'details',
        // Opens itself once when something inside needs attention (see needsAttention).
        {
          'data-nmp-setting': 'advanced',
          open: advancedOpen,
          onToggle: (event) => {
            const open = event.currentTarget.open === true
            nmpWriteAdvancedOpen(open)
            setAdvancedOpen(open)
          },
          style: { ...CARD_STYLE, display: 'block' },
        },
        h('summary', { style: { ...NMP_TITLE_STYLE, cursor: 'pointer' } }, t('settings.advanced')),
        h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: '12px', marginTop: '12px' } },

          group('trigger', true),
          numberRow('triggerDelayMs', { first: true, dim: !autoPredict }),
          numberRow('autoWindowMinutes', { dim: !autoPredict }),
          numberRow('manualLimit'),
          numberRow('candidateCount', { dim: !multi }),
          numberRow('habitMinCount', { dim: !habits }),

          group('content'),
          numberRow('contextMessages', { first: true }),
          numberRow('targetInputTokens'),
          row(
            'includeTurnFacts',
            t('settings.includeTurnFacts'),
            nmpSwitch(h, { name: 'includeTurnFacts', checked: turnFacts, disabled: busy, label: t('settings.includeTurnFacts'), onClick: () => toggle('includeTurnFacts', !turnFacts, 'settings.saved') }),
          ),
          row(
            'redactSecrets',
            t('settings.redactSecrets'),
            nmpSwitch(h, {
              name: 'redactSecrets',
              checked: redact,
              disabled: busy,
              label: t('settings.redactSecrets'),
              // Turning masking off needs a second, explicit confirmation.
              onClick: () => {
                if (busy) return
                if (redact) setConfirmRedact(true)
                else toggle('redactSecrets', true, 'settings.saved')
              },
            }),
            { note: redact ? '' : t('warn.redactSecrets'), noteColor: NMP_DANGER },
          ),
          confirmRedact && redact
            ? h(
                'div',
                {
                  'data-nmp-setting': 'redactConfirm',
                  role: 'alertdialog',
                  style: { display: 'flex', flexDirection: 'column', gap: '10px', padding: '10px 12px', borderRadius: '8px', border: `1px solid ${NMP_DANGER}`, fontSize: '12px', lineHeight: '18px', color: 'var(--dsw-alias-label-secondary)' },
                },
                h('div', { style: { color: NMP_DANGER, fontWeight: 600 } }, t('settings.redactConfirmTitle')),
                h('div', null, t('settings.redactConfirmBody')),
                h(
                  'div',
                  { style: { display: 'flex', justifyContent: 'flex-end', gap: '8px' } },
                  h('button', { type: 'button', 'data-nmp-setting': 'redactCancel', disabled: busy, onClick: () => setConfirmRedact(false), style: buttonStyle(busy) }, t('settings.cancel')),
                  h(
                    'button',
                    {
                      type: 'button',
                      'data-nmp-setting': 'redactConfirmButton',
                      disabled: busy,
                      onClick: () => {
                        setConfirmRedact(false)
                        toggle('redactSecrets', false, 'settings.redactOff')
                      },
                      style: { ...buttonStyle(busy), borderColor: NMP_DANGER, color: NMP_DANGER },
                    },
                    t('settings.redactConfirmButton'),
                  ),
                ),
              )
            : null,

          group('limits'),
          numberRow('maxSuggestionGraphemes', { first: true }),
          numberRow('maxOutputTokens'),
          numberRow('timeoutMs'),
          numberRow('dailyRequestLimit'),
          numberRow('dailyTokenBudget'),

          group('other'),
          row(
            'announce',
            t('settings.announce'),
            nmpSwitch(h, { name: 'announceSuggestions', checked: config.announceSuggestions !== false, disabled: busy, label: t('settings.announce'), onClick: () => toggle('announceSuggestions', config.announceSuggestions === false, 'settings.saved') }),
            { first: true },
          ),
          row(
            'fakeSuggestion',
            t('settings.fakeSuggestion'),
            h(
              'div',
              { style: { display: 'flex', gap: '8px', flex: 'none', width: '260px' } },
              h('input', {
                type: 'text',
                'data-nmp-setting': 'fakeSuggestion',
                'aria-label': t('settings.fakeSuggestion'),
                style: FIELD_STYLE,
                value: fakeText === null ? config.fakeSuggestion : fakeText,
                maxLength: 160,
                disabled: busy,
                onChange: (event) => setFakeText(event.target.value),
                onKeyDown: onEnter(saveFake),
              }),
              fakeText !== null && fakeText !== config.fakeSuggestion
                ? h(
                    'button',
                    { type: 'button', 'data-nmp-setting': 'saveFakeSuggestion', disabled: busy, onClick: saveFake, style: { ...buttonStyle(busy), height: '34px', flex: 'none' } },
                    t('settings.save'),
                  )
                : null,
            ),
          ),
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', paddingTop: '12px', borderTop: NMP_DIVIDER } },
            h('span', { style: NMP_HINT_STYLE }, advancedChanged ? t('settings.advancedChanged') : t('settings.advancedDefault')),
            h(
              'button',
              { type: 'button', 'data-nmp-setting': 'restoreAdvanced', disabled: busy || !advancedChanged, onClick: restoreAdvanced, style: buttonStyle(busy || !advancedChanged) },
              t('settings.restoreAdvanced'),
            ),
          ),

          group('diagnostics'),
          h(
            'div',
            { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
            h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' } },
              h('div', { style: NMP_HINT_STYLE }, t('settings.diagnosticsHint')),
              h('button', {
                type: 'button',
                disabled: busy,
                onClick: () => {
                  void runtime.loadStatus()
                },
                style: buttonStyle(busy),
              }, t('settings.refresh')),
            ),
            h(
              'div',
              { style: { display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '12px', lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)', fontFamily: 'var(--ds-font-family-code, monospace)', overflowWrap: 'anywhere' } },
              diagLines.map((line, index) => h('div', { key: index }, line)),
            ),
          ),
        ),
      ),
    )

    return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px', maxWidth: '720px' } }, rows)
  }
}

/**
 * The Settings page as a global panel (opened from the left sidebar). The main
 * area gives a flex column with no padding or scrolling of its own, so this
 * wrapper supplies both and centres the page.
 */
export function createPanelComponent(react, Section) {
  const { createElement: h } = react
  return function NextMessagePredictorPanel() {
    return h(
      'div',
      {
        'data-nmp-panel': PANEL_ID,
        style: {
          boxSizing: 'border-box',
          flex: 1,
          minHeight: 0,
          height: '100%',
          overflowY: 'auto',
          // Clear the window controls where the frame does not already do so (macOS).
          padding: 'max(28px, calc(var(--dsh-frame-top-clearance, 0px) - var(--dsh-frame-chrome-top, 0px) + 12px)) clamp(20px, 4vw, 48px) 40px',
          color: 'var(--dsw-alias-label-primary)',
        },
      },
      h('div', { style: { maxWidth: '720px', margin: '0 auto' } }, h(Section, null)),
    )
  }
}

/** A labelled on/off switch button (`data-nmp-setting` = name). */
function nmpSwitch(h, options) {
  const { name, checked, disabled, label, onClick } = options
  return h(
    'button',
    {
      type: 'button',
      role: 'switch',
      'aria-checked': checked,
      'aria-label': label,
      'data-nmp-setting': name,
      disabled,
      onClick,
      style: {
        position: 'relative',
        flex: 'none',
        width: '40px',
        height: '22px',
        padding: 0,
        border: 'none',
        borderRadius: '11px',
        cursor: disabled ? 'default' : 'pointer',
        background: checked ? NMP_ACCENT : 'var(--dsw-alias-border-l2)',
        transition: 'background 120ms ease',
      },
    },
    h('span', {
      style: {
        position: 'absolute',
        top: '3px',
        left: checked ? '21px' : '3px',
        width: '16px',
        height: '16px',
        borderRadius: '50%',
        background: '#ffffff',
        boxShadow: '0 1px 2px rgba(0, 0, 0, 0.2)',
        transition: 'left 120ms ease',
      },
    }),
  )
}

/** The Host's error text for a failed save, or a readable stand-in. */
function nmpSaveError(t, error) {
  return typeof error === 'string' && error !== '' ? nmpCodeLabel(t, 'reason', error) : t('settings.saveFailedUnknown')
}

/** 14 px "sidebar" glyph: a plus while off, the entry rows drawn in once added. */
function nmpPinIcon(h, on) {
  return h(
    'svg',
    { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true', focusable: 'false' },
    h('rect', { x: 2, y: 2.5, width: 12, height: 11, rx: 2.2 }),
    h('path', { d: 'M6 2.5v11' }),
    on ? h('path', { d: 'M3.6 6h.9M3.6 8.2h.9' }) : h('path', { d: 'M10 6.3v3.4M8.3 8h3.4' }),
  )
}

function buttonStyle(busy) {
  return {
    height: '30px',
    padding: '0 12px',
    borderRadius: 'var(--dsw-radius-sm, 6px)',
    border: '1px solid var(--dsw-alias-border-l2)',
    background: 'var(--dsw-alias-bg-layer-1)',
    color: 'var(--dsw-alias-label-primary)',
    fontFamily: 'inherit',
    fontSize: '13px',
    cursor: busy ? 'default' : 'pointer',
    opacity: busy ? 0.6 : 1,
  }
}

/**
 * Settings nav icon, drawn in the style of DSH's own 16 px outline icons
 * (stroke = currentColor, round caps): a text line with a spark, i.e. "the
 * next line, predicted". Registered in the `settings.section.icon` slot.
 */
export function createSettingsIconComponent(react) {
  const { createElement: h } = react
  return function NextMessagePredictorIcon(props) {
    const size = typeof props?.size === 'number' ? props.size : 16
    return h(
      'svg',
      { width: size, height: size, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true', focusable: 'false' },
      // Message bubble outline.
      h('path', { d: 'M8.6 2.4H4.2A2.2 2.2 0 0 0 2 4.6v5a2.2 2.2 0 0 0 2.2 2.2h.9v2l2.6-2h4.1A2.2 2.2 0 0 0 14 9.6V8.2' }),
      // Typed text and the predicted remainder.
      h('path', { d: 'M4.9 6.4h2.6M4.9 8.8h4.6' }),
      // Spark: the suggestion.
      h('path', { d: 'M12 1.4l.75 1.85L14.6 4l-1.85.75L12 6.6l-.75-1.85L9.4 4l1.85-.75z', fill: 'currentColor', stroke: 'none' }),
    )
  }
}
