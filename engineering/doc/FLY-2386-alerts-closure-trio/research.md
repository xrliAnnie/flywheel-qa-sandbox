# FLY-2386 值守小版三件收口 — 调研
Issue: FLY-2386 (https://linear.app/geoforge3d/issue/FLY-2386/alerts值守小版-2073-收口后还在咬的-3-件判理册解法册沉淀-每件事有闭环终点-被-的人分档prd-2060)
日期: 2026-09-06
基于: exploration.md

本文只记「改动要挂在哪根既有的钉子上、那根钉子现在的合同是什么」。方案取舍在 exploration.md §3,任务拆分在 plan.md。

## 1. 账本层(StateStore)

### 1.1 `alert_threads` 现有合同(车道 B,不改)

`packages/teamlead/src/StateStore.ts:4346-4380`。主键 `correlation_key`(active-mapping:同 key 新 event 覆盖旧行),`event_id` 为当前 episode。FLY-927 追加列 `ticket_status / owner_ref / attempt_count / first_seen_at / acked_at`,`resolved_at` 原生。

2076 加的 duty 方法(`:14417-14445`、`:15083-15150`):

| 方法 | 语义 | 围栏 |
|---|---|---|
| `stampDutyAck(ck, eventId)` | `acked_at = COALESCE(acked_at, now)` | `WHERE correlation_key=? AND event_id=?`,0 行 → false |
| `handoffTicket(ck, eventId, ownerRef)` | `acked_at` + `ticket_status='ESCALATED'` + `owner_ref` | 同上 + `resolved_at IS NULL AND ticket_status <> 'RESOLVED'` |
| `listDutyOutstanding(limit, since?)` | `acked_at IS NULL AND ticket_status IS NOT NULL`,`ORDER BY opened_at DESC, event_id DESC` | cursor `(opened_at, event_id)` |
| `getAlertThreadByEventId / ByRootMessageId` | 不过滤 resolved | — |

`correlationKeyFor(p)`(`AlertChannelHub.ts:308`)= `${projectName}|${leadId}|${eventType}|${sessionKey ?? ""}`。**车道 A 沿用同一函数**,这样两条车道对「同一个问题」的身份判断一致。

### 1.2 新表 `alert_mailbox_ledger`(车道 A)

与 `alert_threads` 同构,去掉 Discord 列,加信箱引用:

```sql
CREATE TABLE IF NOT EXISTS alert_mailbox_ledger (
  correlation_key TEXT PRIMARY KEY,
  event_id        TEXT NOT NULL,
  delivery_id     TEXT NOT NULL,          -- 当前 episode 那封信的 mailbox deliveryId
  to_agent        TEXT NOT NULL,          -- 实际收件人(值守档 = claude-infra-bot-lead;点名档 = owner Lead)
  requested_owner TEXT NOT NULL,          -- 调用方请求的收件人(duty_reroute 时 ≠ to_agent)
  route_class     TEXT NOT NULL,          -- duty | direct_owner | duty_reroute | duty_fallback(投递前决定)
  lead_id         TEXT NOT NULL,          -- payload.leadId(受影响 Lead)
  project_name    TEXT NOT NULL,
  event_type      TEXT NOT NULL,
  session_key     TEXT,
  ticket_status   TEXT NOT NULL DEFAULT 'NEW',   -- NEW | ESCALATED | RESOLVED(与 alert_threads 同词汇)
  owner_ref       TEXT,                   -- lead:<id> | infra_bot:claude
  handoff_reason  TEXT,                   -- contact_book | no_entry | direct_owner | duty_fallback(仅 ESCALATED)
  handoff_delivery_id TEXT,               -- 转出信的 deliveryId(必达核对用;direct_owner/duty_fallback 时 = 这封信自己)
  handoff_generation INTEGER NOT NULL DEFAULT 0,  -- 每次 handoff +1,进 deliveryId,让重投可区分
  resolve_draft_id TEXT,                  -- duty resolve 时核验过的草稿回执 id(ARC 自动解决为空)
  fire_count      INTEGER NOT NULL DEFAULT 1,
  first_seen_at   TEXT NOT NULL,
  opened_at       TEXT NOT NULL,          -- 当前 episode 开始
  acked_at        TEXT,
  resolved_at     TEXT
);
CREATE INDEX IF NOT EXISTS idx_alert_mailbox_ledger_outstanding
  ON alert_mailbox_ledger(acked_at, opened_at, event_id);
CREATE INDEX IF NOT EXISTS idx_alert_mailbox_ledger_event ON alert_mailbox_ledger(event_id);
```

episode 规则(照抄 `alert_threads` 的 upsert,`StateStore.ts:3628-3634` 一带):

* key 不存在 → 插入(`duty / duty_reroute` 为 NEW;`direct_owner / duty_fallback` 原子种成 ESCALATED,见下表)。
* key 存在且 `event_id` 与本次相同,投递投影(`route_class / to_agent / requested_owner / delivery_id`)也相同 → **纯 no-op**,不碰任何生命周期列(这就是 `archived_terminal` 重放与进程内重试走的分支)。
* key 存在、同 event、投影不同 → **重分类授权来自 mailbox settlement,不只看账本**:runtime 先按 canonical `(to_agent, delivery_id)` 调该收件人 project 队列的 `inspectDeliveryState`;只有 `absent_identity`(上一次 enqueue 确实没成功,与 catch 路径一致)才以 `allowReseed=true` 调 upsert,并且行还必须是 **pristine seed**(SQL 谓词:`resolved_at IS NULL AND resolve_draft_id IS NULL AND handoff_generation = 0 AND (acked_at IS NULL OR handoff_reason IN ('direct_owner','duty_fallback'))`)→ `reseeded`,重写 seed 列(`to_agent / requested_owner / route_class / delivery_id / ticket_status / owner_ref / handoff_reason / handoff_delivery_id / acked_at`)。其余分支或行已被值守 ack / handoff / resolve → `locked_canonical`,**不写**,返回 canonical 投影,新推导收件人 +0(这封信已经真实存在于某人的信箱里,账本不能改写它)。runtime 对 canonical 的动作按 settlement 分支:`live` → 用 live 行原 `created_at` 做 identity 幂等 enqueue(既有 `existing?.created_at` 路径);`archived_nonterminal / archived_terminal` → **不调用 enqueue**(identity 已永久认领,普通 enqueue 会因新时间戳撞 `mailbox identity conflict`,`mailbox-queue.ts:637-658`);`torn_identity` / inspect 抛错 → fail-closed,不 reseed、不转投、不 enqueue,warn 并返回 `{queued:false, reason:'settlement_torn'}`。pristine 谓词只证明「值守没动过」,证明不了「上一封没投出去」,所以两个条件都要。
* `upsertAlertMailboxLedger(input, {allowReseed}) → {disposition, deliveryProjection}`,disposition ∈ `inserted / replayed_same / reseeded / locked_canonical / merged / new_episode`;`deliveryProjection`:`replayed_same / locked_canonical` = canonical,其余 = incoming(`merged` 也是 incoming:账本 event 不变但**新 delivery id 必须入队**,投递量不减)。
* key 存在、event 不同、`resolved_at IS NULL`、且 `route_class` 与 `to_agent` 都相同 → `merged`:`fire_count+1`,账本的 `event_id / delivery_id / opened_at` **不动**(维持 2076 的 episode 围栏语义:Claw 拿到的 event_id 一直有效);**但这封新信照常以自己的 delivery id 入队**。
* key 存在、event 不同、`route_class` 或 `to_agent` 不同(例如 `duty_reroute ↔ duty_fallback` 切换)→ 新 episode(沿用 G2 覆盖语义),不把新投递并进错误的收件人。
* key 存在且已 RESOLVED → 新 episode:重置 `event_id / delivery_id / opened_at / ticket_status / acked_at=NULL / resolved_at=NULL / owner_ref=NULL / handoff_reason=NULL / handoff_delivery_id=NULL / handoff_generation=0 / resolve_draft_id=NULL`,`fire_count=1`,`first_seen_at` 保留。

`alert_threads` 的 `openAlertThread` UPSERT(`StateStore.ts:14307-14330`)今天只重置 `owner_ref / attempt_count / acked_at / resolved_at`;本单给它加的四列(`handoff_reason / handoff_delivery_id / handoff_generation / resolve_draft_id`)必须同时进 INSERT 列表与 `DO UPDATE` 的重置项,否则新 episode 会继承旧 episode 的转出/草稿字段。

> 与 `alert_threads` 的一处有意差别:`alert_threads` 同 key 新 event **覆盖**旧 episode(2076 G2)。车道 A 这里选「未解决则并入当前 episode」,理由是车道 A 一封信一个 event、10 天 1409 个,覆盖式会让 Claw 手里的 event_id 每几分钟失效一次;并入式下 Claw 的 ack/handoff/resolve 永远针对「这个问题当前这一轮」。这是身份规则不是噪音判断。

写入点:`LeadInboxRuntime.enqueueInfraAlert()`(`lead-inbox-runtime.ts:561-610`)。runtime 构造参数含 `store`(`lead-inbox-runtime.ts:74`),可直接调 `store.upsertAlertMailboxLedger(...)`。**顺序:先写账,再投信**,且写账在 `inspectDeliveryState` 的 `archived_terminal` 早返回(`:576-579`)之前 —— 这样重放同一封信时账本走 no-op 分支,不会因早返回漏账。写账失败**不阻断投信**(投信是主职),但 `console.warn('[alert-ledger] …')`、`ledgerWriteErrors++`(进程内只读计数,进 seat 探针与看板)并每进程一次 `metaAlertNotifier.notify({reason:'alert_ledger_write_failed'})`。不再做更重的 durable reconciliation:StateStore 是 Bridge 的主库,它写不进去是 Bridge 级故障,已有 meta-alert 通道;本单不为此加对账循环。

**分类在投递前决定收件人**(`classifyInfraLetter({requestedOwner, eventType, dutyAvailable}) → {routeClass, toAgent}`,纯函数放 `infra-event-router.ts`;`dutyAvailable = isDutyConfigured() && isLeadQueueOpen(Claw)`,由 runtime 注入):

| routeClass | 条件 | 实际收件人 | 账本落法 |
|---|---|---|---|
| `duty` | 请求投 Claw | Claw | NEW —— Claw 的欠账 |
| `direct_owner` | 请求投 Lead 且 kind ∈ `DIRECT_OWNER_KINDS` | 请求的 Lead | 原子种成 `ESCALATED / owner_ref=lead:<Lead> / handoff_reason=direct_owner / handoff_delivery_id=<这封信> / acked_at=now` —— 可见,不是 Claw 欠账 |
| `duty_reroute` | 请求投 Lead、kind 不在白名单、duty 可用 | **Claw** | NEW,`requested_owner=<Lead>` —— Claw 的欠账;三处直投在生产就走这一行 |
| `duty_fallback` | 请求投 Lead、kind 不在白名单、duty 不可用 | 请求的 Lead | 同 direct_owner 落法,`handoff_reason=duty_fallback` |

没有「投了再标违规」的类别:Lead 信箱只可能出现 `direct_owner`、`duty_fallback` 与转出信。`reroutedCount`(进程内)进 seat 探针作诊断。

### 1.3 点名档白名单

`enqueueInfraAlert(ownerLeadId, payload)` 被以下调用方直接调用(`plugin.ts`):

| 行 | 调用方 | 现收件人 | 改后 |
|---|---|---|---|
| 5702 | `workflowSourceAlertFallback` | `payload.leadId` | **Claw** |
| 7033 | resident receiver supervisor `delivery_operation_stalled` | receiver 的 Lead | **Claw** |
| 8145 | `DeliveryContractWatch.enqueueUnboundAlert`(无 runId 的 delivery-contract 升级) | `alertIdentity.leadId` | **Claw** |
| 8948 / 9023 | flag scan owner / effects | 旗标扫描 owner(有 fallback 链) | 不动(点名档) |
| 11971 | `infraTicketSink`(D1 Router 普通告警) | Claw | 不动 |
| 11987 | `leadInboxSink`(`LEAD_INBOX_KINDS` = `review_job_failed`) | issue owner Lead | 不动(点名档) |

三处调用点代码不动;`enqueueInfraAlert` 内部把非白名单 kind 改投 Claw 时保留 `payload.leadId` 原值(信内 `affected=` 仍是受影响 Lead),`requested_owner` 记原请求收件人;`deliveryId` 前缀含实际收件人,与旧 deliveryId 不碰撞。

**点名档白名单** `DIRECT_OWNER_KINDS = LEAD_INBOX_KINDS ∪ {flag_scan_failed, flag_scan_no_clock, flag_scan_handoff}` 放 `infra-event-router.ts`。守卫是投递前分类:以后再长出的直投调用点自动进 `duty_reroute`,不需要维护调用点清单。

**T7(Lead 附加条件的落点)**:三处调用点**零改动**,规则在 `enqueueInfraAlert` 内:Bridge 有 duty token 且 Claw 队列开 → `duty_reroute` 到 Claw;否则 `duty_fallback` 留原 Lead。预检通过后 Claw 的 `queue.enqueue` 抛错(仅 `duty_reroute`)→ **一次有界回退**:同 event pristine 重分类 `duty_fallback` → 投原 owner;第二次也抛 → 抛出,没有第三条路径。fail-open 到 Lead,不 fail-silent;本就请求 Claw 的 `duty` 路径保持既有失败语义。

### 1.4 转出信(R7 必达)

在 duty 路由的 `handoff` 分支、账本事务成功之后,调用新方法 `leadInboxRuntime.enqueueAlertHandoff(toLeadId, {deliveryId, lane, correlationKey, eventId, kind, reason, note, ref})` —— `deliveryId` **只接收** SQL 返回的完整 `handoff_delivery_id`,应用层不自己拼:

* deliveryId = `alert_handoff:<lane>:<correlationKey>:<eventId>:<to>:g<generation>`;`generation` 在 **SQL 内原子递增**并在同一条 UPDATE 里拼出 `handoff_delivery_id`(`? || ':g' || (handoff_generation + 1)`),调用方读回行取 id ⇒ 两次交错 handoff 必得不同 generation;每次调用一封新信(at-least-once)。MailboxQueue 对已存在 identity 返回原行不重插(`mailbox-queue.ts:637-658`),所以没有 generation 就无法「再 handoff 一次」重投 DEAD 的信。
* `sourceKind='infra_alert'`,`type=<kind>`,`content` 首行 `[alert_handoff] <kind> · 来自值守 · 去向 ②/③`,正文含 Claw 的 🧭 五行、thread 链接(车道 B)或 `alert-ticket lookup --event-id <e>` 定位(车道 A)、以及 ③ 时的回填命令行。
* 复用 `enqueueInfraAlert` 底层的入队与 `nudge`(独立方法 `enqueueAlertHandoff`,转出信本身不落账),不新增投递路径。顺序:`no_entry` 先幂等预写 `owed` 回执(失败 → 500,不 handoff)→ **一条** fenced UPDATE 写全 `acked_at / ESCALATED / owner_ref / handoff_reason / handoff_delivery_id / handoff_generation` → 投信;任一点崩溃都能从账本读出「已转出、信 id 已定」,看板用送达态区分「未入队」;预写回执后崩溃,重试同一请求从头幂等继续,最坏多一张同身份回执(幂等合并),不会漏债。
* 送达态读法:新 `readHandoffSettlement(toLeadId, deliveryId)`:runtime 用 `projectByLead.get(toLeadId)`(`lead-inbox-runtime.ts:176`)解析**目标 Lead 的 project** 再调 `getLeadEventSettlement`(`:612`)—— 不能用告警源的 `projectName`(`machine` 工单转 flywheel 的 Tadashi 时会查错队列)。`MailboxSettlement` 五分支映射:`live | archived_nonterminal | archived_terminal` 取其 `.state`(QUEUED/LEASED/ACKED/DEAD);`absent_identity` → `NOT_QUEUED`;`torn_identity` / 未知 Lead / 抛错 → `UNKNOWN`;无 handoff → `null`。看板逐条读、逐条 fail-soft,不缓存。
* `enqueueInfraAlert` 要求 `projectByLead.get(ownerLeadId)` 存在;handoff 目标已在路由里用全舰 roster 校验过(`alert-duty-router.ts` handoff 分支),同一 roster 来源。

> 2076 的 handoff 分支现状:只写账 + `renderTicketLine`。转出信是**追加**在其后的一步;信投失败(runtime 抛)→ 路由返回 200 但 `handoffLetter: {queued:false, error}`,账本已 ESCALATED 且 delivery id 已定;看板读出 `NOT_QUEUED`。不回滚账本:账本是真相,信是送达手段。③(`reason=no_entry`)时路由另写一张 `owed/` 回执(§3)。

## 2. Duty API / CLI

### 2.1 现有(2076,`alert-duty-router.ts`)

`GET /duty/alert-tickets/outstanding?limit&since` → `{tickets, cursor, limit}`;`POST /duty/alert-tickets/transition {action: ack|handoff|resolve, messageId|eventId, to?}`。`dutyAuth` 未配置 503 `alert_duty_unconfigured`。

### 2.2 扩展

| 路由 | 变化 |
|---|---|
| `lookup`(新,GET) | 只读预检:`eventId \| messageId` → `{lane, correlationKey, eventId, kind, leadId, projectName, ticketStatus, ackedAt, resolvedAt, ownerRef, ref}`;`ref` = thread url(thread)或 `alert-ticket lookup --event-id <e>`(mailbox)。`oncall-draft add` 与 `resolve --draft` 靠它取 frontmatter 字段;不受 `acked_at` 过滤(ack 之后也查得到) |
| `outstanding` | 服务端合并两条车道:`store.listDutyOutstanding` + `store.listMailboxLedgerOutstanding`,各取 `limit` 条后按 `(opened_at, event_id)` desc 归并截断到 `limit`;每项加 `lane: "thread" \| "mailbox"`、`fireCount`、`toAgent`;cursor 编码不变(两表同列名),`since` 同时施加到两表 |
| `transition` | locator 增 `--event-id` 双表查找:先 `alert_threads`,再 `alert_mailbox_ledger`;`messageId` 仅车道 B。`lane` 由查到的表决定,响应回显。`resolve` 车道 B 走 `hub.resolve`(不变);车道 A 直接 `store.resolveMailboxLedger(ck, eventId, draftId)`(带 event 围栏,要求已预绑);`handoff` 增 `reason: contact_book \| no_entry`(必填)与 `note?`;两车道 handoff 后都投转出信 |
| `resolve` 前置 | body 必带 `draftId`(语法 `^[a-z0-9][a-z0-9._-]{0,119}$`,否则 400 `runbook_draft_required`)。服务端 `readDraftReceipt(draftId)` 读 `pending/<draftId>.md` 的 frontmatter:不存在 → 404 `draft_receipt_missing`;`book≠runbook` 或 `lane / correlation_key / event_id / kind` 与 fenced row 任一不等 → 400 `draft_receipt_mismatch`。通过后**先** `bindResolveDraft`(fenced:`resolved_at IS NULL AND (resolve_draft_id IS NULL OR resolve_draft_id=?)`;异 draftId → 409 `draft_conflict`),**再**走 thread lane 原样 `hub.resolve(ck, eventId)` / mailbox lane `resolveMailboxLedger`。两个 DB 写不能原子,预绑保证不存在「已解决但无核验草稿」的行;Hub 失败时行未解决但已绑,重试同 draftId 幂等。CLI 的 `resolve --draft <file>` = `lookup` → `oncall-draft add`(拿 draftId)→ POST;add 失败不 POST。ARC / Hub 的无参 `resolve` 不经此路由,不受影响 |
| `GET /duty/alert-board?resolvedSince&limit&cursor` | 新:见 §4 |

### 2.3 CLI(`packages/flywheel-comm/src/commands/alert-ticket.ts`,187 行)

```
alert-ticket lookup  (--message-id|--event-id) [--json]          # 只读预检
alert-ticket outstanding [--json] [--limit] [--since]           # 输出多一列 lane / fires(thread lane 为 -)
alert-ticket ack     (--message-id|--event-id) [--wait]
alert-ticket handoff --to <leadId> --reason contact_book|no_entry [--note "<≤400 字>"] (locator)
alert-ticket resolve --draft <file> (locator)                    # lookup → oncall-draft add → POST
alert-ticket board [--json] [--resolved-since 7d] [--limit 200] [--cursor <c>]
```

退出码沿用 `0 / 2 用法 / 3 400·403·409 / 4 404 / 5 503·网络`;新增:`alert_duty_unconfigured` 时 stderr 固定一行 `alert-ticket: duty write path unconfigured on Bridge (FLYWHEEL_ALERT_DUTY_TOKEN)`,供角色文件规则匹配。

## 3. 册子回填(`oncall-draft`)

### 3.1 草稿文件

目录 `${FLYWHEEL_STATE_DIR:-~/.flywheel}/oncall-drafts/{owed,pending,landed}/`(角色文件已承诺的根目录,细分三个子目录,三处都保留 frontmatter,所以欠账按 event 回执数算、不从账本 active row 猜历史)。回执身份 = `(book, lane, correlation_key, event_id, kind)`;文件名 = draftId = `<book>--<kind 经 sanitize 且 ≤ 40>--<sha256(JSON.stringify([book,lane,ck,eventId,kind])) 前 16 hex>`,抗碰撞、前缀只为可读;digest 相同而五元身份不同 = 碰撞 → fail-closed `receipt_conflict`。写入:containment 用 `path.relative(root, resolved)` 不以 `..` 开头且非绝对路径(不用裸 `startsWith`,避免同前缀 sibling);`lstat` 拒 symlink;**发布用 no-clobber 原语**:同文件系统 tmp 写入 → `fs.linkSync(tmp, target)` 抢占 → unlink tmp;`EEXIST` → 重读 target 比对**语义相等**(五元身份 + 正文 + `to`,排除时间字段):相等 → 幂等返回,不等(含同身份异正文)→ `receipt_conflict`,**绝不覆盖**(普通 rename 会静默替换,且「先检查再 rename」有 TOCTOU);带内容转换的目录移动(owed→pending 补正文与 `to`、pending→landed 补 `landed_at`)= 先在目标目录写出完整目标 bytes 的 temp → link 抢占目标 → 校验 → **最后** unlink 源;EEXIST 且目标已是预期语义 → 继续 unlink 源。frontmatter:

```yaml
---
book: runbook | contact-book
kind: <alert kind>
lane: thread | mailbox
correlation_key: <ck>
event_id: <eventId>
author: <leadId>
created_at: <ISO>
ref: <thread url | "alert-ticket lookup --event-id <e>">
to: <leadId>            # 仅 contact-book
landed_at: <ISO>        # 仅 landed/
---
```

`owed/` 回执由 Bridge 在 `handoff --reason no_entry` 时、账本变更**之前**幂等写(frontmatter only,`book: contact-book`,**不含 `to`**;`to` 是回填者查明后的责任 Lead,由 `add --book contact-book --to` 补);`oncall-draft add --book contact-book --event-id <e> --to <leadId>` **以 owed 回执为权威**(不 lookup,因为 active row 可能已被新 episode 覆盖而 lookup 404),把它移到 `pending/` 并补正文与 `to`;无 owed 回执 → 退出 4。

正文:runbook 按 `_template.md` 五栏(现象 / 去哪看 log 还原 / 做了什么 / 怎么确认好了 / 该找谁);contact-book 正文一行「为什么归这个 Lead」。

### 3.2 命令

```
oncall-draft add     --book runbook --event-id E [--author A] --file F|-                        # lookup 取 lane/ck/kind/ref → 校验 → 落 pending;输出 draftId
oncall-draft add     --book contact-book --event-id E --to L [--author A] --file F|-             # 以 owed 回执为权威 → 校验 → owed 移到 pending;输出 draftId
oncall-draft list    [--json]                                                                    # owed / pending / landed 各多少,按 kind
oncall-draft harvest --repo <path> [--dry-run]                                                   # pending → doc/oncall/ 追加 → 移到 landed(加 landed_at)
```

`add` 的**通用写法守卫**(R4.0 机械化,只拒绝、不改写):正文含 `/Users/`、`/home/`、`$HOME` 字面量、17-20 位纯数字(snowflake)、`sk-`/`ghp_`/`Bearer ` 前缀、邮箱 → 退出 3 并列出命中行。README「通用写法」已经是规则,这里只是把最机械的那几条变成命令行拒绝。

`harvest` 的确定性写法:

* runbook:`doc/oncall/runbooks/<kind>.md` 不存在 → 从模板生成并填五栏;存在 → 在文末追加 `## 处置记录 <YYYY-MM-DD>` 小节(五栏内容 + `<!-- backfill:<eventId> -->` 标记);同 eventId 标记已存在 = 「页已写」→ 跳过写页,**但仍继续把回执 pending → landed**(写页后、移动前崩溃的恢复路径;contact-book 行标记同理)。
* contact-book:`doc/oncall/contact-book.md` 表里该 kind 行存在 → 把「找谁」列改成草稿的 `to`(只在草稿 `to` 与现值不同时改),行尾加 `<!-- backfill:<eventId> -->`;不存在 → 追加一行。
* 完成后把草稿移到 `landed/`;不 commit、不 push、不开 PR(留给调用者)。`--dry-run` 只打印 diff 摘要。

### 3.3 触发与责任

* ①:Claw 在 `resolve` 时必带草稿(CLI 强制)。
* ③:handoff `--reason no_entry` ⇒ Bridge 先写 owed 回执,转出信里附一行现成命令 `oncall-draft add --book contact-book --event-id <e> --to <leadId> --file -`;Tadashi 查明后执行。
* 收割:任何有仓库写权的人(Tadashi 或他派的 docs runner)跑 `harvest --repo`,开 PR。看板「册子欠账」= `{owed:[kind…], pending:n, landed:n}`,全部来自回执文件;harvest 后 pending → landed,欠账归零且不会回弹。
* README supersession:`doc/oncall/README.md` 现行两句「不为了册子增加脚本 / 生成器 / 状态探针」「不增加检测代码、机械对账或新的处理流水」由本单依 founder 2026-09-06 裁定改写为「机械入口只有三个:落草稿并拒本机值 / 按回执写页 / 数欠账」。

## 4. 看板(R6)

`GET /duty/alert-board?resolvedSince=<ISO, 默认 now-7d>&limit=<默认 200, 上限 500>&cursor=<opaque>` → 

```jsonc
{
  "generatedAt": "...",
  "dutyWritePath": "configured",
  "ledgerWriteErrors": 0,
  "reroutedCount": 0,                                                                                  // 诊断计数,不是状态
  "totals": { "unreviewed": n, "in_duty": n, "handed_off": n, "resolved_in_window": n },              // 全量,不受分页影响
  "backfill": { "owed": ["kind", ...], "pending": n, "landed": n },
  "items": [ { "lane", "correlationKey", "eventId", "kind", "leadId", "project",
               "state": "unreviewed|in_duty|handed_off|resolved",
               "ownerRef", "routeClass", "requestedOwner", "handoffReason", "handoffGeneration",
               "handoffLetter": "QUEUED|LEASED|ACKED|DEAD|NOT_QUEUED|UNKNOWN|null",
               "fireCount", "openedAt", "ackedAt", "resolvedAt", "resolveDraftId", "ref" } ],
  "nextCursor": "…" | null,
  "truncated": false
}
```

状态推导(两张表同一函数 `deriveDutyState`):`resolved_at` 非空 → resolved;`ticket_status='ESCALATED'` → handed_off;`acked_at` 非空 → in_duty;否则 unreviewed。四档,没有第五档;`route_class` 与 `handoff_reason` 是行上的正交字段。主键 `(lane, correlation_key)`:同一 key 若在两条车道各有活跃行就是两行(Router 在有合法 mention 时会把同 key 送进 Hub,无 mention 时送进信箱,理论上可并存;不合并、不裁决,如实列)。`items`:**所有 unresolved 无视 `resolvedSince` 始终列出**,resolved 只列窗内;oldest-first;`limit` 只是分页,超出给 `nextCursor` + `truncated=true`;`totals` 永远是全量。**看板不发任何告警、不 @ 任何人、无阈值**。

`GET /duty/alert-board` 与 `alert-ticket board` 走 duty token;`/api/alert-duty/seat`(`tools.ts:139`,挂在 `/api` 的共享 token 中间件后,`plugin.ts:2821-2825`;seat CLI 已带 `TEAMLEAD_API_TOKEN`)增 `dutyWritePath`、`ledgerWriteErrors`、`reroutedCount`,Claw 启动 provisioning 行打印 `write=<configured|unconfigured|->`。

Claw 的 `#flywheel-notify` digest:角色文件加一行「digest 末尾附 `alert-ticket board --json` 的 `totals` 与 `backfill.owed` 摘要,一行,不 @」。

## 5. 角色文件(`.lead/claude-infra-bot-lead/identity.md`)

改动点(哨兵测试 `fly2076-identity-sentinel.test.sh` 需同步):

* 「每条工单的固定流程」增车道 A 分支:无 thread 的信箱工单不发 🧭,五行内容写进 `--note`;定位用 `--event-id`(信内 `event=` 字段旁的 id);去向 ② ③ 用 `handoff --reason`。
* `resolve` 必带 `--draft`;草稿由 `oncall-draft add` 落位与校验(不再手写路径);③ `handoff --reason no_entry` 会给 Tadashi 留一张 owed 回执。
* `outstanding` 退出码 5 且 stderr 含 `duty write path unconfigured` → 在根频道发一帖 `⚠️ 值守写路径未配置 <@Tadashi>`,同一会话一次;继续只读处置(看、查、不记账)。
* digest 一行终态摘要。
* 哨兵必含新增词:「--reason」「--draft」「oncall-draft add」「duty write path unconfigured」「信箱工单不发 🧭」「owed 回执」;必不含:「手写 oncall-drafts/<kind>.md」。

## 6. 测试基座(现有,可追加)

| 文件 | 现有 | 追加什么 |
|---|---|---|
| `bridge/__tests__/alert-threads-tickets.test.ts`(259 行)+ `__tests__/fly-2006-database-retention-sweep.test.ts` | 2076 账本围栏;retention 硬计数 | `alert_mailbox_ledger` upsert 六种 disposition 与 deliveryProjection、outstanding 归并与 cursor、handoff 单语句 + SQL 内 generation、bindResolveDraft、四列 ADD COLUMN 与 `rowToAlertThread` 扩展、retention policy |
| `bridge/__tests__/alert-duty-router.test.ts`(491 行,含 Hub fixture) | 鉴权矩阵、五类联测 | 双表 locator、`reason` 必填、resolve 无 draft 400、handoff 后转出信 deliveryId 与幂等、board 状态推导与 handoffLetter 读取 |
| `bridge/__tests__/lead-inbox-runtime.test.ts` | `enqueueInfraAlert` 既有用例 | runtime 分类四分支与收件人;账本先于投信、写失败不阻断;settlement 五分支下的同 event 重放动作;`duty_reroute` 有界回退;`enqueueAlertHandoff` 形状 |

| `flywheel-comm/commands/__tests__/alert-ticket.test.ts`(181 行) | 四子命令 | `board`、`handoff --reason`、`resolve --draft` 先 add 后 POST、unconfigured 固定 stderr |
| 新 `flywheel-comm/commands/__tests__/oncall-draft.test.ts` + `oncall-receipts.test.ts` | — | receipt 库:sanitize、containment、symlink、原子写、三目录移动、`readBackfillDebt`;add 守卫命中/放行、owed → pending;list;harvest 幂等、dry-run、模板生成、contact-book 改行、landed_at |
| `bridge/__tests__/infra-alert-wiring.test.ts`(追加) | D1 路由 | 非白名单 kind 请求投 Lead(调用点代码不改):duty 可用 → Claw +1 / Lead +0;不可用 → Lead +1 且 `duty_fallback`;`leadRecipientState='alive'` + owner enqueue 抛错的 D1 外层 catch 路径下账本最终 `to_agent=Claw` |
| `scripts/__tests__/fly2076-identity-sentinel.test.sh`(78 行) | 词表 | 新增必含/必不含 |
| `scripts/__tests__/lead-duty-provision.test.sh` | 状态行 | `write=` 字段 |

## 7. 529 房验收形状(交 QA 节点,这里只定证据)

两个 Lead 身份 A / B(slot Lead),Claw 席位,Bridge 设 duty token:

| 步 | 动作 | 证据 |
|---|---|---|
| 1 | 注入一条无 runId 的 delivery-contract 升级,`alertIdentity.leadId = B` | B 的 `mailbox` 零 `infra_alert` 行;Claw 信箱 1 封;`alert_mailbox_ledger` 1 行 NEW,`lead_id=B`,`to_agent=Claw`,`route_class=duty_reroute`,`requested_owner=B` |
| 2 | Claw `handoff --to A --reason no_entry --event-id <e>` | 账本 ESCALATED `owner_ref=lead:A` `handoff_reason=no_entry` `handoff_generation=1`;A 的 `mailbox` 恰 1 封 `[alert_handoff]`(deliveryId `…:g1`);B 仍 0;`owed/contact-book--<kind>--<digest>.md` 存在且 frontmatter 五元身份正确;`board` 该项 `handed_off` 且 `handoffLetter=ACKED`(A 在线) |
| 3 | 再跑一次同 handoff | 200,`generation=2`,A 第 2 封(`…:g2`);账本 `handoff_delivery_id` 指向 g2;`owed/` 仍只有一张同身份回执 |
| 4 | 同 key 再注入一条(新 event) | `fire_count=2`,账本 `event_id` 不变;**Claw 信箱多一封新 delivery id 的信**;board 该项仍 handed_off |
| 5 | `resolve --event-id <e>` 不带 `--draft` | 退出 2/3,400 `runbook_draft_required`;直接 POST 伪造 `draftId=x` → 404 `draft_receipt_missing` |
| 6 | `resolve --draft f.md`(含通用写法违规行) | `oncall-draft add` 退出 3,列出命中行;未 POST |
| 7 | 修正后 `resolve --draft` | pending/ 出现草稿(文件名以 digest 结尾,frontmatter lane/ck/event/kind 与 lookup 一致);账本 RESOLVED `resolve_draft_id` 非空;board 转 resolved;用另一份草稿再 resolve → 409 `draft_conflict` |
| 8 | `oncall-draft add --book contact-book --event-id <e> --to A` 后 `harvest --repo <worktree>` | owed → pending → landed;`doc/oncall/runbooks/<kind>.md` 多一个 `## 处置记录` 小节带 `<!-- backfill:<e> -->`;contact-book 该 kind 行「找谁」= A 且行尾带标记;再跑一次零 diff;`board.backfill.owed` 不含该 kind |
| 9 | 拔掉 duty token 重启 Bridge,再注入一条同步 1 的升级 | `/api/alert-duty/seat`(共享 token)`dutyWritePath=unconfigured`;Claw `outstanding` 退出 5 且 stderr 固定行;**B 收到 1 封**(fail-open),用 DB 直查账本 `duty_fallback`;然后**恢复 token 重启 Bridge**,再查 `board` 该项 handed_off + reason `duty_fallback` 可读 |
| 10 | 车道 B 对照:一条 escalation → thread | 既有 2076 链不变;`handoff` 后 A 收到 `[alert_handoff]` 信且 thread 内 🧭 仍恰一个 `<@id>`;thread lane 行 `fireCount=null` |
| 11 | 一条 `review_job_failed` 归 B | B 收到(点名档);账本 `direct_owner`;board handed_off |
| 12 | 通过测试 seam 请求把一条非白名单 kind 投给 B(duty 已配置) | **B 收到 0 封**,Claw +1;账本 `duty_reroute`,`requested_owner=B`;`reroutedCount` +1 |

## 8. 回滚边界

* 新表只追加、不迁移旧数据;revert 代码后表留着无害。
* `alert_threads` 的四列 ADD COLUMN 幂等,revert 后旧代码不读它们;retention policy 与 registry 条目随代码 revert。
* 三处调用点未改;`enqueueInfraAlert` 的分类 revert 即回到 Lead 直收。
* 草稿目录是状态目录下的文件,不进仓库;harvest 只在调用者的 worktree 产生普通文件 diff。
* 角色文件 revert + 重启 Claw。
