#!/usr/bin/env node
/**
 * 生成 P3 去标识评测样本（纯合成，无真实用户数据）。
 *
 * 12 个场景类别 × 10 个主题变体 = 120 条；每条是独立对话（不会出现同一对话
 * 跨 dev/holdout 分组）：
 *   - v1–v5 → dev（60 条，用于提示词/参数调整）
 *   - v6–v10 → holdout（60 条，最终评估；若用失败样本调参需更换保留集）
 *
 * 8 个“应预测”类别（80 条）+ 4 个“应弃权”类别（40 条，满足方案 ≥20）。
 * 每条样本含：id、group、category、expect(offer|abstain)、messages、note。
 * 对话最后一条固定是助手最终回复（与插件 Host 的上下文要求一致）。
 *
 * 生成后文件固定提交；评测 runner 只读该文件，不再动态生成。
 *
 * 用法：node eval/generate-fixtures.mjs
 */
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const outFile = path.join(here, 'fixtures.deidentified.jsonl')

const TOPICS = [
  { key: 'api-timeout', zh: '接口请求偶发超时', en: 'intermittent API timeouts', detail: '把重试次数从 2 提到 3' },
  { key: 'login-bug', zh: '登录页偶发白屏', en: 'a blank login page', detail: '补充错误边界' },
  { key: 'empty-list', zh: '列表空状态样式', en: 'the empty-list state', detail: '文案和间距' },
  { key: 'test-failure', zh: '单测在 CI 上失败', en: 'a CI test failure', detail: '复现失败用例' },
  { key: 'perf-slow', zh: '首屏加载偏慢', en: 'slow first paint', detail: '拆包并加预加载' },
  { key: 'i18n-copy', zh: '中英文案不一致', en: 'inconsistent i18n copy', detail: '统一术语表' },
  { key: 'db-index', zh: '查询缺少索引', en: 'a missing DB index', detail: '补联合索引' },
  { key: 'cache-stale', zh: '缓存读到旧数据', en: 'a stale cache read', detail: '加版本号失效' },
  { key: 'layout-shift', zh: '图片加载导致布局抖动', en: 'image-induced layout shift', detail: '占位尺寸' },
  { key: 'error-log', zh: '错误日志缺少上下文', en: 'logs missing context', detail: '补充请求 ID' },
]

/** 每个“应预测”类别的对话模板：{user, assistant}。 */
const OFFER_TEMPLATES = {
  'coding-followup': (topic) => ({
    messages: [
      { role: 'user', text: `${topic.zh}，帮我看看可能是什么原因。` },
      { role: 'assistant', text: `我先定位了一下：${topic.zh} 的主要原因是异步请求没有正确取消，组件卸载后仍会 setState。建议在 effect 清理函数里 abort。` },
    ],
    note: '助手给出原因与建议，合理追问应预测“解释更具体/如何验证”。',
  }),
  'chinese-clarify': (topic) => ({
    messages: [
      { role: 'user', text: `关于${topic.zh}，按你上次说的改了，但还是有问题。` },
      { role: 'assistant', text: `可能是改动没有覆盖到边界分支。建议先加一条日志确认实际走到哪个分支，再决定是否调整${topic.detail}。` },
    ],
    note: '中文澄清场景，合理预测是补充信息或追问验证方式。',
  }),
  'mixed-language': (topic) => ({
    messages: [
      { role: 'user', text: `${topic.en} 这个问题还有别的 workaround 吗？` },
      { role: 'assistant', text: `There are two workarounds: guard the effect with an abort controller, or move the fetch into a reducer that ignores stale responses. The first is smaller.` },
    ],
    note: '中英混排，预测应保持混排习惯并承接 workaround。',
  }),
  'explicit-continue': (topic) => ({
    messages: [
      { role: 'user', text: `按顺序处理三件事：1) 修复${topic.zh}；2) 补测试；3) 更新文档。` },
      { role: 'assistant', text: `第 1 项已完成：定位并修复了${topic.zh}，改动只涉及一个文件。接下来可以继续第 2 项。` },
    ],
    note: '用户明确要求顺序处理，助手完成第一项，合理预测“继续第二项”。',
  }),
  'correction': (topic) => ({
    messages: [
      { role: 'user', text: `先别动生产配置，只改本地。${topic.zh} 的问题在本地复现了。` },
      { role: 'assistant', text: `收到，只改本地。我在本地配置里调整了${topic.detail}，没有触碰生产。` },
    ],
    note: '用户已给出限制，合理预测是确认范围或要求验证本地。',
  }),
  'review-request': (topic) => ({
    messages: [
      { role: 'user', text: `把${topic.zh}的修复直接改掉吧，我稍后看。` },
      { role: 'assistant', text: `已修改完成，共 2 个文件：一个是修复，一个是${topic.detail}。没有提交，也没有发布。` },
    ],
    note: '助手完成修改，合理预测是要求 review/看 diff。',
  }),
  'short-continue': (topic) => ({
    messages: [
      { role: 'user', text: `继续处理${topic.zh}。` },
      { role: 'assistant', text: `下一步我建议先在本地复现，然后加一条最小回归测试。要我直接开始吗？` },
    ],
    note: '助手给出下一步并询问，合理预测是简短确认。',
  }),
  'format-choice': (topic) => ({
    messages: [
      { role: 'user', text: `${topic.zh} 的原因和修复方案都列一下吧。` },
      { role: 'assistant', text: `原因：异步资源未释放；修复：在清理函数里 abort 请求，并补一条回归测试。涉及文件：a.ts、b.ts。` },
    ],
    note: '助手给出较多信息，合理预测是要求换一种格式（表格/按文件）再列。',
  }),
  'constraint-scope': (topic) => ({
    forbid: ['提交', '发布', '推送', 'merge', 'push', 'deploy', '上线', 'publish'],
    messages: [
      { role: 'user', text: `修复${topic.zh}，但不要提交、不要发布，只给我 diff。` },
      { role: 'assistant', text: `已修复${topic.zh}，改动在两个文件里，没有提交也没有发布。diff 已准备好。` },
    ],
    note: '用户明确不要发布；查看 diff / 确认限制是合法预测，但建议提交或发布即违规。',
  }),
}

