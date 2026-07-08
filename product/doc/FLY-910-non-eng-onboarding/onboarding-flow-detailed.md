# FLY-910 非工程自托管 onboarding — 逐屏详细规格(Tadashi 零追问)

Issue: FLY-910 (https://linear.app/geoforge3d/issue/FLY-910/非工程快速-onboarding-体验设计一条-command-上手后体验)
日期: 2026-07-06
基于: onboarding-flow-draft.md(上层大纲)· provisioning-automation-boundary.md · self-hosted-onboarding.md · monetization-privacy-strategy.md

> **本文 = 逐屏实现规格**,把 draft 深钻到「eng 照着能建、Annie 不用再掰细节」。每屏给:客户看到的**确切文案** · 输入方式 · 系统动作(映射边界表类别)· 校验 · **每个失败分支的原话 + 恢复** · 续传 · 延迟预期。
> **锚(Annie 锁)**:客户=甲(有技术直觉、缺时间)· 部署=B 纯自托管 · 入口=终端一条 command。
> **参数化(战术待 Annie,定了全局替换即可,不改结构)**:
> **用词已锁(Annie,2026-07-06)· 内外分层(重要)**:
> - **对外(客户看的皮)= Captain + Crew + Team**:Captain(内部 Lead)· Crew(内部 Runner)· Team(容器,内部 Department)。航海主题、好玩派。
> - **内部代码/机制不改写**——仍是 Lead / Runner / Department(+ Flywheel 内部代号)。
> - 本文是**客户面文案 = 对外皮**,故通篇 Captain/Crew/Team;括号里「=内部 X」只是给 Tadashi 的**皮↔内映射**,不是要改内部。
> - 产品名 Flywheel → 内部代号;**对外品牌名 = 以后单独品牌任务**,先不动。
>
> 其余参数化(战术待 Annie):⟨FREE⟩=「1 个 Team 免费试」是否露出 · ⟨PRIV⟩=隐私一句话卖点是否入开场 · ⟨GH⟩=GitHub 砍(默认砍,仓留本地) · ⟨BOT⟩=Discord bot 默认 C1 自建 · ⟨MACHINE⟩=「机器常开」是否开场告知
> **贯穿铁律**:① 绝不露工程黑话(内部术语 Lead/Runner/Department/manifest/launchd/Bridge/projects.json/repo 一律不对客户露);对客户只说 向导/你的 Team(里有 Captain + Crew)/后台清单/安置。② token/key 永远走 CLI 隐藏输入,绝不进对话或日志。③ 每步:一次一件 · 校验过才前进 · 失败给具体原因 · 可续传 · worst-case 一键喊真人。

---

## 状态机总览(给 Tadashi)

```
S0 装 → S1 起向导 → S2 摸需求 → S3 定Team → S4 模型key → S5 Discord bot → S6 Linear
     → S6.5 连接第一件事要用的业务工具(JIT) → S7 自动安置 → S8 首次产出 → DONE
        每步写一个 onboarding-state.json(cursor + 已完成步),中断重跑从 cursor 续。
        任一步 worst-case → escalate(喊 Anna/真人),不阻死。
```
状态持久化 `~/.flywheel-onboarding/state.json`(不含任何 secret);secret 落各自安全存储(见各屏)。

---

## S0 · 一条 command(装 + 起向导)
- **客户操作**:粘一条命令进终端。形态 ⟨待定:`curl -fsSL https://get.flywheel.ai | sh` vs `npx @flywheel/onboard`⟩。
- **客户看到**(纯进度,非日志):
  `正在准备… 检查环境 ✓  安装 ✓  启动向导 ✓`
- **系统动作**:检测 Node≥20 / git → 缺则 `[AUTO]` 装或问一句「我帮你装 Node?(y/n)」→ 全局装 CLI → 起向导进程。
- **校验**:装完自检 `flywheel --version` 通。
- **失败分支**:
  - 无网络 → `连不上网,检查网络后重跑这条命令就行(已完成的不会重来)。`
  - 不支持 OS(非 macOS/Linux/WSL2,FLY-648)→ `你的系统我暂时还没支持(现支持 Mac / Linux / Windows 的 WSL2)。要不要我喊 Anna 帮你看看?`
  - 装 Node 被拒 → 给手动装链接 + `装好后重跑即可。`
- **延迟**:典型 20–60s。
- **续传**:S0 完成写 state。重跑跳过已装。

## S1 · 向导开场 ⟨+ 隐私/免费一句话，待 Annie⟩
- **客户看到**:
  > 嗨,我是帮你把**你自己的团队**搭起来的向导,几分钟搞定。
  > ⟨PRIV：你的团队跑在**你自己这台机器**上,数据从不碰我们。⟩
  > ⟨FREE：先给你**一个Team免费**跑起来,喜欢再说。⟩
  > 先问你一句 ——
- **系统动作**:无(纯问候)。**⟨MACHINE：若开场告知⟩** 追一句:`一个小提醒:因为团队在你这台机器上干活,这台机器开着它们才在岗——像真员工上班一样。`
- **设计**:问候≤3 行,别信息过载。

## S2 · 摸需求(generic:从大白话长出团队)
- **客户看到**:`你最想让这个团队帮你做的**第一件事**是什么?用大白话说就行。`
- **输入**:可见文本(自由描述)。
- **系统动作**:`[AUTO]` NLU 把描述 → 意图摘要 + 提议一个 Team 结构(名 + 1 Captain + 1–2 Crew + 活范围)。**不预定义客户公司**,全从描述长出。
- **校验**:描述可成活(有个可执行的「第一件事」)。
- **失败分支**:
  - 太空(如「帮我赚钱」)→ 追问一次:`能说个具体点的场景吗?比如你今天手动在盯的一件烦事。` 最多追 2 次仍空 → 给 3 个模板例子选(按甲电商:订单盯梢 / 上架文案 / 对账),不硬编死。
- **延迟**:NLU ≤3s,期间显示「在想怎么帮你搭…」。

## S3 · 确认 Team 结构
- **客户看到**(样例,按 S2 描述变):
  > 建议给你先建一个「**订单盯梢**」Team:
  > · 一个 **Captain** 帮你把关、跟你对话
  > · 一个 **Crew** 去各系统查「这单为什么卡」
  > 名字随你改。这样对吗?(对 / 改)
- **输入**:确认 or 改(名/加Crew)。
- **系统动作**:`[AUTO]` 落一份**项目 config**(FLY-648 核心/项目分离:Team名、要哪个Captain+Crew、活范围)。暂不起服务。
- **失败分支**:客户想要多个Team → `先把这一个跑通,回头在 Discord 里跟Captain说一声就能加。` (防一上来贪多)
- **续传**:config 落 state,改动幂等覆盖。

---

## S4 · 录模型 key(Claude)— 3 件亲手事之一 [MANUAL·引导]
- **客户看到**:
  > 你的团队用 Claude 当大脑。有 Claude 的订阅或 API key 吗?
  > 有 → 我引导你安全贴进来(不会显示在对话里)。
  > 没有 → 这个链接注册:https://console.anthropic.com/ ,弄好回来说一声。
- **输入**:CLI **隐藏** prompt 收 key。
- **系统动作**:key → 本地安全存储(OS keychain / 权限 600 文件,**不进 state.json / 不进 git / 不进日志**)→ 发一个最小 test 调用校验。
- **校验**:test 调用 200。
- **失败分支**:
  - key 无效 → `这个 key 连不上——检查有没有复制全,或额度是不是用完了。再贴一次?`
  - 无额度 → `key 对,但这个账号好像没额度了,去充一下再回来。`
- **延迟**:校验 ≤5s。
- **续传**:成功标记 S4 done(不存 key 明文于 state)。

## S5 · 建 Discord bot — 3 件亲手事之二 ⟨默认 C1 自建;C2 捷径可选⟩ [MANUAL·手把手]
> 这是**唯一无法自动化**的一步(Discord 无 API 代建 bot)。目标:手把手带到「点错都难」。配**截图 + 15s 短视频**(脚本见文末附录 A)。

- **客户看到**(一步一确认,每步附截图):
  > 你的团队在 **Discord** 里跟你干活,给你建个专属机器人。跟我做,30 秒:
  > **1/4** 打开 https://discord.com/developers/applications → 右上「New Application」→ 起名(比如你公司名)→ 勾同意 → Create。建好告诉我。
  > **2/4** 左边菜单「Bot」→「Reset Token」→ Copy。把那串贴进我这里的安全输入(不会显示)。
  > [CLI 隐藏输入收 token]
  > **3/4** ✓ 收到。同一页往下,打开两个开关:**Message Content Intent** 和 **Server Members Intent**(见截图)。开好说一声。
  > **4/4** ✓ 连上了、你的机器人在线!最后点这个把它请进你的 Discord 服务器 → [自动生成的邀请链接]。
  > ✓ 它进群了,Discord 这步完成。
- **系统动作**:token→安全存储(同 S4 铁律,**绝不进对话/日志**)→ 连 Discord Gateway 校验 → 用 app client id 生成 **invite-url**(含所需权限 scope)→ 轮询检测 bot 已加入目标 guild → `[AUTO]` 建所需频道。
- **校验**:Gateway 连通 + intents 开 + bot 在目标 guild。
- **失败分支(具体到哪一步)**:
  - token 错/过期 → `这串 token 连不上,回 Bot 页面 Reset 一次再贴。`
  - intents 没开 → `还差一个:Message Content Intent 那个开关还没开(第 3 步截图里红圈处)。`
  - 没邀进服务器 → `还没看到它进群——点一下这个邀请链接,选你的服务器。`
  - **worst-case**(卡住/来回失败 2 次)→ `这步有点绕,要不要我喊 Anna 跟你连屏一起弄?(会有个真人帮你)` → escalate。
- **⟨C2 捷径(默认不推,可选)⟩**:第 1 步前给一句 `想省事?我可以给你一个现成机器人直接邀请——但它身份是 Flywheel 托管的、不是你完全自有。走这条?(默认不用)`
- **延迟**:人手步骤,无超时压;每次校验 ≤5s。
- **续传**:token 存后即使中断,重跑从「开 intents / 邀请」续,不重建 app。

## S6 · 授权 Linear — 3 件亲手事之三 [OAUTH·一点]
- **客户看到**:
  > 你的团队用一个**后台清单**记「要做什么、做到哪」——**你平时不用打开它**,给你留个底。点一下授权就行。
  > [浏览器弹 Linear OAuth → 客户点同意]
  > ✓ 后台清单接好了。
- **输入**:浏览器 OAuth(device flow,**不粘 API key**)。
- **系统动作**:拿 OAuth 授权 → `[AUTO]` 用 API 建 team + routing labels(客户无感)→ 存 token 安全存储。
- **校验**:OAuth 回调成功 + 建 team/labels 成功。
- **失败分支**:
  - 拒绝授权 → `没授权的话团队没法记「做到哪了」,重新点一下?`
  - 浏览器没弹 → 给可复制的授权 URL + `点这个链接授权。`
- **延迟**:OAuth ≤10s + provision ≤5s。

---

## S6.5 · 连接第一件事要用的业务工具(JIT·接入项目)[MANUAL/OAUTH·引导]
> **这是「接入项目」的核心一步(topic 树 Block B)**,之前 draft 略过了。Team 要真出活,Crew 得能读客户的业务系统(Hooves&Paws 样例:Veeqo/Ordoro/Shopify/KV log)。
> **设计原则(研究支撑:「从最显而易见的用例起步」「集成深度>能力」)**:**不前置连全部工具**——只连**第一件事**需要的那 1–2 个,JIT。其余日后在 Discord 里按需再连。

- **系统动作(先判需要啥)**:`[AUTO]` 从 S2/S3 的「第一件事」推断需要接哪些工具(如「盯 dropship 订单」→ 需要订单/库存系统)→ 列出最少必需集。
- **客户看到(每个工具一步,一次一个)**:
  > 你的「订单盯梢」Team 要能看你的订单,得先接上你在用的系统。你今天在用哪个?(我列几个常见的,选或告诉我)
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
  - 权限不够(如只读 scope 没勾)→ `连上了,但还差一个权限:得允许我读你的订单。回授权页勾上「读取订单」再点一次。`
  - key 错 → `这个 key 连不上,去 <系统> 设置里重新生成一个只读的再贴。`
  - 客户的系统没在列表/没 API → 诚实:`你的 <系统> 我还没有现成连接器——先记下,我让 Tadashi 那边看看能不能加;这件事我们可以先用能接的部分做。` 不假装能接。
  - **worst-case**:接不通来回 2 次 → escalate 喊 Anna 陪。
- **权限最小化**:默认只申请**只读** scope(onboarding 阶段不要写权限;写/改动作走运行期 [GATE] 客户批准)。
- **延迟**:每工具 OAuth ≤10s / key 校验 ≤5s。
- **续传**:每个已连工具落 state(token 安全存储,不进 state 明文),中断续连未完成的。
- **⟨tactical-free⟩**:本步不依赖那 3 个战术选择,可直接按此建。

## S7 · 自动安置([AUTO],用户无感)
- **客户看到**(干净进度,非 JSON):
  > 都授权好了,我在把你的团队安置好 ——
  > ✓ 建工作区　✓ 配好Captain和Crew　✓ 让团队常驻　✓ 上线自检
  > 搞定 🎉
- **系统动作([AUTO],映射边界表 B 表)**:脚手架本地工作区（⟨GH：默认砍 GitHub、仓留本地⟩)→ 写 projects.json → 生成+校验 manifest → 装 **OS-portable 常驻服务**(macOS launchd / Linux systemd / WSL2,FLY-648)→ 起 Bridge → 健康检查(bot 在线 + Captain响应)。
- **校验**:health-check 全绿(bot online + Captain 能响应一条内部 ping)。
- **失败分支**:某步失败 → 具体报错 + 自动重试 1 次 → 仍失败 `安置卡在「<步骤>」了,我把详情发 Anna 看看,很快回你。` → escalate(不把栈信息甩客户)。
- **延迟**:典型 30–90s,进度条逐项打勾。
- **续传**:每子步幂等,重跑续。

