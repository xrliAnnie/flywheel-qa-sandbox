# Design Review — FLY-1380 plan.md (Round 4)
Date: 2026-07-22
Author: Codex
Status: APPROVED

## Summary

Round 3 的最后一项已正确关闭。P4 现在把 founder artifact delivery 拆成与真实能力一致的两段协议：Runner 的 `publish-report --publish-only` 只负责取得并校验 hosted URL；Lead 独占 `founder-html-delivery` 的 visual + official-card 投递；Runner 再通过现有 `ask → check` 通道读取明确回执，只有成功回执后才打开 question gate。失败、无回复和 gate timeout 均 fail-closed。

完整重读后未发现新的阻塞问题，也未发现前几轮合同回退。计划在 feasibility、completeness、correctness、risk、scope、sequencing 与 codebase consistency 上已经足够具体，可以进入实现。

## What's Good (Keep)

- **投递协议与 CLI 真实语义一致。** 计划明确承认 `publishOnly:true` 固定不截图、不投递，不再把 `screenshot:null` / `delivered:false` 误判为成功；这与 `packages/flywheel-comm/src/commands/publish-report.ts:209-246` 及其逐字段测试一致（`plan.md:148-154`）。
- **回执面可执行且 fail-closed。** `flywheel-comm ask` 返回 question id，`flywheel-comm check <question_id>` 能区分 pending/answered 并返回 Lead 内容（`packages/flywheel-comm/src/commands/check.ts:10-29`）。executor 明确轮询而不是依赖 mailbox wake，并在投递失败/超时后 blocked/escalate，符合 generic executor 已有的 ask/check 使用模式。
- **职责边界清楚。** Runner 只发布并把 URL/title/artifact id 交 Lead；Lead 通过全局 `founder-html-delivery` 规则完成 founder-facing full-page visual 和官方卡片。Runner 不直发 founder，本地路径也不会被冒充成可访问交付。
- **合同守卫钉住了正确顺序。** P6 要求 `publish-only URL → Lead delivery → observable ack → gate` 的有序锚点，并显式防止未来把 publish-only 的空 screenshot/delivery 字段重新解释成投递成功（`plan.md:210`）。
- **此前的 runtime 可行性问题保持关闭。** 新 v2 seed 的 effort/cross-vendor admission、`docs_v1` materialization、reviewed-head 消费、manifest-derived agent preflight 和 prototype 两条 cutover hard precondition仍完整。
- **迁移与 dormant 边界保持稳健。** QA harness 已按 output/no-output 场景精确迁移；audit rebuild 恢复三个 trigger 与 index；retire 后 rebind 被封住；warm/restart 验收继续要求 binding 逻辑行集与 audit 计数零变化。
- **范围控制合理。** 本单仍然只创建并发布 dormant identity、补 retire write seam 与必要守卫，不写 live work-kind binding、不翻开关、不夹带 cutover 或尚未具备的 prototype engine 能力。

## Issues & Recommendations (numbered)

无阻塞项。实现完成后按 P6/P7 跑完整测试与生产形状验收即可。

## Verdict

APPROVED — ready to implement
