# FLY-2616 证明消失再收尾 — 调研
Issue: FLY-2616 (https://linear.app/geoforge3d/issue/FLY-2616/land收尾-合入后收尾必须能证明每个体已消失session-行缺失窗口不存在心跳超时goneworktree)
日期: 2026-09-15
基于: exploration.md

## 结论
基线 `b51fec422`。问题不是简单“缺少重试”：已有八次退避、第九次 held、升级事件和 resume 路由。需要统一死亡证据、补齐跨 session 消失后的执行身份集合，并让既有恢复通路支持只做合入后收尾。存量实例材料来自 Lead 问题回复 `a1f11bf9-4519-4d5c-80a5-03740e7b0c63`；没有事故 snapshot manifest，也没有本设计节点的生产探活结论。

## 实读代码及消费者
| 源码（packages/ 下） | 事实 | 设计影响 |
|---|---|---|
| teamlead/src/bridge/lifecycle-closeout.ts:147、1000、1215 | collector 是 session/QA/open claim 并集；无 session 分支现已可能直接 confirmedGone；起步中 claim 有特殊保护 | 加 durable workflow attribution；保留 launch race veto；所有 gone 使用一份证据 |
| teamlead/src/StateStore.ts:41640 | listRunAttributedExecutions 从 run_node / side_effect_ledger / execution_binding 收集，不依赖 session 行 | 复用再补历史 activation actor，禁止用仅存 session 作为全集 |
| teamlead/src/bridge/tmux-lookup.ts:355-407 | lookup.kind=gone 只证明注册缺失；DB 文件缺失、无行、无 tmux_window 混在一起 | 保留旧 lookup API；新 evidence collector 分开这些结果，不把 DB 读失败当 session 缺失 |
| teamlead/src/bridge/run-quiescence.ts:41、75 | execution marker、host process、Codex daemon/PGID/socket、pre-adapter failure 已有探针和独立证据 | 复用探针；缺 session 时不能默认非 Codex；不改通用 admission quiescence |
| teamlead/src/bridge/close-runner.ts:687、886 | Codex detached daemon 独立于窗口；终态不等于死亡，cleanup 后还要复核 | 窗口消失不覆盖 detached process 残留 |
| teamlead/src/bridge/commdb-session-prune.ts:384-435 | point 模式 parked 在探针前返回；sweep 模式 dead window 后仍 parked veto | 替换本单收尾的 parked 死亡判断；活 parked 和未知继续保护 |
| flywheel-comm/src/db.ts:8609、8723、8747 | 通信删除有 target/TURN/parked/founder-wake 守卫；各入口不完全一致 | 不仅改 Bridge 的早返回；新增精确证据驱动原子清理入口，避免下层再次 kept_parked |
| teamlead/src/bridge/land-cleanup-opportunity.ts:29-87 | 只迭代 session；已用 runner-instruction-gate；30 秒 bounded grace | 不是无穷 ACK 等待；加物理探活与“已 gone 不入等待集合”，不绕过现有 mailbox 门 |
| teamlead/src/bridge/shipped-husk-escalation.ts:59、194 | 已有 merge proof + run binding + request deadline + claim 复核强制关闭 | 不发明通用 kill；活而停滞体继续走此门，之后重新收集完整证据 |
| teamlead/src/bridge/worktree-cleanup.ts:173-310 | 正向关闭门、受控路径、注册 branch、binding generation、clean guard 后才 remove | 在路径/归属核验后、branch 探针前区分真实 ENOENT；现存目录仍走全部保护 |
| teamlead/src/bridge/post-ship-finalization.ts:1106-1112、1159、1438 | success 认 removed 或 not_registered；后者并非物理目录已不存在 | 新 absent attestation；现存但未注册不能算 cleaned；不授权分支删除 |
| teamlead/src/bridge/land-executor.ts:989-995 | owner=land-engine:PID，租约一小时 | 要进程 incarnation + 自续期 + 独立死亡回收 |
| teamlead/src/StateStore.ts:27944、73234、73337 | admission 只存 owner/generation/expiry；running 只等 expiry；__main__ 竞争者只看时间 | 旧 holder 消失不能继续空占 lane |
| teamlead/src/StateStore.ts:73409 | claim 检查 operation，不检查 lane tuple | 回收必须同时 fence operation 和 lane；旧 worker 所有 effect 必须失权 |
| teamlead/src/bridge/plugin.ts:10798-10873 | 30 秒 sweep 且 running flag 横跨 await all executors | watcher 不能挂在同一 await 门后，否则卡死者阻塞自己的回收 |
| teamlead/src/bridge/land-retry-policy.ts:65、144 | 第九次耗尽转 held | 保留预算，补告警持久投递验收，不新增无限重试 |
| teamlead/src/StateStore.ts:73649、73958、51152、74301 | legacy outbox 不收 workflow op；workflow 有自己的 held 事件 | 两条通路均测试；每一收尾 episode 必有可重投升级 receipt |
| teamlead/src/bridge/land-executor.ts:1855-1883 | held notification 失败只 log | 不能仅依赖 best-effort thread message 来证明 Lead 收到升级 |
| teamlead/src/bridge/lifecycle-routes.ts:277；land-executor.ts:212；StateStore.ts:74000 | 既有鉴权 resume 只支持 held，检查当前 head/approval/run/node/dispatch | 扩展 explicit closeout_only mode，合入后 immutable merge tuple，partial/held 均可；旧模式保持 |
| teamlead/src/bridge/quota-daemon-wake.ts:47-68、account-heal/pidfile.ts | 已有 PID + process start identity 模式 | 复用 OS identity，不以 PID 文本当唯一身份 |

## 调用/持久化路径
land executor claim → cleanup opportunity → plugin finalize / resolveLandSourceSession（当前缺行会 source_session_unavailable 提前返回；本单须改）→ runPostShipFinalization → phase cleanup / forceShippedHusks / lifecycle closeout → worktree → terminal notification → archive → Linear disposition → completed receipts → workflow land node/run projection。
StateStore 和 CommDB 是两库，不能宣称跨库原子事务。设计采用权威 reservation + 每库 CAS + 幂等 receipt；中断后继续未完成部分。runnerDeathProven 只是消费字段，不能被模型提交或旧“complete”消息自行铸造。
所有 proposal 的 provider/consumer：plugin.ts composition root、lifecycle-closeout/close-runner、commdb-session-prune/db、land-cleanup-opportunity、shipped-husk-escalation、worktree-cleanup/post-ship-finalization、land-executor/StateStore、lifecycle-routes/CLI、workflow-engine-dispatcher（held 告警投递）。既有 DirectEventSink/event-route/merge-ship-gate/external-merge-reconcile 经过 finalizer 的 legacy 路径也要跑回归；可选 fence 只允许 genuinely non-land 调用，landManaged 缺 fence 必须拒绝。

## 测试落点
- bridge/__tests__/lifecycle-closeout.test.ts、__tests__/commdb-session-prune.test.ts、__tests__/close-runner.test.ts。
- bridge/__tests__/worktree-cleanup.test.ts、__tests__/post-ship-finalization.test.ts。
- bridge/__tests__/land-executor.test.ts、__tests__/StateStore.land-lifecycle.test.ts、bridge/__tests__/lifecycle-routes.test.ts。
- 新 execution-closeout-evidence、land-owner-liveness、隔离 replay 测试，保存真实故障前形状和后置外部 sandbox receipts。
- flywheel-comm db 清理与 CLI 路由测试；既有 FLY-1328 finalizer callsite sentinel 必须更新并通过。

## 事实边界与研究缺口处理
三种故障的源码路径已验证，具体四 run 的当前生产状态未亲查；Lead 更新纠正 2602 已完成。四个短执行前缀仅供定位，不可用于删除/CAS/测试写入。新 archive_failed 未证明有新病根，只要求现有 archive 失败不被当成完成、恢复路径幂等重试。实施前通过受管 helper 获取一致副本或由 Lead 交付受管快照；仅 synthetic 测试不能替代四实例回放。
未使用 web 资料：契约完全基于当前私有仓库及本线程 Lead 决定。未执行生产清理、复制 live DB、创建外部 sandbox 或验证实现。

## Round 1 追加核查
- `land-source-session.ts:11-41` 全部从 sessions 取 source；plugin.ts:7501-7514 在缺行时提前 partial，已纳入 plan §2.5 和 A 的真实 wiring RED。实际事故短执行前缀缺行不能推论所有 source 行缺失；后者是新增边界测试。
- `codex-phase-shutdown.ts:150-191,252-306` 有更早的 target/ACK/heartbeat 守卫；新 evidence 只在 trusted land closeout context 接线，legacy 不放宽。
- `scripts/lib/fly-2006-retention-registry.mjs:55-62` 拒绝未分类 schema；两新增证据表须有 protectedCurrentOrReference fragments，相关 CI 套件及 stub-hygiene 已列入计划。
- 既有探针单次 timeout 可达5秒；改为逐 observation 30秒 freshness + 每 exec 有界预算，避免5秒全量重探循环。

## Round 2 存储边界纠正
`StateStore.getWorktreeBinding:24981-24994` 读取 sessions 列，session 删除后不再可用；workflow_execution_binding 不保存目录。plan §2.5 改为强制 intent 时把完整 verified targets snapshot 存到 land_operation additive columns，并明确 legacy backfill/provenance recovery/无法补证的分支；不再以不存在的“durable binding表”支持all-rows-deleted fixture。`session_events.execution_id` 为 NOT NULL；null-source operation audit 使用现有 land_operation_step 的 aux namespace，getLandOperationRetryEpoch:73612 排除它，避免诊断重置故障预算。

## Round 3 失败入口核查
`workflow-engine-dispatcher.ts:2269` 直接同步 ensureLandOperation，外层:418 catch 只有log；新预捕获拒绝必须显式调用:2196 holdLandRun，携带alertIdentity，不让异常落入静默catch。existing hold registry:151 已有 land_held_without_operation，StateStore:49538 resume_land_without_operation 接受 retry；复用此无op恢复门。plugin.ts:8494/8537 与 lifecycle-routes createIntent 为同步签名，计划明确新增异步 provider /同步SQL输入payload，并同步 await 接线与tests。
