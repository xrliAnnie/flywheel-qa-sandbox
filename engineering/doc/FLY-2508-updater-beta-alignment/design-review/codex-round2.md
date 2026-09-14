# Design Review — plan.md (Round 2)

Date: 2026-09-13
Author: Codex
Status: CHANGES REQUESTED

## Summary

Round 1 的 `covered_by_newer` 验收缺口已经完整关闭，FLY-2534 的正确 ownership、根因和 QA 前置也已写入主要部署/风险/follow-up 段落；整体设计仍然可实现且保持 fail-closed。当前提交 `a24655d8d2c6009f4d2dadaa4b6286228b5838cd` 仍有一处与 Lead 裁定直接冲突的旧规范文本，因此尚不能批准。

## What's Good (Keep)

- §8.5 现在正确拆分 `published | no_change`、`covered_by_newer`、缺失/非法回执；只有前两者中的 `published | no_change` 能证明 occurrence 的 deployed SHA 与发布 SHA 对齐。
- §5 的回滚测试新增 `publishedSourceCommit !== occurrence.sourceCommit`，并要求同夹具的 `published` 分支给出相反正例，消除了 vacuous acceptance。
- §8.6 明确只消费 `published | no_change`，要求 QA 写明实际 outcome 分支；`covered_by_newer` 不再被误报成对齐成功。
- §8.2、§10 与 §12 F1 已正确把 workflow 恢复绑定到 Lead 已认领的 FLY-2534，并明确本单不改 workflow、QA 必须等待其合入和部署。
- compare 404 与 ancestry-negative 的原因码现在分层清楚：非 200 保留 `beta_github_http_*`，只有成功响应中的 behind/diverged/merge-base mismatch 才成为 `beta_source_not_on_default_branch`。
- 管理台 DTO 已明确表示“当前配置策略”，而不是 active occurrence 或最近发布来源；TOCTOU 也被保留为由 B3 fail-closed 兜底的 availability residual risk，没有扩大 v1。
- `beta-release-config-source.test.ts` 已进入配置回归清单，补齐了新增必填默认字段会影响的现有夹具。

## Issues & Recommendations (blocking)

1. **Round 1 blocking #1 仍未在 §9 完全闭合。** `plan.md:207` 仍写“`不修 #1160 的解析故障(另开单)`”，与同一计划 §8.2 的“前置 B = FLY-2534；已有主；本单不另开单”、§10 及 F1 直接冲突，也违反 Lead `c2684bd8` 的 ownership 裁定。实现者若按“不做”清单执行，仍会得到重复开单这一错误授权。**建议：**只替换这一行，例如写成“`不改 workflow / 接收端 / publisher；解析故障由已认领的 FLY-2534 修复，本单仅把其落地作为 QA 前置`”。不要增加新工作或重述旧 `queue: max` 猜测。

## Advisory (non-blocking)

1. §2.4 已决定标签只在 `fleet-console-html.ts` 的客户端固定映射，但 §1 表头仍写“展示只在 `beta-release-management.ts`”，§4 改动清单仍写 `beta-release-management.ts sourceOrigin 投影 + 标签函数`。建议删除两处“服务端标签函数”残留；否则实现者可能建立两份词表。`research.md:36` 也保留了同一旧说法，可顺手做一致性更正。

2. §8.6 称 `covered_by_newer` 轮次的 B3 结果“必然 `not_currently_deployed`”略强：receipt 之后 updater 可能已把本机推进到那个后代 SHA。核心结论仍成立，因为该 occurrence 的 `sourceCommit !== publishedSourceCommit`，所以它本身不能作为本单的同一 SHA 对齐证据；建议用这个稳定身份事实替换时间相关的“必然”表述。

## Verdict

CHANGES REQUESTED — address blocking items above
