# 架构

适用版本：0.5.0。

插件分两半，各自由 DSH 加载：

- **Host 半**（Node，DSH 后台进程）：`lib/index.js` → `src/host/`。读取权威会话内容、调用模型、管理预算和统计。
- **浏览器半**（DSH 窗口）：`lib/client.js`，由 `src/shared/` 和 `src/client/` 拼接生成。负责输入框里的灰色建议、按键和设置页。

两半只通过一个 HTTP 路由通信：`POST /api/next-message-predictor/rpc`。认证、来源检查由 DSH 的 `/api` 链路完成，插件处理器在其后运行。

```text
┌──────────────── 浏览器（DSH 窗口） ────────────────┐      ┌──────────────── Host（DSH 后台） ────────────────┐
│ overlay.js   输入框覆盖层：幽灵文字、Tab/Esc/快捷键 │      │ index.js            装配、路由注册               │
│ controller.js 每个视图的状态机、去重、请求生命周期 │ RPC  │ predictor-service.js 协议、资格、去重、缓存      │
│ settings.js  设置页 / 全局面板                    │─────▶│ context-builder.js  权威上下文、脱敏、裁剪       │
│ index.js     注册 slot、语言、侧栏入口            │      │ model-provider.js   一次辅助模型调用             │
│ labels.js    原因码 → 文字                        │      │ budget-ledger.js    派发账本、每日预算（落盘）   │
│ dom.js       宿主 DOM 选择器与测量                │      │ results-log.js      结果记录、近 7 天汇总（落盘）│
└───────────────────────────────────────────────────┘      │ request-registry.js 共享生产任务与等待者         │
            共用：src/shared/                              │ semantic-filter.js  语义过滤                     │
   config · presets · protocol · prompt ·                  │ dsh-adapter.js      宿主能力适配                 │
   output-validation · version                             └──────────────────────────────────────────────────┘
```

界面语言由 `src/client/i18n.js` 和 `src/client/locales/` 负责：

- 每种语言一个文件（`locales/<语言>.js`），九个文件的键、顺序和占位符必须一致，`test/i18n.test.mjs` 检查。
- 插件用自己的翻译函数取文字，而不是 DSH 注入的 `t`：这样语言可以在本插件的设置里单独选择，也能提供 DSH 自己没有的语言。`t(key)` 在调用时读取当前语言，缺失的键退回英文。
- 当前语言的来源：配置项 `language` 是具体语言时直接使用；是 `auto` 时依次参考 DSH 正在显示的语言、`<html lang>`、浏览器语言，都不在支持范围内则用英文。DSH 的语言通过一个探针键得知：向 DSH 的语言服务注册字典时，每种语言的字典里多放一个值为该语言编号的键，再用 DSH 的翻译函数取这个键。
- 向 DSH 的语言服务只注册它自己提供的八种语言（中文和英文是它要求的基线）。
- 页面加载后要等 Host 回答才知道 `language` 的值，所以上一次的选择记在 `localStorage`（键 `dsh-next-message-predictor.language`），回答前先按它显示。
- 语言变化时，组件通过 `shellStore` 的 `language` 字段重新渲染；设置导航和左侧栏入口的名称由 DSH 在注册时读取，所以语言变化后这两个入口会重新注册一次。

## 设计原则

1. **浏览器不提供对话内容。** 请求里只有会话、回合的标识和配置版本。Host 从自己的会话存储读取要发给模型的内容，所以页面无法让 Host 发送任意文本。
2. **插件没有发送路径。** 采纳建议使用宿主输入框的原生插入接口（`captureInsertion()` + `insertText()`），结果只是草稿里的一段文字。代码中不存在提交或发送调用，诊断里的 `sendCalls` 恒为 0。
3. **失败时让位。** 任何一步不满足条件，按键都交还给宿主原有行为；只有插入确实成功才吞掉 Tab。
4. **宁可沉默。** 模型输出不是严格 JSON、超长、多行、像助手口吻或像错误信息时一律丢弃，不修复、不截断。
5. **先记账再调用。** 调用模型前把派发标记、预算预留和本回合的调用次数一次写盘；写盘失败就不调用，也不占用次数。

