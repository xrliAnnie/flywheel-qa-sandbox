# QA Report: FLY-692 — combined QA of FLY-637 watchdog v2 / lead-pending escalation

**Issue**: FLY-692 (QA · FLY-637 — watchdog v2 / lead-pending escalation combined)
**Verifies**: PR #386 (FLY-637) — base direction-A (report-once) + ext (lead-pending escalation)
**Verified head**: `1dd0ff85` (含 origin/main merge → FLY-663 sql.js→better-sqlite3 迁移的冲突解析；**非**旧 head `8099a8b2`)
**Date**: 2026-06-29
**Method**: 隔离 worktree、mock/快进 timer（真实 20min–2h timer 不实跑、不重启生产 Bridge）
**Verdict**: ✅ **PASS**

---

## Scope & Method

独立 combined QA，验 PR #386 两层一起：

1. **base（direction-A，report-once）**：quiet classifier 的 FLY-324 done-but-running skip、normalized-fingerprint idle dedup、persistent `quiet_wake_notified` 表、kill-switch `FLYWHEEL_QUIET_PERSIST_DEDUP=0`。
2. **ext（lead-pending escalation）**：runner 卡在**阻塞 question gate** + Lead 没答 → 指数退避催 Lead（起点 20min、×2、封顶 2h）→ 催满 3 轮（`PAGE_ANNIE_ROUNDS=3`）还没答 → 兜底页 Annie 一次（`=0` 永不页）。

验证三路交叉（不只重跑实现者的测试）：
- **A** 复核实现者 26 ext 测 + base direction-A 测（隔离跑）。
- **B** 我自建两个独立 mock-clock / better-sqlite3 driver（FSM + StateStore durability）。
- **C** 逐行读 PR 实现，对照 4 个 Codex bug fix + 排除项 + 接线。

> **关键校正（来自 Lead，brainstorm gate）**：原 task 写的 `8099a8b2` 是旧 head。637 runner 已把 main merge 进分支解 `StateStore.ts` 冲突（FLY-663 better-sqlite3 迁移）。本 QA 已对**新 head `1dd0ff85`**（会 ship 的、含冲突解析）验证。

---

## Acceptance Results

| # | 验收项 | 结果 | 证据 |
|---|---|---|---|
| 1 | escalation FSM：backoff 20→40→80→cap2h；3 轮后 page Annie 一次；Lead 答了停+清状态 | ✅ | FSM driver `[A]` 30/30；ext FSM 测 7/7；gate-poller 集成测 12/12 |
| 2 | Codex 4 个 bug 真修好（①swallow ②per-attempt eventId ③reset grace ④comm.db 误删） | ✅ | 见下「4 Codex Fixes」逐条 |
| 3 | 排除项不触发：founder-facing gate / 非阻塞 ask / 冻住 | ✅ | gate-poller 测「does NOT nudge founder-facing」「does NOT nudge non-blocking ask」；code `maybeEmitLeadPendingNudge` 只认 `cp==="question"` |
| 4 | per-question 持久状态（不串） | ✅ | PK `(execution_id, question_id)`；StateStore driver `[1]` + ext 测「multiple pending questions … independent」 |
| 5 | kill-switch `FLYWHEEL_LEAD_PENDING_ESCALATION=0` 全关 | ✅ | FSM driver `[F]`；gate-poller 测「=0 → never nudges」；code 早 return + prune 门控 |
| 6 | byte-compat：现有 watchdog 不回归 | ✅ | base direction-A 测全绿（130 测）；full suite 3846 pass；唯一 fail = 无关 flaky（见下） |
| 7 | 26 ext 测复核 + 全 teamlead 套（隔离、排除 pre-existing flaky） + tsc + lint | ✅ | 26/26；full suite 3846 pass / 3 flaky（隔离 4/4 pass）；`tsc --noEmit` exit 0；`biome check` exit 0 |

---

## 4 Codex Fixes — verified

