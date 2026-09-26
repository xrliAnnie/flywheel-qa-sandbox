# Design Review — plan.md (Round 3)
Date: 2026-09-25 / Author: Codex / Status: CHANGES REQUESTED

## Summary

v3 已实质关闭 R2 #1–#5 的主设计缺口：不可关闭的损失防线位于 kill switch 外；takeover 全序列由同一个可重入 repo lock 覆盖；所有分类都有 state-root manifest 与非空 event pointer；`worktree_missing` 有明确的 `L/R/S` 权威规则；两条精确 exclude 在首次 status 前以原子 RMW 写入。R2 的三个 advisory（linked-worktree 证明、扩充崩溃点、稳定 reason/cleaned UID）也都进入了规范与测试表。

本轮没有重新审议 FLY-2122 的 Lead 裁决。仍有 2 个 blocking，均是 v3 新机制与现有代码相接时的闭环问题：其一，missing 重建若把未发布的 `L` 选为 target，现行 `create()` 的 post-add 失败回滚会删除这个唯一 branch ref，而计划因为 `L ⊑ target` 不会为它建 rescue ref；其二，计划要求下一次派发读取未 cleaned 的 rescue event，但新增 capability 只有写方法，manifest/event 也没有保存完成路径匹配与 generation 复核所需的全部身份，因此崩溃重入按当前接口无法实现。

评审基于提交 `39f106a108fb8e44f9f1b8a6018766c0b78b1c8e`，仅核对 v2→v3 delta 及相邻源码合同；未运行测试，未修改仓库文件。

## What's Good (Keep)

- R2 #1 已关闭。入口矩阵明确把 `registration_indeterminate`、`worktree_head_unreadable`、`unregistered_present` 和 unique local branch 拒绝放到开关外；开关只关闭自动 rescue/clean（plan `:30-31`, `:47-57`, `:193-196`）。这避免重新落入当前 `removeIfExists()` 的 orphan `rm -rf` 与无条件 `branch -D`（`packages/edge-worker/src/WorktreeManager.ts:1483-1495`, `:1519-1537`）。
- R2 #2 的单锁结构成立。v3 把分类、manifest/event、破坏阶段及 cleaned receipt 放进一个 `runTakeoverTransaction()`（plan `:100-103`, `:132-149`）；现有锁以 `AsyncLocalStorage` 支持同 key 重入（`packages/teamlead/src/bridge/repo-mutation-lock.ts:47-72`），生产 `WorktreeManager` 也确由 composition root 的同一 `repoMutationLock.withRepoLock` 注入（`packages/teamlead/src/bridge/run-infra.ts:1360-1364`, `packages/teamlead/src/bridge/plugin.ts:8293-8315`）。`repo_lock_unavailable` 的 fail-closed 约束保留。
- R2 #3 的通用证据地址已建立：manifest 在目录缺失和 `rescues[]` 为空时也先持久化，event 带 digest，最终 worktree 再收镜像；账本始终至少写 `event:<uid>`（plan `:132-166`）。这消除了 v2 对不存在 worktree 写证据及空 pointer 的矛盾。
- R2 #4 的 head 权威规则已关闭：missing 类显式定义 `L`，覆盖 `L == R` published divergence，并为不在 target 内的 `L/S` 建 rescue（plan `:66-70`, `:230-231`）。该规则不会把已发布的新头错误重置回旧 `S`。
- R2 #5 与 advisory #6/#8 已关闭：exclude 在首次 status 前、repo lock 内做完整行 atomic RMW 并重读验证（plan `:184-191`）；linked worktree 必须由 common-dir 的 exact porcelain entry 证明（`:124-129`）；新增 reason 和 deterministic `cleaned:<rescueUid>` 均已登记（`:140`, `:178-181`）。

## Issues & Recommendations

1. **[blocking] `worktree_missing` 把未发布的 `L` 选为 target 时，`create()` 的既有失败回滚仍可删除它的唯一 named ref。**

   v3 的 missing 规则在 `S ⊑ L` 且 `R` 不存在或只是 `L` 的祖先时选择 `target=L`，但只为“不在 target 里的 `L/S`”推 rescue（plan `:66-70`, `:105-113`）。因此，一个合法形状是：目录已丢、`L` 含前任未推提交、`S ⊏ L`、`R=S` 或不存在；此时 `L` 就是 target，没有本地/远端 rescue ref。

   现有 `create()` 在 `git worktree add -B` 成功后还会配置 hooks 并写 generation（`packages/edge-worker/src/WorktreeManager.ts:1234-1313`）；任何 post-add 失败都会调用 `removeIfExistsUnlocked()` 回滚（`:1314-1327`），而该回滚在 prune 后无条件 `git branch -D <branch>`（`:1498-1537`）。v3 又要求 `create()` 在 add 后执行可能失败的 `ensureFlywheelExcludes`（plan `:184-188`），所以这个窗口不只是理论上的。回滚后 event 虽记录了 target SHA，但 `L` 只剩 dangling object，不再位于 Lead 要求的 named recoverable ref，后续 GC 可真正删除前任提交。

   **建议：**在任何可能重建/重置 branch 的 missing 流程中，把“target 可达”升级为破坏前不变式：若 target 不等于本轮 `ls-remote` 验证的远端 branch tip，则即使 `L == target`，也先把 `L` 推到不可变 `-head` rescue ref 并复核；或者为 `create({carryGeneration})` 定义专用 rollback，保证失败时原子恢复 target local ref，但远端 rescue 更符合本计划的零丢失模型。增加真 Git 用例：`S ⊏ L`、`R=S/不存在`、target=L，分别在 post-add exclude、hook config、generation write 注入失败，断言 `L` 仍由已验证的 named ref 可达。

