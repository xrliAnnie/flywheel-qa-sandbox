# Design Review — FLY-1520 plan.md (Round 2)

Date: 2026-07-28
Author: Codex
Status: CHANGES REQUESTED

## Summary

Round 2 是实质性改进：admission 成员隔离、统一 meta 信封、writer-gap capability、actions 同 actor 续链和 M0 真库 spike 都把 Round 1 的主要方向性缺口收住了，且当前源码确认这些方案大体可映射到公开 API。计划仍有数个会破坏 generation fence、产生孤儿进程、让失败 verdict 完成节点或误记 ship 事实的实现级缺口，因此尚未达到可直接开工的精度。评审基于当前 HEAD `c1aff0bd` 的完整计划与源码/DDL 对照；聚焦测试因 checkout 缺少 `node_modules` 未能运行，未将其伪报为通过。

## What's Good (Keep)

- 保留 admission descriptor 的逐列 tasks 映射、payload 恰四键校验和 `dag_issue:{issue}` 成员回执；这正确承认了既有 v2-engine task effect 写口仍存在，并在本包运行时 fail closed。
- 保留所有 v2-dag meta 值统一 `{v,revision,cutover_epoch,data}` 信封、单一 revision+epoch UPDATE CAS，以及 gate 只使用现有四种 CHECK 状态；用 `settled` 记录 ship 事实比新增非法 `shipped` 状态正确。
- 保留 action payload 不含 `gate_id`、同 logical actor 续链、换 actor 开新 logical root、reconciler 不代 actor 创建 successor 的映射。源码 `actions.ts:368-383` 与 migration 0006 的 lineage/payload trigger 支持该判断。
- 保留 capability id bearer 的完整行绑定检查、`taskId:null` / `attemptGeneration:null` 的显式 FENCE 参数、approval mailbox 可恢复交付和 approval-ref 幂等。
- 保留 admission 同事务落 `pending_gap` + `writer_gap_detected`，以及独立、exact-subject 的 writer adoption capability；这关闭了 commit 后丢失 gap 事实的窗口。
- 保留 `prepareDispatchTx` 在事务内重跑完整 eligibility、T2/T4 共用派发准备、T4 release-before-acquire，以及 commit 后统一 SpawnPort 出口。
- 保留 GitHub observation/merge port 权限分离、ProcessProbePort/WorktreeRefPort、500-task fail-closed 上限和 M0 真迁移链 spike；这些都是合适的降风险顺序。
- 当前计划仍遵守零 migration、零 v2-engine/v2-actions 文件修改、零 `attempts.observed_*` 依赖和只从包级 index import 的硬边界。

## Issues & Recommendations

1. **[阻塞] T7 仍把 activation 换代与 agent generation cutover 拆成了两个事务。** `plan.md:374-378` 先提交旧 activation terminal + 新 activation，spawn 后才让 runner 调 `registerAgentTx`；在这段窗口内 agents 旧 generation 仍是 current。旧进程仍可提交 action/evidence，而新 activation 已 active；反过来，新 generation 上线后也可能消费只绑定 audience、未绑定批准时 generation 的旧 ship capability。现有 `registerAgentTx` 本来就是 `WriteTx` 函数，并在 `registration.ts:91-163` 明确支持调用方事务内完成 generation CAS，且只要求新 activation 已 active。**修正**：T7 的同一个 `kernel.write` 内依次校验 DeathEvidence、terminal 旧 activation、插入带明确 activation generation 的新 activation、调用 `registerAgentTx` 完成 registry cutover、撤销/围栏旧 activation 授权并写事件，commit 后才 spawn；ship intent 还必须断言 `gate.actor_agent_id/generation == caller` 且 `gate.capability_id == presented capability_id`。新增旧 evidence/action 写与 T7 cutover 的双连接竞态测试。

2. **[阻塞] dispatch commit → spawn 与 T6 absence 收割之间没有线性化。** `plan.md:276-277` 允许 commit 后直接 spawn，同时 `plan.md:364-366` 允许任何 dispatched attempt 在 probe=absent 时被终态化。正常的 commit 后、SpawnPort 调用前窗口本来就是 absent；交错可以是“派发 commit → 收割 commit failed → 原派发者随后 spawn”，留下已 terminal activation 的孤儿进程。所谓“补 spawn 或收割”目前也没有唯一 owner/lease。**修正**：定义 durable launch claim/lease（可复用 `desired_state='started'`、`started_at`、`host_epoch`，无需 migration），spawner 先 CAS claim 再外部 spawn；reaper 只处理过期 claim/dispatched grace，事务内重查 attempt/activation/host lease，晚到 spawner 必须在 launch 前看到失效并放弃。为上述三步设置 barrier 竞态测试。另需补齐 T2 的真实 INSERT：`activations.generation` 是 NOT NULL，但 `plan.md:269` 未给值；`ports.hostEpoch()` 在 §4 也没有对应 port。

3. **[阻塞] evidence 合同仍可让无效证据完成节点。** `plan.md:235-236` 对 verdict 只校验 task/attempt/head，没有要求 `verdict='pass'`，因此 `evidence.verdict{verdict:'fail'}` 也会满足 QA 合同。`recordEvidence` 仅检查 agents current generation 也不足以证明 verdict/artifact 的产出者属于该 task/attempt；agents 表没有 instance/activation 字段，任意 current agent 可为别人的 attempt 写同 subject 证据。artifact 的 `cardinality: one|many` 与 optional digest 也没有精确定义匹配数量、重复和缺省 digest 语义。**修正**：逐证据类型写闭合谓词：verdict 必须 pass，并绑定 producer agent/instance/activation → attempt → task 以及 `payload.executor.logicalAgentId`；artifact 同样绑定 producer lineage，并定义 one/many、path 和 optional digest 的集合语义；review approval 单独走 review_families 权威。event UID 冲突时必须比较完整 canonical payload digest。把 fail verdict、别的 current agent、旧 activation、many 的 0/1/N 和重复证据列为反例。

