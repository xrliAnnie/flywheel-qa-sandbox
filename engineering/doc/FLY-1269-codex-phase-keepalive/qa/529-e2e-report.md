# FLY-1269 Codex Phase 常驻 — 529 E2E 验收
Issue: FLY-1269
日期: 2026-07-15
基于: plan.md

## Verdict

**PASS**

529 Room 已证明：Codex Design/Implement 在 phase boundary 后保持同一
execution/thread/goal/TUI 常驻；QA 使用 Claude Opus；真实 issue terminal authority 到来后，
两个 Codex controller 走 request/ack shutdown，Claude QA 保持原 direct-close 语义，三段
最终一起收敛，且没有残留 pane、app-server socket 或 CommDB session。

## Acceptance Matrix

| 验收项 | Run | 结果 | 证据 |
|---|---|---|---|
| Codex Design 完成后常驻 | FLY-1286 / FLY-1291 | PASS | `design_done` 后 `phaseHold.state=paused`，同 execution/thread/pane/socket 存活 |
| Codex Implement `needs_review` 后常驻 | FLY-1286 / FLY-1291 | PASS | `awaiting_review` 后 xhigh controller 保持 paused-alive |
| QA 使用 Opus | FLY-1286 / FLY-1291 | PASS | `claude-opus-4-8`，pane 输出 `FLY1269_TARGET10_QA_OPUS_PASS` |
| quiet wait 不消耗 active goal budget | FLY-1286 / FLY-1291 | PASS | FLY-1286 60 秒 freeze；FLY-1291 超过 60 秒仍为同一 paused goal |
| daemon restart + same-session handback + TURN | FLY-1286 | PASS | 同 thread resume，durable wake，TURN 后返工再 park |
| exact-head review / approval / deploy | FLY-1286 / FLY-1291 | PASS | sandbox PR #58；Codex author由 Claude cross-family review；Bridge 结构化批准 |
| issue terminal 三段一起下线 | FLY-1291 | PASS | shutdown request/ack、三段 `completed`、三窗/两 socket/三 CommDB row 全消失 |
| Claude backend 回归不变 | FLY-1291 / package suites | PASS | QA 无 shutdown control，仍走 direct tmux close；完整回归全绿 |

## Full Workflow — FLY-1286

FLY-1286 使用 `xrliAnnie/flywheel-qa-sandbox` PR #58 完成完整链路：

- Design：Codex `gpt-5.6-sol` high；
- Implement：Codex `gpt-5.6-sol` xhigh；
- QA：Claude Opus 4.8。

Design/Implement 在 boundary 后保留原 execution、Codex thread、goal、TUI 与 mailbox
controller。随后覆盖 60 秒 budget freeze、daemon/socket crash + restart、同 thread resume、
durable wake、TURN 交回与同 phase 返工。

PR #58 最终 head 为 `20bac035cf87c54360be2e4a6edd3b0fa6e1c781`。跨家族 review
对 exact head 给出 APPROVED，CI 全绿；真实 approve gate 通过；Runner 只发送 `:cool:`，
deploy workflow 合并为 `7049f7199aa5ebeab72fb1134828941f8191a6d0`。没有运行
`gh pr merge`。

## Terminal Acceptance — FLY-1291

真实 Linear issue：
`7aed2d07-5dd5-45da-b1f9-d2ed8cb9cc56` / FLY-1291，terminal trigger 前通过
Bridge 精确 lookup 确认 state=`Done`。

候选 Bridge head 为 `00453c71b37518ab649a4b3914f85283608284c7`；sandbox PR
head 为 `20bac035cf87c54360be2e4a6edd3b0fa6e1c781`。三段身份：

| Phase | Execution / thread | Runtime identity |
|---|---|---|
| Design | `17fd34e2-69c1-4f45-a710-a0e7c20c33e6` / `019f6703-05bd-7f60-8859-cffed9ab25f5` | Codex high；window `@392`；PID 5550；socket `c9af83d095e4d7c4.sock` |
| Implement | `7b23c718-fbef-4bec-95f3-636f2f093edb` / `019f6703-051b-7b11-92fc-daedc5d54b56` | Codex xhigh；window `@391`；PID 5551；socket `5907e083a465f5c6.sock` |
| QA | `61c4bed3-946f-4dfb-80de-dd15426e236f` | Claude Opus 4.8；window `@390` |

Design 在 18:21:51Z、Implement 在 18:22:06Z 进入 native paused。18:23:20Z 的
二次采样证明两个 `phaseHold` 仍 paused、thread/PID 不变、heartbeat 前进，quiet window
超过 60 秒。真实 boundary 状态分别为 `design_done` 与 `awaiting_review`。

三扇窗口随后故意改名为 `FLY-1291-target10-drifted-{design,implement,qa}`；CommDB
仍保存 immutable `runner-test-slot-2:@392/@391/@390`，证明 teardown 不依赖 mutable
window name。

