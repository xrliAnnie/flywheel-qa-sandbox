# Research: Claude Lead mem0 Memory Integration — GEO-203

**Issue**: GEO-203
**Date**: 2026-03-22
**Source**: `doc/engineer/exploration/new/GEO-203-claude-lead-mem0-memory.md`

## 1. 研究目标

基于 exploration 确定的方案（Bash curl 直调 Bridge Memory API），调研以下实现细节：

1. Bootstrap generator 如何接入分层 recall
2. Claude Lead 行为配置如何添加 Memory API 指导
3. Supervisor script 如何注入环境变量
4. 现有代码约束与需要的改动

## 2. Bootstrap Generator 接入分析

### 2.1 当前代码

```typescript
// bootstrap-generator.ts:57-64
return {
  leadId,
  activeSessions: activeSessions.map(toBootstrapSession),
  pendingDecisions: pendingDecisions.map(toBootstrapDecision),
  recentFailures: recentFailures.map(toBootstrapFailure),
  recentEvents,
  memoryRecall: null, // GEO-198: wire after mem0 moves to Lead
};
```

**函数签名**: `generateBootstrap(leadId, store, projects)` — 不接收 `memoryService`

**修改方案**: 添加可选参数 `memoryService?: MemoryService`

### 2.2 分层 Recall 策略

`MemoryService.searchMemories()` 的 `agentId` 是**可选参数**（`packages/edge-worker/src/memory/MemoryService.ts:132`）。不传时搜索整个 project。

Bootstrap generator 直接调用 MemoryService（server-side），无需走 REST API，因此不受 route 的 `agent_id` 必填限制。

```typescript
// 伪代码：分层 recall
async function recallMemories(
  memoryService: MemoryService,
  projectName: string,
  agentId: string,
): Promise<string | null> {
  // Primary: 本角色记忆（limit 10）
  const primary = await memoryService.searchAndFormat({
    query: "recent decisions, project context, and learnings",
    projectName,
    agentId,
  });

  // Secondary: 全局记忆（limit 5，不传 agentId）
  const secondary = await memoryService.searchAndFormat({
    query: "cross-team context and project-wide decisions",
    projectName,
    // agentId 不传 → 搜索所有 agent 的记忆
  });

  if (!primary && !secondary) return null;

  const parts: string[] = [];
  if (primary) parts.push("### Role-Specific Memory\n" + primary);
  if (secondary) parts.push("### Project-Wide Context\n" + secondary);
  return parts.join("\n\n");
}
```

**关键**: `searchAndFormat()` 自带 graceful degradation（错误返回 `null`），与 bootstrap 的 advisory 模式一致。

### 2.3 LeadBootstrap 类型

```typescript
// lead-runtime.ts:25
memoryRecall: string | null;
```

类型已经是 `string | null`，不需要改。只是内容会变长。

### 2.4 Bootstrap 格式化截断问题

```typescript
// claude-discord-runtime.ts:177-181
if (snapshot.memoryRecall) {
  sections.push("### Memory Recall");
  sections.push(snapshot.memoryRecall.slice(0, 500));  // ← 500 字符太小
  sections.push("");
}
```

**问题**: 500 字符截断对分层 recall 不够。一个 `searchAndFormat()` 返回 10 条记忆通常 ~1000-2000 字符。

**修改方案**: 增大到 ~3000 字符（Discord 单条消息限制 2000 字符，但 `splitMessage()` 已经处理了分片）。或者去掉截断，让 `splitMessage()` 自然处理。

## 3. Memory REST API — agent_id 约束

### 3.1 当前约束

```typescript
// memory-route.ts:40-43
if (!isNonEmptyString(agent_id)) {
  res.status(400).json({ error: "agent_id must be a non-empty string" });
  return;
}
```

`/api/memory/search` 要求 `agent_id` 必填 — Claude Lead 通过 curl 搜索时必须传自己的 agent_id，**无法做跨 agent 搜索**。

### 3.2 下游 MemoryService 支持

```typescript
// MemoryService.ts:132
async searchMemories(params: {
  query: string;
  projectName: string;
  agentId?: string;  // ← 可选！
  limit?: number;
}): Promise<string[]>
```

MemoryService 本身支持 `agentId` 可选。约束只在 REST route 层。

### 3.3 改动方案

将 `/api/memory/search` 的 `agent_id` 从必填改为可选：

```typescript
// 删除 agent_id 必填验证（search endpoint 中）
// agent_id 仍在 /add 中保持必填（写入必须标记来源）
```

这样 Claude Lead 可以：
- **搜索自己的记忆**: 传 `agent_id` → 过滤
- **搜索全局记忆**: 不传 `agent_id` → 全 project 搜索

**注意**: `/api/memory/add` 的 `agent_id` 保持必填 — 写入必须标记来源 agent。

## 4. Claude Lead 行为配置分析

### 4.1 当前 CLAUDE.md 结构

位置: `/Users/xiaorongli/Dev/geoforge3d/product/.lead/claude-lead/CLAUDE.md`

已有结构：
- 核心身份（角色、限制）
- 事件处理（控制频道消息解析）
- CEO 指令执行（actions API）
- 汇报风格
- 工具（Discord MCP + Bridge API curl 表）

**Bridge API 表** 已列出 sessions、actions、linear 等 endpoint。**缺少 Memory API**。

### 4.2 需要添加的内容

在 CLAUDE.md 的工具/Bridge API 表中添加 Memory endpoints：

| Endpoint | Method | 用途 |
|----------|--------|------|
| `/api/memory/search` | POST | 搜索项目记忆 |
| `/api/memory/add` | POST | 写入记忆 |

