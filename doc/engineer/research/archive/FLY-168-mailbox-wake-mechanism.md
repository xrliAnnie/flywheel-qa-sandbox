# Research: Mailbox Wake Mechanism — FLY-168

**Issue**: FLY-168 (`flywheel-comm send` 不唤醒 `awaiting_review` Runner — transport-split design gap)
**Date**: 2026-05-25
**Source**: `doc/engineer/exploration/new/FLY-168-comm-send-transport-gap.md`
**Linear**: https://linear.app/geoforge3d/issue/FLY-168
**Status**: Complete

---

## 0. TL;DR — Research 改了 Brainstorm 的结论

Brainstorm 倾向 **Option A + A1**（扩 CommDB `sessions` 表加 `agent_name`/`team_name` 字段 + migration）。

**Research 实证后改为：Option A + A3-corrected（零 migration）。**

理由：Runner 的 mailbox 身份是 **(executionId, leadId) 的纯确定性函数**，两个输入都已存在于 CommDB `sessions` 表（`execution_id` PK + `lead_id`）。Brainstorm 之所以判 A3「不 invariant」，是把两个不同数据库里的 `agent_name` 搞混了（详见 §2）。Mailbox 身份从不被 FLY-137 的 override 影响。

→ **不需要 schema migration。** 只要把现有的派生逻辑抽成一个 shared helper，让 `send.ts` 和 `buildAgentTeamIdentity` 共用一个 source of truth 即可。

---

## 1. 事故复盘的精确化（事故本身没证伪 idle-wake）

Brainstorm §1 把事故描述为「33 分钟 Runner 没醒」。Research 需要厘清一个关键点：

事故走的是 `flywheel-comm send` → `CommDB.insertInstruction`（**只写 CommDB，根本没写 mailbox**，见 `send.ts:13`）。所以：

- Runner 的 `useInboxPoller` 没醒，**不是因为 poller 不工作，而是因为没有任何东西写进它 poll 的 inbox 文件**。
- sentinel 让 `inbox-check.sh` 直接 `exit 0`（`inbox-check.sh:44-48`），CommDB 那条 instruction 永远不被注入。
- 结果：两条路都不通 —— mailbox 没人写、CommDB hook 被 sentinel 短路。

**净结论**：事故证明的是 **transport gap 确实存在**（send 写 CommDB，Runner 只看 mailbox），但它**没有**告诉我们「如果 send 真写了 mailbox，idle Runner 会不会醒」。后者仍是唯一的实证未知（§5）。

### 为什么 `respond` 能醒但 `send` 不能

| 命令 | 写入 | Runner 怎么收到 |
|---|---|---|
| `flywheel-comm respond`（gate 答复） | CommDB `type='response'` | Runner 阻塞在 `flywheel-comm gate` 里，每 15s poll CommDB → 能收到 |
| `flywheel-comm send`（instruction） | CommDB `type='instruction'` | 只能靠 PostToolUse hook 注入；idle 在 `❯`（无 tool call）+ sentinel 短路 → **永远收不到** |

`awaiting_review` 的 Runner idle 在 `❯`，**既不在 gate poll 里，也没有 tool call 触发 hook**。所以 send 的唯一可行唤醒 = 写 mailbox。

---

## 2. 身份子问题实证 → A3-corrected（**这是本次 Research 的核心发现**）

### 2.1 Runner mailbox 身份是确定性派生的

生产路径上 Runner 的 Agent Team 身份由 **唯一来源** `buildAgentTeamIdentity()` 决定
（`packages/teamlead/src/bridge/run-dispatcher.ts:64-90`）：

```ts
function buildAgentTeamIdentity(executionId, leadId) {
  if (resolveCommBackend() !== "mailbox") return {};   // rollback: 不用 Agent Team
  if (!leadId) return {};
  return {
    runnerAgentName: `runner-${executionId.slice(0, 8)}`,  // ← agentName
    agentTeamName: leadId,                                  // ← teamName
    vendor: "claude-code",
  };
}
```

这三个值经 `BlueprintContext` → `TmuxAdapter.tryBuildTransportSpawnConfig`
（`TmuxAdapter.ts:465-495`）→ `ClaudeCodeAdapter.buildRunnerSpawnConfig`
（`ClaudeCodeAdapter.ts:263-293`）落成 spawn flag：

```
--agent-name  runner-<execId前8位>
--team-name   <leadId>
```

claude-code 内建 `useInboxPoller` 据此 poll 的 inbox 路径
（`path-helpers.ts:110-116`，`getClaudeInboxPath(leadName, agentName)`）：

```
<CLAUDE_CONFIG_DIR>/teams/<sanitize(leadId)>/inboxes/<sanitize("runner-<execId前8位>")>.json
```

**结论**：inbox 路径 = `f(executionId, leadId)`，纯函数，无任何运行时可变状态。

### 2.2 Brainstorm 判 A3「不 invariant」是 conflation error

