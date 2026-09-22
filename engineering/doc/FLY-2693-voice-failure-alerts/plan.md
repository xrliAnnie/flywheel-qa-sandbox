# FLY-2693 语音健康与失败告警 — 实施计划
Issue: FLY-2693 (https://linear.app/geoforge3d/issue/FLY-2693/语音静默失败-comflywheelvoice-装上后-55-小时-67-次迭代全部失败0-次成功launchd)
日期: 2026-09-17
基于: research.md

状态: 待有效 design review。设计节点不实现、不部署、不重启。此计划优先于原标题“0成功”的错误推断。

## 1. 交付与前置

给语音 daemon 增加可核验的成功记录；连续失败达到阈值立即走工程频道告警，同一故障显示在固定页，真实恢复后熄灭。启动拒绝同样入此链。原PID最近成功与历史逐圈根因仍未验证，不能宣称线上已修复。

**实施前置：FLY-2669 最终实现先合入。** 未合入向Lead排顺序，不merge它的工作分支、不复制一套旧kind。以合入合同重核下文复用点。必须保留源、投递、固定页三个层次的真实回执。

Lead已采纳按需拆单并创建FLY-2701（FLY-2598子单，依赖2693+2655；§7），本单不改变监督/启动模式。founder已于23:25Z明确不采用常驻模式；FLY-2701为硬要求。本单健康合同必须支持正常休眠，详见本节的最新约束及§3补充。

## 2. 诊断修复：先建立真实成功判据

- `bridge-client.ts` 为每请求标记 operation（desired/claim/renew/state/outbound/receipt）、method、规范route模板、requestId、elapsedMs、headers/body阶段、HTTP status、有限errorClass/causeCode、timeoutMs。只输出已校验origin，路径中sessionId不进错误文案；绝不记录URL凭据/query、Authorization、token/hash、响应正文、语音/转录、任意error.message。
- 校验BRIDGE_URL的协议/格式、禁止userinfo/query/fragment；生产默认loopback。配置来源只记录字段名与default/env，不输出secret。跨主机部署如存在，按现有可信配置明确allowlist，不把凭据发向未验证地址。
- desired严格解码：必须为对象且有session，session必须null或含合法sessionId；malformed/截断JSON/正文超时均失败，不能被catch吞后算idle。其他路由保持既有typed合同，不把2xx自动当业务成功。
- `runOnce()` 返回显式判别结果，至少 idle_success/session_ended/session_failed；创建会话失败等当前返回字符串的分支是失败。停机取消不算新依赖故障，也不是恢复。
- 成功日志：首次完整idle、从失败恢复、之后每60秒一个有界heartbeat（timestamp/bootId/observationSeq/mode/lastIterationSuccessAt/counters）；每次完整结果写持久健康记录。单GET200不是整个runOnce成功；日志抑制不抑制持久状态。
- phase耗时使用单调时钟；墙钟只用于展示。success/failure counter累计在本source世代内，重启不伪造成功、不把历史未知补0。
- 本单将idle请求timeout配置与lease请求分开，新增 `FLYWHEEL_VOICE_IDLE_HTTP_TIMEOUT_MS` 缺省2000；**本次不盲目增大默认值**。lease仍2000，`renew+timeout<TTL/2`与fence完全保留。实现/QA采集延迟分布、事件循环延迟及error cause后才能提出单独调参证据。
- 连续错误重试等待5/10/20/30秒，上限30秒；idle成功恢复5秒。只有desired/空转失败走此退避，renew仍4秒、不被日志/告警阻塞。无并发重试或重复claim。
- 历史75条无法逐条补因果，输出不可判定清单；对新观测每次失败必须能关联请求operation/时间/cause。本单不以猜测“修根因”；若新增证据暴露独立故障，做最小针对性修复并补真实回归，超出范围报Lead。

## 3. 唯一健康来源与状态机

**最新约束（Lead instruction faf41313-a917-410c-b2ba-cd84cb02dd9a）：不假设常驻PID。无会话需求且无进程是正常休眠；有需求而未启动、不能进房或持续失败才告警。** 所有阈值先经过下文需求门；成功时间持久在源库，退出后仍可读。

新增 `scripts/lib/voice-health.py`（SQLite标准库，复用2669的安全路径/事务/投递观念，不复用部署cycle语义）、`packages/voice-codex/src/health.ts` 窄适配。

源路径由受信状态根解析为 `state/voice-health/observations.sqlite`；helper支持隔离测试根，不从HTTP payload接受路径。检查所属用户、regular/non-symlink，目录0700/文件0600；参数绑定SQL，schema newer fail closed，不drop旧库。主键：规范JSON `[hostIdentity,"com.flywheel.voice"]` 的hash；hostIdentity使用health源目录独立持久的host-instance UUID（首次原子O_EXCL创建，备份/迁移保留；不能复制到另一主机），不臆造host.json中不存在的字段，不用PID/hostname展示名作为身份。无法读取/创建时config错误；source库重建保留host-instance。

| 记录 | 关键字段 |
|---|---|
| metadata | schemaVersion=1, sourceId(UUID，在建库时一次产生) |
| health | serviceId, generation/bootId, observationSeq, phase, demandRevision/demandState, bootAt, lastIterationSuccessAt, lastProgressAt, successCount, failureCount, failureStreak, firstFailureAt, lastFailureAt, reasonClass/operation, durationMs, episodeIds, sourceStatus |
| episode | UUID, serviceId, scope=poll_dependency/session_unavailable, demandId/attemptId（会话类必填）, openedAt, reasonClass, threshold, closedAt, recoveryObservationSeq；同scope/需求故障不因reason变化或重启重造 |
| notification | intentId=hash(serviceId,episodeId,routeKey), frozenPayload, routeKey, bindingDigest, state, attempt/claim, channel/message receipt；恢复后再坏为新episode |
| changes | sourceId+seq，完整有界projection快照；健康变化最多20秒一条，故障/恢复/投递立即一条；seq高水位独立保留，不随历史裁剪归零 |

helper事务原子更新结果、计数、episode、notification、change。它不是新的常驻进程；daemon通过异步execFile、JSON stdin调用（无shell插值）；单次deadline500ms、最大输入32KB、单飞串行有界队列。正常结果在20秒采样窗口内合并，但保留实际成功/失败计数与最近时间；故障/恢复/启动/退出立即flush，不因正常节流丢失。稳定通话每分钟最多3次helper健康写，N分钟上限ceil(60N/20)+2（首尾），另外计明确异常次数；Bridge需求快照仅digest/seq变化时写，未变化最多20秒刷新一次需求可读时间，3s tick不等于每3s spawn。积压/超时/损坏显式 health_observation_unavailable，stderr+meta-alert，不能伪造sent或清故障；下个结果重试。计数/episode写入失败时内存保留，读者从lastProgressAt判stale，不展示绿。

`register-boot` 在持有现有voice进程锁后建立新generation；保留未恢复episode/streak。每次输入绑定generation+producerEventSeq（本generation从1开始，仅作入站幂等键）；旧generation及重复event不再执行。**observationSeq/changeSeq是helper在事务内分配的sourceId范围全局单调序号，跨generation绝不重置**；投影只消费此全局changeSeq，不能拿producerEventSeq作cursor。wrapper启动拒绝以独立startupAttemptId写startup事件，不能覆盖活跃generation；锁冲突仅在没有近期活跃拥有者健康证据时作启动故障，正常重复启动不把健康实例判坏。source重建必须新sourceId，旧故障保留unverified，不自动关闭。

### 需求门：不把休眠当故障

需求唯一权威是StateStore的会话及转移原因，范围为该主机承接的全部项目的provisioning/desired/claimed/warming/live/ending非终态会话及其现有deadline，并保留尚未满足的失败请求（见下文）。以全局daemon服务为一单元，不看显示名，不由PID猜需求。新增StateStore事务内 `voice_health_demand_events`（AUTOINCREMENT eventSeq）及三个数据库trigger：AFTER INSERT、AFTER DELETE、AFTER UPDATE OF state, reason, cancel_requested_at, ending_started_at, ended_at ON voice_sessions；UPDATE仅在相关值实际变化时append。记录sessionId/project/meeting身份、旧新状态、时间、取消事实与封闭reasonClass，不存token/任意错误文本。**不在9个调用点手工递增revision**，动态UPDATE与reaper也由同一trigger结构性覆盖，事务rollback会连event一起回滚。

`getVoiceDemandSnapshot(afterSeq)`在一个读事务里取当前非终态集合、持久eventHighWater（取分配器高水位，不用可能被retention清空的MAX(剩余行)）、以及afterSeq后的有界事件；snapshotDemandDigest按规范集合内容hash。现有voice runtime startup/3s tick读取，串行投影到helper `record-demand`。只有“eventSeq相同且digest相同”才是幂等重放；同seq而digest不同是schema/trigger缺口，立即demand_source_unavailable，不能保留none冒充健康。较旧seq拒绝但不清已知故障。Bridge incarnation续用StateStore全局eventSeq；数据库重建或回退需新的demandSourceId，首次全量rebase为unknown直到核对，不复用旧cursor。

分页每次最多200事件；hasMore=true时nextCursor只到最后已交付event，不能跳到eventHighWater，且不依据尚未追完的当前空集合宣布none。最后一页才在同一读事务附完整当前集合+digest+该事务高水位。helper确认事务写入后Bridge才推进消费cursor；gap/截断保持unknown和旧故障。

迁移先在一个事务中安装表/trigger，再读取当前集合创建baseline（旧failed历史只记unverified，不重放告警）。trigger存在性/SQL摘要在startup校验；缺失时需求unknown并保留已有故障。retention不得删未消费事件；cursor落后至已裁剪段时必须标gap并重建当前集合、保留未解决事件，不能用空历史推恢复。

- demand=none：无非终态且无本地active/recovery工作时允许dormant；没有PID、旧lastSuccess、未启动producer都不触发stale。页面“无会话需求/正常休眠”，保留最近成功时间；并非声称本次尝试已成功。当前常驻idle仍记录成功/失败诊断，但无需求时不发会话不可用告警。
- demand=required：没有进程也能由Bridge现有tick发现，从desired创建/要求启动的实际时间算60秒未ready；已存在explicit startup failure立即告警，连续错误到阈值告警。claimed/warming不能充当live；超过60秒仍未live产生startup_not_ready。真实基线创建→starting5.2秒+starting→live46.9秒，仅一条样本，不能作为长期分位数。
- demand=unknown：Bridge尚未提供权威快照、schema损坏或最新none快照超过90秒且无法读StateStore时显示需求未确认；不能当none清故障，也不只凭PID缺失新增会话失败。最近required保持未解决事实直到更新的权威快照关闭它，不能过TTL自动转none。已有事件继续保留投递与可见性。
- 成功的完整迭代仍清连续失败；取消需求是另一终结方式：StateStore证明对应需求由明确取消操作终止（或正常完成且无未满足失败请求）后，将仍未恢复的事件标 `closed_not_required`，停止旧告警重试，保留原因和“需求已取消，未证明恢复”，不写lastSuccess或增加successCount。本地仍活跃时不允许none压掉活跃会话故障。
- Bridge side projector读当前StateStore与health source联合展示，不以镜像延迟将最新required显示dormant。daemon独立告警worker在Bridge暂不可用时沿用最后required；none/unknown只保留诊断/本机fallback，Bridge恢复后用实际需求历史与结果重新评估。需求变化后的陈旧generation不能覆盖较新需求revision。

**防止失败后自动消警：** 会话因为provisioning_failed/session_create_failed/lease_lost等故障被系统置failed，并不等于用户取消需求。getVoiceDemandSnapshot同时携带自上次revision以来的终态转移原因与需求identity；helper事务锁存未满足的attempt直到同需求后继会话有完整成功，或可信控制面明确取消。失败终态立即记录确定的会话不可用事件，不等三个完整会话失败；后台正常no_human/用户stop不是依赖故障。首次升级已有failed历史不自动重放为新需求，只显示历史未验证；从本次受控观察到的required→failed要持续可见。不得仅凭“当前非终态数=0”熄灭刚发生的进房故障。

以上是2693兼容2701的观察合同，不触发启动或停止进程；唤醒与idle退出仍归2701。需求读取/投影属于既有Bridge tick，不增加常驻voice PID。新增revision表/字段也需schema/retention和transaction回归。

### 阈值及恢复

- **在demand=required时，连续3次完整迭代失败，或首次失败后60秒无有效进展**，开一个episode并立即持久化通知意图。按默认2s timeout和退避，第3次最迟约21秒；60秒守卫覆盖长任务卡住。调度暂停/主机睡眠下不能保证墙钟硬实时，醒来立即重新评估并显示陈旧。
- 活跃模式不能用runOnce未返回判卡住：每次成功lease renew只更新内存lastProgressAt（工作仍在推进的证据），持久健康快照最多每20秒一次，首次进展/故障/恢复/退出则立即flush，但不冒充lastIterationSuccessAt、不清除未被完整成功验证的故障。固定页显示“通话中/最近续租”，并保留之前待确认故障。
- 60秒守卫在required的failed-retrying阶段无有效进展时运行；startup-not-ready另按desired→live的60秒界限，不能靠进程/claim刷新此界限。其余required情况下，idle状态lastProgressAt>60秒为heartbeat_stale，active状态以renew progress>60秒为stale（lease本身通常更早安全结束）。首启无记录有60秒宽限，缺字段为unknown，不为健康。
- daemon内有一个轻量健康watchdog，只评估不阻塞lease。Bridge既有tick读持久记录也评估stale；daemon事件循环完全冻结时由Bridge侧发现。若Bridge与daemon都挂/主机休眠，不承诺外部频道实时到达；保留本机证据、恢复后补读，并显示source unavailable，不假绿。
- **恢复规则按scope隔离，优先于任何泛称“完整成功清故障”的文案。** 一次完整idle_success清poll的failureStreak/firstFailureAt、记lastIterationSuccessAt，只能关闭poll_dependency事件及取消它自己的未发送意图。它绝不关闭session_unavailable、不取消其通知，也不把startup_not_ready/进房失败判恢复。正常session_ended仅在该会话曾有明确live证据且正常结束时构成会话成功；对应需求的后继会话取得live+至少一次有效续租也可关闭该需求的session_unavailable（不必等整场会议结束），写独立sessionRecoveryProof，而不是伪造lastIterationSuccessAt。无关联新会话成功不能清旧需求故障。
- demandId对meeting使用稳定meetingId，对manual使用首次请求sessionId；若现有API没有显式retryOfSessionId链，本单不按同项目或相邻时间猜关联，旧manual事件仅由可信显式取消关闭并标未证明恢复。新增retry关联能力可交2701评估。poll恢复与session恢复各自独立，服务可以“最近空转成功但进房故障仍open”。session_failed/GET单独成功/alive/重启/旧generation成功均不能恢复会话事件。startup配置故障同样归session_unavailable，需相应需求真正ready或明确取消。
- 计数清零不删除历史failureCount。恢复后再次失败新episode；重复失败不逐圈刷频道，无周期性再发。长时间故障由固定页持续展示。已知限制：一次频道消息可能被流量淹没；此版本不承诺多日重复提醒，归Flywheel Engineering Lead通过现有固定页巡检负责持续处理。老化再提醒作为非阻断Follow-up，由Lead决定频次/预算，不在本单新增调度器或冒用同intent绕过去重。

### 源库并发与封闭原因

SQLite journal_mode=WAL、synchronous=FULL、busy_timeout=100ms；每次短BEGIN IMMEDIATE事务只做DB读写，不含网络/子进程等待，500ms外层deadline内至多一次20–40ms随机退避重试。超时后不能假设未提交：用generation+producerEventSeq重试查询去重记录；意图/结果事务必须整体commit或rollback。故障输入在待重试小日志（同安全根、原子文件、≤1MB）持久保存直到DB确认；满或不可写显式observation_unavailable+meta-alert，不丢完还报健康。读者保留最后故障；checkpoint有界由helper低频执行，不在lease路径。双写者争用测试必须证明最终写入、无伪sent/恢复。

reasonClass是唯一可以进入projection/频道/HTML/Markdown的封闭枚举：bridge_connect_failed、bridge_timeout_headers、bridge_timeout_body、bridge_auth_rejected、bridge_http_error、bridge_protocol_invalid、startup_config_invalid、startup_lock_unavailable、startup_not_ready、session_create_failed、session_runtime_failed、lease_lost、heartbeat_stale、health_observation_unavailable、demand_source_unavailable、unknown_failure。operation另有封闭路由词表。所有任意Error.message和raw reason只作内存分类输入，不保存/投影/插入stderr；不接受“先escape再发布”。未知错误只映射unknown_failure，本机诊断也只允许causeCode/已清洗origin/时长等列举字段。

## 4. 通知合同：复用2669通道，新增kind

新kind **voice_daemon_unhealthy**：owning_lead / none_escalate，普通工程通知，不建ARC修复工单、不自动重启、不默认@founder。

同步消费者：`LeadAlertNotifier.ts` union/INFORMATIONAL_KINDS/queue/drain/recorder；`bridge/{kind-contract,ticket-owner-map,alert-kind-copy}.ts`；`scripts/lead-alert.sh` 白名单/informational/冻结payload/strict-delivery。同步kind parity、copy、echo/路由测试；异步execFile不匹配现有child-process-census的sync/spawn扫描，本单不新增虚假条目、不扩大扫描器范围，保留既有census回归。

新增内部 `--voice-intent <id>`，仅voice kind允许；helper从受信源库读冻结payload，不允许任意标题/频道覆盖。复用2669工程主路由resolver和sender权限预检：Flywheel配置里的工程Lead频道，默认无副路由；同一主机daemon故障只一条，不为所有项目复制。保留主机/服务展示名，不发敏感配置。

queue采用明确voice envelope（voiceSourceId/voiceIntentId/voiceRouteKey/voiceBindingDigest），不是shuttleBatchId。首发与drain都重读来源、活动episode、当前可信binding与权限。binding变化时未sent意图重解析合法路由，原receipt与旧尝试保留；不允许旧队列转往任意频道。恢复的未发送通知取消；inflight不确定发送保留unknown，迟到receipt只补历史，不能重开故障。

通知状态沿用语义 pending/sent/queued_transient/delivery_unknown/dead_lettered/config_error/cancelled_recovered。sent必须有真实channel/message回执；duplicate只有claim不算sent。明确未发送/429可以按既有队列重试；POST结果不明不盲重发。用intentId作为eventId/signature，claim原子获取，过期inflight无确定未发证据转unknown而非补发。

阈值时即异步调用既有shell发送链，不依赖Bridge HTTP成功；Bridge不可达也有本地持久意图和meta-alert兜底。发送不得阻塞daemon/lease；worker单飞、一意图一claim、有界deadline。恢复及startup失败使用同一source。wrapper与cli的配置/锁/顶层fatal按下述bootstrap规则覆盖；helper不可用时保持原退出码/监督行为并保留本机fallback，绝不为告警引入启动循环。

### wrapper最早失败的bootstrap路径

在source host-config之前设独立只用于告警的bootstrap spool：固定`$HOME/.flywheel/voice-startup-spool`（HOME来自服务运行身份；不读坏host.json、不让.env改它）。使用固定wrapper目录的helper启动子命令，参数是封闭reasonClass+startupAttemptId，不包含路径/error文本；owner/non-symlink/权限检查后原子写入一条事件。host config成功后正常source使用解析后的state root；失败时spool仍可读。Bridge的健康适配固定导入该同用户spool并按attemptId幂等落源库，所需已知required需求在Bridge既有tick上关联服务；不得根据spool文件自称的project/channel路由。

当生产helper本身缺失/解释器缺失或bootstrap路径不可写时，只能原有stderr+meta-alert，本设计诚实标为本机fallback；required/no-ready独立的Bridge guard仍在60秒触发频道/固定页，不依赖wrapper写成功。Bridge也不可用期间无法承诺远程即时提醒，恢复后补评估。新增“host-config.sh缺失”“坏host.json/自定义state root”“helper缺失”三组隔离测试，验证前两种事件可导入、第三种不会被错误标sent或健康；不改变现有exit0/KeepAlive行为。

## 5. 固定页与巡检

新增 `bridge/voice-health-projector.ts` 接既有GatePoller tick（单飞每20ticks约60秒，启动立即读），复用现有refresh机制。只读helper export；stale评估及通知意图写入走同一helper事务，以service/generation/seq条件更新，避免覆盖刚到的成功。首次失败通知由daemon立即尝试，页延迟上限为一次60秒cadence+既有publication耗时。

新增StateStore voice_health_projection/cursor（迁移、schema fixtures、retention registry整套登记），按sourceId+seq单调应用；来源读取错误保留最后故障并显示unavailable。

页面新增可选 **voiceHealth.v1**，与deployment并列，不伪造班次/落后提交数。`epic-page/{model,generate,materialize,attention,attention-presentation,attention-budget,optional-budget,render-html,render-markdown}.ts`及来源provenance共同更新；JSON/HTML/Markdown同源。展示服务名、运行模式、最近完整成功、最近进展、连续失败、原因、故障开始、通知状态、日志位置的允许basename。首次达阈值即活动故障/待处理，恢复后移出活动区留历史。

旧版无健康source显示“尚未采集”；记录陈旧显示“未确认/数据陈旧”；不把running或unknown显示健康。预算超限优先保留活动故障/投递未知与截断警示。派生文本HTML转义，DOM只用textContent/value。不能把此健康状态当ship/approval authority。

## 6. 实施切片与真实回归

各切片先写会失败的测试，最小实现，再重跑。使用fake clock与隔离temp根，禁止测试连接真实Discord/生产库。

1. 复核2669合入及实际PID变量；保存脱敏生产基线（日志计数、同配置只读runOnce与局限）。在 `voice-codex/src/__tests__/bridge-client.test.ts`（新增）和config测试中验证2xx坏JSON/正文stall不能算成功、token不出日志、请求operation正确；最小修复解析和诊断。现有lease测试保持绿。
2. 新增 `daemon-health.test.ts` 及helper Python测试（稳定40分钟活跃helper健康写≤122次；双写者锁争用+超时已commit重试最终仅记一次；故障spool重启重放幂等）。**demand=required下真正运行VoiceDaemon.run + 永远抛错fake bridge**，三失败前无告警、第三次一意图；完整idle成功一次清poll计数/关闭poll事件，再失败新episode。替换掉故障分支的写健康调用时测试必须红（变异体阳照）。测试session_failed后立即idle_success仍保持session事件open且通知必须可送达、对应live+续租才恢复；测试返回session_failed不误判成功、长通话续租不误报stale、旧generation/重复seq不覆盖、重启不清episode、存储失败不显示sent、60秒守卫、取消不算故障。
3. 接wrapper/cli启动全路径；现有 `scripts/__tests__/flywheel-voice-wrapper.test.sh`、新增startup-health集成：缺env/key/坏配置/初始化throw/锁helper失败产生持久意图，健康owner下重复启动不告警；只捕获sender，不发真消息。保持现有退出码和KeepAlive合同。
4. 接完整kind/队列/recorder；新增 `voice-health-alert-delivery.test.ts` 和shell捕获测试。源→阈值→真实lead-alert组装→捕获工程channel→sent receipt→页projection一条链。覆盖Bridge断开、Discord429、权限错误、unknown POST、duplicate无receipt、drain binding变化、恢复旧队列取消、迟到receipt不重开；2669行为回归不变。
5. 接StateStore/投影/固定页；新 `voice-health-projector.test.ts`、`epic-page/voice-health.test.ts` 覆盖no-demand/no-PID正常休眠、required/no-PID超时告警、required/warming超时告警、unknown不假绿、旧none不能覆盖新required、required→failed不自动消警、取消需求不伪成功、旧版缺失、损坏、stale、跨host隔离、out-of-order、超量裁剪与escaping、恢复消失。跨两个generation验证全局changeSeq不回退且投影连续更新；注入含token/绝对路径/恶意HTML的Error.message，断言全部projection/HTML/Markdown无该文本；retention/schema closure验证新增表。Python/shell新套件显式登记 `.github/workflows/ci.yml`，零测试收集失败。
6. 运行目标检查：`pnpm --filter flywheel-voice-codex test:run`、`pnpm --filter flywheel-voice-codex typecheck`；teamlead Vitest上述目标与kind-contract/ticket-owner/copy/shuttle回归；shell wrapper/sender新套件；Python health suite；CI enumeration和schema/retention检查。以仓库当时脚本名为准并在QA报告留确切命令/数量/结果。设计阶段不宣称这些检查已执行。

### 实机验收（后继QA/正常部署流程拥有权限）

- 正常updater部署后记录准确build、host/service/bootId、schema；从**运行中的daemon**获得success heartbeat+持久lastIterationSuccessAt+observationSeq相互对应，不能以本设计隔离探针替代。
- 按批准QA操作仅断开该daemon的依赖，记录注入时间、3次连续失败/≤60秒守卫、真实工程频道messageId/URL、固定页对应episode与送达状态。不要停全局Bridge来扰动其他业务；用受控独立实例/批准的限定故障注入。
- 恢复依赖→真实完整idle成功→streak0/episode关闭→固定页下次刷新熄灭。start-up fault另走同样链，并证明重启不伪恢复。
- 新每次失败均能定位operation、phase、cause与时长；旧75条维持不可判定项。超时如果仍发生按这些证据继续最小修复，不以加大timeout代替归因。
- FLY-2655另验；两单均过后自己先live≥60s再对founder说可试。此计划/评审/HTML不构成生产验收。

## 7. 按需启动方案与拆单建议

Lead已在question 27abc2a2-cefc-4e70-97e9-b6a1976fa98b裁定拆单并创建FLY-2701。此节作为2701可继承附录，本节点不建单或派发。约涉及Bridge会话生命周期、launchd、安装/部署/巡检、daemon退出协议五组，非小修。

- `voice-session-provisioner.ts` desired CAS成功后非阻塞请求唤醒；`voice-session-runtime.ts` startup及3s tick重新扫描desired，作为持久待办；`voice-session-services.ts`注入固定service label的有界唤醒器。
- `supervisor_start/trigger`使用不带-k的kickstart，绝不restart正在通话的实例。不从API传入任意命令、label、UID。
- 重复/失败/崩溃后重试直到实际claim；wake accepted不是claim。状态写入与唤醒之间崩溃、空读后新desired与旧进程退出交错，都由持久扫描补偿。会话claim CAS与进程锁仍唯一。
- idle持续120秒、每次成功null、无active/inflight/recovery work才exit0；失败不计空闲。退出最后读后仍有竞态，不能单次检查证明安全，需扫描补偿或generation退出握手。
- 安装器接受registered+dormant；巡检只在desired或active时要求进程和实际进展，部署不能无故唤醒休眠进程；`restart-voice.sh`及restart-services依赖重启路径同步调整。
- launchd SuccessfulExit隐含RunAtLoad。若founder允许注册时一次短空启可保留on-failure后idle退出；若要求从不空启，需要另选监督契约并证明非Bridge父进程+崩溃拉起，不能简单删RunAtLoad交差。
- 保留现有短Bridge中断lease容忍和长中断fence；不得宣称任意Bridge重启不断线。崩溃“接回旧通话”是新增语义，应明确另设计rejoin/音频/投递去重；现有recover仅安全收尾，不能借此计划扩大权限或偷偷放宽lease。
- 验收：需求前无PID、到点meeting/耳机desired后claim/live、idle退出、退出临界新会话不漏、Bridge重启补wake、重复wake不中断、启动失败告警、短中断同租约继续、长中断安全停止、部署不唤醒休眠。此方案符合方向但未实施。

## 8. 迁移、回滚与风险

首次升级health缺失显示未采集；StateStore明确无需求时显示正常休眠，required时首个完整成功才证明迭代健康；无历史成功数。新schema向前迁移，sourceId与incident历史不清。回滚代码仍保留源库/投递状态，旧读者显示未采集/陈旧，不删除活动故障。停止新producer不发送恢复。既有voice会话/lease数据库无语义迁移；本单不动启动方式/生产env/自动重启。

共享sender无法在网络隔离时保证频道即时可见，unknown投递可能有消息但无回执；页如实呈现。health helper若太慢/写失败会降低观测质量，必须有压力与故障测试；不能阻塞实时音频。恢复页更新以publication实际receipt为证据，非仅源状态改变。

### 附录A：2701继承的三个难点与候选

| 难点 | 候选做法 | 风险与推荐 |
|---|---|---|
| desired持久化与唤醒非原子 | A仅POST后kickstart；B desired作为durable待办+启动/3s扫描；C新增wake outbox | A漏崩溃窗口；B复用现有状态最小，推荐，必须直到claim且限频；C可精确审计但新增状态与一致性负担，只有B无法界定重试时采用 |
| 最后空读与退出交错 | A退出前再查一次；B扫描未claim持续补wake；C原子退出generation握手 | A仍有竞态；推荐B并证明start遇到退出中PID的重试，限定启动延迟；C更严格但改StateStore/schema，若延迟要求不能容忍3s再选 |
| 安装/巡检把无PID当坏 | A维持running要求；B注册状态与demand/progress分开；C新独立唤醒常驻进程 | A违背按需；推荐B，改install/restart/patrol与休眠页；C增加一套常驻监督，违背减少常驻方向，不选 |

founder明确不采用常驻模式。2701不得选择长期空转；SuccessfulExit导致的注册时短空启仍需在其设计中明确处理，不得以此偷换成常驻。不能拿本单的健康心跳给休眠实例制造stale。暂停与退役必须是可信控制面状态，删除记录不等于健康。

### 附录B：idle timeout调参触发证据

保留默认2s。提出调参至少要一个有build/boot/operation关联的30分钟样本（空转时至少300个完整成功结果），含成功p50/p95/p99、timeout计数与时间、headers/body阶段、errno/status，以及同窗口Node事件循环延迟/主机睡眠标记。超时是右删失样本，不能把它当精确2000ms算进成功分位数，也不能由仅成功p99推断超时原因。

若窗口内至少3次desired timeout且无401/403/配置错/连接拒绝，并有对应事件循环延迟或隔离较长deadline只读对照请求最终成功，才向Lead提议仅调idle budget（候选5s）并附告警≤60s、尾延迟与负载对照；不自动修改生产env。若请求地址/凭据/协议错误则修该原因，延长timeout不成立。lease2s及fence始终不变。无足够样本或无相关证据，维持2s并标未判定。

### R1需求闭包验收（阻断修订）

迁移测试断言三个trigger定义精确存在；从数据库直接执行INSERT/UPDATE/DELETE（绕过StateStore调用方法）也必须产生日志，以证明新增未来写点被结构性覆盖。回归现有StateStore约3308 reserve、3402动态provisioning step、3432 failed、3492 claim、3583 setState、3625/3635 stop、3834/3876 sweeper全部实际路径；同事务回滚不增加可见事件。provisioning→desired以及短时间desired→failed发生在两个tick之间，也必须在下一snapshot中看到事件、不能只读最终空集合。故意drop trigger或制造same-seq/different-digest必须显示unknown并保留告警，不得显示dormant。
