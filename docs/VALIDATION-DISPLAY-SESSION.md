# 显示、会话和统计验证

本次验证使用隔离的原生 Electron Desktop、独立 userData、DSH_HOME 和插件数据目录；默认模型指向本机 mock。桌面程序自身仍可能检查更新，模型 mock 不意味着整个程序不联网。测试不使用日常会话或配置。

## 统计

`matchScore` 将空白归一化后按 Unicode code point 计数，历史字段名 `suggestionGraphemes` / `userGraphemes` 保留兼容。去除相同前后缀后，编辑距离在计算预算内精确计算；一侧为空或剩余字符集合互不相交时也能精确计算。超出预算且无法证明精确距离时，`editRatio` 是保守相似度下界，`scoreExact` 为 `false`，落盘字段 `editExact` 为 `false`。多个候选中存在未知距离且没有完全匹配时，最佳分数同样标为下界。历史记录没有 `editExact`，不能据此推断其精度。

定向测试覆盖长无关回复、超预算下界、长文本局部改动、Unicode、空输入及真实 `noteUserMessage` 写盘路径。无正文落盘的检查使用临时目录。

## 桌面显示

`tools/desktop-display-e2e.mjs` 连接操作员提供的 loopback CDP 端口；必须提供 `--isolated-desktop`、独立 mock 日志和输出目录。它会更改隔离 profile 配置并发送合成测试消息，只能对已确认隔离的实例运行。报告只含检查结果；截图和运行日志应放在被 Git 忽略的目录中。Playwright CDP 模拟输入不等同于物理键盘、操作系统输入法或物理 DPI 验证。

## 0.6.0 验证

本轮隔离候选客户端 bundle SHA-256 为 `6692B5C9975E00AD6F9EE460301922C41F7EB205B6D3E6A9FEF021ACCF69DA86`，原生宿主为 DSH Desktop `0.2.2-rc.3`。本轮证据路径均相对于被忽略的 `scratch/desktop-isolated/undo-round-2/`。所有消息与模型回复均为隔离合成数据，本机 mock 只覆盖模型调用，桌面程序自身仍可能检查更新。

| 层级 | 结果与范围 |
| --- | --- |
| 自动检查 | 最终候选的 `npm run check` 344/344；`logs/v060-targeted.log` 中焦点/历史测试与双客户端集成测试 30/30。附件、引用、会话、焦点及编辑状态变化后的拒绝路径属于模拟测试，不代表真实附件界面操作；具体日志以本轮最终检查为准。 |
| 原生 Desktop 撤销与重做 | `evidence/v060-strict-1/`、`v060-strict-2/`、`v060-strict-3/` 各 23/23：自然合成回合完成前将焦点移出输入框、其他控件 Tab、真实点击输入框后采纳、撤销、重做、后续输入及连续撤销。消息投影和 mock 调用计数未因采纳或撤销增加。这里的键鼠由 Playwright CDP 驱动。 |
| 原生 Desktop 已有历史 | `evidence/v060-history/desktop-history.json` 10/10：用户逐键输入并清空草稿，先独立证明清空可撤销/重做，再采纳建议；两次撤销依次去除建议和恢复原草稿，两次重做依次恢复清空和建议。 |
| 原生窗口布局 | `evidence/v060-native-capture/` 的英文三组与 `evidence/v060-native-zh/` 的中文三组使用 Electron `BrowserWindow.setBounds`、`webContents.setZoomFactor` 与原生 `capturePage`。实际窗口普通尺寸约 1002×901、窄尺寸约 602×901，页面缩放分别为 100% 和 150%。中英文正常、窄窗口及窄窗口加 150% 页面缩放的截图均可见候选、提示、换一条与暂停控件；稳定几何记录见各目录 JSON。当前显示器的系统 `scaleFactor` 为 **2.25**；额外 150% 是应用页面缩放，不是操作系统切换至 150% DPI。 |
| Web 跨页面 | `evidence/v060-web/web-session-sync.json` 为 10/10：同一认证浏览器 context 的两个独立 **headless** 页面连接独立 Web Host，验证同一会话暂停、恢复、采纳和忽略同步；该层不等同于原生 Desktop 多窗口。 |
| 用户真实输入法手测 | 用户反馈三步均符合预期：真实 Windows 中文输入法组合期间隐藏建议，仅输入本人文字且未自动采纳或发送；清空后 Tab 采纳、Ctrl+Z 清空、Ctrl+Shift+Z 恢复。该结果是用户回执，与上面的 CDP 自动化分开记录。 |

