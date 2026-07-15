# FLY-1099 founder-reply 摄取死掉 — 调研

Issue: FLY-1099 (https://linear.app/geoforge3d/issue/FLY-1099/fix-founder-reply-摄取discordcommdb死掉-founder-批准静默不绑-gatep1)
日期: 2026-07-09
基于: exploration.md

## 1. 调研方法

事故进行中的实时只读取证（2026-07-10 04:00-04:45 UTC，Bridge pid 8341）＋ 代码精读。
数据源：

- `~/.flywheel/comm/flywheel/comm.db`（CommDB，messages/sessions，`mode=ro`）
- `~/.flywheel/teamlead.db`（StateStore，sessions/session_events/codex_review_record/auto_qa_record）
- `/tmp/flywheel-bridge.log`（346MB，跨多个 Bridge 进程段）
- `~/.flywheel/founder-reply-cursor.json`（deliver pass 的持久 cursor）

## 2. 摄取链代码地图

| 环节 | 文件 | 关键点 |
|------|------|--------|
| pass 调度 | `packages/teamlead/src/bridge/gate-poller.ts:737-755` | 每 `founderReplyDeliverEveryNTicks` 子节奏跑一次；`try/catch` 只 `console.warn` + `maybeRecoverStore` |
| pass 本体 | `gate-poller.ts:2460` `founderReplyDeliverPass()` | per (project, lead) 读 CommDB pending questions → 按 issue thread 分组（`store.getSession` + `store.getChatThreadByIssue`）→ 逐 thread 调 deliverer |
| deliverer | `packages/teamlead/src/bridge/founder-reply-deliverer.ts:166` | Discord GET `after=cursor`（limit 50，5s timeout）→ 逐消息匹配 → 处理 → cursor 语义 PROCESSED-THROUGH（at-least-once） |
| ship 归因 | `approval-signal/founder-ship-approval-handler.ts:106` | A-2 narrow（session awaiting_review + review_question_id 一致，必须恰一个）→ **hold guard** → Tier-2 allowlist → Tier-3 Haiku 分类 → `writeGateResponseAndRunPostWrite` |
| hold guard | `auto-qa-held.ts:110` `founderApprovalHoldGuard` = `isReviewHeld` | merge_block ∨ codex gate 未过（`codex_review_record` 非 approved/skipped）∨ QA 未绿（`auto_qa_record` 非 passed）→ **拒绝一切 founder text 写入** |
| Tier-3 runner | `approval-signal/subscription-claude-classifier-runner.ts` | `execFile("claude", ["-p", prompt, "--model", haiku, "--output-format", "json"])`，20s timeout，fail-closed 返回 `{ok:false}` |
| WAKE fallback | `flywheel-comm/src/wake.ts:57` | 依赖 **CommDB** `sessions.lead_id`；无行 → `{ok:false, skippedReason:"no_session_lead"}` |
| cursor 存储 | `lead-backends/codex/InboundCursorStore.ts` | `~/.flywheel/founder-reply-cursor.json`，原子写 |
| CommDB session 清理 | `bridge/commdb-session-prune.ts` | session 终态时 `deleteSession` 删行 |
| pending 定义 | `flywheel-comm/src/db.ts:412` `getPendingQuestions` | 无 response child 且 `expires_at > now`（默认 **72h**） |

## 3. cursor / 重试语义（理解腿 C/D 的钥匙）

`emitFounderReplyDeliveryForThread`（founder-reply-deliverer.ts:242-296）逐消息扫描：

- 消息**不匹配**任何 pending question → `advanceableUpTo = msg.id`（跳过，cursor 可推进）。
- 匹配但**未过 grace** → `cursorPinned = true`，继续扫（FLY-945）。
- 匹配且成熟 → `processFounderMessage`；返回 `false`（任一动作 transient 失败）→
  **`break` 整个扫描**，cursor 停在该消息之前 → 下一轮（~60s）从这条重扫。
- **ship 消息的 WAKE-only 是该消息唯一的投递动作**：`wake.ok=false`（含
  `no_session_lead`）→ 不写 durable marker、`allOk=false` → 上面的 break。
  （FLY-605 Codex ship-gate #2 的正确决定——但它假设 wake 失败是 transient。）

推论：**任何"永久性失败"都会把该 thread 的 cursor 无限钉死**（直到 gate question 72h
expire），期间该 thread 的所有后续 founder 消息统统不被处理。反之，Tier-3 infra 失败
（`tier3_runner_failed`）被折成语义 unclear → WAKE-only（wake 多半成功）→ cursor
**照常前进** → 该消息被消费但从未获得绑定机会，**永久丢失**。两个方向都错：
永久失败被无限重试，暂时失败反而不重试。

## 4. 生产取证明细

### 4.1 腿 A — OOM 窗口（bridge log）——【时间归属修正，见 exploration §7】

```
221x [GatePoller] founder-reply deliver pass error:            ← 空消息（sql.js WASM 崩坏后）
  2x [GatePoller] founder-reply deliver pass error: memory access out of bounds
  1x [GatePoller] founder-reply deliver pass error: out of memory
[StateStore] FLY-639: in-process DB rebuild FAILED (attempt 3/3)…
[StateStore] FATAL: sql.js corruption unrecoverable … exiting for a clean restart
```

同窗口 `Error polling <lead>:`（空）× 数百、`circuit OPEN … 195 consecutive poll
failures`。恢复靠 FLY-639 的 FATAL-exit + launchd respawn。**期间只有 console.warn，
无任何 alert 通道**。

**修正（回归二分取证后）**：上述行位于 log 第 26k-40k 行 = **Jun 28-29 的旧事故段**
（346MB log 自 Jun 28 累积，wrapper 时间戳对照锚定）。**今天（Jul 9 13:09 段起）的
Bridge log 零 OOM 签名——今晚 Bridge 进程没有 OOM**。今晚 14:27 PT 的 OOM 是机器级
swap 事故（杀 runner/codex review 进程，间接造成 codex_review_record 卡 pending，喂给
腿 B）。Issue 原文把旧 OOM 行归因今晚系整文件 grep 误读。腿 A 因此定位为**历史真实发生、
且无告警覆盖的故障模式**（watchdog 修复照做），但它**不是**今晚 binding 失败的原因——
今晚的主因是腿 B（见 exploration §7 回归二分：FLY-1041 hold guard 13:09 部署 + pending
堆积）。

### 4.2 腿 B — stuck codex-hold（StateStore）

- exec `0b9caf7c`（FLY-1059）：session `awaiting_review` / role main / head `8b70b2ed` /
  `review_question_id = 8b6dcc71`（narrow 全过）→ 但 `codex_review_record` =
  **pending**（2026-07-09 23:59:03 创建，取证时 4.5h+ 未变）→
  `isCodexGateSatisfied` false → `isReviewHeld` true → `held_declined`。
- 生产 `codex_review_record`：**approved 92 / pending 73**。pending 跨数天累积
  （最早 Jul 5），OOM 杀 review 进程后 record 无人收尸是主要来源。
- FLY-863 的 `reconcileStuckCodexHolds`（auto-qa-coordinator.ts:606）3h 后确实
  postThread + lead alert（FLY-1059 的 `stuck_notified_at = 02:59:09`）——**只告警一次，
  不解卡、不重发 review、不给 founder 任何可理解的反馈**。
- 24h attribution 统计（session_events）：`held_declined` **39** / `narrow_zero` 16 /
  `narrow_multi` 15 / `tier3_unclear` 8 / `tier3_runner_failed` 3 / `response_written`
  **0**。CommDB 里最后一条成功 `{"approved": true}` = 2026-07-09 18:25:35（actor =
  Annie 的 Discord user id）。
- Annie 04:16:10 的 "ship"（msg `1524992605241475082`）→ 04:17:12 `held_declined`。
  04:25 重发（msg `1524995024335671447`）→ 04:28:10 再次 `held_declined`。她收到的唯一
  信号是 ❓ 反应（FLY-1041 Chunk 8），无解释。

### 4.3 腿 C — 僵尸 gate 队头阻塞（CommDB × StateStore 交叉）

flywheel 项目 pending `approve_to_ship` 共 17 条，最老 2026-07-07 07:35。其中 8 条的
exec 在 CommDB `sessions` **无行**（`commdb-session-prune` 已删——session 终态），但
gate question 直到 72h `expires_at` 前一直 pending：

| exec | issue | StateStore status | CommDB sessions 行 |
|------|-------|-------------------|--------------------|
| 60474e25 | FLY-977 | completed (implement) | 无 |
| 0b01ff5f | FLY-980 | completed (implement) | 无 |
| f61b8e8e | FLY-1041 | completed (implement) | 无 |
| db288c8e | FLY-1049 | awaiting_review (qa) | 无 |

→ 这些 thread 里 founder 消息匹配僵尸 gate → ship WAKE-only →
`founder_ship_reply_wake_skipped {reason:"no_session_lead"}` 每 ~90s 重复（04:25-04:33
取证窗口内四条消息各重复 4+ 次）→ `allOk=false` → **cursor 钉死**。被钉住的最老
founder 消息 snowflake = **2026-07-08 20:00:28 UTC**（32+ 小时）。同 thread 中钉住消息
之后的一切 founder 回复（含可能的批准）从未被处理——「几十条回复一条都没进库」的直接
机制。零告警。

### 4.4 腿 D — Tier-3 分类器 exec 失败

`tier3_runner_failed` reason 实录：

```
exec_failed:Command failed: claude -p You are a STRICT ship-approval classifier …
Warning: no stdin data received in 3s, proceeding without it. …
```

- 命中消息包括 Annie 04:28 的「反正你先帮我去merge了吧。…起码把 1050、1070 这条线都
  先解决了」——语义上明确的 merge 授权，因 infra 失败被折成 unclear。
- `execFile` 默认 stdio=pipe：claude CLI 看到打开的 stdin pipe 等 3 秒（stderr 警告）；
  20s 总 timeout 下高负载晚上（529 overload、swap 打满）易 fail。
- 失败路径 fail-closed 正确（绝不误批），但**处理成 cursor 前进** = 永久丢失该消息的
  绑定机会（见 §3 推论）。

### 4.5 横切 E — 告警缺失盘点

| 失败点 | 现有可见性 | 到 #flywheel-alerts? |
|--------|-----------|---------------------|
| pass 整体抛错（腿 A） | console.warn | 否 |
| per-thread deliver 错误 | console.warn + maybeRecoverStore | 否 |
| Discord GET 失败 | `founder_reply_read_failed` 审计 | 否 |
| wake `no_session_lead` 无限循环（腿 C） | `founder_ship_reply_wake_skipped` 审计 | 否 |
| cursor 长期钉死（腿 C） | 无任何记录 | 否 |
| `held_declined`（腿 B） | 审计 + ❓ 反应 | 否（FLY-863 stuck 告警是 3h 一次性，且面向 codex-hold 而非 founder 批准丢失） |
| `tier3_runner_failed`（腿 D） | 审计 | 否 |

## 5. 已有可复用基建

- **LeadAlertNotifier + #flywheel-alerts**（FLY-368/915/1048）：统一告警通道，
  `claims.db` per-eventId 去重；FLY-220 episode-latch 范式（报一次、恢复后才可再报）。
- **attribution 审计**（FLY-1041 Chunk 4）：`founder_ship_attribution` 已区分 stage，
  watchdog 可直接消费 session_events 无需新埋点。
- **founder ❓/✅ receipt**（FLY-1041 Chunk 8）：反应回执骨架可扩展为明文 thread 回复。
- **reconcileStuckCodexHolds**（FLY-863）：stuck 检测 + claim 一次性通知的骨架，缺
  "解卡"动作。
- **GatePoller patrol 子节奏**：零新 timer 的 piggyback 位（watchdog 挂这里）。
- **postThread effects**（auto-qa-coordinator）：Bridge 直接往 issue thread 发消息的
  现成通道（held 明文回复可复用）。

## 6. 修复选项评估

### 腿 C（僵尸 gate）

| 选项 | 优 | 劣 |
|------|-----|-----|
| C-1 pass 层过滤（terminal session 的 gate 不进候选集） | 无损、立即解阻塞 | 僵尸 question 仍在库里，其它消费者（pending CLI、escalation）继续看到 |
| C-2 过滤 + **自动 resolve**（写 resolved_at + 审计事件） | 账本收敛、防复发、其它消费者同步受益 | 动数据——需确认没有别的路径还会消费这些 gate（三段式 pr_handoff 不开 gate，无冲突） |

倾向 C-2（带审计），C-1 作为 resolve 失败时的兜底。

### 腿 B（stuck codex-hold）

| 选项 | 优 | 劣 |
|------|-----|-----|
| B-1 只加告警频率 | 简单 | 不解卡，founder 还是绑不上 |
| B-2 reconcile 解卡：pending 超阈值 → 标记 + 触发 re-review（复用 FLY-863 检测骨架） | 根治"卡死永远卡" | re-review 触发面（谁去跑 codex review）需要接现有 codex-review 派发路径 |
| B-3 founder 批准暂存 + hold 清绿自动补绑 | founder 不用重复说 ship | 新语义；需 TTL + head 一致性防错绑 |

B-2 必做；B-3 待 Tadashi 拍（gate Q2）。另加：held_declined 时在 thread 发明文解释
（复用 postThread），把 ❓ 从哑谜变成可理解状态。

### 腿 C/D 通用（重试语义）

有界重试 + dead-letter：per (threadId, msgId) 失败计数（StateStore 新表或复用
session_events 计数），超限 → 写 dead-letter 审计事件 + 告警 + **cursor 前进**。
`tier3_runner_failed` 改判 transient（`retrySafe` 已有对应通路：handler 返回
`{handled:[], retrySafe:false}` 即可钉 cursor）→ 进同一有界重试框架。
不变量：**任何 founder 消息要么被成功处理，要么在 dead-letter + 告警里留下痕迹**——
不存在第三种"静默消失"。

### 腿 A/E（watchdog + 告警）

- pass 级心跳：每次成功完成 pass 记 `last_success_ts`（内存 + StateStore）；连续 N 次
  抛错或超 M 分钟无成功 → alert（episode-latch）。
- cursor 钉死检测：deliverer 每轮报告 per-thread「cursor 停留的消息 id + 首见时间」，
  钉死超阈值（建议 10min）→ alert（含 thread/issue/原因 stage）。
- 复用 LeadAlertNotifier；kill-switch env（default-ON）。

## 7. 风险与兼容性

- hold guard 的**安全语义不动**：held 期间依旧绝不写 approve（FLY-1041 Chunk 5 的
  fail-closed 保留）；改的是 hold 的"卡死不解"与"不可见"。
- verify-approval / respond.ts / write-gate-response 的授权链路**零改动**。
- cursor 语义仍是 at-least-once；dead-letter 是显式放弃 + 留痕，不是 at-most-once 化。
- 自动 resolve 僵尸 gate 只针对「StateStore session 终态 ∧ CommDB session 行已删」
  的双重确认，避免误杀活 gate；resolve 写入审计事件 + 可选 kill-switch。
- 所有新告警走 claims.db 去重 + episode latch，防 FLY-218/220 式刷屏回归。
