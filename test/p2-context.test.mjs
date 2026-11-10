// P2 权威上下文构建测试（无 DSH 运行时）。
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  createSessionContextReader,
  extractHumanAndAssistant,
  formatTurnFacts,
  redactSecrets,
  summarizeTurn,
  trimMessages,
} from '../src/host/context-builder.js'
import { DEFAULT_CONFIG } from '../src/shared/config.js'

const config = { ...DEFAULT_CONFIG, enabled: true }

function userEvent(seq, text, kind = 'user') {
  return { type: 'user/message', seq, data: { role: 'user', source: { kind }, content: [{ type: 'text', text }] } }
}
function assistantEvent(seq, text, sourceKind = 'model') {
  // real event shape: data = {turn, step, message, stream, usage}; message carries source/content
  return {
    type: 'assistant/message',
    seq,
    data: { turn: 1, step: 1, message: { role: 'assistant', source: { kind: sourceKind, provider: 'turn-provider', model: 'turn-model' }, content: [{ type: 'text', text }] } },
  }
}
function contextEvent(seq, text) {
  return { type: 'user/message', seq, data: { role: 'user', source: { kind: 'runtime-context' }, content: [{ type: 'text', text }] } }
}

function endEvent(seq, kind = 'completed') {
  return { type: 'turn/end', seq, data: { turn: 1, reason: { kind } } }
}

function anchor(assistantSeq, endSeq) {
  return { sessionId: 's1', branchEpoch: 'v1', turnId: `t1a${assistantSeq}`, completedEventSeq: endSeq }
}

function readerWithSurface(snapshot, completion = endEvent(snapshot.capturedThroughSeq)) {
  return createSessionContextReader({
    getSessionQuery: () => ({ readSession: async () => ({ events: [completion] }), readSurface: async () => snapshot }),
    getSession: () => undefined,
  })
}

test('extractHumanAndAssistant keeps only human user and model assistant text', () => {
  const messages = extractHumanAndAssistant([
    userEvent(1, '你好'),
    contextEvent(2, 'runtime context'),
    assistantEvent(3, '收到'),
    assistantEvent(4, 'reasoning-only?', 'model'),
    userEvent(5, '工具结果?', 'tool'),
  ])
  // B02b: 同一回合只保留最后一条助手文本（多步旁白不占名额）。
  assert.deepEqual(messages, [
    { role: 'user', text: '你好' },
    { role: 'assistant', text: 'reasoning-only?' },
  ])
})

test('B03 redaction no longer mangles paths, session ids, commits or URLs', () => {
  const samples = [
    'work/token-reduction-20261105/REPORT.md',
    'session-07b5568b-4c2a-4a8a-9b4b-1a2b3c4d5e6f',
    'commit 3f9a1c2b8d7e6f5a4b3c2d1e0f9a8b7c6d5e4f3a',
    'https://github.com/example/repo/blob/main/file.ts',
  ]
  for (const sample of samples) {
    const result = redactSecrets(sample)
    assert.equal(result.text, sample, sample)
    assert.equal(result.redactions, 0, sample)
  }
})

test('B03 still redacts high-entropy base64-like tokens', () => {
  const token = 'AbCdEf0123456789AbCdEf0123456789AbCdEf01'
  const result = redactSecrets(`key ${token} here`)
  assert.ok(result.text.includes('[REDACTED_SECRET]'))
  assert.ok(!result.text.includes(token))
})

test('redaction covers bare hex keys, base64url tokens, token/cookie values and whole JWTs', () => {
  const secrets = [
    ['key is 9f86d081884c7d659a2feaa0c55ad015', '9f86d081884c7d659a2feaa0c55ad015'],
    [`hash ${'a3f1'.repeat(16)}`, 'a3f1'.repeat(16)],
    ['tok AbCd1234_EfGh5678-IjKl9012_MnOp3456-QrSt7890_UvWx', 'AbCd1234_EfGh5678'],
    ['token: abcd1234efgh5678', 'abcd1234efgh5678'],
    ['Cookie: SESSDATA=1a2b3c4d5e6f7a8b9c0d', '1a2b3c4d5e6f7a8b9c0d'],
    [
      'jwt eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSM-eKKF2QT4fwpMeJf36POk6yJV_adQssw5c',
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',
    ],
  ]
  for (const [sample, secret] of secrets) {
    const result = redactSecrets(sample)
    assert.ok(result.redactions >= 1, sample)
    assert.ok(!result.text.includes(secret), sample)
  }
  assert.ok(!redactSecrets(secrets[5][0]).text.includes('SflKxwRJSM'))
})

