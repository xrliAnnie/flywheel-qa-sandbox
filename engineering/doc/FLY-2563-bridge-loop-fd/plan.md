# FLY-2563 Bridge 响应与连接寿命 — 实施计划
Issue: FLY-2563 (https://linear.app/geoforge3d/issue/FLY-2563/bridge-ship-judgment-modetick-每-3s-同步跑)
日期: 2026-09-14
基于: research.md

Status: design review pending

## 0. 交付目标与权威边界

在不改变审批、取消归因和历史卡身份的前提下，让 Bridge 的周期查账工作量受候选页约束，关闭失去所有者的 CommDB 连接，并提供可信的 fd 与事件循环健康信息。

此计划供 eng_implement 与独立 QA 沿共享工作流执行；设计节点不实现、不派发、不重启、不请求 ship authority。代码合并与生产部署仍分离，部署只由独立 updater 在授权窗口完成。机器 opinion/outcome/cursor 不是授权，自动审批 mode 保持原值。

Lead clarification `90054f86-ebf0-4256-ab41-9b1d37213565` 是第 9 条语义依据：终态转换证据首次消费一次，例行 reconciliation 只查非终态；重放幂等。第 10/11 条不做：不归档 workflow_gate_holder，不改变 swapoutMinPages。

## 1. 模块边界与文件映射

| 文件（均为 repo 相对路径） | 责任 |
|---|---|
| `packages/teamlead/src/ship-judgment/observation-cursor.ts`（新） | 安装增量索引/游标/待办、取有界源页、提交进度，输出只读统计 |
| `packages/teamlead/src/ship-judgment/outcomes.ts` | 逐源/逐 holder 处理，保留归因与冻结目标验证；不再全历史联表 |
| `packages/teamlead/src/ship-judgment/runtime.ts` | 3 秒本地页预算、让出事件循环、独立网络 lane、停止/模式守卫 |
| `packages/teamlead/src/ship-judgment/clarifications.ts` | 使用现有 learning_cursor，收紧每次条数/时间预算 |
| `packages/teamlead/src/StateStore.ts` | 安装迁移顺序；传递原始连接计时；健康读取现有 Store 接口 |
| `packages/teamlead/src/bridge/fleet-comm-operations.ts`（新） | 从 plugin 提取 notifyLeadInstruction 与 readZombieCandidates，明确打开/关闭所有权 |
| `packages/teamlead/src/bridge/plugin.ts` | 挂接上述函数、资源采样、统一告警、health、启动/关闭 |
| `packages/teamlead/src/bridge/commdb-lead-runtime.ts` | legacy runtime 从每 Lead 常驻连接改为每次同步操作打开/关闭 |
| `packages/teamlead/src/bridge/gate-poller.ts`、`founder-reply-deliverer.ts`、`event-route.ts`、`founder-routing-response-route.ts` | 已审计消费者；仅修改实测未关闭或跨网络持有且无上限的 ownership，保留所有 receipt/lease 语义 |
| `packages/teamlead/src/bridge/process-resource-monitor.ts`（新） | fd 采样缓存/失效状态、>80% episode、健康 getter；无健康请求时的子进程 |
| `packages/teamlead/src/bridge/event-loop-attribution.ts` | 复用当前 lag；增加样本窗口、状态和兼容别名 |
| `packages/config/src/sql-timing.ts`、`packages/config/src/index.ts`（前者新） | 无数据库依赖的实例级同步执行计时；稳定 SQL 摘要 |
| `packages/flywheel-comm/src/db.ts` | 所有 writable/readonly/maintenance 打开入口接入计时；保留 constructor 异常清理 |
| `packages/claude-runner/src/sync-op-marker.ts` | 既有 marker 计时/告警，不改变原异常或返回 |
| `packages/teamlead/src/terminal-row-archive.ts` | 三表先选候选再资格过滤；持久化扫描位置；保留 cold restore/digest 保护 |
| `scripts/flywheel-bridge-wrapper.sh` | exec 前提升软限；保留已有 preflight/部署与锁逻辑 |

补充审计清单 `commdb-open-sites.txt` 与 `timer-sites.txt` 必须在 implementation.md 更新分类结果；单纯 grep 是发现工具，不是泄漏或覆盖证明。不创建全局共享连接池、不改数据库驱动、不搬运所有 SQLite 到 worker。

## 2. 持久化模型与迁移

所有新增对象在 StateStore 源表、holder、verdict、ship_judgment_outcome 已安装后建立，在 observers 启动前提交。migration id 固定为 `fly-2563-observation-budget-v1`。新鲜库、旧库、已打应急索引库、重复启动均覆盖。

```sql
CREATE INDEX IF NOT EXISTS idx_fly2563_closeout_cursor
ON session_events(project_name, source, id)
WHERE event_type='closeout_report'
  AND json_extract(CASE WHEN json_valid(payload) THEN payload ELSE '{}' END,
                   '$.disposition')='canceled';
CREATE INDEX IF NOT EXISTS idx_fly2563_verdict_cursor
ON workflow_founder_gate_verdict(recorded_at, verdict_id);
CREATE INDEX IF NOT EXISTS idx_fly2563_holder_run_question
ON workflow_gate_holder(run_id, question_id);
CREATE INDEX IF NOT EXISTS idx_fly2563_run_issue
ON workflow_run(project_name, issue_id, run_id);

CREATE TABLE IF NOT EXISTS ship_judgment_observation_cursor (
  project_name TEXT NOT NULL,
  source_kind TEXT NOT NULL CHECK(source_kind IN ('closeout','b2')),
  last_event_id INTEGER NOT NULL DEFAULT 0 CHECK(last_event_id>=0),
  last_recorded_at TEXT NOT NULL DEFAULT '',
  last_verdict_id TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL,
  PRIMARY KEY(project_name,source_kind)
);
CREATE TABLE IF NOT EXISTS ship_judgment_observation_pending (
  project_name TEXT NOT NULL,
  source_kind TEXT NOT NULL CHECK(source_kind IN ('closeout','b2')),
  source_id TEXT NOT NULL,
  run_after TEXT NOT NULL DEFAULT '',
  question_after TEXT NOT NULL DEFAULT '',
  reason TEXT NOT NULL CHECK(reason IN
    ('partial','future','late_insert','dependency','invalid_source')),
  next_attempt_at TEXT,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts>=0),
  updated_at TEXT NOT NULL,
  PRIMARY KEY(project_name,source_kind,source_id)
);
CREATE INDEX IF NOT EXISTS idx_fly2563_pending_due
ON ship_judgment_observation_pending(project_name,source_kind,next_attempt_at,source_id);
```

`source_id` 对 b2 是 verdict_id；对 closeout 是 session_events.id 的十进制字符串，和已有 outcome 的 `event:question` 身份不同层级，禁止混用。`run_after/question_after` 只给取消 fanout 用。扫描页与 pending 只在这两张表储存处理位置；观察结果仍唯一写入原 ship_judgment_outcome。

初始化两条 cursor 为起点，不用 MAX(id)/now 跳过尚未处理的历史事件。旧已有 outcomes 用唯一键跳过，不改写其 evidence。游标 missing=首次初始化；游标坏值=暂停该观察源并告警，不能静默跳到最新。

为晚到 B2 行增加一个 AFTER INSERT 触发器：仅当 NEW 的 `(recorded_at,verdict_id)` 小于等于对应 `flywheel/b2` 水位，且 run 属于 flywheel，才 `INSERT OR IGNORE` pending(kind=b2,source_id=NEW.verdict_id,reason=late_insert,next_attempt_at=当前时间)。触发器在源 INSERT 的事务内执行；不修改 verdict 行、不依赖 rowid，不改变原 verdict source_event_id 唯一约束。正常顺序插入无需额外 pending。已有 verdict 从起点补读；clock rollback 与相同 timestamp 由此覆盖。

验明新索引列序与 SQL 谓词；发现同名异定义返回明确 migration error，不能以 IF NOT EXISTS 假装正确。应急旧名字可能为 `idx_fly2563_session_events_closeout_canceled` 或现场实际 `idx_session_events_closeout_canceled`：保留其已有定义，不重命名或先删。新 id 顺序索引满足“或等价”。所有 ALTER/CREATE 和 migration receipt 原子提交；磁盘/锁失败时新 observer 不启动，保留原数据并清晰暴露失败，不静默切回 3 秒全扫描。

一次性索引构建必须独立记录 wall time/数据库大小/SQLite 版本；启动迁移可能昂贵，不能计入 `<50ms` 常态函数后声称迁移也快。部署者在隔离副本测量后安排 updater 窗口。

## 3. 源页算法（关键正确性合同）

### 3.1 先选源，后关联

每次 `observeCancellations(now)` 保持返回新增 outcome 数字的调用合同；内部增加 `pageStats()`/注入 observer 提供测试计数：sourceCandidates、holderCandidates、outcomes、elapsedMs、cursorBefore/After、deferred。SQL 标识固定 `ship-judgment.closeout-page`。

```sql
SELECT id,ts,issue_id,project_name,event_id,
       length(CAST(payload AS BLOB)) AS payload_bytes
FROM session_events INDEXED BY idx_fly2563_closeout_cursor
WHERE project_name=? AND source='bridge.lifecycle-closeout'
  AND event_type='closeout_report'
  AND json_extract(CASE WHEN json_valid(payload) THEN payload ELSE '{}' END,
                   '$.disposition')='canceled'
  AND id>?
ORDER BY id LIMIT ?;
```

参数依次为服务端项目 flywheel、持久化 cursor、固定≤32的页量；不接受客户端表名/索引/SQL。先执行并物化此源页，再按 id 取≤64KiB 的 payload。不能把 holder join 移进此句、不能把用户传入 LIMIT 放大到无界。一个调用最多处理16个 event/holder pair，总同步预算25ms；检查在每个源/holder 开始前以及提交前执行。

B2 源页单独 SQL，仅从 verdict 索引取 `(recorded_at,verdict_id)` 严格大于水位的≤16个身份，不做前置 holder/outcome join。按 verdict_id 点查。不要在源页加 `recorded_at<=now`：原时间可能格式异常/未来，由下述逐条规则处理，不能堵住后续有效事件。

### 3.2 一对多与精确关联

- closeout 用 `project_name/issue_id` 的直接 run 索引 + 已有 `workflow_run_issue_alias(issue_alias,run_id)` 索引两条查询取匹配 run，合并去重；不得用近似 issue 文本或当前最新卡替换原绑定。
- run 按 run_id keyset 前进；每个 run 的 holder 按 `(run_id,question_id)` 索引 keyset 前进。每级先限定≤16候选，再在 JS 检查原 run/card 创建时间。总 pair 上限16覆盖所有 run，而非每个 run 各16。未完成的一对多展开写 pending.partial，保存确切已处理的 `(run_after,question_after)`；后续继续，不能仅推进 event id 后漏掉第17张卡。
- 保留当前 `rootMatches`、匹配 run 数 `LIMIT 2` 唯一性判定、Linear canceled/terminal_authorized/时间顺序、frozenTargetContext、delivery_at_observation 逻辑。run 多义或无可信原始证据仍为 unknown/unresolved，绝不自动提高为 founder_verified。
- 原查询会为每个历史匹配 holder 记录独立取消结果；首次消费新事件保留此语义，包括 approved/superseded holder。不存在“先 state 非终态过滤再读终态事件”。例行扫描只能使用现有 holder 枚举的非终态集合（materializing/awaiting_review），不新增宽泛终态 reconciliation。
- B2 点查由 verdict.question_id 关联原 holder，并继续核对 run_id/attempt/gate_node_id 与 card/head。不能以当前新 head 重新绑定旧 verdict。

### 3.3 原子性、异常与晚到

同一个小事务内：校验当前游标→写/确认唯一 outcome→更新 pending→推进输入 cursor。临界区不 await。任何 SQL/验证意外抛错回滚该页（包括 cursor）；错误不影响另一个源或模式调度。已有相同 outcome 的重放是 no-op，但该候选仍能推进水位；禁止 INSERT OR REPLACE。

| 条件 | 处理 |
|---|---|
| 无新源行 | 0 次 holder 查询；水位不回零 |
| source.ts/recorded_at 在未来 | pending.future，next_attempt_at 为到期时刻；推进源水位，后续新源不受阻 |
| 时间不合法 | pending.invalid_source，next_attempt_at=NULL，记录静态错误码和 source id；不造决定时间、不紧循环 |
| 缺 holder/run（如 restore 次序） | pending.dependency，60秒退避；按 source id 重查依赖；10次失败保留可见隔离行/告警，不删除证据；正式修复依赖后的管理重放以精确 source id 重置 due |
| B2 倒填旧时间或相同时间较小 id | AFTER INSERT 原子写 late_insert，按精确 verdict_id 处理；主水位不能后退 |
| 中途预算耗尽 / >16 pair | pending.partial 保存展开位置，事务提交已完成 pairs；主水位允许前进，因为余项已经持久化 |
| crash 在 commit 前 / 后 | 前：页全回滚；后：pending/cursor/outcome 一致；再次调用不重复副作用 |
| mode=off / stop | 不取新页、不发网络；已提交 cursor 保留，重开从原位续读 |
| 重复 closeout 事件 | 不同 source id 保留独立审计；原 learning.duplicate_cancellation 判定继续排除重复学习样本 |

每次 pending due 查询最多8个身份，其处理消耗上述全局 pair/25ms 预算；保留一半预算给新输入，避免坏依赖饿死新事件。隔离行不是“已经成功消费”；以 health diagnostics 的 deferred/invalid 计数和告警显式记录。恢复工具仅面向服务端来源身份，不能允许 payload/prose 修改授权。

模式 off 时未来积压可能超过7天。归档必须保留本观察源尚未到达的 closeout（id>cursor）与 pending source；缺 cursor 同样保留。只用便宜 type/source/id 检查，不能为了归档再全表 JSON 解析。既已归档的历史行保持原 restore 合同，不在本次循环暗中全量扫描冷库；恢复热行后的精确源重放使用 pending，不能回退全局水位。

## 4. modeTick 与事件循环预算

保持3秒模式感知；把网络 modeSweep/learningSweep 与本地观察分离。`modeTick():Promise<void>` 只等待有界本地轮次，正常总 wall time目标<100ms；每次依次调用 verdict一页、yieldToEventLoop、cancellation一页、yield、clarification一页。clarification 用现有 learning_cursor，每次最多16个 outcome、25ms，游标只到最后实际处理项。

本地单飞 latch 必须在开始工作前赋值：`const flight=Promise.resolve().then(runLocalPages); localFlight=flight; return flight.finally(clearExactFlight)`。finally 只清同一 flight；同步抛错也不留下永久占用。不得通过“异步函数开头已执行但 latch 尚未赋值”造成重入。

网络独立 `deliveryFlight` 与 AbortController，最多1个；已有 bridge transport timeout/abort 继续生效，单网络轮次再受总deadline 15秒约束。deadline 必须传到底层 fetch/子操作并等待清理，不能仅 Promise.race 后允许原操作无限重叠。网络失败不会阻止下个本地输入页。stop 清 interval、abort、await 两个 flight 和原 scanner/worker/stopSources；off 在每次 yield/await 后重新读取 mode，并禁止新 transport/evaluation。dry_run 才启动现有评估；auto_merge_narrow_gate 下仍只做允许的观察与模式历史，不扩大模型或批准能力。

`setMode('off')` 仅模式转换时执行必要本地结算，并计时；对同一 off 值不每3秒重扫。mode provider 抛错时本轮停止并报告，不能默认开启。常量固定在本模块，不新增 founder 控制开关。

## 5. CommDB 关闭与系统上限

### 5.1 两处确定漏 close

提取函数后使用同步作用域，不把完整 db 交给 scanZombies 的异步 probe：

```ts
function readZombieCandidates(path: string, projectName: string) {
  const db = CommDB.openReadonly(path);
  try { return db.listSessions(projectName, ['running']); }
  finally { db.close(); }
}
function insertLeadInstruction(path: string, leadId: string,
  content: string, dedupeId?: string): void {
  const db = new CommDB(path, false);
  try { db.insertInstruction('bridge', leadId, content,
    dedupeId ? { dedupeId } : undefined); }
  finally { db.close(); }
}
```

返回数组值而非 iterator/statement/惰性 db accessor。plugin 在 close 后才 await scanZombies。通知失败保留既有 false/日志，不伪造成功。CommDBLeadRuntime 同样按 sendEnvelope/sendBootstrap 的同步 insert 打开/关闭；shutdown 保持幂等，不再拥有常驻连接。

对清单中的 factory/lease：明确谁 open、谁 release、释放点是否跨网络；保持调用者拥有的句柄不可由借用函数关闭。需要网络的处理拆成读取与写回两段，close 必须发生在 await 前；写回重新证明 run/head/lease/claim 当前 authority。尤其 gate-poller 与 founder-reply-deliverer 不得用过期 lease 写回。不能用扩大连接池或定时 GC 达标。

### 5.2 wrapper 的启动限额

在 source env 后、exec Bridge 前：读 `ulimit -Sn`；若 unlimited 或已有数值≥8192，不降低；否则 `ulimit -Sn 8192`；再读实际值。失败时明确 ERROR（实际 soft/hard）并使启动失败，交既有 wrapper/launchd 故障路径处理；不能忽略后宣称 F通过。仅提高软限，不运行 ulimit -n 同时降低硬限，不改 launchctl 全局值。

验收以 Bridge 本进程 limit 为准，不用父 shell 或 plist 文本替代。低 hard limit 主机需要运维通过既有启动配置调整；本设计不自动修改生产 plist、主机全局配置或重启服务。

## 6. 可观测性合同

### 6.1 fd monitor

`ProcessResourceMonitor.start/stop/snapshot` 在 startBridge 生命周期单例。启动读取一次 `process.report.getReport().userLimits.open_files.soft`，仅保留该值；捕获错误为 null。每30秒异步采样数字 fd，2秒 timeout，1MiB maxBuffer，不用 shell 字符串拼接。Darwin lsof pid来自 process.pid；Linux readdir `/proc/self/fd`；去重数字 fd，不把 cwd/txt/mem 算进去。stop abort当前采样并等待，避免采样自身泄漏。

```ts
type FdHealth = {
  used: number | null; limit: number | null;
  unlimited: boolean; usage_ratio: number | null;
  sampled_at: string | null;
  status: 'fresh' | 'stale' | 'unavailable';
  reason: 'sample_failed' | 'sample_timeout' | 'limit_unavailable' | null;
};
```

`/health.fd` additive 返回此快照；>60秒旧样本标 stale，失败不得返回 used=0 或旧值标 fresh。limit unavailable 不计算 ratio。unauthenticated health 不暴露数据库路径、文件列表、环境、token、完整 diagnostic report。既有 ok/shuttingDown/build fields不变。

fresh 且 used/limit>0.8 时立即 `console.warn` 并调用 routedAlertSink（eventType=`bridge_fd_pressure`，correlation 包含 project、Bridge启动身份；不用每次采样时间作为新 episode）。warn可每30秒输出数值；统一告警沿现有 durable dedupe/queued/deadLettered 回执，成功持久化才标 notified；拒绝/失败下次重试；ratio<0.7 连续两个样本 quiet resolve。unknown/stale 不自动 resolve，不自动重启、不改变派发开关。接入现有 AlertChannelHub/owner route 测试，必要时给 recovery probe 注册同一 episode 身份。

### 6.2 SQL 与 lag

- 新 `installSqlTiming(db,databaseKind)` 只包装该连接实例，WeakSet保证重复安装不多计。保留原 this、返回、异常、事务 immediate/deferred/exclusive 和迭代语义。prepare返回的 run/get/all逐次计时；iterate计next/return的同步耗时；exec/pragma/transaction锁等待同样计时。
- 以SQL模板摘要 `sqlId` + 方法作为静态标识；不输出 SQL参数、原始 payload、认证证据。阈值严格 `>250ms`，在 finally warn；日志 observer错误不得掩盖原错误；轻量 span可交已有 EventLoopAttribution。
- 两个核心数据库所有打开路径均安装（含 raw、恢复、CommDB readonly/maintenance）；这样 setInterval里的DB与await后的同步DB都能被捕获。`withSyncOpMarker` 再加同阈值的静态 op计时，不用慢 async网络总wall time冒充同步阻塞。
- `timer-sites.txt` 每个在 Bridge 进程加载的 timer 要记录“SQL经哪一入口覆盖”或“无同步DB”；renderer HTML timer、独立 gateway进程、guard worker要明确分类。找到绕过核心入口的直接 BetterSqlite3实例则在其实际打开点接计时；不能未审计就声称所有timer覆盖。
- 现有 `/health.event_loop` 保留 p99_ms/max_ms/episodes，追加 `lag_ms=max_ms`、sampled_at、window_ms=30000、status。未完成窗口或采样失败用null/unavailable；QA不能用空值当0。lag sampler不依赖profiler开关，不重复创建第二个采样器。

## 7. 次要归档：限定候选语句、持久化检查进度

保留当前三表与7天保留线。新增 `workflow_terminal_archive_cursor(source_table PK, cycle_cutoff, source_time_jd, source_identity, cycle, updated_at)`；值均绑定参数，source_table来自现有枚举，不接受外部拼接。首次冻结cycle_cutoff，按现有时间表达式索引和`(julianday(time),pk)`选≤64个**元数据候选**，不先JOIN资格/child/active/json_tree。若SQL产生临时排序或以全历史资格过滤驱动，视作实现失败。

元数据先取payload字节数；每候选payload≤64KiB，每页总payload≤1MiB。超限/invalid JSON保留原热行，计skip；不能删或截断归档证据。再按候选PK读取完整行并执行原有终态、child-table、活动execution/issue和所有JSON scalar引用守卫。active snapshot若超过上限2000项，不尝试截断后归档，整页fail-safe保留并告警。

每个**已检查候选**（成功归档或保守skip）推进cursor；只有被选出来但尚未检查的不推进。冷行insert/sha校验/原热行delete/cursor advance在同一小事务；digest冲突或delete≠1回滚。保持restoreTerminalRow、immutable triggers及cold lookup消费合同；加未消费closeout保护（§3.3）。

一页25ms、一次50ms/最多2页，检查时钟在每候选边界；单语句工作量通过候选/bytes有界，时间预算不是SQLite抢占器。实际性能以回归上限和真实副本验证。到冻结cutoff没有更多候选时**持久化**当前轮完成；下次调度开启新cycle并重查保留的旧活跃行，不能同次调用到尾部立即归零全扫。重启仅续当前cycle；只有完成一轮后允许新轮从起点开始。这与终态holder不复扫不同：归档跳过行的资格可能变化。

## 8. 逐块实施与验证（TDD）

每块遵循：写下列失败用例→执行并确认红→最小实现→运行绿→提交该块。禁止本设计节点执行产品改动。

### T1. 迁移与分页观察

- [ ] 新建 `ship-judgment/__tests__/observation-cursor.test.ts`；新/旧/已有应急索引/重复迁移/错名异定义/回滚测试。
- [ ] 在 `outcomes.test.ts` 增加：终态approved/superseded首次证据、重复幂等、重开StateStore接续、相同recorded_at、倒填旧verdict、未来事件、invalid时间、缺依赖恢复、>16 holder跨页、错误回滚、多run alias仍unknown、head变化不改旧绑定、重复取消学习排除。
- [ ] 测例同时断言旧授权表字节/摘要不变；outcome唯一数不增长；cursor只到已处理或已持久化pending源。
- [ ] 实现§2/§3，按真实 query plan 验证源页索引及无全历史扫描。
- [ ] 执行 `pnpm --filter flywheel-teamlead exec vitest run src/ship-judgment/__tests__/observation-cursor.test.ts src/ship-judgment/__tests__/outcomes.test.ts src/__tests__/StateStore.ship-judgment.test.ts` 并提交。

### T2. 周期预算与网络隔离

- [ ] `runtime.test.ts` 增加setInterval真实入口测试：并发tick单飞；本地throw恢复；挂起modeSweep不阻碍第二轮source页；off发生于yield后；stop abort并等待清理；没有网络依赖时latch也正确清空。
- [ ] 用注入clock精确验证每页至多16pairs/25ms，clarification只推进已处理行；再以真实performance测modeTick，不仅假时钟。
- [ ] 实现§4；复用 `bridge/event-loop-yield.ts`。执行 `pnpm --filter flywheel-teamlead exec vitest run src/ship-judgment/__tests__/runtime.test.ts src/ship-judgment/__tests__/runtime-collect.test.ts src/ship-judgment/__tests__/learning.test.ts` 并提交。

### T3. CommDB ownership

- [ ] 新 `bridge/__tests__/fleet-comm-operations.test.ts`：连续100次通知与多项目zombie tick，打开计数每轮回基线；list/insert抛错也close；在挂起async probe之前计数已回基线。用真实临时db另测OS numeric fd，不允许global.gc补救。
- [ ] 新 `bridge/__tests__/commdb-lifetime.test.ts`：N个项目、每项目多Lead legacy runtime；重复send/shutdown，constructor失败、generation失败、写异常、网络拒绝/永不settle、timeout、重复stop；稳态≤6N数字fd。
- [ ] 实现两处提取和legacy短作用域，检查104处清单及跨await权限再验证。现有factory由owner close，不引入double-close。
- [ ] 执行以上两个文件及现有 `bridge/__tests__/gate-poller-health.test.ts`、`bridge/__tests__/lifecycle-routes.test.ts`；对实际修改的lease/router追加其所在现有测试；提交。

### T4. 启动上限与资源健康

- [ ] 新 `scripts/__tests__/bridge-wrapper-fd-limit.test.sh` 用隔离子shell/stub exec覆盖soft256→8192、已有更高不降低、unlimited、不足hard失败；不启动真实Bridge。
- [ ] 新 `bridge/__tests__/process-resource-monitor.test.ts` 注入lsof输出与时钟：数字去重/无数字、失败/超时、stale、limit未知、single-flight/abort、阈值80%边界、告警拒绝重试、durable去重、70%恢复；hostile输出不执行shell。
- [ ] `bridge/__tests__/event-loop-attribution.test.ts` 增加兼容lag/window/freshness测试。新 `bridge/__tests__/health-resources.test.ts` 确认health只读缓存，无spawn/lsof/report调用，无敏感路径/环境，原shutdown/ok语义保留。
- [ ] 实现§5.2/§6.1并走真实unified routing测试；跑上述测试、两个现有wrapper脚本（preflight/fail-loud）；提交。

### T5. 同步SQL计时覆盖

- [ ] 新 `packages/config/src/__tests__/sql-timing.test.ts` 测>250ms/250ms边界、成功/异常、嵌套、this、statement链式调用、iterator.return、transaction方法/锁等待、安装两次、logger抛错、参数绝不出日志。
- [ ] 扩展 `packages/claude-runner/src/__tests__/sync-op-marker.test.ts`。若现有路径不同，以 `rg --files packages/claude-runner/src | rg sync-op-marker` 找到真实文件并在implementation记录对应路径。
- [ ] 新 `packages/teamlead/src/bridge/__tests__/timer-sql-coverage.test.ts` 驱动实际StateStore raw、CommDB writable/readonly/maintenance与恢复连接；注入慢同步statement，assert SQL id warn；await之后的DB也能计到。
- [ ] 对timer清单完成入口矩阵；执行config/comm/claude-runner目标文件与teamlead覆盖文件、相关typecheck；提交。

### T6. 归档安全分页

- [ ] 扩展 `StateStore.fly2341-terminal-archive.test.ts`：≥100k大payload且合格行稀疏、invalid JSON、nested active scalar、超大payload、children存在、digest冲突、冷存储丢写、重启中页、不再活跃后下一cycle可归档、未来timestamp、closeout未消费/pending保护。
- [ ] assert候选≤64、payload总bytes预算、一次<200ms；真正有archive进展；已选但未检验行在重启后继续；activeSnapshot超限不得误删。
- [ ] 实现§7并跑 `pnpm --filter flywheel-teamlead exec vitest run src/__tests__/StateStore.fly2341-terminal-archive.test.ts src/__tests__/archive-outcome-consumers.test.ts src/__tests__/StateStore.session-events-ts.test.ts`；提交。

### T7. 性能夹具、CI与QA交接

- [ ] 新 `ship-judgment/__tests__/observation-performance.test.ts`：真实better-sqlite3 ≥1,700,000 events、500 holders、≈2,729 closeouts，匹配与不匹配、50个待观察非空源；既要空积压稳态，又要从cursor=0补读与末端新事件；模式auto/dry_run都覆盖。
- [ ] 准备夹具/建索引在计时外单列；计时包括observeCancellations完整页验证/写入/commit，严格<50ms；modeTick真实本地轮次<100ms。跑5次记录全部值与p95/max，不能筛去失败样本。固定CI job单worker且非skip；若CI机器不稳定，先定位、保持验收阈值，不能调宽或mock性能。
- [ ] 使用定向vitest+`pnpm --filter flywheel-teamlead typecheck`、`pnpm --filter flywheel-comm typecheck`、`pnpm --filter flywheel-config typecheck`；变更sync marker时补claude-runner对应typecheck。根pnpm全套可调用无关Terminal.app测试，不作为首选。
- [ ] 在implementation.md逐一记录下面QA矩阵的代码/静态/隔离/生产证据层次；没有生产授权的阶段必须写pending，不宣称通过。

## 9. QA矩阵与生产回滚

| 要求 | 必须交付的证据 |
|---|---|
| 12 / A 索引与取消<50ms | migration receipt、EXPLAIN、SQLite/Node版本；指定备份隔离工作副本的完整observeCancellations计时及非空变体 |
| 9/13 / C 增量且终态不反复扫 | 三次无新事件水位稳定且holderCandidates=0；追加1事件→只处理其身份；重启/晚到/终态/重放结果；holder行数/identity不因本单减少 |
| 14 / B 请求响应 | 同一部署SHA/PID/启动身份，启动后15分钟每秒GET /health，保存每次TTFB及失败；失败计入不达标；p99<300ms，所有完整窗口lag_ms<100ms，null/stale不通过 |
| 15 / D CI | 1.7M/500夹具<50ms、modeTick<100ms、语义回归及types的具体CI run URL，不用本地绿冒充CI |
| 6 / F fd上限 | Bridge自己的health.fd，used有效、limit≥8192；不是runner shell的ulimit |
| 7 / E 连接寿命 | 同一PID连续2h每5分钟记录numeric comm.db/wal/shm fd，保留同负载冷静点；计数非单调上升、起止差≤6且每次稳态≤6×P；记录P定义为Bridge配置中启用项目数，不扩大分母掩盖泄漏 |
| 8 阈值告警 | 隔离环境注入>80%实样/受控采样值，warn +统一告警持久化回执、去重/失败重试/恢复证明；不在生产人为耗尽fd |
| 16 归档 | 100k大payload+指定1.7M备份副本，单次<200ms、20次累计archived>0、重启cursor未回零、active引用/restore保护全部绿 |

**快照纪律**：既有事故备份只读打开，绝不对原文件建索引。QA写操作需要隔离副本。活teamlead/comm副本一律 `node scripts/flywheel-snapshot-control.mjs runner ...`，不能cp；放 `/tmp/flywheel-snapshots/4cde77ab-692a-4609-b8df-21a99e2609d0/` 内按实际QA execution重建归属，遵守2GB总上限。该备份约1.6GB，不能同时复制多份或再造1.7M大payload库越界；先测synthetic并删除关闭，再建一个副本。估算空间不足则使用控制器允许的隔离位置/范围，报告不能完成，不绕限额。所有db句柄close后清理。

临时 database_archive=false 是已有事故状态，本设计/实现不擅自改回；QA在隔离配置开启归档验证；生产恢复flag和重启必须由有授权部署者执行，并记录前后值。auto_merge_narrow_gate模式与holder存量、swap阈值保持原样。

回滚：由正常revert PR + updater处理代码；新增进度/待办/outcome数据保留，不清空来伪造回滚。**禁止直接部署会恢复3秒旧全扫的旧observer**：安全回滚包保留fd软限、close修复及有界observer；若撤销observer算法，只将观察维护放到≥60秒且有界页预算的fallback，不能改变founder审批mode。索引可在分析确认不再需要后DROP新名字；不删应急旧索引、不删holder。新table/trigger向后兼容，回滚版本若写旧时间B2仍会留下pending证据；再次升级续处理。

## 10. 设计交付审计

- [ ] exploration/research/plan三份及本游标、源清单、只读证据已提交推送。
- [ ] 明确注册 review_design gate + request-review；有效reviewVerdict=APPROVED，保存question id/审阅基线/结果。
- [ ] founder-design.html含真实本地Mermaid SVG（若两次失败，保留源码并显示规定pending标记）、逐节自动保存意见、分段复制、单nonce脚本；静态/交互/托管验证分开记录。
- [ ] HTML提交推送后publish-only；向flywheel-eng-lead发DESIGN-HTML ready URL回执。
- [ ] 精确执行 `complete --route phase_design_complete`，按返回状态park；这不是issue终态，不调用ship/dispatch或将整个goal标complete。
