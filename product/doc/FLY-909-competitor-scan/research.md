# FLY-909 竞品分析 — 调研

Issue: FLY-909 (https://linear.app/geoforge3d/issue/FLY-909/竞品分析市面上别人怎么做-喂产品定位形态)
日期: 2026-07-06
基于: exploration.md

> 事实核对说明:AI 知识截止 2026-01,以下各家定位/定价/事件已用 2026-07 的 WebSearch 刷新。定价随时会变,以官网为准;本文抓的是**形态与定位打法**,不是精确账单。来源见文末。

---

## 0. 市场大背景(定位的水位)

- **「Vibe coding」= 2026 约 $4.7B 品类,~38% CAGR**;**63% 的 vibe-coding 用户是非开发者**;92% 美国开发者每天用 AI 编码工具。Gartner 预测 2028 年 40% 新企业软件用 vibe-coding 方式产出。
- **Karpathy 2025 初造词「vibe coding」,2026-02 又说它「passe」**,提出更结构化的「**agentic engineering**」:**人给架构与 review,agent 做实现**。
  - → 这句话几乎是 Flywheel 定位的行业背书:**「founder 只管两头(方向 + 验收),中间 AI 团队自治」= agentic engineering 的组织化版本**。市场叙事正在从「自己 vibe 一个 app」转向「让 agent 团队去建、人来把关」。
- **相邻热品类:「AI employees / AI 业务 agent」**(Lindy / Artisan / Vellum / OpenClaw / Zapier Central / Gumloop),AI agent 是 2026 增长最快的软件品类之一。但这些做的是**运营类**活(销售、邮件、客服、workflow),**不造软件**。

---

## 1. no/low-code AI builder 档(最贴我们目标客户 —— 非技术小企业)

这一档的共同形态:**非技术本人在一个画布/聊天框里,用自然语言 prompt → 出一个能跑的 app**。用户**自己是 builder**。

### Lovable
- **定位一句话**:让非工程的创始人/PM「不写一行代码就发布 production app」——vibe coding 的门面。
- **目标用户**:非技术创始人、PM、想快速做 MVP 的小团队。
- **产品形态**:聊天式 prompt → 全栈 web app;浏览器内,所见即所得。
- **onboarding**:输入一句想法 → 几分钟出可点的 app;模板/remix 起步。
- **亮点**:上手最快、对绝对非技术最友好;生成即部署。
- **定价**:Free(每日 5 build credits)/ Pro ~$25/mo / Business ~$50/mo。**坑:Cloud(存储/带宽/DB)与 AI(app 内推理)按用量另计,实际账单常超套餐价**。

### Base44(2025-06 被 Wix ~$80M 收购)
- **定位一句话**:一句话描述 → 直接产出**带 UI + 数据库 + 认证 + 托管**的全栈 app(不是只给你个前端)。
- **目标用户**:做 dashboard、内部工具、门户、workflow 系统的非技术/半技术用户。**明确说自己是 app builder,不是 website builder**。
- **产品形态**:prompt → 可部署、数据后端已接好的 app。
- **数据点**:2M+ 用户、$100M ARR、创始人单人 bootstrap 起家 —— 增长远超融资,证明这个「一句话出全栈 app」形态对非技术极有拉力。
- **定价**:Forever Free(25 message credits)/ 起步 ~$16/mo(年付)。message credits(改 app)+ integration credits(app 内发邮件/AI 调用)双计。

### Replit Agent(Agent 3)
- **定位一句话**:把大白话变成能跑的 app,自动配 DB、认证、第三方、部署,「你不用碰文件」。
- **目标用户**:非技术 + 想快速原型的开发者。
- **产品形态**:云端 IDE + Agent;自然语言驱动全流程。
- **定价**:Free / Core $20/mo / Pro $100/mo(2026-02 上线,含额度折扣与滚存)。
- **坑**:**非技术用户账单最痛** —— 每次迭代/修 bug/失败尝试都烧 credits,评测普遍反映「bill shock」。

### v0(Vercel)
- **定位一句话**:高质量 UI 组件工厂(React/Next.js),不做全栈。
- **目标用户**:偏前端开发者/半技术;**对纯非技术不如 Lovable 友好**(要点 React 基础才能吃透)。
- **产品形态**:prompt → 高质量 UI 组件/页面。
- **定价**:Free / Premium $20 / Team $30/座 / Business $100/座。
- **注**:UI 质量业内最强,但只覆盖约 30% 的活,其余要开发者补。

### Bolt.new(StackBlitz)
- **定位一句话**:浏览器里的整套开发环境,聊天 → 建项目 + 装依赖 + 写后端 + 配 DB + 部署。
- **目标用户**:beginner/非开发者做快速全栈原型。
- **产品形态**:in-browser 全栈脚手架,能扛 70-80% 的活。
- **定价**:Free(每日限量消息)/ 起 ~$20/mo,token/credit 制。

**这一档小结(喂定位)**:
- 共同价值主张 = **「idea → 几分钟出能跑的 app」**,卖的是**自助建造工具**。
- 共同痛点 = **credit 制账单不可预测**(Replit/Lovable 尤甚),非技术用户最恨 surprise bill。
- 天花板 = 适合 MVP/内部工具;**建出来的东西的长期维护、演进、代码质量,用户自己扛**。

---

## 2. 自主编码 agent / AI 开发团队档(只看形态 + 定位打法)

这一档形态:**你派一个任务给一个 agent,它在你的真实 codebase 里 plan → 写 → 测 → 出 PR**;卖给**工程团队**。

### Devin(Cognition)
- **定位一句话**:「AI software engineer」—— 在公司真实 codebase 与工具链里 plan/write/test/ship。
- **定位打法(关键)**:Cognition 说自己**不是卖开发者生产力软件,是卖一种新的「工程产能单位」(engineering capacity)** —— 能在真实代码库里干活的 AI agent。这个「把 agent 当产能/当员工卖」的叙事很值得学。
- **形态**:Slack 式界面派任务,或挂 GitHub/Jira ticket → 自主执行。
- **目标用户**:工程团队/工程 leader。
- **定价**:Free / 个人 $20/mo(2025 末从 $500 砍 96%)/ Team $500/mo(250 ACU)。
- **体量**:Cognition 2026-05 融 $1B、估值 $25B;价格重构后 ARR 9 个月 $1M→$73M。

### Factory(Droids)
- **定位一句话**:「agent-native software development」—— 覆盖整个 SDLC 的自主 Droids。
- **形态**:desktop/CLI/SDK 多环境;**Slack 触发任务 + Linear 连接的 async 工程流**;接 GitHub/GitLab(PR)、Jira/Linear、VS Code、MCP。
- **目标用户**:企业工程团队。
- **定价**:Pro $20 / Plus $100 / Max $200,**无免费**。$1.5B 估值,Terminal Bench 第一。

### GitHub Copilot / OpenAI Codex / Claude Code(形态谱系)
- **Copilot**:实时 IDE 内联补全 + agent mode;把人留在 IDE loop 里(enterprise 默认铺量)。
- **Codex**:**async 云端 agent** —— 派任务 → 云端沙箱 clone repo → 自主干 → 回来 review PR/diff。
- **Claude Code**:terminal-first agentic;async / Slack 工作流最强。**Flywheel 的 Runner 就是它**。

**这一档小结(喂定位)**:
- 核心 primitive = **「在 chat/ticket 里派活 → 自主 → 出 PR」** —— **这正是 Flywheel Runner 已有的形态**,验证了方向。
- 但它们卖的是**一个工程师**(assign a task to an agent),挂在**工程工具链**(IDE/GitHub/Jira)上,买家是**工程团队**。
- **没有一家把自己包装成「一整个 AI 公司/多部门组织,由非技术创始人指挥」**。

---

## 3. teammate 形态档(最能照出我们像谁/不像谁)

### 3a. 软件类 teammate(Devin / Factory 的 Slack 面)
- 都有「在 Slack 里派任务、追状态、拿 PR」这层 —— 跟 Flywheel「Discord 里跟 Lead 聊、派活、出 PR」**同构**。
- 但它们是**把 Slack 贴在工程工具链上的一个通知/派单入口**,不是**以聊天为主界面的组织**;而且是**单 agent 对单任务**,没有「Lead 管 Runner」的层级编排。

### 3b. 业务类 AI employees(Lindy / Artisan / Vellum / OpenClaw)
- **Lindy**:2026 对非技术最友好的 agent builder —— 大白话描述 agent + 拖拽 trigger/action 画布,接 Gmail/Slack/HubSpot/Notion 等 1000+ 集成,跨 run 记忆。$49.99/mo,无永久免费。做的是**沟通/运营 loop**(邮件、日历、CRM)。
- **Artisan**:自主 BDR(外呼销售)。
- **共性**:teammate/员工叙事 + 接「小企业已经在用的工具」+ 大白话配置;**但都不造软件**。
- **值得学的**:①「像招个员工」的叙事对非技术小企业最抓人;②**接客户已在用的工具**(不然一周内摩擦劝退);③大白话/SOP 即可配置。

### 3c. 多 agent 系统(MAS)作为概念
- 「Research Agent + Copywriter + Data Analyst 分工协作降错误率」的 MAS 概念在传播,但基本是**开发者自己攒的 stack**,不是给非技术打包好的「AI 公司」产品。

**这一档小结(喂定位)**:
- **交叉点是空的**:software-building × 组织/teammate 形态 × 非技术创始人指挥 —— Devin/Factory 占了 software-building 但卖单个工程师给工程团队;Lindy/Artisan 占了 teammate/员工但做运营不造软件。**「由非技术创始人在 chat 里指挥、真造并维护软件的整个 AI 公司」这个位置,目前没人正面占。**

---

## 4. April Dunford 视角:我们真正要打败的「替代品」是什么

给**非技术小企业**「想要一个软件/产品」时,它们今天其实会:
1. **雇 freelancer / 外包 dev shop**(最主要的真实替代 —— 贵、慢、沟通累);
2. **自己上 no-code**(Bubble / Webflow / Airtable / Lovable / Base44 —— 能出 MVP,但要自己建、自己维护、长出来的东西自己扛);
3. **找个技术合伙人**;
4. **「no decision」= 啥也不做 / 用 spreadsheet 顶着**(B2B 里 ~40% 输给这个)。

→ Flywheel 要赢的不是「比 Lovable 多个 feature」,而是:**比雇外包更省心、比自己 vibe-code 更能长期扛住一个真产品**。这才是定位的靶子。

---

## 来源(2026-07 WebSearch)

- Lovable 定价/定位:lovable.dev/pricing;flowith.io、costbench.com、eesel.ai 的 2026 定价评测
- Replit Agent:replit.com/pricing;espressio.ai「Agent 3」指南;nocode.mba、checkthat.ai 定价
- v0 / Bolt:index.dev、developersdigest.tech、vibecoding.app 对比;nocode.mba v0 定价
- Base44:wix.com press room(收购公告)、weavai.app、usecarly.com;$100M ARR / 2M 用户数据点
- Devin / Cognition:devin.ai/pricing;techcrunch.com(2026-05 融资 $1B/$25B);costbench.com 定价
- Factory:factory.ai(product/slack、product/droids、news/series-b、news/GA);theaiagentindex.com;nea.com
- Copilot/Codex/Claude Code:datacamp.com、cosmicjs.com、lushbinary.com 2026 对比
- Vibe coding 市场:taskade.com「State of Vibe Coding 2026」、keyholesoftware.com、hostinger.com 统计
- AI employees:lindy.ai、vellum.ai、getbob.ai、teamday.ai 2026 评测

---

## 5. round-2 补充(2026-07-07):完全非技术视角 + 新竞品 + 可信度轴重构

> Annie round-2 决定:目标客户锁死「完全非技术小企业主」(会读 PR 的 persona 出局);加 Paperclip;所有轴按非技术视角重写,尤其可信度轴。以下是新增/更新的事实。

### 5.1 新竞品:Paperclip(@dotta,开源 AI 公司控制平面)
- 见独立文件 **paperclip-deepdive.md**。要点:2026-03-02 发布、MIT 开源免费、自托管 Node.js+React、org chart+ticket+全程 tracing、**BYO agent**、3 周 30K→4 月 43K+ star。作者因「同时管 20–30 个 Claude Code 窗口」痛点而建(与 Flywheel 同源)。**定位 = generic 横向控制平面**,面向会自托管的开发者/prosumer,**非完全非技术**。
- 意义:它 + Matrix 坐实「把 agent 组织成公司」= 已商品化(还免费开源)。→ 「AI 公司」壳当差异彻底死;真差异 = concrete(替你建你那个具体产品)vs generic(给你框架自己拼)。

### 5.2 Hermes / OpenHands 按非技术视角重构(round-1 已有,这轮更新)
- **OpenHands**(All Hands AI):2026 出了 **Cloud**(app.all-hands.dev,连 GitHub/GitLab/Bitbucket)+ 本地 GUI + CLI + SDK。但官方与评测一致:**「primarily designed for developers rather than non-technical users — requires understanding of code repositories and technical workflows」**。→ 对完全非技术仍是非起点。
- **Hermes Agent**(Nous):2026-06 出**桌面 app**(mac/linux/win 一键装、简中 UI)+ 2026-07 **v0.18.0**(Mixture-of-Agents、self-verifying goals、/learn、/journey 学习时间线、memory-graph「看着 agent 长本事」)。→ 门槛降了,但根子仍是**自托管单 agent**(不是替你托管的一整个团队);memory-graph/self-verifying 是它的信任可视化 affordance。

### 5.3 可信度轴重构素材(非技术怎么感知信任)
- **只有 6% 的公司完全信任 AI agent 自主跑核心业务**(verification infrastructure 还没到位)。
- 非技术信任来源:①可追溯 audit trail ②有名有姓的 business owner + technical owner、明确意图/风险边界 ③高影响动作要审批/多步验证 ④rate limit + guardrails + emergency stop。SMB 的治理不必重,轻但一致即可。
- 竞品信任机制都是「给你看证据面板」:Paperclip ticket+tracing、Matrix return proof、Hermes memory-graph/self-verifying —— 对纯非技术仍是「看不太懂的记录」。
- → Flywheel 面向非技术的可信度锚点 = **结果证明(一试真能跑 + 持续维护不烂)**,这是非技术老板唯一能自己验证的、且 Matrix(coding 弱)/Paperclip(generic BYO)做不到的地带;工程纪律(PR/CI/QA)沉到引擎盖下当底气。详见 competitor-scan.md ③。

### 5.4 品类框架:「Zero-Human Company」(2026 命名品类)
- 一波仓库数周内密集发布,前提:AI agent 不是辅助公司,而是**就是**公司(「zero-human」不是「AI-assisted」)。Paperclip 单月 43,900 star,GitHub 史上最快之一;还有 Pulsia、Felix Craft 等。
- **品类自我批评(= 我们的定位礼物)**:这是真的架构趋势(多 agent 编排在发生)裹着 hype 品牌(「zero-human」过度承诺)。**瓶颈已不是执行,是需求 / PMF**——「AI 能 spin up 上千家公司,但谁在买?」;需要判断、创造、关系、信任、在模糊中拿捏的复杂活动**当前 AI 自动化不了**。→ 喂 competitor-scan.md TL;DR #2 的「不是零人公司、是你做判断 AI 做工程」(定位建议,待 Annie/FLY-911 拍)。

### 5.5 round-2 补充来源(2026-07 WebSearch)
- Paperclip:paperclip.ing、github.com/paperclipai/paperclip、contabo.com/blog、towardsai.net、mindstudio.ai、theaienterprise.io、Greg Isenberg X 帖、dev.to Deep Dive
- Zero-Human Company 品类:ossinsight.io(zero-human-company-2026)、fortune.com(2026-03-05)、technologyreview.com(agent-orchestration)、flowtivity.ai、tldl.io
- OpenHands 2026:openhands.dev、docs(Cloud)、aiagentslist、vellum.ai(best coding agents)
- Hermes 2026:github.com/NousResearch/hermes-agent releases、theplanettools.ai(Hermes Desktop)、releasebot.io(v0.18.0)、hermes-agent.org
- 非技术信任:curationai.ai(verification infrastructure)、vouched.id、dock.io、devoteam.com、cyberadvisors.com

---

## 6. round-2.1 补充(2026-07-07):Annie 批注修订 + Paperclip 真挖深

> Annie 看完 round-2 给了实质批注(instruction 68563d64)。核心:①用词去丧(别人做了≠我们不能做);②真研究 Paperclip、别只下「generic 死了」的结论;③别 overclaim「完全非技术」(现在是假的);④Lovable 主要是出 UI 的地方;⑤自托管诚实化(差异是「done-for-you 替你做」不是「不用自托管」);⑥bootstrap 打法采纳。并且**定位大结论归 FLY-911**,竞品扫描不硬下,差异写成候选。以下是 Paperclip 真挖深的新事实。

### 6.1 Paperclip 机制(org-chart / 预算 / 治理具体怎么设计)
- **三角色**:CEO(一司一个)→ Manager(协调子团队、派 IC)→ IC(干活);汇报线定义委派(CEO→CTO→工程师)。
- **预算**:每 agent 月度预算;80% 软预警、100% 自动暂停+挡新任务;board 可 override 恢复。
- **治理**:agent 改动 Paperclip 本身受控;**雇新 agent 默认要 Board 批准**。
- **ticket + heartbeat**:ticket 唤醒;定时 heartbeat + 事件触发;heartbeat 执行 = DB wakeup 队列(coalescing)+ 预算检查 + workspace 解析 + secret 注入 + skill 加载 + adapter 调用 → 结构化日志/成本事件/session 状态/审计。
- **issue 一等公民**:company/project/goal/parent 链、原子 checkout + 执行锁、blocker 依赖、评论/文档/附件/work product/label/inbox。
- **审计**:append-only 审计日志(不可改删)。
- **BYO 任意 agent**:「能收 heartbeat 就算雇了」;到 6 月支持 Claude/Codex/Gemini/Cursor/Hermes/OpenClaw/Pi/OpenCode + Bash + HTTP。

### 6.2 增长 / GTM
- 3-2 发布 → 3 周 30K star → 4 月 42K+6,400 fork → **6-11 达 69,955 star**、105 contributors。
- **明说给 operators 不给开发者**;@dotta × Greg Isenberg 47 分钟 live demo 拉非技术买家(solo 创始人/agency/牙医·营销公司)。
- 自我软化:从「zero-human companies」→「the app people use to manage AI agents for work」。

### 6.3 诚实成熟度(Annie #3 的证据:赛道都还早)
- bug/404/agent 忽略 override;「a proof of concept wearing a product's clothing」;每周报 bug;context 丢了静默重启;**4,953 open issue vs 105 contributor**;化名 lead、无融资、无实体;评分 ~7.8/10。

### 6.4 bootstrap 打法(先立具体旗舰)
- paperclipai/companies 模板库:即导即跑的配置好公司(org chart+skills+治理)。**软件公司模板**:Superpowers(CEO/CTO/QA Engineer/Release Engineer/Staff Engineer + TDD + code review)、gstack Engineering Company、Full-Stack Forge(66 skill)。Company Wizard 插件(回答几问→装配)。
- 落到我们:具体旗舰 = 软件公司 = dogfooding(Flywheel 建 Flywheel)。

### 6.5 round-2.1 补充来源(2026-07 WebSearch)
- 机制:paperclip.ing、github.com/paperclipai/paperclip、mintlify docs、stanza.dev、jimmysong.io、rywalker.com、contabo.com
- 增长/GTM:dev.to、eweek.com、@dotta × Greg Isenberg X、remoteopenclaw.com
- 成熟度:vibecoding.app/blog(~7.8)、kunalganglani.com、github issues(4,953 open)
- bootstrap 模板:github.com/paperclipai/companies、yesterday-ai/paperclip-plugin-company-wizard
