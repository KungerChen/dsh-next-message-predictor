# 第 1 批优化与修复记录（PLAN 2026-11-10）

对应优化计划（PLAN.md，未入库）的第 1 批：
**O01（结果记录）、B02（上下文裁剪）、B03（脱敏）、B05（手动重试）、B09（七个小修复）**。

- 插件版本：`0.2.1`（`engines.dsh: >=0.2.2-rc.1 <0.3.0`）
- 源码：本仓库
- 备份：改动前做了整目录备份（`backup-pre-batch1`，未入库）
- 验证时间：2026-11-10 06:2x–06:4x（America/Chicago）
- 构建：`node scripts/build-client.mjs` → `lib/client.js`（106,871 bytes）；`node --test` **115 项全部通过**

## 1. O01 结果记录（`src/host/results-log.js` 新增）

- 每次预测请求写一行 `<DSH_HOME>/next-message-predictor/events.jsonl`：时间、会话/回合/建议的**稳定哈希**、触发方式、结果与原因、延迟、token、建议长度；客户端回报 `shown / accepted / dismissed / overwritten / expired / closed` 作为独立行；用户发出下一条消息时只写 `exact/prefixChars/editRatio` 匹配分数。
- 正文只在 Host 内存保留（最多 2 小时/200 条），不落盘；文件 5 MB 轮换为 `events.<ISO>.jsonl`，保留 14 天；写入失败只记日志，不影响预测。
- 新增 RPC：`outcome`（客户端回报）、`results.summary`（7 天汇总：展示率、展示后采纳率、采纳后未修改率、弃权原因 Top、P50/P95 延迟只统计真实模型路径、日 token）。
- 设置页新增“近 7 天效果”卡片（显示/采纳/未修改率、弃权原因、延迟、7 天 token；刷新按钮）。
- 验证：`test/results-log.test.mjs` 6 项（含轮换、14 天清理、隐私：文件不含建议/会话/请求原文）；`test/p2-service.test.mjs` 的 O01 用例；专项脚本 `tools/batch1-verify.mjs` 在 scratch 实测 events 落盘 38 行、无原文泄漏、summary 聚合正常。

## 2. B02 上下文裁剪（`context-builder.js`）

- `extractHumanAndAssistant` 改为**按回合折叠**：同一回合工具循环里的多条助手旁白只保留最后一条；用户 steering 只保留该回合最后一条。
- `trimMessages` 重写为固定配额：最近 1 条用户消息 ≤600 字必留；更早 2 条用户消息各 ≤300 字；最终助手回答 ≤1200 字，超长按**头 30% + 尾 70%**；剩余预算才给更早助手（每条 ≤600，从近到远）；token 目标不足时按“更早助手 → 最终助手 → 更早用户”顺序压缩，**最近用户消息永不丢弃**。
- 回放验收（`tools/replay-context.mjs`，只读本机会话、不输出正文）：60 个近 2 天会话、110 个完成回合、82 个人工规模回合（用户消息 ≤1000 graphemes）：
  - 旧实现裁剪后无用户消息：**8/82（9.8%）**
  - 新实现：**0/82（0%）**
  - 证据：`scratch/evidence/replay-context.json`
- 单测：长助手头尾保留、3 条用户配额、token 极紧时仍保留最近用户、同回合助手折叠（`test/p2-context.test.mjs`）。

## 3. B03 脱敏（`context-builder.js`）

- 去掉含 `/ - _ =` 的长串规整；改为只对“长 ≥40、含大写+小写+数字”的 base64 特征串脱敏（不含路径分隔符/连字符/下划线），因此路径、`session-...`、UUID、40 位提交号、GitHub 文件网址不再被误替换；`sk-/ghp_/xox/AKIA/Bearer/key=` 等明确前缀规则保留。
- 单测：上述 4 个误伤样例保持原样；高熵 base64 串仍被替换；原有密钥/邮箱用例继续通过。

## 4. B05 手动重试（`predictor-service.js` + `budget-ledger.js`）

- 派发键加入触发方式：自动/手动各一次，手动重试不再被自动派发的账本挡住。
- 账本记录增加 `shown`/`attempt`：未展示的派发允许在重启后补发一次（最多 2 次物理尝试）；客户端 `shown` 上报后账本标记展示，后续拒绝重派；旧账本无 `shown` 字段按“已展示”保守处理。
- 未展示被回滚（`notDispatched`）时恢复被覆盖的旧记录，避免丢失原派发状态。
- 验证：`p2-ledger.test.mjs` 新增 2 个 B05 用例；`p2-service.test.mjs` 自动→手动重试用例；`tools/batch1-verify.mjs` 实测：自动 offer 后以 `trigger=manual` 再请求，`providerCalls 1→2`、`requestsReceived=2`、仍返回 offer、`sendCalls=0`。
- 注意：手动触发的 **UI 入口**属于第 4 批 O06；本批只修复 Host 逻辑，暂未加按钮/快捷键。

