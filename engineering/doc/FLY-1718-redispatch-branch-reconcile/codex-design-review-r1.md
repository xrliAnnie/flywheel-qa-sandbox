# Design Review — FLY-1718 plan.md (Round 1)
Date: 2026-08-12
Author: Codex
Status: CHANGES REQUESTED

## Summary

方向正确、也能在现有架构内实现，但本轮不能批准。P1、P2、P3、P4 的边界大体合理；当前有三项会直接破坏设计目标的阻塞问题：P1 只拿到远端 SHA、却没有保证该对象已进入本地对象库；P1 把 `shareParentBranch` 错当成普通“续接”开关；P4 没有把退避计数绑定到唯一前驱 execution，可能把同一次死亡重复计数直到 `needs_lead`。P2/P3 另有部署闭包和快照绑定缺口。

对四个指定问题的结论：

- **Q1：是。** `indeterminate` 应拒绝派发。warn+fresh 会精确重现本事故的分叉/覆盖风险。应把它映射为可重试、可观测的结构化拒绝，并验证没有残留 lifecycle claim、CommDB 注册或 worktree。
- **Q2：是。** 保持 `getResumableSessionForIssueRole()` 排除 `completed` 是正确的。resume 表示恢复执行游标；branch continuity 表示保护 Git 成果，两者不应混为一套状态语义。
- **Q3：否。** 当前计划设置 `ctx.shareParentBranch=true` 并不安全；它可以改变 worktree key、触发 takeover、切换三阶段 prompt/keep-alive 语义，而且 pre-launch TURN 仍按 `req.shareParentBranch` 判断，形成前后不一致。
- **Q4：有条件地是。** 外置、单份、worktree-local 配置的 hook 位置优于每个 worktree 复制；但必须补齐可发布资产、安装所有权、绝对路径、原子部署和低层调用方兼容性。

## What's Good (Keep)

- P1 使用 `exists / missing / indeterminate` 三态，并对不确定结果 fail closed，与 `run-dispatcher.ts:831-868` 的 phase-retry 先例一致；远端 branch 是硬信号、open PR 只是增强信息，这个权威分层正确。
- 显式 caller `startPoint`、QA、真实 resume 优先于 continuity preflight 的优先级合理；保留独立 kill switch 也便于止血和回滚。
- 不修改 `StateStore.ts:6189-6208` 的 completed-session 排除是对的；避免让已完成 session 的 ledger/stage 状态被误当作可恢复执行。
- P2 用 `extensions.worktreeConfig` + `core.hooksPath` 只约束 runner worktree，且 `--force-with-lease` 仍按非快进拒绝，符合事故防护目标。
- P4 只将 `<60s` 的 `failed` 视为 DOA，并将人为 `terminated/blocked` 排除；账本读失败时 fail open + loud warning 也符合“可用性断路器、非安全边界”的定位。
- 四包在产品语义上可以独立交付，P1 确实应最先 ship；P4 拆成独立 PR 更利于审清状态机和并发语义。

## Issues & Recommendations

1. **[BLOCKER] P1 的远端 tip 没有被可靠 materialize，本地 `worktree add` 和 resume fallback 都可能失败。**

   **为什么重要：** `ls-remote` 只返回 ref/SHA，不下载对象；`WorktreeManager.create()` 最终执行 `git worktree add ... <startPoint>^{commit}`（`WorktreeManager.ts:228-239`）。我用 bare origin 沙箱验证：clone 仅有 main 时，`ls-remote` 能看到 feature SHA，但 `git cat-file -e <sha>^{commit}` 和 `worktree add` 都无法使用它。计划中的 `git fetch origin <branch>` 也只更新 `FETCH_HEAD`，不保证 `refs/remotes/origin/<branch>` 存在，因此 `run-infra.ts:1106-1120` 随后的 remote-tracking ref 读取仍可能 miss；`discoverDocDir` 也未覆盖 fallback。

   **建议修复：** 把 probe + fetch 做成一个一致的 preflight：精确解析 `refs/heads/<branch>`；在同一 repo mutation lock 下执行显式 refspec `git fetch origin refs/heads/<branch>:refs/remotes/origin/<branch>`；验证 fetched ref 和 commit object；若 probe/fetch 之间 ref 移动、删除、超时或对象不可解析，限定重试后返回 `indeterminate`。`ctx.startPoint` 必须使用已验证的本地 SHA。resume 侧先做一次同样的 targeted fetch，再让 `branchTip`、`readBranchFile`、`discoverDocDir` 共用该 ref。补上“仅远端有分支且本地无对象”的真 Git 测试。

