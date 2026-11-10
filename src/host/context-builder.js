// Host 侧权威上下文读取与构建。
//
// 数据来源（只读，绝不写入会话）：
// - 首选 `ctx.sessionQuery.readSurface(sessionId)`：折叠后的当前模型面，可读冷会话，
//   返回 { events, capturedThroughSeq, inheritedEventCount }；
// - 回合结束事实来自 session/event，冷会话或重载前的回合用 readSession 复核。
//
// 过滤规则（方案 §七 / P0 契约 §1.3）：
// - 人类输入：`role:'user'` 且 `source.kind === 'user'`（同时覆盖本地与 user-rpc）；
// - 助手最终文本：`role:'assistant'` 且 `source.kind === 'model'`，只取 `type:'text'` 块；
// - 排除 runtime-context / tool / reasoning / skill-catalog / system / developer 等。
//
// 上限：条数、码点、估算 token；敏感信息先脱敏。所有截断显式标记。

import { estimateEnvelopeTokens, estimateTokens, buildPredictionInput } from '../shared/prompt.js'

/** 常见凭据/秘密模式（保守脱敏；不保证识别所有秘密，设置页需说明发送范围）。 */
const REDACTION_RULES = [
  // 完整 JWT（三段 base64url）；必须排在高熵规则之前，否则只会替换中间一段。
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/gu, '[REDACTED_TOKEN]'],
  // token / cookie 关键词：值要求 ≥8 位且同时含字母和数字，
  // 因此“输入 token: 1406”这类用量数字不会被替换。
  [/\b(token|cookie)\b\s*[:=]\s*["']?(?=[^\s"',;]*[A-Za-z])(?=[^\s"',;]*[0-9])[^\s"',;]{8,}/giu, '$1=[REDACTED]'],
  [/\bsk-[A-Za-z0-9_-]{16,}\b/gu, '[REDACTED_KEY]'],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/gu, '[REDACTED_TOKEN]'],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/gu, '[REDACTED_TOKEN]'],
  [/\bAKIA[0-9A-Z]{16}\b/gu, '[REDACTED_KEY]'],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/giu, 'Bearer [REDACTED]'],
  [/\b(api[_-]?key|secret|password|passwd|pwd|access[_-]?token|auth[_-]?token)\b\s*[:=]\s*["']?[^\s"',;]{4,}/giu, '$1=[REDACTED]'],
  [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/gu, '[REDACTED_EMAIL]'],
]
/**
 * 高熵不透明串（B03）：只把“看起来像 base64/API token”的长串当秘密。
 * - 不含路径分隔符、连字符、下划线，因此路径、会话号、UUID、提交号、
 *   GitHub 文件网址不会被误伤；
 * - 要求同时含大写、小写与数字，排除纯十六进制提交号与普通英文长词；
 * - 明确的密钥前缀规则（sk-/ghp_/xox/AKIA/Bearer/key= 等）仍然优先。
 */
const BASE64_LIKE_RE = /[A-Za-z0-9+]{40,}={0,2}/gu

function looksLikeHighEntropySecret(candidate) {
  if (typeof candidate !== 'string' || candidate.length < 40) return false
  return /[a-z]/u.test(candidate) && /[A-Z]/u.test(candidate) && /[0-9]/u.test(candidate)
}

/**
 * 裸十六进制串：32 位（常见 API key / MD5）或 ≥48 位当秘密；
 * 40 位是 git 提交号，放行；更短的是短提交号或普通 id，也放行。
 * 前后不能紧挨字母数字，UUID 的各段（最长 12 位）不会命中。
 */
const BARE_HEX_RE = /(?<![A-Za-z0-9])[0-9a-fA-F]{32,}(?![A-Za-z0-9])/gu

function isSecretLengthHex(candidate) {
  if (candidate.length !== 32 && candidate.length < 48) return false
  return /[a-fA-F]/u.test(candidate) && /[0-9]/u.test(candidate)
}

/**
 * 含 `-` / `_` 的 base64url 令牌。前后不能是路径、网址或文件名的一部分；
 * 任何一段是普通单词（≥4 位纯小写）或纯数字（≥4 位）就放行，
 * 这样 `memory-system-s1-v2-20261108-Council` 一类的目录名不会被误伤。
 */
const BASE64URL_LIKE_RE = /(?<![A-Za-z0-9_\/\\.:-])[A-Za-z0-9_-]{40,}(?![A-Za-z0-9_\/\\.-])/gu

function looksLikeBase64UrlSecret(candidate) {
  if (!/[-_]/u.test(candidate)) return false
  if (!(/[a-z]/u.test(candidate) && /[A-Z]/u.test(candidate) && /[0-9]/u.test(candidate))) return false
  return !candidate.split(/[-_]/u).some((part) => /^[a-z]{4,}$/u.test(part) || /^[0-9]{4,}$/u.test(part))
}

/** 脱敏一段文本；返回清理后的文本与命中次数。 */
export function redactSecrets(text) {
  if (typeof text !== 'string' || text === '') return { text: '', redactions: 0 }
  let output = text
  let redactions = 0
  for (const [pattern, replacement] of REDACTION_RULES) {
    output = output.replace(pattern, (match) => {
      redactions += 1
      return typeof replacement === 'string' ? replacement : match
    })
  }
  output = output.replace(BASE64_LIKE_RE, (match) => {
    if (!looksLikeHighEntropySecret(match)) return match
    redactions += 1
    return '[REDACTED_SECRET]'
  })
  output = output.replace(BARE_HEX_RE, (match) => {
    if (!isSecretLengthHex(match)) return match
    redactions += 1
    return '[REDACTED_SECRET]'
  })
  output = output.replace(BASE64URL_LIKE_RE, (match) => {
    if (!looksLikeBase64UrlSecret(match)) return match
    redactions += 1
    return '[REDACTED_SECRET]'
  })
  return { text: output, redactions }
}

/**
 * 常说的话：用户在这次对话里说过至少两次的短句。
 *
 * 依据：真实会话回放里，建议和用户真实下一条完全一致的唯一一例，就是用户重复
 * 说过的短跟进（真实会话回放，见 docs/OPTIMIZATION-BATCH3.md）。这类句子
 * 不需要模型去猜。
 *
 * 规则：
 * - 只看单行、2–20 个字的消息；斜杠指令（/xxx）和 @ 开头的不算；
 * - 比较时忽略首尾空白、连续空格、结尾标点和英文大小写；
 * - 出现次数 ≥ minCount 才算；按“次数多、最近说过”排序；
 * - 显示用最近一次的原话；含疑似密钥（脱敏会改动它）的不要。
 *
 * @param {string[]} userTexts - 按时间顺序的用户消息原文。
 * @param {{maxPhrases?: number, minCount?: number, maxGraphemes?: number}} [options]
 * @returns {string[]} 最多 maxPhrases 条，最值得给的在前。
 */
export function findHabitPhrases(userTexts, options) {
  const maxPhrases = Number.isInteger(options?.maxPhrases) ? Math.max(1, options.maxPhrases) : 3
  const minCount = Number.isInteger(options?.minCount) ? Math.max(2, options.minCount) : 2
  const maxGraphemes = Math.min(20, Number.isFinite(options?.maxGraphemes) ? options.maxGraphemes : 20)
  if (!Array.isArray(userTexts)) return []
  /** @type {Map<string, {count: number, last: number, text: string}>} */
  const seen = new Map()
  userTexts.forEach((raw, index) => {
    if (typeof raw !== 'string') return
    const text = raw.trim().replace(/[ \t　]+/gu, ' ')
    if (text === '' || /[\r\n]/u.test(text)) return
    if (text.startsWith('/') || text.startsWith('@')) return
    const length = Array.from(text).length
    if (length < 2 || length > maxGraphemes) return
    const key = text.replace(/[。．.！!？?～~，,、；;：:\s]+$/u, '').toLowerCase()
    if (Array.from(key).length < 2) return
    const entry = seen.get(key)
    if (entry === undefined) seen.set(key, { count: 1, last: index, text })
    else {
      entry.count += 1
      entry.last = index
      entry.text = text
    }
  })
  return [...seen.values()]
    .filter((entry) => entry.count >= minCount && redactSecrets(entry.text).redactions === 0)
    .sort((a, b) => b.count - a.count || b.last - a.last)
    .slice(0, maxPhrases)
    .map((entry) => entry.text)
}

/** 取消息的文本块（只认 `type === 'text'`）。 */
export function textOfContent(content) {
  if (!Array.isArray(content)) {
    if (typeof content === 'string') return content
    return ''
  }
  const parts = []
  for (const block of content) {
    if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text)
    }
  }
  return parts.join('\n').trim()
}

