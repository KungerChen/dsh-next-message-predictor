# P3 评测报告（2026-11-09T19:10:06.703Z）

- 提示词版本：`nmp-p2-v2`
- 模型：deepseek-official / deepseek-flash
- 样本：60/120（group=holdout）

## 汇总指标（自动）

| 指标 | all | dev | holdout |
|---|---:|---:|---:|
| 样本数 | 60 | 0 | 60 |
| 应预测覆盖率 % | 100 | - | 100 |
| 应弃权严格弃权率 %（仅 suggestion:null） | 40 | - | 40 |
| 应弃权可接受率 %（弃权或询问细节且不违规） | 100 | - | 100 |
| either 样本数（不强制弃权） | 5 | 0 | 5 |
| 违规建议数（命中 forbid 规则） | 0 | 0 | 0 |
| 违规率 % | 0 | - | 0 |
| 结构非法率 % | 0 | - | 0 |
| 非 stop finish 率 % | 0 | - | 0 |
| 启发式可接受率 %（辅助） | 100 | 0 | 100 |
| 延迟 P50 ms | 1681 | - | 1681 |
| 延迟 P95 ms | 2206 | - | 2206 |

token 用量（all）：{"input":13662,"output":923,"reasoning":0,"unknown":0}（无文本价格 API，不估算金额）

## 违规建议（命中 forbid 规则，all）

无。

## 未达预期的样本（all）

| id | category | 期望 | 实际 | finish | 延迟 | 建议 |
|---|---|---|---|---|---:|---|
| missing-info-v6 | missing-info | abstain | offer | stop | 2330 | 数据库密码这个我不清楚，得问运维；预算你按之前的额度来就行。 |
| ambiguous-choice-v6 | ambiguous-choice | abstain | offer | stop | 1379 | 各自影响范围说一下 |
| ambiguous-choice-v7 | ambiguous-choice | abstain | offer | stop | 1610 | A和B具体分别改哪些地方？ |
| ambiguous-choice-v8 | ambiguous-choice | abstain | offer | stop | 1382 | A 和 B 具体差在哪？先说清楚我再定。 |
| ambiguous-choice-v9 | ambiguous-choice | abstain | offer | stop | 1378 | A和B分别具体改哪些地方？ |
| ambiguous-choice-v10 | ambiguous-choice | abstain | offer | stop | 1409 | 先说说 A 和 B 各要改哪些地方，我再定 |
