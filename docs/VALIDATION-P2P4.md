# P2–P4 验证记录（模型链路 / 评测 / 本机试用）

本文件是 P0/P1 之后的验证记录，配套 `docs/VALIDATION.md`（P1 交互矩阵）与 `docs/COMPATIBILITY.md`（P0 契约矩阵）。

环境：DSH `0.2.2-rc.1` 的隔离 `predictor-scratch` profile；Web GUI `127.0.0.1:3090`；本地 OpenAI 兼容 mock provider `127.0.0.1:3091`（确定性、零成本）；真实模型路由 `deepseek-official/deepseek-flash`（仅在 P3 评测与 P4 试用阶段使用）。所有结果均来自实际运行，命令见各节。

## 1. P2 生成链路（真实 `ctx.llm` 层 + mock provider）

脚本：`tools/p2-e2e.mjs`；证据：`scratch/evidence/p2r-report.json`（复测）、`p2-report.json`（首次）。

通过步骤（9/9）：

| 步骤 | 断言 | 结果 |
|---|---|---|
| initial | `mode=model`、路由 `mock/mock-1`、prompt 版本 `nmp-p2-v2`、manifest/ledger 可读 | 通过 |
| model-ghost | 完成回合后 Host 读权威上下文（`sessionQuery.readSurface`，2 条消息、估算 577–1887 tokens）→ 一次模型调用 → 严格 JSON → ghost 上屏（文本来自模型 JSON） | 通过 |
| evidence | Host diagnostics `providerCalls/contextBuilds/offers/inputTokens` 均增长；`<DSH_HOME>/next-message-predictor/ledger.json` 写入派发记录与当日 token 用量 | 通过 |
| tab-adopt | Tab 把建议完整写入草稿；`accepted`；采纳后 1.2s 内无 `session/prompt` HTTP 请求与 WebSocket 帧；`sendCalls=0` | 通过 |
| undo | Ctrl+Z 清空插入且不复活建议 | 通过 |
| invalid-json | mock 返回非法 JSON → `outputRejects` 增长、无 ghost、不重试 | 通过 |
| timeout | mock 5s 慢响应 + `timeoutMs=1000` → 1024ms 后 `finish-aborted:ABORTED` 弃权；mock 只收到 1 次预测请求（无自动重试） | 通过 |
| budget-exhausted | `dailyRequestLimit=1` 时预算拒绝：不调用模型、无 ghost、`unavailable` 有 retryAfter | 通过 |
| restore | 恢复默认配置成功（`mode=model`） | 通过 |

关键数据（复测一轮）：`providerCalls=3`、`contextBuilds=3`、`offers=2`、`outputRejects=1`、`inputTokens=24`、`outputTokens=6`、`sendCalls=0`；ledger 记录 3 次派发，token 与 usage 对应。

实现要点（已写入代码）：

- Host 只读当前分支：`ctx.sessionQuery.readSurface(sessionId)`（live 优先/冷会话可读），要求 `capturedThroughSeq === anchor.completedEventSeq`；回退 `ctx.sessions.get(id).deriveMessages()`。
- 上下文按 `source.kind` 过滤（人类=`user`、助手=`model`），只取 text block；脱敏凭据/邮箱/长 opaque 串；条数/码点/估算 token 三重上限，截断显式标记。
- 一次辅助调用：`ctx.llm.prepareCall` + `stream`，不传 `sessionId`/`tools`，`reasoningEffort` 只传模型 advertised 的首个档位（或用户显式配置且被支持）；超时用 `AbortSignal.timeout` 与外部取消合并；`finish.kind !== 'stop'` 一律弃权；直连调用无自动重试（P0 已核实）。
- 预算与派发账本：派发前先写 `<DSH_HOME>/next-message-predictor/ledger.json`（24h 派发标记 + 按配置时区的日预算，原子写）；写失败不派发；usage 缺失按保守预留计 unknown；不承诺精确一次计费。
- 输出验收：完整 JSON、唯一字段 `suggestion`（string|null）、单行/无控制字符/无 HTML/协议标记、≤160 grapheme、≤4096 字节；失败弃权，不做“取第一行/剥引号/截断”式修复。

## 2. P3 质量与成本评测（真实模型）

脚本：`eval/generate-fixtures.mjs`（120 条去标识合成样本）+ `eval/evaluate.mjs` + `eval/merge-reports.mjs`；证据：`eval/fixtures.deidentified.jsonl`、`eval/report-p3-final.json` / `.md`、`eval/report-p3-dev-v3.json`、`eval/report-p3-holdout.json`。

- 样本：12 类场景 × 10 变体 = 120 条独立对话；dev 60 / holdout 60；应弃权 20 条、either 10 条、应预测 90 条。全部为合成数据，不含用户历史。
- 模型：`deepseek-official / deepseek-flash`；提示词 `nmp-p2-v2`（冻结后先跑 dev、再跑 holdout，同为该版本）。
- 汇总（自动指标）：

| 指标 | all | dev | holdout |
|---|---:|---:|---:|
| 应预测覆盖率 % | 100 | 100 | 100 |
| 应弃权严格弃权率 %（仅 suggestion:null） | 35 | 30 | 40 |
| 应弃权可接受率 %（弃权或询问细节且不违规） | 95 | 90 | 100 |
| 命中 forbid 规则的违规建议数 | 1 | 1 | 0 |
| 结构非法率 % | 0 | 0 | 0 |
| 非 stop finish 率 % | 0 | 0 | 0 |
| 启发式可接受率 %（辅助，非人工） | 99.1 | 98.2 | 100 |
| 延迟 P50 / P95 ms | 1652 / 2206 | 1590 / 2165 | 1681 / 2206 |
| token 用量（input/output/reasoning） | 27475 / 1827 / 0 | 13813 / 904 / 0 | 13662 / 923 / 0 |

