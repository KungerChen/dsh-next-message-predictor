# P0 Host 侧契约档案（dsh-next-message-predictor）

目标版本：DSH Desktop **0.2.2-rc.1**（安装包内 `dsh/package.json` 与 `dsh/node_modules/@deepseek-ai/dsh/package.json` 均为 0.2.2-rc.1）。
采集时间：2026-11-09（America/Chicago）。范围：**Host 半边**（Node/loader 插件）；Client 半边由另一份档案负责。
本文件只记录实测/源码证据，不把推测写成事实；每条给出状态：`confirmed` / `partial` / `unsatisfied`。
配套：`DSH预测消息插件优化完整方案.md`（下称"方案"）；本文件对方案第十四节的行号逐条核对，并补充方案未覆盖的契约。

## 0. 证据记号与资料来源

| 记号 | 含义 |
|---|---|
| `A:<pkg>/<path>:<line>` | 安装包内文件：`<DSH 安装目录>\resources\app.asar\dsh\node_modules\@deepseek-ai\<pkg>\<path>` 的第 `<line>` 行。行号对照 asar 原文核对；`.dsh-recon\dsh\node_modules\@deepseek-ai\...` 是同一批字节的只读镜像（仅部分文件被提取）。 |
| `I:<provider>/<method>` | 运行时 Inspect 查询的返回（Host 侧 Service/Event/Config 的精确签名/类型）。asar 里没有独立行号，但它是当前进程实际加载的契约。 |
| `P:<path>` | profile 安装产物：`<DSH_HOME>\profiles\desktop\...`（参考实现 `dsh-composer-prediction@0.7.8`、`dsh-context@0.83.0`、`qq-mode-console`）。 |
| `R:<pkg>/README.md` | 安装包内 README（和 asar 同一来源）。 |

已实测确认的关键结论（详见正文）：

1. Host 插件读会话的**新生产路径**是 `ctx.sessions`（仅 live）与 `ctx.sessionQuery`（live 优先、可读冷会话）；`Session.eventAt()/snapshotEvents()/ownEvents()` 已被**明令弃用**。
2. `ctx.on('session/event', (session, event) => …)` 可用，回调 **post-commit 且同步**；`turn/end` 是该 feed 里可直接观察的回合完成事实，**不要**用 `agent/turn-stopping` 等待（它排在 `turn/end` 之前且被 `await`）。
3. 原生设置的真实机制是 **loader entry 的 `Config` + schemastery `volatile` 字段**；0.2.2 没有 `ctx.settings.register()`；设置命名空间 = loader entry id；字段必须 volatile 才能在设置页编辑，读取用 `config.field.get()`。
4. 插件 HTTP 只应使用 `ctx.connection.fetch.register({path, methods, requestBody, fetch})`：路径必须 `/api/<segment>[...]`，Host 已统一做 Host/Origin 栅栏、浏览器认证，并对 exact fetch route 强制 **owner-only**；handler 拿不到 peer/窗口身份；buffered 模式由宿主最多缓冲 `maxRequestBodyBytes`（默认 300 MiB），8 KiB 上限只能靠 `requestBody:'streaming'` 自限读取。
5. `ctx.llm.stream(options)` 的直连调用**不会被自动重试**：llm 服务明确"never re-runs a request"，唯一的重试插件 `dsh-llm-retry` 只挂 `agent/request-error`（agent 主循环扩展点）。因此"为本次辅助调用禁用重试"无需开关，默认就是 ≤1 次物理尝试。
6. 没有文本 token 的计费/价格 API（只有 `imageRequestPricing`），成本只能按 `TokenUsage` 展示；token 估算可借 `ctx.tokenMeter`（启发式）。
7. 插件私有持久化没有"插件专属目录"API；原生可用 `ctx.storageDomain`（JSON/sqlite backend，路径 `<DSH_HOME>/storages`），或像参考插件那样自管 `<DSH_HOME>/<name>.json`（临时文件 + rename）。

---

## 1. 会话访问、事件读取与上下文提取

### 1.1 访问矩阵

| 能力 | 精确 API | 证据 | 状态 |
|---|---|---|---|
| 取活跃会话（权威内存日志） | `ctx.sessions.get(id: SessionId): Session \| undefined` | `I:Service/sessions`；`A:dsh-session/lib/index.js:1326`（`var Session = class Session`），`:1346`（`get id()`） | confirmed |
| 列活跃会话 | `ctx.sessions.list(): Session[]`（新数组） | `I:Service/sessions` | confirmed |
| 读冷会话（不使其 live） | `ctx.sessionQuery.readSession(sessionId): Promise<SessionLogSnapshot>`，返回 `{session: SessionHeader, inheritedEventCount, events: SessionEvent[]}` | `I:Service/sessionQuery`；`R:dsh-session-query/README.md:35`（"complete replay-validated raw event log, without making the session live"） | confirmed |
| 读"当前分支/当前模型面"（推荐做上下文） | `ctx.sessionQuery.readSurface(sessionId): Promise<SessionSurfaceSnapshot>`，返回 `{session, inheritedEventCount, capturedThroughSeq, events: SurfaceEvent[]}` | `I:Service/sessionQuery`；`R:dsh-session-query/README.md:39,84,114`（"one canonical surface fold … classifies events as current/shadowed/log-only"） | confirmed |
| live 优先的带 revision 观察 | `ctx.sessionQuery.observeSession(sessionId, options?): Promise<SessionObservation>`，`{source:'live'\|'prepared', header, inheritedEventCount, events, cursor, revision?, projections?}` | `I:Service/sessionQuery`；`R:dsh-session-query/README.md:81,106,110` | confirmed |
| 会话日志长度（live） | `session.seq: SessionLogOffset`（日志事件数、非最后 seq） | `A:dsh-session/lib/index.js:1479`（`get seq()`）；`A:dsh-session/README.md:64`（"session.seq reads the current log length"） | confirmed |
| **已弃用、禁止新代码使用** | `session.eventAt(seq)` / `session.snapshotEvents(...)` / `session.ownEvents()` | `R:dsh-session/README.md:64`："…are deprecated: existing logic may remain unmigrated for now, but new production calls are prohibited." | confirmed（禁用的证据） |
| 取 live Agent（仅用于存活判断） | `ctx.agents.get(id: SessionId): Agent \| undefined`；`Agent` 公开类型只有 `{ readonly id: SessionId }` | `I:Service/agents`；`R:dsh-agent/README.md:134`（"ctx.agents.get(id) still returns a bare Agent — the handle is exposed only to the consumer that created it"） | confirmed（**不要**把 `.session` 当公开 API） |
| 回合/步骤边界投影 | `ctx.agents.turnBoundaryOf(session): TurnBoundaryProjection` = `{openTurnStartSeq, lastStepStartSeq, lastStepBoundary:{kind:'start'\|'end',seq}\|null, lastTurn}` | `I:Service/agents`；`A:dsh-agent/lib/index.js:45,486-489` | confirmed |
| 耐久性屏障（一般不需要） | `ctx.sessions.flush(session): Promise<boolean>` | `I:Service/sessions` | confirmed |

**Host 访问控制说明（方案"Host 校验 session 归属和可访问性"）**：Host 插件运行在信任域内，`ctx.sessions` / `ctx.sessionQuery` 本身**没有** per-principal 过滤。对浏览器侧的唯一实际边界是：插件路由由 Host 强制 owner-only（见 §4），因此可达本路由的调用者都是 owner。若未来支持共享会话，插件路由拿不到 peer/principal（§4），不能自行做非 owner 授权 → 该需求当前 `partial`。

### 1.2 可读的会话事件（`SessionEventMap` 摘要，逐字来自运行时契约）

`I:Service/sessions` 的 `SessionEventMap` 与 `A:dsh-session/lib/index.js` 一致：

```ts
'turn/start': { turn: number }
'turn/end': { turn: number; reason: TurnEndReason }
'step/start': { turn: number; step: number }
'step/end':   { turn: number; step: number }
'user/message': UserMessage                      // 事件 data 就是消息本体
'developer/message': { turn; step; message: DeveloperMessage; headerSeq?: SessionSeq }
'system/message':    { turn; step; message: SystemMessage }
'assistant/message': { turn; step; message: AssistantMessage;
                       stream: AssistantStreamRecord[]; usage?: TokenUsage; interrupted?: true }
'assistant/attempt': { turn; step; stream: AssistantStreamRecord[] }   // 仅日志/诊断，不进模型面
'tool/call':  { turn; step; callId; name; arguments }
'tool/result':{ turn; step; message: ToolResultMessage; error?; meta? }
'request/header': { header: EpochHeader; reason: 'initial'|'resume'|'change'|'series'; startsSeries?: true }
'request/context': RequestContext
```

`TurnEndReasonMap`（回合完成判定的唯一权威）：

```ts
completed: { kind:'completed' }
aborted:   { kind:'aborted'; reason: TurnEndCancelCause }
blocked:   { kind:'blocked' }
error:     { kind:'error'; error: LlmFailure }
'max-tokens': { kind:'max-tokens' }
interrupted:  { kind:'interrupted' }
forked:       { kind:'forked' }
```

方案 5.1 的自动触发条件"`turn/end.reason.kind === 'completed'` 且有最终助手文本"可**原样**实现（见 §2）。

### 1.3 人类消息 vs runtime-context / tool / synthetic 的来源判别

**唯一正确做法：看消息的 `source.kind`，不要只看 `role`，不要用文本正则。**

`MessageBase`：`readonly id: MessageId; readonly content: readonly ContentBlock[]; readonly source: MessageSource`（`A:dsh-llm/lib/typert.host.js:480`）。
`MessageSourceMap` 的全部成员（逐字，`A:dsh-llm/lib/typert.host.js:496`，压缩成表格）：

