# Flywheel v2 设计真终稿(R13 + 凌晨修正案 + FLY-1498/1500/1518 · 2026-07-28)
> 唯一权威来源链:founder 批准的 `v2-final-design.html`(SHA-256 `e0078266d1bb852a17e484d9aea0b7f14ad076a9f48c79bac9394f463f334b17`)→FLY-1498 `v2-final-approved-extract.md`(DAG/节点完成/ship 三条语义)→FLY-1500 `mapping-v2final.md`(actions 黑匣子修正案)→FLY-1518(引擎迁入 actions + 0008 删除退役表)。旧 R13 中与本稿冲突的 command outbox、集中动作执行/对账与病历卡表族全部失效；本文是上线与后续实现的唯一总设计。

## §T 术语表(大白话)
- **标已处理**(=队列 ack,等价 Redis XACK/SQS DeleteMessage):把一条消息 待处理→已处理 的状态翻转,必须与该消息的业务效果同一个数据库事务提交。
- **门铃**:消息入库后发给收件人的"你有新消息"唤醒信号;不带消息本体,允许丢(只降时延,不承担活性)。
- **转化**:处理一条消息=把它变成正确的账本记录(快答/建 task 派发/登记工作项),秒到分钟级;转化完成即处理完成,活本身由 task 层追踪。
- **claim/租约(已删,范围=mailbox 与外部 action)**:mailbox 两步占坑+超时回滚、集中动作认领与租约全部删除；消息靠 processing-attempt，外部效果靠 Agent 主动调用 actions 薄壳。
- **generation fence**:Lead/runner 每次换代世代号+1;旧世代任何写提交时被拒。
- **processing-attempt**:开始转化前落库的处理尝试记录,崩溃归因依据。
- **activation**:一次 attempt 与一个执行 session 的权威绑定。
- **T_max**:单条转化硬上限(默认 10min),超限=活着卡死→硬终止换代。
- **kernel**=唯一写库代码路径;**运行协调器**=只看 DAG/mailbox/heartbeat 状态并拉进程,不读业务内容、不执行外部 effect;**actions**=Agent 外呼黑匣子(`intended→succeeded|failed`),只记事实,不认领/执行/探测/自动重试;**invocationUid**=一次调用尝试的稳定幂等种子;**logicalEffectId**=一条消息内一个逻辑效果的稳定身份;**span_tip/writer_chain**=节点完成 span 与实际作者集合;**注入垫片**=消息进 vendor 会话的唯一适配层(hint/deliver 两方法,无 ack)。
- **backlog subject vs notify recipient**:积压的是谁的信箱 vs 告警发给谁(按当前监督关系实时推导),两字段不混。
- **三个 tier 计数**:last_enqueued_tier(已入队)/suppressed_tier(被抑制的 episode)/last_notified_tier(已确认送达)。

## 0. 目标与范围
- 前提条款:每 issue 的 task 数量与形状由该 issue 的 DAG 定义,三段式只是例子,机制不得隐式绑定三段式。
- 单一真相:flywheel-v2.db(SQLite)——消灭病根①(multiple sources of truth)的核心手段。

## 0.5 消息通道选型
唯一消息通道=SQLite,信箱表住权威库内(comm.db 与 JSON 信箱同时退役)。规模阈值:mailbox 未清理行>100k/库文件>2GB/WAL>64MB/oldest-unconsumed>30min/lag>500。retention tick 每 10min 单实例互斥,每 tick≤5000 行。不在线 VACUUM;每日 idle checkpoint;freelist>30%→维护窗口离线 VACUUM。过载:admission 拒 notice 类。retention_class:notice(applied 后 7 天删)/business(90 天归档)/dlq(30 天人工)。business 超期=单 kernel 事务(mailbox CAS pending→dead+唯一 decision event+typed durable mailbox,幂等);不建 obligation。
### 0.5a 为什么不用现成 MQ(对标而不引入)
唯一硬理由:外部 MQ 无法参与 SQLite 事务——"标已处理+业务效果同事务"是消灭病根①的手段,引入 broker=两个真相复活。语义全盘对标:通知可丢/存储是真相/at-least-once+消费端幂等/端到端 exactly-once 在外部世界边界不存在(库内单事务 exactly-once+边界幂等键)。DR 独立确认:"自研队列表比通用队列库更简单"(原子耦合业务状态)。
### 0.5b SQLite 写纪律 [DR]
写路径 BEGIN IMMEDIATE(选择性);每个可写连接必设 PRAGMA busy_timeout(连接工厂统一);写事务短(禁网络/LLM 调用);读者短命;仅本地盘;禁 BEGIN CONCURRENT。

