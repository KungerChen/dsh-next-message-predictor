// Interface languages for dsh-next-message-predictor.
//
// The plugin carries its own dictionaries (src/client/locales/<id>.js) and its
// own translate function, because the language can be chosen in this plugin's
// Settings independently of DSH, and because it ships a language DSH itself
// does not offer. `auto` follows the language DSH is set to.
//
// This file is concatenated into the browser bundle: plain declarations only.

import { LANGUAGE_AUTO, LANGUAGE_IDS } from '../shared/config.js'
import { NMP_LOCALE_DE } from './locales/de.js'
import { NMP_LOCALE_EN } from './locales/en.js'
import { NMP_LOCALE_ES } from './locales/es.js'
import { NMP_LOCALE_FR } from './locales/fr.js'
import { NMP_LOCALE_JA } from './locales/ja.js'
import { NMP_LOCALE_KO } from './locales/ko.js'
import { NMP_LOCALE_PT } from './locales/pt.js'
import { NMP_LOCALE_RU } from './locales/ru.js'
import { NMP_LOCALE_ZH } from './locales/zh.js'

/** Language id -> dictionary. The ids are LANGUAGE_IDS (src/shared/config.js). */
export const NMP_DICTIONARIES = Object.freeze({
  zh: NMP_LOCALE_ZH,
  en: NMP_LOCALE_EN,
  ja: NMP_LOCALE_JA,
  ko: NMP_LOCALE_KO,
  es: NMP_LOCALE_ES,
  fr: NMP_LOCALE_FR,
  de: NMP_LOCALE_DE,
  ru: NMP_LOCALE_RU,
  pt: NMP_LOCALE_PT,
})

/** Each language under its own name, as the language list shows it. */
export const NMP_LANGUAGE_NAMES = Object.freeze({
  zh: '简体中文',
  en: 'English',
  ja: '日本語',
  ko: '한국어',
  es: 'Español',
  fr: 'Français',
  de: 'Deutsch',
  ru: 'Русский',
  pt: 'Português',
})

/** Used when nothing else can be resolved, and for a key a dictionary lacks. */
export const NMP_FALLBACK_LANGUAGE = 'en'

/** The languages DSH itself offers; only these are registered with its locale service. */
export const NMP_HOST_LANGUAGES = Object.freeze(['en', 'zh', 'ja', 'es', 'fr', 'de', 'ru', 'pt'])

/**
 * Key added to the dictionaries registered with DSH: its translation is the
 * language id, so asking DSH for it tells which language DSH is showing.
 */
export const NMP_LANGUAGE_PROBE_KEY = 'meta.language'

/** Whether a value is one of the shipped language ids. */
export function nmpIsLanguage(value) {
  return typeof value === 'string' && LANGUAGE_IDS.includes(value)
}

/** A language tag (`pt-BR`, `zh_CN`, `EN`) -> a shipped language id, or ''. */
export function nmpMatchLanguage(tag) {
  if (typeof tag !== 'string') return ''
  const primary = tag.trim().toLowerCase().split(/[-_]/)[0]
  return nmpIsLanguage(primary) ? primary : ''
}

/**
 * The language to show.
 * @param {string} setting - the `language` option: `auto` or a language id.
 * @param {Array<string | null | undefined>} [hints] - language tags to follow
 *   in `auto` mode, most trusted first (DSH's language, `<html lang>`, the
 *   browser's language).
 */
export function nmpResolveLanguage(setting, hints) {
  if (setting !== LANGUAGE_AUTO && nmpIsLanguage(setting)) return setting
  for (const hint of Array.isArray(hints) ? hints : []) {
    const match = nmpMatchLanguage(hint)
    if (match !== '') return match
  }
  return NMP_FALLBACK_LANGUAGE
}

/** One text in one language; falls back to English, then to the key itself. */
export function nmpTranslate(language, key) {
  const dictionary = NMP_DICTIONARIES[nmpIsLanguage(language) ? language : NMP_FALLBACK_LANGUAGE]
  const text = dictionary[key]
  if (typeof text === 'string') return text
  const fallback = NMP_DICTIONARIES[NMP_FALLBACK_LANGUAGE][key]
  return typeof fallback === 'string' ? fallback : key
}

/**
 * The translate function the components use. `t(key)` reads the language at
 * call time, so a re-render after a language change shows the new language;
 * `t.language()` names it.
 * @param {() => string} getLanguage
 */
export function nmpCreateTranslator(getLanguage) {
  const current = () => {
    try {
      const language = getLanguage()
      if (nmpIsLanguage(language)) return language
    } catch {
      /* fall through to the fallback language */
    }
    return NMP_FALLBACK_LANGUAGE
  }
  const t = (key) => nmpTranslate(current(), key)
  t.language = current
  return t
}

/** The dictionaries handed to DSH's locale service, each with the probe key. */
export function nmpHostDictionaries() {
  const out = {}
  for (const id of NMP_HOST_LANGUAGES) out[id] = { ...NMP_DICTIONARIES[id], [NMP_LANGUAGE_PROBE_KEY]: id }
  return out
}

/** A detail appended to a sentence: full-width brackets in Chinese and Japanese. */
export function nmpBracket(language, text) {
  if (typeof text !== 'string' || text === '') return ''
  return language === 'zh' || language === 'ja' ? `（${text}）` : ` (${text})`
}

/** Last language option the Host reported, so a page load starts in it. */
const NMP_LANGUAGE_MEMO_KEY = 'dsh-next-message-predictor.language'
export function nmpReadLanguageMemo() {
  try {
    const value = globalThis.localStorage?.getItem(NMP_LANGUAGE_MEMO_KEY)
    return value === LANGUAGE_AUTO || nmpIsLanguage(value) ? value : LANGUAGE_AUTO
  } catch {
    return LANGUAGE_AUTO
  }
}
export function nmpWriteLanguageMemo(setting) {
  try {
    if (setting === LANGUAGE_AUTO || !nmpIsLanguage(setting)) globalThis.localStorage?.removeItem(NMP_LANGUAGE_MEMO_KEY)
    else globalThis.localStorage?.setItem(NMP_LANGUAGE_MEMO_KEY, setting)
  } catch {
    /* storage unavailable: the page starts in the language DSH is set to */
  }
}
