# Design Review — plan.md (FLY-1066) (Round 1)

Date: 2026-07-16
Author: Codex
Status: CHANGES REQUESTED

## Summary

四面残留模型、scope-free 但仅限本 Bridge 配置项目的边界、`dead` 三态证明与 24h/30min 年龄护栏，整体方向可行；`terminated` 也确实是候选非终态的唯一通用终结目标。FLY-817 BLOCKER-1 的修订对普通与 resident phase 路径均有合理依据，但 M2 的真实副作用/失败顺序、M3 的跨项目存在性证明、M4 的定点触发与 flag 组合目前仍有会漏清理或错误置结的缺口，尚不宜进入实现。

## What's Good (Keep)

- 保留四面分解。面①②由 CommDB running 行驱动、面③反向由 StateStore 行驱动、面④单独处理 escalation，正好覆盖现有三个 sweep 的枚举盲区。
- 保留硬安全约束：只有 `probe === "dead"` 才允许删除/终态化，`alive`/`indeterminate` 一律 keep；特别是 `awaiting_review + alive` 必须结构性不可触。
- 保留两个 race 年龄护栏和 configured-project 边界。绝不能枚举整个 `~/.flywheel/comm/`，否则 QA slot/其它 Bridge 的 CommDB 会被错误当作孤儿。
- FLY-817 修订本身成立。`closeRunner` 在普通 CommDB target 已不存在时走幂等 already-gone；resident Codex phase 的专用 shutdown 判据也把 target gone/absent 视为可直接清理。只要 failed/blocked 的 alive/indeterminate 分支仍绝对保留，已死亡窗口不再有 scrollback 或 teardown target 值得保护。
- FSM 判断正确：`awaiting_review` 没有 `failed` 边，而 `pending/running/awaiting_review/approved_to_ship/design_done` 均有 `terminated` 边（`workflow-fsm.ts:120-184`）。
- 保留 injectable deps、kill-switch、反向哨兵和突变对照；这些很适合证明负向安全测试不是 vacuous green。

## Issues & Recommendations

1. **[HIGH] M2 把 `applyTransition` 误当成完整 teardown，且 finalize 顺序不是 fail-closed。** 计划在 `plan.md:62-68` 先 `applyTransition(...terminated)`、成功后才 `finalizeCommDbSession`，并声称 archive/QA-loss 等副作用会由 `transitionOpts` 自动完成。真实 `applyTransition` 只做 FSM 校验、StateStore 持久化、audit directive 和 `onTransition`（当前生产 hook 仅 enqueue display refresh，见 `applyTransition.ts:42-82`、`plugin.ts:3749-3760`）；crash-reaper 则显式执行 CommDB finalize、状态重读、transition、`onQaPhaseTerminated`、archive 和事件记录（`crash-reaper.ts:316-389`）。按现计划实现，QA ghost 会被置 `terminated` 却不触发 `reconcileQaLoss`，archive/audit 也会漏；更严重的是 finalize 若在 transition 后失败，该行已退出 M2 候选集，未答 gate/CommDB lifecycle residue 将永久失去重试入口。**建议：**把 M2 写成明确的 fail-closed `reapOneGhost`：异步 probe 后重新读取 StateStore 状态和 CommDB absence；持有 crash-reaper 同款 per-issue lifecycle mutex；先调用并记录 `finalizeCommDbSession`，失败则不 transition；再用真实 `TransitionContext { executionId, issueId, projectName, trigger: "residue_harvest" }` 转 `terminated`；成功后显式调用 QA-loss hook、terminated archive 和 session event。不要写不存在的 `ctx.actor/reason` 字段。

2. **[HIGH] M3 无法从现有 escalation row 推导“对应 project CommDB”，per-project 串行会产生误置结风险。** `detection_escalations` 只有 `target_key/issue_id/owner_lead_id`，没有 `project_name`（`StateStore.ts:2529-2544`）；而 M3 正是在 StateStore session 已不存在时运行，已经失去从 session 反查 project 的路径。计划又把 M3 放进每个 `harvestResidueForProject(projectName)`（`plan.md:73-80`），若只查当前 project，会把“存在于另一个配置 project CommDB”的 exec 误判为双无主；`isExecAlive(): boolean` 还会把 DB read error 与确证 absent 混为一谈。**建议：**M3 每个全量 pass 只运行一次，先对所有 configured-project CommDB 建 exec-id presence index；只有所有相关 DB 都成功读取且 StateStore、全局 CommDB index 均 absent 才 RESOLVE，任一 DB unreadable/indeterminate 必须 keep。优先复用现有 `getDetectionEscalationsForReconcile()`（其契约是 `status != 'RESOLVED'`）和 target-wide resolve primitive；当前计划刻意不动 `ACKED`，但现有 recovery 逻辑会处理 ACKED，需给出明确理由或把 ACKED 纳入双无主清理。若保留 `resolved_via='residue_harvest'`，同时更新 `DetectionEscalationRow.resolved_via` 类型及“是否可 revive”的语义测试。

