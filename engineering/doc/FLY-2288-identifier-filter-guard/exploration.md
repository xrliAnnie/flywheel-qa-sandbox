# FLY-2288 identifier 过滤静默忽略 — 探索
Issue: FLY-2288 (https://linear.app/geoforge3d/issue/FLY-2288/bridge-apilinearissues-的-identifier-过滤被静默忽略-查-a-单拿到-b-单格式完好无报错)
日期: 2026-09-04
基于: 无

## 问题重述

`GET /api/linear/issues` 当前只读取 `project`、`state`、`labels`、`limit`、`slim`、`projectName`。Express 会把未读取的 query key 保留在 `req.query`，但 handler 没有校验剩余 key，因此 `identifier=FLY-2140` 被静默丢弃，随后执行未过滤列表查询并返回 HTTP 200。响应结构完整，使调用者可能把列表首条误认成目标 issue。

精确读口已经存在：`GET /api/linear/issue?query=FLY-2140` 使用 `lookupLinearIssueByIdentifier`，无需在列表端再实现一套 identifier 查询。

## 锁定范围与假设

1. `identifier` 不是 `/api/linear/issues` 的受支持参数；调用者应继续使用单数 `/api/linear/issue?query=`。
2. 列表端当前声明并实际读取的六个参数视为 allowlist：`project`、`state`、`labels`、`limit`、`slim`、`projectName`。
3. 对 allowlist 外的任意 query key 返回 400，符合 issue 提出的“未知过滤参数 fail loud”原则；这不包含对 `project=` 等既有过滤器正确性的普查或修复。
4. 重复的已知 key 仍合法，沿用现有数组归一化语义；无参数请求与所有已知参数的响应/GraphQL 语义保持不变。

## 验收边界

- `?identifier=FLY-2140` 返回 400，错误体明确指出不支持的参数，且不调用 Linear SDK。
- `?identifier=FLY-999999` 同样返回 400，不得返回任何 issue。
- 无参数查询仍执行原有列表请求并返回原有结构。
- 已知参数（含重复 `state`/`labels`）仍按现有测试工作。
- 本单不修改 `/api/linear/issue`，不新增 GraphQL identifier filter，不处理 `project=` 的已知同族问题。

## 风险

- 过去依赖未知参数被忽略的调用会从 200 变为 400；这是本修复刻意建立的安全边界。
- 错误消息包含 query key，必须通过 JSON 序列化返回，避免任何 HTML 拼接。
- allowlist 若未来新增参数必须同步更新；回归测试会把未接线的新参数暴露为 400，而不是静默放行。
