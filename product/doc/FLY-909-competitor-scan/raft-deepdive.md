# FLY-909 竞品深挖 #2 — Raft(raft.build,前身 slock)

Issue: FLY-909 (https://linear.app/geoforge3d/issue/FLY-909/竞品分析市面上别人怎么做-喂产品定位形态)
本轮: FLY-1001 competitor-scan round-3(Annie 2026-07-08 发现 Raft)
日期: 2026-07-08
基于: FLY-999/1000(Cass Raft profile)+ 1 轮有界核实(raft.build 首页/docs/创始人推文)+ FLY-909 证据 + FLY-911 定位
深挖分析源: `product/doc/FLY-1001-raft-competitor-scan/research.md`(Cass 三压测点逐条压出的结论;§8 = round-2 深挖:市场反应/融资/团队/产品细节 + 诚实 UNKNOWN)
Round-2 review(给 Annie): `product/doc/FLY-1001-raft-competitor-scan/raft-round2-review.html`

> **为什么单独挖它(和 Matrix 一个待遇)**:Raft 被 Cass 定为「**Flywheel 形态的产品化版**」。核实后 —— **成立,而且它比 Matrix(桌面小人)/ Cowork(桌面知识工作)更贴我们的形态**:人+AI agent 在 channels/DM 里当平等队友、供应商中立、持久记忆复利。它是目前找到**最贴、最该警惕**的一家,且**在引擎层比我们强**。
> 资料来源:raft.build / docs.raft.build/welcome / 创始人 @zty0826 推文(WebSearch 引用,X 原文挡付费墙)。**标 ⚠️ 的点建议 FLY-1000 Raft-watch 每周复核。**

---

## 一句话定位(verbatim)

> **"Where humans and AI agents build together."**
> "the future of work isn't humans using AI tools. It's humans and AI agents building together."
> agent 是 **"real teammates in the room, not tools, as equals"**。

## 目标用户

**"agent-native builders and teams"** —— 重心偏**技术 builder / 团队**(明写用例:codebase 记忆、CI/CD、code review)。声称 non-coder / GTM 团队也能上手,但**边界模糊**、重心在 builder。⚠️ 这条是**最关键的信号**:它现在**不**瞄「自己建不了的非技术 operator」—— 那正是我们 911 的 最先专攻的客户群。

## 产品形态(怎么用)

- **web workspace**:channels / threads / tasks / @mentions —— Slack-式,但 agent 是一等队友。
- **agent 跑你自己硬件上的 lightweight daemon**:你控制算力、代码/数据隐私。⚠️ 「你自己跑 daemon」= 有技术 setup 负担,进一步指向 builder/team 而非只带手机的非技术 operator。
- **多人多 agent**:"teammates bring their own agents, agents hand off to others' agents, work stays attached to the conversation"。

## agent 机制(⭐ 命中我们形态的地方)

- **持久身份 + 记忆**:codebase / 偏好 / 历史对话都留,agent「pick up where they left off」。
- **runtime-agnostic**:跑 **Claude / Codex / Hermes / more** —— **它是第三方却做供应商中立**。
- **复利协作**:claim task、并行、互相 hand-off、shared thread 里互相 review;**"what one agent figures out, the next one builds on"**。

## 团队 / 背景(② 的根据)

- 创始人 **TennyZhuang(@zty0826)**,分布式共识出身(Paxos/Raft/FLP):"how do independent actors with partial knowledge ever agree on anything" = **多-agent 协调的第一性问题本身**。
- 团队多前 **Kimi/Moonshot**(强模型/基建血统)。
- 工程博客(『报数』)已**产品化** version-check + staged-draft + Dmail(context view),解 stale-snapshot 协作坑 —— **正是我们还在 backlog 打的坑(FLY-574 draft-not-sent、crossed-wires)**。

## 定价

Free(全功能、30 天历史)/ Pro **$8.80/seat/月**(human=1 seat, agent=0.1 seat, 年付)/ Enterprise(私有部署 + SSO,coming)。—— 定价清晰、走 per-seat SaaS,不是玩具。

---

## 跟 Flywheel:像(为什么最贴)/ 不一样(差异化收窄)

### 像 —— 形态逐条命中(比 Matrix 更狠)
- **界面赌注**:chat-teammate + channels + @提及 + agent 当同事 —— 我们赌的界面,它逐条命中且**已产品化**。
- **供应商中立**:我们把它当差异,**vs Raft 直接不成立**(它自己就是中立第三方)。
- **复利 / 常驻记忆**:机制层被匹配,甚至更精。
- **本机跑**:它 daemon 跑你硬件 ≈ 我们跑 Annie 机器 —— 连部署直觉都像。

> 结论:靠「chat-agent 协作 / 供应商中立 / 复利记忆 / 常驻」**已经区分不开** —— 而且这次对手在**引擎层比我们强**。真差异只能落到**客户 + done-for-you + 管理层**,否则一句话定位上撞脸且我们处下风。

### 不一样(差异化,诚实收窄后)
| 维度 | Raft | Flywheel |
|---|---|---|
| **目标客户** | agent-native **builders / teams**(你跑 daemon、当房间里的 PM) | **自己建不了的非技术 OPC operator**(done-for-you,不用当 PM)|
| **谁在协调** | **peer 协作** + 人 steer(你是协调者/PM 在房间里) | **层级管理**:CoS 分诊 + Leads 派活 + **Push**(组织自转、只找你拍板)|
| **产出定位** | 通用 workspace(软件+研究+写作+运营),你自己干 | **替你建养一个真业务软件/系统**,长期维护(done-for-you)|
| **上手** | 装 + 跑 lightweight daemon(有技术 setup) | Discord 里说话(骑现成手机 IM)|
| **引擎/机制** | ⭐ 分布式共识 + 前 Kimi + 已 ship version-check/staged-draft —— **比我们强** | 还在 backlog 打同款坑;引擎**不是**我们该竞争的战场 |
| **成熟度** | 专注创业、docs/定价/工程博客齐 | dogfooding 建出来、还没做实 done-for-you |

---

## ⭐ 三轴差异化 —— 逐轴标 vs Raft(核心;详证据见 research.md §4)

> 三轴 = 911 现在的差异化支柱。诚实标 成立 / 部分 / 不成立。

| 轴 | vs Raft | 一句话 |
|---|---|---|
| **① 领域**(替非技术 operator 建养真软件产品、跑真实业务、长期维护) | **部分成立** | 站得住 = **done-for-you + 给建不了的人 + 养**;塌 = 「跑在真实软件上」(**Raft 主场**,它 agent 本就跑你真 repo);且这条**待兑现**,我们还没 ship done-for-you |
| **② 被协调常驻组织 + 复利**(always-on + 记忆 + 管理分诊 + Push) | **大部分不成立** | 复利/记忆/常驻**被 Raft 机制层匹配甚至更精**;只剩「**管理+Push 层(不用你当 PM)**」一薄条没塌,而且 **Raft 加个 manager agent 就能补** |
| **③ done-for-you 给非技术 + founder 判断** | **成立(最硬的一轴)** | Raft 重心=builders/teams、盲区=非技术自己建不了的 operator = **我们 最先专攻的客户群**;Annie operator-taste vs Raft engine-taste 真方向差。**但非结构、靠速度+聚焦守、done-for-you 还没 ship** |

**净结论**:三轴里**②(大部分)+ ①(一半)被 Raft 匹配或塌**,只有**③(客户 wedge + taste)真站得住 —— 且它非结构、靠速度守、还没兑现**。

---

## Cass 三压测点 —— 一句话结论(详见 research.md §1–3)

- **① 下游护城河只在真 ship 复利产品时成立,停在 orchestrator 层=被吃** → **完全成立,且更扎心**:Raft 本身就是被产品化的 orchestrator 层、做得更成熟。护城河是**待兑现的赌注不是现有资产**;按我们自认的诚实边界(done-for-you 还没到),**此刻我们离『停在引擎层』比离『已 ship 复利产品』更近**。多耗一天在引擎、被吃概率高一分。
- **② Raft 有融资+专注+前 Kimi 的人 → 引擎层更精** → **成立,建议直接认输这一层**:硬证据 = 他们已 ship 我们还在 backlog 的 version-check/staged-draft。**别在引擎精巧度上跟它掰(必输战场)**;引擎够用就行。⚠️ 但引擎领先**不自动**给它我们的客户 —— 这是 ③ 的口子。
- **③ 唯一真差异 = 自用 + 真实产品闭环 + Annie 判断,证明它硬** → **真实但薄**:dogfooding 不是护城河(Raft 也自用、还同主场);「跑真实产品上」= Raft 主场;复利被匹配;剩最能守的 = 指向非技术 operator 的 **founder taste**,但要转成 ship 出的产品才算数、且我们还在建(Anna)拿真客户声音磨它。**是先发+聚焦+taste 优势,不是结构护城河。**

---

## 值得借鉴 / 别学(from Raft)

**借鉴**:
1. **工程博客连载做 build-in-public** —— version-check/staged-draft/Dmail 那套既是可信度背书、又是我们**可抄的工程解法**(→ FLY-999 落地)。
2. **per-seat 定价清晰**(human=1, agent=0.1 seat)—— agent 廉价定价是个好锚。
3. **agent 一等公民 + @提及 + work stays attached to conversation** —— 交互细节值得看齐。

**别学 / 我们要反着押**:
1. **别去比引擎精巧度**(② 必输)。
2. **别让用户跑 daemon 当 PM** —— 我们反着押 done-for-you + Push(组织自转)。
3. **别抢 builder 客户** —— 那是 Raft 主场;我们只攻它盲区的非技术 operator。

## 一句话差异化候选(给 Annie 挑)

> 「Raft 给 **builder** 一个更强的 agent 协作 workspace,你自己跑 daemon、当房间里的 PM;Flywheel 替一个**自己建不了的非技术 operator** 把整个公司的活 **done-for-you** 做掉 —— 组织自转、只在要你拍板时找你。」
> ⚠️ 诚实:这条差异**非结构、靠速度+聚焦守**,不是稳赢;而且 done-for-you 我们还没兑现。

## 对 FLY-911 的影响 + 建议(只出建议,Annie 拍;详见 research.md §6)

- **动摇了『可防御性』,没动摇『打谁』**:always-on + 记得一切被 Raft 匹配(从差异变 table stakes),甚至 Push 也薄;但 最先专攻的客户群(非技术自己建不了的 operator)是 Raft 盲区、**站得住**。
- **建议**:①把 Raft 列进『最该警惕』和 Cowork 并列(论威胁**形态**比 Cowork 更狠);②退『供应商中立/复利记忆』当差异(Raft 匹配);③主 messaging 狠押唯一站得住的客户 wedge + 管理/Push + build-in-public + Annie taste;④把『靠速度守、不靠结构守』写进诚实边界;⑤最先专攻的客户群 不动。**引擎层别恋战 —— 全压 done-for-you 复利产品,ship 得比 Raft 掉头下移市场更快。**