| # | Bug | Fix（code 位置） | 验证 |
|---|---|---|---|
| ① | alert 没真发出却标记已页（swallow） | `emitLeadPendingUnhandledAlert` 只在 `result.sent\|queued\|dmSent === true` 返 true；`page_annie` 分支 `paged_annie: accepted`（无 sink / skip / dead-letter → false，下个 eligible tick 重试） | code read；FSM driver `[B]`（count=4 paged=false → 再 page）；gate-poller 测「page NOT accepted leaves paged_annie false and re-attempts (R1 #1)」 |
| ② | 同 eventId deadletter 后被当 duplicate 误判 | page alert eventId 带 `…:${nudgeCount}`（每次重试递增）；`duplicate` 不被接受、只认 sent/queued/dmSent | code read；gate-poller 测「never accepts skipped:duplicate, … per-attempt eventId (R2 #1)」 |
| ③ | stage 变化没重置 grace | `decideLeadNudge` 在 `prev.stuck_key !== stuckKey` 时返 `reset`，`next_eligible = now + grace`（不立即催）；gate-poller persist 这条 fresh row | FSM driver `[C]`；gate-poller 测「stuck_key change … resets with a fresh grace — no immediate nudge (R1 #2)」 |
| ④ | comm.db 瞬时打不开误删 backoff 行 | `getPendingQuestions` 只在 `openReadonly` throw **且文件存在**时调 `onReadFailure` → `leadPendingPollComplete=false` → prune 跳过（文件不存在=benign empty，prune 照常）；circuit-open / poll-throw 同样置 false | code read（`getPendingQuestions` L807-811 + prune 门 L450-466）；gate-poller 测「signals onReadFailure for existing-but-unopenable comm.db, not a missing one (R1 #3)」 |

补充：**页 Annie 不进 auto-repair** —— alert eventType = `runner_lead_pending_unhandled`，**不带 `runnerStuck` metadata**，且**不在** `AUTO_ATTEMPT_EVENT_TYPES`（= `{runner_stuck_unhandled, pane_hash_stuck}`）→ AutoRepairBot 不会给 runner 乱发 `continue`（Codex design R1 #3）。催 Lead 的 `runner_lead_pending_escalation` 已加进 `GUARDRAIL_EVENT_TYPES` → 投递失败可靠重试（R1 #6）。gate-poller 测断言 `no runnerStuck metadata`。

---

## FLY-663 merge resolution — independently verified

新 head 把 FLY-663（StateStore sql.js→better-sqlite3）merge 进来。`lead_pending_escalation` 的方法仍调 `this.db.exec/run/getRowsModified` + `this.save()` —— 因为 FLY-663 引入 `CompatDb`（sql.js-shape wrapper over better-sqlite3）：`exec()` 返回 `[{columns, values}]`（`getLeadPendingEscalation` 读的正是这个 shape）、`save()` 现为 no-op（better-sqlite3 autocommit）。

独立 **StateStore driver（real better-sqlite3，on-disk reopen）14/14**：
- 全升级状态（`nudge_count` / `next_eligible_at_ms` / `paged_annie`）**逐字段**跨 reopen 存活 → Bridge 重启**不 re-storm**（退避时钟保留）。
- `paged_annie=true` 跨 reopen 存活 → page-once 跨重启成立。
- empty-set prune DELETE 跨 reopen 持久（即使 `save()` no-op + `getRowsModified()=0`，autocommit 已落盘）。
- per-question 跨 reopen 独立、`clear(execId)` / selective-prune 持久。

---

## Test Evidence

```
# 独立 drivers（mock clock / real better-sqlite3）
FSM driver           30 pass / 0 fail   (backoff 20→40→80→cap120, page on 4th cycle, re-page>=, reset, never-page, kill-switch)
StateStore driver    14 pass / 0 fail   (full-state restart survival, page-once persist, no-op-save+autocommit delete, per-question)

# 实现者测试（隔离跑，新 head 1dd0ff85）
26 ext 测            26/26  (lead-pending-escalation 7 + StateStore.lead-pending-escalation 7 + gate-poller-lead-pending 12)
base direction-A     全绿   (quiet-classifier / runner-idle-watchdog-fingerprint / StateStore.quiet-wake-notified /
                            heartbeat-quiet-suppression / stuck-escalation / runner-idle-watchdog[-quiet]) — 含上面共 130 测

# 全 teamlead 套
vitest run          3846 passed / 3 failed (267 files)
  └ 3 fail = src/__tests__/createLeadRuntime-preflight.test.ts —— PRE-EXISTING FLAKY，非 FLY-637 回归：
      · FLY-637 对该文件依赖的 lead-runtime.ts 唯一改动 = 给 GUARDRAIL_EVENT_TYPES Set 加一行（纯加性，与 codec-roundtrip preflight 无关）
      · 失败伴随 vitest worker "Timeout calling onTaskUpdate" RPC 超时（3849 测并行下 worker 饿死）
      · 隔离单跑该文件 = 4/4 PASS（确定性通过）→ 判定 flaky-under-load，排除

# 静态检查
tsc --noEmit        exit 0
biome check         exit 0 (11 changed source files)
```

---

## Boundary / Notes（诚实边界）

- 本 QA 是**逻辑层 + 持久层** combined QA（mock clock + real better-sqlite3 engine），**不**含 live 端到端：真实 20min–2h 退避延时、真 Discord 催 Lead / 页 Annie 消息投递、真 Bridge 重启 —— 按 task 明确要求（restart-gated，逻辑层 mock timer 隔离验、不实跑真 timer / 不重启生产 Bridge）排除。逻辑 + 持久状态已被三路交叉证实正确。
- 语义确认：`PAGE_ANNIE_ROUNDS=3` = 先催 Lead 3 轮（nudge #1/#2/#3），第 4 个 eligible escalation cycle 改为 page Annie 一次（code `newCount >= pageAnnieRounds + 1`），符合 spec「催满 3 轮还没答 → 兜底页 Annie 一次」。
- `>=`（非 `===`）的 page 判定 + gate-poller 只在真 accept 时置 `paged_annie` → 页失败会在下个 eligible tick 重试，不会「advance 过 page step 然后永不页」。

**结论**：7 条验收项全 PASS，4 个 Codex bug fix 真修好，FLY-663 merge 解析正确，无回归。建议 → 单独 founder-gate ship PR #386。
