# FLY-2382 summary 写侧触发 + 缺席检测 — Codex 设计评审 R5 记录(appendix)
Issue: FLY-2382 (https://linear.app/geoforge3d/issue/FLY-2382/raya回流-summary-写侧触发-缺席检测按-prd-1846-872-的固定节奏6h运行期可改由机制叫-lead)
日期: 2026-09-07
基于: plan.md(blob 5a9fa69838ccc81537ff6fb70c163b84236c499f)

本文件是 plan.md §7 的续篇,单独成文是为了让 Bridge design_review 门校验的 plan blob 与 Codex 实际批准的 blob 完全一致(plan.md 在 R5 后不再改动)。

## R5(2026-09-07,plan blob 5a9fa698,Lead 裁定 ask `00e1fcbc` 准的确认轮)= ✅ APPROVED

反馈:`/tmp/codex-rescue-design-feedback-flywheel-FLY-2382-plan-round5.md`;Codex thread `01a0791a-1148-7030-be3b-9149d2494272`;共 5 轮:6→7→8→(减法)5→2 非阻塞。

Codex 原话:「没有发现继续阻塞① producer due event 或② absence visibility 的问题,也没有发现还应删除的独立子系统。」R4 五项(notification_context 不截断 / grace=min(30min,cadence) + 相位用例 / 三处 try/catch / L7 / L8)与 DEGRADED 写法均确认闭环。

## 两条非阻塞文案建议(实现前顺手改,不改设计)

1. plan §2.7 的「`summary` 文本只追加」与 §2.3 的合同(`summary` 不动,只向 `notification_context` 追加)冲突;以 §2.3 / G15 为准。实现者读到 §2.7 时按 §2.3 执行。
2. plan L7 的量口径:默认 6h 下**新增** 12 行/slot(11 条 `summary_due` + 1 条 `summary_slot_settled`);Raya 激活时本机制合计最多 13 行/slot(含既有 Raya round)。60s cadence 下约 18,720 行/天即按 13 行/slot 计。G12 应在 PR 里直接列出已核对的 production consumers(lead inbox redrive 只取 `workflow_replacement_eligibility` / `workflow_claim_recorded`;patrol 按 roster;两个通用全表查询目前无非测试调用者),不只在 L7 里提。

这两条由实现节点在改 plan §2.7 / L7 措辞时一并处理(改动不影响任何设计决策)。
