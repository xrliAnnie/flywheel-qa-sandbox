# FLY-927 告警频道 → bot 工单队列 + 路由 + @-target 门禁 — 实施计划

Issue: FLY-927 (https://linear.app/geoforge3d/issue/FLY-927/infra-alerts-告警频道-bot-工单队列-路由-target-门禁-fly-915)
日期: 2026-07-07
基于: research.md(同文件夹;上游 exploration.md;brainstorm gate 已过)

> **For agentic workers:** 本 plan 供三段式 Implement 阶段照建(TDD:每任务先 RED 后 GREEN,频繁 commit)。任务用 checkbox 跟踪。

**Goal:** 把 #flywheel-alerts 从「谁都往里刷」改成 bot 工单队列:发射侧三分路由 + 每工单唯一 owner @-target + 发送方门禁 + 20/min 攒批 + 工单 schema/生命周期 + 「告警≠通知」spec 固化 + Watchdog v2(按真实 stage 报、球在谁、1h、owner 首响应)。

**Architecture:** 全部改造压在现有单漏斗(`LeadAlertNotifier` → `AlertChannelHub`)和既有巡检 tick 上,不新增组件进程、不加新 timer;每块行为挂 env,未设 = 现状逐字节。

**Tech Stack:** TypeScript(packages/teamlead)、bash(scripts/)、sql.js StateStore 幂等迁移、vitest + shell 测试。

---

## 0. 已锁决定(brainstorm gate,Tadashi 2026-07-07 拍;均标「Lead 裁定、待 Annie 确认」)

| # | 裁定 | 内容 |
|---|---|---|
| D1 | 路由按「响应者」划 | infra 进程健康类(白名单 kind)一律进队列 @ owner bot,即使绑 issue;issue 进展类进 [FLY-XX] thread;队列工单修不掉升级时 founder page 落 issue thread(复用 FLY-818)。调和 PRD §3.1 与 §4.1 的字面冲突 |
| D2 | 单一发送身份取代 own-bot 链 | 7-06 PRD lgtm 晚于 6-22 own-bot 拍板,新者胜;归属信息由 schema 头承载;env 未设 = 现状链(零回归) |
| D3 | 对齐 FLY-954 | lead-alert.sh = Bridge-independent 告警通道的正身,门禁/schema/统一频道必须一等公民支持它(不是待废弃旁路) |
| D4 | bridge-wrapper 死机 🚨 收进门禁 scope | `bp_fail_loud` 的 Discord 腿改道 lead-alert.sh,保留直 curl 作 fallback(FLY-929 时拍的「统一治时带 fallback 再换」) |

PRD 已锁常量:**T1 = 20 条/分钟**;**T2 = 重试 2 次 或 5 分钟超时**;时效 **1h**(Watchdog v2,可配)。

---

## 1. 三个 PR 的切分与顺序

| PR | 内容 | 依赖 |
|---|---|---|
| **PR-1 频道架构核心(W1+W2)** | Router 分类 + 工单 schema 头 + echo-immunity 同步 + 单一发送身份 + 20/min 令牌桶攒批 + lead-alert.sh 对齐 + bridge-wrapper 改道 + /send 拒发 + `doc/architecture/infra-alerts-spec.md` | 无 |
| **PR-2 工单生命周期 + @-target** | `alert_threads` 扩列 + kind→owner 映射 + root @-target + edit-in-place 状态 + T2 判定 + 无人认领兜底 + 升级落 issue thread | PR-1(schema/Router) |
| **PR-3 Watchdog v2 + W-B** | checkpoint-park 元组派生 + 1h 巡检 + `three_stage_stuck` 措辞收口 + `runner_throttle_stalled` kind + idle≠冻结验收 fixture | PR-1(Router) |

每个 PR 独立可 ship、独立 reverse-compat sentinel、独立 Codex code review;三个 PR 攒一次 Bridge 重启部署(memory 纪律)。

---

## 2. PR-1 频道架构核心

### Task 1.1 Router 纯函数 + 分类表

**Files:**
- Create: `packages/teamlead/src/bridge/infra-event-router.ts`
- Test: `packages/teamlead/src/bridge/__tests__/infra-event-router.test.ts`

分类是**纯函数**,输入 payload + 绑定信息,输出路由决定:

```ts
export type AlertRouteClass = "ticket" | "issue_thread" | "notify";

/** D1:按响应者分类。infra 进程健康 = bot 修得了 → 队列工单;
 *  issue 进展 = 要 Lead/founder 在上下文处置 → issue thread;
 *  notify = 非紧急 digest(v1 仅分类占位,发送迁移 = FLY-929)。 */
export const TICKET_KINDS: ReadonlySet<AlertEventType> = new Set([
  "rate_limit", "usage_limit", "login_expired", "permission_blocked",
  "crash_loop", "pane_hash_stuck", "runner_stuck_unhandled",
  "runner_login_expired", "runner_throttle_stalled", // PR-3 加入 union
  "tui_window_lost", "restart_guard_bypass", "bridge_boot_stale_checkout",
  "auto_qa_stuck", "codex_gate_blocked",
  "bridge_wrapper_fail", // Task 1.7/1.8 新增(shell allowlist + TS union 同步)
]);
export const ISSUE_PROGRESS_KINDS: ReadonlySet<AlertEventType> = new Set([
  "three_stage_stuck", "founder_milestone_undelivered",
  "runner_lead_pending_unhandled", // 三者绑得到 thread 时进 thread;绑不到 fail-safe 进队列
]);

export interface RouteInput {
  eventType: AlertEventType;
  boundIssueThread: { threadId: string; channelId: string } | null; // 调用方查好传入
}
export function classifyInfraEvent(i: RouteInput): AlertRouteClass {
  if (TICKET_KINDS.has(i.eventType)) return "ticket";
  if (ISSUE_PROGRESS_KINDS.has(i.eventType) && i.boundIssueThread) return "issue_thread";
  return "ticket"; // fail-safe:进展类绑不到 thread 时降级进队列(绝不静默丢)
}
```

**接线(Codex R1 #1:必须收全旁路,否则「单漏斗」不成立)**:新增 late-bound **`InfraAlertSink`** holder(plugin.ts 构造一次,所有发射源引用它,`FLYWHEEL_ALERT_ROUTING=1` 时内部走 Router,未设时透传 raw notifier)。**逐个改接的现存旁路发射点(全枚举)**:`three_stage_stuck`(plugin.ts:4470)、`bridge_boot_stale_checkout`(plugin.ts:4818)、`AutoQaEffects` 构造注入的 raw notifier(plugin.ts:4047 → auto-qa-effects.ts:384/458 的 `auto_qa_stuck`/`codex_gate_blocked`)、runner scans(runner-auth-scan/runner-quota-scan 经 alertSink 已收)、lead-pending 页 Annie 路径。集成测试:遍历 `AlertEventType` 全 union,断言 env=1 时每个发射源都过 Router、env 未设时 raw 行为逐字不变。

> **对 PRD 的一处明示偏差(D1 裁定背书)**:PRD CH-1 白名单把 `three_stage_stuck` / founder 通知投递失败列为队列工单;按 gate 裁定 D1(响应者划分),它们**绑得到 issue thread 时进 thread @ 责任方**(这正是 FLY-912 想要的落点与措辞),绑不到时 fail-safe 进队列 —— PRD 那两行覆盖的就是 fail-safe 情形。此偏差列进 Annie 早报确认项(§5)。

- [ ] RED:分类矩阵测试(每 kind × 绑定有无 × env 开关)先挂
- [ ] GREEN:实现 + plugin.ts 接线
- [ ] sentinel:`FLYWHEEL_ALERT_ROUTING` 未设 → alertSink 行为逐字现状
- [ ] Commit

### Task 1.2 工单 schema 头(append-only)+ echo-immunity 同步

**Files:**
- Modify: `packages/teamlead/src/LeadAlertNotifier.ts:943-951`(`formatContent`)
- Modify: `packages/teamlead/src/LeadWatchdog.ts:749`(`ALERT_ECHO_START`)+ `:780`(`ownStateRegion` 行过滤)
- Test: 两侧现有测试文件扩展 + 新 fixture

模板 = **在现有首行后追加一行工单头,不改首行**(保住 `ALERT_ECHO_START` 对 `(<leadId> / <kind>)` 的既有锚,append-only 最小回归半径):

```
${sev} **${title}** (${leadId} / ${eventType})
🎫 ${projectName} · 首见 ${firstSeenHHMM} · owner ${ownerMention ?? "—"} · 状态 ${ticketStatus}
${body}
```

- 仅统一频道模式 + `FLYWHEEL_ALERT_TICKETS=1` 渲染 🎫 行;legacy 路径字节不动(旧测 `result === { sent: true }` 哨兵保留)。
- **echo-immunity 全 kind 覆盖(Codex R1 #2)**:现 `ALERT_ECHO_START` 只枚举 7 个旧 kind —— `runner_login_expired`/`three_stage_stuck`/`codex_gate_blocked`/`bridge_boot_stale_checkout`/新增 kind 的首行回声今天就漏。改法:kind 交替组从**共享 kind 表派生**(从 `AlertEventType` union 生成或共享常量数组,LeadAlertNotifier 与 LeadWatchdog 同源,单测断言两者一致),即匹配泛化 `(<leadId> / <任一 kind>)` 形态;并增 `|^\s*🎫\s` 分支剥工单头行。
- fixture:**每个现存+新增 kind** 的首行回声 + 🎫 行 + 多行 body 回声 → must-suppress;真冻结证据与回声同屏 → must-alert(防遮蔽,FLY-218 判例)。
- `firstSeen` 取 claims/episode 首次时间(PR-2 落库前先用 payload 时刻,PR-2 切到 `alert_threads.first_seen_at`)。
- **owner/工单上下文在第一次 POST 原子生成(Codex R1 #4)**:root 消息由 notifier 发出、Hub 拿到 messageId 已在其后,不能事后补 @。故 `alert()` 增可选 `ticket?: { ownerUserId: string | null; ownerLabel: string; status: string; firstSeenMs: number }` 入参(本 Task 落 API 缝,值由 PR-2 的 owner map 填;PR-1 内传 `undefined` = 渲染 `owner —`);`formatContent` 接收该上下文渲染 🎫 行;`postMessage` 的 `allowed_mentions` 按 `ticket.ownerUserId` 切 `{ users: [id] }` / `{ parse: [] }`,id 过 snowflake 形态校验(复用 `AlertChannelHub.founderId`/`infraBotId` 判例)。测试同时断言 content 的 `<@id>` 与 HTTP body 的 `allowed_mentions.users`。

- [ ] RED:formatContent 新旧两态断言 + echo fixture 先挂
- [ ] GREEN:模板 + 正则 + 行过滤
- [ ] Commit

### Task 1.3 单一发送身份(D2)

**Files:**
- Modify: `packages/teamlead/src/LeadAlertNotifier.ts`(`postAlertWithSendChain` :521-562)
- Modify: `packages/teamlead/src/bridge/plugin.ts`(env 读取/接线)
- Test: `LeadAlertNotifier` 测试扩展

新 env `FLYWHEEL_ALERT_SENDER_TOKEN_ENV`(存**env 名**,与 `FLYWHEEL_ALERT_REPAIR_BOT_TOKEN_ENV` 同风格):
- 设了 → 发送链坍缩为 `[senderTokenEnv]` 单元素(root 与 Hub thread 操作同身份;`createDiscordOps` 的 repair 链同样坍缩);解析不到 token → 现状 fail 路径(dead-letter + meta-alert),**不**静默回退 own-bot 链(门禁语义:宁可 dead-letter 也不越权发)。
- 未设 → own-bot→Cass→字母序链逐字保留。
- severe-DM 沿用「与 root 同 token」既有合同(v1.56 判例),自动继承单一身份。
- 过渡运营:T3 命名/FLY-928 落地前生产先配 `CASS_BOT_TOKEN`;之后改指 Claude Infra Bot token env,纯配置翻转。

- [ ] RED:设/未设两态 + 解析失败 fail-closed 测试
- [ ] GREEN + sentinel(未设=旧链全测绿)
- [ ] Commit

### Task 1.4 20/min 令牌桶 + 溢出攒批(T1)

**Files:**
- Create: `packages/teamlead/src/bridge/alert-rate-limiter.ts`(纯逻辑,注入 now)
- Modify: `packages/teamlead/src/LeadAlertNotifier.ts`(`alert()` POST 前 + `drainQueue()` 共用)
- Test: `alert-rate-limiter.test.ts` + notifier 集成

```ts
export interface AlertRateLimiter {
  /** 允许发 → 消费一个令牌;拒 → 调用方入 queue */
  tryAcquire(nowMs: number): boolean;
  /** 每分钟窗口翻转时返回被攒的条数汇总(kind 计数),供发一条聚合摘要 */
  drainOverflowSummary(nowMs: number): Map<string, number> | null;
}
export function createAlertRateLimiter(perMinute: number): AlertRateLimiter;
```

- env `FLYWHEEL_ALERT_RATE_PER_MIN`(未设 = 不限流 = 现状;生产配 20)。
- 计数对象 = **发进统一告警频道的 root 消息**(工单上限语义);Hub thread 内叙事、issue-thread 路由、meta-alert 不占额度。
- **确定性算法(Codex R1 #9,消灭 summary/queue 不确定行为)**:
  - `alert()` 超限 → 该条**只 enqueue 一次**(现有 `enqueue()`,零新格式)+ limiter 内部 `overflowCount[kind]++`,**不发**任何消息。
  - `drainQueue()`(既有 plugin 60s timer 驱动,plugin.ts:5493,不加新 timer)每轮开头:若 `overflowCount` 非空且 `tryAcquire` 成功 → 先发一条聚合摘要 `⚠️ 速率攒批:N 条告警已入队(kind×m …)` 并清计数(摘要占 1 令牌;摘要被限流 → 保留计数下轮再试,**绝不递归攒摘要的摘要**);随后逐条出队,每条过 `tryAcquire`,失败 → **本轮 drain 立即停**,队列文件原样保留(不重写、不重复 enqueue)。
  - 测试:持续超限场景断言不丢、不重、摘要每窗口至多一条;摘要文案含 🎫 不含 `(leadId / kind)` 锚(不会被误当告警回声,补 fixture)。
- 令牌桶状态进程内存即可(重启清零可接受 —— queue 是持久层,不丢告警只可能多发)。

- [ ] RED:桶语义(20 内直发/21 起入队/窗口翻转摘要一条/drain 同桶)先挂
- [ ] GREEN + sentinel(env 未设 = 无桶逐字现状)
- [ ] Commit

### Task 1.5 issue-thread 投递腿(Router 的 issue_thread 类)

**Files:**
- Modify: `packages/teamlead/src/bridge/founder-thread-notifier.ts`(新通用入口)
- Modify: `packages/teamlead/src/bridge/plugin.ts`(Router 接线)
- Test: founder-thread-notifier 测试扩展

新导出 `emitIssueThreadInfraNotification({ store, session, lead, kind, content, mentionUserId?, onUndeliverable })`:与既有三入口同骨架(POST thread、`allowed_mentions.users` 白名单、`session_events` 审计 `issue_thread_infra_notified`、transient 重试预算)。**失败升级缝(Codex R1 #8)**:`escalateFounderThreadUndelivered` 是 GatePoller 的 private 方法(gate-poller.ts:1589),不可直接复用 —— 通过注入的 `onUndeliverable(payload)` 回调收口(plugin.ts 把它接到告警队列 sink,即预算烧完/永久失败 → 一条队列工单,**永不静默**;该工单 kind 用现存 `founder_milestone_undelivered` 语义或等价,绝不递归回本腿)。测试三路径:transient 重试耗尽 / 永久失败 / 无 thread 绑定(Router fail-safe 已回队列,本腿不该被调到,防御断言)。`three_stage_stuck`/`founder_milestone_undelivered` 经 Router 改投此腿。

- [ ] RED:投递/审计/降级三态测试
- [ ] GREEN + Commit

### Task 1.6 Bridge /send 拒发告警频道(门禁代码腿)

**Files:**
- Modify: `packages/teamlead/src/bridge/tools.ts`(`/send`、`/chat-threads/create` 入口)
- Test: tools 路由测试扩展

实际入口为 `/api/chat-threads/send` 与 `/api/chat-threads/create`(tools.ts 注册名以代码为准):目标 channel/thread == `FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID` → `403 { error: "alert_channel_gated", hint: "告警走 LeadAlertNotifier/lead-alert.sh 管道" }`。挂 `FLYWHEEL_ALERT_ROUTING=1`(同 Router 开关,不另设 flag);未设 = 现状不拒。

- [ ] RED:拒/放行/env 未设三态
- [ ] GREEN + Commit

### Task 1.7 lead-alert.sh 对齐(D3)

**Files:**
- Modify: `scripts/lead-alert.sh`
- Test: `scripts/__tests__/lead-alert-*.test.sh` 扩展

1. 频道解析:`FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID` 设了 → 优先用它(projects.json 路径保留为未设时现状)。
2. 发送身份:`FLYWHEEL_ALERT_SENDER_TOKEN_ENV` 设了 → 用其指向的 env(bash 3.2 兼容 eval 形态,照 FLY-694 判例);未设 → 现状 per-lead token。**token 不进 argv(Codex R1 #7)**:curl 改用 stdin config(`curl -K -` 喂 `header = "Authorization: Bot …"`,照 FLY-510 notion.sh 判例);fake-curl 测试断言进程参数里无 token。
3. **mention 白名单(Codex R1 #7)**:shell POST 的 JSON 一律带 `allowed_mentions: {"parse": []}`(现状没带 = content 里出现 mention 会被 Discord 默认解析);shell 侧永不发 owner ping(owner @ 是 Bridge 的事)。断言 JSON body。
4. 速率近似:`${QUEUE_DIR}/.rate-YYYYmmddHHMM` 计数文件,`FLYWHEEL_ALERT_RATE_PER_MIN` 设了且当前分钟计数 ≥ 上限 → 跳过直发、直接 `write_record` 入 queue(Bridge 代发;去重已由 claims.db 保证)。
5. **system/global alert 一等输入(Codex R1 #3)**:`lead-alert.sh` 现强制 `--lead`/`--project`(:84)。系统级告警(非某个 Lead 的事)约定恒等身份:`--project flywheel --lead bridge`(wrapper 等调用方显式传,脚本不改必填约束 —— 保持 eventId 合同简单);allowlist(:90/:97)加 `bridge_wrapper_fail`。
6. schema 头:统一频道模式下 `CONTENT` 第二行加同款 🎫 行(project 已有变量;owner/状态 shell 侧固定 `owner — · 状态 NEW`,Bridge drain 不重写 —— 简单一致优先)。
7. eventId 构造**一字节不动**(claims 合同)。

- [ ] RED:shell 测试四态(env 设/未设 × 限流内/外)先挂
- [ ] GREEN + sentinel(全 env 未设 = 现状逐字)
- [ ] Commit

### Task 1.8 bridge-wrapper 死机 🚨 改道(D4)

**Files:**
- Modify: `scripts/flywheel-bridge-wrapper.sh:80-95`(`bp_fail_loud`)
- Test: `scripts/__tests__/` 对应 shell 测试

`bp_fail_loud` Discord 腿:改为先尝试完整合法调用(Codex R1 #3 —— 现 lead-alert.sh 强制 `--lead`/`--project`,漏了会在参数校验就死):

```bash
"${FLYWHEEL_DIR}/scripts/lead-alert.sh" \
  --project flywheel --lead bridge \
  --kind bridge_wrapper_fail --severity severe \
  --title "$title" --body "$body"
```

前置:Task 1.7 已把 `bridge_wrapper_fail` 加进 shell allowlist;同时 TS `AlertEventType` union(LeadAlertNotifier.ts:52)加 `bridge_wrapper_fail`(Bridge drain 该 queue record 时 kind 合法)。调用非零/脚本缺失 → **保留现有直 curl core-channel 作 fallback**(Bridge 死时绝不能丢投递);meta-alert.sh 桌面/文件腿不动。测试三态:lead-alert 成功 / lead-alert 失败走 fallback curl / 脚本缺失走 fallback curl。`restart-services.sh`/`update-flywheel.sh` 的 notify_discord **不碰**(FLY-929)。

- [ ] RED:lead-alert 可用/不可用两态
- [ ] GREEN + Commit

### Task 1.9 spec 文档(W2)

**Files:**
- Create: `doc/architecture/infra-alerts-spec.md`

内容(全部从 PRD §10.0 落成 eng 合同,非重述):三频道合同表(CH-1/2/3:进什么/谁发/会不会 @Annie)、四条铁律(告警≠通知;默认不 @Annie 修不掉才 @;一工单一 owner;谁都不救自己)、工单白名单 + owner 表(§3 的映射为准)、消息 schema 逐字段、生命周期状态机图(mermaid)、T1/T2 常量、发送方门禁三层(Discord 权限 ops / Bridge 代码 / shell)、与 FLY-523/818 revert 判例的链接。头部标注:source of truth = 本 spec,PRD §10.0 为产品出处。

- [ ] 写 + 自查(无 TBD/占位)+ Commit

---

## 3. PR-2 工单生命周期 + @-target

### Task 2.1 kind→owner 映射(纯函数 + 注册表)

**Files:**
- Create: `packages/teamlead/src/bridge/ticket-owner-map.ts`
- Test: `ticket-owner-map.test.ts`

```ts
export type TicketOwner =
  | { kind: "infra_bot"; side: "claude" | "codex"; userId: string | null } // userId=env 未配→null
  | { kind: "lead"; leadId: string }        // 动态责任 Lead(watchdog v2 类)
  | { kind: "none" };                        // 已升级类/无 owner
export interface OwnerRegistry { claudeBotUserId: string | null; codexBotUserId: string | null; }
export function resolveTicketOwner(
  eventType: AlertEventType,
  provider: "claude" | "codex" | "unknown",  // Lead=ProjectConfig backend;Runner=sessions.adapter_type;取不到=unknown
  reg: OwnerRegistry,
): TicketOwner;
```

映射表(PRD CH-1 白名单逐行):

| kind | provider | owner |
|---|---|---|
| `usage_limit` / `login_expired` / `rate_limit` / `runner_login_expired` | claude | **codex bot**(交叉) |
| 同上 | codex | **claude bot**(交叉) |
| 同上 | unknown | claude bot(主力默认) |
| `pane_hash_stuck` / `crash_loop` / `runner_stuck_unhandled` / `runner_throttle_stalled` / `tui_window_lost` / `auto_qa_stuck` / `codex_gate_blocked` / `restart_guard_bypass` / `bridge_boot_stale_checkout` / `bridge_wrapper_fail` | 任意 | **claude bot**(provider 无关默认) |
| `permission_blocked` | 任意 | **none**(权限=人的事,PRD §4.3 判例,直接 needs_human) |
| `runner_lead_pending_unhandled` | — | **none + 状态直落 ESCALATED**(它是 FLY-637-ext 梯子催完 K 轮的产物,owner-首响应已发生过;再 @ Lead = 与已批阈值冲突) |
| watchdog v2 checkpoint 类(PR-3) | — | `{kind:"lead", leadId}` 动态(Linear 评论追加的第三类;经 issue-thread 腿投,不进队列) |

env:`FLYWHEEL_INFRA_BOT_USER_ID`(已有 = Codex bot,沿用)+ 新 `FLYWHEEL_CLAUDE_INFRA_BOT_USER_ID`(T3 占位,FLY-928 建好后填)。**owner.userId=null → 不 @、不启 T2 无人认领兜底,走现状 Cass 行为**(FLY-928 前零回归)。

- [ ] RED:映射矩阵(kind×provider×注册表配没配)先挂
- [ ] GREEN + Commit

### Task 2.2 `alert_threads` 扩列 + 生命周期状态

**Files:**
- Modify: `packages/teamlead/src/StateStore.ts`(:1380-1397 schema + :4318-4404 访问器)
- Test: `alert-threads.test.ts` 扩展

幂等 `ALTER TABLE alert_threads ADD COLUMN`(照 FLY-267 `reply_channel_id` 迁移判例):
`ticket_status TEXT`(NEW/ACK/REPAIRING/RESOLVED/ESCALATED;NULL=旧行=legacy 语义)、`owner_ref TEXT`(如 `infra_bot:codex` / `lead:<id>`)、`attempt_count INTEGER DEFAULT 0`、`first_seen_at TEXT`、`acked_at TEXT`。新方法:`setTicketStatus(correlationKey, status)`、`bumpAttempt(correlationKey)`、`getUnackedTicketsOlderThan(ms)`。现有 stale→resolve→新 episode 语义(correlation_key PK + event_id)不动,全部旧测必须原样绿。

- [ ] RED:迁移幂等 + 新方法 + 旧语义回归先挂
- [ ] GREEN + Commit

### Task 2.3 root @-target + 状态 edit-in-place

**Files:**
- Modify: `packages/teamlead/src/bridge/AlertChannelHub.ts`(root 后处理 + DiscordOps)
- Modify: `packages/teamlead/src/LeadAlertNotifier.ts`(root POST 返回 messageId 已有;allowed_mentions 按 owner)
- Test: Hub 测试扩展

- root 消息 @(接 Task 1.2 的 API 缝,Codex R1 #4):plugin 接线层在调 `alert()` **之前**用 owner map 算好 `ticket` 上下文传入 —— `FLYWHEEL_ALERT_TICKETS=1` 且 owner.userId 非 null(snowflake 校验过)→ 🎫 行 owner 段渲染 `<@userId>` + POST `allowed_mentions: { users: [userId] }`(第一次 POST 原子生成,泛化 :302-327 的 account_switch 先例);否则 `parse: []` 现状。Hub 不做 root 后补 @。
- DiscordOps 增 `editMessage(channelId, messageId, content)`(包 `discord-utils.ts:192` `editDiscordMessageInChannel`);状态变迁(NEW→ACK→REPAIRING→RESOLVED/ESCALATED)= 重渲染 🎫 行 edit root;edit 404/失败 → best-effort 降级(thread 叙事已是真相流,现状)。
- **ACK correlation 缝(Codex R1 #5)**:action 路由的输入(account-switch-route.ts:101 = sourceAlertId/pending-switch;rescue-route.ts:63 = route/project/lead/execution)都不含 correlation key,不能瞎猜。两侧补:① root 工单 @-owner 的 assignment 文案里带**工单 ref = event_id 短形**(bot 回调时可回传);② StateStore 新查询 `getActiveAlertThreadByEventId(eventId)` + 按 `(lead_id, event_type)` 的 active 行精确查;③ account-switch 路由用其已有 `sourceAlertId`→event_id 映射、rescue 路由用 `(leadId|executionId, kind)` 查 active 行,查到才 `setTicketStatus(ACK)`,查不到 = no-op(绝不 ACK 错 episode)。测试:stale episode 不被 ACK;同 lead 多 active kind 不串;owner 未配置不触发无人认领升级。
- resolve/升级:reconcile `resolve()` → RESOLVED;needs_human/T2 → ESCALATED。

- [ ] RED:@ 渲染/寂静两态、每状态 edit 一次、edit 失败降级
- [ ] GREEN + Commit

### Task 2.4 T2 判定 + 无人认领兜底 + 升级落 issue thread

**Files:**
- Modify: `packages/teamlead/src/bridge/AlertChannelHub.ts`(reconcile pass 内,piggyback 现有 `onPollComplete`)
- Modify: `packages/teamlead/src/bridge/stuck-escalation.ts`(founder page 时机,见下)
- Test: Hub reconcile 测试扩展

reconcile 每 tick 对 active 工单判定(T2 全部纯函数化 `decideTicketEscalation(row, nowMs, policy)`):
- **Cass-ARC 类**:attempt 已发但未恢复 且 `attempt_count < 2` 且距 `first_seen_at < 5min` → 允许第二次 attempt(仍走全部安全闸);`attempt_count ≥ 2` 或超 5min 未 RESOLVED → 升级。
- **owner-bot 类**(owner 配置了):`getUnackedTicketsOlderThan(5min)` → 升级(bot 没认领 = 兜底)。
- **升级动作(D1 接缝)**:工单绑 issue(payload 有 execution → session → thread)→ `emitFounderStuckNotification` 落 issue thread(复用 FLY-818 + `founder_page_ledger` 防重页)+ 工单 ESCALATED + thread 叙事一条;绑不到 → 现状 Hub needs_human @Annie。
- **行为变更(要在 Annie 早报里写明)**:`runner_stuck_unhandled` 的 founder page 从「Q7 立即页」改为「T2(2 次/5 分)修不掉才页」——@Annie 更少、更准。`FLYWHEEL_ALERT_TICKETS` 未设 = 立即页现状。

- [ ] RED:T2 矩阵(2 次/5 分/无人认领/owner 未配置不兜底)+ 升级两落点 + 防重页
- [ ] GREEN + sentinel(TICKETS 未设 = Q7 立即页现状)
- [ ] Commit

---

## 4. PR-3 Watchdog v2 + W-B

### Task 3.1 checkpoint-park 元组派生(纯函数)

**Files:**
- Create: `packages/teamlead/src/bridge/checkpoint-park.ts`
- Test: `checkpoint-park.test.ts`

```ts
export type BlockedParty = "founder" | "lead" | "runner" | "ci";
export interface ParkTuple {
  issueId: string; identifier: string | null;
  stage: string | null;            // sessions.session_stage(权威,绝不猜)
  party: BlockedParty;
  ownerLeadId: string | null;      // resolveLeadForIssue
  waitingSinceMs: number;          // gate created_at | awaiting_review_entered_at | stage_updated_at
  notifiedEvidence: boolean;       // session_events 有成功投递审计(founder_thread_notified 等)
  nextStep: string;                // 模板「下一步」:按 checkpoint 生成(等你 ship / 答 runner 的 question / …)
}
export function deriveParkTuple(input: {
  session: Session;
  pendingGates: Array<{ checkpoint: string | null; createdAtMs: number }>;
  autoQaActive: boolean;
  notifiedEvidence: boolean;
}): ParkTuple | null; // null = 没 park 在 checkpoint(不巡检)
```

party 派生:checkpoint `brainstorm|approve_to_ship` 或 status `awaiting_review` → founder;checkpoint `question` → lead;autoQaActive → ci;其余 active 且 stage 停滞 → runner。措辞模板(真话,来自 issue 文案):
`[<identifier>] [Runner] 停在<stage>已<N>h,球在<party>,owner=<Lead>,下一步=<nextStep>`。

- [ ] RED:派生矩阵(checkpoint×status×autoQa×审计)先挂
- [ ] GREEN + Commit

### Task 3.2 1h 巡检(piggyback GatePoller)

**Files:**
- Modify: `packages/teamlead/src/bridge/gate-poller.ts`(紧挨 `maybeEmitFounderThreadFallback`/`maybeEmitLeadPendingNudge` 的第三个兄弟,独立 try/catch)
- Test: gate-poller 测试扩展

`maybeEmitCheckpointParkAlert(session, tuple)`,env `FLYWHEEL_CHECKPOINT_WATCHDOG=1` + `FLYWHEEL_CHECKPOINT_STUCK_MS`(默认 3600000):
- 只对 `party=founder` 且 `waitingSince ≥ 1h` 且 `notifiedEvidence=false` 的 park 发**第一响**:wake owner(Runner mailbox wake「校验你的 founder 通知是否送达,重试上报」+ Lead lead_event 同文案)—— FLY-912 的自愈路径(Runner 重试 publish 即愈)。durable marker(`session_events` `checkpoint_park_nudged_<qid|stage>`)防重。
- 再过一窗(同 env 值)仍无 evidence → founder page 落 issue thread(经 PR-1 issue-thread 腿,真话模板)。
- `party=lead` **不新发**(FLY-637-ext 梯子在管,阈值 Annie 已拍;v2 只保证它的文案用元组措辞 —— Task 3.3);`party=ci|runner` v1 仅派生不发(FLY-195/auto-QA guards 在管)。
- kill-switch 未设 = 整条不跑(byte-compat)。

- [ ] RED:1h 门/evidence 门/两窗升级/durable 防重/637 不重叠
- [ ] GREEN + Commit

### Task 3.3 措辞收口(治「Code Review 卡 3h」家族)

**Files:**
- Modify: `packages/teamlead/src/bridge/plugin.ts:4449-4481`(`three_stage_stuck` 文案)
- Modify: `packages/teamlead/src/bridge/lead-pending-escalation.ts`(催单文案)
- Test: 两处文案断言

两处发射点的 title/body 改从 `deriveParkTuple` 生成(stage 取 `session_stage` 权威值;拿不到 tuple → 现状文案 + 前缀「stage未上报」,绝不猜 stage 名)。断言:approve 停等的告警文案含「待你拍板/等你 ship」、**不含**「code review」字样(FLY-912 回归测试)。

- [ ] RED → GREEN → Commit

### Task 3.4 `runner_throttle_stalled` kind(W-B)

**Files:**
- Modify: `packages/teamlead/src/LeadAlertNotifier.ts`(union 加 kind)
- Modify: `packages/teamlead/src/bridge/stuck-candidate.ts`(识别)+ `stuck-escalation.ts`(kind 改写)
- Test: fixture + candidate 测试

`evaluateStuckCandidate` 增识别:pane 停滞(既有判定)**且** pane 含 529/overloaded 限流残留 **且** 无行级 retry 活动(复用 FLY-218 的行级 retry 证据闸思路,Lead 侧函数不搬、runner 侧独立实现避免耦合)→ stagnation 细分为 `runner_throttle_stalled`(否则维持 `runner_stuck_unhandled`)。健康 529(在 retry/在烧)→ 不算停滞,现状不报。

**AutoRepairBot 路径同步(Codex R1 #6,否则新 kind 掉进 needs_human 与 PRD「bot 先修」相悖)**:`runner_throttle_stalled` 作为 runner-stuck **subtype** —— payload 携带同款 `metadata.runnerStuck`(escalation 侧填,字段一致),`AUTO_ATTEMPT_EVENT_TYPES`(AutoRepairBot.ts:80)加入该 kind,attempt 分支复用 `repairRunner` 的 audited continue-nudge(全部 5 道闸不变)。单测:`canAttempt("runner_throttle_stalled")===true`;无 `metadata.runnerStuck` → 拒修 needs_human;白名单/owner 表已含(PR-2)。fixture:合成「真停+529 残留」must-alert、「在 retry」must-not,真样本抓到后替换(follow-up,FLY-218 判例)。

- [ ] RED:三 fixture 先挂 → GREEN → Commit

### Task 3.5 idle≠冻结覆盖验收(W-B 确认项)

**Files:**
- Test only: `packages/teamlead/src/__tests__/LeadWatchdog.*`(补断言,不改逻辑)

把 PRD §4.2 的判定标准落成永久验收断言:`isIdleHealthyPane` 对全部已提交 idle fixture(含 Peter ctx-100%)suppress;resume-menu/compact-prompt/frozen-compact must-alert;`isTransientThrottlePane` 对 529-live suppress、真封顶 must-alert。已知盲点(frozen-mid-thinking)在测试文件注释挂 follow-up 引用。

- [ ] 补断言全绿 + Commit

---

## 5. 部署 / 灰度(三 PR 攒一次重启)

1. **Ship 全关**:三 PR merge,所有新 env 未设 → 逐字现状(每 PR reverse-compat sentinel)。
2. **配置 + 一次 Bridge 重启**(先改 `~/.flywheel/.env` 再重启,launchd KeepAlive 教训):`FLYWHEEL_ALERT_ROUTING=1`、`FLYWHEEL_ALERT_TICKETS=1`、`FLYWHEEL_ALERT_RATE_PER_MIN=20`、`FLYWHEEL_ALERT_SENDER_TOKEN_ENV=CASS_BOT_TOKEN`(过渡;FLY-928 后切 Claude Infra Bot)、`FLYWHEEL_CHECKPOINT_WATCHDOG=1`。
3. **ops(Annie/Tadashi)**:告警频道 Discord 权限收紧(只给 infra bot + 发送身份 Send);写进 FLY-928 部署 runbook 交叉引用。
4. **独立真机 QA(529 Room)**:注入工单看 @-target/状态 edit/攒批;shell 路径统一频道;approve-park 1h 巡检措辞;生产目录零污染 snapshot。
5. **Annie 早报确认项**(Tadashi 递):D1/D2 两裁定 + 「runner_stuck founder page 改 T2 后才页」的行为变更 + 阈值(1h/20/min 沿用已锁值)。

## 6. Out of scope(不碰清单)

bot 建/部署(FLY-928);notify sender 迁移 + self-heal 启用(FLY-929);`FLYWHEEL_BRIDGE_URL`/standup(FLY-925);restart-services/update-flywheel notify(FLY-929);FLY-605/637-ext/195/626 逻辑重写(仅文案/接缝);重恢复引擎(FLY-271);ci 一等状态机;frozen-mid-thinking 真样本(follow-up)。

## 7. 风险与缓解

| 风险 | 缓解 |
|---|---|
| 新模板回声重燃 FLY-220 风暴 | append-only 首行不动 + echo kind 表与 `AlertEventType` 同源派生(全 kind 覆盖)+ 🎫 行分支 + 每 kind 双向 fixture(Task 1.2) |
| 门禁把告警锁死(sender token 失效) | fail 路径 = 既有 dead-letter + meta-alert(Discord-independent),绝不静默;lead-alert.sh/bp_fail_loud 保 fallback |
| owner bot 未部署期工单没人修 | owner 未配置 → 不 @ 不兜底,Cass 现状全保;纯配置翻转 |
| T2 改晚 founder page 错过真急事 | 仅 `FLYWHEEL_ALERT_TICKETS=1` 生效;5min 上限本身很短;Annie 早报明示可否 |
| alert_threads 迁移碰 FLY-663 判例 | 幂等 ADD COLUMN + 旧行 NULL 语义 + 全旧测原样绿 |
