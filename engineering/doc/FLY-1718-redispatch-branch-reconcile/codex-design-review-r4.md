# Design Review — FLY-1718 plan.md (Round 4)
Date: 2026-08-12
Author: Codex
Status: CHANGES REQUESTED

## Summary

Round 3 的四项 finding 均已实质闭合：P4 结算点已从过早的 `emitStarted` 移到 Bridge-local durable binding seam，settled successor 有独立 identity，auto-QA lane 已显式豁免；P3 也把 manifest 权威移入 StateStore，并补上服务端验证与投递修复。

本轮仍有两个 blocker，均位于新方案与现有生产 seam 的交界处：普通 runner 没有 `/api/runs` 认证面接受的凭证，因此 P3 gate 在真实 pane 中无法成功；P4 的 crash repair 又把“已有 binding”直接等同于“lifecycle activation 可结算”，遗漏了两者之间现存且可失败的 CAS。两项都应在实现前写进设计合同。

## What's Good (Keep)

- 保留 P4 的 Bridge-local `emitWorktreeReady` 权威边界；明确禁止 runner-postable HTTP 事件触发 settlement 是正确的。
- `last_settled_successor_execution_id` 将代数推进绑定到真正获得 launch release 的 successor，修复了 pre-binding failed session 污染计数的问题。
- `req.qaContext != null` 的窄豁免与现有 AutoQaCoordinator / three-stage QA 分工一致，且没有把全部 QA 都排除。
- P3 的 StateStore manifest、source-event 幂等 revision、server-side worktree/dirty 校验，以及 manifest/delivery crash reconcile，方向正确。
- P1/P2 与 Round 3 已关闭的 branch-key、ordering、reset-authority 设计保持不变；没有发现需要重开的旧问题。

## Issues & Recommendations

1. **[BLOCKER] P3 所声明的 `/api/runs` 认证面，普通 runner 实际无法访问。**

   **Why it matters:** §4.2 要求 `await-codex-gate design` 调用“同 `/api/runs` 认证面”的 loopback endpoint。现有 `/api/runs` 在配置 master token 时由 `TEAMLEAD_API_TOKEN` / Gemini scoped token 保护（`packages/teamlead/src/bridge/plugin.ts:961-998,3741-3763`），但 Blueprint 只把 `TEAMLEAD_INGEST_TOKEN` 传入 runner context（`packages/edge-worker/src/Blueprint.ts:2773-2777`），Claude/Codex pane 暴露的是 `FLYWHEEL_INGEST_TOKEN`（`packages/claude-runner/src/TmuxAdapter.ts:463-469`; `CodexTmuxAdapter.ts:1436-1442`）。master token 刻意不进入 pane，scoped allowlist 也没有该新 endpoint。结果是在真实 production 配置中，正确的 gate 请求会稳定收到 401/403；“token 缺失 fail closed”测试会通过，但成功路径永远不可达。

   **Suggested fix:** 在计划中选定一个 runner 实际持有、最小权限的认证合同。最小改动是把只返回 allow/deny、绝不回传 manifest 内容的 validation endpoint 放在 ingest-token 认证面，使用现有 `FLYWHEEL_INGEST_TOKEN`；若共享 ingest token 的权限范围不可接受，则 mint 一个按 execution（最好再按 requestId）绑定的 dedicated gate capability 并注入两种 runner。不要把 `TEAMLEAD_API_TOKEN` 注入 runner。增加 production-shaped 测试：pane 仅有 `FLYWHEEL_BRIDGE_URL`、`FLYWHEEL_EXEC_ID`、`FLYWHEEL_INGEST_TOKEN` 且没有 master/scoped token 时成功；错误/缺失凭证失败。

2. **[BLOCKER] P4 的 binding-crash repair 会绕过 lifecycle activation，可能错误结算或在 lease 到期后放出第二个 launch。**

   **Why it matters:** §5.2 step 5 前半正确要求 durable binding 且 lifecycle activation 未拒，后半却规定 repair 看到 matching binding 就直接 settle。现有真实顺序是 `bindWorktreeOnce` 先落库（`packages/teamlead/src/DirectEventSink.ts:439-481`），随后才 `await lifecycleActivate`（`:483-514`）；后者是另一笔 `starting→active` CAS，既可能被 founder park 拒绝，也可能 throw，而当前 sink 会捕获后继续。因而存在三种未覆盖状态：crash 在 binding 与 activation 之间、activation 明确拒绝、activation 结果 indeterminate。binding-only repair 会把前两者错误认作 settled；不 repair 而等待 10 分钟 lease 过期，又会在已有 runner/binding 时允许第二次 launch。

   **Suggested fix:** 把 repair 合同改为重驱同一权威事务，而不是“有 binding 即 settle”：在 canonical issue mutex 下验证 reservation owner 与 exact binding，原子地（同一 StateStore transaction）完成/确认 lifecycle `starting→active` 和 DOA `reserved→settled`；若 claim 已 `cancelled/closed`，不 settle，并释放给 park teardown；若 activation/DB 状态 indeterminate，保持该 owner fenced（可续 lease并告警），且 admission 在 matching durable binding 存在时不得因 lease 过期另放 owner。startup/periodic repair 必须调用同一方法。补测：binding 后、activation 前 crash；park 赢得 CAS；activation throw/DB busy 后重启；分别证明 cancelled 不 settle、indeterminate 不产生第二 reservation、active + matching binding 最终只 settle 一次。

## Verdict

**CHANGES REQUESTED.** Round 3 的四项修订已经到位，但 P3 当前没有可用的 runner credential，P4 repair 也尚未把 lifecycle activation 纳入 durable settlement authority。这两点会分别造成 gate 永久 fail-closed，以及 park/重生竞态下的错误结算或双 launch；补齐后应可进入批准轮。
