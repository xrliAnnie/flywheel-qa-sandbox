# Design Review — plan.md (Round 2)
Date: 2026-09-25 / Author: Codex / Status: CHANGES REQUESTED

## Summary

v2 已实质解决 R1 的许可证、远端权威、事件先行、双层恢复、账本 CLI、内容指纹和 kill-switch 文案合同问题；FLY-2122 的新 a/b 口径按 Engineering Lead 裁决作为既定合同，本轮没有重新讨论该决策。嵌套仓在持久事件之后用 `rename` / `git worktree move` 搬运、搬后复核、永不自动回收的主机制，在该合同下方向成立。

仍有 5 个 blocking：开关会重新启用已知丢数据的 orphan/branch 删除老路；两个 WorktreeManager 阶段之间没有可实现的连续 repo-lock/重验证合同；缺目录与“无远端 ref 的 rescue”没有通用证据地址；`worktree_missing` 的 target 没有定义；FLY-2122 exclude 在现有调用点晚于 takeover 分类且失败会被吞掉。它们分别会造成真实工作丢失、违反 Lead 硬约束，或让计划中的步骤无法实现。

评审基于提交 `08ab20453b1e5be1ef7b654573ee30c25e126a66`，只读核对 v2 与当前源码；未运行测试，未修改仓库。

## What's Good (Keep)

- R1 #1 已闭环：failed/terminated/blocked 只有 `dead` 可放行，`unknown` fail closed；前任集合同时看 session path 与 binding path，并对冲突/缺字段拒绝（plan `:72-90`）。这与活性探针“缺失/探针错默认不是死亡证据”的源码合同一致（`packages/teamlead/src/bridge/generalized-launch-recovery.ts:135-164`）。
- FLY-2122 新合同的主要机械边界合理：外层 clean predicate 不变；未获 permit 不移动；获 permit 后事件先行，再移动；linked worktree 用 Git 自己更新 admin metadata；ignored canonical target 原地保留（plan `:24-28`, `:113-118`）。`complete.ts` 与 `resolveReviewTarget` 当前都以 realpath 证明目标严格位于绑定 worktree 下并且恰是 nested repo root（`packages/flywheel-comm/src/commands/complete.ts:928-963`, `packages/teamlead/src/bridge/review-request-coordinator.ts:381-419`），保留这条安全边界是正确的。
- R1 #3 的入口矩阵已大幅修正：registration probe error、registered+unreadable、unregistered+present 都改为拒绝，避免当前 `isRegistered().catch(false)` 静默掉进 destructive else（plan `:38-49`; 当前入口见 `packages/edge-worker/src/Blueprint.ts:1407-1424`）。
- R1 #4 已闭环：`R` 来自本轮 `ls-remote`，按 advertised OID fetch，不再信 stale remote-tracking refs；所有不在 target 的 tip 都推自己的 immutable ref（plan `:63-66`, `:94-111`）。
- R1 #5/#6/#7/#8 的修订均正确：checked event 在破坏前、cleaned receipt 分开；恢复按 staged/worktree 两层；`progress.ts` 与 schema 两边都接线；指纹加入真实 index tree 与内容 hash（plan `:104-107`, `:120-155`）。
- generation carry 的安全边界仍然合适：只允许 admin `gitdir`、branch、marker 完整交叉验证的 registered+absent 路径；不引入改绑 API（plan `:47`, `:138-142`）。

## Issues & Recommendations

1. **[blocking] kill switch 会重新启用已知会丢工作的新建老路，违反 Lead 的绝对零丢失约束。**

   plan `:171-174` 规定开关打开时“包括未登记 → 老路”全部回到今天的控制流。今天的代码在 `isRegistered()==false` 时进入 `removeIfExists()+create()`（`packages/edge-worker/src/Blueprint.ts:1572-1587`）；若目录仍在，`removeIfExists` 会直接 `fs.rm(..., recursive:true)`，随后无条件 prune 并 `branch -D`（`packages/edge-worker/src/WorktreeManager.ts:1483-1495`, `:1498-1537`）。因此开关一开，`unregistered+present` 的任意文件以及 `unregistered+absent` 本地分支上的未推提交又会在没有 named ref、没有事件的情况下被删。这不是“关闭自动修复”，而是恢复已经确认不安全的 destructive fallback。

   **建议：**把入口安全矩阵放到 kill switch 外，作为不可关闭的损失防线。开关只能决定“是否尝试自动 rescue+clean”：关闭自动化时，registered dirty/head drift 走旧 `worktree_takeover_failed`；但 shared `takeoverCandidate` 的 `unregistered+present` 必须始终拒绝，`unregistered+absent` 若本地 branch tip 不在 `startPoint` 中则必须保全成功后才能 `branch -D/-B`，否则拒绝。补一个开关开启的真 Git 用例，证明 orphan bytes 和 unique branch commits 都不会被删除。

