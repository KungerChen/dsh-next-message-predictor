// Interface languages: the nine dictionaries stay in step, the language is
// resolved the way Settings promises, and everything the build and DSH need
// for each language is there.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { DEFAULT_CONFIG, LANGUAGE_AUTO, LANGUAGE_IDS, checkConfigField, configRevision, normalizeConfig, sanitizeConfigPatch } from '../src/shared/config.js'
import { PRESETS, PRESET_IDS, presetPatch } from '../src/shared/presets.js'
import {
  NMP_DICTIONARIES,
  NMP_FALLBACK_LANGUAGE,
  NMP_HOST_LANGUAGES,
  NMP_LANGUAGE_NAMES,
  NMP_LANGUAGE_PROBE_KEY,
  nmpBracket,
  nmpCreateTranslator,
  nmpHostDictionaries,
  nmpIsLanguage,
  nmpMatchLanguage,
  nmpResolveLanguage,
  nmpTranslate,
} from '../src/client/i18n.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const placeholders = (text) => (text.match(/\{[A-Za-z]+\}/g) ?? []).sort().join(' ')

test('languages: nine of them, each with a dictionary and its own name', () => {
  assert.deepEqual([...LANGUAGE_IDS], ['zh', 'en', 'ja', 'ko', 'es', 'fr', 'de', 'ru', 'pt'])
  assert.deepEqual(Object.keys(NMP_DICTIONARIES), [...LANGUAGE_IDS])
  assert.deepEqual(Object.keys(NMP_LANGUAGE_NAMES), [...LANGUAGE_IDS])
  for (const id of LANGUAGE_IDS) assert.ok(NMP_LANGUAGE_NAMES[id].length > 0, id)
  assert.ok(LANGUAGE_IDS.includes(NMP_FALLBACK_LANGUAGE))
  // Everything DSH offers itself is covered.
  for (const id of NMP_HOST_LANGUAGES) assert.ok(LANGUAGE_IDS.includes(id), id)
})

test('dictionaries: the same keys in the same order, with the same placeholders', () => {
  const reference = NMP_DICTIONARIES.en
  const keys = Object.keys(reference)
  assert.ok(keys.length >= 299)
  for (const id of LANGUAGE_IDS) {
    const dictionary = NMP_DICTIONARIES[id]
    assert.deepEqual(Object.keys(dictionary), keys, `${id}: keys differ from en (or are in another order)`)
    for (const key of keys) {
      assert.equal(typeof dictionary[key], 'string', `${id}: ${key}`)
      assert.equal(placeholders(dictionary[key]), placeholders(reference[key]), `${id}: placeholders of ${key}`)
      // No text may be a leftover key, a line break or padded by accident at the start.
      assert.equal(/[\r\n\t]/.test(dictionary[key]), false, `${id}: ${key} contains a line break or tab`)
    }
  }
})

test('dictionaries: only unit and separator texts may be empty, nothing is left in English by mistake', () => {
  const mayBeEmpty = /^(unit\.|settings\.unit)/
  for (const id of LANGUAGE_IDS) {
    for (const [key, text] of Object.entries(NMP_DICTIONARIES[id])) {
      if (text.trim() === '') assert.ok(mayBeEmpty.test(key) || text !== '', `${id}: ${key} is empty`)
    }
  }
  // Sentences (help texts and risk notes) must differ from English in every other language.
  const sentences = Object.keys(NMP_DICTIONARIES.en).filter((key) => /^(help|warn)\./.test(key))
  assert.ok(sentences.length > 30)
  for (const id of LANGUAGE_IDS.filter((value) => value !== 'en')) {
    const same = sentences.filter((key) => NMP_DICTIONARIES[id][key] === NMP_DICTIONARIES.en[key])
    assert.deepEqual(same, [], `${id}: untranslated sentences`)
  }
})

