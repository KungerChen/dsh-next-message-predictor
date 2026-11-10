# dsh-next-message-predictor

DeepSeek Harness（DSH）输入框的“下一条消息预测”插件。助手回答结束后，在空输入框中以灰色文字给出一条你可能要发的消息：

- **Tab** 或 **→** 把建议填入输入框，可以继续修改；**不会自动发送**。
- **Esc** 隐藏这条建议。
- **Alt+\\**（可改）或输入框右侧的“预测”按钮：立即预测；已有建议时切换到下一条。
- 开始打字、输入法组词、打开菜单、切换会话时，建议立即让位。

当前版本 **0.3.0**，适用于 DSH `>=0.2.2-rc.1 <0.3.0`。更新内容见 [CHANGELOG.md](CHANGELOG.md)。

## 0.3.0 新增

| 功能 | 说明 |
|---|---|
| 一键添加到左侧栏 | 设置页右上角“添加到左侧栏”，在 DSH 首页左侧栏的入口列表里加一个“消息预测”入口，点一下就打开本插件的页面；再点一次移除。 |
| 版本号 | 设置页标题旁显示插件版本（如 `v0.3.0`）。页面与后台版本不一致时提示重启 DSH。 |
| 一键模式 | “预测模式”卡片提供 **均衡 / 省流 / 高质量** 三种推荐组合，点一下即切换，可立即撤销。 |

## 安装

本插件以本地目录方式安装到 DSH profile（不发布到 npm）。下面的 `<DSH 安装目录>` 是 DeepSeek Harness 的安装位置，`<插件目录>` 是本仓库在你机器上的位置。

```powershell
$dsh = '<DSH 安装目录>\resources\runtime\cli\bin\dsh.cmd'
& $dsh plugin --profile desktop add '<插件目录>'
```

安装或更新后**完全退出并重新打开 DSH**。同一个 profile 里只启用一个输入框预测插件：检测到另一个幽灵文字插件时，本插件会自动暂停并在设置页说明原因。

卸载：

```powershell
& $dsh plugin --profile desktop remove dsh-next-message-predictor
```

更新本目录的代码后，先运行 `npm run build` 重新生成 `lib/client.js`，再重启 DSH。

## 快速上手

1. 打开 **设置 → 消息预测**，打开“启用预测”（默认关闭：未启用时不显示建议，也不调用模型）。
2. 在“预测模式”里选一种模式，默认是“均衡”。
3. 想少进设置页，就点右上角“添加到左侧栏”，之后从左侧栏的“消息预测”直接打开同一个页面。

| 模式 | 触发 | 模型 | 上下文 | 每日上限 | 适合 |
|---|---|---|---|---|---|
| 均衡（推荐） | 每次回答后自动 | 指定的低成本模型 | 12 条 / 2,000 token | 200 次 / 50 万 token | 日常使用 |
| 省流 | 仅手动（按钮或快捷键） | 指定的低成本模型 | 6 条 / 1,000 token | 60 次 / 15 万 token | 控制费用 |
| 高质量 | 每次回答后自动 | 跟随会话模型 | 20 条 / 4,000 token | 200 次 / 100 万 token | 建议要更贴合，接受更高费用和等待 |

模式只改触发方式、模型策略、候选条数、上下文、超时和每日上限；不改总开关、快捷键、常用短句和隐私选项，也不覆盖你已填写的模型服务商 ID 和模型 ID。完整说明见 [使用指南](docs/USER-GUIDE.md) 和 [配置参考](docs/CONFIGURATION.md)。

## 它发送什么

每次预测向模型发送一次请求，内容是当前会话最近的用户消息和助手最终回答的片段（默认最多 12 条、约 2,000 token），发送前遮蔽疑似密钥、令牌和邮箱。浏览器不上传草稿；插件没有任何“发送消息”的代码路径。“常用短句”来自本会话里你自己重复发过的短消息，不调用模型。细节见 [隐私与数据边界](docs/PRIVACY.md)。

## 文档

| 文档 | 内容 |
|---|---|
| [docs/USER-GUIDE.md](docs/USER-GUIDE.md) | 使用指南：按键、设置页每一项、模式、左侧栏入口、常见问题 |
| [docs/CONFIGURATION.md](docs/CONFIGURATION.md) | 全部配置项、默认值、范围，以及三种模式的取值 |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Host / 浏览器两半的结构、请求流程、协议、落盘文件 |
| [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) | 构建、测试、端到端验证、调试入口、发布步骤 |
| [docs/PRIVACY.md](docs/PRIVACY.md) | 发送范围、本机文件、删除数据的方法 |
| [docs/COMPATIBILITY.md](docs/COMPATIBILITY.md) | 与 DSH 0.2.2-rc.1 的契约确认与降级项 |
| [docs/README.md](docs/README.md) | 文档索引（含历史验证与优化记录） |
| [CHANGELOG.md](CHANGELOG.md) | 版本变更 |

## 目录

```text
dsh-next-message-predictor/
  package.json          包信息与 dsh.client 声明
  cordis.patch.yml      loader 条目：next-message-predictor
  lib/index.js          Host 入口（转出 src/host）
  lib/client.js         生成的浏览器 bundle（npm run build，勿手改）
  src/shared/           Host 与浏览器共用：配置、模式、协议、提示词、输出校验、版本号
  src/host/             路由、预测服务、上下文、模型调用、预算账本、结果记录
  src/client/           控制器、输入框覆盖层、设置页与面板、文案
  test/                 node:test 单元与集成测试（含对 lib/client.js 的冒烟测试）
  tools/                隔离 profile 启停、浏览器驱动、端到端脚本、mock 模型
  eval/                 去标识评测样本、评测脚本与报告
  docs/                 文档
  scratch/              隔离测试 profile 用的配置片段与探针（日志和截图不入库）
```

## 开发

```powershell
npm run build   # 由 src/shared + src/client 生成 lib/client.js
npm test        # 199 项单元与集成测试
npm run check   # build + test + 语法检查
```

无第三方依赖、无打包器，需要 Node.js 22 或更高版本（开发时使用 24）。端到端验证与调试入口见 [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)。

## 已知限制

- 只在 DSH `0.2.2-rc.1` 上验证过；`engines.dsh` 限定 `<0.3.0`。
- 保存设置会让宿主重启本插件的后台实例，进行中的预测会被取消。
- 多个窗口共享后台的预测结果；一个窗口里隐藏建议不会实时同步到其他窗口。
- 命令弹层和反馈对话框没有稳定的 DOM 标记，靠焦点与模态特征判断；判断失误时只会少显示一次建议，不会抢按键。
- 质量评测目前只有自动指标（120 条合成样本与少量真实会话回放），人工评分尚未完成。

## 许可与来源

以 [MIT 许可证](LICENSE) 发布。代码为原创实现，来源说明见 [NOTICE](NOTICE)。扩展点的选择和“幽灵文字 + Tab 采纳 + Esc 隐藏”的交互方式参考了 MIT 许可的 `dsh-composer-prediction`（未复制其代码）。
