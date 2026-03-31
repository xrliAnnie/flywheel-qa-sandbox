# Research: Agent Rules Splitting Strategy — FLY-26

**Issue**: FLY-26
**Date**: 2026-03-30
**Source**: `doc/exploration/new/FLY-26-lead-rules-scalability.md`

---

## 1. 技术验证

### 1.1 `--append-system-prompt-file` 验证

| 测试 | 结果 |
|------|------|
| Flag 存在性 | ✅ `claude --help` 的 `--bare` 文档明确列出 `--append-system-prompt-file` |
| 基本功能 | ✅ 内容被注入 system prompt，agent 遵从规则 |
| 多文件叠加 | ✅ 可多次使用，内容按顺序追加 |
| 与 `--agent` 共存 | ✅ `--agent X --append-system-prompt-file Y` 正常工作，两者内容都生效 |
| 与 `--channels` 共存 | ✅ 不冲突（`--agent` + `--append-system-prompt-file` + `--channels` 三者可同时使用） |

### 1.2 `--add-dir` 验证

`--add-dir <dirs>` 添加额外目录用于 CLAUDE.md 自动发现和工具访问。Lead 可运行在隔离 workspace（`~/.flywheel/lead-workspace/`），同时通过 `--add-dir PROJECT/.lead/` 加载共享 CLAUDE.md。

Phase 1 不需要 `--add-dir`（`--append-system-prompt-file` 已足够），但 Phase 2 可能用到。

---

## 2. Agent.md 内容分析

### 2.1 行数统计

| Agent | 总行数 | 独有内容 | 与 Peter/Oliver 共享 | 三者共享 |
|-------|--------|---------|--------------------:|--------:|
| Peter (product-lead) | 490 | ~32 行 (身份) | ~328 行 | ~130 行 |
| Oliver (ops-lead) | 491 | ~34 行 (身份) | ~327 行 | ~130 行 |
| Simba (cos-lead) | 434 | ~274 行 (triage + task assignment) | 0 | ~130 行 |
| **合计** | **1,415** | | | |

### 2.2 Section-by-Section 分析

| Section | Peter | Oliver | Simba | 共享状态 | 唯一部分 |
|---------|-------|--------|-------|---------|---------|
| Frontmatter | 1-8 | 1-8 | 1-8 | 结构相同 | name, description |
| 核心身份 | 10-32 | 10-34 | 10-20 | 独有 | 名字/角色/Bot ID |
| Channel 隔离 | 34-45 | 35-46 | 21-28 | 结构共享 | Channel IDs |
| Core Channel 路由 | 46-56 | 47-57 | 29-43 | P/O 100% | Simba 简化版 |
| 沟通风格 | 57-66 | 58-67 | 44-52 | 95% | Simba 加 "全局视角" |
| 精准回答 | 67-83 | 68-84 | N/A | P/O 100% | Simba 无 |
| 事件处理 | 86-127 | 87-127 | 86-101 | P/O 100% | Simba 简化 |
| Bubble DOWN | 129-241 | 130-242 | N/A | P/O 100% | Simba 有 "任务分配" 替代 |
| 汇报风格 | 244-252 | 245-253 | N/A | P/O 100% | |
| Runner 通信 | 255-296 | 256-297 | N/A | P/O 100% | |
| Stage Monitoring | 297-342 | 298-343 | N/A | P/O 100% | |
| Escalation | 343-354 | 344-355 | N/A | P/O 100% | |
| Discord MCP | 359-364 | 360-365 | 320-325 | 100% | |
| Bridge API | 365-390 | 366-391 | 326-344 | P/O ~95% | leadId 不同; Simba 仅查询 |
| flywheel-comm | 391-402 | 392-403 | N/A | P/O 100% | |
| Channel IDs | 403-410 | 404-411 | 346-353 | 结构共享 | ID 值不同 |
| 记忆系统 | 413-478 | 414-479 | 356-421 | 100% | leadId 模板变量 |
| 限制 | 482-491 | 483-492 | 425-434 | ~90% | Simba 少 Runner 条目 |
| Triage | N/A | N/A | 104-297 | Simba 独有 | 194 行 |
| 任务分配 | N/A | N/A | 56-74 | Simba 独有 | |

### 2.3 关键发现

1. **Peter ↔ Oliver: ~95% 相同**。唯一差异是 leadId、channel IDs、角色名、领域描述。
2. **Simba 根本不同**: 不执行 action、不管 Runner、不做 Bubble DOWN。独有的 triage 系统 194 行。
3. **三者共享**: 沟通风格 + 记忆系统 + Discord MCP + 限制 ≈ 130 行。
4. **Peter/Oliver 共享但 Simba 无**: Bubble DOWN + Runner 通信 + Stage Monitoring + Escalation ≈ 270 行。

