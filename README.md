<p align="center">
  <img src="icon.svg" width="88" alt="">
</p>

<h1 align="center">下一条消息预测</h1>

<p align="center">
  <b>DeepSeek Harness 输入框插件</b><br>
  助手答完，你要说的下一句已经在输入框里等着。<br>
  <kbd>Tab</kbd> 填入，<kbd>Esc</kbd> 忽略，<b>绝不替你发送</b>。
</p>

<p align="center">
  <img src="https://img.shields.io/badge/版本-0.3.0-4d6bfe" alt="版本 0.3.0">
  <img src="https://img.shields.io/badge/DeepSeek%20Harness-0.2.2--rc.1-1f2937" alt="DeepSeek Harness 0.2.2-rc.1">
  <img src="https://img.shields.io/badge/第三方依赖-0-2ea44f" alt="第三方依赖 0">
  <img src="https://img.shields.io/badge/测试-199%20项通过-2ea44f" alt="测试 199 项通过">
  <img src="https://img.shields.io/badge/许可-MIT-blue" alt="许可 MIT">
</p>

<p align="center">
  <img src="docs/images/demo.png" width="760" alt="演示：助手回答结束后，输入框里出现灰色建议；换一条；按 Tab 填入">
</p>

<p align="center">
  <sub>建议出现 → 不满意就换一条 → <kbd>Tab</kbd> 填入，可以继续修改再发送</sub>
</p>

---

## 为什么用它

和助手协作时，很多回复其实很短，也很容易猜到：“继续”“跑一下测试”“把改动给我看看”。这个插件把这类跟进提前写好，放在输入框里。

<table>
<tr>
<td width="33%" valign="top">

### ⌨️ 少打字

常见的跟进一键填入。填入后和自己打的字一样，可以改、可以撤销。

</td>
<td width="33%" valign="top">

### 🤫 不打扰

你一开始打字，建议立刻让位；输入法组词、菜单打开时不出现。模型没把握时宁可不给。

</td>
<td width="33%" valign="top">

### 🛡️ 不越权

只把文字放进输入框。插件里没有任何“发送消息”的代码，发不发永远由你决定。

</td>
</tr>
<tr>
<td valign="top">

### 💰 费用可控

默认用低成本模型，有每日次数和 token 上限。重复说过的短句直接给出，不调用模型。

</td>
<td valign="top">

### 🔒 注重隐私

发送前遮蔽疑似密钥、令牌和邮箱。浏览器不上传草稿。本机统计只记数字，不记文字。

</td>
<td valign="top">

### 📊 用量透明

近 7 天的请求数、采纳率、响应时间和 token 用量都在设置页里，一眼看清值不值。

</td>
</tr>
</table>

## 功能一览

### 建议就在输入框里

助手回答结束后，如果输入框是空的，灰色的建议就出现在你正要打字的地方，不弹窗、不占位。

<p align="center">
  <img src="docs/images/suggestion.png" width="720" alt="输入框中的灰色建议，右侧有“Tab 采纳”和“换一条”">
</p>

| 操作 | 效果 |
|---|---|
| <kbd>Tab</kbd> 或 <kbd>→</kbd> | 把建议填入输入框，可以继续修改；<kbd>Ctrl</kbd>+<kbd>Z</kbd> 只撤销这次填入 |
| <kbd>Esc</kbd> | 隐藏这条建议 |
| <kbd>Alt</kbd>+<kbd>\\</kbd>（可改） | 立即预测；已有建议时换一条，一次调用带回多条候选，切换不用等 |
| 直接打字 | 建议立刻消失；清空输入框后它会回来 |

### 三种模式，一键切换

不想研究每个选项？选一种模式就行，随时可以撤销或再微调。

<p align="center">
  <img src="docs/images/modes.png" width="720" alt="预测模式卡片：均衡、省流、高质量">
</p>

| 模式 | 什么时候预测 | 用什么模型 | 上下文 | 每日上限 | 适合 |
|---|---|---|---|---|---|
| **均衡**（推荐） | 每次回答后自动 | 指定的低成本模型 | 12 条 | 200 次 | 日常使用 |
| **省流** | 只在你点“预测”或按快捷键时 | 指定的低成本模型 | 6 条 | 60 次 | 严格控制费用 |
| **高质量** | 每次回答后自动 | 跟随会话模型 | 20 条 | 200 次 | 想要更贴合的建议 |

模式只调整触发方式、模型策略、上下文和上限，不动总开关、快捷键和隐私选项，也不会覆盖你填好的模型。

### 放进左侧栏，一点即达

点一下“添加到左侧栏”，入口就出现在 DSH 首页左侧；之后看状态、换模式都不用再进设置。标题旁的版本号让你随时知道装的是哪一版。

<table>
<tr>
<td width="30%" align="center" valign="middle">
  <img src="docs/images/sidebar-entry.png" width="230" alt="左侧栏中的“消息预测”入口">
</td>
<td width="70%" align="center" valign="middle">
  <img src="docs/images/page-header.png" width="560" alt="页面标题旁的版本号和“从左侧栏移除”按钮">
</td>
</tr>
</table>

### 用了多少，一目了然

<details>
<summary><b>展开查看完整的设置页</b>（基础开关、模式、建议来源、预测模型、近 7 天统计）</summary>
<br>
<p align="center">
  <img src="docs/images/settings.png" width="640" alt="完整的设置页">
</p>
</details>

> 以上截图来自一段演示对话，由仓库里的脚本自动生成，使用的是本地模拟模型，所以模型名显示为 Mock、统计数字很小。实际使用时，建议由你在 DSH 中配置的模型生成。

