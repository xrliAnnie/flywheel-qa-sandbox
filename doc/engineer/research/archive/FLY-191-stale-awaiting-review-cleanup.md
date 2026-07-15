# Research: Stale `awaiting_review` session 无清理路径 — FLY-191

**Issue**: FLY-191（[Bridge/Infra] Stale awaiting_review session has no reject/terminate cleanup path → falsely occupies inflight count, misleads capacity readings）
**Date**: 2026-06-02
**Source**: `packages/teamlead/src/StateStore.ts`、`packages/teamlead/src/HeartbeatService.ts`、`packages/teamlead/src/bridge/{runs-route,triage-data-route,dashboard-data,close-runner,actions,standup-service,plugin}.ts`、`packages/core/src/workflow-fsm.ts`、`packages/terminal-mcp/src/index.ts`、`packages/teamlead/lead-rules-base/founder-only-authority.md`、`packages/teamlead/src/bridge/founder-consent/reserved-endpoints.ts`、`packages/edge-worker/src/Blueprint.ts`
**Status**: Complete（审计部分）；设计选型待 Annie 对 Q1/Q2 拍板
**范围**: 先**用真实代码核对 issue 陈述**，再列出设计选项空间。不预先拍设计——auto-reap vs advisory vs manual tool 取决于 Annie 红线偏好。

---

## 0. 结论速览（TL;DR）

| Issue 陈述 | 代码核对结果 |
|---|---|
| Lead `close_runner` 拒绝 `awaiting_review` | ✅ 属实。`close-runner.ts:118` — awaiting_review 既不在 `AUTO_CLOSE_STATES` 也不在 `CRASH_PRESERVE_STATES` → `status_not_eligible`。close_runner 只清 tmux/Terminal，前提是 session **已经** terminal。 |
| `awaiting_review → terminal` 只能走 Discord review-gate ❌ reaction | ⚠️ **部分准确**。Discord reaction 是路径之一；另有 HTTP `POST /api/actions/{reject,terminate,defer,shelve}`（只要 `execution_id`，不需要 review post）。但 Lead 没有对应的 MCP 工具，且这些是 founder-only reserved action。 |
| 无 watcher 回收 awaiting_review | ✅ 属实。`getOrphanSessions`/`getStuckSessions` 只匹配 `status='running'`；`getStaleCompletedSessions` 只匹配 completed/failed/blocked。awaiting_review 对**所有** patrol 不可见。 |
| stale awaiting_review "占用 inflight count / 撑满 cap" → 假 10/10 | ❌ **不属实（强制 cap 不算 awaiting_review）**。见 §3。这是**显示层/感知层**的容量虚高，不是 enforced cap 阻塞。 |
| CoS（Simba）Bridge query-only，无 reject/terminate、无 Forum | ⚠️ 只有**一个** Bridge 进程；action 端点挂在共享 Bridge 上但被 founder-consent 中间件门控。Simba 是**规则受限**（founder-only-authority）+ 经 `/api/triage/data` 只读，而非独立的 query-only Bridge 二进制。 |

**根因修复方向（核对后判断）**：清掉"已死"的 awaiting_review（reaper / 清理原语）即可从 `getActiveSessions()` 移除它们 → 同时修好①感知容量（sessionCount/dashboard）和②同 issue 重启锁——一招到位。enforced cap 计数**不需要改**。

---

## 1. Session 状态模型 + awaiting_review 的位置

`StateStore.ts`：

- `getActiveSessions()`（L779-791）：`status IN ('running', 'awaiting_review', 'approved_to_ship')`。**所有"活跃"派生显示都来自这里**。
- FSM（`workflow-fsm.ts:120-148`）：`awaiting_review` 合法出边 = `approved_to_ship | completed | rejected | deferred | shelved | terminated`。**转换本身合法** —— 问题是**怎么触发**。
- `awaiting_review` 在 `TERMINAL_STATUSES` 集合里被当作"monotonic 终点之一"（L20-23）用于阻止 `terminal → running` 回退；但它**不是真正的 outcome**（不在 `OUTCOME_STATUSES`）。