2. **[BLOCKER] continuity 不能设置 `shareParentBranch=true`；该字段是三阶段协议，不是通用续接标志。**

   **为什么重要：** `BlueprintContext.shareParentBranch` 被明确标成 PhaseOrchestrator 内部三阶段标志（`Blueprint.ts:455-460`）。它会改变 worktree key（`:1264-1270`）；对 design/implement/qa 且已有注册 worktree 时会进入 takeover，并可能报 `worktree_takeover_failed`（`:1280-1334`）；它还会启用三阶段 prompt 和 keep-alive（`:1574-1613`）。更危险的是 pre-launch TURN 按 `req.shareParentBranch` 判断（`run-dispatcher.ts:1508-1535`），而计划在 resume 之后才改 `ctx.shareParentBranch`，因此 runner 可获得三阶段 prompt 却没有 TURN。main role 恰好通常不触发这些分支，不能证明所有 role 安全。

   **建议修复：** continuity 只设置经过验证的 `startPoint` 和新的解释性 `continuityInherit`；原样保留 `req.shareParentBranch`。远端 branch 名必须由 `resolveWorktreeKey(issueIdentifier, { sessionRole, shareParentBranch: req.shareParentBranch })` 与 `expectedWorktree()` 这一现有权威链计算，不能在新模块重写规则。增加此前非 shared 的 design/implement/qa 重派测试：worktree key 不变、不进入 takeover、不生成三阶段 prompt、也不申请 TURN；真实三阶段 caller 原行为不变。

3. **[BLOCKER] P4 会重复计算同一个失败前驱，且第 5 代后没有可执行的 Lead 恢复协议。**

   **为什么重要：** 只有“连续 DOA 代数 + next_eligible_at”时，同一个 terminal predecessor 在 1 分钟到期后仍是“最近 failed 前任”；下一次 start 会再次把它计为第 2 代。重复调用甚至可在没有新 runner 死亡的情况下耗尽到 `needs_lead`。并发 start 还会竞态递增。计划写“需 Lead 显式重派”，但所有入口都经过同一 start seam，未定义谁、用什么带审计的 authority 可以清除/越过终态。FLY-1648 的 `workflow_rework_delivery` 是 request-specific、带外键的表（`StateStore.ts:1894-1909`），不能直接复用为 `(project, issue, role)` 账本；可复用的是 CAS、事务和 durable alert-outbox 模式（`:20996-21107`）。

   **建议修复：** 本轮先选定 StateStore 新表，不把 JSON/SQLite 决策留给 implement。至少持久化 canonical issue identity、role、`last_counted_predecessor_execution_id`、count、state、next eligible、revision/timestamps。事务状态机必须保证：新失败前驱只计一次；同一前驱在 deadline 前只拒绝而不加代；deadline 后恰好放行一次；只有该 successor 成为新的短命 failed 后才进入下一代；健康 successor 原子清零。第 5 代用同一事务写 `needs_lead` 和幂等 alert receipt，并定义仅可信 Lead 边界可提交的 audited reset/override。增加到期后放行、同前驱重复调用、并发调用、新 successor 再死、重启恢复、Lead reset 的测试。

4. **[HIGH] P3 目前只验证“路径仍存在”，没有形成所称的 snapshot binding；两处接线假设也与源码不符。**

   **为什么重要：** `codex-instruction.ts:42-56` 的 `<MISSING ...>` 是一个会被拼进 `/codex-design-review` 命令和 `reviewedTarget` 的占位符，不是 `event-route.ts:411-442` 已有的安全降级指令；直接复用会产生错误命令。FLY-827 AutoQaCoordinator 的 re-queue 固定构建 **code** review（`codex-instruction.ts:91-146`），与 design plan path 无关。更根本地，gate 只验 `HEAD:<path>` 存在时，同一路径内容在审批后被替换仍会通过；这不对称于 code gate 的 `reviewedHeadSha === HEAD`（`packages/flywheel-comm/src/commands/await-codex-gate.ts:175-196`）。

   **建议修复：** 将 `event-route` 现有 missing-plan 文案提取为共享 builder，孤儿路径调用该 builder；从 P3 删除 AutoQaCoordinator design re-queue 接线。设计结果增加 `reviewedPlanBlobSha`（或等价的 reviewed head + path binding），gate 比较 `git rev-parse HEAD:<reviewedTarget>` 的 blob SHA，而不只是 `cat-file -e`。明确 plan 必须先 commit 再 stage；dirty/uncommitted plan 应得到可操作的 fail-closed 指令。测试至少覆盖同路径换内容、路径删除、git 不可用、未提交 plan、kill switch。

