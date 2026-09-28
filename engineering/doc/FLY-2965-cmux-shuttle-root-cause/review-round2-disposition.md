# FLY-2965 第二轮评审处置 — 实施计划
Issue: FLY-2965 (https://linear.app/geoforge3d/issue/FLY-2965/病根-定时班车-restart-servicessh-的非生产-tmux-残留只读审计对-tmpcmuxsock-跑-list)
日期: 2026-09-27
基于: plan.md

R2 effective CHANGES_REQUESTED，request 742caa90-6a3b-46e1-9900-bbafe601263c；原始裁定存evidence/review-round2.json（已去deliveryNonce）。

| findingKey | 当前处置 |
|---|---|
| single-batch-drops-convergence-wait | HIGH已按Lead新裁定修订。已核FLY-2643 plan147-149和restart-services.sh现有barrier注释，异步refresh尚未完成时首批失败不是终态。建议保留只对未pass目标的共享批次收敛重试，仍用原1320s deadline与carrier预留；不恢复逐目标全局扫描。Lead在问题6b8154c1-6b34-4c1c-a79d-7c2e3b667293明确撤回旧要求，允许此必要重试；R3纳入每批2W/已pass不重复判定/首批全绿立即结束/迟到收敛清marker验收，不需要review-ruling。 |
| admission-resume-exit-retry-nonexistent | 已核restart_on_exit没有resume。修正文档：诊断结束后lease仍在且owner允许时调用原resume一次，失败或异常退出沿用原1800s TTL；不新增EXIT机制、循环或恢复cutover owner。F增加首次失败负控。 |
| batch-timeout-status-mapping | 批次rc124/不完整JSON明确unproven/batch_timeout，不消费部分pass；既有单目标rc124 fail/visibility_timeout不变。J增加负控。 |

R3已解决HIGH范围冲突，待新有效评审；不可实施。
