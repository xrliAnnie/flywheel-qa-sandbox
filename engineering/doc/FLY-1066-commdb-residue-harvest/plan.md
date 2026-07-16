# FLY-1066 Bridge 侧残留治理(双层)— 实施计划

Issue: FLY-1066 (https://linear.app/geoforge3d/issue/FLY-1066/infra-bridge-侧残留收割-commdb-孤儿注册清理-statestorecommdb-终态同步-scope-free-清理入口)
日期: 2026-07-16
基于: exploration.md(重写版,双层)、research.md(§1-§8 = ②层事实;§9 = ①层审计)

## 0. 目标一句话

双层治理 Bridge 残留:**① 根因层** = failed/blocked 的**五个生产写入面**经非阻塞同步队列实时把
CommDB registration 终态如实化(泄漏源在产生当刻闭合,治本);**② 兜底层** = 已实现的四面收割器
(boot/心跳/定点,收 crash 死法的残留,fsck 定位)+ 两处增量。只做②被 Annie 否决;
分工 = 能拦的走①、拦不住的走②。

## 1. 对 FLY-817 review BLOCKER-1 决定的修订(给 Codex reviewer 显式看;②层沿用 + B1 扩展引用)

**原决定**(FLY-817,`commdb-fsm-reconcile.ts` 现行注释):CommDB running 行若 StateStore ∈
CRASH_PRESERVE(failed/blocked),只看 FSM、绝不 probe、绝不删——retry 的
`closeRunner(forcePreserved)` 要读 CommDB tmux 目标,删行会 strand preserved 窗口。

**修订**(第一轮已获 Tadashi gate 放行 + Codex design R1 复核,已实现、已 QA):probe==="dead" 时允许
finalize——窗口与 scrollback 已灭失,preserve 标的不存在;删行后 `getTmuxTargetFromCommDb` 返回空 →
closeRunner 幂等。**probe=alive/indeterminate 的 failed/blocked 行原决定原样保留**(FLY-116 零变化)。

**mark 与 delete 的时机分工**(重开后新增,消解 Tadashi 两次答复的表面矛盾;呈他终裁):

| 时机 | 动作 | 依据 |
|---|---|---|
| ①转移当刻(窗口可能活) | mark:`markSessionTerminalStatus(execId, failed/blocked)`(A1 新原语) | 非破坏;A3 答复(只 mark 不 delete)的适用域 |
| ②收割时(probe=dead 铁证) | delete:`finalizeSession` | BLOCKER-1 修订,双签已实现 |

## 2. 硬约束(验收原文)

> 收割信号 = terminal/CommDB 存在性,绝不是 FSM 终不终态;awaiting_review + terminal 活 = 合法等 founder,结构性不可触。

②层推论原样(删除/终态化只认 probe==="dead";alive/indeterminate keep;design_done/parked 不可触;
面③ FSM 拒绝即 keep 不 forceStatus;时间戳 fail-closed;搭车不阻塞 tick)。①层新增推论(Codex R1 收紧):
- 生产写入面上的同步点**只做 enqueue**(微秒级、try/catch、永不破坏 transition/sink 调用栈——FLY-907
  契约原文);CommDB 打开/UPDATE/close 全部发生在调用栈之外的 drain 协程里(R1 #2);
- mark **绝不 DELETE**(转移当刻无死亡证明);drain 前重读 StateStore,权威状态仍 ∈ {failed,blocked}
  才写(防队列延迟期 retry/shelve/terminate 后写回旧状态,R1 #2);
- **写入优先级**(R1 #3):FSM/DirectEventSink 的 failed/blocked mark = StateStore 权威写;adapter 生命周期
  尾写(completed/timeout)只允许 CAS `WHERE status='running'`;`ended_at` = first-terminal-write 语义
  (`COALESCE(ended_at, datetime('now'))`,重复 mark 不漂移);
- mark 不改 tmux_window / vendor / issue_id ——retry teardown target 原样;
- CHECK 迁移只放宽约束,旧值全兼容,迁移幂等(schema sql 含 'failed' 即跳过,FLY-1279 同款);
  多进程 contention 有测试证明,不靠断言(R1 #6)。

## 3. Part A — ①根因层(本轮新增工作;TDD,每 M 单独 commit 全绿)

### A1 — flywheel-comm:CommDB CHECK 加 'failed' + 写入优先级 + 读侧候选集(R1 #3/#4/#6 扩容)

- **schema**:db.ts 按 FLY-1279 模式(db.ts:370-405 逐字仿写)整表原子重建 sessions,CHECK 扩为
  `('running','completed','timeout','blocked','failed')`;迁移判据 = schema sql 不含 `'failed'` 才跑;
  顶层 SCHEMA(新库)与 migration(旧库)两条路径都测。`types.ts:67` Session.status union 同步。
- **写入优先级语义**(R1 #3,新原语而非改现有语义时逐点核对调用方):
  - 新 `markSessionTerminalStatus(execId, 'failed'|'blocked')`:StateStore 权威 mark,
    `ended_at = COALESCE(ended_at, datetime('now'))`(first-terminal-write,重复 mark 不漂移);
  - adapter 尾写路径(`updateSessionStatus` 的既有调用方 TmuxAdapter.ts:703 / CodexTmuxAdapter.ts:821/898)
    改为 CAS 变体:`UPDATE … WHERE execution_id=? AND status='running'`——尾写只能收敛 running 行,
    不得覆盖已 mark 的终态;
  - `registerSession` 的 INSERT OR REPLACE 晚注册时序审计:构造「mark 后 runner 自注册」交错,可达则改
    「保留已存在终态」的 upsert,不可达则顺序哨兵 pin;
  - **四个交错测试**(R1 #3 原文):adapter-before-mark / mark-before-adapter / duplicate-mark /
    late-register。
- **读侧候选集**(R1 #4——没有这条 mark 对 Lead 视图不可见):`getRecentTerminalSessions`(db.ts:2052)与
  `countTerminalSessions`(db.ts:2073)的硬编码 `('completed','timeout')` 扩为含 `'failed','blocked'`;
  terminal-mcp(index.ts:182-198)文案/cap/count 测试同步;覆盖 failed/blocked × alive/dead × active_only
  矩阵。**不动** `cleanupStaleSessions` 的 `{completed,timeout}` 集(它会 kill 窗口,与 preserve 政策冲突)。
- **迁移 contention 测试**(R1 #6):两进程——旧 schema 上 A 持写锁/插行,B 触发迁移,释放后两侧数据/
  vendor/索引/新 CHECK 全保全;超 busy_timeout(5s)的迁移失败不留 staging 表/半迁移、下次 open 可重试。
- **部署顺序**:Bridge boot 先对全部 configured CommDB 显式 warm-migrate(逐 project,失败明确告警且
  该 project 不启用 sync 队列),之后才启用 A2;避免部分 schema 被误报为已启用。失败 project 暴露
  持续 degraded 计数,并做有界退避重试 warm-migrate、成功后启用该 project 队列——一次瞬时 5s 启动锁
  不得让①层整个 Bridge 生命周期关闭(Codex R2 #3)。
- **测试**(flywheel-comm db.test 扩展):旧库重建后数据逐行保全 + 新值可写;已迁移库幂等跳过;
  'failed' 写入 + first-terminal ended_at 断言;读方矩阵(listSessions/getSession/getRecentTerminal)。

### A2 — teamlead:非阻塞终态同步队列 + 全生产写入面接线(L-A,①层核心;R1 #1/#2 重构)

- 新模块 `bridge/terminal-commdb-sync.ts`,**enqueue 与 drain 分离**:
  ```
  enqueueTerminalCommDbSync(executionId, targetStatus, projectName):   // 生产写入面同步调用的唯一入口
    targetStatus ∉ {failed, blocked} → no-op
    有界队列(coalesce by execId)入队 + 触发 drain(per-project single-flight)
    —— 只做内存入队,微秒级,try/catch,永不 throw(FLY-907 契约)

  drainLoop(project):                                                   // transition/sink 调用栈之外
    取队目 → 重读 StateStore:权威状态仍 ∈ {failed, blocked} 且与队目一致 → 才写
    CommDB open(resolveCommDbPath 失败 → warn+跳过)→ markSessionTerminalStatus(A1 原语)
    → finally db.close();任何失败 warn 计数,由②层收敛(不重试风暴)
  ```
- **接线 inventory(确定清单,R1 #1——不是「两个 onTransition」而是五个生产写入面)**:
  1. plugin.ts 共享 ApplyTransitionOpts.onTransition(FLY-907 实例);
  2. stale-blocker-guard 自有 ApplyTransitionOpts.onTransition;
  3. `DirectEventSink` in-process completion `route==="blocked"` 直写点(DirectEventSink.ts:647,758-785
     ——**故意绕过 applyTransition 的生产路径**,DirectEventSink.ts:102-108 / run-infra.ts:554-556 自述);
  4. `DirectEventSink.emitFailed`(DirectEventSink.ts:1036-1088,直写 failed/blocked);
  5. `complete-marker-reconciler.ts:731-758` 的 forceStatus fallback。
  其余 forceStatus 调用点:逐点写死「生产不可达 failed/blocked」的证明(引调用方 transitionOpts 传入
  事实)+ 守卫测试 pin;证明不成立的点并入 inventory。
- **队列边界契约**(Codex R2 #2):key = `(projectName, executionId)`,coalesce = latest-wins(同 exec
  failed→blocked 交替只保最新目标);容量有界,满队列**绝不抛回调用面**——丢弃+计数+warn,由②层兜底;
  Bridge 关闭时 bounded drain(超时即放弃,②层兜)。哨兵测试:status-flap(latest-wins)+ overflow
  (计数且调用面无感)各一条。
- flag `FLYWHEEL_TERMINAL_COMMDB_SYNC`(default on,注册进 feature-flags registry,注册与首个读点同
  commit);=0 时五个写入面零 enqueue。**精确语义**(Codex R2 #3):它只关同步行为——A1 的 CHECK/
  读侧/CAS 是 schema/原语层、不随 flag 回退,不得把该 flag 描述成整票 byte-compat rollback。
- **测试**:五个写入面各一条 fixture(reapOrphans force-fail / stale-guard / DES blocked completion /
  DES emitFailed / marker forceStatus fallback)→ drain 后 CommDB row 'failed'/'blocked' + first-terminal
  ended_at;**契约测试**:CommDB writer 持锁(busy)时 applyTransition/DES 调用立即返回(R1 #2 原文);
  drain 前权威状态已变(retry→running / terminated)→ 不写(交错测试);open/UPDATE/close 各段异常 →
  transition 照常成功(fail-open 哨兵)+ warn 计数;非 CRASH_PRESERVE 转移零 enqueue(负向+突变对照);
  flag=0 五面反向哨兵;**retry 哨兵**:marked row 上 closeRunner(forcePreserved) teardown target 查找
  照常(tmux-lookup 按 execId,status 无关)。

### A3 — spawn 失败 cleanup 覆盖审计(非代码 gate;R1 #7 改判)

- 现行 dispatcher 已在 pre-launch abort / promise rejection / 无 sessionId 失败结果上调用
  `cleanupPreRegistration`(run-dispatcher.ts:618-630/824-843/888-925/1203-1214/1388-1421)——
  A3 改为**审计并引用/补 pin 既有覆盖**的非代码 gate:逐分支列 cleanup 调用事实;只有找到一个具名、
  可复现、且拿到「从未启动」证明的未覆盖分支才新增 unregister 调用(GEO-441 历史形态与现行覆盖的
  差异写进审计结论)。实现预算让位给 A1/A2 的真实必需工作。

### A4 — owner 矩阵 pin(L-C,审计交付)

- research §9.3 矩阵中标 ✅ 的关键格子加最小哨兵测试(已有测试则引用不重写):closeRunner 调
  finalizeCommDbSession、crash-reaper 调 finalize、lifecycle-closeout 调 finalize——各 1 条已存在则记
  文档指针,缺则补 1 条 spy 级断言。发现真 gap:属本票三残留物的修在本票,机制级缺陷另开 issue 并在
  PR 描述列出。FLY-603 autoclean 调查、FLY-1148 进程泄漏 = 独立 open item,不并入。

## 4. Part B — ②兜底层(已实现,引用 + 两处增量)

**as-built**(本分支 commit `01201baf1`…`5cec7eeb2`,原 PR #616,独立 QA PASS = qa-report.md):
M1 面①②收割分支(commdb-fsm-reconcile.ts harvest opts:孤儿 = 无 FSM row + 24h + probe dead → finalize;
面② = CRASH_PRESERVE + probe dead → finalize)/ M2 面③ statestore-ghost-reconcile.ts(30min + CommDB
absent + session 级 probe dead + 双重新读 → finalize 先行 → terminated + 显式侧效)/ M3 面④
orphan-escalation-reconcile.ts(全局 presence index + TOCTOU 双验 + 复活 predicate 扩
'residue_harvest')/ M4 三入口(boot 循环 + HeartbeatService onMaintenanceTick 搭车 ~1h + runs-route
409 定点,`FLYWHEEL_COMMDB_RESIDUE_HARVEST` 总闸)/ M5 flag 矩阵哨兵。**本轮不重做、不重构**;
计划细节以 git 历史 `6a79e4918` 的 plan.md 为准。

### B1 — 终态 prune:扫描集扩展 + 纳入 residue full pass(R1 #5 扩容)

- `pruneDeadTerminalCommDbSessions` 扫描集扩为 `{completed,timeout,failed,blocked}`——**新增两值挂
  `FLYWHEEL_COMMDB_RESIDUE_HARVEST`**,原 `{completed,timeout}` 行为无条件保留(=0 时逐字节回到
  FLY-638 现状;D2 按 Codex 建议定案,呈 Tadashi 确认)。delete 正当性 = §1 修订,判据不变
  probe==="dead"。
- **收敛 SLA 修复**(R1 #5):现状 prune 只在 boot wrapper 跑(residue-harvest.ts:98-107 /
  plugin.ts:5742-5763),而 A2 mark 会把行移出 running 扫描 → 不入 full pass 就要等下次重启才收。
  把扩展后的 terminal prune 纳入 `ResidueHarvester.runFullPass` 的 per-project 阶段(residue-harvest.ts:
  37-66,heartbeat maintenance ~1h 一轮),boot 同轮去重不重复 probe。收敛 SLA = mark 后窗口证死起
  ≤1 个 maintenance 周期(~1h)。
- **测试**:marked 'failed' + probe dead → prune(boot 与 maintenance 两入口各一);'failed' + alive →
  keep(preserve 哨兵);harvest flag=0 → 扫描集回 `{completed,timeout}`(反向哨兵);boot 轮 probe
  去重断言。

### B2 — ①×② 交互回归

- ①标记后 row 离开 running 扫描集 → ②面②候选收敛(测试:同一 row 先被 A2 mark,再跑
  reconcile running 扫描 = 零候选;再跑 B1 prune probe-dead = 收走)。
- flag 矩阵扩维:`FLYWHEEL_TERMINAL_COMMDB_SYNC` × `FLYWHEEL_COMMDB_FSM_RECONCILE` ×
  `FLYWHEEL_COMMDB_RESIDUE_HARVEST` 关键组合哨兵(全开 / 全关 / 只①(=治本无兜底,新僵尸零产生但
  存量在)/ 只②(= 第一轮形态))。

## 5. 决策点(呈 Tadashi,plan 过目时终裁)

- **D1(§1 分工表)**:①mark-当刻 / ②delete-证死后 的时机分工——确认 A3 答复适用域。
- **D2(Codex R1 #5 已给推荐,呈确认)**:B1 新增 failed/blocked 扫描集挂
  `FLYWHEEL_COMMDB_RESIDUE_HARVEST`,原 FLY-638 `{completed,timeout}` 行为无条件保留。
- **D3**:①层 flag 名 `FLYWHEEL_TERMINAL_COMMDB_SYNC`(default on)。

## 6. 实施顺序与提交纪律(Codex R1 建议顺序)

A1(schema/type/migration + 读侧候选集 + 写入优先级)→ A2(非阻塞 sync 队列 + 五写入面接线)→
A3(cleanup 审计 gate)→ A4(owner pins)→ B1(prune 扩展 + 接入 boot+maintenance,落实 D2)→
B2(全交错/三 flag 回归)。每步 RED→GREEN→REFACTOR、单独 commit 且全绿;全程 progress.md 记 cursor。
已实现的 M1-M5 commits 不动(implement 阶段在同分支增量);PR 头移动 → Codex code review 以 resume
增量复审全部新旧改动。PR 描述:决策级摘要 + §1 修订/分工表 + 双层验收清单,链
FLY-1066/FLY-817/FLY-742/FLY-1050/FLY-1279。

## 7. 真机验收(deploy 即验收,配下一次 Bridge 重启窗;M6 原样 + ①层新增)

1. **重启前置门**(必做):7 份生产快照跑 same-predicate preflight(log-only)输出 face/age/FSM/probe/
   action+reason 清单;独立 QA 核对 candidate/keep 集(重点 joycon-typeless/growth/sub 未判读行)。
2. 重启后:②收割计数出现;`d2f31930`/`e4d3b29d`/`e90f3962` 消失(Peter 复核,issue 原文)+
   ~11 条同型消失;flywheel 合法行(design_done×2 等)原样在场(阳性对照)。
3. **①层生产观察**:下一个自然产生的 failed/blocked session(如 auto-QA 失败)→ CommDB row 即时
   'failed'/'blocked',runner_terminal_list 不显示 running(对照:修复前形态 = 永久 running)。
4. 独立 QA 复查生产库,不信实现者自报。

## 8. 验收清单(汇总)

- [ ] A1:旧库重建保全 + 幂等 + 两 schema 路径 + 多进程 contention(R1 #6);写入优先级四交错测试
      (adapter-before-mark / mark-before-adapter / duplicate-mark / late-register,R1 #3);读侧候选集
      扩展 + failed/blocked × alive/dead × active_only 矩阵(R1 #4);cleanupStaleSessions 集合不动。
- [ ] A2:**五个生产写入面**(含 DirectEventSink blocked-completion / emitFailed / marker forceStatus
      fallback,R1 #1)各 fixture → drain 后 mark;enqueue-only 契约测试(writer 持锁 transition 立即
      返回,R1 #2);drain 前权威状态漂移不写;非 CRASH_PRESERVE 零 enqueue(突变对照);fail-open
      哨兵;flag=0 五面反向哨兵;retry teardown 哨兵;其余 forceStatus 点不可达证明落档。
- [ ] A3:cleanup 覆盖审计结论落档(非代码 gate,R1 #7)。
- [ ] B1:prune 四态矩阵 + boot/maintenance 双入口 + probe 去重 + 收敛 SLA(≤1 maintenance 周期);
      B2 交互回归 + 三 flag 组合哨兵。
- [ ] Bridge boot warm-migrate 全 configured CommDB 先于 sync 队列启用;迁移失败逐 project 告警且该
      project 不启用队列(R1 #6 部署顺序)。
- [ ] ②层既有验收原样(M6 清单:preflight 独立核对、3 样本+同型收净、零误伤阳性对照、§2 硬约束哨兵、
      负向断言全带突变对照)。
- [ ] §1 修订 + 分工表在 PR 描述链给 Codex reviewer;D1-D3 经 Tadashi 终裁。

## 9. 风险与对策

| 风险 | 对策 |
|---|---|
| 同步点拖慢/破坏 transition(CommDB 构造器重量级:mkdir/WAL/migrations/busy_timeout 5s,R1 #2) | enqueue-only(内存入队,微秒级)+ drain 在调用栈外 per-project single-flight;契约测试:writer 持锁时 transition 立即返回 |
| 漏接生产写入面(DirectEventSink 故意绕过 applyTransition,R1 #1) | 五写入面确定 inventory 全接线 + 各面 fixture;其余 forceStatus 点不可达证明落档;②收割兜底任何未来新绕行 |
| mark 被 adapter 尾写覆盖 / ended_at 漂移(R1 #3) | adapter 尾写 CAS WHERE status='running';mark first-terminal-write ended_at;drain 前重读权威状态;四交错测试 |
| CHECK 迁移撞上并发写者(runner CLI,busy_timeout 5s) | 两进程 contention 测试(R1 #6)+ boot warm-migrate 先于队列启用 + 失败逐 project 告警不启用 |
| 'failed' 新值到不了 Lead 视图(读侧硬编码,R1 #4) | A1 扩 getRecentTerminalSessions/countTerminalSessions + terminal-mcp 矩阵测试;cleanupStaleSessions 刻意不扩(kill 窗口 vs preserve) |
| mark 与 retry 语义冲突 | mark 不动 tmux_window;tmux-lookup 按 execId status 无关(已核+哨兵);preserve 窗口照常保留 |
| ①层 flag=0 时回到泄漏现状 | 有意为之(kill-switch 语义);②收割兜底仍在 |
| 双层同 PR 体量大 | Part B 已实现且 QA 过,增量只有 B1/B2;真实新代码 = A1/A2(小);Codex resume 增量复审 |

## 10. Non-goals(exploration §6 原样)

不动 FLY-742 PR-证据路径;无手动 HTTP 入口;不重建 worktree/app-server 清理机制;CommDB 不加
'terminated' 等更多值;park 语义零变化;FLY-638/817 关闭态 byte-compat;FLY-603 autoclean 调查独立跟。
