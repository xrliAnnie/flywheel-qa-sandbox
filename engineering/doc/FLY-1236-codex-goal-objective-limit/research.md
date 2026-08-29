# FLY-1236 Codex goal objective 超 4000 上限 — 调研

Issue: FLY-1236 (https://linear.app/geoforge3d/issue/FLY-1236/bug-codex-implement-段-goal-objective-超-4000-字符上限-setup-failed-秒阻塞1225)
日期: 2026-07-14
基于: exploration.md

## 1. 代码锚点(逐行核实)

| 位置 | 现状 | 相关性 |
|------|------|--------|
| `codex-daemon-adapter-helpers.ts:46-53` | `buildGoalObjective` = `systemLayer + "\n---\n" + prompt`,无长度上界 | **根因组装点** |
| `CodexTmuxAdapter.ts:344-349` | `systemLayer` 组装 → `objective = buildGoalObjective({systemLayer, prompt: ctx.prompt})` | 调用点 |
| `CodexTmuxAdapter.ts:478-512` | `runtime.runGoal({ objective, ... })` —— **未传 `kickText`** | kick 用默认 stub |
| `codex-daemon-client.ts:638-646` | `setGoal({ objective: input.objective })` —— 无长度防御 | 触限处 |
| `codex-daemon-client.ts:660` | `startTurn(threadId, input.kickText ?? "Begin working toward the goal now.")` | kick turn 通道(无 4000 限制) |
| `codex-daemon-client.ts:558-564` | `objectiveIsOurs`:用 objective 判断 goal 是否被顶替 | objective 须跨 resume 稳定 |
| `CodexTmuxAdapter.ts:442-448 / 451` | `onThreadReady`(开 founder 窗)在 setGoal **之前**触发 | founder TUI 秒死 = 同因 |

## 2. 长度数据

- `PONYTAIL_RULESET`:源文件 `packages/config/src/ponytail-ruleset.ts` ~2.1KB。
- `ctx.prompt`:Blueprint 侧 `readAgentFile` 截断上限 **40000 字符**(CLAUDE.md FLY-880 记载 `Blueprint.ts:1483`)。真实三段式 implement 的 prompt(issue 描述 + design 交接)单独就常超 4000。
- 4000 = Codex daemon `thread/goal/set` 服务端硬限,超出即 RPC error `-32600`。

结论:`systemLayer + prompt` 拼接后**几乎必然** > 4000。沙箱短句 prompt 例外 → 从不触限。

## 3. 三通道通道分工(修法依据)

- `AGENTS.md`(daemon 持久契约,无限制)—— vendor 固定层,本修不动。
- `/goal` objective(≤4000)—— 只该放稳定的 north-star,当前误放全文。
- kick turn `turn/start` input(无限制)—— 该放工作正文,当前只发 stub。

**正文该走 kick turn,north-star 走 objective。** 通道当前用反,这是本修的核心纠正。

## 4. resume 稳定性验证

`runGoalToTerminal` 每次循环(首跑 + 每次 resume)都 `setGoal(objective) + startTurn(kickText)`。因此:
- objective 必须每次一致(否则 `objectiveIsOurs` 会误判 goal 被顶替)→ 新 objective 由 `issueId`+`label`(每 execution 稳定)构造,满足。
- kickText 在 resume 时会重发正文:resume 走 `thread/resume` 保留历史,重发正文是**冗余但无害**(且 crash 后重锚 goal)。接受。

## 5. 可用于短 objective 的 ctx 字段(`AdapterExecutionContext`)

- `ctx.issueId`(如 `FLY-1225`)—— 稳定短标识。
- `ctx.label`(如 `FLY-1225-<title>`)—— 人读任务名,含标题。
- 二者组合 → north-star 指针天然 <300 字符,远低于 4000。

## 6. 影响面与回归风险

- 仅 Codex daemon 路径(`codex-tmux` backend);claude/kimi/antigravity tmux adapter 不经此代码,零影响。
- 失败路径(turn-belt reclaim / fail-closed teardown)不改动 → 相关回归测试保持绿。
- 现有单测断言 objective 含 "SYSTEM RULES"/"do the task"/ponytail —— 这些内容迁到 kickText,测试需相应更新为断言 **kickText**(而非 objective)含之。这是行为纠正带来的必要测试更新,非回归。

## 7. 测试策略(TDD)

- 纯 helper 单测:`buildGoalKickText` 折叠正文;`buildGoalObjective` 产出有界短指针含 issueId/label;`enforceObjectiveLimit` 超限降级且返回值恒 ≤4000。
- 适配器单测:大 prompt(>4000)→ `runGoalInputs[0].objective.length ≤ 4000` 且 `kickText` 含完整 prompt(FLY-1236 核心回归断言);appendSystemPrompt / ponytail 内容出现在 **kickText**。
- 现有失败路径回归测试保持不变、保持绿。
