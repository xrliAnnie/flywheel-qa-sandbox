# Flywheel v2 设计终版(Codex R13 APPROVED · 2026-07-27)
> 评审链:R1-R5(基础版 APPROVED)→深夜 ultrathink 重设计→R6(9项)→R7(4)→R8(5)→R9(4)→R10(3)→R11(1)→R12(3)→R13 APPROVED。外部对标:ChatGPT Deep Research(40引用)独立确认总方向。本文=v5 终版+v6..v13 全部修订的并稿。

## §T 术语表(大白话)
- **标已处理**(=队列 ack,等价 Redis XACK/SQS DeleteMessage):把一条消息 待处理→已处理 的状态翻转,必须与该消息的业务效果同一个数据库事务提交。
- **门铃**:消息入库后发给收件人的"你有新消息"唤醒信号;不带消息本体,允许丢(只降时延,不承担活性)。
- **转化**:处理一条消息=把它变成正确的账本记录(快答/建 task 派发/登记工作项),秒到分钟级;转化完成即处理完成,活本身由 task 层追踪。
- **claim/租约(已删,范围=仅 mailbox 消息层)**:两步占坑+超时回滚被删除;commands/dispatcher 的执行 claim 协议保持不变。
- **generation fence**:Lead/runner 每次换代世代号+1;旧世代任何写提交时被拒。
- **processing-attempt**:开始转化前落库的处理尝试记录,崩溃归因依据。
- **activation**:一次 attempt 与一个执行 session 的权威绑定。
- **T_max**:单条转化硬上限(默认 10min),超限=活着卡死→硬终止换代。
- **kernel**=唯一写库代码路径;**dispatcher**=每类 command 唯一执行者;**探针**=应有vs实际状态核对;**注入垫片**=消息进 vendor 会话的唯一适配层(hint/deliver 两方法,无 ack);**obligation**=必须销账的事项(告警载体);**幂等键**=防重复执行的唯一编号。
- **backlog subject vs notify recipient**:积压的是谁的信箱 vs 告警发给谁(按当前监督关系实时推导),两字段不混。
- **三个 tier 计数**:last_enqueued_tier(已入队)/suppressed_tier(被抑制的债)/last_notified_tier(已确认送达)。

## 0. 目标与范围
- 前提条款:每 issue 的 task 数量与形状由该 issue 的 DAG 定义,三段式只是例子,机制不得隐式绑定三段式。
- 单一真相:flywheel-v2.db(SQLite)——消灭病根①(multiple sources of truth)的核心手段。

## 0.5 消息通道选型
唯一消息通道=SQLite,信箱表住权威库内(comm.db 与 JSON 信箱同时退役)。规模阈值:mailbox 未清理行>100k/库文件>2GB/WAL>64MB/oldest-unconsumed>30min/lag>500。retention tick 每 10min 单实例互斥,每 tick≤5000 行。不在线 VACUUM;每日 idle checkpoint;freelist>30%→维护窗口离线 VACUUM。过载:admission 拒 notice 类。retention_class:notice(applied 后 7 天删)/business(90 天归档)/dlq(30 天人工)。business 超期=单 kernel 事务(mailbox CAS pending→dead+唯一 decision event+至多一个 obligation,幂等)。
### 0.5a 为什么不用现成 MQ(对标而不引入)
唯一硬理由:外部 MQ 无法参与 SQLite 事务——"标已处理+业务效果同事务"是消灭病根①的手段,引入 broker=两个真相复活。语义全盘对标:通知可丢/存储是真相/at-least-once+消费端幂等/端到端 exactly-once 在外部世界边界不存在(库内单事务 exactly-once+边界幂等键)。DR 独立确认:"自研队列表比通用队列库更简单"(原子耦合业务状态)。
### 0.5b SQLite 写纪律 [DR]
写路径 BEGIN IMMEDIATE(选择性);每个可写连接必设 PRAGMA busy_timeout(连接工厂统一);写事务短(禁网络/LLM 调用);读者短命;仅本地盘;禁 BEGIN CONCURRENT。

