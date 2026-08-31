# FLY-2076 Claw 值守席位 — 实施计划
Issue: FLY-2076 (https://linear.app/geoforge3d/issue/FLY-2076/2073值守-claw-infrabot-值守上岗对整条队列负责-初审三去向宁转勿吞)
日期: 2026-08-26
基于: research.md

> **v10(Lead instruction f490a35d,code review R1 收敛)**:① 撤掉 `duty_visible` 加列；`outstanding` 改成服务端有界(default 25,max 100)、`opened_at,event_id` newest-first，并接受该 tuple 的 opaque `since` cursor；Claw 满批主动报压力、逐批处置，不一次拉全历史；② `ack` 只写 `acked_at`，T2 查询要求 `acked_at IS NULL`，绝不让值守 ACK 喂给任何自动 @founder 路径；③ handoff 用全舰 roster 一次 lookup，任何 project / fleet 工单都能转 Tadashi；④ Claw 的 `FLYWHEEL_DIR` 直接由 launcher 注入 repo root，不新增 config/env 传播层。
> **v9(Codex R7 之后,3 条)**:① `hub.resolve(ck, expectedEventId)` 在**任何 Discord / 账本副作用之前**先比对初次读到的活跃行的 `event_id`(不等 → `stale_episode`,零副作用),末尾的谓词围栏保留为第二道;② 不再承诺「只归档一次」:并发的 ARC resolve 与值守 resolve 都可能各发一次恢复帖 / 各归档一次(既有 Hub 无串行化,不为此加机制),合同只保证账本幂等;③ T6 文案与 §2.1 / R4 对齐。
> **v8(Codex R6 之后,4 条)**:① **删除**另一个 `acked_at` 写入者 —— rescue 路由的 `ackTicket`(`plugin.ts:10130-10150`,FLY-927「救援调用 = owner bot 认领」,在救援结果之前就盖 ACK;生产两个月 0 次触发)—— 值守成为唯一认领者,`acked_at` 只有一个含义;② 🧭 模板末行 `handoff --to <leadId>`(roster id,不是 Discord mention),哨兵禁 `--to <@`;③ `hub.resolve` 末尾 0 行要区分:重读非活跃行,同 `event_id` 且 `resolved_at` 非空 → 200 幂等(ARC 在 Discord await 期间先解决了同一 episode),否则 409 `stale_episode`;④ research §1.4 / §6 对齐 v7/v8。
> **v7(Codex R5 之后,4 条,仍是既有 UPDATE 上的守卫与文档修正)**:① 围栏落在**变更语句本身**:`hub.resolve` 内两次 correlation-key-only 写(`setTicketStatus` / `resolveAlertThread`)改为带 `event_id` 的谓词,0 行 → `stale_episode`;handoff 谓词加 `resolved_at IS NULL AND ticket_status <> 'RESOLVED'`;② `outstanding` 加 `ticket_status IS NOT NULL`(排除 legacy 非工单行);③ 🧭 模板的「账本」字段改为「落账:待执行 ack|handoff」,T11 / §10 / research §3.4 残留清理,哨兵加词;④ 2075 切换门加「duty 写路径可用」证据(boot 行 `token=set` + 认证 `GET /duty/alert-tickets/outstanding` 200),且 **token 未设时 provisioning 不翻门控**(`gate=skipped:no_duty_token`);T8 补 `bridge/types.ts` 的 `BridgeConfig` 字段与 dispatcher id 的 holder。
> **v6(Codex R4 之后,5 条,均为 v5 合同内的一行守卫 / 文档修正,不恢复任何删掉的机制)**:① 顺序改为**先发帖、后记账**,记账(`ack` / `handoff`)= 这条处置完成,重启按 `acked_at IS NULL` 重做 —— 代价是至少一次(可能多一帖 = G1),不再有「记了账没留痕」的静默丢失;② 每个变更带 `event_id` 围栏(`WHERE correlation_key=? AND event_id=?`),`hub.resolve` 加 `expectedEventId`;③ `outstanding` 不再过滤 `resolved_at`,自动 RESOLVED 的工单以 ack-only 回收,`--event-id` 定位用不过滤 resolved 的查找;④ owner=Codex bot 的工单不 handoff、只 ack;🎫 行 owner 文案由路由按 roster 解析后传给 Hub;Hub 缺席时 `resolve` 503;seat 探针放回 `/api/alert-duty/seat`(启动 CLI 没有 duty token);⑤ research 残留清理。
> **v5(Tadashi scope guard,2026-08-26 ~10:00Z,收在 Codex R3 之后)**:「只删不加」—— ⛔ 不加状态机(值守认领 = 写**既有**的 `alert_threads.ACK/acked_at`,那个两个月没被写过的字段正是 bug);⛔ 不加新表 / 持久层(要持久就用既有表,否则不做);mention 白名单 / 归档 thread 发帖 / root-only stub 只能是既有路径上的**一行守卫**,不能是子系统;被取代 episode 与 PRD R2 的冲突**交 founder 在 HTML 上看**,不设计绕过。v4 的 `alert_duty_receipts` / `alert_duty_posts` / intent 状态机 / Bridge 代发 全部**删除**;下面是删完的版本,比 v3 短。
> 历史:v4(R3 之后)、v3(R2 之后)、v2(R1 之后)见 git;它们把 Codex 指出的每个缺口都用新机制封死,方向与 guard 相反,不再引用。

## 0. 一句话

把 Claw 从「只响应 @我的工单」改成 **alerts 频道唯一值守席位**:接入 = 翻它告警频道那组的插件门控(`requireMention:false` + dispatcher 进 `allowBots`);看到每条工单根消息后必落 ①/②/③ 之一:先用既有 `reply` 在 thread 发一帖 🧭 留痕,再写既有账本 —— 认领 = `acked_at`(既有列,PRD §1.3 数的那个),转出 = 既有 `ESCALATED` + `owner_ref`,解决 = 既有 `RESOLVED`。记账 = 处置完成;重启按「没记账的」逐批重做(至少一次)。不加表、不加列、不加状态机、不加告警层；API 的批次安全上限不成为指标、考核或值守工作 hard limit。

## 0.1 前提、跨 PR 合同、拍板点

| # | 前提 | 状态 | 缺席时本单交付什么 |
|---|---|---|---|
| P1 | FLY-2075:ticket 根消息在频道、Hub 开 thread、删自动 @founder / 自动 ESCALATED | Tadashi 07:26Z comment 定向;founder 一字确认待收 | 代码与角色文件照合;验收在 2075 切频道单腿后采 |
| P2 | FLY-2078 R7:被 @ 的 Lead 必达 | 未开 | ②/③ 只留痕不必达;**① 独立验收** |
| P3 | FLY-2077 册子路径 | 未开 | research §4 最小接口;路径变动 = 改角色文件一行 |

**与 FLY-2075 的跨 PR 合同**(各自实现,谁先合谁不动对方文件):C1 ARC 保留、值守 `acked_at` 与 `ticket_status` 正交(`AlertChannelHub.ts:466-582`);C2 handoff 时 🎫 行 owner 段一并重渲染(`:596-602` 现只换状态段,**一行正则**);C3 `🔧 Cass 收到` → `🔧 已登记(<title>)。<ackTail>`(`:456`,一行);C4 owner map 的根消息 @ 不变,owner=Codex bot 的工单值守记 ② 不再 @;C5 部署顺序 2076 先 → 实证门控活 → 2075 同窗切单腿。

**Tadashi 拍**:D1 `ESCALATED` 复用为「值守已转出,球在 `owner_ref`」;D2 runbook 草稿两步走(不给 Claw git 写权);D3 专用 token `FLYWHEEL_ALERT_DUTY_TOKEN` 进 `.env`,并接受它是**防误用的 capability、不是身份隔离**(§2.2);D6 旁路根消息(无 thread 无账本行)切出本单 R2 覆盖。

**founder 看的(HTML 评论层)**:值守永不自行 @她;兜底是 Tadashi;未解决 thread 她自己翻;2076 先于 2075 部署;**以及三条本单不封的缺口(§2.5),按 guard 交她判**。

## 1. 改动清单(文件级)

| # | 文件 | 改什么 |
|---|---|---|
| T1 | `packages/teamlead/src/bridge/alert-duty-seat.ts`(新,≈40 行) | `ALERT_DUTY_SEAT = { leadId: "claude-infra-bot-lead" }`;纯函数 `resolveAlertDutySeat({ leadId, projectName, projects, env }) → { isDutySeat, alertChannelId \| null }`。`INFRA_ALERT_LAST_MILE_ROUTE.ownerLeadId` 引用它;2075 已删该常量 → 不碰 `infra-alert-mailbox.ts` |
| T2 | `packages/teamlead/src/alert-duty-seat-cli.ts`(新,仿 `core-room-gate-cli.ts`) | `--lead-id --project [--projects-file] [--bridge-url]` → `{ isDutySeat, alertChannelId, dispatcherBotUserId \| null }`(dispatcher id 从 `GET /api/alert-duty/seat` 取;Bridge 不可达 → null,stderr 保留) |
| T3 | `packages/teamlead/scripts/apply-alert-duty-gate.sh`(新) | 仿 `apply-core-room-mention-gate.sh` 反向:`.groups[$ch].requireMention=false \| .allowFrom=[]`,`--allow-bot <id>` 并入 `allowBots`(只增不删);group 缺席 `skipped:no_alert_group`;`atomic_patch` 逐字复制 FLY-898;不吞 stderr |
| T4 | `packages/teamlead/scripts/lead-duty-provision.sh`(新)+ `claude-lead.sh`(FLY-898 块后 `source`)+ `lead-body.sh` / `flywheel-lead-wrapper-v2.sh`(token 投递缝) | 调 T2 → 席位则 T3 → 打**唯一形状**一行 `[alert-duty] seat=<true\|false> lead=<id> channel=<id\|-> gate=<changed\|noop\|skipped:reason\|-> dispatcher=<id\|unresolved:reason\|-> token=<set\|unset>`。token 三处缝:wrapper 白名单(`:318-350`)仅席位放行;`lead-body.sh:6-12` 重灌后非席位 `unset`;`_launch_claude` `env -i`+`env_args`(`claude-lead.sh:1891-1930`)仅席位追加 |
| T5 | `packages/teamlead/src/StateStore.ts`(**不加表、不加列**) | ① `getAlertThreadByRootMessageId(id)` / `getAlertThreadByEventId(id)` 都不过滤 `resolved_at`;② `stampDutyAck(ck,eventId)` 只 `COALESCE` 写 `acked_at`，不改变 lifecycle，且带 episode 围栏；③ `handoffTicket` 原子写 `acked_at + ESCALATED + owner_ref`，拒绝已 RESOLVED；④ `listDutyOutstanding(limit,since?)` 只取 `acked_at IS NULL AND ticket_status IS NOT NULL`，可按 cursor 的 `(opened_at,event_id)` 下界筛选，`ORDER BY opened_at DESC,event_id DESC LIMIT ?`，含 resolved 标记；⑤ `setTicketStatus` / `resolveAlertThread` 可选 event 围栏，不传时旧行为不变 |
| T6 | `packages/teamlead/src/bridge/AlertChannelHub.ts` | C2:`updateRootTicketStatus` 的正则扩一行,可选替换 `· owner … ·` 段(owner 文案由**路由**按 roster 解析成 `<@botUserId>` 后传入 —— Hub 没有 roster 依赖,不在 Hub 里查);C3 一行文案;公开包装 `renderTicketLine(row, ownerText?)`(3 行);`resolve(ck, expectedEventId?)` **两道围栏**:(a) 方法开头 `getActiveAlertThread(ck)` 读到的行 `event_id !== expectedEventId` → 立即抛 `stale_episode`,**零副作用**(不读根消息、不编辑、不发恢复帖、不归档);(b) 末尾的 `setTicketStatus(ck, "RESOLVED", eventId)` 与 `resolveAlertThread(ck, eventId)` 带谓词(T5 ⑤)—— 0 行时重读该 `event_id`:`resolved_at` 非空 → 视为同 episode 已被 ARC 解决,返回幂等成功;否则抛 `stale_episode`。Discord 侧的编辑 / 恢复帖 / 归档在 (b) 这一段是 best-effort、可能与并发的 ARC resolve 各做一次(既有 Hub 无串行化,不加);不传 `expectedEventId` 时既有路径逐字不变 |
| T7 | `packages/teamlead/src/bridge/alert-duty-router.ts`(新) | 只两条在 `/duty`:`POST transition` 与 `GET outstanding`；GET 的 `limit` default 25 / max 100，`since=<opaque-cursor>` 解码出 `(opened_at,event_id)`，非法值 400；返回 newest-first tickets + newest cursor。handoff 在全舰 roster 一次 lookup，故所有 project 都能转 Tadashi；`resolve` 走既有 `hub.resolve(ck,eventId)`，Hub 缺席 503 |
| T8 | `packages/teamlead/src/config.ts` + `bridge/types.ts` + `bridge/plugin.ts` | config 读 `FLYWHEEL_ALERT_DUTY_TOKEN`(`normalizeOptionalBearer`;与 `apiToken`/ingest/`geminiAgentToken` 相等 → 启动拒绝,`config.ts:99-118` 模式);`types.ts` 的 `BridgeConfig` 加 `alertDutyToken?: string`;plugin:挂 `/duty`;`getAlertHub` holder(`alertHub` 在 `:10210` 才构造);boot 用 dispatcher token `GET /users/@me` 一次(`flag-retirement-production.ts:537` 模式)写进 `dispatcherBotUserIdRef.current`,`/api/alert-duty/seat` 处理器(挂载早于解析,`:2498`)通过该 ref 读,未解析前返回 `null`;横幅一行 |
| T9 | `packages/flywheel-comm/src/commands/alert-ticket.ts` + `index.ts` | `ack \| handoff \| resolve \| outstanding`；outstanding 支持 `--limit 1..100` / `--since <cursor>`；token 只读 `FLYWHEEL_ALERT_DUTY_TOKEN` |
| T10 | `.lead/claude-infra-bot-lead/identity.md` | research §3 改写(用既有 `reply` 发 🧭/✅/↪;§2.4 的规矩) |
| T11 | `doc/architecture/infra-alerts-spec.md` | 守卫段:值守先看;**`acked_at` = 值守处置完成并已留痕**(先发帖后记账);`ESCALATED` = 已转出;所有值守变更带 `event_id` 围栏;token 定性;三条已知缺口(§2.5);只追加 |
| T14(**删除**) | `packages/teamlead/src/bridge/plugin.ts:10133-10150`(`rescueRouteHolder.ackTicket`)+ `rescue-route.ts:42`(可选依赖声明)与 `:104-106`(调用)+ `packages/teamlead/src/__tests__/rescue-route.test.ts` | 删掉 rescue 路由在救援**开始**时 `setTicketStatus(ck, "ACK")` 的写入(FLY-927 Task 2.3;只覆盖 `login_expired` / `runner_login_expired`,生产 `alert_threads` 两个月 0 次 ACK 即它从未触发)。值守席位成为 `acked_at` 的**唯一**写入者;Codex bot 的救援仍照跑,只是不再自己盖 ACK —— 这类工单的认领 = Claw 的 ②(owner map)ack-only(C4)。相关既有测试改为断言「rescue 不写 ACK」 |
| T12 / T13 | `engineering/doc/FLY-2076-claw-duty-seat/`;`engineering/doc/milestones/FLY-2076.md` | 随 PR;最后一个 commit;不碰 `CLAUDE.md` |

**不改**:插件代码、`AutoRepairBot.ts`、`ticket-escalation.ts`、`kind-contract.ts`、`ticket-owner-map.ts`、`infra-event-router.ts`、`LeadAlertNotifier`、projects.json、Cass 角色文件、**`alert_threads` 的表结构**、`createQueryRouter` 既有路由。**唯一的删除**:T14(rescue 路由的 ACK 写入)。**删掉的(相对 v4)**:`alert_duty_receipts` / `alert_duty_posts` / `alert_duty_meta` 三张表、intent 状态机、Bridge 代发与对账、pressure 路由、`seedDutyEpisode` / fold 逻辑。

## 2. 合同

### 2.1 账本动作(全部落既有列)

| 动作 | 写什么 | 状态迁移 | 重放 |
|---|---|---|---|
| `ack` | `acked_at = COALESCE(acked_at, now)` | `NEW → ACK`;`REPAIRING / MONITORING / ESCALATED / RESOLVED` **不动**(C1) | 200 幂等 |
| `handoff --to X` | `acked_at = COALESCE(...)`、`owner_ref = lead:X`、`ticket_status = ESCALATED`(一个事务;谓词含 `resolved_at IS NULL AND ticket_status <> 'RESOLVED'`) | 任意非 RESOLVED → ESCALATED;RESOLVED(含定位后被 ARC 解决的)→ 409 `already_resolved`,不回退 | 同 X 200;不同 X 200(重指派) |
| `resolve` | 走既有 `hub.resolve(ck, eventId)`:入口先比对活跃行 `event_id`(不等 → 409,零副作用);末尾两次写都带 `event_id` | → RESOLVED + `resolved_at` + 归档;Hub 缺席 503;末尾写 0 行 → **重读**该 `event_id` 的行:`resolved_at` 非空 → 200 幂等(ARC 在 Discord await 期间先解决了同一 episode;此时恢复帖 / 归档可能各发生两次,账本只有一次);行不存在 / event 不同 → 409 `stale_episode`,B 的账本与 Discord 都不动 | 已 RESOLVED 200 |

**顺序 = 先发帖、后记账**:🧭 帖发出后才调 `ack` / `handoff`;✅ 帖发出后才调 `resolve`。所以 **`acked_at` 非空 = 这条的处置已完成并留痕**(不是「看过」);重启按 `acked_at IS NULL` 重做,最坏多一帖(G1),**不会**丢处置。

**`acked_at` 只有一个写入者**:T14 删掉 rescue 路由的 ACK 写入后,`acked_at` 非空当且仅当值守完成过处置(否则「Claw 离线时 owner bot 调 `/api/rescue`」会盖上 `acked_at`,让 `outstanding` 静默漏掉一条没留痕的工单)。

**episode 围栏在变更语句上,不是读后比较**:路由先定位行拿到 `event_id`,之后**每一条** UPDATE(ack / handoff / `hub.resolve` 末尾的两次写)都带 `AND event_id=?`;0 行 → 409 `stale_episode`(A 在定位与写之间 —— 包括 Hub 等 Discord 的那段 —— 被同 correlation key 的 B 覆盖时,不动 B)。handoff 另带 `resolved_at IS NULL`:定位后被 ARC 解决的行不会被退回 ESCALATED。定位:`--message-id`(根消息 id 或 thread id,同值)或 `--event-id`,恰一个,**都不过滤 `resolved_at`**;找不到 → 404。`to` 必须在该 project 的 roster;owner=Codex bot 的工单**不 handoff**(见 §2.4)。

### 2.2 `/duty` 与 token

`createAlertDutyRouter()` 只含两条(transition / outstanding),`app.use("/duty", dutyAuth, router)` 恰一次,不复挂 `createQueryRouter`;seat 探针在 `/api/alert-duty/seat`。**`/duty` 不是第四层告警**(Tadashi 的检查项):三条路由只是值守对**既有工单**的手 —— 写 `acked_at` / `owner_ref` / 状态、重渲染 🎫 行、走既有的安静 `hub.resolve()`;它们**不发任何告警、不 @ 任何人、不给 founder 发任何东西**。要 @ 谁,是 Claw 在 thread 里自己发的那一帖(§2.4),不是路由。`dutyAuth`:未配置 503;缺失 / 长度不等 / 不等 → 403(先比长度再 `timingSafeEqual`);对 `/api/*` 无效。config 碰撞启动拒绝。**定性(D3)**:所有 Lead 同一 OS user、`.env` 对每个 Lead 可读、都有 Bash —— 它防误用(挡「拿共享 token 顺手写账」),不防恶意 Lead;不再声称隔离。

### 2.3 CLI

```
alert-ticket ack        (--message-id <id> | --event-id <id>) [--wait 30]    # 含 🎫 的根消息 404 时重试 3×10s;发完 🧭 之后调
alert-ticket handoff    --to <leadId> (locator)                              # 发完 🧭 之后调;自带 acked_at
alert-ticket resolve    (locator)                                            # 发完 ✅ 之后调
alert-ticket outstanding [--json] [--limit 1..100] [--since <cursor>]        # newest-first,含已 RESOLVED(标 resolved)
```

退出码:`0` / `2` 用法 / `3` 400·403·409 / `4` 404 / `5` 503·网络。

**Code review R1 修订 — 上岗 cutover 与跨 project 转交**:

- 不新增 rollout 列。服务端即使调用方不传参数也最多返回 newest-first 25 条(max 100)；
  `since` 使用已有 alert row 的 `event_id` 还原 `(opened_at,event_id)` 下界。满批时 Claw 报压力并
  逐批处置；这限制单次读取/首轮发帖洪峰，不过滤 kind、不判断噪音、不限制最终处置总量。
- `handoff --to` 在所有 project 的全局 roster 中解析目标,不再限定工单自己的
  `project_name`;fleet 的 `machine` sentinel 与非 flywheel 工单都能走 ③ @Tadashi。
- `ack` 只写 `acked_at`,不把 `NEW` 改成 `ACK`;T2 unclaimed 查询同时要求
  `acked_at IS NULL`,避免 founder-direct 工单被值守 ACK 后装上自动 @founder 升级。
- `resolve` 只有 duty 调用传 `eventId` 时启用 episode 围栏;既有 ARC/reconcile 无参调用保持
  原来的写序、无围栏与不抛语义。Claw pane 显式收到 `$FLYWHEEL_DIR`,contact book 路径可解析。
- `resolve` CLI 单独使用 30s deadline(四次串行 Discord I/O),其他动作仍为 5s。

### 2.4 留痕:Claw 用既有 `reply`,规矩写在角色文件

- 顺序:**先发 🧭 帖(`reply chat_id=<thread id>`;thread id == 根消息 id),再记账** —— ① → `ack`;② ③ → `handoff --to`;① 修好后发 ✅ 帖再 `resolve`;失败发 ↪ 帖再 `handoff`。记账成功 = 这条完成。
- 发帖前**先看 thread**(`fetch_messages(channel=<thread>, limit=50)`)有没有自己的 🧭;有 → 不再发,直接记账;`fetch_messages` **失败 → 不发帖**(fail-closed,留给下一次)。
- owner 是 Codex bot 的工单(根消息 🎫 owner = Codex Infra Bot):发 🧭 记「② 归 owner map」、不 @、**不 `handoff`**(它不是 roster Lead,owner 也无需改),只 `ack`。
- 🧭 帖里 @ 只允许**一个**真 `<@id>`(转给谁 @ 谁;① / owner=Codex bot 一个不 @);正文 ≤ 1800 字。
- 已自动 RESOLVED(thread 已归档;`outstanding` 行 `resolved: true`)的工单:只 `ack`,**不发帖**(系统已经解决,再开 thread 只制造噪音)。
- 旁路根消息(无 🎫、无 thread):看,不回、不记(D6)。
- 压力自述:批次接力 / `outstanding` 返回满批 / 数量大于本次能处理 → 在根频道发**一帖** @Tadashi;同一会话只喊一次;**重启后可能再喊一次**(没有跨重启 latch,见 §2.5)。

### 2.5 本单不封的三条缺口(交 founder,HTML 明标;不设计绕过)

| # | 缺口 | 为什么不封 | 谁定 |
|---|---|---|---|
| G1 | **一条工单可能多一帖 🧭(至少一次)**:顺序是先发帖后记账,Claw 在「发了帖、还没记账」时重启会再发一次;插件 `reply` 对结果不明的分片会重试(本身就是 at-least-once);thread 最近 50 条之外的旧 🧭 看不到。**不会丢处置**:没记账的重启后一定重做 | 封它要 Bridge 代发 + durable intent + 对账(v4 的三张表),guard 不允许 | founder:接受「偶尔多一帖」,还是另开单做代发 |
| G2 | **被新 episode 取代的旧 episode 没有自己的去向**:`alert_threads` 是 active-mapping,同 correlation key 的新 event 覆盖旧行(`StateStore.ts:3628-3634`),旧 thread 被 Hub 归档;PRD R2 说每条都要落 ①/②/③ | 封它要按 episode 建回执表,guard 不允许;设计绕过(并入 B)也被 guard 否 | founder:接受「同一问题连发时只有最新一次有去向」,还是改 PRD 口径 / 另开单 |
| G3 | **root-only 工单(thread 创建失败)没有账本行**(`AlertChannelHub.ts:409-420` 直接 return),`ack` 404、`outstanding` 看不到 | 封它要在 Hub 建 thread 前先写行,那是 2075 的文件与 Epic 的账本设计 | Tadashi:归 2075 / Epic |

## 3. 行为协议(角色文件 §3)

```
0. 定位:根消息 message_id(= thread id);含 🎫 但账本行还没落(ack 会 404)→ 等 30s 再试,仍无 → 留给下一次 outstanding
1. 只读核实(allow 列;§3.3 不装懂 allow/deny 不变)
2. 定去向:owner=Codex bot → ②(不 @、不 handoff) | runbook 命中且在授权内 → ① | contact-book 命中 → ② | 否则 ③
   工单已自动 RESOLVED → 跳到 4,只 ack
3. fetch_messages(thread, 50):有我的 🧭 → 跳过发帖;失败 → 停(不发);无 → reply 发 🧭(恰一个 @ 或没有)
4. 记账 = 完成:① / owner=Codex → alert-ticket ack;② ③ → alert-ticket handoff --to …
5. ① 后续:动手 → 验证 → reply ✅ → alert-ticket resolve → 写 runbook 草稿;失败 → reply ↪ → alert-ticket handoff --to …
启动:`alert-ticket outstanding --json --limit 25`(newest-first,含 resolved 标记)→ 满批先报压力，处理后不带 cursor 取下一批；只有响应内每条都落账后，本会话后续查新欠账才可带该响应的 `--since <cursor>`，禁止游标先行。
```

## 4. TDD 顺序

### RED

| # | 测试 | 用例 | 现状 |
|---|---|---|---|
| R1 | `alert-duty-seat.test.ts` | 席位四例;dispatcher 解析成功 / 失败;2075 先合的 rebase 变体 | 红 |
| R2 | `apply-alert-duty-gate.test.sh` | 翻转 + `allowFrom:[]`;幂等;不碰其他字段;备份;dry-run;坏 JSON fail-closed;group 缺席 `skipped`;文件缺席;`--allow-bot` 并入 / 已存在 noop;输出行格式 | 红 |
| R3 | `alert-threads-tickets.test.ts`(追加) | lookup 含 resolved；duty ACK 只写 `acked_at`、T2 不拾取；所有 mutation 的 episode 围栏与 handoff 事务；`listDutyOutstanding` 排除 `ticket_status IS NULL` legacy 行、含 resolved、严格 newest-first、尊重 limit 与 since cursor | 红 |
| R4 | `alert-duty-router.test.ts`(Hub fixture 复用 `alert-ticket-lifecycle.test.ts`) | 鉴权矩阵(shared → 403;duty → 200;duty 打 `/api/*` 401/403;错长度无异常;未配置 503;config 碰撞启动拒绝);五类联测(NEW / REPAIRING / MONITORING / 自动 RESOLVED(ack-only,定位 resolved 行成功)/ owner=codex(ack 成功、handoff 不被调用))按 §2.1 表;handoff 后 fake edit 同时含**路由解析出的** `<@botUserId>` 与状态段;fleet `machine` 工单能转给 flywheel roster 的 Tadashi,全局 roster 不存在则 400;`resolve` 走 `hub.resolve(ck, eventId)`:**B 已活跃 / 路由定位 A 后进 Hub 前 B 覆盖 A** → 409 且 fake Discord **零调用**(无根消息读取、无编辑、无恢复帖、无归档)、B 账本不变;**在 fake Discord 的 await 之后、末尾账本写之前注入「B 覆盖 A」** → 409 `stale_episode` 且 B 账本不动(TOCTOU 第二道围栏;此时 Discord 侧对 A 的编辑已 best-effort 发生,断言不涉及 B 的 thread —— A 与 B 的 thread 不同);**同一窗口注入「ARC 先把 A 解决」(账本层注入)** → 200 幂等、A 仍 RESOLVED、账本只写一次(Discord 侧允许两次 best-effort 归档 / 恢复帖,不断言恰一次);**「Claw 离线时 owner bot 调 `/api/rescue`」→ 行仍 `acked_at IS NULL`、仍在 `outstanding`**(T14 的对照);Hub 缺席:ack / handoff 账本仍写,**resolve → 503**;locator 校验;「离线 → ARC 已 RESOLVED → 启动 outstanding 列出 → ack-only」端到端 | 红 |
| R5 | `alert-ticket-cli.test.ts` | 四子命令;`--wait` 仅对含 🎫 的 404;token 只读 duty env;退出码 | 红 |
| R6 | `fly2076-identity-sentinel.test.sh` | 必含:「值守席位」「每条工单根消息都归你先看」「三个去向」「宁转勿吞」「永不自行 @Annie」「兜底 @Tadashi」「先发帖再记账」「记账 = 完成」「落账:待执行」「发帖前看 thread」「fetch_messages 失败不发帖」「一个 @」「handoff --to <leadId>」「owner 是 Codex bot 不 handoff」「已自动 RESOLVED 只 ack 不发帖」「旁路通报不回帖」「压力自述」「根因线」「alert-ticket outstanding」;必不含:「只响应 … 显式 @你」「没被 @ 的工单你不动手」「修不掉才 @Annie」「先 ack 再发帖」「账本:<回执」「--to <@」;②/③ 角色 fixture:🧭 头一行恰一个 `<@id>`,末行 `--to <leadId>` | 红 |
| R7 | `lead-duty-provision.test.sh` + launch plan | 席位 → apply 一次且带 `--allow-bot`;非席位 → 不调且 unset;CLI 缺失 → `gate=skipped:cli_missing` 且 stderr 有内容;Bridge 不可达 → `dispatcher=unresolved:bridge_unreachable` 且门控照翻;**席位但 `FLYWHEEL_ALERT_DUTY_TOKEN` 未设 → `gate=skipped:no_duty_token token=unset`,access.json 不变**;launch plan 席位含 token、非席位不含 | 红 |
| R8 | `alert-hub-duty-render.test.ts` | owner 段正则只改 🎫 行;legacy root 跳过;C3 文案不含「Cass」 | 红 |
| R9 | 既有 rescue 测试(`grep -rl ackTicket packages/teamlead/src --include=*.test.ts`)改断言 | rescue 路由跑完,`alert_threads` 该行 `acked_at` 仍 NULL、`ticket_status` 不变;`ackTicket` 符号在 `plugin.ts` / `rescue-route.ts` 中零引用(反向哨兵) | 现在断言写 ACK → 红 |

阳性对照:R3 故障注入前先证明字段会变;R4 先证明「不经路由 → 账本无变化」。

### GREEN

T1 → T2 → T5 → T6 → T8(config)→ T7 → T8(wiring / banner)→ T9 → T3 → T4 → T10 → T11。不顺手重构。

## 5. 全仓自验

`pnpm lint` → `pnpm -r build` → `pnpm test:packages:run` → 三个 shell 测试 → `check-flag-truth.test.sh`(`FLYWHEEL_ALERT_DUTY_TOKEN` 登记 `NON_FLAG_ALLOWLIST`)。

## 6. Codex code review

`codex:rescue` 循环到 APPROVED。重点:outstanding 的服务端 bound + since cursor + newest-first 且零 schema；全舰 Tadashi fallback；ACK 永不喂自动 founder；`handoffTicket` 事务；`/duty` 不复挂 query router；token 碰撞；角色哨兵；2075 rebase 分支。

## 7. 部署与验收

**部署合同(C5)**:本单合入 → 班车部署 Bridge + Claw 重启 → **两条证据齐了才让 2075 切频道单腿**:(a) 入站活:第一条真实 dispatcher 根消息(旁路通报每天都有)在 `comm.db` 出现 `discord_chat` 行且 ACKED;(b) **写路径活**:Claw 启动行 `token=set` **且** 用 Claw 的 duty token 打 `GET /duty/alert-tickets/outstanding` 得 200(实现节点 / QA 采)。缺任一条不切。另:provisioning 在 `FLYWHEEL_ALERT_DUTY_TOKEN` 未设时**不翻门控**(`gate=skipped:no_duty_token`)—— 听得见却写不了账的席位不该上岗。

**(a)**:T10 合入;`[alert-duty]` 行 `gate=changed|noop`;`jq` 核 `requireMention=false` 且 `allowBots` 含 dispatcher;Bridge 横幅。

**(b) 一条真实工单完成 ①/②/③ 并留痕**(2075 切换后第一条;不注入;6h 无事件 `INCONCLUSIVE`):

| 步 | 证据 |
|---|---|
| 1 | `comm.db` 该根消息 `discord_chat` 行 ACKED |
| 2 | thread 里 🧭 帖(作者 = Claw),字段齐,恰一个 `<@id>` 或没有 |
| 3 | `alert_threads` 该行 `acked_at` 非空(= 处置完成);状态按 §2.1;handoff 时 `owner_ref = lead:<to>` 且 🎫 行 owner 段一致(截图) |
| 4 | ① 时:✅ 帖 + `resolved_at` + `oncall-drafts/<kind>.md` 新段;②③ 时:真 `<@id>`(必达标「待 2078」);owner=Codex bot 工单帖内无 @ |
| 5 | 24h:根频道 Claw 帖 = 0(除压力自述);同一工单 🧭 = 1(G1 的例外要逐条解释);旁路通报无回帖 |
| 6 | 重启 Claw 一次:`outstanding --limit 25` newest-first 逐批补齐(含离线期间被 ARC 自动 RESOLVED 的；不含 legacy 无状态行)；满批压力自述；已记账工单不重做 |

## 8. 回滚

角色文件 revert + 重启;门控用 FLY-898 脚本反向翻回(热生效);`/duty` 路由 revert 即无;`.env` token 留着无害；没有 schema / 数据回滚。

## 9. 边界

| 不做 | 去处 |
|---|---|
| 被 @ 必达、接手进展、未解决清单、Cass 文件 | FLY-2078 |
| 册子格式 / 落位 / 收割 PR | FLY-2077 |
| 频道单腿、删自动 @founder、root-only 工单入账(G3) | FLY-2075 / Epic |
| 指标 / 阈值 / 噪音判定 / severity 优先 | 第 2 层 |
| G1 多一帖、G2 被取代 episode、跨重启压力 latch | founder 定(§2.5) |
| 旁路根消息入账(D6)、真隔离凭据、Claw git 写权 | Epic / 另开单 |

## 10. 风险

| 风险 | 概率 | 处置 |
|---|---|---|
| 回环(FLY-220) | 中 | 角色文件:先看 thread、发一帖再记账、一工单一帖、根频道不回;§7 24h 硬项 |
| G1 多一帖 | 低 | 明标;founder 定 |
| 2075 先合并 | 高 | rebase 分支(T1 / C3) |
| 前期 runbook 空 → 几乎全走 ②/③ | 确定 | PRD §6.3;压力自述 |
| duty token 被同 UID 读走 | 已知 | §2.2 定性;D3 接受 |

## 11. 文档与里程碑

`engineering/doc/FLY-2076-claw-duty-seat/` 随 PR;PR 最后一个 commit 新建 `engineering/doc/milestones/FLY-2076.md`,不碰 `CLAUDE.md`。

## 12. 2026-08-27 founder 返工补充（Lead 方案 13:29 PT 获准）

本节只补充已经完成设计后的返工范围，不重开探索/调研/设计决策。

### 12.1 总开关

- 新增 store-managed `alert_system`（legacy env 名 `FLYWHEEL_ALERT_SYSTEM`），默认开、
  `bridge_global`、`call_time`、`toggleable:direct`。权威值进入既有 `flag_values`，
  用 `storeAlertSystemEnabled(flagStore)` 每次调用读取；管理面继续复用既有
  `feature-flags stage/apply`，不增加 writer。
- 门位于既有主管道的 intake ledger 之后、所有 Discord / issue thread / Hub ticket /
  Claw mailbox 与旧 queue drain side effect 之前。OFF 时把完整 payload 写入既有
  `lead_events`，返回 `skipped=disabled`；不创建第二张告警表、不增加新告警层。
- `LeadAlertNotifier` 的直连入口与 queue drainer 共用同一 call-time reader；
  `buildInfraAlertRouting` 覆盖会绕过 notifier 的 Claw mailbox / issue-thread 分支。
  因此关掉的是整个告警投递系统，不是 Claw；Claw 的角色、进程与值守职责仍存在。
- 本单不做 flag CI 拦截与存量 flag 迁移（founder 已另立范围）。

### 12.2 TDD 与 QA 硬门

RED→GREEN seams：

1. `flag-store-runtime`:默认 ON，SQLite 写 `0` 后同一 runtime 下一次读立即 OFF；
2. `buildInfraAlertRouting`:OFF 时 raw sink / ticket sink / Discord fetch 全为 0，
   `lead_events` 仍有完整 alert；
3. `LeadAlertNotifier`:直连 OFF 零 POST/queue/deadletter，旧 queue OFF 不消费；
4. registry/drift/management 守卫:registry → managed set + codec → seed → named wrapper →
   production import/call → route round-trip 全链闭合。

QA 不再把开与关拆成两段。一个 harness、一个 file-backed StateStore、一个进程连续跑：

`ON 真告警 → 真 Discord root/thread → ticket → Claw CLI ② handoff → DB 写 OFF →
下一条告警只落 lead_events（零 Discord / ticket / Claw mailbox）→ DB 写回 ON →
下一条立即重新进入真 Discord/thread（无重启）`。
