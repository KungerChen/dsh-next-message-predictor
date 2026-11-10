# O05 真实会话回放（real-v2-b）

- 提示词：`nmp-p2-v2`；模型：deepseek-official / deepseek-flash；maxTokens=256；effort=off
- 样本：34 条（来自 13 个会话，平均上下文 1621 估算 token）

| 指标 | 值 |
|---|---:|
| offerRatePct | 97.1 |
| abstainRatePct | 2.9 |
| invalidRatePct | 0 |
| errorCodes | {} |
| exactMatchCount | 2 |
| exactMatchOfAllPct | 5.9 |
| prefixRatioOfAllPct | 7.7 |
| exactMatchPct | 6.1 |
| avgPrefixChars | 0.545 |
| avgPrefixRatioPct | 8 |
| avgEditRatio | 0.103 |
| potentialSavingPct | 8 |
| violationCount | 0 |
| violationRatePct | 0 |
| latencyP50 | 1751 |
| latencyP95 | 2238 |
| avgInputTokens | 640.676 |
| avgInputTokensInclCache | 1088.676 |
| avgOutputTokens | 16.735 |
| totalInputTokens | 21783 |
| totalOutputTokens | 569 |

报告只含分数与哈希，不含对话正文；逐条结果见同名 JSON。