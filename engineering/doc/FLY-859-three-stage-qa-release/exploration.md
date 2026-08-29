# FLY-859 三段式 QA PASS 放行缺口 — 探索

Issue: FLY-859 (https://linear.app/geoforge3d/issue/FLY-859/batch-gap三段式-qa-pass-放行-foundership-未实现deferred)
日期: 2026-07-04
基于: 无(上游 = FLY-793 plan Step 5/8 + FLY-849 组合 QA 报告 #440 §3.8)

## 1. 问题(审计确认)

三段式 pipeline(FLY-793,已 merge `3ebc6663`)跑到 QA phase 就断:QA phase 发出的
`qa_result` 落进 `AutoQaCoordinator.onQaResult`(`event-route.ts:625` 唯一路由),被两道
为 auto-QA(FLY-579)模型设计的闸丢弃:

1. **parent-state guard**(`auto-qa-coordinator.ts:551`)— verdict 的 targetExec(implement
   exec)在 Implement→QA 交接时已被 `closePhaseRunner(finalizeDone:true)` 转成 `completed`
   (`plugin.ts:3763`),不是 `awaiting_review` → ignored。
2. **AutoQaRecord guard**(`:594`)— 三段 QA 由 `PhaseOrchestrator` 派发、非 `spawnQa`,
   `auto_qa_record` 零行 → ignoring。

结果 = FLY-849 组合 QA §3.8 的观察:三 phase 全 `completed`、无 founder gate、ship/finalization
不 fire。**这是 merged-793-alone 的必然行为,不是回归**——plan Step 8 的 NEW
`ThreeStageQaCoordinator`(Model A:PASS→放行 founder/ship;FAIL→起 Implement-fix)当时被
defer,merged 793 里零实现(`grep -rn ThreeStageQaCoordinator packages/` 无代码命中;
`phase-orchestrator.ts:147` 明确 `nextPhase(qa)=null → return // Step 8`)。

## 2. 待定问题的答案:FLY-795(#436)实现了吗?

**没有。** #436 全部内容 = restart-resilient resume(`progress.md` 执行游标 + 重启续跑),
diff 中 `ThreeStageQaCoordinator` / `qa_result` / `onQaResult` **零命中**(逐文件核对)。
795 立项后转向了 FLY-709 的重启韧性方向,当初「defer 到 795」的 QA 收尾组件没有跟过去。
→ **batch 真缺口成立**,FLY-859 补齐它,793-batch 才能 enable three_stage。

## 3. Model A 设计点:QA 关闭后谁持 awaiting_review / 谁执行 ship?

这是 issue 点名的未决设计域。审计三个候选:

### 方案 A(选定):QA phase 自己 = ship gate 持有者 + ship 执行者

QA runner `qa-result pass` 之后**不关闭**,接着走标准 APPROVE GATE 流:
`gate approve_to_ship --no-block` → `complete --route needs_review --pr <N>` →
session 落 `awaiting_review` 持 gate → GatePoller 既有 relay 通知 founder →
founder 批准 → `verify-approval` → QA runner 自己 `:cool:` ship → 既有
post-ship finalization 收尾(关 tmux/worktree、archive threads、Linear Done)。

**为什么选它**:
- **849 §3.5 已真机验证过这条机制**:第一轮 E2E 里 tester 手动模拟 QA phase 正是
  「QA session 落 awaiting_review → gate → respond approved → approved_to_ship →
  runPostShipFinalization」,全链 PASS。方案 A 只是把手动模拟变成 QA runner 的真实指令。
- **与 FLY-799(#426)的「runner self-ships」模型一致**:批准时刻必须有一个活 runner
  执行 ship(799 的 re-wake reconciler 对 dead runner 只告警不代 ship)。三段里
  Design/Implement 都已按 plan Step 4 关闭,QA 是唯一还活着的 runner。
- **零新增 founder-facing 机制**:gate relay、verify-approval、self-ship、finalization
  全部复用,新代码只在 Bridge 侧 FAIL 分支 + 提示词 sequencing。
- FLY-579 的「QA 不绿不打扰 founder」不破:founder gate 由 QA runner 在 PASS **之后**
  才打开,结构上先绿后扰。

### 方案 B(否):Bridge 代 QA 开 gate / 合成 awaiting_review

Bridge 侧合成 gate question + review 绑定 + FSM 转移 = 复制一整套 runner CLI 已有的
可信写路径,新增授权面,和 799「write authority unchanged」相抵触。放弃。

### 方案 C(否):Implement 段不关、保持 awaiting_review 持 gate

违反 plan Step 4「交接前关闭上段」(单 writer 占 B 的核心不变式),且批准时 implement
runner 已死(tmux 已关)无法执行 ship。放弃。

### plan Step 8 字面「PASS → 关闭 QA」的调和

Step 8 写「QA PASS → push + 关闭 QA → 放行 founder/ship」但没回答「关闭后谁 ship」——
这正是 issue 点名的未决点。方案 A 把「关闭 QA」推迟到 ship 完成后的既有 post-ship
finalization(它本来就负责关 feature runner),语义上仍是「pipeline 收尾时 QA 被关闭」,
只是关闭时机从 PASS 时刻移到 ship 完成时刻——换来的是 ship 执行者不缺位。

## 4. FAIL 分支(fix-loop,plan Step 8 Model A 原样)

`qa-result fail` → Bridge 新分支(见 §5):capture B head → `closePhaseRunner`(dirty-safe,
QA 必须已 commit+push findings/failing tests,否则 fail-closed 告警)→ 起新 Implement-fix
phase(`shareParentBranch`、pin B head、带 fix 上下文)→ fix 完成 `needs_review` 时**既有**
`PhaseOrchestrator.onPhaseComplete` 自动再起新 QA phase = 闭环,零新交接代码。
轮数上限(默认 3,env `FLYWHEEL_THREE_STAGE_MAX_FIX_ROUNDS`)超限 fail-closed 告警 Lead。

## 5. Bridge 侧落点:PhaseOrchestrator.onQaResult(= deferred ThreeStageQaCoordinator 的职责)

不建平行新类:FAIL 路径就是一次 qa→implement 的交接,`PhaseOrchestrator` 已封装全部所需
effects(capturePhaseHeadSha / closePhaseRunner / alertLeadPipelineError / startDispatcher,
`plugin.ts:3724` 全部真实接线)。新增 `onQaResult`,路由在 `event-route.ts:625`:

```
qa_result 到达 → reporting session 是三段 QA phase?
  判别 = session_role==='qa' && chat_thread_role==='qa'(持久化标记,Blueprint.ts:589:
        只有 shareParentBranch+phase role 才写 phase role;auto-QA runner 恒 'main')
  是 → phaseOrchestrator.onQaResult(新分支)
  否 → autoQaCoordinator.onQaResult(逐字不变 = byte-compat)
```

PASS 分支轻:审计日志 + pass 标记(session_params)——真正的放行由 QA runner 自己的
approve-gate 流触发。安全网:三段 QA session 落 terminal `completed` 却带 pass 标记且无
`review_question_id` 绑定(= 849 观察到的静默断裂形态)→ 告警 Lead(live 路径挂在既有
`onPhaseComplete` 两 sink 调用点 + startup reconcile 镜像 `design_done` 模式)。

## 6. 提示词侧(Blueprint isQaPhase)

现状两个洞:① `:889` 只说「Report the verdict with flywheel-comm qa-result」没给
`--exec-id/--target-exec` 具体值(auto-QA 的 `:407` 是给全的);② isQaPhase 同时收到完整
APPROVE GATE block(`:1244`,只 skip `isQaRunner`)但 role prompt 的最后一步是「报 verdict」
→ 849 真机里 QA runner 报完 verdict 就 stop,gate block 成了死文字。

改法:isQaPhase 的 role 步骤明确 sequencing——
- PASS:`qa-result --status pass`(带完整参数)→ **接着执行下方 APPROVE GATE 流(a-g)**,
  PR 用 Implement 段开的那个(`gh pr view --json number`);你就是本 pipeline 的 ship 执行者。
- FAIL:先 commit+push findings/failing tests → `qa-result --status fail --summary` → STOP
  等待关闭(pipeline 会起 Implement-fix;不要 park 等 retest——那是 auto-QA 的协议)。
- `--target-exec` 用自己的 exec id(三段 verdict 按 reporting session 键定,target 仅审计;
  不动 qa-result CLI 契约,auto-QA 语义不变)。

## 7. 边界 / 明确不动的东西(scope)

- **auto-QA 全链逐字不变**(路由分支 fall-through;byte-compat 哨兵测试两侧)。
- Implement 段自己开的 approve gate(交接后被 GatePoller 以 source-terminal evict,849
  §3.8 已观察为设计内行为)——不动。
- isQaPhase 仍收到 BRAINSTORM GATE block(849 未见阻塞)——不动,记 follow-up。
- founder gate ping 落在 🧪QA phase thread(Step 11 侧表语义)而非 main thread——v1 接受,
  UX 观察点交 Lead 判断。
- qa-result 掉失(4 次重试全败写 marker)→ QA session 停 `running` → 既有 stuck watchdog
  兜底;不新建 marker replay。

## 8. 关键代码事实(全部现场核对)

| 事实 | 位置 |
|---|---|
| qa_result 唯一路由(HTTP;CLI 恒 POST /events,DirectEventSink 不经手) | `event-route.ts:625` |
| 双闸丢弃 | `auto-qa-coordinator.ts:551,594` |
| `nextPhase(qa)=null` → Step 8 缺口注释 | `phase-orchestrator.ts:147` |
| implement 关闭 `finalizeDone:true` → completed | `plugin.ts:3763-3780` |
| `chat_thread_role` 持久判别(三段 phase 才写 phase role) | `Blueprint.ts:589`, `StateStore.ts:831` |
| `isQaRunner = !!ctx.qaContext` → 不能借 qaContext 传 parent id | `Blueprint.ts:821` |
| APPROVE GATE block 只 skip isQaRunner,isQaPhase 全收 | `Blueprint.ts:1175,1244` |
| `complete --route needs_review` 需 `--pr` + questionId(Bridge fail-close) | `complete.ts:29,181` |
| run-dispatcher dedup = dispatch 期 in-process map,`blueprint.run` settle 即删 → fix 轮二次 implement 不被拦 | `run-dispatcher.ts:611,734` |
| onMainAwaitingReview 只对 role 'main' → 三段 QA 落 awaiting_review 不会被 auto-QA 二次抓 | `event-route.ts:1834` |
| 795(#436)零 QA-收尾内容(全部 = progress.md resume) | `gh pr diff 436` 逐文件 |

## 9. 预期结果

Design→Implement→QA→(FAIL→Implement-fix→QA)*→PASS→founder gate→approved→QA runner
self-ship→post-ship finalization 全链闭合;FLY-849 §3.8 的断点消失;793-batch 具备 enable
`pipeline.three_stage` 的完整尾巴。
