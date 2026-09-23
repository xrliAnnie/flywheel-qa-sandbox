# FLY-2786 语音架构讨论页 — 调研
Issue: FLY-2786 (https://linear.app/geoforge3d/issue/FLY-2786/语音架构讨论页-founder-亲测语音延迟大漏听要一页可互动-html现在三种模式随身语音-rg-耳机模式-会议)
日期: 2026-09-22
基于: exploration.md

> 本文件只比较方向,给 founder 讨论页用;不是实施计划。每个方案的「实现量」是量级判断(推断),不是排期。

## 1. 延迟到底花在哪(用 exploration §2.1 的实测拆)

把 U1 / U2 的「说完 → 第一个字」(≈38s / ≈18s)按性质分三类:

| 类别 | U1 | U2 | 能不能靠「修管道」拿掉 |
|---|---|---|---|
| 听懂(静 500ms + 转写) | 2.1s | 1.2s | 基本拿不掉(server_vad 500ms 是 9 月初同值) |
| 搬运(镜像、邮箱、推给 Lead、两层轮询、整段合成后才播) | 23.3s | 8.6s | **大部分能**:推送代替轮询、门铃必达、边合成边播 |
| Raya 想(一整轮 Codex turn) | 12.5s | 8.2s | **拿不掉**:只要每句话都走 Lead 一整轮,就要付这一段 |

结论:即使把搬运全部修到接近 0,「每句都过 Lead」这条架构的下限仍是 **转写 1–2s + Raya 一轮 8–12s ≈ 10–15s**(n=2,量级)。这就是她感觉「比 9 月初差很多」的根:9 月初简单问题根本不进后台。

## 2. 方案对比

### 方案 A — 前台快答 + 后台 Raya(Lead 提出的方向)

- 形状:保留今天**直连 OpenAI Realtime**(不走 app-server,绕开 FLY-2655 的断点),但把前台从「只念稿」改回「能自己答」:`create_response:true`,instructions = Raya 人设 + 记忆摘要 + 当前 thread 近况;加一个函数工具 `ask_lead`(语义同 9 月初 `background_agent`)。简单的前台直接答;要查、要做、要判断的,前台先说一句「我去问一下 Raya/我查一下」,工具调用走**今天现成的邮箱通路**进 Lead,Lead 的文字回来后以 `function_call_output` 交还前台,前台用自己的声音说。
- 依据:Realtime GA 支持会话内函数工具与 `function_call_output` → `response.create`(developers.openai.com `guides/realtime-mcp`);OpenAI 官方 `openai-realtime-agents` 把这列为 Pattern 1「Chat-Supervisor」——实时模型直接答简单的,复杂的交 supervisor,并建议先说一句填充语。
- 延迟预期:简单问题 ≈ 9 月初量级(同为 gpt-realtime-1.5 + server_vad 500ms 自动回话);本管线**未测**,参考值 `/gemini` 自带脑子真人 0.86s(FLY-1347 `voice-measurement-pack.md:17`,另一条管线)。交给 Lead 的问题:立即有一句口头回应,答案本身仍是「Raya 一轮 + 搬运」≈ 今天量级,修掉搬运后约 10–15s。
- 记忆 / 能力从哪来:快答只知道我们塞给它的(人设、记忆摘要、近期 thread);**不带 Lead 的工具和实时状态**。凡是需要事实、动作、承诺的,必须走 `ask_lead`。
- **要推翻的既有裁定(两条)**:① 09-08 founder 直令 F2/F3「语音转写成文字进 mailbox、走与文字完全相同的路,由 Lead 回复」(FLY-2446 `exploration.md:17-18`)—— 快答句**不进** Lead 的 mailbox/turn,Lead 不知道前台说了什么,除非另设留痕;② 09-22 FLY-2655「Realtime 不得独立回答」。仍保留的是 F1(独立 voice 进程、任何 Lead 可挂)与 F4(会议通用),交办句仍走 F2/F3 的文字通路。
- 快答留痕:今天语音进程只把**她的**话镜像进 thread(`delivery.ts:119-171`);前台自己说的话目前没有去处。方案需新增「🤖 前台:…」镜像行(拟议,未验证),且该行必须被 Bridge 轮询排除以免被当成 Lead 回复再念一遍 —— 今天的排除前缀恰好含 `🤖`(`voice-session-poller.ts:12`)。
- 与 Lead 工作是否冲突:快答完全不碰 Lead;只有 `ask_lead` 占 Lead 串行队列里的一个 turn(同今天)。
- 对 Claude 系 Lead:`ask_lead` 的另一头就是今天的文字邮箱,与厂商无关 ⇒ Opus/Fable Lead 同样可挂。
- 实现量(推断):中。改 `voice-codex/src/realtime.ts` 会话配置与事件处理(工具调用、流式出声)、`session.ts` 的回合编排;delivery / 邮箱 / Bridge 通路基本复用。
- 风险:① 前台会「把能力说大、编事实、说我已经做了」—— FLY-1851 §20/§44 已记录(FLY-2446 `exploration.md:111`),9 月初 Raya 靠「效果权威规则」提示词压(`raya apps/voice/src/cli.ts:98-104@b1b5a64`);② 两个声音(前台 vs Raya 本人)说法可能不一致,她要能分辨「这是前台说的」还是「Raya 说的」;③ 打断(`interrupt_response`)要重新设计,今天是关的;④ 部分推翻 09-08 F2/F3 与 FLY-2655「不得独立回答」—— 需要 founder 明确改口。

### 方案 B — 复原 9 月初「自带脑子」(Codex app-server realtime v2)

- 形状:另起一个 Codex 进程,`thread/start` 带 IDENTITY+MEMORY,`thread/realtime/start v2`,由 app-server 自带的 `background_agent` / `remain_silent` 做分流(exploration §3)。
- 延迟预期:快(`create_response:true`);逐句**无实测留痕**,只有 founder 本人 9 月初的体感。
- 记忆 / 能力:第二个 Codex 线程,带身份与记忆文件,能跑命令;**不是 Raya Lead 那个活着的会话**,看不到 Raya 此刻在做什么,除非另读。
- 与 Lead 工作:不占 Lead(独立进程)。代价是**两个 Raya 大脑**并存——这正是 FLY-2445/2446 要消掉的东西(FLY-2445 `plan.md@04ff8800a:150`「不得从旧 cli/AppServerClient 复制出新的专属 Codex 脑」)。
- 对 Claude 系 Lead:不可用,只有 Codex 有这套 realtime(FLY-2446 `exploration.md:198`)。
- 实现量:代码在 raya 仓历史里,但**今天这条路不通**,B 是「历史复原候选」,不是可直接启用的能力:生产实证 app-server realtime v2 `session.created` 被标 unsupported(FLY-2655 `exploration.md:54`);当前本机实证 本机 as-of 2026-09-23T03:46Z:Raya 实际在跑的二进制 `~/.codex-raya/…/0.154.0` → `codex features list` 为 `realtime_conversation removed false`;另一个 PATH 上的 `~/.local/bin/codex` 0.153.2 为 `under development false`。要走通得 pin/升级 Codex,那是全舰共享载体(FLY-2655 当时拒绝的 B 路)。
- 风险:高,且被上游版本卡住。

### 方案 C — 不改架构,只修管道(对照组)

- 形状:保留「每句都过 Lead」。修:门铃必达(U1 的 12.7s)、Bridge → 语音进程推送代替 3s+4s 两层轮询、边合成边播代替整段缓冲、说话人归属不再整句丢弃、进房不念主频道状态。
- 延迟预期:下限 ≈ 转写 1–2s + Raya 一轮 8–12s ≈ 10–15s(§1)。
- 记忆 / 能力:完整 Raya。与 Lead 冲突:同今天(每句一个 turn,与其他工作串行)。
- 实现量:小到中,风险低。
- 定位:它修的是 A 里「交给 Lead」那一半也要修的东西;单独做,体验到不了 9 月初。

### 推荐(给她讨论用,不是定案)

**A 为主,C 的管道修复作为 A 的一部分一起做;B 不推荐。** 理由:A 拿回「简单的马上答」,保留 9-08 的 F1(任何 Lead 可挂)与 F4,交办句仍走文字通路;代价是快答句不再走 F2/F3;B 被上游卡住且会重新长出第二个大脑;C 单做到不了她要的体感。
A 真正要她拍板的是一件事:**允许前台用自己的话回答**(部分推翻 09-08 F2/F3 与 FLY-2655「不得独立回答」),以及她能接受前台答错时怎么提示。

## 3. 她的三个问题 —— 回答要点

1. **能不能直接让 Raya 的 Codex 用语音跟我聊**:历史上 Codex app-server 有过实验性 realtime 接口,9 月初的第二个 Codex 进程用过;今天没有一条已证可用、受支持、能直接挂到 Raya Lead 本线程的 Codex 原生语音路径(生产实证 + 当前本机实证)。想要「Raya 本人的 Codex 线程直接开口」还会撞上:这个线程同时在跑 Discord、Runner 督办,还和你的 TUI 共用(`codex-lead-tui-runtime.ts:18-22`)。⇒ 行不通的是「直接」,行得通的是 A(Realtime 当前台,Raya 当后台)。
2. **Claude 系 Lead**:方案 A/C 的后台接口是文字邮箱,Opus/Fable Lead 能用;方案 B 只有 Codex 能用。需要补的:Claude Lead 侧防二次摄入镜像消息(未验证),以及一场真实的 Claude Lead 会议 QA(生产从没跑过 meeting)。
3. **进语音时原来的工作能不能继续**:今天:Runner 照跑;但 Raya 本人每听你一句就要停下做完这一轮,别的消息排在后面,反之亦然(串行队列)。A:快答不占 Raya;只有 `ask_lead` 占。B:完全不占,但那是另一个大脑。

## 4. 会议模式单独说明

语音进程与 Bridge 外层与 rg 共用(exploration §1),所以镜像、邮箱、两层轮询、整段合成这些等待机制都在;「收件 → Lead 想 → 回帖」随被挂的 Lead 而变:Raya 分支有 rg 实测可参考,Claude Lead 分支(tmux 收件)未读实现、未测;会后才派 Runner 写纪要,不影响会中延迟。生产从未跑过 meeting,**会议端到端未测,不能与 rg 比快慢**。
