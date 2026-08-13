# Design Review — FLY-1718 plan.md (Round 2)
Date: 2026-08-12
Author: Codex
Status: CHANGES REQUESTED

## Summary

Round 1 的七个方向都已被实质采纳，计划明显更接近可实施状态：P1 现在 materialize 并验证对象；continuity 不再污染三阶段协议；P2 有发布闭包和统一安装所有权；P3 升级为 blob 绑定；P4 选择了 StateStore/CAS/outbox，并引入 predecessor identity。P2 本轮没有新的阻塞项。

本轮仍不能批准，原因不是重开已关闭架构，而是更新后的具体接线留下四个安全缺口：P1 仍用 `issueIdentifier` 推导 branch，和 Blueprint 的实际 `req.issueId` authority 不一致；P4 的“一次放行”在 runner 真正出生前就被永久消费；P3 的 expected snapshot 没有可信请求侧绑定且不能检测 tracked plan 的未提交改动；P4 的 canonical key 与 reset authority 仍未落到现有可验证边界。

## What's Good (Keep)

- P1 的 `ls-remote → explicit-refspec fetch → rev-parse → cat-file` 链和 SHA 窗口重试，修复了 Round 1 最核心的 Git mechanics blocker；新增“对象只在远端”的真 Git 用例正确。
- continuity 只写 `startPoint + continuityInherit`，原样透传 `req.shareParentBranch`；非 shared design/implement/qa 的 takeover、prompt、TURN 负测试覆盖到位。
- Q1/Q2 的原判断继续成立：`indeterminate` fail closed 正确；`completed` 继续排除在 resume 之外正确。
- P2 改为 edge-worker 发布资产并由 WorktreeManager 自安装，补上 atomic install、hash/mode/owner/symlink 校验、失败回滚、tarball 和 Voice Bridge 回归，外置 hooksDir 方案现在成立。
- P2 已明确 ACK 审计失败 fail closed，并如实列出 `--no-verify`/config 修改绕过；其定位现在准确地是事故护栏而非 security boundary。
- P3 删除了错误的 AutoQaCoordinator 接线，missing-plan 改为共享安全 builder；缺字段的部署窗口也有明确 fail-closed 行为。
- P4 不再假称复用 `workflow_rework_delivery`，而是复用其 CAS/事务/outbox 模式；`last_counted_predecessor_execution_id` 和并发负测试解决了“同一死亡反复涨代”的 Round 1 blocker。
- 四包拆成四个 PR、P1 单独先 ship，降低了止血变更的 blast radius。

## Issues & Recommendations

1. **[BLOCKER] P1 仍未使用 Blueprint 创建 branch 时的同一个 key 输入。**

   **为什么重要：** 计划 §2.2 用 `resolveWorktreeKey(issueIdentifier, ...)`。实际 Blueprint 用 `resolveWorktreeKey(node.id, ...)`（`Blueprint.ts:1267-1270`），而 dispatcher 传入的 `node.id` 是 `req.issueId`（`run-dispatcher.ts:1684-1685`）。两者并不保证相等：workflow engine 明确以 `run.issue_id` 作为 `issueId`，同时可能用 predecessor 的 Linear identifier 覆盖 `issueIdentifier`（`workflow-engine-dispatcher.ts:2380-2392`）。这样 preflight 可以探错 branch、得到 `missing`，随后 Blueprint 仍在真正的同名 branch 上执行 `-B ... origin/main`，正好重现 FLY-1704。

   **建议修复：** branch authority helper 必须消费和 Blueprint 完全相同的 `req.issueId`、role、`req.shareParentBranch`，最好抽出一次 `worktreeIssueId` 计算并同时供 preflight 与 Blueprint 使用，而不是两处各调一次。`issueIdentifier` 只用于显示/Linear alias，不能进入 branch key。增加 `issueId=<UUID>, issueIdentifier=FLY-1718` 以及两者反向/缺失的集成测试，断言 probe branch === `Blueprint.expectedWorktree(...).branch`。

2. **[BLOCKER] P4 的 `released_for_predecessor` 在真正 launch 前提交，会被任何后续失败或进程崩溃永久消耗。**

   **为什么重要：** §5.2 step 4 在 deadline 到期时先写 `released_for_predecessor`，然后 start 才继续 continuity、lifecycle admission、CommDB、TURN、hook install 和 Blueprint。若 continuity 返回 `CONTINUITY_INDETERMINATE`、founder park 拒绝、CommDB/TURN/config 失败，或进程在 spawn 前崩溃，没有 successor session 出生；但同一 predecessor 的后续请求按计划会“仍拒”，只能人工 reset。这把暂时网络故障变成了永久断路。

   **建议修复：** 将“一次放行”改成 durable launch reservation，而不是立即完成的布尔 receipt：至少持久化 `release_owner_execution_id`、lease/expiry、revision 和状态；同 execution 可幂等重驱，其他 execution 在有效 lease 内拒绝；在 `session_started`/等价 durable launch commit 后才结算 release；所有已知 pre-launch failure 释放 reservation，未知 crash 由 lease 过期恢复。若 launch 后 successor 真正短命 failed，才由它的 execution id 推进下一代。补上“release 后 P1 indeterminate / lifecycle parked / TURN 失败 / Worktree create 失败 / crash-restart”的测试。