| `source.kind` | 含义 | 预测上下文是否采用 |
|---|---|---|
| `'user'` | 用户消息（含 `user-rpc` 变体，后者带 `rpcId/clientTimeZone/principal`；同一 kind 值） | **是**（人类输入） |
| `'model'` | 助手消息（`ModelMessageSource`，带 provider/model） | **是**（只取 text block） |
| `'runtime-context'` | 宿主注入的运行时上下文 | 否 |
| `'model-selection'`, `'action-cards'`, `'tool-registry'`, `'working-directory'`, `'user-approval'`, `'skill-invocation'`, `'ptc-mode'`, `'compact-checkpoint'`, `'cordis-host-runner'`, `'user-question-reply'`, `'plan-mode'`, `'schedule'` | 系统/注入/结构化交互 | 否 |
| `'agent-message'`, `'subagent-settled'`, `'team-message'`, `'goal'`, `'webhook'`, `'session-reference'` | 其它代理/调度来源 | 否 |
| `'tool'` | 工具结果消息（role `'tool'`） | 否 |

佐证：agent-loop 自己就是按 `message.source.kind === "runtime-context"` 区分 runtime context 与用户在 inbox 里的消息（`A:dsh-agent-loop/lib/index.js:860`；`/862,/865,/866` 分别 append runtime context / inbox 消息）。
`user-rpc` 的来源：客户端 `session/prompt` Remote 构造的 durable user message（`R:dsh-api-session-controller/README.md:38`："`session/prompt` builds the durable `user-rpc` message source in its Remote method…"）。因此以 `source.kind === 'user'` 作为"人类输入"白名单，正好同时覆盖本地/远程用户输入。

**最终助手文本**：`AssistantMessage.source.kind === 'model'`（session 层强制校验，`A:dsh-session/lib/index.js:1212-1215`）；正文只取 `type === 'text'` 的块，排除 `reasoning`（`ContentBlockMap`：`text{type:'text',text}`、`reasoning{type:'reasoning',text}`、`tool-call`、`image`、`file` 等，`A:dsh-llm/lib/typert.host.js:536,628,640`）。

### 1.4 一个回合的身份：seq / turn / 分支与回退

| 事实 | 证据 | 结论 |
|---|---|---|
| `seq` 是**会话内单调**事件序号，从 0 连续；`session.seq` 是日志长度（最后事件 seq = `session.seq - 1`） | `R:dsh-session/README.md:64`；`A:dsh-session/lib/index.js:1561-1567`（`seq: SessionSeq(this.log.length)`） | `turn/end` 事件的 `event.seq` 是**该回合完成**的精确锚点 |
| `turn` 号来自事件 data，重放/继续后递增；fork 后是**新 Session**，turn 号不可跨会话当唯一键 | `I:Service/sessionProfile`→`agents.turnBoundaryOf`；`R:dsh-api-session-controller/README.md:67`（fork 复制 inclusive 前缀到 independent Session） | 键 = `sessionId + turn/end.seq`（+ live 时 surface generation） |
| 宿主**没有** `branchEpoch` / `contextRevision` 原语 | `I:Service/sessions` 的 `SessionSurface` 只有 `{nodes, replaceGeneration, contentGeneration}`；`sessionQuery` 快照只有 `capturedThroughSeq/inheritedEventCount` | 方案 4.1 的 `branchEpoch/contextRevision` 由适配层构造（见下） |
| live Session 有进程内 surface 代数 | `I:Service/sessions`：`get surface(): SessionSurface { nodes; replaceGeneration; contentGeneration }`；`A:dsh-session/README.md:102`（replaceGeneration=位置替换，contentGeneration=替换+插件消息变化） | 只能在同一 live 实例内比较；重启/冷读后失效 |
| 回退/重生成在 UI 上是 fork（新 session id），宿主数据层无"分支 id" | `R:dsh-api-session-controller/README.md:67`："Fork copies the exact inclusive event prefix selected by `atSeq`, including a cut inside an open turn, into an independent Session without `parentSession`"；`R:dsh-session/README.md:44-52`（surfaceOp replace 是 compaction 等对模型面的遮蔽，不是分支） | 用 `sessionId + inheritedEventCount + turn/end.seq` 即可区分 fork；**不要**让回退后重复的 turn 数字命中旧缓存 |
| 绑定代际（binding generation）属于 **Client**，Host 无对应字段 | `R:dsh-api-session-controller/README.md:84-86`（Client `sessions.retain` 的 generation）；`I:Service/connection` 的 `browserPeer` 为单一 owner Peer | Host 端 anchor 只能由上述 seq+generation 构造；client 的 generation 只用于 client 侧校验 |
| 冷会话可选 revision（仅统计/缓存线索） | `I:Service/sessionPersistence`：`stat(id)` 的 `revision` 是"opaque change token comparable only against revisions from the same service instance and session id" | 不能当回合身份，也不能跨重启 |

适配层建议（可直接照抄）：

```ts
type TurnAnchor = {
  sessionId: string
  turn: number
  completedEventSeq: number      // turn/end 事件的 event.seq
  contentGeneration: number      // live: session.surface.contentGeneration；冷读见下
  replaceGeneration: number
}
```

冷会话 / 非 live 场景没有 surface generation：此时用 `readSurface(sessionId)` 的 `capturedThroughSeq` 与 `inheritedEventCount` 代替（要求 `capturedThroughSeq === completedEventSeq` 才算"完成回合是最后事件"）。

### 1.5 上下文提取（Host 侧最小实现）

live 主路径（在 `session/event` 的 `turn/end` 回调里同步抓取，最稳，无 await 竞态）：

```js
const textOf = (blocks) => blocks.filter((b) => b && b.type === 'text').map((b) => b.text).join('\n')

function buildTailFromLive(session, completedEventSeq, maxMessages = 12, maxChars = 6000) {
  const messages = session.deriveMessages()   // Message[]，已做 surface 折叠（replace 生效、shadowed 不出现）
  const out = []
  for (const m of messages) {
    if (m.role === 'user' && m.source && m.source.kind === 'user') {
      const t = textOf(m.content).trim()
      if (t) out.push({ role: 'user', text: t })
    } else if (m.role === 'assistant' && m.source && m.source.kind === 'model') {
      const t = textOf(m.content).trim()
      if (t) out.push({ role: 'assistant', text: t })
    }
  }
  // 从尾部取，最多 maxMessages/6000 码点；并保证最后一条是 assistant（该完成回合的最终文字）
  return trimTail(out, maxMessages, maxChars)
}
```

注意：

- `deriveMessages()` 会包含 `system/message`（系统提示，`role:'system'`）与 `developer/message`、`tool/result`，必须按 role+source 过滤；它返回**每次新数组**且内部缓存（`A:dsh-session/lib/index.js:1681`；`R:dsh-session/README.md:44,129`）。
- 不要在 `session/event` 回调里 `await` 后使用同一快照：回调是同步派发（§2.2），抓取必须是同步段内的快照；拿到的 `Message[]` 是深冻结投影，可以传出回调。
- 若只取"该回合内"的用户/助手：live 路径下 `deriveMessages()` 是当前面；本回合的最终助手消息就是过滤后的最后一条 assistant。要严格按 seq 截断，用下面的冷读/`readSurface` 路径。
- 冷读/重连后路径（无 live Session 或需要按 seq 截断）：

```js
const snap = await ctx.sessionQuery.readSurface(sessionId)  // 折叠后的当前模型面
if (snap.capturedThroughSeq !== anchor.completedEventSeq) return abstain('stale')
const tail = []
for (const e of snap.events) {                 // SurfaceEvent 带 seq；只含 current 节点
  if (e.seq > anchor.completedEventSeq) continue
  if (e.type === 'user/message' && e.data.source.kind === 'user')
    tail.push({ role: 'user', text: textOf(e.data.content) })
  else if (e.type === 'assistant/message' && e.data.source.kind === 'model')
    tail.push({ role: 'assistant', text: textOf(e.data.message.content) })
}
```

- 敏感信息脱敏、条数/码点上限、推理块排除：属业务层（方案 7.1/7.2），Host 契约不提供 tokenizer；估算用 `ctx.tokenMeter`（§5.4）。
- 工具摘要、思考内容、附件正文、检索文档：`Message` 里本就以 `tool/result`/`reasoning`/`image`/`file` 出现，默认全部排除即可（方案 7.1 的默认项与宿主结构一致）。

---

## 2. 回合完成观察（Host）

### 2.1 可用的观察点

| 观察点 | 精确契约 | 证据 | 状态 |
|---|---|---|---|
| **会话事件 feed（推荐主触发）** | `session/event`，`emit` 模式，签名 `(this: Scoped<Session>, session: Session, event: SessionEvent): void`；描述："Post-commit, fire-and-forget append feed. The listener snapshot resolves before the log push, but callbacks run after it; observer failures are logged and contained" | `I:Event/session/event`；`A:dsh-session/lib/index.js:1583-1608` | confirmed |
| 监听写法（Host 插件内） | `ctx.on('session/event', (session, event) => { … })` | `A:dsh-session-title/lib/index.js:243-251`（真实运行中的 Host 插件就是这么监听全量会话事件的） | confirmed |
| Agent 状态切换 | `agent/status`，`emit`，`(this: Scoped<Agent>, payload: { agent: Agent; status: 'idle' \| 'running' }): void`；"idle means no driver remains scheduled or active" | `I:Event/agent/status` | confirmed |
| 回合即将关闭（串行、会被 await） | `agent/turn-stopping`，`serial`，`(this: Scoped<Agent>, payload:{agent,turn,signal}): Promise<void>\|void`；"Awaited before the boundary commits" | `I:Event/agent/turn-stopping`；`A:dsh-agent-loop/lib/index.js:790-797` | confirmed（**不要用**，见 2.3） |
| 模型请求失败恢复扩展点 | `agent/request-error`，`waterfall`，`payload:{agent,turn,step,provider,failure,retryPolicy,signal}` | `I:Event/agent/request-error`；`A:dsh-agent-loop/lib/index.js:929-940` | confirmed |

