# FLY-909 竞品逐家深挖(深化一层)

Issue: FLY-909
日期: 2026-07-06
基于: research.md / candidate-list.md / gtm-intel.md;Matrix 有独立文件 matrix-deepdive.md

> 把已知竞品在 定位 / 目标用户 / 产品形态+onboarding / 亮点 / 定价 / GTM / 软肋 / **跟我们像不像 + 差异化** 上再深一层。事实用 2026-07 WebSearch 刷新,来源见文末。**Matrix 见 matrix-deepdive.md(最贴对标,不在此重复)。**

## 顶部对比矩阵

| | 定位一句话 | 目标用户 | 产品形态 | 定价 | 关键软肋 | vs Flywheel 一句话 |
|---|---|---|---|---|---|---|
| **Lovable** | 不写代码发布 production 全栈 app | 非技术创始人/PM/设计 | 聊天 + 可视化点选改;prompt→全栈→一键部署;可 eject 到 GitHub | Free/$25/$50/Ent | **technical cliff**:复杂/自定义功能撞墙,要雇开发者 | 它给你自助工具、你自己建到撞墙;我们给你一支团队建到底、并长期养 |
| **Base44**(Wix) | 一句话→带 DB+认证+托管的全栈 app | 做内部工具/dashboard 的非技术 | prompt→全栈 app;24h 出内部工具 | Free/~$16 | **vendor lock-in**(数据锁平台、无干净导出)+ 只出 SPA(SEO 差)+ 设计控制弱 | 它锁在自己平台;我们建在你自己的真 GitHub repo,不锁定 |
| **Replit Agent** | 大白话变 app,不用碰文件 | 非技术+原型开发者 | 云 IDE + Agent | Free/$20/$100 | 非技术 credit bill-shock 最痛 | 它还是个 IDE;我们让你只在 Discord 说话 |
| **Devin**(Cognition) | AI software engineer(工程产能单位) | 工程团队 | 云端隔离 VM;**Devin 能管 Devin**(主协调一队 managed Devin 并行) | Free/$20/$500 | 模糊/探索/架构/需**产品判断**的活会「自信地做错」 | 它是给工程师的、需你把任务讲清;我们有 Lead 做产品判断 + 非技术 founder 在环 |
| **Factory**(Droids) | agent-native 覆盖整个 SDLC | 企业工程团队 | desktop/CLI/SDK;Slack 触发+Linear 连接 | $20/$100/$200 | 面向企业工程,非非技术;无免费 | 卖给工程团队做 SDLC;我们卖给非技术创始人做整个产品 |
| **OpenHands**（All Hands AI） | 开源的云端 coding agent 平台(开源版 Devin) | 开发者(+自托管者) | web GUI / CLI / SDK;接 Slack/GitHub/GitLab | Free(BYOK)/Pro $20(at-cost 零加价) | 开源=要你会用 dev 工具链;非技术门槛高 | 它开源给开发者自装;我们是给非技术创始人的托管团队 |
| **Hermes Agent**（Nous） | 开源自托管、会自己长本事的常驻 agent | 技术自托管者 | 自己服务器跑 daemon;接 16+ 消息平台 | 开源(自付基建,$5 VPS 起) | 要会自托管;单 agent 非团队 | 它要你自己养一个 agent;我们替你养一整个团队 |

---

## 1. Lovable —— 「自助建造工具」里最贴非技术的,也最能照出「technical cliff」

