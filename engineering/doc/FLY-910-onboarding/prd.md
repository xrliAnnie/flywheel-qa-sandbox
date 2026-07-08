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
>
> ## 🆕 v3 改(Codex design review R1 fold,2026-07-08)
> Codex 确认**方向可建、MVP scope 正确**,但抓出 PRD 把几项**还没闭合的底座能力写成了已可用契约**。8 条全采纳,核心是**把「MVP-minimum vs 目标」诚实分层 + 底座前置说清 + build 依赖重排**:
> - 新增 **§4.5 Supersedes/Final decisions**(锁定决策覆盖旧文档);
> - 新增 **§6.7 MVP 可建性收敛**(macOS 安置成熟度 / Linear·GitHub OAuth-vs-token / Discord 频道-vs-全结构 / agent CLI provider seam / state seam 统一 / 首个产出 vertical —— 逐条 MVP-minimum·目标·底座前置·决策点);
> - 重排 **§12 build issues**(FLY-648 closeout 前置 + 依赖顺序 + 每个真验收)。

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

## 4.5 Supersedes / Final decisions(本 PRD 为准,覆盖旧文档 · Codex R1#7)
> 上游设计文档留有旧决定(如「砍 GitHub」「agent CLI 默认待定」「Buddy 名待定」),与本 PRD v2/v3 锁定冲突。**以本表为准**;eng 拆 issue 只认本表。

| 决策 | 最终(本 PRD) | 覆盖的旧说法 / 位置 |
|---|---|---|
| GitHub | **接**(基础工具之一,OAuth/安全 token 见 §6.7)| 「砍 GitHub、仓留本地」(provisioning-automation-boundary.md · onboarding-flow-detailed.md 旧段) |
| agent CLI 默认 | **默认 Claude Code、可切 Codex**(vendor-agnostic seam,§6.7)| 「默认待定 / 让用户选」(onboarding-buddy-spec.md 旧「仍开放」) |
| 名称 | **Buddy**(常驻用户面自助;MVP=onboarding)| 「Onboarding Buddy」(全部旧文档) |
| Discord 自动建 | MVP-minimum=**频道 + bot online/post/delete probe**;roles/webhooks/guild_id 预选 = **目标/BI-3 扩展**(§6.7)| 「bot 自动建全套结构(频道/角色/webhook)」当已可用(§7/§8-A 旧措辞)|
| Linear/GitHub 授权 | **目标=OAuth 不贴 token**;**MVP 可 fallback 安全隐藏 token**(现状底座已有)= BI-3 决策点(§6.7)| 「一次 OAuth、不贴 token」当已建 |
| macOS 自动安置 | **MVP-minimum 可为 guided/manual fallback**;全自动 = FLY-648 closeout 前置(§6.7)| 「step7 全自动」当已可用 |

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
- **状态 + 续传**:每步把 onboarding cursor 写进**与 FLY-648 setup journal 共用/桥接的同一个 state schema**(cursor + 已完成步 + 非敏感证据;**绝不存 secret**;确切路径/schema 由 BI-2 定,不另起漂移的第二 state 根,§6.7);中断重跑从 cursor 续。
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

## 6.7 MVP 可建性收敛(Codex R1)—— MVP-minimum vs 目标 · 底座前置 · 决策点

> Codex 抓出:§7/§8 的逐步骤描述的是**目标 UX**,但有几项**当前底座还没闭合**(macOS 自动服务、Linear/GitHub OAuth、Discord roles/webhooks、agent CLI provider 抽象、首个产出 connector)。**下表逐条把「MVP-minimum(现在真能建)」和「目标」分开,并标底座前置/决策点。§7 的步骤读作目标;MVP 验收以本表为准。**

