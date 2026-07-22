# Design Review — FLY-1380 plan.md (Round 2)
Date: 2026-07-22
Author: Codex
Status: CHANGES REQUESTED

## Summary

Round 1 的七项反馈主体都已被认真折入：两个新 v2 seed 现在满足 snapshot effort 与 cross-vendor review admission；output 改成当前 materializer 真正接受的 `docs_v1`；prototype 负向终态不再被虚构成现有能力；retire/bind、agent preflight、tier 等价口径和 dormancy 矩阵也明显更扎实。

但还不能批准。端到端复核发现，计划只打通了“producer artifact → materialized head → reviewer”，没有打通权威 PRD 要求的“artifact → founder 实际看到/试到 → 决策”。designer 的中途 mockup 只写进本地 doc path，prototype 的已审 head 只进入 terminal gate 的 head-SHA 卡片；两者都没有可执行的 founder-facing artifact delivery 合同。另有 QA seed 替换方案会破坏现有 output E2E，以及 audit rebuild 尚未明确保住 `no_replace` trigger。

## What's Good (Keep)

- **R1 三个 runtime blocker 已正确处理。** `design_iterate` 补了 effort，designer producer/reviewer 改为 Claude/Codex cross-vendor；P6 也不再止于 validator，而是要求真实 snapshot、producer/review admission 与 docs materialization 链路（`plan.md:56-59,90-111,186-197`）。
- **output 合同现在与真实代码一致。** exact-key `docs_v1`、doc allowlist、materialized head review 以及 prototype 仅承诺 doc-hostable clickable v1，均对齐 `packages/teamlead/src/workflow-docs-output.ts:92-158` 与 `packages/teamlead/src/bridge/workflow-docs-materializer.ts:199-294`；“真跑”扩面被诚实登记为 follow-up。
- **prototype 负向终态的边界写对了。** 计划不再宣称 reject/shelve 会终结 v2 run，并把 positive/negative 两终态验收列为 prototype binding 前置（`plan.md:158-161,216-217`）。
- **retire 不变量大幅加固。** actor/reason 输入卫生、确定性 refs、异常 retired-but-bound、单事务、retire 后禁止再 bind，以及 published/fresh guard 都是正确补强（`plan.md:165-184`）。
- **agent_file preflight 已改为 manifest 派生。** 当前三文件集合完整覆盖 `tpl_product_v1`、`tpl_generic`、designer 与 prototype，且明确无安装目录 fallback（`plan.md:214-215`）。
- **tier 与 dormancy 的可测口径准确。** full effective manifest 等价、不宣称 identity/digest/provenance 相等，以及 generalized on 时 direct override 合法的四格矩阵，都消除了 R1 的过度承诺（`plan.md:84-88,130-137,190-196`）。
- **两个范围加项仍然成立。** `tpl_eng_land_v1` 避免新 eng identity 在 land 路径依赖待退休旧模板；未进生产的 ops/research seed 从 bundle 退出也符合“替换/并入”产品语义，前提是按下述第 2 项精确迁移消费者。

## Issues & Recommendations (numbered)

1. **[BLOCKER] founder-facing artifact delivery 仍未闭环，当前 template 不能兑现已批准的 designer/prototype 合同。** PRD 明确要求 designer 每轮把 mockup 交 founder，并要求 prototype 由 founder 实际试用后判定（`product/doc/FLY-1396-dag-tier-binding/prd.md:561-566`）。但 P4 只说 HTML 落 doc path、“经 Lead relay”，没有规定先远程发布并把可访问 URL/visual 交给 Lead；仓库规则明确禁止把本地路径当 founder 交付（`packages/teamlead/lead-rules-base/founder-html-delivery.md:7-16`），现有 designer precedent 也要求 `publish-report`/`founder-html-delivery` 后把 URL 交 Lead（`.flywheel/agents/engineering/designer-executor.md:78-93`）。而新节点类型是 `generic`，不会自动命中 design-node 的 HTML visibility 接线。prototype 更严重：producer 结束后才 materialize/review；materializer 只 push/confirm head、不投递 artifact（`packages/teamlead/src/bridge/workflow-docs-materializer.ts:276-294`），terminal gate 卡片只有 issue、head SHA 与 approve 文案（`packages/teamlead/src/bridge/gate-materializer.ts:82-95`），founder 无法从这里“试”HTML 原型。**建议：**P4 对 designer 写死每一轮 `publish-report --publish-only`/`founder-html-delivery`、URL+visual 交 Lead、确认官方卡片已投递后才开对应 question gate，且超时仍 fail-closed；P6 增加 executor contract guard。prototype 则把“已 materialize 且 review-pass 的 exact head 中 artifact，必须以 founder 可访问 URL/visual/open instruction 投递并完成试用后才允许 terminal decision”登记为与负向终态并列的 **cutover hard precondition**，在这条交付/版本绑定能力落地前不得绑定 `prototype`。验收需钉顺序：reviewed head → founder delivery receipt（绑定同一 head/artifact digest）→ founder decision；不能用 head SHA 或本机 `open <path>` 代替交付。

2. **[HIGH] P2 对 `qa-fly-1281` 的统一 `tpl_generic` 替换在源码上不可行，且“整脚本 fail-fast”会丢掉仍有价值的 real-machine coverage。** `tpl_generic` 逐字复制 `tpl_ops_light`，没有 `produces_output`；但 `qa-fly-1281-generalized-template-e2e.mjs` 的 research 路径明确断言 output credential 存在、missing-output 409、补交 output 后完成及 restart reconcile（`scripts/qa-fly-1281-generalized-template-e2e.mjs:389-400,464-493`）。把 `tpl_research_light` 换成 `tpl_generic` 必然打破这些断言。该脚本还在 flag-off case 断言 bundled v2 seed 未安装（`:519-533`），这与 P3 的“flag off 也无条件安装发布”正面冲突。**建议：**P2 必须给出确定映射，而不是把选择留给实现时：ops/no-output 与 dispatch sentinel 用 `tpl_generic`；output/reconcile 场景改用一个明确的 output-producing test fixture（建议脚本内导入/发布专用 direct-to-gate seed，避免把多节点产品 flow 强塞进此 harness）；flag-off case 改为断言 `tpl_generic` 已发布但 start 仍因 `generalized_disabled` 409、零 run/零 spawn。保留现有 marker/replay 断言；只有已有等价 real-machine 验证并被明确点名时，才可退役对应子场景，不能用整脚本 fail-fast 代替迁移。

3. **[MEDIUM] audit rebuild 仍未明确恢复并行为验证 `workflow_template_audit_no_replace`。** 现表不只有 UPDATE/DELETE triggers；还有专门阻止显式复用 audit id 的 `workflow_template_audit_no_replace`（`StateStore.ts:2850-2855`）。P5 当前只点名 UPDATE/DELETE，并只要求这两种操作继续失败（`plan.md:184`）；DROP/RENAME 同样会丢 `no_replace`。**建议：**计划明确列出并重建三个 trigger 名称和 index，迁移测试增加 `INSERT OR REPLACE`/重复显式 id 仍被拒、原 row 不变的断言。这样才完整关闭 R1 #4 的 append-only 子项。

## Verdict

CHANGES REQUESTED — address items above
