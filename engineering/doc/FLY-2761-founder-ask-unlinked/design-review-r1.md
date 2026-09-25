# Design Review — plan.md (Round 1)

Date: 2026-09-24
Author: Codex
Status: CHANGES REQUESTED

## Summary

方案抓住了漏报的两处原因，C1–C4 的呈现、计数和身份补源方向可行，bootstrap 选择写明边界也符合本单要求。实施前需收紧 C5：当前文字只比较 provenance 中声明的 ask_id，没有保证该 ID 就是本行 founder_ask fact 的实际 ID，允许错误来源被用于补源身份。审阅基于干净工作树 HEAD `d4cc2cc29f51515baa430149d04459ff34b8bd51`；与阴性对照 `637752fcc` 相比，仅新增上游文档和 fixture，相关生产源码一致。

## What's Good (Keep)

- 删除统一入口的链接过滤，能同时修复 HTML 与 Markdown 的 founder 列表；保留链接校验、无链接提示和生命周期判定是合适的边界。直接消费者及相关过滤搜索未发现另一处遗漏的同类静默链接过滤（`packages/teamlead/src/epic-page/attention-presentation.ts:192-231`、`render-html.ts:522-545`、`render-markdown.ts:484-504`）。
- C4 先查完整的共享 metadata，再为 ask 补 identifier：同一轮已有 UUID/identifier 映射时，各来源都会选择同一个 Linear ID，不会仅因新增 fallback 同时产生 UUID 行和 identifier 行。metadata 缺失时保留不同的未知来源行，配合不完整提示，比猜测归并可靠（`packages/teamlead/src/epic-page/attention-sources.ts:163-217`、`attention.ts:292-324`）。
- 复用讨论串解析器保留了项目频道范围、冲突、失效讨论串及 Discord ID 校验；空 title 使用明确 missing，不冒充 Linear 标题，也不公开 excerpt（`packages/teamlead/src/StateStore.ts:3623-3665`、`bridge/tools.ts:952-963`）。
- 预算处理保留整行及其全部 sources，再重建派生字段；没有额外依赖“已解析身份必须来自 Linear”。Lead 投影仍按来源种类筛选，Markdown 改用 founder 行数能修正现有计数差异（`packages/teamlead/src/epic-page/attention-budget.ts:39-53,111-145`、`attention-presentation.ts:196-227`）。
- C6 无需新增第二套待办行为：实际 pendingDecisions 仅取最近的 awaiting_review sessions，用户明确允许文档化不覆盖 founder_ask（`packages/teamlead/src/bridge/bootstrap-generator.ts:305-311,534`、`lead-runtime.ts:82`）。现有同步测试也覆盖 no-session ask 的亮起、回复熄灭和终态抑制，保留这条生命周期链路正确（`bridge/__tests__/founder-attention-sync.test.ts:148-175,230-239`）。

## Issues & Recommendations

1. **MEDIUM — C5 的“本行自己的 ask”判定尚未闭合；实施前必须补齐。**

   **问题与证据：** `engineering/doc/FLY-2761-founder-ask-unlinked/plan.md:74-80` 只要求身份 provenance 的 `key.ask_id` 等于某条 founder_ask 来源 provenance 的 `ask_id`。然而通用 provenance 校验允许空 key，也不要求存在 ask_id（`packages/teamlead/src/epic-page/model.ts:625-633`）；source 校验对 fact ID 与 provenance key 的一致性仅覆盖 mailbox/holder，没有 founder_ask 分支（`packages/teamlead/src/epic-page/attention.ts:602-623,658-673`）。实际 reader 正确地产生 `fact.value.id = ask.ask_id` 和相同的 provenance key，但这是尚未被 C5 校验的关系（`packages/teamlead/src/bridge/founder-attention-facts.ts:193-204`）。

   **具体反例：** 本行唯一 fact 为 `{ id: "ask-A", kind: "founder_ask", state: "pending" }`，其 fact/since 与三格身份 provenance 全部写成 `statestore/founder_ask/{ask_id:"ask-B"}`；issue_id、identifier 均为 `FLY-2736`，title 为 null。按 C5 原文它会通过，虽然本行没有 ID 为 ask-B 的 fact。将这些 provenance 的 key 全部改成 `{}`，还会因 `undefined === undefined` 通过。

   **验证：** [verified by reading code] 上述缺口来自现有校验分支。[verified by executing] 在内存中加载当前 TypeScript，将 C5 条件替换成计划原文对应谓词，使用真实 `buildAttention`、其余 `assertAttention` 和 model 的 `assertCell` 执行三个场景：合法 ask、fact ID 不匹配、缺 ask_id，三者均被接受；当前未加宽的条件拒绝三者。最终探针退出码 0，无源码或测试文件改动。这是设计谓词模拟，不是已实现代码的测试结果。

   **建议：** 明确要求用于补源的 ask_id 为非空字符串，且等于被选中 founder_ask source 的 `fact.value.id`；同时核对该 source 的 fact/since 均为 `statestore · founder_ask`，二者 `key.ask_id` 与这个 ID 相同。三格补源身份引用这个已校验来源，继续保持 identifier 形状、identifier=issue_id、title=null 等限制。新增“fact ID 与 provenance ID 不同”“缺 ask_id”“since 来源错配”负向测试，并保留同一 issue 多条合法 ask 合并后的通过用例。无需回查数据库或引入新 schema；真实 issue 归属仍由项目范围内的 reader 提供，校验器负责封住行内来源不一致。

2. **LOW — 验收表中的公开字节检查尚未完整落入现有 fixture（建议，不阻塞设计）。**

   **问题与证据：** 计划 `plan.md:91` 写了“页面字节不含 excerpt / ask_id”，现有 fixture 只检查 HTML 不含 excerpt，未检查 ask_id，Markdown 也只检查 identifier（`packages/teamlead/src/epic-page/__tests__/founder-ask-outside-scope.test.ts:125-134`）。此次恰好会把 ask provenance 加到身份三格，补齐该断言能直接约束新增来源不会出现在公开字节中。

   **建议：** 在实现时对 HTML 和 Markdown 均断言不含完整 `SAMPLE.ask_id` 与 excerpt；断言范围是公开渲染结果，保留内部 document 的审计来源。另建议增加一个 metadata 可用的 identifier ask + UUID 来源归并用例，将上面已核对的单行计数行为固定下来。

## Verdict

CHANGES REQUESTED — address items above

必须关闭第 1 项后再实施；第 2 项为非阻塞建议。本轮为源码与设计审阅，仅执行了上述无文件写入的内存探针，未运行 Vitest、lint 或 build；计划记录的 3/3 RED 为提交内既有证据，本轮未重跑。