/**
 * 从原始事件序列构建按回合的 {role,text} 列表（B02/B02b）。
 *
 * 同一回合内的助手文本只保留最后一条：工具循环里每一步的旁白不再各占一条
 * 上下文名额；用户在同一回合的多次输入（steering）只保留最后一条作为该回合
 * 的请求。输出顺序按回合升序，用户消息在其助手消息之前。
 */
export function extractHumanAndAssistant(entries, options) {
  const textOf = options !== undefined && typeof options.textOf === 'function' ? options.textOf : textOfContent
  /** @type {Map<number, {users: string[], assistant: string | null}>} */
  const turns = new Map()
  let currentTurn = null
  /** @type {string[]} 还没找到所属回合的用户消息（surface 可能不含 turn/start） */
  let pendingUsers = []
  const turnFor = (turn) => {
    if (typeof turn !== 'number' || !Number.isSafeInteger(turn)) return null
    let entry = turns.get(turn)
    if (entry === undefined) {
      entry = { users: [], assistant: null }
      turns.set(turn, entry)
    }
    return entry
  }
  const flushPending = (turn) => {
    if (pendingUsers.length === 0) return
    const entry = turnFor(turn)
    if (entry !== null) entry.users.push(...pendingUsers)
    pendingUsers = []
  }
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (entry === null || typeof entry !== 'object') continue
    const type = entry.type
    if (type === 'turn/start' && typeof entry.data?.turn === 'number') {
      currentTurn = entry.data.turn
      continue
    }
    if (type === 'turn/end') continue
    const raw = entry.data !== undefined && entry.data !== null ? entry.data : entry
    const message = type === 'assistant/message' && raw.message !== null && typeof raw.message === 'object'
      ? raw.message
      : raw
    const role = typeof message.role === 'string' ? message.role : type === 'user/message' ? 'user' : type === 'assistant/message' ? 'assistant' : ''
    const source = message.source !== null && typeof message.source === 'object' ? message.source : undefined
    const sourceKind = source !== undefined && typeof source.kind === 'string' ? source.kind : ''
    if (role === 'user' && sourceKind === 'user') {
      const text = textOf(message.content)
      if (text === '') continue
      if (currentTurn !== null) {
        const turn = turnFor(currentTurn)
        turn?.users.push(text)
      } else {
        pendingUsers.push(text)
      }
    } else if (role === 'assistant' && sourceKind === 'model') {
      const text = textOf(message.content)
      if (text === '') continue
      const turn = typeof raw.turn === 'number' ? raw.turn : (typeof message.turn === 'number' ? message.turn : currentTurn)
      flushPending(turn)
      if (typeof turn === 'number') {
        const turnEntry = turnFor(turn)
        if (turnEntry !== null) turnEntry.assistant = text
        currentTurn = turn
      } else {
        // 没有回合信息的旧数据：退化为顺序列表。
        turns.set(Number.NEGATIVE_INFINITY + turns.size, { users: [], assistant: text })
      }
    }
  }
  flushPending(currentTurn)
  const out = []
  for (const turn of [...turns.keys()].sort((a, b) => a - b)) {
    const entry = turns.get(turn)
    if (entry === undefined) continue
    if (entry.users.length > 0) out.push({ role: 'user', text: entry.users[entry.users.length - 1] })
    if (entry.assistant !== null && entry.assistant !== '') out.push({ role: 'assistant', text: entry.assistant })
  }
  if (out.length === 0 && pendingUsers.length > 0) {
    for (const text of pendingUsers) out.push({ role: 'user', text })
  }
  return out
}