### awaiting_review 的两种子态（reaper 必须区分）
1. **Runner 活着**：runner 阻塞在 `flywheel-comm gate approve_to_ship`（Blueprint.ts:536-559 注入的 APPROVE GATE，默认 48h 阻塞）等审批 —— **合法 pending，绝不能动**。
2. **Runner 已死**：gate 超时 fail-close / crash / 被 kill / landing 信号没回写（Blueprint.ts:550-558 注释明说："leaving the file at ready_to_merge keeps the session stuck in awaiting_review even though the PR is gone"）→ tmux 没了、last_activity 老化 → **可回收**。

**判别器 = tmux liveness**，与 GEO-270 `checkStaleCompleted` 已有套路一致（它对 completed/failed/blocked 探 tmux 活没活）。

---

## 2. 现有清理路径全景（为什么 awaiting_review 漏网）

### 2.1 Lead 工具面
`flywheel-terminal` MCP（`terminal-mcp/src/index.ts`）暴露 6 个工具：`runner_terminal_capture / list / search / status / input` + `close_runner`。
- `close_runner` 文档串明说："REJECTS: running, awaiting_review, approved, approved_to_ship — those must be approved/rejected first."（L411）
- **没有** terminate/reject/defer/shelve 的 MCP 工具。

→ Lead 把 awaiting_review 推向 terminal 的唯一手段：(a) Discord review post 上的 reaction（post 没了就没法点）；(b) 直接 curl `/api/actions/*`（founder-only reserved）。

### 2.2 Bridge action 端点（`actions.ts` + `plugin.ts:548-619`）
- `/actions/:action`（no-auth loopback）与 `/api/actions/:action`（api-token）都挂 `createActionRouter`，前置 `fcMw("action_router")` = founder-consent 中间件。
- `handleTerminate`（L727）/ `transitionSession`（reject/defer/shelve, L320）只要 `execution_id`，校验 `actionDef.fromStates.includes(session.status)`。`terminate`/`reject`/`defer`/`shelve` 的 fromStates **都含 awaiting_review** → 端点层面**能**清。
- 但：这些是 **FLY-175 reserved founder-only action**（`reserved-endpoints.ts` + `founder-only-authority.md:178-181`），enforce 模式下要 founder consent。

### 2.3 Watcher 面（`HeartbeatService.ts`）
单一定时器（5min tick，`intervalMs`）跑：`reconcileMonitorLoss → checkStuck → reapOrphans → checkStaleCompleted`。
- `reapOrphans`（L353）/ `checkStuck`（L263）：`getOrphanSessions`/`getStuckSessions` **只看 `status='running'`** → awaiting_review 永远进不了候选集。
- `checkStaleCompleted`（GEO-270, L301）：`getStaleCompletedSessions` 只看 `completed/failed/blocked` + tmux 还活 → 发 **advisory**（`session_stale_completed`，"please check if it can be closed"），**不自动终止**。**这是最接近本 issue 所需的现成范式**（throttle 6h，threshold 24h）。

→ awaiting_review 对三类 patrol 全部不可见 = "hang forever"的机制根因。

---

## 3. 容量计数核对（核心 push back）

**Enforced cap 三处都只算 `status==='running' + dispatcher inflight`，不含 awaiting_review：**
- start-gate：`runs-route.ts:142-148` — `runningInStore = activeSessions.filter(s => s.status==='running')`。
- `/active`：`runs-route.ts:495-506`。
- `/api/triage/data` `capacity`：`triage-data-route.ts:93-110`。
- `StartDispatcher.dispatch`：`run-dispatcher.ts:380` — `getInflightCount()`（内存中 dispatch 预留，promise resolve 即清，≠ awaiting_review）。

**所以 "stale awaiting_review 占 inflight / 撑满 cap" 字面不成立。** 真实成因：
- `getActiveSessions()` 含 awaiting_review → `/api/triage/data` 的 **`sessionCount`**（L104, `filteredSessions.length`）、dashboard `active` 列表（`dashboard-data.ts:78,111`）都含它。
- Peter 的 "10/10" = 7 running + 3 stale awaiting_review 被当成"active sessions"。**这是感知/显示层虚高**，不是 enforced 阻塞。实际 cap=7，另一个 issue 的 QA runner **本可启动**。
- standup（`standup-service.ts:198-200`）其实**正确分列** `Running X/max` 与 `Awaiting Review Y` —— 它不是误读源头。

