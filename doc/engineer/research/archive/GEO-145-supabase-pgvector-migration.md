# Research: Supabase pgvector Migration — GEO-145

**Issue**: GEO-145 (v0.3-next: Memory Production Setup — Supabase pgvector)
**Date**: 2026-03-10
**Source**: `doc/engineer/exploration/new/v0.3-memory-system.md` (Appendix C3)

---

## 1. Executive Summary

mem0 OSS (`mem0ai/oss` v2.3.0) 内置 `provider: 'supabase'` 向量存储——**不是**原生 pgvector，而是通过 `@supabase/supabase-js` REST API 操作 Supabase 托管的 pgvector。迁移只需改配置（provider + 环境变量）+ 在 Supabase 上运行一次性 SQL migration。

**关键发现**：
- ✅ mem0 原生支持 Supabase provider（零自定义代码）
- ✅ Supabase free tier 500MB 足够（768-dim vector ~3KB，可存 ~150K 条记忆）
- ✅ Supabase Dashboard SQL Editor 直接查询记忆内容（满足 Annie 核心诉求）
- ⚠️ 表不会自动创建——需手动运行 SQL migration
- ⚠️ `@supabase/supabase-js` 未安装，需添加为依赖
- ⚠️ `match_vectors` RPC 函数中硬编码了表名 `memories`，tableName 配置必须匹配

---

## 2. mem0 Supabase Provider 源码分析

### 2a. Provider 架构

`VectorStoreFactory.create()` 支持 7 种 provider：
`memory` | `qdrant` | `redis` | **`supabase`** | `langchain` | `vectorize` | `azure-ai-search`

