# Design Review — plan.md (FLY-1066 dual-layer) (Round 1)

Date: 2026-07-16
Author: Codex
Status: CHANGES REQUESTED

## Summary

双层方向可行，mark-at-transition / delete-after-proven-dead 的职责分工也成立；A1 先于 A2、复用 FLY-907/FLY-1279/FLY-638/817 的总体路线是对的。但当前计划把 `applyTransition` 当成了完整的 failed/blocked 写入咽喉，而现行生产代码明确存在绕过它的 `DirectEventSink`，同时同步 DB hook、状态写入竞态、读侧候选集和周期收割接线尚未闭合，因此现在还不能进入实现。

## What's Good (Keep)

- 保留 founder 明确要求的两层治理：Layer 1 阻止新 running 僵尸产生，Layer 2 继续处理 crash/OOM/SIGKILL/双账失同步等无法自清的死法。
- §1 的时机分工正确：failed/blocked 转移当刻只 mark，只有 `probe === "dead"` 才 delete；这保留了 FLY-116 的活窗口/scrollback/retry teardown 语义。
- A1 → A2 的依赖顺序正确；在任何代码写入 `failed` 前先扩 CHECK、类型和测试是必要门槛。
- Layer 2 继续坚持 tri-state probe、indeterminate keep、时间戳 fail-closed、单飞行和 kill-switch；这些与已完成的独立 QA/突变验证一致，应保持不动。
- `finalizeSession` 继续作为 delete 原语是正确的：它同时退休 gates、phase wakes、shutdown controls 和 sessions row，避免只删 registry row 的半清理。
- owner matrix 的大方向与源码一致：`closeRunner`、`crash-reaper`、`lifecycle-closeout` 已有各自的 CommDB/进程/worktree owner，不需要在本票重造机制。

## Issues & Recommendations

1. **[HIGH] A2 没覆盖生产中的两个真实 failed/blocked 写入面，Layer 1 仍会漏。** 计划只给两个 `ApplyTransitionOpts.onTransition` 实例接线（`plan.md:61-67`），但 `DirectEventSink` 明确说明它故意用 `upsertSession`、不会经过 `applyTransition`（`packages/teamlead/src/DirectEventSink.ts:102-108`）。生产 in-process completion 的 `route === "blocked"` 在 `DirectEventSink.ts:647,758-785` 直写 blocked；`emitFailed` 在 `DirectEventSink.ts:1036-1088` 直写 failed/blocked。`run-infra.ts:554-556` 也再次声明该绕行是生产设计。另有 `complete-marker-reconciler.ts:731-758` 的 `forceStatus` fallback；其他 `forceStatus` 点虽多注明 production 总会传 `transitionOpts`，也必须把“生产不可达”证明写死，而不是留到 implement 时再猜。建议提取一个共享的 `enqueueTerminalCommDbSync(executionId, status, projectName)`，明确接到：共享 onTransition、stale-guard onTransition、DirectEventSink 的 blocked completion、DirectEventSink.emitFailed，以及任何保留的生产 forceStatus 逃生口。测试必须直接跑上述生产 sink/fallback fixture；删除“若有则补、若无则 grep pin”的条件式描述，改成当前源码下的确定 inventory。

2. **[HIGH] 计划中的同步 CommDB hook 违反 FLY-907 的 hook 契约，并可能把一次 FSM transition 卡 5 秒以上。** `applyTransition.ts:19-27,71-80` 明文要求 hook 只做微秒级 enqueue；计划却在 hook 内解析路径、打开 CommDB、UPDATE。`CommDB` 构造器会同步 mkdir/open、设置 WAL、设置 `busy_timeout = 5000`、执行全量 SCHEMA、跑所有 migration、再 `purgeExpired`（`packages/flywheel-comm/src/db.ts:224-237`），这不是“微秒级单行 UPDATE”，锁竞争时也不是低延迟。伪代码还没有明确 `finally { db.close() }`。建议 onTransition 只把 `{execId,status,project}` 放进一个有界、coalesced、per-project single-flight 队列；队列在 transition 调用栈之外打开/关闭 DB，失败 warn、由 Layer 2 收敛。drain 前重读 StateStore，只有当前权威状态仍是 failed/blocked 才写，避免队列延迟期间发生 retry/shelve/terminate 后写回旧状态。增加“CommDB writer 持锁时 applyTransition 仍立即返回”的契约测试，以及 open/update/close 的异常测试。

3. **[HIGH] `updateSessionStatus` 目前是无条件 last-writer-wins，A2 的 mark 可被 adapter 尾写覆盖；“重复 UPDATE 幂等”也不成立。** 该方法无条件更新 status 并把 `ended_at` 改成当前时间（`db.ts:1911-1919`）。Claude adapter 的 finally 会随后写 completed/timeout（`packages/claude-runner/src/TmuxAdapter.ts:698-707`）；Codex adapter 也会写 completed/timeout/blocked（`CodexTmuxAdapter.ts:817-829,889-905`）。因此 heartbeat/zombie 路径先 mark failed、adapter 后收尾时，CommDB 可以重新变成 completed/timeout；重复 mark 还会漂移 `ended_at`，影响 terminal recency/order。建议在 A1/A2 之间先定义写入优先级：adapter 的生命周期尾写只能 CAS `status='running'`；FSM/DirectEventSink 的 failed/blocked 同步是 StateStore 权威写，但 drain 时必须确认权威状态仍匹配；`ended_at` 用 first-terminal-write 语义（例如 `COALESCE(ended_at, datetime('now'))`）。同时审计 `registerSession` 的 `INSERT OR REPLACE`（`db.ts:1875-1887`）是否存在晚注册覆盖 terminal mark 的可达时序；若证明不可达就加顺序哨兵，否则改成保留已存在 terminal 状态。必须补 adapter-before-mark、mark-before-adapter、duplicate-mark、late-register 四个交错测试。

