# Research: Memory Architecture — memU + deer-flow 模式调研

> 来源：NevaMind-AI/memU, bytedance/deer-flow
> 影响范围：Phase 3（Auto-Loop + Memory）、Phase 5（Decision Intelligence）
> 状态：研究完成，待 architecture 整合

## 1. 背景

Flywheel Phase 3 规划了 per-project 持久记忆系统（`.flywheel/` 目录 + SQLite + sqlite-vec）。本研究调研了两个成熟的记忆实现，提取可直接复用的模式。

## 2. memU 的三层实体模型

### 数据模型

```
Resource（原始数据）
  ├── url, modality (conversation|document|image|video|audio)
  ├── local_path, caption
  └── embedding: float[]

MemoryItem（原子记忆）
  ├── resource_id → FK(Resource)
  ├── memory_type: profile|event|knowledge|behavior|skill|tool
  ├── summary: string（< 30 词）
  ├── embedding: float[]
  ├── happened_at: datetime
  └── extra: { content_hash, reinforcement_count, last_reinforced_at, ref_id }

MemoryCategory（类别/目录）
  ├── name, description
  ├── embedding: float[]
  └── summary: string（LLM 自动生成，~400 字）

CategoryItem（多对多关联）
  ├── item_id → FK(MemoryItem)
  └── category_id → FK(MemoryCategory)
```

### 适配 Flywheel 的数据模型

```typescript
// .flywheel/ 目录下的 SQLite schema

interface DecisionResource {
  id: string;
  type: 'issue' | 'session' | 'pr' | 'slack_thread';
  projectId: string;          // scope 字段
  content: string;
  embedding: number[] | null;
  createdAt: string;
}

interface DecisionItem {
  id: string;
  resourceId: string;         // FK → Resource
  type: 'pattern' | 'error' | 'preference' | 'constraint' | 'decision';
  summary: string;            // "GeoForge3D migration PRs should include rollback script"
  embedding: number[] | null;
  extra: {
    content_hash: string;           // SHA256 去重
    reinforcement_count: number;    // 被验证/复现的次数
    last_reinforced_at: string;
    confidence: number;             // 0-1
  };
}

interface DecisionCategory {
  id: string;
  name: string;               // "deployment" | "testing" | "code_style" | "architecture"
  description: string;
  summary: string;            // LLM 维护的类别摘要
  embedding: number[] | null;
}
```

## 3. Salience 排序公式（memU）

```typescript
// 直接从 Python 移植
function salienceScore(
  similarity: number,          // cosine similarity (0-1)
  reinforcementCount: number,  // 被强化的次数
  daysSince: number,           // 距离上次强化的天数
  halfLifeDays = 30            // 半衰期（天）
): number {
  const reinforcementFactor = Math.log(reinforcementCount + 1);
  const recencyFactor = Math.exp(-0.693 * daysSince / halfLifeDays);
  return similarity * reinforcementFactor * recencyFactor;
}
```

**直觉**：重复出现的模式 → 分数更高（log 增长，不会失控）。太旧的历史 → 自然衰减（半衰期 30 天，可调）。

## 4. Content Hash 去重（memU）

```typescript
function computeContentHash(summary: string, type: string): string {
  const normalized = `${type}:${summary.toLowerCase().replace(/\s+/g, ' ').trim()}`;
  return crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 16);
}

// 使用：每次提取新 pattern 前检查 hash
// 如果已存在 → reinforcement_count++ 而不是创建新条目
```

## 5. deer-flow 的 Memory JSON Schema

```json
{
  "user": {
    "workContext": { "summary": "...", "updatedAt": "" },
    "personalContext": { "summary": "...", "updatedAt": "" },
    "topOfMind": { "summary": "...", "updatedAt": "" }
  },
  "history": {
    "recentMonths": { "summary": "...", "updatedAt": "" },
    "earlierContext": { "summary": "...", "updatedAt": "" },
    "longTermBackground": { "summary": "...", "updatedAt": "" }
  },
  "facts": [
    {
      "id": "fact_xxx",
      "content": "...",
      "category": "preference|knowledge|constraint|decision",
      "confidence": 0.9
    }
  ]
}
```

### 适配 Flywheel 的 `.flywheel/memory.json`

