# O05 真实会话回放（v3）

- 提示词：`nmp-p2-v3`；模型：deepseek-official / deepseek-flash；maxTokens=96；effort=off
- 样本：42 条（来自 15 个会话，平均上下文 1012 估算 token）

| 指标 | 值 |
|---|---:|
| offerRatePct | 78.6 |
| abstainRatePct | 21.4 |
| invalidRatePct | 0 |
| errorCodes | [object Object] |
| exactMatchPct | 9.1 |
| avgPrefixChars | 1.273 |
| avgPrefixRatioPct | 13.6 |
| avgEditRatio | 0.291 |
| potentialSavingPct | 13.6 |
| violationCount | 0 |
| violationRatePct | 0 |
| latencyP50 | 1476 |
| latencyP95 | 2070 |
| avgInputTokens | 360.238 |
| avgOutputTokens | 10.929 |
| totalInputTokens | 15130 |
| totalOutputTokens | 459 |

报告只含分数与哈希，不含对话正文；逐条结果见同名 JSON。