# FLY-2901 接管失败自动重建 — 实施计划
Issue: FLY-2901 (https://linear.app/geoforge3d/issue/FLY-2901/codex接管-替身接管工作目录失败worktree-takeover-failed-worktree-not-found)
日期: 2026-09-25
基于: research.md

**Status**: codex-approved → v5.2 **effective APPROVED（Lead 裁定 A1，2026-09-26）**。v5.1 经 Codex R1–R5（R5 APPROVED）；重派时服务端指定 gpt-6-astra 复核 R6 打出「被忽略内容可被 reset/clean 静默删除或覆盖」HIGH，Lead 裁定 (A) 在本单修，新增 §4.7a 忽略内容保全门，经 R6-2 / R6-3 / R6-4（两次被内容过滤中断，留执行证据）/ R6-5（纯书面）逐轮收窄；R6-5 的 symlink 解析链 HIGH 按 Lead 裁定补进 (e) 后不再送审。残余：(e) 最终措辞无 Codex 书面确认——实现阶段代码评审必须专门核 §4.7a (a)–(f) 全部分支与回归。其余章节自 v5.1 起不动。

## 0. 一句话

替身接管共享 branch-B 工作目录失败时，不再直接 held：先**证明**前任不会再写 → 把本地未推提交、未提交改动**推到远端救援分支并复核**、把未忽略的嵌套仓整目录挪走 →
**先落持久事件与证据，再**原地把目录清回干净（只有「已登记但目录没了」才重建并沿用 generation）→ 接管；任何一步证明不了「零丢失」就停手、目录不动、告警列出具体路径。

## 1. 范围

**做**
1. `WorktreeManager.runTakeoverTransaction()`：**一次持有 repo 锁**完成「exclude → 分类 → 采样 → 保全 → 写 manifest → 回调 Bridge 本地记录器写持久事件 → 破坏阶段 → 回调写 cleaned 回执」（R2 #2；锁可重入，内部 `create()` 不死锁）。
2. `Blueprint` 的 takeover 入口改为「先算候选，再在 repo 锁内按 登记×存在 分类」（§2.1），不再让 `isRegistered()` 的 false/异常静默回落老路。
3. 引擎派发器：计算「前任不会再写」许可证（§3）；`resolvePredecessorHead` 回退链 + 去重告警（§4.6）。
4. 证据：git 不可见的证据文件 + 替身提示词一节 + `workflow_run_event` + 账本 `rescue` 指针（由替身首写落地，CLI 与 schema 都改）。
5. **FLY-2122 根治（Lead 裁定的条件①）**：跨仓评审的嵌套目标固定放在树内 `.flywheel/review-targets/<repo>/`；
   Blueprint 把 `.flywheel/review-targets/` 与 `.flywheel/runs/` 两条**精确**写进 `info/exclude`；`--target-repo` 提示词指向该位置。
   `complete.ts` / `resolveReviewTarget` 的「必须严格位于绑定工作树内」包含校验**不动**（安全边界）。

**与 FLY-2122 阴性对照的关系（Lead 2026-09-25 两次裁定，已定）**
- clean 判定（`assertCleanTree`）一字不改；脏仍判脏。
- 阴性对照改为两条：(a) 许可证不过（前任在跑 / 僵尸 / 无法证明）时，往共享树放未跟踪目录 → 接管必须失败，失败原因列出具体脏路径；
  (b) 许可证通过时 → 嵌套仓被原样挪到救援目录（内容 + git 元数据零损失；嵌套 worktree 用其主仓 `git worktree move`），证据 / 事件 / 告警列出路径，然后接管成功。
- 放在 `.flywheel/review-targets/`、`.flywheel/runs/` 之外的未跟踪目录仍判脏（exclude 只精确排除这两个目录，不用更宽的通配）。

**不可关闭的损失防线（R2 #1）**：§2.1 入口矩阵里的三条拒绝（`registration_indeterminate` / `worktree_head_unreadable` / `unregistered_present`）以及「未登记且目录不在但本地分支有独有提交」的拒绝，
**不受 kill switch 控制**——它们只拦住今天会静默 `rm -rf` / `branch -D` 丢数据的路径。kill switch 只决定「是否尝试自动保全 + 清理」。

**不做**
- 不改 FLY-1707 `workflowResume` 的对外语义（只把存档算法抽成共用函数，原测试原样通过）。
- 不修 FLY-2528 / FLY-2329；不修前任死因；不做真 Codex 替身演练（等 Codex 服务恢复后由 QA 另行验证）。
- 不自动回收救援分支 / 救援目录（Lead 条件③：至少保留到该 issue ship 之后；本单不写任何回收逻辑，回收另起单）。
- 「未登记且目录不存在」保持今天的新建路径（它不是普查里的失败类，改成停手会造成回归），只在 `branch -D` / `-B` 之前补本地分支尖保全（§2.1 第 5 行）。

## 2. 分类与处置（单一真相表）

### 2.1 入口：登记 × 存在（repo 锁内）
`takeoverCandidate` = `!workflowResume && shareParentBranch && (implement|qa 带 startPoint || design 带 startPoint 且无 continuityInherit)`（与现行谓词相同，只是去掉 `isRegistered`）。
候选成立后，在 `WorktreeManager` 的 repo 锁内一次性探测：

| 登记 | 目录 | 处置 |
|---|---|---|
| 探针异常（`worktree list` 失败） | 任意 | 停手 `registration_indeterminate`，不 prune、不 create |
| 已登记 | 在，HEAD 可读 | 进入 §2.2（今天能复用的仍直接复用，字节不变） |
| 已登记 | 在，HEAD 不可读 | 停手 `worktree_head_unreadable`（任意文件无法用 git 快照证明已上远端） |
| 已登记 | 不在 | `worktree_missing`：admin 区 `gitdir` 反查指向期望路径 + 读出 generation + 分支名吻合（任一失败停手 `generation_unrecoverable`）→ 按 §2.2 的 `L` 规则定 target → 不在 target 里的 `L`/`S` 推救援 → 写 manifest + 事件 → `worktree prune` → `create({startPoint: target, carryGeneration})` |
| 未登记 | 在 | 停手 `unregistered_present`（不再 `rm -rf`；列路径）。不可关闭 |
| 未登记 | 不在 | 本地分支 `refs/heads/<branch>` 不存在或其 tip `⊑ startPoint` → 老路 `removeIfExists` + `create(startPoint)` 不变。否则：自动化开着 → 推 `-head` 救援 + manifest + 事件，成功后再走老路；自动化关着或推送失败 → 停手 `unregistered_branch_unique_commits`。不可关闭 |

### 2.2 已登记且可读：细分类
设 `H` = 目录 HEAD，`S` = `startPoint`，`R` = 远端分支头（§4.3 取法）。

| 标识 | 判据 | 处置 |
|---|---|---|
| （复用） | 干净且 `S ⊑ H` | 今天的原地复用，**不进入本流程** |
| `dirty` | 非空 status，无未忽略嵌套仓，`S ⊑ H` | 两层快照 → 推 `-dirty` → 原地清理回 `H` |
| `nested_repo` | 未跟踪项中有目录是 git 仓 / worktree 根 | 其余脏内容按 `dirty`；嵌套仓整体挪到救援目录（§4.4） |
| `head_behind` | `H ⊏ S` | 快进到 `S`（有脏先快照） |
| `head_published_diverged` | 分叉且 `H == R`（FLY-2463） | 采纳 `H`；`S` 不 ⊑ `H` → 推 `-base` |
| `head_diverged` | 分叉且 `H` 未发布 | 推 `-head`（或含脏的 `-dirty`）→ 回到 `S`；额外 info 告警 |

目标 `target`：按顺序取第一个满足「`R` 不存在或 `R ⊑ c`」的候选 `c`：① `H`（当 `S ⊑ H` 或 `H == R`）；② `S`。都不满足 → 停手 `remote_not_ancestor`。

`worktree_missing`（R2 #4）：用 `L` = admin 区记录的分支对应的本地 ref tip 代替 `H`，规则相同——① `L`（当 `S ⊑ L` 或 `L == R`，且 `R` 不存在或 `R ⊑ L`）；② `S`（`R` 不存在或 `R ⊑ S`）；否则 `remote_not_ancestor`。`L` 缺失时只能选 ②。
不在 target 里的 `L` / `S` 按同一不变式推救援。
**额外规则（R3 #1）**：`worktree_missing` 会重建 / 重置分支，而现有 `create()` 在 post-add 失败时回滚会 `branch -D`。所以只要 `L` 存在且 `L ≠ R`（本轮 `ls-remote` 验证的远端分支头），**即使 `L == target` 也先把 `L` 推到 `-head` 救援并复核**，保证任何失败路径下 `L` 都由已验证的 named ref 可达。

**零丢失不变式**（代码断言，违反即停手、不做破坏性动作）：`{H, T(脏快照 tip), S}` 中每一个要么 `⊑ target`，要么 `⊑` **本次推送并经 `ls-remote` 复核**的某条救援 ref；且 `R ⊑ target`。
**不**用「其他远端 ref 已包含」免推（本地 remote-tracking ref 可能陈旧）——不在 target 里的 tip 一律推自己的不可变救援 ref。

### 2.3 通用停手前置（任一不满足即停手；不做任何 worktree / ref / admin / event 的保全或破坏性写入——唯一例外是 §6 的幂等 exclude 根治写入，R3 #4）
许可证 `allowed=true`（§3）；kill switch 未开（§7）；无进行中的 git 操作（`MERGE_HEAD` / `rebase-merge` / `rebase-apply` / `CHERRY_PICK_HEAD` / `REVERT_HEAD` / `BISECT_LOG`）；worktree 未 lock；
无未合并 index；快照在上限内（2000 文件 / 64 MiB，沿用 FLY-1707）；`R` 探测成功；Bridge 本地事件能力可用（§4.5）；
原地清理类（目录存在）在选定 `target` 后通过 §4.7a 忽略内容保全门（v5.2，R6 HIGH）。

## 3. 许可证：前任不会再写（派发器计算，放进 Blueprint ctx）

`takeoverRescuePermit: { allowed; reason; predecessors: Array<{executionId; sessionStatus; liveness; pathSource}> }`。

**前任集合**：同 run 中除自己以外的每个 execution，只要 `sessions.worktree_path` **或** `getWorktreeBinding().path`（任一）经 `worktree-paths.ts` 的 missing-leaf canonicalizer 后等于期望共享路径，就纳入。
两个来源互相冲突、读取失败、身份字段不完整 → `permit_indeterminate`。

**活性证据**：`probeGeneralizedLaunchLiveness(execId, project, { allowMissingTargetHostAbsence: true })`（即 dead-exec 判死用的「tmux 目标缺失 + 宿主进程按 exec id 缺席」证明）。

| 前任会话状态 | 活性 | 判定 |
|---|---|---|
| `completed`（停驻；TURN 已交出，按 TURN 法不写） | 任意 | 可 |
| 被判死（`failed` / `terminated*` / `blocked`） | `dead` | 可 |
| 被判死 | `unknown` | **否** `permit_indeterminate` |
| 被判死 | `alive` | **否** `zombie_writer` |
| 非终态 | 任意 | **否** `live_writer` |

全部为「可」才 `allowed=true`。计算异常 → `permit_indeterminate`。许可证是必要条件，Blueprint 内另有内容指纹三次采样（§4.2）兜底。
说明：普查里 21/40 的前任是额度墙死体，它们被 dead-exec 扫描判死时走的正是上述「目标缺失 + 宿主缺席」证明，所以这条收紧不会让主形状失效；实现时用这 21 条的 exec 形状写一条夹具确认。

## 4. 机制细节

### 4.0 事务与锁（R2 #2）
`runTakeoverTransaction(opts, recorder)` 在 `this.locked(mainRepo, …)` 内一次跑完 §4.5 的全序列；`recorder` 是 Blueprint 传入的 Bridge 本地**双向**能力（R3 #2）：
- `loadPendingTakeoverRescue({runId, canonicalPath})`：由 `DirectEventSink` 用现有 `StateStore.listWorkflowRunEvents()` 找本 run 中该 canonical 路径上「有 `worktree_takeover_rescued`、没有对应 `cleaned:<uid>`」的事件，返回事件 payload；
- `recordRescue(manifest)` / `recordCleaned(uid)`：均 awaited，抛错即停手。
事务第一步（exclude 之后、入口矩阵与 kill switch 判断之前、仍在锁内）调用 `loadPendingTakeoverRescue`；有 pending 就只走 §4.5 的崩溃重入分支。
HTTP / NoOp emitter 没有这套能力 → `rescue_event_capability_missing` 停手（共享接管候选路径上一律如此）。
锁内包含 5 s 采样与网络推送（推送设 60 s 超时）。这会让同一主仓的其他 worktree 变更在这段时间排队——处置本身很少发生（普查 14 天 45 次），用短暂排队换掉 TOCTOU 是划算的。
`WorktreeManager` 未注入 `withRepoLock` 时（`locked()` 退化为直通）→ 停手 `repo_lock_unavailable`，不在无锁状态下做破坏性动作。

### 4.1 保全阶段（事务内，无破坏性动作）
1. 抽出 `snapshotWorktreeState()`（FLY-1707 同一算法：临时 `GIT_INDEX_FILE`、`RESUME_GIT_SAFE_CONFIG`、两层 `commit-tree`、上限、路径逃逸 / 不支持类型 / 未合并 index 拒绝）。
   嵌套仓在快照前从 status 条目中剔出，单独走 §4.4。快照链：`H → stagedCommit → worktreeCommit`，tip 记 `T`（无脏 `T=H`）。
2. 需保全的 tip 集合 = `{T, H, S}` 中不 ⊑ target 的（去重，`T` 覆盖 `H` 时只推 `T`）。
3. 每个 tip 写本地 `refs/flywheel/rescue/<runId>/<predecessorExec>/<successorExec>/<stamp>/<kind>`（`update-ref` 带旧值 0）；
   远端分支 `flywheel-rescue/<issueKey>/<pred8>-<succ8>-<stamp>-<kind>`，`<stamp>` = UTC `YYYYMMDDTHHMMSSZ`（Lead 要求名带 exec id 与时间）。
4. 主仓 `git push --atomic origin <tip>:refs/heads/<rescue>…`（非强推、新建 ref；走 `RESUME_GIT_SAFE_CONFIG`，这是 Bridge 新建的 ref，不是分支改写）。
5. 每条 `git ls-remote origin refs/heads/<rescue>` 必须等于对应 tip，否则停手 `rescue_push_unverified`。
6. 返回 `RescueRecord`（全部 tip、ref、嵌套仓挪动计划、fingerprint 2、target）。

### 4.2 内容指纹（防僵尸写者；R1 #8 采纳）
指纹 = `HEAD` + `write-tree`（真实 index）OID + status 原文 sha256 + 每个非删除变更路径的**内容 sha256**（symlink 用 link target；删除用显式 sentinel）+ 嵌套仓各自的 `HEAD` 与 status 摘要。
- 采样 1 → 等 `TAKEOVER_STABILITY_WAIT_MS`（5 s，可注入）→ 采样 2，不等 → 停手 `worktree_unstable`；
- 保全阶段结束后、写事件之前采样 3，与 2 不等 → 停手 `worktree_changed_during_rescue`（已推的救援保留，不回滚）。

### 4.3 远端分支头 `R`（R1 #4 采纳）
`git ls-remote --heads origin refs/heads/<branch>`：空 = 远端不存在（合法）；命令失败 = 停手 `remote_probe_failed`；
存在则按 advertised OID `git fetch --no-tags origin <oid>`（仓内 `quarantineAndRebuild` 同款），fetch 失败停手 `remote_head_unreachable`。不依赖任何本地 `refs/remotes/*`。

### 4.4 嵌套仓挪走（`nested_repo`）
- 判定：未跟踪条目是目录且 `git -C <dir> rev-parse --show-toplevel` 的 realpath 等于该目录 realpath。忽略的（如 `/paired/`、`.flywheel/review-targets/`）不出现在 status 中，原地保留。
- linked worktree 的判定（R2 #6）：只有在其 common-dir 的 `git worktree list --porcelain` 里能找到这个 exact toplevel（realpath 比较）时才走 `git worktree move`；submodule / `--separate-git-dir` 等其他 gitfile 仓按普通仓 `rename`。命令一律 argv 调用，提示词里的路径做 shell quoting。
- 目标：`<FLYWHEEL_STATE_DIR>/state/takeover-rescue/<runId>/<successorExec>/<stamp>/nested/<relpath>`（与共享树同卷；`EXDEV` / 目标已存在 → 停手 `nested_move_failed`）。
- 嵌套 worktree（`.git` 是文件）：用其主仓（`rev-parse --git-common-dir` 反推）执行 `git worktree move`；被 lock 或 move 失败 → 停手。普通仓：`rename`。
- 挪走发生在破坏阶段（§4.5 之后），挪完核对新位置的 `HEAD` 与 status 摘要等于采样 3 记录的值。
- 救援目录不被任何代码自动清理（Lead 条件③）。

### 4.5 持久化顺序（R1 #5 + R2 #3，硬合同，全部在 §4.0 事务内）
```
ensure exclude（§6，失败即 exclude_unavailable）→ 分类（含选定 target）→ §4.7a 门（第一次）→ fingerprint 1 → wait → fingerprint 2
→ 保全（push --atomic → 逐条 ls-remote 复核）→ fingerprint 3
→ 以 temp+rename 写 canonical manifest 到 <FLYWHEEL_STATE_DIR>/state/takeover-rescue/<runId>/<successorExec>/<stamp>/manifest.json（失败 → rescue_evidence_unrecorded）
→ recorder.recordRescue：appendWorkflowRunEventChecked(worktree_takeover_rescued, UID, payload 含 manifest sha256) 成功（失败 → rescue_event_unrecorded）
→ 【破坏阶段】原地类先过 §4.7a 门（第二次）→ 挪嵌套仓（到同一 <stamp>/ 目录下）→ reset --hard target → clean -fd / 或 prune + create → 复核
→ 把 manifest 镜像到 <worktree>/.flywheel/runs/takeover/<successorExec>.json|.md
→ recorder.recordCleaned：appendWorkflowRunEventChecked(worktree_takeover_cleaned, UID = "cleaned:" + rescue UID)
```
manifest 对**所有**分类都存在（包括目录不存在、`rescues[]` 为空的 `head_behind`、只有嵌套仓的情况），它就是这次处置的通用证据地址；远端救援 ref 只是 manifest 里的内容。
manifest 内容（R3 #2 / R4 #2）：`canonicalPath`、`branch`、`generationBefore: string | null`（原地清理 = 现 marker；missing = admin 区读出值；未登记且不在 = `null`，只有非 null 时才做 generation 比较）、`class`、`target`、`fingerprint3`、`rescues[]`、`nestedMoves[]`（全文统一用这个名字）。
manifest **不含**自身哈希（R4 #1）：先用确定性序列化（键排序的 JSON + 结尾换行）写出最终字节，对这些**确切字节**算 sha256；事件 payload 带 `{manifestPath, manifestSha256}` 以及上面的身份字段副本。
确定性序列化（R5 MEDIUM）：字节 = 仓内 `canonicalJsonString(manifest) + "\n"`（`packages/config/src/canonical-json.ts`，对象键**递归**排序、数组顺序即数据）；构造 manifest 与事件共用的身份对象前，`rescues[]` 按 `kind` 排序、`nestedMoves[]` 按仓内相对源路径排序（相同再按目标路径），同一已排序数组同时写进 manifest 与事件。
重入时先读 manifest 原始字节、核对 sha256 等于事件值，再 parse 并与事件里的身份字段逐项交叉比对；任一不等 → 破坏阶段前停手 `rescue_resume_mismatch`。
目录布局（R3 #3）：`<stamp>/manifest.json`、`<stamp>/nested/<relpath>`——嵌套仓与 manifest 不共用命名空间。
- 事件 UID = sha256(runId, successorExec, 全部 tip, target)；用仓内 content-addressed replay API（`StateStore.ts` ~68819），重复写同内容幂等、异内容拒绝。
- 事件写失败 → 停手 `rescue_event_unrecorded`，**不进入破坏阶段**。「已保全」事件写后不改写；清理结果单独追加 `worktree_takeover_cleaned`。
- 能力接线：`ExecutionEventEmitter` 新增可选方法 `loadPendingTakeoverRescue()` / `recordTakeoverRescue()` / `recordTakeoverCleaned()`，只有 Bridge 本地 `DirectEventSink` 实现；
  emitter 缺该能力 → 停手 `rescue_event_capability_missing`。HTTP `/events` 对这两个 kind 返回 400（与 pre-adapter 回执同样防伪造）。
- 崩溃重入：下一次派发若在同一路径发现已记录但未 `cleaned` 的 rescue 事件，且当前目录指纹等于事件里的 fingerprint 3 → 直接进入破坏阶段；
  若目录已干净且 `HEAD == target`（`worktree_missing` 还要求 generation == 事件记录值）→ 只补镜像与 `cleaned` 回执；其余情况停手 `rescue_resume_mismatch`。
  重入绝不落入「未登记且不在」老路新发 generation：只要存在未 `cleaned` 的 rescue 事件，该路径的老路被禁止（R2 #7）。嵌套仓目标目录已存在时不覆盖，停手 `nested_move_failed`。

### 4.6 派发器 head 回退（`predecessor_path_missing`）
`resolvePredecessorHead` 默认实现改为链：`resolveWorkflowHeadAuthority` → 失败原因为 `worktree_not_found` / `git_head_unavailable` 时读前任 binding 路径 HEAD →
再失败读主仓 `refs/heads/<binding.branch 或派生分支名>`（与 `run-infra.ts` `probePhaseRetryBranchTip` 共用）。
全部失败：按执行体去重发一次 `three_stage_takeover_failed`（reason=`predecessor_head_unavailable`），保持按 tick 重试。不回写前任的 `sessions.worktree_path`。

### 4.7 原地清理与重建
- 原地：`git reset --hard <target>` → `git clean -fd`（不带 `-x`）→ 复核 status 为空且 `HEAD == target`，否则停手 `post_clean_dirty`（此时事件已在，Lead 可按事件里的救援 ref 处理）。generation 不变。
- `worktree_missing` 重建：`create()` 新增仅内部使用的 `carryGeneration` 选项，写回从 admin 区读出的旧值；事件记 `generationCarried: true`。
  安全论证：FLY-1185 generation 防的是「别人在同一路径重建同名目录」（ABA）；这里由同一 Bridge 在同一 repo 锁内、以已保全的目标重建，语义上是同一 worktree 的延续。
  被否：新发 generation + 新增改绑 API（要动 binding 一次性合同，范围远超本单）。

### 4.7a 忽略内容保全门（v5.2，R6 HIGH，Lead 裁定 A）
问题：被 `.gitignore` / `info/exclude` 忽略的未跟踪内容不出现在 status，不进快照、不进指纹、不进救援 ref；但 `reset --hard target` 会覆盖 target 开始跟踪的同路径，
而 `clean -fd`（不带 `-x`）按 **reset 之后**的忽略规则判定，target 删掉某条忽略规则就会把原先被忽略的文件当成未跟踪删掉。两种情况事务都会报成功、原字节无任何副本（复现见 `codex-review-round6.md`、`repro-r6/`）。
「不带 `-x`」本身**不**构成保留证明。

门 `assertIgnoredContentSafe(worktree, target)`（只用于目录存在的原地清理类；`worktree_missing` / 未登记且不在没有旧目录内容，不适用）。
**不枚举忽略内容、也不在 target 规则下重算忽略**（R6-3：`--directory` 枚举会被同名 index 文件遮住、规则文件有大小写别名与 `core.excludesFile` 等多个来源——预测式判据一再漏）；改为只看「reset 会写哪些路径」并核对这些路径上的磁盘现状，外加「会不会改动规则源」。
基线是当前 index / 工作区（reset 的输入），**不因 `target == H` 跳过**（R6-2 #1）：
1. `D` = `git diff --name-only -z --no-renames <target>`（target 树 对 当前工作区，含 index 里有而 target 没有、target 有而 index 没有、内容 / 类型不同的全部路径）= `reset --hard target` 会写或删的全部路径。
2. 路径冲突（reset 会覆盖 / 删除的不在保全范围内的东西）——对每个 `p ∈ D`：
   (a) `lstat(p)` 是目录 → 冲突（跟踪路径位置上的目录，里面可能有 status 看不到的忽略内容，R6-3 #1）；
   (b) `p` 不在当前 index（`git ls-files -z --cached --error-unmatch` 语义）且 `lstat(p)` 存在，且 `git check-ignore --no-index -q -- <p>` 判为忽略 → 冲突（未忽略的未跟踪文件已在 §4.1 快照里）；
   (c) `p` 的任一真祖先在磁盘上存在且不是目录、又不在当前 index → 冲突（reset 建目录时会删掉它）。
   `lstat` 走真实文件系统，macOS 大小写不敏感时天然命中大小写变体；`check-ignore` 遵循仓库 `core.ignorecase`。
3. 规则源冲突（clean 用的忽略规则会变）：
   (d) `D` 中任一路径的末段按大小写不敏感等于 `.gitignore`（覆盖 `.GITIGNORE` 等别名，R6-3 #2）→ 冲突；
   (e) 实际生效的全局忽略文件落在工作树内 → 冲突（R6-3 #3；罕见配置，一律保守拒绝，不试图判断它是否被 reset 改写）。「实际生效」= `git config --path --get core.excludesFile` 有值时取该值，否则取 git 默认 `$XDG_CONFIG_HOME/git/ignore`（`XDG_CONFIG_HOME` 未设时 `$HOME/.config/git/ignore`）；不能只看最终 realpath（R6-5 HIGH：树内被跟踪的 symlink 指向树外文件时，realpath 在树外，但 reset 换掉这个 symlink 就换掉了 git 读到的规则）——做**整条解析链**检查：
   取未解析的绝对路径名（配置值是相对路径时，按 git 在工作树根执行时的解释拼成绝对路径——它本身就落在树内，直接拒），从根逐段 `lstat`，遇 symlink 就读出目标并继续解析（相对目标按其所在目录拼接，设跳数上限 40，超限即拒），记录经过的**每一个**路径名（原路径名、每个中间前缀、每一跳 symlink 本身及其目标）；
   任一路径名落在工作树内即拒——比较时对工作树同时用字面绝对路径与 realpath 两种形式、按路径段前缀比较（`core.ignorecase=true` 时大小写折叠）。解析失败（不存在的中间段除外、权限错误等）→ 保守拒绝。
   (f) 当前 index 里任一条目带 assume-unchanged 或 skip-worktree 标记（`git ls-files -z -v` 的小写标签或 `S`）→ 冲突（这类条目会让 `git diff` 看不到工作区真实改动，`D` 不再完整；保守拒绝）。
   **不设安全根豁免**（R6-2 #2）；也不以「目录里有没有忽略内容」为前提——共享树里 `.flywheel/runs/` 几乎总在，这个前提只会引入枚举漏洞。
4. 有冲突 → fail-closed 停手 `ignored_content_at_risk`，失败文案列出触发的路径与规则（(a)–(f) 标签 + 路径前 20 条，超出 `…(+N more)`），走 §4.8-5 同一转义规则。**不可关闭**（它是损失防线；kill switch 开时本来就不进原地清理）。
5. 充分性论证：`reset --hard target` 只写 / 删 `D` 中的路径（及为其创建 / 移除的父目录）。(a)(b)(c) 保证这些位置上不存在「不在 index 且未被快照」的内容：index 里的内容在 `H` / 快照里，未忽略的未跟踪内容在快照里，被忽略的内容命中即拒绝。
   `clean -fd`（不带 `-x`）只删 reset 后规则下未被忽略的未跟踪项，不删被忽略项、也不删仍含被忽略项的目录；reset 后的规则来源 = 工作树内各 `.gitignore`（只有 `D` 里的会变，(d) 已拒）+ `info/exclude`（在 git 目录内，不随 reset 变）+ 全局忽略文件——git 按路径名查找它，(e) 保证这条查找的**整条解析链**（路径名本身、每个中间前缀、每一跳 symlink）都不在工作树内，因此 reset 既改不了它的内容、也改不了它解析到哪个文件。
   `D` 的完整性以 (f) 为前提（无 assume-unchanged / skip-worktree 条目时，`git diff <target>` 对工作区逐路径比对，不会隐藏改动）。
   ⇒ 所有此刻被忽略的内容在 clean 时仍被忽略，原地保留。
6. 调用两次：第一次在分类 / 选定 target 之后、任何保全写入之前（停手时无救援 ref、无 manifest、无事件、目录字节不变）；
   第二次在破坏阶段的第一步、任何嵌套仓挪动与 `reset --hard` 之前（含崩溃重入直接进入破坏阶段的路径）——此时事件已在，停手同 `post_clean_dirty` 的处理口径，但尚无任何破坏性动作，原字节仍在。
7. 命令一律 argv 调用；`-z` 输出按 NUL 切分，不经 shell。

被否：在临时目录按 target 规则重算每个忽略文件是否仍被忽略（更精确但需要构造 target 规则环境，范围与风险都更大）；把忽略内容也纳入快照（会把 `node_modules` 等大体量产物推上远端，且与 FLY-1707 上限冲突）。
代价：reset 会改动任一 `.gitignore`（大小写不敏感）、或 `core.excludesFile` 指向树内时，自动清理一律停手回到今天的 held + 告警——不会比今天更差，且不丢工作。常见的 `dirty`（target == H、没动 `.gitignore`）与只改普通文件的 `head_behind` 不受影响。

### 4.8 证据与替身取回
1. canonical manifest（state root，见 §4.5）+ 清理后镜像到 `<worktree>/.flywheel/runs/takeover/<successorExec>.json|.md`。字段：`eventUid`、`schema: "fly-2901.takeover-rescue.v1"`、`class`、`startPoint`、`headBefore`、`target`、`remoteTip`、
   `rescues[]`（`{kind, localRef, remoteBranch, tip}`，按 kind 排序）、`snapshot: {stagedCommit, worktreeCommit}`、`nestedMoves[]`（源 / 目标 / HEAD / 状态摘要）、`generationCarried`、`fingerprints`、`predecessors`、`at`。
2. 提示词一节「## Worktree takeover rescue」：列出上述内容 + 指令：
   ① 第一次 `flywheel-comm progress` 必须带 `--pointer rescue=<编码>`；编码**始终非空**（R2 #3）：`event:<rescueEventUid>`，有救援 ref 时再追加 ` refs:` + 按 kind 排序、逗号分隔的 `<remoteBranch>@<tip>` 列表；
   ② **同节点替身**（前任是本节点上一 attempt / 被判死的同角色体，FLY-2510 主形状）先恢复再干活，两层分别恢复、空层跳过（R1 #6 采纳）：
      `git diff --binary <H> <stagedCommit> | git apply --index` → `git diff --binary <stagedCommit> <worktreeCommit> | git apply`；嵌套仓按证据路径挪回（`git worktree move` / `mv`）。
      仅当 `target == H` 时给出这组命令；否则只列内容。冲突即停下 `ask` 报 Lead，不许丢弃。
   ③ **跨阶段接管**：只列救援内容，由替身判断是否取回。
   为什么不由 Bridge 启动前自动回放：`assertCleanTree` + `captureBaseline` 是防归因错误的硬门（Lead 手工配方里 pop 也在替身起来之后）；冲突处理不能变成无人值守的静默决策。
3. 账本（R1 #7 采纳）：`packages/config/src/progress-schema.ts` 的 `ProgressPointers` / `parsePointers` 白名单加 `rescue`；
   `packages/flywheel-comm/src/commands/progress.ts` `applyArgs` 白名单同步加 `rescue`；测试走真实 `applyArgs → write → parse`。
4. 告警：`head_diverged` 发 info kind `worktree_takeover_rescued`（按现有四处登记：`LeadAlertNotifier.ts`、`infra-event-router.ts`、`kind-contract.ts`、`alert-kind-copy.ts`）；
   `nested_repo` 成功也发（Lead 条件②b：告警列路径）；其余成功类只记事件。
5. 停手：沿用 `three_stage_takeover_failed`；`failureReason` = `worktree_takeover_failed: rescue refused (<class>/<reason>) …` + 已完成的保全 + **具体不干净路径**（porcelain 前 20 条，超出 `…(+N more)`；仓内相对路径，只作为文本进告警 copy 的既有转义，不拼进 shell / SQL）。

## 5. 稳定标识清单
- 分类：`dirty | nested_repo | head_behind | head_published_diverged | head_diverged | worktree_missing | predecessor_path_missing`
- 停手原因：`kill_switch | repo_lock_unavailable | exclude_unavailable | unregistered_branch_unique_commits | rescue_evidence_unrecorded | permit_denied:<live_writer|zombie_writer|permit_indeterminate> | registration_indeterminate | worktree_head_unreadable | unregistered_present | generation_unrecoverable | git_operation_in_progress | worktree_locked | quarantine_overflow:<detail> | remote_probe_failed | remote_head_unreachable | remote_not_ancestor | rescue_ref_conflict | rescue_push_failed | rescue_push_unverified | worktree_unstable | worktree_changed_during_rescue | rescue_event_capability_missing | rescue_event_unrecorded | rescue_resume_mismatch | nested_move_failed | post_clean_dirty | ignored_content_at_risk`
- 事件 kind：`worktree_takeover_rescued`、`worktree_takeover_cleaned`；告警 kind：`worktree_takeover_rescued`（info）；kill switch 旗标 `worktree_takeover_rescue_disabled`
- 路径：`.flywheel/review-targets/<repo>/`（git 排除）、`<FLYWHEEL_STATE_DIR>/state/takeover-rescue/…`

## 6. FLY-2122 根治细节
- 新 helper `ensureFlywheelExcludes(worktreeOrMain)`（`WorktreeManager` 内，repo 锁内调用）：读全量 `info/exclude` → 按**完整行**判断，缺哪条补哪条（只补 `.flywheel/runs/` 与 `.flywheel/review-targets/` 两条精确行，保留既有第三方行）→ temp+rename → 重读验证两行都在。
  `info/exclude` 在 common dir、所有 worktree 共享；并发由 repo 锁序列化（R2 #5）。
- 时序（R2 #5）：共享接管候选在事务里**先于任何 status / assertCleanTree / 指纹**执行它，失败 → `exclude_unavailable` 停手；`create()` 在 `worktree add` 之后、返回之前执行它。
  这样升级前已经存在于 `.flywheel/review-targets/` 下的嵌套目标会先被排除、不会被误判成 `nested_repo` 挪走。
- 非共享路径保持今天 `Blueprint.ensureFlywheelRunsExclude` 的 warn-and-continue 语义不变（它仍在 L1702 调用，现在是幂等的第二道）。
- `Blueprint.ts:2027` 的 `--target-repo <relative-repo-path>` 提示改为明确「嵌套仓只能建在 `.flywheel/review-targets/<repo>/` 下」。
- 包含校验（`complete.ts` ~930-975、`resolveReviewTarget`）不动；`.flywheel/review-targets/<repo>` 仍严格位于工作树内，校验照常通过（加一条测试证明）。

## 7. Kill switch
按 `doc/engineer/implementation/flag-authoring-runbook.md` 新增 `worktree_takeover_rescue_disabled`（`kill_switch`、`bridge_global`、`opt_in`、默认 `false`、`call_time`）。
为 `true` 时：已登记的脏 / 分叉 / 目录缺失回到今天的 `worktree_takeover_failed`（`failureKind` / held 语义不变）；§1 列出的不可关闭损失防线照常生效（「未登记且在」「未登记且分支有独有提交」拒绝，而不是回到 `rm -rf` / `branch -D`）；**失败文案允许新增脏路径诊断**（R1 #9：合同是控制流与语义兼容，不是字节兼容）。
派发器 head 回退与告警、FLY-2122 exclude 两项不受开关控制（只读 / 不写目录）。

## 8. 回滚边界
- 关开关 = 回到今天行为；已推救援分支、本地救援 ref、救援目录全部保留，不需要清理（只增不删）。
- 单次处置：保全 + 持久事件一定先于任何破坏性动作；破坏前任何失败只停手，不回滚已推救援。
- 救援产物回收不在本单（至少保留到本 issue ship 之后）。现有分支清理只管 `<repoSlug>-…` 形状（`branch-cleanup.ts:84-90`），不会扫到 `flywheel-rescue/`。

## 9. 分块

| # | 块 | 主要文件 | 依赖 |
|---|---|---|---|
| 1 | 抽出 `snapshotWorktreeState()`；FLY-1707 走新函数；`WorktreeManager.resume.test.ts` 原样全绿 | `WorktreeManager.ts` | — |
| 2 | 入口分类（登记×存在）+ 保全阶段（快照、救援 ref）+ 远端探测 + 推送复核 + 指纹 | `WorktreeManager.ts` | 1 |
| 3 | 事务 `runTakeoverTransaction`（锁、manifest、recorder 回调、嵌套仓挪走、原地清理、`worktree_missing` 续用 generation、`create({carryGeneration})`、镜像）+ 崩溃重入 + `ensureFlywheelExcludes` | `WorktreeManager.ts` | 2 |
| 4 | 事件能力：`ExecutionEventEmitter` 可选方法、`DirectEventSink` 实现、StateStore 事件、HTTP 拒绝 | `ExecutionEventEmitter.ts`、`DirectEventSink.ts`、`StateStore.ts`、`event-route.ts` | — |
| 5 | 派发器许可证 + head 回退 + 去重告警 | `workflow-engine-dispatcher.ts`、`plugin.ts`、`run-infra.ts` | — |
| 6 | Blueprint 接线：候选入口、许可证 / 开关、持久化顺序、证据文件、提示词一节、结果映射、FLY-2122 exclude 与提示词 | `Blueprint.ts`、`adapter-types.ts` | 2,3,4,5 |
| 7 | 账本 `rescue` 指针（schema + CLI） | `progress-schema.ts`、`progress.ts` | — |
| 8 | 告警 kind 四处登记 + copy；旗标登记 | 告警四处、`feature-flags/registry.ts` | — |

## 10. 测试（⛔ 本机只跑相关测试；跑前排除 `**/tmux-viewer.macos.test.ts`；跑 teamlead `startBridge` 类用例前先隔离 `FLYWHEEL_CODEX_HOMES_ROOT`）

**真 git 集成测试**（新文件 `WorktreeManager.takeover-rescue.test.ts`；`mkdtemp` 里 `git init --bare -b main` 作 origin + 主仓 + 共享 worktree，沿用 `WorktreeManager.resume.test.ts` 搭法）。
**零丢失断言**：处置前记录 `git diff --cached --binary`、`git diff --binary`、`git ls-files --others --exclude-standard` 及其文件字节 / mode / symlink target、`git rev-list H`；
处置后在临时 worktree 检出远端救援分支，按两层恢复命令复原，三项输出与字节逐一相等，提交集合包含 `rev-list H`；嵌套仓按挪走后的目录比对 HEAD、未推提交、status、文件字节。
（v5.2）原地清理类另记处置前 `git ls-files --others --ignored --exclude-standard` 及其字节，处置后原位置逐一相等（忽略内容原地保留的正面证明）。

| 用例 | 断言 |
|---|---|
| `dirty`（同文件 staged+unstaged、仅未跟踪、删除、改名、mode、symlink、binary） | 成功；干净且 `HEAD==H`；generation 不变；远端 tip == 本地 ref == 证据；零丢失；事件先于清理（事件 seq 早于 `cleaned`） |
| `nested_repo` 阴性 (a)：许可证不过 + 未跟踪嵌套仓 | 失败，原因列出该路径；目录字节不变 |
| `nested_repo` 阳性 (b)：普通嵌套仓 + 嵌套 worktree（各带未推提交与未提交改动） | 挪到救援目录后零损失；嵌套 worktree 的主仓 `worktree list` 指向新位置；告警列路径 |
| `.flywheel/review-targets/<repo>` 下的嵌套仓 | 不判脏、原地保留；`--target-repo` 包含校验通过 |
| 放在两目录之外的未跟踪目录（许可证不过） | 仍判脏失败（exclude 未被放宽） |
| `head_behind` / `head_published_diverged`（FLY-2463：树干净，H==R，S 为旧 base） / `head_diverged` | 目标分别为 S / H / S；需保全的 tip 在对应救援分支；`head_diverged` info 告警一次 |
| `worktree_missing`（已登记、目录删掉、本地分支有未推提交） | 新目录在 target；generation == 旧 marker；多余提交已推救援 |
| `worktree_missing` 且 `L == R` 与旧 `S` 分叉（目录丢失版 FLY-2463） | target == `L`；generation 续用；`S` 在 `-base` 救援；之后替身 push 为快进 |
| 无救援 ref 的成功类：clean `head_behind`、`worktree_missing` 无独有 tip、只有嵌套仓 | manifest 与事件存在；账本指针非空（`event:<uid>`）；最终目录有镜像证据 |
| kill switch 开 + 未登记且在 / 未登记且分支有独有提交 | 均拒绝；孤儿目录字节与独有提交都还在 |
| 升级夹具：旧 worktree 在 `.flywheel/review-targets/<repo>` 下已有嵌套目标、exclude 缺新行 | 先补 exclude，不判脏、不挪；第三方 exclude 行保留 |
| exclude 读 / 写失败注入；两个 worktree 并发 ensure | `exclude_unavailable`；并发后两行各一条、第三方行不丢 |
| 并发：在 recorder 回调与破坏阶段之间排入同主仓 remove/create | 被 repo 锁挡在事务之后；旧 rescue 不会清理新 generation |
| 入口四格：`registration_indeterminate`（注入 `worktree list` 失败）、`worktree_head_unreadable`、`unregistered_present`、未登记且不在（老路 + 本地分支尖保全） | 各得对应结果；前三者目录字节不变、无 prune/create |
| 停手：远端不是目标祖先 / 远端探测失败 / 推送失败（origin 不可写）/ 未合并 index / 进行中 merge / 超上限 / 等待期同尺寸同 mtime 改写（内容指纹）/ 事件写失败 | 目录、index、HEAD 字节不变；对应 reason；已推救援保留 |
| `worktree_missing` 且 `S ⊏ L`、`R = S` 或不存在（target = L 未发布）：在 post-add exclude / hook 配置 / generation 写入处分别注入失败 | `L` 始终由已复核的 `-head` 救援 ref 可达 |
| 嵌套仓相对路径恰为 `manifest.json/`（含大小写变体） | 挪到 `<stamp>/nested/…`，不与 manifest 冲突 |
| manifest 篡改：原文件重入成功；任意改一字节 | 后者在破坏阶段前得 `rescue_resume_mismatch` |
| （v5.2，R6 复现一）`head_behind`：H 忽略 `drafts/`，工作树有未提交的 `drafts/unpublished.md`；S 删除该忽略规则 | 停手 `ignored_content_at_risk`，文案列出 `.gitignore` 与 `drafts/`；无救援 ref / manifest / 事件；HEAD 与文件字节不变 |
| （v5.2，R6 复现二）同上，但 S 开始跟踪 `drafts/unpublished.md`（忽略规则不变） | 停手 `ignored_content_at_risk`，列出该路径；文件字节不变 |
| （v5.2）第二次门：崩溃重入进入破坏阶段前，工作树新出现与 target 冲突的忽略文件 | reset 之前停手 `ignored_content_at_risk`；该文件字节不变 |
| （v5.2，R6-2 #1）`dirty`：target == H，前任在工作区把 `.gitignore` 改成忽略 `drafts/` 并留下未提交的 `drafts/unpublished.md` | 停手 `ignored_content_at_risk`，列出 `.gitignore`；草稿字节不变 |
| （v5.2，R6-2 #1）同上但 `H ⊏ S`、S 只改普通文件、H/S 的 `.gitignore` 相同 | 停手 `ignored_content_at_risk`；草稿字节不变 |
| （v5.2，R6-2 #2）`head_behind`：S 的 `.gitignore` 保留 `/paired/` 但追加 `!/paired/`，`paired/` 下有未提交内容；以及 S 追加 `!/.flywheel/runs/`、`!/.flywheel/review-targets/` 两例 | 三例均停手 `ignored_content_at_risk`；对应内容字节不变 |
| （v5.2）macOS 大小写：S 跟踪 `Drafts/x.md`，工作区有被忽略的 `drafts/x.md`（`core.ignorecase=true`） | 停手 `ignored_content_at_risk`；原字节不变 |
| （v5.2 阴性对照）`dirty`（target == H、未动 `.gitignore`）且有 `node_modules/`、`.flywheel/runs/` 类忽略目录；`head_behind` 且 S 只改普通文件 | 均通过门、正常清理；忽略内容原地逐字节保留 |
| （v5.2，R6-3 #1）`dirty`：H 跟踪普通文件 `drafts`、`.gitignore` 有 `drafts/`；工作区删掉该文件、建同名目录并留下 `drafts/unpublished.md` | 停手 `ignored_content_at_risk`（(a)）；草稿字节不变 |
| （v5.2，R6-3 #2）真大小写不敏感文件系统：H 跟踪 `.GITIGNORE`（内容 `drafts/`），S 清空其规则 | 停手（(d)）；草稿字节不变 |
| （v5.2，R6-3 #3）`core.excludesFile` 指向树内被跟踪的 `project.ignore`，S 删掉其中规则 | 停手（(e)）；草稿字节不变 |
| （v5.2）`.gitignore` 带 assume-unchanged / skip-worktree 标记且工作区改过；全局忽略文件（显式 `core.excludesFile` 或默认 XDG 路径）位于树内 | 均停手（(f) / (e)）；忽略内容字节不变 |
| （v5.2，R6-5）`core.excludesFile` 指向树内被跟踪的 symlink `global-ignore` → 树外文件（内容 `drafts/`），S 把它换成空普通文件；以及树外路径经树内 symlink 中转再出树的链 | 两例均停手（(e)）；草稿字节不变（先写用例见红，再实现见绿） |
| 崩溃注入：manifest 前 / 事件前 / 事件后 reset 前 / reset 后 cleaned 前 / prune 后 create 前 / create 后 marker 前 / 多个嵌套仓只挪了一部分 / cleaned 回执写失败 | 重跑按 §4.5 收敛或停手 `rescue_resume_mismatch`，均无丢失；绝不落入老路新发 generation；不覆盖已有救援目录。其中「事件后 / prune 后 / cleaned 写失败」三种重启用**真实 StateStore + DirectEventSink** 重建一次 Blueprint / 事务实例来跑，不用内存假 recorder |
| FLY-1707 回归 | `WorktreeManager.resume.test.ts` 原样全绿 |

**单元 / 流程测试**
- 许可证：五行真值表 + `failed+unknown` 拒 + 同路径无 binding 的 running session 拒 + session/binding 路径冲突拒；额度墙死体夹具（目标缺失 + 宿主缺席）判 `dead` 放行。
- `Blueprint.fly887-worktree-takeover.test.ts`：拆「首阶段未登记 → 新建」与「共享接管未登记」两种合同；rescue 成功继续启动、提示词一节、证据在 `.flywheel/runs/` 且 `assertCleanTree` 通过；开关开 → 控制流同今天；emitter 无能力 → `rescue_event_capability_missing`。
- 派发器：head 回退三级；全部失败只告警一次。
- `event-route`：HTTP 投递两个新事件 kind → 400。
- 账本：`applyArgs(--pointer rescue=…) → write → parse` round-trip（多值编码）；未知指针仍被丢弃。
- 不撞 head：真 StateStore 夹具中替身 binding 指向清理后的目录，`complete` 侧与 `resolveWorkflowHeadAuthority` 读到 `HEAD == target`；`head_diverged` 下旧 `H` 的 frozen review 按现有规则得 `head_moved`。

**守卫清册**：新测试会 `execFileSync("git")`；实现时核对 child-process census / shell 枚举守卫是否需要登记，本地跑对应守卫用例。

## 11. 验收映射

| issue 验收 | 本计划 |
|---|---|
| 每类失败构造一次，自动重建成功、零丢失（前后提交与 stash 对比） | §10 真 git 表；「stash」由不可变救援 ref + 远端救援分支承担，按 index / 工作区 / 未跟踪三层逐字节比对 |
| 会丢工作的场景拒绝并告警 | §2 / §2.3 停手列 + §4.7a 忽略内容保全门 + §4.8-5；停手用例断言目录字节不变 |
| 保全证据写进进度账本给替身读 | §4.8：证据文件 + 提示词 + 替身首写 `rescue` 指针（CLI + schema 都支持） |
| 重建后替身能继续 complete / 复审，不撞 head | §4.7 + §10「不撞 head」 |
| FLY-2122 阴性对照（Lead 新口径 a/b）+ 根治 | §1-5、§6、§10 对应三行 |
| 真 Codex 替身演练 | 不在本单；Codex 服务恢复后由 QA 另起 |
