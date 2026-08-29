# Exploration: Lead Thread Routing — FLY-162

**Issue**: FLY-162 ([workflow] Lead must auto-route messages to correct chat thread per Linear issue)
**Date**: 2026-05-17
**Status**: Draft — Annie 已锁 scope (Option D hybrid)，待 Codex 写 plan

> 目的：把 Lead cross-talk 真问题 ("Peter 在 GEO-374 thread 里 post GEO-372 status update") 的 root cause、4 options 评估、Annie 的 framing decision，以及给 plan phase 的 open questions 一次写清楚。所有引用的 codebase 事实都已 grep 过；不靠印象。

---

## 1. Problem Statement

### Annie 的规则

> 每个 thread 都是分开的 —— 每个 Linear issue 在 Lead 的 chat channel 里有自己的 Discord chat thread，那个 thread 只讨论那个 issue。

### 实际发生 (empirical)

2026-05-17 一次 3 小时 session 里 Peter (product-lead) 至少 3 次 cross-talk：

1. GEO-372 terminate 状态 post 进 GEO-374 thread
2. FLY-161 + GEO-376 Dockerfile drift 讨论 post 进 GEO-374 thread
3. GEO-376 brainstorm gate approval post 进 GEO-374 thread

事件类型：Lead 在 thread A 里讨论 issue A 时，**主动**带出 issue B 的状态/决策，全部留在 thread A。

### 不是孤例

所有 3 个 Lead (Simba/Peter/Oliver) 都暴露在相同失败模式下 —— 这是工具 affordance 问题，不是某个 Lead 的 prompt 写得差。

---

## 2. 现状架构 (codebase 事实)

### 2.1 已有 routing 基础设施 — FLY-91 已 ship 80%

| 资产 | 位置 | 已做 |
|------|------|------|
| Canonical mapping table | `StateStore.chat_threads(issue_id × channel_id → thread_id, unique idx)` | ✅ |
| Bridge 创建 thread | `packages/teamlead/src/bridge/ChatThreadCreator.ts:ensureChatThread()` | ✅ |
| Event 携带 thread id | `HookPayload.chat_thread_id` (hook-payload.ts:47); `DirectEventSink.ts:521` 通过 `resolveChatThreadId(store, issueId, chatChannel)` 填充 | ✅ |
| Lead → Bridge 创建/查询 | `POST /api/chat-threads/create`, `GET /api/chat-threads?issueId=&channelId=` (tools.ts:485/615) | ✅ |
| Lead identity rule | `~/.flywheel/lead-rules/product-lead/department-lead-rules.md:118-119` 已写 "reply(chat_id=chat_thread_id)" | ✅ |
| **Bridge 反查 (threadId → issueId)** | 无 | ❌ |
| **Outbound routing 强制** | 无 — 全靠 prompt | ❌ |
| **Inbound payload enrichment** | 无 — discord plugin 不知道 issue 概念 | ❌ |

### 2.2 Discord plugin reply tool — 零校验

`~/.claude/plugins/cache/claude-plugins-official/discord/0.0.4/server.ts:568-584`：

```js
{
  name: 'reply',
  description: 'Reply on Discord. Pass chat_id from the inbound message...',
  inputSchema: {
    chat_id: { type: 'string' },
    text: { type: 'string' },
    ...
  },
  required: ['chat_id', 'text'],
}
```

`chat_id` 接受任意 string。Lead 选错 thread 也好、用过期 thread id 也好、跨 channel 投递也好，都不会被 plugin 阻止。

### 2.3 Inbound 侧的 enrichment gap

Annie 在某个 thread 里发消息时，Lead 收到 `<channel source="discord" chat_id="THREAD_X" message_id="..." user="...">`。这个 envelope **没有** `issue_id`。Lead 要靠：

- thread title 里的 `[GEO-374]` 字面识别（脆弱：title 可能被改、可能没 issue prefix）
- 或对 `chat_id` 反查 Bridge（但 `GET /api/chat-threads` 只支持 `?issueId=&channelId=` 正查，不支持 `?threadId=` 反查）

所以 inbound 侧 Lead 实际上是在猜 thread ↔ issue 绑定，**也是 cross-talk 的隐性 root cause**：Lead 不知道自己 reply 的 thread 绑哪个 issue，自然容易跨 issue 漂。

---

## 3. Peter 提的 3 options + 我加的 Option D

### Option A — Bridge events 带 canonical chat-thread ID per issue; Lead tooling enforce

审计结论：**A 已 ship 80%**。FLY-91 已把 canonical id 放进 `HookPayload.chat_thread_id`，Lead identity rules 也已经写了 "用 chat_thread_id reply"。Peter 提的 "enforce" 部分等于 prompt 加强 (A++)。

### Option B — Lead-side guardrail in reply tool: 解析 text 找 GEO-XXX → 查 canonical thread → 不匹配则 reject