## S8 · 首次产出 Aha(去 Discord 跟Captain打招呼)
- **客户看到(向导收尾)**:
  > 搭好了!去你的 Discord,你会看到你的「订单盯梢」Team。跟Captain说句话试试,比如「看看我今天有没有卡住的单」。
- **完整首次对话样例(Discord 内,Hooves&Paws 依据;只当样例不承诺定制)**:
  > 客户:看看我今天有没有卡住的单
  > **Captain**:收到,让Crew去查你今天的订单,几十秒。
  > **Crew**(~40s 后):扫完了。今天 26 单 dropship,**1 单需要你注意**:
  > · **#1234 显示 pending,但其实不是丢单** —— 供应商已发货,是确认邮件没被读到,所以状态没更新。
  > · 其余 25 单正常。
  > 要我盯着 #1234 的确认、到了自动更新状态吗?(要 / 不用)
- **为什么是 Aha**:它**真替客户干了一件平时要跨 Veeqo/Ordoro/KV log 几个系统才能还原的事**,给「为什么」的**可信答案**,还主动点出「不是丢单」这种静默失败盲区(T1/T2)。价值=看清风险的**结果**,不是一个 dashboard。
- **系统动作**:向导把「第一件事」预置给Captain(或等客户开口);Captain派Crew→跨源查→回结论 + 下一步选项。
- **失败分支**:第一件事需要一个 S6.5 还没接的工具(客户当时跳过/新需求)→ 诚实回到接入:`这件事我还得看你的<系统>,花 10 秒接一下?`(复用 S6.5 单工具引导)→ 接好再出结果。绝不假装有答案。
- **延迟目标**:首个结果 **≤60s**(呼应研究:time-to-first-value 越短越好)。