3. **[HIGH] scheduled-run 定点触发放在 `alert_block` 前仍太晚，不能兑现 30min ghost 自愈，而且会被旧 FLY-742 flag 意外关闭。** 当前 `createStaleBlockerGuard` 先检查 `enabled`，再把 running、fresh parked、缺失 anchor 直接判为 `block_silent`，只有 stale parked 才查 PR（`stale-blocker-guard.ts:525-553`）。若按 `plan.md:82` 只在即将 `alert_block` 时调用 M2，31 分钟但小于 FLY-742 默认 120 分钟的 dead ghost、以及 running ghost，都仍然返回 409；`FLYWHEEL_CRON_STALE_GUARD=0` 也会在进入新逻辑前返回，和“定点入口只由 residue flag 控制”冲突。**建议：**在 active blocker 进入旧 FLY-742 分类之前运行 `ghostReconcileOne`（可直接放在 `runs-route` 的 409 分支，或放在 guard 顶部但必须早于旧 `enabled`/local classify）；仅由 `FLYWHEEL_COMMDB_RESIDUE_HARVEST` 控制。返回 false 后再逐字节执行原 FLY-742 路径。验收矩阵应加入 fresh awaiting_review、running、`CRON_STALE_GUARD=0` 三个定点用例，而不只测 alert_block。

4. **[MEDIUM] 心跳接线重复设计了已有的 detached maintenance seam，且当前锚点错误。** `HeartbeatService` 已有 `onMaintenanceTick`、tick counter 和 detached single-flight（`HeartbeatService.ts:467-515`），生产也已在 `plugin.ts:5204-5273` 注入每 tick/每 N tick maintenance；`plugin.ts:6249` 实际是 focused-frame scheduler 的 interval，不是 HeartbeatService interval。再向 HeartbeatService 加一套尾部 counter/single-flight 会扩大构造器和约 69 个相关测试的改动面。**建议：**直接把 residue 的约 1h cadence 组合进现有 `onMaintenanceTick`，用真正的 `config.stuckCheckIntervalMs` 计算 N；但必须放在现有 `worktreeAutocleanEnabled()` early return 之前或独立分支，否则 `FLYWHEEL_WORKTREE_AUTOCLEAN=0` 会成为未声明的 residue kill-switch。共享的 harvest single-flight 仍要同时覆盖 boot、maintenance 和 targeted 入口。

5. **[MEDIUM] “flag off 输出逐字节一致”与无条件新增 result 字段相互矛盾。** M1 同时要求结果接口增加四个计数（`plan.md:46`）和不传 `opts.harvest` 时输出与现状完全一致（`:45,48,88`）。现有测试会对六字段对象做 deep equality（`commdb-fsm-reconcile.test.ts:246-253`）；若新字段即使为 0 也总是出现，反向哨兵会失败，调用契约也已改变。**建议：**把 harvest metrics 做成仅在 harvest 开启时出现的可选嵌套对象，或保持旧 result shape、由外层单独记录新指标；新增明确的 `Object.keys`/deep-equality off-sentinel。

6. **[MEDIUM] 年龄与 mid-dispatch 论证需要按真实写入顺序修正并 fail-closed 解析。** research §6 R3 声称“CommDB 行永远晚于 StateStore 行”，但 fresh/retry dispatcher 都在 Blueprint 启动及 StateStore 事件之前先执行 `preRegisterCommDb`（`run-dispatcher.ts:618-630`、`:1203-1214`）；因此“CommDB running + 无 StateStore + `:pending` dead”本身就是正常的短暂 face①形态，24h 才是实际安全边界，而不只是纵深防护。另一个缺口是 `started_at` 缺失、非法或未来时间未定义；若 `ageMs` 得到 NaN 后比较落入删除分支，会直接削弱 24h/30min 保护。**建议：**修正文档 race 表，明确 SQLite UTC 解析；任何 missing/invalid/future timestamp 一律 keep，并为两面分别加这三类负向测试。

7. **[MEDIUM] M4→M5 的提交顺序违反“每步 GREEN”。** M4 首次在生产源码读取 `FLYWHEEL_COMMDB_RESIDUE_HARVEST`，但 registry 到 M5 才注册。现有双向 drift guard 会把任何未注册的 `process.env.FLYWHEEL_*` gate 直接判失败（`feature-flags-drift.test.ts:251-328`），所以 M4 commit 不可能全绿。**建议：**flag registry、readSite 与第一处生产读取同一个里程碑/commit 落地（把注册移到 M4，或将 M5 提前）；M5 只保留矩阵哨兵与全套回归。

8. **[MEDIUM] default-on 的首次生产 pass 缺少同谓词 preflight。** 已知 flywheel/geoforge3d 行做过判读，但 research 对 joycon-typeless/growth/sub 仍写着未逐行判读；M6 却在默认开启的 boot pass 直接删除/terminalize。**建议：**不必新增长期 dry-run 模式，但部署前应在七份快照上运行与生产完全同一候选分类器，输出每个 exec 的 face、age、FSM、probe、action/reason，并由独立 QA 核对 candidate/keep 集；把这一步列为 enable/restart 前置门，而不是“implement 时可选”。

## Verdict

CHANGES REQUESTED — address items above