风险：
- 需要修改 vendored discord plugin (`~/.claude/plugins/cache/.../discord/0.0.4/server.ts`)。Flywheel 已经在维护一个 plugin fork (FLY-29)，新增 vendor-fork drift 成本不低。
- 文本扫描脆弱：Lead 可以用 "另一个 ticket" / "上面那个 issue" 这种模糊指代绕过。
- 反查 chat_id → issueId 需要新 endpoint (见 §2.1 ❌ 行)。

### Option C — Auto message splitting

不推荐：
- 内容很少能干净分 —— "FLY-161 unblocks FLY-162" 本身就是 cross-cutting。
- 拆分语义判断需要 LLM 层；复杂度高，错拆比不拆更差。

### Option D (worker-fly-162 加的) — Bridge 路由 by Issue

新增 Lead-only 工具 `reply.by_issue(issueId, text)`：

1. Lead 调 tool 时只指定 **issueId** (业务主键)，不指定 chat_id (Discord 物理 ID)
2. Bridge 查 canonical `chat_threads` mapping → 找到正确 thread → 用 bot token 投递
3. 顺便：Bridge inbound webhook 时反查 `chat_id → issue_id`，enrich 给 Lead 的 payload

**语义关键**：主键从 Discord 物理 ID (`chat_id`) 切到业务对象 (`issueId`)。

---

## 4. Codex framing key insight — Lead autonomy on WHAT, system on WHERE

通过 codex:rescue 跟 Codex 做 high-level product 讨论，Codex 锁定了关键 framing：

> **核心 product problem 不是 "Lead 要不要 autonomy"，而是 "Annie 能不能信任每个 Linear issue 的 Discord thread 只承载该 issue 的讨论记录"。**
>
> 边界应该是：
> - Lead 负责 **WHAT to say** — 内容、priority、跨 issue 关系判断
> - 系统负责 **WHERE to send** — 投递位置不漂移
>
> 把 Bridge routing enforcement 看成 "cage-like" 是误判。WHERE 不是创作自由的一部分；它是数据一致性和协作信任的基础设施。

### 为什么 prompt-only 不够 (Codex 判断)

- Sonnet/Claude Code 短上下文单 issue 时遵守率粗估 90–98%，但 1–5% error rate 对 hard rule 不可接受
- 高频协作里小概率 = 稳定事故流
- 长 session / 上下文压缩 / 多 issue 状态汇总 已经反复 leak
- 问题不是 prompt 写得不够严，**是 tool affordance 错了** —— `reply(chat_id)` 等于要求概率模型每次手动维护系统不变量

### 为什么 A++ 单独不行

A++ (更强 prompt + 更清楚 context) 只能 **降低** 误发概率，不能消除 error type。事实层面 Peter 已经在长 session 里 demo 过 prompt 衰减。

---

## 5. Annie 的 Scope Decision — Option D Hybrid

Annie 锁定 4 项：

1. **Outbound**: 新增 Lead-only 工具 `reply.by_issue(issueId, text)`，Bridge canonical routing 投递
2. **Inbound**: Bridge 加 `threadId → issueId` reverse lookup，enrich Discord thread message payload 给 Lead
3. **A++**: 保留强 prompt + Lead identity rules 帮 Lead 判断 "这段话属于哪个 issue"
4. **Cross-issue**: Lead 显式多次调用 `reply.by_issue`，**不自动 split** (不做 Option C)

### 分层防御

| Layer | 谁负责 | 内容 |
|-------|--------|------|
| L1 — judgment | Lead (prompt + identity rules) | 决定 **WHAT** to say 和 **属于哪个 issue** |
| L2 — routing | Bridge (`reply.by_issue` tool + canonical mapping) | 决定 **WHERE** to send |
| L3 — context | Bridge inbound enrichment | 让 Lead **知道** thread 绑哪个 issue |

L1 失败 (Lead 把 X 的话错认成 Y 的) → L2 还能保证投递到正确 thread (按 Lead 给的 issueId)。这是 hybrid 的核心 — L1 减少 misjudgment，L2 兜底防漂移。

### Cross-cutting decision 处理

不自动 split。Lead 显式多次 `reply.by_issue("GEO-374", "<text-1>")` + `reply.by_issue("FLY-161", "<text-2>")`。每次调用就是 Lead 自觉地说 "这段话属于这个 issue"，可追溯、不猜内容归属。

---

## 6. Open Questions for Codex Plan

以下都是 plan phase 需要 codex (写 plan / design review) 细化的实现问题。本 brainstorm 不锁定。

### 6.1 `reply.by_issue` tool API spec

- **Tool 怎么暴露给 Lead？** 选项：
  - (a) 新 MCP server (Bridge 暴露 MCP endpoint，Lead 通过 MCP 客户端调用)
  - (b) Bridge HTTP endpoint，Lead 用 curl + `runner-messaging-rules.md` 风格 (像现在 `--lead <id> <question-id>` CLI tool)
  - (c) wrap 在现有 discord plugin 里 (要 fork plugin，跟前面 push back 的 B 矛盾) — 不推荐
