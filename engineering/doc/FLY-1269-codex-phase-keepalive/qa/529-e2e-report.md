# FLY-1269 Codex Phase 常驻 — 529 E2E 验收
Issue: FLY-1269
日期: 2026-07-15
基于: plan.md

## Verdict

**PENDING — terminal close observation is still running.**

本报告把两类证据分开：FLY-1286 证明完整三段工作流、返工、审查、QA、审批与真实
deploy；FLY-1288 在修复 tmux identity 后，专门证明 founder pane 即使被运行时改名，
issue terminal 仍能用 immutable window id 把三段一起收敛。任何 harness、认证或治理
前置条件未满足的尝试都列在 Excluded Runs，不计入 PASS。

## Acceptance Matrix

| 验收项 | Run | 结果 | 证据 |
|---|---|---|---|
| Codex Design phase 完成后常驻 | FLY-1286 / FLY-1288 | PASS | 同 execution、thread、goal 进入 `phaseHold.state=paused`，founder pane 与 socket 仍存活 |
| Codex Implement `needs_review` 后常驻 | FLY-1286 / FLY-1288 | PASS | Implement xhigh 在 handoff 后保持 paused，可由 mailbox/TURN re-engage |
| QA 使用 Opus | FLY-1286 / FLY-1288 | PASS | `runnerModel=claude-opus-4-8`；FLY-1288 pane 输出 `FLY1269_QA_OPUS_PASS` |
| 等待不消耗 active goal budget | FLY-1286 | PASS | 60 秒 hold freeze 前后 active/hard deadline remaining 不减少 |
| daemon transport restart 后同 goal 恢复 | FLY-1286 | PASS | 同 thread/goal 在 socket crash/restart 后恢复 paused，再接受 exact wake turn |
| handback 先过 TURN | FLY-1286 | PASS | wake queue durable 入队，同 execution 恢复后先获 TURN 才继续返工 |
| 真实 review / CI / approval / deploy | FLY-1286 | PASS | sandbox PR #58，review round 7 APPROVED exact head，CI green，verify-approval 通过，`:cool:` workflow 合并 |
| issue terminal 三段一起下线 | FLY-1288 | PENDING | immutable `@257/@258/@261` observer 已 armed；等待 fresh exact-head review/approval 后触发 |
| Claude backend 回归不变 | package suites | PASS | Claude close path 仍直接 kill；相关 Teamlead/runner 回归与完整 package suite 全绿 |

## Full Workflow — FLY-1286

529 Room 的完整链路使用 sandbox issue FLY-1286 与
`xrliAnnie/flywheel-qa-sandbox` PR #58：

- Design：Codex `gpt-5.6-sol` high，exec
  `464064c0-a711-4aa7-9426-5633dcef590d`。
- Implement：Codex `gpt-5.6-sol` xhigh，exec
  `1ba0f0f1-928c-4aaa-aa5f-5782a54a37ad`。
- QA：Claude Opus 4.8，exec `aad2f2a7-ad02-4e34-b933-7ae539af1dfa`。

Design 与 Implement 在 phase boundary 后没有退出；两者保持原 execution、Codex thread、
goal、TUI 和 mailbox controller。测试随后覆盖 60 秒 budget freeze、daemon/socket crash +
restart、同 thread resume、durable wake、TURN 交回与同 phase 返工。

PR #58 最终 head 为 `20bac035cf87c54360be2e4a6edd3b0fa6e1c781`。跨家族 code
review round 7 对该 exact head 给出 APPROVED；CI 全绿；真实 approve gate 经
`verify-approval` 确认；Runner 只发送 `:cool:`，由 deploy workflow 合并，merge commit
为 `7049f7199aa5ebeab72fb1134828941f8191a6d0`。没有运行 `gh pr merge`。

## Runtime Finding — tmux Name Is Not Identity

FLY-1286 第一次观察 terminal cleanup 时发现一个真实缺陷：Codex TUI 会把 tmux window
自动改名为 `zsh`。旧 teardown 按 mutable name kill，因而错过仍活着的 founder pane；
Bridge 却可能已经收到 controller ack，造成「后台认为关了、cmux 仍可见」。这次失败
没有计作验收通过。

修复把 founder pane identity 固定为 tmux 的 immutable `window_id`：