2. **[blocking] `rescueForTakeover()` 与 `cleanAfterRescue()` 分成两个 public lock scope，会在事件缝隙留下可丢新工作的 TOCTOU。**

   plan 把保全和破坏拆成两个方法，由 Blueprint 在中间写事件（plan `:15-17`, `:120-129`），同时声称分类/重建由同一 repo lock 保护（`:38-40`, `:138-142`）。但当前 WorktreeManager 只有 private `locked()`，每个 public 方法各自 acquire/release（`packages/edge-worker/src/WorktreeManager.ts:300-336`）；Blueprint 无法在两次调用之外继续持锁。仓库的 repo-lock 合同明确要求 fresh revalidation 与 delete 在同一 critical section，且允许 async-context re-entry（`packages/teamlead/src/bridge/repo-mutation-lock.ts:14-23`, `:47-72`）。按现计划，流程可能在 fingerprint 3/event 后释放锁，lifecycle sweep 或另一 dispatch 随即 remove/create 同一路径，随后 `cleanAfterRescue` 用旧 `RescueRecord` reset/clean 新树；新树里的工作并未进入旧 rescue refs。

   **建议：**任选一种并写成规范接口：

   - 首选：一个外层 `withTakeoverTransaction(mainRepo, async txn => ...)`/单一 WorktreeManager orchestration 持有 repo lock，内部通过 awaited callback 调 Bridge-local event recorder，再执行 clean；现有锁可重入，不会让内部 `create()` 死锁。
   - 若不愿在 5 秒采样和网络 push 期间持锁：`cleanAfterRescue` 重新 acquire 后，必须在第一次 destructive syscall 前重新验证 registration、path、branch、generation、HEAD、完整内容 fingerprint 与 rescue event payload 全部仍等于 `RescueRecord`；不等即 `rescue_resume_mismatch`。

   加一个并发测试：在 event recorder 返回与 clean 调用之间排入同 repo 的 remove/create，断言旧 rescue 绝不能清理新 generation。

3. **[blocking] 通用证据/账本合同覆盖不了目录不存在和 `rescues[]` 为空的合法成功类。**

   硬顺序要求在事件前写 `<worktree>/.flywheel/runs/...`（plan `:120-125`, `:144-146`），但 `registered+absent` 与 `unregistered+absent` 恰好没有 `<worktree>`（`:47-49`）。若先创建该目录来写证据，后续 `git worktree add` 会因 path exists 失败；若重建后才写，又违反“证据+事件先于 prune/create”。另外，需推 tips 只包含“不在 target 中”的集合（`:97`），所以 clean `head_behind`、仅含 nested repo 的 rescue、以及没有 unique local tip 的 missing rebuild 都可能得到 `rescues=[]`。此时 plan `:148` 要求的 `--pointer rescue=<逗号分隔 remoteBranch@tip>` 是空串；现有 schema 的 string parser 会丢弃空值（`packages/config/src/progress-schema.ts:216-230`, `:267-269`），无法 round-trip。

   **建议：**给所有分类一个始终存在的 durable rescue identity，而不是把 remote refs 当唯一地址：先在 state root 以 temp+rename 写 canonical manifest（含 event UID、digest、可选 `rescues[]`、nested move plan、generation），checked event 引用该 manifest digest；目录存在/重建成功后再把它镜像到 `.flywheel/runs/`。账本 `rescue` pointer 应始终写 `event:<uid>` 或 `manifest:<id>`，remote refs 作为 manifest 内容而非 pointer 是否存在的前提。增加三条验收：`worktree_missing` 无 unique tip、clean `head_behind` 无 ref、nested-only rescue 无 ref，三者均有非空 pointer、可查 event，并在最终 worktree 有镜像证据。

