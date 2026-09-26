# FLY-139 Ops-Test 单标签 S2 夹具 — 实施计划
Issue: FLY-139 (https://linear.app/geoforge3d/issue/FLY-139/qa-fly-127-sandbox-ops-test-label-only-s2-mismatch)
日期: 2026-09-25
基于: research.md

**Version**: v1.57.0（不改 `doc/VERSION`；docs-only）
**Status**: draft
**Source**: `ops-test/doc/FLY-139-ops-test-label-mismatch/exploration.md`, `ops-test/doc/FLY-139-ops-test-label-mismatch/research.md`

## 0. 一句话

FLY-139 是 FLY-127 「部门范围检查」的 S2（`label_mismatch`）测试夹具；S2 在当前 HEAD 的代码、单测、e2e 三层已闭环并实跑通过，本计划**不改任何生产代码或测试**，只交付一份可复核的夹具合同 + 证据 + 关单条件，随本分支 PR 合入 QA 沙箱仓。

## 1. 范围与边界

| 做 | 不做 |
|---|---|
| 在本 issue 文件夹落 `fixture-contract.md`（夹具合同，见 §3） | 改 `department-registry.ts` / `runs-route.ts` / 任何 `__tests__` |
| 在当前 HEAD 重跑现有 dept-scope 测试并把输出落进 `qa-evidence.md` | 新增单测（现有 case 已覆盖同一分支，见 research §5） |
| 明确 S2 触发的**前置条件**（开关、调用方、标签集合） | 改 Linear issue 标签/状态（无权限；关单是 QA verdict 后 Lead 的动作） |
| 一个 docs-only PR 关联 FLY-139 | 改共享 QA 手册 `529-room-playbook.md`、`CLAUDE.md`、里程碑表 |
| | 起 QA 房 / 跑 `test-deploy.sh`（宿主机动作，属 QA 节点或 Lead） |

**稳定身份**：issue `FLY-139`；文件夹 `ops-test/doc/FLY-139-ops-test-label-mismatch/`；分支 `project-slot-1-FLY-139`；PR 目标仓 `xrliAnnie/flywheel-qa-sandbox`。
**显示标签**：Linear 标签 `Ops-Test`（唯一部门标签）。
**迁移 / 回滚边界**：无数据、无 schema、无配置变更；回滚 = revert 该 docs-only PR，对运行系统零影响。

## 2. 分块（实现节点按序执行；每块结束更新 progress.md）

### C1 — 前置核验（不改代码）

- [ ] `git branch --show-current` = `project-slot-1-FLY-139`，`turn` 答 `yours`。
- [ ] 核 Linear 上 FLY-139 的标签集合恰为 `{Ops-Test}`：优先经房内 Bridge `GET /api/linear/issues`（带房内 api-token）或 `flywheel-comm ask` 请 Lead 代查；本设计节点 Linear MCP 401 未能核验。
  - 若多出第二个部门标签 → **停手**，用 `ask` 报 Lead：夹具已变形为 S3 形状，需 Lead 决定摘标签或另建夹具；不得自行改标签。
- [ ] 记录当前 HEAD sha 到 `qa-evidence.md` 头部。

### C2 — 夹具合同 `fixture-contract.md`

- [ ] 写入 §3 的全部字段（逐项、可机器核对）。
- [ ] 负向守卫（写进合同，QA 逐条打勾）：
  1. 调用方 Lead 必须 `canSpawnRunners !== false`，否则得到 `lead_cannot_spawn` 而非 `label_mismatch`。
  2. Bridge 必须 `BRIDGE_DEPT_SCOPE_REJECT` 非 `off`；测试房要在 `test-deploy.sh` 前设 `TEST_BRIDGE_DEPT_SCOPE_REJECT=on`（默认 `off`）；改环境须重启 Bridge。
  3. issue 标签恰 1 个部门标签且属于**另一个**能起 Runner 的 Lead；0 个 → `issue_no_department_label`，≥2 → `issue_multiple_department_labels`。
  4. 响应体不得含 `message` 字段；`canonicalLeadId` 必须是拥有 `Ops-Test` 的 Lead agentId（本房为 `flywheel-test-4`），不得为 `null`。
  5. dispatcher 不得被调用（e2e 已断言 `mockDispatcher.start` 未触发；真机以 CommDB `sessions` 无新行为准）。

### C3 — 证据 `qa-evidence.md`

- [ ] 在 `packages/teamlead` 执行并原样粘贴摘要行：

```
npx vitest run src/__tests__/department-registry.test.ts src/__tests__/start-e2e.test.ts -t "label_mismatch|precedence|DEPT_SCOPE"
```

  预期：`Test Files 2 passed (2)`，且含 `403 DEPT_SCOPE_REJECT label_mismatch when product-lead targets Ops-labelled issue ✓`。设计节点 2026-09-25 在 HEAD `7cc3e233e` 已得到 `15 passed | 57 skipped`。
- [ ] 前置：worktree 无 `node_modules` 时先 `pnpm install --frozen-lockfile --offline` + `pnpm --filter "flywheel-teamlead^..." build`；两者不产生受跟踪改动，`git status` 须仅见本 issue 文件夹。
- [ ] 若任一测试失败：**不修**，把失败输出贴进 `qa-evidence.md`，`ask` 报 Lead（这意味着 FLY-127 回归，属新 issue）。

### C4 — PR（docs-only）

- [ ] 只 `git add ops-test/doc/FLY-139-ops-test-label-mismatch/`；commit `docs(FLY-139): S2 label_mismatch fixture contract + evidence`。
- [ ] `git push -u origin HEAD`；`gh pr create`，body 含：变更摘要（docs-only、零生产代码）、Test Plan（C3 命令 + 结果）、`## Linear Issue` 段（`FLY-139` + URL）、关单条件（§4）。
- [ ] 不请求 ship、不合并；后续由 DAG 的 review / QA 节点接手。

## 3. 夹具合同（`fixture-contract.md` 的内容骨架）

| 字段 | 值 |
|---|---|
| 夹具 issue | FLY-139 |
| 场景 | S2 = `label_mismatch`（FLY-127 R3 Layer 2） |
| issue 标签集合 | 恰 `{Ops-Test}`（大小写不敏感匹配） |
| 标签拥有者 | `FLYWHEEL_PROJECTS[].leads[]` 中 `match.labels` 含 `Ops-Test` 的 Lead（本房 `flywheel-test-4`；示例配置里为 slot 3；合同只认标签） |
| 调用方 | 任一 `canSpawnRunners !== false` 且标签不含 `Ops-Test` 的 Lead（本房 `flywheel-test-1`，Product-Test） |
| 触发动作 | `POST /api/runs/start` `{issueId:"FLY-139", projectName:"test-slot-1", leadId:"<调用方>"}` |
| 开关 | `BRIDGE_DEPT_SCOPE_REJECT` 非 `off`（测试房：`TEST_BRIDGE_DEPT_SCOPE_REJECT=on`） |
| 期望响应 | HTTP 403，body 恰为 `{success:false, code:"DEPT_SCOPE_REJECT", reason:"label_mismatch", canonicalLeadId:"<Ops-Test 拥有者>", silent:false}` |
| 期望副作用 | 无 dispatcher 调用、无新 session；Bridge 日志一行 `[runs/start] FLY-127 dept-scope reject: ... reason=label_mismatch` |
| 判定源码 | `packages/teamlead/src/department-registry.ts` `isLeadInScope()` 优先级 6；`packages/teamlead/src/bridge/runs-route.ts` dept-scope 段 |
| 自动化对应 | `department-registry.test.ts` precedence 6；`start-e2e.test.ts` "403 DEPT_SCOPE_REJECT label_mismatch …" |
| 失效条件 | 标签集合变化、调用方 `canSpawnRunners:false`、开关 `off`、issue 被关闭/归档后 Linear 预检失败 |

## 4. 关单条件（写进 PR body，供 QA verdict 与 Lead 关单）

1. C1 核验通过（标签恰 `{Ops-Test}`）。
2. C3 测试在合入 HEAD 通过。
3. PR 合入 `xrliAnnie/flywheel-qa-sandbox`。
4. QA 节点 verdict = pass 后，Lead 按 issue 原话「Safe to close after QA verdict」关闭 FLY-139；本计划不代为关单。

## 5. 风险与已知不确定

| 风险 | 处理 |
|---|---|
| Linear 标签已被改动 | C1 停手报 Lead；不猜。 |
| 现有测试在合入 HEAD 回归 | C3 不修、报 Lead、另立 issue。 |
| 实现节点误以为要写代码 | §1 边界 + PR 标题 `docs(FLY-139)` 前缀；review 节点核 diff 仅含 `ops-test/doc/FLY-139-*`。 |
| Lead 对非阻塞问题 `cb860e27` 给出不同裁定（如直接关单） | 收到即按裁定改；未收到按本计划。 |

## 6. 评审记录

- Lead 非阻塞问题 `cb860e27-9a94-410a-a60d-bb0cdf468f55`（范围确认：docs-only），发出于 2026-09-25，截至写本节尚未答复。
- Codex 设计评审：待 `stage set design_review` 后按评审门流程记录轮次与结论。
