# Design Review — plan.md (FLY-1501) (Round 4)

Date: 2026-07-27
Author: Codex
Status: CHANGES REQUESTED

## Summary

Round 4 已关闭 execute-only recipient 合同与 W5 decision-family scope 两项问题；把跨语言锁集中到 Python `mark-applied` helper 的方向也符合现有 Node/Python 边界。剩余问题已收窄到 restart-spool 投影：计划仍把 partial open-only index 当作全历史幂等键，并且 helper 没有收到 reconciler 实际枚举的 spool root；这两点会让 A12 在真实 crash replay 中失效，因此本轮仍需修改。

## What's Good (Keep)

- C-recipient 在正文、正式 §4 合同和 A4 中均已统一为 execute/effect-handoff only；claim 不解析、不缓存权威 recipient。
- W5 已明确从 pinned `snapshot.manifest.nodes` 读取窗口，并以 loops+edges 推导的 decision contract 强制字段 scope；live seed 不再是运行时 authority。
- `mark-applied` 把 fcntl acquisition、content revalidation、live/applied 仲裁、durable move 和 directory fsync 放在同一个 Python 临界区，TS reconciler 不再伪装成能直接持 POSIX lock。
- helper missing、exit 75、DB commit 后 crash 都保留 live spool 并依赖下一轮幂等重试，A12 也加入了真实双进程锁竞争测试。
- W4 继续保持 C5/C7 未签字即不实现的清晰交付边界。

## Issues & Recommendations

1. **[HIGH] restart-spool 的 obligation upsert 仍没有真正的全历史幂等键，A12 所承诺的 crash replay 可产生第二条 obligation。** 计划把“episode 唯一键”作为 DB commit 后 helper 失败时反复 upsert 不重复的依据（`plan.md:38,128`），但当前 schema 只有 `UNIQUE(episode_key) WHERE state='open'`（`packages/v2-kernel/src/migrations/0002-obligations-rebuild.ts:1-39`），它只保证同一时刻最多一个 open row，不保证同一 spool episode 的历史投影恰一次。失效交错是：kernel upsert commit → helper missing/crash，live spool 保留 → 首条 `restart_storm_hold` obligation 被 resolved/tombstoned → 下一轮 reconcile 看不到 open conflict，再插入第二条历史 row。另一个顺序问题是计划把 content validation 放在 commit 后的 helper 中；parseable 但 filename/`episode_key`/`child_key` 不一致的 spool 可能先写入错误 obligation，之后才被 helper quarantine。**建议：**在 kernel 事务前冻结并执行 exact spool schema、filename、episode/child/window 一致性校验；投影使用独立的永久幂等键，例如由 episode_key 确定性派生的 `obligations.id`，或在同一事务写一个全局唯一 projection receipt。重放命中既有 id/receipt 时必须校验 immutable projection fields，绝不能 reopen、更新已关闭 state 或再建 row。A12 增加“commit 后 helper 崩 → 原 obligation 关闭 → reconcile 重放，历史 obligation 总数仍为 1”的测试，以及 mismatch/corrupt spool 在 quarantine 前后均产生 0 条 obligation 的反向测试。

2. **[MEDIUM] `mark-applied` 尚未绑定 reconciler 实际使用的 spool root，且 CLI/退出码总合同仍自相矛盾。** `reconcileRestartStormSpool` 接收 `{spoolDir, gateHelperPath}`，但冻结的 helper 调用只有 `mark-applied <child_key> <episode_key>`（`plan.md:38`）；helper 没有参数或已冻结 env 来证明它操作的 live/applied 路径就是 TS 刚枚举的 `spoolDir`。这在临时目录测试、非默认 state root 或未来迁移中会变成“DB 已 commit，但 helper 永远在另一目录查文件”。同时 W3 总合同仍称脚本只有 `gate/resume/status` 三个子命令且退出码仅 0/2/3/4（`plan.md:44`），与新增第四个 `mark-applied` 及其 exit 75 冲突。**建议：**改为注入绝对 `ledgerRoot` 并由 TS/helper 共同派生 spool、applied、child lock，或把绝对 `spoolDir` 作为受校验参数/env 显式传给 helper；不要依赖隐含 HOME。同步把 CLI 表更新为四个子命令并按 subcommand 列出 exit 语义，验证 child/episode 不能逃逸 root。A12 的双进程测试应使用一个与 HOME/default root 不同的临时 root，证明双方确实竞争同一 lock、移动同一个文件。

## Verdict

CHANGES REQUESTED — address items above
