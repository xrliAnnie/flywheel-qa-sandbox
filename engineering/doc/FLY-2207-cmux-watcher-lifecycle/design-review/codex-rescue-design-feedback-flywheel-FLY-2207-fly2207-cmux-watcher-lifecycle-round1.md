# Design Review — plan.md FLY-2207 cmux-watcher-lifecycle (Round 1)

Date: 2026-08-31
Author: Codex
Status: CHANGES REQUESTED

## Summary

方向基本正确：T1 修正 heartbeat 语义、复用既有 escalation face、保持 FLY-913 判定矩阵不变，都对准了 8-31 事故链。当前计划仍会在 maintenance park、瞬态 bootstrap 失败和 QA 隔离三个场景重新制造生命周期风险，且 T2 的 bootout/残影信号机比仓库现有的原地 kickstart 模式更复杂、更不安全。本轮执行的现有 shell 基线均通过（restart 17/17、guard 282/282、autostart 6/6）；TypeScript focused suite 因 checkout 未安装 `vitest` 未能执行，相关结论来自源码和测试静态核对。

## What's Good (Keep)

- T1 在 `_cmux_bounded_spawn` 的完成出口刷新既有三字段 heartbeat，直接修复“睡眠时心跳、干活时失联”的双语义冲突，且不增加 timer 或外部命令。
- 自动恢复限定到 `com.flywheel.cmux-watcher`，不扩大到其他 `com.flywheel.*` label；FLY-913 只改提示文案、不改 P1/P2 决策矩阵。
- 不收敛才走既有 AlertChannelHub founder escalation face，恢复成功保持无消息，符合“禁新增告警层”和 founder-imperceptible 目标。
- 计划识别了 updater 并发、restart-storm gate、PID reuse、post-bootstrap probe 和补窗验收，实施依赖关系总体清楚。

## Issues & Recommendations

1. **[HIGH] `job_absent → rebuild` 会穿透现有 maintenance park。** 当前 classifier 先判断 `!job.ok`，之后才判断 `snapshot.park`（`cmux-watcher-patrol.ts:100-131`）；计划又要求“park 优先级不变”（plan:118），因此 job 已被计划性 bootout 且 marker 仍在时会直接进入 rebuild。`--rebuild` 的前置也只有 plist + `launchctl print`（plan:71-74），没有 mutation-time marker fence；这会与 QA teardown/ops rebuild 争抢 label，且残影逻辑还可能发信号。**建议：**将 fresh/expired park 都置于 `job_absent` 之前并保持 `recovery=null`；同时在 shell 真正 bootstrap 前重新检查 maintenance、`.qa-teardown`、`.ops-rebuild` 三个 marker，marker 出现即无 mutation。增加 `job_absent + 每一种 park` 以及“sensor 后、bootstrap 前 marker 出现”的竞态测试。

2. **[HIGH] “每 episode 至多一次”会在一次瞬态失败后重建新的单向门。** 现有 `recoveryEpisodes` 只在 `recovery.ok` 时落 latch（`cmux-watcher-patrol.ts:715-724`），所以失败会在后续 tick 重试；plan:95-99/120 却把它描述成“已尝试即锁死”。若第一次 bootstrap、post-print 或 process census 瞬态失败，label 仍 absent，但同一 generation 永不再自动尝试，只会等 10 分钟告警，不能满足“≤10min 自动回来”。**建议：**保留失败重试，使用固定的少量重试预算/60s cadence，或让 `--rebuild` 在自身 deadline 内完成 bounded retry；只在成功收敛后 latch。测试必须覆盖“同一 job-absent generation 第一次失败、第二次成功”，并证明预算内恢复且不会形成 bootstrap 风暴。

3. **[HIGH] T2 没有真正建立 label 保全不变量，并新增了不必要的 straggler killer。** `bootout → bootstrap` 中间仍存在 crash/outer-timeout 窗口；“最终尝试 bootstrap”不等于 label 始终受管。仓库已有明确的原地模式：`bridge/launchctl.ts:1-5` 将 `kickstart -k` 定义为 idempotent/reversible restart-in-place，`restart-services.sh` 的 Claude Lead 路径也明确删除 bootout choreography。与此同时，同 argv 残影正是 `_cmux_bounded_spawn` 的 watchdog；它负责在 timeout 后 TERM/KILL cmux process group（`flywheel-cmux-sync.sh:318-335`）。plan:63-70 若过早杀 watchdog，可能留下孤儿 cmux helper；而 `FLYWHEEL_CMUX_CALL_TIMEOUT` 当前没有上界，所以“25s ≥ watchdog 寿命”只对默认值成立。**建议：**loaded/stalled 路径优先改为 exact-owner revalidation 后 `launchctl kickstart -k`，job-absent 才使用 bootstrap；删除 generic straggler TERM/KILL 状态机，让 lease 保持唯一写权威、watchdog 自然收尾。若必须保留 bootout，计划需明确说明 kickstart 不可用的源码理由，并加入 bootout 后 SIGKILL/timeout 的 crash-recovery 测试及不会杀 watchdog 的身份合同。

