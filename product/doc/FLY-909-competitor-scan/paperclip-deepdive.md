# FLY-909 竞品深挖 #2 — Paperclip(@dotta)

Issue: FLY-909 (https://linear.app/geoforge3d/issue/FLY-909/竞品分析市面上别人怎么做-喂产品定位形态)
日期: 2026-07-07
基于: round-2 deep research(Annie 点名加的第 3 家竞品);对标 matrix-deepdive.md

> **为什么挖它**:round-2 Annie 点名加进来。经查,它是**继 Matrix 之后第二个正面做「你指挥的一整个 AI 公司」的玩家 —— 而且是开源、免费、病毒式**。它坐实了一件对我们定位生死攸关的事:「把 agent 组织成一个公司」这个形态**已经商品化**了。它也是那条 **generic-first vs concrete-company** 洞察的活证据。
> 资料来源:paperclip.ing / github.com/paperclipai/paperclip + 第三方评测/复盘(2026-07 WebSearch)。标 ⚠️ 处为口径需复核。

---

## 一句话定位

> **「The app people use to manage AI agents for work.」** / 「The control plane for AI agents.」
> 通俗:把你的一堆 AI agent **组织成一个公司**(org chart + 角色 + 汇报线 + 预算 + 治理),让它们在这个结构里自主干活 —— 「你是 CEO,agent 是员工」。

## 目标用户

**会自托管的开发者 / prosumer**。官方「who uses it」画像:正在跑多个 AI agent 且被协调搞疯的人、想要 24/7 自主 + 人类可审计、**comfortable with self-hosted Node.js infrastructure**、需要预算控制防 API 烧穿、看重开源 + vendor independence。—— **不是**完全非技术的 SMB 老板。

## 产品形态(怎么用)

- **一个你自己跑的 Node.js server + React 面板**(API server 起在 localhost:3100,内嵌 PostgreSQL 自动建好)。官方 quickstart「5 分钟在你笔记本上跑起一个容器」;也有社区 Docker/VPS 自托管教程(Contabo/Hostinger/DeployHQ 都写了 how-to)。
- **BYO agent** —— Paperclip 明说自己**不是 agent 框架**,不教你怎么建 agent;它是**跑一个由 agent 组成的公司**的那一层。你自带 agent(如 Claude Code / OpenClaw),Paperclip 给它们套上组织结构。**「If OpenClaw is the employee, Paperclip is the company.」**
- **交互 = ticket**:你通过 ticket 跟 agent 沟通,**每一条指令 / 回复 / 工具调用 / 决策都被记录、全程 tracing**(审计面板)。
- **org chart 建模**:角色、汇报线、预算、治理;「routines」自动化重复工作;性能指标监控;heartbeat 系统解决「stateless agent」+ 重启丢状态问题。
- **domain 配置(generic)**:security firms / game studios / science labs / consultancies 等模板 —— 不是垂直做某一行,是**给你一个横向框架去搭任意一种**。

## 公司背景 / 体量

- 作者 **@dotta**(化名,不露脸)。起因:他自己跑一个自动化对冲基金,同时开着 **20–30 个 Claude Code 终端窗口**,agent 之间没有共享上下文、没有跨 session 成本追踪、系统重启后状态全丢 —— Paperclip 直接从这个运维痛点长出来。(**注意:这跟 Flywheel 起源同源** —— 都是「一堆 Claude Code 跑起来后没人管得过来」这个痛点。)
- **增长炸裂**:2026-03-02 发布 → 3 周破 30K GitHub star → 4 月初 43K–53K star、6,400+ fork,史上最快开源 agent 项目之一。
- 走 **build-in-public + 开源病毒**:化名创始人、立即公开、HN/X 口碑、Greg Isenberg 等大 V 推 → 组织式扩散,几乎零广告。

## Onboarding

`git clone` → 交互式 setup 引导你配数据库 + 建第一支 agent 团队 → localhost 跑起来。**对开发者是 5 分钟;对完全非技术是不可能**(要 clone、要跑 Node、要自带 agent、要连模型 key)。

## 亮点 feature

1. **控制平面定位清晰**:不跟你抢 agent 那一层,只做「org chart + ticket + 预算 + 治理 + 审计」——踩在别人 agent 之上。
2. **全程 tracing / audit trail**:每个决策可回溯(对「AI 干的活怎么信」有正面回应)。
3. **预算控制**:防 runaway API 花费(直击 credit bill-shock 痛点)。
4. **heartbeat / 状态恢复**:解决 stateless agent + 重启丢状态。
5. **开源 MIT + 自托管 + 无账号**:vendor independence,免费。

## 定价

- **完全免费**:MIT license,无授权费、无订阅档、无托管云(截至 2026 年中)。你自己下、自己托管、自付基础设施(模型 API + VPS)。

## 已知软肋(= 我们的机会点)

1. **自托管门槛**:要会 Docker/VPS/Node、要自带 agent、要连 key —— **完全非技术的 SMB 老板装不起来**。
2. **BYO agent = 质量甩锅给你**:Paperclip 只管组织,**产出质量取决于你塞进去的 agent**;它自己不保证「建出来的东西真能用」。
3. **generic 框架 = PMF 甩锅给你**:它给你搭公司的能力,但**建什么、有没有人买是你的事**(正是品类批评的「执行不是瓶颈、需求才是」)。
4. **审计面板 ≠ 非技术可读**:ticket + tracing 对开发者很棒,但对纯非技术仍是「一堆看不太懂的记录」。
5. **⚠️ 无托管云**:想要「别人替我跑」的用户,Paperclip 目前不提供(这正是我们做的)。

---

## 跟 Flywheel:像谁 / 不一样(这份深挖的重点)

### 像(为什么它对我们是威胁)
- **同一个大形态**:你指挥的**一整个分层 AI 公司**(org chart / 角色 / 汇报线 / 治理)。
- **同源痛点**:都从「一堆 Claude Code 跑起来没人管」长出来。
- **同样做审计/证据**:它 ticket+tracing,我们验收/QA。
- → **靠「把 agent 组织成公司」这个壳,区分不开我们和 Paperclip**;而且它**免费开源**,在这个壳上没人能建护城河。

### 不一样(差异化,round-2 收窄)
| 维度 | Paperclip | Flywheel |
|---|---|---|
| **generic vs concrete** | **generic 横向框架** —— 给你搭**任意** AI 公司的能力,BYO agent、自定 org chart | **concrete 具体公司** —— 一支**已组装好、替你建你那个具体产品**的软件团队 |
| **谁托管** | **你自己**(Node server / VPS / Docker) | **我们替你托管**,你只在 Discord 说话 |
| **谁带 agent** | **你**(BYO agent) | 我们(Runner 已接好) |
| **面向** | 会自托管的开发者 / prosumer | **完全非技术**的 SMB 老板 |
| **界面** | 自跑的 React 面板 + ticket | **Discord(手机原生 IM)** |
| **质量保证** | 甩给你塞进去的 agent | Runner 走 PR/CI/review/QA,**结果一试真能跑、下周还能跑** |
| **商业形态** | 开源免费、无托管云 | 托管服务、订阅制 |

### 值得借鉴(from Paperclip)
1. **控制平面定位的清晰度**:「不是 agent 框架,是跑一个 agent 公司的那一层」——这种一刀切的定位表达值得学(我们对外也要一句话说清「我们是替你建产品的那支队,不是给你搭队的框架」)。
2. **预算控制 + 状态恢复 + 审计**做成显性 feature —— 我们有类似能力(founder 验收、记忆、reconcile),可以更显性地讲。
3. **开源 build-in-public 病毒式**(43K star / 零广告)是 GTM 教科书;但 ⚠️ **别学开源自托管路线** —— 那正是把非技术挡在门外的东西,我们的护城河恰恰是「替你托管、不用自己跑」。

### generic-first vs concrete-company(这份深挖导出的定位洞察)
> Paperclip 证明:**「搭 AI 公司的通用框架」这一层 = 免费 + 开源 + 病毒式,谁也别在这儿建护城河。** Flywheel 要赢就得做**反面** —— 不做 generic 框架,做 concrete 的、有主见的、开箱替你建**你那个具体产品**的团队。价值在「具体 + 替你做完 + 一试真能跑」,不在「给你能力自己搭」。
> 〔喂 FLY-908/911 定位:这条建议已折进 competitor-scan.md ② 和 ⑤,待 Annie 拍。〕

---

## 来源(2026-07 WebSearch)

- Paperclip 是什么 / 增长:paperclip.ing、github.com/paperclipai/paperclip、contabo.com/blog(what-is-paperclip-ai)、towardsai.net、mindstudio.ai(what-is-paperclip)、theaienterprise.io
- 作者起源(20–30 个 Claude Code 窗口)+ 病毒:Greg Isenberg X 帖、dev.to(Paperclip Deep Dive)、「If OpenClaw is the employee, Paperclip is the company」
- 自托管 / 谁用:MadeByAdem/paperclipai-docker、contabo/hostinger/deployhq 自托管教程、aiagentslist/aitooltier 评测
- 品类(Zero-Human Company):ossinsight.io(GitHub's Most Ambitious Bet of 2026)、fortune.com(2026-03-05)、technologyreview.com(agent orchestration)、批评见 medium/sofmen 等
