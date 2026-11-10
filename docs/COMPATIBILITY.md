# P0 契约确认：DSH 0.2.2-rc.1 兼容矩阵

本文件是 P0 阶段的交付物。目标版本为 **DSH Desktop/Web 0.2.2-rc.1**（Electron 安装包，下称 `<DSH 安装目录>`，asar 内 `dsh/package.json` 与 `@deepseek-ai/dsh` 均为 `0.2.2-rc.1`）。采集环境：Windows 11，America/Chicago，2026-11-09。

证据分三类，下文用前缀标注：

- **[H]** `docs/p0-host-contract.md`（Host 侧契约，61 处 archive `path:line` 引用）
- **[C]** `docs/p0-client-contract.md`（Client/编辑器契约，archive `path:line` 引用）
- **[L]** `docs/p0-load-verification.md`（scratch profile 中的最小 Host/Client 装载实测）
- **[R]** 本仓库实现与 `test/` 单测、`scratch/evidence/` 实测证据

本方案的“能力适配层”是本插件自己定义的语义接口，不是 DSH 已提供的同名 API。下表中的“确认”只表示 DSH 提供了足够的底层能力把它实现出来；具体语义仍由本插件适配层负责。

## 1. 结论摘要

| 方案要求 | 状态 | 结论 |
|---|---|---|
| 展示入口 `conversation.input.overlay` | 确认 | list/session slot，声明于 `conversation.composer.bar`；条目渲染在 `[data-composer-overlay]` 内（`[C]`） |
| 原生安全插入（非 setDraft） | 确认 | `captureInsertion()` + `insertText(text, span)`，同步布尔返回、独立 undo 单元、`draftRev` 校验（`[C]`） |
| Tab/Esc 手势 | 确认（有上游变更风险） | 无 composer keymap 的插件钩子；document capture 后自行 gating 是唯一可行路径（`[C]`） |
| IME | 确认 | `[data-composer-input][data-composer-composing]` + `isComposing`/`keyCode 229`（`[C]`） |
| 菜单/结构化交互避让 | 部分确认 | `/` `@` 菜单有 `[data-trigger-menu]`；command-popup、feedback-dialog 无稳定标记，用焦点/模态启发式并 fail-open；approval/question/plan 通过 `useSessionStatus.pendingInteraction` 且通常 takeover 掉 composer（`[C]`） |
| Host 读取权威会话 | 确认（P2 已实现） | live `ctx.sessions.get(id)`；当前分支用 `ctx.sessionQuery.readSurface`；**禁用**已弃用的 `eventAt/snapshotEvents/ownEvents`（`[H]`） |
| 回合完成事件 | 确认（P2 部分实现） | `ctx.on('session/event', …)` 的 `turn/end` 且 `reason.kind === 'completed'`，post-commit 同步；**不用** `agent/turn-stopping`（会被 await，推迟 turn/end）（`[H]`）。P2 客户端触发为 running→idle + chat 投影变化，Host 读上下文时校验 `capturedThroughSeq`；完整 reason 复核列为后续项 |
| Host 独立模型调用 | 确认（P2 已实现） | `ctx.llm.prepareCall` + `stream`；直连调用**不会自动重试**（`dsh-llm-retry` 只挂 agent 请求错误链）（`[H]`）；超时/取消/finish 非 stop 均弃权 |
| 模型路由/推理档位 | 部分确认（已实现最低档位策略） | 路由来自已配置 provider/model 或 `agentDefaultModel.currentSelection()`；`reasoningEffort` 只传模型 advertised 档位（默认首项，可显式配置且必须被支持）；不保证跨提供商语义上的“最低”（`[H]`） |
| Token 价格/费用估算 | 不满足 | 无文本 token 价格 API（只有图片定价）；只能显示用量，不估算金额（`[H]`） |
| 原生 Config 表单 + volatile 热更新 | 部分满足 | 可用 schemastery `Config` + `.extra('volatile', true)`；但本插件当前不导出 Config（依赖解析风险，见 §5）；设置写入走 `configEditor.edit`（会重启插件） |
| 请求体 8 KiB 上限 | 确认 | 路由必须用 `requestBody:'streaming'` 自行限量读取；buffered 模式受宿主全局上限（默认 300 MiB）影响（`[H]`） |
| 路由认证/owner | 确认 | `/api` 链由宿主统一做 Host/Origin 栅栏、浏览器认证与 exact-route owner-only（403）；插件 handler 拿不到 peer/window 身份（`[H]`） |
| 跨窗口去重 | 部分满足 | 宿主无 view/window 身份，`viewId` 不可信；跨窗口同步只能客户端辅助（BroadcastChannel）+ Host 结果缓存/账本去重，P1 未实现多窗口 |
| branchEpoch / contextRevision 原语 | 不满足（需构造） | 无现成原语；锚点用 `sessionId + turn/end.seq (+ surface replaceGeneration / capturedThroughSeq)` 构造，fork/rollback 是新的 session（`[H]`） |
| 持久化账本/预算 | 确认（P2 使用） | base bundle 已挂 storage/storage-json/storage-domain（`<DSH_HOME>/storages`），或参考插件自管 `<DSH_HOME>/<name>.json`（tmp+rename）；P1 仅内存实现 |
| Web 端验收 | 未开始 | 本阶段在独立 scratch profile 的 Web GUI 上做 P1 交互验证；Desktop 原生窗口的输入法/快捷键仍需单独验收 |

