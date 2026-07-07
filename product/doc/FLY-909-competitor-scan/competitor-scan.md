# FLY-909 竞品扫描 + 定位启发 — 交付物(round 2 · Annie 批注修订版)

Issue: FLY-909 (https://linear.app/geoforge3d/issue/FLY-909/竞品分析市面上别人怎么做-喂产品定位形态)
日期: 2026-07-07
基于: research.md + round-2 deep research + Annie round-2 批注(instruction 68563d64)
喂给: FLY-908(对外定位 & 产品形态 EPIC)/ FLY-911(定位收敛 —— 定位大结论在那拍)

> 一页看完:市场怎么分、各家什么状态、能借什么、我们的差异**候选**线索在哪 —— 全部按「**非技术小生意主**」这个视角(Annie 已定:能读 PR/做验收的高阶画像出局)。
> **口径(重要)**:「我们跟 Matrix/Paperclip 到底差异化不化、generic-vs-concrete」这类**定位大结论,归 FLY-911 跟 Annie 收敛,本文不硬下** —— 差异一律写成「候选 / 待 911 拍」。本文是喂料,不是定案。
> **本版(Annie 批注)改了什么**:①用词去丧(别人做了 ≠ 我们不能做);②Paperclip 真挖深(机制/怎么起来的/可借鉴,不只下结论,见 paperclip-deepdive.md);③不 overclaim「完全非技术」(现在还没到,产品化是待解题);④修正 Lovable 分类(它主要是出 UI 的地方);⑤自托管诚实化(差异不是「不用自托管」,是「done-for-you 替你做」);⑥bootstrap 打法写进「可借鉴」。

---

## TL;DR(3 句话)

1. **「一整个 AI 公司 / 一队 agent」这个形态,有人正面在做、而且做得早做得响**:Matrix(桌面、商业)+ **Paperclip(开源、免费、~70K star)** + 整个「Zero-Human Company」品类。**但「别人在做」不等于我们不能做**(OpenAI 之后有 Anthropic)—— 真差异不在「AI 公司」这个壳,而在我们能不能把**自己团队的优势**打出来。
2. **这条赛道自己也承认瓶颈**:执行已不是难点,**需求 / 有没有人买 / 信任 / 判断**才是。而且**大家都还早**——连 70K star 的 Paperclip 都被评测叫「原型穿着产品外衣」、每周报 bug。我们可以诚实地把「**人留在两头**(你给方向 + 你验收)」当一条对外线索。〔定位建议 · 待 Annie / FLY-911 拍〕
3. **对非技术小生意主,我们的差异候选(待 911)= 三条,用他听得懂的话讲**:**done-for-you 替你做**(目标是你不用自己攒/配/盯 —— 不是「不用自托管」,我们八成也要那套基建,而是替你搞定)· **建并养一个真软件产品** · **信得过**(东西一试真能跑、下周还能跑)。这三条是**候选线索**,主打哪条由 FLY-911 收敛。

---

## ① 横切表 A:各家什么形态、非技术小生意主用起来什么体验

| 玩家 | 定位一句话 | 目标用户 | 产品形态 | 非技术小生意主的现实体验 | 定价形态 |
|---|---|---|---|---|---|
| **Lovable** | 主要是**用聊天快速生成 UI / 前端**的地方(也能带全栈,但重心和口碑在界面) | 要快速出界面/原型的非技术、设计、PM | 聊天 prompt → 生成 UI(可带后端) | 出个好看界面/原型很快;复杂后端、长期维护不是它的重心 —— **跟「替你建并养一个真产品」不是一类** | Free/$25/$50 |
| **Base44**(Wix) | 一句话→带 DB+认证+托管的全栈内部工具 | 做内部工具/dashboard 的非技术 | prompt → 可部署 app | 出全栈内部工具最快,但数据锁平台、只出 SPA | Free/~$16 |
| **Replit Agent** | 大白话变 app,不碰文件 | 非技术+原型开发者 | 云 IDE + Agent | 还是个 IDE,要进开发环境;credit 易 bill shock | Free/$20/$100 |
| **v0**(Vercel) | 高质量 UI 组件工厂 | 偏前端/半技术 | prompt → UI 组件 | 要点 React 基础 | Free/$20/$30座 |
| **Bolt.new** | 浏览器里整套开发环境 | beginner 全栈原型 | 聊天 → 建+部署 | 面向会点开发的 beginner | Free/~$20 |
| **Devin**(Cognition) | AI software engineer | 工程团队 | Slack 派任务 → 出 PR;Devin 能管 Devin | 卖给工程师,要把活讲成工程语言 | Free/$20/$500 |
| **Factory**(Droids) | agent-native 覆盖 SDLC | 企业工程团队 | Slack 触发 + Linear;async → PR | 面向企业工程,无免费 | $20/$100/$200 |
| **🆕 Paperclip**(@dotta) | 把你的 agent 组织成一个公司的控制平面(org chart/预算/治理) | **明说给 operators**(solo 创始人/agency/甚至牙医·营销公司) | 自己跑的 Node server + React 面板;BYO agent | **瞄的人跟我们很像**,但上手要自托管(Docker/VPS);还「原型穿产品外衣」、每周 bug | **开源 MIT 免费**(自付基建) |
| **Hermes**(Nous) | 会自己长本事的常驻 agent | 技术自托管者 / prosumer | 自己服务器跑 daemon(现有桌面 app) | 桌面 app 后好一点,根子仍是自托管单 agent | 开源(自付基建) |
| **OpenHands**(All Hands) | 开源云端 coding agent 平台 | 开发者 | Cloud/CLI/SDK;连 GitHub → 出 PR | Cloud 也要懂 repo/git 流 | Free(BYOK)/$20 |
| **🌟 Matrix**(flowith) | Launch a 0-Person Company that actually earns | 想 0 人创业的个人/小团队 | macOS 桌面 app + 游戏小人可视化 | 门槛低但要下桌面 app、跑营销生意不是软件 | 公测免费 |
| **🎯 Flywheel** | 由你指挥、替你建并养一个真软件产品的 AI 团队 | **非技术小生意主/创始人** | Discord 里跟 AI Lead 聊,Lead 管 Runner 建并维护你 GitHub 里的真产品 | **目标 done-for-you**(你不用懂技术);⚠️ **坦白:现在还没到** —— 跑起来仍需要点工程水平(Annie 自己用都撞 bug),产品化是待解题 | Claude 订阅制 |

**这张表看出的东西(观察,不是定位结论)**:
- **没有一家是「非技术真能自己跑起来 + 在已有 IM 里说话 + 替你建真软件」**;但要诚实 —— **这个「非技术真能自己用」现在谁都没做到**(连 Paperclip 都还是原型状态),我们也还没到。这是赛道的共同未解题,谁先把「done-for-you 真产品化」跑通谁赢。
- **builder 档(Lovable/Base44)** 里,Lovable 其实是**出 UI/前端**为主,别跟「替你建并养真产品」混一类。
- **agent 档(Devin/Factory/OpenHands)** 面向工程师;**开源框架档(Paperclip/Hermes)** 面向自托管者 —— 但 **Paperclip 明确在往 operators / 非技术小生意主打**,跟我们目标人群重叠。

---

## ② 「AI 公司」这个形态:有人在做、都还早 —— 我们能借什么(不硬下定位结论)

- **Matrix** = 商业化的「你指挥的 AI 公司」(桌面 app)。**Paperclip** = 开源免费的同类(~70K star、105 contributors、明说给 operators)。加上 **Devin 能管 Devin、Factory 一群 Droid** —— 分层多 agent 组织是 2026 的常见形态。
- **口径**:靠「AI 公司 / 分层组织」这个壳,我们和 Matrix/Paperclip **区分度不高**;但**这不等于我们不该做** —— 该做的是把差异落到别处(done-for-you / 真产品 / 可信),而**具体怎么落、主打哪条,归 FLY-911 跟 Annie 收敛**。

**⭐ 可借鉴:先立具体旗舰来 bootstrap 通用能力(Annie + 独立 catch,采纳)**
> generic 产品一开始没人用 —— 所以聪明的玩家**先立一个可信的、具体的旗舰样板**来 bootstrap 那个通用能力。**Matrix** 用 live 示例公司(agency 类)、**Paperclip** 用 `companies` 模板库(里面一堆**软件公司**模板:Superpowers = CEO/CTO/QA/Release Eng + TDD + code review;gstack;Full-Stack Forge)+ Company Wizard(回答几问→装配)。
> **这是打法、该学,不是弱点。** 落到我们:**我们的具体旗舰样板 = 一个软件公司 = dogfooding(Flywheel 建 Flywheel）**,正好贴我们的背景。→ 喂 FLY-908/910/911。

**⭐ 可借鉴:Paperclip 的几个具体机制**(详见 paperclip-deepdive.md)
- **每 agent 月预算 + 80% 预警 + 100% 自停** → 把「不 surprise 账单」做成结构护栏(对非技术尤其重要)。
- **雇新 agent 默认要 Board 批准** → 「高影响动作要人批」的产品化,跟我们 founder 验收 gate 同类。
- **import 即跑的公司模板 + Company Wizard** → 非技术 onboarding 的好范式(喂 FLY-910)。
- **append-only 审计轨迹** → 「可信」的可视化底座。

---

## ③ 可信度轴:非技术小生意主不读 PR/CI,他怎么感知信任?(Annie flag 的关键重想点)

**非技术老板读不懂 PR/CI。** 那份工程纪律(PR/CI/review/QA)仍然是**东西真能用**的根本原因,但它**不是**非技术老板能亲身感知的东西。所以这条轴按「他能感知什么」重述(这些是**候选表达**,主线待 911):

行业事实:只有 **6%** 的公司完全信任 AI agent 自主跑核心业务;竞品的信任机制(Paperclip 的 ticket+tracing、Matrix 的 return proof、Hermes 的 memory-graph)对纯非技术仍是「一堆看不太懂的记录」。

**面向非技术的可信度,候选四件事(他能亲身感知的):**
1. **⚓ 结果证明(候选锚点)—— 东西一试真能跑,而且下周还能跑。** 这是非技术老板**唯一能自己验证**的信任(功能能用、不崩、持续维护不烂)。这也是这条赛道普遍的短板 —— Matrix coding 弱、Paperclip 还「原型穿产品外衣」;谁把「真能用且养得住」做实,谁在这条轴上占先。⚠️ 诚实:**我们现在也还没做实**(还一堆 bug),这是要争的地方,不是已经赢的地方。
2. **关系型信任 —— 有个能对话的 named Lead。** 你在 Discord 里能直接问它「为什么这么做」「改一下」,像信一个员工/承包商。
3. **可读的审批 —— 批决定,不批 diff。** Lead 用大白话说「我打算做 X,行吗」,你批的是听得懂的决定。
4. **能感知的护栏 —— 不 surprise 账单 + 能喊停。**(Paperclip 的月预算自停机制值得借鉴。)

> **PR / CI / code review / QA** = 沉在引擎盖下的质量保证,是上面「一试真能跑」的**底气**,不是拿去跟非技术老板讲的卖点。

---

## ④ 值得借鉴清单(按非技术视角,喂 onboarding sibling issue FLY-910)

1. **「几分钟内出一个真能跑的东西」的 onboarding**(Lovable/Base44):非技术第一次用,产物要已经在跑。
2. **import 即跑的公司模板 + 回答几问就装配**(Paperclip Company Wizard):非技术 onboarding 好范式。
3. **后端/认证/托管开箱接好**(Base44 黄金标准)。
4. **「像招个员工/团队」的叙事**(Devin/Matrix/Paperclip「你是 CEO」)—— 讲更聚焦的版本(替你建软件并养着,不是自动赚钱)。
5. **operator 语言、不跟开发者讲**(Paperclip 明确「给 operators」)—— 我们对外也用非技术小生意主听得懂的话。
6. **定价可预测 / 月预算自停**(OpenHands at-cost、Paperclip 预算护栏):把 bill-shock 痛点做成「不 surprise」。
7. **Building-in-Public 的 GTM(steer:Matrix + Base44 + Paperclip)**:见 gtm-intel.md。build-in-public(中文圈用小红书)+ 产品自传播 onboarding +「产品当众干活」当病毒 demo(Paperclip 的 Greg Isenberg live demo 是标杆)。

---

## ⑤ 对 FLY-908 / FLY-911 定位的启发(喂料 · 差异写成候选,定位在 911 拍)

- **要打败的替代品(定位靶子)不是 Lovable、也不是 Matrix,而是**:雇 freelancer/外包 dev shop、自己上 no-code 然后自己维护、以及「干脆不做」。
- **「AI 公司」这个壳我们和 Matrix/Paperclip 区分度不高** —— 但别人在做不等于我们不能做。一句话定位往哪走(带上 done-for-you / 真软件 / 可信 哪几条、怎么讲)**由 FLY-911 收敛,本文不定**。
- **差异化候选线索(喂 911,不是定案)**:
  - **done-for-you 替你做**(候选):目标是你不用自己攒/配/盯。⚠️ 诚实:差异不是「不用自托管」(我们八成也要 Docker/VPS 那套),是「替你搞定」。
  - **建并养一个真软件产品**(候选):不是一次性 MVP、不是营销生意。
  - **结果证明「一试真能跑、下周还能跑」**(候选锚点):非技术唯一能亲验的信任;⚠️ 我们现在也还没做实,是要争的地方。
  - **具体旗舰 = dogfooding 软件公司**(可借鉴的 bootstrap 打法落到我们)。
- **〔定位建议 · 待 Annie / FLY-911 拍〕** 一条可选的对外反差:品类喊「Zero-Human Company / 自动赚钱」,我们诚实反着讲——**「不是零人公司,是你做判断、AI 做工程」**。压在品类承认自动化不了的地方(判断/关系/信任)。用不用当主 messaging,911 拍。

---

## 我们跟谁「像」/ 差异候选(诚实 · 不硬下结论)

- **跟 Matrix + Paperclip 最像 —— 连组织骨架都撞**(都是「你指挥的分层 AI 公司」;三角色也对得上)。这个壳区分度不高 —— 但**别人在做不等于我们不能做**。
- 跟 Devin/Factory 的 async 派活→出 PR 同构,但它们卖给工程师、我们瞄非技术小生意主。
- 跟 Paperclip/Hermes/OpenHands 一样都还早、都要点技术才跑得动 —— 包括我们。
- → **真差异该落在「done-for-you + 真产品维护 + 可感知信任 + 我们自己的团队优势」,但具体主打哪条、成不成立,归 FLY-911 跟 Annie 收敛。本文只把候选摆出来。**

---

## 开放问题(喂 FLY-911)

1. ✅ **已定(Annie)**:目标客户 = 非技术小生意主。本文已按此重写。
2. **主线差异化**:done-for-you / 真软件 / 结果证明 三条候选里,哪条当一句话定位主线?(我倾向:结果证明当锚、done-for-you 当切分 —— 但这是 911 跟 Annie 拍。)
3. **反差 messaging**:「不是零人公司、是你做判断 AI 做工程」用不用当对外主线?
4. **诚实边界怎么讲**:我们现在还没到「完全非技术能用」—— 对外要不要坦诚「正在把它做成 done-for-you」而不是假装已经是?(我倾向坦诚,和品类一起早,反而可信。)