## 1. 数据层
### 1.0 权威 schema(17 张表)
tasks/task_dependencies/attempts/events/commands/command_dependencies/gates/capabilities/obligations/source_receipts/mailbox/thread_bindings/archive_manifest/meta(含 lead_registry+consumer_registry 键空间)/schema_migrations/**activations**/**processing_attempts**。全部入迁移+备份合同。
### 1.1 表要点
- tasks:rework_of+lineage_root_id;**terminal 规则**:目标 task 非 terminal→同 task 新 attempt;已 terminal(无论 issue 是否 Done)→rework_of successor 继承 lineage/thread。
- attempts:terminal_reason;每 task 至多一个 active attempt。
- commands:6+2 态(pending→claimed→accepted→executing→succeeded|failed;rejected/canceled)+result_code;dispatcher 执行 claim 协议不变。
- command_dependencies:notify_before;admission 强制非豁免 action 有通知前置;禁环。
- **obligations(重建迁移)**:target_task_id 改 nullable;增 episode_key/target_kind CHECK('task','agent')/target_agent_id(=subject)/notify_recipient_agent_id/last_enqueued_tier/suppressed_tier/last_notified_tier;恰一目标 CHECK;UNIQUE(episode_key) WHERE open;depth CHECK≤1(告警不生告警);task 终态 tombstone 只作用 task-target。
- thread_bindings:lineage_root canonical,successor 继承 thread。
- **activations**:`CREATE TABLE activations(id TEXT PRIMARY KEY, attempt_id TEXT NOT NULL REFERENCES attempts(id), session_ref TEXT NOT NULL, generation INTEGER NOT NULL, state TEXT NOT NULL CHECK(state IN ('active','terminal')));` + 两个 partial unique(attempt_id/session_ref 各至多一 active)。**原子换代**:{旧 activation terminal+旧 capability revoke+新 attempt/activation+registry cutover}=一个 immediate 事务,幂等重放。
- **processing_attempts**:`CREATE TABLE processing_attempts(attempt_uid TEXT PRIMARY KEY, message_uid TEXT NOT NULL REFERENCES mailbox(message_uid), attempt_no INTEGER NOT NULL, instance_id TEXT NOT NULL, generation INTEGER NOT NULL, activation_id TEXT, started_at TEXT NOT NULL, outcome TEXT NOT NULL DEFAULT 'running' CHECK(outcome IN ('running','succeeded','failed','crashed')), settled_at TEXT, UNIQUE(message_uid,attempt_no));` + `pa_one_running` partial unique(每消息至多一行 running,实测拒并发)。start=IMMEDIATE 事务校验 registry+pending+无 running;成功与业务行+applied 同事务结算;失败/crash 按 attempt_uid exactly-once CAS(WHERE outcome='running');crash 归因前提=探针确认旧进程死;5 次→dead。
### 1.2 mailbox
`mailbox(seq PK, message_uid UNIQUE, source_kind, source_id, payload, payload_digest, to_agent, kind, retention_class CHECK, cutover_epoch, state CHECK('pending','applied','tombstoned','dead'), retry_count, next_retry_at, created_at, applied_at)`;UNIQUE(source_kind,source_id)=canonical key(P3 关闭);退避 30s×2^n cap 15min;≥5 次→dead。**无 claimed 态、无租约**。
**防丢防重三支柱**:①同一事务(转化产出+标已处理)②幂等键(message_uid;外发走 outbox command+effect_key)③generation fence(全部 agent 写带谓词,CAS 行数=1 否则整体回滚)。
**七个 partial index + 四条候选 SELECT + detector SQL**:F1/F2(founder immediate/scheduled,命中 _f)、N1/N2(非 founder,命中 _nf)、age(detector)——全部实测 EXPLAIN 命中,无 TEMP B-TREE;实现原样使用不得改写。
### 1.2a-e 消费协议
- **唤醒三路**:门铃(可丢)/回合末查/超龄侦测顺带;**活性**:注册必拉+Lead 30s 周期 pull+到点调度(due scheduler);**runner=kernel timer 实际查询+durable deliver(重试至观察终态)**,不依赖可丢 hint。
- **串行消费**:逐条(batch=1),同收件人单活消费者;consumer registry(meta)+注册事务=唯一 cutover 点;同世代 single-flight;终局收件人处置(business 改投/dead,notice tombstone,告警只发活监督者)。
- **公平性**:K=4 有界优先+30min 超龄晋升+配额重启保守恢复;T_max=10min(started_at 起);参数 T_tick≤60s/T_deliver_tot≤5min(总 deadline)/T_switch≤5min/T_due_cap=15min。
- **SLA(唯一公式)**:A=1+S×(K+1),S=(q−1)×5+R;`T(q,R) ≤ T_tick + A×(T_deliver_tot+T_max+T_switch) + (R−1)×(T_due_cap+T_tick)`;q=1,R=5 默认=585min≈9h45m(诚实数字,Codex 独立验算一致);活性保证=配额+晋升无饿死;深积压由 admission+超龄告警暴露。
- **外发=outbox**:转化事务只写 pending command;"处理完成"="回复 command 已入 outbox";边界残留(Discord 罕见重复)诚实入基线。
### 1.3 events 归档:staging+fsync+原子 rename+单事务 manifest;启动 reconcile。
### 1.4-1.5 执行所有权/gates:同前版(exact-head 绑定,founder-only ship)。
### 1.6 三层模型:task→attempt→session;resume 复用 session 体但新 activation+新 generation;每 worktree 至多一活 writer。

