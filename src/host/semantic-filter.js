// O03：严格 JSON 之后的语义过滤（Host）。
//
// 原则（与方案一致）：不修复、不截断、不“洗稿”。只拒绝明显不是用户会说的话：
// - 助手口吻开头（“我来…”“让我…”）；
// - 感谢/评价（“不错”“谢谢”）；
// - 元话语（“没有建议”）；
// - 错误文本（api error / timed out / error:）；
// - 标签前缀（“建议：”“User:”）；
// - 与助手最后一句高度重复（字符 bigram 重合率 ≥ 0.8）。
//
// 命中返回规则名（写入 O01 的 reason），否则返回 null。规则保持保守，避免误杀
// 正常的用户追问；更细的语义判断留给提示词与评测。

const RULES = [
  ['assistant-voice', /^(我来|让我|我可以|我们可以|建议你|建议先|需要我|要我先|要不要我)/u],
  ['praise-or-thanks', /(谢谢|感谢|辛苦了|不错|很好|好主意|厉害)/u],
  ['meta-talk', /(没有建议|暂无建议|无建议|不需要建议|无需建议)/u],
  ['error-text', /(api error|timed out|timeout|error[:：]|出错|报错)/iu],
  ['label-prefix', /^(建议|回答|User|Assistant|Suggestion|Reply)[:：]/iu],
]

/** 字符 bigram 覆盖率：suggestion 的 bigram 有多大比例出现在 finalAssistant 中。 */
export function bigramOverlap(suggestion, finalAssistant) {
  const charsOf = (text) => Array.from(String(text).replace(/\s+/gu, ' ').trim().toLowerCase())
  const suggestionChars = charsOf(suggestion)
  const assistantChars = charsOf(finalAssistant)
  if (suggestionChars.length < 2 || assistantChars.length < 2) return 0
  const assistantGrams = new Set()
  for (let i = 0; i < assistantChars.length - 1; i += 1) assistantGrams.add(assistantChars[i] + assistantChars[i + 1])
  let hit = 0
  const total = Math.max(1, suggestionChars.length - 1)
  for (let i = 0; i < suggestionChars.length - 1; i += 1) {
    if (assistantGrams.has(suggestionChars[i] + suggestionChars[i + 1])) hit += 1
  }
  return hit / total
}

/**
 * @param {string} suggestion - 通过严格 JSON/输出校验的建议。
 * @param {string} finalAssistant - 上下文最后一条助手文本（可为空）。
 * @returns {string | null} 命中的规则名。
 */
export function semanticViolation(suggestion, finalAssistant) {
  if (typeof suggestion !== 'string' || suggestion.trim() === '') return null
  const text = suggestion.trim()
  for (const [name, pattern] of RULES) {
    if (pattern.test(text)) return name
  }
  if (typeof finalAssistant === 'string' && finalAssistant.trim() !== '' && bigramOverlap(text, finalAssistant) >= 0.8) {
    return 'duplicate-assistant'
  }
  return null
}
