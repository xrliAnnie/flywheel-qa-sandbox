# FLY-887 三段式 phase-session 并存保活 — 实施计划

Issue: FLY-887 (https://linear.app/geoforge3d/issue/FLY-887/pipeline-三段式-phase-session-并存保活-designimplementqa-不跑完就关qaimplement)
日期: 2026-07-05
基于: research.md
版本: v1.58.0（暂定，ship 取空号）

> ⚠️ **R1 草稿 — 部分被收回的约束污染，待 Annie sanity-check 🅱️ 提案后重写 R2。**
> 本稿 M2/M3/M7 基于 Lead 初版「QA 只读 checkout」约束，该约束已被 Annie 亲自纠正收回
> （三段都是 writer；worktree 并发定案 = 🅱️ 单物理 worktree + TURN 轮流写，见
> exploration.md R2）。M1（park 化交接）/ M4 触发点 / M5（ship 收尾）/ M6（reconcile）/
> M8（kill-switch）与轮次账本设计仍然成立，R2 将保留这些、把 worktree/QA 相关段落换成
> 🅱️ + TURN。**本稿未经 Annie OK，不进 design review、不作为实现依据。**

## 定案（Lead brainstorm gate 已批 A1-A6 + worktree 图约束）

三段式交接从「关人重开」改为「**park 保活 + wake-or-spawn**」：

- 每段完成后 **park 不退出**（runner 自 park + Bridge 侧标记双保险），三段并存到 ship。
- QA FAIL → **wake 活体 implement** 修（带全部 context）；fix 后 → **wake 同一 QA** 复验；循环到 PASS。任一侧死体 → **spawn 兜底 = 现行为**。
- worktree 按 Lead 给 Annie 的图：**可写 worktree 在 design→implement 传递（原地复用不重建）；QA 用独立 pinned 只读 checkout**（结构必然：branch B 无法二次 checkout，见 research §1.3/§3）。
- 只在 founder ship 批准 + verified merge 后统一 `finalizeDone` 收尾三段 + archive thread。
- 不改 FSM、不动单 session / auto-QA / isQaRunner 路径（byte-compat，改动全在 `shareParentBranch`/phase-role 门内）。
- A5（内存代价）已由 Lead 转 Annie 知情确认（plan 进 design review 前由 Lead 给准话）。

## 目标运行时行为（Annie 六条 → 状态表）

| 时刻 | design | implement | QA | 可写 worktree 持有者 |
|---|---|---|---|---|
| 设计中 | running | — | — | design |
| 实现中 | design_done + parked | running | — | implement |
| QA 中 | design_done + parked | awaiting_review + parked | running（只读 checkout） | implement（parked，不动） |
| FAIL 修复中 | parked | awaiting_review + **woken 修复** | running + parked（等 RE-TEST） | implement |
| 复验中 | parked | 重新 parked | woken 复验（re-pin 新 head） | implement（parked） |
| founder 批准→ship | parked | parked | approved_to_ship → ship | implement（parked） |
| merged 收尾 | finalizeDone→completed→关 | 同左 | completed→关 | 共享 worktree 此刻才删；QA checkout 同删 |

## 改动面（7 文件 + 测试）

| # | 文件 | 改动 |
|---|---|---|
| 1 | `packages/teamlead/src/bridge/phase-orchestrator.ts` | `handoff()` park 化 + wake-or-spawn；`runFailFlow()` wake 化 + 轮次账本换源；reconcile 适配；deps 扩展（`probePhaseAlive`/`parkPhaseRunner`/`wakePhaseRunner`/`getAlivePhaseSession`/`recordFixRound`/`countFixRounds`） |
| 2 | `packages/teamlead/src/bridge/plugin.ts` | 新 effects 接线：park（CommDB `upsertDeclaredState` + tmux 活体探测）、wake（`wakeRunnerMailbox` 直调，镜像 auto-qa-effects）、活体判定、ship 收尾扩容调用 |
| 3 | `packages/edge-worker/src/WorktreeManager.ts` | `resolveWorktreeKey`：`shareParentBranch && sessionRole==='qa'` → `<identifier>-qa` 独立 key（design/implement 仍共享 main key） |
| 4 | `packages/edge-worker/src/Blueprint.ts` | worktree 复用路径（活体前段→校验后跳过 removeIfExists+create）；三段 prompts 改版（park 协议、翻转「Do NOT park」、QA 只读纪律） |
| 5 | `packages/teamlead/src/StateStore.ts` | `getPhaseSessionsForIssue(issueId)`（按 chat_thread_role）+ `countEventsByIssueAndType(issueId, type)` |
| 6 | ship 收尾链（`event-route.ts` merged 分支 / post-ship finalization 所在处，实现时以 grep `runPostShipFinalization` 定位） | 收尾扩到 issue 全部三段活体：逐个 `closeRunner({finalizeDone:true})` → 共享 worktree + QA checkout 删除 → archive cascade 放行 |
| 7 | `packages/config/src/feature-flags/registry.ts` | 登记新 env `FLYWHEEL_THREE_STAGE_KEEPALIVE`（FLY-871 registry-drift 教训：新 env 必登记） |

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
                                               # 不 closeRunner、不 phaseWorktreeCleanup
  else:
    await deps.effects.closePhaseRunner(prev)  # 死体 → 现行 close-clean（worktree 收干净）
  target = deps.getAlivePhaseSession(prev.issue_id, next)
  if (target): await deps.effects.wakePhaseRunner({session: target, kind: 'retest', headSha, ...})
  else:        await startDispatcher.start({... 现行 dispatch ...})
```

- `probePhaseAlive`：plugin 侧 `getTmuxTargetFromCommDb(execId, project)` + `tmux has-session/list-windows` 探测（复用 tmux-lookup 现有 helpers）。探测失败按死体处理（fallback = 现行为，绝不悬空）。
- `parkPhaseRunner` **绝不删 worktree** —— 可写 worktree 原地传递给下一段（M2）。
- Bridge 侧 park 标记是**双保险**（runner prompt 也自 park，M7）：任一侧生效即不误报 stall（FLY-626 watchdog 抑制）。

### M2 worktree 传递与复用（Blueprint）

`Blueprint.runInner` worktree 准备段（现 :719-733）改为：

```
const reuse = ctx.shareParentBranch === true
  && ctx.sessionRole === 'implement'          # 只有 implement 接手可写 worktree
  && await worktreeManager.isRegistered(projectRoot, worktreePath)
  && await gitWorktreeClean(worktreePath) === true
  && (await revParseHead(worktreePath)) === ctx.startPoint;
if (reuse) { cwd = worktreePath; }            # 原地复用：不 removeIfExists、不 create
else       { 现行 removeIfExists + create }    # 首段 design / 死体兜底 / 校验失败
```

- **校验失败 fail-closed 语义**：校验不过而共享 worktree 又有活体 parked 前段 → 该 dispatch 本来就是 orchestrator 发起的，orchestrator 在 dispatch 前已 park 前段；Blueprint 侧兜底走 removeIfExists 会拆活人 —— 所以 reuse 判定**不过时必须 throw**（带 `worktree_reuse_failed` 原因），由 orchestrator 的 `failClosed` 升级 Lead，**不许静默 remove**。仅当共享 worktree 不存在/未注册（前段死体已被 close-clean）才走现行 create 路径。
- QA phase：`resolveWorktreeKey` 返回 `<identifier>-qa` → 独立目录独立 branch（`<slug>-<identifier>-qa`），`startPoint = reviewed head`（现有 `ctx.startPoint` 机制），**结构上碰不到 branch B**。`-B` 冲突（research §1.3）消失。
- key 派生一致性（FLY-603）：ship 收尾/reconciler 清理对 QA 段用同一 qa key 派生（M6）。

### M3 QA FAIL → wake implement（runFailFlow 改版）

```
runFailFlow(qaSession, verdict):
  基础 refuse 分支不变（config off / 缺 project_name）
  round = deps.qaVerdicts.countFixRounds(issue) + 1        # ← 账本换源，见下
  if (round > maxFixRounds): refuse(cap 升级 Lead)          # cap=3 语义不变
  impl = deps.getAlivePhaseSession(issue, 'implement')
  if (impl):
    deps.qaVerdicts.recordFixRound(issue, verdict.eventId, round)   # 幂等，先记账后动作
    await deps.effects.wakePhaseRunner({session: impl, kind: 'fix',
        round, qaSummary, qaReportPath})                     # mailbox send，send 即清 impl 的 park 标记
    patchIntent(qa, {fixExecId: impl.execution_id, round})
  else:
    现行 spawn implement-fix（capture reviewed head → dispatch phaseFixContext）  # 兜底=今天
  QA 自己由 prompt park（M7）；Bridge 不 close QA
```

- **轮次账本换源**：`countImplementPhases`（数 session 行）在 wake 模式下永不增长 → 换成**幂等轮次事件**：`recordFixRound` = `store.insertEvent({event_id: 'fix-round-' + verdict.eventId, event_type: 'three_stage_fix_round', issue_id, payload:{round}})`（insertOnce 幂等，重放不重计）；`countFixRounds(issue)` = 新 StateStore 查询 `countEventsByIssueAndType(issueId,'three_stage_fix_round')`。durable、跨 session、跨重启。spawn 兜底路径同样记账（替代 countImplementPhases 语义，两路统一）。
- **head 语义简化**（research §3.4）：QA 只读无 commit → 不再 capture QA 头；fix 基线 = implement 的 reviewed head（已在 handoff 时传给 QA 的 `startPoint`，随 intent 持久）。
- **QA 报告通道**：wake 内容 = summary（600 cap 不变，作索引）+ QA checkout 内报告文件的绝对路径（QA prompt 要求 FAIL 时把完整报告写到自己 checkout 的 `qa-report-round-N.md`，本地文件不 push —— 与只读纪律自洽）+ 修复指令。implement 直接读该路径。
- verdict intent 从「一 session 一 verdict」放宽为**按轮**：`three_stage_verdict` 增加 `round` 字段；「已有 intent 即忽略新 verdict」的守卫（:372-389）改为「同 round 幂等、新 round 换届」——resume 语义保留（fail 未走完的 round 继续走完）。

### M4 implement 修完 → wake QA 复验

- implement prompt（M7）：修完 push → Codex review 照旧 → 重跑 `gate approve_to_ship --no-block` + `complete --route needs_review`（FLY-191 生产已验形态；fix 轮 prompt :927 已是这个走法）。
- 触发点**零新增**：`session_completed` → `onPhaseComplete`（event-route.ts:2080 每事件必调）→ `handoff(implement,'qa')` → M1 的 wake-or-spawn 找到活体 parked QA → `wakePhaseRunner({kind:'retest', headSha: 新 head})`。
- QA wake 消息：新 reviewed head + 指令「fetch + 把你的只读 checkout re-pin 到新 head（git fetch origin && git checkout --detach <sha> 或 reset）→ 重跑场景 → 再发 qa-result」。
- **幂等**：wake 前查 QA intent 当前 round 是否已 retest-woken（intent patch `retestWokenAt` + head）；同一 head 重放事件不双 wake（镜像 FLY-752 durable retest 标记）。
- **守卫对齐**：merge_block session（FLY-869）不做任何 auto wake/spawn（镜像 event-route.ts:2059 suppressor）；触发条件与今天逐字同点，不新增/不移除 Codex gate 语义。

### M5 ship 后统一收尾

- Hook 在既有 post-ship finalization（verified merge → landing merged → QA `stage set completed` 的收尾链）：新增 `finalizeThreeStagePhases(issueId)` —— `store.getPhaseSessionsForIssue(issueId)` 取 chat_thread_role ∈ {design, implement} 且状态 ∈ FINALIZE_DONE_SOURCE_STATES 的 session，逐个 `closeRunner({finalizeDone:true, transitionOpts})`（FSM 边合法：design_done/awaiting_review → completed），随后共享 worktree `phaseWorktreeCleanup`（**此刻才删**）+ QA checkout（qa key）`removeIfExists`。
- archive cascade（FLY-369）本就 gate 在「completed + 无其他 active runner」——三段全关后自然放行，不改 cascade。
- 漏收兜底：FLY-742 stale-blocker guard（PR merged 后 authoritative 检查会收）保持为第二道网。

### M6 reconcile / 重启韧性

- `reconcileOnStartup`：stranded design_done 的重驱走同一 `handoff`（M1 已 wake-or-spawn 化，天然不双开——`getAlivePhaseSession` 先查活体）。
- QA verdict sweeps（FLY-859 (a)(b)(c)）保留；replay 进 `onQaResult` → intent round 幂等守卫（M3）保证重放安全。
- 重启后 park 标记在 CommDB（FLY-626 持久）；tmux 活体过重启（FLY-172）；死 parked runner 被 HeartbeatService 收割 → 后续 wake-or-spawn 自动落到 spawn 兜底。

### M7 prompts（Blueprint 三段块）

- **design**（:903-909 追加）：
  > 5. After `complete --route phase_design_complete` succeeds: release heavy resources (close Claude-in-Chrome tabs; run `/compact` if your context is large), then run `node <comm> declare-state park --exec-id <id> --reason "three-stage design parked until ship"`, then STOP and WAIT. Do NOT exit, do NOT touch the worktree again unless a wake message instructs you. You stay alive as the design-context holder for the whole pipeline; the Bridge closes you after ship.
- **implement**（:911-928 改）：完成步骤后追加同款 park 指令（reason "three-stage implement parked awaiting QA"）+ wake 契约：
  > When woken with a QA FIX message: read the QA report (path in the message), fix exactly what it names on THIS branch, push, re-run Codex review, then re-request review (`gate approve_to_ship --no-block` + `complete --route needs_review`), then park again and WAIT. Never touch the worktree while parked.
- **QA**（:938-944 重写）：只读纪律 + park/retest：
  > Your checkout is READ-ONLY: verify at the pinned reviewed commit; NEVER push to the shared branch, NEVER open the writable worktree. Write your full QA report to `qa-report-round-N.md` INSIDE your own checkout (local file, not committed).
  > On PASS: `qa-result --status pass` → APPROVE GATE flow（不变，QA 仍是 ship-gate holder + ship executor）。
  > On FAIL: `qa-result --status fail --summary ...` → release heavy resources → `declare-state park --reason "three-stage QA awaiting implement fix"` → STOP and WAIT for a RE-TEST wake（翻转原「Do NOT park」禁令）。Do NOT `complete`, do NOT open the approve gate on FAIL.
- 现 :941-944 的「commit tests to B / push findings to B」全部移除（Annie 2026-07-02 的 writer 决定被本次 Lead 图**有意替换** —— design review 请显式确认此 supersede）。

### M8 kill-switch

`FLYWHEEL_THREE_STAGE_KEEPALIVE`（默认 ON；`=0` → M1-M4/M7 全部回退现行 close+spawn+重建，M5/M6 的收尾扩容按「无活体可收」自然 no-op）。判定收口在 orchestrator 一处 `keepAliveEnabled()` + Blueprint 复用判定一处（两处同 env，registry 登记一条）。three-stage 本身仍由 `pipeline.three_stage` opt-in——两开关正交。

## 实施步骤（TDD：每步先失败测试 → 最小实现 → 全绿 → commit）

### Step 1 — StateStore 新查询
- RED：`getPhaseSessionsForIssue` 按 issue 返回 chat_thread_role ∈ {design,implement,qa} 的行（含状态过滤）；`countEventsByIssueAndType` 精确计数 + insertOnce 幂等重放不重计。哨兵：两方法对非三段 issue 返回空/0。
- GREEN：两个 SQL 方法（现有 sessions/events 表，无 schema 迁移）。

### Step 2 — resolveWorktreeKey QA 独立 key
- RED：`resolveWorktreeKey('FLY-1',{shareParentBranch:true,sessionRole:'qa'})==='FLY-1-qa'`；design/implement 仍 `'FLY-1'`；非 shareParentBranch 全组合逐字不变（byte-compat 哨兵表）。
- GREEN：`:83` 一行分支。**同步排查**所有 `resolveWorktreeKey`/`deriveWorktreeKey` 调用点（FLY-603 cleanup、post-ship、reconciler）对 qa 段的 key 一致性，逐点加断言。

### Step 3 — Blueprint worktree 复用路径
- RED（用注入的 fake WorktreeManager/exec）：implement 段 + registered+clean+HEAD==startPoint → 不调 removeIfExists/create、cwd=worktreePath；校验任一不过 → throw `worktree_reuse_failed`（不静默 remove）；worktree 不存在 → 现行 create；design 首段 / kill-switch=0 / 非三段 → 现行路径逐字（哨兵）。
- GREEN：M2 判定块。

### Step 4 — PhaseOrchestrator handoff park 化 + wake-or-spawn
- RED（fake deps）：活体前段 → parkPhaseRunner 被调且 closePhaseRunner 不被调；死体 → closePhaseRunner（现行）；活体 parked 下段 → wakePhaseRunner 且不 dispatch；无下段 → dispatch（现行参数逐字）；capture head 失败 → fail-closed 不变；kill-switch=0 → 全现行路径（哨兵）。
- GREEN：M1 逻辑 + deps 接口扩展 + plugin 接线（probePhaseAlive/park/wake effects）。

### Step 5 — runFailFlow wake 化 + 轮次账本
- RED：活体 implement → recordFixRound（幂等：同 verdict eventId 重放只记一次）+ wakePhaseRunner(kind:'fix') + intent patch；死体 → spawn 兜底（现行 dispatch 参数 + 同样记账）；round>cap → refuse 升级（文案含轮数）；intent round 换届语义（新 round 的 verdict 不被旧 intent 吞）。
- GREEN：M3 全量。

### Step 6 — QA 复验 wake（二次 needs_review）
- RED：implement 二次 `session_completed`(awaiting_review) → handoff('qa') → 活体 QA → retest wake（内容含新 head）+ `retestWokenAt` 幂等（同 head 重放不双 wake）；QA 死体 → spawn 新 QA（pinned 新 head，现行）；merge_block session → 全程 no-op。
- GREEN：M4（大部分由 Step 4 的 wake-or-spawn 覆盖，本步补 retest 专属幂等 + 守卫）。
- **验证补钉**：加一个 event-route 级集成测试钉死「FSM no-op（awaiting_review→awaiting_review 拒绝）时 session_completed 事件仍到达 onPhaseComplete」（research §6.1）。

### Step 7 — 三段 prompts
- RED：Blueprint prompt 快照断言——design/implement 含 park 指令与 wake 契约；QA 含只读纪律 + FAIL park/retest、不含「commit tests to B」「Do NOT park」旧文案；单 session/auto-QA prompt 逐字不变（哨兵）。
- GREEN：M7 文案。

### Step 8 — ship 收尾扩容
- RED：merged 收尾触发 `finalizeThreeStagePhases` → 两个 parked 段 closeRunner(finalizeDone) 按序调用 → 共享 worktree 清理 + QA checkout 清理被调 → archive cascade 在全关后放行；单 session issue → no-op（哨兵）。
- GREEN：M5。

### Step 9 — reconcile 适配
- RED：重启 replay：stranded design_done + 活体 implement 已在 → 不双 spawn（adopt/wake）；FAIL round 半程（recordFixRound 已记、wake 未确认）→ replay 续走不重计。
- GREEN：M6（大部分复用 Step 4/5 判定）。

### Step 10 — kill-switch + registry
- RED：registry 含 `FLYWHEEL_THREE_STAGE_KEEPALIVE` 条目（FLY-871 drift 哨兵 pattern）；`=0` 下 Step 3/4/5/6 的所有哨兵路径全过。
- GREEN：M8。

### Step 11 — 收口
- 全仓 `pnpm lint` + 全测试套；push 前跑（房子纪律）。
- 真机 E2E（529 Room / 或 flywheel 本体 dogfood）：一条三段 issue 全链 —— design park→implement 复用 worktree→QA 只读 checkout→注入 FAIL→wake implement 修→wake QA 复验→PASS→founder gate→ship→三段统一收尾+archive。**QA 阶段由独立 QA session 验，不自证**（auto-QA 会照 FLY-579 流程接管）。

## 测试计划汇总

- 单测：Step 1-10 各 RED 集（orchestrator fake-deps 套用现有 `__tests__/phase-orchestrator` 模式；Blueprint 用注入 fake）。
- byte-compat 哨兵：非三段全路径逐字（prompt 快照 / worktree key 表 / dispatch 参数）+ kill-switch=0 回退全套。
- 集成：event-route 二次 needs_review 事件到达性；insertEvent 幂等轮次。
- 真机：Step 11 全链 + Bridge 重启穿插（park 标记/活体存活/不双开）。

## 风险 / 边界（照 research §5）

- 内存 3 进程/issue：park 前 /compact + 释放 Chrome（prompt 硬要求）；three-stage 仅 flywheel opt-in；A5 待 Annie 准话。
- 双写者：QA 只读后可写 worktree 单持有者=design→implement 传递；park 纪律 + wake 唯一激活信号；git 冲突为可见兜底。
- watchdog：park 标记全抑制（FLY-626）；`parked-alive` 分类已有；识别缺口归 FLY-878 不重做。
- 与 FLY-869 的 merge_block / QA-done gate：守卫镜像，不动其语义。
- 回退：`FLYWHEEL_THREE_STAGE_KEEPALIVE=0` 单开关回现行；再往上 `pipeline.three_stage=false` 回单 session。

## 交付 / 验收

- 本文档由 **Design phase**（本 session）产出并 commit 到分支；**Implement phase** 在同分支按本计划 TDD 执行。
- 验收 = Step 11 真机全链 PASS + Annie 六条逐条对照（本计划「目标运行时行为」表）+ Codex code review APPROVED + 独立 QA。
