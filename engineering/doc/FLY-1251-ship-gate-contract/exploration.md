# FLY-1251 ship-gate 契约落地（R1-R9 主通道 A）— 探索

Issue: FLY-1251 (https://linear.app/geoforge3d/issue/FLY-1251/build-fly-1211-ship-gate-契约落地-founder-approval-绑定根治r1-r9主通道-a)
日期: 2026-07-14
基于: 无（上游 = `product/doc/FLY-1211-founder-approval-binding/prd.md` v6，权威契约，本单不重开产品讨论）

---

## 1. 任务是什么

把 FLY-1211 PRD §5 的 ship-gate 契约（R1-R9）在主通道 A（founder 点最新 active 卡的 ✅）上工程落地。PRD 定契约/不变量/失败可观测结果；本单（+ 切片出的子单）交机制。

**最小验收（issue 原文）**：2026-07-14 flag 批事故的形状——code PR 以 no-three-stage 派发 → 零 QA 节点 → approve 卡照开——在新闸下**机械不可能**（无 QA 证据 → 卡拒开）。

## 2. 今天事故的机械链（生产 DB 实证，2026-07-14）

flag 批（FLY-1240/1241/1242/1243/1245，PR #584/#585/#588/#589/#590）：

1. 五个 issue 带 `["no-three-stage","flywheel"]` label →（`resolveThreeStagePolicy`，`three-stage-policy.ts:73`）单 session 派发，**零 QA phase 节点**（sessions 表实查：五行全部 `session_role='main'`）。
2. session 进 awaiting_review → `AutoQaCoordinator.onMainAwaitingReview`（`auto-qa-coordinator.ts:310`）评 policy → 当时 `FLYWHEEL_AUTO_QA=0` 生效 → `setQaRequiredSnapshot({required:0})`。**生产 DB 铁证**：五行 `qa_required_reason` 全部 = `policy_off:FLYWHEEL_AUTO_QA=0 global kill-switch`；**今天查生产 `~/.flywheel/.env` 该行已删**，但 snapshot 是 write-once（`StateStore.setQaRequiredSnapshot`，`UPDATE … WHERE qa_required IS NULL`）——运维开关的瞬时状态被固化成永久 ship 豁免。
3. `auto_qa_record` 对这五个 execution **0 条**（实查 count=0）。
4. merge 闸 `evaluateQaShipGate`（`packages/flywheel-comm/src/ship-eligibility.ts:182`）：`qa_required=0` → `qa_not_required` → **放行**。
5. 发卡闸：GatePoller 主循环 `isReviewHeld`（`gate-poller.ts:706-711`）→ `isQaHeld`（`auto-qa-held.ts:143`）**无 record → 不 hold**（byte-compat 设计：「a session with NO matching record is never held」）→ 过 15s grace（`shipGateCardGraceMs`）→ `maybeEmitFounderThreadFallback`（`gate-poller.ts:2131`）照发 approve 卡。
6. Lead 报「到批准门口」→ Annie 三连问才暴露零 QA。

**病理（PRD §2 的替身模式）**：两个各自「合法」的局部决定（运维关全局 auto-QA + Lead 派 no-three-stage）组合成一条零 QA 的 ship 通道，没有任何 run 级 barrier 汇总检查「这个 run 到底有没有人测过」。更精确：`FLYWHEEL_AUTO_QA=0` 的本意是「别自动 spawn QA runner」（资源/运维动作），却被 ship 闸消费成「这个 PR 不需要 QA 证据」（安全豁免）——**两个语义共用一个布尔**，且以 write-once snapshot 固化。`qa_required=0` 这个**政策标签**站在了「QA 证据存在」这个**事实**的位置上。

## 3. 现状机制盘点（源码核查）

### 3.1 发卡侧（founder 卡什么时候出现）

- 现有唯一的发卡前 hold = `reviewHoldReason`（`auto-qa-held.ts:92`）：`merge_block` → `codex_pending` → `qa_not_green`，被四个 founder 面（event-route always-deliver / GatePoller approve relay / HeartbeatService gate_timed_out / DirectEventSink push）共同消费。
- `qa_not_green` 只在**有 AutoQaRecord 且非 passed** 时成立（`isQaHeld`, auto-qa-held.ts:143-157）——**没有 record = 不 hold**。这是 R1「卡只在 readiness 之后 active」缺失的精确形状。
- `founderApprovalHoldGuard`（auto-qa-held.ts:134）带 `FLYWHEEL_ATTRIBUTION_HOLD_ALIGN=0` 静默旁路 = PRD R8 点名要删/响亮化的那个 env 后门。

### 3.2 merge 侧（verify-approval / ship-eligibility）

- `verifyApproval`（`flywheel-comm/src/commands/verify-approval.ts:176`）：绑定 `review_question_id` + 结构化 `{approved:true}` + founder attribution + `status='approved_to_ship'` + **raw `pr_head_sha` 精确相等**（R4 说的替身：sha 相等冒充「内容没变」）+ FLY-827 cross-family codex gate。
- `evaluateShipEligibility`（ship-eligibility.ts:234）= B（merge approval）∧ A（QA gate），两个独立 kill-switch（`FLYWHEEL_MERGE_APPROVAL_GATE` / `FLYWHEEL_QA_DONE_GATE`，live-`.env`）。
- A 侧 `evaluateQaShipGate` 的 `qa_required` 三态：1=要 record、0=豁免直放、NULL=code PR fail-closed / no-code 豁免。**0 的豁免来源不区分「docs-only 事实」和「政策标签」**。

### 3.3 claims substrate（FLY-1232，已在生产）

生产 teamlead.db 已有 7 张 workflow 表：`workflow_run` / `workflow_run_node` / `workflow_run_event` / `workflow_decision_capability` / `workflow_claims` / `workflow_claim_revocation` / `workflow_side_effect_ledger`（全 default-off，shadow 写路径）。

### 3.4 FLY-1244（并行在飞，design 定稿 / implement 0/5）交付什么

读 `flywheel-FLY-1244/engineering/doc/FLY-1244-enforcement-claims-templates/plan.md`（Codex 6 轮 APPROVED）：

- **commit A** = founder guard 收口：`writeFounderApproval` 单一写入原语（text/reaction/voice/actions/founder-consent/deferred 全路由经它）+ `founder_approved` claim 唯一写者 = projector + USE-time challenge 绑定 → **这就是 R8 的主体**。
- **commit B** = `qa_passed` head-bound server-captured claim + per-execution submission credential + enrollment + `evaluateQaShipGate` read-switch 真值表（(c) 非三段式=字节兼容旧布尔；(e) durable 三段式无 enrollment=fail-closed）+ **单一 head-authority resolver 贯穿提交面与所有 ship sink**（含 verify-approval CLI 改走 Bridge endpoint）→ **R2 的账本地基 + R4 的 head 权威半步**。
- **commit C** = 模板 schema/发布/三种子 manifest（QA 一等节点任何档不省）+ `manifestReviewFamilyOk`（resolved-family 比较器）→ **R3/R5/R6 的模板侧地基**。
- 1244 明确 defer：review claim 生产（子单 D）、claim-driven orchestration（子单 D）、peer-cred broker（READ 上生产硬前置）。

### 3.5 咬合边界（消费/复用，冲突处以 1211 PRD 为准）

| 1251 需要 | 来源 | 关系 |
|---|---|---|
| `qa_passed` head-bound claim | 1244 commit B | **消费**，不重造 |
| `founder_approved` claim + 单一 approval authority | 1244 commit A | **消费**（= R8 主体已被 1244 吃掉） |
| 单一 head-authority resolver | 1244 commit B §4.3b | **消费** |
| 非三段式 code-PR 的 QA 证据要求 | 无人做 | **1251 的核心增量**（1244 真值表 (c) 承诺字节兼容——1251 是对 (c) 域的有意行为改变，正交于 1244 的 merge 闸改动：1251 止血片动的是**发卡时点**） |
| 卡状态机（R1）/ stale 点击回应（R9） | 无人做 | **1251 增量** |
| canonical ship_subject（R4 全量内容锚） | 无人做 | **1251 增量**（大件，切片） |
| freeze_epoch + mutation lease（R7） | 无人做 | **1251 增量** |
| 闸门 vendor 泛化（R5）+ 豁免权限（R6） | 1244 部分（家族比较器/种子） | 1251 补 gate 侧泛化 |

## 4. 发卡链审计（Bridge 侧，源码核查）

### 4.1 卡的物理形态与发送链

- 卡 = issue thread 里的 founder Discord 消息：`emitFounderThreadNotification` → `postFounderThreadCore`（`founder-thread-notifier.ts:264`），唯一调用点 `GatePoller.maybeEmitFounderThreadFallback`（`gate-poller.ts:2131`）。
- 发送前 predicate 顺序：notify-enabled → chatThreads → checkpoint ∈ {brainstorm, approve_to_ship} → session ACTIVE → matchesLead → 15s grace → per-question dedup（in-proc + durable marker `founder-thread-notify-<qid>`）→ thread/botToken/ownerUserId 解析。
- `isReviewHeld` 检查在主 poll 循环**上游**（`gate-poller.ts:706-711`），held 时同时跳过 relayToLead 和发卡；卡片方法自身不复查（依赖上游 skip 的注释在 `:2088-2091`）。

### 4.2 老卡的命运（R1 空档的精确画像）

- head 漂移/re-review 时：旧 gate 的 **CommDB 行**被 `retireShipGate` 退休（`event-route.ts:1167-1211` 主路径 + `gate-poller.ts:1990` backstop），**纯 SQL expire，零 Discord 副作用**。
- **旧 Discord 卡永不 edit/delete**——全代码库对 founder 卡无任何 editMessage/deleteMessage。旧卡视觉上仍可点。
- rebind 路径 `AutoQaCoordinator.tryShipGateRebind`（`auto-qa-coordinator.ts:1365`；触发 = QA PASS 证据 commit 同分支前移 head 且 gate 未答）**又发一张物理卡**（`notifyShipGateRebound` + `ensureRebindAnchor:1509`），旧卡不删——一个 run 的 thread 里可并存多张可点历史卡。
- 发卡去重 = **per-question-id**，不是 per-run/epoch。**没有卡状态机、没有 at-most-one-active 强制、没有 retired-message-id 观测。**

### 4.3 stale 点击的命运（R9 空档的精确画像）

静默 no-op，多层吞、零 founder 反馈：
1. reaction pass 只扫**当前 pending** 的 approve_to_ship gate（`gate-poller.ts:3278-3280`）——retired question 不 pending → 旧卡上的 ✅ **根本不被读**。
2. 即便旧 question 仍 pending：`tryFounderReactionApproval` 因 `session.review_question_id !== 旧 qid` return null（`founder-reaction-approval-handler.ts:82-87`），或 `selectCurrentBinding` 非唯一匹配 return null（`gate-message-binding.ts:53-62`）。
3. 全链路没有任何「这张已过期，活卡在这里」的回复。

### 4.4 founder approval 写入面清单（R8 现状；1244 commit A 正在收口）

| 入口 | 位置 | 备注 |
|---|---|---|
| `approveExecution`（POST /api/actions/approve） | `actions.ts:306` | **直写** insertResponse，零 hold 检查（PRD R8 点名） |
| gate-response-router（off 模式 pass-through / enforce） | `founder-consent/gate-response-router.ts:289/:367` | **直写** |
| 共享原语 `writeGateResponseAndRunPostWrite` | `approval-signal/write-gate-response.ts:155` | reaction / text / voice / deferred replay 四面经它 |
| CLI `respond` | `flywheel-comm/commands/respond.ts:81/:119` | approve_to_ship 已改道 router |

1244 commit A = 把两条直写路由进增强版共享 writer（`writeFounderApproval`）→ R8 主体归 1244，1251 不重复。

### 4.5 substrate/证据侧补充事实

- 三段 QA verdict 走 `qa-result` → `session_params.three_stage_verdict`（`phase-orchestrator.ts:977`），**不写 auto_qa_record、不写 claims**——三段式 run 的 QA 证据在 durable 层只有 session_params 一处（1244 commit B 会补 claim 生产）。
- `sessions` 无 `workflow_run_id` 直连列；execution↔run 归属靠 `workflow_side_effect_ledger ∪ workflow_run_event` 派生（`StateStore.ts:10113`）。
- `FLYWHEEL_WORKFLOW_CLAIMS_READ` / `FLYWHEEL_WORKFLOW_FORCE_LEGACY` 在当前树只有定义、无生产读点（读切换全归 1244）。
- `auto_qa_record` 状态机：running / awaiting_retest / passed / failed / superseded / stuck（PK = parent_execution_id + head，head 变即新行）。

## 5. 切片方向（brainstorm 结论，待 Lead 拍板）

PRD §10 明说不要 R1-R9 一对一拆单。本单 design 覆盖全契约的机制设计，implement 段按依赖切片交付；量力边界明确划出 defer 子单。倾向：

1. **Slice 1（止血，先行独立 PR）— R2 最小机械版 + R8 余量**：
   - 新 hold 原因 `qa_evidence_missing`，落点 = `reviewHoldReason`（`auto-qa-held.ts:92`）：main/implement session、awaiting_review、有 PR、**diff 含非 docs 文件（server 端客观计算，不认 label）** 而无「当前 head 的 QA 证据」（auto_qa_record passed **或** enrolled run 的 `qa_passed` claim）→ 卡不发 + Lead 收到显式运营原因。**杠杆点：四个 founder 面（GatePoller relay / event-route always-deliver / HeartbeatService / DirectEventSink）已共同消费这一个谓词——改一处，全部面同步收口。**
   - 豁免的合法来源收紧到「server 算出的 docs-only」+「受信 canonical policy 的显式豁免（qa.auto:false / skip_labels，快照进 run、卡上可见）」——**运维 env kill-switch（FLYWHEEL_AUTO_QA=0）不再是 ship 豁免来源**（它只该关「自动 spawn QA」这个动作，不该关「ship 要 QA 证据」这个事实要求——语义拆开）。
   - 必须配一条**人肉/独立 QA 的证据登记路**（Lead 手动 dispatch 的 QA PASS 能落 durable 证据，否则止血片会把合法的人肉 QA 流程也卡死）。
   - 删 `FLYWHEEL_ATTRIBUTION_HOLD_ALIGN=0` 静默旁路（R8 收尾，1244 不覆盖这条；`auto-qa-held.ts:139`）。
   - 三段式 run 不受此片误伤：其 approve gate 由 QA phase session（role=qa）持有，`isReviewableRole` 只认 main/implement。
2. **Slice 2 — R1 卡状态机 + R9 回应契约**：耐久卡状态机（posting→active→retiring→retired）+ at-most-one-active 约束 + retired message-id 观测回应 stale 点击 + 通道中断 retire/block + 文字批准指向 active 卡。
3. **Slice 3 — R4 ship_subject + R7 freeze_epoch**：内容锚 schema + 干净 rebase 携带 + freeze_epoch mutation lease。依赖 R1/R2 落地后的 gate epoch 概念，最后做；先 shadow-compare。
4. **R5/R6 泛化**（codex-gate 认 qa 角色产出、任意 vendor 政策、无合格 reviewer 顶住）随 Slice 2/3 带，或 defer 至 1244 子单 D 汇合。

## 6. 关键设计问题（research 阶段要核死）

1. 「QA 证据」在双轨期的定义与优先序：auto_qa_record passed（auto-QA 轨）/ `session_params.three_stage_verdict`（三段轨——不需要，qa session 持卡天然豁免？还是也要 durable 化？）/ `qa_passed` claim（1244 轨）——以及**人肉独立 QA 的登记路**（现在 Lead 手动 dispatch 的 QA PASS 落在哪，能否被 hold 谓词看见）。
2. docs-only 的 server 端客观判定放哪（Bridge 算 diff？complete 时算？merge 前再算一次？用什么 allowlist？）——绝不信 runner/label 自报；与 `evaluateQaShipGate` NULL 分支的 `pr_number == null` 豁免的关系。
3. merge 闸侧要不要同步收紧：止血片只堵发卡面，`evaluateQaShipGate` 的 `qa_required=0 → qa_not_required` 放行仍在（万一卡以别的路径开出来，merge 还是会过）。纵深防御要求两侧都收；但 merge 侧动 = 碰 1244 正在改的 `ship-eligibility.ts` → 冲突面。定切法。
4. 卡状态机的存储形态（复用 session_event 的 `ship_gate_msg_binding` write-once 模式扩展，还是新表）+ Discord 消息编辑/删除策略（edit 成「已过期」置灰 vs 删除 vs 只回 reaction）+ retired message-id 的观测窗口。
5. stale 点击回应的实现面：reaction pass 现在只扫 pending gate（`gate-poller.ts:3278`）——要回应 stale 点击就得扫 retired binding 的 message-id 集合，扫描成本与窗口。
6. R7 freeze_epoch 最小形态：`progress` 命令现已「session 非 running 就拒绝」；readiness→卡激活→授权完成这段的其它第一方 writer 还有谁（qa evidence commit？doc commit？）。
7. 与 1244 implement 并行的合并顺序风险：1244 动 `ship-eligibility.ts` / `write-gate-response.ts` / `StateStore.ts` / `actions.ts`；1251 止血片改动尽量落在 `auto-qa-held.ts` / `gate-poller.ts` / 新文件，减少 rebase 冲突；merge 闸收紧若必须动 `ship-eligibility.ts`，排在 1244 落地后。

## 7. 结论

方向：**先把「发卡」变成一个有 readiness barrier 的门（止血），再给卡一个生命周期（根治尸体卡），最后换内容锚（根治重审税）**。R8 主体交给 1244，不重复造；R2 的账本证据消费 1244 的 `qa_passed` claim 但不等它——止血片用现有 auto_qa_record 也能立即成立，claim 到位后作为第二证据源并入。