## 1. 数据层
### 1.0 权威 schema(20 张表)
`actions` / `activations` / `agents` / `archive_manifest` / `attempts` / `capabilities` / `config` / `events` / `gates` / `mailbox` / `meta` / `processing_attempts` / `scheduler_leases` / `scheduler_repair_leases` / `scheduler_runs` / `schema_migrations` / `source_receipts` / `task_dependencies` / `tasks` / `thread_bindings`。全部进入迁移与备份合同。`agents` 是 Lead/runner generation 的唯一 authority；旧 meta consumer registry 已退出运行合同。0008 已删除三张退役表,但 checksum-bound 的 0001/0002 历史迁移逐字保留。
### 1.1 表要点
- tasks:forward migration 重建为稳定 DAG identity+`contract_json TEXT NOT NULL`(canonical JSON array)+`writes_repo INTEGER NOT NULL CHECK(IN(0,1))`+state;存量值只从 canonical task/admission descriptor 回填,缺失 fail closed,禁止按 kind/节点名猜。删除 `rework_of`、`lineage_root_id` 与 self-rework triggers;保留 task id 并做 foreign_key_check。task-local generation 由 attempts.generation+UNIQUE(task_id,generation) 承载,不复制 counter。**terminal/rework 规则**:无论 task 当前或历史是否 terminal,返工都在同 task 新建 attempt,不建 successor/回边。
- attempts:terminal_reason;每 task 至多一个 active attempt。`observed_state` / `observation_kind` / `observed_at` 三列仅为过渡兼容保留,生产路径不读取；退役归 post-launch 的 attempts 重建单,FLY-1518 不跨 FLY-1520 的运行时域。
- **actions**:稳定 `logical_key` 与唯一 `effect_key`;状态仅为 `intended→succeeded|failed`。相同 invocation 重放返回既有事实且不再次执行；未知或失败后确需重做,必须新 invocation 并显式写 `supersedes_action_id + retry_basis`,禁止重用 predecessor invocationUid。runner 行强绑 task/attempt/generation/activation,lead 行不绑 DAG；actor generation 在 intent/outcome 两端都 fenced。authorization 是首次 intent 的事实快照,重放不覆写；授权变化必须换新 logicalEffectId。actions 不选择 actor、不派发、不授予权限、无 retention/archiver/自动 retry/probe；保留期归批次 3 另审。
- gates:forward migration 重建为 issue-scoped current gate(issue_id+kind+tip+DAG/contract digest),同 issue 至多一个 open|approved founder_ship_approval;task_id 仅可作 emitter provenance,不按 rowid 猜 current。
- thread_bindings:forward migration 重建为显式 `{binding_kind=task|issue,binding_id}` canonical identity;同 task 多 attempt 复用 task binding,DAG 共用 issue binding,无 successor 继承。
- **activations**:`CREATE TABLE activations(id TEXT PRIMARY KEY, attempt_id TEXT NOT NULL REFERENCES attempts(id), session_ref TEXT NOT NULL, generation INTEGER NOT NULL, state TEXT NOT NULL CHECK(state IN ('active','terminal')));` + 两个 partial unique(attempt_id/session_ref 各至多一 active)。**原子换代**:{旧 activation terminal+旧 capability revoke+新 attempt/activation+registry cutover}=一个 immediate 事务,幂等重放。
- **processing_attempts**:`CREATE TABLE processing_attempts(attempt_uid TEXT PRIMARY KEY, message_uid TEXT NOT NULL REFERENCES mailbox(message_uid), attempt_no INTEGER NOT NULL, instance_id TEXT NOT NULL, generation INTEGER NOT NULL, activation_id TEXT, started_at TEXT NOT NULL, outcome TEXT NOT NULL DEFAULT 'running' CHECK(outcome IN ('running','succeeded','failed','crashed')), settled_at TEXT, UNIQUE(message_uid,attempt_no));` + `pa_one_running` partial unique(每消息至多一行 running,实测拒并发)。start=IMMEDIATE 事务校验 registry+pending+无 running;成功与业务行+applied 同事务结算;失败/crash 按 attempt_uid exactly-once CAS(WHERE outcome='running');crash 归因前提=探针确认旧进程死;5 次→dead。
### 1.2 mailbox
`mailbox(seq PK, message_uid UNIQUE, source_kind, source_id, payload, payload_digest, to_agent, kind, retention_class CHECK, cutover_epoch, state CHECK('pending','applied','tombstoned','dead'), retry_count, next_retry_at, created_at, applied_at)`;UNIQUE(source_kind,source_id)=canonical key(P3 关闭);退避 30s×2^n cap 15min;≥5 次→dead。**无 claimed 态、无租约**。
**防丢防重三支柱**:①同一事务(库内转化产出+标已处理)②消息 `message_uid` + 外部效果 `JSON.stringify(["conversion",messageUid,logicalEffectId,qualifier??null])` 派生的 invocationUid/effect_key ③generation fence(全部 Agent 写带谓词,CAS 行数=1 否则整体回滚)。
**七个 partial index + 四条候选 SELECT + detector SQL**:F1/F2(founder immediate/scheduled,命中 _f)、N1/N2(非 founder,命中 _nf)、age(detector)——全部实测 EXPLAIN 命中,无 TEMP B-TREE;实现原样使用不得改写。
### 1.2a-e 消费协议
- **唤醒三路**:门铃(可丢)/回合末查/超龄侦测顺带;**活性**:注册必拉+Lead 30s 周期 pull+到点调度(due scheduler);**runner=kernel timer 实际查询+durable deliver(重试至观察终态)**,不依赖可丢 hint。
- **串行消费**:逐条(batch=1),同收件人单活消费者;`agents` 注册事务=唯一 cutover 点;同世代 single-flight;终局收件人处置(business 改投/dead,notice tombstone,告警只发活监督者)。
- **公平性**:K=4 有界优先+30min 超龄晋升+配额重启保守恢复;T_max=10min(started_at 起);参数 T_tick≤60s/T_deliver_tot≤5min(总 deadline)/T_switch≤5min/T_due_cap=15min。
- **SLA(唯一公式)**:A=1+S×(K+1),S=(q−1)×5+R;`T(q,R) ≤ T_tick + A×(T_deliver_tot+T_max+T_switch) + (R−1)×(T_due_cap+T_tick)`;q=1,R=5 默认=585min≈9h45m(诚实数字,Codex 独立验算一致);活性保证=配额+晋升无饿死;深积压由 admission+超龄告警暴露。
- **外发=Agent 主动动作**:转化期间通过 `runRecordedAction` 先记 intent、事务外亲手执行、再记 outcome；所有已启动 action outcome 必须先于消息结算。库内 task/event 产出与 mailbox applied 仍同事务提交。崩在 intent 前→消息重投后执行；崩在效果后 outcome 前→重放只返回 `replayed+intended`,不自动重做、不冒充成功；有外部证据时才走显式 supersede。
### 1.3 events 归档:staging+fsync+原子 rename+单事务 manifest;启动 reconcile。
### 1.4 执行所有权
运行协调器只跑 task DAG eligibility、mailbox 冷启动、heartbeat Agent wake、风暴刹车四类「看库→拉进程」循环；不读业务内容、不路由、不执行外部 action。current-generation Agent 经通用薄壳亲手执行效果；仓内没有集中 action executor、claim loop、事实 probe、saga 或自动补偿者。
### 1.5 gates、actions 与 ship [FLY-1498]
ship 是 Agent action,不是 DAG node。founder approval 事务把 current gate 绑 exact tip,选择可重启且有 GitHub capability 的 emitter；否则只读合并目标 ref 上可信 `.flywheel/config.yaml::default_action_agent_id`,并把 target ref+digest 与 approval 同时落库。被合并 PR 不得选择自己的 actor；都不可用时批准可落库,但 action blocked 并发 typed alert。Agent 不在线时,运行协调器只按 `agents` generation + heartbeat 重启同一 logical Agent。

