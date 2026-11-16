# 焦点显示修复与 Tab 一键发送

<a id="20261115-focus-tab-send"></a>

- 记录 ID `20261115-focus-tab-send`
- 开始时间 2026-11-15 09:43:53 America/Los_Angeles（PST，UTC 17:43:53）
- 状态 用户已确认焦点显示及 Tab 一键发送。0.7.0 本地候选，未提交或发布。
- 基线 `main`，与 `origin/main` 同步，HEAD `5321e10eaa5cf2c52b7d5c0c7eedab671c57b6e3`，已发布产品基线 0.6.0。

## 授权和验收条件

用户批准先修关闭“仅在输入框获得焦点时显示预测”时的聚焦显示，再加入默认关闭的 Tab 一键发送，完成测试和文档后交付手工验收。当前范围为仓库工作区与隔离验证。

1. 显示修复。关闭焦点开关时，前台窗口的空输入框在聚焦和失焦两种状态都能看到仍有效的建议。开启时仅在聚焦时显示。焦点往返应复用建议，并保持草稿、输入法、菜单、回合、窗口和冲突等保护。
2. 发送开关。默认、缺字段的旧配置和恢复默认均为关闭，模式预设保留用户选择。首次切换为开启时明确提示误发风险并要求确认，开启期间输入框持续提示 Tab 发送语义。关闭时 Tab 和对应按钮只填入草稿。开启时仅用户主动按 Tab 或点击对应发送按钮且保护条件成立时才走宿主提交路径；右方向键只填入草稿，Esc 只隐藏。
3. 发送边界。失焦、保护条件不满足、建议失效或上下文不一致时均不得发送；同一后台的同一回合跨窗口防重，区分填入、交给宿主提交和宿主确认。预测完成或显示不得自行提交，也不得形成自动续聊。
4. 验收层次。先取得显示回归证据，运行针对性自动化与正式检查；使用隔离 DSH 验证编辑器与发送状态；提供手工验收，逐层记录失败和未验证项。

## 工作区和回退

动手前已存在 `docs/DEVELOPMENT.md`、`docs/README.md` 的未提交修改，以及未跟踪的 `AGENTS.md`、`docs/maintenance/2026-11-14-project-docs.md`、`docs/maintenance/20261115-085644-rules-alignment.md`。这些实际文件的逐字节副本及两个已跟踪文件的二进制差异保存在忽略目录 `scratch/evidence/focus-tab-send-baseline/`，其中 `preexisting-tracked.patch` 可用于核对原有差异。回退本轮时以这些副本和当前差异核对，已跟踪且原先干净的文件可按上述 HEAD 对照。当前无本轮提交。

## 进展和证据

- 已核对项目规则、基线和原有工作区，保存回退参考，并登记本轮记录。
- 接下来依次核对显示复现、发送配置和实际提交保护，更新对应规范与生成源，再记录测试、隔离运行和待人工验收结果。

### 隔离环境准备

- 一次合并执行新建隔离 profile、关联插件、写入 mock 路由并启动的命令被自动审批拒绝，返回 `rejected: blocked by policy`，无进一步原因。随后单独创建目录和 profile 成功，后续步骤停止，服务未启动。
- 内置浏览器初始化完成，打开空标签页时缺少所需网络策略。Computer Use 初始化缺少 Codex app-server 路径。两处均未取得页面或桌面观察结果。
- 焦点修复相关的 58 项既有离线测试通过。专门的失焦到聚焦渲染复现仍在调查；上述结果尚未覆盖本轮症状。

- 用户随后明确授权已审阅的隔离启动方案，目录为 `scratch/data-home-focus-20261115-approved/`，DSH Web/mock 各用端口 3090/3091。此处仅记录授权，具体启动结果和复现证据另记。

### 复现补充与生成文档

- 用户补充桌面复现路径：从上一条用户消息发出后一直保持输入框焦点，等助手回答完成，自动预测始终不显示；此时按 Alt+反斜杠触发的手动预测可以显示。应分别覆盖始终聚焦和焦点进入/退出，关闭焦点开关的两条路径均应正常显示。
- 阶段二接口已定为 `sendOnTab`（布尔，默认关闭）。浏览器采用 DSH 公开的 `inputActions.submit()`；Host 以公开 `sessionController.state`、`verifyAnchor()` 复核回合，并按会话和规范回合在当前 Host 进程内原子授权。授权跨插件配置重载共享，进程重启使旧授权失效。普通手动发送仍由宿主管理。
- 已将 Tab 默认填入、主动启用后的发送动作、右方向键始终填入和误发风险写入九语言 README 生成源。执行 `npm run readme`、`node tools/build-readmes.mjs --check` 和 `git diff --check` 均通过。该检查覆盖生成一致性。

