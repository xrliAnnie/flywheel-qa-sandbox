# FLY-909 竞品扫描 + 定位启发 — 交付物(round 2)

Issue: FLY-909 (https://linear.app/geoforge3d/issue/FLY-909/竞品分析市面上别人怎么做-喂产品定位形态)
日期: 2026-07-07
基于: research.md + round-2 deep research(Paperclip / Hermes / OpenHands + 「Zero-Human Company」品类 + 可信度轴素材)
喂给: FLY-908(对外定位 & 产品形态 EPIC)/ FLY-911(定位收敛)

> 一页看完:市场怎么分、我们像谁不像谁、能借什么、独特在哪 —— **全部按「完全非技术小企业主」这个视角**(round-2,Annie 已定:会读 PR 的 persona 出局)。
> **round-1 → round-2 改了什么**:①目标客户锁死「完全非技术」,所有轴重写;②加了新竞品 **Paperclip**(开源免费的「AI 公司」框架)+ 按非技术视角重构 Hermes / OpenHands;③**可信度轴推倒重来**(非技术老板不读 PR/CI,他怎么感知信任);④折入三条 steer:Matrix 好推广建得平庸、GTM = Building-in-Public、Paperclip 的 generic-first vs concrete-company 洞察。

---

## TL;DR(3 句话 · round-2)

1. **「一整个 AI 公司 / 一队 agent」这个位现在挤爆了、而且商品化了**:Matrix(桌面、商业)+ **Paperclip(开源 MIT、免费、43K star、病毒式)** + 整个「Zero-Human Company」品类(Pulsia / Felix Craft…)。把 agent 组织成公司 = 已经**免费 + 开源 + 人人可下**。→ **「我们是一整个 AI 团队」当差异已彻底死透。**
2. **品类自己的批评替我们指了路**(送分题):执行已不是瓶颈了,**需求 / PMF / 信任 / 判断**才是(「AI 能量产上千家公司,但谁在买?需要判断和关系的活自动化不了」)。→ Flywheel **故意把人留在两头**(founder 给方向 + 验收),正好压在品类自己承认自动化不了的部分。〔**定位建议 · 待 Annie / FLY-911 拍**,不是本文能锁死的〕
3. **对一个完全非技术的老板,真差异收窄到三条**:**concrete 不 generic**(我们替你建**你那个具体产品**,他们给你一个 generic 框架自己拼)· **done-for-you 不自托管**(Discord 里说话,不装 Node server、不搭 org chart、不自带 agent)· **可感知的信任**(有个能对话的 Lead + 白话审批 + 东西一试真能跑且下周还能跑;PR/CI/QA 沉到引擎盖下当底气)。

---

## ① 横切表 A:各家用什么形态服务非技术用户 —— 「一个完全非技术的人能不能自己用」是新分水岭

| 玩家 | 定位一句话 | 目标用户 | 产品形态 | 完全非技术能自己用吗 | 定价形态 |
|---|---|---|---|---|---|
| **Lovable** | 不写代码发布 production app | 非技术创始人/PM | 聊天 prompt → 全栈 web app(浏览器内) | ✅ 能上手,但撞 technical cliff 就得雇人 | Free/$25/$50,credit+隐藏用量 |
| **Base44**(Wix) | 一句话→带 DB+认证+托管的全栈 app | 做内部工具的非技术 | prompt → 可部署 app | ✅ 能,但锁数据、只出 SPA | Free/~$16,双 credit |
| **Replit Agent** | 大白话变 app,不碰文件 | 非技术+原型开发者 | 云 IDE + Agent | ⚠️ 还是个 IDE,要进开发环境 | Free/$20/$100,credit(易 bill shock) |
| **v0**(Vercel) | 高质量 UI 组件工厂 | 偏前端/半技术 | prompt → UI 组件 | ❌ 要点 React 基础 | Free/$20/$30座/$100座 |
| **Bolt.new** | 浏览器里整套开发环境 | beginner 全栈原型 | 聊天 → 建+部署 | ⚠️ 面向会点开发的 beginner | Free/~$20,token |
| **Devin**(Cognition) | AI software engineer | 工程团队 | Slack 派任务 / 挂 ticket → 出 PR;**Devin 能管 Devin** | ❌ 卖给工程师,要你把任务讲成工程语言 | Free/$20/$500 |
| **Factory**(Droids) | agent-native 覆盖 SDLC | 企业工程团队 | Slack 触发 + Linear;async → PR | ❌ 面向企业工程,无免费 | $20/$100/$200 |
| **🆕 Paperclip**(@dotta) | 把你的 agent 组织成一个公司的**控制平面** | **会自托管的开发者 / prosumer** | **自己跑的 Node server + React 面板**;org chart + ticket + 预算 + 全程 tracing;**BYO agent** | ❌ 要会 Docker/VPS/自托管、还得自带 agent | **开源 MIT 免费**(自付基建) |
| **Hermes**(Nous) | 会自己长本事的常驻 agent | 技术自托管者 / prosumer | 自己服务器跑 daemon(现也有桌面 app);记忆图 + 自写 skill | ⚠️ 桌面 app 后好一点,但根子是自托管单 agent | 开源(自付基建,$5 VPS 起) |
| **OpenHands**(All Hands) | 开源云端 coding agent 平台 | **开发者** | Cloud/CLI/SDK;连 GitHub → 自主出 PR | ❌ Cloud 也要懂 repo/git 工作流 | Free(BYOK)/$20(at-cost) |
| **🌟 Matrix**(flowith) | 「Launch a 0-Person Company that actually earns」 | 想 0 人创业的个人/小团队 | **macOS 桌面 app** + 游戏小人可视化;设目标 → agent 自建部门跑生意 | ⚠️ 门槛低但要下桌面 app、跑的是营销生意不是软件 | 公测免费;跑订阅 + BYOK |
| **🎯 Flywheel** | **由你指挥、替你建并养一个真软件产品的 AI 团队** | **完全非技术的小企业主/创始人** | **Discord 里跟 AI Lead 聊,Lead 管 Runner 建并维护你自己 GitHub 里的真产品** | ✅✅ **不装东西、不自托管、不写 issue、不自带 agent —— 在已有的 IM 里说话** | Claude 订阅制,无按 token 计费 |

**这张表的新分水岭 =「完全非技术能不能自己用」**:
- **builder 档(Lovable/Base44)最贴非技术**,但天花板是 technical cliff + lock-in(撞墙要雇人 / 数据搬不走)。
- **agent 档(Devin/Factory/OpenHands)全是给工程师的** —— 要你把活讲成工程语言、要你懂 repo。
- **新一波「AI 公司」框架(Paperclip/Hermes)是开源自托管** —— 免费、强大,但**要你会 Docker/VPS/自带 agent**,一个完全非技术的老板根本装不起来。
- **Matrix** 门槛最低,但要下**桌面 app**、且跑的是**营销获客生意不是软件产品**。
- → **没有一家是「完全非技术 + 在已有 IM 里说话 + 替你建真软件」**。这就是空当。

---

## ② 「AI 公司」这个位已经商品化了 —— 真差异是 concrete 不 generic(steer:Paperclip generic-first 洞察)

**round-1 说「一整个 AI 公司这个位没人正面占」是错的;round-2 更进一步 —— 这个位不但有人占,还免费开源了。**

- **Matrix** = 商业化的「你指挥的 AI 公司」(桌面 app,组织骨架 `Departments→Leads→Workers→Proof` ≈ 我们 `CoS→Lead→Runner+验收`)。
- **🆕 Paperclip** = **开源免费的**「你指挥的 AI 公司」。@dotta(管着 20+ 个 Claude Code 终端窗口、没有共享上下文/成本追踪/状态恢复的痛点催生)3-2 发布 → 3 周 30K star、4 月 43K+、MIT 免费、自托管、**BYO agent**。它明说「**不是 agent 框架,是让你把一堆 agent 跑成一个公司**」——org chart / 预算 / 治理 / ticket + 全程 tracing。「If OpenClaw is the employee, Paperclip is the company.」
- 加上 **Devin 能管 Devin、Factory 一群 Droid** —— **分层多 agent 组织 = 2026 行业标配**,不是任何人的差异。

**关键洞察(steer:generic-first vs concrete-company)**:
> Paperclip / Matrix 都是 **generic 横向平台** —— 给你一个「搭任意 AI 公司」的框架(Paperclip 甚至让你 BYO agent、自己定 org chart;Matrix 给你 security firm / game studio / consultancy 等模板让你自己拼)。**generic 那一层现在是免费 + 开源 + 病毒式的,谁也别想在那儿建护城河。**
> Flywheel 要赢就得反过来做 **concrete**:不是「一个搭 AI 公司的框架」,是「**一支已经组装好、替你建你那个具体产品**的 AI 软件团队」。价值恰恰在**具体、有主见、开箱即用**,因为通用层已经被 Paperclip 商品化掉了、而品类真正的瓶颈是「建出来没人买」(见 TL;DR #2)。

---

## ③ 可信度轴 · 推倒重来:一个完全非技术的老板,不读 PR/CI,怎么感知信任?(round-2 头号重构)

**round-1 把可信度讲成「真 PR / CI / code review / QA / founder 验收」= 工程级可信。问题:一个完全非技术的老板根本读不懂 PR/CI。** 那份工程纪律仍然是**东西真能用**的根本原因,但它**不是**非技术老板能亲身感知的东西。所以这条轴要按「他能感知什么」重写:

行业事实:**只有 6% 的公司完全信任 AI agent 自主跑核心业务**;非技术信任来自 ①能追溯的 audit trail ②有名有姓的负责人 + 明确的意图/风险边界 ③高影响动作要审批 ④能一键喊停。而竞品的信任机制(Paperclip 的 ticket+tracing、Matrix 的 return proof、Hermes 的 memory-graph)**给你看的都是日志/证据面板** —— 对纯非技术仍是「一堆看不太懂的记录」。

**Flywheel 面向非技术的可信度 = 四件他能亲身感知的事:**

1. **⚓ 结果证明(锚点)—— 东西一试真能跑,而且下周还能跑。** 这是非技术老板**唯一能自己验证**的信任:功能能用、不崩、持续维护不烂。**这恰恰是 Matrix(coding 弱、跑营销生意)和 Paperclip(generic 框架、质量看你 BYO 的 agent)做不到的** —— 他们能「建出个东西」,但「真能长期用的真软件」是我们独占的地带。**信任往这上面压。**
2. **关系型信任 —— 有个能对话的 named Lead。** 你在 Discord 里能直接问它「这个为什么这么做」「改一下」,像信任一个员工 / 承包商,而不是信任一个黑箱。
3. **可读的审批 —— 批决定,不批 diff。** Lead 用大白话说「我打算做 X,行吗?」,你批的是一个**你听得懂的决定**,不是一屏代码。(工程纪律里的 review/gate,产品化成非技术能读的一句话。)
4. **能感知的护栏 —— 不 surprise 账单 + 能喊停。** 跑订阅、可预测的花费(对比全行业 credit bill-shock)+ 随时叫停。

> **而 PR / CI / code review / QA** = 沉在**引擎盖下**的质量保证,是上面那份「一试真能跑、下周还能跑」的**底气**,不是拿去跟非技术老板讲的卖点。
> 一句话:**别人给你看证据(proof/tracing/日志);我们给你一个真能用、且有人替你养着的东西 —— 这是非技术老板唯一验得动的信任。**

---

## ④ 值得借鉴清单(按非技术视角,喂 onboarding sibling issue FLY-910)

1. **「几分钟内出一个真能跑的东西」的 onboarding**(Lovable/Base44):非技术第一次用,产物要**已经在跑**(带后端/认证/托管),不是一个他跑不起来的 repo。→ 喂 FLY-908/910 的「一条 command onboarding」。
2. **后端/认证/托管开箱接好**(Base44 黄金标准):非技术 onboarding 别让他碰基础设施 —— 正反衬 Paperclip/Hermes/OpenHands 的自托管门槛(那是我们**不**该学的,要天然绕开)。
3. **「像招个员工/团队」的叙事**(Devin 产能单位 / Matrix 0 人公司 / Paperclip「你是 CEO、agent 是员工」)—— 被反复验证对非技术最抓人。但要讲**更聚焦的版本**:「一支替你**建软件并养着**的团队」,不是「自动赚钱的 0 人公司」。
4. **接客户已经在用的工具 / 别逼他进陌生工具链**(Lindy 教训 + 我们的 Discord 优势):非技术在已有 IM 里说话就行。
5. **定价可预测 = 卖点**(OpenHands「at-cost 零加价」是全行业清流):把 credit bill-shock 痛点做成我们的「不 surprise」体验。
6. **Building-in-Public 的 GTM(steer:Matrix + Base44)**:见 gtm-intel.md —— build-in-public(中文圈用小红书)+ 产品自传播 onboarding(「招募布道者而非转化用户」)+「产品当众干活」当病毒 demo。**Paperclip 也是这套的极致**(开源 + 病毒式 43K star,靠 @dotta build-in-public + HN/X 口碑,零广告)。→ 我们最强的 demo = 「AI 团队当着人面把一个真功能建出来 / 修好」。

---

## ⑤ 对 FLY-908 / FLY-911 定位的启发(收敛用)

- **要打败的替代品(定位靶子)不是 Lovable、也不是 Matrix,而是**:雇 freelancer/外包 dev shop、自己上 no-code 然后自己维护、以及「干脆不做」。**一句话价值 = 比雇外包更省心、比自己 vibe-code 更能长期扛住一个真产品。**
- **⚠️ 「AI 公司」这个壳不能再当定位** —— Matrix 占了、Paperclip 还免费开源了。一句话定位**必须带上** concrete(你那个具体产品)/ done-for-you(非技术不自托管)/ 可信(一试真能跑) 其中至少一条。
- **〔定位建议 · 待 Annie / FLY-911 拍〕最锋利的一条对外反差**:品类喊「Zero-Human Company / 自动赚钱」;我们诚实地反着讲 —— **「不是零人公司。是**你**做判断、AI 做工程**」。正好压在品类自己承认自动化不了的部分(需求/判断/信任/关系)。**这是竞品扫描导出的定位建议,不是本文锁死的定位** —— 定位由 Annie + FLY-911 那条线拍。
- **一句话定位候选(给 Annie 挑/改,已按 Matrix + Paperclip 收窄)**:
  - **A(concrete + 可信)**:「替非技术创始人把**你那个具体产品**建出来、并像真团队一样养着的 AI 开发团队 —— 一试真能跑、下周还能跑,不是一次性 demo。」
  - **B(对比品类显式切分)**:「别人给你一个搭 AI 公司的框架、让 agent 去开个自动赚钱的生意;我们**替你把你那个真软件产品建出来、长期维护** —— 你只管方向和验收。」
  - **C(done-for-you + 只管两头)**:「你在**聊天里**给方向、验收结果,一支 AI 团队替你把软件建出来 —— 不用装 server、不搭 org chart、不自带 agent、不进 IDE。」
- **产品形态锚点(区别于 Matrix + Paperclip)**:**Discord 聊天为界面(手机原生)** + **产物 = 你自己 GitHub 里的真软件产品** + **可感知信任(一试真能跑 + 能对话的 Lead + 白话审批)** —— 建议把这三条写进 FLY-908 产品形态定义。

---

## 我们跟谁「像」/「不一样」(诚实版 · round-2)

- **跟 Matrix + Paperclip 最像 —— 连组织骨架都撞**(都是「你指挥的分层 AI 公司」)。**但组织形态已商品化(Paperclip 还免费开源),这条区分不开。**
- 跟 Devin/Factory 的 async 派活→出 PR 同构,但**它们卖给工程师**、我们卖给完全非技术。
- 跟 Paperclip/Hermes/OpenHands 的开源自托管**正相反**:它们要你是技术人、会自托管;我们**替非技术托管一整个团队**。
- → **真差异 = concrete(你那个具体产品)+ done-for-you(非技术不自托管、Discord 说话)+ 可感知信任(一试真能跑、有人养着)。不是「AI 公司」这个壳。**

---

## 开放问题(gate 给 Lead / Annie · round-2 已更新)

1. ✅ **已解决(Annie 定)**:目标客户 = **完全非技术小企业主**(会读 PR 的 persona 出局)。本文已按此重写。
2. **主线差异化**:三条(concrete / done-for-you / 可感知信任-结果锚点)里,Annie 想主打哪条当**一句话定位的主线**?(建议:结果证明「一试真能跑、下周还能跑」当锚,concrete 当切分。)→ 喂 FLY-911。
3. **TL;DR #2 那条「不是零人公司、是你做判断 AI 做工程」的反差** —— 用不用当对外主 messaging?(定位建议,待 Annie / FLY-911 拍。)
