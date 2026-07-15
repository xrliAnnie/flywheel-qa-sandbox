# Design Review — plan.md (Round 4)

Date: 2026-07-10
Author: Codex
Status: CHANGES REQUESTED

## Summary

R4 已准确关闭 Round 3 的两个 blocker：landing deadline 现在有真实取消与 late-result fence，context 也改为 normal terminal result 才 ack，并在非正常终止后保守重投。剩余 1 个阻塞点位于新加入的 startup reconciliation：它只定义了 summary marker 的确认办法，尚未覆盖 AssistantLanding 的 transcript chunk 与 close mutation，也没有把“列 issue comments”的现有缺失读取 seam 纳入跨分支实现合同。

## What's Good (Keep)

- R3 #1 的 late completion 风险已被正面关闭：`plan.md:215-229` 要求 AbortController + generation token，resident 终轮和 Linear fetch 接收 signal，并在每次 await/外部写前后检查 deadline；abort 后不再推进、不写 success receipt、不渲染成功 TIV。
- pending state 已区分 `not_started` 与 `mutation_outcome_unknown`，deadline 路径只原子落 durable pending、绝不在超时路径发起第二次 Linear；“comment 晚返回”和“服务端已提交但客户端超时”两个关键测试也已明确。
- R3 #2 已完整关闭：`plan.md:111-119` 把 context ack 点移到 normal terminal result；interrupt/error/crash/timeout 保留 unacked snapshot，以稳定 seq 标记重注入，明确接受可识别重复而不接受静默丢失。
- 类型与接线合同同步：`ResidentBrainEvent` 已加入 `context-drained{upToSeq}`（`plan.md:96-100`），manager 公共合同加入同步 `forceKillAll()`（`:172-178`），/glaw Feed adapter 也明确只把 terminal-result ack 当作 drain 信号（`:281-288`）。
- 对应测试覆盖具有判别力：context frame drain 后 SIGKILL、下一轮重注入并在 normal result 后才清；shutdown 则覆盖 summary/Linear 永挂、late resolve 和多 child 收尸，不只是 happy path。
- Phase A/B/C、默认 OFF、BrainPort 鉴权、barge-in 同 tick 停嘴、dispose 分级收尸及 byte-compat 哨兵均保持此前已审定的边界，没有因本轮修订扩大 /gemini 产品范围。

## Issues & Recommendations

1. **[BLOCKER] `mutation_outcome_unknown` 的 reconciliation 目前只会查 `assistant-summary <sessionId>`，不能判定 transcript chunk 或 close 的未知结果；同时计划依赖的 comments-list read seam 在当前 Bridge 链路中不存在。** Plan `plan.md:223-229,329-332` 只规定 list issue comments 查 summary marker。但真实 AssistantLanding 是 summary comment → 多个 transcript comments → close issue（FLY-545 `AssistantLanding.ts:1-15,199-308`）；每个 transcript chunk 都是独立 Linear mutation（`:277-295`），close 也是独立 mutation（`:299-307`）。若 chunk 2 或 close 已在服务端成功、客户端因 deadline/重启未收到结果，仅发现 summary marker 并不能判断该 mutation 是否应重试：前者会重复逐字稿，后者要么重复 close、要么错误停在 open。此外，当前 `BridgeLinearClient` 只有 create/comment/update/issue lookup（`BridgeLinearClient.ts:6-12,80-107`），Bridge 仅暴露 POST comment 与不含 comments 的 GET issue（main `plugin.ts:2400-2484`），没有计划所说的 list-comments 能力。**建议修复：**把 pending schema 定义为 stage-aware continuation（至少记录 `stage: summary | transcript | close`、transcript `chunkIndex/marker`、目标 close status、generation/sessionId）；summary 和每个 transcript chunk 的 unknown outcome 分别用既有 deterministic marker（`assistant-summary…` / `assistant-transcript … chunk i/n`）查询，close unknown 则读取 issue 当前 status 后决定是否重试。把 scoped、Bearer-auth 的 comments-list（含分页直到命中或 EOF）以及 issue-status read 能力明确加入 545/1006 wiring PR 的 Bridge route、`BridgeLinearClient`/`LandingLinear` 合同和测试，所有 fetch 同样接 AbortSignal。补至少两条 unknown-outcome 回归：transcript chunk 服务端提交后 client timeout 不重复；close 服务端成功后 client timeout 不重复 mutation、reconciliation 正确完成 receipt/TIV。现有 summary timeout 测试保留。

## Verdict

CHANGES REQUESTED — address items above
