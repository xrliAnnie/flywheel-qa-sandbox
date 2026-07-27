# Flywheel v2 设计稿 v6(全量重稿·ultrathink 版)
> 相对 v5(R5 APPROVED):吸收 2026-07-26 深夜 Annie 全部对谈修订。**实质协议变更**:mailbox 删除 claim/租约,消费协议重写为「串行消费+generation fence」(§1.2/§1.2a)。新增:术语表(§T)、三层执行模型(§1.6)、消费与唤醒机制(§1.2a)、MQ 对标(§0.5a)、场景压测附录(§6)。本轮请全量审,重点攻击 §1.2/§1.2a 的新消费协议。

## §T 术语表(全文用大白话,缩写只在此定义)
- **标已处理**(=队列 ack,等价 Redis XACK/SQS DeleteMessage):数据库里把一条消息 待处理→已处理 的状态翻转,**必须与该消息的业务效果在同一个数据库事务里提交**。B1 轮定下,从未变过。
- **门铃**(=push 通知):消息入库后发给收件人的"你有新消息"唤醒信号。**不携带消息本体,允许丢失**——丢了只影响时延,不丢消息(表是真相)。
- **转化**:处理一条消息的动作=把它变成正确的账本记录(快答回复/建 task 派发/登记工作项),秒到分钟级。**转化完成即处理完成**;活本身做没做完由 task 层追踪,不占消息队列。
- **回执/回话**:转化的一种产出(回发送者一句话)。不是队列机制,与「标已处理」无关。
- **claim/租约**:已删除的旧机制(两步"先占坑再确认"+超时回滚)。删除理由见 §1.2a。
- **generation fence**:每次 Lead 进程重启,注册表里的世代号+1;旧世代进程的任何写入在提交时被拒绝(防僵尸旧进程)。
- **kernel**:唯一允许写权威库的代码路径(带不变量校验);**dispatcher**:每类 command 的唯一执行者;**探针**:对外部世界"应有状态vs实际状态"的核对;**注入垫片**:把消息塞进某 vendor 会话的唯一适配层;**obligation**:必须有人认领销账的事项(告警的承载体)。
- **幂等键**:同一动作重复执行时用来识别"已做过"的唯一编号,保证效果只发生一次。

## 0. 目标与范围(同 v2;修复:Ship gate 引用改为 §1.5-gates)
**前提条款(DAG 形状可变)**:每个 issue 的 task 数量与形状由该 issue 的 DAG 定义(1/2/4/任意个,任意连接);design→implement→qa 三段式只是常见例子,全文不得把任何机制隐式绑定在三段式上。

## 0.5 消息通道选型 [同 v5 + 补强]
唯一消息通道=SQLite,信箱表住权威库 flywheel-v2.db 内(comm.db 与 JSON 信箱同时退役)。真实优势表述、规模阈值、retention 调度、VACUUM 策略、过载 admission、retention_class 三值及 business 超期单事务处置——全部同 v5 不变(business 处置中 mailbox CAS 改为 pending→dead,claimed 态已不存在)。
### 0.5a 为什么不用现成开源 MQ(对标而不引入)
拒绝外部 broker 的唯一硬理由:**外部 MQ 无法参与 SQLite 事务**。「标已处理+业务效果同一事务」是本设计消灭病根①(multiple sources of truth)的核心手段;引入 Kafka/RabbitMQ/Redis 意味着消息状态与业务状态又变成两个真相+跨系统对账,病根①复活。且我们的量级(单机、<10 个消费者、每分钟几十条)远低于这些系统的设计点。
**但语义全盘对标成熟 MQ,不自己发明**:
| 我们的机制 | Postgres 队列 | Redis Streams | SQS | RabbitMQ |
|---|---|---|---|---|
| mailbox 表=唯一真相 | 表 | stream | 队列 | 队列 |
| 门铃(可丢的唤醒) | LISTEN/NOTIFY | 阻塞 XREAD | 长轮询 | consumer push |
| 标已处理 | DELETE/UPDATE | XACK | DeleteMessage | basic.ack |
| 崩溃恢复 | 行还在 | PEL 重读 | visibility 重现 | 未 ack 重投 |
| 投递语义 | at-least-once | at-least-once | at-least-once | at-least-once |
| 消费端幂等 | 必须 | 必须 | 必须 | 必须 |
共同结论(业界公认):**通知可丢、存储是真相、at-least-once+消费端幂等**;端到端 exactly-once 在与外部世界(Discord/GitHub)交界处不存在,只能"库内 exactly-once(单事务)+边界 at-least-once+幂等键"。本设计照此执行,见 §1.2a。

