# O05 真实会话回放（real-v2-a）

- 提示词：`nmp-p2-v2`；模型：deepseek-official / deepseek-flash；maxTokens=256；effort=off
- 样本：15 条（来自 8 个会话，平均上下文 1523 估算 token）

| 指标 | 值 |
|---|---:|
| offerRatePct | 93.3 |
| abstainRatePct | 6.7 |
| invalidRatePct | 0 |
| errorCodes | {} |
| exactMatchCount | 1 |
| exactMatchOfAllPct | 6.7 |
| prefixRatioOfAllPct | 10 |
| exactMatchPct | 7.1 |
| avgPrefixChars | 0.929 |
| avgPrefixRatioPct | 10.7 |
| avgEditRatio | 0.175 |
| potentialSavingPct | 10.7 |
| violationCount | 0 |
| violationRatePct | 0 |
| latencyP50 | 1790 |
| latencyP95 | 2186 |
| avgInputTokens | 348.8 |
| avgInputTokensInclCache | 988.8 |
| avgOutputTokens | 14.867 |
| totalInputTokens | 5232 |
| totalOutputTokens | 223 |

报告只含分数与哈希，不含对话正文；逐条结果见同名 JSON。