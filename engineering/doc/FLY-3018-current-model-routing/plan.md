# FLY-3018 新派单按当前模型配置选模型 — 实施计划
Issue: FLY-3018 (https://linear.app/geoforge3d/issue/FLY-3018/引擎路由-派单不带覆盖时老单的实现节点opus被解析成-codex-模型gpt-6-astra-gpt-56-sol回执仍写-opus)
日期: 2026-09-28
基于: research.md

> 本 run 为「重开·只重做 QA」。本计划**不含任何代码改动**；它定义 implement 节点的零改动交卷边界与 QA 节点的可判定验收矩阵。产品设计（新 run 读当前配置、同 run 冻结、回执从冻结记录重建）继承真仓 PR #1381 分支 `engineering/doc/FLY-3018-current-model-routing/plan.md`（有效评审 `e59792b3…` APPROVED）及其 `advisory-dispositions.md`，本文不重述、不修改。

## 1. 一句话

**在 PR #1381 头上，用 `generalized_e2e_real` 通道在真房重跑「不带 overrides 派单」，证明每个节点严格按当前 models.json 选模型、回执 `alias (= exact)` 与 `sessions.runner_model` 一致，并把证据记成 judge 能判定的强度二记录。**

## 2. 精确头（Lead 已裁定：`7e28dd51c`）

| 项 | 值 |
|---|---|
| Lead 重开说明 | `76cf3c2498c59788f26a25274a2ee9bdc2d9c2d4` |
| PR #1381 当前头 = local = origin | `7e28dd51c58a67cb04f37d392a8cf1f2b1e64c89` |
| 差异 | `5dab14d4c` merge main；`950870cee` rerun_spec 支持 `noOverrides`；`97db7c68e` QA prompt fixture 同步 |
| 两头 full CI | 均绿（36496804828 / 36504079616） |
| 本计划默认 | **`7e28dd51c`**。理由：只有它能让强度二 `rerun_spec` 表达 no-overrides（上一轮 FAIL 的直接缺口）；implement 节点被要求核对 local=origin=PR 头一致，而这三者现在都是 `7e28dd51c` |
| 裁定通道 | question `c43580f2-d4cb-41db-835f-65e1971d6813` |
| **Lead 裁定（2026-09-28）** | **同意改房头到 `7e28dd51c58a67cb04f37d392a8cf1f2b1e64c89`**。Lead 已核对 PR #1381 当前精确头即该 SHA、CI OK，且它包含上一轮缺口所需的 `noOverrides` rerun spec 与 `room drill --no-overrides`。后续 implement / QA 统一绑定该精确头 |

裁定附带的硬约束（原话）：「若 head 再变化，先停并重新核对，不沿用本次裁定」。因此本计划下文所有「PR 头」均指 `7e28dd51c`；任何节点发现 `gh pr view 1381 --json headRefOid` ≠ 该 SHA，立即停下 ask Lead，不得自行沿用旧裁定。

## 3. implement 节点：零改动交卷

1. 在真仓 worktree 核对：`git rev-parse HEAD` = `git rev-parse origin/flywheel-FLY-3018` = `gh pr view 1381 --json headRefOid` 且 `git status --porcelain` 为空。
2. 不改任何文件、不 merge main、不重跑 CI。
3. 代码复审复用的合法条件（Codex R1 #6）：`await-codex-gate code` 只接受 `reviewedHeadSha` **等于当前 HEAD**、24h 内、绑定本执行身份与具体 review turn 的 `code-review.json`，不存在「把旧批准改绑到新头」的能力。实现节点先找出既有 APPROVED 轮次的真实 head / thread / turn / 回执；**只有当该 head 就是 `7e28dd51c`** 且未过期，才能直接过 gate。否则（既有批准落在 `76cf3c249` 或更早、或已过 24h）→ 这是流程阻断而非代码问题：ask Lead，由 Lead 决定是否授权在同一 Codex 线程上对 `76cf3c249..7e28dd51c` 三条提交做一轮**增量**复审并以 `7e28dd51c` 记录；⛔ 禁止改写 `reviewedHeadSha` / timestamp 自行过 gate。
4. `complete --route needs_review --pr 1381`。

负向守卫：若三者任一不一致（例如 PR 头再次前进），**停下** ask Lead，不自行 merge 或 push。

## 4. QA 节点：验收矩阵

### 4.0 执行环境前置（Codex R1 #1：三处版本分别钉住）

「房头 = `7e28dd51c`」只钉住了**房内** Bridge。`room deploy/drill/wait` 与 `evidence-run record` 打的是 **`FLYWHEEL_BRIDGE_URL` 指向的管理 Bridge**，`--no-overrides` 还要经过 **CLI**。三处缺一不可：

| 组件 | 要求 | 检查方式 | 不满足时 |
|---|---|---|---|
| 被测房 Bridge | buildSha = `7e28dd51c`；**Lead 裁定（question `560e8e5e-452c-42e1-95c6-ac45de2c51af`）：不指定固定 slot——slot 1–3 有 service-claim、4–5 属同一活动 campaign、6 有活动进程；QA 节点 `room deploy --slot auto`，成功后以返回快照的 `slot` 与 `roomInfo` 的 DB 路径作为 `--site`、seed/SQL 的唯一来源**（Codex R2 #1 背景：Codex R2 #1：`localhost:19873` 就是 slot 3 的 Bridge，slot 3 lock 已占——对它 `room deploy --slot 3` 会 `slot_unavailable`(409, `qa-room-service.ts:213`)，`evidence-run --site slot_529:3` 会被 `slot_port_is_self` 拒(`strength-two-evidence-route.ts:420`)） | deploy 返回快照的 `slot` + `roomInfo`（buildSha、端口、state dir） | `--slot auto` 返回 `slot_unavailable` → **阻断** ask Lead；⛔ 不复用看似空的 lock，⛔ 不清理/接管其他房，⛔ 不拆自测守卫 |
| 管理 Bridge（`$FLYWHEEL_BRIDGE_URL`） | **Lead 裁定（question `8af71ce4`）：QA 节点只挂 test-slot Bridge `http://localhost:19873`，不挂生产 Bridge**；preflight 要求 health 的 `buildSha` **与** `artifactBuildSha` 都等于 `7e28dd51c58a67cb04f37d392a8cf1f2b1e64c89`（该头含 `950870cee`：`qa-room-contract.ts` strict schema 才有 `no_overrides`，`strength-two-contract.ts` 才接受 `driver.noOverrides`） | `curl $FLYWHEEL_BRIDGE_URL/health`，两个字段逐字比对 | 生产 main `95e5cd708` 的 drill strict schema 对未知字段返回 `field_not_supported`（`qa-room-contract.ts` `parse()`，zod `unrecognized_keys`），服务端 evidence-run 对带 `noOverrides` 的 spec 返回 `evidence_run_rejected:rerun_spec_invalid:unknown_key` → **阻断**，ask Lead 解决执行环境（例如让 QA 节点挂在 PR 头的 Bridge 上）。⛔ 禁止自行部署生产 Bridge，⛔ 禁止去掉 `--no-overrides` 绕过 |
| CLI（`$FLYWHEEL_COMM_CLI`） | 同上，`room --help` 出现 `[--no-overrides]` | 直接看 usage | 同上 |

QA 报告开头记录三处 buildSha / 路径。Lead 与本设计各自实测：`localhost:19873`（slot 3）的 `buildSha` = `artifactBuildSha` = `7e28dd51c`；生产 `localhost:9876` = `95e5cd708`（不可用）。拓扑：**管理端 = slot 3 (19873)，被测房 = `--slot auto` 分到的 slot N**；后文 `--site slot_529:<N>`、房 DB 路径、seed 目标都指被测房，由返回的 `slot`/`roomInfo` 解析，⛔ 绝不写管理端（slot 3）的 DB。O2-seed 仅在新房成功部署且隔离性可证后执行（Lead 原话）。

### 4.1 房的所有权与参数（Codex R1 #2、#4）

- **所有权**：`qa-room-service` 只允许 owner、Lead 或「同 issue 且 owner 已终态」的后继执行 drill / teardown；Lead actor 为 `lead:<id>`，QA runner 是 execution 身份，两者不同 → Lead 起的房 QA 去 drill 会 `403 room_not_owned`。因此**默认**：Lead 给定参数，**QA 节点自己 `room deploy`** 成为 owner（`.flywheel/agents/nodes/qa.md:61` 即此形态）。备选：若 Lead 坚持自起，则 drill 由 Lead 执行、QA 只读房 DB 取证（§4.3），并在报告记录 owner、`request_id`、`operation_id` 与任何拒绝码。⛔ 不借用 Lead 凭据。**Lead 已裁定选默认**（question `8af71ce4-aa22-4eee-ac4e-34dca48a50b3`）：QA 节点自己 `room deploy` 成为 owner，Lead 只提供参数，不走 Lead 起房后 QA drill 的 403 路径。
- **参数**：`--slot auto`（Lead 裁定，不指定固定 slot）、`--generalized`、`--head 7e28dd51c58a67cb04f37d392a8cf1f2b1e64c89`、Claude runner、不带 `--stub-runner`、`--env TEST_REPLY_BY_ISSUE=1`。改参数 ask Lead。
- **models.json 不是房内隔离的**：房进程继承宿主 `HOME`（`qa-room-runtime.ts` `minimalRoomEnvironment`），模型配置默认读 `~/.flywheel/models.json`（`packages/config/src/model-config.ts` `configLocation()`，仅 `FLYWHEEL_MODELS_CONFIG` 可覆盖，而 deploy env 白名单不放行该键）。所以「房内 models.json」**就是生产文件**。QA 只做：drill 前后各记一次 `shasum -a 256 ~/.flywheel/models.json` 与 implement 节点摘要（`impl_opus`(opus,3) : `impl_sol56`(codex,1)，`bindings.opus = claude-opus-5-5`），两次必须一致；⛔ 任何节点都不得写该文件。原 O2「Lead 改房内配置」**撤销**（见 §4.3）。

### 4.2 步骤 ①②：精确头 CI 与两条新提交行为（Codex R1 #8）

| 步骤 | 做法 | 通过判据 |
|---|---|---|
| ① full CI | 在真仓 worktree（HEAD = `7e28dd51c`）：`node "$FLYWHEEL_COMM_CLI" ci-full ensure --pr 1381 --head 7e28dd51c58a67cb04f37d392a8cf1f2b1e64c89 --json`。exit 8 = 已请求/在跑，继续做独立 QA 并保活；exit 1/2 按输出恢复；PASS 前对同一 HEAD 重跑一次要求 exit 0 | 同头 exit 0；`CI Scope OK` 不算 |
| ② `54a6b6b77`（receipt alias 按钉住的 runtime vendor 解析） | `pnpm --filter flywheel-teamlead exec vitest run src/__tests__/workflow-dispatch-resolution.test.ts` | 含「alias 注册表 vendor ≠ dispatch vendor → exact 自标」用例绿 |
| ② `47680000a`（冻结 alias 不再对照可变 bindings） | `pnpm --filter flywheel-teamlead exec vitest run src/__tests__/workflow-template-selection.test.ts` | 含「热改绑后未缓存重放/恢复不误报 409」用例绿 |
| ② `950870cee`（rerun_spec `noOverrides`） | `pnpm --filter flywheel-comm exec vitest run src/__tests__/strength-two-contract.test.ts`，再单独 `pnpm --filter flywheel-comm exec vitest run src/commands/__tests__/room.test.ts` | `noOverrides` 规范化 / argv / `no_overrides_invalid` 用例绿 |
| ② 老 UUID 不同 policy 历史用例 | `pnpm --filter flywheel-teamlead exec vitest run src/__tests__/fly3018-current-model-routing.test.ts` | 老 UUID 带历史 Codex assignment、无 overrides start → 当前 policy 胜出；含 `simple_code` 用例绿 |

选择纪律（`qa.md:17`）：先 `git grep -lF` 发现相关测试并记录排除项与理由，**一次一个具体文件**跑，⛔ 不合并多个文件到一条命令，⛔ 不跑整包。

### 4.3 步骤 ③：真房「不带 overrides」派单矩阵（Codex R1 #3、#7）

驱动命令（唯一合法入口，不直接跑 `qa-529-generalized-e2e.mjs`）：

```sh
node "$FLYWHEEL_COMM_CLI" room drill --room <id> --issue <FLY-N> --real --no-overrides
# exit 3 → room wait --room <id> --operation <operation_id>；exit 4 = driver 非零
```

**先算再跑**（Codex R2 #3：`resolveAutomaticModelSplit` 未导出，不能从房源模块调用；⛔ 不为取证新增产品导出）：分桶是 issue UUID + node ID 的确定性哈希，同配置下可预先算出。QA 在房源 worktree 用 **现有导出** `getModelConfigSnapshot()`（`packages/config/src/model-config.ts`）与 `resolveWeightedModelSplit(policy, issueUuid, "implement")`（`packages/config/src/model-split.ts:260`，要求小写规范 UUID）做只读预计算：

```sh
cd <房源 worktree> && node -e '
const { getModelConfigSnapshot, resolveWeightedModelSplit } = require("./packages/config/dist/index.js");
const snap = getModelConfigSnapshot();
const policy = snap.modelSplit?.rule === "issue_node_weighted" ? snap.modelSplit : null;
if (!policy) throw new Error("modelSplit is not weighted/enabled");
for (const uuid of process.argv.slice(1)) {
  const r = resolveWeightedModelSplit(policy, uuid, "implement");
  console.log(JSON.stringify({ uuid, bucket: r.bucket, arm: r.arm.arm, model: r.arm.model, version: policy.version }));
}' <候选 issue UUID…>
```

输出（配置摘要 + UUID + bucket + 期望 arm）**drill 前写入报告**，并用房 DB 核实 N1/N2 在被测房**无任何历史 run**。选出：一个必落 `impl_opus` 的 issue（N1）、一个必落 `impl_sol56` 的 issue（N2）。「如落到 codex」这种碰运气的用例不算证据。issue UUID 取自房内注入的 Linear issue 记录。

| 例 | 输入 | 证明什么 | 缺失时 |
|---|---|---|---|
| **N1 新单·Opus 桶** | 预计算落 `impl_opus` 的 issue，drill 一次 | 每个节点 arm 来自当前 modelSplit；回执 `opus (= claude-opus-5-5)`；receipt = runtime = session | FAIL |
| **N2 新单·Codex 桶** | 预计算落 `impl_sol56` 的 issue | 仍合法选 Codex（`gpt-5.6-sol (= gpt-5.6-sol)` 或注册表别名），修复不是「全量强制 Opus」 | FAIL |
| **O1 老单·同配置** | 对 N1 的 issue 再 drill（新 key，房内已有 N1 历史） | 同 UUID 同配置同分桶 → 与 N1 一致；basis `ruleVersion` = 当前 | FAIL |
| **O2-seed 老单·不同 policy 历史（真房强证明，可选）** | **Lead 条件授权**（question `8af71ce4`）+ 下列全部前置（Codex R2 #2），任一不满足即**不 seed**：(a) 用**专用第三个 issue**（预计算落 `impl_opus`，被测房内无历史），seed 在它**首次 drill 之前**，这样旧实现继承的是**单一旧 policy**（若像 N1 那样已有当前 policy 记录再加旧 policy，旧实现会报 `prior workflow model assignment ambiguous`，不会出 Astra 回执）；(b) 房 DB 隔离且可写：`realpath` 证明是被测房 `<state dir>/teamlead.db` 而非宿主 `~/.flywheel/*.db` 或 slot 3 DB，且房 Bridge 为 file-backed 实时读；(c) 夹具是**完整信封**：以被测房里一条真实 N1 `model_arm_assigned` 事件 payload 为模板，仅替换 arm=`impl_astra`、modelAlias/model=`gpt-6-astra`、`basis.ruleVersion`/`basis.nodes`/`basis.weightAudit`/`basis.bucket` 为旧 policy 的一致值，保留 `basis.rule="issue_node_weighted"`、`basis.issueKey`=该 issue UUID、`basis.nodeId`=`implement`；写前用 `95e5cd708` 只读 checkout 的 `assertFrozenWeightedModelAssignment`（`workflow-model-assignment.ts`）与 `listWorkflowModelAssignmentEventsForIssue` 的 project+UUID 关联条件验证「旧 reader 选得中、旧校验器接受」；(d) 一条**参数化事务 SQL** 写入：一行 `workflow_run`（synthetic run_id、issue_id=UUID、project_name=房项目、status 终态、`selected_by`/`selection_reason`=`synthetic-fly3018-o2-seed`）+ 一行 `workflow_run_event`（kind=`model_arm_assigned`、node_id=`implement`、seq=1、synthetic event_uid、payload=上述信封），SQL 原文与参数入报告；(e) 写后读回原件比对摘要。然后 drill 该 issue `--real --no-overrides` |
修复前（`95e5cd708` `:125-165` 单一旧 policy 继承）会得 `opus (= gpt-6-astra)`；修复后期望 `impl_opus` / `opus (= claude-opus-5-5)`，且植入行字节不变。⛔ 绝不写宿主/生产 DB、slot 3 DB 或 `~/.flywheel/models.json`；⛔ 报告不得把 synthetic fixture 表述为生产历史事实 | (a)–(e) 任一不满足 → 不 seed，该项写「未做」，PASS 范围按 Lead 裁定降为 **单测 + 源码守卫 + 真房同配置矩阵**并明确报告（源码守卫：真仓 `git grep listWorkflowModelAssignmentEventsForIssue packages/teamlead/src/workflow-template-selection.ts` 在 `7e28dd51c` 为空） |

**任务类别缺口（诚实）**：driver 写死 `taskCategory: "code"`（`scripts/lib/qa-generalized-e2e-lib.mjs:745`），founder 事故是 `simple_code`。房内**没有**现成受权的 simple_code 派单入口（加 `--task-category` 是产品改动，超出本 run）。simple_code 证据只来自 §4.2 ② `fly3018-current-model-routing.test.ts`；报告单列此缺口，是否作为 PASS 阻断由 Lead 裁定（同一 question）。

**取证（只读被测房 DB：路径从 `roomInfo` 的 state dir 解析为 `<state dir>/teamlead.db`，形如 `/tmp/flywheel-test-slot-<N>/teamlead.db`，⛔ 不是管理端 slot 3 的 `/tmp/flywheel-test-slot-3/teamlead.db`；`sqlite3 -readonly`）**。drill 步骤输出不含完整 start 响应，必须回房 DB 取原件，⛔ 不用重建值冒充原始响应：

```sql
-- 原始回执：response.resolved.nodeModels（不是 response.nodeModels）
SELECT r.run_id, r.node_id, r.attempt, r.execution_id, resp.response_json
  FROM workflow_start_reservation r JOIN workflow_start_response resp USING (idempotency_key)
 WHERE r.run_id = :run;
-- 本 run 冻结 assignment：payload 含 arm / modelAlias / model / basis{ruleVersion,issueKey,nodeId,bucket,nodes,weightAudit}（没有 basis.policy）
SELECT seq, kind, node_id, execution_id, payload FROM workflow_run_event
 WHERE run_id = :run AND kind IN ('design_model_arm_assigned','model_arm_assigned');
-- 不可变运行时
SELECT execution_id, node_id, attempt, vendor, model, effort FROM workflow_execution_runtime WHERE run_id = :run;
-- 会话实际模型（按 execution_id 关联）
SELECT execution_id, runner_model, dispatch_model FROM sessions WHERE execution_id IN (...);
```

每例保留：request key、issue UUID、预计算期望 arm、run id、node id、attempt、execution id、宿主 models.json sha256、`response.resolved.nodeModels` 原文、assignment payload、runtime `vendor/model/effort`、`sessions.runner_model`、实际会话证据（Claude TUI 或 Codex 会话头）、effective effort 对照。

判定顺序：先断言 **receipt exact = runtime.model = 同 execution 的 sessions.runner_model**（缺行或多行即 FAIL），再核对实际载体。code 类别必须观察到后继 implement 真启动，不能拿 design session 冒充。

### 4.4 步骤 ④：强度二记录与提交（Codex R1 #5）

1. 完整命令（`evidence-run.ts` 全部必填；`--local-copy` 不能替代 URL）：

```sh
node "$FLYWHEEL_COMM_CLI" evidence-run record \
  --exec-id <QA exec id> \
  --head 7e28dd51c58a67cb04f37d392a8cf1f2b1e64c89 \
  --site slot_529:<deploy 返回的 slot N> --lane generalized_e2e_real \
  --record-url <已发布证据的 https URL> \
  --rerun-spec <服务返回的 rerun_spec 文件，须含 lane=generalized_e2e_real 且 driver.noOverrides=true> \
  --driver-exit-code <drill 返回的真实 driver_exit_code> \
  --record-id <稳定 id，重试沿用> [--local-copy <仅 evidence_copy=ok 时>]
```

2. **exit 0 ≠ satisfied**：收到合法 ACK（含 `verdict=unsatisfied`）也退出 0。QA 必须保存 ACK 原文，要求本次矩阵对应记录的 `verdict` / `ran` / `record` 三者都 satisfied 才算强度二通过；`lane_unproven` 只是其中一种失败。
3. driver 非零、证据缺、`evidence_copy` 不全、探测失败 → 先重跑或 FAIL；同一请求结果不确定时用**同一 record-id、同一 payload** 重试，不换 id。
4. `qa-result` 提交 PASS 时若被 `land_head_pr_identity_unavailable` 拒：按 CLI 恢复路径**显式交 FAIL**，原因写「FLY-2407 部署边界缺陷，产品证据本身 PASS」，附 §4.3 证据清单；不绕过、不伪造 identity。
5. 房子 teardown 只由 owner / Lead / 同 issue 后继做；保留 `evidence_dir`。

### 4.5 QA 负向守卫

- `drill_config_not_reproducible` → 房参数不对（Codex-runner 房、非 main fixture、`--no-lead`），ask Lead 改房，不改自己的命令绕过。
- 回执出现跨 vendor 拼接（如 `opus (= gpt-*)`）→ 直接 FAIL，附 `response.resolved.nodeModels` 原文。
- 管理 Bridge 或 CLI 不含 `950870cee`（§4.0；症状 `field_not_supported` / `rerun_spec_invalid:unknown_key`）→ 阻断 ask Lead；⛔ 不去掉 `--no-overrides`，⛔ 不自行部署。
- `slot_unavailable`（`--slot auto` 无空位）/ `slot_port_is_self`（site 指到管理端）→ ask Lead 阻断（§4.0）；⛔ 不拆守卫，⛔ 不复用空 lock，⛔ 不接管他人房。
- `403 room_not_owned` → 所有权错位（§4.1），ask Lead，⛔ 不借 Lead 凭据。
- 宿主 `~/.flywheel/models.json` sha256 在矩阵前后不一致 → 环境被改动，FAIL 并上报。
- 房头 sha ≠ `7e28dd51c`，或 PR #1381 头再次前进 → 停，ask Lead 重新核对；不沿用本次裁定。

## 5. 数据与身份（本轮不新增）

沿用 PR 头已有结构，无迁移：`StartReservation(idempotencyKey, runId)` → `RunSnapshot(modelRouting, dispatchPinned)` + `AssignmentEvent(arm, modelAlias, model, basis{ruleVersion, issueKey, nodeId, bucket, nodes, weightAudit})` → `ExecutionRuntime(executionId, vendor, model, effort)` → `sessions.runner_model`。回执只从这条链的**本 run** 记录投影。

## 6. 取舍与放弃的替代

| 放弃 | 原因 |
|---|---|
| 沿用 `manual_test_deploy` 手工记录 | judge.ts:110 写死 `lane_unproven`，上一轮就此 FAIL |
| 改 judge 让 manual 通道可判定 | 属于产品改动，超出「只重做 QA」边界，且降低强度二的证明力 |
| 在 `76cf3c249` 上硬判强度二 | 该头 rerun_spec 表达不了 no-overrides，证据不可判定 |
| 由 Lead 或 QA 改「房内」models.json 做 O2 | 房读的是宿主 `~/.flywheel/models.json` = 生产文件，改它就是改生产，且没有恢复边界（Codex R1 #4）；改为 O2-seed（房 DB 历史夹具，需授权）或退回单测+源码守卫 |
| Lead 起房、QA 去 drill | owner 是 `lead:<id>`，QA 身份会 403 `room_not_owned`（Codex R1 #2） |
| 只检查 FLY-2407 就开跑 | 管理 Bridge 在 main 上没有 `no_overrides` schema：drill 被拒 `field_not_supported`，evidence-run 被拒 `rerun_spec_invalid:unknown_key`（Codex R1 #1 / R2 #4）；报告保留实际响应原文 |
| 管理端与被测房同为 slot 3 | `slot_unavailable` / `slot_port_is_self` 自测守卫必拒（Codex R2 #1）；被测房用 `--slot auto` 另开 |
| Lead 指定固定 slot | 当前无可安全指定的空闲 slot（1–3 claim、4–5 campaign、6 活动进程）；固定指定会抢占，故用 `--slot auto` + 无空位即阻断 |

## 7. 回滚与边界（诚实）

- 本 run 无代码改动；**配置也不写**（宿主 models.json 只读取摘要），所以没有代码或配置回滚对象；O2-seed 若获授权，其回滚对象是房 DB 中植入的行，随房 teardown 一并消失，报告记录植入 SQL；产品代码回滚语义见真仓 plan §5（回退会恢复历史继承缺陷，且新旧 policy 并存后旧代码可能报 `prior workflow model assignment ambiguous`）。
- 本设计**做**：审计头差异并提交 Lead 裁定；给 implement 零改动边界；给 QA 可执行、可判定的矩阵与命令。
- 本设计**不做**：不改代码、不起房、不派单、不判定 QA 结果、不重派生产老单（FLY-2405/2909 由 Lead 按既有授权路径处置）、不处理统计口径（scorecard mixed 分组是已知 follow-up）。
- merge 与部署分离；merge 不等于生产生效，只有独立 updater 在其窗口部署。

## 8. 相关测试（本机只跑相关；一次一个文件）

```sh
node "$FLYWHEEL_COMM_CLI" ci-full ensure --pr 1381 --head 7e28dd51c58a67cb04f37d392a8cf1f2b1e64c89 --json
pnpm --filter flywheel-teamlead exec vitest run src/__tests__/fly3018-current-model-routing.test.ts
pnpm --filter flywheel-teamlead exec vitest run src/__tests__/workflow-dispatch-resolution.test.ts
pnpm --filter flywheel-teamlead exec vitest run src/__tests__/workflow-template-selection.test.ts
pnpm --filter flywheel-teamlead exec vitest run src/bridge/__tests__/qa-room-drill-contract.test.ts
pnpm --filter flywheel-comm exec vitest run src/__tests__/strength-two-contract.test.ts
pnpm --filter flywheel-comm exec vitest run src/commands/__tests__/room.test.ts
```

## 9. 设计交付游标

1. 三份文档 + progress 提交推送；`stage set design_review --plan …` 并按 gate 流程取得 `reviewVerdict=APPROVED`（仅 stage 变化不算）。
2. founder HTML（本地 mmdc 预渲染 SVG、逐段意见层、`【页面意见汇总】FLY-3018`）提交推送、静默 publish、向 Lead 报 URL。
3. `complete --route phase_design_complete`；不派后继、不申请 ship。
