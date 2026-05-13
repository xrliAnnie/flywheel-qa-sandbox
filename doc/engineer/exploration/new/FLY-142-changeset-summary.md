# FLY-142 Changeset Summary — Vendor-Neutral Mailbox Transport (4-PR Stack)

**Issue**: FLY-142 — Runner doesn't wake on Lead respond
**Date**: 2026-05-11
**Plan**: `doc/engineer/plan/inprogress/v1.27.1-FLY-142-agent-team-full-mirror-vendor-neutral.md`
**PR Stack**: #177 → #178 → #179 → #181 (squash-ship as one unit; Path 1 decision)
**Status**: 全部 Codex APPROVED + CI 绿，待 QA E2E

---

## 0. 一句话

把 Lead↔Runner 通信从「CommDB SQLite + PostToolUse hook」整套换到「vendor-neutral mailbox + claude-code 内建 `useInboxPoller`」。**抽象层只 import adapter package**，未来切 Codex / 其他 vendor 只换 adapter 实例。同步 fix 掉 FLY-142 wake bug。

---

## 1. PR 拆分（why 4 PRs）

按 Annie 2026-05-09 决策（"我们一定不能绑定在 Claude Code 上面"），Batch 1 切成 4 个独立 reviewable PR，每个都自带测试。Squash 时合一个 commit 进 main。

| PR | 范围 | 行为变化 |
|----|------|----------|
| **#177** PR 1.1 | 新 package `packages/agent-team-transport/`（types + ClaudeCodeAdapter + CodexAdapter stub + 全套 compat 测试） | 无 — 仅引入抽象 |
| **#178** PR 1.2 | Runner spawn + Lead launcher wiring（`TmuxAdapter` + `claude-lead.sh` 接 transport） | 无 — opt-in via ctx，默认不启用 |
| **#179** PR 1.3 | `MailboxTransport` + `StructuredInboxRouter` 两个 mailbox 消费 class | 无 — 类存在但 Bridge 没 instantiate |
| **#181** PR 1.4 | Mailbox cutover — Bridge 切到 `MailboxLeadRuntime`，写 sentinel，prompt rule 教 `SendMessage` | **行为切换**：默认 `FLYWHEEL_COMM_BACKEND=mailbox`，wake bug 在这里 fix |

只有 #181 翻 default，前 3 个 PR 是「死代码」级别的安全引入。

---

## 2. 各 PR 关键改动

### PR #177 — `agent-team-transport` package（~4K lines）

**新文件**：
- `src/types.ts` — 5 个拆细的 interface（`IMailboxWriter` / `IMailboxReader` / `IReceiverWakeTransport` / `IAgentSpawnTransport` / `ITransportPreflight`）+ 聚合 `IAgentTeamTransport` + `TransportCapabilities`（vendor-leak-free）
- `src/claude/ClaudeCodeAdapter.ts` — 完整实现，封装 stock claude-code 的 mailbox 路径 + `useInboxPoller` 行为
- `src/claude/ClaudeMailboxCodec.ts` — 跟 stock `proper-lockfile` 协作的原子写 + 两阶段 sidecar（pending → finalized）做 `flywheelId` idempotency
- `src/claude/team-bootstrap.ts` — 跟 claude-code `teamHelpers.ts` 完全对齐的 TeamFile schema（createdAt + members[].{joinedAt, tmuxPaneId, cwd, subscriptions}）
- `src/codex/CodexAdapter.ts` — stub，每个方法都 throw "not implemented"（loud-fail boot）
- `src/AgentTeamTransportFactory.ts` — env-driven adapter 选择（`FLYWHEEL_AGENT_BACKEND` 默认 `claude-code`）
- `bin/grep-gate.ts` — CI script，enforces "Bridge / StateStore / hooks 不准直接 import claude-code 内部"

**测试**：91/91 PASS（含 60s 并发 200 写 0 message loss、idempotency 100x same `flywheelId` → 1 main entry + 1 finalized sidecar、real claude CLI preflight 1.27s）

### PR #178 — Runner spawn + Lead launcher wiring（~600 lines）

**改动**：
- `packages/core/src/adapter-types.ts` — RunnerSpawnContext 新增可选字段：`agentName` / `teamName` / `leadSessionId` / `agentColor` / `vendor`
- `packages/claude-runner/src/TmuxAdapter.ts` — 可选 `transport` ctor 参数 + `tryBuildTransportSpawnConfig()`，把 adapter 给的 env+args merge 到 tmux `new-window` 调用
- `packages/teamlead/scripts/claude-lead.sh` — `eval "$(agent-team-transport lead-env|lead-args)"` pattern，启动时 propagate env 到 Lead tmux pane + 跑 preflight gate

