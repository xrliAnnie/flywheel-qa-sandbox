# Design Review — plan.md (Round 5)

Date: 2026-09-02
Author: Codex
Status: CHANGES REQUESTED

## Summary

Round 5 已把 #1 的 set-once ledger 定义、#5 的 completion settlement、#7 的可执行 schema 验收写清，并继续遵守“零新表、零新告警面”的封顶约束。不过，对当前代码逐点代入后，#2、#3、#4、#6 仍有会让 DDL、阶段计时或 expiry saga 实际失效的缺口，research 与迁移文字也尚未完成 #8 的同步，因此还不能批准实现。

## What's Good (Keep)

- Lead 对“append-only”的项目内定义已无歧义：attempt 行不删除，五个阶段时间与 `settlement_reason` 仅允许 `IS NULL` 的 set-once CAS；对应的二次写零变更和 DELETE 静态守卫可直接验收。
- `root_id` 已加入 project/issue namespace，reroute 的 generation 与 sanctioned resend 的 attempt 语义也已拆开，避免把普通 push retry 当成新血统。
- completion 的两个分支都在原事务内终结 attempt，live 索引改看 `settlement_reason IS NULL`，Round 4 的永久 live-attempt 问题在 plan 中已修正。
- `first_push_at` 已从 claim 路径移到 push completion 路径，方向正确；claim 后崩溃、首次成功、重试不覆盖三类测试也已列出。
- TURN belt 使用 `NOT NULL DEFAULT 0`，换手时清 active turn 并提升旧 holder 的 deferred rows；完成事件不再依赖 Bridge 内存 generation。
- shutdown control 改为每个 `(execution_id, request_id)` 一行，解决了新 expiry 请求被旧 failed 行从插入层面挡住的问题。
- A7 现在给出固定的 `sqlite_master` 查询、显式索引名和独立 alert-prefix 守卫；五张 StateStore 表也逐表解释了不能并入既有实体的原因。
- 本轮没有新增表或告警通路，reroute/expiry 仍复用 `workflow_delivery_operation` 和既有 Lead inbox path。

## Issues & Recommendations

1. **[BLOCKER] #2 的 `parent_attempt` 外键按当前 DDL 形状无法建立。** 父表主键是三列 `(root_id, generation, attempt)`，但计划只给 child 一个 `parent_attempt` 并声明它直接 FK 到父表；SQLite 外键的子/父列数量必须一致，派生而未物化的 `attempt_id` 也不能成为引用目标。实现时要么物化一个 `attempt_id TEXT UNIQUE` 并让 `parent_attempt` 引用它，要么把 parent 拆成 generation/attempt 并建立 `(root_id, parent_generation, parent_attempt) → (root_id, generation, attempt)` 的复合 FK；同时把精确 DDL 与 dangling-child 阴阳测试写入 M1/A7。该修复只改变已批准 ledger 表内部形状，不需要新表或新告警。证据：`engineering/doc/FLY-2248-generic-delivery-contract/plan.md:35,68,97-98,145`。

2. **[BLOCKER] #2 的 CommDB g1 物化顺序与故障恢复描述互相相反，后续阶段回填也没有可重驱 owner。** 计划规定先提交 StateStore attempt、再插 CommDB 行，却把崩溃窗口写成“CommDB 行存在但 attempt 不存在”；真实窗口恰好是 live attempt 已存在、物理 IOU 不存在。当前 baseline 只修后一种情形，发送重试也没有定义如何凭稳定业务键找回原 root/attempt，因而可能留下永久 orphan 或另铸 root。类似地，native `first_push_at/notified_at/acked_at/started_at` 提交后到 attempt 回填前崩溃时，watch 又明确零写入，而 boot 只做一次 baseline，没有命名的持续 projector，阶段可能永远停在 minted/sent 并误报。请在现有 attempt/operation 机制内补齐两方向 crash matrix：发送重试必须复用已存在的 g1 intent；维护 pass 在 watch 前幂等补投影 set-once 时钟，并覆盖“CommDB 已提交、StateStore 未回写”和“attempt 已提交、CommDB 未插入”。无需新增表或 alert surface。证据：`engineering/doc/FLY-2248-generic-delivery-contract/plan.md:35,37,79,81,84-85,97-98`。

