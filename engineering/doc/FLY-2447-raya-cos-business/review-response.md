# FLY-2447 Raya 统管业务 — 实施计划
Issue: FLY-2447 (https://linear.app/geoforge3d/issue/FLY-2447/rayacos-统管-leads-summaries88-日报-在新地基重排按-prd-fly-1846-的定义作为-raya)
日期: 2026-09-14
基于: plan.md

## 有效裁决与修订

原 gate `91192887-0b17-4c74-a79c-3d4b4a186f54`，有效 request `6bad0ad5-e820-4459-98a9-79c7811c1686`，R2 `reviewVerdict=CHANGES_REQUESTED` / `reviewerVerdict=CHANGES_REQUESTED`。2 HIGH，9非阻塞advisories。原R1只有no_verdict基础设施失败，未取得有效裁决；按Lead恢复指令在原gate重试时收到上述有效R2。

| findingKey | 等级 | 本v2处理 |
|---|---|---|
| roundtable-proactive-send-blocked | HIGH | plan §2.3新增B1：保留FLY-676防循环边界，现有Bridge发送+内部inbox engage，持久订阅/预算/逐消息准入、首回复补读、已发未engage恢复，明确所有消费者和测试。 |
| founder-reply-correlation-missing-replyto | HIGH | plan §2.4新增B2：可选replyTo schema从平台REST、mailbox持久化到转义render全链路贯通；§6.6引用新能力；旧envelope与错误关联反例明确。 |
| lead-rulings-not-recorded-in-plan | MEDIUM | §2.1/7/10写入两条生效Lead裁定，#71仅参考，不继承审批。 |
| founder-html-diagrams-renderable | MEDIUM | 本次sandbox失败证据保留并纠正归因；复用核验过的本地reviewer flow SVG，model仍pending，未改权限/启用远程渲染。 |
| pnpm-filter-teamlead-false-green | MEDIUM | §9修正flywheel-teamlead包名，要求核对Tests条数，零用例不是通过。 |
| chat-rate-limit-vs-report-chunks | MEDIUM | §6.5明确4片/60s、共用额度与真实retryAfterMs，持久nextAttemptAt后续做，不能紧循环。 |
| business-artifact-packaging-constraints | MEDIUM | §2/3/G明确node实际入口、零运行时依赖、dist内seed；Node exclusive-create锁及崩溃遗留锁的诚实边界。 |
| directory-projection-external-leads | MEDIUM | §2.2投影external/canSpawnRunners角色，§4.2排除external/未配置roundtable参与者。 |
| record-input-provenance-not-mechanical | MEDIUM | §2.4/N1/N6将平台属性来源与模型手写JSON区分；CLI只证明结构/状态机，persona来源纪律做端到端验证。 |
| meeting-status-planned-not-in-schema | LOW | §7使用MeetingRecord合法scheduled状态。 |
| repo-writer-default-transport-not-listed | LOW | 批次E显式移除repo-writer等默认transport（含execFile gh）。 |

这里只记录审查和设计修订，尚未实施这些通路，也未取得新一轮APPROVED。所有平台增量仍是通用能力，Raya不增加连接/驱动。下一轮使用新gate和新request；新轮身份及结果记入validation.md。


## R3有效通过

新gate `d83e628f-0669-431c-a9b0-d683cdf50383`，request `1e966c8d-75d2-4e74-9010-bd314e16da21`；2026-09-14 21:07 UTC `reviewVerdict=APPROVED`、`reviewerVerdict=APPROVED`。两项HIGH已通过。3项非阻塞advisories见review-result.json和plan Follow-ups；Lead报告receipt `76b617a0-485b-409c-8fbd-428f3f1e3052`。继续已批准设计的交付收尾，不另开评审。
