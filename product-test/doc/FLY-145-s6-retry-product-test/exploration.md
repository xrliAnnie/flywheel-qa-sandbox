# FLY-145 S6 重试沙箱单 — 探索
Issue: FLY-145 (https://linear.app/geoforge3d/issue/FLY-145/qa-fly-127-sandbox-s6-retry-product-test)
日期: 2026-09-25
基于: 无

## 1. 这张单是什么

FLY-145 是 QA-FLY-127 的 S6 场景（生产镜像多 Lead 矩阵）用的**沙箱哑单**。issue 正文明确：

- 标签 `Product-Test`；
- 预期只有 flywheel-test-2（product-lead-test）认领并 spawn，flywheel-test-1/3/4 保持沉默；
- **不需要任何代码工作**；QA agent 把 issue 号贴进 cos-test 频道，Lead bot 反应，QA 收集证据；
- S6 PASS 后归档。

也就是说，这张单的"产品"不是代码，而是**一次可复现的部门范围（dept-scope）行为观测**。设计节点要回答的问题因此变成：实现节点应该交付什么、不应该交付什么，以及 S6 的判据到底靠哪几行代码兜底。

## 2. 被测机制在仓库里的落点（已核对）

| 层 | 位置 | 作用 |
|---|---|---|
| Bridge 服务端强制 | `packages/teamlead/src/department-registry.ts` `isLeadInScope()` | 决策优先级：project_unknown → lead_unknown → lead_cannot_spawn → issue_no_department_label → issue_multiple_department_labels → label_mismatch → ok。标签匹配大小写不敏感，只看 `canSpawnRunners` 为真的 Lead。 |
| Lead 提示规则 | `packages/teamlead/lead-rules-base/department-lead-rules.md` §5 | Lead **不自行预过滤**，直接调 `POST /api/runs/start`，收到 `DEPT_SCOPE_REJECT` 后按 reason 回一行、不重试（每 (issue, reason) 去重 N=1）。 |
| 多 Lead 可见性补丁 | PR #170 / 提交 `cecefcb92` | 每个测试 slot 的 Bridge 只装本槽 Lead，导致 S2/S3 不可测；修复是把兄弟 slot 以 **shadow Lead** 注入 `FLYWHEEL_PROJECTS`，让 registry 看到完整项目。 |
| 测试槽配置 | `~/.flywheel/test-slots.json`（只读了 label/department 字段） | slot1 = cos / PM-Test；slot2 = Product-Test；slot3 = Ops-Test；slot4 = Finance-Test；另有 slot5/6（Product-Test-2 / Ops-Test-2）。 |

据此推导 S6 对 `Product-Test` 单的**理论矩阵**：

| Lead | 部门标签 | 预期 registry 结论 | 预期 Discord 表现 |
|---|---|---|---|
| flywheel-test-2 | Product-Test | `ok`, canonicalLeadId = test-2 | 认领 + spawn |
| flywheel-test-3 | Ops-Test | `label_mismatch`（canonical = test-2） | 一行"被判定为 test-2 的范围，我不会启动" |
| flywheel-test-4 | Finance-Test | `label_mismatch` | 同上 |
| flywheel-test-1 | cos / PM-Test | 若 `canSpawnRunners=false` → `lead_cannot_spawn`；否则 `label_mismatch` | 沉默或一行拒绝 |

## 3. 观察到的一个不一致（需 Lead 确认，非阻塞）

本次 eng_design 执行由 **flywheel-test-1**（cos 槽，`FLYWHEEL_LEAD_ID=flywheel-test-1`）派发，而 issue 预期 test-1 对 Product-Test 单保持沉默。可能的解释：

1. S6 重试是 QA 手动经 slot 1 的 DAG 工作流派发的，用来产出评审文档，与 Discord 侧的 Lead 反应测试是两条线；
2. issue 当前标签已不只 `Product-Test`（本会话 Linear MCP 鉴权失败，无法核实标签）。

本探索不把它当 bug 报，只记录事实；已通过 `flywheel-comm ask` 非阻塞询问 Lead。设计本身不依赖这个答案。

## 4. 设计节点面临的选择

### 选项 A：零改动，实现节点只交付文档 PR（推荐）
- 实现节点不改任何 `.ts` / 脚本；PR 只携带本文件夹的探索 / 调研 / 计划 / 设计 HTML，以及一份 **S6 证据模板**（把 §2 的矩阵变成可勾选的表格）。
- 符合 issue 原话"no actual code work needed"与 CLAUDE.md 的 scope discipline。
- 风险：PR 对仓库"没用"。但这正是沙箱单的定义；S6 的价值在 Discord 证据，不在代码。

### 选项 B：顺手补一个针对 S6 矩阵的单元测试
- 在 `start-e2e.test.ts` 旁加 4 Lead × Product-Test 的断言。
- 拒绝理由：`department-registry` 的 label_mismatch / multi_dept 已有覆盖（PR #170 说明），再加一份是重复；且违反"不要在本 issue 修顺便发现的东西"。

### 选项 C：把 issue 直接标 blocked / 空转完成
- 拒绝理由：设计节点的完成契约要求探索 / 调研 / 计划 / 设计 HTML 齐全并过评审门；跳过会让 DAG 后继节点没有输入。

**结论：走选项 A。**

## 5. 明确不做

- 不改 `department-registry.ts`、Lead 规则、`test-deploy.sh`；
- 不新增测试；
- 不去 Discord 频道贴 issue 号（那是 QA agent 的动作）；
- 不归档 issue（S6 PASS 后由 QA / Lead 处理）。

## 6. 交给调研阶段的问题

1. 实现节点的 PR 最小内容是什么，CI 对 docs-only PR 有没有额外要求？
2. S6 证据模板应记录哪些字段，才能和 FLY-127 既有 QA 证据格式对齐？
3. `canSpawnRunners` 在 slot1（cos）上的实际取值如何从仓库侧确定？
