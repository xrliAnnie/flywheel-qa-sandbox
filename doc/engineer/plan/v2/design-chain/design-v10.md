# Flywheel v2 设计稿 v10
> 相对 v9:吸收 Codex R9 阻断项([R9-n])。变更:SLA 单一统一公式+多 attempt 成本(§1.2e);restart episode/hold 状态机+线性化顺序(§2.11);四条 exact SELECT 全文(§1.2f);suppressed_tier 迁移+三 tier 计数分离+claimed 竞态仲裁(§1.1/§3.2)。

## §T / 0.-0.5b [同 v9] + 术语:
- **restart episode 状态机**:`active→held(alert_pending)→held(alert_attempted)→resumed` 的持久文件状态。
- **三个 tier 计数**:`last_enqueued_tier`(已入队进度)/`suppressed_tier`(被抑制的债)/`last_notified_tier`(已确认送达进度)——三个概念三个字段。

## 1. 数据层
### 1.0 [同 v9] / 1.2-1.2d [同 v9,R9 已闭合]
### 1.1 obligations 重建迁移 [R9-M2 补]:在 v8 列基础上**再增** `last_enqueued_tier INTEGER NOT NULL DEFAULT 0`、`suppressed_tier INTEGER`(nullable);原 `last_notified_tier` 语义收紧=**仅在通知 command 的 effect receipt 确认后推进**。迁移/CHECK/replay 测试覆盖三计数单调转换(enqueue→last_enqueued_tier;父 open→suppressed_tier;送达 receipt→last_notified_tier)。
### 1.2e 公平性与时间上界(统一重算)[R9-H1]
- 逐条消费+K=4+超龄晋升+配额保守重启 [同 v9];T_max=10min 计时起点=attempt started_at [同 v9];
- **参数**(全部配置+入公式):`T_tick≤60s`;`T_deliver_tot≤5min`(**deliver 总 deadline**:从应投递起到成功注入或将该 attempt 结算失败——不是退避 cap;内部退避 cap 60s);`T_switch≤5min`;`T_due_cap=15min`(mailbox 退避上限,§1.2);
- **两级保证(唯一口径,不再有第二公式)**:
  ① **per-attempt 硬上界**:任一 attempt 从 started_at 起 ≤ `T_max`,超时→crash 结算+换代 ≤ `T_switch`;
  ② **ready→terminal 统一参数化公式**(q=第几老 ready 非 founder,R=目标剩余 attempt 数=5−retry_count,S=(q−1)×5+R 为可能先于/含目标的非 founder attempt 槽数,+1 为当前在途):
  `T(q,R) ≤ T_tick + (1+S×(K+1))×T_max + S×(T_deliver_tot+T_switch) + R×T_due_cap`
  q=1,R=5 时即队首式(无独立第二式);默认参数下 q=1,R=5 最坏 ≈ 4.6h——**诚实数字**:单消费者+5 次重试+founder 配额的真实串行代价;
- **活性保证(定性,硬)**:配额+超龄晋升保证任一 ready 消息最终被服务(无饿死);深积压(q 大)由 §0.5 admission 拒 notice+§3.1 超龄告警暴露给监督者,不虚报固定分钟数;
- 验收 [R9]:用"5 次失败×每次前 K founder×每次 timeout+switch"反例**按公式算出期望 deadline** 并断言;另四类场景同 v9。
### 1.2f 候选查询(exact SELECT 全文)[R9-M1]
索引七个 [同 v9]。四条候选 SQL(原样入迁移与 query-plan 测试,ORDER BY/LIMIT/绑定参数齐全):
```sql
-- F1 founder·immediate(命中 mailbox_pending_immediate_f)
SELECT seq,message_uid,payload FROM mailbox
 WHERE to_agent=:agent AND state='pending' AND next_retry_at IS NULL
   AND source_kind='founder' ORDER BY seq LIMIT 1;
-- F2 founder·scheduled(命中 mailbox_pending_scheduled_f)
SELECT seq,message_uid,payload FROM mailbox
 WHERE to_agent=:agent AND state='pending' AND next_retry_at IS NOT NULL
   AND next_retry_at<=:now AND source_kind='founder'
 ORDER BY next_retry_at, seq LIMIT 1;
-- N1 非founder·immediate(命中 mailbox_pending_immediate_nf)
SELECT seq,message_uid,payload FROM mailbox
 WHERE to_agent=:agent AND state='pending' AND next_retry_at IS NULL
   AND source_kind<>'founder' ORDER BY seq LIMIT 1;
-- N2 非founder·scheduled(命中 mailbox_pending_scheduled_nf)
SELECT seq,message_uid,payload FROM mailbox
 WHERE to_agent=:agent AND state='pending' AND next_retry_at IS NOT NULL
   AND next_retry_at<=:now AND source_kind<>'founder'
 ORDER BY next_retry_at, seq LIMIT 1;
```
detector SQL [同 v8]。验收:此四条+detector 原样 EXPLAIN 断言命中(实现不得自行改写)。
### 1.3-1.6 [同 v9]