4. **[HIGH] “连续不健康 10 分钟、一集一响”没有跨 branch 的稳定 episode 身份。** 现有 latch 和 episode key 都按 branch 分开；已有测试明确显示一次 `stalled → job_absent` 会产生两个 branch episode。plan:100-105 没说明 firstUnhealthyMs 在 `stalled/job_absent/owner_missing/heartbeat_missing` 之间如何继承，因此恢复过程中的正常状态迁移会重置 10 分钟时钟、改变 founder event id，甚至重复或无限推迟 escalation。**建议：**新增一个与 branch-ticket 去重分离的 `unhealthyGeneration`：首次进入任一非健康分支时固定 `firstSeenMs + stable key`，跨上述 branch 继承，仅在 verified healthy 或 intentional park 后清零；founder escalation 使用该稳定 key。增加 `stalled → job_absent → owner_missing` 跨过 600s 仍恰好一响的测试，并更新 full-union routing test、router 注释及 plugin 中目前声称 `founder-auto-mention=workflow_engine_escalation-only` 的启动日志。

5. **[HIGH] T5 的“隔离 env 真机演练”实际上不隔离 launchd/Bridge，并通过 opaque wrapper 绕过 FLY-913。** plan 自己把 label 定义为硬编码唯一值（plan:29）；`flywheel-cmux-autostart.sh:64-77` 和 plist 也使用固定 `com.flywheel.cmux-watcher`。HEARTBEAT/LOCK_DIR 只隔离文件，不能改变 running launchd job 的 label或已启动 Bridge 的环境；测试 shell 中设置 `REBUILD_DISABLED=1` 也不会改变在跑 Bridge。plan:148 的“命令串不含 launchctl 的封装”会绕开 hook 的字符串扫描却仍 bootout 真实生产 label，正违反 FLY-913 审计目的。**建议：**label-absent/rebuild、600s escalation 和路由零消息都用 PATH-stub launchctl + fake sink + fake clock 的 hermetic E2E；真实 `kill -9`/bootout 只能在明确 founder 授权的维护窗口、绑定精确 PID/label、走现有有审计的 bypass 合同执行，不能称为隔离 QA。若要完全自动的真 launchd QA，必须先设计独立 QA label/plist，而不是复用生产 label。

6. **[MEDIUM] T1 的“bounded 调用持续推进就永不 stale”只对默认 timeout 成立，且写点位置需覆盖 cold-start reconcile。** `FLYWHEEL_CMUX_PING_TIMEOUT`/`FLYWHEEL_CMUX_CALL_TIMEOUT` 目前只校验正整数、没有上界（`flywheel-cmux-sync.sh:291-296`）；任一值可大于 300s heartbeat stale threshold，重新出现假 stalled。plan:43 的“watch_loop 启动前”也可能被实现为 bootstrap reconcile 之后，而 `watch_main` 在进入 `watch_loop` 前已经执行完整 `sync_additive_bootstrap`。**建议：**在 `--watch` dispatcher 调用 `watch_main` 前激活 heartbeat，并把 call/ping timeout + kill grace 约束在 stale threshold 以内（最好固定安全上界，不再加旋钮）；测试覆盖 cold-start 长 reconcile 和最大允许 timeout。

7. **[MEDIUM] `w4_cmux_watcher` 是非验收必需的额外 API 面，且当前设计数据不够。** plan:111-113 只提出 `lastDecision` getter，但 `CmuxWatcherDecision` 没有 `job.ok`、结构化 heartbeat age 或 last recovery，无法生成所承诺的四个字段；接线还会扩展 `/health` schema、liveness builder 和测试面。**建议：**按“只删不加”先从本 issue 删除 C2，依靠已有 patrol ticket/escalation 完成验收；若确需保留，必须改成结构化 `lastObservation`（snapshot + verdict + recovery + observedAt），明确未运行/读失败状态，并补 liveness manifest schema 与 `/health` 集成测试。

## Verdict

CHANGES REQUESTED — address items above
