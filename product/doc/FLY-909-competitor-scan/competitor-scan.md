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
3. **有一个空位没人正面占**:「**由非技术创始人在 chat 里指挥、真造并长期维护软件的一整个 AI 公司**」。Devin/Factory 造软件但卖单个工程师给工程团队;Lindy/Artisan 是 AI 员工但做运营不造软件。**我们站这个交叉点。**

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
| **🎯 Flywheel** | **由你指挥的一整个 AI 公司** | **非工程小企业/创始人** | **Discord 里跟 AI Lead 聊,Lead 管 Runner 建并维护真产品** | **一个 AI 组织(Lead+Runner 分层)** | **Claude 订阅制,无按 token 计费** |

**这张表看出的三条线**:
- **「谁在建」这一列是分水岭**:builder 档要**用户自己建**(自助工具);agent 档是**一个 agent 建**;**只有 Flywheel 是「一个分层的 AI 组织在建」,用户只指挥**。
- **服务非技术的手段**:builder 档靠「浏览器画布 + 一句话出 app」;AI 员工档靠「像招员工 + 接已有工具 + 大白话」。**两套都值得学**,但它们服务的「产物」不同(app vs 运营)。
- **定价**:全行业 credit 制 + 隐藏用量是非技术用户的公认痛点;**Flywheel 跑在 Claude 订阅上、无按 token 计费,是个潜在的「不 surprise 账单」优势**。

---

## ② 横切交付物 B:差异化候选清单(我们比他们独特在哪)

> 每条都标了「跟谁对比」和「站不站得住」。这些是喂 FLY-908 定位的**候选差异点**,给 Annie 挑。

1. **卖「一整个 AI 公司/团队」,不是一个工具、也不是一个工程师** ✅ 强
   - vs Lovable/Base44:它们给你**工具**,你自己是唯一的建造者;我们给你**一支队伍**。
   - vs Devin/Factory:它们卖**一个 AI 工程师**给工程团队;我们是**多部门组织**(CoS 分诊 → Lead 派活 → Runner 干),买家是**非技术创始人**。
   - 空位证据:调研没找到「面向非技术创始人的、造软件的 AI 公司」正面竞品。

2. **founder 只管两头(方向 + 验收),中间自治** ✅ 强(有行业背书)
   - vs Copilot(把你留在 IDE loop)/ vs builder 档(你得全程 prompt-改-prompt)。
   - Karpathy 的「agentic engineering」正是这个叙事 —— 我们是它的**组织化落地**。

3. **聊天(Discord)为主界面,不是 IDE、不是画布** ✅ 中强
   - vs Devin/Factory:它们把 Slack**贴在**工程工具链上当派单入口;我们是**以聊天为主界面的组织**,非技术创始人不进 IDE、不进画布,只在 Discord 跟 Lead 说话。

4. **建的是「会长期演进、被维护的真产品」,不是一次性 MVP** ✅ 中强
   - vs Lovable/Base44/Bolt:它们出 MVP/内部工具很快,但**长期维护、代码质量、演进你自己扛**;我们像真团队一样走 PR/CI/review/记忆,**持续维护一个 codebase**(dogfooding:Flywheel 建 Flywheel 本身)。

5. **常驻、会自己分诊 backlog 的组织,不是「你 prompt 才动」的被动工具** ✅ 中
   - vs 全部 builder/agent 档(都是 reactive:你发指令才干)。我们有 Chief of Staff 分诊、standup、Lead 协调 —— 一个**always-on 的组织**。

6. **无按 token 计费(跑 Claude 订阅)** ⚠️ 中(要小心,是运营现状不是护城河)
   - vs 全行业 credit/bill-shock 痛点。**能讲「不给非技术用户 surprise 账单」的体验,但别当结构性护城河吹** —— 底层成本随规模会变。

**我们跟谁「像」(诚实说)**:跟 Devin/Factory 的 **async Slack 派活→出 PR** 同构;跟 vibe-coding 大势「让非技术也能造软件」同向;跟 Lindy 的「像招员工」叙事同调。**差异全在「一个分层组织 vs 一个工具/一个工程师」+「非技术创始人当买家」这两点上。**

---

## ③ 值得借鉴清单(可直接喂 onboarding sibling issue)

1. **「几分钟内出一个真能跑的东西」的 onboarding**(Lovable/Base44):非技术第一次用,产物要**已经在跑**(带后端/认证/托管),不是一个他跑不起来的 repo。→ 直接喂 FLY-908 的「一条 command onboarding」。
2. **模板/gallery + remix 起步**(builder 档通用):非技术怕空白画布,从一个能跑的例子改起。
3. **「像招个员工/团队」的叙事**(Devin「产能单位」/Lindy「AI 员工」):这套叙事被证明对非技术小企业最抓人、且能撑价格。**我们可以比谁都更彻底地讲「一整个可指挥的 AI 团队」。**
4. **接客户已经在用的工具**(Lindy 的教训:接不上 = 一周内摩擦劝退)。对非技术 SMB,别逼他们进陌生工具链。
5. **定价可预测**:把全行业的 credit bill-shock 痛点,做成我们的「不 surprise」体验卖点。
6. **status 可见、可追**(Devin/Factory 的 Slack 派活体验):在 Discord 里让非技术创始人**看得见活干到哪、拿得到 PR**——打磨这层。

---

## ④ 对 FLY-908 定位的启发(收敛用)

- **要打败的替代品(定位靶子)不是 Lovable,而是**:雇 freelancer/外包 dev shop、自己上 no-code 然后自己维护、以及「no decision」。**我们的一句话价值 = 比雇外包更省心、比自己 vibe-code 更能长期扛住一个真产品。**
- **一句话定位候选(给 Annie 挑/改)**:
  - A:「**一整个由你指挥的 AI 公司** —— 你只说要什么、验收结果,它替你把软件建出来并持续维护。」
  - B:「非技术创始人的 **AI 开发团队**:在聊天里给方向,团队自己分工、建造、交付。」
  - C:「不是让你**自己**造 app 的工具,是**替你造**的一支 AI 团队。」
- **产品形态锚点**:聊天为主界面 + 分层组织(CoS/Lead/Runner)+ founder 只管两头 —— 这三点是我们区别于全场的形态特征,建议写进 FLY-908 的产品形态定义。

---

## 开放问题(gate 给 Lead / Annie)

1. 目标客户再收窄一档:是**「有一点技术直觉的创始人」**(能看懂 PR/验收),还是**「完全非技术」**(那验收/沟通界面要重新想)?这直接决定形态。
2. 差异化候选里,Annie 想主打哪条当**主线**(建议 #1「一整个 AI 公司」+ #2「只管两头」组合)?
3. 「无按 token 计费」这条,定位上**用不用**、用到多明(我倾向:讲体验不讲护城河)?
