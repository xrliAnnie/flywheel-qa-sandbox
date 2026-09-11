# FLY-1942 通信层防线三件套 — 调研
Issue: FLY-1942 (https://linear.app/geoforge3d/issue/FLY-1942/通信层防线-三件套发信短-id-静默死信-bot-永久偷听-guard-误拦并-19431953)
日期: 2026-09-11
基于: exploration.md

本文只回答「exploration §4 的推荐设计落到代码上碰哪些接口、被哪些既有合同约束、怎么测、怎么上线」。事实与证据在 exploration §2,不重复。

## 1. 第一件:收件人校验层

### 1.1 接线点

| 层 | 文件 | 现状 | 改动形态 |
|---|---|---|---|
| CLI 参数 | `packages/flywheel-comm/src/index.ts:876-915` `runSend` | `--to` 非空即过 | stdout 仍单行 id;verify 提示与前缀回显到 stderr;`--json` 加 `resolved_to` / `resolved_from_prefix` / `verify_command`;**无 override flag**(R1 #1) |
| 命令体 | `packages/flywheel-comm/src/commands/send.ts:18-38` | `insertInstructionWithId` 直写 | 在 `authorizeLeadWrite` 之后、`insertInstructionWithId` 之前调用 `resolveRunnerRecipient({commDb, stateStore}, args.toAgent)`,用其 `executionId` 作 `toAgent`;`send(): Promise<string>` 签名保留,另加 `sendDetailed()`;`stateStore` 为只读快照读者(注入 seam) |
| 命令体 | `packages/flywheel-comm/src/commands/respond.ts:40-110` | 收件人 = `question.from_agent` | 非 gate 问题(无 `checkpoint`、id 不以 `workflow-gate:` / `turn-wait:` / `turn-wake-alert:` 开头)在 `insertGuardedResponse` 前做同一终结检查;gate 类跳过 |
| 新 helper | `packages/flywheel-comm/src/recipient-resolve.ts`(新)、`session-terminal.ts`(新,`isMailboxTerminalStatus` 单一来源,StateStore re-export;`package.json` exports 加 `./session-terminal`) | — | 纯函数 + 只读 SQL;见 §1.2 |
| 类型 | `packages/flywheel-comm/src/types.ts` | — | 导出 `RecipientResolution` 与错误码枚举 |

`insertInstructionWithId`(`db.ts:4300-4336`)**不改**:`send-mailbox.test.ts:57` 的「session 行存在之前 mailbox 行可入队」合同保留;引擎内部写入者(`design-review-manifest.ts:234`、`codex-instruction.ts:150,161`、`event-route.ts:381,516`、`account-switch-consumer.ts:34,202`、`plugin.ts:12977`、`commdb-lead-runtime.ts:58-79`、`land-cleanup-opportunity.ts:34`)不经过新 helper。

### 1.2 `resolveRunnerRecipient` 合同

输入 `raw: string`。判定顺序(每步只读):

1. `raw === "lead"` 或 `raw.endsWith("-lead")` ⇒ `{kind:"lead", toAgent: raw}`(lead 收件人不在本单,原样透传;这是 `db.ts:4327` 现有 recipient_kind 猜测的同一谓词,复用不复制)。
2. 形态:`/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i` ⇒ 全 ID;`/^[0-9a-f-]{8,35}$/i` 且首 8 位为 hex ⇒ 前缀;其他 ⇒ `RecipientMalformed`(exit 2,与现有 usage 错误同码)。
3. 存在性:`SELECT execution_id, project_name, issue_id, lead_id FROM session_receipt_lineage WHERE execution_id = ?`(全 ID)或 `WHERE execution_id LIKE ? || '%' LIMIT 3`(前缀;`?` 由参数绑定,前缀先经形态门,不含 `%`/`_`)。0 行 ⇒ `RecipientNotFound`;≥2 行 ⇒ `RecipientAmbiguous{candidates}`;1 行 ⇒ 展开。
4. 终结(v3/v4,R2 #1):**只读 StateStore 快照**(`TEAMLEAD_DB_PATH ?? ~/.flywheel/teamlead.db`,better-sqlite3 `{readonly:true}`,`SELECT status FROM sessions WHERE execution_id = ?`),谓词 = 队列同一个 `isMailboxTerminalStatus`(`TERMINAL_STATUSES` − `awaiting_review`)。终态 ⇒ `RecipientTerminal`;StateStore 无行 ⇒ 放行(lineage 已证存在,队列按 missing 处理);快照不可读 ⇒ 放行 + stderr `liveness_unverified`。**CommDB `sessions.status` / `ended_at` / 行是否存在均不参与**——adapter 会独立写 CommDB `completed|timeout|blocked` 而 StateStore 仍 `awaiting_review`(parked-alive,FLY-229 合同保留)。无 override flag。
5. 返回 `{kind:"runner", executionId, resolvedFromPrefix: boolean, issueId, leadId}`。

错误都是 `Error` 子类带 `code`,CLI 统一映射:`recipient_malformed`→exit 2;`recipient_not_found`/`recipient_ambiguous`/`recipient_terminal`→exit 1;stderr 一行 `flywheel-comm send: <code>: <human text> (hint: flywheel-comm sessions list --project <p>)`。

lineage 覆盖边界:lineage 由 FLY-1573 引入,更早的会话无行——它们全部 terminal,`RecipientNotFound` 是可接受的答案。输入先 `toLowerCase()` 规范化,`=` 与 `LIKE` 行为一致。

### 1.3 引擎侧三态

| 文件 | 行 | 改动 |
|---|---|---|
| `packages/flywheel-comm/src/mailbox-queue.ts` | `:53` `MailboxRecipientState` | `"alive" \| "terminal" \| "missing" \| "unknown" \| "terminal_or_missing"`(最后一个标 `@deprecated`,队列内部 `normalize()` 映射为 `terminal`) |
| 同上 | `:1959`、`:2047`(以及 `:1588-1596` 的 `terminalizeRecipientInbox`,它是显式 terminal,不变) | `state === "terminal" \|\| state === "missing"` 才终结;`dead_reason` / `last_error` 按 state 写 `recipient_terminal` 或 `recipient_missing` |
| `packages/teamlead/src/StateStore.ts` | `:1547-1551` `RunnerRecipientState`、`:11615-11629` | `state: "alive" \| "terminal" \| "missing"`;`!session` ⇒ `missing` |
| `packages/teamlead/src/bridge/runner-mailbox-lane.ts` | `:161`、`:245-254` | 类型跟随 |
| `packages/teamlead/src/bridge/lead-inbox-runtime.ts` | `:303-304`、`:1035` | 类型跟随;`stateLabel` 映射加 `missing` |
| `packages/teamlead/src/bridge/infra-alert-wiring.ts` | `:54`、`:178` | 类型跟随(它自己产 `unknown`) |
| `packages/teamlead/src/bridge/flag-retirement-production.ts` | `:113` | `primaryState === "terminal" \|\| primaryState === "missing"` |

`recipient_missing` 不进 `QUARANTINE_DEAD_REASONS`(`:127`),与 `recipient_terminal` 同为「终结类」。`dead_reason` 列无 CHECK 约束(schema 见 exploration §2.1),无迁移。

### 1.4 死信通知回落发信方

`mailbox-queue.ts:2202-2316`:owning-Lead 路径不变(按 recipient 聚合)。`resolveOwningLead(recipient)` 为空时进入 **per-(recipient, sender)** fallback(plan M2,R1 #3):对该 recipient 的 DEAD 行 `GROUP BY from_agent`,只取 `resolveSenderLead(from_agent)` 非空的发信方;每个 (recipient, sender) 独立 cursor(`source_ref = recipient + "\u001f" + sender`)、独立聚合与 summaries(`AND from_agent = ?`)、独立 id `dead_letter:<enc(recipient)>:<enc(sender)>:<through_seq>`、独立 rate-limit,`toAgent = sender`。lane 侧(`runner-mailbox-lane.ts:301-307`)传入 `resolveSenderLead = (fromAgent) => projectLeadIds.has(fromAgent) ? fromAgent : undefined`,`projectLeadIds` 由 `lead-inbox-runtime.ts` 从 `project.leads[].agentId` 构造。通知正文加一句 `dead_reason=recipient_missing: recipient <id> never had a session row — check the id you sent to.`。非 Lead 发信方(如 `bridge-land`)维持 unroutable。

### 1.5 规则与文案

- `packages/teamlead/lead-rules-base/runner-messaging-rules.md`:在 `## Driving a parked / idle Runner`(`:55`)之前插入 `## Recipient ID + post-send verification (FLY-1942)`;wake matrix `:70` 行文案改为 `✅ when the recipient exists and is not terminal — the CLI now rejects short / unknown / terminal ids (FLY-1942)`。`lead-rules-bundle.test.ts:187-204` 只钉文件顺序,不需改;若加断言则在 `:220-250` 的 `toContain` 家族里加一条钉新标题。
- `mailbox-lead-runtime.ts:451,475`、`hook-payload.ts:427,1428-1429` 的运行期指令串不改(它们讲的是 respond 的 gate 用法)。
- `runs-route.ts:1859` 已有的「re-engage via flywheel-comm send」提示不改。

### 1.6 测试目标

- `packages/flywheel-comm/src/__tests__/recipient-resolve.test.ts`(新):形态 × 存在 × StateStore 状态 × 快照可读性的真值表;前缀含 `%` 被形态门拒;lineage 两行同前缀 ⇒ ambiguous;StateStore `completed` ⇒ terminal;StateStore `awaiting_review`(CommDB 任意)⇒ 放行;StateStore 无行 ⇒ 放行;快照缺失 ⇒ 放行 + `liveness_unverified`;大写输入等价。
- `send-mailbox.test.ts`:`:57` 用例改为 `db.insertInstructionWithId` 直写(合同保留在 db 层);走 `send()` 的用例用 `seedRunnerSession(db, uuid)` 夹具(写 lineage + CommDB 行)并注入一个内存 StateStore 快照;另加「短 ID 唯一 ⇒ 展开后入队,`to_agent` 是全 ID」「短 ID 查无 ⇒ 不入队,mailbox 零行」。
- `cli.test.ts` `describe("send") :803`:exit 码与 stderr 文案;`--json` 字段;turn-wait 断言 `:655-657` 原样保留并在 plan 验证清单里点名。
- `respond-mailbox.test.ts` / `respond.gate.test.ts`:对 terminal 节点的普通问题 respond ⇒ exit 1 且 mailbox 零行;`turn-wait:` / `workflow-gate:` 问题不受影响。
- `mailbox-queue-capabilities.test.ts:941,977` 夹具改用四态;新增 `missing ⇒ dead_reason=recipient_missing`。
- `packages/teamlead/src/bridge/__tests__/runner-mailbox-lane.test.ts`、`lead-inbox-runtime.test.ts`:回落到发信方的通知一条且去重。
- `packages/teamlead/src/__tests__/fly2337-dead-mail-terminalization.test.ts`:现有 `terminal_or_missing` 断言改 `terminal`。

## 2. 第二件:订阅账本

### 2.1 接线点

| 文件 | 现状 | 改动 |
|---|---|---|
| `lead-backends/codex/RoundtableThreadRegistry.ts` | `Set<string>` | 向后兼容的纯内存状态机(plan M3,R1 #5/#7):无参构造与 `add(string)`/`list(): string[]` 保留;新增 `entries()`/`snapshot()`/`plan{Add,Remove,Touch,Sweep,Restore}()`(纯计算)与 `commit(next)`(唯一内存写入点);`has()` 惰性判过期 |
| `lead-backends/codex/roundtable-subscription-ledger.ts`(新) | — | `parseLedgerFile(path)`(无副作用 + schema 校验)/ `persistSnapshot(path, snapshot)`(唯一 tmp + `wx` + rename + finally 清理)/ `quarantineCorrupt(path)`(唯一名)/ `appendAudit(path, row)`(`appendRotatedLogSync` best-effort);wiring 的 `applyPlan` = persist → commit → source 副作用 → 审计 |
| `lead-backends/codex/roundtable-reply-in-thread-wiring.ts:118-146` | `subscribeImmediate` 无条件 | `resolveReplyRoute` 恢复纯函数;mention 订阅移到 `onTopicEngaged`(journal accepted-new 之后,R1 #4);变更走 persist→commit→side-effect 的 `applyPlan`(R1 #5);cap 由 registry `planAdd` 统一 |
| 同上 `start()/stop()` | 只启停 discovery | `start` = parse → planRestore → **persist 规范化快照** → commit(不经 add 回调)→ `source.addChannel` + 审计 `restore`;再起 60s sweep(`setTimer` 注入);`stop` 取消 sweep |
| `lead-backends/codex/RoundtableThreadDiscovery.ts:129-185` | 自己 add/remove/enforceCap | **只修不铸**(R2 #2):只剔除账本里已归档/未加入的条目、修复账本条目的轮询槽;从不新增;cap 由 registry 统一 |
| `LeadInputRouter`(journal accept 后) | `seedBudgetForRoute` | `onTopicEngaged` 内完成 mention 订阅(accepted-new 之后);新增 `onInputAccepted(entry: Pick<JournalEntry,"replyChannelId"\|"replyRoute">)` 在 `submit`/`submitBatch` 两个 accepted 分支都调用,wiring 据此 touch 已订线程(R2 #3) |
| `codex-lead-runtime.ts:664-668` 与 `codex-lead-tui-runtime.ts` 同段 | `FLYWHEEL_ROUNDTABLE_CHANNEL_ID \|\| crossDept[0]` | 删回退;新 env `FLYWHEEL_ROUNDTABLE_SUBSCRIPTION_TTL_MS`(默认 86_400_000,范围 [60_000, 7d]) |
| `scripts/flywheel-lead.sh:139-154` | 只导出 CROSS_DEPT | 同时 `export FLYWHEEL_ROUNDTABLE_CHANNEL_ID="$roundtable_channel"` |
| `packages/teamlead/scripts/run-codex-lead-mufasa-tui-fullaccess.sh:62` | `${…:-<rt>}` 可覆盖 | 保留(它已不是生产 launcher,plist 走 generic wrapper);仅加同名 `FLYWHEEL_ROUNDTABLE_CHANNEL_ID` 导出以免该脚本启动的进程关闭 reply-in-thread |
| `lead-backends/codex/CodexLeadInboxSocket.ts` | v2 `submitBatch` / `capabilities` | 新增 `listSubscriptions` / `unsubscribeThread {threadId, reason}`(同 HMAC、同 `parseRequest` 严格形态);server 端注入 `subscriptions?: {list(), remove(id, reason, actor)}` |
| `packages/teamlead/src/codex-lead-subscriptions-cli.ts`(新) | — | `list \| unsubscribe --thread <id> [--reason <r>] --lead <id> --project <name> [--json]`;state dir 用 `lead-inbox-runtime.ts:1204` `resolveCodexLeadStateDir`;bot token 用 `loadProjects()` 的 `lead.botToken`(与 Bridge `:1254` 同源);`list` 读账本文件(runtime 不在也能看);`unsubscribe` 走 socket,socket 缺失 ⇒ exit 3 `runtime not running`(不改文件,避免双写) |

### 2.2 账本形态

`<stateDir>/roundtable-subscriptions.json`(= plan `RegistrySnapshot`,顶层只有 `version` 与 `entries`;lead/parent 归属由 `planRestore(snapshot, expectedParent)` 在恢复时校验,错域条目丢弃并审计)
```json
{ "version": 1,
  "entries": [ { "threadId": "…", "parentChannelId": "…", "source": "mention|discovery|restore",
                 "subscribedAt": "ISO", "lastActivityAt": "ISO", "expiresAt": "ISO" } ] }
```
`<stateDir>/roundtable-subscriptions-audit.jsonl`:`{ts, op: add|remove|expire|evict|restore|reject, threadId, parentChannelId, reason, actor}`。`reject` 记录被域守卫拒绝的 route(threadId + 试图使用的 parent)。

### 2.3 消费者兼容

四个消费者只用 `{has}`(`mention-gate.ts:50`、`CodexDiscordGateway.ts:109`、RestPoll 通过 wiring)。`has(id)` 内部用 `clock()` 判过期,签名不变 ⇒ 消费者零改动;过期条目在下一次 sweep 才真正 `removeChannel`,期间 `has=false` 已足以让网关拒收(与 `passesFilters:282-287` 一致)。

### 2.4 测试目标

- `__tests__/RoundtableThreadRegistry.test.ts`:fake clock;TTL 到期 `has=false`;`touch` 续期;cap 驱逐最旧;`snapshot` 往返。
- `__tests__/roundtable-subscription-ledger.test.ts`(新):原子写、损坏文件 ⇒ 空账本 + 审计 `restore` 失败行;审计 append 失败不抛。
- `__tests__/roundtable-reply-in-thread.test.ts`:重放「父频道 @ 一次」⇒ 账本一条 + 审计 `add`;推进 fake 时钟过 TTL + 触发 sweep ⇒ `source.removeChannel` 被调、审计 `expire`、账本为空;非 roundtable 父频道的 route ⇒ 不订阅 + 审计 `reject`;重启(新 wiring 实例、同 ledger 路径)⇒ 未过期条目恢复。
- `__tests__/codex-lead-runtime.test.ts` / `codex-lead-tui-runtime.test.ts`:无 `FLYWHEEL_ROUNDTABLE_CHANNEL_ID` 但有 crossDept ⇒ `replyInThread` undefined(现有「resolvable parent (cross-dept)」用例反转,注释写明 FLY-1942)。
- `__tests__/CodexLeadInboxSocket.test.ts`:两个新方法的 HMAC 正负例。
- `packages/teamlead/src/__tests__/codex-lead-subscriptions-cli.test.ts`(新):list 读文件;unsubscribe 无 socket ⇒ exit 3。
- `scripts/__tests__/`(bash):`sanitize_codex_child_env` 导出两个变量。

### 2.5 现状约束

本机 2026-09-11 无 Codex lead runtime 进程(exploration §2.2 末)。实现阶段的「重放驱动一次回话」= 单测 fake source;生产回放需 Codex lead 上线,plan 的验证清单要把这条标为「条件性」。

## 3. 第三件:guard 客户端

### 3.1 两仓改动

**插件 fork(`xrliAnnie/claude-plugins-official`,基线 origin/main `e122f46` = 装机 0.0.7)**

| 文件 | 改动 |
|---|---|
| `external_plugins/discord/reply-guard-client.ts`(新) | `createReplyGuardClient({fetchImpl, now, env, audit})` → `evaluate(chatId, text, {roundtableThread}) : Promise<GuardOutcome>`;纯逻辑,可注入 |
| `external_plugins/discord/reply-guard-client.test.ts`(新) | bun:test |
| `external_plugins/discord/server.ts:364-468` | `callReplyGuard` / `guardDenyResult` 改为薄调用;`guardDenyResult` 在 `issues` 为空时省略 `Issues:`,追加 `probe=…` |
| `external_plugins/discord/.claude-plugin/plugin.json` | 0.0.7 → 0.0.8 |
| `external_plugins/discord/doc/`(若有 guard 文档) | 更新 fail policy 说明 |

**本仓**

| 文件 | 改动 |
|---|---|
| `packages/teamlead/scripts/claude-lead.sh:417-424` 附近 | 同样用 `loadProjects()` 派生 `LEAD_CHAT_CHANNEL=<lead.chatChannel>`(按 `PROJECT_NAME` + `LEAD_ID` 精确匹配) |
| `packages/teamlead/scripts/claude-lead.sh:2111` 同一 `env -i` 块 | `-e "DISCORD_OWN_CHAT_CHANNEL=${LEAD_CHAT_CHANNEL:-}"`(无条件设置,空则空,与 `DISCORD_CORE_CHANNEL` 同纪律) |
| `packages/teamlead/scripts/__tests__/`(bash) | 断言 env -i 块含该行 |
| `lead-rules-base/cross-dept-channel-rules.md` 或 `department-lead-rules.md` | 一句:guard 拒绝文本现在带 `probe=` 读数,上报时原文贴 |

Codex runtime 的 env allowlist(`codex-lead-runtime.ts:420-432`)**不加** `DISCORD_OWN_CHAT_CHANNEL`:Codex Lead 出站走 `/api/lead-outbound/send`(`plugin.ts:3217-3223`),不经 reply-guard。

### 3.2 `GuardOutcome` 合同

```
kind: "allow" | "deny" | "not_deployed" | "unauthorized" | "unavailable"
probe: { url, attempts, timeoutMs, outcome: "ok"|"http"|"abort"|"network",
         httpStatus?, error?, latencyMs, at }
local?: { classification: "core"|"roundtable_thread"|"own_top_level"|"other"|"legacy_broad",
          issueTokens: string[], decision: "allow"|"deny" }
deny?: { reason, issues?, guidance }
```

决策表(`unauthorized` 与 `unavailable` 共用「本地兜底」列):

| 目标频道 | Bridge 健康 | 本地兜底 |
|---|---|---|
| core(`DISCORD_CORE_CHANNEL`) | allow(Bridge) | allow |
| roundtable 线程(调用方 opts) | allow(Bridge "other") | allow |
| 自己 chat 频道顶层(`DISCORD_OWN_CHAT_CHANNEL`)+ 单号 | deny `issue_at_top_level`(Bridge) | deny `guard_unavailable` / `guard_unauthorized` |
| 自己 chat 频道顶层,无单号 | allow | allow |
| 其他任何频道(跨 Lead、founder、issue thread…) | allow / telemetry | **allow**,审计 `classification=other` |
| `DISCORD_OWN_CHAT_CHANNEL` 未注入 | — | 今天的宽 fail-closed(有单号即 deny),reason `guard_unavailable_legacy_broad` |

请求参数:`TEAMLEAD_REPLY_GUARD_TIMEOUT_MS`(默认 4000,`parseIntInRange` 夹到 [500, 10000],复用 `retry.ts` 的解析器)、重试 1 次仅对 `abort`/`network`(退避 250ms,注入 `sleep`);HTTP 状态不重试。404 ⇒ `not_deployed` ⇒ allow(保留现有语义)。

审计:`<DISCORD_STATE_DIR>/reply-guard-audit.jsonl`,非 `allow` 一律记 `{ts, leadId, chatId, kind, probe, local, deny.reason}`;`allow` 不记(避免每条回复一行)。轮转:复用插件内已有的文件写法(`chat-receipt-runtime.ts` 有 JSONL 追加;若无轮转 helper,则自带 1MB 截断重命名,单文件)。

拒绝文本形态:
```
BLOCKED by routing guard (guard_unavailable). Bridge routing guard unavailable; … probe={url=http://localhost:9876/api/discord/reply-guard attempts=2 timeout_ms=4000 outcome=abort latency_ms=4003 at=2026-09-11T01:02:03Z local=own_top_level}
```

### 3.3 测试目标(bun:test,注入 fetch/clock/sleep)

1. 超时一次、第二次 200 allow ⇒ `allow`,attempts=2。
2. 两次超时 + 跨 Lead 频道 + 有单号 ⇒ `unavailable` + `local.classification=other` + allow + 审计一行。
3. 两次超时 + 自己频道 + 有单号 ⇒ deny `guard_unavailable`,文本含 `probe=` 各字段。
4. 401 ⇒ 不重试,`unauthorized`,自己频道 ⇒ deny `guard_unauthorized`。
5. 404 ⇒ `not_deployed` ⇒ allow,不审计。
6. Bridge 200 `{allow:false, reason:"issue_at_top_level", issues:[…]}` ⇒ deny 原样透传,文本含 `Issues:`。
7. 无 `DISCORD_OWN_CHAT_CHANNEL` + 超时 + 任意频道 + 单号 ⇒ deny `guard_unavailable_legacy_broad`。
8. core / roundtable 线程豁免在超时下 allow(现有语义)。
9. 审计 append 抛错不影响返回值。

本仓:`claude-lead.sh` 的 bash 测试族(`packages/teamlead/scripts/__tests__/`)加断言;`reply-guard.test.ts`(Bridge 侧)不动。

### 3.4 上线与回滚(照 memory 合同)

1. 本仓 PR 先合:多一个无人消费的 env 无副作用;Lead 重启后 pane 才带上它(`env -i` 冻结)。
2. 插件 PR 合到 fork main(版本 0.0.8)。fork main 是冻结窗口:合入即成为下一次受管重启的目标。
3. 受管上线:`restart-services.sh`(`restart.lock.d` 内 `check_discord_plugin_fork` → 更新 → 重检 → Lead wave);**不要**单独跑 `update-discord-plugin.sh`。上线后 `installed_plugins.json` 的 `gitCommitSha` 应为 fork PR merge SHA、`version=0.0.8`。
4. 顺序保证:插件 0.0.8 先于本仓 PR 上线也安全(env 未注入 ⇒ `legacy_broad`,即今天的行为 + 读数)。
5. 回滚:fork 上 revert 除 `.claude-plugin/plugin.json` 外全部,版本 patch+1(0.0.9),`git diff <preimage> <revert> -- external_plugins/discord ':!…/plugin.json'` 为空;本仓 env 注入无需回滚。
6. 本单**不**做插件的 FLY-1914 消费者 sweep(未删改任何 CLI 子命令)。

## 4. 与 Lead 的范围确认

question `ee7bbdf5-f01d-4eef-8621-851867c29376`(非阻塞,2026-09-11):默认切法 = exploration §5。截至本文写就未收到回复;plan 按默认写,若 Lead 回拉任一项,以 design-correction 附录方式追加。

## 5. 未解与假设

- 假设 `session_receipt_lineage` 自 FLY-1573 起对每个 spawn 都写(`run-dispatcher.ts:1244` 预注册路径);若某种 spawn 路径绕过 `registerSession`,该会话会被 CLI 判 `recipient_not_found`。plan 里加一条实现前核验:grep 所有 `TmuxAdapter`/`CodexTmuxAdapter` 起 runner 的路径都经过 `preRegister`。
- 假设 Codex TUI runtime 与 headless runtime 的 wiring 完全对称(`codex-lead-runtime.ts:1733-1741` vs `codex-lead-tui-runtime.ts:713-727`);两处都要改,plan 逐一点名。
- 插件 fork 的 `validate-discord-runtime.yml` 跑 `bun test`;新测试文件放同目录即被收。
