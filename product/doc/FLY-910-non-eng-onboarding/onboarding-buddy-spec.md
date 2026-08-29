# FLY-910 Onboarding Buddy — 可建的详细交互 spec(Tadashi 照着能建)

Issue: FLY-910 (https://linear.app/geoforge3d/issue/FLY-910/非工程快速-onboarding-体验设计一条-command-上手后体验)
日期: 2026-07-08(v3,织入 Annie v4 复审:CLI=地基/step0 + vendor-agnostic · GitHub=接)
基于: onboarding-flow-detailed.md(屏级概览)· tactical-options.md(Annie 逐块决定)· discord-permission-research.md · provisioning-automation-boundary.md

> **这是 Annie 要的核心**:把 Onboarding Buddy 从「一个概念」做成 **Tadashi 照着能建的详细交互 spec** —— 真流程 + 真话术 + 真 action。
> **参照**:Metric 那种成熟自助引导 agent —— 温暖、有耐心、像同事,把一个**非技术新人**从「刚拿到 access」带到「**手里有一个真能跑的 system**」,全程不用懂工程词。

> **⭐ 更名 + reframe(Annie PRD 反馈,2026-07-08)**:「Onboarding Buddy」现更名为 **「Buddy」**(去 onboarding 前缀)—— 它是一个**常驻的用户面自助助手**(onboarding 只是它的第一件事;上手后还能帮开新 team / 帮修问题 / 日常自助)。**但 MVP scope 不变 = onboarding(本文 step 0–8);常驻 = phase-2 愿景,不进 MVP build。** 权威分期 + 边界(vs FLY-915/942 infra 告警 bot)见 `engineering/doc/FLY-910-onboarding/prd.md` §6.5 / §6.6。本文以下沿用「Onboarding Buddy / Buddy」指同一个 agent。

> ## 🆕 决定演进(逐版织入)
> - **v2(Annie 逐块)**:客户=甲(半技术)· 部署=自托管 MVP(managed=V2)· 用词 Captain/Crew/Team · 收费=placeholder(免费全试,待竞品分析)。
> - **v2.1(Annie v3 复审)**:setup-first(先搭基础工具再问做什么)· welcome-first(第一句暖场不派活)· 建 Discord 简化。
> - **v3(Annie v4 复审)**:
>   1. **agent CLI = 地基 / 第一步(step 0),vendor-agnostic** —— 装一个 agent CLI(**Claude Code / Codex / 任一**,不写死)是最前面的地基,因为 **Onboarding Buddy 本身就跑在这个 CLI 上**;没 CLI 就没 buddy、也没东西给用户用。(取代原「接大脑=贴 key」,更早、更根本、不锁厂商。)
>   2. **GitHub = 接**(基础工具之一,跟 CLI / Discord / Linear 并列)—— 推翻早前「砍 GitHub」。

---

## 0. Onboarding Buddy 是什么(运作模型)

### 0.1 定位 + persona
- **是什么**:一个**跑在 agent CLI 上**的自助对话 agent。用户跑完那条命令、装好 agent CLI 之后,面对的就是它。
- **persona**:**耐心、热情、像同事**,先让你觉得「有个搭档陪我」,再谈正事。大白话带温度,**绝不端着**。
- **不是谁**:不是 Anna(Anna=Sales,只在进门前);不是工程报错器。是**你的搭档**。

### 0.2 operating loop(每步都跑)
```
1. 说人话(warm,一次一件)   2. 要用户做的:给到「点这→点这→贴回来」级别
3. 能自动的:后台悄悄做       4. 当场校验   5. 成→落 state 进下一步;不成→具体报错+恢复
6. 卡住(失败2次/明显懵)→ 转人工支持
```

### 0.3 状态 + 续传
每完成一步写 `~/.flywheel-onboarding/state.json`(cursor + 已完成步 + 非敏感 config;**绝不存 secret**);中断重跑从 cursor 续,开口先「欢迎回来,咱上次搭到『X』,接着来?」

### 0.4 决策引擎(自适应核心)
1. **描述 → Team 结构**:大白话「先想搞定哪件事」→ 解析 {意图/角色/范围} → 提议 Team(1 Captain + 1–2 Crew),从描述长出、不预设行业。
2. **「第一件事」→ 接哪些业务系统**:推断需要的系统 → 只接最少必需集。
3. **何时升级**:同一步失败 2 次 / 用户连说「不懂」→ 转人工。

### 0.5 三条贯穿铁律
1. **绝不露工程黑话**(Lead/Runner/manifest/launchd/Bridge/repo/token…),只说 向导 / 你的 Team(Captain+Crew)/ 后台清单 / 安置。
2. **secret 只走 CLI 隐藏输入**(或 OAuth 登录)→ keychain/600,**绝不进对话/日志/state/git**。
3. **一次一件 · 校验过才前进 · 失败给具体原因 · 可续传 · worst-case 转人工。**

### 0.6 跟 Anna 的边界(Anna=Sales)
Anna 只在进门前(聊产品→把用户聊进来),顶多传 context 当开场底料;卡住转**人工支持**,不是 Anna。

---

## 1. 完整旅程 —— agent CLI 地基 + setup-first(刚拿 access → 手里有一个能跑的 system)

> 每步给:**Buddy 说** · **Buddy 做**(action)· **用户做** · **建出了什么** · **分支/卡住** · **用例自适应**。

### 步骤 0 · 地基:装一个 agent CLI(Claude Code / Codex / 任一)+ 登录 —— **Buddy 就跑在它上面**
> **Annie v4 点破**:这是**最前面的地基**,不是中间某步。**Onboarding Buddy 本身跑在这个 agent CLI 上**——没它,buddy 起不来、用户也没东西可用。所以那条 command 干的第一件事就是把 agent CLI 弄好,然后 **Buddy 在它上面启动**、才有下面的对话。**vendor-agnostic:Claude Code 或 Codex 或任一 agent CLI,不写死。**
- **谁做这步**:那条 command 的**引导安装脚本**(不是 Buddy —— 此刻 Buddy 还没起来)。装好 + 登录后,Buddy 在 CLI 上启动、接管后面全程。
- **客户看到**(纯进度 + 一次登录):
  `正在准备… 装好你的 agent 工具 ✓  让你登录一下…`
  > 先装一个 **agent 工具**(它是你这套东西的底座)。我帮你装好了,现在在浏览器里登录你自己的账号、点同意就行 —— 用你自己的订阅,不用弄任何密钥。
- **系统动作**:`[AUTO]` 检测/装一个 agent CLI(**默认装其中一个、可配;vendor-agnostic**:Claude Code / Codex / …)→ 引导用户跑登录 → 浏览器 OAuth 登录**用户自己的账号/订阅** → 校验能起一个最小会话 → **在这个 CLI 上启动 Onboarding Buddy**。**不收 API/Cloud key、无 key 明文落地。**
- **用户做**:跑一下(粘 command 时已触发)+ 浏览器点登录同意。
- **建出了什么**:**底座就绪** —— agent CLI 装好登录、Onboarding Buddy 在它上面跑起来了。这一切的地基。
- **分支/卡住**:没装成 → 手动安装链接 + 「装好回来说声」;登录没弹浏览器 → 可复制登录 URL;失败 2 次 → 转人工。
- **用例自适应**:与用例无关(所有用户都要底座);**厂商可选**(装哪个 agent CLI 不影响后面流程)。

### 步骤 1 · Welcome(colleague 感;先不派活)
- **Buddy 说**(此刻 Buddy 已在 CLI 上跑起来了,温暖、像终于见面的同事,**不马上派活**):
  > 嗨,我是你的搭档 —— 往后帮你把这套东西搭起来、有事招呼我就行 😊
  > 先不急着干活,就想说声:**欢迎入伙**。以后这台电脑上就有你自己的一个小团队了,咱一起把它们安顿好,几分钟的事,不难。
  > (三件小事交个底:现在**完全免费**随便试;你的东西**全在你自己电脑上**、不往我们这传;因为它们在你电脑上干活,**电脑开着它们才在岗**,像同事上班一样。)
- **Buddy 做**:纯欢迎;有 Anna context 可带一句「Anna 说你在做 ⟨用户的事⟩」——**仍先 welcome、不立刻派活**。
- **建出了什么**:关系的第一印象(colleague 感)。
- **用例自适应**:welcome 恒温暖、与用例无关。

### 步骤 2 · 搭其余基础工具(setup-first;task-independent)
> 底座(agent CLI)已在 step 0 弄好。这里搭**其余每个用户都要、跟他具体做啥无关**的地基 —— 一件件带,能自动的自动、要手动的手把手。搭完才问要做什么。
> **基础工具集(Annie 定)= Discord + Linear + GitHub**(agent CLI 已在 step 0)。
- **Buddy 说(开场)**:
  > 底座装好了~ 咱再把三样地基接一下(Discord / 后台小本子 / GitHub),我一件件带,能我来的我都自己来。接完再聊你想让团队先干啥。

**2a · 建你自己的 Discord(简化:bot 自动建结构)** [用户亲手最小 4 步] —— **详见 §2**
- **一句话**:用户只做 4 件平台锁死的(建 server / 建 bot 拿 token / 开 2 个 intent / 点高权限邀请),**bot 一进群自动建好频道/角色/webhook 全套结构**。

**2b · 接后台清单 = Linear(一点授权)** [用户点一下]
- **Buddy 说**:「一个**后台小本子**,团队记『要做啥、做到哪』——你平时根本不用打开。点一下授权就行,不贴密钥。」→ OAuth → `[AUTO]` 建后台 team + 路由标签(无感)。
- **分支**:拒绝 → 「不授权团队没法记『做到哪了』,重来一次?」

**2c · 接 GitHub(基础工具之一;Annie v4 定 = 接)** [用户点一下授权]
- **Buddy 说**:「再接一下 **GitHub** —— 你团队做的东西(代码/产物)存这儿,安全、有版本、搬得走。点一下授权就行。」
- **Buddy 做**:GitHub OAuth(device flow,不贴 token)→ `[AUTO]` 建/绑一个仓给这个 Team(客户无感)→ token 安全存储。
- **分支**:没 GitHub 账号 → 给注册链接 +「弄好回来说声」;拒绝授权 → 「不接 GitHub 的话产物没地方安全存,重点一下?」
- **说明**:这推翻早前「砍 GitHub、仓留本地」——现在 **GitHub 接、作基础工具之一**(Annie v4 定)。

- **步骤 2 收尾**:「好啦,地基齐了(底座 ✓ Discord ✓ 后台本子 ✓ GitHub ✓)。现在聊正事 ——」

### 步骤 3 · 问你先想搞定哪件事(setup 完才问)
- **Buddy 说**:「你最想让这个小团队**先帮你搞定哪件事**?大白话说,你今天正手动盯着、还挺烦的那种事最好。」
- **Buddy 做**:`[AUTO]` 解析 → {意图/角色/范围}。
- **用户做**:自由描述。
- **分支**:太空(「帮我赚钱」)→ 追问一次要具体场景,最多 2 次 → 给 3 个例子选。
- **用例自适应**:**这句是自适应源头** —— Team / 接哪些系统 / 第一个产出全从这长出。

### 步骤 4 · 提议 + 确认 Team
- **Buddy 说**(下例订单用例):「那先给你搭个「**订单盯梢**」小组:一个 **Captain** 帮你把关,一个 **Crew** 去各系统查『这单为什么卡』。名字随你改。成吗?(成 / 改改)」
- **Buddy 做**:`[AUTO]` 落项目 config。
- **分支**:一上来贪多 → 「先把这一个跑通,回头 Discord 里跟 Captain 说声就能加」。
- **用例自适应**:Team 名/角色/范围全按步骤 3 变。

### 步骤 5 · 早聊一句(welcome-first;先像同事打招呼,不马上派活)
- **Buddy 做**:`[AUTO]` 起一个最小可对话的 Captain。
- **Buddy 说**:「你的 **Captain 已经上线了**!去 Discord 跟它打个招呼吧,随便说句『在吗』。先认识一下,别的等下再说。」
- **Captain 说(welcome-first;提正事按用户用例、不硬塞订单)**:
  > 在的 👋 我是你的 Captain,以后就是我陪你把活儿盯下来。终于见面了~
  > 你先随便跟我聊两句都行。等把该接的东西接上,我就能真去帮你干活了 —— 想让我先看哪件事,直接跟我说。
  > （※ 已知用例则把「帮你干活」换成贴用户那件事的话,**不硬塞订单**。）
- **建出了什么**:第一个「有个活的**同事**在回我」的时刻。
- **分支**:用户不想聊 → 直接继续;Captain 没上线 → 报错 + 重试 1 次 → 仍不行转人工。

### 步骤 6 · 接第一件事要用的业务系统(JIT) —— **详见 §3**
- **一句话**:从步骤 3 推断要接哪些系统,只接这件要的,一次一个,能 OAuth 就 OAuth、否则隐藏输入贴 key,当场只读探测校验。

### 步骤 7 · 自动收尾安置([AUTO])
- **Buddy 说**:「都齐了,我把团队正式安顿一下 —— ✓ 建工作区　✓ 配好 Captain 和 Crew　✓ 让它们常驻上岗　✓ 上线自检　搞定 🎉」
- **Buddy 做**([AUTO]):脚手架工作区 + **推到 GitHub 仓**(Annie v4:GitHub 已接)→ 写 config → 生成/校验 manifest → 装 OS-portable 常驻服务(launchd/systemd/WSL2,FLY-648)→ 起服务 → 健康检查。
- **分支**:某子步失败 → 具体报错 + 重试 1 次 → 仍失败转人工。

### 步骤 8 · 第一个真产出
- **Captain/Crew 干活**(下例订单,只当样例):
  > 用户:看看我今天有没有卡住的单 → **Captain**:让 Crew 去查,几十秒 → **Crew**(~40s):今天 26 单,**1 单要注意**:#1234 显示 pending 但**不是丢单**——供应商已发货、确认邮件没读到才没更新。要我盯着到了自动更新吗?
- **建出了什么**:第一个「它真帮到我了」的结果(≤60s)。onboarding 完成。
- **用例自适应**:产出形态按用例(对账/文案/回客户…),都是**一个可信结果**、不是 dashboard。

---

## 2. 深挖 A · 建你自己的 Discord(简化版,据 discord-permission-research.md)

> **research 结论**:高权限 bot 一进群能**自动建好频道/角色/webhook 全套结构**;但有 **4 件平台锁死、用户必须亲手**(Discord 不给 API):建 server、建 bot 拿 token、开 2 个 intent、点邀请。我们把这 4 步带到「点错都难」,其余全自动。

**用户只做这 4 件(每件一句人话 + 截图 + 短视频兜底):**

| # | Buddy 跟你说 | 用户做 | Buddy 自动/校验 |
|---|---|---|---|
| 1 建 server | 「先建个你自己的服务器——团队上班的『办公室』。左边大『+』→ 亲自创建 → 起名。」[截图] | 建 server(10s) | 记下 server(供邀请预选) |
| 2 建 bot 拿 token | 「开发者页 → New Application → 起名 → Create;Bot → Reset Token → Copy,贴进我这安全输入(不显示)。」[截图] | 建 app + 贴 token(隐藏) | token→安全存储;连 Gateway 校验 |
| 3 开 2 个 intent | 「同页往下,开 Message Content + Server Members 两个开关(红圈)。」[截图] | 开开关 | 轮询校验两个都开了 |
| 4 点邀请 | 「点这个链接把机器人请进你刚建的服务器(权限和服务器我都给你选好了)→ [高权限邀请链接,预选 server]。」 | 点一下授权 | 检测已入群 |

**之后 bot / Buddy 全自动**:生成 **OAuth2 高权限邀请链接**(`scope=bot` + 权限整数:Manage Channels/Roles/Webhooks/发消息 + `guild_id` 预选)→ bot 一进群**自动建好所有频道/分类/角色/webhook/结构** → 每步即时校验给**具体**报错。
**失败分支**:token 连不上→重 Reset;intent 少开→精确指哪个开关;没进群→再点邀请选对 server;**worst-case 2 次→转人工连屏陪弄**。
**为什么还剩这 4 步删不掉**:见 discord-permission-research.md §4(平台锁死,OpenClaw 也没绕过;想全免只能「共享 bot 池」,块3 已定=理想/探索项)。

---

## 3. 深挖 B · 接第一个真实任务(use-case adaptive)

1. **[AUTO] 推断要接啥**:从步骤 3 推断需要的系统 → 最少必需集。
2. **一次接一个**(下例):「你那件『订单盯梢』要看你的订单,你今天用哪个?· Shopify · Veeqo · Ordoro · 其它」→ 选 → 「点这个授权就行,不贴密钥」→ ✓ →「还要接 Veeqo 吗?」
3. **两条路**:有 OAuth 的(Shopify)浏览器点一下不贴 key;只有 key 的(Veeqo/Ordoro)隐藏输入贴 + 引导去哪拿。
4. **当场校验**:最小**只读**探测(拉最近 1 单)。
5. **权限最小化**:onboarding 只申请**只读**;写/改留运行期 [GATE] 批准。

**失败**:权限不够→精确指去勾哪 scope;key 错→去重生成只读的;没连接器→诚实「先记下让工程看能不能加,先用能接的做」不假装;worst-case 2 次→转人工。

**用例自适应表(订单只是一行)**:

| 第一件事 | 自动接 | 第一个产出 |
|---|---|---|
| 盯 dropship 订单 | 订单/库存(Shopify/Veeqo) | 「#1234 卡了,不是丢单,是确认邮件没读到」 |
| 对广告花费和成交 | 广告后台 + 订单 | 「今天花 800、成交 12 单,ROI 1.8,比昨天低」 |
| 先回客户询价 | 邮箱/CRM + 价目表 | 「3 个客户在等报价,草稿拟好了,你看发不发」 |
| 上新品写文案 | 商品库/图床 | 「这款三版标题 + 卖点,你选一个」 |

---

## 4. 卡住怎么办 + worst-case 转人工(升级阶梯)
1. **第 1 次失败** → **具体**报错(精确到哪步/哪开关)+ 一句怎么修 → 重试。
2. **第 2 次失败 / 用户明显懵** → 「这步有点绕,别耗着 —— 我帮你转个**人工支持**,真人跟你连屏几分钟弄好,要吗?」
3. **转人工**:生成**脱敏**上下文摘要(走到哪、卡在哪、报错啥,**不含 secret**)→ 递人工支持队列 → 「转好了,一会有人找你」→ state 标 `escalated`(可被人工接手续)。
4. **绝不**把栈信息/黑话甩用户;不阻死。转的是**人工支持**,不是 Anna。

## 5. 用例自适应(订单只是一个例子)—— 总纲
同一条流程对每种「第一件事」都成立,变的只有三处、都从**步骤 3 那句大白话**长出:① Team 名+角色(步骤 4)② 接哪些业务系统(步骤 6)③ 第一个产出形态(步骤 8)。**step 0 底座 / welcome / 基础工具(Discord/Linear/GitHub)/ 建 Discord / 安置与用例无关,恒定。** 订单只是一个跑通样例。

## 6. 给 Tadashi 的实现要点
- **状态机**:步骤 0–8 各一个可续传 state;`escalated` 是可被人工接手的终态。**step 0(agent CLI 底座)由 command 的引导安装脚本做、Buddy 在其上启动**;基础工具(Discord/Linear/GitHub)= task-independent 段先跑;team + 任务工具 + 安置 = task-specific 段,问完任务再跑。
- **agent CLI = 地基,vendor-agnostic**:装一个 agent CLI(Claude Code / Codex / 任一,**默认可配、不锁厂商**),用户登录**自己的账号/订阅**(OAuth,不收 key);**Onboarding Buddy 跑在这个 CLI 上**。
- **基础工具**:Discord(高权限 bot 自动建结构)· Linear(OAuth 建 team/labels)· **GitHub(OAuth 建/绑仓,Annie v4 定=接)**。
- **action 清单**:装/登录 agent CLI · 生成高权限 Discord 邀请 + bot 自动建结构 · 轮询入群 · Linear/GitHub OAuth + provision · 解析描述→Team config · 业务系统 OAuth/隐藏 key + 只读探测 · [AUTO] 安置(config/manifest/推 GitHub 仓/OS-portable service/health-check)。
- **安全**:secret→keychain/600,不进 state/git/日志/对话;onboarding 只只读 scope;写/改留运行期 [GATE]。
- **persona**:话术层 = Buddy system prompt/模板,基调=温暖同事;每步真样例见本文,可当模板起点。

---

## 附录 · Discord 短视频/截图脚本(§2 配套)
对齐简化后 4 步:① 建 server;② New Application→命名→Create + Bot→Reset Token→Copy(打码);③ 开 Message Content + Server Members(红圈);④ 点高权限邀请选服务器。每步一句字幕=对应话术;截图作 fallback。

## 仍开放(待 Annie / 后续)
- **agent CLI 默认装哪个**(vendor-agnostic,但要不要给个默认 / 让用户选)—— 小战术,待定。
- Onboarding Buddy 正式名 · 命令具体形态(curl vs npx)。
- 收费 = placeholder,待 WorkBuddy / homerail 竞品分析。
- 「Draft」竞品待 Annie 给链接。
- (GitHub 已定=接;砍-GitHub 早前决定已推翻。)
