# FLY-1927 新建 issue 开出多个 thread — 调研

Issue: FLY-1927 (https://linear.app/geoforge3d/issue/FLY-1927/bugthread-新建-issue-会开出多个-thread至少一个不对18671925-实证-实际工作-thread-与登记正主脱节)
日期: 2026-08-20
基于: exploration.md

---

## 0. 本文回答的问题

exploration.md 留了 6 个未核实项。本文逐条给出可复现的证据或明确的「未解决」。**最重要的一条**:根因从「推断」变成了「实证」—— 超时那一刻 Discord 确实已经把 thread 建好了,那两条 thread 现在还活着。

---

## 1. 【已证实】超时之后,Discord 那边 thread 是真建成了

这是整个分析的支点。之前只是推断,现在是实测。

**方法**:用 Tadashi bot token 只读调 Discord API,列出 `#flywheel-engineer`(channel `1516209714097291335`)的活跃 thread,和生产 `~/.flywheel/teamlead.db` 的 `chat_threads` 表做差集。

> 探针纠错记录:第一版探针对所有 19 个 bot token 都返回 403。**这是探针坏了,不是权限事实** —— Discord API 要求带 `User-Agent: DiscordBot (...)`,urllib 默认 UA 被挡。补上 UA 后全部正常。(教训归档:一致的失败先怀疑自己的尺子。)

**结果 —— 活在 Discord、登记表里没有的 thread,4 条**:

| thread id | 名字 | 判定 |
|---|---|---|
| `1533242117197922335` | `[FLY-1597] 系统健壮性全面摸底…` | 历史孤儿 |
| `1534587835259031739` | `[O] [FLY-1640] DAG 引擎等待/重激活点普查…` | 历史孤儿 |
| `1539849627166310441` | `[FLY-1867] playwright-mcp Chrome 泄漏…` | **昨夜 04:09 超时的那次** |
| `1539893450084716545` | `[F] [FLY-1925] patrol_tick 名册加「圈」维度…` | **昨夜 07:06 超时的那次** |

两条昨夜的孤儿,id 都**小于**各自的登记正主(1867 正主 `1539849790748106784`,1925 正主 `1539894121341394994`)。Discord 的 id 是雪花号、单调递增 ⇒ **孤儿是先建出来的那条**。

⇒ 代码报 `create FAILED: timeout` 的那一刻,Discord 已经把 thread 建好了。**代码把「我不知道」写成了「失败了」,这一句话就是根因。**

### 1.1 顺带纠正 issue 描述里的一条

issue 描述写「founder 已于 07:12Z 手工 archive 1867/1925 的重复 thread」。实测(07:5x Z):

- FLY-1867 的第一条孤儿(03:28 那次,`1539838435404157088`)确实**已归档**;
- FLY-1867 的第二条孤儿(`1539849627166310441`)**仍然活着,未归档**;
- FLY-1925 的孤儿(`1539893450084716545`)**仍然活着,未归档**。

⇒ founder 归档了她看见的那条,但 1867 一共产生了 **3 条** thread,她少归档了一条。这也说明「靠人工发现并清理」不可行 —— 数量本身就是隐藏的。

---

## 2. 【已证实】thread id 恒等于根消息 id —— 修复方案的支点

Discord 官方文档,Start Thread from Message (`POST /channels/{cid}/messages/{mid}/threads`):

> **"The id of the created thread will be the same as the id of the source message, and as such a message can only have a single thread created from it."**

**在生产数据上实测验证**(不是只读文档):

```
GET /channels/1516209714097291335/messages/1539849627166310441
  → 200,content = "🤖[自动] 🧵 **FLY-1867** — playwright-mcp Chrome …"
  → message.thread.id = 1539849627166310441   ← 与消息 id 完全相同
GET /channels/1516209714097291335/messages/1539893450084716545
  → 200,content = "🤖[自动] 🧭 **Route**: `code` → `workflow_v2` · s…"
  → message.thread.id = 1539893450084716545   ← 同上
```

这两条同时验证了三件事:
1. **thread id == 根消息 id**,官方语义在生产上成立。
2. 一条消息**最多**只能挂一条 thread —— 所以对同一条消息重复调建 thread,不会产生第二条。
3. 两条孤儿的根消息内容形状不同,**坐实了两条独立入口**:`🧭 **Route**:` 开头的是 `DirectEventSink`(session_started 触发),`🧵 **FLY-xxxx** —` 开头的是 Lead 的 `/api/chat-threads/send`。

**这条不变量的价值**:第 1 步一拿到消息 id,我们就**已经知道**未来那条 thread 的 id 是多少。不需要按名字搜索,不需要列举全服务器 thread。判断「thread 到底建成了没有」缩成一个确定性探针:

> **`GET /channels/{根消息id}` 返回 200 ⟺ thread 存在,且它的 id 就是根消息 id。**

而这个探针**代码里已经有了** —— `packages/teamlead/src/bridge/thread-validator.ts` 的 `validateThreadExists()` 干的正是这件事。修复不需要新增任何 Discord 交互原语。

---

## 3. 【已证实】这不是「前两天引入的 bug」

founder 的假设是「前两天或今天的改动引入的」。**证据推翻了这个假设**,我按记忆里的规矩(结论被证伪不能靠惯性活着)直说。

### 3.1 缺陷从第一天就在

git 全历史考古:

| 事实 | 证据 |
|---|---|
| 5 秒超时 + **一个** AbortController 罩住两步 REST | 自 `8a804ef5e`(2026-04-13,FLY-91 引入本文件)起就是这样 |
| 5 秒这个数字变过吗 | **从未**。`git log -p --all -S"CREATE_TIMEOUT_MS = "` 全部命中都是 `5_000` |
| FLY-1544 ③ 抽成共享 `createChatThread()`(`f5d894c77`,2026-07-30)有没有改超时语义 | **没有**。抽取前就是一个 controller 罩两步,抽取是逐字搬家 |
| 有没有过「孤儿找回」逻辑后来被删了 | **从来没有过**。`done-thread-archiver` / `legacy-phase-thread-sweep` / `chat-thread-register` 全部只处理「已经在登记表里」的 thread |

⇒ 这是一个**四个月零补偿的结构性缺口**,不是被删掉的功能。

### 3.2 最近 3 天的 commit 逐条排除

| commit | 碰 ChatThreadCreator / chat-thread-utils 吗 | 结论 |
|---|---|---|
| `53e814e0e` FLY-1806 (08-16) | **碰了**,+4/-4 | 只改 `stampStageEmoji` 的注释文字(删掉已退役 env 名),功能代码逐字不变 |
| `2df1fd06b` FLY-1808 (08-18) | 否 | 删的是 founder_ux_gate 路由和一个默认关闭的 poller —— 只减不加 |
| `92adf6597` / `87e9e8352` / `d839a92fa` / `3a335b295` / `ff0fa64f4` / `a0761bbf4` / `f2917f728` / `f8f2176e2` | 否 | 分别是 ship 卡、land、CI、runner spawn、Chrome 回收、日志 janitor,均不在这条路上 |

进一步:健康窗口(08-19,15 次建、0 超时)跑的 HEAD 是 `2df1fd06b`,故障窗口(08-20)跑的是 `fe9e3de86` 和 `f8f2176e2`,中间三个 commit 全是 CI/测试/文档。⇒ **两个窗口之间,这条路上的 Bridge 代码逐字相同。**

### 3.3 历史孤儿普查 —— 它一直在发生

扫 `#flywheel-engineer` 的归档区,724 条归档 thread,与登记表做差集:

**62 条归档 thread 名字里带 issue 号、却不在登记表里**,最早可追到 2026-07-09。其中肉眼可辨的同一 issue 重复对:

```
2026-07-16  [F] [FLY-1193] …      ×2   (1525897926252167170 / 1525964411779547297)
2026-07-23  [F]/[O] [FLY-1328] …  ×2
2026-07-23  [FLY-1441] …          ×2
2026-07-30  [FLY-1544] …          ×2
2026-08-20  [F] [FLY-1867] …           (昨夜第一条孤儿,founder 已归档)
```

⚠️ **边界**:62 是「Discord 有、登记表没有、名字带 issue 号」的上界,不等于「62 条都是超时孤儿」。里面混着 v2 实验期(2026-07-30/31)用别的机制建的 thread(名字形如 `✅完成 [F] [FLY-1545]`)。**能明确归因到本缺陷的,是那些同一 issue 出现两条、名字形状一致的重复对。** 精确归因需要逐条比对当时的日志,不在本次范围。

### 3.4 那为什么 founder 现在才觉得不对?

两个成立且互不排斥的解释:

1. **低频事件 + 高失败率 = 需要密集触发才显形。** 27.5 小时里只建了 25 次 thread,但 5 秒预算超时是长期状态 —— 同一个 5 秒也管改标题的调用,日志里 `stage-emoji stamp timed out after 5000ms` 出现了 **159 次**,每个小时都有。昨夜 03:00–07:00 是新 issue 密集派发时段,10 次建里撞了 5 次,一晚上冒出 5 条孤儿,才越过了「能被人注意到」的门槛。
2. **孤儿是先建出来的那条(id 更小)**,在 Discord 侧栏里排在正主前面。issue 越多、越容易点错。

**部分解决 —— 主机确实处于饱和状态。** 2026-08-20 07:5x Z 实测:

```
load averages: 88.56  58.78  57.03      (全机 %CPU 合计 830)
curl http://localhost:9876/health → 200,144ms   (Bridge 本身健康)
```

1 分钟 load 88、5 分钟 58 —— 这台机器长期严重过载。(MEMORY 里已有同一条记录:「全量 vitest 套件会压死生产 Bridge — load 顶到 88」。)

**这个数字改变了对超时性质的判断,而且是往更严重的方向**:在 load 88 的机器上,`setTimeout(abort, 5000)` 触发的往往不是「网络慢」,而是 **Node 事件循环被饿死** —— 响应可能早就躺在 socket 缓冲区里,只是没有 CPU 去处理它。

⇒ **这进一步否定了「调大超时」这条路**:事件循环饿死时,把 5 秒改成 15 秒只是让计时器晚一点在同样饿死的循环里触发,并不保证有 CPU 去读响应。**唯一稳的解法是让操作可重放**,与调度延迟彻底解耦。

**仍未解决**:为什么 08-20 03:00–07:00 这个时段负载升高。**我故意不去查,也不把修复建立在「消除延迟」上** —— 延迟是扳机不是枪。

---

## 4. 【已核实】代码层的三个缺口

### 4.1 一个计时器罩两步

`packages/teamlead/src/bridge/chat-thread-utils.ts:574-655`:

```ts
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? DEFAULT_TIMEOUT_MS);  // 5s
try {
  const msgRes = await fetchImpl(`…/channels/${channelId}/messages`, { signal: controller.signal });
  const msgData = (await msgRes.json()) as { id?: string };          // ← msgId 到手
  const res = await fetchImpl(`…/messages/${msgData.id}/threads`, { signal: controller.signal });
  const data = (await res.json()) as { id?: string };
  return { created: true, threadId: data.id, rootMessageId: msgData.id };
} catch (err) {
  if ((err as Error).name === "AbortError") {
    return { created: false, error: "timeout" };   // ← msgId 被整个丢掉
  }
}
```

两个问题叠在一起:
- **预算是共享的**:第 1 步慢了 4.5 秒,第 2 步只剩 0.5 秒。
- **abort 分支把已经到手的 `msgData.id` 扔了** —— 而它恰恰是唯一能找回孤儿的钥匙(§2)。

### 4.2 `inflight` 只压并发,不压顺序重试

`ChatThreadCreator.ts:318-333`:

```ts
const key = `${ctx.issueId}:${ctx.chatChannelId}`;
const pending = this.inflight.get(key);
if (pending) return pending;
const promise = this._doEnsure(ctx);
this.inflight.set(key, promise);
try { return await promise; } finally { this.inflight.delete(key); }   // ← 一 settle 就删
```

promise 一 settle(哪怕是 `{created:false, error:"timeout"}`)key 立刻被删。下一次 `ensure` 从头再来一遍。

### 4.3 失败路径不写任何东西 ⇒ 下次必然重建

`_doEnsure` 第 1 步只查本地登记表(`ChatThreadCreator.ts:337`);而 `upsertChatThread`(:408)被 `if (created.created)` 挡着。超时 ⇒ 一个字不写 ⇒ 下次查不到 ⇒ 走「建新的」分支。**闭环成立。**

---

## 5. 建 thread 的入口清单

日志形状 + 代码交叉核实,两条真正会建 issue thread 的入口:

| 入口 | 调用链 | 根消息形状 | 标题形状 |
|---|---|---|---|
| session_started | `DirectEventSink.ensureChatThread` → `ChatThreadCreator.ensureChatThread` | `🧭 **Route**: …\n🧵 **FLY-xxxx** — ` | `[F] [FLY-xxxx] …`(带模型标记) |
| Lead 主动通报 | `/api/chat-threads/send` → 同上 | `🧵 **FLY-xxxx** — 标题` | `[FLY-xxxx] …` |

两条入口**共用同一个 `ensureChatThread`**。所以这不是「两条入口打架」,是**同一个缺陷被两条入口各踩一次**。修在 `ChatThreadCreator` / `createChatThread` 这一层,两条入口同时受益。

其他候选已排除:`AlertChannelHub`(告警频道工单 thread,不碰 issue thread)、`RoundtableThreadManager`(圆桌话题 thread,另有 `roundtable_topic_threads` 表)、`phase_chat_threads`(近期无行,已由 FLY-892 收敛)。

---

## 5.1 排除掉的第二条假说:issueId 键不一致(FLY-270 已修,不是本次成因)

静态代码分析提出过另一条机制:`/api/runs/start` 传进来的 `issueId` 可能是 Linear UUID,而 Lead 走 `/chat-threads/send` 时解析成 identifier 字符串 —— 两个不同的键在 `UNIQUE(issue_id, channel_id)` 下互不冲突,于是同一个 issue 落成两行、两条 thread。

这条机制**真实存在过**,拿生产库判:

```
chat_threads 共 1050 行:identifier 形态 944,UUID 形态 106
UUID 形态行的时间范围:2026-05-05 → 2026-07-12
2026-07-21 之后:0 行
```

同一 issue 同时有 UUID 行和 identifier 行的实例(join `sessions` 表):GEO-425、LEARN-123、FLY-739/748/761/786/787/794/803/804、GEO-441 …… **最后一例 2026-07-12。**

⇒ 这正是 **FLY-270**(PR #267)修掉的那个 dual-thread bug。**它已经不再发生,和 FLY-1927 无关。**

**但对本次的四条孤儿,归因是干净的 1:1**:

| 孤儿 thread | 根消息形状 | 对应的日志行 |
|---|---|---|
| `1539838435404157088`(1867,已归档) | `🧭 Route` = DirectEventSink | 03:28 `create FAILED: timeout` |
| `1539849627166310441`(1867,仍活) | `🧵` = `/chat-threads/send` | 04:09 `create FAILED: timeout` |
| `1539893450084716545`(1925,仍活) | `🧭 Route` = DirectEventSink | 07:06 `create FAILED: timeout` |
| (FLY-1884 / FLY-1921 的两次超时) | — | 03:29 / 03:56 `create FAILED: timeout` |

**每一条孤儿都恰好对应一行 `create FAILED: timeout`,没有多余、没有缺漏。** 超时机制单独就解释了 100% 的本次重复。

⚠️ 残留隐患(记账,不在本次修):`resolvedIssueId` 在「session 行还不存在」时回落到 identifier —— 只要将来有人用 UUID 调 `/api/runs/start`,FLY-270 那条路会重开。加一道边界校验值得单开一单。

### 一条方法论教训

静态分析给出的判断是:「create 失败时不可能产生孤儿,因为 Discord 那边也没建成」。**这是错的,而且错得和生产代码一模一样** —— 都假设了「超时 = 什么都没发生」。四条活孤儿是反证。

⇒ 归档进教训:**判「远端做没做成」只能去远端取证,不能从本地返回值推断。** 这也正是本 issue 的根因本身。

---

## 6. 修复方案的技术前置 —— 已核实清单

| 前置 | 状态 | 证据 |
|---|---|---|
| thread id == 根消息 id | ✅ 已证实 | 官方文档 + 生产实测两例(§2) |
| 一条消息只能挂一条 thread | ✅ 已证实 | 官方文档原文(§2) |
| 「thread 存不存在」有确定性探针 | ✅ 已证实 | `GET /channels/{id}`;`thread-validator.ts` 已实现 |
| 消息对象带 `thread` 字段 | ✅ 已证实 | 官方文档 + 生产实测(§2) |
| `chat_threads` 可加可空列 | ✅ 现状如此 | 表已有 10 个通过 ALTER 加的可空列 |
| 对同一消息重复 POST …/threads 的**确切错误码** | ⚠️ **未实测** | 见下 |

最后一条的处理:**方案刻意不依赖这个错误码。** 判据统一收敛成一句 —— `GET /channels/{根消息id}` 返回 200 就是存在。任何来自第 2 步的 4xx,都退回这一个探针裁决。所以即使错误码和预期不同,方案也不会误判。实测这个错误码留给实现阶段在 529 隔离房做,不阻塞设计。

---

## 7. 结论(交给 plan.md)

1. **根因**:不可重放的两步写 + 共享的硬性放弃计时器 + 零补偿。计时器掐断的是本地的等待,掐不断 Discord 已做完的事;代码把「未知」当成了「失败」。
2. **不是新回归**:缺陷自 2026-04-13 存在,最近 3 天无相关代码改动,历史孤儿可追到 7 月。昨夜只是密集建单让它显形。
3. **修复支点**:thread id 恒等于根消息 id ⇒ 只要在第 1 步成功后**立刻把这个 id 落盘**,整条路径就能做成确定性幂等,与超时长短彻底解耦。
4. **不做**:只调大超时数字;新增常驻孤儿巡检告警。
