# Exploration: Remove Discord Forum 概念 — FLY-163

**Issue**: FLY-163 (Remove forum channel concept from codebase + Discord)
**Date**: 2026-05-17
**Status**: Draft

## 背景 / Problem

Annie 完全不再使用 product-forum / ops-forum / QA forum 这些 Discord forum channel。FLY-91 之后，每个 Linear issue 对应一个 chat thread（在 `chatChannel` 里），这是唯一的 issue-level thread surface。

Annie 原话:
> 我现在其实完全不用 product forum 或者是 ops forum 这些 channel 了。可以完全把 forum 这个概念拿掉，不管是从我们的代码中，还是从 Discord 上面（包括 QA testing 里面的那些 forum channel），都不需要了。

目标:
- 从 Flywheel codebase 删除所有 Forum 相关代码 / 配置 / 测试
- 列出 Annie 需要手动删除的 Discord channel
- 解耦一个 forum-coupled 的 bug：`canSpawnRunners` 自动从 `Boolean(forumChannel)` 派生 — 删 forum 会副作用地把所有 lead 变成 spawn-disabled

## Scope 审计结果

### Forum-only 代码（整体删除）

| 文件 | 行数 | 角色 |
|------|------|------|
| `packages/teamlead/src/bridge/ForumPostCreator.ts` | 135 | session_started 时创建 Forum Post |
| `packages/teamlead/src/bridge/ForumTagUpdater.ts` | 119 | status change 时更新 forum thread tag + `postThreadStatusMessage` helper |
| `packages/teamlead/src/CleanupService.ts` | 137 | 24h idle 后自动 archive forum threads（只看 `conversation_threads` 表） |
| `packages/teamlead/src/__tests__/ForumPostCreator.test.ts` | — | 测试 |
| `packages/teamlead/src/__tests__/ForumTagUpdater.test.ts` | — | 测试 |
| `packages/teamlead/src/__tests__/CleanupService.test.ts` | 240 | 测试 |
| `POST /api/forum-tag` route in `bridge/plugin.ts:935-988` | 53 | 外部无调用方（grep 验证） |
| `POST /threads/upsert` + `GET /thread/:thread_id` in `bridge/tools.ts:267-328` | 62 | Forum-only thread binding API |
| `scripts/e2e-event-filter.ts` | — | ForumTagUpdater 的 e2e harness |

### Forum + Chat 并行代码（保留 chat 分支，删 forum 分支）

| 文件 | 涉及行号 | 怎么改 |
|------|----------|--------|
| `packages/teamlead/src/DirectEventSink.ts` | 122-175 (forum) / 177-230 (chat) | 删 forum 分支 + 删 `forumPostCreator?` / `forumTagUpdater?` 构造参数 + 删 `postThreadStatusMessage` 调用 |
| `packages/teamlead/src/bridge/event-route.ts` | 342-558 (forum) / 875+1131 (chat) | 同上 + 删 forum thread 继承逻辑 (466-518) |
| `packages/teamlead/src/bridge/EventFilter.ts` | 12-153 | 删 `updateForum` 字段，分类器只返回 priority + reason；删 forum-related reason 文案 (55-68) |
| `packages/teamlead/src/bridge/hook-payload.ts` | 16, 40-45 | 删 `forum_channel`、`forum_tag_update_result` 字段 |
| `packages/teamlead/src/bridge/mailbox-lead-runtime.ts` | 248-249 | 删 `Forum-Thread:` / `Forum:` 行 |
| `packages/teamlead/src/bridge/commdb-lead-runtime.ts` | 122-123 | 同上 |
| `packages/teamlead/src/bridge/actions.ts` | 67-145 | 删 `forumTagUpdater?` 参数 + tag update 分支 |
| `packages/teamlead/src/HeartbeatService.ts` | 345-367 | 删 `forum_channel` 注入 |
| `packages/teamlead/src/bridge/run-infra.ts` | 407-428 | 删 ForumPostCreator / ForumTagUpdater 构造 + 传参 |
| `packages/teamlead/src/bridge/plugin.ts` | 32-33, 422-528, 1605-1647, 1801-1803 | 删 imports、factory wiring、startup diagnostics |
| `packages/teamlead/src/bridge/runs-route.ts` | 395-468 | 删 `forumLink` 字段 + 相关 polling 简化 |
| `packages/teamlead/src/bridge/bootstrap-generator.ts` | — | 验证没有 forum 注入（chat thread 已独立） |

### Config / env

