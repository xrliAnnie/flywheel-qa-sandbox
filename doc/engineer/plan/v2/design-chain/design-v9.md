# Flywheel v2 设计稿 v9
> 相对 v8:吸收 Codex R8 阻断项([R8-n])。变更:processing_attempts 单 running 约束+CAS 合同(§1.2d);公平池 SQL 修正(_f 索引)+SLA 限定与参数化(§1.2e/§1.2f);重启风暴 kernel 外持久 ledger+独立 meta-alert(§2.11);父抑制子完整状态机(§3.2);两表可执行 DDL(§1.2d/§1.6)。

## §T / 0. / 0.5 / 0.5a / 0.5b [同 v8] + 术语新增:
- **notification debt(通知债务)**:被父告警抑制而暂不发送的子告警通知;父清账后按最新 tier 补发。
- **restart ledger(重启账本)**:kernel 之外、由唯一 OS 级 supervisor 写的重启事件文件账本。

## 1. 数据层
### 1.0 [同 v8:17 张表] / 1.1 [同 v8 obligations 重建] / 1.2-1.2c [同 v8]
### 1.2d processing_attempts(修正:单 running+CAS 合同+可执行 DDL)[R8-H1/M2]
```sql
CREATE TABLE processing_attempts(
  attempt_uid TEXT PRIMARY KEY,
  message_uid TEXT NOT NULL REFERENCES mailbox(message_uid),
  attempt_no  INTEGER NOT NULL,
  instance_id TEXT NOT NULL,
  generation  INTEGER NOT NULL,
  activation_id TEXT,
  started_at  TEXT NOT NULL,
  outcome     TEXT NOT NULL DEFAULT 'running' CHECK(outcome IN ('running','succeeded','failed','crashed')),
  settled_at  TEXT,
  UNIQUE(message_uid, attempt_no)
);
CREATE UNIQUE INDEX pa_one_running ON processing_attempts(message_uid) WHERE outcome='running';
```
- **start**=一个 `BEGIN IMMEDIATE` 事务:校验 current registry(instance/generation/activation)+ mailbox `state='pending'` + **无 running attempt**(pa_one_running 兜底拒),原子分配 attempt_no+稳定 attempt_uid;
- **deliver 重放复用**:已有 running→不开新行,直接把该 attempt 的 {message_uid,payload} 再投递(消费幂等兜底);不做并行 speculative attempt;
- **三类结算全部 CAS**:`UPDATE ... WHERE attempt_uid=? AND outcome='running'`;涉及 retry/dead 的事务同时校验 message 仍 pending;**attempt CAS 与 mailbox CAS 预期行数均=1,否则整事务回滚**——late success 与 failure/crash 交错=只有一方 CAS 成功;
- 验收 [R8]:deliver 首次转化未完成时连续重试不增行;同 activation 多次 start 后 crash 只计 1 次;late success vs failure/crash 交错只一方生效;成功 apply 后立即崩不计 crash;5 次→dead;并发 start 同 message 被唯一索引拒。
### 1.2e 公平性与时间上界(修正)[R8-H2]
- 逐条消费+K=4+超龄晋升 [同 v8];**配额重启语义**:重启后计数器保守恢复为 K(视为 founder 预算已耗尽→有 ready 普通消息则首选之),永不增加欠账;验收=第 4 条 founder 后、强制普通选择前重启;
- **T_max=10min,计时起点=processing_attempts.started_at**(durable start);
- **各阶段硬上限(配置,入公式)**:kernel tick `T_tick≤60s`;deliver 重试退避 cap `T_deliver≤60s`;探针判死+换代 `T_switch≤5min`;
- **SLA 分两档(不再宣称任意消息固定 60min)**:
  ① **队首保证(硬)**:当前最老 ready 非 founder 消息,ready→applied/dead ≤ `T_tick + T_deliver + (K+1)×T_max + T_switch`(默认≈57min);
  ② **一般第 q 老 ready 非 founder(参数化公式,非固定数)**:≤ `T_tick + q×T_deliver + (q×(K+1)+1)×T_max + T_switch`——单消费者串行的诚实代价;q 由 §0.5 过载 admission 控制(notice 类拒收),business 类深积压由 §3.1 超龄告警暴露给监督者;
