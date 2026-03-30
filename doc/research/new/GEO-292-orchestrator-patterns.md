# Research: Flywheel Orchestrator 模式 — 技术可行性分析 — GEO-292

**Issue**: GEO-292
**Date**: 2026-03-30
**Source**: `doc/exploration/new/GEO-292-orchestrator-patterns.md`

---

## 1. flywheel-comm 消息扩展可行性

### 1.1 现有 Schema

CommDB 已定义 4 种消息类型（`packages/flywheel-comm/src/db.ts`）：

```sql
CHECK(type IN ('question','response','instruction','progress'))
```

**`progress` 类型已定义但未实现。** 这意味着添加 pipeline 进度报告是 **零 schema 改动**。

### 1.2 现有 `send` 命令

```bash
flywheel-comm send --from <lead-id> --to <exec-id> "content text"
```

当前 `send` 命令硬编码为 `type='instruction'`（调用 `db.insertInstruction()`）。

**需要的改动**：
1. 添加 `--type` flag（默认 `instruction`，可选 `progress`）
2. 或新建 `flywheel-comm progress` 子命令

推荐方案：添加 `--type` flag，最小改动。

### 1.3 消息格式设计

Pipeline progress 消息的 content 字段使用 JSON：

```json
{
  "stage": "brainstorm",
  "status": "completed",
  "artifact": "doc/exploration/new/GEO-292-slug.md",
  "issueId": "GEO-292",
  "timestamp": "2026-03-30T04:30:00Z"
}
```

Stage 枚举（对齐 orchestrator 的 9 步 template）：
- `verify_env` — 环境检查
- `brainstorm` — 探索文档
- `research` — 技术研究
- `plan_review` — Plan + Design Review
- `implement` — 代码实现
- `code_review` — 代码审查
- `user_approval` — Annie 审批
- `ship` — 合并 PR
- `post_ship` — 归档 + 清理

### 1.4 Lead 侧消费

Lead 通过 inbox hook（PostToolUse `inbox-check.sh`）自动接收 Runner 消息。当前 hook 检查 `getUnreadInstructions()`，需要扩展为也检查 `progress` 类型消息。

**改动范围**：
- `inbox-check.sh`：添加 progress 消息检查（或统一为 `getUnreadMessages()`）
- Lead agent.md：添加 progress 消息处理行为

### 1.5 结论

**可行性: 高**。CommDB schema 已支持 progress 类型，只需：
1. `send` 命令添加 `--type` flag（~20 行 TypeScript）
2. inbox hook 扩展读取 progress 消息（~10 行 bash）
3. /spin 插入 progress reporting（~30 行 markdown）

## 2. /spin Skill 改造范围

### 2.1 当前结构

`/spin`（`.claude/commands/spin.md`，191 行）是一个 **模块化编排器**：

```
Step 0: Parse & Onboard (issue ID, worktree setup)
  ↓
Step 1: Detect Pipeline Stage (scan doc/ dirs)
  ↓
Step 2: Execute Pipeline (sequential sub-skills)
  brainstorm → research → write-plan → codex-design-review → implement
  ↓
Step 3: Archive + Cleanup (git mv docs)
```

每个阶段委托给独立 sub-skill（`/brainstorm`、`/research`、`/write-plan`、`/codex-design-review`、`/implement`）。

### 2.2 进度报告插入点

```mermaid
graph TD
    S0[Step 0: Parse] --> |"progress: verify_env started"| S1
    S1[Step 1: Detect Stage] --> |"progress: verify_env completed"| S2
    S2{Stage?} --> |brainstorm| B[/brainstorm]
    S2 --> |research| R[/research]
    S2 --> |plan| P[/write-plan]
    S2 --> |implement| I[/implement]

    B --> |"progress: brainstorm completed"| R2[/research]
    R2 --> |"progress: research completed"| P2[/write-plan]
    P2 --> |"progress: plan_review completed"| I2[/implement]
    I2 --> |"progress: implement completed"| CR[Code Review]
    CR --> |"progress: code_review completed"| PR[Create PR]
    PR --> |"progress: user_approval waiting"| DONE[Done]
```

**具体插入位置**（/spin Step 2 的每个 sub-skill 之间）：

```markdown
# 在 /spin Step 2 中，每执行一个 sub-skill 后添加：
if FLYWHEEL_EXEC_ID and FLYWHEEL_COMM_DB are set:
  flywheel-comm send --type progress --from $FLYWHEEL_EXEC_ID --to lead \
    '{"stage":"brainstorm","status":"completed","artifact":"<path>"}'
```

### 2.3 环境变量依赖

Runner 已通过 TmuxAdapter 注入：
- `FLYWHEEL_EXEC_ID` — 当前 execution ID
- `FLYWHEEL_COMM_DB` — CommDB 路径

/spin 可直接使用这些变量进行 progress reporting。

### 2.4 改造成本

| 改动 | 文件 | 行数 |
|------|------|------|
| 添加 progress 检测 | `.claude/commands/spin.md` | ~30 行 |
| 条件性发送（仅在 Runner 模式） | `.claude/commands/spin.md` | ~10 行 |
| 错误时发送 failed | `.claude/commands/spin.md` | ~10 行 |

**总计**: ~50 行 markdown 改动。/spin 本身是 prompt template，改动不需要编译。

