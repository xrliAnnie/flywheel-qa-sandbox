# FLY-2006 14 天全表保留窗清扫 — 探索
Issue: FLY-2006 (https://linear.app/geoforge3d/issue/FLY-2006/数据库清理二期-30-天保留窗全表清扫1995-结案解除保护按-1998-纪律清-session-events-等大头)
日期: 2026-08-23
基于: 无

## 1. 已裁定的目标

Issue 最初询问能否删除 30 天前内容。Tadashi 在问题
`5a154482-c0b7-4d19-9855-b4b0409d6d06` 中回传 Founder 的最新明确裁定：保留窗改为
**14 天**，删除严格早于窗口的历史数据。这个窗口自然覆盖 2026-08-01 至 2026-08-05 的
FLY-1995 风暴 cohort；FLY-1995 已结案，因此不再需要任何 cohort 特例。

Lead instruction `19dab58b-dd1e-489c-98f3-4d80da352214` 指向 Linear comment
`df407e3e-66b8-4484-80f4-597a1f97c50e`，追加唯一的 retention-age 例外：
`comm.mailbox` 中同时满足 `from_agent='voice-honeylemon-fly1911' AND
relay_state='terminal_disposed'` 的 42 条语音原型孤儿，不论年龄纳入本次候选。这个例外只认两个字段的
exact equality；相同 sender 的其他 relay state、其他 sender 的 `terminal_disposed`、或任何扩大到
issue/cohort/prefix 的判据都继续保护。

这 42 个 id 与 FLY-1998 production manifest 当时冻结的 `fly1995.mailbox.baselineIds` 集合完全相等。
FLY-1998 inventory 时它们仍是 open，故当时受调查 baseline 保护；随后已统一变成
`terminal_disposed + resolved_via='fly1995_sessionless_ask'`。FLY-1995 结案同时解除 session-event cohort
与这组 mailbox baseline 的保护。已经 complete 的 v1 evidence 保持 immutable，后续只验证自身 seal/
receipt/digest，不拿已冻结 baseline 再回查变化后的 live DB。

本单不是“扫描时间列后全部 DELETE”。它要把 `teamlead.db` 157 张、`comm.db` 25 张业务表都
纳入 schema classification。除上述 42 条 exact orphan exception 外，只删除同时满足下列条件的行：

1. 时间可解析且严格 `< cutoff14`；等于 cutoff、窗口内、`NULL`、invalid time 全部保留；
2. 表、状态和事件值都在 compile-time 正向 allowlist；新表、新状态、新事件值默认保护；
3. 不关联 live session、`active|held` workflow run、running CommDB session 或其 issue/message lineage；
4. 不属于审批、凭证、裁定、当前配置、当前模板、租约、游标或幂等 authority；
5. 状态已经 terminal/settled，且不存在 late ACK、pending delivery、lease、open gate 等后续写入可能。

生产 `apply` 与 `VACUUM` 仍须绑定 inventory 时冻结的 exact-key manifest，经过快照恢复验证、独立
QA 彩排和 Founder 对同一 manifest 的明确确认。本 implement node 只交付工具、测试、隔离副本彩排
与真实只读 inventory，不执行生产删除。

## 2. 只读现盘

现盘时间为 `2026-08-23 13:40:20Z`，对应 `cutoff14=2026-08-09 13:40:20Z`。以下是进入
policy 判定前的 age/state census，不是最终删除授权：

| 数据 | 总行数 | 14 天前 | 仍须保护/判定的事实 |
|---|---:|---:|---|
| `teamlead.session_events` | 2,815,803 | 2,779,792 | FLY-1995 cohort 2,638,046 行已自然超龄；active/ruling event 仍排除 |
| `teamlead.lead_events` | 88,483 | 68,911 | 2,830 个老行未 delivered；ACK/late-ACK 语义必须继续过滤 |
| `teamlead.workflow_run_event` | 100,365 | 14,334 | 其中 1 行属于 active run；authority kind 必须保护 |
| `teamlead.sessions` | 约 2,438 | 约 1,957 个窄终态 | 当前 6 个 live session；root 不作为本期直接 target |
| `comm.mailbox` | 49,660 | 1,639 | 另有 42 条窗口内 HL exact orphan exception；30 个 `LEASED`、3 个 `QUEUED` 老行及其余审批/问答/裁定保护 |
| `comm.mailbox_log` | 115,066 | 107,838 | 主要是 migrated/process/dispose 历史；与 identity 成对证明 |
| `comm.mailbox_identity` | 102,795 | 47,575 个 archived | schema/reader 均把 identity 定义为永久幂等 authority，全部保留 |
| `comm.receipt_alert_outbox` | 7,772 | 7,772 | 11 个未结算仍保护；其余按 settled 状态判定 |
| `comm.runner_phase_wakes` | 2,785 | 2,785（按 queue time） | 2,366 finished 可判定；pending/started 全保留 |

物理体积：`teamlead.db` 约 1.59 GiB，`comm.db` 约 481 MiB。`session_events` 表与三组 index 约
1.317 GiB，`comm.mailbox_log` 表与 index 约 288 MiB。两库 `journal_mode=WAL`、
`auto_vacuum=0`，所以 DELETE 后必须显式 `VACUUM` 才会缩小 main file。

两库 `quick_check=ok`。`comm.db` foreign-key baseline 为零；`teamlead.db` 已有 7 个与本单无关的
历史 orphan，全部位于 `workflow_submission_credential`。验收不是虚构“零 orphan”，而是要求
apply 前后的 canonical FK fingerprint 完全不变。

## 3. 方案比较

### 3.1 根据列名自动发现并删除（否决）

157+25 张表没有统一时间语义；`created_at` 可能只是 root 出生时间，integer 可能是秒或毫秒，
无时间列的 child 可能仍是活 authority。自动猜测会把未知语义误判为历史。

### 3.2 只给一期脚本增加 `session_events`（否决）

它可以回收最大头，但会再次遗漏 `lead_events`、CommDB migration ledger、settled outbox 和
finished wake，无法回答“全表是否已经盘过”。

### 3.3 全 schema 分类 + 显式多 target registry（采用）

复用 `scripts/fly-1998-database-retention-sweep.mjs` 的 `inventory|apply|rotate-log`、sealed
manifest、逐批 CAS、快照恢复和 receipt 纪律。新增无 I/O registry，要求每张 production 表恰好
属于：

- `delete-target`：具名表、具名状态/事件值与正向 predicate；
- `protected-authority`：审批、凭证、裁定、幂等或运行 authority；
- `protected-current`：配置、模板、owner、cursor、migration/current state；
- `reference-only`：inventory 统计但本期不 mutation。

schema 出现未分类表、registry 声明的表消失、同一表落入多类，inventory 都 fail closed。混合日志
还要对当前已知 enum 做第二层 value classification；未知 value 只计入 `oldProtectedUnknown`。

## 4. 操作合同

### 4.1 Inventory

1. 用 read-only handle + `query_only=ON` 冻结 `cutoff14`、DB dev/inode、schema、trigger 和 FK baseline；
2. 构造 active snapshot：live execution ids、active/held run ids、这些 run 的全部 execution ids、
   running CommDB executions 与其 issue ids；
3. 每个 target 形成互斥 partition：`candidate|recent|invalidTime|activeProtected|oldProtected`，总和必须
   等于 table/policy universe；
4. 小 cohort 冻结 ordered logical keys；大 cohort 冻结有界 PK range + streaming CAS digest shards。
   每个 target 导出独立 0600 SQLite snapshot DB，用 backup API restore 到 scratch 并核对 count、digest
   和 `quick_check`；
5. 记录 182 张表的分类、row count、schema digest、classification reason；
6. 写 sealed manifest 与不含 payload/PK 的 founder summary。

### 4.2 Apply

1. 只消费 sealed manifest，并记录外部 Founder gate 的 question id/response digest；这些字段是审计
   binding，不冒充 authority；
2. 重核 script/schema/trigger/DB identity/FK baseline，并重算 active snapshot；候选只要新关联 active
   lineage 就 fail closed；
3. 按 dependency order 执行 `BEGIN IMMEDIATE` + 完整 CAS：小 cohort 每批最多 200 logical keys，
   高基数表每 shard 最多 50,000 candidates；no-delete trigger 只能按逐名、reader-audited policy 在同一
   事务内撤销并原样恢复；
4. 每批 commit 后写 sealed receipt；已有 receipt 且 keys 已消失才允许 resume；缺 receipt 的 missing
   row、CAS drift、trigger/schema drift 都停止；
5. 每表 `candidateCount === committedDeletedCount`，两库 integrity/FK/protected sentinel 均通过后，
   才写 complete apply receipt。

### 4.3 Vacuum

`vacuum --database teamlead|comm` 是独立命令，只接受 complete apply receipt。每库先 fsync started
marker，再运行一次 `VACUUM`，记录 before/after bytes、page/freelist、identity、duration、integrity
和 FK fingerprint。它不重启 Bridge，也不投紧急重启票。

## 5. 验收与交付边界

1. 当前 production schema 的 157+25 张业务表全部分类，未知项 fail closed；
2. 14 天边界、invalid time、active/held/running、pending/leased/open 和 authority 数据都有保留测试；
   唯一 HL exception 的两个 equality 与三类 near-miss 也有精确回归；
3. 非零 target 快照均 restore-verified；fixture/隔离副本中 dry-run 与 deleted count 逐表完全一致；
4. 两库隔离副本完成 inventory → apply → integrity → VACUUM，main files 实际缩小；
5. implement node 生成 production 只读 inventory 和 summary，生产 DELETE/VACUUM 明确保持未执行；
6. 独立 QA 复核 apply 彩排；Founder 看见 exact counts 后才可对同一 manifest 授权生产 mutation。

现盘数字、active set 和 schema 都会变化；只有工具新生成并 sealed 的 manifest 才能成为后续操作输入。
