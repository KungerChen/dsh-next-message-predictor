# 文档索引

## 当前版本（0.4.0）

| 文档 | 给谁看 | 内容 |
|---|---|---|
| [USER-GUIDE.md](USER-GUIDE.md) | 使用者 | 按键、设置页每一项、三种模式、左侧栏入口、常见问题 |
| [CONFIGURATION.md](CONFIGURATION.md) | 使用者 / 维护者 | 全部配置项的默认值与范围，三种模式的取值与切换规则 |
| [PRIVACY.md](PRIVACY.md) | 使用者 | 发送给模型的内容、本机文件、删除方法 |
| [ARCHITECTURE.md](ARCHITECTURE.md) | 维护者 | 两半结构、请求流程、协议、扩展点、落盘文件、构建方式 |
| [DEVELOPMENT.md](DEVELOPMENT.md) | 维护者 | 构建、测试、端到端验证、调试入口、排查 |
| [RELEASE.md](RELEASE.md) | 维护者 | 版本信息、发布文件、启用到日常 profile 的步骤与回退 |
| [COMPATIBILITY.md](COMPATIBILITY.md) | 维护者 | 与 DSH 0.2.2-rc.1 的契约矩阵、降级项、版本策略 |
| [../CHANGELOG.md](../CHANGELOG.md) | 所有人 | 版本变更 |

## 历史记录

这些文件记录各阶段当时的取证、验证和决策，按写作时的状态保留，不随版本更新。其中的版本号、设置页名称（旧称“下一条消息”“预测”）和“尚未启用”等表述以当时为准。

| 文档 | 阶段 | 内容 |
|---|---|---|
| [p0-host-contract.md](p0-host-contract.md) | P0 | Host 侧扩展点的逐项取证 |
| [p0-client-contract.md](p0-client-contract.md) | P0 | 浏览器侧扩展点、输入框与 slot 的逐项取证 |
| [p0-load-verification.md](p0-load-verification.md) | P0 | 隔离 profile 的最小装载与可复现步骤 |
| [VALIDATION.md](VALIDATION.md) | P1 | 无模型交互矩阵的验证结果 |
| [VALIDATION-P2P4.md](VALIDATION-P2P4.md) | P2–P4 | 模型链路、120 条合成样本评测、真实模型试用 |
| [OPTIMIZATION-BATCH1.md](OPTIMIZATION-BATCH1.md) | 0.2.x | 结果记录、上下文配额、脱敏误伤、回合复核、重派发 |
| [OPTIMIZATION-BATCH2.md](OPTIMIZATION-BATCH2.md) | 0.2.x | 失焦补发、建议有效期、重试、长建议显示 |
| [OPTIMIZATION-BATCH3.md](OPTIMIZATION-BATCH3.md) | 0.2.x | 真实会话回放、提示词 v3、语义过滤、固定快模型 |
| [OPTIMIZATION-BATCH4.md](OPTIMIZATION-BATCH4.md) | 0.2.x | 方向键采纳、冲突检测、回合事实摘要 |

评测数据与报告在 [`../eval/`](../eval/)：`fixtures.deidentified.jsonl` 是纯合成样本；`replay-*.json` 是真实会话回放的指标，只有哈希标识和分数，不含对话文字。
