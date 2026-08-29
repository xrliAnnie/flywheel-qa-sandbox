# FLY-869 流水线纪律收口 — 实施计划

Issue: FLY-869 (https://linear.app/geoforge3d/issue/FLY-869/infrapipelineconsolidated-流水线纪律收口-qa-该起没起原-868-merge-抢跑提前)
日期: 2026-07-04
基于: exploration.md, research.md（Round 3：并入 Codex design R1 5HIGH+4MED、R2 5HIGH+3MED）

一个 PR 三半。TDD（RED→GREEN→REFACTOR）。所有新 flag **default ON**（Annie 决定 ②）+ 独立紧急关 kill-switch。

## 核心架构（R1/R2 收敛后）

**单一 ship-eligibility 判定，但 B/A 两 gate 可独立开关**（R2 HIGH-3）：

新 `packages/flywheel-comm/src/ship-eligibility.ts` `evaluateShipEligibility(args)` —— **CLI 与 Bridge 唯一共用入口**：
- `mergeApprovalOk = FLYWHEEL_MERGE_APPROVAL_GATE==0 || verifyApproval({...}).approved`（B 侧：approval+Codex，
  复用现有 `verifyApproval`，不造弱 helper）。
- `qaOk = FLYWHEEL_QA_DONE_GATE==0 || evaluateQaShipGate({...}).passed`（A 侧：qa_required 快照 + auto_qa_record）。
- 返回 `{eligible: mergeApprovalOk && qaOk, mergeApprovalOk, qaOk, reason}`。**两开关独立**：关 B 不放 A，关 A 不放 B。
- CLI `verify-approval` 命令 + Bridge 完成/终结表面都调**这一个**，参数一致 → 零分叉（R1 HIGH-2 / R2 HIGH-2）。

**关键调用时序（R2 HIGH-1，anti-regress 命脉）**：`verifyApproval` 要求 DB row 仍是 `approved_to_ship`，
但两 sink **先写 completed 再跑 finalization**。故 **必须在任何 status mutation 之前**算出
`ShipEligibilityDecision`，把**预算好的 decision** 传进 finalization —— `isPostApproveShipComplete`
**不再自己读 DB**，只收 `shipEligible: boolean`（+ reason）。W2 同理：先算 eligibility 再 `applyTransition(...,"completed")`。

### verifyApproval 精确复用（R2 HIGH-2）
`VerifyApprovalArgs = {execId, prHead, dbPath(=CommDB!), stateDbPath?, env?, codexDotenvPath?}`。Bridge 调法**写死**：
`verifyApproval({ execId: session.execution_id, prHead, dbPath: commDbPathForProject(session.project_name), stateDbPath: store.getDbPath() })`。
**生产不传 `env`**（传 `process.env` 会绕过 CLI 权威的 `~/.flywheel/.env` Codex-gate live-read；R2 HIGH-2）。
`env`/`codexDotenvPath` 仅测试用。import `from "flywheel-comm/verify-approval"`。

## flag / kill-switch 一览（独立）

| 半 | 行为 | 默认 | 独立紧急关 | live-read |
|----|------|------|-----------|-----------|
| C | brainstorm gate 全 issue enforce | absent config → enforce+`["brainstorm-exempt"]` | config `mode:"off"`/`audit_only` | config |
| B | merge→completed 需 mergeApprovalOk | ON | env `FLYWHEEL_MERGE_APPROVAL_GATE=0`（只放 B）| `.env` live（mirror Codex 门）|
| A | merge/Done 需 qaOk（qa_required 时）| ON | env `FLYWHEEL_QA_DONE_GATE=0`（只放 A）| `.env` live |

---

## C 半 — brainstorm 硬门扩到全 issue（R1 HIGH-1）

**R1 HIGH-1**：光翻常量不生效 —— runtime 判「config key 存在性」，absent→仍 off。

### 改点
1. **新 resolver** `packages/config/src/founder-ux-config.ts`
   `resolveEffectiveFounderUxConfig(raw?)`：absent → `{mode:"enforce", exempt_labels:["brainstorm-exempt"]}`；显式值透传。
2. `types.ts`：`FounderUxGateConfig` 加 `exempt_labels?: string[]`；`FOUNDER_UX_GATE_DEFAULT_MODE`→`"enforce"`（改注释「absent=enforce」）。
3. `ConfigLoader.ts:399-422`：校验 `exempt_labels`（string[] 小写规整）。
4. resolver 替换所有「config-key 存在性」判断：DirectEventSink snapshot（`:156-165`）、Blueprint（`:1127-1152`）、
   `runs-route.ts:561-564`、`claude-lead.sh:1785-1812`。
5. `founder-ux/trigger.ts:23-30`：默认 true，除非 `labels ∩ exempt_labels ≠ ∅`；fetch 失败 fail-closed=true；
   `founder-facing-ux` 保留 legacy always-in-scope 别名。
6. `Blueprint.ts:1141-1148` 文案改「every substantial issue MUST brainstorm & align before implement；仅豁免 label 跳过」；
   `founder-ux-rules.md` 重写；`registry.ts:1313` description 更新。

### TDD（C）
- resolver：absent→enforce+默认豁免；off/audit_only/enforce/custom exempt 透传。
- trigger：无 label→true；`brainstorm-exempt`→false；`founder-facing-ux`→true；fetch 失败→true。
- ConfigLoader exempt_labels 校验。**有意改**旧「absent=off」测试为「absent=enforce」（Blueprint/DirectEventSink/claude-lead.sh 三处）。
- stage-guard 集成：非豁免无 signoff → implement block。byte-compat：显式 `mode:"off"` → 完全旧行为。

---

## B 半 — merge 抢跑终点闸（fragile；R1 HIGH-2/3/4,MED-1/4；R2 HIGH-1/2/3/4/5,MED-*）

### B-1 预算 decision（R2 HIGH-1 时序）
每个 status-mapper 在 **status 写库之前** 调 `evaluateShipEligibility(...)` 得 `decision`。
merged + `decision.eligible` → completed；merged + **不** eligible → **merge_block 处置（B-3）**，不 completed。
`decision` 透传给 finalization（`isPostApproveShipComplete` 收 `shipEligible` boolean，**不读 DB**）。

### B-2 四表面同改 + 单终结闸（R1 HIGH-3 / R2 HIGH-4）
1. `DirectEventSink.ts` session_completed merged 分支（`:371/:381/:406`）——先算 decision。
2. `event-route.ts` session_completed 姊妹分支（`:1037/:1045`）——同。
3. `complete-marker-reconciler.ts` `expectedStatusFromMarker`（`:165-190`）+ `tryReconcileComplete`（`:308-362`）——
   **新增非终态 outcome「processed merge_block」**：replay 到不 eligible 时，写 durable merge_block claim +
   **删/settle marker**（不 quarantine-forever、不强推 completed/failed）；marker 类型扩带 `pr_head` 证据。
4. finalization 单闸 `post-ship-finalization.ts:isPostApproveShipComplete`：签名加 `shipEligible: boolean`，
   `landingStatus==merged && shipEligible` 才 true。W2（`event-route:1662-1795`）**在 applyTransition→completed 之前**算 eligibility。
   DirectEventSink `:687-718`、event-route `:1353-1384` 全传预算 decision。

### B-3 merge_block 处置（R1 HIGH-4，决定 ③ 不 revert）
- **持久 marker**（typed，非裸 awaiting_review）：session 新列 `merge_block_reason TEXT` +
  `merge_block_head TEXT` + `merge_block_at`（或 session_params fail-closed 解析；R2 MED-3 倾向 typed 列）。
  status 保持非终态。
- **suppressor**（认 marker）：auto-qa `onMainAwaitingReview`、GatePoller/review 投递、W2 finalization、
  complete-marker reconciler、Done finalization —— 全部跳过/特判。
- **recovery（R2 HIGH-5，双入口）**：同 head 正当批准落地后清 marker→completed→finalize once。
  hook 在 **两处 `approved_to_ship` flip 之后**：`actions.ts:approveExecution`（`:317-365`）+
  founder-reply `wiring.ts:buildGateResponsePostWriteHook`（`:121-151`）。检查 `merge_block_head===session.pr_head_sha`
  → 重算 `evaluateShipEligibility` → 清 marker → completed → finalize 一次。
- **durable 去重 alert（R1 MED-4）**：StateStore claim（key=execId+规整 head），claim 先于 async；
  alert 带 PR number + head + review_question_id + reason；事件 `merge_without_approval` 发 Annie。

### anti-regress（**显式回归**）
- 回归 1（FLY-120）：approved_to_ship + merged + needs_review → **pre-transition** eligibility=true → completed（不卡）；
  断言 verifyApproval 在 transition **之前**成功、**不**在 row 变 completed 后重跑。
- 回归 2（FLY-58）：durable 批准 + auto_approve + merged → completed。
- 新行为：merged 无批准 → merge_block + alert，不 completed/Done；`FLYWHEEL_MERGE_APPROVAL_GATE=0` → 退回旧短路（只放 B）。
- 四表面参数矩阵一致（`event-route-dual-session-completed` + `complete-marker-reconciler.integration` 模式）。

---

## A 半 — QA 该起没起 + 没过也 Done（R1 HIGH-5,MED-1/2/3,SCOPE；R2 HIGH-3,MED-1/2/3）

### A-1 QA gate（`evaluateQaShipGate`，独立开关）
- **qa_required 快照（typed 列，R2 MED-3）**：sessions 加 `qa_required INTEGER NULL` + `qa_required_reason TEXT NULL`
  （迁移 + 测试）。auto-qa-policy 首评（`onMainAwaitingReview`）时 spawn/skip 两路都持久化 `resolveAutoQaPolicy`
  的 verdict；config/label 事后改不翻旧快照。
- `evaluateQaShipGate(session, stateDbPath, prHead)`：
  - `FLYWHEEL_QA_DONE_GATE=0`（**`.env` live-read，mirror Codex 门；R2 MED-2**）→ passed。
  - `qa_required==0` → passed（no-code/纯 docs/no-qa label/qa.auto:false 的快照）。
  - `qa_required==1` → 查 `auto_qa_record`（execId/parent, prHead）`status=='passed'`，否则 `qa_not_passed`。
  - **快照 NULL（该起没起/pre-migration）** → route∈{no_code,pr_handoff}||无 PR → passed（豁免）；否则 fail-closed 需 QA。
- 纯 docs classifier = **label/route/config-based**（no-qa label || qa.auto:false || no-code route），非 path-diff；写死+测。
- registry 加 `FLYWHEEL_QA_DONE_GATE` 条目（direct-toggle 证明或标 restart-required；R2 MED-2）。

### A-1b qa_required in-flight backfill（R2 MED-1）
启动/reconcile 对现存 active（awaiting_review/approved_to_ship）session backfill：有匹配 `auto_qa_record`→`qa_required=1`；
no-code/pr_handoff/无 PR→`0`；code PR 无法重建→alert/hold（不静默放行）。测 pre-migration active（有/无 passed record）两例。

### A-2 codexHold 静默卡→响亮+超时升级（R1 MED-2；FLY-863 未在 main）
持久 `codex_hold_started_at`（首次 hold 写）；reconcile 按 age（>30min）→ **一次性**升级 alert（独立 eventId per exec/head，
不被初始 hold 去重吞），标 stuck。`onCodexReviewResult:548-563` 静默 drop 前 warn。

### A-3 「该起没起」兜底扫描（R1 MED-3，scoped）
挂已有 `reconcileOnStartup`/周期对账（**不新增 timer**）：扫「awaiting_review + main + 无 auto_qa_record + 无 hold +
未豁免 + **无 merge_block marker**」→ 补 spawn/hold。复用 `:349-365` review-evidence gate；尊重 QA 豁免+Codex；早跑（抢在 founder surfacing 前）。

### A-4 defer → FLY-863/864（显式 non-goals）
rebase-rebind(863)、boot-liveness retry(864)、手动 QA 纳入 —— 本 PR 不做；A-1/A-2/A-3 是 M1 不可拆。

### TDD（A）
- qa_required 快照：spawn/skip 两路持久化；事后改 config 不翻快照；backfill 两例。
- `evaluateQaShipGate`：passed→ok；required 无 record→`qa_not_passed`；快照 0→放行；NULL+no-code→放行；NULL+code→fail-closed；
  `FLYWHEEL_QA_DONE_GATE=0`→放行（**且 B 仍强制**：R2 HIGH-3 独立开关测试）。
- Done finalization：qa_required 无 pass→不 markIssueDone；豁免→放行。
- codexHold：age 超阈→一次性升级 alert+stuck；drop→warn。
- 兜底扫描：orphan（无 record 无 hold 未豁免）→spawn/hold；**排除 merge_block**。

---

## 实现顺序（TDD）
1. C（独立）：resolver+config+trigger+4 消费点+prompt+doc。
2. Schema/迁移：`qa_required`/`qa_required_reason`/`merge_block_*`/`codex_hold_started_at` 列 + 迁移测试。
3. `evaluateShipEligibility` + `evaluateQaShipGate`（flywheel-comm，含 verifyApproval 复用）+ 单测（含独立开关）。
4. B（fragile，先回归）：四表面 pre-transition decision + isPostApproveShipComplete 收 shipEligible + merge_block marker/suppressor/recovery 双入口/去重 alert。
5. A-1 QA gate 进 evaluateShipEligibility（依赖快照）+ A-1b backfill → A-2 codexHold → A-3 兜底扫描。
6. 全仓 `pnpm lint` + 相关 `pnpm test`。7. Codex code review → PR → approve gate（stop, founder-gated）。

## 全链真机 E2E（决定 ⑤，QA session 验）
真 issue：非豁免→brainstorm 门→Annie OK→implement→code review→auto-QA→PASS→founder 批→才 merge+Done。
负例：非豁免未签→implement block；merged 未批准→merge_block+alert 不 Done；qa_required 无 pass→拒。

## R1/R2 findings 处置总表
- R1 HIGH-1 enforce 接线 → resolver 收口 ✅ / HIGH-2 弱 helper → 复用 verifyApproval ✅ /
  HIGH-3 漏表面 → 四表面+单闸 ✅ / HIGH-4 裸 awaiting_review → merge_block marker ✅ / HIGH-5 QA 豁免不可读 → qa_required 快照 ✅
- R2 HIGH-1 时序 → **pre-transition 预算 decision，finalization 不重读** ✅ / HIGH-2 精确 args+不传 env ✅ /
  HIGH-3 独立开关 → evaluateShipEligibility 拆 mergeApprovalOk/qaOk ✅ / HIGH-4 complete-marker 非终态 outcome ✅ /
  HIGH-5 recovery 双入口 ✅ / MED-1 backfill ✅ / MED-2 QA 开关 .env live-read ✅ / MED-3 typed 列 ✅
