# Design Review — plan.md (Round 4)

Date: 2026-09-11
Author: Codex
Status: CHANGES REQUESTED

## Summary

v1.4 已把 Round 3 的文件系统三轴降为一致性核对，并用 pre-adapter failure + 终结 claim 收窄正常控制流；`worktree_takeover_failed` 的真实生产返回点也确实早于 `adapter.execute()`。但新的承重事实取自 Runner 可写的 `/events` 通道，当前设计没有可信 provenance，且 `cancelled` claim 按现有合同可与已出生 Runner 共存，因此仍存在活 Codex daemon 被误判为 `dead` 的真实安全路径。

## What's Good (Keep)

- `worktree_takeover_failed` 的真实 Blueprint 分支位于 `Blueprint.ts:1470-1480`，明确早于 `adapter.execute()` 的 `:3105`；把白名单固定在这个最小集合，方向正确。
- `storeFacts` 只接入 lifecycle-closeout，其他五个生产调用者不具备新放行条件；`starting / active / missing` claim、非白名单 failure kind、`no_group / stale / unreadable / live` 证据均继续 fail-closed。
- `missing + socket dead + lock absent` 已降级为辅助一致性核对，T-RQ-14 保留 `no_group + released lock => unknown`，因此 Round 3 的 lock-release 实现风险不再直接承重。
- regular-file parity、symlink/FIFO 等有意 fail-closed 变化、pre-persist `no_group` 时间线以及 `teardown.reason` authority 形状均已同步到主要计划、守卫和 chunk/test 清单。
- cause 优先级仍合理：显式失败错误优先，两个 authority 形状其次，未确认消失最后；`blocked` 无 cause 回落 `unknown` 也保持语义诚实。

## Issues & Recommendations

1. **HIGH — `session_failed.payload.failureKind` 不是可信的控制面事实，Runner 可伪造唯一白名单值。** Codex daemon 环境直接获得 `FLYWHEEL_INGEST_TOKEN`（`CodexTmuxAdapter.ts:2422-2423`），而源码明确把 `/events` 视为 Runner-visible / untrusted wire（`event-route.ts:1586-1612`）。该入口会接受 `payload.failure.failureKind="worktree_takeover_failed"`，传给 `recordEnrolledTerminalSignal`（`event-route.ts:1388-1414`），后者正好规范化成计划所读取的顶层 `session_failed.payload.failureKind`（`StateStore.ts:38896-38914`）；现有测试甚至明确断言带 ingest token 的该 HTTP 请求返回 200（`event-route.test.ts:1961-1998`）。`launchClaimState` 不能补上 provenance：源码明确记录 `starting -> cancelled` 后 Runner 仍可能出生，因为 activation refusal 只审计、不撤销已越过 verify 的启动（`lifecycle-closeout.ts:1236-1246`; `DirectEventSink.ts:616-640`）。因此，一个这种 newborn/live Runner（或任意已失败但 detached daemon 仍活的执行）可以提交白名单事件；结合 Round 3 已确认的 root drift / 同 UID evidence unlink 与 generic `pgrep` clean-miss，便能满足 v1.4 全部门并被误判 `dead`。终复核只重读文件证据，不能发现伪造 provenance。建议不要从通用 `session_failed` 事件推导承重事实：新增或复用一个只有 Bridge 内部 DirectEventSink/dispatcher 能写的 durable pre-adapter receipt，并让 `storeFacts` 校验该 receipt。若采用最小入口隔离方案，至少要让 `/events` 拒绝所有 `PRE_ADAPTER_FAILURE_KINDS`、把 HTTP `source` 固定为 Bridge 赋值而非接受 `event.source`，且 eligibility 同时要求不可由 HTTP 伪造的 Bridge-local provenance；仅检查 `source === "direct-event-sink"` 目前不够，因为 `event-route.ts:1411-1412` 也信任客户端 source。补三条负向/正向测试：Runner token（含伪造 source）不能创建 eligible pre-adapter fact；真实 DirectEventSink 的 takeover failure 可以；`cancelled` claim + 已出生 Runner + HTTP spoof 必须保持 `unknown`。

2. **MEDIUM — Follow-up：计划漏了 core package 的 runtime re-export。** `packages/core/src/index.ts:20-32` 对 `adapter-types.ts` 目前只有 `export type { ... }`；把 `PRE_ADAPTER_FAILURE_KINDS` 仅新增到 `adapter-types.ts` 并不能让 teamlead 从 `flywheel-core` 导入运行时常量。请在实现时把 `export { PRE_ADAPTER_FAILURE_KINDS } from "./adapter-types.js"` 加入变更清单/测试，或明确采用不会穿越 package public API 的归属位置。按本轮规则这是实现 follow-up，不单独改变 verdict。

3. **LOW — Follow-up：§2.2.3 仍保留一句已被本轮否定的 lock 论证。** 第 134 行正确说明 `ensureDead()` 只证明 socket 不再监听、lock 不承重，但紧接的第 135 行又称 lock 只会在 “daemon 证明已死” 后释放。应删除或改成“socket-dead cleanup 后释放，不能单独证明进程组消失”，避免实现者或后续审计恢复旧假设。实际 gate 与 T-RQ-14 已 fail-closed，因此这是文档 follow-up，不是第二个 blocker。

## Verdict

CHANGES REQUESTED — address items above
