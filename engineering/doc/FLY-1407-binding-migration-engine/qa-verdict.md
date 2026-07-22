# FLY-1407 QA 独立验证 — 判定记录

Issue: FLY-1407 (https://linear.app/geoforge3d/issue/FLY-1407/enginebinding-migration-1396-addendum-引擎面落地v2-入口三件套keylessflag-offauth)
日期: 2026-07-22
基于: fly1385-addendum.md(契约唯一权威副本)+ plan.md(§4 契约→实现+测试映射)+ PR #670

## 结论:FAIL(缺口=测试映射未达承诺锚点;实现本身经通读验证正确)

真实 scope:merge-base(origin/main)= d817eff2(=FLY-1392 #661),故 FLY-1407 真实改动 = 单一 feature commit 7bac8dfe(43 文件、~3150 插入)。188 文件/22937 是 stale local main 噪声(FLY-1392 receipt-foundation),已剔除。

### 已验证通过(强证据)
- 契约→实现 逐条通读:work-kind.ts / runs-route.ts / StateStore.ts(+621)/ workflow-template-selection.ts / three-stage-config-source.ts / workflow-route-reminder-drain.ts / ConfigLoader.ts / kind-contract.ts / LeadAlertNotifier.ts / lead-alert.sh / three-stage-policy.ts —— 实现面零静默 descope。①-⑤ 每条要么 🔨 实现+测试,要么 📤 显式交 named receiver(FLY-1380 binding 写入 / cutover 单 / Gemini schema / prompt 资产),后者是 codex-design-approved 的合法 phasing。
- 我自己跑:teamlead 169 route/unit 全绿;config 122 全绿;edge-worker 54 全绿;teamlead build exit 0;PR #670 CI 全绿。
- 测试是真·能力级(real better-sqlite3 StateStore + real Express router + real drain),非 vacuous:store-spy 证 generic fallback 不查 binding;bypass 零 workflow_run;summarize 分母正确排除 override/rejected/fallback。
- 故障注入到位:crash-window rebuild(D2b,replay 同构 200 + Runner 只起一次 + 单 decision)、TOCTOU flag-flip(D1c,WORK_KIND_ENTRY_NOT_MATERIALIZED,不落 silent legacy)、at-least-once redrive(D11a,per-attempt eventId dedup#1/#2,duplicate≠delivered)、retired-template dedup(2 请求 → 恰 1 decision + 1 outbox)。

### FAIL 依据(测试映射 vs 承诺锚点的缺口;均经我自己 grep 复核 = 零 test 引用)
1. WORK_KIND_ROUTE_DECISION_CONFLICT(409 digest-mismatch)+ legacy 路径的补偿动作 casLaunchClaimState(starting→cancelled)—— 零覆盖。补偿性 side-effect 未验证(verify-at-destination 红线)。
2. WORK_KIND_ROUTE_LAUNCH_EVIDENCE_MISSING(409)—— 零覆盖。
3. INVALID_ROUTING_OVERRIDE 的 route 面(400 + rejected 收据 + outbox)—— 无 route-level 测试(仅 canonicalizeRoutingOverrides 纯函数单测),违背映射行 ①.1-invalid「全部提醒臂码逐一测」。
4. ③.0「templateId retired → pinned recovery 照读」—— recoverWorkflowStartSelection 从无任何测试调用;该 must-hold 不变式仅靠代码通读,无回归守卫。
5. INVALID_TASK_CATEGORY / INVALID_TIER / TIER_NOT_SUPPORTED 的 route 测试只断言 status/code/零 Runner,未断言「恰一 rejected 行 + 恰一 outbox 行」(仅 TEMPLATE_NOT_FRESH_ELIGIBLE 做了完整检查)。plan §5.11「5 码逐一同时断言…恰一 rejected 行 + 恰一 outbox 行」未达。
6. ROUTING_CONFLICT_CONFIRM_REQUIRED 只测 taskCategory+override,未测 templateId+override 分支(同一 OR 守卫)。

### 边界说明(非 FAIL 依据)
- 隔离房 live 真-tmux + 真-Discord E2E 未跑:work_kind 路径是 founder-gated(cutover 单 + FLY-1380 前,生产无法激活);且 FLY-1407 不改 tmux-spawn / Discord-transport 代码,FLY-1407 专属风险面全在 router/StateStore/drain 层(已 real-DB E2E 覆盖)。此项作为 boundary 交代,不构成 FAIL 依据。
- codex CODE review:PR 自报「APPROVED on e6270f87」(=HEAD 代码,e6270f87..HEAD 仅 progress.md),但仓内无 codex-review artifact;以我自己的全量通读 + 全绿 CI 作 code-quality 实证。设计面 codex-approved(R5)已独立确认。

### 修复方向(小而精,补齐即可重 QA)
补 route-level 测试:INVALID_ROUTING_OVERRIDE 400+收据+outbox;WORK_KIND_ROUTE_DECISION_CONFLICT 409+casLaunchClaimState cancelled 回滚;WORK_KIND_ROUTE_LAUNCH_EVIDENCE_MISSING 409;retired-template 下 recoverWorkflowStartSelection 照读回归;3 个 reject 码补「恰一 rejected 行 + 恰一 outbox 行」;ROUTING_CONFLICT templateId 分支。
