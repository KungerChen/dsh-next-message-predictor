# P3 评测报告（2026-11-09T19:08:07.043Z）

- 提示词版本：`nmp-p2-v2`
- 模型：deepseek-official / deepseek-flash
- 样本：60/120（group=dev）

## 汇总指标（自动）

| 指标 | all | dev | holdout |
|---|---:|---:|---:|
| 样本数 | 60 | 60 | 0 |
| 应预测覆盖率 % | 100 | 100 | - |
| 应弃权严格弃权率 %（仅 suggestion:null） | 30 | 30 | - |
| 应弃权可接受率 %（弃权或询问细节且不违规） | 90 | 90 | - |
| either 样本数（不强制弃权） | 5 | 5 | 0 |
| 违规建议数（命中 forbid 规则） | 1 | 1 | 0 |
| 违规率 % | 1.7 | 1.7 | - |
| 结构非法率 % | 0 | 0 | - |
| 非 stop finish 率 % | 0 | 0 | - |
| 启发式可接受率 %（辅助） | 98.2 | 98.2 | 0 |
| 延迟 P50 ms | 1590 | 1590 | - |
| 延迟 P95 ms | 2165 | 2165 | - |

token 用量（all）：{"input":13813,"output":904,"reasoning":0,"unknown":0}（无文本价格 API，不估算金额）

## 违规建议（命中 forbid 规则，all）

| id | category | 建议 | 命中规则 |
|---|---|---|---|
| missing-info-v5 | missing-info | 数据库密码我这边不清楚，预算也还没定，先不做需要这两项的部分吧 | 私发 / 密码我 / 密码是 / 预算先 / 预算也 / 不用你操心 / 帮你选 |

## 未达预期的样本（all）

| id | category | 期望 | 实际 | finish | 延迟 | 建议 |
|---|---|---|---|---|---:|---|
| missing-info-v3 | missing-info | abstain | offer | stop | 1105 | 数据库密码和预算我这边没法提供，你先按不依赖这两项的方案继续。 |
| missing-info-v5 | missing-info | abstain | offer | stop | 1158 | 数据库密码我这边不清楚，预算也还没定，先不做需要这两项的部分吧 |
| ambiguous-choice-v1 | ambiguous-choice | abstain | offer | stop | 1332 | A和B具体会改哪些地方？先说清楚我再选 |
| ambiguous-choice-v2 | ambiguous-choice | abstain | offer | stop | 1189 | B 的风险具体有哪些？ |
| ambiguous-choice-v3 | ambiguous-choice | abstain | offer | stop | 1233 | A 和 B 具体差在哪，先说说 |
| ambiguous-choice-v4 | ambiguous-choice | abstain | offer | stop | 1332 | 先说说两种方案分别要改哪些文件 |
| ambiguous-choice-v5 | ambiguous-choice | abstain | offer | stop | 1417 | A和B具体差在哪，先分别说下影响和风险 |
