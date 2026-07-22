# Design Review — FLY-1380 plan.md (Round 3)
Date: 2026-07-22
Author: Codex
Status: CHANGES REQUESTED

## Summary

Round 2 的三项反馈几乎全部关闭。P2 已按场景为两个 QA harness 指定可执行迁移；P5 已把 audit table rebuild 的三个 trigger 与 index 全部按名恢复并补行为断言；prototype 也同时以“负向合法终态”和“reviewed-head founder 试用投递”作为不得绕过的 cutover 前置。

现在只剩一处很窄、但位于 founder hard gate 上的命令级错配：计划写成 Runner 通过 `publish-report --publish-only` 拿到“URL+visual”，再确认官方卡片已投出；真实命令在该模式下明确不截图、不投递，返回 `screenshot:null`、`delivered:false`。计划尚未指定 Runner 如何从 Lead 获得可观察的投递确认。由于 executor contract guard 会把这段文字固化进 runtime prompt，不能带着错误能力假设进入实现。

## What's Good (Keep)

- **QA 消费者迁移现在 decision-complete。** `qa-fly-1307` 和 ops/no-output 场景迁到 `tpl_generic`；output/reconcile 场景改用 script-local、output-producing direct-to-gate seed；flag-off 断言也正确改为“模板已安装发布、dispatch 仍 `generalized_disabled`、零 run/spawn”（`plan.md:115-126`）。这保住了 marker/replay 的 real-machine 覆盖，没有用整脚本退役掩盖迁移。
- **audit rebuild 已完整闭环。** 三个 trigger 与 `idx_workflow_template_audit_template` 都被按名列出，测试包含 UPDATE、DELETE、`INSERT OR REPLACE`/重复显式 id、原 row 不变和对象存在性（`plan.md:191`），完整关闭 R1 #4 / R2 #3。
- **prototype cutover 边界清楚且可验。** 负向终态与 founder-try delivery 是并列 hard precondition；验收顺序明确为 reviewed head → 同 head/digest delivery receipt → founder decision，并禁止用 SHA 或本机路径冒充试用交付（`plan.md:223-227`）。
- **designer 的产品纪律已写进 P4。** 每轮 mockup 必须先远程发布并经 Lead 交付，收到投递确认后才开 question gate；沉默/超时不算批准。方向门、开放细节循环和 hi-fi 均复用同一纪律（`plan.md:148-156`）。
- **前两轮其余设计结论仍成立。** tier full-manifest 等价、v2 snapshot/admission、docs materialization、dormancy 四格矩阵、manifest-derived agent preflight、retire/bind fresh-eligibility 与零 binding warm 验收均保持完整。

## Issues & Recommendations (numbered)

1. **[HIGH] `publish-report --publish-only` 的真实返回与 P4 的“URL+visual/已投递确认”合同不一致，且确认通道未定义。** `publish-report` 在 `publishOnly` 分支直接返回 `url/reportId`，同时固定 `messageId:null`、`screenshot:null`、`delivered:false`，随后退出，不进入 screenshot 与 delivery 阶段（`packages/flywheel-comm/src/commands/publish-report.ts:209-246`）；专门测试也逐字段钉住这一点（`packages/flywheel-comm/src/__tests__/publish-report.test.ts:239-256`）。所以 `plan.md:148` 的“`--publish-only` 拿 URL+visual → 交 Lead → 确认官方卡片已投出”不能由该命令完成。现有 designer precedent 证明的是产品交互形状，不会改变 CLI 语义。

   **建议：**把职责与回执写成可执行的两段协议：Runner 运行 `publish-report --publish-only`，只取得 hosted URL，并验证 `url != null`、`publishOnly:true`；随后把 URL、title、artifact 标识交 Lead。Lead 再调用 `founder-html-delivery` 生成 full-page visual 并投递官方卡片。计划还必须选定一个现有的可观察确认机制，例如 Lead 对专用 `ask` 回应 `delivered`、Runner 用 `flywheel-comm check <question_id>` 读到肯定回执；或提供等价的 durable delivery receipt。只有收到该回执才开 question gate，失败/超时则 blocked/escalate。P6 contract guard 同步断言这条 **publish-only URL → Lead delivery → observable ack → gate** 顺序，并明确禁止把 `publish-only` 的 `screenshot:null`/`delivered:false` 当成交付成功。这样无需扩大 engine scope，也能真正兑现本轮想加的 hard contract。

## Verdict

CHANGES REQUESTED — address items above
