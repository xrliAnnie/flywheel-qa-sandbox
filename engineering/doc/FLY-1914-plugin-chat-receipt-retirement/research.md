# FLY-1914 Discord 插件 chat-receipt 合同脱节收尾 — 调研

Issue: FLY-1914 (https://linear.app/geoforge3d/issue/FLY-1914/插件合同脱节-discord-插件仍在调已被-808-净删除的-chat-receipt-子命令-settle-永败重试-向-founder)
日期: 2026-08-19
基于: exploration.md

> 时态标注:每条结论标 `[生产现状]` / `[fork PR]` / `[合并部署后]`。所有 `[生产现状]` 均为本设计节点 2026-08-20 UTC 当晚实测,as-of 见各行;这些结论**会过期**,implement/ship 节点动手前须按「过期复核」列重测。

## 1. 事实清单(全部实测,含复核命令)

### 1.1 断代本体

| # | 事实 | 证据 / 复核命令 | as-of |
|---|---|---|---|
| F1 | `[生产现状]` 主仓 PR #808 已 merge(2026-08-12T00:45Z),`packages/flywheel-comm/src/commands/chat-receipt.ts` 等整族删除 | `gh pr view 808 --json mergedAt,files` | 恒久(已 merge) |
| F2 | `[生产现状]` 生产 CLI dist 零 `chat-receipt` 残留;`chat-ingest` 健在 | `grep -c chat-receipt ~/Dev/flywheel/packages/flywheel-comm/dist/index.js` = 0;`node …/dist/index.js chat-ingest --help` 报 unknown **option**(命令存在) | 08-20 |
| F3 | `[生产现状]` 两处生产插件缓存均为 0.0.4 且含完整 receipt runtime:`discord@flywheel-plugins`(gitCommitSha `49c8c478`)与 `discord@claude-plugins-official`(`d56d7b61`,legacy overlay) | `installed_plugins.json`;`ls ~/.claude/plugins/cache/*/discord/0.0.4/chat-receipt-runtime.ts` | 08-20 |
| F4 | `[生产现状]` 告警发射点:`chat-receipt-runtime.ts:625`,原文 `Chat receipt settlement recovery has failed ${attempts} times for message ${messageId}` | `grep -n "settlement recovery has failed" ~/.claude/plugins/cache/flywheel-plugins/discord/0.0.4/chat-receipt-runtime.ts` | 随 0.0.4 字节固定 |
| F5 | `[生产现状]` 跑步机活转:`discord-flywheel-eng-lead/chat-receipt-spool/settle/` 43 条活 intent(晚于 Annie 8-19 两次归档 `settle-archive-fly1914-*`),最高 `attempts=26`,最新 `advisedAt=2026-08-20T05:11Z`;`discord-flywheel-product-lead` 另 4 条 | `ls …/settle | wc -l`;读最新/最旧 intent JSON | **08-20 快照,持续增长** |
| F6 | 触发收窄(FLY-1730 QA §1.2,非全部消息):只有 Lead 回复**带真实 reply 引用**(`reply_to` && `sentMessageCarriesReference`)才走 settle;不带引用的发言不产 intent | 生产 `server.ts:1248-1252` 门条件 | 随 0.0.4 字节固定 |
| F7 | 全插件缓存 stale 动词 sweep:两个 discord 0.0.4 缓存共调 `chat-receipt`/`chat-ingest`/`send`/`complete` 四个 CLI 动词,仅 `chat-receipt` stale——**无第二处断代** | `grep -rhoE "'(chat-receipt|chat-ingest|send|…)'" <cache>/server.ts <cache>/chat-receipt-runtime.ts` | 08-20 |

### 1.2 已有修复资产(FLY-1730 遗产)

| # | 事实 | 证据 / 复核命令 | as-of |
|---|---|---|---|
| F8 | fork PR #23(`fix/FLY-1730-receipt-cli-desync`,supersede #20):退役 settlement runtime + 净删 advisory 注入面 + bump 0.0.5;**MERGEABLE / mergeStateStatus=CLEAN**;head `a3117e1c` | `gh pr view 23 --repo xrliAnnie/claude-plugins-official --json mergeable,mergeStateStatus,headRefOid` | **08-20,会过期**——merge 前 JIT 重读 |
| F9 | fork main head = `49c8c478`(2026-08-11,PR #18)= 生产 flywheel-plugins cache 的 gitCommitSha——**fork main 自 PR #23 开出后零漂移** | `gh api repos/xrliAnnie/claude-plugins-official/branches/main` | **08-20,会过期** |
| F10 | fork main `plugin.json` version = 0.0.4 → PR #23 的 0.0.5 **占号仍有效**;fork 开放 PR 队列 #14/#15/#19/#20/#21/#22 均未占 | `gh api …/contents/….claude-plugin/plugin.json?ref=main`;`gh pr list --state open` | **08-20,会过期**——若 #21/#22 先落,版本顺延(FLY-1730 plan §2.2 D3) |
| F11 | PR #23 已过 codex code review R2 APPROVED + **独立 QA PASS 绑定 exact head `a3117e1c`**(真机 A/B 真 Discord:候选零告警、旧字节复现 ⚠️);QA 明示不覆盖部署 | CLAUDE.md FLY-1730 里程碑行;`engineering/doc/FLY-1730-discord-plugin-receipt-desync/qa-report.md` §0 | head 不动即有效;**head 一动全作废**(rebase → 重测重审,FLY-1730 plan §2.1) |
| F12 | 主仓半 PR #817(checker dual fork marker:`ChatReceiptRuntime` **或** `ChatIngestRuntime`)已 merge(2026-08-13T00:39Z) | `gh pr view 817 --json state,mergedAt`;repo `scripts/discord-plugin/check-discord-plugin.sh:83-84` | 恒久(已 merge) |

### 1.3 部署面现状(本单新发现的坑)

| # | 事实 | 证据 / 复核命令 | as-of |
|---|---|---|---|
| **F13** | 🔴 `[生产现状]` **生产 checker 副本未收敛**:`~/.flywheel/bin/check-discord-plugin.sh:77` 仍逐字单要求 `ChatReceiptRuntime`(#817 的 dual marker 只进了仓库);即 FLY-1730 runbook Phase A step 2(`scripts/install-discord-plugin-ops.sh`)**从未执行**。后果:先部署 0.0.5 会被 `restart-services.sh` fork recheck 在 Lead mutation 前 fail-close 中止 | `grep -n ChatReceiptRuntime ~/.flywheel/bin/check-discord-plugin.sh` | **08-20,会过期**——ship 前重测 |
| F14 | `[生产现状]` managed 部署资产齐备:`~/.flywheel/bin/update-discord-plugin.sh` + `update-discord-plugin-legacy-overlay.sh` + 两个 checker(FLY-1676 管线);仓库 `scripts/request-restart.sh`(FLY-1671)与 `scripts/install-discord-plugin-ops.sh` 均存在 | `ls ~/.flywheel/bin/ | grep -i plugin`;`ls scripts/request-restart.sh scripts/install-discord-plugin-ops.sh` | 08-20 |
| F15 | `[生产现状]` `FLYWHEEL_MAILBOX_DISCORD=1` 仍在 `~/.flywheel/.env:162`——二级回滚(回 0.0.4)的前提仍成立;PR #23 候选插件无运行时回切(`readMailboxFlag` 已拔,FLY-1645 既定终局) | `grep -n MAILBOX_DISCORD ~/.flywheel/.env` | **08-20,会过期**——Phase C 前禁删(FLY-1730 plan §4.9) |
| F16 | fork PR 队列邻居:#21(chat ingest Lead ownership,FLY-1774 面)、#22(FLY-1726 bot identity,exact-head APPROVED)、#19(FLY-1676 sync)均 open 且部分与 #23 同文件——**先落者赢**,#23 若被迫 rebase 则触发 F11 的重测重审链 | `gh pr list --repo xrliAnnie/claude-plugins-official --state open` | **08-20,会过期** |
| F17 | ~~FLY-1715 PR #821 在途未 merge~~ **更正(design review R1 抓出,已实测)**:PR #821 已 merge(2026-08-13T19:36Z,`e08c8d0a`)**且已在生产 deployed-sha 内**(`git merge-base --is-ancestor` 验证)。CLAUDE.md 里程碑行是陈旧的——教训重演:拿里程碑表当事实。census 保留的正确理由:**部署波前既存/未随波重启的 adapter 进程可以存活**,与 #821 是否 merge 无关 | `gh pr view 821 --json state,mergedAt`;`git merge-base --is-ancestor e08c8d0a fe9e3de86` | 08-20(实测) |
| F20 | `[生产现状]` 生产 `deployed-sha` = `fe9e3de86`;未部署区间 `fe9e3de86..origin/main` 现为 4 个 commit(#884/#890/#888/#897)。部署波会把该区间连带上线——Phase A 前必须审计该区间有无未满足 ship 前置的改动,不允许静默 co-deploy;`restart-services.sh` 自 FLY-1730 时代以来已新增 pull-to-latest-main、identity preflight、voice-bridge replacement 等行为,runbook 判据以现行脚本为准 | `cat ~/.flywheel/deployed-sha`;`git log fe9e3de86..origin/main --oneline` | **08-20,会过期**——Phase A 前重测 |

### 1.4 机械门与规矩现状

| # | 事实 | 证据 | as-of |
|---|---|---|---|
| F18 | 跨仓 receipt 残留机械门已存在:`scripts/fly1645-receipt-residue-gate.config.json`(repos 含 plugin,includeRoots `external_plugins/discord`)——receipt 动词族的机械实例 | 文件本体 | 恒久 |
| F19 | 「CLI 净删除子命令 → grep 全部插件缓存目录调用方」的**通用**规矩目前不存在于 CLAUDE.md / lead-rules 任何一处(#808 评审因此漏掉插件消费者) | `grep -rn "插件缓存\|plugin cache" CLAUDE.md` 零命中 | 08-20 |

## 2. 结论(喂给 plan)

1. **修复本体零新工作**:fix ① 的成品(fork PR #23)已 review+QA 齐备且至今 CLEAN。FLY-1914 的实现工作 = preflight 复核(F8-F10 的 JIT 重测)+ 主仓侧文档/规矩 PR + 推动 founder-gated merge + 执行部署 runbook + 真机验收。
2. **部署第一块砖是 F13**:先跑 `scripts/install-discord-plugin-ops.sh` 收敛生产 checker(对现 0.0.4 惰性、零风险、可先行),否则 fleet wave 必被 fail-close。
3. **通用规矩落 CLAUDE.md**(F19 空缺):零新机制,措辞进 plan。
4. **验收沿用 FLY-1730 §5 A1-A5**,对照组(A5)更新为本单 F5 的 8-20 活 intent 快照(比 8-12 的对照更新鲜)。
5. Annie 的临时处置口径延续:部署前若 settle spool 再堆积,按既有先例归档(`settle-archive-fly1914-*`),**勿重复建新机制**;部署 runbook Phase B step 8 会做最终残骸归档。
