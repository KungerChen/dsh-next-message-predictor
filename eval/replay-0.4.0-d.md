# O05 真实会话回放（0.4.0-d）

- 提示词：`nmp-p2-v3`；模型：deepseek-official / deepseek-flash；maxTokens=256；effort=off
- 样本：15 条（来自 8 个会话，平均上下文 1523 估算 token）

| 指标 | 值 |
|---|---:|
| offerRatePct | 100 |
| abstainRatePct | 0 |
| invalidRatePct | 0 |
| errorCodes | {} |
| exactMatchCount | 2 |
| exactMatchOfAllPct | 13.3 |
| prefixRatioOfAllPct | 14.2 |
| exactMatchPct | 13.3 |
| avgPrefixChars | 1.267 |
| avgPrefixRatioPct | 14.2 |
| avgEditRatio | 0.189 |
| potentialSavingPct | 14.2 |
| violationCount | 0 |
| violationRatePct | 0 |
| samplesWithMasking | 5 |
| maskingHitsTotal | 10 |
| truncatedSamples | 9 |
| hardCappedSamples | 0 |
| latencyP50 | 1633 |
| latencyP95 | 2043 |
| avgInputTokens | 187 |
| avgInputTokensInclCache | 1125.667 |
| avgOutputTokens | 13.667 |
| totalInputTokens | 2805 |
| totalOutputTokens | 205 |

报告只含分数与哈希，不含对话正文；逐条结果见同名 JSON。