const TRUNCATION_MARKER = '\n[…内容因长度限制被截断…]\n'

/** 按 grapheme 截断；保留开头与结尾，中间放显式标记。 */
function truncateText(text, maxGraphemes, headRatio) {
  const chars = Array.from(text)
  if (chars.length <= maxGraphemes) return { text, truncated: false }
  const total = Math.max(2, maxGraphemes)
  const head = Math.max(1, Math.floor(total * headRatio))
  const tail = Math.max(1, total - head)
  return {
    text: chars.slice(0, head).join('') + TRUNCATION_MARKER + chars.slice(chars.length - tail).join(''),
    truncated: true,
  }
}

/** 按回合切分消息：assistant 结束一个回合；同一回合的多条助手只保留最后一条。 */
function splitTurns(messages) {
  /** @type {{user: string | null, assistant: string | null}[]} */
  const turns = []
  let current = { user: null, assistant: null }
  for (const message of messages) {
    if (message === null || typeof message !== 'object' || typeof message.text !== 'string' || message.text === '') continue
    if (message.role === 'user') {
      current.user = message.text
    } else if (message.role === 'assistant') {
      current.assistant = message.text
      turns.push(current)
      current = { user: null, assistant: null }
    }
  }
  if (current.user !== null || current.assistant !== null) turns.push(current)
  return turns
}