```json
{
  "project": {
    "codebaseContext": { "summary": "Monorepo, React frontend + FastAPI backend", "updatedAt": "" },
    "activeWork": { "summary": "Working on v3.15.0 multi-deployment isolation", "updatedAt": "" },
    "recentDecisions": { "summary": "Switched from Docker Compose to Kubernetes", "updatedAt": "" }
  },
  "history": {
    "recentSessions": { "summary": "Last 5 sessions: GEO-66 fix, GEO-63 deploy...", "updatedAt": "" },
    "patterns": { "summary": "Common failures: missing env vars, schema migration...", "updatedAt": "" },
    "longTermContext": { "summary": "Project started Aug 2025, 130+ PRs merged...", "updatedAt": "" }
  },
  "facts": [
    { "id": "f001", "content": "Always run alembic upgrade after schema changes", "category": "constraint", "confidence": 0.95 },
    { "id": "f002", "content": "Frontend tests require VITE_API_URL env var", "category": "knowledge", "confidence": 0.9 }
  ]
}
```

## 6. deer-flow 的 Memory Update Prompt

关键文件：`/tmp/deer-flow/backend/src/agents/memory/prompt.py`

这个 prompt 指导 LLM 如何从对话中：
1. 提取结构化 facts（category + confidence）
2. 更新各层级 summary（不是覆盖，是增量合并）
3. 删除过期或被推翻的 facts
4. 保持 summary 的压缩性（不超过目标长度）

**可以直接拷贝翻译**，用于 Flywheel session 结束后的记忆提取。

## 7. 三层分级检索（memU）

```
query
  ↓ route_intention（LLM 判断是否需要检索）
  ↓ 不需要 → 返回，0 成本
  ↓
category recall（embedding 搜索 → 返回 category summary）
  ↓ sufficiency_check（LLM 判断是否够了）
  ↓ 够了 → 返回 summary
  ↓
item recall（embedding 搜索具体 items）
  ↓ sufficiency_check
  ↓ 够了 → 返回 items
  ↓
resource recall（原始文档片段）
```

**Token 节省**：每层有提前退出机制。简单查询只触发 category 层（~100 token），复杂查询才深入到 resource 层。

## 8. 实现建议

### Phase 3 实现路径

**Step 1**：`.flywheel/memory.json`（纯 JSON，类似 deer-flow schema）
- 每个 session 结束后，用 Haiku 提取 facts + 更新 summaries
- 原子写入（tempfile + rename）
- Debounced queue（30s 防抖）

**Step 2**：`.flywheel/memory.db`（SQLite + sqlite-vec）
- 迁移到三层实体模型（Resource/Item/Category）
- Salience 排序检索
- content_hash 去重

**Step 3**：Context injection
- Blueprint 生成 prompt 前，自动检索相关记忆
- 注入 `<project_memory>` block 到 Claude Code session

### 不建议直接采用的部分

- **memU 的 LLM 自动类别分配**：让 LLM 在提取时决定类别不够确定性。建议用规则或 embedding 相似度阈值
- **memU 的 Rust `_core` 扩展**：当前是空壳（仅 `hello_from_bin()`）
- **memU 的 `dedupe_merge` 步骤**：自己都是 placeholder，需要自己实现

## 9. Follow-up Session 建议

### Session R2: Memory System Design

**目标**：为 Flywheel Phase 3 设计完整的记忆系统 spec

**输入**：
- 本研究文档
- memU 源码（`/tmp/memU/src/memu/`）
- deer-flow memory prompt（`/tmp/deer-flow/backend/src/agents/memory/prompt.py`）
- Flywheel 当前 MEMORY.md 格式

**输出**：
- `doc/exploration/new/v0.3-memory-system.md`
- `.flywheel/memory.json` schema 定义
- Memory extraction prompt（中文版，适配 Flywheel 场景）
- SQLite schema（Phase 3 Step 2）

**预计工作量**：1 个 session，约 2-3 小时

### Session R2b: Memory Prompt 翻译与适配

**目标**：将 deer-flow 的 `MEMORY_UPDATE_PROMPT` 适配到 Flywheel 场景

**输入**：
- deer-flow prompt 原文
- Flywheel 项目特性（Linear issue、git commit、Claude Code session log）

**输出**：
- `packages/edge-worker/src/prompts/memory-update.ts`
- 测试用例（给定 session log → 期望的 memory update）
