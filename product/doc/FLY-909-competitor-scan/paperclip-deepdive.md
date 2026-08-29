# FLY-909 竞品深挖 #2 — Paperclip(@dotta)

Issue: FLY-909 (https://linear.app/geoforge3d/issue/FLY-909/竞品分析市面上别人怎么做-喂产品定位形态)
日期: 2026-07-07
基于: round-2 deep research + Annie round-2 批注(instruction 68563d64:真研究 Paperclip,别只下「generic 死了」的结论);对标 matrix-deepdive.md

> **为什么值得挖深**:Annie 点名要真研究它 —— 它是继 Matrix 之后另一个正面做「你指挥的一整个 AI 公司」的玩家,开源、免费、增长炸裂(6 月 ~70K star)。它有一堆**具体机制和 GTM 打法值得我们借鉴**,不是拿来下「这条路死了」的结论。
> **定位口径(重要)**:「我们跟 Paperclip 到底差异化不化 / generic-vs-concrete」这个**大结论归 FLY-911 跟 Annie 收敛**;本文只把事实和「可借鉴 / 差异候选」摆出来,**不硬下定位结论**。
> 资料:paperclip.ing / github.com/paperclipai/paperclip + companies repo + 第三方评测/复盘(2026-07 WebSearch)。标 ⚠️ 处口径需复核。

---

## 一句话定位

> **原**:「Launch a 0-Person Company」(zero-human company)。
> **现**(它自己悄悄软化了):**「The app people use to manage AI agents for work.」/「The control plane for AI agents.」**
> 通俗:把你的一堆 AI agent **组织成一个公司**(org chart + 角色 + 汇报线 + 预算 + 治理),让它们在这个结构里自主干活 —— 「你是 CEO,agent 是员工」。
> 📌 **注意这次软化本身就是一条教训**:连它都把「0 人公司自动赚钱」这种 overclaim 收成了更稳的「管 AI agent 干活的工具」。(呼应 Annie:别 overclaim。)

## 目标用户(比想象的更贴我们)

官方明说:**「多数 agent 框架是给开发者的,Paperclip 是给 operators 的」**。@dotta × Greg Isenberg 的 47 分钟 live demo 拉来的是**非技术买家 —— solo 创始人、agency 主,甚至「牙医、屋顶工、营销公司」找 AI worker 面板**。
- 也就是说:**它瞄的人群跟我们高度重叠**(非技术小生意主)。
- ⚠️ **但**:它的**上手仍要自托管**(下面),所以「瞄非技术」和「非技术真能自己跑起来」之间有个坎 —— 这个坎**我们也还没跨过去**(见诚实成熟度),是这条赛道共同的未解题。

## 产品形态 / 机制(Annie 要的「具体怎么设计」)

- **一个你自己跑的 Node.js server + React 面板**(API server 起在 localhost:3100,内嵌 PostgreSQL 自动建;官方 quickstart 5 分钟起一个容器,也有 Docker/VPS 自托管教程)。
- **org chart 三角色**:**CEO(一司一个)→ Manager(协调子团队、派给 IC)→ IC(真正干活的)**。汇报线定义委派流(CEO→CTO→工程师)。
- **预算/治理(设计得挺细)**:
  - **每个 agent 月度预算**:到 80% 软预警、到 100% **自动暂停 + 挡新任务**(防跑飞账单);board 可随时 override 恢复。
  - **治理模块**:agent 想改动 Paperclip 本身是受控的 —— 例如**雇新 agent 默认要 Board 批准**。
- **ticket + heartbeat 驱动**:ticket 指派唤醒 agent;agent 按**定时 heartbeat + 事件触发**(任务指派、@提及)跑。heartbeat 执行 = DB wakeup 队列(coalescing)+ 预算检查 + workspace 解析 + secret 注入 + skill 加载 + adapter 调用 → 产出结构化日志 / 成本事件 / session 状态 / **审计轨迹**。
- **issue 一等公民**:带 company/project/goal/parent 链、原子 checkout + 执行锁、first-class blocker 依赖、评论、文档、附件、work product、label、inbox 状态。
- **审计**:每个对话都 traced、每个决策都记;**append-only 审计日志(不可改不可删)**。
- **BYO 任意 agent**:「**能收 heartbeat 就算雇了**」。到 2026-06 支持 Claude / OpenAI Codex / Gemini / Cursor / Hermes / OpenClaw / Pi / OpenCode + Bash 脚本 + HTTP 端点。

## 怎么起来的(Annie 要的「怎么发展起来的」)

- **起源痛点**:@dotta 跑一个自动化对冲基金,同时开 **20–30 个 Claude Code 终端窗口**,agent 间没共享上下文、没跨 session 成本追踪、重启丢状态 —— Paperclip 直接从这个运维痛点长出来。(**跟 Flywheel 同源**。)
- **增长曲线**:2026-03-02 发布 → 3 周 30K star → 4 月 42K star + 6,400 fork → **6-11 达 69,955 star**、105 contributors、稳定发版节奏。史上最快的开源 agent 项目之一。
- **GTM = build-in-public + 开源病毒 + operator 定位**:化名创始人立即公开、HN/X 口碑、**Greg Isenberg 47 分钟 live demo**当病毒素材(演示「怎么用它 0 员工跑一个 startup」)、明确喊「给 operators 不给开发者」→ 几乎零广告。
- **自我软化**:悄悄从「zero-human companies」重定位成「the app people use to manage AI agents for work」——更稳、更 enterprise-friendly。

## 定价

- **完全免费**:MIT license,无授权费、无订阅、无托管云(截至 2026 年中)。自己下、自己托管、自付基础设施(模型 API + VPS)。⚠️ 无托管云 = 想要「别人替我跑」的用户它现在不接。

## 诚实成熟度 / 局限(Annie #3 的直接证据:这条赛道都还早,包括我们)

- **stability 未到**:4 月起报 bug、instruction 文件 404、agent 忽略 override;活跃用户能产出,但**每周都在提 bug**。
- **评测原话**:「community 文档 / 生态 / production-readiness **还没到 AutoGen / CrewAI 的水平**」;**「a proof of concept wearing a product's clothing(一个穿着产品外衣的原型)」**。
- **context 丢了会静默重启假设**、而不是 flag 出来(可靠性硬伤)。
- **token 会飙**:heartbeat 设太勤 + agent 指令含糊 = surprise bill。
- **维护体量**:6-11 有 **4,953 个 open issue 对 105 个 lifetime contributor**(issue backlog 跑赢维护者);化名 lead、无公开融资、无商业实体。
- **评分 ~7.8/10**:vision 和 dashboard 很强,被当前 bugginess + 真实学习曲线拖住。
- 👉 **对我们最有用的一条**:即便一个 70K star 的明星项目,现在也还是「原型穿产品外衣」。所以「让完全非技术的人自己跑起来」是**整条赛道的未解题**,不是谁已经做到了 —— 谁先把「done-for-you 替你做、真产品化」跑通,谁赢。

## bootstrap 打法:先立具体旗舰来 bootstrap 通用能力(Annie + 我都独立 catch 到,采纳)

Paperclip 本体是 generic(搭任意公司的能力),但它和社区**没有只丢一个空框架** —— 而是配了一整套**具体样板**来让人上手:
- **paperclipai/companies** 模板库:一堆**即导即跑**的配置好的公司(每个 = 完整 org chart + skills + 治理),import 就能跑。domain 例子:security firm / game studio / science lab / consultancy(CEO→directors→specialists + 上百个可复用 workflow skill)。
- **注意:里面一堆是「软件公司」模板**,而且形态跟我们撞:
  - **Superpowers**:一个纪律严明的软件开发公司 —— **CEO / CTO / QA Engineer / Release Engineer / Staff Engineer** + 14 个 skill(含 **TDD + code review**)。
  - **gstack「Engineering Company」**:product vision / design critique / technical planning / security audit / code review / ship / deploy / QA 各种认知模式。
  - **Full-Stack Forge**:全栈软件开发咨询公司,66 个 skill 覆盖 12 语言 / 7 后端框架 / 前端移动 / 基础设施 / 安全 / 数据 / DevOps。
- **Company Wizard 插件**:回答几个问题 → 自动装配 workspace 文件 + 建好公司和 CEO。

**这条打法的意义(该学)**:generic 产品一开始没人用,所以**先立一个可信的、具体的旗舰样板来 bootstrap 那个通用能力** —— Matrix 用 live 示例公司(agency 类)、Paperclip 用 companies 模板库。落到我们:**我们的具体旗舰样板 = 一个软件公司 = dogfooding(Flywheel 建 Flywheel)**,正好贴我们的背景。〔喂 competitor-scan.md ② 的「可借鉴」+ FLY-911 定位轮。〕

## 哪些机制我们可借鉴(Annie 要的「可借鉴的部分」)

1. **每 agent 月预算 + 80% 预警 + 100% 自停**:把「不 surprise 账单」做成结构性护栏(对非技术尤其重要),比全行业 credit 烧透明。
2. **Board 批准才能雇新 agent**:这是「治理/审批」的产品化,跟我们的 founder 验收 gate 同类 —— 可参考它怎么把「高影响动作要人批」做成默认。
3. **import 即跑的公司模板 + Company Wizard(回答几问→装配)**:非技术 onboarding 的好范式 → 喂 FLY-910「一条 command onboarding」。
4. **append-only 审计轨迹**:每个决策可回溯、不可改删 —— 「可信」的一种可视化底座(我们有验收/QA,可以更显性)。
5. **operator 定位 + operator 语言的 GTM**(不跟开发者讲,跟 operators 讲)+ Greg Isenberg live demo 当病毒素材 —— 直接可抄的 build-in-public 打法。

## 跟 Flywheel:像谁 / 差异候选(不硬下结论,待 FLY-911)

### 像
- **同一个大形态**:你指挥的一整个分层 AI 公司(org chart / 角色 / 汇报线 / 治理)。连三角色 CEO/Manager/IC ≈ 我们 CoS/Lead/Runner。
- **同源痛点**:都从「一堆 Claude Code 跑起来没人管」长出来。
- **同一群目标人**:它也瞄非技术 operators(牙医/agency/营销)。
- **软件公司形态也被它社区模板化了**(Superpowers = CEO/CTO/QA/Release Eng + TDD + code review)—— 说明「软件团队 org 形态」本身不是护城河。

### 差异候选(待 FLY-911 跟 Annie 收敛,别在这硬下)
| 维度 | Paperclip | Flywheel(差异候选) |
|---|---|---|
| **谁托管 / 谁配** | 你自己自托管、BYO agent、自己配 org chart(即便有模板也要你装) | 目标 **done-for-you 替你做**(候选,待 911);⚠️ 诚实:我们八成最后也要 Docker/VPS 那套,差异不是「不用自托管」,是「替你搞定」 |
| **产物** | 你自己塞进去的 agent 干出的东西,质量看你 | 目标:替你建并**长期养一个真软件产品**(候选) |
| **具体旗舰** | companies 模板库(含软件公司模板)= 通用平台的 bootstrap 样板 | 我们的旗舰 = dogfooding 软件公司(Flywheel 建 Flywheel) |
| **界面** | 自跑的 React 面板 + ticket | 手机原生 IM(Discord)(候选) |
| **成熟度** | 70K star 但「原型穿产品外衣」、每周 bug | 我们也还早、也一堆 bug、也没产品化(诚实,别 overclaim) |

> 结论层留白:「AI 公司」这个壳我们和 Paperclip/Matrix 都在用、区分不开;**但『别人在做』不等于我们不能做**(OpenAI 之后有 Anthropic)。真正的差异该落在「我们能不能把自己的团队优势 + done-for-you + 真产品维护 + 可感知信任打出来」,而这些**具体主打哪条、成不成立,归 FLY-911 跟 Annie 收敛**。

---

## 来源(2026-07 WebSearch)

- Paperclip 机制/org-chart/预算/治理:paperclip.ing、github.com/paperclipai/paperclip、mintlify docs、stanza.dev(org charts)、jimmysong.io、rywalker.com、contabo.com/blog
- 增长/GTM/operator 定位:dev.to(Open-Source OS for 20 agents)、eweek.com、@dotta × Greg Isenberg X 帖、remoteopenclaw.com、neuralnotions(Medium)
- 诚实成熟度/局限:vibecoding.app/blog(review ~7.8)、kunalganglani.com、rywalker.com、github issues(4,953 open）
- bootstrap 模板:github.com/paperclipai/companies(README + Superpowers/gstack/Full-Stack Forge)、yesterday-ai/paperclip-plugin-company-wizard
