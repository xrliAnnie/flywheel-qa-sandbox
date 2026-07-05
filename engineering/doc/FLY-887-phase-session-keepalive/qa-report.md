# FLY-887 三段式 phase-session 并存保活 — QA 报告

Issue: FLY-887 (https://linear.app/geoforge3d/issue/FLY-887/pipeline-三段式-phase-session-并存保活-designimplementqa-不跑完就关qaimplement)
日期: 2026-07-05
基于: plan.md

## 结论：FAIL

代码级审查 + 测试执行发现一处 **高严重度、可复现的正确性 bug**：`reconcileOnStartup`
（Bridge 每次启动/重启都会跑）在 keep-alive 模式下会在**每一次 Bridge 重启**时错误地对
已经合法 park 的 design session 重新触发 design→implement handoff —— 无论流水线实际
已经推进到哪一步，都会把共享 worktree 的 TURN 从当前合法持有者（例如正在 fix-loop 中的
QA）夺走并错误地转授给 implement，还会给 implement 发一条它的 prompt 从未教过它处理的
"retest"（QA 专用措辞）唤醒消息。这个问题会在生产上**每次 Bridge 重启**都复发（本项目
重启 Bridge 是常态操作），直接违背了 FLY-887 本身要解决的核心诉求（"不丢 context、不被
打断的 fix 循环"）。

## 已验证通过的部分（代码级，非常扎实）

逐条对照 plan.md 的机制设计（M1-M9,7 处改动面 + kill-switch），全部实现与设计一致:

- **TURN 表 + `turn` 命令**（`db.ts` / `turn.ts`）: UPSERT + epoch 自增语义正确;
  `turn` 命令 yours/not-yours/no-turn 三态 + 正确的 exit code 契约（真失败才 exit 1）。
- **PhaseOrchestrator.handoff()**: 四态 liveness（alive/dead_pin/absent/indeterminate）
  处理正确，`indeterminate` 严格 fail-closed（不 park、不 close、不动 TURN）;
  wake-or-spawn 路径里 `grantTurn` 严格先于 `wakePhaseRunner`（真实测试从 fake
  `blueprint.run` 内部读表验证 happens-before，非仅断言调用顺序）。
- **`assertPhaseWorktreeReady`** 在 wake 前的 dirty/head-mismatch fail-closed 校验到位
  （handoff 和 fix-loop 两处都过）。
- **RunDispatcher pre-launch TURN grant seam**：`run-dispatcher-fly887-turn-seam.test.ts`
  用真实 fake `blueprint.run` 读表证明了"launch 前 TURN 已落"，覆盖 fresh spawn/两条
  spawn 兜底/kill-switch OFF 哨兵。
- **Blueprint worktree 原地接管**：`Blueprint.fly887-worktree-takeover.test.ts` 用**真
  git 临时仓**（非 mock）验证 dirty/HEAD-drift 时 fail-closed 拒绝接管，clean+HEAD 匹配
  时正确复用。
- **`runFailFlowKeepAlive`**：`recordFixRound` insert-or-read 幂等语义 + cap 检查 +
  wake(fix)/spawn 兜底路径全部符合设计;多轮验证测试证明 round 正确递增。
- **post-ship 收尾顺序**：`post-ship-finalization.fly887.test.ts` 用真实
  `WorkflowFSM`+`DirectiveExecutor`+`StateStore` 证明 `finalizeThreeStagePhases` 严格
  先于 `removeCleanWorktree` 调用，且正确把 parked design/implement 转 completed、
  保留 shipped QA session 原状、删除 TURN 行。
- **kill-switch**（`FLYWHEEL_THREE_STAGE_KEEPALIVE`）：默认 ON，registry 已登记
  （`feature-flags-drift.test.ts` 不会漏检），`=0` 时逐字回退旧 close+respawn 行为
  （legacy 测试套件专门用 `keepAliveEnabled: false` 跑，是有效的 byte-compat 哨兵）。
- **Prompt 文案**：design/implement 段的 park 契约 + 强制 turn 自查 + QA FAIL 段的新
  RE-TEST 措辞，snapshot 测试全绿；`declare-state` → `park` 的 drive-by 修正（含
  auto-QA prompt 那处同类潜在 bug）已生效。

全仓测试：teamlead 4862 passed / edge-worker 1054 passed / flywheel-comm 732 passed /
config 323 passed（另有 24 个 `codex-lead-runtime.test.ts` 失败是已知环境性问题——QA
runner 自己的 TMPDIR 落在 `~/.flywheel` 下触发该文件的安全校验，与本 PR 无关，该文件
根本不在 diff 里；用干净 TMPDIR 重跑 117/117 全过）。CI 绿（PR #458）。Lint 干净。

## FAIL 发现：`reconcileOnStartup` 在 keep-alive 下每次重启都会误触发过期 handoff

### 根因

`StateStore.getStrandedDesignPhaseSessions()`（pre-FLY-887 既有查询）：

```sql
SELECT * FROM sessions WHERE session_role = 'design' AND status = 'design_done'
```

这个查询在 FLY-793 时代的语义是"implement 从未真正起来过的崩溃残留"——因为当时
design_done 只是一个**转瞬即逝**的中间状态（handoff 立刻把它关掉+起 implement）。

FLY-887 keep-alive 把这个假设打破了：design session park 之后会**永久停留**在
`design_done`（这正是"park 不退出"的字面含义），直到 ship 才被 `finalizeThreeStagePhases`
转成 `completed`。于是 `getStrandedDesignPhaseSessions()` 现在**分不清"真崩溃残留"
和"健康 park 中，流水线早就往前走了"**——两者在这个查询看来一模一样。

`reconcileOnStartup()`（`phase-orchestrator.ts:310`）在**每次 Bridge 启动/重启时无条件
执行**，把查到的每一行都重放进 `onPhaseComplete` → `handoff(design, 'implement')`。
`handoff()` 本身没有"这个 issue 是不是已经推进过 implement"的检查——它只看
`getAlivePhaseSession(issueId, 'implement')` 是否有活体，有就走 wake-or-spawn 的
wake 分支：

1. `capturePhaseHeadSha(prev)` 对**共享物理 worktree**跑 `git rev-parse HEAD`——不管
   design/implement/QA 谁的 session row 传进去，读到的都是同一个目录当前的 HEAD。
2. `assertPhaseWorktreeReady(target, headSha)` 拿这个刚读出来的 HEAD 去比对 target
   （被唤醒对象）的 worktree HEAD——因为是同一个物理目录，这个校验**永远同义反复地
   通过**，不管流水线实际推进到多远。
3. 于是 `grantTurn({execId: <implement>, phase: 'implement'})` 被调用——**把 TURN 从
   当前真正的持有者（可能是 QA，正在 fix-loop 里）夺走**，转授给 implement。
4. `wakePhaseRunner({session: implement, kind: 'retest', ...})` 被调用——发给
   implement 的措辞是（plugin.ts wakePhaseRunner 的 'retest' 分支）："the implement
   phase pushed a fix... re-run your **QA scenarios** and emit `qa-result` again"——
   这段话是写给 **QA** 的，implement 的 prompt 里从未教过它怎么处理一条 "RE-TEST" 唤醒
   （implement 只被教了怎么处理 "QA FIX" 唤醒）。

### 复现（已写成失败的回归测试，随本次 QA 一并提交）

`packages/teamlead/src/bridge/__tests__/phase-orchestrator.fly887-keepalive.test.ts`
新增 describe block "FLY-887 QA FINDING: reconcileOnStartup re-fires design→implement
on EVERY restart under keep-alive"：构造一个永久 park 在 `design_done` 的 design
session + 一个活体 implement（模拟"流水线早就往前走了"），跑
`reconcileOnStartup()`，断言 `grantTurn` / `wakePhaseRunner` / `start` 都不应被调用。
**当前实现下这个断言失败**——`grantTurn` 被以 `{execId: 'impl-exec', phase:
'implement'}` 调用了一次，证实了上面的分析。

跑法（在 packages/teamlead 下，注意用干净 TMPDIR 避开环境性噪音）：

```
TMPDIR=/tmp npx vitest run src/bridge/__tests__/phase-orchestrator.fly887-keepalive.test.ts
```

### 影响面

- **每次 Bridge 重启**都会对**每一个**"design 已完成但 issue 还没 ship"的三段式
  issue 触发一次——这不是罕见 corner case，是这个仓库的日常操作节奏（本仓库 changelog
  里 Bridge 重启是按天甚至按批次发生的）。
- TURN 被错误转授之后，真正应该持有 TURN 的一方（例如 mid-fix-loop 的 QA）下次做
  `turn --exec-id` 自查会看到 `not-yours`——而 QA/implement 的 prompt 契约里**没有
  教过"看到 not-yours 该怎么恢复"**，等于把一个健康的 fix-loop 卡死，需要人工
  （Lead）介入才能恢复。这正好是 Annie 提出 FLY-887 想要根治的那类"半途被打断、
  context 断裂"的问题的一个新变种。
- implement 收到不属于自己的 "retest" 唤醒文本后的实际行为不可预测（不在被教过的
  契约范围内）。

### 建议的修复方向（不越权替 implement 做决定，仅供参考）

`reconcileOnStartup` / `getStrandedDesignPhaseSessions` 需要加一个"这个 issue 是否已
经推进过 design"的判断，例如：只有当**该 issue 不存在任何活体的
implement/qa**（`getAlivePhaseSession` 对 implement 和 qa 都返回 undefined）时才认定
design_done 是"真崩溃残留"，否则视为"健康 park，无需重放"直接跳过。TURN 表本身也可以
作为第二重信号（TURN 当前指向别的 phase → 跳过）。

## 下一步

按协议：本次 QA 报告 FAIL，commit + push 这份报告和回归测试到本分支后立即
`qa-result --status fail`，然后 STOP 等待——流水线会关闭本 QA session 并起一个新的
Implement-fix session 来修复上述问题。

修复后建议：Tadashi（flywheel-eng-lead）已确认——鉴于这是自举流水线基建本身（restart-
gated feature），ship 前仍需在隔离 529 QA Room 补一次真机全链 E2E（真 park→真 wake→
TURN 轮转→穿插 Bridge 重启→ship 统一收尾 + fix-loop cap 3），而不是 ship 了当生产
canary 去发现问题。这次发现的 reconcile bug 恰好会在 E2E 的"穿插 Bridge 重启"步骤里
复现，建议先修好这个再进 529 Room，否则会在那一步白白撞上同一个已知问题。
