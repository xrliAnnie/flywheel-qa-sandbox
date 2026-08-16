# FLY-1788 tpl_prd run 建立但 runner 拿不到 workflow activation — 探索

Issue: FLY-1788 (https://linear.app/geoforge3d/issue/FLY-1788/enginebug-tpl-prd-run-建立但-runner-拿不到-workflow-activation-founder)
日期: 2026-08-16
基于: 无

## 1. 现象(照抄事故账)

2026-08-15,HL 的 FLY-1782 runner(exec `cea85f94`)实测:

- runner 按 Blueprint 注入的 founder-review 协议执行 `flywheel-comm gate founder_review`,报错
  `founder_review requires a current workflow activation`;
- comm DB `runner_workflow_activation` 全表 221 行,其他 runner 有近期行(仪器正常);
- 该 exec **无行**;
- 但 StateStore `workflow_run` 存在:`tpl_prd` / `status=active`。

⇒ run 建了,runner 没拿到 activation,founder_review 这道门对它**永久关闭**。

## 2. 审计结论:根因链(每一环有代码位点)

issue 的怀疑方向(「单产出节点模板的 activation 铸造路径与三节点 tpl_code 不一致」)**成立**,且不一致点精确定位到一个条件判断。链条:

1. **tpl_prd 的唯一可执行节点是 `generic` 类型。**
   `menus/shapes/prd.yaml` 里 produce 节点 `role: pm`;`workflow-menu.ts` 的
   `nodeType()` 只认 design/implement/qa 三个 role,其余一律编译成 `"generic"`
   (`packages/teamlead/src/workflow-menu.ts:365-371`)。
2. **`generic` 不是 phase role。**
   `NODE_TYPE_REGISTRY.generic.isPhaseRole === false`
   (`packages/config/src/node-type-registry.ts`)。
3. **两个 dispatch 入口都把非 phase 节点降级成 `sessionRole: "main"`、`shareParentBranch: undefined`。**
   - 引擎 successor 派发:`workflow-engine-dispatcher.ts:2669/2679`
     (`role = isWorkflowPhaseRole(node.type) ? node.type : "main"`)。
   - fresh 入口派发:`runs-route.ts:3061-3065/3096-3097`
     (`workflowRole === "main" ? undefined : true`)。
4. **run-dispatcher 的 pre-launch TURN+activation 铸造被 phase-role 条件拦死。**
   两个铸造位点(fresh `run-dispatcher.ts:1683`、retry `run-dispatcher.ts:945-1006`)
   都是 `req.shareParentBranch === true && isWorkflowPhaseRole(role)` 才调
   `grantPrelaunchWorkflowTurn`。generic 节点两个条件都不满足 → **跳过铸造**。
   这是唯一的 spawn 期铸造入口(注释自证:"This ONE seam covers every spawn path")。
5. **gate 读取侧强耦合 TURN。**
   `CommDB.resolveRunnerWorkflowActivation`(`flywheel-comm/src/db.ts:5278`)要求
   session→issue 的 `three_stage_turn` 行存在、holder 是本 exec、且
   `runner_workflow_activation` 行与 TURN 四元组(activation_id/run_id/node_id/attempt)
   一致才返回 active。没有 TURN+activation → `legacy` → gate 命令
   (`flywheel-comm/src/index.ts:1966-1976`)抛
   `founder_review requires a current workflow activation`。

## 3. 影响面(比 issue 标题更宽,如实圈定)

**单产出节点模板 = 单个 generic 可执行节点 + founder gate**,四个模板全走同一路径:

| 模板 | founderReview | 后果 |
|------|---------------|------|
| tpl_prd | true | **双重 wedge**:`gate founder_review` 打不开;`complete --route needs_review/no_code` 在 `FLYWHEEL_FOUNDER_REVIEW_REQUIRED=1` 下同样要求 activation(`complete.ts:319-355`),也会 exit 1。founder 投递只能退回 Lead 手工做。 |
| tpl_design | true | 同上,双重 wedge。 |
| tpl_prototype | true | 同上,双重 wedge。 |
| tpl_generic_menu | 无 | 不撞 founder_review 门,但 completion payload 缺 `workflowActivation` 归因,落到 legacy carrier 推断路径(FLY-1650 已裁定该推断抛 `incoherent_ship_bundle` 的事故类)。 |

**tpl_code 三节点不受影响**:design/implement/qa 都是 phase role,条件满足,正常铸造
(这就是「其他 runner 有近期行」的来源)。

## 4. 关键反证:rework 路径对任意节点类型都铸造

`grantWorkflowReworkTurn`(`workflow-rework-coordinator.ts:40-87`)给 rework 目标
granted TURN 时 `phase = input.nodeId`(不限 phase role),activation 全量写入。
即:**同一个 tpl_prd produce 节点,如果走 founder-kickback rework 唤醒路径会拿到
activation,只有 fresh/retry spawn 拿不到**。spawn 路径的 phase-role gating 是
历史遗留(FLY-887/FLY-1257 时代 TURN 只服务三 phase 共享 worktree),泛化引擎
(FLY-1281/FLY-1372)把 activation 变成 engine 权威凭证后,spawn 条件没跟上。

## 5. 修复方向(brainstorm 选项)

### 方案 B(选定):扩 run-dispatcher 铸造条件到 engine-owned 全体
两个铸造位点的条件改为:

```ts
const engineOwned = req.generalizedExecution?.engineOwned === true;
if (engineOwned || (req.shareParentBranch === true && isWorkflowPhaseRole(role)))
```

phase 参数:非 phase 的 engine 节点用 `req.generalizedExecution.nodeId`
(与 rework 路径 `phase = nodeId` 的既有约定对齐;tpl_code 的 node id 恰好等于
role,phase 节点字节不变)。

理由:
- activation 是 engine 权威概念,不是共享 worktree 概念;engine-owned 派发
  永远带全量 activation payload(两个入口都构造了 `activationId` +
  `projectTurn`,`grantPrelaunchWorkflowTurn` 对 engine-owned 缺料本来就 throw);
- 单一 seam,fresh / retry / reconcile 重派全覆盖;
- 副作用审计干净(见 research.md §5):TurnBeltReconciler 对 engine-owned holder
  整体跳过;HeartbeatService `classifyTurn` phase 无关;turn CLI phase 仅展示;
  遗留 TURN 行已有既有文档定性 harmless + post-ship finalization `deleteTurn` 收口;
- 非 engine 的普通 runner 派发(无 `generalizedExecution`)字节不变。

### 方案 A(否决):dispatcher 把 generic 节点也标成 shareParentBranch=true
会把「共享 branch B」的 worktree 语义错误附加到单节点 run(它有自己独立
worktree),连带触发 phase-retry 的 branch-B startPoint 计算(`run-dispatcher.ts:945`
的 `isPhaseRetry` 同条件),改动面和语义污染都大。

### 方案 C(否决):gate 读取侧对无 activation 的 exec 按 execution_id 回退
fail-open:activation 的意义就是把 runner 绑到「当前 run/node/attempt 的引擎权威」,
回退等于让任何 exec 冒名开 founder round,FLY-1655 刚把这种 session 推断裁定为
事故源(`incoherent_ship_bundle`)。方向相反。

## 6. 存量处置(1782 等 active prd run)

见 plan.md §6:不做通用补铸脚本。修复 ship 后,对 wedged exec 走
close-runner → 引擎 dead-exec 重派(重派同样经 run-dispatcher 单 seam,新 exec
自然铸造);等不及重派的按现状由 Lead 手工投递 founder。理由:补铸需要恢复
spawn 时 rotate 出的 output/submission credential,凭证只在派发时境内存在,
补铸脚本要新开凭证轮换入口,复杂度远超一次受控重派。
