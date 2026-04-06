# Exploration: Runtime Forum Tag 更新 — GEO-167

**Issue**: GEO-167 (Runtime Forum Tag 更新：status 变更后自动替换 tag)
**Date**: 2026-03-16
**Depth**: Standard
**Mode**: Technical
**Status**: final

## 0. Problem Statement

v1.2.0 (GEO-163) 的 Discord Forum Channel 只在创建 Forum Post 时 apply 初始 tag（如 `in-progress`），后续 session status 变更不会更新 tag。CEO 在 Forum Channel 按 tag 过滤时完全不准——已完成的 issue 仍显示 `in-progress`。

两个缺口：
1. **OpenClaw `channelEdit` 工具不支持 per-post `appliedTags`**：`channelEdit` 支持频道级 `availableTags`（定义有哪些 tag），但不支持 per-thread `appliedTags`（设置帖子 tag）。`threadCreate` 支持 `appliedTags` 但仅限创建时
2. **Bridge action handler 无 post-action hook**：`/api/actions/{approve|reject|defer|retry|shelve}` 成功后只改 StateStore 状态，不通知 OpenClaw

## 1. Affected Files and Services

| File/Service | Impact | Notes |
|-------------|--------|-------|
| `packages/teamlead/src/bridge/actions.ts` | modify | 添加 post-action hook notification |
| `packages/teamlead/src/bridge/hook-payload.ts` | modify | HookPayload 可能需要扩展字段 |
| `packages/teamlead/src/bridge/event-route.ts` | 不变 | 已有 hook notification（session_started/completed/failed） |
| OpenClaw `send.types.ts` | modify | `DiscordChannelEdit` 加 `appliedTags?: string[]` |
| OpenClaw `send.channels.ts` | modify | PATCH body 加 `applied_tags` |
| OpenClaw `discord-actions-guild.ts` | modify | `channelEdit` case 解析 `appliedTags` 参数 |
| OpenClaw `handle-action.guild-admin.ts` | modify | `channel-edit` case 传递 `appliedTags` |
| `~/clawdbot-workspaces/product-lead/SOUL.md` | modify | 添加 tag 更新行为指令 |
| `~/clawdbot-workspaces/product-lead/TOOLS.md` | modify | 文档化 `channelEdit` 的 `appliedTags` 参数 |

## 2. Architecture Constraints

### 现有 Hook 通知覆盖情况

| 触发源 | Event Type | Hook 发送？ | Agent 知道状态变了？ |
|--------|-----------|------------|-------------------|
| Orchestrator 发 event | `session_started` | ✅ | ✅ |
| Orchestrator 发 event | `session_completed` | ✅ | ✅ |
| Orchestrator 发 event | `session_failed` | ✅ | ✅ |
| HeartbeatService | `session_stuck` | ✅ | ✅ |
| HeartbeatService | `session_orphaned` | ✅ | ✅ |
| CEO 通过 Agent 执行 action | approve/reject/defer/retry/shelve | ❌ | ❌（无 hook） |

**关键发现**：Orchestrator 触发的状态变更已有 hook 覆盖，Agent 只缺「执行 action 后的自我感知」和「更新 tag 的工具」。

### Discord API 支持

Discord `PATCH /channels/{thread_id}` **确认支持** `applied_tags` 字段（Forum thread only）。这是标准 REST API，已被 Discord 官方文档记录。

### OpenClaw 现状（代码验证）

- **工具名**：`channelEdit`（非 `thread-edit`，之前 SOUL.md/TOOLS.md 的工具名有误）
- **`appliedTags` 创建时支持**：`threadCreate` 已支持 `appliedTags` 参数（`send.types.ts` line 72-81）
- **`appliedTags` 编辑时不支持**：`DiscordChannelEdit` 类型缺少 `appliedTags` 字段
- **改动量**：4 个文件，每处 2-3 行（Low effort）
- **已有 issue**：OpenClaw #33691（`channel-edit / thread-create should support applied_tags`）

### 状态 → Tag 映射（已定义）

| Status | Tag Name | Tag ID |
|--------|----------|--------|
| `running` | in-progress | `1482926857581232310` |
| `awaiting_review` | awaiting-review | `1482927658454089912` |
| `blocked` | blocked | `1482929080629329941` |
| `completed` / `approved` | completed | `1482929593001181214` |
| `failed` | failed | `1482930162491330783` |

## 3. Options Comparison

### Option A: Agent-driven + Post-action Hook（推荐）

**Core idea**: Bridge 在 action 执行成功后发 hook 通知 Agent，Agent 收到任何 status 变更 hook 后统一调用 `thread-edit` 更新 tag。