| 位置 | 改法 |
|------|------|
| `packages/teamlead/src/ProjectConfig.ts:5-9, 160-170` | 删 `LeadConfig.forumChannel` 字段 + validator |
| `packages/teamlead/src/ProjectConfig.ts:13-16, 219-246` | 删 `statusTagMap`（per-lead）+ validator |
| `packages/teamlead/src/ProjectConfig.ts:292-299` | **Bug fix**: `canSpawnRunners` 默认值从 `Boolean(forumChannel)` 改成 `true`（详见下面 §canSpawnRunners 解耦） |
| `packages/teamlead/src/department-registry.ts:55-65` | 同上 — `effectiveCanSpawn()` 防御 fallback 改成 `true`（保留 fallback 给手写 fixture） |
| `packages/teamlead/src/config.ts:9-31, 105` | 删 `STATUS_TAG_MAP` env 解析 + `parseStatusTagMap` helper |
| `packages/teamlead/src/bridge/types.ts` | 删 `statusTagMap`（如果在 BridgeConfig 里） |
| `scripts/test-deploy.sh:307-714` | 删 `FORUM_CHANNEL_ID` 读取、jq 注入、WARN log |
| `scripts/test-slots.example.json` | 删 `forumChannelId` / `forumChannelName` 字段 + `_forumChannel` 注释 |
| `scripts/cleanup-fly-77-config.sh:98` | 更新提示文案 |
| `scripts/e2e-demo.ts:101`、`scripts/test-stale-patrol.ts:128` | fixture 里删 `forumChannel: "..."` |
| `packages/teamlead/scripts/test-lead-alert-dedup.sh:49` | fixture 里删 `forumChannel` |
| `.claude/commands/setup-discord-lead.md` | 删 forum 模板 + `{forum-channel-id}` 占位符 |
| `~/.flywheel/projects.json`（Annie 本地） | 删 `forumChannel`、`statusTagMap`；加 `canSpawnRunners: false` 到 cos-lead |
| `~/.flywheel/test-slots.json`（Annie 本地） | 删 `forumChannelId` / `forumChannelName` |

### Storage（详见 §conversation_threads 决策）

- `conversation_threads` SQL table + 所有写入方法删除
- `sessions.thread_id` 列保留一个 release（harmless deprecated column）

### 测试覆盖（fixture cleanup）

40 个 `packages/teamlead/src/__tests__/*.ts` 文件提到 `forum`。大多数只是 fixture 里的 `forumChannel: "..."` 字符串。

- **删除**：`ForumPostCreator.test.ts`、`ForumTagUpdater.test.ts`、`CleanupService.test.ts`
- **修改**：`DirectEventSink.test.ts`、`event-route*.test.ts`（3 个）、`actions.test.ts`、`bridge*.test.ts`、`EventFilter.test.ts`、`event-filter-e2e.test.ts`、`start-e2e.test.ts`、`retry-e2e.test.ts`、`bootstrap-generator.test.ts`、`runs-route-registration.test.ts`、`HeartbeatService.test.ts`、`ProjectConfig.test.ts`、`department-registry.test.ts`、`lead-scope.test.ts`、其他

### 不在本 PR 范围（其他 repo）

- **GeoForge3D `geoforge3d-gbrain-sync/.lead/{product-lead,ops-lead}/agent.md`**：每个文件 ~10 个 Forum refs（Bridge auto-tag、"附 Forum Thread 链接"、`forumLink` reading）。Annie/GeoForge3D worker 单独处理。
- **Discord channel 删除**：Annie 手动操作。

## Discord Channel 删除清单（Annie 手动）

按 Annie 习惯顺序（先测试再生产）:

### 测试环境（先删，验证 QA framework 还跑得通）
1. `1501660591184412682` — finance-forum-test (slot 4)
2. `1501660264314179807` — ops-forum-test (slot 3)
3. `1501659917923254292` — product-forum-test (slot 2)

### 生产环境（最后删，确认 Bridge 已经 ship 新代码再删）
4. `1485789340989915266` — ops-forum (Oliver / ops-lead)
5. `1485787822119194755` — product-forum (Peter / product-lead)

Status tag 子项（每个 forum channel 自带 6 个 tag）会随父 channel 一起删除，不用单独处理。

## `canSpawnRunners` 解耦（forum-coupled bug 修复）

### Problem

```ts
// ProjectConfig.ts:292-299
if (lead.canSpawnRunners === undefined) {
    lead.canSpawnRunners = Boolean(lead.forumChannel);
}
```
```ts
// department-registry.ts:60-65
function effectiveCanSpawn(lead: LeadConfig): boolean {
    if (typeof lead.canSpawnRunners === "boolean") return lead.canSpawnRunners;
    return Boolean(lead.forumChannel);
}
```