### 焦点显示调查

- 受控 React DOM 搭配模拟 Host 的复现中，会话完成投影已更新时 composer 暂处于 `sending`，约 300 ms 后恢复 `plain`。期间输入框始终聚焦且为空，会话可用，但 Host 自动预测调用为 0，未显示建议。观察记录为 `trace-transient-phase.json`。
- 隔离 DSH 的普通回合在初次检查中通过，未出现上述状态时序。用户现场表现和受控复现相符，现场的具体时序仍待核对。
- 批准只对短暂 `input-frozen` 在现有有界观察期内保留自动触发机会。其余预测和显示保护维持原有要求，并需以同一复现的修复前失败、修复后通过作为验证。

### 阶段一修复与验证

- `src/client/controller.js` 仅在 `input-frozen` 是唯一阻塞时保留原有五秒完成观察期，配置版本变化会撤回待触发状态。控制器和真实 Host 双客户端测试覆盖冻结恢复、失焦策略、会话暂停恢复及其他守卫。修复前回归断言预期一次自动预测而实际为零；修复后控制器、显示和会话集成共 77 项通过，后补暂停用例单独 1 项通过。
- 使用相同受控 Chromium、React DOM 和模拟 Host，修复后恢复到 `plain`，观察到一次自动预测和可见建议。修复前后分别是 `scratch/data-home-focus-investigation-20261115/trace-transient-phase.json` 和 `trace-transient-phase-fixed.json`；脚本、摘要及阶段补丁同目录，分别为 `render-probe.mjs`、`stage1-evidence.md` 和 `stage1.patch`。
- 经用户授权的隔离 DSH Web 和本机 mock 已启动。普通合成回合的基线和重新构建后均显示自动建议，未复现短暂冻结顺序。轨迹和截图为 `scratch/data-home-focus-20261115-approved/focused-turn.json`、`focused-turn.png` 与对应的 `focused-turn-fixed.json`、`focused-turn-fixed.png`。主代理目视复核了基线截图，灰字、Tab 采纳和换一条可见，无明显遮挡。这组早期轨迹未独立确认重建后加载字节，20 ms 采样也无法证明持续聚焦。随后用 `focused-verified.json` 核对插件 HTTP 响应精确含阶段一的本地 bundle，原配置下不按手动快捷键，合成回合结束且聚焦时观察到自动预测和可见建议；已目视检查 `focused-verified-automatic.png`。隔离 Web 普通路径仍未复现原生桌面症状。
- 阶段二以 0.7.0 为本地候选版本，继续实现和验证一键发送。隔离服务留给阶段二复用，结束后需按已审启动脚本停止并核对。

### 阶段二实现与首轮隔离观察

- `package.json`、`src/shared/version.js` 和生成 bundle 已同步为 0.7.0 本地候选，CHANGELOG 标为未发布。九语言 README 与插件元数据描述已同步。正式验收以最终检查为准。
- `src/client/overlay.js` 按当前输入框和建议身份执行 Tab 或按钮操作；一键发送还要申请 `send.claim`，等待期间复核输入框、焦点、选择和会话。提交只走 DSH 的 `inputActions.submit()`。开关、确认与绘制诊断位于 `src/client/settings.js`；客户端文案位于 `src/client/locales/`。Host 侧在 `src/host/predictor-service.js` 复核权威回合与会话状态，由 `src/host/session-state.js` 对同一回合原子授权。授权统计与 DSH 实际消息分别核对。
- 首轮隔离 Web 报告已覆盖 0.7.0、实际加载 bundle、宿主能力、默认 Tab 只填草稿及取消启用。后续导航停在插件设置页，查找 composer 超时并中断，其余送出场景此轮未运行。主代理查看了中断截图；该失败发生在测试切换页面步骤。
- 证据更正：首轮失败 JSON 后来被重跑覆盖。主代理在覆盖前读取到 9 项通过、随后 composer 定位超时。之后名为 `attempt-01-navigation.json` 的文件实际包含 19 项通过的快速重跑，不能充当首轮失败的原始报告；首轮中断截图仍在。主代理另查看 `tab-send-candidate.png`，可见灰色候选和“Tab 发送”字样。
- 定位修正后，`scratch/evidence/20261115-tab-send-contract/full-02/isolated-send.json` 前 23 项通过，因浏览器第二页创建方式中断。随后 `full-03/isolated-send.json` 28 项均通过，记录 bundle SHA-256 `c66e7dcff4f7f9837ae2fdfb1b181f4201d95b73b980f1361cd948608285acb2`，与该阶段本地构建一致。覆盖默认 Tab 和右方向键零提交、启用后 Tab 和按钮各一次真实 DSH 会话提交、模拟 HTTP 503 后保留草稿且只尝试一次、取消/启用/关闭、预测模式保留及恢复默认。第二个已登录 Web 页面直接调用同一授权 API 被拒，验证后台防重；未模拟两窗口同时按键。配套截图在同目录。
- 同一阶段 `npm run check` 共 371 项通过，报告位于 `scratch/evidence/20261115-tab-send-contract/check-01.txt`。此处是诊断改动前的构建记录。