本轮重新建立的相同严格焦点轨迹基线（上轮 bundle `615F…D74D`）仍复现采纳后第一次 Ctrl+Z 不生效，见 `evidence/baseline/`；0.6.0 的三轮通过结果见上表。先前空文本插入实验会增加不可见撤销步骤，未采用。屏障实验中曾有一个失败样本的用户删除在采纳前本身不可撤销，不作为历史回归结论；随后增加独立历史前置检查的有效样本通过。

**未验证：** 用户反馈后尝试只读复核时，隔离桌面 PID 已退出且调试端口不可连接，因此无法独立读取手测最终草稿或比较手测前后消息计数；不将用户回执描述为自动观察。其他操作系统 DPI 档位、其他输入法、原生 Desktop 多窗口、不同 DSH 版本和日常安装自然会话仍未验证。手测后确认隔离桌面已退出，按测试 PID 停止 mock 和独立 Web Host，并确认对应端口无监听；驱动因等待已退出的应用而中断，证据目录保留。

## 上一轮 0.5.1 结果（历史）

以下结果对应客户端 bundle SHA-256 `615F8A1496C9A057BEA2B143A1907F07126AB7DD2A435F647F85E98049A1D74D`，DSH Desktop `0.2.2-rc.3`。合成测试数据、去敏 JSON、截图和原始日志保留于被忽略的 `scratch/desktop-isolated/`；下列证据路径相对于该目录。最终完整检查日志为 `scratch/logs/final-check-615f.txt`。

| 层级 | 结果与范围 |
| --- | --- |
| 自动检查 | `npm run check` 通过，331/331；单独的双真实客户端与单 Host 服务集成测试 `final-integration.log` 为 5/5。集成覆盖共同生产、采纳和忽略、旧快照乱序、暂停在途和恢复、会话隔离、断连重连；使用固定测试提供方，不能代替真实桌面/网络验证。 |
| 原生 Desktop 显示 | `final-desktop-2/display/desktop-display.json` 中 11 项通过后，第 12 项撤销失败而中断；不能把后续未执行项目计为通过。失焦显示、实际像素、提示、其他控件 Tab 和真实聚焦后准确插入通过。 |
| 原生 Desktop 焦点选项 | `final-desktop-2/focus/desktop-focus.json` 为 4/4：要求焦点时失焦隐藏、聚焦显示已有结果且没有新增模型调用。 |
| 原生 Desktop 会话 | `final-desktop-2/session-3/desktop-session.json` 为 9/9：暂停、页面刷新、保存设置、恢复及恢复后新回合自动预测；截图为 `session-3/paused.png`。 |
| 原生 Desktop 其他对照 | `final-desktop-2/controls/desktop-undo-controls.json` 的一次普通键入和聚焦后 Tab 采纳撤销通过；其中“after resume”标签依赖先前状态，恢复后新回合的独立证据以 `session-3` 为准。 |
| Web 跨页面 | `web-final-6/web-session-sync.json` 为 10/10：同一认证浏览器 context 中两个独立页面连接单个隔离 Web Host，验证同会话暂停、恢复、采纳和忽略传播。两次终态场景各观察到一次本机 mock 预测。这不是两个原生 Desktop 窗口，也不是 Desktop 与 Web 共用同一 Host。 |
| 布局 | `final-desktop-2/layout-4/` 中中英文正常视口截图可见候选和控件；CDP 视口覆盖及 CSS 150% 缩放的几何数据已记录，但测量与截图存在不一致，且未验证视口裁剪，不能认定窄视口或 150% 布局通过。窄视口截图超时，150% 截图未显示输入框。 |

**已知未通过：** 原生 Desktop 的合成交互中，发送并收到回复后，真实点击输入框再点击采纳，文本准确插入，但一次 Ctrl+Z 未撤销（`final-desktop-2/display/desktop-display.json`）。同一焦点轨迹在未修改的 `8e882d6` 基线中按钮和 Tab 两次均复现（`baseline-evidence-3/desktop-undo-baseline.json`）；另一次聚焦 Tab 对照通过，因此不能将限制泛化为所有撤销都失败。只读追踪及宿主契约分析表明提交草稿后宿主会清空历史，某些焦点轨迹下首次插入缺少可撤销前态。隔离实验先调用公开空插入虽能改善该情形，却在已有历史中增加空撤销步骤，因而未采用。该限制仍需在交付时如实说明。

**NOT VERIFIED：** 物理键盘、操作系统输入法与物理 DPI；原生 Desktop 多窗口；窄视口和 150% 缩放的完整可见布局；日常安装中的自然会话；长时间运行与所有宿主版本。CDP 键盘和合成输入法事件不能替代物理操作。模型请求使用本机 mock；Desktop 自身可能联网检查更新。

上一轮创建的 Desktop 最终和基线进程、独立 Web Host 与 mock 均按各自测试 PID 和身份关闭，端口已确认不再监听；浏览器测试脚本关闭其创建的 browser。测试目录未清理。
