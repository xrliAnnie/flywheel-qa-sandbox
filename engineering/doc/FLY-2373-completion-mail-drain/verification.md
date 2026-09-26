# FLY-2373 完工消息排空 — 实施验证记录
Issue: FLY-2373 (https://linear.app/geoforge3d/issue/FLY-2373/病根-完工-drain-与中途延后门铃互锁codex-体在一个-turn-里轮询等-lead-答案-deferred-midturn)
日期: 2026-09-26
基于: plan.md（含 §11 Lead 裁定修订）

本记录只覆盖**本地定向验证**。它不是全量 CI，也不是 QA：真实 Codex 长 turn、真实 529 房、Claude 体端到端回归均属下游 QA（plan §9 Q1–Q7）。

## 实现映射
| plan | 实现 |
|---|---|
| T1 义务与消费 | `flywheel-comm/src/completion-obligations.ts`（词汇、digest、分页）；`db.ts`：`runner_content_consumption` / `runner_wake_settlement`、`consumeGateResponse` 与 `consumeRunnerInbox` 同事务签凭据、`resolveCompletionObligations`、`acknowledgeCompletionDrainRead`、`settleCompletionWakes`（savepoint）、`reapplyCompletionWakeSettlement` |
| T2 当前 turn 返回/确认 | `teamlead/src/bridge/completion-drain.ts`（proof、409 v2、`runSemanticCompletionDrain`）；`event-route.ts`（锁内重算、`/events/completion-drain/page` 与 `/ack`）；CLI `complete`（完整解析、退出码 3、无 FAIL-CLOSE、pending 记录）、`inbox --drain-page / --ack-consumed` |
| T3 结算/并发 | `StateStore`：v2 read envelope 列、`issueDrainChallenge` v2、`getDrainReadEnvelope`、`markDrainReadPageServed`、`consumeDrainChallengeTx` 改收 server proof（删除 started/finished 条件）、`listCompletionDrainProofs`；replay 补结算 |
| T4 等待/兼容 | `codex-runner-contract.md` v4；`Blueprint.ts` CODEX GATE WAIT LAW 与 gate 文案；`complete --route blocked` 拒绝文案 |
| retention | `scripts/lib/fly-2006-retention-tables/comm/runner_content_consumption.json`、`runner_wake_settlement.json`（protectedCurrentOrAuthority） |

## 本地命令与结果（机器负载 load avg 120–190）
- `pnpm lint`：exit 0（25 个既有 warning，均不在改动文件内）。
- `pnpm --filter "flywheel-teamlead..." --filter "flywheel-edge-worker..." --filter "flywheel-claude-runner..." build`：exit 0。
- `pnpm --filter "...flywheel-comm" --filter "...flywheel-teamlead" typecheck`：exit 0（comm、teamlead、edge-worker、claude-runner、inbox-mcp、terminal-mcp、voice-codex；voice-codex 先单独构建 voice-bridge）。
- flywheel-comm，plan §9 清单 + 直接消费者：`completion-obligations`、`completion-drain-cli`、`complete`、`db.fly2268`、`db.fly1774`、`receipt-wake-state-machine`、`mailbox-settlement`、`commands`、`gate`、`gate-noblock`、`gate-codex-marker`、`founder-review-state-reader` → 12 files / 238 tests passed。
- flywheel-comm `vitest related src/completion-obligations.ts src/commands/completion-drain.ts src/commands/inbox.ts src/commands/complete.ts --run`：80 files 中 74 passed；6 个失败文件（cli、db.fly2268、e2e-workflows、adopt-inflight、qa-result-lock、qa-result.realgit）全是子进程超时或负载下 `[slow-sql]` 写入 stderr，用 `--testTimeout 120000 --maxWorkers 2` 单独重跑 6 files / 99 tests 全部通过。`db.fly2268` 的并发 writer 用例在 runner TMPDIR 下 HEAD 版 db.ts 同样失败，`TMPDIR=/tmp` 下通过（环境性）。
- teamlead 直接消费者：`completion-drain-v2`（新增，真实临时 CommDB + StateStore）、`completion-drain`、`event-route`、`StateStore.generalized-execution`、`fly2268-replay`、`event-route-session-completed-guard`、`fly2268-mechanism-guards`、`fly-2006-database-retention-sweep`、`fly-2413-retention-migration`、`fly-2413-retention-registry`、`commdb-fly2268-preflight`、`complete-marker-reconciler`(+integration)、`event-route-dual-session-completed.integration`、`fly2268-resident-expiry` → 15 files / 400 tests passed；其余 `commitEnrolledCompletion` 调用方 16 files / 530 passed（1 skipped）；`event-route.fly1427-terminal-immunity.integration` 4 passed。`event-route.test.ts` 在默认 5s 超时下有 4 个既有 git/PR 用例超时，放宽超时后通过。
- edge-worker `vitest related src/Blueprint.ts --run`：29 files / 353 tests passed。
- claude-runner：`codex-home`、`fly2268-resident-receiver` 204 passed；`codex-phase-lifecycle`、`codex-daemon-client` 108 passed。
- shell：`agent-visibility-rules.test.sh` 通过；`fly1674-residue.test.sh` PASSED=85 FAILED=0；`node --test scripts/__tests__/teamlead-shards.test.mjs` 9/9。

## 负向对照（删掉守卫必须变红）
check 凭据、turn 输入去重、历史 ACK 不算已读、inline 凭据绑定 activation、结算置 finished、完工锁内提交（去掉 IMMEDIATE 锁）、结算 savepoint（两条 wake 中第二条失败）——每个变体都让对应用例失败，恢复后全绿。

## 消费者发现与排除
按改动文件完整路径、文件名、目录及新符号 `git grep -lF`：
- `db.ts`、`StateStore.ts`、`event-route.ts`、`Blueprint.ts` 为枢纽模块，related 会扩散到近乎全包；按直接调用方（上列）选测，未跑全包。
- `scripts/__tests__/package-onboard-smoke.test.sh` 只检查 `codex-runner-contract.md` 文件存在，路径未变，排除。
- `packages/teamlead/ci-test-costs.json`：新测试文件按 unknownFileMs 走 parallel，分片测试通过，未登记。
- `scripts/lib/fly-2006-retention-*`、`fly1645-receipt-residue-gate.config.json`：由 retention 测试与 fly1674 覆盖。

## 未做 / 交下游
- 进程级本地冒烟（真实 dist CLI 对本地假 Bridge）第二次尝试被权限拒绝，未再执行；CLI 行为由 mock fetch 单测覆盖，真实链路交 QA。
- 真实 529 房 Codex 长 turn（Lead send + 复审判决）、未读负向、Claude 回归、race/restart：plan §9 QA 矩阵，未在本节点执行。

## 事故披露
第一次本地冒烟在 zsh 下用了未加引号的 `env $ENVS`，zsh 不分词，其余变量继承了本 runner 的真实环境，导致两次 `complete --route needs_review --pr 9` 发到真实 Bridge：teamlead.db `session_events` 多出 2 行（event_id `4c120b3e-f948-4f7a-a4ee-31a55a3b0a70`、`b6d40291-b08e-4d8d-8314-1c9ace90883f`，execution_id 为畸形串，issue FLY-2373）。只读核查：无 session 行、无 lead_events、CommDB 无残留，本执行会话未受影响。已向 Lead 报告（7399aa69-4866-4657-bf07-0db96f57cacd），未改生产库。

## 代码评审 R1 修订后的复验
按 plan §11.1 修复后逐文件复跑：comm `completion-obligations`(26)、`completion-drain-cli`(7)、`complete`(74)、`db.fly2268`(22)、`db.fly1774`(16)、`receipt-wake-state-machine`(24)、`mailbox-settlement`(5)、`commands`(25)；claude-runner `codex-daemon-client`(85)、`codex-phase-lifecycle`(23)、`fly2268-resident-receiver`(9)；teamlead `completion-drain-v2`(7)、`StateStore.generalized-execution`(73)、`event-route`(109) 全部通过。新守卫负向对照：去掉 drain_settled 的 dispose、去掉 started 根、放宽 source_missing 满足判定，各自让对应用例失败。

## 代码评审 R2 修订后的复验
按 plan §11.2 修复后逐文件复跑：comm `completion-obligations`(27)、`completion-drain-cli`(9)、`complete`(74)、`db.fly2268`(22)、`db.fly1774`(16)、`receipt-wake-state-machine`(24)、`mailbox-settlement`(5)、`commands`(25)、`db.fly2517-wake-retirement`(20)、`db`(86)；claude-runner `codex-daemon-client`(85)、`codex-phase-lifecycle`(23)、`fly2268-resident-receiver`(9)、`CodexTmuxAdapter`(166)；teamlead `completion-drain-v2`(7)、`StateStore.generalized-execution`(73)、`event-route`(110，含 ship carrier 409→page→ACK→重试)、`fly2248-r6-projector-recovery`(7)、`fly2517-rework-wake-retirement`(31) 全部通过。负向对照：去掉 replay 的 in-flight 标记、去掉 in-flight 义务，各自让用例失败。

## QA@1 返工（rework epoch 4，implement attempt 2）
QA（exec 76d62fb3）判 FAIL 的唯一原因：冻结头 990f852 的 exact-head CI（run 36237702537）Unit teamlead 4/4 中 `lead-token-savings-drift.test.ts` 5 个失败——`fly2567/compatibility.json` 钉住的 `packages/flywheel-comm/src/db.ts` 哈希漂移。行为验收在 529 slot 3 全部通过（A1–A4），本轮不改产品代码。

- 逐 hunk 审计 db.ts：8 个 hunk（import、schema、类型、WAKE_ID 常量、drain 方法块、claim、consumeGateResponse）都不触及 `getPendingQuestions`、待答问题的选择/排序/分页/载荷、token-savings 模式选择或任一 bootstrap generator；在 bootstrap-generator 对的 rationale 追加 FLY-2373 说明并更新 db.ts 哈希 → 17/17 通过。
- 漏检原因：第一轮对枢纽文件只按符号做消费者发现，没有按**完整路径** `git grep -lF`。本轮对全部改动文件补做完整路径发现（排除 doc/），保留并逐个运行：`kill-path-inventory`(5)、`bridge-child-process-census`(1)、`fly2398-narrow-boundary`(3)、`fly2396-authorship-boundary`(1)、`fly1808-wave-a`(6)、`feature-flags-drift`(14)、`fly-2006-retention-consumer-gate` 单测(10) 与 gate 脚本、`fly1645-receipt-residue-gate` 单测(5) 与 `--main-only` 脚本、`runner-test-policy`(8)、`runtime-role-auto-qa-retirement.test.sh`、`migrate-fly1572-mailbox.test.sh`、`auto-narrow-rollback-precheck.test.sh`、`qa-codex-lead-parity.test.mjs` 全部通过。
- 排除：`audit-discord-mailbox-ingest.test.sh` 断言 chat-ingest 协议 v2，而 main 的 FLY-2799（e52d4ae33）已升到 v3；本 PR 未触及 chat-ingest，该套件也不在 CI 中。`product/doc/**`、`doc/**` 中的命中是文档/快照，不执行。

## 新近不可达代码（未删除，待 Lead 决定）
`CommDB.getCompletionDrainPending` / `getCompletionDrainVerification`、`StateStore.findIssuedDrainChallenge` / `getIssuedDrainChallenge` 已无生产调用方（event-route 改走语义排空）。
