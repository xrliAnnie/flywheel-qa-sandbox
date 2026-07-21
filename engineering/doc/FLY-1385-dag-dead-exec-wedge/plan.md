# FLY-1385 死 exec 永久楔死 DAG node — 实施计划
Issue: FLY-1385 (https://linear.app/geoforge3d/issue/FLY-1385/bugdag引擎-死-exec-永久楔死-node失败无-completion-receipt-teardown-held-node-卡)
日期: 2026-07-20
基于: research.md(v3:并入 Codex design review R1+R2 裁定)

**Status**: codex-approved(design review 共 11 轮:R1-R7 原计划(R7 APPROVED)+ R8-R11 覆盖 Lead 增补的 W8(R11 APPROVED),2026-07-20/21;评审记录 `/tmp/codex-rescue-design-feedback-flywheel-FLY-1385-plan-round{1..11}.md`,thread `019f82d7-23b9-7850-964e-12fc4dbc3e2d`。实现备注:divergence page 观察 DTO 保持 immutable、stale-observation typed refusal 零写入——测试须锁两性质。实施另有 Annie 硬门,见 §0)

## 0. 硬门与协调(先读)

1. **Annie 流程硬门(直令,覆盖 W1-W8 全部)**:先出「之前/现在/改后」对照图设计稿(`founder-design-draft.md`)→ Tadashi relay Annie 批准 → 才许动**任何**实现代码。
2. **FLY-1396 正交**:不碰 candidate/**binding derive** 逻辑(work-kind→模板解析是 1396 的地盘,其 cutover 单开关也不管本单);本单改动 = **runs-route 入口编排**(W8:入口次序/opt-out/flag-off 政策归位/keyless 合成/通用 recovery 分类/双模线性化)+ **有界的 selection 语义**(W3 active-run 闸及 supersession;W8 flag 语义)——均为 Lead 显式划入本单、1396 rollout 链的前置 gate;candidate/binding derive 的语义一行不动。
3. 面 5(takeover)严格 ancestor+clean 双条件;要动 FLY-1185 binding guard 更多面就拆单。

## 1. 目标 / 非目标

**目标**:
- 死 exec 自动回滚 + 有界重试(≤3 次,backoff 1/5/15min);超限或 output 已写 ⇒ run→held + 告警(不再无声)。**资源类死亡例外**:quota/billing/auth 不走三次梯子、也不触发替补,立即 held+告警;唯一自动替补是 design 的 Fable provider/model 明确不可用时切到 GPT-5.6,且切换同时告警。
- enrolled 终态必落账(persist-only teardown,3 个 SQLite fact 原子)。
- run hold/terminate API(quiescence-gated)+ 审计;guard 文案指真实操作;`terminated` 合法终态。
- quiescent 影子 run 被新开工原子接管终结;影子 writer ownership-aware,不误写 engine run。
- takeover 接受 fast-forward 后代。
- 删 `FLYWHEEL_WORKFLOW_FORCE_LEGACY`(行为保持型 cutover)。
- vendor-at-dispatch:解析先于 admission,runtime 单一真相,覆盖全部 **3 个**生产 admission/launch 位点。
- node/session 终态一致或显式 divergence event。
- 混 schema 入口语义补齐(W8):v2 keyless 可派、flag off 全域回落 legacy、no-three-stage 引擎内短路对 v1/v2 一视同仁 —— 1396 迁 binding 的前置 gate。

**非目标**:影子生命周期全面重构(只做 supersession 终结 + ownership seam);node 级 retry/cancel API;orphan output 自动收养;FSM 改造;快照 digest 链改动;run 级 API 接管 runner 物理清理。

## 2. 改后总览

```mermaid
flowchart TD
    subgraph TD1 [persist-only enrolled teardown(W1.4)]
        E1[enrolled exec 终态信号] --> E2[单 SQLite 事务:信号事件 + session 固定映射投影<br/>+ durable teardown fact(3 facts)]
        E2 --> E2b[提交后 best-effort CommDB enqueue<br/>(Layer-2 reconcile 收敛)]
        E2b --> E3[return —— 零 legacy hook]
    end
    subgraph SW [sweep(W1.2,piggyback 1s reconcile)]
        S0[候选:teardown facts ∪ running node ×<br/>session ∈ 完整不可逆终态集] --> S1{zombie 已强证?}
        S1 -->|否| S2[probeGeneralizedLaunchLiveness]
        S2 -->|alive/unknown| SH[不动账;unknown 连 3 次告警一次]
        S1 -->|是| S3{receipt?}
        S2 -->|dead| S3
        S3 -->|有| SP[投影收尾]
        S3 -->|无| S4{attempt 已有 output?}
        S4 -->|有| S6[run→held + dead_execution_after_output + 告警]
        S4 -->|无| S5{ordinal ≤ 1+3 且过 backoff?}
        S5 -->|是| R[rollbackDeadWorkflowNodeExecution]
        S5 -->|超限| S6b[run→held + retry_limit_escalated + 告警]
        R --> N[消费域下轮起新 exec(最高 ordinal)]
    end
```

## 3. 工作项

### W1 — 引擎死 exec 侦测 + node 有界重试(面 1+2)

**W1.1 StateStore 原语 `rollbackDeadWorkflowNodeExecution(input)`**(单事务,幂等):
- 入参:`{ runId, nodeId, attempt, deadExecutionId, newExecutionId, reason, livenessEvidence, now }`。
- 守卫(typed refusal):
  1. run 存在、engine_owned=1、active;
  2. node (runId,nodeId,attempt) running 且 execution_id===deadExecutionId;
  3. 无 receipt(receipt 先赢 ⇒ `receipt_exists`);
  4. session ∈ 完整不可逆终态集(`ZOMBIE_IRREVERSIBLE_TERMINAL_STATUSES`)**或**存在匹配的 durable teardown fact + 调用方 fresh dead 证据(row 缺失场景同此);
  5. **output 守卫**:`workflow_node_outputs(run,node,attempt)` 已有行或该 attempt 有已消费 output credential ⇒ 同事务 CAS run→held + `dead_execution_after_output` + refusal(不自动重试);
  6. dispatch ordinal 计数 < 1+3。
- 写:revoke 未消费未撤销 credential → checked-append `execution_dead_rolled_back` → node 易主 (attempt, newExecutionId, pending) → 铸新 ordinal。老 ledger 行不动。

**W1.1b output writer 补竞态守卫(R2#2)**:`submitWorkflowNodeOutput` 当前在**事务外**读 credential、事务内无条件消费 —— 与 rollback 存在第三交错(writer 读到 live credential → rollback 提交(revoke+易主)→ writer 事务用陈旧 credential 落旧 output,同 attempt 被占死,新 exec 无法完成)。修:credential 的 consumed/revoked/expiry 判定**移入写事务**,并增加守卫 `workflow_run_node(run,node,attempt).execution_id === credential.execution_id`;以条件 UPDATE credential(`consumed_at IS NULL AND revoked=0`)的 row-count 为线性化点,失败整体回滚。两连接测试只允许两种结局:output 先赢 ⇒ rollback 守卫 5 转 held;rollback 先赢 ⇒ writer 得 `credential_revoked`/stale,零写入。

**W1.2 dispatcher sweep 域**:候选双源(durable teardown facts ∪ running node × session ∈ 完整不可逆终态集);除 zombie 强证外一律 `probeGeneralizedLaunchLiveness`,仅 dead 回滚;unknown 连 ≥3 次告警一次(进程内计数,重启清零仅延迟 advisory,文档明示);backoff 读最新 ordinal created_at;超限 `escalateWorkflowRunRetryLimit`(CAS active→held + event + 告警);per-run try/catch;双实例并发安全。

**W1.2b Annie 2026-07-21 资源死亡裁决(覆盖通用梯子)**:terminal error 分类为 quota/billing/auth 时,无条件立即 run→held + durable escalation,不分配新 ordinal且不触发替补。与资源错误互斥的唯一自动替补是:**当前 design runtime 恰为 `claude-fable-5`**且错误明确表示 Fable provider/model 不可用,允许一次切为 `codex/gpt-5.6-sol/xhigh`,并在同一回滚事务 enqueue `design_fallback` 告警。不得自动换到其他模型/供应商。

**W1.3 supersession 守卫**:消费域按 (run,node,attempt) 只消费最高 ordinal;`markStarted` 对易主 node no-op;`consume()` getSession 检查:非不可逆终态才 markStarted,终态无 receipt ⇒ throw `engine_execution_dead`,终态有 receipt ⇒ 投影收尾;`workflow-shadow-writer.reconcileSideEffects` 断言测试:只补 ledger 证据,不回写 node 归属。

**W1.4 persist-only enrolled teardown(R2#4 修正原子边界)**:
- 原语 `recordEnrolledTerminalSignal`:**单 SQLite 事务落 3 个 fact** —— (a) 终态事件(session_failed/session_completed,insertEvent dedup);(b) session **固定映射**投影:物理 completed→`completed`、failed→failureKind==='goal_blocked'?`blocked`:`failed`(不复用 legacy route orchestration 映射,保证落进不可逆终态集,sweep/守卫可见),经既有 `applyTerminalTimestamp` + `bumpLifecycleRevision` 维护 terminal_at/revision;(c) durable teardown fact(`generalized_teardown_recorded`,绑 source event id)。
- **CommDB 终态 enqueue 在事务提交后 best-effort**(TerminalCommDbSync 是进程内 Map,不可入 SQLite 事务;丢失由既有 Layer-2 reconcile 收敛)。
- 两 sink 调原语后 return,**零 legacy hook**(auto-QA/phase handoff/QA-loss respawn/turn-belt/founder 通知/post-ship;spy 零调用测试)。
- event-route 非 comm 源 held 分支:同款落账 + 200 `{ok:true,generalized:true,teardown:'held_recorded'}`。

**W1.5 竞态线性化 + stale completion 收敛**:
- receipt 先赢 ⇒ rollback `receipt_exists` refusal;rollback 先赢 ⇒ `commitEnrolledCompletion` 返回 typed `stale_execution_superseded`,**该检查置于 produces_output 的 `missing_output` 检查之前**(R2#4:否则产 output 的旧 exec 先撞 missing_output 走 retryable 死循环);event-route 对该 reason 答 200-settled;marker reconciler settled 收敛删 marker(其余 4xx quarantine 不动)。
- 四顺序测试 + W1.1b 两结局测试。

**W1.6 divergence + durable 告警(R2#6 + R3#1/#2/#4 落地合同)**:
- **B 类 divergence 生产者(R3#4 + R4#4 + R5#2 有界增量域)**:候选域 = engine-owned run(不限 status)的 done node,但**不做全史每秒重扫** —— 新增 durable checkpoint 表 `workflow_divergence_check(execution_id PK, checked_lifecycle_revision)`:sweep 每 tick 只取「session lifecycle_revision > checked(或无 checkpoint)**且 session.status ∈ ZOMBIE_IRREVERSIBLE_TERMINAL_STATUSES**」的 done-node execution(R6#1:非终态 done-node 不入页 —— 不占页头不饿死后面的真候选;它终态化时 revision 前进自然入页),**capped page**(如 200/tick)。落账走**单事务同步原语 `commitWorkflowDivergenceObservation`**(R6#1):事务内重读 node 归属 + session,要求与**观察到的精确 revision/status 一致**(过期观察 ⇒ typed refusal,下轮重扫);不可逆终态且 ≠ completed ⇒ checked-append `divergence:{run}:{node}:{attempt}` **与** checkpoint 推进**同事务原子**(杜绝 checkpoint 先提交、append 前崩溃的永久漏记);completed ⇒ 仅推进 checkpoint;checkpoint 更新单调 `MAX(existing, observedRevision)`(旧并发 worker 不能回退)。配套 status/revision 索引;重启即恢复。测试:大历史每 tick 行数有界(query-plan/分页断言)、event/checkpoint 间故障注入(不可分裂)、N-vs-N+1 乱序双 worker、页前 >200 条 done+非终态行不饿死后面的终态 divergence、重启 cursor 恢复、revision 前进重入、boot 重放幂等、completed 一致态不报、active→held/terminated/completed 三种先赢竞态、不可逆终态集除 completed 全态(含 deferred/shelved)。
- **告警传输 = durable outbox + lease(R3#2 + R4#3)**:claims.db 是 claim-before-send 去重账,不是投递 receipt。新 StateStore 表 `workflow_alert_outbox`(escalation_uid PK、payload、**state pending→delivering→sent|failed**、attempt、**lease_owner、lease_expires_at、generation**、last_error):escalation 落账时同事务 enqueue pending。投递协议(boot one-shot 与周期 tick 复用同一原语,天然抗 boot-vs-tick 重叠与双实例):**事务内原子 claim**(pending 或过期 lease → delivering,分配唯一 attempt+generation)→ 发送(eventId = `{escalationUid}:{attempt}`,每次尝试唯一 ⇒ claims.db 不挡重试)→ 成功:**同一事务** CAS(仅本 generation)delivering→sent + checked-append `alert_posted:{escalationUid}`(不许分两步,防 sent-without-receipt);失败:按 generation 回 pending(attempt 保留),第 3 次转 failed(dead-letter,不伪装 posted);旧 generation 迟到的成功 CAS 失败即丢弃。**at-least-once 明示**:send 成功→CAS 前崩溃可能重发一条(lease 到期后),窗口窄,接受——去重兜底靠 outbox lease,非 eventId。测试:crash-after-claim-before-send 收敛重投、crash-after-send-before-CAS 重复但收敛、duplicate-result 不当 posted、永久失败 dead-letter、boot-vs-tick 同 row、双实例同 row、旧 generation 迟到成功被拒。
- **告警身份钉入(R5#3)**:`AlertPayload` 必填 `projectName+leadId`,而 dispatcher 现有 `resolveLeadId` 依赖 session row —— missing-session 死 exec(W1/quiescence 明确接纳的形态)会让 escalation 无 lead 而 dead-letter,违背"不再无声"。修:**escalation 事务在 enqueue outbox 时就钉入投递身份** —— 从 run/start authority 解析(run.project_name + run.issue_id 的存量 labels 走 `resolveLeadForIssue`),不依赖死 session row;解析不出 ⇒ fail-loud 落 project 级默认 Lead/统一 Alerts 兜底身份并在 payload 标注 `leadResolution:'fallback'`。**delivery 判定只认 `sent`/durable `queued`**;unknown-lead/no-channel/dead-letter 一律记 outbox failed。测试:真 routed-notifier 集成测试跑 retry-limit escalation 且 execution 的 session row 缺失(只断言 sessionKey/route 分类不算数)。
- **wiring(R3#1 + R4#1 合同分层)**:dispatcher options 增 `alertSink` late-bound holder;**boot 补发 one-shot 不放 dispatcher.start()** —— 放 plugin 的 **holder 填充点之后**显式调 `dispatcher.reconcileWorkflowEngineAlerts()`(post-wiring boot-ticket 模式,plugin.ts:9286-9314 同位),周期 sweep 不变;**独立于 sweep flag 恒跑**。新增 kind `workflow_engine_escalation` 的三层合同**分开写**(R4#1:不得混成一个 entry):① payload:severity=**`severe`**(合法词表仅 info|warning|severe);② `KIND_CONTRACTS` 条目:`{ owner: "claude", arc: "human_by_design", remediationRef: "FLY-1385 run hold/terminate API" }`(exhaustive Record,缺项编译失败 + validateKindContracts fail-loud);③ routing 断言测试:sessionKey=`wf:{runId}`、**不**入 `ISSUE_PROGRESS_KINDS`、走统一 Alerts 频道 route。集成测试按真实 plugin 构造顺序(不许预填 holder 的单测冒充)。
- `holdStrandedGeneralizedExecutions` 注释更新。

**W1.7 checked-append + UID 词表**:`appendWorkflowRunEventChecked`(同 UID 异 payload fail-closed)。词表:`dead_rollback:{run}:{node}:{attempt}:{deadExec}`、`retry_limit:{run}:{node}:{attempt}:{maxOrdinal}`(policy 变更不撞 checked equality)、`dead_after_output:{run}:{node}:{attempt}:{deadExec}`、`divergence:{run}:{node}:{attempt}`、`teardown_recorded:{run}:{exec}:{sourceEventId}`、`alert_posted:{escalationEventUid}`、`vendor_resolved:{run}:{node}:{attempt}:{exec}`、`run_held_by_operator:{run}:{clientRequestId}`、`run_terminated:{run}:{clientRequestId}`(operator)、`run_terminated:{run}:supersession`(W3,一 run 只终结一次)。

### W2 — run 管理 API(面 3)

- `POST /api/runs/:runId/hold`(active→held)/`POST /api/runs/:runId/terminate`(active|held→terminated):
  - 显式 `requestAuthKind==='master'`;审计记可信 auth principal;body `{reason≤500 必填, clientRequestId 必填}`,同 id 重放返回首次结果。
  - **quiescence 门(与 W3 共用同一 store validator,R2#5 + R3#3 + R4#2 唯一谓词)**:两层 API —— async 编排层 `collectRunQuiescenceEvidence(store, probe, runId)`:snapshot run-attributed execution 全集(见 W3)→ 逐个 probe → 产证据数组 `{executionId, sessionStatus, lifecycleRevision, liveness, observedAt, trustedZombieEventUid?}`;同步 store validator 在**事务内重新枚举全集**,对每个 execution 施加**唯一谓词**:
    - 有 session row:`status ∈ ZOMBIE_IRREVERSIBLE_TERMINAL_STATUSES` **且** status/revision 与 fresh 证据(TTL 30s)一致 **且**(liveness==='dead' **或** 事务内验证 trustedZombieEventUid 确实绑定该 execution);
    - 无 session row:证据字段显式 `sessionStatus:null, lifecycleRevision:null` + durable attribution(execution 在 node/ledger/binding 账内)+ fresh dead probe;
    - unknown 一律拒绝;任何新增 execution/缺证 ⇒ 409 `run_has_live_executions`(列 executionIds,指 per-session terminate/close-runner)。
    W2 与 W3 调**同一个** validator。测试:running+dead ⇒ 409(DB 未终态不许终结)、伪造/错绑 zombie UID ⇒ refusal、missing-row 三分支(有 dead 证据放行/无证据拒/unknown 拒)。
  - CAS + 审计 event 同事务;影子 run 同样适用。
- `terminated` 入合法词表;guard 文案(`ACTIVE_DAG_RUN_RECOVERY_HELD`/`DAG_RUN_ACTIVE`/selection hold)改指真实端点。

### W3 — 影子 run supersession + ownership seam(面 4,R2#1 升级)

- **run-attributed execution 全集**(新共享 reader `listRunAttributedExecutions`):union of `workflow_run_node.execution_id` ∪ dispatch ledger execution_id ∪ `workflow_execution_binding`(R2#1:影子普通 spawn 零 binding,只看 binding 会把活影子误判 quiescent);session row 缺失 ⇒ **不** quiescent(除非 fresh dead probe)。
- **异步证据 → 同步事务的桥(R3#3)**:`supersedeQuiescentShadowRun` 是同步 store 原语,**入参带 W2 同款证据数组**;事务内重新枚举全集,逐 execution 校验证据(TTL 30s 内、status/revision 未变、dead/zombie 证据);probe 后新增的 execution 或缺证 ⇒ `shadow_run_live`。probe 的 await 发生在编排层:`resolveWorkflowTemplateSelection` **改 async**(不触碰 FLY-1396 candidate/binding derive),内部对影子 run 调 `collectRunQuiescenceEvidence` 后再进同步 store 原语。**调用方类型改造(R4#5)**:runs-route:1150-1152 的局部类型 `ReturnType<typeof resolveWorkflowTemplateSelection> | undefined` 会随 async 变 Promise —— 导出显式 `WorkflowTemplateSelectionResult` 类型(或 `Awaited<ReturnType<...>>`)并在 :1157 加 await;此调用方改造入结构测试清单(编译级守卫)。
- `supersedeQuiescentShadowRun` 其余守卫:active run 非影子 ⇒ `active_run_not_shadow`;quiescent ⇒ CAS active→terminated + checked-append `run_terminated:{run}:supersession`(reason=`superseded_by_engine_start`)。
- **supersession 并入 W8 共享 entry-admission 事务的 engine 分支(R10#1)**:影子终结**不再是独立事务** —— 探针与 candidate/replay 复核在事务外;之后**单个同步事务**内依次:证据复核(TTL/revision)→ **无 legacy durable claim/session 复核** → 影子 active→terminated CAS + supersession checked-append → engine run+reservation materialize。两种结局:(a) legacy 已赢 ⇒ **零写 refuse**(影子保持 active、无 supersession event);(b) engine 获准 ⇒ 影子终结与 materialize **原子不可分**。原「terminate 后 materialize 前崩溃留 terminated 影子」的中间态随之消失(单事务无此窗口)。测试:barrier —— legacy 在 engine 探针后、supersession 前落 claim ⇒ 影子仍 active 零 supersession event;反向赢家;逐语句故障注入证影子终结/event/run/reservation 不可分裂。
- selection `:193`:engine/dag run ⇒ 照旧抛 hold;影子 ⇒ 走上述共享事务(成功即 materialize 完成,唯一索引自然通过);`shadow_run_live` ⇒ 照旧抛(文案给 per-session 指引)。
- **await 期间的 selection TOCTOU 防护(R5#1)**:probe await 返回后、动影子之前:(a) **重读 start reservation** —— 已被同 key 并发赢家创建 ⇒ 走既有 validated replay 返回,不 supersede;(b) **重跑 candidate resolver**,要求完整 selection identity(category/template/revision/schema/source/digest)与 await 前快照一致,漂移 ⇒ typed fail 重进 selection(不 mutate 影子);(c) materialize 增加 expected revision/digest 入参,事务内不一致 ⇒ refuse(防 selection 认 N、快照落 N+1 的分裂)。测试:paused-probe 期间 publication/rebind 漂移;同 idempotency-key 并发赢家(迟到方拿 replay 而非 `active_run_not_shadow`)。
- **shadow writer ownership seam(R2#1 后半 + R3#5 精确化)**:ownership 限制**只作用于无 runId 的 issue 级分支**(`applyWorkflowShadowBatch` issue 分支、`currentAttempt`、`onShipFinalized` 的 active-run 查询只认 engine_owned=0;查到 engine run ⇒ typed no-op + warn)。**显式 runId 的 side_effect 分支保持 identity-bound 且支持两种 ownership**:新增 `expectedEngineOwned` 入参 —— engine dispatcher `markStarted` 传 1,shadow `reconcileSideEffects` 传 0(它合法作用于已 terminated/completed 的影子 run),mismatch ⇒ typed refusal。测试:engine markStarted 正向、completed 影子 reconcile 正向、mismatch 拒绝。
- 测试:quiescent 影子 supersession 走通留审计;零-binding 活影子(main/design spawn,仅 ledger+node 有 exec)⇒ `shadow_run_live`;engine active 后迟到 onWake/onNodeComplete/onShipFinalized ⇒ no-op 不污染 engine run;并发抢 active slot 撞唯一索引;ship-finalize 不触 engine run。

### W4 — takeover fast-forward(面 5)

- gitChecker 加 `isAncestorOf(worktreePath, ancestor, head)`(`git merge-base --is-ancestor`;错/非零 → false,fail-closed)。
- `Blueprint.ts:1179`:`head === ctx.startPoint || await isAncestorOf(...)`;其余不动。

### W5 — 删 `FLYWHEEL_WORKFLOW_FORCE_LEGACY`(面 6,行为保持型 cutover)

- 生产 env 行已删 ⇒ 现实 = force 恒 unset。只删 flag 定义/registry 注册/ship-eligibility 的 **force-skip 分支**;非 force 分支字节保持 —— 精确语义(R2#7):durableQa + force off 时,claims-read disabled 或 execution unbound ⇒ **fail-closed**(`ship-eligibility.ts:300-315`),不落 legacy `auto_qa_record` 查询;非 durableQa 路径不动。
- 三场景等价测试写明删前/删后精确 reason/result(enrolled durable QA / unbound / claims-read disabled);grep 归零范围 = 生产源码 + 当前 config/runbook。

### W6 — vendor-at-dispatch(面 7;**3 个生产 seam**,R2#3)

- **Annie 2026-07-21 最终路由裁决**:`DEFAULT_PHASE_DISPATCH`/当前已配置模型仍是 source of truth,不做盲目自动换模。替补 allowlist 仅 `{Fable, GPT-5.6}`;唯一自动替补为 design `claude-fable-5` 不可用 → `codex/gpt-5.6-sol/xhigh`,其他 replacement 一律拒绝并告警。`FLYWHEEL_VENDOR_AT_DISPATCH=0` 是紧急逃生开关,回到 pinned snapshot 且不写 live-resolution audit。
- seam 清单:**① runs-route start 段;② dispatcher `consume()`;③ `bridge/actions.ts` `handleRetry`(:904-912 admission、:1052-1067 launch)** —— 三处全部改为:先 `resolveNodeDispatchAtLaunch` → `{triple, source}`。schema-v1 phase 从当前 `DEFAULT_PHASE_DISPATCH`/受支持的 phase override 解析;schema-v2 从当前 published template 解析;解析失败 → snapshot_fallback(不凭空换模);批准的 design fallback 走显式 allowlist 分支。admission 以 triple 为入参,同事务重做 same-vendor 校验(对 actual predecessor runtime)、写 immutable `workflow_execution_runtime`、checked-append `dispatch_vendor_resolved` → launch 参数**只读** durable runtime;replay/已有 binding 返回落账 triple;admission 后崩溃/重试不重解析。
- 结构守卫测试:`rg 'admitGeneralizedWorkflowExecution\('` 生产调用方清单快照(新增调用方必须显式进清单,防未来遗漏)。
- `FLYWHEEL_VENDOR_AT_DISPATCH=0`:返回 snapshot pinned + 不写新审计 event(字节兼容 sentinel)。
- 快照校验链/digest/schema 零改动。

### W8 — 混 schema 入口语义补齐(面 8,Lead design 阶段增补;1396 rollout 链前置 gate)

现状(research §2.9,已核):binding 迁到 v2 模板后,keyless/非 master 派发全 409;v2 + flag off 也 409(flag 不是保护);`no-three-stage` label 只挡 v1 政策域,v2 独立入口静默绕过。**设计落在 runs-route 编排层 + selection 双侧**(R8 全 6 项已并入),不挂 FLY-1396 的 cutover 开关:

- **入口总次序(runs-route,R8#1/#5 + R9#2 修正)**:① **active engine-run recovery 分类**(marked + unmarked v2 兼容分类)→ ② **reservation-domain 侦测**(R9#2:此步只做 candidate-free 的**存在性侦测**判 fresh,**不是**响应缓存直接 replay —— "fresh" = 无适用 start reservation 且无可恢复 active engine run;真正的 replay/re-drive 走既有校验路径:master auth 前置、project/issue 身份、checked `selection_digest` 比对一个不少,fresh 判定之后 replay 路径咨询 candidate 是允许的)→ ③ **no-three-stage opt-out**(fresh 才到这)→ ④ candidate preflight → ⑤ 政策/selection(以下各子项)。测试:scoped/tokenless 持 master key、同 key 改 taskCategory/template/selectionReason/Lead 身份、跨 issue/project 的 key —— 全部拒绝且不返回缓存响应。
- **入口双模线性化原语(R9#1)**:通用 active-engine 守卫是 check-then-act,不是线性化点 —— 并发下「读旧标签的请求 materialize v2」与「读新标签的请求过守卫起 legacy」仍可交错(flag 迁移窗同理)。定义**共享 entry-admission 原语**,两模共用:legacy 侧 —— 在同一持久事务/canonical issue mutex 内**复核无 active engine run + durable 落 legacy launch claim** 后才放行;engine 侧 —— 同一原语内**复核无未决 legacy launch/session + durable 建 run/reservation** 后才放行;若复用既有 issue mutex,两侧都必须参与,durable claim 在放锁后仍然有效;**不许**跨探针/跨 runner spawn 持锁。测试:barrier 控制的双请求两种赢家次序(label 漂移 + flag 漂移,含不同 engine 起始 node role),恰一模获准、败者 typed 409、零孤儿 run/reservation/claim。
- **(d) no-three-stage opt-out 放 runs-route(非 selection 顶部,R8#1)**:现实调用链里 `resolveWorkflowTemplateCandidateSchema`(:926-959)先于 selection 跑,坏 binding/revision 会在 selection-top 检查前就 409 —— 违反 candidate-free。故 opt-out 放 **active-run 分类与 replay 之后、candidate preflight 之前**:fresh main + 有效 `no-three-stage`(dispatch-time `normalizedIssueLabels` 权威)⇒ **完全绕过** candidate 解析与 generalized selection,走既有 legacy 请求/政策校验(字节兼容);零 workflow_run 行/零 reservation/零 shadow enrollment。active **shadow** run 场景:legacy 照今日行为继续(W3 ownership seam 继续观察 engine_owned=0 影子),**绝不** mutate/terminate engine-owned run。优先级契约(no-three-stage > 候选考虑,v1/v2 一视同仁)以 fixture 落地:坏 v2 binding + label ⇒ legacy 不 409;live/quiescent 影子 + label 各态。
- **(b) v2 + 主 dispatch flag off ⇒ 字节等同 legacy(R8#3 补路由侧)**:仅 selection 返 null 不够 —— `:1022-1027` 对 `candidateSchemaAtEntry===2` 跳过 incumbent three-stage 政策块,会把 v2-bound 项目 flag-off 变成 legacy **单 session**(而非项目应有的 legacy 三段)。修:路由政策改按「engine candidate **admitted**」判定而非裸 schema —— 主 flag off 时 v2 与 engine-absent/v1-回落同等参加 incumbent three-stage 政策 + 请求校验;该场景**不**合成 `wf2-auto-` key、**不**打 `workflow_v2` 标。v1 truth table 保持(claims/generalized 半开配置照旧 fail-loud)。等价 fixture:`pipeline.three_stage` true/false 两态,断言 role/shared-branch/dispatch 字段/behavior 快照/响应/零 workflow 行全形状(不只零行)。
- **(a) v2 keyless key 合成 + entry 标记**:flag on + schema-2 candidate + 无显式 key ⇒ 合成 `wf2-auto-${randomUUID()}`(对齐 dag-auto 位置);materialize 事务钉 `entry_kind='workflow_v2'`。
- **v2 recovery = 通用 marked-engine recovery 分类 + 按 entry kind 分策(R8#2)**:不许机械放宽 dagRun 谓词 —— 现 wrapper(:835-875)要求 `pipeline.dag===true` + DAG 请求校验,下游注入 DAG-only templateAuthority/dagBehavior(:1129-1139, :1420-1423),对 v2 会错误 hold/错误拒参/错误持久化。新分类按两种 entry kind 分支:共享不变量(candidate-free、active-run/reservation/key/auth/snapshot 校验)一致;`pipeline_dag_v1` 才要求 pipeline.dag + DAG 校验 + DAG authority/behavior;`workflow_v2` 用 pinned schema + workflow flags + fresh-v2 launch 形状;错误类型/文案通用化。测试:v2 recovery × pipeline.dag=false、无 DAG authority/behavior 污染、dispatch disabled、key/auth/role 不匹配、live successor。
- **unmarked 存量 v2 run 兼容(R8#4)**:已存在的 v2 start-reservation run 是 `engine_owned=1 + entry_kind=NULL`,两-kind 谓词看不见 ⇒ 双保险:(i) recovery 分类增加**窄兼容分类器**:active + engine_owned=1 + 有 start reservation + pinned snapshot schema=2(**不许**只按 engine_owned 分类 —— 显式 v1 run 同值);(ii) **每个 legacy 短路(no-three-stage/flag-off)前置通用 fail-closed 守卫**:该 issue 存在任何 active engine-owned run ⇒ 不得起 legacy,走 recovery/hold 语义。fixture:unmarked active v2 × no-three-stage、× flag-off ⇒ recover/hold/拒,绝不 legacy 并行。
- **(c) v2 auth 面:本单维持 master-only**。理由:generalized start 现实路径都是 Lead 侧 master 调用;(a) 落地后 keyless 摩擦消除;放宽到 scoped/Lead 直派属 1396 work-kind 产品语义(auth 收紧易、放宽难回收)。
- 其余 fixture:v2-bound + flag on + keyless master ⇒ 合成 key 起 v2 run 且 recovery 可 replay;非 master ⇒ 409;**仅 wildcard binding 项目 keyless legacy start 不破**(1396 回归);label 立单后增删 ⇒ dispatch-time 判定生效;**completed/terminated v2 reservation + 同 key + 新加 label ⇒ 走 replay/拒绝而非 legacy**(R8#5);keyless/异 key + label 的真 fresh ⇒ legacy。

### W7 — 文档 + founder 设计稿

- `founder-design-draft.md`(已产)→ Tadashi relay Annie。
- guard 文案、CLAUDE.md 里程碑、注释更新随实现 PR。

## 4. 测试计划(TDD;§3 各节已内嵌关键测试,此处为验收汇总)

1. **1335 型**:zombie 死 exec ⇒ ≤N tick 回滚+新 exec;4 连死 ⇒ held+escalation+告警。
2. **1356 型**:quiescent 影子 supersession ⇒ /start 走通+审计;零-binding 活影子 ⇒ 409;唯一索引并发反例。
3. **divergence**:done node × session 事后 failed ⇒ 恰一条 divergence,node 不动;running node ⇒ 走回滚。
4. **teardown**:3-fact 原子落账 + 零 legacy hook(spy)+ CommDB post-commit enqueue;HTTP 200 held_recorded。
5. **output**:die-before/die-after-output;W1.1b 两结局竞态(双连接)。
6. **竞态四顺序** + stale-before-missing_output 次序断言 + marker settled 收敛。
7. **takeover** 五象限(等值/后代/无关/dirty/探针错)。
8. 结构守卫:supersession 双守卫突变测试;credential revoke 必要性;checked-append UID 冲突;双实例 sweep;shadow reconcileSideEffects;W6 调用方清单快照。
9. 故障注入:rollback 后重启;held 后告警前重启(boot 补发);outbox 全竞态矩阵(见 W1.6:claim 前/后崩溃、boot-vs-tick、双实例、旧 generation);admission 后 spawn 前重启(读 runtime 不重解析)。
10. W2:auth/quiescence(含 terminal-但-alive 拒绝)/clientRequestId 重放/审计 principal/影子 run。
11. W5 三场景等价;W6 三 seam × 三源 + same-vendor(predecessor runtime)+ `=0` sentinel。
12. reverse-compat sentinel:非 enrolled legacy 全链字节不变;alive/unknown 永不改账。
13. 真机 QA:529 隔离房重放 1335 型(真 tmux 杀窗)+ supersession 后真 /start。

## 5. 上线(分阶段)

| 阶段 | 内容 | 开关 |
|------|------|------|
| A | W1 store 原语(含 W1.1b writer 守卫)+ persist-only teardown + 竞态/重启测试 | `FLYWHEEL_ENGINE_DEAD_EXEC_SWEEP` default ON,可在线直关 |
| B | W1 sweep/supersession/告警 wiring + W2 API;真机 fixture 验证 | 保持 default ON;异常时 direct-toggle OFF |
| C | W3 supersession + ownership seam | 独立可回滚 |
| D | W4 takeover(并行) | 无(fail-closed 收窄型放宽) |
| E | W5 cutover(等价证据齐后) | 无 |
| F | W6 三 seam 改造(Annie 批准 + A-C 落定后) | `FLYWHEEL_VENDOR_AT_DISPATCH` |
| G | W8 入口语义(route 编排 + 有界 selection;与 C 协调排布,1396 迁 binding 前必须落) | 无(行为收敛型:409→legacy/合成 key;wildcard 回归 fixture 锁底) |

- 存量楔死 run 不迁移;部署 = Bridge 单次重启,Blueprint 侧 merge+pull 即生效。

## 6. 风险

| 风险 | 缓解 |
|------|------|
| 迟到完成/迟到 output vs 回滚 | W1.5 线性化 + W1.1b 写事务守卫 + 次序断言 |
| 探针误判 | dead 才回滚;unknown 保守;去抖;告警不动账 |
| 老 intent/迟到 shadow hook 复活 | 双 supersession 守卫 + ownership seam + 突变测试 |
| output 已写死 exec | held+告警,不自动重试 |
| W3 handoff 崩溃/并发 | supersession 与 materialize 单事务原子(R10#1),零中间态;legacy 赢家 ⇒ 零写 refuse |
| W6 authority 分裂/漏 seam | 解析先于 admission、runtime 单一真相、调用方清单快照守卫 |
| 告警丢/重 | durable outbox + lease/generation + boot 补发(at-least-once 明示,重复窗=send 成功→CAS 前) |
| 与 FLY-1396 冲突 | §0.2 清单;不碰 candidate/binding derive;W3/W8 的 selection/入口改动是 Lead 显式划界的前置 gate |
| W8 入口语义回归(v2/legacy 双向) | 等价 fixture 全形状断言 + wildcard 回归 + unmarked v2 fail-closed 守卫 |

## 7. Founder 增量裁定:A 加强版(2026-07-21)

原 W1 上线开关改为硬验收:`FLYWHEEL_ENGINE_DEAD_EXEC_SWEEP` **default ON**，且 dispatcher 每次 reconcile tick 现场读取。direct-toggle console 修改运行进程的 env 后，同一 dispatcher 的下一 tick 必须立即观察到 OFF/ON，无需 Bridge 重启；OFF 只暂停新的死亡判定/换人，不撤销已持久化的安全告警。

每次 `dead` 判定成功换人时，同一事务登记 execution 身份绑定的 durable watch。watch 的基线包含该 execution 的 launch-commit marker mtime、session `commit_count`、该 execution 在 CommDB 的写入游标，以及它原 tmux target 的输出摘要。前三者是 execution-bound 强信号：任一前进才写 `dead_execution_activity_after_replacement`，并通过 workflow alert outbox 对 issue thread + Lead escalation chain 发 severe 告警。tmux 是可被替补复用的物理窗口弱信号，只写 diagnostic log、绝不消费 watch 或触发 severe page；每轮仍按旧 execution 身份重解析 target，以保留现场线索。没有 session row 时 issue copy 直接用 payload 中已钉住的 issue/Lead 身份找 thread。基线无法建立则本 tick 不换人，后续读/probe 不确定时继续观察，不作误判。watch patrol 每 tick 最多 200 条并用稳定 cursor 轮转，存量超过一页时不饿死尾页；run 一旦不再 active 立即删除所属 watch，否则在 24 小时 TTL 边界删除，且 prune 同样每 tick 最多 200 条、先于 probe 执行。相同 run/node/attempt 第二次及以后发生死亡换人时，另发 `repeated_dead_execution_pattern` 模式告警。

新增 TDD 验收:

1. 同一 dispatcher 上 `0 → 1`，下一 tick 从零 probe/零 mutation 变为正常换人；flag registry 声明 call-time + direct proof。
2. 换人后旧 exec 的 commit marker、session commit 或 CommDB 写入任一变化，恰一次 severe alert；tmux 输出变化只写 diagnostic log，物理窗口被替补复用时不得 page；Bridge 重启后仍能从 durable watch 继续观察。
3. 同 node 第二次死亡换人产生模式告警；单次死亡不误报；probe/CommDB/tmux unknown 不告警且 watch 保留。
4. 基线采集抛错时，旧 execution/node 归属保持不变，零新 dispatch、零 watch；issue-thread 路由必须用旧 execution/issue 的钉死 metadata 解析，不能把 `wf:{runId}` 当 execution id，且 session row 缺失也能到 thread。
5. 201 条 active watch 连续两 tick 必须覆盖第 201 条；旧 execution 的 tmux target 改名/迁移后继续捕获并记录新输出，但不升级为强信号。
6. active run 的 watch 在 24 小时 TTL 前保留、边界时删除；run held/terminated/completed 后下一 tick 立即删除；过期 watch 必须在 probe/page 前清理。
