# FLY-2115 land 授权脱离临时 worktree — 探索
Issue: FLY-2115 (https://linear.app/geoforge3d/issue/FLY-2115/病根-ship-收尾删掉-worktree而-land-的授权核验正需要它merge-已成功但-run-永不收敛-2)
日期: 2026-09-03
基于: 无

## 问题

engine-owned workflow 的 PR 已合并后，land 会再次验证 founder review 对当前产物的授权。当前实现把 `workflow_node_pr_binding.target_repo_path` 当作 Git authority root；这个字段指向产出节点的临时 worktree。ship cleanup 会先删除该 worktree，因此随后调用 `resolveFounderReviewVerdictAtCommit` 时，`realpathSync` 抛出 `ENOENT`。

异常又被 `evaluateWorkflowFounderReviewPrecondition` 的裸 `catch {}` 压缩成 `founder_review_authority_unavailable`。该 reason 未被 land retry policy 显式分类，会走默认 retryable、耗尽八档退避后 held；在耗尽前 workflow land node 一直 pending。

## 独立复核

2026-09-03 对生产只读状态复核，不把 issue 描述当作既成事实：

- FLY-2261 run `1ed28604-4c8f-4d86-9e73-e569bc6a66ed` 当前在 `land`，run 为 `active`，land node 为 `pending`。
- PR #1058 的 binding head 是 `4861207ccc5814e6bdf368405472ba02c235b10c`，`target_repo_identity=__main__`，`target_repo_path=/Users/xiaorongli/Dev/flywheel-FLY-2261`。
- 该 worktree 路径不存在；Node `realpathSync` 对它返回 `ENOENT`。
- canonical project root `/Users/xiaorongli/Dev/flywheel` 存在，且 `git cat-file -e 4861207...^{commit}` 成功；`git show` 能读取该 head。
- land operation 已有 `merge_confirmed`、`cleanup_requested`、`terminal_notified` receipt，但仍为 `partial`，`retry_count=8`，`last_error=founder_review_authority_unavailable`。
- 代码链闭合：`evaluateWorkflowFounderReviewPrecondition` 传入 binding worktree → `resolveFounderReviewVerdictAtCommit` → `inspectFounderReviewArtifactsAtCommit` → `realpathSync(resolve(repoRoot))`；外围为裸 catch。

FLY-1969 的历史行也保留相同 binding 形状。它目前已被后续恢复为 completed，且同名 worktree 已重建，因此只作为历史对照，不拿当前路径状态冒充首见时刻证据。

## 边界与假设

- founder review 必须继续 fail-closed。无法核验绝不能等价为通过。
- 不改 gate、claim、approval、authority 的任何写入；不改 `approve_to_ship` 判定。
- 本单只改 `founder-review-authority.ts`、`land-retry-policy.ts` 及测试、文档。
- 不改 `close-runner.ts`；不改 `post-ship-finalization.ts`，因此不需要与 FLY-2313 协调共享文件。
- `projects.json` 中的 `projectRoot` 是主仓权威路径；对 `target_repo_identity=__main__` 的 binding，主仓和临时 worktree 共享 Git object database，所以主仓可以按冻结 head 读取 tree，而不依赖 checkout 当前指向。
- nested repository 不在 land 支持范围内；本单不扩展该能力，非 `__main__` binding 保持原路径行为。

## 候选方向

1. 延后 worktree cleanup：跨 FLY-2313 边界，扩大生命周期耦合，而且任何其他 cleanup 仍可能再次破坏授权读取，不选。
2. worktree 缺失时重建：在错误依赖外包补偿，新增生命周期和清理风险，不选。
3. 缺路径时跳过 founder review：伪造授权真相，明确禁止。
4. 对主仓 binding 使用 canonical project root + 冻结 head：Git tree 查询不依赖当前 checkout，也不依赖临时 worktree 生命周期；改动最小，保留逐 blob digest 核验，选择此方向。

## 成功条件

- 删除 worktree 后，已通过且与冻结 head 产物一致的 founder review 仍能核验通过。
- founder 未通过、响应不可信或产物已变化时仍然阻挡，行为不放宽。
- 核验异常日志包含 error 类型和 worktree/canonical authority 路径。
- `founder_review_authority_unavailable` 不再默默耗尽默认 retry budget，而有明确、可诊断的分级。

