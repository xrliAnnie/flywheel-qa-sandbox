# Design Review — plan.md (Round 4)

Date: 2026-09-03
Author: Codex
Status: CHANGES REQUESTED

## Summary

Round 4 已正确闭合上一轮的 turn barrier 稳定尾、claim-time started 写、terminal 失败优先级和 0.153.2 `thread/read` envelope；这些合同现在与现有同步通知路径和协议形状相符。迁移方案仍有两个可导致“有 receipt 但备份不是迁移前精确状态”的阻断窗口，并且 writer census 漏掉了直接 `MailboxQueue(path)` 的生产写入面；在这些边界闭合前，M3-1 仍不具备可证明的 fail-closed/可回滚性。

## What's Good (Keep)

- `settled()` 改为 drain 到稳定链尾，并把 started 写固定在 RPC claim 后、`setGoal(active)` / `finishWake` / `leaveHold` 之前，是可执行的边界 barrier；`setup_failed` 压过并发 terminal 也关闭了原先的吞错路径。
- `thread/read` parser 已按 0.153.2 的 `ThreadReadResponse { thread }`、`Thread.id`、`Thread.turns[]` 和 `TurnStatus` 定义，并保留显式、受测的旧 envelope union。
- 明确撤回“updater 已冻结所有 writer”的错误前提是正确的；receipt 增加 backup SHA、source main/WAL binding、backup `quick_check` 和 consumed 标记，为受控重建提供了合适的基础材料。
- 之前已闭合的 legacy `phaseRole` digest、multi-binding activation、completion/drain 同事务、expiry canonical identity、shutdown exact-request 与多 pending ACK 合同仍保持一致，没有重新引入节点名、flag、新表或新告警面。

## Issues & Recommendations

1. **[BLOCKER] 计划规定的构造器顺序会在 receipt/source binding 校验前先写库，合法 receipt 因此会被自己制造成 stale，缺 receipt 也无法满足“零写入”。** M3-1 明确把三个 `ADD COLUMN` 排在 shutdown rebuild 的 receipt 门之前（`engineering/doc/FLY-2268-worker-resident-receiver/plan.md:67,106-109`）。真实构造器当前还在迁移事务前执行 `PRAGMA journal_mode=WAL`、`SCHEMA` 和 `ensureMailboxQueueSchema`，事务取得 `BEGIN IMMEDIATE` 后的首个动作又是 drop views，随后 `applyMigrations` 还会执行写入（`packages/flywheel-comm/src/db.ts:1053-1088,1190-1195`）；`ensureMailboxQueueSchema` 本身可 `ALTER TABLE`、建索引、更新行和重建 view（`packages/flywheel-comm/src/mailbox-queue.ts:313-399`）。三个新列一旦先写入，main/WAL hash 必然不再等于 preflight receipt，重建无法通过；若门缺失，前置写又已经发生。建议把“旧 PK 探测 → receipt 读取 → `BEGIN IMMEDIATE` → backup/source/schema 全量复验”移到 writable open 的最前端，并使它成为锁内第一个可能影响旧库的步骤；只有通过后才执行 `SCHEMA`、queue schema、三个加列和 shutdown 重建。缺失/stale receipt 的测试应断言 main、WAL、schema 与行内容均逐字节不变，而不只断言 shutdown 表没重建。

2. **[BLOCKER] `backupCommDb → 计算 sourceBinding` 没有把 backup 与 receipt 所描述的源快照原子绑定。** §10.2 明确在备份返回后才计算 main/WAL hash（`engineering/doc/FLY-2268-worker-resident-receiver/research.md:349-353`）；而 `backupCommDb` 在 `source.backup()` 完成后关闭只读连接、校验并返回，期间没有持有阻止其他 writer 提交的锁（`packages/flywheel-comm/src/mailbox-migration.ts:1287-1317`）。若 writer 恰在 backup 完成后、source hash 计算前提交，receipt 和构造器都会看到提交后的相同 source hash，于是重建被放行，但 backup 不含该提交；计划关于“backup = 重建前完整状态”和无损恢复的结论不成立（`engineering/doc/FLY-2268-worker-resident-receiver/plan.md:116`）。建议让 preflight 在同一个可证明的 writer-exclusion 区间内完成源快照绑定、SQLite backup、backup 校验和 receipt durable write，或采用等价的前后 source binding/逻辑内容一致性证明；仓库现有 FLY-1572 路径是在记录 binding 后先 fence main/WAL，再做 backup（`packages/flywheel-comm/src/mailbox-migration.ts:1918-1941,1971-1977`）。增加精确 fault injection：writer 在 backup 完成与 binding 捕获之间提交，系统不得用缺少该行的 backup 放行重建。

3. **[HIGH] “生产 writer 全集”只扫描 `new CommDB(`，遗漏了直接打开同一 comm.db 的 `MailboxQueue(path)` 写入路径。** research 仅要求把 `rg "new CommDB\\(" packages scripts` 的结果入表（`engineering/doc/FLY-2268-worker-resident-receiver/research.md:344-347`），但 `MailboxQueue` 的 path 构造器会直接 writable open、设置 WAL、执行 schema、迁移 queue schema、drop receipt ledger 并装 triggers（`packages/flywheel-comm/src/mailbox-queue.ts:446-475`）。生产 Codex Lead 两条 runtime 都以 `config.commDbPath` 直接构造它（`packages/teamlead/src/lead-backends/codex/codex-lead-tui-runtime.ts:626-638`; `packages/teamlead/src/lead-backends/codex/codex-lead-runtime.ts:1679-1685`），Discord ingest 也如此（`packages/flywheel-comm/src/discord-chat-ingest.ts:74-82`）。这既使“每个 writer 在旧 PK + 无 receipt 时 fail-loud、零写”验收为假，也漏测 preflight 的真实竞争者。建议把 census 扩为所有对 comm.db 的 writable open（至少 `CommDB`、path-form `MailboxQueue` 和直接 `better-sqlite3`），让新二进制路径共享 early gate；对无法改造的在飞旧进程，明确由第 2 项的快照锁保证安全，并加入并发写回放。

4. **[HIGH] claim-time started barrier 仍未定义 RPC 响应缺少 turn id 时的 fail-closed 行为。** 计划要求用 RPC response 的 turnId 在 claim 时入链，但验收没有 malformed/missing id 负例（`engineering/doc/FLY-2268-worker-resident-receiver/plan.md:23,138`）。现有 `startTurn` 返回 `Promise<string | undefined>`，因为响应只经过宽松的 `extractTurnId`（`packages/claude-runner/src/codex-daemon-client.ts:544-565,1622-1631`）；`claimTurnDispatch` 在响应和已缓冲通知都没有 id 时仅记 diagnostic 后返回（`packages/claude-runner/src/codex-daemon-client.ts:789-803`）。若 malformed response 先到、`turn/started` 稍后到，post-claim `settled()` 可在没有任何 `markTurnStarted` 的情况下通过，原来的 mid-turn 逃逸重新出现。建议严格解析官方必填的 `TurnStartResponse.turn.id`；claim 时仍取不到可归属 id 就立即 latch `TurnBarrierError`，最终转 `setup_failed`，不得继续 goal。新增“响应缺 id、通知迟到”的真实 frame 顺序测试，断言不 push、不 active、不 leave hold。

## Verdict

CHANGES REQUESTED — address items above
