# FLY-2900 续跑结算后的断线重启 — 实施记录
Issue: FLY-2900 (https://linear.app/geoforge3d/issue/FLY-2900/codex额度墙-撞额度墙后-held-的-run额度恢复-切号成功后自动续上换体或唤醒不再挂起等人)
日期: 2026-09-26
基于: admission-rework.md

评审 request `6191188c-ce83-40ba-bcc1-1129ca4c1f75` / question `184e95c3-e1a8-46d5-be4e-5c0e79d94a04` 在 `a354a6867dd74ec15196cadc8e3c8cee9a9657a7` 给出 CHANGES_REQUESTED。Lead 在 `e2d4e977-702f-4f06-8454-e15924cb1d32` 回复确认本轮实际是全量 merge-base 评审，要求按结论处理。本次只修新 HIGH `resumed-body-restart-refused-after-settle`；MEDIUM/LOW 留 Follow-ups。

## 根因与修复

成功续跑会关闭 standby claim。runtime 已在结算后停止转交 quota lifecycle，但 adapter 的 daemon-start gate 闭包仍传旧 authorization，onThreadReady 也仍调用已关闭 claim 的持久验证。因此之后一次普通 transport death 会变成 pre-auth 拒绝；单修 gate 又会在 durable verification 被拒。

adapter 包装同一 quota lifecycle 的两个成功信号：`onContinueProgress` 返回后，或 `onContinueReconciled` 返回 `send + settled` 后，标记本次恢复已结算。之后的 daemon 重启仍走原普通额度 gate，只是不再传旧 claim；仍核对实际 thread/model/cwd 并持久化 session，但不再回调和等待已关闭的 quota claim。尚未结算的重试、非额度的普通/rework resume 保持原门禁。

没有修改 runtime 协议、导出 API、schema、WIP checkpoint、配置或既有冲突取舍。

## 验证

- RED：真实 `CodexTmuxAdapter` + `CodexDaemonGoalRuntime` 重启循环，注入底层 transport/client/process；progress 与 reconciled 两种结算后重启都失败，pending 对照通过。先只修启动 gate 再跑，仍有两条在 durable verification 失败；随后修复第二处。
- GREEN：该 adapter 文件 184 条通过；新增六场景覆盖两种结算、pending 重试和结算后 thread/model/cwd 三种身份漂移拒绝。每次确实经过第二次 spawn 与同 thread 的严格 resume；成功结算后不重复 quota continue。
- owning package `vitest related src/CodexTmuxAdapter.ts test/CodexTmuxAdapter.test.ts --run`：5 文件，332 过、2 个环境失败。未修改的 FLY-2830 socket fixture 在 `test/codex-daemon-runtime.test.ts:1933` 的 `ownPgid` 调用 `ps` 时被沙箱拒绝 `EPERM`，均未到产品断言。该源码与测试相对评审基线无 diff；不绕过权限或修改夹具。
- 额外 runner runtime/preflight/sync-timeout/kill-inventory：4 文件 78 条通过。teardown/census/sync-marker：3 文件 14 条通过。feature-flags drift：1 文件 14 条通过。
- 相关 `bash scripts/__tests__/codex-guard.test.sh`：49 过、0 失败。
- `pnpm lint` 通过（既有 warnings）；`pnpm --filter "flywheel-claude-runner..." build` 通过。无导出、API、类型契约变化，不扩展依赖方 typecheck。
- 原 admission 返工的 related 最终为 105 文件 / 1242 条通过；此前 milestone 中的“正在验证”现已完成，原记录保留时间上下文。
- 证据目录：`/Users/xiaorongli/.flywheel/state/implement-evidence/FLY-2900/94665083-restart/`。包含红/绿、related、守卫、lint/build 日志及 full path/name/parent 的 `git grep -lF` 原始结果；375 个消费者匹配逐项保留/排除，另记 import-search 排除。

QA 负责最终头完整 CI + 两条 HIGH 回归；founder 重新批准新卡。WIP checkpoint 未改，沿用原头 529 /health ≤20 秒验收。本实现体不请求 full CI，不派 QA，不合并或部署。

## 本轮非阻塞 Follow-ups

| findingKey | 等级 | 事项 |
|---|---|---|
| fallback-prepared-blocked-by-open-rework | MEDIUM | rework 进行中的节点做兜底 prepare 会死锁：新体永远被 rework 围栏挡住，也不会回滚 |
| stale-terminal-charges-new-claim | MEDIUM | 上一次拉起留下的迟到 terminal 会记到新 claim 上：预算被重复扣，健康的新拉起被拆 |
| run-terminal-trigger-preempts-release-finalize | MEDIUM | operator terminate 时 trigger 先把行改成 released，同事务里的显式 release 因此不收尾，兜底新体没有回滚 |
| fallback-evaluator-repeats-sync-git-every-tick | MEDIUM | 兜底评估器没有 latch 也没有退避，每个维护 tick 约 3 秒一次，都在 Bridge 事件循环上同步跑整树 git |
| resume-audit-page-reads-oldest-2048 | MEDIUM | listResumeAudit 取的是最旧的 2048 行，审计表涨过这个数后，额度页和 STEP 2 的近期计数会静默变成 0 |
| resume-loop-no-single-flight | MEDIUM | resume loop 没有 single-flight，两个 tick 重叠时可能把刚 claim 的 inflight 条目删掉 |
| reconcile-unavailable-hot-relaunch-loop | MEDIUM | 对账 unavailable 后会立刻再次拉起，没有退避也不停止；reconcile_failures 从不归零 |
| same-account-generation-bump-masks-old-gen-walls | MEDIUM | reading_confirmed 在同一账号上把代数 +1，打破了 FLY-2465「旧代等于旧账号」的前提 |
| fallback-transient-start-refusal-burns-attempt | MEDIUM | 兜底体在 admission 之后遇到的瞬时 start() 拒绝仍会 revert，并消耗两次兜底机会中的一次 |
| fallback-without-process-gone-fence | MEDIUM | progress_timeout 之后，同一轮循环就可能在旧进程还活着时做 checkpoint 并 prepare 兜底 |
| wip-checkpoint-stale-lock | LOW | checkpoint 锁没有 owner，也没有陈旧回收；崩溃后该 worktree 上的所有 checkpoint 永久被拒 |
| untracked-nested-repo-becomes-gitlink | LOW | 未跟踪的嵌套 git 仓库会被 add -A 暂存成 gitlink，进入 WIP 提交 |
| success-evidence-item-denylist | LOW | 判定「首个模型产出」用的是黑名单，不是白名单 |
| host-readiness-standby-includes-resuming | LOW | host readiness 的 isQuotaStandby 也包含 resuming，会掩盖 lease_without_process |
| fallback-codex-effort-default-high | LOW | Codex 兜底冻结的 effort 与原体不一致 |
| inherited-flag-count-red | LOW | flag 总数断言红（期望 38，实际 39），继承自 main |
