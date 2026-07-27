# Flywheel v2 设计稿 v7
> 相对 v6:吸收 Codex R6 全部阻断项(5 HIGH+4 MEDIUM,[R6-n] 标注)。核心补齐:删除 mailbox 租约后缺失的**驱动(§1.2b)、消费者身份(§1.2c)、attempt 归因(§1.2d)、公平性(§1.2e)**;修正三层模型 terminal 规则(§1.6)、agent 级 obligation(§3.1)、索引实证(§1.2f)。

## §T 术语表 [R6-M3 修正]
- **标已处理**(=队列 ack):同 v6。
- **门铃**:同 v6——但门铃**只降低时延,不承担活性**;活性由 §1.2b 的必拉+定时+到点调度承担。
- **转化/回执/generation fence/kernel/dispatcher/探针/垫片/obligation/幂等键**:同 v6。
- **claim/租约(已删除的范围=仅 mailbox 消息层)**:删除的是 mailbox 消息的 claim 抢占与 15 分钟租约。**commands/dispatcher 的执行 claim、effect receipt、reconcile 协议完全保持 v5 不变**——外发执行仍需所有权,两个状态机不可混淆。
- **processing-attempt(处理尝试记录)**:开始转化一条消息前落库的短事务记录,崩溃归因的依据(§1.2d)。
- **activation(激活)**:一次 attempt 与一个执行 session 的权威绑定(§1.6)。

## 0. 目标与范围 + DAG 形状可变前提 [同 v6]

## 0.5 消息通道选型 [同 v6] / 0.5a MQ 对标 [同 v6]