## 1. 数据层
### 1.0 权威 schema 全量清单 [同 v5]
15 张表不变;DDL 命名统一条款不变。
### 1.1 修订点 [同 v5 全部保留] + 新增:
- **obligations 增列** `episode_key TEXT`(聚合告警唯一键,见 §3.1)+ UNIQUE(episode_key) WHERE state='open'。
### 1.2 mailbox(住权威库)——**协议重写(claim/租约删除)**
```sql
mailbox(seq PK, message_uid TEXT NOT NULL UNIQUE,
  source_kind TEXT NOT NULL,        -- founder/lead/runner/system(决定优先级)
  source_id TEXT NOT NULL, payload NOT NULL, payload_digest TEXT NOT NULL,
  to_agent TEXT NOT NULL, kind TEXT NOT NULL,
  retention_class TEXT NOT NULL CHECK IN ('notice','business','dlq'),
  cutover_epoch INTEGER NOT NULL,
  state TEXT NOT NULL CHECK IN ('pending','applied','tombstoned','dead'),  -- 无 claimed
  retry_count INTEGER NOT NULL DEFAULT 0, next_retry_at,
  created_at NOT NULL, applied_at)
```
索引同 v5(两个静态 partial index + :now 绑定参数,R4/R5 已实证);UNIQUE(source_kind,source_id) canonical key 同 v5;退避公式同 v5(base=30s,cap=15min,≥5 次→dead)。
**删除项与理由**:
- 删 claim(claim_owner/claim_generation/lease_expires_at 列、claimed 态、claim CAS):每条消息有且仅有一个确定收件人(to_agent),同收件人只有一个活世代消费者,**不存在竞争,无坑可占**。
- 删租约/超时回滚:「第16分钟处理完但已被判超时→重复处理」是租约机制自带的 bug(Annie 指出,成立)。替代规则:**未标已处理=未处理**,没有计时器,没有回滚。
**防丢/防重三支柱**(替代 claim/租约提供过的全部保护):
1. **同一事务**:转化产出(commands/tasks/receipts/events 行)+ 标已处理,一个事务提交。崩溃=整体未发生,消息仍 pending,重启后重做。
2. **幂等键**:apply 以 message_uid 为幂等键;外发副作用一律先落 command 行(outbox 模式,见 §1.2a-4),command 以 effect_key 幂等。
3. **generation fence**:标已处理的 UPDATE 带 `WHERE state='pending'` 的 CAS+提交前校验 meta.lead_registry 当前世代=本进程世代;僵尸旧进程的整个事务被拒,其"转化"连同外发 command 一并回滚,零副作用。
### 1.2a 消费与唤醒(门铃 vs 真相)
**角色**:每个 to_agent 一个逻辑消费者(Lead=本人;runner=经注入垫片)。
**唤醒三路**(主=门铃,皆可丢,truth 在表):
1. 门铃:消息入库后 kernel 经注入垫片向收件人会话注入"有新消息"(不带本体);
2. 回合末顺手查:消费者每个对话回合结束时读一次自己的 pending(便宜,非每秒轮询);
3. 超龄侦测:§3.1 聚合 obligation 创建时顺带唤醒。
**串行消费循环**(醒来后):
```
loop:
  batch = SELECT ... WHERE to_agent=me AND state='pending'
          AND (next_retry_at IS NULL OR next_retry_at<=:now)
          ORDER BY (source_kind='founder') DESC, seq ASC  LIMIT 200
  if batch 空: 退出循环(等下次唤醒)
  for msg in batch:                    # 串行,逐条
    转化(msg) ⟶ 单事务{业务行 + mailbox CAS pending→applied + generation 校验}
    失败 ⟶ 单事务{retry_count+1, next_retry_at=退避}  # ≥5→dead(§0.5 DLQ 路径)
  # 批间重新查询:新到的 founder 消息在下一批排最前
```
性质(逐条对应场景压测 §6):
- **读到≠消费**:读只是取工作清单;真相翻转只发生在"标已处理"事务。批中崩溃→未处理的仍 pending,一条不丢(答 S3)。
- **"处理中又读到待处理"时刻不存在**:串行模型里,同一消费者处理期间不重读;批间才重读(答 F1③)。
- **FIFO+founder 插队**:同收件人按 seq 先进先出;founder 来源每批排最前。批上限 200 保证插队时延有界。
- **长活不进队列**:转化只做秒到分钟级决策;长活转成 task 由 runner 跑(答 G1②)。
- **4. 外发副作用=outbox**:转化事务里只写 command 行(pending);dispatcher 异步执行真实外发。dispatcher 崩溃于"已发未记"窗口→重试可能重复外发一次——**这是与外部世界交界处的公认残留**(SQS/Rabbit 消费者同样存在);可探测的效果(PR/Linear/进程)以探针+effect_key 收敛,不可探测的(Discord 消息)接受罕见重复,低害。诚实入验收基线。
### 1.3-1.5 [同 v5 不变](events 归档协议/执行所有权/gates)
### 1.6 三层执行模型(显式条款)
**task(工作项)→attempt(第 N 次执行,generation)→session(执行体)**。
- 打回/loop=**同一 task 新 attempt**;原 session 活着就 resume(带上下文),worktree 同分支继续;
- 仅"issue 已 Done 关闭后的事后返工"才新建 successor task(rework_of,lineage 继承 thread);
- task 形状由 issue 的 DAG 决定(§0 前提条款);打回=loop 起点更靠前,同机制无特例。

