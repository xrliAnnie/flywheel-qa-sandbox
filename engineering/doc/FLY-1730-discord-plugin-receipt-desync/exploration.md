# FLY-1730 Discord 插件 chat-receipt 配套断代 — 探索

Issue: FLY-1730 (https://linear.app/geoforge3d/issue/FLY-1730/bug配套断代-discord-插件仍调用已拆除的-chat-receipt-cli-每条-founder-消息结算永败内部告警直喷)
日期: 2026-08-12
基于: 无

## 1. 问题是什么

2026-08-12 11:09 PT,Annie 在 founder 频道亲撞 6 条同文告警:

> `⚠️ Chat receipt settlement recovery has failed 6 times for message 1537154904257204294.`

三层根因交汇(全部实证,见 research.md):

1. **配套断代(本单要修的)**:主仓 #808(FLY-1645 收据机器拆除)删掉了 flywheel-comm 的 `chat-receipt` 命令族,今天 10:13 随 4f246f52 首次上线。但生产 Discord 插件(`~/.claude/plugins/cache/flywheel-plugins/discord/0.0.4/`,fork main @ `49c8c478` = FLY-1574 状态)没有配套更新——每次 Lead 带 `reply_to` 回复,插件仍调 `node <commCli> chat-receipt settle ...` → `Unknown command: chat-receipt` exit 1 → settle 永败 → 落 durable settle intent → 恢复循环每 ~3-4 分钟重试 → `attempts > 5` 后向消息来源频道(= founder 频道)发 advisory。**只要不修,每条被回复的 founder 消息 = 十几分钟后一条告警,永续。**
2. **×6 放大器**:6 个寄生 bun 插件进程并发扫同一 spool(FLY-1715 的病,Lead 已现场杀掉止血)。
3. **告警治理**:internal plumbing advisory 直发 founder 频道、跨进程零去重(FLY-1612 家族,样本已交)。

本单只治第 1 层,同时按 issue 指令把第 3 层在**插件侧**的口径对齐(见 §3 决策 2)。

## 2. 最关键的探索发现:修复已经被写好了,只是没上船

审计推翻了「要从头写拆除代码」的默认假设:

- **fork PR #20**(`xrliAnnie/claude-plugins-official`,分支 `flywheel-FLY-1645-plugin`,head `3c72cd9`)就是 FLY-1645 的插件侧配套拆除:删掉 begin/complete/pending/settle/quarantine 全族 CLI 调用面与恢复循环,runtime 从 1208 行减到 568 行,只保留 mailbox `chat-ingest` 通路(文件名与 ingest spool 兼容逐字保留);`bun test` 173 绿;跨仓 FLY-1645 残留门通过;对 fork main **MERGEABLE**。
- 它 OPEN 未合、零 review、未部署——FLY-1645 里程碑写的「双仓 PR + exact-head code review pending」正是它。
- FLY-1645 自己的 plan §风险清单早写明:「**若 plugin merge 先行而主仓延后 = 兼容**(chat-ingest 已存在);反向不兼容」。实际 ship 顺序恰好走了不兼容方向(主仓先上、插件没动),这就是断代的机理。

因此本单的性质从「设计一个修复」收敛为「**把已写好的拆除接上生产,并补齐 issue 指令要求的告警面与部署面**」。

## 3. 方案空间与取舍

### 决策 1:交付载具 — 采纳 PR #20 还是重写?

| 选项 | 说明 | 判定 |
|---|---|---|
| **A. 采纳 PR #20 为基底 + FLY-1730 delta(推荐)** | 从 `3c72cd9` 起新分支,保留原 commit(FLY-1645 归属),叠加 FLY-1730 的告警面 delta + 版本号 bump;单 PR、单次 founder-gated merge、单次部署 | ✅ 已过残留门与 173 测;founder 偏好合并 held PR 栈,不摊两次 ship |
| B. 让 PR #20 原样先合,FLY-1730 再开小 PR | 两次 review、两次 founder gate、两次部署窗 | ✗ 流程重一倍,期间告警继续喷 |
| C. 从头重写拆除 | 重复劳动,重新过残留门 | ✗ 无收益 |

### 决策 2:告警面 — 剩余 advisory 去哪?

PR #20 拆掉了本次事故的 settle/begin 告警族,但仍保留 4 类经 `advise(chatId, …)` 直发消息来源频道的 internal plumbing advisory(ingest 应急/腐坏 intent/ingest 停滞/接线 broken)。issue 硬指令:「即便保留过渡告警,internal plumbing advisory 不得发 founder 频道(改 log / alerts 通道)」;红线:「零新机制,净删除单」。

| 选项 | 说明 | 判定 |
|---|---|---|
| **A. 全部降级为结构化 stderr log,整删 advise 通道(推荐)** | 删 `AdviseFn`/`advise` option/`adviseWithMarker`/`adviseBroken` + server.ts 里 `channel.send('⚠️ …')` 闭包;保留 per-intent 一次性 latch 防 log 刷屏 | ✅ 满足硬指令 + 净删除;插件从此**物理上没有**向聊天频道发 plumbing 告警的通路 |
| B. 插件接 #flywheel-alerts / lead-alert.sh | 内部告警仍有频道可见性 | ✗ 插件侧新接线 = 新机制,撞红线;这是 FLY-1612 的地盘 |
| C. 保持 PR #20 原样(advisory 仍发频道) | 最小 diff | ✗ 直接违反 issue 硬指令;下一次 ingest 故障又会喷 founder 频道 |

**诚实边界**:选 A 后,插件侧 ingest 故障的可见性 = Lead 载体 stderr 日志(+ 未来 FLY-1612 的告警治理接管频道级可见性)。founder 消息若 ingest 永败,表征是「Lead 不回」而非频道告警——这个 tradeoff 在 plan 与 founder HTML 里明说。

### 决策 3:部署面 — 怎么真正到生产?

issue 硬指令:「交付必须含『装进生产 plugin cache + 重启载体验证』,不能只 merge repo」——这正是断代的教训镜像。

- 现实管线(FLY-1676 Phase 3 已落、PR #19 cutover 未落):pointer marketplace `flywheel-plugins` → `claude plugin update discord@flywheel-plugins` 从 fork main 拉取(实证:`marketplace update` 只刷 manifest,**必须** `plugin update <plugin>` 才更新已装插件)。
- **版本号是舰队可用性单点**(1676 operator card):同版本改写会被 CLI 判 already latest。⇒ 本单 fork PR 必须 bump `plugin.json` 0.0.4 → 0.0.5。
- 载体重启:插件进程是 Lead session 的子进程;cache 更新后旧进程仍跑旧代码,必须走标准统一重启(禁手敲 tmux,FLY-1596 纪律)。
- **好消息**:主仓已在新 CLI 上,「新插件 + 新 CLI」即目标态,且 FLY-1645 已证「新插件 + 旧 CLI」也兼容 ⇒ **不再需要 1645 plan §5 那套 quiesced fence**,普通「更新 cache → 统一重启」即安全。

被否的部署替代:直接改生产 cache 文件热修(hot-patch)——不可审计、绕过 fork 管线、下次 `plugin update` 即被冲掉,恰是把事故的病根(repo 与 cache 脱钩)再造一遍。

### 决策 4:遗留 spool 残骸

新 runtime 不再读 `settle/` 与根部 begin intent(只保 `ingest/`)。死文件不迁移、不解释——部署后归档清理(与 Lead 11:2x 的止血归档同款),让验收「spool 零新 intent」从干净地板起算。

## 4. 收敛方向(进 research/plan)

1. 载具 = PR #20 基底 + FLY-1730 delta(告警面净删 + `plugin.json` 0.0.5 + 测试更新),单 fork PR,supersede #20。
2. 主仓侧零代码改动:只有本 doc 文件夹 + CLAUDE.md 里程碑(随本分支 PR)。
3. 部署 runbook 与验收(真机 founder 频道两条消息、15 分钟观察窗)写死进 plan,交付定义 = 生产 cache + 载体重启后验证,不是 merge。
4. 排序约束:先于 FLY-1676 PR #19 cutover 窗;FLY-1645 closeout 的「从生产 .env 删退休 flag」**必须等本单部署完**(旧插件还在读 `FLYWHEEL_MAILBOX_DISCORD`,先删 flag 会把入站打回 legacy begin 路径造成第二轮告警);与 FLY-1710 PR #21 互为 rebase 邻居。
