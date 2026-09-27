# FLY-2901 接管失败自动重建 — 调研
Issue: FLY-2901 (https://linear.app/geoforge3d/issue/FLY-2901/codex接管-替身接管工作目录失败worktree-takeover-failed-worktree-not-found)
日期: 2026-09-25
基于: exploration.md

## 1. 失败后的真实链路（为什么会「held 等人」）

| 步 | 位置 | 行为 |
|---|---|---|
| 1 | `Blueprint.ts:1537-1547` | 返回 `failureKind: worktree_takeover_failed`，无 `launchFailure` |
| 2 | `DirectEventSink.emitFailed` `:1363-1373` | 写 Bridge 本地 pre-adapter 失败回执；引擎托管 run 把 session 置 `failed`，追加 `generalized_teardown_recorded` |
| 3 | `turn-belt-reconcile.ts:77-91` → `plugin.ts:14280-14308` | 发 `three_stage_takeover_failed`（warning）告警，文案「Inspect and preserve the parked phase's work before retrying」 |
| 4 | `run-dispatcher.ts:139-145` | 映射成 `precommit_failed`，`physicalEvidence: unknown` |
| 5 | `workflow-engine-dispatcher.ts:3197-3212` | evidence 未知 → 不释放 launch，节点停在 `admitted` |
| 6 | 未启动绊线 `:1451-1668` | 5 分钟告警，10 分钟回滚：`workflow_run.status='held'` + `unlaunched_admission_rolled_back` |
| 7 | Lead | 手工保全 + 清理 → `flywheel-comm hold resume --shape unlaunched_admission_rolled_back`；节点重置为 pending → 重派 → 再进 Blueprint takeover |

`worktree_not_found` 这一支更糟：它出现在 `workflow-engine-dispatcher.ts:2783` 的 `resolvePredecessorHead`（默认实现 = `resolveWorkflowHeadAuthority`，读前任 `sessions.worktree_path`），
在 admission **之前**抛出；`reconcile()` 只 `held += 1` 并打一行日志，每个 tick 重试，**没有任何告警**（绊线要求节点已 `admitted`）。
旧的非引擎路径（`run-infra.ts:1797` `phaseRetryStartPointComputer`）用的是 `refs/heads/<branch>` 分支尖，不依赖 `worktree_path`。

## 2. 关键约束（决定方案形状）

### 2.1 generation 绑定只能「设一次」
`WorktreeManager.create()` 每次写新的 generation 随机数到 git admin 区；`DirectEventSink.emitWorktreeReady` → `bindWorktreeOnce` 只在 `worktree_binding_generation IS NULL` 时写，
**没有改绑 API**。一旦删目录重建（新 generation），同一 run 里停驻 / 更早的执行体仍绑着旧 generation：
- `land-intent-targets.ts:466-472` → `worktree_generation_mismatch` → `land_target_snapshot_unavailable`（可重试但会一直卡 land）；
- `worktree-cleanup.ts:668-685` → `binding_mismatch` 跳过清理；`lifecycle-sweep.ts:919-926` 视为无主。

⇒ **原地清理（同路径、同 admin 区、同 generation）是首选**；删目录重建只留给「目录本身已经没了」这一类。

### 2.2 `removeIfExists` 会杀停驻体
`removeUnlocked` 先按 cwd 收割进程（`WorktreeManager.ts:1381`，`worktree-process-reaper.ts`）。停驻体的 cwd 就在共享目录里（`Blueprint.ts:2226-2255`），删目录重建 = 把它杀掉。
⇒ 又一条支持原地清理的理由。

### 2.3 head 权威
- 替身自己的 complete：Bridge 用替身自己的 binding 路径读 HEAD（`event-route.ts:1512-1600`）。同路径原地清理 → 天然一致。
- QA / 评审：`frozen_head_sha` 与绑定路径 HEAD 比对（`review-request-coordinator.ts:1343-1358`），QA 判决用 `resolveWorkflowHeadAuthority`。
  ⇒ 自动处置**不得往分支上加提交**；HEAD 只允许「保持不变」或「快进到 startPoint」或「在分叉时回到 startPoint（引擎认定的基线）」。

### 2.4 进度账本
`flywheel-comm progress` 要求写者是当前 running 且最新的活跃写者，会做一次 path-limited 提交（移动 HEAD），正文每次重写，frontmatter 只留
`plan|exploration|research|pr|reviewedSha` 指针。⇒ Bridge 不能也不该替替身写账本。可行做法：
- 给账本 schema 加一个 `rescue` 指针；
- Bridge 把证据写到 git 看不见的 `.flywheel/runs/takeover/<exec>.json|.md`（`.flywheel/runs/` 已在 `info/exclude`），并在替身提示词里注入一节，
  要求替身**第一次** `progress` 写入时带 `--pointer rescue=<branch>@<sha>`。这样账本里的证据由替身自己的提交落地，不动评审 head。

### 2.5 活体判定
- `probeGeneralizedLaunchLiveness` → `alive|dead|unknown`；停驻体进程是活的（设计如此）。
- 所以不能只看进程：要结合前任的**会话终态**。停驻体 = 已 `completed` + 活；额度死体 = 被判死（failed/terminated）+ 死或未知；
  僵尸（FLY-2572/2814）= 被判死但探针仍 `alive`；真在干活 = 非终态。
- TURN 在 Blueprint 之前已授予替身（`run-dispatcher.ts:1710-1750`）。按 TURN 法，停驻体不写共享目录。

### 2.6 嵌套仓（FLY-2122）
没有代码创建它们，是 runner 手工在 `paired/<repo>` 下建的 worktree（flywheel 仓的 `.gitignore` 有 `/paired/`，别的仓没有）。
被忽略的嵌套仓不影响 clean 判定、`git clean -fd` 也不动它 → 原地清理天然保住。未被忽略的会显示成未跟踪目录 → FLY-1707 存档函数拒绝（`unsupported_file_type`）。
⇒ 未被忽略的嵌套仓用「整目录挪走」保全（嵌套 worktree 用它自己主仓的 `git worktree move`，普通仓用 `rename`），挪走本身零损失，不需要判断里面有没有未推内容。

### 2.7 可复用件
- `WorktreeManager.quarantineAndRebuild`（FLY-1707）里「临时 index → 两层提交（已暂存 / 工作区）→ 不碰真实 index 与工作区」的存档算法，
  已有真 git 测试覆盖暂存 vs 工作区、改名、mode、symlink、clean filter 绕过、上限、未合并 index。本单把这段**抽成共用私有函数**，FLY-1707 行为不变。
- `bridge/worktree-quarantine.ts`（FLY-1185 §2.8）也能存档，但它连忽略文件一起存、面向回收场景，不适合这里。

## 3. 方案比较

| 方案 | 做法 | 结论 |
|---|---|---|
| A 原地清理（选中） | 保全 → `reset --hard <target>` + `clean -fd`（不带 `-x`）→ 复核 → 沿用同一 generation 接管 | 保住停驻体 cwd、generation、忽略文件（`node_modules`、`/paired/`），head 权威不变 |
| B 删目录重建（issue 字面） | 保全 → `removeIfExists` → `create(target)` | 换 generation → land 卡 `worktree_generation_mismatch`；会收割停驻体进程。**只用于目录已没了** |
| C 新路径旁建 | 在新路径建 worktree，改 `sessions.worktree_path` | 路径是确定性派生的（`expectedWorktree`），十几处消费者按键派生路径；binding 只能设一次。否决 |
| D 真 `git stash` | `git stash push -u` 记 SHA | stash 栈跨所有 worktree 共享，并发会话可能 pop 走；且 stash 不能推远端。否决，改用具名 ref + 推送 |
| E 只留本地 ref | FLY-1707 做法 | 普查明确要求「救援引用必须推送到远端」；本机出事仍会丢。否决：推送失败 = 停手 |
| F 把证据提交进 progress.md | Bridge 代写账本并提交 | 移动 HEAD → QA/评审 head 不一致。否决，改为替身首写时带 `rescue` 指针 |

### 3.1 目标 head 的取法
设 `H` = 目录当前 HEAD，`S` = `startPoint`，`R` = `origin/<branch>`（先 fetch）。

| 关系 | 目标 | 说明 |
|---|---|---|
| `H == S` 或 `S` 是 `H` 的祖先 | `H` | 与现行复用规则一致，不丢提交 |
| `H` 是 `S` 的祖先（落后） | `S` | 快进，零丢失 |
| 分叉 | `S` | `H` 上多出来的提交先推到救援分支；告警里点名 |
| `R` 存在且不是目标的祖先（含相等） | **拒绝** | 远端有目标里没有的工作 → 替身之后推送必然非快进 → 要人裁 |

> **修订（2026-09-25，Lead 转述 FLY-2463 病根后）**：上表「分叉 → S」对 FLY-2463 是错的——那里树是干净的，前任合法 rebase 到新 main 并把 H 推成了远端分支头，
> 按上表会因 `R` 不是 `S` 的后代而停手，等于没修。plan §2 改为：分叉且 `H == R`（已发布）→ 采纳 `H`；只有未发布的分叉才回到 `S`。

### 3.2 救援分支命名
`flywheel-rescue/<issueKey>/<predecessorExec8>-<successorExec8>`（普通分支，GitHub 上可见；不匹配 `flywheel-<ISSUE>` 的生命周期清理前缀，实现时要 grep 确认没有别的清理器会扫到它）。
本地同时写 `refs/flywheel/rescue/<run>/<successorExec>`。推送用 `<sha>:refs/heads/<rescue>`，**非强推、新建 ref**，推后 `ls-remote` 复核 SHA 相等。

## 4. 风险

1. 僵尸写者：两次指纹采样（改动路径 + mtime + size + HEAD + index 摘要）间隔 ≥ 5 s 且存档后再采一次，任何变化 → 停手。
2. 推送依赖网络 / 凭据：失败即停手（= 今天的行为，不更差）。
3. 大量未跟踪产物：沿用 FLY-1707 上限（2000 文件 / 64 MiB），超限停手。
4. 进行中的 git 操作（merge / rebase / cherry-pick / bisect）、锁定的 worktree、未合并 index：停手。
5. 目录已没时的 generation 续用（§2.1 的例外）：见 plan §4.4，这是本设计里最需要评审盯的一点。