### 2.2 顺序与"post-commit"保证（关键）

`Session.commit()` 的实现顺序（`A:dsh-session/lib/index.js:1589-1608`）：

1. `this.surfaceManager.validateNext(event)`
2. 收集监听器快照：`collectSessionCallbacks(entry.emitCtx, [entry.carrier, 'session/event', this, event])`（`collectSessionCallbacks` 内部 `ctx.events.dispatch('emit', args)`，`:1226-1229`）
3. **先** `this.log.push(event)`（`:1599`）
4. **后**同步逐个调用监听器：`invokeContainedSessionObservers(...)`（`:1601`；实现 `:1231-1240`：`for (const callback of callbacks) try { callback(...args); Promise.resolve(returned).catch(log) } catch { log }`）

由此得到对插件可依赖的保证：

- 在 `session/event` 回调里，`turn/end` **已经**写入日志（`event.seq` 可用），且此前所有事件（含最终 `assistant/message`）都已在日志中 → 可以在回调内同步 `session.deriveMessages()` / `sessionQuery.readSurface()` 拿到完成后的完整上下文。
- 回调是**同步**调用的；回调返回 Promise 不会被 await，且异常/拒绝会被记录并吞掉（observer 失败不影响已提交 append）。因此：**回调里不要做重活/长 await**；预测请求应在回调内同步抓 anchor 后交给队列/定时器（方案 5.1 的 250 ms 静默期适合放在 Host 的 `setTimeout`，用 `ctx.timer`/普通 timer 均可，必须随插件 effect 清理）。
- `turn/end` 的 append 发生在 `ReactLoopAgent.turn()` 的 `finally` 中（`A:dsh-agent-loop/lib/index.js:817-826`），在 `agent/turn-stopping` 串行派发之后（`:790-797`）；`step()` 在正常完成时**先** append `assistant/message`（`:949-955`）再返回 `{kind:'completed'}`（`:958`），随后循环 `break` 并 append `turn/end`。
- 事件流按 append 顺序逐条同步派发；`turn/end` 的 `session/event` 之后才会出现下一回合 `turn/start`（若 inbox 有排队输入，`turn()` 返回 true 继续，`:827-831`）。因此"该 `turn/end` 是最后一条事件"的检查可以简单做：`session.seq === event.seq + 1`。
- 是否需要 `inject:['sessions']` 才能收事件？**不需要**：事件监听不依赖服务注入；但既然回调/路由要用 `ctx.sessions`/`ctx.agents`，建议 `export const inject = ['sessions','agents']`（或多个 service 用 `ctx.get` 可选读取）。作用域方面：`dsh-scope` 的过滤规则是"未打 tag 的 listener 仍全局可见；带 key 的 listener 只收该 key/祖先的事件"（`R:dsh-scope/README.md:42,75`），插件的 fiber ctx 未打 scope tag，因此能收到所有会话/Agent 的事件；`dsh-session-title` 在全量会话上工作即为反证。

### 2.3 明确不要用 `agent/turn-stopping`

- 它排在被 `await` 的串行派发里，位置在 `turn/end` 之前：`await this.dispatch.serial("agent/turn-stopping", {turn, signal})`（`A:dsh-agent-loop/lib/index.js:791`）；`turn/end` 在其后的 `finally` 中 append（`:819`）。任何在这等待的插件都会**延后 `turn/end`**（方案第二节的结论正确）。
- 若在其中 `await` 一个 8 秒预测，会让主回合结束延迟 8 秒 → 违反"主对话优先"。首版用 `session/event` 的 `turn/end` 即可，无需该钩子。

### 2.4 最小触发骨架

```js
// apply(ctx, config) 内
ctx.on('session/event', (session, event) => {
  if (event.type !== 'turn/end') return
  if (event.data.reason.kind !== 'completed') return           // aborted/blocked/error/max-tokens/interrupted/forked 全部忽略
  const anchor = {
    sessionId: session.id,
    turn: event.data.turn,
    completedEventSeq: event.seq,
    contentGeneration: session.surface.contentGeneration,
    replaceGeneration: session.surface.replaceGeneration,
  }
  const tail = buildTailFromLive(session, event.seq)            // §1.5，同步
  if (tail.length === 0 || tail[tail.length - 1].role !== 'assistant') return  // 无最终助手文本 → 弃权
  schedulePrediction(ctx, config, anchor, tail)                 // 250ms 静默期后在 Host 侧执行
})
```

注意：`schedulePrediction` 到真正派发前必须**再核验** anchor（配置关闭、会话已继续、surface 变了、插件卸载都要放弃）：

```js
function stillAtAnchor(ctx, anchor) {
  const session = ctx.sessions.get(anchor.sessionId)
  if (session === undefined) return false
  if (session.seq !== anchor.completedEventSeq + 1) return false      // 之后又有新事件（新输入/新回合）
  if (session.surface.contentGeneration !== anchor.contentGeneration) return false
  if (session.surface.replaceGeneration !== anchor.replaceGeneration) return false
  return ctx.agents.turnBoundaryOf(session).lastTurn === anchor.turn
}
```

---

## 3. 插件 Config、原生设置与 revision/CAS

### 3.1 声明与读取（Host 插件）

| 能力 | 精确机制 | 证据 | 状态 |
|---|---|---|---|
| 声明 Config schema | 函数式插件：`export function apply(ctx, config)` + `export const Config = z.object({...})`（schemastery）；service 类插件：`static Config = z.object({...})` | `A:dsh-agent-preset/skills/cordis-plugin-development/references/host-plugin.md:61-64`（"`export function apply(ctx, config) {}` … optional `export const Config`"；"A plugin that declares `Config` validates the row's `config` at activation"）；`A:dsh-agent-default-model/lib/index.js:21-25`；`P:qq-mode-console/lib/index.js:95-100` | confirmed |
| 可热改字段标记 | 字段必须带 `volatile` 元数据。DSH 自带 `@deepseek-ai/schemastery@3.19.0` 有 `Schema.prototype.volatile()`（= `this.extra("volatile", true)`） | `A:schemastery/lib/index.mjs:235-238`；`A:schemastery/package.json`（version 3.19.0） | confirmed |
| 兼容写法（推荐） | 用 `.extra('volatile', true)`；若插件解析到的 schemastery 不是 DSH 内置那份，`.volatile()` 可能不存在（真实踩坑记录） | `P:qq-mode-console/lib/index.js:88-99`（"`.extra('volatile', true)` 是 DSH 的…标记。这里刻意不写 `.volatile()`… 本仓库钉的 `^3.18.1` 解析出来的那份没有这个方法"）；`P:dsh-context/lib/index.js` 有防御：`function R(e){let t=e.volatile;return typeof t==='function'?t.call(e):e}` | confirmed（工程约束，必须注意） |
| apply 收到的 config | 普通字段是值；**volatile 字段是稳定引用，读取用 `.get()`** | `A:dsh-agent-default-model/lib/index.js:38-45`（`this.config.provider.get()`）；`A:cosmokit/src/volatile.ts:9-12`（`interface Volatile<T> { get(): VolatileSnapshot<T> }`，注释"keep the reference, or capture its value for one operation only"） | confirmed |
| 插件自己的 entry | `ctx.fiber.entry`（loader Entry；`entry.options.id` 是设置命名空间，`entry.options.config` 是原始配置） | `A:dsh-agent-default-model/lib/index.js:54-56`；`A:dsh-config-editor/lib/index.js:30-35`（`entries().filter(...)`，`:readonly` `entry.options.id`）；`A:cordis-plugin-loader/lib/index.js:559-566`（`entry.options.id`） | confirmed |
| 设置页策略 | `ctx.inject(['settings'], (child) => child.effect(() => child.settings.configure({ auto: false }, ctx.fiber), …))`（自绘页面时关闭自动页） | `I:Service/settings`（`configure(presentation:{auto?}, owner?)`）；`R:dsh-settings/README.md:39`；`A:dsh-agent-default-model/lib/index.js:30-32` | confirmed |

**设置命名空间 = loader entry id**。`ctx.settings` 完全按 `entry.options.id` 定位：`describe()` 用 `entry.options.id` 作为 `ns`（`A:dsh-settings/lib/index.js:413-464`，`ns: entry.options.id` 在 `:432`）。因此新插件 `cordis.patch.yml` 的 row `id` 应直接取 `next-message-predictor`（或设计确定的命名空间），与包名解耦。`P:qq-mode-console` 的踩坑注释明确：entry id 必须等于命名空间（`:6-22, :67-100`）。

### 3.2 `ctx.settings` 在 0.2.2-rc.1 的真实形状（无 `register`）

`I:Service/settings` 的完整方法集：

```ts
configure(presentation: { auto?: boolean }, owner?: Fiber): () => void
prepareDocument(): Promise<string>
describe(options?: { redactSecrets?: boolean }): SettingsDescriptor[]
update(ns: string, patch: object, expectedRevision?: number): Promise<void>      // 合并可编辑字段
replace(ns: string, section: object, expectedRevision?: number): Promise<void>   // 重置本层 live 字段后写入
mutate(ns: string, ops: readonly SettingsPathOp[], expectedRevision?: number): Promise<void>
```

