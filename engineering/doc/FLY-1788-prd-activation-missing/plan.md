# FLY-1788 tpl_prd run 建立但 runner 拿不到 workflow activation — 实施计划

Issue: FLY-1788 (https://linear.app/geoforge3d/issue/FLY-1788/enginebug-tpl-prd-run-建立但-runner-拿不到-workflow-activation-founder)
日期: 2026-08-16
基于: research.md

## 0. 保质期分辨(第一屏)

- **会作废的前提**:行号引用基于 main `7267ff3fe`;若 implement 前 main 大幅移动
  `run-dispatcher.ts`,以「两个 `grantPrelaunchWorkflowTurn` 调用位点的 gating 条件」
  这一结构性描述为准重新定位。
- **不会作废的结论**:根因(phase-role gating 挡掉 engine-owned generic 铸造)、
  读取侧强耦合 TURN(不能只补 activation 行)、副作用审计结论(research.md
  §6 + §8b —— §8b 补上了 §6 漏掉的 projector 硬校验消费方,两节要一起读)。

## 1. 目标与范围

**目标**:engine-owned 单产出节点(generic 类型)的 spawn(fresh / retry / 重派)
与 phase 节点一样,在 launch 前铸造 `three_stage_turn` + `runner_workflow_activation`,
使 `gate founder_review` 与 `complete`(founder-review-required)可用。

**范围**(R1 review 后扩两处,均为同一 bug 家族):
- `packages/teamlead/src/bridge/run-dispatcher.ts` 两个铸造位点的 gating
  条件与 phase 取值(§2.1/§2.2);
- `packages/teamlead/src/bridge/actions.ts` generalized retry 的
  `generalizedExecution` payload 补全(§2.4,Codex R1 BLOCKER-1:真实生产
  retry caller 缺 engine bundle,任何 run-dispatcher 侧条件都够不着它);
- `packages/teamlead/src/StateStore.ts` `applyWorkflowSourceEvent` 的
  `to_role` 校验最小兼容放宽(§2.5,Codex R1 BLOCKER-2:generic 节点的
  turn_grant source event 会被 projector 终态 deadletter,rework/carrier
  两个既有 writer 对 generic 节点今天就潜伏同一问题);
- 不动 dispatcher/runs-route 的 role/shareParentBranch 降级(那是 worktree
  语义,正确);不动 gate/complete 读取侧(fail-closed 语义正确);不动 schema;
  **不加 flag**(FLY-1466 铁律)。
- 覆盖全部四个单节点模板(tpl_prd / tpl_design / tpl_prototype / tpl_generic_menu),
  它们编译后同为 generic 节点、走同一路径。

**非目标**:
- 不为存量 wedged run 做通用补铸脚本(理由见 §6)。
- 不改 tpl_generic_menu 的 completion 归因链(修复后 activation 存在,
  completion payload 自然带 `workflowActivation`,legacy carrier 推断不再触发)。

## 2. 代码修改(4 个文件、5 个逻辑位点)

### 2.1 fresh `start()`(现 run-dispatcher.ts:1683)

```ts
// 现状
if (req.shareParentBranch === true && isWorkflowPhaseRole(role)) {

// 改为
const engineOwnedSpawn = req.generalizedExecution?.engineOwned === true;
if (
    engineOwnedSpawn ||
    (req.shareParentBranch === true && isWorkflowPhaseRole(role))
) {
```

phase 取值(传给 `grantPrelaunchWorkflowTurn` 的 `phase` 字段):

```ts
const turnPhase = isWorkflowPhaseRole(role)
    ? role
    : req.generalizedExecution!.nodeId;
```

- phase-role 节点:`role` 不变(tpl_code 字节兼容);
- generic 引擎节点:用 `nodeId`(如 `produce`/`execute`),与 rework 路径
  `grantWorkflowReworkTurn` 的 `phase = input.nodeId` 既有约定对齐
  (`workflow-rework-coordinator.ts:74` 校验 `persisted.phase === input.nodeId`,
  fresh 与 rework 两次 grant 才能对得上同一套 phase 语义)。
- 走进新分支时 `engineOwnedSpawn === true` 必然成立(非 engine 派发无
  `generalizedExecution`),`req.generalizedExecution!.nodeId` 非空由类型与
  `grantPrelaunchWorkflowTurn` 的 engine 完整性校验兜底(缺料 throw,
  fail-closed abort 与 phase 现状同路径)。

### 2.2 retry `dispatch()`(现 run-dispatcher.ts:984)

```ts
// 现状:if (isPhaseRetry) { grantPrelaunchWorkflowTurn(...) }
// 改为:
const engineOwnedRetry = req.generalizedExecution?.engineOwned === true;
if (isPhaseRetry || engineOwnedRetry) { grantPrelaunchWorkflowTurn(..., phase: turnPhase, ...) }
```

**红线**:`isPhaseRetry` 还 gate 着 branch-B `retryStartPoint` 两次计算
(`:947-978`、`:1011-1018`)——那是 phase 共享分支专属语义,**保持只看
`isPhaseRetry`,不得并入新条件**。

### 2.3 明确不改的位置(review 锚点)

- `workflow-engine-dispatcher.ts:2669/2679` 与 `runs-route.ts:3061-3065/3097`
  的 role/shareParentBranch 降级:不改。
- `grantPrelaunchWorkflowTurn` 本体:不改(engine 校验与回读校验已足)。
- `resolveRunnerWorkflowActivation` / gate / complete 读取侧:不改。
- rework / ship-carrier 两个 writer 的 `phase = nodeId` 写法:不改
  (§2.5 的 projector 兼容放宽同时覆盖它们)。

### 2.4 actions.ts generalized retry 补全 engine bundle(Codex R1 BLOCKER-1)

`packages/teamlead/src/bridge/actions.ts` 的 generalized retry
(`:981-990` 已 `admitGeneralizedWorkflowExecution`,`:1209-1231` 组装
`generalizedExecution`)缺四样材料,导致该 payload 永远进不了新铸造分支,
且 retry 出来的 runner 丢 founder-review 协议:

对 `run.engine_owned === 1` 的 retry,payload 补:

```ts
engineOwned: true,
activationId: admitted.activationId,
projectTurn: (turn) => store.recordWorkflowActivationTurn(turn),
capabilities: {
    ...node.capabilities,
    founder_review_required: nodeRequiresFounderReview(snapshot, node.id),
    ...workflowGateEntryPromptCapabilities(snapshot, node.id),
},
```

与 fresh 两条路径(dispatcher `:2708-2735`、runs-route `:3110-3142`)的
payload 形态对齐;缺任一项时 `grantPrelaunchWorkflowTurn` 的 engine 校验
throw → dispatch 前 fail-closed(不 launch)。非 engine retry payload 不变。

**实现看点(Codex R2 建议 2)**:actions.ts 在调 `dispatch()` 前已取得
durable workflow launch owner,其 pre-dispatch catch 不像 fresh 两路那样
调 `releaseFailedWorkflowLaunch`。新引入的铸造失败(fail-closed abort)
保证的是「不 launch runner」,但可能让该 successor 留在有界 launch lease
后面等租约过期。实现时二选一并写明:(a) 在 pre-dispatch 失败分支加
fenced `releaseFailedWorkflowLaunch` + 回归测试(推荐,与 fresh 路径对称);
(b) 明确接受有界 lease 自愈并在 PR 里注明。**不得**假设 `abortPreLaunch()`
会释放 StateStore ownership(它不会)。

### 2.5 source projector `to_role` 最小兼容放宽(Codex R1 BLOCKER-2)

`StateStore.applyWorkflowSourceEvent`(`StateStore.ts:36353-36363`)对
`turn_grant` source event 要求 `context.node.type === to_role`。三个 writer
(spawn 修复后、rework `workflow-rework-coordinator.ts:48`、carrier
`workflow-ship-carrier-coordinator.ts:33`)写的都是 **nodeId**;phase-role
节点 id==type 恰好通过,generic 节点 `produce`/`execute` ≠ `generic` →
projector 终态 deadletter(`TURN source payload invalid: run ownership
mismatch`)+ 丢 `turn_granted` run event。**这不是本修复引入的:rework/
carrier 对 generic 节点今天就潜伏同一 deadletter。**

最小兼容修复:校验改为接受**绑定节点的两个合法表示之一**——

```ts
context?.node.type !== toRole && context?.node.id !== toRole  // → 仍 throw
```

即 `to_role ∈ {node.type, node.id}`,其余值(伪造 role、错节点)照旧拒绝。
不改三个 writer(统一 canonical phase 需要同步动 spawn/rework/carrier 三处
加既有测试面,收益只是表示唯一性,违背最小改动 —— 已否决)。

### 2.6 founder admission 改用 current activation(Lead comment #7)

Lead 在 implement 开工时指出:同一 physical exec 经 rework wake 后会同时保留
历史与当前两条 binding;`question-admission.ts` 原调用 legacy
`getGeneralizedWorkflowNodeForExecution`,该 getter 只接受恰好一条 binding,
于是修复部署后的第一次 founder 打回仍会把合法 gate 永久撤销。

本 PR 采用 Lead 推荐的 **A 方案**,把 founder-review admission 唯一调用点换为
`resolveCurrentWorkflowActivation(executionId)`:只有返回 `kind === "current"`
才继续核对 run id 与 `founder_review_required`;`none`/`ambiguous` 保持
fail-closed。这样 authority 绑定最新 active node attempt,不会误用历史 activation,
也不放宽 gate 权限。

## 3. TDD(RED → GREEN,先写测试)

落点 `packages/teamlead/src/bridge/__tests__/run-dispatcher-fly887-turn-seam.test.ts`
(复用现成 harness:`turnAtLaunch` 探针、CommDB 断言、abort 断言模式):

RED(修复前必须红):
1. **engine-owned generic fresh spawn 铸造**:`start({ sessionRole: "main" }`,无
   `shareParentBranch`,`generalizedExecution` engineOwned、`nodeId: "produce"`)→
   断言 launch 时 TURN 已存在、`phase === "produce"`、comm DB
   `runner_workflow_activation` 行存在且 activation_id/run_id/node_id/attempt
   与 payload 一致、`projectTurn` 投影被调用。