ship 调用前,Agent 在事务外观测 PR head,再用短事务校验 current generation、unused exact capability、current approved gate 绑 tip、current DAG all done、observation==tip 并消费 capability；提交后通过 actions 薄壳调用 GitHub merge(expected_sha=tip)。**前置恰三条**:①founder approval 绑 current head ②DAG 全节点成功 ③GitHub head 未漂移；review/QA/docs/session role 不在 ship 谓词。rework/revision/revoke 必须先线性化失效 ship authority；若外部调用已经跨过不可撤销点,业务变更报告 conflict,不得假装撤销。

CI 不是第四条 ship 谓词。v2 lane bootstrap 必须真实读取 target branch ruleset/required checks 与 token actor repository permission/bypass actors；403/unknown、required checks 空集、actor=admin 或命中 bypass list 均 fail closed,不注册 v2 merge capability,发 typed deployment alert并保留 v1 ship lane。probe 成功才启用 v2 merge；它是世界侧 deployment enablement,不进入某次 gate/ship transaction。激活后红 CI 由 GitHub 原子拒绝；是否重做由 Agent 基于可审计证据显式新建 supersede action,系统不自动生成 retry。

actions 黑匣子不读取 GitHub、不对账、不定时重试、不持 retry budget。调用成功/失败由执行它的 Agent 原样记账；效果后崩溃留下 `intended` 是诚实未知窗。恢复者只能读取旧事实,不能自动再执行；确认需要重做时必须提供新 invocationUid、predecessor 与 retry evidence。authorization 变化必须建立新 logical root。
### 1.6 三层模型
task→attempt→session;resume 复用 session 体但新 activation+新 generation;每 worktree 至多一活 writer。task-local attempt_generation 与 agent consumer_generation 解耦。
### 1.7 节点完成合同 [FLY-1498]
`contract=declared(parse_contract(task.contract_json))∪derived(canonical diff)`。product code→exact-subject cross-family code review;test-only/docs-only/空 diff→不派生 code review;节点名/role/phase 不参与。admission 事务外算 `initial_anchor=merge-base(merge_target_ref,HEAD)`,事务内令 `span_tip=writer_chain.chain_head=initial_anchor` 并固化 target/anchor;禁止以 admitted HEAD 惰性开链。HEAD 已领先则先走通用 writer-gap 归因,只推进 chain_head,首个完成仍从 anchor 分类全部 diff。runner proposal 只带 task/attempt identity;kernel API 事务外要求 span_tip 是 canonical head ancestor,再构造 raw manifest(A/D/M/R/C 严格 status/mode/path,rename/copy 两端取最严,非法/退化/超限拒),计算 manifest+effective_author_set+subject digest,BEGIN 前重取 HEAD/writer version。history rewrite 破坏 ancestry 时 expire gate+typed fail;终态化 active attempt 后用普通新 worktree admission 建新 identity,不得原地 re-anchor 到 HEAD。

