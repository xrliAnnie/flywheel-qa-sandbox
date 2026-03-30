# Exploration: Lead Context Window 管理 — GEO-285

**Issue**: GEO-285 (Lead Context Window 管理 — crash recovery + proactive context management)
**Date**: 2026-03-29 (updated from 2026-03-28)
**Status**: Complete

## 问题定义

Lead agent（Peter, Oliver, Simba）是**长期运行的 Claude Code session**——通过 `claude --agent <lead-id> --channels discord` 启动，持续监听 Discord 消息、Bridge 事件，与 Annie 和 Runner 沟通。

**两个核心问题**:

1. **被动问题 — Crash Recovery**: Lead 可能因 context window 溢出、OOM、网络中断等原因崩溃。崩溃后需自动恢复。
2. **主动问题 — Proactive Context Management**: Lead 不应该等到 context 满了被动触发 auto-compact（可能丢失关键信息），而应该**主动管理 context 生命周期**——在合适的时机清理 context，在干净状态下继续工作。

## Context 填满路径

Lead context 被以下内容填满（每天 50-100K tokens）：
1. **Discord 消息历史** — Annie 的指令、Lead 间的讨论、triage 报告
2. **Bridge 事件** — Runner 的 session_completed/failed/stuck 事件
3. **Tool 调用结果** — Bridge API 响应、flywheel-comm 查询
4. **Bootstrap 数据** — 启动时注入的状态快照

200K token window 约支持 2-4 天连续工作。

## 现有机制分析

### Claude Code 内置机制
- **Auto-compact**: ~95% context 时自动触发压缩（不可控，可能丢关键 context）
- **`CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`**: 可设低阈值（如 70%）提前触发
- **`/compact`**: 用户侧命令，**agent 无法编程触发**
- **`--resume`**: 恢复已有 session（包括 compact 后的状态）
- **CLAUDE.md / agent.md**: compact 后重新加载（存活）
- **PostCompact hook**: compact 后可执行自定义脚本

### 关键限制
- Agent **无法主动触发** `/compact`（不是 tool，无 API）
- Agent **无法查询** 自身 context 使用量（无 token count API）
- 外部**无法监控** Claude Code 的 context 使用量

## 方案设计

### Part A: Crash Recovery Supervisor（已实现）

`claude-lead.sh` 作为 supervisor，包装 Claude Code 进程：
- 两层架构：one-time preflight + recovery loop
- 自动 session ID 管理（`uuidgen` + `--session-id`）
- Crash 后自动重启 + exponential backoff
- Resume 失败检测（<10s 快速退出 → 3 次后 fresh start）
- Graceful shutdown（SIGINT/SIGTERM 转发）
- 条件化 bootstrap（仅 fresh start 时发送）

### Part B: Proactive Context Management（新增）

核心思路：**既然 agent 无法主动 compact，那就用 session rotation 代替 compact**。

Session rotation = 优雅地结束当前 session → 保存关键记忆 → 启动全新 session + bootstrap。效果等同于 compact，但完全可控。

#### Annie 提出的两个触发策略

**策略 A — 定时 Rotation**:
- Supervisor 配置最大 session 寿命（如 `MAX_SESSION_AGE_HOURS=8`）
- 到时间后优雅重启：SIGTERM Claude → fresh start + bootstrap
- 适合：每天晚上清理，第二天干净状态开始

**策略 B — 任务触发 Rotation**:
- Lead 完成一段任务后，写入 rotation request 信号文件
- Supervisor 检测到信号 → SIGTERM Claude → fresh start + bootstrap
- 适合：一批 Runner 完成后清理，准备接新任务

**两者可共存**：定时是保底，任务触发是优化。

#### 实现机制

1. **Rotation Signal File**: Lead 写 `~/.flywheel/claude-sessions/{project}-{lead}.rotate` 触发 rotation
2. **Rotation Monitor**: Supervisor 后台检测信号文件 + 定时检测
3. **Pre-rotation Bootstrap**: Rotation 前自动发送 bootstrap 到 Discord（Lead 新 session 第一时间看到状态）
4. **`CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=70`**: 作为安全网，即使没有主动 rotation，auto-compact 也更早触发
5. **PostCompact Hook**: Auto-compact 后自动重发 bootstrap，补充可能丢失的状态
6. **Agent.md 行为规则**: 教 Lead 何时请求 rotation、如何保持 context 卫生

## 推荐方案: Part A + Part B

| 组件 | 描述 | 层 |
|------|------|-----|
| Crash recovery supervisor | 已实现的 restart loop | Shell |
| Session rotation（定时） | MAX_SESSION_AGE 后自动重启 | Shell |
| Session rotation（任务触发） | Signal file 触发重启 | Shell + Agent |
| Early auto-compact | `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=70` | Env |
| PostCompact hook | Auto-compact 后重发 bootstrap | Hook |
| Agent context hygiene | agent.md 行为规则 | Agent |

## 非目标

- 外部 token count 监控（Claude Code 不暴露 API）
- Agent 自主触发 `/compact`（不可行）
- 多 session 并行（Lead 始终单 session）
- Bridge 新 API endpoint（用现有 bootstrap API）

## 风险

| 风险 | 缓解 |
|------|------|
| Rotation 太频繁导致频繁丢 context | 定时 8h 保守阈值 + 任务触发由 Lead 自主判断 |
| Lead 不请求 rotation | 定时 rotation 作为保底 |
| PostCompact hook 不触发 | 定时 rotation 覆盖此场景 |
| Signal file 竞态 | Supervisor 原子检测并删除 |
