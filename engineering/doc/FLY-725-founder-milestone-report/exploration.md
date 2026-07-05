# FLY-725 Lead 不主动报告 runner 里程碑 — 探索

Issue: FLY-725 (https://linear.app/geoforge3d/issue/FLY-725/founder-ux-lead-不主动报告-runner-完成-状态只在频道名没-push-报告founder-被迫-pull)
日期: 2026-06-30
基于: 无

---

## 1. Problem（Annie 的原话痛点）

> "runner 做完事情了、Lead 也不告诉我、我还要亲自去问到底发生什么。**每个项目都有这问题**、看门狗为什么一点用都没有？"

精确诊断（LEARN-149 截图）：runner 走完全流程（规划→设计审→实现→代码审→待批→✅完成），
但**状态只体现在频道/线程名上**（被动、founder 得自己盯），**没有一条 Lead 主动发的"完成 + 结果"报告**。
Lead ack 了 runner，却漏了"报告给 founder"那一步 → Annie 只能 pull（"what is the status?"）。

**founder 是 pull 模型、本该 push。** 这是 fleet-wide 的系统行为问题（不是单项目）。

---

## 2. 现状审计（codebase）

### 2.1 现有的 Lead"报告"行为 = 纯 discipline（不可靠）

- `runner-patrol-rules.md` RC-1 **已经**规定 Lead 必须把**每一个** runner 生命周期事件
  （`session_completed` / `session_failed` / `runner_stuck_escalation` / `runner_question` / parked-awaiting-lead）
  relay 到 `[FLY-XX]` chat thread（`POST /api/chat-threads/send`）。"relay 是默认、沉默是 bug"。
- 但这是 **prompt 里的纪律**，不是机制保证。FLY-725 的事故正是 Lead **漏了这一步**。
- `runner-patrol-rules.md` 开头明确写着历史决定：
  > "Bridge does **not** auto-post Runner status to the founder's Discord (**FLY-163, by design**).
  >  You (the Lead) are the **only** channel..."

  **FLY-725 正是要修订这个 FLY-163 立场** —— issue 原文："修它 = flywheel-repo 改动（Lead 行为 + 通知机制）… fleet-wide"。

### 2.2 现有的 **Bridge 侧 founder-push** —— 只覆盖 GATE，不覆盖里程碑

Bridge 侧唯一会主动 push 给 founder 的机制在 `GatePoller`（`packages/teamlead/src/bridge/gate-poller.ts`）
的 poll 循环里，按 project→lead 迭代 pending 问题，piggyback 两条 watchdog：

| 机制 | 触发条件 | 覆盖 | 文件 |
|---|---|---|---|
| **FLY-605 founder-thread fallback**（`maybeEmitFounderThreadFallback`） | 一个 **founder-facing gate**（`brainstorm` / `approve_to_ship`）pending 超过 grace（默认 10min）没人答 = "Lead 漏了" | 只 **gate**（brainstorm / 待批），**不含完成/失败** | gate-poller.ts:1207 + `founder-thread-notifier.ts` |
| **FLY-637-ext lead-pending 升级**（`maybeEmitLeadPendingNudge`） | 一个 **lead-facing `question` gate** Lead 坐着不答 → 指数退避 nudge Lead，N 轮后 page Annie 一次 | 只 **question gate** | gate-poller.ts:982 + `lead-pending-escalation.ts` |
| **FLY-579 auto-QA**（`notified_at` on `auto_qa_record`） | QA 通过后"ship-ready"通知 founder（approve gate 在 QA 绿之前 hold） | 只 **QA-pass → 待批** | `auto-qa-*.ts` + StateStore.ts:2287 |

**关键缺口**：runner **到达终态里程碑**（`session_completed` / merged / blocked / failed）时，
**没有任何 Bridge 侧的 founder-push**。GatePoller 只看 **pending 问题**，不看**已完成/失败的 session**。
所以一个 runner 干完活（无 pending gate）→ founder 永远收不到 Bridge 主动报告，
只有频道/线程名变化（FLY-560 status prefix，若启用）。

> 注意：`approve_to_ship`（待批）里程碑其实**部分**被 FLY-605 覆盖（10min fallback），
> 但**完成 / 失败 / 阻塞**这三个终态**完全没有**。事故里的 "✅完成（8:43PM）" 正落在这个缺口。

### 2.3 可复用的 primitives（已存在，不用从零造）

- `StateStore.getStaleCompletedSessions(thresholdHours)`（StateStore.ts:2068）——
  `SELECT * FROM sessions WHERE status IN ('completed','failed','blocked') AND last_activity_at < …`，
  正好枚举终态 session。
- `emitFounderThreadNotification(opts, deps)`（`founder-thread-notifier.ts`）——
  往 issue thread POST 一条结构化消息 + `@founder`，已处理 429/5xx/4xx 分类、allowed_mentions 只放 founder。
  当前 `checkpoint` 类型只有 `"brainstorm" | "approve_to_ship"`，需扩展加里程碑类型。
- `GatePoller.poll()` 的 per-project/per-lead 循环 + piggyback 模式（零新 timer）——
  里程碑巡检的天然落点，和 FLY-605 / FLY-637-ext 同构。
- `StateStore.insertEvent` / `getEventsByExecution` —— 幂等 dedup marker（FLY-605 用
  `founder-thread-notify-<qid>` event 做 restart-safe 去重）。
- `StateStore.getChatThreadByIssue(issueId, channel)` —— 解析 issue 的 chat thread。
- Session 有 `completed_at` / `last_activity_at` 时间戳，`session_params` 里带 PR/route 信息（待 research 确认字段）。

### 2.4 Session 终态路由（DecisionLayer / event-route，已核对）

`session_completed`（event-route.ts:774）按 route 落地：`needs_review`→`awaiting_review`、`merged`→`completed`、
`blocked`→`blocked`（**无任何 founder 动作**）、`no_code`/`pr_handoff`→`completed`、`auto_approve`→`awaiting_review`。
`session_failed`（event-route.ts:1338）只写 FSM `failed` + `last_error`，无 founder emission。
`DecisionLayer`（edge-worker）**纯路由**、零 Discord/founder 副作用。

**唯一的"通知"= event-route.ts:1889-1940 的 always-deliver block**：`appendLeadEvent` + `runtime.deliver`
把事件送进 **Lead 的 CommDB inbox**（不是 founder）。thread 改名（`stampStageEmojiForSession`,event-route.ts:1469
→ `ChatThreadCreator`）**只 PATCH channel name，不 POST 消息、不 ping 任何人**，和通知完全解耦。
（blocked 的 🔴 v1 根本不 stamp → 阻塞的 runner 连标题都不变。）

### 2.5 **两个更尖锐的根因（Explore 核实）** —— "被迫 pull" 有两层

1. **完成/失败/阻塞里程碑：Bridge 侧零 founder-directed post**（只进 Lead inbox + 改标题）。
2. **即使发了 post 也不 ping**：Lead 自己 relay 走 `POST /api/chat-threads/send` →
   `postDiscordMessageToChannel`，**硬编码 `allowed_mentions:{parse:[]}`**（discord-utils.ts:104）→
   passive thread 消息、**Annie 手机不会响**。auto-QA 的 "✅ …可以 ship 了"（`notifyShipReady`,
   auto-qa-effects.ts:207）**同样是 passive、无 ping**。全系统唯一真正 `@founder` ping 的只有
   **FLY-605 fallback**（仅 gate、仅 10min Lead 沉默后）。

**含义**：就算把 Lead discipline 修可靠，Annie 依然收不到"push"（因为 Lead relay 本身不 ping）。
→ FLY-725 的机制修复本质是 **"里程碑 → 一条真正 `@founder`-ping 的 push"**，
`emitFounderThreadNotification`（带 `@founder`）正是唯一合适的 primitive。这把推荐从"修 Lead 纪律"
推向 **Bridge 侧机制保证的 ping**。

---

## 3. 设计方向（最小、跟随先例、fleet-wide、byte-compat）

**核心思路**：把 FLY-605 的"检测→通知"从 **gate** 扩到 **终态里程碑** ——
在 GatePoller 里加一条 piggyback 巡检：检测"到达终态里程碑但 founder 没被通知"的 session，
Bridge 自己往 issue thread POST 一条简短的"完成/失败 + 结果"报告 + `@founder`。
这正是 issue 要求的"扩 FLY-720 的 detect→act 到 notification / 接上检测→通知"。

复用 `emitFounderThreadNotification`（扩 checkpoint 类型）+ `getStaleCompletedSessions` + event-marker 去重。
默认关（`FLYWHEEL_*=0` byte-compat）+ 按 project 走 `doc_flow`/`qa` 同款 opt-in，flywheel 自身 default-enable。

### 需要 Annie 拍板的 UX 决策（founder-facing UX → FLY-598 brainstorm gate）

1. **推送去向**：
   - **(A1, 推荐)** 该 issue 的 `[FLY-XX]` chat thread + `@founder`（跟现有 per-issue thread 模型一致，复用 FLY-605 基建）。
   - (A2) 一个总 status 频道（聚合视图）。
   - (A3) DM。
2. **Lead-first 还是 Bridge-primary**（因 §2.5 "Lead relay 不 ping"，这题变关键）：
   - **(B2, 推荐) Bridge-primary ping**：里程碑一到（或极短 grace 后），Bridge **必发一条 `@founder`-ping 的
     简短里程碑报告**。这是唯一能保证 Annie 收到 push 的做法（Lead 就算 relay 也不 ping）。Lead 仍可在同 thread
     补更丰富的 context，但 founder 的"保证 ping"由 Bridge 兜。最贴合 Annie "push not pull / 看门狗要有用"。
   - (B1) Lead-first + Bridge fallback：给 Lead 短 grace 先发，Lead 漏了才 Bridge 发。**但 Lead relay 不 ping**
     → 勤快 Lead 的场景 Annie 反而收不到 ping（除非再让 Lead relay 也 ping，改动更大）。
   - (B3) 攒 digest —— 被 FLY-715 否掉（要让完成逐个冒出来）。
3. **覆盖哪些里程碑**：完成（done / PR opened / pr_handoff / merged）、失败/阻塞、**ship-ready（QA 过→待批，
   现在是 passive 无 ping）**。approve-gate 的"待批"已被 FLY-605 覆盖 → 避免重复。
   auto-QA 交互：QA 在跑/失败时 founder 不被打扰（现状保留），QA 过才发 ship-ready ping。
4. **详细度**：一行状态 + 结果（PR 链接 / route / 短 summary）+ `@founder`，保持简短（Annie 忙）。
5. **噪音控制**：fleet-wide 每个 runner 完成都 ping 可能很吵 → 可配置哪些里程碑 ping（失败/ship-ready 一定 ping；
   纯 completed 视项目/label 可调），default-off env + 按 project opt-in（同 `qa`/`doc_flow`）。

**推荐组合**：**A1（issue thread + `@founder` ping）+ B2（Bridge-primary，机制保证一条 ping）+
覆盖 完成/失败/阻塞/ship-ready（approve-gate 待批交给 FLY-605）**，复用 `emitFounderThreadNotification` +
`getStaleCompletedSessions` + GatePoller piggyback + event-marker 去重，default-off byte-compat。
理由：直接落地 issue 的"detect→notify、扩 FLY-720"，是唯一能真正给 Annie "push" 的做法（passive 无 ping 治不了她的痛）。
