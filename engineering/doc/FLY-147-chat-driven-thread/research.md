# FLY-147 聊天驱动 Issue Thread — 调研
Issue: FLY-147 (https://linear.app/geoforge3d/issue/FLY-147/chat-driven-issue-creation-auto-discord-thread-when-lead-spawns-new)
日期: 2026-08-30
基于: exploration.md

## 1. 调研结论

当前缺口不是 Discord thread 创建器或 role routing 缺失，而是 capability 与 auto policy 被同一开关绑死：

- 自动路径：`DirectEventSink.emitStarted()` 在 `config.chatThreadsEnabled && chatThreadCreator` 时调用 `ensureChatThread()`。
- 手动路径：`tools.ts` 的 `/chat-threads/create`、`register`、`send`、查询与 archive 也先检查同一个 `chatThreadsEnabled`。
- composition root：`startBridge()` 只在 `config.chatThreadsEnabled` 为真时构造共享 `ChatThreadCreator`。

因此只移除 route 的 404 guard 会把实证中的错误从 404 变成 `ChatThreadCreator not initialized` 503；只把开关默认改成 true 又会把自动与手动策略继续耦合，并扩大旧部署的行为变化。

## 2. 自动 spawn 路径

### 2.1 Role 兼容性

`DirectEventSink.emitStarted(env)` 持久化 `env.sessionRole ?? "main"`，但创建 thread 的分支只使用：

- `env.projectName`
- `env.labels`
- `env.issueId` / `issueIdentifier` / `issueTitle`
- resolved Lead 的 `chatChannel` 与 bot token

分支中没有 `main`、`qa`、`designer` 或 phase allowlist。故现有实现天然支持任意 string role；需要补的是参数化回归证据，而不是新增生产分支。

### 2.2 现有失败语义

- 找不到 Lead/channel/token 或 Discord 创建失败：记录 warning，Runner 继续启动。
- 创建成功：`chat_threads` 写入 issue/channel mapping，`/api/runs/start` 最多轮询 5 秒把 `chatThreadId` 带回响应。
- `ChatThreadCreator.ensureChatThread()` 负责复用、并发去重和 stale mapping 自愈；本 issue 不复制这些能力。

`TEAMLEAD_CHAT_THREADS_ENABLED=true` 应继续只控制以上自动路径及其后台 enrichment。这样 engineer/main 的现有自动行为不变，其他 role 与其共享同一路径。

## 3. 手动 ad-hoc 路径

### 3.1 `/api/chat-threads/create`

route 已完整实现：

1. 接受 `issueId` 或 `issueIdentifier`。
2. 校验 project、Lead、channel。
3. 经 Linear API 验证并解析 identifier/title。
4. 解析 per-Lead/global bot token。
5. 调用 `ensureChatThread()`，返回 `{threadId, created}`。

它不需要 session row；只有 canonicalization 会在存在 session 时优先复用 session 的 `issue_id`。这正是 chat-driven 新 issue 的所需接口。

### 3.2 Composition seam

不应把 `startBridge()` 的 auto creator 改成无条件共享给所有后台 consumer。`BridgeAppOptions.chatThreadCreator` 同时被 event route、issue display refresher、auto-QA effects 等存在性判定使用；简单改成常驻可能在 auto flag 关闭时重新激活后台写入。

安全的 seam 是 `createBridgeApp()` 挂载 query router 时：

```ts
const manualChatThreadCreator =
  opts?.chatThreadCreator ?? new ChatThreadCreator(store);

createQueryRouter(store, projects, {
  chatThreadCreator: manualChatThreadCreator,
  // ...existing options
});
```

当 auto flag 开启时，两条路径复用现有 shared creator；关闭时，仅 HTTP 手动能力获得一个 store-local creator，其他 background consumer 仍收到 `undefined`。

## 4. Route gate 拆分

| Route | 新 gate | 原因 |
|---|---|---|
| `POST /chat-threads/create` | `apiTokenConfigured` + 现有参数/Linear/token 校验 | Discord 写入口；auto flag 不应禁用手动 capability |
| `POST /chat-threads/register` | `apiTokenConfigured` + 现有 Discord/Linear 校验 | 修改 canonical mapping，必须 fail-closed |
| `POST /chat-threads/send` | `replyByIssueEnabled` | 该 flag 在 `loadConfig()` 已强制要求 API token；auto flag 与手动回复无关 |
| `GET /chat-threads` | 无 auto gate | 本地 mapping 查询；仍在统一 `/api` middleware 下 |
| `GET /chat-threads/by-thread/:id` | 无 auto gate | inbound enrichment 应能解析手动创建的 thread |
| `POST /chat-threads/archive` | 现有 `apiTokenConfigured` | 已有 fail-closed 写保护；移除 auto gate即可 |

`apiTokenConfigured` 已由 production composition 传入 `Boolean(config.apiToken)`。直接构造 router 的单测默认 false，天然验证 fail-closed，不需要新 auth primitive。

## 5. 安全与兼容性

- 不接受 client 传入任意 bot token；token 仍只从 verified Lead config 或 Bridge global config 读取。
- project/Lead/channel mismatch、alert ticket channel gate、Linear existence check 保持原样。
- `send` 的 startup guard 保持：`TEAMLEAD_REPLY_BY_ISSUE_ENABLED=true` 且无 `TEAMLEAD_API_TOKEN` 时 Bridge 拒绝启动。
- 自动 flag 关闭时不会因 manual creator 存在而激活 DirectEventSink、event-route display 或 auto-QA 后台行为。
- 自动 flag 开启时 query router 优先复用原 shared creator；engineer/main 的行为与 creator identity 不变。

## 6. TDD 覆盖设计

### 6.1 必须先红的行为

`packages/teamlead/src/bridge/__tests__/chat-thread-routes.test.ts`：

1. `chatThreadsEnabled:false` + injected creator + `apiTokenConfigured:true` 的 `/create` 应返回 200；当前返回 404。
2. 同一配置下预置 mapping 的 `GET /chat-threads` 应返回 thread；当前返回 404。
3. `apiTokenConfigured:false` 的 `/create`/`register` 应返回 503 且 creator 不被调用；当前 auto-off 返回 404，auto-on 会继续执行。
4. `chatThreadsEnabled:false` + `replyByIssueEnabled:true` + existing row 的 `/send` 应发到 Discord thread；当前被 auto flag 404 拦截。

### 6.2 Characterization / regression

`packages/teamlead/src/__tests__/DirectEventSink.test.ts`：用 `it.each(["main", "qa", "designer", "custom-role"])` 证明 auto enabled 时每个 role 都调用同一个 `ensureChatThread()` 一次，并保持传入 issue/channel/Lead 相同。该测试可能首次即绿，因为它锁定已存在但未被证明的 role-agnostic 合同。

### 6.3 Composition evidence

在 query-router mounting 附近加入 focused seam test，证明 auto creator 缺席时 manual creator 仍被提供；优先通过 endpoint 集成行为断言而不是测试构造器 identity。生产代码只在 `createBridgeApp()` 内新增 fallback，不改 `startBridge()` 的 auto creator 条件。

## 7. 文档矩阵

- `doc/reference/product-lead-TOOLS.md`：区分 manual create、auto spawn、reply-by-issue 三套触发与 env。
- `doc/reference/product-lead-SOUL.md`：说明无 session 的 ad-hoc issue 先 `/create`，auto off 不影响手动路径。
- `packages/teamlead/lead-rules-base/{department,cos}-lead-rules.md`：修正 `/send` 404 原因，不再把 `chatThreadsEnabled=false` 当 send gate。
- `docs/operations/bridge-daemon-management.md`：配置表与 smoke test，明确哪些变更需 Bridge restart。

## 8. 不需要 migration / rollback

无 schema 或持久化格式变化。回滚代码即可恢复原 gate；已有 `chat_threads` rows 保持可读。若运维希望关闭自动创建，继续设 `TEAMLEAD_CHAT_THREADS_ENABLED` 非 `true`；若希望关闭手动 send，设 `TEAMLEAD_REPLY_BY_ISSUE_ENABLED` 非 `true`。手动 create/register 的安全总闸是 `TEAMLEAD_API_TOKEN` 配置与 API auth。