4. **[阻塞] T3 的非写节点路径与 replay 顺序仍未定义成可执行算法。** 计划说 writes_repo=false 跳过 manifest（`plan.md:284-286`），但事务步骤仍无条件读取 `manifest.base/head`、推进 `span_tip`、执行 writer finalize（`:297-307`）；而 admission 又允许该 task 的 `worktree_id=null`。这使纯 verdict 节点没有权威 head，且实现者可能错误修改 repo span。与此同时 completion replay fast path 位于 manifest/Git 观测之后；一次已成功 completion 在 branch 后续移动或 worktree 消失后重放，可能在看到既有 receipt 前先失败或 expire gate。**修正**：先在任何 Git port 调用前按 completionUid + stable request digest 查 receipt并返回首次结果；首调用才观测。为非写 task 明确 head subject 来源（例如要求 head-bound contract 指定 admission 的 ship worktree），仅校验该 head，不构造 diff、不推进 span、不进入 author finalize；只 terminal activation/attempt/task、写 node_completed 并 refresh gate。T1 admission replay也应在外部 worktree读取前先查 admission receipt。

5. **[阻塞] 当前 gate 数据没有真正持久化 ship target，且多 worktree DAG 无法映射到单一 `tip`。** 用户说明称 `{repo,pr}` 已持久化到 gate meta，但实际 `ship_gate` data 列表 `plan.md:130` 没有 repo/pr/head；approve 入参虽含 shipTarget（`:326-334`），也没有明确 CAS 写入。响应/mailbox 丢失后，blocked approval 或尚无 action 的 retry 无法仅从权威 gate 重建 target。更根本的是 admission 允许多个 worktree，T4 还显式支持多 worktree closure，但 gate/capability/action 只有一个 tip/head，`maybeRefreshShipGateTx` 没有规则说明哪个 worktree 可 ship。**修正**：在 admission 明确一个 immutable `ship_worktree_id`（或本批 fail closed 限制每 issue 恰一个 shippable worktree），并定义其他 worktree 对 gate open 的约束；gate 首开从该 worktree 的 current span_tip 取 tip。approval CAS 把 canonical `{repo,pr,head=tip}` 持久化进 gate，并校验 repo 与 canonical worktree identity 一致；后续 capability、mailbox、intent、reconcile 全从该快照重算，不再依赖调用者重传。

6. **[阻塞] T6 把“已合并”和“确定拒绝”的 generation-changed 观察性结算混在同一个 event-only 分支，retry CAS 也未闭合。** §2.4 b 型只定义 `ship_completed + gate.settled`（`plan.md:202-206`），但 T6 又写“确定拒绝…换代时同样 event-only”（`:357-360`）；按文字复用 b 型会把拒绝误记为 ship，若不复用则没有定义 next_retry/第六次 expire 如何推进。另一个竞态是 due retry 只说 mint+mailbox，没有原子清 `next_retry_at`、替换 `capability_id` 或按 revision 去重；level-triggered reconciler 可为同一 due slot 重复 mint。**修正**：把 changed-generation probe 明确拆开：merged 才写 ship_completed+settled；definitive rejected 只写 rejection/unsettleable evidence，并原子安排 next_retry 或到上限 expire，绝不写 settled。due retry 必须以 gate revision、`settled IS NULL`、到期时间和当前 tail 为 CAS，单事务清该 due slot、mint 一枚 capability、写回 capability_id/revision并 append mailbox。execute/retry/invalidate/reopen 全部要求 `settled IS NULL`；settled gate 是终局事实，不能再被 expire/reopen。补“merged/rejected/unknown × generation current/advanced”六格测试和两个 reconciler 同时处理同一 due slot 的测试。

7. **[高] T4 的事务外 observation 集合不足以重新派发被打回 task。** `plan.md:312-313` 只为 dependency closure 内的 active writers 收集 packet；但被打回的 task 可能已经 done，因此没有 active writer，却在 `prepareDispatchTx` 中需要自己 worktree 的 current head+writer revision。若下游 active writer 在另一个 worktree，现有 packet 集合更无法代用。**修正**：事务外观测集合应是“所有待 finalize 的 active writer worktree ∪ 被打回 task 的 dispatch worktree ∪ gate refresh 所需 worktree”，每个 packet 带 exact head/revision；事务内先分别复核所有 packet，再 release，最后用目标 worktree packet acquire。增加“已 done 的 writes-repo 上游、另一 worktree 下游仍 active”的测试。

8. **[中] 仍有几处逐字实现合同矛盾，应在开工前修正文档。** (a) capability 行写 `issuer='ship_gate:'+gate_id`，消费规则却写 `issuer==当前 gate_id`（`plan.md:154-159`），必须统一为带前缀的完整字符串；(b) meta 首建注释说仅 admission/gate（`:113-115`），但 `review_families:{project}` bootstrap 必然也要 INSERT，当前没有 bootstrap API 的幂等、授权和 CAS 规范；(c) §1 仍声明依赖 `flywheel-v2-actions`，但修订后的 ship 只调用 v2-kernel 的公开 action 动词，若没有真实类型 import 应删除该依赖，降低与 1518 的接触面。把这些都加入 M0/M1 的 public-surface/static-fence 退出条件。

## Verdict

CHANGES REQUESTED — address items above