`SettingsDescriptor`：`{ ns: SettingsNamespace; autoGenerate: boolean; schema: unknown; value: unknown; revision: number; base?: unknown; user?: unknown; applies: 'live'; secrets?: RedactedSecret[] }`（`I:Service/settings`）。

- `register(ns, schema, …)` 在 0.2.x 已删除：`P:dsh-composer-prediction/lib/index.js:30-37` 注释（"The 0.2.x settings service (`ctx.settings`) is a *form* service over loader entries … there is no `register(ns, schema)` returning a live `{get, update}` scope any more (that was the 0.1.x API …)"）；`P:qq-mode-console/lib/index.js:6-22`（更完整的 0.2.0 实测说明）。→ **禁止使用 `ctx.settings.register`**。
- **只有 volatile 字段可被表单编辑**：`describe()` 先经 `volatileForm(schema)`（只保留 volatile 字段；无 volatile 字段整条不出现，`A:dsh-settings/lib/index.js:122-131, 413-420`）；`write()` 对非 volatile 路径抛错（`:501-537`，`:507` `"Config field … is not volatile"`，`:506` `"has no volatile fields"`）。`R:dsh-settings/README.md:12,33` 同义（"Forms expose only volatile fields from active, uniquely addressed profile entries"）。→ 方案的 `PredictorConfig` 若希望全部在原生设置页可改，**每个字段都要 volatile**。
- 普通（非 volatile）字段的修改走 profile patch + Loader 重挂载（`configEditor.edit` 或直接改 patch）；`apply` 会重新执行，内存状态重置。

### 3.3 热更新、revision 与 CAS

| 能力 | 精确机制 | 证据 | 状态 |
|---|---|---|---|
| volatile-only 热更新（不重启插件） | loader `update()`：若唯一变化是 config 且 `equalExceptVolatile(...)` 为真，则 `this.fiber.rawConfig = ...` 并 `this._commitVolatile()`，不重挂载 | `A:cordis-plugin-loader/lib/index.js:498-520`（`:513-515`）；`:522-558`（`_commitVolatile`：对 `volatileEntries(fiber.effectiveConfig)` 逐个 `updateVolatile(ref, source)`，成功后 `fiber.ctx.emit(self, "loader/volatile-update", paths)` `:553`） | confirmed |
| volatile 的解析与提交 | schemastery 把 volatile 字段包装成 `createVolatile(value)`；cosmokit 提供 `volatileEntries/updateVolatile` | `A:schemastery/lib/index.mjs:265-277`；`A:cosmokit/src/volatile.ts:39-45,62-76,84-86` | confirmed |
| 配置变更事件（公开） | `settings/document-updated`，`emit`，签名 `(ns: SettingsNamespace, revision: number): void`；在 `describe()` 检测到 raw/autoGenerate 变化时发出 | `I:Event/settings/document-updated`；`A:dsh-settings/lib/index.js:413-435`（`:435` emit），`:453-462`（namespace 消失时 revision+1 并 emit） | confirmed |
| revision 语义 | 每条 entry 的 `revision` 在 `describe()` 内按 `previous.revision + Number(previous.raw !== raw)` 递增；`updatedAt` 无；**进程内**，不是持久版本号 | `A:dsh-settings/lib/index.js:427-434` | confirmed |
| CAS 写 | `update/replace/mutate` 的 `expectedRevision` 与当前 `descriptor.revision` 不等时抛 `SettingsConflictError`（`code:'SETTINGS_CONFLICT'`，含 `expected/actual`） | `A:dsh-settings/lib/index.js:501-512`（`:511` throw）；`:163-181`（错误类） | confirmed |
| 写持久化路径 | 最终由 `configEditor.edit(entry, change)` 写入 profile `cordis.patch.yml`（原子写 + 文件锁 + reconciliation + 失败回滚；与 HMR 串行化） | `A:dsh-settings/lib/index.js:508`（`this.ownerContext.configEditor.edit(...)`）；`A:dsh-config-editor/lib/index.js:64-134`（`:69-82` change/resolveConfig，`:122-129` writeFileAtomic + 回滚，`:132-133` `hmr.runExclusive`） | confirmed |

**Host 侧读取"当前配置 revision"的可行做法**：`ctx.get('settings')?.describe()` 找到 `ns === ctx.fiber.entry.options.id` 的 descriptor，取 `revision`/`value`。注意 `describe()` 会计算全部表单（O(entries)），不要在每次预测里做；建议订阅 `settings/document-updated` 只维护本 entry 的 revision 缓存，或仅在路由请求里按需比对。**明确限制**：revision 是进程内值，Host 重启后会重新从 0/1 起算；方案的 `expectedConfigRevision` 只能当作"同一 Host 进程内的过期检查"，不能跨重启标识配置版本（`partial`）。

**读取当前值（推荐）**：不要缓存 `descriptor.value`；直接读 volatile 引用：

```js
const enabled = config.enabled.get()        // config 是 apply 的第二参数
```

若字段很多，可写 `const snapshot = () => ({ enabled: config.enabled.get(), ... })`，每次操作取一次（`Volatile` 注释要求只捕获"一次操作"的快照）。

### 3.4 `Config` 声明的两个真实范例（供抄结构）

- `dsh-context`（profile 安装、正在运行）：`Config.listConfigs` 条目 `include:dsh-context`，`status:"schema"`，`packageDir: <DSH_HOME>\profiles\desktop\node_modules\dsh-context`；其 schema JSON 中每个表单字段带 `x-cordis: { loose:true, volatile:true, … }`。源码：`P:dsh-context/lib/index.js` 导出 `ir as Config`，`ir = r.object({ maxRequestSteps: z(...), defaultPlacement: R(r.union([...])), … })`，`R` 是"有 `.volatile` 就调用、否则原样"的兼容包装。
- `qq-mode-console`（link 安装的最小 Host-only 设置插件）：`export const Config = z.object({ mode: …, ownerQQ: …extra('volatile', true) })`，`apply` 可为空操作；命名空间来自 patch row id `qq-mode`（`P:qq-mode-console/lib/index.js:95-113`，`P:qq-mode-console/cordis.patch.yml`）。

依赖声明参考：`qq-mode-console/package.json` 把 `@deepseek-ai/schemastery` 放在 `dependencies`（`^3.18.1`）；`dsh-context/package.json` 把它放在 `peerDependencies`，host 代码实际 `import r from "@deepseek-ai/schemastery"`（`P:dsh-context/lib/index.js` 首行 import 列表）。本机运行时这些 profile 插件都能解析到 `@deepseek-ai/*`（Config 目录显示它们已激活），但**从 profile 目录直接 `node import.meta.resolve('@deepseek-ai/schemastery')` 失败**（本项目实测 `ERR_MODULE_NOT_FOUND`）——解析是 DSH 运行时的机制，不是普通 Node 行为。→ 实现时按现有插件同款方式声明依赖，并在真实 DSH 内 smoke 验证，不要假设本机 `node` 可解析。

---

## 4. Host HTTP/RPC 表面

### 4.1 唯一推荐入口：`ctx.connection.fetch.register`

精确类型（`I:Service/connection`）：

```ts
interface HostConnectionFetch {
  register(route: ConnectionFetchRoute): () => Promise<void>
}
interface ConnectionFetchRoute {
  readonly path: string
  readonly methods: readonly ('GET' | 'HEAD' | 'POST')[]
  readonly requestBody: 'buffered' | 'streaming'
  readonly fetch: (request: Request) => Promise<Response>
}
```

真实用法（运行中的参考插件，`P:dsh-composer-prediction/lib/index.js:96-124`）：

```js
ctx.effect(() => connection.fetch.register({
  path: ROUTE,                        // '/api/composer-predict/rpc'
  methods: ['POST'],
  requestBody: 'buffered',
  fetch: async (request) => { ...; return new Response(JSON.stringify(result), { status: 200, headers: { 'content-type': 'application/json' } }) },
}), 'composer-predict: rpc route')
```

`register` 的注册/注销语义（`A:dsh-client-connection/lib/index.js`）：

- `registerFetchRoute`：`assertFetchRoute(route)` → 存入 `fetchRoutes`；`return owner.effect(() => { …; return () => this.fetchRoutes.delete(path) }, …)`（`:840-854`）。同一路径重复注册抛 `Error("… is already registered")`（`:848`）。插件卸载 / effect 释放 → 路由自动删除。
- `assertFetchRoute`：`endpointFromPath("/api", route.path)` 必须有效 → **`path` 必须是 `/api/<segment>[/<segment>…]`**，每段匹配 `/^[A-Za-z0-9_$.-]+$/`（`ENDPOINT_SEGMENT_PATTERN` `:690`；`endpointFromPath` `:926-931`）；`methods` 不能为空、不能重复（`:973-977`）。`/api/next-message-predictor/rpc` 合法。
- 匹配是按 `new URL(request.url).pathname` 精确匹配（`createSharedFetchHandler.fetch`：`const route = this.fetchRoutes.get(pathname)`，`:826-838`）；query string 不影响匹配，子路径不会落到父路由。

请求/响应契约：

