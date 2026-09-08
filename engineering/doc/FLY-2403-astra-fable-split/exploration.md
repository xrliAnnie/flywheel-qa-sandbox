# FLY-2403 Astra / Fable 设计分臂 — 探索
Issue: FLY-2403 (https://linear.app/geoforge3d/issue/FLY-2403/模型ab-设计段-astra-fable-对半分流-对比台账注册-gpt-6-astra)
日期: 2026-09-06
基于: 无

## 目标与锁定边界

Founder 要在正常工程派单中积累可比较的设计样本：同一 Epic 内，`code` 工作流按首次派单顺序交替把 `eng_design` 放到 Astra 与 Fable，两臂之后继续走同一套实现、QA、founder gate。Astra 必须是独立 alias；既有 `codex` 仍解析到 `gpt-5.6-sol`。

本单不实现随机分桶或自动分配器，不增加 A/B authority 字段，不改变 merge/approval 权限，不改变 QA 与直接 producer 不得同 vendor 的约束，也不把没有设计节点的 `simple_code` 纳入实验。

## 已明确的假设

- “奇 Astra、偶 Fable”只计算同一 Epic 中实际以 `taskCategory: "code"` 首次派出的 issue；`simple_code` 不计入序号。
- 只交替覆盖 `eng_design`。`implement` 继续默认 `codex`，但策略允许人工选择 `astra`，满足模型可派范围；这样 `qa=opus` 与默认 implement 仍跨 vendor。
- 一次 run 的 pinned snapshot 决定后续重试所用模型；同一 run 不重新抽臂。
- 对比以 run 为样本单元。每项单独报告可用样本数 `N`，零次 QA/founder 打回也进入计数指标的分母。
- 本 implementation 节点交付可执行的只读报表与自动化证明；至少一个真实 Astra 设计节点完成属于合并并启用后的后续 QA/运营阳性对照，本节点不部署或代替 DAG 调度器派后继 issue。

## 方案比较

### 方案 A（采用）：内建注册 + Lead 显式交替 + 事件派生只读 SQL

在内建 model registry 注册 `astra`，在 `code` 菜单的 `eng_design` 与 `implement` allowlist 加入它；Flywheel Lead 的项目身份规则负责按 Epic 序号显式传 `overrides.eng_design.model`。报表只读 `workflow_execution_runtime`、`dispatch_vendor_resolved`、两族各自的 design-review ledger、`workflow_run_event`、`workflow_run_node`。

优点是代码发布即可获得 fail-safe 注册，线上 `models.json` overlay 仍可热更新其他模型；实验规则可见且不引入新的状态权威；报表的臂归因来自实际 runtime receipt，并与 dispatch event 交叉核验。缺点是 Lead 每次派单前必须从 Linear Epic children 与已有 run/runtime receipt 重建序号，不能依赖对话记忆。

### 方案 B：只改 `~/.flywheel/models.json` + 新 `flywheel-comm` 报表子命令

热生效更快，但 live home 不随 PR 复制，重装或缺文件时 Astra 消失；新增 CLI 扩大了兼容性和消费者测试面。它不适合作为本单唯一交付。

### 方案 C：Bridge 自动分桶并持久化 arm

自动化程度高，但需要 Epic membership/ordinal authority、新 schema 与重排语义，直接违反“Lead 侧、不进引擎、不新造 authority 字段”的边界，因此排除。

## 设计结论

采用方案 A。模型注册、菜单 allowlist、Lead 人工规则和只读 SQL 四块相互独立：registry 负责 alias→canonical；菜单负责节点可选集合与 effort；Lead 只决定本次 `eng_design` override；报表只消费已有不可变 receipt 与生命周期行。Codex/Astra 设计审轮次来自 `codex_review_job`，Claude/Fable 设计审轮次来自 `design_review_manifest`，避免把单一 reviewer family 的表误当成跨臂真源。任何未知 alias 在 HTTP 边界保持 `400 INVALID_MODEL`，已注册但不在该节点 allowlist 的模型仍报节点策略错误。
