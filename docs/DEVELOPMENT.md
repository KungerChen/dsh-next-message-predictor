# 开发与验证

适用版本：0.4.0。

## 环境

- Node.js 22 或更高（使用了 `Promise.withResolvers`、`AbortSignal.any`）。开发时使用 24。
- 无第三方依赖，不需要 `npm install`。
- 端到端脚本另外需要本机的 DeepSeek Harness、Chrome 或 Edge，以及一份 `playwright-core`，见下面的“本机环境”。

## 本机环境

仓库里不写任何机器相关的路径。`tools/` 和 `eval/` 下的脚本在运行时由 `tools/lib/local-env.mjs` 查找这三样东西，每一样依次看：环境变量 → `tools/local.config.json` → 系统上的常见位置。

| 需要什么 | 环境变量 | `local.config.json` 字段 | 都没有时 |
|---|---|---|---|
| `playwright-core` 包目录 | `NMP_PLAYWRIGHT_PATH` | `playwrightPath` | 按 Node 的常规方式查找（在本仓库运行过 `npm install --no-save playwright-core` 即可） |
| Chrome 或 Edge 可执行文件 | `NMP_BROWSER_PATH` | `browserPath` | 在系统的标准安装位置查找 |
| DeepSeek Harness 安装目录 | `DSH_INSTALL_DIR` | `harnessRoot` | 报错并说明如何设置（也可以给 `launch-scratch-web.ps1` 传 `-HarnessRoot`） |

`tools/local.config.json` 不入库（已在 `.gitignore` 中）。复制 `tools/local.config.example.json` 为该文件名，填上实际位置，用不到的字段删掉即可。

DSH 的数据目录取环境变量 `DSH_HOME`，未设置时为用户主目录下的 `.dsh`。

`npm test` 中的 `test/no-local-paths.test.mjs` 会检查已入库的文件，发现盘符开头的路径或某个用户的主目录就失败。文档里需要举例时用 `<插件目录>`、`<DSH 安装目录>` 这样的占位符。

## 日常命令

```powershell
npm run build   # 生成 lib/client.js
npm test        # 全部单元与集成测试
npm run check   # build + test + node --check
```

改了 `src/shared/` 或 `src/client/` 之后必须重新 `npm run build`，否则 DSH 加载的还是旧的 `lib/client.js`。`test/v030.test.mjs` 会在 bundle 里的版本号与 `package.json` 不一致时失败，提醒重新构建。

## 修改代码时的约定

- `src/shared/` 和 `src/client/` 的文件会被拼成一个函数作用域：只写普通的顶层声明；顶层名字在所有文件间唯一（客户端辅助函数习惯加 `nmp` 前缀）；新增文件要加进 `scripts/build-client.mjs` 的 `INPUTS`，顺序即依赖顺序。
- 新增配置项：在 `src/shared/config.js` 的 `DEFAULT_CONFIG` 加默认值，并登记到 `NUMBER_FIELDS` / `STRING_FIELDS` / `BOOLEAN_FIELDS`；要在设置页显示数值项再加 `SETTING_LIMITS`。同步更新 [CONFIGURATION.md](CONFIGURATION.md)。
- 新增界面文字：在 `src/client/locales/` 的九个语言文件里都加上同一个键，位置相同（`test/i18n.test.mjs` 检查键、顺序和 `{key}` 这类占位符）。先写 `zh.js` 和 `en.js`，其余语言照英文翻译。
- 新增一种语言：加 `src/client/locales/<语言>.js`，登记到 `src/shared/config.js` 的 `LANGUAGE_IDS`、`src/client/i18n.js` 的字典和语言名称、`scripts/build-client.mjs` 的 `INPUTS`，再加 `locale/<语言>.json` 和 `README.<语言>.md`。
- 新增原因码：给它加 `reason.<code>` 文案。带细节的原因码写成 `<code>:<细节>`，文案只需覆盖冒号前的部分（见 `src/client/labels.js`）。
- 修改提示词：递增 `src/shared/prompt.js` 的 `PROMPT_VERSION`（它是结果缓存键的一部分）。
- 发版：同时改 `package.json` 的 `version` 和 `src/shared/version.js` 的 `PLUGIN_VERSION`，更新 `CHANGELOG.md`，然后 `npm run check`。

## 测试

`node --test "test/*.test.mjs"`，共 242 项。

