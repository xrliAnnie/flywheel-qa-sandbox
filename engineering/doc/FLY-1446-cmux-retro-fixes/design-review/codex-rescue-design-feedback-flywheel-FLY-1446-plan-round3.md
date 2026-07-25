# Design Review — plan.md FLY-1446 (Round 3)

Date: 2026-07-24
Author: Codex
Status: CHANGES REQUESTED

## Summary

Round 3 已把 Round 2 的五项方向性反馈基本落成可实施设计：carrier 闭集、Runner 凭据边界、R/M mutation 分相、observer 移出本单和独立 policy seed 都是正确收口。当前仍有一个会制造错误 roster episode 的 HIGH 缺口、一个建立在错误 HEAD 事实上的 scope deviation，以及一个新 rescue verb 未完整接入既有锁观测链的问题，因此本轮仍需修改。

## What's Good (Keep)

- Codex carrier 已改为 watcher 单点维护的 exact allowlist，并显式覆盖文件名不含 `tui` 的 infra-bot wrapper；标准 wrapper + Codex 不再从共享 `.env` 猜 TUI。
- Claude Lead 的检查先锁定 exact live tmux window `flywheel:=<project>-<leadId>`，再判断同名 cmux tab，避免仅凭人读标题推导 source。
- A-Runner URL 使用安全 loopback 默认，token 发送前校验 scheme/host/port 并拒绝 userinfo/path/query/fragment；Bearer 经 `curl --config -` stdin，且测试明确检查 argv 不含 token。
- Runner inventory 已对齐 `tmux list-windows -a`、session alias 按 distinct window id 合并、多 window id/malformed fail-closed 的现有 TS 语义。
- R/M 两相拆分正确：read-only 报警不被 WAL 恢复失败吞掉，所有新增 cmux mutation 则复用 post-refresh create 路径并受 blocked set 约束。
- Observer 实现和 flag 已从本 PR 删除，避免“默认关闭的未完成 mutation surface”悄然进入生产；follow-up 所需 marker/receipt/终态重验边界值得保留。
- `policy-enforce <socket>` 比伪造裸 `ensure` 合理，rollout 验收也已从“命令执行过”提升为 rc、PID、server option 和 exact sentinel 四项事实。

## Issues & Recommendations

1. **[HIGH] R 相仍没有“真实空 roster”与“tmux inventory 读取失败”的分型，可能把读失败放大成全员 missing/orphan episode。** Plan `plan.md:70-75` 要求 R 相在空窗分支和 `refresh_linked_sessions` 失败轮照常报警，但当前 `get_tmux_agent_windows()` 在 flywheel `list-windows`、`list-sessions` 和每个 runner `list-windows` 上全部使用 `|| true`（`scripts/flywheel-cmux-sync.sh:497-520`），所以 tmux binary/IPC/单 session 读取失败与“成功读到零窗”都是 rc=0 + 空字符串；`sync_additive()` 也正以空字符串进入 quiet branch（`:4902-4918`）。A-Runner 的新全局枚举同样只规定了 matched-row malformed/multi-id，没有明确命令失败、超时或不可解析全局输出时禁止 orphan 结论。建议新增一个供 R 相使用的 typed inventory seam（例如 `ok_nonempty | ok_empty | indeterminate`），保留真实命令 rc 并原子解析完整快照：只有 conclusive `ok_empty` 才能授权 per-subject missing/orphan 与 healthy re-arm；`indeterminate` 发一个 roster-blind/derive-failed episode并保留既有 subject 状态，不得批量转坏或转健康。若“tmux server 已被确证死亡”要按真实全空处理，应通过独立 server-generation/socket 证据明确区分，不能从任意 rc≠0 猜。补测试：binary/IPC failure、无 server、成功零窗、某 runner session 局部读取失败、恢复后一轮，分别验证 episode 与零 mutation。

2. **[HIGH] Observer 移出本单的核心事实理由不成立，导致 issue scope deviation 的审批依据不可靠。** Plan `plan.md:17` 和 `:106` 声称鉴权 `GET /api/sessions/:id` 今天不存在、需要新增 Bridge/TS endpoint；当前 HEAD 已在 `packages/teamlead/src/bridge/tools.ts:219-236` 实现该 route，并在 `packages/teamlead/src/bridge/plugin.ts:2146-2150` 通过 `/api` 的 Bearer middleware 挂载。它确有需要评估的边界——lookup 会从 execution id fallback 到 identifier，且 token 未配置时 middleware 会 no-op——但 plan 已要求响应 `execution_id` 与 receipt 全等，前者并不等于 endpoint 不存在。Observer 仍可留在 follow-up；请把偏离理由改成真实原因（durable log/rotation、receipt ownership、不可逆终态 allowlist和真机场景矩阵尚未完成，故主动切单），并明确现有 endpoint 是复用、需 harden，还是要新增 strict-by-execution route。同步更新 issue 验收/Linear follow-up，避免以虚假的跨边界依赖宣布原 issue 完成。

3. **[MEDIUM] 新 `policy-enforce` 只描述了拿同一 kernel lock，尚未完整接入 `tmux-server-rescue` 的 acquisition/decision/hold-observability 契约。** 当前框架在多个位置把 verb 闭集写死为 `ensure|recover`：`_tmux_rescue_prepare_lock_instrumentation`（`scripts/lib/tmux-server-rescue.sh:839-845`）、pending decision replay（`:1169-1195`）、owner evidence（`:1380-1389`）以及 `_tmux_rescue_run_with_lock` dispatch（`:1470-1498`）。只新增 CLI case 和 lock dispatch，确实可能在 kernel lock 内执行 policy，却因这些 `|| true`/allowlist 静默失去 acquisition receipt、crash replay、owner metadata和长持锁报警；现有“subcommand rc/lock”测试抓不住这个退化。请在 plan 中选择并写死一种实现：要么把 `policy-enforce` 映射到已有 `ensure` instrumentation verb并说明其审计语义，要么把新 verb 加入上述所有闭集与 usage/inner dispatch；测试除互斥锁外还要覆盖 acquisition/decision receipt、pending replay/hold alert，以及 server unreachable 时 nonzero + zero mutation。

## Verdict

CHANGES REQUESTED — address items above
