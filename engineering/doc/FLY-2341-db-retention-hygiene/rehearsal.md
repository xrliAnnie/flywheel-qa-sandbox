# FLY-2341 529 隔离归档验证 — 验证
Issue: FLY-2341 (https://linear.app/geoforge3d/issue/FLY-2341/引擎db-卫生-数据库无保留策略终态行只增不减teamleaddb-598mb-commdb-639mb让维护扫描随历史线性变慢)
日期: 2026-09-04
基于: plan.md

## 边界与来源

所有写操作只发生在 `/tmp/fly2341-rehearsal.AOPSu5/` 的 SQLite online-backup 副本；生产
`~/.flywheel/teamlead.db` 与 CommDB snapshot 源均只读。源文件 SHA-256 分别为
`eca4c6bce63682c2af9a7384b47471bcdf7ea87fd6aa440d735922f0c2a7612c` 与
`ad0648f728667d17572ec758338f1b411de9df5d1c5d26f9c5881b8a6fc497ff`，副本初始
`quick_check=ok`。

## 2 小时 09 分 checkpoint：速率与 horizon

统一用 129 分钟 wall time 做保守外推；期间包括历史 schema/microsecond timestamp 缺口的 fail-close、
修复与重启时间，因此不是理想化吞吐。`终态安全候选上限` 是 fixed allowlist + terminal/time/child guards
的 cold 已归档数加当前 hot 候选数，尚未扣除 payload active-lineage guard，故只会高估可归档量。

| 表名 | 终态安全候选上限 | 129 分钟已归档 | rows/min | 按 checkpoint 剩余预计小时 |
| --- | ---: | ---: | ---: | ---: |
| `lead_events` | 1,724 | 1,616 | 12.53 | 0.14 |
| `session_events` | 8,547 | 8,155 | 63.22 | 0.10 |
| `workflow_run_event` | 76,716 | 26,417 | 204.78 | 4.09 |
| Comm `mailbox_identity`/`mailbox_log` cold compaction | 116,482 | 116,482 | 902.96 | 0.00 |

Founder/Lead 指令要求在该 checkpoint 停止用“完整 drain”充当判据，后续只采用速率+外推。停止前副本的
TeamLead cold 最终采样为 53,772（`lead_events=1,616`、`session_events=8,155`、
`workflow_run_event=44,001`）；以相同 checkpoint 速率，workflow 剩余 32,715 行约 2.66 小时。

上述 129 分钟 rate table 来自 R1 前实现（head `2cd05f0ee`）的 operator run，作为 debt/horizon 对照
保留，不冒充当前头实测。Code review R2 指出第一版 keyset 页仍由旧复合索引构建 temp B-tree；最终修复
提交 `59469fc48` 使用 `(julianday(time), identity)` allowlist partial index、明确 `INDEXED BY`，并把环形
keyset cursor 跨 tick 保存。`EXPLAIN QUERY PLAN` 回归断言命中专用 index 且没有
`USE TEMP B-TREE FOR ORDER BY`。

在归档前 630MB TeamLead 快照的两份新 online-backup 上，用 `59469fc48` 分别执行每表 5 次单页
`limit=64` 与 5 次真实 runtime `limit=100`（有限采样，不继续 full-drain）：

| source table | 64-row 单页 archived / wall ms（5 次） | 100-row tick archived / wall ms（5 次） |
| --- | --- | --- |
| `session_events` | 每次 64 / `57.4,23.0,11.7,8.3,7.3` | 每次 100 / `20.9,30.6,10.9,7.6,9.4` |
| `workflow_run_event` | 每次 64 / `9.9,6.9,5.2,4.4,6.5` | 每次 100 / `7.7,8.9,7.5,10.3,8.0` |
| `lead_events` | 每次 64 / `14.4,6.3,9.1,28.7,10.8` | 每次 100 / `34.7,10.5,15.6,13.5,9.3` |

R1 前满批基线为 100 rows/tick；当前头 15/15 个真实 tick 都为 100，rows/tick 比率 1.00，超过 Lead
要求的 0.50 下限。15 tick 合计 1,500 行 / 205.4ms（本地 engine 吞吐 438,169 rows/min；不含长期
operator 故障排查时间），相对 R1 前 129 分钟实测的三表合计 280.53 rows/min 也远高于 1/2。单页最大
57.4ms 来自 session 首次冷缓存；deadline 在该页 SELECT 前启动，页完成后立刻 yield，后续四页为
7.3–23.0ms。新 partial indexes 一次性安装为 1,275.9–2,937.2ms，不计入 maintenance page。

## 热表与文件采样

| 指标 | before | 停止时 |
| --- | ---: | ---: |
| TeamLead bytes | 630,681,600 | 674,164,736 |
| `session_events` hot | 369,952 | 361,797 |
| `workflow_run_event` hot | 120,507 | 76,506 |
| `lead_events` hot | 68,819 | 67,203 |
| TeamLead cold | 0 | 53,772 |
| Comm bytes | 670,281,728 | 876,650,496 |
| `mailbox` hot | 20,417 | 20,185 |
| `mailbox_identity` hot | 152,541 | 36,059 |
| `mailbox_log` hot | 144,121 | 16,525 |
| Comm cold | 0 | 116,482 |

同库 cold evidence 使 VACUUM 前总 bytes 增长，这符合设计中“只承诺 hot-path 收缩”的边界，不把它写成
文件缩小。停止采样两库 `quick_check=ok`；R1 前实现的 TeamLead/Comm 最大完整 batch wall time 分别达到
1,079ms/185ms。当前头的 TeamLead deadline 已改为逐页覆盖 candidate SELECT 与完整归档，实测见上方
64-row/100-row 表。

## 三段维护 pass baseline

在独立写时复制副本上执行真实类而非 mock：projector 39,850ms（examined 3,633）、watch 28,907ms
（observed 107）、operations 200ms（examined 37）。归档不修改 FLY-2339 的三段算法；同一停止采样上的
后测、显式 VACUUM 和 exact restore 仍作为 implementation verification 后续步骤，不冒充本 checkpoint
已经完成。生产 Bridge 连续两小时零 stall 也必须等 rollout 后观察，本 implementation 节点不写生产库。

## 演练发现并已测试的升级边界

- 缺 `mailbox_identity.terminal_at` 的历史 CommDB 必须先迁移再执行主 schema；
- production `workflow_run_event_no_delete` 只在 immutable cold row 逐字段等值时放行；
- 历史 ACK 时间可有 6 位小数 UTC；
- 单 identity 冲突用独立 transaction 隔离，legacy keyset cursor 可越过超过 25 行的失败 cohort；
- operator 每轮刷新 Comm running lineage；首个 candidate query 必须实际执行，不能把“deadline 前耗尽”
  伪报成空集；停止判据固定为连续两个全零 pass。

## 最终审查与全仓门禁

R8 在冻结头 `7fb476c167759558646d21453e52ad86aca22577` 返回 `CHANGES_REQUESTED`。本轮按 Lead 裁定修复：

- `workflow-run-event-replay-guard-missing`：checked workflow event 在 hot row 归档后仍从 cold exact lookup
  判定逐字段幂等或冲突；
- `partial-index-predicate-drift`：3 个 keyset 与 3 个 cold lookup index 从 allowlist/lookup 单一 spec 生成，
  启动时读取 `sqlite_master.sql`，只重建定义漂移的 index 并再次校验；
- `per-page-budget-has-no-call-level-cap`：保留 25ms/page，并新增 2 pages/call 与 50ms/call 总上限。

FLY-2339 合入 main 后，本分支普通 merge 其分页 projector/watch/operations；两套维护逻辑的组合单 fork
验证通过。另有 2 MEDIUM + 6 LOW 按 Lead 裁定留作后续，完整 finding key 记录在 `plan.md`。

启动成本口径：首次迁移现在创建/校验 7 个关键 archive index，其中 4 个是 `json_extract` expression
index；调用点在 `StateStore.runMigrations` 的 Bridge 启动 preflight，**不是**首个 maintenance tick。
此前 1.28–2.94s 仅量到 3 个 keyset index，因此只能作为当前首次启动成本的下界，rollout 必须另量。

R9 在冻结头 `f34215210a989484d2c5b3f9610253c1c6e0235a` 返回一个 blocking HIGH。Lead 要求按
retention writer 类而非单点修补：`recordEnrolledTerminalSignal` 与 `commitThreadArchive` 的直接 session
event 写入现已在 transaction 内查 hot+cold；`appendLeadEvent` 的 `(lead_id,event_id)` 去重覆盖 cold，
atomic detection escalation 删除重复 INSERT 并复用该入口；workflow event 的所有 caller 同时使用 cold
`event_uid` 去重与 indexed cold max seq，故“archive→新事件→restore”逐行往返不再撞
`UNIQUE(run_id,seq)`。完整 production 写点 census 与天然不受影响项记录在 `plan.md`。

实现节点全仓门禁结果：

- `pnpm lint`：通过（只有仓库既有 warning/info）；
- `pnpm -r build`：通过；
- `pnpm test:packages:run`：首次精确运行中 Comm 134/134 files、1,913 passed、2 skipped；最终在
  edge-worker 出现一个负载相关 30s timeout 和一个 runner 注入 `FLYWHEEL_STATE_DB_PATH` 导致的环境隔离
  失败。前者单 fork 复跑 365ms 通过；后者清除注入变量后单 fork 10/10 通过。清除注入变量的完整复跑中
  上述两项均通过，唯一失败变为 Comm `gate-marker` 的 `afterEach` 临时目录清理 10s timeout；该文件随即
  单 fork 18/18、1.33s 通过。因此全仓并发 gate 有已隔离的负载抖动，未发现本 PR 的功能回归；
- 受影响面单 fork：Comm 28/28、TeamLead 37/37 通过；未新增
  `scripts/__tests__/*.test.sh`。

R9 类级扫除后的最终 focused gate（单 TeamLead package、单 fork）覆盖 11 个文件：289 passed、1 个既有
skip；包括 generalized execution、dead-exec、terminal immunity、thread archive、detection escalation、
workflow ledger/diagnostic、operator 与 query-plan audit。`pnpm lint` 退出 0（仅仓库既有 warning/info），
`pnpm -r build` 通过，FLY-2006 retention consumer test 4/4 且真实 census `ok:true`。R9 冻结头的 PR 全
CI matrix 也已绿色；R10 新头推送后的 CI 仍作为最终全仓证据。
