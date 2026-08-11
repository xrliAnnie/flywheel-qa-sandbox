# FLY-1676 Discord plugin fork 追平上游 + 修自动同步 + 堵 vanilla 冲掉通路 — 探索

Issue: FLY-1676 (https://linear.app/geoforge3d/issue/FLY-1676/chore-把-discord-plugin-fork-整个追平上游-rebase-我们的定制-修好自动同步-founder-裁定不)
日期: 2026-08-10
基于: 无

## 1. 问题是什么

Flywheel 全部 Lead↔founder / Lead↔Lead 的 Discord 通信跑在一个**定制过的 Discord plugin** 上(fork 自 `anthropics/claude-plugins-official` 的 `external_plugins/discord/`)。定制携带 allowBots 白名单、reply-guard、roundtable thread 全套、chat-receipt producer 等 Flywheel 命脉功能。

三条痛并存:

1. **running 副本反复被冲成官方原版(vanilla)** — 2026-08-10 09:48 第三次复发;且本单调查期间(同日 11:23)**当场又发生一次**,证明冲掉频率是每天多次,不是偶发。
2. **fork 仓常年落后上游** — merge-base 停在 2026-04-16,落后 2818 commits(issue 里写 948+ 是旧数字)。
3. **自动同步名存实亡** — fork 的每日 Sync Upstream workflow 最近 100 次运行 **100% 失败**(最早可查 2026-05-03),且失败路径**零告警**,静默烂了三个多月。

## 2. founder 裁定(2026-08-10)— 本单的边界

founder 明确否决了「把 discord 插件 vendor 进自己仓、与上游脱钩」的方案:

> 「没有必要把 Discord 插件单独抽出来放进我们自己的仓……我们可以继续跟着原仓的更新跑。反正我们自己只会改 Discord,不会动他们其他东西,所以 merge conflict 应该不会很多。」

裁定后本单 = 三件事:
1. fork 整个追平上游,~20 个定制 commit rebase 上去;
2. 修好自动同步,失败要告警不许静默;
3. 查清并堵住「冲成 vanilla」的通路——验收:自动更新跑一次后,running 副本仍是 fork 版(grep 定制标志 > 0)。

顺带:fetch_messages 验证、定制 commit 逐条盘点(回答 founder「之前那些改动还有需要吗」)。

## 3. 审计推翻了 issue 的两个假设

本单 audit-first 拿到的现场证据(细节见同folder research.md)修正了 issue 文本里的两个猜测:

| issue 里的假设 | 现场事实 |
|---|---|
| 「Sync Upstream 常年 FAILING(rebase conflict 推不上去)」 | **rebase 每天都成功、从无 conflict**。失败在 push:`GITHUB_TOKEN` 缺 `workflows` 权限,上游新增了 `.github/workflows/*.yml` 文件,rebase 后推送包含这些文件的 commit 被 GitHub 拒收(`refusing to allow a GitHub App to …update workflow … without workflows permission`)。100/100 次全是同款拒绝。 |
| 「merge conflict 应该不会很多」(founder 预期) | 比预期更好:**上游自 merge-base(4月16日)以来对 `external_plugins/discord/` 的改动为零**。2818 个 upstream commit 全部落在其他插件。rebase 我们的 20 个 commit 是纯机械操作,冲突概率 ≈ 0。 |

另一个关键定位:冲掉 running 副本的**元凶是 Claude Code 自身的官方 marketplace 刷新机制**——`known_marketplaces.json` 里该 marketplace 的 source 是 `anthropics/claude-plugins-official`(上游官方,不是我们 fork),且官方 marketplace 走特殊 GCS 快照通道(目录里的 `.gcs-sha` 文件 = 上游 main 的 commit sha;其他 github 源 marketplace 都没有这个文件、也几乎从不被自动刷新)。每次刷新 = 把上游 vanilla 整个铺回 `~/.claude/plugins/marketplaces/claude-plugins-official/`,顺手抹掉我们 rsync 上去的 fork 定制。

即:**这不是"某个坏脚本拉错 remote",而是两个写者在争同一个目录**——Anthropic 的 marketplace 分发机制(写 vanilla)vs 我们的 update-discord-plugin.sh overlay(写 fork)。谁最后写谁赢。现有防线只有 Lead 启动时的 preflight(claude-lead.sh 923 行起 check→update 自愈),但 Lead 运行中 adapter 崩溃重启时会直接加载当时磁盘上的版本——若正处在被冲窗口,就中招。

## 4. 方向探索

### 方向 A:改 known_marketplaces.json 的 source 指向 fork
最小改动:官方 marketplace 的刷新机制若尊重 source 字段,刷新动作本身就变成「分发 fork」。
- 风险:`.gcs-sha` 的存在暗示官方 marketplace 按名字特殊处理(GCS 快照,可能无视 source 字段);该文件也可能被 Claude Code 升级时重置。**依赖未文档化行为,需探针实证。**

### 方向 B:注册第二个 marketplace(github 源 = fork 仓),discord 插件从它安装
- `claude plugin marketplace add xrliAnnie/claude-plugins-official`(命名如 `flywheel-plugins`)→ 安装 `discord@flywheel-plugins` → 停用 `discord@claude-plugins-official`。
- 结构性根治:discord runtime 从此住在**官方刷新机制永远不碰**的目录;官方 marketplace 想怎么刷就怎么刷,与我们无关。github 源 marketplace 实测不会被高频自动刷新(existing 三个的 lastUpdated 分别停在 1月/3月/6月),更新节奏完全由我们的脚本控制。
- 代价:插件 id 变更(`discord@claude-plugins-official` → `discord@flywheel-plugins`),需要一次性改 `~/.claude/settings.json` + `~/.claude.json` 的 enabledPlugins 引用 + 重装插件 + 全舰队 Lead 一次性重启(红线:不许混跑窗口)。preflight check/update 脚本同步retarget。

### 方向 C:保持现状架构,加看门狗
不动加载路径,加一个 launchd watcher 检测冲掉后秒级恢复 + 告警。
- 否决理由:结构上仍是两个写者赛跑,只是把输的概率压小;每天多次冲掉意味着 watcher 永远在打仗。是补偿层不是根治,与「修结构别加报警器」的项目纪律相悖。

### 方向 D(变体):local-path marketplace
把 `~/.flywheel/repos/claude-plugins-official`(本地 fork clone)注册为 local marketplace。单一写者做到极致(runtime 直接引用我们的 clone),但依赖 Claude Code local marketplace 的物化方式(引用 vs 拷贝),同样需探针。作为 B 的备选变体保留。

### 初步倾向
**B 为主方案**(不依赖未文档化行为,结构性消灭双写者),A 作为探针通过时的机会性简化,D 作为 B 的变体在探针阶段一并验证。C 仅作末路兜底。三件事里的「修自动同步」(PAT + 告警)与方向选择正交,任何方向都要做。

## 5. 悬而未决(进 research/plan 前需收口)

1. Claude Code marketplace 更新机制的准确行为(触发时机/特殊通道/source 是否被尊重)— 已派研究 agent 查官方文档 + CLI bundle,探针方案在 plan 里兜底。
2. Sync PAT 的权限最小面:fine-grained PAT,仅 `xrliAnnie/claude-plugins-official` 仓,Contents: write + Workflows: write。需要 Annie 铸造(涉及她的 GitHub 账号,只能她做)。
3. fetch_messages「channel_id undefined not snowflake」:上游四个月没碰 discord → 追平不改变此 bug 的存在性;fork 版在生产日常工作。列为验收时的真机验证项,不阻塞主线。
