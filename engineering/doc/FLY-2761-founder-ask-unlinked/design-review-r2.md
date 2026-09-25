# Design Review — plan.md (Round 2)

Date: 2026-09-24
Author: Codex
Status: APPROVED

## Summary

更新后的 C5 已关闭 R1 的来源绑定缺口，公开字节验收要求也已补齐，计划可以进入实施。复核限于 R1 两项修订及相邻生成、分组和生命周期契约，未发现新的阻塞项。审阅固定在干净工作树 HEAD `9d2d2c083ea18fc19d6e18077f0f6a5c7f3e65f9`；相对 R1 仅修改计划并收录反馈，生产源码和测试实现尚未改变。

## What's Good (Keep)

- **R1 #1（MEDIUM）已关闭。** C5 明确要求精确的身份 provenance、非空 ask_id、同一行匹配的 fact ID，以及 fact/since 的一致来源，保留 identifier 与空 title 限制（`engineering/doc/FLY-2761-founder-ask-unlinked/plan.md:74-84`）。这与真实 reader 生成的数据一致（`packages/teamlead/src/bridge/founder-attention-facts.ts:193-204`），也封住了通用 provenance 校验不要求 ask_id 的空缺（`packages/teamlead/src/epic-page/model.ts:625-633`）。
- **合并后的来源仍然有效。** `buildAttention` 按 issue_id 分组并保留不同 ask 的 sources，首条身份 provenance 对应的 ask 不会被合并过程删除；新增“两条合法 ask 合并后通过”用例覆盖了这一边界（`packages/teamlead/src/epic-page/attention.ts:315-364`、`plan.md:96`）。
- **R1 #2（LOW）已关闭。** 测试表已明确对 HTML 和 Markdown 的公开字节分别检查 excerpt 与完整 ask_id，并增加 metadata 可用时的 UUID 归一验证（`plan.md:95-97`）。这些是实施阶段待兑现的断言，本轮没有把它们当作已运行的测试。
- C1–C4、C6 的既定范围保持不变：不以链接可用性丢行，拆分缺链接与清单不完整，保留生命周期过滤，并文档化 bootstrap pendingDecisions 的覆盖边界。

## Issues & Recommendations

无阻塞项。

1. **LOW — UUID 归并测试应避免把生命周期过滤误判为成功归并（非阻塞实施建议）。**

   **证据与影响：** `plan.md:97` 指定 identifier ask 与同 issue holder 归并，但真实 founder holder 的 level 为 ship，ask 的 level 为 answer，ship 优先（`packages/teamlead/src/bridge/founder-attention.ts:2-6,15-20`）。`readAttentionSources` 在构造候选前仅保留与 effective level 相同的来源（`packages/teamlead/src/epic-page/attention-sources.ts:229-269`）；现有同步测试也明确要求 holder 生效时只留下 founder_gate source（`packages/teamlead/src/bridge/__tests__/founder-attention-sync.test.ts:202-228`）。因此仅断言“最终一行且 key 为 issue:<uuid>”可能没有实际测试 ask 的归一与合并。

   **建议：** 保留 holder+ask 场景验证现有生命周期优先级；用于验证真正归并的来源读取测试，可采用 identifier ask 加同 issue 的 UUID mailbox Lead 问题，并断言最终 `key === issue:<uuid>`、两种 source ID 都保留、founder 投影含 ask。这样无需改变生命周期规则，也能让归并测试具有区分力；可在实施时落实，无需为此新增设计评审轮次。

本轮验证：[verified by reading code] 重读完整更新计划、提交差异、R1 反馈及上述相邻源码。[verified by executing] 仅在内存中把新 C5 谓词代入当前源码，使用真实 buildAttention、其余 assertAttention 和 model assertCell 执行 10 个场景：合法单 ask、两条合法 ask 合并、原 Linear 身份均通过；fact ID 错配、缺 ask_id、since 来源错配、非 identifier、identifier 不等于 issue_id、非空 title、身份 key 含额外字段均被拒绝。10/10 结果符合预期，进程退出码 0；未写源码或测试文件，未运行 Vitest、lint 或 build。这是设计谓词验证，不是实施完成或生产验收声明。

## Verdict

APPROVED — ready to implement