4. **[blocking] `worktree_missing` 使用的 `target` 没有定义，且没有对 published remote head 建立与 FLY-2463 相同的权威规则。**

   target 算法只在“已登记且可读”中定义，依赖 `H`（plan `:51-65`）；但 registered+absent 行直接使用未定义的 `target` 来判断本地 branch tip、重建和写事件（`:47`），测试也只说“新目录在 target”而没有给期望值（`:208`）。若实现者直觉取 `S`，反例是 admin branch 的本地 tip `L == R`、且 `L` 与旧 `S` 分叉：流程会把 L 另推 rescue 后把 branch-B 重置到 S，随后 successor 对仍指向 L 的 origin branch 无法正常 push/complete。这就是 FLY-2463 的 published-head 根因，只是目录已丢。

   **建议：**为 missing 类显式定义 `L`（admin symbolic branch 对应的本地 ref tip）并给出候选算法：优先 `L`，条件为 `S ⊑ L` 或 `L == R`，且 `R` 不存在或 `R ⊑ L`；其次 `S`，条件为 `R` 不存在或 `R ⊑ S`；都不满足则 `remote_not_ancestor`。不在 target 中的 `L/S` 按同一 invariant 推 rescue。若 L 缺失，只能选满足远端祖先条件的 S。补 registered+absent 的 `L==R` published divergence 真 Git 用例，断言 target=L、generation carry、后续 push 不产生 non-fast-forward。

5. **[blocking] FLY-2122 exclude 在当前代码中的时序与失败语义都不足以兑现 Lead 的根治合同。**

   plan 要求 `.flywheel/review-targets/` 在 status 中不可见（`:20-28`, `:166-169`），但当前 `ensureFlywheelRunsExclude(cwd)` 在整个 worktree takeover/create 分支之后才调用（`packages/edge-worker/src/Blueprint.ts:1702-1714`），而 takeover 的第一次 clean/status 判断早在 `:1515-1537`。因此升级前已经存在的 canonical review target 会先被误分类成 `nested_repo` 并搬走，根本走不到新 exclude。更糟的是，helper 在 `rev-parse` 失败时自行 warning+return（`:3552-3568`），调用方无法知道没有排除成功；若 `.flywheel/runs/` 也未生效，事件前写好的 evidence 还会被后续 `git clean -fd` 删除。该文件位于 common dir，多 worktree 并发 read-modify-write 也需要序列化；现实现只是 substring check + 覆写（`:3573-3590`）。

   **建议：**registered+present 候选必须在任何 `assertCleanTree/status/fingerprint` 之前，于 repo lock 内原子地“读全量 → 按完整行补两项 → temp+rename → 重读验证”；shared workflow/rescue 路径上任何 read/write/verify 失败都应 `exclude_unavailable` fail closed，不能 warning 后继续。fresh create 则在 `worktree add` 后、全局 `assertCleanTree` 前执行同一 helper。补升级夹具（旧 worktree 已有 canonical nested target 但缺新 exclude）、注入 read/write failure、以及两个 worktree 并发 ensure 且保留既有第三方 exclude 行的测试。

6. **[advisory] `.git` 是文件并不等价于 linked worktree，当前 nested classifier 会把 submodule/separate-git-dir 普通仓误送到 `git worktree move`。**

   plan `:113-117` 以 `.git` 文件区分 linked worktree。Git submodule 与 `git init --separate-git-dir` 也使用 gitfile；对它们调用 common-dir 的 `git worktree move` 会安全失败，但会把本可原子 rename 的场景降成永久人工处理。建议从 common-dir 的 `git worktree list --porcelain` 中证明该 exact toplevel 已登记后才走 `worktree move`；否则按普通仓 rename。比较 `show-toplevel`、source、destination 时都用 realpath，命令一律 argv 调用，提示词中的恢复路径用明确 shell quoting。

7. **[advisory] 崩溃测试还应点名 missing rebuild 与多嵌套仓的部分完成边界。**

   plan `:211` 的“事件后 reset 前”对原地路径足够，但 missing 类的 destructive 边界是 `prune → worktree add → generation marker`，nested 类则可能移动第一个仓后在第二个失败。建议增加：prune 后/create 前、create 后/marker 前、多个 nested repo 只移动一部分、clean 成功但 cleaned receipt 写失败。期望可以是安全拒绝而非自动收敛，但必须证明不会掉进 `unregistered+absent` 老路新发 generation，也不会重复覆盖已有 rescue 目录。

8. **[advisory] 稳定 reason 与 receipt identity 还缺两个落点。**

   证据文件写失败和 exclude 验证失败目前没有对应稳定 reason（plan `:160-163`）；`worktree_takeover_cleaned` 也未规定 deterministic UID。建议增加 `rescue_evidence_unrecorded`、`exclude_unavailable`，并把 cleaned UID 定为例如 `cleaned:<rescueEventUid>`，用 checked append；这样 crash 后补 receipt 是幂等的，告警也不会把 evidence I/O 错误误报为 event failure。

## Verdict

**CHANGES REQUESTED**

请先修完 1–5。其余 R1 阻塞项可视为已关闭，FLY-2122 的 Lead 裁决也已按新合同接受；下一轮无需再重审这些已关闭方向，只需验证上述原子性、通用证据地址、missing target 与 exclude 接线。
