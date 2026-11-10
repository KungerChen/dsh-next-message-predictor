# 发布与启用

## 版本

| 字段 | 值 |
|---|---|
| 包名 | `dsh-next-message-predictor` |
| 版本 | `0.3.0`（变更见 [CHANGELOG.md](../CHANGELOG.md)） |
| 目标 DSH | `>=0.2.2-rc.1 <0.3.0`（实测 `0.2.2-rc.1`） |
| 提示词版本 | `nmp-p2-v3`（结果缓存键的一部分） |
| 构建 | 无打包器：`scripts/build-client.mjs` 由 `src/shared` + `src/client` 生成 `lib/client.js`；`lib/index.js` 是 Host 入口 |
| 发布文件 | `lib/`、`src/`、`cordis.patch.yml`、`locale/*.json`、`icon.svg`、`README.md`、`CHANGELOG.md`、`LICENSE`、`NOTICE`（`package.json` 的 `files`；不含 `test/`、`tools/`、`eval/`、`docs/`） |
| 分发方式 | 本地目录安装（`package.json` 标记 `private`，不发布到 npm） |

## 发版步骤

1. 同时修改 `package.json` 的 `version` 和 `src/shared/version.js` 的 `PLUGIN_VERSION`。
2. 在 `CHANGELOG.md` 顶部写本次变更。
3. `npm run check`（构建 + 测试 + 语法检查）。构建会拒绝不一致的版本号。
4. 在隔离 profile 上跑端到端矩阵（[DEVELOPMENT.md](DEVELOPMENT.md#端到端验证隔离-profile)）。
5. 提交、打标签 `v<版本>`、推送。

## 0.3.0 的验证

- `npm test`：199 项全部通过。
- 隔离 profile（`predictor-scratch`，DSH 0.2.2-rc.1，mock 模型）：`p1-e2e.mjs` 13 步、`p2-e2e.mjs` 9 步全部通过。
- 浏览器手动核对：版本号显示、左侧栏入口的添加与移除、模式切换与撤销、统计修复。

未做的验证：0.3.0 没有重跑真实模型试用（`p4-real-e2e.mjs`）和质量评测（`eval/`）；提示词与模型调用路径在本版本没有改动（提示词版本仍为 `nmp-p2-v3`）。Desktop 原生窗口未单独验收，端到端验证都在 Web GUI 上进行。

## 安装到 profile 与更新

普通用户从 GitHub 安装，一条命令即可（无依赖、无构建步骤）：

```powershell
dsh plugin --profile desktop add github:KungerChen/dsh-next-message-predictor
```

开发时从本地目录安装：

`<DSH 安装目录>` 是 DeepSeek Harness 的安装位置，`<插件目录>` 是本仓库在你机器上的位置。

```powershell
$dsh = '<DSH 安装目录>\resources\runtime\cli\bin\dsh.cmd'
& $dsh plugin --profile desktop add '<插件目录>'
```

本地目录以 `link:` 方式进入 profile：profile 直接引用这个目录，不复制文件。因此：

- **更新不需要重新安装。** 改完代码运行 `npm run build`，然后完全退出并重新打开 DSH。Host 半在 DSH 重启后加载新代码；浏览器半在页面重新加载时加载新 bundle。
- **只刷新页面不够。** 那样页面是新版本而后台还是旧版本，设置页会在标题下提示版本不一致，新增的选项（如左侧栏入口）保存会失败。

同一个 profile 只启用一个输入框预测插件。本插件检测到另一个幽灵文字插件时会自动暂停并在设置页说明，但两个插件仍会各自调用模型，应停用其中一个。

启用后在 **设置 → 消息预测** 打开“启用预测”，选择模式，确认“预测模型”。使用真实模型会按次产生 token 费用，“近 7 天统计”和“今日额度使用”可以查看用量。

## 回退

卸载：

```powershell
& $dsh plugin --profile desktop remove dsh-next-message-predictor
# 重启 DSH
```

卸载移除路由、监听器、界面入口和运行时状态，不修改会话历史。profile 中已写入的配置和 `<DSH_HOME>/next-message-predictor/` 下的文件需要手动删除，见 [PRIVACY.md](PRIVACY.md#数据删除)。

只想退回某个版本：把本目录检出到对应的标签（`git checkout v<版本>`），`npm run build`，重启 DSH。仓库的版本历史从 `v0.3.0` 开始，更早的版本没有提交记录。从更新的版本退回 0.3.0 之前的代码时：0.3.0 新增的配置字段 `sidebarEntry` 在旧版本中会被报告为未知字段（列在诊断的“配置错误”里），不影响预测；介意的话先在 0.3.0 里点“从左侧栏移除”再回退。

## 日常使用时值得留意的事

日常使用中可以留意：

- 建议是否干扰输入（误吞 Tab / Esc、抢焦点）。
- 建议是否像你会说的话；信息不足或任务已结束时是否保持安静。
- 是否出现越权的建议（提交、发布、删除、付费、替你编造事实）。
- 回答结束到建议出现的等待时间。
- 每日请求数与 token，是否触到上限。

出现严重误触或越权建议时，先关闭“启用预测”，并保留“高级选项 → 诊断信息”里的内容以便排查。

## 后续可做

1. 更多真实会话回放。
2. 原生配置 schema 与热更新（保存设置不再重启插件）。
3. 多窗口之间实时同步建议的隐藏状态；账本的跨进程锁。
4. Desktop 原生窗口的输入法与快捷键验收。
