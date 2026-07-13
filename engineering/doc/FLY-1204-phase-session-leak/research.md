# FLY-1204 三段式 phase session 泄漏 — 调研

Issue: FLY-1204 (https://linear.app/geoforge3d/issue/FLY-1204/bug-三段式-designqa-阶段-session-交接后不被收掉-内存泄漏累积-oomclose-runner-也拒关-design)
日期: 2026-07-12
基于: exploration.md

> 本文核实 exploration §6 的待确认点，并把 brainstorm gate 里 Tadashi 的三个决策落成可实施的技术选型。

---

## 0. Brainstorm gate 已定的方向（Tadashi 批准）

1. **不动 FLY-887 交接期 PARK**（有意的 context holder）。只补回收链 3 缺口 + 加**硬守卫**：`hasShipFinalizationClaim` 或（无 alive 下游 + 已过终态）才回收，**绝不误杀慢跑 issue 的健康 parked holder**。
2. **兜底阈值单列** `FLYWHEEL_PARKED_PHASE_STALE_HOURS`（别复用 24h 通用 stale），语义独立可调。分工：**终结守卫 = 主力**（确认孤立/pipeline 终结即时回收、不等时间）；**时间阈值 = 纯安全网**，保守偏长（24h 量级，宁晚收不误杀）。快回收靠守卫，不靠时间。
3. **design_done 保留 done-mode**（finalizeDone），不让普通 `close_runner` 静默接受它（会掩盖"这段其实还需当 context holder"）。真正修法 = **文档化/可发现**（MCP tool 描述写明 design_done 用 `done=true` 关）+ 自动兜底 closeStale 对 design_done 带 finalizeDone（缺口 C）。

---

## 1. 核实点 1 —— QA 段 completed 后为何残留（主路径）

**结论：QA 段不 PARK；completed qa 残留 = ship 主路径没可靠关掉它，缺口 A 是主路径修复点。**

证据 `packages/edge-worker/src/Blueprint.ts:1099-1120`：keep-alive PARK epilogue **只加给** Design（`isDesignPhase`）+ Implement（`isImplementPhase`）：
- Design：`complete --route phase_design_complete` 后 park，"stay alive as the design-context holder until ship; the Bridge closes you after ship."
- Implement：PR review（`complete --route needs_review`）后 park，等 QA FIX wake。
- **QA（`isQaRunner`）没有 PARK epilogue** —— 走 `buildQaModeSystemPromptLines`（1144-1153）+ 标准 APPROVE GATE：QA PASS → 开 gate → `complete --route needs_review` → 等 founder → ship → `stage set completed` → 进程退出。

那 completed qa 残留怎么来？—— QA ship 完成后 `stage set completed` 会触发 `runPostShipFinalization`，其 step-1 `postMergeTmuxCleanup(opts.executionId)` 本应关掉触发者（QA）的 tmux。但这条依赖：① QA 的 completion event 满足 `isPostApproveShipComplete`（`post-ship-finalization.ts:68-99` 的 existingStatus/route/landingStatus=merged 组合）**且** ② 触发者恰好是 QA execId **且** ③ QA 的 CommDB registration 还在（`getTmuxTargetFromCommDb` 找得到）。任一不满足 —— ship 由 external-merge 触发、QA 在 `needs_review` 后 idle 期间被别路径推进、或 registration 已被前一次清理 —— QA 段就没被关，残留在 `completed` + 进程 alive。

> 因此缺口 A 的修法**不是**去修补这条脆弱触发链，而是让 `finalizeThreeStagePhases` **主动**把 qa 段也纳入回收（不依赖"QA 恰好是触发者"）。ship 成功 → 遍历该 issue 全部 parked phase（design/implement/**qa**）→ 逐个 `closeRunner`（幂等：target=null → alreadyGone，重复关无副作用）。

## 2. 核实点 2 —— 守卫所需 helper 全在 StateStore 层可达（无需注入 plugin closure）

守卫（决策 ①）需要两个信号，都能在 StateStore / HeartbeatService 层直接实现：

- **无 alive 下游 / 段已孤立** → `getPhaseSessionsForIssue(issueId)`（`StateStore.ts:2857-2878`）返回该 issue 全部 `chat_thread_role IN (design,implement,qa)` 的 session（含 status + last_activity_at）。守卫判"除自己外，是否还有非终态的 phase 段活着"。
- **pipeline 已 ship（hasShipFinalizationClaim 等价）** → `countEventsByIssueAndType(issueId, "post_ship_finalization_claim")`（`StateStore.ts:2888-2897`）> 0。这个 claim event 正是 `runPostShipFinalization` step-0 写的原子 claim（`post-ship-finalization.ts:294-302`），是"该 issue 已进入 ship finalization"的durable 信号。

> plugin.ts 里给 PhaseOrchestrator 的 `hasShipFinalizationClaim` / `getAlivePhaseSession` 也是基于同源数据的 closure，本 fix 不必复用它们——直接在兜底路径用上面两个 StateStore 方法即可，避免把 orchestrator 依赖拖进 HeartbeatService。

## 3. 核实点 3 —— 兜底扫描的候选与 CommDB registration

- **parked design_done 段的 CommDB registration 还在**：`parkPhaseRunner`（`plugin.ts:5604-5623`）只 `upsertDeclaredState="parked"`，**不** `deleteCommDbSession`。所以 `checkStaleCompleted` 的 `getTmuxTargetFromCommDb` 能找到它的 tmux window（`HeartbeatService.ts:916-923`），`isTmuxWindowAlive`=true → 走 close。→ 只要把 design_done 纳入**候选集**（缺口 B）+ closeStale 带 finalizeDone（缺口 C），兜底就能收 design_done。
- 现有候选集 `getStaleCompletedSessions`（`StateStore.ts:3418-3420`）SQL = `status IN ('completed','failed','blocked')`，**不含 design_done**。需新增覆盖 design_done 的查询（见 plan）。
- `checkStaleCompleted` 已有 `isRetestProtected` 守卫（`HeartbeatService.ts:987`）——那是 auto-QA record 的保护，与三段式 phase 段无关（三段式 qa 无 auto_qa_record）；不受影响。但**三段式 parked 段需要额外的"终结/孤立"守卫**（决策 ①），因为 `isRetestProtected` 不覆盖它。

## 4. 核实点 4 —— byte-compat / kill-switch / FLY-603 关系

- **byte-compat**：所有改动只在三段式 keep-alive 路径生效。keep-alive OFF（`FLYWHEEL_THREE_STAGE_KEEPALIVE=0`）无 parked 段 → finalize/兜底候选为空；非三段式 session（`chat_thread_role` 非 design/implement/qa）不受影响。
- **kill-switch**：新兜底对齐 FLY-867 —— 复用 `FLYWHEEL_STALE_TERMINAL_CLOSE=0` 关掉整条 stale-close；新增阈值 `FLYWHEEL_PARKED_PHASE_STALE_HOURS`（默认 24）单列。
- **FLY-603（worktree 清理没触发）**：同类生命周期泄漏。本 fix 的 finalize-qa 走 `closeRunner`（不碰 worktree removal——共享 worktree 由 `removeCleanWorktree` 在 finalize 之后统一删，`post-ship-finalization.ts:352-399`）。FLY-603 是 worktree 侧，本 issue 不合并处理它（scope 纪律），但兜底回收 parked 段后共享 worktree 的孤立问题可作为 follow-up 记录。

## 5. 现有测试锚点（实现阶段复用/扩展）

- `packages/teamlead/src/bridge/__tests__/post-ship-finalization.fly887.test.ts` —— finalize 的既有测试（加 qa 场景）。
- close-runner / HeartbeatService.checkStaleCompleted 的既有单测（加 design_done 候选 + 守卫场景）。
- StateStore.getStaleCompletedSessions / getPhaseSessionsForIssue 的既有 DB 测试。

---

## 6. 落到 plan 的技术选型（汇总）

| 缺口 | 修复 | 文件（预估） |
|------|------|------------|
| A · finalize 漏 qa | `makeFinalizeThreeStagePhases` filter 加 `qa` role；`completed`/`awaiting_review`/`approved_to_ship` 纳入可回收（qa 终态 completed 也收）；close 幂等 | `post-ship-finalization.ts` |
| B · 兜底 SQL 漏 design_done | 新增 `getStalePhaseSessionsForCleanup`（或扩现有）覆盖 `design_done`（+ completed）三段式 parked 段候选 | `StateStore.ts` |
| C · closeStale 关不掉 design_done | 兜底对 design_done 段带 `finalizeDone:true` + `transitionOpts`；HeartbeatService 兜底加"终结/孤立"守卫（`countEventsByIssueAndType(post_ship_finalization_claim)>0` 或无 alive 下游）+ 单列阈值 `FLYWHEEL_PARKED_PHASE_STALE_HOURS` | `HeartbeatService.ts` + `StateStore.ts` + `plugin.ts`(wire) |
| 2 · close_runner 文档 | MCP tool 描述写明 design_done 用 `done=true` 关；确认 `completed` 普通 close 已能关（补测） | `terminal-mcp/src/index.ts` + `lifecycle.ts` |

守卫逻辑（决策 ①，主力即时回收）：
```
候选 = 三段式 parked phase 段(design_done / 或 completed 的 qa/implement)
回收条件(OR):
  (a) 终结守卫: countEventsByIssueAndType(issue, "post_ship_finalization_claim") > 0
              OR 该 issue 无 alive/非终态下游 phase(getPhaseSessionsForIssue 全终态)
  (b) 时间兜底: last_activity_at 超 FLYWHEEL_PARKED_PHASE_STALE_HOURS(默认 24)
命中 → closeStale(finalizeDone for design_done)
```
