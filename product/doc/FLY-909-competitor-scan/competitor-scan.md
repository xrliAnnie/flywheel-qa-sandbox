# FLY-909 竞品扫描 + 定位启发 — 交付物(round 2 · Annie 批注修订版 + Claude Cowork/Codex app 扩展 + round-4 WorkBuddy 折进)

Issue: FLY-909 (https://linear.app/geoforge3d/issue/FLY-909/竞品分析市面上别人怎么做-喂产品定位形态)
日期: 2026-07-07
基于: research.md + round-2 deep research + Annie round-2 批注(instruction 68563d64)
喂给: FLY-908(对外定位 & 产品形态 EPIC)/ FLY-911(定位收敛 —— 定位大结论在那拍)

> 一页看完:市场怎么分、各家什么状态、能借什么、我们的差异**候选**线索在哪 —— 全部按「**非技术小生意主**」这个视角(Annie 已定:能读 PR/做验收的高阶画像出局)。
> **口径(重要)**:「我们跟 Matrix/Paperclip 到底差异化不化、generic-vs-concrete」这类**定位大结论,归 FLY-911 跟 Annie 收敛,本文不硬下** —— 差异一律写成「候选 / 待 911 拍」。本文是喂料,不是定案。
> **本版改了什么**:〔round-2.1 Annie 批注〕①用词去丧(别人做了 ≠ 我们不能做);②Paperclip 真挖深(见 paperclip-deepdive.md);③不 overclaim「完全非技术」(现在还没到);④修正 Lovable(主要是出 UI 的地方);⑤自托管诚实化(差异是「done-for-you 替你做」);⑥bootstrap 打法写进「可借鉴」。〔round-2.2 扩展〕⑦加 **Claude Cowork + Codex app**,诚实回答「我们还有没有价值 / 会不会被取代」(见 ⑥ 节)—— 编排引擎不占优要认,真差异落在 领域/常驻组织/手机 IM/供应商中立 的组合(候选,待 911)。〔round-3 扩展〕⑧加 **Open Cloud/OpenClaw** 竞品 + **OPC 最先专攻的客户群** 答(见 ⑦ 节)+ 配套 **value-artifact.html**。〔round-3.1 Annie 纠正〕**OPC target 收窄 = 非技术电商/social operator(不是程序员)**;DIY 硬问题 reframe(会自己拼的是程序员、本就不是我们 target,风险不落在攻的这群);定位主线「替一个非技术的一人公司 operator,把一整个公司的活在聊天里做掉」。〔round-3.2 Raft — FLY-1001〕加 **Raft(raft.build,前身 slock)** 竞品(Annie 2026-07-08 发现)+ 三轴 vs Raft 逐轴标(见 §⑧ + `raft-deepdive.md`)。诚实结论:**Raft 是目前找到最贴、最该警惕的一家(比 Matrix/Cowork 更贴我们形态)、且引擎层比我们强(分布式共识+前 Kimi+已 ship version-check/staged-draft)**;三轴里两轴被它匹配/塌,只剩「非技术 operator done-for-you」这一轴站得住,且非结构、靠速度守。深挖分析 = `product/doc/FLY-1001-raft-competitor-scan/research.md`。〔round-4 扩展 · FLY-1003〕⑨加 **WorkBuddy(腾讯)** —— 我们扫过量级最大的大厂威胁(见 §⑨ + workbuddy-deepdive.md)。诚实结论:它把手机 IM / 供应商中立 / 个性化记忆+后台派发回报 / done-for-you / 目标是一人公司 一次覆盖,**手机 IM + 供应商中立两条候选差异退出、目标用户不再是差异**;活着的候选收窄到「长期 ownership lifecycle + 被协调组织自推进 backlog」两条,靠产品化速度守。跟 Raft(FLY-1001)结论收敛。〔round-4 · FLY-1004〕加 **homerail**(小天fotos 开源的语音多-agent 编排,可扒代码)进表 A + 独立 homerail-deepdive.md;**两个战略点都是好消息** —— ① homerail 明确不做软件(说软件最难判断好坏)→ 坐实我们「建并养真软件产品」是块没人占的空地;② 它 vendor-neutral 不自造 harness → 跟我们 executor-backend(FLY-493/494/350)独立撞车、方向验证。**语音层可借鉴**(双 TTS 通道/生成式 UI 短朗读/执行前确认)喂 FLY-1004 eng-idea 清单 + 我们 voice PRD。**本文只加 1 行 + 一句观察,不改已收敛的定位叙事。**

---

## TL;DR(3 句话)

1. **「一整个 AI 公司 / 一队 agent」这个形态,有人正面在做、而且做得早做得响**:Matrix(桌面、商业)+ **Paperclip(开源、免费、~70K star)** + 整个「Zero-Human Company」品类。**但「别人在做」不等于我们不能做**(OpenAI 之后有 Anthropic)—— 真差异不在「AI 公司」这个壳,而在我们能不能把**自己团队的优势**打出来。
2. **这条赛道自己也承认瓶颈**:执行已不是难点,**需求 / 有没有人买 / 信任 / 判断**才是。而且**大家都还早**——连 70K star 的 Paperclip 都被评测叫「原型穿着产品外衣」、每周报 bug。我们可以诚实地把「**人留在两头**(你给方向 + 你验收)」当一条对外线索。〔定位建议 · 待 Annie / FLY-911 拍〕
3. **对非技术小生意主,我们的差异候选(待 911)= 三条,用他听得懂的话讲**:**done-for-you 替你做**(目标是你不用自己攒/配/盯 —— 不是「不用自托管」,我们八成也要那套基建,而是替你搞定)· **建并养一个真软件产品** · **信得过**(东西一试真能跑、下周还能跑)。这三条是**候选线索**,主打哪条由 FLY-911 收敛。

**〔round-3 补 · Raft〕** 新竞品 **Raft** 把「人+agent 频道协作」这个形态**产品化**了,且**供应商中立 + 复利记忆 + 引擎层比我们强** —— 它使上面的差异**收窄到只剩一条**:替一个**自己建不了的非技术 operator** 把公司的活 **done-for-you** 做掉(Raft 瞄 builders/teams,不瞄这个客户)。这条**非结构、靠速度+聚焦守**,不是稳赢。详见 §⑧ + `raft-deepdive.md`。

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
| **🆕 homerail**(小天fotos) | 跑你自己家 NAS、语音进/生成式 UI 出的可审计 DAG 编排 runtime(原名贾维斯) | 单人 operator(自托管、voice-primary) | 桌面 voice shell + 浏览器 UI + 每 DAG node 一 Docker 容器;开源 TS | **语音层成熟**(双 TTS 通道/生成式 UI 短朗读);但要自托管 + **明确不做软件**;跟我们 voice+编排撞得最狠、代码可扒 → 见 homerail-deepdive.md + FLY-1004 | 开源(自付基建 + 自己的模型订阅 glm/kimi/codex) |
| **🆕 Open Cloud / OpenClaw** | 跑你自己设备、在你已用的 IM 里回你的**个人 AI 助理** | 技术自托管者(靠 Discord 把 agent 推向更广人群) | 本地自托管 + **29 个消息渠道**(Discord/TG/Slack/WhatsApp…)+ 跨会话记忆 + 浏览/填表/跑 shell | **界面跟我们最像(IM 驱动)**,但**多开几个也是各自为战、你得自己 juggle**(不是被协调的组织);2026 爆红(60 天 250K star)后因定价套利+安全降温 | 开源(自付基建) |
| **OpenHands**(All Hands) | 开源云端 coding agent 平台 | 开发者 | Cloud/CLI/SDK;连 GitHub → 出 PR | Cloud 也要懂 repo/git 流 | Free(BYOK)/$20 |
| **🆕 Claude Cowork**(Anthropic) | 非技术知识工作者的 AI coworker(在你文件上干活) | **明确非技术知识工作者** | Claude 桌面 app GUI,描述「做完什么样」→ 它做完交到你文件夹 | **done-for-you + 无需编程** —— 但做的是**你文件上的知识工作**(研究/合同/报告),不是建并养一个软件产品;桌面端、锁 Claude、是「你启动一个任务」 | 随 Claude 订阅 |
| **🆕 Codex app**(OpenAI) | agent 指挥中心(编排一队 coding agent) | **开发者-导演** | 桌面「command center」+ CLI;manager 协调并行 subagent(默认最多 6-8) | 面向开发者、要懂技术在桌面/CLI 编排;锁 OpenAI | 随 OpenAI 订阅 |
| **🆕 WorkBuddy**(腾讯) | 一句话→像同事一样自主规划执行、交付可验收结果的全场景职场 AI agent(**大厂办公 agent**) | **官方打一人公司/个体创业者/自由职业者/小团队 + 白领 + 企业**(与我们 beachhead **正面重叠**) | 桌面 app(读本地文件·sandbox)+ **官方 9 个 IM 渠道**(微信/Discord/Slack/TG/钉钉/飞书…)派活回报;多 agent 并行 + 100+ 专家角色 + 14 模型 TokenHub | **贴得最狠** —— 电商选品/落地页/客服都能做、一句话就跑;但**任务式交付、缺长期养一套系统的 ownership**;红海无鲜明优势(vs Copilot/豆包/WPS) | 个人 39/99/299 · 企业 99/199/999 元/月(免费档+50GB;⚠️各源出入) |
| **🌟 Matrix**(flowith) | Launch a 0-Person Company that actually earns | 想 0 人创业的个人/小团队 | macOS 桌面 app + 游戏小人可视化 | 门槛低但要下桌面 app、跑营销生意不是软件 | 公测免费 |
| **🆕🌟 Raft**(raft.build,前身 slock) | 人+AI agent 在频道/DM 里当**平等队友**共建("humans and AI agents build together") | **agent-native builders / teams**(重心偏技术;声称 non-coder 也能) | web workspace(channels/threads/@提及)+ 本机 daemon;agent **供应商中立**(Claude/Codex/Hermes)+ 持久记忆复利 | **形态最贴我们,但你得自己跑 daemon、当房间里的 PM** —— 对非技术自己建不了的 operator **不是 done-for-you**;引擎层它比我们强 | Free / Pro $8.80/seat / Enterprise |
| **🎯 Flywheel** | 由你指挥、替你建并养一个真软件产品的 AI 团队 | **非技术小生意主/创始人** | Discord 里跟 AI Lead 聊,Lead 管 Runner 建并维护你 GitHub 里的真产品 | **目标 done-for-you**(你不用懂技术);⚠️ **坦白:现在还没到** —— 跑起来仍需要点工程水平(Annie 自己用都撞 bug),产品化是待解题 | Claude 订阅制 |

**这张表看出的东西(观察,不是定位结论)**:
- **没有一家是「非技术真能自己跑起来 + 在已有 IM 里说话 + 替你建真软件」**;但要诚实 —— **这个「非技术真能自己用」现在谁都没做到**(连 Paperclip 都还是原型状态),我们也还没到。这是赛道的共同未解题,谁先把「done-for-you 真产品化」跑通谁赢。
- **builder 档(Lovable/Base44)** 里,Lovable 其实是**出 UI/前端**为主,别跟「替你建并养真产品」混一类。
- **agent 档(Devin/Factory/OpenHands)** 面向工程师;**开源框架档(Paperclip/Hermes/homerail)** 面向自托管者 —— 但 **Paperclip 明确在往 operators / 非技术小生意主打**,跟我们目标人群重叠。
- **🆕 Raft 是这张表里跟我们形态最贴的一家**(chat-teammate + 供应商中立 + 复利记忆),但它瞄 **builders/teams**、要你自己跑 daemon 当 PM —— 它**没占**「非技术自己建不了的 operator + done-for-you」这格。**这格现在仍空,但守它的护城河非结构、靠速度**(见 §⑧)。
- **🆕 大厂档(WorkBuddy/腾讯)已把多条候选形态差异一次覆盖**:多渠道 IM(官方 9 个)+ 多模型(14 个 TokenHub)+ 个性化记忆 + 多 agent 并行 + done-for-you,**且官方直接打「一人公司/自由职业者」+ 电商选品/落地页/客服** —— 「靠单点形态差异化 + 靠目标用户差异化」两条路都被它堵。详见 §⑨ + workbuddy-deepdive.md。
- **🆕 homerail(FLY-1004)= 跟我们 voice + 编排撞得最狠、且开源可扒的一个**:它语音层比我们成熟(可借鉴,喂 FLY-1004 eng-idea);但它**主动划掉软件赛道** + 跟我们 vendor-neutral 独立撞车 —— 两点都对我们有利。详见 homerail-deepdive.md。

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

## ⑥ 存在性拷问:Claude Cowork + Codex app 已经很 general 了 —— 我们还有没有价值?会不会被取代?(诚实答,别护短)

> Annie 直接问的最硬的问题。我按「诚实、别护短、验证她的假设别替她下结论」来答。**这是喂 FLY-911 的诚实评估,不是定案。**

**先说这俩是什么:**
- **Claude Cowork**(Anthropic):明确做**非技术知识工作者**的 AI coworker,活在 **Claude 桌面 app** 的 GUI 里(no terminal / no coding / no technical background),直接读你电脑上一个文件夹。用法是 **done-for-you**:你**描述「做完长什么样」→ 它自己 start/run/finish、把成品交到你文件夹**,你 review 成品(告诉它 what,不是 how)。底层是 Claude Code 的 lead+sub-agent 编排(sub-agent 还能生 sub-agent)。
- **Codex app**(OpenAI):**开发者的 agent 指挥中心** —— 桌面「command center」+ CLI,manager 协调一队并行 subagent(默认最多 6-8),覆盖 design/build/ship/maintain 全生命周期。开发者从写代码转成**编排/review/架构判断**。2M+ 周活。

**诚实第 1 条(别护短):编排引擎不是我们的护城河。** 「把一个 lead agent 拆活、派给 sub-agent、还能 dispatcher 分诊」—— 这现在是 **Claude(Cowork / Code Agent Teams / `/goal` 常驻 / agents dashboard)和 Codex(subagents GA)两家的一方功能**,大厂资源更足、迭代更快。我们这套 leads/departments/三段式,在**编排机制层面**跟他们**重叠很多、且我们不占优**。这条要认。

**诚实第 2 条(验证 Annie 的假设 —— 一半对一半不对):**
- **Codex app**:✅ Annie 猜对 —— 它是**开发者工具**,你在桌面/CLI 当导演、要懂技术、锁 OpenAI。跟我们的目标用户(非技术小生意主)不是一路人。
- **Claude Cowork**:⚠️ **Annie 的假设对它不成立,得诚实说** —— Cowork **恰恰是非技术 + done-for-you + 描述结果 review 成品 + 无需编程的 GUI**,这几乎就是我们对外讲的那套。**它是目前最贴、最该警惕的一家。**

**诚实第 3 条:那价值/差异到底还剩什么?(候选,待 911 —— 我验证出来的,不替 Annie 下结论)**
1. **领域**:Cowork 做的是**你文件上的知识工作**(研究综述 / 合同抽取 / 报告 / 数据整理),**不是建并长期维护一个真软件产品**;Codex 建软件但面向开发者。→ 「**替非技术的人建并养一个真软件产品/公司**」这块,两家目前都没正面做。
2. **常驻组织 vs 你启动的任务**:Cowork/Codex 本质是「**你启动一个任务/会话** → 它 fan-out → 交付」(Cowork 能跨多天,但仍是项目会话)。我们是一个**常驻的组织**(CoS 自己分诊 backlog、Leads、部门、always-on),不是「你每次启动一个活」。这条是真结构差异,但**别吹太大**(值不值钱要 911 判)。
3. **界面**:Cowork = **桌面 app + 你电脑上的文件夹**;Codex = 桌面/CLI。我们 = **手机原生 IM(Discord)**,不用开电脑、不用盯文件夹 —— 对「只带手机的非技术小生意主」体验更顺。**⚠️〔round-3/4 修正〕** 别把「手机 IM」当**真差异** —— WorkBuddy(官方 9 渠道含微信/Discord)+ OpenClaw(29 渠道)都做 IM 驱动,**手机 IM 已退为 table stakes**(见 §⑨);它是好体验,不是能拉开的差异。
4. **agent-agnostic / 供应商中立(Annie ④)**:**Cowork 锁 Claude、Codex 锁 OpenAI**;我们架构上能跨后端(Claude / Codex / GLM / MiniMax / Antigravity / Kimi)。**⚠️〔round-3/4 修正 · 此判断已作废〕** 原写「这是第一方厂商结构上不会做的真差异」—— 但 Raft(第三方却做 runtime-agnostic)+ WorkBuddy(云厂商腾讯 TokenHub 原生一键切 14 模型)已证伪:**供应商中立已退为 table stakes、不是差异**(见 §⑧ Raft / §⑨ WorkBuddy)。「不锁死你」仍是可信承诺,不当差异主打。
   - ⚠️ **〔round-3/4 修正 · 此子判断已作废〕** 原写「供应商中立可当定位候选讲、只是不必现在建全」—— 但 Raft(第三方 runtime-agnostic)+ WorkBuddy(腾讯 TokenHub 一键切 14 模型)已把它做成现成功能 → **它是 table stakes、退出差异候选**(见 §⑧/§⑨)。Annie「setup 先不做 agent-agnostic」不受影响:那本就不是要靠它当差异,只作「不锁死你」的可信承诺。

**诚实第 4 条:会不会被取代 / 风险在哪。** 最该盯的是 **Cowork(Anthropic 自己)**:它已经是「非技术 + done-for-you + 桌面 chat」。**如果 Anthropic 把 Cowork 指向「从手机替你建并长期维护一个软件产品」,我们的空间会被快速压缩。** 我们在**引擎层没有护城河**;价值全押在**把「done-for-you + 常驻组织 + 真软件产品维护」这套组合,替一个非技术小生意主真正做通** —— 而这套**现在还没产品化**(见 ③ 的诚实边界)。**⚠️〔round-3/4 修正〕** 此处原把「手机 IM + 供应商中立」也列进组合 —— 经 Raft/WorkBuddy 覆盖,这两条已退为 table stakes、不算组合里的差异项(见 §⑧/§⑨)。**所以答案不是「我们注定被取代」,也不是「我们稳」,而是:差异存在、但薄,赢面取决于我们能不能比一个通用知识工作工具更早把这套具体组合做成真能用的 done-for-you 软件团队。这个判断,911 跟 Annie 拍。**

---

## ⑦ Open Cloud / OpenClaw + OPC 最先专攻的客户群 的硬问题(Annie 新 最先专攻的客户群)

### Open Cloud / OpenClaw 是什么(Annie 灵感来源)
- **是什么**:Peter Steinberger 的开源**个人 AI 助理**,跑在**你自己的设备**上、在你**已经在用的 IM**(Discord/Telegram/Slack/WhatsApp/Signal… 29 个渠道)里回你;本地私有、零云依赖;能浏览网页/填表/读写文件/跑 shell,跨会话记忆你的偏好/项目/人。
- **怎么起来的**:Clawdbot → Moltbot → OpenClaw(2026-01);2 月破 100K star、**~60 天 250K star(史上最快 repo)**;**build-in-public + Discord 当 showroom**、半百万系统在跑,创始人上 Fast Company AI 20。
- **现状(热度回落 —— 诚实)**:安全事故(恶意第三方 skill / 过度授权 / 钓鱼 repo)后降温,「OpenClaw is dead」成论坛梗。**真因 = 定价套利泡沫**(靠一段被低估的算力起来,平台把算力调贵后几天崩,休闲用户走光、只剩认真工作流)+ 创始人转投 OpenAI 阵营带走社区 + 深度本地访问的安全风险。**但项目没死** —— 转成 AI-agent stack 里认真-谨慎的一层,375K+ star、周更、猛推可靠性(agent 恢复/audit trail/MCP 校验/LTS)。
- **⭐ 起源故事(Annie,真实 —— 写进 building-in-public 素材)**:**Flywheel 最早就是搭在 Open Cloud 上的** —— Annie 一开始在 OpenClaw 上搭这套系统,后来 Claude Code 能连 Discord 了才迁过来。所以 OpenClaw 对我们不只是竞品,是**起点**。这条真实起源(「我自己在 OpenClaw 上搭、撞到墙,才做了 Flywheel」)是极强的 build-in-public 故事,建议进 GTM 素材。
- **跟我们:重叠 / 差异(诚实,已按 Annie 纠正)**:
  - **重叠(界面最像)**:它就是「把 agent 通过 Discord/IM 推给更广人群」—— 跟我们**手机 IM 驱动**的界面赌注一样,连 Discord-当门面都像。
  - **⚠️ 差异不在 agent 数量、在协调(Annie 纠正,重要)**:别再讲「我们多部门组织 vs 它单个助理」—— **多开几个 OpenClaw 也能凑成多部门,这框站不住**。真差异 = **N 个 OpenClaw = 各自为战、你得自己 juggle**(各跑各的、不互通、你当人肉调度);**我们 = 一个被协调的常驻组织**(Leads 互通、共享 backlog、跨项目复用经验、部门分工)—— **对外是一家公司在动,不是 N 个你得盯的助理**。
  - **可借鉴**:多渠道触达 + 跨会话记忆 + Discord-showroom 的 build-in-public。
- **⚠️ OpenClaw 踩的坑 → 我们怎么避(喂「持久 vs 昙花」这条)**:
  1. **硬定价、别做套利泡沫**:它靠一段被低估的算力爆红、算力调贵后几天崩 —— 我们定价要建在**真实可持续的价值**上,不赌一时的价格红利。
  2. **安全、别裸 provision**:它深度本地访问 + 恶意第三方 skill 出事 —— 我们要 **managed、有边界、不把安全敞口甩给用户**。
  3. **可靠性要 managed**:它把稳定性甩给自托管用户 —— 我们做**替你托管的可靠**,这正是「持久」区别于「昙花」的地方。
- ⚠️ **Aimless Agent 查无实据**:两轮 WebSearch 没找到叫「Aimless Agent」的项目(可能很小众/很新,或名字近似,像之前 open people→OpenHands)。**请 Annie/Lead 确认真名或给个链接,我再补**;先不硬编造。

### OPC 最先专攻的客户群(Annie 收窄):目标 = 非技术的一人公司 operator,不是程序员
**⚠️ target 收窄(盖过早前「技术够的 solo founder」的说法)**:最先专攻的客户群 = **非技术的 OPC operator** —— 自己做电商、自己做 social media 的一人公司。他有「**一个人干一个团队的活**」的痛,但**不是程序员、自己拼不出来 → 需要 done-for-you**。**程序员 OPC 不是我们专门 target**(他们自己能搞、不需要我们、我们也抢不过;能用我们产品但不是攻的人)。

**定位主线一句话(Annie 定)**:「**替一个非技术的一人公司 operator,把一整个『公司』的活在聊天里做掉。**」

**DIY 硬问题的诚实 reframe(关键)**:引擎层(编排)我们**确实没护城河** —— 但**会自己拼的是程序员,而程序员本就不是我们攻的人**,所以「能 DIY」这个风险**不落在我们要攻的那群(非技术电商/social operator)身上**。诚实两句:
- 对**能 DIY 的技术人**:我们不占优、也**不攻他们**。
- 对**非技术电商/social operator**:他们**拼不出来**(不是程序员),要的是**替他们做 + 常驻组织 + 生态整合 + 体验气质**,不是自己拼引擎。

对这群人,真差异押哪(候选,待 FLY-921):
1. **替你做(done-for-you)+ 被协调的常驻组织**:差异**不在 agent 多不多**(多开几个 OpenClaw 也能凑数),**在协调** —— 一个 always-on、Leads 互通、共享 backlog、跨项目复用、部门分工的**被协调组织**,对外像**一家公司在动**;而不是 N 个各自为战、要你自己 juggle 的助理。一个非技术 operator 更弄不出这份协调,也不该要求他去当人肉调度。
2. **生态整合 / 供应商中立**:按任务难度配模型 + 成本、单一工具短板用别的补(CC 弱多模态 → 接 Antigravity)—— 非技术 operator 更不可能自己整合。**⚠️〔round-3/4 修正〕** 别再讲「中立整合是第一方结构上不做的」—— Raft/WorkBuddy 都做了多模型(见 §⑧/§⑨);活着的点是**「替非技术 operator 免自己整合」的 done-for-you**,不是「中立」本身(那已是 table stakes)。
3. **体验气质**:managed、可靠、像真人团队在干(有趣 + drama + 真实,voice 让它像真人)—— 一个非技术 operator 要的是「有支队在替我热闹地干活」,不是一堆要自己调的工具。
**诚实总结**:对**非技术电商/social OPC operator**,我们赢的是「**他自己做不了 / 不该自己拼,我们替他把一整个公司的活在聊天里做掉**」。这够不够撑一个生意,**归 FLY-921 跟 Annie 拍**。详细 Value 见配套 **value-artifact.html**。

---

## ⑧ Raft(raft.build)—— 最贴的产品化版 + 三轴 vs Raft(round-3 · FLY-1001)

> Annie 2026-07-08 发现的新竞品。Cass 定性「Flywheel 形态的产品化版」—— 核实后**成立、而且比 Matrix/Cowork 更贴**。独立深挖见 `raft-deepdive.md`;Cass 三压测点逐条压出的证据结论见 `product/doc/FLY-1001-raft-competitor-scan/research.md`。**本节按 Honey Lemon 定调:写透『wedge 薄、非结构性』,别糖衣。**

**Raft 是什么(核实)**:人+AI agent 在 channels/DM/threads 里当**平等队友**共建;agent 持久身份+记忆、**runtime-agnostic(Claude/Codex/Hermes)**、互相 hand-off+review、"the next one builds on"(复利);跑你自己硬件上的 **lightweight daemon**;目标 **agent-native builders/teams**;定价 Free / Pro $8.80/seat / Enterprise;创始人分布式共识出身+前 Kimi、工程博客已 ship version-check/staged-draft(正是我们还在 backlog 打的 FLY-574 那类坑)。

**威胁到哪(正面撞车)**:①**形态**逐条命中(chat-teammate+@提及+agent 当同事,已产品化)②**供应商中立**——它第三方却做 runtime-agnostic,**打穿我们「中立=第一方不会做」的差异** ③**复利/记忆**机制层被匹配甚至更精 ④**引擎层比我们强**(人+专注+已 ship 的证据)⑤是家专注的真公司,不是玩具。**唯一没被吃的口子 = 目标客户**:Raft 瞄 builders/teams(你跑 daemon、当 PM),**非技术自己建不了的 operator 是它盲区** = 我们 最先专攻的客户群。

### 三轴差异化 —— 逐轴标 vs Raft(核心交付)

| 轴 | vs Raft | 一句话 |
|---|---|---|
| **① 领域**(替非技术 operator 建养真软件产品、跑真实业务、长期维护) | **部分成立** | 站得住 = **done-for-you + 给建不了的人 + 养**;塌 = 「跑在真实软件上」(**Raft 主场**,它 agent 本就跑你真 repo);且**待兑现**,我们还没 ship done-for-you |
| **② 被协调常驻组织 + 复利**(always-on + 记忆 + 管理分诊 + Push) | **大部分不成立** | 复利/记忆/常驻**被 Raft 匹配甚至更精**;只剩「**管理+Push 层(不用你当 PM)**」一薄条,还可被 Raft 加个 manager agent 补 |
| **③ done-for-you 给非技术 + founder 判断** | **成立(最硬)** | Raft 盲区=非技术建不了的 operator = **我们 最先专攻的客户群**;Annie operator-taste vs Raft engine-taste 真方向差。**但非结构、靠速度+聚焦守、done-for-you 未 ship** |

**净结论**:三轴里 **②(大部分)+ ①(一半)被 Raft 匹配或塌**,只有 **③(客户 wedge + taste)真站得住,且非结构、靠速度守、还没兑现**。〔与 WorkBuddy(§⑨)结论收敛:手机 IM/供应商中立/记忆 都被大厂+同形态竞品匹配,只剩「替非技术 operator done-for-you 长期养系统」这条靠速度守。〕

### Cass 三压测点 —— 证据结论(一句话;详见 research.md §1–3)
- **① 停在 orchestrator 层=被吃** → **完全成立、更扎心**:Raft 本身=被产品化的 orchestrator 层、更成熟。护城河是**待兑现赌注不是现有资产**;按我们诚实边界(done-for-you 没到),**此刻我们离『停在引擎层』比离『已 ship 复利产品』更近**。
- **② 融资+专注+前 Kimi → 引擎更精** → **成立,认输这层**:硬证据 = 他们已 ship 我们还在 backlog 的解法。**别比引擎精巧度(必输战场)**,引擎够用就行。引擎领先**不自动**给它我们的客户(③ 的口子)。
- **③ 唯一真差异(自用+真实产品闭环+Annie 判断)** → **真实但薄**:dogfooding 不是护城河(Raft 也自用、同主场);「跑真实产品上」= Raft 主场;复利被匹配;最能守的 = 指向非技术 operator 的 founder taste,但要转成 ship 出的产品才算数、且还在建(Anna)拿真客户声音磨。**先发+聚焦+taste 优势,非结构护城河。**

### 一句话(不美化)
**Raft 是目前找到最贴、最该警惕的竞品** —— 它把我们的形态产品化了、引擎层更强、还供应商中立。它没吃掉我们的**唯一原因** = 它现在瞄 builders,不是我们那个「自己建不了的非技术 operator」。**活路窄且非结构:在 Raft 掉头下移市场之前,把 done-for-you 复利产品替这个客户真正做通。**

---

## ⑨ WorkBuddy(腾讯)—— 最强的大厂威胁(FLY-1003 折进;深挖见 workbuddy-deepdive.md)

> Annie 2026-07-08 点名的又一竞品(跟 Raft/FLY-1001 同一套打法)。**这是我们扫过量级最大、且比其他家更贴的一家** —— 它把我们一堆候选形态差异一次覆盖,官方还直接打「一人公司/自由职业者」。**诚实、不护短。**

**是什么**:腾讯云 CodeBuddy 团队出的**全场景职场 AI 智能体桌面工作台**(腾讯从「服务开发者」向「服务全职场人」延伸)。桌面 app(读本地文件·sandbox)+ 官方 9 个 IM 渠道派活回报;多 agent 并行(Expert Teams:lead+sub)+ 100+ 专家角色 + 14 模型 TokenHub + MCP。上线 3 个月 **13M+ DAU**(⚠️非独立审计)、中国第一效率 agent。**辨析**:腾讯真正的 OpenClaw 衍生品是 **QClaw**(微信直连遥控器);造软件的是 **CodeBuddy**(给开发者);**WorkBuddy = 办公,含 development 角色但不主打编程**。

**逐轴站/塌(诚实):**
1. **③ 手机 IM / ④ 供应商中立 —— ❌ 塌了**。官方 9 渠道 IM + 14 模型 TokenHub 正面覆盖;「第一方结构上不做多模型」站不住(**云厂商腾讯原生就做**)。**两条退出差异清单,跟 Raft 结论收敛。**
2. **⑦ 目标用户 —— ⚠️ 部分塌 / 重叠很大**。官方逐字打 **"one-person company / individual entrepreneurs / freelancers / small team leaders"** + 电商选品/落地页/IM 客服场景 —— **正面撞我们 beachhead**。差异不在「目标用户」本身,在「目标用户 + job」的绑定。
3. **⑥ Push —— 半塌**。「异步远程执行 + 回报」已商品化(它也有);活着的候选只剩「自发起 backlog 分诊 + 跨 Lead 协调 + 持续 ownership」半(「always-on daemon」官方未证,⚠️存疑)。
4. **① 领域(长期 ownership)+ ② 被协调组织 —— ⚠️ 当前最像还站得住的候选,但更窄**。WorkBuddy 是**任务式交付**(一件件做完交付),不是「长期拥有并演进一套软件/业务系统的 lifecycle」;是**你派活的(有记忆的)助理**,不是「被协调、自己推 backlog、持续 own 的组织」。**Watch:腾讯把 WorkBuddy 办公/IM + CodeBuddy 建软件 + 腾讯云部署 融成 operator 系统 → 这条快速压缩。**
5. **⑧ 工程纪律/可信 —— ⚠️ 方向对但我们没做实**(它复杂任务易错/半途/代码深度弱是机会;我们「一试真能跑」也还没做实)。

**大厂威胁形态(founder 该看的)**:
- **威胁真**:量级碾压(13M DAU + 微信生态分发 + 企业渠道,不是能力碾压)+ 覆盖面&目标都撞。**⭐ Substitution path**:腾讯**不用抄我们架构** —— 把 IM 派发(微信/企微/QQ)+ 办公/业务 skill(选品/落地页/客服)+ 腾讯云部署 + TokenHub + CodeBuddy 建软件 + 企业销售 + 存储捆绑 + 社交图谱 拼成**够用的 operator 系统**,就能在我们产品化之前**从「够用的业务自动化」侧吃掉 beachhead** —— 全程不用长得像 GitHub/PR/CI。
- **没到取代(诚实另一半)**:长期 ownership 的闭环还没有(任务式交付、造软件在分开的 CodeBuddy 给开发者、两者还没融);验收/可信仍弱;大厂融合这件对它非核心的事有结构惰性。**窗口靠速度守,不靠护城河。**

**可借鉴**:多 agent 并行拆解 / 100+ 专家角色即现成虚拟团队(喂 FLY-910)/ sandbox 隔离(能感知的护栏)/ 免费档+50GB。**别学**:红海堆功能无鲜明优势 + 腾讯生态锁定(兼容非腾讯工具差 —— 正是我们「供应商中立整合」可讲、但只当可信方向不当现在主卖点的地方)。

**一句话差异化候选(收窄后,给 Annie 挑)**:「WorkBuddy 是大厂的、什么办公活都能帮你一件件交付的 AI 助手(还打一人公司);Flywheel 押的是**替非技术 operator 长期拥有并演进一套真软件/业务系统 —— 一个被协调、自己推 backlog 的组织在替你养着**。」当前最像还站得住的候选差异 = 长期 ownership lifecycle + 被协调组织自推进 backlog,**均更窄、靠产品化速度守;主打哪条归 FLY-911 拍**。

---

## 我们跟谁「像」/ 差异候选(诚实 · 不硬下结论)

- **跟 Matrix + Paperclip 最像 —— 连组织骨架都撞**(都是「你指挥的分层 AI 公司」;三角色也对得上)。这个壳区分度不高 —— 但**别人在做不等于我们不能做**。
- 跟 Devin/Factory 的 async 派活→出 PR 同构,但它们卖给工程师、我们瞄非技术小生意主。
- 跟 Paperclip/Hermes/OpenHands 一样都还早、都要点技术才跑得动 —— 包括我们。
- **🆕 跟 Raft 形态上最贴、和 Cowork 并列最该警惕**(见 §⑧ + `raft-deepdive.md`):它就是「人+agent 频道协作」的产品化版,**供应商中立 + 复利记忆 + 引擎层比我们强**。**论威胁我们的形态,Raft 比 Cowork 更狠**(Cowork 是上方威胁=Anthropic 非技术 done-for-you;Raft 是侧翼=有钱创业、就是我们的形态)。唯一没被它吃的口子 = 它瞄 builders/teams、不瞄「自己建不了的非技术 operator」。
- **🆕 跟 WorkBuddy(腾讯)是量级最大的大厂威胁,且覆盖面 + 目标都撞**(官方打一人公司/自由职业者、9 渠道 IM、14 模型、done-for-you)。**它逼我们把差异表述再收窄:手机 IM + 供应商中立两条经它正面覆盖已退出;目标用户不再是差异。详见 §⑨。**
- **跟 Claude Cowork 定位上最贴、最该警惕**(它也非技术 + done-for-you);跟 Codex app 的「一队 agent 覆盖软件全生命周期」编排重叠,但它面向开发者。**编排引擎层面我们不占优,详见 ⑥;Raft(§⑧)+ WorkBuddy(§⑨)出现后更坐实——有人正拿更足资源/更专注(Raft)或更大分发(腾讯)把编排层做成产品。**
- → **真差异该落在「领域 = 替非技术 operator done-for-you 长期拥有并演进一套真软件/业务系统 + 被协调组织自推进 backlog(不用你当 PM)+ 客户 wedge(自己建不了的非技术 operator)」—— ⚠️ 经 Raft(§⑧)+ WorkBuddy(§⑨)双重收窄:『供应商中立 / 复利记忆 / 手机 IM / 个性化记忆 / 目标是一人公司』都被匹配或覆盖,退出差异候选、当 table stakes;活着的差异非结构、靠速度 + 聚焦守、还没兑现。具体主打哪条、调不调定位,归 FLY-911 跟 Annie 收敛。本文只把候选摆出来。**

---

## 开放问题(喂 FLY-911)

1. ✅ **已定(Annie)**:目标客户 = 非技术小生意主。本文已按此重写。
2. **主线差异化**:done-for-you / 真软件 / 结果证明 三条候选里,哪条当一句话定位主线?(我倾向:结果证明当锚、done-for-you 当切分 —— 但这是 911 跟 Annie 拍。)
3. **反差 messaging**:「不是零人公司、是你做判断 AI 做工程」用不用当对外主线?
4. **诚实边界怎么讲**:我们现在还没到「完全非技术能用」—— 对外要不要坦诚「正在把它做成 done-for-you」而不是假装已经是?(我倾向坦诚,和品类一起早,反而可信。)
5. **面对 Cowork/Codex 这种大厂通用编排(尤其 Cowork = 非技术 done-for-you)**:我们押哪条组合当立身之本?(⚠️〔round-3/4 修正〕原写「领域 + 常驻组织 + 手机 IM + 供应商中立最能拉开」—— 经 Raft/WorkBuddy 收窄,**手机 IM + 供应商中立已退为 table stakes**;活着的 = 领域「替非技术 operator 长期养真软件系统」+ 被协调组织自推进 backlog + done-for-you。这条 911 拍。)
6. **🆕〔round-3〕面对 Raft(同形态、产品化、供应商中立、引擎领先)**:定位要不要调?(我的证据结论:target 层没被威胁——Raft 不要我们客户;可防御性层被威胁——供应商中立/复利/always-on 都被匹配。建议:①Raft 进最该警惕并列 Cowork ②退供应商中立/复利当差异、降 memory/always-on 为 table stakes ③狠押客户 wedge + 管理/Push + build-in-public + Annie taste ④诚实写『靠速度守非结构守』⑤最先专攻的客户群 不动。**弹药+建议在此,调不调 Annie 拍;详见 `raft-deepdive.md` + `product/doc/FLY-1001-raft-competitor-scan/research.md §6`。**)
7. **🆕〔round-4 · FLY-1003〕面对 WorkBuddy(腾讯,带微信生态分发 + 已正面打一人公司)**:手机 IM / 供应商中立经它覆盖后已退出;活着的候选只剩「长期 ownership lifecycle + 被协调组织自推进 backlog」两条,且靠**产品化速度**守。问题:(a)这两条够不够撑一个生意?(b)面对腾讯的 substitution path(选品/落地页/客服 + 腾讯云部署拼成够用的 operator 系统),我们要不要把「长期拥有并演进真系统」这条**更早做实**当立身之本?(c)对外要不要显式讲「大厂能做够用的办公活,我们做的是替你长期养一套真系统」?—— 与 Raft(#6)结论收敛,911 跟 Annie 拍。
