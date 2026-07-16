# FLY-1257 Codex 常驻运行时 + retry 路径四缺陷 — QA 验证报告

Issue: FLY-1257
日期: 2026-07-15
基于: plan.md / exploration.md / research.md + 本分支已提交实现
PR: #599 (base main)

## Verdict

**PASS**。四个缺陷的实现均忠实于 Codex-design-reviewed 的 plan，逐个缺陷的
安全行为都通过**突变验证**(把修复改坏 → 对应测试变 RED)确认「测试真的在把关」,
而非绿得莫名其妙。Claude 路径字节兼容。补 1 条 QA 测试锁定一个未被断言的行为
(超时门放行)。

## 验证范围

真实 FLY-1257 delta = merge-base(origin/main, HEAD) `5e7c2a86` .. HEAD `783db589`,
共 34 文件 / +3889 行(其余 workflow-* 文件是本地 main 陈旧造成的假象,已用
origin/main 校正)。四缺陷 → 生产位点:

| 缺陷 | 生产改动 | 权威 seam |
|---|---|---|
| ① 等门自杀 | Blueprint 等门文案 · codex-runner-contract.md · complete.ts CLI 硬闸 · codex-daemon-client.ts goal-loop hold/latch/preflight · gate-marker.ts 原子写 · feature-flags registry | gate marker 驱动 hold;CommDB 驱动 blocked 权威 |
| ② retry 不发带 | run-dispatcher.ts grantTurn seam(镜像 FLY-887) | CommDB `grantTurn` ON CONFLICT epoch+1 原子转移 |
| ③ retry 缺 startPoint | run-infra.ts 三态 branch-tip probe + run-dispatcher.ts 双探针消费 | branch B 本地 ref(rev-parse --verify --quiet 全限定) |
| ④ blocked 吞门 | zombie-gate-hygiene.ts 时序判定 · StateStore.ts terminal_at · gate-poller.ts created_at 透传 | StateStore `terminal_at` vs CommDB `messages.created_at`(同 SQLite UTC) |

## 1. 聚焦回归测试 — 全绿

在 QA 分支 HEAD (`783db589`) 本机重跑 FLY-1257 触及的全部测试文件:

| 包 | 测试文件 | 结果 |
|---|---|---|
| claude-runner | codex-daemon-client · codex-daemon-goal-runtime · CodexTmuxAdapter | 128 passed |
| flywheel-comm | complete · db.gate (+我补的 1 条) | 57 passed |
| config | feature-flags-registry | 10 passed |
| edge-worker | Blueprint.fly1188-codex-prompt · -identity · fly887-worktree-takeover | 33 passed |
| teamlead | run-dispatcher-fly887-turn-seam · run-dispatcher · StateStore · zombie-gate-watchdog · gate-poller | 199 passed |

合计 **427 passed**(原 426 + QA 补测 1)。lint(biome)对改动测试文件 clean;
typecheck flywheel-comm 通过。

### 全套件失败已定性 = host-env/负载超时,非回归

跑 flywheel-comm 全套件(846 测)时本机红 31~43 个,均落在 **spawn 子进程的
CLI/集成套件**(cli · commands · e2e-workflows · publish-report · ship-eligibility ·
progress.realgit · await-codex-gate)。定性证据链:

1. **失败特征全是超时**——主导信号「Test timed out in 5000ms」(26+ 次),
   零断言失败(无 Expected/Received 不符)。
2. **无一在 FLY-1257 触及文件**——db.gate / complete / gate-marker 全绿。
3. **隔离复跑坐实负载超时**——把最可疑的 complete/gate-exercising 套件
   (commands · cli · await-codex-gate)单 fork、30s 超时隔离跑:37 passed,
   仅 cli.test.ts 的 4 个 `check`/`pending` 子命令仍红,**仍是 30s 超时**
   (整文件跑了 380 秒)。这 4 个是 spawn `node dist/index.js` 子进程的 CLI 集成
   测试,与 FLY-1257 的 `complete`/`gate` 命令无关;而 `complete.test.ts` 是
   **进程内**测 FLY-1257 逻辑,故快且全绿——正好解释「逻辑覆盖绿、CLI-spawn
   集成超时」。
4. **CI 在同一 head 独立全绿**——GitHub Actions `Build & Test` pass(16m25s)+
   payload distribution pass,head `783db589` 与本地一致。unloaded CI runner 不撞
   子进程排队,全过。
5. **既有记忆佐证**——`ship-eligibility.test.ts` 本机红是已知 env flake(CI 绿)。

结论:本机满载(生产 Bridge + 多 Lead + runner + 并发测试)→ 子进程 spawn 排队
30s+ 超时,与 FLY-1257 改动无关。

## 2. 突变验证 — 每个缺陷的安全行为都被测试真正把守

对四个缺陷各自的核心安全行为,把修复「改坏」→ 跑对应测试 → 确认变 RED → git
还原。这是对「绿测可能在为绕过背书」失效模式的直接防御。

| 缺陷 | 突变(改坏修复) | 期望测试变红 | 实测 |
|---|---|---|---|
| ①(M1-c) | `complete --route blocked` 的 pending-gate 拒绝短路(`if (false && pending)`) | 未答门本应 exit 1 拒绝 | **2 failed** ✓(不拒绝、mockFetch 被调用) |
| ②(M2) | 移除 grantTurn seam(`if (false && isPhaseRetry ...)`) | TURN 应转移到新 exec | **1 failed** ✓(`turnAtLaunch` 留在旧 holder) |
| ③(M3) | indeterminate fail-close 改为放行(`return undefined`) | indeterminate 应 abort-before-TURN | **2 failed** ✓(不抛错、Blueprint 被启动) |
| ④(M4) | 时序判定短路(`if (false && session)`) | 终态后创建的门应被保留 | **6 failed** ✓(门被 `retireQuestionGuarded` 退掉) |

