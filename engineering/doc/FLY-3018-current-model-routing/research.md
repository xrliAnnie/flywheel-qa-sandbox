# FLY-3018 新派单按当前模型配置选模型 — 调研
Issue: FLY-3018 (https://linear.app/geoforge3d/issue/FLY-3018/引擎路由-派单不带覆盖时老单的实现节点opus被解析成-codex-模型gpt-6-astra-gpt-56-sol回执仍写-opus)
日期: 2026-09-28
基于: exploration.md

调研对象是真仓 `xrliAnnie/flywheel` 的 PR #1381 分支，源码来自 QA 房 `~/.flywheel/state/qa-rooms/3f9ad286-…/src`（HEAD `7e28dd51c`），对照 `origin/main`（`95e5cd708` 之后）。所有行号以该头为准。本轮只读源码与 CI，未跑测试、未改代码、未触生产 DB。

## 1. 根因在 main 上仍存在（对照）

```
$ git show origin/main:packages/teamlead/src/workflow-template-selection.ts | grep -n listWorkflowModelAssignmentEventsForIssue
125:		for (const event of store.listWorkflowModelAssignmentEventsForIssue(
```

`resolveAutomaticModelSplit`（main `:99`）算完当前选择后遍历该 issue 全部历史 assignment 事件并覆写。这就是老单被牵回旧 policy（`impl_astra` / 旧 `impl_sol56`）的地方。

## 2. PR 头上的修复形态（逐层核对）

### 2.1 选择层：新 start 只读当前配置

`workflow-template-selection.ts:99-131`（HEAD）：

- `resolveAutomaticModelSplit(templateId, issueIdentifier, issueKey?, menuOverrides?)` 不再接收 `store`，只 `loadWorkflowMenuLibrary()` + `resolveMenuOverrides(menu, menuOverrides, {issueIdentifier, issueKey})`。
- 注释明确：「a fresh start reads today's model policy only… another run of the same issue never steers it」。
- `git grep listWorkflowModelAssignmentEventsForIssue packages/teamlead/src/workflow-template-selection.ts` 在 HEAD 为空；StateStore 的该查询未删除（不再被新 start 调用）。

### 2.2 预准入：每条 start 路径校验本 run 冻结记录

`workflow-template-selection.ts:136` `readFrozenRunModelAssignments`：读取**本 run** 在 materialization 冻结的 assignment，逐节点对照该 run 的 pinned dispatch；任何不一致抛错，调用方在准入前拒绝（稳定 409，原 run/reservation 保留，同 key 重试同一拒绝）。Codex 复审 R1/R2 把它收敛为「对每个节点直接调用导出的 launch reader `resolveModelAssignment` 裁决」，避免两套基数/比较口径。

### 2.3 回执层：别名只在能证明指向该模型时保留

`workflow-menu.ts:1094-1108` `aliasNamesModel(aliasTarget, dispatch)`：

1. `aliasTarget.runtimeVendor !== dispatch.vendor` → false（跨 vendor 一票否决，Codex R3 补的）；
2. `aliasTarget.id === dispatch.model` → true；
3. 否则要求 `modelFamilyCode` 相同且 `[1m]` 变体相同（FLY-2775 的 Opus 升代窗口：`opus (= claude-opus-5)` 仍合法）。

`workflow-menu.ts:1124` `pinMenuReceiptsToRun(receipts, snapshot, assignments)`：

- 无 pinned dispatch → 抛错（调用方准入前拒绝）；
- 有本 run assignment 且 `assignment.model !== dispatch.model` → 抛错；
- 有 assignment：别名取 `assignment.modelAlias`，但只在 `aliasNamesModel(registry(alias), dispatch)` 为真时保留；
- 无 assignment：解析菜单回执 `alias (= exact)`，只在 `aliasNamesModel(registry(exact), dispatch)` 为真时保留菜单别名；
- 否则 `alias = dispatch.model`（exact 自标，形如 `gpt-6-astra (= gpt-6-astra)`）；
- effort = `narrowEffort(dispatch)`，被收窄掉就不写。

**结论**：在 PR 头上，`opus (= gpt-6-astra)` 这种拼接在结构上不可能再出现——alias 注册表条目 vendor=claude、dispatch vendor=codex，第一条就否决。

### 2.4 QA 工具链：no-overrides 贯通到强度二

| 提交 | 内容 |
|---|---|
| `16847c397` | `scripts/qa-529-generalized-e2e.mjs --no-overrides`：不传任何节点覆盖。默认仍钉 `eng_design=fable`、`implement=codex`（`scripts/lib/qa-generalized-e2e-lib.mjs:731-757`）——这就是上一轮「real 车道无法诚实复现不带覆盖」的原因 |
| `950870cee` | `GeneralizedRerunSpecV1.driver.noOverrides?: boolean`（`strength-two-contract.ts`）：旧 spec 缺字段规范化为 `false`；非布尔拒 `no_overrides_invalid`；`true` 时 `deriveRerunArgv` 追加 `--no-overrides`。`room drill --no-overrides`（`commands/room.ts`）→ Bridge strict schema（`qa-room-contract.ts`）→ 首次真实 driver argv → 服务生成的 `rerun_spec`，首次执行与证据重放同一选择 |
| `97db7c68e` | 仅同步 `fly2533-phase-baseline.json`（qa.md 加了 `--no-overrides` 说明后 pinned QA domain 与精确预算失配），修 `76cf3c249` 之后的 CI 红灯 |

`.flywheel/agents/nodes/qa.md:63` 已写明 QA 节点用法：`node "$FLYWHEEL_COMM_CLI" room drill --room <id> --issue <FLY-N> --real --no-overrides`；Codex-runner 房与非可复现设置会被拒 `drill_config_not_reproducible`；绝不在 runner 沙箱直接跑 `qa-529-generalized-e2e.mjs`。

### 2.5 强度二 judge 的通道规则

`packages/teamlead/src/strength-two/judge.ts:110-111`：

```ts
if (input.lane === "manual_test_deploy") {
    return { satisfied: false, reason: "lane_unproven" };
```

通道枚举（`strength-two-contract.ts:5-6`）：`generalized_e2e_stub` / `generalized_e2e_real` / `manual_test_deploy`。上一轮 e8074839 记录走 `manual_test_deploy` 故必 FAIL；本轮必须走 `generalized_e2e_real`（`deriveRerunArgv` 在该 lane 追加 `--real`，`:307`）。

### 2.6 primary PR identity（FLY-2407 边界）

`packages/flywheel-comm/src/commands/qa-result.ts:91,114` 列有 `land_head_pr_identity_unavailable` 拒绝码；Bridge 侧在 `workflow-decision-routes.ts`。FLY-2407（`8e44ac64d`）已合入 main 并随 `5dab14d4c` 进入 PR 头。上一轮首交落在 FLY-2407 部署边界前的旧 Bridge 才缺 identity；本轮 Bridge buildSha `95e5cd708` 已含 FLY-2407。若仍被拒，按 Lead 判据显式交 FAIL 并写明原因。

### 2.7 管理端契约与房的配置来源（设计评审 R1 补核）

- `room drill` 请求发往 `FLYWHEEL_BRIDGE_URL` 指向的**管理 Bridge**（`commands/room.ts:508`），不是房内 Bridge。`git show 95e5cd708:packages/teamlead/src/bridge/qa-room-contract.ts | grep -c no_overrides` = 0：生产 main 的 strict schema 不认 `no_overrides`，会 `unknown_key`。本沙箱 `localhost:19873` buildSha = `7e28dd51c`，生产 `localhost:9876` = `95e5cd708`。
- 房所有权：`qa-room-routes.ts` Lead actor = `lead:<id>`；`qa-room-service.ts:324-333` 非 owner 且非 Lead 的 drill 只在「同 issue 且 owner 已终态」时放行，否则 `403 room_not_owned`。
- 房进程环境 `minimalRoomEnvironment` 继承宿主 `HOME`；`packages/config/src/model-config.ts` `configLocation()` 默认 `~/.flywheel/models.json`，仅 `FLYWHEEL_MODELS_CONFIG` 可覆盖，deploy env 白名单（`qa-room-contract.ts` `env` strict 对象）不放行该键 → 房读的就是生产 models.json。
- 原始回执字段为 `response.resolved.nodeModels`（`runs-route.ts:4108`）；weighted basis 字段为 `issueIdentifier/issueKey/nodeId/rule/ruleVersion/bucket/nodes/weightAudit`（`workflow-menu.ts:899-907`）。回执原件持久化在 `workflow_start_response.response_json`，经 `workflow_start_reservation(idempotency_key → run_id/node_id/attempt/execution_id)` 关联；运行时在 `workflow_execution_runtime(vendor, model, effort)`；会话在 `sessions(execution_id, runner_model, dispatch_model)`。
- `evidence-run record` 必填 `--head`（40 位小写）、`--site slot_529:<n>`、`--lane`、`--record-url`（https）、`--rerun-spec`、generalized 通道必填 `--driver-exit-code`；合法 ACK 即便 `verdict=unsatisfied` 也 exit 0（`evidence-run.ts:382-387`）。
- `await-codex-gate code` 要求 `reviewedHeadSha` = 当前 HEAD（`await-codex-gate.ts:235-254`），没有改绑旧批准的能力。
- driver 写死 `taskCategory: "code"`（`scripts/lib/qa-generalized-e2e-lib.mjs:745`）。

## 3. 当前 models.json（生产 `~/.flywheel/models.json`，只读；房与生产共用同一文件）

```json
"modelSplit": {"enabled": true, "rule": "issue_node_weighted",
  "nodes": {
    "eng_design": [{"arm":"design_astra","model":"astra","weight":1},{"arm":"design_opus","model":"opus","weight":3}],
    "implement":  [{"arm":"impl_opus","model":"opus","weight":3},{"arm":"impl_sol56","model":"codex","weight":1}],
    "qa":         [{"arm":"qa_sol56","model":"codex","weight":3},{"arm":"qa_opus","model":"opus","weight":1}]}}
"bindings": {"fable":"claude-fable-5-1","opus":"claude-opus-5-5","opus1m":"claude-opus-5-5[1m]"}
```

implement 没有 astra arm；`opus` 绑定 `claude-opus-5-5`。分桶按 issue UUID + node ID 确定性哈希，同配置下同 issue 结果稳定；权重是分桶比例，少量派单不保证恰好 3:1。

## 4. 两个候选头的 CI 与差异

| 头 | full CI | 备注 |
|---|---|---|
| `76cf3c249`（Lead 重开说明） | 绿，run 36496804828 | 有直连 driver `--no-overrides`，**无** rerun_spec `noOverrides`；后续 exact-head CI 曾红（Unit heavy，`Blueprint.generalized-workflow.test.ts:620`）——该红灯出现在把 qa.md 改动带入之后，由 `97db7c68e` 修 |
| `7e28dd51c`（PR #1381 当前头 = local = origin） | 绿，run 36504079616（全部 job pass） | 含 `950870cee` + `97db7c68e` + merge main |

`gh pr view 1381 --json headRefOid` 返回 `7e28dd51c58a67cb04f37d392a8cf1f2b1e64c89`；与 origin/main 的 merge-tree 由 Lead 说明确认干净。

## 5. 测试证据（PR 头已含，QA 只需引用）

| 文件 | 用例数 | 覆盖 |
|---|---|---|
| `packages/teamlead/src/__tests__/fly3018-current-model-routing.test.ts` | 8 | 路由级：老/新 UUID 无 overrides start、回执与 runtime/session 联接 |
| `packages/teamlead/src/__tests__/workflow-template-selection.test.ts` | 30 | 历史不牵引、同 key 重放、预准入拒绝 |
| `packages/teamlead/src/__tests__/workflow-dispatch-resolution.test.ts` | 15 | 回执 alias/exact/effort 投影，含 FLY-2775 升代用例与热改绑用例 |
| `packages/flywheel-comm/src/__tests__/strength-two-contract.test.ts` | 7 | `noOverrides` 规范化、`--no-overrides` argv、`no_overrides_invalid` |
| `packages/teamlead/src/bridge/__tests__/qa-room-drill-contract.test.ts`、`commands/__tests__/room.test.ts` | — | `room drill --no-overrides` wire body 与 schema |

## 6. 调研结论

1. 修复完整且在结构上封死了错标签；本 run 不需要也不应改代码。
2. 上一轮 QA 的两处 FAIL 原因（通道 `lane_unproven`、PR identity 缺失）在 PR 头 + 当前 Bridge 上都有对应机制可解，前提是房头为 `7e28dd51c`。
3. 房头裁定已落：Lead 同意 `7e28dd51c`（question `c43580f2`，2026-09-28），并要求 head 再变化时先停再核对。
