# Flywheel v2 设计稿 v12
> 相对 v11:仅修 Codex R11 唯一阻断项(resumed 状态与 threshold claim 谓词互斥)。其余全部同 v11(SLA/四条 SELECT/suppression 方案A 均已闭合,不动)。

## 全文 [同 v11],唯 §2.11 的 resumed 分支替换如下:

### 2.11 resumed 分支(重写)[R11-H1,采纳最小修订选项2]
- **状态文件增持久字段** `last_resumed_at`(随 resume CAS 原子写入,此后各状态转移保留携带);
- **resumed 启动分支**:取锁后**立即原子 CAS resumed→active**(同一 `<child_key>.lock` 下,temp+fsync+rename;`last_resumed_at` 保留)——resumed 只存在于 resume 命令与下一次 wrapper 启动之间,不再有"按 active 流程处理但状态是 resumed"的混合态,谓词互斥消除;
- **threshold 谓词修正**:`count(窗口内 且 event_ts > last_resumed_at 的事件) ≥ 6 AND state=active`——旧 episode 事件被计数下界排除;post-resume crash-loop 第 6 次启动:append→谓词真→原子 claim {held_alert_pending, episode_key=child_key+新 window_start(> last_resumed_at), window_start}→spool→alert→attempted→不 exec;
- **"健康 30 分钟"语义替换**(消除永不成立的固定起点区间):不再有 resumed→active 的 30min 惰性归档(该转移已即时发生);episode 自然翻页=10min 滑窗+last_resumed_at 下界让旧事件自然老化;状态文件无需归档动作;
- **N43 重写(真实执行)**:resume 后连续 6 次启动(各间隔≤1min):断言前 5 次 exec、第 6 次不 exec、state=held_alert_pending、episode_key 属新窗口(window_start > last_resumed_at);另断言 resume 前旧 episode 事件不计入新谓词。

其余章节、公式、DDL、SELECT、验收、场景(N1-N44)一律 [同 v11]。