2. **engine-owned generic retry 铸造**:`dispatch(retryRequest({ sessionRole: "main",
   shareParentBranch: undefined, generalizedExecution }))` → 同上断言;并断言
   **未**触发 phase-retry 的 startPoint 计算(branch-B 语义未被连带)。
3. **四模板参数化**:用 `loadWorkflowMenuLibrary()` + `compileWorkflowMenuSeed`
   加载真实四个单节点 seed,对每个模板取其可执行节点 nodeId 驱动用例 1 —
   把「全部单节点模板」写进测试本体而不是靠人脑归纳。
4. **fail-closed**:generic 铸造失败(mock grantTurn throw)→ abort 前注册清理,
   与既有 `:381` "fresh start TURN grant failure" 同构断言。

GREEN 后回归(必须保持绿,行为字节不变):
5. 既有 `:412` / `:423` 两条 byte-compat(legacy 无 generalizedExecution 的
   main 派发不铸造)——**不许改这两条用例**。
6. 既有 `:133` engine phase 用例 —— 断言 phase 参数仍为 role(tpl_code 不变)。

comm 侧补一条(`packages/flywheel-comm/src/__tests__/` 现有 activation 测试文件内):
7. **1782 失败模式还原**:generic exec 无 activation 行 →
   `currentWorkflowCompletionActivationFromEnv` 为 null(gate 会 throw);
   经 `grantTurn(phase="produce", activation)` 铸造后 → 返回 activation 且
   run_id/node_id 正确。锁住读取侧契约,防未来有人把 fail-closed 改成回退。