| 文件 | 覆盖 |
|---|---|
| `shared.test.mjs` | 配置校验、协议、提示词、输出解析、快捷键 |
| `controller.test.mjs` | 浏览器状态机：触发、去重、切会话恢复、手动预测、候选切换 |
| `host-service.test.mjs` / `host-plugin.test.mjs` | Host 服务与插件入口（固定测试建议路径） |
| `p2-context.test.mjs` | 上下文提取、脱敏、裁剪、回合复核 |
| `p2-model-provider.test.mjs` | 模型调用、推理强度选择、回退 |
| `p2-ledger.test.mjs` | 预算预留与结算、跨日、重启后的重派发 |
| `p2-service.test.mjs` | 模型路径上的完整服务：缓存、并发、常用短句、多条候选 |
| `results-log.test.mjs` | 结果记录、轮换、汇总 |
| `request-registry.test.mjs` / `semantic-filter.test.mjs` / `ghost-conflict.test.mjs` | 各自的模块 |
| `v030.test.mjs` | 版本、模式、左侧栏选项、原因码文案、0.3.0 修复的回归 |
| `v040.test.mjs` | 0.4.0 修复的回归：遮蔽范围、配置字段名、快捷键限制、行分隔符、片段上限、次数与额度的退还、切会话恢复、后台无响应 |
| `i18n.test.mjs` | 九种语言的字典一致性、语言解析、`language` 配置项、打包内容、各语言 README 的语言栏 |
| `bundle-smoke.test.mjs` | 对 `lib/client.js` 的冒烟测试，见下 |
| `no-local-paths.test.mjs` | 已入库的文件里没有本机路径 |

### bundle 冒烟测试

`node --check` 只能证明 bundle 语法正确。`bundle-smoke.test.mjs` 像 DSH 一样加载它（ModuleLoader 工厂 + 宿主提供的 React），用假的 slot 注册表和一个进程内的真实 Host 服务把两半接起来，然后渲染设置页并点击：

- 所有扩展点都已注册，版本号正确；
- 设置页在九种语言下都能渲染，没有漏出未翻译的键或未替换的占位符；
- “跟随 DSH”随 DSH 的语言变化，在语言列表里选一项后页面和入口名称随之切换；
- 点“添加到左侧栏”后入口出现，再点一次入口消失而面板仍在；
- 点模式卡片后配置变成对应模式，改一项后变成“自定义”；
- 插件卸载时面板开着，会留下重新打开的标记。

它用一个极简的 React 替身（只调用组件并遍历返回值），不测真实的 DOM 行为；那部分由下面的端到端脚本覆盖。

## 端到端验证（隔离 profile）

不要在日常使用的 profile 上跑。脚本使用名为 `predictor-scratch` 的独立 profile 和 3090 端口，模型请求指向本机的 mock 服务（3091 端口），不消耗真实额度。

首次准备（`<DSH 安装目录>`、`<插件目录>` 换成实际位置）：

```powershell
$dsh = '<DSH 安装目录>\resources\runtime\cli\bin\dsh.cmd'
& $dsh --profile predictor-scratch --from-default-profile web
& $dsh plugin --profile predictor-scratch add '<插件目录>'
```

mock 模型路由写在该 profile 的 `cordis.patch.yml` 中（`llm-pi-ai` 的 `mock` 服务商，`agent-default-model` 指向它），做法见 `docs/p0-load-verification.md`。

每次验证：

```powershell
.\tools\launch-scratch-web.ps1 -ForceRestart        # 启动隔离的 Web GUI，URL 写入 scratch\logs\web-3090.url.txt
.\tools\mock-llm-control.ps1 -Action start          # 启动 mock 模型
$u = (Get-Content scratch\logs\web-3090.url.txt -Raw).Trim()

# 输入框交互矩阵（离线固定建议）
node tools/set-config.mjs --url $u --patch-file scratch/config-fixed.json
node tools/p1-e2e.mjs --url $u --out scratch/evidence --tag p1

# 模型链路矩阵（mock 模型，含非法 JSON、超时、预算耗尽的故障注入）
node tools/set-config.mjs --url $u --patch-file scratch/config-model.json
node tools/p2-e2e.mjs --url $u --out scratch/evidence --tag p2

.\tools\mock-llm-control.ps1 -Action stop
.\tools\stop-scratch-web.ps1
```

启动脚本设置 `NMP_DATA_HOME=scratch\data-home`，测试产生的账本和统计不会混入真实数据。URL 带有本次启动的访问令牌，`scratch/logs/` 和 `scratch/evidence/` 不入库。

0.4.0 的结果（2026-11-11，DSH 0.2.2-rc.1）：

| 脚本 | 结果 |
|---|---|
| `p1-e2e.mjs` | 13 步全部通过：加载、自动触发、Tab 采纳、撤销、Esc、输入法、菜单守卫、多输入框、占位符恢复、窄输入框、方向键采纳、冲突让位、零发送审计 |
| `p2-e2e.mjs` | 9 步全部通过：模型建议上屏、证据核对、采纳、撤销、非法 JSON、超时、预算耗尽、恢复 |
| 手动（浏览器） | 设置页标题显示 `v0.4.0`；“界面语言”选 English 后页面立即变为英文并出现“撤销”，面板保持打开；语言列表以各语言自己的名称列出九种语言；“跟随 DSH”时显示 DSH 的语言，且不受 `<html lang>` 被改动的影响；在页面不知情的情况下把配置改为韩语，左侧栏入口和输入框的“预测”按钮随即变为韩语 |

