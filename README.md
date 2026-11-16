<div align="center">

**简体中文** · [English](README.en.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Español](README.es.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · [Русский](README.ru.md) · [Português](README.pt.md)

</div>

<p align="center">
  <img src="icon.svg" width="88" alt="">
</p>

<h1 align="center">下一条消息预测</h1>

<p align="center">
  <b>DeepSeek Harness 输入框插件</b><br>
  助手答完后，可在输入框里预览下一条消息的建议。<br>
  聚焦输入框后按 <kbd>Tab</kbd>，默认填入草稿。
</p>

<p align="center">
  <img src="https://img.shields.io/badge/%E7%89%88%E6%9C%AC-0.7.0-4d6bfe" alt="版本 0.7.0">
  <img src="https://img.shields.io/badge/DeepSeek%20Harness-%3E%3D0.2.2--rc.1%20%3C0.3.0-1f2937" alt="DeepSeek Harness &gt;=0.2.2-rc.1 &lt;0.3.0">
  <img src="https://img.shields.io/badge/%E7%95%8C%E9%9D%A2%E8%AF%AD%E8%A8%80-9-8250df" alt="界面语言 9">
  <img src="https://img.shields.io/badge/%E7%AC%AC%E4%B8%89%E6%96%B9%E4%BE%9D%E8%B5%96-0-2ea44f" alt="第三方依赖 0">
  <a href="https://github.com/KungerChen/dsh-next-message-predictor/actions/workflows/ci.yml"><img src="https://github.com/KungerChen/dsh-next-message-predictor/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <img src="https://img.shields.io/badge/%E8%AE%B8%E5%8F%AF-MIT-blue" alt="许可 MIT">
</p>

<div align="center">

[快速开始](#quick-start) · [预览和采纳](#suggestions) · [暂停当前会话](#session-pause) · [预测模式](#modes) · [隐私和模型请求](#privacy) · [文档](#documentation)

</div>

<p align="center">
  <img src="docs/images/demo.png" width="760" alt="DSH 输入框中的失焦预览、聚焦后切换建议以及填入草稿">
</p>

<a name="quick-start"></a>

## 快速开始

DeepSeek Harness 安装版本范围为 `>=0.2.2-rc.1 <0.3.0`。从 GitHub 安装即可使用，无需构建。

```powershell
dsh plugin --profile desktop add github:KungerChen/dsh-next-message-predictor
```

使用日常打开的 profile（默认桌面版为 `desktop`，Web 版为 `web`）。安装后**完全退出并重新打开 DSH**。

1. 打开 **设置 → 消息预测**。首次安装时，预测默认关闭。
2. 在“预测模式”中选一种模式，到“预测模型”确认 DSH 中已配置所填的服务商与模型，或者选择“跟随会话模型”。修改模型文本框后请保存。
3. 打开“启用预测”，等助手答完后保持输入框为空。也可以点“预测”，或聚焦空输入框后按 <kbd>Alt</kbd>+<kbd>\</kbd> 手动试用。

均衡和省流默认使用 `deepseek-official / deepseek-flash`。想使用其他指定模型时，请填写 DSH 中对应的服务商 ID 和模型 ID。指定模型无法解析时，本次预测可能改用可用的 DSH 默认模型。

<details>
<summary>找不到 <code>dsh</code> 命令，或要从本地目录安装</summary>

可直接调用 DeepSeek Harness 安装目录中的命令行。要修改代码，先克隆仓库，再从本地目录安装。

```powershell
git clone https://github.com/KungerChen/dsh-next-message-predictor.git
$dsh = '<DSH 安装目录>\resources\runtime\cli\bin\dsh.cmd'
& $dsh plugin --profile desktop add '<插件目录>'
```

</details>

<details>
<summary>更新与卸载</summary>

**从 GitHub 更新**。先卸载，然后重新执行安装命令并完整重开 DSH。

**应用本地更新**。先更新并构建本地插件目录。若“消息预测”设置检测到未加载的本地构建，会显示“应用本地更新”。点击后，DSH 可能同时重载此 profile 中的其他已变更插件。首次使用前，或无法应用时，请完整退出并重新打开 DSH。

**卸载**。

```powershell
dsh plugin --profile desktop remove dsh-next-message-predictor
```

同一个 profile 只启用一个输入框预测插件。检测到另一个同类插件时，本插件会暂停，并在设置页说明原因。

</details>

<a name="suggestions"></a>

## 预览和采纳

有建议时，前台窗口的空输入框会显示灰字预览。默认即使输入框失焦也能看到。开启“仅在输入框获得焦点时显示预测”后，只有输入框聚焦时才显示。此选项只控制已有建议的显示。

<p align="center">
  <img src="docs/images/suggestion.png" width="720" alt="失焦的输入框显示灰字建议，以及点击输入框后按 Tab 采纳的提示">
</p>

| 输入框操作 | 效果 |
|---|---|
| <kbd>Tab</kbd>、对应按钮，或光标在开头时按 <kbd>→</kbd> | 先聚焦输入框。默认填入草稿。显式开启 “Tab 一键发送”后，Tab 和对应按钮会提交当前建议。右方向键始终只填入草稿。仅在当前建议有效且通过发送保护时提交，启用前请留意误发风险。 |
| <kbd>Esc</kbd> | 聚焦输入框时隐藏当前建议，之后仍可手动请求新的建议。 |
| <kbd>Alt</kbd>+<kbd>\</kbd>（可改）、“预测”或“换一条” | 输入框为空时手动预测或换一条。使用快捷键还需聚焦输入框。 |
| 直接打字 | 开始输入后，预览会隐藏。清空草稿时，如果原建议仍然有效，它可以再次显示。 |

采纳后用 <kbd>Ctrl</kbd>+<kbd>Z</kbd> 撤销、<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Z</kbd> 重做。0.6.0 修复了已验证的 DSH Desktop `0.2.2-rc.3` 编辑器中发送后首次采纳的撤销问题。其他编辑器版本沿用 DSH 的原生撤销行为。 [验证报告](docs/VALIDATION-DISPLAY-SESSION.md)

<a name="session-pause"></a>

## 暂停当前会话

输入框工具栏的暂停按钮会停止本会话的自动和手动预测，并清除当前建议。点击 ▶ 恢复后，可以手动预测或等待新一轮回答结束。

<p align="center">
  <img src="docs/images/pause.png" width="720" alt="已暂停预测的会话及输入框工具栏中的恢复按钮">
</p>

连接同一 DSH 后台的窗口共享暂停状态。刷新页面或保存设置后仍会保留，直到你恢复预测或重启 DSH。在一个窗口采纳或隐藏建议时，同会话其他视图也会隐藏同一回合的建议。

<a name="modes"></a>

## 预测模式

<p align="center">
  <img src="docs/images/modes.png" width="720" alt="预测模式卡片中的均衡、省流和高质量选项">
</p>

| 模式 | 何时预测 | 模型 | 上下文消息上限 | 每日请求上限 |
|---|---|---|---|---|
| **均衡** (推荐) | 满足条件的回答结束后自动 | 指定模型 | 12 | 200 |
| **省流** | 仅手动 | 指定模型 | 6 | 60 |
| **高质量** | 满足条件的回答结束后自动 | 跟随会话模型 | 20 | 200 |

模式调整触发方式、模型策略、上下文和上限，保留总开关、快捷键、界面语言、隐私选项和已填的模型 ID。

### 模型建议和自己的短语

模型候选之后，可以接上你在本会话中重复发过的短消息和固定短语。在 **设置 → 消息预测 → 建议来源 → 固定短语** 添加或排序后保存。点击“换一条”可在已有候选中切换，无需再次调用模型。已有候选用完后，再换一条可能请求模型，仍受额度限制。

手动预测没有可用的模型结果时，如果有自己的短语，插件可以直接提供这些短语。提供本机回退候选无需额外调用模型。

<p align="center">
  <img src="docs/images/phrases.png" width="720" alt="输入框中的固定短语候选，“换一条”按钮显示图钉和候选位置">
</p>

## 设置与用量

插件支持九种界面语言，默认跟随 DSH。也可在插件设置中单独选择“界面语言”。该选项控制界面文案的语言。

点击“添加侧栏入口”，即可从 DSH 左侧栏打开“消息预测”。取消固定后，可以在“更多”中打开或重新固定。设置标题旁显示已安装的版本。

<table>
<tr>
<td width="30%" align="center" valign="middle">
  <img src="docs/images/sidebar-entry.png" width="230" alt="DSH 左侧栏中的“消息预测”入口">
</td>
<td width="70%" align="center" valign="middle">
  <img src="docs/images/page-header.png" width="560" alt="消息预测标题、版本号和侧栏入口设置">
</td>
</tr>
</table>

“近 7 天统计”显示请求次数、已展示和已采纳的建议、响应时间及 token 用量，可用来查看每日额度和建议的使用情况。

<details>
<summary>展开查看完整设置页和多语言示例</summary>

<p align="center">
  <img src="docs/images/settings.png" width="640" alt="包含基础、模式、建议来源、模型和统计的设置页">
</p>

<p align="center">
  <img src="docs/images/languages.png" width="720" alt="插件设置页顶部的多语言界面示例">
</p>

</details>

> 截图取自隔离的 Web 界面，使用合成会话和本机模拟模型，设置为示例配置。图中的用量和耗时仅供演示。

<a name="privacy"></a>

## 隐私和模型请求

模型预测将当前会话分支最近的**用户消息和助手最终回答**片段发送给 DSH 配置的模型服务商。默认上限为 12 条消息、约 2000 token，包含预测任务说明。

- 默认附带上一回合的简短活动计数摘要。工具调用参数、输出、推理和系统提示不包含在内。
- 默认开启规则遮蔽，替换疑似密钥及部分个人标识。规则可能漏掉敏感文字。
- 浏览器的预测与会话状态请求携带标识和元数据。后台从 DSH 读取已发送的消息；草稿、附件和引用不包含在内。本地统计记录次数、耗时和标识，不保存对话或建议正文。
- 本机候选与固定短语列表不会附加到模型提示中。已经作为消息发出的短语仍可能出现在最近对话片段里。

完整数据范围和删除方法见 [隐私与数据边界](docs/PRIVACY.md)。

## 常见问题

<details>
<summary><b>为什么没有建议？</b></summary>

先看设置页的“当前状态”。会话暂停、窗口不在前台、草稿非空、菜单打开或输入法正在组词都可能阻止显示。模型也可能不给可用建议。满足条件时，可在聚焦的空输入框中手动预测。

</details>

<details>
<summary><b>预测什么时候会计费？</b></summary>

费用取决于实际调用的服务商及 token 用量。切换已有候选或生成本机回退候选不会新增模型请求。希望只在需要的时候预测，可以使用省流模式。

</details>

<a name="documentation"></a>

## 文档

0.7.0 的宿主与验证范围见 [发布与启用](docs/RELEASE.md#release-validation-070)。

| 文档 | 内容 |
|---|---|
| [使用指南](docs/USER-GUIDE.md) | 设置、按键、模式与排查方法 |
| [配置参考](docs/CONFIGURATION.md) | 配置项默认值、取值范围和模式预设 |
| [隐私与数据边界](docs/PRIVACY.md) | 发送范围、本地文件和数据删除 |
| [兼容性](docs/COMPATIBILITY.md) | 安装范围、实测宿主与原生编辑器行为 |
| [更新日志](CHANGELOG.md) | 各版本变更 |
| [文档索引](docs/README.md) | 当前文档和历史验证记录 |

## 参与开发

```powershell
npm run build
npm test
npm run check
```

开发需要 Node.js 22 或更高版本，无需安装运行依赖。`npm run check` 检查客户端包、生成的 README、测试和 JavaScript 语法。 [开发与验证](docs/DEVELOPMENT.md) · [架构](docs/ARCHITECTURE.md)

## 许可

以 [MIT 许可证](LICENSE) 发布。扩展点和键盘交互参考了同为 MIT 许可的 `dsh-composer-prediction`。来源说明见 [NOTICE](NOTICE)。
