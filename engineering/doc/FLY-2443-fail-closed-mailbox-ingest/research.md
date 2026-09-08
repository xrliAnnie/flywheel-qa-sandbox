# FLY-2443 Claude Lead fail-open 旁路改 fail-closed — 调研

Issue: FLY-2443 (https://linear.app/geoforge3d/issue/FLY-2443/通路claude-claude-lead-的-fail-open-旁路改-fail-closed缺-env-不再绕过-mailbox)
日期: 2026-09-08
基于: exploration.md

行号基准:插件 = 生产在跑的 `~/.claude/plugins/cache/flywheel-plugins/discord/0.0.6/`(fork `xrliAnnie/claude-plugins-official` `external_plugins/discord`,main);主仓 = `flywheel` `296d9a413`。

## 1. Lead 裁定(question `82731579`,2026-09-08)

| 项 | 裁定 | 对设计的约束 |
|---|---|---|
| (a) ⛔ reaction | **做** | 是对 founder 自己那条消息的回执,不是 advisory 广播,不撞 FLY-1730 |
| (b) 一次性文字通知 | **不做** | FLY-1730 红线原文:internal plumbing advisory 不得进 founder channel;插件侧不许再长回任何文字广播,一次性也不行 |
| (c) DISCORD_ALERT_CHANNEL 告警 | **不做** | 插件侧新接线 = 新机制,属 FLY-1612 地盘;ops 可见性走**已存在的** StateStore `dead_letter_alerts`(`createDeadLetterAlertIntent`) |
| (d) dead-letter + 自动重放 | **做** | ① 落盘 = write-ahead intent,含原文 / channel / message_id / 收到时刻;② 健康启动后自动重放进 mailbox,保序、幂等(同 message_id 只进一次);③ 重放时由 **Lead 自己**在对应频道说「这 N 条是你 HH:MM 发的,我当时接线断了,刚读到」—— 唯一允许的文字面 |
| 停下来的条件 | — | 若必须动 1730 删掉的东西才能 fail-closed,停下报 Lead |
| 陈旧窗口 | 我定默认值 + 理由 | 见 §6 |

## 2. 旁路的完整生命周期(逐行)

```
启动  server.ts:104  RECORDER_MODE = resolveRecorderMode(process.env)      ← 只判一次
      chat-receipt-recorder.ts:90-95   COMPANION/EXTERNAL=1 → disabled/isolated
      chat-receipt-recorder.ts:97-103  三 env 全空            → disabled/stock
      chat-receipt-recorder.ts:105-108 三缺一或二             → broken{missing}
      chat-receipt-recorder.ts:110-115 三齐                   → enabled{commCli,dbPath,leadId}
      server.ts:109-113  broken → stderr 一行,继续启动
入站  server.ts:1719  if (RECORDER_MODE.kind === 'enabled') buildBeginArgs(...)
      server.ts:1750-1752 delivery = ingestArgs ? acceptInbound : 'legacy'
      chat-receipt-runtime.ts:100-104 acceptInbound: 非 enabled → 'legacy'
      server.ts:1763-1765 ack reaction(两条路一样)
      server.ts:1767-1782 delivery==='legacy' → mcp.notification('notifications/claude/channel')
```

结论:
- `enabled` 路径里 `ingest()` **从不**回退到直推(`chat-receipt-runtime.ts:106-154` 三种失败都只写 intent / 打日志),所以运行时故障已经是 fail-closed;唯一的 fail-open 就是启动时的 `broken` 判定。
- 「Discord 侧看不出来」的根因是 `server.ts:1763` 的 ack reaction 在分叉**之后**、对所有 delivery 值一视同仁。

## 3. env 的来源与「缺」的现实形态

- 插件以 MCP 子进程继承 Claude Code 进程环境:`.mcp.json` → `start-adapter.sh:44 exec bun server.ts`。
- `FLYWHEEL_LEAD_ID` 由 `scripts/flywheel-lead-wrapper-v2.sh:290-295,440` 断言+注入;三 env 全空在 Flywheel Lead 下基本不可能。
- `FLYWHEEL_COMM_CLI` 注入模式(Runner 侧 `packages/claude-runner/src/TmuxAdapter.ts:760-768`):`require.resolve("flywheel-comm")` 失败就 **catch 后静默不注入**。这是「缺一」最典型的形态:上游静默 → 插件静默 → 两层静默叠加。
- 生产实况 2026-09-08(只看变量名):6 个在跑的 `bun …/0.0.6/server.ts` 三 env 全齐;20 个 lead `STATE_DIR/.env` 无一配 `DISCORD_ALERT_CHANNEL`(印证裁定 (c))。

## 4. 可复用的既有原语

### 4.1 插件侧

| 原语 | 位置 | 用途 |
|---|---|---|
| `IngestIntentV1` + `writeJsonAtomic` | `chat-receipt-runtime.ts:32-39, 439-450` | 原子落盘;0600 权限;`.tmp`+rename |
| `readIngestIntent` | `:452-475` | 校验后 `{...parsed, begin}` —— 未知顶层字段保留 |
| `kickWorker / ingestWorkerLoop / drainIngestPass` | `:185-264` | 健康模式的 drain 循环;每 pass 5 条;按 mtime 排序 |
| `invokeIngest` → `chat-ingest --json` | `:266-294, 381-410` | spawn CLI;stdout 最后一行 verdict JSON |
| `parseLaneVerdict` | `:416-433` | `inserted_inbox/active_inbox/…` 五种 lane |
| `diagnoseNode` → `chat-ingest --version-probe --json` | `:156-183` | 已有能力探针,输出 `{command, protocolVersion:1, ok}` |
| ack reaction | `server.ts:1763-1765` | `msg.react(access.ackReaction)`,失败静默 |
| FLY-1730 结构负测 | `chat-receipt-runtime.test.ts:56-70` | 禁 `AdviseFn` / `advise:` / `adviseBroken` / `content: \`⚠️ ${text}\`` / `chatIngestRuntime.settle`;要求 `acceptInbound` 后 120 字符内 `kickWorker()` |
| 测试基座 | `bun test`(bun 1.3.11 本机可跑;fork CI `validate-discord-runtime.yml`) | 两文件 18 用例 98ms 绿(scratch 副本实测) |

### 4.2 主仓 flywheel-comm

| 原语 | 位置 | 用途 |
|---|---|---|
| `runChatIngest` `parseArgs` | `index.ts:702-724` | `allowPositionals:true`,**未声明的 `--flag` 会抛错**(node `parseArgs` 默认 strict)→ 新 flag 必须 CLI 先落地 |
| `--version-probe` | `index.ts:728-732` | `protocolVersion: 1` —— 提升到 2 作为插件侧能力门 |
| `ChatDeliveryEnvelopeV1` / `normalizeChatDeliveryEnvelope` | `chat-delivery-envelope.ts:15-36, 58-155` | 白名单重建,可加 optional 字段;`deliveryId = chatDeliveryId(leadId, messageId)` |
| `renderDiscordChatContent` | `discord-chat-ingest.ts:48-70` | 生成模型看到的 `<channel …>` 标签;属性全 `escapeXml` |
| `claimDiscordLane` | `mailbox-queue.ts:692-732` | 同 `delivery_id` 再来 → `active_inbox` / `archived`,**天然幂等** |
| `markDead(id, now, reason)` | `mailbox-queue.ts:951-964` | `QUEUED/LEASED → DEAD`,写 `dead_reason`/`last_error`,幂等 |
| `listUncoveredLeadDeadLetters` | `mailbox-queue.ts:2288-2420` | 扫 `carrier='inbox' AND state='DEAD' AND recipient_kind='lead'` → `lead_unacked` 候选,**不按 type 过滤** |
| `reconcileDeadLetterAlertIntents` → `createDeadLetterAlertIntent` | `lead-inbox-runtime.ts:1060-1097` · `StateStore.ts:17161-17220` | 候选 → `dead_letter_alerts`(pending / rate_limited 1800s `mailbox-queue-config.ts:19`) |
| `onDeadLetterAlert` sink | `plugin.ts:5814-5818` | 既有告警出口;本单不碰 |
| batch 渲染 | `lead-inbox-loop.ts:451,462` | `delivery_content ?? content` 原样拼进 turn |

### 4.3 推论:陈旧信用 DEAD 行留档,就能免费得到 ops 可见性

重放时把超窗的信照常 `claimDiscordLane` 入表、随即 `markDead(reason='discord_wiring_broken_stale')`,它就会被 `listUncoveredLeadDeadLetters` 捡到 → `dead_letter_alerts` → 既有 sink。零新告警路,正合裁定 (c)。`QUARANTINE_DEAD_REASONS`(`mailbox-queue.ts:127`)与 `FROZEN_DELIVERY_UNCONFIRMED_EXHAUSTED_REASON`(`:96`)都不含这个新 reason,不会被排除。

## 5. 两仓依赖与顺序

| 变更 | 仓 | 兼容性 |
|---|---|---|
| `chat-ingest --held-since <iso>`、`--dead-letter-reason <reason>`、`protocolVersion:2`、envelope `heldSince?`、`<channel held_since=…>` | 主仓 flywheel-comm | 纯增量:旧插件不传新 flag,行为不变 |
| broken → rejected;⛔;`rejected/` spool;健康重放 | fork 插件 | 重放前探 `--version-probe`;`protocolVersion<2` 时**不重放、只保留**,并打一次 `discord_mailbox_replay_awaiting_cli` 日志;实时消息不受影响 |

顺序:主仓先合并并部署(Lead 通过独立 updater,本单不做);插件 PR 合并后走 `scripts/discord-plugin/update-discord-plugin.sh` cutover(FLY-2226 §3 同款:**merge ≠ 生效**)。任一顺序颠倒都不丢信、不直推。

## 6. 陈旧窗口默认值:24 小时

- ⛔ 已实时告诉 founder「这条没投递」;她要么重发、要么在别处推进。超过一天再被 Lead 突然执行,危害(过期指令被执行)大于收益。
- 修 env 是人做的重启;实测告警到修复一般在小时级,24h 覆盖「隔夜发现」。
- mailbox 自身的保留期是 72h(`MAILBOX_RETENTION_MS`,`mailbox-queue.ts:233`),24h 窗口留出充足余量让 DEAD 留档行进入告警扫描。
- 超窗的信**不丢**:进 mailbox 为 DEAD 行(可查、可告警),本地 `rejected/` 文件在 CLI 成功后删除。

## 7. 被否决的路径(附理由)

- 启动即退出:黑洞化,Discord 侧更看不见(exploration §4 O1)。
- 猜 comm.db 路径:换皮 fail-open(O3)。
- 把 rejected 意图直接写进既有 `ingest/`:健康 drain 会以「普通 intent」重放,拿不到 `held_since`、没有窗口判断,还会触发 stall 日志;且 broken 时未必有 `leadId`,而 `normalizeBeginArgs` 要求非空。→ 独立 `rejected/` 目录、独立文件形状。
- 插件把「迟到说明」拼进 founder 原文:篡改原文;→ 用 envelope 属性 + stock 指令句让 Lead 自己说。

## 8. 与 1730 红线的关系(自检)

不新增 `AdviseFn` / `advise` option / `channel.send('⚠️')` / `adviseBroken`;不改 `chatIngestRuntime.settle`;`acceptInbound` 之后仍紧跟 `kickWorker()`。新代码只有:reaction、本地文件、stderr 结构化日志、健康时的 CLI 调用。不需要动任何 1730 删掉的东西 —— 未触发「停下报 Lead」条件。
