# FLY-906 Voice 产品体验 — 外部 UX 参考调研

Issue: FLY-906 (https://linear.app/geoforge3d/issue/FLY-906/voice-产品体验设计pm-共创-设计prd喂给-542-实现树)
日期: 2026-07-06
基于: exploration.md · prd.md(同文件夹)

> Annie R4 要求把 PRD 做细,并授权做 research 补外部参考。本文档 = 两路并行 web research
> 的提炼(Discord voice 产品 UX / voice-first 交互;voice 对话延迟规范 / 结论落地 UX)。
> **只作产品体验参考,不做技术选型**(后端归 eng / FLY-883)。给 prd.md Part II 当依据。

## 1. Discord voice 界面 & bot 如何呈现

- **四种 voice 面**:常规 **Voice Channel**(对称、drop-in、成员列表显示谁在、进出提示音——
  小型「聊清」最合适)/ **Stage**(广播式,1:1 不合适)/ **Voice Messages**(异步语音夹,
  非对话面)/ **Text-in-Voice(TIV)**——**每个 VC 自带的文字聊天**(2022 起),在语音里能看到
  文字气泡。
- **TIV = 关键**:实时 transcript、action 卡片、书面结论的天然落点——artifact 落在对话发生的
  同一个频道。
- **bot 在 VC 里**:与真人成员一样(头像进成员列表);说话时 Discord 画**原生绿色说话圈**
  (唯一免费视觉信号);**无原生"AI/听写"UI**——字幕/状态得由 bot 自己发进 TIV。
- **现状**:没有打磨好的大众级 Discord VC 语音 AI bot 可抄(AICord / DiscMeet / SeaVoice 都是
  indie;Discord 自家 Clyde 是纯文字且 2023 已杀)。**UX 标杆是 ChatGPT 语音 / Gemini Live**,
  不是 Discord 里的任何东西。
- **Slack Huddles 心智模型**:纯音频、刻意模拟"路过工位"、打字↔说话一键切、无"开会"仪式感、
  95% CSAT——启示:入口要一步、要随意、别有会议框架感。

## 2. 会话进入 & 唤起

- 四种进入模型:wake word(hands-free 但有开销/误触)/ push-to-talk(零误触但 hands-busy 不行)/
  开麦+VAD(最自然但收 TV/自言自语)/ **「进频道=开始听」**(Discord 原生,最优:**加入 VC
  这个动作就是唤醒词**,物理在频道内=会话边界;meeting bot 都这么干——bot 可见地进会=录制开)。
- 参考:**Alexa Follow-Up**(答完再听 ~7s 免唤醒词)/ **Alexa Conversation Mode**(显式开、
  开麦、有可见 on-态、口头关)/ **Gemini Live**(最像"chores 模式":后台/锁屏续跑,Hold=静音留
  上下文、End=结束出 transcript)/ **ChatGPT Voice**(一键进/一键出,**退出把 transcript 追加进
  文字会话**——"语音会话留文字凭据"的范式)。
- **干净结束是被低估的一半**:好产品都把结束与一个 deliverable 配对(Gemini→transcript、
  Otter→summary、我们→结论贴进 TIV);结束不给产物=对话像蒸发。

## 3. 听/想/说 状态信号 & barge-in

- 状态词汇范式:**Alexa 光环**(蓝=听、转 cyan=想、蓝/cyan 交替=说、红=麦关)/ **ChatGPT 声球**
  (一个球以运动区分听 vs 说)。**Discord 只给一个免费视觉=绿说话圈(只表"说")**;听/想得靠:
  presence 状态、bot 在 TIV 编辑的状态行(🎙听/🧠想/💬说)、或 **earcon 提示音**。
- **她不看屏时,音频线索 > 视觉**:短 ack 音 或 口头 filler("嗯,稍等")用于 >1s 的思考。
- **barge-in**:一等权利;她一开口 TTS 须 **<100ms 停**;要区分真打断 vs backchannel(嗯/对/笑)
  ——backchannel 不打断;打断后把没说完的暂存,让 LLM 决定续/弃/重答,别重头念。

## 4. 语音触发有后果的 action:安全但不啰嗦

- **治理框架(Google Conversation Design)**:误识别代价低→**隐式确认**(做了+说做了,如"手电开了");
  代价高/难撤销→**显式确认**(readback+yes/no);显式确认太多会让对话变慢。
- 落地标定:**Siri 发消息**=readback("要发吗?")且是**用户可调的档**(设置里可关确认)——信任随
  时间转交用户,非写死;**Alexa** 智能家居=隐式、购物=显式结账、支付=升级到语音码——干净的
  **三档梯子:直接做 / 口头确认 / 凭据确认**。
- **重复即 UX**:readback 关键槽位("周二 3 点,对吧")兼作纠错面。
- **诚实空白**:没有"语音批准 AI agent 真实开发动作"的公开参考——这是新territory;最接近的代理 =
  上面的 Siri/Alexa 梯子 + Flywheel 现有 founder-gate 合同。

## 5. 语音对话延迟规范(业务层)

- **人类基线**:对话轮次间隔中位 ~200ms(Stivers 等 10 语言);人靠"边听边规划回复"达成——AI
  若等你说完才想,永远慢半拍,除非流式/预测。
- **业务band(用户停说→agent 开口,即首音时间)**:<300ms 瞬时 / **300-800ms 生产甜区** /
  800-1200ms 可察觉但可接受 / **>1500ms 机器感、有压力反应** / **静默零反馈 >3s = 用户以为崩了**。
  今天多数拼接栈中位 1.4-1.7s,靠 masking 活着。
- **首音 ≠ 全答**:业界都优化**首音<500ms**(流式 TTS 40-200ms)、让全答想多久多久——感知锚在
  agent **何时开始**回应。
- **masking(纯 UX,非后端提速)**:ack/filler("嗯,让我查下")能让 ~1000ms 感觉像 500ms;
  流式先说第一句;思考 earcon。**注意**:每轮都 filler 会显得脚本化,只在真答会慢时用。
- **端点判定**:语义端点(小模型判"说完没")是 2025-26 标准——"我的邮编是…"会等、"对"立即答;
  裸静默阈值每 ms 都是每轮加的延迟。Vapi 默认停顿 0.4s;VUI 重提示静默 ~1.5s、>3s 读作死。

## 6. 结论落地(voice→结构化产物)& 信任

- 范式:**Otter/Fireflies/Zoom**(bot 录制→自动 summary+抽 action item→推 Slack/CRM);
  **Granola**(当红:用户先记粗要点,AI 会后增强成结构化——**人给种子**是它更被信任的原因,
  summary 锚在你标重要的地方);**voice-to-task**(Todoist Ramble:语音→LLM→结构化任务的
  **预览,确认/改后才建**)。类别通则:**快速 capture 进用户已经在看的系统,不是静默后台归档**。
- **信任破坏面(Zoom AI Companion 有据)**:把 action 分派给**没参会的人**;summary 质量隔夜
  静默退化;长会 summary 含糊/出错。机构部署(Stanford/Cornell/UDel)都收敛到**默认 summary
  仅 host 可见→人审核后再分发**。
- **信任建立面**:(a) 产物落在用户已经工作的地方(不是新 silo);(b) summary 可追溯到源
  (回链 transcript/引用);(c) 给用户一个快速的 **review-then-commit**,而非自动发布;(d) 产物含
  用户自己的话/标记(Granola 范式)。
- **诚实空白**:没找到 auto-summary 信任率 / action 抽取准确率的公开量化研究——证据是产品评测 +
  机构政策,非 benchmark。

## 7. 非技术用户的语音 UX

- 白话是 Nielsen 启发式 #9;错误说人话、说清哪错了、给下一步,**绝不暴露系统术语**。
- **错误恢复是纪律不是边角**——语音是易逝的,用户没法重读。Google 错误 playbook:首次没听清→
  **快速重提示**(只问缺的那块、隐式证明其余听到了)、给示例、**连续 no-match ≤3 次**后优雅退出/
  升级,别死循环。
- 非技术/年长用户从故障恢复更难,受益于**多重同时恢复策略**(重复+给选项+确认部分理解)。
- 听错名字/术语:**confirm-by-consequence**("我把它归到 payments 项目——对吧")优于 parrot 回念
  乱码 ASR。

## 8. 目标数字一屏总表

| 指标 | 目标 | 依据 |
|------|------|------|
| 人类轮次间隔(基准) | ~200ms | Stivers 等 |
| Huddle 首音 | ≤800ms 好 / ≤1.2s 可接受 / >1.5s 破 | AssemblyAI/Hamming/Famulor |
| 长答前的 ack | ≤1s("让我查下") | Hamming filler |
| 静默零反馈 | 绝不 >3s | O'Reilly VUI |
| 端点停顿容忍 | ~0.4-0.7s(语义,非裸静默) | Vapi/LiveKit |
| barge-in | 常开,<100ms 停 TTS,忽略 backchannel | FutureAGI/LiveKit |
| no-match 重试 | 短重述×1,总 ≤3,再优雅回落文字 | Google |
| Huddle 后 capture | 口头 ≤3 项 recap→口头确认→建 issue+归档带链接 | Granola/Ramble/Zoom 综合 |

## 9. 诚实空白(如实转告,勿当定论)
1. 没有打磨好的大众级 Discord VC 语音 AI bot 可抄(标杆是 ChatGPT/Gemini Live)。
2. 没有"语音批准 agentic 开发动作"的公开参考(Siri/Alexa 购买梯子是最好代理)。
3. Discord 无自定义"在听"指示的 API——绿圈之外的状态得靠 earcon + TIV 文字。
4. 无 auto-summary 信任率 / ambient async 语音协作的公开量化研究("chores 模式"无直接 shipped 对标,
   最近似 = 对讲机 UX + 异步语音便条,该处建议为外推非引用)。

## 10. 车载「读+回」语音流(Android Auto / Siri CarPlay / Alexa Auto)—— 异步多-agent 交互对标

> 给 §17 离屏多-agent 语音模式当交互借鉴。诚实注:各家不公开逐字 VUI 脚本;下文措辞是官方
> 文档 + 实测文章 + 论坛拼装,**跨版本有变**(Android Auto 2024-26 Assistant→Gemini 迁移、
> iOS 15→18 Siri 变化);**结构模式稳定**,引号里的话是代表性非合同。

**三家独立收敛到同一契约**(单条最大 takeaway):浅推(身份报头 + 提示音)→ 深拉(正文按需读)
→ 开麦处置回合(回 / skip)→ 默认发前确认 + 可选自动发 → 严格一条一条 → 用户掌握节奏。
**我们的 delta 只在两处:报头更重(agent+issue+进度)、queue 策略(优先级类 vs 纯 FIFO);
其余照抄别自己发明。**

- **消息流四拍骨架**:earcon → 身份报头 → 正文(或摘要)→ 开麦问处置(「回 / skip / 听详情?」)。
  Google 驾驶模式逐 sender:「hear it, reply, or skip it?」;Siri:tone → 「X said: …」→ 自动开麦
  听回复(回复回合不用唤醒词)→ 读回 + 问「send it or change it?」。
- **报头/正文两深度**:Siri 对**长消息只报 sender、不读正文**——正合我们"报头重"的处境:
  **报头必念(身份+issue+一句进度),正文按需**(她可能已忘 issue 123 是啥,先给进度提示)。
- **发前确认默认、可选关**:Siri「Reply Without Confirmation」/ iPhone「Automatically Send」;
  Google 驾驶模式直接自动发——而**静默自动发会吓到人**(用户投诉证据)。→ **不可逆动作强制确认**
  (§14 c 档),其余可随时间开自动发(Siri 式)。
- **多消息 = 纯 sequential per-sender FIFO**;「skip」是队列前进动词;**新消息入队不打断**在进行的
  读/回;同一 sender 堆积可 AI 摘要(Google >40 词或多条触发摘要)。
- **回复机制**:每条后自动开麦(做家务不能每句唤醒词)、读回再确认、可语音改、silence=defer 不发、
  拒绝无愧疚不重问。长指令**读回意图摘要**而非逐字复述。
- **hands-free 安全元规则**(Google Design for Driving / Apple CarPlay HIG):每次交互**纯语音可完成、
  零必需瞥屏**;**可中断 + 可恢复、用户掌握节奏**(「暂停/待会」中途要能用、该条回队列);
  **一回合一个决定**(不问复合问题);短固定语法。音频版约束 = **每条推送硬词预算**(报头各项 ≤ 一
  短句),超了降级为按需拉。

**⚠️ 对 Annie「FIFO 无优先级」的诚实 push(不是覆盖,是把取舍摆出来让她定)**:三家都发现消息
其实有优先级类(时效/直接 vs 全部)。我们的**阻塞类**(某 Lead 的 gate 问题在等她拍)若排在 9 条
FYI 进度后面,会拖慢解阻塞。**便宜方案 = 2-3 个类(阻塞 / 普通),不是打分系统**:只有最高类主动
推,其余等她拉(「还有别的吗?」)。**v1 尊重她的简单 FIFO**;此为 flagged 未来可选项,经 Lead 抛回她定。

## 11. Stop Word 选词(唤醒词可靠性 → 退出安全词)—— 给 §13 耳机模式退出

> 结束 always-on 会话的「Stop Word」= 与唤醒词同一工程问题,但**误差代价反过来**:唤醒词怕漏
> (FR),结束词怕误挂(FA)。据 Picovoice/Sensory/Apple ML/Amazon Science + 中文语音芯片厂
> 选词指南 + 安全词 UX。

- **唤醒词标准**:≥3 音节 / ≥6 音素(「Alexa」6 音素);**音素多样**(独特声学签名 → 少误报);
  **日常不说的词**(Amazon 选 Alexa 因"日常不用" + 独特 X 音);**「Hey/OK」前缀**加音素且标
  "有意唤起";跨说话人发音一致;**避近音词**(Echo 曾对 89 个词误触:Alexis/allegedly…)。
- **中文标准**(启英泰伦/聆思):**4 字**为宜;**塞音声母**(b/p/t/d/k/g)+ **开口韵**(a/ai/an/ao;
  避 e/i/en/in)+ **四声**(例:灌溉);避重复/相似邻音、避日常语。
- **FA vs FR + Apple 双阈值**:严主阈值(低 FA)+ 低"第二次机会"阈值——边界分进更敏感态,**立刻
  重说即触发**。→ 结束词照此:阈值调严;边界时听重说 或 软问「要收工吗」。
- **结束词的代价不对称**:误接受 = 会话中途死(毁掉 always-on 信任);误拒 = 再说一遍(~2s)。→
  **跑在比唤醒词严得多的工作点**。
- **安全词原则**:「不/停」当安全词失败,因为它们在活动中自然出现;安全词必须是"你平时不会说的
  词",一说即无歧义真结束(red/pineapple)。→ 我们的 Stop Word 要对**她做家务闲聊(中英双语)**
  都 out-of-distribution。
- **裸"停/stop"不可用**:「Alexa, stop」是唤醒词前缀后才进意图;裸 stop 只在窄上下文(闹钟响、
  Follow-Up)靠 device-directed 分类器(甚至要面对摄像头)。我们无摄像头 → 靠**名字前缀 /
  上下文门控**。
- **短语 > 单词**:单词误接受高,靠加音素(通常加前缀)修;**名字前缀短语**还编码"在对你说"。
- **确认步**:VUI 只对高风险/不可逆动作用显式确认,滥用惹烦。**关键问:结束真不可逆吗?** 若重开
  只需一句话,结束就便宜 → **别问"确定吗"**,改 **ack 播报 + ~30s「回来/come back」撤销窗**;
  只在**边界打分时软确认**(Apple 第二次机会)。
- **中/英 code-mixing 证据薄**:无 CN 优于 EN 的对照证据;她中英混说 → 选一个在**两种语言里都
  没近音、都不是闲聊常用**的词/短语。

**选词 checklist(全满足)**:①≥3 音节/≥6 音素(中文 4 字)②塞音+开口韵(中文四声佳)③她两种
语言的家务闲聊里都不出现、无近音 ④不是常用词的子串/前缀 ⑤她说着自然、疲惫分心时发音也稳
⑥agent 名字前缀或自带 address 标记 ⑦检测器严(低 FA)+ 边界第二次机会。

**候选**(供 Annie 选):

| 候选 | 语言 | 为什么работает |
|------|------|---------------|
| **芝麻关门** zhīma guānmén | 中 | 4 音节,塞音 g + 开口 an/en,芝麻开门的反转=好记,对话里基本零基率 |
| **飞轮收工** fēilún shōugōng | 中 | agent 名前缀=address 门控(单说"收工"有风险:"我先收工了",前缀修掉);4 音节 |
| **下课下课** xiàkè xiàkè | 中 | 四声×4、塞音 k、叠词=刻意标记;若她常聊真"上课"需避 |
| Flywheel, over and out | 英 | 名字门控 + 无线电"通话结束"语义通用;6 音节极独特 |

**推荐**:短语(4+ 音节)、**名字前缀**(=业界对"怎么知道不是随口一说"的答案);**不做硬两步确认**,
用 严阈值 + 边界软确认 + ack + ~30s「回来」撤销窗。中/英由 Annie 按顺口选(中文候选更贴她母语直觉)。

## 12. Discord Huddle 机制(真实能力)—— 给 §12.0/§12.1 发起+拉人

> Annie 明确要:基于真实 Discord 能力设计最顺的「发起 Huddle→拉指定 Lead 进语音频道→聊→落
> action items」。以下带引用。

**能力表(能 / 不能):**

| 能力 | 结论 | 备注 |
|------|------|------|
| bot 按命令进语音频道 | ✅ | `joinVoiceChannel()`(需 GuildVoiceStates intent) |
| bot 播音(TTS 输出) | ✅ 官方稳定 | AudioPlayer;DAVE 下 send 正常 |
| bot 收音(STT 输入) | ⚠️ **非官方 + 脆弱** | Discord 不官方支持 bot 收音;**且 @discordjs/voice 0.19.x 在强制 DAVE 下收音当前坏(重连环/零采集/DecryptionFailed)** |
| **ring/强拉「没在语音里的人」进服务器 VC** | ❌ **硬 NO** | ring 只存在于 DM/群 DM;服务器 VC 无 ring(多年社区头号请求未满足)。第三方(RingVC)只是 opt-in DM ping 假装 |
| 强制 move「已在语音里的人」进某 VC | ✅(仅限已连语音) | Modify Guild Member `channel_id`「if they are connected to voice」+ MOVE_MEMBERS |
| 多个 bot 同在一个 VC(各 TTS+STT) | ✅ | 每 token=独立成员;一 bot/guild 一条语音连接;收音 `VoiceReceiver.subscribe(userId)` 出 per-speaker 流(多说话人可按 user 分离) |
| bot 按需建/删 VC | ✅ | Join-to-Create 生态成熟;正常 rate limit,Huddle 频率无压力;代价=频繁 churn 权限/审计噪音 |
| 人的一键 join | ⚠️ 1-2 tap,非零 | 贴 VC 深链 `discord.com/channels/<guild>/<vc>`:桌面点即进,手机弹「Join Voice」确认 |

**crux(明确说)**:**Discord 不能 ring / 强拉 Annie 进语音频道(她没在语音里时)。** bot 能 100%
自动进;**她进必然一次主动 tap**。唯一"拉人"原语:她若已在服务器任一 VC → MOVE_MEMBERS 可零-tap
挪她进 Huddle。Slack Huddle 本身也是 ring + 一键 Join(不强制),所以 UX 差距其实小(一个推送通知
tap vs 弹窗点击)。

**推荐机制 = 一个常驻复用 `#huddle` 语音频道**(非每场临时频道):稳定深链可 pin(她的"huddle 按钮")、
稳定权限、TIV 文字历史=天然 Huddle 存档;临时频道增建延迟/权限重设/丢文字历史,1-founder 规模零收益
(临时频道方案完全可行,留作并发需求时的后备)。

**流程**:①发起=她 `/huddle @Peter @Hiro`(slash 最顺,回复直接带进 VC 的按钮);②被点名 Lead bot
~1s 自动 joinVoiceChannel(#huddle)(这半个"ring"完美);③"ring"她=@通知(推送=ring)+ Join 链接/按钮,
她 tap 一下(桌面)/tap+确认(手机);**她已在某 VC 则 MOVE_MEMBERS 零-tap**;落地 Lead 在她进来瞬间
语音招呼(像被接住);④聊=各 Lead TTS(稳)+ 指定**一个 bot 当"耳朵"做 STT**(共享 transcript 给其余,
只一条进程吃脆弱收音);⑤她说结束/离开(voiceStateUpdate)→ 一个 Lead 贴 summary 卡 + 落 1-2 个 Linear
issue 到 `#huddle` 自带文字区 → Leads 断开。

**风险(诚实写进 PRD)**:①**收音(STT)是最脆弱的腿** —— 非官方 + 0.19.x 在强制 DAVE 下当前坏
(#11419);缓解:patch davey / 用 py-cord 当"耳朵"bot(据报可用)/ 本地采音绕开。**这是全 PRD 头号
可行性风险**(归 eng)。②TTS 发送侧安全(官方、DAVE 下正常)。③ring gap 不可修 —— 把"推送通知+一键
join"做到极好,别假装能强拉。

## 主要来源
延迟/轮次:AssemblyAI 300ms rule · Hamming · Famulor · Telnyx · Stivers(PubMed)· Frontiers ·
LiveKit turn detection · Vapi · O'Reilly Designing VUI · FutureAGI barge-in · Full-Duplex-Bench(arXiv)。
落地/信任:Granola review · Otter/Fireflies/Zoom 对比 · Zoom AI Companion 评测 · UDel 政策 · Todoist Ramble ·
Google conversation-design(confirmations/errors)· Nielsen 启发式 #9。
Discord:Discord blog(Stage vs VC / TIV / Voice Messages)· Slack Huddles · Salesforce eng ·
AICord / DiscMeet / SeaVoice · discord.js green-ring issue · Alexa Follow-Up/Conversation Mode/light ring ·
Gemini Live help · ChatGPT Voice Mode FAQ · Siri 确认 · Alexa 语音码。
(完整 URL 见两 research agent 原始输出;时效敏感,实施前复核。)
