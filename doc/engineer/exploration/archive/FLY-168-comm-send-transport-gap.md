# Exploration: `flywheel-comm send` Transport Gap — FLY-168

**Issue**: FLY-168 (`flywheel-comm send` doesn't wake `awaiting_review` Runner — transport-split design gap)
**Date**: 2026-05-22
**Status**: Draft
**Linear**: https://linear.app/geoforge3d/issue/FLY-168

---

## 1. 背景与事故复盘

### 1.1 真实事故 (2026-05-22 23:06 UTC)

- Peter (product-lead) 通过 `flywheel-comm send --from product-lead --to 6b1920df-fcad-4ebc-9677-40ac675cf229 --content "..."` 发指令，message id `d7730d9e-b1dd-4070-ae74-a973030c7b24`
- 目标 Runner: `exec_id=6b1920df-fcad-4ebc-9677-40ac675cf229` (GEO-378 backend), `status=awaiting_review`, `stage=approve`
- 33 分钟后 Runner tmux 仍 idle 在 `❯` prompt，message 从未 consume
- CommDB 行 `delivered_at=NULL, read_at=NULL, resolved_at=NULL`（实测 `~/.flywheel/comm/geoforge3d/comm.db`）
- 兜底：Peter 用 `runner_terminal_input` MCP 直接 tmux `send-keys` 把 Claude 推醒

### 1.2 为什么 v1.27.0 之前没暴露

FLY-142 (PR #186) 把 **Bridge → Lead** 的 delivery 从 CommDB 切到 mailbox (`MailboxTransport.writeVerified`)。Lead 这条路 wake bug 已修，但 **Lead → Runner** 仍然走老的 `flywheel-comm send` → `CommDB.insertInstruction` → PostToolUse hook 注入，这条路没动过。

事故发生时刚好踩了两个坑：
1. 目标 Runner idle 在 `❯`，没有 tool call，PostToolUse hook 不触发
2. 即便 hook 被触发，TmuxAdapter 默认写 `~/.flywheel/runner-state/<execId>/mailbox-active` sentinel，`inbox-check.sh` 一进来就 `exit 0` no-op（让位给 mailbox path，但 mailbox 这边根本没写）

**净结果**：mailbox 模式默认开启之后，`flywheel-comm send` 在 idle Runner 上变成了静默丢弃。这是 transport split 的设计缺口。

---

## 2. 现有架构（事实，不是推测）

### 2.1 两条 delivery path 对比

| 维度 | Path A: Bridge `MailboxTransport.writeVerified` | Path B: `flywheel-comm send` |
|---|---|---|
| 发起方 | Bridge daemon (`MailboxLeadRuntime.deliver`) | Lead CLI (Peter 的 claude session) |
| 写入位置 | `<CLAUDE_CONFIG_DIR>/teams/<safeLead>/inboxes/<safeAgent>.json` + sidecar `.flywheel.jsonl` | CommDB `messages` 表 `INSERT` `type='instruction'` |
| 唤醒机制 | claude-code 内建 `useInboxPoller`（运行在 Claude session 内的后台 poll loop，idle 也工作） | 依赖 PostToolUse hook `inbox-check.sh` 在 tool call 后注入 additionalContext |
| Idle Runner 行为 | 自动唤醒 ✅ | 永远不触发 ❌ |
| Sentinel 影响 | 不依赖 | 有 sentinel → hook 直接 exit 0，永远不读 CommDB ❌ |
| 是否需要 tmux send-keys | 否（builtin-receiver） | 否（hook 注入 additionalContext） |

### 2.2 关键文件

- `packages/flywheel-comm/src/commands/send.ts` — 17 行，单 SQL insert，**完全没有 mailbox 写入**
- `packages/flywheel-comm/src/commands/respond.ts` — 18 行，同样只 `insertResponse`。能 wake Runner 仅仅是因为 Runner 在 `flywheel-comm gate` 里 15s/次 polling CommDB
- `packages/agent-team-transport/src/claude/ClaudeCodeAdapter.ts:117-143` — 已实现的 `transport.write({leadName, recipient, payload})`，PR #186 已经在生产用
- `packages/teamlead/src/mailbox/MailboxTransport.ts:77-103` — `writeVerified` 提供 write + read-after-write 校验
- `scripts/hooks/inbox-check.sh:42-49` — sentinel short-circuit；mailbox 模式下 hook = no-op
- `packages/claude-runner/src/TmuxAdapter.ts:262-292` — 默认写 sentinel + 把 `FLYWHEEL_RUNNER_STATE_DIR` 注入 Runner env
- `packages/flywheel-comm/src/db.ts:7-37` — CommDB `sessions` 表（schema 里没有 `agent_name` / `team_name`，**这是 mailbox 写入路径解析的关键缺口**）

### 2.3 Mailbox path 解析所需身份字段

mailbox 路径模板：

```
<CLAUDE_CONFIG_DIR>/teams/<sanitize(teamName)>/inboxes/<sanitize(agentName)>.json
```

Runner spawn 时 Claude-code 收到 `--team-name <teamName> --agent-name <agentName>`（见 `ClaudeCodeAdapter.buildRunnerSpawnConfig:263-293`），stock `useInboxPoller` 据此 polling 自己的 inbox 文件。

Lead 现在调 `flywheel-comm send --from product-lead --to <execId>` 时手上只有 `execId`（UUID），但 mailbox 写入需要：
- `teamName` — 跟 Lead 的 `--team-name` 一致；约定上 = `leadId`（每个 Lead 自带一个 team）
- `agentName` — Runner spawn 时分配的 name，**不保证等于 execId**

CommDB `sessions` 表的字段（`db.ts:21-30`）：

```
execution_id  TEXT PRIMARY KEY,
tmux_window   TEXT NOT NULL,
project_name  TEXT NOT NULL,
issue_id      TEXT,
lead_id       TEXT,
started_at, ended_at, status
```

**没有 `agent_name` 和 `team_name`**。所以要让 `flywheel-comm send` 走 mailbox，必须解决「Runner 身份从哪里查」这个子问题。

---

## 3. 三个候选方案评估

### Option A：`flywheel-comm send` 双写 Mailbox + CommDB（推荐）

**做法**：

1. `send.ts` 多写一份 mailbox payload（复用 `AgentTeamTransportFactory.fromEnv()` + `MailboxTransport.writeVerified`）
2. CommDB 写入保留（向后兼容 `FLYWHEEL_COMM_BACKEND=commdb` rollback 模式 + audit log）
3. Mailbox 写失败时不阻断 CommDB 写（best-effort wake；CommDB 是审计/回滚兜底）
4. 身份解析子问题（见 §4）

**优点**：

- 改动单包（`flywheel-comm`）+ 一次小 schema migration，blast radius 极小
- 复用 PR #186 已经在生产跑了 10 天的 mailbox 写入路径（不发明新唤醒机制）
- 跟 Bridge → Lead 路径对称，认知负担低
- Rollback 路径仍然完整：env 设 `FLYWHEEL_COMM_BACKEND=commdb` → TmuxAdapter 不写 sentinel → `inbox-check.sh` 走 CommDB 注入

**风险**：

- Mailbox 写需要 team config 文件已存在（Lead 启动时由 `team-bootstrap.ts` 创建，正常情况下 OK；但要 verify Runner spawn 前 team file 已就位）
- 「Runner 身份从哪里查」需要解决（§4 列三种子方案）
- Idle Runner 在 mailbox 模式下能被 useInboxPoller 唤醒 — 这个假设需要 §5 research 阶段实证验证（同 Bridge→Lead 情况，但 Runner 这边历史上没在 idle 状态下被精确测过）

### Option B：Runner 端轮询 hook（不推荐）

**做法**：Claude Code 加一个 idle-tick / per-N-second hook，让 `inbox-check.sh` 在 idle 时也跑。

**为什么不推荐**：

- Claude Code 现有 hook 系统只有 PreToolUse / PostToolUse / Stop / PostCompact 等事件触发，**没有 idle/tick hook**
- 加 idle hook 是 fork Claude Code 的工作量（vendor 上游级别改动），远超 FLY-168 范围
- 即便加上 tick hook，仍然只解决一个 vendor (claude-code)，未来 codex 还要再做一遍
- 跟现有架构思路相反 —— FLY-142 已经把方向转到「写 mailbox + builtin-receiver」

### Option C：Lead 改用 Bridge API `POST /api/runner-messages`（不推荐）

**做法**：废弃 `flywheel-comm send`，Lead identity rules 改成调 Bridge HTTP API，Bridge 内部走 `MailboxTransport.writeVerified`。

**为什么不推荐**：

- 加一个 HTTP 跳，Bridge 还是要走 mailbox 写入 → 跟 Option A 比多一层
- Lead identity rules 要同步改（多个 Lead 模板的 muscle memory 都需要更新）
- Bridge 当前没有 `POST /api/runner-messages` endpoint，要新写路由 + 鉴权
- Bridge daemon 一旦挂了，Lead → Runner 通信也跟着断（Option A 直接进程内写文件，没这个耦合）
- 没有解决 Option A 没解决的任何问题，纯粹多花钱

---

## 4. Option A 内的子分歧：Runner 身份从哪里查

`flywheel-comm send` 只拿到 `--to <execId>`，怎么算出 `teamName`/`agentName` 写 mailbox？

### A1：扩展 CommDB `sessions` 表加 `agent_name` + `team_name` 字段

- Schema migration（已经有 `applyMigrations()` 机制，db.ts:51）
- Runner spawn 时（`TmuxAdapter` 或 `sessions register` 注册路径）写入这两个字段
- `flywheel-comm send` 收到 `--to <execId>` → `SELECT agent_name, team_name FROM sessions WHERE execution_id=?` → 写 mailbox
- 优点：消费端零认知负担，UX 不变
- 缺点：有 migration，需要覆盖所有创建 `sessions` 行的代码路径

### A2：`flywheel-comm send` 加显式 `--team` + `--agent-name` flag

- Lead identity rules 升级，叫 Lead 传完整身份
- 优点：实现最简单，不动 schema
- 缺点：UX 退化（Lead 现在只记 execId，要查 team/agent 多一步）；rules 改动散在多个 Lead 模板

### A3：约定 `agent_name == execId`，team_name = lead_id

- 看一下现状是不是已经这样（research 阶段需 grep 验证）
- 如果已经是这个约定，`flywheel-comm send` 只需要从 sessions 查 `lead_id`（已有字段），mailbox path = `<CLAUDE_CONFIG_DIR>/teams/<lead_id>/inboxes/<execId>.json`
- 优点：零 schema 改动，零 UX 改动
- 缺点：是隐性约定，没在代码里强制；如果哪天有 Lead 给 Runner 自定义 agent_name 会断（FLY-137 v1.27.2 的 `agent_name override` 路径就有这种可能 —— 见 `actions.ts:680`）

**初步倾向：A1**。理由：
- `actions.ts:680` 已经把 `agent_name` 当 StateStore 字段使用（Bridge 内部知道这个值），扩展 CommDB sessions 不算引入新概念
- A3 太脆弱，FLY-137 retry 路径已经在用 `session.agent_name` override，约定其实已经不成立
- A2 把负担推给人（Lead 模板），不可持续

Research 阶段会实测 A3 假设、确认 A1 的覆盖点（哪些代码路径插 sessions 行）。

---

## 5. 决策与后续问题

### 5.1 推荐方案

**Option A + A1**：`flywheel-comm send` 双写 mailbox + CommDB，身份从扩展的 `sessions` 表查。

### 5.2 留给 Research 阶段实证的开放问题

1. **`useInboxPoller` 在 Runner idle 状态下是否真的 wake** —— Bridge → Lead 路径在生产里跑过，但 Lead → Runner 这条线还没在 `awaiting_review` 静态条件下精确测过；可能需要 spike 一个 minimal reproducer。
2. **Mailbox 写入对 team config 文件存在性的依赖** —— `team-bootstrap.ts` 哪个时机创建 / 是否在 Runner spawn 前 always 就位 / 失败时降级行为是什么。
3. **身份查询子问题最终方案确认** —— A1 vs A3 实证（grep 所有写 `sessions` 行的入口 + agent_name override 频次）。
4. **Sentinel 边界场景** —— Lead 调 `send` 时 Runner 还没创建 sentinel / Runner 已经退出但 sentinel 残留 / 用户手动 `rm` 了 sentinel。

### 5.3 留给 Annie 拍板的产品决策（如出现）

目前不预见需要 Annie 拍板的 product trade-off：
- 行为变化对外不可见（Lead UX 不变，CLI flag 不变）
- 不变更 Lead identity rules
- Rollback 路径完整

如果 Research 阶段发现 idle wake 需要额外 tmux nudge（不只是 mailbox 写）—— 会暂停升 plan，先问 Annie。否则继续到 Plan 阶段。

---

## 6. 下一步

→ Phase 2: Research（`doc/engineer/research/new/FLY-168-mailbox-wake-mechanism.md`）

Research 重点：
- 实测 `useInboxPoller` 在 Runner idle 状态下的唤醒行为
- 审计所有写 `sessions` 行的代码路径，确认 A1 covering points
- 验证 ClaudeCodeAdapter spawn 时 team config 文件生命周期
- 列出 Plan 阶段需要的最小改动 surface（行数 / 文件 / 测试矩阵）
