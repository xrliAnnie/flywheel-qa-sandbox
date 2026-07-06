# FLY-314 Roundtable auto-thread 修复(over-spawn + 占位名) — 实施计划

Issue: FLY-314 (https://linear.app/geoforge3d/issue/FLY-314/roundtable-per-topic-auto-thread-auto-create-a-thread-when-a-topic)
日期: 2026-07-01
基于: 无(doc tier=轻/plan-only,Tadashi 拍;本 plan 直接基于代码审计 + Codex design review R1)

---

## 1. 背景与范围(scope)

FLY-314 的 roundtable per-topic auto-thread **功能已 DONE + 全部 merged**(Phase 1 #318 / 2a #329 / 2b #340 / plugin #8 + FLY-576 #349 命名·成员 + FLY-569 reply-in-thread default-on)。当前 branch `flywheel-FLY-314` == `main`,零 divergence。

本次真正的活 = 看板 task「Fix FLY-314 roundtable — over-spawns thread per-message + placeholder names (fleet-wide)」= **修两个生产 bug**(Tadashi brainstorm gate 已确认 scope):

- **Bug A — 过度开 thread(每条消息一个)**:应该「每话题一个」。
- **Bug B — 占位名**:`#leads-roundtable` 里一排 thread 全叫「Roundtable topic」(Annie 2026-06-25 截图)。= 已有 backlog **FLY-578**,与 314 一起修(Cass 定)。

### 1.1 有 3 个 thread 创建者(Codex R1 揪出第 3 个)—— 都要覆盖

| # | 创建者 | repo | 谁在跑 | over-spawn? | 占位名? |
|---|--------|------|--------|------------|---------|
| 1 | Bridge poller `RoundtableThreadManager` | flywheel | Bridge | ✅ any_top_level + 无 follow-up 识别 | 描述名(对);但改名 backstop 依赖 host-bot |
| 2 | **Codex-lead reply-in-thread wiring** | flywheel | **Mufasa**(Codex lead)| ✅ route by msg.id,无 follow-up 识别 | ✅ `ensureThreadFromMessage` 不传 name → fallback `Roundtable topic` |
| 3 | Claude 插件 `ensureRoundtableThread` | claude-plugins-official fork | Belle 等 Claude leads | ✅ route by msg.id | ✅ 硬编码 `Roundtable topic` |

**生产实据**:`~/.flywheel/.env` 有 `FLYWHEEL_ROUNDTABLE_REPLY_IN_THREAD=1` + `FLYWHEEL_LEAD_CROSS_DEPT_CHANNEL_IDS=<roundtable>` → Mufasa(创建者 2)在 roundtable 活跃、reply-in-thread 开着 → 创建者 2 是**真的生产 over-spawn + 占位名源**,不能只修 1+3。

### 1.2 PR 拆分(跨两 repo)

- **PR-1(flywheel,本 repo)**:覆盖创建者 **1 + 2**(Bridge poller + Codex-lead reply-in-thread path)。一个 PR。
- **PR-2(claude-plugins-official fork,单独)**:覆盖创建者 **3**(Claude 插件)。**单独 PR** + **companion-lead fleet Tier-3 重启**。

**doc tier = 轻**:本 focused plan 就够,不跑 full 三件套。

---

## 2. Root cause(实据)

### Bug A — 过度开 thread(3 个源)

**A-1 触发器太宽(创建者 1):** 生产 `FLYWHEEL_ROUNDTABLE_TRIGGER_MODE=any_top_level` →
`buildTopicTrigger` 返回 `() => true`(`topic-trigger.ts:67-68`)→ **每条顶层消息**都开 thread。

**A-2 follow-up 也开新 thread(核心 bug,Tadashi 点名)—— 3 个创建者都有:**
- 创建者 1:`RoundtableThreadManager.mapMessage`(`RoundtableThreadManager.ts:626-638`)**没捕获** `message_reference` → 无法识别 follow-up → follow-up 顶层消息照开新 thread。
- 创建者 2:`resolveRoundtableReplyRoute`(`roundtable-reply-route.ts:51-61`)把顶层消息路由到 `threadId = msg.id`;`RestPollDiscordInboundSource`(`:330`)**不带** `message_reference` → 同样无法识别 follow-up。
- 创建者 3:`resolveRoundtableInboundChatId`(`roundtable-thread-policy.ts:129-146`)把顶层消息用 **自己的 message id** 作 thread id → follow-up 被路由到**新 thread**。

**A-3 噪音也开 thread:** 纯 emoji / 过短顶层消息在宽 trigger 下也开 thread。

### Bug B — 占位名(FLY-578)—— 创建者 2、3

- 创建者 3:`ensureRoundtableThread`(`server.ts:146-160`)赢 create race 时**硬编码** `name:'Roundtable topic'`(`server.ts:159`)。
- 创建者 2:`ensureReplyRoute`(`roundtable-reply-in-thread-wiring.ts:139-147`)调 `ensureThreadFromMessage` **不传 threadName** → `deriveName` fallback `'Roundtable topic'`(`ensure-thread-from-message.ts:41-44`)。
- 创建者 1(Bridge)建 thread 时已用描述名 `threadName(msg.content)`(对);其对**别人建的** placeholder thread 的 recovery-rename(`renameThread`)**在生产没收敛** → 终态占位名。

**为何 host-bot rename 没生效(FLY-578「先查清别假设」):** 最可能真因 = roundtable bot(user id `1516205086890786917`)**缺 `MANAGE_THREADS`** → PATCH 改别人建的 thread 名 → 403 → `renameThread` 归 `permanent` → warn+跳过 → 占位名残留。本 plan 用 **correct-from-start**(每个创建者建 thread 时就用描述名)**彻底消除对 rename 的依赖**,使该真因无关紧要;同时把 `MANAGE_THREADS` 核实放进部署清单(rename 只作 backstop)。

**关键 call site 事实**:创建者 3 在 `server.ts:1422` 调 `ensureRoundtableThread(msg.channelId, routed.sourceMessageId)`,此处 `msg` **就是** topic 源消息(thread id == message id)→ `msg.content` 在 scope 内 → 描述名可**零额外 API 调用**派生。

---

## 3. 设计(design)

**总原则:两层组合。**
- **Layer 1(mode-independent 代码闸,durable)**:follow-up 跳过/confirm-only + 噪音跳过 —— 无论 trigger mode 是什么都生效。**过度开 thread 的根治层**。
- **Layer 2(product-tunable 收窄,env)**:trigger mode 收窄。Annie 真 E2E 可调 mode 微调手感(Tadashi:不替她拍死产品手感)。

### 3.1 触发语义(Layer 2,只影响创建者 1 Bridge poller)—— Codex R1 已同意

**默认 = `broadcast` with `minMentions=1`**(现成 mode):触发 = 顶层 `@everyone/@here` **或** 显式 @ ≥1 人。覆盖 Annie 两例(① 广播、② lead↔lead 互 @),免维护 lead-id 列表。理由:生产 env 没设 `FLYWHEEL_ROUNDTABLE_LEAD_USER_IDS`,`any_lead_mention` 空集 → `() => false` 静默开不出 thread(`topic-trigger.ts:60`);且 `any_lead_mention` 漏 `@everyone` 广播(Annie 例①)。

**Codex R1 采纳点:**
- **不改全局 code 默认**:`broadcast` 的 code 默认 `minMentions` **保持 2**(`roundtable-config.ts:45-46` / `topic-trigger.ts:63-65` / 现有测试),避免动 QA Room / 其他 install 的默认。`minMentions=1` 只作**生产 env 设置**(`FLYWHEEL_ROUNDTABLE_MIN_MENTIONS=1`)。
- **启动 loud log**:Bridge 起 poller 时打印 `mode / minMentions / lead-count / member-count / threadOwnBotMessages` —— 重启后一眼证明加载了正确 mode(现只打印 channel+mode,`plugin.ts:2996`)。
- **blast radius 明说**:`min=1` 在 leads-only 频道里,任何带够文本的单 @ 都会开 thread。可接受(Annie E2E 可调),写进风险节。
- 若 Tadashi 坚持 `any_lead_mention`:必须补 `loadRoundtableConfig` 把 fallback 列表传进 `trigger.leadUserIds`(现在 `roundtable-config.ts:113-144` 解析了 `memberUserIds` 但**没传进 trigger**)+ 空集 loud warn。

> 决策点:**`broadcast`(min=1,env)vs `any_lead_mention`+fallback**。推荐前者。

### 3.2 Layer 1 —— follow-up + 噪音,统一语义(3 个创建者)

**共同语义(3 处一致实现):**
1. **follow-up gate**:消息是 Discord 回复(有 `referencedMessageId`)→ **绝不新开 thread**(硬保证)。至于「回复落哪」是 **creator-specific**(下面各创建者分述):creator 3 插件可 confirm-only 并入原 topic thread;creator 2 Codex 因 durable seam 留父频道;creator 1 poller 只负责建 thread、follow-up 直接 advance 不建。**不新开 thread 是三者一致的硬约束;并入 thread 只有能安全做到的路径做**。
2. **noise gate**:消息去噪后无实义 → 不开 thread。
3. 只有「非 follow-up、非噪音、trigger 命中(创建者 1)/ 该 lead 要回(创建者 2/3)」的顶层消息才 **create-or-confirm**(可建 thread)。

**Codex R1 HIGH#1/#2 核心修正:follow-up 路由必须 confirm-only,不能 create-capable。** 否则把 over-spawn 从「follow-up 自己的 id」挪到「被引用消息的 id」——换个马甲还是过度开。

#### 3.2a 噪音判定 = 独立导出纯函数(Codex R1 MEDIUM#4)
**不复用 `threadName` 反推**(它不去 Unicode emoji)。新增 `isTopicNoise(content): boolean`(flywheel 一份、plugin 一份,镜像):
- 去 custom emoji `<a?:\w+:\d+>` + mention `<@[!&]?\d+>` + channel `<#\d+>` + **Unicode 图形符**(`\p{Extended_Pictographic}`)+ 空白;
- 剩余需有 ≥ `MIN_TOPIC_CHARS`(默认 3)个 `\p{L}`/`\p{N}` 语义字符,否则 = 噪音。
- 测试:custom emoji、单 Unicode emoji、双 Unicode emoji(`👍👍`)、空白、1/2 字符 ack、中文话题、英文话题。

#### 3.2b 创建者 1(Bridge poller)
- `topic-trigger.ts`:`RoundtableMessage` 增 `referencedMessageId?: string`。
- `RoundtableThreadManager.ts`:`RawDiscordMessage` 增 `message_reference?: { message_id?: string }`;`mapMessage` 映射;`processMessage` 在 **trigger 之前**加 follow-up gate + noise gate(返回 `true` = advance 不开 thread,cursor 正常前进 —— 这是 handled/no-op 非 transient,符合 `processMessage` 语义)。

#### 3.2c 创建者 2(Codex-lead reply-in-thread path,PR-1 内)—— Codex R2 采纳「simple safe option」

**架构约束(Codex R2 HIGH#1/#2 揪出):** Codex-lead 的 `replyChannelId` + `replyRoute` 在
**durable accept 时就持久化**(`CodexDiscordGateway.ts:160-170` → `LeadInputRouter.submit`
`:176-184`),`ensureReplyRoute` 只是发送前 best-effort hook(`:284-322`)**改不了 channel**;
且 `submit` 一 accept `replyRoute` 就 `onTopicEngaged`(seed budget)、wiring 的 resolver 同步
`subscribeImmediate`(`:123`)。所以「confirm 不到退父频道」在当前架构**没有 seam**,follow-up 若带
`replyRoute` 会在 confirm 前误 seed budget + 订阅未确认频道。

**因此 creator 2 取 Option B(Tadashi 拍):同步 registry 路由进已知 thread,不改出站链路。**
- `RestPollDiscordInboundSource`:`DiscordInboundMessage` 增 `referencedMessageId?`;`deliver()` 解析 `message_reference.message_id`。
- `resolveRoundtableReplyRoute`:入参 `msg` 增 `content` + `referencedMessageId`;新增 follow-up 分支(在现有 case 1「顶层 roundtable 消息」之内,按是否 Discord 回复分流):
  - **follow-up 且 `ctx.registry.has(referencedMessageId)`**(= 该 topic thread 已知、Mufasa 已订阅)→ **`replyChannelId = referencedMessageId`(同步路由进那个已知 thread),不带 `replyRoute`**(无需 create/confirm — registry 是本进程可信真相,thread id == source message id 不变量)。回复**落 thread**(与 Claude-lead 对齐)→ **不落父频道 → Bridge poller 看不到 → 无 re-thread**。天然满足 R2 HIGH#2(无 replyRoute → 不 seed budget、不 subscribe)。
  - **follow-up 且 registry 未知**(Mufasa 没订阅该 topic)→ `replyChannelId = msg.channelId`(退父频道),不带 replyRoute。**窄残留**(见下取舍)。
  - **fresh topic**(无 referencedMessageId)→ 现行 route(threadId==msg.id),带 `threadName = deriveName(msg.content)`。
- `roundtable-reply-in-thread-wiring.ts` `ensureReplyRoute`:**只在 fresh(有 `replyRoute`)时** `ensureThreadFromMessage(..., { threadName })` 传描述名;follow-up(两种)都无 `replyRoute` → 不进 ensure/subscribe/seed 分支。
- `ensure-thread-from-message.ts`:`EnsureThreadDeps.threadName` 已存在,把它接到 wiring(现在没传)。

> **明确取舍(Tadashi 接受的窄残留 + Codex R3 HIGH 的处理)**:Option B 让 **常见情形**(Mufasa 已订阅该 topic)的 follow-up **进同一 thread、不落父频道**,与 Claude-lead 对齐、无 poller re-thread。**唯一残留**:Mufasa 被 @ 进一个**它没订阅过**的 topic 的顶层-父频道 follow-up → 退父频道 → 若该回复带 mention,理论上仍可能被 poller 当新话题 re-thread。**双重罕见**(reply-in-thread default-on 下 Mufasa 基本已在自己参与的 topic thread 里;被拉进陌生 topic 的顶层-父频道-follow-up 少见)。Tadashi 已接受此窄残留;**彻底闭合需 Option A**(给 Codex 出站加 `replyToMessageId` 让父频道回复变 Discord reply → poller follow-up gate 自动跳)—— 留作 follow-up,不进本 PR(避免把 flywheel PR 扩进整个出站链路)。

#### 3.2d 创建者 3(Claude 插件,PR-2)—— 插件可 into-thread 路由(它 `await ensureRoundtableThread` 后才定 chat_id,有 seam)
- `roundtable-thread-policy.ts`:`InboundChannelInfo` 增 `referencedMessageId?`;`resolveRoundtableInboundChatId`:
  - **fresh top-level**(无 referencedMessageId)→ 现行(chatId==msg.id),标 `create-or-confirm`;
  - **follow-up**(有 referencedMessageId)→ target = referencedMessageId,标 `confirm-only`。
- `server.ts`:`ensureRoundtableThread(parent, targetMessageId, { mode, desiredName })`:
  - `create-or-confirm`:POST create,`name = deriveRoundtableThreadName(msg.content)`(新纯函数,镜像 Bridge `threadName`);160004 → confirm。
  - `confirm-only`:**只 GET** `/channels/{targetThreadId}` 验证是 roundtable 下的 thread;不是 → 返回 false(chat_id 留父频道,不 POST)。
  - `deriveRoundtableThreadName` 放 `roundtable-thread-policy.ts`(可单测)。
- call site `server.ts:1409-1432` 传 `msg.content` + follow-up target。
- **budget seed guard(Codex R2 HIGH#2 第 3 点)**:现在 `server.ts:1427-1429` 对**任何** routed 顶层消息无条件 `seedThreadBudget`。改成**只在 fresh(create-or-confirm)时** seed;**follow-up(confirm-only)不 seed**,且沿用既有「bot-authored trigger 绝不 reset budget」不变量 —— bot 发的 follow-up 不得 revive 已耗尽的 budget。

> **明确取舍(Codex R2 MEDIUM#3,确定性规则,不做 one-hop resolution)**:只有**直接回复 topic 源消息**的 follow-up 才被路由进该 topic thread(target = referencedMessageId,confirm-only);**回复一条 follow-up**(referenced 不是 topic 源)→ confirm 找不到 thread → **退父频道、不建 thread**。E2E matrix 按此写。

#### 3.2e Codex R1 HIGH#3 —— follow-up 重定向要 strip 跨频道 `reply_to`(插件)
follow-up 被路由进原 topic thread 后,`msg.id`(follow-up 自己)与 `sourceMessageId`(root topic)**都是父频道 id**;模型若 `reply_to: msg.id`,Discord 从 thread 内引用父频道消息会被拒。
- `server.ts` 现在 `rtRedirectedSource` 每 thread 只存一个 source id(`:98-100`),strip 只认那个(`:1081-1087`)。
- 改:每个 redirected thread 存**一组**要 strip 的父频道 id —— 至少 root topic source id **+ 当前 follow-up message id**。
- 测试:follow-up 路由进 thread + `reply_to = follow-up id` → 被 strip。

### 3.3 不动的东西(scope discipline)
- **StateStore 无 schema 改动**:`roundtable_topic_threads` + CRUD 已存在(`StateStore.ts:993/2688/2717`)。
- **不碰** issue-thread(`ChatThreadCreator`)、reply-guard、mention-gate、budget、discovery/registry 核心逻辑(只给 route/ensure 加 follow-up 分支)。
- **不做** roundtable thread auto-archive(原 FLY-314「auto-archive resolved topic threads」**从未实现**)—— 超范围,若要另开 issue(关联 FLY-292)。
- **byte-compat**:feature OFF(`FLYWHEEL_ROUNDTABLE_ENABLED≠1` / 无 reply-in-thread config / 插件无 roundtable config)→ 所有改动零行为变化。新增字段皆 optional、default 不改。

---

## 4. Test plan(TDD)

### 4.1 flywheel PR-1 单测
- **isTopicNoise**(3.2a 全套用例)。
- **创建者 1** `RoundtableThreadManager` / `topic-trigger`:follow-up gate(有 referencedMessageId → 不 create、advance)、noise gate、`mapMessage` 解析 `message_reference.message_id`、命中话题照常建 thread + 描述名(回归)、broadcast(min=1)覆盖 @everyone + 单 @、启动 log 断言。
- **创建者 2** `resolveRoundtableReplyRoute` / `roundtable-reply-in-thread-wiring` / `RestPollDiscordInboundSource`(Option B):
  - **follow-up + registry.has(referencedMessageId)**(已知 topic thread)→ `replyChannelId = referencedMessageId`(进 thread)+ **无 `replyRoute`**;断言**不** create、**不** onTopicEngaged/seed、**不** addChannel、且**不**落父频道。
  - **follow-up + registry 未知** → `replyChannelId = msg.channelId`(父频道)+ 无 `replyRoute`;断言不 create/seed/subscribe。
  - fresh(无 referencedMessageId)→ 带 `replyRoute` + `threadName`;`ensureThreadFromMessage` 收到描述名(不再 fallback 占位名)。
  - `deliver()` 解析并带 `referencedMessageId`。
  - **recovery 路径(Codex R2 LOW#4)**:follow-up 无 replyRoute → 不引入新 recovery 态;fresh-topic 的 `replyRoute` recovery(`model_completed` / `output_pending` 重放)由现有 `LeadInputRouter.replyRoute` / `SqliteJournalStore.replyRoute` 测试覆盖,加一条 fresh-topic 传 threadName 的回归即可。
- **byte-compat**:OFF → 无 poller / reply-in-thread 不变(现有 `roundtable-config.test.ts` 回归)。

### 4.2 plugin PR-2 单测(`roundtable-thread-policy.test.ts` / server 相关)
- `deriveRoundtableThreadName`:去 markup/emoji、collapse、slice、空→fallback。
- `resolveRoundtableInboundChatId`:fresh → create-or-confirm(chatId==msg.id);**直接回复 topic 源 → confirm-only、target=referencedMessageId**;**回复一条 follow-up(referenced 非 topic)→ confirm 找不到 → 退父频道、不建**(R2 MEDIUM#3);已在 thread / 其他频道 → 不变(回归)。
- `ensureRoundtableThread` confirm-only:referenced 非 topic → 不 POST、返回 false。
- **budget guard**(3.2d,R2 HIGH#2):fresh → seed;follow-up → **不** seed;bot-authored follow-up **不能** reset 已耗尽 budget。
- **reply_to strip**(3.2e):follow-up 路由进 thread + reply_to=follow-up id → strip。
- byte-compat:无 roundtable config → chatId 不变。

### 4.3 真机 E2E(529 QA Room,**QA 红线** — Tadashi 安排真频道,独立 QA 非实现者)
1. 真发一条 @-lead 顶层消息 → **只开 1 个 thread** + thread 名 == 第一句(**不是**「Roundtable topic」)。
2. 真发 follow-up(在 thread 内回复 / 直接回复 topic 源消息):
   - **硬要求(所有创建者)**:**不新开 thread**。
   - **Claude-lead(创建者 3)**:直接回复 topic 源的 follow-up → **进同一 thread**。
   - **Codex-lead / Mufasa(创建者 2,Option B)**:**验收门** = 回复一个 Mufasa 已订阅的 topic 的 follow-up(registry-known)→ **进同一 thread、不新开**(registry 同步路由)。**registry-unknown** 的陌生-topic 顶层-父频道 follow-up = **明确记录的已接受残留**(退父频道;若该回复带 mention 理论上仍可能被 poller re-thread)—— **不作「保证不 over-spawn」的验收断言**(Codex R4 note 2)。
3. 噪音(纯 emoji / 双 emoji)→ 不开 thread。
4. **覆盖创建者 2 + 3 两条**:验 Codex-lead(Mufasa 式)与 Claude-lead(Belle 式)回复都**不 over-spawn**、fresh topic 名字描述性。
5. byte-compat sanity(OFF 行为不变)。

---

## 5. 交付与部署(deployment)

**PR 拆分**:PR-1(flywheel:创建者 1+2)、PR-2(plugin fork:创建者 3)。

**部署(founder-gated,Tadashi 编排;Codex R1 LOW#7:partial deploy 不算修好):**
1. PR-1 merge → **Bridge 重启**(读 env);同时改 `~/.flywheel/.env`:`FLYWHEEL_ROUNDTABLE_TRIGGER_MODE=broadcast` + `FLYWHEEL_ROUNDTABLE_MIN_MENTIONS=1`。**教训(memory)**:config 在 boot 读,改 env 必须**再重启一次 Bridge** 才生效。
2. PR-2 merge → **companion-lead fleet Tier-3 重启**(同 FLY-569/no-@ 路径,跟那批一起)。
3. **部署清单**:核实 roundtable bot 有 `MANAGE_THREADS`(rename backstop);核实启动 log 显示 `mode=broadcast, minMentions=1`。
4. **验收 gate = 两 PR 都部署 + fleet 重启后**(不是只 Bridge)才跑真 529 E2E → **HOLD 等 Annie**(nothing ships without her)。

**已存在的占位名 thread 清理(Codex R1 MEDIUM#5)—— 一次性运维、不进 code PR:**
correct-from-start 只止住**新** thread 的占位名,不改 Annie 已看到的那一排旧「Roundtable topic」。两 PR 部署后:
- 单条噪音 orphan thread → 用现成 `archive-roundtable-orphan-threads.mjs`(dry-run→apply)归档;
- 有真实回复的活 thread → **Annie 决定**:留着 / 一次性 rename(注意 Discord 硬限 2 改名/10min/thread)。
- 明确写入交付:**旧占位名的清理是部署后一次性运维步骤,交 Annie 拍**,不塞进本次 code PR。

**顺序**:PR-1/2 → Codex design review(本 plan)→ implement(TDD)→ Codex code review ×2(每 repo)→ 两 PR 部署 + fleet 重启 → 真 529 E2E → **HOLD 等 Annie**。

---

## 6. 风险与回滚
- **风险 1:trigger 收窄过头 / min=1 blast radius** → Layer 1(follow-up/noise)mode-independent 兜底;Annie 真 E2E 可即时调 mode(纯 env + Bridge 重启,无需改码)。
- **风险 2:follow-up 误判** → 把「回复一条消息但其实是新话题」当 follow-up 跳过。默认接受(Annie 可发 fresh 顶层消息开新话题);E2E 观察。confirm-only 保证误判最坏 = 退父频道,绝不误建。
- **风险 3:三处 follow-up/naming 语义漂移** → 抽独立纯函数(isTopicNoise / deriveName)+ 各自单测锁定,flywheel 内 3.2b/3.2c 共享 helper。
- **回滚**:flywheel 改动都在 enabled-path,新字段 optional;`FLYWHEEL_ROUNDTABLE_TRIGGER_MODE` 改回 `any_top_level` 即回旧触发。插件改动 byte-compat,回滚 = revert PR-2 + fleet 重启。
