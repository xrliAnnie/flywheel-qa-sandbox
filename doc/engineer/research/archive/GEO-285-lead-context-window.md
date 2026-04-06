# Research: Lead Context Window 管理 — GEO-285

**Issue**: GEO-285
**Date**: 2026-03-29 (updated from 2026-03-28)
**Source**: `doc/engineer/exploration/new/GEO-285-lead-context-window.md`

## 1. Claude Code Compact 机制深度调研

### Auto-Compact 行为

| 属性 | 值 |
|------|-----|
| 触发阈值 | ~95% context window（200K window → ~190K tokens） |
| 触发方式 | Claude Code harness 自动，模型不参与决策 |
| 执行过程 | 生成摘要 → 丢弃早期消息 → 从摘要继续 |
| 保留内容 | 最近的请求、关键代码片段、近期 tool 输出 |
| 丢失内容 | 早期详细指令、旧 tool 输出、累积的上下文细节 |
| CLAUDE.md/agent.md | **存活** — compact 后重新加载 |
| Session ID | **不变** — compact 在 session 内发生 |
| `--resume` | **可用** — 恢复 compact 后的状态 |

### `/compact` Slash Command

| 属性 | 值 |
|------|-----|
| 可用性 | Interactive 模式可用；`-p` (headless) 模式**不可用** |
| `--agent` 模式 | **理论上可用**（interactive session），但模型**无法编程调用** |
| 工作原理 | 用户侧命令，不是 tool — agent 看不到也无法触发 |

**结论**: Agent 无法主动 compact。这是 Claude Code 的根本限制。

### 环境变量控制

| 变量 | 功能 | 值 |
|------|------|-----|
| `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` | 设定 auto-compact 触发百分比 | 1-100，默认 ~95 |
| `CLAUDE_CODE_AUTO_COMPACT_WINDOW` | 覆盖 context capacity 计算值 | 最大=模型实际 window |
| `CLAUDE_CODE_DISABLE_1M_CONTEXT` | 禁用 1M context window | `1` |

**`CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` 行为**:
- 只能设**更低**（提前触发），不能设更高
- 设 70 = 在 70% context 时触发 compact
- 为 Lead 提供 ~30% 的安全缓冲

### Hooks

| Hook | 触发时机 | 能力 |
|------|---------|------|
| PreCompact | Compact 前 | 只读观测，不能阻止 compact |
| PostCompact | Compact 后 | 可执行脚本（如重发 bootstrap），exit code 被忽略 |

**PostCompact hook** 是最有价值的：compact 后可以自动重发 bootstrap 到 Discord，补充丢失的状态信息。

### 已知问题

- Agent teams 可能在 compaction 后丢失（GitHub anthropics/claude-code#23620）
- 没有环境变量向 hooks 暴露 context 使用量（GitHub anthropics/claude-code#34340）
- 模型无法查询自身 context 使用量（GitHub anthropics/claude-code#34879）

## 2. Session 大小实测

| Lead | Session 大小 | 估算 tokens | 消息数 |
|------|-------------|-------------|--------|
| Simba (cos-lead) | 185 KB JSONL | ~50-100K | 49 |
| Oliver (ops-lead) | 55 KB JSONL | ~15-30K | ~20 |
| Peter (product-lead) | 10 KB JSONL | ~3-5K | ~5 |

**增长率**: 活跃 Lead 约 50-100K tokens/天
**200K window**: 支持 2-4 天连续工作
**意义**: 不做任何管理，Lead 约 2-4 天就会触发 auto-compact

## 3. Session Rotation 作为 Compact 替代

### 核心洞察

Agent 无法主动 compact，但 supervisor 完全控制 session 生命周期。**Session rotation**（优雅结束 → fresh start + bootstrap）等同于"完全可控的 compact"。

### Rotation 信号机制

Lead 在 agent.md 中被教导：任务完成后调用 Bash tool 创建信号文件：
```bash
touch ~/.flywheel/claude-sessions/{project}-{lead}.rotate
```

Supervisor 后台 monitor 检测到文件 → SIGTERM Claude → 下一轮 fresh start。

**实现**: Supervisor 在 `wait` 同时运行后台 monitor，检测：
1. Rotation signal file 存在
2. Session 寿命超过 `MAX_SESSION_AGE_SECONDS`

每 60 秒检查一次，检测到条件后 SIGTERM Claude。

### PostCompact Hook

即使有 session rotation，auto-compact 仍可能在 rotation 前触发。PostCompact hook 覆盖此场景：

```bash
#!/bin/bash
# Re-send bootstrap after auto-compact
curl -s -X POST "$BRIDGE_URL/api/bootstrap/$FLYWHEEL_LEAD_ID" \
  -H "Authorization: Bearer $TEAMLEAD_API_TOKEN" \
  --max-time 10 || true
```

需要 claude-lead.sh export `FLYWHEEL_LEAD_ID` 环境变量让 hook 可用。

### Memory API 状态

现有 Bridge Memory API（mem0 + Supabase pgvector）：
- `POST /api/memory/add` — 存储记忆
- `POST /api/memory/search` — 搜索记忆
- Bootstrap 中 `memoryRecall: null` — 未接入

当前 Phase 不依赖 memory API，靠 bootstrap（active sessions + pending decisions + recent failures + recent events）足够恢复 Lead 状态。

## 4. 技术方案对比

| 方案 | 可行性 | 控制力 | 数据保留 | 复杂度 |
|------|--------|--------|---------|--------|
| Agent 自主 `/compact` | ❌ 不可行 | — | — | — |
| 早期 auto-compact (env var) | ✅ | 低 | 中 | 极低 |
| PostCompact hook + bootstrap | ✅ | 中 | 中 | 低 |
| Session rotation（定时） | ✅ | 高 | 高 | 中 |
| Session rotation（任务触发） | ✅ | 高 | 高 | 中 |
| 外部 token count 监控 | ❌ 不可行 | — | — | — |

**推荐**: 组合使用（层层防护）：
1. `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=70` — 安全网：提前 compact
2. PostCompact hook + bootstrap — 补救：compact 后恢复状态
3. Session rotation（定时 + 任务触发） — 主力：完全可控的 context 清理
4. Crash recovery — 最后防线：崩溃后重启