完成短事务校验 generation/current attempt、span_tip==base、observation==manifest.head、writer version、declared+derived exact evidence、reviewer family∉effective_author_set;同一 commit 写 activation/attempt/task terminal、node_completed、span_tip 推进、清 author set、`maybe_refresh_ship_gate(issue)`。product-code 的可审 family=`review_capable_families-effective_author_set`;为空则 typed `review_family_exhausted`+mailbox、task 不 done，披露/同族 review/founder approval 均不能充证据；选定出口是认证第三方 reviewer family 对原 subject digest 做 exact review，不做无逐贡献权威的 split review。test/docs-only 不派生此合同。gate tip 只能取同事务 current span_tip;canonical HEAD≠span_tip 时 expire+`unconsumed_span_blocks_gate`,excision/cancellation 不吞 diff。任何 CAS/证据失败全回滚。writes-repo attempt 的 completed/failed/canceled/superseded 全路径都由壳或 crash reconciler 在事务外取得 observation 后调用同一 author finalize;非写 attempt 跳过。canonical worktree identity 在 admission 与 span/writer state 同事务记录 repo/path/branch/merge_target/initial_anchor;worktree+ref 都丢失时只有 exact `adopt_writer_gap(lost_open_attempt)` 可把 attempt 标 failed、保守折入旧 family、复位 span_tip、清 writer slot;task 不 done。

