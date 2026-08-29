# FLY-546 耳机模式 — 调研

Issue: FLY-546 (https://linear.app/geoforge3d/issue/FLY-546/voicev15-耳机模式完整-deliverable-离屏推进-per-agent-声线原-546547-合并待-huddle-试跑后开)
日期: 2026-07-07
基于: exploration.md

> 目的:把 exploration §3 七个决策 + §8 gate 裁决落到**代码级事实**,给 plan.md 直接输入。
> 全部结论都有文件/行级证据,标注「已验证 / implement 期再验」。

## 1. voice-core 现状与扩展面(子范围 A 的落点)

**已验证事实**:

- `AnnouncerOptions.voice` 已支持 per-session 声线(`types.ts:67-71`),`EdgeTtsBackend.createAnnouncer`
  透传(`EdgeTtsBackend.ts:44-53`);`TtsEngine.synthesize(text, voice, opts)` 逐调用收 voice
  (`types.ts:157-163`)。**缺口只有映射层**:没有「agentId → 声线参数」的目录与配置源。
- `EdgeTtsEngine`(`EdgeTtsEngine.ts:45-102`)**不支持 per-call rate/pitch**:参数面只有
  `--voice/--file/--write-media`,rate/pitch 只能进全局 `baseArgs`(所有声线共用,不能 per-agent)。
  edge-tts CLI 本身支持 `--rate=±N% --pitch=±NHz`(FLY-960 spike 复现配方里已实测 `--rate=-20%`)。
  → **A 需要扩 TtsEngine 参数面**(向后兼容:新增可选 prosody 参数,旧调用不变)。
- `EdgeTtsAnnouncerSession` 自带串行 speak 队列 + `interrupt()` 清队停播(`EdgeTtsBackend.ts:105-117`)
  ——**单条消息内**的播报原语可复用;§17 的跨消息 FIFO 是其上一层,不存在,需新建。
- voice-core 无任何 discord.js 依赖(纯本机 I/O + Gemini ws)。headphone 纯逻辑模块放这里
  不引入新依赖,符合 543 立的「backend 可插拔、I/O 注入」架构。

**声库盘点(本机 edge-tts 实测,`edge-tts --list-voices`)**:zh-CN 共 8 个——

| Voice | 性别 | 音色标签 |
|-------|------|---------|
| zh-CN-XiaoxiaoNeural | 女 | Warm(现全局默认) |
| zh-CN-XiaoyiNeural | 女 | Lively |
| zh-CN-YunjianNeural | 男 | Passion |
| zh-CN-YunxiNeural | 男 | Lively, Sunshine |
| zh-CN-YunxiaNeural | 男 | Cute |
| zh-CN-YunyangNeural | 男 | Professional, Reliable |
| zh-CN-liaoning-XiaobeiNeural | 女 | 东北口音, Humorous |
| zh-CN-shaanxi-XiaoniNeural | 女 | 陕西口音, Bright |

8 基础声 × rate/pitch 微调,当前 Lead 编制(Tadashi/Aunt Cass/Honey Lemon/Peter/Hiro/Simba/
Belle/Mufasa 等)够分;口音声(东北/陕西)差异度最高,是「不报身份也能听辨」的好素材,但适不适合
给某个 Lead 用是品味题 → **audition kit 交 Annie 真听定稿**(gate 裁决 #7)。zh-TW/zh-HK 声可扩池。

## 2. approval-signal 解剖(子范围 B 的 c 档批准落点)

**已验证事实(全部 `packages/teamlead/src/bridge/approval-signal/`)**:

- **voice 源是预留位**:`ApprovalSignal` 判别联合(`types.ts:11-45`)已含
  `{ source: "voice"; kind: approve|reject|unclear; questionId; prHeadSha; transcriptId }`,
  文件头注释明写「Annie: extensible to voice/image」。→ 本设计是**填位**,不是改架构。
- **唯一可信写入原语** = `writeGateResponseAndRunPostWrite`(`write-gate-response.ts:104-158`),
  guards 齐全:checkpoint 必须 approve_to_ship / questionId 必须等于 session 当前 review 绑定
  (写入时活读,TOCTOU 关死)/ status 必须 awaiting_review / 幂等重试 vs 冲突拒绝。
  → voice 源**只做信号归一**,写入走同一原语,语义零分叉。
- **gate 消息绑定**:`gate-message-binding.ts` — `(questionId, prHeadSha) → gateMessageId`
  持久化为 write-once session_event;`selectCurrentBinding` fail-closed(恰一条才解析)。
  → **队列识别「这条是 approve gate」的钥匙 = Discord message id 反查绑定**:耳机 daemon 播到
  某条消息时,拿 message id 问 Bridge 是否为当前绑定的 ship-gate 消息;是 → 进 c 档批准回合分支。
  非绑定消息**结构上进不了**批准分支(与 reaction 源同款纪律:绝不从 thread 扫描/文本推断目标)。
- **身份**:`canonical-founder-id.ts` — 两配置源(discordOwnerUserId / founderConsent.founderUserId)
  不一致即 null,fail-closed。voice 源同样只认 canonical founder id(归因自她的 VC 音轨,SSRC→user id,
  FLY-960 spike 判据④已真机验证)。
- **开关语义**:现有 `FLYWHEEL_FOUNDER_AUTO_APPROVE`(默认 ON,`=0` 全局杀)+ per-project denylist。
  voice 源在其上叠加**自己的默认 OFF flag**(gate 裁决 #2):`FLYWHEEL_VOICE_APPROVAL`(默认关,
  `=1` 才开)——两道都过才写批准。
- **文本源的分层借鉴**(`text-approval-source.ts`):Tier-2 精确白名单(零 AI)→ 显式错目标引用
  fail-closed → Tier-3 分类器。voice 源**更严**:只走「显式 readback → 精确确认词」一层,
  **不接分类器**(误听代价高;PRD §14 c 档本来就是显式确认,不需要猜)。

**需要新建(implement 范围,plan 细化)**:

- `voice-approval-source.ts`(纯归一,单测友好)+ Bridge 新 endpoint(如
  `POST /api/voice/ship-approval`,Bearer apiToken 鉴权——`/api/*` Bearer 中间件模式已在
  `plugin.ts:1377` 一带,daemon 是本机进程持 token 即可)+ `GET /api/voice/gate-binding`
  (按 message id 查绑定,daemon 判 c 档分支用)+ audit 行(modality=voice + TIV 收据链接 +
  原话转写,复用 FLY-175 founder_consent_audit 思路/FLY-945 attribution 语义,按 Tadashi 裁决)。

## 3. 代发与 Lead 接收(gate 补充② 的验证)

**已验证(本仓可证的部分)**:

- **FLY-944(#484,已 merge)确认**:插件 fork 的 per-group allowFrom 发件人白名单已退役——
  它以前在 mention 检查**之前**就把 sibling Lead 的消息丢掉;退役后「任何作者(含 bot)的真
  `<@id>` @ 能到达目标 Lead」。
- **Codex Lead 路径代码证据**(`lead-backends/codex/mention-gate.ts`):
  - `hasExactMentionToken`(:79-90)对 **bot 作者同样放行**(只有裸名字正则 ③ 限非 bot 作者);
  - Lead **自有 chat/core 频道与 issue thread 不设门**(:151 `!isShared → true`);
  - FLY-898 core-strict 频道 = id-only(真 `<@id>` 或 reply-to-bot)——代发消息带 @ 即满足。
- → **Tadashi 补充②属实,不需要 founder-proxy 白名单**。代发消息固定结构:
  `🎧 Annie(语音)` 前缀 + `<@LeadBotId>` + 引用原消息,两个 Lead backend 路径都会接。

**implement 期再验(设计已留验证步)**:Claude 插件 fork 侧 allowBots 相关 group 配置在生产
各 Lead 的实际值(FLY-944 改的是 fork,行为一致性要真机冒烟一发)。

## 4. 消息 tap 事实(全局消息转语音的采集面)

**已验证事实**:

- Lead 用**自己的 botToken 直发 Discord**(`ProjectConfig.ts:284-292` per-lead botTokenEnv 解析;
  Claude Lead 走 discord 插件、Codex Lead 走 gateway sender)——**Bridge 看不到 Lead 出站消息**,
  exploration D2 的「gateway 是唯一诚实 tap 点」成立。
- issue ↔ thread 映射:StateStore `chat_threads` 表,`UNIQUE(issue_id, channel_id)`
  (`StateStore.ts:1265-1283`);三段式 issue 有 `phase_chat_threads` 侧表(每 phase 一 thread)。
  **StateStore 是 sql.js(内存+全量导出写盘,FLY-663)——跨进程直读不安全** → daemon 拿
  issue/thread 上下文必须走 **Bridge 查询 endpoint**(新增 `GET /api/voice/context?channelId=`,
  返回 {issueId, issueIdentifier, issueTitle, agentId, stage}),不碰 db 文件。
- 频道范围素材:leads[].chatChannel + generalChannel(`ProjectConfig.ts:220`)+ chat_threads /
  phase_chat_threads(上述 endpoint 可给全集或 daemon 缓存)+ alertChannel(v1 不进队列,
  告警不是「Lead 发给她的消息」;可后续配置扩)。
- roundtable:`headphone.includeRoundtable` 开关(默认 false,gate 裁决 #1);开了也走同一
  FIFO,无特权。
- Lead bot user id 集合:botTokenEnv → token → bot user id 需一次 Discord API 自查
  (`GET /users/@me`)或配置显式声明;daemon 启动时解析 + 缓存,解析失败的 Lead fail-loud
  记日志(不静默漏听)。

**报头素材(身份→issue→一句进度)**:身份 = leads[].agentId(显示名);issue = thread 映射的
issueIdentifier + title;「一句进度」v1 = StateStore session stage 的白话化(如「code review 中」)
——正文本身就是进度详情,报头只做定位。三样都从 `GET /api/voice/context` 一次拿齐。

## 5. 545 接口合同(exploration §4,gate 已批、Tadashi 同步给 545)

five-interface 合同不变:`speak(agentId, text)`(用 VoiceDirectory 解声线、可 barge-in)/
`onFounderUtterance(transcript, final)`(归因 canonical founder id 音轨)/ `onFounderSpeakingStart`
(<100ms 停播)/ `presence(founderInVc)` / `postTiv(channelId, card)`。

FLY-960 spike 给 545 的实现约束里与 546 相关的:per-speaker SSRC→user 分轨(归因基础,已真机验证)、
speaking-start 去重、`joinVoiceChannel` 必须 clientReady 后。546 不重复背,只依赖行为结果。

## 6. 口令与模式状态

- **进入(打字路径,v1 主路径)**:daemon 的 gateway tap 已订阅 messageCreate → 对
  #flywheel-core(项目 generalChannel)监听 author=canonical founder id + content 精确匹配
  「芝麻开门」/「/headphone on」→ 开模式。零新基建。
- **进入(语音路径)**:她已在 VC 时说「芝麻开门」→ 545 的 onFounderUtterance 精确匹配。
- **退出**:「芝麻关门」精确短语(语音或打字)→ FSM 进 CONFIRM_EXIT 态 →「确认结束耳机模式?」
  → 「对/确认」→ 退出 + 口头 recap(处理 N 条、剩 M 条留 Discord)。**全部精确匹配,无 NLP**。
- **模式状态持久化**:daemon 本地 JSON 状态文件(`~/.flywheel/headphone-state.json`:mode、
  队列快照、游标),崩溃/重启恢复;不进 StateStore(不属于 Bridge 会话域,避免跨进程写)。
- **离 VC**:presence=false → 暂停播报、照常入队;回来续推;不自动退出(gate 裁决 #4)。

## 7. 结论 → plan 输入

1. **A 声线**(不依赖 545,先行):`VoiceSpec {voiceId, rate?, pitch?}` + `VoiceDirectory`
   (agentId→VoiceSpec,fallback 默认);`TtsEngine.synthesize` 加可选 prosody(向后兼容);
   `leads[].voice` 配置字段 + 校验;audition kit 脚本(每声线 × 同一段报头样本)交 Annie 定稿。
2. **B-1 纯逻辑层**(不依赖 545):voice-core `headphone/` 模块——FIFO 队列、回合 FSM
   (ANNOUNCE→ASK→WAIT_DISPOSITION→[DICTATE→READBACK→代发]→next;c 档批准分支;
   CONFIRM_EXIT 分支;mid-turn 入队;沉默=defer;barge-in 语义),I/O 全注入,单测全覆盖。
3. **B-2 tap daemon**(不依赖 545 的 VC 面):gateway messageCreate 订阅 + 过滤(Lead bot 集合 ×
   频道范围 × includeRoundtable)+ 入队 + 口令打字路径 + 状态持久化。
4. **B-3 Bridge 面**:`GET /api/voice/context` + `GET /api/voice/gate-binding` +
   `POST /api/voice/ship-approval`(voice-approval-source 归一 → writeGateResponseAndRunPostWrite;
   FLYWHEEL_VOICE_APPROVAL 默认 OFF;audit 行);TIV 收据卡先贴、后写批准。
5. **B-4 VC 接线**(依赖 545):five-interface 合同对接(speak/utterance/bargeIn/presence/postTiv),
   动手前发 ask 对齐 545 现状。
6. **验收**:Annie 戴耳机离屏一段真实工作流全程语音推进;QA=Opus 独立,真 Discord E2E。
