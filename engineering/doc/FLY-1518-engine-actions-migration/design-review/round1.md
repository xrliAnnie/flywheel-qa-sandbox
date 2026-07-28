# Design Review — FLY-1518 plan.md (Round 1)

Date: 2026-07-28
Author: Codex
Status: CHANGES REQUESTED

## Summary

D1/D2/D3 的方向与 actions 黑匣子权威一致，0008 的 SQL 主体、删除顺序和 `fkMode: "rebuild"` 也可行；当前生产代码中确实只有 v2-engine 仍写 `commands`，没有任何生产 reader。计划暂不能实施，因为真实 lead 转化路径拿不到新接缝所需的 handle，`RecordActionIntentSpec.cutoverEpoch` 没有来源或同事务 fence，且“git revert 即回滚”对已执行 0008 的数据库不成立。

## What's Good (Keep)

- 保留 D1 方案 B：effect 由 Agent 在 conversion 中经 `runRecordedAction` 亲手执行，settlement 只提交 task/event；没有重建 dispatcher、scanner、probe、executor registry 或自动 action retry。
- `messageUid` 跨 processing attempt 稳定，`attemptUid` 不进入 action 幂等身份；E1/E4/E5/E6/E7 正确覆盖了重投递、多动作、未知窗和 generation 接班。
- runner binding 的字段映射与 0006 一致：`activations.attempt_id/generation` 加 `attempts.task_id` 正好提供 CHECK/`actions_lineage_insert` 所需三元组；consumer generation 与 attempt generation 也正确保持解耦。
- `prepare` 中复用 `requireCurrentAgentTx` 和 `requireAttemptBindingTx` 是合适的 engine-level admission fence；它只约束新 intent，不引入 action executor。
- 0008 先写回执、再删挂在 `tasks/attempts` 上的两个 trigger、再按 child→parent 删除三表，顺序正确。`events` 的九列赋值均符合当前 DDL；我用 SQLite 3.51 对带两条 commands、一条 dependency edge、root+depth-1 obligation 的最小库实际执行了该 SQL，得到 `{"commands":2,"command_dependencies":1,"obligations":2}`，退役对象全部消失。
- `fkMode: "rebuild"` 与 migrator 的真实机械一致：事务外关 FK，事务内执行 DDL、`foreign_key_check`、登记 checksum，异常整体回滚，finally 恢复 FK。
- 0001/0002 在当前评审 HEAD 相对指定基线 `9455a2b8` 无字节变化；采用 0008 前向删除而不改 checksum-locked 历史迁移是正确做法。
- settlement 的 command FK 注入改成 `tasks.lineage_root_id` FK 注入是可行的；poll-loop 测试仍可证明异步 settlement 错误在下一次 shell poll 浮出。
- D2 的偏离记录充分且范围克制；不在本批次 rebuild `attempts`，避免与 FLY-1520 形成隐式串行。
- A1、A4、时间戳校验、0008 fresh/upgrade/failure 双路径以及 design-FINAL 并稿清单总体合理。

## Issues & Recommendations

1. **[HIGH] 新 action 接缝没有接入真实 lead conversion 调用面。**

   当前 `Converter` 只接收 `{messageUid,payload,kind,sourceKind,seq}`（`packages/v2-engine/src/types.ts:135`），`EngineDriver.#runLead` 也只传这些字段（`packages/v2-engine/src/driver.ts:321`）；它拿不到计划中 `performConversionAction` 强制要求的 `AttemptHandle`。同时包只开放 root export（`packages/v2-engine/package.json:8`），现有 root index 没有新接缝（`packages/v2-engine/src/index.ts:1`），API 测试还锁死了精确 runtime export 集（`packages/v2-engine/src/__tests__/api-surface.test.ts:5`）。按现计划可以写出并单测一个 helper，但自动 lead 路径无法调用它，D1 的生产 seam 仍是断的。

   建议在计划中锁定唯一真实调用形态：例如给 `Converter` 增加一个 conversion context，内含当前 `handle` 和绑定好的 generic `performAction(action, perform)`；或者提供 `EngineDriver.performConversionAction(handle, ...)`，同时确保 converter 能取得 handle。不要让业务 converter 自由持有 kernel。只把调用方真正需要的 runtime seam 放到 root export；`deriveConversionInvocationUid`/`resolveActionBinding` 可保持 package-private。新增一个从 `registerLead` 进入的端到端 E5/E7 测试，而不只直接调用 helper。