3. **[BLOCKER] #6 只改复合主键而没有迁移现有单行读取合同，expiry saga 仍可能永远等不到自己的 ACK。** 当前 `requestRunnerShutdown` 插入后和 `getRunnerShutdown` 都仅按 `execution_id` 读取一行；held loop 的 `observe`/poll 也只消费这一个未排序结果。复合主键允许同 execution 同时存在旧 requested/acked/failed 与新 expiry request 后，runtime 可能读到并 ACK 旧行，而 saga 按计划只检查自己的 requestId，于是自己的行永久 requested。请明确并实现 exact-request 查询以及 runtime 的多 pending 规则（例如退出时 ACK 该 execution 的全部 pending shutdown，或确定性选中并 ACK expiry request），并把所有仍假设“一 execution 一行”的 caller/测试纳入迁移 sweep；三种旧状态测试必须同时断言 expiry 自己的 requestId 达到 ACK/projected。证据：`engineering/doc/FLY-2248-generic-delivery-contract/plan.md:43,52,113,152`；`packages/flywheel-comm/src/db.ts:230-237,4240-4306`；`packages/claude-runner/src/codex-phase-lifecycle.ts:287-292,493-520`；`packages/teamlead/src/bridge/codex-phase-shutdown.ts:207-241`；`packages/teamlead/src/bridge/land-cleanup-opportunity.ts:33-48`。

4. **[HIGH] #4 绑定了生产代码从不产生的 phase-wake 成功值，`first_push_at` 会一直为空。** plan/research 要求 `completeRunnerReceiptWakePush(result='ok')` 才置时钟，并把它解释为 daemon 接受 `turn/start`；但这个函数记录的是 `wakeRunnerMailbox` 的 push 结果，当前唯一生产 caller 成功时传的是 `"delivered"`，函数自己的 stale-success 分支也只识别 `"verified" | "delivered"`。请用既有真实 outcome（至少 `delivered`）定义 sent，或明确迁移 producer 与所有消费者；测试必须经过 `runner-wake.ts` 的真实调用链，不能直接向 DB helper 注入一个生产中不存在的 `ok`。证据：`engineering/doc/FLY-2248-generic-delivery-contract/plan.md:37,79`；`engineering/doc/FLY-2248-generic-delivery-contract/research.md:181`；`packages/teamlead/src/bridge/runner-wake.ts:184-203`；`packages/flywheel-comm/src/db.ts:3649-3674`。

5. **[HIGH] #3 没有定义全新 `three_stage_turn` 行的首次 generation。** 两条计划内 SQL 只在 `ON CONFLICT ... DO UPDATE` 分支执行 `turn_generation + 1`；当前 INSERT 分支创建新 belt 行。如果新增列采用默认 0 而 INSERT 不显式写 1，首次 `grantTurn` 得到 generation 0，与“+1 由 grantTurn 写入”不一致，也让 legacy-0 与首次真实 grant 无法区分。请规定新 INSERT 写 `turn_generation=1`、冲突换手写 `+1`，并增加“无既有行首次 grant 为 1”的测试；legacy 行升级为 0 的测试继续保留。证据：`engineering/doc/FLY-2248-generic-delivery-contract/plan.md:43,52,108`；`packages/flywheel-comm/src/db.ts:4622-4634,4704-4718`。

6. **[HIGH] #8 仍未同步完成，并留下互斥的迁移/验收合同。** research replay #6 仍要求本轮已删除的 `settled_at`；其告警段仍把 `attempt_id` 定义成旧的 `<family>:<源主键>:g<generation>`，与新的 namespaced root + attempt 序号不符。plan 的迁移标题仍宣称“不重建表”，回滚段仍称“schema 全加法”，但同文明确要求重建 `runner_shutdown_controls`；机制说明一处写 CommDB 4 列，最终 guard 写 5 列。实现者无法同时满足这些文本，A2/A7 也会得到不同预期。请只做文档收口：删除 `settled_at` 断言，统一 attempt-id 公式，把迁移/回滚改成“StateStore 全加法；CommDB shutdown 表受控重建且按备份/恢复边界回滚”，并统一列数为 5。证据：`engineering/doc/FLY-2248-generic-delivery-contract/research.md:60,65,183,195`；`engineering/doc/FLY-2248-generic-delivery-contract/plan.md:138,152,167,174,189`。

## Verdict

CHANGES REQUESTED — address items above
