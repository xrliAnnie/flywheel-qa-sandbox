# FLY-887 三段式 phase-session 并存保活 — 实施计划

Issue: FLY-887 (https://linear.app/geoforge3d/issue/FLY-887/pipeline-三段式-phase-session-并存保活-designimplementqa-不跑完就关qaimplement)
日期: 2026-07-05
基于: research.md
版本: v1.58.0（暂定，ship 取空号）
修订: R2（按 Annie steer 全面换到 🅱️ 单物理 worktree + TURN 轮流写、三段全 writer；
R1 的「QA 只读 checkout」模型已随 Lead 收回作废。**design_review 提交 hold 中——
等 Annie 对 exploration.md R2 提案 sanity-check OK 后才触发。**）

## 定案（Lead brainstorm gate 已批 A1-A6；worktree 并发 = Annie steer 🅱️）

三段式交接从「关人重开」改为「**park 保活 + wake-or-spawn + TURN 轮流写**」：

- 每段完成后 **park 不退出**（runner 自 park + Bridge 侧标记双保险），三段并存到 ship。
- **单物理 worktree**：整个 issue 只有一个 worktree（= 现状共享 key 的那个），创建一次、ship 后才删；三段 session 的 cwd 都指向它，**三段都是 writer**（设计 commit 文档、实现 commit 代码、QA commit 测试/报告——FLY-793 原协议全保留）。
- **TURN = 显式激活权**：任一时刻只有 TURN 持有者碰 worktree（写+跑测试），其余 parked 完全不碰。授予=PhaseOrchestrator 既有交接/唤醒点；释放=既有完成/verdict 信号；真相源=CommDB `three_stage_turn` 表（Bridge 独写）。机制全文与权威时序图见 exploration.md R2.2/R2.3。
- QA FAIL → **wake 活体 implement** 修（带全部 context）；fix 后 → **wake 同一 QA** 复验（worktree 已在新 head，零 checkout 编舞）；循环到 PASS。任一侧死体 → **spawn 兜底 = 现行为**。
- 只在 founder ship 批准 + verified merge 后统一 `finalizeDone` 收尾三段 + 删 worktree + archive thread。
- 不改 FSM、不动单 session / auto-QA / isQaRunner 路径（byte-compat，改动全在 `shareParentBranch`/phase-role 门内）。
- A5（内存代价）Lead 正在跟 Annie 确认。

## 目标运行时行为（Annie 六条 → 状态表）

| 时刻 | design | implement | QA | TURN 持有者 |
|---|---|---|---|---|
| 设计中 | running | — | — | design |
| 实现中 | design_done + parked | running | — | implement |
| QA 中 | parked | awaiting_review + parked | running（同一 worktree，可写） | QA |
| FAIL 修复中 | parked | woken 修复 | running + parked（等 RE-TEST） | implement |
| 复验中 | parked | 重新 parked | woken 复验（worktree 已在新 head） | QA |
| founder 批准→ship | parked | parked | approved_to_ship → ship | QA |
| merged 收尾 | finalizeDone→completed→关 | 同左 | completed→关 | —（worktree 此刻才删） |

不变量：任一时刻 TURN 只指向一个 phase；worktree 生命周期 = issue 生命周期；每次 TURN 授予/交还都落在既有 pipeline 信号上（零新事件类型）。

## 改动面（7 处 + 测试）

| # | 文件 | 改动 |
|---|---|---|
| 1 | `packages/teamlead/src/bridge/phase-orchestrator.ts` | `handoff()` park 化 + wake-or-spawn + TURN 授予；`runFailFlow()` wake 化 + 轮次账本换源；reconcile 适配；deps 扩展（`probePhaseAlive`/`parkPhaseRunner`/`wakePhaseRunner`/`getAlivePhaseSession`/`grantTurn`/`recordFixRound`/`countFixRounds`） |
| 2 | `packages/teamlead/src/bridge/plugin.ts` | 新 effects 接线：park（CommDB `upsertDeclaredState` + tmux 活体探测复用 tmux-lookup）、wake（`wakeRunnerMailbox` 直调，镜像 auto-qa-effects）、TURN 表读写、ship 收尾扩容调用 |
| 3 | `packages/flywheel-comm/src/db.ts` + 新 `src/commands/turn.ts` | CommDB 新表 `three_stage_turn(issue_id PK, holder_exec_id, phase, epoch, granted_at)`（幂等 CREATE TABLE IF NOT EXISTS，migration 同 `runner_declared_states` 模式）+ 新子命令 `turn --exec-id <id>`（答 yours/not-yours + holder；runner 写前自查 belt） |
| 4 | `packages/edge-worker/src/Blueprint.ts` | worktree 原地接手路径（implement/QA dispatch 遇活体前段 → 校验后复用，绝不 removeIfExists）；三段 prompts 改版（park 协议、翻转「Do NOT park」、TURN 契约；**QA writer 协议保留**） |
| 5 | `packages/teamlead/src/StateStore.ts` | `getPhaseSessionsForIssue(issueId)`（按 chat_thread_role）+ `countEventsByIssueAndType(issueId, type)` |
| 6 | ship 收尾链（`runPostShipFinalization`，DirectEventSink.ts:36 引入处 + 其定义模块） | 收尾扩到 issue 全部三段活体：逐个 `closeRunner({finalizeDone:true})` → 共享 worktree 删除（此刻才删）→ archive cascade 放行 |
| 7 | `packages/config/src/feature-flags/registry.ts` | 登记新 env `FLYWHEEL_THREE_STAGE_KEEPALIVE`（FLY-871 registry-drift 教训：新 env 必登记） |

**WorktreeManager 零改动**（R1 的 QA 独立 key 已作废——🅱️ 下三段共用现状 shared key，worktree key 派生一字不动）。

## 关键机制设计

### M1 park 化交接（handoff）

```
async handoff(prev, next):
  headSha = capturePhaseHeadSha(prev)          # 不变，fail-closed
  if (!keepAliveEnabled()) → 现行 close+spawn   # kill-switch =0 逐字回退
  alive = await deps.effects.probePhaseAlive(prev)   # tmux window 活体探测
  if (alive):
    await deps.effects.parkPhaseRunner(prev)   # CommDB upsertDeclaredState(execId,'parked',
                                               #   'three-stage phase parked awaiting pipeline', now, null)
                                               # 不 closeRunner、不删 worktree
  else:
    await deps.effects.closePhaseRunner(prev)  # 死体 → 现行 close-clean（worktree 收干净）
  target = deps.getAlivePhaseSession(prev.issue_id, next)
  if (target):
    deps.grantTurn(prev.issue_id, target.execution_id, next)      # 先记 TURN 再 wake
    await deps.effects.wakePhaseRunner({session: target, kind: 'retest', headSha})
  else:
    res = await startDispatcher.start({... 现行 dispatch ...})
    deps.grantTurn(prev.issue_id, res.executionId, next)
```

- `probePhaseAlive`：plugin 侧 `getTmuxTargetFromCommDb(execId, project)` + tmux 探测（复用 tmux-lookup 现有 helpers）。探测失败按死体处理（fallback = 现行为，绝不悬空）。
- **TURN 顺序**：先写 TURN 记录再 wake（wake 失败 → `runner_wake_failed` 事件 + held-for-reconcile 镜像 FLY-752；TURN 已指向目标，reconcile 重试 wake 幂等）。
- 释放语义：orchestrator 处理 `phase_design_complete` / `needs_review` / `qa-result` 事件时即认定上一持有者交还（TURN 在授予下一位时覆盖写，epoch+1；不需要显式"空档"状态）。

### M2 单 worktree 原地接手（Blueprint）

`Blueprint.runInner` worktree 准备段（现 :719-733）改为：

```
const phaseTakeover = ctx.shareParentBranch === true
  && (ctx.sessionRole === 'implement' || ctx.sessionRole === 'qa');
if (phaseTakeover && await worktreeManager.isRegistered(projectRoot, worktreePath)) {
  const clean = await gitWorktreeClean(worktreePath);
  const head  = await revParseHead(worktreePath);
  if (clean !== true || head !== ctx.startPoint) {
    throw new Error('worktree_takeover_failed: ...');   # fail-closed，绝不 removeIfExists 活人目录
  }
  cwd = worktreePath;                                    # 原地接手：不 remove、不 create
} else {
  现行 removeIfExists + create                            # 首段 design / 死体已清 / 非三段
}
```

- **fail-closed 语义**：接手校验不过 → throw（`worktree_takeover_failed`），orchestrator `failClosed` 升级 Lead，**绝不静默 remove**（parked 前段的 cwd 在里面）。
- worktree key、目录、branch 全部零变化（🅱️ = 现状结构 + 不删）。

### M3 QA FAIL → wake implement（runFailFlow 改版）

```
runFailFlow(qaSession, verdict):
  基础 refuse 分支不变（config off / 缺 project_name）
  round = deps.qaVerdicts.countFixRounds(issue) + 1        # 账本换源，见下
  if (round > maxFixRounds): refuse(cap 升级 Lead)          # cap=3 语义不变
  headSha = capturePhaseHeadSha(qaSession)                  # 语义照旧：QA 是 writer，
                                                            # findings 已 commit 在共享 worktree
  impl = deps.getAlivePhaseSession(issue, 'implement')
  if (impl):
    deps.qaVerdicts.recordFixRound(issue, verdict.eventId, round)   # 幂等，先记账后动作
    deps.grantTurn(issue, impl.execution_id, 'implement')
    await deps.effects.wakePhaseRunner({session: impl, kind: 'fix', round,
        qaSummary})                                         # findings 已在分支上，wake 带摘要即可
    patchIntent(qa, {fixExecId: impl.execution_id, round})
  else:
    现行 spawn implement-fix（close QA 不需要——QA 活着只是 park；worktree 死体清理后
    dispatch phaseFixContext @ headSha）+ 同样 recordFixRound   # 兜底=今天
  QA 自己由 prompt park（M6 文案）；Bridge 不 close QA
```

- **轮次账本换源**：`countImplementPhases`（数 session 行）在 wake 模式下永不增长 → 换成**幂等轮次事件**：`recordFixRound` = `store.insertEvent({event_id: 'fix-round-' + verdict.eventId, event_type: 'three_stage_fix_round', issue_id, payload:{round}})`（event_id 幂等，重放不重计）；`countFixRounds(issue)` = 新查询 `countEventsByIssueAndType(issueId,'three_stage_fix_round')`。durable、跨 session、跨重启；wake 路与 spawn 兜底路统一记账。
- **QA findings 通道不变**：FAIL 前 QA 已把 findings/failing tests/报告 commit 进 branch B（现行 :944 协议）——implement 醒来在同一 worktree 直接看到，wake 消息只需带摘要 + round。R1 的「报告文件路径引用」通道作废（不需要了）。
- verdict intent 从「一 session 一 verdict」放宽为**按轮**：`three_stage_verdict` 增加 `round` 字段；「已有 intent 即忽略新 verdict」守卫（:372-389）改为「同 round 幂等、新 round 换届」——FAIL 未走完的 round 继续走完（resume 语义保留）。

### M4 implement 修完 → wake QA 复验

- implement prompt（M6）：修完 push → Codex review 照旧 → 重跑 `gate approve_to_ship --no-block` + `complete --route needs_review`（FLY-191 生产已验形态；fix 轮 prompt :927 已是这个走法）。
- 触发点**零新增**：`session_completed` → `onPhaseComplete`（event-route.ts:2080 每事件必调，DirectEventSink.ts:725 同）→ `handoff(implement,'qa')` → M1 wake-or-spawn 找到活体 parked QA → grantTurn + `wakePhaseRunner({kind:'retest', headSha: 新 head})`。
- QA wake 消息：新 head + 指令「你的 worktree 已经在新 head（implement 在同一目录修的）——直接重跑场景，再发 qa-result」。**无 fetch/checkout 步骤。**
- **幂等**：wake 前查 QA intent 当前 round 是否已 retest-woken（intent patch `retestWokenAt` + head）；同一 head 重放事件不双 wake（镜像 FLY-752 durable retest 标记）。
- **守卫对齐**：merge_block session（FLY-869）不做任何 auto wake/spawn（镜像 event-route.ts:2059 suppressor）；触发条件与今天逐字同点，不新增/不移除 Codex gate 语义。

### M5 TURN 表 + turn 子命令（flywheel-comm）

- `db.ts`：`CREATE TABLE IF NOT EXISTS three_stage_turn (issue_id TEXT PRIMARY KEY, holder_exec_id TEXT NOT NULL, phase TEXT NOT NULL, epoch INTEGER NOT NULL, granted_at INTEGER NOT NULL)` + `grantTurn(issueId, execId, phase)`（epoch 自增覆盖写）+ `getTurn(issueId)`。Bridge 独写；runner 只读。
- 新子命令 `turn --exec-id <id>`：查本 session 的 issue 的 TURN 行 → stdout 打印 `yours` / `not-yours holder=<execId> phase=<phase>`（exit 0 都是；查询失败 exit 1）。runner 契约（M6 prompt）：凡不是被带 TURN 的 wake 叫醒，动 worktree 前必须 turn 自查；not-yours → 不写、只回话。
- ship 收尾时删除该 issue 的 TURN 行（M7）。

### M6 prompts（Blueprint 三段块）

- **design**（:903-909 追加）：
  > 5. After `complete --route phase_design_complete` succeeds: release heavy resources (close Claude-in-Chrome tabs; run `/compact` if your context is large), then run `node <comm> declare-state park --exec-id <id> --reason "three-stage design parked until ship"`, then STOP and WAIT. Do NOT exit and do NOT touch the worktree while parked — you have handed the TURN back. You stay alive as the design-context holder; if a wake message asks you a question, answer it (read-only) unless the wake explicitly grants you the TURN. The Bridge closes you after ship.
- **implement**（:911-928 追加 park + wake 契约）：
  > After `complete --route needs_review`: release heavy resources, `declare-state park --reason "three-stage implement parked awaiting QA"`, STOP and WAIT. Never touch the worktree while parked.
  > When woken with a QA FIX message (the wake grants you the TURN): the QA phase's findings / failing tests / report are ALREADY COMMITTED on this branch — read them first, fix exactly what they name in THIS worktree, push, re-run Codex review, then re-request review (`gate approve_to_ship --no-block` + `complete --route needs_review`), then park again and WAIT.
  > If you are woken by any message that does NOT explicitly grant the TURN, run `node <comm> turn --exec-id <id>` before touching the worktree; if it says not-yours, reply without writing.
- **QA**（:938-944 修订——**writer 协议主体保留**）：
  > （步骤 1-4 现行文案保留：同一 branch 验证、commit 测试+QA report 到 THIS branch、push、PASS → qa-result pass + APPROVE GATE 流。）
  > 5. On FAIL: commit + push your findings/failing tests to this branch FIRST (unchanged), then `qa-result --status fail --summary ...`, then release heavy resources and `declare-state park --reason "three-stage QA awaiting implement fix"`, then STOP and WAIT for a RE-TEST wake — the implementer (alive, with full context) fixes on this same branch and the pipeline wakes you to re-verify. Your worktree will already be at the new head when you wake — re-run your scenarios directly. Do NOT run `complete`, do NOT open the approve gate on FAIL.（删除旧「Do NOT park for retest」「the pipeline closes this session」句。）
- 三段共同追加一行 TURN 契约（见 implement 段第三句，design/QA 同款）。

### M7 ship 后统一收尾

- Hook 在既有 `runPostShipFinalization`（DirectEventSink.ts:36 引入；merge-evidence gated）：新增 `finalizeThreeStagePhases(issueId)` —— `store.getPhaseSessionsForIssue(issueId)` 取 chat_thread_role ∈ {design, implement} 且状态 ∈ FINALIZE_DONE_SOURCE_STATES 的 session，逐个 `closeRunner({finalizeDone:true, transitionOpts})`（FSM 边合法：design_done/awaiting_review → completed），随后共享 worktree 清理（**此刻才删**，复用 phaseWorktreeCleanup）+ 删 TURN 行。
- archive cascade（FLY-369）本就 gate 在「completed + 无其他 active runner」——三段全关后自然放行，不改 cascade。
- 漏收兜底：FLY-742 stale-blocker guard（PR merged 后 authoritative 检查会收）保持为第二道网。

### M8 reconcile / 重启韧性

- `reconcileOnStartup`：stranded design_done 的重驱走同一 `handoff`（M1 已 wake-or-spawn 化，天然不双开——`getAlivePhaseSession` 先查活体）。
- QA verdict sweeps（FLY-859 (a)(b)(c)）保留；replay 进 `onQaResult` → intent round 幂等守卫（M3）保证重放安全。
- 重启后 park 标记在 CommDB（FLY-626 持久）；TURN 行同库同持久；tmux 活体过重启（FLY-172）；死 parked runner 被 HeartbeatService 收割 → 后续 wake-or-spawn 自动落到 spawn 兜底；TURN 指向死 session 时 reconcile 按流水线当前态重新授予。

### M9 kill-switch

`FLYWHEEL_THREE_STAGE_KEEPALIVE`（默认 ON；`=0` → M1-M4/M6 全部回退现行 close+spawn+重建，M5 表闲置、M7/M8 扩容按「无活体可收」自然 no-op）。判定收口在 orchestrator 一处 `keepAliveEnabled()` + Blueprint 接手判定一处（两处同 env，registry 登记一条）。three-stage 本身仍由 `pipeline.three_stage` opt-in——两开关正交。

## 实施步骤（TDD：每步先失败测试 → 最小实现 → 全绿 → commit）

### Step 1 — CommDB TURN 表 + turn 子命令
- RED：`grantTurn` 覆盖写 + epoch 自增；`getTurn` 读；`turn --exec-id` 对 yours/not-yours/无行 三态输出契约；migration 幂等（二次 open 不炸）。
- GREEN：db.ts 表 + 两方法 + commands/turn.ts。

### Step 2 — StateStore 新查询
- RED：`getPhaseSessionsForIssue` 按 issue 返回 chat_thread_role ∈ {design,implement,qa} 的行（含状态过滤）；`countEventsByIssueAndType` 精确计数 + event_id 幂等重放不重计。哨兵：非三段 issue 返回空/0。
- GREEN：两个 SQL 方法（现有 sessions/events 表，无 schema 迁移）。

### Step 3 — Blueprint worktree 原地接手
- RED（注入 fake WorktreeManager/exec）：implement/qa 段 + registered+clean+HEAD==startPoint → 不调 removeIfExists/create、cwd=worktreePath；校验任一不过 → throw `worktree_takeover_failed`（不静默 remove）；未注册（前段死体已清）→ 现行 create；design 首段 / kill-switch=0 / 非三段 → 现行路径逐字（哨兵）。
- GREEN：M2 判定块。

### Step 4 — PhaseOrchestrator handoff park 化 + wake-or-spawn + TURN
- RED（fake deps）：活体前段 → parkPhaseRunner 被调且 closePhaseRunner 不被调；死体 → closePhaseRunner（现行）；活体 parked 下段 → grantTurn 先于 wakePhaseRunner 且不 dispatch；无下段 → dispatch（现行参数逐字）+ grantTurn；capture head 失败 → fail-closed 不变；kill-switch=0 → 全现行路径（哨兵）。
- GREEN：M1 逻辑 + deps 接口扩展 + plugin 接线（probePhaseAlive/park/wake/grantTurn effects）。

### Step 5 — runFailFlow wake 化 + 轮次账本
- RED：活体 implement → recordFixRound（幂等：同 verdict eventId 重放只记一次）+ grantTurn + wakePhaseRunner(kind:'fix') + intent patch；死体 → spawn 兜底（现行 dispatch 参数 + 同样记账）；round>cap → refuse 升级（文案含轮数）；intent round 换届语义（新 round 的 verdict 不被旧 intent 吞）。
- GREEN：M3 全量。

### Step 6 — QA 复验 wake（二次 needs_review）
- RED：implement 二次 `session_completed`(awaiting_review) → handoff('qa') → 活体 QA → grantTurn + retest wake（内容含新 head + 「worktree 已在新 head」）+ `retestWokenAt` 幂等（同 head 重放不双 wake）；QA 死体 → spawn 新 QA（现行）；merge_block session → 全程 no-op。
- GREEN：M4（大部分由 Step 4 覆盖，本步补 retest 专属幂等 + 守卫）。
- **验证补钉**：event-route 级集成测试钉死「FSM no-op（awaiting_review→awaiting_review 拒绝）时 session_completed 事件仍到达 onPhaseComplete」（research §6.1；complete.ts 每次调用独立 POST /events 已核实）。

### Step 7 — 三段 prompts
- RED：Blueprint prompt 快照断言——design/implement 含 park 指令与 TURN 契约；QA 保留 writer 步骤（commit tests/report to THIS branch）、FAIL 段含 park/RE-TEST、不含「Do NOT park」「the pipeline closes this session」旧句；单 session/auto-QA prompt 逐字不变（哨兵）。
- GREEN：M6 文案。

### Step 8 — ship 收尾扩容
- RED：merged 收尾触发 `finalizeThreeStagePhases` → 两个 parked 段 closeRunner(finalizeDone) 按序调用 → 共享 worktree 清理 + TURN 行删除 → archive cascade 在全关后放行；单 session issue → no-op（哨兵）。
- GREEN：M7。

### Step 9 — reconcile 适配
- RED：重启 replay：stranded design_done + 活体 implement 已在 → 不双 spawn（adopt/wake）；FAIL round 半程（recordFixRound 已记、wake 未确认）→ replay 续走不重计；TURN 指向死 session → 重授予。
- GREEN：M8（大部分复用 Step 4/5 判定）。

### Step 10 — kill-switch + registry
- RED：registry 含 `FLYWHEEL_THREE_STAGE_KEEPALIVE` 条目（FLY-871 drift 哨兵 pattern）；`=0` 下 Step 3/4/5/6 的所有哨兵路径全过。
- GREEN：M9。

### Step 11 — 收口
- 全仓 `pnpm lint` + 全测试套；push 前跑（房子纪律）。
- 真机 E2E（529 Room / 或 flywheel 本体 dogfood）：一条三段 issue 全链 —— design park→implement 原地接手 worktree→QA 同 worktree 验证→注入 FAIL→wake implement 修→wake QA 复验（确认零 checkout 编舞）→PASS→founder gate→ship→三段统一收尾+worktree 删除+archive。穿插一次 Bridge 重启验证 park/TURN/活体全存活。**QA 阶段由独立 QA session 验，不自证**。

## 测试计划汇总

- 单测：Step 1-10 各 RED 集（orchestrator fake-deps 套用现有 `__tests__/phase-orchestrator` 模式；Blueprint 用注入 fake；CommDB 用临时库）。
- byte-compat 哨兵：非三段全路径逐字（prompt 快照 / dispatch 参数 / worktree 路径决策）+ kill-switch=0 回退全套 + WorktreeManager 零改动断言。
- 集成：event-route 二次 needs_review 事件到达性；insertEvent 幂等轮次；TURN grant→wake 顺序。
- 真机：Step 11 全链 + Bridge 重启穿插（park 标记/TURN/活体存活/不双开）。

## 风险 / 边界（照 research §5 + R2）

- 内存 3 进程/issue：park 前 /compact + 释放 Chrome（prompt 硬要求）；three-stage 仅 flywheel opt-in；A5 待 Annie 准话。
- 双写者：TURN（Bridge 独写）+ parked-不碰-worktree 纪律 + runner 写前 turn 自查；同刻激活段唯一；git 冲突为可见兜底。
- watchdog：park 标记全抑制（FLY-626）；`parked-alive` 分类已有；识别缺口归 FLY-878 不重做。
- 与 FLY-869 的 merge_block / QA-done gate：守卫镜像，不动其语义。
- 回退：`FLYWHEEL_THREE_STAGE_KEEPALIVE=0` 单开关回现行；再往上 `pipeline.three_stage=false` 回单 session。

## 交付 / 验收

- 本文档由 **Design phase**（本 session）产出并 commit 到分支；**Implement phase** 在同分支按本计划 TDD 执行。
- 验收 = Step 11 真机全链 PASS + Annie 六条逐条对照（本计划「目标运行时行为」表）+ Codex code review APPROVED + 独立 QA。
