# FLY-2152 判决投递与巡检闭环 — 调研
Issue: FLY-2152 (https://linear.app/geoforge3d/issue/FLY-2152/巡检缺口-判决层不在巡检清单verdict-落库但无人推送静默压单2139-三小时无人动)
日期: 2026-08-29
基于: exploration.md

## 当前写入链

- `packages/teamlead/src/bridge/workflow-decision-routes.ts` 的 `POST /api/workflow/decision`
  先解析 credential、server-owned head 与 predicate，再调用
  `StateStore.submitWorkflowDecisionByCredential()`。
- `packages/teamlead/src/StateStore.ts` 在一个 transaction 内写
  `workflow_decision_capability`、`workflow_claims`、credential consumption、`claim_written`
  run event，并提交 engine transition。它已经接收 `alertIdentity`，因此事务内拥有当前 run 的
  `leadId/projectName`，无需相信 Runner 提供收件人。
- route 成功后只写普通 `events` 表的 `workflow_decision`/`qa_result`，没有 `lead_events`，所以
  Lead runtime 不会收到任何东西。CLI 的成功日志仅回显 claim id/server seq。

## 可复用的投递设施

- `StateStore.appendLeadEvent()` 以 `(lead_id,event_id)` 去重；在外层 DB transaction 中调用可与
  claim 原子提交。
- `leadEventEnvelopeFromJournalRow()` 从 durable journal 重建 envelope；
  `RuntimeRegistry.enqueueLeadEvent()` 进入 canonical mailbox queue。
- `RETRYABLE_LEAD_EVENT_TYPES` 已没有运行时消费者，不能作为恢复机制。现役 journal redrive 位于
  `LeadInboxRuntime.admit()`，目前只扫描 `workflow_replacement_eligibility`；本单应把这个定向扫描
  泛化为 claim + replacement 两类，而不是复活已删除的 chase watchdog。
- `hook-payload.ts` 已提供 mailbox/CommDB 共用 renderer 的先例（如
  `formatStuckEscalation`、`formatMisroutedReport`），新事件应沿用 parity-by-construction。

## 当前巡检链

- `scripts/lead-patrol-snapshot.sh` 生成六步报告：名册、pane、TURN、投递/receipt、外部真相、处置。
  Step 4 的 `verdict_candidates` 只查 PR binding 与有效 pass claim 的 head mismatch，不查 claim
  是否有 Lead 投递，因此 FLY-2139 同形会全绿。
- owner attribution 已封装为 SQL CTE：execution 精确归属 → current issue cohort → latest historical
  cohort；任何不完整/歧义会 fail closed 且不输出外部 Lead 标识。Step 4 新判决查询必须复用它。
- `packages/teamlead/lead-rules-base/runner-patrol-rules.md` 明确 snapshot 只是候选骨架，Lead 必须把每步
  定稿为 `OK | FINDING | UNAVAILABLE(...)`。新增维度应保持这个合同并汇入 Step 4 candidate；Step 6
  与 A/B 处置继续作为所有 finding 的完成合同。

### 六步兼容轴

- `~/.flywheel/bin/flywheel-patrol-snapshot` 由 `converge-flywheel-bin.sh` 建成指向主仓
  `scripts/lead-patrol-snapshot.sh` 的 symlink；`update-flywheel.sh` 先 `merge --ff-only`，再调用
  `restart-services.sh`。因此 checkout 前移后脚本字节立即变化，而运行中的 Lead prompt 要等各自
  restart 才变化，不能证明 producer/consumer 零窗口原子切换。
- 结论：不做 6→7，也不复用 Step 6。判决事实进入原本就负责 delivery/verdict consistency 的
  Step 4，Step 6 的 disposition/Linear Epic bookkeeping byte-compatible 保留。`^STEP [1-6]`、
  `FINAL_STEP_COUNT=6` 与 finding validator 完全不改，部署前后 prompt 都消费六行。

## QA 合同现状

- generalized workflow 有 credential 时的通用 prompt 只要求执行一个 `qa-result` terminal action。
- legacy DAG QA prompt 的 PASS、FAIL 与 founder-feedback kickback 三条路径都执行 `qa-result`，但随后
  分别直接开 gate、park 或 wait，没有 `ask --report`。
- `flywheel-comm ask --report` 已是 Runner→Lead 的唯一合法报告通道，且 report 会进入 Lead mailbox；
  因而这里只需补顺序化合同，不需新 CLI。
- `ask --report` 只把 CommDB question 标成 `kind=report`。现有 `formatRunnerQuestion()` 只把同时
  满足 `rstop-<32hex>`、`kind=report` 与 `RUNNER-STOPPED kind=runner_stopped` 的 FLY-2017 三元组
  渲染成 `[REPORT]`；普通 DONE report 仍显示 `[ASK]`。Lead 若按 `[ASK]` 规程执行 `respond`，
  `insertGuardedResponse()` 会写 Runner mailbox response，`runner-mailbox-lane.ts` 把无 checkpoint
  response 渲染为 `ask_answered` 并调用 `wakeRunnerMailbox()`：PASS polling 或 FAIL parked QA 都会被
  额外唤醒。
- 普通 UUID 是所有 `ask` 的默认，model-typed prefix 也不是可靠 namespace；在本单新增 report family
  需要 CLI mint、renderer、respond 与四份 Lead rules 一整条新子系统。按 founder“review findings
  不得驱动机制越长越多”的约束，本单不扩这个 family；确切 wake 副作用白纸黑字交给 FLY-2134。

## 关键实现判断

### 原子边界

fresh claim 的 lead event 必须在 `submitWorkflowDecisionByCredential()` 事务内写。若 event journal
写失败，整个 decision submission rollback；不能接受“claim 成功、事件稍后 best-effort append”。
`CompatDb.transaction()` 的普通 callback `return` 会 commit，只有 throw 才 rollback。因此
`alertIdentity` 必填且必须在进入 transaction、发生 capability/claim/credential/run-event 任一写入前
通过 `workflowAlertIdentityValid()`；不能把 guard 放在 claim insert 后。exact replay 从 credential 的
`claim_id` 按全局稳定 event id 找原 journal row 并返回原 seq；若 event 缺失则在 replay transaction
内补写，不能因 owner resolver 变化生成第二条。

### 投递完成口径

Step 4 判决层的机器 finding 只判断 durable Lead event 是否存在、owner 是否一致、是否完成现有
lead-event delivery；不声称推断 Lead 的心理状态或业务动作。R3 已证明 run-event 法结构性反转：
engine-owned submission 同事务必有更高 seq 的 `edge_traversed`，legacy submission 则永远没有，无法
用它识别 Lead 是否动作。这个明确 gap 由 FLY-2134 承接；本单拒绝新增 disposition 表或第二状态机。
claim attribution 必须与 Step 4 既有 facts 分开算：claim 分支不完整时只关闭该分支并输出聚合
`CLAIM_ATTRIBUTION_INCOMPLETE`，mailbox/wake/dead-letter/head 四类仍照常产出。

### 信息最小化

巡检只输出：issue、claim id、decision kind、predicate、issued_at、node、attempt、delivery state。
`workflow_claims.evidence` 与 mailbox content 不进入报告。Lead event renderer 可展示有界 summary，
沿用现有 Unicode-safe truncation helper。

### 兼容与恢复

- 不加 cutover migration channel。fresh submission 已经原子写 `claim_written` run-event；本单给该
  payload 增加 `leadEventRequired: true` 与 `leadEventId: workflow_claim:<id>`。判决层只查这个 marker，
  因此旧 backlog 不重复报，新 claim 若 event 被删/错投/未 delivered 会被抓到。exact replay 仍可
  补 pre-change event，但不回写 immutable 历史 run-event。
- `founder_approved/founder_challenge` 与 `bridge_policy/qa_exempt` 来自其他 producer，既不使用
  submission credential，也不进入本单的 Runner verdict 投递巡检。
- 新 event id 由 claim id 派生，response-loss retry 不重复。
- marked fresh claim 的 marker 与 event 同事务，仓内没有删除 lead event 的路径，因此
  `CLAIM_DELIVERY_MISSING` 是 restore/tamper/corruption canary，不是日常补账入口；Lead 没有 consumed
  credential，必须升级。`CLAIM_DELIVERY_PENDING` 才是 runtime 未注册/未完成 delivery 的 FLY-2139
  主信号。
- route 级即时 enqueue 只是降低时延；`LeadInboxRuntime.admit()` 的 owner/project-scoped journal scan
  是已注册 Lead runtime 的 crash/restart 恢复权威。runtime 未注册时它会 skip；这时 event 本身仍
  durable 且 `delivered_at IS NULL`，Step 4 输出 `CLAIM_DELIVERY_PENDING`，而不是用 console warning
  冒充恢复保证。
- claim payload 中 `project_name` 与 `issue_id` 是 required routing fields：前者供 redrive project filter，
  后者供 `routingSnapshotForLeadEvent()`；测试必须用 wrong-project row 证明过滤不会假阳性。

## 需要覆盖的测试面

- StateStore：identity 在 first write 前 fail closed、fresh claim/event/marker 原子写、exact replay
  单事件/缺 event 自愈、different-owner replay 不重复、transaction failure rollback。
- Router/plugin：required owner resolver 进入 event；成功后 enqueue stable envelope，runtime 未注册时
  row 保持 pending。
- Renderers：mailbox/CommDB 同形，字段完整，summary Unicode-safe bounded。
- LeadInboxRuntime：已注册 runtime 缺少 direct enqueue/重启后从 project-matched undelivered journal row
  redrive，wrong-project row 不进入，成功后写 `delivered_at`。
- Snapshot shell：marked claim 的缺 event、未 delivered、owner mismatch、已 delivered，以及 legacy
  unmarked、跨 Lead、terminal run、schema/owner attribution fail-closed；报告仍恰有 Step 1–6，
  判决 facts 归 Step 4，Step 6 disposition 不变。
- Blueprint：generalized 使用 “workflow verdict”，PASS/FAIL（Codex/Claude keep-alive 与
  non-keep-alive）和 feedback kickback 使用 “QA verdict”；全部是单一 compound
  `qa-result && ask --report`，并明确 accepted verdict 后 report 失败只重试 report。StateStore 测试证明
  decision commit 后 reporting session 没有同步 terminalize。当前 report 到 Lead 的确切 `[ASK]`
  形状与 respond→`ask_answered` wake 是 FLY-2134 的显式边界，不在本单另造 message family。
