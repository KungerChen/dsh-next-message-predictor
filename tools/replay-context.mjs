#!/usr/bin/env node
/**
 * B02 上下文裁剪回放统计（只读、离线、无网络、不输出正文）。
 *
 * 读取本机 `~/.dsh/sessions/<project>/<session>/session.v4.jsonl.zstd`，对每个“完成回合”分别用
 * 旧实现（--old-root 指向的一份旧版本源码里的 context-builder）和新实现构建上下文，统计
 * “人工规模回合”（该回合用户消息 ≤1000 graphemes）裁剪后没有任何用户消息的比例。
 *
 * 用法：
 *   node tools/replay-context.mjs --old-root <旧版本插件目录> --days 4 [--max-sessions 300]
 *                                 [--out scratch/evidence/replay-context.json]
 *
 * <旧版本插件目录> 是本插件某个旧版本的检出（其中要有 src/host/context-builder.js），
 * 例如 `git worktree add ../predictor-old <提交>` 得到的目录。
 */
import fs from 'node:fs'
import { readdir, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { zstdDecompressSync } from 'node:zlib'

import { extractHumanAndAssistant, trimMessages } from '../src/host/context-builder.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..')
const args = process.argv.slice(2)
const argOf = (name, fallback) => {
  const i = args.indexOf(name)
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback
}
const days = Math.max(1, Number(argOf('--days', '4')) || 4)
const maxSessions = Math.max(1, Number(argOf('--max-sessions', '80')) || 80)
const out = argOf('--out', path.join(repoRoot, 'scratch', 'evidence', 'replay-context.json'))
const oldRootArg = argOf('--old-root', '')
if (oldRootArg === '') {
  console.error('--old-root <directory> is required: a checkout of an older version of this plugin to compare against.')
  process.exit(2)
}
const backupRoot = path.resolve(oldRootArg)
if (!fs.existsSync(path.join(backupRoot, 'src', 'host', 'context-builder.js'))) {
  console.error(`--old-root has no src/host/context-builder.js: ${backupRoot}`)
  process.exit(2)
}
const limits = { maxMessages: 12, maxCodePoints: 6000, targetInputTokens: 2000, systemReserveTokens: 600 }

function graphemes(text) {
  return Array.from(String(text ?? '')).length
}

async function listSessionFiles(root) {
  const files = []
  async function walk(dir, depth) {
    if (depth > 3) return
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) await walk(full, depth + 1)
      else if (entry.isFile() && entry.name === 'session.v4.jsonl.zstd') files.push(full)
    }
  }
  await walk(root, 0)
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000
  const withTime = []
  for (const file of files) {
    try {
      const info = await stat(file)
      if (info.mtimeMs >= cutoff) withTime.push({ file, mtimeMs: info.mtimeMs })
    } catch {
      /* skip */
    }
  }
  withTime.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return withTime.slice(0, maxSessions)
}

function decompressSessionFile(file) {
  const buf = fs.readFileSync(file)
  const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
  const offsets = []
  let index = buf.indexOf(magic, 0)
  while (index !== -1) {
    offsets.push(index)
    index = buf.indexOf(magic, index + 1)
  }
  if (offsets.length === 0) return ''
  const parts = []
  for (let i = 0; i < offsets.length; i += 1) {
    const start = offsets[i]
    const end = i + 1 < offsets.length ? offsets[i + 1] : buf.length
    try {
      parts.push(zstdDecompressSync(buf.subarray(start, end)).toString('utf8'))
    } catch {
      // 帧尾可能有对齐/长度字节：尝试去掉尾部字节后再解一次
      let recovered = false
      for (const trim of [8, 16, 32, 64]) {
        if (end - start <= trim) continue
        try {
          parts.push(zstdDecompressSync(buf.subarray(start, end - trim)).toString('utf8'))
          recovered = true
          break
        } catch { /* keep trying */ }
      }
      if (!recovered) throw new Error('zstd frame decode failed')
    }
  }
  return parts.join('')
}

function parseEvents(text) {
  const events = []
  for (const line of text.split('\n')) {
    if (line === '') continue
    try {
      const value = JSON.parse(line)
      if (value !== null && typeof value === 'object' && typeof value.type === 'string') events.push(value)
    } catch {
      /* skip malformed */
    }
  }
  return events
}

