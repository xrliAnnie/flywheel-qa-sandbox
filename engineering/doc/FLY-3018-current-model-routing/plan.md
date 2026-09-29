# FLY-3018 新派单按当前模型配置选模型 — 实施计划
Issue: FLY-3018 (https://linear.app/geoforge3d/issue/FLY-3018/引擎路由-派单不带覆盖时老单的实现节点opus被解析成-codex-模型gpt-6-astra-gpt-56-sol回执仍写-opus)
日期: 2026-09-29
基于: research.md

> 本 run 为「重开·只重做 QA」的**第三次**（Lead 2026-09-29 05:3xZ）。本计划**不含任何代码改动**；它定义 implement 节点的零改动交卷边界与 QA 节点的可判定验收矩阵。产品设计（新 run 读当前配置、同 run 冻结、回执从冻结记录重建）继承真仓 PR #1381 分支 `engineering/doc/FLY-3018-current-model-routing/plan.md`（有效评审 `e59792b3…` APPROVED）及其 `advisory-dispositions.md`，本文不重述、不修改。版本 **v2.5**：相对 v2.4 只改「精确头 → `6c091c4fd`、被测房 → 显式 slot 4、新增房服务 preflight 与 `12b82e4e9` 用例」，其余判据原样保留。**v2.5.1（Codex R1 两项）**：④ 的顺序改为「记录 → 自己 teardown → 最后 qa-result」（qa-result 会消耗 submission credential，之后 teardown 必 403）；所有 preflight / 守卫改为**正向条件 + 保留 CLI 原始输出**，不再假设 CLI 会打印服务端 reason。

## 1. 一句话

**在 PR #1381 头 `6c091c4fd` 上，用 `generalized_e2e_real` 通道在真房（slot 4）重跑「不带 overrides 派单」，证明每个节点严格按当前 models.json 选模型、回执 `alias (= exact)` 与 `sessions.runner_model` 一致，并把证据记成 judge 能判定的强度二记录。**

## 2. 精确头（Lead 指令直接给定：`6c091c4fd`）

| 项 | 值 |
|---|---|
| Lead 05:3xZ 指令写明的头 = PR #1381 当前头 = 真仓 `origin/flywheel-FLY-3018` | `6c091c4fd2001c7aa3d41760dcde28b2054e23ff` |
| 相对上一轮定稿 `7e28dd51c` 的差异 | 产品提交仅 `12b82e4e9`（`no_overrides` 缺省/false 保持加旗前字节）；`0eb377157` merge main；其余文档/进度 |
| 祖先核对 | `950870cee`（rerun_spec `noOverrides`）、`54a6b6b77`（receipt alias 按 runtime vendor）、`47680000a`（冻结 alias 不对照可变 bindings）均为祖先 |
| 精确头 full CI | run `36522011074` success，全部 job pass；`CI Scope OK` 不算 |
| 头裁定的效力 | v2.4 的裁定 `c43580f2`（`7e28dd51c`）按其硬约束「head 再变化不沿用」**失效**；本轮 Lead 指令自己写明 `6c091c4fd`，即为新裁定，无需再问 |

硬约束不变：任何节点发现 `gh pr view 1381 --json headRefOid` ≠ `6c091c4fd…`，**立即停下 ask Lead**，不得自行沿用。

## 3. implement 节点：零改动交卷（Lead 原话「不要问 Lead」）

1. 在真仓 worktree 核对：`git rev-parse HEAD` = `git rev-parse origin/flywheel-FLY-3018` = `gh pr view 1381 --json headRefOid` = `6c091c4fd…` 且 `git status --porcelain` 为空。
2. 不改任何文件、不 merge main、不重跑 CI。
3. 代码复审复用（Codex R1 #6 规则不变）：`await-codex-gate code` 只接受 `reviewedHeadSha` **等于当前 HEAD**、24h 内、绑定本执行身份与具体 review turn 的 `code-review.json`。真仓 `6c091c4fd` 提交信息「record review round 1 fix」表明既有代码复审轮次落在该头；实现节点先找出其真实 head / thread / turn / 回执，**只有当该 head 就是 `6c091c4fd`** 且未过期才直接过 gate。否则 → 流程阻断而非代码问题：ask Lead 授权在同一 Codex 线程做**增量**复审并以 `6c091c4fd` 记录；⛔ 禁止改写 `reviewedHeadSha` / timestamp 自行过 gate。
4. `complete --route needs_review --pr 1381`。

负向守卫：三者任一不一致（例如 PR 头再次前进）→ **停下** ask Lead，不自行 merge 或 push。

## 4. QA 节点：验收矩阵

### 4.0 执行环境前置（三处版本 + 房服务开关，缺一不可）

「房头 = `6c091c4fd`」只钉住**被测房**的 Bridge。`room deploy/drill/wait/teardown` 与 `evidence-run record` 打的是 **`$FLYWHEEL_BRIDGE_URL` 指向的管理 Bridge**（本工作流 = slot 3 房内 Bridge `http://localhost:19873`），`--no-overrides` 还要经过 **CLI**。

| 组件 | 要求 | 检查方式 | 不满足时 |
|---|---|---|---|
| **管理 Bridge 房服务开关（本轮新增，第一道）** | **正向条件**：`node "$FLYWHEEL_COMM_CLI" room list` **exit 0 且 stdout 是有效 JSON `{ok:true, rooms:[…]}`**（可为空数组）。其它任何结果（非零 exit、`service request failed after 3 attempts (HTTP 503)`、`request refused (HTTP 401/403)`、transport failure）一律**阻断** | 跑一次 `room list`，把 **完整 stdout/stderr、exit code、`$FLYWHEEL_BRIDGE_URL`** 原样写进报告 | **阻断，ask Lead（引用 `d630d640`），不猜 reason**。CLI 对 5xx 会丢弃响应体、只打印 `HTTP 503`（`commands/room.ts:577-618`，reason 白名单仅 `operation_not_in_room`/`inconsistent_state`），所以 QA **拿不到** `room_service_disabled` 字样；「未开关」这个归因来自本设计节点在只读探测中直接看到的服务端诊断（research §8），QA 只引用、不重现。Lead 加开关并重启后若仍非正向 → 可能是 `room_auth_unconfigured`/`room_authority_unavailable`/凭据问题，**由 Lead/宿主看外层 Bridge 服务端诊断**，QA 继续等，⛔ 不改任何 Bridge 环境/配置、⛔ 不打生产 `9876`、⛔ 不换 Bridge、⛔ 不直接跑 `qa-529-generalized-e2e.mjs` |
| 管理 Bridge 版本 | `curl $FLYWHEEL_BRIDGE_URL/health` 的 `buildSha` **与** `artifactBuildSha` 都 = `6c091c4fd2001c7aa3d41760dcde28b2054e23ff`（实测已满足，research §7.1） | 两个字段逐字比对 | 阻断 ask Lead；⛔ 不自行部署、⛔ 不去掉 `--no-overrides` |
| CLI（`$FLYWHEEL_COMM_CLI`） | `room --help` 含 `[--no-overrides]`（实测已满足） | 直接看 usage | 同上 |
| 被测房 Bridge | deploy 返回快照 `roomInfo.buildSha` = `6c091c4fd…`；judge 还要求 site `/health` 的 `buildSha` = `artifactBuildSha` = `--head`（`judge.ts:104-108`） | deploy 快照 + `curl http://localhost:19874/health` | 头不符 → 停，ask Lead |

**Lead 裁定（question `d630d640`，2026-09-29）：选 A**。原话要点：已把 `TEST_QA_ROOM_SERVICE=1` 写入 slot 3 的安全 launch spec；官方 bridge-only cycle 因 stale `bridge.pid`/ownership（24341 已死，实际唯一 listener 25164）fail-closed，Lead 沙箱无 ps 身份/祖先核验能力，不能安全强杀或手改 PID；已在 FLY-3018 thread 提交 founderAsk 请宿主 operator 完成**保 sessions 的 bridge-only cycle**。**QA 必须保持上表第一道 preflight：只有 `room list` 不再 `room_service_disabled` 才执行 slot 4 deploy；不改打生产 Bridge、不绕过验证。** 在此之前 QA 先做与房无关的步骤 ①②（§4.2），并按 TURN 规则轮询等待，不空转报 FAIL。

QA 报告开头逐字记录：管理 Bridge 两个 sha、CLI usage 片段、`room list` 首次 **CLI 输出原文（stdout/stderr/exit code）**、被测房 `roomInfo`、宿主 `~/.flywheel/models.json` sha256。拓扑：**管理端 = slot 3 (19873)，被测房 = slot 4 (19874)**；后文 `--site slot_529:4`、房 DB 路径、seed 目标都指被测房，由返回的 `roomInfo` 解析，⛔ 绝不写管理端（slot 3）的 DB。

### 4.1 房的所有权与参数

- **所有权**：QA 节点自己 `room deploy` 成为 owner（Lead 03:4xZ 更正：「房由 Lead 起」作废）；drill / teardown 只有 owner、Lead 或「同 issue 且 owner 已终态」的后继能做。⛔ 不借用 Lead 凭据。房用完 **QA 自己 teardown**（保留 `evidence_dir`）。
- **参数（Lead 05:3xZ：只用 4 号，别用 auto）**：

```sh
node "$FLYWHEEL_COMM_CLI" room deploy --slot 4 \
  --head 6c091c4fd2001c7aa3d41760dcde28b2054e23ff \
  --generalized --env TEST_REPLY_BY_ISSUE=1
# 不带 --stub-runner（真 Claude runner）、不带 --codex-runner / --no-lead / --from-branch（否则 drill 拒 drill_config_not_reproducible）
# exit 3 → room wait --room <id>
```

  `--slot 4` 返回 `request refused (HTTP 409)` → CLI **不会**告诉你 reason（可能是 `slot_unavailable`、`actor_has_room` 等），QA 只记「HTTP 409，reason 未确认」+ 完整输出，**阻断 ask Lead** 由 Lead 看服务端审计；⛔ 不改用 `--slot auto`（Lead 明令）、⛔ 不用 1/2/3（1–3 是断电后的死房 FLY-3046，且 1/2(+5)/3 当前有 service-claim）、⛔ 不清理/接管任何锁。`request refused (HTTP 403)` 同理（凭据/角色/所有权任一），记原文 ask Lead。改参数 ask Lead。
- **models.json 不是房内隔离的**（不变）：房进程继承宿主 `HOME`，模型配置读 `~/.flywheel/models.json` = 生产文件。QA 只在 drill 前后各记一次 `shasum -a 256 ~/.flywheel/models.json`（本设计实测 `27c91802…d8b0`）与 implement 摘要（`impl_opus`(opus,3) : `impl_sol56`(codex,1)，`bindings.opus = claude-opus-5-5`），两次必须一致；⛔ 任何节点都不得写该文件。

### 4.2 步骤 ①②：精确头 CI 与新提交行为

| 步骤 | 做法 | 通过判据 |
|---|---|---|
| ① full CI | 在真仓 worktree（HEAD = `6c091c4fd`）：`node "$FLYWHEEL_COMM_CLI" ci-full ensure --pr 1381 --head 6c091c4fd2001c7aa3d41760dcde28b2054e23ff --json`。exit 8 = 已请求/在跑，继续做独立 QA 并保活；exit 1/2 按输出恢复；PASS 前对同一 HEAD 重跑一次要求 exit 0 | 同头 exit 0；`CI Scope OK` 不算 |
| ② `54a6b6b77` | `pnpm --filter flywheel-teamlead exec vitest run src/__tests__/workflow-dispatch-resolution.test.ts` | 「alias 注册表 vendor ≠ dispatch vendor → exact 自标」用例绿 |
| ② `47680000a` | `pnpm --filter flywheel-teamlead exec vitest run src/__tests__/workflow-template-selection.test.ts` | 「热改绑后未缓存重放/恢复不误报 409」用例绿 |
| ② `950870cee` + **`12b82e4e9`** | `pnpm --filter flywheel-comm exec vitest run src/__tests__/strength-two-contract.test.ts`，再单独 `pnpm --filter flywheel-comm exec vitest run src/commands/__tests__/room.test.ts`，再单独 `pnpm --filter flywheel-teamlead exec vitest run src/bridge/__tests__/qa-room-drill-contract.test.ts` | `noOverrides` 规范化 / argv / `no_overrides_invalid` 用例绿；**新增**「keeps pre-flag canonical bytes when no-overrides is absent or false」与「keeps the pre-flag drill digest when no-overrides is absent or false」绿 |
| ② 老 UUID 不同 policy 历史 | `pnpm --filter flywheel-teamlead exec vitest run src/__tests__/fly3018-current-model-routing.test.ts` | 老 UUID 带历史 Codex assignment、无 overrides start → 当前 policy 胜出；含 `simple_code` 用例绿 |

选择纪律（`qa.md` local-test-policy）：先 `git grep -lF` 发现相关测试并记录排除项与理由，**一次一个具体文件**跑，⛔ 不合并多个文件到一条命令，⛔ 不跑整包。

### 4.3 步骤 ③：真房「不带 overrides」派单矩阵

驱动命令（唯一合法入口，不直接跑 `qa-529-generalized-e2e.mjs`）：

```sh
node "$FLYWHEEL_COMM_CLI" room drill --room <id> --issue <FLY-N> --real --no-overrides
# exit 3 → room wait --room <id> --operation <operation_id>；exit 4 = driver 非零
```

**先算再跑**（Codex R2 #3：`resolveAutomaticModelSplit` 未导出；⛔ 不为取证新增产品导出）：分桶是 issue UUID + node ID 的确定性哈希，同配置下可预先算出。QA 在房源 worktree 用现有导出 `getModelConfigSnapshot()`（`packages/config/src/model-config.ts`）与 `resolveWeightedModelSplit(policy, issueUuid, "implement")`（`packages/config/src/model-split.ts`，小写规范 UUID）做只读预计算：

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
| **O2-seed 老单·不同 policy 历史（真房强证明，可选）** | **Lead 条件授权**（question `8af71ce4`，本轮沿用）+ 下列全部前置（Codex R2 #2 / R3），任一不满足即**不 seed**：(a) 用**专用第三个 issue**（预计算落 `impl_opus`，被测房内无历史），seed 在它**首次 drill 之前**（旧实现继承单一旧 policy；若已有当前 policy 记录再加旧 policy，旧实现报 `prior workflow model assignment ambiguous`，不会出 Astra 回执）；(b) 房 DB 隔离且可写：`realpath` 证明是被测房 `/tmp/flywheel-test-slot-4/teamlead.db` 而非宿主 `~/.flywheel/*.db` 或 slot 3 DB，且房 Bridge 为 file-backed 实时读；(c) 夹具是**完整且自洽的信封**（不能克隆 N1 再改字段——顶层 `runId`/`policyVersion`/`resolvedModel` 残留会被旧 `workflow-model-assignment.ts:376-393` 拒；`modelAlias` 必须是旧 implement 菜单里的别名 `astra`）：用 `95e5cd708` 只读 checkout 的 `finalizeWeightedModelAssignment` 以 synthetic run_id、第三 issue 的 identifier/UUID、旧 policy 为输入生成整个信封（arm=`impl_astra`、`modelAlias="astra"`、`model="gpt-6-astra"`、一致的 `basis{rule="issue_node_weighted", issueKey=UUID, nodeId="implement", ruleVersion/nodes/weightAudit/bucket=旧 policy}`），写前在同一 checkout 用 `assertFrozenWeightedModelAssignment` + 旧 reader 菜单/模型检查 + `listWorkflowModelAssignmentEventsForIssue` 的 project+UUID 关联条件验证；(d) 一条**参数化事务 SQL** 写入一行 `workflow_run`（synthetic run_id、issue_id=UUID、project_name=房项目、status 终态、`selected_by`/`selection_reason`=`synthetic-fly3018-o2-seed`）+ 一行 `workflow_run_event`（kind=`model_arm_assigned`、node_id=`implement`、seq=1、synthetic event_uid、payload=信封），SQL 原文与参数入报告；(e) 写后读回原件比对摘要。然后 drill 该 issue `--real --no-overrides`。修复前（`95e5cd708` `:125-165`）会得 `opus (= gpt-6-astra)`；修复后期望 `impl_opus` / `opus (= claude-opus-5-5)`，植入行字节不变。⛔ 绝不写宿主/生产 DB、slot 3 DB 或 `~/.flywheel/models.json`；⛔ 报告不得把 synthetic fixture 表述为生产历史事实 | (a)–(e) 任一不满足 → 不 seed，该项写「未做」，PASS 范围按 Lead 裁定降为 **单测 + 源码守卫 + 真房同配置矩阵**并明确报告（源码守卫：真仓 `git grep listWorkflowModelAssignmentEventsForIssue packages/teamlead/src/workflow-template-selection.ts` 在 `6c091c4fd` 为空） |

**任务类别缺口（诚实）**：driver 写死 `taskCategory: "code"`（`scripts/lib/qa-generalized-e2e-lib.mjs`），founder 事故是 `simple_code`。房内**没有**受权的 simple_code 派单入口（加 `--task-category` 是产品改动，超出本 run）。simple_code 证据只来自 §4.2 ② `fly3018-current-model-routing.test.ts`；报告单列此缺口，是否作为 PASS 阻断由 Lead 裁定。

**取证（只读被测房 DB：`/tmp/flywheel-test-slot-4/teamlead.db`，由 `roomInfo` state dir 解析并 `realpath` 核对；⛔ 不是管理端 slot 3 的 `/tmp/flywheel-test-slot-3/teamlead.db`；`sqlite3 -readonly`）**。drill 步骤输出不含完整 start 响应，必须回房 DB 取原件，⛔ 不用重建值冒充原始响应：

```sql
-- 原始回执：response.resolved.nodeModels（不是 response.nodeModels）
SELECT r.run_id, r.node_id, r.attempt, r.execution_id, resp.response_json
  FROM workflow_start_reservation r JOIN workflow_start_response resp USING (idempotency_key)
 WHERE r.run_id = :run;
-- 本 run 冻结 assignment
SELECT seq, kind, node_id, execution_id, payload FROM workflow_run_event
 WHERE run_id = :run AND kind IN ('design_model_arm_assigned','model_arm_assigned');
-- 不可变运行时
SELECT execution_id, node_id, attempt, vendor, model, effort FROM workflow_execution_runtime WHERE run_id = :run;
-- 会话实际模型
SELECT execution_id, runner_model, dispatch_model FROM sessions WHERE execution_id IN (...);
```

每例保留：request key、issue UUID、预计算期望 arm、run id、node id、attempt、execution id、宿主 models.json sha256、`response.resolved.nodeModels` 原文、assignment payload、runtime `vendor/model/effort`、`sessions.runner_model`、实际会话证据（Claude TUI 或 Codex 会话头）、effective effort 对照。

判定顺序：先断言 **receipt exact = runtime.model = 同 execution 的 sessions.runner_model**（缺行或多行即 FAIL），再核对实际载体。code 类别必须观察到后继 implement 真启动，不能拿 design session 冒充。

### 4.4 步骤 ④：强度二记录 → 自己 teardown → 最后提交（顺序是合同的一部分，Codex R1 HIGH）

**为什么顺序不能反**：`qa-result` 成功提交（PASS，或身份恢复分支的 FAIL）会经 `submitWorkflowDecisionByCredential` 写 submission credential 的 `consumed_at`；而 `room teardown` 与 deploy/drill 一样要过 `qa-room-routes.ts` 的凭据 preflight，已消耗凭据返回 `credential_consumed`（403），会话终态则 `runner_not_active`。先提交再拆房 = slot 4 留下房与 claim，只能再劳 Lead/后继清理。因此：**房在线 → 记录并确认 satisfied → 用尚未消耗的当前凭据 teardown → 等 `torn_down`、保存 `evidence_dir` → 最后 `qa-result`**。所有提前 FAIL 分支同样先走 teardown。

1. 完整命令（`evidence-run.ts` 全部必填；`--local-copy` 不能替代 URL）：

```sh
node "$FLYWHEEL_COMM_CLI" evidence-run record \
  --exec-id <QA exec id> \
  --head 6c091c4fd2001c7aa3d41760dcde28b2054e23ff \
  --site slot_529:4 --lane generalized_e2e_real \
  --record-url <已发布证据的 https URL> \
  --rerun-spec <服务返回的 rerun_spec 文件> \
  --driver-exit-code <drill 返回的真实 driver_exit_code> \
  --record-id <稳定 id，重试沿用> [--local-copy <仅 evidence_copy=ok 时>]
```

2. **rerun_spec 检查按 `12b82e4e9` 后的形态**：`lane` = `generalized_e2e_real`，且 `driver.noOverrides` **键存在且 === true**（不带旗的 drill 现在是「没有该键」，不是 `false`）。键缺失 = 这次 drill 没带 `--no-overrides`，不是本矩阵的证据 → 重跑，不得手改 spec。
3. **exit 0 ≠ satisfied**：合法 ACK（含 `verdict=unsatisfied`）也退出 0。CLI **不输出 HTTP ACK 原文**，只打印一行判定摘要 `strength-two: verdict=… ran=<status>/<reason> record=<status>/<reason> record_id=…`（`commands/evidence-run.ts:382-387`）。留证 = 这一行原样 + `record_id` + 传入的原始 `rerun_spec` 文件 + 服务返回的不可变 request receipt（drill/wait 快照里的 `operation_id`、`driver_exit_code`、`evidence_copy`）；⛔ 不把 CLI 摘要称作「HTTP 原文」。要求本次矩阵对应记录的 `verdict` / `ran` / `record` 三者都 satisfied 才算强度二通过；`lane_unproven`、`site_head_mismatch`、`driver_nonzero` 都是失败。
4. driver 非零、证据缺、`evidence_copy` 不全、探测失败 → 先重跑或 FAIL；同一请求结果不确定时用**同一 record-id、同一 payload** 重试，不换 id。
5. **teardown（在 qa-result 之前）**：QA（owner）自己 `room teardown --room <id>`；exit 3 → `room wait --room <id>` 直到 `torn_down`；保留返回的 `evidence_dir`；`snapshot_failed` 先看既有证据再用新 request `--skip-snapshot --reason <原因>` 重试。teardown 被拒（`request refused (HTTP 403/409)`）→ 保留现场、记原文、ask Lead；⛔ 不借凭据、⛔ 不删 `/tmp/flywheel-test-slot-4.lock`。
6. **最后**提交 `qa-result`。PASS 被 `land_head_pr_identity_unavailable` 拒：按 CLI 恢复路径**显式交 FAIL**，原因写「FLY-2407 部署边界缺陷，产品证据本身 PASS」，附 §4.3 证据清单；不绕过、不伪造 identity。

### 4.5 QA 负向守卫

- **守卫的分层**：CLI 只给「HTTP 状态已知」（`HTTP 503` / `request refused (HTTP 4xx)`），服务端 `reason` 只有 Lead/宿主能从审计/诊断确认。QA 报告两者分开写，不把猜测写成 reason。
- `room list` / `room deploy` 非正向结果（含 `HTTP 503`）→ 外层房服务未开或其它服务端拒绝（§4.0 第一道），记原文 ask Lead（引用 `d630d640`）；⛔ 不改 Bridge 环境、⛔ 不打生产 Bridge、⛔ 不跑裸驱动。
- `room deploy --slot 4` 得 `HTTP 409`（reason 未确认：`slot_unavailable` / `actor_has_room` …）→ ask Lead；⛔ 不改 `--slot auto`、⛔ 不用 1/2/3 死房、⛔ 不复用空 lock、⛔ 不接管他人房。
- `evidence-run record` 被拒 `slot_port_is_self`（site 指到管理端 slot 3；该命令会打印拒绝码）→ site 写错，改为 `slot_529:4`。
- teardown 前已提交 qa-result → 顺序错误（§4.4），凭据已消耗不可恢复；记录并 ask Lead 清房，⛔ 不借凭据。
- `drill_config_not_reproducible` → 房参数不对（Codex-runner 房、非 main fixture、`--no-lead`），ask Lead 改房，不改自己的命令绕过。
- drill/teardown `request refused (HTTP 403)`（可能 `room_not_owned` / `credential_*` / `runner_not_active`，CLI 不区分）→ 记原文 ask Lead，⛔ 不借 Lead 凭据。
- 回执出现跨 vendor 拼接（如 `opus (= gpt-*)`）→ 直接 FAIL，附 `response.resolved.nodeModels` 原文。
- 管理 Bridge 或 CLI ≠ `6c091c4fd`（症状 `field_not_supported` / `rerun_spec_invalid:unknown_key`）→ 阻断 ask Lead；⛔ 不去掉 `--no-overrides`、⛔ 不自行部署。
- 宿主 `~/.flywheel/models.json` sha256 在矩阵前后不一致 → 环境被改动，FAIL 并上报。
- 房头 sha ≠ `6c091c4fd`，或 PR #1381 头再次前进 → 停，ask Lead 重新核对；不沿用本次裁定。

## 5. 数据与身份（本轮不新增）

沿用 PR 头已有结构，无迁移：`StartReservation(idempotencyKey, runId)` → `RunSnapshot(modelRouting, dispatchPinned)` + `AssignmentEvent(arm, modelAlias, model, basis{ruleVersion, issueKey, nodeId, bucket, nodes, weightAudit})` → `ExecutionRuntime(executionId, vendor, model, effort)` → `sessions.runner_model`。回执只从这条链的**本 run** 记录投影。

## 6. 取舍与放弃的替代

| 放弃 | 原因 |
|---|---|
| 沿用 `manual_test_deploy` 手工记录 | judge.ts:110 写死 `lane_unproven`，上一轮就此 FAIL |
| 改 judge 让 manual 通道可判定 | 产品改动，超出「只重做 QA」边界，且降低强度二证明力 |
| 在 `76cf3c249` / `7e28dd51c` 上判 | 前者 rerun_spec 表达不了 no-overrides；后者已不是 PR 头（Lead 裁定硬约束：头变即失效） |
| 由 Lead 或 QA 改「房内」models.json 做 O2 | 房读的是宿主 `~/.flywheel/models.json` = 生产文件，改它就是改生产且无恢复边界（Codex R1 #4） |
| Lead 起房、QA 去 drill | owner 是 `lead:<id>`，QA 身份 403 `room_not_owned`（Codex R1 #2）；Lead 03:4xZ 已作废该路径 |
| **QA 打生产 Bridge `9876` 起房**（本轮新增） | 必被拒：ingest token 不匹配先 401；即便 token 过了，本店 `getSession` 不认识该 execution → 403（`qa-room-routes.ts:41-60`）；且生产 `95e5cd708` 无 `no_overrides` schema → `field_not_supported` |
| **QA 自己给 19873 加 `TEST_QA_ROOM_SERVICE=1` 或重启 Bridge**（本轮新增） | 越权：README:400 明写「not an arbitrary runner environment option」；改 Bridge 环境是 Lead 宿主侧动作 |
| **`--slot auto`**（v2.4 采用） | Lead 05:3xZ 明令别用（会抢别人的房）；且 1–3 是死房，auto 可能分到 |
| 管理端与被测房同为 slot 3 | `slot_unavailable` / `slot_port_is_self` 守卫必拒（Codex R2 #1） |
| 把旧代码评审批准改绑到新头 | gate 只接受「评审头 = 当前头」且 24h 内，无改绑能力；头不符是流程阻断，问 Lead |

## 7. 回滚与边界（诚实）

- 本 run 无代码改动；**配置也不写**（宿主 models.json 只读取摘要），没有代码或配置回滚对象。外层房 `TEST_QA_ROOM_SERVICE=1` 若由 Lead 加上，其回滚对象是 Lead 侧的 Bridge 环境，随房 teardown 消失；O2-seed 若获授权，回滚对象是房 DB 植入行，随房 teardown 消失，报告记录植入 SQL。产品代码回滚语义见真仓 plan §5。
- 本设计**做**：审计头差异（`7e28dd51c → 6c091c4fd`）并核对 CI/祖先；发现并上报房服务禁用阻断（`d630d640`）；给 implement 零改动边界；给 QA 可执行、可判定的矩阵与命令。
- 本设计**不做**：不改代码、不起房、不派单、不判定 QA 结果、不改 Bridge 环境、不重派生产老单（FLY-2405/2909 由 Lead 处置）、不处理统计口径。
- merge 与部署分离；merge 不等于生产生效，只有独立 updater 在其窗口部署。

## 8. 相关测试（本机只跑相关；一次一个文件）

```sh
node "$FLYWHEEL_COMM_CLI" ci-full ensure --pr 1381 --head 6c091c4fd2001c7aa3d41760dcde28b2054e23ff --json
pnpm --filter flywheel-teamlead exec vitest run src/__tests__/fly3018-current-model-routing.test.ts
pnpm --filter flywheel-teamlead exec vitest run src/__tests__/workflow-dispatch-resolution.test.ts
pnpm --filter flywheel-teamlead exec vitest run src/__tests__/workflow-template-selection.test.ts
pnpm --filter flywheel-teamlead exec vitest run src/bridge/__tests__/qa-room-drill-contract.test.ts
pnpm --filter flywheel-comm exec vitest run src/__tests__/strength-two-contract.test.ts
pnpm --filter flywheel-comm exec vitest run src/commands/__tests__/room.test.ts
```

## 9. 设计交付游标

1. 三份文档 + progress 提交推送；`stage set design_review --plan …` 并按 gate 流程取得 `reviewVerdict=APPROVED`（仅 stage 变化不算）。
2. founder HTML（本地 mmdc 预渲染 SVG、逐段意见层、`【页面意见汇总】FLY-3018`）同步到 v2.5，提交推送、静默 publish、向 Lead 报 URL。
3. `complete --route phase_design_complete`；不派后继、不申请 ship。