---

## 3. 分割策略

### 3.1 文件结构

```
.lead/
├── shared/
│   ├── common-rules.md              (~130 行: 沟通风格 + 记忆 + MCP + 限制)
│   └── department-lead-rules.md     (~270 行: Bubble DOWN + Runner + Stage + Escalation)
├── product-lead/
│   └── identity.md                  (~60 行: frontmatter + 身份 + channels + 精准回答 + 工具参考)
├── ops-lead/
│   └── identity.md                  (~60 行: 同结构，不同值)
└── cos-lead/
    └── identity.md                  (~300 行: frontmatter + 身份 + triage + 任务分配 + 工具参考)
```

### 3.2 claude-lead.sh 启动参数变化

**当前**:
```bash
CLAUDE_ARGS=(--agent "$LEAD_ID" --channels "plugin:discord@claude-plugins-official" --permission-mode bypassPermissions)
```

**Phase 1 后**:
```bash
CLAUDE_ARGS=(
  --agent "$LEAD_ID"
  --append-system-prompt-file "$PROJECT_DIR/.lead/shared/common-rules.md"
  --channels "plugin:discord@claude-plugins-official"
  --permission-mode bypassPermissions
)
# Peter/Oliver 额外加载 department-lead rules
if [[ "$LEAD_ID" != "cos-lead" ]]; then
  CLAUDE_ARGS+=(--append-system-prompt-file "$PROJECT_DIR/.lead/shared/department-lead-rules.md")
fi
```

### 3.3 参数化策略

identity.md 中需要硬编码的值（不同 Lead 不同）：
- `name:` / `description:` (frontmatter)
- Bot ID + 其他 Lead 的 ID 表
- Channel IDs (chat, forum, control)
- `leadId` 值（在 curl 命令中）
- 角色描述文字

共享文件中用 `$LEAD_ID` 环境变量引用的地方（如 curl 命令中的 `leadId`）：
- **不做模板替换**。shared-rules 中的 curl 示例用 `$LEAD_ID` 占位符，Lead 在执行时从环境变量中读取。
- `claude-lead.sh` 已经 `export LEAD_ID`，Claude Code session 中的 Bash 可直接使用。

### 3.4 Simba 特殊处理

Simba 的 identity.md 会比 Peter/Oliver 的大（~300 行 vs ~60 行），因为 triage 系统是 Simba 独有的。这是合理的——不应为了"对称"而把 triage 规则放到共享文件中。

Simba 不加载 `department-lead-rules.md`（不管 Runner、不执行 action）。只加载 `common-rules.md`。

---

## 4. 影响分析

### 4.1 Context Window 影响

| Lead | 当前 | Phase 1 后 | 变化 |
|------|------|-----------|------|
| Peter | 490 行 (agent.md) | 60 (identity) + 130 (common) + 270 (dept) = 460 行 | -6% |
| Oliver | 491 行 | 60 + 130 + 270 = 460 行 | -6% |
| Simba | 434 行 | 300 (identity) + 130 (common) = 430 行 | -1% |

**Phase 1 不减少 context window 占用**（总行数基本不变）。减少 context 是 Phase 2（MCP tools）的目标。Phase 1 的价值是消除重复维护。

### 4.2 维护影响

| 操作 | 当前 | Phase 1 后 |
|------|------|-----------|
| 改沟通风格 | 改 3 个文件 | 改 common-rules.md |
| 改 Bubble DOWN SOP | 改 2 个文件 | 改 department-lead-rules.md |
| 改记忆模板 | 改 3 个文件 | 改 common-rules.md |
| 改 Peter channel ID | 改 1 个文件 | 改 identity.md (不变) |
| 新增 Lead | 复制 490 行 + 全量修改 | 写 ~60 行 identity.md |
| 新增公共规则 | 改 2-3 个文件 | 改 1 个共享文件 |

### 4.3 风险

| 风险 | 概率 | 影响 | 缓解 |
|------|------|------|------|
| `--append-system-prompt-file` 被废弃 | 极低 | 低（5 分钟回退到 cat 合并） | 正式 flag，有文档 |
| 共享规则与身份规则边界模糊 | 中 | 低 | 明确的分类标准（见 3.1） |
| 环境变量 `$LEAD_ID` 在共享文件中的引用问题 | 低 | 中 | 测试验证；`claude-lead.sh` 已 export |
| Simba identity.md 仍然很长（~300 行） | 确定 | 低 | Phase 2 可进一步拆分 triage 到 MCP |
