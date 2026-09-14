# Design Review — plan.md (Round 5)

Date: 2026-09-11
Author: Codex
Status: CHANGES REQUESTED

## Summary

v1.5 已关闭 Round 4 指出的 HTTP provenance 路径：合法 producer 的核实成立，`/events` 会拒绝白名单 kind，`storeFacts` 不再读取可伪造的 `session_events`，并且 `cancelled` claim 已从放行条件移除。但 receipt 所在的 StateStore 数据库本身位于 Codex Runner 的可写 sandbox root 内，因此 Runner 可以绕过所有 TypeScript 写入点直接伪造承重 receipt；Round 4 的 provenance blocker 仍未从物理权限边界上闭合。

## What's Good (Keep)

- 生产源码 sweep 支持 §2.6 的 producer 结论：`worktree_takeover_failed` 的业务产生点只有 `Blueprint.ts:1470-1480`，真实 Bridge Blueprint 持有的是进程内 `DirectEventSink`（`run-infra.ts:664,934-944`），`TeamLeadClient` 没有生产实例化点，`flywheel-comm` 也没有产生该 terminal kind 的命令。
- `/events` 对 `PRE_ADAPTER_FAILURE_KINDS` 直接 400、HTTP terminal source 固定为 `http-events`、伪造 `source:"direct-event-sink"` 也不能写 receipt，正确关闭了 Round 4 的具体 HTTP spoof 路径。T-EV-1/2 与 forged-event-without-receipt 的 T-RQ/T-LC 用例应保留。
- `storeFacts` 只读专用 receipt，不再从 `session_events` 推断 provenance；旧行无 receipt 时 fail-closed，也避免把历史客户端 source 当可信事实。
- gate 只接受 `launchClaimState === "closed"`，明确拒绝可与 newborn Runner 共存的 `cancelled`，关闭了 Round 4 指出的 claim 反例。
- receipt 先于 terminal status 写入的 crash ordering 是 fail-closed 的；retention registry 三处同步也符合现有 schema 分类合同。

## Issues & Recommendations

1. **HIGH — “只有 DirectEventSink 调用 writer”不等于 Bridge-only provenance：Runner 对承重 receipt 所在的 SQLite 数据库有直接写权限。** 生产 StateStore 默认位于 `~/.flywheel/teamlead.db`（`packages/teamlead/src/config.ts:200-202`）。Codex daemon 的 sandbox writable roots 明确包含整个 `~/.flywheel`（`codex-daemon-adapter-helpers.ts:23-45`; `CodexTmuxAdapter.ts:1035-1041`），同时 Runner 环境还直接获得实际 `FLYWHEEL_STATE_DB_PATH`（`CodexTmuxAdapter.ts:2432`; `Blueprint.ts:736-748,3063-3067`）。StateStore 使用可跨进程写入的原生 better-sqlite3 WAL（`StateStore.ts:3951-3965`）；本机生产 DB 也是运行用户可写，且 `/usr/bin/sqlite3` 可用。于是同一个被 Round 4 视为不可信的 Runner 可以绕过 `recordPreAdapterFailureReceipt`，直接执行 SQL 插入 `pre_adapter_failure_receipts`；表定义没有 MAC、Bridge-only nonce 或不可伪造外键。它还可以直接修改同库中的 session status/launch claim，结合 Round 3 已确认的 evidence unlink 与 generic clean-miss，满足 v1.5 的全部放行门。T-EV-3 的 grep 只能证明源码调用点数量，不能验证这个权限边界。建议把 receipt 放入 Runner sandbox 不可写的 Bridge-only durable store，或给 receipt 加由 Runner 无法读取的 Bridge-only key 生成并在读取时验证的 MAC；另一条可行路径是移除 `~/.flywheel` 这个宽 writable root，改为枚举必要子目录并明确排除 StateStore 主文件及 `-wal`/`-shm`。验收测试必须覆盖物理边界：以 Runner 等价权限直接插入一行应失败，或无有效 Bridge MAC 的 raw-SQL 行必须让 `storeFacts` 返回无 receipt/`unknown`。在此之前，新增表只是新的可伪造 carrier，不能承担“从未进入 adapter.execute()”的证明。

## Verdict

CHANGES REQUESTED — address item above
