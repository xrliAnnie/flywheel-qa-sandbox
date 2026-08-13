# FLY-1730 Discord 插件 chat-receipt 配套断代 — 调研

Issue: FLY-1730 (https://linear.app/geoforge3d/issue/FLY-1730/bug配套断代-discord-插件仍调用已拆除的-chat-receipt-cli-每条-founder-消息结算永败内部告警直喷)
日期: 2026-08-12
基于: exploration.md

全部为 2026-08-12 当天真机/真仓实证,非推断。

## 1. 故障链逐环实证

### 1.1 CLI 侧:`chat-receipt` 命令族已拆除

- `packages/flywheel-comm/src/index.ts` 命令 switch 里有 `chat-ingest`(:222),**没有** `chat-receipt` case(#808 / FLY-1645 删除)。
- 真机执行:`node …/flywheel-comm/dist/index.js chat-receipt settle …` → stdout `Unknown command: chat-receipt`,**exit 1**。
- `chat-ingest` 健在(mailbox 通路,FLY-1574/1645 保留面)。

### 1.2 插件侧:生产 cache 仍是拆除前的调用面

生产插件 = `~/.claude/plugins/cache/flywheel-plugins/discord/0.0.4/`,`installed_plugins.json` 记录 `gitCommitSha: 49c8c478`(= fork main 最新 commit,FLY-1574 PR #18,2026-08-11 装入)。`chat-receipt-runtime.ts`(1208 行)保有完整 `chat-receipt` CLI 族调用:

| 调用 | 位置(cache 文件行号) | 触发条件 |
|---|---|---|
| `chat-receipt begin` | `invoke('begin', …)` :203, :562 | 入站消息 legacy 路径(mailbox flag 关时)+ spool 恢复重放 |
| `chat-receipt complete` | :286 | 投递完成结算 |
| `chat-receipt settle` | `invokeSettle` :790→:791 | **每次带 `reply_to` 的出站回复**(server.ts :1253 `chatReceiptRuntime.settle(reply_to, id, chat_id)`) |
| `chat-receipt pending` | :651 | 恢复循环 pending 对账 |
| `chat-receipt quarantine` | :684 | 超 48h pending 隔离 |

### 1.3 事故签名的精确机理(settle 路径)

`settle()`(runtime :310)是 write-ahead 设计:先落 durable settle intent(`chat-receipt-spool/settle/<messageId>.json`),再调 CLI;CLI exit 1 → `kickWorker()` → 恢复循环 `drainSettlePass`(:593)每轮重试;`intent.attempts > FILE_RETRY_ADVISE_AFTER(=5)` 且未 advise 过 → `advise(intent.chatId, "Chat receipt settlement recovery has failed N times for message …")`(:623-627)→ server.ts 的 advise 闭包(:1014-1019)`channel.send({content: '⚠️ ' + text})` **直发消息来源频道**(founder 消息 ⇒ founder 频道)。与 Annie 撞见的告警逐字吻合。

- 生产 `~/.flywheel/.env` 有 `FLYWHEEL_MAILBOX_DISCORD=1` ⇒ 入站走 `ingest()`(chat-ingest,健康),`begin` 不被日常触发;**settle 与 flag 无关,每次 reply_to 回复必调** ⇒ 事故只呈现 settle 签名。若 flag 被撤(见 §5.3),begin 路径会以同样方式坏掉。
- ×6 同文 = 6 个寄生 bun runtime 并发扫同一 spool,在 `advisedAt` 落盘前各发一条(FLY-1715,已止血;样本已交)。

### 1.4 止血失效中(设计紧迫性证据)

Lead 11:2x 归档 12 个死 intent 至 `/tmp/settle-intent-archive-20260812/`(实核 12 个文件,含事故消息 `1537154904257204294`;其中 4 个是 8-09/8-10 的陈年失败——settle 通路在旧栈上早有失败史)。**归档后到 11:26,又积 8 个新 settle intent**(eng-lead 4 / product-lead 3 / cos-lead 1,mtime 11:14–11:26),每个都会在攒满 5 次失败后再喷一条。生产 12 个 `discord-*` state dir 中 3 个在持续出血。

### 1.5 生产在跑的插件进程

`ps` 实测 ~9 个 `bun …/discord/0.0.4/server.ts` 进程(多数 10:14–10:15 起,= 今晨重启批)。插件进程是 Lead(及 FLY-1715 bug 下 runner)session 的 MCP 子进程:**cache 更新不影响已在跑的进程,必须重启载体**。

## 2. 修复载具:fork PR #20 的精确状态

repo `xrliAnnie/claude-plugins-official`(经 pointer marketplace 供给生产),分支 `flywheel-FLY-1645-plugin`,head `3c72cd9`,base main,**MERGEABLE**,零 review 零 comment(FLY-1645 里程碑「双仓 PR + exact-head code review pending」的插件半边)。

改动面(PR 文件清单):

| 文件 | +/- | 内容 |
|---|---|---|
| `chat-receipt-runtime.ts` | +31/-671 | 类改名 `ChatIngestRuntime`;删 begin/complete/settle/pending/quarantine 全族与恢复循环;只剩 `chat-ingest` 调用(:198 capability probe、:306 invokeIngest)与 ingest intent 恢复;文件名保留 |
| `chat-receipt-recorder.ts` | +18/-47 | 删 receipt 元数据与 rollout flag(`readMailboxDiscordFlag` 族);保留 `RecorderMode` capability 三元组(commCli/dbPath/leadId)判定 |
| `server.ts` | +52/-92 | `chatIngestRuntime` 接线;**reply 路径的 settle 调用整删**(PR #20 版 server.ts grep 零 `settle`);MCP 文案改 delivery 口径 |
| 两个 test 文件 | -937 净 | 对应删除;`bun test` 173 绿 |
| `.github/workflows/validate-discord-runtime.yml` | +27 | path-scoped CI 跑插件测试套件 |
| fixture / FLY-1437 doc | -88 | flag fixture 与旧实现文档清理 |

PR body 声明:cross-repo FLY-1645 semantic residue gate passed(主仓 `scripts/fly1645-receipt-residue-gate.config.json` 为门配置)。

### 2.1 PR #20 之后仍存的告警面(FLY-1730 delta 的对象)

PR #20 版 runtime 仍经 `advise(chatId, …)` → server.ts `channel.send('⚠️ …')`(:1004-1009)直发来源频道的 4 类 internal plumbing advisory:

| # | 位置(PR #20 runtime 行号) | 文案 | 触发 |
|---|---|---|---|
| 1 | :140 | "Discord mailbox ingest could not persist recovery … may require manual replay" | ingest intent 写盘失败 + 两次立即 ingest 均失败 |
| 2 | :252(`adviseWithMarker`) | "…corrupt ingest intent…" | 腐坏 intent,once-latch |
| 3 | :275 | "Discord mailbox ingest is stalled for message …" | chat-ingest 持续失败 >5min,per-intent once |
| 4 | :172 `adviseBroken`(marker) | "…wiring is incomplete…" | capability 三元组缺失(broken 模式);server.ts :94 启动时已另有 stderr 同义警告 |

## 3. 部署机制实证(当前现实,非 1676 未来态)

- 供给链:`~/.flywheel/marketplaces/flywheel-plugins/.claude-plugin/marketplace.json` → `source: git-subdir, url: xrliAnnie/claude-plugins-official.git, path: external_plugins/discord, ref: main`。
- 更新命令:**`claude plugin update discord@flywheel-plugins`**(FLY-1676 plan R1 实证:`claude plugin marketplace update` 只刷 manifest 不更新已装插件)。
- **版本号单点**(1676 operator card §3):fork main 前进必须 bump `plugin.json` patch,同版本改写 → CLI 报 already latest、registry 停旧 SHA。当前 fork main 与 cache 均为 `0.0.4`(与上游官方同号;8-11 是首次安装而非同版本更新,该坑尚未在生产踩过,不赌)⇒ 本单 bump `0.0.5`。
- 验证锚:`installed_plugins.json` 的 `gitCommitSha` == fork main 新 SHA;cache 内容含/不含哨兵;`ps` 中所有 `bun …server.ts` 的 argv 路径指向新版本目录。
- 载体重启:统一重启走标准入口(FLY-1671 `scripts/request-restart.sh` → updater → `restart-services.sh`;FLY-1663 后 Lead 为 launchd v2 载体,重启后 session 重新 spawn 插件子进程)。禁手敲 tmux/cmux(FLY-1596 纪律)。

## 4. 兼容性矩阵(为什么现在部署不需要 quiesced fence)

| 插件 \ CLI | 旧 CLI(有 chat-receipt) | 新 CLI(#808,现生产) |
|---|---|---|
| 旧插件(0.0.4 现生产) | 正常(8-11 前的世界) | **断代(本事故)** |
| 新插件(PR #20+delta) | 兼容(chat-ingest 两边都有;FLY-1645 plan §风险明写) | **目标态** |

主仓已在新 CLI ⇒ 部署新插件是纯改善方向,cache 更新与重启顺序无混窗风险(旧进程继续坏 = 现状,新进程即好)。1645 plan §5 的 quiesced fence 是为「两仓同窗切」设计的,单边补齐不需要。

## 5. 交互与排序约束

### 5.1 FLY-1676(PR #19,sync 管线 cutover)
未合入、有硬前置(FLY-1679 等)+ 冻结窗纪律。FLY-1730 是生产出血修复,**先行落地**;落地后 1676 的「20 个定制 patch 盘点」过期,cutover 前必须重新盘点(+1730,若 1710 已落再 +1)。1730 的手动 version bump 与 1676 workflow 的自动 bump 不冲突(它从当前值继续 bump)。

### 5.2 FLY-1710(fork PR #21,chat ingest Lead ownership)
OPEN,改 ingest 归属判定,与本单同文件邻域。先落者赢,后落者 rebase;语义正交。

### 5.3 FLY-1645 生产 closeout(排序硬约束)
closeout 步骤含「从生产 `.env` 删三条退休 flag」。**旧插件仍在读 `FLYWHEEL_MAILBOX_DISCORD`**(cache recorder `readMailboxDiscordFlag` ← `~/.flywheel/.env`):若在本单部署前删 flag,入站被打回 legacy `begin` 路径 → `chat-receipt begin` 同样 exit 1 → 每条入站消息一个 spool intent + 第二轮告警风暴。⇒ **`.env` 退休 flag 清除必须排在本单「cache 更新 + 载体重启完成」之后**;之后该 flag 对新插件彻底 inert(PR #20 已拔读取)。

### 5.4 FLY-1715 / FLY-1612(明确不做)
- 1715(寄生 runtime ×N 放大):本单不修寄生;但 chat-receipt 告警类被整体删除后,寄生场景下也**无此类告警可发**(issue 验收第 3 条的达成机理)。注意:已在跑的旧寄生进程在载体重启前仍持旧代码——验收观察窗以重启波完成、`ps` 零旧路径进程为前提。
- 1612(告警治理):频道级内部告警可见性归它;本单把插件侧 plumbing advisory 降为 stderr log 即完成本单侧对齐。

## 6. 残留资产盘点(部署后清理对象)

- `~/.claude/channels/discord-*/chat-receipt-spool/settle/*.json` — 新 runtime 不读,死文件(当前 8 个,还在涨)。
- `~/.claude/channels/discord-*/chat-receipt-spool/*.json`(根部 begin intent)+ `meta/` 各 advise marker — 同为死文件(当前 0 个 begin intent;meta marker 少量)。
- `chat-receipt-spool/ingest/` — **仍活**(PR #20 逐字保留 ingest spool 兼容),不许动。
- spool 目录名 `chat-receipt-spool` 本身保留(PR #20 决策:文件名兼容优先于改名洁癖)。
