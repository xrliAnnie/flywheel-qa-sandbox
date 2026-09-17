# FLY-2701 语音按需启动 — 调研
Issue: FLY-2701 (https://linear.app/geoforge3d/issue/FLY-2701/语音按需启动-语音进程平时不常驻开耳机模式-会议到点时才由系统启动空闲后自行退出founder-2026-09-17)
日期: 2026-09-17
基于: exploration.md

## 1. 权威与证据层次

工作树基线d11bb892d。只读引用 `origin/flywheel-FLY-2693:engineering/doc/FLY-2693-voice-failure-alerts/plan.md` §3/7/附录A/B；未合并其分支。依赖最终实现先合入再复核，不把设计文档当现存API。

Lead question 7712f43a-8364-4842-8bdf-b00ff6257c50：认可严格按需launchd；无更多warming分段证据；要求正常班车最多有限等待、紧急不等。question c2452d96-ed5e-4773-9a76-211f31f59eed：旧Raya apps/brain已停用，跨Raya改动禁止；本单提供Bridge预约合同，QA直接POST/CLI；cos接入由Lead后继单安排。这两个当前裁定优先于探索中的初步候选。

## 2. 核实的调用链

| 文件 | 当前行为与必须改变的消费者 |
|---|---|
| packages/teamlead/src/bridge/voice-session-start.ts:141 | 解析mode=rg/meeting，meetingId只允许可信当前会议starting/live/interrupted，不能借旧meetingId入口预热scheduled |
| voice-session-routes.ts:95 / voice-session-provisioner.ts | reserve→Discord thread provisioning→desired；原子提交之后立即调窄wake函数；API成功不等于voice ready |
| packages/teamlead/src/StateStore.ts:3246/3266 | desired查询与房间唯一reserve；未来预约必须另表，不能提前占用唯一活动房间 |
| voice-session-runtime.ts:39 | 启动立即tick、周期3秒；当前validateSession及poll可await外网，不能把wake补偿排在这些慢操作后面 |
| voice-session-services.ts:41 | 可信host/project/lead绑定及服务构造；注入固定launchd目标与独立单飞wake/预约协调步骤 |
| packages/voice-codex/src/daemon.ts:250/270/321 | 无限run；recover清旧会话failed；先claim，再建session；SessionLifetime当前晚于createSession创建，须把续租覆盖前置异步验证 |
| session.ts:113 | frontend.start串行room.start；音频guard目前admitted，不足以保证预热时不收音，必须增加ready/live分别门控 |
| realtime.ts:61 | process start→apiKey login→account/read→thread start并核对只读回执→realtime/start；保留鉴权和隔离检查 |
| discord-room.ts:83 | VAD模型加载→registry登录→join→房间/本人presence；可与模型链并行，但必须处理取消及迟到资源 |
| cli.ts:77/159 | 进程锁；createSession内token身份验证；finally释放锁；要覆盖启动分段、超时、异常退出 |
| scripts/flywheel-voice-wrapper.sh:114 | PID文件里任何活PID都会exit0；exec后EXIT trap不执行，复用PID可误拒绝启动；不能把PID文件当唯一锁 |
| scripts/install-voice-launchd.sh:57/100/133 | 强制RunAtLoad/on-failure且要求PID；改为注册校验，按需状态不要求PID |
| scripts/lib/restart-voice.sh:20 | loaded服务总kickstart -k，空闲部署会误唤醒；改需求敏感的注册刷新/排空重启 |
| scripts/launchd/units.manifest:31 | 当前hold跳过巡检；managed反而禁止loaded，不可改成managed；采用setup支持显式安装及合法休眠 |
| scripts/lib/converge-nonlead-daemons.sh:981/994/1038/1349/1385 | setup/copy能检查registered无PID；现有字节drift只报错不会替换，迁移必须显式刷新注册 |
| scripts/restart-services.sh:1965/2964/3011/3061/3217 | 分类、回滚、voice重启、Bridge stop、后置voice重启均需同步；不能只在最后加等待 |
| scripts/update-flywheel.sh:255/636 | 正常班车执行前挂有界延期，founder urgent不等；先同步已合入2669/2657 |

## 3. 不应复用的旧调度

`~/.flywheel/raya/code/apps/brain/src/meeting.ts:640–739`只在到点后start，15秒tick来自旧gateway。源码存在不证明运行。Lead明确其22:01Z已bootout+disable；本单不恢复、不改该仓。`meeting-notes-scheduler.ts`是会议归档/笔记后继调度，不能当语音启动调度。`loadTrustedCurrentMeeting`可用于旧即时meetingId入口，但不成为新预约的轮询来源。

新预约唯一持久来源归Bridge StateStore；调用方POST一次，随后即使调用方退出仍能预热。后继cos仅接接口，不能拥有另一套launchctl或时间触发器。

## 4. launchd依据

本机 `/usr/share/man/man5/launchd.plist.5:287–291` 与 [Apple开源手册](https://github.com/apple-oss-distributions/launchd/blob/main/man/launchd.plist.5) 都明确SuccessfulExit隐含RunAtLoad。采用RunAtLoad=false、KeepAlive=false；Bridge请求系统启动，实际进程仍是launchd管理的独立进程。没有Bridge存活时的自动重启承诺；Bridge恢复立即补扫尚未claim的desired。

[Apple启动任务文档](https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/CreatingLaunchdJobs.html)区分按需启动与持续KeepAlive。需求路径禁止-k；不能通过启动回执推出进房成功。

## 5. 性能已知与未知

只读事件路径：`~/.flywheel/voice/sessions/5142f2ab-16ed-48f6-bef5-c08d3740dd23/events.jsonl`。
- 原始starting 2026-09-16T23:31:12.203Z，live 23:31:59.053Z，相差46.850秒。
- created_at 23:31:07.007Z由Lead提供：到starting 5.196秒，全程52.046秒。
- 该文件无room/Codex/realtime分段事件，无法事后拆数。live之后12.461秒出现DAVE解密中断；不能把此样本当成功长通话。
- wrapper开机约10秒只有旁证；必须QA至少3次process确实不存在的冷启，记录每次值。当前无实测优化收益。

测量模型：t_request、t_reserve、t_desired、t_kickstart、t_wrapper、t_daemon_ready、t_claim、t_identity、t_process_ready、t_auth_verified、t_thread_ready、t_realtime_ack、t_realtime_ready、t_vad_ready、t_gateway_ready、t_room_ready、t_ready、t_live、t_first_heard。进程内用单调时钟；跨进程使用同host启动时间+校准误差，不直接相减不同performance.now。分段记录只含固定阶段名、关联ID、结果和耗时，无secret/音频/转录。

优化候选有真实依赖依据：取消5秒等下一轮的首次探测、把room与frontend并行准备；VAD/网络与Codex之间无必要串行。保留account/read和thread隔离回执，不能为快跳过安全验证。优化后关键路径是max(room,frontend)+共同前后置，不是相加；仍需同环境前后对照证明。

## 6. 故障和边界

无需求无PID=正常休眠。desired未claim=仍欠启动，launchctl成功/进程存在不清账。已claim后崩溃保留现有lease过期failed及2693告警，不擅自再join同场。计划重启最多推迟600秒；异常/强制重启可能超过15秒lease并中断，告警而非伪恢复。未来会议的等待时间不算启动超时，从prewarmAt/实际接入时间起算。

完整测试/迁移/接受标准见plan；当前只做源码和日志审计，没有启动生产实例、没有运行候选代码、没有真实房间验收。

## 7. 合并裁定补充

Lead 4891fab3-1055-4b83-b02a-1358788d37bc明确取代deca6970的canonical起点要求：Bridge scheduleId/revision为唯一预约事实，QA直接API/CLI；canonical仅旧即时入口校验，双入口冲突409并告警。现代Raya origin/main 90e433e的meeting-artifact.ts:77禁止提前begin_start，meeting.json到点才产，不能用于提前两分钟调度。
