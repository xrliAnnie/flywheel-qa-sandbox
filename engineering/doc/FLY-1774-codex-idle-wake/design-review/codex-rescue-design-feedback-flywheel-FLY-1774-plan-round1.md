# Design Review — FLY-1774 plan.md (Round 1)

Date: 2026-08-14
Author: Codex
Status: CHANGES REQUESTED

## Summary

现有 `RunnerMailboxLane → codex-teams JSON → CodexMailboxWatcher → runner_phase_wakes → hold loop → reactivateWake` 链路真实存在，修复两处断链且不增加 delivery-time direct RPC 的总体方向可行。当前计划仍不能直接交给 implement：Fix B 忽略了数据库唯一索引和绑定入队的自动 ACK 副作用，Fix B/C 的去重与 sweep 合同也不足以证明不会产生双注入、陈旧唤醒或错误 ACK；Fix A 则低估了实际状态爆炸半径。

## What's Good (Keep)

- 保留单一注入者（daemon hold loop），外部 lane/sweep 只持久化 wake；这与现有 `reactivateWake()`、`phaseHold` 生命周期一致，也避免双客户端 RPC 竞态。
- 不新增 delivery-time direct-RPC 腿是正确的。watcher 在 `confirmHoldPaused()` 后启动并立即首扫，hold loop 最长约 15 秒观察一次；修通既有链即可覆盖“先停驻、后来信”和“进 hold 前已落 JSON”两种顺序。
- 非 `phaseKeepAlive` runner 没有可救的 resident hold，goal-terminal 后仍交给 teardown/dead-letter；这个范围边界准确。
- 量化的 60 秒真机验收、before/after 复现、active-goal 阴性对照、Claude 对照组，以及不改 config.toml notify argv 的发布思路都值得保留。
- 已核对本地 `main`/`origin/main`（`59e8bd645`）：`resolveRunnerRecipientState()` 仍使用现有 `TERMINAL_STATUSES`，FLY-1731 尚未把 Fix A 落入 main；JIT rebase/reconcile 条款应保留。现有 FLY-1731 计划的相邻改动主要是 question admission/presentation，并非本函数。

## Issues & Recommendations

1. **Fix B 按现文不可实现，并会违反 I1“自动腿绝不 ACK”。** `runner_phase_wakes` 除了查询级去重，还有 `idx_runner_phase_wakes_source` 唯一索引 `(execution_id, source_instruction_id) WHERE source_instruction_id IS NOT NULL`（`db.ts:253-255`）；因此仅把 batch 查询改为按 `message_id` 去重，第二次重投仍会在 INSERT 时触发唯一约束。更严重的是，`enqueueRunnerPhaseWake()` 对任何非空 source 在同一事务中执行 `UPDATE mailbox SET state='ACKED' ... type='instruction'`（`:2712-2720`），现有测试 `db.test.ts:1245-1265` 也明确把它定义为“queues ... and claims its instruction”。若 batch source 取首成员，watcher 会替 agent ACK 首条 instruction，而其余成员仍 LEASED，直接破坏批级 ACK 和租约语义。另一个精度问题是 `metadata.memberIds` 来自 `MailboxRow.delivery_id`（`runner-mailbox-lane.ts:188`），而 `mailbox.id` 与 `delivery_id` 是独立唯一列；不能未经 canonical mapping 就把 memberId 当作 `mailbox_message_projection.id`。建议在计划中明确一个 batch 专用的事务边界：按 `delivery_id` 解析并校验 canonical mailbox 行、同一 batch/recipient/owner/state，插入 wake 时绝不修改 mailbox settlement；同时选择并写清 source 唯一性方案（例如迁移为“同 source 仅 pending/started 唯一”的 partial index，或 batch source 置 NULL 并另行定义 active-wake identity）。若改索引，必须补 up/down/rollback 与存量库测试，不能继续声称“无 schema 变更”。

2. **“batch 仅按 message_id 去重”不足以防双注入，计划对消费侧的论证不成立。** `CodexPhaseLifecycle.observe()` 取最早的非 finished wake（`codex-phase-lifecycle.ts:287-301`）；一次成功 `reactivateWake()` 会 finish 当前行并离开 hold（`codex-daemon-client.ts:914-930`），不会清理同一义务的第二条 pending wake。若租约重投在旧 wake 仍 pending/started 时创建新 message id，旧行恢复成功后新行会残留，并在下一次 hold 注入一条陈旧 turn；`[phase-wake <id>]` 的 runner 幂等合同也帮不上忙，因为两次 batch attempt 的 id 不同。正确合同应是：同 envelope id 永远幂等；同一稳定 source/member-set 已有 pending/started wake 时复用，不新增；只有前一 wake 已 finished 且 mailbox 仍未 ACK、发生新的租约投递 attempt 时才允许新 wake。把检查与 INSERT/CAS 放进一个事务，并补齐 old=pending、started、finished 三态、并发 callback、以及“下一次 hold 无残留 stale wake”的测试。