**还有一处真锁**：per-issue+role 的 409 检查（`runs-route.ts:124-140`）`["running","awaiting_review"].includes(s.status)` → stale awaiting_review 会**挡住同一 issue+role 的重启**（GEO-360/362/351/375 本身被锁），但不是全局容量。

**推论**：suggestion (3) "fix capacity counting" 对 enforced cap 基本是 no-op。reaper/清理一旦把死 session 终结，它们退出 `getActiveSessions()` → sessionCount/dashboard/per-issue 锁**全部自动恢复**。

---

## 4. FLY-175 founder-only-authority 交互（最大设计风险）

- `terminate/reject/defer/shelve` + `close-runner` 是 reserved founder-only action，前置 `fcMw` HTTP 中间件（`reserved-endpoints.ts`）。
- **in-process reaper**（在 HeartbeatService 里调 `applyTransition()`）**绕开 HTTP 中间件** —— 与 `reapOrphans` 现在对 running orphan 强制 `→failed` 的做法**完全一致**（L389-412），属已被接受的 system GC。
- 但：自动 terminate 一个 session = "关 runner"邻近动作 = Annie 反复强调的红线（memory: `feedback_never_shutdown_without_permission`）。即便 runner 进程早死，**"强制 terminate 这个动作本身"**是否越线，需要 Annie 拍。
- 非对称性观察：running orphan 会被自动 `→failed`，awaiting_review orphan 却不会 —— 这个不对称**本身就是 bug**。但 awaiting_review 语义="活干完了，等人审"，强终止=丢弃未审的成果，比终结 hung 的 running 风险更高。故保守默认（advisory + 人工确认）更稳。

---

## 5. 设计选项空间（不预选，待 Annie 拍 Q1）

| 选项 | 做法 | 优点 | 风险 |
|---|---|---|---|
| **A. 全自动 reaper** | HeartbeatService 探到 tmux 死 + 老化 → `applyTransition(→terminated)` | 与 reapOrphans 一致；零人工 | 丢弃未审成果；越 FLY-175 红线之嫌 |
| **B. Advisory-only**（GEO-270 式） | 探到 stale awaiting_review（无 live runner）→ ping owning Lead "要清吗" | 对齐 founder-only-authority；人有最终决定权 | 仍需人动手；若人不在则继续 hang |
| **C. 清理原语** | 给 Lead/CoS 一个 `reject_stale`/`force_terminate` 工具/端点（带审计，仅限无 live runner）| 直接补上"没 post 可点"的缺口 | 多一个 reserved-action 面，需 founder-consent 门控 |

**Worker 推荐：B + C**。advisory 探测 + 一个 Lead/CoS 可调的**审计型**清理原语（仅当无 live runner）；全自动 A 默认 OFF（可加 flag）等 Annie。理由：守红线、补真缺口、人保留最终拍板。

### 落地位置（任一选项通用）
- 新增 `StateStore.getStaleAwaitingReviewSessions(thresholdHours)`（仿 `getStaleCompletedSessions`，`status='awaiting_review' AND last_activity_at < now-Nh`）。
- HeartbeatService 新增一 pass（复用同一 5min 定时器；像 checkStaleCompleted 一样自带节流），**不引入新周期定时器**（守 FLY-169/172 norm）。
- 探 tmux liveness 复用 `isTmuxWindowAlive`/`getTmuxTargetFromCommDb`。
- 审计走 StateStore event log（仿 `lead_close_runner`），与现有一致。

---

## 6. 待 Annie 拍板的开放问题（已上报 team-lead）

- **Q1**: auto-reap(A) vs advisory(B) vs manual tool(C)？（worker 推 B+C）
- **Q2**: staleness 阈值。tmux-dead 作硬门 + 年龄作次级 guard。awaiting_review 容许 sit 多久算 stale？（现 staleThresholdHours=24h，但 review 可能合理压一个周末 → 倾向 2–3 天）
- **Q3**（多半 out of scope）: live（runner 活着）的 awaiting_review 该不该计入 cap？现在不计 → 可能 10 running + N parked = >10 live runner。本 issue 只管 *stale*，建议不动 cap 语义。
- **Q4**: 审计落 StateStore event log vs founder_consent_audit corpus？（推 event log）

---

