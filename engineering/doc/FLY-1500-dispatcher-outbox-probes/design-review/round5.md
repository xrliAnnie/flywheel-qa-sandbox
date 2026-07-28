# Design Review — plan.md (Round 5)

Date: 2026-07-27
Author: Codex
Status: CHANGES REQUESTED

## Summary

Round 5 已实质关闭 command probe 的迟到 unknown 回写、terminal attempt 后插 obligation，以及 branch binding 无权威源这三项 R4 风险。kernel-action 也不再把 WriteTx 交给 delegate，但 `{sql, params}` 仍允许任意单条 SQL，不能兑现“changes=0 天然零副作用”或“写 SQL 只住 kernel”两项合同；另有 attempt snapshot 与 research 接缝的两处较小漂移，因此本轮仍需修改。

## What's Good (Keep)

- `commandCasRecordProbeUnknown` 带完整 owner/generation/retry_count token；簿记、阈值读取、`effect_unknown` 终局和 obligation 被收进同一 kernel 事务，正确关闭了跨 attempt 串案。
- probe-adopt 复用的 succeeded CAS 原子清 streak/first_unknown_at，`effect_not_applied` 重排也继续原子清理，command probe 的三种确定/不确定出口现已自洽。
- `recordAttemptObservation` 把 active/host-epoch 检查放在 observation event 和 episode 写入之前；terminal/换代返回 0 行即零 event、零 obligation，正确补上了 0002 trigger 无法覆盖的“终结后才插入”窗口。
- branch-delete 已有 1498 权威的只读 `resolveBranchBinding` 接缝，executor 仍无 DB 写权；research 也不再把“payload 中有 SHA”误写成单独足以恢复/授权删除。
- §8.2/§8.5 已加入 denied、慢 probe、terminal/host-epoch 交错的 mutation controls。github_branch_delete 不进 manual_gate、补偿不豁免 notify-then-do、Discord 表现层效果不进 outbox 的裁决继续成立。

## Issues & Recommendations

1. **[HIGH] `buildBusinessCas() → {sql, params}` 仍可表达“有副作用但 changes=0”，H3 的结构性保证尚未成立。** §6.7 让 sibling delegate 返回任意 SQL 文本，再以 statement `changes` 判 granted/denied（`plan.md:406-411`）。但当前 WriteTx 只禁止事务/PRAGMA 等连接状态语句，`CREATE/DROP/ALTER` 均可执行（`kernel.ts:71-82,227-244`）。我用 SQLite 3.51.0 实测：单条 `CREATE TABLE t(...)` 执行后 `changes()=0`，表却真实存在；按本协议会提交 capability consume、schema 副作用、`bypass_used(outcome=denied)` 和 rejected command。`sqlite3_changes` 也不计 trigger 的间接写，因此仅检查 `>1` 不是副作用边界。并且 owner 批次生成 SQL 与 §0“所有写路径 SQL 仍收口在 kernel 包”（`plan.md:14-16`）直接冲突。**建议**：delegate 只返回 discriminated `BusinessCasSpec`/枚举 key + 参数，不返回 SQL；四条 SQL 常量及 kind→SQL 映射由 `v2-kernel` 持有，kernel 只允许对应的单行 `UPDATE ... WHERE ...`。注册时按 kind 固定 spec 类型，动态 payload 只能进 params。新增 mutation：尝试返回 DDL、非 allowlist target 或带额外 trigger/副作用的 spec，必须在执行前被类型/运行时 allowlist 拒绝；0-row canonical UPDATE 才可映射 denied。

2. **[MEDIUM] `recordAttemptObservation` 声称携带 snapshot `desired_state`，但回写谓词没有匹配该 snapshot 值。** §6.5 的 token 含 `{attempt_id,generation,host_epoch,desired_state}`，实际文字只要求当前行仍 `desired_state IN ('dispatched','started')`（`plan.md:377-383`）。因此 snapshot=`dispatched`、tmux 枚举 absent 后，1498 将同一行推进 `started`，旧回写仍会命中并新开 `attempt_absent`；我按该谓词实测 `changes=1`。这不会形成 terminal 后的永久 episode，但会在最常见的启动交错中制造假 obligation。另因 0001 的 `host_epoch` 可为 NULL，若实现使用 `host_epoch=:snapshotHostEpoch`，NULL token 永远 0 行。**建议**：把 canonical SQL 原文落进 §3.2，使用 `desired_state=:snapshotDesiredState AND desired_state IN (...)` 及 SQLite null-safe 的 `host_epoch IS :snapshotHostEpoch`；新增 `dispatched→started` 赶在回写前必须 0 行，以及 NULL host_epoch 的 unknown 观测可正确回写两测。

3. **[MEDIUM] research 的冻结接缝仍描述已废弃的 WriteTx delegate，且 transitional binding adapter 没有实际退役条件。** `research.md:150` 仍写 delegate 接收 WriteTx、返回 granted/denied，与 plan 的 `buildBusinessCas` 完全相反；research 接缝表也没有 `resolveBranchBinding`。同时 plan 只说 v1 StateStore adapter“带明确退役期”（`plan.md:393`），却没有给出日期、批次3步骤或可验收的退出条件。research 是本 plan 的上游，姊妹批次很容易按旧接口实现。**建议**：research 接缝同步为最终 `BusinessCasSpec` 形态并补 binding resolver；把 transitional adapter 的退役条件写实，例如“批次3完成 v2 binding backfill+双向核对后、旧 StateStore 原路径 fence 前删除 adapter”，并加入切换验收。

## Verdict

CHANGES REQUESTED