- **结论边界**：以上均为自动指标；合成样本覆盖面有限，覆盖率偏高不代表真实分布；`abstainAcceptable` 的“询问细节”判定依赖 forbid 关键词表，存在漏检（holdout 有 1 例“替用户定预算”的建议未命中规则）。
- 评测过程中发现并修复：提示词 v2 增加“选项不明确只能问细节、不得表态/选择”和“任务结束不得制造新任务”；样本期望按方案口径修正（任务结束追问细节可接受、约束场景查看 diff 合法）；新增 forbid 违规检测。真实模型仍存在“协商式替用户表态”的边界，列入 P4/后续改进。

## 3. P4 本机试用（隔离 profile + 真实模型）

脚本：`tools/p4-real-e2e.mjs`；证据：`scratch/evidence/p4-report.json`、`p4-01-offer-adopted.png`。

- 切换方式：仅修改 scratch profile patch 的 `agent-default-model` 为 `deepseek-official/deepseek-flash` 并重启，未触碰 desktop/web/headless。
- 结果：真实回合完成后，Host 读取上下文（2 条消息、估算 1887 tokens）、调用真实模型（1590–1741ms）→ 给出上下文相关建议：  
  **“我用的是 Java Spring Boot + K8s，能给份具体的采集清单和指标项吗？”**（模型 JSON 输出经严格解析）。
- Tab 采纳进入草稿、Ctrl+Z 撤销均通过；采纳窗口内无 prompt 请求/帧，`sendCalls=0`。
- 真实模型首轮在“只回复：收到”这种无上下文对话中选择合法弃权（`model-abstained`），改为有上下文的对话后正常给建议；说明弃权路径在真实模型下有效。
- 验证后已把 scratch profile 恢复为 mock 路由，避免无意消耗真实额度。

## 4. 复测记录

| 项目 | 结果 | 证据 |
|---|---|---|
| `node --test`（共享/Host/Client/P2） | **90 项全部通过** | 命令输出 |
| P1 交互矩阵（fixed-test，复测） | 10/10 通过 | `scratch/evidence/p1final-report.json` |
| P1 矩阵（P2 model 模式下） | 10/10 通过 | `scratch/evidence/p1r-report.json` |
| 配置开关（关闭/恢复，含 Host 重启） | 通过 | `scratch/evidence/config-toggle-final-report.json` |
| P2 模型链路矩阵（mock provider） | 9/9 通过 | `scratch/evidence/p2r-report.json` |
| 卸载清理（remove + 重启） | 通过（无 anchor/ghost/global、路由 404） | `scratch/evidence/uninstall-final-report.json` |
| P3 评测（dev+holdout，真实模型） | 完成，自动指标见上 | `eval/report-p3-final.md` |
| P4 真实模型试用 | 通过（建议上屏 + 采纳/撤销 + 零发送） | `scratch/evidence/p4-report.json` |

复测中发现并修复的真实 bug：

1. **上下文事件结构错误**：`assistant/message` 事件的 `source` 在 `data.message.source`，初版读 `data.source` 导致助手文本被过滤 → `no-final-assistant-text` 弃权。修复并用真实事件形状补单测。
2. **真实模型下的完成触发竞态**：`session.running` 先变 false、chat 投影（`turnId/turnEnds`）后更新时，初版“上一帧 running=true”触发逻辑会消费锚点、导致新回合不预测。修复为“running 进入回合时记录锚点，等待观察到 turnId 变化后再触发，5s 超时清理”，并新增竞态单测。
3. **P3 样本期望/提示词问题**：见 §2；提示词升级为 `nmp-p2-v2`。
4. **评测脚本环境问题**：评测 host 插件单独安装、只在 scratch profile；评测运行器的编码/正则问题已修复。

## 5. 已知限制（P2–P4）

- 客户端仍无法看到 `turn/end.reason.kind`；最终完成判定在客户端是“running→idle + chat 投影新回合”，Host 侧上下文读取时用 `capturedThroughSeq === completedEventSeq` 做校验，但未做完整的 `reason.kind` 复核（P2+ 可在 Host `session/event` 维护完成回合表后补齐）。
- 无窗口/view 身份：`viewId` 不可信，跨窗口共享等待者与 BroadcastChannel 同步未实现。
- 无文本 token 价格 API：只报告 usage，不估金额。
- 派发账本为单进程原子写，多实例共享 `$DSH_HOME` 时无跨进程锁（最坏为后写覆盖）。
- `Config` schema 未引入（linked 插件无法解析 schemastery/zod）；设置写入经 `configEditor.edit` 会重启 Host 插件；`reasoningEffort` 默认取模型 advertised 首档，不保证是所有提供商语义上的“最低”。
- 合成评测样本不代表真实分布；真实模型的“协商式替用户表态”仍是质量风险。
- Desktop 原生窗口的输入法/快捷键、Web 与 Desktop 双端分别验收未做。
- 自然使用观察需 3–7 天，本轮只能完成隔离 profile 的端到端试用，不能宣称“自然对话稳定”。