test('redaction leaves usage numbers, long names, UUIDs and commit hashes alone', () => {
  const samples = [
    '输入 token: 1406，输出 token: 11',
    'token=deepseek',
    'D:/projects/app/work/memory-system-s1-v2-20261108-council/notes',
    'memory-system-s1-v2-20261108-Council-notes-Final-V2',
    'session-07b5568b-f178-4015-bd48-0c27a7a5a0f6',
    'commit 3f9a1c2b4d5e6f708192a3b4c5d6e7f801234567',
    'short 3f9a1c2b4d5e',
    'https://github.com/QwenLM/qwen-code/blob/main/packages/core/src/followup/suggestionGenerator2.ts',
    'node scripts/build-agent-preset-patches.mjs',
  ]
  for (const sample of samples) {
    const result = redactSecrets(sample)
    assert.equal(result.text, sample, sample)
    assert.equal(result.redactions, 0, sample)
  }
})

test('B02 keeps the recent user message and preserves the final assistant tail', () => {
  const userLong = `用户约束ABC${'中'.repeat(1000)}末尾要求XYZ`
  const assistantLong = `开头说明${'中'.repeat(2000)}尾部结论TAIL`
  const result = trimMessages(
    [
      { role: 'user', text: userLong },
      { role: 'assistant', text: assistantLong },
    ],
    { maxMessages: 12, maxCodePoints: 6000, targetInputTokens: 3000 },
  )
  assert.equal(result.userMessages, 1)
  const user = result.messages.find((message) => message.role === 'user')
  assert.ok(user.text.startsWith('用户约束ABC'))
  assert.ok(Array.from(user.text).length <= 700)
  const assistant = result.messages[result.messages.length - 1]
  assert.equal(assistant.role, 'assistant')
  assert.ok(assistant.text.endsWith('尾部结论TAIL'))
  assert.ok(assistant.text.includes('[…内容因长度限制被截断…]'))
  assert.ok(Array.from(assistant.text).length <= 1300)
  assert.equal(result.truncated, true)
})

test('B02 keeps the three most recent human messages instead of dropping them', () => {
  const messages = []
  for (let index = 1; index <= 4; index += 1) {
    messages.push({ role: 'user', text: `用户${index}号${'甲'.repeat(900)}` })
    messages.push({ role: 'assistant', text: `助手${index}号回复${'乙'.repeat(100)}` })
  }
  const result = trimMessages(messages, { maxMessages: 40, maxCodePoints: 6000, targetInputTokens: 4000 })
  assert.ok(result.userMessages >= 2, `expected at least two retained user messages, got ${result.userMessages}`)
  assert.ok(result.messages.some((message) => message.role === 'user' && message.text.startsWith('用户4号')))
  assert.ok(result.messages.some((message) => message.role === 'user' && message.text.startsWith('用户3号')))
})

test('B02 never drops the recent user message even under a tight token target', () => {
  const messages = [
    { role: 'user', text: `旧问题${'旧'.repeat(2000)}` },
    { role: 'assistant', text: `旧回答${'答'.repeat(2000)}` },
    { role: 'user', text: '最近的用户请求' },
    { role: 'assistant', text: `最终回答${'尾'.repeat(2000)}末尾` },
  ]
  const result = trimMessages(messages, { maxMessages: 12, maxCodePoints: 6000, targetInputTokens: 900 })
  assert.ok(result.userMessages >= 1)
  assert.ok(result.messages.some((message) => message.role === 'user' && message.text.includes('最近的用户请求')))
  assert.equal(result.messages[result.messages.length - 1].role, 'assistant')
})

test('redactSecrets removes obvious credentials and counts hits', () => {
  const result = redactSecrets(
    'use sk-abcdefghijklmnopqrstuvwxyz123456 and Bearer abc.def.ghi, key=supersecret, mail a@b.com',
  )
  assert.ok(result.redactions >= 3)
  assert.ok(result.text.includes('[REDACTED_KEY]'))
  assert.ok(result.text.includes('[REDACTED]'))
  assert.ok(!result.text.includes('sk-abcdefghijklmnopqrstuvwxyz123456'))
  assert.ok(!result.text.includes('a@b.com'))
})

