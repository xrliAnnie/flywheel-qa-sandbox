# FLY-1204 三段式 phase session 泄漏 — QA 报告

Issue: FLY-1204 (https://linear.app/geoforge3d/issue/FLY-1204/bug-三段式-designqa-阶段-session-交接后不被收掉-内存泄漏累积-oomclose-runner-也拒关-design)
日期: 2026-07-13
基于: plan.md, exploration.md, research.md
阶段: QA (三段式流水线第三段 — 验证 implement 已提交的改动,不重新实现)
PR: #571 (branch flywheel-FLY-1204, head ba4c4f2d + 本 QA commit)

---

## 1. 验收结论

**PASS。** 4 块改动(A/B/C/D)与 plan 逐条吻合、实现正确、依赖真实存在、全套单测 + 集成测试绿、lint + tsc 干净。QA 阶段补齐了 plan 测试计划明列却缺失的两个用例(重入 guard §258、独立节流 §259),使 FLY-1204 触及测试从 135 → 137 全绿。

根因修复三条诉求全部覆盖:
1. **交接/终态后回收上一段**(诉求1)→ Change A:`makeFinalizeThreeStagePhases` filter 加 `qa` 段 + `RECLAIMABLE_PHASE_STATUSES` 加 `completed`;external-merge ship 路径共用同一 finalizer。
2. **close_runner 接受 design_done**(诉求2)→ Change D:`DONE_STATUS_SET` 补 `design_done`,直接驱动 `/api/sessions?mode=by_identifier&statuses=` 的 done-mode lookup + tool 文档化。`completed` 普通 close 本就能关(exploration 已澄清 issue 描述不准)。
3. **周期兜底清扫**(诉求3)→ Change B(候选预筛)+ Change C(verdict 引擎 patrol,硬守卫绝不误杀健康 parked holder)。

---

## 2. 逐块代码核验(against plan)

### Change D — close_runner 关 design_done
- `terminal-mcp/src/lifecycle.ts`:`DONE_STATUS_SET` 加 `design_done`,注释说明与 Bridge `FINALIZE_DONE_SOURCE_STATES` 对齐(FLY-793 早已含 design_done,这是补 close-runner 侧漂移)。
- `terminal-mcp/src/index.ts`:tool 描述 + `done` 参数描述 + 两处 error 文案都补了 design_done;`>1` disambiguation guard 保留。
- **关键路径核实**:`DONE_STATUSES_PARAM = DONE_STATUS_SET.join(",")` 被 `index.ts:573` 直接拼进 `statuses=` 查询参数 → 服务端 by_identifier lookup 现能命中 design_done 段。**加集合就是完整修复**,单测断言集合 + param 字符串已充分覆盖该路径。

### Change A — ship finalize 主动回收 qa + external-merge
- `post-ship-finalization.ts`:新增 `RECLAIMABLE_PHASE_STATUSES = FINALIZE_DONE_SOURCE_STATES ∪ {completed}`;filter 加 `chat_thread_role === "qa"`。completed 是终态 → closeRunner 跳过 FSM 只拆 tmux;design_done 走 FINALIZE_DONE transition。幂等(target=null → alreadyGone)。
- `external-merge-reconcile.ts`:`ExternalMergeReconcileDeps` 加可选 `finalizeThreeStagePhases`(byte-compat),`finalize()` 透传给 `runPostShipFinalization`。
- `plugin.ts`:构造**单一共享** `finalizeThreeStagePhases`,run-infra 路径 + external-merge reconciler 注入同一个实例。核实:构造点上移到 L3612,两处引用同名常量,无重复构造。

### Change B — 候选预筛
- `StateStore.getParkedPhaseCandidates()`:`chat_thread_role IN (design/implement/qa) AND status IN (design_done/completed/awaiting_review/approved_to_ship/running)`,`ORDER BY last_activity_at DESC, rowid DESC`。仅粗筛,真"parked"判定在 C。running 纳入候选(FAIL fix-loop park 时 status 可能仍 running)。

### Change C — 兜底 patrol verdict 引擎(核心守卫)
- `HeartbeatService.checkStaleParkedPhases()`:kill-switch(`FLYWHEEL_STALE_TERMINAL_CLOSE=0`)+ 全局重入 guard(`parkedSweepRunning`)+ 独立节流(`lastParkedCheckAt` / `staleCheckIntervalMs`)+ 稳定 `execution_id` watermark 轮转(`PARKED_SWEEP_CANDIDATE_CAP=200`,FLY-1210 根治多-issue starvation)。
- `computeIssueReclaimVerdict()`:**(1)** 有 `post_ship_finalization_claim` → pipeline 已终结,自动回收全部真-parked/terminal(TOCTOU 无害,自动化主力);**(2)** 无 claim → `classifyIssueWorking` 非 clean 就整 issue keep/defer;clean + 超 grace → `completed` 自动收、非终态 parked 只告警。
- 辅助全部核实:`classifyTurn`(TURN stale-aware,仅 in-flight spawn defer)/ `declaredStateIsParked`(CommDB read error → defer,fail-closed)/ `probePhaseLiveness`(三态,`lookupTmuxTarget` error≠gone)/ `isBeyondParkedStale`(时间兜底)/ `pickLatestNPerRole`(≤GHOST_PROBE_MAX_ROWS/role)/ `alertOrphanParkedOnce`(投递成功后才落 dedupe,失败不静音)。
- `plugin.ts` wiring:`closeParked` 走 closeRunner(`finalizeDone:true`,`executorType:"phase"`,**NO archive**);`alertOrphan` 晚绑(sink 未绑时 throw 不静默,防 dedupe 误落账),复用 `three_stage_stuck` 事件类型 + 真实 lead/project attribution。

### 依赖真实性核验(全部存在,签名一致)
- `StateStore`: `getParkedPhaseCandidates` / `getPhaseSessionsForIssue` / `countEventsByIssueAndType` / `hasQuietWakeNotified(execId,source,fp)` / `recordQuietWakeNotified` ✓
- `CommDB`: `openReadonly` / `getTurn` / `getEffectiveDeclaredState(execId, nowMs)`(readonly-tolerant)✓
- `HeartbeatService` imports: `lookupTmuxTarget` / `probeRunnerProcessLiveness` / `GHOST_PROBE_MAX_ROWS` / `TURN_GRANT_GRACE_MS`(后两者本 PR export 出来避免漂移)✓
- `closeRunner` 接受 `executorType?` / `finalizeDone` ✓;`commDbPathForProject` 已 import ✓
- `alertOrphanParkedOnce` 以 issueId 作 synthetic key 传入 `hasQuietWakeNotified`(execution_id 列)—— 有意复用 composite-PK dedup 表,非 bug。

---

## 3. 测试执行结果

### 现有测试(implement 阶段随代码提交)
| 套件 | 用例 | 结果 |
|------|------|------|
| `HeartbeatService.fly1204-parked-reclaim.test.ts` | 17(现) | ✓ |
| `StateStore.fly887-keepalive.test.ts` | 10 | ✓ |
| `post-ship-finalization.fly887.test.ts` | 9 | ✓ |
| `external-merge-reconcile.test.ts` | 13 | ✓ |
| `terminal-mcp/lifecycle.test.ts`(Change D)| 16 | ✓ |
| `feature-flags-drift.test.ts` | — | ✓ |

### QA 阶段新增(补 plan 明列缺口)
plan 测试计划 §258/§259 明列但实现未覆盖:
1. **重入 guard(§258)** — `re-entrancy guard: a second sweep while one is in flight short-circuits (no double close)`:用确定性 gate 让 sweep-1 挂在 closeParked 内(`parkedSweepRunning=true`),sweep-2 必须短路、不重复 close 同一候选。
2. **独立节流(§259)** — `independent throttle: a second sweep within staleCheckIntervalMs is skipped`:1h interval 下首扫跑、窗口内二次调用被 `lastParkedCheckAt` 节流为 no-op。

`makeService` 扩了可选 `intervalMs` 参数(default 0,保持既有 17 用例行为不变)。

### 回归 + 全量
- `HeartbeatService.fly1204-parked-reclaim.test.ts`:**19/19** ✓(17+2)
- 全 4 个 `HeartbeatService*` 套件:**79/79** ✓(含 `stale-terminal-close` = FLY-867 兜底回归,共享 kill-switch/interval 路径未破)
- 6 个 FLY-1204 触及 teamlead 套件合跑:**135/135** ✓ →(+2 新增)**137**
- `terminal-mcp` 全套件:**37/37** ✓
- `phase-orchestrator.test.ts`(export 常量来源):**69/69** ✓
- `tsc`(terminal-mcp + teamlead build):0 error ✓
- `biome check` 改动测试文件:0 issue ✓
- CI(PR #571):FLY-1062 payload check = SUCCESS;Build & Test 跑最新 head 中(干净环境为权威 gate)。

---

## 4. 真机 E2E 说明(诚实边界)

验收原文:「真机:跑几轮三段式 → 每个 issue 结束后不残留 design_done/completed 的 alive session」。

该改动是 **Bridge 内部的内存生命周期回收 patrol** + finalize 路径补漏 + terminal-mcp 文档/集合改动,其"产品面"是**泄漏进程消失 / 不再 OOM** 以及孤立段的 Lead 告警——不是 founder 可见的交互面。完整真机 E2E 需要:① 部署带新代码的 Bridge(**restart-gated = 正是 founder-gated ship 步骤**);② 真跑数轮三段式流水线到 ship;③ patrol 6h 节流 + 24h staleness 兜底路径需一天才自然触发。**在 host 上复现 OOM 事故条件本身不安全**(memory:销毁性动作前先抓基线 / runner 绝不 host 上跑破坏性测试)。

因此本阶段采用**对回收引擎的确定性行为验证**(而非纯 mock):
- `getParkedPhaseCandidates` 跑**真 StateStore**(`StateStore.create(":memory:")` 真 SQLite);
- declared_state / TURN 读**真 CommDB 文件**(`new CommDB(...)` + `upsertDeclaredState` / `grantTurn`);
- verdict 引擎的全部安全反例(有 claim / 无 claim / has_working / in-flight TURN / stale TURN / read-error defer / 双 probe 预算 / 时间兜底 / cap 轮转 / 告警去重)逐一验证;
- 唯二 mock 边界 = tmux 进程存活(本质依赖真 tmux,无法单测)+ closeParked 拆卸(closeRunner 路径在别处已测)。

**真机三段式回收的最终验证 = 部署上线后的自然观察**(新 Bridge 一旦 live 并跑流水线,design_done/completed 不再累积);这属于 post-ship 观察项,不阻塞本 PR 合入。已在报告中明记边界,不冒充跑过。

---

## 5. 未触碰 / 潜在关注

- **未改** FLY-887 交接期 PARK 语义(设计意图保留)。
- **未并入** FLY-603 worktree 泄漏(同类但独立,follow-up)。
- **byte-compat**:所有改动仅三段式 keep-alive 路径生效;`staleParkedClose` 未 wire → patrol inert;两个 env(`FLYWHEEL_STALE_TERMINAL_CLOSE=0` / `FLYWHEEL_PARKED_PHASE_STALE_HOURS`)可控。
- Codex code review 已 5 轮 APPROVED(含 FLY-1210 stable-watermark 根治多-issue starvation)。
