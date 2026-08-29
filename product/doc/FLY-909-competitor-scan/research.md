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

---

## 7. 扩展(2026-07-07):Claude Cowork + Codex app —— 存在性拷问

> Annie 加的:这两家已是很 general 的 agent 编排工具,我们还有没有价值/会不会被取代?诚实答、别护短、验证假设别替她下结论。产出进 competitor-scan.md ⑥ + review.html。

### 7.1 Claude Cowork(Anthropic)
- **面向**:明确做**非技术知识工作者**(no terminal / no coding / no technical background)。例子:研究综述、合同抽取、survey 处理、周期报告。
- **形态**:活在 **Claude 桌面 app** GUI,直接读你电脑一个文件夹;底层是 Claude Code 的 lead+sub-agent 编排(sub-agent 还能生 sub-agent = dispatcher)。
- **用法 = done-for-you**:你**描述「做完长什么样」→ 它 start/run/finish、把成品交到你文件夹**,你 review 成品(告诉它 what,不是 how)。「Chat 让你自己做得更快;Cowork 直接替你做完」。
- **持久**:多天会话、本地文件、Dreaming feature,适合跨周项目(迁移/深研/文档)。
- ⚠️ **对我们**:这是**最贴、最该警惕**的一家——非技术 + done-for-you 几乎就是我们的定位。差异靠:领域(它做文件知识工作,不是建养软件产品)、界面(桌面 app vs 手机 IM)、常驻组织 vs 任务、锁 Claude。

### 7.2 Codex app(OpenAI)
- **面向**:**开发者-导演**。桌面「command center for agents」+ CLI;manager 协调并行 subagent(subagents 2026-03-14 GA;max_threads 默认 6,官方另有到 8 的说法;max_depth 默认 1)。内部编排框架 = Symphony(开源 Elixir)。
- **叙事**:「bottleneck 不再是 agent 能做什么,而是人怎么指挥/监督多个 agent」;开发者从写代码转向编排/review/架构判断。2M+ 周活。
- ⚠️ **对我们**:Annie 的「他们是开发者工具、要懂技术」假设**对 Codex 成立**。

### 7.3 诚实结论(喂 competitor-scan.md ⑥)
- **编排引擎(lead+subagent+dispatcher)现在是 Claude(Cowork / Code Agent Teams / `/goal` 常驻 / agents dashboard)和 Codex(subagents GA)两家的一方功能** —— 我们在编排机制层面重叠多、不占优,大厂资源更足。**custom 子 agent 框架**(Flywheel 的前身那类)当初出现正是因为 Codex CLI 早期没 subagent;现在被一方功能吸收,这是「会不会被取代」的真实压力。
- 差异候选(待 911):领域(建并养真软件产品)· 常驻组织 · 手机 IM · **供应商中立**(Cowork 锁 Claude / Codex 锁 OpenAI,第一方结构上不会替你用对手模型;Flywheel 多后端 claude-tmux/codex/antigravity/kimi)。**能打≠现在建**(Annie setup 先不做 agent-agnostic,不冲突)。
- 风险:**Cowork(Anthropic 自己)最该盯** —— 若它指向「从手机替你建并维护一个软件产品」,我们空间快速被压缩。我们引擎层无护城河,赢面全在能不能更早把那套组合productize 成非技术真能用的 done-for-you 软件团队(现在还没到)。

### 7.4 来源(2026-07 WebSearch)
- Claude Cowork:anthropic.com/product/claude-cowork、claude.com/blog(how people use)、support.claude.com(get started)、mintmcp.com(use Cowork if not engineer)、aibl.to(Claude Trinity)、maven.com(Cowork for knowledge workers)、anthropics/knowledge-work-plugins
- Codex app:openai.com/index/introducing-the-codex-app、intuitionlabs.ai、firecrawl.dev(multi-agent orchestration)、bhavishyapandit9.substack、morphllm.com(Codex vs Claude Code 2026)
- 对比/持久 vs 任务:flowtivity.ai(Hermes vs Codex vs Cowork)、developersdigest.tech(Claude Code vs Codex app 2026)、code.claude.com/docs(agent-teams)、mindstudio.ai(Claude Code Agent Teams)

---

## 8. round-3 扩展(2026-07-07):Open Cloud/OpenClaw + OPC beachhead + Value 工件

> Lead 指令 3b81e3cd:加 Open Cloud(OpenClaw)+ Aimless Agent 竞品;回答 OPC(One Person Company)beachhead 硬问题;产出 Value 工件(5 支柱)。beachhead 从「完全非技术」演进到「OPC = 技术够的单人创始人」。

