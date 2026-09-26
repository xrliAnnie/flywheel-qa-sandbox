# Code Review — FLY-2901 (Round 2, scoped to the R1 fix b1fd2e1d4..6286e2be1)
Date: 2026-09-25 / Reviewer: Codex (same companion thread, xhigh, read-only) / Status: APPROVED

> 以下为 Codex 输出原文。

# Summary

Reviewed HEAD: `6286e2be1ea042d3db573b026e0b36e002a0a43b`

本轮严格审查 `b1fd2e1d4..HEAD`。三个 Round 1 finding 均已关闭，未发现修复引入的新回归。

验证结果：

- 生产代码及测试差异通过 `git diff --check`。
- `packages/edge-worker` TypeScript 检查通过，退出码 `0`。
- 测试文件存在用户预先留下的未提交修改，因此审查证据固定读取 HEAD blob；没有修改工作区。
- 本轮未在只读沙箱中重新运行会创建临时 Git 仓库的测试。测试实现已逐项检查，并与提示中给出的修复前 RED 结果核对。

# Per-finding Status

1. **CLOSED — [HIGH] local-branch probe failure treated as absent**

   `packages/edge-worker/src/worktree-takeover-transaction.ts:895-927` 现在使用三态探测：

   - 只有 `for-each-ref` 成功且未返回精确 ref 时才返回 `null`。
   - Git 命令失败会拒绝为 `registration_indeterminate`。
   - 精确 ref 返回非法 OID 时同样 fail closed。
   - `worktree_missing` 在任何 prune/rebuild 前调用该探测（`:541-570`）；`unregistered + absent` 在删除或创建 worktree 前调用（`:599-608`）。

   新测试确实覆盖原失败路径：

   - `packages/edge-worker/src/__tests__/WorktreeManager.takeover-rescue.test.ts:1327-1349` 注入本地分支探测失败，验证 unregistered/absent 路径拒绝，并保留唯一分支 tip；修复前会错误返回 `created`。
   - 同文件 `:1351-1374` 覆盖 `worktree_missing`，验证拒绝发生后分支和 worktree registration 均保留；修复前会继续 rescue。
   - `:1300-1324` 的注入 seam 同时匹配旧 `rev-parse` 与新 `for-each-ref`，因此测试具备有效的修复前 RED、修复后 GREEN 区分能力。

2. **CLOSED — [HIGH] missing recorder capability bypasses pending-rescue lookup**

   `packages/edge-worker/src/worktree-takeover-transaction.ts:336-365` 将 recorder 和 `runId` 组合为强制能力门槛，并在 pending-rescue 查询及任何分类之前拒绝 `rescue_event_capability_missing`。因此 clean reuse（`:411-428`）和 fresh create（`:599-608`）均无法绕过该检查，符合计划 §4.0 的预期行为。

   新测试覆盖了关键状态：

   - `packages/edge-worker/src/__tests__/WorktreeManager.takeover-rescue.test.ts:1272-1297` 验证无 recorder 时 dirty、clean reuse 和 fresh create 全部拒绝，且 fresh 路径未创建目录。
   - `:1394-1410` 构造 rescue 已完成清理、但 cleaned receipt 写入失败的重入状态；随后移除 recorder/runId，确认拒绝而不是修复前的 `reused`。
   - `:1376-1392` 进一步验证 prune 后崩溃重入时，缺少能力不会创建新 generation。

3. **CLOSED — [MEDIUM] rescue push not create-only under a remote race**

   `packages/edge-worker/src/worktree-takeover-transaction.ts:1324-1355` 保留 preflight 检查，并为每个待创建 ref 加入：

   `--force-with-lease=refs/heads/<remoteBranch>:`

   空 expected value 明确要求远端 ref 在 push 时仍不存在。即使另一个进程在 `ls-remote` 与 push 之间创建了 ancestor-valued ref，atomic push 也会失败，而不会将其 fast-forward。后续精确 OID 验证仍保留于 `:1363-1375`。

   `packages/edge-worker/src/__tests__/WorktreeManager.takeover-rescue.test.ts:1412-1441` 在 push 前注入竞态，直接创建相同远端 rescue ref，并验证：

   - transaction 拒绝为 `rescue_push_failed`；
   - 竞态 ref 仍指向原始 base；
   - ref 未被 fast-forward。

   该测试直接复现了修复前会错误 fast-forward 的情形。

# New Findings

未发现新的 `[BLOCKER]`、`[HIGH]`、`[MEDIUM]` 或 `[LOW]` finding。

# Verdict

三个 Round 1 finding 均有对应的 fail-closed 实现和具备修复前失败区分力的回归测试；未发现本次修复引入的阻塞性或高严重度回归。

VERDICT: APPROVED