- 验收:多普通消息排队/旧 founder backlog/deliver 持续失败/换代/配额边界重启五类 wall-clock 断言按上述公式(带参数)判定。
### 1.2f 候选查询与索引(修正:founder 池带谓词)[R8-H2]
**七个 partial index**(全部静态 predicate;基础两个留给驱动/generic 读,age 给 detector):
```sql
-- 基础(v5,驱动/兜底读):
CREATE INDEX mailbox_pending_immediate ON mailbox(to_agent, seq)
  WHERE state='pending' AND next_retry_at IS NULL;
CREATE INDEX mailbox_pending_scheduled ON mailbox(to_agent, next_retry_at, seq)
  WHERE state='pending' AND next_retry_at IS NOT NULL;
-- founder 池(新,带谓词):
CREATE INDEX mailbox_pending_immediate_f ON mailbox(to_agent, seq)
  WHERE state='pending' AND next_retry_at IS NULL AND source_kind='founder';
CREATE INDEX mailbox_pending_scheduled_f ON mailbox(to_agent, next_retry_at, seq)
  WHERE state='pending' AND next_retry_at IS NOT NULL AND source_kind='founder';
-- 非 founder 池(R8 实测已过):
CREATE INDEX mailbox_pending_immediate_nf ON mailbox(to_agent, seq)
  WHERE state='pending' AND next_retry_at IS NULL AND source_kind<>'founder';
CREATE INDEX mailbox_pending_scheduled_nf ON mailbox(to_agent, next_retry_at, seq)
  WHERE state='pending' AND next_retry_at IS NOT NULL AND source_kind<>'founder';
-- detector:
CREATE INDEX mailbox_pending_age ON mailbox(to_agent, created_at) WHERE state='pending';
```
**候选合同**:founder 池=两支 `... AND source_kind='founder' ...` LIMIT 1(命中 _f);非 founder 池=两支 `... AND source_kind<>'founder' ...` LIMIT 1(命中 _nf);应用层在 ≤4 候选中按 K 配额+超龄晋升选 1。detector SQL [同 v8]。
验收:真实迁移建 7 索引;六路候选+detector 逐条 EXPLAIN 断言命中;**反例**:普通 seq=1+founder seq=2 时 founder 池必含 founder(R8 发现的谓词缺失场景)。
### 1.3-1.5 [同 v5]
### 1.6 activations(可执行 DDL)[R8-M2]
```sql
CREATE TABLE activations(
  id TEXT PRIMARY KEY,
  attempt_id TEXT NOT NULL REFERENCES attempts(id),
  session_ref TEXT NOT NULL,
  generation INTEGER NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('active','terminal'))
);
CREATE UNIQUE INDEX activations_one_per_attempt ON activations(attempt_id) WHERE state='active';
CREATE UNIQUE INDEX activations_one_per_session ON activations(session_ref) WHERE state='active';
```
原子换代/幂等重放/验收 [同 v8]。迁移测试均在 `PRAGMA foreign_keys=ON` 下执行(两表皆是)。

## 2. 引擎
### 2.1-2.10 [同 v8]
### 2.11 重启风暴上限(重写:kernel 外权威)[R8-H3]
- **restart ledger**:append-only 文件账本(`~/.flywheel/restart-ledger/<child_key>.jsonl`,每事件 fsync),由**唯一 OS 级 supervisor wrapper** 写入(现实先例=flywheel-bridge-wrapper 的 Bridge-independent fail-loud 通道);**单一 authority 声明**:只有 OS 级 wrapper 计数,进程内监督不计数(消除多层各给 5 次额度);child_key=稳定服务名;
- **窗口算法**:每次重启决策时读 ledger 统计最近 10min 事件数;≥5→**停止自动重启**+写 durable **incident spool** 文件+发 **kernel-independent meta-alert**(wrapper 直连通道,不经 kernel/Bridge);
- **投影**:kernel 恢复后 reconcile 读 spool,以稳定 episode key(child_key+窗口起点)幂等建 obligation;外部 supervisor **永不**直接写 flywheel-v2.db;
- **恢复**:人工恢复=founder/Lead 执行 resume 命令清除 hold;连续健康 30min 自动重置窗口;
- 验收 [R8]:supervisor 在第 4/5 次间崩溃重启后计数不清零;kernel 连续崩溃→第 6 次不拉起+spool+meta-alert 恰一;告警提交前/后崩溃重放幂等;单一 authority(注入进程内假计数不影响)。

## 3. 告警
### 3.1 [同 v8] + 修正:四步事务在插通知 command 前先查抑制(见 3.2);被抑制→记 debt,**不推进 last_notified_tier**。
### 3.2 父抑制子(完整状态机)[R8-M1]
- **匹配键**:静态抑制规则表(设计常量):(parent_kind, child_kind, 同 subject)——如 (agent_down, mailbox_backlog) 按 target_agent_id 匹配;机器可查询;
- **dispatcher claim predicate**:通知 command 可领取 iff 无匹配 open parent obligation——父后开也拦得住(claim 时判);
- **notification debt**:①插入时父已 open→不插 command、不推进 tier,obligation 记 `suppressed_tier`(债);②command 已 pending 后父才 open→command 停在 pending(claim 拦住),它就是债;抑制期 tier 继续升→债合并到最高 tier;
- **解抑**:父清账事务(或 reconcile)原子释放:按**最新 tier** upsert/放行一条通知 command(effect_key=obligation id+该 tier,未被占用无冲突),同事务 cancel 更旧 tier 的被抑制 command;此时才推进 last_notified_tier;
- 验收 [R8]:child-command-before-parent/parent-before-child/claim 后 parent open/父清账前后 crash replay 四交错,断言"父子同 open 只发父;父清后子按最新 tier 恰一条补发"。

## 4. 切换手册 [同 v5] / ## 5. 验收 [同 v8 + 本轮各节新增] / ## 6. 场景 [同 v8 N1-N30] + 增:
N31 重复 deliver 并发 start→pa_one_running 拒;N32 supervisor 崩溃跨窗口→ledger 不清零;N33 kernel 死时风暴超限→spool+meta-alert 不依赖 kernel;N34 抑制期间 tier 连升→债合并,解抑只发最新 tier;N35 普通 seq=1+founder seq=2→founder 池含 founder(谓词验证);N36 q 深积压→参数化 SLA 按公式判,不虚报固定上界。
