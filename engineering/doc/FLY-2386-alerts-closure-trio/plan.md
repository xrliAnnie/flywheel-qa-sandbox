# FLY-2386 值守小版三件收口 — 实施计划
Issue: FLY-2386 (https://linear.app/geoforge3d/issue/FLY-2386/alerts值守小版-2073-收口后还在咬的-3-件判理册解法册沉淀-每件事有闭环终点-被-的人分档prd-2060)
日期: 2026-09-06
基于: research.md

> **v6 · Codex R6 APPROVED(2026-09-06,共 6 轮)**。实现提示(不改合同):`InfraAlertQueueReceipt`(`lead-inbox-runtime.ts:66-70`)扩成判别联合以容纳 `{queued:false, deliveryId, reason:'settlement_torn'}`;五分支 settlement 动作收在一个 settlement-aware delivery helper 里,`replayed_same` 与 `locked_canonical` 共用它,R2 的 archived/torn 重放用例同时覆盖同投影与异投影。
> **v6(Codex R5 之后)**:① 同 event 异投影时,按 canonical settlement 的**五个分支**分别定动作:`absent_identity` → 允许 reseed(仍需 pristine);`live` → `locked_canonical`,用 live 行原 `created_at` 做 identity 幂等 enqueue(既有 `existing?.created_at` 路径);`archived_nonterminal / archived_terminal` → `locked_canonical`,**不再调用 enqueue**(identity 已被永久认领,普通 enqueue 会因新时间戳触发 identity conflict);`torn_identity` / inspect 抛错 → fail-closed:不 reseed、不转投、不 enqueue,记 warn 并返回 `{queued:false, reason:'settlement_torn'}`;看板 `handoffLetter` 映射:`live | archived_nonterminal | archived_terminal` 取其 `.state`(QUEUED/LEASED/ACKED/DEAD),`absent` → NOT_QUEUED,`torn` / 未知 Lead / 异常 → UNKNOWN;② T1 ⑥ 明确扩展 `AlertThreadRow` 与 `rowToAlertThread`(四个新列,NULL/0 默认),R1 断言 mapper 返回四列;③ research §6 / §2.2 文字与最终合同同步(六 disposition、runtime 守卫、调用点仅注释、`resolveMailboxLedger(ck, eventId, draftId)`)。
> **v5(Codex R4 之后)**:① 同 event 异投影的重分类授权绑定到 **mailbox settlement**,不只看账本:runtime 先按 canonical `(to_agent, delivery_id)` 调 `inspectDeliveryState`,只有 `absent_identity`(= 上一次 enqueue 确实没成功)才允许 fenced pristine 重写;`live / archived_* / torn_identity` 一律 fail-closed 保留 canonical 并按 canonical identity 幂等重投(新收件人 +0);② upsert 返回 **enum disposition** 而不是 `adopted:boolean`:`inserted / replayed_same / reseeded / locked_canonical / merged / new_episode`,每个都带 `deliveryProjection` —— `merged`(跨 event 同 class 并入)与 `inserted / reseeded / new_episode` 返回 **incoming** 投影(新 event、新 delivery id 必须入队,投递量不减),`replayed_same / locked_canonical` 返回 canonical;③ 回执「同身份」= 五元 identity + 语义内容(正文与 `to`,排除时间字段)全等才幂等;同 identity 异正文 → `receipt_conflict`;带内容转换的目录迁移(owed→pending 补正文、pending→landed 补 `landed_at`)先在目标目录生成完整 bytes 的 temp → link 抢占 → 校验 → 最后 unlink 源;EEXIST 且目标已是预期语义 → 继续清理源;④ 漂移:R4 fixture 显式 `leadRecipientState='alive'` 再让 owner `enqueue` 抛错以覆盖 D1 外层 catch;owed 回执**不含** `to`(`to` 由 `add --book contact-book --to` 补,T4 输入同步删掉);research §4 seat 文字补 `reroutedCount`;去掉「v3」版本引用;风险表「无 token」范围改为「A1 改投的非白名单告警」。
> **v4(Codex R3 之后)**:① 同 event 重投分两种:投递投影(`route_class / to_agent / requested_owner / delivery_id`)相同 → 纯 no-op,不碰任何生命周期列;投影不同 → 只在行仍是 **pristine seed**(SQL 谓词:`resolved_at IS NULL AND resolve_draft_id IS NULL AND handoff_generation = 0 AND (acked_at IS NULL OR handoff_reason IN ('direct_owner','duty_fallback'))`)时重写;否则保留 canonical 行,upsert 返回 canonical 投影,runtime **按返回的投影投递**、不向新推导的收件人投第二份;② `duty_reroute` 的 Claw enqueue 抛错 → 一次有界回退:pristine 重分类为 `duty_fallback` 并投 requested owner;第二次也抛则抛出,没有第三条路径(Lead 条件的 throw 分支落地);③ 回执 digest = `sha256(JSON.stringify([book,lane,ck,eventId,kind]))` 前 16 hex,身份含 `kind`;「唯一」改为「抗碰撞、碰撞即 fail-closed」;发布用 `link(tmp, target)` 抢占(EEXIST → 重读比对:同身份幂等 / 异身份 `receipt_conflict`),目录移动同样 link-then-unlink,绝不普通 rename 覆盖;并发测试用不同正文断言 winner 内容不被替换;④ T1 加 `scripts/fly-2006-retention-consumer-gate.config.json`(`targetTables` + consumers/disposition),§4 加 gate 测试与 gate 命令;⑤ harvest 崩溃恢复:marker 已存在 = 「页已写」,仍必须继续 pending → landed;两本册子各一条「写页后崩溃、重跑零 doc diff 且回执 landed」测试;⑥ 漂移清理:`ref` 统一为 `alert-ticket lookup --event-id <e>`;`enqueueAlertHandoff` 只接收 SQL 返回的完整 `deliveryId`;seat 响应补 `reroutedCount`;board 引用 `research §4`;research §1.3/§8 与 529 步 2/9 文字对齐;P0 说明限定为「A1 改投的非白名单告警」,529 步 9 先用 DB/seat 取证、恢复 token 后再查 board。
> **v3(Codex R2 之后)**:① 分类在**投递前**决定收件人:`enqueueInfraAlert(requestedOwner, payload)` 内部按 `classifyInfraLetter` 算出实际收件人 —— 非白名单 kind 请求投 Lead 时,duty 可用就改投 Claw(`duty_reroute`),不可用才投 Lead(`duty_fallback`);**没有 `unclassified` 这种投递类别**,看板也没有第五档;T7 三处调用点因此零改动(规则在 runtime 里);② 账本 upsert 改为「同 event → 按本次投递投影重写 seed 列(允许失败重路由后的重分类);异 event 且 `route_class / to_agent` 相同才并入,否则新 episode」;③ thread lane `resolve` 先用 event 围栏把已核验的 draftId **预绑**到未解决行(同 draftId 幂等、异 draftId 409 `draft_conflict`),再走原样 `hub.resolve`;不会出现 `resolved_at` 非空而 `resolve_draft_id` 空;④ ③ 兜底顺序:先幂等预写 `owed` 回执 → 写失败则不 handoff(500 `owed_receipt_write_failed`)→ 账本 handoff → 投信;`add --book contact-book` 以 owed 回执为权威,不再 lookup;⑤ 回执文件名 = `<book>--<kind≤40>--<sha256(book|lane|ck|event) 前 16 hex>`,目标已存在则比对 frontmatter 身份(同 → 幂等,异 → 409 conflict,绝不覆盖);containment 用 `path.relative`;⑥ 补触点:retention registry `deleteTarget` + engine `staticPolicy`(按 `resolved_at` 14 天,同 `alert_threads`)+ fixture + 硬计数;`flywheel-comm/package.json` 加 `./oncall-receipts` export;`MetaAlertNotifier` reason 加 `alert_ledger_write_failed`,runtime 通过窄回调 `onLedgerWriteFailure` 注入且 best-effort catch;⑦ `handoff_generation` 在 SQL 内原子 `+1` 并把 `handoff_delivery_id` 一并拼出(`|| ':g' || (handoff_generation+1)`),读回行取 id;P0 文案收窄为 Bridge 侧可检条件(Claw 未重启只是延迟,信在 durable 信箱里);24h 验收同时看 meta-alert 落盘证据;plan/research 字段与命令统一(`ref` 用 `lookup --event-id <e>`)。
> **v2(Codex R1 之后 + Lead 裁定 e064d949)**:① 两表 schema 闭合:`alert_mailbox_ledger` 补 `resolve_draft_id / handoff_generation`,`openAlertThread` UPSERT 在新 episode 原子清空四个 per-episode 列;② 账本写入改为显式分类(`duty / direct_owner / duty_fallback / unclassified`)、账本先于投信、同 event 重放幂等;③ handoff 一条 fenced UPDATE 同时写 owner / reason / generation / delivery id,再投信;`generation` 让「再 handoff 一次」真的重投;送达态按目标 Lead 的 project 查;`absent_identity` 显示 `NOT_QUEUED`;④ 新增只读 `lookup` 预检;服务端 `resolve` 校验草稿回执真实存在且 book/lane/ck/event/kind 与 fenced row 一致;draftId 语法、目录 containment、symlink、原子写;⑤ 册子欠账改为按 event 的 durable 回执(`owed/ → pending/ → landed/` 三目录,都保留 frontmatter),不从 active row 猜;⑥ 看板主键 `(lane, ck)`、unresolved 不受 `since` 裁剪、cursor + `truncated` + 全量 totals;⑦ `doc/oncall/README.md` 两句「不加脚本 / 不加流水」由本单显式 supersede(founder 2026-09-06「做,开小单」),写进 README;⑧ A1 已由 Lead 原则批准并附加条件:duty 未配置或 Claw 队列不可用时 **fail-open 回退直投 Lead**,并写清 657 封无 runId 升级的新去向;T7 不再是可砍分支;⑨ 压力文案改正(账本归并不减投递量)、seat 探针走 `/api` 共享 token、测试排除命令给出可执行形式、点名档守卫改为运行时分类 + 看板 `misrouted` 可见,不维护平行 allowlist。

## 0. 一句话

给告警补一本**去向账**(车道 A 新表 `alert_mailbox_ledger`,与 `alert_threads` 同一套词汇),把 2076 的 ack / handoff / resolve 扩到两条车道;在账上挂三个出口:`resolve` 必带经服务端核验的 runbook 草稿回执、③ 兜底落一张 `owed` 回执、`oncall-draft harvest` 把草稿确定性写进 `doc/oncall/`(R3/R4);`alert-ticket board` 按四档列出每个 `(lane, key)` 的终态与转出信送达态,不截断挂着的(R6);非白名单 kind 在投递前改投 Claw(duty 不可用则投原 Lead 并标 `duty_fallback`),Lead 只收 Claw 的 `[alert_handoff]` 信与合同已声明 owner 的 kind(R7)。不加指标、阈值、噪音判定;不动 Dispatcher 与 D1 分类表。

## 0.1 前提与裁定

| # | 内容 | 状态 |
|---|---|---|
| P0 | **上线前置(非代码)**:生产设 `FLYWHEEL_ALERT_DUTY_TOKEN`,随班车重启;核 `[alert-duty] … gate=changed\|noop write=configured`,`GET /api/alert-duty/seat`(带 `TEAMLEAD_API_TOKEN`)返回 `dutyWritePath=configured`。今天生产 `unset`,2076 整条写路径是暗的(exploration §1.2) | **Lead 裁定:由 Lead 设进生产 env,runner 不碰生产 env** |
| A1 | 非白名单 kind 请求投 Lead 时改投 Claw 队列(覆盖三处直投,规则在 runtime) | **Lead 原则批准**,附加条件:duty 未配置 / Claw 队列不可用 → 回退到现状直投 Lead(fail-open 到 Lead,不 fail-silent);写清 657 封无 runId 升级的新去向与可见性(§2.4) |
| A2 | 「同一个问题」= `correlationKeyFor()` 同 key;车道 A 未解决则并入当前 episode(research §1.2);同一 key 理论上可在两条车道各有一行,看板主键是 `(lane, key)` | 设计决定,HTML 给 founder 看 |
| A3 | Discord 的 `<@id>` 只是人可读留痕;送达靠信箱转出信 | 设计决定,HTML 给 founder 看 |
| A4 | `doc/oncall/README.md` 里「不为了册子增加脚本 / 生成器 / 状态探针」与「不增加新的处理流水」两句由本单 supersede:founder 2026-09-06 拍「回填机制没有 → 做」。本单加的机械入口**只做三件事**:落草稿并拒绝本机值、按回执写页、数欠账;不做检测、对账、状态机 | T11 把 supersession 写进 README;已在 ask 里报 Lead |

## 1. 改动清单(文件级)

| # | 文件 | 改什么 |
|---|---|---|
| T1 | `packages/teamlead/src/StateStore.ts` + `scripts/lib/fly-2006-retention-registry.mjs` + `scripts/lib/fly-2006-retention-engine.mjs` + `scripts/__tests__/fixtures/fly-2006-teamlead-production-tables.json` + `scripts/fly-2006-retention-consumer-gate.config.json` | ① 建表 `alert_mailbox_ledger` + 索引(research §1.2 DDL,含 `route_class / requested_owner / resolve_draft_id / handoff_generation`);同一 chunk 内:registry `deleteTarget` 组加表名、engine 加 `staticPolicy("alertMailboxLedger","teamlead","alert_mailbox_ledger","correlation_key","julianday(t.resolved_at)<julianday(?)")`(与 `alertThreads` 同 14 天口径)、fixture 排序插入、`fly-2006-database-retention-sweep.test.ts` 硬计数 +1、consumer-gate config 的 `targetTables` 加 `alert_mailbox_ledger` 并按 `node scripts/fly-2006-retention-consumer-gate.mjs` 的输出登记 `StateStore.ts` 与 `fly-2006-retention-engine.mjs` 的每个 read consumer 及 disposition;② `alert_threads` 幂等 ADD COLUMN `handoff_delivery_id TEXT`、`handoff_reason TEXT`、`resolve_draft_id TEXT`、`handoff_generation INTEGER DEFAULT 0`(FLY-927 模式 `:4369-4380`);③ `openAlertThread` 的 INSERT 列表与 `ON CONFLICT … DO UPDATE` 增这四列并在新 episode 置 NULL / 0(`:14307-14330`);④ 方法(全部 `AND event_id=?` 围栏,0 行 → false):`upsertAlertMailboxLedger(input, {allowReseed:boolean}) → {disposition, deliveryProjection}`(research §1.2:`inserted` / `replayed_same`(同 event 同投影,纯 no-op)/ `reseeded`(同 event 异投影、`allowReseed` 为真且行 pristine,SQL 谓词)/ `locked_canonical`(同 event 异投影但不允许或行已被值守动过 → 不写)/ `merged`(异 event 未解决且 `route_class` 与 `to_agent` 相同 → `fire_count+1`,账本 event 不变)/ `new_episode`(否则,清空 per-episode 列);`deliveryProjection`:`replayed_same / locked_canonical` = canonical 行的投影,其余 = **incoming** 投影 —— `merged` 必须投新 delivery id)、`getMailboxLedgerByEventId`、`listMailboxLedgerOutstanding(limit, since?)`、`stampMailboxLedgerAck`、`handoffLedger(lane, ck, eventId, {ownerRef, reason, deliveryIdPrefix})`(**一条 UPDATE**:`handoff_generation = handoff_generation + 1`,`handoff_delivery_id = ? || ':g' || (handoff_generation + 1)`,同时写 `acked_at / ticket_status=ESCALATED / owner_ref / handoff_reason`;返回读回的行,调用方从行里取 `handoff_delivery_id` 与 `handoff_generation`;两次交错调用必得两个不同 generation;thread lane 替换既有 `handoffTicket`)、`bindResolveDraft(lane, ck, eventId, draftId)`(fenced:`resolved_at IS NULL AND (resolve_draft_id IS NULL OR resolve_draft_id = ?)`;0 行时区分 409 `draft_conflict` / `stale_episode`)、`resolveMailboxLedger(ck, eventId, draftId)`(要求 `resolve_draft_id = ?` 已预绑);⑤ `listAlertBoard({resolvedSinceIso, limit, cursor?})`:两表 UNION,unresolved 全列、resolved 按窗,`ORDER BY opened_at ASC, event_id ASC, lane ASC`,cursor `(opened_at, event_id, lane)`,另返回全量 `totals`;⑥ `AlertMailboxLedgerRow` 类型、mapper;**`AlertThreadRow` 与 `rowToAlertThread`(`StateStore.ts:67182-67258` 一带)同时扩展 `handoff_reason / handoff_delivery_id / handoff_generation / resolve_draft_id`(NULL / 0 默认)**,thread lane 的 handoff 响应、board、draft conflict 都从 mapper 取值 |
| T2 | `packages/teamlead/src/bridge/lead-inbox-runtime.ts` | ① `enqueueInfraAlert(requestedOwnerLeadId, payload)`:签名不变,内部先 `classifyInfraLetter({requestedOwner, eventType, dutyAvailable: this.dutyAvailable()})` 得 `{routeClass, toAgent}`(research §1.3 表):`duty`(请求 Claw)→ Claw;`direct_owner`(白名单 kind)→ 请求的 Lead;`duty_reroute`(非白名单 kind 且 duty 可用)→ **Claw**;`duty_fallback`(非白名单 kind 且 duty 不可用)→ 请求的 Lead。`dutyAvailable()` = 构造时注入的 `isDutyConfigured()`(读 `config.alertDutyToken`)&& `isLeadQueueOpen(Claw)`。**先写账后投信**:`duty / duty_reroute` → 行 NEW `to_agent=Claw`,`requested_owner=<请求的 Lead>`;`direct_owner / duty_fallback` → 行原子种成 `ESCALATED`,`owner_ref=lead:<toAgent>`,`handoff_reason=<routeClass>`,`handoff_delivery_id=<这封信自己的 deliveryId>`,`acked_at=now`(不是 Claw 欠账);`route_class` 列记分类。转出信走独立方法不落账。账本写失败 → `console.warn('[alert-ledger] …')` + `ledgerWriteErrors++`(只读 getter)+ 每进程一次 `deps.onLedgerWriteFailure?.(err)`(plugin 注入为 `metaAlertNotifier.notify({reason:'alert_ledger_write_failed'})` 的 best-effort 包装,自带 catch),**仍投信**;写账在 `inspectDeliveryState` 的 archived 早返回**之前**执行;同 event 重投(含 `createInfraAlertSink` 里 owner 信箱抛错后回落 Claw 的既有路径):runtime 先查账本;若存在同 event 行且投影不同,**先按 canonical `(to_agent, delivery_id)` 调该收件人 project 队列的 `inspectDeliveryState`**,按五个分支定动作:`absent_identity` → `allowReseed=true`(上一次 enqueue 确实没成功),upsert 后按 `deliveryProjection` 投;`live` → `allowReseed=false`,`locked_canonical`,用 live 行原 `created_at` 对 canonical 收件人做 identity 幂等 enqueue(新推导收件人 +0);`archived_nonterminal / archived_terminal` → `locked_canonical`,**不调用 enqueue**(identity 已永久认领;普通 enqueue 会因新 `created_at` 撞 `mailbox identity conflict`),返回 `{queued:true, deliveryId}`;`torn_identity` 或 inspect 抛错 → fail-closed:不 reseed、不转投、不 enqueue,`console.warn` 并返回 `{queued:false, deliveryId, reason:'settlement_torn'}`。其余 disposition(`merged / inserted / reseeded / new_episode`)→ 投 incoming(新 delivery id 必入队);**`duty_reroute` 的 Claw enqueue 抛错 → 一次有界回退**:pristine 重分类 `duty_fallback`(同 event)→ 投 requested owner;第二次也抛 → 抛出,不加第三条路径;请求本就是 Claw 的 `duty` 路径保持既有失败语义;② 新 `enqueueAlertHandoff(toLeadId, input:{deliveryId, lane, correlationKey, eventId, kind, reason, note, ref})`:**`deliveryId` 只接收 SQL 返回的完整 `handoff_delivery_id`**(形如 `alert_handoff:<lane>:<ck>:<eventId>:<to>:g<n>`),应用层不再自己拼;`sourceKind='infra_alert'`,`type=<kind>`,`collapseKey=deliveryId`,内容由纯函数 `formatAlertHandoffContent(input)` 生成(首行 `[alert_handoff] <kind> · 来自值守 · 去向 ②/③`、五行 note、ref、③ 时附 `oncall-draft add --book contact-book --event-id <e> --to <leadId> --file -`);复用既有 enqueue + nudge;③ 新 `readHandoffSettlement(toLeadId, deliveryId)`:用 `projectByLead.get(toLeadId)` 解析目标 project 后调 `getLeadEventSettlement`,未知 Lead → `{kind:'unknown_lead'}`;④ `correlationKeyFor` 从 `AlertChannelHub.ts` 导入;⑤ 新只读 `isLeadQueueOpen(leadId)`:`projectByLead.has` && `queues.has(project)`;⑥ 构造 deps 增 `isDutyConfigured: () => boolean`、`onLedgerWriteFailure?: (err) => void`、`reroutedCount` getter(`duty_reroute` 次数,进 seat 探针作诊断) |
| T3 | `packages/teamlead/src/bridge/infra-event-router.ts` | 导出 `DIRECT_OWNER_KINDS = new Set([...LEAD_INBOX_KINDS, "flag_scan_failed", "flag_scan_no_clock", "flag_scan_handoff"])`;导出纯函数 `classifyInfraLetter({requestedOwner, eventType, dutyAvailable}) → {routeClass: 'duty'\|'direct_owner'\|'duty_reroute'\|'duty_fallback', toAgent}`(T2 用它;测试直接打它) |
| T4 | `packages/teamlead/src/bridge/alert-duty-router.ts` | ① locator:`eventId` 先 `alert_threads` 再 `alert_mailbox_ledger`(event 只会落一条车道,先后只是查找顺序),返回 `{lane,row}`;`messageId` 仅 thread;② 新 `GET /alert-tickets/lookup?eventId\|messageId`(duty token):返回 `{lane, correlationKey, eventId, kind, leadId, projectName, ticketStatus, ackedAt, resolvedAt, ownerRef, ref}`,`ref` = thread url(thread)或 `alert-ticket lookup --event-id <e>`(mailbox);③ `ack` 按 lane;④ `handoff`:`reason` 必填 `contact_book\|no_entry`(否则 400 `handoff_reason_required`),`note` ≤ 400 字;顺序:(a) `reason=no_entry` 先 `deps.writeOwedReceipt({book:'contact-book', kind, eventId, lane, ck})`(不含 `to`,`to` 由回填者用 `add --book contact-book --to` 补;幂等;写失败 → 500 `owed_receipt_write_failed`,**不** handoff);(b) **一条 fenced UPDATE**(`handoffLedger`,generation 与 delivery id 在 SQL 内生成);(c) `deps.enqueueAlertHandoff(to, {deliveryId: row.handoff_delivery_id, …})`;投信抛错 → 200 `handoffLetter:{queued:false,error}`(账本已 ESCALATED 且 id 已定,看板读出 `NOT_QUEUED`);thread lane 保留 `renderTicketLine`;同 `to` 重复 handoff = 新 generation = 新信(at-least-once,明写);(a) 之后崩溃 → 重试同一请求从 (a) 幂等继续,最坏多一张 owed 回执(同身份幂等)不会漏债;⑤ `resolve`:body 必带 `draftId`(语法 `^[a-z0-9][a-z0-9._-]{0,119}$`);服务端 `deps.readDraftReceipt(draftId)` 读 `pending/<draftId>.md` 的 frontmatter,必须 `book=runbook` 且 `lane/correlation_key/event_id/kind` 与 fenced row 全等,否则 400 `draft_receipt_mismatch` / 404 `draft_receipt_missing`;通过后 **先** `bindResolveDraft(lane, ck, eventId, draftId)`(同 draftId 幂等,异 draftId 409 `draft_conflict`),**再** thread lane 走原样 `hub.resolve(ck, eventId)` / mailbox lane `resolveMailboxLedger`;Hub 失败时行仍未解决但已绑草稿,可安全重试;⑥ `outstanding`:两表各取 `limit`,归并截断,项加 `lane / fireCount(thread lane 为 null,不追踪) / toAgent`;⑦ 新 `GET /alert-board?resolvedSince&limit&cursor`:`resolvedSince` ISO 默认 now-7d;`limit` 默认 200 上限 500;返回 `{generatedAt, dutyWritePath:'configured', ledgerWriteErrors, reroutedCount, totals:{unreviewed,in_duty,handed_off,resolved_in_window}, backfill:{owed,pending,landed}, items:[…], nextCursor, truncated}`;`handoffLetter` 逐项 `deps.readHandoffSettlement(ownerLeadId, deliveryId)`:`live | archived_nonterminal | archived_terminal` 取其 `.state` → `QUEUED\|LEASED\|ACKED\|DEAD`;`absent_identity` → `NOT_QUEUED`;`torn_identity` / 未知 Lead / 异常 → `UNKNOWN`;无 handoff 的项为 `null`;逐项 fail-soft;状态推导纯函数 `deriveDutyState(row)` 导出 |
| T5 | `packages/teamlead/src/bridge/tools.ts:139` + `plugin.ts`(runtime 构造处 `:5680` 一带与 duty 路由挂载处)+ `alert-duty-seat-cli.ts` + `packages/teamlead/src/MetaAlertNotifier.ts` | seat 探针(仍在 `/api`,共享 token)增 `dutyWritePath`、`ledgerWriteErrors`、`reroutedCount`;seat CLI 透传 `dutyWritePath`;runtime 构造注入 `isDutyConfigured: () => Boolean(config.alertDutyToken)` 与 `onLedgerWriteFailure`(包装 `metaAlertNotifier.notify`,`void …catch`);`MetaAlertReason` union 加 `alert_ledger_write_failed`;duty 路由 deps 注入 `enqueueAlertHandoff`、`readHandoffSettlement`(bind 到 runtime 实例)、`readDraftReceipt` / `writeOwedReceipt` / `readBackfillDebt`(T6 的 receipt 库,根目录 `${FLYWHEEL_STATE_DIR:-~/.flywheel}/oncall-drafts`) |
| T6 | `packages/flywheel-comm/src/oncall-receipts.ts`(新,纯文件库)+ `packages/flywheel-comm/package.json` exports 加 `"./oncall-receipts": "./dist/oncall-receipts.js"` + `packages/flywheel-comm/src/commands/oncall-draft.ts`(新)+ `index.ts` 注册 | receipt 库:三目录 `owed/ pending/ landed/`;回执身份 = `(book, lane, correlation_key, event_id, kind)`;draftId = 文件名 stem = `<book>--<kind 经 sanitize 且 ≤ 40>--<sha256(JSON.stringify([book,lane,ck,eventId,kind])) 前 16 hex>`(抗碰撞;前缀只为可读;digest 相同而身份不同 = 碰撞 → fail-closed `receipt_conflict`);发布 = 同文件系统 tmp 写入 → `fs.linkSync(tmp, target)` 抢占 → unlink tmp;`EEXIST` → 重读 target 比对**语义相等**(五元身份 + 正文 + `to`,排除 `created_at / landed_at` 等时间字段):相等 → 幂等返回,不等(含同身份异正文)→ `receipt_conflict`,**绝不覆盖**(不用普通 rename,它会静默替换);带内容转换的目录移动(owed→pending 补正文与 `to`、pending→landed 补 `landed_at`)= 先由源 + 命令输入生成**完整目标 bytes** 写到目标目录 temp → link 抢占目标 → 校验目标语义 → **最后** unlink 源;EEXIST 且目标已是预期语义 → 视为已完成,继续 unlink 源;任何时刻两个目录不会同时持有「未转换」的目标;containment:`path.relative(root, resolved)` 不以 `..` 开头且不是绝对路径;`lstat` 拒 symlink(目录与文件);frontmatter 解析/序列化;`readBackfillDebt()` = `{owed:[kind…], pending:n, landed:n}`;`writeOwedReceipt(identity)` 幂等。命令:`add --book runbook`(先 `alert-ticket lookup --event-id` 取 lane/ck/kind/ref)/ `add --book contact-book --event-id <e> --to <leadId>`(以 `owed/` 回执为权威,不 lookup;无 owed 回执 → 退出 4);`--author` 默认 `FLYWHEEL_LEAD_ID`;守卫 `GENERIC_WRITING_VIOLATIONS` 只拒不改;`list [--json]`;`harvest --repo <path> [--dry-run]`(纯函数 `applyRunbookDraft(pageText\|null, draft)`、`applyContactBookDraft(tableText, draft)`;`<!-- backfill:<eventId> -->` 已存在的含义是「页已写」→ 跳过写页但**仍继续** pending → landed(加 `landed_at`),所以写页后崩溃重跑 = 零 doc diff + 回执落位;不 git) |
| T7 | `packages/teamlead/src/bridge/plugin.ts:5702, 7033, 8145` | **零改动**:三处仍调 `enqueueInfraAlert(<lead>, payload)`,改投规则在 T2/T3(非白名单 kind → `duty_reroute` 到 Claw,duty 不可用 → `duty_fallback` 留原 Lead)。只在三处各加一行注释指向 `classifyInfraLetter` |
| T8 | `packages/flywheel-comm/src/commands/alert-ticket.ts` | `lookup (locator) [--json]`;`handoff --reason --note`;`resolve --draft <file> (locator)`:`lookup` → `oncall-draft add --book runbook …`(拿 draftId)→ POST;add 失败不 POST;`board [--json] [--resolved-since 7d] [--limit] [--cursor]`(人读:totals 一行 + 表 lane/kind/state/owner/route/letter/fires/opened;`truncated` 时打印 `nextCursor`);`alert_duty_unconfigured` 固定 stderr 行 `alert-ticket: duty write path unconfigured on Bridge (FLYWHEEL_ALERT_DUTY_TOKEN)` |
| T9 | `packages/teamlead/scripts/lead-duty-provision.sh` | 状态行末尾追加 ` write=<configured\|unconfigured\|->` |
| T10 | `.lead/claude-infra-bot-lead/identity.md` | research §5;`## runbook 立即沉淀` 改为「`alert-ticket resolve --draft <file>`;草稿由命令落位与校验,不手写路径」;③ 写「handoff --reason no_entry 会给 Tadashi 留一张 owed 回执」 |
| T11 | `doc/oncall/README.md` | ① 「通用写法」段的「不为了册子增加脚本、lint、生成器、状态探针或运行时检查」与「新告警类别上线闸门」段的「这里不增加检测代码、机械对账或新的处理流水」两句改写为:「本册子的机械入口只有三个(落草稿并拒绝本机值 / 按回执写页 / 数欠账),由 FLY-2386 依 founder 2026-09-06 裁定加入;不加检测、对账、状态机」;② 「新问题怎样入册」增「机器入口」小节:①/③ 回执、`oncall-draft add/harvest`、`<!-- backfill:<eventId> -->` 含义、谁跑 harvest 谁开 PR |
| T12 | `doc/architecture/infra-alerts-spec.md` | 只追加一段:两车道各一本账、同一词汇;投递分类 `duty / direct_owner / duty_reroute / duty_fallback` 在投递前决定收件人;转出信 = 唯一送达机制,generation;`resolve` 必带核验草稿且先预绑;看板主键 `(lane, ck)` |
| T13 | 测试(§3) | — |
| T14 | `engineering/doc/FLY-2386-alerts-closure-trio/`、`engineering/doc/milestones/FLY-2386.md` | 随 PR;最后一个 commit;不碰 `CLAUDE.md` |

**不改**:`infra-event-router.ts` 三张分类表与 `createInfraAlertSink`、`AlertChannelHub.ts`(`resolve` / `renderTicketLine` 原样)、`ticket-owner-map.ts`、`AutoRepairBot.ts`、`rescue-runtime.ts`、Dispatcher 与各发射源、`alert_threads` 既有列语义、mailbox schema 与折叠语义、任何 Lead 的 `access.json`、`_template.md`、`contact-book.md` 现有行(harvest 只在有回执时改)。

## 2. 合同

### 2.1 去向账(两表同一词汇)

| 状态 | 两表的列 | 看板档 |
|---|---|---|
| 未初审 | `acked_at IS NULL` | unreviewed |
| 值守处理中 | `acked_at` 非空,非 ESCALATED,`resolved_at IS NULL` | in_duty |
| 已转出 | `ticket_status='ESCALATED'`,`owner_ref=lead:<X>`,`handoff_reason ∈ {contact_book, no_entry, direct_owner, duty_fallback}`,`handoff_delivery_id`,`handoff_generation` | handed_off(+ 信的送达态) |
| 已解决 | `resolved_at` 非空;`resolve_draft_id` 非空 = duty 路径,空 = ARC 自动 | resolved |

episode:两表都以 `event_id` 围栏;新 episode 原子清空 `acked_at / resolved_at / owner_ref / handoff_reason / handoff_delivery_id / resolve_draft_id`,`handoff_generation=0`;车道 A:同 event 再投且投影相同 → `replayed_same`;投影不同 → 只有 canonical 信 `absent_identity` 且行 pristine(SQL 谓词)才 `reseeded`,否则 `locked_canonical`(runtime 按 canonical 投影幂等重投,新收件人 +0);异 event 同 class → `merged`(账本 event 不变、fire_count+1、**新信照常入队**);异 event 未解决且 `route_class` 与 `to_agent` 相同 → `fire_count+1`、event 不变;异 event 但 `route_class` / `to_agent` 不同 → 新 episode(沿用 G2 覆盖语义)。

### 2.2 duty API

```
GET  /duty/alert-tickets/lookup?eventId|messageId              → {lane, correlationKey, eventId, kind, leadId, projectName, ticketStatus, ackedAt, resolvedAt, ownerRef, ref}
GET  /duty/alert-tickets/outstanding?limit&since               → {tickets:[{lane, …row, resolved, fireCount|null, toAgent}], cursor, limit}
POST /duty/alert-tickets/transition
     {action:"ack",     eventId|messageId}
     {action:"handoff", eventId|messageId, to, reason:"contact_book"|"no_entry", note?}
       → 200 {lane, eventId, correlationKey, to, generation, handoffLetter:{queued, deliveryId, error?}}
     {action:"resolve", eventId|messageId, draftId}             → 200 {lane, …}
GET  /duty/alert-board?resolvedSince&limit&cursor              → research §4
GET  /api/alert-duty/seat   (共享 token)                        → 既有 + dutyWritePath + ledgerWriteErrors + reroutedCount
```

错误码:400 `handoff_reason_required` `runbook_draft_required` `draft_receipt_mismatch` 参数 / 403 / 404 `ticket_not_found` `draft_receipt_missing` / 409 `stale_episode` `already_resolved` `codex_owner_ack_only` `draft_conflict` / 500 `owed_receipt_write_failed` / 503 `alert_duty_unconfigured` `alert_hub_unavailable`。

### 2.3 转出信(R7)

* 唯一「被 @」定义:目标 Lead 的信箱里出现 `[alert_handoff]` 信。
* deliveryId 含 `generation`;每次 `handoff` 调用 = generation+1 = 一封新信(at-least-once)。「再 handoff 一次」因此真的重投,DEAD 的旧信留在账上可见。
* 送达态按目标 Lead 的 project 读;`absent_identity` → `NOT_QUEUED`(账已转出、信没进队列),与「无 handoff」的 `null` 区分。
* 点名档:`DIRECT_OWNER_KINDS` = `review_job_failed`、`flag_scan_failed`、`flag_scan_no_clock`、`flag_scan_handoff`;它们的信在账上是 `handed_off / direct_owner`,可见但不是 Claw 欠账。**Lead 信箱只可能出现三类 `infra_alert` 行**:`direct_owner`、`duty_fallback`、转出信 —— 因为非白名单 kind 在 `enqueueInfraAlert` 里投递前就被改投 Claw(`duty_reroute`);以后新长出的直投调用点自动落入同一规则,不需要维护调用点清单。`reroutedCount` 只是诊断计数。

### 2.4 三处直投的新去向(Lead 附加条件)

| 条件 | 去向 | 账本 | 可见性 |
|---|---|---|---|
| Bridge 有 duty token 且 Claw 队列开 | Claw 信箱(车道 A),`route_class=duty_reroute`,`requested_owner=<原 Lead>` | NEW,`to_agent=Claw` | 看板 unreviewed → Claw 初审 → ②/③ 时 Tadashi 收 `[alert_handoff]`。Claw 未重启 / 未加载 token 时信仍在它的 durable 信箱里等,是延迟不是丢失 |
| Bridge 无 duty token / Claw 队列关 | **原 owner Lead 信箱**(现状),`route_class=duty_fallback` | `ESCALATED / duty_fallback`,`owner_ref=lead:<owner>`,`handoff_delivery_id=<这封信>` | 看板 handed_off,reason 显示 `duty_fallback`;不会 fail-silent |
| 预检通过后 Claw 投递抛错(仅 `duty_reroute`) | **一次有界回退**:canonical `absent_identity` → 同 event pristine 重分类 `duty_fallback` → 投原 owner Lead;第二次也抛 → 抛出 | `ESCALATED / duty_fallback` | 看板 handed_off;Lead 条件的 throw 分支就落在这里 |
| 同 event 在 duty 可用性变化后重放(信已 live) | 保留 canonical 收件人,幂等重投同 delivery id;新推导收件人 +0 | 不变 | 不双投 |

657 封无 runId 的 `workflow_engine_escalation`(10 天,主要是 FLY-2366 delivery-contract 每 15 分钟一封):新路由下进 Claw 信箱,按 `project|lead|kind|session` 落账(session 含 attempt id,所以多数一封一个 key,`fire_count` 不会把它们并起来 —— 这是身份规则的如实结果,不做相似归并);Claw 按 2076 压力规则处置;Tadashi 只在 Claw handoff 时收信。**投递量不变**(每封信仍投一次,账本只影响看板行数与 Claw 的 outstanding 列表);源头重发是 R8 另开单(exploration Q3)。

### 2.5 册子回填(R3/R4)

* 回执三目录:`owed/`(③ `no_entry` 时 Bridge 在 handoff **之前**幂等写,frontmatter only)→ `pending/`(`oncall-draft add` 写正文)→ `landed/`(`harvest` 移入,加 `landed_at`)。三处都保留 frontmatter,欠账按 event 回执数:`owed` 与 `pending` 都算欠,不从账本 active row 推历史;active row 被新 episode 覆盖后,owed 回执仍能独立走完 pending → landed。
* 回执身份 = `(book, lane, correlation_key, event_id, kind)`;文件名以其 digest 结尾;发布用 link 抢占,目标已存在按「身份 + 语义内容」比对,不覆盖;同身份异正文 → conflict;并发两个 writer 异正文 → 先到者内容永不被替换,后到者明确得 conflict。
* `resolve` 无核验通过的草稿回执不成立(CLI 先 add,服务端再核 receipt 与 fenced row 全等)。
* 守卫只拒绝不改写;命中即退出 3 并逐行列出。
* `harvest` 幂等、无 git;README 写明「谁跑 harvest 谁开 PR」;PR diff 里每个 `<!-- backfill:<eventId> -->` 对应 `landed/` 一张回执。

### 2.6 看板(R6)

* 主键 `(lane, correlation_key)`;同 key 双车道 = 两行(各自 lane 标明)。
* 所有 unresolved 无视 `resolvedSince` 始终列出;resolved 只列窗内。
* `limit` 只影响分页,`totals` 是全量;`truncated=true` 时给 `nextCursor`;oldest-first。
* 不发告警、不 @、无阈值。

### 2.7 不是什么

* 看板计数不是指标:无目标值、无阈值、不触发任何告警或 @。
* 车道 A 的 episode 并入不是噪音判定:同 key 才并。
* 转出信不是新的告警层:只在 Claw 明确 handoff 时产生。
* 账本不减少投递量:1409 封仍是 1409 封。

## 3. TDD 顺序

### RED

| # | 测试 | 用例 |
|---|---|---|
| R1 | `alert-threads-tickets.test.ts`(追加)+ `fly-2006-database-retention-sweep.test.ts`(硬计数 + `alertMailboxLedger` policy 用例) | 新表 upsert:插入 / 同 event 同投影纯 no-op / 同 event 异投影 pristine 重写(`duty_reroute → duty_fallback`、`direct_owner → duty` 两组)/ **同 event 异投影在 ack 后、`contact_book` 与 `no_entry` handoff 后、resolve 后、`archived_terminal` 重放四组均 `locked_canonical` 且返回 canonical 投影;`allowReseed=false` 时即使行 pristine 也 `locked_canonical`** / 异 event 同 class → `merged`,`fire_count=2`,账本 event 不变,**`deliveryProjection` 是 incoming(新 delivery id)** / 异 event 异 class 新 episode / 解决后新 episode 清空 per-episode 列;retention consumer gate 对新表零未登记 consumer;`openAlertThread` 新 episode 清空四列(旧 episode 先 handoff+resolve 再同 key 新 event);`listMailboxLedgerOutstanding` 排序、limit、since;`handoffLedger`:一条 UPDATE、SQL 内 generation+1 且 `handoff_delivery_id` 以 `:g<n>` 结尾、两次交错调用得 g1/g2 两个不同 id;`bindResolveDraft`:同 draftId 幂等、异 draftId 0 行、已解决 0 行;`resolveMailboxLedger` 要求已绑;五个变更方法的 event 围栏;四列 ADD COLUMN 幂等且 **`rowToAlertThread` 在旧库(无列)与新库都返回四列(NULL / 0 默认)**;`listAlertBoard`:同 ck 双车道两行、旧 unresolved 不受窗裁剪、cursor 分页无重漏、totals 为全量;retention:registry 分类、engine policy 只选 `resolved_at` 早于 cutoff 的行、fixture、硬计数 |
| R2 | `lead-inbox-runtime.test.ts`(追加)+ `infra-event-router.test.ts`(`classifyInfraLetter` 四分支表驱动) | `enqueueInfraAlert` 收件人:请求 Claw → Claw(`duty`);白名单 kind 请求 Lead → Lead(`direct_owner`);非白名单 kind 请求 Lead 且 duty 可用 → **Claw +1、Lead +0**(`duty_reroute`,`requested_owner` 落账);duty 未配置 / Claw 队列关 → Lead +1(`duty_fallback`);**真 runtime + fake queue:Claw `queue.enqueue` 抛错、owner 成功 → owner +1、Claw +0、账本 ESCALATED `duty_fallback`;两个都抛 → 各尝试恰一次后抛出,账本 `duty_fallback` 且送达态可解释**;行已被值守 handoff 后同 event 重投 → 按 canonical 收件人重投、新推导收件人 +0;**两组反例:成功 `duty_reroute`(Claw 信 live、未 ack)后 duty 变不可用、同 event 重放 → Claw 信保留、Lead +0;成功 `duty_fallback`(Lead 信 live)后 duty 恢复、同 event 重放 → Lead 信保留、Claw +0;canonical identity `absent_identity` 时两个 pristine 回退用例仍能重分类;canonical 为 `archived_nonterminal` / `archived_terminal` 的同 event 重放 → 零 enqueue 调用、新收件人 +0、无 identity conflict;`torn_identity` / inspect 抛错 → `queued:false, reason:'settlement_torn'`、零 enqueue、账本不变**;**同 key 两个不同 event 同 class/to → mailbox 两个 distinct delivery id、账本首 event 保留且 `fire_count=2`**;`duty/duty_reroute` 写 NEW、`direct_owner/duty_fallback` 写 ESCALATED 且 `handoff_delivery_id` = 信 id;账本先于投信(注入顺序记录);store 抛错 → 信仍入队、`ledgerWriteErrors=1`、`onLedgerWriteFailure` 恰一次/进程且回调抛错被吞;archived 早返回前已写账;`enqueueAlertHandoff` 只用传入的 deliveryId、同 id 重放不新增、异 id 新增;`formatAlertHandoffContent` 首行与 ③ 命令行;`readHandoffSettlement` 用目标 Lead 的 project(machine 工单 → flywheel Tadashi);`isLeadQueueOpen` |
| R3 | `alert-duty-router.test.ts`(追加,复用 Hub fixture) | `lookup` 两车道;eventId 双表查找;`handoff` 缺 reason 400;成功 → 账本六列 + fake `enqueueAlertHandoff` 恰一次且 deliveryId 以 `:g1` 结尾;再 handoff 同 to → `:g2` 第二封;fake 投信抛错 → 200 `queued:false` 且账本仍 ESCALATED 且 id 已定;`no_entry`:fake `writeOwedReceipt` 在账本写之前被调、抛错 → 500 且账本未变、投信零调用;`resolve` 缺 draftId 400 且 Hub 零调用;伪造 draftId → 404;book/lane/ck/event/kind 任一不等 → 400;绑定成功后 Hub 抛错 → 行未解决但 `resolve_draft_id` 已绑,重试同 draftId 成功;异 draftId → 409 `draft_conflict`;**不变量**:任何注入崩溃点后都不存在 `resolved_at IS NOT NULL AND resolve_draft_id IS NULL` 的 duty 路径行;ack 后 resolve 成功;message-id resolve 成功(thread lane);mailbox lane resolve 不碰 Hub;`outstanding` 归并与 cursor;`/alert-board`:四档推导表驱动、`handoffLetter` 映射(live QUEUED/ACKED/DEAD、**archived_nonterminal QUEUED/LEASED、archived_terminal ACKED/DEAD**、absent→NOT_QUEUED、torn/unknown_lead→UNKNOWN、无 handoff→null)、fail-soft、`resolvedSince` 非法 400、`limit>500` 400、`truncated`+`nextCursor`、totals 全量;既有 2076 用例全部保持绿 |
| R4 | `infra-alert-wiring.test.ts`(追加) | 用真 runtime + fake queue,fixture 显式 `leadRecipientState='alive'`,再让 owner `enqueue` 抛错,驱动 `createInfraAlertSink` 外层「owner 信箱抛错 → 回落 Claw」catch:账本最终 `to_agent=Claw`、`route_class=duty`(同 event、`absent_identity` → `reseeded`);以及 `workflow_engine_escalation` 请求投 Lead → duty 可用时 Claw +1 / Lead +0,duty 不可用时 Lead +1 且 `duty_fallback`。改动前先证明该入口原本 Lead +1(RED 的 RED) |
| R5 | 新 `oncall-draft.test.ts` + `oncall-receipts.test.ts` | receipt 库:digest 含 kind(仅非法字符不同的两个 kind、超长同前缀的两个 kind 得到不同文件名;人为制造 digest 相同而身份不同 → `receipt_conflict`)、目标已存在同五元身份幂等 / 异身份 `receipt_conflict` 不覆盖、containment(`../`、绝对路径、同前缀 sibling 目录、symlink 目录与文件)拒绝、link 抢占(EEXIST 分支)、三目录移动同样 no-clobber、**并发两个 writer 同身份异正文 → 先到者正文原样保留、后到者明确 `receipt_conflict`**;同身份同正文(仅时间字段不同)→ 幂等;**owed→pending 与 pending→landed 各一个「目标 link 成功、源 unlink 前崩溃」重试:内容完整且只剩目标目录一份**;`readBackfillDebt`、`writeOwedReceipt` 幂等;`add --book runbook`:五类违规各一命中 → 退出 3 且列行;合规 → pending 且 frontmatter 齐;`add --book contact-book`:以 owed 为权威、无 owed → 退出 4、active row 已被新 episode 覆盖后仍 owed → pending;`list`;`harvest`:页不存在由模板生成、存在追加带标记小节、同 eventId 二次零 diff、contact-book 改行/追加/同值不改、`--dry-run` 不写不移、成功后 landed 有 `landed_at`、**runbook 与 contact-book 各一条「写页后崩溃(回执仍在 pending)→ 重跑零 doc diff 且回执进入 landed」** |
| R6 | `alert-ticket.test.ts`(追加) | `lookup`;`handoff` 缺 `--reason` 退出 2;`resolve --draft` 顺序 lookup → add(fake)→ POST 且 body 含 draftId;add 失败不 POST;`board` 人读与 `--json`、`--cursor` 续页;503 固定 stderr 行 + 退出 5 |
| R7 | `fly2076-identity-sentinel.test.sh` | 必含「--reason」「--draft」「oncall-draft add」「duty write path unconfigured」「信箱工单不发 🧭」「owed 回执」;必不含「手写 oncall-drafts/<kind>.md」 |
| R8 | `lead-duty-provision.test.sh` | 状态行 `write=configured` / `unconfigured` / `-` |

阳性对照:R1 先证明不带围栏的 UPDATE 会改行;R3 先证明不经路由账本无变化;R4 先证明改动前 owner +1。

### GREEN

T1 → T3 → T2 → T6(receipt 库先于路由)→ T4 → T5 → T8 → T7(注释)→ T9 → T10 → T11 → T12。每步只让对应 RED 变绿,不顺手重构。

## 4. 全仓自验

```
pnpm lint
pnpm -r build
pnpm --filter './packages/*' --filter '!./packages/core' test:run
pnpm --filter ./packages/core exec vitest run --exclude '**/tmux-viewer.macos.test.ts'   # 该用例真开 Terminal.app,禁跑
bash packages/teamlead/scripts/__tests__/fly2076-identity-sentinel.test.sh
bash packages/teamlead/scripts/__tests__/lead-duty-provision.test.sh
bash packages/teamlead/scripts/__tests__/apply-alert-duty-gate.test.sh
bash packages/teamlead/scripts/__tests__/check-flag-truth.test.sh      # 本单不新增 env 变量,只确认无回归
node --test scripts/__tests__/fly-2006-retention-consumer-gate.test.mjs
node scripts/fly-2006-retention-consumer-gate.mjs                       # 新 deleteTarget 的 consumer 审计(CI 单跑,本地也跑)
```

实现节点先核 `packages/core/package.json` 的 `test:run` 是否已排除该用例;若已排除,第二行合并回 `pnpm test:packages:run`。

## 5. Codex code review

`codex:rescue` 循环到 APPROVED。重点:两表词汇与 episode 清空一致;每条变更的 event 围栏;handoff 单语句 + generation;receipt 核验与路径安全;账本先于投信与重放幂等;fail-open 回退;看板不截断 unresolved;2076 既有用例零改动仍绿;README supersession 句子落地。

## 6. 部署与验收

| 步 | 证据 |
|---|---|
| 0 | P0(Lead 执行):设 token → 班车重启 → Claw `[alert-duty] … gate=changed\|noop write=configured`;`curl -H "Authorization: Bearer $TEAMLEAD_API_TOKEN" $BRIDGE/api/alert-duty/seat` → `dutyWritePath=configured`;`jq` 核 Claw access.json 告警组 `requireMention=false`。Bridge 侧可检条件只有「token 已加载 + Claw 队列开」:**Bridge 无 token → A1 改投的非白名单告警走 `duty_fallback` 直投原 Lead(本就请求 Claw 的普通告警照常进 Claw 信箱,只是 Claw 记不了账);Bridge 有 token 但 Claw 未重启 → 信进 Claw durable 信箱等待,Claw 重启后处理(验收 INCONCLUSIVE 直到 Claw 行 `write=configured`)** |
| 1 | 部署后 24h:`alert_mailbox_ledger` 行数 > 0;`ledgerWriteErrors=0` **且** meta-alert 落盘目录 / Bridge 日志无 `alert_ledger_write_failed`(计数会随重启清零,落盘证据才算);Tadashi 信箱新 `infra_alert` 行只剩 `direct_owner` kind、`[alert_handoff]`、`duty_fallback`(若步 0 未完成) |
| 2 | 第一条真实 ③:账本 `no_entry`,`owed/` 一张回执;Tadashi 信箱 1 封 `[alert_handoff]` 且 ACKED;board handed_off + `handoffLetter=ACKED` |
| 3 | 第一条真实 ①:`pending/` 草稿;`resolve_draft_id` 非空;`harvest` 后 PR 里 `doc/oncall/runbooks/<kind>.md` 多一段带标记,`landed/` 有回执 —— **验收条 1** |
| 4 | `alert-ticket board`:每项四档之一;unresolved 全列;founder 能读出「挂着可见」清单 —— **验收条 2** |
| 5 | 529 房 research §7 十二步,两 Lead 对照 —— **验收条 3**(QA 节点执行) |

## 7. 回滚

research §8。新表与新列 revert 后无害(新 episode 清空逻辑随代码 revert;retention policy 随 registry 条目一起 revert);T2 的分类 revert 即回旧路由(调用点没动);回执是状态目录文件;角色文件 revert + 重启;README 句子随 PR revert。没有数据迁移。

## 8. 边界

| 不做 | 去处 |
|---|---|
| 噪音判定、相似归并、severity 优先 | 第 2 层 |
| Infra bot 本身 | 独立议题 |
| `workflow_engine_escalation` 无 runId 分支每 15 分钟重发 | R8 根因线,建议另开单(exploration Q3) |
| Lead 的 Discord 告警频道订阅 / FLY-898 式门控 | 拒绝的替代方案(exploration §3.4) |
| 转出信 DEAD 的自动重投 | 不做;看板可见,Claw 再 handoff = 新 generation |
| 减少投递量 / mailbox 折叠 | 不做;账本只归并看板行 |
| 2076 G1 / G2 / G3 | 原样沿用 founder 裁定 |
| 自动开 PR | 不做;harvest 只写文件 |

## 9. 风险

| 风险 | 概率 | 处置 |
|---|---|---|
| P0 未完成 | 中 | Bridge 无 token → A1 改投的非白名单告警 fail-open 直投原 Lead(普通告警照常进 Claw 信箱);Bridge 有 token 而 Claw 未重启 → durable 等待;三处可见(seat 探针 / provisioning 行 / Claw 规则);不失明 |
| 车道 A 首轮欠账多(657 封无 runId 升级各自成 key) | 高 | 沿用 2076 压力自述;账本不减投递量,明写;源头另开单 |
| receipt 核验 + 预绑让 `resolve` 多一次文件读一次 UPDATE | 低 | 失败码清晰;预绑后可重试 |
| harvest 改表误伤 | 低 | 纯函数 + 幂等测试 + `--dry-run` |
| 守卫误杀合法 17 位数字 | 低 | 只拒绝、列行,作者改写 |
| README supersession 被 Lead 否 | 低 | 已报 Lead;若否,T6 缩为 receipt 库 + add(守卫)+ list,删 harvest,入册回人工 |
