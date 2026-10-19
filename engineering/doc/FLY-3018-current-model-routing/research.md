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

## 7. 第三次重开：`6c091c4fd` 增量核对（2026-09-29）

对象：真仓 `xrliAnnie/flywheel` PR #1381，`gh pr view 1381 --json headRefOid` = `6c091c4fd2001c7aa3d41760dcde28b2054e23ff`（OPEN，MERGEABLE，base main）。源码来自本房源 `~/.flywheel/state/qa-rooms/8b128544-…/src`（HEAD 即 `6c091c4fd`）。

| 项 | 结果 |
|---|---|
| `7e28dd51c..6c091c4fd` 产品提交 | 仅 **`12b82e4e9` fix(FLY-3018): keep pre-flag bytes for absent no-overrides**；其余为 `0eb377157` merge main（带入 FLY-2913 等）、`aba3d175e`/`6c091c4fd` 文档、`e4aeb1fd3`/`6b9c731fb` 进度 |
| `12b82e4e9` 行为 | `qa-room-contract.ts:195` `no_overrides: z.boolean().optional()`；`parseRoomDrill` 把 `false`/缺省**剥掉**，只有 `true` 留在请求体与 `rerun_spec.driver.noOverrides`（`:247`）；`strength-two-contract.ts:244-254` `validateRerunSpecV1` 同样只在 `true` 时记录字段，缺省/false 与加旗前 canonical 字节、request digest 完全一致（代码复审 R1 #1-2：升级后重试旧记录/回执不再冲突） |
| 新增用例 | `strength-two-contract.test.ts` 「keeps pre-flag canonical bytes when no-overrides is absent or false」；`qa-room-drill-contract.test.ts` 「keeps the pre-flag drill digest when no-overrides is absent or false」 |
| 祖先关系 | `950870cee`、`54a6b6b77`、`47680000a` 均为 `6c091c4fd` 祖先（`git merge-base --is-ancestor`） |
| 精确头 full CI | run **36522011074**（`CI full-request 6c091c4fd…`）success，全部 job pass（Quick Gate / Unit ×8 / Script Tests ×6 / NPM payload）；另 run 36521462877 `CI` success |
| 对 QA 的影响 | `room drill --no-overrides` 仍产出 `driver.noOverrides: true`；**不带**该旗的 drill 其 spec 里没有 `noOverrides` 键（不再是 `false`）。§4.4 的 spec 检查要按「键存在且为 true」写 |

### 7.1 三处版本钉住的实测（本设计节点 2026-09-29 06:1xZ）

| 组件 | 实测 |
|---|---|
| 管理 Bridge `localhost:19873`（slot 3 房内 Bridge） | `/health` `buildSha` = `artifactBuildSha` = `6c091c4fd…`，`buildMode=built` |
| CLI `$FLYWHEEL_COMM_CLI`（房源 dist） | 房源 HEAD `6c091c4fd`；`room --help` 含 `drill … [--no-overrides]` |
| 生产 Bridge `localhost:9876` | `buildSha` = `95e5cd708…`；`950870cee`、`12b82e4e9` **都不是**其祖先 → 不认 `no_overrides` |
| 宿主 `~/.flywheel/models.json` | sha256 `27c91802901ed3d2a774eef76a7c221cd98b43bc99c745fa1e021ad33bc1d8b0`；implement = `impl_opus`(opus,3) : `impl_sol56`(codex,1)；`bindings.opus = claude-opus-5-5`（与 §3 一致） |

## 8. 起房拓扑事实：为什么 QA 节点当前起不了房

| 事实 | 位置 |
|---|---|
| 隔离 Bridge 的房服务默认关闭：`qaRoomServiceEnabled = storeEnabled && (!env.FLYWHEEL_ISOLATION_ROOT \|\| env.TEST_QA_ROOM_SERVICE === "1")` | `packages/teamlead/src/bridge/qa-room-host.ts:10-18` |
| 19873 进程环境含 `FLYWHEEL_ISOLATION_ROOT=/tmp/flywheel-test-slot-3`，无 `TEST_QA_ROOM_SERVICE`；`room list` 实测 `503 {"ok":false,"reason":"room_service_disabled"}` | `ps eww`；`qa-room-routes.ts:121`、`qa-room-service.ts:106` |
| 该键只能由 Lead 在宿主起外层验收房时注入：「Isolated Bridges default to room service disabled. A Lead may provision the outer FLY-2405 acceptance room with `TEST_QA_ROOM_SERVICE=1`; this is not an arbitrary runner environment option」 | `packages/qa-framework/README.md:400`；`scripts/test-deploy.sh:1149-1151` |
| `room deploy --env` 白名单只有 `TEST_REPLY_BY_ISSUE` 等三键，不含 `TEST_QA_ROOM_SERVICE` | `qa-room-contract.ts:53-55`；`room --help` |
| runner 身份认证：`Bearer FLYWHEEL_INGEST_TOKEN` + `execution_id` → **本 Bridge store** `getSession(execution)`；session 不存在/终态 → 403；须 `session_role=qa` 或当前 activation 节点为 implement/qa；有 workflow submission credential 时必须随请求带上 | `qa-room-routes.ts:41-90` |
| 推论：QA runner 的 `room deploy` 只能打派它的 19873；打生产 9876（store 不认识该 execution）会 403，且 9876 是 `95e5cd708`，drill strict schema 无 `no_overrides` → `field_not_supported` | 同上 + §7.1 |
| 槽锁是宿主级 `/tmp/flywheel-test-slot-<N>.lock/service-claim`，房内服务与生产服务共用同一锁目录，不会双分配同一槽 | `qa-room-service.ts:213-231` |
| 2026-09-29 06:1xZ 锁快照：slot 1 = room `c676decf`、slot 2+5 = room `1b4ae2a6`（campaign）、slot 3 = 本房 `8b128544`；**slot 4、6 无锁**。Lead 指令：只用 4 号 | `ls /tmp/flywheel-test-slot-*.lock` |
| 显式 `--slot 4`：`free(4)` 为假即 `409 slot_unavailable`；服务不会替 QA 换槽 | `qa-room-service.ts:200-214` |
| judge 通道规则：`manual_test_deploy` → `lane_unproven`；`generalized_e2e_real` 要求 site `/health` 的 `buildSha` = `artifactBuildSha` = `--head` 且 `driverExitCode === 0` 才 `satisfied` | `packages/teamlead/src/strength-two/judge.ts:88-113` |

结论：本轮 QA 若在**现状**外层房里直接执行 Lead 的「自己 room deploy」，第一步就会 503。唯一不越权的解法是 Lead 在宿主侧给 slot 3 外层 Bridge 加 `TEST_QA_ROOM_SERVICE=1` 并原地重启（sessions 保留，不 teardown 房），QA 再对 19873 起 slot 4 房。已以 question `d630d640-f104-44a4-a346-52e59aff88bf` 提交 Lead 裁定。