## 7. 生产数据库实证（2026-06-02 查 `~/.flywheel/teamlead.db`，只读）

查询当时共 **10 个** awaiting_review session。按"最后活动距今"排序（NOW=06-02 23:50 UTC）：

| issue | act 老化 | 心跳老化 | PR | 真实身份 | 死/活 |
|---|---|---|---|---|---|
| GEO-360 | ~1199h(7周) | 1199h | #186 | `[Dummy] FLY-102 测试` cmux 轮询验证 | **死** |
| GEO-362 | ~1197h(7周) | 1197h | #188 | `[Dummy] FLY-102 Re-test` | **死** |
| GEO-351 | ~622h(26天) | 641h | #207 | `[Ops] 定价方案`（533 行文档，被搁置）| **死** |
| GEO-375 | ~47h(2天) | 47h | #225 | `Frontend 字体接线`（gate 超时）| **死** |
| GEO-388 | ~23h | 23h | #232 | `[Backend] 字体校验 E2E` | 待定（可能仍在 48h 审窗内）|
| GEO-390 | ~21h | 21h | #233 | `[Frontend] Skyline zoom` | 待定 |
| GEO-394 | ~20h | 20h | #239 | `[QA] Skyline zoom 复验` | 待定 |
| GEO-389 | ~18h | 21h | #235 | `[Frontend] 字体校验 UI` | 待定 |
| GEO-400 | ~19h | **7.7h** | (无) | `[QA] 字符拦截 E2E 复验` | **活**（心跳明显更新）|
| GEO-401 | ~16h | **7.7h** | (无) | `[Backend] 修 prod 网关` | **活** |

### 关键事件铁证（`session_events`）
- **GEO-360**：`session_started→…→stage_changed(completed)→session_completed(00:49)→tmux_closed(00:51, runner 进程死)→lead_close_runner_blocked(07:46)`。Lead **真的试过关**，被 `status_not_eligible` 挡回。
- **GEO-375**：`…→stage_changed(approve)→session_completed(06-01 01:06)→gate_timed_out{checkpoint:approve_to_ship}(06-02 01:05)→lead_close_runner_blocked(06-02 16:24)`。**approve 闸门等满 48h 超时（FLY-159 fail-close）→ runner 退出**，session 仍停 awaiting_review；Lead 试关被挡。

### 由实证得出的设计要点
1. **判别器 = runner 真死没死**（tmux 没了 / 心跳停很久），不是单纯年龄。死的 4 个心跳停 2 天~7 周；活的（GEO-400/401）心跳还在更新。
2. **24h 单一阈值会误杀**：正常审窗就是 48h，18–23h 的几个（GEO-388/390/394/389）很可能还在合理等审。→ 阈值必须以"runner 已死"为硬门，年龄作次级保险。
3. **stale 分两类来源**：(A) approve 闸门 48h 超时致 runner 退出（GEO-375 实锤）；(B) 测试假任务无人审（GEO-360/362）或真活被搁置（GEO-351/375）。
4. **`lead_close_runner_blocked` 已是高频事件**（全库 13 次）——说明 Lead 反复撞到"想清却被拒"这堵墙，不是个例。

## 8. ⚠️ Annie 重新定性 — 真问题是"等审时 Bridge 够不到 runner"（2026-06-02 第二轮）

Annie push back：4 个死 orphan 是对的，但她真正在意的是 **live runner**——"为什么 runner 进 `awaiting_review` 后，Lead 就不能再经 Bridge 跟它说话、只能直接 tmux？是不是我们设计了个怪机制？" 顺代码挖到底，机制如下（**已成为本 issue 的核心发现**）：

### 8.1 冻结机制（code-confirmed）
1. runner 到"等审批"时运行 `flywheel-comm gate approve_to_ship`（`commands/gate.ts`）——一条**前台 Bash 调用，阻塞最多 48h**，每 15s 轮询 CommDB 看"我这条 gate 问题有没有 response"（`getResponse(questionId)`，只认自己那条）。
2. `TmuxAdapter.ts:344` 把 runner 的 Bash 工具超时从默认 10min 提到 **49h**（`BASH_MAX_TIMEOUT_MS=176400000`），就是为让这个冻结撑满 48h。
3. **冻结期间 Claude Code agent loop 卡死在这条 tool 里**。runner 收消息的两条路**都只在"动作之间/空闲时"触发**：
   - `~/.flywheel/hooks/inbox-check.sh` = **PostToolUse hook**（只在一个 tool 完成后才跑）。
   - stock `useInboxPoller` = Claude Code 内置**空闲**轮询。
   - → 长阻塞前台 tool 期间两个都不触发 → Bridge/mailbox 消息堆着没人读。