- **入参 schema**：`issueId`（必填）、`text`（必填）、`leadId`（用谁的 bot token 投递）、`replyTo` (message_id, optional thread 回引)、`files` (attachment paths, optional)
- **issueId 形式**：Linear UUID? 还是 `FLY-162` identifier? 还是 both 都接受?
- **错误处理**：issueId 没有 canonical thread 时怎么办？(a) Bridge 自动 `ensureChatThread` 然后投递？(b) 报错让 Lead 显式 create？

### 6.2 Inbound enrichment hook 位置

- Discord plugin 不可改的话，inbound 怎么 enrich？
  - Lead 收到 `<channel chat_id=THREAD_X>` 后**主动**调 Bridge `GET /api/chat-threads/by-thread/:threadId` 反查（Lead 多一步 tool call，简单但有 latency）
  - 或：Bridge 加 webhook intercept，把 Discord webhook 先送 Bridge → Bridge enrich → 再转给 Lead？(改架构大)
  - 或：discord plugin **可以加 system-prompt prefix** 吗？让 plugin 在 inbound envelope 后面附一段 "lookup: $ISSUE_ID" — 但 plugin 不知道 issueId，回到第一种
- **推荐方向**：Lead-side lookup (调 Bridge endpoint)，简单不动 plugin。但需要 Lead identity rules 写明 "收到 thread 消息时先反查 issueId"。

### 6.3 Vendored discord plugin 怎么不动 (或动得最小)

确认 Option D 完全不需要改 plugin。`reply.by_issue` 是新工具，不替换 `discord.reply`。但要规划 Lead identity rules 怎么写：

- Lead 的 reply 路径变成 **两个**：`discord.reply(chat_id)` (退化/legacy) 和 `reply.by_issue(issueId)` (新主路径)
- 怎么避免 Lead 继续用老的 `discord.reply` 跨 thread？— prompt-only 又回到 Codex 说的 "tool affordance" 问题
- 选项：在 Lead identity rules 里加硬规则 "discord.reply 仅限非 issue-bound 消息 (e.g. core channel 闲聊)"，但这又是 prompt-only
- 或：**让 reply.by_issue 接管全部 issue-bound 投递路径**，并且 Bridge 在 thread 投递层加 audit log，发现 `discord.reply` 直接命中 chat_threads table 里的 thread_id 时记一笔 violation —— 不阻止但留证据，配 dashboard 看 leak 率

### 6.4 Lead prompt 更新范围

- `lead-rules-base/department-lead-rules.md` 加 "issue-bound reply 用 reply.by_issue" 章节
- `~/.flywheel/lead-rules/<lead>/department-lead-rules.md` 把现有 "用 chat_thread_id" 改成 "用 reply.by_issue(issueId)"
- 多人 Lead (cos-lead) 在 core channel 时还需要 `discord.reply(chat_id=core_channel_id)`，怎么界定 "issue-bound vs not"？

### 6.5 Out of scope（明确不做）

- Auto split (Option C)
- 修改 vendored discord plugin (Option B 的 reject path)
- 文本 GEO-XXX 扫描 (B 的脆弱部分)

### 6.6 Migration / Rollout

- FLY-91 已 ship 的 `chat_thread_id` payload 字段保留不动，向后兼容
- `reply.by_issue` 先在 product-lead (Peter) 上试，验证 1 周后再 roll 给 ops-lead + cos-lead
- 怎么衡量 success？— audit log: `discord.reply` 命中 chat_threads table 的次数（即 leak 事件）应该归零；同时 `reply.by_issue` 调用次数应该接近原 `discord.reply` 的 issue-bound 调用量

---

## 7. Decisions Log

| Date | Decision | Source |
|------|----------|--------|
| 2026-05-17 | Option D hybrid (4 项见 §5) | Annie via team-lead (codex:rescue framing 后) |
| 2026-05-17 | 不做 auto-split (Option C) | Annie |
| 2026-05-17 | 不动 vendored discord plugin | worker-fly-162 audit + Annie |
| 2026-05-17 | Cross-issue decision → Lead 多次显式 `reply.by_issue` | Codex 推荐 + Annie |

---

## 8. References

- `packages/teamlead/src/bridge/ChatThreadCreator.ts` — Bridge 创建 thread
- `packages/teamlead/src/bridge/chat-thread-register.ts` — validate + register
- `packages/teamlead/src/bridge/chat-thread-utils.ts` — `resolveChatThreadId`
- `packages/teamlead/src/bridge/hook-payload.ts` — `HookPayload.chat_thread_id`
- `packages/teamlead/src/DirectEventSink.ts:500-528` — payload 填充 chat_thread_id
- `packages/teamlead/src/StateStore.ts:447,1283-1341` — `chat_threads` table CRUD
- `~/.claude/plugins/cache/claude-plugins-official/discord/0.0.4/server.ts:568-584` — reply tool schema
- `~/.flywheel/lead-rules/product-lead/department-lead-rules.md:112-156` — Lead chat-thread rule
- `doc/engineer/plan/inprogress/v1.22.0-FLY-91-discord-thread-reply.md` — FLY-91 已 ship 的部分
