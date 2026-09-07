# FLY-2426 主仓锚 PR 误退休 — 探索
Issue: FLY-2426 (https://linear.app/geoforge3d/issue/FLY-2426/批准通路2394-founder-的两条批准通路对同一张卡全部失效-reaction-挂-13-小时reply-to)
日期: 2026-09-07
基于: 无

## 问题重述

Founder 对 FLY-2394 的 ship 卡先点了 ✅，后又逐字 reply-to-card `approve`，两条入口都没有推进 workflow。卡本身在 founder 第一次操作前已经被 `superseded_merged` 退休；因此本单修复错误的 merged authority 判定，不改 reaction/reply pickup，也不伪造或补写 founder 授权。

同一错误还命中 FLY-2381；FLY-2379 是必须解释的阴性对照。

## 快速红灯

基于 2026-09-07 11:21 PDT 对生产 `teamlead.db` / `comm.db` 做的 SQLite backup 副本，以及 GitHub 当前 PR 状态，运行 ordinary-candidate 风险复算：

```text
FLY-2394 probe=25:MERGED anchor=1103:OPEN
FLY-2381 probe=27:MERGED anchor=1109:OPEN
FLY-2379 probe=none anchor=1106 verdict=protected
misretirement-risk=2
exit=1
```

这个反馈环确定、约 2 秒、agent 可运行，并直接断言用户看到的静默失效前置条件：OPEN 主仓锚 PR 的 gate 会被同号旧 merged PR 带偏。

## 已确认事实

1. `external-merge-reconcile.ts` 的 ordinary candidate 来自 parked/completed `sessions`，按 `(project, issue, pr_number)` 分组，并以项目 `projectRoot` 调 `checkPrMerge(root, candidate.prNumber)`。
2. FLY-2394 有历史 completed implement session `pr_number=25`，同时当前主仓 anchor 为 `#1103`；FLY-2381 对应 `27` / `#1109`。
3. flywheel `#25/#27` 分别在 2026-03-16 / 2026-03-17 merged；Raya `#25/#27` 与 flywheel `#1103/#1109` 当前均 OPEN。
4. 误判后 `retireMergedGates()` 传入同 issue alias，再以同一错误 `candidate.prNumber` revalidate；因此 fresh check 仍返回 authorized，`TerminalGateRetirement` 随即把该 issue 的 open gate 写为 `superseded_merged`。
5. FLY-2394 gate 创建于 `03:00:37.893Z`，`03:01:04.507Z` 被退休；FLY-2381 gate 创建于 `08:31:49.899Z`，`08:32:58.258Z` 被退休。两者均早于 founder 后续批准操作。
6. FLY-2379 当前 StateStore session 集合只有主仓 `pr_number=1106`，没有 `pr_number=26` 的 ordinary candidate；所以 reconciler 没有机会把 flywheel `#26` 的旧 merged 状态套到这条 issue 上，gate 保持 `protected`。这解释了反例，不需要诉诸轮转或卡死。

## 测试 seam（冻结判据已确认）

- 公开驱动面：`createExternalMergeReconciler(...).pass()`。
- 外部边界：注入 `checkPrMerge`，让嵌套仓号在主仓同号为 merged、主仓 anchor 为 open。
- 业务观察面：`retireMergedGates` 是否被调用，以及其 `prNumber` / `revalidate()` 是否只绑定主仓锚 PR。
- 持久结果面：真实 `TerminalGateRetirement` + CommDB gate 是否保持 open。
- 正向对照：主仓锚 PR 确实 merged 时仍退休。
- 变异证明：手工恢复旧的“任意 session PR”选择后，阴性测试必须重新变红。

## 假设与预测

1. **最高概率：ordinary candidate 没有主仓锚身份。** 若候选先解析该 issue 的主仓 anchor，并只让该 PR 驱动 gate retirement，FLY-2394/2381 变为不退休，已 merged anchor 正向对照不变。
2. **次级：issueAliases 放大错误 authority。** 单独收窄 aliases 能部分止血，但无法修正 probe/finalization/TURN 对错误 PR 的理解，不满足“绑定主仓锚 PR”。
3. **低概率：rotation/negative cache/run stall。** FLY-2379 无 `#26` session candidate 已解释反例；这些时序机制不是根因。
4. **已否定：approval pickup 过滤。** gate 在批准发生前已 terminal-disposed，pickup 跳过它是后果。
5. **已否定：declared multi-repo repo slug。** 三条目标 run 没有 `workflow_declared_pr` 行；误退来自 ordinary path。

## 明示假设

- “主仓锚 PR”以 StateStore 当前主仓 `workflow_node_pr_binding`（`target_repo_identity='__main__'`）为首选权威；兼容 legacy 时才使用已明确属于主仓的 session evidence。
- OPEN / CLOSED-unmerged / UNKNOWN anchor 都必须 fail closed，不得退休 gate。
- 本单不改变 post-ship finalization、TURN reclaim、reaction/reply parser 或 gate recovery。

## 不在范围

- 不修死卡收敛（FLY-2427）。
- 不补 gate / approval / claim / authority 行，不写 `pr_head_sha`。
- 不终结 Runner，不 merge，不 deploy。
- 不重排 `plugin.ts`；如无需接线变化则保持字节不动。