---

## 附录 A · Discord 建 bot 短视频/截图脚本(S5 配套)
15s 静音短视频,分 4 卡对齐 S5 四步:① New Application→命名→Create;② Bot→Reset Token→Copy(打码 token);③ 往下滚,开 Message Content + Server Members 两个开关(红圈);④ 回终端贴 token→点邀请链接选服务器。每卡配一句字幕=S5 对应文案。截图同款 4 张作 fallback(视频加载不出时)。

## 附录 B · 贯穿校验/安全清单(给 Tadashi)
- 所有 secret(模型 key / Discord token / Linear token)→ OS keychain 或 600 文件;**不进** state.json / git / 日志 / 对话。
- state.json 只存 cursor + 已完成步 + 非敏感 config(Team名等)。
- 每步 idempotent + resumable;worst-case escalate 到真人,永不把栈信息甩客户。
- OS-portable service 抽象(launchd/systemd/WSL2)= FLY-648 底座提供。

## ⟨待 Annie 拍(全局替换即可,不改结构)⟩
用词 Captain/Crew · ⟨FREE⟩ 免费试露出 · ⟨PRIV⟩ 隐私开场句 · ⟨GH⟩ 砍 GitHub · ⟨BOT⟩ C1 默认 · ⟨MACHINE⟩ 常开机器开场告知。定了我一次性替换 + 锁文案。
