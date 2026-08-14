# FLY-1750 Codex Lead ack 腿 + 重投 cap — 调研

Issue: FLY-1750 (https://linear.app/geoforge3d/issue/FLY-1750/bug-codex-lead-ack-batch-生产路径未打通fly-1573-未验腿-租约重投-131-次不进-dead-无-cap)
日期: 2026-08-13
基于: exploration.md

> 全部证据 2026-08-13 17:4x–18:0x PT 只读取证(sqlite `mode=ro`、`launchctl list`、`lsof`、`ps`,零 mutation)。行号基于本分支(= 今日部署的 `origin/main` f3a27971)。

## 1. 投递失败计数与 cap 的完整地图

### 1.1 mailbox 的两套计数(FLY-1573 §2.1 分账)

| 计数 | 记什么 | cap | 生产状态 |
| -- | -- | -- | -- |
| `lease_retry_count` | 已投(`delivered_at` 非空)未 ack,租约到期重投 | `FLYWHEEL_MAILBOX_LEASE_RETRY_MAX`=3 → DEAD `lease_expired_unacked`(mailbox-queue.ts:1523-1546) | ✅ 工作正常:Claude 腿最高 3、DEAD 行存在 |
| `retry_count` | transport 投递失败 | `maxModelAttempts`=5(lead-inbox-loop.ts:145)→ DEAD `delivery_attempts_exhausted` | ⚠️ **有豁免洞**(下节) |

**issue 措辞更正**:涨到 131 的是 `retry_count`(投递失败),不是租约重投。`lease_retry_count` 的 cap 完好,不动。

### 1.2 豁免洞:`Number.MAX_SAFE_INTEGER` 两处(全仓仅此两处)

```
lead-inbox-loop.ts :523-543  deliverModelBatch catch:
    const unavailable = error instanceof LeadDeliveryUnavailableError;
    const nonExhausting = unavailable;
    …recordLeadDeliveryFailure({ …, maxAttempts: nonExhausting
        ? Number.MAX_SAFE_INTEGER : this.maxModelAttempts })

lead-inbox-loop.ts :596-603  quarantineDiscord 内 onDiscordUndeliverable 告警失败退避:
    …recordLeadDeliveryFailure({ …, maxAttempts: Number.MAX_SAFE_INTEGER })
```

`recordLeadDeliveryFailure`(mailbox-queue.ts:2023-2085)本身是**有 cap 机械的**(`retry_count+1 >= maxAttempts → DEAD`),洞只在调用方传的参数。runner lane(runner-mailbox-lane.ts)**零** MAX_SAFE_INTEGER 位点(runner 收件人另有 terminal 闸兜底)。

### 1.3 `LeadDeliveryUnavailableError` 的三个 throw 位点(lead-delivery-adapter.ts,全仓仅此三处)

| 行 | 场景 | scope |
| -- | -- | -- |
| :132 | `probeCodexLeadInboxCapabilities` **连接级失败**(ENOENT/ECONNREFUSED/timeout;auth 拒绝走 `CodexLeadInboxRejectedError` 原样上抛、**不**豁免) | `lead` |
| :139 | v1 server 收到 discord_chat 批(`route_protocol_unavailable`) | `discord` |
| :167 | `submitCodexLeadInboxBatch` 连接级失败 | `lead` |

**只有 Codex 腿会造出这个错**:Claude 腿(`ClaudeLeadDeliveryAdapter`)写文件 inbox,不 throw 此类。这解释了「风暴只打 Codex 后端」的观测。

### 1.4 backoff 参数与观测的数值吻合

`nextRetryAt = min(retryBackoffCapMs, 5s × 2^retry_count)`,`retryBackoffCapMs = 10min`(:146-147)。131 次 ≈ 21h(平均 ~9.6min/次),与 08-12 19:15 → 08-13 16:32 挂 21 小时逐字吻合。`2**131` 是有限 float,`Math.min` 先取 cap,无溢出 bug。

## 2. Codex ack_batch 代码链:完整,且生产 dist 在位

| 环节 | 位置 | 状态 |
| -- | -- | -- |
| MCP 工具 `ack_batch` | `lead-actions-main.ts:37-46,157-176`(`LEAD_ACTIONS_TOOLS` 恰二工具断言;`commDb.insertBatchAckReceipt`) | ✅ 源码在 |
| 生产 dist | `~/Dev/flywheel/packages/teamlead/dist/…/lead-actions-main.js`(今日 16:36 构建,含 `insertBatchAckReceipt` 调用) | ✅ 在 |
| durable protocol 行 | `CommDB.insertBatchAckReceipt`(db.ts:1525-1544):`type='ack_batch'`,`to_agent='bridge'`,`recipient_kind='bridge'`,content=`{"batch_id":…}` | ✅ |
| Bridge 消费 | `protocol-ingress.ts:57-63` → `ackBatchByRecipient`(授权=批成员 `to_agent === from_agent`,三态幂等) | ✅ |
| mufasa config.toml | `~/.codex-mufasa/config.toml`:`[mcp_servers.lead_actions]` 带 `FLYWHEEL_COMM_DB=~/.flywheel/comm/growth/comm.db`、`FLYWHEEL_LEAD_ACTIONS_STATE_DIR`、`DISCORD_BOT_TOKEN` by-name | ✅ 配置在 |
| 对照组 | flywheel comm.db `type='ack_batch'` 共 **5997** 行(Claude Lead 经 inbox-mcp 同形态落行,被 ingress 正常消费) | ✅ 链路被 Claude 腿日常验证 |

**结论:「ack_batch 生产路径未打通」的真身不是代码缺口,是「批从来投不进去,所以 ack 从来无从发生」**(growth 库 `ack_batch` 史 = 0)。

## 3. 投递腿(socket)生产实况

### 3.1 架构

Bridge per-lead `LeadInboxLoop` → backend 分派(lead-inbox-runtime.ts:608-631 `createProductionAdapter`):`codex-app-server` → `CodexLeadDeliveryAdapter{ stateDir: resolveCodexLeadStateDir(project, leadId), authSecret: lead.botToken ?? DISCORD_BOT_TOKEN }` → unix socket `<stateDir>/lead-inbox.sock`。**server 侧**由 Codex Lead 载体进程 host:`codex-lead-runtime.ts:1664` / `codex-lead-tui-runtime.ts:614` 都会 `new CodexLeadInboxServer(...)`。

### 3.2 两个生产 Codex Lead(projects.json 全舰仅此二)

| Lead | 注册 | 载体 | socket | 结论 |
| -- | -- | -- | -- | -- |
| `mufasa-lead`(growth,companion) | ✅ `backend=codex-app-server` | ✅ launchd `com.flywheel.lead.growth-mufasa-lead` 活(PID 92133) | ✅ `…/mufasa-lead/lead-inbox.sock` ctime **今日 16:37**,`lsof` 证实 92133 持有 | 腿**今天起才具备条件**;历史 `delivered_at` 全 NULL = 从未通过;**E2E 未证明** |
| `codex-infra-bot-lead`(flywheel,infra) | ✅ `backend=codex-app-server, codexProfile=full-access` | ❌ plist 在 `~/Library/LaunchAgents/` 但 **launchctl list 无此 job**;wrapper `flywheel-codex-lead-wrapper-codex-infra-bot.sh` 为 **7-5 headless 旧代** | ❌ stateDir 存在(journal.db 等残迹,最后活动 8-12)但**无 socket 文件** | 载体缺位 → 永久 ENOENT → 风暴主源;**此刻仍在病中**(LEASED 行 retry=23 在爬,`last_error` 逐字 = `connect ENOENT …/codex-infra-bot-lead/lead-inbox.sock`) |

### 3.3 为什么 21h 没人管:告警在、但失效

`onModelTransportStall` → plugin.ts `leadAlertNotifier.alert(eventId=codex_model_transport_unavailable:<leadId>:<30min桶>, severity=severe)`,每 Lead 每 30min 一发。同窗正值 fleet-alert OOM 广播风暴(FLY-1749/1750 同一排查线),severe 被淹没。代码评审又验证出一条边界:生产 `FLYWHEEL_MAILBOX_QUEUE=0` 时,最后一行进 DEAD 后 claim 为空,这个 stall 告警也随之停止;所以 cap 不能只靠它兜底,必须在 DEAD 前发一次独立终态告警,且告警失败时保留行继续退避。

### 3.4 FLY-1573 就绪探针为什么没拦住

`mailbox-queue-ack-readiness-probe.ts`:起**沙箱** MCP 子进程 listTools,断言 `flywheel_inbox_ack_batch` / `ack_batch` 在工具清单里。它验的是「入口文件能列工具」,不验:活载体存在、per-lead config.toml 正确、socket 可达、模型真会调用。生产 ON + 腿断 = 探针绿的必然结果。

## 4. 修复面所需的既有机械(全部已在,零新轮子)

| 需求 | 既有机械 |
| -- | -- |
| cap 超限进 DEAD | `recordLeadDeliveryFailure` 的 maxAttempts 机械(mailbox-queue.ts:2023-2085);只改调用参数 + 可选 deadReason |
| DEAD 不静默 | cap 边界先发独立 severe 终态告警;告警失败则保持 LEASED + 退避。Discord 行先走 `onDiscordUndeliverable`。queue ON 时 FLY-1573 死信闸仍补充扫描:lead 收件人 DEAD 行 → `listUncoveredLeadDeadLetters`(无 dead_reason 过滤)→ `dead_letter_alerts` intent |
| knob 模式 | FLY-1573 六 knob 先例:`mailbox-queue-config.ts` 快照供给器 + 界 + warn-once + `NON_FLAG_ALLOWLIST` 登记 |
| 载体复活模板 | mufasa 现行形态:launchd plist + full-access wrapper + `codex-lead-tui-home.sh` 渲染 config.toml(含 lead_actions) |
| socket 探活 | `probeCodexLeadInboxCapabilities`(CodexLeadInboxSocket.ts)现成函数 |

## 5. 风险点核查(为 plan 铺路)

1. **QUARANTINE_DEAD_REASONS 交互**(mailbox-queue.ts:79,:657-725):存在一个按 dead_reason 白名单的 quarantine 恢复通道。新 `dead_reason='transport_unavailable_exhausted'` **不得**加入该白名单(不希望被恢复通道复活),implement 时写反断言测试。
2. **单预算污染**(exploration §5 A1 已记):unavailable 抬高 `retry_count` 后,transport 恢复期的第一次真实失败会立即触发普通 cap。与现状一致、有界、接受;测试钉死语义。
3. **OFF(`FLYWHEEL_MAILBOX_QUEUE=0`)路径**:`deliverModelBatch` 的 catch 是 ON/OFF 共享的,且生产当前就是 OFF。cap 两态一并生效;OFF 不跑死信 intent scanner,所以 cap 边界必须直接发终态告警并 fail-close 保行。queue ON 另写回归锁,防 frozen reclaim 将来重新引入自旋。
4. **复活 codex-infra-bot 无 FLY-1751 陷阱**:其 mailbox 无 delivered-未 ack 在途批(`delivered_at` 全 NULL,LEASED 行是 Bridge lane 自己持有的投递失败 frozen 行,到期走 frozen 重发路径),载体上线后下一次重发即真投。**对照:`claude-infra-bot-lead`(65 LEASED delivered 0 + 96 DEAD)是 Claude 腿别的病,本单禁碰(issue 硬约束)。**
5. **discord_chat 行同覆盖**:`route_protocol_unavailable`(scope=discord)同属 unavailable 类,cap 一并生效 → codex 腿的 Discord 转发行也收敛。
6. **人工 ACK 残迹**:两库里 retry 131 的行现已 ACKED 且 `delivered_at` NULL(运维手工止血),负对照验收要用**新造行**而不是这些残迹。

## 6. Lead 裁决(ask id `631446b1`,Tadashi 2026-08-13 已回)

1. **修复必须 general**:任何 recipient 的 socket 死了都要有界退避 + 终态(DEAD cap),不按 Lead 名写死;`maxAttempts=MAX_SAFE_INTEGER` 豁免层就是本单核心,先修它。
2. **codex-infra-bot-lead 复活/退役 = founder 决策项,本单不拍死**。新事实:它是 **8-08 被故意停掉的** —— 其 Codex `auth.json` 缺失(FLY-246 设计不复制凭据),起来就 crash-loop,当时起就在等 founder 拍「补哪个号」,决定至今未下。design 可把复活写成推荐路径,但必须标注此前置(先解决 Codex 凭据 = founder 决策点);**验收不得硬依赖它复活** —— fallback 验证面 = mufasa 健康腿正对照 + 受控死 socket 场景验有界退避。
3. 本节点抓到的 live LEASED retry=23 行:**留证据即可,design 阶段不动生产数据**。
