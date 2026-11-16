# 消息预测插件：协作入口

先读 [README.md](README.md)、[文档索引](docs/README.md) 和 [开发约定](docs/DEVELOPMENT.md)，然后按当前任务阅读相关契约、源码和测试。

## 复用文档

| 职责 | 入口 |
| --- | --- |
| 当前功能与使用 | [README.md](README.md)、[用户指南](docs/USER-GUIDE.md) |
| SPEC | [架构与设计原则](docs/ARCHITECTURE.md)、[配置契约](docs/CONFIGURATION.md)、[隐私](docs/PRIVACY.md)、[宿主兼容](docs/COMPATIBILITY.md) |
| 验收约定 | [开发与验证](docs/DEVELOPMENT.md)、[显示与会话验证](docs/VALIDATION-DISPLAY-SESSION.md) |
| LOG / LOG-INDEX | [CHANGELOG.md](CHANGELOG.md) 记录版本；[docs/README.md](docs/README.md) 的历史记录与维护记录索引定位决策和证据 |

## 工作规则

- 默认中文沟通。新的重大/架构变更先形成具体方案并确认；已授权范围内的常规实现、检查和文档维护继续推进。
- 每轮实质修改保留稳定记录 ID、原因、文件清单、验证证据、未验证项、交接状态与回退参考；日志按索引局部读取。
- 区分自测、真实环境验证与用户验收。先完成可执行的验证，再给出必要的人工复现步骤；未确认时标注“待用户验收”。
- 用户确认本轮有效后同步 README 的能力、运行方式、限制及验收/上线状态；生成文件随已授权源码变更同步的例外按 [README 同步与验收边界](docs/DEVELOPMENT.md#readme-acceptance-boundary)执行。用户明确要求直接整理文档时可以按授权更新已核实内容。需求、设计或验收标准变化时同步对应规范并记录原因。
- 保留原有设计和验收文档的权威入口，不复制另一份 SPEC；不主动劝用户休息或收手。
- 默认采纳只填入草稿。用户显式开启 Tab 一键发送后，只有聚焦输入框时主动按 Tab 或点击对应发送按钮、且通过发送保护，才可调用宿主提交；保留默认零发送、失败时让位给宿主和跨窗口防重的设计原则；涉及宿主编辑器或快捷键必须区分离线、Web 和原生桌面验证。
- 仓库文档使用相对路径或占位符，不写本机绝对路径、访问令牌或真实会话内容。
- `src/client/`、`src/shared/` 与 `lib/client.js`、`lib/build-manifest.json`、`src/shared/build-id.js` 的构建关系，九语言文案及版本同步沿用 DEVELOPMENT。正式检查入口为 `npm run check`。
- 各语言 README 是生成文件；修改需经 `tools/readme/` 源和 `npm run readme`。仅补接手索引时修改现有 `docs/README.md`，避免手改生成结果。
- 后续维护记录写入 `docs/maintenance/` 或已有专题验证报告；在文档索引追加 ID、时间、摘要、证据和状态。不要复制一套 ARCHITECTURE/SPEC 或全量 LOG。