actions.ts retry 路径(R1 BLOCKER-1,落点 actions 相关既有测试文件):
8. **production-shaped generalized generic retry**:engine-owned run 的
   retry 经真实 `RunDispatcher.dispatch()` → 断言 launch 前 activation 已
   铸造、`projectTurn` 投影发生、runner ctx capabilities 带
   `founder_review_required`、且 phase-retry startPoint probe **未**运行。
9. **fail-closed**:构造缺 `projectTurn` 的 engine retry payload →
   dispatch 前 abort(grantPrelaunchWorkflowTurn 校验 throw)。

projector 路径(R1 BLOCKER-2,落点 StateStore workflow source event 测试):
10. **generic activation source-event drain**:generic 节点 turn_grant
    (to_role = nodeId,如 "produce")→ apply 成功、无 deadletter、
    `turn_granted` run event 存在。修复前红(现状 throw)。
11. **rework/carrier 潜伏面回归**:同一 drain 断言复用在 rework 形态的
    turn_grant payload 上(generic 节点 rework 今天就 deadletter,此用例
    把潜伏 bug 的修复锁死)。
12. **负例保留**:伪造 to_role(非 node.type 也非 node.id)仍 throw
    `run ownership mismatch`;phase-role 节点既有用例全绿(id==type,
    行为字节不变)。
