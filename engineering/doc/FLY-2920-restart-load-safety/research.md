# FLY-2920 重启与负载恢复 — 调研
Issue: FLY-2920 (https://linear.app/geoforge3d/issue/FLY-2920/病根修复-4-重启和负载不再把系统自己打垮删卡顿自杀与-250ms-起体判败审查作业与孤儿身份只认领退休一次内存手刹不锁存6-张-59)
日期: 2026-09-26
基于: exploration.md

## 研究边界与方法

基线 d52df7841；源码只读扫描，未读写生产数据库，未启动测试房或运行重型套件。两份并行只读研究分别核对审查/孤儿与内存/旧恢复，再由设计作者核对关键代码。本文是代码证据，不声称六单已实测修复。任务明确授权产出计划并走注入的 design-review；不另增通用技能的人工作业门。

## 1. 主循环与子进程

| 文件与锚点 | 当前事实 | 设计影响 |
|---|---|---|
| `packages/teamlead/src/bridge/BridgeEventLoopGuard.ts:237` | worker 的 stall 先收证、复核 heartbeat，仍无进展就设置 terminal 并 `process.kill(process.pid, "SIGKILL")` | 删除 kill，监测不能在一次报告后永久 terminal；每次连续 stall 一份取证，heartbeat 前进才重新武装 |
| `packages/teamlead/src/bridge/plugin.ts:13786` | 生产启用，日志明说自杀重启 | 改接线说明和日志，不留另一处恢复性 kill |
| `packages/claude-runner/src/TmuxAdapter.ts:2826` | `defaultAsyncExecFile` 分别等 exit/close，exit 后独立 250ms timer 强制失败 | 不是启动总时长 250ms；不能把 spawn 事件当业务成功 |
| `TmuxAdapter.ts:2513` | ensureSession 总预算 210s、单次 90s；解析 helper 输出 | 去掉 drain timer，沿用调用方总预算和输出协议 |
| `packages/claude-runner/src/CodexTmuxAdapter.ts:653` | Codex 也使用同一 async helper | 两 vendor 起体都须回归 |
| `packages/claude-runner/test/async-exec-file.test.ts:57` | 旧测试要求 grandchild 持管道时触发 250ms 错误 | 更新为延迟 >250ms 后完整输出成功，永久持管道仍受总超时约束 |

保留 spawn error、非零 exit、signal、maxBuffer、整体 timeout 的错误字段；exit 后不得再按 recycled PGID 杀一组进程。生产调用者逐个确认有整体 timeout；无 timeout 的调用使用明确定义的默认整体预算，不能留下无限等待。

`runs-route.ts:3761–3905` 已有 `releaseFailedWorkflowLaunch` 和物理证据 unknown → LAUNCH_PENDING；`run-dispatcher.ts:1283,1904–1948` 已有 inflight/生命周期/CommDB 清理。因此先构造真实 stdio 原现象穿透 start 路径，只有必要时补漏，不能另造全量 run 清扫。已投递/未知物理状态不能按失败回滚。

## 2. 审查作业和结果是两回事

核心：`packages/teamlead/src/bridge/review-request-coordinator.ts`。

- `:1157–1210 redriveOnBoot`：通知 outbox、终态结果 outbox、reuse bindings（多扇门共用一次审查）、running→pending、排队 pending/running、scheduled retry。
- `StateStore.ts:23247 resetRunningCodexReviewJobs` 无条件重置所有 running；`:23031 listRedrivableCodexReviewJobs` 再次取出它们。重启没有审查体持久 PID 身份校验。
- `StateStore.ts:22821 claimCodexReviewJobRunning` 已有条件认领 pending/failed → running。明确作者重试已有基础，不必新建无限后台重试队列。
- coordinator `:753–814` 同 requestId 的失败作业重试会核对 exec、question、review type、repo 绑定及 open gate；`request-review.ts:85` 默认 UUID，故重发必须带 `--request-id`。
- `:1170,1215`、StateStore `:23229` 已完成且未送达的结论只重投；不能将它们混入退休。
- `:1462` 若 request-bound code approval 先写成功、job done 未写，现有 runJob 可恢复既有 APPROVED。删掉 boot rerun 时必须将这条结果恢复移到无 reviewer 的 boot 恢复分支。
- `:1194,2022,2090` 失败 source 的 follower 会自动转 own lane 并 enqueue。退休 reason 必须贯穿 follower，否则主作业不重跑、追随门却重跑。
- `claude-review-runner.ts:204` detached child；`:118` liveChildren 仅内存。作业退休不等于 OS 进程已死。
- 失败告警 `:1983` 投 Lead，而非直接让 Runner 重发；`flywheel-comm/src/commands/check.ts` 目前只读最终响应。因此计划必须补可见的未决重试提示及作者消费动作，不可凭“runner 会重发”假定已有自动行为。

独立保留：批准/发现、门、requestId、delivery nonce、head/repo/plan 绑定、governance rulings。退休只停止旧作业的自动启动资格；不能伪造 CHANGES/APPROVED，也不能关闭未回答的门。

## 3. 孤儿账本不是可扔掉的垃圾文件

`packages/teamlead/src/bridge/codex-runner-orphan-reaper.ts:216` 从 `<session-root>/<exec>/session.json` 取 ledger；`:847–861` home inventory 缺失便每轮写 identity_mismatch；`:870–885` home 在、argv/PGID 不符是另一类。

`packages/claude-runner/src/CodexTmuxAdapter.ts:3035` 写同一 session.json，保留 home/thread/gate 等字段。退休不能 unlink 全文件，也不能用 inventory absence 代替路径真实不存在。`packages/claude-runner/src/codex-home.ts` 的 keyed-home marker/lease 恢复仍需保留；ledger 的 keyed home 在 lease 退休后仍能帮助解析。

必须区分：确认缺失、不可读/损坏、软链接/隔离路径拒绝。只在确认 home 缺失、最新执行 inactive、完整 daemon generation 未变化时一次性退休 daemon ownership。其他身份不匹配不授权 kill，不随本单扩大自动清理。

## 4. 内存：当前版本已有 release，病根是两本账

- `fleet-sensors.ts:201–241` 已有 clear 及重启后 healthy 清理；`fleet-sensors.test.ts:383,737–795` 已覆盖。只加相似 cleanup 测试不能证明删除锁存。
- `machine-watermark.ts:118–275` 由 vm_stat free% + Swapouts 累积值差分判定；两次 danger 确认，首次 baseline delta 为 unknown。healthy 为 free≥HIGH 且 delta≤MIN。历史差分跨异常读数缺口，需明确新鲜度。
- `fleet-sensors.ts:264` 为唯一查到的生产 setFleetPressureHold 调用；`plugin.ts:6630` 将 durable row 提供给 admission；`runner-admission.ts:300` 当前 hold probe 异常 fail-open。
- `capacity-snapshot.ts:579,816` 也读 durable hold；`:542` 另外执行 memory_pressure 得 free%，不同来源不能冒充当前 hold 的传感器读数。
- `fleet-sensors.ts:291` 恢复只有 log，工单静默 resolve；短暂 pause 也必须有可见恢复收据。
- 非 swap-sensor 的人工行存在 API/测试语义，无生产 setter 命中。不静默清除这些记录；将其明确视作独立 operator pause 兼容输入。

设计：准入与压力展示共享一个有时间戳的当前 sensor snapshot，读数危险/健康/未知都不继承旧 episode 的阻断位。数据库仅保留通知去重与人工暂停语义；不再有传感器持久锁存。未知有可见原因、下一读数自动更新，不可将旧 danger 无限缓存。

## 5. FLY-2084：较旧盘点里有过时证据

当前 `workflow-template.ts` 无 literal produce 节点，不能照搬旧单“produce 仍存在”的结论。实际遗留是 `rescue-runtime.ts:172–300` 的 terminate→close→startSuccessor 和 `plugin.ts:15490–15555` 接线；已有 engineOwned guard 防止 DAG 被转成 unbound legacy。

`progress-resume.ts:124–130` 仍以 session_stage 算 effectiveStage。`run-infra.ts:1710–1747` 已 local branch 优先并 pin 同一 ref，保留未推提交；须回归而非重新设计。DAG（持久节点工作流）的恢复应从 workflow_run_node + attempt/execution 读取，progress.md 是继续工作的游标，session_stage 只显示。

自动 legacy 复活消费者退出。停止/取消的终态不重开；节点或分支证据不明则给可操作的等待/拒绝收据，不回落 main、不新造 produce。人工明确 start/retry 仍要通过现有 admission 与绑定校验，不能由 boot/sweep 冒充。

## 6. 测试与运行约束

相关文件包括：bridge-event-loop-guard、async-exec-file、TmuxAdapter/CodexTmuxAdapter、review-request-coordinator、StateStore review job、request-review/check、codex-runner-orphan-reaper、pressure-hold/fleet-sensors/machine-watermark、capacity、run-dispatcher-pre-registration-cleanup、runs-route-generalized-pending、generalized-launch-recovery、rescue-runtime、progress-resume、run-infra-continuity。

仅具体文件白名单，worker=1；不得 `pnpm test` 全仓，不用 hub 文件的 vitest related。启动 Bridge 的测试须隔离所有状态与 Codex homes，不能碰宿主 lease；禁止真实 GUI 测试。最终验收要求 old/new 同夹具证据、六张单逐项、端到端不丢结果；本阶段只计划和文档检查。

## R1 后校正与续接核对

本节覆盖前文中已被 R1 校正的推论，以 `plan.md` 的 R1 修订合同为实施依据：

- 孤儿退休覆盖 home 缺失和 home 存在但完整证据确认旧进程不存在两支；身份不匹配而无法确认失效时，只去重审计，不退休或杀进程。无需给 spawn writer 新增共享锁。
- `makeCloseAndDispatchSuccessor` 是有 live-pane 重验的登录失效恢复，不能凭名字归因到 FLY-2084，也不删除这个功能。继续限定真实 boot/node 恢复入口、停止令与分支/游标保护，并要求调用图及负控制。
- 单纯给 `check` 增加提示唤不醒 gate-hold 作者。实施合同 D3a/D6 要求持久退休/ready 通知、CommDB 与 marker fallback 两条 hold 消费路径、原审查期限，以及真实作者 turn 发起重发的证据。
- 内存未知沿用本项 probe fail-open，保留独立 load/free-bytes 护栏；两次危险才阻断，当前有效 non-danger 立即放行，通知另做确认。原人工暂停独立保留。
- 续接只读复核当前源码：EventLoopGuard 仍有自杀；TmuxAdapter 仍有 250ms drain timer；review coordinator 仍 running→pending 后重排；progress-resume 仍从 session_stage 推 effectiveStage。这里没有把设计内容声称为已实现。


## R2 后校正（覆盖 R1 的未知读数结论）

实核 `machine-watermark.ts:195–209`：一次读失败保留 pressure 和 baseline；`fleet-sensors.ts:224–236`：重启首个 delta=null 不清 durable hold。`runner-admission.ts` 的异常 fail-open 只针对 hold probe，不能推广到 sensor unknown。默认 minFreeMemBytes=0（关闭），load/core=8，不能替代换页压力保护。R2 的 F1/F2 因此改为2P内新鲜证据和有界启动采样等待，有效 non-danger立即放行，超期未知告知降级并不锁存。

R2 同时实核：review coordinator 只有 per-job retry timer，没有通用30s recovery patrol；plan明确新增窄单飞回合。`stop()` 当前只清定时器，shutdown kill回调仍有写普通failure的路径，设计统一退休。退出marker当前以同代stall推“自杀”，删除kill后须改为仅诊断线索。这些均是实现合同，不是已实现行为。


## R3 生产接线校正

`FleetSensors.tick()`虽有注释暗示约30秒，但唯一生产调用来自`lead-reconcile-pass.ts`，且先等待lease/identity/audit；`plugin.ts`给GatePoller的3秒tick与`gate-poller.ts`的200 tick共同产生约10分钟周期，忙时单飞跳过更长。因此不能从monitor注释推P。F0改为明确新增独立30秒轻量swap采样，早于admission启动、单飞、5秒读取上限，重型fleet tick只留其他职责。F1/F2证据有效期90秒用于容纳单次失败与读取抖动，warm-up仍≤60秒。生产接线测试必须实际经历30秒timer，不能只给monitor注入样本。以上为待实现方案，当前源码仍是十分钟链路。
