# O05 真实会话回放（0.3.0-rerun）

- 提示词：`nmp-p2-v3`；模型：deepseek-official / deepseek-flash；maxTokens=256；effort=off
- 样本：15 条（来自 8 个会话，平均上下文 1523 估算 token）

| 指标 | 值 |
|---|---:|
| offerRatePct | 80 |
| abstainRatePct | 20 |
| invalidRatePct | 0 |
| errorCodes | {} |
| exactMatchCount | 2 |
| exactMatchOfAllPct | 13.3 |
| prefixRatioOfAllPct | 14.2 |
| exactMatchPct | 16.7 |
| avgPrefixChars | 1.583 |
| avgPrefixRatioPct | 17.7 |
| avgEditRatio | 0.212 |
| potentialSavingPct | 17.7 |
| violationCount | 0 |
| violationRatePct | 0 |
| samplesWithMasking | 0 |
| maskingHitsTotal | 0 |
| truncatedSamples | 9 |
| hardCappedSamples | 0 |
| latencyP50 | 1622 |
| latencyP95 | 2526 |
| avgInputTokens | 187.133 |
| avgInputTokensInclCache | 1125.8 |
| avgOutputTokens | 10.467 |
| totalInputTokens | 2807 |
| totalOutputTokens | 157 |

报告只含分数与哈希，不含对话正文；逐条结果见同名 JSON。