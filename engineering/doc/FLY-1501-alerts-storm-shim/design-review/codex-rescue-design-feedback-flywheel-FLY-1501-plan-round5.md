# Design Review — plan.md (FLY-1501) (Round 5)

Date: 2026-07-27
Author: Codex
Status: CHANGES REQUESTED

## Summary

Round 5 已实质关闭 Round 4 的两个问题：deterministic obligation primary key 提供了跨 closed-state 的全历史幂等性，显式 `ledgerRoot` 也把 TS reconciler 与 Python helper 绑定到同一目录和锁。当前只剩两个收口缺口：invalid-spool 的 pre-validation 分支到不了 helper quarantine，以及 CLI/research 的错误与退出码合同仍不一致；它们不会改变已批机制，但会让 A12 或实现文档假绿，因此本轮仍需小幅修改。

## What's Good (Keep)

- `restorm:<episode_key>` 作为 obligation primary key 正确补上了 partial open-only episode index 无法提供的全历史投影幂等性。
- replay 命中既有 deterministic id 时只校验 immutable projection fields，明确不 reopen、不修改 closed state、不创建第二行。
- exact spool schema、filename、episode、child 与 window 的一致性校验已移到 obligation 写事务之前，invalid input 不再污染权威库。
- `reconcileRestartStormSpool(kernel, {ledgerRoot, gateHelperPath})` 与 `mark-applied --root <abs>` 现在从同一绝对 root 派生 spool/applied/lock，消除了隐含 HOME。
- A12 已覆盖 helper crash 后 obligation 被关闭再重放、非默认临时 root 的真实锁竞争，以及 corrupt/mismatch 输入产生零 obligation。
- C-recipient、W4 阻塞边界和 W5 pinned-manifest scope 在本轮没有回退。

## Issues & Recommendations

1. **[MEDIUM] invalid-spool 的 quarantine 路径在当前流程中不可达，A12 的“quarantine 前后”断言无法按计划实现。** `plan.md:40` 规定 pre-validation 失败即“跳过该文件+记 events 行”，只有合法文件才进入 DB commit 后的 `mark-applied`；但同一行又把 quarantine 归给 helper，`plan.md:41` 也只有 helper content mismatch 才 quarantine。由于 invalid 文件已经在进入 helper 前被 skip，TS 又被明确禁止 rename/加锁，它会永久留在 live spool，每轮 reconcile 重复命中；A12 的 corrupt/mismatch→quarantine 因而没有调用路径。`events` 行的 `event_uid`/kind/cutover source 也未冻结，残留文件可能造成无界重复诊断事件。**建议：**明确一个可达的 invalid-file 处置合同：例如对 canonical-safe filename 先派生受校验的 child/episode，再在 pre-validation 失败时调用 helper 的 quarantine-only 路径；无法安全派生 identity 的 basename 则使用明确的 root-scoped quarantine helper 或定义为 fail-closed 留置。冻结 helper 参数、锁选择、durable rename/fsync、退出码，以及 deterministic `event_uid`/event kind/payload/`cutover_epoch`，确保同一坏文件重放只产生一个诊断事件。A12 分别覆盖 invalid JSON、filename↔payload mismatch 和 unsafe basename，验证零 obligation、唯一 event 与约定的 quarantine/留置终态。

2. **[MEDIUM] 四子命令退出码表仍未穷举状态损坏，且 research 的 kernel 投影段仍描述已废弃实现。** `resume` 和 `status` 都要在锁内读取 state，但 `plan.md:48` 只给它们列 0/2；state 损坏时若返回 0 会把 fail-closed corruption 伪装成成功，若返回其他值又违反“按 subcommand 列”的穷举合同。所有子命令都接受 `--root <abs>`，但非法/非绝对 root 的退出语义也只在 `mark-applied` 下出现。与此同时，已声称同步的 `research.md:174-175` 仍写旧签名 `reconcileRestartStormSpool(kernel, spoolDir)`、以 partial episode key 幂等、由 TS 直接 rename 到 applied，与 Round 5 plan 的 deterministic id、`ledgerRoot` 和 helper move 全部冲突。**建议：**为 resume/status 增加 corrupt-state exit（建议沿用 4），并列出所有子命令的 usage/root-validation 退出码；随后把 research §2.5 更新为当前 projection 流程，避免 implement 同时面对两套互斥合同。

## Verdict

CHANGES REQUESTED — address items above
