# FLY-2339 有界投递监看 — 调研

Issue: FLY-2339 (https://linear.app/geoforge3d/issue/FLY-2339/引擎urgent-2331-之后-eventloopguard-第二层凶手维护-tick-里同步跑的-delivery)
日期: 2026-09-04
基于: exploration.md

## 1. 取数方法

2026-09-04 约 19:51Z 使用 SQLite backup API 从在线库取得一致性快照：

- `~/.flywheel/teamlead.db`：598 MB
- `~/.flywheel/comm/flywheel/comm.db`：639 MB

全部基准在 `/private/tmp/fly2339-measure.z8xzhj/` 的副本上运行。`watch.runPass` 会写 StateStore，因此没有直接对在线库执行；SQL 分解也只读副本。固定业务时间为 `2026-09-04T19:51:00.000Z`，terminal projection cutoff 为 72 小时前。

取证期间 loop guard 又重复了两次同形状自杀。最后三条分别是 19:42:41Z / 19:50:35Z / 19:58:02Z，stall 62,687 / 63,186 / 63,093 ms，load 25.4 / 15.4 / 10.5；三条均为 `attribution="marker"`、`last_sync_op="delivery-contract:watch"`，且每次都发生在开机约 7–8 分钟的首轮维护。负载下降而 stall 稳定在约 63 秒，进一步排除「只因系统 load 高」的解释。

## 2. 真实规模

### StateStore (`teamlead.db`)

| 表/集合 | 行数 |
|---|---:|
| `workflow_delivery_attempt` 全部 | 4,271 |
| live attempt | 112 |
| `workflow_delivery_contract_episode` | 1,071 |
| `workflow_rework_delivery` | 544 |
| `workflow_delivery_operation` | 10 |
| `workflow_run` | 558 |

live attempt 按 family：mailbox 61、launch 19、rework 17、land 7、phase_wake 6、turn_wake 2。

### CommDB (`comm.db`)

| 表/集合 | 行数 |
|---|---:|
| `mailbox` | 20,340 |
| `sessions` | 49 |
| `session_receipt_lineage` | 1,209 |
| `runner_phase_wakes` | 412 |
| `turn_wake_outbox` | 400 |
| mailbox projection（72h terminal + 当前非终态） | 约 3,140 |

projector 同一 pass 实际 examined 3,664：约 3,132 mailbox、409 phase-wake、123 turn-wake；另有 unsettled attempt 收敛循环。

## 3. 凶手已逐查询定位

`CommDB.listRunnerDeliveryProjectionRows()` 为每条 mailbox projection 候选运行两个相关子查询：

1. `COUNT(DISTINCT active.batch_id)`：当前 planner 选 `mailbox_batch_lookup(batch_id, priority, seq)`，不能先按 `to_agent` 缩小；
2. `MIN(active.delivered_at)`：planner 选 `mailbox_lease_expiry(claim_expires_at)`。

生产快照上只有 4 条当前有效 inflight runner lease（4 个 recipient / 4 个 batch），但第一条查询仍对约 3,140 个外层候选重复扫 `mailbox_batch_lookup`。该索引有 170 页；重复访问约 53 万索引页，解释了高 system/I/O 时间。

分解计时：

| 生产快照查询 | wall time |
|---|---:|
| 完整 `listRunnerDeliveryProjectionRows` SQL（强制消费两个聚合） | 82.75 s |
| 仅强制消费 `COUNT(DISTINCT batch_id)` | 57.44 s |
| 仅强制消费 `MIN(delivered_at)` | 0.46 s |
| 外层 projection/joins，不含两个相关聚合 | 0.45 s |
| 真实 `DeliveryContractWatch.runPass`（110 observed） | 32.543 s |

完整 SQL 与 `runPass` 的绝对值受页缓存影响，但归因不含混：`COUNT(DISTINCT)` 单项已独占 57.44 秒，且 EQP 明确显示错误访问维度。线上 62.687 秒 marker 与这条 SQL 是同量级、同主线程位置。

在加索引后的副本上从 StateStore/CommDB `prepare` seam 计数，一次 112 observed 的 watch 调用了 507 次 StateStore prepare 与 23 次 CommDB prepare，共 530 次，平均 **4.73 次查询/attempt**（无状态变化，故本轮 0 次写）。这验证了 Lead 指出的逐 attempt 点查放大，但数量级仍远小于单条错误相关子查询的 I/O 成本；首要凶手是那 1 条“大查询”，逐行点查是必须由 page 上限控制的第二层成本。

## 4. 三段当前成本

在同一快照上：

| 段 | 当前单次工作 | 实测 |
|---|---|---:|
| projector | 3,664 source rows，逐条投影/点查 | 5.446 s（已临时加索引后；原查询只会更慢） |
| watch | 先物化全部 CommDB projection，再扫 110 个本项目 live attempts | 32.543 s（加索引前） |
| operations | 37 个 open undeliverable episodes 等 | 214 ms |

所以只加索引可拆掉眼前 60 秒引信，但不能证明单次 pass 有界：projector 与三个 list API 仍会随 72 小时历史/未收敛合同线性增长。

## 5. 最小可行物理修复验证

在副本上增加一个 partial covering index：

```sql
CREATE INDEX mailbox_runner_inflight_by_recipient
ON mailbox(to_agent, claim_expires_at, batch_id, delivered_at)
WHERE recipient_kind = 'runner'
  AND carrier = 'inbox'
  AND state = 'LEASED'
  AND delivered_at IS NOT NULL
  AND batch_id IS NOT NULL;
```

结果：

- index build：1.19 s（一次性，仅 1 个 4KB index page）；
- planner 改为 `to_agent=? AND claim_expires_at>?`；
- 原完整 SQL：82.75 s → 0.38 s；
- 原 `watch.runPass`：32.543 s → 653 ms。

再给 mailbox projection 加 `m.seq > cursor ORDER BY m.seq LIMIT 64` 后，EQP 同时变成 `SEARCH m USING INTEGER PRIMARY KEY (rowid>?)`，64 行 SQL 在计时分辨率内为 0.00 s。由此可知「匹配索引 + 主键 cursor + 小页」足以解决，不需要新依赖或 worker。

## 6. 推荐设计

1. CommDB schema/兼容升级加入上述 partial index。
2. projector/watch/operations 各自改为最多 64 个业务对象的 page；cursor 使用既有单调主键（mailbox `seq`、phase `queue_seq`、其余稳定 PK）。
3. plugin 在同一次 maintenance sweep 内逐 page drain；每页仍用原 sync marker 包裹，页间 `yieldToEventLoop()`。这样不改变最终收敛语义，也不把 backlog 推迟到下一次 5 分钟 tick。
4. watch 不再预取全部 mailbox/turn-wake projection；只对本页 attempt 的物理 PK 做点查。`getRunnerDeliveryProjectionRow` 补齐 watch 所需的 inflight 两字段，并由新索引保证点查有界。
5. 回归测试同时证明：单页处理数不超过 64、cursor drain 后全量语义收敛、页间确实 yield、query plan 使用新索引。墙钟基准作为生产快照证据，不作为易抖 CI 断言。

## 7. 部署后验证边界

本实现节点只能给出快照前后与可执行回归。真正的部署后判据是新 build 上线后观察 `~/.flywheel/bridge-loop-guard.log`：不得再新增 `last_sync_op=delivery-contract:*`。发布和观察由独立 updater / QA 流程执行，本节点不越权部署。