删 forum 后，**所有 lead 都默认 spawn-disabled** — 包括必须 spawn 的 dept lead。Annie 拍板："删 forum 不应该副作用导致 spawn disabled. canSpawnRunners 应该独立于 forumChannel. 这是个 bug，必须修."

### Decision（Codex 推荐 Option A + validator + 两阶段 deploy）

1. **`canSpawnRunners` 默认值**: 从 `Boolean(forumChannel)` 改成 **`true`**。cos / PM-only lead 必须显式写 `canSpawnRunners: false`。
2. **保留 `department-registry.ts:64` 的 defensive fallback**，但语义改成 `return true`（默认 true）—— 删掉会打破手写 `ProjectEntry[]` 测试 fixture 的防御层。
3. **加 validator (Q2a)**: `loadProjects()` 检测到 lead 的 `match.labels` 包含 `"PM"` / `"Triage"` 但 `canSpawnRunners !== false` 时硬抛 error。Option A 是 fail-open，silent-expansion 是真实风险；这个 validator 是针对已知 footgun 的最小防御。
4. **两阶段 deploy (Q2b)**:
   - **Phase 1**: 先更新 `~/.flywheel/projects.json`（cos-lead 加 `canSpawnRunners: false`，product / ops 加 `canSpawnRunners: true`）。在旧代码下重启 Bridge，验证行为不变。
   - **Phase 2**: 拉新代码 + 删 forum + 改默认值。重启 Bridge。
   - 这样避免了"拉新代码 → 重启 → 改 config" 期间 cos-lead 短暂可 spawn 的窗口。
5. **`canSpawnRunners` doc comment 重写**: "Bridge spawn authorization — independent of Discord channel features."

### 受影响的代码路径
- `runs-route.ts:241-281` — 真正的 spawn gate（返回 `403 DEPT_SCOPE_REJECT`）。解耦后逻辑不变。
- `classifyIssue()` (`department-registry.ts:84-85, 177-180`) — 只枚举 `effectiveCanSpawn=true` 的 lead。如果 cos-lead 不显式 false，PM-labeled issue 会进入 canonical lead resolution，破坏 GEO-275 保证。
- WorkflowFSM 没有直接的 cos/PM spawn 依赖；风险纯在 scope gate。

### 测试 fixture 影响
- 约 7 个 GEO-275 / PM-related fixture + 2 个隐式 spawn-denial-via-missing-forum fixture（`department-registry.test.ts`、`start-e2e.test.ts`）需要显式 `canSpawnRunners: false`。

## 其他技术决策（Codex 推荐）

### Q1 — `postThreadStatusMessage` 文本
**决策**: 整体删除（不 repoint 到 chat thread）。

Lead 已经在 chat 通知 Annie 状态变化；emoji status trace（"🚀 Running ‹ pending → running ›"）冗余。删 `ForumTagUpdater.ts` 里的 `postThreadStatusMessage` + `DirectEventSink.ts:567` + `actions.ts:137` 调用点。

### Q3 — `conversation_threads` SQL table
**决策**: D-partial — 删表 + 方法层，保留 `sessions.thread_id` 一个 release。

- 删 `conversation_threads` table 的 DDL / migration helpers（`StateStore.ts:224-232, 258-283, 322-341, 399-412`）+ 写入方法（`upsertThread`、`getThreadByIssue`、`setSessionThreadId`、`markArchived`、`clearArchived`、`markCleanupNotified`、`markDiscordMissing`、`getEligibleForCleanup`）
- 保留 `sessions.thread_id` 列：harmless deprecated。Forum 走的就是这个列（验证：`chat_threads` 表 + `chat_thread_id` 字段是独立的 chat thread storage，`sessions.thread_id` 只服务 Forum 继承）。
- 增加 SQLite migration: `DROP TABLE IF EXISTS conversation_threads`。

### Q4 — 删 forum 后用户 `projects.json` 里仍写 `forumChannel` 的处理
**决策**: B（warn + ignore）一个 release，之后改成 A（hard-fail）。

- Phase 1: `loadProjects()` 看到 `forumChannel` 时 log `[loadProjects] forumChannel is deprecated, ignoring`，剥掉字段继续运行。
- Phase 2（follow-up PR）: 改成 hard-throw `Unknown field "forumChannel"`.
- Annie 单人环境 + ~3 lead 迁移面小，但 fork 用户可能 surprise；一个 release 的 courtesy 窗口够用。

