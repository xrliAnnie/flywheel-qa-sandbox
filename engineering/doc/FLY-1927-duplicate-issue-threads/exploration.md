# FLY-1927 新建 issue 开出多个 thread — 探索

Issue: FLY-1927 (https://linear.app/geoforge3d/issue/FLY-1927/bugthread-新建-issue-会开出多个-thread至少一个不对18671925-实证-实际工作-thread-与登记正主脱节)
日期: 2026-08-20
基于: 无

---

## 1. 一句话结论

Bridge 建 Discord thread 用的是**两步、不可重放的写操作**(先在频道发一条根消息,再从这条消息开 thread),整段被裹在**一个 5 秒的硬性放弃计时器**里;计时器到点时代码返回「失败」,但 Discord 那边**很可能已经把 thread 建出来了** —— 这条 thread 从此没人认领(不进登记表 `chat_threads`)。下一次调用因为登记表里查不到,又从头建一条新的。于是一个 issue 出现两条、三条 thread,其中只有最后成功的那条被登记为「正主」。

> 名词解释:
> - **登记表 `chat_threads`** = Bridge 自己维护的一张 SQLite 表,记「这个 issue 的官方 thread 是哪一条」。事件通报、状态贴、归档都只认这张表。
> - **不可重放(非幂等)** = 同样的请求发两遍会产生两个结果,而不是同一个结果。发一条消息、开一条 thread 都属于这种。
> - **硬性放弃计时器(AbortController timeout)** = 到点就把网络请求掐断。掐断的是本地的「等」,掐不断服务器那边**已经做完的事**。

---

## 2. 症状与 founder 原话

founder 2026-08-20 07:11Z 在 #FLY-1867 thread:

> 「我才是 1867 真正在工作的 thread 吧?你为什么一直在另外一个 thread 里面去回复呢?而且今天晚上也发生好多次,就是新建 issue 的时候,都会开好几个 thread,其中起码有一个 thread 看起来都不对(比如 1867 和 1925 都是这个样子)。感觉是我们前两天或者今天的改动中又引入了一个 bug,之前都没有这个问题。」

拆成两个可独立验证的断言:
- **A. 数量**:新建 issue 会开出多条 thread。
- **B. 脱节**:她实际在用的那条,和系统往里写事件的那条,不是同一条。

下面的实证同时命中 A 和 B,且 A 是 B 的成因。

---

## 3. 实证(全部只读取证,未改动任何生产数据)

### 3.1 登记表本身是干净的

只读打开生产库 `~/.flywheel/teamlead.db`:

```
CREATE UNIQUE INDEX idx_chat_threads_issue_channel ON chat_threads(issue_id, channel_id);
```

2026-08-18 以来 28 行,每个 issue 恰好一行,无重复、无 UUID 形态的脏键。FLY-1867 登记正主 `1539849790748106784`(created_at 04:13:19),FLY-1925 登记正主 `1539894121341394994`(created_at 07:09:28)。

⇒ **重复 thread 不是登记表写重了,是有 thread 从来没被登记过。** 这排除了「一 issue 两登记」类的老问题(FLY-270 canonical-key、FLY-892 唯一约束),把范围收窄到「建了但没登记」。

### 3.2 Bridge 日志里的直接证据

日志窗口:`/tmp/flywheel-bridge.log`,2026-08-19T04:08Z → 2026-08-20T07:34Z(约 27.5 小时)。

FLY-1925 完整时间线:

| 时刻 | 日志 | 含义 |
|---|---|---|
| 07:06:53Z | `[DirectEventSink] ensureChatThread calling: issueId=FLY-1925` | session_started 触发第 1 次建 thread |
| 同上 | `[ChatThreadCreator] create thread … name="[F] [FLY-1925] …"` | 第 1 次真的发出去了 |
| 同上 | `[ChatThreadCreator] create FAILED: timeout` | 5 秒到点,本地判失败 |
| 同上 | `[DirectEventSink] ensureChatThread: created=false threadId=none error=timeout` | **没拿到 thread id,登记表一个字没写** |
| 07:09:28Z | `[ChatThreadCreator] create thread … name="[FLY-1925] …"` | Lead 走 `/api/chat-threads/send` 建第 2 次 |
| 07:09:28Z | (成功) | 登记为正主 `1539894121341394994` |

FLY-1867 更严重,**三次**:

| 时刻 | 事件 |
|---|---|
| 03:28:20Z | 第 1 次建(`[F] [FLY-1867] …`)→ `create FAILED: timeout` |
| 04:09Z 前后 | 第 2 次建(`[FLY-1867] …`)→ `create FAILED: timeout` |
| 04:13:19Z | 第 3 次建 → 成功,登记为正主 `1539849790748106784` |

⇒ founder 看到的「好几个 thread」,数量对得上:1867 最多 3 条、1925 最多 2 条。

### 3.3 全窗口统计

整个 27.5 小时窗口:

- `[ChatThreadCreator] create thread` 共 **25** 次
- `[ChatThreadCreator] create FAILED: timeout` 共 **5** 次(2026-08-20 的 03:23 / 03:29 / 03:56 / 04:09 / 07:06)
- 按天拆:08-19 约 15 次建、**0 次超时**;08-20 约 10 次建、**5 次超时**

命中的 5 个 issue:FLY-1867(两次)、FLY-1884、FLY-1921、FLY-1925。founder 只提了 1867/1925,是因为那两个她当晚在里面说话;**1884 和 1921 同样各有一条无人认领的孤儿 thread,她还没注意到**。

### 3.4 「5 秒不够用」是长期状态,不是今晚才有

同一个 5 秒预算也管着改 thread 标题的调用。同一份日志里:

- `stage-emoji stamp timed out after 5000ms` — **159 次**,从 08-19 06:00 一路散到 08-20 07:00,每个小时都有
- `attach-pin timed out after 5000ms` — 5 次
- `sendBootstrap timed out after 3000ms` — 3 次
- `RoundtableThreadManager poll failed { err: 'fetch failed' }` — 9 次

⇒ **这台机器上 Discord 调用超过 5 秒是家常便饭。** 建 thread 之所以显得是「今晚才有的新问题」,只是因为建 thread 本身是低频事件(27.5 小时才 25 次),要连着新建好几个 issue 才撞得出来 —— 今晚 03:00–07:00 正好是新 issue 密集派发的时段。

---

## 4. 代码层根因

### 4.1 两步写 + 一个计时器

`packages/teamlead/src/bridge/chat-thread-utils.ts` 的 `createChatThread()`(FLY-1544 ③ 抽出的共享实现):

```ts
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? DEFAULT_TIMEOUT_MS);
try {
  // 第 1 步:在频道发根消息
  const msgRes = await fetchImpl(`${DISCORD_API}/channels/${input.channelId}/messages`, { …, signal: controller.signal });
  const msgData = (await msgRes.json()) as { id?: string };
  // 第 2 步:从这条消息开 thread
  const res = await fetchImpl(`${DISCORD_API}/channels/${input.channelId}/messages/${msgData.id}/threads`, { …, signal: controller.signal });
  const data = (await res.json()) as { id?: string };
  return { created: true, threadId: data.id, rootMessageId: msgData.id };
} catch (err) {
  if ((err as Error).name === "AbortError") {
    return { created: false, error: "timeout" };   // ← 什么都没带回来
  }
  …
}
```

`ChatThreadCreator.ts:31` 传进去的是 `CREATE_TIMEOUT_MS = 5_000`。

**一个 5 秒预算要覆盖:两次跨洋 HTTPS 往返 + 两次响应体读取。** 而且计时器是从第 1 步开始算的 —— 第 1 步慢了,第 2 步就没预算了。

### 4.2 掐断的时机决定了留下什么垃圾

| 计时器在哪一刻到点 | Discord 侧真实状态 | 本地拿到什么 | 留下什么 |
|---|---|---|---|
| 第 1 步请求在飞 | 消息可能已发出 | 无 | 频道里一条没有 thread 的孤儿消息 |
| 读第 1 步响应体时 | 消息**已发出** | 无(丢了 message id) | 同上,且 message id 永久丢失 |
| 第 2 步请求在飞 | thread 可能已建 | 无 | **无人认领的 thread** |
| 读第 2 步响应体时 | thread **已建** | 无(丢了 thread id) | **无人认领的 thread** ← 最可能 |

关键在于:**掐断的只是本地的「等」,掐不断 Discord 已经做完的事。** 代码把「我不知道」写成了「失败了」。

### 4.3 三个结构性缺口

1. **零补偿**:abort 之后既不回滚,也不去查「刚才那两步到底成了没有」。第 1 步成功拿到的 `rootMessageId` 在 abort 路径上被整个丢掉 —— 而这个 id 恰恰是唯一能把孤儿 thread 找回来的钥匙(Discord 里一条消息最多只能挂一条 thread)。
2. **零发现**:`_doEnsure()` 第一步只查本地登记表(`store.getChatThreadByIssue`)。从来没有任何代码去 Discord 那边问一句「这个 issue 是不是已经有 thread 了」。所以孤儿一旦产生,**永远不会被发现,也永远不会被归档** —— `done-thread-archiver` 也只认登记表。
3. **重试即重建**:登记表查不到 ⇒ 下一次 `ensure` 必然重走「建新的」分支。`inflight` 那张并发合并表只压得住同一时刻的并发调用,压不住隔了几分钟的顺序重试。

### 4.4 两条入口都能建

日志里两次建 thread 的标题形状不同,说明是两个不同的调用者:

- `[F] [FLY-1925] …` + 根消息带 `🧭 **Route**:` 行 → `DirectEventSink.ensureChatThread`(session_started 触发)
- `[FLY-1925] …` + 根消息只有 `🧵 **FLY-1925** —` → Lead 调 `/api/chat-threads/send`

两条入口共用同一个 `ChatThreadCreator.ensure`,所以共享同一个缺陷。**这不是「两条入口打架」,是同一个缺陷被两条入口各踩一次。**(完整入口清单在 research.md 里核。)

---

## 5. 对 founder 那句「前两天的改动引入的」的诚实回应

**在可观测的证据范围内,我没找到支持「代码回归」的证据,反而找到了反证。**

Bridge 在健康窗口(08-19,15 次建、0 超时)跑的是 `2df1fd06b`(FLY-1808);在故障窗口(08-20)跑的是 `fe9e3de86`(FLY-1877)和 `f8f2176e2`(FLY-1905)。这中间的三个 commit 逐个看 diff:

| commit | 改了什么 | 碰 Bridge 建 thread 这条路吗 |
|---|---|---|
| `0742c4248` FLY-1883 | CI 配置 + 测试文件 + 文档 | 否 |
| `fe9e3de86` FLY-1877 | CI 配置 + shell 测试 + 文档 | 否 |
| `f8f2176e2` FLY-1905 | CI 配置 + 文档 | 否 |

⇒ **两个窗口之间,Bridge 建 thread 那条路上的代码逐字未变。** 差别在环境(主机负载 / Discord 延迟),不在代码。

那为什么 founder 感觉是新的?两个成立的解释:
1. **它一直在坏,只是很少被撞见。** 5 秒预算长期不够(159 次改标题超时是铁证),但建 thread 每天只发生十几次,要连着新建好几个 issue 才让 20%~50% 的失败率显形。今晚正好是密集建单的时段。
2. **更早的改动可能确实收紧了预算或换了实现。** 日志只回溯到 08-19 04:08,看不到「前两天」。`createChatThread` 是 FLY-1544 ③ 从 `ChatThreadCreator` 抽出来的共享实现,抽的时候超时语义有没有变(比如原来两步各有 5 秒、抽完变成两步共用 5 秒),需要翻 git 历史坐实 —— 这是 research.md 的头号问题。

⚠️ **保质期声明**:上面「代码逐字未变」这一条只覆盖 08-19 04:08Z 之后。08-17/08-18 的改动尚未逐条排除,结论可能被 research 阶段推翻。

**但无论回归来源是什么,这不改变要修的东西。** 延迟只是扳机;真正的缺陷是「一个不可重放的两步写,配一个会把『我不知道』说成『失败了』的计时器,且事后没有任何找回机制」。把预算从 5 秒调到 15 秒只是让扳机更难扣动,不解决问题 —— 这台机器上 Discord 偶发几十秒是有记录的。

---

## 6. 修复方向(供 research/plan 收敛,尚未定案)

按「修结构,别加报警器;删的比加的多」排序:

### 方向 A(首选):让建 thread 变成可重放的

利用 Discord 的一条硬性语义:**一条消息最多只能挂一条 thread**。于是:

1. 第 1 步(发根消息)成功后,**立刻把 `rootMessageId` 落盘**,再去做第 2 步。
2. 第 2 步超时/失败 ⇒ 状态记为「未定」,不是「失败」。
3. 下一次 `ensure` 看到「未定」:拿 `rootMessageId` 去 `GET` 那条消息 ——
   - 消息上已经挂了 thread ⇒ **认领它**,写进登记表。孤儿变正主,一条都不多开。
   - 还没挂 ⇒ 对**同一条消息**重试第 2 步。绝不重发根消息。

这样整条路径不管超时多少次,最终只会存在一条 thread。**需要先核实的 Discord API 事实**:`GET /channels/{cid}/messages/{mid}` 返回的消息对象在有 thread 时是否带 `thread` 字段;对同一条消息重复 `POST …/threads` 的确切行为。这是 research 的硬前置。

### 方向 B(补齐存量):一次性认领已有的孤儿

已经躺在 Discord 里的孤儿(至少 1867 ×2、1884、1921、1925 各一条,founder 已手工归档了 1867/1925 的)。列出频道里的活跃 thread,按标题里的 `[FLY-XXXX]` 匹配,发现「Discord 有、登记表没有」时:若该 issue 尚无正主 ⇒ 认领;若已有正主 ⇒ 归档掉多余的那条。**只做一次性对账,不做常驻巡检**(避免加报警器)。

### 方向 C(卫生):预算分段 + 别把未知说成失败

两步各自独立计时,总预算放宽;错误分成「明确失败」(4xx)和「结果未知」(abort / 网络中断)两类,只有前者才允许重建。这一条单独做没用,是 A 的配套。

### 明确不做

- ❌ 只调大超时数字 —— 治不了根,只是把概率往下压。
- ❌ 加一个「孤儿 thread 告警」常驻巡检 —— 那是加报警器不是修结构,而且 Annie 明确反对新增告警层。

---

## 7. 已知边界 / 尚未回答

| 问题 | 状态 |
|---|---|
| Discord 消息对象在有 thread 时带不带 `thread` 字段?重复 POST …/threads 的确切行为? | **未核实,方向 A 的硬前置** |
| `createChatThread` 抽取时(FLY-1544 ③)超时语义有没有变紧? | 未核实(git 考古进行中) |
| 08-17/08-18 的改动有没有碰这条路? | 未核实(git 考古进行中) |
| 除了 `DirectEventSink` 和 `/api/chat-threads/send`,还有没有第三条能建 thread 的入口? | 未核实(入口清点进行中) |
| 为什么 08-20 03:00–07:00 主机/网络变慢? | 未查。**故意不查** —— 修复不应依赖延迟消失 |
| 存量孤儿的确切条数 | 只能靠 Discord API 列举确认;日志证据给出下界:≥5 条 |