- **定位(verbatim 风格)**:让非技术的创始人/PM/设计「不写一行代码发布 production app」;vibe coding 门面。2026-03 起还扩到通用任务(数据分析/BI/PPT/营销)。
- **目标用户**:非技术创始人、PM、设计师、快速做 MVP 的小团队。
- **产品形态 + onboarding**:几分钟上手。**Chat Mode**(边聊边规划/调试)+ **可视化点选编辑**(点 app 上任意元素直接改)+ **Plan Mode**(2026-02,写代码前先给你看它打算建什么,像 design review)。prompt → 生成完整 codebase(前端+后端+DB+认证)→ 一键部署。**Supabase** 供 DB/认证/实时;**全 GitHub 同步、生成 TS/React、可 eject 干净导出**(想找开发者接手就接手,不锁定)。
- **亮点**:上手最快、对纯非技术最友好;生成即部署;**可 eject 不锁定**(区别于 Base44)。
- **定价**:Free(每日 5 build credits)/ Pro $25 / Business $50 / Enterprise 面议。credit + 隐藏 Cloud+AI 用量。
- **GTM(见 gtm-intel.md)**:build-in-public 教科书 —— $100M ARR 零付费广告、全员 X+LinkedIn 发、249 KOL、12+ 渠道飞轮、黑客松送 credits。
- **软肋(关键)**:**technical cliff** —— 「生成漂亮 UI,但复杂功能/自定义设计系统撞墙」,「团队常做出原型,才发现自定义功能非雇开发者不可」。不适合大型企业项目。
- **跟 Flywheel 像不像 + 差异化**:
  - 像:都打「让非技术把软件做出来」;都能几分钟出真东西。
  - **不一样**:Lovable 是**自助工具,你是唯一建造者**,一撞 technical cliff 就得自己雇人;Flywheel 给你**一支会写真代码的团队**,复杂功能是团队接着干,还长期维护。Lovable 生成一坨代码交给你,**维护/演进你扛**;我们像真团队走 PR/CI/review 持续养。
  - **借鉴**:①「几分钟出能跑的东西」的 onboarding;②Plan Mode(先给看计划再动手)= 我们 brainstorm gate 的产品化呈现;③可 eject 不锁定这点我们天然更强(本来就是你自己的 repo)。

## 2. Base44 —— 一句话出全栈内部工具,但锁定 + 只出 SPA

- **定位**:一句话描述 → 自动生成前端 UI + 后端逻辑 + DB schema + 认证 + 托管。**明确是 app builder 不是 website builder**,主打 dashboard/内部工具/门户/workflow。
- **目标用户**:做内部工具(HR/CRM/dashboard)的非技术/半技术;24h 出一个内部工具。
- **产品形态 + onboarding**:不用拖拽、不用连外部 DB;描述需求 → 平台自动生成全栈。最快出全栈 MVP(前后端+DB+认证+托管全含)。
- **亮点**:「一句话 → 可部署、数据后端已接好」的完整度;$100M ARR / 2M 用户 / 单人 bootstrap → 被 Wix $80M 收(2025-06)。
- **定价**:Forever Free(25 msg credits)/ 起 ~$16 年付;message + integration 双 credit。
- **GTM(见 gtm-intel.md)**:创始人 LinkedIn 第一人称连载 + 产品自传播(用户晒作品);零付费广告;3 周 $1M ARR。
- **软肋(关键)**:
  - **vendor lock-in 真实**:数据锁在 Base44 托管 Postgres,**没有干净的「全部导出」**,GitHub 代码导出到 2026 年中大多套餐还是 beta。
  - **只出 SPA**:无 SSR/预渲染 → SEO 差、分享链接社交预览坏。
  - **设计控制弱**:可视化编辑只能微调,自定义设计系统撞墙。
- **跟 Flywheel 像不像 + 差异化**:
  - 像:都让非技术「说需求→出全栈能跑的东西」。
  - **不一样**:Base44 **锁定**(数据/代码出不来);Flywheel 建在**你自己的真 GitHub repo**,零锁定、随时可接管。Base44 出 SPA 内部工具;我们建可长期演进的真产品。
  - **借鉴**:「后端/认证/托管已接好、开箱能跑」是非技术 onboarding 的黄金标准 —— 喂 FLY-908 的一条 command onboarding。

## 3. Devin(Cognition)—— 已经是「Devin 管 Devin」,单 agent 框架过时了

