# Design Review — FLY-1189 plan.md (Round 1)

Date: 2026-07-11
Author: Codex
Status: CHANGES REQUESTED

## Summary

方向正确：单 Bridge 多 Lead 是唯一能同时验证 owner 路由、跨 target 抑制隔离与 fleet guard 的生产同形拓扑，PR-C 的 env 名、默认 30min grace、默认 fleet threshold=4、默认 CLEARING TTL=2h、默认 reconcile=20 ticks 也都与 `98c2108c` 代码一致。但当前计划含数个会导致 harness 泄漏、场景不可达或证据假绿的执行级矛盾，尚不能照建照跑。由于 sandbox 无权写共享 worktree 的 `FETCH_HEAD`，本轮 `git fetch` 被拒；现有 `origin/flywheel-FLY-1048-pr-c` 已核为完整 SHA `98c2108c5f4e80ee75222b6966f16b2cc16ab8cd`，下述源码判断均直接读取该 ref。

## What's Good (Keep)

- 保留单 Bridge + 两个显式 label owner Lead；两个独立 Bridge 测不到同一 `detection_escalations` 表内的路由/抑制隔离。
- 保留 main-dist harness smoke 与 PR-C-dist 独立 QA 的分工，以及 FAIL 只 kickback、不在 QA session 代修被测代码的红线。
- 保留真 Discord API GET、slot DB 行、bridge.log 三件套；消息链接旁存原始 API dump 是正确的耐久证据合同。
- 保留 3min 主矩阵 + 一条真实默认 30min 等待；代码确实以持久化 `lead_notified_at_ms` 计时，Bridge 重启不会重置 grace（`detection-escalation.ts:305-351`）。
- 保留 gap + case-c 两条入流、ACK/resolve、ESCALATED 不重报、fleet、阴性对照与 production taint 检查；这些共同覆盖 E1-E5，而不是只证明某个模块函数可调用。
- H5c 的核心静态假设可以确认：`evaluateGapSuspicion` 把 `session.executionId` 写为 `targetKey`（`detection-gap-scan.ts:121-127`），`buildGapEscalationInput` 原样传入并同时记录 `session.execution_id`（`detection-detector-wiring.ts:73-91`），`createSessionTargetResolver` 再以 `row.target_key` 查 session（`detection-escalation-sinks.ts:90-114`）。所以 runner-keyed gap episode 的 `target_key == execution_id`，不是未决 blocker。

## Issues & Recommendations

1. **H1 只改 `test-deploy.sh` 不足以安全拥有第二个 Lead/slot 资源。** 当前脚本只为主 Lead 生成一个 `discord-state/.env`/`access.json`（`scripts/test-deploy.sh:681-723`），Bridge env 只显式传主 Lead 的 token env（`:1084-1099`）；`test-teardown.sh` 也只清主 `AGENT_ID` 的 supervisor、tmux window、session-id、manifest 与 workspace（`:253-309`, `:444-452`）。此外 `--extra-lead 3` 借用了 slot 3 的 bot/channel，却没有 claim slot 3；开跑时房空不能防止 campaign 中途另一任务成功 claim slot 3。这样会出现 extra Lead 无 token/错误 access、并发 bot 冲突、teardown 后残留 supervisor/manifest/session 等问题。**建议：**H1 Files 增加 `scripts/test-teardown.sh`；按排序后的完整 slot 集合原子 claim 主/extra slots，失败时全部回滚，并把资源清单落 slot2 campaign manifest。每个 Lead 生成独立 state dir、identity、access、log，Bridge 显式接收全部 `tokenEnvVar=value`；teardown 按 manifest 逐 Lead 清 PID/window/session-id/manifest/workspace/state 并释放所有借用 slot。hermetic 测试补“第二 slot 已占用时零副作用”“启动中途失败完整回滚”“teardown 无 extra 残留”，同时保留无 flag 的逐字 sentinel。