test('dictionaries: each one is written in its own script', () => {
  const script = {
    zh: /[\u4e00-\u9fff]/u,
    ja: /[\u3040-\u30ff\u4e00-\u9fff]/u,
    ko: /[\uac00-\ud7af]/u,
    ru: /[\u0400-\u04ff]/u,
  }
  for (const [id, pattern] of Object.entries(script)) {
    const texts = Object.entries(NMP_DICTIONARIES[id]).filter(([key]) => /^(help|state|reason)\./.test(key)).map(([, text]) => text)
    const off = texts.filter((text) => !pattern.test(text))
    assert.deepEqual(off, [], `${id}: texts without ${id} characters`)
  }
  // Kana must not leak into Chinese, Hangul not into Japanese, and so on.
  assert.equal(Object.values(NMP_DICTIONARIES.zh).some((text) => /[\u3040-\u30ff\uac00-\ud7af\u0400-\u04ff]/u.test(text)), false)
  assert.equal(Object.values(NMP_DICTIONARIES.ja).some((text) => /[\uac00-\ud7af\u0400-\u04ff]/u.test(text)), false)
  assert.equal(Object.values(NMP_DICTIONARIES.ko).some((text) => /[\u3040-\u30ff\u0400-\u04ff]/u.test(text)), false)
  for (const id of ['en', 'es', 'fr', 'de', 'pt']) {
    assert.equal(Object.values(NMP_DICTIONARIES[id]).some((text) => /[\u0400-\u04ff\u3040-\u30ff\u4e00-\u9fff\uac00-\ud7af]/u.test(text)), false, id)
  }
})

test('dictionaries: every mode and every numeric option has wording in every language', () => {
  for (const id of LANGUAGE_IDS) {
    const dictionary = NMP_DICTIONARIES[id]
    for (const preset of PRESET_IDS) {
      assert.ok(dictionary[`preset.${preset}.name`].length > 0, `${id}: preset.${preset}.name`)
      assert.ok(dictionary[`preset.${preset}.desc`].length > 0, `${id}: preset.${preset}.desc`)
    }
    for (const key of ['settings.language', 'settings.languageAuto', 'settings.languageSaved', 'help.language', 'settings.nav', 'settings.title', 'ghost.predict', 'ghost.adopt']) {
      assert.ok(dictionary[key].length > 0, `${id}: ${key}`)
    }
  }
})

test('language option: "auto" by default, validated, kept out of the modes', () => {
  assert.equal(DEFAULT_CONFIG.language, LANGUAGE_AUTO)
  assert.equal(checkConfigField('language', 'auto').ok, true)
  for (const id of LANGUAGE_IDS) assert.equal(checkConfigField('language', id).ok, true, id)
  for (const bad of ['', 'xx', 'EN', 'zh-CN', 'english', 7, null, true]) assert.equal(checkConfigField('language', bad).ok, false, String(bad))
  assert.equal(sanitizeConfigPatch({ language: 'ja' }).ok, true)
  assert.equal(sanitizeConfigPatch({ language: 'klingon' }).ok, false)
  assert.equal(normalizeConfig({ language: 'de' }).config.language, 'de')
  const broken = normalizeConfig({ language: 'klingon' })
  assert.equal(broken.config.language, LANGUAGE_AUTO)
  assert.equal(broken.errors.length, 1)
  assert.notEqual(configRevision({ ...DEFAULT_CONFIG }), configRevision({ ...DEFAULT_CONFIG, language: 'fr' }))
  for (const id of PRESET_IDS) {
    assert.equal('language' in PRESETS[id], false)
    assert.equal('language' in presetPatch(id, { ...DEFAULT_CONFIG, language: 'ko' }), false)
  }
})

test('language resolution: an explicit choice wins, "auto" follows the first usable hint', () => {
  assert.equal(nmpResolveLanguage('ko', ['zh-CN']), 'ko')
  assert.equal(nmpResolveLanguage('auto', ['', 'pt-BR', 'en-US']), 'pt')
  assert.equal(nmpResolveLanguage('auto', [undefined, null, 'xx-YY', 'zh_CN']), 'zh')
  assert.equal(nmpResolveLanguage('auto', ['JA']), 'ja')
  assert.equal(nmpResolveLanguage('auto', ['it-IT', 'nl']), NMP_FALLBACK_LANGUAGE)
  assert.equal(nmpResolveLanguage('auto'), NMP_FALLBACK_LANGUAGE)
  // A value that is not a language behaves like "auto".
  assert.equal(nmpResolveLanguage('klingon', ['de-AT']), 'de')
  assert.equal(nmpResolveLanguage(undefined, ['ru']), 'ru')
  assert.equal(nmpMatchLanguage('es-419'), 'es')
  assert.equal(nmpMatchLanguage('constructor'), '')
  assert.equal(nmpMatchLanguage(42), '')
  assert.equal(nmpIsLanguage('toString'), false)
})

