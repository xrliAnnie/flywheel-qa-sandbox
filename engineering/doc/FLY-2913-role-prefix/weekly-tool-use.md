# FLY-2913 七天工具调用刷新 — 调研
Issue: FLY-2913 (https://linear.app/geoforge3d/issue/FLY-2913)
日期: 2026-09-25
基于: research.md

只读 Claude 转写；没有打开活 DB。固定窗口为 `2026-09-19T05:18:04.661Z`（含）至 `2026-09-26T05:18:04.661Z`（不含）。角色只由转写中的 phase 系统协议或跨家族评审首段合同判定；不从目录名或普通任务内容猜角色。七天使用情况是背景证据，零调用不代表可删。

| 角色 | 输入转写 | 调用次数 | 工具种类 |
|---|---:|---:|---:|
| design | 31 | 3,733 | 11 |
| implement | 75 | 15,050 | 17 |
| qa | 130 | 20,721 | 17 |
| review-design | 33 | 2,202 | 6 |
| review-code | 146 | 12,494 | 12 |
| unattributed | 1492 | 40,349 | 66 |

共 1,907 份输入，94,549 次去重调用；40,349 次无法归属。1 次重复调用被排除，4,605 次在时间窗外，517 份无窗口内调用；缺失/不可读/损坏记录均为 0。174 份子代理转写均无法安全关联到已识别角色，保持未归属；未将它们并入主会话。Codex 历史不在此输入集。

## 每角色实际调用清单

### design

| 工具 | 调用次数 |
|---|---:|
| `Agent` | 34 |
| `Bash` | 3,082 |
| `Edit` | 226 |
| `Monitor` | 17 |
| `Read` | 134 |
| `SendMessage` | 1 |
| `Skill` | 40 |
| `TaskStop` | 2 |
| `ToolSearch` | 10 |
| `Write` | 185 |
| `mcp__plugin_playwright_playwright__browser_navigate` | 2 |

Skill 名称：`codex-design-review` × 26；`onboarding` × 14

### implement

| 工具 | 调用次数 |
|---|---:|
| `Agent` | 31 |
| `Bash` | 13,779 |
| `Edit` | 404 |
| `ListAgents` | 12 |
| `Monitor` | 101 |
| `Read` | 130 |
| `ScheduleWakeup` | 13 |
| `SendMessage` | 5 |
| `Skill` | 107 |
| `TaskStop` | 22 |
| `ToolSearch` | 53 |
| `WebFetch` | 1 |
| `Write` | 387 |
| `mcp__plugin_context7_context7__query-docs` | 2 |
| `mcp__plugin_context7_context7__resolve-library-id` | 1 |
| `mcp__plugin_playwright_playwright__browser_navigate` | 1 |
| `mcp__plugin_playwright_playwright__browser_resize` | 1 |

Skill 名称：`claude-api` × 1；`codex-code-review` × 18；`codex-design-review` × 10；`codex:codex-cli-runtime` × 1；`codex:rescue` × 36；`flywheel-context` × 2；`flywheel-tdd` × 1；`implement` × 1；`linear-issue-context` × 5；`onboarding` × 31；`superpowers:systematic-debugging` × 1

### qa

| 工具 | 调用次数 |
|---|---:|
| `Bash` | 19,838 |
| `Edit` | 10 |
| `Monitor` | 114 |
| `Read` | 247 |
| `Skill` | 91 |
| `TaskStop` | 50 |
| `ToolSearch` | 73 |
| `Write` | 183 |
| `mcp__claude-in-chrome__browser_batch` | 6 |
| `mcp__claude-in-chrome__computer` | 46 |
| `mcp__claude-in-chrome__javascript_tool` | 5 |
| `mcp__claude-in-chrome__list_connected_browsers` | 10 |
| `mcp__claude-in-chrome__navigate` | 24 |
| `mcp__claude-in-chrome__resize_window` | 3 |
| `mcp__claude-in-chrome__tabs_close_mcp` | 12 |
| `mcp__claude-in-chrome__tabs_context_mcp` | 6 |
| `mcp__plugin_playwright_playwright__browser_navigate` | 3 |

Skill 名称：`claude-api` × 1；`linear-issue-context` × 2；`onboarding` × 88

### review-design

| 工具 | 调用次数 |
|---|---:|
| `Bash` | 2,180 |
| `Read` | 13 |
| `ToolSearch` | 1 |
| `Write` | 4 |
| `mcp__plugin_context7_context7__query-docs` | 3 |
| `mcp__plugin_context7_context7__resolve-library-id` | 1 |

Skill 名称：此角色在窗口内未观测到 Skill 调用。

### review-code

| 工具 | 调用次数 |
|---|---:|
| `Agent` | 25 |
| `Bash` | 12,332 |
| `ListAgents` | 24 |
| `Monitor` | 18 |
| `Read` | 25 |
| `Skill` | 1 |
| `TaskStop` | 2 |
| `ToolSearch` | 17 |
| `WebFetch` | 2 |
| `Write` | 41 |
| `mcp__plugin_context7_context7__query-docs` | 6 |
| `mcp__plugin_context7_context7__resolve-library-id` | 1 |

Skill 名称：`claude-api` × 1

## 可复查边界

完整聚合见 `evidence/weekly-tool-use.json`；显式文件/会话清单见 `weekly-transcript-manifest.json`；角色判定依据和未知条目见 `weekly-discovery.json`；来源与 SHA256 见 `weekly-provenance.json`。未存 prompt、工具参数、结果正文或 credential。

转写读取不是文件系统快照。固定了成员和 cutoff，但源文件后来被编辑会让重跑结果变化；不把本统计冒称 provider 精确计费或不可变转写快照。发现脚本只用于这次背景刷新，与显式 manifest collector 分开。
