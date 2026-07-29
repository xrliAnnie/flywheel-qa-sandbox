# Design Review — FLY-1520 plan.md (Round 8)

Date: 2026-07-28
Author: Codex
Status: APPROVED

## Summary

Round 8 已关闭 Round 7 的最后一个阻塞点：T4 现在通过 stable-set acquisition loop，在锁下重读和最终 kernel.write 中两次断言 active session 集合精确等于已持锁集合，无法再无锁终结并发 T2 新建的 suite。完整 T1-T7、ports、crash/replay、真实 kernel/engine API 与 0001..0007 DDL/trigger 复核后，未发现新的实施映射缺口；计划已可进入实现。评审基于当前 HEAD `f7d20453`；新包尚未实现且 checkout 无 `node_modules`，本结论是设计批准，不声称实现测试已运行。

## What's Good (Keep)

- T4 stable-set loop 的五步边界完整：预读 S、canonical lock、锁下集合相等检查、锁内 fresh probe、最终事务内集合/revision/evidence 再断言。
- 在锁下检查与 kernel.write 之间提交的新 dispatch 会被最终集合断言发现并整体回滚；write 开始后 BEGIN IMMEDIATE 又阻止并发 T2 插入，线性化闭合。
- mismatch 路径释放全部锁并从预读重试，present 路径零 DB 变化并返回 typed quiescence；没有在 kernel.write 内反向取 OS 锁。
- `launchOnce` 是 T2/T7 唯一 exec 入口，claim one-shot、receipt-before-exec、pre-launch takeover 和 launched-crash→T6→T2 恢复路径一致。
- task→attempt→activation generation 分层、agent_binding 单飞、activation-scoped session_ref、lock-fresh DeathEvidence 与 current-generation fence 彼此一致。
- admission payload/membership receipt、contract/evidence fail-closed、单一 DAG eligibility、writer chain/span tip 和 issue-scoped ship worktree 映射均已逐键定义。
- ship target 只取 gate snapshot，capability 完整绑定与单消费、actions chain/supersede triggers、advanced-generation observational settlement及六次 retry 上限均与现有公开 API/DDL 兼容。
- M0 先钉真实 actions/registration/capability 合同，M1-M6 再按拓扑、completion、rework、ship/reconcile 和 E2E/crash 分层推进，TDD 顺序合理。
- 零 migration、零 v2-engine/v2-actions/v2-scheduler 编辑、零 attempts.observed_* 依赖、包依赖恰 kernel+engine，以及节点语义/ship 三谓词静态围栏均得到保留。
- Route A 相对设计 §8 的偏离、单 shippable worktree、generic lane 合流、legacy agent adoption 和生产 activation 的 1502 跟进边界记录充分。

## Issues & Recommendations

未发现需要在实施前修改的阻塞或高风险问题。实现时按 M0 真库 spike 和各 milestone 的竞态/crash exit conditions 逐项验收即可；特别保留 T4 stable-set barrier 与 `launchOnce` 唯一 exec 的静态调用图测试。

## Verdict

APPROVED — ready to implement