2. **[HIGH] `cutoverEpoch` 是必填 intent 字段，但计划既没有组装它，也没有 mutation-time epoch fence。**

   `RecordActionIntentSpec.cutoverEpoch` 必填（`packages/v2-kernel/src/actions.ts:27`），并参与 `logical_key` 和 replay envelope（`packages/v2-kernel/src/actions.ts:368`、`:394`）。计划的 options 和组装清单（plan `§1.1`, lines 50-78）完全没有该字段；直接照写不能完成 spec。若实现者只在 intent 前做一次普通 read，跨进程 cutover 可在 read 与 insert 之间改变，action 会以 stale epoch 落账，甚至因新 epoch 形成新 logical root 而再次执行 effect。

   建议明确：从当前 handle 所绑定的 mailbox 行读取 `cutover_epoch`，同时读取 canonical `meta.cutover_epoch`；构造 spec 后，在 `prepare(tx)` 中与 `requireAttemptBindingTx` 一起重新验证“mailbox epoch = captured epoch = current meta epoch”，不相等则在 intent/effect 前 fail closed。为此可让 `readAttemptBinding` 返回 mailbox epoch。增加 epoch 在捕获后漂移的测试，断言无 action、无 perform；replay 路径只读旧事实，不执行 effect。

3. **[HIGH] 回滚章节把代码 revert 错当成数据库 downgrade。**

   plan line 256 声称“revert 即回 9455a2b8”；但 migrator 只有 forward apply/checksum，没有 downgrade（`packages/v2-kernel/src/migrator.ts:115`）。任何持久库一旦执行 0008，即使三表原来为空，git revert 后 ledger 仍有 0008、三表仍不存在，而旧 engine 会重新执行 `INSERT INTO commands`（`packages/v2-engine/src/sql.ts:59`）并崩溃。若旧表有数据，events 回执只有计数，不能恢复行内容。

   建议把回滚合同改成两段：0008 尚未应用时才可单纯 git revert；一旦应用，必须恢复迁移前 WAL-safe backup（或对可抛弃的 pre-launch v2 DB 明确整库重建），不能把回执行当 recovery artifact。把“运行 0008 前取得并验证 backup”加入 upgrade runbook/M3，并测试 backup restore 后旧三表及数据仍在。

4. **[MEDIUM] invocation UID 的 delimiter 声明不成立，`qualifier` 的“独立执行”用途还违反 root 唯一约束。**

   plan lines 31-36 说输入含 `::` 仍无歧义，但拼接不是单射。例如同一 `logicalEffectId="x"` 时，`("a","x","b::x::c")` 与 `("a::x::b","x","c")` 都得到 `a::x::b::x::c`；在 actor/kind/binding/epoch 相同时 logical key 也相同，第二条消息会误 replay 第一条。更直接地，qualifier 只改变 invocation UID，不改变 logical key，而 0006 有 `actions_one_root_per_logical`（`packages/v2-kernel/src/migrations/0006-actions-black-box.ts:77`）；因此“同一 logicalEffectId 的两次独立执行”若不带 supersede 会撞 root UNIQUE。FLY-1500 已规定独立效果必须换新的 logicalEffectId。

   建议用无碰撞编码（canonical JSON tuple 或 length-prefix）派生 UID，或在 API 边界强制并测试不含 delimiter 的字符集。文档改为：独立效果必须使用不同 `logicalEffectId`；qualifier 只用于同一 logical root 的新 invocation attempt，并且 supersede 时必须同时有 `supersedesActionId + retryBasis`。为 delimiter 碰撞和“qualifier 不得绕过 root 唯一”各加一个反例。

