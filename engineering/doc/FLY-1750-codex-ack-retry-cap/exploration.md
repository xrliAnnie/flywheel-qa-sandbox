# FLY-1750 Codex Lead ack 腿未打通 + 重投无 cap — 探索

Issue: FLY-1750 (https://linear.app/geoforge3d/issue/FLY-1750/bug-codex-lead-ack-batch-生产路径未打通fly-1573-未验腿-租约重投-131-次不进-dead-无-cap)
日期: 2026-08-13
基于: 无(本单第一份文档;上游权威 = FLY-1573 设计文档 `engineering/doc/FLY-1573-queue-lease-batch-deadletter/plan.md`)

## 1. 一句话

Codex 后端 Lead 的 mailbox 投递腿在生产从未成功过(socket 缺位),而 Bridge 把「transport 不可用」这类投递失败**豁免了计数上限**(`maxAttempts: Number.MAX_SAFE_INTEGER`),两者叠加 = 消息无限重投、永不进 DEAD、也永远等不来 ack。

## 2. 现象与实测证据(2026-08-13,全部只读取证)

### 2.1 issue 记录的观测

- `codex-infra-bot-lead` 的 swap-broadcast 行 `retry_count` = 131(08-12 那行,挂 21 小时才被人工签收)/ 48(08-13 那行);
- 同一广播的 4 个 Claude 后端 Lead 全部 `retry_count = 0` —— 重投风暴**只打在 Codex 后端**;
- mufasa 同病:3 行 ACKED、`retry_count` 最高 131、`delivered_at` 全 NULL。

### 2.2 本节点复核新增的实锤(生产库只读)

| 证据 | 数值 | 含义 |
| -- | -- | -- |
| flywheel comm.db:`codex-infra-bot-lead` LEASED 行 | `retry_count=23` 且**还在爬**,`last_error = "Codex Lead inbox capability probe failed: connect ENOENT …/codex-infra-bot-lead/lead-inbox.sock"` | 病**此刻仍活着**;失败类型逐字 = 连接级 ENOENT |
| 两个 Codex Lead 全部历史行 | `delivered_at` **全 NULL** | 投递腿在生产**从未成功过一次** |
| growth comm.db `type='ack_batch'` 行数 | **0** | mufasa 从未 ack 过任何批(因为从未收到过) |
| flywheel comm.db `type='ack_batch'` 行数 | **5997** | Claude 腿的 ack 链路健康且大量在用(对照组) |
| `launchctl list` | 无 `com.flywheel.lead.flywheel-codex-infra-bot-lead`(plist 在盘上未加载;wrapper 是 7-5 headless 旧代) | codex-infra-bot **没有任何载体进程** → 没有人 host 它的 socket |
| `lsof -U` | mufasa 的 `lead-inbox.sock` 有活 listener(node 92133),socket 文件 ctime = 今天 16:37 | mufasa 的投递腿**今天重启后才第一次**具备条件,历史上一直缺位 |
| backoff 参数 | `retryBackoffCapMs = 10min`(lead-inbox-loop.ts:147) | 131 次 × ~9.6min ≈ 21h,与 issue 观测逐字吻合 |

### 2.3 「131 不进 DEAD」的机制指认(与 issue 的措辞做一处更正)

issue 写「**租约**重投无 cap」。审计结论:涨到 131 的计数是 **`retry_count`(transport 投递失败计数)**,不是 `lease_retry_count`(已投未 ack 的租约重投计数)。后者 FLY-1573 已带 cap=3、超限进 DEAD,生产在 Claude 腿上大量验证过(`lease_retry_count` 最高 3、DEAD 行存在)。真正无 cap 的位点:

```
packages/teamlead/src/bridge/lead-inbox-loop.ts
  :523-543  catch 里:error instanceof LeadDeliveryUnavailableError
            → nonExhausting=true → maxAttempts: Number.MAX_SAFE_INTEGER
  :596-603  quarantine_alert_failed 退避:同样 Number.MAX_SAFE_INTEGER
```

设计初衷可以理解:「transport 挂了是环境故障,不该烧掉消息的投递预算」(源码注释:"Connection-level failures are Lead-wide and must not exhaust queued model rows")。它对**临时**故障是对的;但对**永久缺位**(载体根本不存在)就变成无限自旋 —— 用治「临时故障」的药,治了「永久缺位」的病。

## 3. 根因树(两层五因)

```
消息无限重投、不收敛
├── ① Bridge 代码:unavailable 类失败豁免 cap(MAX_SAFE_INTEGER,两处)      ← Fix A
├── ② 生产载体:codex-infra-bot-lead launchd job 未加载 → socket ENOENT    ← Fix B1
│      mufasa 载体长期跑旧 runtime,socket 直到 8-13 16:37 才第一次 host    ← Fix B2(验证)
├── ③ 结构假设:queue 对 lead 收件人「恒活」,无 terminal/缺位判定
│      → 「registered 但无载体」的 Lead = 永久黑洞(runner 有 terminal 闸,lead 没有)
├── ④ FLY-1573 就绪探针只验「MCP 入口文件能列出工具」(沙箱内 listTools),
│      不验活载体、不验 per-lead config、不验真 ack 行为 → 生产 ON 时探针绿、腿是断的
└── ⑤ 告警存在但失效:codex_model_transport_unavailable severe 每 30min 一发
       (plugin.ts:7764),但同窗 fleet-alert 风暴把它淹了,21h 无人处置
```

①是本单要修的**结构收敛缺口**;②是**当下生产事故的直接原因**;③④⑤解释「为什么烂了 21 小时没人管」——③的通用治理归 FLY-1751 族,⑤的告警去噪归 FLY-1749/告警族,本单只做①②加一个轻量的④补强(见 §5 Fix C)。

## 4. 器官边界(与 FLY-1749 / FLY-1751 的分工,按 issue 判据)

| 症状 | 器官 | 归属 |
| -- | -- | -- |
| 某收件人 `retry_count` 数十~上百 | 投递失败无 cap + Codex 腿缺位 | ✅ **本单** |
| 所有收件人 `retry_count=0` 仍被重放(Claude 腿 ~500 份洪水) | 广播语义(瞬时广播不该 at-least-once) | ❌ FLY-1749 |
| 队列冻结 + 恰好 3 行 LEASED(换代后在途批无人 ack) | Lead 启动对账缺失 | ❌ FLY-1751 |
| `claude-infra-bot-lead` 的 65 LEASED + 96 DEAD | Claude 腿自身投递问题 | ❌ 不归本单;且**恢复顺序硬约束:不得直接 kickstart 它**(issue 原文,先有 1751 对账腿) |

## 5. 方案空间与取舍

### Fix A — unavailable 类投递失败加有界 cap(核心修复,founder 已拍方向「超限进 DEAD」)

| 选项 | 形态 | 取舍 |
| -- | -- | -- |
| **A1 计数 cap(推荐)** | 新 knob `FLYWHEEL_MAILBOX_UNAVAILABLE_RETRY_MAX`(默认 48),两处 `Number.MAX_SAFE_INTEGER` 换成它;超限 DEAD,`dead_reason='transport_unavailable_exhausted'` | 最小改动;复用现成 `retry_count` 列与 `recordLeadDeliveryFailure` 的 DEAD 机械;10min backoff cap × 48 ≈ **8h 容忍窗**(扛得住整晚重启波/配额停摆,又能在一天内收敛);knob 上界放宽即是逃生口,**不需要新 flag**(遵守 Annie「不加新 flag」铁律) |
| A2 时间窗 cap | `now - created_at > windowMs` 且 unavailable → DEAD | 语义更直白(「容忍 N 小时故障」)但要么引入首失败时刻追踪(schema 变更)要么借 `created_at`(行龄 ≠ 故障龄,长队积压时误判);多一套时间比较边界 |
| A3 独立计数列 | `unavailable_retry_count` 新列 | schema 变更 + 迁移 + 双计数分账复杂度,收益只是「预算不互相污染」;违背简单性 |

**选 A1。** 已知副作用(接受并写测试钉死):`retry_count` 是单一预算,unavailable 重试把它抬高后,transport 一旦恢复、第一次**真实**失败会立即触发普通 cap(`≥ maxModelAttempts=5`)进 DEAD。这与今日行为一致(131 之后任何真实失败同样立死),且有界;不为它加第二列。

DEAD 之前必须先有 founder 可见终态信号:queue ON 时继续由 FLY-1573 死信闸补扫;生产实际 queue OFF 时,cap 边界直接走独立 severe 终态告警,告警未送达就保持 LEASED 并退避,不许先判 DEAD。Discord 行复用 `onDiscordUndeliverable` 专用告警。行随后留在活表供扫描;可归档终态族满 72h 后移入审计归档,开放且未回答的 question 家族受终态保护继续留在活表。

### Fix B — Codex ack 生产路径打通(不是代码缺口,是载体+验证缺口)

审计推翻了 issue 标题的一半:`ack_batch` 的**代码链完整**(`lead_actions` MCP 工具 → `CommDB.insertBatchAckReceipt` → comm.db protocol 行 → Bridge `ProtocolIngress` :57 → `ackBatchByRecipient`),源码和生产 dist(今日 16:36 构建)都在,mufasa 的 config.toml 也已带 `lead_actions` + `FLYWHEEL_COMM_DB`。缺的是:

- **B1 codex-infra-bot-lead 载体复活**:按现行 mufasa 形态(launchd + full-access wrapper + config.toml 带 `lead_actions`)重建并 bootstrap。安全性:其 mailbox **没有任何 delivered-未 ack 的在途批**(`delivered_at` 全 NULL),复活不会踩 FLY-1751 的「换代后在途批无人 ack」陷阱。(备选:从 projects.json 退役注册 —— 已用非阻塞 ask 请 Tadashi 拍板,默认按复活写。)
- **B2 双 Lead 真机 E2E 验证**(FLY-1573 验收 10 的欠账):正对照 = 真投一批 → `delivered_at` 非空 → Codex Lead 真调 `lead_actions.ack_batch` → protocol 行被 ingress 消费 → 行 ACKED。mufasa 今天起 socket 已具备条件但**从未被证明过**——「listener 在」≠「链路通」,必须行为证据。

### Fix C — 就绪探针补强(轻量,可被 Lead 裁掉)

FLY-1573 的 `mailbox-queue-ack-readiness-probe` 只在沙箱里 listTools。补一条**活载体探活**:部署验证(restart-services 收尾核验)对每个 registered Codex Lead 跑一次带 auth 的 `probeCodexLeadInboxCapabilities`,socket 不可达 → 部署 verdict 显式 degraded。复用现成探针函数,几十行。这是把「④探针验错了对象」的教训落进部署合同;若嫌 scope 大可裁,①②已足够让故障有界。

## 6. 不做什么

- 不动 Claude 腿的洪水(FLY-1749)与 rebirth 对账(FLY-1751);不碰 `adoptInflightForRecipientOnConnection`(手动 CLI,FLY-1751 领地)。
- 不 kickstart `claude-infra-bot-lead`(issue 硬约束)。
- 不动 `lease_retry_count` 机制(cap=3 已存在且已验)。
- 不加新 feature flag、不改 mailbox schema、不加新定时器。
- 不做 lead 收件人 terminal 判定的通用机制(③ 的完整治理归 1751 族;本单用 Fix A 让黑洞有界 + Fix B 消掉当前黑洞)。
