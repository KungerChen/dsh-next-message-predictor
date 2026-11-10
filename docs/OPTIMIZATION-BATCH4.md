# 第 4 批体验优化记录（O06 / O07 / O08）

对应 PLAN 第 4 批：**O06 交互小改进、O07 运行时冲突检测、O08 回合事实摘要**。
验收：P1 矩阵加新用例；单测全过；保持绝不自动发送。

## 1. O06 右方向键填入

- 当草稿为空、光标在输入框开头、且当前 ghost 建议可用时，**右方向键**也可以把建议填入草稿（与 Tab 相同的原生 `captureInsertion` + `insertText` 路径，绝不发送）。
- 非空草稿、光标不在开头、IME 组合、菜单/弹窗打开、非本插件输入框等情况下不拦截，正常光标移动不受影响。
- 弃权或失败仍然不显示任何 UI；原因只在设置页诊断中查看（已满足，未新增打扰）。
- P1 新用例 `arrow-adopt`：完成回合 → ghost 出现 → 按 ArrowRight → 草稿为完整建议、ghost 消失、无 prompt 请求。

## 2. O07 运行时冲突检测

- 客户端启动后立即检测 + 每 2 秒轮询：
  - 页面存在 `[data-composer-ghost]` 且其值不是本插件标记（`GHOST_MARKER='dsh-next-message-predictor'`）；
  - 或存在旧插件的 `window.__composerPredict` 全局。
- 检测到冲突 → `runtime.noteConflict(source)`：停止请求、清空 ghost、状态置为 `conflict`（不打扰用户）；设置页诊断显示“检测到其他幽灵文字插件，本插件已让位”。
- 冲突源消失后自动恢复（`clearConflict`），后续回合可继续预测。
- **修复了一个真实 bug**：最初检测时用 locale 命名空间 `NS='next-message-predictor'` 与幽灵标记 `'dsh-next-message-predictor'` 比较，导致插件把自己的 ghost 误判为冲突（P1 IME 步骤偶然暴露）。现统一使用 `GHOST_MARKER`，并补单测。
- P1 新用例 `conflict-yield`：向页面注入 `data-composer-ghost="other-plugin"` → 2 秒内进入 `conflict`、ghost 消失；移除后恢复。

## 3. O08 回合事实摘要

- `noteEvent` 在运行中按会话/回合累积 `tool/call` 事实（只读 `data.turn`、`data.name`、`data.arguments` 用于分类，**不保留、不输出参数正文**）：
  - 工具调用次数；
  - 文件修改类工具（edit/write/apply_patch/patch/str_replace/multi_edit/create_file/delete_file）次数；
  - 测试命令（npm/pnpm/yarn/bun/jest/vitest/pytest/go/cargo/dotnet/mvn/gradle/node --test 等）次数。
- 冷会话/插件重启后的回合：`read()` 在需要时读取一次会话日志并直接扫描统计（不再依赖 live 缓存）。
- `formatTurnFacts` 生成一行中文事实，例如：`本回合 12 次工具调用；修改文件 3 次；未观察到测试命令。`
- `buildPredictionInput(messages, { turnFacts })` 把该行放在对话记录之后、预测指令之前；`trimMessages` 的预算计算包含该行。
- 这样“跑一下测试”“先看下 diff”这类预测有了事实依据，且上下文不含工具输出正文。
- 单测：`summarizeTurn` 统计、`formatTurnFacts` 文本、`read()` 注入事实行、`buildPredictionInput` 兼容无 facts 的旧调用。

## 4. 验证

| 项目 | 结果 | 证据 |
|---|---|---|
| `node --test` | **144/144 通过** | 命令输出 |
| P1 交互矩阵（13 项，含 arrow-adopt、conflict-yield） | **13/13 通过** | `scratch/evidence/batch4-p1-report.json`、`batch4-p1-09-arrow-adopt.png`、`batch4-p1-10-conflict-yield.png` |
| P2 模型链路（mock） | **9/9 通过** | `scratch/evidence/batch4-p2-report.json` |
| 零发送审计 | P1/P2 均通过，`sendCalls=0` | 各报告 |
| 构建 | `lib/client.js` 已重建（117,199 bytes） | `scripts/build-client.mjs` |

## 5. 已知限制与后续

- O07 轮询间隔 2 秒，冲突出现/消失最多有约 2 秒延迟；冲突恢复后当前已完成回合不会自动补发（`servedAuto` 已用），下一回合正常。
- O08 摘要依赖 `tool/call` 事件形状（`data.turn/name/arguments`）；不同工具名分类可能漏判（如通过 shell 执行的测试需命令特征匹配）。
- 摘要行会占用少量上下文预算（约 20–30 token）；无工具调用时不注入。
- 四批（第 1–4 批）代码均已完成；尚未完成的是人工评分（方案 §十二）与桌面 3–7 天自然使用观察。
- 桌面 DSH 尚未重启；重启后加载全部批次与新的默认固定路由（deepseek-flash / 关闭推理 / maxTokens 96）。
