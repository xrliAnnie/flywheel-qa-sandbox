# Design Review — plan.md (Round 1)
Date: 2026-09-25 / Author: Codex / Status: CHANGES REQUESTED

## Summary

方向是对的：复用 FLY-1707 的双层临时-index 快照、先把不可达 tip 推到远端、尽量原地清理并沿用 generation，确实覆盖了 FLY-2510 与 FLY-2463 的主形状。不过当前计划还不能证明 Lead 要求的“零丢失”：许可证把未知活性当成可写，FLY-2122 的既有阴性对照被默认改成成功，未登记/坏目录仍有绕过 generation 续用的入口，远端可达性可能由陈旧 remote-tracking ref 误证，且销毁性动作前没有一条必须成功的持久事件。恢复指令与进度账本接线也各有一个确定性错误。

评审基于提交 `ae5154140791981d5fd2fdda83c78997f36a5f5d`，只读核对了计划、exploration/research、实际调用链和相关合同；未运行测试。

## What's Good (Keep)

- 保留“两层提交但不移动业务分支”的核心机制是正确的。现有实现确实先把真实 index 写成一层 commit，再用临时 index 把工作区写成下一层 commit（`packages/edge-worker/src/WorktreeManager.ts:695-731`, `:732-856`）；抽成共用私有函数并保持 FLY-1707 回归测试不变，是合适的复用边界。
- FLY-2463 的 head 选择修订正确：`H == R` 的已发布分叉应采纳 `H`，不能机械回到旧 `S`。这与现有 takeover 允许 `S ⊑ H` 的规则一致（`packages/edge-worker/src/Blueprint.ts:1528-1536`）。
- 原地 `reset --hard <target>` + `clean -fd`（不带 `-x`）优于删树重建：它保留忽略内容、停驻体 cwd 和 admin-area generation。计划也正确识别了 binding set-once（`packages/teamlead/src/StateStore.ts:30820-30890`）以及 land 的 generation fence（`packages/teamlead/src/bridge/land-intent-targets.ts:464-472`）。
- 用普通远端 rescue branch、`push --atomic`、再 `ls-remote` 精确复核，比共享 stash 或仅本地 ref 更可靠；救援前后不在 branch-B 上增加证据提交，也是正确的 head-authority 边界。
- predecessor head 的三级回退方向合理，并且复用现有三态本地分支探针是对的（`packages/teamlead/src/bridge/run-infra.ts:437-489`）。当前失败确实只在 reconcile 中记日志并持续 held（`packages/teamlead/src/bridge/workflow-engine-dispatcher.ts:423-433`），补去重告警有明确价值。
- 新告警 kind 的四处登记清单与现状一致；现有 kind contract 是穷尽型 `Record`，漏登记会在编译/启动期暴露（`packages/teamlead/src/bridge/kind-contract.ts:59-65`）。现有生命周期清理只管理 `<repoSlug>-...` 形状（`packages/teamlead/src/bridge/branch-cleanup.ts:84-90`），不会误扫 `flywheel-rescue/` 前缀。

## Issues & Recommendations