- 创建 TUI 后捕获 `@<number>`，并把 CommDB target 更新为 `session:@id`；
- shutdown 两条路径都优先 kill exact `=session:@id`；
- 只保留 window name 作为旧调用方的兼容 fallback；
- CommDB target 更新只改 tmux target，不覆盖 lifecycle/review metadata。

TDD 的 RED 精确表现为两个失败：name drift 后 pane 仍活着、CommDB 仍保存 mutable name。
修复后 focused runner tests 75/75、CommDB tests 80/80、完整 `claude-runner` 589/589、
完整隔离 HOME 的 `flywheel-comm` 856/856，两个 package typecheck 均通过。

`flywheel-comm` 在默认 HOME 下另有 16 个 claims tests 因机器全局
`FLYWHEEL_WORKFLOW_FORCE_LEGACY=1` 失败；同一 repo 在隔离 HOME 使用产品默认配置时
856/856 全绿，因此该机器级 legacy override 不属于本分支回归，也没有为测试修改它。

## Immutable-ID Terminal Proof — FLY-1288

候选 build 为 scratch head `ccc743e6536a7229e7f7ef0a74473ca750aeac4f`，包含主分支
identity fix。该 run 使用：

- Design exec `d9390f61-7d53-4dc2-8c4c-f8ce4f5f46fb`，Codex high，thread
  `019f6693-03f6-7c90-b9f9-d6edbcd789c8`，window `@257`；
- Implement exec `2bac8250-f4c7-4e8b-ac80-ace4cead0b91`，Codex xhigh，thread
  `019f6693-041d-7962-b27d-f4b471cc4e9a`，window `@258`；
- QA exec `b59560a1-1c2e-40d8-97a2-3093b9c65cc6`，Claude Opus 4.8，window
  `@261`，pane 输出 `FLY1269_QA_OPUS_PASS`。

Design/Implement 的 `phaseHold.state` 均为 `paused`；两个 Codex socket 存活；CommDB
保存 `runner-test-slot-2:@257`、`:@258`、`:@261`。随后故意把三扇窗口改名为
`FLY-1288-drifted-design`、`-implement`、`-qa`，而 CommDB immutable target 不变。
terminal observer 在触发前确认三扇窗全部存在。

最终 terminal close 结果：**PENDING**。

## Excluded Runs

以下尝试只用于发现测试或产品缺陷，明确不计作 acceptance PASS：

1. FLY-1287 在 thread 创建前失败：QA 外层 managed sandbox 拒绝 rotation shim 的
   process substitution，报 `/dev/fd/62: Operation not permitted`。FLY-1288 的 harness
   仅为本次 QA 改用 raw authenticated Codex binary；生产接线仍保留 rotation shim。
2. FLY-1288 第一次从 QA exec 触发 terminal 时，被治理层以
   `codex_review_not_approved` / `merge_without_approval` fail-closed。该 fresh exec 没有
   exact-head cross-family review binding，因此三段正确地继续常驻，没有被误清理。
3. fresh Implement review round 1 因隔离 `CLAUDE_CONFIG_DIR` 没有登录态返回
   `Not logged in`。修复临时 reviewer 认证后使用新 gate、新 request 重新审查；失败的
   question/job 保留审计，不复用。

这些排除项也解释了为什么不能拿 FLY-1286 已有的审批文字直接授权 FLY-1288：review
和 approval 都必须 execution + exact head 绑定，terminal finalizer 应继续 fail-closed。

## Reproduction Notes

529 harness 使用独立 StateStore `/tmp/flywheel-test-slot-2/teamlead.db`、独立 CommDB
`~/.flywheel/comm/test-slot-2/comm.db` 与 test-slot-2 Bridge。API/ingest token 未写入本
报告或 repo。terminal observer 在 Bridge 发出 issue-terminal close 前启动，判定条件为：

1. 三个 target CommDB session row、shutdown control 与 shared TURN row 清除；
2. StateStore 三个 session 保留 audit history，但状态全为 `completed`；
3. immutable windows `@257/@258/@261` 均不存在；
4. 两个 Codex socket 与 daemon 均不存在。

StateStore audit row 的保留是预期语义，不应误判为 teardown 泄漏。