test('trimMessages keeps the trailing assistant and marks truncation', () => {
  const messages = [
    { role: 'user', text: '旧'.repeat(4000) },
    { role: 'assistant', text: '答'.repeat(3000) },
    { role: 'user', text: '新问题' },
    { role: 'assistant', text: '最终回复' },
  ]
  const result = trimMessages(messages, {
    maxMessages: 3,
    maxCodePoints: 2000,
    targetInputTokens: 1200,
  })
  assert.ok(result.messages.length >= 2)
  assert.equal(result.messages[result.messages.length - 1].role, 'assistant')
  assert.ok(result.messages[result.messages.length - 1].text.includes('最终回复'))
  assert.equal(result.truncated, true)
  assert.ok(result.estimatedTokens > 0)
})

test('readSurface path builds a verified tail', async () => {
  const reader = readerWithSurface({
    capturedThroughSeq: 20,
    inheritedEventCount: 0,
    events: [
      userEvent(8, '请分析原因'),
      contextEvent(9, 'runtime'),
      assistantEvent(16, '原因是 X'),
    ],
  })
  const result = await reader.read(anchor(16, 20), config)
  assert.equal(result.ok, true)
  assert.deepEqual(result.messages, [
    { role: 'user', text: '请分析原因' },
    { role: 'assistant', text: '原因是 X' },
  ])
  assert.ok(result.input.includes('[用户] 请分析原因'))
  assert.ok(result.estimatedTokens > 0)
  assert.deepEqual(result.modelSelection, { provider: 'turn-provider', model: 'turn-model' })
})

test('B04: capturedThroughSeq beyond the turn end is accepted when no invalidating event followed', async () => {
  const reader = readerWithSurface({
    capturedThroughSeq: 25,
    inheritedEventCount: 0,
    events: [userEvent(8, 'x'), assistantEvent(16, 'y')],
  }, endEvent(20))
  const result = await reader.read(anchor(16, 20), config)
  assert.equal(result.ok, true)
  assert.deepEqual(result.messages.at(-1), { role: 'assistant', text: 'y' })
})

test('B04: a user message after the turn end invalidates the context', async () => {
  const reader = createSessionContextReader({
    getSessionQuery: () => ({
      readSession: async () => ({ events: [endEvent(20), { type: 'user/message', seq: 21, data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '新消息' }] } }] }),
      readSurface: async () => ({ capturedThroughSeq: 25, inheritedEventCount: 0, events: [userEvent(8, 'x'), assistantEvent(16, 'y')] }),
    }),
    getSession: () => undefined,
  })
  const result = await reader.read(anchor(16, 20), config)
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'stale-context')
})

test('B04: title or model-selection events after the turn end do not invalidate', async () => {
  const reader = createSessionContextReader({
    getSessionQuery: () => ({
      readSession: async () => ({
        events: [
          endEvent(20),
          { type: 'session/title', seq: 21, data: { title: 'x', messageSeqs: [] } },
          { type: 'model/selection', seq: 22, data: { provider: 'p', model: 'm' } },
          { type: 'job/settled', seq: 23, data: {} },
        ],
      }),
      readSurface: async () => ({ capturedThroughSeq: 23, inheritedEventCount: 0, events: [userEvent(8, 'x'), assistantEvent(16, 'y')] }),
    }),
    getSession: () => undefined,
  })
  const result = await reader.read(anchor(16, 20), config)
  assert.equal(result.ok, true)
})

test('missing final assistant text abstains', async () => {
  const reader = readerWithSurface({
    capturedThroughSeq: 5,
    inheritedEventCount: 0,
    events: [userEvent(1, '只问了问题'), contextEvent(2, 'runtime')],
  })
  const result = await reader.read(anchor(1, 5), config)
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'no-final-assistant-text')
})

test('a verified live turn does not need a log read, but still needs the authoritative surface', async () => {
  const session = { seq: 21 }
  const reader = createSessionContextReader({
    getSession: () => session,
  })
  const request = anchor(16, 20)
  assert.equal((await reader.verifyAnchor(request)).ok, false)
  reader.noteEvent(session, endEvent(20))
  const completion = await reader.verifyAnchor(request)
  assert.equal(completion.ok, true)
  assert.equal(typeof completion.completedAt, 'number')
  assert.equal((await reader.read(request, config, completion)).reason, 'context-unavailable')
  // B04: 无害事件只增长 seq 不会让完成过期。
  session.seq += 1
  assert.equal(completion.isCurrent(), true)
  // 新回合开始（turn/start）才让旧完成过期。
  reader.noteEvent(session, { type: 'turn/start', seq: 22, data: { turn: 2 } })
  assert.equal(completion.isCurrent(), false)
  assert.equal((await reader.verifyAnchor(anchor(16, 20))).reason, 'stale-context')
})