**Backward compat**：所有改动 opt-in。`transport` 默认 `undefined` → 走原 path；transport throw 非致命，回退到 no-transport spawn。

**测试**：claude-runner 149/149 + shell 5/5（含对抗性 quote-safety：空格 / 单引号 / `$VAR` 字面 / 换行全部 eval round-trip 安全）

### PR #179 — `MailboxTransport` + `StructuredInboxRouter`（~1080 lines）

**新文件**：
- `packages/teamlead/src/mailbox/MailboxTransport.ts` — `IMailboxWriter`+`IMailboxReader` 的 facade。核心方法 `writeVerified`：写 + read-after-write 校验，mismatch throw `MailboxWriteError`（plan §2.7）
- `packages/teamlead/src/mailbox/StructuredInboxRouter.ts` — chokidar 监 `<FLYWHEEL_STATE_DIR>/inbox-structured/<lead>/requests/`。**有意放在 vendor inbox 路径之外**，跟 stock `useInboxPoller` 不会 race（Codex r2 critical #2）

**行为边界**：PR 1.3 不翻任何 default。两个 class 存在但 Bridge / teamlead 任何代码都没 instantiate。

**测试**：23/23 PASS（9 MailboxTransport + 14 StructuredInboxRouter，含 corrupt JSON / missing request_id / callback throw 三种失败 mode）

### PR #181 — Mailbox cutover（~1130 lines） — **wake bug 实际 fix 处**

**关键改动**：
- `packages/teamlead/src/bridge/mailbox-lead-runtime.ts` — 新 `MailboxLeadRuntime` impl，`deliver` / `sendBootstrap` / `health` / `shutdown`。`formatEnvelope` 跟 `CommDBLeadRuntime` 逐行对齐（保 prompt parity）。Deterministic `flywheelId` 走 sidecar dedupe。3s 写超时。
- `packages/teamlead/src/bridge/plugin.ts` — `createLeadRuntime` factory 按 `FLYWHEEL_COMM_BACKEND` 选 runtime；**默认翻到 `"mailbox"`**
- `packages/claude-runner/src/TmuxAdapter.ts` — Runner spawn 时写 `~/.flywheel/runner-state/<exec>/mailbox-active` sentinel + 注入 `FLYWHEEL_RUNNER_STATE_DIR` env
- `scripts/hooks/inbox-check.sh` — 看到 sentinel 直接 `exit 0` no-op，让任何漏写到 CommDB 的 instruction 不会跟 mailbox 路径打架；`FLYWHEEL_DISABLE_MAILBOX_SENTINEL=1` 是 escape hatch
- `packages/teamlead/lead-rules-base/runner-messaging-rules.md` — 新 prompt rule：日常 DM 用 `SendMessage` MCP tool；hard gate (`approve_to_ship` / `clarify_question`) 仍走 `flywheel-comm respond`（Batch 2 才换）

**测试**：65/65 PASS（48 mailbox + 17 hook 含 4 个新 sentinel 测试）

---

## 3. Vendor-Neutral 怎么体现

| 层 | 中立性证据 |
|----|-----------|
| **Interface 拆细** | `IMailboxWriter` / `IMailboxReader` / `IReceiverWakeTransport` / `IAgentSpawnTransport` / `ITransportPreflight` 各自独立。Codex r1 medium #7 要求：删 vendor-leak 字段（`identityFlagNames`、`hasRemoteKillswitch`），改用通用 `availabilitySignals[]` |
| **`TransportCapabilities`** | `wakeMode: "builtin-receiver" \| "external-watcher" \| "push-only"` —— claude-code 是 builtin（用 `useInboxPoller`），未来 Codex 是 external watcher（用 `IMailboxWatcher.start()/stop()/health()`） |
| **`ClaudeCodeAdapter`** | 唯一一处 `import` claude-code 内部约定的地方。`createReceiver()` 返回 `null`（builtin 不需要 watcher）；`buildRunnerSpawnConfig()` 输出 vendor-specific CLI args (`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` / `--agent-id` / `--agent-name` / `--team-name` / `--parent-session-id`) |
| **`CodexAdapter` stub** | 每个方法 throw "not implemented"。Plan §11 写了 plug-in guide，估 1-2 周可补完。`FLYWHEEL_AGENT_BACKEND=codex` 在 boot 时 loud-fail 而不是 silent fallback |
| **路径** | `CLAUDE_CONFIG_DIR`（claude-code native 路径权威） + `FLYWHEEL_STATE_DIR`（vendor-neutral，给 structured-inbox / sentinel 用） |
| **`grep-gate.ts`** | CI script，扫 Bridge / StateStore / await-mcp / flywheel-ship / hooks 不准直接 `import` claude-code internals。当前 tree 自检 PASS |
| **MailboxPayload** | flywheel 自己定义的 semantic：`from` / `to` / `content` / `metadata?.flywheelId` idempotency key。Adapter 各自把 envelope 翻译成 vendor wire format |

