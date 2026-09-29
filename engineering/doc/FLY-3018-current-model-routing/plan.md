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
2. 不改任何文件、不 merge main、不重跑 CI、不问 Lead。
3. 沿用该头已有的 Codex 代码复审（返工线程 R1–R3，最后一轮 APPROVED；`7e28dd51c` 相对 `76cf3c249` 只多 merge main、rerun_spec `noOverrides` 与 fixture 同步，产品路径未变）；若 gate 要求 head-bound `code-review.json`，按既有 `await-codex-gate code` 路径绑定到 `7e28dd51c`，不新起评审轮。
4. `complete --route needs_review --pr 1381`。

负向守卫：若三者任一不一致（例如 PR 头再次前进），**停下** ask Lead，不自行 merge 或 push。

## 4. QA 节点：验收矩阵

### 4.1 前置

- 房由 Lead 起：slot 3、`--generalized`、精确头 `7e28dd51c`（§2 裁定）、Claude runner、不带 `--stub-runner`、保留 `TEST_REPLY_BY_ISSUE=1`。Lead 给 `room_id` / `roomInfo` 后开工；需要改参数 ask Lead。
- 房内 Bridge 必须含 FLY-2407（`8e44ac64d`），否则 primary PR identity 仍会缺（§4.4）。
- 房内 `models.json` 与生产同形：implement `impl_opus`(opus, 3) : `impl_sol56`(codex, 1)，`bindings.opus = claude-opus-5-5`。QA 先记录房内 models.json 摘要（policy hash 或文件 sha）作为「当前配置」的证据锚点。

### 4.2 步骤 ①②：精确头 CI 与两条新提交行为

| 步骤 | 做法 | 通过判据 |
|---|---|---|
| ① full CI | `gh run list --commit <头>`，引用 run id | 该精确头 full-request 全部 job pass |
| ② `54a6b6b77`（receipt alias 按钉住的 runtime vendor 解析） | 在房源跑 `pnpm --filter flywheel-teamlead exec vitest run src/__tests__/workflow-dispatch-resolution.test.ts` | 含「alias 注册表 vendor ≠ dispatch vendor → exact 自标」用例绿 |
| ② `47680000a`（冻结 alias 不再对照可变 bindings） | 同上 + `src/__tests__/workflow-template-selection.test.ts` | 含「热改绑后未缓存重放/恢复不误报 409」用例绿 |
| ② `950870cee`（rerun_spec `noOverrides`） | `pnpm --filter flywheel-comm exec vitest run src/__tests__/strength-two-contract.test.ts src/commands/__tests__/room.test.ts` | `noOverrides` 规范化/argv/`no_overrides_invalid` 用例绿 |

⛔ 只跑相关文件，不跑整包。

### 4.3 步骤 ③：真房「不带 overrides」派单矩阵

驱动命令（唯一合法入口，不直接跑 `qa-529-generalized-e2e.mjs`）：

```sh
node "$FLYWHEEL_COMM_CLI" room drill --room <id> --issue <FLY-N> --real --no-overrides
# exit 3 → room wait --room <id> --operation <operation_id>
```

矩阵（每例都不带覆盖）：

| 例 | 输入 | 证明什么 |
|---|---|---|
| N1 新单 | 房内此前无任何 run 的 issue，drill 一次 | 每个节点 arm 来自当前 modelSplit；回执 alias 与 exact 同 vendor |
| O1 老单（同配置） | 同一 issue 再 drill 一次（新 idempotency key，房内已有 N1 的历史 assignment） | 选择与 N1 一致（同 UUID 同配置同分桶），且 start 路径**没有读**历史（回执 basis 为当前 policy） |
| O2 老单（配置变化，强证明，需 Lead 改房内 models.json） | Lead 把 implement 权重或 arm 调整后，再对同一 issue drill | 新 run 采用新配置，旧 run 记录字节不变；这是「历史不再牵引」的直接证据 |
| N2 新单 Codex arm（如分桶落到 codex） | 另一个 issue | 仍合法选 Codex，修复不是「全量强制 Opus」 |

