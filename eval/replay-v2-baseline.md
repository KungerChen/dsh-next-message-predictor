# O05 真实会话回放（v2-baseline）

- 提示词：`nmp-p2-v2`；模型：deepseek-official / deepseek-flash；maxTokens=256；effort=off
- 样本：42 条（来自 15 个会话，平均上下文 831 估算 token）

| 指标 | 值 |
|---|---:|
| offerRatePct | 100 |
| abstainRatePct | 0 |
| invalidRatePct | 0 |
| errorCodes | [object Object] |
| exactMatchPct | 2.4 |
| avgPrefixChars | 0.429 |
| avgPrefixRatioPct | 4.3 |
| avgEditRatio | 0.248 |
| potentialSavingPct | 4.3 |
| violationCount | 0 |
| violationRatePct | 0 |
| latencyP50 | 1411 |
| latencyP95 | 1984 |
| avgInputTokens | 199.881 |
| avgOutputTokens | 16.929 |
| totalInputTokens | 8395 |
| totalOutputTokens | 711 |

报告只含分数与哈希，不含对话正文；逐条结果见同名 JSON。