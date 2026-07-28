# Design Review — plan.md (FLY-1498) (Round 4)

Date: 2026-07-27
Author: Codex
Status: CHANGES REQUESTED

## Summary

Round 4 已实质关闭上一轮的 4 个 HIGH 与 1 个 MEDIUM：统一的 ship authority 失效原语、带 `dag_tip` CAS 的 revision、`--find-copies-harder`、多写者作者族集合，以及详细版与压缩版的一致性都成立。当前仍有一个新引入的 HIGH：`author_family_set` 的权威基础——writer lease receipt chain——尚未被定义成可崩溃重放、常数时间校验且可从 gap 恢复的完整状态机；另有一个 revision 终态/幂等谓词精度问题，因此本轮不能批准。

## What's Good (Keep)

- `invalidate_ship_authority(target)` 已成为真正的单一失效原语：`accepted` command 会在同事务被取消，`executing` command 则先取得不可逆线性化点并令业务变更冲突。V8 覆盖 rework、B7 cancellation、new gate 三组双序，关闭了旧 command 穿透授权失效的漏洞。
- Revision 的 `revision_uid`、`expected_before_digest`、`dag_tip` CAS、active-attempt conflict、永久 excision/current-membership 定义和全量 admission revalidation，使图变更具备了明确的并发所有权；给 running task 增 blocker 的旧 activation 漏洞也已封住。
- 分类器现在是完整且 fail-closed 的：`--find-copies-harder`、固定 similarity/rename limit、degraded detection rejection 和 C 两端取最严共同覆盖“未修改 product source 被复制到 docs/test”的反例。实盘 Git 探针也确认该命令将此情形报告为 `C100`。
- `subject_digest` 纳入 `author_set_digest`，且跨族谓词改为 `reviewer_family ∉ author_family_set`，正确关闭了 Codex/Claude 写者交接后由旧作者评审的 C5 反例；同 manifest、不同作者集也不能复用旧评审。
- canonical worktree HEAD、append-only evidence 的预期残留、copy detection 边界、author-set 的可信环境残余和 current membership 均已同步进入压缩并稿文本，没有在 living authority 中隐藏安全边界。
- Founder 的四句指令与 Lead rulings 仍被满足：review 是节点完成合同的派生证据而非 ship gate；ship 只有三条通用前置；test-only 不凭节点名产生 cross-family review；dispatcher 只认 DAG，三段式无特权。

## Issues & Recommendations

1. **[HIGH] Writer lease receipt chain 还不是一个原子、幂等、有界且可修复的状态机。**

   **问题：** §C3/§D1 规定每次 lease grant/release 都写 receipt，并以 receipt chain 推导 `author_family_set`；但 §C4 的完成事务只写“revoke writer capability”，§D3 的终止路径也只写 capability revoke，未规定 receipt 与 capability grant/revoke、attempt terminal、`span_tip` 推进之间的同事务边界，也未给 grant/release receipt 稳定的 `event_uid`、open-lease CAS 谓词或 commit-before-response replay 语义。B7、普通 failure、handoff/forced-read-only 路径同样没有封闭这套生命周期。于是 crash 可以留下“capability 已发但 grant receipt 未写”“release receipt 已写但旧 capability 仍有效”或“attempt 已 terminal 但 chain 仍 open”等状态；这些状态恰好位于作者归因和 cross-family review 的权威链上，会破坏 ship 三条件的构造性充分性。

   另外，B3 允许无限轮返工，而当前 schema 的 `events` 只有 `event_uid UNIQUE`，没有可直接承载 chain tip/开放 lease/累计作者集的约束。若 completion 每次从 append-only events 扫描 base 以来全部 lease receipts，成本随 handoff/rework 次数无界，无法兑现 1 秒事务预算。§C3 的“gap → completion rejected，收编=打回”也不是恢复协议：若最后 release head 为 H1、ownerless advancement 已到 H2，新 attempt 在 H2 grant 后依然不满足 `grant_head == H1`，单纯 rework 会永久重复同一 gap。

   **建议修复：**

   - 定义一个 per-worktree lease-chain state（可用 `meta['writer_chain:<worktree_id>']` 或等价 kernel-owned row），至少包含 chain version/tip、open lease identity、last release head 和 author-set accumulator/digest。Grant 必须以“无 open lease + canonical HEAD == expected chain head”为 CAS 谓词，在同一事务 issue capability、append stable-UID grant receipt、推进 chain state；release 必须在同一事务观察 canonical HEAD、revoke/consume capability、append stable-UID release receipt、关闭 open lease并推进 accumulator。
   - completion、rework、B7 cancellation、failure、forced-read-only/termination 和 handoff 全部调用同一 grant/release primitive；receipt UID（例如基于 capability/lease id）及 same-key/different-payload 行为必须明确。Completion 路径的 release receipt、writer revoke、node completion 和 `span_tip` CAS 必须明确处于同一原子提交，或给出等价且可证明的两阶段恢复协议。
   - Completion 只校验有界的 chain state/version CAS；append-only receipts 用于审计和重建，不在 1 秒 IMMEDIATE 事务内做无界扫描。增加最大规模、多轮 B3 handoff 的成功预算验收。
   - 给 gap 一个可执行恢复路径，而不只是 fail loud：例如冻结/保存 ownerless diff，回到已知 `span_tip` 后在新 lease 下重放；或落一个需要明确身份/作者族的 adoption receipt，再从该受控边界继续。增加 crash-at-every-boundary、grant/release replay、open-lease takeover 和 V9 gap-recovery 验收。该机制直接服务 B3/B5/C5 与 V9/V12，并非场景外扩张。

2. **[MEDIUM] Revision 的 excision 状态转移和幂等 fast path 仍欠精确。**

   **问题：** §D2.4 无条件写“目标 task CAS → canceled”。若目标已经 `done`，这会违反 FINAL §1.1 的 terminal immutability；若目标已因 B7 进入 `canceled`，后续 excision 应只改变 current-membership，而不应再次做非法/无意义的终态转移。另一方面，§D2.1 按文字顺序先做 `dag_tip` expected-before CAS、再描述同 UID replay；commit-before-response 后以旧 `expected_before_digest` 重放时，若未先查 revision event，就会在幂等返回前因 tip 已推进而冲突，和 V14 的承诺不一致。

   **建议修复：** 给 excision 一张明确的 source-state 表：有 active attempt 一律冲突；非终态且无 active attempt 才以 `state_version` CAS 到 `canceled`；`done`/已 `canceled` 保持原终态，仅由 `dag_revision` + new `dag_tip` 表示从 current membership 移除（或者明确禁止 excise `done`，二选一）。同时把 authenticated `revision:<revision_uid>` lookup 规定为 API 第一步：同 request digest 返回首次结果且不再要求旧 before-tip，异 payload conflict；仅首次执行才验证 expected-before 并在同事务写 event + CAS `dag_tip`。V14 应补 `done` excision、B7-canceled 后 excision，以及 stale expected-before 的 commit-lost-response replay。

## Verdict

CHANGES REQUESTED — address items above
