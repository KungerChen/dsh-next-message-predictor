# P1 无模型交互验证记录

> P2（真实模型链路）、P3（质量/成本评测）、P4（真实模型试用）与最终复测见 `docs/VALIDATION-P2P4.md`。

目标：用固定假建议完成 overlay、采纳、撤销、IME、菜单、多输入框和卸载验证；编辑器端到端通过，**发送接口调用次数为零**。

环境：DSH `0.2.2-rc.1` 的独立 `predictor-scratch` profile（从 shipped web 模板创建，不改动 desktop/web/headless），隔离 Web GUI `127.0.0.1:3090`，本地 OpenAI 兼容 mock 模型 `127.0.0.1:3091`（`mock`/`mock-1`，固定回复“收到（mock-1）”）只用于产生“真实完成的助手回合”；预测链路本身不调用模型。

工具：

- 启动/停止：`tools/launch-scratch-web.ps1` / `tools/stop-scratch-web.ps1`
- mock 模型：`tools/mock-llm.mjs` / `tools/mock-llm-control.ps1`
- 浏览器驱动（P0 装载）：`tools/dsh-driver.mjs`
- P1 交互矩阵：`tools/p1-e2e.mjs`（`matrix` / `uninstalled` 两种模式）
- P1 配置开关：`tools/p1-config-toggle.mjs`
- 回合数据诊断：`tools/debug-probe.mjs`

复现：

```powershell
# 前提：scratch web 与 mock LLM 已启动；profile 插件已安装并 seed enabled=true
$u = (Get-Content scratch\logs\web-3090.url.txt -Raw).Trim()
node tools/p1-e2e.mjs --url $u --out scratch/evidence --tag p1
node tools/p1-config-toggle.mjs --url $u --out scratch/evidence
# 卸载清理：先 dsh plugin remove 并重启，再：
node tools/p1-e2e.mjs --url $u --out scratch/evidence --tag uninstall --mode uninstalled
```

## 验收矩阵与结果

2026-11-09 实测：**矩阵 10/10 通过**，配置开关通过，卸载清理通过。证据在 `scratch/evidence/`。

| # | 场景 | 断言 | 结果 | 证据 |
|---|---|---|---|---|
| 0 | 安装与装载 | Host `host ready` 日志、`status` RPC `ok:true`、`window.__nextMessagePredictor` 存在、`[data-nmp-anchor]` 位于 `[data-composer-overlay]` | 通过 | `p1-00-loaded.png`、`p1-report.json` |
| 1 | 正常完成回合自动触发 | mock 回合 `running` true→false 后出现且只出现一条灰色建议；建议在 contenteditable 之外（`data-composer-ghost` 标记）；原生 placeholder 被隐藏；`placeholder` 元素带本插件标记 | 通过（建议=“固定测试建议：继续第二项”） | `p1-01-ghost-visible.png` |
| 2 | Tab 采纳 | 建议完整进入草稿（`draftText == 建议正文`）；`status=accepted`；Host `accepts` 计数 +1；采纳后 1.2s 内无 `session/prompt` HTTP 请求、无 prompt WebSocket 帧；`sendCalls=0` | 通过 | `p1-02-tab-adopted.png` |
| 3 | Ctrl+Z 撤销 | 草稿回到空；只撤销本次插入；已采纳回合不再复活建议（`status` 保持 accepted） | 通过 | `p1-03-undo-empty.png` |
| 4 | Esc 忽略 | 建议消失；同回合 900ms 内不复活；`status=dismissed`；placeholder 恢复 | 通过 | `p1-04-esc-dismissed.png` |
| 5 | 中文 IME | `Input.imeSetComposition` 期间 `data-composer-composing` 为真、ghost 隐藏；组词期间 Tab 不采纳；提交后清空草稿不复活建议 | 通过 | `p1-05-ime-suppressed.png` |
| 6 | `/` 菜单 | 输入 `/` 后 `[data-trigger-menu]` 出现、ghost 隐藏；Tab 交给原生菜单，不采纳建议 | 通过 | `p1-06-menu-guard.png` |
| 7 | 多输入框 | 焦点在另一个输入框时 ghost 隐藏、Tab 不拦截；回到 composer 后同一有效建议恢复展示 | 通过 | `p1-07-multi-input.png` |
| 8 | placeholder 恢复 | 建议结束/撤销后 `data-nmp-placeholder` 标记与 inline visibility 均恢复 | 通过 | `p1-report.json` |
| 9 | 卸载清理 | 卸载并重启后：无 `[data-nmp-anchor]`、无 ghost、无 `window.__nextMessagePredictor`、插件路由 404 | 通过 | `uninstall-report.json`、`uninstall-99-uninstalled.png` |
| 10 | 零发送（代码路径） | 浏览器半源码无 `submit(` / `session/prompt` / `sendSession` / `beginSubmission` 调用 | 通过 | `p1-report.json` `codePath` |
| 11 | 配置关闭 | 经 `config.set` 关闭 `enabled` 后 Host 重启、`status` 显示 `enabled=false`、ghost 立即消失；关闭状态下完成一个回合仍不出现 ghost；恢复 `enabled=true` 成功 | 通过 | `config-toggle-report.json`、2 张截图 |

