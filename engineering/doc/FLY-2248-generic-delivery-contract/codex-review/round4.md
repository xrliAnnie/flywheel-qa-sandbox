# Design Review — plan.md (Round 4)

Date: 2026-09-02
Author: Codex
Status: CHANGES REQUESTED

## Summary

Round 4 确实减少了机制：阶段血统集中到一张 attempt 表，resident expiry 复用同一 saga，mid-turn 状态复用 `three_stage_turn`，告警也回到既有 outbox。Round 3 的七项方向性问题均有实质回应，但按 Lead 本轮新增的硬规则和当前源码逐项落地后，仍有三个协议阻断，以及若干会造成错误计时、永久 live attempt 或无法执行验收的缺口，尚不能进入实现。

## What's Good (Keep)

- `workflow_delivery_attempt` 取代 2×7 个欠条列、三类跨库动作共用 `workflow_delivery_operation`，机制数量明显收敛。
- rework/carrier/turn_wake/phase_wake 的时钟来源已基本对齐真实状态转移；retry/generation/lease 等可变字段明确禁止充当进度。
- mid-turn 不再新建 execution 级表，而是复用 issue 级 TURN belt；到件分类与 completion promotion 置于同一 CommDB 事务，竞态方向正确。
- resident `enter` 增加 boundarySeq 幂等、reown adopt、本地 hold 失败补偿；expiry 也进入可重放 barrier，而不是一次性跨库调用。
- undeliverable 的用户可见告警已由 reroute outcome 单点拥有；watch 只开 episode，不再抢先发不完整结论。
- A7 已拆成新对象集合、逐表列 delta、二次启动 canonical schema 三类可执行检查，并同时覆盖 StateStore/CommDB。
- loop residency 继续只取 pinned snapshot 的 loop target，未退回 role、节点名或 `shareParentBranch`。
- 22 个 hold shape、双向 inventory、前置条件阴阳测试和 8 起事故回放仍保持完整。

## Issues & Recommendations

1. **[BLOCKER] `workflow_delivery_attempt` 不满足 Lead 明确要求的“append-only ledger”。** 当前设计是一行一个 attempt，随后用 `UPDATE ... WHERE col IS NULL` 写阶段时间、在完成时写 settlement、改派时回写旧行的 `superseded_by_attempt_id`；部分唯一索引也依赖这些更新。这是保留历史的 mutable lifecycle row，不是 append-only。仓库里真正的 append-only 表用 `BEFORE UPDATE/DELETE` trigger 拒绝修改，因此这里不是术语差异而是可机器观察的不同合同。请先固定唯一解释：若 Lead 的意思是“generation 只追加、IOU 表不改、attempt 行允许 set-once CAS”，必须把硬规则改成这句并增加禁止覆盖非空值/删除行的测试；若要求字面 append-only，则需把同一张表改成逐事件 INSERT 的形状并从事件派生当前 attempt，不能继续依赖上述 UPDATE。不要在实现期自行选择。证据：`engineering/doc/FLY-2248-generic-delivery-contract/plan.md:67-80,94-98,144`；`packages/flywheel-comm/src/db.ts:1172-1177`；`packages/teamlead/src/StateStore.ts:20794-20802`。

2. **[BLOCKER] 中央 attempt identity 对 CommDB 家族仍不唯一，也没有闭合原始行到 reroute child 的血统。** `phase_wake` 用每个项目 CommDB 各自自增的 `queue_seq` 作 root，但 attempt 表在中央 StateStore，两个项目的 `queue_seq=1` 会撞同一 `(root_contract_id,generation)`；其他 CommDB 主键也没有声明全局唯一保证。正常 mailbox/phase/turn 写入不会同时写 StateStore，baseline 又只覆盖 rework/carrier/land/gate_holder（还漏了旧 open launch），所以 incident #2 的“首次投影即 undeliverable”可能根本没有 g1 attempt，`MAX(generation)+1` 会把第一次 reroute 错铸成 g1。并且 reroute child 的物理 id 已改变，按 §1 的“family + source PK”公式会被 source 当成新 root，而不是原 root 的 g2。请给 CommDB roots 加稳定 project namespace；明确无 attempt 的原始行如何确定/物化 g1；明确 child 通过 `contract_ref_json`/envelope 回到原 root 的投影规则；baseline 补齐全部 StateStore 家族。增加“两项目相同 queue_seq 不冲突”和“无 attempt 的原始 mailbox 第一次 reroute 得到同 root 的 g2”测试。证据：`engineering/doc/FLY-2248-generic-delivery-contract/plan.md:35-36,67,78-84,95-98`；`engineering/doc/FLY-2248-generic-delivery-contract/research.md:58,178-181`；`packages/flywheel-comm/src/db.ts:175-176`；`packages/teamlead/src/bridge/plugin.ts:4537-4583`。

3. **[BLOCKER] 复用 `three_stage_turn` 的方案没有覆盖旧行初始化与 TURN 换手，按现有 SQL 会永久卡住。** 计划新增的是 nullable `turn_generation INTEGER`，却用 `turn_generation = turn_generation + 1`；所有升级后的既有行从 `NULL` 加一仍为 `NULL`。同时 `grantTurn` 的两个现有 upsert 只覆盖 holder/epoch/activation 等列，不会清除未来的 `active_turn_id`：旧 holder mid-turn 时发生 re-grant/manual handoff，新 holder 会继承旧 turn，自己的 `onTurnStarted` 因 `active_turn_id IS NULL` 条件永远失败。接口也未说明重复 `turn/started` 如何幂等取得同一 generation，或重启后的 `onTurnCompleted` 从哪里取得 SQL 中的 `g`。请使用 `NOT NULL DEFAULT 0` 或 `COALESCE`；把两条 `grantTurn` upsert 的 active-turn 收口写入同一事务（同时处理旧 generation 的 deferred wakes）；定义 same-turn replay、different-active-turn fail-closed 及 generation 返回/查询合同。测试必须覆盖 legacy NULL 行、active 中换 holder、重复 started、重启后无内存 generation 的 completed。证据：`engineering/doc/FLY-2248-generic-delivery-contract/plan.md:42-43,51,107`；`packages/flywheel-comm/src/db.ts:91-101,1182-1205,4597-4634,4701-4718`；`packages/claude-runner/src/codex-daemon-client.ts:749-814`。

