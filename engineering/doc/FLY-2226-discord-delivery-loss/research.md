# FLY-2226 founder Discord 消息选择性丢投 — 调研

Issue: FLY-2226 (https://linear.app/geoforge3d/issue/FLY-2226/通信投递丢失-founder-discord-消息选择性丢投2216-thread-从出生就聋-engineer-顶层-0325z)
日期: 2026-09-01
基于: exploration.md

---

## 0. 本文回答什么

exploration.md 定了「是什么坏了」。本文定「能怎么修」,并把每一个设计取舍钉在实测事实上。

Lead 已裁决(2026-09-01):
- **Q1**:本单交付 **B**(flywheel 本仓的失聪检测 + 告警 + 兜底扩面);插件侧自愈(**A**)拆独立后续单。
- **Q2**:批准扩面到「顶层 allowlisted 频道 + 所有注册 issue thread」,并**追加硬约束**:兜底投递的行必须带来源标记,让未来审计能区分主路/兜底。

---

## 1. 决定设计形状的六个实测事实

| # | 事实 | 出处 | 对设计的约束 |
|---|---|---|---|
| F1 | 入站天然有**数小时静默期**(8-31 08h→14h 空 5 小时) | `comm.db` 按小时计数 | **「N 分钟无入站即告警」不可用**,founder 睡觉时会持续误报。检测必须是**对账**,不是静默检测 |
| F2 | `deliveryId = chat:<leadId>:<messageId>` **完全确定** | `chat-delivery-envelope.ts:54-56` | 两个写入者对同一条消息产出**同一个键**,天然可去重 |
| F3 | 重复 ingest **安全且静默**:返回 `active_inbox`,不抛错、不写第二行、不产生第二次 Lead 唤醒;跨进程由 `BEGIN IMMEDIATE` + `busy_timeout=5000` 串行化 | `mailbox-queue.ts:599-644`;测试 `discord-chat-ingest.test.ts:42-101` | Lead 的「不得产生第二次唤醒」**底座已经满足**,不需要新机制 |
| F4 | 但 `claimDiscordLane` **从不比较内容** —— 先到者赢下整个载荷,后到者被静默丢弃 | `mailbox-queue.ts:611-620`(`enqueue` 的投影哈希冲突检查在这条分支上**不可达**) | **真正的危险不是重复,是载荷分歧**。见 §2 |
| F5 | 插件 ingest 重试上限 **5 分钟**(`INGEST_RETRY_MAX_MS`),它自己也在 5 分钟处记 stall | 插件 `chat-receipt-runtime.ts:68-70` | grace 窗口的**有原则取值** = 5 分钟。低于它就会和「正在正常重试的插件」抢跑 |
| F6 | 活跃 `chat_threads` 只有 **58** 行(总 1166,注册表按 `archived_at`/`discord_missing_at` 自剪枝) | `teamlead.db` | 注册表驱动的扫描**成本可控**,不需要新的剪枝机制 |

---

## 2. 核心危险:先到者赢的载荷分歧(F4)

两个写入者对**同一条消息**产出的 envelope 并不相同:

| 字段 | 插件 | Bridge |
|---|---|---|
| `chatId` / `originChannelId` | `msg.channelId`,且 roundtable 路由会**改写成 topic thread** | `ctx.threadId` |
| `authorName` | `msg.author.username` | `global_name ?? username ?? id` |
| `msgKind` | `roundtable` 或 `guild` | 恒 `guild` |
| `attachments` | 真实附件列表 | 真实附件列表 |
| `replyRoute` | roundtable 时**携带** | **从不设置** |

`from_agent` 还是 batch 分组键(`mailbox-queue.ts:1245`),会出现在 Lead 可见的 batch 头。

**后果**:如果兜底路径在健康期抢先写入了一条本该由插件写的消息,Lead 的回复可能**路由到错的地方**(丢掉 `replyRoute` → 回复落在父频道而不是 topic thread)。这是一个真实的行为回归风险,不是理论洁癖。

**解法 = grace 窗口(而不是加锁或比较内容)**:兜底只处理「Discord 侧已存在、且**已超过 grace 仍未进 mailbox**」的消息。健康期插件 ~1 秒就写完了,兜底永远碰不到它;只有插件确实失灵时兜底才动手。**抢跑窗口被彻底消除,而不是被缩小。**

grace 取 **5 分钟**,理由是 F5:这是插件自己的重试上限,也是它自认 stall 的时刻。取更小的值会和「正在正常重试的插件」抢跑。代价是兜底路径最坏可见延迟 ~5-6 分钟 —— 对照本次事故的 **3 小时**,是 30 倍以上的改善,且这个数字是从对侧写入者的重试上限推导出来的,不是拍脑袋。

---

## 3. 检测层:对账,而不是静默检测

F1 排除了静默检测。可行的检测有三种,取第三种:

| 方案 | 做法 | 判决 |
|---|---|---|
| 静默检测 | N 分钟无入站即告警 | **否决**。F1:天然静默数小时,必然误报 |
| 合成探针(canary) | 定期往某频道发消息,验证它是否进了 mailbox | **否决**。要么污染 founder 可见频道,要么需要专用频道 + 改插件 access.json;而且是纯增的噪声与新失败面 |
| **对账(选用)** | 拉取 Discord 侧确实存在的 founder 消息,与 mailbox 该有的行比对,缺了才判失聪 | **选用**。见下 |

对账方案的三个决定性优点:

1. **零误报**。founder 不说话时无可比对,天然静默 —— 不需要任何"营业时间""节假日"之类的启发式。
2. **检测与恢复是同一个机制**。发现缺失的那一刻就把它补投了,不是先告警再等人来救。
3. **信号是现成的,而且现在被所有人丢弃**。`claimDiscordLane` 的返回值就是判据:
   - `active_inbox` → 插件已经拿到了 → 健康,不计数
   - `inserted_inbox` → **插件漏了这一条** → 既是一次丢失恢复,也是一个失聪数据点
   - `archived` → 身份已归档,静默丢弃(目前**两个调用方都忽略返回值**,完全不可见)

   目前 `founder-reply-deliverer.ts:432` 与 `CodexDiscordMailboxStrategy.ts:72` 都**丢弃**这个返回值。把它捡起来,检测器就有了判据,不需要发明任何新的状态存储。

告警阈值按「单位时间内 `inserted_inbox` 计数」而不是「连续次数」,因为 founder 可能只发一条就走开 —— 一条本该由插件投递却由兜底补上的消息,已经是插件失灵的确证。

---

## 4. 覆盖面:扩到哪里,以及为什么不再多

现状与目标:

```
                       顶层频道   有 session 的 thread   无 session 的 thread   DM
插件(主路)               ✅            ✅                    ✅              ✅
Bridge 兜底(现状)         ❌            ✅                    ❌              ❌
Bridge 兜底(本单目标)      ✅            ✅                    ✅              ❌
```

- **顶层 allowlisted 频道**:本次 3 条丢失在这里,且它对插件是 **100% 单点依赖**,没有任何第二条腿。必须覆盖。
- **所有注册 issue thread**(而非仅有 session 的):2216 的 thread 从 `00:48:55` 就在 `chat_threads` 里(`archived_at` 为空),注册表驱动本可从它出生起覆盖它。这正是本次另外 3 条丢失的成因。活跃行只有 58(F6),成本可控。
- **`phase_chat_threads` 侧表也要覆盖**:DAG workflow issue 的 Design/Implement/QA 阶段 thread 存在这张**独立的侧表**(`StateStore.ts:3736-3760`)。只扫 `chat_threads` 会留下一个新的盲区 —— 这类 issue 恰恰是 founder 最常追问的。
- **DM 明确不在本单范围**,理由有据而非省略:(a) Bridge 侧**没有任何 DM 频道注册表**可枚举;(b) `flywheel-eng-lead` 的历史 DM 消息数为 **0**。若将来 founder 开始用 DM,需要先建注册表,那是独立的一单。

---

## 5. 不能复用 `emitFounderReplyDeliveryForThread`(硬边界)

那个函数**不止 ingest**。它还把 founder 回复解释成门答复:`approve_to_ship`(ship 批准!)、`founder_review`、decision convergence、voided card input(`founder-reply-deliverer.ts:616-660`)。

**若把它的扫描面直接扩到顶层频道,founder 在顶层随口一句「好」就可能被匹配成 ship 批准。** 这是一个安全级别的回归,不是风格问题。

所以兜底扩面必须走**独立的、只做 ingest 的路径**,不携带任何门解释语义。结构上这是可分的:现有代码本来就是「先 ingest 每一条 founder 消息(`:432`),之后才做门匹配(`:466+`)」,新对账器等于只保留前半段。

---

## 6. 一个照抄就会踩的坑:cursor bootstrap 跳 HEAD

现有 cursor 首次 bootstrap 会**直接跳到 thread 当前 HEAD 并返回 `noop`**(`founder-reply-deliverer.ts:305-339`)。

对它原本的用途(不要重放历史)这是对的。但对本单的**投递保证**是致命的:一个 thread 首次进入扫描集时会**静默放弃此前所有消息** —— 恰好在「开始覆盖」的那一刻留下一个永久空洞。上线当天所有已存在的活跃 thread 都会各留一个洞。

新对账器的 bootstrap 必须改成**有界回看**:取 `max(thread 创建时刻, now − 回看上限)`,而不是跳 HEAD。回看上限用于防止 1166 行历史被重放;由于 §2 的 grace + §F3 的去重,回看重叠部分是安全的(已投递的会返回 `active_inbox`,不会重复唤醒)。

---

## 7. 来源标记(Lead 的追加约束)如何零插件改动实现

关键发现:**插件的写入路径跑的就是本仓的代码** —— 它 spawn 的是 `node <flywheel-comm CLI> chat-ingest`(插件 `chat-receipt-runtime.ts:267-275`)。Bridge 则在进程内调 `db.ingestDiscordChat(...)`。两个入口,同一个核心函数。

`normalizeChatDeliveryEnvelope`(`chat-delivery-envelope.ts:58+`)是**白名单重建式**的:它只从已知字段构造输出,未知字段被静默丢弃而**不是报错**。所以加一个可选字段是安全的、向后兼容的,代价是要在类型、normalizer、encoder 三处显式加上。

方案:envelope 增加可选 `ingressPath`,取值 `plugin | bridge_reconcile`。
- CLI 入口(插件走的那条)**缺省为 `plugin`** —— 老插件不传这个 flag,自动落到缺省值,**零插件改动**。
- Bridge 对账器显式写 `bridge_reconcile`。

这满足 Lead 的要求(审计能区分主路/兜底),并且把本次诊断赖以成立的判别能力**从"靠 authorName 的巧合"升级成"显式契约"** —— 现在这个判别器是我在两条路径取不同字段时侥幸得到的,不该继续依赖它。

---

## 8. 现存检测为什么全部没响(负空间清单)

| 机制 | 为什么没响 |
|---|---|
| 插件 gateway handler | 只注册了 `error`/`interactionCreate`/`messageCreate`/`ready`。无 `shardDisconnect`/`invalidated`/`shardResume`,静默死掉的 WebSocket 完全无声 |
| 插件 stderr | MCP 日志(`mcp-logs-plugin-discord-discord/*.jsonl`)只记录工具调用与返回,**不透传 server 进程 stderr**。就算插件写了 gateway 报错也没地方能读到 |
| `scripts/audit-discord-mailbox-ingest.sh` | 只查**已到达行的形状**(carrier / delivery_id 自洽 / 重复 / 死信)。零到达时每一项都是 0,**全绿**。且是手动脚本,无任何调度 |
| `claimDiscordLane` 的 `archived` 分支 | 静默丢弃,两个调用方都忽略返回值,完全不可见 |

这一族的共同形状:**所有现存检测量的都是「坏消息的形状」,没有一个量「好消息的缺席」。**

---

## 9. 验证策略要点

- **对账器的核心断言必须配错形状对照组**:只喂「插件已投递」的输入,`active_inbox` 分支恒真,检测器可以是死代码而测试全绿。必须同时喂「插件漏投」的输入,断言 `inserted_inbox` 被计数并触发告警。
- **载荷分歧要有显式测试**:同一条消息先后由两个写入者以**不同 envelope** ingest,断言「先到者赢、后到者静默丢弃、不抛错」。§F4 指出这个行为目前**没有任何测试覆盖**,而本单正是要依赖它。
- **grace 边界测试**:恰好在 grace 内的消息**不得**被兜底碰;恰好超过的必须被兜底补投。
- **bootstrap 回看测试**:一个已有历史消息的 thread 首次进入扫描集,断言它**不会**跳 HEAD 丢掉待投递消息。
- **顶层频道不得触发门解释**:在顶层发一条形如 ship 批准的消息,断言它只被 ingest、**不**匹配任何 `approve_to_ship` 门。这是 §5 的回归护栏。
- 现有 alert 测试族(`alert-rate-limiter` / `alert-duty-router` / `alert-threads-tickets` 等)是新告警的接线参照。

---

## 10. 接线点(全部复用现有基础设施,不新建任何东西)

### 10.1 周期性 tick:挂 `GatePoller`,**不得**新建 `setInterval`

`GatePoller` 生产 tick = **3000 ms**(`plugin.ts:8689`),patrol 类以 `% 20` ≈ 60 秒的节奏搭车。房规明写「zero new periodic timers」(FLY-169/172 纪律)。现有 riders 有 14 个,注册形状固定:

```ts
if (this.config.onXTick && (this.tickCount - 1) % this.xEveryNTicks() === 0) {
  void Promise.resolve()
    .then(() => this.withSpan("gate-poller.x", () => this.config.onXTick?.()))
    .catch(err => console.warn(`[GatePoller] x error (non-fatal): ${err.message}`));
}
```

`(tickCount - 1) % n === 0` 是刻意的(让 tick 1 就触发,且 `n=1` 也成立)。60 秒节奏对本单足够:grace 是 5 分钟,兜底在 grace 之后的第一个 tick 补投即可。

**每轮要有预算上限**:58 个活跃 thread + 1 个顶层频道 ≈ 59 次 Discord GET。现有代码在 cursor 命中时走 `limit=1` 廉价探测,但仍应设每轮上限并轮转,避免突发打到限流。

### 10.2 告警发射:走 `routedAlertSinkHolder`

标准写法(全仓一致):

```ts
await (routedAlertSinkHolder.current ?? leadAlertNotifier).alert({
  leadId, projectName, eventId: `<kind>:<stable-episode-key>`,
  eventType: "<kind>", title, body, severity: "severe",
});
```

新增一个 alert kind 要动 **7 处**,其中 `bridge/kind-contract.ts` 的 `KIND_CONTRACTS` 是**编译期强制 + 启动期 `validateKindContracts()` 抛错**的,漏了 Bridge 直接起不来:

1. `LeadAlertNotifier.ts:70` `ALERT_EVENT_TYPES`
2. `bridge/kind-contract.ts:306` `KIND_CONTRACTS` ← 编译+启动双重强制
3. `bridge/infra-event-router.ts` `TICKET_KINDS` 或 `ISSUE_PROGRESS_KINDS`
4. `bridge/alert-kind-copy.ts` 展示文案
5. `scripts/lead-alert.sh:200` shell 允许表
6. `doc/oncall/contact-book.md` on-call 归属行
7. `bridge/AlertChannelHub.ts:305`(若属 informational/lifecycle)

> ⚠️ 记忆里的教训:**新枚举值被顺手塞进旧白名单**是高危动作;第 3 项要论证归 `TICKET_KINDS` 还是 `ISSUE_PROGRESS_KINDS`,不能凭手感塞。

### 10.3 防抖:抄 `CmuxWatcherPatrol` + `FleetSensors` 的两段式

- **纯分类器**:`classifyX(snapshot, thresholds) → { branch, alert, episodeKey, detail }`(模板 `cmux-watcher-patrol.ts:135`)。宿主读取注入,逻辑可单测。
- **episode latch**:内存 `Map<branch, episodeKey>`,只在 `isDurablyHandled(result)` 为真之后才置位(`fleet-sensors.ts:119`;`sent || queued || deadLettered || skipped==="duplicate"`)。
- **重启重新 latch**:置内存 latch 前先查**持久**的 `store.getActiveAlertThread(correlationKey)`,否则 Bridge 一重启就会重开一个重复 episode(`fleet-sensors.ts:566-572`)。
- **恢复边**:失聪→恢复的那一刻清 latch 并静默 resolve 工单(`fleet-sensors.ts:591-597`)。

### 10.4 顶层频道 id 从哪来

`ProjectConfig.ts:15` `LeadConfig.chatChannel: string` —— **必填,启动期校验非空否则抛错**(`:468-475`)。这正是本单要覆盖的顶层频道,无需新增配置。

> 注意区分:`#flywheel-alerts` **不是** chatChannel,它是 `FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID`(`plugin.ts:9203`)。

### 10.5 与 FLY-2062 的关系(核实后收窄)

仓内**没有** FLY-2062 的代码、文档或 commit;它只作为 FLY-2075 调查中的**交叉引用**存在,且被 FLY-2075 明确划到范围外。它管的是 **shell 路径**(`scripts/lead-alert.sh`)在 Bridge 进程**之外**发射、以 `queueReason: "no-token"` 死信的那一类告警断供(`no-token` 属 `PERMANENT_QUEUE_REASONS`,60 秒 drain 永不重试)。

**与本单不是同一条链路**:本单的失聪发生在 Bridge 进程内的入站面,告警发射走的是 `routedAlertSinkHolder`。相关但不重叠,本单不修 FLY-2062。

---

## 12. 明确不做

- **不做** FLY-2222(delivered ≠ actionable,投了但没看见)。本单只保证「必达 mailbox」。
- **不做**插件侧 gateway 自愈(Lead 已拆独立后续单)。
- **不做** DM 覆盖(§4,有据排除)。
- **不改**插件仓一行代码。§7 的方案保证了这一点。

---

---

# 附:范围变更后的插件侧调研(2026-09-01 05:03 之后)

> founder 拍板砍掉对账层(B),本单改做**插件侧自愈**(A)。§1-§12 中与对账器相关的部分**仅作历史留档**;
> 下面这一节是新范围的技术底座。全部结论来自**装机字节**(`~/.claude/plugins/cache/flywheel-plugins/discord/0.0.5/`),不是文档。

## A1. 版本与真实表面(核实过,不是查文档得来的)

| 项 | 值 |
|---|---|
| `discord.js` | **14.25.1**(`package.json` 声明 `^14.14.0`) |
| `@discordjs/ws` | **1.2.3** |
| 插件已注册的 client 事件 | 只有 **4 个**:`error` / `interactionCreate` / `messageCreate` / `ready`(`server.ts:1414/1421/1479/1667`) |

`WebSocketManager` 确实会 emit 这些事件(装机字节 `discord.js/src/client/websocket/WebSocketManager.js`):

| 事件 | 发射处 |
|---|---|
| `ShardDisconnect` | `:257` |
| `ShardReconnecting` | `:268` |
| `ShardError` | `:304` |
| `ShardReady` | `:196` |

可读状态:`WebSocketManager.status`(`:95`)、`WebSocketManager.ping`(getter `:117`);`WebSocketShard.status` / `.ping` / `.lastPingTimestamp`(`:35/48/54`)。

⇒ **不是库不报,是插件没接**。Node 的 EventEmitter 对**没有监听者**的非 `error` 事件是**静默丢弃**的 —— 这就是「gateway 死了而全世界无声」的机制层解释。

## A2. 🔴 库里**已经有**心跳僵尸检测 —— 不要重复实现

`@discordjs/ws/dist/index.js:905-907`:

```js
if (!this.isAck && !requested) {
  return this.destroy({ reason: "Zombie connection", recover: 1 /* Resume */ });
}
```

- 心跳间隔由 Hello 下发并起 `setInterval`(`:1051`);
- `HeartbeatAck` 到达时置 `isAck = true`(`:1054-1055`);
- 下一次要发心跳时若上一次**没被 ACK**,直接销毁并按 **Resume** 恢复;
- 另有 `helloTimeout: 60000`(`:555`)与 initial-heartbeat 超时控制器(`:1041-1047`)。

**结论:指令里「协议层心跳监听,断了即重连」这一条,库已经在做。** 照字面再实现一遍,就是在已有机制上叠机制 —— 与本单刚刚学到的教训同形。**本设计不做它。**

## A3. 🔴 由 A2 推出的关键问题:A 方案可能抓不到本次故障

已知事实(全部有据):

| 事实 | 来源 |
|---|---|
| 进程活着 | `ps`,pid 23059 全程 |
| 事件循环没卡 | MCP 工具调用全程正常响应(有日志) |
| REST 出站正常 | Tadashi 03:47 / 03:52 成功发言;REST **不走 gateway** |
| 入站 3.5 小时零事件 | mailbox `authorName` 判别器 + spool mtime 冻结 |
| 重连即愈 | 04:16:48 重启 → 04:17:58 恢复 |

事件循环活着 ⇒ 心跳定时器会照常触发。若心跳也照常被 ACK,则:

- 库的 zombie 检测**不触发**(`isAck` 一直是 true);
- `shardDisconnect` / `invalidated` / `shardResume` **一个都不会发生**(协议上没有断开);
- 连接只是**停止派发 `MESSAGE_CREATE`**。

**这种形态下,「生命周期 handler + 心跳监听」两件套都抓不到。**

**我没有直接证据判定是哪一种形态** —— 插件 stderr 全链路不落盘(§8 记过的洞),所以无法回看当时有没有 zombie destroy 发生。**不假装能归因。**
设计因此必须覆盖**两类**故障,而不是押注其中一类。

## A4. 能真正测到「入站派发」的信号:自回声

gateway 会把**插件自己发出的消息**作为 `MESSAGE_CREATE` 回送。插件现在把这条回声**直接丢弃**:

```js
// server.ts:1481
if (msg.author.id === client.user?.id) return
```

这正是「一个已经在流动、却被丢掉的信号」—— 与本单前一阶段发现 `claimDiscordLane` 返回值被丢弃是同一个形状。

它的判别力恰好对准坏掉的那个能力:**它测的是入站派发本身,不是心跳,也不是 REST**。
用本次事故回放:03:47 / 03:52 两次出站若配了回声超时,**03:47 就会自愈**,而不是等到 04:16 人肉重启。

**已知边界(写进文档,不藏)**:插件自己完全不说话时没有回声可验。但危险闭环恰恰是「她说了 → 它没听见 → 于是它也不说话」,该闭环里只要任何路径让它开过一次口,探针就会触发。

## A5. 舰队证据(复核了 Lead 给的输入,部分证伪)

我复跑了全舰 `chat-receipt-spool/ingest` 的 mtime。**多数 lead 已变成 08-31 21:57:2x** —— 应是 founder 那次全舰自检产生的流量,所以「冻在 08-24 / 08-26」名单里有一部分已被证伪为「当时只是没流量」。

复核后仍可疑的:

| lead | ingest mtime |
|---|---|
| `tidal-echo-cos-lead` | 2026-08-28T17:05 |
| `belle-lead` | 2026-08-29T18:48 |
| `product-lead`(Peter) | 2026-08-31T13:00(= 20:00Z,与 Lead 给的数字吻合) |

⚠️ **但这三条都不能据此判定「聋」** —— `spool mtime` **分不出「聋了」和「没人说话」**(两种状态同一个痕迹)。这正是零检测的病本身。

**这条对设计的意义**:自回声探针(A4)不依赖对方说话、只依赖自己说话,因此**对安静 lead 也有判别力**;而心跳类方案对这三条同样无判别力。

## A6. 交付纪律:插件源在外部仓

| 项 | 位置 |
|---|---|
| 插件源真身 | `xrliAnnie/claude-plugins-official` 的 `external_plugins/discord`(marketplace manifest `git-subdir`,ref `main`) |
| 运行时字节 | `~/.claude/plugins/cache/flywheel-plugins/discord/0.0.5/` |
| flywheel 侧工具 | `scripts/discord-plugin/`(`update-` / `cutover-` / `check-`,FLY-1676 起带 fleet 级串行锁) |

⇒ 代码改动落在**外部仓 PR**(需 founder 授权 merge);flywheel 侧登记 `__main__` 锚 PR(指针 / 文档)。