## 1. 数据层
### 1.0 权威 schema 全量清单 [R6-H4 修正]
flywheel-v2.db 共 **16 张表**:v5 的 15 张 + **activations**(§1.6)。obligations 增列见 §3.1;consumer registry 落 meta 键空间(`consumer_registry/<to_agent>`,入迁移+备份合同)。全部入迁移与备份合同。
### 1.1 修订点 [同 v5 全部保留] + 新增:
- **obligations 增列** [R6-H5]:`episode_key TEXT`、`target_kind TEXT NOT NULL CHECK IN ('task','agent')`、`target_agent_id TEXT`、`last_notified_tier INTEGER NOT NULL DEFAULT 0`;CHECK(恰一目标:`(target_kind='task') = (target_task_id IS NOT NULL)` 且 `(target_kind='agent') = (target_agent_id IS NOT NULL)`);UNIQUE(episode_key) WHERE state='open'。task 终态 tombstone 触发器**只作用于 target_kind='task'**;agent 级 episode 只按 §3.1 清账条件销账。
### 1.2 mailbox schema [同 v6 DDL 不变] + 索引重做 [R6-M1],见 §1.2f
### 1.2a 消费事务合同(修正版)
每条消息的消费=**kernel 短事务**{业务行(commands/tasks/receipts/events)+ mailbox CAS `pending→applied` + generation 谓词},同 v6;**修正** [R6-H2]:
- **所有** agent 发起的 mailbox 写(applied/retry 更新/dead)一律带 `WHERE state='pending' AND <current-generation 谓词>`;**CAS 影响行数必须恰为 1,否则抛错并回滚整个事务**——不只 fence `pending→applied`。
- 外发副作用=outbox:转化事务只写 pending command;"处理完成"的定义修正为**"回复 command 已持久入 outbox"**(不是"回复已发出");真实发送由既有唯一 dispatcher 执行(§1.4/v5 协议不变)。
### 1.2b 消费驱动(活性合同,新增)[R6-H1]
门铃只能**提前** pull,不是唯一驱动。活性由三个机器机制承担:
1. **注册必拉**:消费者注册/启动成功后必须立即执行一次完整 pull;
2. **低频周期 pull**:每个活消费者保持周期性 pull(Lead=每 30s;runner=垫片注入的回合边界+kernel 周期 hint),对标现实代码 lead-inbox-loop 的 1s/30s 定时拉;
3. **到点调度**:存在未来 `next_retry_at` 时,kernel 持久调度器(与 retention tick 同机制)在最早 due time 触发该收件人的 pull——显式失败的重试**不依赖**新流量/门铃/回合。
**终局收件人处置**:收件人永久消失/superseded(activation terminal 且无继任)时,其 pending 由 kernel 单事务处置——business:原子改投 owning Lead(改 to_agent+事件)或 `dead`+decision event+obligation;notice:tombstone。backlog 告警(§3.1)的通知目标=**仍活着的监督者**(owning Lead/founder),永不只唤醒已死 runner。
### 1.2c 消费者身份与 cutover(新增)[R6-H2]
- **consumer registry**(meta 键空间,机器可查):每个可收件 to_agent 一行 `{agent_id, instance_id, generation, kind: lead|runner, activation_id(runner 时)}`。mailbox admission **拒绝不可路由地址**(无 registry 行的 to_agent 不收信)。
- **注册事务提交=唯一 cutover 点**:新消费者在注册事务提交前不得读/转化;cutover 前旧世代已开启的事务可自然完成;cutover 后旧世代所有写路径(§1.2a 谓词)必败。**authority 由注册事务定义,不由 apply 竞速定义**(N12 修正)。
- **同世代 single-flight**:每进程内以 to_agent 为 key 串行化消费循环——重复/风暴门铃只触发标志位,不并发第二个循环。
- **活着但卡死的代际切换**:必须先硬终止旧进程并由探针确认 absent,再注册新 generation;**禁止**仅凭时间让活进程失权(这正是租约 bug 的根)。
### 1.2d processing-attempt 崩溃归因(新增,无租约的等价物)[R6-H1]
- 开始转化前,**短事务**落 `processing_attempt(message_uid, consumer_generation, attempt_no, started_at)`(落 events 表,kind='processing_attempt',幂等键=message_uid+generation+attempt_no);
- 显式失败:当场结算(outcome=failed,retry_count+1+退避,同一失败事务);
- **硬崩溃**(kill -9/OOM/vendor 崩,进程没机会写失败事务):新世代注册后,把**旧世代未完成的 attempt** 结算为 crash failure(retry_count+1)——前提=旧进程已被探针确认死亡(§1.2c);
- 累计 **5 次实际失败**(显式+crash 归因)→dead(DLQ)。毒消息即使每次都杀死消费者,也在 5 个世代内进入 dead,后续消息继续(N1 修正)。
### 1.2e 公平性与时间上界(新增)[R6-H3]
- **逐条消费,不预取**:每处理完一条重新查询下一条(batch=1);founder 最大插队延迟=**一条在途转化**(分钟级上界,量化写入验收);
- **有界优先,非绝对优先**:连续处理 founder 消息至多 **K=4** 条后,必须处理 1 条最老的 ready 非 founder 消息;
- **超龄提升**:pending >30 分钟的普通消息提升到 founder 同级(与 §3.1 阈值一致);
- 保证:founder 洪泛持续大于处理速率时,任一 ready 普通消息的服务上界 ≤ (K+1)×单条转化时长+超龄提升;验收=洪泛全程持续注入(非灌一批停),断言早期普通消息在上界内 applied/dead。
### 1.2f 索引与查询实证(重做)[R6-M1]
v5 两个 partial index 保留;查询**不用 OR 单查**,按分支各自命中索引(候选各 LIMIT 20,应用层合并+公平选择,候选集有界不物化全表):
```sql
-- 分支1(命中 mailbox_pending_immediate):
SELECT ... WHERE to_agent=:me AND state='pending' AND next_retry_at IS NULL ORDER BY seq LIMIT 20;
-- 分支2(命中 mailbox_pending_scheduled):
SELECT ... WHERE to_agent=:me AND state='pending' AND next_retry_at IS NOT NULL AND next_retry_at<=:now ORDER BY next_retry_at, seq LIMIT 20;
```
founder/超龄排序在应用层对 ≤40 条候选做(无全表 TEMP B-TREE)。**新增超龄侦测索引**:
```sql
CREATE INDEX mailbox_pending_age ON mailbox(to_agent, created_at) WHERE state='pending';
```
验收:真实迁移建三索引成功;上述两分支+侦测查询各自 `EXPLAIN QUERY PLAN` 断言命中对应索引(R5 对旧查询的证明不沿用)。
### 1.3-1.5 [同 v5 不变]
### 1.6 三层执行模型(修正版)[R6-H4]
task→attempt→session 三层;**terminal 规则恢复已闭合不变量**:
- 目标 task **非 terminal**:打回/loop=同一 task 新 attempt(desired 回退,generation+1);
- 目标 task **已 terminal**(无论 issue 是否 Done):新建 `rework_of` successor task,继承 lineage_root_id/thread——task terminal 单调性、dependency unlock、kernel terminal 拒绝、obligation tombstone 合同全部不动;
- **activations 表**(新,第 16 张):`activations(id PK, attempt_id FK NOT NULL, session_ref NOT NULL, generation INTEGER NOT NULL, state CHECK IN ('active','terminal'), UNIQUE(attempt_id) WHERE state='active')`——resume 可复用外部 session 执行体,但每个新 attempt 获得**新 activation+新 generation**,旧 activation 置 terminal+旧 generation capability 撤销;每 task 至多一个 active attempt(partial UNIQUE on attempts)、每 worktree 至多一个活 writer(kernel 校验);
- 入迁移/FK/UNIQUE/备份/crash-replay 验收。

