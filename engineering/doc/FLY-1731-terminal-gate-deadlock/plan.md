# FLY-1731 活着的 runner 被判终态·gate 永不投递 — 实施计划

Issue: FLY-1731 (https://linear.app/geoforge3d/issue/FLY-1731/session-被提前判-terminal活着的-runner-双向失联-ship-gate-无限重试永不投递)
日期: 2026-08-12
基于: research.md(其中 §2.2 permanence 合同与 §4.2 告警形态已被本计划 R1 修订取代)

## 0. 一句话

engine-owned workflow gate 的 admission 改为与系统其余消费者一致地以 **gate holder 为 authority**(session 活性不再是门票),同时给不可投递 question 一个**有限终结+可见告警**的出口、给 runner 一个**基于真实 transition receipt 的收工信号**。发给 runner 的死信通知复用并验证既有 owner-Lead mailbox 通道,不重复造第二条 alert 通道。

## 1. 范围与交付切分(R1 修订:Fix A 独立成 PR,解堵不被后续合同绑死)

| 交付 | 内容 | 解决症状 | 优先级 |
|---|---|---|---|
| **PR-1(第一交付)** | **仅 Fix A**(admission holder-authority)+ 正/负 integration + 部署验收 | 症状 1 现场解堵 | Urgent;**硬 deadline 2026-08-15T14:33:46Z**(现场行过期) |
| **PR-2** | Fix B(permanence + 有限 horizon 兜底)+ Fix C(receipt-based 收工信号)+ Fix D(核实既有 owner 通知,零新增代码) | 静默过期 + 症状 2/3 源头 | High,紧随 PR-1 |

**Founder 层级原则已终裁 owner≠sender 争点(2026-08-12)**:死信只通知收件方的上一级——runner → owner Lead;Lead → founder。sender 不进路由决策,因此 Fix D 的 owner 通知是**正确形态**,不是验收降级;原 PR-3(per-destination sender 迁移)**移除**。send 入口拒绝跨 Lead 直发仍可作为通信纪律小修,但不再是本单验收缺口。§3.3 的 per-destination 形态只保留为评审历史。

两个 PR 均**无 schema 迁移、无新 env flag、无新周期 timer**。

**部署顺序硬约束(R3 #5)**:Fix B 的生产前置条件 = **Fix A 已部署且 71271 解堵验收已过**。否则现场 holder gate 仍命中 `revoked_terminal_session`,Fix B 的 permanence 层会把 seq 71271 立即 `markDead`,永久摧毁 PR-1 的自然重试解堵路径。「cherry-pick」只允许指向已含 Fix A 的基线。组合回归钉死:同一 live-holder + completed-session 行在 A+B 同时生效下必须 deliver,绝不能被 permanence 层先 DEAD。

**stacked PR 不豁免该约束(code review advisory 落定)**:#822 以 #819 branch 为 base 只是审查/开发拓扑,不是合并或部署许可。ship 必须分两波:#819 先合入并部署 → 现场验证 71271 类行已离开 `revoked_terminal_session` 且 gate head 绑定正确 → 才把 #822 retarget 到 main 并进入其独立 founder-gated ship。禁止从 #822 combined head 一次性部署 A+B。

## 2. PR-1 — Fix A:admission 尊重 holder authority

### 2.1 改动(两文件:`question-admission.ts` + `StateStore.ts` 的 presentation predicate 补一检查)

`eligibility()` 在既有第 3 步拿到 `workflowGatePresentationDisposition` 结果后:

```
const holderAuthoritative = ownership.allow && ownership.reason === "holder_authoritative";
if (question.checkpoint != null) {
    if (!holderAuthoritative && !ACTIVE_GATE_SESSION_STATUSES.has(session.status))
        return { ok:false, disposition:"revoked_terminal_session" };
    if (!matchesLead(...)) return { ok:false, disposition:"revoked_lead_scope" };   // holder/legacy 一律保留
    if (!holderAuthoritative && question.checkpoint === "approve_to_ship" && reviewHoldReason(...) !== null)
        return { ok:false, disposition:"revoked_qa_hold" };
}
return { ok:true, session };
```

- `holder_authoritative` 时跳过活性检查与 legacy QA hold(engine run 的 QA 证据已在 `workflow_gate_holder_evidence` 冻结;FLY-1425 已把 engine execution 隔离出 legacy QA 路径)。
- `matchesLead` 保留(misroute 防御;completed session 行的 project/labels 列健在)。
- legacy gate(disposition = `legacy`/`legacy_epoch`)行为逐字节不变。
- **(R2 #6)`workflowGatePresentationDisposition` 增加 runner_ship carrier-binding 检查**:`holder.authority_mode === "runner_ship" && holder.carrier_binding_state !== "bound"` → 新 non-allow reason `holder_carrier_unbound`。使 presentation predicate 与 materializer(gate-materializer.ts:69-74)/`GateAuthorityView`(gate-authority-view.ts:72-74)对 unbound carrier 的拒绝语义一致——admission 与 reaction pass(同一 predicate 的两个消费者)同步受益。

### 2.2 安全论证(R1 #6 + R2 #6 修订:写准 inductive invariant)

`workflowGatePresentationDisposition`(StateStore.ts:22355-22403)本身校验的是:当前唯一 active activation、`gate_carrier_epoch===1`、`run.current_node_id === gate.node`、holder 存在且 `source_execution_id`/`question_id` 精确匹配,外加本 PR 新增的 runner_ship carrier-binding 检查。**`engine_owned` 的显式校验不在该 predicate 内**——安全性来自归纳不变量:**epoch-1 的 gate holder 只能由 engine-owned run 的 `commitWorkflowTransitionTx` → `createWorkflowGateHolderTx` 铸出**(gate 开门是 engine transition 的一部分),所以「存在精确匹配的 current holder」蕴含 engine 出身。批准写入侧另有更强的 `GateAuthorityView`(显式 `engine_owned===1`、pinned authority mode/subject、runner_ship carrier binding)与 holder-state mutation guard(write-gate-response.ts:333-352)——**Fix A 只放行 presentation(通知 Lead),不触碰任何批准权限路径**。

负面测试必须用真实 StateStore(非 mock reason):non-engine run 同形 question、epoch=0 run、holder 换代后的旧 question、corrupt snapshot、runner_ship unbound carrier(经新 `holder_carrier_unbound` 拒绝,直接以 admission 断言而非只靠 materializer 不产 question)——逐一断言仍拒。

### 2.3 PR-1 测试(TDD,先红后绿)

单测(question-admission 现有测试族扩展):
1. holder_authoritative × session∈{completed, ship_parked, blocked} → `deliver:true` + materialize 发生(RED:现状全拒)。
2. legacy gate(无 activation)× completed session → 仍 `revoked_terminal_session`(行为不变哨兵)。
3. matchesLead 违例在 holder_authoritative 下仍拒。
4. §2.2 的五组真实-StateStore 负面测试。

integration(真 StateStore + 真 CommDB 文件,重放 FLY-1704 时序):
5. land run:complete(needs_review)→ completed 投影 → gate holder → materializer 写 question → mailbox admission → **断言投递**(payload 含 checkpoint=approve_to_ship、event_type=gate_question)。
6. 对照组:legacy terminal gate → 仍拒,证明 Fix A 不是无差别放行(阳性对照防「空过绿测」)。

### 2.4 现场解堵验收(部署即验收)

部署 PR-1(Bridge 重启)后 60s 内:
- `mailbox seq 71271` 离开 QUEUED(→ LEASED/ACKED 链);
- PM Lead model-lane 收到 `gate_question`(lead_events 出现 `gate_workflow-gate:ea1d6df3…` 行);
- 不动 runner pane `@180`(现场保护由 Lead 统筹)。
若 08-15 前无法部署,须在过期前把该行处置升级给 Lead 决策——不允许静默过期。

## 3. PR-2 — Fix B + Fix C + Fix D 通道核实

### 3.1 Fix B:permanence 分类 + 有限 horizon 兜底(R1 #1 + R2 #4/#5 修订)

**范围边界(Lead 2026-08-12 裁定)**:本单只处理 **QUEUED admission 拒绝类**。Cass 普查发现的 batchless `LEASED` 孪生积压已独立为 FLY-1736,本单不滚包、不改过期 lease 扫描。

**双层合同**(取代 research §2.2 单层表):

**第一层(快终结,按事实而非 disposition 名字判永久 — R2 #4 + R3 #6)**:`eligibility()`/`revalidate()` 返回值带 `permanent?: boolean`;`revalidate()` 的 retry 改为 `row.source_ref === null && !verdict.permanent`。
- `revoked_terminal_session` **不再无条件永久**:它来自 `!ACTIVE_GATE_SESSION_STATUSES.has(status)`,而 `pending / ship_parked / design_done` 均可回到 active(workflow-fsm.ts:120-144)。permanent 当且仅当 `isNoOutEdgeTerminalStatus(session.status)`——真正的 no-out-edge 集合是 `approved / completed / shelved / terminated`;**`failed` 不在其中**(FSM 允许 failed→shelved/terminated),`failed / rejected / deferred` 均 retryable(交第二层)。实现必须调用 helper,禁止退回字符串 allowlist——`failed/rejected/deferred` retryable 哨兵测试钉死。
- 无条件永久:`revoked_missing / revoked_superseded / revoked_answered / revoked_orphan / revoked_lead_scope / revoked_workflow_gate_holder_mismatch`。
- 未列出者默认瞬时(保守)。

**第二层(horizon 兜底,治「误归瞬时」— R2 #5 + R3 #4 补全边界)**:
- 任何可重试 verdict 追加行内寿命检查:`expires_at - now ≤ HORIZON_MARGIN`(24h 常量,非 env;边界含等号,与测试一致)→ 强制 `retry:false`。
- **错误分类边界:显式新 error class,mint 点为代码级边界,其余一律 rethrow(R3 #4 + R4 #5 + R5 #1 + R6 #1 定形)**:现有 snapshot/classification 失败抛的是普通 `Error`,生产中**不存在**可辨识的 typed row-local error——本 PR 新建 error class `WorkflowAdmissionClassificationError`,mint 点写到代码级边界,**catch/wrap 绝不允许包住任何 DB 读**(否则 SQLITE_BUSY 会被重写成 `admission_error`,违反本段 rethrow 合同):
  - ① **`generalizedExecutionContextForBinding` 内部**(实际 snapshot parse 所在;非其调用者 `resolveCurrentWorkflowActivation` 外围——后者还执行两组 SQL):仅对 deterministic snapshot decode / validate / node-resolution 失败构造 typed error;**`getWorkflowRun` 调用不在包裹范围内**。
  - ② presentation 侧(若确需):仅包纯 manifest classification(`workflowApprovalGate` 一族纯函数);activation / holder 的 DB 读取不在包裹范围内。
  `revalidate()` 的 catch 只对 `instanceof WorkflowAdmissionClassificationError` 转 retryable disposition `admission_error` 过 horizon;**所有其他错误(`SQLITE_*` BUSY/IOERR/CORRUPT/NOTADB、I/O、连接、owner-fence、未知)默认 rethrow**,由 inbox tick 外层 catch + 健康告警处理(错误不是 verdict,不消耗行)。`getMessageById` 缺行不是异常,是既有 `revoked_missing` 的正常返回路径。expiry 完整性检查放在所有读取之前。哨兵测试:**三个相邻 DB seam**(activation SELECT、`getWorkflowRun`、`getCurrentWorkflowGateHolder`)注入 SQLite 错误 → rethrow 不消费行(证明 catch 范围非真空、不误吞);SQLITE_BUSY/IOERR/CORRUPT 各一条「不消费行」断言。
- **expiry 完整性**:`expires_at` 为 NULL/非法的行 → 立即 `retry:false`,disposition `expiry_integrity`(fail-closed,进告警域)。
- **materialize 失败 = 基础设施域,不属于本合同(R4 #1 + R5 #1 定形)**:R3 稿「lease-exhaustion 兜底」论断已撤回(frozen-resend 分支先命中,`lease_retry_count` 永不递增);R4 稿的「pre-handoff typed materialize error」分支同样删除——`materialize()` 的 read/render/StateStore/CommDB 操作没有任何真实的 deterministic row-local 失败类,**不虚构一个生产永远不会产生的类型**。定形边界:materialize 抛出 = Bridge 侧基础设施故障 → rethrow(行不消费,留 LEASED → 过期 → frozen-resend 重投),故障修复后行照常投递;它不是「不可投递」,horizon 与 DEAD 不适用。frozen-at-adapter batch 的 no-duplicate 语义零改动(哨兵测试钉死)。
- 不变式措辞(准确版):**在 Bridge 正常 tick 的前提下,任何成功产生 verdict 的 QUEUED question 行,要么投递,要么在首次被观察到 `remaining ≤ 24h` 后的下一次重试处置时 DEAD + 进入可见告警域**;无法产生 verdict 的行(基础设施故障)不消费、由健康告警可见,故障恢复后回到本不变式;轮询停摆期间不计时(恢复后第一个 tick 兜住)。

消费方(lead-inbox-loop.ts:334-348)零改动:retry:false 已走 `markDead(disposition)`;DEAD 后走既有 `lead_unacked` 死信通知。implement 必核:新 disposition(含 `admission_error`/`expiry_integrity`)不落入 `QUARANTINE_DEAD_REASONS`(R1 已核:该常量只含两项归档语义,不冲突)。

测试:permanence 按 status 事实逐项断言(`pending/ship_parked/design_done/failed/rejected/deferred` retryable、`approved/completed/shelved/terminated` permanent);horizon 边界(margin **等号**、跨 margin 一个 retry interval);corrupt snapshot → `WorkflowAdmissionClassificationError` → `admission_error` → **重复 claim/retry(30s `releaseClaimForRetry` 循环,非 lease expiry)直到 horizon → DEAD + notifier 扫到**;SQLITE_BUSY/IOERR/CORRUPT rethrow 不消费行(三哨兵);frozen-at-adapter 行为不变哨兵;NULL/非法 expiry → 立即 DEAD;0-current activation、persistent multi-current、merge_block hold 在 horizon 下的有限终结(R1 #1 点名);**A+B 组合回归(§1 部署顺序):live-holder + completed-session 行必须 deliver**。

### 3.2 Fix C:receipt-based 收工信号(R1 #5 + R2 #2/#3 修订)

**静态 snapshot mode 不够**——no_code 直完、shadow/non-engine run 会错报。改为从**实际 transition receipt + pinned authority** 派生(current holder 全程禁用,见 replay 段),分类规则**互斥**(R2 #2):

- `commitEnrolledCompletion` 返回结构增加 `completionDisposition: "engine_gate_handoff" | "runner_ship_park" | "terminal_no_gate"`,分类规则(R4 #2 重排:**先按本次 receipt 收敛域,再在 gateOpened 域内分 carrier**——避免 no_code 同时命中两条规则):
  1. 本次 completion **无 `gateOpened`**(含 `no_code` 直完——它绕过 transition、不铸 holder)→ **`terminal_no_gate`**。pinned snapshot 解析出什么 authority 无关紧要:没开门就没有 gate 语义(tpl_generic 可解析为 runner_ship carrier,但其 no_code 出口必须是 terminal——专项全链测试钉死)。
  2. 有 `gateOpened` 且 run `engine_owned===1 && gate_carrier_epoch===1`:completer 是否 carrier 用 **pinned authority**(R3 #3)——`resolveWorkflowGateAuthority().carrierNodeId === completion binding.node_id` → **`runner_ship_park`**,无论 holder 此刻 bound/unbound(unbound 是可修复的 carrier-binding 故障,rebind 要求 carrier session 留在 `ship_parked`;叫 carrier 退出会摧毁修复前提。binding 状态只控 presentation/materialization,不控 runner 生命周期指令);非 carrier(land/engine_terminal 的 gate,或 QA/非 carrier 节点打开 runner_ship gate)→ **`engine_gate_handoff`**。
  3. 其余(non-engine、epoch=0)→ `terminal_no_gate`。
- **幂等 replay 返回同一 disposition(R2 #3 + R3 #2 + R5 #2:从 immutable 证据,checked 写入)**:首次 completion 事务内以 **`appendWorkflowRunEventCheckedTx`**(核验 kind/payload,拒绝同 UID 冲突;弱版 `appendWorkflowRunEventTx` 同 UID 静默返回既有 seq,会让首次与 replay 分叉)写一条 immutable `completion_disposition` workflow event(uid 含 run/node/attempt,payload 带 disposition;`workflow_run_event` 是既有通用事件表,**零 schema 迁移**)。**冲突策略(首次与 replay 同一;R6 #2:catch 必须可辨识)**:checked helper 现抛普通 `Error("workflow_event_uid_conflict:…")`,与它内部 event 查询/插入可能抛的 SQLite 错误不可区分——本 PR 给它引入 discriminant `WorkflowEventUidConflictError`(或同等严格判别)。**只 catch 该 deterministic conflict**:completion 事务照常提交(disposition receipt 冲突不能回滚核心状态推进),响应**省略** `completionDisposition` 字段(fail-closed)并记 log;**SQLite、I/O、owner-fence、未知错误一律 rethrow,completion 事务回滚、由调用方重试**——绝不允许「没写成 receipt 还提交了 completion」。replay 读到 wrong-kind/corrupt → 同样省略字段。注入测试:首次写与 legacy backfill 各注入 SQLITE_BUSY/IOERR,断言**不**返回 2xx-with-field-omitted、**不**提交半套 core state;wrong-kind/corrupt 冲突才走「核心提交 + 字段省略」。current holder 会漂移(rebind unbound→bound、supersede 后不再可见),session projection 会推进——**均禁止作 replay 依据**。
- **升级前 completion 的 legacy 分支(R4 #3)**:PR-2 部署前已完成的行没有 disposition event。replay 遇到 legacy-missing-event 时:仅从既有 immutable 证据(completion row、transition receipt 的 `gateOpened`/target、pinned snapshot、activation binding)重建一次,并在同一事务用 `appendWorkflowRunEventCheckedTx` 固化;**禁止读 current holder**。证据损坏/不完整 → fail-closed:响应**省略** `completionDisposition` 字段(CLI 落回现行逐字节输出,自然安全)。测试:旧库仅有 completion+transition receipt(无 event)→ 升级后 replay,land / runner_ship / no_code 三类;wrong-kind 与 corrupt-payload 冲突各一。
- event-route 把它透传进 generalized completion 的 res.json(replay 分支同样携带)。
- complete.ts ok 分支:**独立 best-effort try/catch 读 body**(HTTP 已 2xx 后 body/JSON 失败必须仍按成功返回,不得掉入外层重试或写失败 marker);按 disposition 打印:
  - `engine_gate_handoff` →「run 已进入 engine-owned gate;本节点已终结,不会有 approve/ship 环节找你;不要等待、不要跑 verify-approval,立即收尾退出。」
  - `runner_ship_park` →「已 park 等待 ship gate;等 wake,勿自行轮询。」
  - `terminal_no_gate` / 字段缺失 / body 非 JSON → 输出与现行逐字节一致。
- 兼容矩阵测试:新 CLI×旧 Bridge、旧 CLI×新 Bridge、no_code、engine_owned=0、epoch=0、**首个 2xx 丢失→同请求 replay 返回同 disposition**(R3 #2 三变体:replay 前 carrier rebind 发生、旧 holder 已 superseded、session 已后续推进——均断言与首次一致)、2xx body-read throw;carrier 判定三组(R2 #2 + R3 #3):bound direct-to-gate carrier(→park)、**unbound carrier(→park,并覆盖 repair→materialize→approval→wake 全链)**、QA/non-carrier 打开 runner_ship gate(→handoff)。

### 3.3 Fix D:死信告警通道核实(implement review 校正;founder 层级原则定案)

**通知路由总纲(founder 2026-08-12 原话,记入为最高设计约束)**:

> 「其实 Dead Letter 不就是给他的上一级吗?比如说 runner 的东西如果进入 Dead Letter 就给 leader 说,如果 leader 的东西进入 Dead Letter 就给我说,大概就是这么一个顺序」

即:**死信通知永远发给收信方的上一级**——runner 的死信 → 它的 owner Lead;Lead 的死信 → founder。**发信方是谁不进路由决策**,R2-R3 纠结的 owner≠sender 议题被该原则直接消解(per-destination sender 通知不再是任何层的需求;§「第二层存档」保留仅作历史)。

**层级映射与现状核查**:
- **runner → owner Lead**:现状已有 `RunnerMailboxLane` → `scanAndInsertDeadLetterNotices()` → `dead_letter_notice` mailbox 通道,使用同一个 `resolveOwningLead`;本单验证复用,零新增代码。
- **Lead → founder**:现状**已有通道覆盖**——`lead_unacked` 死信经 `deadLetterAlertSink` → `LeadAlertNotifier`(plugin.ts:7735-7753,eventType `mailbox_dead_letter`)投 **#flywheel-alerts 告警频道**,即 founder 可见的系统告警面(claude-infra-bot 同巡)。映射成立,本单零改动。诚实注记:这是「频道可见」级覆盖;若 founder 要求点名直 ping 级,则是另单增强,非缺口修补。
- 相关史料:死信闸本体 = FLY-1573(Done);判死接真探针 = FLY-1714(Backlog)。

R2 证明 per-destination fan-out 无法零 schema 穿过现有约束。R3 曾裁定 owner-only 不得自行降级验收;该争点现由 founder 层级原则终裁:**owner 通知即正确形态**。implement code review 进一步发现原计划误读了 `listUncoveredLeadDeadLetters` 的 skip:它只跳过统一 alert 通道,而既有 runner mailbox lane 已向 owner Lead 插入同内容通知;删除 skip 会双报,因此按 YAGNI 撤回该改动。

**实施形态(PR-2,零 schema、零生产代码)**:
- 保持 `listUncoveredLeadDeadLetters` 对 owned runner 的 skip,避免与 runner mailbox lane 双报。
- 用既有 `scanAndInsertDeadLetterNotices` 测试/调用链确认:terminal runner 的 DEAD 行按 30 分钟窗口聚合,以 `dead_letter_notice` 投给 `resolveOwningLead(recipient)`。
- 通知正文由 `formatDeadLetterNotice` 生成并包含 `from_agent`;sender 仅是摘要内容,不参与 destination authority。

**第二层(存档,已被 founder 层级原则取代——发信方不进路由,per-destination sender 通知在任何层都不再是需求;保留仅作评审历史):per-destination 通知**

覆盖模型(R4 #4 + R5 #3 定案:**per-destination coverage,destination 集合带 authority guard**):
- **destination 集合(R5 #3 恢复 validated-Lead guard)**:owning lead ∪ 该组 DEAD 行中**当前项目配置可验证的** distinct Lead `from_agent`。`from_agent` 是 CommDB 行数据,**不能直接当 notifier 的 authority**——必须过项目 Lead 配置校验;非 Lead / 已移除 Lead 的 sender 只出现在 owner 通知的 summary 里,不产生直发 destination。`owner === sender` 时去重为单 destination。聚合域:**owner destination 聚合该 runner 全组 DEAD(全组语义优先);每个 sender destination 只聚合自己发出的行**。`lead_unacked` 不变:recipient Lead 是唯一 destination。
- 每条 intent 的成功持久化只推进**自己 destination 的 cursor**;部分 crash / 单 destination 被限流,由该 destination 落后的 cursor 在后续 tick 自然补齐,不影响其他 destination。
- API 合同:`DeadLetterAlertCandidate` 显式扩展(`destinationLeadId` + `aggregationScope: "owner" | "sender"`——destination 与聚合域不靠 runtime 猜测);`listDeadLetterAlertCursors()` 返回并由 scanner 消费 **destination-aware** cursor(`(sourceKind, recipient, destinationLeadId) → throughDeadSeq`——现状 CommDB 侧把 cursor 压成 `(sourceKind, recipient)` Map 会互相覆盖,必须同步改);intent id / event id 含 destination 段;pending partial index 与 30min rate-limit 键均加 destination 维度,互不干扰。
- **schema 增列 `destination_scope`(owner/sender;R5 #4)**:持久化每条 intent 的 coverage 语义,旧行 backfill `owner`。这是 down migration 正确性的前提(见下)。
- 迁移合同(R4 #6 + R5 #4 写实,选 **quiescent up + 显式 down 工具**形态):
  - up = Bridge 停写窗口内 table rebuild,旧行 backfill `destination_lead_id := lead_id`、`destination_scope := 'owner'`;pre-migration backup 强制。
  - down 工具(rollback 二进制前必须先跑),两步(R6 #3:owner-scope 也必须确定性 collapse——owning Lead 由 config+labels 逐次解析,owner 漂移(A→C)会给同 recipient 留多条合法 owner-scope 行,旧表 `UNIQUE(source_kind, recipient, through_dead_seq)` + 每 recipient 至多一个 pending 装不下它们):
    1. **清 sender-scope**:pending 删除;accepted 及其 `alert_delivery_receipts` 归档(审计保留,移出活表)。**含 post-receipt crash 窗口的合法状态**——仍 pending 但已写 receipt 的行,其 receipt 一并归档。
    2. **collapse owner-scope 到旧键**:投影到 `(source_kind, recipient, through_dead_seq)` 消解 duplicate tuple(保最新 owner 行,其余归档);每 recipient 收敛到至多一个 pending(多 pending 保 through_dead_seq 最小者,其余归档)。**cursor 只允许降、不允许升**:collapse 后旧 `(source_kind, recipient)` MAX 若低于任一被归档行,接受重复扫描(重发重复告警,安全);绝不让 MAX 高于 owner 实际覆盖(跳过未覆盖段,丢信)。
  - down 测试(真实旧表数据,非空库):owner A→C 漂移(双 owner-scope 行);两个 owner pending;pending+receipt(post-receipt crash 窗口);「sender cursor > owner cursor」→ down → 旧 binary 重扫补齐 owner 未覆盖段;collapse 后 MAX ≤ owner 覆盖断言。
- 测试(up 侧):owner≠sender 双通知;owner=sender 单 destination;non-Lead sender 只进 owner summary;`lead_unacked` 不变哨兵;首 destination 后 crash → 重启由落后 cursor 补齐(断言其他 destination cursor 不回退);单 destination 被限流不阻塞其他;**从含 pending、accepted、delivery receipt 的真实旧文件升级**(非空库 schema round-trip)。down 侧测试见上。
- **历史裁决的最终状态**:ask `61386e7b` 的 (b) 先移除了本层;随后 founder 层级原则进一步确认 sender 不进路由,因此本层从「follow-up 候选」降为纯历史存档。send 入口校验可另作通信纪律小修,不属于死信通知合同。

### 3.4 明确不做(边界)

- send CLI 同步拒绝 terminal recipient(跨库读耦合 + TOCTOU;聚合告警语义已满足验收第三条)。
- 终态-存活对账 patrol(逆 FLY-1570;Fix A+C 消灭源头)。
- runner_ship 深链(park/wake/ship-attempt)——FLY-1448/1505 领域,不碰。
- `needs_review → awaiting_review` 投影改动(exploration §2.1:land 语义有意投影 completed;R1 复核确认保留)。

## 4. 验收对照(issue 三条行为锚定;整单以三条全部满足为准)

| issue 验收 | 由谁满足 | 验证方式 |
|---|---|---|
| `complete --route needs_review` 后开的 `approve_to_ship` gate 必须投达 Lead | Fix A(PR-1) | integration #5 + 现场 71271 解堵 + QA 真机剧本 |
| 永久性不可投递必须有限终结 + 可见告警,不得静默过期 | Fix B 双层合同(PR-2) | permanence 逐项 + horizon 边界测试 + 对照组 #6 |
| 终态 session 收到消息时必须产生上级可见失败信号(**founder 层级原则**:runner → owner Lead;Lead → founder) | Fix D(既有 runner mailbox lane 核实)+ Fix C(收敛场景);Lead→founder 频道可见通道已有 | 既有通道测试 + 真机死信通知观察 |

QA 真机剧本(529 隔离房,research §5):land run 全链(complete → completed 投影 → gate holder → 卡片 → **admission 放行 → Lead model-lane 收到 gate_question**)+ founder ✅ → land 推进。后者同时定案「✅ 通路对 terminal source 是否真活」——代码推断的现场验证,QA 节点必跑。

## 5. 风险

1. **Fix A 放行面**:安全性=§2.2 归纳不变量 + 五组真实-StateStore 负面测试钉死;legacy 面零变化由对照组测试钉死;批准权限路径不经过本改动。
2. **permanence 误判**:第二层 horizon 把两个方向的最坏情况都封在「过期前 24h 有限终结+告警」;瞬时误标永久=丢门但有告警可人工重触发。
3. **Fix D 双报风险**:code review 发现 owner 已有 `dead_letter_notice` mailbox 通道;本单撤回第二条 unified-alert 路由,保持单通道与既有 30 分钟聚合窗。
4. **部署窗口**:PR-1 上线要 Bridge 重启,走批次部署车;deadline 08-15 需在 Lead 排程里显式标注。
5. **现场保护**:全部验证只读(`mode=ro`);runner pane `@180` 与 comm.db 现场行为不动,直至 Lead 宣布解除现场。

## 6. 里程碑与文档流

- 本 plan 经 codex-design-review 循环至 APPROVED 后进入 implement(本单 workflow 的后继节点,非本 design 节点职责)。
- PR-1/PR-2/PR-3 各自按 TDD(RED→GREEN→REFACTOR)+ 全仓 gate(`pnpm lint` + `pnpm -r build` + 定向 vitest;全量 suite 不在生产 host 跑)+ codex code review 循环。
- CLAUDE.md 里程碑行 + 文档随分支进 main(PR 最后一 commit)。

## 附:评审裁决记录

R1:
| 条目 | 裁决 | 落点 |
|---|---|---|
| #1 permanence 无有限终结 | 接受(horizon 兜底形态,不逐 reason 拆分) | §3.1 |
| #2 runner_owned 撞 CHECK 约束 | 接受(零 schema) | §3.3 |
| #3 owner ≠ sender | R1 接受为 destination 集合;R2 #1 证明该形态不可零 schema → 收敛为单 destination + follow-up | §3.3 |
| #4 MAX(seq) 基线无持久位置 | 接受(删除抑制) | §3.3 |
| #5 静态 mode 错报 | 接受(transition receipt + best-effort body read) | §3.2 |
| #6 论证收紧 + PR 切分 | 接受(PR-1 仅 Fix A;归纳不变量写准) | §1/§2.2 |

R2:
| 条目 | 裁决 | 落点 |
|---|---|---|
| #1 fan-out 撞四重键 | 接受(收敛单 destination=owning lead;后由 founder 层级原则确认这是正确形态) | §3.3 |
| #2 disposition 不互斥,direct-to-gate carrier 被误叫退 | 接受(holder-aware 互斥分类) | §3.2 |
| #3 replay 丢信号 | 接受(replay 从 durable receipt 重建同一 disposition) | §3.2 |
| #4 revoked_terminal_session 不可无条件永久 | 接受(permanent ⟺ isNoOutEdgeTerminalStatus;pending/ship_parked/design_done retryable) | §3.1 |
| #5 horizon 非 total(异常/NULL expiry/措辞) | 接受(admission_error + expiry_integrity + 措辞修正) | §3.1 |
| #6 unbound carrier 测试与一文件范围矛盾 | 接受(presentation predicate 加 holder_carrier_unbound;PR-1 范围 +StateStore.ts) | §2.1/§2.2 |

R3:
| 条目 | 裁决 | 落点 |
|---|---|---|
| #1 owner-only 自行降级验收 | 历史 finding 已由 founder 层级原则终裁:owner-only 是正确层级路由,per-sender 不再是需求 | §1/§3.3/§4 |
| #2 replay 依赖可变 current holder | 接受(首次事务写 immutable `completion_disposition` workflow event,replay 只读它;零 schema) | §3.2 |
| #3 unbound carrier 被叫退 | 接受(carrier 身份 = pinned authority `carrierNodeId`,与 holder binding 状态解耦;unbound carrier → park + rebind 全链测试) | §3.2 |
| #4 error boundary 不 total | 接受(R4 #1/#5 进一步修正后定形) | §3.1 |
| #5 Fix B 硬依赖 Fix A | 接受(部署顺序硬约束 + A+B 组合回归;删「独立 cherry-pick」) | §1/§3.1 |
| #6 failed 误列 no-out-edge | 接受(正确集合 approved/completed/shelved/terminated;failed/rejected/deferred retryable 哨兵) | §3.1 |

R4:
| 条目 | 裁决 | 落点 |
|---|---|---|
| #1 lease-exhaustion 不覆盖 materialize 失败(frozen-resend 先命中) | 接受(R3 稿论断被真代码驳倒;R5 #1 进一步定形) | §3.1 |
| #2 no_code 同时命中 carrier→park 与 terminal | 接受(规则重排:先按本次 receipt 收敛域——无 gateOpened(含 no_code)→ terminal;gateOpened 域内才分 carrier;tpl_generic no_code 全链测试) | §3.2 |
| #3 disposition event 无升级前兼容 | 接受(legacy-missing-event 分支:从 immutable 证据重建一次并 checked 固化;证据损坏 → 省略字段 fail-closed;land/runner_ship/no_code + corrupt 测试) | §3.2 |
| #4 PR-3 cursor/原子性/限流矛盾 | 接受(定案 per-destination coverage:每 destination 独立 cursor/聚合域/限流;crash 由落后 cursor 补齐) | §3.3 |
| #5 异常 allowlist 过宽 | 接受(窄 typed 转换;SQLITE_*/IO/连接/未知一律 rethrow;BUSY/IOERR/CORRUPT 不消费行哨兵) | §3.1 |
| #6 迁移无可执行数据合同 | 接受(quiescent up + backfill destination:=lead_id + 显式 down 工具含冲突收敛;真实旧文件升级测试) | §3.3 |

R5:
| 条目 | 裁决 | 落点 |
|---|---|---|
| #1 Fix B 三处旧文字残留矛盾 + typed materialize error 是虚构 | 接受(删虚构分支:materialize 失败=基础设施域=rethrow 不消费行;新建 `WorkflowAdmissionClassificationError` 两个精确 mint sites;测试改「重复 claim/retry 至 horizon」+ frozen-at-adapter 哨兵) | §3.1 |
| #2 首写用弱 append 与冲突测试矛盾 | 接受(首次与 legacy backfill 均用 checked helper;冲突策略统一=completion 照常提交+响应省略字段;删 current-holder 旧表述) | §3.2 |
| #3 丢失 validated-Lead guard | 接受(destination 集合恢复 guard;candidate 显式扩展 destinationLeadId+aggregationScope;owner=sender 去重;lead_unacked 不变哨兵) | §3.3 |
| #4 down 工具留 sender cursor 冒充 owner coverage | 接受(新增 `destination_scope` 持久列;down=先删/归档全部 sender-scope 再恢复旧表;保留规则写死;sender>owner cursor 重扫测试;§6 milestone 扩到 PR-3) | §3.3/§6 |

R6:
| 条目 | 裁决 | 落点 |
|---|---|---|
| #1 mint sites 未按真实 DB/纯分类边界写准 | 接受(①移到 `generalizedExecutionContextForBinding` 内部、不包 `getWorkflowRun`;②只包纯 manifest classification;三个相邻 DB seam rethrow 哨兵) | §3.1 |
| #2 checked rejection 与基础设施失败不可区分 | 接受(引入 `WorkflowEventUidConflictError` discriminant;只 catch 它;SQLite/IO/fence rethrow=completion 回滚重试;BUSY/IOERR 注入测试) | §3.2 |
| #3 owner 漂移使「owner-scope 全保留」不可执行 | 接受(down 两步:清 sender-scope → collapse owner-scope 到旧键;cursor 只降不升;owner 漂移/双 pending/pending+receipt 三组真实旧表测试) | §3.3 |
