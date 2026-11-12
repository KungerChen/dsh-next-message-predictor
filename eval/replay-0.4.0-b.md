# O05 真实会话回放（0.4.0-b）

- 提示词：`nmp-p2-v3`；模型：deepseek-official / deepseek-flash；maxTokens=256；effort=off
- 样本：15 条（来自 8 个会话，平均上下文 1523 估算 token）

| 指标 | 值 |
|---|---:|
| offerRatePct | 93.3 |
| abstainRatePct | 6.7 |
| invalidRatePct | 0 |
| errorCodes | {} |
| exactMatchCount | 2 |
| exactMatchOfAllPct | 13.3 |
| prefixRatioOfAllPct | 14.1 |
| exactMatchPct | 14.3 |
| avgPrefixChars | 1.286 |
| avgPrefixRatioPct | 15.1 |
| avgEditRatio | 0.192 |
| potentialSavingPct | 15.1 |
| violationCount | 0 |
| violationRatePct | 0 |
| samplesWithMasking | 5 |
| maskingHitsTotal | 10 |
| truncatedSamples | 9 |
| hardCappedSamples | 0 |
| latencyP50 | 1570 |
| latencyP95 | 1848 |
| avgInputTokens | 187 |
| avgInputTokensInclCache | 1125.667 |
| avgOutputTokens | 12.867 |
| totalInputTokens | 2805 |
| totalOutputTokens | 193 |

报告只含分数与哈希，不含对话正文；逐条结果见同名 JSON。