1. **[blocking] “前任不会再写”许可证会把无法证明死亡的执行体放行，而且只看 binding 会漏掉真实共享路径持有者。**

   计划把 `failed/terminated* + unknown` 判为可接管（`engineering/doc/FLY-2901-worktree-takeover-rebuild/plan.md:69-77`）。但探针自己的合同明确写着：CommDB 缺失与探针错误是 `unknown`，不是 gated shell 已死的证据；默认情况下 target 不见也返回 `unknown`（`packages/teamlead/src/bridge/generalized-launch-recovery.ts:135-164`）。这正好违反“先证明前任不会再写”。另外，计划用 `listRunAttributedExecutions + getWorktreeBinding` 按 binding.path 选前任（plan `:64-67`），但 `getWorktreeBinding` 只有 generation 非空才返回（`packages/teamlead/src/StateStore.ts:30893-30934`）；现有 Blueprint 明确容忍 marker-less takeover，并且 `emitWorktreeReady` 失败会记录 warning 后继续启动（`packages/edge-worker/src/Blueprint.ts:1549-1553`, `:1650-1657`）。因此，拥有相同 `sessions.worktree_path`、却没有 binding 的活体会完全漏出许可证集合。

   **建议：**只有 `dead` 才能放行 failed/terminated；`unknown` 一律映射为 `permit_indeterminate`。对同 run 的每个 execution 同时读取 `sessions.worktree_path` 与 binding.path，使用现成的 missing-leaf canonicalizer（`packages/edge-worker/src/worktree-paths.ts:5-30`）比较；任一来源指向目标路径就纳入，两个来源冲突、读取失败或身份不完整都 fail closed。补三条负测：`failed+unknown`、同路径但无 binding 的 `running` session、session/binding 路径冲突。

2. **[blocking] 默认自动搬走 `nested_repo` 后继续接管，直接违反 FLY-2122 的既有阴性对照。**

   Lead 给出的合同是“共享树出现该未跟踪目录时，takeover 必须仍失败”；它约束的是最终接管结果，不只是 `assertCleanTree` 这一行是否还会先报脏。计划却把“先判脏、再搬走、最后成功”设为默认（plan `:22-24`, `:40`），并把成功搬走写进验收（plan `:173-174`），所以行为上仍然放宽了阴性对照。现有门会对任何未跟踪内容 fail closed（`packages/edge-worker/src/GitResultChecker.ts:64-79`），当前 takeover 也不会在失败后清理再继续（`packages/edge-worker/src/Blueprint.ts:1515-1547`）。

   **建议：**本单把未忽略的 `nested_repo` 固定为 `refused:nested_repo`，告警列出路径；被忽略的 `/paired/` 保持原地不动。删掉 `git worktree move`/普通仓 rename 的自动成功分支及对应成功验收。若 Lead 将来明确改变 FLY-2122 验收，再作为独立范围引入；这也会显著缩小本单最危险、最难回滚的一块代码。

3. **[blocking] takeover 仍以 `isRegistered()` 为入口，导致未登记且目录已消失、登记探针失败、以及“目录存在但 HEAD 不可读”绕过安全状态机。**

   当前 `takeover` 布尔值把 `isRegistered()` 的 false 和异常都压成 false（`packages/edge-worker/src/Blueprint.ts:1407-1424`），随后直接走 `removeIfExists()+create()`（`:1572-1587`）。`removeIfExists` 会删除 orphan、prune admin entry、再 `branch -D`（`packages/edge-worker/src/WorktreeManager.ts:1475-1537`），而 `create` 会新发 UUID generation（`:1297-1313`）。计划只补了“未登记但目录存在”的 `unregistered_orphan`（plan `:44-45`, `:157`），没有拦住“非首阶段、未登记且目录已没”或 registration probe indeterminate；前者会生成新 generation，旧 binding 随后稳定卡在 `worktree_generation_mismatch`。此外，plan 把“目录存在但 `rev-parse HEAD` 失败”与真正目录消失合并成 `worktree_missing` 并继续重建（plan `:44`）；这类目录中的任意文件无法按当前 Git 快照算法证明已经进入远端 named ref，本地挪走后继续成功也不满足计划自己的离机保全承诺。

   **建议：**先根据 `shareParentBranch + phase role + startPoint` 计算 `takeoverCandidate`，再在同一 repo lock 内分类 `{registration: registered|unregistered|indeterminate} × {path: present|absent}`，不要让 registration false 决定回落老路。最小自动化边界应为：

   - `registered + absent` 且 admin `gitdir`、branch、generation 都能反查并吻合：允许 carry-generation 重建；
   - `unregistered + present` 或 `present + HEAD unreadable`：可以原样挪到 quarantine 并写事件，但本轮必须拒绝/交人处理，不能宣称已远端保全后继续 create；
   - 非首阶段的 `unregistered + absent`：`generation_unrecoverable`；
   - registration/list 探针异常：新增 `registration_indeterminate`，不做 prune/create。

   测试必须覆盖这四格，以及 `isRegistered` 抛错；现有 “not registered → legacy create” 用例（`packages/edge-worker/src/__tests__/Blueprint.fly887-worktree-takeover.test.ts:252-265`）需要拆成首阶段与共享接管两种合同。