## 2. 引擎
### 2.1-2.3/2.5-2.9 [同 v5/v6 修订不变]
### 2.4a 注入垫片(重写)[R6-H2]
InjectionShim 契约修正:垫片**不再有 ack 方法**。
- 接口:`hint(runner_session)`(注入"有新消息"门铃)或 `deliver(runner_session, {message_uid, payload})`(把消息交 vendor 会话计算);
- vendor 会话的产出**只能以带 generation 的"转化 proposal"提交 kernel**;唯一写路径=kernel 短事务(业务行+`pending→applied`,§1.2a 谓词);垫片/vendor 永不直接翻转 mailbox 状态——"ack 与业务效果分离"的窗口结构性不存在;
- 垫片仍无状态、崩溃即重启;新 backend 只实现 hint/deliver 两方法。
### 2.10 消息处理语义 [R6-H2 修正]
转化三出口不变;"处理完成"=转化产出**已提交**(回复 command 已入 outbox/task 已建/工作项已登记)——外发的实际送达由 dispatcher+effect receipt 追踪,不在消息处理的完成定义里。

## 3. 告警
### 3.1 mailbox 超龄聚合告警(重写)[R6-H5]
- **detector proposal 只是 hint**:kernel 在**一个 immediate 事务**内:①重算该 to_agent 当前超龄集合(以库内为准,不信 detector 携带的 count) ②episode upsert(open,target_kind='agent',target_agent_id=收件人的**监督者**——runner 的=owning Lead,Lead 的=founder;见 §1.2b 终局处置) 或清账 tombstone ③payload 更新+`last_notified_tier` **单调**推进 ④按 tier 变化插入通知 command——四步同事务,无先读后写窗口;
- 通知 effect_key=**本 obligation 行 id+tier**(不复用 episode_key,历史 episode 的旧 command 不会错误去重);backlog 清空时未执行的通知 command 在同一清账事务内置 canceled(不发历史告警);
- 行数语义 [R6-M2]:任一时刻 **open 行 ≤1**/收件人;历史 tombstoned 行保留审计,可多行;验收=两次清空重建后总行数=2、open=1;
- 升档 30min→2h→8h,tier 单调,每 tier 通知一次;
- 侦测查询用 §1.2f 的 mailbox_pending_age 索引+query-plan 断言。

## 4. 切换手册 [同 v5 不变]

## 5. 病例回归矩阵 [同 v6 全部保留] + 修正/新增 [R6]:
- 毒消息验收改:转化中连续 kill -9 五次(跨 5 个世代)→dead,第 2 条消息继续;
- 驱动验收:无任何后续流量时丢门铃,消息仍最终 applied/dead;单条 retry 到点自动重跑(无新流量);
- 身份验收:同世代 100 次并发门铃只出现一个消费循环;两个物理进程同读同一 UID 只有一个业务提交;旧世代 success/failure 两条写路径全败零副作用;runner replacement 后旧 activation 的 proposal 必拒;
- 公平验收:founder 洪泛全程注入,早期普通消息在 (K+1)×转化时长+超龄提升 上界内终态;
- 终局收件人验收:runner 永久终止后其 pending 有确定终局(改投/dead/tombstone),告警路由到活监督者;
- obligation 验收:create/clear 与 consumer apply 交错;每 tier 事务 crash replay;episode1 tombstone 后 episode2 的 30m 通知仍发;目标 runner terminal 时告警到 owning Lead。

## 6. 场景压测附录 [R6-M4 修正+扩充]
29 场景(附录 A)+N 系列修正:
- N5 三分:N5a commit 前崩→业务行/command/applied 全回滚;N5b commit 后外发前崩→mailbox 已 applied、command 仍 pending,dispatcher 重启后发送(**不是回滚**);N5c 外发后 receipt 前崩→probe/effect_key 收敛,Discord 罕见重复接受;
- N10:恒≤1 的是 open episode,历史行保留;
- N12:注册 cutover 决定 authority,非 apply 竞速;
- 新增:N13 retry 到点且无任何新门铃/回合(→§1.2b-3);N14 转化中 hard crash vs 活着卡死(→§1.2d/§1.2c);N15 两个同世代循环(→single-flight)/两个物理消费者(→cutover)/runner activation 换代(→proposal 拒);N16 收件人不存在/terminal/superseded(→admission 拒/终局处置);N17 retention pending→dead 与在途 apply 竞态(→CAS 行数=1,一败一成);N18 generation 注册事务前/后 crash(→注册幂等,未提交=旧世代仍 authority);N19 obligation create/clear 与消费并发(→immediate 事务重算);N20 tier 通知 intent 事务 crash(→同事务原子,重放幂等);N21 同 agent 第二个 episode(→effect_key 含行 id);N22 持续 founder 洪泛(→§1.2e 上界)。
