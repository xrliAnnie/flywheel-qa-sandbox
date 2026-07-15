# FLY-1204 三段式 phase session 泄漏 — 进度 (progress ledger)

Issue: FLY-1204 (https://linear.app/geoforge3d/issue/FLY-1204/bug-三段式-designqa-阶段-session-交接后不被收掉-内存泄漏累积-oomclose-runner-也拒关-design)
日期: 2026-07-12
基于: exploration.md

## Phase: design

- [x] onboard + 代码审计（close-runner / phase-orchestrator / post-ship-finalization / HeartbeatService / StateStore / terminal-mcp）
- [x] exploration.md（根因分析 — 3 个结构缺口 A/B/C + 设计张力 §4）
- [x] brainstorm gate — Tadashi 批准方向 + 三决策（守卫硬/阈值单列/design_done 保 done-mode）
- [x] research.md（核实:QA 不 park、守卫 helper 全在 StateStore 层、DONE_STATUS_SET 漂移）
- [x] plan.md（4 块改动 A/B/C/D 到函数行级 + TDD 测试计划）
- [x] design_review — Codex design review 3 轮 APPROVED（R1 5 项 + R2 4 项全采纳；5 条 implement notes 已纳入）
- [ ] commit + complete --route phase_design_complete ← 当前

## Codex design review 收敛记录

- R1 CHANGES REQUESTED（3 BLOCKER + 2 MAJOR）：C2 守卫误杀健康 holder / external-merge 漏 finalize / C4 误归档未 ship thread / async 签名+节流+扫描边界 / 测试缺安全反例 → 全部重写采纳。
- R2 CHANGES REQUESTED（2 BLOCKER + 2 MAJOR）：TURN 无 TTL 会永久 defer orphan / probe→close TOCTOU / helper 三态+API+alert+wrapper+全局 guard / probe 预算只覆盖 verdict → 全部采纳（TURN 收窄为 in-flight spawn 检测；自动 kill 收窄到 ship-claim + completed 终态，非终态 parked 只告警）。
- R3 APPROVED + 5 条非阻塞 implement notes（stale TURN 显式清 / 常量 export+rotation / dedupe 落账时机 / late-bound alert sink / header status）。

## 根因一句话

keep-alive 交接后 design/qa 段 PARK 保活（FLY-887 故意），但 ship/终态后的回收链有 3 缺口：
A) ship finalize 漏 qa；B) 周期兜底 SQL 漏 design_done；C) 兜底 closeStale 不传 finalizeDone 关不掉 design_done。
close_runner：completed 本能关（issue 描述不准），design_done 因 lifecycle.ts DONE_STATUS_SET 漂移（缺 design_done）关不掉 → 补集合 + 文档。

## Tadashi brainstorm 决策（已 fold 进 plan）

① 守卫硬：hasShipFinalizationClaim OR（无 alive 下游 + 已过终态）才回收，绝不误杀健康 parked holder。
② 阈值单列 FLYWHEEL_PARKED_PHASE_STALE_HOURS（保守 24h）；终结守卫主力即时回收，时间纯兜底。
③ design_done 保 done-mode（finalizeDone），文档化 + 补 DONE_STATUS_SET；不让普通 close 静默接受。

## Next

Codex design review（前台迭代到 APPROVED）→ commit → complete --route phase_design_complete → park。

## Phase: implement (2026-07-12)

- [x] pnpm install + full `pnpm -r build` (fresh worktree, no node_modules)
- [x] Change D — terminal-mcp DONE_STATUS_SET += design_done + tool doc/error text (TDD RED→GREEN, 37/37)
- [x] Change A — finalize 加 qa role + RECLAIMABLE_PHASE_STATUSES(+completed) + external-merge seam + plugin 共享 finalizer wire (TDD 9+13 绿)
- [x] Change B — getParkedPhaseCandidates() 候选预筛(TDD 10 绿)
- [x] Change C — verdict 引擎 patrol(computeIssueReclaimVerdict / classifyIssueWorking / classifyTurn / declaredStateIsParked / probePhaseLiveness / isBeyondParkedStale / alertOrphanParkedOnce)+ C1 env FLYWHEEL_PARKED_PHASE_STALE_HOURS + C4/C5 plugin wire(closeParked no-archive + 晚绑 orphan alert 复用 three_stage_stuck)。安全反例单测 14 绿
- [x] 常量 export(GHOST_PROBE_MAX_ROWS / TURN_GRANT_GRACE_MS)避免漂移
- [x] tsc 干净 + `pnpm -w lint` 0 error + 触及包单测全绿(teamlead 46 + terminal-mcp 16 + Heartbeat/phase-orchestrator/auto-qa 隔离复跑绿)
- 全仓 `vitest run` 唯二红为环境性(codex-lead-runtime TMPDIR-overlap 隔离跑 124/124 绿 + 一次 worker OOM-timeout flake),非本改动;CI 干净环境为权威 gate
- [ ] commit → push → PR → codex code review → approve gate(founder-gated 停点)← 当前