4. **[blocking] 远端可达性证明既不能正确处理“远端分支不存在”，也可能被陈旧 remote-tracking ref 误证。**

   plan 要求 `git fetch --no-tags origin <branch>` 成功，同时又允许 `R` 不存在（plan `:48-56`）；普通 fetch 一个不存在的 branch 会失败，二者互相矛盾。更严重的是，随后用 `git branch -r --contains` 证明“任意远端 ref 已包含 tip”（plan `:58-60`），但只 fetch 一个 branch 不会刷新/删除其他 `refs/remotes/origin/*`，已在服务端删除的陈旧 ref 仍可能让代码跳过 rescue push。这样“远端已有副本”的零丢失断言是假的。仓内已有更稳的模式：先 `ls-remote --heads` 区分 absent 与 probe failure，再按 advertised OID fetch（`packages/edge-worker/src/WorktreeManager.ts:476-537`）。

   **建议：**最小方案是不再用“其他任意远端 ref 可达”作为免推条件：只要 `H/T/S` 不在 target 中，就推自己的 immutable rescue ref；重复保存一点对象远小于错误跳过保全的风险。`R` 单独用 `ls-remote --heads origin refs/heads/<branch>` 获取，存在时 fetch 精确 OID，不存在是合法状态，网络/凭据错误才是 `fetch_failed`。若坚持复用任意远端 ref，就必须以本次 `ls-remote --heads` 的服务端集合为准并逐个验证 advertised OID，不能信任本地 `branch -r`。

5. **[blocking] 计划没有保证“远端 named ref + 持久事件”在任何破坏性动作之前完成，崩溃窗口会留下已被清理但无人知道如何恢复的树。**

   plan 只明确 ref/push 在 `reset/clean/move/prune` 之前（plan `:146-149`），事件则笼统列在证据章节（`:115-130`），没有时序和失败语义。若 push 已验证后执行 reset，进程在事件/证据写入前崩溃，下一轮看到的是干净树，替身拿不到 rescue 提示；这违反 Lead 的硬约束。代码层面，Blueprint 目前只依赖通用 `ExecutionEventEmitter`，其中没有 rescue 方法（`packages/edge-worker/src/ExecutionEventEmitter.ts:109-149`）；而现有 `emitWorktreeReady` 的异常会被吞掉继续（`packages/edge-worker/src/Blueprint.ts:1650-1657`），不能照搬到这里。

   **建议：**把顺序写成硬合同：`push --atomic` → 每个 ref `ls-remote` 验证 → fingerprint 3 → 以 temp+rename 写完整 evidence → `appendWorkflowRunEventChecked` 成功 → 才允许 reset/clean/move/prune。使用确定性、包含所有 tip 的 event UID/payload；仓内已有 content-addressed replay API（`packages/teamlead/src/StateStore.ts:68819-68884`）。事件写失败必须拒绝，不能 log-and-continue。清理成功后再追加独立的 completed/cleaned receipt；“已保全”事件不能被事后改写。计划还应补 `ExecutionEventEmitter.ts`/Bridge-local capability 接线：HTTP emitter 不具备该 authority，HTTP route 继续拒绝。增加三个崩溃注入测试：事件前、事件后 reset 前、reset 后 final receipt 前，并验证重跑可由已存事件/证据收敛。