- **定位**:AI software engineer;卖「新的工程产能单位」。
- **目标用户**:工程团队 / 工程 leader。
- **产品形态**:每个 session 跑在**隔离 VM**;几秒内自动分析 codebase + 提初始 plan。**Devin 2.0 能 manage Devins** —— 主 Devin 当协调者,把大任务拆给一队 **managed Devin** 并行(各自 VM/终端/浏览器),监控进度、解冲突、汇总;还能 **schedule Devins**(定时)。工具:Devin Search / Devin Wiki / Interactive Planning。入口:Slack 式派任务 / 挂 GitHub·Jira ticket。
- **定价**:Free / 个人 $20(从 $500 砍 96%)/ Team $500(250 ACU)。Cognition 2026-05 融 $1B、估值 $25B。
- **软肋(关键)**:**模糊/探索/架构重/需产品判断**的活会「自信地做错」;任务欠明确就跑偏。
- **跟 Flywheel 像不像 + 差异化(诚实收窄)**:
  - 像:**Devin 也是分层多 agent 了**(主协调 managed Devins)+ async 派活→出 PR + Slack 入口 —— 所以「我们是团队、它是单 agent」这条**过时,别再讲**。
  - **不一样**:①**买家与界面** —— Devin 卖给工程师、挂在 IDE/GitHub/Jira;我们卖给**非技术创始人**、界面是 Discord。②**产品判断层** —— Devin 恰恰在「模糊/需判断」处翻车;Flywheel 有 **Lead 做分诊/产品判断 + founder 在环给方向**,正补它的短板。③它在**别人的 codebase**里当承包工;我们是**替非技术创始人从 0 建并养他自己的产品**。
  - **借鉴**:Interactive Planning(先协作定 plan)+「卖产能单位/像雇人」的叙事被验证能撑价格。

## 4. OpenHands(All Hands AI)—— 开源版 Devin,开发者向

- **定位**:「开放的云端 coding agent 平台」;社区对 Devin 的开源回应。
- **目标用户**:开发者;要自托管/可编排的团队(freelancer 用 CLI+免费云,agency 上自托管 K8s)。
- **产品形态**:多入口 —— web GUI / CLI / SDK;接 Slack / GitHub / GitLab / Bitbucket。给个 GitHub issue → 自主 plan/写/出 PR。$18.8M A 轮、70K+ star、Anthropic·Menlo Anthology Fund 首批。
- **定价**:Individual 免费(BYOK 或按用量 at-cost)/ Pro $20(覆盖 runtime compute + **用平台模型 at-cost 零加价**)。
- **软肋**:开源 = 要你会 dev 工具链(CLI/SDK/approval flow);对纯非技术门槛高;要自己攒/托管。
- **跟 Flywheel 像不像 + 差异化**:
  - 像:async issue→PR、接 Slack/GitHub —— 核心 primitive 同构。
  - **不一样**:OpenHands **开源给开发者自装自托管**;Flywheel 是给**非技术创始人的托管团队**,不碰服务器、不写 issue、只在 Discord 说话。
  - **借鉴**:**at-cost 零加价**的透明计费 —— 全行业 bill-shock 里的清流,喂我们「可预测/不 surprise」定价叙事。

## 5. 更短:Replit / Factory / Hermes(已在 research.md,补差异点)

- **Replit Agent**:云 IDE + Agent,大白话全流程。**它还是个 IDE**(非技术要进开发环境);我们让非技术只在 Discord 说话。credit bill-shock 最痛。
- **Factory(Droids)**:agent-native 覆盖 SDLC,Slack 触发 + Linear 连接,$1.5B 估值。**卖给企业工程团队**;我们卖给非技术创始人。它的 Slack+Linear 形态跟我们最像,但受众相反。
- **Hermes Agent(Nous)**:开源自托管常驻 daemon,自己写 skill、接 16+ 消息平台、自我改进。**要你会自托管、且是单 agent**;我们替你养一整个团队。它的「自写 skill + 常驻 + 接消息平台」跟我们架构有并行,是形态参照。

---

## 横切:这一层深挖对我们定位的具体启发

1. **「technical cliff」+ lock-in 是自助 builder 的共同天花板**(Lovable 撞墙要雇人、Base44 锁数据出不来)→ 我们最硬的一句对比:**「builder 让你自己建到撞墙;Flywheel 一支团队建到底、还长期养,而且是你自己的真 repo,不锁定。」**
2. **「我们是团队、别人是单 agent」这条已死** —— Devin 能管 Devin、Matrix 有 Departments→Leads→Workers、Factory 一群 Droid。分层多 agent 是**行业标配**,不是差异。**真差异 = 非技术 founder 界面(Discord)+ 产品判断层(Lead)+ 领域(建真软件产品)+ 工程级可信交付。**
3. **Devin 的软肋 = 产品判断/模糊任务** —— 正是「非技术创始人 + Lead 在环」的价值:把模糊方向翻译成明确工程,别「自信地做错」。
4. **计费**:全行业 credit/用量 = bill-shock 痛点;**OpenHands「at-cost 零加价」** 是唯一透明范式 —— 值得学,喂我们「不 surprise 账单」叙事(但 ⚠️ 订阅驱动不独有,Matrix 也有)。
5. **无锁定 = 潜在信任卖点**:非技术最怕「东西建在别人平台、搬不走」。Flywheel 天然建在**用户自己的 GitHub**,这点对 Base44 lock-in 是硬优势,建议写进定位。

