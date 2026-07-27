# Flywheel v2 设计稿 v13
> 相对 v12:仅修 Codex R12 三项(全在 §2.11)。其余全部同 v12/v11(不动)。

## §2.11 修订三处 [R12]

### 1. N43 断言修正 [R12-H1]
- **正常子例**:resume 后连续 6 次启动→断言前 5 次 exec、第 6 次不 exec、最终 `state=held_alert_attempted`(完整走 claim→spool→alert→attempted);
- **fault-injection 子例**(另设):第 6 次在 claim rename 后立即 crash→断言 `state=held_alert_pending`;下一次启动按 pending 恢复分支补 spool/alert→attempted(N42 语义,不重开)。

### 2. resume 写者纳入同一锁 [R12-H2]
- **全部状态文件写者**(wrapper 启动分支、授权 resume 命令、任何恢复工具)必须先取得同一 `<child_key>.lock`(fcntl,fail-closed 同 v11);
- resume 在**锁内重读**状态,仅当实际状态仍为 `held_*` 时写 `{state=resumed, last_resumed_seq=当前 ledger 最大 seq, ...保留字段}`;锁内条件写=真 CAS;
- 并发第二次 resume:取锁后见 `resumed`/`active`→**幂等 no-op**(明确成功返回但不改任何字段,尤其不刷新计数下界);
- N43 增交错子例:两次 resume 与 wrapper 并发→断言恰一次 resume 生效、无 stale rename 覆盖 active/held、下界只推进一次。

### 3. 计数下界改用 durable ledger cursor [R12-M1,采纳选项2]
- ledger 每行事件带**单调递增 seq**(append 时分配,持久于 ledger 文件行内);
- 状态文件字段改为 `last_resumed_seq`(替代 last_resumed_at 作计数下界;时间戳只负责 10 分钟滑窗);
- **threshold 谓词(终版)**:`count(窗口内事件 AND event_seq > last_resumed_seq) ≥ 6 AND state=active`;
- **缺失语义**:字段不存在/初始 active 状态文件=取 0(等价无下界)——fresh child 与旧状态文件的 crash-loop 完整计数,不受影响;
- 排序保证:seq 全序,与 wall-clock 精度/回拨解耦(same-tick/回拨问题消解);same-tick 测试改为 same-seq 边界测试(event_seq=last_resumed_seq 不计,+1 计);
- 字段在 `resumed→active→held_alert_pending→held_alert_attempted` 全程保留;仅下一次成功的 `held_*→resumed`(锁内 CAS)推进。

其余章节、公式、DDL、SELECT、验收、场景一律 [同 v12/v11]。
