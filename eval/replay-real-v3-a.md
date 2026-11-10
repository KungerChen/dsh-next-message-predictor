# O05 真实会话回放（real-v3-a）

- 提示词：`nmp-p2-v3`；模型：deepseek-official / deepseek-flash；maxTokens=96；effort=off
- 样本：15 条（来自 8 个会话，平均上下文 1523 估算 token）

| 指标 | 值 |
|---|---:|
| offerRatePct | 86.7 |
| abstainRatePct | 13.3 |
| invalidRatePct | 0 |
| errorCodes | {} |
| exactMatchCount | 1 |
| exactMatchOfAllPct | 6.7 |
| prefixRatioOfAllPct | 10 |
| exactMatchPct | 7.7 |
| avgPrefixChars | 1 |
| avgPrefixRatioPct | 11.5 |
| avgEditRatio | 0.12 |
| potentialSavingPct | 11.5 |
| violationCount | 0 |
| violationRatePct | 0 |
| latencyP50 | 1849 |
| latencyP95 | 2519 |
| avgInputTokens | 289.533 |
| avgInputTokensInclCache | 1125.8 |
| avgOutputTokens | 13.733 |
| totalInputTokens | 4343 |
| totalOutputTokens | 206 |

报告只含分数与哈希，不含对话正文；逐条结果见同名 JSON。