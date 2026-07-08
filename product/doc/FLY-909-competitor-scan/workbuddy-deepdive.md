# FLY-909 竞品深挖 #4 — WorkBuddy(腾讯云出品)

Issue: FLY-1003 (https://linear.app/geoforge3d/issue/FLY-1003/workbuddy-竞品分析-腾讯-workbuddy-vs-flywheel-competitor-scan)
日期: 2026-07-08
基于: `product/doc/FLY-1003-workbuddy-scan/research.md`(本深挖的调研底稿)

> **为什么挖它**:Annie 2026-07-08 点名研究腾讯 WorkBuddy(跟 Raft/FLY-1001、Matrix 同一套竞品打法)。经查,这是我们扫过**量级最大、且比第一版承认的更贴的一家大厂竞品** —— 不只覆盖了我们一堆候选形态差异,**官方还白纸黑字把「一人公司 / 自由职业者」当目标用户**,场景直接列了电商选品/落地页/客服,正面撞我们 beachhead。
>
> **证据分级(inline 标注)**:【官方】腾讯官方页/blog · 【媒体】TechNode/Forbes/PANews/BigGo · 【分析】投行/分析机构 · 【评测】第三方评测/blog/知乎/CSDN · 【⚠️存疑】单源或与官方冲突、未证实。**资料来源诚实声明**:官网(copilot.tencent.com/work)常挡爬;本文事实靠腾讯全球页(tencentcloud.com/act/pro/workbuddy,已 WebFetch 核实目标用户/9 渠道/14 模型/记忆/development 角色)+ 多篇媒体/评测多源拼出;高影响数字标 ⚠️。

---

## 一句话定位(verbatim)

> 【官方】**"Tencent WorkBuddy — an AI-native agent … your own AI teammate"**;腾讯云口径:**全场景职场 AI 智能体桌面工作台**,「用一句话描述需求 → 像同事一样自主规划、执行、交付**可验收**的结果」。
> 腾讯官宣战略:从「**服务开发者(CodeBuddy)**」向「**服务全职场人**」延伸 —— 继承 CodeBuddy 底层 agent 架构,把能力边界从「写代码」扩到「坐在电脑前能做的事都能帮你做」。
> 【媒体】TechNode / issue 定性:**"OpenClaw-like workplace AI agent"**。

## 目标用户(⭐ 关键 —— 官方比想象的更贴我们 beachhead)

- 【官方,全球页逐字】**"One-person company: Individual entrepreneurs, freelancers, small team leaders"**(一人公司 / 个体创业者 / 自由职业者 / 小团队负责人)+「Research content(市场调研/竞品分析/成稿)」+「Data insights(运营/客服/管理业务数据)」。
- 【评测/媒体】2026 上半年主力用户 = **HR / 行政 / 运营白领**;也覆盖企业客户 + 程序员(程序员那套走 CodeBuddy)。
- **诚实结论**:WorkBuddy **不是「只打公司里的白领」** —— 它官方就打**一人公司 / 自由职业者 / 小团队**,跟我们 beachhead(非技术 solo OPC operator)**正面重叠**。不能把它的目标用户当成「跟我们错开」。

## 产品形态(怎么用)

- 【官方/评测】**桌面 app + 多渠道 IM bot 双形态**:
  - **桌面端**直连本地机器读写本地文件(清 Excel、整理文件夹、从本地文档生成报告),**sandbox 隔离执行**(「no-setup sandboxed」,活跑在隔离环境里不碰系统其他部分)。
  - **IM 端**派活回报 —— 【官方全球页逐字,**9 个渠道**】**Slack / Telegram / Discord / WeChat Assistant Bot / Enterprise WeChat / QQ / Yuanbao Pai(元宝派)/ DingTalk / Feishu**。「这些渠道变成命令台:发一条高层指令 → 它后台跑完 workflow → **完成后回报**」。⚠️ 部分媒体/评测说「12+ 渠道」,**官方页只列 9 个**,取官方标差异。
- **官方列的使用场景(⭐ 正好撞我们 beachhead 的业务活)**【官方】:**电商选品 · 独立落地页生成 · IM/在线客服 · 网页内容合规 · 市场调研/竞品分析 · 报告成稿 · 会议纪要 · 数据/运营洞察**。← 非技术电商/social operator 天天要干的业务活,不是抽象办公。
- **持久性**:【官方】只证「**Personalized memory capability**(专业版)」= 一个记忆 feature;【评测,⚠️存疑】llm-agent.cc/aicost 说「持久 daemon、离开工位也在、跨 run 记忆」—— **官方不背书 daemon 说法**。诚实合并:**它有个性化记忆 + IM 后台派发/回报,但「常驻 daemon 组织」是评测口径、未经官方/一手证实。**

## 核心机制

- 【官方/评测】**多 agent 并行**(它的最大杀手锏):把大目标拆子任务**并行跑**(不是排队);**Expert Teams** = 一个 lead agent 协调多个 sub-agent(一个调研 / 一个写代码 / 一个写文档)。
- 【官方】**100+ 内置专家角色**:"covering all roles and scenarios including operations, design, **data, development**, etc." —— 注意 **development(开发)明确在专家角色里**,不是「完全不碰编程」(但代码深度弱、不主打,见软肋)。
- 【官方】**多模型**:「one-click switching between multiple models」+ **TokenHub** 统一管理 token 调用,接 **14 个顶级模型**(混元 / DeepSeek / GLM / Kimi / MiniMax… + BYOK)。
- MCP + 20+ skill:连 GitHub / GitLab / Jira / Confluence / Google Drive / Gmail / Notion / Slack。

## 公司背景 & 体量(决定威胁量级)

- 【媒体】2026-01 内测 → **2026-03-09 国内全量上线** → **2026-05-29 全球上线**(TechNode / Forbes)。上线前 2000+ 非技术员工(HR/行政/运营)测过。
- 【媒体/分析,⚠️非独立审计】上线 3 个月 **13M+ DAU**,行业第二名 **3-4 倍**;**DAU/MAU 65-75%**(粘性直逼 Slack);3 个月迭代 **43 个版本**;3 月环比 **831%**。腾讯口径「中国目前最常用效率 agent」;**Citi** 称「中国 AI agent 市场拐点」;**Forbes**「WorkBuddy 出海标志 AI agent 竞赛的一次反转」。**数字口径可信但未独立审计。**
- 有 **Enterprise Edition(6 月)「From Super Individuals to Super Teams」+ Agent Suite**(企业 AI team)。

## Onboarding

【官方/评测】**开箱即用(out-of-the-box / no-setup)** —— 免费档 + 全员 50GB 云存储先试核心能力,一句话描述需求就开跑;100+ 专家角色即「预配好的团队」,不用自己攒 prompt/skill。上手门槛低是它爆量的原因之一。

## 亮点 feature

1. **多 agent 并行拆解**(把一个大目标拆成子任务同步推进,不排队)。
2. **100+ 专家角色 = 现成的「虚拟团队」**(每个预装领域技能 + prompt 模板 + 方法论)。
3. **sandbox 隔离执行**(活跑在隔离环境,降低碰坏系统的风险 —— 对非技术尤其安心)。
4. **多模型 TokenHub**(一键切 14 个模型 + 统一 token 管理)。
5. **9 渠道 IM 派活 + 后台跑 + 回报**(手机上发指令、桌面上出活)。
6. **免费档 + 50GB 存储**的低门槛获客。

## 已知软肋(诚实 = 机会点,但别夸大)

1. 【评测】**复杂多步易错**(算错 / 内容错位,要用户自己核对);**error recovery ~3/5,活有时只干一半**。
2. 大文件吃力、跨 OS 兼容问题、上线初期服务器压力/崩溃。
3. **代码深度落后** Cursor / Claude Code(本就不主打编程)。
4. **红海、缺鲜明优势**:微软 Copilot(集成进 Windows)、字节豆包、金山/WPS AI(更深集成或更便宜)—— 评测直言 WorkBuddy「**缺乏鲜明竞争优势**」。
5. 生态偏腾讯:跟非腾讯 WPS/飞书/钉钉 兼容不足;行业垂直功能有限。
6. 企业落地阻力:本地文件操作的数据安全顾虑 + 审批慢 + 员工换工具阻力。

## 定价

(⚠️各源出入,取区间)个人 Lite 39 / Standard 99 / Pro 299 元/月;企业 Standard 99 / Premium 199 / Flagship 999 元/月,企业 SaaS 旗舰约 198 元/人/月。免费档 + 全员 50GB 云存储。订阅 + token 售卖变现。

## 腾讯三剑客分工辨析(关键 nuance —— 别把 WorkBuddy 当 OpenClaw fork)

【评测,多篇横评一致】腾讯「Claw/龙虾」矩阵里三个最相关:
- **CodeBuddy** = 给**程序员**的「对话即编程」全流程研发搭档(**造软件的那个**)。
- **WorkBuddy** = 办公室全能助理(重「深度」、多 agent 并行、含 development 角色**但不主打编程**)。
- **QClaw**(小龙虾 AI)= 腾讯电脑管家团队**基于 OpenClaw 开源框架**的微信直连本地 AI 遥控器(重「随时」、数据不出本地)。

→ **腾讯真正的 OpenClaw 衍生品是 QClaw,不是 WorkBuddy;WorkBuddy 是自研(继承 CodeBuddy 架构)。** 「OpenClaw-like」是形态类比,别当成 fork。

---

## 跟 Flywheel:像谁 / 不一样(这份深挖的重点)

### 像(为什么最该警惕 —— 而且比 Matrix/Cowork 更贴)

WorkBuddy 一次性覆盖了我们**一堆候选形态差异**,且比之前扫的任何一家都全:
- **组织形态**:lead agent 协调 sub-agent 团队(Expert Teams)+ 100+ 专家「当同事」—— 骨架跟 CoS→Lead→Runner 相邻。
- **手机 IM 驱动**:官方 9 个 IM 渠道(含微信/Discord)派活回报 —— 跟我们「手机原生 IM」界面赌注**正面撞**。
- **多模型/供应商中立**:一键切 14 个模型 + TokenHub —— 跟我们「架构上跨后端」**正面撞**。
- **done-for-you**:描述任务 → 它交付 —— 跟我们**一样**。
- **个性化记忆 + 后台派发回报**:跟我们「常驻 + 记忆」的**可感知那部分撞**(「持久 daemon 组织」官方未证,标⚠️)。
- **目标用户**:官方打**一人公司 / 自由职业者**,场景列电商选品/落地页/客服 —— **正面重叠我们 beachhead**。

> 结论:靠「AI 团队 / IM 界面 / 多模型 / done-for-you / 目标是一人公司」**都区分不开了**。真差异只能落到「**你做的活到底是不是长期拥有并演进一套软件/业务系统**」+「**是不是一个被协调、自己推 backlog、持续 own 的组织**」上,否则跟 WorkBuddy 在一句话定位上会撞脸。

### 不一样(逐轴诚实 · 哪几轴站得住 / 塌了)

| 轴 | WorkBuddy | Flywheel | 判定(诚实) |
|---|---|---|---|
| **① job/结果 = 长期 ownership** | 任务式交付(选品/落地页/客服/报告一件件做完),含 development 角色,**但不是长期拥有并演进一个 codebase/业务系统** | **长期拥有并演进一套软件/业务系统的 lifecycle**(codebase ownership + 变更管理 + 维护 + 验收 + 随业务成长演进) | **✅ 当前最站得住的候选差异,但窄着说**。不是「软件 vs 办公」这么干净(它也生成落地页、也有 development 角色)—— 差异是**一次性任务交付 vs 长期被养的系统**。**Watch:腾讯把 WorkBuddy 办公/IM 流 + CodeBuddy 建软件 + 腾讯云部署 融成 operator 系统 → 这条快速压缩。** |
| **② 被协调的组织自推进 backlog + ownership** | 个性化记忆 + IM 后台派发/回报 + Expert Teams;但**每个活仍是「你派一个任务 → 它回报」**(持久 daemon/always-on【⚠️存疑】) | CoS 自分诊 backlog → Leads 互通 → 部门分工 → **自推进 + 持续 ownership**,对外像一家公司在动 | **⚠️ 候选、更窄**。「有记忆 + 后台派发/回报」**塌了**(WorkBuddy 官方也有)。剩的候选 = 「被协调、自己推 backlog、持续 own」vs「一个你派活的(有记忆的)助理」(差异在**协调 + ownership**)。别吹大。 |
| **③ 手机 IM 界面** | 官方 9 个 IM 渠道 | Discord 手机原生 chat | **❌ 塌了(不再独有)**。跟 Raft 结论收敛,退出差异清单。 |
| **④ 供应商中立/多模型** | 一键切 14 个模型 + TokenHub + BYOK | 架构上跨后端 | **❌ 塌了**。「第一方结构上不做」站不住 —— **云厂商腾讯原生做多模型**。退它当卖点(跟 Raft 收敛)。 |
| **⑤ done-for-you** | ✅ | ✅ | **平局**,单独不构成差异,须绑①②。 |
| **⑥a Push:异步远程执行+回报** | ✅ | ✅ | **❌ 已商品化,塌**。 |
| **⑥b Push:自发起 backlog 分诊+跨 Lead 协调+持续推进** | 「你发指令→它跑→回报」= 用户发起 | 系统从 backlog **自发起** | **⚠️ 候选(仅这半站)**。「always-on daemon」存疑,别据此强断。 |
| **⑦ 目标用户** | 官方打一人公司/自由职业者/小团队 + 白领 + 企业 | 非技术 solo OPC operator | **⚠️ 部分塌 / 重叠很大**。官方就打一人公司 + 电商选品/落地页/客服。差异不在「目标用户」本身,在「目标用户 + job(长期养系统)」的绑定。 |
| **⑧ 工程纪律/可信交付** | 复杂任务易错、半途、代码深度弱;办公活无 PR/CI | PR/CI/review/QA/founder 验收(引擎盖下底气) | **⚠️ 方向对但我们没做实**。它软肋真(结果证明是机会),但**我们也还没做实** —— 要争的,不是已赢。 |

### 大厂做办公 agent 对我们的威胁形态(founder 该看的)

**威胁为什么真:**
1. **量级碾压(分发,不是能力)**:早期团队(Matrix/Paperclip/OpenClaw)vs 腾讯 13M DAU + 微信生态分发 + 企业渠道 + 43 版/3 月迭代。
2. **覆盖面 + 目标都撞**:一次覆盖我们一堆候选差异,**且官方直接打一人公司/自由职业者 + 电商选品/落地页/客服** —— 「靠单点形态 + 靠目标用户」两条差异化路都被堵。
3. **⭐ Substitution path(最该盯的具体路线)**:腾讯**不需要抄 Flywheel 架构**就能伤我们 —— 把 **IM 派发(微信/企微/QQ)+ 办公/业务 skill(选品/落地页/客服)+ 腾讯云部署 + TokenHub 多模型 + CodeBuddy 的建软件 + 企业销售 + 存储捆绑 + 社交图谱** 拼成**够用的 operator 系统**,就能在我们产品化之前**从「够用的业务自动化」这一侧吃掉 beachhead** —— 全程不用长得像 GitHub/PR/CI。

**威胁为什么没到「取代」——诚实的另一半:**
1. **长期 ownership 的缝还在**:今天是任务式交付,没有「长期拥有 + 变更管理 + 维护 + 演进一个 operator 的软件/业务系统」的闭环;造软件在分开的 CodeBuddy(给开发者),两者还没融。
2. **验收/可信仍弱**(复杂任务易错、半途、无长期维护闭环)。
3. **大厂结构惰性**:融合「建软件 + 被协调组织 + 服务非技术 operator done-for-you 长期养系统」需跨团队 + 想清非技术 operator 的 job —— 大厂不必然快做这件对它非核心的事。**这是窗口,但靠速度守,不靠护城河。**

## 值得借鉴(from WorkBuddy)

1. **多 agent 并行拆解**做成显式能力(把大目标拆子任务并行),对「一个人手握一支队」的叙事很直观。
2. **100+ 专家角色 = 现成虚拟团队**,是非技术 onboarding 的好范式(喂 FLY-910;跟 Paperclip Company Wizard 同类)。
3. **sandbox 隔离执行** —— 「能感知的护栏」的一种(降低碰坏系统的恐惧),对非技术尤其重要。
4. **免费档 + 50GB 存储**的低门槛获客。
5. ⚠️ **别学**:红海里靠堆功能没鲜明优势(WorkBuddy 自己就被这么评);腾讯生态锁定(跟非腾讯工具兼容差)是**大厂的病、正好是我们「供应商中立整合」可讲的地方**,但那也只是「可信方向」不是现在主卖点。

## 一句话差异化候选(收窄后,给 Annie 挑 —— 措辞是「候选」,不是定论)

- 「WorkBuddy 是一个**大厂的、什么办公活都能帮你做一件件交付**的 AI 助手(还打一人公司);Flywheel 押的是**替一个非技术 operator,长期拥有并演进一套真软件/业务系统 —— 一个被协调、自己往前推 backlog 的组织在替你养着**,不是你一件件派活的助手。」
- **当前最像还站得住的候选差异 = 「长期 ownership lifecycle(给非技术 operator)」+「被协调组织自推进 backlog」两条,且都更窄、靠产品化速度守。** 主打哪条、成不成立、怎么讲,**归 FLY-911 跟 Annie 收敛,本文只摆候选。**

---

## 建议下一步

1. ⚠️ 可选:对 WorkBuddy 跑一次 **ChatGPT Deep Research**(Annie 已通用授权),复核实际交互模型(是不是真「常驻 daemon 组织」)+ DAU 数字的独立佐证 + 它到底能不能碰「长期维护一个 codebase」。—— **非阻塞,不影响本结论量级**;要更硬的一手事实再跑。
2. 结论已折进 `competitor-scan.md`(横切表 A + ⑧ 节)+ 轻改 `FLY-911 positioning.md`(§5 竞品表 + §7 诚实边界)。
