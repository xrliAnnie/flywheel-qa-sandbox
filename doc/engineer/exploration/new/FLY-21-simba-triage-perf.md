# Exploration: Simba Triage Performance — FLY-21

**Issue**: FLY-21 (Simba Triage 太慢)
**Date**: 2026-03-30
**Status**: Complete

## Problem

Simba (COS Lead) 的 triage 流程太慢。每次 triage 需要 Simba 执行多个查询、处理大量数据、生成 HTML 报告。

## Root Cause Analysis

### Bottleneck 1: `description` field 被获取但未使用

`linear-query.ts` 的 GraphQL 查询获取了每个 issue 的 `description` 字段。Issue description 可以非常长（多段文字），100 个 issue 可能产生 50KB+ 的无用 payload。

**Simba triage 只使用**: identifier, title, priority, state, labels, assignee, url。Description 从未出现在报告中。

**影响**:
- 增加 Linear API 响应时间
- 增大 Simba 的 LLM 输入 token 数 → LLM 处理更慢

### Bottleneck 2: 无缓存

每次查询都创建新的 `LinearClient` 并直接请求 Linear API。如果 Simba 在几分钟内重新运行 triage，完全相同的数据被重新获取。

### Bottleneck 3: 三次顺序 HTTP 调用

Simba 依次执行三个 curl 调用:
1. `GET /api/linear/issues` — 外部 Linear API (1-3s)
2. `GET /api/sessions` — 本地 SQLite (<100ms)
3. `GET /api/runs/active` — 本地 SQLite (<100ms)

每个 curl 调用都有开销（HTTP 连接、序列化/反序列化）。

## Fixes Implemented

### Fix 1: Slim mode — 可选省略 `description`

`linear-query.ts` 新增 `slim?: boolean` 参数。当 `slim=true` 时，GraphQL query 不包含 `description` 字段。

- API 端: `GET /api/linear/issues?slim=true`
- **可选参数，默认 false** — description 对 triage 分析有价值，不强制省略
- 向后兼容: 默认行为不变

### Fix 2: Combined `/api/triage/data` endpoint (3 calls → 1)

新端点 `GET /api/triage/data?project=X` 返回:
```json
{
  "issues": [...],        // 含 description（除非 slim=true）
  "issueCount": 42,
  "truncated": false,
  "sessions": [...],      // active sessions
  "sessionCount": 3,
  "capacity": { "running": 2, "inflight": 0, "total": 2, "max": 3 }
}
```

- Linear query 和 SQLite query **并行执行** (`Promise.all`)
- 默认 state filter: `backlog,unstarted,started`
- 默认 limit: 100
- 支持 `leadId` scope filter
- 支持可选 `slim=true` 参数

### Simba agent.md 更新

Triage Step 1 从三个独立 curl 变为一个合并查询，附带备用回退方案。

### 未实施: Cache

Annie 认为 cache 容易 outdated 且容易忘记清理，决定不加缓存。

## Performance Impact Estimate

| Metric | Before | After | Improvement |
|--------|--------|-------|-------------|
| HTTP round trips | 3 | 1 | 66% reduction |
| Linear + SQLite queries | Sequential | Concurrent (Promise.all) | Latency overlap |

## Files Changed

| File | Change |
|------|--------|
| `packages/teamlead/src/bridge/linear-query.ts` | Slim mode |
| `packages/teamlead/src/bridge/triage-data-route.ts` | New combined endpoint |
| `packages/teamlead/src/bridge/plugin.ts` | Pass slim param + mount triage route |
| `packages/teamlead/src/__tests__/linear-issues.test.ts` | Slim mode tests |
| `packages/teamlead/src/__tests__/triage-data.test.ts` | Combined endpoint tests |
| `GeoForge3D/.lead/cos-lead/agent.md` | Updated triage commands |

## Test Coverage

- 14 tests for `/api/linear/issues` (2 new: slim mode on/off)
- 9 tests for `/api/triage/data` (new: combined response, slim optional, default filters, error handling, session inclusion)
