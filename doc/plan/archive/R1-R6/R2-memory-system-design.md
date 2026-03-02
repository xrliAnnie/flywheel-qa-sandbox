# Research Plan R2: Memory 架构设计 → Phase 3 记忆系统

> 优先级：🟡 Medium
> 影响 Phase：Phase 3（Auto-Loop + Memory）
> 输入：`doc/research/new/005-memory-architecture-survey.md`
> 预期产出：`doc/exploration/new/v0.3-memory-system.md`

## 目标

为 Flywheel Phase 3 设计完整的 per-project 记忆系统，整合 memU 的三层实体模型和 deer-flow 的 memory JSON schema + update prompt。

## 研究任务

### 1. 深入分析 memU 源码

- 读取 `/tmp/memU/src/memu/` 核心模块
- 重点分析：
  - `models.py` — Resource / MemoryItem / MemoryCategory 数据模型
  - `salience.py` — salience 排序实现
  - `retrieval.py` — 三层分级检索（route_intention → category → item → resource）
  - `storage/` — SQLite 后端实现
  - `dedup.py` — content_hash 去重逻辑
- 提取可直接移植到 TypeScript 的代码

### 2. 深入分析 deer-flow memory prompt

- 读取 `/tmp/deer-flow/backend/src/agents/memory/prompt.py`
- 提取 `MEMORY_UPDATE_PROMPT` 完整模板
- 分析 prompt 如何指导 LLM：
  - 提取结构化 facts（category + confidence）
  - 增量更新各层 summary（不是覆盖）
  - 删除过期/被推翻的 facts
  - 保持压缩性
- 翻译并适配到 Flywheel 场景（Linear issue、git commit、Claude Code session log）

### 3. 分析 deer-flow debounced 写入

- 读取 `/tmp/deer-flow/backend/src/agents/memory/` 完整目录
- 提取 `MemoryUpdateQueue` 实现（30s debounce + threading.Timer）
- 适配为 TypeScript 的 debounced 写入方案

### 4. 设计 Flywheel 记忆系统

基于以上分析，设计：

- **Step 1**: `.flywheel/memory.json`（纯 JSON，类似 deer-flow schema）
  - 每个 session 结束后，用 Haiku 提取 facts + 更新 summaries
  - 原子写入（tempfile + rename）
  - Debounced queue
- **Step 2**: `.flywheel/memory.db`（SQLite + sqlite-vec）
  - 迁移到三层实体模型
  - Salience 排序检索
  - content_hash 去重
- **Step 3**: Context injection
  - Blueprint 生成 prompt 前，自动检索相关记忆
  - 注入 `<project_memory>` block 到 Claude Code session

## 产出

### 主要文件
- `doc/exploration/new/v0.3-memory-system.md` — 完整的记忆系统设计

### 文件内容要求
1. **Architecture overview**（Mermaid 图）— 三层实体模型 + 检索流程
2. **Step 1 JSON schema** — `.flywheel/memory.json` TypeScript interface
3. **Step 2 SQLite schema** — CREATE TABLE 语句 + sqlite-vec 集成
4. **Memory extraction prompt** — 从 deer-flow 翻译适配的中文版
5. **Salience 排序公式** — 从 memU 移植的 TypeScript 实现
6. **content_hash 去重** — TypeScript 实现
7. **Context injection 方案** — 如何在 Blueprint 中注入记忆
8. **Migration path** — Step 1 → Step 2 → Step 3 的渐进式迁移

### 更新
- 更新 `MEMORY.md`：新增 Phase 3 设计决策

## 参考资料

- `doc/research/new/005-memory-architecture-survey.md`（已有研究摘要）
- `/tmp/memU/`（已 clone）
- `/tmp/deer-flow/`（已 clone）
- Flywheel 当前 MEMORY.md 格式（作为 Step 0 参考）
