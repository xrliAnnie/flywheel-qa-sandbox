# Flywheel v2 设计稿 v8
> 相对 v7:吸收 Codex R7 阻断项([R7-n])+DR 外部对标三处增补([DR])。变更点:runner 真 pull 驱动与 processing_attempts 独立表(§1.2b/§1.2d,表数 17);公平候选 SQL 重写+T_max(§1.2e/§1.2f);obligations 重建迁移+subject/recipient 分离(§1.1/§3.1);activations 双唯一+原子换代(§1.6);监督树重启风暴上限/告警父抑制子/SQLite 写纪律(§2.11/§3.2/§0.5b)。

## §T 术语表 [同 v7] + 新增:
- **T_max**:单条消息转化的硬性时长上限(配置值,默认 10 分钟);超限=活着卡死,走 §1.2c 硬终止换代。
- **backlog subject vs notify recipient**:积压的是谁的信箱(subject) vs 这次告警通知发给谁(recipient,按当前监督关系实时推导)——两个概念两个字段,不混用。

## 0. / 0.5 / 0.5a [同 v7]
### 0.5b SQLite 写纪律 [DR]
写路径纪律(入验收):已知写路径用 `BEGIN IMMEDIATE`(选择性,读路径不用);**每个可写连接**必设 `PRAGMA busy_timeout`;写事务必须短(禁止在写事务内做网络/LLM 调用);读者短命防 WAL checkpoint 饿死;库只放本地盘;禁用 BEGIN CONCURRENT 等非主线特性。验收:审计所有 kernel 写路径皆为 IMMEDIATE+短事务;busy_timeout 在连接工厂统一设置。

