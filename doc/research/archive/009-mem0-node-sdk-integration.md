# 009 — mem0 Node.js SDK 集成研究

> 研究目标：评估 mem0 Node.js SDK 作为 Flywheel Memory System 的实现方案
> 日期：2026-03-09
> 状态：Complete
> 下游：v0.3 Memory System Plan（需基于本研究重写）

---

## 1. Executive Summary

mem0 (`npm install mem0ai`) 提供完整的 Node.js SDK，支持本地自建（`mem0ai/oss`）和云 API 两种模式。SDK 内置 LLM fact 提取、embedding 生成、vector similarity 搜索、冲突检测（ADD/UPDATE/DELETE）和审计日志。

**结论：直接用 mem0 OSS Node SDK，不需要自己写 memory 逻辑。**

关键优势：
- 零 Python 依赖：纯 TypeScript SDK，`npm install` 直接用
- 完整的 memory lifecycle：extraction → dedup → search → update → history
- 灵活 provider：LLM/Embedding/Vector Store 都可换
- MCP server 可选：既能 SDK 集成，也能作为 MCP 给 Claude Code 用

---

## 2. 包信息

| 属性 | 值 |
|------|-----|
| npm 包名 | `mem0ai` |
| 最新版本 | 2.3.0 |
| 最新 release | v1.0.5 (2026-03-03) |
| GitHub stars | 60k+ |
| Node.js 要求 | >= 18 |
| 导出路径 | `mem0ai`（云 API）, `mem0ai/oss`（自建） |
| 核心依赖 | `axios`, `openai`, `uuid`, `zod` |
| 可选 peer deps | `@anthropic-ai/sdk`, `@qdrant/js-client-rest`, `ollama`, `groq-sdk`, `neo4j-driver`, `better-sqlite3`, `pg`, `redis` 等 |

---

## 3. 两种模式

### 3a. 云 API 模式（`mem0ai`）

```typescript
import MemoryClient from 'mem0ai';
const client = new MemoryClient({ apiKey: 'm0-xxx' });
```

- 需要 mem0.ai 账号和 API key
- Free tier: 10,000 memories + 1,000 retrieval/月
- 自动 embedding + vector 搜索
- 无需自建基础设施

### 3b. OSS 自建模式（`mem0ai/oss`）

```typescript
import { Memory } from 'mem0ai/oss';
const memory = new Memory({
  llm: { provider: 'openai', config: { model: 'gpt-4.1-nano', apiKey: process.env.OPENAI_API_KEY } },
  embedder: { provider: 'openai', config: { model: 'text-embedding-3-small' } },
  vectorStore: { provider: 'memory', config: { collectionName: 'flywheel' } },
  historyDbPath: '.flywheel/memory-history.db',
});
```

- 数据完全本地
- 需要 OpenAI API key（或其他 LLM provider）做 fact 提取和 embedding
- Vector store 可选 in-memory（开发）或 Qdrant（生产）
- History 用 SQLite

---

## 4. API Surface

### 核心方法

| 方法 | 用途 | 关键参数 |
|------|------|----------|
| `memory.add(messages, opts)` | 从对话中提取 facts 并存储 | `user_id`, `agent_id`, `run_id`, `metadata` |
| `memory.search(query, opts)` | 语义搜索相关记忆 | `query`, `user_id`, `limit`, `filters` |
| `memory.getAll(opts)` | 获取所有记忆 | `user_id`, `agent_id` |
| `memory.get(memoryId)` | 获取单条记忆 | `memoryId` |
| `memory.update(memoryId, text)` | 更新记忆内容 | `memoryId`, `text` |
| `memory.delete(memoryId)` | 删除单条记忆 | `memoryId` |
| `memory.deleteAll(opts)` | 批量删除 | `user_id` |
| `memory.history(memoryId)` | 查看变更历史 | `memoryId` |
| `memory.reset()` | 清空所有数据 | — |

### Session Scoping（记忆隔离）

| Identifier | 作用域 | Flywheel 映射 |
|------------|--------|---------------|
| `user_id` | 长期用户上下文 | **project name**（如 `geoforge3d`） |
| `agent_id` | Agent 特定上下文 | **agent role**（如 `backend`, `frontend`, `qa`） |
| `run_id` | 临时会话 | **execution_id** |
| `app_id` | 应用级隔离 | `flywheel`（固定值） |

