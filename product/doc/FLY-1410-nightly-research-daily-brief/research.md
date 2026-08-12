# FLY-1410 夜间研究 agent → 早报 — 调研(复用 vs 新建 map)

Issue: FLY-1410 (https://linear.app/geoforge3d/issue/FLY-1410/researchprdhl-夜间研究-agent-早报-配置化多源xgithub-trendinghn每晚扫读早上给可互动日报每条可留)
日期: 2026-08-10
基于: exploration.md

---

## 0. 这份文档回答的唯一问题

issue 明写:「**"存在"≠"在跑"** —— 必须核:这些现在有没有一个真的每晚在跑的实例?」

所以每一块都分三栏:**代码做出来了吗 / 现在真在跑吗 / 判断**。
第二栏一律用**机器可查的证据**,不用文档和记忆。

---

## 🔴 1. 头号发现:整台机器上,一个夜间定时任务都没在跑

这不是「小红书那套缺调度」,是**全线缺**。

**证据(2026-08-10 实测,gui/501 域)**

```
$ launchctl list | awk '{print $3}' | grep '^com.flywheel'
com.flywheel.bridge
com.flywheel.cmux-watcher
com.flywheel.lead.<13 个 Lead>
```

**已加载的 com.flywheel.* 只有:Bridge、cmux-watcher、13 个 Lead supervisor。定时任务 = 0。**

磁盘上躺着、但**一个都没被 bootstrap** 的 plist:

| plist | 本该做什么 | `launchctl print gui/501/<label>` |
| -- | -- | -- |
| `com.flywheel.daily-standup` | 每天 03:00 晨会 | `Could not find service` |
| `com.flywheel.skills-update` | 每天同步 skill 库 | `Could not find service` |
| `com.flywheel.growth-learn / -report / -improve / -retro` | growth 四件套 | `Could not find service` |
| `com.flywheel.sub-daily-loop / sub-create-nightly` | sub 夜间产线 | `Could not find service` |
| `com.flywheel.quota-monitor / token-usage-daily / updater / bridge-liveness-probe` | 运维巡检 | `Could not find service` |

旁证:`/tmp/flywheel-standup.log`(plist 里指定的日志路径)**不存在**。
`crontab -l` 只有一条 `daily-permission-learn.sh`,与 Flywheel 无关。

**唯一一个跟"学习"沾边、且真的被加载的 job:**

```
com.xiaohongshu-deep-learning.qa528
  Program        = /bin/bash /var/folders/.../T/tmptczovkqh/...-scheduled.sh   ← 临时目录
  StartCalendarInterval = 每周三 09:00
  LastExitStatus = 32512                                                       ← 127<<8 = command not found
```

→ 这是 **QA 遗留物**,指向一个已被清掉的临时脚本,每周三失败一次。**不是生产实例。**

### 🟢 Annie 的裁决(2026-08-10 第一轮反馈)—— 这条关切**撤掉**

> 过去几天系统一直处在比较奇怪的状态,所以那些夜间定时任务完全没跑。
> **而且现在也不会马上让它们跑起来** —— 要等整个系统修好、稳定之后,再开始跑这些定期夜间任务。

**⇒ 这一节的地位变了:**

- ✅ **测量保留**(它是真实测量,有价值,且解释了「为什么小红书那套从没跑过」)。
- 🚫 **但它不再是本单的阻塞或前置。** 定时任务没在跑是**已知的、被她主动搁置的**状态。
- 🚫 **不得据此提任何「要先修好基建才能做 1410」的建议** —— 那个顺序她已经拍了:
  **先稳系统,再开夜间任务。**
- 📐 **因此 1410 这一轮做的是「设计」,不是「马上上线」。** 全篇按这个前提读:
  下面所有的「判断:直接复用 / 泛化 / 新写」讲的是**将来要建的时候怎么建**,
  不是「现在就去装 plist」。

### 这个发现对 1410 意味着什么(按上面的裁决修订)

- 「复用现成夜间基建」这个前提 **不成立** —— 没有现成的活基建可复用,只有现成的**形状**。
  这影响的是**工作量估算**,不影响开工顺序。
- **立一个夜间调度不是这单最难的部分**(见 §2.1),真正难的在 §2.4。
- ⚠️ 顺带一个**超出本单范围**的信号:standup / skills-update 这些本该在跑的东西也没在跑。
  已由 HL 转 Tadashi;**本单不处理、也不等它**。

---

## 2. 逐块 map

### 2.1 夜间调度(「每晚某个时间起跑」)

| | |
| -- | -- |
| **现有 machinery** | ① launchd plist(全项目通用形态,`scripts/xiaohongshu-learning-tick.sh` 是完整范本:FLY-176 mkdir 重入锁 + 日志截断 + source `~/.flywheel/.env`)<br>② `scripts/xiaohongshu-scheduler.ts` — 薄调度器:枚举 config → 判 due → 建 trigger issue → POST Bridge `/api/runs/start` 起 Runner,**不等 Runner**<br>③ `packages/teamlead/src/bridge/management-cron-source.ts` + `management-cron-writer.ts` — Bridge 里已有一套**扫描 + 写 launchd plist** 的管理面(FLY-1038 管理控制台),能读 `StartCalendarInterval`、能改、带 model binding |
| **代码做出来了吗** | ✅ 全做完了,而且质量不错(锁、幂等、409 active-session guard、Runner 自持 lease) |
| **现在真在跑吗** | ❌ **没有**。`xiaohongshu-scheduler.ts` 源码顶部逐字写着:「installing the launchd plist + the FIRST live run is the **GATED pilot**… **Do NOT load the plist against a production Bridge**」。`/tmp/flywheel-xhs-scheduler.log` 不存在 ⇒ 一次都没 tick 过 |
| **判断** | **直接复用形状 + 泛化一层**。`xiaohongshu-learning-tick.sh` 几乎逐字可改成 `nightly-research-tick.sh`;调度器把「枚举 XHS collections」换成「枚举 sources」。**唯一真活儿 = 把 plist 真装上去、真跑起来**(这是 XHS 那单欠的账,1410 不能再欠) |

### 2.2 抓取 / 读源(X · GitHub Trending · HN · 小红书)

| 源 | 现有能力 | 真能用吗 | 判断 |
| -- | -- | -- | -- |
| **小红书** | `com.codex.xiaohongshu-mcp` 在 launchctl 里**已加载**;`mcp__xiaohongshu-mcp__*` 全套工具(list_feeds / search_feeds / get_feed_detail / list_collections…) | ⚠️ **工具在,但我一次抓取都没实测过**(而且本会话中途该 MCP 连接断开了)。「MCP server 加载了」≠「抓得到」 | 形状可直接复用;**接之前必须先实测一次** |
| **HN** | 无专用接线。HN 有公开免费 API(Firebase / Algolia),无需 key | ✅ **已实测可抓**(见下) | **新写,但很轻** |
| **GitHub Trending** | 无专用接线。无官方 API,需抓 HTML 页;`gh` CLI 已装且有 token | ✅ **已实测可抓**(见下) | **新写,轻—中** |
| **X / Twitter** | ① `last30days` skill 声称覆盖 X ② `claude-in-chrome` 可驱动她已登录的 Chrome | 🔴 **两条路都有硬约束,见下** | **最大风险块** |

#### ✅ HN / GitHub Trending — 已实测(2026-08-10,把原来的推断换成实测)

| 探针 | 结果 |
| -- | -- |
| `GET hn.algolia.com/api/v1/search?tags=front_page` | **HTTP 200**,31,710 bytes,**20 条**;每条自带 `title` / `url` / `points` / `num_comments` / `created_at` / `objectID`。**无需任何 key** |
| `GET github.com/trending?since=daily`(带 UA) | **HTTP 200**,683,753 bytes,解析出 **16 行仓库条目** |
| `gh api search/repositories?...`(已认证备选路) | **通**,返回结构化 `full_name` / `stars` / `description` |

⇒ 这两个源**没有凭据风险、没有浏览器争用**,是纯 HTTP。**它们应该是第一批接的源**
(先跑通整条链路,再去碰 X 那条有钱和可靠性代价的路)。

⚠️ 仍未实测的:抓取**频率上限 / 反爬**。GitHub Trending 是 HTML 抓页,
GitHub 随时可以改版式或限速 —— 这是一个需要在实现时容错的点,不是阻塞点。

#### 🔴 X 这条路必须先说清楚(不说清楚 PRD 会建在沙上)

**路 A — `last30days` skill:不可用。**
实测 `~/.flywheel/.env` 里:

```
SCRAPECREATORS_API_KEY => absent   ← skill 的 primaryEnv,必需
AUTH_TOKEN / CT0       => absent   ← X cookie 模式
APIFY / BRAVE / XAI / OPENAI / PARALLEL / BSKY => absent
```

skill 装了,**一把钥匙都没有**。「跨 10+ 源深研」目前是一个空壳。要用 = **Annie 得掏钱买 key**,
这是一个需要她拍的产品决策,不是工程细节。

**路 B — `claude-in-chrome` 驱动她登录态的 Chrome:能用,但代价明确。**
- 必须 **headed Chrome + 她本人登录态 + 一次交互式配对**;
- **同一时间只能有一个 connected browser** ⇒ **抢浏览器的源只能串行**;
- Chrome 断连是已知常见故障(有 `chrome-repair` skill 专门治)⇒ 夜间无人值守时,
  这是**最可能整晚白跑**的一环。

⚠️ Annie 在原单里已经预判了串行问题(「不抢浏览器的并行、抢浏览器的必须串行」)——
说明她知道。但**「断连 = 整晚白跑」她可能没预期**,这条我必须摆出来。

### 2.3 深读 + 核实

| | |
| -- | -- |
| **现有 machinery** | ① `xiaohongshu-deep-learning` skill(多模态深读:视频原片 / 图 / 文)② `deep-research` skill(ChatGPT Deep Research,带引用)③ Runner 本身就能读源码 / 读 repo — 本周五轮就是这么做的 |
| **代码做出来了吗** | ✅ 深读有;**「核实」没有**。现有 skill 全是「读得更深」,**没有一个是「去核原物、并标出帖子说错了」** |
| **现在真在跑吗** | ❌ XHS 深读从没定时跑过;`deep-research` 是手动、串行、抢浏览器 |
| **判断** | **核实 = 本单的真正新东西,必须新写。**「深读」可复用;「核实」得从零定义(见 exploration.md 的 B 块)。⚠️ 这也是最容易做假的一步 ——「我核实过了」很容易退化成「我又读了一遍那个帖子」 |

### 2.4 「跟我们什么关系」(最值钱、也最没有现成东西的一块)

| | |
| -- | -- |
| **现有 machinery** | 几乎没有。能对照的「我们的已知事实」散在:`~/.claude/projects/…/memory/`、`doc/architecture/`、CLAUDE.md 里程碑表、Linear issue —— **没有一个可被程序查询的"我们已知事实"库** |
| **代码做出来了吗** | ❌ |
| **现在真在跑吗** | ❌ |
| **判断** | **新写,而且这是整单的技术核心。** 本周五轮里,这一段全靠一个 Lead 的脑子(「67% 等待」「校验器锁死出度」这些数字他记得)。要自动化,要么(a)每次现读架构文档 + memory,要么(b)先立一个薄的「我们已知事实」索引。**这一块决定 1410 是"又一个摘要机"还是真有用** |

### 2.5 日报交付(可互动 HTML + 每条 feedback 框)

| | |
| -- | -- |
| **现有 machinery** | ① `flywheel-comm publish-report`(FLY-203)= 一条命令:发布到不可猜 URL → proofshot 截图 → Bridge 发一条 Discord 消息<br>② `report-registry.ts` **已支持 nonce**:`script-src 'nonce-…'` 显式白名单(FLY-930 落地),静态报告仍守 `default-src 'none'` ⇒ **交互式 JS 页面是活能力**<br>③ `xhs-review-routes.ts` = Bridge 自服务的 review 页(自带 CSP + nonce) |
| **代码做出来了吗** | ✅ |
| **现在真在跑吗** | ✅ **这一块是全篇唯一"真在跑"的** —— 本周五轮的报告就是这么交付的 |
| **判断** | **直接复用,零新建。** 这是 1410 风险最低的一块,应当最后做、也最省事 |

### 2.6 闭环(feedback → follow-up issue 草稿)

| | |
| -- | -- |
| **现有 machinery** | ① `create-issue` skill + Linear MCP<br>② XHS 那套的 **post-hoc review 模型**(FLY-286):`pendingFeedbackRunTokens` / `lastReportToken` / `recordAnalysisDelivered` —— 她在 review 页上的动作,**下一次跑的时候被应用**(close / create + 记 learnings) |
| **代码做出来了吗** | ✅ 模型完整,而且正是 1410 要的形状 |
| **现在真在跑吗** | ❌ 从没在生产跑过一次(同 §2.1 的 gated pilot) |
| **判断** | **直接复用模型 + 泛化**。⚠️ 但要注意:XHS 的状态是 collection-scoped(`XiaohongshuCollectionConfig`),泛化到多源要重定 key |

### 2.7 配置化多源(「能随时加/减源」)

| | |
| -- | -- |
| **现有 machinery** | `XiaohongshuLearningConfig`(`packages/config/src/types.ts:529`) |
| **它是通用的吗** | 🔴 **不是。** 字段是 `collections?: XiaohongshuCollectionConfig[]` + `video_opt_in`(小红书视频专用)。这是**一个源的专用 config**,不是多源框架 |
| **判断** | **泛化 = 真活儿,不是改个字段名。** 需要一层 source 抽象(source kind / 抓取方式 / 是否抢浏览器 / 额度 / 独立 due 状态)。⚠️ 但**不要一步做成插件框架** —— 先支持四个源的 union type,比先建抽象层更符合「先做能跑的」 |

---

## 3. 一页总表

| 块 | 代码有 | 在跑 | 判断 | 风险 |
| -- | :--: | :--: | -- | -- |
| 夜间调度 | ✅ | ❌ | 复用形状 + **真装上去** | 低(纯执行) |
| 抓取:小红书 | ✅ | ⚠️ 工具在,**抓取未实测** | 形状可复用,接前先实测 | 中 |
| 抓取:HN | ❌ | ❌ | 新写(很轻)· **已实测可抓** | 低 |
| 抓取:GitHub Trending | ❌ | ❌ | 新写(轻—中)· **已实测可抓** | 中(抓 HTML,会随版式变) |
| 抓取:X | ⚠️ | ❌ | **待 Annie 拍**(买 key vs 抢浏览器) | 🔴 **高** |
| 深读 | ✅ | ❌ | 复用 | 中 |
| **核实** | ❌ | ❌ | **新写(本单核心)** | 🔴 **高** |
| **「跟我们什么关系」** | ❌ | ❌ | **新写(本单技术核心)** | 🔴 **高** |
| 日报 HTML(含交互) | ✅ | ✅ | 直接复用 | 低 |
| feedback → issue | ✅ | ❌ | 复用模型 + 泛化 | 中 |
| 多源配置 | ⚠️ | ❌ | 泛化 | 中 |

**结论:这单 70% 的价值在「核实」+「跟我们什么关系」这两块新东西上,
而 70% 的现成代码在「调度 + 交付 + 闭环」这些外壳上。
如果 PRD 把重心放在"接好四个源",就做反了。**

---

## 4. 口径(我读了什么 / 没读什么)

**读了 / 实测了**
- `launchctl list`、`launchctl print gui/501/<label>` 逐个探(daily-standup / skills-update / growth-learn)、`crontab -l`
- `~/Library/LaunchAgents/` 全量 plist 清单 + `com.xiaohongshu-deep-learning.qa528` plist 正文与 `LastExitStatus`
- `scripts/xiaohongshu-scheduler.ts`、`scripts/xiaohongshu-learning-tick.sh` 源码抬头与锁逻辑
- `packages/config/src/types.ts:529-540`(`XiaohongshuLearningConfig` 真实字段)
- `packages/teamlead/src/bridge/report-registry.ts`(nonce CSP)、`xhs-review-routes.ts`、`management-cron-source.ts`
- `packages/flywheel-comm/src/xiaohongshu-review-delivery.ts`(FLY-286 交付模型)
- `~/.flywheel/.env` 中 10 个 API key 的**存在性**(只查有没有,没读值)
- `~/.claude/skills/last30days/SKILL.md` frontmatter(必需 env)
- Bridge `/health`:`ok:true`,build `d32a9919`

- **实跑了两次真实抓取**:HN Algolia(200 / 20 条 / 免 key)、GitHub Trending 页(200 / 16 行)+ `gh api` 备选路

**没读 / 没核**
- **X 一次都没实测**(不该在无人授权时动她的登录态)
- **小红书一次抓取都没实测** —— 我只看到 MCP server 在 launchctl 里加载。
  这是「工具在」不是「抓得到」,原先我把它写成「✅ 真能用」是过头了,已改
- 没实测 `claude-in-chrome` 当前是否连得上她的 Chrome(本单不该动她的浏览器)
- 没读 `last30days` 的脚本正文,只读了 frontmatter 的 env 要求 ⇒ 「没 key 就完全不能用」是**基于 frontmatter 声明的推断**,没实跑验证
- 没查 FLY-914 / FLY-930 build issue 在 Linear 上的最终状态(只从代码确认 nonce 已落地)
- 没核 standup / skills-update 为什么没被加载(是主动停的还是掉的)—— **超出本单范围,应单独报 Tadashi**
- **没测抓取频率上限 / 反爬** —— GitHub Trending 抓的是 HTML 页,GitHub 改版式或限速都会打断它
- 没实测「统一 CoS / 语音总管」那条线的任何东西 —— 边界段(exploration §3.5)是**设计约定**,不是实测

**厂商自报 / 二手**
- `last30days` 的「覆盖 10+ 源」是该 skill 自己的 README 说法,**我们从没验证过**
