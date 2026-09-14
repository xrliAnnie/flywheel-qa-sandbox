# FLY-2555 Codex 终态缺席判定 — 探索
Issue: FLY-2555 (https://linear.app/geoforge3d/issue/FLY-2555/巡检假报修-codex-设计死体的-commdb-行带-parked-声明-窗口不解析时-reconcile-只-veto)
日期: 2026-09-14
基于: 无

目标：消除 FLY-2537 中已终止 Codex 体的 parked CommDB running 残留，避免每 tick 假报 MISSING_PANE。

用户证据：412485c1（此前 6f0390f6）在 StateStore completed，注册窗口 runner-flywheel:@2877 不存在，宿主无 execution id 进程；CommDB running、无 ended_at、仍带 parked 声明。

当前工作树 f31b75af9，implement TURN epoch=1，尚无上游文档。已通过非阻塞问题 f0f73cd0-a46b-48cb-880e-e55f2f637a0e 向 Lead 查询上游计划。

范围：仅 Codex 三证齐全时允许 executionAbsence dead 并走现有原子 finalizer；缺证据保留。Claude、FLY-1319 stale-mapping 分支、TURN 保护保持原语义。修订 FLY-2537 描述原因。实现阶段不负责 QA 调度、合并或部署。

验证必须区分单测、生产副本复现、真实宿主观测、完整仓库门禁、精确头 CI 与后续 QA 验收。