**底线**：未来切 Codex = 写 `CodexAdapter` + 在 factory 加一个 case + 翻 `FLYWHEEL_AGENT_BACKEND=codex`。Bridge / StateStore / await-mcp / flywheel-ship / hooks 不动一行代码。

---

## 4. Runner Wake Bug 怎么 fix

### 4.1 旧路径（broken）

```
Runner   ──ask──► CommDB.messages (type='question')
                      │
                      ▼
Lead     ──respond──► CommDB.messages (type='response')
                      │
                      ▼
        inbox-check.sh PostToolUse hook
        SELECT WHERE type='instruction'   ← 只看 instruction！
                      │
                      ▼
        type='response' 永远不被读取 → Runner 永远不醒
```

`scripts/hooks/inbox-check.sh` 历史上只 filter `type='instruction'`，Lead `respond` 写的 `type='response'` 行没人读。Runner system prompt 告诉它 "use `flywheel-comm check {question_id}`"，但没机制提醒它何时 check —— Runner 就 idle 死等。

### 4.2 新路径（fixed）

```
Lead 进程内
  ├─ MailboxLeadRuntime.deliver()
  │     └─ MailboxTransport.writeVerified()
  │           └─ ClaudeCodeAdapter.write()
  │                 └─ atomic temp+rename 到
  │                    ~/.claude/teams/<lead>/inboxes/<runner>.json
  ▼
~/.claude/teams/<lead>/inboxes/<runner>.json   ← stock mailbox 文件
  ▼
Runner (claude-code CLI, 已 enroll 为 teammate)
  └─ useInboxPoller（claude-code builtin，1s tick）
        └─ 新 message → 直接 inject 到 conversation 当 user turn
```

**关键差别**：
1. **Bypass hook**：mailbox 是 stock claude-code 路径，wake 走的是 builtin `useInboxPoller`，跟 `inbox-check.sh` 完全无关
2. **Hook 主动短路**：Runner spawn 时 `TmuxAdapter` 写 `mailbox-active` sentinel；`inbox-check.sh` 看到 sentinel 直接 `exit 0`，避免任何 CommDB 残留写造成混淆
3. **`flywheelId` idempotency**：caller 提供 stable id（await-mcp 用 `request_id`，Bridge actions 用 `eventId`，Lead respond 用 source message id），adapter 走 sidecar dedupe 保证 retry 不重复
4. **Prompt rule 同步换路**：`runner-messaging-rules.md` 教 Lead 用 `SendMessage` MCP tool 而不是 `flywheel-comm send`

### 4.3 Hard gate 仍走 CommDB（**有意不动**）

`approve_to_ship` / `clarify_question` 这类 gate 还走 `flywheel-comm respond` + CommDB —— Codex r3 critical #1 要求的 sequencing：Batch 1 先 mailbox cutover，Batch 2 PR 2.1 再把 gate 换成 `await-mcp` + `StructuredInboxRouter`。

理由：Runner 端 `flywheel-comm gate wait` 是主动 poll CommDB（`getResponse(questionId)`），不依赖 `inbox-check.sh`，本来就不受 wake bug 影响，可以等 Batch 2 一起换。

---

## 5. Rollback Path

如果 mailbox 路径生产环境出问题：

**Step 1 — Bridge 侧切回 CommDB runtime**
```bash
# 给 Bridge daemon 加 env
export FLYWHEEL_COMM_BACKEND=commdb
# 重启 Bridge daemon
restart-services.sh bridge   # 或 launchctl unload/load 对应 plist
```
Bridge 收到 env 后 `createLeadRuntime` 工厂会 instantiate `CommDBLeadRuntime`（PR #181 保留它当 rollback runtime）。Lead bot 行为回到 PR #181 之前。

**Step 2 — 个别 Runner 切回 hook 路径（可选）**

如果只想个别 Runner 回退（其他 Runner 继续吃 mailbox）：
```bash
# 选项 A：删 sentinel
rm -f ~/.flywheel/runner-state/<exec>/mailbox-active
# 选项 B：env 短路
export FLYWHEEL_DISABLE_MAILBOX_SENTINEL=1
```
然后 `inbox-check.sh` 会重跑 legacy path（读 `type='instruction'`）。

**代价**：wake bug 回来。但 incident 期间可以用 `tmux send-keys` 救急（plan §3 文档了窗口期 fallback）。

**Plan §D-3** 写了完整 8-failure-mode runbook，Batch 2 PR 2.4 会落地。

---

## 6. 测试矩阵（4 个 PR 累计）

