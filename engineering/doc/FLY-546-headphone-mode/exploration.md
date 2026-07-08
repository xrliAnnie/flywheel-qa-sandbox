# FLY-546 耳机模式 — 探索

Issue: FLY-546 (https://linear.app/geoforge3d/issue/FLY-546/voicev15-耳机模式完整-deliverable-离屏推进-per-agent-声线原-546547-合并待-huddle-试跑后开)
日期: 2026-07-07
基于: 无

> 上游输入(非同文件夹): `product/doc/FLY-906-voice-product-experience/prd.md`(APPROVED v0.17,§13/§14/§17 为本 issue 权威)、
> `engineering/doc/FLY-958-prd-eng-issue-breakdown/proposal-906-voice.md`(#6+#7 = 本 issue)、
> `engineering/doc/FLY-960-stt-dave-spike/spike-report.md`(GO,选型 A)。

## 1. 问题与目标

Annie 目前离开屏幕就断联:多个 Lead 的消息、gate 问题、批准请求全部堆在 Discord 里等她回来看。
FLY-546 = 一个**完整可用的耳机模式**:她说「芝麻开门」进入后,**所有 Lead 发给她的消息转成语音、
按 FIFO 一条条推给她**,每条一来一回(skip / 口述回复代发),不可逆动作走语音批准 + 文字收据,
说「芝麻关门」+确认步退出。

两块子范围(issue 权威描述):

- **A. per-agent 声线(原 FLY-547,先行)**:每 agent 独立声线(换 agent 换声线,理想不报身份也能
  听辨);Edge TTS voice 参数 per-Lead 配置起步,辨识度真听调优。
- **B. 离屏推进本体**:「芝麻开门/关门」对称口令+确认步、全局消息转语音、§17 FIFO queue
  (推不拉/一来一回/报头「身份→issue→一句进度」/mid-turn 静默入队/skip 或代发才进下一条)、
  §14 c 档语音批准 + TIV 文字收据。

**验收 = Annie 戴耳机离屏,一段真实工作流全程语音推进**(PRD §17 worked example 是逐字样板)。

## 2. 现状审计(brainstorm 前 codebase 事实)

### 2.1 voice-core(FLY-543 落地 + FLY-959 四修)

- 双能力面契约已在:`announce`(Edge TTS,speech-out)/ `converse`(Gemini Live,in+out),
  `packages/voice-core/src/types.ts`。
- **announce 面已支持 per-utterance voice**:`AnnouncerOptions.voice` → `EdgeTtsAnnouncerSession`
  每次 `speak()` 用创建时的 voice;`TtsEngine.synthesize(text, voice, …)` 逐调用传 voice。
  缺的只是「agentId → voice 参数」的映射层与配置来源(现在全局单一 `config.voice`,默认
  zh-CN-XiaoxiaoNeural)。
- `EdgeTtsAnnouncerSession` 自带串行 speak 队列 + `interrupt()`(清队+停播)——**单条消息内**的
  播报/打断原语现成;§17 的跨消息 FIFO/回合状态机是它上面一层,不存在。
- 无任何「Discord 消息 → 语音」的桥;voice-core 目前只有本机 mic/afplay/ffplay I/O。

### 2.2 FLY-545 并行现状(Huddle,同分支族)

- FLY-545 = A. voice bridge(常驻 #huddle VC 实时音频 runtime:bot 进/出、TTS 播音、单「耳朵」bot
  收音、TIV 状态行+earcon、MOVE_MEMBERS、barge-in)+ B. /meet 端到端 + C. 结论落地。
- **545 worktree 目前零产出**(clean,HEAD=main)——本设计不能引用它的代码,只能**定义接口假设**
  (§4),implement 时按 Lead 编排指示对齐(545 未落 main 则基于其分支协调或先做不依赖部分)。
- FLY-960 spike(GO)给了收音管线的硬约束:`@discordjs/voice` 0.19.2 + `@snazzah/davey` 0.1.12;
  per-speaker 按 SSRC→user id 天然分轨(**Annie 的话语可归因到她的 Discord user id**);
  speaking-start 去重必须做;`joinVoiceChannel` 必须在 clientReady 后。

### 2.3 founder 批准现有机制(§14 c 档必须复用的那道闸)

- Bridge `approval-signal/` 已有两个**批准信号源**:founder TEXT 回复(text-approval-source +
  classifier)和 founder REACTION(reaction-approval-source),都:
  - fail-closed 绑 **canonical founder Discord id**(`canonical-founder-id.ts`:两配置源不一致即拒);
  - 经 `write-gate-response.ts` 写 CommDB gate response;runner 侧 `verify-approval` 绑 pr_head_sha 核验;
  - 有 kill-switch(`FLYWHEEL_FOUNDER_AUTO_APPROVE=0`)+ per-project denylist。
- 所以「语音批准」的正确形态 = **同一 gate 机制加第三个信号源(voice)**,不是新闸——与 PRD §14
  「照旧走现有 founder gate,不新增语音专属闸」一致:gate 不变,**信号采集媒介**多一种。

### 2.4 「Lead 发给她的消息」在系统里的真实流向

- Lead(Claude session + discord 插件)**用自己的 bot token 直发 Discord**(chatChannel / 每 issue
  的 [FLY-XX] chat thread / generalChannel);**Bridge 看不到这些出站消息**(Bridge 只管自己发的
  gate/founder-page 等)。founder-page 类通知也是发进对应 issue thread(FLY-818/605)。
- ⇒ 想拿到「所有 Lead 发给她的消息」,**唯一诚实的 tap 点是 Discord gateway 本身**(一个 bot 订阅
  messageCreate),不是 Bridge 事件流。
- 消息作者集合可从 ProjectConfig `leads[]`(agentId + botTokenEnv → bot user id)推出;频道范围
  可从 chatChannel / generalChannel / StateStore chat_threads 推出。

### 2.5 声线配置的自然落点

- `leads[]`(ProjectConfig)已是 per-Lead 配置家(agentId / chatChannel / botTokenEnv / model /
  backend…),加一个可选 `voice` 字段(voiceId + 可选 rate/pitch)是最顺路径;不配 = 默认声线
  (字节兼容)。

## 3. 关键设计决策(选项 + 推荐)

### D1. 耳机模式的宿主:复用 545 voice runtime(推荐)vs 独立 daemon vs 塞进 Bridge

- **推荐:与 545 的 voice bridge 同一个 voice daemon 进程族**。耳机模式需要的音频原语
  (bot 在 VC 播 TTS、耳朵收音+STT、barge-in、TIV 发卡)与 Huddle 完全同集;545 的 issue 描述
  就叫它「常驻 #huddle VC 的实时音频 runtime」。546 在其上加一个 **HeadphoneMode 编排层**。
- 不塞 Bridge:实时音频与 Bridge 事件循环生命周期/延迟特性完全不同(545 拆解已定此调)。
- 不另起第二个音频 daemon:两个 bot 进程管同一个 VC 的播音权与 barge-in 会互相打架。
- **风险缓解**:545 未落地前,546 的队列/状态机/声线层全部按「注入式 I/O 接口」写(§4 接口假设),
  不 import 545 的实现;真接线放 implement 后段。

### D2. 全局消息 tap:Discord gateway 订阅(推荐)vs Bridge 事件流 vs Lead 侧改造

- **推荐:voice daemon 的 bot 订阅 Discord gateway messageCreate**,过滤条件(全部可配):
  ① 作者 ∈ 已注册 Lead bot user id 集合(从 leads[] 配置解出,启动时解析一次+定期刷新);
  ② 频道 ∈ founder-facing 范围:各 Lead chatChannel + 各 issue chat thread(含其下线程)+
    generalChannel;**排除 #leads-roundtable**(Lead 对 Lead,不是「发给她」);
  ③ 或任意频道内 @她(canonical founder id)的 Lead 消息(兜底)。
- Bridge 事件流覆盖不了(§2.4);改造每个 Lead 出站(双写队列)侵入面大、且漏 Bridge 自己发的
  founder-page。gateway tap 对 Lead/Bridge **零改动**,拿到的就是她本来会在屏幕上读到的原文。
- PRD 说「所有 Lead 消息(不是子集)」——v1 以上述范围作为「所有」的工程定义(= 她实际会读的
  founder-facing 面),roundtable 噪音排除;此定义在 gate 里向 Lead 明示。

### D3. 队列 + 回合状态机:voice-core 新模块(纯逻辑、I/O 注入)

- **推荐:`packages/voice-core` 新增 headphone 模块**(`HeadphoneQueue` + `HeadphoneTurnMachine`),
  纯 TypeScript 状态机,**不 import discord.js**;音频 I/O(speak/listen)、消息源、TIV 发卡、
  批准写入全部走注入接口。这样:① 单测可全覆盖(回合边界、mid-turn 入队、skip/代发、口令、
  确认步全部可确定性测);② 545 管线未就绪也能先做完 + 测完;③ 与 543 已立的「backend 可插拔、
  brain 正交」架构同调。
- 状态机(§17 逐字 worked example 直译):
  IDLE →(队首出队)ANNOUNCE(报头:身份→issue→一句进度 + 正文;长文只报头+摘要问「要听全文吗」)
  → ASK(「要回吗?」)→ WAIT_DISPOSITION →
  「skip/不用」→ 该条完结 → 下一条;
  「要回」→ DICTATE(她口述)→ READBACK(读回意图摘要)→ 代发 → 完结 → 下一条;
  沉默 = defer(该条回队尾/挂起,**不代表同意**);
  全程:mid-turn 新消息静默入队尾;她开口 barge-in(<100ms 停 TTS);queue 空 = 静默待命。
- 特殊回合:c 档批准回合(D5)与 stop word 回合(D7)是状态机的两个显式分支,不靠 NLP 泛化。

### D4. 代发(她口述→agent 发出):voice bot 结构化转发(推荐)

- **推荐:voice daemon 以自己的 bot 身份把她的口述发进原消息的频道/thread**,固定结构:
  `🎧 Annie(语音)` 前缀 + @原 Lead bot + 引用原消息。**绝不冒用她的账号**。
- 集成风险(要真机验):Lead 侧 mention-gate / reply-guard 对 bot 作者的处理(FLY-267:名字正则
  仅非 bot 作者;@mention 路径 + allowBots 配置需确认放行)——research 阶段给出结论,必要时
  在 Lead 规则/插件配置里把 voice bot 列为 founder-proxy 白名单(配置项,不改判定逻辑)。
- 归因安全:**只转发归因到她 user id 音轨的话语**(SSRC→user id,spike 已验);VC 里其他人的
  声音不会被当成她。

### D5. §14 c 档语音批准:新增 voice 批准信号源(同 gate、fail-closed、默认关)

- 流程(状态机批准分支):队列读到一条**绑定 approve gate 的消息** → 正常报头+正文 → 她表达
  批准意图 → **显式 readback**(「你确认把 FLY-901 ship 上线?」)→ 她说「确认」→
  ① 先发 **TIV 文字收据卡**(gate id、pr head、原话转写、时间)进该 issue thread;
  ② 再经 Bridge 的 approval-signal 第三源(voice)写 gate response(复用 write-gate-response +
  canonical founder id fail-closed + 现有 kill-switch 语义),audit 记 modality=voice + 收据链接。
  Runner 侧 verify-approval 完全不变。
- 归因链:她的「确认」必须来自**她 user id 的音轨**(DAVE E2EE 会话内 SSRC→user)+ 显式 readback
  匹配;任何不确定 → 不写批准、口头告知「这条我没把握,收据卡贴在 thread 里,你回屏幕确认」。
- **默认 OFF 的 feature flag** 起步(如 FLYWHEEL_VOICE_APPROVAL=0 默认),真机 QA + Annie 试用后
  再开——批准面是 authority 面,按 FLY-175/945 的谨慎惯例走。跳过/回复类(a/b 档)不受此 flag 限制。

### D6. per-agent 声线(子范围 A,先行)

- 配置:`leads[].voice`(可选,`{ voiceId, rate?, pitch? }`),不配 = 项目级默认;voice-core 加
  `VoiceDirectory`(agentId → 声线参数,含解析/校验/fallback)。Edge TTS 的 rate/pitch 走
  `--rate/--pitch` 参数(EdgeTtsEngine 已可传 args)。
- 辨识度:从 zh-CN 声库挑**性别/音色/语速差异最大化**的一组(Xiaoxiao/Yunxi/Yunyang/Xiaoyi/
  Yunjian/liaoning-Xiaobei/shaanxi-Xiaoni…),产出 **audition kit**(脚本:同一段报头文本 ×
  每声线合成样本)供 Annie 真听 → 定稿映射写进配置。「理想不报身份也能听辨」= 验收听测,
  报头仍恒定播(PRD 双保险)。
- 交付顺序:A 先行(独立于 545,纯 voice-core + 配置),B 复用 A 的 VoiceDirectory。

### D7. 口令与模式开关

- **进入**:#flywheel-core 里她(canonical founder id)**打字或说**「芝麻开门」(/headphone on 同义)
  → voice daemon 开全局模式 + 建/复用 VC 会话(她已在某 VC → MOVE_MEMBERS 零-tap;否则发
  Join 按钮)→ 开始推队列。文字入口先行(零误触发、无 STT 依赖);语音入口 = 她已在 VC 时说。
- **退出**:只认「芝麻关门」精确短语(不做 NLP 泛化)→ 系统「确认结束耳机模式?」→ 「对」→
  退出 + 口头 recap(处理了几条、剩几条,剩余留在 Discord)。打字「芝麻关门」同效(带同款确认)。
- **模式状态持久化**(daemon 重启恢复 ON/OFF + 队列游标);她离开 VC = 播报暂停、消息照常入队,
  回来续推;**不自动退出**(退出只认口令,PRD 语义)——此点作为假设报 Lead。

## 4. 对 FLY-545 管线的接口假设(协调合同)

546 状态机以注入接口消费 545 的能力;545 落地后按此对齐(或反向适配):

| 接口 | 方向 | 内容 |
|------|------|------|
| `speak(agentId, text) → {done, interrupted}` | 546→545 | 用 VoiceDirectory 解出的声线在 VC 播 TTS;可被 barge-in 打断 |
| `onFounderUtterance(transcript, final)` | 545→546 | 归因到 canonical founder id 音轨的近实时转写(utterance 级) |
| `onFounderSpeakingStart` | 545→546 | barge-in 信号(<100ms 停播) |
| `presence(founderInVc: boolean)` | 545→546 | 她在/离 VC(暂停/续推) |
| `postTiv(channelId, card)` | 546→545/自有 | 状态行、收据卡、代发消息(也可 546 自己持 bot 发) |

**Implement 期编排(Lead 已指示)**:545 voice bridge 未落 main → 先做不依赖部分(A 声线全部、
B 的队列/状态机/tap/配置 + 单测),真 VC 接线基于 545 分支协调,动手前发 ask 对齐、不重复造管线。

## 5. 方案取舍(整体形态,2 案对比)

- **方案一(推荐):545-runtime 复用 + voice-core 纯逻辑层 + Bridge 第三批准源**。
  优点:一条音频管线、状态机可离线全测、批准复用既有 fail-closed 机制;缺点:跨 3 个部件接线,
  对 545 有时序耦合(用接口假设 + 编排缓解)。
- **方案二(否):独立「耳机 bot」daemon 全自包含(自己进 VC、自己收发、自己写批准)**。
  优点:与 545 零耦合、可先独立跑;缺点:两套 VC 音频 runtime 长期并存(播音权/收音互踩)、
  DAVE 收音管线重复造(违背 Lead「别重复造管线」指示)、批准路径若自造 = 新闸(违背 PRD §14)。
- 方案二只在一种情形下降级启用:545 长期未落地且 Annie 急用 A+B 的非 VC 部分——不预设,发生再报。

## 6. 风险

1. **545 时序**(最大):真 VC 端到端验收依赖 545 管线落地。缓解 = §4 接口合同 + 先做独立部分。
2. **消息 tap 的「全」**:v1 范围定义(D2)可能漏她在意的源(如 alert channel);gate 里明示范围,
   真用后可配置扩。
3. **Lead 侧接受代发**:bot 作者消息被 mention-gate/reply-guard 拦的可能;research 定论,最坏
   加 founder-proxy 白名单配置。
4. **语音批准安全面**:归因/误听风险 → fail-closed + readback 精确匹配 + 默认 OFF flag + TIV 收据;
   任何不确定不写批准。
5. **STT 质量**(口述代发的转写错误):readback 一道 + 发出后消息本体可在 Discord 改;不可逆动作
   有 c 档双确认。
6. **Edge TTS 依赖**:声线全押 edge-tts 云服务;543 已留 TtsEngine 可插拔位(Azure fallback slot),
   本 issue 不扩后端。

## 7. 留给 gate 的确认点(brainstorm gate 一并问)

1. D2 的「全局消息」v1 范围定义(chatChannel + issue threads + generalChannel + @她;排除
   roundtable)是否符合 Annie 的「所有」直觉。
2. D5 语音批准 = Bridge 第三批准源 + 默认 OFF flag 起步,是否接受。
3. D6 声线配置落 leads[].voice、audition kit 交 Annie 真听定稿,是否接受。
4. D7 「离开 VC 不自动退出、只认口令退出」假设是否成立。

## 8. Brainstorm gate 裁决(Tadashi,2026-07-07 · 理解正确、7 决策全批)

1. **a) 全局消息范围**:按 D2 定义,但 roundtable 排除改成**「默认排除、config 可开」**——
   新增 `headphone.includeRoundtable` 开关(默认 false),不写死。理由:roundtable 是 bot 对 bot
   高频互聊会淹队列,但 Annie 的「所有」直觉可能包含它。(会贴 thread 给 Annie 可否决。)
2. **b) 语音批准第三源 + 默认 OFF ✅**:批准类写操作 fail-closed 起步;**复用 FLY-945 刚上线的
   founder-attribution 语义**;真机 QA + Annie 试用满意后再开。