| 项 | 结论 | 证据 |
|---|---|---|
| handler 入参 | 只有 `Request`；**没有 peer/principal/窗口身份参数** | `I:Service/connection` 的 `ConnectionFetchRoute.fetch` |
| Host 认证 | `/api` 前缀 route 先 `connection.admit(req)`；未认证 401 / Host 或 Origin 不可信 403，之后才 `bridge(req, res, fetchHandler, admission.peer, maxRequestBodyBytes)` | `A:dsh-client-connection/lib/index.js:1044-1058`（`:1049` admit） |
| 栅栏规则 | Host header 必须是 loopback / `trustedHosts` / 监听 bind 地址；`Sec-Fetch-Site: cross-site` 拒绝；有 `Origin` 时必须与 Host 同 authority | `A:dsh-client-connection/lib/index.js:240-250`（`isTrustedApiRequest`），`:133-145` 注释 |
| 认证规则 | 先查浏览器会话 cookie（`browserAuth.isAuthenticated`）→ 返回共享的 `browserPeer`（principal owner）；否则按 API token（`authenticateApi`）→ 返回已发布 peer；否则 401 | `A:dsh-client-connection/lib/index.js:742-750`（`admit`），`:709-714`（`browserPeer = new Peer(ctx, {principal:{kind:'owner'}})`） |
| **owner-only** | exact fetch route 命中后：`if (peer.principal.kind !== "owner") return new Response("forbidden", {status:403})`，然后 `route.fetch(request)` | `A:dsh-client-connection/lib/index.js:826-838`（`:830` 原文） |
| 请求体（buffered） | Host 按全局 `maxRequestBodyBytes` 先完整缓冲（默认 `300 * 1024 * 1024`）；`content-length` 或实际累计超限 → 413 + `connection: close` | `A:dsh-client-connection/lib/index.js:26-30`（默认 300 MiB 注释："The bridge buffers each body in memory, so this cap is also the per-request resident bound."）；`:54-80`；`:1014-1019`（Config `maxRequestBodyBytes`） |
| 请求体（streaming） | 不做宿主缓冲，body 以 `Readable.toWeb(req)` 交给 handler；handler 可自限读取（8 KiB 的唯一无损实现方式） | `A:dsh-client-connection/lib/index.js:81-87`；`:89-113`（若 handler 未读完 body → 响应后 `connection: close` 并 `req.destroy()`） |
| 请求取消 | `bridge` 在 `res.on("close")` 时 abort → 传入 `new Request(..., {signal})`；并行模型调用应透传该 signal | `A:dsh-client-connection/lib/index.js:40-44,75-87` |
| 返回 JSON | handler 返回 WHATWG `Response`（status/headers 由它决定）；`bridge` 原样写回 status+headers+body | `A:dsh-client-connection/lib/index.js:88-113` |
| 支持方法 | 仅 `GET`/`HEAD`/`POST`（类型层）；设计用 `POST` 即可 | `I:Service/connection`（`ConnectionFetchMethod`） |
| 响应流式 | bridge 支持 `response.body` 分块回写（`:100-111`），但首版返回完整 JSON 更简单 | `A:dsh-client-connection/lib/index.js:95-113` |

**"插件必须做什么 vs 宿主已经做什么"**：

- 宿主已做：`/api` 前缀挂载、Host/Origin 栅栏、浏览器/API token 认证、exact route owner-only、方法集合过滤（非注册方法不会命中 → 404）、buffered 模式的 300 MiB 内存上限与 413、请求断开 abort、路由随插件卸载注销。
- 插件必须做：`Content-Type` 校验（exact route 不会替你校验，`rpcFetchHandler` 才校验 JSON，`:888-917`）；schema/字段/深度/长度校验；**自己的 8 KiB 上限**（推荐 `requestBody:'streaming'` + 读满上限即中止并返回 413）；业务状态码与 JSON 错误体；对 `request.signal` 的透传；幂等/dedupe（用 requestId）；不要把 `viewId` 当权限。

### 4.2 备选通道（不推荐/仅供理解）

| 通道 | 契约 | 证据 | 状态 |
|---|---|---|---|
| `ctx.connection.rpc.handle(channel, handler)`（legacy） | `handle(channel: string, handler: (endpoint, payload, signal, peer) => Promise<{ok:true,value,attachments?}\|{ok:false,error}>): () => Promise<void>`；channel 必须匹配 `/^\/[A-Za-z0-9._~-]+$/` 且不能是 `/api`；挂载在 webServer 上，内部走 `clientRequestSchema` 信封（`{type:'client-request', rpcId, method, payload}`） | `I:Service/connection`；`A:dsh-client-connection/lib/index.js:855-916`（`:970-972` `assertChannel`），`:888-916`（信封/415/404/500） | confirmed but **不建议**：信封格式是内部协议，Client 半边要自己拼；参考插件只在没有 `connection.fetch` 的旧运行时才用（`P:dsh-composer-prediction/lib/index.js:127-137`） |
| `ctx.connection.rpc.intercept('/api', matches, handler)` | 只允许 `/api`；会接管 `/api/<...>` 中匹配的 endpoint | `I:Service/connection`；`A:dsh-client-connection/lib/index.js:873-886` | confirmed（本插件不需要） |
| `ctx.webServer.register(route)` | `WebRoute | WebResourceRoute`；**不会自动做认证/owner 检查**，需要自己 `connection.requestRejection(request)`/`admit(request)` | `I:Service/webServer`、`I:Service/connection`（`requestRejection`/`admit`） | 可行但**禁止用于本插件**（方案 2.1：不能只看插件有没有鉴权；这条路径全靠自己，容易漏） |

### 4.3 P1 路由骨架（无模型、固定假建议）

```js
// 路径与方案 §6 一致；requestBody:'streaming' 以便自限 8 KiB
ctx.effect(() => ctx.connection.fetch.register({
  path: '/api/next-message-predictor/rpc',
  methods: ['POST'],
  requestBody: 'streaming',
  fetch: async (request) => {
    if ((request.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase() !== 'application/json')
      return json({ error: 'content-type must be application/json' }, 415)
    const body = await readJsonBounded(request, 8192)          // 自实现：累计 bytes 超限 → 413
    if (body === undefined) return json({ error: 'invalid or too large body' }, 400)
    // body: { schemaVersion:1, operation:'predict', requestId, viewId, anchor, expectedConfigRevision, trigger }
    const cfg = snapshotConfig(config)                         // 全部 volatile 字段 .get()
    if (!cfg.enabled) return json({ result: { kind: 'unavailable', reason: 'disabled' } })
    // owner-only 由宿主保证；anchor 再核验（§2.4）；先查内存 offer 缓存（P1 固定假建议，无模型）
    return json({ requestId: body.requestId, anchor: body.anchor, configRevision: currentRevision(ctx, config),
                  result: { kind: 'offer', suggestionId: 'fixed-1', text: '（P1 固定假建议）', expiresAt: Date.now() + 60_000 } })
  },
}), 'next-message-predictor: rpc route')
```

```js
function json(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
}
```

说明：P1 的"固定假建议"不需要模型、不需要持久化；但 `predict` 仍必须先验证 `enabled` + anchor 是**该会话最后一条已完成回合**（§2.4），否则无法验收"跨会话/新输入不误显示"的工程矩阵。

---

## 5. 模型路由与成本（只给契约，不实现）

### 5.1 服务与调用签名（逐字来自 `I:Service/llm`）

```ts
// 访问：ctx.get('llm')（optional，需 undefined 检查）或 inject:['llm']（硬依赖，等 adapter 就绪）
interface LlmRuntime {
  listProviders(): LlmProviderInfo[]                           // {id,name}
  async listModels(provider: string): Promise<LlmModelInfo[]>  // {provider,id,name,description?,inputModalities?,badge?}
  async resolveModelInfo(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo>
      // 含 context?:{contextWindow}, defaultMaxTokens?, reasoning?:{efforts:[{id,name,description?}],defaultEffort?},
      //    systemPromptUpdate?:'in-history', toolUpdate?
  async resolveCallConfig(config: LlmCallConfig, signal?: AbortSignal): Promise<LlmCallConfig>
  async prepareCall(config: LlmCallConfig, signal?: AbortSignal, configure?: ConfigureCall): Promise<PreparedLlmCall>
  stream(options: GenerateOptions): AsyncIterable<StreamChunk>
  providerRetryPolicy(provider: string): ResolvedRetryPolicy   // 由 adapter 注册时捕获
}
type ConfigureCall = (controls: Readonly<LlmCallControls>, model: Readonly<LlmResolvedModelInfo>) => LlmCallControls
interface LlmCallControls { reasoningEffort?: ReasoningEffortId; temperature?: number; maxTokens?: number; stop?: string[] }
interface LlmCallConfig extends LlmCallControls { provider: string; model: string }
interface PreparedLlmCall {
  readonly config: LlmCallConfig
  readonly retryPolicy: ResolvedRetryPolicy
  readonly context?: { contextWindow: number }
  readonly inputModalities?: readonly ModelModality[]
  readonly systemPromptUpdate?: 'in-history'
  readonly toolUpdate?: 'in-history' | 'addition-only'
  readonly adapterDefaults: { reasoningEffort?: true; maxTokens?: true }
  stream(options: GenerateOptions): AsyncIterable<StreamChunk>
}
```

```ts
interface GenerateOptions<Purpose extends string = LlmRequestPurpose> {
  provider: string
  model: string
  reasoningEffort?: ReasoningEffortId
  messages: RequestMessage[]            // 持久 Message 或 {role:'user',content} 的 RequestUserInput
  system?: string
  tools?: ToolSchema[]
  toolHistory?: ToolHistory
  temperature?: number
  maxTokens?: number
  stop?: string[]
  signal?: AbortSignal
  sessionId?: SessionId                 // 本插件辅助调用**不要**传：会被 checkpoint-policy/标题插件当作主会话请求
  purpose?: Purpose                     // 需要 module augmentation 声明；本插件可不传
}

type StreamChunk =
  | { type:'block-start'; index:number; blockType:ContentBlockType }
  | { type:'text-delta'; index:number; text:string }
  | { type:'reasoning-delta'; index:number; text:string }
  | { type:'tool-call-delta'; index:number; id:ToolCallId; name?:string; argumentsDelta:string }
  | { type:'block-end'; index:number; block:ContentBlock }
  | { type:'usage'; usage: TokenUsage }
  | { type:'finish'; reason: FinishReason; replayState?: ReplayEnvelope }

interface TokenUsage { inputTokens:number; outputTokens:number; totalTokens?:number;
                       cacheReadTokens?:number; cacheWriteTokens?:number; reasoningTokens?:number }
type FinishReason = {kind:'stop'} | {kind:'tool-calls'} | {kind:'max-tokens'}
                  | {kind:'aborted'; failure:LlmFailure} | {kind:'error'; failure:LlmFailure}
interface LlmFailure { message:string; code:string; status?:number; providerRetryAfterMs?:number; requestId?:ProviderRequestId }
```