| 测试范围 | 数量 | 关键覆盖 |
|---------|------|---------|
| `flywheel-agent-team-transport` 包 | 91 | path / codec / team-bootstrap / adapter / factory / cli / grep-gate；含 60s 并发 200 写 0 loss、idempotency 100x、real CLI preflight |
| `flywheel-claude-runner` | 149 | TmuxAdapter spawn 5 新 transport 测试 + 90 行 sentinel 测试 |
| Shell wiring integration | 5 | quote-safety 对抗性 eval round-trip |
| `flywheel-teamlead` mailbox | 23 | MailboxTransport (9) + StructuredInboxRouter (14) |
| `mailbox-lead-runtime` | 17 | happy / format parity / throw → delivered=false / write timeout bounded / flywheelId determinism / sendBootstrap throws / health transitions |
| `inbox-check.sh` hook | 17 | 4 新 sentinel + 13 pre-existing CommDB 回归 |
| **合计** | **~302** | 全绿 |

CI gate：`grep-gate` 自检通过，所有 4 PR 远端 CI 绿。

---

## 7. 待 QA 验证项（给 qa-fly-142）

1. **Wake bug 真消失** — 真起 Lead + Runner，Lead 发 DM，验证 Runner 在 1s 内 wake 并响应（不再 idle 死等）
2. **Mailbox 落盘** — `~/.claude/teams/<lead>/inboxes/<runner>.json` 有新 message 行，`.flywheel.jsonl` sidecar 有对应 finalized 条目
3. **Sentinel 生效** — Runner spawn 后 `~/.flywheel/runner-state/<exec>/mailbox-active` 存在；故意写 CommDB instruction 进去后 hook 应 no-op
4. **Idempotency** — 同 `flywheelId` 重复写 → mailbox 主文件只 1 条
5. **Rollback drill** — 设 `FLYWHEEL_COMM_BACKEND=commdb` 重启 Bridge → 行为回到旧 CommDB 路径（应该 wake bug 复现，证明 rollback 真切了 runtime）
6. **Hard gate 不退化** — `flywheel-comm respond` 对 `approve_to_ship` 类 gate 仍 work（Batch 2 才换）
7. **Prompt rule 加载** — Lead 真按 `runner-messaging-rules.md` 用 `SendMessage` 而不是 `flywheel-comm send`

---

## 8. Codex Review 历史

| PR | Rounds | 最终状态 |
|----|--------|---------|
| #177 | 5 (R1=11 → R2=7 → R3=5 → R4=3 → R5 APPROVED w/ 3 low-priority notes folded) | APPROVED |
| #178 | （多轮）含 adversarial quote-safety 修复 | APPROVED |
| #179 | （多轮）含 chokidar awaitWriteFinish + corrupt JSON 处理 | APPROVED |
| #181 | R1 修：gate sentinel on backend + monotonic seq | APPROVED |

---

## 9. 文件改动一览（squash 后会进 main 的）

```
新 package
  packages/agent-team-transport/                  (~4K lines)

现有 package 增量
  packages/core/src/adapter-types.ts              (+29)
  packages/claude-runner/src/TmuxAdapter.ts       (+163)
  packages/claude-runner/src/TmuxRunner.ts        (+13)
  packages/teamlead/src/mailbox/                  (~1080 lines, 全新)
  packages/teamlead/src/bridge/mailbox-lead-runtime.ts (+347)
  packages/teamlead/src/bridge/plugin.ts          (+59)
  packages/teamlead/lead-rules-base/runner-messaging-rules.md (+57)
  packages/teamlead/scripts/claude-lead.sh        (+79)

Hooks + scripts
  scripts/hooks/inbox-check.sh                    (+27)
  scripts/hooks/test-inbox-check.sh               (+126)
  scripts/spike-mailbox-wake.sh                   (+128)

测试
  各包 __tests__/  + .test.sh                     (~2.5K lines)

文档
  doc/engineer/exploration/new/FLY-142-option4-detail.md
  doc/engineer/exploration/new/FLY-142-runner-wake-bug-audit.md
  doc/engineer/exploration/new/FLY-142-changeset-summary.md   ← 本文档
  doc/engineer/implementation/v1.27.0-FLY-142-spike-results.md
  doc/engineer/plan/inprogress/v1.27.1-FLY-142-agent-team-full-mirror-vendor-neutral.md
```

---

## 10. 已知不在本批次（Batch 2 scope）

- Hard gate 路径切 `await-mcp` + `StructuredInboxRouter`（PR 2.1）
- `flywheel-ship` capability control（PR 2.2）
- GrowthBook killswitch + telemetry（PR 2.3）
- Runbook 8 failure modes 落地（PR 2.4）
- `CodexAdapter` 真实现（独立 sprint，~1-2 周）
