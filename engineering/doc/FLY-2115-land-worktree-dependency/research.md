# FLY-2115 land 授权脱离临时 worktree — 调研
Issue: FLY-2115 (https://linear.app/geoforge3d/issue/FLY-2115/病根-ship-收尾删掉-worktree而-land-的授权核验正需要它merge-已成功但-run-永不收敛-2)
日期: 2026-09-03
基于: exploration.md

## 当前调用链

`land-executor.ts` 在真正执行 land side effect 前调用 `evaluateWorkflowFounderReviewPrecondition`。该函数先用 `resolveWorkflowExactHeadAuthority` 找到当前 head 的不可变 PR binding，再调用：

```text
evaluateFounderReviewAuthority
  -> resolveFounderReviewVerdictAtCommit
    -> inspectFounderReviewArtifactsAtCommit
      -> realpathSync(repoRoot)
      -> git cat-file -e <head>^{commit}
      -> git ls-tree <head> -- <review path>
      -> computeFounderArtifactDigest
```

真正需要的是「一个能读取冻结 commit object 的 repository root」，不是产出节点 checkout。`git ls-tree <head>` 不读取 working tree 内容；只要主仓与 worktree 共享 object database，主仓当前 checkout 在哪个 commit 都不影响结果。

## 可用的权威输入

- `binding.head_sha` / `exactHeadAuthority.authorityHead`：冻结 Git commit。
- `binding.target_repo_identity`：`__main__` 表示项目主仓，land 当前也明确拒绝 nested repository。
- `projectName`：可映射 `projects.json` 中的 canonical `projectRoot`。
- founder review card binding：把 question id、run id 与 artifact digest 绑定；reader 已用它拒绝未投递/错 run 的 response。
- question/response：都绑定 artifact digest；现有 resolver 还会从冻结 head 重算 digest，防止 review 后改 HTML。

因此无需增加 receipt，也无需改 authority 写路径。只需在读取时，对 `__main__` binding 首选 canonical `projectRoot`，仍用原 resolver 对冻结 head 重算 blob digest。

## 兼容与失败策略

直接无条件换成 registry root 会让测试夹具或旧部署在 registry 缺项时退化。读取策略应是：

1. `target_repo_identity=__main__` 时，从项目 registry 找 canonical root。
2. 有 canonical root 时先用它验证冻结 head。
3. 若 canonical root 不可用、但原 binding worktree 尚在，允许用旧 root 完成同一套验证；这是兼容回退，不是缺失 worktree 的重建。
4. 两个 root 都不能验证时 fail-closed，返回 `founder_review_authority_unavailable`。
5. 非 `__main__` binding 不改变路径选择。

回退不会放宽授权：每个候选 root 都必须通过现有 `resolveFounderReviewVerdictAtCommit`；它仍检查 Git commit、artifact paths、blob digest、founder attribution 和 response 内容。

## 异常诊断

当前裸 catch 丢失了唯一有判别力的信息。最终失败日志至少写：

- error 的 `name` 与 `message`；
- run id / project name；
- binding worktree path；
- 尝试过的 authority root。

日志只用于诊断，返回值保持稳定的 fail-closed reason，避免把本机绝对路径写进持久业务状态或 API。

## Retry 分级判断

`founder_review_authority_unavailable` 不是在等待 founder 回答；同族 `missing` / `not_passed` / `stale_artifact` 才是在等待新的外部 review round。authority unavailable 表示本地权威证据无法读取：registry/root/commit/CommDB 任一处不满足核验。相同输入的周期重试不会产生新授权事实，默认烧完八档只会延迟同一结论。

选择显式 `terminal`：land operation 立即进入 held，workflow run 进入 held，并通过现有 land-held alert + audited resume 路径要求人工修复权威源后恢复。这样既不 fail-open，也不把确定性本地故障伪装成等待 founder。对真正的外部短暂故障，调用方应返回已有的 `external_outage`，而不是复用 authority-unavailable。

## TDD 覆盖形状

新增真实 Git + StateStore + CommDB 集成测试，不 mock verdict resolver：

- 建主仓和 linked worktree，在 head 上提交 founder HTML。
- 建 workflow run/node/exact-head PR binding，binding 指向 worktree。
- 建已投递 founder review card binding 与可信 response。
- 删除 linked worktree，再调用 workflow precondition；修复前应返回 unavailable，修复后应通过。
- 阴性对照复用同一删除形状，但 founder response 为不通过；结果必须仍是 `founder_review_not_passed`。
- stale artifact 对照：review digest 对应旧 head，而 authority head 的 HTML blob 不同；必须仍挡在 `founder_review_stale_artifact`。
- 两个 authority root 都缺失时，断言 fail-closed reason 且日志含 error 类型与两个路径。
- retry policy 测试把 unavailable 从 retryable 移到 terminal，并断言不增加 retry count、无 next attempt。

变异阳照：临时把 canonical root 选择中和回 binding worktree，删除-worktree测试必须红；临时把阴性 verdict 分支放行，阴性对照必须红。变异只在本地验证，不提交。

