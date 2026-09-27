# FLY-2900 QA 路由返工：合入 main — 实施记录
Issue: FLY-2900 (https://linear.app/geoforge3d/issue/FLY-2900/codex额度墙-撞额度墙后-held-的-run额度恢复-切号成功后自动续上换体或唤醒不再挂起等人)
日期: 2026-09-26
基于: restart-rework.md

QA@1 claim 1658 是合入冲突导致的 routing qa_fail，不是产品缺陷。Lead 在 question `28583bfb-d200-43d2-91fc-32610ed98f1c` 明确授权：merge origin/main，只解 feature-flags-registry 总数断言冲突，保留两边 EXPECTED_WHEN_ON 条目，自动合并重叠文件跑相关验证。本次 TURN implement epoch12 / attempt2，activation `activation:rework:469ecba4ba99694eab148d662cad987058d408096774639ccb4fcb1c61b1ac40`。

## 合并与取舍

从 `c7c92f5d27af0dc48627387248a405e272c9d668` 合入 `origin/main fdd1b404d40129f9e5345d325f1c687e52a682e9`，merge commit `7bdfd4c2545352617c37bf46e111a675efbbcd25`。没有 rebase 或 force-push。

唯一手工冲突为 `packages/config/src/__tests__/feature-flags-registry.test.ts`：删除本分支 `expect(FEATURE_FLAGS).toHaveLength(38)`，采用 main/FLY-2934 的删除；保留本分支的两个 quota flag 与 main 新增 `lead_alert_wake_dedup` 文案条目，并继续用完整 EXPECTED_WHEN_ON 映射校验。旧 main 总数继承红在上游已修。

自动合并重叠文件：config `feature-flags/registry.ts`、`feature-flags-drift.test.ts`；teamlead `StateStore.ts`、`bridge/flag-store-runtime.ts` 及测试、`bridge/plugin.ts`。main 的告警去重 schema、flag 及 LeadInboxRuntime dispatcherUserId 注入与本单额度待命路径同时保留。没有额外改动产品代码。

`git diff c7c92f5d2 HEAD --` 验证 CodexTmuxAdapter 源码/测试、standby-resumer、workflow-same-execution-relaunch、WIP checkpoint 无差异。两条 HIGH 修复和原 WIP 529 /health ≤20 秒判据保留。

## 验证与交卷

合并后的 config focused 3 文件/94 条通过，config related 21 文件/388 条通过；lint（既有 warnings）、teamlead 及依赖 build、12 个依赖方项目 typecheck 通过。额外静态守卫 42 文件/407 条、6 个相关脚本套件、额度重启定向8条、进程清册5条、新合入mailbox去重26条均通过。Lead 在 `aa2397d3-6d11-4df3-8c3c-e156f414c9c6` 明确批准停止 StateStore 广图，只保留受合并影响的 alert-wake-dedup / StateStore.alert-wake-dedup / flag-store / lead-inbox 测试、两条 HIGH 的33条回归和 fly663 sparse迁移；完整图交QA full CI。广图进程已通过原工具session18963中断，部分日志仅存档，不记作整套通过。最终11个定向文件/306条全部通过（含准入33条及fly663 sparse迁移）；全部指定验证现已完成。

证据：`.flywheel/state/implement-evidence/FLY-2900/epoch12-merge/`，包含唯一冲突的 remerge diff、自动合并 diff、测试日志及 full path/name/parent 逐项消费者处置。合入 main 的历史证据文件 `engineering/doc/FLY-2910-alert-wake-dedup/evidence/review-r1-tdd.txt` 原有 EOF 空行在 diff-check 报告中保留，不改上游文档。

新头需推送后取得 scoped 合并复审 APPROVED，再 complete --route needs_review --pr 1354。实现体不请求 full CI；QA 承接新头 full CI、重叠处与两条 HIGH 回归。非阻塞 advisories 保持已报告的后续范围，本轮不扩展实现。