## 一次自动预测的流程

1. **浏览器**：`overlay.js` 每次渲染后把当前视图的快照（会话、最近完成的回合、草稿是否为空、焦点、菜单、输入法状态）交给 `controller.sync()`。
2. 控制器观察到“运行中 → 空闲”且出现了新的已完成回合，检查资格（`eligibility()`），等待 `triggerDelayMs` 后发出 `predict` 请求，带上回合锚点（`sessionId`、`turnId`、`completedEventSeq`、`contextRevision`）和配置版本。
3. **Host**：`predictor-service.handlePredict()` 校验请求；`context-builder.verifyAnchor()` 用自己观察到的 `turn/end` 事件（或读取会话日志）确认这个回合确实正常完成，且之后没有新回合、新用户消息、压缩或回退。
4. 同一回合的相同请求共用一个生产任务（`request-registry`），全局同时只运行一个。
5. 生产任务（第一条建议总是来自模型，常用短句不再代替模型调用）：
   - 读取上下文 → 脱敏 → 按配额裁剪 → 解析模型路由 → 账本预留（含本回合次数）→ 调用模型一次 → 结算用量（见“额度记账”）；
   - 输出经严格 JSON 解析（`output-validation`）和语义过滤（`semantic-filter`）；
   - 得到建议后，`localPhrases()` 在模型候选后面接上本机短语（见“候选环”）；手动预测没有得到建议时，`localFallback()` 改为只给本机短语。
6. Host 返回 `offer`（建议）、`abstain`（不给建议）、`stale`（已过期）或 `unavailable`（不可用）之一。
7. **浏览器**：控制器再次核对视图没有变化（同一回合、草稿未动、配置未变），才把建议交给覆盖层显示。显示出来后上报 `shown`；采纳（带上采纳的是环里第几条、来源）、隐藏、被覆盖、过期分别上报。

手动预测走同一条路，区别是：不受“自动预测有效时间”限制；提示词追加“用户主动要一条”；开启多条候选时一次返回多条；每次回答有次数上限（`manualLimit`）；模型没有给出建议时可以回退到本机短语。

## 候选环

一次 offer 在页面上是一个环（`protocol.offerRing()`，两半共用），“换一条”按这个顺序走：

1. 模型的候选：`text`，然后 `alternatives`；
2. 本次会话里重复发过的短消息（`habitSuggestions` 开启时，`context-builder.findHabitPhrases`，只读本机会话）；
3. 固定短语（`pinnedPhrases`）。

后两类统称本机短语，由 Host 的 `localPhrases()` 组装：每一条都过 `validateSuggestionText`；和模型候选、彼此之间按 `normalizePhraseKey`（与常用短句检测相同：去首尾空白、合并空格、去结尾标点、忽略大小写）去重；合计最多 `LOCAL_PHRASES_MAX`（5）条；放在 offer 的 `local` 字段里，每条带 `source`（`habit` / `pinned`）。本机短语从不发给模型：它们不进入提示词，也不进入 `offeredTexts`（那份列表在“换一条”时告诉模型它已经说过什么）。

两类短语都在 Host 接上，而不是由页面按配置追加固定短语，原因：

- 只有 Host 知道每条 offer 的完整环，结果记录才能按采纳的位置判断来源，并且只拿模型的候选去和用户下一条消息比较；
- 去重在一个地方按同一规则完成；
- 回退是否发生、要不要占用次数和额度，取决于模型那边的结果，这些都在 Host；
- 请求带着 `expectedConfigRevision`，Host 用的固定短语就是页面当时看到的那一份。

代价是后台不可达时没有回退，但那时本来就什么都做不了。

**页面上的切换。** 控制器在 `candidates` / `sources` 里保存整个环。按 Alt+\ 或点“换一条”先在本地往后走，不发请求；走过最后一条时，本回答还有手动次数就请求模型（和以前一样），没有了就回到第一条。`canOfferAnother()` 在环里有两条以上时总为真。按钮显示“换一条 2/5”，当前是本机短语时多一个小图标（常用短句是循环箭头，固定短语是图钉）并在悬停提示里说明没有调用模型；只要环里有本机短语，图标的位置就一直保留（看不见），切换时按钮宽度不变。

