# O05 真实会话回放（0.3.0-rerun-d）

- 提示词：`nmp-p2-v3`；模型：deepseek-official / deepseek-flash；maxTokens=256；effort=off
- 样本：15 条（来自 8 个会话，平均上下文 1523 估算 token）

| 指标 | 值 |
|---|---:|
| offerRatePct | 86.7 |
| abstainRatePct | 13.3 |
| invalidRatePct | 0 |
| errorCodes | {} |
| exactMatchCount | 1 |
| exactMatchOfAllPct | 6.7 |
| prefixRatioOfAllPct | 7.6 |
| exactMatchPct | 7.7 |
| avgPrefixChars | 1 |
| avgPrefixRatioPct | 8.8 |
| avgEditRatio | 0.165 |
| potentialSavingPct | 8.8 |
| violationCount | 0 |
| violationRatePct | 0 |
| samplesWithMasking | 0 |
| maskingHitsTotal | 0 |
| truncatedSamples | 9 |
| hardCappedSamples | 0 |
| latencyP50 | 1597 |
| latencyP95 | 1912 |
| avgInputTokens | 187.133 |
| avgInputTokensInclCache | 1125.8 |
| avgOutputTokens | 12.067 |
| totalInputTokens | 2807 |
| totalOutputTokens | 181 |

报告只含分数与哈希，不含对话正文；逐条结果见同名 JSON。