0.3.0 的结果（2026-11-10，DSH 0.2.2-rc.1）：

| 脚本 | 结果 |
|---|---|
| `p1-e2e.mjs` | 13 步全部通过：加载、自动触发、Tab 采纳、撤销、Esc、输入法、菜单守卫、多输入框、占位符恢复、窄输入框、方向键采纳、冲突让位、零发送审计 |
| `p2-e2e.mjs` | 9 步全部通过：模型建议上屏、证据核对、采纳、撤销、非法 JSON、超时、预算耗尽、恢复 |
| 手动（浏览器） | 设置页标题显示 `v0.3.0`；“添加到左侧栏”后左侧栏出现“消息预测”并可打开面板，刷新后入口仍在，移除后面板不关闭；切换“省流”后选项与卡片状态一致，“撤销”恢复原配置；近 7 天统计的“已采纳”对旧记录正确计数 |

更早阶段的记录见 `VALIDATION.md`、`VALIDATION-P2P4.md`。

### 重新生成 README 的截图

`docs/images/` 里的图片由 `tools/capture-screenshots.mjs` 从真实界面截取：它在隔离 profile 里用 mock 模型跑一段两轮的演示对话，截下输入框里的建议、动图的各帧、模式卡片、左侧栏入口和完整的设置页，最后把界面语言依次切到英语、日语、西班牙语和俄语，拼成 `languages.png`。界面有变化时重新运行即可。

```powershell
# 用一个空的统计目录启动，截图里的“近 7 天统计”才只包含这次演示
$env:NMP_DATA_HOME = "$PWD\scratch\data-home-demo"
Remove-Item -Recurse -Force $env:NMP_DATA_HOME -ErrorAction SilentlyContinue
.\tools\launch-scratch-web.ps1 -ForceRestart
.\tools\mock-llm-control.ps1 -Action start
$u = (Get-Content scratch\logs\web-3090.url.txt -Raw).Trim()

node tools/capture-screenshots.mjs --url $u

.\tools\mock-llm-control.ps1 -Action stop
.\tools\stop-scratch-web.ps1
Remove-Item Env:NMP_DATA_HOME
```

脚本只截取属于本插件或演示对话的区域，侧栏里的会话列表不会进入图片。结束时它会把隔离 profile 的插件配置和 mock 的回复恢复原样；演示对话本身会留在会话列表里。`demo.png` 是动画 PNG（APNG），不支持动画的查看器会显示第一帧。提交前请逐张看一遍，确认没有不该公开的内容。

其他脚本：

| 脚本 | 用途 |
|---|---|
| `tools/p1-config-toggle.mjs` | 设置页开关与配置写入 |
| `tools/p4-real-e2e.mjs` | 真实模型试用（需要把 scratch profile 的默认模型切到真实路由，会产生费用） |
| `tools/dsh-driver.mjs` | 通用浏览器驱动：`inspect` / `smoke` / `load-proof` |
| `tools/session-turn.mjs`、`tools/replay-context.mjs`、`tools/debug-probe.mjs` | 造一个回合、回放上下文构建、读取运行时状态 |
| `eval/*.mjs` | 质量评测：合成样本（`evaluate.mjs`、`merge-reports.mjs`）、真实会话回放（`replay-eval.mjs`）、“换一条”与多条候选（`regen-eval.mjs`、`candidates-eval.mjs`） |

## 调试入口

DSH 窗口的开发者工具控制台：

```js
__nextMessagePredictor.version        // 浏览器 bundle 的版本
__nextMessagePredictor.state()        // 当前建议状态、配置、最近一次视图快照
__nextMessagePredictor.config()       // 生效配置、配置版本、后台版本
__nextMessagePredictor.predictNow()   // 手动请求一次（受次数与预算限制）
__nextMessagePredictor.suggest('测试') // 只在本地画一条建议，不经过后台
__nextMessagePredictor.clear()
__nextMessagePredictor.openPanel()    // 在主区域打开插件面板（等同点击左侧栏入口）
__nextMessagePredictor.reloadConfig()
```

Host 日志以 `[next-message-predictor]` 开头，只有原因码、耗时、模型标识和用量，不含对话或建议的文字。启动时打印一行 `host ready v<版本>`。

## 排查

| 现象 | 先看 |
|---|---|
| 设置页空白或面板空白 | 控制台里的 `slot entry crashed`；运行 `npm test` 看冒烟测试 |
| 改了代码不生效 | 是否 `npm run build`；是否重启了 DSH（Host 半）或刷新了页面（浏览器半）；设置页是否提示版本不一致 |
| 一直不出建议 | 设置页“当前状态”；“高级选项 → 诊断信息”的计数；Host 日志里的 `stale` / `abstain` 原因 |
| 保存设置失败 | 提示里的原因；`能力` 一行的 `configEditor` 是否为 `true` |
