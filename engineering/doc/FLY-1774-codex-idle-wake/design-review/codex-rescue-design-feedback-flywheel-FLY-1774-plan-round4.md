# Design Review — FLY-1774 plan.md (Round 4)

Date: 2026-08-14
Author: Codex
Status: CHANGES REQUESTED

## Summary

Round 3 的两个原 blocker 已被实质修正：资格来源不再误用 declared-state，mixed snapshot 也已有确定的分组、顺序与 response pointer 合并规则。当前方案仍有三个实现级耐久合同未闭合：跨不同 attempt 的 reuse 没有持久化 dedupe alias，静态 capability 没有与 consumer teardown 做竞态 fencing，且 `session.json` 的字段、失败语义和跨进程寻址尚未定死；因此还不能交给 implement node。

## What's Good (Keep)

- R3-1 的根因判断已纠正：`ctx.phaseKeepAlive` 才是创建 `CodexPhaseLifecycleController`/hold consumer 的 capability，`declare-state park` 不再承担它无法证明的职责；`send.ts:33` 和 goal-complete 直入 hold 的行号/语义也已修正。
- Capability runner 不要求“当前 parked”是正确方向：sweep 只入 durable wake，active turn 不会被打断，下一次 hold 才由唯一注入者消费；这继续满足 I3/I5 和“不 proactive message”。
- R3-2 已关闭：同一事务按最老 LEASED group 优先、QUEUED frontier 最后排序，只覆盖第一组，因而多 LEASED batch + QUEUED 快照已有确定的单值结果；pending wake 合并缺失 response refs、started wake 留给后续 attempt 的规则也与现有状态机可配合。
- I9 已准确改为“新验证 batch attempt 或新 QUEUED sweep frontier”，并承认 eligible-set shrink 也会改变 frontier；新增 mixed-group、跨 attempt response、pending/finished reuse 测试方向正确。
- Fix A 的窄 carve-out、queue-enabled 零 settlement、legacy queue-OFF 自动 ACK 例外、stale envelope typed convergence、真实 lease-redelivery QA、Fix D 部署/监督边界以及无 delivery-time direct RPC 的既有结论继续成立。

## Issues & Recommendations

1. **合同 1 与合同 2 对“不同 attempt 复用同一 wake”仍不相容；当前落库形态不能保证 reused attempt 永久幂等。** `runner_phase_wakes` 一行只有一个 `message_id`，唯一键也只有 `(execution_id, message_id)`（`packages/flywheel-comm/src/db.ts:176-200`）。例如 A 创建 `doorbell:A`，B 在 A pending 时按合同 2 复用 A；即便把 B 的 response ref/member 并入 metadata，表内仍没有 `doorbell:B`。A finished 后，同一 B 的 callback/redelivery/sweep 既找不到 non-finished wake，也无法命中 message-id equality，于是会再插一条，违反“同 `doorbellAttemptId` 永远幂等”，并可能把已合并进 A 的 B 再注入一次。计划必须定义 durable attempt coverage，而不只是 content/member coverage：推荐在每次 reuse 的同一 immediate transaction 中把 B 加入 canonical `coveredDoorbellAttemptIds`，所有 equality 检查同时查询主 `message_id` 与该集合；或者新增唯一 attempt-receipt 表并修订“零 schema 变更”。补精确回归：A pending → B reuse 且 pointer 合并 → A finished → **同一 B** 再 callback/sweep，结果必须 `already_covered`、零新增；另测并发重复 B 只记录一次。

2. **Write-once capability 只能证明“曾配置 consumer”，不能 fence “consumer 仍存活”；detached sweep 与 terminal teardown 可留下 orphan doorbell。** Hook 在前台返回前只启动 detached 子 shell，DB 子任务可在后续继续（`scripts/hooks/runner-stop-notify.sh:139-172`）。与此同时 adapter teardown 会先 `stopIntake()`/drain daemon，再仅用 `updateSessionStatusIfRunning()` 标 terminal（`packages/claude-runner/src/CodexTmuxAdapter.ts:901-1024`）；该 DB 方法只更新 `sessions.status`，不会阻止或清理 phase wake（`packages/flywheel-comm/src/db.ts:5039-5047`）。因此最后一个 turn 的 sweep 可以在 consumer 已停后插入；反向顺序中 sweep 先插入，现 teardown 也不会收走它。`session.json` capability 又没有生产清除者，所以“active capability 入队无 orphan”并不成立。请增加 mutation-time lifecycle fence：sweep 的 immediate transaction 必须验证一个仍 active 的 phase-consumer fact；terminalization 在同一 DB transaction 关闭该 fact并 dispose pending doorbells，使两个顺序都收敛为“要么可消费，要么被清理”。可以复用 `sessions.status='running'`，但必须把 status flip 与 doorbell cleanup 合成一个 helper；也可注册 controller-owned active fact，若需 schema 则更新零迁移声明。补两向竞态测试：shutdown 先 fence 后释放暂停的 sweep → no-op；sweep 先插入后 shutdown → terminal 后零 non-finished doorbell，并覆盖 controlled shutdown 与普通/error teardown。

3. **`session.json` capability 仍是“落点建议”而非可执行的 producer/consumer contract，当前跨包路径会在 override 下分叉。** 现 resolver 位于 `flywheel-claude-runner`，读取 `FLYWHEEL_CODEX_SESSION_DIR` 或默认目录（`CodexTmuxAdapter.ts:190-197`），而新 CLI 属于下游依赖 `flywheel-comm`；后者不能反向 import claude-runner。更直接地，`buildDaemonEnv()` 会洗掉继承的 `FLYWHEEL_*`，随后只显式注入现有清单，并未传 `FLYWHEEL_CODEX_SESSION_DIR`（`:1413-1477`）。所以 adapter 可按 override 写 A 路径，hook/CLI 却按 `$HOME` 读 B 路径；当前 adapter 测试正使用这个 override seam。请在 plan 中选定而不是留给 implement 猜：定义字段名/schema（含 executionId/role 或等价校验），在 `CodexPhaseLifecycleController.start()` 返回前通过现有 atomic merge fail-loud 写入，缺失/损坏在 sweep 侧 fail-closed；并把 resolver 移到双方可依赖的共享包，或明确把已有 session-dir override/精确 state path 传进 daemon/hook 并更新 `buildDaemonEnv` touch surface。补 override 路径的真实 hook→CLI 测试、写失败不得静默启动 phase consumer、malformed/mismatched fact no-op/fail-loud 的明确断言。若采用第 2 项建议把 capability 一并放入 CommDB，则删除这套文件寻址分支并诚实改 schema 声明会更简单。

## Verdict

CHANGES REQUESTED — address items above