## 5. B09 七个小修复

| 项 | 状态 | 说明/证据 |
|---|---|---|
| B09a `budgetTimeZone` 默认取系统时区 | 完成 | `DEFAULT_CONFIG` 改为空串，`normalizeConfig` 解析为 `Intl` 系统时区；`shared.test` B09a 用例 |
| B09b engines 范围 + 0.2.2 正式版重跑 | 部分 | `engines.dsh` 改为 `>=0.2.2-rc.1 <0.3.0`；本机 DSH 仍是 `0.2.2-rc.1`（asar 内 package 版本），**正式版 P1 矩阵重跑待正式版安装** |
| B09c 移除 `dsh-composer-prediction` 残留 | **未执行（前置条件不满足）** | 计划要求“确认页面无 `window.__composerPredict` 后移除”。实际检查：desktop `package.json` 在 06:21（PLAN 写完之后）被外部改为 **bundles 含 `dsh-composer-prediction`、不含本插件**；remove 命令因 pnpm store 版本冲突失败且未改变配置。已备份 desktop `package.json`/`cordis.patch.yml` 到 `backup-desktop-profile/`，未擅自反转该外部改动；需用户确认是否按 PLAN 切回 |
| B09d 集合上限 500 | 完成 | Host：`dismissedIds/acceptedIds/dismissedTurns/releasedRequests` 有界 Set + `suggestionDispatches` 有界 Map；客户端：`servedAuto/servedManual/suppressedTurns/dismissedTurns/acceptedTurns/announced` 与结果上报去重 Map 均限 500 |
| B09e cache token 重复计费确认 | 确认不重复 | 从 asar 提取 `dsh-llm-deepseek`：`usage.totalTokens = inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens`，说明 `inputTokens` 已不含缓存；账本相加正确，已补注释与结论 |
| B09f reasoningEffort 优先 off/none/minimal | 完成 | `PREFERRED_EFFORTS` 优先 `off/none/minimal/no-thinking/disabled/low`，否则回退模型 advertised 首项；单测覆盖 |
| B09g 幽灵文字位置用实际 padding | 完成 | `measureEditor` 改用 `getComputedStyle` 的 `paddingTop/Left/Right`；P1 矩阵截图（`scratch/evidence/batch1-p1-01-ghost-visible.png`）位置正常 |

## 6. 回归与专项验证

| 项目 | 结果 | 证据 |
|---|---|---|
| `node --test` | **115/115 通过** | 命令输出（原 99 + 新增 16） |
| P1 交互矩阵（fixed-test，含窄输入框用例） | **11/11 通过** | `scratch/evidence/batch1-p1-report.json` |
| 配置开关（关闭/恢复 + Host 重启） | 通过 | `scratch/evidence/batch1-toggle-report.json` |
| P2 模型链路（mock，9 步） | **9/9 通过** | `scratch/evidence/batch1-p2-report.json` |
| B05/O01 专项（scratch，mock） | 通过 | `scratch/evidence/batch1-verify-report.json` |
| B02 回放 | 9.8% → **0%** | `scratch/evidence/replay-context.json` |

## 7. 测试污染修复（额外）

`host-plugin.test.mjs` 之前调用 `apply()` 时未隔离 `DSH_HOME`，会把测试请求写进用户真实 `~/.dsh/next-message-predictor/`。本批已把测试 `DSH_HOME` 指向临时目录（`after` 清理），并修复 `results.summary` 的延迟统计（不再把 0ms 早退计入 P50）。现有 `events.jsonl` 中测试噪声已备份到 `scratch/evidence/events-before-batch1-cleanup.jsonl` 后重置；`ledger.json` 保留（含真实 05:52 预测记录，预算消耗极小）。

## 8. 生效方式与已知遗留

- 源码与 `lib/client.js` 已更新；Host 改动在 **DSH 重启后**加载，浏览器端需刷新页面（Desktop 重启即可）。
- **桌面 profile 当前状态与 PLAN 不一致**（见 B09c）：`desktop/package.json` 现在把本插件移出 bundles、把旧插件放回 bundles，`patch` 里本插件仍 `enabled: true`。若用户重启 DSH，将加载旧插件而不是本插件。请确认后再重启；如需按 PLAN 切回：
  1. 把 `dsh-next-message-predictor` 加回 `desktop/package.json` 的 `dsh.profile.bundles`；
  2. 从 `bundles` 与 `dependencies` 移除 `dsh-composer-prediction`（pnpm store 冲突时手动编辑 package.json，无需安装）；
  3. 重启 DSH。
- 第 2 批（B01/B04/B06/B07/B08）、第 3 批（O05/O02–O04）、第 4 批（O06–O08）未开始；本批的手动重试仅有 Host 逻辑。
- 回放样本仅 60 个近 2 天会话（82 个回合）；更大人群分布需后续扩大。
- O01 汇总使用 `~/.dsh` 共享目录；桌面与 scratch 会混合计数（本次已重置测试噪声）。