3. **[BLOCKER] P3 的 blob SHA 仍是 result writer 自报，没有绑定到当前 trusted review request；dirty tracked plan 也会漏过。**

   **为什么重要：** §4.1 只在触发时检查 `<session.branch>:<planPath>` 存在，却没有保存 expected path/blob/revision；§4.2 让 runner 从当前 HEAD 自己写 `reviewedTarget + reviewedPlanBlobSha`。同一 execution 若先审 plan A、之后重新 stage plan B，旧的 design-review.json 仍可在 A 还存在时通过 gate。另一个反例是：HEAD 已有 plan A，worktree 把 A 改成未提交内容 A′；`git rev-parse HEAD:A` 仍返回旧 blob，计划声称的“uncommitted plan all fail closed”并不成立，Codex/implementer 却可能读取 A′。

   **建议修复：** event-route 在验证时计算 blob SHA，并原子写一个 Bridge-owned、非审批性的 design-review request manifest（`executionId + requestId/revision + expectedPlanPath + expectedBlobSha`）；instruction/result 回显 requestId，gate 要求 result 的 target/blob/requestId 同 manifest 一致，再与当前 HEAD 比较。gate 和建成点都对目标路径执行 tracked/staged/unstaged clean check（例如限定路径的 status/diff），拒绝 A→A′ 的 dirty 形态。增加“同 execution A 审批后改投 B，旧 result 不得过”和“已提交文件有 unstaged/staged 修改”测试。

4. **[HIGH] P1 的零残留顺序及 resume lock 接口仍与当前函数形状矛盾。**

   **为什么重要：** 当前 lifecycle admission 在 `run-dispatcher.ts:1365-1376`，resume 在 `:1548-1550`；计划要求 continuity 失败时“无 lifecycle claim”，却没有明确把 `admitLifecycle()` 移到哪里，并仍写 `abortPreLaunch`，而该 helper 会通知 lifecycle spawn failure（`:1158-1180`）。此外 `ResumeComputer` 当前是同步函数（`run-infra.ts:1046`），共享 `withRepoLock` 是 async；若在原函数内直接 targeted fetch，它无法进入同一 repo mutation lock。

   **建议修复：** 把精确序列写进计划：inflight check → P4 reservation → awaited origin-aware resume/continuity（共享 async `withRepoLock` materializer）→ lifecycle admission/claim → inflight reservation → CommDB → TURN → launch guard → Blueprint。pre-lifecycle 的 P1 拒绝直接抛 typed error，不调用 `abortPreLaunch`；claim 之后才走对称 cleanup。把 `ResumeComputer` 升为 async/await 或抽成 dispatcher 侧 awaited seam，并加一个与 WorktreeManager create 并发的 lock 测试。

5. **[HIGH] P4 的“canonical issue_identifier”与 reset 的认证/审计权威仍只是标签，不是现有机制可证明的合同。**

   **为什么重要：** repo 已有 `resolveLifecycleRootKey()`，其 canonical root 是 immutable Linear UUID（`lifecycle-root-key.ts:1-21,76-124`）；计划表却以可缺失/可漂移的 `issue_identifier` 为主键，未说明 UUID/identifier aliases 如何合并，仍可能分账。reset 则写“走 `/api/actions` 既有认证面”，但 `tokenAuthMiddleware` 在未配置 master token 时会 no-op（`plugin.ts:961-975`），action router 同时有无认证的 loopback `/actions` mount（`:1589-1609`），且现有 reserved action set 没有 reset（`reserved-endpoints.ts:38-45`）。直接加 action 不能证明只有 founder/Lead 能清断路器。

   **建议修复：** ledger key 改为 `(project, lifecycle_root_uuid, role)`，复用 `resolveLifecycleRootKey` 和同一 alias closure；runs-route 已拿到 `issueUuid`，将它作为 server-trusted alias 传入。无法唯一解析时按 P4 定位 fail open + loud warn，不另建 identifier key。reset 使用单独的 privileged API mount或明确扩展 reserved-authority 表：master token 缺失时 fail closed、不得生成 `/actions` 无认证 alias、actor 从认证/consent receipt 推导而非信任 body；reset 与 actor/reason receipt 在同一 StateStore 事务内提交。测试 UUID/identifier 两种入口共用一行、token 缺失/伪造 actor/loopback alias 均不能 reset。

## Verdict

**CHANGES REQUESTED**

Round 1 七项修订的方向均保留；下一轮无需重开 P2，也无需重议 Q1/Q2。批准前需收口：P1 使用 `req.issueId` 的同源 branch authority、P4 release reservation 的 launch-settlement/crash recovery、P3 trusted request manifest + dirty-path guard，以及 lifecycle/root/auth 的明确接线。