## 1. 数据层
### 1.0 权威 schema 全量清单 [R7-H1 修正]
flywheel-v2.db 共 **17 张表**:v5 的 15 张 + **activations**(§1.6)+ **processing_attempts**(§1.2d)。consumer registry 落 meta 键空间。全部入迁移+备份合同。
### 1.1 修订点 [同 v5 保留] + obligations **重建迁移** [R7-H3]:
- `target_task_id` 显式改为 **nullable**(表重建迁移,旧行保真);
- 增列:`episode_key TEXT`、`target_kind TEXT NOT NULL CHECK IN ('task','agent')`、`target_agent_id TEXT`(=**backlog subject**,即谁的信箱积压)、`notify_recipient_agent_id TEXT`(=当前通知收件人,§3.1 事务内按 registry 实时推导)、`last_notified_tier INTEGER NOT NULL DEFAULT 0`;
- CHECK 恰一目标:`(target_kind='task' AND target_task_id IS NOT NULL AND target_agent_id IS NULL) OR (target_kind='agent' AND target_agent_id IS NOT NULL AND target_task_id IS NULL)`;UNIQUE(episode_key) WHERE state='open'(partial unique index);
- task 终态 tombstone 触发器只作用 target_kind='task';agent episode 只按 §3.1 清账;
- 迁移测试:旧 task 行保真/agent 行可插/双空双填均拒/owner 换代后通知新 owner/subject terminal 后行仍可审计且通知活监督者。
### 1.2 mailbox schema [同 v6 DDL] / §1.2a 消费事务合同 [同 v7] + 补:processing_attempts 的 start 写与 mailbox 写同属 fence 家族(见 §1.2d,一切 agent 发起写带 generation 谓词+行数校验)。
### 1.2b 消费驱动(活性合同)[R7-H1 修正]
Lead:注册必拉+30s 周期 pull+到点调度(同 v7)。
**Runner(修正——不再依赖可丢 hint)**:kernel timer(与 retention/侦测同 tick 机制)**实际查询**该 runner 的 ready mailbox;有 ready 行→执行 **durable deliver**:经垫片 `deliver(message_uid,payload)` 注入 vendor 会话,并持续重试(带退避)直至观察到该消息进入终态(applied/dead)或 runner activation terminal——deliver 可重复,消费幂等(§1.2a)兜底。due scheduler 重启后重建最早 due;未观察到 pull/终态前一直重试。hint 仍可用作低延迟加速,但活性从不依赖它。
终局收件人处置 [同 v7]。
### 1.2c 消费者身份与 cutover [同 v7]
### 1.2d processing_attempts(独立表,完整状态机)[R7-H1 修正]
```sql
processing_attempts(attempt_uid TEXT PK, message_uid TEXT NOT NULL REFERENCES mailbox(message_uid),
  attempt_no INTEGER NOT NULL, instance_id TEXT NOT NULL, generation INTEGER NOT NULL,
  activation_id TEXT, started_at NOT NULL,
  outcome TEXT NOT NULL CHECK IN ('running','succeeded','failed','crashed') DEFAULT 'running',
  settled_at, UNIQUE(message_uid, attempt_no))
```
- **start fence**:start 短事务校验 message `state='pending'` + 当前 `{instance_id,generation,activation_id}`(cutover 后旧世代 start 必拒)——与 §1.2a 同一 fence 家族;
- **成功结算**:`outcome='succeeded'` 的 UPDATE **与业务行+`pending→applied` 同一事务**——成功提交后崩溃与转化中崩溃在账上可区分;
- **显式失败**:同一失败事务按 attempt_uid exactly-once 结算 `failed`+retry_count+1+退避;
- **crash 归因**:新世代注册后,对旧世代 `outcome='running'` 且 message 仍 pending 的 attempt,按 attempt_uid exactly-once 结算 `crashed`+retry_count+1——前提=旧进程已探针确认死亡;
- 独立小表,不进 events 归档(open attempt 无归档资格问题消解);终态行按 retention 90 天清理;
- 验收:cutover 后旧世代 start 拒;成功 apply 后立即崩溃不计 crash;5 次(显式+crash)→dead;并发 start 同 message 只一行 running。
### 1.2e 公平性与时间上界 [R7-H2 修正]
- 逐条消费(batch=1)+K=4 有界优先 [同 v7];配额状态=进程内计数器,重启归零(声明:重启后首轮重新计数,上界仍成立,无需持久化);
- **T_max=10 分钟**(配置):单条转化超限=活着卡死→§1.2c 硬终止+换代,该 attempt 计 crash;
- **上界(精确化)**:任一 ready 普通消息从 ready 到 applied/dead ≤ `(K+2)×T_max`(在途 1 条+K 条 founder+自身)=默认 **60 分钟**;叠加超龄提升(30 分钟,§3.1 同阈值):pending>30min 的普通消息晋升 founder 同级按最老优先——洪泛下实际上界由晋升主导;
- 验收:founder 洪泛全程持续注入(生产速率>消费速率),断言早期普通消息在上界 wall-clock 内终态;**反例场景**:普通消息在候选前 20 之外(§1.2f 结构性保证其可见)。
### 1.2f 候选查询与索引(重写)[R7-H2]
**四个 partial index**(全部静态 predicate,可执行 DDL):
```sql
CREATE INDEX mailbox_pending_immediate ON mailbox(to_agent, seq)
  WHERE state='pending' AND next_retry_at IS NULL;
CREATE INDEX mailbox_pending_scheduled ON mailbox(to_agent, next_retry_at, seq)
  WHERE state='pending' AND next_retry_at IS NOT NULL;
CREATE INDEX mailbox_pending_immediate_nf ON mailbox(to_agent, seq)
  WHERE state='pending' AND next_retry_at IS NULL AND source_kind<>'founder';
CREATE INDEX mailbox_pending_scheduled_nf ON mailbox(to_agent, next_retry_at, seq)
  WHERE state='pending' AND next_retry_at IS NOT NULL AND source_kind<>'founder';
CREATE INDEX mailbox_pending_age ON mailbox(to_agent, created_at) WHERE state='pending';
```
**候选合同(exact SQL,每轮选下一条)**:四路候选各 LIMIT 1——founder 池=分支1/2(同 v7 SQL,LIMIT 1);**非 founder 池**=分支3/4(同构 SQL 加 `AND source_kind<>'founder'`,命中 _nf 索引,LIMIT 1)——**最老 ready 非 founder 结构性必在候选内**,founder 前缀无法遮挡;应用层按 K 配额+超龄晋升在 ≤4 条候选中选 1。
**detector exact SQL**(per-recipient,收件人来自 consumer registry 枚举,无全局 GROUP BY 扫描):
```sql
SELECT count(*), min(created_at) FROM mailbox
 WHERE to_agent=:agent AND state='pending' AND created_at<=:cutoff;
```
验收:真实迁移建 5 索引成功;四路候选+detector 逐条 `EXPLAIN QUERY PLAN` 断言 SEARCH 命中对应索引(本机已实测分支1/2/age 命中;_nf 两支入迁移验收)。
### 1.3-1.5 [同 v5] 
### 1.6 三层执行模型 [R7-M1 修正]
terminal 规则 [同 v7,已闭合]。activations 修正:
```sql
activations(id TEXT PK, attempt_id TEXT NOT NULL REFERENCES attempts(id),
  session_ref TEXT NOT NULL, generation INTEGER NOT NULL,
  state TEXT NOT NULL CHECK IN ('active','terminal'));
CREATE UNIQUE INDEX activations_one_per_attempt ON activations(attempt_id) WHERE state='active';
CREATE UNIQUE INDEX activations_one_per_session ON activations(session_ref) WHERE state='active';
```
(两个 partial unique index,可执行 DDL——同一 session 双 active 被 DB 拒。)
**原子换代**:{旧 activation→terminal + 旧 capability revoke + 新 attempt/activation 插入 + consumer registry cutover}=**一个 kernel immediate transaction**,以稳定 activation id/request id 幂等重放;验收=每个可注入 crash 点重放后恰一 active activation/一 current generation/旧 capability 全拒。