test('translate: the chosen language, then English, then the key', () => {
  assert.equal(nmpTranslate('zh', 'settings.save'), '保存')
  assert.equal(nmpTranslate('de', 'settings.save'), 'Speichern')
  assert.equal(nmpTranslate('klingon', 'settings.save'), NMP_DICTIONARIES.en['settings.save'])
  assert.equal(nmpTranslate('fr', 'no.such.key'), 'no.such.key')
  // Object.prototype members are not texts.
  assert.equal(nmpTranslate('en', 'constructor'), 'constructor')
  assert.equal(nmpTranslate('en', 'toString'), 'toString')

  let language = 'es'
  const t = nmpCreateTranslator(() => language)
  assert.equal(t('settings.cancel'), 'Cancelar')
  assert.equal(t.language(), 'es')
  language = 'ru'
  assert.equal(t('settings.cancel'), 'Отмена', 'the language is read when t is called')
  language = 'nope'
  assert.equal(t.language(), NMP_FALLBACK_LANGUAGE)
  const failing = nmpCreateTranslator(() => { throw new Error('no language source') })
  assert.equal(failing('settings.cancel'), NMP_DICTIONARIES.en['settings.cancel'])
})

test('DSH registration: its own languages only, each able to name itself', () => {
  const registered = nmpHostDictionaries()
  assert.deepEqual(Object.keys(registered).sort(), [...NMP_HOST_LANGUAGES].sort())
  assert.ok('zh' in registered && 'en' in registered, 'zh and en are the baseline DSH requires')
  for (const id of NMP_HOST_LANGUAGES) {
    assert.equal(registered[id][NMP_LANGUAGE_PROBE_KEY], id)
    assert.equal(registered[id]['settings.nav'], NMP_DICTIONARIES[id]['settings.nav'])
  }
  // The probe key is added to the copies, not to the dictionaries themselves.
  assert.equal(NMP_LANGUAGE_PROBE_KEY in NMP_DICTIONARIES.en, false)
})

test('brackets: full width in Chinese and Japanese, plain elsewhere', () => {
  assert.equal(nmpBracket('zh', '原因'), '（原因）')
  assert.equal(nmpBracket('ja', '理由'), '（理由）')
  assert.equal(nmpBracket('en', 'reason'), ' (reason)')
  assert.equal(nmpBracket('ko', '이유'), ' (이유)')
  assert.equal(nmpBracket('en', ''), '')
})

test('packaging: every language is in the bundle and has a DSH meta file', async () => {
  const build = await readFile(join(root, 'scripts', 'build-client.mjs'), 'utf8')
  const bundle = await readFile(join(root, 'lib', 'client.js'), 'utf8')
  const reference = Object.keys(JSON.parse(await readFile(join(root, 'locale', 'en.json'), 'utf8')).meta).sort()
  for (const id of LANGUAGE_IDS) {
    assert.ok(build.includes(`'src/client/locales/${id}.js'`), `${id} is missing from the build inputs`)
    assert.ok(bundle.includes(`const NMP_LOCALE_${id.toUpperCase()} = {`), `${id} is missing from lib/client.js: run \`npm run build\``)
    const meta = JSON.parse(await readFile(join(root, 'locale', `${id}.json`), 'utf8')).meta
    assert.deepEqual(Object.keys(meta).sort(), reference, `locale/${id}.json`)
    for (const value of Object.values(meta)) assert.ok(typeof value === 'string' && value.trim() !== '', `locale/${id}.json`)
  }
  // i18n.js must come after the dictionaries it refers to, and before its users.
  const order = (name) => build.indexOf(`'${name}'`)
  assert.ok(order('src/client/locales/pt.js') < order('src/client/i18n.js'))
  assert.ok(order('src/client/i18n.js') < order('src/client/settings.js'))
  assert.ok(order('src/client/i18n.js') < order('src/client/index.js'))
})

test('readme: one per language, each linking to all the others', async () => {
  const files = { zh: 'README.md', en: 'README.en.md', ja: 'README.ja.md', ko: 'README.ko.md', es: 'README.es.md', fr: 'README.fr.md', de: 'README.de.md', ru: 'README.ru.md', pt: 'README.pt.md' }
  assert.deepEqual(Object.keys(files), [...LANGUAGE_IDS])
  for (const [id, file] of Object.entries(files)) {
    const text = await readFile(join(root, file), 'utf8')
    const head = text.split('\n').slice(0, 40).join('\n')
    for (const [other, target] of Object.entries(files)) {
      if (other === id) assert.ok(head.includes(`**${NMP_LANGUAGE_NAMES[other]}**`), `${file}: the current language is not marked`)
      else assert.ok(head.includes(`[${NMP_LANGUAGE_NAMES[other]}](${target})`), `${file}: no link to ${target}`)
    }
  }
})
