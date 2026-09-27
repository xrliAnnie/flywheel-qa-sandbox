# FLY-2900 准入延迟不耗尽续跑预算 — 实施记录
Issue: FLY-2900 (https://linear.app/geoforge3d/issue/FLY-2900/codex额度墙-撞额度墙后-held-的-run额度恢复-切号成功后自动续上换体或唤醒不再挂起等人)
日期: 2026-09-26
基于: plan.md

Lead 本轮授权只修 `resume-transient-admission-counted-mechanical`，基线为已推头 `6da64a8b8c63fd3eb226c82d25e439bfe55f39c0`。原 scoped review request `5f5a041d-c987-41bb-a3dc-3ad565f65f0b` / question `9a10f466-36dc-4350-a232-5be20a914004` 的有效结论为 CHANGES_REQUESTED；其余 6 条为非阻塞 follow-ups。

## 根因与修复

`relaunchSameWorkflowExecution` 原来把 `startDispatcher.start()` 的所有异常压成普通失败；`standby-resumer.launch` 再统一调用 mechanical fail。两次 deploy/pressure/DOA/shutdown 延迟后，真实 fallback evaluator 会把原 thread 换成新体。

共享 relaunch 只在 `start()` 的拒绝边界识别 `AdmissionDeferredError`、`DoaBackoffError`、`CodexQuotaQueuedError`、精确 shutdown 消息以及已有 `admissionBrake` 标记，并保留为结果元数据。启动后身份/首产出异常仍按既有失败语义处理。resumer 使用现有 neutral CAS 回到 standby，保留 continue id、execution/thread、permit 和机械/兜底预算；审计原因记 `admission_brake`。

退避至少一个 15 秒 evaluation 周期；dispatcher 给出的正有限 `retryAfterSeconds` 更长时使用该值。退避只属于当前 entry，关闭/释放/entry 更换后清理；不设有限重试次数。与引擎 admissionBrake 一样，Bridge 重启后由常规维护 tick 重新检查准入。现有清理与重认领围栏保持不变。没有 schema、WIP checkpoint、配置默认值或冲突合并取舍变更。

## 验证

- RED：真实 relaunch + 真实准入错误类 + StateStore + fallback evaluator；7 个场景均复现 `mechanical_failures=2`、`fallback_attempt=1`、`state=fallback_prepared`（旧测试 10 条仍过）。
- GREEN：新增 quota queued 覆盖，8 类拒绝各经历两次延迟，检查退避边界前不重试、两种预算不变，随后原 execution/thread 恢复；负例覆盖真实 spawn 异常及启动后身份错误不被归为准入刹车。
- 已完成：核心两个文件 33 条通过（resumer 18 + shared relaunch 15）；fallback 与 teardown/census/sync-marker 四文件 30 条通过；lint（既有 warnings）、teamlead 及依赖 build、teamlead/voice-codex 两项目 typecheck 通过。冻结头时 `vitest related` 仍在执行，最终结果补到 PR/交卷回执，不移动已评审头。
- 完整命令和结果见本机证据目录 `/Users/xiaorongli/.flywheel/state/implement-evidence/FLY-2900/94665083-admission/`。`consumers.json` 是逐文件 full path/name/parent 的 `git grep -lF` 输出，`consumer-exclusions.tsv` 逐项记录排除理由；直接 import 另由 `rg` 与 `vitest related` 覆盖。
- 本轮不请求 full CI；QA 在最终新头运行完整 CI + 该回归，founder 需重新批准新卡。WIP checkpoint 未变，沿用原批准头的 529 /health ≤20 秒验收。

## PR Follow-ups（Lead 明确不在本轮实现）

| findingKey | 等级 | 后续事项 |
|---|---|---|
| resume-success-voided-by-later-wall | MEDIUM | 将成功结算与后续无关撞墙作废 permit 的影响分开 |
| fallback-without-process-gone-fence | MEDIUM | reap 未证完成时，持久阻止 checkpoint/替身并发写者 |
| wip-checkpoint-stale-lock | LOW | checkpoint 锁的 owner 与陈旧回收 |
| capacity-rejection-unbounded-relaunch | LOW | 读数与执法不一致时 capacity rejection 退避 |
| wip-checkpoint-tests-near-timeout | LOW | 真实 git 测试的超时余量 |
| inherited-flag-count-red | LOW | main 继承的 flag 总数差一由 FLY-2934 修；本轮不改 |
