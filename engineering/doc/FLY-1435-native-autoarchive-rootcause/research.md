# FLY-1435 Discord 原生 auto-archive 真实语义查证 — 调研
Issue: FLY-1435 (https://linear.app/geoforge3d/issue/FLY-1435/返工802-roundtable-thread-1h-自动归档-原生-auto-archive-未触发-查根因修复接替-fly-802)
日期: 2026-07-22
基于: exploration.md

> **⚠️ Dated correction(2026-07-22,design review R1 source audit 后)**:本文的平台语义证据链(E1-E4)全部成立;但 **§E5 的「只差 merge PR #677 + Bridge 重启」结论作废**,§QA 建议第 2 条「不 @ founder、不加 founder 成员」与真实产品合同(FLY-576:founder 恒为 thread 成员)不符,同样作废。design review 阶段的代码审计新发现两个 #677 范围外的生产交付洞:① plugin 实时网关 creator 硬编码 aad=4320(installed cache `claude-plugins-official/discord/0.0.4/server.ts:199`);② 生产 poller bot(Cass)在 `#leads-roundtable` 无 MANAGE_THREADS(真机位运算探针),#677 的 PATCH 收敛路径 403 放行。完整修复面与新 QA 合同以 **`plan.md`(PR-1/PR-2/Ops 7-8/L1+L2)为唯一权威**。历史证据原文保留如下,不作静默改写。

## 结论(先说答案)

**根因查实:FLY-1431 的 Fail 不是机制没触发,是 ground truth 选错了。**

Discord 在 2022 年改过语义:`auto_archive_duration`(下称 aad)**不再控制服务端何时把 `archived` 翻成 true**——它被官方明文「repurposed」为控制 **thread 在客户端 channel list(侧栏)里停留多久**。真正的 `archived` 翻转由另一个未公开的服务端惰性计时器控制,只在 guild 逼近 thread 上限时才会下调("usually not below the aad")。在我们这种安静 guild 上,该计时器实测 **28 天都不触发**。

而 founder 要的效果——「1h 无活动自动从侧栏收起」——恰好就是 aad **现在真正控制的那个行为**,且真机实测**确实触发**(细节:已读 thread 超 aad 空闲即收起;**未读 thread 被未读徽章钉住不收**,这是 Discord 全平台的未读保护行为)。

因此:PR #677 的机制(create body 按频道策略落 aad)**就是正确修复**;需要返工的是**验收信号与 QA 方法**(用客户端侧栏可见性做 ground truth,而不是 REST `archived` 标志),外加把「未读钉住」如实呈给 founder 做知情边界。

## 证据链

### E1. 官方文档原文(docs.discord.com/developers/topics/threads,2026-07-22 抓取)

> "Threads automatically archive after a period of inactivity. As a server approaches the max thread limit this timer will automatically lower, usually not below the `auto_archive_duration`. In very busy channels, threads set to a 7 day auto archive may archive earlier to help avoid the server becoming "full". "Activity" is defined as sending a message, unarchiving a thread, or changing the auto-archive time. **The `auto_archive_duration` field previously controlled how long a thread could stay active, but is now repurposed to control how long the thread stays in the channel list.**"

三个直接推论:
1. 服务端归档计时器 ≠ aad;aad 只是它的**下限参考**,常态值未公开(实测远大于 aad,见 E2)。
2. aad 的现行合同 = **channel list 停留时长**(即 founder 要的侧栏收起)。
3. "Activity" = 发消息 / 解档 / 改 aad——**读消息、REST GET 都不算活动**,排除了 exploration H4(观测本身抑制归档)。

channel 对象的 `default_auto_archive_duration` 字段描述同款措辞("threads will stop showing in the channel list after the specified period of inactivity"),这正是 PR #677 读取的父频道字段。

### E2. 真机:服务端 `archived` 标志实际上不翻(28 天铁证)

用 QA host bot(`TEST_BOT_TOKEN_1`)只读 GET,观测时刻 2026-07-23T03:03Z:

| thread | aad | 静置 | `archived` |
|---|---|---|---|
| FLY-1431 native-60(`1529589050393235477`) | 60 | **383 min(6.4 倍窗口)** | false |
| FLY-1431 fallback(`1529586769241047294`) | 4320 | 392 min | false |
| FLY-1431 alert(`1529586462746742816`) | 1440 | 393 min | false |
| `[zombie_session_backlog] zombie 18:31`(`1525313524388335779`) | 1440 | **12.1 天** | false |
| `[usage_limit] flywheel-test-1 13:44`(`1519443137431470241`) | 1440 | **28.3 天** | false |

guild active-threads 列表(`GET /guilds/{gid}/threads/active`)里躺着大量超窗数十倍的 thread。**结论:在本 guild(远未逼近 thread 上限)上,服务端主动翻 `archived` 的行为实际不发生。任何以「REST `archived` 在 aad 到点后变 true」为 ground truth 的验收都必然 Fail——FLY-1431 的核心 Fail 正是这个。**

### E3. 真机:频道里既有的 `archived=true` 全是批量 PATCH 痕迹,非原生到点归档

`GET /channels/1512578695468941333/threads/archived/public`(生产 `#leads-roundtable`):20 条 archived thread 的 `archive_timestamp` **全部挤在 2026-07-17T06:49:17 ~ 06:49:41 的 24 秒内,间隔约 1.2s**——典型的 REST PATCH 循环节奏(带 rate-limit 间隔),且这些 thread 创建于 7/14-7/15(aad=60,若原生到点归档,archive_timestamp 应散布在各自最后活动 +60min 处)。高度疑似某次 reconciler 类工具运行的痕迹(FLY-802 演化过程中被废除的 reconciler,或同类脚本)。**它反证:此前侧栏「看起来会清掉」的经验来自工具批量归档,不是原生。**

### E4. 真机:客户端侧栏收起**确实由 aad 触发**,但被未读钉住(Claude-in-Chrome,Annie 生产客户端)

> 环境说明:`DISCORD_GUILD_ID=1485787271192907816`(claude's server)就是**生产 guild**;`1512578695468941333` 就是生产 `#leads-roundtable`(FLY-529 的 `#test-*` 是同 guild 镜像频道)。FLY-1431 的 native-60 thread 建在生产 `#leads-roundtable` 里,以下观察即 Annie 生产侧栏。

时序实验(2026-07-23T03:0x Z):

| 步骤 | 观察 |
|---|---|
| T0:侧栏截图 | native-60 thread(闲 6.4h,aad=60)**仍显示**在 `#leads-roundtable` 下,带红色未读徽章「1」 |
| 查成因 | REST `GET /channels/{tid}/thread-members`:**Annie(`1138241636057481306`)是 thread 成员**(被 Aunt Cass 消息 @mention 自动加入);未读 = 该 @mention |
| T1:点开 thread(读掉未读) | 未读徽章清除 |
| T2:切走到 `#general`,再截图 | **native-60 thread 从侧栏消失**(证据截图已存盘);同列表中已读但 aad=4320 且在窗口内的 thread(灰字无徽章)**仍显示** |

这一组 A/B 确立客户端现行规则:

```
侧栏显示 = 未 archived 且 ( 未读/被 @ 钉住 或 最后活动距今 < aad )
```

- **已读 + 空闲超 aad → 收起**(原生机制真触发;读消息不算 activity,不重置计时——E1)。
- **未读(尤其未读 @mention)→ 钉住**,aad 不生效。@mention 还会把人自动加成 thread 成员。这解释了 Annie 侧栏里 `#flywheel-alerts` 下几十条「一排排」——全是未读徽章钉住的,和 aad 无关,连 aad=60 也救不了它们(除非强制 `archived=true`)。

局限:T1→T2 是 n=1 快速实验(设计节点取证);QA 阶段按 §QA 建议复刻成受控 E2E(≥90min 静置 + A/B 对照)。实验副作用:读掉了 Annie 在该 QA thread 上的一条未读(QA 测试 thread,无实质影响,如实记录)。

### E5. 生产 rollout 前提已就位

- 生产 `#leads-roundtable`(`1512578695468941333`)的 `default_auto_archive_duration=60` **已配置**(FLY-1431 verdict 节点回读证实,`hasDefaultField=true`)。
- PR #677 对 main:`MERGEABLE / CLEAN`(23 commits ahead, 3 behind,无冲突)。
- 即:**机制侧只差 merge PR #677 + Bridge 重启**,无需新频道配置。

## 对 founder 目标的诚实映射

| 场景 | 纯原生(PR #677)行为 | 是否达成「别堆侧栏」 |
|---|---|---|
| roundtable thread,Annie 已读 | 最后活动 1h 后自动从侧栏收起 | ✅ 达成(这就是 issue 原始诉求) |
| roundtable thread,Annie **未读**(被 @) | 钉在侧栏直到她读掉;读掉后若已超 1h 空闲**立即**收起 | ⚠️ 半达成——钉住是 Discord 的未读保护,读一眼就收 |
| alert threads(`#flywheel-alerts`,大量未读) | 不受本单影响(fallback 1440;未读照钉) | ❌ 本单范围外;若要强收未读需 reconciler(founder 已否决方向,如要做是新决策) |

**「原生纯静置无法归档」不成立**——原生做得到 founder 要的核心效果(已读 thread 1h 收起),所以按 founder 指令走「修」分支,不触发「停下来报告加 reconciler」分支。「未读钉住」作为知情边界随设计 HTML 呈报,若 founder 想连未读一起强收,那是新的产品决策(她拍了才动)。

## QA 方法学修正(给 QA 节点的合同基础)

1. **Ground truth = 客户端侧栏可见性**(Claude-in-Chrome 截图),**不是** REST `archived` 标志。REST `archived` 在本 guild 上几乎永不翻转,属预期平台行为,**不得**再作为 Fail 依据。
2. 核心用例 A(原生收起):在配置 default=60 的频道建 thread(**不 @ founder、不加 founder 为成员**)→ T0 确认侧栏显示 → 静置 ≥90min 零活动 → 确认侧栏**不再显示**该 thread(REST 同步记录 `archived` 仍可能为 false,作为语义佐证而非判定)。
3. 对照用例 B(排除「消失=别的原因」):同窗建一条 aad=4320 的 thread,静置同样时长 → 仍显示。
4. 用例 C(未读钉住,知情边界复证):@ founder 的 thread 静置超窗仍显示;founder 读掉后收起。涉及 founder 真实未读状态,执行与否交 Lead 定夺(E4 已有一次实证)。
5. 频道准备:`#test-leads-roundtable` 当前无 default(null→fallback)。要么请 Annie 一次性把该频道 default 设为 1h(bot 无 MANAGE_CHannels,FLY-529 已知),要么复用生产 `#leads-roundtable`(FLY-1431 先例,QA 前缀命名)。

## 引用

- Discord 官方开发者文档 Threads(现行):https://docs.discord.com/developers/topics/threads
- Channel 资源 `default_auto_archive_duration` 字段:https://docs.discord.com/developers/resources/channel
- 社区对同一语义的印证(reverse-engineered docs):https://docs.discord.food/topics/threads ;discord.py 文档修订讨论 https://github.com/Rapptz/discord.py/issues/9351 ;discord-api-docs 讨论 https://github.com/discord/discord-api-docs/discussions/6703
- FLY-1431 QA 报告:`engineering/doc/FLY-1431-qa-802-autoarchive-e2e/qa-report.md`(PR #680 分支)
- 证据截图(读掉后侧栏收起):`/Users/xiaorongli/.flywheel/runner-state/ac24b7a3-920c-44fd-817e-c2987f078491/browser-tmp/claude-chrome-screenshots-iQll5l/screenshot-1784776159128-0.png`(本地留档)
