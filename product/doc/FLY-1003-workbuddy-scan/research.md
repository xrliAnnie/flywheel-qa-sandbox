# FLY-1003 WorkBuddy 竞品分析 — 调研

Issue: FLY-1003 (https://linear.app/geoforge3d/issue/FLY-1003/workbuddy-竞品分析-腾讯-workbuddy-vs-flywheel-competitor-scan)
日期: 2026-07-08
基于: exploration.md;上游参照 = `product/doc/FLY-909-competitor-scan/competitor-scan.md` + `matrix-deepdive.md` + `product/doc/FLY-911-product-positioning/positioning.md`
证据分级(inline 用):【官方】腾讯官方页/blog · 【媒体】TechNode/Forbes/PANews/BigGo · 【分析】投行/分析机构 · 【评测】第三方评测/blog/知乎/CSDN · 【⚠️存疑】单源或与官方冲突,未证实

> **一句话结论(先说,别护短 — round-2 修订后更狠)**:WorkBuddy 是我们扫过**最该警惕的一家**,而且比第一版承认的**还更贴**。它不只覆盖了我们一堆候选形态差异(个性化记忆 + 多渠道 IM + 多模型 + 多 agent + done-for-you),**官方页还白纸黑字把「一人公司 / 个体创业者 / 自由职业者 / 小团队负责人」当目标用户**,并列了**电商选品 / 独立落地页生成 / IM 客服**这些**正好是我们 beachhead(非技术电商/social operator)要做的业务活**。叠加大厂分发 + 13M DAU 量级。扫完后**真正还站得住的候选差异,收窄到「job/结果 = 长期拥有并演进一套软件/业务系统的生命周期」这一条为主 + 「被协调的组织自推进 backlog + 持续 ownership」为辅**,而且都比原来更窄、靠**产品化速度**守,不靠形态独有。定位大结论仍归 FLY-911 跟 Annie 拍。

---

## 1. WorkBuddy 是什么(核实过的事实 + 证据分级)

**身份**【官方/媒体】:腾讯云 **CodeBuddy 团队**推出的**全场景职场 AI 智能体桌面工作台**。腾讯从「服务开发者(CodeBuddy)」向「服务全职场人」延伸 —— 继承 CodeBuddy 底层 agent 架构,能力边界从「写代码」扩到「坐在电脑前能做的事都能帮你做」。定性(TechNode / issue):**"OpenClaw-like workplace AI agent"**。

**时间线 & 体量(决定威胁量级)**:
- 【媒体】2026-01 内测 → **2026-03-09 国内全量上线** → **2026-05-29 全球上线**(TechNode/Forbes)。上线前 2000+ 非技术员工(HR/行政/运营)测过。
- 【媒体/分析,⚠️非独立审计】上线 3 个月 **13M+ DAU**,行业第二名 **3-4 倍**;DAU/MAU **65-75%**(直逼 Slack);3 个月 **43 个版本**;3 月环比 **831%**。腾讯口径「中国目前最常用效率 agent」;Citi 称「中国 AI agent 市场拐点」;Forbes「WorkBuddy 出海标志 AI agent 竞赛反转」。**这些数字口径可信但未独立审计,标 ⚠️。**

**目标用户(round-2 关键修订 — 官方口径比第一版说的更贴我们)**:
- 【官方,全球页逐字】**"One-person company: Individual entrepreneurs, freelancers, small team leaders"**(一人公司 / 个体创业者 / 自由职业者 / 小团队负责人)+ 「Research content(市场调研/竞品分析/快速成稿)」+「Data insights(运营/客服/管理业务数据)」。
- 【评测/媒体】2026 上半年主力用户 = HR/行政/运营白领;也覆盖企业客户 + 程序员(程序员那套走 CodeBuddy)。有 Enterprise Edition(6 月)「From Super Individuals to Super Teams」+ Agent Suite。
- **诚实结论:WorkBuddy 不是「只打公司里的白领」—— 它官方就打「一人公司/自由职业者/小团队」,跟我们 beachhead(非技术 solo OPC operator)正面重叠。** 我第一版把 目标用户 当 ✅ 站得住是**过于宽待自己了**,已在 §2 降级。

**产品形态**【官方/评测】:**桌面 app + 多渠道 IM bot 双形态**。
- 桌面端直连本地机器读写本地文件、**sandbox 隔离执行**(「no-setup sandboxed」)。
- IM 端派活回报:【官方全球页逐字,9 个渠道】**Slack / Telegram / Discord / WeChat Assistant Bot / Enterprise WeChat / QQ / Yuanbao Pai(元宝派)/ DingTalk / Feishu**。⚠️ 部分媒体/评测说「12+ 渠道」,**官方页只列 9 个**,取官方、标差异。
- **持久性(round-2 收紧)**:【官方】只证「**Personalized memory capability**(专业版)」= 一个记忆 feature;【评测,⚠️存疑】llm-agent.cc/aicost 说「持久 daemon,离开工位也在,跨 run 记忆」—— **官方不背书 daemon 说法,标【⚠️存疑】**。诚实合并:**它有个性化记忆 + IM 后台派发+回报,但「常驻 daemon 组织」是评测口径、未经官方/一手证实。**

**核心机制**【官方/评测】:
- **多 agent 并行**(它的最大杀手锏):大目标拆子任务**并行跑**;**Expert Teams** = 一个 lead agent 协调多 sub-agent(调研/写代码/写文档)。
- 【官方】**"100+ domain experts … covering all roles and scenarios including operations, design, data, development, etc."** —— 注意 **development(开发)明确在 100+ 专家角色里**,不是「完全不碰编程」。
- 【官方】**多模型:「one-click switching between multiple models」+ TokenHub 统一管理,接 14 个顶级模型**(混元/DeepSeek/GLM/Kimi/MiniMax… + BYOK)。
- MCP + 20+ skill:连 GitHub/GitLab/Jira/Confluence/Google Drive/Gmail/Notion/Slack。

**官方列的使用场景(round-2 补 — 正好撞我们 beachhead 的业务活)**【官方】:**电商选品 · 独立落地页生成 · IM/在线客服 · 网页内容合规 · 市场调研/竞品分析 · 报告成稿 · 会议纪要 · 数据/运营洞察**。← 这些是**非技术电商/social operator 天天要干的业务活**,不是抽象办公。

**定价**(⚠️各源出入,取区间):个人 Lite 39/Standard 99/Pro 299 元/月;企业 Standard 99/Premium 199/Flagship 999 元/月,企业 SaaS 旗舰约 198 元/人/月。免费档 + 全员 50GB 云存储。订阅 + token 售卖。

**腾讯三剑客分工辨析(关键 nuance)**【评测,多篇横评一致】:
- **CodeBuddy** = 给程序员的「对话即编程」全流程研发搭档(**造软件的那个,给开发者**)。
- **WorkBuddy** = 办公室全能助理(重「深度」、多 agent 并行、含 development 角色但不主打编程)。
- **QClaw**(小龙虾 AI)= 腾讯电脑管家团队**基于 OpenClaw 开源框架**的微信直连本地 AI 遥控器(重「随时」、数据不出本地)。← **腾讯真正的 OpenClaw 衍生品是 QClaw,WorkBuddy 是自研**;「OpenClaw-like」是形态类比,别当成 fork。

**软肋(诚实 = 机会点,别夸大)**【评测】:
1. 复杂多步易错(算错/错位,要用户核对);**error recovery ~3/5,活有时干一半**。
2. 大文件吃力、跨 OS 兼容、上线初期服务器压力/崩溃。
3. 代码深度落后 Cursor/Claude Code(本就不主打编程)。
4. **红海无鲜明优势**:微软 Copilot(集成进 Windows)、字节豆包、金山/WPS AI(更深集成或更便宜)—— 评测直言 WorkBuddy「缺乏鲜明竞争优势」。
5. 生态偏腾讯:跟非腾讯 WPS/飞书/钉钉 兼容不足;行业垂直功能有限。
6. 企业落地阻力:本地文件操作数据安全顾虑 + 审批慢 + 员工换工具阻力。

---

## 2. 它 vs Flywheel —— 逐轴诚实(哪几轴还站得住 / 塌了 · round-2 更狠)

| 轴 | WorkBuddy | Flywheel | 判定(诚实) |
|---|---|---|---|
| **① job/结果 = 长期 ownership** | 官方场景是**任务式交付**(选品/落地页/客服/报告一件件做完交付),含 development 角色,但**不是长期拥有并演进一个 codebase/业务系统** | **长期拥有并演进一套软件/业务系统的生命周期**:codebase ownership + 变更管理 + 维护 + 验收 + 随 operator 业务成长演进 | **✅ 当前最站得住的候选差异,但要窄着说**。不是「软件 vs 办公」这么干净(WorkBuddy 也能生成落地页、也有 development 角色)—— 差异是 **一次性任务交付 vs 长期被养的系统 lifecycle**。**风险 watch:腾讯把 WorkBuddy 办公/IM 流 + CodeBuddy 建软件 + 腾讯云部署 融成 operator 系统,这条会快速压缩。** |
| **② 被协调的组织自推进 backlog + ownership** | 个性化记忆 + IM 后台派发回报 + Expert Teams;但**每个活仍是「你派一个任务 → 它回报」**(「持久 daemon/always-on」【⚠️存疑】,官方不背书) | CoS 自分诊 backlog → Leads 互通 → 部门分工 → **自推进 + 持续 ownership**,对外像一家公司在动 | **⚠️ 候选、更窄**。「有记忆 + IM 后台派发/回报」**塌了**(WorkBuddy 官方也有;「always-on daemon」存疑,不据此定论)。剩的候选 = 「被协调、自己推 backlog、持续 own」vs「一个你派活的(有记忆的)助理」,跟 FLY-911 对 OpenClaw 的定框一致(差异在**协调 + ownership**不在数量/记忆)。别吹大。 |
| **③ 手机 IM 界面** | 【官方】**9 个 IM 渠道**(含微信/Discord/Slack/TG/钉钉/飞书…) | Discord 手机原生 chat | **❌ 塌了(不再独有)**。Lead 已确认、跟 Raft 收敛。IM 赌注被大厂正面匹配,**退出差异清单**。 |
| **④ 供应商中立/多模型** | 【官方】一键切多模型 + TokenHub 接 14 个模型 + BYOK | 架构上能跨后端 | **❌ 塌了**。Lead 已确认、跟 Raft 收敛。「第一方结构上不做」站不住 —— **云厂商腾讯原生做多模型**。**退它当卖点**(FLY-911 早已降级,这次是官方铁证)。 |
| **⑤ done-for-you** | ✅ 描述任务 → 交付 | ✅ done-for-you | **平局**。done-for-you 单独不是差异,只有绑到①②(替非技术 operator done-for-you **长期养一套系统**)才有区分。 |
| **⑥a Push:异步远程执行 + 回报** | ✅ IM 派发 + 后台跑 + 完成回报 | ✅ 有 | **❌ 已商品化,塌**。 |
| **⑥b Push:自发起 backlog 分诊 + 跨 Lead 协调 + 持续推进** | 「你发指令 → 它跑 → 回报」= 用户发起 | 系统从 backlog **自发起**、只在要拍板时找你 | **⚠️ 候选(仅这半站)**。FLY-911 §7 应显式:活着的 Push 只是这一半,不是「记忆 + IM 后台派发/回报」那半(那半已商品化;「always-on daemon」存疑,别据此强断)。 |
| **⑦ 目标用户** | 【官方】**"one-person company / individual entrepreneurs / freelancers / small team leaders"** + 白领 + 企业 | **非技术 solo OPC operator**(电商/social,拼不出来、要 done-for-you) | **⚠️ 部分塌 / 重叠很大(round-2 从 ✅ 降级)**。WorkBuddy 官方就打一人公司/自由职业者 + 电商选品/落地页/客服场景 —— **正面重叠我们 beachhead**。差异不在「目标用户」本身,而在「目标用户 + job(长期养系统)」的绑定。 |
| **⑧ 工程纪律/可信交付** | 复杂任务易错、半途、代码深度弱;办公活无 PR/CI | PR/CI/review/QA/founder 验收(引擎盖下底气) | **⚠️ 方向对但我们没做实**。它软肋真(结果证明是机会),但**我们「一试真能跑」也还没做实** —— 要争的,不是已赢。 |

---

## 3. 大厂做办公 agent 对我们的威胁形态(Lead 点名要的 · round-2 加 substitution path)

**这是我们扫过量级最大的威胁,且比第一版更贴。拆清 —— 不是「腾讯做了我们就没了」:**

**威胁为什么真:**
1. **量级碾压(分发,不是能力)**:Matrix/Paperclip/OpenClaw 是早期团队;腾讯有 **13M DAU + 43 版/3 月 + 微信生态分发 + 企业渠道**。
2. **覆盖面 + 目标都撞**:它一次覆盖我们一堆候选差异(个性化记忆/多渠道 IM/多模型/多 agent/done-for-you),**且官方直接打一人公司/自由职业者 + 电商选品/落地页/客服** —— 「靠单点形态差异化 + 靠目标用户差异化」两条路都被它堵。
3. **⭐ Substitution path(founder 最该看的具体路线)**:腾讯**不需要抄 Flywheel 架构**就能伤我们 —— 它只要把 **IM 派发(微信/企微/QQ)+ 办公/业务 skill(选品/落地页/客服)+ 腾讯云部署(Lighthouse/EdgeOne 那类)+ TokenHub 多模型 + CodeBuddy 的建软件 + 企业销售 + 存储捆绑 + 社交图谱** 拼成**够用的 operator 系统**,就能在我们产品化之前**从「够用的业务自动化」这一侧吃掉 beachhead** —— 全程不用长得像 GitHub/PR/CI。这是最该盯的路线,不是抽象的「大厂」。

**威胁为什么没到「取代」——诚实的另一半:**
1. **长期 ownership 的缝还在**:今天 WorkBuddy 是**任务式交付**,没有「长期拥有 + 变更管理 + 维护 + 演进一个 operator 的软件/业务系统」的闭环;造软件在**分开的 CodeBuddy(给开发者)**,两者**还没融**。
2. **验收/可信仍弱**:它复杂任务易错、半途、无长期维护闭环。
3. **大厂结构惰性**:融合「建软件 + 常驻组织 + 服务非技术 operator done-for-you 长期养系统」需跨 CodeBuddy/WorkBuddy 团队 + 想清非技术 operator 的 job,大厂不必然快做这件对它非核心的事。**这是窗口,但窗口靠速度守,不靠护城河。**

**一句话威胁结论**:WorkBuddy 给 FLY-911「**引擎层无护城河**」的诚实前提配了一个**带分发肌肉、且已正面打一人公司的大厂样板**。赢面全押在**比腾讯更早、更专地把「被协调组织 + done-for-you + 长期养一套软件/业务系统」替一个非技术 operator 做通**(现在还没到)。防御 = **产品化速度 + 长期 ownership 专注**,不是形态独有。

---

## 4. 对 FLY-911 定位的影响评估(要不要调 · round-2)

**结论:不推翻 FLY-911,而是「进一步坐实它已有的诚实姿态」+ 补几处显式记录,并把差异表述收窄。** FLY-911 早已(诚实地)①把供应商中立降为「未来设计原则、不当主打」;②把差异框成「协调、不是数量/持久」;③认「引擎层无护城河、防御全在 done-for-you 组合产品化速度」。WorkBuddy 是对这套姿态的**最强印证**,同时逼我们把差异表述**再收窄**(目标用户不再当差异;活着的差异是 job = 长期 ownership)。

**建议的轻改(Lead 已批「视结论轻改 positioning.md 竞品表 + 诚实边界」;严守边界):**
1. **§5 竞品表加 WorkBuddy 一行** —— 定性:「**最强大厂威胁 · 覆盖面 + 目标都撞(官方打一人公司/自由职业者 + 电商选品/落地页/客服)· 活着的差异 = 长期拥有并演进一套软件/业务系统的 lifecycle**」。
2. **§7 诚实边界补** —— 显式记:(a)手机 IM + 供应商中立经 WorkBuddy(官方 9 渠道 + TokenHub 14 模型)正面覆盖,**退出差异清单**;(b)**目标用户不再是差异**(WorkBuddy 官方打一人公司/自由职业者);(c)活着的 Push 只剩「自发起 backlog 分诊 + 跨 Lead 协调 + 持续 ownership」半,「记忆 + IM 后台派发/回报」半已商品化(「always-on daemon」存疑,别据此强断);(d)当前最像还站得住的候选差异 = 「长期拥有并演进一套软件/业务系统的 lifecycle(给非技术 operator)」+「被协调组织自推进 backlog」,**均写「候选 / 待 911」,更窄、靠速度守**。
3. **不动** §0 主线一句话 / §1 beachhead / §2 主差异段 / §3 支柱 / §4 信任 —— 那是 Annie 的。**「真差异收敛到 X 条」这种定论口气不进 FLY-911 主体**,只用「当前最像还站得住的候选差异」。

**口径守则**:定位大结论仍归 FLY-911 跟 Annie 拍;本文只把新竞品事实 + 轴判定喂进去,**用「候选/待 911」措辞,不越权硬下**。

---

## 5. UNKNOWN / 待复核(诚实 · round-2)

- 【⚠️非独立审计】13M DAU / 市场第一 / DAU-MAU:腾讯口径 + 分析机构 + 媒体,多源一致、量级可信,非独立审计。
- 【⚠️存疑】「持久 daemon / 离开工位也在 / 跨 run 常驻组织」:仅评测/blog 口径,官方只证「个性化记忆」;若要对外强断言它「是/不是常驻组织」,建议 ChatGPT Deep Research 或一手试用复核实际交互模型。
- 【⚠️出入】IM 渠道数:官方 9 个,部分媒体说 12+,取官方标差异。定价各源出入(个人 39/99/299 vs eigent $9.95/$40-seat vs 58-316 元),取区间标 ⚠️。
- 【方法】官网(copilot.tencent.com/work)常挡爬;本文事实靠 tencentcloud.com 全球页(官方,已 WebFetch 核目标用户/渠道/多模型/记忆/development 角色)+ TechNode/Forbes/PANews/BigGo/Pandaily + eigent/aicost/llm-agent + 多篇中文横评 多源拼出。若 Annie 要更硬的一手交互事实,Deep Research 为**可选后续,不阻塞本结论量级**。

---

## 6. 主要来源

- 【官方】copilot.tencent.com/work · **tencentcloud.com/act/pro/workbuddy(已 WebFetch 核实目标用户/9 渠道/14 模型 TokenHub/个性化记忆/development 角色)** · tencent.com/en-us/articles/2202350
- 【媒体】TechNode(2026-05-29 出海)· Forbes(Vivian Toh, 2026-05-28)· PANews(DAU 3-4x)· BigGo(顶中国办公 agent 市场)· Pandaily(Enterprise Edition)· InfotechLead
- 【评测】eigent.ai/blog/workbuddy-ai-review · aicost.org(no-setup sandboxed)· llm-agent.cc(memory sync,⚠️daemon 说法)· 多篇知乎/CSDN/腾讯云开发者社区「三剑客/双龙虾」横评(WorkBuddy vs CodeBuddy vs QClaw 分工)
