# FLY-145 S6 重试沙箱单 — 调研
Issue: FLY-145 (https://linear.app/geoforge3d/issue/FLY-145/qa-fly-127-sandbox-s6-retry-product-test)
日期: 2026-09-25
基于: exploration.md

## 1. 调研目标

回答探索文档 §6 的三个问题，把"零代码改动"的设计落到可执行、可验证的粒度。

## 2. 问题一：slot1（cos）对 Product-Test 单的 registry 结论是什么

- `packages/teamlead/src/ProjectConfig.ts` 第 84–87 行：`canSpawnRunners` 缺省为 `true`，但 `loadProjects()` 的 PM/Triage 校验器要求 **`match.labels` 含 "PM" 或 "Triage"（大小写不敏感）的 Lead 必须显式 `canSpawnRunners: false`**，否则配置加载直接抛错。
- slot1 的部门标签是 `PM-Test`（`~/.flywheel/test-slots.json`），含 "PM"，因此 slot1 的 Bridge 若能启动，其 cos Lead 必然是 `canSpawnRunners: false`。
- 对应 `isLeadInScope()` 决策优先级第 3 条：**`lead_cannot_spawn`** 早于任何标签判断返回。

结论：S6 矩阵中 flywheel-test-1 的预期 reason 应写成 `lead_cannot_spawn`，而不是 `label_mismatch`。这修正了探索文档 §2 表格中"若…否则…"的两可写法。

同时注意 `classifyIssue()` 只遍历 `canSpawnRunners` 为真的 Lead（`department-registry.ts` 第 115 行 `if (!effectiveCanSpawn(lead)) continue;`），所以 PM-Test 标签本身永远不会成为 canonical 部门；这与 FLY-127 设计"PM/triage 不认领"一致。

## 3. 问题二：S6 证据模板应对齐哪种格式

仓库里最近的 QA 证据先例是 `engineering/doc/FLY-1189-qa-prc-nton-e2e/qa-evidence/`：

- 每个场景一个 JSON（`S0-environment.json`、`E1-E2-evidence.json`…），外加 `campaign-meta.json`；
- `S0-environment.json` 记录 `bridge_head`、`bridge_port`、`campaign_id`、`slot_dir`、`leads[]`（agentId / role / labels / channel）与开关 `flags`；
- 字段是扁平键值，便于 QA 用 `jq` 汇总。

S6 证据模板因此建议采用同一形状（一个 `S6-product-test-matrix.json` 模板 + 一段 markdown 填表说明），每个 Lead 一条记录：

| 字段 | 含义 |
|---|---|
| `agentId` | Lead bot 名（flywheel-test-N） |
| `deptLabel` | 该槽的部门标签 |
| `expectedReason` | `ok` / `label_mismatch` / `lead_cannot_spawn` |
| `observedReason` | QA 从 Bridge 响应或 Lead 回复中抄录 |
| `discordReply` | Lead 在频道里的一行回复原文（沉默填 `null`） |
| `spawned` | 是否真的起了 Runner |
| `evidenceRef` | 消息链接 / 日志路径 |

**模板只是模板**：实现节点不填 `observed*` 字段，留给 QA。

## 4. 问题三：docs-only PR 的 CI 处理

- `.github/workflows/ci.yml` 的 `classify` 作业（FLY-1861）会判断当前 PR 头是否为"最新绿基线的纯文档后代"；是则跳过重活，任何不确定都跑全量。
- 本单 PR 只含 `product-test/doc/FLY-145-s6-retry-product-test/` 下的 markdown / JSON / HTML / mmd / svg，属于典型 docs-only 头。
- 不需要为此加任何 CI 例外；也**不应**给 PR 打 `ci:full` 之类标签去改变默认路径。

## 5. 顺带核对的边界

- **Lead 侧不预过滤**（`department-lead-rules.md` §5）：S6 的"沉默"其实是 Lead 调了 `POST /api/runs/start`、拿到 403 `DEPT_SCOPE_REJECT` 后只回一行且不重试。因此严格说预期不是"完全沉默"，而是"最多一行拒绝回复、零 spawn"。证据模板的 `discordReply` 字段允许一行回复。
- **PR #170 的 shadow Lead 机制**：让每个槽的 registry 看到全部兄弟部门，S6 的 `label_mismatch` 路径才可测。它已合入，不在本单范围内重验。
- **Linear MCP 本会话不可用**（鉴权 401）：无法读取 issue 实时标签，探索 §3 的不一致只能留给 Lead 确认。

## 6. 交给计划阶段的结论

1. 实现节点交付 **docs-only PR**，新增两个文件：`S6-product-test-matrix.template.json` 与 `s6-evidence-guide.md`；不改任何代码。
2. 预期矩阵：test-2 `ok`；test-3 / test-4 `label_mismatch`；test-1 `lead_cannot_spawn`。
3. 验证方式：PR 的 diff 只落在本文件夹；CI classify 判为 no_code；`jq` 能解析模板 JSON。