## 2. 引擎
### 2.1-2.10 [同 v7]
### 2.11 监督树与重启风暴上限 [DR]
kernel 服务/桥/垫片/Lead 启动器按监督树管理(OTP 语义):子进程按关系重启;**最大重启强度**=同一子进程时间窗内(默认 5 次/10 分钟)超限→停止自动重启+建 obligation 告警到监督者(founder/Lead)——防重启风暴。验收:注入连续崩溃子进程,断言第 6 次不再自动拉起且告警恰一条。

## 3. 告警
### 3.1 mailbox 超龄聚合告警 [同 v7 四步单事务] + 修正 [R7-H3]:
- `target_agent_id`=backlog **subject**(谁的信箱积压);`notify_recipient_agent_id`=**当前通知收件人**,在同一 kernel 事务内按当前 registry/监督关系推导(runner→owning Lead,Lead→founder);owner 换代/收件人 terminal 时重推导重路由;
- 通知 effect_key=obligation 行 id+tier [同 v7]。
### 3.2 告警父抑制子 [DR]
Alertmanager 语义:父 obligation open 时抑制其子类告警的通知(如"runner 死亡" open 时抑制该 runner 的"信箱积压"通知——积压是死亡的下游);抑制只作用通知层,obligation 行照常记账;父销账后子若仍成立按其 tier 正常通知。验收:父子同 open 时只发父通知;父清后子补通知。

## 4. 切换手册 [同 v5]

## 5. 病例回归矩阵 [同 v7 全部] + 增:
- §1.2d 四条验收;§1.2e 反例场景;§1.2f 五索引 query-plan;§1.1 obligations 迁移五测;§1.6 crash 点重放;§2.11 风暴上限;§3.2 父抑制子。

## 6. 场景压测附录 [同 v7 N1-N22] + 增:
N23 runner 空闲+hint 全丢→kernel timer 查询+durable deliver 兜底;N24 成功 apply 后立即崩→attempt=succeeded 不计 crash;N25 旧世代 cutover 后尝试 start→fence 拒;N26 普通消息在 founder 前缀 20+ 条之后→_nf 候选路结构性可见;N27 转化超 T_max→硬终止换代计 crash;N28 owner 换代后 backlog 告警→通知新 owner;N29 同 session 双 attempt 双 active→DB 唯一索引拒;N30 换代事务任意点崩→幂等重放收敛恰一 active。
