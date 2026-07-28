# Design Review — plan.md (FLY-1498) (Round 6)

Date: 2026-07-27
Author: Codex
Status: APPROVED

## Summary

Round 6 完整关闭了 Round 5 的 2 个 HIGH 与 1 个 MEDIUM：当前 open writer 会在推进 HEAD 时立即进入被审作者集，adoption authority 精确绑定一次 gap，writer-chain 从 admission 到 dispatch/launch failure 也形成了原子 crash contract。设计现在能在已合并的 FLY-1497 kernel 上落地，三条 ship 前置的构造性充分性成立，未发现新的阻塞问题。

## What's Good (Keep)

- `effective_author_set(observed_head)` 成为 manifest、review request 和 completion 共用的唯一谓词；首个 writer 从 H0 写到 H1 时已进入 `author_set_digest`，同族 review 被拒，不再依赖 release 后补记作者。
- Completion 的 writer 谓词已精确区分 `chain_head` 与 `manifest.head`：open lease 期间前者合法停在 `grant_head`，而 fresh canonical HEAD 必须精确等于已分类、已评审的 manifest head。Release 又以 expected head/version/open lease 做同事务校验，push-after-review 和 chain drift 都是零状态转移回滚。
- Release 折入后的作者集合必须与 `node_completed` 记录的 author-set digest 一致，随后才与 `span_tip` 推进一起清空；因此 review 消费、作者归因、writer revoke 和 span-chain advance 共享同一线性化点。
- `lease_adoption` 已具备完整 break-glass 语义：canonical request digest 绑定 repo/worktree、obligation、chain version、from/to head 和 attribution family；idempotency lookup 前置，one-shot capability 精确绑定 subject，receipt/consume/resolve/fold/CAS 同事务。旧授权不能扩大到漂移后的 HEAD 或另一段 gap。
- Admission 同事务以 fork point 初始化 `writer_chain`，禁止 lazy initialization；首个 lease 前的 ownerless push 会进入既有 gap/adoption 路径，不会被静默接受为链起点。
- Writer dispatch 把 attempt、launch command、capability、grant receipt 和 open lease 放进一个 idempotency domain；claim 复核绑定，launch failed/rejected/canceled 的 observation 同事务 release，符合 FINAL §2.2 的 crash replay 纪律和 §1.6 单 writer 红线。
- V4/V15 已覆盖首写者同族拒/跨族成功、review 后 push、正常 `chain_head != manifest.head`、release drift、admission-first-grant gap、dispatch replay、launch failure、adoption stale/concurrent/replay 六类反例；B3 多轮 handoff 仍是 O(1) 校验并保留 1 秒成功预算。
- Round 4 的 revision lookup-first/excision terminal table、Round 3 的 `invalidate_ship_authority`、lineage-root cascade、fail-closed classifier 和 current gate lifecycle 均未回退。
- 详细版、压缩 §T/§1.7/§2.12、场景台账 L、验收 V 与 meta inventory 对关键安全谓词保持一致；机制均能回指 B/C/D 或既有事故，没有三段式特权和额外常态 gate。
- Founder 与 Lead 的绑定裁定全部满足：product review 在节点完成合同消费；test-only 免 cross-family review；ship 仍只有 founder exact-head approval、DAG terminal-success、world head 未漂移三条；CI red 是 merge executor 世界约束而非第四道门。

## Issues & Recommendations

1. **No blocking issues.** Batch 3 实现与后续 code review 应逐字保留本文的 exact predicates、idempotency fast paths 和同事务组合；任何把 `effective_author_set` 退化为 release 后作者集、把 adoption capability 放宽为非 exact subject、或拆分 writer dispatch/grant 的实现都应视为设计偏离，而不是可接受的实现简化。

## Verdict

APPROVED — ready to implement
