# 第 2 批优化与修复记录（PLAN 2026-11-10）

对应 `PLAN.md` 第 2 批：**B01（补发）、B04（完成复核放宽）、B06（跨会话恢复/2 小时）、B07（临时失败重试）、B08（两行省略）**。
同时完成了第 1 批遗留的 **B09c 桌面残留清理**（按 PLAN 恢复 desktop bundles）。

- 版本：`0.2.1`；`lib/client.js` 已重建（113,983 bytes）
- 改动前备份：`backup-pre-batch1`（第 1 批前）+ `backup-desktop-profile`（桌面配置）
- 最终 `node --test`：**128 项全部通过**
- 验证：P1 矩阵 11/11、P2 矩阵 9/9、B08 专项通过

## 1. B01 回合结束时窗口没焦点 / 看别的会话 → 补发

**客户端（`controller.js`）**
- 新增 `pendingBySession`（最多 40 会话）：当本视图观察到“运行→空闲 + 新 turnId”但 `eligibility` 因 `window-inactive` 失败时，记录 `{turnKey, turnId, completedEventSeq, contextRevision, at}`，不再丢弃触发机会。
- 窗口重新聚焦/可见（overlay 新增 `focus`/`blur`/`visibilitychange` 监听触发一轮快照）、或切回该会话且回合仍是最新、草稿为空、该回合未自动请求过时，补发一次 `scheduleAuto`。
- `scheduleAuto` 的 waiting 状态现在保存 `completedEventSeq/contextRevision`，切走会话时也能正确记录。
- 重复聚焦、重复切回不会重复请求（`servedAuto` + pending 删除）。

**Host（`predictor-service.js` / `context-builder.js`）**
- `verifyAnchor` 返回 `completedAt`（Host 观察到的 `turn/end` 时间或日志时间），`runProduction` 在调用模型**之前**拒绝超过 **30 分钟**的补发（`stale / completion-too-old`），不浪费 token。

**单测**
- `B01: completion while the window is inactive is requested once after focus returns`
- `B01: switching to another session and back requests the pending turn once`
- `B01: completions older than 30 minutes are rejected before any model call`（Host）

## 2. B04 回合结束后追加事件不再误判过期

**`context-builder.js`**
- `noteEvent` 按会话维护 `{lastTurnEndSeq, lastTurnEndAt, lastTurnEndCompleted, invalidatedAfter}`：
  - 只有 **`turn/start`、来源为用户的 `user/message`、压缩/回退/分支切换** 才把“失效”置位；
  - `session/title`、`model/selection`、权限/preset、投递回执、`job/settled` 等不算过期。
- `verifyAnchor` 两条路径：
  1. 插件运行中见过的 turn/end：`lastTurnEndSeq === seq` 且未失效 → 快速通过；`lastTurnEndSeq > seq` → 旧锚点过期；非 completed 的 turn/end → `turn-not-completed`；
  2. 重启/未观察：读完整会话日志，找到 `turn/end` 后扫描其后事件，只有失效事件才返回 `stale-context`。
- `read()` 接受 `capturedThroughSeq >= completedEventSeq`（不再要求严格相等），仍要求最后一条 assistant 消息与锚点一致。

**单测**
- 水位大于锚点、但无失效事件 → 接受；
- 回合结束后用户新消息 → `stale-context`；
- 标题/模型选择/作业结算 → 接受；
- live 场景：只增长 seq 不失效；`turn/start` 才让完成过期；
- host-plugin：标题事件后仍可预测，用户消息后 stale。

## 3. B06 跨会话恢复 + 输入清空恢复 + 2 小时有效期