## 2. Host 契约矩阵

| 能力 | 精确 API | 证据 | 状态 |
|---|---|---|---|
| 插件装载 | loader entry（`cordis.patch.yml` insert 行）+ `export function apply(ctx, config)` | `[H] §1`；`[L]` | 确认 |
| 插件配置 schema | `export const Config = z.object({...})`（schemastery），仅 `.extra('volatile', true)` 字段可进设置页，`config.field.get()` 读取 | `[H] §3` | 确认（本插件 P1 暂未采用，见 §5） |
| 配置持久化 | `ctx.fiber.entry` + `ctx.get('configEditor').edit(entry, (current, inherited) => next)`；自带校验/CAS/串行化；普通字段改动会重启插件 | `[H] §3`；`[R] src/host/dsh-adapter.js` | 确认 |
| 配置变更事件 | `settings/document-updated(ns, revision)` | `[H] §3` | 确认 |
| 会话存储 | `ctx.sessions.get(id)`、`ctx.sessions.list()`；`session.seq`；`session.deriveMessages()` | `[H] §2` | 确认 |
| 冷会话/当前分支读取 | `ctx.sessionQuery.readSession/readSurface`（live 优先，cold OK） | `[H] §2` | 确认（P2 使用） |
| 会话事件 | `ctx.on('session/event', (session, event) => …)`，post-commit、同步 | `[H] §2` | 确认（P2 使用） |
| `turn/end` 形状 | `event.type === 'turn/end'`，`event.data.reason.kind`（completed/error/aborted/interrupted/max-tokens） | `[H] §2` | 确认（P2 使用） |
| 消息来源判别 | `source.kind`：人类=`user`（含 user-rpc），助手=`model`；排除 runtime-context/model-selection/tool/goal/team/webhook 等 | `[H] §2` | 确认（P2 使用） |
| HTTP 路由 | `ctx.connection.fetch.register({path:'/api/<seg>', methods:['POST'], requestBody:'streaming', fetch})` | `[H] §4` | 确认；本插件 P1 已用 |
| 路由认证/owner | 宿主统一 Host/Origin + 浏览器认证 + owner-only；handler 仅拿到 `Request` | `[H] §4` | 确认 |
| 请求体限制 | buffered 默认全局 300 MiB；插件自限需 streaming 模式 | `[H] §4`；`[R] src/host/dsh-adapter.js` | 确认；本插件用 streaming + 8 KiB 自限 |
| LLM 调用 | `ctx.llm.stream(GenerateOptions)`（provider/model/messages/system/maxTokens/reasoningEffort/temperature/stop/signal） | `[H] §5` | 确认（P2 使用） |
| 取消 | `GenerateOptions.signal`，abort 以 `aborted` finish 结束 | `[H] §5` | 确认（P2 使用） |
| 自动重试 | 直连 `ctx.llm.stream` 无自动重试；`dsh-llm-retry` 只挂 `agent/request-error` | `[H] §5` | 确认（无需 per-call 关闭） |
| 默认模型路由 | `ctx.agentDefaultModel.currentSelection()` | `[H] §5` | 确认 |
| 用量回报 | usage chunk 先于 terminal finish；有 usage 则有 token 数 | `[H] §5` | 确认（P2 使用） |
| 文本 token 价格 | 无 API | `[H] §7` | 不满足 → 只显示用量 |
| 持久化 | `ctx.storageDomain`（`<DSH_HOME>/storages`）或插件自管 JSON | `[H] §6` | 确认（P2 使用）；P1 仅内存 |
| 窗口/view 身份 | 无 | `[H] §7` | 不满足 → viewId 仅作提示，去重以 Host 共享缓存/账本为准 |
| branch/context revision 原语 | 无 | `[H] §7` | 不满足 → 适配层构造 |
| 路由 peer/principal | handler 无 peer | `[H] §7` | 不满足 → 权限依赖宿主 owner-only |