### 5.2 usage / abort / 失败语义

| 能力 | 契约 | 证据 | 状态 |
|---|---|---|---|
| 每次流必有一个终止 `finish` | "Every stream ends in exactly one terminal `finish` chunk" | `R:dsh-llm/README.md:47,95` | confirmed |
| usage 上报 | `{type:'usage', usage: TokenUsage}`；顺序保证 "`usage` precedes `finish`"，且 `finish` 之后无任何 chunk | `R:dsh-llm/README.md:140` | confirmed |
| 取消 | 传 `GenerateOptions.signal`；abort 后以 `finish {kind:'aborted', failure}` 结束（不是抛异常）；usage 可能缺失或部分 | `R:dsh-llm/README.md:95`；`I:Event/llm/stream`（"Adapter selection, dispatch, and iteration failures become terminal `error` or `aborted` finish chunks; middleware, nested-call, cleanup, and consumer failures remain thrown."） | confirmed（需同时 catch 抛出） |
| 失败码 | 稳定 code：`NO_ADAPTER`、`MISSING_CREDENTIAL`、`AUTH`、`RATE_LIMIT`、`CONTEXT_WINDOW_EXCEEDED`、`QUOTA`、`ACCOUNT_QUOTA`、`INVALID_CREDENTIAL`；路由判断用 code，不用 message | `R:dsh-llm/README.md:95` | confirmed |
| 输出上限 | `maxTokens`（`GenerateOptions`/`LlmCallControls`）；adapter 可在 `prepareCall` 时补默认值（`PreparedLlmCall.config.maxTokens` 是**materialize 后的**值） | `I:Service/llm`；`R:dsh-llm/README.md:65` | confirmed |
| 推理参数 | `reasoningEffort: ReasoningEffortId`；必须用 `resolveModelInfo(...).reasoning.efforts` 里的 id，`prepareCall` 对不支持的值**直接拒绝**（"Unsupported explicit efforts reject before provider I/O; no clamping or aliasing"） | `I:Service/llm`（`resolveCallConfig`/`prepareCall` 描述） | confirmed |
| 选"最低推理" | 参考实现取 `model.reasoning.efforts[0].id`（真实可用）；但方案 8.2 提醒 efforts 首项不一定"最低"——本机没有额外语义 API，只能按 id/能力表显式映射 | `P:dsh-composer-prediction/lib/index.js:227-235`；`I:Service/llm` | partial（能力表需自建） |
| 预检查路由 | `resolveModelInfo` / `resolveCallConfig` 可在真正调用前校验 provider/model/effort/context | `I:Service/llm`；`R:dsh-llm/README.md:89-90` | confirmed |
| 请求不可变 | `llm/stream` 描述：loop-built 请求 deep-frozen；手搓调用"callers own their request inputs and must keep them unchanged until the stream settles" | `I:Event/llm/stream` | confirmed |

### 5.3 重试：直连调用**没有**自动重试

证据链（三条互相独立）：

1. `R:dsh-llm/README.md:95`："**This service never re-runs a request: retrying is the job of `dsh-llm-retry` at the agent's failed-step extension point.**"
2. `dsh-llm-retry` 只注册 `agent/request-error`（agent 主循环的失败步骤扩展点）：`A:dsh-llm-retry/lib/index.js:184` `ctx.on("agent/request-error", (payload, next) => …)`；`:16-19` 注释 "Provider-routed model-request retry policy on the agent loop's request recovery extension point"。
3. 全仓只有两个 `llm/stream` 监听器，都不是重试：`A:dsh-session-checkpoint-policy/lib/index.js:61-65`（`options.sessionId === undefined` 时直接 `next()`，插件直连调用满足此条件）；`A:dsh-session-title/lib/index.js:252-258` + `:429-430`（只处理 `isAgentLoopRequest(options)` 的主循环请求，手搓调用被忽略）。

结论：

- 插件直接 `ctx.llm.stream(...)` 的调用**天然不发生宿主级重试**，一次调用 ≈ 1 次 adapter dispatch；无需"per-call retry disable"开关。`PreparedLlmCall.retryPolicy` 只被 `dsh-llm-retry` 在 agent 主循环里消费（`A:dsh-agent-loop/lib/index.js:929-940` 把 `retryPolicy` 传给 `agent/request-error`，默认 `next()` 返回 `undefined`，只有返回 `{kind:'retry'}` 才 `continue`）。
- 无法从 `StreamChunk` 得到"物理尝试序号/次数"；若关心物理尝试，只能按"每次 `stream()` 调用 = 一次 provider 请求"记账（本机文本路径成立；adapter 内部的图片 stale-id 重传不属于文本调用）。
- 方案的"自动模型重试 0，需核验宿主重试链"→ **confirmed：0**，连"禁用"都不必实现。
- 风险提示：`agent/request-error` 是**全局** waterfall；如果将来本插件把它用于其它目的，会与 `dsh-llm-retry` 组合——首版不要监听该事件。

### 5.4 模型路线与成本可测性

| 能力 | 契约 | 证据 | 状态 |
|---|---|---|---|
| "跟随当前会话"的默认路线 | `ctx.agentDefaultModel.currentSelection(): ModelSelection`（`{provider,model,reasoningEffort?}`，detached） | `I:Service/agentDefaultModel`；`P:dsh-composer-prediction/lib/index.js:65-73,105-119`（inject `agentDefaultModel` 后 `currentSelection()`） | confirmed |
| 列 provider / model 能力 | `ctx.llm.listProviders()` / `listModels(provider)` / `resolveModelInfo(provider,model)` | `I:Service/llm`；`R:dsh-llm/README.md:59,86-90` | confirmed |
| usage 数字 | 来自辅助调用自己的 `usage` chunk（input/output/cache/reasoning token） | `I:Service/llm`；`R:dsh-llm/README.md:140` | confirmed |
| token 估算（上下文预算） | `ctx.tokenMeter.measure(session, requestHeader?): TokenMeasurement`（`totalTokens/surfaceTokens/nodes[]/baseline`）、`estimateMessage(message): number`、`contextPressure(session)` | `I:Service/tokenMeter` | confirmed（**启发式**，不是精确 tokenizer） |
| 文本单价/费用估算 | 不存在服务级文本价格 API；`ctx.llm.imageRequestPricing(provider,model)` 只有图片。`resolveModelInfo` 不含价格 | `I:Service/llm`（无 text pricing 方法）；`R:dsh-llm/README.md:129`（只有 image pricing） | **unsatisfied**：首版只能展示 token 用量，不能承诺金额；若用户配置了价格表，价格来源须自管并标注 |
| 提供商 token 缓存 | usage 里 `cacheReadTokens/cacheWriteTokens` 可区分；是否命中由 provider 决定 | `I:Service/llm`（TokenUsage）；`R:dsh-llm/README.md:129` | partial（可展示，不可控制） |

### 5.5 P2 调用骨架（可直接套）

```js
async function callPredictorModel(ctx, config, prompt, signal) {
  const llm = ctx.get('llm'); if (llm === undefined) return { kind: 'unavailable', reason: 'no-llm' }
  const route = resolveRoute(config)            // config.modelMode==='session' ? agentDefaultModel.currentSelection() : {provider,model}
  if (!route) return { kind: 'unavailable', reason: 'no-route' }
  const maxTokens = config.maxOutputTokens.get() // 256 起
  const prepared = await llm.prepareCall({ ...route, maxTokens }, signal, (controls, model) => {
    const efforts = model.reasoning?.efforts ?? []
    const chosen = pickSupportedEffort(efforts, config)   // 显式映射；找不到就保持 controls
    return chosen === undefined ? controls : { ...controls, reasoningEffort: chosen.id }
  })
  let text = '', usage = null, finish = null
  try {
    for await (const chunk of prepared.stream({
      ...prepared.config,
      system: prompt.system,
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt.input }] }],
      signal,
      // 不传 sessionId / tools / toolHistory：本调用不是会话请求
    })) {
      if (chunk.type === 'text-delta') text += chunk.text
      else if (chunk.type === 'usage') usage = chunk.usage
      else if (chunk.type === 'finish') finish = chunk.reason
    }
  } catch (error) {
    return { kind: 'unavailable', reason: 'transport', error }
  }
  if (finish?.kind !== 'stop') return { kind: 'abstain', reason: `finish-${finish?.kind ?? 'missing'}` } // max-tokens/aborted/error 全弃权
  return { kind: 'raw', text, usage }
}
```

超时：`signal` 由 `AbortSignal.any([request.signal, AbortSignal.timeout(config.timeoutMs.get())])` 组合即可（`dsh-timeout` 包也是同样能力；`AbortSignal.timeout` 在 Node 22/24 可用）。abort 后必须等 `for await` 结束再处理（会以 `finish aborted` 正常结束）；不要把 abort 当作"零费用"（usage 可能缺失 → 方案 8.5 的"未知"分支）。

---

## 6. 预算/持久化原语与路径约定

### 6.1 原生持久化：`ctx.storageDomain`（推荐，如可接受依赖）