- `OFFER_TTL_MS` 从 10 分钟改为 **2 小时**（“到下一回合开始为止”另设上限）。Host 结果缓存与客户端恢复共用该值。
- `offersBySession`（最多 40）：离开会话时保存当前建议；切回时若回合未变、草稿为空、未接受/忽略/抑制、未过期 → **恢复显示，不再请求 Host**。
- `suspendedOffers`（按回合）：用户开始输入时保存建议并隐藏；草稿再次清空时**恢复同一条建议**（不重新请求），并更新 `offerDraftRev` 使 Tab 可用。
- 单测：切走再回来恢复（predict 次数不变）、输入后清空恢复、IME 后清空恢复（P1 矩阵断言已同步更新）。
- 行为变化：此前“输入后整回合作废”的语义被 PLAN 要求替换；P1 的 IME/窄宽度断言已按新语义更新。

## 4. B07 临时失败重试一次

- 客户端 `requestPrediction`：
  - 传输失败 → 500ms 后自动重试 **1 次**；
  - Host 返回 `unavailable/busy`（含 `retryAfterMs`）→ 尊重 `retryAfterMs`（至少 500ms）重试 **1 次**；
  - 模型弃权/输出非法 → **不重试**（保持原原则）。
- Host `request-registry.activeCount()` 只统计未中止的 production，已中止任务不再占用并发名额。
- 单测：busy 重试成功、传输失败重试成功、模型 abstain 不重试；registry 的 activeCount 不计 aborted、自动/手动额度独立、最后一个 waiter 离开才 abort。

## 5. B08 超过两行不再整条隐藏

- `overlay.js` 去掉“两行放不下就整条隐藏”的判断；文本改为 `-webkit-line-clamp: 2` 两行省略号显示，Tab 仍使用**完整建议文本**。
- 专项 `tools/b08-verify.mjs`：注入 196 个 grapheme 的长建议 → ghost 可见（截图 `b08-01-long-ghost.png`）、Tab 后草稿为完整文本（190 字符）、零 prompt 请求。
- P1 `narrow-composer` 步骤改为“窄宽度下仍显示、Tab 填入完整文本”，通过。

## 6. B09c 桌面残留清理（第 1 批遗留，按 PLAN 完成）

- 检查桌面 profile 后按 PLAN 恢复：`desktop/package.json`
  - `dependencies` 移除 `dsh-composer-prediction`；
  - `dsh.profile.bundles` 移除 `dsh-composer-prediction`，加入 `dsh-next-message-predictor`；
  - `cordis.patch.yml` 中 `next-message-predictor.enabled: true` 已确认。
- 由于 pnpm store 版本冲突，**只手动编辑 package.json**，未执行安装/卸载；旧包目录可能残留在 `node_modules`，但 bundles 不再引用，不会加载。
- 桌面 DSH 未重启（用户正在使用）；重启后才会加载本插件与第 1/2 批源码。

## 7. 验证矩阵（scratch profile）

| 项目 | 结果 | 证据 |
|---|---|---|
| `node --test` | **128/128** | 命令输出 |
| P1 交互矩阵（含更新后的 IME/窄宽度断言） | **11/11** | `scratch/evidence/batch2-p1-report.json` |
| P2 模型链路（mock，9 步） | **9/9** | `scratch/evidence/batch2-p2-report.json` |
| B08 长建议专项 | 通过 | `scratch/evidence/b08-verify-report.json`、`b08-01-long-ghost.png` |
| 零发送审计 | `sendCalls=0`（P1/P2/B08 均验证） | 各报告 |

## 8. 已知限制与后续

- B01 依赖页面 `focus`/`visibilitychange` 事件与视图仍在目标会话；若回合结束时会话视图已卸载（用户在别的会话），只能靠“重新打开该会话”时无 running→idle 锚点，需后续通过 Host 推送/全局会话事件补齐。
- B06 的 40 会话上限未单独写单测（淘汰逻辑简单）；2 小时上限依赖时钟。
- B08 依赖 Chromium 的 `-webkit-line-clamp`（DSH Web/Desktop 均 Chromium）；非 Chromium 宿主需回退显示策略。
- B07 每种临时失败只重试一次；busy 重试仍受 Host 全局并发 1 限制。
- 第 3 批（O05 基线、O02 提示词 v3、O03 语义过滤、O04 固定快模型）与第 4 批（O06–O08）未开始。