**变更**：
1. **OpenClaw `channelEdit`** — 4 文件加 `appliedTags` 参数（`send.types.ts`, `send.channels.ts`, `discord-actions-guild.ts`, `handle-action.guild-admin.ts`）
2. **Bridge `actions.ts`** — action 成功后调用 `notifyAgent()` 发 post-action hook（复用 event-route 中已有的 `buildHookBody` + HTTP POST 逻辑）
3. **`hook-payload.ts`** — 新增 `action` 字段，event_type 用 `action_executed`
4. **SOUL.md** — Agent 收到任何包含 status 变更的 hook 后，查 thread_id → 调用 `channelEdit` 更新 tag，失败时重试
5. **TOOLS.md** — 文档化 `channelEdit` 的 `appliedTags` 参数

**Pros**：
- 统一架构：所有状态变更（orchestrator + action）都走 hook → agent → Discord
- Agent 可以在更新 tag 的同时发一条状态变更消息（e.g. "✅ GEO-167 已批准"）
- 解耦：Bridge 不需要 Discord API 凭据

**Cons**：
- 依赖 Agent 正确执行 tag 更新（LLM 可能偶尔不执行）
- 额外延迟：hook → agent 处理 → Discord API

**Effort**: Small-Medium（Bridge 改动 ~30 LOC，OpenClaw 需确认 thread-edit 扩展难度）

### Option B: Agent 自感知（无 post-action hook）

**Core idea**: Agent 执行 action 后，直接从 HTTP response 推断新状态并更新 tag。Orchestrator 事件已有 hook 覆盖。不需要 Bridge 改动。

**变更**：
1. **OpenClaw** — 同 Option A（`thread-edit` + `appliedTags`）
2. **SOUL.md** — 两套逻辑：(a) 收到 orchestrator hook 时更新 tag；(b) 自己执行 action 后立即更新 tag
3. **TOOLS.md** — 同 Option A

**Pros**：
- Bridge 零改动
- 更快（action 后立即更新，不走 hook 绕路）

**Cons**：
- Agent 需要两套 tag 更新路径（hook-triggered vs self-triggered），增加 SOUL.md 复杂度
- 如果有任何 Bridge 外部直接改状态的路径（如运维手动改 DB），tag 不会更新
- Agent 是 LLM，两套逻辑更容易遗漏

**Effort**: Small（仅 OpenClaw 工具 + SOUL.md）

### Recommendation: Option A

统一 hook 路径更健壮。Bridge 改动量小（复用已有 `buildHookBody` 逻辑），且 Agent 只需一套「收到 hook → 更新 tag」逻辑。维护成本低于 Option B 的双路径方案。

## 4. Clarifying Questions

### Q1: OpenClaw `thread-edit` 扩展
OpenClaw Gateway 的 `thread-edit` 工具是否已支持任意参数透传？还是需要改 OpenClaw 代码新增 `appliedTags` 支持？这决定是否有外部依赖。

### Q2: Post-action hook event_type
Action 触发的 hook 应该用什么 event_type？
- (a) `action_executed`（新类型，区分 orchestrator 事件）
- (b) 复用现有 event_type（如 `session_completed`），加 `action` 字段区分
- (c) `status_changed`（通用类型）

### Q3: Tag 更新失败容错
如果 Agent 收到 hook 但 `thread-edit` 调用失败（Discord API error），是否需要重试机制？还是 best-effort 即可（与现有 hook notification 一致）？

## 5. User Decisions

**Selected approach**: Option A — Agent-driven + Post-action Hook

### Q1: OpenClaw 工具扩展
**答**：需要改 OpenClaw 代码。工具名是 `channelEdit`（非 `thread-edit`）。4 个文件各加 2-3 行。已有 OpenClaw issue #33691 跟踪。Discord API 确认支持 PATCH `applied_tags`。

### Q2: Post-action hook event_type
**答**：使用 `action_executed`（新类型）。区分 orchestrator 事件，payload 包含 `action` 字段（approve/reject/defer/retry/shelve）和结果 `status`。

### Q3: Tag 更新失败容错
**答**：重试。Agent SOUL.md 中明确要求 tag 更新失败时重试（与现有 hook notification 的 best-effort 策略不同）。

## 6. Suggested Next Steps

- [ ] /research — 确认 OpenClaw 代码改动细节 + Bridge actions.ts 集成点
- [ ] /write-plan — 基于 Option A 写实现计划
- [ ] /implement — 分两个 repo：OpenClaw（channelEdit 扩展）+ Flywheel（post-action hook + SOUL.md/TOOLS.md）
