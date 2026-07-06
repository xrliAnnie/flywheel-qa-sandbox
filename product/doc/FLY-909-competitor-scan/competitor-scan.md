# FLY-909 竞品扫描 + 定位启发 — 交付物

Issue: FLY-909 (https://linear.app/geoforge3d/issue/FLY-909/竞品分析市面上别人怎么做-喂产品定位形态)
日期: 2026-07-06
基于: research.md
喂给: FLY-908(对外定位 & 产品形态 EPIC)

> 一页看完:市场怎么分、我们像谁不像谁、能借什么、独特在哪。给 Annie review,喂 FLY-908 定位。

---

## TL;DR(3 句话)

1. **市场分两大形态**:①「**自助建造工具**」(Lovable/Base44/v0/Bolt/Replit —— 非技术**自己**在画布里 prompt 出 app);②「**派活给 agent**」(Devin/Factory —— 工程团队把任务派给**一个 AI 工程师**,出 PR)。
2. **行业叙事正好在往我们这边走**:Karpathy 2026 宣布 vibe coding「passe」→「**agentic engineering**」(人给方向与 review,agent 做实现)—— 这就是 Flywheel「**founder 只管两头,AI 团队自治**」的组织化版本。
3. **「一整个 AI 公司」这个位有人正面占了 —— Matrix(flowith)**,且组织骨架跟我们撞车(它 `Brain→Runtime→Departments→Leads→Workers→Proof` ≈ 我们 `CoS→Lead→Runner+验收`)。所以我们**不能**再靠「AI 公司/分层组织/订阅驱动」当差异 —— 真差异收窄到三条:**领域**(我们建软件产品/真 codebase,Matrix 跑营销获客生意)、**界面**(我们 Discord 聊天,Matrix 桌面 app + 游戏可视化)、**可信度**(我们工程级 PR/CI/review/founder 验收,Matrix 是业务产出的 proof)。详见 ② + `matrix-deepdive.md`。

---

## ① 横切交付物 A:各家用什么产品形态服务非技术用户

| 玩家 | 定位一句话 | 目标用户 | 产品形态(非技术怎么用) | 谁在「建」 | 定价形态 |
|---|---|---|---|---|---|
| **Lovable** | 不写代码发布 production app | 非技术创始人/PM | 聊天 prompt → 全栈 web app(浏览器内) | 用户本人 | Free / $25 / $50,credit + 隐藏用量 |
| **Base44**(Wix) | 一句话 → 带 DB+认证+托管的全栈 app | 做内部工具/dashboard 的非技术 | prompt → 可部署 app,后端已接好 | 用户本人 | Free / ~$16,message+integration credits |
| **Replit Agent** | 大白话变 app,不用碰文件 | 非技术 + 原型开发者 | 云 IDE + Agent,自然语言全流程 | 用户本人 | Free / $20 / $100,credit(易 bill shock) |
| **v0**(Vercel) | 高质量 UI 组件工厂 | 偏前端/半技术 | prompt → UI 组件(要点 React 基础) | 用户本人(+需补) | Free / $20 / $30座 / $100座 |
| **Bolt.new** | 浏览器里整套开发环境 | beginner 全栈原型 | 聊天 → 建项目+部署 | 用户本人 | Free / ~$20,token |
| **Devin**(Cognition) | AI software engineer(工程产能单位) | 工程团队 | Slack 派任务 / 挂 ticket → 出 PR | 一个 AI 工程师 | Free / $20 / $500 team |
| **Factory**(Droids) | agent-native 覆盖整个 SDLC | 企业工程团队 | Slack 触发 + Linear 连接,async → PR | 一群 Droid(单任务) | $20 / $100 / $200,无免费 |
| **Lindy** | 最好上手的 AI 员工(运营) | 非技术小企业 | 大白话 + 拖拽画布,接 1000+ 工具 | AI 员工(不造软件) | $49.99,无永久免费 |
| **🌟 Matrix**(flowith) | 「Launch a 0-Person Company that actually earns」 | 想 0 人创业的个人/小团队 | **macOS 桌面 app** + 游戏小人可视化;设目标 → agent 自建部门跑生意 | **一个自主 AI 公司**(Departments→Leads→Workers→Proof) | 公测免费;跑 Codex/CC 订阅 + BYOK |
| **🎯 Flywheel** | **由你指挥的一整个 AI 软件团队** | **非工程小企业/创始人** | **Discord 里跟 AI Lead 聊,Lead 管 Runner 建并维护真产品** | **一个 AI 组织(CoS→Lead→Runner+验收)** | **Claude 订阅制,无按 token 计费** |

**这张表看出的三条线**:
- **「谁在建」这一列是分水岭**:builder 档要**用户自己建**(自助工具);agent 档是**一个 agent 建**;**Matrix 和 Flywheel 都是「一个分层 AI 组织在建、用户只指挥」** —— 这两家撞形态(连分层骨架都像)。
- **Matrix vs Flywheel 的真分界**在最后落到:**产物**(它跑营销获客生意 / 我们建真软件产品)、**界面**(它桌面 app + 游戏可视化 / 我们 Discord)、**可信度**(它轻 proof / 我们工程级 PR·CI·review·验收)。
- **定价**:全行业 credit 制 + 隐藏用量是公认痛点;订阅驱动(无 token 计费)是「不 surprise 账单」体验 —— 但 **Matrix 也订阅驱动**,这条不独有。

---

## ② 横切交付物 B:差异化候选清单(我们比他们独特在哪)

> 每条都标了「跟谁对比」和「站不站得住」。这些是喂 FLY-908 定位的**候选差异点**,给 Annie 挑。

> ⚠️ **诚实修正(Matrix 之后)**:第一版说「一整个 AI 公司这个位没人正面占」是**错的**。**Matrix(flowith)正面占了**,而且组织骨架跟我们撞车(`Brain→Runtime→Departments→Leads→Workers→Proof` ≈ `CoS→Lead→Runner+验收`)。所以下面 #1 不再当「独有差异」,真差异是 #3/#4/#7 的**领域 + 界面 + 可信度**三条。

1. **卖「一整个 AI 公司/团队」,不是一个工具、也不是一个工程师** ✅ 中(**不再独有** —— Matrix 也这么定位)
   - vs Lovable/Base44:它们给你**工具**,你自己是唯一的建造者;我们给你**一支队伍**。
   - vs Devin/Factory:它们卖**一个 AI 工程师**给工程团队;我们是**多部门组织**(CoS 分诊 → Lead 派活 → Runner 干),买家是**非技术创始人**。
   - **vs Matrix**:同样是「你指挥的分层 AI 公司」—— 这一条区分不开我们和 Matrix,必须靠 #3/#4/#7。

2. **founder 只管两头(方向 + 验收),中间自治** ✅ 强(有行业背书)
   - vs Copilot(把你留在 IDE loop)/ vs builder 档(你得全程 prompt-改-prompt)。
   - Karpathy 的「agentic engineering」正是这个叙事 —— 我们是它的**组织化落地**。

3. **【界面轴】聊天(Discord)为主界面,不是 IDE、不是画布、不是桌面 app** ✅ 强(**对 Matrix 成立**)
   - vs Devin/Factory:它们把 Slack**贴在**工程工具链上当派单入口;我们是**以聊天为主界面的组织**,非技术创始人不进 IDE、不进画布,只在 Discord 跟 Lead 说话。
   - **vs Matrix**:它是 **macOS 桌面 app + 游戏小人可视化**(还有「要开盖才能工作」的运维负担);我们在**已有的 Discord IM 里**,非技术创始人不用下新 app、不用盯小人。

4. **【领域轴】建的是「会长期演进、被维护的真软件产品」,不是一次性 MVP、也不是营销生意** ✅ 强(**对 Matrix 成立**)
   - vs Lovable/Base44/Bolt:它们出 MVP/内部工具很快,但**长期维护、代码质量、演进你自己扛**;我们像真团队一样走 PR/CI/review/记忆,**持续维护一个 codebase**(dogfooding:Flywheel 建 Flywheel 本身)。
   - **vs Matrix**:它的 agent 团队去开**营销/获客生意**(官方示例 = Video Commerce / SEO Growth / Lead Gen),coding 是公开短板;我们的团队建并养**一个真软件产品**。

5. **常驻、会自己分诊 backlog 的组织,不是「你 prompt 才动」的被动工具** ✅ 中
   - vs 全部 builder/agent 档(都是 reactive:你发指令才干)。我们有 Chief of Staff 分诊、standup、Lead 协调 —— 一个**always-on 的组织**。

6. **无按 token 计费(跑 Claude 订阅)** ⚠️ 弱(**不是护城河,且非独有** —— Matrix 也跑 Codex/CC 订阅 + BYOK)
   - vs 全行业 credit/bill-shock 痛点。能讲「不给非技术用户 surprise 账单」的**体验**,但 **Matrix 同样订阅驱动**,别当结构性差异吹。

7. **【可信度轴】工程级「可信交付」:真 PR / CI / code review / QA / founder 验收 gate** ✅ 强(**对 Matrix 最锋利**)
   - vs Matrix:它的软肋是**验证** —— 评论区有人直接质疑「verification cost 会成为 AGI 经济瓶颈」(AI 说建好了,谁验、验得起吗?),它只有轻量的「return proof」;而且它「actually earns/数万家 0 人公司」**只有官方口径、查无第三方实证**。我们把**软件工程的验证纪律**(测试/CI/review/founder 验收)做成硬「可信」卖点 —— 正打它痛处。

**我们跟谁「像」(诚实说)**:
- **跟 Matrix 最像 —— 连组织骨架都撞**(`Departments→Leads→Workers→Proof` ≈ `Lead→Runner+验收`)、都订阅驱动、都打「不用招人就能开始」。**光靠「AI 公司」定位区分不开我们俩。**
- 跟 Devin/Factory 的 **async Slack 派活→出 PR** 同构;跟 vibe-coding 大势「让非技术也能造软件」同向;跟 Lindy 的「像招员工」叙事同调。

→ **真差异 = 领域(软件产品)+ 界面(Discord)+ 可信度(工程级验收)三条,不是「AI 公司」这个壳。**

---

## ③ 值得借鉴清单(可直接喂 onboarding sibling issue)

1. **「几分钟内出一个真能跑的东西」的 onboarding**(Lovable/Base44):非技术第一次用,产物要**已经在跑**(带后端/认证/托管),不是一个他跑不起来的 repo。→ 直接喂 FLY-908 的「一条 command onboarding」。
2. **模板/gallery + remix 起步**(builder 档通用):非技术怕空白画布,从一个能跑的例子改起。
3. **「像招个员工/团队」的叙事**(Devin「产能单位」/Lindy「AI 员工」/**Matrix「0 人公司」**):这套叙事被证明对非技术小企业最抓人、且能撑价格。但 **Matrix 已经把「一整个可指挥的 AI 公司」喊得很响** —— 我们要讲的是**更聚焦的版本**:「一支替你**建软件、并养着**的 AI 团队」,而不是「自动赚钱的 0 人公司」。
4. **接客户已经在用的工具**(Lindy 的教训:接不上 = 一周内摩擦劝退)。对非技术 SMB,别逼他们进陌生工具链。
5. **定价可预测**:把全行业的 credit bill-shock 痛点,做成我们的「不 surprise」体验卖点。
6. **status 可见、可追**(Devin/Factory 的 Slack 派活体验):在 Discord 里让非技术创始人**看得见活干到哪、拿得到 PR**——打磨这层。

---

## ④ 对 FLY-908 定位的启发(收敛用)

- **要打败的替代品(定位靶子)不是 Lovable,而是**:雇 freelancer/外包 dev shop、自己上 no-code 然后自己维护、以及「no decision」。**我们的一句话价值 = 比雇外包更省心、比自己 vibe-code 更能长期扛住一个真产品。**
- ⚠️ **Matrix 之后的收窄**:一句话定位**不能只说「一整个 AI 公司」**(Matrix 已占且更响),必须带上**软件 + 聊天 + 可信**其中至少一条,否则跟 Matrix 撞脸。
- **一句话定位候选(给 Annie 挑/改,已按 Matrix 收窄)**:
  - A(领域 + 可信):「**替非技术创始人把软件建出来、并像真团队一样养着的 AI 开发团队** —— 有 PR、有 review、有验收,不是黑箱。」
  - B(对比 Matrix 显式切分):「Matrix 让 agent 去**开个自动赚钱的生意**;我们让 AI 团队**替你把一个真软件产品建出来、长期维护**。」
  - C(界面 + 只管两头):「你在**聊天里**给方向、验收结果,一支 AI 团队替你把软件建出来 —— 不用下 app、不进 IDE、不盯小人。」
- **产品形态锚点(区别于 Matrix)**:**聊天(Discord)为界面** + **产物是真软件产品/codebase** + **工程级可信交付(CI/review/验收)** —— 光靠「分层组织(CoS/Lead/Runner)+ founder 只管两头」已跟 Matrix 撞,建议把这三条锚点写进 FLY-908 产品形态定义。

---

## 开放问题(gate 给 Lead / Annie)

1. 目标客户再收窄一档:是**「有一点技术直觉的创始人」**(能看懂 PR/验收),还是**「完全非技术」**(那验收/沟通界面要重新想)?这直接决定形态。
2. 差异化候选里,Annie 想主打哪条当**主线**(建议 #1「一整个 AI 公司」+ #2「只管两头」组合)?
3. 「无按 token 计费」这条,定位上**用不用**、用到多明(我倾向:讲体验不讲护城河)?