2. **[blocking] “发现未 cleaned event 并重入”没有读取 capability，且 manifest 缺少执行该判断所需的身份字段。**

   v3 的事务 recorder 只定义 `recordRescue()` / `recordCleaned()` 两个写回调（plan `:100-103`），`ExecutionEventEmitter` 的计划扩展也只有两个 record 方法（`:143-146`）；但紧接着要求“下一次派发”在入口矩阵之前发现同一路径的 rescued-without-cleaned event，并据此恢复或禁止 legacy create（`:147-149`）。当前 Blueprint 只持有 write-oriented `ExecutionEventEmitter`（`packages/edge-worker/src/Blueprint.ts:874-889`）；真正能读事件的 `StateStore.listWorkflowRunEvents()` 只存在 TeamLead/DirectEventSink 一侧（`packages/teamlead/src/StateStore.ts:68940-68954`）。按 §9 的接线清单，没有任何方法把 pending event 读回 Blueprint/WorktreeManager。

   身份数据也未闭合：event payload 只保证带 manifest sha256（plan `:136-137`），manifest 字段清单没有 canonical worktree path、branch、准确的 `generationBefore` 或 manifest locator/stamp（`:162-164`），但重入规则要求判断“同一路径”并比较 event 中记录的 generation（`:147-149`）。因此 event→prune/create 中途崩溃后，代码既无法在登记矩阵前证明 pending rescue 属于该路径，也没有值可完成 generation 比较；“绝不落入老路”的要求目前不可实现。

   **建议：**把 Bridge-local recorder 扩成双向 capability，例如 `loadPendingTakeoverRescue({runId, successorExec, canonicalPath})`，由 `DirectEventSink` 用现有 `listWorkflowRunEvents()` 配对 rescue/cleaned UID，并在入口矩阵与 kill-switch fallback 之前、仍在 repo lock 内调用。event/manifest 至少持久化 canonical path、branch、`generationBefore`、manifest path（或 stamp）、target 与 fingerprint 3；读取时必须以 event digest 重算并验证 manifest 后才能进入破坏阶段。HTTP/NoOp emitter 没有读取能力时继续 fail closed。测试应使用真实 StateStore + DirectEventSink 重建一次 Blueprint/transaction 实例，覆盖 event 后、prune 后与 cleaned 写失败三种重启，而不只用内存 fake recorder。

3. **[advisory] canonical manifest 与 nested repo 共用 `<stamp>/` 命名空间，会制造确定性的目标冲突。**

   nested 目标是 `<stamp>/<relpath>`（plan `:127`），manifest 同时固定为 `<stamp>/manifest.json`（`:136`）。若合法嵌套仓的仓内相对目录恰为 `manifest.json/`（macOS 大小写不敏感卷上还包括大小写变体），event 写完后 move 必然命中“目标已存在”并拒绝。它不会丢数据，但会让本可自动处理的 FLY-2122 positive case永久失败。建议把仓目录固定隔离到 `<stamp>/nested/<relpath>`，manifest/receipt 留在 stamp 根，并增加 collision fixture。

4. **[advisory] “通用前置失败不做任何写入”与 exclude-first 根治合同文字冲突。**

   §2.3 仍写任一 permit/kill-switch 等前置不满足便“不做任何写入”（plan `:72-75`），但硬顺序要求先写 exclude（`:132-137`），§7 也明确 exclude 不受开关控制（`:193-196`）。实现方向以后两处为准是合理的；建议把 §2.3 改成“不做 worktree/ref/admin/event 的 rescue/破坏性写入；允许 §6 的幂等 exclude 根治写入”，避免实现者为了满足其中一处而破坏另一处。

## Verdict

**CHANGES REQUESTED**

请修复 1–2 后再进入实现。R2 #1–#6 与 #8 可视为关闭；#7 的测试点已补齐，但 pending-event 读取与重入身份仍需完成上述最后一段接线。下一轮只需验证这两个 blocker 及其直接修订，不必重审 Lead 已裁定的 nested_repo 合同。
