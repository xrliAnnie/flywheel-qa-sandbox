# FLY-2028 thread 过期归档不生效 — 调研
Issue: FLY-2028 (https://linear.app/geoforge3d/issue/FLY-2028/返工1435-thread-过期归档仍然不生效-设置对了但-discord-原生-auto-archive)
日期: 2026-09-02
基于: exploration.md

> **范围更新(2026-09-02,Lead 回复 + Linear 评论 08-24 → 09-03)**:本单不止 roundtable/alerts 的年龄清扫。founder 09-02 20:03 PT 点名「ship 之后自动 archive 还是坏的,加到比较前面」,Lead 把它列为**主验收**。因此本调研分两段:**A = issue chat thread 在 Done/ship 后真的归档**(主);**B = roundtable / alerts 按年龄清扫**(exploration.md 原方案)。

## 0. 结论先行

| 段 | 现状 | 根因 | 修向(plan.md 定稿) |
|---|---|---|---|
| A · issue thread ship 后不归档 | ship 时归档 → Lead 收尾话 / founder 追问把线程顶开 → 之后**任何自动路径都不再归档**(`founder_reopened` 永拒;6h 清扫只看 DB `archived_at IS NULL`) | ① FLY-1709 的「任何人类消息 ⇒ 永不再归档」在 issue 已 Done 后仍生效;② 归档时机在收尾话**之前**,结构性必然被顶开;③ 6h 清扫的候选集以 DB 为真相,顶开的线程永远不在候选集 | 单条规则:**issue 终态 + Discord 上线程开着 + 最后一句话 ≥ 60min ⇒ 归档,不问是谁说的**。终态权威由调用方带入(fresh Linear Done / ship merged);自动路径都等 60min 静默(收尾话说完再收);候选集用 Discord 真相补全 |
| B · roundtable / alerts 堆积 | aad 设置正确(60 / 1440),Discord 不执行;归档只在人工大扫除时成批发生 | Discord 2022 语义变更:aad 只管**已读**线程的侧栏收起;未读被钉住;服务端 `archived` 在安静 guild 上实测 28 天不翻 | Bridge 内定时清扫器:只管两个频道,线程静置 ≥ 自己的 aad ⇒ `PATCH archived:true` |

## 1. 真机证据(全部只读,2026-09-03T03:10Z,claw-infra-bot GET)

### 1.1 频道默认值与线程分布(guild `1485787271192907816`,43 个频道,活跃线程 328)

| 频道 | 频道 `default_auto_archive_duration` | 活跃线程 | 线程自身 aad | 静置(小时)min / 中位 / max | 超过自身 aad |
|---|---|---|---|---|---|
| `#leads-roundtable` 1512578695468941333 | **60** | 9 | 60 ×9 | 1.8 / 22.1 / 40.8 | **9/9** |
| `#flywheel-alerts` 1518793447165661254 | **null(未设置)** | 10 | 1440 ×10 | 4.0 / 6.2 / 6.8 | 0/10 |
| `#flywheel-engineer` 1516209714097291335 | null | 11 | 4320 ×11 | 0.0 / 0.5 / 185.2 | 1 |
| `#test-leads-roundtable` 1519417773304975450 | 60 | 7 | 60 ×4, 1440 ×3 | 284 / 340 / 340 | 7/7 |
| `#test-flywheel-alerts` 1519421055805165842 | null | 60 | 60 ×5, 1440 ×55 | 89 / 185 / 712 | 60/60 |

全 guild **只有两个频道**设了 default(生产 roundtable 与其 test 镜像)。issue 里写的「`#flywheel-alerts` = 1440」是每条线程自带的值(`AlertChannelHub.ts:85` 的 fallback),不是频道设置。

### 1.2 归档只在成批时刻发生(`GET /channels/{id}/threads/archived/public?limit=100`,两频道都 `has_more=true`)

```
#leads-roundtable   2026-08-24T17 ×53 · 08-24T18 ×5 · 08-27T06 ×29 · 08-28T05 ×7 · 08-29T00 ×5 · 08-29T21 ×1
#flywheel-alerts    08-31 → 09-02 每小时 1~5 条零散(AlertChannelHub 按 incident 归档) + 09-02T03 ×20(一次成批)
```

roundtable 在 issue 开单(08-24)之后又被人工扫了三次。alerts 的零散归档是 `AlertChannelHub` 按 incident 生命周期做的(recovered → archive),与年龄无关。

### 1.3 谁能归档谁的线程(角色 + 频道 overwrite 位运算,`MANAGE_THREADS = 1<<34`)

| bot | `#leads-roundtable` | `#flywheel-alerts` | `#test-leads-roundtable` | `#test-flywheel-alerts` |
|---|---|---|---|---|
| claw-infra-bot(`CLAUDE_INFRA_BOT_TOKEN`,id 1524829037825101975) | ✅ | ✅ | ✅ | ✅ |
| Aunt Cass(`CASS_BOT_TOKEN`) | ✅ | ✅ | ✅ | ✅ |
| Tadashi(`TADASHI_BOT_TOKEN`) | ❌ | ❌ | ❌ | ❌ |

roundtable 活跃线程属主:Honey Lemon / Aunt Cass / Tadashi ×3 / Simba ×2 / Belle / Peter(6 个不同 Lead bot);alerts 属主全是 `flywheel-alerts-dispatcher`。官方 docs:「Editing a thread to change the `name`, `archived`, `auto_archive_duration` fields requires `MANAGE_THREADS` or that the current user is the thread creator」⇒ 段 B 必须用 MANAGE_THREADS 身份;claw 是基础设施身份,与 FLY-802 当年 reconciler 的选择一致。

### 1.4 段 A 的生产实例(Linear FLY-2028 评论,Tadashi 取证)

| 日期 | issue | 现象 | 端点返回 |
|---|---|---|---|
| 08-27 | FLY-2094 | 引擎 21:59Z 归档 → Lead 22:32Z 发 ship 总结 → 顶开 | `reason:"ok"`(手动调端点才收) |
| 08-27 | FLY-2074 | 归档 → Lead 要 founder 授权 → founder 回「merge raya 2」→ 顶开 | `founder_reopened` |
| 08-27 | 6h 清扫日志 | `scanned=57 archived=0 skippedNotDone=57 skippedReopenProtected=0` | 顶开的两条**不在候选集** |
| 08-29 | FLY-2032 / FLY-2030 | founder 在已归档线程里下令「你去 archive 吧」→ 她这句话本身被判成 human reopen | `founder_reopened`,Lead 用 bot token 直接 PATCH |
| 08-31 | FLY-2164 | ✅ → land → 归档 → Lead 收尾话后到 → 顶开;founder 质疑「为什么不能等说完再归档」 | — |
| 08-31 | FLY-1944 | Lead 在 Done 单归档线程留对账 note → 顶开 → founder 问「为什么又开了」→ 她的提问又成 reopen 证据 | `founder_reopened` |
| 09-02 | FLY-2264 | ship/Done 后 Lead 调端点 | `founder_reopened`;同刻 FLY-2274 / 2249 成功 |

## 2. Discord 语义(官方 docs.discord.com/developers/topics/threads,2026-09-02 抓取)

1. 「Threads automatically archive after a period of inactivity. As a server approaches the max thread limit this timer will automatically lower, usually not below the `auto_archive_duration`.」+「The `auto_archive_duration` field … is now repurposed to control how long the thread stays in the channel list.」⇒ 服务端计时器 ≠ aad;安静 guild 上实测不触发(FLY-1435 §E2 28 天)。
2. 「"Activity" is defined as sending a message, unarchiving a thread, or changing the auto-archive time.」⇒ **读消息 / REST GET 不算活动**;解档算活动。
3. 「Sending a message will automatically unarchive the thread, unless the thread has been locked by a moderator.」⇒ 归档后 Lead / founder 再发言 → 自动解档(这是 founder 与 Lead 都接受的行为;也是段 A 「顶开」的机制本体)。
4. 归档需要 MANAGE_THREADS 或线程创建者(§1.3)。

**时钟合同(Linear 08-24 评论 + 本节 2)**:「静置」= `now − snowflake(last_message_id)`。`thread.id` 是创建时刻、`archive_timestamp` 是归档状态上次变化时刻,**都不能替代** `last_message_id`;但两者只能把「最后活动」推**晚**(创建/解档都是活动),绝不会推早 ⇒ 取三者最大值只会少杀不会多杀。`last_message_id` 缺失(零消息线程)才退到创建时刻;三者都非法 ⇒ 不归档。

## 3. 代码审计:段 A 的归档链与三处失效点

### 3.1 唯一 sink 与调用方

`archiveThreadAndRecord`(`done-thread-archiver.ts:282`)是「The ONE place」。调用方:

| 调用方 | 触发 | 携带的「issue 终态」证据 | 对 `founder_reopened` 的处理 |
|---|---|---|---|
| `post-ship-finalization.ts:1226` | ship merged 后立即 | merged(ship 本身) | `isArchiveObligationSettled` 判 settled,发「请 Lead 手动归档」infra 通知(`:1269`) |
| `done-thread-reconcile.ts:679` | 6h 全量 | fresh Linear Done/Canceled 双门 | `skippedReopenProtected++` |
| `terminal-thread-archive.ts:281`(targeted,分钟级) | session 终态事件入队 | fresh Linear Done 复核 + 全 alias 终态 | outcome `founder_reopened`,**非重试,出队** |
| `tools.ts:1216` 端点 `POST /api/chat-threads/archive` | Lead 手动 | **无**(不查 Linear) | 原样返回 |
| `maybeArchiveThreadOnClose`(close cascade) | runner close done=true | 无 | 首次归档路径不分类 |

### 3.2 sink 的现行决策(`archived_at` 已置时,FLY-1709)

```
probe Discord → 仍归档 ⇒ already_archived(真话 no-op)
             → 开着   ⇒ resolveReopenVeto(epoch 后新 admission / 活 pane) ⇒ in_active_use
                       ⇒ classifyThreadReopener(epoch 后消息):
                            任一非 bot 作者 ⇒ founder_reopened(永不再归档)
                            全 bot ⇒ reArchiveWithQuietWindow(frontier 围栏 + 补偿收据)
                            unknown ⇒ reopen_check_failed(可重试)
```

FLY-1709 plan §2.4 选 any-human 的代价原文:「founder 参与过的重开 thread 永远不会被自动关(需她本人或 Lead 手动)」。当时合理(issue 未必终态);**issue 已 Done/ship 后仍这么判就是 §1.4 全部实例的根因**。

### 3.3 三处失效点(与 §0 对应)

1. **终态无效**:sink 没有「issue 已终态」输入,human ⇒ 永拒;端点也不查 Linear,所以 Lead 明知 Done 也调不动。
2. **时机在收尾话之前**:post-ship 在 `(3) thread teardown` 立即归档;Lead 的 ship 总结、后继单通告、founder 的授权回复都在其后 ⇒ 顶开。DirectEventSink `:1195`:post-ship 归属的完成**不入** targeted 队列(归档归 post-ship 独占),顶开后没有分钟级重试。
3. **候选集以 DB 为真相**:`getUnarchivedIssueChatThreads()`(`StateStore.ts:12188`)只取 `archived_at IS NULL`;顶开的线程 DB 已记归档 ⇒ 6h 清扫永远看不见。`getChatThreadByThreadId()`(`:11973`)可按 thread id 反查,是补全候选集的现成读点。

### 3.4 可复用的现成件

- `startDoneThreadReconcileScheduler`(`done-thread-reconcile.ts:932`):boot 延迟、单飞、协作式 `stop()`、每 tick 重读 config;scheduler 只读 `enabled` / `intervalMin` 两个字段。FLY-802 当年就用显式 adapter 接过一个第二 reconciler(commit `d0b7794d7`,`plugin.ts` +38 行)。
- `getLatestThreadMessageId` / `classifyThreadReopener` / `getChannelName`(`chat-thread-utils.ts:952/901/976`):frontier、作者分类、归档状态探针;静默窗只需把 frontier 的 snowflake 反解成时间。
- `lookupLinearIssueByIdentifier`(`linear-query.ts`):identifier / UUID 都接受;端点拿 `canonicalKey` 可直接用。
- `terminalArchiveBuffer.enqueue` / `doneThreadReconcile.enqueue`(`plugin.ts:6062/7704`):targeted 队列入口;post-ship 延后归档时可把 issue 交给它重试(退避 1→30min,24h 后每小时)。
- `MetaAlertReason` 联合(`MetaAlertNotifier.ts:36`):fail-loud 通道,需加一个成员给段 B 的 401/403。
- FLY-802 的 `channel-default-thread-reconcile.ts`(`git show d0b7794d7:…`,565 行 + 598 行测试):429 not-before、401/403 结束本轮、5s 请求超时、60s 整轮期限、fresh 复核、竞态分类(404 benign / 400+50083 already-archived)—— 段 B 直接裁剪它,去掉频道发现与 aad 收敛。

### 3.5 flag 治理约束

- `packages/config/src/feature-flags/exemptions.ts:22`「Closed: no historical exemption may justify a new entry」;`store-policy.ts:213`「FLAG_EXEMPTIONS is frozen and accepts no new entries」;`truth.ts:980` 未注册的 `FLYWHEEL_*` env 直接报 `unknown FLYWHEEL environment variable`。
- FLY-2101(founder 08-27 v4)把 `done-thread-reconcile` 的 interval / cap 固化成常量。
- ⇒ 本单**零新 `FLYWHEEL_*` env**,所有参数常量化;段 B 的构造条件只用既有变量(`CLAUDE_INFRA_BOT_TOKEN`、`DISCORD_GUILD_ID` / `FLYWHEEL_ROUNDTABLE_GUILD_ID`、两个频道 id)。Lead 09-03 亦明示「不加开关」。

### 3.6 QA 台架

- 529 房:`scripts/test-deploy.sh <slot> --generalized --stub-runner`(真 Discord issue thread,隔离 Bridge);`--alerts` 接 `#test-flywheel-alerts`;roundtable 镜像 `#test-leads-roundtable` 已配 default=60(§1.1)。slot env **没有** `CLAUDE_INFRA_BOT_TOKEN`(`test-deploy.sh` 全文零引用)⇒ 段 B 与段 A 的 Discord 真相发现在 slot 里天然 dormant,QA 需显式注入。
- 模块驱动真 Discord E2E 先例:`scripts/qa-fly892-real-discord-thread-e2e.mjs`(加载 `packages/teamlead/dist` 的真实 StateStore / ChatThreadCreator,对 slot 频道真发真收)。段 A 的「fresh Linear Done」用注入 seam 给定,Discord 侧全真。
- 人类消息:分类器判 `author.bot !== true`。QA bot 发不出「人类」消息;真机 human 分支需要一个真人账号在测试线程发一句(founder / Lead),否则该分支由注入 `classifyFn` 的单测覆盖,真机只覆盖 bot-only 顶开。**这条边界写进 QA 合同,不许拿 bot 消息冒充。**

## 4. 设计判定(输入 plan.md)

1. **段 A 一条规则**:`issue 终态 ∧ Discord 开着 ∧ 静默 ≥ 60min ⇒ 归档`。60min 与 founder 给 roundtable 定的「一小时」同源:一小时没人说话就收。终态权威只由三种调用方带入:fresh Linear Done/Canceled(reconcile / targeted / 端点)、ship merged(post-ship)。close cascade 不带(它没有 Linear 证据,但首次归档本就不分类,静默窗照样适用)。
2. **静默窗对自动路径一律适用**(首次归档也是):这就是 founder 08-31「等说完再归档」的实现 —— post-ship 不再在 ship 当刻归档,而是「试一次,不静默就交给 targeted 队列」;端点是人为显式调用,不等静默。
3. **候选集补全**:6h 清扫用 `GET /guilds/{gid}/threads/active`(claw 身份,与段 B 共用一次发现)反查 `chat_threads`,把「DB 记归档、Discord 开着」的行加进候选;发现失败 ⇒ 退回 DB-only + LOUD 日志,不静默。
4. **段 B**:exploration.md §3.2 原样;时钟按 §2 合同。
5. **不做**:端点 `force` 参数(终态权威已覆盖 §1.4 全部 founder 直令实例,issue 未 Done 时 founder 要求归档属罕见,留边界);「Lead 归档后追话防呆」(发送路径在 plugin,另单);告警减量(FLY-1386)。

## 5. 引用

- Discord Threads topic:https://docs.discord.com/developers/topics/threads
- FLY-1435 `research.md` §E1–E4(aad 语义、28 天铁证、未读钉住 A/B)
- FLY-1709 `plan.md` §2.4(any-human 取舍原文)、`done-thread-archiver.ts:282-560`
- FLY-802 `plan.md` §2 + commit `d0b7794d7`(被废 reconciler 源码)
- Linear FLY-2028 评论 2026-08-24 / 08-28 / 08-29 ×2 / 08-31 ×2 / 09-03(本轮经 Bridge 进程的 Linear key 只读拉取)
