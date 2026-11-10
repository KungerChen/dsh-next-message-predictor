// The repository is public: no file in it may name a location on someone's
// machine. Scripts find what they need through tools/lib/local-env.mjs
// (environment variables, the untracked tools/local.config.json, standard
// install locations); documentation uses placeholders such as <插件目录>.
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/** Tracked files, or (outside a git checkout) every file except ignored working folders. */
function repositoryFiles() {
  try {
    const out = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    const files = out.split('\0').filter((name) => name !== '')
    if (files.length > 0) return files
  } catch {
    /* not a git checkout: walk the tree instead */
  }
  const skipped = new Set(['.git', 'node_modules', 'logs', 'evidence', 'data-home', 'asar-copy'])
  const files = []
  const walk = (dir, prefix) => {
    for (const name of readdirSync(dir)) {
      if (skipped.has(name) || name === 'local.config.json') continue
      const full = join(dir, name)
      const relative = prefix === '' ? name : `${prefix}/${name}`
      if (statSync(full).isDirectory()) walk(full, relative)
      else files.push(relative)
    }
  }
  walk(root, '')
  return files
}

const TEXT_FILE = /\.(md|mjs|js|json|jsonl|ya?ml|ps1|svg|txt)$|^(NOTICE|LICENSE|\.gitignore|\.gitattributes)$/

/**
 * What counts as a machine location:
 * - a drive letter followed by at least one folder, with either kind of slash;
 * - a named user's home folder (under "Users" or "home"), unless the name is a
 *   placeholder or a variable.
 * The second test below shows the shapes; they are built from parts there so
 * this file does not trip its own scan.
 */
const PATTERNS = [
  /(?<![A-Za-z0-9])[A-Za-z]:[\\/]+[A-Za-z0-9 _.()-]+[\\/]/g,
  /[\\/](?:Users|home)[\\/]+(?![<$%{*])[A-Za-z0-9._-]+/g,
]

/** Deliberate, made-up samples. Keep this list short and explain each entry. */
const ALLOWED = [
  // test/p2-context.test.mjs: a path-shaped string that redaction must leave alone.
  'D:/projects/app/',
]

test('no tracked file names a location on a particular machine', () => {
  const findings = []
  for (const file of repositoryFiles()) {
    if (!TEXT_FILE.test(file) && !TEXT_FILE.test(file.split('/').pop())) continue
    let text
    try {
      text = readFileSync(join(root, file), 'utf8')
    } catch {
      continue // listed by git but deleted in the working tree
    }
    const lines = text.split('\n')
    lines.forEach((line, index) => {
      for (const pattern of PATTERNS) {
        for (const match of line.matchAll(pattern)) {
          if (ALLOWED.some((allowed) => line.slice(match.index).startsWith(allowed))) continue
          findings.push(`${file}:${index + 1}: ${match[0]}`)
        }
      }
    })
  }
  assert.deepEqual(findings, [], 'local paths found; use tools/lib/local-env.mjs in scripts and placeholders in documentation')
})

test('the scan recognises the shapes it is meant to catch', () => {
  const hit = (line) => PATTERNS.some((pattern) => new RegExp(pattern.source).test(line))
  const drive = 'Q:'
  assert.equal(hit(`${drive}\\Some Folder\\app.exe`), true)
  assert.equal(hit(`'${drive}/work/tool/index.js'`), true)
  assert.equal(hit(['C:', 'Users', 'someone', '.dsh'].join('\\')), true)
  assert.equal(hit(['', 'home', 'someone', '.dsh'].join('/')), true)
  // Placeholders, variables, URLs and ordinary prose are fine.
  assert.equal(hit('<DSH 安装目录>\\resources\\runtime\\cli\\bin\\dsh.cmd'), false)
  assert.equal(hit('$env:USERPROFILE\\.dsh\\sessions'), false)
  assert.equal(hit('http://127.0.0.1:3090/?token=<per-boot token>'), false)
  assert.equal(hit('https://github.com/owner/repo/blob/main/file.ts'), false)
  assert.equal(hit('scratch\\logs\\web-3090.url.txt'), false)
  assert.equal(hit('ratio a:b/c'), false)
})
