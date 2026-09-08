# FLY-2403 Astra / Fable 设计分臂 — 调研
Issue: FLY-2403 (https://linear.app/geoforge3d/issue/FLY-2403/模型ab-设计段-astra-fable-对半分流-对比台账注册-gpt-6-astra)
日期: 2026-09-06
基于: exploration.md

## 1. Model registry 权威层

`packages/config/src/model-config.ts` 每次构造 snapshot 时先加载 `packages/config/src/model-builtins.ts`，再合并 `$FLYWHEEL_MODELS_CONFIG` 或 `~/.flywheel/models.json` 的 `models` overlay，最后应用 bindings。线上 `models.json` 当前只覆盖 Fable family；它能热更新，但不是随 PR 复制的完整 registry。

因此本单把 Astra 写入 builtins，作为所有环境共同的 fail-safe 身份；live file 仍是可选 overlay 权威，未来同 id overlay 会覆盖内建字段。为防止 Astra 被误用为普通 run-level tier，它只声明 `runner`、`workflow` surfaces，不声明 `dispatch`、`lead` 或 `cron`。

现有 `codex` entry 独立存在，固定 `MODEL_IDS.CODEX_STANDARD = "gpt-5.6-sol"`。新增 `MODEL_IDS.CODEX_ASTRA = "gpt-6-astra"` 和 alias `astra`，不复用/重绑 `codex`。

Effort 口径与现有 Codex entry 对齐：workflow 允许 `low|medium|high|xhigh|max`；runner 只允许 `xhigh`。菜单中 Astra 的 `allowedEfforts` 与 Codex 一致，`defaultEffort: xhigh`。

## 2. 菜单与 HTTP 边界

`.flywheel/agents/registry.yaml` 是 graph-local 节点策略源。`code.eng_design`、`code.implement` 和 `simple_code.implement` 是三个独立 policy block；只改其中一个不会自动传播。三处都应加入 `astra` 作为可选项，但现有 node defaults 保持：design=`fable`，implement=`codex`。

`packages/teamlead/src/workflow-menu.ts#resolveMenuOverrides` 先按节点 policy 的 literal alias 匹配，再 canonicalize。合法 `overrides: {"eng_design":{"model":"astra"}}` 应生成 `{vendor:"codex", model:"gpt-6-astra", effort:"xhigh"}`，随后进入 pinned workflow snapshot 与 `dispatch_vendor_resolved` receipt。

当前未知拼写会与“已注册但该节点不允许”一起落成 `MODEL_NOT_ALLOWED_FOR_NODE`。验收指定未知 alias 仍为 `400 INVALID_MODEL`，所以验证顺序应补一层：全局 registry 查不到时返回 `INVALID_MODEL`；查得到但节点不允许时保留 `MODEL_NOT_ALLOWED_FOR_NODE`。大小写仍遵循菜单 literal alias 合同，仅小写 `astra` 是策略值。

顶层 `body.model` 只接受 `dispatch` surface。Astra 故意没有该 surface，因此顶层 `model:"astra"` 继续是 `INVALID_MODEL`；Astra 设计分臂只通过 node override。

## 3. 分臂记录与可比指标

无需新增 arm 字段：

- `workflow_execution_runtime` 是每个实际 execution 的 append-only runtime receipt，含 run/node/attempt/vendor/canonical model；它是臂归因主源。
- `workflow_run_event(kind='dispatch_vendor_resolved', node_id='eng_design')` 的 `payload.$.dispatch.model` 是同一 execution 的 immutable dispatch audit event。它只在 audited resolution path 发出，报表要求它与 runtime receipt 精确一致；缺失、冲突或同一 run 混用两臂的设计 run 会被排除并显式计入 `attribution_excluded_n`，不能静默消失。
- `workflow_run.snapshot` 是整次 run 的 pinned template/resolution，可用于人工审计，但不替代实际 runtime receipt。
- `workflow_run_node` 已有每个 `(run_id,node_id,attempt)` 的 `started_at`、`ended_at`。
- Astra/Codex author 的 request-driven 审查在 `codex_review_job`；Fable/Claude author 的 legacy 审查不写该表，而以 `design_review_manifest(execution_id, revision)` 记录每次绑定请求。两条 lane 必须 union 后再聚合。
- `workflow_run_event` 已有 `loop_iteration` / `loop_limit_escalated`，`edge_id` 能区分 `qa_retry`；founder ingress 另有幂等 `founder_feedback_kickback` event。

选用一个 `sqlite3 -readonly` 可执行 SQL，而不是新 CLI/HTML。SQL 先用 runtime receipt 将 run 归为 `gpt-6-astra` 或 `claude-fable-*`，逐 execution 校验 matching dispatch event，并排除缺 event、model 冲突或同 run 多臂的污染样本；再按 run 计算四个值，最后输出四行、两臂的平均值/总量/独立 `N`：

1. `design_review_approval_rounds`：只纳入 durable `eng_design` 完成的 execution；Astra 对每个 execution 取最终 `codex_review_job.status='done' AND verdict='APPROVED'` 的最大 `round`，Fable 对每个 execution 取 `design_review_manifest` 最大 `revision`，再按 run 求和。完成的 design node 是 legacy lane 审批已通过的持久结果；某 lane 缺自己的轮次真源时，该 run 不进本指标 N。
2. `qa_kickbacks`：至少有一个已完成 QA attempt 的 run 才进入观察窗，按 run 计 `edge_id='qa_retry'` 且 kind 为 `loop_iteration|loop_limit_escalated` 的次数；零次也计入 N。旧 `applyWorkflowLedgerBatch` 可产生没有 node/edge 的 `loop_iteration`，它无法诚实归因；相关 run 的 QA 值置空、从 QA N 排除，并计入 `qa_ambiguous_excluded_n`。
3. `founder_kickbacks`：按 run 计幂等 `kind='founder_feedback_kickback'` 的次数；零次也计入 N。
4. `design_duration_hours`：按 run 汇总所有已结束 `eng_design` attempt 的 `ended_at-started_at`；尚无已结束设计 attempt 的 run 不进本指标 N。

Founder 指标仅在至少一个 founder gate attempt 已完成后进入观察窗，避免把尚未走到 founder 的 run 当作零打回。输出同时给 `avg_per_run`、`total` 与 `n`，并重复显示 `attribution_excluded_n`、`qa_ambiguous_excluded_n`，避免只有比例、共享一个含混 denominator 或静默丢样本。按 `node_id='eng_design'` 自然排除了没有设计节点的 `simple_code`。

## 4. Lead 规则落点

`.lead/flywheel-eng-lead/identity.md` 已包含本项目 literal `/api/runs/start` payload 与 `code`/`simple_code` 选择规则，是这条项目级 founder 指令的最小落点。规则写明：每次新派单先从 Linear 重新列出同一 Epic children，并用这些 issue 已存在的首个 `code` workflow run/runtime receipt 确认此前已首次派出的数量；当前 ordinal=`已派 code children + 1`，奇数显式传 `eng_design:astra`，偶数显式传 `eng_design:fable`。`simple_code` 不计数，不依赖对话记忆，不随机，不让 Bridge 自动算序号；run 重试沿用 pinned snapshot。

HTTP `200` 本身不是成功分臂凭据。Lead 必须检查响应 `resolved.nodeModels.eng_design`：model 必须精确为预期的 `astra (= gpt-6-astra)` 或 Fable receipt，且 `overridden: true`；缺失或不符时 fail loud，不把该 issue 计作已成功派臂。

`packages/teamlead/src/workflow-menu.ts` 的 QA-vs-producer 校验，以及 StateStore admission 的 `same_vendor_review` backstop 都不需要改变。默认 implement 仍是 Codex/Sol，QA 仍是 Claude/Opus；Astra/Fable 只改变 design 节点，不触碰 QA 约束。

## 5. 测试与剩余外部证明

自动化应覆盖 registry 精确字段、三处菜单 allowlist、Astra HTTP override canonical receipt、未知 alias 的 `INVALID_MODEL`、Lead 文案合同、SQL 四项与逐项 N、两条 review lane fixture、runtime/event 不一致排除、空 edge QA 反例，以及 SQL 对 fixture DB 字节不变。现有 `workflow-menu.test.ts` 与 `runs-route.dag-entry.test.ts` 中硬编码的合法模型集合也必须更新为含 `astra`；same-vendor 组合拒绝测试继续保持绿色。

新增 root shell suite 必须在 `.github/workflows/ci.yml` literal 枚举；先验证 `sqlite3` 存在，否则 harness fail loud，并运行 `ci-shell-suite-enumeration.test.sh` 证明未落入未分类测试缝隙。

真实 `gpt-6-astra` business 会话权限已由 Lead 在本单输入中给出证据。`POST /api/runs/start` 真阳性必须等本 PR 合入并由 updater 激活新 registry 后，用一张后续 `code` issue 作为奇数臂跑完 design；implementation 节点不部署、不派 DAG successor，故把该项明确留给独立 QA/运营验收，不以本地 mock 冒充。
