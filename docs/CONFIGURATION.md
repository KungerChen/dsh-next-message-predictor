# 配置参考

适用版本：0.4.1。配置的唯一来源是 `src/shared/config.js`（`DEFAULT_CONFIG`、取值范围）和 `src/shared/presets.js`（模式）。

配置保存在 DSH profile 中本插件的 loader 条目（id `next-message-predictor`）下。通常在设置页修改；也可以在 profile 的 `cordis.patch.yml` 里写：

```yaml
- id: next-message-predictor
  config:
    enabled: true
    manualOnly: false
    sidebarEntry: true
```

未写的字段取默认值。类型或范围不合法的字段不会被悄悄替换成别的值：该字段取默认值，问题列在设置页“高级选项 → 诊断信息 → 配置错误”里。未知字段同样会被报告。

## 全部选项

“设置页范围”是设置页允许输入的范围；手写配置时存储层接受的范围略宽，见 `NUMBER_FIELDS`。

### 基础

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `enabled` | 布尔 | `false` | 总开关。关闭时不显示建议、不调用模型。 |
| `manualOnly` | 布尔 | `false` | `true` 时回答结束后不自动预测。设置页以反义显示为“回答结束后自动预测”。 |
| `showPredictButton` | 布尔 | `true` | 输入框为空时在右侧显示“预测”按钮。 |
| `predictShortcut` | 字符串 | `Alt+Backslash` | 写法 `Ctrl+Alt+Shift+Meta+<KeyboardEvent.code>`。必须含 Ctrl、Alt 或 Meta；主键不能是 Tab、Escape、Enter、Backspace、Delete 或方向键；Ctrl 或 Meta（不带 Alt）加编辑键（A、C、V、X、Z、Y、F、S、P、R、W、T、N、Q、L）不可用。 |
| `sidebarEntry` | 布尔 | `false` | 在 DSH 左侧栏的入口列表中显示“消息预测”入口。 |
| `language` | 字符串 | `auto` | 插件自身文字的语言。`auto` 跟随 DSH 的界面语言；也可以是 `zh`、`en`、`ja`、`ko`、`es`、`fr`、`de`、`ru`、`pt` 之一。不影响建议本身的语言。 |

### 建议来源

| 字段 | 类型 | 默认 | 设置页范围 | 说明 |
|---|---|---|---|---|
| `habitSuggestions` | 布尔 | `true` | | 同一会话里重复发过的短消息直接作为建议，不调用模型。 |
| `habitMinCount` | 整数 | `2` | 2–5 | 短消息至少出现几次才算常用短句。 |
| `multiCandidates` | 布尔 | `true` | | 手动预测一次调用返回多条候选。自动预测始终一条。 |
| `candidateCount` | 整数 | `3` | 2–5 | 多条候选时一次返回几条。 |

### 模型

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `modelMode` | `fixed` \| `session` | `fixed` | `fixed`：使用下面指定的模型；`session`：跟随完成该回合的会话模型。 |
| `provider` | 字符串 | `deepseek-official` | 模型服务商 ID。`fixed-test` 是离线测试路径（不调用模型）。 |
| `model` | 字符串 | `deepseek-flash` | 模型 ID。 |
| `reasoningEffort` | 字符串 | `off` | 推理强度档位。空字符串表示自动选择（优先 off / none / minimal / low，否则取模型的第一档）。只对指定模型严格校验；会话模型不支持该档位时退回自动选择。 |

指定模型不可用（服务商或模型未配置）时，本次预测回退到会话的默认模型，不重试。

### 触发与次数

| 字段 | 类型 | 默认 | 设置页范围 | 说明 |
|---|---|---|---|---|
| `triggerDelayMs` | 整数 | `250` | 0–30,000 | 回答结束后等待多久再自动预测（毫秒）。 |
| `autoWindowMinutes` | 整数 | `30` | 5–240 | 回答结束超过该时长不再自动预测（含窗口重新获得焦点后的补发）。手动预测不受限。 |
| `manualLimit` | 整数 | `3` | 1–5 | 每次回答最多调用模型做几次手动预测。次数记在 `ledger.json`，保存设置或重启 DSH 后不重新计数（24 小时后清除）；调低后对已用过的回答立即生效。高于 3 时设置页提示费用风险。 |

### 发送内容

