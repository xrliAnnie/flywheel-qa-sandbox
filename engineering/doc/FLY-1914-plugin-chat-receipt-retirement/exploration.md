# FLY-1914 Discord 插件 chat-receipt 合同脱节收尾 — 探索

Issue: FLY-1914 (https://linear.app/geoforge3d/issue/FLY-1914/插件合同脱节-discord-插件仍在调已被-808-净删除的-chat-receipt-子命令-settle-永败重试-向-founder)
日期: 2026-08-19
基于: 无

## 1. 问题(实况,含本设计节点当晚复核)

`#flywheel-engineer` 反复出现 `⚠️ Chat receipt settlement recovery has failed N times for message …`。机制:PR #808(FLY-1645)把 `chat-receipt` 子命令族从 flywheel-comm CLI 净删除(回执职能已由 FLY-1574 mailbox 路由接管),但生产 Discord 插件 0.0.4(`~/.claude/plugins/cache/{flywheel-plugins,claude-plugins-official}/discord/0.0.4/`)的 `chat-receipt-runtime.ts` 仍按老合同在每次带真实 `reply_to` 引用的回复后调 `node <commCli> chat-receipt settle` → `Unknown command: chat-receipt` exit 1 → settle intent 落 spool → 恢复循环每 ~3-4 分钟重试 → `attempts > 5` 后向 chatId(founder 可见频道)发 advisory(告警发射点 `chat-receipt-runtime.ts:625`)。

本设计节点复核(2026-08-20 UTC):跑步机**仍在活转**——`discord-flywheel-eng-lead/chat-receipt-spool/settle/` 有 43 条活 intent(Annie 8-19 两次归档之后新堆的),最高 `attempts=26`,最新 `advisedAt=2026-08-20T05:11Z`;`discord-flywheel-product-lead` 另有 4 条。**所有回复本体都真实送达**(每条 intent 都带 replyId)——坏的只是回执记账,零功能损失、纯告警噪音。

## 2. 前史 —— 这不是新问题,是已修未部署的问题

审计推翻了「从零设计修法」的前提。完整链:

| 时间 | 事件 |
|---|---|
| 2026-08-12 | 主仓 PR #808(FLY-1645)merge:CLI `chat-receipt` 命令族净删除,生产 dist 零残留(实测 `grep -c` = 0) |
| 2026-08-12 | **FLY-1730** 立案(同根因,Annie 亲撞 ×6 连发)。走完整设计:3 轮 codex design review,产出 `engineering/doc/FLY-1730-discord-plugin-receipt-desync/` 全套文档 |
| 2026-08-12 | 插件 fork PR #23(supersede #20)开出:退役 receipt settlement runtime + 净删全部 Discord advisory 注入面,bump 0.0.5。**codex code review R2 APPROVED** |
| 2026-08-12 | **独立 QA PASS**(`qa-report.md`),绑定 exact head:主仓 `b06ce21b` + fork `a3117e1c`。真机 A/B 真 Discord:候选插件零告警、旧字节复现 ⚠️ 原文。PASS 边界:不覆盖部署 |
| 2026-08-13 | 主仓半 PR #817(checker dual fork marker)**merge 上线** |
| 2026-08-18 | founder 拍板关 FLY-1730:仓库半已上线;插件半未完成(执行 runner 死亡 5.5 天被收);「症状仍存在则开新单做插件半」 |
| 2026-08-19 | Annie 再撞告警 → **FLY-1914 = 那张新单** |

关键结论:**修复本体已存在、已过审、已过独立 QA,且 fork PR #23 至今 MERGEABLE/CLEAN、head 未动**(`a3117e1c`,与 QA PASS 绑定的 head 逐字一致;fork main 自 8-11 的 `49c8c478` 起未动,恰等于生产 cache 的 gitCommitSha)。FLY-1914 的实质 = **把 FLY-1730 的插件半推过终点线**(preflight 复核 → founder-gated merge → managed 部署 → 真机验收),外加 issue 新增的一条通用规矩。

## 3. 方案空间与决策

### 3.1 修法(issue 给出 ①/②)

| 选项 | 内容 | 判定 |
|---|---|---|
| **① 插件侧退役 receipt runtime(采纳 fork PR #23)** | 与 #808 对齐:settle/begin/complete/pending 全族 CLI 调用面移除,runtime 收敛为 durable mailbox ingest only;advisory 注入面净删(internal plumbing 告警不再有通路可发 founder 频道,降级结构化 stderr log + once-latch) | **采纳**。这是 FLY-1645 的既定终局(收据已死,插件不该假装它活着);已过 3 轮 design review + code review + 独立 QA;零新机制 |
| ② 插件启动时 feature-detect 子命令存在性,不存在则 mode=disabled 静默 | 保留死代码 + 增加探测面 | **拒绝**:给已判死的机器续命,违反 FLY-1730 红线「零新机制、净删除单」;探测本身是新故障面(探测误判 → 静默丢真回执 or 复活告警);且 ① 的成品已在手,② 反而要新写新审新测 |
| ③ 只治告警面(留 settle 重试,不发 founder) | 最小改 | **拒绝**:spool 永久积尸 + CPU 空转重试永续,「永败重试」本身就是 issue 点名不允许的现状;且改动量并不比 ① 小多少 |

### 3.2 通用规矩的形态(issue: 「CLI 净删除子命令的 PR 必须 grep 全部插件缓存目录的调用方」)

| 形态 | 判定 |
|---|---|
| **A. 过程规矩写进仓库 CLAUDE.md**(CLI 合同变更 sweep 条款) | **采纳**:零新机制;CLAUDE.md 每个 session 必载,实现者与 reviewer 都会看到;与既有「Dead code hygiene / grep 引用再删」同族 |
| B. 通用 CI 机械门 | **拒绝**:无法预知未来被删的子命令名,通用化必然要么误报要么漏报;新机制维护成本 > 触发频率。既有的 `scripts/fly1645-receipt-residue-gate.config.json`(跨仓、含 plugin roots)已是 receipt 动词族的机械实例,证明「按具体动词族建门」才是可机械化的粒度 |

本节点已按该规矩做了一次全插件缓存 sweep:两个 discord 0.0.4 缓存共调用 `chat-receipt` / `chat-ingest` / `send` / `complete` 四个动词,后三个在生产 CLI 全部健在——**`chat-receipt` 是唯一 stale 动词**,无第二处断代。

### 3.3 部署面(FLY-1730 验收铁律:交付定义是生产行为改变,不是 merge)

沿用 FLY-1730 plan §4 的 managed runbook(Phase A checker 先行 → Phase B 插件部署 + 终态回执 + 波后 census → Phase C 联动解锁),但本节点审计发现一个**关键未完成步骤**:主仓 #817 虽已 merge 上线,**生产 checker 副本从未收敛**——`~/.flywheel/bin/check-discord-plugin.sh:77` 仍逐字单要求 `ChatReceiptRuntime`(`scripts/install-discord-plugin-ops.sh` 没有跑过)。若跳过此步直接部署 0.0.5,`restart-services.sh` 的 fork recheck 会在任何 Lead mutation 前 fail-close 中止 fleet wave。**Phase A step 2 是本单部署的第一块必踩砖。**

## 4. 诚实边界(不做什么)

- 寄生 runtime ×N 放大器 → FLY-1715(PR #821 在途,不等它;runbook 波后 census 兜住寄生旧进程)
- 频道级内部告警治理 → FLY-1612 家族
- FLY-1645 主仓生产 closeout(`.env` 退休 flag 清除)→ Phase C 之后由持单人解锁,本单不碰
- checker dual marker 收窄回单 marker → 部署收敛后的后续清理单
- mailbox 投递语义(FLY-1573/1574)逐字不碰

## 5. 待 research 确认的问题(→ research.md)

1. fork PR #23 与 fork main 的 preflight 矩阵(head/mergeable/版本占号)——**已确认**,细节进 research.md。
2. 生产部署资产存在性(update-discord-plugin.sh / install-discord-plugin-ops.sh / request-restart.sh)——**已确认存在**。
3. `FLYWHEEL_MAILBOX_DISCORD=1` 是否仍在生产 .env(二级回滚的前提)——**已确认在**。
4. 通用规矩在 CLAUDE.md 的具体落点与措辞 → plan.md。