### Q5 — 测试 forum channels
**决策**: 全删。Annie 原话"包括 QA testing 里面的那些 forum channel，都不需要了。"

## 实施 Pass 划分

### Pass 0 — Pre-merge 配置迁移（Annie 手动 + 旧代码）
1. Annie 在 `~/.flywheel/projects.json` 加 explicit `canSpawnRunners`：cos-lead `false`，product/ops `true`
2. Annie 在 `~/.flywheel/test-slots.json` 准备好新版（虽然字段不变，验证一遍）
3. 旧代码下重启 Bridge，验证 spawn 行为不变（cos 仍被 deny，dept 仍 ok）

### Pass 1 — Bridge runtime + tests（主 PR）
1. 删 3 个 Forum-only class + 3 个 dedicated test files
2. 简化 DirectEventSink / event-route / actions / HeartbeatService / plugin / run-infra / runs-route / lead-runtime（删 forum 分支）
3. 简化 EventFilter（删 `updateForum` 字段）
4. 删 `forum_*` 字段（HookPayload、API response、lead-runtime format string）
5. 删 `/api/forum-tag` + `/threads/upsert` + `/thread/:thread_id` 三个 route
6. ProjectConfig: 删 `forumChannel` + `statusTagMap` 字段；改 `canSpawnRunners` 默认值；加 PM-label validator (Q2a)；加 stale `forumChannel` warn-and-ignore (Q4)
7. department-registry: 改 `effectiveCanSpawn()` 默认值
8. config.ts: 删 `STATUS_TAG_MAP` env + `parseStatusTagMap`
9. 更新 40 个 test 文件 fixture（删 `forumChannel: "..."` + 给 GEO-275 fixture 加 explicit `canSpawnRunners: false`）
10. scripts/test-deploy.sh / test-slots.example.json / e2e fixtures cleanup
11. .claude/commands/setup-discord-lead.md scrub

### Pass 2 — Storage cleanup（同一 PR 或 follow-up）
1. SQLite migration: `DROP TABLE IF EXISTS conversation_threads`
2. 删 StateStore 里所有 `conversation_threads` CRUD 方法
3. 保留 `sessions.thread_id` 列（deprecated comment + TODO follow-up issue）

### Pass 3 — Discord channel 删除（Annie 手动）
按上面 §Discord Channel 删除清单 顺序删 5 个 forum channel。

### Pass 4 — Follow-up（下个 release）
1. Hard-fail on `forumChannel` 字段（Q4 phase 2）
2. 删 `sessions.thread_id` 列（Q3 deprecated cleanup）
3. 文档同步（CLAUDE.md / MEMORY.md 里 `Forum` 相关条目）

## Out-of-scope / 后续 issue

| 工作 | 在哪 |
|------|------|
| GeoForge3D Lead 系统 prompt 里删 Forum refs | `~/.flywheel/repos/geoforge3d-gbrain-sync/.lead/{product-lead,ops-lead}/agent.md`，~10 refs/file |
| 删 5 个 Discord forum channel | Annie Discord UI 手动 |
| Annie projects.json / test-slots.json 编辑 | Pre-merge phase 0 |
| `sessions.thread_id` 列清理 | Follow-up issue |
| `forumChannel` hard-fail 切换 | Follow-up issue（下个 release） |

## Open Questions（plan 阶段）

1. SQLite `DROP TABLE` 是否需要 backup / 是否 Annie 想保留旧 forum thread metadata 用于 archive 查询？（current 默认：直接 drop，旧 Discord channel 都删了，metadata 也没意义）
2. `EventFilter` 的 `updateForum` 字段移除后，audit log JSON shape 改变 — 是否会破坏外部消费方？（grep 看下来只有自己的 console log 在用，无外部 consumer）
3. Pass 1 这么大的 diff 是否拆 2-3 个 PR（runtime / config / test fixture）？还是一个原子 PR 更安全？我倾向原子。

## References

- FLY-91: Per-issue chat thread creation in chatChannel — `packages/teamlead/src/bridge/ChatThreadCreator.ts`
- FLY-127: Bridge-side spawn authorization (`canSpawnRunners`) — `packages/teamlead/src/department-registry.ts`
- GEO-275: PM-lead (forum-less) handling — `packages/teamlead/src/ProjectConfig.ts:160-170`
- GEO-195 / FLY-24: Original Forum infrastructure — `ForumPostCreator.ts`、`ForumTagUpdater.ts`
- FLY-137 v1.27.2: `LeadConfig.department` field — `packages/teamlead/src/ProjectConfig.ts:52-60`