## 2. 引擎
### 2.1-2.10 [同 v9]
### 2.11 重启风暴(episode/hold 状态机)[R9-H2]
- **持久状态**:每 child_key 一个状态文件(`~/.flywheel/restart-ledger/<child_key>.state`),值∈{active, held_alert_pending, held_alert_attempted, resumed};写入=临时文件 fsync→rename→目录 fsync;**单写者**=持有 `<child_key>.lock` flock 的 wrapper 实例;
- **每次 wrapper 启动的线性化顺序**(fail-closed gate):
  ①取 flock ②读状态:held_*→**直接退出不 exec**(滑窗过期**不**隐式解除 hold;唯 resume CAS 可解除)③append 重启事件+fsync ④统计 10min 窗口:本次为第 6 次→CAS active→held_alert_pending(rename 提交)→写 spool(rename,exactly-once)→发 meta-alert→CAS→held_alert_attempted→退出不 exec ⑤未超限→exec child;
- **告警语义修正 [R9]**:spool=exactly-once(rename 原子);外部 meta-alert=**at-least-once+稳定 episode key(child_key+窗口起点)+sink 侧 debounce**(现有 meta-alert.sh 的 marker debounce 即此),不宣称恰一;crash 于 alert 前后→下次启动读 held_alert_pending 重发(幂等靠 key+debounce);
- **resume**:授权命令 CAS held_*→resumed;resumed 后连续健康 30min→归档 episode 状态文件回 active;
- **注**:这是**新的启动 gate 状态机**——现有 flywheel-bridge-wrapper(exec 后不驻留)只证明独立告警通道存在,本机制在 exec 前完成全部判定,不要求 wrapper 驻留;
- 验收 [R9]:第 4/5 次间 wrapper 崩溃→计数不丢;第 6 次判定后任意点崩→重启后仍 held 且告警重发(debounce 去重);滑窗过期不解除 hold;resume CAS 后才可再 exec;kernel 死时 spool+meta-alert 照常。

## 3. 告警
### 3.1 [同 v9] + tier 计数分离 [R9-M2]:四步事务推进的是 `last_enqueued_tier`;`last_notified_tier` 仅在通知 command effect receipt 后推进;被抑制→记 `suppressed_tier`,不动另两者。
### 3.2 父抑制子(修正:schema 落地+竞态仲裁)[R9-M2]
- 匹配键/claim predicate/debt/解抑按最新 tier [同 v9];`suppressed_tier` 已入 §1.1 迁移;
- **parent-open 事务**:原子处理匹配的 **pending** child 通知 command(置 suppressed/held 状态)+记 suppressed_tier;
- **claimed 竞态仲裁(明确定义,收窄验收)[R9-M2 选项 B]**:严格抑制只作用于 pending;**已被 dispatcher claim 的 child command 允许完成该次发送**(claim 先赢)——单条在途窗口秒级、通知类信息性、重复低害;此后各 tier 均被抑制。验收据此收窄:"claim 后 parent open→该条在途通知允许送达,后续 tier 全部抑制;其余三交错按严格抑制断言";
- 解抑事务:按最新 tier 放行恰一条(effect_key=obligation id+tier 未占用),cancel 旧 tier 被抑制 command,送达 receipt 后推进 last_notified_tier。

## 4.-6. [同 v9] + 场景增:N37 SLA 反例按统一公式计算断言;N38 wrapper 每个 crash 点重放→hold 不变量;N39 claim 先赢仲裁交错;N40 三 tier 计数在 enqueue/父open/receipt 三事件下的单调转换。