4. **[HIGH] phase-wake 的 set-once `first_push_at` 写点在 plan 内自相矛盾。** M1 说在首次 push claim 时写，但负向守卫又要求 claim/release/retry 不改变任何阶段时钟；claim 只证明取得 lease，进程可在物理投递前崩溃。现有代码也把 claim 与完成 push 分成两个明确边界。请把 `first_push_at` 固定在 `completeRunnerReceiptWakePush` 的已定义投递结果上，并明确哪些 outcome 算 sent；claim 继续只写 `last_push_at`/lease/retry 字段。测试增加“claim 后崩溃仍为 minted、完成一次 push 后 set-once、重试不覆盖”。证据：`engineering/doc/FLY-2248-generic-delivery-contract/plan.md:78,80,174`；`packages/flywheel-comm/src/db.ts:3575-3646,3649-3668,5436-5472`。

5. **[HIGH] `superseded_by_completion` 分支没有写 `settled_at`，会留下一个永久 live attempt。** 正常 `wake_delivered` 分支明确写 `settled_at`，但 pending/turn_granted/awaiting_receipt/replacement_pending 分支只写 `settlement_reason`；部分唯一 live 索引只看 `superseded_by_attempt_id IS NULL AND settled_at IS NULL`，因此欠条虽已 completed，该 attempt 仍占用唯一 live 槽。research replay #6 又要求 `settled_at` 非空，三处合同不一致。请在同一完成事务中同时 set-once `settled_at=completionAt` 与 `settlement_reason='superseded_by_completion'`，并断言完成后不存在 live attempt、幂等 replay 不改时间。证据：`engineering/doc/FLY-2248-generic-delivery-contract/plan.md:23,67,94,144`；`engineering/doc/FLY-2248-generic-delivery-contract/research.md:183`。

6. **[HIGH] resident-expiry 对现有 shutdown primitive 的幂等假设不成立。** `runner_shutdown_controls` 以 `execution_id` 为主键；`requestRunnerShutdown` 的 `INSERT OR IGNORE` 后按 execution 读取并直接返回，若已有另一 requestId 的 requested/acked/failed 行，它不会证明计划中的确定性 `resident-expiry:<exec>:r<rev>` 已落库。尤其旧行为为 failed 时，每 tick 重调同一函数也无法创建新请求，expiry saga 可永久停住。请在 barrier 中校验返回的 `request_id`，并定义并发既有控制的处理：adopt 仍 requested 的权威 shutdown、对 acked 先验证进程已退出、对 failed 明确转 failed/operator 路径；不能把不同 requestId 当成本 operation 的 applied receipt。增加三种既有状态的冲突测试。证据：`engineering/doc/FLY-2248-generic-delivery-contract/plan.md:51,112,147`；`packages/flywheel-comm/src/db.ts:230-237,4240-4307`。

7. **[HIGH] A7 的“exact new-object allowlist”仍缺少可比较的对象定义。** §3 只给了索引表达式，没有稳定 index 名；SQLite 还会为 TEXT PRIMARY KEY/UNIQUE 生成 `sqlite_autoindex_*` 行。若直接比较 `sqlite_master(type IN ('table','index'))`，实际集合不会等于当前表格；若过滤内部索引，计划也没有写过滤条件。机制守卫中的四个 alert prefix 也不是 schema，不能由 A7(a)(b) 自动证明。请写出 canonical 查询（包括是否排除 `sqlite_%`/`sql IS NULL`）、给所有显式索引命名并列出精确期望集合；alert-prefix 另做 added-line/export allowlist 测试。证据：`engineering/doc/FLY-2248-generic-delivery-contract/plan.md:25,139-151,172,176`。

8. **[HIGH] research 仍不是 Round 4 的单一事实源。** §1.4 仍要求给两个 IOU 表加 `consumed_at`；§3.2 仍要求把 `settlement_reason` 放在 IOU 表；launch 行还明确说“不用 delivery_attempt”，与 plan 的 StateStore-family attempt 时钟相反。§1.5 的 episode DDL 仍用旧 `contract_id`、没有 `attempt_id/root_contract_id`；replay #1/#4 的 uid 又漏掉 `:g1`。R5 仍要求记录迁移耗时，而 Lead/plan 已删除该要求。由于 M0 fixture、source mapping 和 A7 都会从这些段落取规范，这会让实现者得到两套合法答案。请同步 §1.2/§1.4/§1.5/§3.2/§5/§6，并加一个文档/fixture consistency test 固定 root、attempt、settlement owner 与 schema delta。证据：`engineering/doc/FLY-2248-generic-delivery-contract/research.md:29-36,49-53,60-73,124-129,178-183,195`；`engineering/doc/FLY-2248-generic-delivery-contract/plan.md:36,41-42,65-80,94,137-151`。

## Verdict

CHANGES REQUESTED — address items above