**关于 pgvector provider**：mem0 源码中实际存在 `pgvector.ts` 实现（支持直接 pg 连接 + 自动建表），但 **VectorStoreFactory 没有注册它**——是死代码。GitHub issue [#3491](https://github.com/mem0ai/mem0/issues/3491) 已追踪此问题（2025-09-22 开启，至今未修复）。PR #4244 尝试修复但被关闭。

**结论**：使用 `provider: 'supabase'`（已注册、已测试）而非尝试 patch pgvector provider。`supabase` provider 通过 REST API 操作。

### 2b. SupabaseDB 配置接口

```typescript
// 从 mem0ai@2.3.0 源码提取
interface SupabaseConfig {
  supabaseUrl: string;      // e.g. "https://xxx.supabase.co"
  supabaseKey: string;      // anon key or service role key
  tableName: string;        // 必须与 match_vectors 函数中的表名一致
  embeddingColumnName?: string;  // default: "embedding"
  metadataColumnName?: string;   // default: "metadata"
}
```

### 2c. SupabaseDB 核心方法

| 方法 | Supabase 调用 | 说明 |
|------|--------------|------|
| `insert()` | `client.from(tableName).insert()` | 写入向量 + metadata |
| `search()` | `client.rpc('match_vectors', ...)` | 余弦相似度搜索 |
| `get()` | `client.from(tableName).select().eq('id')` | 按 ID 查询 |
| `update()` | `client.from(tableName).update()` | 更新向量和 metadata |
| `delete()` | `client.from(tableName).delete()` | 删除单条 |
| `list()` | `client.from(tableName).select()` | 列表 + 过滤 |
| `initialize()` | 插入/删除 test_vector | 验证表和 extension 存在 |

### 2d. 初始化验证

`initialize()` 会尝试插入一个全零测试向量，如果失败则抛出错误并输出完整的 SQL migration 指令。**表不会自动创建。**

### 2e. History Store

mem0 同时支持 Supabase 作为 history store：

```typescript
historyStore: {
  provider: 'supabase',
  config: {
    supabaseUrl: '...',
    supabaseKey: '...',
    tableName: 'memory_history'  // default
  }
}
```

需要额外的 `memory_history` 表。当前 Flywheel 用本地 SQLite 文件存 history。

**建议**：History 也迁移到 Supabase，统一管理，Dashboard 可直接查看。

---

## 3. 所需 SQL Migration

以下 SQL 需在 Supabase SQL Editor 中运行一次。维度从默认的 1536 改为 **768**（匹配 gemini-embedding-001）。

```sql
-- 1. Enable pgvector extension
CREATE EXTENSION IF NOT EXISTS vector;

-- 2. Memories table (vectors + metadata)
CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  embedding vector(768),
  metadata JSONB,
  created_at TIMESTAMPTZ DEFAULT timezone('utc', now()),
  updated_at TIMESTAMPTZ DEFAULT timezone('utc', now())
);

-- 3. Memory migrations table (mem0 internal tracking)
CREATE TABLE IF NOT EXISTS memory_migrations (
  user_id TEXT PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT timezone('utc', now())
);

-- 4. Memory history table (audit log)
CREATE TABLE IF NOT EXISTS memory_history (
  id TEXT PRIMARY KEY,
  memory_id TEXT NOT NULL,
  previous_value TEXT,
  new_value TEXT,
  action TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT timezone('utc', now()),
  updated_at TIMESTAMPTZ,
  is_deleted INTEGER DEFAULT 0
);

-- 5. Similarity search RPC function
-- IMPORTANT: table name 'memories' must match tableName config
CREATE OR REPLACE FUNCTION match_vectors(
  query_embedding vector(768),
  match_count INT,
  filter JSONB DEFAULT '{}'::JSONB
)
RETURNS TABLE (
  id TEXT,
  similarity FLOAT,
  metadata JSONB
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    t.id::TEXT,
    1 - (t.embedding <=> query_embedding) AS similarity,
    t.metadata
  FROM memories t
  WHERE CASE
    WHEN filter::TEXT = '{}'::TEXT THEN TRUE
    ELSE t.metadata @> filter
  END
  ORDER BY t.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;

-- 6. HNSW index for fast cosine similarity search
CREATE INDEX IF NOT EXISTS memories_embedding_idx
ON memories USING hnsw (embedding vector_cosine_ops)
WITH (m = 16, ef_construction = 64);

-- 7. Metadata GIN index for JSONB filter queries
CREATE INDEX IF NOT EXISTS memories_metadata_idx
ON memories USING gin (metadata);
```

### 关键注意事项

- `match_vectors` 中 **硬编码了 `FROM memories t`**——`tableName` 配置必须设为 `"memories"`（或修改 RPC 函数）
- 维度 768 匹配 `gemini-embedding-001`（当前 MemoryService 使用）
- HNSW index 参数 `m=16, ef_construction=64` 适合中小规模数据集（<100K 条）

---

## 4. Supabase Free Tier 评估

| 资源 | Free Tier 限制 | Flywheel 预估用量 |
|------|---------------|----------------|
| 数据库大小 | 500 MB | 768-dim vector ~3KB/条 → ~150K 条记忆 |
| 连接数 | 60 (direct) | 1 daemon，远低于限制 |
| CPU/RAM | Shared / 0.5 GB | 足够 |
| 项目数 | 2 active | 需 1 个 |
| pgvector | 全功能可用 | ✅ |

**结论**：Free tier 完全满足 Flywheel 当前需求。

### 连接方式

```
postgresql://postgres:[PASSWORD]@db.<project-ref>.supabase.co:5432/postgres?sslmode=require
```

但 mem0 Supabase provider 使用 **REST API**（不是直接 pg 连接），所以需要的是：
- `SUPABASE_URL`: `https://<project-ref>.supabase.co`
- `SUPABASE_ANON_KEY`: Supabase anon/public key（Settings → API）

### Dashboard 数据查看

Supabase Dashboard 的 SQL Editor 支持：
- `SELECT * FROM memories ORDER BY created_at DESC LIMIT 50;` — 查看所有记忆
- `SELECT metadata->>'issue_id' as issue, metadata->>'app_id' as app, * FROM memories;` — 结构化查看
- `SELECT * FROM memory_history WHERE memory_id = '...' ORDER BY created_at DESC;` — 查看记忆变更历史

---

## 5. 代码变更清单

### 5a. 新增依赖

```bash
pnpm add -F edge-worker @supabase/supabase-js
```

### 5b. MemoryService 配置变更

**Before** (当前 — Qdrant):
```typescript
vectorStore: {
  provider: 'qdrant',
  config: {
    url: config.qdrantUrl,
    collectionName: 'flywheel-memories',
    dimension: 768,
  }
}
```

**After** (Supabase):
```typescript
vectorStore: {
  provider: 'supabase',
  config: {
    supabaseUrl: config.supabaseUrl,
    supabaseKey: config.supabaseKey,
    tableName: 'memories',  // must match match_vectors function
  }
}
```

注意：Supabase provider 不需要 `dimension` 配置（维度在 SQL 建表时指定）。

### 5c. History Store 变更

**Before**: 本地 SQLite (`historyDbPath`)
**After**: Supabase（统一到同一个 Supabase 项目）

```typescript
historyStore: {
  provider: 'supabase',
  config: {
    supabaseUrl: config.supabaseUrl,
    supabaseKey: config.supabaseKey,
    tableName: 'memory_history',
  }
}
```

### 5d. 类型接口变更

`MemoryServiceConfig`:
- 移除: `qdrantUrl: string`
- 新增: `supabaseUrl: string`, `supabaseKey: string`
- 移除: `historyDbPath: string`（不再需要本地文件）

`CreateMemoryServiceOpts`:
- 移除: `qdrantUrl?: string`
- 新增: `supabaseUrl?: string`, `supabaseKey?: string`
- 条件: 需要 `googleApiKey` + `supabaseUrl` + `supabaseKey` 都存在才启用

### 5e. 环境变量变更

**Before**:
```bash
GOOGLE_API_KEY=...
QDRANT_URL=http://localhost:6333
```

**After**:
```bash
GOOGLE_API_KEY=...
SUPABASE_URL=https://xxx.supabase.co
SUPABASE_ANON_KEY=eyJ...
```

### 5f. 受影响文件

| 文件 | 变更类型 |
|------|---------|
| `packages/edge-worker/src/memory/MemoryService.ts` | 重写 constructor |
| `packages/edge-worker/src/memory/types.ts` | 更新接口 |
| `packages/edge-worker/src/memory/createMemoryService.ts` | 更新 factory |
| `packages/edge-worker/package.json` | 添加 `@supabase/supabase-js` |
| `scripts/lib/setup.ts` | 更新 env var 引用 |
| `packages/edge-worker/src/__tests__/MemoryService.test.ts` | 更新测试 |
| `packages/edge-worker/src/__tests__/memory-e2e.test.ts` | 更新 E2E 测试 |

---

## 6. 测试策略

### 6a. Unit Tests（不需要 Supabase）

- MemoryService 构造函数接受 Supabase 配置
- `MemoryServiceTestConfig` 仍使用 `provider: 'memory'`（in-memory）
- createMemoryService 在缺少 SUPABASE_URL 或 SUPABASE_ANON_KEY 时返回 undefined

### 6b. Integration Tests（需要 Supabase）

- 标记为 `@live` 或 `@integration`，CI 中跳过
- 验证完整 flow：add → search → get → update → delete
- 验证 match_vectors RPC 正确返回相似度分数

### 6c. E2E Validation

手动验证：
1. 运行一个 test issue
2. 在 Supabase Dashboard SQL Editor 查看写入的记忆
3. 验证 searchAndFormat 返回相关记忆

---

## 7. 风险与缓解

| 风险 | 影响 | 缓解 |
|------|------|------|
| `match_vectors` 硬编码表名 | tableName 不匹配会搜索失败 | 使用 `memories` 作为 tableName |
| REST API 延迟 > 直接 pg | 搜索稍慢 | Flywheel 不是实时系统，可接受 |
| Supabase free tier 停机 | 记忆不可用 | graceful degradation 已实现 |
| 768-dim vs 1536-dim 不匹配 | 插入失败 | SQL migration 明确指定 768 |
| anon key 暴露 | 数据泄露 | 启用 RLS policies（后续优化） |

---

## 8. pgvector vs supabase Provider 对比

| 维度 | `provider: 'pgvector'` | `provider: 'supabase'` |
|------|----------------------|----------------------|
| Factory 注册 | ❌ 死代码，未注册 | ✅ 已注册 |
| 连接方式 | 直接 pg 连接 | REST API (`@supabase/supabase-js`) |
| 自动建表 | ✅ 全自动 | ❌ 需手动 SQL migration |
| 依赖 | `pg` | `@supabase/supabase-js` |
| 性能 | 更快（直连） | 稍慢（REST 开销） |
| 维护 | 需 pnpm patch | 零维护 |
| Supabase Dashboard | ✅ 同一个 DB | ✅ 同一个 DB |

**选择 `supabase`**：虽然 pgvector provider 技术上更优（直连、自动建表），但它是死代码，需要 patch mem0 包。Supabase provider 开箱即用，REST API 的延迟对 Flywheel（非实时系统）完全可接受。

---

## 9. 决策建议

1. **使用 `provider: 'supabase'`**（不是 raw pgvector）— 唯一已注册且可用的方式
2. **History 也迁移到 Supabase** — 统一管理，Dashboard 可查看完整审计日志
3. **tableName 固定为 `'memories'`** — 匹配 match_vectors 函数硬编码的表名
4. **维度 768** — 匹配 gemini-embedding-001
5. **先不做 RLS** — Flywheel 是内部工具，anon key 不暴露到公网
6. **保留 graceful degradation** — 缺少环境变量时自动禁用记忆系统
7. **未来升级路径** — 如果 mem0 修复 pgvector provider（issue #3491），可无缝切换到直连模式
