# FLY-910 非工程自托管 onboarding — 逐屏详细规格(Tadashi 零追问)

Issue: FLY-910 (https://linear.app/geoforge3d/issue/FLY-910/非工程快速-onboarding-体验设计一条-command-上手后体验)
日期: 2026-07-08(v2,织入 Annie 逐块决定)
基于: onboarding-flow-draft.md · provisioning-automation-boundary.md · self-hosted-onboarding.md · deployment-decision-and-mvp-scope.md · tactical-options.md(Annie 2026-07-08 逐块拍)

> **本文 = 逐屏实现规格**,把设计深钻到「eng 照着能建、Annie 不用再掰细节」。每屏给:客户看到的**确切文案** · 输入方式 · 系统动作 · 校验 · **每个失败分支的原话 + 恢复** · 续传 · 延迟预期。
> **锚(Annie 锁)**:客户=甲(有技术直觉、缺时间)· 部署=B 纯自托管(MVP;managed=V2)· 入口=终端一条 command。
> **用词已锁 · 内外分层**:对外(客户看的皮)= Captain(=内部 Lead)/ Crew(=内部 Runner)/ Team(=内部 Department)。内部代码不改写。产品对外品牌名 = 以后单独品牌任务,先不动。
>
> ## 🆕 Annie 2026-07-08 逐块决定(本 v2 已织入)
> 1. **块1 起步 = A+C**:终端一条命令 → 命令行一问一答(默认快路);**加「早聊一句」**——Discord+模型一接好,先让客户跟 Captain 打个招呼(工具没全接也行),完整跨系统结果随后。
> 2. **块2 = 自助,重构成「Onboarding Buddy」**(★重要重构):onboarding = **一个自助 agent(暂名 Onboarding Buddy,参照 Metric 那种一步步带用户搭建的自助 agent)**,**跟 Anna 完全分开**。**Anna = Sales**(聊产品把客户聊进来 → Sales 就结束 → 顶多把 context 传给 Onboarding Buddy);进来后客户跟 Onboarding Buddy 搭、跟 Anna 无关。本文通篇的「向导」= Onboarding Buddy。**worst-case 升级 = 转人工支持**(不再是「喊 Anna」)。
> 3. **块3 = C,但主线收敛**:**主线 = 引导客户建他自己的 Discord(server + bot),我们能帮的都帮、尽量降摩擦**;「现成 bot 池一键邀请」捷径**标成理想 / 大概率做不成**(控制不了 Discord 平台),当探索项,不当承诺。
> 4. **块4 收费 = 现在不做**:初期**给创始人自己用、免费全试**;license-key 按 Team 计费 = 后期精进,**本文标 placeholder、不写死收费细节**,等 WorkBuddy / homerail 竞品分析完再一起深化。**隐私(数据在你自己机器)仍当显式卖点。**
> 5. **块5 开场文案 = 更像人说话、口语自然**;开关:现在免费(露)、隐私句(露)、砍 GitHub、机器常开(开场用人话说一句)。
>
> **贯穿铁律**:① 绝不露工程黑话(Lead/Runner/Department/manifest/launchd/Bridge/projects.json/repo 一律不对客户露);对客户只说 向导(Onboarding Buddy)/ 你的 Team(里有 Captain + Crew)/ 后台清单 / 安置。② token/key 永远走 CLI 隐藏输入,绝不进对话或日志。③ 每步:一次一件 · 校验过才前进 · 失败给具体原因 · 可续传 · worst-case 一键转人工支持。

---

## 状态机总览(给 Tadashi)

```
S0 装 → S1 起 Onboarding Buddy(开场) → S2 摸需求 → S3 定Team → S4 模型key → S5 建自己的 Discord(server+bot)
     → S5.5 早聊一句(先跟 Captain 打招呼,工具没全接也行) → S6 Linear
     → S6.5 连接第一件事要用的业务工具(JIT) → S7 自动安置 → S8 首次产出 → DONE
        每步写一个 onboarding-state.json(cursor + 已完成步),中断重跑从 cursor 续。
        任一步 worst-case → escalate 转人工支持(不阻死;Anna 不在此环,Anna=Sales)。
```
状态持久化 `~/.flywheel-onboarding/state.json`(不含任何 secret);secret 落各自安全存储(见各屏)。

> **Onboarding Buddy 是谁(给 Tadashi)**:一个**自助引导 agent**,在终端里一步步带客户走完 S0–S8,能自动的后台悄悄做、要客户亲手的手把手带。它**独立于 Anna**(Anna=Sales,只在客户进来前;顶多把 Sales 阶段的 context 传给 Onboarding Buddy 当开场底料)。worst-case 它把客户转给**人工支持**,不是 Anna。

---

## S0 · 一条 command(装 + 起 Onboarding Buddy)
- **客户操作**:粘一条命令进终端。形态 ⟨待定:`curl -fsSL https://get.flywheel.ai | sh` vs `npx @flywheel/onboard`⟩。
- **客户看到**(纯进度,非日志):
  `正在准备… 检查环境 ✓  安装 ✓  启动向导 ✓`
- **系统动作**:检测 Node≥20 / git → 缺则 `[AUTO]` 装或问一句「我帮你装 Node?(y/n)」→ 全局装 CLI → 起 Onboarding Buddy 进程(若 Anna 传了 context,载入当开场底料)。
- **校验**:装完自检 `flywheel --version` 通。
- **失败分支**:
  - 无网络 → `连不上网,检查网络后重跑这条命令就行(已完成的不会重来)。`
  - 不支持 OS(非 macOS/Linux/WSL2,FLY-648)→ `你的系统我暂时还没支持(现支持 Mac / Linux / Windows 的 WSL2)。我帮你转个人工支持看看?`
  - 装 Node 被拒 → 给手动装链接 + `装好后重跑即可。`
- **延迟**:典型 20–60s。
- **续传**:S0 完成写 state。重跑跳过已装。

## S1 · 开场(口语自然;免费 + 隐私 + 机器常开各一句人话)
- **客户看到**(口语、别端着,≤5 短行):
  > 嗨!我来帮你把**你自己的一个小团队**搭起来,几分钟的事,跟着我走就行。
  > 两句话先说清楚,你心里有底 ——
  > · **现在完全免费**,随便试,不用填卡。
  > · 你的团队**就跑在你这台电脑上**,你的数据一直在你这儿、从不往我们这儿传。
  > · 还有个小实话:因为它们在你这台电脑上干活,**电脑开着它们才在岗**——就跟真员工上班一样,关机它们就下班了。
  > 行,那我先问你一句 ——
- **系统动作**:无(纯开场)。
- **设计**:全程像一个耐心的人在带你,不是系统提示音;免费/隐私/常开三句都用大白话、不吓人。

## S2 · 摸需求(从大白话长出团队)
- **客户看到**:`你最想让这个团队帮你搞定的**第一件事**是啥?大白话说就行,别拘束。`
- **输入**:可见文本(自由描述)。
- **系统动作**:`[AUTO]` 把描述 → 意图摘要 + 提议一个 Team 结构(名 + 1 Captain + 1–2 Crew + 活范围)。**不预定义客户公司**,全从描述长出。
- **校验**:描述可成活(有个可执行的「第一件事」)。
- **失败分支**:
  - 太空(如「帮我赚钱」)→ 追问一次:`能说个具体点的场景吗?比如你今天正手动盯着、还挺烦的一件事。` 最多追 2 次仍空 → 给 3 个例子选(电商向:订单盯梢 / 上架文案 / 对账),不硬编死。
- **延迟**:≤3s,期间显示「我想想怎么帮你搭…」。

## S3 · 确认 Team 结构
- **客户看到**(样例,按 S2 描述变):
  > 那我建议先给你搭个「**订单盯梢**」Team:
  > · 一个 **Captain** 帮你把关、平时跟你对话
  > · 一个 **Crew** 去各个系统里查「这单为什么卡了」
  > 名字你随便改。这样成吗?(成 / 改改)
- **输入**:确认 or 改(名/加Crew)。
- **系统动作**:`[AUTO]` 落一份**项目 config**(FLY-648 核心/项目分离:Team名、要哪个Captain+Crew、活范围)。暂不起服务。
- **失败分支**:客户想一上来要好几个Team → `咱先把这一个跑通,回头你在 Discord 里跟 Captain 说一声就能再加。`
- **续传**:config 落 state,改动幂等覆盖。

---

## S4 · 录模型 key(Claude)— 亲手事之一 [MANUAL·引导]
- **客户看到**:
  > 你的团队用 Claude 当脑子。你有 Claude 的订阅或者 API key 吗?
  > 有 → 我带你安全贴进来(不会显示在对话里)。
  > 没有 → 这个链接注册:https://console.anthropic.com/ ,弄好回来跟我说一声。
- **输入**:CLI **隐藏** prompt 收 key。
- **系统动作**:key → 本地安全存储(OS keychain / 权限 600 文件,**不进 state.json / 不进 git / 不进日志**)→ 发一个最小 test 调用校验。
- **校验**:test 调用 200。
- **失败分支**:
  - key 无效 → `这个 key 连不上——看看是不是没复制全,或者额度用完了。再贴一次?`
  - 无额度 → `key 是对的,但这个账号好像没额度了,去充一下再回来。`
- **延迟**:校验 ≤5s。
- **续传**:成功标记 S4 done(不存 key 明文于 state)。

## S5 · 建你自己的 Discord(server + bot)— 亲手事之二 [MANUAL·手把手]
> **块3 决定(Annie)**:主线 = **引导客户建他自己的 Discord —— 我们能帮的都帮、尽量降摩擦**。Discord 建 bot 这一步**没法替他自动化**(平台不给接口),只能手把手带到「点错都难」。配**截图 + 15s 短视频**(脚本见附录 A)。
> **⟨现成 bot 池一键邀请捷径 = 理想 / 大概率做不成⟩**:我们控制不了 Discord 平台,「给个现成 bot 直接邀请」这条能不能长期成立没把握——**当探索项,不当承诺**;第一版**默认走客户自建**,捷径成了再说。

- **客户看到**(一步一确认,每步附截图):
  > 你的团队在 **Discord** 里跟你干活,所以先弄好你自己的 Discord。跟我做,几分钟:
  > **A. 有 Discord 吗?** 没有的话先花 1 分钟注册 + 建一个你自己的服务器(server)——这就是你团队上班的「办公室」。[附:注册 + 建 server 截图] 弄好告诉我。
  > **B. 给团队建个专属机器人**(30 秒):
  > **1/4** 打开 https://discord.com/developers/applications → 右上「New Application」→ 起名(比如你公司名)→ 勾同意 → Create。建好告诉我。
  > **2/4** 左边菜单「Bot」→「Reset Token」→ Copy。把那串贴进我这里的安全输入(不会显示)。
  > [CLI 隐藏输入收 token]
  > **3/4** ✓ 收到。同一页往下,打开两个开关:**Message Content Intent** 和 **Server Members Intent**(见截图)。开好说一声。
  > **4/4** ✓ 连上了、机器人在线!最后点这个把它请进你刚建的服务器 → [自动生成的邀请链接]。
  > ✓ 进群了,Discord 这步就完成了。
- **系统动作**:token→安全存储(**绝不进对话/日志**)→ 连 Discord Gateway 校验 → 用 app client id 生成 **invite-url**(含所需权限 scope)→ 轮询检测 bot 已加入目标 server → `[AUTO]` 建所需频道。
- **校验**:Gateway 连通 + intents 开 + bot 在目标 server。
- **失败分支(具体到哪一步)**:
  - 没有 server → `先建一个你自己的服务器(左边那个「+」),几秒钟,建好回来。`[附截图]
  - token 错/过期 → `这串 token 连不上,回 Bot 页面 Reset 一次再贴。`
  - intents 没开 → `还差一个:Message Content Intent 那个开关还没开(第 3 步截图里红圈处)。`
  - 没邀进服务器 → `还没看到它进群——点一下这个邀请链接,选你刚建的服务器。`
  - **worst-case**(卡住 / 来回失败 2 次)→ `这步有点绕,我帮你转个人工支持,让个真人跟你连屏一起弄?` → escalate 转人工支持。
- **降摩擦(我们能帮的都帮)**:自动生成带正确权限的邀请链接、自动建频道、每步即时校验给具体报错、短视频/截图兜底;客户只需在 Portal 点几下 + 贴一次 token。
- **延迟**:人手步骤,无超时压;每次校验 ≤5s。
- **续传**:token 存后即使中断,重跑从「开 intents / 邀请」续,不重建 app。

## S5.5 · 早聊一句(块1 C:先跟 Captain 打个招呼,工具没全接也行)
> **Annie 块1 C**:Discord + 模型一接好,别让客户干等着把所有工具接完才有反应——**先让他跟 Captain 说上一句话**,把「有个活的东西在回我」这个时刻提前(参照 OpenClaw 的「先进去聊一句」逃生路)。
- **系统动作**:`[AUTO]` 起一个**最小可对话的 Captain**(够在 Discord 里回话即可,完整跨系统能力等 S6.5 工具接好)。
- **客户看到**:
  > 你的 **Captain** 已经上线了!去你的 Discord 跟它打个招呼试试——比如「在吗」。它现在能跟你聊,等下我们把你的系统接上,它就能真去帮你查东西了。
  > [客户在 Discord 说「在吗」]
  > **Captain**:在的 👋 我是你的 Captain。你那件「订单盯梢」的事我记着了,等咱把你的订单系统接上,我就带 Crew 去给你查。先接着走两步?
- **为什么加这步**:最快给「有反应」的信任时刻(time-to-first-message 越短越好),不用全套接完才见到活的团队。
- **失败分支**:Captain 没上线 → 具体报错 + 自动重试 1 次 → 仍不行 `Captain 起得有点慢,我看看…`(不甩栈信息;仍不行转人工支持)。
- **续传**:可跳过(客户不想聊直接继续);不阻塞后续。

## S6 · 授权 Linear — 亲手事之三 [OAUTH·一点]
- **客户看到**:
  > 你的团队用一个**后台清单**记「要做什么、做到哪了」——**你平时根本不用打开它**,给你留个底而已。点一下授权就行。
  > [浏览器弹 Linear OAuth → 客户点同意]
  > ✓ 后台清单接好了。
- **输入**:浏览器 OAuth(device flow,**不粘 API key**)。
- **系统动作**:拿 OAuth 授权 → `[AUTO]` 用 API 建 team + routing labels(客户无感)→ 存 token 安全存储。
- **校验**:OAuth 回调成功 + 建 team/labels 成功。
- **失败分支**:
  - 拒绝授权 → `不授权的话团队没法记「做到哪了」,重新点一下?`
  - 浏览器没弹 → 给可复制的授权 URL + `点这个链接授权。`
- **延迟**:OAuth ≤10s + provision ≤5s。

---

## S6.5 · 连接第一件事要用的业务工具(JIT·接入项目)[MANUAL/OAUTH·引导]
> **这是「接入项目」的核心一步**。Team 要真出活,Crew 得能读客户的业务系统(Hooves&Paws 样例:Veeqo/Ordoro/Shopify/KV log)。
> **设计原则(研究支撑:「从最显而易见的用例起步」「集成深度>能力」)**:**不前置连全部工具**——只连**第一件事**需要的那 1–2 个,JIT。其余日后在 Discord 里按需再连。

- **系统动作(先判需要啥)**:`[AUTO]` 从 S2/S3 的「第一件事」推断需要接哪些工具 → 列出最少必需集。
- **客户看到(每个工具一步,一次一个)**:
  > 你那件「订单盯梢」要让团队能看你的订单,得先接上你在用的系统。你今天用的哪个?(我列几个常见的,选一个或告诉我名字)
  > · Shopify　· Veeqo　· Ordoro　· 其它(说名字)
  > [客户选 Shopify]
  > 好,连 Shopify —— 点这个授权就行(不用你贴任何密钥)。
  > [浏览器 Shopify OAuth → 客户点同意]
  > ✓ Shopify 接好了。还要接 Veeqo 吗?(它管你的库存/发货)
- **输入/机制(按工具类型)**:
  - **有 OAuth 的(Shopify 等)**:浏览器 OAuth 一点,**不粘 key**。
  - **只有 API key 的(Veeqo/Ordoro 等)**:CLI 隐藏输入贴 key + 引导「去哪拿这个 key」(截图),同 S4 安全铁律。
  - 工具接入实现 = **MCP server / 连接器**(eng 细节归 Tadashi 648 底座;产品侧只保证「引导式、一次一个、安全录、当场校验」)。
- **校验**:每接一个 → 发一个最小只读探测(如拉最近 1 单)确认连通 + 权限够。
- **失败分支**:
  - 权限不够 → `连上了,但还差个权限:得允许我读你的订单。回授权页勾上「读取订单」再点一次。`
  - key 错 → `这个 key 连不上,去 <系统> 设置里重新生成一个只读的再贴。`
  - 客户的系统没在列表/没 API → 诚实:`你的 <系统> 我还没有现成连接器——先记下,我让工程那边看看能不能加;这件事咱可以先用能接的部分做。` 不假装能接。
  - **worst-case**:接不通来回 2 次 → escalate 转人工支持。
- **权限最小化**:默认只申请**只读** scope(onboarding 阶段不要写权限;写/改动作走运行期 [GATE] 客户批准)。
- **延迟**:每工具 OAuth ≤10s / key 校验 ≤5s。
- **续传**:每个已连工具落 state(token 安全存储,不进 state 明文),中断续连未完成的。

## S7 · 自动安置([AUTO],用户无感)
- **客户看到**(干净进度,非 JSON):
  > 都授权好了,我把你的团队正式安置一下 ——
  > ✓ 建工作区　✓ 配好 Captain 和 Crew　✓ 让团队常驻　✓ 上线自检
  > 搞定 🎉
- **系统动作([AUTO])**:脚手架本地工作区(**砍 GitHub、仓留本地**)→ 写 projects.json → 生成+校验 manifest → 装 **OS-portable 常驻服务**(macOS launchd / Linux systemd / WSL2,FLY-648)→ 起 Bridge → 健康检查(bot 在线 + Captain 响应)。
- **校验**:health-check 全绿(bot online + Captain 能响应一条内部 ping)。
- **失败分支**:某步失败 → 具体报错 + 自动重试 1 次 → 仍失败 `安置卡在「<步骤>」了,我帮你转个人工支持看一下,很快回你。` → escalate(不把栈信息甩客户)。
- **延迟**:典型 30–90s,进度条逐项打勾。
- **续传**:每子步幂等,重跑续。

## S8 · 首次产出 Aha(去 Discord 让 Captain 真干一件事)
- **客户看到(Onboarding Buddy 收尾)**:
  > 全搭好了!回你的 Discord,让 Captain 真干件事试试,比如「看看我今天有没有卡住的单」。
- **完整首次对话样例(Discord 内,Hooves&Paws 依据;只当样例不承诺定制)**:
  > 客户:看看我今天有没有卡住的单
  > **Captain**:收到,让 Crew 去查你今天的订单,几十秒。
  > **Crew**(~40s 后):扫完了。今天 26 单 dropship,**1 单要你注意一下**:
  > · **#1234 显示 pending,但其实不是丢单** —— 供应商已经发货了,是那封确认邮件没被读到,状态才没更新。
  > · 其余 25 单都正常。
  > 要我盯着 #1234 的确认、到了自动帮你更新状态吗?(要 / 不用)
- **为什么是 Aha**:它**真替客户干了一件平时要跨 Veeqo/Ordoro/KV log 几个系统才能还原的事**,给「为什么」的**可信答案**,还主动点出「不是丢单」这种静默失败盲区。价值=看清风险的**结果**,不是一个 dashboard。
- **系统动作**:Onboarding Buddy 把「第一件事」预置给 Captain(或等客户开口);Captain 派 Crew → 跨源查 → 回结论 + 下一步选项。
- **失败分支**:第一件事需要一个 S6.5 还没接的工具 → 诚实回到接入:`这件事我还得看你的 <系统>,花 10 秒接一下?`(复用 S6.5 单工具引导)→ 接好再出结果。绝不假装有答案。
- **延迟目标**:首个结果 **≤60s**。

---

## 附录 A · Discord 建 server+bot 短视频/截图脚本(S5 配套)
两段:①(可选)注册 Discord + 建一个自己的 server(2 卡)。② 建 bot 15s 静音短视频,分 4 卡对齐 S5 四步:New Application→命名→Create;Bot→Reset Token→Copy(打码 token);往下滚开 Message Content + Server Members 两个开关(红圈);回终端贴 token→点邀请链接选服务器。每卡配一句字幕=S5 对应文案。截图同款作 fallback。

## 附录 B · 贯穿校验/安全清单(给 Tadashi)
- 所有 secret(模型 key / Discord token / Linear token)→ OS keychain 或 600 文件;**不进** state.json / git / 日志 / 对话。
- state.json 只存 cursor + 已完成步 + 非敏感 config(Team名等)。
- 每步 idempotent + resumable;worst-case escalate **转人工支持**(Anna=Sales,不在此环),永不把栈信息甩客户。
- OS-portable service 抽象(launchd/systemd/WSL2)= FLY-648 底座提供。

## 决定已锁(Annie 2026-07-08)+ 仍开放
- **已锁(本文已织入)**:块1 A+C(命令+早聊)· 块2 自助 Onboarding Buddy(Anna=Sales 分开)· 块3 主线自建 Discord + 现成 bot 捷径当探索项 · 块5 口语开场 + 免费/隐私/砍GitHub/机器常开人话一句。
- **收费 = placeholder(块4)**:初期给创始人自用、**免费全试**;license-key 按 Team = 后期精进,**不写死**,等 **WorkBuddy / homerail 竞品分析**完再深化(见 monetization-privacy-strategy.md 顶部 placeholder 标注)。
- **仍待**:Onboarding Buddy 正式名(暂名)· command 具体形态(curl vs npx)· 「Draft」竞品待 Annie 给链接。
