# FLY-1001 Raft 竞品分析 — 调研(压测三点 + 三轴 vs Raft + 911 影响)

Issue: FLY-1001 (https://linear.app/geoforge3d/issue/FLY-1001/raft-竞品分析-raft-vs-flywheel-差异化-competitor-scan-round-3)
日期: 2026-07-08
基于: exploration.md;上游 = FLY-909 competitor-scan(证据源)+ FLY-911 定位 + FLY-999/1000(Cass Raft profile)+ 1 轮有界核实(raft.build)

> **这份是给 Annie 定位决定的战略输入**,不是喂料清单。骨架 = Cass 在 FLY-1001 comment 里的三个压测点,逐条用 FLY-909/Raft 证据压出诚实结论,**写透『wedge 薄、非结构性』,别糖衣**(Honey Lemon 定调)。结论 raft-deepdive.md + competitor-scan.md 折入,FLY-911 只出影响评估 + 建议(定位调不调 Annie 拍)。

---

## 0. Raft 核实事实(枢轴,不重复 Cass profile 的 raw-dig)

来源:raft.build 首页 + docs.raft.build/welcome + 创始人推文(WebSearch 引用)+ FLY-999/1000。

- **一句话**:"Where humans and AI agents build together" / "the future of work isn't humans using AI tools. It's humans and AI agents building together." 人 + AI agent 在 channels/DM/threads 里当**平等队友**("real teammates in the room, not tools, as equals")。
- **目标客户**:"**agent-native builders and teams**" —— 重心偏**技术 builder / 团队**(codebase 记忆、CI/CD、code review 是明写的用例);声称 non-coder / GTM 团队也能上手(边界模糊)。
- **产品形态**:web workspace(channels / threads / tasks / @mentions)+ agent 跑你**自己硬件**上的 **lightweight daemon**(你控制算力、代码/数据隐私)。
- **agent 机制**:持久身份 + 记忆(codebase / 偏好 / 历史对话都留)+ 专长;**runtime-agnostic —— Claude / Codex / Hermes / more**;claim task、并行、互相 hand-off、在 shared thread 里互相 review;"what one agent figures out, **the next one builds on**"(复利)。多人多 agent:"teammates bring their own agents, agents hand off to others' agents"。
- **定价**:Free(全功能、30 天历史)/ Pro **$8.80/seat/月**(human=1 seat, agent=0.1 seat, 年付)/ Enterprise(私有部署 + SSO,coming)。
- **团队**:创始人 TennyZhuang(@zty0826)分布式共识出身(Paxos/Raft/FLP,"how do independent actors with partial knowledge ever agree on anything")+ 团队多前 Kimi/Moonshot;工程博客(『报数』)已产品化 **version-check + staged-draft + Dmail(context view)** 解 stale-snapshot 协作坑。

**一句话定性**:Raft = **「Flywheel 形态的产品化版」这个说法,核实后成立、而且比 Matrix/Cowork 更贴** —— chat-teammate + channels + @提及 + agent 当同事 + 供应商中立 + 复利记忆,几乎逐条命中我们的形态赌注,还做成了一家专注、会写工程博客、有定价的真公司。

---

## 1. 压测点 ① —— 下游护城河只在我们「真 ship 复利产品」时成立;停在 orchestrator 层 = Raft 吃我们

**Cass 的命题**:『护城河在下游』是假设,不是定论 —— 要是我们停在『造 orchestrator』这层,Raft 直接把我们吃了。

**证据压出的结论:① 完全成立,而且比 Cass 说的更扎心。**

- Raft **本身就是**「被产品化的 orchestrator 层」:channels + agent 当队友 + hand-off + 互相 review + runtime-agnostic + 持久记忆。这一层**它做得比我们成熟**(有 docs / 定价 / 工程博客),还更专注。
- FLY-911 §2 已自认「引擎层无护城河」;FLY-909 §⑥.1「编排引擎不是我们的护城河」。**Raft 的出现把这句从『自谦』变成『已被验证的事实』** —— 有人正拿更足的资源、更专注地把这一层做成产品。
- 所以下游护城河**不是我们已经握有的资产,是一个待兑现的赌注**:只有当我们真的 ship 出「一个跑在真实业务上、被长期维护(养)、随时间复利」的软件产品/系统,这条护城河才存在。
- **扎心处(诚实)**:按 FLY-909/911 自己的诚实边界 —— 「结果证明还没做实、还一堆 bug、Annie 自己用都撞 bug、done-for-you 还没到」—— **此刻我们离『停在 orchestrator 层』比离『已 ship 复利产品』更近**。也就是说,**今天**如果拿我们和 Raft 摆一起比,比的恰恰是我们最弱、它最强的那一层(引擎)。
- → **① 的战略含义**:护城河是「未来执行」的赌注,不是现在的护身符。Raft 把赌注的赔率变差了 —— 我们在引擎层多耗一天,被吃的概率就高一分。**唯一解 = 尽快把重心从『造引擎』挪到『ship 下游 done-for-you 复利产品』**,否则 Cass 这条压测就是我们的死法。

---

## 2. 压测点 ② —— Raft 有我们没有的(融资 + 专注 + 前 Kimi 的人)→ 编排层他们大概率做得更精

**Cass 的命题**:编排层他们大概率做得比我们精。

**证据压出的结论:② 成立,建议直接认输这一层、别在引擎上跟它掰。**

- **人**:创始人研究的就是「独立个体在只有局部信息时如何达成一致」= **多-agent 协调的第一性问题本身**;团队多前 Kimi/Moonshot(强模型/基建血统)。这套人马做 agent 编排,起点比我们高。
- **专注**:Raft = 这**一件事**(raft.build 一个产品、docs、定价、工程博客连载)。Flywheel = Annie 一边跑 GeoForge3D / 内容 COE / 一堆真业务、一边 dogfooding 建出来的 —— **不是一支拿了钱、只做这一件事的创业团队**。专注度不对等。
- **已交付的证据**:他们工程博客已经**产品化**了 version-check + staged-draft + Dmail context-view —— 解的正是我们**还在打**的坑(FLY-574 draft-not-sent、crossed-wires:Lead 读旧频道快照)。**在同一个机制问题上,他们已经 ship 了解法,我们还在 issue backlog 里。** 这是编排层他们更精的硬证据,不是猜。
- → **② 的战略含义**:**不要在引擎/编排的精巧度上跟 Raft 竞争 —— 那是我们必输的战场。** 我们的引擎只需要「够用、能托起下游 wedge」,过度打磨引擎 = 在我们输的地方投兵。
- ⚠️ **一条诚实的反向 nuance(别把 ② 用过头)**:引擎领先**不自动**给 Raft 我们的 wedge。「把 builder 的 agent 协作做得更精」≠「替一个自己建不了的非技术 operator 把公司的活 done-for-you 做掉」。② 证明的是「引擎战场我们输」,**不是**「Raft 已经赢了我们的客户」。这给 ③ 留了口子 —— 但那口子有多硬,得 ③ 用证据说。

---

## 3. 压测点 ③ —— 唯一真差异 = 自用 + 真实产品反馈闭环 + Annie 判断;逐块用证据证明「硬不硬」

**Cass 的命题**:这条得用证据证明它硬,不能靠嘴。

**证据压出的结论:③ 是真的、但薄 —— 三块没有一块是 Raft(有钱有人)造不出来的结构护城河;真正难抄的是『组合 + 指向一个 Raft 不服务的客户 + 认真操盘的先发』。逐块拆:**

### 3a. 自用(dogfooding:Flywheel 建 Flywheel)
- **撑它的证据**:我们真的用 Flywheel 建 Flywheel(self-hosting,FLY-270 Aunt Cass/Tadashi 两层 onboard 真上线),也真跑在多个真业务上。天天吃自己产品的痛。
- **压它的证据(硬不硬)**:**dogfooding 不是护城河,是通用开发实践** —— Raft 大概率也 dogfood(dev-tool 创业几乎都自用)。而且**我们 dogfood 的地形 = 建软件,恰恰和 Raft 的 builder 主场同一块地**。「dogfood 软件工程」对 Raft **不构成差异,是 table stakes**。
- **真正有区别的那一丝**:不是「我们 dogfood」,是「Annie 本人作为一个半-非技术的 operator,拿 Flywheel 在跑 GeoForge3D 电商 / 内容 COE 这些**非软件的真业务**」—— 这个闭环比 Raft 的 builder-dogfood 更贴我们的目标客户。
- **但这丝也不干净(诚实)**:(a) Annie 技术够到能自己 debug,**不是纯非技术 operator**,所以这个闭环只是目标客户的**近似 proxy**,不是本尊(FLY-909/911 自认「跑起来仍需要点工程水平」);(b) 非结构 —— Raft 拿钱招几个 operator design partner 也能搭这个闭环。
- **3a 结论**:**部分**。dogfooding 本身不硬(Raft 也能、且同主场);硬的那丝 = 「真 operator 跑真非软件业务」的闭环,但它(a)还不干净(Annie 半技术、产品还没 done-for-you)(b)不排他。**是先发 + 真实共情 + build-in-public 素材的优势,不是护城河。**

### 3b. 真实产品的反馈闭环(跑在真实产品上、复利)
- **撑它的证据**:我们跑在 GeoForge3D(有真客户真订单的 3D 打印电商)、内容 COE 等**真业务**上,不是 Matrix 那种 3 家 demo 公司;并且跨项目复利(global skill 框架 FLY-216、org 记忆、跨项目复用)。
- **压它的证据**:**「跑在真实产品上」对 Raft 不成立为差异 —— Raft 的模型本来就是 agent 跑在你真实 repo、你自己硬件上干真活(CI/CD、code review)。** 每个 Raft 用户带自己的真产品进来。所以「真实」不是我们独有。
- **复利这条(Honey Lemon 点名要诚实标)**:Raft **有**持久记忆 + agent 互相接力(next one builds on)+ hand-off + review。**复利/记忆在机制层被 Raft 匹配,甚至更精。** 我们的复利-as-机制**不成立为差异**。剩下的只有复利-as-已积累资产(我们跨 GeoForge3D/sub/joycon/tidal-echo 攒下的 battle-tested skill 库 + org 记忆)—— 那是**先发资产**,但一个拿了钱的 Raft 建个 shared skill 市场能追,**不是结构护城河**。
- **3b 结论**:**部分/大部分塌**。「跑在真实产品上」= Raft 主场,不成立为差异;「复利/记忆」机制被匹配(按 Honey Lemon 定调:标不成立);只剩「我们已积累的具体 skill/记忆语料」这份**先发资产**,可追、非结构。

### 3c. Annie 的判断(founder judgment / taste)
- **撑它的证据**:产品/定位由 Annie 对「一个非技术 operator 到底需要什么」的 taste + 判断驱动,且她在跑真业务。**这份判断是不可复制的(它是一个具体的人)**;Raft 创始人是分布式系统工程师,taste 天然偏**引擎 / rigor**,不偏「非技术 operator 的 done-for-you 体验」。**方向差是真的。**
- **压它的证据(别把它当万能挡箭牌)**:(a)「founder judgment」是**每家创业都会喊**的护城河 —— 只有当它产出**竞品不会去抄的差异化产品决定**时才算数;(b)判断是**输入不是资产** —— 没被转成 ship 出的产品之前,它不产生护城河;(c) Raft 的 founder judgment 在**它的领域(引擎)更锋利**,我们的判断只在**operator-共情 / 非技术 UX** 这一维更锋利 —— 前提是 Annie 真能代表 / 贴近目标 operator。而 Annie 半-技术这件事说明**我们对『真非技术 operator 要什么』的判断还有 gap**:Anna 采访 bot(FLY-879)存在的理由,恰恰是我们**还在建**「拿到真 operator 声音」的渠道 = 我们承认这份判断还没完全握有。
- **3c 结论**:**成立但有条件**。指向非技术 operator wedge 的 founder taste 是三块里**最能守**的一块(一个人的品味、指着一个 Raft 的引擎-founder 没在优化的客户);但它(i)要转成 ship 出的差异化产品才算护城河,(ii)我们还在建(Anna)拿真客户声音来磨它。**是方向性优势,不是已证明的硬护城河。**

### ③ 汇总
「唯一真差异」**真实但薄**,主体是**先发 + 聚焦 + taste**,不是结构护城河。三块没一块 Raft(有钱有人)造不出。**Raft 一时半会难抄的 = 这三块的组合 + 指向一个它不服务的客户(非技术自己建不了的 operator)+ 认真操盘的先发 + build-in-public 起源故事 + 已积累的跨项目 skill/记忆语料。这个组合、快速执行,才是赌注 —— 靠速度+聚焦守,不靠结构守。**

---

## 4. 三轴差异化 —— 逐轴标 vs Raft 成立 / 部分 / 不成立(交付核心)

> 三轴 = 911 现在的差异化支柱(Honey Lemon 确认口径)。每轴用上面的证据诚实标。

### 轴 1 · 领域 = 替非技术 operator 建养一个真软件产品/系统(跑真实业务、长期维护)
**判定:部分成立。**
- **站得住**:Raft 是通用协作 workspace(软件+研究+写作+运营),重心 builders/teams,**不是**「替一个自己建不了的非技术 operator 把业务软件 done-for-you 建好并长期养着」。DOMAIN 里「done-for-you + 给建不了的人 + 长期养」这层,不是 Raft 的靶。
- **塌掉**:「跑在真实软件/产品上」不独有 —— Raft 的 agent 本来就跑你真 repo;而且「建软件」是 Raft **主场**(它的强项)。
- **一句话**:站得住的是**「done-for-you + 给建不了的非技术 operator + 养」**,塌的是**「跑在真实软件上」**(Raft 也这样、还是它主场);且这条是**待兑现**(我们还没 ship done-for-you),不是已握有。

### 轴 2 · 被协调的常驻组织 + 复利(always-on + 记忆 + 管理层分诊 + Push)
**判定:大部分不成立 / 只剩一薄条。**
- **塌掉**:复利/记忆 —— Raft 有持久记忆 + agent 接力 + hand-off + review,机制层匹配甚至更精(Honey Lemon 定调:标不成立)。always-on 常驻 —— Raft agent 是跑你 daemon 的 persistent process,也常驻。
- **唯一没塌的薄条**:**管理 / Push 层**。Raft 是**peer 协作**(agent 认领/接力/互 review,人「set direction, steer when needed」= 人在房间里当协调者/PM)。我们多一层**层级管理**(CoS 自动分诊 backlog、Leads 派活、Push = 组织自转、只在要你拍板时找你)——**把人从『协调者』位置上解放**。这和我们 vs OpenClaw 画的线同款,但**vs Raft 更薄**:Raft 是被协调的(agent-to-agent),不像 OpenClaw 各自为战;我们唯一独加的 = **manager/Push 层**。
- ⚠️ 且 Raft **加个 manager/orchestrator agent 就能补这条**(有钱、引擎强的团队,trivial)。
- **一句话**:复利/记忆/常驻**被 Raft 匹配(甚至更精)**;只剩「管理+Push 层(不用你当 PM)」这一薄条没塌,而且**可被 Raft 补**。

### 轴 3 · done-for-you 给非技术 operator + founder 判断留两头
**判定:成立 —— 目前最站得住的一轴;但非结构、靠聚焦+速度守。**
- **站得住**:Raft 重心 = builders/teams,**你自己跑 daemon、你是房间里的 builder/PM**,agent 是你的 coding 队友。它**不是**「给一个建不了的非技术 operator done-for-you」。**那个客户是 Raft 的服务盲区,正是 911 的 最先专攻的客户群。** Raft 的引擎-founder 在为 builder 优化,不为「非技术 operator done-for-you 体验」优化 —— 真方向 gap。Annie 的 operator-taste vs Raft 的 engine-taste 是真差。
- ⚠️ **诚实边界**:(a) Raft 声称「non-coders adapt quickly」+ GTM 团队在用,边界模糊、**可下移市场**;(b)**非结构** —— 有钱的 Raft 能建 done-for-you operator 层 + 招 operator 共情;(c) 我们 **done-for-you 还没 ship**(产品没到、Annie 半技术)。所以它**今天作为定位 gap 成立**,但只由**我们抢在 Raft 掉头之前占住这个客户的速度+聚焦**来守。
- **一句话**:**最硬的一轴,但硬在『Raft 现在不要这个客户』,不硬在结构;靠速度+聚焦,不是稳赢;且 done-for-you 我们还没兑现。**

### 三轴速览
| 轴 | vs Raft | 一句话 |
|---|---|---|
| ① 领域(建养真软件产品) | **部分成立** | done-for-you+给建不了的人+养 站得住;「跑真实软件上」塌(Raft 主场);待兑现 |
| ② 常驻组织+复利 | **大部分不成立** | 复利/记忆/常驻被 Raft 匹配;只剩「管理+Push 不用你当 PM」一薄条,还可被补 |
| ③ done-for-you 给非技术+founder 判断 | **成立(最硬)** | Raft 服务盲区=我们 最先专攻的客户群;但非结构、靠速度+聚焦、done-for-you 未 ship |

**净结论**:三轴里**两轴(②大部分、①一半)被 Raft 匹配或塌**,只有**一轴(③客户 wedge + taste)真站得住,且它非结构、靠速度守、还没兑现**。

---

## 5. Raft vs Flywheel —— 威胁到哪(汇总)

**正面撞车(威胁)**:
1. **形态**:chat-teammate + channels + @提及 + agent 当同事 —— 我们的界面赌注,Raft 逐条命中且已产品化。**比 Matrix(桌面小人)/ Cowork(桌面知识工作)更贴。**
2. **供应商中立**:Raft 是第三方却做 runtime-agnostic(Claude/Codex/Hermes)—— **直接打穿我们「供应商中立 = 第一方不会做」的差异**(对 Cowork/Codex 成立,对 Raft 不成立)。
3. **复利/记忆**:机制层被匹配,甚至更精。
4. **引擎/机制领先**:分布式共识 + 前 Kimi + 已 ship version-check/staged-draft(我们还在 backlog)。
5. **是家专注、会讲工程博客、有定价的真公司** —— 不是玩具。

**没威胁到(我们的口子)**:
- **目标客户**:Raft 重心 = builders/teams(要跑 daemon、当 PM);**非技术、自己建不了的 operator 是它的盲区** = 我们的 最先专攻的客户群。**这是唯一真口子。**
- **done-for-you + 管理/Push 层**:Raft 让**你**当房间里的协调者;我们赌「组织自转、只找你拍板」。薄、可被补,但今天是差异。

**一句话定性(不美化)**:**Raft 是我们目前找到最贴、最该警惕的竞品** —— 它把我们的形态产品化了、在引擎层比我们强、还供应商中立。它没吃掉我们的**唯一原因** = 它现在瞄的是 builders,不是我们那个「自己建不了的非技术 operator」。我们的活路窄且非结构:**在 Raft 掉头下移市场之前,把 done-for-you 复利产品替这个客户真正做通。**

---

## 6. 对 FLY-911 定位的影响 + 建议(只出建议,Annie 拍)

**Raft 动摇了定位吗?—— 动摇了『可防御性』,没动摇『打谁』。**

911 主线 = 「一直在线、记得一切、还自己把活往前推的公司 —— 你只做判断」+ 最先专攻的客户群 = 非技术 OPC operator。逐条对 Raft:
- **一直在线(always-on)** → Raft 匹配(persistent daemon agent)。**不再独有。**
- **记得一切(memory)** → Raft 匹配(persistent memory)。**不再独有。**
- **自己把活往前推(Push)** → Raft 偏 peer-你 steer;Push(组织自转、找你拍板)还算差异,**薄、可被补**。
- **最先专攻的客户群 非技术 OPC operator** → Raft 盲区。**站得住,最强。**

**→ 结论:Raft 没使定位的『打谁(target)』失效(它恰恰不要我们的客户),但把定位的『机制卖点(always-on + 记得一切,甚至 Push)』掏空了 —— 这些从『差异』变成了『table stakes』,被一个资源更足、引擎更强的对手匹配。护城河 100% 押在『比 Raft 更早、更专注地把 done-for-you 非技术 operator 产品做通』。**

**给 Annie 的建议(弹药 + 我的推荐,定位调不调你拍)**:
1. **把 Raft 列进『最该警惕』,和 Cowork 并列** —— Cowork = 上方威胁(Anthropic、非技术 done-for-you);**Raft = 侧翼威胁(有钱创业、就是我们的形态、供应商中立、引擎领先、前 Kimi)**。论「威胁我们的**形态**」,Raft 比 Cowork 更狠。
2. **退『供应商中立』和『复利/记忆』当差异**:Raft 都匹配。911 已把供应商中立降为「未来原则」—— 确认它**连差异都不该列**(vs 同形态对手);「记忆/复利」(支柱 1)从『看家本领』改标『table stakes 底座』,**别拿它当主卖点领头**。
3. **主 messaging 别绕 always-on / 记得一切 / Push 机制**(Raft 有)—— **狠押唯一站得住的**:客户 wedge(done-for-you 给一个**自己建不了**的非技术 operator)+ 管理/Push 层(不用你当 PM)+ build-in-public 真实感 + Annie 的 operator-taste。
4. **要让 Annie 看到的那句不舒服的真话**:定位在 **target 层没被威胁**(Raft 不要我们的客户),但在**可防御性层被威胁** —— 我们能指的几乎每条机制,现在都被一个更有钱、引擎更强的对手匹配了。护城河就剩一句:**「把 done-for-you 非技术 operator 产品,ship 得比 Raft 掉头更快。」** 停在引擎层 = 被 Raft 吃(压测点 ①②)。所以战略含义是**执行聚焦**:别再打磨引擎(那儿我们输),全压 done-for-you 体验 + 真 ship 复利真产品维护,拿 build-in-public + Annie operator-taste 当**速度**优势。
5. **我推荐的 911 具体动作**(Annie 拍):最先专攻的客户群 **不动**(Raft 的缺席反而验证了它);但 (a) 加 Raft 进最该警惕;(b) 把 memory/always-on 从『看家本领/支柱』降到『table-stakes 底座』;(c) 把支柱收敛成**领头 = 客户 wedge + 管理/Push + done-for-you 组合**;(d) 把『靠速度守、不靠结构守』这句诚实写进去(现在 911 §7 有诚实边界,但没点破『机制已被同形态对手匹配』这层)。

---

## 7. 边界 / 没查到 / 留给别的 issue

- **『报数』/version-check/staged-draft/Dmail 的可抄工程解法** = **FLY-999 的 scope**(Cass 初读 + eng 落地);本文只把它当「Raft 引擎领先」的证据引用,不做完整可抄清单。
- **Raft 融资体量 / 团队规模** = 未查到具体数(只知前 Kimi 团队、有 Enterprise 计划)。不影响结论(② 的方向已由「人 + 专注 + 已 ship 的证据」坐实)。
- **Raft 是否已有 manager/Lead 层** = 核实到的是 peer 协作(claim/hand-off/review),**没**看到显式的层级 manager/分诊层;标为「据现有信息推断」。若 Raft 后续加,轴 2 那薄条即塌。
- **创始人推文原文** = X 挡付费墙(402);关键 verbatim 从 WebSearch 引用拿到(分布式共识那段),够用。
- **目标客户 builder vs operator 的确切占比** = Raft 官方措辞是「builders and teams」重心 + 声称 non-coder 也能用,**边界模糊**;这是最该持续盯的信号(→ FLY-1000 Raft-watch 每周核:它有没有下移市场朝 operator)。

---

## 8. Round-2 深挖(FLY-1001 · Annie 要更深一层 + HTML)

> Annie 看完 round-1 结论后要「更深一层」:市场反应 / 融资 / 团队规模 / 产品具体长啥样。**本轮做了真 web 深挖(不是上轮的『别 raw-dig』)。铁律:查不到的诚实标 UNKNOWN,绝不编;同名公司污染的数据绝不安到 raft.build 头上。** 配套 review HTML 给 Annie。

### 8.1 ⚠️ 同名公司污染(先说,因为它决定了融资/团队为什么标 UNKNOWN)
搜「Raft」撞上**至少三家同名公司**,数据全混在 Tracxn/PitchBook/Crunchbase 里:
- **raft.ai**(伦敦,供应链/物流 AI,2017,Nisarg Mehta 等)—— 融资 $30M,投资方 **Eight Roads / Bessemer / Booom**。
- **teamraft.com / Raft(defense)**(Reston,2018,Shubhi Mishra)—— 346 人,$45M。
- **Raftt**(dev-environment 工具)—— 又一家。
- **我们的 = raft.build(前身 slock,TennyZhuang)= AI agent 协作平台。**
→ **PitchBook 那条「Raft 融资 $46.7M,投资方 Bessemer/Eight Roads」几乎肯定是物流 raft.ai(Eight Roads/Bessemer 正是物流那家的投资方),不是 raft.build。绝不采纳。** 这正是 Annie 警告的坑。

### 8.2 融资 —— **UNKNOWN(诚实)**
- **没找到 raft.build / slock 专属的融资披露。** 所有金额($30M/$46.7M/$60M/$45M)+ 投资方(Bessemer/Eight Roads/Cendana…)经核**都属同名的物流/国防/dev-env Raft**,不是 raft.build。
- **结论:raft.build 融资 = 未知。** 不编、不借同名公司的数字充数。→ FLY-1000 Raft-watch 持续盯官方/推文有没有官宣。
- ⚠️ **但『有没有融资』不改 round-1 的 ② 结论**:② 的力量来自「人 + 专注 + 已 ship 的证据」,不依赖融资金额。

### 8.3 团队规模 —— **UNKNOWN,但 pedigree 硬(有名有姓)**
- **具体人数未核实**(同名污染,拿不到干净 headcount)。
- **已确认的人(强)**:
  - **TennyZhuang(@zty0826)**:分布式系统出身 —— GitHub 主属 **RisingWaveLabs**(streaming compute engine)、前 **Alibaba PolarDB-X**(事务)、**TiKV/TiDB/OpenDAL** committer、清华软院、CCPC 金牌。公开在 X 宣布 **slock→Raft** 改名。**分布式共识/系统的硬核 pedigree 坐实。**
  - **Tianxiao Shen(xxchan)**:LinkedIn 写 building Slock + **co-created Kimi CLI**(Kimi K2.5 相关开源 coding agent)。**坐实 FLY-999『团队含前 Kimi』。**
- ⚠️ **创始实体/CEO 存疑,不硬下**:TennyZhuang GitHub **未列 Raft 关联**(主属 RisingWave)—— 可能是 co-founder/兼顾,或 GitHub 未更新;一处博客抓取出现「**Richard / Botiverse, Inc.**」与 TennyZhuang 创始说法冲突 —— **存疑,不采纳,标待确认**。可确认的:TennyZhuang 是公开负责人/创始人figure,团队是**强分布式系统 + AI-infra 的小团队**。
- **结论:团队规模 UNKNOWN;但『强 pedigree 小团队』坐实,足够支撑 ② 的『引擎层他们更精』。**

### 8.4 市场反应 —— **公开声量查无(诚实 UNKNOWN)**
- **没找到 HN / Product Hunt / Reddit / 小红书 对 raft.build 的公开讨论。**(HN 搜出来全是 Raft **共识算法**;PH/Reddit 搜到的是 agent-collab 大类别的别家如 Upstream/Agent Arena。)
- **推断(标清是推断)**:launch 约 **2026 年中**(launch 博客『Introducing Raft』抓取日期 May 21 2026,存疑但方向一致)—— 若属实则**很新、公开声量还没起来**;也可能它主要在 X/私域传播、没大规模 PH/Reddit launch。
- **赛道热但拥挤(有据)**:2026 年中 Product Hunt「Agent Infrastructure Explosion」,过半 Top20 在做「让 agent 更可发现/管理/评估/部署」;AI-native email(Upstream,agent 当协作者)、Agent Arena 等一堆同类 —— **人+agent 协作是个正在『铺路期』的热门拥挤品类**,Raft 是其中形态最贴我们的一家,但不是唯一。
- **结论:口碑/声量未知;不美化成『爆红』也不贬成『没人用』——就是新、拥挤赛道里一家 pedigree 很硬的玩家。**

### 8.5 产品具体长啥样(讲透 —— 这轮最有料)
**onboarding 四步(docs welcome verbatim)**:① Meet your Onboarding Agent(建 server、连一台电脑、见到团队第一个 agent)→ ② Hand off your first task(给 agent 真活、看它做完带回来)→ ③ Bring in your teammates(把人拉进房间、和 agent 并肩)→ ④ Build agent team(加更多 agent、定各自职责、养一支会学的队)。
**导航结构(docs)**:Getting Started · Work on Raft(Build agent team / Divide work / Catch up / Search / Notifications / Multi-device)· Tutorials(Investing research team)。
**核心概念(launch 博客 verbatim)**:agent = 一等公民,"They have memory, identity, and their own workspace";"**One agent is one session: a continuous identity that stays alive across days and tasks**"(不是无状态调用);shared channels 里 agent "@mention teammates, claim work from task boards";agent 维护自己的 inbox/tasks/reminders;例子:一个 agent「**被在它不在的频道里点名 → 自己加进那个频道开干**」(主动性)。

**⭐ 核心工程机制 —— 『房间会乱吗』那篇(= Cass 说的『报数/version-check/staged-draft/Dmail』的真身,verbatim)**:
- **问题(stale-snapshot,= 我们 crossed-wires)**:"the gap between an agent's reasoning and the room moving on" —— agent 回合制:读快照→推理→提交,"While the agent is composing, it isn't simultaneously seeing new messages arrive. If the room moves between the reasoning and the commit, the agent may still be acting on a state that no longer exists" → 非续贯/重复回复。
- **解法 1 · Inbox surface**:把「消息硬推进 working context」反转成「agent 有余力时**主动拉**」——"Mentions, thread updates... surface as queryable items the agent can pull when it has bandwidth"。agent 自己决定什么值得进上下文,不被房间噪声挤掉 task state。
- **解法 2 · Held Draft surface(= staged-draft + version-check 的真身)**:每条出站消息带**版本标记**,标它是对着哪个房间状态写的。发送时:房间没变→提交;**房间动了→扣住、连同「你写的时候进来了啥」还给 agent**;"The draft is preserved as a first-class state, not a failed send"。agent 四选一:**Revise / Send as-is / Stay silent / Send anyway(反复扣住后显式绕过)**。原则:"The room informs the agent that something arrived; the agent decides what to do"。
- ⚠️ **名字澄清**:Cass 的『报数/Dmail』是**转述简称**;Raft 官方叫 **Inbox surface + Held Draft surface + version marker**。机制对得上,名字以官方为准。
- **= 我们 FLY-574(draft-not-sent)+ crossed-wires 的正解,已被 Raft 产品化。这是 ② 『引擎层他们更精』的最硬证据。**

**Raft 的产品 theses(博客,暴露它的设计哲学 —— 对我们有战略含义)**:
- **"Agents Need Names"**:named agent 做路由/连续性/信任 —— **我们『named Lead』这条信任点,Raft 也做,不独有。**
- **"Trust Doesn't Live in Code Review"**(⭐ 战略金矿):trust = "the ability to predict it";验证靠**持续读系统信号**(bug 簇、mutation testing 幸存者、静态结构、**agent 间实时碰撞检测**),"A failure is not a verdict on the model; it is a map of the inputs you left unclean";人从**看门人**转成**读系统、收紧输入(specs/contracts)的人**。**目标用户 verbatim = "technical leaders and senior engineers steering projects... architects and decision-makers, not line-by-line code readers"。**
- **"You Don't Need a Company Brain"**:主张**多个专才视角 > 一个统一大脑** —— ⚠️ 和我们『共享记忆/第二大脑』是**分叉的哲学**(它反对单一 brain)。值得盯。
- **"DAA"(DAU→DAA)**:把 agent 队友算进活跃度指标。

**8.5 的两条战略含义(喂三轴 + 911)**:
1. **trust 博客的目标用户 verbatim 坐实轴 3**:Raft 自己把用户定义成 **technical leaders / senior engineers / architects**,**明确不是非技术 operator**。→ **轴 3(done-for-you 给非技术 operator)vs Raft 更站得住了 —— 是 Raft 自己的话佐证的,不是我们自说。**
2. **trust 模型正好相反 → 多一条差异**:Raft 的信任 = 「读系统信号」(要技术素养、architect 视角);我们的信任(911 §4)= 非技术 operator 能亲验的四件事(named Lead / 可读审批 / 结果证明 / 护栏)。**在『非技术怎么信任』这条上,我们和 Raft 是两套人的两套答案 —— 这是 round-1 没挖出的一条新差异,建议补进 911 信任章。**

### 8.6 Round-2 对结论的净影响
- **三轴结论不变**,但**轴 3 更硬了**(Raft 自己的 trust 博客把用户定义成 technical leaders → 非技术 operator 确是它盲区)+ **新增一条差异**:非技术 trust 模型(我们 4 件可亲验 vs Raft 读系统信号)。
- **② 更实**:Held Draft/version marker 是它已 ship、我们还在 backlog 的硬证据。
- **融资/团队/声量 = 诚实 UNKNOWN**(同名污染),但团队 pedigree 硬这点坐实,不影响「引擎层它更精」。
- **911 建议微调**:round-1 五条不变;**加第 6 条**——「非技术 trust 模型」写进 911 §4 当一条对 Raft 成立的差异(它服务 architect、trust 靠读系统;我们服务非技术、trust 靠 4 件可亲验)。