**手动回退。** 手动预测时，模型弃权、输出被拒、模型不可用、当日额度已满或本回答的手动次数已用完（`stale: already-requested`），而本机短语不为空：Host 返回 `fallback: true` 的 offer，环里只有本机短语，`text` 是第一条，`modelReason` 说明模型为什么没有给。会话已经往前走、请求被取消、后台忙、功能关闭时不回退。自动预测从不回退。“换一条”时页面已经走完了原来那条建议的环（其中已经包含这些短语），所以页面收到的回退如果没有新短语，就恢复原来那条建议，并把回退那条报告为 `closed`。

## 额度记账

`budget-ledger.js` 是唯一决定“能不能花钱”的地方。

**只为模型调用占用次数。** 生产任务开始前先占用本回合的一次机会（内存），任务结束时如果没有真正向模型发出调用，就退回：读取对话失败、路由不可用、账本没写成、当日额度已满、回合在调用前过期或被取消、调用在流开始前失败、任务意外抛错，都不占用次数。离线测试建议（`fixed-test`）代替模型，按一次调用计。本机短语（包括手动回退）从不占用次数，也不碰账本和每日额度。

**每回合次数。** 两层：`request-registry.js` 在内存里按回合记自动、手动的生产任务（包括进行中的），管本实例内的并发和重复；`ledger.json` 的 `turns` 按回合记已经调用模型的次数，和派发标记、预留在同一次原子写入里增加，“没有调用模型”的结算（`notDispatched`）里减回。保存任何设置都会让宿主在同一进程里重新 apply 本插件，内存里的次数随之清空，所以 `handlePredict` 同时查两层、取更严的一个，`reserve` 在写盘前再按持久次数核对一次（手动不超过 `manualLimit`；自动不超过 2，即一次加上 B05 允许的一次补发）。回合记录 24 小时后清除，最多 2,000 条。

**每日 token 分三类：**

| 类别 | 字段 | 含义 |
|---|---|---|
| 实测 | `inputTokens` `outputTokens` `reasoningTokens` | 服务商报告的用量 |
| 估算 | `estimatedTokens` | 已结束、用量没有（完整）报告的调用 |
| 预留 | `reservedTokens` | 正在进行的调用；结束时转为实测或估算 |

每日上限比较的是三者之和（`snapshot().usedTokens`）。预留 = 输入估算（系统提示词 + 实际发送的输入，按 `estimateTokens` 的保守估法）+ 输出上限（`maxOutputTokens`，多条候选时提高到 200 或“条数 × 65”）。结算规则在 `chargeForCall`：

| 结束方式 | 输入 | 输出 |
|---|---|---|
| 正常结束，用量完整 | 实测 | 实测 |
| 正常结束，没有用量，推理档位为 `off` 一类 | 估算 | 按收到的文字估算 |
| 正常结束，没有用量，可能有推理 | 估算 | 上限 |
| 达到输出上限、超时、取消、出错、中途断开 | 报告了就实测，否则估算 | 上限（不少于已收到的部分） |
| 进程在调用中退出（遗留预留） | 估算 | 上限 |

调用没有走到 finish 时，看不到的推理 token 和服务商已生成但没送达的部分只有上限能兜住，所以输出不按“已收到的部分”计。

**遗留预留。** 每条派发记录带着自己的预留（`reserved`）。加载账本时本进程没有任何调用在进行（同一进程内的多个实例通过 `shareWithinProcess` 共用一份状态和写队列），文件里残留的预留都属于上一个进程：整体转入估算，按派发记录计入 `unknownUsage` 和 `orphanedCalls`，写一条日志。转换不改变每日上限的计算结果。0.4.0 及更早的账本（`schemaVersion: 1`）的 `reservedTokens` 混有两种含义，加载时同样整体转入估算。

## 协议

所有操作都是同一路由上的 JSON 请求，`operation` 字段区分：