---

## 来源(2026-07 WebSearch)

- Lovable:lovable.dev/guides、nocode.mba、muz.li、work-management.org;Plan Mode / eject / technical cliff
- Base44:weavai.app、justinmckelvey.com、vicky.dev、zite.com、capacity.so;lock-in / SPA-SEO / 设计控制
- Devin 2.0:cognition.ai/blog(「manage Devins」「schedule Devins」)、venturebeat.com、analyticsvidhya.com、medium(Takafumi Endo);软肋见 idlen/评测
- OpenHands:openhands.dev/pricing、docs.openhands.dev、openhands.dev/blog、theaiagentindex.com;at-cost 零加价
- Factory / Replit / Hermes:见 research.md / candidate-list.md 来源

---

## round-2 补充(2026-07-07):完全非技术视角 + Paperclip

> Annie round-2:目标客户 = 完全非技术;加 Paperclip;所有轴按非技术重构。Paperclip 独立见 **paperclip-deepdive.md**;这里只补它进逐家矩阵 + 一条非技术视角的横切收敛。

### 6. Paperclip(@dotta)—— 开源免费的「AI 公司」控制平面(详见 paperclip-deepdive.md)
- **定位**:「把你的 agent 组织成一个公司」的控制平面(不是 agent 框架);「你是 CEO,agent 是员工」。
- **目标用户**:会自托管的开发者 / prosumer(**非完全非技术**)。
- **产品形态**:自跑 Node server + React 面板;org chart + ticket + 预算 + 全程 tracing;**BYO agent**;MIT 开源免费自托管。
- **软肋**:自托管门槛(非技术装不起来)+ BYO agent 把质量甩给你 + generic 框架把 PMF 甩给你 + 无托管云。
- **vs Flywheel**:同形态(你指挥的分层 AI 公司)、连起源痛点都同源(管一堆 Claude Code 窗口);但它 **generic + 自托管 + BYO agent**,我们 **concrete + 替你托管 + Runner 已接好 + 面向完全非技术**。它免费开源 = 「AI 公司」壳没护城河的铁证。

### 横切:按「完全非技术能不能自己用」重排(round-2 新分水岭)
| 完全非技术能自己用吗 | 玩家 | 为什么 |
|---|---|---|
| ✅ 能上手(但有天花板) | Lovable / Base44 | 聊天出 app;天花板 = technical cliff（撞墙雇人）/ lock-in（数据搬不走） |
| ⚠️ 勉强 / 要进开发环境 | Replit / Bolt / Matrix | Replit/Bolt 还是 IDE 味;Matrix 要下桌面 app + 跑的是营销生意不是软件 |
| ❌ 面向工程师 | Devin / Factory / v0 | 要把活讲成工程语言 / 要懂 repo / 要点前端基础 |
| ❌ 面向自托管者 | **Paperclip** / Hermes / OpenHands | 要会 Docker/VPS/自托管、要自带 agent、要连 key |
| ✅✅ 完全非技术、在已有 IM 说话 | **🎯 Flywheel** | 不装 server、不搭 org chart、不自带 agent、不进 IDE —— Discord 里跟 Lead 说话 |

**收敛**:round-1 说「我们是团队、别人是单 agent」这条早已死(Devin 管 Devin / Matrix Departments / Factory 一群 Droid / **Paperclip 免费开源**)。round-2 的真差异 = **concrete（你那个具体产品)+ done-for-you（非技术不自托管)+ 可感知信任（一试真能跑、有人养着)**。喂 competitor-scan.md ②③⑤。
