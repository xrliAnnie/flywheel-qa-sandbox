# Research: Worktree cleanup 机制 + 权威 merged 判定 — FLY-603

**Issue**: FLY-603
**Date**: 2026-06-26
**Source**: `doc/engineer/exploration/new/FLY-603-runner-worktree-cleanup.md`

---

## 1. 目的

把 exploration 的方向落成可实现的技术细节：(A) on-merge 钩子接哪、传什么；(B) reconciler sweep 的权威 merged 判定算法；(C) 存量选择性清理的判定逻辑（本 session 已执行）的方法学与实测结果。

## 2. 现有清理面 audit（不重造轮子）

| 方法 | 文件:行 | 行为 | 生产 caller |
|------|---------|------|-------------|
| `create()` | WorktreeManager.ts:114 | `git worktree add -B` sibling 路径 | Blueprint.ts:412 |
| `remove()` | :173 | rename → `worktree prune` → 后台 `rm -rf`（**不删分支**） | removeIfExists 内 + pruneOrphans 内 |
| `removeIfExists()` | :231 | remove worktree + **`branch -D`** + prune；返回是否清了东西 | **仅** Blueprint.ts:407（create 前清同名旧的） |
| `pruneOrphans()` | :304 | 遍历，**仅删目录已消失的孤儿登记**（行 319 `fs.existsSync` 命中即跳过） | run-infra.ts:496（boot）, DagDispatcher.ts:62/125 |
| `list()` | :217 | `worktree list --porcelain` 解析 | 多处 |

**关键缺口**：没有任何方法在「task done / PR merged」时被调。`removeIfExists` 正是要复用的方法（它已含 worktree remove + branch -D + prune + FLY-99 race 修），只是从没在完成路径接上。

## 3. on-merge 钩子（Layer A）接入点

### 3.1 唯一正确的钩子 = `runPostShipFinalization`

`post-ship-finalization.ts::runPostShipFinalization(opts, deps)`：

- **触发条件权威**：`isPostApproveShipComplete()` 强制 `landingStatus.status === "merged"`（FLY-208 5a）→ 只在真·merged 触发 → **天然满足「只清 merged」**。
- **原子单跑**：行 151 `insertEvent({event_id: post-ship-finalization-<execId>})` UNIQUE 认领，DES + event-route 双路只有一个赢家。
- **opts 已含** `executionId / issueId / issueIdentifier / projectName`。
- **deps.projects** 是 `ProjectEntry[]`，含 `projectRoot`（= mainRepoPath）。已在 orchestrator 内用 `resolveLeadForIssue(projects, projectName, labels)` 取 lead；同理可取 `project.projectRoot`。
- 现有 stage 顺序：(1) `postMergeTmuxCleanup` → (2) notifier → (3) thread teardown，每 stage 自吞错误、orchestrator 不 throw。

### 3.2 新增 stage 放在 tmux cleanup 之后

```
// stage (1.5) — worktree cleanup（tmux 已 kill，runner cwd 已释放）
try {
  const project = projects.find(p => p.projectName === opts.projectName);
  if (project) {
    await worktreeManager.removeIfExists(
      project.projectRoot, opts.projectName, opts.issueId /* 注意: issueId 非 identifier，见 §3.3 */
    );
  }
} catch (e) { /* audit, never throw */ }
```

顺序理由：runner tmux 的 cwd 就是该 worktree；先 `postMergeTmuxCleanup` kill tmux 释放 cwd，再删目录，避免「目录被占用」或删到活进程的工作区。

### 3.3 ⚠️ issueId vs issueIdentifier 陷阱（必须 plan 阶段坐实）

`worktreeManager` 的路径/分支由 `worktreeName(mainRepoPath, issueId)` = `<repoSlug>-<issueId>` 推出。**worktree 实际命名用的是哪个值**（Linear UUID `issue_id` 还是 human identifier `FLY-603`）决定钩子传 `opts.issueId` 还是 `opts.issueIdentifier`：

- 实测 sibling worktree 目录是 `flywheel-FLY-603`（human identifier），分支 `flywheel-FLY-603`。
- 故 `create()` 的 `issueId` 入参实际接收的是 **human identifier**（`FLY-603`），不是 UUID。
- → 钩子必须传**与 create 时同源的那个值**。plan 阶段须回溯 Blueprint.create 的 `issueId` 实参来源（DagDispatcher → Blueprint），确认传 `opts.issueIdentifier` 还是 `opts.issueId`，否则 `removeIfExists` 会算出错误路径、清不到。这是 Layer A 最大的正确性风险点。

### 3.4 注入 worktreeManager 到 orchestrator

`runPostShipFinalization` 现 deps 只有 `{store, projects}`。`WorktreeManager` 在 `run-infra.ts:460` 实例化，与 orchestrator 不在同一构造点。需把 worktreeManager（或一个 `removeWorktree(projectRoot, issueId)` 闭包）经 `PostShipDeps` 注入。保持可测试（注入而非 import 单例）。

## 4. reconciler sweep（Layer B）权威 merged 判定算法

### 4.1 为什么 naive 判定不行