### 8.1 Open Cloud / OpenClaw(Annie 灵感来源)
- **是什么**:Peter Steinberger 开源个人 AI 助理,本地跑你自己设备、在你已用的 IM(Discord/TG/Slack/WhatsApp/Signal… 29 渠道)回你;本地私有零云、能浏览/填表/读写文件/跑 shell、跨会话记忆。
- **怎么起来的**:Clawdbot→Moltbot→OpenClaw(2026-01);2 月 100K star、~60 天 250K star(史上最快 repo,超 React 十年);build-in-public + Discord 当 showroom、半百万系统在跑,创始人 Fast Company AI 20。
- **现状(热度回落)**:安全事故(恶意第三方 skill/过度授权/钓鱼 repo)后降温,「OpenClaw is dead」论坛梗。真因=**定价套利泡沫**(靠被低估算力起,平台调贵后 Feb→Apr 几天崩、只剩认真工作流)+ 创始人转投 OpenAI 带走社区(Anthropic 拒 hire)+ 深度本地访问安全风险。**项目没死**,转 AI-agent stack 认真-谨慎一层,375K+ star、周更、猛推可靠性(恢复/audit/MCP 校验/LTS)。
- **跟我们**:重叠=IM 驱动界面赌注最像(连 Discord 门面);差异=它是你自己跑的单个助理(self-host/single-agent),不是常驻多部门 done-for-you 组织;爆红-回落一课=定价套利+病毒自托管不持久,持久=managed 可靠性+audit。可借鉴=多渠道触达+跨会话记忆+Discord-showroom GTM;别学=深度本地访问安全敞口/纯自托管甩锅可靠性。
- ⚠️ **Aimless Agent 查无实据**:两轮 WebSearch 未找到,标待 Annie/Lead 确认真名(不硬编造)。

### 8.2 OPC beachhead 硬问题(诚实)
- Annie 落 beachhead 到 OPC=一个人开公司(技术够、越来越多)。诚实第一条:OPC 能自己拼(OpenClaw 自托管+Cowork+Codex)=引擎层无护城河、此人群尤其能 DIY,必须认。
- 真差异押(候选,待 921,「他能拼但懒得拼/拼不出气质」):①常驻组织(非单助理/非你启动的任务)②生态整合/供应商中立(按难度配模型成本、单一工具短板别家补;Cowork 锁 Claude/Codex 锁 OpenAI 结构不会替你用对手)③体验气质(managed/可靠/像真人团队、有趣+drama+真实、voice)。总结:赢的不是「他做不到」,是「他能拼但不值当自己搭+维护这套」。

### 8.3 Value 工件(value-artifact.html)
- 把 Annie 5 支柱包装成 OPC 外人可感知的商业 Value:①常驻组织=记忆+掌控(常驻 Lead+long-term memory+Linear 第二大脑)②多线并行各自独立不糊(每 session 自己 thread/file vs CC 一个窗口)③多视角团队(工程/管理/产品 Lead,越用越强、跨项目复用)④供应商中立生态整合(CC 弱多模态→Antigravity)⑤(未来)成本+价值可视(token+eval 面板)。框架=OPC「你一个人手握一整个公司」;每支柱标「为什么 DIY 攒不出」;demo 气质=有趣+drama+真实、voice 像真人。目的=技术优势+Annie 个人体验→外人可感知商业 Value。

### 8.4 来源(2026-07 WebSearch)
- OpenClaw:openclaw.ai、github.com/openclaw/openclaw、digitalocean.com、kdnuggets.com、Fast Company AI 20;decline:medium(rosgluk rise-and-fall / mehul "is dead")、techcrunch.com(2026-02-16)、smartproductivitytools.com、elegantsoftwaresolutions.com(May review)、getagentiq.ai(myth-check)
- Aimless Agent:两轮 WebSearch 无匹配(待确认)

### 8.5 round-3.1 target 纠正(2026-07-07,Lead 指令 fe7ba7c3,盖过 8.2 的「技术够 solo founder」)
- **target 收窄 = 非技术的 OPC operator**(自己做电商 / social 的一人公司):有「一人干一团队的活」的痛,**不是程序员、自己拼不出来 → 需要 done-for-you**。
- **不打程序员 OPC**:他们自己能搞、不需要我们、抢不过;能用但不是专门 target。
- **DIY 硬问题 reframe**:引擎无护城河属实 —— 但会自己拼的是程序员、本就不是我们攻的人,所以 **DIY 风险不落在非技术 operator 这群身上**。对能 DIY 的技术人不占优也不攻;对非技术 operator,他们要替他做 + 常驻组织 + 生态整合 + 体验气质。
- **定位主线一句话(Annie 定)**:替一个非技术的一人公司 operator,把一整个「公司」的活在聊天里做掉。
- 落地:competitor-scan.md ⑦ OPC 部分 + 标题本版说明重写;value-artifact.html hero/frame/各支柱 DIY 部分重框;review.html OpenClaw+OPC 卡重框。