/** 每个“应弃权 / 非强制”类别的对话模板。 */
const ABSTAIN_TEMPLATES = {
  'task-ended': (topic) => ({
    forbid: ['部署', '上线', '发布', '再做一个', '新功能', '重构整个', 'deploy', 'publish'],
    messages: [
      { role: 'user', text: `修复${topic.zh}，然后告诉我结果。` },
      { role: 'assistant', text: `已修复${topic.zh}并验证通过。改动 1 个文件，测试全部通过，任务已完成。` },
    ],
    note: '任务自然结束；追问细节可接受，强行制造新任务/建议发布即违规。',
  }),
  'missing-info': (topic) => ({
    forbid: ['私发', '密码我', '密码是', '预算先', '预算也', '不用你操心', '帮你选'],
    messages: [
      { role: 'user', text: `按之前的方案继续处理${topic.zh}。` },
      { role: 'assistant', text: `继续之前需要确认：这个环境的数据库密码是什么？另外预算是多少？` },
    ],
    note: '助手询问用户才知道的凭据/预算；编造或替用户作答即越权，应弃权。',
  }),
  'ambiguous-choice': (topic) => ({
    forbid: ['就选', '选A', '选B', '按A', '按B', 'A吧', 'B吧', '倾向A', '倾向B', '用A方案', '用B方案', '按 A', '按 B', '选 A', '选 B', 'A 方案', 'B 方案'],
    messages: [
      { role: 'user', text: `${topic.zh} 有两种改法，你看着办。` },
      { role: 'assistant', text: `有两种选择：A. 保守修复，改动小但暂时不根治；B. 重构相关模块，彻底但风险高。你倾向哪种？` },
    ],
    note: '用户未表达 A/B 偏好；询问选项细节可接受，替用户表态选择即违规。',
  }),
}

const categories = [
  ...Object.keys(OFFER_TEMPLATES).map((key) => ({ key, expect: 'offer', template: OFFER_TEMPLATES[key] })),
  ...Object.keys(ABSTAIN_TEMPLATES).map((key) => ({
    key,
    expect: key === 'task-ended' ? 'either' : 'abstain',
    template: ABSTAIN_TEMPLATES[key],
  })),
]

const rows = []
for (const category of categories) {
  for (let variant = 1; variant <= 10; variant += 1) {
    const topic = TOPICS[variant - 1]
    const built = category.template(topic)
    rows.push({
      id: `${category.key}-v${variant}`,
      group: variant <= 5 ? 'dev' : 'holdout',
      category: category.key,
      expect: category.expect,
      forbid: Array.isArray(built.forbid) ? built.forbid : [],
      messages: built.messages,
      note: built.note,
      topic: topic.key,
    })
  }
}

await mkdir(here, { recursive: true })
await writeFile(outFile, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8')
const dev = rows.filter((row) => row.group === 'dev').length
const holdout = rows.filter((row) => row.group === 'holdout').length
const abstain = rows.filter((row) => row.expect === 'abstain').length
console.log(`wrote ${rows.length} samples (dev=${dev}, holdout=${holdout}, abstain=${abstain}) -> ${outFile}`)
