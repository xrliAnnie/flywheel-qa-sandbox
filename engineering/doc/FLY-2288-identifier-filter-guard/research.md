# FLY-2288 identifier 过滤静默忽略 — 调研
Issue: FLY-2288 (https://linear.app/geoforge3d/issue/FLY-2288/bridge-apilinearissues-的-identifier-过滤被静默忽略-查-a-单拿到-b-单格式完好无报错)
日期: 2026-09-04
基于: exploration.md

## 现有合同

### 列表端点

`packages/teamlead/src/bridge/plugin.ts` 的 `/api/linear/issues` handler 逐项读取六个 query key：

- `project`
- `state`
- `labels`
- `limit`
- `slim`
- `projectName`

随后调用 `queryLinearIssues()`。未被读取的 key 不进入任何 GraphQL variables，也不触发错误。

历史设计材料 `doc/engineer/research/archive/GEO-276-linear-query-api.md` 与 `doc/engineer/plan/archive/v1.16.0-GEO-276-pm-auto-triage.md` 只声明 `project/state/labels/limit`；后续 FLY-21 加入 `slim`，FLY-371 加入 `projectName`。`git blame` 显示这些是 handler 当前六个明确接线的参数，没有 `identifier` 合同。

`packages/teamlead/src/bridge/linear-query.ts` 的 `LinearQueryFilters` 同样没有 `identifier`。它支持的 GraphQL 条件是 project、state、labels，以及供其他内部调用使用的 `titleContains`；列表路由没有暴露后者。

### 精确端点

`GET /api/linear/issue?query=` 已调用 `lookupLinearIssueByIdentifier()`。该 helper 使用 Linear GraphQL `issue(id: $id)`，能精确返回一个 issue，并把不存在映射为 null/404 语义。它是现成且职责清晰的 identifier 读口。

### 测试形状

`packages/teamlead/src/__tests__/linear-issues.test.ts` 启动真实 Express app、mock `@linear/sdk` 的 `rawRequest`，覆盖认证后的 HTTP 状态、响应体以及传给 GraphQL 的 filter。这个文件能直接证明两件关键性质：

1. 未知参数在 HTTP 边界被拒绝；
2. 被拒请求没有调用 Linear SDK，因此不可能回落成未过滤列表。

## 方案比较

| 方案 | 结果 | 判断 |
| --- | --- | --- |
| 在列表端实现 `identifier` 精确过滤 | 需要定义它与 project/state/labels/limit 的组合语义，并重复单数端点能力 | 不采用；超出最小修复且制造双合同 |
| 只特判 `identifier` 返回 400 | 能修复当前复现，但任意拼写错误仍会静默变成无过滤查询 | 不采用；保留同一失效模式 |
| 明确 allowlist，任意未知 key 返回 400 | 修复当前复现，同时从机制上消除“未知参数静默忽略” | 采用 |

## 实现约束

- allowlist 放在模块级常量，避免每请求重建。
- handler 在参数归一化和任何 Linear 调用之前读取 `Object.keys(req.query)`，过滤 allowlist 外的 key，并排序以获得确定性错误。
- 未知 key 返回 HTTP 400 JSON；错误消息只经 `res.json()` 序列化，不拼接 HTML。
- 保留现有 `LINEAR_API_KEY` 501、Linear upstream 502、limit clamp、重复 state/labels、projectName binding 的行为。
- 本单不改变 `queryLinearIssues()`，也不审计或修复 `project=` 的过滤完整性。

## 可执行验证

聚焦测试使用 Lead 指定的单包、单线程形状：

```bash
VITEST_MAX_THREADS=1 VITEST_MIN_THREADS=1 pnpm --filter flywheel-teamlead exec vitest run src/__tests__/linear-issues.test.ts
```

回归测试应使用两个 identifier 值（一个已知形状、一个不存在形状），均断言 400、错误指出 `identifier`、`mockRawRequest` 未调用。现有无参数和六个已知参数测试继续证明兼容性。
