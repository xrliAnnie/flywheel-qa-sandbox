# FLY-1574 Discord 收编 mailbox — 独立 QA 报告(第 2 轮 · 复测)

Issue: FLY-1574 (https://linear.app/geoforge3d/issue/FLY-1574/消息层重构-e-批次2-discord-收编不再直推统一走-mailbox)
日期: 2026-08-10
基于: qa-report.md(第 1 轮 FAIL)+ plan.md(R9)

**验证 head**: 主仓 `ba16b8dadd7ffb1793108f46fb5395a3ee967902`(PR #797)
**companion**: 插件仓 PR #18 head `5bf4045ef2db307a03f676f246294a5e30cbc15b`(实测用的就是这个 head)

## 裁定:**FAIL**(范围比第 1 轮窄得多)

**第 1 轮的 4 条阻断 + 2 条中等 —— 全部真修好了,我逐条复现验过。**
新发现 **1 条阻断**:两个 companion PR 在 route 契约上没对齐,导致跨频道消息被并进同一个投递批次。

---

## 一、第 1 轮问题复验:6/6 关闭

### B1 founder 原话转义 → **关闭(实测逐字一致)**

改法是对的:`escapeXmlText()` 正文只中和 `<`(唯一能伪造 `</channel>` 的字符),
属性仍走完整 `escapeXml`。跑同一组真实句式,输出**与输入逐字相同**:

| founder 打的 | 第1轮 | 现在 |
| -- | -- | -- |
| `doesn't work.` | `doesn&apos;t work.` | `doesn't work.` ✅ |
| `说明 "为什么" &` | `&quot;为什么&quot; &amp;` | `说明 "为什么" &` ✅ |

`source` 也改回生产真形态 `plugin:discord:discord`。

**注入防线仍在**(我另跑了对抗组):伪造 `</channel>` / `<channel>` / `<attachment>` /
`< /channel>` 四种在正文里都无法成为结构;`authorName` 打 `" receipt_id="` breakout 后
整块仍只有 1 个 `receipt_id`。

**接受的残留(非缺陷)**:正文里的字面 `<` 仍会变 `&lt;`(如 `echo a<b>c`)。
这是不可能两全的取舍 —— 要挡 `</channel>` 伪造就必须中和 `<`。相比第 1 轮把撇号/引号/`&`
一起腌了,影响面已经从「几乎每条消息」缩到「正文含字面 `<`」。**明确记为已知项,不是遗留缺陷。**

### B2 静默无限重试 + 告警没接线 → **关闭(行为级验证)**

不是读代码下的结论。我拿**真 SQLite 库 + 真 ingest 行 + 真 `LeadInboxLoop`** 装了三种故障:

| 场景 | 结果 |
| -- | -- |
| S1 服务端明确拒绝(毒行) | 第 5 次耗尽 → **先发 undeliverable 告警** → 才 `DEAD`(第1轮:无限重试且零告警) |
| S2 传输中断(socket 挂) | 行**不** DEAD、`TRANSPORT_STALL_ALERT` 发出(不误判死信,也不静默) |
| S3 毒行 + 告警槽也挂了 | 行**不**静默 DEAD,退避后持续重试并重发告警 |

告警链路也真接上了:`plugin.ts` → `LeadInboxRuntime` → `LeadInboxLoop` → `leadAlertNotifier.alert()`。
`onDiscordUndeliverable` 在投递不成时抛错,是「先告警、后 DEAD」这个顺序能被强制的原因 —— 设计得好。

### B3 priority 倒转会话顺序 → **关闭**。两处都是 `priority: 1`,真机实测 `priority=1`。
### B4 archived 静默吞消息 → **关闭**。`beginChatReceipt` 恢复硬抛。
   (ON 路径的 `archived` 仍静默跳过,这个是对的 —— 该 message id 本来就已投递并归档,是幂等 no-op,不是丢消息。)
### M1 审计脚本不卡 DEAD → **关闭**,`dead_rows` 已进退出判据,shell 测试 3/3。
### M2 `source` 漂移 → **关闭**(见 B1)。

**测试也修了,不是空过绿测**:测试断言换成了我上一轮报告里的原句,现在锁的是「逐字」和 `priority: 1`。

---

## 二、新发现(阻断):两个 companion PR 的 route 契约没对齐

### 现象(FLY-529 隔离房真机 E2E)

真发一条 `#test-leads-roundtable` 消息 + 一条 slot-2 频道消息,两条被**并进同一个投递批次**,
批次级 `replyChannelId=null`。plan §3.1 Q10 明确要求「不同 channel/thread 必分批」。

### 定位:主仓做了,插件没送

主仓 CLI **支持** route 参数(`packages/flywheel-comm/src/index.ts:851-852`):

```
"reply-channel-id": { type: "string" },
"reply-route-json": { type: "string" },
```

插件 PR #18 的 `ingestFlags()`(`chat-receipt-runtime.ts:1001`)是喂给 `chat-ingest` 的
**唯一**参数来源 —— 它 `--lead / --chat-id / --origin-channel-id / --message-id / --author-id /
--author-name / --ts / --msg-kind / --attachments-json / --content-stdin / --json` 全有,
**唯独没有这两个 route 参数**。于是 route 永远是 null。

而 `discordBatchPartitionKey()` 的分区键**只**由 `replyChannelId` + `replyRoute` 派生
(`discord-chat-ingest.ts:110-115`,不看 `chatId`)→ 两者恒为 null → 一个 Lead 名下**所有**
频道的 Discord 行塌成同一个分区。

### 阳性对照(证明尺子是好的,是插件没用它)

同一个 CLI、同一个库,只差有没有带参数:

```
A роundtable  插件今天的调法(无 route 参数): discord-route:e2ddbc00c0b8…
B slot-2 DM   插件今天的调法(无 route 参数): discord-route:e2ddbc00c0b8…   ← 与 A 相同
C roundtable  带 --reply-channel-id           : discord-route:b42ce6f25d08…   ← 正确分开
```

投递侧对照:

```
batch kind=discord_chat members=2 replyChannelId=null
   同一个批次里的 chat_id: 1519417773304975450(roundtable) , 1493080993173737583(slot-2)
batch kind=discord_chat members=1 replyChannelId=1519417773304975450   ← 阳性对照,正确隔离
```

### 影响范围(据实收窄,不夸大)

- **Codex Lead 路径不受影响** —— `CodexDiscordMailboxStrategy` 自己把 `replyChannelId`/`replyRoute`
  传下去了(`:71-74, :109-112`),route 保真。
- **受影响的是 Claude Lead 路径**(插件 ingest),而 Tadashi / Aunt Cass / Peter 等大多数在役 Lead
  都走这条,`#leads-roundtable` / `#flywheel-core` / issue thread 正是它们的日常路由。
- **今天就在发生,不是等 D 合入才显现** —— 上面的 6 条并 1 批是这一版实测出来的。
- **没有证据显示 Claude Lead 今天会回错频道**:批次里每条成员仍各自带正确的
  `chat_id="…"`,所以 Lead 仍能按条判断回哪。**我不声称回复错投**;确证的是
  分区/合批语义错(plan Q10 与 §1g「不与不同 route 的 Discord 信混批」)+ 受信封套里
  丢了结构化 route(plan Q3 的证据要求)。给 Codex 发 v2 时批次级 route 为 null,
  是 §1g「绝不降级到 default chat」想堵的形态。

### 修法(很轻)

插件 `ingestFlags()` 补 `--reply-channel-id` / `--reply-route-json`,并把已解析的 route
带进 `BeginArgs`。主仓侧不用改 —— 能力已经在了。

---

## 三、FLY-529 真机 E2E 明细(21/23)

真 Discord(真 bot token、真隔离频道、真 POST/GET)+ 真插件 PR#18 代码 + 真 `chat-ingest` CLI
+ 真 SQLite mailbox + 真 `LeadInboxLoop`。生产零触碰(隔离频道 / 隔离库 / 隔离 .env)。

| 场景 | 结果 |
| -- | -- |
| Q1 ON 真发一条 → mailbox 行、carrier=inbox、带 mailbox id、**正文逐字**、机器信封不给模型看 | PASS(6/6) |
| Q7 同一条重放 → 不重复入队 | PASS |
| Q3 跨 Lead roundtable 走 mailbox / 正文逐字 | PASS(a、c) · **b route 保真 FAIL** |
| Q10 不同 route 必分批 | **FAIL**(见上) |
| Q2 60 秒内真发 3 条 → 各自恰一次入账、同 route 同分区、逐字 | PASS(3/3;D 未合,合批窗口本身留 D) |
| Q5 运行时 OFF 回切 → 走旧直推;再 ON → 回 mailbox(不重部署) | PASS(3/3) |
| Q8 ON 拥有的消息在 OFF 下重放 → `skip`,零双投 | PASS |
| D 投递环:交付批次每条都带 mailbox id、founder 正文端到端逐字 | PASS(4/4) |
| A 审计脚本:bad=0 duplicate=0 dead=0 | PASS |

## 四、单测/构建

- `flywheel-comm` 定向 15/15;`teamlead` 定向 **672/672**;审计 shell 3/3;`pnpm -r build` 通过。
- **一个宿主假红需要说明**:teamlead 首跑 33 红,全是 unix socket `listen EINVAL` ——
  我的 runner TMPDIR 让 socket 路径长到 **137 字符**,超 macOS `sun_path` 104 上限。
  换短 TMPDIR 后 672/672 全绿。**这是宿主环境项,不是代码缺陷**,也不该记到这一版账上。

## 五、诚实边界

- 用的是**模块驱动**的真 Discord E2E(真 token / 真隔离频道 / 真编译产物),不是把候选版
  部署进 529 slot 起完整 Bridge+双 Lead 拓扑。原因:Claude Lead 的 ingest 在**另一个仓**
  (插件 PR #18),`test-deploy.sh --from-branch` 只部主仓,单靠它拼不出这条链;
  模块驱动能把真插件代码 + 真 CLI + 真库 + 真投递环接成同一条真链,对本单要验的
  「入站→mailbox→投递」是更直接的证据面。**这条我按记忆里 529 内存红区的既有配方做的,不是省步骤。**
- **没做**:Annie 本人在真 Discord 里的完整对话轮(§3.2 第 7 条 ON→OFF→ON 的 founder 在场实测)——
  那要在生产部署后做,且需要她在场;这一版还没到那步。
- **没做**:D 单(FLY-1573,PR #798)未合,60 秒真合批窗口无法验;plan §3.1 Q2 已有预案,
  我按预案如实记录了 C 期形态(3 条各自入账、同分区)。
- 延迟数值(§3.2 第 5 条 Claude ≤3.5s)没测 —— 需要生产部署后的真链路计时。

## 六、复验入口

1. 插件 `ingestFlags()` 补两个 route 参数 → 重跑我的 `ctrl.sh` 阳性对照:
   roundtable 与 slot-2 的分区键必须**不同**;投递批次不得再混两个 `chat_id`。
2. 然后重跑 FLY-529 E2E 全表,Q3.b 与 Q10 必须转绿(其余 21 项已绿,应保持)。