O2 是可选强证明：若 Lead 不改房内配置，QA 在报告里写明只有同配置证据，不冒充。

每例保留：request key、issue UUID、run id、node id、activation/execution id、房内 models.json 摘要、`response.nodeModels`（回执）、run snapshot `modelRouting`/`dispatchPinned`、immutable runtime `vendor/model/effort`、`sessions.runner_model`、实际会话窗口/原生模型证据（TUI 或 Codex 会话头）。

判定顺序：先断言 **receipt exact = runtime.model = 同 execution 的 sessions.runner_model**，再核对实际 carrier。code 类别必须观察到后继 implement 真启动，不能拿 design session 冒充。未启动、缺模型证据即 FAIL。

### 4.4 步骤 ④：强度二记录与提交

1. `evidence-run record`：用服务返回的 `rerun_spec`（须含 `lane: generalized_e2e_real` 与 `driver.noOverrides: true`）原样传 `--rerun-spec`；`--driver-exit-code` 传 `driver_exit_code`；`--local-copy` 只在 `evidence_copy=ok` 时传。
2. judge 不得再走 `manual_test_deploy`；若记录被判 `lane_unproven`，说明 spec 来源错误，回到 1 而不是改判。
3. `qa-result` 提交 PASS 时若被 `land_head_pr_identity_unavailable` 拒：按 CLI 恢复路径**显式交 FAIL**，原因写「FLY-2407 部署边界缺陷，产品证据本身 PASS」，附本文件 §4.3 的证据清单；不绕过、不伪造 identity。
4. 房子 teardown 只由 owner / Lead / 同 issue 后继做；保留 `evidence_dir`。

### 4.5 QA 负向守卫

- `drill_config_not_reproducible` → 房参数不对（Codex-runner 房、非 main fixture、`--no-lead`），ask Lead 改房，不改自己的命令绕过。
- 回执出现跨 vendor 拼接（如 `opus (= gpt-*)`）→ 直接 FAIL，附 nodeModels 原文。
- 房头 sha ≠ `7e28dd51c`，或 PR #1381 头再次前进 → 停，ask Lead 重新核对；不沿用本次裁定。

## 5. 数据与身份（本轮不新增）

沿用 PR 头已有结构，无迁移：`StartReservation(idempotencyKey, runId)` → `RunSnapshot(modelRouting, dispatchPinned)` + `AssignmentEvent(arm, modelAlias, model, basis.policy)` → `ExecutionRuntime(executionId, vendor, model, effort)` → `sessions.runner_model`。回执只从这条链的**本 run** 记录投影。

## 6. 取舍与放弃的替代

| 放弃 | 原因 |
|---|---|
| 沿用 `manual_test_deploy` 手工记录 | judge.ts:110 写死 `lane_unproven`，上一轮就此 FAIL |
| 改 judge 让 manual 通道可判定 | 属于产品改动，超出「只重做 QA」边界，且降低强度二的证明力 |
| 在 `76cf3c249` 上硬判强度二 | 该头 rerun_spec 表达不了 no-overrides，证据不可判定 |
| 让 QA 自己改房内 models.json 做 O2 | 房参数是 Lead 权限；QA 只 ask |

## 7. 回滚与边界（诚实）

- 本 run 无代码改动，无回滚对象；产品代码回滚语义见真仓 plan §5（回退会恢复历史继承缺陷，且新旧 policy 并存后旧代码可能报 `prior workflow model assignment ambiguous`）。
- 本设计**做**：审计头差异并提交 Lead 裁定；给 implement 零改动边界；给 QA 可执行、可判定的矩阵与命令。
- 本设计**不做**：不改代码、不起房、不派单、不判定 QA 结果、不重派生产老单（FLY-2405/2909 由 Lead 按既有授权路径处置）、不处理统计口径（scorecard mixed 分组是已知 follow-up）。
- merge 与部署分离；merge 不等于生产生效，只有独立 updater 在其窗口部署。

## 8. 相关测试（本机只跑相关）

```sh
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
