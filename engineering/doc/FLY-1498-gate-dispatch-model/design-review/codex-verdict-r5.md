# Design Review — plan.md (FLY-1498) (Round 5)

Date: 2026-07-27
Author: Codex
Status: CHANGES REQUESTED

## Summary

Round 5 已完整关闭 Round 4 的 revision/excision 问题，并把 writer lease receipt chain 推进成可落在现有 `meta`/events/capabilities 上的有界状态，原子 grant/release、O(1) 校验与 gap recovery 的方向正确。当前仍有两个 HIGH：当前 open writer 在 review/合同校验时尚未进入 `author_family_set`，且 adoption authority 未绑定 exact gap；另有一个 admission/dispatch 原子组合的 MEDIUM，因此 ship 三条件的充分性尚未成立。

## What's Good (Keep)

- `writer_chain` 使用 per-worktree kernel-owned bounded state，而 receipts 只承担审计/重建，避免 B3 无限 handoff 导致 completion 扫描 events；这与现有 `meta(key PRIMARY KEY, value)`、`Kernel.write`/CAS 和 1 秒事务预算可以干净衔接。
- Grant/release 把 capability issue/revoke、receipt 和 chain advance 放进同一事务，且完成、rework、B7、failure、forced-readonly、handoff 均被列为强制调用路径，关闭了 Round 4 指出的三类 durable intermediate state。
- Gap 不再只是永久 fail loud：obligation + audited adoption + explicit family attribution 给出了可执行恢复方向，并在 L/V 中对应 B3/B5/C5、V9/V15，没有引入场景外的常态 gate。
- Revision 的 authenticated lookup-first 已精确支持 stale `expected_before_digest` 的 commit-lost-response replay；same-key/different-payload conflict、`dag_tip` CAS 和同事务 revision event 组合正确。
- Excision source-state 表与 FINAL §1.1 terminal immutability 一致：active attempt 冲突，非终态无 active attempt 才 CAS canceled，done/B7-canceled 只做 membership removal。V14 已补齐三类终态和 replay 反例。
- `invalidate_ship_authority`、三条 ship 前置、fail-closed classifier、subject digest、lineage-root cascade 及 founder/Lead rulings 没有回退；详细版、压缩版、L/V 与 meta inventory 也基本同步。

## Issues & Recommendations

1. **[HIGH] 当前 open writer 在评审与合同校验时不在作者集合中；现有完成谓词要么拒绝全部非空 writer，要么允许同族自审后 ship。**

   **问题：** §C3 把 `author_family_set(span)` 定义为当前 `span_author_set`，而当前 lease holder 只有在 `release` 观察到 `HEAD != grant head` 时才被折入该集合。可是 review request/subject digest 在 completion 前产生，§C4 又按 `b writer_chain check → c contract/review validation → g release` 的顺序执行。最小反例是：初始 `span_tip=chain_head=H0, span_author_set={}`；Codex grant 于 H0，写出 product commit H1。此时 review subject 的作者集仍为空，Codex reviewer 满足 `Codex ∉ {}`；completion 也在 release 前以空集合验证该 verdict。随后 release 才把 Codex 折入集合，而 §C4.i 紧接着清空集合，完成事件仍引用先前的错误 digest。若其他三条 ship 条件满足，这个实际同族自审的 product diff 可以到达 merge。

   §C4.b 的“`chain_head` 与 `head` 一致性”不能消除此漏洞：active writer 写出 H1 时 `chain_head` 按状态机仍是 grant 时的 H0，直到 §C4.g 才推进。若该谓词要求相等，所有非空 writer completion 都会被拒；若实现为允许 open writer 的 head 领先，便落入上述安全漏洞。与此同时，release 只是“观测 canonical HEAD”而未要求它等于已分类/已评审的 `manifest.head`；manifest 构造后再 push 的 H2 可能被 release 吸收到 `chain_head`，但 completion 仍按 H1 的 manifest/digest 验证并清空作者集。

   **建议修复：**

   - 明确定义只读的 `effective_author_set(observed_head) = span_author_set ∪ ({open_lease.family} if open_lease exists and observed_head != chain_head else ∅)`；`chain_head` 在 open lease 期间就是该 lease 的 grant head，或把 `grant_head` 显式存入 `open_lease`。
   - Manifest/review-request 和 completion 都必须从同一套 kernel predicate 计算 effective set；当前 holder 一旦推进 HEAD，就在发起 review 时进入 `author_set_digest`，不能等 release 后才加入。
   - §C4.b 对 writer 的精确谓词应为：open lease 的 lease/attempt/family 与当前身份匹配、`span_tip == manifest.base`、fresh canonical `HEAD == manifest.head`、chain version/expected open lease 未变；不能要求 pre-release `chain_head == manifest.head`。§C4.g 的 release 必须携带 `expected_head=manifest.head` 和 expected chain version/open lease，HEAD 或 chain 任一漂移即整体回滚。
   - Contract validation 使用该 effective set；release 折入的集合必须与被验证并写入 `node_completed` 的 author-set digest 完全相同，之后才允许与 `span_tip` 推进一起清空。
   - V4/V12/V15 增加：首个单 writer 自审拒、首个 writer 的真正 cross-family review 成功、review 后 completion 前 push 拒、pre-release `chain_head != manifest.head` 的正常成功路径，以及 release 观察到不同 HEAD 时零状态转移。修复必须同步压缩 §1.7。

