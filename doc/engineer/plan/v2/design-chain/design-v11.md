# Flywheel v2 设计稿 v11
> 相对 v10:吸收 Codex R10 阻断项([R10-n])。变更:SLA 倍率重算+数字重出(§1.2e);restart 状态机穷举分支+可重放谓词+episode key 持久化+锁后端(§2.11);suppression 定案=方案A(command 恒 pending,谓词抑制)+parent-clear 清债(§3.2)。§1.2f 四条 SELECT 原样不动。

## §T / 0.-1.1 / 1.2-1.2d / 1.2f / 1.3-1.6 [同 v10]

### 1.2e SLA(倍率重算)[R10-H1]
- 参数同 v10;**deliver 与 T_max 关系明确**:每个 attempt 槽=串联三阶段 deliver(≤T_deliver_tot)→转化(started_at 起 ≤T_max)→超时则换代(≤T_switch);T_max 不含 deliver;
- **attempt 槽总数** `A = 1 + S×(K+1)`,S=(q−1)×5+R(在途 1+每轮 K founder+1 目标);**逐槽成本按 A 计**:
  `T(q,R) ≤ T_tick + A×(T_deliver_tot + T_max + T_switch) + (R−1)×(T_due_cap + T_tick)`
  (retry due 只发生 R−1 次:第 5 次失败直接 dead;每次 due 后计一个 tick);
- **默认值重算**(q=1,R=5,K=4):A=26 → T ≤ 1 + 26×(5+10+5) + 4×(15+1) = **585 分钟 ≈ 9h45m**——数字由公式直接得出,与公式严格一致;R10 的 451 分钟反例时间线 < 585 ✓(N37 按此断言,不再假绿);
- 活性保证/admission/告警暴露 [同 v10];per-attempt 硬上界 [同 v10]。

## 2. 引擎
### 2.1-2.10 [同 v10]
### 2.11 重启风暴(穷举状态机)[R10-H2]
- **持久状态文件内容**:`{state, episode_key, window_start, resumed_at?}`(temp+fsync+rename+目录 fsync);state∈{active, held_alert_pending, held_alert_attempted, resumed};**episode_key 与 threshold claim 同一次 rename 原子落盘**;
- **锁后端 [R10]**:macOS 无 flock(1)——用仓库既有 Python `fcntl.flock` helper 对 `<child_key>.lock` 加锁;**取锁失败=fail-closed 退出不 exec**(另一实例正在裁决,避免双 exec);
- **启动分支(穷举,逐状态)**:
  ① `held_alert_attempted` → 退出,不 exec;
  ② `held_alert_pending` → **不 exec**,执行恢复:ensure-spool(稳定 episode 终址,create-once 幂等,文件+目录 fsync)→ 发 meta-alert(episode_key,at-least-once+sink debounce)→ CAS→held_alert_attempted → 退出;
  ③ `resumed` → 若 now−resumed_at≥30min 且该区间 ledger 无事件 → **惰性 CAS resumed→active**(下一次启动做,无需驻留观察者;若永无重启,resumed 与 active 行为等价,无害)→ 继续按 active 处理;否则按 active 的评估流程处理但窗口只计 resumed_at 之后的事件(旧 episode 事件不计);
  ④ `active` → append 事件+fsync → **可重放谓词** `count(窗口内事件)≥6 AND state=active`(不是"本次为第6次"——append 后 CAS 前崩溃、重启多 append 一条也判定正确)→ 为真:原子 claim(写 {held_alert_pending, episode_key=child_key+window_start, window_start},rename 提交)→ ensure-spool → meta-alert → CAS→held_alert_attempted → 退出不 exec;为假 → exec child;
- **crash replay 覆盖 [R10]**:append 后 claim 前崩→重启走④谓词仍真且不 exec;claim 后 spool 前崩→重启走②补 spool+alert(漏报窗口消除);alert 后 CAS 前崩→②重发(stable key+debounce 去重);resume 后再 crash-loop→③窗口只计新事件,可再次触发 threshold=新 episode_key;
- **resume**:授权命令 CAS held_*→resumed(写 resumed_at);spool=create-once 幂等(rename 提供原子可见,create-once+fsync 提供 durable exactly-once 语义);
- 验收:R10 列出的三类 crash replay+resumed 再失败+锁竞争 fail-closed。

## 3. 告警
### 3.1 [同 v10]
### 3.2 父抑制子(定案:方案A)[R10-M1]
- **command 无新状态**:被抑制的通知 command **恒为 pending**,抑制完全由 dispatcher claim predicate 承担(claim 条件=无匹配 open parent)——删除"suppressed/held 状态"措辞,commands CHECK 枚举不变(无迁移);claim-first 仲裁 [同 v10,已闭合];
- **parent-open 事务**:只记账 obligation.suppressed_tier=当前应通知 tier(债),不动 command(其自然停在 pending 被谓词拦);
- **parent-clear 事务(清债,原子)[R10]**:①若 suppressed_tier>last_enqueued_tier→按最新 tier 插入恰一通知 command(effect_key=obligation id+tier,唯一性防重放双发)+推进 last_enqueued_tier;②cancel 更旧 tier 的 pending 通知 command;③**同事务 suppressed_tier←NULL**;④送达 receipt 后才推进 last_notified_tier;reconcile 重复执行=幂等(effect_key 占用+债已清);
- 验收 N40 扩 [R10]:enqueue/父open/父clear/receipt 四事件的三字段+command 状态收敛;**父 clear 前后 crash replay**;清债后 reconcile 不重复放行。

## 4.-6. [同 v10] + N41 append→claim 崩溃重放谓词;N42 claim→spool 崩溃补发;N43 resumed 再失败新 episode;N44 parent-clear 崩溃重放幂等。