function clampInt(value, min, max, fallback) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, Math.round(number)))
}

/**
 * 固定配额的上下文裁剪（B02）。
 *
 * 配额（字符数，grapheme）：
 * - 最近 1 条用户消息必留，上限 600；更早再留 2 条用户消息，各上限 300；
 * - 最终助手回答上限 1200，超长按头 30% + 尾 70% 截断（结尾的“下一步/要不要我继续”最关键）；
 * - 剩余 token 预算才给更早回合的助手回答（每条上限 600，从近到远）；
 * - 同一回合内只保留最后一条助手文本（extractHumanAndAssistant 已按回合折叠）。
 *
 * 绝不为了 token 目标丢掉最近用户消息：预算不足时先压缩更早助手、再压缩
 * 最终助手、再压缩更早用户；最近用户消息保底保留。
 */
export function trimMessages(messages, limits) {
  const maxMessages = clampInt(limits?.maxMessages, 1, 40, 12)
  const maxCodePoints = clampInt(limits?.maxCodePoints, 200, 100000, 6000)
  const targetTokens = clampInt(limits?.targetInputTokens, 100, 1000000, 2000)
  const recentUserChars = clampInt(limits?.recentUserChars, 120, 2000, 600)
  const earlierUserChars = clampInt(limits?.earlierUserChars, 80, 1000, 300)
  const earlierUserCount = clampInt(limits?.earlierUserCount, 0, 8, 2)
  const finalAssistantChars = clampInt(limits?.finalAssistantChars, 200, 4000, 1200)
  const earlierAssistantChars = clampInt(limits?.earlierAssistantChars, 100, 2000, 600)
  const finalHeadRatio = 0.3
  const list = Array.isArray(messages) ? messages : []
  const turns = splitTurns(list)

  let finalIndex = -1
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    if (turns[i].assistant !== null) {
      finalIndex = i
      break
    }
  }
  // 没有助手文本：退化为按尾巴保留（不会发生在生产路径，但保持函数健壮）。
  if (finalIndex < 0) {
    const tail = []
    let codePoints = 0
    for (let i = turns.length - 1; i >= 0 && tail.length < maxMessages; i -= 1) {
      const text = turns[i].user ?? turns[i].assistant
      if (text === null) continue
      const clipped = truncateText(text, i === turns.length - 1 ? recentUserChars : earlierUserChars, 0.5)
      tail.unshift({ role: turns[i].user === null ? 'assistant' : 'user', text: clipped.text })
      codePoints += Array.from(clipped.text).length
    }
    const input = buildPredictionInput(tail, { turnFacts: limits?.turnFacts })
    return {
      messages: tail,
      input,
      truncated: tail.some((message) => message.text.includes(TRUNCATION_MARKER)),
      codePoints,
      estimatedTokens: estimateEnvelopeTokens(input),
      messageTokens: estimateTokens(input),
      userMessages: tail.filter((message) => message.role === 'user').length,
    }
  }

  const finalTurn = turns[finalIndex]
  /** 每个回合的保留配额：turnIndex -> 用户消息最大字符数 */
  const userQuota = new Map()
  if (finalTurn.user !== null) {
    userQuota.set(finalIndex, recentUserChars)
  } else {
    for (let i = finalIndex - 1; i >= 0; i -= 1) {
      if (turns[i].user !== null) {
        userQuota.set(i, recentUserChars)
        break
      }
    }
  }
  let earlierUsersAdded = 0
  for (let i = finalIndex - 1; i >= 0 && earlierUsersAdded < earlierUserCount; i -= 1) {
    if (turns[i].user === null || userQuota.has(i)) continue
    userQuota.set(i, earlierUserChars)
    earlierUsersAdded += 1
  }
  const recentUserTurn = finalTurn.user !== null
    ? finalIndex
    : [...userQuota.keys()].filter((index) => index < finalIndex).sort((a, b) => b - a)[0] ?? -1

  /** 把回合槽位铺平成消息序列。 */
  function flatten(slots) {
    const output = []
    for (const index of [...slots.keys()].sort((a, b) => a - b)) {
      for (const message of slots.get(index)) output.push(message)
    }
    return output
  }

  /**
   * 按给定预算组装；返回结果与是否仍有压缩空间。
   * @param {{finalAssistantLimit:number, includeEarlierUsers:boolean, earlierUserLimitScale:number}} plan
   */
  function assemble(plan) {
    /** @type {Map<number, {role: string, text: string}[]>} */
    const slots = new Map()
    const push = (index, message) => {
      const list = slots.get(index) ?? []
      list.push(message)
      slots.set(index, list)
    }
    let truncated = false
    for (const [index, limit] of userQuota) {
      if (!plan.includeEarlierUsers && index !== recentUserTurn) continue
      const text = turns[index].user
      if (text === null) continue
      const scaled = Math.max(120, Math.round(limit * plan.earlierUserLimitScale))
      const clipped = truncateText(text, scaled, 0.4)
      if (clipped.truncated) truncated = true
      push(index, { role: 'user', text: clipped.text })
    }
    const finalAssistant = truncateText(finalTurn.assistant, plan.finalAssistantLimit, finalHeadRatio)
    if (finalAssistant.truncated) truncated = true
    push(finalIndex, { role: 'assistant', text: finalAssistant.text })
    // 更早的助手回答：从近到远，在剩余预算内加入。
    for (let i = finalIndex - 1; i >= 0; i -= 1) {
      const text = turns[i].assistant
      if (text === null) continue
      const clipped = truncateText(text, earlierAssistantChars, finalHeadRatio)
      push(i, { role: 'assistant', text: clipped.text })
      const candidate = flatten(slots)
      const input = buildPredictionInput(candidate, { turnFacts: limits?.turnFacts })
      const overTokens = estimateEnvelopeTokens(input) > targetTokens
      const overCodePoints = candidate.reduce((sum, message) => sum + Array.from(message.text).length, 0) > maxCodePoints
      const overMessages = candidate.length > maxMessages
      if (overTokens || overCodePoints || overMessages) {
        slots.get(i).pop()
        if (clipped.truncated) truncated = false
        continue
      }
      if (clipped.truncated) truncated = true
    }
    const messagesOut = flatten(slots)
    const input = buildPredictionInput(messagesOut, { turnFacts: limits?.turnFacts })
    return {
      messages: messagesOut,
      input,
      truncated: truncated || messagesOut.some((message) => message.text.includes(TRUNCATION_MARKER)),
      codePoints: messagesOut.reduce((sum, message) => sum + Array.from(message.text).length, 0),
      estimatedTokens: estimateEnvelopeTokens(input),
      messageTokens: estimateTokens(input),
      userMessages: messagesOut.filter((message) => message.role === 'user').length,
    }
  }

  // 逐步收紧：先压更早助手（assemble 内已按预算处理），再压最终助手，
  // 再放弃更早用户，最后缩最近用户与最终助手；最近用户始终保留。
  const plans = []
  for (const limit of [finalAssistantChars, 900, 700, 500, 300, 220]) {
    plans.push({ finalAssistantLimit: limit, includeEarlierUsers: true, earlierUserLimitScale: 1 })
  }
  for (const limit of [300, 220]) {
    plans.push({ finalAssistantLimit: limit, includeEarlierUsers: false, earlierUserLimitScale: 1 })
  }
  for (const limit of [220]) {
    plans.push({ finalAssistantLimit: limit, includeEarlierUsers: false, earlierUserLimitScale: 0.6 })
  }
  let result = assemble(plans[0])
  for (const plan of plans) {
    result = assemble(plan)
    if (result.estimatedTokens <= targetTokens && result.codePoints <= maxCodePoints) break
  }
  return result
}