3. **Fix C 的 sweep 合同与当前 API、消息类型和竞态都不闭合。** 按计划“绑定最老未 ACK 行”调用当前 `enqueueRunnerPhaseWake()` 会触发上述自动 ACK；若保留现有 source 去重，已有 finished wake 又会让 sweep 永远入不了第二条，两者均与正文语义冲突。查询也不能只用 `to_agent + QUEUED/LEASED`：必须至少限定 `recipient_kind='runner'`、`carrier='inbox'` 和真实可读/未过期谓词；response 行应执行 `flywheel-comm check <questionId>`，而 `inbox` 只读取并 ACK instruction（`UNREAD_INSTRUCTIONS_SQL`、`commands/inbox.ts:24-32`），所以 response-only mailbox 不能生成通用 “run inbox” doorbell。建议新增一个专用、原子的 `enqueueRunnerWakeSweep`/等价 DB helper，在同一事务中完成“存在 eligible unread instruction + 无覆盖中的 wake + 插入不带 settlement 副作用的合成 wake”，并约束 CLI 只能作用于环境绑定的 `FLYWHEEL_EXEC_ID`（显式 debug override 另行处理）。测试需增加：两个 detached sweep 并发只入一条、scan 后 agent ACK 最多留一条无害 stale wake、response-only 不误唤醒、已有 pending/started/finished wake 的各态行为，以及 Claude Stop/StopFailure 分支绝不运行 sweep。当前“竞态可容忍”只论证了 read→ACK 窗口，没有证明并发幂等或不会形成连续 turn-end 自唤醒循环。

4. **Fix A 的 blast radius 与 I7/QA 矩阵写错了。** 当前 `TERMINAL_STATUSES` 包含 `approved/rejected/deferred/shelved/awaiting_review`；`WAKE_TERMINAL_STATUSES` 不仅排除 `awaiting_review`，也刻意排除 `approved/rejected/deferred/shelved`（`operational-terminal-status.ts:15-29`，对应测试 `:21-26`）。直接换集合会让这四个 outcome 状态也从 instant-DEAD 变为可投递/最多延迟约 90 分钟后 DEAD，因此“instant-DEAD 仅限 OUTCOME-terminal”和“除 awaiting_review 外只跨 vendor”都不成立，现有“OUTCOME 仍 DEAD”测试描述也会失败。grep 未发现任何消费者按 `awaiting_review` 或 `recipient_terminal` 的来源状态分支；消费者只处理通用 DEAD/dead-letter notice，所以风险是死信产生时机和本不该唤醒的 outcome runner，而不是下游 schema 兼容。最小范围修复应只从 mailbox recipient 判定中 carve out `awaiting_review`（`design_done/ship_parked/approved_to_ship` 本来已 alive）；若团队确实要复用 WAKE 集合，则必须逐项声明并验证四个新增 alive 状态、跨 vendor 行为、teardown 后 90 分钟窗口及 owner dead-letter 通知，并改写 I7。

5. **Fix D 与测试/发布细节还需写实。** `runner-stop-notify.sh` 同时服务 Codex notify 和 Claude Stop/StopFailure；自动部署默认 allowlist、模块头注释及 `sync-flywheel-hooks.test.ts` 多处断言目前都假设只有 `inbox-check.sh`，不能只改 `HOOKS_TO_DEPLOY` 一行。现有 12 秒 watchdog 监督的是单个 `runner-stopped` child；若只在其后追加 sweep，必须明确把两个命令包在同一受监督的 child process group 中，或分别建立有界监督，否则“复用 12s watchdog”不成立。还应定义 `runner-stopped` 耗尽预算时 sweep 是允许跳过还是需要独立预算。最后，Bridge hook sync 是 soft-fail、只记日志（`sync-flywheel-hooks.ts:425-440`、`plugin.ts:4304-4328`），所以它能修复正常部署漂移，但不能宣称彻底消除静默失效；至少补默认双 hook 的安装/权限/原子替换测试与可观察的 degraded 说明。

6. **租约兜底 QA 应验证真实失败状态，而不是靠删耐久 wake 行制造成功。** “hold 前删 wake 行”绕过了本设计最关键的 source/index/state 约束，也无法证明 callback failure、watcher 未 ACK JSON、旧 wake pending/started 等生产形态能收敛。建议用可注入的 watcher callback failure/暂停消费来保留真实 CommDB 与 codex-teams 状态，缩短 `ackLeaseMs` 后验证：首次未形成可消费 wake → 原批回 QUEUED → 新 attempt 投递 → 恰一条可消费 wake → agent ACK；同时保留 frozen-resend 同 envelope id 的阴性用例，避免把已知幂等洞误写成可靠性保证。

## Verdict

CHANGES REQUESTED — address items above
