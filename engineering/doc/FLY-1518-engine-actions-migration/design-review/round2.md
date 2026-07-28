# Design Review — FLY-1518 plan.md (Round 2)

Date: 2026-07-28
Author: Codex
Status: CHANGES REQUESTED

## Summary

Round 1 的七项修订已实质纳入：真实 lead 调用面、epoch 三等式 fence、无碰撞 UID、单一 serialization authority、数据库恢复认知、完整 public/lockfile 面，以及更强的 E3/M4 都与当前架构相容；0008 DDL 本身仍然正确。当前仍不能批准实施，因为新 async action API 没有把“所有 action outcome 必须先于 settlement”做成 driver 不变量，另外 M5/runbook 与 Z1 allowlist 尚未落成可执行且自洽的验收步骤。

## What's Good (Keep)

- `EngineDriver.performConversionAction` 与注入给 `Converter` 的 bound `ConversionContext` 把接缝接入了真实 lead 路径，同时不把 kernel 交给业务 converter；package-private derive/resolve helper 与 root API/type-test 更新范围也正确。
- runner binding 仍准确对应 0006：`activations.(attempt_id,generation)` 加 `attempts.task_id` 提供 action CHECK/lineage trigger 所需三元组，consumer generation 与 DAG attempt generation 没有混用。
- 从 handle 对应 mailbox 捕获 `cutover_epoch`，并在 `prepare(tx)` 内重验 mailbox captured/current meta 三等式，能在新 intent/perform 前 fail closed；`ENGINE_SQL.readAttemptBinding` 是合适的共享读取落点。
- 固定形状 JSON tuple 消除了 delimiter 碰撞；独立效果换 `logicalEffectId`、qualifier 只服务显式 supersede 的方向符合 FLY-1500 黑匣子合同。
- `ActionSerializationError` 让 kernel 保持唯一 canonical JSON authority，v2-actions 只对 serialization failure 做诚实 succeeded fallback；CAS/fence/SQLite 错误继续原样上抛，边界正确。
- E3 先写合法 effect 再注入 FK 失败，M4 同时验证 receipt、旧数据与外置 tombstone triggers 回滚，均恢复了完整事务证明力。
- 0008 的 receipt 行符合当前 `events` schema；先删挂在 `tasks/attempts` 上的两个 trigger，再按 dependency→commands→obligations 删除，配合真实 `fkMode: "rebuild"` 的事务与 `foreign_key_check` 机械可行。
- 当前生产源码没有三张退役表的 reader；生产 blast radius 仍是 v2-engine 的 command writer。0001/0002 相对指定基线 `9455a2b8` 仍无字节变化。
- 计划没有引入 dispatcher、probe、reconciler、executor registry 或自动 retry，且没有越过 FLY-1520 的 engine/migration 边界。

## Issues & Recommendations

1. **[HIGH] 两个 async action 入口没有形成 settlement barrier，漏 `await` 时 D1 会被直接违反。**

   新 API 都返回 `Promise<RunRecordedActionResult>`（plan lines 41-57），但计划只说它们共享实现，没有让 `AgentState`/settlement 观察 in-flight action。当前 lead 路径在 `packages/v2-engine/src/driver.ts:321` 只等待 converter 返回，随后在 `:335-339` 立即 `submitProposal`；直接 handle 路径的 `submitProposal` 在 `:178-181` 也是同步入口。与此同时 `runRecordedAction` 要到 `await perform()` 之后才写 succeeded outcome（`packages/v2-actions/src/index.ts:37-67`）。因此 converter 执行 `void ctx.performAction(...deferred perform...)` 后返回成功，或 runner 启动 `driver.performConversionAction(...)` 后未等待就调用 `submitProposal`，都可先提交 mailbox/task/event/attempt，再晚到 action outcome；这与 D1 的 “intent→perform→outcome 全部在 settlement 前” 相反。正常 `await` 的 E5/E7 不会捕获此反例。

   建议把 barrier 做进唯一 driver 实现：按当前 handle 在 `AgentState` 跟踪所有 action Promise；lead converter 返回后先关闭 context、drain/传播所有已登记 action 的结果，再允许 success/failure settlement；直接 `submitProposal`/`reportConversionFailure` 若仍有 in-flight action 则 fail closed（或统一改为等待同一 barrier）。登记时立即挂 rejection observer，避免被调用方忽略的 rejection 变成 unhandled。新增两个回归：lead 故意不 await deferred `ctx.performAction` 时 mailbox 在 outcome 前仍 pending；runner 在 action pending 时 submit 被拒，await action 后才可结算。