const COMPLETION_RESEND_WINDOW_MS = 30 * 60 * 1000

/**
 * 回合结束后是否出现“让旧上下文失效”的事件（B04）。
 * 标题、选模型、权限、投递回执、作业结算不算；只有新回合、用户新输入、
 * 压缩/回退/分支切换才算。
 */
export function isInvalidatingEvent(event) {
  if (event === null || typeof event !== 'object' || typeof event.type !== 'string') return false
  if (event.type === 'turn/start') return true
  if (event.type === 'user/message') {
    const source = event.data !== null && typeof event.data === 'object' ? event.data.source : undefined
    return source !== null && typeof source === 'object' && source.kind === 'user'
  }
  return /compact|rewind|rollback|branch\/fork|branch\/switch/u.test(event.type)
}

const FILE_WRITE_TOOLS = /^(edit|write|apply_patch|patch|str_replace|multi_edit|create_file|delete_file)$/iu
const TEST_COMMAND_RE = /(npm test|pnpm test|yarn test|bun test|jest|vitest|pytest|go test|cargo test|dotnet test|mvn test|gradle test|node --test)/iu

/**
 * O08：统计一个回合的工具事实（不含正文）。只读 tool/call 的事件字段，
 * 不读取/不输出工具参数与结果正文。
 */