### 最终候选验证

- 最终 Host 在 `verifyAnchor()` 前后各读一次被动会话状态，游标不同即拒绝授权；对应自动化用例覆盖冷会话游标推进、期间暂停、配置变化和取消。显示诊断在离开输入框视图后保留为“最近一次候选显示”；显示和一键发送授权计数分别核对。
- `npm run check` 通过，376 项测试全通过，详见 `scratch/evidence/20261115-tab-send-contract/check-final.txt`。包含构建、九语言 README 一致性、自动化和语法检查。
- 隔离 DSH Web、合成会话与本机 mock 的最终报告 `scratch/evidence/20261115-tab-send-contract/final-04/isolated-send.json` 57 项全通过，Host 和前端均 0.7.0；实际加载 bundle SHA-256 为 `1e194b5827c1187e867672329b2bcc2ceb0c7d66abaacebf7b8f9cf9f0e32c9f`，与本地 `lib/client.js` 匹配。共观察到 15 次 DSH HTTP 原生提交请求，包含 11 次准备输入、3 次成功路径（含延迟无变化对照）和 1 次模拟 HTTP 503，WebSocket 提交为零。第二已认证页面直接调用授权 API 被拒，覆盖同后台的防重边界。
- 持有真实、在途的授权响应时，插入再移除菜单节点、打开再关闭 `aria-expanded`、改变再恢复选择、失焦再复焦，均未提交或插入迟到草稿；同样延迟而无变化的对照提交一次。设置页保留最近一次显示阻塞也通过验证。最终设置、候选、失败留草稿和诊断截图在 `final-04/`。
- 桌面原生、真实日常复现、原生多窗口同时按键、物理输入设备或其他宿主版本未覆盖。跨插件与普通 DSH 手工发送没有全局事务承诺。当前候选未发布、无提交，日常 DSH 未重启，待用户手工验收原症状和显式发送。
- 主代理目视核对 `final-04/rejected-draft.png` 的宿主 503 提示和保留的草稿、`final-04/tab-sent.png` 的单条预测用户消息，以及 `diagnostic-visual-05/display-diagnostics.png` 的“最近一次候选显示：输入框未聚焦”。早一轮 `full-03/` 的设置确认、持续警示和动态快捷键图例也已目视核对。独立源码和证据审核未发现新阻塞。
- 再次核对九份元数据 JSON 可解析、九语言 README 与生成源一致、`git diff --check` 通过。原有 `docs/DEVELOPMENT.md` 与两份历史维护记录和基线副本逐字节相同，索引及 AGENTS 仅增加本轮行或修改本轮相关规则。
- 阶段二结束后按审过的隔离脚本停止 DSH Web 与 mock。停止前核验 PID 45532、47276 对应各自进程，停止后两 PID 均不存在，3090/3091 监听数均为 0。日常 DSH 保持原运行状态，隔离证据保留。
- 本地候选的下一步是按交付的桌面验收指南核对持续聚焦、焦点开关、Tab/按钮、Esc、右方向键与中文输入法。未确认日常根因前保留上述现场边界；发布与日常启用另按授权处理。

### 用户验收（2026-11-15，America/Los_Angeles）

- 用户在 DSH 原生桌面验收后确认通过，焦点显示和一键发送均正常。物理输入法、原生多窗口并发及其他宿主版本的本轮覆盖情况仍未确认。
- 九语言 README 已包含焦点显示策略、默认填草稿、启用后的 Tab 一键发送和右方向键用法。0.7.0 仍是未提交或发布的本地候选。
- 用户另提出插件更新后自动生效，并在前后台版本不一致且必要时提供一键重启 DSH。该需求目前处于只读调查阶段。