2. **[MEDIUM] M5 仍只有目标描述，没有落到真实 restore 操作、文档落点或 TDD 切片。**

   plan lines 213-214 声明 “restore 后三表与数据俱在”，line 288 又要求 upgrade runbook 硬前置；但 §2.3 对 `backup.test.ts` 只安排更新硬编码迁移列表（lines 185-186），§3.1 没有明确把 backup/restore procedure 写进 `design-FINAL` 的切换手册，TDD step 6 仍止于 M1-M4（line 260）。当前 `backupDatabase` 只创建并验证独立 snapshot；现有 `backup.test.ts:44-73` 也只是打开 backup 副本，并未模拟“0008 已应用后恢复运行库”。若只照现有文件清单实现，M5 很容易退化成重复的 backup-read 测试，不能证明实际回滚合同。

   建议指定唯一落点：在 `design-FINAL-v2.md` §4（或一个具名 upgrade runbook）写出 quiesce/关闭所有 writer → 对 0007 库执行并验证 `backupDatabase` → 应用 0008 → 失败时隔离新 DB 及其 WAL/SHM、恢复 snapshot、配对 code revert、以 0007 ledger 和旧表逐行数据验证后再启动。把 M5 明确放入 `backup.test.ts` 或一个具名新测试，并在 TDD step 6 中列出；测试必须真的从已迁移状态切换到恢复后的数据库路径，而不只是 read-only 打开备份文件。

3. **[MEDIUM] Z1b 的 allowlist 与计划自己要求的 M3-M5/schema-negative tests 互相冲突。**

   Z1b（plan lines 243-245）只允许 `obligations-migration.test.ts`、`migrator-failure.test.ts` 的 0002 用例和 0001/0002 migration，但 §2.3/§4 同时要求 `schema-contract.test.ts` 点名验证三表不存在、M3 塞入三张旧表、M4 查询旧数据/trigger/receipt、M5 验证恢复后的旧表（lines 178-185、209-214）；新 0008 migration 本体也必然包含这些表名。按字面执行，正确实现必定被 Z1b 判红。

   建议保留 Z1a 对 production runtime 的严格零引用；把 migration/test gate 改成精确 allowlist，至少包含 0001、0002、0008、`obligations-migration.test.ts`、schema-negative assertions，以及承载 M3/M4/M5 的具名测试。最好扫描 SQL 操作形态并区分“生产读写”与“migration/退役证明”，避免用裸词命中迁移 ID 或负断言。

4. **[LOW] TDD 顺序尚未同步 Round 2 新增的依赖与矩阵编号。**

   step 3 只点 E5，step 5 只列 E1/E2/E4/E6/E7，step 6 只列 M1-M4；E8、E9、M5 没有进入 red→green 顺序。A2 又依赖 kernel 先新增并导出 `ActionSerializationError`，而 step 2 只写 “v2-actions A2”。

   建议把 step 2 明写为 kernel typed error/public surface 先红绿，再做 v2-actions fallback；step 3 加 E8/E9；step 6 加 M5，并在 Z1 之前完成测试 allowlist。这样实施顺序与 §4/完成判据一致。

## Verdict

CHANGES REQUESTED — address items above
