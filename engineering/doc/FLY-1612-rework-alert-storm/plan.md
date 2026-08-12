# FLY-1612 rework 告警风暴治理 — 实施计划

Issue: FLY-1612 (https://linear.app/geoforge3d/issue/FLY-1612/告警治理-workflow-rework-held-重试无去重无退避直发-issue-thread-同一句话对-founder)
日期: 2026-08-12
基于: research.md
修订: R6(R2-R4 折入 Codex R1-R3;R5 折入 Codex R4;R6 折入 Codex R5:kill switch 暂停 stall clock / pause 与 genuine stall 独立键空间 / recovered prior 有界读取)

## 0. 一句话

把被漏在 strike 机制外的 rework「held 家族」失败并入现有 `settleWorkflowReworkFailure` 退避/终局机制(其中 `persisted_target_missing` 在耗尽时**原子移交 FLY-1648 pane-loss 恢复**而非 needs_lead),同时把 stall 告警去重键从 claim 计数器改为 episode 稳定键,并给「永不可能成功」的激活加即时终局 —— 每个 failure episode 的告警量从 ~1272 条压到 ≤4 条(operator pause episode 固定为 pause severe + resume warning 两条),1s 热循环消失,零新表、零新 flag、零 migration。

## 1. 改动清单(主体在 `packages/teamlead`,flag ledger 同步在 `packages/config`)

### Change 1 — held 家族并入 strike 机制(缺陷 A)

**文件**:`src/bridge/workflow-rework-coordinator.ts`

`releaseAndHold` 的出口按 reason **逐项**改路由(不笼统并轨):

| 出口(现行号) | reason | 新行为 |
|---|---|---|
| `rework_reentry_disabled`(L352) | env 关闭 | **可逆暂停**:coordinator 在 claim 前返回 `disabled`,dispatcher 用独立 pause episode 键即时发 1 条 Lead severe;delivery/reservation/activation/credentials/verification **零 mutation**;关闭期间 stall reconciler 不计时,flag 恢复时发 1 条 warning 并从恢复时刻重启 30/60 分钟 stall clock,下一 tick 可继续 |
| reentry classify hold(L366) | `registered_liveness_indeterminate` / `persisted_liveness_indeterminate` | `releaseRetryable`(strike:1/2/4/8 分钟退避,第 5 击 → `needs_lead` + 单条 severe)—— 探针瞬时噪声给 4 次重试机会 |
| reentry classify hold(L366) | `persisted_target_missing` | strike 同上,但**第 5 击不走 needs_lead,原子移交 FLY-1648**(§Change 1a) |
| `worktree_not_ready:*`(L399) | worktree 脏/缺 | `releaseRetryable`(FLY-1602 场景:worktree 在退避窗内清干净则自动恢复,超预算则 needs_lead 走 operator redrive —— 与该事故实际解法一致) |
| `holder_activation_failed:*`(L409) | 见右 | 先判僵尸:error 形如 `state_not_revivable:<status>` 且 `isStateStoreIrreversibleTerminalForZombie(status)` → **即时终局**;否则 `releaseRetryable`(`approved_to_ship` 明确不是不可逆,走普通 strike) |

- 删除 `releaseAndHold`(其 `session` 参数在 #779 删掉 alertHold 后已是死参)。outcome 词表中 `{kind:"held"}` 随之退场,dispatcher 对 held/retryable/invalid 本就同等计数(research §3.8),仅测试断言需同步。
- `releaseRetryable` 现有兜底不变:run 非 active 时退回裸 release(不铸 strike)。
- `*_liveness_indeterminate` 的第 5 击 cleanup 分两种真实可达形态:若仍在 admission 前,target 只是未使用的 `pending` reservation,普通 exhausted 会 supersede 该空 reservation(没有 activation/credential 可 revoke);若 delivery 已到 `turn_granted`,既有 `grant_started_at` / durable TURN 证据强制 `cleanupDisposition='retain_ambiguous_grant'`,不会 supersede 或 revoke 可能仍活跃的 actor。两种形态都加定向断言,不把 `indeterminate` 当成无证据安全清理。
- kill switch 不进入 `settleWorkflowReworkFailure`:它是 registry 中 `toggleable:"direct"` 的可逆安全开关,不是失败终局。StateStore 用 durable `transitionWorkflowReworkPause` 记录 pause/resume 状态机:pause uid 前缀 `rework_reentry_paused:${requestId}:rev${route.revision}:${executionId}:episodeN`,resume 用独立 `rework_reentry_resumed:...:episodeN`;同一状态重放幂等,再次 OFF→ON 自动进入下一 episode。pause 和 genuine stall 的 event kind/uid/outbox 均不共享键空间,也不进入 `rework_stall_recovered` 的 prior 集合。
- stall clock 必须真正暂停而非只在 flag OFF 时跳过扫描:恢复 transition 的 durable `at` 是新的 clock floor,`reconcileWorkflowReworkStalls` 用 `max(naturalSourceAt,resumedAt)` 计算 30/60 分钟阈值。于是关闭超过 60 分钟仍零 run/delivery mutation,恢复首 tick 不会 force-hold;恢复后若真的仍 stall,才从零重新累计并按 genuine-stall 键正常 alert/hold。
- `packages/config/src/feature-flags/registry.ts`、其 exact-array 测试和 FLY-1413 audit snapshot 同步登记 dispatcher 的 `reconcileWorkflowReworks` / `reconcileWorkflowReworkStalls` 两个新 read site;kill-switch ledger 不得漏掉决定 pause 状态和 clock 的调用点。

### Change 1a — `persisted_target_missing` 的 FLY-1648 原子移交(Codex R1 #1)

现状链路:`persisted_target_missing` → 裸 release 热循环 60 分钟 → legacy stall hold 把 run/delivery 置 `held` + `last_error='persisted_target_missing'` → FLY-1648 恢复机器(60s 节流 dead-probe → `materializeWorkflowReworkReplacement(recoverHeldPaneLoss)` 或 `settleHeldReworkRecoveryFailure` 自身 5 击预算)接管。**若笼统并入普通 strike,15 分钟后 needs_lead,FLY-1648 永远接不到新库存 —— 自动恢复回归。**

移交设计(在 `settleWorkflowReworkFailure` 同事务内,新增可选输入 `onExhausted?: "needs_lead" | "handoff_held_pane_loss"`,默认 `needs_lead`):

- 仅当 reason 为 `persisted_target_missing` 时 coordinator 传 `handoff_held_pane_loss`。
- 第 5 击时:run → `held`(与现有 exhausted 分支同款 CAS)、delivery → `state='held'`、`last_error='persisted_target_missing'`、**`hold_count` 归零、`next_retry_at=NULL`** —— FLY-1648 的 `settleHeldReworkRecoveryFailure` 从 `delivery.hold_count+1` 起算预算,不归零会把它的 5 击预算掐成 0(移交即耗尽,恢复被掐死)。
- 告警:单条 severe,episode uid `rework_pane_loss_handoff:${requestId}`,body 如实(「actor tmux target missing after N attempts; handed to pane-loss recovery」)—— 与现状 60 分钟 stall-hold 单条 severe 对齐(不是新增噪声,是把同一条提前到 ~15 分钟)。
- 移交后 delivery 形态与 legacy stall-hold 产物**逐字段等价**(FLY-1648 的 CAS:`run.status='held' AND delivery.state='held' AND last_error='persisted_target_missing'`),它的 dead-probe/materialize/revive 与自身失败预算全部原样接管。
- **handoff 是独立 exhausted 分支,必须绕开普通 exhausted cleanup(Codex R2 #1)**:普通第 5 击的 cleanupDisposition 会 revoke credentials、把 `workflow_run_node` target reservation 置 `superseded`、verification path 转 `needs_lead`(StateStore L21236-21276)—— 而 FLY-1648 的 `materializeWorkflowReworkReplacement(recoverHeldPaneLoss)` 的 CAS **强制旧 target 保持 `pending|admitted` 且 execution 匹配**(L20424-20435),被 supersede 即返回 `rework_replacement_target_changed`,恢复被毁。因此 `handoff_held_pane_loss` 在 cleanupDisposition / credential revoke / verification-path 翻转**之前**分流:保留 target reservation、activation/credentials、`grant_started_at`、pending verification path 原样不动(它们由 FLY-1648 materialize 的既有 revoke/rebind 事务接管),只原子更新 run/delivery 两行 + 写 handoff receipt/outbox。
- 对比取舍:不做「首击即移交」—— `persisted_target_missing` 可能是探针/注册的瞬时缺失,4 次退避重试保留自愈窗;移交后若 pane 实际存活,FLY-1648 现行为是 held 停驻 + 60s 节流探测(与今天 60 分钟 hold 后一致,非本单新引入)。

### Change 1b — StateStore 输入组合封闭合同(Codex R2 #3)

`settleWorkflowReworkFailure` 新增的两个可选输入在 StateStore 边界成闭合合同,误组合零 mutation:

- `onExhausted: "handoff_held_pane_loss"` **精确绑定** `reason === "persisted_target_missing"`;其他 reason 携带它 → `{ ok: false, reason: "invalid_rework_failure" }`。
- `terminal: {kind:"irreversible_actor", status, cause}` 与 `onExhausted: "handoff_held_pane_loss"` **互斥**(同时出现 → `invalid_rework_failure`);terminal 强制走 `needs_lead` 终局 —— 不可逆僵尸绝不能被错送进 pane-loss recovery。operator kill switch 不是 terminal 调用方。
- 返回联合类型显式加入 handoff 变体 `{ ok: true, state: "held", … }`;coordinator 将其识别为 settled handoff(outcome `{kind:"settled", state:"held"}`),**不依赖**「非 needs_lead 即 retryable」的隐式分支。

### Change 2 — stall 告警 episode 稳定键(缺陷 B)

**文件**:`src/StateStore.ts` `escalateWorkflowReworkStall`(L18597)

- eventUid 由 `${prefix}:${requestId}:${generation}:${executionId}` 改为 **`${prefix}:${requestId}:rev${route.revision}:${executionId}`**。
  - **revision 稳定性的真实依据(Codex R1 #5 修正)**:不是「只在真实改道时递增」—— `appendWorkflowReworkRouteRevision` 本身不看 target 是否变化;它的入口 CAS 要求 **owner 为空且 generation=0**,所以**首次 claim 之后 revision 即被冻结**;此后唯一的 revision 增长来自 proven-dead replacement(伴随 actor 变化)。claim churn 不可能改 revision —— 这是键稳定性的合同,测试要直接证它(见 §4-#10)。
  - **`rev` 前缀防 legacy 碰撞**:旧库存有 `…:${数字 generation}:…` 形态的事件;若新键裸用数字 revision,`rev=3` 会撞上历史 `generation=3` 的同 kind 同 executor 事件被误判 idempotentReplay。`rev` 段使新旧键空间永不相交。
- `generation` 输入参数保留,仅继续充当 CAS 上下文校验(`delivery.generation !== input.generation` → `rework_stall_context_changed`),不再进 uid。
- raw reason **不进键**(防 reason 文本振荡重开风暴);reason 只进告警 body。
- alert 与 hold 两个 prefix 同改。
- body 补合并语境:加 `first stalled at ${sourceAt}(距今 X 分钟)`,满足 issue「距首次 X 小时」要求(strike 家族的「第 N 次」由 exhausted body 的 attempts 计数承载)。

### Change 3 — 不可逆僵尸即时终局入口(缺陷 C)

**文件**:`src/StateStore.ts` `settleWorkflowReworkFailure`(L21113)

- 新增可选输入 `terminal: { kind: "irreversible_actor"; status: string; cause: string }`(`cause`/`status` **非空校验**,违规 → `invalid_rework_failure`)。置位时无视 holdCount 直接走既有 exhausted 分支结构(delivery → `needs_lead`、run → `held`、清 verification path、既有 cleanupDisposition 回滚逻辑原样复用 —— 这就是 issue 要的「自销」收敛路径)。CAS 与事务结构零改动。
- **receipt 与文案(Codex R1 #4 / R4 修正)**:普通第 5 击的现有 receipt 是 `rework_retry_exhausted:${requestId}` + body「failed five retryable deliveries」(StateStore L21297-21323;计划初稿误引了 FLY-1648 专用的 `rework_held_recovery_exhausted`)。terminal 路径**复用同一 episode uid** `rework_retry_exhausted:${requestId}`(同一 episode 只许一条终局告警,天然互斥),但 event payload 增加 `terminalCause`,并只为不可逆 actor 渲染专用 title/body;operator-disabled 模板已删除,避免把可逆 kill switch 误表述成终局:
  - `irreversible_actor`:`Rework activation cannot succeed for ${issue}` / `… target actor is ${status} (irreversible); settled needs_lead after ${holdCount} attempt(s): ${cause}`。
  该文案**绝不谎称五次**;第 5 击路径的现有文案逐字不动。
- 唯一调用方是 coordinator 的不可逆僵尸激活出口;reentry kill switch 走 Change 1 的可逆暂停,绝不触发 cleanup。

### Change 4 — 解堵收口一条(issue「状态翻转收口」语义)

**文件**:`src/StateStore.ts` `advanceWorkflowReworkDelivery`(L21383)+ `src/bridge/workflow-rework-coordinator.ts`

- **两个 `wake_delivered` 写者都要覆盖(Codex R2 #2)**:解堵成功有两个入口 —— ① 原 actor 复用:coordinator → `advanceWorkflowReworkDelivery(to:"wake_delivered")`;② proven-dead/FLY-1648 replacement 起飞:dispatcher → `markWorkflowReworkReplacementLaunched`(StateStore L20635-20717,直接把 delivery 从 `replacement_pending` 改 `wake_delivered`)—— Change 1a 的 handoff 恢复形态恰恰走 ②。收口逻辑提取为 transaction-local helper **`enqueueReworkRecoveredIfAlertedTx`**,两个写者同事务调用。
- **身份合同(Codex R1 #3 / R4 修正)**:两个写者的签名都拼不出 `WorkflowEngineAlertPayload` 的 `leadId/projectName/leadResolution`。收紧输入:两处 `wake_delivered` 转移**必须携带有效 `alertIdentity: WorkflowEngineAlertIdentity`** —— coordinator 传既有 `deps.resolveAlertIdentity(run)`,dispatcher 传既有 `resolveRunAlertIdentity`。`advance(...to:"wake_delivered")` 缺失/空 identity → `invalid_delivery_transition`;replacement launch 缺失/空 identity → `invalid_rework_replacement_launch`;两者都在任何 state mutation 前 fail-closed 并有零 mutation 测试。
- helper 逻辑:同事务内探测本 request 的 **prior-alert 集合(Codex R3 #2,两个精确来源)**:① stall 前缀区间 `event_uid >= 'rework_stalled_alert:${requestId}:' AND < 'rework_stalled_alert:${requestId};'`(索引友好,避开 LIKE 大小写陷阱;区间同时覆盖新旧键形态);② handoff 精确 uid `rework_pane_loss_handoff:${requestId}` —— 否则 pane-loss 正常流程(~15 分钟 handoff severe → FLY-1648 replacement 成功)的 founder 只看到「handed to pane-loss recovery」却永远等不到恢复收口。读取必须有界:stall 区间按 `seq LIMIT 1` 只取首条、handoff 精确查询只取一条,最多 JSON parse 两个 payload;不能在 wake-delivered 写事务里物化 legacy storm 的上千行。
- 命中任一(或两者)则:append 事件 uid `rework_stall_recovered:${requestId}`(天然幂等,双写者互斥,两来源共存也只发一条)+ `enqueueWorkflowEngineAlertTx` 一条 **severity "warning"** 收口告警(`Stalled rework for ${issue} recovered`,body 以**最早**一条 prior receipt 计算持续时长)。状态翻转、recovered receipt、outbox enqueue 三者同一事务,失败整体回滚。
- 未发过 stall 告警的 episode(绝大多数,strike 在 30 分钟阈值前就终局了)零输出。needs_lead 分支的收口就是 exhausted severe 本身,不再加第二条。

### Change 5 — 第一口 invariant 守卫

- 单测断言 rework 全部告警 payload 的 `eventType === "workflow_engine_escalation"`(Lead 告警面),rework 路径不产生 `workflow_engine_issue_alert`(issue thread 面)。#779 删掉的第一口不许悄悄回来。

## 2. 明确不做(honest boundary)

1. **不建**通用 (run_id, reason, target_node) 告警去重/合并计数层 —— 普查证明病灶唯一(99.9% 单 emitter),strike 机制使告警量结构有界,通用层是给一个病人建的医院(Annie 简单性三连)。
2. **不改**通道侧投递行为(outbox 投递、ClaimsDB、LeadAlertNotifier formatter/sender)—— per-attempt transport eventId 是防误抑的正确设计;仅在 `LeadAlertNotifier.ts` widening metadata disposition 与 `warning` payload type union,让 pause/resume/recovered 新事件通过现有 warning 渲染且不触发 severe DM。
3. **不动** FLY-1648 已治的 pane-loss 恢复机器本体(`settleHeldReworkRecoveryFailure` / dead-probe / materialize / revive)—— Change 1a 只是把它的**入库口**从「60 分钟 stall-hold」换成「~15 分钟 strike 耗尽移交」,入库形态逐字段等价。launch-stall escalator(键形态健康)、carrier 机制不动。
4. **不加**任何新 env flag(FLY-1466 铁律);既有 `FLYWHEEL_ENGINE_REWORK_ALERT_MS/HOLD_MS` 不动。行为变更无条件生效;唯一校正是 operator pause 的时间不再计入这两个阈值。
5. **不做** DB migration / 存量清洗:存量 pending 行在部署后的下一次失败自然进入新路径;僵尸型在首次失败即终局。部署前已是 `held` 且 `last_error!='persisted_target_missing'` 的 legacy victim 仍停驻,需 operator 处理,不纳入本单部署自动收敛验收。outbox 旧告警尾流按 §5 合同处理,不写自动 closeout 代码。
6. **不改** 30/60 分钟 stall clock 的存在 —— 它继续拥有两类残余库存:零失败静默 stall,以及 proven-dead 后进入 `replacement_pending` 但 materialize 一次失败的 stranded row。后者不在 coordinator 的 pending/turn_granted 列表,无 strike budget,仍由稳定 episode 键在 30 分钟报 1 条、60 分钟 hold 1 条;本单只消除 per-tick 风暴,不扩写 replacement materialize 重试 FSM。

## 3. 行为对照表(部署验收基准)

| 场景 | 现状 | 改后 |
|---|---|---|
| 僵尸激活(目标 actor 已 completed) | 1s 热循环 60 分钟;30 分钟起每秒 1 条告警(实测 1272 条);60 分钟 hold 止 | **首次失败即 needs_lead + 1 条 severe**(terminal 专用文案);热循环消失 |
| worktree 脏(FLY-1602 型) | 同上 | strike 1/2/4/8 分钟退避;窗内解堵自动恢复;第 5 击(~15 分钟)needs_lead + 1 条 severe |
| actor tmux target 缺失(pane-loss 型) | 热循环 60 分钟 + 风暴 → stall hold → FLY-1648 恢复 | strike ~15 分钟(4 次自愈机会)→ **原子移交 FLY-1648**(hold_count 归零)+ 1 条 severe;恢复机器行为不变,只是提前 45 分钟拿到库存、零风暴 |
| 探针瞬时不确定(indeterminate) | 热循环 + 风暴 | strike;瞬态自愈,持续 15 分钟 → needs_lead + 1 条 severe |
| coordinator reentry lane 被 env 关闭 | 无限静默热循环;关闭超过 60 分钟会被独立 stall clock 永久 force-hold | 每 pause episode 即时 1 条 severe + 恢复时 1 条 warning;该 lane 零 claim/零 delivery/reservation/activation/credential/verification mutation;关闭时 stall clock 停止,恢复时从零重启,下一 tick 继续。**边界**:既已 held 的 FLY-1648 pane-loss replacement lane 是独立恢复 owner,不受该 flag 控制,仍可能 materialize replacement actor |
| `replacement_pending` materialize 单次失败 | 30 分钟起 per-tick 风暴,60 分钟 hold | 30 分钟 1 条 + 60 分钟 hold 1 条;stall clock 仍是唯一 owner(独立 FSM 扩写不在本单) |
| 零失败静默 stall | 30 分钟起每秒 1 条 | 30 分钟 1 条 + 60 分钟 hold 1 条(episode 键) |
| stall 告警后自愈 | 无收口 | 收口 warning 1 条 |
| **每 failure episode 告警上界** | **~1272** | **≤4**(每 operator pause episode 另固定 2 条状态翻转告警) |

## 4. TDD 计划(RED → GREEN)

现有测试文件就位:`src/__tests__/StateStore.workflow-rework.test.ts`、`workflow-engine-dispatcher.test.ts`、coordinator 相关套件。

1. **风暴回归(锚定测试,先写)**:store+coordinator+stall 扫描,虚拟时钟 1s tick × 60 分钟:
   a. 激活恒失败 `state_not_revivable:completed` → 断言 outbox 该 request 总条数 ≤1(terminal severe)、delivery 于首击进 `needs_lead`、claim 后续返回 `delivery_settled`。
   b. 激活恒失败 `worktree_not_ready:worktree_dirty` → 断言 strike 时刻 ≈ 1/2/4/8 分钟、第 5 击 needs_lead、outbox 总条数 ≤1、`rework_delivery_claimed` 事件总数 ≤ ~6(vs 现状 2423)。
2. **pane-loss 端到端回归(Codex R1 #1 指定形态)**:terminal actor 无 tmux target + host 进程仍在 → `persisted_target_missing` strike(断言无 1s 热循环)→ 第 5 击原子移交,**逐字段断言**:run held / delivery held / last_error / hold_count=0 / **target reservation 仍 `pending|admitted` 未被 supersede / verification path 未转 needs_lead / credentials 未 revoke**(Codex R2 #1)→ host 消失 → dispatcher 既有 dead-probe → `materializeWorkflowReworkReplacement(recoverHeldPaneLoss)` 成功走通 —— **不得只测手工预置的 held 行**。**credential 保全断言必须非 vacuous(Codex R3 #3)**:本测试或一个定向 StateStore case 预置真实 admitted activation、至少一张未消费且 `revoked=0` 的 credential、非空 `grant_started_at`,断言 handoff 后逐字段不变,revoke/rebind 留给后续 materialize —— 新鲜 fixture 无 credential 时「未 revoke」是空断言,证不了绕开 revoke 分支。
3. **uid 稳定性**:claim/release ×3 抬 generation 后连续两次 `escalateWorkflowReworkStall("alert")` → 恰 1 条 `rework_activation_stalled_alerted` + 恰 1 条 outbox;第二次 `idempotentReplay: true`。
4. **legacy 键不碰撞**:预置历史事件 `rework_stalled_alert:REQ:3:EXEC`(数字 generation 形态)→ 新键 `rev3` 正常发射,不被误判 replay、不报 receipt conflict。
5. **僵尸判定边界**:`state_not_revivable:approved_to_ship` → 走普通 strike(非即时终局);`state_not_revivable:terminated` → 即时终局。
6. **terminal 输入**:`cause`/`status` 空串被拒;zombie(`irreversible_actor`)body 必须带 status 且不含「five」;第 5 击路径现有「failed five retryable deliveries」文案逐字不回归。kill switch 另测同实例 OFF 超过 60 分钟→ON:OFF 期间仅 1 条 pause severe 且 delivery 全字段不变;ON 首 tick 1 条 resume warning、仍不 force-hold;恢复后超过新 30/60 阈值才产生独立 genuine stall alert/hold。断言 pause/resume/stall 三套 uid 和 event kind 不碰撞,第二轮 OFF→ON 使用 episode2 而非被首轮永久抑制。
7. **移交预算独立性**:移交产物再走 `settleHeldReworkRecoveryFailure` → 其预算从 1 起算(hold_count 已归零),5 击全额可用。
8. **输入组合封闭合同(Change 1b)**:`handoff_held_pane_loss` + 非 `persisted_target_missing` reason → `invalid_rework_failure` 零 mutation;`terminal` + handoff 同时出现 → 同拒;coordinator 对 `{state:"held"}` 返回按 settled handoff 处理。
9. **stall clock 让位**:hold_count>0 的 delivery 不再被 `reconcileWorkflowReworkStalls` 扫描(既有 guard 的新族群覆盖)。
10. **收口(双写者 × 双来源)**:prior alert 在场 → ① `advanceWorkflowReworkDelivery(to:"wake_delivered")` 与 ② `replacement_pending + prior receipt → markWorkflowReworkReplacementLaunched` 各自恰 1 条 recovered warning(双写者互斥不重发;重复调用不重发;resolved 与 fallback 两种 identity 都断言;identity 缺失/空值零 mutation fail-closed;receipt conflict 事务整体回滚);**真实 handoff → materialize → replacement launch 链路恰 1 条 recovered(Codex R3 #2)**;stall 与 handoff 两来源共存仍只 1 条,时长按最早 receipt;任何 prior alert 都不在场 → 零输出。
11. **revision 冻结合同**:claim/release churn 不改 route.revision;proven-dead replacement 递增 revision 且伴随 actor 变化。
12. **invariant 守卫**(Change 5)。
13. 既有断言更新:凡是断言 `{kind:"held"}` outcome / 旧 uid 形态的测试按新语义改写(它们断言的就是病)。

## 5. 验证与交付

- 全仓门:`pnpm lint` + `pnpm -r build` + `pnpm test:packages:run`(FLY-224/248 教训:全 repo,不只 changed files;host 负载红线 —— 定向文件跑法优先,全量以 CI 为准)。
- Codex code review(`codex:rescue`)循环至 APPROVED。
- 部署形态:**纯 Bridge 侧(teamlead 包)→ 单次 Bridge 重启生效**,不动 Lead、不动 Runner、无 migration。
- **outbox 尾流合同(Codex R1 #2)**:源头修复只阻止**新** uid,不撤销重启前已入 durable outbox 的旧行。
  - Preflight(重启前一条命令):`SELECT state, count(*) FROM workflow_alert_outbox WHERE escalation_uid LIKE 'rework_stalled_alert%' GROUP BY state`。当前生产证据(2026-08-12 快照):**11,714 行全部 `sent`,pending/delivering = 0**,稳态零积压。
  - 尾流量化(Codex R2 #4:20 条/tick 是**上限**不是保证 —— 每条 `await sink.alert()` 串行、dispatcher 有 `reconciling` 防重入,网络延迟/sink 失败都会压低实际吞吐):**不做「秒级清空」的结构性断言**;尾流大小与清空时间以 preflight 实际行数 + 现场 drain 速度量化。唯一的非零场景是「重启恰撞风暴进行中」,残留有界、投完即止。
  - 合同:部署验收的「零连发」观察窗**从 outbox 中 `rework_stalled_alert%` 的 pending+delivering 归零时刻起算**;postflight 双账本核对 —— `workflow_run_event` 新增量有界 **且** outbox 该家族 pending/delivering = 0。若 preflight 发现 pending > 50(风暴进行中):先按现场 drain 速度估算清空时间;在 operator 可接受窗口内 → 直接重启并接受有界尾流(默认),超窗 → operator 手工按 FLY-1648 closeout 纪律(备份 + CAS + 逐行审计)预清 —— 不写进代码。
- 部署后验收(独立 QA,非实现者自报;基线用 `workflow_run_event` + `workflow_alert_outbox` 双台账,跨重启不丢):
  1. 重启前抓 `rework_stalled_alert` 家族 event 总数 + outbox state 分布基线;
  2. 触发/等待一个真实 rework-held episode(或在 529 隔离房注入僵尸 rework);
  3. 断言该 episode 告警 ≤4 条、`rework_delivery_claimed` 增量 ≤ ~6、delivery 在预算内到达 needs_lead/移交/恢复;
  4. 观察窗(≥2h,从尾流归零起算)alerts 频道零同文连发。
- 文档归档 + CLAUDE.md 里程碑 = 实现 PR 最后一个 commit(feedback_archive_docs_in_main_pr)。

## 6. 风险与接受的相互作用

| 风险 | 评估 |
|---|---|
| worktree 类瞬态堵塞 15 分钟预算不够,落 needs_lead 需 operator redrive | 接受:与 FLY-1602 实际解法一致(operator 解堵);一致性优先于给 held 家族另设预算 |
| `persisted_target_missing` 移交比现状提前 45 分钟把 run 置 held;若 pane 实际存活,FLY-1648 现行为是 held 停驻 + 60s 探测 | 接受:与现状 60 分钟 hold 后的停驻行为一致,非本单新引入;且 4 次 strike 重试已给瞬态自愈窗 |
| reentry kill switch 在 env 关闭期间每个新 rework 产生 1 条告警;既有 held pane-loss 库存仍由 FLY-1648 独立 lane 恢复并可能 materialize actor | 接受:operator 关闭 coordinator reentry lane 本应可见;每 pause episode 两条状态翻转告警有界;该 lane 不 claim、不终局、不破坏 direct toggleability。该 flag 从未覆盖 FLY-1648 pane-loss lane,计划与告警文案不能把边界误述为 Bridge 全局「无 spawn」 |
| `replacement_pending` materialize 单次失败仍等 60 分钟 stall owner | 接受:该路径告警已由 stable uid 限为 2 条;为它增加独立 retry FSM 超出通知治理范围,行为表与验收明确排除预算承诺 |
| 新旧 uid 键空间 | 已由 `rev` 前缀消除(§Change 2) |
| 部署瞬间存量风暴中的 request | 下一 tick 首次失败即进新路径,≤1 条后归于安静;outbox 尾流按 §5 合同有界 |