export function summarizeTurn(events, turnNumber) {
  let toolCalls = 0
  let fileWrites = 0
  let testRuns = 0
  for (const event of Array.isArray(events) ? events : []) {
    if (event === null || typeof event !== 'object' || event.type !== 'tool/call') continue
    const data = event.data !== null && typeof event.data === 'object' ? event.data : {}
    const turn = typeof data.turn === 'number' ? data.turn : undefined
    if (turn !== turnNumber) continue
    toolCalls += 1
    const name = typeof data.name === 'string' ? data.name : ''
    if (FILE_WRITE_TOOLS.test(name)) fileWrites += 1
    const args = typeof data.arguments === 'string' ? data.arguments : JSON.stringify(data.arguments ?? '')
    if (TEST_COMMAND_RE.test(args) || /test/iu.test(name)) testRuns += 1
  }
  return { toolCalls, fileWrites, testRuns }
}

/** 格式化一行回合事实；没有工具调用时返回空串（不注入上下文）。 */
export function formatTurnFacts(stats) {
  if (stats === null || stats === undefined || !(stats.toolCalls > 0)) return ''
  const parts = [`本回合 ${stats.toolCalls} 次工具调用`]
  if (stats.fileWrites > 0) parts.push(`修改文件 ${stats.fileWrites} 次`)
  parts.push(stats.testRuns > 0 ? `运行测试 ${stats.testRuns} 次` : '未观察到测试命令')
  return `${parts.join('；')}。`
}

