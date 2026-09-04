# FLY-2293 派发同步 Linear 开工态 — 设计修正
Issue: FLY-2293 (https://linear.app/geoforge3d/issue/FLY-2293/状态可信度-派发不可靠地置-in-progress11-个在跑-runner-里-6-张单仍是-backlogstartedatnull-按)
日期: 2026-09-04
基于: plan.md（design review R4 APPROVED）

本文件只记录 R4 已批准后的非阻塞 advisory 如何落入实现；不修改已 pin 的 `plan.md`。

## `bridge-extra-env-append-collides-with-state-dir-invariant`

`FLYWHEEL_LINEAR_STARTED_SYNC=0` 只在共享 slot env 初始化中追加一次，放在 FLY-2163 的
`FLYWHEEL_STATE_DIR` 最后覆盖之前。三条 Bridge 启动分支复用同一个 `BRIDGE_EXTRA_ENV`；
不得逐分支重复追加，也不得改弱现有 state-dir 最后覆盖断言。

## `flag-env-not-registered-in-drift-guard`

在 `packages/config/src/feature-flags/exemptions.ts` 为该 QA 隔离开关登记 `qa_isolation`
exemption，并运行 config package 的 focused drift-registry test。

## `pushnotification-exactly-once-unasserted`

把 post-upsert tail 包进 `try/finally` 时删除原直线尾部通知调用。测试同时断言 happy path
与 earlier-tail-throw path 都只产生一条 `session_started` Lead event，且 starter 仍恰好执行一次。

## `outcome-payload-reason-vs-errorclass-ambiguous`

原始 `reason` 仅进入 console warning；持久化的 `linear_issue_start_outcome` payload 只允许
闭集 outcome 和稳定短 `errorClass`，不得保存 SDK error message、URL 或 GraphQL body。

## `vitest-threads-env-inert`

聚焦测试只用 `--pool=forks`、`--poolOptions.forks.maxForks=1` 与
`--poolOptions.forks.minForks=1` 限制为单 worker；删除无效的 `VITEST_MAX_THREADS` /
`VITEST_MIN_THREADS` 前缀。
