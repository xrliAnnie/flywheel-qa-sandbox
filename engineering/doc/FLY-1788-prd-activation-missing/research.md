# FLY-1788 tpl_prd run 建立但 runner 拿不到 workflow activation — 调研

Issue: FLY-1788 (https://linear.app/geoforge3d/issue/FLY-1788/enginebug-tpl-prd-run-建立但-runner-拿不到-workflow-activation-founder)
日期: 2026-08-16
基于: exploration.md

本文逐条列出代码证据,支撑 exploration.md 的根因链与方案 B。行号基于本分支
(`flywheel-FLY-1788`,base = main `7267ff3fe`)。

## 1. `runner_workflow_activation` 的唯一写入点

comm DB 侧只有一个写入点:`CommDB.grantTurn`(`packages/flywheel-comm/src/db.ts:4336-4540`)。
仅当调用方传入 `source.activation` 时,才在 turn-grant 事务里同时写
`three_stage_turn` upsert + `runner_workflow_activation` insert(PK =
`(execution_id, epoch)`,epoch 来自 turn 的单调递增)。

带 activation 调 `grantTurn` 的调用方共三个:

| 调用方 | 场景 | 节点类型限制 |
|--------|------|--------------|
| `grantPrelaunchWorkflowTurn`(`workflow-turn-bundle.ts:4-90`) | **spawn 前铸造**(fresh/retry/reconcile 重派) | **被调用条件限死在 phase role**(本 bug) |
| `grantWorkflowReworkTurn`(`workflow-rework-coordinator.ts:40-87`) | founder kickback rework 唤醒 | **无限制**,`phase = input.nodeId` |
| ship-carrier(`workflow-ship-carrier-coordinator.ts:30-39`) | approve 后 ship 载体 | 无限制,context.kind = `runner_ship_carrier`(completion 读取侧显式排除,`workflow-activation.ts:31-40`) |

另有 `plugin.ts:8734-8744` turn-belt 恢复用的 `grantTurn`(不带 activation,与本 bug 无关)。

`grantPrelaunchWorkflowTurn` 自带 engine 完整性校验:engine-owned 但缺
`activationId`/`projectTurn`/executionId 不匹配 → throw
(`workflow-turn-bundle.ts:15-24`);grant 后回读校验 TURN 四元组与投影
(`:52-88`)。即调用它的前提材料在两个派发入口都已备齐,只是没被调用。

## 2. 铸造被跳过的精确条件(两个位点)

`run-dispatcher.ts` 是所有 spawn 的单一 seam(注释自证 `:1673-1682`:
"This ONE seam covers every spawn path (all route through start())")。

- **fresh `start()`**(`:1439` 起):
  ```ts
  // :1683
  if (req.shareParentBranch === true && isWorkflowPhaseRole(role)) {
      grantPrelaunchWorkflowTurn({ ..., phase: role, generalizedExecution: req.generalizedExecution });
  }
  ```
- **retry `dispatch()`**(`:770` 起,`role = req.sessionRole ?? "main"` `:777`):
  ```ts
  // :945-946
  const isPhaseRetry = req.shareParentBranch === true && isWorkflowPhaseRole(role);
  // :984-1006  if (isPhaseRetry) { grantPrelaunchWorkflowTurn(...) }
  ```
  注意 `isPhaseRetry` 同时 gate 了 branch-B `retryStartPoint` 计算(`:947-978`、
  `:1011-1018`)——那部分是 phase 专属语义,修复时**不能**动。

## 3. 两个派发入口对非 phase 节点的降级(条件为何不满足)

- 引擎 successor 派发 `workflow-engine-dispatcher.ts`:
  - `:2669` `const role = isWorkflowPhaseRole(node.type) ? node.type : "main";`
  - `:2679` `shareParentBranch: isWorkflowPhaseRole(node.type) ? true : undefined`
  - `generalizedExecution` payload 全量携带(`:2708-2735`):`engineOwned: true`、
    `activationId: admitted.activationId`、credentials、
    `projectTurn: (turn) => store.recordWorkflowActivationTurn(turn)`。
- fresh 入口 `runs-route.ts`:
  - `:3061-3065` `workflowRole = isWorkflowPhaseRole(node.type) ? node.type : "main"`
  - `:3097` `shareParentBranch: workflowRole === "main" ? undefined : true`
  - `generalizedExecution` payload 同样全量(`:3110-3142`)。

即:engine-owned generic 派发时,铸造所需材料(activationId、credentials、
projectTurn 投影闭包)已经在 `req.generalizedExecution` 里,唯独 run-dispatcher
的条件把调用挡掉。

## 4. 读取侧:为什么没有 TURN 就永久关门

- `CommDB.resolveRunnerWorkflowActivation`(`db.ts:5278-5305`):
  session→issue 查 `three_stage_turn`;无 TURN 或 TURN 无 activation_id →
  `{state:"legacy"}`;holder 不是本 exec → stale;activation 行与 TURN 四元组
  不一致 → stale。**activation 与 TURN 强耦合,不能只补 activation 行。**
- `currentWorkflowActivationFromEnv`(`flywheel-comm/src/commands/workflow-activation.ts:5-23`):
  legacy → null。
- gate 命令(`flywheel-comm/src/index.ts:1966-1976`):checkpoint 为
  `founder_review` 时 activation 为 null 直接 throw
  `founder_review requires a current workflow activation`。**FLY-1782 实测报错即此行。**
- complete 命令(`flywheel-comm/src/commands/complete.ts:319-355`):
  `FLYWHEEL_FOUNDER_REVIEW_REQUIRED=1` 且 route 为 `needs_review`/`no_code` 时,
  activation 缺失 → `founder_review authority is unavailable` → exit 1。
  该 env 由 TmuxAdapter 按节点 capability 注入(`TmuxAdapter.ts:551`、
  `CodexTmuxAdapter.ts:1456`),capability 源头是
  `nodeRequiresFounderReview`(dispatcher `:2720`、runs-route `:3122`)。
- Blueprint 对 founder_review_required 节点注入的执行协议
  (`edge-worker/src/Blueprint.ts:887-910`)明确指示 runner 跑
  `gate founder_review --no-block`。**即 runner 被指示走一条对它必然报错的路 —
  双重 wedge 成立。**
- Bridge completion 侧还有第三道:`event-route.ts:937-1005` 对
  founder-review 节点的 completion 校验 founder verdict —— 修复后这道门靠
  gate→verdict 流程自然满足,不需要改。

## 5. 四个单产出模板的编译事实

`menus/shapes/*.yaml` + `workflow-menu.ts:365-371`:

| shape | 可执行节点 | role | 编译后 type | founderReview |
|-------|-----------|------|-------------|---------------|
| prd | produce | pm | generic | true |
| design | produce | designer | generic | true |
| prototype | produce | proto | generic | true |
| generic | execute | generic | generic | (无) |

`NODE_TYPE_REGISTRY.generic.isPhaseRole === false`(`node-type-registry.ts:129-158`)。
tpl_code 三节点 id/role 均为 design/implement/qa(`isPhaseRole: true`),不受影响。

## 6. 副作用审计(方案 B 引入 generic TURN 行后)

| 消费方 | 行为 | 结论 |
|--------|------|------|
| `TurnBeltReconciler`(`turn-belt-reconcile.ts:96-120`) | `isEngineOwned(turn.holder_exec_id)` → **整体跳过** engine-owned holder 的恢复/接管 | 零新巡检噪声 |
| `HeartbeatService.classifyTurn`(`HeartbeatService.ts:1918-1943`) | 只看 holder + granted_at,phase 无关;注释已定性遗留 TURN 行 "tiny, harmless row" | 无影响 |
| `flywheel-comm turn` CLI(`turn.ts:196-198`) | phase 仅用于展示字符串 | 无影响 |
| post-ship finalization(`post-ship-finalization.ts:525`) | issue 级 `deleteTurn` 收口 | generic run 结束同样收口 |
| `three_stage_turn.phase` 值 | 无消费方 switch on "main"/自由字符串;rework 路径已在写任意 nodeId(`workflow-rework-coordinator.ts:74` 校验 `persisted.phase === input.nodeId`) | 用 nodeId 与 rework 约定对齐 |
| ship-carrier 覆写 | approve 后 carrier grant epoch+1 覆写 spawn grant,与 implement phase 现状同构 | 无影响 |
| 普通(非 engine)派发 | `req.generalizedExecution` 仅 engine 派发存在;legacy 分支条件不变 | 字节兼容 |

## 7. 既有测试基线

`run-dispatcher-fly887-turn-seam.test.ts`:
- `:412` "byte-compat: a non-phase (no shareParentBranch) dispatch grants NO turn" —
  用例**不带** `generalizedExecution`,修复后仍绿(legacy 行为保持)。
- `:423` "non-phase retry calls no TURN grant" — 同上,仍绿。
- `:133` "attributes an engine-owned phase TURN to its pinned workflow run" —
  engine phase 现状基线,修复后字节不变。

新用例落点即此文件 + `workflow-turn-bundle.test.ts`(见 plan.md §4)。

## 8. QA 基建参考

- FLY-1775 已落 529 generalized-DAG QA 房(PR #847),快模板(tpl_prd 等)派单
  可在隔离房重放;驱动脚本对 roundtable mode 的限制不影响本场景。
- 记忆库配方:529 房 Bridge 跑的是脚本所在仓库不是 --from-branch(开跑前必核
  `/health` buildSha);从 runner pane 起房的 env 两坑。QA 节点执行时须按配方预检。

## 8b. R1 design review 补充审计(Codex 两个 blocker,已独立核验)

1. **actions.ts generalized retry 是第三条真实派发路径,payload 缺 engine bundle。**
   `actions.ts:981-990` 对 successor 已 `admitGeneralizedWorkflowExecution`
   (`admitted.activationId` 在手),但 `:1209-1231` 组装的 `generalizedExecution`
   没有 `engineOwned`、`activationId`、`projectTurn`,capabilities 也没有
   `founder_review_required`(fresh 两路都有,dispatcher `:2720`、runs-route
   `:3122`)。仅改 run-dispatcher 条件够不着这条路;且 retry 出来的 tpl_prd
   runner 会丢 founder-review 协议注入。
2. **`three_stage_turn.phase` 有一个硬校验消费方:source projector。**
   §6 的「零 switch」审计漏了 comm→StateStore 的 source-event 投影:
   `StateStore.applyWorkflowSourceEvent`(`StateStore.ts:36353-36363`)对带
   targetRunId 的 `turn_grant` 要求 `context.node.type === to_role`,否则 throw
   `TURN source payload invalid: run ownership mismatch` → projector 终态
   deadletter + 丢 `turn_granted` run event。generic 节点 type="generic" 而三个
   writer(spawn/rework `workflow-rework-coordinator.ts:48`/carrier
   `workflow-ship-carrier-coordinator.ts:33`)写的都是 nodeId
   (produce/execute)→ **rework 与 carrier 对 generic 节点今天就潜伏同一
   deadletter**,tpl_code 恰因 id==type 幸免。收口方案见 plan §2.5。

## 9. 存量数据核查口径(为 plan §6 定过渡策略)

- 判定一个 active 单节点 run 是否 wedged:StateStore `workflow_run`
  (`status=active`、template 为四个单节点之一)JOIN 当前节点 execution →
  comm DB `runner_workflow_activation` 按 execution_id 查无行即 wedged。
- 补铸不可行的硬理由:spawn 时 rotate 出的 output/submission credential
  (dispatcher `:2575-2651`)只在派发时境内存在;事后补铸要新开凭证轮换入口
  (等价于把 delivery-repair 轮换泛化成运维 API),复杂度与风险远超受控重派。
  重派路径(close wedged exec → 引擎 dead-exec 重派)走同一 run-dispatcher
  seam,修复后自然铸造。
