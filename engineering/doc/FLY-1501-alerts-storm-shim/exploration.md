# FLY-1501 聚合告警+重启风暴上限+注入垫片 — 探索
Issue: FLY-1501 (https://linear.app/geoforge3d/issue/FLY-1501/v2批次2-聚合告警-重启风暴上限-注入垫片vendor-neutral)
日期: 2026-07-27
基于: 无(本文件夹首篇;上游=doc/engineer/plan/v2/design-FINAL-v2.md)

## 1. 任务是什么(一句话)

在已 merge 的 v2 地基(packages/v2-kernel,FLY-1497/#710)之上,设计三块批次2组件——**聚合告警(§3.1/§3.2)**、**重启风暴上限(§2.11)**、**vendor-neutral 注入垫片(§2.4a)**——外加三个前置实证台账项(OOM 阈值 48G 重校 / QA 凭据软窗 / codex-review-result CLI footgun)。本 issue 是三段式的 design 节点:只产设计文档,不写实现代码。

## 2. 设计终版对这三块的完整约束(已闭合,不重开)

设计链 R6→R13 已经把这三块的机制打磨到 APPROVED,我的设计工作是**把已批设计落成可实施的工程蓝图**(模块归属/接口/文件/验收),不是重新发明机制。以下是终版约束的浓缩(出处:design-FINAL-v2.md + design-chain/design-v7..v13.md):

### 2.1 聚合告警 §3.1(超龄聚合)
- detector tick 每分钟;per-recipient `DETECTOR_SQL`(已在 kernel 落地);收件人枚举来自 consumer registry。
- **N=1 也发**,无数量阈值;条件=某 to_agent 存在 ≥1 条 pending 超 30min。
- kernel **单 immediate 事务四步**:①以库内为准重算超龄集合(不信 detector 携带的 count)②episode upsert(open,target_kind='agent',target_agent_id=**subject**)或清账 tombstone ③payload 更新+`last_enqueued_tier` 单调推进 ④按 tier 变化插入通知 command(插入前先查抑制,见 §3.2)。
- **subject 与 notify recipient 分离**:`target_agent_id`=谁的信箱积压;`notify_recipient_agent_id`=事务内按当前监督关系实时推导(runner→owning Lead,Lead→founder);owner 换代重推导重路由。
- 通知 effect_key=**obligation 行 id+tier**(不复用 episode_key);清账事务内 cancel 未执行的通知 command。
- open 行 ≤1/收件人;历史 tombstoned 行保留审计;升档 30min→2h→8h,tier 单调,每档通知一次。
- **三 tier 计数**:`last_enqueued_tier`(已入队)/`suppressed_tier`(被抑制的债,nullable)/`last_notified_tier`(仅通知 command effect receipt 确认后推进)。
- 四道闸(P5 永不复发):聚合(单条消息独立告警路径不存在)/episode 唯一键(partial UNIQUE 已落库)/depth CHECK≤1 告警不生告警(已落库)/自动销账。

### 2.2 父抑制子 §3.2(定案=方案A)
- **command 无新状态**:被抑制的通知 command 恒 pending;抑制完全由 **dispatcher claim predicate** 承担(claim 条件=无匹配 open parent obligation)——commands CHECK 枚举不动,零迁移。
- 匹配键=静态抑制规则表(**设计常量,不是 DB 表**):(parent_kind, child_kind, 同 subject),如 (agent_down, mailbox_backlog) 按 target_agent_id 匹配。
- **claim 先赢仲裁**:已被 claim 的在途一条允许送达(单条在途窗口秒级、通知类低害);此后各 tier 均被抑制。
- parent-open 事务:只记 `suppressed_tier`=当前应通知 tier(债),不动 command。
- **parent-clear 原子清债**:①suppressed_tier>last_enqueued_tier→按最新 tier 插恰一通知 command(effect_key 唯一性防重放双发)+推进 last_enqueued_tier ②cancel 更旧 tier 的 pending 通知 command ③同事务 suppressed_tier←NULL ④送达 receipt 后才推进 last_notified_tier;reconcile 重复执行幂等。
- 验收:child-before-parent/parent-before-child/claim 后 parent open/父清账前后 crash replay 四交错(N39/N40/N44)。

### 2.3 重启风暴上限 §2.11(v13 终态)
- **kernel 外权威**:restart ledger=append-only `~/.flywheel/restart-ledger/<child_key>.jsonl`,每行事件带**单调 seq**(持久于行内),每事件 fsync;唯一写者=OS 级 supervisor wrapper(单一 authority,进程内监督不计数)。
- 状态文件 `<child_key>.state`:`{state, episode_key, window_start, last_resumed_seq}`;temp+fsync+rename+目录 fsync;state∈{active, held_alert_pending, held_alert_attempted, resumed}。
- **全部写者**(wrapper 启动分支/授权 resume 命令/恢复工具)同一 `<child_key>.lock`(**fcntl flock,fail-closed**:取锁失败=退出不 exec;macOS 无 flock(1) CLI→用仓库既有 Python fcntl helper)。
- **启动分支穷举**:attempted→退出;pending→不 exec,ensure-spool(create-once 幂等)+meta-alert→CAS attempted→退出;resumed→锁内**立即 CAS→active**(保留 last_resumed_seq);active→append 事件+fsync→**可重放谓词** `count(10min 窗口内 AND event_seq>last_resumed_seq)≥6 AND state=active`→真:原子 claim(episode_key=child_key+window_start)+spool(exactly-once)+meta-alert(at-least-once+stable key+sink debounce)→attempted 不 exec;假:exec child。
- resume=锁内条件写(仅实际状态仍 held_* 才生效);并发第二次 resume=幂等 no-op(不刷新计数下界);cursor 缺失=0。
- **meta-alert 是 kernel-independent**(wrapper 直连通道,不经 kernel/Bridge——kernel 死了也能报);kernel 恢复后 reconcile 读 spool,以稳定 episode_key 幂等建 obligation;外部 supervisor 永不直接写 flywheel-v2.db。
- 验收:全部 crash 点重放(N38/N41/N42)+resumed 再失败新 episode(N43 两子例)+并发 resume 交错+锁竞争 fail-closed+kernel 死时 spool+alert 照常(N33)。

### 2.4 注入垫片 §2.4a(v7 终态,无 ack)
- 契约 `InjectionShim`:仅两方法——`hint(runner_session)`(可丢门铃)+`deliver(runner_session, {message_uid, payload})`(把消息交 vendor 会话计算)。**无 ack 方法**:vendor 会话产出只能以带 generation 的转化 proposal 提交 kernel,垫片/vendor 永不翻转 mailbox 状态——"ack 与业务效果分离"的窗口结构性不存在。
- 垫片**无状态**(零持久化,崩溃即重启无恢复步骤)。
- Claude 实现=写 harness 原生监听的信箱文件(白拿注入;文件降级为纯注入介质,不再是 record);Codex 实现=走它的 turn/inbox 通路;新 backend 只实现 hint/deliver 两方法。
- 活性边界(§1.2b,FLY-1499 地盘):runner 由 kernel timer 实际查询 ready mailbox+**durable deliver**(重试至观察终态或 activation terminal),不依赖可丢 hint——**驱动是 1499 的,垫片只是被驱动调用的适配层**。
- 验收:①零持久化崩溃即好 ②新增 backend 只实现接口不改 kernel/schema(可插拔回归测试)(N11/N23)。

## 3. 已落地地基(我自己审计 packages/v2-kernel 的结论)

FLY-1497(#710,已在 main)交付的与本单直接相关的资产:

| 资产 | 位置 | 对本单的意义 |
|---|---|---|
| obligations 重建(0002 迁移) | `src/migrations/0002-obligations-rebuild.ts` | **告警 schema 已全量落库**:episode_key/target_kind CHECK('task','agent')/target_agent_id/notify_recipient_agent_id/last_enqueued_tier/suppressed_tier/last_notified_tier/depth CHECK(0,1)/恰一目标 CHECK/`obligations_episode_open` partial UNIQUE/task-only tombstone 触发器——本单**零 schema 迁移** |
| commands 表(0001) | `src/migrations/0001-base-schema.ts:72` | 8 态含 pending/claimed/canceled+`effect_key TEXT UNIQUE`+claim_owner/claim_generation/lease——通知 command 直接用,方案A 零迁移成立 |
| DETECTOR_SQL | `src/sql/candidates.ts:22` | detector 查询已锁定原文并过 EXPLAIN 验收,实现原样使用 |
| mailbox_pending_age 索引(0004) | `src/migrations/0004-mailbox-index-family.ts` | detector 命中索引已建 |
| Kernel.write | `src/kernel.ts:273` | BEGIN IMMEDIATE 单写事务+tx 预算+`cas(sql,params,expected)`(行数≠预期抛 CasViolation)+`requireIdentity`(fence)——四步事务/清债事务的执行底座 |
| FENCE 常量+registry | `src/fence.ts` | `consumerRegistryKey()`/`readRegistry`/AgentIdentity(lead/runner 两形)——detector 枚举收件人、subject→recipient 推导的数据源 |
| meta 表 | 0001 | consumer_registry 键空间宿主 |

**推论**:本单实现全部是**kernel 之上的写路径逻辑+kernel 之外的 wrapper 状态机+适配层接口**,不动 schema。obligations 缺一个东西:payload 列(§3.1 说 payload={count,oldest_age} 就地更新)——0002 的 obligations 没有 payload 列!这是一个需要在 research 确认的 gap:要么复用 `resolution` 列(语义不对),要么台账进 events,要么**需要一列**(ALTER TABLE ADD COLUMN 幂等迁移,轻)。→ research.md 裁决。

## 4. 现状审计(三路并行 Explore 结果)

### 4.1 重启/respawn 现状(风暴上限的落点,explore 审计已回)

**对设计有直接约束的三条硬事实**:
1. **wrapper 全部是 exec 型**(`flywheel-bridge-wrapper.sh:211-220`、voice-bridge `:93`、`flywheel-lead-wrapper.sh:186/:195`):exec 后进程里没有 wrapper 逻辑。ledger/判定只能在 **exec 之前**完成——与设计 §2.11 "启动 gate 在 exec 前完成全部判定,不要求驻留" 完全吻合;且现有 `bp_launcher_preflight`(`flywheel-bridge-wrapper.sh:130`)就在这个位置,但**超限从不阻断**(`bridge-port.sh:237-241` 注释明写 "Crash-loop alerting NEVER blocks the start")——"held→不 exec" 是行为变更点。
2. **现有计数原语全部达不到 §2.11 的持久化要求**:`bp_record_start_and_check_crashloop`(`bridge-port.sh:199-210`,append 明文 epoch+全量剪枝重写,无 fsync/无 seq/无锁);最好的两个(quota-monitor wrapper `:85-93` temp+chmod+mv 原子、bridge-liveness-probe `:98-114` jq+mv)仍无 fsync 无跨进程锁。
3. **重启额度现散在 ≥5 层互不知情**:launchd ThrottleInterval=30(**19 个 KeepAlive 单元**:Bridge/voice-bridge/cmux-watcher/quota-monitor+15 个 Lead)、bridge wrapper 60s/3 次(只告警)、dirty-exit 600s/3 次(只升级文案)、quota-monitor 600s/3 次(仍 exec)、claude-lead.sh **进程内**内存 CRASH_COUNT(≥5 告警,launchd 重启即归零)。唯一 fail-closed 到顶就停的先例=`phase-orchestrator.ts:229` `QA_RESPAWN_MAX=3`("dead rows are the durable ledger")。**设计的"单一 authority(只有 OS 级 wrapper 计数)"正是对这 5 层散账的收口**。

**可复用资产**:
- **Python fcntl helper 确认存在**:`scripts/flywheel-config-lock.py`(+`.sh` 封装;LOCK_EX|LOCK_NB 有界重试,超时 exit 75,FD_CLOEXEC 不泄漏)——§2.11 fcntl fail-closed 锁的现成底座;`tmux-server-rescue.sh:1590-1620` 另有 exec 继承变体(`os.set_inheritable+execvp`,命令本身成为锁 owner)。
- **meta-alert.sh**(`scripts/meta-alert.sh`,55 行):桌面通知+本地 marker 文件两通道,**本身不发 Discord**;debounce=marker mtime(默认 10min,`FLYWHEEL_META_ALERT_DEBOUNCE_MS`)——设计说的 "sink 侧 debounce" 即此。Discord 腿在调用方:`lead-alert.sh`(Bridge 挂了也能直 POST Discord;claims.db 去重+queue+deadletter;`--strict-delivery` 机器可读结果)。**§2.11 的 kernel-independent meta-alert=复用 meta-alert.sh+lead-alert.sh 双腿,零新通道**。
- episode 语义现成范式:`bridge-exit-marker.ts:17-22` 三重 dedup 身份(shared episode `bridge-abnormal-exit:<pid>:<bootTs>`);`bridge-liveness-probe.sh:65-96` 四独立 episode 各带 escalated latch;`~/.flywheel/state/tmux-rescue-episodes/`(117 条)。
- spool 现成范式:`report-deployed.ts`(原子 spool+机会性 drain+at-least-once+dedup_key,"never silently lost");self-ship `QueueDirectories`+"坏 marker 移去单独不被 watch 的目录防热循环";alert-queue/deadletter。
- hold 状态机现成先例:`tmux-server-rescue.sh` 的 hold_* 动词族+锁+episode 目录。

**监督树结构现状**(gate 的落点清单):launchd(KeepAlive)→ wrapper(exec)→ 服务进程。Bridge:`flywheel-bridge-wrapper.sh`;Lead(15 个):`flywheel-lead-wrapper.sh`→exec `claude-lead.sh`/`codex-lead.sh`——**注意 claude-lead.sh 内部还有 while true 进程内监督循环**(`:3157`,自带退避+内存 CRASH_COUNT),按设计"单一 authority"声明,进程内循环**不计数**,ledger 只记 wrapper 级(=launchd respawn)事件。Bridge 有自触发重启源(`StateStore.ts:1191` DB 不可恢复 process.exit(1) 交 launchd 拉起)。Runner **无 OS 级 supervisor 无 KeepAlive**(死了走 HeartbeatService re-adopt/QA respawn cap/Lead 判断),印证探索 §7-3 的边界:风暴 gate 一期只覆盖 launchd 管的服务。
- 手工重启已被 hook 硬阻断(`scripts/hooks/flywheel-restart-guard.py`,唯一合法路径=restart-services.sh)——gate 集成进 wrapper 不受影响,但 resume 命令的形态要考虑 restart-guard 白名单。
- 真实事故实证:`~/.flywheel/meta-alert/bridge_crash_loop.txt`(Jul 6)——crash-loop fail-loud 真发生过。

### 4.2 消息注入现状(垫片的落点,explore 审计已回)

**Claude 路径(现成,基本白拿)**:
- 信箱文件=`<CLAUDE_CONFIG_DIR>/teams/<team>/inboxes/<agent>.json`(`agent-team-transport/src/path-helpers.ts:110-117`);`deriveRunnerMailboxIdentity(executionId, leadId)`→`runner-<execId前8>`(`:163-168`)。
- 写入=`ClaudeMailboxCodec`(proper-lockfile 与 stock 逐字段一致+temp+rename+**sidecar flywheelId 幂等去重**——重复 deliver 天然收敛为 accepted_duplicate)。
- 发现=claude-code 二进制内建 `useInboxPoller`(1000ms,非 flywheel 代码);`createReceiver()` 返回 null(`wakeMode:"builtin-receiver"`)。at-least-once。
- **FLY-142 的 `agent-team-transport` 就是现成的 vendor-neutral 传输层**:5-facet `IAgentTeamTransport`(Writer/Reader/ReceiverWake/Spawn/Preflight),`TransportCapabilities.wakeMode: builtin-receiver|external-watcher|push-only`。

**Codex 路径(现成)**:
- Runner:自有信箱格式(`~/.flywheel/codex-teams/.../inboxes/*.json`,单对象 `{messages:[]}`,O_EXCL 锁)+`CodexMailboxWatcher`(fs.watch+1s poll)→`enqueueRunnerPhaseWake`(CommDB ledger)→`reactivateWake`→**JSON-RPC `turn/start` 注入新 turn**(goal paused 时先注 turn 再 set active;`codex-daemon-client.ts:853-870`)。**不是 interject**(`turn/steer` 只在 Lead 侧有封装,Runner 未用)。
- Lead:Bridge→unix socket(HMAC)→`LeadInputRouter.submitBatch`(journal durable accept+串行 pump)→`CodexTurnExecutor.startTurn`。
- TUI=`codex resume --remote` 只读渲染,不经 send-keys。

**hint(门铃)语义的现成原型**:`lead-inbox-nudge.ts:31-60` `nudgeLeadInboxBestEffort`——注释原话 "Best-effort doorbell ... The queue row is the authority; this request only shortens the next adaptive poll interval",200ms 超时。**设计 §1.2a 的门铃语义在 v1 已有逐字对应物**。

**vendor-neutral 注入契约的最接近先例**:`lead-delivery-adapter.ts:37-39` `LeadDeliveryAdapter { deliverBatch(batch)→DurableAcceptReceipt }`+Claude/Codex 两实现(FLY-1373)——注释点出两 vendor 语义差:"Codex consumes one packaged turn; Claude writes members atomically and its stock poller packages the unread snapshot into one turn"。

**transport 解析(垫片选型的路由现状)**:`role-adapter-resolver.ts:49-56` `EXECUTOR_TO_TRANSPORT`(claude-tmux→claude-code/codex-tmux→codex/antigravity+kimi→none);no-transport 三层防线(runner-wake isNoTransportBackend/send CLI 大声跳过/DecisionLayer HR-PR-HANDOFF)。

**kernel HTTP API:不存在**。`packages/v2-kernel` 纯库(仅依赖 better-sqlite3),无任何包依赖它;Bridge HTTP surface 在 packages/teamlead(express)。设计里"垫片只读 kernel API 的 pending"在 batch 2 时点=直接用 Kernel 库接口,HTTP 面是后续接线问题(1499/batch 3 协调点)。

**tmux send-keys 注入**:存在但被定位为受限 fallback(recovery-nudge allowlist=["continue"]/terminal-mcp 手动),不是常规投递通道——垫片不应建在它上面。

**对垫片实现的直接结论**:
- Claude deliver=写 harness 信箱文件(复用 ClaudeMailboxCodec;sidecar 幂等使重复 deliver 无害);hint=可实现为 no-op 或轻量门铃条目(builtin 1s poller 使 deliver 本身即低延迟)。
- Codex deliver=`turn/start` 注入(复用 daemon-client 通路);重复 deliver 会重复 turn——设计已声明"deliver 可重复,消费幂等兜底"(v8 §1.2b),可接受;hint=可实现为轻量 doorbell turn 或 no-op。
- 两实现都无状态:去重/锁都在介质侧(sidecar 文件/O_EXCL),垫片自身零持久化,符合 §2.4a 验收①。
- `InjectionShim` 代码尚不存在(全仓确认,仅设计文档提及)——接口由 1499 定义(Tadashi 裁定),我实现两份。

### 4.3 告警通路现状 + 台账三项现状(explore 审计已回)

**A. 现有(v1)告警通路全景** — 新聚合告警的"被替代对象"与 meta-alert 的"复用对象":
- 产生:`packages/teamlead/src/LeadWatchdog.ts`(10min tick,pattern-first;`computeEventId=sha1(project|lead|kind|signature)` 与 `scripts/lead-alert.sh` 字节对齐)。FleetSensors/AlertChannelHub 都搭 `onPollComplete` 车(零新 timer 规范,FLY-169)。
- 投递:`LeadAlertNotifier.alert()` 5 步:claims.db 快读→原子 claim(BEGIN IMMEDIATE)→lead_events UNIQUE→resolveChannel(失败=deadLetter)→速率闸(20/min 生产)→Discord POST。
- shell 兜底:`scripts/lead-alert.sh`(699 行,Bridge 挂了也能发;21-kind 白名单;默认 signature=UTC 日期=同日同 kind 只发一次;queue=`FLYWHEEL_ALERT_QUEUE_DIR`(默认 `~/.flywheel/alert-queue`),deadletter=`FLYWHEEL_ALERT_DEADLETTER_DIR`;claims.db=`~/.flywheel/alerts/claims.db`,含 alert_claims+alert_deliveries lease 状态机)。队列消费者=Bridge `drainQueue()` 每 60s。**这条 Bridge-independent 通道就是 §2.11 meta-alert 的现成落点**。
- 降噪:FLY-220 episodeKind latch(`LeadWatchdog.ts:520-528`)+echo immunity(`ALERT_EVENT_TYPES` 单一真相派生 `ALERT_ECHO_START`)+FLY-218 529 短路+`tui-window-alert.ts` 的持久 episode 文件 latch(in-proc latch OR 文件,跨 KeepAlive 重启)——**v1 已经在向"episode 化"演化,但都是 per-kind 手搓;v2 §3 是它的结构化根治**。

**B. OOM/内存压力(台账1)现状**:
- 传感器:`packages/teamlead/src/bridge/machine-watermark.ts`。信号=freePct(纯页数比:(free+inactive)/Σ7桶)+swapoutDelta(Swapouts 计数器两 tick 增量)。
- **阈值**(`memPressureThresholdsFromEnv:122-142`):`FLYWHEEL_MEM_FREE_LOW_PCT`=8(触发)/`FLYWHEEL_MEM_FREE_HIGH_PCT`=15(恢复)/`FLYWHEEL_MEM_SWAPOUT_MIN_PAGES`=**0**(任何一页 swapout/tick 即 danger)。注释自认 "provisional, calibrated against the 2026-07-10 box"。触发=连续 2 tick;释放=首个 healthy(freePct≥HIGH 且 delta≤MIN 且 delta 可算);null 永不释放。
- pressure-hold:hold 的是**新 runner 派发**(`runner-admission.ts tryAdmit` 第一检查),持久单行表 `fleet_pressure_hold`;sensor-owned hold 才可自动 lift;page debounce 120s;broadcast load-shed 幂等。
- **全仓零机器内存规格适配**(hw.memsize/totalmem 零命中);48GB 只在注释里。`FLYWHEEL_SWAP_PRESSURE_HIGH/LOW_PCT` 是死旋钮(truth.ts 登记、无读取方,生产 .env 残留 =99 失效值)。
- **白挂机理**:swapoutMinPages=0 → macOS 偶发良性 swapout 即 danger→hold;释放又要求 delta≤0+freePct≥15%,抖动下 hold 粘住。百分比阈值在 48G 上语义漂移(8%=3.84G vs 16G 上 1.28G)。

**C. QA 凭据软窗(台账2)现状**:
- 代码里无 "soft window" 标识符;软窗=`workflow_submission_credential.expires_at`,absolute deadline=`absolute_deadline_at`。
- 两处硬编码:legacy 三段式 `run-infra.ts:637-639`(30min/2h);workflow engine `workflow-engine-dispatcher.ts:1668-1672` 及 rotation/repair 各处(60min/24h)。**无 env 旋钮、无按 QA 类型分支、无预约机制**。
- mint 不变式(expires≤absolute,6 处同款)、过期判定 `workflowExpired`(≥ 即过期,NaN fail-closed)、提交三处检查(`credential_expired`)。
- **决定性事实:`renewWorkflowDecisionCapability()`(StateStore.ts:26887,"extend expiry but NEVER past the absolute deadline",过期不能复活)已实现+有测试,但零生产调用方(无 route/无 CLI/无心跳)**——续期杠杆现成,只缺接线。
- 真机实证:FLY-1434 qa-report.md:65(60min 软窗到期挡真 Discord E2E)。

**D. codex-review-result footgun(台账3)现状**:
- CLI(`flywheel-comm/src/index.ts:1383-1404`):5 个参数全 optional,无 usage 守卫(对比 await-codex-gate 有)。
- emitter(`commands/codex-review-result.ts`):execId/issueId/project/bridgeUrl 全从 env 兜底;`prHeadSha` 无参时**自跑 git rev-parse HEAD**;`status:"APPROVED"` 在 :72 硬编码且类型焊死(:50 literal);POST `/events` 免凭据(仅可选 ingest token)。
- Bridge 端(`event-route.ts:1085` → `auto-qa-coordinator.ts:941-1008`):payload 自述校验全过即 `recordCodexReviewApproved`,可直接放行 auto-QA。authorFamily 从持久 adapter_type 推(payload 不可信原则),**但 status 无服务端权威来源**。
- 设计内唯一合法调用方=`await-codex-gate.ts:43` 程序化调用 emitter。
- 相关决议留痕:FLY-1244(不进 capability 迁移,只洗 marker)、FLY-1436(emit 后跑 progress 会推 head 作废记录)、FLY-887(真实误发生产事故一次)。

## 5. 与并行单的边界(1499/1500,防撞防漏)

| 接口 | 我方(1501)提供 | 对方消费/提供 |
|---|---|---|
| 通知 command 的 claim 抑制谓词 | 谓词定义+SQL/函数导出+抑制规则常量表 | **1500** dispatcher claim loop 在 claim 通知类 command 时调用 |
| last_notified_tier 推进 | receipt 时点的推进函数(与 obligation 绑定) | **1500** effect receipt 事务内调用 |
| detector 收件人枚举 | 消费 consumer registry(fence.ts 已有 key 约定) | **1499** 注册事务写 registry |
| InjectionShim 契约 | **接口定义归 1499**(packages/v2-engine,消费侧契约主人;Tadashi 裁定 7e8e6aca)——我对接口的方法/字段需求提给 Tadashi 转 1499 收口,不自定义类型 | **1499** 定义接口+runner 驱动(kernel timer+durable deliver) |
| InjectionShim vendor 实现 | **Claude/Codex 各一份 hint/deliver 实现**+零持久化验收+可插拔回归测试 | 实现 1499 定义的接口 |
| 单实例 tick 互斥 | detector tick 的可调用实现+互斥要求声明 | 与 1499 due scheduler/retention tick 共用同一 tick 机制(协调点,batch 3 接线) |
| 通知 command 的实际外发 | 只负责 INSERT(pending+effect_key) | **1500** dispatcher 执行真实 Discord 外发+effect receipt |

文件层面:三单都会动 packages/v2-kernel——各自新模块文件(alerts.ts / consumption.ts / dispatcher.ts 之类),互不改对方文件,冲突面≈仅 index.ts 导出行。

## 6. 台账三项(前置实证,设计必须给出裁决)

1. **OOM/内存压力阈值 48G 重校**:Cass 实测 free 15%/swapout 噪声线按旧 16G 机校,48G 机上过度触发→pressure-hold 白挂。(现状代码/阈值位置待 4.3 回填)
2. **QA 凭据软窗错配**:真机长观测 QA(50min-2h)必然超 30-60min 软窗(1496/1497 两单实证)→软窗按 QA 类型可配置或开跑时预约;absolute deadline 保留。(现状位置待 4.3 回填)
3. **CLI footgun**:`flywheel-comm codex-review-result` 无参调用即向 Bridge 写 APPROVED(动作伪装成查询)→无参=usage 报错;写入须显式参数+校验。(现状位置待 4.3 回填)

## 7. 需要 brainstorm 裁决的问题(带我的倾向)

1. **模块归属**:告警四步事务/抑制谓词/清债事务→v2-kernel 新模块(alerts 族,与 FENCE 同风格的纯函数 over WriteTx)?还是新包?**倾向 v2-kernel 内新模块**——它们就是 kernel 写路径("kernel 单 immediate 事务四步"是设计原文),且地基包已是它们唯一依赖。
2. **风暴 gate 语言/形态**:启动 gate 在 exec 前完成全部判定,不要求 wrapper 驻留。**倾向:独立可执行脚本(Python,复用既有 fcntl helper 先例)+ 各服务 wrapper 以「gate 先行」方式调用**;spool reconcile 投影函数放 v2-kernel(TS,kernel 侧)。
3. **风暴 gate 的 child 范围**:v2 一期只覆盖 OS 级 supervisor 管的服务(launchd KeepAlive:Bridge/Lead daemons);Runner 的重启是 Lead 判断层,不进本机制。**倾向:明确写进边界**。
4. **obligations payload 落点**(§3 gap):加列 vs 复用列 vs events 承载。**倾向:幂等 ADD COLUMN `payload TEXT`**(轻,一条迁移,tombstone/唯一键不动)。
5. **台账1 的落地时机**:48G 重校是 v1(现系统)配置修正+v2 告警设计的阈值模型两层。**倾向:设计给出两层——v1 立即止血的具体新阈值+v2 聚合告警里的机器内存感知模型**;v1 修正是否随本单 implement 落地由 Tadashi 拍。
6. **台账2 形态**:全局常量→**开跑时预约**(QA 起跑声明预计时长,软窗=预约值,absolute deadline 不动)vs 按 QA 类型配置表。**倾向:开跑预约**(自描述,不用维护类型表)。
7. **反 over-reaction 清单**:哪些属于"保护性机制,单独列出供 founder 砍"——初判:风暴上限的 resume 状态机全套(相对简单计数)、claim 先赢仲裁的收窄验收、三 tier 计数(相对单 tier)。设计文档已逐条给过"哪个场景需要它"(N 系列),plan 里要按 Annie 原则重列。
