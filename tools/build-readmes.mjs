// Regenerates the translated READMEs (README.<lang>.md) from
// tools/readme/template.md and tools/readme/strings/<lang>.txt, and refreshes
// the two generated regions of the hand-written Chinese README.md (the
// language bar and the badge block, delimited by HTML comment markers).
//
//   node tools/build-readmes.mjs            write the files
//   node tools/build-readmes.mjs --check    exit 1 if any file on disk differs
//
// Inside a string, {ui:<key>} is that language's interface text from
// src/client/locales, {langs} the list of language names, and {ph_dsh} /
// {ph_plugin} the two placeholder strings of the same language file.
// No dependencies.

import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const readmeDir = join(root, 'tools', 'readme')

const ORDER = ['zh', 'en', 'ja', 'ko', 'es', 'fr', 'de', 'ru', 'pt']
const FILES = Object.fromEntries(ORDER.map((id) => [id, id === 'zh' ? 'README.md' : `README.${id}.md`]))

const read = async (path) => (await readFile(path, 'utf8')).replace(/\r\n/g, '\n')

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

/** Everything the READMEs take from the project instead of a hand-typed copy. */
async function loadFacts() {
  const pkg = JSON.parse(await read(join(root, 'package.json')))
  const repoMatch = /github\.com\/([^/]+\/[^/.]+)(?:\.git)?$/.exec(pkg.repository?.url ?? '')
  assert(repoMatch, 'package.json: repository.url is not a GitHub URL')
  const dshMatch = /(?:>=|^)\s*(\d[^\s<>=]*)/.exec(pkg.engines?.dsh ?? '')
  assert(dshMatch, 'package.json: engines.dsh has no minimum version')
  const i18n = await import(pathToFileURL(join(root, 'src', 'client', 'i18n.js')).href)
  assert(JSON.stringify(Object.keys(i18n.NMP_DICTIONARIES)) === JSON.stringify(ORDER), 'the language order here differs from NMP_DICTIONARIES')
  return {
    version: pkg.version,
    dsh: dshMatch[1],
    dependencies: Object.keys(pkg.dependencies ?? {}).length,
    repo: repoMatch[1],
    dict: i18n.NMP_DICTIONARIES,
    names: i18n.NMP_LANGUAGE_NAMES,
  }
}

function langBar(facts, current) {
  return ORDER.map((id) => (id === current ? `**${facts.names[id]}**` : `[${facts.names[id]}](${FILES[id]})`)).join(' · ')
}

// shields.io static badge: '-' and '_' are escaped by doubling them.
function shield(label, message, color) {
  const enc = (text) =>
    encodeURIComponent(text.replace(/-/g, '--').replace(/_/g, '__')).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())
  return `  <img src="https://img.shields.io/badge/${enc(label)}-${enc(message)}-${color}" alt="${label} ${message}">`
}

function ciBadge(facts) {
  const page = `https://github.com/${facts.repo}/actions/workflows/ci.yml`
  return `  <a href="${page}"><img src="${page}/badge.svg" alt="CI"></a>`
}

function badgeLines(facts, labels) {
  return [
    shield(labels.version, facts.version, '4d6bfe'),
    shield('DeepSeek Harness', facts.dsh, '1f2937'),
    shield(labels.languages, labels.languageCount, '8250df'),
    shield(labels.dependencies, String(facts.dependencies), '2ea44f'),
    ciBadge(facts),
    shield(labels.license, 'MIT', 'blue'),
  ].join('\n')
}

async function loadStrings(lang) {
  const out = {}
  for (const line of (await read(join(readmeDir, 'strings', `${lang}.txt`))).split('\n')) {
    if (line.trim() === '') continue
    const at = line.indexOf(': ')
    const key = at < 0 ? '' : line.slice(0, at)
    assert(/^[a-z0-9_]+$/.test(key), `${lang}.txt: not a "key: text" line: ${line.slice(0, 40)}`)
    assert(!(key in out), `${lang}.txt: duplicate key ${key}`)
    out[key] = line.slice(at + 2)
  }
  return out
}