| 能力 | MVP-minimum(首批验收) | 目标(可后续扩) | 底座前置 / 决策点 |
|---|---|---|---|
| **step0 agent CLI provider**(R1#4) | **Claude Code** 作 MVP provider(detect/install/login/smoke/startBuddy/resume) | Codex adapter(注意 CLAUDE.md 生产 Codex = windowed TUI 硬规则) | **BI-1 建 `AgentCliProvider` 合同 seam**;Codex 是同-MVP adapter 还是 post-MVP = 决策点(默认 Claude Code 先落地) |
| **step2 Linear/GitHub 授权**(R1#2) | **Linear**:安全隐藏 token + keychain/0600(现状 FLY-648 wizard 已有,Linear 已用)· **GitHub**:token/OAuth/create-push **尚未实现**(现状 skeleton 只 local git、无 GitHub 建/推)—— 属 BI-3/BI-0 决策(可先 `gh auth` 作 MVP GitHub path) | **OAuth device flow / 不贴 token**(更顺) | **BI-3 决策点**:OAuth vs 安全 token —— 目标 OAuth,MVP 可先安全 token(Linear)/`gh auth`(GitHub);PRD 不把「不贴 token」当已建 |
| **step2 Discord 自动建**(R1#3) | **bot 自动建频道 + online/post/delete probe**(现状 wizard 已建基础频道) | roles/webhooks/分类全套 + `guild_id` 预选 + 幂等 + 403 fallback | **BI-3 扩 permission 整数(加 Manage Roles/Webhooks)+ 幂等建 + 测试矩阵**;首批可只频道 |
| **step7 自动安置(macOS)**(R1#1) | **可为 guided/manual fallback**(现状 Darwin 是 operator-run launchd);**Linux/systemd 若更成熟可先全自动** | macOS clean-host 全自动 bring-up | **FLY-648 closeout 前置**:manifest 生成 → plist install/bootstrap → Bridge reload → bot online → Captain ping 的真实验收 |
| **state/secret seam**(R1#5) | **与 FLY-648 setup journal 共用/桥接一个 state schema**(cursor + 非密证据 + 脱敏);不另起漂移的第二 state 根 | — | **BI-2/BI-7 共用 state contract**;验收加 **secret-scan**(任何 token 不得出现在 state/logs/prompt transcript/support summary) |
| **首个真产出 vertical**(R1#6) | **选一个 beachhead vertical = dropship 订单**(订单系统 + 邮箱/确认邮件,只读)+ **fixture/demo fallback** + 无连接器诚实路径 | 更多 vertical(广告/CRM/文案…) | **BI-4/BI-6 交付一条可验收的 first-output path**,不只是「connector seam」;北极星 = 拿到第一个真产出,没真 vertical 会变空壳 |

> **一句话**:MVP 先把 **Claude Code provider + 安全 token(或 OAuth)+ Discord 频道自动建 + 一个真 dropship 订单 vertical(带 fixture fallback)+ 共用 state/secret contract** 做通;macOS 全自动安置、Discord roles/webhooks、OAuth、Codex adapter、更多 vertical 是**目标/后续**,不阻塞首批「拿到第一个真产出」。

## 7. 详细需求 —— 逐步骤(step 0–8),eng 照着能建

> 每步给:**目标 · 客户看到的确切文案 · 交互 · 系统动作(命令/调用/[AUTO])· 校验 · 失败分支(原话+恢复)· 续传 · 验收标准**。真话术样例见 onboarding-buddy-spec.md,可直接当模板。
> **⚠️ 以下步骤描述目标 UX;每项的「MVP-minimum vs 目标 / 底座前置」以 §6.7 为准**(step0 provider seam / step2 授权 token-vs-OAuth + Discord 频道-vs-全结构 / step7 macOS 成熟度 / step6-8 首个 vertical)。

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

## 12. 交给 eng 的 build issues(最终清单 · 收敛后由 Lead 挂 Tadashi 队列)
> 每个链回本 PRD 段 + FLY-648 底座;**本 issue 不派 eng-build runner**,建单/路由由 Lead 在 PRD 收敛后做。
> **依赖顺序(Codex R1#8 重排)**:`BI-0 底座前置` → `BI-1 bootstrap+provider` →(`BI-2 状态机` ∥ `BI-7 转人工`,共用 state contract)→ `BI-3 基础工具` → `BI-5 安置` → `BI-4+BI-6 vertical+首产出` → `BI-8 素材`。BI-1/3/5 依赖 BI-0,不能盲并发。

- **BI-0 · FLY-648 底座 closeout** —— **拆两档,别把 target-only 的东西当 MVP 硬阻塞(Codex R2#1)**
  - **(a) MVP 硬前置(真阻塞 BI-1/3/5)**:① `AgentCliProvider` seam 落位(BI-1 要)· ② Linear/GitHub 授权方式**定案**(OAuth or 安全 token / `gh auth`;BI-3 要)· ③ 与 setup journal 共用/桥接的 **state schema 定案**(BI-2 要)· ④ macOS 安置**至少有 guided/manual 可跑通**(BI-5 要,全自动见下 b)。
  - **(b) target closeout / follow-up(不阻塞 MVP,后续)**:macOS clean-host **全自动** bring-up(manifest→plist install/bootstrap→Bridge reload,真验收)· Discord **roles/webhooks** 权限扩 + 幂等建 · OAuth(若 MVP 走安全 token)· Codex adapter。
  - 验收:(a) 每项定案 + 可跑(自动或明确 guided/manual 且 UX 标注);(b) 有单独 follow-up issue,不进首批 MVP 验收。
  - 依赖:FLY-648。挂:Tadashi(底座)。

1. **BI-1 · 一条 command bootstrap + agent CLI 地基(step 0)+ AgentCliProvider seam**
  - 范围:装 Flywheel onboard 层 + `AgentCliProvider`(detect/install/login/smoke/startBuddy/resume/repair)· **MVP provider = Claude Code**(登录用户订阅,不收 key)· 在其上起 Buddy。**Codex adapter = 决策点**(同-MVP or post-MVP;守 CLAUDE.md windowed-TUI 硬规则)。
  - 验收:非技术用户粘一条命令 + 一次浏览器登录 → 得到已登录 Claude Code + 在其上运行的 Buddy;无 key 明文;provider seam 有 Codex 占位。
  - 依赖:BI-0(provider seam)。§7 step0 · §6.7。挂:Tadashi。

2. **BI-2 · Buddy agent 本体**(∥ BI-7,共用 state contract)
  - 范围:operating loop + 话术层(system prompt/模板,温暖同事基调)+ **state 续传(与 FLY-648 setup journal 共用/桥接一个 schema,§6.7)** + 决策引擎(描述→Team / 推断接哪些系统 / 何时升级)。
  - 验收:中断重跑从 cursor 续;**secret-scan 通过**(任何 token 不入 state/logs/prompt transcript)。
  - 依赖:BI-1。§6 · §6.7 · §7。挂:Tadashi。

3. **BI-3 · 基础工具接入**(按 BI-0 授权方式定案实现)
  - 范围:**Discord**(MVP:高权限邀请 + bot 自动建**频道** + online/post/delete probe;**目标扩**:roles/webhooks/guild_id 预选 + 幂等 + 403 fallback)· **Linear**(OAuth 或安全 token,按 §6.7 决策)+ provision team/labels · **GitHub**(OAuth 或安全 token)+ 建/绑仓。
  - 验收:三样各自一次授权即接好 + 校验;token keychain/0600;可续传/重试。
  - 依赖:BI-0(权限/授权定案)、BI-1。§7 step2 · §8-A · §6.7。挂:Tadashi。

4. **BI-4 · 业务系统连接器 + JIT 接入**(与 BI-6 合成首个 vertical)
  - 范围:MCP/连接器 seam · 推断最少必需集 · OAuth/隐藏 key · 最小**只读**探测 · 只读 scope · 无连接器诚实路径。
  - 验收:**首个 beachhead vertical = dropship 订单(订单系统 + 邮箱/确认邮件)只读接入通**。**⚠️ fixture/demo fallback 只算 QA/demo/进度兜底(连接器缺失时诚实路径),不算生产 North Star 的「成功」**(Codex R2#4)—— 生产成功 = 从客户**真实系统**出第一个真产出。
  - 依赖:BI-1、BI-2。§7 step6 · §8-B · §6.7。挂:Tadashi(FLY-648 连接器)。

5. **BI-5 · 自动安置**(建立真实 health-check)
  - 范围:脚手架 + 推 GitHub 仓 + projects.json + manifest + OS-portable 常驻服务 + health-check(bot online + Captain ping)。**macOS 成熟度按 §6.7:MVP 可 guided/manual、全自动依赖 BI-0。**
  - 验收:health-check 全绿;每子步幂等可续传;客户只看干净进度。
  - 依赖:BI-0、BI-3。§7 step7 · §6.7。挂:Tadashi。

6. **BI-6 · 早聊一句 + 第一个真产出编排**(与 BI-4 合成首个 vertical)
  - 范围:最小可对话 Captain(welcome-first)+ 首件事预置/开口 → 跨源查 → **一条可信结果 + 下一步选项**(dropship 订单诊断样例)。
  - 验收:**≤60s 拿到第一个真产出**(dropship vertical);需未接系统时诚实回接入、不假装。
  - 依赖:BI-4。§7 step5/step8 · §6.7。挂:Tadashi。

7. **BI-7 · 卡住/worst-case 转人工支持通道**(∥ BI-2,共用 state contract)
  - 范围:升级阶梯 + **脱敏**上下文摘要 + `escalated` 终态可被人工接手 + 人工支持投递面。
  - 验收:任一步失败 2 次可转人工;摘要脱敏(secret-scan);人工可接手续跑。
  - 依赖:BI-2。§6 · §11。挂:Tadashi。

8. **BI-8 · Discord 4 步截图/短视频素材**。依赖:BI-3。§8-A 附录。挂:Tadashi(或内容)。

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
