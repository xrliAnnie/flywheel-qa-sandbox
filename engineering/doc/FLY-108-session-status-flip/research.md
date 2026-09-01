# FLY-108 Session Status 不 Flip — 调研
Issue: FLY-108 (https://linear.app/geoforge3d/issue/FLY-108/session-status-不-flip-runner-session-completed-两类-bug-geo-362-empty)
日期: 2026-09-01
基于: exploration.md

调研目标:把 exploration 锁定的方案(Runner-driven complete + Bridge merged fallback +
严格 route guard)落到机制级细节,每条断言给出本仓 file:line 证据。

## 1. 事件生产面(谁能发什么)

### 1.1 `flywheel-comm stage set`(现状,Variant B 的缺口所在)
- `packages/flywheel-comm/src/commands/stage.ts`:只发 `event_type: "stage_changed"`;
  VALID_STAGES 含 `completed`(:77-91),但它只是展示信号。
- 关键附件:`land-status.json`(`FLYWHEEL_LAND_STATUS_PATH`)被解析成
  `landingStatus {status, prNumber, mergeCommitSha}` 随事件上行(:55-73)——
  **merge 证据不需要 GitHub API,已经在事件里**。这是 Option 2 fallback 可行的前提。

### 1.2 `flywheel-comm complete`(新增,方案主体)
`packages/flywheel-comm/src/commands/complete.ts`:
- **CLI 契约**:`complete --route <r> [--pr N] [--merged] [--question-id Q] [--summary S]`。
  route 枚举(:30-38):`auto_approve | needs_review | blocked | no_code | pr_handoff |
  phase_design_complete`(后三个是后续 issue 增补的 no-merge 终态,复用同一守卫骨架)。
- **入参负面守卫**(:96-145):非法 route 退 1;`--merged` 必须带 `--pr`;
  no-merge 类 route 拒绝 `--merged/--pr` 矛盾旗;`pr_handoff` 强制正整数 PR
  且 land-status prNumber 必须与 `--pr` 一致(fail-closed)。
- **Payload 契约**(:172-208):`{decision:{route}, evidence, sessionRole, exitReason,
  summary?, issueIdentifier?, reviewQuestionId?}`;evidence 含
  `landingStatus?/commitCount/filesChangedCount/linesAdded/linesRemoved/diffSummary/
  changedFilePaths/commitMessages/headSha?`(:44-66)。字段与 edge-worker
  `ExecutionEventEmitter.emitCompleted`(`packages/edge-worker/src/ExecutionEventEmitter.ts:61-85`)
  逐字段对齐 —— **一个 payload 形状,两个生产者**,消费端零分叉。
- `evidence.headSha` = worktree HEAD,Bridge 持久化为 `sessions.pr_head_sha`,
  `verify-approval` 据此 fail-close(:55-65)—— completion 是审批绑定的证据源。
- **可靠性**(:216-260):4 次尝试、5s 超时、1s/2s/4s 退避;全部失败 →
  fail-close 写 marker `~/.flywheel/state/complete-failed/<execId>.json`(:401-405),
  内容为完整 event body。丢事件 = bug 原样复发,所以发射失败绝不静默。

### 1.3 edge-worker Blueprint 路径(老路径,不动)
`Blueprint.ts` 经 `eventEmitter.emitCompleted()` 在进程内直发 —— Lead-driven
tmux Runner 不经过它;该路径保持字节不变是本设计的兼容底线。

## 2. 事件消费面(双 sink,必须逐字段一致)

### 2.1 HTTP `/events` sink — `packages/teamlead/src/bridge/event-route.ts`
`session_completed` 分支的处理顺序(这个顺序本身是设计决策):

1. **Decision 4 严格 route guard**(:865-897):`!isPostApproveShip && (!route ||
   !VALID_ROUTES.has(route))` → loud warn + `{ok:true, warning:"invalid route skipped"}`,
   **跳过 FSM 更新**。这是 Variant A 的直接修复:空 payload 不再静默 fallback 成
   `completed`(旧行为)也不再被 FSM 静默拒绝(症状不可见),而是发射器 bug 立即
   进日志可排查。`approved_to_ship` 豁免保住 natural-completion 路径
   (Annie :cool: → Runner ship → route=undefined → completed)。
2. **no-merge route 只许从 running 终态化**(:900-921):review-gated 状态
   (awaiting_review/approved_to_ship)不得经 `no_code/pr_handoff/phase_design_complete`
   洗白清门。
3. **status 映射**(:921-1090,与 DirectEventSink 镜像,顺序敏感):
   - `needs_review`:merged→(ship-eligible? `completed` : park merge_block);
     post-approve-ship + 新 question 绑定→`awaiting_review`(FLY-945 重开评审);
     否则 evidence-gap `completed`(FLY-208 5a);默认→`awaiting_review`。
   - `auto_approve`:merged→(ship-eligible? `completed` : park);否则同上。
   - `blocked`:恒 `blocked` —— 显式失败 route 压过 post-approve-ship fallback
     (顺序修正来自 FLY-115 Codex R3:旧序会把失败 ship 误终态成 completed 并跑清理)。
   - `undefined`:仅 post-approve-ship 可达(guard 已拦其余)→ `completed`。
4. **applyTransition**(`packages/teamlead/src/applyTransition.ts`):FSM validate
   统一入口,拒绝则不 upsert + `transitionRejected=true`(FSM 拒绝日志升级为 error
   并携带 pre-state/target/route,:1309)。
5. **Decision 6 CIPHER backfill**(:1492-1505):Runner 无 Linear SDK,payload 缺
   labels/projectId → 从 `store.getSessionLabels()` 回填;显式 `labels: []` 语义为
   "无 label",不触发回填。
6. terminal `completed` + merged → `runPostShipFinalization`(🏁 通知、tmux 关闭、
   thread archive、issue Done、worktree 清理)。

### 2.2 in-process sister sink — `packages/teamlead/src/DirectEventSink.ts`
`emitCompleted` 的 status 映射(:258-274 区域)与 2.1 第 3 步逐分支镜像;
`isPostApproveShipComplete`(🏁 通知唯一入口谓词)要求 merged landing(:564,931)。
**对齐铁律**:任何一侧的映射改动必须同步另一侧 + 双 sink 集成测试
(`event-route-dual-session-completed.integration.test.ts` 的 Scenario 矩阵)。

## 3. FSM 变更(窄边,不放宽语义)

`packages/core/src/workflow-fsm.ts:146-153`:
```
awaiting_review: [approved_to_ship, completed, rejected, deferred, shelved, terminated]
```
`completed` 是新增边(FLY-60 W2(b) 注释,:139-145):**FSM 图只声明边合法,
merge-proof 守卫放在 event-route call site**(转移前必须验 landingStatus)。
Option 4(无条件放宽)被否决的原因就在这里:边+守卫分离让 approve 语义由
调用点的证据检查持有,而不是靠图上没这条边。

## 4. stage_changed fallback(Option 2 兜底,informational 契约保留)

`event-route.ts` stage_changed 分支(:1642 起):
- 默认行为不变:informational only,`patchSessionMetadata` 记 stage,不碰 FSM(:1977-1982 NOTE)。
- **W2 merged branch**(:1850-1925):`stage=completed` 且事件携带
  `landingStatus.status==="merged"` → `applyTransition(...,"completed")` +
  `runPostShipFinalization`(与 session_completed 分支完全相同的 PostShipOpts 形状)。
  FSM 拒绝则 loud warn,不 finalize;`transitionOpts` 缺失时拒绝 finalize(防御,R5 M1)。
- **FLY-324 branch**(:1930-1975,后续增补同骨架):no-PR/no-code Runner 只发
  stage=completed → `isDoneButRunning`(status=running + stage=completed +
  无 decision_route + 无 pr_number)+ 无 pending complete marker + 入站 landing
  无 prNumber → `running→completed`。带 PR 的 session 不走此路(必须过评审)。

## 5. 可靠性链(丢事件的兜底的兜底)

`packages/teamlead/src/bridge/complete-marker-reconciler.ts`(FLY-172 增补,
补上 complete.ts 注释里"哀叹缺失的 stale patrol"):
- Bridge boot 时扫 `~/.flywheel/state/complete-failed/`,把 marker 的完整 event body
  经 **loopback HTTP self-POST `/events`** 重放 —— 与生产 ingest 路径最大对齐
  (route guard、FSM、finalization、`insertEvent` 幂等全都走一遍)。
- **删除 marker 不看 HTTP 2xx**(`/events` 对 invalid-route/FSM-reject 也返 200):
  重放后重读 `store.getSession()`,verify 终态与 payload 应得状态一致才删;
  歧义 → quarantine。职责边界:只管 marker+replay+verify,不探 tmux
  (tmux liveness 归 HeartbeatService,不 split-brain)。

## 6. 负面守卫清单(设计必须显式携带)

| 守卫 | 位置 | 拦什么 |
| -- | -- | -- |
| 严格 route guard | event-route.ts:865 | 空/外来 route 静默终态化(Variant A) |
| no-merge route running-only | event-route.ts:900 | review-gated 状态经 no_code 等洗白 |
| blocked 压过 post-approve-ship | event-route.ts:921 注释 | 失败 ship 被误 finalize |
| ship-eligibility(FLY-869) | merge-ship-gate | merged 但未获批 → park merge_block,不 completed |
| W2 merge-proof at call site | event-route.ts:1850 | 无 merge 证据的 awaiting_review→completed |
| FLY-324 无 PR 才直通 | event-route.ts:1930 | 有 PR 的 session 绕过评审 |
| CLI 参数矛盾旗 | complete.ts:96-145 | 误用伪装成 merged 完成 |
| fail-close marker + verify-then-delete | complete.ts:401 / reconciler | 事件丢失静默、重放假成功 |

## 7. 测试证据(本仓已有,plan 引用为验收基线)

- `packages/flywheel-comm/src/__tests__/complete.test.ts` — CLI 契约 + payload 形状
  (:112 断言 `event_type === "session_completed"`)。
- `packages/teamlead/src/__tests__/event-route-session-completed-guard.test.ts` — Decision 4。
- `packages/teamlead/src/__tests__/event-route-dual-session-completed.integration.test.ts`
  — 双 sink Scenario 矩阵(D: undefined HTTP;E: blocked HTTP)。
- `DirectEventSink.test.ts:798-841` — blocked 不 finalize;undefined→completed。
- `packages/teamlead/src/__tests__/commdb-fsm-reconcile.test.ts` + `fsm-e2e.test.ts` — FSM 边。

## 8. 迁移与回滚边界

- **零 DB migration**:events/sessions 现有列足够;新增只是事件语义 + 守卫。
- **老 Runner 兼容**:从不调 `complete` 的旧 pipeline 仍被 W2/FLY-324 fallback 覆盖;
  edge-worker Blueprint 路径字节不变。
- **回滚**:revert Bridge 侧改动 → stage_changed 退回 informational-only、
  session_completed 退回旧 fallback(bug 复现但无新破坏);marker 文件是惰性数据,
  无消费者时无副作用;`complete` 子命令对旧 Bridge 只是一个被存进 events 表的
  普通事件(insertEvent 幂等),不会打坏状态。
- **稳定标识**:`event_type: "session_completed"`、route 枚举字符串、marker 文件名
  `<execId>.json` 是跨组件契约,重命名即破坏 —— plan 中列为不可变更项。

## 9. 结论

机制闭环成立:**源头发射(complete)+ 严格入口守卫(Decision 4)+ 证据驱动兜底
(W2 merged fallback)+ 丢失重放(marker reconciler)**,四层各自独立可回滚,
共同保证"Runner 完工 ⇒ status 必达终态,且绝不绕过 approve 语义"。→ plan.md。
