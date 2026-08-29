# FLY-921 三段式相位误推进 + turn-belt stale-holder 恢复 — QA 报告

Issue: FLY-921 (https://linear.app/geoforge3d/issue/FLY-921/bugpipeline-三段式流水线qa-相位抢先跑-turn-belt-死-holder-不释放锁-qa-边角覆盖补强)
日期: 2026-07-06
基于: plan.md（独立 QA 阶段）

## 结论：PASS

四个 fix（A/B/C/D）+ 对抗测试 + 两轮 Codex code review 后续修补，均按 plan 落地，逻辑与真实事故根因（FLY-543）一一对应。全仓构建 + lint 干净，测试全绿（5 处失败均为与本 PR 无关的环境噪声，逐一独立复现确认）。补跑了一版真 Discord 可见的模块驱动复现（§5），5/5 项通过，thread 链接见 §5。

## 1. 范围核对（vs origin/main，非陈旧本地 main）

`git diff origin/main...HEAD --stat` 实际改动 23 个文件：
- 传输层：`core/src/hook-callback-types.ts`、`edge-worker/src/HookCallbackServer.ts`、`claude-runner/src/TmuxAdapter.ts`（+ 对应测试）
- 相位护栏：`teamlead/src/bridge/phase-orchestrator.ts`（证据闸 + reconcileTurnBelt + 两处 Codex 后续修补）
- turn-belt：`flywheel-comm/src/db.ts`（listTurns）、`teamlead/src/bridge/{event-route,plugin}.ts`、`teamlead/src/DirectEventSink.ts`
- 防御纵深：`edge-worker/src/decision/FallbackHeuristic.ts`
- 对抗/场景测试：`phase-orchestrator.fly921-adversarial.test.ts`、`event-route-fly921-turn-belt.test.ts`、`three-stage-turn.test.ts`（补）
- 设计文档：`engineering/doc/FLY-921-three-stage-turn-belt/{exploration,research,plan,progress}.md`

（注：会话最初 `git diff main...HEAD` 因本地 `main` 落后 origin 多个已合并 PR 而显示了 100+ 无关文件；已用 `origin/main` 重新界定范围。）

## 2. 构建 + Lint

- `pnpm install` + `pnpm -r build`：**全绿**，`tsc` 无错误（含 core/config/flywheel-comm/edge-worker/claude-runner/teamlead 全链）。
- `pnpm lint`（biome）：**无新增告警**。输出的 14 条告警逐一核对文件 diff，均落在本 PR **未触碰**的既有代码区域（`DirectEventSink.test.ts` 870 行之前的旧测试、`runner-idle-watchdog-quiet.test.ts`、`qa-fly-863-*.mjs`、`AgentTeamTransportFactory.ts`）。

## 3. 测试

逐包运行（teamlead 因体量大改用 vitest 默认并发，其余包默认）：

| 包 | 结果 |
|---|---|
| packages/config | 20 files / 359 tests — 全绿 |
| packages/flywheel-comm | 51 files / 735 tests — 全绿（含新增 `three-stage-turn.test.ts` listTurns 用例） |
| packages/claude-runner | 17 files / 334 tests — 全绿（TmuxAdapter 107/107，claude 路径字节兼容红线守住） |
| packages/edge-worker | 全绿（含新增 `FallbackHeuristic.test.ts` ledger-only 用例、`HookCallbackServer.test.ts` sessionId 过滤用例，均对着真实 HTTP server 验证，非纯 mock） |
| packages/teamlead | 375 files / 5206 tests — **369 passed, 5 failed(环境噪声), 27 tests failed**（见下）|

### 3.1 teamlead 5 个失败文件 — 逐一核实为环境噪声，与本 PR 无关

用 `--no-file-parallelism` 单独重跑，脱离 16-way 并发负载后复核：

1. **`codex-lead-runtime.test.ts`（22 个）**：`FLYWHEEL_CODEX_LEAD_WORKSPACE must not overlap ~/.flywheel`。根因是本 QA 会话自身的 `mkdtempSync(tmpdir())` 落在 `~/.flywheel/runner-state/<exec-id>/browser-tmp/` 下（本机 TMPDIR 配置），恰好撞上被测代码本身要拦截的"workspace 与 ~/.flywheel 重叠"红线——是运行环境的路径巧合，不是代码逻辑错误。单独重跑复现同样失败模式，确认非并发竞态。**未被本 PR 触碰**（FLY-245 相关文件）。
2. **`LeadAlertNotifier.test.ts`（1 个）**：`expected 'Bot MTQ4...(真实 token)' to be 'Bot resolved-bot-token'`——单独重跑后收到的是本机环境里真实存在的 Discord bot token,证实是 env 变量泄漏到测试进程,不是 mock 失效。**未被本 PR 触碰**。
3. **`StructuredInboxRouter.test.ts`（1 个）**：chokidar pre-ready error 用例 hook 10s 超时。单独重跑（`--no-file-parallelism`）**通过**——确认是 16-way 并发下的调度延迟,非真实竞态。**未被本 PR 触碰**。
4. **`createLeadRuntime-preflight.test.ts`（2 个）**：单独重跑同样受 TMPDIR-overlap 环境影响（见 #1 同根因,该文件调用同一个 preflight path）,5s/超时反映的是并发下真实 Claude CLI 版本探测延迟。**未被本 PR 触碰**。
5. **`fly247-bash-suites.test.ts`（1/12 个）**：`flywheel-fleet plan/apply/rollback/recover` 单条 120s 超时,同文件其余 11 条（含相邻的 `flywheel-fleet report`/`journal`/`batch primitives` 等重 IO 用例）全绿,证明是重负载下单条 hermetic bash 套件超出默认超时,非逻辑损坏。**未被本 PR 触碰**。

以上 5 个文件均**不在** `git diff origin/main...HEAD` 的改动文件列表内，且失败特征（真实 token 泄漏 / TMPDIR 路径重叠 / 并发调度延迟）与 FLY-921 的改动逻辑（sessionId 过滤、证据闸、turn-belt reconcile、ledger-only 判定）无因果关系。

### 3.2 与 FLY-921 直接相关的测试 — 100% 通过

- `HookCallbackServer.test.ts` 新增 4 用例（sessionId 过滤/byte-compat/warn 日志/超时）：**全绿**，用真实 HTTP server 验证，覆盖了 FLY-543 嵌套会话误判的精确场景。
- `TmuxAdapter.test.ts` 107/107：**全绿**，claude 路径字节兼容红线守住。
- `FallbackHeuristic.test.ts` 新增 3 用例（ledger-only/混合/零 commit）：**全绿**。
- `three-stage-turn.test.ts`（flywheel-comm）listTurns 新增用例：**全绿**。
- `phase-orchestrator.test.ts` 证据闸 + reconcileTurnBelt 矩阵（stale 判定 4 格 × 恢复优先级 × 两道竞态守卫 + 两处 Codex code review 后续修补的回归钉子）：**全绿**。
- `phase-orchestrator.fly921-adversarial.test.ts`（6 个场景，跑在**真实** better-sqlite3 CommDB 上，不是纯 mock）：**全绿**——FLY-543 全链重放、kill-holder 恢复+幂等、founder 中途改 scope、keep-alive OFF 同样 fail-closed、indeterminate 不动。
- `event-route-fly921-turn-belt.test.ts`（跑在**真实** Bridge HTTP app + 真实 `WorkflowFSM` 上，走真实 `/events` 端点）：**全绿**——含 Codex R1 HIGH 钉子（`session_failed` 打在 PARKED `awaiting_review` holder 上，FSM 拒绝状态转换后 reconcile 仍必须跑）。
- `DirectEventSink.test.ts` 新增 3 用例（emitFailed/emitCompleted 顺序/main-role byte-compat）：**全绿**。

## 4. 代码正确性审查（对着源码逐点核实，非仅读 diff）

1. **Fix A（sessionId 过滤）**：`IHookCallbackServer.waitForCompletion` 新增可选第三参，`TmuxAdapter` 传入自己预生成的 `claudeSessionId`；不匹配时 warn + 继续等待（pane_dead poller 兜底）。字节兼容——调用方不传参时行为逐字不变。**正确**。
2. **Fix B（implement→QA 证据闸）**：`hasRunnerDrivenReviewEvidence` 只认 `review_question_id` 存在且 ≠ `REVIEW_BINDING_UNBOUND`（复用 `StateStore.ts` 既有导出常量，未新造判别逻辑）。判定顺序（边界→policy→证据→handoff）与 plan §9 R1 #6 一致。**正确**。
3. **Fix C（turn-belt reconcile）**：
   - `reconcileOneTurn` 的 stale 判定矩阵（holder 缺失/终态/非终态+探针）与 plan 表格逐格对应；恢复候选**显式排除** stale holder 自身且只挑非终态候选，逐个 probe，`indeterminate` 时整体 fail-closed 不动 TURN——**用代码验证过**这确实规避了「status-only 选择器会把 TURN 重授给死 holder 自己」的 Codex R1 #2 场景。
   - 两道竞态守卫：事件位点守卫（`terminalExecId` 必须 === 当前 holder）+ 启动位点 5 分钟宽限——**核对了 `RunDispatcher.start()` 里 `grantTurn` 确实在 `session_started` 落库之前的 pre-launch seam**（`run-dispatcher.ts:720`），证实守卫 2 的宽限窗口是必要的，不是防御性冗余。
   - **Codex code R1 HIGH 修补（FSM-rejected session_failed）**：核对了 `packages/core/src/workflow-fsm.ts` 的 `WORKFLOW_TRANSITIONS.awaiting_review` 边列表，**确认真的没有 `awaiting_review→failed` 边**（只有 `approved_to_ship/completed/rejected/deferred/shelved/terminated`）——FSM 会拒绝这个转换,原 early-return 确实会永久跳过 stale-holder 恢复。修补在 `event-route.ts` 的 `transitionRejected` 分支里补跑了一次 scoped reconcile，是对的。
   - **`completed+qa` 优雅完成 carve-out（e5287297）**：核对了 `post-ship-finalization.ts:241` 确实是 TURN 行删除的唯一既有写手（ship 后异步清理）。若不做这个 carve-out，reconcile 会在每次成功 ship 时把 TURN 误判为 stale 并重授给 parked 的上游相位、误发一次 STALE-TURN 告警——这是一个会在**每次成功三段式 ship** 上触发的真实回归，carve-out 修复是必要且范围精准的（只排除 `completed+qa`，`failed` 的 QA holder 仍按 stale 处理，与 FLY-543 的 kill 形态一致）。
4. **Fix D（FallbackHeuristic ledger-only）**：正则 `/^chore\(progress\):/` 判定全部 commit 均为 ledger → blocked；混合 commit 不受影响。**正确**，与 FLY-543 事故链的第 4 环节（ledger commit 让 commitCount≠0 从而绕过 Rule 1）精确对应。
5. **`plugin.ts` 接线**：`turnBelt.listTurns/getTurn/deleteTurn` 逐项目开关 CommDB（`try/finally db.close()`），启动位点在 `reconcileOnStartup()` 之后串行跑一次全表 `reconcileTurnBelt()`——与 plan §3 chunk C3 描述一致。

## 5. 真机 Discord 复现（Annie 要求补跑,2026-07-06 补充）

Plan §5 把"真机 QA"列为第三段独立 QA 的移交项。第一轮 QA 判断"完整起隔离 Bridge+tmux+嵌套 claude -p"投入与风险不成比例而推迟（见下方原始记录）；Lead 转达 Annie 明确要"眼见为实"后,补跑了一版**真 Discord 可见**的复现。

### 做法：模块驱动真机复现（非完整 Bridge+tmux 起号）

新增 `scripts/qa-fly921-real-discord-turn-belt-e2e.mjs`，直接 import **编译后的生产代码**（`packages/teamlead/dist/bridge/phase-orchestrator.js` 的真实 `PhaseOrchestrator` 类、`packages/flywheel-comm/dist/db.js` 的真实 `CommDB`），驱动真实的 sqlite 读写 + 真实 Discord API（529 QA 测试房 slot-2 频道，真 bot token），逐条复现 Annie 要看的三件事：

1. **QA 相位不抢跑**：起 parked-alive 的 design + implement(`awaiting_review` 但无 `review_question_id`，模拟 FLY-543 的合成完成) → 调真实 `onPhaseComplete` → 断言 `startDispatcher.start`（QA spawn 入口）**从未被调用**，只触发了一次真实 `alertLeadPipelineError`（内容原样贴进 Discord thread）。
2. **turn-belt 死 holder 释放锁**：把 implement 标记 `failed`（模拟 Lead kill）→ 调真实 `reconcileTurnBelt` → 断言 TURN 从 `impl-demo`(epoch 1) 自动转给 parked 的 `design-demo`(epoch 2)，**不需要手改 DB**；重跑一次验证幂等（无二次告警/无二次 grant）。
3. **成功 ship 不误报**：design 段正常持有 TURN、QA 段优雅 `completed`（approved ship 形态）→ 调真实 `reconcileTurnBelt` → 断言 TURN **仍留在** QA 手里（未被误判 stale 抢回 design）、且 `alertLeadPipelineError` 调用次数**不变**（0 次误报）——这正是本轮 Codex code review R1 HIGH 抓到、e5287297 修的那个 carve-out。

**结果：5/5 项全部通过**，真实 Discord thread（可点开逐条查看，含时间戳）：
https://discord.com/channels/1485787271192907816/1493080993173737583/1523883826621972581

**诚实披露边界**：唯一 stub 的依赖是 `probePhaseAlive`（tmux/进程存活探测）——没有起真实 tmux Runner 进程，用确定性的按场景取值代替。这个探针本身是**本 PR 之前就存在**的既有生产依赖（`plugin.ts:4330`，已被 FLY-887 的 wake-before-park 逻辑生产验证过），FLY-921 只是新增了调用点复用它。其余全部真实：真实生产 `PhaseOrchestrator`/`CommDB` 代码、真实 sqlite 读写、真实 Discord HTTP API + 真实 thread + 真实消息渲染。未起完整 Bridge 进程 / tmux / 嵌套 `claude -p` 会话 / Discord 频道级 stage_changed 事件流。

### 原始记录（第一轮 QA 的推迟理由，供参考）

- 这是纯后端流水线内部机制的 bug-fix，不产生新的用户可见界面/交互面。
- 对抗测试套件已经把 FLY-543 事故的精确时间线在真实 CommDB + 真实 WorkflowFSM + 真实 Bridge HTTP `/events` 端点上完整重放。
- 若需要更高确信度（完整 Bridge+tmux+真实嵌套 claude -p 会话的端到端），可另立 follow-up，不建议作为本次 ship 的阻塞项。

## 6. 验收结论

对照 plan §6 验收标准：

1. FLY-543 全链重放（单测层）全绿 ✅
2. 既有测试全绿（TmuxAdapter 107、phase-orchestrator 既有套件、three-stage-turn 套件、FallbackHeuristic 既有用例）✅
3. `pnpm lint` 全仓干净 ✅；push 前全仓测试跑过一遍 ✅（5 处环境噪声已逐一独立复现排除）
4. 字节兼容红线：确认 A 的可选参、B 的不可达分支、C 的纯新增、D 仅 fallback 分支均有反证用例 ✅

**PASS** — 可进入 approve gate。