/** 读取完成回合的权威上下文。 */
export function createSessionContextReader(options) {
  const getSessionQuery = options && typeof options.getSessionQuery === 'function' ? options.getSessionQuery : () => undefined
  const getSession = options && typeof options.getSession === 'function' ? options.getSession : () => undefined
  /** session -> { lastTurnEndSeq, lastTurnEndAt, lastTurnEndCompleted, invalidatedAfter, currentTurn, statsByTurn } */
  const liveStates = new WeakMap()

  function noteEvent(session, event) {
    if (session === null || session === undefined || event === null || typeof event !== 'object') return
    let state = liveStates.get(session)
    if (state === undefined) {
      state = {
        lastTurnEndSeq: 0,
        lastTurnEndAt: 0,
        lastTurnEndCompleted: false,
        invalidatedAfter: false,
        currentTurn: 0,
        statsByTurn: new Map(),
      }
      liveStates.set(session, state)
    }
    if (event.type === 'turn/end') {
      state.lastTurnEndSeq = typeof event.seq === 'number' ? event.seq : 0
      state.lastTurnEndAt = typeof event.time === 'number' ? event.time : Date.now()
      state.lastTurnEndCompleted = event.data?.reason?.kind === 'completed'
      state.invalidatedAfter = false
      return
    }
    if (event.type === 'turn/start') {
      // B04: 新回合开始即让旧完成过期；同时记录当前回合，用于 O08 工具统计。
      state.invalidatedAfter = true
      const turn = event.data?.turn
      if (typeof turn === 'number') state.currentTurn = turn
      return
    }
    if (event.type === 'tool/call') {
      // O08: 只统计次数/工具类别，不保留参数与结果正文。
      const data = event.data !== null && typeof event.data === 'object' ? event.data : {}
      const turn = typeof data.turn === 'number' ? data.turn : state.currentTurn
      if (turn > 0) {
        const stats = state.statsByTurn.get(turn) ?? { toolCalls: 0, fileWrites: 0, testRuns: 0 }
        stats.toolCalls += 1
        const name = typeof data.name === 'string' ? data.name : ''
        if (FILE_WRITE_TOOLS.test(name)) stats.fileWrites += 1
        const args = typeof data.arguments === 'string' ? data.arguments : JSON.stringify(data.arguments ?? '')
        if (TEST_COMMAND_RE.test(args) || /test/iu.test(name)) stats.testRuns += 1
        state.statsByTurn.set(turn, stats)
        while (state.statsByTurn.size > 8) state.statsByTurn.delete(state.statsByTurn.keys().next().value)
      }
      return
    }
    // 重启后没有历史 turn/end：任何失效型事件都让“未知完成”不可信。
    if (isInvalidatingEvent(event)) state.invalidatedAfter = true
  }

  /**
   * 校验完成回合（B04）：允许 turn/end 之后出现标题/选模型/权限/回执/作业结算等
   * 非失效事件；只要出现新回合、用户新输入或压缩/回退才算过期。
   * @returns {Promise<{ok:true, turn:number, assistantSeq:number, completedAt:number, isCurrent:()=>boolean}|{ok:false, reason:string}>}
   */
  async function verifyAnchor(anchor) {
    const seq = anchor?.completedEventSeq
    const turnId = /^t(0|[1-9]\d*)a(0|[1-9]\d*)$/.exec(anchor?.turnId)
    if (!Number.isSafeInteger(seq) || seq <= 0 || turnId === null || Number(turnId[2]) >= seq || anchor.branchEpoch !== 'v1') {
      return { ok: false, reason: 'unverified-completion' }
    }
    const session = getSession(anchor.sessionId)
    const isCurrent = () => {
      const live = getSession(anchor.sessionId)
      if (session === undefined || session === null) return live === undefined || live === null || live === session || live.seq >= seq + 1
      if (live !== session || live.seq < seq + 1) return false
      const state = liveStates.get(live)
      // 运行中观察到新的失效事件（新回合/用户消息/压缩/回退）即过期。
      if (state !== undefined && state.invalidatedAfter) return false
      return true
    }
    // 1) 插件运行中见过的 turn/end：快速路径。
    const liveState = session === undefined || session === null ? undefined : liveStates.get(session)
    if (liveState !== undefined && liveState.lastTurnEndSeq > seq) {
      // 已经看到更新的回合结束：该锚点必然过期。
      return { ok: false, reason: 'stale-context' }
    }
    if (liveState !== undefined && liveState.lastTurnEndSeq === seq) {
      if (!liveState.lastTurnEndCompleted) return { ok: false, reason: 'turn-not-completed' }
      if (!isCurrent()) return { ok: false, reason: 'stale-context' }
      return {
        ok: true,
        turn: Number(turnId[1]),
        assistantSeq: Number(turnId[2]),
        completedAt: liveState.lastTurnEndAt,
        isCurrent,
      }
    }
    // 2) 重启/未观察：读完整会话日志，确认 turn/end 之后没有失效事件。
    const query = getSessionQuery()
    if (typeof query?.readSession !== 'function') {
      return { ok: false, reason: session === undefined || session === null ? 'unknown-session' : 'unverified-completion' }
    }
    let snapshot
    try {
      snapshot = await query.readSession(anchor.sessionId)
    } catch {
      return { ok: false, reason: 'unverified-completion' }
    }
    const events = Array.isArray(snapshot?.events) ? snapshot.events : []
    const endIndex = events.findIndex((event) => event !== null && typeof event === 'object' && event.seq === seq && event.type === 'turn/end')
    if (endIndex < 0) return { ok: false, reason: 'turn-not-completed' }
    const end = events[endIndex]
    if (end.data?.reason?.kind !== 'completed' || end.data?.turn !== Number(turnId[1])) {
      return { ok: false, reason: 'turn-not-completed' }
    }
    for (let index = endIndex + 1; index < events.length; index += 1) {
      if (isInvalidatingEvent(events[index])) return { ok: false, reason: 'stale-context' }
    }
    if (!isCurrent()) return { ok: false, reason: 'stale-context' }
    return {
      ok: true,
      turn: Number(turnId[1]),
      assistantSeq: Number(turnId[2]),
      completedAt: typeof end.time === 'number' ? end.time : 0,
      isCurrent,
    }
  }

  /**
   * @param {{sessionId:string, turnId:string, completedEventSeq:number}} anchor
   * @param {object} config - 生效配置。
   * @returns {Promise<{ok:true, messages:object[], input:string, modelSelection:object, truncated:boolean,
   *   codePoints:number, estimatedTokens:number, redactions:number, source:string}
   *   | {ok:false, reason:string}>}
   */
  async function read(anchor, config, completion) {
    const verified = completion ?? await verifyAnchor(anchor)
    if (!verified.ok) return verified
    const sessionQuery = getSessionQuery()
    if (typeof sessionQuery?.readSurface !== 'function') return { ok: false, reason: 'context-unavailable' }
    let snapshot
    try {
      snapshot = await sessionQuery.readSurface(anchor.sessionId)
    } catch {
      return { ok: false, reason: 'context-read-failed' }
    }
    if (!verified.isCurrent() || snapshot?.capturedThroughSeq < anchor.completedEventSeq) {
      return { ok: false, reason: 'stale-context' }
    }
    const events = Array.isArray(snapshot.events) ? snapshot.events : []
    const final = events.findLast((event) => event?.type === 'assistant/message')
    const finalMessage = final?.data?.message
    if (
      final?.seq !== verified.assistantSeq || final.data.turn !== verified.turn || final.data.interrupted === true ||
      finalMessage?.source?.kind !== 'model' || textOfContent(finalMessage.content).trim() === ''
    ) {
      return { ok: false, reason: 'no-final-assistant-text' }
    }
    const messages = extractHumanAndAssistant(events)
    if (messages.at(-1)?.role !== 'assistant') return { ok: false, reason: 'no-final-assistant-text' }
    // 脱敏。
    let redactions = 0
    // config.redactSecrets === false：用户在设置页确认过风险后关闭遮蔽，原样发送。
    const redacted = config?.redactSecrets === false
      ? messages.map((message) => ({ role: message.role, text: message.text }))
      : messages.map((message) => {
          const result = redactSecrets(message.text)
          redactions += result.redactions
          return { role: message.role, text: result.text }
        })
    // O08：回合事实摘要（工具调用/改文件/测试），不含正文；live 统计优先，冷会话读日志。
    let stats = null
    const live = getSession(anchor.sessionId)
    const liveState = live === undefined || live === null ? undefined : liveStates.get(live)
    if (liveState !== undefined && liveState.statsByTurn.has(verified.turn)) stats = liveState.statsByTurn.get(verified.turn)
    if (stats === null) {
      try {
        const log = await sessionQuery.readSession(anchor.sessionId)
        if (Array.isArray(log?.events)) stats = summarizeTurn(log.events, verified.turn)
      } catch {
        stats = null
      }
    }
    const turnFacts = config?.includeTurnFacts === false ? '' : formatTurnFacts(stats)
    // 裁剪。
    const trimmed = trimMessages(redacted, {
      maxMessages: config.contextMessages,
      maxCodePoints: config.maxContextCodePoints,
      targetInputTokens: config.targetInputTokens,
      systemReserveTokens: 600,
      turnFacts,
    })
    if (trimmed.messages.length === 0) return { ok: false, reason: 'empty-context' }
    const lastTrimmed = trimmed.messages[trimmed.messages.length - 1]
    if (lastTrimmed.role !== 'assistant') return { ok: false, reason: 'no-final-assistant-text' }
    return {
      ok: true,
      messages: trimmed.messages,
      input: trimmed.input,
      modelSelection: { provider: finalMessage.source.provider, model: finalMessage.source.model },
      truncated: trimmed.truncated,
      codePoints: trimmed.codePoints,
      estimatedTokens: trimmed.estimatedTokens,
      redactions,
      turnFacts,
      turnStats: stats ?? { toolCalls: 0, fileWrites: 0, testRuns: 0 },
      source: 'sessionQuery.readSurface',
    }
  }

  /**
   * 常说的话：从当前会话里用户自己发过的消息中找出重复的短句（见 findHabitPhrases）。
   * 只读、不落盘、不发给任何模型。读不到会话时返回空数组。
   */
  async function habitPhrases(anchor, options) {
    const sessionQuery = getSessionQuery()
    if (sessionQuery === undefined || sessionQuery === null || typeof sessionQuery.readSurface !== 'function') return []
    let snapshot
    try {
      snapshot = await sessionQuery.readSurface(anchor.sessionId)
    } catch {
      return []
    }
    const events = Array.isArray(snapshot?.events) ? snapshot.events : []
    const userTexts = []
    for (const event of events) {
      if (event?.type !== 'user/message') continue
      const data = event.data !== null && typeof event.data === 'object' ? event.data : {}
      if (data.source?.kind !== 'user') continue
      const text = textOfContent(data.content)
      if (text.trim() !== '') userTexts.push(text)
    }
    return findHabitPhrases(userTexts, options)
  }

  return { read, verifyAnchor, noteEvent, habitPhrases, isResendWindowOpen: (completedAt) => completedAt > 0 && Date.now() - completedAt <= COMPLETION_RESEND_WINDOW_MS }
}