| 能力 | 精确契约/约定 | 证据 | 状态 |
|---|---|---|---|
| 取服务 | `ctx.get('storageDomain')` / `inject:['storageDomain']`；基础 bundle 已挂载（storage + storage-json + storage-domain 三行） | `I:Service/storageDomain`；`A:dsh-base/cordis.patch.yml:175-190` | confirmed |
| 声明 domain | `defineDomain({ name, version, tables: { <table>: domainTable(zodSchema) }, global?: {schema, initial} })`；插件导出 spec | `R:dsh-storage-domain/README.md:34-45`；`I:Service/storageDomain`（`DomainSpec`） | confirmed（README 级） |
| 打开/使用 | `const domain = await ctx.storageDomain.open(spec)`；`domain.table('t').get(k)` 同步读；`put/delete/deleteMany/update` 返回即已持久；`domain.global.get()/set()`；`domain.close()` | `R:dsh-storage-domain/README.md:47-58,71-73,87-90`；`I:Service/storageDomain`（`Domain`/`KvTable`） | confirmed |
| 后端路由 | storage-domain 插件 Config：`backend`（默认路线）+ `routes`（domain name → backend）；当前 profile：`backend: json` | `A:dsh-base/cordis.patch.yml:187-190`；`R:dsh-storage-domain/README.md:60-69` | confirmed |
| JSON backend 落盘 | storage-json Config `root`（必填）；当前 profile：`root: !!js dshHomePath('storages')`；single 布局每 unit 一个 `<root>/<unit>.json`，原子替换（temp+fsync+rename） | `A:dsh-base/cordis.patch.yml:182-186`；`R:dsh-storage-json/README.md:34-52,75-76` | confirmed |
| 变更事件 | `domain/changed`（emit；"emitted once per write strictly after the backend acknowledged durability"） | `I:Event/domain/changed`；`R:dsh-storage-domain/README.md:71-73,90` | confirmed |
| 生命周期 | 调用者持有 handle 并负责 `close()`（通常 `ctx.effect` 里）；facility 卸载会关掉未关的 domain | `I:Service/storageDomain`；`R:dsh-storage-domain/README.md:58` | confirmed |

**工程风险（必须标 partial）**：`defineDomain`/`domainTable` 来自 `@deepseek-ai/dsh-storage-domain` 包，`valueSchema` 要求 zod schema。profile 插件能否直接 `import '@deepseek-ai/dsh-storage-domain'` 与 `zod` 的实例身份是否一致（domain facility 用自己那份 zod 校验）没有在 P0 验证；备选是直接传**形状等价**的 plain spec（`{name,version,tables:{t:{valueSchema: z.object(...)}}}`）——但跨包 zod 实例可能被 `$ZodType` 品牌/instanceof 拒绝。→ P2 若用此路径，先在 scratch profile 做 5 行 smoke；失败即降级到 6.2。

### 6.2 插件私有 JSON（备选，参考实现做法）

参考插件自管 `<DSH_HOME>/composer-predict.json`：`const configFile = () => join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'composer-predict.json')`；写用 `mkdirSync(dirname)` + `writeFileSync(tmp)` + `renameSync(tmp, path)`（`P:dsh-composer-prediction/lib/index.js:16-56`）。

- 这是**生产可用**的路径（该插件 0.7.8 在运行），但 DSH 没有"插件私有目录"的正式 API；约定上文件名带插件域前缀即可（例如 `<DSH_HOME>/next-message-predictor/ledger.json`）。
- 不要写 `<DSH_HOME>/storages`（后端域数据保留给 domain 系统，见 §6.1）和 `<DSH_HOME>/sessions`（会话持久化归 `dsh-session-persistence-jsonl`，`A:dsh-base/cordis.patch.yml:138-141` root=`dshHomePath('sessions')`）。
- 原子写：Node 自带 temp+rename 足够；运行时内部还有 `@deepseek-ai/dsh-atomic-write`（`withFileLock`/`writeFileAtomic`，`A:dsh-config-editor/lib/index.js:8,72,122`），但它不是面向第三方插件的公开 API，跨包解析未验证 → 不要依赖。
- 预算账本建议：每次派发前先写"预留"再调用模型；写失败则不派发（方案 6.3 的取舍与宿主无关，完全由插件实现）。

### 6.3 不要用的持久化方式

- `session.append(...)` / `appendPluginRecord(...)`：前者会写进用户会话日志（方案明确禁止把预测写会话；且写权受 `publicationEntry`/announcement 约束，`A:dsh-session/lib/index.js:1572-1582`）；后者明确"Plugins outside this repository must not call it either"（`R:dsh-session/README.md:72`）。
- 直接改 profile 的 `cordis.patch.yml`/`package.json`：只有 configEditor 有权（且它做锁、校验、回滚）；`A:dsh-agent-preset/skills/cordis-plugin-development/references/host-plugin.md:66-77`。
- 把预测/账本挂到 `settings.yaml` 或 localStorage 作为第二权威（方案 9.1 已禁）。

---

## 7. 未确认 / 不可满足的能力清单（供功能安全降级）

| # | 能力 | 结论 | 证据/原因 | 降级建议 |
|---|---|---|---|---|
| 1 | Host 感知客户端视图/焦点/IME/菜单/草稿 | **unsatisfiable（Host）** | 这些只在 Client 侧；Host 无对应服务/事件（`I:Service` 目录无此类；方案把该职责划给 Client） | 由 Client 校验；Host 只验证会话/anchor/配置 |
| 2 | Host 识别"哪个窗口/标签页/视图" | **unsatisfiable** | exact fetch route handler 无 peer 参数（`I:Service/connection`）；所有浏览器连接共享单一 owner `browserPeer`（`A:dsh-client-connection/lib/index.js:709-714,742-750`）；`viewId` 只能由 Client 自报、不可信 | 多标签去重靠 Client BroadcastChannel + Host requestId/结果键共享；不把 viewId 当权限 |
| 3 | 宿主原生的 `branchEpoch` / `contextRevision` | **unsatisfiable（无原语）** | `I:Service/sessions` 只有 live surface `{nodes,replaceGeneration,contentGeneration}`；`sessionQuery` 快照只有 `capturedThroughSeq/inheritedEventCount` | 适配层构造：`sessionId + inheritedEventCount + turn/end.seq (+ live generation)`；重启后只用 seq 身份 |
| 4 | Host 侧"当前分支是否被回退/重生成"的显式信号 | **partial** | UI 侧回退/重生成= fork 成新 session（`R:dsh-api-session-controller/README.md:67`）；in-session 只有 compaction 等 surfaceOp replace（`R:dsh-session/README.md:52,163`） | anchor 里比较 `sessionId` + seq + live generation；fork 必然换 id，天然不命中 |
| 5 | 会话级访问控制（非 owner / 共享会话） | **partial/unsatisfiable for plugin route** | Host 服务没有 per-principal 过滤；插件路由拿不到 peer，无法自行授权；当前唯一边界是宿主 owner-only（§4.1） | 首版只支持 owner；未来共享会话需改造为 Remote/remote-access 体系（不在本插件范围） |
| 6 | 文本 token 单价 / 费用金额 | **unsatisfiable** | `I:Service/llm` 无文本价格 API；只有 `imageRequestPricing` | 只报 usage；金额仅当用户自配价格表时估算并标注来源 |
| 7 | 物理尝试序号/次数（区分"一次 request"与"一次 HTTP attempt"） | **partial** | `StreamChunk` 无 attempt 元数据；文本路径无宿主重试（§5.3），一次调用≈一次请求；provider 内部是否隐藏重传不可观测 | 计数按 `stream()` 调用；文案用"请求"不用"尝试" |
| 8 | 精确 tokenizer（输入 token 精确预算） | **unsatisfiable** | 只有 `ctx.tokenMeter` 启发式（`I:Service/tokenMeter`，`estimateMessage`/`measure` 文档称 heuristic） | 字符+启发式双上限；记录"估算"，依赖模型返回的真实 usage 事后校准 |
| 9 | 共享/只读会话的语义 | **partial** | session store/query 不区分；`ShareViewerPrincipal` 存在但只在 Remote/API 层（`A:dsh-llm/lib/typert.host.js:528` `PrincipalMap` 含 `share-viewer`） | 首版路由 owner-only 已排除 share viewer；不承诺共享会话 |
| 10 | 关闭插件时"取消在途模型调用" | **confirmed 可实现** | 插件 effect 释放时 abort 自己的 AbortController；`llm/stream` 会以 aborted finish 结束；路由 request.signal 也会在客户端断开时 abort | 在 `ctx.effect` disposer 中 abort 所有在途 + 清理 timer |
| 11 | "预测调用不会写入会话/不进模型面" | **confirmed 可保证**（只要不用 session.append/不传 sessionId） | 辅助调用只是 `llm.stream`；`GenerateOptions.sessionId` 不传，则 checkpoint-policy/标题插件都不介入（§5.3） | 代码审查 + 监测 route 不调用 session.append |
| 12 | 与已有预测插件 `dsh-composer-prediction` 冲突检测 | **partial（无宿主 API）** | 无"已注册预测器"注册表；只能检查 profile 依赖/包名或 Client 侧 DOM 占用 | 方案 10.4：首版在设置中说明冲突，试用 profile 二选一；不做自动卸载 |

### 7.1 明确禁止使用 / 不得依赖的 API