## 安装

需要 DeepSeek Harness `0.2.2-rc.1`（`>=0.2.2-rc.1 <0.3.0`）。插件没有第三方依赖，克隆下来即可安装。

```powershell
git clone https://github.com/KungerChen/dsh-next-message-predictor.git
$dsh = '<DSH 安装目录>\resources\runtime\cli\bin\dsh.cmd'
& $dsh plugin --profile desktop add '<插件目录>'
```

`<DSH 安装目录>` 是 DeepSeek Harness 的安装位置，`<插件目录>` 是刚才克隆下来的文件夹。装好后**完全退出并重新打开 DSH**。

然后三步开始使用：

1. 打开 **设置 → 消息预测**，打开“启用预测”。默认是关闭的：不启用就不会显示建议，也不会调用模型。
2. 在“预测模式”里选一种，默认是“均衡”。
3. 想更顺手，就点右上角“添加到左侧栏”。

<details>
<summary>更新与卸载</summary>

**更新**：在插件目录里 `git pull`，然后重启 DSH。只刷新页面不够，那样页面是新版而后台还是旧版，设置页会提示版本不一致。

**卸载**：

```powershell
& $dsh plugin --profile desktop remove dsh-next-message-predictor
```

同一个 profile 里只启用一个输入框预测插件。检测到另一个同类插件时，本插件会自动暂停，并在设置页说明原因。

</details>

## 它会发送什么

每次预测向模型发送一次请求，不自动重试。内容是当前会话最近的**用户消息和助手的最终文字回答**的片段，默认最多 12 条、约 2,000 token。

- 不包含工具调用的参数和输出、推理过程、系统提示。
- 发送前把疑似密钥、令牌、邮箱替换成占位符（基于规则，不能保证识别全部）。
- 浏览器页面只发送会话和回合的编号，不发送草稿、附件或任何对话文字；要发给模型的内容由后台从 DSH 自己的会话记录里读取。
- “常用短句”只在本机比较你发过的短消息，不调用模型。

完整说明和删除本机数据的方法见 [隐私与数据边界](docs/PRIVACY.md)。

## 常见问题

<details>
<summary><b>会不会替我把消息发出去？</b></summary>

不会。采纳建议只是把文字填进输入框，用的是输入框自己的插入接口；插件代码里不存在提交或发送的调用。

</details>

<details>
<summary><b>会花多少钱？</b></summary>

每次预测是一次很短的模型调用（默认输出上限 96 token）。默认每日最多 200 次、50 万 token，达到上限当天就不再调用。想更省就选“省流”模式，只在你主动要的时候预测。实际用量在设置页的“近 7 天统计”里。

</details>

<details>
<summary><b>为什么有时候没有建议？</b></summary>

设计如此：模型没有把握时会选择不给，输出不符合要求（太长、多行、像助手的口吻）的也会被丢弃。设置页“当前状态”一行会说明此刻为什么没有建议。想要一条的时候按 <kbd>Alt</kbd>+<kbd>\\</kbd>。

</details>

<details>
<summary><b>建议准吗？</b></summary>

它擅长的是短而明确的跟进：确认继续、要求验证、追问细节。它猜不到只有你自己知道的事，这种情况下它应当保持沉默。目前的质量评测只有自动指标，人工评分尚未完成，详见 <a href="docs/RELEASE.md">发布说明</a>。

</details>

## 文档

| 文档 | 内容 |
|---|---|
| [使用指南](docs/USER-GUIDE.md) | 按键、设置页每一项、模式、左侧栏入口、常见问题 |
| [配置参考](docs/CONFIGURATION.md) | 全部配置项的默认值与范围，三种模式的取值 |
| [隐私与数据边界](docs/PRIVACY.md) | 发送范围、本机文件、删除数据的方法 |
| [架构](docs/ARCHITECTURE.md) | Host 与浏览器两半的结构、请求流程、协议 |
| [开发与验证](docs/DEVELOPMENT.md) | 构建、测试、端到端验证、重新生成截图 |
| [兼容性](docs/COMPATIBILITY.md) | 与 DSH 0.2.2-rc.1 的契约确认与降级项 |
| [更新日志](CHANGELOG.md) | 版本变更 |
| [文档索引](docs/README.md) | 全部文档，含历史验证与优化记录 |

## 参与开发

```powershell
npm run build   # 由 src/shared + src/client 生成 lib/client.js
npm test        # 199 项单元与集成测试
npm run check   # build + test + 语法检查
```

不需要 `npm install`，没有打包器，需要 Node.js 22 或更高版本。

<details>
<summary>目录结构</summary>

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
  tools/                隔离 profile 启停、浏览器驱动、端到端脚本、mock 模型、截图脚本
  eval/                 去标识评测样本、评测脚本与报告
  docs/                 文档与截图
  scratch/              隔离测试 profile 用的配置片段（日志和测试截图不入库）
```

</details>

## 已知限制

- 只在 DSH `0.2.2-rc.1` 上验证过。
- 保存设置会让宿主重启插件的后台实例，进行中的预测会被取消。
- 多个窗口共享预测结果；在一个窗口里隐藏建议不会实时同步到其他窗口。
- 命令弹层和反馈对话框靠焦点与模态特征判断；判断失误时只会少显示一次建议，不会抢按键。

## 许可

以 [MIT 许可证](LICENSE) 发布。扩展点的选择和“灰色建议 + Tab 采纳 + Esc 隐藏”的交互方式参考了同为 MIT 许可的 `dsh-composer-prediction`，未复制其代码，来源说明见 [NOTICE](NOTICE)。