## Implement Notes 落实
- Note 1(stale TURN)：采纳「接受 tiny stale row + 不写不实注释」(见 classifyTurn 注释:stale TURN 不阻塞回收,turn-belt reconciler 负责;不 deleteTurn 以免给 HeartbeatService 加 writable-CommDB 面)
- Note 2：GHOST_PROBE_MAX_ROWS / TURN_GRANT_GRACE_MS export 复用;cleanup revalidate 逐 autoReclaim 就地 probe(无 backlog rotation 需求——每 sweep 全量分组,非头部截断)
- Note 3：alertOrphanParkedOnce 落账在 alertOrphan 成功返回后(失败不静音)
- Note 4：orphanParkedAlertHolder 晚绑,复用 three_stage_stuck + 真实 lead/project/session attribution
- Note 5：header 已 codex-approved

## Codex code review 收敛（implement 阶段）
- R1 CHANGES REQUESTED（4 项）→ 全修：config drift 注册 FLYWHEEL_PARKED_PHASE_STALE_HOURS / alert-holder 未绑定时 throw 不落 dedupe / cleanup 加总 cap+rotation / classifyTurn 注释诚实化。
- R2 CHANGES REQUESTED（1 项）→ 修：per-issue cap 不够,改两段式(verdict → 扁平化 cleanup)加 PARKED_CLEANUP_PROBE_CAP 总 cap + candidate rotation cursor + 单-issue-超限测试。
- R3 CHANGES REQUESTED（1 项,rotation fairness 边界）→ **Tadashi 拍 Option C**：保留当前总 cap+rotation,把跨-sweep candidate rotation 在交替 issue-window 下的 tail-starvation 作为**文档化 known-limitation**（HeartbeatService Phase-2 注释,注明偏离 plan.md:83 + 自我排除场景 + tail=dead husk）+ 开 **follow-up FLY-1210**。核心安全不变量(绝不误杀健康 parked holder)3 轮均 CONFIRMED。
- R4 CHANGES REQUESTED —— **推翻 R3 接受前提**：Codex 证明 starvation 不需要单 mega-issue,多 issue×少候选(总>cap)也触发,且被饿死的 tail 可能是**真 alive 泄漏**非 dead husk → Option C 的「自我排除/dead husk」基础不成立。**改为直接根治**（而非 defer FLY-1210）：checkStaleParkedPhases 改用**稳定 execution_id watermark 走全量候选**(单游标+稳定全局排序,每轮 PARKED_SWEEP_CANDIDATE_CAP,到尾回头),⌈total/cap⌉ 轮内每个候选必达,无 per-sweep-window modulo 抖动。删两游标/两段式,反而更简。补多-issue 覆盖测试(60×5=300>200 两轮全达)。FLY-1210 取消(resolved-in-PR)。已回报 Tadashi 前提更正。17 单测绿。
- R5 **APPROVED** ✅ —— stable-watermark 根治多-issue starvation,core safety + fail-closed probe 保持。写 code-review.json + await-codex-gate 交付 Bridge(head 472fbbd0)。
- ✅ implement 阶段完成:codex code review APPROVED gate 已关 → approve_to_ship gate 已开(--no-block,questionId 09339dc8)→ complete --route needs_review --pr 571 → park 等 founder-gated ship。CI Build&Test 跑最新 head 中。

## Phase: qa (2026-07-13)

- [x] 读齐本分支 design(exploration/research/plan)+ implement 代码 diff + progress —— 不重新实现
- [x] 逐块核验 A/B/C/D against plan(finalize+qa / external-merge seam / getParkedPhaseCandidates / verdict 引擎 + wiring / DONE_STATUS_SET);依赖真实性核验(StateStore/CommDB/tmux-lookup/closeRunner 签名全对)
- [x] 跑现有测试:6 套件 135 绿 + terminal-mcp 37 绿 + phase-orchestrator 69 绿 + 全 HeartbeatService 79 绿;tsc 0 error;biome 干净
- [x] 补 plan 明列但缺失的 2 用例(重入 guard §258 / 独立节流 §259)→ HeartbeatService.fly1204 从 17→19 绿;`makeService` 扩可选 intervalMs(default 0 保既有行为)
- [x] qa-report.md(PASS,含真机 E2E 诚实边界:Bridge 内部回收 patrol,真机复现 OOM 不安全 → 部署后自然观察)
- [ ] commit + push → qa-result pass → approve gate(founder-gated ship,本 QA 段是 ship executor)← 当前

## QA 结论
PASS。4 块改动逐条符合 plan、实现正确、依赖真实、全测绿。补齐重入+节流覆盖(137 触及测试全绿)。真机三段式回收 = post-ship 自然观察项,不阻塞合入。