6. **[blocking] 提示词中的单条 `git diff H T | git apply --index` 无法还原原始 index/worktree 分层，计划中的测试断言不可能成立。**

   快照链明确是 `H → stagedCommit → worktreeCommit`（plan `:81-84`；实现见 `WorktreeManager.ts:695-856`）。但恢复命令把 `H→T` 的全部差异一次性 `--index`（plan `:121-123`），会把原本未暂存和未跟踪的内容全部 staged。它能还原最终文件字节，却不能还原原始 index；与 plan `:178` 的“工作区 + index 逐字节一致”矛盾。

   **建议：**提示词按两层恢复，并对空层跳过：先 `git diff --binary H stagedCommit | git apply --index`，再 `git diff --binary stagedCommit worktreeCommit | git apply`（第二条不带 `--index`）。真 Git 测试除文件 bytes/mode 外，必须分别比较处置前后的 `git diff --cached --binary`、`git diff --binary` 和 `git ls-files --others --exclude-standard`，覆盖 staged+unstaged 同文件、仅未跟踪文件、删除、mode、symlink、binary。

7. **[blocking] `rescue` pointer 只改 config schema 不会从 CLI 落账，而且单值证据模型装不下 plan 允许的多个 rescue ref。**

   计划只列 `progress-schema.ts`（plan `:127-128`, `:161`, `:189`）。实际 `flywheel-comm progress` 在 `applyArgs` 里另有独立白名单，当前只接受 `plan|exploration|research|pr|reviewedSha`，未知 key 被静默丢弃（`packages/flywheel-comm/src/commands/progress.ts:237-259`）。所以提示词要求的首条 `--pointer rescue=...` 会成功退出却不写入。另一个不一致是：零丢失算法允许一次推 `head/dirty/base` 多个 ref（plan `:58-60`），但 evidence 是单个 `rescue` 对象，账本也是单个 `<branch>@<tip>`（plan `:116-123`）；例如已发布分叉同时有 dirty tip 和不可达 base 时会有两条。

   **建议：**把 `packages/flywheel-comm/src/commands/progress.ts` 及其 CLI 测试纳入块 7，白名单显式加入 `rescue`。证据/event/prompt 使用有序 `rescues[]`；为 ledger 的单 string 定义稳定的多值编码（例如按 kind 排序的逗号分隔 `branch@sha` 列表）并 round-trip 测试。测试必须走真实 `applyArgs → write → parse` 路径，而不只是直接测 `parsePointers`。

8. **[advisory] 指纹只用 status 摘要与 `size:mtimeNs`，仍可能漏掉同尺寸、保留时间戳的内容改写。**

   plan `:91-94` 把双采样当作僵尸写者兜底，但 `status` 不包含文件内容；复制工具可以保留 mtime，同尺寸覆盖也不会改变 porcelain 形状。既然快照上限已经是 64 MiB，建议对所有非删除变更路径计算 bytes（symlink 用 link target）的 sha256，并纳入 index tree/OID；删除使用显式 sentinel。这样 fingerprint 3 才能证明它实际推送的内容仍等于当前待清理内容。

9. **[advisory] kill switch 的“字节级兼容”与同一分支新增路径诊断互相矛盾。**

   plan `:133` 要给旧 fail-closed 分支增加 dirty path 列表，`:142-144` 与测试 `:185-186` 又要求旧行为字节级兼容。两者不能同时成立。建议把合同改为“控制流、failureKind、held 语义兼容，文案允许新增诊断”，或在 kill switch 分支保持原 error string 完全不变、只在结构化告警附加路径；测试按选定合同断言，不要写无法满足的 byte-compat。

## Verdict

**CHANGES REQUESTED**

在实施前至少修完 1–7。最小可交付范围建议收窄为：`dirty/head_behind/head_(published_)diverged` 的远端快照与原地清理 + truly-missing/registered 且 generation 可验证的重建 + predecessor head 回退；`nested_repo`、坏但仍存在的目录和无法证明 registration/generation 的 orphan 全部 fail closed。这样能先解决普查中的主流 34/45 脏树与 FLY-2463，同时不突破 FLY-2122 和零丢失边界。
