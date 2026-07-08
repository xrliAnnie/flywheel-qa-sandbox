# FLY-910 非工程快速 onboarding — PRD(Buddy)

Issue: FLY-910 (https://linear.app/geoforge3d/issue/FLY-910/非工程快速-onboarding-体验设计一条-command-上手后体验)
日期: 2026-07-08(v2,折入 Annie PRD 反馈)
基于: `product/doc/FLY-910-non-eng-onboarding/` 全套设计(onboarding-buddy-spec.md v3 · onboarding-flow-detailed.md · discord-permission-research.md · provisioning-automation-boundary.md · tactical-options.md · deployment-decision-and-mvp-scope.md · monetization-privacy-strategy.md · competitor-onboarding-research.md)+ Annie 逐块/逐小节共创收敛(2026-07-08 全过)· 定位见 FLY-911 · 底座 FLY-648

> **这份 PRD = eng-buildable**:每块写清 UX / 交互 / 命令 / 调用 / 系统动作 / 文案 / 边界 / 验收,eng 照着能建、不用再回来掰细节。中文 body,English where natural。
> **状态**:设计已与 Annie 逐小节收敛定稿;本 PRD 待 Annie/Lead review → 收敛后拆 build issues 挂 Tadashi eng 队列(**本 issue 不派 eng-build runner**)。**PRD 是 docs,不 ship build。**
>
> ## 🆕 v2 改(Annie PRD 反馈,2026-07-08)
> 1. **agent CLI 默认 = Claude Code、可切 Codex**(open-q1 定了;step0 vendor-agnostic 地基支持切换)。
> 2. **改名 + reframe**:「Onboarding Buddy」→ **「Buddy」**(去 onboarding 前缀)。Buddy 不只 onboarding 时在,是一个**常驻的用户面自助助手**(有问题帮修、想开新 team 帮开、日常自助)。**但守 scope:本 PRD 的 MVP 仍 = onboarding(step 0–8);常驻 = 愿景 / phase-2**(见 §6.5),**不塞进 MVP build**。
> 3. 新增 §6.5 愿景+分期 · §6.6 边界(Buddy vs FLY-915/942 infra 告警 bot)。

---

## 1. 问题(Problem)

现在**没有面向非技术用户的 onboarding**。唯一的「一条 command」(`scripts/setup-new-project.sh`)只做工程师视角的文件系统脚手架,真正花一天的活全压在 founder 手动完成的 **10 步工程/运维 cutover**(建 GitHub 仓、Linear routing、建 Discord bot 塞 token、手改 live `projects.json`、跑 `claude-lead.sh` 生成 manifest、装 launchd、重启 Bridge、接 deploy hook…)。→ 非技术小企业面对的不是「一条 command」,而是一张 10 步工程清单:**手动搞一天 + 强耦合工程**。

## 2. 目标用户(Users)

- **第一版(MVP)= 甲**:时间紧、**有技术直觉但非程序员**的经营者(自己做电商 / social 的一人公司 operator)。能接受终端一条 command、能跟着截图在 Developer Portal 点几下;但不是工程师、拼不出整套。
- **部署 = 纯自托管(B)**:跑在客户自己机器上。**已知取舍**:要一台 7×24 常开机器 = 会挡掉纯非技术小白;MVP 用它换 ship 速度,**managed(V2)**再把非技术那群接回来(done-for-you)。
- **愿景(later)= 更广非技术小生意主**(FLY-911);managed V2 兑现。

## 3. 目标 / 非目标(Goals / Non-goals)

**Goals**
- G1 一条命令起步 → **Buddy(自助 agent)**一步步带,把非技术新人从「刚拿到 access」带到「**手里有一个真能跑的 system**」。
- G2 全程非技术视角:**看得懂、不用懂工程**;绝不出现工程黑话。
- G3 **第一个真产出**:onboarding 完成的标志不是「装好了」,是客户拿到**第一个「它真帮到我了」的结果**(≤60s)。
- G4 交付一份 eng 照着能建的设计 → 拆 build issues 交 eng。

**Non-goals(本 issue 明确不做)**
- managed 云托管(= V2,单独设计)· 收费(= placeholder,待 WorkBuddy/homerail 竞品分析)· eng 实现本身(交 Tadashi)· PM 验收(FLY-830)。
- 不越过 FLY-911 定位;不为某 agent 厂商写死(vendor-agnostic)。

## 4. 定位锚 + MVP scope(已锁)

| 维度 | MVP(现在) | V2(later) |
|---|---|---|
| 部署 | 纯自托管(甲、上线快) | managed(替你托管,接非技术那群) |
| 客户 | 半技术 operator(甲) | 更广非技术小生意主 |
| 收费 | 不做,免费全试(创始人自用起步) | license-key 按 Team 等(待竞品分析) |
| done-for-you | 部分(引导 + 自动) | 完整兑现 |

## 5. 体验标准(非技术视角红线 · 全程铁律)

1. **绝不露工程黑话**:Lead/Runner/Department/manifest/launchd/Bridge/projects.json/repo/token 一律不对客户露。对客户只说:**向导(Buddy)/ 你的 Team(里有 Captain + Crew)/ 后台清单 / 安置**。
2. **secret 只走 CLI 隐藏输入或 OAuth 登录** → OS keychain 或 600 文件;**绝不进对话 / 日志 / state.json / git**。
3. **一次一件事 · 校验过才前进 · 失败给具体原因(不是「出错了」)· 可续传 · worst-case 一键转人工支持。**
4. **用词(对外皮)= Captain(=内部 Lead)/ Crew(=内部 Runner)/ Team(=内部 Department)**;内部代码不改写。
5. **vendor-agnostic**:agent CLI 可以是 Claude Code / Codex / 任一,不写死。

## 6. Buddy(核心)—— 运作模型

- **是什么**:一个**跑在 agent CLI 上**的自助对话 agent。用户跑完命令、装好 agent CLI 后面对的就是它。
- **persona**:耐心、热情、**像同事**(参照 Metric 那种成熟自助引导 agent)。先给「有搭档陪我」的感觉,再谈正事。**绝不端着。**
- **operating loop(每步都跑)**:说人话(warm,一次一件)→ 要用户做的给到「点这→点这→贴回来」级 → 能自动的后台悄悄做 → 当场校验 → 成则落 state 进下一步 / 不成给具体报错+恢复 → 卡住转人工。
- **状态 + 续传**:每步写 `~/.flywheel-onboarding/state.json`(cursor + 已完成步 + 非敏感 config;**绝不存 secret**);中断重跑从 cursor 续。
- **决策引擎(自适应核心)**:① 用户描述 → Team 结构(从描述长出、不预设行业)· ② 「第一件事」→ 推断接哪些业务系统(只接最少必需集)· ③ 何时升级(同一步失败 2 次 / 用户连说「不懂」→ 转人工)。
- **跟 Anna 的边界**:**Anna = Sales**(只在用户进门前;顶多把 context 传给 Buddy 当开场底料);进来后跟 Buddy 搭、跟 Anna 无关;**卡住转人工支持,不是 Anna**。

## 6.5 愿景:Buddy 常驻(phase-2)+ 分期(Annie v2 reframe)

Annie 的 reframe:**Buddy 不只 onboarding 时在,而是一个常驻的用户面自助助手**(像用户身边一直在的一个搭档)—— 上手之后:**有问题帮你修、想开新 team 帮你开、日常自助**。

**但守 scope(每加一样说清砍哪)**:
| 阶段 | Buddy 做什么 | 状态 |
|---|---|---|
| **MVP(本 PRD,现在建)** | **onboarding(step 0–8)**:把非技术新人从「刚拿到 access」带到「有一个能跑的 system + 第一个真产出」 | ✅ 本 PRD 全部需求 |
| **phase-2(愿景,MVP 不做)** | **常驻自助**:① 想再开一个新 team → Buddy 引导开(复用 onboarding 的 Team/工具接入机制)· ② 系统/某个接入出问题 → Buddy 帮你自助修(诊断 + 引导重连/修复)· ③ 日常「我想让团队多做件 X」的自助引导 | 🔭 方向,**不进 MVP build** |

**分期红线**:MVP build **只做 onboarding(step 0–8)**;上面 phase-2 三样(开新 team / 自助修 / 日常自助)**先不建** —— 现在只把架构留出可扩位(Buddy 是常驻 agent 形态、不是一次性 onboarding 脚本),真做常驻功能是 phase-2 单独 PRD。**每加一样都要说清砍哪:MVP 砍掉常驻三样、只保 onboarding,换 ship 速度。**

## 6.6 边界:Buddy vs infra 告警 bot(FLY-915/942)—— 两个角色别混

| | **Buddy(本 issue)** | **infra 告警 bot(FLY-915 / FLY-942)** |
|---|---|---|
| 面向 | **用户(客户自己)** | **系统运维 / founder** |
| 干啥 | 用户面**自助**:onboarding +(phase-2)开 team / 修问题 / 日常引导 | **系统健康检测 + 告警**(watchdog:卡住/异常/告警上报) |
| 触发 | 用户来找它 / 它在 onboarding 里主动带 | 系统状态变化自动触发 |
| 关系 | 客户体验层 | 平台可靠性层 |

**别混**:Buddy 是「客户身边的自助搭档」,不是「监控系统健康的看门狗」;FLY-915/942 那套告警/watchdog 是平台侧、面向运维,**不归 Buddy**。两者可互补(Buddy 帮用户自助修的某些问题,信号可能来自 infra 层),但**角色、面向的人、触发方式都不同,设计/build 分开**。

## 7. 详细需求 —— 逐步骤(step 0–8),eng 照着能建

> 每步给:**目标 · 客户看到的确切文案 · 交互 · 系统动作(命令/调用/[AUTO])· 校验 · 失败分支(原话+恢复)· 续传 · 验收标准**。真话术样例见 onboarding-buddy-spec.md,可直接当模板。

### 步骤 0 · 地基:装一个 agent CLI(vendor-agnostic)+ 登录 —— Buddy 跑在它上面
- **目标**:把底座(agent CLI)弄好,并在其上启动 Buddy。**没它 Buddy 起不来**——所以是最前面的地基。
- **谁做**:那条 command 的**引导安装脚本**(此刻 Buddy 还没起);装好+登录后 Buddy 在 CLI 上启动、接管后续。
- **客户看到**:`正在准备… 检查环境 ✓  装好你的 agent 工具 ✓  让你登录一下…` +「先装一个 agent 工具(它是你这套东西的底座)。装好了,现在浏览器里登录你自己的账号、点同意 —— 用你自己的订阅,不用弄任何密钥。」
- **交互**:粘 command(触发)+ 浏览器 OAuth 登录用户自己账号/订阅。
- **系统动作**:检测 Node≥20 / git(缺则 [AUTO] 装或问)→ 全局装 Flywheel onboard 层 → **[AUTO] 装 agent CLI:默认 Claude Code、可切 Codex(vendor-agnostic 地基,Annie v2 定;架构保持可切换、不写死)** → 引导登录命令 → 浏览器 OAuth 登录用户自己账号/订阅 → 校验能起最小会话 → **在该 CLI 上启动 Buddy**。**不收 API/Cloud key。**
- **校验**:agent CLI 能起一个最小会话 + Buddy 在其上启动。
- **失败分支**:没装成→手动安装链接+「装好回来说声」;登录没弹浏览器→可复制登录 URL;失败 2 次→转人工。
- **续传**:装/登录态由 CLI 自管,不落 state 明文;重跑跳过已装。
- **验收**:非技术用户跑一条命令 + 浏览器点一次登录,即得到一个已登录、能起会话的 agent CLI + 一个在其上运行、开始说话的 Buddy;全程无 key 明文、无工程黑话。

### 步骤 1 · Welcome(colleague 感;先不派活)
- **目标**:第一印象 = 关系(有个搭档陪我),不是派活。
- **客户看到**(温暖、≤5 短行,不马上说要干嘛):「嗨,我是你的搭档 —— 往后帮你把这套东西搭起来、有事招呼我就行 😊 先不急着干活,就想说声:**欢迎入伙**…(顺带交底:现在**完全免费**随便试;你的东西**全在你自己电脑上**、不往我们这传;**电脑开着它们才在岗**,像同事上班一样。)」
- **系统动作**:纯欢迎;有 Anna context 则带一句「Anna 说你在做 ⟨用户的事⟩」——**仍先 welcome、不立刻派活**。
- **验收**:第一屏读起来像一个耐心的同事在打招呼,不是系统提示音;不含任何「接下来第 1 步做 X」的派活口吻。

### 步骤 2 · 搭其余基础工具(setup-first;task-independent)= Discord + Linear + GitHub
> 底座(CLI)已在 step 0。这里搭**每个用户都要、跟他具体做啥无关**的地基,一件件带;**搭完才问要做什么**(setup-first,Annie 定)。

**2a · 建你自己的 Discord(简化;bot 自动建结构)** — 详见 §8-A
- **目标**:用户在 Discord 里有个能跟团队干活的地方。
- **交互/客户做(只 4 件平台锁死的)**:① 建一个自己的 server ② Developer Portal 建 bot + Copy token(贴进隐藏输入)③ 开 Message Content + Server Members 两个 intent ④ 点我们生成的高权限邀请链接。
- **系统动作**:token→安全存储 → 连 Gateway 校验 → 生成 **OAuth2 高权限邀请链接**(`scope=bot` + 权限整数含 Manage Channels/Roles/Webhooks/发消息 + `guild_id=用户server` 预选)→ 轮询 bot 入群 → **bot [AUTO] 自动建好所有频道/分类/角色/webhook 全套结构**。
- **验收**:用户只做那 4 下,其余(频道/角色/webhook)bot 全自动建好;每步失败给精确到哪步/哪开关的具体报错;worst-case 转人工连屏。

**2b · 接后台清单(Linear)**
- **客户看到**:「一个**后台小本子**,团队记『要做啥、做到哪』——你平时根本不用打开。点一下授权就行,不贴密钥。」
- **系统动作**:OAuth device flow → [AUTO] 建后台 team + 路由标签(无感)→ token 安全存储。
- **验收**:一次浏览器授权即接好;客户全程不见 Linear 界面。

**2c · 接 GitHub(基础工具之一 · Annie v4 定=接)**
- **客户看到**:「再接一下 **GitHub** —— 你团队做的东西(代码/产物)存这儿,安全、有版本、搬得走。点一下授权就行。」
- **系统动作**:GitHub OAuth(device flow,不贴 token)→ [AUTO] 建/绑一个仓给这个 Team → token 安全存储。
- **失败分支**:没账号→注册链接+「弄好说声」;拒绝→「不接的话产物没地方安全存,重点一下?」
- **验收**:一次授权即绑好仓;产物有版本、可搬走。

### 步骤 3 · 问你先想搞定哪件事(setup 完才问)
- **目标**:地基齐了才问,不提前(setup-first)。
- **客户看到**:「你最想让这个小团队**先帮你搞定哪件事**?大白话说,你今天正手动盯着、还挺烦的那种事最好。」
- **系统动作**:[AUTO] 解析描述 → {意图/建议角色/活范围}。
- **失败分支**:太空(「帮我赚钱」)→ 追问一次要具体场景,最多 2 次 → 给 3 个例子选(不硬编死)。
- **验收**:能从一句大白话产出一个可执行的「第一件事」+ 一个 Team 提议;太空描述有优雅兜底。

### 步骤 4 · 提议 + 确认 Team
- **客户看到**(下例订单):「先给你搭个「**订单盯梢**」小组:一个 **Captain** 帮你把关,一个 **Crew** 去各系统查『这单为什么卡』。名字随你改。成吗?(成 / 改改)」
- **系统动作**:[AUTO] 落项目 config(Team 名 + 角色 + 活范围;FLY-648 核心/项目分离)。暂不起服务。
- **失败分支**:一上来贪多 → 「先把这一个跑通,回头 Discord 里跟 Captain 说声就能加」。
- **验收**:Team 名/角色/范围全**按步骤 3 变**(用例自适应);config 幂等可改。

### 步骤 5 · 早聊一句(welcome-first;先像同事打招呼,不马上派活)
- **目标**:最快给「有个活的**同事**在回我」的时刻(time-to-first-message 最短)。
- **系统动作**:[AUTO] 起一个**最小可对话的 Captain**(够 Discord 回话即可)。
- **客户看到**:「你的 **Captain 已经上线了**!去 Discord 跟它打个招呼吧,随便说句『在吗』。先认识一下,别的等下再说。」
- **Captain 话术(welcome-first;提正事按用户用例、不硬塞订单)**:「在的 👋 我是你的 Captain,以后就是我陪你把活儿盯下来。终于见面了~ 你先随便跟我聊两句都行。等把该接的东西接上,我就能真去帮你干活了。」(※ 已知用例则把「帮你干活」换成贴用户那件事的话,**不硬塞订单**。)
- **失败分支**:用户不想聊→直接继续不阻塞;Captain 没上线→报错+重试 1 次→仍不行转人工。
- **验收**:Captain 第一句是暖场问好(不是派活 / 不写死订单例子);用户不聊也能继续。

### 步骤 6 · 接第一件事要用的业务系统(JIT · use-case adaptive)— 详见 §8-B
- **目标**:让 Crew 能读客户业务系统,**只接这件事需要的**(不前置连全部),一次一个。
- **系统动作**:[AUTO] 从步骤 3 推断需要的系统 → 最少必需集 → 一次一个引导接入。
- **交互**:有 OAuth 的(Shopify)浏览器点一下不贴 key;只有 key 的(Veeqo/Ordoro)隐藏输入贴 + 引导去哪拿 key。每接一个发**最小只读探测**校验。
- **权限最小化**:onboarding 只申请**只读**;写/改留运行期 [GATE] 客户批准。
- **失败分支**:权限不够→精确指去勾哪 scope;key 错→去重生成只读的;没连接器→诚实「先记下让工程看能不能加,先用能接的做」**不假装**;worst-case 2 次→转人工。
- **验收**:只接第一件事要的 1–2 个;每个当场只读探测通过;没连接器诚实告知不假装。

### 步骤 7 · 自动安置([AUTO])
- **客户看到**:「都齐了,我把团队正式安顿一下 —— ✓ 建工作区　✓ 配好 Captain 和 Crew　✓ 让它们常驻上岗　✓ 上线自检　搞定 🎉」
- **系统动作([AUTO])**:脚手架工作区 → **推到 GitHub 仓**(GitHub 已接)→ 写 projects.json → 生成/校验 manifest → 装 **OS-portable 常驻服务**(macOS launchd / Linux systemd / WSL2,FLY-648)→ 起 Bridge → 健康检查(bot 在线 + Captain 响应)。
- **失败分支**:某子步失败→具体报错+重试 1 次→仍失败「安置卡在『⟨步骤⟩』了,我帮你转个人工看一下」→转人工(不甩栈信息)。
- **验收**:health-check 全绿(bot online + Captain 能响应一条内部 ping);每子步幂等可续传;客户只看到干净进度、不见 JSON/栈信息。

### 步骤 8 · 第一个真产出(它真帮你干成一件事)
- **客户看到 + 样例(订单,只当样例)**:客户「看看我今天有没有卡住的单」→ **Captain**「让 Crew 去查,几十秒」→ **Crew**(~40s)「今天 26 单,**1 单要注意**:#1234 显示 pending 但**不是丢单**——供应商已发货、确认邮件没读到才没更新。要我盯着到了自动更新吗?」
- **为什么是 Aha**:真替客户干了一件平时要跨几个系统才能还原的事,给「为什么」的**可信答案**,主动点出静默失败盲区。价值=看清风险的**结果**,不是 dashboard。
- **失败分支**:第一件事需要一个还没接的系统→诚实回到步骤 6 单工具引导,接好再出结果,**绝不假装有答案**。
- **验收**:首个结果 **≤60s**;是一个**可信的结果/答案 + 下一步选项**,不是一个静态 dashboard;跨源还原成立。

## 8. 深挖子流程

### §8-A · 建你自己的 Discord(据 discord-permission-research.md)
**Discord 平台边界(核实)**:bot **不能干净地建归用户所有的 server**(`POST /guilds` 仅限 bot 在 <10 guild 且建出来归 bot 所有)· bot **不能建自己**(建 application/token 只能 Developer Portal,无 API)· 开 intents 只能 Portal · **但 bot 进群后带高权限能程序化建频道/角色/webhook**。
→ **用户手动最小集 = 4 件**(建 server / 建 bot 拿 token / 开 2 intent / 点高权限邀请);**其余全套结构 bot [AUTO] 建**。逐微步话术 + 截图/短视频脚本见 onboarding-buddy-spec.md §2 + 附录。想连这 4 步都免 = 「共享 bot 池」= **理想/大概率做不成**(平台控不了),当探索项、非第一版承诺。

### §8-B · 接第一个真实任务(use-case adaptive)
Buddy 从「第一件事」推断要接哪些系统 → 一次一个 → OAuth 优先(不贴 key)/ 否则隐藏输入 → 最小只读探测校验。**用例自适应表**:

| 第一件事 | 自动接 | 第一个产出 |
|---|---|---|
| 盯 dropship 订单 | 订单/库存(Shopify/Veeqo) | 「#1234 卡了,不是丢单,是确认邮件没读到」 |
| 对广告花费和成交 | 广告后台 + 订单 | 「今天花 800、成交 12 单,ROI 1.8,比昨天低」 |
| 先回客户询价 | 邮箱/CRM + 价目表 | 「3 个客户在等报价,草稿拟好了,你看发不发」 |
| 上新品写文案 | 商品库/图床 | 「这款三版标题 + 卖点,你选一个」 |

## 9. 用例自适应(总纲)
同一条流程对每种「第一件事」都成立,**变的只有三处**、都从**步骤 3 那句大白话**长出:① Team 名+角色(步骤 4)② 接哪些业务系统(步骤 6)③ 第一个产出形态(步骤 8)。**step 0 底座 / welcome / 基础工具(Discord/Linear/GitHub)/ 建 Discord / 安置与用例无关,恒定。** 订单只是一个跑通样例。

## 10. 成功指标(North Star)
- **北极星 = time-to-first-useful-output**:从「粘命令」到「拿到第一个真产出」的时间(目标:首个结果 ≤60s;整个 onboarding 理想「一个 session 内」)。**成功 = 客户拿到第一个成品,不是「环境 ready」。**
- 次级:onboarding **完成率** · 卡点**转人工率**(越低越顺)· 早聊一句到达率(time-to-first-message)· 首周留存。

## 11. 安全 / non-negotiables
- 所有 secret(agent CLI 登录态 / Discord token / Linear/GitHub token / 业务系统 key)→ keychain 或 600;**不进 state.json / git / 日志 / 对话**。
- onboarding 阶段业务系统只申请**只读** scope;写/改动作走**运行期 founder-gated [GATE]**(FLY-175,自托管下 founder=客户本人)。
- merge / ship / runner-lifecycle 永远 founder-gated。
- 转人工的上下文摘要**脱敏**(不含 secret);永不把栈信息/黑话甩客户。
- 外部输入(用户描述、贴入的 key/token)在边界校验;失败路径显式处理。

## 12. 交给 eng 的 build issues(建议拆分 · 收敛后由 Lead 挂 Tadashi 队列)
> 每个链回本 PRD 段 + FLY-648 底座;**本 issue 不派 eng-build runner**,拆分/建单在 PRD 收敛后进行。

1. **BI-1 · 一条 command bootstrap + agent CLI 地基(step 0)**:装 Flywheel onboard 层 + vendor-agnostic 检测/装 agent CLI(Claude Code/Codex/…)+ 引导登录 + 在其上起 Buddy。(§7 step0;FLY-648)
2. **BI-2 · Buddy agent 本体**:operating loop + 话术层(system prompt/模板,温暖同事基调)+ state 续传(onboarding-state.json)+ 决策引擎(描述→Team / 推断接哪些系统 / 何时升级)。(§6·§7)
3. **BI-3 · 基础工具接入**:Discord(高权限 bot + 自动建结构 + 4 步引导 + 校验)· Linear OAuth+provision · GitHub OAuth+建/绑仓。(§7 step2 · §8-A)
4. **BI-4 · 业务系统连接器 + JIT 接入**:MCP/连接器 seam · 推断最少必需集 · OAuth/隐藏 key · 最小只读探测 · 只读 scope。(§7 step6 · §8-B;FLY-648)
5. **BI-5 · 自动安置**:脚手架 + 推 GitHub 仓 + projects.json + manifest + OS-portable 常驻服务 + health-check。(§7 step7;FLY-648)
6. **BI-6 · 早聊一句 + 第一个产出编排**:最小可对话 Captain(welcome-first)+ 首件事预置/开口 → 跨源查 → 结果+下一步。(§7 step5/step8)
7. **BI-7 · 卡住/worst-case 转人工支持通道**:升级阶梯 + 脱敏上下文摘要 + `escalated` 终态可被人工接手。(§6·§11)
8. **BI-8 · Discord 4 步截图/短视频素材**。(§8-A 附录)

## 13. Open questions(不自己填,待 Annie/后续)
> **已定(v2)**:~~agent CLI 默认~~→ 默认 Claude Code、可切 Codex(§7 step0)· ~~Buddy 正式名~~→「Buddy」。
1. **一条 command 具体形态**(`curl … | sh` vs `npx @flywheel/onboard`)。
2. **收费** = placeholder,待 **WorkBuddy / homerail 竞品分析**完再深化(块4)。
3. **「Draft」竞品**待 Annie 给链接/截图(补 competitor-onboarding-research.md)。

## 14. 引用
- 设计全套:`product/doc/FLY-910-non-eng-onboarding/`(权威可建 spec = onboarding-buddy-spec.md v3)。
- 定位:FLY-911(`product/doc/FLY-911-product-positioning/positioning.md`)。
- 底座:FLY-648(核心/项目分离 + OS-portable provisioning)。
- 运行期 founder-gated:FLY-175。
- PM 验收(未来,不在本 issue):FLY-830。