| operation | 方向与用途 |
|---|---|
| `predict` | 请求一条建议。响应带回原样的锚点和 `configRevision`，页面核对后才显示。 |
| `release` | 页面不再等待某个请求。最后一个等待者离开时生产任务被取消。 |
| `accepted` / `dismiss` | 建议被采纳 / 被 Esc 隐藏。`accepted` 可以带 `index`（环里第几条，从 0 起）和 `source`（`model` / `habit` / `pinned`）。 |
| `outcome` | 建议的其他去向：`shown`、`overwritten`、`expired`、`closed`。 |
| `status` | 生效配置、配置版本与错误、插件版本、模型路由预览、今日预算、诊断计数、宿主能力。 |
| `config.get` / `config.set` | 读取 / 写入配置补丁（经宿主的 `configEditor.edit`，写入后宿主通常会重启本插件）。 |
| `results.summary` | 近 7 天统计。 |

校验逻辑在 `src/shared/protocol.js`，两半共用。

`offer` 结果的字段：`suggestionId`、`text`、`expiresAt`，可选的 `alternatives`（模型的其他候选），以及：

- `local`：本机短语，`[{ text, source }]`，`source` 为 `habit` 或 `pinned`；
- `fallback: true`：环里只有本机短语（手动回退），此时 `text` 等于 `local[0].text`，没有 `alternatives`；
- `modelReason`：回退时模型没有给出建议的原因（仅供记录，页面可以不看）。

新旧版本混用时：旧页面忽略 `local` / `fallback`，回退时把第一条短语当作普通建议显示，采纳不带 `index`，Host 按第 0 条记来源；旧 Host 不返回这些字段，页面的环只有模型候选，页面多带的 `index` / `source` 被旧 Host 忽略；旧 Host 不认识 `pinnedPhrases`，保存会以“unknown config field”失败（设置页同时会提示版本不一致、需要重启 DSH）。

**请求体上限。** 路由按 `requestBodyLimitBytes`（1,024 – 1 MiB，默认 8,192）限制请求体，只有 `config.set` 至少允许 `CONFIG_SET_MIN_BODY_BYTES`（4,096）字节：一整张固定短语列表（10 条，每条不超过 160 字节，加上 JSON 转义）最多约 2.1 KB，上限设到最小时设置页也必须能保存它。

## 浏览器半注册的扩展点

| Slot | 内容 |
|---|---|
| `conversation.input.overlay` | 输入框覆盖层（每个会话视图一个）。 |
| `settings.section` + `settings.section.icon` | “设置 → 消息预测”页面与导航图标。 |
| `main`（key `next-message-predictor`） | 全局面板：同一个设置页，显示在主区域。始终注册。 |
| `sidebar.panellist`（id `next-message-predictor`） | 左侧栏入口。仅当配置 `sidebarEntry` 为 `true` 时注册。 |

DSH 按相同的 id 把左侧栏入口和 `main` 面板配对：点击入口即选中该面板。面板始终注册、入口按需注册，所以在面板里点“从左侧栏移除”不会把正在看的页面关掉。

两个细节：

- **入口不迟到。** 页面加载后要等 Host 回答才知道 `sidebarEntry` 的值。为避免入口每次都晚一拍出现，上一次的选择记在 `localStorage`（键 `dsh-next-message-predictor.sidebarEntry`），Host 回答前先按它注册，回答后以 Host 为准。Host 不可达时保持现状。
- **面板不被踢走。** 保存设置会让宿主重启插件；面板注销时宿主会把主区域切回会话。插件卸载时如果自己的面板正开着，就在 `window` 上留一个时间戳，重新加载后（15 秒内）重新选中面板。

`sidebar.panellist` 所在的侧栏不存在时（某些精简组合），设置页不显示“添加到左侧栏”按钮。

## 版本号

`src/shared/version.js` 的 `PLUGIN_VERSION` 是唯一来源：

- 构建时拼进浏览器 bundle，设置页标题旁显示；
- Host 在 `status` 响应的 `version` 字段中上报；
- 页面比较两者，不一致时提示重启 DSH（常见于更新文件后只刷新了页面）。0.3.0 之前的 Host 不上报版本，页面按“后台版本较旧”处理。