function fillInline(facts, lang, strings, text) {
  text = text.replace(/\{ui:([A-Za-z0-9_.-]+)\}/g, (_, key) => {
    assert(key in facts.dict[lang], `${lang}: no interface text ${key}`)
    return facts.dict[lang][key]
  })
  text = text.replaceAll('{ph_dsh}', strings.ph_dsh).replaceAll('{ph_plugin}', strings.ph_plugin)
  text = text.replaceAll('{langs}', ORDER.map((id) => facts.names[id]).join(lang === 'ja' ? '、' : ', '))
  const left = /\{[a-z_:.]+\}/.exec(text)
  assert(!left, `${lang}: unresolved ${left?.[0]} in: ${text.slice(0, 80)}`)
  return text
}

const LABEL_KEYS = ['b_version', 'b_deps', 'b_langs', 'b_license']

async function translated(facts) {
  const template = await read(join(readmeDir, 'template.md'))
  const templateKeys = new Set([...template.matchAll(/\{\{([a-z0-9_]+)\}\}/g)].map((m) => m[1]))
  const out = new Map()
  let reference = null
  for (const lang of ORDER.slice(1)) {
    const strings = await loadStrings(lang)
    const keys = Object.keys(strings)
    reference ??= keys
    assert(JSON.stringify(keys) === JSON.stringify(reference), `${lang}.txt: keys differ from ${ORDER[1]}.txt`)
    const values = Object.fromEntries(keys.map((key) => [key, fillInline(facts, lang, strings, strings[key])]))
    values.langbar = langBar(facts, lang)
    values.badges = badgeLines(facts, {
      version: values.b_version,
      languages: values.b_langs,
      languageCount: String(ORDER.length),
      dependencies: values.b_deps,
      license: values.b_license,
    })
    const missing = [...templateKeys].filter((key) => !(key in values))
    assert(missing.length === 0, `${lang}: the template needs ${missing.join(', ')}`)
    const unused = keys.filter((key) => !templateKeys.has(key) && !LABEL_KEYS.includes(key))
    assert(unused.length === 0, `${lang}.txt: unused keys ${unused.join(', ')}`)
    let text = template.replace(/\{\{([a-z0-9_]+)\}\}/g, (_, key) => values[key])
    // The mode table names come straight from the interface texts.
    text = fillInline(facts, lang, strings, text)
    if (lang === 'ja') {
      const recommended = facts.dict.ja['preset.recommended']
      text = text.replaceAll(`** (${recommended})`, `**（${recommended}）`)
    }
    out.set(FILES[lang], text)
  }
  return out
}

function replaceRegion(text, name, body) {
  const pattern = new RegExp(`(<!-- readme:${name}:start -->\\n\\n)[\\s\\S]*?(\\n\\n<!-- readme:${name}:end -->)`)
  assert(pattern.test(text), `README.md: the <!-- readme:${name}:start/end --> markers are missing`)
  return text.replace(pattern, (_, head, tail) => head + body + tail)
}

async function chinese(facts) {
  let text = await read(join(root, FILES.zh))
  text = replaceRegion(text, 'langbar', `<div align="center">\n\n${langBar(facts, 'zh')}\n\n</div>`)
  const badges = badgeLines(facts, {
    version: '版本',
    languages: '界面语言',
    languageCount: `${ORDER.length} 种`,
    dependencies: '第三方依赖',
    license: '许可',
  })
  return replaceRegion(text, 'badges', `<p align="center">\n${badges}\n</p>`)
}

/** Map of README file name -> the text it should contain. */
export async function generateReadmes() {
  const facts = await loadFacts()
  const out = await translated(facts)
  out.set(FILES.zh, await chinese(facts))
  return out
}

/** Names of the READMEs whose content on disk differs from the generated text. */
export async function staleReadmes() {
  const stale = []
  for (const [file, text] of await generateReadmes()) {
    const current = await read(join(root, file)).catch(() => null)
    if (current !== text) stale.push(file)
  }
  return stale
}

async function main() {
  const check = process.argv.includes('--check')
  if (check) {
    const stale = await staleReadmes()
    if (stale.length === 0) {
      console.log('READMEs are up to date')
      return
    }
    console.error(`These READMEs are out of date: ${stale.join(', ')}\nRun \`npm run readme\` and commit the result.`)
    process.exitCode = 1
    return
  }
  for (const [file, text] of await generateReadmes()) {
    await writeFile(join(root, file), text, 'utf8')
    console.log('wrote', file)
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
}
