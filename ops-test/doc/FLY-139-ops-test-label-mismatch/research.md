# FLY-139 Ops-Test 单标签 S2 夹具 — 调研
Issue: FLY-139 (https://linear.app/geoforge3d/issue/FLY-139/qa-fly-127-sandbox-ops-test-label-only-s2-mismatch)
日期: 2026-09-25
基于: exploration.md

## 1. 调研问题

1. S2（`label_mismatch`）在当前 HEAD 的判定路径与响应形状是什么，是否与 FLY-127 R3 报告一致？
2. 夹具 issue「只挂 Ops-Test」在测试房里会被解析成哪个 Lead，触发条件精确到哪一步？
3. 现有自动化测试是否已经覆盖，能否在本 worktree 实际跑通留证据？
4. 有没有必须改代码或改共享文档的理由？

## 2. 判定路径（按代码逐行核对）

`POST /api/runs/start`（`packages/teamlead/src/bridge/runs-route.ts`）顺序：

1. 解析 `issueId` / `projectName` / `leadId`（`leadId` 缺省时由调用方身份自动解析）。
2. Linear 预检：拉取 issue，得到 `issueLabelNames`；拉不到 → 早退，**不会**到 dept-scope。
3. `isDeptScopeRejectEnabled()`（`BRIDGE_DEPT_SCOPE_REJECT` 非 `off/false` 即开，默认开）且 `leadId` 非空 → 调 `departmentRegistry.isLeadInScope(projectName, leadId, issueLabelNames)`。
4. `isLeadInScope` 7 级优先级（`department-registry.ts` L262-L271 注释即源码顺序）：
   - project_unknown / lead_unknown / lead_cannot_spawn（调用方本身的问题，优先于标签）
   - `classifyIssue()`：把 issue 标签全部小写，遍历项目里 `canSpawnRunners !== false` 的 Lead，每个 Lead 取 `match.labels` 中第一个命中的；0 命中 → `issue_no_department_label`；≥2 → `issue_multiple_department_labels`
   - 恰 1 命中且 `cls.leadId !== leadId` → **`label_mismatch`**，`canonicalLeadId = cls.leadId`
   - 否则 `ok`
5. 拒绝时 Bridge 打一行服务端日志（含英文 `decision.message`），HTTP 返回 **403**：

```json
{ "success": false, "code": "DEPT_SCOPE_REJECT", "reason": "label_mismatch",
  "canonicalLeadId": "<拥有该标签的 Lead agentId>", "silent": false }
```

无 `message` 字段（FLY-127 Codex R1 决定：不给 Lead 可转述的英文 prose）。dispatcher **不会**被调用。

与 `doc/qa/reports/v1.27.0-FLY-127-r3-replay-test.md` §2 Layer 2 描述逐字段一致。

## 3. 夹具在测试房里的解析（按本会话所在的真实房核对）

本节点所在的房（`/tmp/flywheel-test-slot-1/room-info.json`，campaign `fly1189-1790381958-slot1`）的 Bridge 进程环境 `FLYWHEEL_PROJECTS` 实际是：

| slot | agentId | `match.labels` | `canSpawnRunners` |
|---|---|---|---|
| 1（host） | flywheel-test-1 | `["Product-Test"]` | 未显式设置 → `effectiveCanSpawn` 默认 `true` |
| 4（extra，借用） | flywheel-test-4 | `["Ops-Test"]` | 同上 `true` |

（`scripts/test-slots.example.json` 里 Ops-Test 示例绑在 slot 3；实际 campaign 用 `--extra-lead 4:Ops-Test` 借了 slot 4。夹具合同只认 **deptLabel**，不认 slot 号。）

对 FLY-139（标签恰为 `["Ops-Test"]`）：

- `classifyIssue` → `{kind:"one", leadId:"flywheel-test-4", deptLabel:"Ops-Test"}`。
- 调用方 `leadId=flywheel-test-1`（Product-Test，能起 Runner）→ 应得 **`label_mismatch`**，`canonicalLeadId="flywheel-test-4"`。这就是 S2。
- **但本房的 Bridge 以 `BRIDGE_DEPT_SCOPE_REJECT=off` 运行**（`scripts/test-deploy.sh` L291/L1025：`TEST_BRIDGE_DEPT_SCOPE_REJECT` 默认 `off`）。这正是本 eng_design 会话能由 slot 1 对一张 Ops-Test issue 起 run 的原因：Layer 2 在本房被有意关掉，S2 **不会**在默认房型里触发。要跑 S2，部署时必须 `TEST_BRIDGE_DEPT_SCOPE_REJECT=on`（开关是 fork 时快照，改环境须重启 Bridge）。
- ⚠️ 若调用方 Lead 配置了 `canSpawnRunners:false`（生产 cos-lead 就是），优先级 3 会先返回 `lead_cannot_spawn`，**不会**到 `label_mismatch`。S2 的调用方必须是一个**能起 Runner 但部门不同**的 Lead。
- 若 QA 曾给 FLY-139 加过第二个部门标签（例如同时挂 `Product-Test`），会变成 `issue_multiple_department_labels`（S3 类场景），夹具失效。本节点无法查 Linear（MCP 401），写成实现/QA 前置检查。
- 本 worktree 的 `origin` 是 `xrliAnnie/flywheel-qa-sandbox`（QA 沙箱镜像仓），PR 落在该仓，不进生产 `flywheel` 主仓。

## 4. 现有测试覆盖与本地证据

| 测试 | 断言 | 本 worktree 结果（2026-09-25，HEAD `7cc3e233e`） |
|---|---|---|
| `department-registry.test.ts` › precedence 6 | `product-lead` × `["Operations"]` → `label_mismatch`, `canonicalLeadId="ops-lead"` | ✓ |
| `department-registry.test.ts` › precedence 1-5, 7 | 其余优先级各一条 | ✓ |
| `start-e2e.test.ts` › FLY-127 — department scope reject › `403 DEPT_SCOPE_REJECT label_mismatch when product-lead targets Ops-labelled issue` | 403、`code`、`reason`、`canonicalLeadId="ops-lead"`、`silent=false`、无 `message`、dispatcher 未调用 | ✓（523ms） |

执行命令（在 `packages/teamlead`）：

```
npx vitest run src/__tests__/department-registry.test.ts src/__tests__/start-e2e.test.ts -t "label_mismatch|precedence|DEPT_SCOPE"
→ Test Files 2 passed (2) · Tests 15 passed | 57 skipped (72)
```

前置：worktree 初始无 `node_modules`；`pnpm install --frozen-lockfile --offline` + `pnpm --filter "flywheel-teamlead^..." build` 后可跑。这两步都不产生受 git 跟踪的改动（`git status` 仅见本 issue 的 doc 文件）。

## 5. 要不要改东西

| 候选改动 | 结论 | 理由 |
|---|---|---|
| 加「Ops-Test vs PM-Test」形状的单测 | 不加 | 同一分支已被 `Operations` 标签 case 覆盖；标签匹配大小写不敏感、纯字符串，换名字不换路径。 |
| 改 `529-room-playbook.md` 记录夹具 | 不改 | 共享写点，多 PR 并发必冲突（CLAUDE.md 里程碑表同类教训）。夹具合同只放本 issue 文件夹。 |
| 补 Bridge 端 `BRIDGE_DEPT_SCOPE_REJECT` 免重启开关 | 不做 | FLY-127 已列为独立 follow-up，超出本单。 |
| 在 Linear 上关单 | 不做 | 节点无 Linear 写权限；关单是 QA verdict 之后 Lead 的动作。 |

## 6. 结论

- S2 场景在生产代码、单测、e2e 三层都闭环，当前 HEAD 实跑通过。
- FLY-139 的交付物 = 夹具合同 + 证据 + 关单条件（docs-only）。
- 唯一未核验项：Linear 上 FLY-139 的标签集合是否仍恰为 `{Ops-Test}`；交给实现节点用 Bridge `/api/linear/issues` 或 Lead 代查。
