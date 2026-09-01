# FLY-2226 Discord 插件 gateway 失聪自愈 — 实施计划

Issue: FLY-2226 (https://linear.app/geoforge3d/issue/FLY-2226/通信投递丢失-founder-discord-消息选择性丢投2216-thread-从出生就聋-engineer-顶层-0325z)
日期: 2026-09-01
基于: exploration.md, research.md(尤其 §A1-A6)

> **范围**:2026-09-01 05:03 founder 拍板「可以可以 对账别做」。对账 / 兜底扩面(B)**整体砍掉**,
> 本单唯一交付物是**插件侧自愈**(A)。作废的 B 计划原样留档在 `plan-superseded-reconcile.md`。

---

## 0. 一句话

让插件**自己发现自己聋了**并重连 —— 靠两个**已经在流动、却被丢掉的信号**:gateway 生命周期事件(库在发,插件没接)和插件自己消息的回声(gateway 在送,插件在第 1481 行丢掉)。

**不新增任何轮询、不新增任何合成流量、不实现库已有的心跳检测。**

---

## 1. 目标与非目标

### 目标

- **G1** 插件入站派发死亡时**自己重连**,不再需要人肉重启。
- **G2** 自愈失败时**告警**,且告警自带 token 供给(不踩 FLY-2062 / 2223 的 `no-token` 族)。
- **G3** gateway 生命周期不再无声:断开 / 重连 / 恢复 / 失效都留痕。
- **G4** 健康期**零行为改变**、零额外流量。
- **G5** 修复对**全舰 14 个 lead 一次生效**(同一份插件字节)。

### 非目标

- ✗ **不实现协议层心跳监听** —— `@discordjs/ws:905-907` **已经有了**(research §A2)。照指令字面再做一遍就是在库上叠机制。
- ✗ 对账 / 兜底扩面 —— founder 已砍。
- ✗ FLY-2222(投了没看见)。
- ✗ 僵尸插件进程清理 —— Lead 04:14 已用阴性对照**排除**它是本次病因(杀掉 pid 1485/86404 后 04:12:41 的 `test2` 仍零行)。

### ⛔ 范围封顶(Lead 2026-09-01 裁定,写在这里当护栏)

本单**只有** Chunk 1 / 2 / 3 三件。**三条之外不得再长**:

- ✗ 不做对账、✗ 不做补投、✗ **不加 Bridge 侧任何东西**、✗ 不加新表、✗ 不加新的周期性轮询。

这条护栏是有来历的:作废的 B 计划**每被评审一轮就长一层机制**(pin → 为 pin 留证据 → 加枚举器 → 再加第二个 frontier),
到第 5 轮才发现根因是「把 lead 级状态当成逐条消息簿记」。**这次把教训前置成 non-goal,而不是等它再长出来一次。**

⇒ **评审若提出的修法是「再加一层」,先问「是不是又在长机制」,再决定接不接。**

---

## 2. 两类故障,分别由谁接住

research §A3 的核心:**我们无法归因本次是哪一类**(插件 stderr 全链路不落盘),所以必须两类都覆盖。

| 故障类型 | 协议上表现 | 库自己能否处理 | 谁接住 |
|---|---|---|---|
| **真断开**(socket 断 / session invalid / 心跳失 ACK) | 通常先见 `shardReconnecting`;只有不可恢复 close code 才见 `shardDisconnect` | 可恢复错误由库 Resume/Reconnect | 库先重连;**Chunk 1** 从 `shardReconnecting` 开始计时,超时后只补一次强制重连 |
| **半聋**(心跳照常 ACK,但停止派发 `MESSAGE_CREATE`) | **协议上完全健康** | ❌ **抓不到**(`isAck` 恒 true) | **Chunk 2**(自回声探针)—— 唯一能测到它的东西 |

⚠️ **如果只做 Chunk 1**,当本次事故属于「半聋」时,我们交付的是一个**不修复本次事故的修复**。这一点必须显式承认,不能含糊。

---

## 3. 分块实施

### Chunk 1 — gateway 生命周期不再无声

**现状**:插件只注册了 4 个事件(`error` / `interactionCreate` / `messageCreate` / `ready`)。而库**确实在 emit** `ShardReconnecting`(`:268`)/ `ShardError`(`:304`)/ `ShardReady`(`:196`),并只在六类不可恢复 close code 下 emit `ShardDisconnect`(`:246-268`)。Node 的 EventEmitter 对**无监听者**的非 `error` 事件**静默丢弃** —— 这就是 gateway 生命周期「发生了但没有可读痕迹」的机制层原因。

改动(`server.ts`,纯增监听,不改任何既有分支):

| 事件 | 处理 |
|---|---|
| `shardReconnecting` | 记 stderr + `STATE_DIR/gateway-health.log`;先清空旧连接上不可能再补来的 pending echo/timer;若本 episode 尚无 deadline,**从这里开始计时**(后续重复事件不延长 deadline) |
| `shardResume` / `shardReady` | 记双路日志;**清 deadline**、结束 episode、重新启用探针 |
| `shardDisconnect` | 当前版本仅代表鉴权 / intents / sharding 等不可恢复配置错误;记含 code/reason/wasClean 的双路日志并**立即走 Chunk 3**,不做注定失败的重连循环 |
| `shardError` | 记双路日志(不 throw) |
| `invalidated` | 保留 future-compatible 监听与日志;`discord.js@14.25.1` 当前没有发射点,**不作为 G1/G3 验收证据或生产触发器** |

**「库重连不起来」的兜底**:`shardReconnecting` 之后若在 `RECONNECT_DEADLINE_MS`(缺省 **90 秒**)内没有等到 `shardResume`/`shardReady`,进入与 Chunk 2 相同的**单次强制重连** episode。强制重连仍未在另一个 90 秒窗口内恢复,才判定为自愈失败 → Chunk 3。
> 90 秒的依据:`helloTimeout` 是 60 秒(`@discordjs/ws:555`),留一次完整 hello 往返 + 余量。**不是拍脑袋。**

双路日志里的文件是**有界滚动文件**(256 KiB + 一个备份),不含 token / 消息正文。stderr 保留给现场,文件才是事故后可读证据。写文件失败不得 throw,但要在 stderr 留一次降级提示。

**不做**:不自己实现重连循环 / 心跳 —— 库有。本 chunk 只做**观测 + deadline + 至多一次强制重连**;所有 timer 都只在真实 lifecycle episode 内存在,没有周期轮询。

**测试**
- `shardReconnecting` 后按时 `shardResume` → **不**强制重连、不告警、状态清干净。
- `shardReconnecting` 后超过 deadline → 强制重连一次;第二个 deadline 仍无恢复 → 触发一次自愈失败路径并停止该 episode 的重试。
- 重复 `shardReconnecting` 不延长 deadline、不产生多个 timer / 重连 / 告警。
- `shardDisconnect`(不可恢复 code)→ 立即告警,不等 deadline、不强制重连。
- `invalidated` 只验证兼容监听与日志;测试名明确标注当前锁定版本不可达,不计入 G1。
- 日志在达到容量后滚动,且写盘失败不打断 client event loop。

---

### Chunk 2 — 自回声探针(唯一能测到「半聋」的东西)

> ✅ **Lead 已批准**(2026-09-01,question `ed5d1a8b`):自回声探针是**本单的主修法**。
> 裁定同时写死三条判据:**只在插件确有出站之后才启动计时**;**超时的唯一动作是强制重连**;
> **不补投、不记账、不新建表**。
> Lead 已把形状变化(含「心跳监听」表述不准确、以及两件套修不好本次形态)如实同步给 founder;
> 若 founder 否掉本 chunk,则砍到 Chunk 1+3,并按 §6.1 原样写明**不保证修复本次形态**。

**原理**:插件经 REST 发出的每一条消息,gateway 都会作为 `MESSAGE_CREATE` **回送**给它自己。这条回声现在被 `server.ts:1481` 的 `if (msg.author.id === client.user?.id) return` **直接丢弃**。

**改动**:

1. 插件成功发出消息后,把 message id + channel id 放进一个新的**有界**待确认集合。它只借用 `RECENT_SENT_CAP` 的容量纪律,**绝不复用、删除或改变 `recentSentIds` 本体**;后者继续服务 reply-as-mention(`server.ts:833`)。
2. REST response 与 gateway echo 是并发竞态。所有纳入 probe 的插件 REST 发送都经一个 tracked-send helper:请求发出前增加 `trackedRestInFlight`,response 拿到 message id 后**在 helper 内、返回调用方之前**登记 pending,最后才减少 in-flight。自身 `messageCreate` 先到且 `trackedRestInFlight > 0` 时,把 id + seenAt 放进 `earlySelfEchoIds`;登记出站 id 时先查它,命中即当场对消,不启动 timeout。这样 Bridge 代发在通常情况下只刷新「入站活着」的弱信号,不会永久占 early 集合;它若恰与插件 REST 并发,也受下述 TTL + cap 双界限约束。
3. `earlySelfEchoIds` 用 `Map<id, seenAt>`:每次访问先删掉早于 `2 × ECHO_TIMEOUT_MS` 的项,并设独立防御上限 1,000(超限按最旧 seenAt 淘汰)。它不只靠条数假装解决竞态,也不会无界增长。
4. 若某条已登记消息在 `ECHO_TIMEOUT_MS`(缺省 **60 秒**)内**没有**收到回声 → 判定「入站派发已死」→ 进入一个带 latch 的 recovery episode:第一步清空全部 pending / timer,随后**只强制重连一次**。episode 活跃期间所有后续 timeout/lifecycle 信号都只记日志,不得再次重连。
5. 强制重连后 90 秒内收到 `shardResume`/`shardReady` → episode 成功结束并重新启用探针;调用抛错或 90 秒仍未恢复 → Chunk 3 告警一次,探针保持停用直到真实恢复事件到来。告警 REST 发送明确绕过 tracked-send helper,不会递归触发探针。

**Lead 裁定的三条判据(写死,不得放宽)**:
- **只在插件确有出站之后才启动计时** —— 没有出站就没有待确认项,不存在「空跑的计时器」;
- **超时的自愈动作只有一次强制重连** —— 不补投、不重放;清 pending 与 episode latch 是防止重连风暴的安全边界;
- **不补投、不记账、不新建表**。

**为什么这个信号是对的**:

- **零合成流量** —— 用的是本来就会发生的出站;
- **静默期零误报** —— 没出站就没有待确认项,天然不检查;
- **测的就是坏掉的那个能力**(入站派发),不是心跳、也不是 REST —— 后两者在本次事故中**都是好的**。

**强制重连怎么做(写死 API,避免误用 manager-level destroy)**:

1. 把真正决定私有字段形状的 `discord.js` 从 `^14.14.0` **精确 pin 到 `14.25.1`**;`bun.lock` 同步锁定它解析出的 `@discordjs/ws@1.2.3`。不另加一份可能与 transitive copy 漂移的 `@discordjs/ws` 直接依赖。
2. 用一个带来源注释的本地常量 `WS_SHARD_RECOVER_RECONNECT = 0`(`@discordjs/ws@1.2.3` 的 `WebSocketShardDestroyRecovery.Reconnect`)。
3. 窄适配器读取实际 client 的私有 `client.ws._ws.strategy.shards`,快照所有当前 shard;集合缺失/为空、任一 shard 无 `destroy`、或解析到的 `discord.js` 版本不是 `14.25.1` 时,**永久禁用本进程的强制重连并走 Chunk 3 dead-letter**,不猜 API。
4. 对快照里的**每个 raw shard**直接调用:

```ts
await Promise.all(rawShards.map(shard => shard.destroy({
  reason: 'FLY-2226 inbound dispatch probe timed out',
  recover: WS_SHARD_RECOVER_RECONNECT,
})))
```

**禁止**调用公开的 `client.ws.destroy()`(会置 `destroyed=true`)或 `client.ws._ws.destroy()`(它的 sharding strategy 在 await 每个 shard recovery 后会 `shards.clear()`,导致第二次自愈静默空转)。直接 shard destroy 不清 strategy map,所以第 N 次与第 1 次必须等效。

这个接缝依赖锁定版本的私有字段,所以除了注入单测,还要有一条兼容性测试**连续调用两次**适配器,每次都断言同一真实 strategy map 仍非空、每个 shard 都收到 `recover: 0`,并各自产生 `shardReconnecting → shardReady` 恢复契约;只测一次不算通过。合并后、全舰前再在隔离 lead 连续做两次真实 gateway 验证。

**已知边界(写进文档,不藏)**:探针只能由**经过这个插件登记的 REST 出站**启动。Bridge 的 thread 代发虽然会产生自身 gateway echo、可刷新弱 liveness,但插件看不到其 REST response,不能为它建立逐 id timeout;只在 issue thread 工作的 Lead 因此可能很久没有一次主动探测。配对/权限/普通 reply 等插件内出站都要接登记 helper,不能只覆盖 `sendReplyChunks`。完全没有插件出站时没有判别力。**不为此增加合成心跳消息** —— 那会污染 founder 可见频道。

**测试**
- 出站 → 回声按时到达 → **不**触发,待确认集合清空。
- 回声先到、REST callback 后登记同一 id → 当场对消,健康期不误重连。
- 早到目标回声与大量无关自身回声混合 → TTL/cap 清理后目标仍能对消;过期项与超限项都会回收。
- 出站 → 回声不到 → 到期触发一次强制重连;恢复 deadline 仍超时才告警。
- 出站 → 回声**迟到但在窗口内** → 不触发(边界 ±1s 各一例)。
- **完全没有出站** → 永不触发(静默期零误报回归)。
- 待确认集合有界:超过容量时按插入序淘汰最旧,**不得无界增长**(照 `RECENT_SENT_CAP` 的既有纪律)。
- `pending`/`earlySelfEchoIds` 与 `recentSentIds` 相互独立;探针确认回声后 reply-as-mention 仍命中本地快路。
- 同一 episode 反复 timeout → 总共只调用一次 force reconnect;其 pending 在重连前已清空。
- 连续两个「失聪 → 恢复」episode → 两次都真实调用 raw shard destroy,第二次不得因 strategy map 被清空而空转。
- 告警消息不登记、不生成第二个 timeout。
- **错形状对照组**:只喂「回声按时到达」会让触发分支成为死代码 —— 必须有不到达的用例。

---

### Chunk 3 — 自愈失败的告警出口(自带 token)

触发源:不可恢复的 `shardDisconnect`、强制重连调用失败、或强制重连后的 recovery deadline 超时。`invalidated` 在锁定版本不可达,只保留兼容日志;首次 echo/lifecycle timeout 先尝试单次重连,不把「开始自愈」误报成「自愈失败」。

**硬约束(直接来自 FLY-2062 / 2223 的教训)**:

1. **token 供给自带**。插件已有自己的 `DISCORD_BOT_TOKEN`(`STATE_DIR/.env` 或 env,`server.ts:69-85`)。告警发射**必须**用它,**不得**依赖 Bridge 侧的告警链路 —— 那条链路正是 `no-token` 死信族的发生地,而且**此刻插件与 Bridge 的关系可能已经不可靠**。
2. **目标频道不猜**。在每个 lead 已有的 `STATE_DIR/.env` 中显式配置 `DISCORD_ALERT_CHANNEL=<该 lead chatChannel>`;插件现有 loader 会读到它,不需要改 flywheel runtime。缺失/非 snowflake 与 REST 发射失败同样落 dead-letter,绝不能错发到 `DISCORD_CORE_CHANNEL`(那是 project `generalChannel`,不是 lead chatChannel)。
3. **发射失败要落盘 dead-letter**,不得静默吞掉。落在 `STATE_DIR/gateway-health-dead-letter.jsonl`(该目录插件必然可写,`.env`/`access.json` 都在那儿),内容不含 bot token。
4. **告警正文不可变** —— 同一 episode 反复触发时正文必须一致,否则重试路径会因内容变化而出问题(这条教训来自作废计划 R10,**仍然适用**,原样保留)。

**发到哪**:插件自己的 stderr + 有界 lifecycle log(必留)+ 一条发给 `DISCORD_ALERT_CHANNEL` 的 Discord 消息。发送使用已由 `client.login(TOKEN)` 装载 token 的 `client.rest.post(Routes.channelMessages(...))`,不走 Bridge,并显式绕过 echo 登记 helper。
> 理由:REST 出站在本次事故中**全程正常**,而 gateway 入站是死的 —— 所以「用 REST 报告 gateway 坏了」在故障态下**可用**,这是本次事故实证过的、少数仍然可信的通道。

**测试**
- 自愈失败 → stderr 有记录 + REST 发出一条。
- `DISCORD_ALERT_CHANNEL` 缺失/非法 → 不猜频道、写 dead-letter。
- REST 发射失败 → 写 dead-letter 文件,**不抛**、不影响插件继续服务。
- 同 episode 重复触发 → 只发一次。
- 恢复后再次失聪 → 新 episode,重新发。

---

### Chunk 4 — 交付纪律(外部仓)

| 位置 | 内容 |
|---|---|
| **外部仓 PR**(`xrliAnnie/claude-plugins-official`,`external_plugins/discord`) | Chunk 1-3 的全部代码 + 测试。**merge 需 founder 授权**,本节点不请求。 |
| **flywheel 侧 `__main__` 锚 PR** | 本套设计文档 + 指针/版本记录;不含插件代码 |

上线走既有 `scripts/discord-plugin/`(`update-` / `cutover-` / `check-`,FLY-1676 起带 fleet 级串行锁),**不新造发布路径**。本节点只开 PR,不执行上线。

⚠️ 版本注意:运行时字节在 `.../discord/0.0.5/`,marketplace 指向 fork 的 `main`。**改动落地需要一次 cutover**,否则跑的还是旧字节 —— 这一条要在 PR body 里写明,别让人以为 merge 完就生效了。

**灰度要求**:首版两个功能开关都**缺省 OFF**(漏配 = 不启用,而不是漏配 = 全舰冒险)。全舰 cutover 前,先在所有 lead 的 `STATE_DIR/.env` 写好各自 `DISCORD_ALERT_CHANNEL`,并显式保持 `DISCORD_GATEWAY_WATCH=0`、`DISCORD_ECHO_PROBE=0`;只选一个低风险 lead 同时写 `=1` 打开两条自愈路径,连续完成两次真实 reconnect、跨过至少 10 次真实插件出站且观察满 24 小时,确认零假阳性 / 零空转后再分批打开其余 lead。相同插件字节仍满足 G5,但功能不做同秒全舰冒险。

---

## 4. 上线与回滚

- **功能开关**:两个自愈动作各自独立,首版缺省 **OFF**;只有精确 `=1` 才启用(灰度完成后的后续版本再另行决定是否 default-on):
  - `DISCORD_GATEWAY_WATCH=1` 启用 Chunk 1 的 deadline + 强制重连;即使为 0,监听与双路日志仍保留。Chunk 1 已不是「纯观测无风险」。
  - `DISCORD_ECHO_PROBE=1` 启用 Chunk 2。
- **开关真实注入点**:写入该 lead 的 `$DISCORD_STATE_DIR/.env`,再重启该 lead 才生效。不能依赖外层 shell `export`:两套 launcher 都有 `env -i` 白名单,不会透传新变量。全舰关停意味着改 14 份 `.env` 并重启;这不是零成本旋钮,所以灰度是前置硬门。
- **回滚**:逐 lead 在 `.env` 写 `=0` 并重启即回到当前行为;缺失同样安全地视为 OFF;彻底回滚 = cutover 回上一版插件。
- **无迁移、无 schema 改动、不碰 flywheel 运行时**。

---

## 5. 验收

| 要求 | 怎么验 |
|---|---|
| G1 入站死亡能自愈 | Chunk 2 的回声超时用例 + Chunk 1 从 `shardReconnecting` 启动的 deadline 用例 + episode 单次重连上限 |
| G2 告警自带 token 且失败可见 | Chunk 3 的 dead-letter 用例 |
| G3 生命周期留痕 | `shardReconnecting`/resume/ready/disconnect/error 的 stderr + 有界文件用例;`invalidated` 仅 future-compatible,不计验收 |
| G4 健康期零改变 | 「回声按时到达」「回声早于登记」「完全没有出站」三个零触发用例 |
| G5 全舰生效 | 同一份插件字节 + 灰度后分批开关;每个 lead 需一次性配置自己的 alert channel |

**真机验证**(实施节点做,不是设计节点):在一个隔离的 lead 上人为断开 gateway(如临时阻断 gateway 域名)→ 断言自愈发生且告警发出。**不得**在 founder 可见频道做。

---

## 6. 诚实边界

1. 🔴 **本次事故的具体机理仍未归因**。插件 stderr 全链路不落盘(exploration §8),无法回看当时有没有发生 zombie destroy。设计因此覆盖**两类**故障(§2),而不是押注一类。
   **若 Lead 最终只批 Chunk 1+3(不做自回声),而本次事故实际属于「半聋」形态,则本单不修复本次事故** —— 这个结论会原样留在文档里,不改措辞。
2. **没有经过插件自身 REST helper 的出站时,自回声没有主动判别力**(§Chunk 2 边界)。Bridge 代发只能提供被动的「当前活着」弱信号,不能启动逐 id timeout。
3. **舰队上那三个可疑 lead 无法确证**:`tidal-echo-cos`(08-28)、`belle`(08-29)、`product-lead`(08-31 20:00Z)。`spool mtime` **分不出「聋了」和「没人说话」** —— 两种状态同一个痕迹。本单**不声称**已诊断它们;修复上线后它们若是聋的,会由自愈机制自己解决。
4. **僵尸插件进程**:Lead 04:14 的阴性对照已排除它是本次病因。其**产生与清理机制**本单**不做**,理由是无证据支撑的机制改动是凭空猜测。
5. **本单不改 flywheel 运行时** —— Bridge 侧现有的 issue-thread 兜底保持原样(它在本次事故里救了 2210/2178 那部分,是既有资产,不动它)。

---

## 7. 与作废计划的关系

`plan-superseded-reconcile.md` 是被 founder 砍掉的对账方案,**留档不实施**。它值得留的原因:它跑了 11 轮评审才通过,而最终形态仍要求实现方精确复刻插件 `gate()` 谓词、载荷逐字段等价、四值 provenance 和一套非平凡的 disposition 分类 —— **那份复杂度本身就是砍掉它的最好论据**,founder 的直觉在文档里有账可查。

对比之下,本计划只保留一个**进程内、有界、每 episode 最多重连一次**的恢复状态;它不落业务账、不补消息、不增加合成流量,只消费两个已经在流动却被丢弃的信号。