4. **只有两条能穿透**：(a) `flywheel-comm respond` 到 gate 的 questionId（gate 轮询看到→解冻；approve/reject 走这条，**Bridge 路是通的、设计内**）；(b) tmux send-keys 打断被冻 CLI（Annie 看到的"只能 tmux"后门）。

### 8.2 FLY-168 没覆盖这个场景
`send.ts:20` 自己的注释："wakes an **idle** Runner"。FLY-168 的 mailbox dual-write 只对**空闲（动作之间）**的 runner 有效；对**卡在 gate 里**的活 runner **不生效**，缺口仍在。

### 8.3 与 FLY-195 同根
通用不变式：**Claude Code 只在"动作之间/空闲时"收消息；任何长阻塞前台 tool（gate 这种故意等待 OR FLY-195 那种意外卡死）都让 runner 在 Bridge 上失联，只剩 tmux 后门。** FLY-191=故意冻结，FLY-195=意外卡死。两者应共用同一个"卡住时仍能从 Bridge 够到 runner"的原语。

### 8.4 FLY-191 实为两个问题
- **问题一（死 runner）**：§7 的 4 个 orphan，runner 已死、session 卡 awaiting_review 无人能清 = 清扫小事。
- **问题二（活 runner）**：runner 活着但被 gate 冻住，Lead 经 Bridge 只能发审批结果 = Annie 真正在意的，FLY-195 同根。是否算 bug 取决于产品意图（见下）。

### 8.5 待 Annie 拍的产品意图（已上报）
等审时 Lead 期望对活 runner 做到什么程度？
1. 只 approve/reject 够（现状已满足→只补"清死 orphan"+ 把限制讲清楚）；
2. 想随时发普通指令/追问（→ 做"打断 gate / Bridge 够到被冻 runner"，与 FLY-195 合并）；
3. 居中：等审想聊时用一个统一 Bridge 命令（底层走 tmux 打断），不用手动开 tmux。

## 9. Annie 本意澄清 → 设计方向翻转（2026-06-02 第三轮）

Annie："我当时的想法就是 awaiting_review，我只是希望它在等 review 时不要自己把自己关了，就这样。有必要把它冻住吗？" → **本意只有"别自退"，从没要求"冻住"。阻塞 gate 是过度实现。**

### 9.1 决定性事实
- **runner 跑交互式 Claude Code（`TmuxAdapter.ts:212` "NO --print"）→ 干完一轮天然停在提示符待命、进程不退。** 所以"保活"是交互模式免费给的，**不需要阻塞 gate**。阻塞 gate 的真正作用是：①硬卡住（防未批先 ship）；②自带 48h 超时。它顺带把 runner 冻成"活着但聋了"。
- 拆掉阻塞 gate **不削弱 ship 安全**：FLY-175 的 Bridge ship 闸门已在服务端兜底（无 founder consent 根本 ship 不出去）。硬卡住这层是冗余的。

### 9.2 三选项（取舍）
- **(a) 闲着但能听（推荐）**：runner 发"请审"后正常结束这轮、停提示符待命；approve/reject/任意指令都走普通 Bridge 消息，闲置 runner 被 FLY-168 唤醒处理。48h 超时搬 Bridge 侧（GatePoller/HeartbeatService 已有）。"没批准就一直闲着不 ship = 不动即安全"。**坑（需 spike）**：① FLY-168 闲置唤醒可靠性是命脉；② RunnerIdleWatchdog 要把"等审时闲着"当正常、别误报；③ 确保 agent 发完请审真停手（FLY-175 兜底）。
- **(b) 非阻塞等待**：gate 发完问题即返回、不冻，runner 闲等唤醒 = (a) 的另一写法。
- **(c) 现状阻塞 gate**：活着但聋，只 tmux 后门。Annie 已否。