## 2. 引擎
- 2.4a 注入垫片:vendor-neutral,hint/deliver 两方法,**无 ack**;产出只能以带 generation 的转化 proposal 提交 kernel;无状态。
- 2.9 notify-then-do:通知前置是 Agent/业务合同,不再有集中 outbox/claim 图。Agent 取得 exact capability 后主动调用通用 actions 薄壳；黑匣子只记账,不解释 kind 或 prerequisite。
- 2.10 处理=转化(三出口);完成=产出已提交。
- **2.11 重启风暴(kernel 外权威)**:restart ledger(append-only,seq 单调)+状态文件{state,episode_key,window_start,last_resumed_seq},temp+fsync+rename;**全部写者**(wrapper/resume/工具)同一 <child_key>.lock(fcntl,fail-closed);穷举启动分支:attempted→退出;pending→不 exec 补 spool+alert→attempted;resumed→锁内立即转 active(保留 cursor);active→append+fsync→谓词 `count(窗口内 AND event_seq>last_resumed_seq)≥6 AND state=active`→真:原子 claim+spool(exactly-once)+meta-alert(at-least-once+stable key+debounce)→attempted 不 exec;假:exec。resume=锁内条件写(仍 held_* 才生效,并发第二次幂等 no-op);cursor 缺失=0。验收含全部 crash 点重放+并发 resume 交错。
- **2.5 同 task rework**:rework_uid 幂等;incoming dependencies 仍 all done;事务外取 canonical HEAD+writer version;同事务先 terminal/revoke/release 被打回 task 与下游全部 active 套件,下游历史 attempt 不改、task 只重算 ready/blocked且不预建 attempt;断言 writer slot 清空后才为被打回 task 创建新 attempt/activation并按需 acquire;同时 invalidate ship authority。release 必须先于 acquire;不建 successor/rework_of/回边。外部不可逆 action 位于 intent 与 outcome 之间时,先按未知事实处理；没有外部证据不得重做。
- **2.12 DAG 调度 / Agent wake [FLY-1498]**:task dispatch 唯一 eligibility=`ready+incoming all done+no active attempt+(writes_repo⇒open_attempt null且HEAD==chain_head)`;事务内 attempt+activation+task generation+writer slot,commit 后只拉 runner。Agent wake=`pending mailbox+(absent OR heartbeat stale)+restart budget`,只重启 `agents` 表中同一 logical Agent 并推进 generation(heartbeat 列由 FLY-1499 建)。1/2/N、串/并行、PRD 单、QA 单、三段式均为 task/edge 数据；引擎零 design/implement/qa/template 名字面量。