## 3. Client / 编辑器契约矩阵

| 能力 | 精确 API | 证据 | 状态 |
|---|---|---|---|
| overlay slot | `ctx.slots.inject('conversation.input.overlay', () => ctx.slots.register({name, id, order, locale}, Component))` | `[C] §2` | 确认 |
| slot 标准 props | `sessionId, useSession, useSessions, useSessionStatus, useProjection, useAccess, useConversation, useInput, inputActions, useChat` + locale `t` | `[C] §2` | 确认 |
| `InputState` | `{draft, attachmentIds, draftRev, phase, claim?, occurrences, queue}`；phase=`plain/claimed/adjudicating/submitting/sending` | `[C] §3.1` | 确认 |
| `InputActions.captureInsertion` | `() => {start, end, draftRev}`，同步 | `[C] §3.2` | 确认 |
| `InputActions.insertText` | `(text, span) => boolean`；frozen/disposed/draftRev 不匹配时 false；`paste` tag 独立 undo 单元 | `[C] §3.2` | 确认（undo 独立性待 E2E 实测） |
| `setDraft` | 存在但**不用于采纳**（整段替换破坏引用/撤销语义） | `[C] §3.2` | 确认 |
| `submit()` | 存在但**不得调用**（本插件零发送） | `[C] §3.2` | 确认 |
| 语义为空 | `draft==='' && attachments=0 && occurrences=0 && queue=0 && phase==='plain' && !claim`（空白字符也算内容） | `[C] §3.3` | 确认规则 |
| `canEdit` | `!frozen(phase)` + session `!removed` + subagent 非 one-shot；DOM `aria-disabled` 辅助 | `[C] §3.3` | 部分（组合派生） |
| 焦点 | `document.activeElement === card.querySelector('[data-composer-input]')` | `[C] §3.3` | 部分（DOM 派生） |
| IME | `[data-composer-input][data-composer-composing]` + `event.isComposing`/`keyCode 229` | `[C] §3.3/§5` | 确认 |
| 菜单/面板 | `/` `@`：`[data-trigger-menu]`；command-popup/feedback-dialog 无稳定 marker；approval/question/plan：`useSessionStatus.pendingInteraction` | `[C] §5` | 部分，采用保守守卫 + fail-open |
| 回合完成（客户端） | `useChat.legacy.nodes` + `turnEnds Map<turn, turn/end seq>`；排除 `interrupted`、`turn-error`、`turn-max-tokens` | `[C] §6.4` | 部分；`turn/end.reason.kind` 不可见 → Host 复核（P2） |
| 键盘仲裁 | 无插件 keymap 钩子；document capture + 自有 card gating；成功后 `preventDefault+stopPropagation` | `[C] §7` | 确认（上游变更风险） |
| 占位符隐藏 | `[data-composer-placeholder]`，保存并恢复 inline `visibility` | `[C] §4` | 确认 |
| 几何测量 | `[data-composer-input]` rect + computed font；ResizeObserver + resize/scroll | `[C] §4` | 确认 |
| 客户端捆绑格式 | `window.__ModuleLoader__.load({id, factory})`；`dsh.client {platform:'web', inject, external?, immediately?}` | `[C] §9` | 确认 |
| 客户端 RPC | 同源 `fetch('/api/...')`（cookie 认证）或 `ctx.connection.rpc.call` | `[C] §9.4` | 确认；本插件用同源 fetch |
| 卸载/HMR 清理 | `ctx.effect` / 组件 `useEffect` 清理；module 系统在 effects drain 后驱逐 | `[C] §9.5` | 确认（E2E 验证） |

## 4. 当前阶段（P0–P4）采用与暂缓的能力

P0–P4 已实现：overlay slot、`captureInsertion`+`insertText`、`[data-composer-placeholder]`、`[data-composer-composing]`、`[data-trigger-menu]` 守卫、`useSessionStatus.pendingInteraction` 守卫、`useChat.legacy` 回合识别 + 真实模型竞态修复、同源 fetch 路由、`configEditor.edit` 配置写入、streaming 路由 + 8 KiB 自限、`ctx.sessions.get` 会话存在性校验、`sessionQuery.readSurface` 权威上下文、`ctx.llm` 一次辅助调用（不重试/超时/取消/usage）、严格 JSON 输出校验、持久派发账本与日预算、模型路由设置、P3 评测 runner 与 120 条去标识样本。

暂缓/后续：

