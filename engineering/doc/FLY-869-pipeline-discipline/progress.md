# FLY-869 流水线纪律收口 — progress

Issue: FLY-869 (https://linear.app/geoforge3d/issue/FLY-869/infrapipelineconsolidated-流水线纪律收口-qa-该起没起原-868-merge-抢跑提前)
日期: 2026-07-04
基于: 无

## Phase: design (brainstorm)

- [x] onboard + inbox 读 Lead 指令 a298450d（以身作则走 C 半 brainstorm 门）
- [x] 深度审计三半代码（C=founder-ux gate/#369 验签路径；B=DirectEventSink+event-route merged→completed；A=auto-qa-coordinator/verify-approval/finalization）
- [x] 核实 B 半 anti-regress 关键事实：verify-approval 用 durable CommDB approve_to_ship 批准记录（非裸 status）
- [x] brainstorm gate 发出（三半理解 + 修法 + 5 岔口）→ Lead 确认「三半理解全对，岔口问得准」→ 已转 Annie 在 869 thread 过目
- [ ] **HOLD：等 Annie「OK 开始做」经 Lead relay 回来 → 才解锁写代码**（她若改某条，Lead 带具体修改回来 → 我据此改设计再重开 gate）
- [ ] exploration.md / research.md / plan.md（full doc tier）
- [ ] design_review gate
- [ ] implement（TDD）
- [ ] PR + approve gate

## Implement 进度（Annie GO 后，commit 39b1bf36）

**已完成 + 已验证:**
- ✅ Codex design review APPROVED（3 轮，抓出我设计里 2 个 critical 自 bug：调用时序 + 独立开关）
- ✅ Schema: 6 typed 列 + 两 interface + rowToSession + patch 白名单 + 4 immutable helper（setQaRequiredSnapshot/setMergeBlock 兼一次性 alert claim/clearMergeBlock/markCodexHoldStarted）
- ✅ **共用 ship-eligibility predicate**（flywheel-comm/ship-eligibility.ts）—— 编译通过 + **10 单测全绿**:
  QA gate fail-closed 边界 + **独立 B/A kill-switch**（关 merge 门不放 QA，R2 HIGH-3 证明）
- 🔄 C 半:后台 subagent 实现中（config resolver + trigger 扩面 + 4 消费点 + prompt/doc），未整合

**未做（continuation，按 Codex-approved plan）:**
- B 四表面 pre-transition decision 接线（DirectEventSink/event-route session_completed + W2 + complete-marker-reconciler）+ isPostApproveShipComplete 收 shipEligible + merge_block suppressor（扩 isReviewHeld 到 GatePoller/event-route/DES/HeartbeatService）+ recovery 双入口（actions.approveExecution + wiring.buildGateResponsePostWriteHook）+ 回归测试（FLY-120/58 不 regress）
- A-half: qa_required 快照 persist（auto-qa-policy eval）+ backfill + codexHold 升级 + orphan 兜底扫描
- 整合 C 半 subagent + registry FLYWHEEL_QA/MERGE 条目 + 全仓 lint/test + Codex code review + PR

## Implement — committed 增量（branch flywheel-FLY-869）
- `39b1bf36` foundation: schema 6 列 + StateStore helper + ship-eligibility predicate + 10 单测
- `ef8e4539` B 四表面 gate + merge_block park + isReviewHeld 中心 suppressor + isPostApproveShipComplete 单闸
- `7db20053` B recovery: clearMergeBlockOnApproval 双入口（actions + wiring）
- (本次) A-1: qa_required 快照持久化（auto-qa-coordinator onMainAwaitingReview 两路）
- C 半:subagent 已改 config/types/ConfigLoader/trigger/registry/index + founder-ux-config.ts（**工作树未 commit**，编译已随 teamlead 通过）

## Cursor — continuation TODO（按优先级，全 Codex-approved plan）
1. **A-1b backfill**(reconcileOnStartup :1106):对现存 awaiting_review/approved_to_ship 且 qa_required IS NULL 的 session backfill——有匹配 auto_qa_record→1；no-code/pr_handoff/无 PR→0;code PR 无法重建→alert/hold。**部署安全必需**(否则 in-flight session ship 被 fail-close)。
2. **B 回归测试**(Annie 明确要):approved_to_ship+merged+needs_review→completed 不卡(FLY-120);auto_approve+merged durable 批准→completed(FLY-58);merged 无批准→merge_block+不 Done;FLYWHEEL_MERGE_APPROVAL_GATE=0 退回;四表面参数矩阵一致。参照 event-route-dual-session-completed + complete-marker-reconciler.integration 测试脚手架。
3. **A-2 codexHold 升级**(:1069 reconcileCodexHolds + codexHold):markCodexHoldStarted 首次写;age>30min→stuck+一次性响亮 alert;onCodexReviewResult drop 前 warn。
4. **A-3 orphan 兜底扫描**(reconcileOnStartup):扫 awaiting_review+main+无 auto_qa_record+无 hold+未豁免+**无 merge_block**→补 spawn/hold;复用 :349-365 evidence gate。
5. **整合 C 半**:核对 subagent 输出 + registry 加 FLYWHEEL_QA_DONE_GATE/FLYWHEEL_MERGE_APPROVAL_GATE 条目 + 全仓 lint。
6. **loud Discord alert**:merge_without_approval 现只 console.warn + marker;接 lead-alert 真发 Annie(setMergeBlock claim 已保证一次)。
7. 全仓 pnpm test + Codex code review → PR → approve gate（founder-gated，本段停这）。

预算/质量保护:B 接线是 fragile 热点,已全部 pre-transition decision(不 regress FLY-120)+ 编译通过;不 rush 剩余。

## 测试验证状态（重要，已核对）
- 跑现有测试(非只 typecheck)发现我的 gate 破了 6 个现有 sink 测试 → **全部已修**:
  event-route.test / event-route-dual-session-completed / complete-marker-reconciler(integration+unit) /
  event-route-session-completed-guard。4 受影响 sink 套件 90/90,guard/unit 51/51,ship-eligibility 10/10。
- **修的过程抓到并修了真 production bug**:no-prHead / 无 existing-session 的 fallback 用 status proxy 绕过 kill-switch,
  会误判 auto_approve/首见 merged session → 改成四表面统一走 computeShipDecision(commit f35f5375 + 11f39b16)。
- 全 teamlead 套件剩 **23 失败经 origin/main(4e3129a5)核对为预存环境问题**(codex-lead-runtime TMPDIR +
  LeadAlertNotifier + createLeadRuntime-preflight),**非本 issue 引入**。
- commits: 39b1bf36 foundation / ef8e4539 B 四表面 / b2929fb9 recovery / 0d53ccc1 A-1 快照 /
  a89088d5 docs / f35f5375 统一 predicate 修真 bug / 11f39b16 mock-store 容错。
- C-half subagent 完成(default-on enforce + HIGH-1 resolver,323+67+1040+7 测过)已整合编译,**工作树未 commit**。

## continuation 待办(更新)
1. **提交 C-half subagent 的工作树改动**(config/types/ConfigLoader/trigger/registry/index/founder-ux-config + 其测试)。
2. A-1b backfill / A-2 codexHold 升级 / A-3 orphan 兜底扫描(reconcileOnStartup :1106)。
3. 新增 **B 集成回归测试**:带真 approval fixture(CommDB answered approve_to_ship + status + pr_head + codex/qa record)
   证 FLY-120 approved 路径**过门到 completed**(不只 kill-switch bypass);merged-but-unapproved → merge_block + 不 Done。
4. registry 加 FLYWHEEL_MERGE_APPROVAL_GATE / FLYWHEEL_QA_DONE_GATE 条目;loud Discord alert 接线(现 console.warn+marker)。
5. **C 半补丁(Lead 指令 2ee06754,不扩 scope)**:brainstorm gate 的豁免机制让「QA ·」前缀 / qa 类 issue
   **自动豁免**(不用手工打 label)—— 复用 A 半已有的 `isQaIssueSession`(title 前缀 "QA ·" / qa_issue_* 列)判定,
   接进 `resolveFounderFacingUx`/exempt 判定;测试用例带上真实 case **QA·867(FLY-873)**(被 three_stage 拆 design 段
   还上 Fable 的双重浪费)。注:三段拆分本身是 three_stage 特性(非本 gate 控),本条只落地「QA issue 免 brainstorm 门」。
6. 全仓 pnpm lint + Codex code review → PR → approve gate。

## Lead 确认(2026-07-04)
- 所有 checkpoint 答复正面;明确「**/compact 后同 runner 自己续、保知识、别硬撑 ctx**」= 标准做法。
- 续跑顺序(Lead 拍):A-1b backfill(部署安全优先)→ B 集成回归(真 approval fixture 证 FLY-120 过门到 completed +
  merged-无批准 → merge_block+alert 不 Done 两组)→ A-2/A-3 → C 整合 + registry flag(default ON per Annie 规矩)→
  loud alert → 全仓 test → Codex code review → 一个 PR。

## compact 后进度(2026-07-04 续跑)
- ✅ **C 半 commit** `693bdac5` — default-on brainstorm 门 + resolver 收口 + exempt_labels 全链;
  config 323 / trigger 8 / runs-route-exempt 5 / shell 7 全绿,三包(config/teamlead/edge-worker)build 过。
- ✅ **A-1b backfill** commit `ecc1c263` — reconcileOnStartup sweep(0)重建 qa_required 快照(部署安全);
  status-aware(approved_to_ship grandfather 防 strand);7 新测,auto-qa-coordinator 60/60 全绿。
- ✅ **B 集成回归** commit `2acb1f53` — 真 StateStore+CommDB+verifyApproval+QA闸+Bridge seam 全链;
  4 组(FLY-120 approved→completed / merged-无批准→merge_block 不 Done / same-head 批准 recovery / kill-switch),4/4 绿。
- ✅ **A-2/A-3** commit `3d15823f` — codexHold 超时 stuck 一次性响亮 alert + drop→warn + clear-on-approve;
  reconcileOnStartup(5) orphan 兜底扫描(排除 merge_block,freshTransition 复用内层门)。8 测,auto-qa 68/68。
- ✅ **C 补丁(QA issue 免门)** commit `0f4e3972` — isQaIssueTitle「QA ·」自动豁免,先于 fail-closed;QA·867 用例。trigger 12/runs-route 5。
- ✅ **loud Discord alert** commit `3959cf3f` — alertMergeWithoutApproval 接两活 sink(event-route×2+DirectEventSink)首次 claim 一次性发;
  reconciler 可选 hook(boot-drain 因 alert infra 后建故不接,marker+log)。sink 套件 185/185 不动。
- ✅ **registry** commit `81548e02` — FLYWHEEL_MERGE_APPROVAL_GATE/QA_DONE_GATE 两 kill-switch default-ON+独立,drift 过。
- ✅ **全仓 lint**:我的 16 个改动文件全 clean(逐个 biome check 过);全仓 `pnpm lint` 剩 6 个报错文件**全在 diff 之外**
  = 预存 repo 债(FLY-581 research asset / AgentTeamTransportFactory / 3 个 suppression 测试 / fleet-data.test),不碰(scope 纪律)。
- 🛑 **BLOCKER 发现(升级 Lead)**:origin/main 在我建 FLY-869 期间从 `4e3129a5` 推进到 `f03657ad`(FLY-863/864/865/867/871 已 merge)。
  **FLY-863 已把我的 A-2(codexHold 超时 stuck 升级)落在 main 了** —— 它用 `reconcileStuckCodexHolds` +
  `codex_review_record.stuck_notified_at` + `codexHoldStuckThresholdMs`(我用 sessions 表的 codex_hold_started_at/
  codex_hold_stuck_notified_at + markCodexHoldStarted/claimStuckCodexHold + reconcileCodexHolds 内升级)。plan 明写
  「A-2 … FLY-863 未在 main」现已过时。**我的 A-2 冗余 + 与 FLY-863 在 StateStore.ts/auto-qa-coordinator.ts 冲突**。
  真冲突文件(main 与我都改):StateStore.ts / auto-qa-coordinator.ts / auto-qa-coordinator.test.ts / registry.ts。
- 📋 **建议方案(等 Lead 确认再执行 rebase)**:rebase FLY-869 到当前 main(f03657ad),**DROP A-2**(FLY-863 已覆盖),
  保留 A-1/A-1b/A-3(orphan 兜底)/B(merge-抢跑,头号交付)/C(brainstorm 门 + QA 免门);把 A-1b/A-3/B/loud-alert
  层叠到 FLY-863 的 codex-hold 机制上;重跑全套 B 回归证 FLY-120 不 regress。**未经确认不碰 fragile hot-spot 的 rebase**。

## Lead 批准 ① + rebase 完成(commit ae909352)
- Lead 批准 ①:rebase 到 f03657ad + DROP A-2(863 今晚已 ship,真机 QA 16/16×2 + Codex 3 轮 + 在产)。两 verify:
  ① 全套 B 回归(FLY-120 不 regress)② 869 loud alert 不得把 863 静音的 routine codexHold 噪音带回来(加断言证 routine hold 仍静默)。
- 执行:`git merge origin/main`(interactive rebase 不可用 + A-2 跨 2 commit interleaved → merge + 外科式 A-2 移除,同终态);
  冲突(auto-qa-coordinator.ts + test)取 863 静音版 codexHold + `now` seam;外科移除 StateStore 的 codex_hold 列/方法 +
  coordinator 的 codexHoldStuckMinutes/reconcileCodexHolds 升级块/clear-on-approve/drop→warn(还原 863 log)+ A-2 测试块。
- **保留**(层叠 863,加性):A-1 快照 / A-1b backfill / A-3 orphan / B merge-race+merge_block+loud-alert / C。
- **verify 全过**:auto-qa 72(含新加的 routine-hold-silent 断言,Lead req 2)/ merge-ship 4(FLY-120 不 regress,req 1)/
  event-route 51 / StateStore / codex-gate(863 完好)…10 套件 320 绿 + flywheel-comm 35 + config 47。4 包 build clean,我的文件 lint clean。
- **PR net diff(main...HEAD)= 40 文件全 FLY-869**(863/865/867/871 在 merge-base 正确排除)。
- ✅ **PR #449** 开 + push;stage pr_created。
- ✅ **Codex code review APPROVED(3 轮 xhigh)**:抓出 **6 个真 merge_block 生命周期 bug** 全修 + 回归:
  R1(3):recovery 清 marker 但不 complete→strand(补 finalizeRecoveredMerge)/ reconciler 漏 awaiting_review park(TERMINAL 含 awaiting_review→改 NO_OUT_TERMINAL + headSha fallback)/ onMainAwaitingReview 漏 merge_block 守卫(codexReleased 会 QA parked)。
  R2(3,fail-closed):sink 用 row head(首 complete 时空)→改 row||event.evidence.headSha 绑真 head / recovery 清 marker 早于验 eligibility→改 eligibility-gated(QA 未满足留 marker held)/ worktree cleanup 省略记为 recovery path 明确取舍。
  R3:APPROVED 无新问题。回归 301+ sink/recovery 套件绿(真 StateStore+CommDB B 集成覆盖 FLY-120 不 regress + merged-无批准 park + recovery 两态 + kill-switch)。
- 🔄 **下一步**:approve gate(founder-gated,停这)。