5. **[HIGH] P2 的外置目录选择合理，但 Bridge-boot 安装与 `WorktreeManager.create()` 默认强制之间存在发布和调用方断层。**

   **为什么重要：** repo-root 的 `scripts/push-guard/pre-push` 不在 teamlead package 的发布闭包（`packages/teamlead/package.json:39-42` 只含 `dist`/`bin`），也不在 edge-worker package 的 `files`（`packages/edge-worker/package.json:8-14`）。同时 `WorktreeManager` 是低层共享组件；例如 Voice Bridge 直接 `new WorktreeManager().create()`（`packages/voice-bridge/src/cli.ts:530-536`），并不经过 TeamLead Bridge boot。默认 ON 后它会因 hooksDir 不存在而意外停止创建 worktree。若 `worktree add` 成功后 config 失败，当前 create 也没有计划清理半成品。

   **建议修复：** 保留 `~/.flywheel/state/push-guard/hooks` 的单份部署模型，但用 `homedir()` 解析并写入绝对路径。二选一并明确所有权：(a) 将 hook 作为 edge-worker 的已发布资产，由 WorktreeManager 原子安装/校验；或 (b) 给 create 注入显式 push-guard policy/path，并更新每个受管 caller，未选择该策略的调用方保持 byte-compatible。安装应使用临时文件 + rename、校验 regular non-symlink/owner/可执行位/hash；config 失败要回滚刚建 worktree/branch。补 package tarball/production-layout 测试及 Voice Bridge 回归。

6. **[MEDIUM] P2 的审计契约和绕过边界需要与测试一致。**

   **为什么重要：** 计划说“拒绝时”才 append audit，但 T5 要求 ACK 放行也有 `acked` 记录；两者冲突。若 ACK 放行而 audit 写失败，“事后必可追认”也不成立。此外 Git 原生 `git push --no-verify` 可完全绕过 pre-push，当前诚实边界只提到 runner 可自设 ACK，没有写这个更直接的绕过。

   **建议修复：** 对每次非快进尝试都记一条结果为 `rejected` 或 `acked` 的记录；ACK 路径在 audit 无法持久化时 fail closed。文档明确 ACK 应是单命令环境变量，并明确 `--no-verify`/修改 worktree config 都能绕过，因此它是防事故护栏而非 authority/security boundary；runner 合同同时禁止这些绕过。为 audit 失败、`--no-verify` 诚实边界和并发追加补测试/文档断言。

7. **[MEDIUM] bypass 权威、错误语义和四包的实际集成顺序仍需收口。**

   **为什么重要：** `freshStart:true` 会绕过本 issue 的核心数据保护，不能只是一个普通 boolean + 日志行；要定义可信来源、持久审计和远端 branch 已存在时的明确结果。P1/P4 虽无数据依赖，却都修改 `start()` admission seam；当前 probe 位于 lifecycle admission 和 CommDB pre-register 之后（`run-dispatcher.ts:1365-1376,1485-1496,1548`），失败清理必须成为验收契约。open-PR API 还可能返回多个候选。把 P1+P2、P3+P4 任意合并也会扩大首个止血 PR 的 blast radius。

   **建议修复：** 将 `freshStart` 限于已认证的人工 runs-route，记录 durable actor/reason/branch/tip receipt；其他内部 start caller 不接受该开关。给 `indeterminate` 定义稳定、可重试的错误码，并测试 lifecycle claim/CommDB/worktree 均无残留。PR lookup 精确限定 repo/head/base 并定义多结果处理。推荐顺序：修正后的 P1 单独先 ship；P2、P3 各自独立；P4 作为独立状态机 PR。P4 admission 应先于 P1 网络 probe，避免对本就处于 backoff 的请求做远端调用；随后再做 continuity，最后 pre-register/TURN/launch guard。

## Verdict

**CHANGES REQUESTED**

保持四包目标和 Q1/Q2 的决策；批准前至少必须修复：P1 fetch/materialization、continuity 不得篡改 `shareParentBranch`、P4 predecessor identity + 原子状态机 + Lead reset、P3 blob/head binding，以及 P2 的发布/调用方闭包。完成后可按包复审，P1 无需等待 P2-P4。