`ship-on-comment.yml:147 merge_method:'squash'` → squash-merged 分支 HEAD 不是 main 祖先 → `git merge-base --is-ancestor` 对 merged 分支返回 false（漏判，over-keep）。若有人「修正」成反向判断会 over-delete WIP。两者都错。

### 4.2 squash-safe + reuse-safe + fail-safe 判定

一个 worktree 可清 ⟺ **全部**成立（任一不成立=保留）：

1. **非活跃**：该 issue 在 StateStore `sessions` 无 status ∈ {running, awaiting_review, approved_to_ship, pending, starting, queued}。
2. **干净**：`git -C <wt> status --porcelain` 空。
3. **无 OPEN PR**：`gh pr list --head <branch> --state open` 空。
4. **merged 铁证**（二选一）：
   - (a) `git merge-base --is-ancestor <HEAD> origin/main` 成功（HEAD commit 字面在 main 上，**TRUE 永远可信**），或
   - (b) 该分支存在 MERGED PR 且其 `headRefOid == <HEAD>`（**squash 后仍成立**：PR 记录的被 merge commit，与本地 tip 逐字相等 ⟹ 工作树正是被 merge 的内容，未被复用推新）。
5. **非嵌套父**：`<wt path>` 不是任何其他注册 worktree path 的前缀（避免删父毁子）。

### 4.3 为什么 (4b) 的 headRefOid 等值是关键

同名分支可挂多个 PR。`flywheel-FLY-369` 同时有 PR#353(merged, head=1cbdbebf)、PR#304(merged, head=0fb2d8f9)。本地 HEAD=1cbdbebf ⟹ 匹配 #353 ⟹ 安全。若 runner 之后在同分支推了新 commit（HEAD 前移），headRefOid 不再等值 ⟹ 自动保留。实测 `flywheel-FLY-286` HEAD=e581a680 ≠ 其 merged PR#280 head=53ff9855 ⟹ 正确判为 WIP 并保留。

### 4.4 数据源效率

- merged/open PR 全集各一次 `gh pr list --state merged|open --limit N --json headRefName,headRefOid` → 本地 dict 查 O(1)，避免逐分支 58 次调用。
- 活跃 issue 集：一次 SQL `SELECT DISTINCT issue_identifier FROM sessions WHERE status IN (...)`。
- per-worktree 仅 `git status` + `git merge-base`（本地，快）。
- 注意：`gh pr list` 离线/限速会失败 → Layer B 实现须 fail-closed（拿不到 gh 数据时该分支判「未证实 merged」=保留，不删）。

## 5. 存量选择性清理（本 session 执行）— 方法学 + 实测结果

用 §4.2 逻辑（人工先行版）扫全部 sibling worktree。结果（58 全覆盖、账平）：

| 类别 | 数量 | 说明 |
|------|------|------|
| **可清** | 38 | merged 铁证 + 干净 + 非活跃 + 无 OPEN PR + 非嵌套父；约半数 ancestor-of-main、半数 headRefOid-match |
| **HOLD（嵌套父）** | 2 | FLY-496（嵌套 `worktrees/fly314-qa-sandbox` 脏）、FLY-592（嵌套 `worktrees/pr-351`）→ 手动 |
| **保留** | 16 | WIP/no-merge-evidence(286,314,549) · OPEN PR(508,530,531,583,598) · dirty(560,567,572,581,599,604) · 活跃 session(594,598,599,**603=本 runner**,604,560) |

清理操作：`git worktree remove <path>`（**绝不 --force** —— 自带 dirty/lock 拒删，作第二道保险）+ `git branch -D <branch>`（已验 merged，安全；squash 后本地分支 ref 已无价值）。

清单已经 Lead（Tadashi）过目门控（QUESTION GATE），OK 后执行。

## 6. 实现取舍建议（给 plan）

1. **Layer A 优先级最高、改动最小**：~15 行 + issueId 来源坐实 + worktreeManager 注入 + 测试。防新堆积，价值/风险比最高。
2. **Layer B 次之**：把 §4.2 算法做成 `reconcileWorktrees(project, deps)`，boot 时调（紧邻现有 `pruneOrphans`），fail-closed。不新增 timer（boot-only 起步，周期化作 follow-up）。
3. **不碰** FLY-586/597/369 的 runner-liveness 根因；Layer A+B 对其鲁棒即可。
4. **测试**：Layer A 用 mock worktreeManager 验「merge → removeIfExists(projectRoot, …, 正确 id) 被调一次、在 tmux cleanup 之后」；Layer B 用 fake porcelain + fake gh/sql 验五判据各自的保留/清理分支（尤其 squash headRefOid-match、嵌套父保留、gh 失败 fail-closed）。

## 7. 结论

- 根因 = 完成/merge 事件无 worktree 清理钩子（设计层有意推迟给从未实现的 contract）+ pruneOrphans 只管目录已失踪的孤儿。
- 修法 = Layer A（on-merge 钩子复用 removeIfExists，纯 Bridge 侧、与 runner 存活解耦）+ Layer B（权威 merged 判定的 boot reconciler 兜底 unhappy path + 排空积压）。
- 最大正确性风险 = §3.3 的 issueId/identifier 来源；最大安全风险 = squash 误判，已用 §4.2 双铁证 + fail-safe 化解。