### Metadata Filtering

支持丰富的过滤器：
- 精确匹配：`{ category: "error" }`
- 比较运算：`{ confidence: { gte: 0.8 } }`
- 列表成员：`{ tags: { in: ["pattern", "constraint"] } }`
- 逻辑组合：`{ AND: [...] }`, `{ OR: [...] }`
- 文本搜索：`{ content: { contains: "migration" } }`
- 通配符：`{ user_id: "*" }`

---

## 5. 内部数据流

### memory.add() 处理流程

```
输入 messages → LLM 提取 facts → 生成 embeddings
    → 搜索已有相似 memories → LLM 决策 (ADD/UPDATE/DELETE/NONE)
    → 并行写入: Vector Store + Graph Store (optional) + History DB
    → 返回操作结果 + memory IDs
```

### memory.search() 处理流程

```
查询文本 → 生成 query embedding → Vector similarity 搜索
    → Reranking (optional) → Graph relationship 查询 (optional)
    → 返回排序结果
```

---

## 6. Provider 支持

### LLM Providers（15+）

| Provider | 适合场景 | 备注 |
|----------|----------|------|
| **OpenAI** | 默认首选 | `gpt-4.1-nano`（便宜快速） |
| **Anthropic** | Claude 生态 | 需 `@anthropic-ai/sdk` peer dep |
| **Groq** | 速度优先 | `llama-3.1-70b-versatile` |
| **Ollama** | 完全本地 | ⚠️ 有已知 static require bug (#3857) |
| Google AI / Gemini | Google 生态 | — |
| AWS Bedrock | AWS 部署 | — |

### Embedding Providers（11+）

OpenAI `text-embedding-3-small`（默认，1536 维）、Ollama、HuggingFace、Google AI 等。

### Vector Store Providers（22+）

| Provider | 适合场景 | 备注 |
|----------|----------|------|
| **In-memory** | 开发 / 小规模 | 默认，进程重启数据丢失 |
| **Qdrant** | 生产推荐 | Docker 一行命令 |
| **PGVector** | 已有 PostgreSQL | 需 `pg` peer dep |
| **better-sqlite3** | 嵌入式 | 需 peer dep |

---

## 7. MCP Server 集成

### 方案 A：官方 @mem0/mcp-server（npm）

```bash
claude mcp add --scope user --transport stdio mem0 \
  --env MEM0_API_KEY=m0-xxx \
  -- npx @mem0/mcp-server
```

- 依赖 mem0 云 API（需 API key）
- 暴露 `add_memory` 和 `search_memory` 工具
- 最简单的集成方式

### 方案 B：社区 mem0-mcp-selfhosted

```bash
claude mcp add --scope user --transport stdio mem0 \
  --env MEM0_QDRANT_URL=http://localhost:6333 \
  --env MEM0_EMBED_URL=http://localhost:11434 \
  --env MEM0_EMBED_MODEL=bge-m3 \
  -- uvx --from git+https://github.com/elvismdev/mem0-mcp-selfhosted.git mem0-mcp-selfhosted
```

- 完全本地：Qdrant + Ollama
- 11 个 MCP tools（add/search/get/update/delete/list_entities/graph）
- 零云依赖（embedding 用本地 Ollama）
- 需要 Docker（Qdrant + Ollama）

### 方案 C：CLAUDE.md 指令（最简）

在 `~/.claude/CLAUDE.md` 中添加指令让 Claude Code 主动调用 mem0 MCP：

```markdown
## MCP Servers
- **mem0**: Persistent memory. At session start, search_memories for context.
  Use add_memory for architecture, conventions, debugging insights.
```

---

## 8. 已知问题

| Issue | 严重度 | 影响 | Workaround |
|-------|--------|------|------------|
| **#3857 Static require('ollama')** | 高 | 不装 `ollama` 包时 import `mem0ai/oss` 会报错 | `npm install ollama`（即使不用 Ollama provider） |
| **Ollama embed API mismatch** | 中 | Ollama 0.17+ 的 API 变了 | 不用 Ollama embedding 就没影响 |
| **Vector dimension mismatch** | 中 | Ollama embedder 默认 768 维但 Qdrant 创建 1536 | 手动设 `dimension: 768` |
| **Telemetry 默认开启** | 低 | PostHog 追踪 | `MEM0_TELEMETRY=false` |

### #3857 的重要性

这是 Node SDK 最大的已知坑：`mem0ai/oss` 的 bundle 文件里静态 `require("ollama")`，即使你不用 Ollama provider 也会在 import 时尝试加载。解决方案：

```bash
# 安装 ollama 包作为 no-op（不需要运行 Ollama 服务）
npm install ollama
```

或等官方修复（改为 dynamic import）。

---

## 9. Flywheel 集成方案评估

### 方案 1：SDK 集成（推荐）

mem0 OSS SDK 直接嵌入 Flywheel TypeScript 代码。

```
Session 结束 → Blueprint 收集 session context
    → memory.add(messages, { user_id: projectName, run_id: executionId })
    → mem0 自动: LLM 提取 → embedding → 去重 → 存储

Session 开始 → Blueprint 组装 prompt
    → memory.search(issueTitle, { user_id: projectName })
    → 注入 <project_memory> block 到 Claude Code prompt
```

**优点**：
- 完全控制调用时机和数据流
- 可以用 Flywheel 已有的 session/event 数据
- 不需要额外进程

**缺点**：
- 需要 OpenAI API key（LLM + embedding）
- 集成代码 ~100-150 LOC

### 方案 2：MCP Server 集成

让 Claude Code session 自己通过 MCP 读写 memory。

```
Claude Code 启动 → MCP mem0 server 连接
    → Claude Code 自动 search_memories (via CLAUDE.md 指令)
    → 工作过程中 add_memory
    → Session 结束时记忆已写入
```

**优点**：
- Claude Code 原生支持 MCP
- 不需要 Flywheel 写集成代码
- Claude Code 可以自主决定存什么

**缺点**：
- 需要 Docker（Qdrant + Ollama）或 mem0 云 API key
- Claude Code 可能忘记存/存错东西（不受控）
- 每个 Claude Code session 都要启动 MCP server

### 方案 3：混合（推荐考虑）

SDK + MCP 双路：
- **Flywheel SDK**：Session 结束后自动用 `memory.add()` 存结构化摘要（受控）
- **MCP Server**：Claude Code session 内可以用 `search_memories` 查历史（自助）

---

## 10. LLM Provider 选择

Flywheel 当前环境：
- Claude Max 订阅（CLI 用，非 API）
- OpenAI Codex 订阅（CLI 用）
- 需要确认：是否有 OpenAI API key（用于 mem0 的 fact extraction + embedding）

### 推荐配置

```typescript
const memory = new Memory({
  llm: {
    provider: 'openai',
    config: {
      model: 'gpt-4.1-nano',  // 最便宜的 fact extraction
      apiKey: process.env.OPENAI_API_KEY,
    }
  },
  embedder: {
    provider: 'openai',
    config: {
      model: 'text-embedding-3-small',  // 1536 维，$0.02/1M tokens
      apiKey: process.env.OPENAI_API_KEY,
    }
  },
  vectorStore: {
    provider: 'memory',  // Step 1: in-memory；Step 2: 换 Qdrant
    config: { collectionName: 'flywheel-memories' }
  },
  historyDbPath: '.flywheel/memory-history.db',
});
```

**成本估算**：
- Fact extraction: gpt-4.1-nano ~$0.001/session
- Embedding: text-embedding-3-small ~$0.0001/session
- 总计: < $0.01/session

### 备选：Anthropic provider

如果有 Anthropic API key：

```typescript
llm: {
  provider: 'anthropic',
  config: {
    model: 'claude-3-haiku-20241022',
    apiKey: process.env.ANTHROPIC_API_KEY,
  }
}
```

---

## 11. 与原 v0.3 Exploration 的差异

| 维度 | 原方案（自写） | 新方案（mem0 SDK） |
|------|---------------|-------------------|
| Memory extraction | 自写 Haiku prompt + 解析 | mem0 内置 LLM extraction |
| Dedup | 自写 content_hash | mem0 内置 vector similarity + LLM 判断 |
| Storage | 自写 JSON → SQLite | mem0 in-memory / Qdrant / PGVector |
| Retrieval | 自写三层分级检索 | mem0 vector search + reranker |
| Salience 排序 | 自写 memU 公式 | mem0 vector similarity (无 salience 但有 reranker) |
| History/审计 | 自写 | mem0 内置 SQLite history |
| Code 量 | ~200 LOC 核心 + ~300 LOC 集成 | ~100 LOC 集成（调 SDK） |
| 维护成本 | 全部自维护 | 社区维护（60k stars） |

**丢失的能力**：
- memU 的 salience 排序公式（reinforcement + recency decay）
- 三层分级检索（route → category → item）的 early exit 优化
- deer-flow 的 debounced write queue

**获得的能力**：
- Graph memory（Neo4j，可选）
- 22+ vector store backends
- Metadata filtering
- Reranking
- MCP server 现成可用
- Custom extraction prompt

---

## 12. 推荐实施路径

### Step 1：最小可用集成

1. `pnpm add mem0ai ollama`（ollama 是 workaround #3857）
2. 新建 `packages/edge-worker/src/memory/mem0-client.ts` — 封装 Memory 初始化
3. `Blueprint.run()` 结束后调 `memory.add()` 存 session 摘要
4. `Blueprint.run()` 开始前调 `memory.search()` 注入 prompt
5. 存储：in-memory vector + SQLite history
6. LLM：OpenAI gpt-4.1-nano

### Step 2：持久化 + 生产化

1. Vector store 从 in-memory 换到 Qdrant（Docker 一行命令）
2. 添加 MCP server 让 Claude Code 自助查 memory
3. Custom extraction prompt 针对 Flywheel 场景优化

### Step 3：高级功能

1. Graph memory（Neo4j）— 记录 issue 间因果关系
2. Reranker — 提升检索精度
3. 多 project 隔离（user_id = project）
4. Memory 仪表盘（Dashboard 扩展）

---

## 13. Open Questions

1. **OpenAI API key**：Flywheel 环境是否有 `OPENAI_API_KEY`？mem0 OSS 模式至少需要一个 LLM provider 做 fact extraction + embedding。
2. **进程重启数据丢失**：in-memory vector store 在 TeamLead 重启后丢失。Step 1 是否可接受？或者直接从 Qdrant 开始？
3. **Custom extraction prompt**：是否需要针对 Flywheel 定制 fact extraction 提示词？（mem0 默认 prompt 是面向对话场景的，Flywheel 需要提取的是"session 做了什么、遇到什么错误、学到什么 pattern"）
4. **mem0 MCP vs SDK**：优先 SDK 集成（Flywheel 控制）还是 MCP（Claude Code 自助）？还是双路？

---

## Sources

- [mem0 Node SDK Quickstart](https://docs.mem0.ai/open-source/node-quickstart)
- [mem0 Open Source Overview](https://docs.mem0.ai/open-source/overview)
- [mem0 Installation & Setup (DeepWiki)](https://deepwiki.com/mem0ai/mem0/1.2-installation-and-setup)
- [mem0 Metadata Filtering (DeepWiki)](https://deepwiki.com/mem0ai/mem0/11.4-metadata-filtering)
- [mem0 Custom Categories & Instructions (DeepWiki)](https://deepwiki.com/mem0ai/mem0/10.2-custom-categories-and-instructions)
- [mem0 Custom Update Memory Prompt](https://docs.mem0.ai/open-source/features/custom-update-memory-prompt)
- [mem0ai npm package](https://www.npmjs.com/package/mem0ai)
- [mem0 GitHub](https://github.com/mem0ai/mem0)
- [mem0 LLM Providers](https://docs.mem0.ai/llms.txt)
- [Self-hosted mem0 MCP for Claude Code](https://dev.to/n3rdh4ck3r/how-to-give-claude-code-persistent-memory-with-a-self-hosted-mem0-mcp-server-h68)
- [Add Memory to Claude Code with Mem0](https://mem0.ai/blog/claude-code-memory)
- [@mem0/mcp-server npm](https://www.npmjs.com/package/@mem0/mcp-server)
- [Issue #3857: Static require('ollama')](https://github.com/mem0ai/mem0/issues/3857)
