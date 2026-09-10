# Design Review — plan.md (Round 4)

Date: 2026-09-09
Author: Codex
Status: APPROVED

## Summary

本轮按 Lead 授权的冻结范围，只复核 Round 3 的四项问题。基于当前 HEAD `dc506e80c` 的 plan v4、research.md，以及 Codex CLI 0.153.2 对 no-output stage1 和 phase2 selection 的原生落库路径，四项均已完整关闭。

v4 不再从 `jobs.status='done'` 推导虚假的 stage1 成功；`readable_ready` 也不再只依赖 global phase2 job 完成，而是绑定全部目标 output 的精确 selection snapshot。全部 `hints` 现在构成明确覆盖集，任何未 claim、无输出、失败、pending 或 phase2-only claim 都不能进入成功状态。research.md 的 source、lease/liveness 与负观察用词也已同步。设计保持 admit-time 架构、fail-open lifecycle、5 分钟预算、Lead scope 和 FLY-2359 非目标不变。

结论：`APPROVED`，可以进入实施。

## What's Good (Keep)

- **Round 3 #1 已关闭。** 每个 hint 的结果区分 `done_with_output` 与 `done_no_output`；成功要求 output 行存在、两段正文均非空，并且 `source_updated_at >= jobs.input_watermark`。这与 Codex `mark_stage1_job_succeeded_no_output` 会将 job 标为 done、同时删除 output 行的行为一致。
- **Round 3 #2 已关闭。** `readable_ready` 要求本 worker 的 phase2 done，并要求每个 hint 的 output 同时满足 `selected_for_phase2=1` 和 selection watermark 精确匹配。超出 phase2 top-N、目标未入选时只报 `stage1_done`；真实首轮语义仍由 E4 的模型 receipt 验证。
- **Round 3 #3 已关闭。** 顶层覆盖集明确为全部 `hints`，且至少需要一条 stage1；`expectedButUnclaimed` 非空、`done_no_output`、error、pending 或只有 phase2 claim 均为 `partial`。这消除了部分 claim 和空 stage1 集的成功假阳性。
- **回执足以追溯判定。** per-row 记录 output presence、source watermark、input watermark 和 phase2 selection；不落记忆正文，保持原安全边界。
- **测试合同具有反例覆盖。** C2 明列 no-output 行缺失/删除、旧 watermark、部分 claim、phase2-only、超过 256 未入选和成功入选等关键分支，不再只测试理想路径。
- **Round 3 #4 已关闭。** research.md 已补齐 `cli/vscode/atlas/chatgpt`、`archived=0`、`preview<>''`，明确不读 lease、不提供 per-candidate liveness，并统一为 `skipped:no_claim_observed_within_45s`。
- **既有范围保持稳定。** 没有重引入 closeout distillation、lease fence、巡逻、旧家回填、受控 legacy trigger 或 FLY-2359 transport 修改。

## Issues & Recommendations (numbered: issue, why it matters, suggested fix)

无。Round 3 的四项均已按建议关闭；本轮冻结范围内没有剩余阻塞项。

## Verdict

APPROVED — ready to implement