`package.json` 的 `version` 必须与它相同，`scripts/build-client.mjs` 和 `test/v030.test.mjs` 都会检查。

## 模式

`src/shared/presets.js` 定义三种模式和两个纯函数：

- `matchPreset(config)`：当前配置等于哪个模式，都不等返回空字符串（“自定义”）。
- `presetPatch(id, config)`：切换到该模式要写入的补丁。

设置页点击模式时调用 `config.set` 写入补丁，并记下被覆盖字段的旧值作为“撤销”补丁。Host 不知道“模式”这个概念，只看到一次普通的配置写入；因此模式不占用配置字段，也不会与手动修改冲突。

## 本机文件

都在 `<DSH_HOME>/next-message-predictor/` 下（`DSH_HOME` 默认 `~/.dsh`）：

| 文件 | 内容 | 保留 |
|---|---|---|
| `ledger.json` | 派发标记（时间、会话与回合标识、服务商、模型、是否已显示、进行中的预留）、每回合的模型调用次数（自动、手动），以及按日聚合的请求数与 token（实测、估算、预留）。不含任何文字。`schemaVersion: 2`。 | 派发标记与回合次数 24 小时（回合最多 2,000 条），日聚合 7 天 |
| `events.jsonl` | 每次请求一行：时间、各标识的哈希、触发方式、结果与原因、耗时、token、建议长度、环里各来源的条数（`nm` 模型、`nh` 常用短句、`np` 固定短语）、是否回退（`fb`）、是否来自缓存（`cached`）；以及显示、去向（采纳时带 `index` 和 `source`）和匹配分数。不含任何文字。 | 5 MB 轮换，14 天 |

建议正文只在 Host 内存中短暂保留（最多 2 小时、200 条），用于计算你下一条消息与建议的匹配分数，算完即丢弃。保存设置会让插件后台在同一进程里重启，`results-log` 和账本一样通过 `shareWithinProcess` 让新旧实例共用这份内存记录（以及写队列和文件大小），屏幕上那条建议的去向和匹配不会因此丢失；DSH 进程重启后则不再保留。同一条建议被第二次记录（另一个视图、缓存命中、重试）时不会覆盖已经记下的“已显示”和去向。

**匹配与汇总只算模型。** 用户发出下一条消息（会话日志里 `source.kind` 为 `user` 的 `user/message`）时，`noteUserMessage` 只和环里模型的候选比较（采纳的是模型的某一条时只和那一条比）；消息和某条本机短语相同时另记 `local`。近 7 天汇总里：`acceptedBySource` 分来源计采纳数；`acceptRate` 是被采纳的模型建议 ÷ 含有模型建议且显示过的建议；“采纳后未修改”只看采纳的模型建议；延迟分位数只统计调用了模型的请求（`provider` 非空且不是以前版本的 `habit`，不含缓存命中）。

环境变量 `NMP_DATA_HOME` 可把这两个文件改写到别处，隔离测试用它避免污染真实统计。

## 构建

没有打包器。`scripts/build-client.mjs` 按固定顺序读取 `src/shared/*.js` 和 `src/client/*.js`，去掉 `import` / `export`，拼进宿主要求的 `window.__ModuleLoader__.load({ id, factory })` 包装里。因此这些文件必须只含普通的顶层声明，且顶层名字在所有文件之间不能重复（构建时检查）。`src/shared/` 同时被 Host 以普通 ESM 引用，所以不能使用 Node、DOM 或 React 的接口。

## 与宿主的耦合

所有 DSH 相关的假设集中在三处，升级 DSH 时先看这里：

- `src/host/dsh-adapter.js`：路由注册、配置写入、会话存储；
- `src/client/dom.js`：输入框的 DOM 标记；
- `src/client/index.js`：slot 名称与注册参数。

逐项的契约依据见 [COMPATIBILITY.md](COMPATIBILITY.md)，原始取证见 `p0-host-contract.md`、`p0-client-contract.md`。