新增 **Memory 使用指南** section：

```markdown
## 记忆

你可以通过 Bridge Memory API 读写项目记忆。记忆帮助你保持跨 session 的连续性。

### 何时搜索记忆

- 做重要决策前（approve/reject/retry），回顾相关 issue 的历史
- CEO 问你上下文时，先查记忆
- 重新启动后（bootstrap 已预加载部分记忆，可按需追加搜索）

### 何时写入记忆

**Must-write（每次都写）**:
- 做完重要决策后（approve/reject/retry + 理由）
- 发现新的项目约束或 pattern
- CEO 给出关键指示

**自主判断**: 任何你认为未来会有参考价值的信息

### curl 示例

搜索（本角色）:
  curl -s -X POST http://localhost:9876/api/memory/search \
    -H "Authorization: Bearer $TEAMLEAD_API_TOKEN" \
    -H "Content-Type: application/json" \
    -d '{"query":"...", "project_name":"geoforge3d", "agent_id":"product-lead"}'

搜索（全局）:
  curl -s -X POST http://localhost:9876/api/memory/search \
    -H "Authorization: Bearer $TEAMLEAD_API_TOKEN" \
    -H "Content-Type: application/json" \
    -d '{"query":"...", "project_name":"geoforge3d"}'

写入:
  curl -s -X POST http://localhost:9876/api/memory/add \
    -H "Authorization: Bearer $TEAMLEAD_API_TOKEN" \
    -H "Content-Type: application/json" \
    -d '{"messages":[{"role":"user","content":"..."},{"role":"assistant","content":"..."}], "project_name":"geoforge3d", "agent_id":"product-lead"}'
```

### 4.3 环境变量

`$TEAMLEAD_API_TOKEN` 已在 supervisor script 中通过环境变量传入。其他值（`project_name`、`agent_id`、Bridge URL）对每个 lead 固定，在 CLAUDE.md 中硬编码更简单清晰。

不需要额外注入 `PROJECT_NAME` / `AGENT_ID` 环境变量 — 减少 supervisor script 改动。

## 5. Supervisor Script 分析

### 5.1 当前结构

`packages/teamlead/scripts/claude-lead.sh`:
- 接收 `<lead-id>` 和 `<project-dir>` 参数
- 使用 `BRIDGE_URL` (default `http://localhost:9876`) 和 `TEAMLEAD_API_TOKEN`
- 发送 bootstrap → sleep 3s → 启动 claude CLI
- 工作目录: `${PROJECT_DIR}/product/.lead/claude-lead`

### 5.2 需要的改动

**无需改动**。原因：
- Bootstrap 改进在 server-side（`bootstrap-generator.ts`），supervisor script 只调用 `POST /api/bootstrap/:leadId`
- Memory API 的 project_name / agent_id 在 CLAUDE.md 中硬编码
- `TEAMLEAD_API_TOKEN` 已作为环境变量传入

如果未来需要让同一个 CLAUDE.md 模板服务多个 lead，再考虑环境变量注入。

## 6. 改动清单

| # | 文件 | 改动 | 复杂度 |
|---|------|------|--------|
| 1 | `packages/teamlead/src/bridge/bootstrap-generator.ts` | 添加 `memoryService` 可选参数，实现分层 recall | Medium |
| 2 | `packages/teamlead/src/bridge/claude-discord-runtime.ts` | 移除或增大 `memoryRecall` 的 500 字符截断 | Small |
| 3 | `packages/teamlead/src/bridge/plugin.ts` | 传 `memoryService` 给 `generateBootstrap()` | Small |
| 4 | `packages/teamlead/src/bridge/memory-route.ts` | `/search` 的 `agent_id` 从必填改为可选 | Small |
| 5 | `geoforge3d/product/.lead/claude-lead/CLAUDE.md` | 添加 Memory API section（搜索/写入指南 + curl 示例） | Small |
| 6 | Tests | bootstrap-generator tests + memory-route tests 更新 | Medium |

**总计**: ~6 个文件改动，1 个新增 section，2 个 test 文件更新。

## 7. 风险与 Edge Cases

### 7.1 Bootstrap 记忆延迟

mem0 `searchMemories()` 涉及 Gemini embedding + Supabase pgvector 查询。在 bootstrap 中增加两次搜索会增加启动时间。

**缓解**: `searchAndFormat()` 已有 graceful degradation。如果搜索超时或失败，`memoryRecall` 为 null，bootstrap 正常发送。不阻塞启动。

### 7.2 Discord 消息长度

分层 recall 可能产生 ~2000-3000 字符的 memory 内容。加上其他 bootstrap sections，总长可能超过 Discord 2000 字符限制。

**缓解**: `splitMessage()` 已经在 `sendBootstrap()` 中处理了分片。只需移除 500 字符截断。

### 7.3 agent_id 可选的安全性

将 `/api/memory/search` 的 `agent_id` 改为可选会让任何 caller 搜索全 project 记忆。

**风险评估**: 低。Bridge API 已有 token auth 保护。调用方都是受信任的 lead agents。跨 agent 可见性是设计目标（exploration Q2/Q4 决策）。

### 7.4 Claude Lead 使用频率

Claude 可能过度或不足使用 memory API。

**缓解**: CLAUDE.md 中明确 must-write 节点 + 搜索时机。初期观察实际使用模式，必要时调整指导。

## 8. 不在研究范围

- OpenClaw Lead 的 TOOLS.md 更新（已有 Memory API 文档）
- mem0 数据清理或 schema 变更
- 跨项目记忆共享
- Memory API 的 rate limiting