Brainstorm §4 A3 反对理由：「`actions.ts:680` 用 `session.agent_name` override，约定其实已经不成立」。

实证：`actions.ts:680` 的 `session.agent_name` 是 **`StateStore.sessions` 表（Bridge 的 sql.js DB）** 的列
（`StateStore.ts:377` `ALTER TABLE sessions ADD COLUMN agent_name TEXT`），语义是 **FLY-137 dispatcher key**
——「retry 时让 Runner 留在同一个 named agent 配置上」。

这跟 mailbox 的 `runnerAgentName`（`runner-${execId.slice(0,8)}`，在 `flywheel-comm` 的 CommDB 里、由 `buildAgentTeamIdentity` 派生）**是两个不同数据库里的两个不同字段**：

| | StateStore.sessions.agent_name | mailbox runnerAgentName |
|---|---|---|
| DB | Bridge sql.js (`StateStore`) | 派生值（不落 CommDB） |
| 语义 | FLY-137 dispatcher key（选哪个 named agent） | claude-code inbox 文件名组件 |
| 可变? | 可被 Lead override | **恒为 `runner-<execId前8位>`** |
| 影响 mailbox 路径? | **否** | 是 |

→ Mailbox 身份 **invariant**。A3 的反对理由不成立。Brainstorm 的 A3 框架本身也写错了
（它写的是 `agentName == execId`；真实约定是 `agentName == runner-${execId.slice(0,8)}`）。

### 2.3 A1 vs A3-corrected 重新权衡

| 维度 | A1（migration + 存列） | A3-corrected（shared helper + 读时派生） |
|---|---|---|
| Schema migration | 需要（CommDB sessions 加 2 列） | **不需要** |
| 写入点改动 | 3 个 `registerSession` caller 都要塞身份 | 0 |
| 消费端 | `SELECT agent_name,team_name` | `SELECT lead_id` + 调 helper 派生 |
| 与派生函数解耦 | 完全解耦 | 共用 helper（单一 source of truth） |
| 「隐性约定」脆弱性 | 无 | **用 shared helper 消除**（不是 hardcode 字符串） |
| 代码量 | 多（migration + 3 写点 + 读点 + 测试） | 少（helper + 读点 + 测试） |

**推荐 A3-corrected**：符合项目「enforce simplicity / min surface change」。脆弱性靠**抽 shared helper** 解决，而不是靠 migration。

> ⚠️ 关键实现要求：派生字符串 `runner-${execId.slice(0,8)}` **绝不能**在 `send.ts` 里硬编码。必须从 `buildAgentTeamIdentity` 抽出共享 helper（建议放 `packages/agent-team-transport`，它本来就 own identity），两边 import。否则哪天有人改派生规则，`send.ts` 会静默断 —— 这正是 Brainstorm 担心的脆弱性，shared helper 是正解。

### 2.4 `lead_id` 在生产路径可靠填充

A3 依赖 `sessions.lead_id` 非空。审计所有 `registerSession` 写入点：

| 写入点 | 传 leadId? | 生产是否触发 |
|---|---|---|
| `run-dispatcher.ts:246` (pre-register) | ✅ `leadId` | ✅ Bridge dispatch 主路径 |
| `TmuxAdapter.ts:379` (spawn 时) | ✅ `ctx.leadId` | ✅ 每次 spawn |
| `flywheel-comm/index.ts:388` (`sessions register` CLI) | 取决于 `--lead` | ❌ **生产从未调用**（全仓 grep 仅 help text `index.ts:37` 引用，无任何 sh/blueprint 触发） |

`registerSession` 是 `INSERT OR REPLACE`（`db.ts:393`）。两个生产写入点都传 leadId，且 CLI self-register 路径根本没被用 → **不存在 lead_id 被 null 覆盖的 race**。A3 安全。

---

## 3. Mailbox 写入对 team config 的依赖（开放问题 #2 → 解决）

实证 `writeMailboxEntry`（`ClaudeMailboxCodec.ts:112-113`）：

```ts
// Validate parent dir exists; lazy mkdir for ephemeral test dirs.
await mkdir(dirname(spec.inboxPath), { recursive: true });
```

→ 写 Runner inbox **会 lazy mkdir inbox 目录，不依赖 team `config.json` 预先存在**。写入侧零 bootstrap 依赖。

至于 Runner 端 `useInboxPoller` 的初始化是否需要 team config —— 那是 claude-code 内部行为，且发生在 **Runner spawn 时**（spawn 已带 `--team-name`/`--agent-name`，poller 已起）。`send.ts` 写文件时 poller 早已在跑。所以开放问题 #2 对 FLY-168 的写入路径 **不构成约束**。

---

## 4. Sentinel 边界（开放问题 #4 → 解决）

dual-write 后 sentinel 语义保持正确：