1. Host 侧 `turn/end.reason.kind` 权威完成表（当前客户端用 running→idle + chat 投影变化，Host 仅在读上下文时校验 `capturedThroughSeq`）。
2. 原生 `Config` schema 与 volatile 热更新（linked 插件无法解析 schemastery/zod；当前设置写入会重启 Host）。
3. 多窗口/多标签共享等待者与 BroadcastChannel 同步；跨进程账本锁。
4. Desktop 原生窗口验收；与既有预测插件的运行时冲突检测。
5. 自然使用观察（见 `docs/RELEASE.md`）。

## 5. 无法满足/需降级的能力（P0 结论）

| 能力 | 状态 | 降级方式 |
|---|---|---|
| Host 窗口/view 身份 | 不满足 | `viewId` 仅作关联，不能当权限/去重凭据；同回合去重以 Host 缓存 + 账本键为准 |
| branchEpoch/contextRevision 原语 | 不满足 | 适配层用 `sessionId + turn/end.seq (+ content/replaceGeneration)` 构造；fork/rollback 视为新 session |
| 文本 token 价格与金额估算 | 不满足 | 只显示 token/请求用量；不显示金额 |
| 冷会话授权与 branch 复核（fetch 路由层） | 部分 | P1 用 `ctx.sessions.get` 只校验 live 会话；冷会话标记 `session-unverified` 诊断；P2 用 `readSurface` 强制校验，失败即拒 |
| 客户端 `turn/end.reason.kind` | 不满足 | 客户端只排除 derived failure 行；P2 Host 复核后才允许调用模型 |
| command-popup / feedback-dialog 稳定 DOM 标记 | 部分 | 焦点/模态启发式 + fail-open；E2E 覆盖 `/` `@` 菜单与设置模态 |
| 原生 Config volatile 热更新 | 暂缓 | P1 设置写入触发插件重启；文档标注，P2 引入 `Config`（需 smoke-test `@deepseek-ai/schemastery` 依赖解析） |
| 跨设备/跨窗口即时状态一致 | 不满足 | 仅承诺单视图；多窗口在 P2 用 BroadcastChannel 加速 + Host 状态为权威 |
| 8 KiB 请求体在框架层的硬保证 | 部分 | 本插件用 streaming 自限并在超限时 413；宿主全局缓冲上限仍存在（插件无法改变） |
| Desktop 原生窗口输入法/快捷键 | 未验证 | 本阶段只用 Web GUI（独立 scratch profile）；Desktop 验收列为 P1 后续项 |

## 6. 版本策略

- 只声明并测试 **0.2.2-rc.1**（`package.json` `engines.dsh`）。
- 不写宽泛 `>=0.2`；升级前需重跑 `docs/VALIDATION.md` 的 P1 矩阵。
- 缺少 overlay / `captureInsertion`+`insertText` / 认证路由时：客户端显示“不支持当前版本”并停用，不退回修改编辑器 DOM 或 `setDraft`。

## 7. 最小 Host/Client 装载

见 `[L] docs/p0-load-verification.md`：独立 `predictor-scratch` profile（从 shipped web 模板创建，不修改 desktop/web/headless），安装最小 bundle 与本插件后，实测确认：

- Host 日志：`[next-message-predictor] host ready: route=/api/next-message-predictor/rpc enabled=false provider=fixed-test-suggestion`（首次装载为默认关闭；P1 E2E 时 seed 为 enabled=true，日志同样出现 ready 行）。
- `dsh --profile predictor-scratch --dump-config` 可见 `next-message-predictor` 行与 patch 的配置覆盖。
- 页面 `__DSH_BOOT__` 条目含 `dsh-next-message-predictor`（rev 随 bundle 变化）；`window.__nextMessagePredictor` 版本 `0.1.0-p0p1`。
- `[data-nmp-anchor]` 位于 `[data-composer-overlay]` 内，slot `conversation.input.overlay` 活跃。
- 页内 `POST /api/next-message-predictor/rpc {operation:"status"}` 返回 `{ok:true, value:{capabilities:{connectionFetch:true, configEditor:true, sessionStore:true, agentRegistry:true}}}`。
- 装载期发现的真实契约问题：插件包主入口若同时有 named exports 和 `default`，loader 会执行 `exports = exports.default ?? exports`，named `inject` 会被丢弃；因此本插件把 `apply`/`inject` 同时放进 default 对象（见 `src/host/index.js` 末尾注释）。这也是 P0 装载验证的直接产出。

P1 的编辑器交互结果见 `docs/VALIDATION.md`（矩阵 10/10、配置开关、卸载清理、零发送审计）。
