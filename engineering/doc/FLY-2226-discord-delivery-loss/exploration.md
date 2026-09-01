# FLY-2226 founder Discord 消息选择性丢投 — 探索

Issue: FLY-2226 (https://linear.app/geoforge3d/issue/FLY-2226/通信投递丢失-founder-discord-消息选择性丢投2216-thread-从出生就聋-engineer-顶层-0325z)
日期: 2026-09-01
基于: 无

---

## 0. 一句话结论

不是两个可分病灶,是**一个真因 + 一个放大器**:Tadashi 的 Discord 插件在 `00:47:32Z` 之后 inbound 单向失聪(进程活着、outbound 正常、无任何检测),而 Bridge 侧那条只覆盖「有非终态 session 的 issue thread」的兜底通道恰好还在工作 —— 它的**部分可用**把一次彻底失聪伪装成了随机丢包,让 founder 三小时都以为只是没人理她。

issue 自带的假设 A(「2216 thread 因为建法不同所以从出生就聋」)**被证伪**:2216 thread 出生于 `00:48:55Z`,比插件失聪**晚 82 秒**。

---

## 1. 判别器:是谁写的这条 mailbox 行

这是整个取证的支点。两个写入者对 `authorName` 取的是**不同字段**:

| 写入者 | 代码位置 | authorName 取值 | 实测值 |
|---|---|---|---|
| Discord 插件 (MCP) | `server.ts:1605` `msg.author.username` | Discord **用户名** | `xrliannie_96634` |
| Bridge 兜底 | `founder-reply-deliverer.ts:438` `msg.author.global_name ?? username ?? ...` | Discord **显示名** | `Annie` |

这不是巧合归纳,是先读代码确认两条路径取不同字段,再拿实测数据对照。实测结果(`comm.db` `mailbox` 表,`id LIKE 'chat:flywheel-eng-lead:%'`):

```
00:40:46  "authorName":"xrliannie_96634"   ← 插件
00:41:27  "authorName":"xrliannie_96634"   ← 插件
00:46:00  "authorName":"xrliannie_96634"   ← 插件
00:47:32  "authorName":"xrliannie_96634"   ← 插件(最后一条)
────────────────── 分界线 ──────────────────
00:51:32  "authorName":"Annie"             ← Bridge
02:09:34  "authorName":"Annie"             ← Bridge
02:10:58  "authorName":"Annie"             ← Bridge
02:12:13  "authorName":"Annie"             ← Bridge
03:02:06 / 03:02:43 / 03:03:21             ← Bridge
03:38:52 / 03:42:03 / 03:58:19             ← Bridge
```

**00:47:32Z 之后 3 小时 24 分,插件投递数为 0。**

独立佐证(不同来源、同一结论):插件的 ingest spool 目录 `~/.claude/channels/discord-flywheel-eng-lead/chat-receipt-spool/ingest` 的 mtime 精确停在 `2026-09-01T00:47:33Z`。插件每收一条消息都会在这里落一个 intent 文件、投递成功后删除,两个动作都会更新 mtime;mtime 冻结 = 此后一条都没收到过。

---

## 2. 完整因果链(每个数据点都被解释,无剩余)

```
00:40:46 / 00:41:27 / 00:46:00  顶层    插件投递 ✅  founder 说「都秒回了」
00:47:32                        thread  插件投递 ✅  ← 插件最后的呼吸
00:47:33                        插件 inbound 死亡(进程存活、outbound 正常、零告警)
00:48:55                        FLY-2216 thread 创建  ← 比失聪晚 82 秒
00:51:41  2216 thread  「开始做吧」     ✗ 丢失(插件已死;2216 无 session,Bridge 不扫)
02:11:59  2216 thread  三段/两段问题     ✗ 丢失(同上)
03:25:17  顶层        OAuth 截图        ✗ 丢失(插件已死;顶层 Bridge 永不覆盖)
03:26:06  顶层        quota 3%          ✗ 丢失(同上)
03:39:27  顶层        「你怎么一直没回」 ✗ 丢失(同上)
03:40:16  2216 thread 「怎么还没回我」   ✗ 丢失(同上)
03:53:34                        FLY-2216 session 起跑 → 2216 thread 进入 Bridge 扫描集
03:58:19  2216 thread 「2216 test」      ✅ Bridge 投递 —— 同一个 thread,只因多了 session
```

期间「正常投递」的对照消息(00:51 / 02:09 / 02:10 / 02:12 / 03:02 / 03:38 / 03:42)的 `chatId` 全部是 **2178 / 2210 / 1955 三个 issue thread**,它们的 session 早在 8-31 就 running,一直在 Bridge 扫描集里。

**最强的一个判别点**:`03:58:19` 的「2216 test」和丢失的三条在**同一个 thread**、**同一个人**发的。唯一的差别是 `03:53:34` 起跑的那个 session。这一条就排除了「这个 thread 的建法有问题」的全部解释空间。

---

## 3. 两条投递面各自的覆盖边界

```
                          顶层频道   有 session 的 issue thread   无 session 的 issue thread   DM
插件 (MCP, 主通道)          ✅              ✅                          ✅                    ✅
Bridge 兜底                 ❌              ✅                          ❌                    ❌
```

Bridge 兜底的扫描集在 `gate-poller.ts:2164` `founderReplyDeliverPass()` 里构造:

```
listNonTerminalSessions()
  → 按 lead 过滤
  → getChatThreadByIssue(session.issue_id, lead.chatChannel)
  → 只有这些 thread_id 会被拉取消息
```

顶层频道**从不进入**这个集合 —— Bridge 只枚举 issue thread。所以顶层频道对插件是 **100% 单点依赖**,插件一死就是彻底静默,没有任何第二条腿。

---

## 4. 为什么三小时没人发现(可观测性的负空间)

三层检测**全部缺席**:

1. **插件自身无 gateway 存活检测**。`server.ts` 只注册了 4 个 handler:`error` / `interactionCreate` / `messageCreate` / `ready`。没有 `shardDisconnect`、`invalidated`、`shardResume`、`shardError`,也没有 inbound 心跳。一个静默死掉的 WebSocket 在这份代码里**完全无声**。
2. **插件 stderr 无处可查**。`~/Library/Caches/claude-cli-nodejs/.../mcp-logs-plugin-discord-discord/*.jsonl` 只记录 MCP 工具调用与其返回,不透传 server 进程的 stderr。就算插件往 stderr 写了 gateway 报错,也没有任何地方能读到。
3. **现存审计脚本查不了「零到达」**。`scripts/audit-discord-mailbox-ingest.sh` 检查的是**已到达行的形状**(carrier 是否为 inbox、delivery_id 是否自洽、有无重复、有无死信)。零到达时它每一项都是 0,**全绿**。而且它是手动脚本,没有被任何调度器调起。

这正是「**对照组也是零 ⇒ 什么都没证明**」那一族失效模式的实例:所有现存检测量的都是「坏消息的形状」,没有一个量「好消息的缺席」。

---

## 5. 被证伪 / 被排除的假设

| 假设 | 结论 | 依据 |
|---|---|---|
| A. 2216 thread 建法不同(message-attached vs 独立 thread)导致投递面不同 | **证伪** | 2216 出生比失聪晚 82 秒;同一 thread 在 session 起跑后立刻可投。锚消息缺 `<#threadid>` 只是 `ChatThreadCreator` 里**新建**(`:366`,无链接)与**复用**(`:1455` `postChannelNotification`,有链接)两条文案分支的外观差异,和投递路径无关 |
| access.json 政策 drop | **排除** | 顶层 `requireMention:false`,`gate()` 走 `deliver` 分支;且 gate drop 也不会让 spool mtime 冻结 3 小时 |
| ingest spool 积压 | **排除** | `ingest/` 为空,mtime 冻结在 00:47:33 —— 是**根本没有新 intent 写入**,不是写了没消费 |
| 插件进程死亡 | **排除** | pid 23059 全程存活,03:47/03:52 还成功执行了 MCP `reply`(outbound 活着) |
| 僵尸插件同 token 双连互踢 gateway | **就 pid 1485 而言不成立;pid 86404 未证实** | 见下方取证边界 |

---

## 6. 取证边界(诚实说明)

- issue 点名的两个僵尸插件进程 **pid 1485 / 86404 在我取证过程中已经退出**,取证窗口关闭,无法再核。
- 退出前我读到 **pid 1485** 的环境**不含** `DISCORD_BOT_TOKEN`,它会回落到 `~/.claude/channels/discord/.env`,那里的 bot id 是 `1499895683287748679`,与 Tadashi 的 `1516207680836866219` **不是同一个身份**。就 1485 而言,「同 token 双连互踢」不成立。
- **pid 86404 的环境我没有读到**(`ps eww` 返回空)。这一条标记为**未证实**,不写进结论,也不作为「已排除」。
- **失聪的具体机理仍未知**:gateway 心跳超时未被 discord.js 感知 / session invalidate 后放弃重连 / 其它 —— 本次取证没有拿到指向某一条的直接证据,只有「进程活、outbound 活、inbound 死、无日志」这个症状指纹。设计必须据此选择**不依赖具体病因**的防线。

### 6.1 正向控制:重启即愈(2026-09-01 04:16Z,Lead 执行)

Lead 重启了插件进程做止血,这顺带给了我们一个干净的正向控制:

| 时刻 (UTC) | 事件 |
|---|---|
| 00:47:32 → 04:16:47 | 插件投递数 **0**(3 小时 29 分) |
| 04:16:48 | 插件进程重启(旧 pid 23059 → 新 pid 51167) |
| 04:17:58 | **第一条插件投递行**出现(`authorName: xrliannie_96634`),spool mtime 同步复活 |

重启前后**没有改动任何 access.json、配置或权限**,唯一变量是进程本身。这排除了策略/配置/权限类解释,把病因锁定在**进程内的 gateway 连接状态**:连接以一种 discord.js 既不上报、也不自愈的方式死掉了,而同一进程继续正常服务 MCP 工具调用与 REST 出站。

这条正向控制同时说明:**重启是有效的自愈动作** —— 自愈层只要能「察觉 + 重启」就够,不需要先搞懂 gateway 内部到底怎么死的。

---

## 7. 这决定了设计的形状

真因的**具体机理未知且可能复发为别的形态**,所以防线不能只押在「修好这一个 gateway bug」上。三层各司其职:

1. **检测层(必须)**:量「投递的缺席」而不是「错误的存在」。这是唯一能防住「下次换个别的原因失聪」的一道。
2. **兜底层**:把 Bridge ingress 的覆盖面从「有 session 的 issue thread」扩到能真正兜住本次两类丢失的范围;代价是健康期双写,必须有去重与「不重复唤醒 Lead」的硬约束。
3. **自愈层(治本,跨仓)**:插件侧补 gateway 存活检测与自愈。插件源真身在外部仓 `xrliAnnie/claude-plugins-official` 的 `external_plugins/discord`,flywheel 本仓只有 `scripts/discord-plugin/` 的指针更新与 cutover 工具 —— 跨仓交付,应拆为独立后续单。

> 边界重申:本单**不做** FLY-2222(delivered ≠ actionable,投了但没看见)的问题。本单只保证「必达 mailbox」。