2. **[HIGH] `lease_adoption` 是能改写作者归因的 break-glass authority，但尚未绑定 exact gap、HEAD 和一次性 capability。**

   **问题：** §C3 目前只说 adoption 经 Lead/founder capability 显式授权、receipt UID 稳定、携带一个 family，然后把 `chain_head` 推到 H2。没有定义 UID/request digest、idempotency fast path、same-key/different-payload 行为，也没有要求 `open_lease IS NULL`、expected `chain_version/chain_head`、fresh canonical HEAD 或 obligation identity。更关键的是 capability 没有利用现有 `capabilities.subject_digest/consumed_at` 绑定“哪个 repo/worktree、从哪个 H1 到哪个 H2、归因哪个 family”。

   这会产生实际授权重放：人看到 H1→H2 并批准归因 Claude 后，若提交前 HEAD 又推进到 H3，现文可以把 H3 一并记给 Claude；旧 capability 也可能被用于后续另一段 gap。由于 adoption family 进入 `author_family_set` 并直接决定谁可作为 cross-family reviewer，错误或重放的 attribution 能使真实作者完成事实同族自审，破坏 P9/FINAL §2.6 对高权限显式 transition 的边界。

   **建议修复：** 定义 `adoption_uid` 和 canonical request digest，例如 `H(repo_identity, worktree_id, obligation_id, expected_chain_version, from_chain_head, observed_to_head, attribution_family)`。API 必须先按 `lease_adoption:<uid>` 做 authenticated idempotency lookup：同 digest 返回首次结果，异 payload conflict；首次执行要求 obligation 仍 open、无 open lease、meta version/head 与 expected 值相等、fresh canonical HEAD 恰等于 `observed_to_head`，且 one-shot capability 的 action/audience/subject_digest 精确匹配。Receipt、capability consume、obligation resolve、family fold、chain-head/version CAS 必须同一事务；HEAD 漂移须重新人工裁决，不能扩大旧授权。V9/V15 增加 adoption 的 stale-head、stale-version、双并发、commit-lost-response、异 payload 和旧 capability 用于新 gap 的拒绝案例。

3. **[MEDIUM] Writer-chain 的 admission 初始化与 dispatch grant 尚未和既有派发事务合成一个封闭 crash contract。**

   **问题：** §D2 admission 只列出 `ship_anchor/span_tip/dag_tip`，没有规定同事务初始化 `writer_chain`；§D1 仍写“attempt + launch command 同事务”，而 §C3 另写 grant 自己是单事务，但没有明确 grant 的 capability/receipt/open-lease CAS 是否就在该 attempt+launch 事务内。若 writer-chain 在首次 grant 时以“当前 HEAD”惰性初始化，admission fork point 后、首个 lease 前的 ownerless push 会被静默当成 chain 起点而绕过 gap；若缺行直接拒，首个 writer 永久不可派发。若 attempt+launch 与 grant 分两个提交，任一顺序都会留下“可被 dispatcher claim 的 writer launch 没有 lease”或“open lease 占住 worktree 但没有 launch command”的 crash 状态。

   **建议修复：** Admission 与 `span_tip` 同事务创建 `writer_chain={version:0, chain_head:fork_point, open_lease:null, span_author_set:{}}`，existing-row/different-payload fail loud。Writer dispatch 首次提交应原子写 attempt + launch command + writer capability + grant receipt + writer-chain open lease（同一个 dispatch/lease idempotency domain）；launch claim 同时核 capability/open lease 仍绑定该 attempt。若 launch 最终 failed/rejected/canceled，其 observation transition 同事务调用 release。V15 补 admission→first-grant gap、dispatch commit-before-response、grant/launch 任一失败与重复 claim；该补充直接服务 B5/C7/C8，只是封闭既有机制的事务边界。

## Verdict

CHANGES REQUESTED — address items above