test('non-completed turns and a mismatched final message are skipped', async () => {
  const snapshot = { capturedThroughSeq: 20, events: [userEvent(8, '问题'), assistantEvent(16, '旧回复')] }
  for (const kind of ['blocked', 'aborted', 'error', 'max-tokens', 'interrupted', 'forked']) {
    const reader = readerWithSurface(snapshot, endEvent(20, kind))
    assert.equal((await reader.read(anchor(16, 20), config)).reason, 'turn-not-completed')
  }
  assert.equal((await readerWithSurface(snapshot).read(anchor(17, 20), config)).reason, 'no-final-assistant-text')
})

test('O08: summarizeTurn counts tool calls, file writes and test commands without text', () => {
  const events = [
    { type: 'turn/start', seq: 1, data: { turn: 2 } },
    { type: 'tool/call', seq: 2, data: { turn: 2, name: 'read', arguments: { path: 'a.ts' } } },
    { type: 'tool/call', seq: 3, data: { turn: 2, name: 'edit', arguments: { path: 'a.ts' } } },
    { type: 'tool/call', seq: 4, data: { turn: 2, name: 'shell', arguments: { command: 'npm test -- --run' } } },
    { type: 'tool/call', seq: 5, data: { turn: 1, name: 'edit', arguments: {} } },
    { type: 'turn/end', seq: 6, data: { turn: 2, reason: { kind: 'completed' } } },
  ]
  const stats = summarizeTurn(events, 2)
  assert.deepEqual(stats, { toolCalls: 3, fileWrites: 1, testRuns: 1 })
  const facts = formatTurnFacts(stats)
  assert.ok(facts.includes('3 次工具调用'))
  assert.ok(facts.includes('修改文件 1 次'))
  assert.ok(facts.includes('运行测试 1 次'))
  assert.equal(formatTurnFacts({ toolCalls: 0, fileWrites: 0, testRuns: 0 }), '')
})

test('O08: read() injects turn facts into the model input', async () => {
  const reader = createSessionContextReader({
    getSessionQuery: () => ({
      readSession: async () => ({
        events: [
          { type: 'turn/start', seq: 1, data: { turn: 1 } },
          { type: 'tool/call', seq: 2, data: { turn: 1, name: 'edit', arguments: {} } },
          { type: 'tool/call', seq: 3, data: { turn: 1, name: 'read', arguments: {} } },
          { type: 'turn/end', seq: 20, data: { turn: 1, reason: { kind: 'completed' } } },
        ],
      }),
      readSurface: async () => ({ capturedThroughSeq: 20, inheritedEventCount: 0, events: [userEvent(8, '???'), assistantEvent(16, '???')] }),
    }),
    getSession: () => undefined,
  })
  const result = await reader.read(anchor(16, 20), config)
  assert.equal(result.ok, true)
  assert.ok(result.input.includes('回合事实'))
  assert.ok(result.input.includes('2 次工具调用'))
  assert.ok(result.input.includes('修改文件 1 次'))
  assert.ok(result.input.includes('未观察到测试命令'))
  assert.equal(result.turnStats.toolCalls, 2)
})

test('findHabitPhrases returns short messages the user sent at least twice', async () => {
  const { findHabitPhrases } = await import('../src/host/context-builder.js')
  const texts = ['先看下整体结构', '继续', '把这个函数改成异步的，并且补上错误处理和重试逻辑，别动别的地方', '继续。', '/compact', '/compact', '跑一下测试', '继续！', '跑一下测试', 'OK', 'ok']
  // "继续" x3 (punctuation ignored, latest wording shown); "ok" and "跑一下测试" both x2, the more recent first.
  assert.deepEqual(findHabitPhrases(texts), ['继续！', 'ok', '跑一下测试'])
  assert.deepEqual(findHabitPhrases(texts, { maxPhrases: 1 }), ['继续！'])
  // Said once, too long, multi-line, slash commands and one-character messages never qualify.
  assert.deepEqual(findHabitPhrases(['继续', '好', '好', '第一行\n第二行', '第一行\n第二行', '这是一条超过二十个字的比较长的消息需要被排除在外', '这是一条超过二十个字的比较长的消息需要被排除在外']), [])
  // Something that looks like a secret is never offered back.
  assert.deepEqual(findHabitPhrases(['token: abcd1234efgh', 'token: abcd1234efgh']), [])
  assert.deepEqual(findHabitPhrases(null), [])
})