3. **c) leads[].voice ✅**(不配=默认声线、字节兼容)。
4. **d) 离 VC 不自动退出 ✅**(暂停+入队);显式「芝麻关门」+确认步才退出,不做 NLP 泛化。
5. **补充①**:§4 接口合同策略照走(speak/onFounderUtterance/bargeIn/presence,真 VC 接线前发
   ask 对齐);**Tadashi 会把这份合同同步给 545**。
6. **补充②**:FLY-944 上周已把 allowFrom 白名单退役,现在**任何人(含 bot)的 @ 都触发目标
   Lead** → research 验证此条;若属实,D4 不需要 founder-proxy 白名单。
7. A(声线 audition kit)先行给 Annie 真听定稿。

## 9. Annie 拍板(2026-07-07,经 Lead 转达 · 覆盖 §8 部分裁决,以本节为准)

1. **消息范围**:各 Lead 频道 + issue thread + 主频道 + @她;roundtable 默认排除 ✅
   (保留 config 开关)——与 §8.1 一致,维持。
2. **语音批准 = 真批准,测试通过后直接默认开**(覆盖 §8.2 的「默认 OFF 起步」):不留长期
   opt-in flag;她原话「我们先都测试好,确定可以用之后再打开…之后边用边修」。→ 实现语义:
   `FLYWHEEL_VOICE_APPROVAL` 改为 **kill-switch**(默认 ON,`=0` 仅急停回滚),整个功能的
   enablement 门 = **ship 前 QA 真机验证 founder 归因链**;readback + TIV 收据卡 UX 保留。
3. **声线基础现在全打好**(强化 §8 第 7 条):flywheel 下**每个 Lead 的 leads[].voice 都配上**
   差异化合理默认值(ship 时 ops 步骤);audition kit 照做;**具体每个 Lead 用什么声线 =
   Annie 和 Honey Lemon 的产品决定**——工程职责 = 「换声线 = 改一行 config」的基础。
4. **退出方式**(覆盖 §8.4「离 VC 不退出」):**她离开语音频道 = 退出耳机模式**(主退出路径,
   她的直觉「点退出不就退出了」);工程加防抖:**短暂掉线(60s 内重连)不算退出**,静默恢复;
   「芝麻关门」降级为**可选口头等价路径**(保留);进场口令「芝麻开门」保留。