2. **S6 使用了不存在的 disposition 枚举。** 计划写 `acknowledged` 与 `false_positive`（`plan.md:125`），实际 route 只接受 `ack | resolve | dismiss`，其他值返回 400；`ack` 才写 ACKED，`resolve/dismiss` 才写 RESOLVED（`stuck-remanage-routes.ts:387-431`, `:453-511`; `StateStore.ts:6336-6369`）。**建议：**把第一腿改成 `disposition:"ack"`，第二个明确命名的独立 episode 改成 `"resolve"`（或 `"dismiss"`，若要验 dismiss 语义）；分别断言 200 + ACKED/RESOLVED，并继续保留无 Bearer=401、错 owner lead=403、正确 owner=200。断言必须使用服务端实际返回的 `episode_fingerprint`，不能硬编码 pane fingerprint 形态。

3. **S4 与 S5/S6 对同一 A1 episode 的时间线互相排斥。** S4 要求 A1、B1 都独立页 founder 恰一次（`plan.md:123`），但紧接的 S5 要在 A1 grace 前 ACK，使 A1 不页、只让 B1 页（`:124-125`）；同一次 S4 编排不可能同时满足。**建议：**拆成两组新 episode：S4a 验 N-to-N 路由（A/B 首腿均正确，之后二者均不 ACK、各页一次）；S4b/S5/S6 用 fresh A2/B2（或至少 fresh occurrence）在 grace 前 ACK A2，只让 B2 页，证明跨 target 抑制隔离。若要控制 founder @ 总数，可让 S4a 只做首腿路由，并明确把“两边都页”的要求移到另一个 bounded case，不能在同一 episode 同时要求 page 与 no-page。

4. **S7 的真实入口无法产生计划所述的 TTL 回弹。** `/close-runner` 对 running/awaiting runner 会先以 `status_not_eligible` 拒绝；成功路径只允许 terminal 状态或 `done=true` 先转 completed（`close-runner.ts:146-250`; `plugin.ts:1756-1851`）。成功 kill 后虽会短暂标 CLEARING（`close-runner.ts:252-281`, `:373-376`），但每次 detection reconcile 先执行 recovery auto-RESOLVE，再执行 CLEARING TTL rebound（`detection-reconcile-tick.ts:84-106`, `:197-208`）；terminal session 因而会在 2min TTL 前变 RESOLVED，不能“保持故障源 → TTL 回 NEW”。**建议：**先把此项作为 PR-C 可达性问题反馈实现者：要么提供一个真实、受支持的“cleanup 已开始但未 terminal”入口并据此重写 S7；要么承认当前 TTL 仅能做 module/DB state-machine 测试，真机场景改验 close-runner→CLEARING→下个 reconcile RESOLVED，并把 TTL 回弹从 E2E 硬判据降为已有单测 spot-check。不要通过直接改 slot DB 冒充生产 E2E。

5. **两次“重部署”会删除前序 runner、DB 与证据，当前顺序和证据存放合同不成立。** 现有 redeploy 必须先 teardown，而 teardown 会 kill `runner-test-slot-N`、删除 runner worktrees、整个 `${SLOT_DIR}`（含 `teamlead.db` 与 `qa-evidence`）及 test CommDB（`scripts/test-teardown.sh:146-170`, `:357-441`）。因此 S8/S-30 后再做 S9 的 thaw/restore 已无目标，campaign 结束再从 `${SLOT_DIR}/qa-evidence` 拷贝也会丢掉 S1-S8 证据。S-30 与 S10 也不能同一部署并行：per-project grace 在 Bridge boot 时只加载一次（`plugin.ts:5067`, `detection-config-source.ts:20-44`），一旦 project 配 120s，该 project 的 S-30 episode 也不再走默认 30min。**建议：**重排为独立 phase：A=S0-S6+可达的 S7+S9（恢复必须在首次 teardown 前）；B=fresh S8；C=fresh S-30（显式 `env -u FLYWHEEL_DETECTION_LEAD_GRACE_MS` 且无 project override）；D=fresh S10（部署前把 override 注入 canonical config）。证据实时写到不被 teardown 删除的 campaign root，如 `/tmp/qa-fly-1189-campaign-<id>/phase-*`，每场景完成即 fsync/copy；slot dir 只作临时工作区。为 S10 给 `test-deploy` 增加受测的 pre-boot config hook/专用数值参数，不要部署后改文件期待热加载。