| API / 行为 | 原因与证据 |
|---|---|
| `session.eventAt()`, `session.snapshotEvents()`, `session.ownEvents()` | 新生产代码被明令禁止（`R:dsh-session/README.md:64`）；用 `ctx.sessionQuery.readSession/readSurface` 或 `session.deriveMessages()` |
| `ctx.settings.register(ns, schema)` | 0.2.x 已删除（`P:dsh-composer-prediction/lib/index.js:30-37`；`P:qq-mode-console/lib/index.js:6-22`） |
| `agent/turn-stopping` 里等待/做预测 | 串行 await 且排在 `turn/end` 之前（`A:dsh-agent-loop/lib/index.js:790-797,819`；`I:Event/agent/turn-stopping`）→ 会延迟主回合结束 |
| `agent.session` / `ReactLoopAgent` 内部字段 | `ctx.agents.get()` 公开类型只有 `{id}`（`I:Service/agents`；`R:dsh-agent/README.md:134`）；取 Session 用 `ctx.sessions.get()` |
| `session.append(...)` / `appendPluginRecord(...)` | 会把预测写进用户会话；且 `appendPluginRecord` 明确禁止外部仓库调用（`R:dsh-session/README.md:72`） |
| `ctx.settings.update/replace/mutate` 写非 volatile 字段 | 会抛 `"Config field … is not volatile"` / `"has no volatile fields"`（`A:dsh-settings/lib/index.js:501-537`） |
| `ctx.webServer.register(...)` 直接挂业务路由 | 不自动鉴权/owner 检查，必须手写 `connection.admit/requestRejection`；方案已禁止"无认证路由"（`I:Service/webServer`,`I:Service/connection`） |
| `ctx.connection.rpc.handle(...)` 作为首选 | 内部信封协议 + 仅 webServer 存在时可用；参考插件只把它当旧运行时 fallback（`A:dsh-client-connection/lib/index.js:855-916`；`P:dsh-composer-prediction/lib/index.js:127-137`） |
| 在 `session/event` 回调里做同步长计算，或把重活放在回调的同步段 | 回调由 `commit()` 同步调用，其**同步段**会阻塞当前 append（`A:dsh-session/lib/index.js:1589-1608`）；`await` 之后的后续不会被 await（Promise 仅被 catch 记日志），且异常不会传播给 append。重活应交给队列/定时器（方案 250 ms 静默期） |
| 把 Client 传来的 `messages`/对话内容送模型 | 方案 2.1 明确禁止；Host 必须用 `ctx.sessions/sessionQuery` 读权威会话 |
| 传 `GenerateOptions.sessionId` 给辅助调用 | 会被 checkpoint-policy 当作主循环请求 flush 会话；标题插件也只对 loop 请求生效——不传最干净（`A:dsh-session-checkpoint-policy/lib/index.js:61-65`） |
| 依赖 `@deepseek-ai/*` 在普通 `node` 下的解析 | profile 目录直接 resolve 失败（本机实测 `ERR_MODULE_NOT_FOUND`）；只能在 DSH 运行时内按现有插件同款声明 |
| 写 `<DSH_HOME>/sessions` / `<DSH_HOME>/storages` | 属于 session-persistence / storage backend 的保留目录（`A:dsh-base/cordis.patch.yml:138-141,182-190`） |

---

## 8. 方案第十四节证据核对（逐条）

| 方案原条目 | 核对结果 | 备注 |
|---|---|---|
| `dsh-agent-loop/lib/index.js` 791、819：串行等待 turn-stopping 后 append turn/end | **confirmed** | `:791` `await this.dispatch.serial("agent/turn-stopping", {turn, signal})`；`:819` `this.session.append("turn/end", {turn, reason: turnEnds})`，位于 `finally`（`:817-826`）；另有 `:949-955` assistant/message 先于 turn/end |
| `dsh-client-connection/lib/index.js` 742、830、1049：认证与 Host/Origin；Fetch 路由 owner；/api 准入链 | **confirmed** | `:742` `admit(request)` 起点；`:743` isTrusted→403；`:746-749` browserAuth cookie/API token；`:830` `peer.principal.kind !== "owner"` → 403；`:1049` `/api` handler 内 `const admission = connection.admit(req)`，`:1055` 才进 bridge |
| `dsh-client-ui-conversation/lib/client.js` 15119/15370/15374/16050：插入/撤销/draftRev/快照 | 未核对（Client 侧档案范围） | 本档案不覆盖 client bundle |
| 同文件 22966：overlay list/session 声明 | 未核对（Client 侧） | 同上 |
| `dsh-settings/lib/index.js` 470、479：update 合并 vs replace 替换语义 | **confirmed** | `:470-473` `update` = `mergeLayers(current, input)`；`:479-482` `replace` = `mergeLayers(base, input)`（重置本层后写）；CAS 在 `:511` |
| Desktop 与 dsh 核心版本 0.2.2-rc.1 | **confirmed** | `dsh/node_modules/@deepseek-ai/dsh/package.json` 与 `dsh/package.json` 版本均为 0.2.2-rc.1（Design 文档同）；本 session 运行环境亦为 Desktop 0.2.2-rc.1 |

核对中新增/修正（相对方案）：

- `Session.eventAt/snapshotEvents/ownEvents` 已被官方 README 标为 **deprecated / 新生产代码禁止** → 方案 4.1"读当前分支事件"的实现应改为 `ctx.sessionQuery` 或 `session.deriveMessages()`（这是对方案的重要修正）。
- `ctx.settings` 无 `register`，且**设置命名空间=loader entry id**、**只有 volatile 字段可编辑**（方案 9.1 的"原生 Config 表单"成立，但需按此约束声明 schema）。
- `ctx.agents.get()` 只承诺 `{id}`；不要按具体 loop agent 字段取 Session（用 `ctx.sessions.get`）。
- 直连 `ctx.llm.stream` 无重试（不只是"可禁用"），无需实现 per-call 关闭。
- `connection.fetch` 路由由宿主 owner-only 强制、handler 无 peer；请求体 8 KiB 限制必须用 streaming 模式自限，宿主 buffered 会先吃最多 300 MiB。

---

## 9. 残留不确定项（P1/P2 实施前需在 scratch profile 验一下）

1. **profile 插件对 `@deepseek-ai/schemastery` / `@deepseek-ai/dsh-storage-domain` / `zod` 的解析与实例身份**：现有插件（dsh-context、qq-mode-console）能跑，但直接 `node` resolve 失败；安装形态（bundle vs link）可能影响依赖安装。→ 用真实 loader 加载一次插件并检查 `Config.listConfigs` 出现本插件 row（status `schema`）。
2. **`.volatile()` 是否为安装到 profile 的那份 schemastery 的可用方法**：qq-mode 的记录说明不一定。→ 实现用 `.extra('volatile', true)`，或按 dsh-context 的 `R()` 防御包装。
3. **`connection.fetch.register` 的 `requestBody:'streaming'` 下，插件自限读 8 KiB 后立即响应 413 的实际行为**：bridge 会在响应后 `req.destroy()` 并把 `connection: close`（`A:dsh-client-connection/lib/index.js:89-113`）。→ 用真实浏览器 fetch 做一次 9 KiB 拒绝 + 正常 200 的 smoke。
4. **`ctx.sessions.get()` 对"刚 turn/end、agent 仍在 running"会话的稳定性**：Agent 在 `session/event` 回调内一定还在 store 中；但 250 ms 后用户可能已切会话/继续输入，必须用 `stillAtAnchor` 再验（§2.4）。
5. **冷会话/重启后手动预测**：`sessionQuery.readSurface` 的 `capturedThroughSeq` 是否严格等于目标 `turn/end.seq`（预期是；README 说 "capturedThroughSeq … last sequence number included"）。→ smoke 一次冷读。
6. **多标签页**：Host 无法区分窗口（§7 #2）→ 方案 6.2 的"广播去重"必须由 Client 完成，Host 只能做 requestId 幂等与结果共享。
7. **`settings/document-updated` 的 ns 类型**是 branded `SettingsNamespace`，实际就是 entry id 字符串；Host 订阅时按字符串比较即可（`I:Event/settings/document-updated`）。
8. **模型 reasoning effort 能力表**：`resolveModelInfo` 给出的 efforts 列表没有"代价/是否最低"语义；方案 8.2 的"最低 effort"需自建映射并在设置中显示实际选择（`partial`）。

---

## 10. 给实现阶段的最小检查清单（P1 验收点，Host 侧）

- [ ] `cordis.patch.yml` 插入 row：`id: next-message-predictor`（= 设置命名空间），`name: <包名>`；插件导出 `apply`、`inject`、`Config`。
- [ ] `Config` 每个字段 `.extra('volatile', true)`；`Config.listConfigs` 中该 row `status:"schema"`。
- [ ] `ctx.on('session/event', ...)`：仅 `turn/end` 且 `reason.kind === 'completed'` 才抓 anchor；aborted/blocked/error/max-tokens/interrupted/forked 零请求。
- [ ] 路由 `POST /api/next-message-predictor/rpc`（`connection.fetch.register`，`requestBody:'streaming'`，8 KiB 上限，415/400/413/200 JSON）。
- [ ] 每个 predict 请求：`enabled`、content-type、schemaVersion/operation、anchor 是最后事件、sessionId 是 live、`stillAtAnchor` 双检。
- [ ] P1 返回固定假建议；不 import `ctx.llm`；不发任何模型请求（可加计数器断言 0）。
- [ ] 插件卸载：effect 释放路由/timer/在途 abort；无全局 capture 键盘监听（键盘属 Client）。
- [ ] 不写会话日志、不写 profile 文件、不调用 `ctx.settings.register`/弃用的 session 读取 API。

（P2 追加：`prepareCall` 校验 `maxTokens`/effort；`finish.kind === 'stop'` 才解析；usage 记录；abort/超时不重试；预算账本先写预留再派发；结果缓存键含 session+turn seq+config revision+prompt version。）
