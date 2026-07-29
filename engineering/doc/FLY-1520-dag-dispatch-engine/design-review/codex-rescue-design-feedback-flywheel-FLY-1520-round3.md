# Design Review — FLY-1520 plan.md (Round 3)

Date: 2026-07-28
Author: Codex
Status: CHANGES REQUESTED

## Summary

Round 3 再次取得实质进展：Round 2 的 evidence、非写 completion、ship target、retry slot、T4 observation 和 package 边界问题，大多已在实际计划文本中闭合。当前 DDL/API 对照仍发现一个直接不可构建的 generation 映射、两个确定的状态机死路，以及 launch/agent authority 的残余竞态，因此尚不能批准实施。当前 checkout 没有 root 或 v2-kernel `node_modules`，本轮结论来自完整计划、公开 API、DDL/trigger 和既有测试源码的直接核对，未声称执行了测试。

## What's Good (Keep)

- 保留 T7 在一个 `kernel.write` 内完成旧 activation terminal、新 activation、`registerAgentTx` generation CAS 和事件，再在 commit 后启动；`registerAgentTx` 确实是公开的 `WriteTx` 函数，且要求 activation 已 active。
- 保留 `EngineDriver.attachRunner` 领养预注册 `RegisteredAgent`、runner 不再自行注册的方向；该方法确实通过 v2-engine index 公开。
- 保留 T2 的事务内完整 eligibility、同事务注册、显式 `host_epoch`、commit 后 launch claim，以及 started/dispatched 两类收割 grace 和 barrier 测试思路。
- 保留 evidence 的 pass-only verdict、executor/activation producer 绑定、review family 反查、artifact cardinality 和 canonical payload collision 检查；这些关闭了 Round 2 的完成合同漏洞。
- 保留 completion/admission 在任何外部 Git 读取前先查 receipt、事务内二次幂等检查，以及非写节点不推进 span、不进入 author finalize。
- 保留每 issue 恰一 shippable worktree、`dag_issue.ship_worktree_id`、gate target 持久化以及后续 capability/action/reconcile 只从 gate 快照派生。
- 保留 merged/rejected/unknown × generation current/advanced 的观察性结算拆分、settled 终局约束和 due-slot revision CAS；“换代后拒绝绝不写 ship_completed”已表达清楚。
- 保留 T4 observation 并集、families bootstrap API、零 v2-actions 依赖、M0 真迁移链 spike 和全部硬范围约束。

## Issues & Recommendations

1. **[阻塞] `activations.generation` 被映射成了 agent generation，但真实 schema 把它当作 attempt generation。** `plan.md:241-245` 和 `:345-348` 都写 activation.generation=agents 新代。实际 migration 0006 的 `actions_lineage_insert` 要求 activation 同时满足 `attempt_id=NEW.attempt_id AND generation=NEW.attempt_generation`（`0006-actions-black-box.ts:93-109`）；既有 kernel 测试也明确使用 agent generation 3、attempt generation 2、activation generation 2（`actions.test.ts:770-815`）。`registerAgentTx` 只要求 activation active，并不要求其 generation 等于 agent generation。第二个 task 或一次 resume 后两种 generation 很容易分叉，届时任何 task-bound action 都会被 trigger 拒绝。**修正**：T2/T7 的 activation.generation 一律写当前 `attempts.generation`；agent generation 只进入 agents/RegisteredAgent/action.actor_generation/processing_attempts。T3/evidence 绑定分别校验 activation.generation==attempt.generation 和 agents.generation==producer generation。M0 必须用故意分叉的 agent=3、attempt/activation=2 fixture 钉死。

2. **[阻塞] T7 复用 T2 launch claim 时，attempt 状态不满足 claim；claim 已成功后的晚到 spawn 竞态也仍存在。** T7 保持同一 attempt，死亡前它通常已经是 `started`，但 `plan.md:345-350` 没有把它改回 `dispatched`；随后复用的 CAS `dispatched→started` 必然返回 0，所以 resume 永远不会 spawn。即使 T2 路径，当前 barrier 只覆盖“reaper 先 terminal、晚到 claim 失败”；未覆盖“claim 成功 → launcher 停顿超过 grace → reaper terminal → launcher 恢复后 spawn”。这时 `attachRunner` 也救不了：真实实现只检查 agents kind/generation（`driver.ts:115-145`），不检查 activation 仍 active。**修正**：T7 同事务显式 CAS attempt `started→dispatched` 并清/重置 launch timestamp，或改用 activation-scoped claim。claim 必须是有 owner/token/lease_until 的 durable fence，SpawnPort 在真正 exec 前验证同一 token，reaper 先 tombstone/失效该 token再 terminal；可用 meta + session_ref 共享锁实现，无需 migration。增加“claim 已胜、跨 grace 后 reaper 胜、原 launcher 再继续”的第二组 barrier，并在 attachRunner 前由 v2-dag wrapper 重查 activation active + claim token。