6. **S1 三锚方向正确，但缺 TOCTOU 身份绑定与异常恢复，尚不足以保护同机生产 runner。** 当前合同只说“检查后执行”（`plan.md:34-38`）；检查与 `kill`/`mv` 间 PID 可退出并复用，pane 进程树可能有零个或多个 claude descendant，字符串前缀也会把 `slot-2-evil` 当作 `slot-2`。更重要的是 driver 中途失败/INT 时，冻结进程或已移动 worktree 没有强制恢复合同。**建议：**verify 后落 append-only action journal，记录 execId、pane id、PID、进程 start-time、command、canonical cwd/worktree 与 inode；动作前立即重读同一 tuple，要求恰一个目标且 start-time/inode 未变，路径用带尾 `/` 的 component-boundary 比对。`freeze/break` 成功后立刻注册幂等 `EXIT INT TERM` cleanup（先 SIGCONT，再 restore），cleanup 只使用已验证 journal 身份且再次核 start-time。拒绝矩阵补 PID reuse、零/多 descendant、目标在检查后退出、prefix collision、action 半成功与 trap 恢复。另把“mv 会真产出 ENOENT”前移为 H2 的实现 gate：同 filesystem rename 通常不会使已打开 cwd 自动失效，H4 才发现会太晚；未实测出现目标签名前不得把 break-worktree 用作 S1/S4 的确定机械路。

7. **S0/S11 与 H3 的部分证据方法会假失败或假绿。** 529 alert suite 已明确说明 macOS 上 `ps eww` 不能读取另一个进程的 env，故 S0 的 flag 实测方法不可用（`packages/qa-framework/suites/fly-529-alert-mirror.md:32-34`；实现也在 `qa-fly-529-alert-smoke.sh:69-75` 说明）。同时，活跃 19-runner 主机上要求三小时后 production PID 集合、`teamlead.db` mtime、整个 comm 根完全相同（`plan.md:131`）会被正常生产活动击穿；现有 529 snapshot 只在短窗口比较窄的 alert queue/deadletter file-set 和 claims mtime（`qa-fly-529-alert-smoke.sh:57-64`, `:161-170`），不能直接扩成全局静态性证明。`assert_no_cross(channelId, ...)` 若只 GET parent channel messages，也不会遍历 issue thread，可能对串台假绿；episode/lead_event 断言若不带 fingerprint，也无法区分同 target 的多 occurrence。**建议：**test-deploy 写一个无 secret 的 Bridge launch manifest（PID、5 bool、数值 knob、SHA），再以 bridge.log 的实际 cadence/feature锚点交叉验证，不用 `ps eww`。E5 改成 attribution-based fail gate：production DB/queue/comm 中不得出现 campaign id、test project、test execId 或 QA marker；production PID/file snapshots保留为观察证据，若有自然 churn 做归因，而非要求集合绝对相等。H3 所有 episode 断言以完整 `(target_key, kind, episode_fingerprint, first_detected_at_ms)` 为键；Discord 证据同时断言 thread id、parent/channel、author bot id、message id/marker，并显式读取两边已知 issue threads做 cross-check。

8. **H5c 不再是 PLAN-BLOCKER，且 main-dist 探针不能证明 PR-C founder pager。** 如上所述，`98c2108c` 源码已经闭合 targetKey 链；main 没有 PR-C 表/统一 pager 时，用 main dist 跑 gap 最多证明 PR-A observation，不能给 `founderPageResolvable` 一个运行时真值。另 `/api/runs/start` 不接受 caller body 的 labels；route 从真实 Linear issue 拉 labels 并据此 auto-resolve/scope-check（`runs-route.ts:351-418`, `:432-470`），PreHydrator再把 issue labels带入 session（`PreHydrator.ts:31-41`）。**建议：**删除“matchesExecId=false 才 STOP”的未决表述，在 progress.md 记录源码结论 `matchesExecId=true`。把 H5c 改为 PR-C-dist 部署 preflight：用已带 Product-Test/Ops-Test 的真实 Linear dummy issue启动 runner，断言 `sessions.issue_labels`、owner lead、chat_threads 绑定与 `createSessionTargetResolver` 的前置条件均成立；driver 不传伪 labels 参数。若任一 runtime 前置缺失再 STOP，这才是剩余的真实 blocker。

## Verdict

CHANGES REQUESTED — address items above