4. **[HIGH] 新状态并未真正进入 `runner_terminal_list` 的读取候选集，plan/research 对 reader compatibility 的结论不成立。** `classifyRunnerRow(status !== running)` 虽能分类任意终态（`packages/terminal-mcp/src/lifecycle.ts:20-22`），但调用方只取 `getActiveSessions()` 的 running 加 `getRecentTerminalSessions()` 的 completed/timeout；后者及配套 count SQL 都硬编码 `('completed','timeout')`（`db.ts:2052-2065,2073-2082`；`packages/terminal-mcp/src/index.ts:182-198`）。所以 marked failed/blocked 根本到不了 classifier：活着的 preserved 窗口不会显示 parked-alive，`active_only=false` 也看不到 dead 行。这既与 exploration 的可见性描述冲突，也削弱人工取证入口。建议 A1 同步扩 `getRecentTerminalSessions` 和 `countTerminalSessions` 到 completed/timeout/failed/blocked，更新 terminal-mcp 文案和 cap/count 测试，并覆盖 failed/blocked × alive/dead × active_only。不要顺手扩 `cleanupStaleSessions` 的 `{completed,timeout}` 集合；它会主动 kill 窗口，与 failed/blocked preserve 政策不同。

5. **[MEDIUM] B1 当前只是 boot prune；A2 一旦把行移出 running，小时级 Layer-2 full pass 就再也看不到它。** 现有 `ResidueHarvester.runFullPass` 只跑 running reconcile、StateStore ghost 和 orphan escalation（`packages/teamlead/src/bridge/residue-harvest.ts:37-66`），heartbeat maintenance 只调用该 full pass（`plugin.ts:5361-5369`）；FLY-638 prune 仅在 boot wrapper 另行执行（`residue-harvest.ts:98-107`、`plugin.ts:5742-5763`）。因此“mark 后窗口一死就由 B1 收走”实际是“等下次 Bridge restart 才收走”。建议把扩展后的 terminal prune 纳入 residue full pass 的 per-project 阶段，同时避免 boot 同一轮重复 probe；并在计划中明确收敛 SLA。D2 也应在实施前定案：只把新增 failed/blocked 扫描集挂在 `FLYWHEEL_COMMDB_RESIDUE_HARVEST` 下，保留原有 completed/timeout FLY-638 行为无条件运行；这样 `=0` 才真正恢复旧扫描集。

6. **[MEDIUM] A1 对多进程迁移风险的处理只有断言，没有验证或运行顺序。** “事务原子、表很小、毫秒级”不足以覆盖 Bridge 与多个 runner CLI 同时构造 `CommDB` 的场景；构造器有 5 秒 busy timeout，而且每个进程都在 transaction 外先读 schema 再决定是否重建。建议在 A1 加两进程 contention 测试：旧 schema 上一个进程持写锁/插入行，另一个进程触发迁移，释放后验证两边数据、vendor、索引、新 CHECK 全保全；再覆盖超过 busy timeout 的失败不会留下 staging table/半迁移、下一次 open 可重试成功。部署顺序写清为 Bridge boot 先显式 warm-migrate 所有 configured CommDB，再启用 sync queue；迁移失败必须逐 project 明确告警，但不能让部分 schema 被误报为已启用。新库的顶层 `SCHEMA` 与旧库 migration 两条路径都要测。

7. **[MEDIUM] A3 是一个尚无具体缺口的条件式实现里程碑，反而遗漏了上面已经证实的 DirectEventSink 工作。** 当前 fresh/retry dispatcher 已在 pre-launch abort、promise rejection、以及无 sessionId 的失败结果上调用 `cleanupPreRegistration`（`packages/teamlead/src/bridge/run-dispatcher.ts:618-630,824-843,888-925,1203-1214,1388-1421`）。建议把 A3 改成“审计并引用/补 pin 现有 cleanup 覆盖”的非代码 gate；只有找到一个具名、可复现、且确实拿到“从未启动”证明的未覆盖分支时才新增 unregister 调用。这样范围更小，也把实现预算移到真实必需的 DirectEventSink、write ordering 和 reader/wiring 修复上。

建议的新顺序为：A1 schema/type/migration + reader query + CommDB 写入优先级 → A2 非阻塞 sync queue + 全生产写入面接线 → A3 cleanup audit/pin → A4 owner pins → B1 接入 boot+maintenance 且落实 D2 → B2 全交错/三 flag 回归。A1 仍必须先于任何 `failed` 写入。

## Verdict

CHANGES REQUESTED — address items above