| 字段 | 类型 | 默认 | 设置页范围 | 说明 |
|---|---|---|---|---|
| `contextMessages` | 整数 | `12` | 2–40 | 发送的最近消息条数上限。高于 20 时提示。 |
| `targetInputTokens` | 整数 | `2000` | 1,000–16,000 | 单次预测输入的估算 token 上限，包含固定的任务说明（约 700 token）和对话片段。超出时保留最近内容并截断，片段不会超过这个上限。高于 4,000 时提示。 |
| `maxContextCodePoints` | 整数 | `6000` | （不单独显示） | 对话片段的字符上限。设置页修改 token 上限时自动设为其 3 倍（最多 60,000）。 |
| `includeTurnFacts` | 布尔 | `true` | | 附带一行上一回合的统计（工具调用、文件修改、测试命令的次数），不含正文。 |
| `redactSecrets` | 布尔 | `true` | | 发送前遮蔽疑似私钥、密钥、令牌、密码、邮箱、手机号、身份证号和个人文件夹路径中的用户名，范围见 [PRIVACY.md](PRIVACY.md#发送前的遮蔽)。关闭需在设置页二次确认。 |

### 输出与限额

| 字段 | 类型 | 默认 | 设置页范围 | 说明 |
|---|---|---|---|---|
| `maxSuggestionGraphemes` | 整数 | `60` | 20–400 | 建议最大长度（字）。超过则丢弃，不截断。 |
| `maxOutputTokens` | 整数 | `96` | 32–2,048 | 单次预测的输出 token 上限。多条候选时自动提高到至少 200。高于 512 时提示。 |
| `timeoutMs` | 整数 | `8000` | 2,000–60,000 | 单次预测等待模型的最长时间（毫秒）。 |
| `dailyRequestLimit` | 整数 | `200` | 1–5,000 | 每日预测请求上限。高于 500 时提示。 |
| `dailyTokenBudget` | 整数 | `500000` | 10,000–20,000,000 | 每日 token 上限。按三部分之和比较：服务商报告的用量（输入、输出、推理）、用量没有返回的调用的估算、进行中调用的预留。高于 1,000,000 时提示。 |
| `budgetTimeZone` | 字符串 | `''` | （不显示） | 计算“每日”的 IANA 时区。空字符串表示跟随系统时区。 |

### 其他

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `announceSuggestions` | 布尔 | `true` | 建议出现时向读屏软件播报一次。 |
| `fakeSuggestion` | 字符串 | `''` | 离线测试用的固定建议，仅在 `modelMode: fixed` 且 `provider: fixed-test` 时使用。 |
| `fakeSuggestionDelayMs` | 整数 | `0` | 离线测试时模拟的延迟（0–30,000 毫秒）。 |
| `requestBodyLimitBytes` | 整数 | `8192` | 插件路由接受的请求体上限（1,024–1,048,576 字节）。 |

## 模式取值

模式是一组选项的命名组合。三种模式设置的字段完全相同，所以互相切换是确定的，当前配置属于哪个模式也可以从配置反推（`matchPreset`）。

| 字段 | 均衡 `balanced` | 省流 `saver` | 高质量 `quality` |
|---|---|---|---|
| `manualOnly` | `false` | `true` | `false` |
| `modelMode` | `fixed` | `fixed` | `session` |
| `multiCandidates` | `true` | `true` | `true` |
| `candidateCount` | 3 | 3 | 3 |
| `manualLimit` | 3 | 2 | 3 |
| `contextMessages` | 12 | 6 | 20 |
| `targetInputTokens` | 2,000 | 1,200 | 4,000 |
| `maxContextCodePoints` | 6,000 | 3,600 | 12,000 |
| `maxOutputTokens` | 96 | 96 | 160 |
| `timeoutMs` | 8,000 | 8,000 | 15,000 |
| `dailyRequestLimit` | 200 | 60 | 200 |
| `dailyTokenBudget` | 500,000 | 150,000 | 1,000,000 |

“均衡”等于出厂默认值，因此全新安装时显示为“当前模式：均衡”。

切换模式时写入的补丁由 `presetPatch(id, config)` 生成，除上表外还有两条保证结果可用的规则：

1. 目标模式是指定模型（均衡、省流），而当前 `provider` 或 `model` 为空，或 `provider` 是 `fixed-test`：同时写入推荐路由 `deepseek-official / deepseek-flash` 和 `reasoningEffort: off`。已有路由时不动。
2. 目标模式是仅手动（省流），而 `showPredictButton` 为 `false`：同时写入 `showPredictButton: true`，保证有一个看得见的触发方式。

模式从不写入 `enabled`、`predictShortcut`、`sidebarEntry`、`language`、`habitSuggestions`、`redactSecrets`、`includeTurnFacts`、`announceSuggestions`、`fakeSuggestion`。这些约束由 `test/v030.test.mjs` 和 `test/i18n.test.mjs` 检查。

## 配置版本

后台对生效配置计算一个 32 位指纹（`configRevision`）。每个预测请求带上发出时的指纹；配置在请求途中变化时，后台回答“设置刚刚发生变更”，页面重新读取配置，不显示过期结果。
