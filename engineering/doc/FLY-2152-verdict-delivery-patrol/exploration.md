# FLY-2152 判决投递与巡检闭环 — 探索
Issue: FLY-2152 (https://linear.app/geoforge3d/issue/FLY-2152/巡检缺口-判决层不在巡检清单verdict-落库但无人推送静默压单2139-三小时无人动)
日期: 2026-08-29
基于: 无

## 问题定义

FLY-2139 证明了现有健康信号不能代表工作流仍在推进：QA 已把 `qa_verdict/qa_failed`
写入 `workflow_claims`，但没有通过 `ask --report` 告知 Lead。pane、session、TURN、PR
和普通投递账都可以同时为绿，Lead 却不知道已有一个需要返工或汇报的判决。

本单要消除的是“判决事实存在，但 Lead 通道没有对应可见事件”的静默窗口。判决的
source of truth 必须是 StateStore 的 claim，而不是 Runner 终端输出或 Runner 是否记得发消息。

## 假设与边界

- `workflow_claims.id` 是一条判决的稳定身份，`decision_kind/predicate/issued_at` 是巡检所需的
  最小事实；summary/evidence 不是巡检输出的必要内容，避免泄漏与报告膨胀。
- “Bridge 已主动推 Lead”以 durable `lead_events` 记录及其 delivery receipt 为准；不为本单
  新造“Lead 是否理解/已行动”的主观状态机。
- 巡检只看 active workflow run，并沿用 FLY-2118 的 owner attribution；不扩大 Department
  Lead 对其他 Lead Runner 的可见面。
- claim 的业务转移、返工或 ship gate 仍由 workflow engine 负责；本单只补事实可见性与
  巡检 finding，不改 predicate、authority、approval 或 claim 本身。
- Bridge 自动事件与 QA `ask --report` 是有意的双保险，允许 Lead 看见两条来源清晰的消息；
  两者不能互相作为成功前置。

## 方案比较

### 方案 A（采用）：claim 与 Lead event 同事务，投递走现有 durable queue

在 `submitWorkflowDecisionByCredential()` 写入 claim 的同一事务内，以
`workflow_claim:<claimId>` 为稳定 event id 写 `workflow_claim_recorded` Lead event；API 返回前
尝试进入现有 Lead mailbox，失败由仍在运行的 `LeadInboxRuntime.admit()` 定向 redrive。巡检新增
第六维度，只查 credential-backed `runner_node` claim 是否缺对应 Lead event、owner 是否漂移或
event 仍未投递。

优点：claim 与通知账不会一半提交；重放天然幂等；复用现有 owner resolution、journal、mailbox
和现役 redrive 机制。缺点：StateStore 的 decision transaction 多承担一条 event journal 写入，但仍是
同一 SQLite 内的小事务。

### 方案 B：route 在 claim commit 后 best-effort 发事件

`workflow-decision-routes.ts` 收到成功结果后再 append/enqueue。

优点：改动局部。缺点：claim commit 与 event append 之间仍有 crash window，恰好保留了本单要
消灭的静默形状；需要额外 reconciler 才能补齐。

### 方案 C：只补 QA prompt 与巡检规则

要求 QA 在 `qa-result` 后 `ask --report`，巡检定期扫 claim。

优点：实现最小。缺点：继续依赖 Runner 自觉，Bridge 无主动投递；巡检间隔内仍会压单，也不满足
双保险要求。

## 采用设计

1. `workflow_claim_recorded` 是 typed Lead event，payload 必须携带用于 routing/redrive 的
   `project_name/issue_id`，并只补 run/node/attempt、claim id、`decision_kind/predicate/issued_at` 和
   有界 summary。共享 renderer 让 mailbox/CommDB 两个 runtime 同形展示，并明确该事实需要 Lead
   推进返工、报告或 ship。
2. `alertIdentity` 在进入 transaction、发生任何写入前就必须通过
   `workflowAlertIdentityValid()`；fresh submission 才在 claim transaction 内 append event。exact
   replay 按全局稳定 event id 复用原 event seq；若旧 receipt 没有 event，则在 replay transaction
   内用同一稳定 id 补写，不能因 owner resolution 漂移生成第二条。
3. claim commit 后通过 `createBridgeApp()` 已有的 `RuntimeRegistry` 立即 enqueue；若已注册 runtime
   尚未 ready，`LeadInboxRuntime.admit()` 对 `workflow_claim_recorded` 与现有 replacement event 做
   同一条 owner/project-scoped journal redrive。若 Lead runtime 根本没有注册，redrive 也无法运行，
   但 durable event 保持 `delivered_at IS NULL`，由 Step 4 判决层持续显示 `PENDING`，直到 runtime 恢复。
   已删除、无消费者的 `RETRYABLE_LEAD_EVENT_TYPES` 不作为证据。
4. Lead patrol **保持六步且 Step 6 处置不动**。第六维度“判决层”的 machine facts/status candidate
   放进现有 Step 4“投递账 + verdict/receipt 一致性”下面；这一步本来就拥有 delivery 与 verdict
   consistency，旧 prompt 也会因 Step 4 `FINDING-CANDIDATE` 无法完成。updater 会先 fast-forward 主仓，
   而 `~/.flywheel/bin/flywheel-patrol-snapshot` 是指向主仓脚本的 symlink；全体 Lead restart 完成前
   存在新 producer + 旧 prompt 的窗口，因此不能把 producer 先改成七步。
   新 submission 的既有 `claim_written` run-event payload 增加 `leadEventRequired: true` 与稳定 event
   id；判决层只查带这个原子 marker 的 active credential-backed `runner_node` claims，输出
   `CLAIM_DELIVERY_MISSING`、`CLAIM_DELIVERY_PENDING` 或 `CLAIM_DELIVERY_OWNER_MISMATCH`
   finding；system/founder claims 不在这条 Runner 通知合同内。输出的 nullable 字段全部显式
   `coalesce`，只列 allowlist 元数据，不列 evidence/summary。claim owner attribution 使用独立
   fail-closed guard，不加入 Step 4 既有四类 facts 的 shared subject set；错误只输出聚合
   `CLAIM_ATTRIBUTION_INCOMPLETE`，不能压掉 mailbox/wake/dead-letter/head findings。
5. generalized verdict 与 legacy DAG QA prompt 都把 `qa-result && ask --report` 写成同一个 compound
   terminal action；PASS 后再开 gate，FAIL 后再 park。`commitWorkflowTransitionTx()` 不同步修改
   `sessions.status`，因此 verdict HTTP 返回后当前 shell 仍能完成 report；若 compound 非零而
   `qa-result` 已 accepted，只重试 `ask --report` 半段，绝不重提或改写 verdict。

## 明确遗留边界（FLY-2134）

- `delivered_at` 只证明事件进了 Lead runtime，不证明 Lead 已读或已推进。R3 验证了 engine-owned run
  会把 `edge_traversed` 与 claim 同事务提交，而 legacy run 永远没有该 event，因此不能用 run-event
  presence 区分“Lead 未处置”；这种判据会对前者永静默、对后者永告警。本单不新增噪声状态机，
  “已投递但 Lead 长时无动作”交给互链 FLY-2134（没人监控监控者）。
- `ask --report` 当前仍以 ordinary UUID `runner_question` 显示为 `[ASK]`；Lead 若 `respond`，会创建
  `ask_answered` mailbox wake，FAIL parked QA 可能被提前唤醒。为它新增 message family/CLI namespace
  会把本单扩成另一个子系统，也交由 FLY-2134；本单只落实用户要求的 verdict 后立即 report。
   PASS 后再开 gate，FAIL 后再 park。`commitWorkflowTransitionTx()` 不同步修改 `sessions.status`，因此
   verdict HTTP 返回后当前 shell 仍能完成 report；测试直接钉住这个观察。若 compound 非零而
   `qa-result` 已 accepted，只重试 `ask --report` 半段，绝不重提或改写 verdict。缺 `leadId` 的历史
   兼容 dispatch 不新增 hard throw，Bridge 原子 event 仍是保证。

## 成功标准

- fresh claim 与 `workflow_claim_recorded` journal row 要么一起存在，要么一起不存在；invalid identity
  在第一条写入前拒绝；exact replay 始终只有一条 Lead event，并可修复 pre-change eventless receipt。
- 两种 Lead runtime 都能看到 claim id、decision kind、predicate、issue 与有界 summary。
- Bridge mailbox enqueue 失败后，已注册 runtime 由现役 `LeadInboxRuntime.admit()` 从 journal 定向
  redrive 并最终写 `delivered_at`；未注册 runtime 的 pending journal row 由 Step 4 判决层 durable 暴露。
- 巡检 fixture 能让 post-change FLY-2139 同形（active run + marked qa_failed claim + 无 Lead event）
  成为 Step 4 判决层 finding；其中 `PENDING` 是真实未投递信号，`MISSING` 是只可能来自 restore/
  tamper/corruption 的原子不变量 canary，必须升级而非要求 Lead replay。跨 Lead claim 不泄漏，legacy
  unmarked backlog 不重复报。
- QA prompt 的 PASS、FAIL、founder feedback kickback 及 generalized verdict 均明确包含 verdict 后
  立即 report-to-Lead 的顺序。
