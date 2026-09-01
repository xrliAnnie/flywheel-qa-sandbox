# FLY-2210 节点停留巡检 — 探索
Issue: FLY-2210 (https://linear.app/geoforge3d/issue/FLY-2210/巡检舰队规范-3小时节点停留规则超阈强制-deep-dive勾销台账重置计时等-founder-提醒founder-拍板-v2-设计)
日期: 2026-08-31
基于: 无

## 已拍板边界

Founder 于 2026-08-31 19:32 拍板 v2 设计开工。权威设计页：
https://fw-reports-a53de2.vercel.app/r/217e0dbfeffa6bc8170d49b192f7ae23/

本单只实现机器层与纪律层，不重设计：

- `teamlead.db` 新建 `node_dwell_review`，主键为 `(run_id,node_id,attempt,cycle_no)`，`verdict` 只允许 `normal|cleared|fixed|waiting_founder`；
- 在场节点严格来自 active `workflow_run` 与 `workflow_run_node` 的未结束 `running|review|admitted` 行；
- 停留基线为 `max(started_at, 最新 examined_at)`，阈值来自 scoped `flag_values.node_dwell_threshold_hours`，无值默认 3 小时；
- 超阈后一律进入处置：founder 等待态只提醒，不做 deep dive；其余强制读终端内容和工作日志，判断真实推进或空转；
- 收据的 `examined_at` 是下一轮基线，不改写引擎 `started_at`；
- 沿用现有巡检钟与 issue thread，不加独立 daemon 或告警进程。

## 等 founder 的两个判据

两者取或：

1. 当前节点 `node_id='founder_gate' AND state='review'`；
2. 同 issue 的 CommDB 存在 `checkpoint='approve_to_ship'` 且没有 response 子消息的开放卡。

命中后，同一 issue 的多项等待合并为 thread 内一条提醒；只有提醒成功后才在同一事务里为本条提醒覆盖的每个 node 写 `waiting_founder` 收据，因此整组节点三小时内不重复提醒，也不会部分落账后立刻重报。

## 验收

必须由可执行回归证明：4 小时节点被报出；写收据后立即消失、三小时后重现；`founder_gate/review` 只走提醒分支。规则文本必须原样保留 FLY-2178 的教训：禁止只看画面是否刷新，必须读内容判断推进或原地空转。