## 3. Lead Agent 现有编排能力

### 3.1 现有 Runner 管理

Peter/Oliver agent.md 已有：
- 启动 Runner: `POST /api/runs/start`（GEO-274）
- 容量查询: `GET /api/runs/active`（GEO-267）
- Session 查询: `GET /api/sessions?leadId=<id>`
- Action 执行: `POST /api/actions/{action}`
- tmux 查看: `GET /api/sessions/:id/capture`

Simba agent.md 已有：
- Triage: 查询 Linear backlog → 按优先级分组
- 投递: 向 Peter/Oliver chat channel 发 triage 结果

### 3.2 缺失的编排能力

| 能力 | 状态 | Phase |
|------|------|-------|
| 批量 issue 扫描 → 自动 dispatch | 缺失（Simba 手动 triage） | Phase 1 |
| Runner pipeline 进度可见性 | 缺失（只看最终 status） | Phase 1 |
| 多 Runner 并行监控 | 部分（可查 active count，不知具体进度） | Phase 1 |
| Post-merge lifecycle (archive + MEMORY) | 缺失（由 Annie 手动或 orchestrator 执行） | Phase 1 |
| Sprint 级别状态持久化 | 缺失 | Phase 2 |
| Gate enforcement | 缺失 | Phase 3 |

### 3.3 Simba 的 Triage → Dispatch 路径

当前流程：
```
Annie 说 "triage" → Simba 查 Linear → 分组为 "马上做/本周/team" → Annie 确认 → Simba 告诉 Peter/Oliver
```

目标流程：
```
Cron/Annie 触发 → Simba 查 Linear → 自动判断优先级 → Simba 通知 Peter/Oliver dispatch → Lead 调用 runs/start
```

关键 Gap: Simba 目前只输出 triage 报告，不直接调用 `POST /api/runs/start`。Peter/Oliver 收到 triage 结果后也不自动 dispatch。

## 4. Bridge API 端点完整清单

### 现有端点（30+ routes）

**查询类**:
- `GET /api/sessions` — 按 leadId/status/limit 过滤
- `GET /api/sessions/:id` — 详情
- `GET /api/sessions/:id/history` — 执行历史
- `GET /api/sessions/:id/capture` — tmux 输出
- `GET /api/resolve-action` — 检查 action 可执行性
- `GET /api/runs/active` — 全局 Runner 容量

**Action 类**:
- `POST /api/actions/{action}` — approve/reject/defer/retry/shelve/terminate
- `POST /api/runs/start` — 启动 Runner
- `POST /api/sessions/:id/close-tmux` — 关闭 tmux

**Patrol/Standup**:
- `POST /api/patrol/scan-stale` — 扫描 stale session
- `POST /api/standup/trigger` — 触发日报

**Linear 代理**:
- `POST /api/linear/create-issue` — 创建 issue
- `PATCH /api/linear/update-issue` — 更新 issue
- `GET /api/linear/issues` — 查询 issue

**其他**:
- `POST /api/forum-tag` — 更新 Forum tag
- `POST /api/memory/search|add` — 记忆服务
- `GET /api/config/discord-guild-id` — Discord 配置
- `GET /health`, `GET /`, `GET /sse` — 健康/Dashboard/SSE

### Phase 1 需要新增的端点

**无。** Phase 1 的所有编排能力可以通过：
1. 现有 Bridge API（sessions, runs, actions, linear）
2. flywheel-comm progress 消息
3. Lead agent.md 行为升级

来实现，不需要新增 Bridge 端点。

## 5. 关键技术决策

### 5.1 Progress 消息方向

两个选项：
- **A: Runner → Lead**（通过 flywheel-comm，Runner 主动报告）
- **B: Lead → Bridge → Runner tmux**（Lead 轮询 tmux capture 推断进度）

**推荐 A**：Runner 主动报告更可靠，不依赖 tmux 输出解析。flywheel-comm 已有基础设施。

### 5.2 编排决策者

- **Simba** 做全局 triage（已有能力），输出带优先级的 dispatch 建议
- **Peter/Oliver** 各自接收建议，调用 `POST /api/runs/start` 执行 dispatch
- **Lead 自身** 监控自己 scope 的 Runner 进度（通过 flywheel-comm inbox）

### 5.3 Post-merge 责任

当前：Annie 手动 merge + orchestrator 归档
目标：Lead 在收到 approve 指令后执行完整 post-merge lifecycle

这需要 Lead 能访问 main repo（不是 worktree）来执行 git mv。Lead 已有 workspace（`~/Dev/GeoForge3D/.lead/<lead>/`），但 archive 操作需要在 repo root。

**解决方案**: Lead 切换到 repo root 执行 archive commands，然后切回 workspace。或使用 `git -C <repo-root>` prefix。

## 6. 总结

| 维度 | 评估 |
|------|------|
| flywheel-comm 改动量 | **小**（~30 行 TS + ~10 行 bash） |
| /spin 改动量 | **小**（~50 行 markdown） |
| Bridge API 改动量 | **零**（Phase 1） |
| Lead agent.md 改动量 | **中**（~100-150 行 markdown per lead） |
| 风险 | **低**（增量改动，不影响现有功能） |
| 总工期 | **2-3 天**（Phase 1） |
