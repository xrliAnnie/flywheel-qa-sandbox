# FLY-2910 告警叫醒去重 — 探索
Issue: FLY-2910 (https://linear.app/geoforge3d/issue/FLY-2910/token3-告警去重同一-lead-6-小时内同一标题的告警只累加计数不再叫醒状况升级照常叫醒info-级只进摘要)
日期: 2026-09-25
基于: 无（上游测量来自 FLY-2904 `engineering/doc/FLY-2904-token-waste-census/`，分支 `flywheel-FLY-2904`）

## 1. 问题

FLY-2904 测得：14 天里告警把 Lead 叫醒 3,296 次，只有 67 种标题；其中 2,928 次是「同一个 Lead 6 小时内已经收过同一标题」，约 27.1 亿 token（以缓存读为主）。founder 9-25 批了「做」（FLY-2904 建议 r3）。

需求要点（issue 原文）：
1. 按 (leadId, 告警标题/类别) 6 小时窗口去重：窗口内重复只累加计数、记账，不叫醒。
2. 升级照常叫醒：级别升高、同类计数翻倍、对象不同、出现新的 action 要求，任一满足即叫醒，并在消息里带上窗口内累计次数。
3. info 级不叫醒，只进定时摘要（沿用现有通道，不新建 daemon）。
4. 项目级开关，默认开，关掉即恢复逐条叫醒。
5. 盘清告警的产生点和标题的真实形状，定义规范化的去重键。
硬约束：⛔ 不能吞掉真实待办；⛔ 本机只跑相关测试。

## 2. 告警怎样叫醒 Lead（盘点结论）

「叫醒」= Lead 的 mailbox（CommDB 里 `mailbox` 表，Lead 的唯一收件箱）里出现一封 `delivery_disposition='model'` 的信，被 `LeadInboxLoop` 领走、打成一个批次（batch）投给 Lead 模型。所以告警只有两种「载体」会叫醒 Lead，最后都进同一张 mailbox 表：

| 载体 | 怎么产生 | 信的样子 | 9-25 收件人 |
|---|---|---|---|
| A. Bridge 告警信 | 所有 Bridge 告警经 `routedAlertSink` 路由后，由 `LeadInboxRuntime.enqueueInfraAlert`（`packages/teamlead/src/bridge/lead-inbox-runtime.ts:645`）写入 | `source_kind='infra_alert'`；正文首行 `[infra_alert] <标题>`，末行 `event=<kind> severity=<级别> project=… affected\|owner=<lead> [session=<对象>]` | claw（`claude-infra-bot-lead`，告警值班席）为主；`review_job_failed` 等直投给负责 Lead（工程 Lead） |
| B. 告警频道 Discord 帖 | `LeadAlertNotifier` / `scripts/lead-alert.sh` 用 `flywheel-alerts-dispatcher` 机器人在 `#flywheel-alerts` 发工单帖；claw 的 Discord 插件把帖子写成 `type='discord_chat'` 的信 | 信封 JSON 的 `authorId` = dispatcher 机器人；正文首行 `{🚨\|⚠️\|ℹ️} **<标题>** (<lead> / <kind>)`，第二行 `🎫 … 状态 NEW` | 只有 claw（告警频道对它 `requireMention=false`） |

两条载体不是同一条告警的双发：路由器（`infra-event-router.ts:202`）把每条告警只送一条路。`workflow_engine_escalation` / `cmux_watcher_unrecovered` 或带 founder @ 的走 B，其余大多走 A。

现有去重全部按 eventId 精确匹配（`claims.db`、`lead_events`、mailbox 的 `delivery_id`）。生产者多数每次都铸新 eventId（带 attempt、`Date.now()`、episode 等），所以重复照样叫醒。`alert_mailbox_ledger.fire_count` 会把同一关联键的重复记为 merged，但仍然返回一个新投递、仍然叫醒。结论：**今天没有任何按「标题 + 时间窗」合并叫醒的机制**，本单是新增能力，不是修旧开关。

## 3. 标题的真实形状

盘点了约 60 个生产者（完整表见 research.md §2）。标题里的变量主要有四类：

| 变量 | 例子 | 规范化 |
|---|---|---|
| issue id | `FLY-2798 delivery contract stalled`、`Workflow land cleanup needs attention for FLY-2893` | → `<issue>`，同时作为「对象」 |
| 数量 | `跨 Lead 僵尸 session 积压（12 个）`、`Runner admission pause has remained active for 30 minutes`、`tmux server 丢失 — 3 个 runner 阵亡` | → `<n>`，同时作为「数量指标」 |
| 项目 / Lead 名 | `${project}/${lead} resident Codex Lead business-liveness …` | 保留（不同 Lead 本来就不合并） |
| 固定文案 | `Cross-family review job failed`、`cmux watcher unhealthy (event_backlog)` | 原样 |

标题里没有时间戳、exec id、PR 号，这些都在正文、`session=` 或 eventId 里。所以去重键定为 `(收件 Lead, 告警 kind, 规范化标题)`。规范化把 ISO 时间、UUID、长 hex、issue id、数字依次折叠。

## 4. 9-25 真实序列回放（设计阶段快照）

脚本：`evidence/replay_0925.py`（只读 CommDB）。数据：`evidence/replay-0925-design-freeze.json`，窗口为 PT 9-25 00:00 到 21:00（UTC `2026-09-25T07:00Z` 到 `2026-09-26T04:00Z`）。

- 共 154 封告警信，落在 152 个叫醒批次里（claw 138、工程 Lead 14）。
- 「叫醒」按批次算：只有一个批次里所有信都被合并，这次叫醒才真正消失。

| 口径 | 叫醒批次 | 变化 | claw | 工程 Lead |
|---|---|---|---|---|
| 改前 | 152 | — | 138 | 14 |
| 只按标题去重（FLY-2904 的算法） | 37 | -76% | 31 | 6 |
| **本设计：issue 四条升级规则 + info 进摘要** | **85** | **-44%** | 72 | 13 |
| 同上，但「计数翻倍」解读为「窗口内出现次数翻倍」 | 97 | -36% | 84 | 13 |

注：上表在 PT 21:00 冻结，为设计阶段快照。实现阶段用真实判定模块对 9-25 整天重跑，产出验收数字。

> **更正（Codex design review R1 之后）**：上表「本设计」一行对应 v1 的启发式规则。R1 指出它会把不同待办误判为同一件（见 `review/design-review-round1.md`）。plan v2 改为只合并「与已送达告警完全等价」的信，9-25 快照为 **152 → 102（-33%）**，工程 Lead 为 14 → 14，见 `evidence/replay-0925-strict.json`。

## 5. 核心张力：「对象不同就叫醒」会吃掉大部分节省

founder 举的例子是：9-25 工程 Lead 连续收到多条 `Cross-family review job failed`。回放显示，这串告警**每一条都是不同的 review / 执行**。其中多数正文写着 `Retry POST /review-requests with the same requestId; the gate remains closed`，也就是 Lead 真要去处理的待办。按 issue 第 2 条「对象不同照常叫醒」，再加上硬约束「不能吞真实待办」，它们都必须叫醒。所以工程 Lead 14→13，几乎没省。

省下来的主要在 claw：
- 同一对象的重复：`跨 Lead 僵尸 session 积压` 24 封里合并 20；`cmux watcher unhealthy` 13 封合并 9。
- info 级的 `Review passed with non-blocking advisories` 18 封改进摘要。

FLY-2904 的 27.1 亿是「只按标题」口径的**上界**。按本设计的规则，9-25 的节省比例约是标题口径的 58%（44% / 76%）。

已非阻塞地报 Lead（问题 `5b09be16-…`、`a262e864-…`），推荐按 issue 字面规则实现，不自行放宽「对象不同」。

## 6. 其他发现（影响设计）

1. **info 不全是纯通知。** `flag_scan_handoff`（「每周 flag 扫描已就绪，等你去问 founder」）是 info 级，但带真实待办。「info 一律不叫醒」会违反硬约束，需要一个显式例外集。
2. **没有对所有 Lead 通用的定时摘要。** claw 收不到 `patrol_tick`，也收不到 `summary_due`（9-25 只有工程 Lead 收 patrol_tick）。现有的「固定页」是 `GET /duty/alert-board` 与 `flywheel-comm alert-ticket`，它们读 `alert_mailbox_ledger` / `alert_threads`。
3. **FLY-2749 的 `audit_only` 可以复用，但缺告警信的终态。** `releaseClaimForAudit` 把行放回 QUEUED，并把 `next_retry_at` 停在 9999 年，只有 question 行后来会被 `markQuestionTerminalDisposed` 结算。告警信照搬会永远不归档。需要「机器结算：ACKED + audit_only」的路径。
4. **dispatcher 的身份可信。** Bridge 运行时已经解析 `alertDutyDispatcherBotUserId`（`plugin.ts:10062`）。用信封里的 `authorId` 对比它来认 B 载体，不看可伪造的 `authorName`。解析不到就不认，照常叫醒。
5. **现有 revalidate 钩子只作用于新批次。** 只对 `retry_count=0` 的新批次调用（`lead-inbox-loop.ts:350-399`），重投永远照常投，天然偏向「宁可多叫醒」。

## 7. 选项

| 方案 | 做法 | 取舍 |
|---|---|---|
| **A. 消费端合并（推荐）** | 在 `LeadInboxLoop` 的 revalidate 钩子里，对两种载体的告警信判定叫醒或合并；合并的信用 audit_only 机器结算 | 一个卡口覆盖两种载体和 shell 发的帖；复用 FLY-2749 的审计列；告警本身（Discord 帖、工单、账本）完全不动，founder 看到的不变 |
| B. 生产端合并 | 在 `enqueueInfraAlert` 和 `LeadAlertNotifier.alert` 里就不发 | 覆盖不到 `lead-alert.sh` 直发的帖；要改三处；会改变 Discord 工单可见性 |
| C. 只做标题口径 | 不做升级规则 | 与 issue 第 2 条和硬约束冲突，否决 |

推荐 A。细节见 research.md 与 plan.md。