## 2. 引擎
### 2.1-2.7 [同 v5 不变;2.4a 注入垫片 vendor-neutral 契约不变]
### 2.8 Lead 可靠性(修订):消费保护由 **generation fence(§1.2 支柱3)** 承担(原"claim CAS"表述作废);lead_generation 记 meta 不变。
### 2.9 notify-then-do [同 v5 不变]
### 2.10 消息处理语义(处理=转化)
转化三出口:快答(读视图直接回)/转 task 派发(长活在 runner 侧)/登记工作项(需 Lead 深思的,ack 一句+排进工作清单)。"怎么算处理完"=转化产出已提交(回复已发出/task 已建/工作项已登记)。

## 3. 告警(同 v5 detector→kernel 原子写 + 精确化)
### 3.1 mailbox 超龄聚合告警(精确语义,答 S2)
- 侦测 tick:每分钟(kernel 自带,单实例,与 retention tick 同机制互斥);
- 条件:某 to_agent 存在 **≥1 条** pending 超 30 分钟(N=1 也触发,无数量阈值);
- 动作:upsert **唯一一条** obligation(episode_key=`mailbox_backlog:<to_agent>`,§1.1 partial UNIQUE 保证唯一),payload={count,oldest_age},数字变化就地更新;
- 通知策略:创建时通知一次+升档时(30min→2h→8h)再通知,**不逐 tick 重发**;
- 销账:该 to_agent 无超龄 pending → 自动 tombstone;再出现=新 episode。
- 结构保证:单条消息的独立告警路径**不存在**(唯一告警产物即聚合行);obligation depth CHECK≤1(告警不生告警);——四道闸对应 P5 永不复发。

## 4. 切换手册 [同 v5 不变](九步+十条 Go/No-Go+旧 writer 三重围栏)

## 5. 病例回归矩阵 [同 v5 全部保留] + 增:
- B1 验收:一次涌入 100 条混合来源消息→断言零漏(全部终态 applied/dead,无永久 pending);
- 串行消费验收:批中 kill -9 消费者→重启→断言未处理消息全在、已处理不重做(幂等)、无重复外发 command;
- 僵尸世代验收:旧世代进程持已读批强行提交→断言整事务被拒零副作用;
- 毒消息验收:构造必崩转化→断言 5 次退避后 dead+DLQ 告警,队列不阻塞后续消息;
- 聚合告警验收:1 条超龄→告警存在(N=1);99 条→仍唯一一行;清空→自动销账;告警行永不超过 1 条/收件人。

## 6. 场景压测附录
29 场景全表(/tmp/scenarios/all.md)为附录 A;本轮自压测新增(附录 B,全部已在 §1.2a/§3.1 闭合):
N1 毒消息循环崩→退避+dead;N2 门铃丢失→回合末查+超龄告警兜底;N3 门铃重复/风暴→唤醒幂等无害;N4 founder 消息洪泛饿死普通消息→普通消息超龄告警仍触发+批间重排有界;N5 转化后进程崩(外发未执行)→outbox 同事务回滚;N6 僵尸旧 Lead 双处理→generation fence 拒整事务;N7 积压 5000→有界批+批间重查+admission 过载拒 notice;N8 时钟→全部用库内时间(单机);N9 处理中新消息到→下一批(串行模型);N10 告警抖动(清了又积)→episode 销账/新建,行数恒≤1;N11 runner 侧垫片崩→无状态,消息仍 pending;N12 批处理中途 Lead 换代→新旧世代首个 apply 即分胜负,败者零副作用。