3. **[阻塞] generation 已前进的 definitive rejection 会写一个永远无法消费的 retry schedule。** 四格表规定该 action 永留 `intended`（`plan.md:175-180`），但 due-retry 原子槽只接受“链尾==failed”（`:333-337`）。因此 advanced-generation rejection 虽写了 next_retry_at，到期后 predicate 永远为假；这也与 migration 0006 明确允许 successor supersede prior.state IN ('intended','failed') 不一致。**修正**：due-slot 接受两种精确 basis：failed tail，或仍 intended 且存在匹配 action_id/probe digest 的 `action_unsettleable_generation` definitive-rejection 事件；两者都要求无 successor、同 logical key/payload、settled null。到上限直接 expire；未到则新 generation actor 可按 trigger 允许的 intended-tail successor 建下一行。新增 advanced-generation rejection→due→successor 的端到端测试。

4. **[阻塞] approved gate 在“无 actor/无 capability”或 capability 持有者换代时没有恢复路径。** approve 无可用 actor 时会落 `state=approved` + blocked event、但不 mint（`plan.md:302-310`）；同 approval_ref 重放只会返回第一次的无 capability 结果，新 approval 又过不了 `state=open`。T7 则声明旧 capability 因 actor_generation 落后而停用并“待 reconcile 再武装”（`:343-350`），但 T6 唯一 mint-2 路径要求 next_retry_at 到期且存在 failed tail；尚未执行的 capability 没有 action tail或 retry slot。两种情况都会永久卡在 approved。**修正**：补一个 level-triggered approved-authority recovery 事务并明确它仍属于 reconciler mint 点 2：要求 approved、settled null、target/tip/DAG 未变、无 intended action；同 logical actor 仅 generation 前进时 revoke 旧 cap、CAS gate actor_generation/capability_id、mint+mailbox。approval 时没有 actor或需要换 actor/config 时不得静默重选，必须定义 founder-authorized fresh recovery/reopen API。覆盖“approval blocked 后配置修复”和“cap 未消费即 T7 换代”两例。

5. **[高] gate reopen 与 actions 线性链仍缺少逐字段/逐尾映射。** 计划宣称 payload digest 跨 reopen 稳定、supersede 链不断（`plan.md:161-172`），但 execute 只写“attempt>1 带 supersede”（`:314-320`），没有说明 attempt 序号来自 actions 链而非新 gate 已重置的 retry.attempt_count。第六次失败后 gate expire→同 actor/同 target fresh approval 时，logical_key 已有 root；若按新 gate 的 attempt 1 插 root，会撞 `actions_one_root_per_logical`。同时 reopen 仅声明新 gate_id/tip/digests（`:122-127`），未明确清空旧 target/actor/config/capability/approval_ref 和重置 retry。**修正**：列出 reopen 的完整 next envelope：target/actor/config/capability/approval_ref 归 null、retry attempt_count=0/next_retry_at=null、settled 仍 null。execute 先按新 target+actor 计算 logical_key 并读唯一 tail：无 tail才 root；tail intended/failed 必须 successor+retryBasis；tail succeeded 为终局冲突。增加“第六次失败→reopen→同 actor/target fresh approval→合法 successor”测试。

6. **[高] T2 对 logical agent 的全局单飞、DeathEvidence 绑定和 spawn request 重构仍未成为 durable 合同。** agents 表每 logicalAgentId 只有一个 current generation，但 eligibility 只看 task/attempt；若 agent A 的旧 DAG process 已 absent、旧 task 尚未被 T6 harvest，另一个 ready task 可拿 DeathEvidence 并调用 `registerAgentTx` 推进 generation，留下旧 active attempt/activation stranded。反方向，计划称 spawn request 可从库重构（`plan.md:248-249`），但 agents 不存 instanceId，activation 也不存 agentId；若 commit 后进程崩溃，新的 spawner 没有文档化规则恢复当时传给 `registerAgentTx` 的完整 RegisteredAgent。**修正**：dispatch eligibility 增加 executor logicalAgentId 全局单飞；发现同 agent 仍有 active DAG activation 时必须先走 T6 harvest，不能借新 task 偷渡 cutover。把 `{agent_id, instance_id, agent_generation, activation_id, session_ref, host_epoch}` 作为 `attempt_dispatched` 的 canonical durable payload（或统一 meta binding），ProcessProbe/DeathEvidence 必须精确绑定该记录；也可规定 instanceId=session_ref 使其可确定重建。明确 runner 在完成/终态后退出或交还 session 的生命周期，否则后续 dispatch 会因拿不到 absence evidence永久跳过。增加同 agent 两个并行 ready task、commit 后 launch 进程崩溃重构、旧 task absent 尚未 harvest 三例。

## Verdict

CHANGES REQUESTED — address items above