## 3. 告警
- **3.1 typed failure episodes**:tick 每分钟;≥1 条超 30min 即发(N=1 也发)。detector 只提交 proposal；kernel 单 IMMEDIATE 事务重算集合、append stable episode_key+tier 的 typed event、按当前监督关系推导 recipient、写 durable mailbox；同 episode+tier 幂等,30min→2h→8h 各通知一次。subject 与 recipient 分离；不建 owner 行或独立病历表。
- **3.2 父抑制子**:静态 suppression 规则在 typed episode view 上求值；kernel 只把 eligible 通知写 mailbox。parent open 记录 suppressed tier event；parent clear 同事务按最新 tier 放行恰一并取消旧 tier；receipt 后写 notified event。没有 parent/child 病历卡或销账表。
- 结构闸:P5 由稳定 episode key、tier 单调、event/mailbox 幂等与终态 reducer 关闭;失败/恢复都有 typed event,不靠会话补记录。

## 4. 切换手册
0008 是 v2 上线前置,切换时三张退役表及其触发器/索引必须已经不存在,弃行回执必须可查。对任何不可抛弃库执行顺序固定为:①quiesce 全部 writer ②`backupDatabase` 创建并验证 WAL-safe 快照 ③跑 0008 并核对 20 表、8 条 migration ledger、零 FK violation ④再配对部署只使用 actions 的代码。失败或需回滚时:保持 writer quiesced,隔离已迁移数据库及其 WAL/SHM,把快照恢复到**原运行库路径**,配对 code revert,核对 ledger 止于 0007 且旧表逐行数据仍在,之后才允许重启。其余九步 stop-the-world+消息通道切换(双源冻结/canonical 对账/只读归档)、旧 writer 三重围栏(启动入口撤销/原路径 fence tombstone/epoch fence)与 GitHub required-checks + non-admin merge actor Go/No-Go 探针保持不变。

## 5. 病例回归矩阵
P1-P13 全覆盖+bypass 封闭矩阵(audit=actions+typed events)+B1 验收(百条零漏)+既有验收(§1.2d 四条/公平反例/七索引 query-plan/activations crash 重放/风暴上限/typed episode 父抑制子四交错/N43 双子例)+actions 等价族(恰一次重放、intent 前不丢、效果后 `intended` 诚实窗、显式 supersede、双动作混合重投、epoch/generation fence、settlement barrier)+0008 迁移族(fresh/幂等/带数据/中途回滚/恢复原运行路径)+FLY-1498:PRD 单无 code review/QA test-only 只欠 verdict/product-code 跨族 exact review/author-set 自审双反例/merge-base anchor/history rewrite 拒绝/freshness 三窗口/1-2-N 零节点名/返工 release-before-acquire/gate refresh/excision 不吞 span/cold ship generation/lost-open adoption/non-admin actor+required-checks 激活失败保持 v1 lane/ship 谓词无 review-QA-docs-role-CI。

## 6. 场景压测附录
29 基础场景(附录A)+N1-N44(毒消息/门铃丢失/风暴/洪泛/崩溃三分/僵尸世代/积压/时钟/告警抖动/垫片崩/换代/成功即崩/fence 拒/候选可见/T_max/监督者换代/双 active 拒/换代重放/并发 start/ledger 跨窗/kernel 死告警/episode 合并/谓词反例/参数化 SLA/重放谓词/补发/新 episode/终态幂等)+FLY-1498 外部世界竞态(intent 后断电/merge 已成与未知/CI 暂拒/head 漂移/approval 撤回/显式 supersede 证据)。

## 7. 外部对标(DR,40 引用)
总裁决:"kernel 保持 custom 但做小,模式狠抄"——SQLite 单一真相是决定性约束,Temporal/DBOS/Restate/Inngest 均会搬走真相,不采用(Restate=将来若放弃 SQLite-SSOT 的首选备胎)。模式抄:K8s reconcile/OTP 监督树+风暴上限/transactional outbox/saga 选择性/事件历史/CI 短命工作区/Alertmanager 分组+抑制。可采用:LangGraph(仅代码化 planner 场景,记为选项)/OpenHands(操作员 UX 参考)/SWE-agent(runner ACI 参考)。空白确认:本系统类型无成熟 OSS 等价物,自研正确。
