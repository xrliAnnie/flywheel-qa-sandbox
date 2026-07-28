# FLY-1498 门与图 — 代码评审 R1
Issue: FLY-1498
日期: 2026-07-28
基于: `doc/engineer/plan/v2/design-chain/fly-1498-gates-dispatch.md`@5c6a755e

## Verdict

PR #717 的 request-driven cross-family review round 1 在
`5c6a755e30a68b6d0cc44789d81d577ac3fddfb9` 返回
`CHANGES_REQUESTED`。本文件只记录该轮与处置，不冒充后续 head 的 verdict。

## Blocking findings

1. `span-anchor-base-case`：admission 缺 merge-base anchor 基例，既有 feature/残留
   分支上首节点前的产品代码可落在合同链外。
2. `ci-axis-removal-assumes-branch-protection`：若 merge actor 是 admin，删除 v1 CI
   轴后单靠 branch protection 不能保证红 CI 合不进。

Lead 对第二项的裁定（question
`d811012b-4a52-410e-9201-d8fbbf83ba19`）：ship 事务仍恰好三条；required checks +
non-admin merge actor 是 GitHub 世界侧 deployment invariant，v2 启动时必须真实
探测，失败 fail closed 并保留 v1 lane；ship 不重新查询 CI。

## 本轮修订

- admission 固化 merge target + merge-base initial anchor，
  `span_tip=writer_chain.chain_head=anchor`；领先 HEAD 先走通用 writer-gap 归因，
  首个 done 从 anchor 消费完整 diff。
- span_tip 非 HEAD ancestor 时 typed fail closed；终态化 active attempt 后以普通
  新 worktree identity 重新 admission，禁止原地懒 re-anchor。
- v2 lane bootstrap 真实读取 GitHub ruleset/required checks、token actor permission
  与 bypass actors；unknown/403/空 checks/admin/bypass 均不注册 v2 merge capability。
- `maybe_refresh_ship_gate` 的 tip 只取同事务 span_tip；HEAD 落后/领先未结清时
  expire+typed alert，不让 excision/cancellation 吞 diff。
- forward migration 清单加入 issue-scoped gates 与显式 task|issue
  thread_bindings；0001/0002 checksum 不改。
- founder HTML 同步 actions、bounded reconcile 与 deployment invariant，删除
  “零新表/行为完全一样/写者租约链”旧口径。
- attempt 1 capability 与后续轮一致，绑定 gate/effect_key/repo/pr/head/attempt_no。
- default action agent 只读 merge target ref 配置快照并记录 digest。
- 删除会把并稿前 mapping APPROVED 冒充当前取代版 verdict 的标签。
- `writer_chain` key 明确为 per-worktree。
