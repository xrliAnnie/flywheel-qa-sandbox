# FLY-2307 launch episode 收口 — 实施计划
Issue: FLY-2307 (https://linear.app/geoforge3d/issue/FLY-2307/病根-ship-完成后-launch-投递契约-episode-停在-received-永不关闭反复升级到-severe-告警而活早已干完)
日期: 2026-09-03
基于: research.md

## 目标

把两侧边界固化为 executable regression：A 是 FLY-2270 的精确清理后形状——launch attempt 的 binding/session 已消失、open received episode 的 `run_id` 为 NULL，但 durable attempt ref 仍指向 completed run；B 是 run 仍 active 的真实 received stall。A 必须在 projector pass 中 settle/close 且不再升级，B 必须保持 live、warning 和 severe 都照常发生。

## 锁定范围

### 做

- 修改 `packages/teamlead/src/__tests__/fly2248-r6-projector-recovery.test.ts` 中已有 native launch terminal test。
- 保留真实调用顺序：`DeliveryProjector.runPass()` 后 `DeliveryContractWatch.runPass()`。
- A 加入现场四个前置事实的断言：run completed、node done、binding absent、session absent；episode 为 received 且 `run_id IS NULL`；attempt ref 仍带 exact `runId`。
- 保留并收紧结果断言：attempt `settlement_reason='run_terminal'`、episode `closed_reason='terminal:settled:run_terminal'`、watch `observed=0`。
- B 把相邻 active launch control 收紧为 received-stage warning→severe：projector 不 settle，episode 始终 open 且 run-bound。
- 做两次 negative mutation control：删除 `ref.runId` fallback 时 A 红；删除 terminal-status protection 时 B 红。每次随后逐字恢复生产文件并重新跑绿。

### 不做

- 不改 `StateStore.ts`、`watch.ts`、schema、migration 或生产数据库。
- 不回填历史 episode 的 `run_id`；部署后的 projector convergence 会关闭它们。
- 不改变 active/held run、FLY-2115 granted stall、其他 delivery family 或 alert 文案。
- 不新增 dependency、helper、fixture framework 或配置开关。
- 不部署、不 dispatch QA、不 merge。

## 为什么是 test-only

`069013b25` 已经实现并进入当前分支：

1. launch `session_started` 立即 settle；
2. terminal reconciliation 在 binding 已清理时 fallback 到 `contract_ref_json.runId`；
3. projector 在 watch 前运行；
4. live DB 副本已经证明 FLY-2270 会被 current HEAD 收口且不会再产生 target unbound alert。

再写一份 watcher guard 或 episode migration 是重复状态逻辑，不符合 Ponytail 的第一层 YAGNI。FLY-2307 的新增价值是防止现有修复在缺少 exact cleanup-shape test 的情况下回归。

## 实施步骤（TDD）

### M1 — A：terminal run 防噪

在现有 “settles a native launch obligation when its owning run completes” test 内：

1. 继续用 public API 创建 run 和 launch attempt。
2. 将 attempt 的 `received_at` 设为确定时间，让 watch 先创建一条 received episode。
3. 将 run 设为 completed、node 设为 done，删除 execution binding；断言 `getSession(executionId)` 与 `getWorkflowExecutionBinding(executionId)` 均为空。
4. 将既有 open episode 的 `run_id` 设为 NULL，回读断言 `{stage:'received', run_id:null, closed_at:null}`。
5. 回读 attempt `contract_ref_json`，断言 `{table:'workflow_execution_binding', pk:executionId, runId}` 不丢。
6. 运行 projector：断言 `advanced=1` 且 target 不再 live。
7. 运行 watch：断言 `{observed:0, opened:0, closed:0, alerted:0}`。
8. 回读 episode：断言在 projector 时间闭合，reason 为 `terminal:settled:run_terminal`。

只扩展现有 test，不新建文件、不抽 helper。

### M2 — B：active run 防瞎

收紧相邻 “keeps a native launch obligation open while its owning run is active” test：

1. 用 public API 创建 active run 和 launch attempt。
2. 把 attempt 推进到 `received`，但不产生 consumed/settlement。
3. 依次执行 projector 与 watch：projector `advanced=0`；在 received deadline 后 watch 创建 warning episode。
4. 在 severe deadline 后再跑 watch：同一 episode 仍 open，`severe_alerted_at` 被写入，warning/severe 两条 outbox 都存在。
5. 断言 episode `run_id` 等于 active run，attempt 仍在 live list。

这格禁止使用 terminal fixture；否则无法证明真正卡住的 launch 没被吞。

### M3 — 红绿与双变异证据

因为修复已在 branch baseline 中，正常 test-first 会直接为绿。用受控 mutation 证明判别力：

1. 记录 `projector.ts` 修改前摘要。
2. A mutation：临时移除 owning-run 选择中的 `ref.runId` fallback，只保留 authoritative source 与 episode fallback。只跑 A，必须因 binding absent 而失败，失败应指向 attempt 仍 live / projector `advanced=0`。
3. 恢复并断言摘要；A 重跑绿。
4. B mutation：临时把 projector 的 `workflowRunIsTerminal(run.status)` 条件改为无条件 true（等价于删除 active protection）。只跑 B，必须因 active attempt 被提前 settle 而失败，且 warning/severe 不会出现。
5. 再次恢复并断言摘要；B 重跑绿。
6. 跑整个 `fly2248-r6-projector-recovery.test.ts`。

mutation 不提交。任一 test 在对应 mutation 下仍绿，说明测试没有锁住该边界，必须修 test 后重做。

### M4 — 受影响面验证

- `pnpm --filter flywheel-teamlead test -- src/__tests__/fly2248-r6-projector-recovery.test.ts`
- `pnpm --filter flywheel-teamlead test -- src/__tests__/fly2248-delivery-transition-table.test.ts src/__tests__/fly2278-settle.test.ts`
- `pnpm --filter flywheel-teamlead typecheck`

active launch control 必须继续 live 并从 warning 升到 severe；projector→watch ordering mechanism guard 必须保持绿。

### M5 — 全仓门与评审

按实现节点合同执行：

- `pnpm lint`
- `pnpm -r build`
- `pnpm test:packages:run`
- 运行所有新增 `scripts/__tests__/*.test.sh`（本单预计无新增 shell test；若 diff 为空则记录 none）。
- 通过 `codex:rescue` 形状执行 code review，随后按 injected protocol 开 `review_code` gate、`request-review --type code` 并轮询 verdict。
- HIGH finding 必须修复并重新开新 gate；APPROVED advisories 报 Lead。

## 验收标准

1. 测试前置状态同时证明：`received` open episode、episode `run_id=NULL`、binding/session absent、run completed、node done、attempt ref runId present。
2. current HEAD projector 单 pass 后：attempt 不在 live list，`settlement_reason='run_terminal'`，episode 关闭 reason 精确为 `terminal:settled:run_terminal`。
3. 同时间随后的 watch 对 A target 零观察、零新开、零升级。
4. B 的 active received launch 在 deadline 后开 warning、severe deadline 后同一 episode 升级；attempt/episode 均保持 live/open。
5. 删除 `ref.runId` fallback 的 mutation 让 A 红；删除 terminal-status protection 的 mutation让 B 红；每次逐字恢复后对应测试转绿。
6. 其他 settlement suites、typecheck 和全仓三门通过。
7. diff 不含生产逻辑、schema、dependency、`CLAUDE.md` 或生产状态写入。

## 提交与交接

1. 提交 docs + reviewed plan。
2. design review APPROVED 后提交 test change。
3. code review APPROVED 后 push feature branch，创建 PR。
4. literal last commit 新建 `engineering/doc/milestones/FLY-2307.md`，其中如实写明 production fix 已由 ancestor `069013b25` 提供，本 PR 增加 exact regression。
5. 完成路线：`complete --route needs_review --pr <NUMBER>`。不请求 ship approval，不 merge。

## 回滚

本单唯一行为变更是测试增强。回滚只需 revert 该 test diff；生产运行时不受影响。若后续发现 ancestor fix 不足，另开基于新证据的 production patch，不在本单预埋 speculative branch。
