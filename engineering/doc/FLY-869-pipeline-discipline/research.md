# FLY-869 流水线纪律收口 — 调研

Issue: FLY-869 (https://linear.app/geoforge3d/issue/FLY-869/infrapipelineconsolidated-流水线纪律收口-qa-该起没起原-868-merge-抢跑提前)
日期: 2026-07-04
基于: exploration.md

> 分支 `flywheel-FLY-869`。所有行号为审计当时值，实现时以 grep 复核为准。

## C 半 — brainstorm 硬门（founder-ux gate）现状

FLY-598 / PR #369 的门叫 `founder_ux_gate`，几乎全在
`packages/teamlead/src/bridge/founder-ux/` + CLI `packages/flywheel-comm/src/commands/founder-ux.ts`。
**两层 fail-closed**：Runner 侧硬停（`await-founder-ux-gate`）+ Bridge 侧 stage guard，
都只认 per-session 布尔 `founder_facing_ux`。

### 触发（唯一的「只 scope UX」判定）
- `founder-ux/trigger.ts:17` `FOUNDER_FACING_UX_LABEL = "founder-facing-ux"`
- `trigger.ts:23-30` `resolveFounderFacingUx(normalizedLabels, labelsFetchFailed)`：
  仅当 issue 带 `founder-facing-ux` label **或** label fetch 失败（fail-closed）→ true。
  **这一个函数是整个「只 scope UX」的开关。** 无 Haiku 分类器（`trigger.ts:1-14` 明说）。
- 调用点：`runs-route.ts:561-564`（算 `founderFacingUx`）→ `:686` 持久化
  `founder_facing_ux` 到 session 行。label 快照语义同 `codex-skip`（`runs-route.ts:547`）。

### 验签（服务端不可伪造 + fail-closed）——**一个字不改**
- `founder-ux/verify.ts:60-145` `verifyAndRecordFounderUxSignoff`：三查 ——
  (a) thread 绑定 `:107-113`（Annie 的 msgId 必须在这 issue 的注册 Discord thread，服务端 fetch）
  (b) founder 身份 `:116-121`（`msg.authorId === deps.founderUserId`，Lead 伪造不了）
  (c) 新鲜度 `:124-131`（48h）。全 fail-closed。
- `founder-ux/signoff.ts:50-58` `signoffSatisfies`：verified signoff 存在 **且** 匹配当前 `uxHash`。
- `founder-ux/routes.ts`：`GET /api/founder-ux/status`（ingest token）读；
  `POST /api/founder-ux/signoff`（apiToken，与 ingest token 冲突则 503）privileged 写 ——
  这使 Runner 写不了 signoff。
- `founder-ux/stage-guard.ts:37-67` `evaluateFounderUxStageGuard`：键在
  `session.founder_facing_ux`（`:54` `if (!session?.founder_facing_ux) return {decision:"pass"}`）。
  `stage_changed→implement` 无匹配 signoff → enforce=block / audit_only=log。
  接线 `event-route.ts:1553-1589`（409 before persist）。
- Runner 硬停：`founder-ux.ts:231-293` `awaitFounderUxGate` 轮询 status，approved 才
  `exit(0)`，否则 fail-closed `exit(1)`。

### Config
- `packages/config/src/types.ts:264-285`：`FounderUxGateMode = "off"|"audit_only"|"enforce"`，
  **`FOUNDER_UX_GATE_DEFAULT_MODE = "off"`**（← Annie 决定 ② 要改成 enforce）。
- `ConfigLoader.ts:399-419` 校验；`feature-flags/registry.ts:1303-1323` 注册
  （`configKey: "founder_ux_gate.mode"`, `toggleable: "readonly"`）。
- StateStore 列：`StateStore.ts:1031-1054`（`founder_facing_ux` / `founder_ux_signoff_json`
  / `founder_ux_gate_mode`），读回 `:4128-4133`。
- Prompt 注入：`edge-worker/src/Blueprint.ts:1120-1152`（mode≠off 才注入），文案
  `:1141` 「If this run IS founder-facing UX…」（要改成「every substantial issue」）。
- Lead 指南：`packages/teamlead/lead-rules-base/founder-ux-rules.md`（要重写）。

### C 半改点（扩面 = 只改「谁触发」）
1. `trigger.ts:23-30` `resolveFounderFacingUx`：**从 opt-in 翻成 default-on except 豁免**。
2. 豁免 config（model on `codex-skip`）：`FounderUxGateConfig` 加 `exempt_labels`
   （`types.ts:282` + `ConfigLoader.ts:399` 校验）；默认 `["brainstorm-exempt"]`。
3. `runs-route.ts:561-564` 调用点：传豁免 labels/config。
4. `types.ts:264` `FOUNDER_UX_GATE_DEFAULT_MODE` → `"enforce"`（决定 ②）。
5. `Blueprint.ts:1141-1148` prompt 文案改「所有实质 issue 必须先跟 Annie brainstorm」。
6. `founder-ux-rules.md` 重写为「默认全 gate，仅豁免 label 跳过」。
7. `registry.ts:1313` description 更新。
- **无需改**：verify.ts / signoff.ts / routes.ts / stage-guard.ts / awaitFounderUxGate /
  StateStore 列（都已只认 per-session flag）。

## B 半 — merge 抢跑（终点闸）现状

`merged→completed` 短路同时在两个姊妹 sink：
- `DirectEventSink.ts`（in-process）：`needs_review` 分支 `:371-378`、`auto_approve` `:381-388`、
  自然完成 `:406`。`isPostApproveShip = status==="approved_to_ship" && !desPhase2Bound`（`:345-347`）。
- `event-route.ts`（HTTP /events）：`needs_review` `:1037-1044`、`auto_approve` `:1045-1054`。
  `isPostApproveShip = existingSession?.status === "approved_to_ship"`（`:936-937`）。

两处逻辑一致：`if (landingStatus?.status === "merged") status = "completed";`
—— **只看 landing 已 merge 就标 completed，没验批准**。这是抢跑漏洞。

### 可复用的 durable 批准判定（anti-regress 基石）
`verify-approval.ts` 不信内存 status，读 durable：
- `:218` `SELECT status, pr_head_sha, review_question_id, codex_skip FROM sessions`
- `:247-255` `review_question_id` 必须存在且非 `"unbound"`
- `:263-267` CommDB 里那条 bound question 必须存在、是 `approve_to_ship` gate、被答过（批准）。

→ B 半新增 Bridge 侧 helper `hasVerifiedMergeApproval(session, commDbPath)`，镜像
verify-approval 的 durable 查询（review_question_id + CommDB approve_to_ship answered）。
`merged→completed` 改为：`isPostApproveShip || hasVerifiedMergeApproval` 才 completed；
否则 = merged-but-unapproved → **不 finalize、留 open、响亮 alert**。

### 怎么不 regress「批准后已 merge 卡 awaiting_review」（FLY-115 v1.24.5 / FLY-120）
那个正当流程：founder 批 approve_to_ship gate → runner 才自 merge → session_completed。
此时 `status === "approved_to_ship"`（`isPostApproveShip === true`）**且** durable 批准记录存在。
→ 新闸的两个条件**都**满足 → 照样 `completed`，零 regression。
新闸只卡「merged 但 `isPostApproveShip=false` **且** 查不到 durable 批准」——正好是抢跑。

### Done finalize 链（B/A 共用的终点）
- `DirectEventSink.ts:687-718` merged→completed 后 `runPostShipFinalization`→`markIssueDone`。
- 姊妹：`event-route.ts:1365 / :1739`（`markIssueDone :1383/:1761`）。
- `post-ship-finalization.ts:63-82` `isPostApproveShipComplete`：只 gate
  `landingStatus==merged` + (approved_to_ship|auto_approve|needs_review)，**无 QA 检查**。
- `linear-issue-finalizer.ts:43` `markLinearIssueDone`：无 QA 检查；kill-switch
  `FLYWHEEL_AUTO_LINEAR_DONE=0`（FLY-799）。

## A 半 — QA 该起没起 + 没过也 Done 现状

### auto-QA 触发（FLY-579）
`auto-qa-coordinator.ts`：`onMainAwaitingReview :263` 是唯一 live 触发，只在
`session_completed` 事件（`event-route.ts:1929-1937` / `DirectEventSink.ts:622-644`）跑。
gate 链：role==main → status==awaiting_review → gate①never-QA-a-QA → **fail-closed 缺
pr_head_sha `:316-328`** → **FLY-827 Codex 硬门 `:336-339`（未过→codexHold return，不 spawn）**
→ policy → gate② review evidence `:357-365` → gate③ one-issue-one-QA → 原子 claim → `spawnQa`。
config key `qa.auto`（`types.ts:208` / `ConfigLoader.ts:361` / `registry.ts:1205`），FLY-752
改成 opt-out 默认 ON；policy `auto-qa-policy.ts:38`（kill-switch `FLYWHEEL_AUTO_QA=0` →
`no-qa` label → qa.auto:false → skip_labels → 默认 ON）。

### A 半的洞
1. **该起没起（结构洞）**：没有兜底扫描去发现「awaiting_review + 无 auto_qa_record + 无 hold」
   的 main session。`reconcileOnStartup :1088` 只 re-drive 已 claim 的 record，从不为「从未 claim」
   补 spawn。coordinator 若 wiring 失败（`plugin.ts:3816-3819`）本次 boot auto-QA 全禁、无 hold。
2. **Codex verdict 静默卡**：`await-codex-gate.ts:254` 明说「delivery failure never fails the
   local gate」；`emitCodexReviewResult` 丢了 → Bridge 永不 record approval → 永久 codex-held →
   QA 永不 spawn，且只有一次 rate-limited alert（`reconcileCodexHolds :1051` 重发同一条）。
   `onCodexReviewResult :548-563` 内容稍偏就静默 drop。
3. **QA boot 死无重试**：`spawnQa` 抛错 `:854-868` 标 stuck 无重试；spawn 成功但 QA 秒死
   `:1200-1219` 标 stuck 从不 re-spawn；`spawnQa` 不校验 pane 真起来（`started-evidence.ts`
   `checkStartedEvidence` 未被 auto-QA 用）。
4. **rebase 换 head 绑定失效**：`pr_head_sha` 只在 `event-route.ts:1132-1138` /
   `DirectEventSink.ts:579-586`（都需 session_completed）更新。rebase/force-push 不伴随
   re-complete → record 仍绑旧 head → QA 验旧 head 却 freshness 校验反而通过 → founder 被 surface。
   无 PR-head watcher（FLY-210 只是清理占位）。
5. **手动 QA issue 不纳入**：手动建的 QA issue 上是 main role，不挂任何 parent 的
   `auto_qa_record`；发 qa-result 会被 `onQaResult :917` 拒（非 QA session）。

### 终点缺 QA 门（核心洞）
`verify-approval.ts:340-356` 有 Codex 硬门（`codexApprovedForHead`）**却无 QA 门** ——
没查 `auto_qa_record.status == 'passed'`。`isPostApproveShipComplete` / `markIssueDone`
也都不查 QA。→ 只要 auto-QA 该起没起 / auto_approve 自 merge / QA stuck 但 founder 别处批了，
issue 都会 merge 翻 Done 而 QA 从没 pass。

### A 半改点
1. **终点 QA 硬门**（与 Codex 门对称，fail-closed）：
   - `verify-approval.ts:340-356` 后加 QA-passed 检查（同 readonly 连接查
     `auto_qa_record` for (execId, prHead) status=='passed'；reason 加 `qa_not_passed`）。
   - `post-ship-finalization.ts:isPostApproveShipComplete` 或
     `linear-issue-finalizer.ts:makeLinearDoneFinalizer` 加 QA-passed 前置。
   - **豁免口**（Annie 决定 ④）：纯 docs / no-code route / `no-qa` label / `qa.auto:false` /
     `FLYWHEEL_AUTO_QA=0` → 复用 `auto-qa-policy` 的信号，QA 门不卡。
2. **起点补触发洞**：兜底扫描「awaiting_review + 无 record + 无 hold」；codexHold 超时→stuck+
   响亮 alert；QA boot 有界重试；rebase 重绑；手动 QA issue 纳入。

## 未决技术问题（design_review 要 Codex 帮压）
- B 半 helper `hasVerifiedMergeApproval` 放哪个 package 最合适（teamlead 侧需读 CommDB；
  verify-approval 在 flywheel-comm）？→ 倾向 teamlead 侧新 helper 直接读 CommDB（不跨包依赖 CLI）。
- A 半 QA 门 fail-closed 与「auto-QA 该起没起」的相互作用：无 record 时终点 fail-closed
  会不会把「本该 QA 但触发洞漏了」的 issue 卡死在 founder gate？→ 这是**期望行为**（宁卡勿漏），
  但要保证豁免口能让正当 no-code/docs issue 通过。
- A 半触发洞（兜底扫描 / rebase 重绑 / 手动 QA 纳入）范围可能偏大，需确认哪些是 M1 必须、
  哪些可拆 follow-up —— 但**终点 QA 硬门 + codexHold 响亮化**是 M1 核心，不可拆。