/** 统计一个回合的完成时刻与“人工规模”判断。 */
function completedTurns(events) {
  const turns = []
  for (const event of events) {
    if (event.type !== 'turn/end') continue
    const reason = event.data !== null && typeof event.data === 'object' && event.data.reason !== null ? event.data.reason : {}
    if (reason.kind !== 'completed') continue
    turns.push(event.seq)
  }
  return turns
}

function contextAt(events, endSeq) {
  const slice = []
  for (const event of events) {
    if (typeof event.seq === 'number' && event.seq > endSeq) break
    slice.push(event)
  }
  return slice
}

function hasUser(messages) {
  return Array.isArray(messages) && messages.some((message) => message !== null && message !== undefined && message.role === 'user')
}

const oldModulePath = pathToFileURL(path.join(backupRoot, 'src', 'host', 'context-builder.js')).href
const oldModule = await import(oldModulePath)
const oldExtract = oldModule.extractHumanAndAssistant
const oldTrim = oldModule.trimMessages

const sessionsRoot = path.join(homedir(), '.dsh', 'sessions')
const files = await listSessionFiles(sessionsRoot)
const report = {
  generatedAt: new Date().toISOString(),
  days,
  maxSessions,
  // Which old version, not where it sits on this machine.
  oldImplementation: `${path.basename(backupRoot)}/src/host/context-builder.js`,
  newImplementation: 'src/host/context-builder.js',
  limits,
  sessions: { scanned: files.length, withTurns: 0, errors: 0 },
  turns: { completed: 0, humanScale: 0, humanScaleWithAssistant: 0 },
  old: { noUser: 0 },
  new: { noUser: 0 },
  lengths: { user: [], assistant: [] },
  samples: [],
}
for (const { file } of files) {
  let events
  try {
    const text = decompressSessionFile(file)
    events = parseEvents(text)
  } catch {
    report.sessions.errors += 1
    continue
  }
  const turns = completedTurns(events)
  if (turns.length === 0) continue
  report.sessions.withTurns += 1
  for (const endSeq of turns.slice(-20)) {
    report.turns.completed += 1
    const slice = contextAt(events, endSeq)
    // 新实现按回合提取；人工规模以该回合最后一条用户消息长度判断。
    const newMessages = extractHumanAndAssistant(slice)
    let lastUser = null
    for (const message of newMessages) {
      if (message.role === 'user') lastUser = message.text
    }
    if (lastUser === null) continue
    if (graphemes(lastUser) > 1000) continue
    report.turns.humanScale += 1
    const newTrimmed = trimMessages(newMessages, limits)
    const oldMessages = oldExtract(slice)
    const oldTrimmed = oldTrim(oldMessages, limits)
    if (!hasUser(newTrimmed.messages)) report.new.noUser += 1
    if (!hasUser(oldTrimmed.messages)) report.old.noUser += 1
    const assistant = newMessages.length > 0 && newMessages[newMessages.length - 1].role === 'assistant'
      ? newMessages[newMessages.length - 1].text
      : ''
    if (assistant !== '') report.turns.humanScaleWithAssistant += 1
    report.lengths.user.push(graphemes(lastUser))
    report.lengths.assistant.push(graphemes(assistant))
    if (report.samples.length < 5) {
      report.samples.push({
        userGraphemes: graphemes(lastUser),
        assistantGraphemes: graphemes(assistant),
        oldUserMessages: oldTrimmed.messages.filter((message) => message.role === 'user').length,
        newUserMessages: newTrimmed.messages.filter((message) => message.role === 'user').length,
        oldEstimatedTokens: oldTrimmed.estimatedTokens,
        newEstimatedTokens: newTrimmed.estimatedTokens,
      })
    }
  }
}

const percentile = (values, p) => {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[index]
}
report.percentiles = {
  userP50: percentile(report.lengths.user, 50),
  userP90: percentile(report.lengths.user, 90),
  assistantP50: percentile(report.lengths.assistant, 50),
  assistantP90: percentile(report.lengths.assistant, 90),
}
report.rates = {
  oldNoUserPct: report.turns.humanScale === 0 ? null : Math.round((report.old.noUser / report.turns.humanScale) * 1000) / 10,
  newNoUserPct: report.turns.humanScale === 0 ? null : Math.round((report.new.noUser / report.turns.humanScale) * 1000) / 10,
}
delete report.lengths
await writeFile(out, JSON.stringify(report, null, 2), 'utf8')
console.log(JSON.stringify({ out, sessions: report.sessions, turns: report.turns, old: report.old, new: report.new, rates: report.rates, percentiles: report.percentiles }, null, 2))
