# FLY-2550 Lead thread 轮换 — 设计纠偏
Issue: FLY-2550 (https://linear.app/geoforge3d/issue/FLY-2550)
日期: 2026-09-14
基于: plan.md

按 FLY-1404 记录批准设计后的增量纠偏；plan.md 保留为历史设计。

## 废除概念

废除 launcher 环境变量产品开关 `FLYWHEEL_CODEX_LEAD_THREAD_ROTATION`。v4 对 memory-distill 开关的类比已过时：该开关已经迁入 SQLite。不得保留环境变量兼容读或新增 exemption。

## 保留器官

保留轮换算法、attempt 写入顺序、liveness fence、backoff、readiness 和 off guard。只将启用状态来源迁到现有 registry + codec + named wrapper，项目级、默认开启。按每个 generation 启动读取；项目行优先于 `*`，再回退注册默认值。已启动的 generation 不受本次修改中断；开关变更在下一 generation 生效，与原启动开关边界一致。只读打开现有 StateStore，不创建/迁移生产数据库；读取失败关闭本 generation 的轮换，保留正常 Lead 启动。

## 评审与 CI 证据

HEAD c6c376f021a24a4d50a2b8adbcd85ac23d69b957 的代码评审有效 APPROVED（9ce3f664-34db-4385-b3c8-a8b1c8cac0dc），2 MEDIUM / 3 LOW advisories 已报 Lead；后续裁定要求本次修两条 MEDIUM，三条 LOW 留 follow-ups.md。CI 34919031532 有真实断言失败：开关 authoring/drift 校验与 kill-path 清单 682→683；全部 Teamlead 分片、shell 分组通过不能覆盖 aggregate red。

## Lead 裁定原文

问题 f3eca09f-9116-4abc-9d73-b9c48b835f24：

> Design correction CONFIRMED: replace the env product switch FLYWHEEL_CODEX_LEAD_THREAD_ROTATION with the existing SQLite flag registry + codec + named-wrapper path, PROJECT scope (consistent with codex_memory_distill), default ON, rotation algorithm unchanged, no new exemption and no second channel; update rollback docs/tests accordingly. Record it in design-correction.md per the design-correction contract: abolished concept = launcher env switch (v4 analogy to a since-migrated flag was stale); retained organs = rotation algorithm, attempt ordering, liveness fence, backoff, readiness/off guard. Sequencing: keep HEAD c6c376f02 frozen until active review 9ce3f664 returns; then ONE push containing (1) the registry flag change + tests, (2) the kill-path inventory regeneration for the 682->683 delta, (3) any blocking review findings; milestone-last; then ONE fresh exact-head review and exact-head CI. No host full package suites.

## Lead 后续裁定

问题 b8bef3ea-a2bf-4cf4-a904-2c16c273da94：

> Follow-up decision: since a push is already required, fold the two MEDIUMs into that SAME single push — kill-missing-window-blocks-rotation (an absent pane must count as already-killed and let rotation proceed) and fence-unexpected-throw-stalls-router (the second journal count must not throw the router into a stall; catch and mark the attempt failed with backoff). The three LOWs go to follow-ups.md only. So the one push = SQLite flag correction + design-correction.md + inventory regeneration + these two MEDIUMs, milestone-last; then ONE fresh exact-head review + CI. Nothing else in scope.

fence 内异常新增 `rotation_failed:fence_error` 结果；正常清理 pending 后释放路由并恢复 pane，维持六小时退避。若已落盘 pending 又无法清除，保持原有 fail-closed fence，错误日志可见，避免旧输入与未来 pending 重建并发。

## R2 docs-only correction authority

Lead question response `78dacdf5-c82f-417e-9e83-74ed1a2e8cc5`:

> founder-doc-still-names-abolished-env-switch — fix it now, docs-only: regenerate the founder HTML/template + d3 rollback diagram so they describe the SQLite flag (no env switch), republish the founder HTML (publish-only, verify HTTP 200 + nonce), commit as a docs-only follow-up in the same PR after the current CI finishes, milestone literal last; no new review round for a docs-only delta (same rule as 1945/1948).

其余 R2 两条建议仅记入 follow-ups.md；最终 HEAD CI green 后按 needs_review 交接 PR #1203。