13. **双 binding admission**(Lead comment #7):同一 exec 先绑定 attempt 1,
    rework wake 再绑定 attempt 2;断言两条 binding 都存在、current resolver
    精确返回 attempt 2,且 founder-review question 可投递。legacy getter 在修复前
    返回 undefined,因此该用例先红后绿。

## 4. 验证 gate(全 repo,非只测改动文件)

- `pnpm lint`(全仓 biome)
- `pnpm -r build`
- 定向 vitest:上述测试文件 + `workflow-turn-bundle.test.ts` +
  `workflow-rework-coordinator.test.ts`(rework phase=nodeId 契约未被扰动)+
  actions retry 相关测试 + StateStore workflow source event 测试
  (`workflow-source-events` / founder-approval-projector 面)
- host 上不跑全量 package suite 当门(记忆规则:全量压死生产 Bridge;以 PR CI
  的无沙箱结果为准),host 全量差异如实上报不伪报
- Codex code review(`codex:rescue`,xhigh),循环到 APPROVED

## 5. 复现 / 独立 QA(交付 1,由 qa 节点执行)

529 generalized-DAG 房(FLY-1775,PR #847 基建):

1. 预检(记忆配方):房内 Bridge `/health` 的 buildSha 必须是被测分支
   (529 房跑脚本所在仓库,不是 --from-branch);从 runner pane 起房注意
   roundtable env / TMPDIR sun_path 两坑。
2. **修前基线(RED 铁证)**:main 版 Bridge 派一张 tpl_prd → 查 comm DB
   该 exec 无 `runner_workflow_activation` 行;pane 内跑
   `gate founder_review --no-block` 报 `founder_review requires a current
   workflow activation`(复现 1782)。
3. **修后**:被测分支 Bridge 同样派 tpl_prd → 断言 activation 行存在
   (四元组与 StateStore admission 一致)、`gate founder_review --no-block`
   返回 questionId、`three_stage_turn.phase = "produce"`。
4. **对照组**:同房派 tpl_code → design 节点行为与 main 无差(phase=role、
   epoch 语义、`:133` 断言面)。
5. 时间允许再抽一张 tpl_generic_menu 验 execute 节点 activation 存在。

## 6. 存量过渡(交付 3:1782 等 active 单节点 run)

**先盘点**(修复 ship 后执行,只读):StateStore `workflow_run` 里
`status='active'` 且 template ∈ {tpl_prd, tpl_design, tpl_prototype,
tpl_generic_menu} 的 run,取当前节点 execution → comm DB
`runner_workflow_activation` 按 execution_id 无行即 wedged。

**处置(按产出状态二选一,均为 Lead 决策、founder-gated 动作走现行权限)**:
- **产出未投递**:Lead 对 wedged exec 走 close-runner(普通 close,不带 done —
  记忆规则:close(done=true) 触发重派语义混乱)→ 引擎 dead-exec 重派同一节点
  → 新 exec 经修复后的 seam 自然铸造 → 新 runner 按 FLY-1718 存量分支对账,
  发现产出已在分支上,直接进 founder round。**不补铸**:spawn 时 rotate 的
  output/submission credential 只在派发时境内存在,补铸要新开凭证轮换运维入口,
  复杂度/风险远超一次受控重派(research.md §9)。
- **产出已由 Lead 手工投递**(如 1782 当晚的 workaround):产出闭环后由 Lead
  对 run 走 cancel 收口(取消 run,不伪造 gate 通过),runner 普通 close。

## 7. 风险与回滚

| 风险 | 定性 | 依据 |
|------|------|------|
| generic run 新增 TURN 行遗留 | 无害 | TurnBeltReconciler 跳过 engine-owned;HeartbeatService 注释已定性 harmless;post-ship `deleteTurn` 收口(research.md §6) |
| `three_stage_turn.phase` 出现非 phase 字符串 | 消费方两类 | 运行时消费(reconciler/heartbeat/CLI)全量审计零 switch;**source projector 是唯一硬校验消费方**,由 §2.5 兼容放宽收口(Codex R1 BLOCKER-2) |
| projector 校验放宽面 | 严格受限 | 只多接受「绑定节点自己的 id」这一个新值;伪造 role / 错节点照旧 throw;phase-role 节点(id==type)行为字节不变 |
| actions retry payload 加 `engineOwned` 的连带行为 | 已审计 | dispatch() 内 `generalizedExecution` 的其他消费点(inflight 收敛、launch claim、buildRunnerSpawnFields)都只判 presence,payload 早已存在,新字段只影响铸造分支与 grant 校验 |
| generic 派发新增 fail-closed 失败模式(铸造失败挡 spawn) | 有意为之 | 与 phase 现状一致;宁可不 launch 也不 launch 一个开不了 founder 门的 runner |
| 回滚 | 单 commit revert | 无 schema 变化、无 flag、无数据迁移;已铸的 TURN/activation 行对旧代码就是 legacy-tolerant 读取;projector 放宽是超集接受,回滚后新写入的 to_role=nodeId source event 会重新 deadletter(与今日现状同,不更坏) |

## 8. 验收标准

1. §3 用例 1-4、8-12 修复前红(负例/兼容例除外:5-6、12 的 phase-role 面
   全程绿)、修复后全绿;7 绿。**8-12 是 R1 两个 blocker 的回归锁,
   不是可选项。**
2. §4 全仓 gate 绿(CI 为准)。
3. §5 独立 QA:修前基线复现 + 修后 tpl_prd activation 行存在 + gate 开出
   questionId + tpl_code 对照无回归,FINAL PASS。
4. §6 盘点清单交 Lead,存量 run 处置有主。
5. Codex code review APPROVED;PR 末 commit 带 CLAUDE.md 里程碑 + 文档随分支。

## 9. Implement 记录

- RED:新增 seam/actions/projector/admission 用例在修复前出现 9 个预期失败;
  兼容对照保持绿。
- GREEN:TeamLead 扩展影响面 9 files / 206 tests 全绿;flywheel-comm TURN +
  complete 契约 89/89;两包 typecheck 全绿。
- 全仓 gate:`pnpm lint` 通过(8 条既有 warning),`pnpm -r build` 22/23
  workspace 通过。生产宿主不跑 package aggregate,由 PR CI 执行。
- Lead comment #7:已采用 A 方案并加双 binding 回归,没有另拆 scope。
- Code review R1:5 个旧 generalized dispatcher fixture 因缺 activation bundle
  如预期 fail-closed,已补成 production-shaped 合同;同时把 held/ambiguous
  founder authority 保持为有界重试,stale completion 改为明确拒绝,并让 retry
  的 `engineOwned` 由 durable run 字段派生。R1 HIGH 已修复,MEDIUM 两项也收口。
- 存量过渡:不做脱离 dispatch credential 的通用 backfill;修复上线后按 §6
  受控 close + engine re-dispatch 补铸。已手工投递者 cancel/普通 close 收口。