四项全部按预期变红 → 测试确实在把守修复行为。

## 3. 四缺陷代码正确性(逐个复核)

### ① 等门自杀
- **M1-c CLI 硬闸**:判别式 = `FLYWHEEL_GATE_MARKER_DIR`(Codex-only,Claude runner
  从不注入 → 整段跳过、byte-compat)。权威用 **CommDB `getPendingGatesByRunner`**
  (非 marker 文件——marker 是 runner 可写的 wake 镜像,删 marker 无法隐藏未答门),
  比 plan 原本的 strict-marker-scan 更强(commit 783db589 已把过时 strict scan 移除)。
  query 只计「未答(无 response 子行) + 未过期(`expires_at > now`)」的 checkpoint 门
  → 被 watcher 超时解析的门自然放行。
- **M1-d goal-loop hold/latch/preflight**:blocked + isWaiting → 不当终态,本地持有
  (durable latch,写失败 fail-close 保持 latch=true);marker 解析 → native
  goal/set(active) 自动续轮(不发 turn/start,与 m0-probe 实测 11ms 自恢一致)。
  **重启恢复的关键安全属性**已复核:preflight 分支「`gateHoldLatched && !waiting` 的
  blocked goal → resumeHeldGoal 而非终态」正确区分了「合法终态 blocked」与「持有期
  blocked」,防重启把持有中的 goal 误当终态自杀。kill-switch `FLYWHEEL_CODEX_GATE_WAIT=0`
  整段回旧行为。
- **原子写**:gate-marker.ts 改 temp+rename,防半写 marker 被 isWaiting/watcher 读到。

### ② retry TURN seam
- dispatch() 镜像 start() 的 grantTurn(`ON CONFLICT epoch+1` = 原子转移);仅
  `isPhaseRetry && keepAlive` 触发;非 phase / keepalive=0 零调用(byte-compat)。
- 共享 `abortPreLaunch` helper 补了 start() 原先漏的 `onSpawnFailed`(durable launch
  claim 关闭);commitLaunch 拒绝路径用 `notifySpawnFailed=false` 避免重复。

### ③ retry startPoint(fail-close 语义)
- 三态 probe:`rev-parse --verify --quiet refs/heads/<branch>^{commit}` 全限定 ref
  (防同名 tag 冒充)+ 20s timeout + 机器可读退出契约(exit 1=missing、SHA=found、
  其余=indeterminate)。branch 名来自 `resolveWorktreeKey` + `expectedWorktree().branch`
  (不手写模板,防 drift)。
- **双探针**设计:第一次探针在 grantTurn 之前(indeterminate→fail-close,绝不把 TURN
  转给永不启动的 exec),grantTurn 转移 belt(fence),第二次探针在 fence 后读权威 tip
  (前任已失写权)。indeterminate → abortPreLaunch+throw(绝不落 origin/main 毁分支);
  missing → 不设 startPoint 走既有 fallback;found → ctx.startPoint。

### ④ blocked 吞门(时序判定)
- StateStore `terminal_at`:SQL 端 `datetime('now')`(非 JS wall-clock,与 CommDB
  `messages.created_at` 同为 SQLite 服务端 UTC,字典序可比),三个写入点
  (upsertSession/persistTransition/forceStatus)统一走 `applyTerminalTimestamp`:
  首次进终态盖戳、终态→终态不改写、revive 清 NULL。
- hygiene:`session` 终态时,`created_at`/`terminal_at` 任一 missing/格式不过 → fail-open
  保留门;`created_at >= terminal_at`(含同秒 tie,`>=` 覆盖)→ 生命迹象保留;仅
  `created_at < terminal_at`(都合法)→ 真僵尸照退。session 缺失 → 旧行为(无从比较)。
- gate-poller `created_at` 透传已补(plan 特别标记的「漏透传即静默失效」位点)。

## 4. 真机行为证据(已在实现阶段落盘)

M-opt 的原生 goal paused RPC 在实现阶段已用真 codex-cli 0.144.4 app-server 验证
(`qa/m0-paused-probe.md`,原始 RPC 帧 + timing):`blocked→paused→active` 44ms 自恢、
`blocked→active` 直恢 11ms、objective/budget 全程保留、daemon restart 后 paused 持久。
本 QA 不重复该 probe(结论以原始帧为准,可复现)。

## 5. QA 补测(锁定未被断言的行为)

`getPendingGatesByRunner` 的 `expires_at > datetime('now')` 子句是 M1-c 硬闸依赖的
「超时门放行」保证(watcher 超时解析后 runner 必须能 `complete --route blocked`,否则
永久被拒),但原测试只覆盖了「本 runner / 已答」两维,没断言过期维度。补 1 条
`db.gate.test.ts` 测试(默认 TTL 门 → rewind expires_at 到过去 → 断言不再 pending),
并自突变验证:从 query 移除该子句 → 新测试变 RED(过期门仍返回)→ 证明测试真在把关。
`packages/flywheel-comm/src/__tests__/db.gate.test.ts` 唯一改动,typecheck+lint 通过。

## 6. 结论

- 四个 2026-07-14 实战缺陷的修复实现正确、忠实于 Codex-reviewed plan,四个 fixture 场景
  在测试中复现修前失败/修后通过。
- 每个缺陷的安全行为经突变验证确认被测试真正把守(①2红 ②1红 ③2红 ④6红)。
- Claude 路径字节兼容(判别式 env 缺失即整段跳过;identity/prompt/takeover/turn-seam
  既有测试全绿)。
- 补 1 条 QA 测试锁定超时门放行行为并自突变验证。

**QA 判定:PASS。**
