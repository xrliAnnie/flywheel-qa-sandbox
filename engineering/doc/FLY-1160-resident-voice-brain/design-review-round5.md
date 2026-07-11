# Design Review — plan.md (Round 5)

Date: 2026-07-10
Author: Codex
Status: CHANGES REQUESTED

## Summary

R5 已关闭 Round 4 所指出的 stage 覆盖缺口：summary、每个 transcript chunk 与 close 都有各自的 unknown-outcome 判定，缺失的 comments/status read seams 和三类回归测试也已纳入接线 PR。当前仍有 1 个 restart-feasibility blocker：列出的 durable pending schema 没有持久化目标 `issueId`，因此在最关键的“summary 已提交、client 超时、receipt 未写、daemon 重启”窗口里，boot reconciliation 无法知道应查询或续写哪个 issue。

## What's Good (Keep)

- R4 blocker 的 mutation 覆盖已完整闭环：`plan.md:224-240` 把 pending 定义为 stage-aware continuation，并分别用 `assistant-summary <sessionId>`、`assistant-transcript <sessionId> chunk i/n` 和 issue status read-back 判断 summary、每个 transcript chunk 与 close 的未知结果。
- reconciliation 行为明确为“确认已落则跳过并进入下一 stage，确认未落才续发”，不再把 summary marker 错当成整个 landing 的幂等证明，也不允许 blind retry（`plan.md:229-233`）。
- 计划诚实承认 comments-list/status read 是当前 Bridge 链路不存在的新能力，并把 scoped Bearer auth、分页、`BridgeLinearClient`/`LandingLinear` 合同、AbortSignal 和测试一起纳入 545/1006 接线 PR（`plan.md:234-237`）；这与当前仅有 comment/issue lookup 的代码事实一致。
- unknown-outcome 测试现在覆盖三类 Linear mutation，而不只覆盖 summary：transcript chunk 不重复、close 不重复写且最终 receipt/TIV 正确，能验证真正的 crash-window 幂等性（`plan.md:238-240`）。
- `/eleven` 的 `pending-landing.json` 已统一引用同一个 stage-aware schema 和 marker/status read-back 流程（`plan.md:340-345`），没有再形成第二套恢复语义。
- Round 3 的 cancellation fence、terminal-result context ack、shutdown 收尸、BrainPort 安全边界、barge-in 顺序及 Phase A/B/C 完成门均保持不变。

## Issues & Recommendations

1. **[BLOCKER] durable pending schema 不是 restart-self-contained：缺少目标 `issueId`，summary unknown 的重启恢复无法发起 marker 查询。** Plan `plan.md:223-240` 声明持久对象只记录 `{stage, chunkIndex?, marker, closeTarget?, sessionId, outcome}`，而 boot scanner 在 `:340-343` 要脱离已关闭 brain/旧 Session 做 reconciliation。现有成功 receipt 确实含 `issueId`（FLY-545 `AssistantLanding.ts:70-83`），但它只在 summary comment await 成功返回后才写（`:206-218`）；R5 正要覆盖的“服务端已提交、client 超时/重启”窗口恰好没有这张 receipt。当前 `/eleven` 文件也不能兜底：receipt/transcript 路径只是 `<stateDir>/<sessionId>.*`（FLY-1006 `assistant/wiring.ts:350-357,503-507`），JSONL `TranscriptEntry` 只有 backend sessionId/role/text 等字段，不含 kickoff issue（FLY-1006 `voice-core/src/types.ts:255-264`）。因此重启后既无法调用 comments-list/status read，也无法安全续发。**建议修复：**把 durable 文件定义为自足且可校验的 envelope，至少持久化 `{version, issueId, sessionId, outcome, ...stagePayload}`（若 daemon 可服务多个项目，再持久化 project binding/key 或明确从哪个稳定配置恢复）；最好用 discriminated union 约束 `summary:{marker}`、`transcript:{chunkIndex,marker}`、`close:{closeTarget}`，避免无 marker 的 close 或无 chunkIndex 的 transcript 成为合法状态。startup 对未知版本/缺字段必须保留 pending、fail-loud 且不发 Linear mutation。新增一条真正的 cold-start 测试：清空内存 Session、确保 summary receipt 不存在，只给 scanner pending+journal/config，验证它能定位正确 issue、查 marker、继续后续 stages，且不重复 summary。

## Verdict

CHANGES REQUESTED — address items above
