# FLY-139 Ops-Test 单标签 S2 夹具 — 探索
Issue: FLY-139 (https://linear.app/geoforge3d/issue/FLY-139/qa-fly-127-sandbox-ops-test-label-only-s2-mismatch)
日期: 2026-09-25
基于: 无

## 1. 这张单是什么

FLY-139 不是功能需求，也不是 bug。它是 `qa-fly-127` 在验证 FLY-127 PR #170「部门范围检查」（dept-scope check：Bridge 在起 Runner 前核对 issue 的部门标签是否属于发起请求的 Lead）时建的**测试夹具 issue**：

- 只挂一个部门标签 `Ops-Test`（对应测试房 slot 3 / `flywheel-test-3`）。
- 用途是场景 **S2 = `label_mismatch`**：让一个**不是** Ops-Test 部门的 Lead（例如 slot 1 的 PM-Test / cos）对它调用 `POST /api/runs/start`，期望 Bridge 返回 403 `DEPT_SCOPE_REJECT` + `reason=label_mismatch`。
- Issue 描述原话：「Safe to close after QA verdict.」

因此这张单的**工程交付物本质是「确认夹具仍然成立并把夹具合同固定下来」**，而不是新代码。

## 2. 当前代码事实（本 worktree HEAD `7cc3e233e`，分支 `project-slot-1-FLY-139`）

| 层 | 位置 | 事实 |
|---|---|---|
| 判定逻辑 | `packages/teamlead/src/department-registry.ts` `isLeadInScope()` | 决策优先级固定 7 级：project_unknown → lead_unknown → lead_cannot_spawn → issue_no_department_label → issue_multiple_department_labels → **label_mismatch** → ok。`label_mismatch` 只在 issue 恰好命中**一个**可起 Runner 的 Lead 的标签、且该 Lead ≠ 调用方时返回，并附 `canonicalLeadId`。 |
| 标签匹配 | 同文件 `classifyIssue()` | 大小写不敏感（`toLowerCase()`），只看 `canSpawnRunners !== false` 的 Lead；每个 Lead 取 `match.labels` 中第一个命中的标签。 |
| HTTP 执行点 | `packages/teamlead/src/bridge/runs-route.ts` ~L2003-2046 | Linear 预检通过后、有 `leadId` 且 `BRIDGE_DEPT_SCOPE_REJECT != off` 时调用；拒绝响应 **仅机器字段**：`{success:false, code:"DEPT_SCOPE_REJECT", reason, canonicalLeadId: string|null, silent:false}`，无 `message`（英文 prose 只进服务端日志）。 |
| 单测 | `packages/teamlead/src/__tests__/department-registry.test.ts` `precedence 6` | `product-lead` 对 `["Operations"]` → `label_mismatch`，`canonicalLeadId="ops-lead"`。 |
| e2e | `packages/teamlead/src/__tests__/start-e2e.test.ts` L567 | `product-lead` 对 `["Ops"]` 标签 issue → 403 / `DEPT_SCOPE_REJECT` / `label_mismatch` / `canonicalLeadId="ops-lead"` / `silent=false` / 无 `message` / dispatcher 未被调用。 |
| 测试房标签 | `scripts/test-slots.example.json` slot 3 | `department:"ops-test"`, `deptLabel:"Ops-Test"`, `botName:"flywheel-test-3"`。`test-deploy.sh --extra-lead 3:Ops-Test` 把它接进同一 Bridge。 |
| Lead 侧消费 | `packages/gemini-agent/src/tools/schemas.ts` L72 | 工具描述已写明 `label_mismatch` = 属于别的 Lead，不得原样重试。 |

结论：**S2 场景在生产代码和测试两层都已闭环，没有缺口。**

## 3. 假设（显式列出）

1. 本 DAG 派发 FLY-139 到 eng_design 节点是通用工作流对「有标签的 issue」的机械派发，不代表 Lead 认为存在工程缺口。已用非阻塞问题 `cb860e27-9a94-410a-a60d-bb0cdf468f55` 向 Lead 确认；未答复即按「docs-only」推进。
2. 夹具的 Linear 侧状态（标签仍只有 `Ops-Test`、issue 未被加第二个部门标签）本节点无法核验：本会话 Linear MCP 连接失败（401 invalid token），`linear-issue-context` 技能里也不含标签列表。这一点作为实现/QA 节点的前置检查写进 plan。
3. `ops-test/doc/` 是本 slot 项目的 doc 根（Lead 注入的 DOC-FLOW 路径），文件夹随分支进 PR。

## 4. 候选方向

| 方向 | 内容 | 判断 |
|---|---|---|
| **A. docs-only（推荐）** | 写死「夹具合同」（标签形状、调用方、期望 403 体、触发命令）+ 在当前 HEAD 跑现有单测/e2e 留证据 + 给出关单条件。零生产代码。 | 与 issue 原意（夹具、QA 后关）一致；不碰任何消费者；实现节点工作量最小。 |
| B. 补一条按测试房标签形状（`Ops-Test` vs `PM-Test`）的回归单测 | 在 department-registry.test.ts 加 case | 现有 case 已覆盖同一分支（标签只是字符串，大小写不敏感），新增只是重复；且违反「不要顺便改无关文件」。**拒绝**。 |
| C. 直接关单不走 DAG | Lead 手动关闭 | 属于 Lead 裁量；本节点无权改 Linear 状态。作为 ask 里的选项列出。 |
| D. 把夹具合同写进 `doc/qa/framework/529-room-playbook.md` | 改共享 QA 手册 | 手册是多 issue 共享写点，改它会引冲突（同 CLAUDE.md 里程碑表教训）。**拒绝**，只在本 issue 文件夹内落盘并从 plan 里指向手册相关段落。 |

选 A。

## 5. 不做什么（边界）

- 不改 `department-registry.ts` / `runs-route.ts` / 任何测试文件。
- 不改 Linear issue 状态或标签（无权限也无必要）。
- 不新建 QA 房、不跑 `test-deploy.sh`（那是 QA 节点/Lead 的宿主机动作）。
- 不处理 FLY-127 后续 follow-up（如 `BRIDGE_DEPT_SCOPE_REJECT` 免重启开关）。
