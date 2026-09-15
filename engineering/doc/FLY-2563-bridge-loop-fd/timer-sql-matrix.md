# FLY-2563 Bridge 定时SQL入口 — 调研
Issue: FLY-2563 (https://linear.app/geoforge3d/issue/FLY-2563/bridge-ship-judgment-modetick-每-3s-同步跑)
日期: 2026-09-14
基于: plan.md

## 审计方法与边界

对teamlead/claude-runner/flywheel-comm的非测试TS扫描setInterval，再用TypeScript AST区分调用、类型引用及字符串。以下每行命名实际调度点；同文件多个点分别列出。计时安装在连接实例，涵盖回调await之后的SQL，不依赖计时器外层wall time。StateStore包含普通/维护/备份入口；CommDB包含writable/readonly/adoption、MailboxQueue owned/borrowed及恢复入口。其余原生连接也已在构造处安装。

这是源码调用链/入口审计，配合timer-sql-coverage真实连接与旁路执行测试；不证明每个生产timer已运行，也不替代15分钟健康或2小时fd验收。

## Bridge主线程及其可加载组件

| 定时入口 | 同步SQL入口或无DB说明 |
|---|---|
| TmuxAdapter 两处主poller | shouldTimeout的CommDB readonly；onHeartbeat回调到StateStore |
| TmuxAdapter gracePoller | tmux探测本身无DB；onHeartbeat回调到StateStore |
| CodexTmuxAdapter heartbeat | 执行上下文heartbeat回调/StateStore；读取shutdown由CommDB入口覆盖 |
| CodexTmuxAdapter tick | CommDB动态状态与执行上下文回调；native memory-distill reader亦已计时 |
| codex-phase-lifecycle shutdownTimer | CommDB shutdown/lease及状态回调；native consent/lease库已计时 |
| HeartbeatService.check | StateStore、CommDB、MailboxQueue及lead lease库 |
| ship-judgment worker.tick | 注入的jobs/learning/inputs store使用StateStore提供的raw连接 |
| ship-judgment scanner.tick | 同一StateStore raw的input/job队列 |
| ship-judgment runtime.modeTick | outcomes/clarifications均使用同一受计时raw连接；增量预算另由T1/T2验证 |
| ship-judgment history-runtime.run | StateStore提供的history raw连接 |
| beta-release-scheduler.tick | BetaReleaseStore注入的StateStore raw连接 |
| workflow-launch-outcome heartbeat | 注入的workflow launch租约heartbeat使用StateStore；不在这里另开库 |
| voice-session-runtime.tick | StateStore会话与outbox读写；网络等待不计为SQL |
| workflow-engine-dispatcher.reconcile | StateStore工作流、CommDB投递与launch-claim本地库 |
| founder-approval-projector.drain | CommDB队列/StateStore投影 |
| workflow-docs-materializer.reconcile | StateStore outbox及文档回执 |
| gate-poller.poll | StateStore/CommDB/queue；经辅助读取打开的state/comm路径亦计时 |
| done-thread-reconcile tickTimer | StateStore/CommDB与告警回调 |
| report-hosting-maintenance.tick | StateStore publication读取；网络存储调用无SQLite |
| report-hosting-usage.tick | StateStore持久化/报告回执；native publication reader旁路已补计时 |
| fleet-data.collectOnce | StateStore、CommDB及fleet-admin/continuity本地审计库 |
| plugin SseBroadcaster.poller | buildDashboardPayload的StateStore读取、fleet supplier缓存 |
| plugin SseBroadcaster.heartbeat | 仅SSE写入，无DB |
| plugin fleet progress push | FleetConsole terminal audit/management读取；fleet-admin/StateStore已计时 |
| plugin fleetReconcileTimer | FleetConsole/management -> fleet-admin、continuity、StateStore/CommDB |
| plugin runtimeRetryTimer | createLeadRuntime可能构造CommDB和Codex journal/outbound/dedup本地库；均计时 |
| plugin designReviewManifestTimer | StateStore设计manifest outbox |
| plugin chromeReaperTimer | host检查/回收本身无SQLite；StateStore会话与配置查询经过主入口 |
| plugin doaBackoffMaintenanceTimer | StateStore、CommDB及审计写入 |
| plugin leadAlertDrainTimer | StateStore告警队列/回执；routed回调的CommDB mailbox入口已计时 |
| event-loop-attribution.rollWindow | perf_hooks/inspector/诊断文件，无SQLite |
| process-resource-monitor.sample | readdir/report/sysctl无SQLite；压力回调StateStore回执与routed mailbox已计时 |
| BridgeEventLoopGuard主线程heartbeat | 仅Atomics，无DB |
| account-heal switch-executor heartbeat | 文件锁fence/AbortController，无SQLite |
| CodexDiscordRuntimeOwnership.refresh | 注入的ownership/lease后端；lead-lease原生库已计时 |
| DiscordTypingNotifier scheduler adapter及refresh tick | Discord typing网络请求，无DB |
| codex-lead-tui-runtime ensureTuiHealthy | TUI探测本身无SQLite；运行时journal/outbound/dedup及lease原生后端已计时 |

## 独立进程与嵌入脚本

- gateway-main observeOnce：独立Codex gateway进程，不计入Bridge主线程health。该进程state reader和lifecycle/journal/outbound后端同样已计时。
- BridgeEventLoopGuard的worker字符串中setInterval(check)：worker进程/线程，Atomics和诊断文件检查，无SQLite。
- epic-page/render-html与bridge/dashboard-html内setInterval：浏览器渲染脚本，无服务器SQLite。
- 类型声明、注释中的setInterval不属于调度点；DiscordTypingNotifier的adapter定义与实际调用分别识别，不能算作两个并发timer。
- token-usage的SQLite位于独立token-report CLI/日报任务（core项目只从commands/token-report动态加载）；qa-framework sqlite-reader属独立评估工具。两者不是Bridge timer原生打开路径，不新增包依赖。

## 原生打开点补齐

除主要入口外，本批覆盖：state recipient/turn/ship/founder-review读取，snapshot/teardown/migration恢复与检查，node-dwell/host-readiness/report-publication/park probe，lead lease/consent audit，launch/continuity/fleet audit，Codex journal/outbound/dedup/lifecycle/runner-action与memory-distill；同库CLI命令的只读打开也计时，保持其独立进程分类。

构造参数、fileMustExist/readonly/timeout、事务和close所有权未改变。计时只输出静态databaseKind、SQL哈希和耗时；不记录路径、SQL文本、参数或数据库异常内容。

补充：本单scripts/fly-2341-db-hygiene.mjs的5个直接连接（inventory/archive/restore/vacuum）同样计时；该命令属于独立运维进程，不是Bridge timer。源码清单57处TS构造点，另加这5处运维连接；40个AST timer调用点不含类型引用和字符串内调用。