- **mailbox 模式（默认）**：`send.ts` 写 mailbox（唤醒）+ 写 CommDB（审计/rollback）。sentinel 让 `inbox-check.sh` no-op —— 正确，CommDB 这份纯审计，不重复注入。
- **rollback（`FLYWHEEL_COMM_BACKEND=commdb`）**：`TmuxAdapter` 不写 sentinel（`TmuxAdapter.ts:293-300`）+ 注 `FLYWHEEL_DISABLE_MAILBOX_SENTINEL=1`。此时 `send.ts` **必须跳过 mailbox 写**（用同一个 `resolveCommBackend()` 判断），只写 CommDB，hook 走 legacy 注入。
- **sentinel 残留 / 用户手动 rm**：mailbox 写是 best-effort，CommDB 始终写。sentinel 在不在只影响 hook 那条兜底路径，不影响 mailbox 主路径。

→ `send.ts` 的 backend 判断必须复用 `resolveCommBackend()`（与 `buildAgentTeamIdentity`、`plugin.ts` 一致），不要新造判断逻辑（FLY-142 Codex r1 已经踩过 strict-check vs lenient-check 不一致的坑，见 `run-dispatcher.ts:71-77` 注释）。

---

## 5. 唯一剩余实证未知：idle Runner 的 useInboxPoller 唤醒（开放问题 #1）

**架构层面高置信**：Runner 跟 Lead 跑的是同一个 claude-code 二进制、同样的 Agent Team flag（`--team-name`/`--agent-name`）。Bridge→Lead 的 mailbox 唤醒已在生产跑了 10+ 天（FLY-142 PR #186）。Runner 用同样机制。

**但仍未在 Runner「idle 在 `❯` prompt + `awaiting_review`」这个精确静态条件下实测过**。Lead 平时未必真的 idle 在裸 prompt，而事故里的 Runner 是。

→ **建议 implement 阶段先跑一个 minimal spike**：
1. 起一个真 Runner（QA framework A1 slot），让它跑到 idle 在 `❯`。
2. 手写一条 mailbox entry 到它的 inbox（`teams/<leadId>/inboxes/runner-<execId前8位>.json`）。
3. 观察 Runner 是否在 poll 周期内自动醒、消费、回应。
4. PASS → 继续按 plan 实现；FAIL → **暂停升级，问 Annie**（按 Brainstorm §5.3，可能需要额外 tmux nudge，那是 product 决策）。

spike 必须用真 Runner + Chrome 观察（参照 QA E2E 标准），mock 无法验证 claude-code 内建 poller 的 idle 行为。

---

## 6. 最小改动面（给 Plan 阶段）

| 文件 | 改动 | 估算 |
|---|---|---|
| `packages/agent-team-transport/src/...`（identity helper） | 抽 `deriveRunnerMailboxIdentity(execId, leadId)` export；重构 `buildAgentTeamIdentity` 调它 | ~15 行 + 单测 |
| `packages/flywheel-comm/src/commands/send.ts` | CommDB insert 后：若 `resolveCommBackend()==='mailbox'`，`SELECT lead_id`→ helper 派生身份 → `AgentTeamTransportFactory.fromEnv()` + `MailboxTransport.writeVerified`，best-effort（catch+log，不阻断 CommDB） | ~40 行 |
| `send.ts` CLI 入口 | 确保 `dbPath`/`projectName` 能拿到（已有） | 小 |
| 测试 | (a) helper 单测 (b) send dual-write 集成（mailbox 写入 + CommDB 审计都在）(c) rollback：backend=commdb → 不写 mailbox (d) lead_id 缺失降级 | 中 |
| spike | idle Runner 真机唤醒验证（§5） | 1 次 |

### 不在本次 scope（标记）

- `respond.ts` 不改：gate 答复靠 Runner 在 `flywheel-comm gate` 里的 15s CommDB poll，已工作。若要一致性也 dual-write，另开 issue。本 issue 标题就是 `send`。
- 不动 Lead identity rules（Lead UX 不变，仍只记 execId）。
- 不动 CommDB schema。

---

## 7. 决策

**Option A + A3-corrected**：
- `flywheel-comm send` 在 mailbox 模式下双写 mailbox（唤醒）+ CommDB（审计/rollback）。
- 身份从 `sessions.lead_id` + `execution_id` 经 **shared helper** 派生，零 migration。
- backend 判断复用 `resolveCommBackend()`，rollback 路径完整。
- mailbox 写 best-effort，不阻断 CommDB。

**升 Plan 前唯一 gate**：§5 的 idle-wake spike 必须 PASS（FAIL 则问 Annie）。其余开放问题（#2 team config、#4 sentinel）已实证解决，无需 Annie 拍板的 product trade-off。

---

## 8. 下一步

→ Phase 3: Plan（`doc/engineer/plan/draft/v1.28.x-FLY-168-comm-send-mailbox-dual-write.md`）
→ Plan 写完跑 `/codex-design-review`
→ Codex approved 后**暂停等 Annie GO** 再 `/implement`（spike 在 implement 早期跑）