## 2. 引擎
- 2.4a 注入垫片:vendor-neutral,hint/deliver 两方法,**无 ack**;产出只能以带 generation 的转化 proposal 提交 kernel;无状态。
- 2.9 notify-then-do:admission+claim 双校验;prerequisite_notification/readonly/action 三类。
- 2.10 处理=转化(三出口);完成=产出已提交。
- **2.11 重启风暴(kernel 外权威)**:restart ledger(append-only,seq 单调)+状态文件{state,episode_key,window_start,last_resumed_seq},temp+fsync+rename;**全部写者**(wrapper/resume/工具)同一 <child_key>.lock(fcntl,fail-closed);穷举启动分支:attempted→退出;pending→不 exec 补 spool+alert→attempted;resumed→锁内立即转 active(保留 cursor);active→append+fsync→谓词 `count(窗口内 AND event_seq>last_resumed_seq)≥6 AND state=active`→真:原子 claim+spool(exactly-once)+meta-alert(at-least-once+stable key+debounce)→attempted 不 exec;假:exec。resume=锁内条件写(仍 held_* 才生效,并发第二次幂等 no-op);cursor 缺失=0。验收含全部 crash 点重放+并发 resume 交错。
- 2.5 rework saga:effect 处置总表穷举 command.kind,未知 fail closed;github_merge/destructive_delete 不入自动 saga。

## 3. 告警
- **3.1 超龄聚合**:tick 每分钟;≥1 条超 30min 即发(N=1 也发,无数量阈值);kernel 单 immediate 事务四步(重算集合/episode upsert 或 tombstone/tier 单调/通知 command);subject 与 recipient 分离(runner→owning Lead,Lead→founder,换代重推导);effect_key=obligation id+tier;open 行≤1/收件人,历史行保留审计;30min→2h→8h 升档各通知一次。
- **3.2 父抑制子(方案A)**:command 恒 pending,抑制=dispatcher claim predicate(无匹配 open parent);静态抑制规则表(parent_kind,child_kind,同 subject);claim 先赢仲裁(已 claim 的在途一条允许送达,收窄验收);parent-open 只记 suppressed_tier 债;parent-clear 原子:按最新 tier 放行恰一+cancel 旧 tier+suppressed_tier←NULL;receipt 后才推进 last_notified_tier。
- 结构四道闸(P5 永不复发):聚合/episode 唯一键/depth CHECK/自动销账。

## 4. 切换手册
九步 stop-the-world+消息通道切换(双源冻结/canonical 对账迁移/WAL-safe backup/只读归档);旧 writer 三重围栏(启动入口撤销/原路径 fence tombstone/epoch fence);Go/No-Go 十条(含实弹复活测试)。回滚锚点:main@37bcb8e2。

## 5. 病例回归矩阵
P1-P13 全覆盖+bypass 封闭矩阵(audit=commands.result_code+events bypass_used)+B1 验收(百条零漏)+本轮全部新增验收(§1.2d 四条/公平反例/五+二索引 query-plan/obligations 迁移五测/activations crash 重放/风暴上限/父抑制子四交错/N43 双子例)。

## 6. 场景压测附录
29 基础场景(附录A)+N1-N44(毒消息/门铃丢失/风暴/洪泛/崩溃三分/僵尸世代/积压/时钟/告警抖动/垫片崩/换代/驱动兜底/成功即崩/fence 拒/候选可见/T_max/owner 换代/双 active 拒/换代重放/并发 start/ledger 跨窗/kernel 死告警/债合并/谓词反例/参数化 SLA/重放谓词/补发/新 episode/清债幂等)。

## 7. 外部对标(DR,40 引用)
总裁决:"kernel 保持 custom 但做小,模式狠抄"——SQLite 单一真相是决定性约束,Temporal/DBOS/Restate/Inngest 均会搬走真相,不采用(Restate=将来若放弃 SQLite-SSOT 的首选备胎)。模式抄:K8s reconcile/OTP 监督树+风暴上限/transactional outbox/saga 选择性/事件历史/CI 短命工作区/Alertmanager 分组+抑制。可采用:LangGraph(仅代码化 planner 场景,记为选项)/OpenHands(操作员 UX 参考)/SWE-agent(runner ACI 参考)。空白确认:本系统类型无成熟 OSS 等价物,自研正确。
