# O05 真实会话回放（real-v3-b）

- 提示词：`nmp-p2-v3`；模型：deepseek-official / deepseek-flash；maxTokens=96；effort=off
- 样本：34 条（来自 13 个会话，平均上下文 1621 估算 token）

| 指标 | 值 |
|---|---:|
| offerRatePct | 76.5 |
| abstainRatePct | 23.5 |
| invalidRatePct | 0 |
| errorCodes | {} |
| exactMatchCount | 2 |
| exactMatchOfAllPct | 5.9 |
| prefixRatioOfAllPct | 6.2 |
| exactMatchPct | 7.7 |
| avgPrefixChars | 0.731 |
| avgPrefixRatioPct | 8.2 |
| avgEditRatio | 0.12 |
| potentialSavingPct | 8.2 |
| violationCount | 0 |
| violationRatePct | 0 |
| latencyP50 | 1822 |
| latencyP95 | 2410 |
| avgInputTokens | 649.676 |
| avgInputTokensInclCache | 1225.676 |
| avgOutputTokens | 11.147 |
| totalInputTokens | 22089 |
| totalOutputTokens | 379 |

报告只含分数与哈希，不含对话正文；逐条结果见同名 JSON。