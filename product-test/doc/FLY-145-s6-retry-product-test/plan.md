# FLY-145 S6 重试沙箱单 — 实施计划
Issue: FLY-145 (https://linear.app/geoforge3d/issue/FLY-145/qa-fly-127-sandbox-s6-retry-product-test)
日期: 2026-09-25
基于: research.md

**Status**: draft（待 Codex 设计评审）

## 1. 一句话

本单是 QA-FLY-127 S6 场景的沙箱哑单，**不改任何代码**；实现节点只交付一个 docs-only PR，里面放 S6 的预期矩阵、证据模板和填表说明，供 QA 在 Discord 侧收集证据时对照。

## 2. 范围

### 做
- 在 `product-test/doc/FLY-145-s6-retry-product-test/` 新增：
  1. `S6-product-test-matrix.template.json` — 4 个 Lead 的预期记录，`observed*` 字段留空；
  2. `s6-evidence-guide.md` — 告诉 QA 怎么填、什么算 PASS。
- 把本文件夹（探索 / 调研 / 计划 / 设计 HTML / 进度账本）随 PR 合到 main。

### 不做（负向护栏）
- 不改 `packages/teamlead/src/department-registry.ts`、`packages/teamlead/lead-rules-base/*.md`、`scripts/test-deploy.sh`；
- 不新增或修改任何 `*.test.ts`；
- 不去 Discord 频道贴 issue 号，不代 QA 填写 `observed*` 字段；
- 不归档 issue，不打 `ci:full` 标签；
- PR diff 若出现本文件夹以外的任何路径，即视为越界，实现节点必须回退。

## 3. 预期矩阵（单一事实来源）

| agentId | deptLabel | expectedReason | 预期 Discord 表现 | spawned |
|---|---|---|---|---|
| flywheel-test-2 | Product-Test | `ok` | 认领 + spawn 通知 | true |
| flywheel-test-3 | Ops-Test | `label_mismatch` | 至多一行"被判定为 flywheel-test-2 的范围，我不会启动" | false |
| flywheel-test-4 | Finance-Test | `label_mismatch` | 同上 | false |
| flywheel-test-1 | PM-Test（cos） | `lead_cannot_spawn` | 沉默，或至多一行"我不负责启动 Runner" | false |

依据：`isLeadInScope()` 决策优先级（`department-registry.ts` 第 259–266 行注释）与 PM 标签强制 `canSpawnRunners:false`（`ProjectConfig.ts` 第 84–87 行）。表格只在这里维护一份；模板 JSON 由它派生，不另写一套词汇。

## 4. 文件设计

### 4.1 `S6-product-test-matrix.template.json`

```json
{
  "scenario": "S6",
  "issue": "FLY-145",
  "issueLabels": ["Product-Test"],
  "campaign_id": null,
  "bridge_head": null,
  "leads": [
    { "agentId": "flywheel-test-2", "deptLabel": "Product-Test", "expectedReason": "ok",
      "expectedSpawned": true,  "observedReason": null, "observedSpawned": null, "discordReply": null, "evidenceRef": null },
    { "agentId": "flywheel-test-3", "deptLabel": "Ops-Test",     "expectedReason": "label_mismatch",
      "expectedSpawned": false, "observedReason": null, "observedSpawned": null, "discordReply": null, "evidenceRef": null },
    { "agentId": "flywheel-test-4", "deptLabel": "Finance-Test", "expectedReason": "label_mismatch",
      "expectedSpawned": false, "observedReason": null, "observedSpawned": null, "discordReply": null, "evidenceRef": null },
    { "agentId": "flywheel-test-1", "deptLabel": "PM-Test",      "expectedReason": "lead_cannot_spawn",
      "expectedSpawned": false, "observedReason": null, "observedSpawned": null, "discordReply": null, "evidenceRef": null }
  ],
  "verdict": null
}
```

- 形状对齐 `engineering/doc/FLY-1189-qa-prc-nton-e2e/qa-evidence/S0-environment.json`（扁平键值、`leads[]`）。
- `null` 表示"待 QA 填写"，不是"无"。
- `verdict` 取值 `PASS` / `FAIL`，由 QA 填。

### 4.2 `s6-evidence-guide.md`

内容三段：
1. **怎么跑**：QA agent 在 cos-test 贴 `FLY-145`，等四个 Lead 反应（≤ 一个 Lead 心跳周期），抄录回复原文与 Bridge 日志中的 `DEPT_SCOPE_REJECT reason`；
2. **怎么填**：逐 Lead 填 `observedReason` / `observedSpawned` / `discordReply` / `evidenceRef`；
3. **PASS 判据**：四行 `observedReason === expectedReason` 且 `observedSpawned === expectedSpawned`；任何一行不符即 FAIL，并注明 Bridge head。

## 5. 实施步骤（给实现节点）

| # | 步骤 | 验证 |
|---|---|---|
| 1 | 从本分支继续，`turn` 为 `yours` 后再写 | `flywheel-comm turn` 输出 `yours` |
| 2 | 按 §4.1 写模板 JSON | `jq . S6-product-test-matrix.template.json` 退出码 0；`jq '.leads|length'` 输出 4 |
| 3 | 按 §4.2 写填表说明 | 文件存在，标题三行符合 DOC-FLOW |
| 4 | `git diff --name-only origin/main...HEAD` | 全部路径以 `product-test/doc/FLY-145-s6-retry-product-test/` 开头 |
| 5 | 提交、推送、开 PR，body 含 `## Linear Issue` 段 | PR 链接回填 issue |
| 6 | 等 CI classify | 期望 `no_code=true`；若跑了全量也不算失败 |

无迁移、无回滚边界（没有状态改动；回滚 = 关 PR）。

## 6. 测试证据

- 本单没有代码，因此没有单元测试；**这是有意的**，理由见探索 §4 选项 B 的拒绝。
- "测试"就是 §5 第 2、4 步的两条命令输出，实现节点把输出贴进 PR body 的测试计划。

## 7. 风险与开放问题

| 风险 | 处理 |
|---|---|
| Linear 标签与 issue 正文不一致（本会话无法读取 Linear） | 已非阻塞询问 Lead；矩阵以 issue 正文 `Product-Test` 为准，QA 跑之前应再看一眼标签 |
| 本 exec 由 flywheel-test-1 派发，表面上与"test-1 沉默"相悖 | 记录为观察，不影响文档交付；若 Lead 答复说明是手动派发，在 design-correction.md 里补一句 |
| slot5/6（Product-Test-2 / Ops-Test-2）若也在线 | 不在 issue 预期矩阵内；QA 若观察到它们反应，作为附加行记入 `evidenceRef`，不改判据 |
