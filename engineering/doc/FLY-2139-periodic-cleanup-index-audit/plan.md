# FLY-2139 Bridge 全方位定期清理与 index 审计 — 实施计划

Issue: FLY-2139 (https://linear.app/geoforge3d/issue/FLY-2139/bridge-稳定全方位定期清理-文件db-陈旧数据的机制化清理与-index-审计保证-bridge-常快founder-已令开工)
日期: 2026-08-28
基于: research.md

**Status**: codex-approved(R1–R4 修订,R5 APPROVED,2026-08-28)
**分支**: `flywheel-FLY-2139`(现 worktree),PR base = `main`
**合入顺序声明**:本 PR 依赖 **FLY-2136 先合入**(mailbox 索引/归档/gate-marker 缓存是 comm 面前提;分支已在 land 流程)。实现期 rebase 到 2136 合入后的 main 再跑全部验收;若 2136 被弃,comm 面验收从本单剥离另立强依赖单 —— 不留永久 skip。

## 0. 摘要

不造新调度器、不给 Bridge 事件循环加任何新负载。五刀:

| # | 刀 | 载体 | 语义变化 | 预期收益 |
|---|---|---|---|---|
| 1 | janitor `--cycle` 修复定时断链 | launchd 04:15 | **有**——文件模块的 apply 授权从「人工先跑 dry-run」变「同进程自铸」(刀 1 如实声明与补偿) | 停止「每次部署后 janitor 永久失败」 |
| 2 | 文件面三个新 janitor 模块(gate_markers 单遍扫描 / state_residue / commdb_backups) | janitor | 零业务语义 | 一次性 ~1.2GB + 周期性防再堆积;**已分类** marker 常驻有上界(backlog 单列+告警) |
| 3 | DB retention 定时化(registry 对账 + `policy-apply`(engine 内强制 activation)+ janitor 周模块;**范围=flywheel 一对库**) | janitor(周) | 零(谓词沿用 FLY-2006 已批口径) | lead_events 等回弹按周压回 |
| 4 | 班车窗 checkpoint + 周 VACUUM(引擎 `maintenance-vacuum`:EXCLUSIVE preflight + SQLITE_BUSY 全路处理) | updater 停机窗 | 零 | comm.db 立回收 ~170MB + WAL 160MB→0 |
| 5 | index 审计固化(per-path tracing window 捕获真实 SQL + 非真空门)+ 查漏补索引 | 测试/schema | 零(只加 partial index,不改查询文本) | 「只读进行中 status」走索引有测试作证;防退化 |

操作基线贯穿:备份 + 归档式优先、只动可证终结项、每类带 before/after 证据、全部 fail-closed。

**评审删除项台账(只删不加)** — R1:`push-guard/worktrees` 清理(活 `core.hooksPath` 目标)、`pending-reports` 清理(durable 投递队列)、多 project comm.db 行级 retention。R2:**Bridge 内终态删 marker 钩子整刀删除**(O(全部 marker) 同步文件扫描挂进 durable 写点 = 给事件循环加新 stall 源,与本单 p99 目标自相矛盾;「用完即删」的消费路径本就存在 —— CodexTmuxAdapter 消费后删、respond 答复后删 ask marker —— 缺的只是崩溃残留兜底,交给 janitor 每夜单遍扫描,接受 ≤1 天延迟)、主 marker 时间推导删除分支(`cleanupTtlHours` 不是结算证明)、VACUUM 硬超时中断承诺(同步 VACUUM 无法同进程中断,改 post-hoc SLA)。

## 1. 常设清扫政策(本单核心设计物,founder HTML 重点呈现)

FLY-2006 的删除授权是一次性的。本单升级为**有界常设政策**,授权链 = 本 issue founder 设计评审通过 → 政策文件(digest 固定)→ **activation receipt(不可自铸,engine 强制校验,刀 3c)**:

| 维度 | 值 | 依据 |
|---|---|---|
| 范围 | **仅 teamlead.db + flywheel comm.db**(引擎硬编码对库保持不变;host-wide 扩展另立单) | R1 #6 最小方案 |
| 可清表族 | 仅 registry `deleteTarget`,谓词/删除序沿用 FLY-2006 registry 原样 | 已批口径,零新谓词 |
| 保留窗 | `RETENTION_MS = 14d`(复用 registry 常量) | 已批口径 |
| 每次运行行数上限 | 全局 500,000;单表 300,000 | 周稳态预估 ~15–25 万行;cap ≈ 2×,异常暴涨变 fail-closed 信号 |
| 超界行为 | 零删除,evidence 落盘,failure receipt + Lead 告警(路径有测试) | fail-closed |
| 频率 | 每 7 天一次(仅 `status=complete` 的 sealed receipt 后写 success marker) | 回弹速率下周跑足够 |
| 激活 | `policy-apply` 的 `--activation-receipt` 为**必需参数,engine 在打开可写 DB 前校验**;缺失/损坏/digest 失配 → 非零退出零删除 | R2 #4 |

`sessions` 终态行与 `dead_letter_alerts` accepted 本轮不纳入(体量不值,保护面不收窄);inventory 持续报告行数,涨过 10 万行再立单。

## 2. 改动清单(file-by-file)

### 刀 1 — janitor `--cycle`

**`scripts/flywheel-log-janitor.sh`**:`parse_args` 增 `--cycle`;顺序执行 dry-run 全模块(铸回执)→ apply 全模块(消费刚铸回执);锁贯穿。**授权模型变化如实声明**:旧模型的「人工 dry-run 门」实测结果是部署后永久失败而非人工介入;新模型把无人值守作为一等需求,真实安全边界改由「模块 allowlist + 逐项终结性判定 + per-run cap + 审计 + activation receipt(DB 面)」承担。dry 与 apply 使用**不同 run id**(`$RUN_ID-dry`/`$RUN_ID-apply`),apply 报告只按 apply run id 汇总。`--dry-run`/`--apply`/`--force` 单独调用行为字节不变。
**`scripts/com.flywheel.log-janitor.plist` + `scripts/install-log-janitor.sh`**:ProgramArguments → `--cycle`。

### 刀 2 — 文件面新模块(全部走既有 `audit_event`/cap/lsof 骨架)

**`run_gate_markers()`**(R2 #1/#2 重做 —— 单遍扫描,纯终结性证明,无时间推导删除):
- 每夜一次:先从 teamlead.db(read-only sqlite3,复用 `codex_logs_db` 手法)**一次性加载** status ∈ `WAKE_TERMINAL_STATUSES`(复用 operational-terminal-status.ts:30 现有常量:completed/terminated/failed/blocked/timeout/canceled/cancelled —— 注释明确 approved/rejected/deferred/shelved 仍可能有 live runner mailbox,不在此列)的 execution 集合;再对 `codex-gates/*.json` + `codex-gates/ask/*.json`(文件名模式 `[A-Za-z0-9_-]+\.json`,不递归其他子目录)**单遍扫描**。
- 删除判定(主 marker 与 ask marker 同两路,二取一):① marker JSON 的 `answeredAt` 为合法 ISO 时间且 `now - answeredAt > 2d`(age anchor 用 answeredAt 本身,非 mtime);② marker 的 `executionId` ∈ 上述 wake-terminal 集合且 mtime > 2d。
- **无任何纯时间分支**:deadline 已过但 timeout settlement 未完成(adapter 对 CommDB 的原子写可能在 retry)的 marker,其 execution 仍非终态 ⇒ 不动。legacy marker 缺可选字段不影响回收(判定不依赖 marker 字段,依赖 DB 终结性)。executionId 在 sessions 表中不存在、或 JSON 不可解析 → skip + 审计,并计入 **backlog 计数**(R3 #6:此类 marker 常驻无上界保证 —— 报告里单列 unclassified/corrupt/missing-session backlog,超阈值(默认 500)告警,不静默)。teamlead.db 不可读 → 整模块 skip。
- shell 里的状态列表与 TS 常量以一条 vitest 钉同步(grep 断言脚本内列表 == `WAKE_TERMINAL_STATUSES` 成员)。
- 处置:mv 入 `codex-gates-archive/<YYYYMMDD>/`;cap 默认 20,000/次。
- 负例测试:deadline 已过但 execution 仍 running 的 marker 必不动;`approved` 状态 execution 的 marker(主/ask)必不动;legacy 缺字段 marker + wake-terminal 可回收;合法非 UUID 文件名正常;非终态旧 marker 必不动。

**`run_state_residue()`**:显式枚举政策表,只碰列名目录:
| 目录 | 窗 | 处置 |
|---|---|---|
| `state/fly2054-playwright` | 14d | 直接删(Playwright 浏览器缓存,可重新下载 —— 唯一 delete 类,founder HTML 如实标注) |
| `state/codex-gates/FLY-2024-xhs-mcp` | 一次性 | mv → `~/.flywheel/archive/state-residue/`(误放 repo clone) |
| `state/codex-gates-archive/<YYYYMMDD>` | 30d | 删(已是归档,30d 反悔窗到期) |
- 政策表未列目录一律不碰(测试作证,显式含 push-guard、pending-reports 反例);lsof 探测 + per-entry try。

**`run_commdb_backups()`**(R2 #3 重做 —— 按 producer/tag 分型,不设通用 family):
- **本单只自动处理 `comm.db.pre-fly1572-*` 族**(producer = `backupCommDb()`,契约可验证):required 成员 = standalone backup DB + `<base>.refs-manifest.json`;`<base>.refs/` 目录按 manifest 内容**条件存在**(manifest 为空则合法缺席);同名 `-wal`/`-shm` 是杂散文件,**不属于**该族(backup API 产物无 wal/shm),发现即按下一条 fail-closed 规则处理(不自动处置)。
- 政策:每 project 保留**最新一套 manifest 校验通过的 raw 族**原样;其余 pre-fly1572 族:mtime > 14d → 全族 tar.gz(no-clobber,tar 后校验完整性)→ 整族成功后删源;`.tar.gz` > 30d 删。
- **backup-named 杂散 `-wal`/`-shm` 不自动处置**(R3 #5:超出 producer contract,移走可能改变该 SQLite image 的可恢复状态):只 audit + alert,与未知 tags 同进 follow-up 台账;**族旁存在 stray 时该族压缩 fail-closed skip**。
- `migrated-*`/`bak-*`/`pre-remigration-*` 等**无可验证契约的历史文件:本单保留不动**,列入 follow-up 台账(收益口径相应收窄,见 §4)。
- manifest 缺失/损坏、swap-intent 或 recovery 引用中 → 该族 skip + 审计;活体 `comm.db`/`-wal`/`-shm` 精确文件名排除 + lsof 双保险。
- 负例测试:manifest 空但 refs/ 缺席的合法族正常处理;manifest 损坏族必不动;recovery 引用族必不动;`migrated-*` 必不动;压缩中断残留不删源;**stray 在旁的族必不动**。

### 刀 3 — DB retention 定时化

**(a) registry 对账** — `scripts/lib/fly-2006-retention-registry.mjs`:live 两库 `assertClassifiedSchema` 报出的全部未分类新表补分类(已知 comm:`mailbox_archive` → protectedCurrentOrAuthority、`runner_stop_declarations` → 按消费者审计定);逐表依据写 `registry-reconciliation.md`;consumer gate 重跑绿。

**(b) 常设政策文件(授权链的机械身份,R3 #3 恢复)** — **`scripts/lib/fly-2139-standing-policy.mjs`**(新,纯数据 + 校验函数,无 I/O):固定 issue、两级 caps(全局 500,000/单表 300,000)、`RETENTION_MS` 引用(import registry 常量,不复制数值)、允许表族来源(registry `deleteTarget`)、schema version。engine 校验的是**canonical 仓内路径 + digest + 严格 schema 三者同时**,不接受任意同 digest 参数。测试:policy path 替换、字段增删、caps 漂移 → 全部在打开可写 DB 前拒绝。

**(c) 引擎扩展** — 改动面:`scripts/fly-1998-database-retention-sweep.mjs`(CLI parser 增 `policy-apply`,required = `--manifest --activation-receipt`;policy 路径由 engine 按 canonical 位置解析,不作为可注入参数)+ **`scripts/lib/fly-2006-retention-engine.mjs`**(`policy-apply` 复用与 `apply` 完全相同的 snapshot/CAS/delete/receipt 代码路径;身份校验从 founder audit 换为 policyAudit;evidence root 参数化为 `maintenance/fly-2139`,不动 fly-2006 root)+ receipt schema(`policyAudit`:政策文件 sha256、registry sha256、engine sha256、issue、caps、实际行数、**activation receipt sha256**)。cap 校验:任一 target 超单表或全局 cap → 零删除、非零退出、`policy_cap_exceeded` receipt。引擎硬编码对库保持不变。

**(d) activation receipt(不可自铸,engine 内强制,R2 #4)** — `~/.flywheel/state/log-janitor/db-retention-activation.json`:Lead 在首夜 inventory 审阅后以文档化命令**原子 no-clobber** 写入(issue、政策/registry/engine 三 digest、caps、批准人、时间)。**校验在 engine 内、打开可写 DB 之前**:canonical regular non-symlink、严格 schema、issue/caps/三 digest 匹配;任何直接调用 CLI 的路径同样被拦(janitor 只传递路径,不是唯一 authority)。政策/registry/engine 任一文件变更 → digest 失配 → receipt 自动失效。损坏/缺失 → 非零退出零删除。
测试**直接调 CLI**:缺失、篡改、digest 失配、cap 失配 → 全部非零 + 零删除;complete receipt 的 policyAudit 绑定 activation sha256。

**(e) janitor 周模块 `run_db_retention()`**(R3 #1:首夜与 engine 权威的兼容分界):7d marker 未到期 → skip;dry 相 = `inventory`(候选行数进审计与报告);apply 相 = `inventory` 后 janitor 做**一项非权威存在性分支**:activation 文件**不存在** → 审计记 `activation_missing_inventory_only`、**不调用** `policy-apply`、模块正常返回(cycle exit 0)、不写 7d success marker;文件**存在** → 原样传给 engine(损坏/失配仍由 engine 非零并告警 —— janitor 不解析内容,不是 authority)。success marker 只在 `status=complete` sealed receipt 后写;失败/超界:durable failure receipt + 告警,不重试。
测试:full `--cycle` 首夜缺 activation = exit 0 + 报告含 inventory-only + 零删除 + 无 success marker;direct CLI 缺 activation 仍非零。

### 刀 4 — 班车窗 DB 维护(R2 #5 重做:preflight + BUSY 全路语义,无硬中断承诺)

**引擎新命令 `maintenance-vacuum`**(复用 `executeFly2006Vacuum` 的原语:started/recovery receipt、磁盘余量、`integrity_check`,解除 sweep manifest/rehearsal 耦合):
- **`BEGIN EXCLUSIVE` 探针明确定位为 preflight**(锁即释,不是持续 fence);此后每一步(checkpoint、VACUUM、integrity_check)独立处理 `SQLITE_BUSY` → safe skip + failure receipt(writer 在 probe 后重开是合法场景,有并发测试);
- `wal_checkpoint(TRUNCATE)` 返回三元组 `{busy, log, checkpointed}` **必须检查**(StateStore.ts:2042 先例:busy=1 非抛错返回)——busy≠0 时不得计成功,success receipt 记录三元组;
- **无硬超时中断承诺**(同步 VACUUM 无法同进程中断;外部 watchdog = 新机制,不加):**操作结论与 SLA 结论分离**(R3 #2)—— VACUUM、非 busy checkpoint、integrity 全部成功即 sealed receipt `status=complete`,duration 超预算另记 `slaStatus=degraded`/`durationExceeded=true` 并告警,**不影响 7d marker 推进**(否则慢而完整的 VACUUM 会每班车重复重活);生命周期测试:慢但完整的 VACUUM 下一班必 skip、7 天后才再跑;
- **路径 allowlist**:只接受 canonical `~/.flywheel/teamlead.db` 或 `~/.flywheel/comm/<safe-project>/comm.db` 的 regular non-symlink,拒绝任意 path。**fixture 注入不走 CLI/env**(R3 #4):沿用 FLY-2006 既有模式 —— 测试直接调用引擎函数传 `allowFixturePaths: true`(CLI 不暴露该参数),或 spawned-CLI 测试用隔离 HOME 造 canonical 形状;断言:任何 env 组合都不能让 production CLI 接受 `/tmp/other.db`;
- 每库 7d VACUUM marker 只在 `status=complete`(checkpoint 非 busy)sealed receipt 后写(slaStatus 不参与)。

**`scripts/db-maintenance.sh`**(薄壳,新):对 teamlead.db + 全部 project comm.db(文件级维护无 registry 依赖):
1. `.backup` 到 `~/.flywheel/archive/db-backups/<project>-<db>-<runid>.db`(project+run-id 限定、no-clobber);备份件跑 `integrity_check`,失败 → 全库 skip;滚动保留 2 份(路径与刀 2 glob 显式互斥);
2. checkpoint(每班车)→ 3. `maintenance-vacuum`(周)→ 4. 任何失败:先落 durable failure receipt + 触发告警(内容有测试),再返回非零;`restart-services.sh` 调用处 `|| true`(不阻塞重启,失败已持久上报)。
**`scripts/restart-services.sh`**:停止服务后、拉起前插入调用。诚实声明:停机窗内 Lead/CLI 仍可能重开 DB —— 所以每步靠 BUSY 语义让路,拿不到即 skip 本班。
测试:并发重开 → skip + receipt;备份失败不 checkpoint/VACUUM;checkpoint busy=1 不计成功;integrity 失败非零 + receipt;失败不写 7d marker;同名 comm.db 多 project 不碰撞;path allowlist 拒绝任意路径。

### 刀 5 — index 审计固化(R2 #6 修正:per-path tracing window + 非真空门)

**`packages/teamlead/src/__tests__/fly2139-query-plans.test.ts`**(新):对六路径(GatePoller tick / LeadInboxRuntime.admit / RunnerMailboxLane.tick / patrol tick / workflow engine transition / outbox·dead_letter drain 族)**各设 tracing window**:窗口内 instrument 所有新建 better-sqlite3/CommDB 连接(这些路径会自建连接,如 runner-mailbox-lane.ts:54、lead-inbox-runtime.ts:215、gate-poller.ts:1299 —— 只包测试自持的一个 db.prepare 不完整);每路先断言**至少捕获一条 SELECT** 且**预期 table/query-family 集合出现**(不钉 SQL 文本),再对每条捕获 SQL 跑 EQP:具名索引、无 bare `SCAN <大表>`、无 `TEMP B-TREE`。
**负控制(绿色 meta-test,R3 #6)**:不留常驻 RED —— 一个正常为绿的 meta-test 在测试内部对 fixture 库临时移除一个已知索引,断言 audit checker **报告失败**,恢复 schema 后再断言正常路径绿(证明尺子能区分,且 CI 全绿)。
**审计产出**:`index-audit.md` **由同一 capture 集生成**(测试与审计表同源);缺口 → 补 partial index(migration + 存量库 ensure 双路径,照 2136 纪律),不改查询文本。
comm 面:rebase 到 2136 合入后执行(§0),无永久 skip。

### 里程碑(PR 最后一 commit)

`engineering/doc/milestones/FLY-2139.md` 新建;不碰 CLAUDE.md。

## 3. TDD 顺序(RED → GREEN)

1. `scripts/__tests__/flywheel-log-janitor.test.sh` 扩:`--cycle` dry→apply 成功、双 run id、apply 报告只含 apply 相;`--apply` 无回执仍拒;dry-run die → 不进入 apply。
2. 同文件:gate_markers 五负例 + 两正路 + backlog 计数/阈值告警 + teamlead.db 不可读整段 skip + 状态列表同步 vitest;state_residue 表外必不动(含 push-guard/pending-reports 反例);commdb_backups 分型六负例(含 stray 在旁族必不动)。
3. standing-policy 测试:policy path 替换/字段增删/caps 漂移 → 开 RW DB 前拒绝;sweep 测试扩:registry 对账全分类;`policy-apply` 直接 CLI 六场景(同结果/超界零删/activation 缺失/篡改/digest 失配/receipt 绑定 sha);full `--cycle` 首夜缺 activation = exit 0 + inventory-only + 零删除 + 无 success marker。
4. `maintenance-vacuum` + `db-maintenance.test.sh`:刀 4 八场景(含慢但完整 VACUUM 下一班 skip 生命周期、env 不能绕 path allowlist)。
5. `fly2139-query-plans.test.ts`:六 tracing window + 非真空断言 + 绿色 meta-test 负控制,发现缺口即 RED,补索引至 GREEN。
6. GREEN 后:既有 janitor/sweep/gate-marker 行为测试零修改通过 = 语义不变证明。

## 4. 全仓门 + QA

1. `pnpm lint` + `pnpm -r build` + `pnpm test:packages:run`(核对 teamlead 包确实执行)+ shell harness 全绿。
2. 生产影子演练(不动生产数据):scratch fixture 复刻 codex-gates/备份族/残留形状跑 `--cycle`;db-maintenance 对 scratch 库(种子 free page + WAL)跑,断言字节回收与 receipt。
3. before/after 证据表附 PR:codex-gates 文件数、state 目录字节、两库文件/WAL 字节、/health p99。首次生产收益预估(R2 收窄后口径):文件面一次性 ~1.2GB(playwright 520MB + clone 162MB + pre-fly1572 族压缩净 ~560MB 名义);comm.db VACUUM ~170MB + WAL 160MB;`migrated-*`/`pre-remigration-*` ~820MB 本单保留(follow-up 台账)。
4. Codex code review(`codex:rescue`)循环至 approved。

## 5. 部署与首启

- merge 后不投重启票(FLY-1959);plist 变更由 `install-log-janitor.sh` 在运维窗生效;
- 首启序列:00:00 班车(checkpoint + 首次 VACUUM)→ 04:15 janitor `--cycle`(文件面首扫;db_retention:activation 文件不存在 ⇒ janitor 存在性分支记 `activation_missing_inventory_only`,不调 `policy-apply`,cycle 正常 exit 0)→ Lead 审阅首夜 inventory 后写 activation receipt ⇒ 次周起全自动;
- 回滚:`FLYWHEEL_JANITOR_DISABLE_MODULES` 摘单模块;plist 改回 `--apply` 回旧行为;删 activation receipt 即 DB 面回 inventory-only;新引擎命令未被调用时行为与 FLY-2006 后完全一致。

## 6. 与在飞分支的接缝

- **FLY-2136**:§0 先合依赖;本单不动 mailbox-queue/lead-inbox-runtime 归档代码与 gate-marker.ts(R2 后本单已无 gate-marker.ts 改动 —— 清扫全在 janitor 侧);
- **FLY-2058**:读路径归它,零重叠;其改动若波及六路径查询形状,rebase 后 tracing 自动覆盖新形状(刀 5 抗漂移属性)。

## 7. 边界与不做(诚实清单)

- 不改任何业务语义、查询文本、mailbox 归档机制本体(2136)、读路径(2058);
- **不加 Bridge 内终态删 marker 钩子**(R2 #2:O(N) 同步扫描进 durable 写点与 p99 目标矛盾);消费路径的就地删已存在(adapter/respond),崩溃残留由 janitor 每夜兜底,**接受 ≤1 天清理延迟**;
- `push-guard/worktrees`(265MB)不清(活 `core.hooksPath` 目标,归 worktree 生命周期 owner,建议另立单);`pending-reports` 不清(durable 投递队列);
- `mailbox_archive`/`mailbox_log` archived 行不删不导出;`sessions` 终态行 / `dead_letter_alerts` accepted 本轮不清;
- 多 project comm.db 行级 retention 不做(host-wide manifest 另立单);文件级维护(checkpoint/VACUUM/备份)覆盖全部 project;
- `migrated-*`/`pre-remigration-*` 等无契约历史备份(~820MB)本单不动,follow-up 台账;
- VACUUM 无硬超时中断(post-hoc SLA);「谁在铸 marker 残留」源头不追;launchd 之外调度形态不考虑。

## 8. 验收清单

- [ ] launchd 连续两夜 `--cycle` 成功;**部署新版本后下一夜仍成功**;apply 报告不含 dry 相
- [ ] gate marker 五负例绿(deadline 过但 running 幸免/approved 幸免/legacy+wake-terminal 可回收/非 UUID 名/非终态旧 marker 幸免);状态列表同步 vitest 绿;**已分类** codex-gates 常驻 ≤ 活跃 gate + 2d 窗;backlog(corrupt/missing-session)单列入报告且超阈值告警
- [ ] 政策表外目录零触碰(含 push-guard/pending-reports 显式反例);state 残留一次性回收 ≥ 680MB
- [ ] pre-fly1572 备份族分型六负例绿(含 stray 在旁必不动);每 project 保最新完好 raw 族;`migrated-*` 必不动;stray 只 audit+alert
- [ ] registry 对账后 live 两库零 unclassified;consumer gate 绿;standing-policy 三拒绝测试绿
- [ ] `policy-apply` 直接 CLI 六场景绿(activation 由 engine 强制,janitor 非唯一门);cap 超界零删除 + failure receipt + 告警(内容有测试);首夜 `--cycle` 缺 activation = exit 0 + inventory-only
- [ ] 班车窗 checkpoint 每班执行且 busy 三元组入 receipt;VACUUM 周执行(complete+slaStatus 分离,慢而完整不重跑);并发重开 skip 测试绿;comm.db 首次回收 ≥ 100MB;integrity 全绿;path allowlist 拒任意路径(env 不能绕)
- [ ] 六路径 tracing window 全固化:每路非真空 + family 断言 + 绿色 meta-test 负控制;audit 表与 capture 同源;缺口索引已补且不改查询文本
- [ ] before/after 证据表附 PR;全仓门 + codex review approved;PR 末 commit 带 milestone 文件