## 汇总数字

- 单元/集成测试：P1 阶段 51 项；P2 完成后最终 **90 项全部通过**（共享协议/配置/提示词/输出校验、Host service、Host 插件入口、Client controller 状态机与竞态、上下文构建、模型调用、持久账本）。
- P1 矩阵：10/10 步骤通过；`pageErrors` 为空；仅插件自身 `client ready` 控制台日志。
- 零发送审计（Tab 采纳窗口）：`sendCalls=0`；新增 HTTP 请求 3 个（均为本插件 `accepted`/`status` 路由）；新增 WebSocket 发送帧 **0**；无任何 `session/prompt`。
- Host 诊断：`requestsReceived=5`、`productionTasks=5`、`offers=5`、`providerCalls=5`、`accepts 2→3`，`sendCalls=0`（该轮运行前的累计值；计数在 Host 重启后清零，符合 P1 内存实现）。
- 配置开关：`config.set` 两次均 HTTP 200 且 `restarted:true`，`configRevision` 关闭后 1776090920、恢复后回到 1064797471。

## P1 实现过程中发现并修复的问题（真实契约修正）

1. **Host 插件 `inject` 被 loader 丢弃**：`@deepseek-ai/cordis-plugin-loader` 的 `unwrapExports` 用 `exports = exports.default ?? exports` 归一化入口；本插件原 `export default { apply }` 使 named `export const inject = ['connection']` 失效，`apply` 在 carrier 就绪前执行，日志报 `connection.fetch is unavailable`。修复：default 对象同时携带 `apply` 与 `inject`。
2. **placeholder 选择器**：composer 占位符是 `[data-composer-placeholder]`（编辑器自身另有 `data-placeholder`）。初始实现用 `[data-placeholder]` 会误隐藏编辑器 root；已按 P0 契约改为选择真正的 placeholder 元素，并保存/恢复 inline visibility。
3. **采纳终态被草稿变化覆盖**：原生插入后草稿变为非空，controller 的“用户编辑 → suppressed”分支会把 `accepted` 覆盖成 `suppressed`。修复：同回合的 accepted/dismissed/failed 终态不被该分支覆盖（新增单测覆盖）。
4. **完成回合识别依赖 `legacy.turnEnds` + assistant 节点 `turn/seq`**：实测 confirm `turnEnds=[[1,20]]`、assistant `{turn:1, seq:17}`；据此排除 `turn-error`/`turn-max-tokens`/`interrupted` 行。客户端仍看不到 `turn/end.reason.kind`（P2 Host 复核）。
5. **配置写入会重启 Host 插件**：`config.set` 经 `configEditor.edit` 返回 `restarted:true`，插件重建后路由恢复；客户端 `saveConfig` 会重新拉取 status。P1 将此记录为已知行为，P2 引入 `Config` volatile 后可热更新。
6. **路由请求体上限**：改用 `requestBody:'streaming'` + 自限 8 KiB 读取，超限返回 413（buffered 模式受宿主全局上限影响，无法由插件限制）。

## 已知限制与未覆盖项

1. 客户端看不到 `turn/end.reason.kind`，P1 只排除 derived 的 `turn-error`/`turn-max-tokens`/`interrupted` 行；权威复核在 P2 Host（`session/event` 的 `turn/end.reason.kind === 'completed'`）。
2. command popup 与 feedback dialog 无稳定 DOM marker，采用焦点/模态启发式并 fail-open；P1 覆盖 `/` `@` 菜单但不覆盖 command-popup/feedback-dialog 打开时的逐帧行为。
3. 多窗口/多标签共享等待者与 BroadcastChannel 同步未实现；P1 只验证单视图。宿主不提供窗口/view 身份，`viewId` 不能作为权限或去重凭据。
4. Desktop 原生窗口的输入法与快捷键未在本阶段覆盖（本阶段只验证隔离 Web GUI）。
5. 设置页 UI 的点击路径未纳入自动化矩阵；本轮通过插件 RPC 验证了同一 `config.set` 持久化链路。设置写入会通过 `configEditor.edit` 重启 Host 插件（P1 已知行为），P2 引入 `Config` volatile 后改为热更新。
6. 真实模型质量、延迟、成本属于 P2/P3，不在本文件结论内；P1 全程无模型调用（mock 仅服务主对话回合）。
7. 共享 `$DSH_HOME`：scratch profile 的调试会话会出现在用户桌面会话列表中；P0 harness 文档记录了清理方式。