QA 在 18:24:24Z 发出 exact-head PASS。cross-family review request
`eb737944-82e5-4c03-bdbf-0cb15ecd1fe7` 由 Claude reviewer 审查 Codex author，
18:30:38Z 对 `20bac…` APPROVED。最终 approval question
`100e5623-6d35-44f2-a893-5ac253e25a6d` 由 Bridge 写入结构化
`{"approved":true}`，StateStore 从 `awaiting_review` 转到 `approved_to_ship` 并取得
post-ship finalization claim。

529 机器全局设置 `FLYWHEEL_WORKFLOW_FORCE_LEGACY=1`，而本次 purpose-built run 是手工
seed 的三段 session，没有 legacy `auto_qa_record`。因此 final recovery lap 仅在隔离
test-slot-2 Bridge 设置 `FLYWHEEL_QA_DONE_GATE=0`；真实 Opus PASS、exact-head review、
结构化 founder approval 与 terminal teardown 均未伪造。此 escape hatch 只绕过该 fixture
不可能生成的 legacy record，不替代 QA 行为证据。

## Shutdown Evidence

terminal observer 于 18:54:36Z armed，baseline 同时确认三窗、两个 socket、三个 CommDB
session 都存活。18:54:48Z 开始 terminal DAG，18:55:19Z 收敛：

- Implement request `52af8d89-ca40-45e1-9318-8b51a838c310`：observer 直接看到
  `requested → acked`；其 immutable pane 与 socket 随后消失。
- Design request `2ab8334a-4e48-42d3-b86a-824d46f7bc77`：observer 看到 requested；
  durable `lead_close_runner` event 携带同一个 `phaseShutdownRequestId`。该 event 只会在
  Bridge 读取 matching `acked` 并确认 TUI gone 后产生；adapter 同时以 success 返回。
- QA 没有 `runner_shutdown_control`，沿用 Claude direct close；`@390` 消失。
- StateStore 三行最终均为 `completed`，`merge_block_reason` 已清空。
- CommDB 三个 session 与所有 shutdown controls 已删除。
- `@390/@391/@392` 全不存在；两个 socket 均无 holder。
- Linear finalizer 再次幂等确认 FLY-1291 `Done`。

原始 observer 的最终布尔结果是 false-negative：它要求每个 Codex request **同时**被本地
50ms sampling 捕获为 `acked`，并同时拥有 request-bound close event。Implement 的 ack 被
直接采到，但第一条 cleanup path 后续记为 `alreadyGone`；Design 的 durable request-bound
close event 证明 Bridge 已消费 ack，但该瞬时 ack row 在下一个 sample 前被删除。两条
独立证据合并后覆盖两个 controller；这是 observer predicate 过严，不是产品 teardown
失败。sanitized timeline 固化在 `529-target10-terminal-evidence.json`。

## Immutable tmux Identity Finding

FLY-1286 首次 terminal cleanup 暴露真实缺陷：Codex TUI 会自动改名 window，旧代码按
mutable name kill，造成后台认为关闭但 founder pane 仍可见。修复后：

- TUI 创建后捕获 immutable `window_id`；
- CommDB target 更新为 `session:@id`，不覆盖 lifecycle/review metadata；
- shutdown 两条路径都优先 exact `=session:@id`；
- 仅对旧调用方保留 name fallback。

focused runner tests 75/75、CommDB tests 80/80、完整 `claude-runner` 589/589、隔离 HOME
下完整 `flywheel-comm` 856/856，两个 package typecheck 均通过。

## Excluded Runs

以下 run 只用于发现 fixture/runtime 问题，不计 acceptance PASS：

1. FLY-1287：managed sandbox 拒绝 rotation shim process substitution；未到 thread 创建。
2. FLY-1288：真实 issue 后来被外部取消；terminal authority 正确拒绝。
3. target7：candidate checkout 被 fixture lifecycle 删除，Bridge symlink 指向旧 build；无效。
4. target8：review 与 runtime 共用 sandbox worktree，reviewer cleanup 删除 cwd/panes；无效。
5. target9：phase 常驻与 exact models 有效，但使用 synthetic Linear UUID，terminal
   arbitration 以 `linear_lookup_failed_retryable` 正确 fail-close；不计 terminal PASS。
6. FLY-1291 第一次 completed signal 在 legacy QA gate 上以 `qa_not_passed` 正确拒绝；三段
   保持存活。它用于证明 fail-close，不是 terminal trigger。

## Reproduction Notes

529 使用独立 StateStore `/tmp/flywheel-test-slot-2/teamlead.db`、独立 CommDB
`~/.flywheel/comm/test-slot-2/comm.db` 与 test-slot-2 Bridge。token 未写入 repo。主报告只
保留 execution/thread/request/head 等非秘密审计字段。