### 9.3 与 FLY-123（Codex runner）对齐 —— 关键
- FLY-123 已定 Codex 形态 = **Option A 进程边界=gate**：Codex 到等待点**进程退出**，回复后 `codex exec resume` 续跑。看似与"保活"矛盾，本质一致：**work 不丢、可续跑**。
- 统一概念：**"等审" = 一个"可续跑的暂停点"，不要求冻住的活进程。** Claude Code 实现=闲着待命；Codex 实现=退出但会话可 resume。两边在"你能发消息、runner 能续"层面都是"活着且能聊"。
- **现阻塞 gate 对未来 Codex runner 行不通**（FLY-123 记：长驻冻结丢掉 Codex 多账号容错）→ **FLY-191 从"冻结"改"可续跑暂停"正好对齐 FLY-123 已定方向**，一举两得。
- 待确认：Codex"活着"=会话可续跑（进程会退），沿用 FLY-123 决定。

### 9.4 待 Annie 拍（已上报）
1. 走 (a) 闲着但能听 + 48h 超时改 Bridge 管？
2. Codex"活着=会话可续跑（进程会退）"沿用 FLY-123？
3. "等审闲着"要不要配轻量保活动作，还是纯靠交互模式天然不退？

## 9.5 Annie 最终拍板（2026-06-02 第四轮）+ 设计落点机制核对

**Annie 确认**："awaiting_review 前 runner 是个能正常聊的 Claude session，就保持那个状态。为什么过了 awaiting_review 就要变成另一个状态？" → **awaiting_review 必须不改变 runner 行为**，纯 Bridge 侧**状态标签**（= "开了 PR、等审批 ship"），不是行为态、不是冻结。审批/打回/任何消息都作为**普通消息**发给 idle runner（与 awaiting_review 之前同一条路）。这是 path (a) 最简形态：不切行为、只加标签。

**为何敢去掉冻结**：阻塞 gate 的活是"硬卡住、没批准不准 ship"，但 **FLY-175 服务端 ship 闸门已在服务端兜底**，冻结冗余。去掉不削弱"没批准不 ship"。

### 落点机制核对（写 plan 的依据）
1. **Label 设置 = 事件驱动，非冻结驱动**：Bridge 在 `session_completed`（`route="needs_review"` 且 `landingStatus != merged`）时设 `awaiting_review`（`event-route.ts:595-608`）。→ runner 可**非阻塞**地 emit 此事件设标签，然后 idle，不需要 block。
2. **审批送达唤醒缺口（必须补）**：`respond.ts` 只写 CommDB response（`insertResponse`），**不唤醒 idle runner** —— 现在靠阻塞 gate 的轮询循环 `getResponse(questionId)` 看到。新设计 idle runner 不轮询 → 审批送达**必须同时 mailbox dual-write 唤醒**（复用 `send.ts`/FLY-168 的 `deriveRunnerMailboxIdentity`+`transport.write`）。Bridge `runner-gate-response` endpoint 是补这一步的落点。
3. **RunnerIdleWatchdog 只看 `status==='running'`**（`RunnerIdleWatchdog.ts:80`）→ **不会**对 awaiting_review-idle runner 误报。真正要协调的是 **fly-195 的新 stall 检测**（需加 status-guard：awaiting_review 不自动 nudge）。
4. **48h 超时**：现由 gate CLI 自持（倒计时→`gate_timed_out`→exit）。新设计搬 Bridge 侧（GatePoller 持 deadline / HeartbeatService stale 检测）。idle runner 的"超时"= 一直闲着不 ship = 不动即安全；到点 Bridge 提醒 Annie。
5. **Runner 交互式不退**（`TmuxAdapter.ts:212` NO --print）→ 干完一轮天然 idle 待命，保活免费。

## 10. 协调

- **FLY-195**（worker-fly-195）：共享根因（§8.3）。已同步对齐"卡住时从 Bridge 够到 runner"的原语。
- **FLY-123**（Codex runtime）：§9.3 —— FLY-191 的"可续跑暂停"抽象须与 FLY-123 的 exit+resume 模型统一。
- **worker-fly-193**：在处理紧急 spam-kill，回来后同步。
- 改 HeartbeatService / capacity / gate / wake / IdleWatchdog 等共享代码前先协调，避免冲突。
