# ⛔️ 本计划已整体作废(2026-09-01 05:03,founder 拍板)

> founder 原话:**「可以可以 对账别做」**。对账 / 兜底扩面(B 方案)**整体砍掉,不做**。
> 本单交付物改为 `plan.md` 里的**插件侧自愈**(A 方案)。
>
> **为什么留档而不是删除**:Lead 明确要求保留。R2/R3/R4/R10 抓出来的那几条镜像缺陷,
> 恰好是「对账层复杂到不值得做」的实证注脚 —— founder 的直觉在这份文档里有账可查。
> 它跑了 11 轮设计评审才 APPROVED,而最终形态仍然要求实现方精确复刻插件 `gate()` 的谓词、
> 载荷逐字段等价、四值 provenance、以及一套非平凡的 disposition 分类。
> **这份复杂度本身就是砍掉它的理由。**
>
> 下面的内容按当时状态原样保留,**不要照它实施**。

---

# FLY-2226 founder Discord 消息选择性丢投 — 实施计划

Issue: FLY-2226 (https://linear.app/geoforge3d/issue/FLY-2226/通信投递丢失-founder-discord-消息选择性丢投2216-thread-从出生就聋-engineer-顶层-0325z)
日期: 2026-09-01
基于: exploration.md, research.md

---

## 0. 一句话

给 founder→Lead 的入站主干道加一条**对账式的第二条腿**:Bridge 周期性比对「Discord 侧确实存在的 founder 消息」与「mailbox 里该有的行」,超过 grace 仍缺失的就补投——补投这个动作本身既是恢复,也是插件失聪的确证信号,拿它发告警。

**不改插件仓一行代码。**

---

## 1. 目标与非目标

### 目标(可验收)

- G1 任一 **allowlisted 顶层频道**的 founder 消息,即使插件完全失聪,也必达 Lead mailbox。
- G2 任一**已注册 issue thread**(含无 session 的、含 `phase_chat_threads` 侧表的)同上。
- G3 插件失聪时**主动告警**,不再依赖 founder 自己发现三小时没人回。
  **限定条件**(Codex R7,诚实收窄):告警链路能在 `EVIDENCE_WINDOW_MS`(缺省 24 小时)内**至少一次**耐久受理(sent / queued / dead-lettered)。超出这个条件的形状见 §7 的未归属边界。
- G4 健康期**零行为改变**:不抢跑、不重复唤醒、不改变回复路由。
- G5 mailbox 行可**审计区分**主路 / 兜底来源。

### 非目标(明确不做)

- ✗ 插件侧 gateway 自愈(`shardDisconnect`/`invalidated`/心跳)——Lead 已拆**独立后续单**,跨仓交付。
- ✗ FLY-2222(delivered ≠ actionable,投了但没看见)。本单只保证**必达 mailbox**。
- ✗ FLY-2062(shell 路径 `no-token` 死信告警断供)——不同链路,research §10.5 已核实。
- ✗ DM 覆盖——Bridge 无 DM 注册表可枚举,且该 lead 历史 DM 数为 0(research §4)。
- ✗ 不改 `emitFounderReplyDeliveryForThread` 的门解释语义(只读它、不动它)。

---

## 2. 架构

```
Discord
  ├─(主路,不动)→ 插件 MCP → node <flywheel-comm> chat-ingest ──┐
  └─(新增第二条腿)→ Bridge FounderIngressReconciler ───────────┤
                         │                                      ▼
                         │                              claimDiscordLane
                         │                          (BEGIN IMMEDIATE 去重)
                         │                                      │
                         │                          ┌───────────┴───────────┐
                         │                     写入了一行              已有行(去重)
                         │                     provenance=            读赢家 provenance
                         │                     bridge_reconcile              │
                         │                          │            ┌───────────┼───────────┐
                         └──────────────────────────┤         plugin   bridge_gate  legacy_unknown
                                                    │            │        │            │
                                                    ▼          健康     中性         中性
                                        ✅ 唯一的失聪证据      (关 incident) (都不开也不关)
                                                    │
                                                    ▼
                          (projectName, leadId) 级聚合 → DeafnessLatch → routedAlertSinkHolder
```

**核心不变量**:兜底只在插件**已经失灵**时才写入。健康期它每一次对账都撞到 `active_inbox`,不产生任何副作用。

---

## 3. 分块实施(每块可独立验证)

### Chunk 1 — envelope 增加 `ingressPath`(来源标记)

**动机**:Lead 的追加硬约束(G5)。把本次诊断赖以成立的判别能力从「靠 `authorName` 取值不同的巧合」升级成**显式契约**。

改动(全部在 `packages/flywheel-comm`):

| 文件 | 改动 |
|---|---|
| `src/chat-delivery-envelope.ts` | `ChatDeliveryEnvelopeV1` 增加可选 `ingressPath?: ChatIngressPath`;`normalizeChatDeliveryEnvelope` 显式透传并校验取值(白名单重建式,不加就会被丢弃) |
| `src/discord-chat-ingest.ts` | `IngestDiscordChatArgs` 增加可选 `ingressPath`;传入 envelope |
| `src/index.ts` | `chat-ingest` CLI 增加 `--ingress-path` flag,**缺省 `plugin`** |

**为什么 CLI 缺省是 `plugin`**:插件 spawn 的就是这个 CLI(`chat-receipt-runtime.ts:267-275`),老插件不会传这个 flag → 自动落到缺省值 → **零插件改动**,且旧行为字节等价。

**四值**(R1 定三值,R6 因误报再加 `bridge_gate`):

| 取值 | 含义 | 来源 | 算失聪证据? |
|---|---|---|---|
| `plugin` | 主路投递 | `chat-ingest` CLI 缺省 | 否(是**健康**证据) |
| `bridge_reconcile` | **对账兜底**补投 | 新对账器**显式**写 | ✅ **是** |
| `bridge_gate` | 现有 founder 门投递 | `founder-reply-deliverer.ts:432` | **否** |
| `legacy_unknown` | 历史行,来源不可知 | 解析**无该字段**的旧 envelope | 否(也**不算**健康) |

⚠️ **`bridge_gate` 是四值而非三值的原因**(Codex R6 抓到我埋的误报):现有 `founder-reply-deliverer` **没有 5 分钟 grace**,它本来就会合法地与插件抢跑并经常赢。我 R2 把它也标成 `bridge_reconcile`,于是它每赢一次都会被聚合当成「插件漏投」→ **持续误报失聪**。必须给它独立取值,且**只有 `bridge_reconcile` 计入失聪证据**。

关键点:**旧行(无字段)必须解析成 `legacy_unknown`,绝不能当成 `plugin`** —— 否则会把来源不明的历史行误当作插件健康而错误清除 latch。

**类型与生产者映射**(Codex R2 要求显式化):

```ts
export type ChatIngressPath =
  | "plugin"           // 主路(插件 / Codex REST 策略)
  | "bridge_reconcile" // 对账兜底 —— 唯一计入失聪证据的取值
  | "bridge_gate"      // 现有 founder 门投递(无 grace,合法抢跑,不算证据)
  | "legacy_unknown";  // 旧 envelope 无该字段
```

| 生产者 | 文件 | 传入值 |
|---|---|---|
| `chat-ingest` CLI(外部插件走这条) | `flywheel-comm/src/index.ts` | `--ingress-path` 缺省 `plugin` |
| 现有 founder 门投递 | `bridge/founder-reply-deliverer.ts:432` | **`bridge_gate`**(不是 `bridge_reconcile`) |
| Codex REST 策略 | `codex/CodexDiscordMailboxStrategy.ts:72` | `plugin`(它就是主路的 Codex 版) |
| 新对账器 | `bridge/founder-ingress-reconciler.ts` | `bridge_reconcile` |

`legacy_unknown` **只能**由「解析无该字段的旧 envelope」产生,任何生产者都不得主动写入它。

**赢家行的读取方式**(§4a 依赖它):按 `chatDeliveryId(leadId, messageId)` 查 mailbox 行 → 解析 `content` 里的 envelope → 取 `ingressPath`。需要一个只读 helper(如 `queue.getById(deliveryId)` 之上薄封装);行不存在或 envelope 解析失败 → 视为 `legacy_unknown`(**保守,不算恢复**)。

**不做**:不动 `v` 版本号。字段可选、老读者忽略未知字段,不构成破坏性变更。

**测试**
- 不传 flag → `ingressPath: "plugin"`。
- 传 `--ingress-path bridge_reconcile` → 得到该值。
- 传非法值 → **拒绝**(不静默落缺省)。
- 老 envelope JSON(无该字段)parse 不报错,得到 **`legacy_unknown`**(**不是** `plugin`)。

---

### Chunk 2 — 覆盖面枚举器 `listFounderIngressTargets`

新文件 `packages/teamlead/src/bridge/founder-ingress-targets.ts`,**纯函数 + 注入读取**。

输出每个目标 `{ kind: "top_level" | "issue_thread" | "legacy_phase_thread", channelId, leadId, projectName, bootstrapLowerBoundMs }`:

1. **顶层**:每个 `project.leads[].chatChannel`(`ProjectConfig.ts:15`,必填且启动期校验)。
2. **issue thread**:`chat_threads` 中 `archived_at IS NULL AND discord_missing_at IS NULL`。
3. **legacy phase thread**:复用**已存在**的 `store.getUnarchivedPhaseChatThreads()`(`StateStore.ts:11555`)。

> ⚠️ **计数是运行时快照,不是静态事实**(Codex R2):首次观测 16 + 58 + 7 = 81,数小时后复测已是 16 + 60 + 7 = **83**。规模随活跃 issue 漂移,所以预算与轮转是**必需**而非可选,任何测试都不得把 81/83 写成断言常量。

> 📌 **事实更正**(Codex R1 #6,已核实):`phase_chat_threads` 在 FLY-892 之后**已停止写入**,只剩只读 legacy 行(`StateStore.ts:9150-9156`);现在是「一 issue 一 thread + `sessions.chat_thread_role` 作前缀」。所以这里不是「DAG workflow 的当前 thread 在侧表」,而是**历史遗留行仍需覆盖**。也**不需要新增** `listActivePhaseChatThreads()`,现成方法就够。

**只需新增一个 StateStore 只读方法**:`listActiveChatThreads()`(现有只有按 issue 单查的 `getChatThreadByIssue`)。

#### 2a. 策略门:必须 policy-aware,且 fail-closed

**这是必须做对的一条**。插件的 `gate()`(`server.ts:754-824`)会按 `groups[channelId].requireMention` / `allowFrom` 决定 drop。若对账器无视策略,就会投递插件**有意丢弃**的消息 —— 既是行为扩面(违反 G4),又会把它们错记成失聪证据(违反 G3)。

实测(逐 lead 交叉核对其**自己的** chatChannel):

| 情况 | 数量 | 处置 |
|---|---|---|
| `requireMention: false` | **15** | 插件本就投递 founder 的全部消息 → 对账器覆盖它**不构成行为扩面** |
| 无 access.json(`codex-infra-bot-lead`) | **1** | 策略**不可确认** → **fail-closed 跳过**,并记一条一次性的配置告警 |
| `requireMention: true` | **0** | — |

规则:**只覆盖 `requireMention === false` 且策略可读的 chatChannel 及其注册 thread**。策略读不到、或为 `true` 的目标一律跳过(前者 fail-closed,后者本就该由 @ 提及触发,不属于「必达」语义)。策略文件路径由 `leadId` 推导(`~/.claude/channels/discord-<leadId>/access.json`);**读不到 ≠ 放行**。

thread 继承父频道策略(与 `gate()` 的 `parentId` 查找一致),不单独判。

**策略必须每轮重读,不得在启动时缓存**(Codex R2):`access.json` 是运行时可变的(`/discord:access` skill 会改它,`gate()` 每条消息都 `loadAccess()`)。启动缓存会让对账器按一份过期策略投递。实现上每轮读一次、轮内复用即可。

**必须精确镜像 `gate()` 的 guild 谓词**(Codex R3;我 R2 写的版本有两处错,已逐条核实 `server.ts:707-760`):

```
1. access.dmPolicy === "disabled"          → DROP   ← 尽管名字带 dm,它是全局前置,guild 也拦
2. policy = access.groups[<父频道 id>]
   若不存在                                 → DROP
3. policy.allowFrom 非空 且 不含 senderId   → DROP
4. policy.requireMention !== false          → 需 @ 提及,不属「必达」→ 不覆盖
否则                                        → 覆盖
```

我 R2 版本的两个错误(均已改正):
- **漏了 `dmPolicy === "disabled"`** —— 会补投插件有意全局丢弃的 guild 消息;
- **多加了全局 `access.allowFrom` 检查** —— 那是 **DM 专用**分支(`server.ts:718`),guild 路径**从不检查**它;多加会跳过插件本该接收的消息。

thread 用**父频道 id** 查 group(与 `gate()` 的 `parentId` 查找一致),不单独判。

**测试必须含这两个反例**:`dmPolicy: "disabled"` 的目标不被覆盖;发信人不在全局 `allowFrom` 但在 group `allowFrom`(或 group 未设)的 guild 消息**仍**被覆盖。

#### 2b. thread → (project, CommDB) 的 fail-closed 映射

`chat_threads` / `phase_chat_threads` 的 `lead_id` **可为 NULL**,且两表**都没有 `project_name`**。映射规则:

1. 优先用 `lead_id`;
2. `lead_id` 为 NULL 时,用 `channel_id` 反查 `projects[].leads[].chatChannel`;
3. 反查结果**不唯一或为空** → **跳过该目标并计数**,绝不猜。

#### 2c. bootstrap 下界

| 目标类型 | 下界 |
|---|---|
| issue thread(`chat_threads`) | `max(created_at, now − LOOKBACK_MS)` |
| **legacy phase thread** | `now − LOOKBACK_MS` —— 现有 `getUnarchivedPhaseChatThreads()` **不返回 `created_at`**(Codex R2 核实)。取保守下界,**不扩展该 accessor**:7 行 legacy 且都很旧,不值得为它改动一个被 boot-sweep 共用的只读方法 |
| 顶层频道 | `now − LOOKBACK_MS`(无注册时刻) |

#### 2d. 预算

`MAX_TARGETS_PER_PASS` 默认 **120**(观测规模 81→83 且会漂移),保留轮转(记住上轮游标)。轮转不是为当前规模,是为将来。

**测试**
- 三类目标都被枚举;`archived_at`/`discord_missing_at` 非空的被排除。
- `requireMention: true` 的频道**不被覆盖**;access.json 缺失的频道**不被覆盖**且记配置告警(这两条是 §2a 的针对性用例)。
- `lead_id` 为 NULL 且 `channel_id` 反查歧义 → 跳过并计数,不猜。
- 目标数 > 预算时轮转,断言**两轮之内每个目标都被访问过**。
- legacy phase thread 行不被漏掉。

---

### Chunk 3 — 对账器 `FounderIngressReconciler`(本单主体)

新文件 `packages/teamlead/src/bridge/founder-ingress-reconciler.ts`。

单个目标一轮的流程:

```
1. cursor = cursorStore.load(channelId)
2. 若 cursor 未初始化 → 有界回看 bootstrap(见下),不跳 HEAD
3. GET /channels/<id>/messages?limit=N&after=<cursor>
4. 对每条消息:
     - 非 founder(authorId !== ownerUserId) → 跳过,可推进 cursor
     - 年龄 < GRACE_MS → **停止推进 cursor**,本轮到此为止(它还在插件的合法重试窗口内)
     - 年龄 ≥ GRACE_MS → ingestDiscordChat({ ..., ingressPath: "bridge_reconcile" })
         · verdict active_inbox   → 插件已拿到,健康
         · verdict inserted_inbox → 补投成功 + 记一个失聪证据
         · verdict archived       → 记 archived_drop(目前全仓不可见)
5. 推进 cursor 到最后一条已处理的消息
```

**必须写死的设计点**:

- **GRACE_MS = 5 分钟**,取自插件的 `INGEST_RETRY_MAX_MS`。
  ⚠️ **修正**(Codex R1 #2,已核实):`INGEST_RETRY_MAX_MS` 是**指数退避的间隔上限**,**不是**总重试期限 —— spool intent 会一直保留、无限重试,5 分钟只是它记一次 stalled 日志的点。所以 **grace 不能证明插件已放弃**,它只把抢跑变稀有。真正的防线是下一条(载荷等价)。
- **载荷与主路等价**(替代「靠 grace 避免抢跑」):对账器写入的 envelope,除 `ingressPath` 外必须与插件在**同一目标**上会写的逐字段一致。**逐字段映射表**(Codex R2 要求显式化;左列取自插件 `server.ts:1600-1627` 的 `buildBeginArgs`):

| envelope 字段 | 插件取值 | 对账器必须取 |
|---|---|---|
| `chatId` | `msg.channelId`(覆盖集内不改写) | 目标 `channelId` |
| `originChannelId` | `msg.channelId` | 同上 |
| `authorName` | `msg.author.username` | REST 的 `author.username` —— **不是** `global_name` |
| `authorId` | `msg.author.id` | `author.id` |
| `ts` | `msg.createdAt.toISOString()` | 由 `timestamp` 转同格式 |
| `msgKind` | 覆盖集内恒 `guild` | `guild` |
| `attachments[].sizeKb` | `Number((size/1024).toFixed(0))`(**取整**) | 同一取整式 |
| `attachments[].name` / `type` | `safeAttName(att)` / `contentType ?? 'unknown'` | 同 |
| `text` | `msg.content \|\| (有附件 ? "(attachment)" : "")`(`server.ts:1597`) | **同式** —— 不可直接用 REST 的空 `content` |
| `replyChannelId` | **恒设为 `chatId`**(`chat-receipt-recorder.ts:177`;runtime 也恒传 `--reply-channel-id`) | **恒设为 `chatId`** |
| `replyRoute` | 仅 roundtable 设置(覆盖集外) | 不设置 |
| `founderId` | 传入 | `ctx.ownerUserId` |

这样即使抢跑发生,先到者赢也**不产生任何可观察差异**。

⚠️ **我 R2 的两处错误**(Codex R3 指出,已核实改正):
- 曾写「`replyChannelId` 覆盖集内不设置」—— **错**。插件对**每一条**消息都设 `replyChannelId = chatId`。它参与 batch partition key 与 Lead 回复路由,漏设会让 issue-thread 兜底的回复**落到默认频道**,直接违反 G4。
- 曾**漏掉 `text`** 的空正文回退 —— 纯附件消息插件写 `"(attachment)"`,直接采用 REST 的空 `content` 会产生可观察差异。

⚠️ `sizeKb` 取整与 `authorName` 字段选择是现有 Bridge 路径与插件**已经不一致**的两处,必须按上表对齐到插件侧。

**验证方式**(Codex R3 要求):写一个「插件 mapper 与对账器 mapper 产出的 normalized envelope **深比较**」测试,断言**只允许 `ingressPath` 不同**,并至少覆盖 issue thread 消息与**纯附件**消息两种形状。
  📌 **范围澄清**(Codex R1 #2 的 blast radius 更正):唯一**行为性**的分歧是 roundtable 的 `replyRoute` 改写(丢了会让 Lead 回复落到父频道)。实测 roundtable 频道 = `1512578695468941333`(`~/.flywheel/roundtable.json`),它**不在** 16 个 chatChannel 之列,因此**不在本对账器覆盖范围内**;顶层实测投递行的 `chatId` 也等于频道 id(未被改写)。故覆盖集内的残余分歧仅为上述外观字段。
- **bootstrap 有界回看,不跳 HEAD**。取 `max(目标 bootstrap 下界, now − LOOKBACK_MS)`,`LOOKBACK_MS` 缺省 30 分钟。现有 `founder-reply-deliverer.ts:305-339` 的跳 HEAD 会在「开始覆盖」那一刻给每个目标留永久空洞(research §6)。回看重叠安全:已投递的撞 `active_inbox`(F3)。
- **绝不做门解释**。本模块只 ingest,不得 import 任何 `approve_to_ship` / `founder_review` / decision-convergence 符号。research §5:顶层一句「好」被匹配成 ship 批准是安全级回归。

#### 3a. 顺序、分页、并发(Codex R1 #5,全部接受)

- **oldest-first**:Discord 返回 newest-first,必须先按 snowflake **升序排序**再处理(镜像 `founder-reply-deliverer.ts` 现有的 `messages.sort(...)`)。否则「遇到 grace 内消息就停」会让成熟的旧消息**永久饥饿**。
- **前向分页**:用 `?after=<cursor>` 持续拉取直到追上,并设**单目标消息预算**,超出则保留 cursor 下轮继续。
- **限流**:处理 `429` 与 `Retry-After`,退避而**不推进 cursor**。
- **single-flight**:rider 是 fire-and-forget,一轮若超过 tick 间隔会与下一轮重叠。必须加单飞锁(照 `HeartbeatService.dispatchMaintenanceTick` 的写法),重叠时跳过本轮而不是并行跑。
- **cursor 实例共享**:必须**共用同一个 store 实例**(或独立文件)。两个 `FileInboundCursorStore` 指向同一 JSON 会整图写入互相覆盖。key 用独立命名空间 `ingress:<channelId>`,不与 `founder-reply-deliverer` 的 thread cursor 混用。

**失败处理**:单个目标读失败(限流/权限/超时)→ **不推进 cursor**、记录、下轮重试。绝不因读失败跳过消息。

**测试**(重点在错形状对照组,research §9)

| 用例 | 断言 |
|---|---|
| 插件已投递、消息超 grace | verdict `active_inbox`,**不计**失聪证据,不产生第二行 |
| 插件漏投、消息超 grace | verdict `inserted_inbox`,消息进 mailbox,计 1 次失聪证据 |
| 消息在 grace 内 | **完全不碰**,cursor 不越过它 |
| grace 边界 ±1s | 前者不碰,后者补投 |
| 非 founder 消息 | 不 ingest,但 cursor 可推进 |
| bootstrap:目标有历史消息 | **不跳 HEAD**,回看窗内的待投递消息被补上 |
| 读失败 | cursor 不推进,下轮重试同一批 |
| 顶层频道 + 一条形似 ship 批准的消息 | 只 ingest,**不**触碰任何门(§5 回归护栏) |
| 载荷分歧 | 同一消息先后由两个写入者以不同 envelope ingest → 先到者赢、后到者静默丢弃、**不抛错**(F4 目前无测试覆盖,本单依赖它,必须补) |

---

### Chunk 4 — 失聪告警 `discord_ingress_deaf`

**判据**:一条本该由插件投递却由兜底补上的消息(`inserted_inbox`),就是插件失灵的确证——不等「连续 N 次」,因为 founder 可能只发一条就走开(research §3)。

#### 4a. 恢复判据:`active_inbox` **不是**插件健康证明(Codex R1 #3,接受)

`active_inbox` 只说明「该 identity 已有 inbox 行」。那一行可能来自:对账器自己上一轮的补投、cursor 保存失败后的重放、现有 founder deliverer、甚至已 ACK 的历史行。**据它清 latch 会在插件仍聋时错误 resolve。**

正确判据:读**赢家行的 envelope `ingressPath`**——

| 赢家行 provenance | 含义 |
|---|---|
| `plugin` | ✅ **唯一**的恢复证据 |
| `bridge_reconcile` | ❌ 是对账器自己写的,**不是**恢复(且是唯一的失聪证据) |
| `bridge_gate` | ❌ 现有门投递合法抢跑赢的,**既不算恢复也不算失聪** |
| `legacy_unknown` | ❌ 来源不明,**不算**恢复 |

#### 4b. 耐久证据与 cursor 越过规则(Codex R1 #4 + R2 BLOCKER,重写)

原计划「先补投并推进 cursor,再发告警」有一个永久丢证据的窗口。但我 R1 的修法引入了**更严重的死锁**(Codex R2 抓到,确认成立):

> 规定「告警 `isDurablyHandled` 后 cursor 才能越过」+ 规定「已恢复的历史 miss 不告警」
> ⇒ 后者**永远不满足**前者 ⇒ **cursor 永久卡死**。

而且「未告警的 `bridge_reconcile` 行」**根本不可判定** —— mailbox 行没有任何 alert disposition 字段。R1 的「用 mailbox 行当证据台账」是行不通的。

> 🔻 **这里原本是一版逐条消息簿记的设计,已整段删除**(Codex R5/R6 之后)。
>
> 删除而非保留的原因:它带着一套与 §4b-final **相反**的验收标准(pin、`sink_failed`、
> `advanceableUpTo` waterline),留在实施计划里会让实施者面对互相矛盾的要求 —— 这正是
> Codex R6 点名的问题。
>
> **留下的教训**:它每被评审一轮就长一层机制 —— pin → 为 pin 保留证据 → 为证据加枚举器
> → 再加第二个 frontier。根因是把「失聪」这个 **lead 级**状态当成**逐条消息**的簿记去追踪。
> 正确的动作是换模型,不是继续打补丁。见 §4b-final。

#### 4b-final. 定稿模型:cursor 永不 pin,失聪判据是 lead 级聚合

Codex R5 的两个 blocker 都成立,但它们**共同的根因**是我把「失聪」这个 **lead 级**的状态,拆成了**逐条消息**的簿记去追踪。于是不得不为每条消息保留 pin、为 pin 保留证据、为证据保留枚举器 —— R5 建议再加「两个 frontier + 跨 frontier 枚举器」来补,那是继续往上叠。

**换模型,而不是加机制。**

- **cursor 只有一个,且永不 pin**。读到就 ingest,ingest 完就推进。投递是单调的,`no-delivery-blocking` **由构造保证**(R5 BLOCKER 2 消失:不存在被 pin 的前缀,预算耗尽后下一轮自然从断点继续)。
- **失聪判据 = 对近窗口 mailbox 行按 provenance 做的聚合**,不是逐条消息状态:

  ```
  该 (projectName, leadId) 在窗口内存在 provenance=bridge_reconcile 的行,
  且其后不存在更新的 provenance=plugin 行        ⇒  失聪中
  ```

  **聚合的精确契约**(Codex R6,全部接受):

  | 约束 | 理由 |
  |---|---|
  | 身份是 `(projectName, leadId)`,**不能只用 leadId** | 不同 project 允许复用同一 agentId,只按 leadId 聚合会串台 |
  | 只计入 **founder 发的**、**当前覆盖目标内的**、**可解析的 `discord_chat` envelope** 行 | 否则「另一个用户 / 覆盖范围外 / 另一 project 的较新 `plugin` 行」会**错误清除** incident |
  | 「更新」按 **Discord 事件时间 / snowflake**,不是 mailbox `seq` | `seq` 是写入序,补投会让它与真实时序不一致 |
  | 读取属于 **CommDB / MailboxQueue**,不是 StateStore | 我前面写的「只新增 StateStore 只读方法」不完整,这里要补一个 mailbox 侧的只读聚合 |
  | 每个 `(project, lead)` **每轮只聚合一次** | 窗口小只限制**返回行数**,不限制 SQLite **扫描量**;当前没有 `(to_agent, created_at)` 索引 |

  **实施前必须实测一次 query plan**;若扫描量不可接受再考虑加索引,现在不预先优化。

- **告警失败无需 pin**:下一轮**重新计算同一个聚合**,条件仍然成立(mailbox 行还在),于是自然重试。R5 BLOCKER 1 消失:不需要按 messageId 精确回查,也就不受「Discord 消息被删除后 ID 不再由扫描流提供」的影响 —— 聚合是**按 lead 扫近窗口的行**,不是按 ID 查某一行。
- **恰好一次告警**由既有的 episode latch 负责(§4d),这本来就是它的职责,不该由 cursor 兼任。

**被这一步删掉的东西**(净减,不是净增):

| 删掉 | 原因 |
|---|---|
| 全部 pin 逻辑与 `sink_failed` 状态 | cursor 不再承担证据职责 |
| `advanceableUpTo` waterline | 没有 pin 就没有不连续前缀 |
| 两个 frontier(R5 的建议) | 一个就够 |
| 跨 frontier 的 provenance 枚举器(R5 的建议) | 聚合查询本身就是枚举 |
| 「未处置 miss 的恢复搜索绑 `miss.ts`」的特例 | 聚合按 lead 排序取最新,不需要逐 miss 的下界 |

**第 1 级分类保留**(它仍然有用:决定要不要 ingest、以及这条是不是恢复证据),但**没有任何 disposition 会为了等告警而钉住 cursor**。

⚠️ **但有一条连续前缀约束仍然 load-bearing**(Codex R6 (d) 确认,不可一并删掉):**cursor 绝不能越过一条尚未成功 ingest 的消息**(`io_failed` / `in_grace`)。否则 G1/G2 的「必达」就破了 —— 越过去就再也不会回来读它。

区别在于**为什么停**:
- ❌ 旧模型:为了**等告警**而停 → 会被卡死、会饿死后续消息;
- ✅ 新模型:仅因为**这条还没成功 ingest** 而停 → 下一轮重读即可推进,不依赖任何外部系统恢复。

实现上就是**遇到未成功 ingest 的消息就 break 出本轮循环**,不需要旧的 waterline 对象。

**代价与边界(诚实说明,Codex R6 逐条收紧)**:

- **证据期限 = 聚合窗口本身,就是 `EVIDENCE_WINDOW_MS`(缺省 24 小时)**。我此前写的「72 小时边界」**不成立**,已撤回。

  ⚠️ **我把它归给 FLY-2062 / `bridge-liveness-probe.sh` 的说法同样是错的**(Codex R7 指出,我已核实):FLY-2062 是 **shell 路径 `no-token` 死信**,与本链路不同(research §10.5 是我自己写的);`bridge-liveness-probe.sh` 探的是 Bridge `/health`,而这个反例里 **Bridge 是健康的**,只是 sink 持续不耐久。**这个形状目前没有任何系统覆盖。**

  按 Codex 给的两个可接受修法,本单取**第一个**:**显式收窄 G3 + 把它列为未归属的接受边界**(§7),而不是为它保留超窗证据 —— 后者会把刚删掉的机制再加回来。

  风险评估(为什么可以接受):⚠️ 注意 `isDurablyHandled` / `PERMANENT_QUEUE_REASONS`(no-channel / no-token / unknown-lead)是 **raw notifier** 的语义,本单选的 **ticket 路由不走那条**(Codex R9 更正)。ticket 路由上真正的持续失败形状是 **Claw mailbox 的 CommDB owner / queue / identity / I/O enqueue 持续抛错**。要连续 24 小时一次都不成功入队,需要 CommDB 侧的持续性故障 —— 罕见,但**不是不可能**,所以写成边界而不是「不会发生」。

- **插件的迟到重试不留痕 ⇒ 单条消息上的恢复不可观测**(Codex R6 的真误报):兜底赢了 M 之后,插件对同一条 M 的成功重试会被 `claimDiscordLane` 静默去重,**不产生任何 `plugin` 行**。所以恢复**不能**指望「同一条消息上看到插件」。
  这正是聚合按 **lead 级**而非**消息级**判定的价值:插件一旦恢复,它会赢下**下一条**消息并留下 `plugin` 行,聚合随即翻转为健康。
  **残留边界**:若插件恢复后 founder **再也没发消息**,incident 会一直挂着直到下一条 founder 消息到达。这是「陈旧 incident」,不是告警风暴。处置:**告警正文写明**「检测器会在**下一条由主路(插件)赢下的** founder 消息到达时判定为已恢复并停止就本代次继续告警 —— 注意 issue thread 里的消息可能被无 grace 的现有门投递抢先赢下,那**不算**恢复;要立即确认,请在 **allowlisted 顶层频道**发一条测试消息(那里没有门投递抢跑)。**本工单需要你自己关闭**,检测器不会替你 resolve」。不为此新增任何机制。

- **聚合的扫描成本**:按 `(to_agent, 时间窗)` 扫行并解析 envelope。窗口小只限制**返回行数**,不限制**扫描量**,且当前没有 `(to_agent, created_at)` 索引 —— 实施前**实测一次 query plan**,不可接受再加索引。现在不预先优化。

**测试(替换上面那组 pin 相关用例)**
- 告警 sink 连续失败 → **cursor 照常前进**,且**每轮都重新判定为失聪并重试告警**(不依赖 pin)。
- 预算 B 耗尽 + 后续 B+1 条成熟消息 → 跨轮全部进入 mailbox(R5 BLOCKER 2 直接回归)。
- 已 ingest 未告警的消息在 Discord 侧被删除 → 聚合**仍**判定失聪(R5 BLOCKER 1 直接回归)。
- 插件恢复(出现更新的 `plugin` 行)→ 聚合翻转为健康,**清内存 latch**(不 resolve 工单,见 §4d 的撤回)。
- 跨频道恢复 → 聚合是 lead 级的,天然覆盖,无需特例。
- 重启后不重复卡在同一预算前缀。

#### 4c. bootstrap 与 live-alert 的矛盾(Codex R1 #7,接受)

原计划自相矛盾:一边说「首个 `inserted_inbox` 即确证」,一边又说「上线首轮的 inserted 不应判失聪」。若首轮证据被抑制**而 cursor 已推进**,一个持续失聪但 founder 恰好不再说话的插件将**永远不会告警**。

解法:**按时间顺序构造每个 lead 的状态**,而不是抑制首轮证据:
- 收集该 lead 近窗口内的证据序列(带时间戳与 provenance);
- 若某次 Bridge-miss **之后**存在更新的 `plugin` provenance 行 → 记为**已恢复事件**(历史,不告警);
- 若 miss 之后**没有**更新的 `plugin` 证据 → **保持 active incident**,告警。

这样上线首轮的历史补投若随后有主路证据,自然被判为已恢复;真正仍失聪的则照常告警。**首轮证据不丢弃,只是被正确地分类。**

**窗口定义**:证据保留窗 `EVIDENCE_WINDOW_MS` 缺省 24 小时(需明确写入实现,不留「单位时间窗」这种含糊表述);同一 pass 内出现 miss→recovery 时,以**时间序最后一个**状态为准。

#### 4d. 防抖(抄 `CmuxWatcherPatrol` + `FleetSensors` 两段式,research §10.3)

- 纯分类器 `classifyIngressHealth(snapshot, thresholds) → { branch, alert, episodeKey, detail }`。

**身份必须逐个写死**(Codex R8:我 R7 只改了 episodeKey 一处示例,其余没写进文件却在汇报里说改了 —— 这里补全):

| 标识 | 精确格式 / 取值 | 为什么必须带 `projectName` |
|---|---|---|
| `episodeKey` | `deaf:<projectName>:<leadId>:<firstUnrecoveredMissMs>` | 一次失聪代次的唯一名 |
| `eventId` | `discord_ingress_deaf:<episodeKey>` | **`lead_events` 的唯一键是 `(lead_id, event_id)`**(`StateStore.ts:3532`,已核实),只用 leadId 会让两个复用同一 agentId 的 project 互相 suppress |
| 内存 latch 的 key | `` `${projectName}\u0000${leadId}` `` → `episodeKey` | 同上,内存侧不能只按 leadId 建索引 |

- 内存 latch **只在 `isDurablyHandled(result)` 为真之后**才置位(`fleet-sensors.ts:119`)。

**重启防重复:靠 Claw mailbox 的 delivery identity(不是 `getActiveAlertThread`,也不是 `lead_events`)**

两次改正,依次记录:

1. **删掉 `getActiveAlertThread`**(Codex R8):ordinary/ticket kind 在 `infra-event-router.ts:188-189` 就 `return deps.ticketSink.alert(payload)` 短路进 Claw mailbox,**根本不经过 `AlertChannelHub`**,不会有 `alert_threads` active 行(`infra-alert-wiring.test.ts:453` 正是断言这一点)。
2. **也不是 `lead_events`**(Codex R10,我 R8 的替代方案同样错):ticket 路由**根本不写 `lead_events`**。它经 `plugin.ts:10511` → `LeadInboxRuntime.enqueueInfraAlert()`,构造
   `deliveryId = infra_alert:<ownerLeadId>:<eventType>:<eventId>`(`lead-inbox-runtime.ts:551`)直接写 Claw CommDB mailbox。

**真正的去重面是这个 `deliveryId`**。但 `MailboxQueue.enqueue` 会比对**整个 producer projection**,identity 相同而**内容不同**时抛 `mailbox identity conflict`(`mailbox-queue.ts:551-558`);内容**完全相同**才是良性去重。

⚠️ 由此得出一条**硬约束**:

> **同一 episode 的告警正文必须是 `episodeKey` 的纯函数 —— 不得包含任何会随时间变化的量。**

📌 实施注意(Codex R11 的 non-blocking note):「不可变」指的是**整个 mailbox producer projection**,不只是 `body` —— `title` / `severity` / `sessionKey` / `episodeId` 等参与 projection 的字段**同样必须稳定**。

Codex R10 给的反例(成立):首次 miss 以「已补投 N=1 条」发出并置 latch → 同 episode 又有 miss → Bridge 重启、latch 丢失 → 聚合重算出**同一个** `eventId`,但正文变成 N=2 → 同 identity + 不同 projection ⇒ **抛 `mailbox identity conflict`**,而不是良性去重 ⇒ sink 抛错 ⇒ latch 永远置不上 ⇒ **此后每轮都失败**。

**处置(又是删,不是加)**:把**会变的计数移出告警正文**。正文只由 `episodeKey` 决定 —— project、lead、失聪起始时刻、以及固定的处置指引。「这次一共补投了多少条」不进告警,由 `bridge_reconcile` 行自己回答(那本来就是审计口径,§7 的 G5)。
正文不变 ⇒ 重启重算得到**逐字节相同**的 projection ⇒ `enqueue` 良性返回既有行 ⇒ sink 成功 ⇒ latch 正常恢复。

- **恢复边**:出现更新的 `plugin` provenance 行(§4a)→ **清内存 latch**,使得**将来**的新失聪代次能重新告警。
  ⚠️ **不承诺自动 resolve 工单**(同上,ticket 路由没有 Hub 生命周期可 resolve)。工单由 on-call 处置后自行关闭。这一条是**撤回**,不是遗漏。

**新 alert kind 要动的 7 处**(research §10.2)。其中:
- `bridge/kind-contract.ts` 是**编译期强制 + 启动期 `validateKindContracts()` 抛错**,漏了 Bridge 起不来。
- ⚠️ `infra-event-router.ts` 归 `TICKET_KINDS` 还是 `ISSUE_PROGRESS_KINDS` **必须论证后再定**,不得凭手感塞进旧白名单。本单主张归 **`TICKET_KINDS`**:它是需要有人处置的基础设施故障(要开工单派给 on-call),不是某个 issue 的进度事件。
- `doc/oncall/contact-book.md` 的 owner 行要填,否则告警无人认领。

**告警正文必须可执行,且必须不可变**:写明「插件 inbound 失聪;止血动作 = 重启该 lead 的 discord 插件进程」。⚠️ **不得**写「已补投 N 条」这类随时间变化的量(见上面的不可变约束)。本次事故已实测**重启即愈**(exploration §6.1),这是确证有效的处置动作,不是猜测。

**测试**(已按 §4b-final 的聚合语义改写;不再有任何 pin / `sink_failed` 相关断言)
- 漏投 → 告警发射一次;同一 episode 内再漏投 → **不重复**发射。
- 恢复判据:窗口内最新的 provenance 为 `bridge_reconcile` / `bridge_gate` / `legacy_unknown` → **不得**清 latch;出现更新的 `plugin` 行 → 清 latch(**不**断言 resolve 工单,见上)。(错形状对照组:只喂 `plugin` 会让「不清 latch」这条分支成为死代码)
- **`bridge_gate` 赢家不得被判失聪**(现有无 grace 的门投递合法抢跑 → 误报回归测试)。
- 再次失聪 → 新 episode 重新告警。
- 告警发射失败(未 `isDurablyHandled`)→ latch **不**置位,**cursor 照常前进**,下一轮**重算同一聚合**并重试(不依赖 pin)。
- **插入成功后崩溃**:补投行已写、告警未发 → 重启后聚合从 mailbox 行重新判定为失聪并告警。
- **时序分类**:miss 之后有更新的 `plugin` 行 → 判已恢复不告警;miss 之后无 `plugin` 行 → 保持 incident 并告警(§4c)。
- **同 `leadId` 的复合身份隔离**:各自独立 miss / recover / 重启,断言**互不 suppress、互不误判恢复、互不清除对方 latch**。
  ⚠️ 必须写成**分类器 / 聚合 / latch 层的 synthetic 测试,并在注释里写明它刻意绕过了生产 config 边界** —— 因为跨 project 复用 `leadId` 在生产配置层是 **fail-loud 拒绝**的(`lead-identity.ts:403-416` 抛 `identity_bare_id_collision`;`ProjectConfig.test.ts:80-94` 锁定了这个拒绝)。**不得为本单放宽这条全局 Lead identity 不变量**。复合身份因此是 **defense-in-depth**,不是在支持一个合法配置。
- **真实 ticket 路径的重启去重**(Codex R10 指定的用例,必须打在真路径上,**不得**拿 `lead_events` 当证明):
  1. 首次以 episode 正文 enqueue;
  2. 同 episode 再发生 miss;
  3. 重建 reconciler / runtime 模拟重启;
  4. 断言**无第二行**、**不抛 `mailbox identity conflict`**、latch 恢复;
  5. 断言 `lead_events` **不**参与这个证明。
- **正文不可变**:同一 episode 两次构造告警,断言 projection **逐字节相同**(计数不得出现在正文里)。
- kind 契约缺失 → 启动期校验抛错(直接跑现有 `validateKindContracts` 测试)。

---

### Chunk 5 — 接线 + 可观测

- `GatePoller` 增加 `onFounderIngressReconcileTick` rider,`% 20` ≈ 60 秒(research §10.1)。**不得新建 `setInterval`**(FLY-169/172 房规)。
- `plugin.ts` 构造回调、注入 store / fetch / 告警 sink。
- 顺手把 `founder-reply-deliverer.ts:432` 与 `CodexDiscordMailboxStrategy.ts:72` 丢弃的 `claimDiscordLane` 返回值**记录下来**(至少 `archived` 分支要可见)。这是零风险的纯增可观测,且是本单检测赖以成立的同一个信号。

**测试**:rider 注册与节奏(照现有 rider 的测试写法);tick 抛错不影响主循环。

---

## 4. 上线与回滚

- **kill-switch**:`FLYWHEEL_FOUNDER_INGRESS_RECONCILE=0` 关闭整块(照 `sensorOn` 惯例,**缺省 ON**)。关掉后系统回到当前行为,不残留半开状态。
- **回滚边界**:Chunk 1(envelope 字段)向后兼容、可单独留下;Chunk 2-5 由同一个 kill-switch 覆盖。
- **新增的读取面**(Codex R7 更正我此前「只有 StateStore 只读方法」的说法):
  - `StateStore.listActiveChatThreads()` —— 只读;
  - **CommDB / MailboxQueue 侧的 provenance 聚合** —— 只读(§4b-final)。
- **默认无迁移**:不改任何表结构(`chat_threads` / `phase_chat_threads` / `mailbox` 全部只读或走既有写入路径)。
  ⚠️ **但 query-plan 门是一个真正的决策点**:当前 schema **没有** `(to_agent, created_at)` 索引(`mailbox-schema.ts:125`)。实施时先实测 query plan ——
  **通过** → 按本计划零迁移交付;
  **不通过** → **停下来修订计划并报 Lead**,由他决定是在本单加索引迁移(那就要连带回滚测试),还是改用别的收敛方式。**不得**由实施者自行决定加迁移。
- **首轮上线的已知一次性行为**:每个目标做一次有界回看 bootstrap(缺省 30 分钟)。窗内已投递的消息撞 `active_inbox` 无副作用;**真正漏投的会被补上**——这是期望行为。
  首轮补投**不做特殊抑制**(§4c):它们照常成为证据,再由「miss 之后是否存在更新的 `plugin` provenance」把历史补投判为已恢复。这样既不会因上线噪声误报,也不会让一个真在失聪的插件因首轮抑制而永远不告警。

---

## 5. 验收(对 issue 的验收方向逐条回应)

| issue 要求 | 本单如何满足 | 证据 |
|---|---|---|
| 定位 A、B 两病灶各自的丢弃点 | **已完成**,且证伪了「两病灶」:单真因 = 插件 inbound 失聪(00:47:32Z),2216 出生晚 82 秒 | exploration §1-2;正向控制 §6.1 |
| 修复后:任一注册 issue thread + 任一 allowlisted 顶层的 founder 消息必达 mailbox | Chunk 2(覆盖面)+ Chunk 3(对账补投) | G1/G2 测试 |
| 僵尸插件进程的产生与清理机制 | **本单不做,且不假装做了**。取证窗口已关闭(两个进程在取证中退出);1485 经核**不同 bot 身份**,双连互踢不成立;86404 未证实。无证据支撑的机制改动会是凭空猜测 | exploration §6 |
| 回归:message-attached thread 与独立 thread 两种建法都可投递 | 该假设**已被证伪**——锚消息差异只是新建/复用两条文案分支(`ChatThreadCreator.ts:366` vs `:1455`),与投递路径无关。回归改为覆盖面维度:三类目标(顶层 / `chat_threads` / `phase_chat_threads`)都必须可投递 | Chunk 2 测试 |

---

## 6. 风险与已做的取舍

| 风险 | 处置 |
|---|---|
| 兜底投递插件**有意丢弃**的消息(行为扩面 + 假失聪证据) | §2a 策略门:只覆盖 `requireMention === false` 且策略可读的目标;策略读不到一律 fail-closed 跳过。实测 15/16 为 false,1 个无 access 文件被跳过 |
| 兜底抢跑插件造成载荷分歧 | grace 只是把抢跑变稀有(`INGEST_RETRY_MAX_MS` 是间隔上限**不是**总期限,插件会无限重试)。真正的防线是**载荷等价**:除 `ingressPath` 外与主路逐字段对齐,抢跑也无可观察差异。行为性分歧(`replyRoute`)只存在于 roundtable 频道,而它不在覆盖集内 |
| 把自己的补投误判成插件健康 | 恢复判据读赢家行 provenance,只认 `plugin`;`legacy_unknown` 不算健康 |
| 告警发不出去时证据被永久跨过 | 失聪判据是 **lead 级聚合**(§4b-final),每轮从 mailbox 重算,天然重试;不需要 pin、不需要按 ID 回查,因此不受 Discord 侧删除影响 |
| 一条卡住的告警阻塞后续投递 | cursor **永不 pin**,投递单调,由构造保证 |

| 新消息不断导致旧消息永久饥饿 | oldest-first 排序 + 前向分页 + 单目标消息预算 |
| 两轮扫描重叠 / cursor 互相覆盖 | single-flight 锁;cursor 共用同一 store 实例、独立 key 命名空间 |
| 顶层消息被误解释成 ship 批准 | 硬边界:对账器不 import 任何门解释符号 + 专门的回归测试 |
| 上线当天每个目标漏一批消息 | bootstrap 有界回看,不跳 HEAD |
| 告警风暴 | episode latch(**唯一**的防线)。⚠️ 现有 `alert-rate-limiter` 在被 ticket 路由**绕过**的 unified-channel notifier 上,**不覆盖**本单所选路径 —— 不可依赖它 |
| Bridge 重启后重复开 episode | 重算出同一 `eventId` → Claw mailbox 的 `infra_alert:<owner>:<kind>:<eventId>` delivery identity 良性去重。**前提是正文不可变**,否则是 `mailbox identity conflict` 而不是去重(**既不用** `getActiveAlertThread`,**也不是** `lead_events`) |
| 扫描打到 Discord 限流 | 每轮预算 + 轮转 + cursor 命中时 `limit=1` 廉价探测 |
| 检测器成为死代码而测试全绿 | 强制错形状对照组:必须有「插件漏投」的用例断言 `inserted_inbox` 被计数 |
| 兜底本身也挂了 | 诚实边界:**本单不解决**。兜底与主路都在 Bridge 进程内;真正独立的第三条腿(如 `bridge-liveness-probe.sh` 那种跨进程 launchd 探针)是另一单的形状 |

---

## 7. 诚实边界

- 插件 **为什么** inbound 单向死亡,本次仍**未归因**。本单是「不依赖病因的防线」:察觉 + 补投 + 告警。真正的治本在拆出去的插件侧自愈单。
- 本单的兜底与被兜底的对象**同在 Bridge 进程内**。Bridge 整体挂掉时这条腿也没了——那由既有的 `bridge-liveness-probe.sh`(launchd,跨进程,且刻意放在 Codex bot 域内)覆盖,不在本单。
- 僵尸插件进程一条**未完成**,理由见 §5,不伪装成已解决。

- 🔴 **一个已知的、目前无人覆盖的边界**(Codex R7 逼出来的,不藏):
  **「Bridge 健康,但告警 sink 连续 > `EVIDENCE_WINDOW_MS`(24 小时)不耐久受理」** 这个形状下,失聪证据会被聚合窗口淘汰,告警永久消失。
  - 它**不属于** FLY-2062(那是 shell 路径 `no-token` 死信,另一条链路);
  - 它**也不被** `bridge-liveness-probe.sh` 覆盖(那探的是 Bridge `/health`,而此时 Bridge 是健康的)。
  - 我曾在计划里把它归给这两者,**那是错的,已撤回**。
  本单**选择接受**这个边界(见 G3 的限定条件),而不是为它保留超窗证据 —— 后者会把刚删掉的那套机制加回来。若 Lead 认为该边界不可接受,正确的动作是**另开一单**做「告警链路自身的耐久性」,而不是在本单加机制。