5. **[MEDIUM] A2/A5 的机械方案没有对齐当前 canonicalizer 边界。**

   A2 要求 v2-actions “先试 canonicalize(result)”，但 canonicalizer 是 v2-kernel `actions.ts` 的私有函数（`packages/v2-kernel/src/actions.ts:145`），kernel 只开放 root package 且拒绝 subpath；v2-actions 无法调用它。复制一份会制造两套 JSON authority；直接 catch 整个 `recordActionOutcome` 又无法可靠区分 serialization failure 与 CAS/generation/SQLite failure。A5 所写“toJSON 携带者按自身键序列化”也不符合当前行为：普通对象上的 callable `toJSON` 会作为 function value 被拒，非 enumerable `toJSON` 会被 own-key 检查拒绝，非平凡 prototype 也会先被拒。

   建议在 plan 中选择一条明确且单一的共享边界，例如让 kernel 把 canonicalization failure 包装成可类型区分的 error，v2-actions 先尝试真实 outcome，仅对该 error 用受控壳再写 succeeded；CAS/fence/SQLite 错误必须继续上抛且不得伪装成 serialization error。若改为公开 pure canonicalizer，要显式评审并更新 kernel 的 exact public surface。A5 应锁成“callable toJSON 不被调用并被拒；JSON-valued 的普通 `toJSON` 字段按数据处理；boxed object 被拒”，不要声称当前不存在的行为。

6. **[MEDIUM] 文件/test blast radius 与验收 gate 不完整，按清单实现会在 CI 留红。**

   新 workspace dependency 必须同步 `pnpm-lock.yaml`；CI 使用 `pnpm install --frozen-lockfile`（`.github/workflows/ci.yml:39`）。新的 public engine seam 还要求更新 `src/index.ts`、`src/__tests__/api-surface.test.ts` 和 `type-tests/public-api.ts`。此外 `packages/v2-kernel/src/__tests__/backup.test.ts:61` 硬编码迁移列表只到 0007，0008 加链后必失败，但 plan `§2.3` 没列它。

   建议给计划补一份真实文件清单，至少纳入上述四处与 lockfile；若 A2 增加 kernel public utility/error，也同步 kernel public API/type tests。Z1 还需拆成两道：production runtime（排除 migrations 和 `__tests__`）必须旧表 SQL 零引用；历史 migration tests 明确 allowlist `obligations-migration.test.ts` 与 0002 failure cases。当前 Z1 的“packages/v2-* 非迁移源码零引用”与计划保留这些历史测试相互矛盾。

7. **[MEDIUM] E3/M4 的断言应覆盖事务中已经发生的前置写，而不是只让第一条 effect 失败。**

   计划的 replacement 仍把单个 invalid task 作为第一个/唯一 effect；它能证明 mailbox/attempt 没 settle，但不能证明 effect loop 中先前成功的 task/event 会随第二个 effect 失败而回滚。E3 却声称“task/event 产出 + applied + succeeded 全事务”。同理 M4 只列三表与 ledger，没有点名 DROP 前已经写入的 discard receipt 必须回滚。

   建议 settlement E3 使用“先写一个有效 event/task，再写一个 invalid lineageRootTaskId task”的顺序，断言前一个 effect、invalid effect、`mailbox.applied` event、mailbox CAS、processing-attempt CAS 全部未提交；poll-loop 只保留异步错误 surface 的职责。M4 再断言 `migration:0008:retired-rows-discarded` 不存在，并断言两个外部 tombstone triggers 与旧表数据均恢复。

## Verdict

CHANGES REQUESTED — address items above
