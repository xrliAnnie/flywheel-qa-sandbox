# FLY-1347 Voice measurement pack — 交付物(HL measurement run 底料)

Issue: FLY-1347 (https://linear.app/geoforge3d/issue/FLY-1347/docshl-voice-measurement-pack-gemini-系测法-qa-记录-runbook-两坑-env-清单hl-今早要)
日期: 2026-07-17
基于: research.md(同文件夹;全部数字可回溯出处见 §5)

> 给 Honey Lemon:四条 voice 管线怎么测、判定标准是什么、latency 数怎么量怎么报、
> 要配哪些 env、以及 runbook 没写的坑怎么绕。所有数字引自既有 QA 记录并标注当时
> load —— 本包不产新实测数,你的 measurement run 才是产新数的地方。敏感值全部打码,
> 只给变量名 + 来源文件。

## 0. 一页速览

| 管线 | 命令 | 状态(2026-07-17) | 机器可测什么 | 真人层 | 延迟基线(附 load) |
|------|------|-------------------|--------------|--------|---------------------|
| Huddle 会议 | /glaw (FLY-545) | founder 真机 FAIL ×2,修复中(FLY-1158 会议 7 分钟死窗) | 灌音频受限:huddle 场景自灌合成音跑不出真多轮 | **必须 Annie 真声**(最终验收 = 北极星 A8) | 识别延迟比 /gemini 明显慢(defect ⑤,未量化) |
| 语音助理 | /gemini (FLY-967/1047/1065) | ✅ SHIPPED+DONE,Annie 验收「一来一回正常」 | WAV 经 ears seam 注入可测全部时序判据(需 `FLYWHEEL_VOICE_QA_PRESENCE_OVERRIDE=1`,FLY-1353 seam;负向对照:`=0` 须复现停 `invoked`) | 已过(真麦多轮 + barge-in + 离房 landing) | 开场首 chunk 0.76-0.80s;打断→cancel 0.73-1.4s;真人 speaking-end→response 0.86s |
| ElevenLabs 语音 | /eleven (FLY-1006) | 机器侧 PASS;P6 Annie 真人 FAIL(barge-in 风暴),修复中 | WAV 注入全链可测(STT→脑→TTS→VC 回放→打断) | sonnet 档复听待 Annie(Lead 排时段) | **冷启动 haiku 中位 8.3s@load6-7 / 9.2s@load51(即「7-10s」);sonnet 中位 3.6s@load5.8 / 5.2s@load16** |
| 语音派活 | /gemini-advanced (FLY-1018/1159) | 代码 merged(default-off);**Enablement 硬门未过,不许真启用** | harness 文本驱动深链;QA-6 真机挂 enablement | Annie 真声 = 声学闭环(⏳) | 深链异步(即时口头 ACK 8-12ms + 深跑几十秒到一两分钟) |

**排 measurement run 的直接含义**:① /gemini 是唯一「已验收、可放心量」的管线;
② /eleven 是 latency 主战场,harness 现成、但要等 barge-in 修复落地才值得复测真人层;
③ /glaw 和 /gemini-advanced 当前分别被 kickback 修复与 enablement 硬门挡着,先别排。

## 1. 测法与判定标准(跨管线通用)

### 1.1 Chrome-as-Annie E2E(standing 语音 QA 姿势)

Annie 授权的 standing rule(FLY-612 起,FLY-1041 再确认)。纪律:**只在隔离
thread/venue、只发测试内容、全程留档**(截图 + API 回读)。

- **voice 场景**:Chrome web 登录 discord.com → 以 Annie 登录态进 staged VC →
  **全程 self-mute**(API 核实 bot=false mute=true)→ 满足 founderPresent 条件。
  「替身没在说话」不要靠 mute UI 观察(不可靠,FLY-1047 有两观察对不齐的实录),
  用 daemon ears **帧计数器**做管道级证明(静默窗口 forwarded frames = 0)。
- **验收分层**:Chrome-as-Annie 自测(as-Annie pre-run)通过后,才 @Annie 做
  founder signoff;QA 绝不代替她下体感结论。
- **依赖**:headed Chrome + Annie 的 Discord 登录态(缺登录态只能 park 等她登一次)。
  claude-in-chrome 断连修法:杀 native host → 重启 Chrome → 点开扩展面板重注册。

### 1.2 两层测试模型:注入 WAV(机器层)vs 真人层 —— 缺一不可

**能力边界(gemini 系的关键 nuance,两条记录都真)**:

- 单 daemon、注入时机可控的场景(/gemini):探针 WAV 经 `allowUserIds` ears seam
  注入,**能**驱动 Gemini Live(触发回答与 cancel,FLY-1047 实证:注入后 2.5s
  response started)→ 时序类判据可机器化。
- 多方 huddle 场景(/glaw)与语音派活真声段(/gemini-advanced):合成音**跑不出**
  真多轮 / 覆盖不了真语音段(FLY-545 QA 复盘 + FLY-1159 Tadashi 书面裁决)→
  真语音体验只能 Annie 真声,那正是验收测试本身。

**为什么两层都要**(/eleven 的血泪对照,m2-annie-p6-session.md):

| | 干净 WAV 预验 | Annie 真人语音 |
|---|---|---|
| 输入 | 短、干净、无自然停顿 | 带停顿/呼吸/半句 |
| local barge-in | 极少 | **单场 8+ 次** |
| 延迟 | 中位 6.4s(4.3-7.5) | R1 1.5s → **R2 28.5s 雪崩** |

预验证明「管道通 + 理想输入下的延迟」;真人层暴露「真实语音下 barge-in 风暴 →
延迟雪崩」。measurement run 两层都排,分开报数。

### 1.3 latency 量法(报数口径)

- **指标** = speech-end→真答案首音:session jsonl 里的
  `first_audio.sinceSpeechEndMs`(事件序:`speech_end → [cue_start/cue_stop] →
  user_transcript → first_audio`)。
- **样本与口径**:n≥4,报**逐轮 + 中位 + 当时 load**;冷/暖档(RESUME、模型档)
  显式标注;有垫话配置时注明「垫话准点 vs 真答案」分开量。
- **load 是一等公民**:同管线同档,load 5.8 vs 16 中位差 ~1.5s;/eleven 的
  founder-report 曾因写「典型 3-4 秒」不标 load 被 QA doc kickback,硬改成
  「低 load 3-4s / 正常 load ~5s」。**不带 load 的延迟数会被打回。**
- **冷启动基线(那组 7-10s 数的准确出处,/eleven,冷 claude -p)**:
  - haiku×fresh:8848/7141/7739/10283ms,中位 ~8.3s(load ~6-7,implement S8);
    QA 复跑 9089/8173/9377/10582ms,中位 ~9.2s(load ~51)。
  - sonnet×fresh:3913/9540/3034/3377ms,中位 ~3.6s(load ~5.8;1 轮 9.5s 离群 =
    模型 API TTFT 长尾);QA 独立复测 6089/4519/4741/5589ms,中位 ~5.2s(load ~16)。
  - **硬地板(已向 Annie 讲明)**:claude -p 订阅形态 ≈ 脑 2-3.5s + 平台 STT/TTS
    ~1s ⇒ **3-4.5s/轮**;进 1-2s 只有付费 API 直连或平台自带脑(两者都违当前约束)。
- 成本随测:/eleven 用 usage 快照跑前跑后记账(credits-ledger 逐行,QA 曾抓出
  +500 未记账缺口 —— 每步可归因)。

### 1.4 判定标准(fail-closed + 负向对照)

- harness 全部 **fail-closed,exit code 为准**;判 PASS 前先跑**负向对照**证明
  harness 不会假绿(/eleven 实例:shim health 指死地址 → 期望 exit 1;
  `STAGED_HEALTH_PORT=9878`(生产端口)→ 期望 exit 2 拒跑)。
- Discord 侧证据要**回读双证**:消息按 message id 从 Discord fetch 回读逐字核对,
  「发出去了就算」不算证据(FLY-1065 口径)。

### 1.5 语音 QA 硬判据(FLY-545 起固化,新验收门)

语音命令的 QA,必须由 QA 自己灌真音频跑一整场端到端才算过:

1. 说话 → 收到 → 回话 → **≥3 轮连续对话不掉线**;
2. **主动打断 / 触发连接 abort,验证断后「对话层」真恢复**(不只连接层 reconnect
   —— FLY-1158 实锤:reconnect 接回了线,对话层又哑了 3 分钟);
3. **环境噪音场景**(VAD 不被杂音误打断)。

`earsJoined:true`、单测绿、单轮通、连接层 reconnect,**都不算过**。这条门就是
FLY-545 两轮 founder FAIL 买来的教训。

## 2. 分管线 QA 记录卡

### 2.1 /glaw — FLY-545 huddle mode(Gemini Live 多 Lead 会议)

- **状态**:founder 真机 FAIL 两轮(07-10 三缺陷;07-11 FLY-1158 会议第一轮后
  **~7 分钟死窗**,「说话没人理」),kickback 修复中。
- **测法**:`packages/voice-bridge/e2e/glaw-injector.mjs` 灌探针音频 + 抓非注入者
  音频;但 huddle 场景自灌合成音跑不出真多轮(QA 复盘盲点:headless 自灌只到
  「meeting live + 单轮」就判 GREEN,漏掉断联)→ §1.5 硬判据由此而来。
- **已知 defect(测前必读)**:① P0 连接脆弱 + 重连后对话层不恢复(疑 assembly
  并发饿死 Gemini WS keepalive;load 10 也断,非纯负载);② P1 cue 状态撒谎
  (只反映 VAD);③ P1 音效缺 + 识别 gap 无即时反馈;④ P1 环境杂音误打断;
  ⑤ P2 识别延迟比 /gemini 慢。
- **复现指针**:`engineering/doc/FLY-545-huddle-mode/evidence/qa-verdict-opus.md`
  (判据与时间线)、`fly1158-evidence.txt`(死窗铁证)、`deploy-kit.md`(部署清单)。

### 2.2 /gemini — FLY-967 基座 + FLY-1047 barge-in QA + FLY-1065 文本面板

- **状态**:✅ SHIPPED+DONE(#535 merged),Annie 验收「感觉还不错,一来一回的」。
- **测法 A(时序判据锚点法,FLY-1047)**:三判据 + 阈值 —— ① 打断→cancel ≤3s
  (实测 0.727s / 1.4s);② 静默 68s 零误掐(管道级证据 = ears 帧计数器 0 帧);
  ③ 开场首 chunk ≤15s(实测 0.76-0.80s)。手法:探针 WAV(pcm_s16le 48k stereo,
  ffprobe 核实)经 `allowUserIds` ears seam 注入;daemon log + probe log 双 log 对时。
  真人层黄金证据:Annie 真麦 speaking-end→0.86s response、真人 barge-in cancel、
  founder-leave landing。
- **测法 B(staged Discord E2E,FLY-1065)**:`fly1065-staged-discord.mjs` ——
  真 Gemini → 真 Discord caption(pool-05 bot 落 staged #General)→ 真 Linear
  staged issue 纪要+逐字记录;message id 回读双证 + Claude-in-Chrome 视觉确认。
- **复现指针**:`FLY-1047-gemini-bargein-opening-qa/evidence/qa-verdict.md`(锚点表
  + 复验轮)、`FLY-1065-voice-transcript-panel/evidence/staged-discord-e2e.md`(跑法)。

### 2.3 /eleven — FLY-1006(ElevenLabs 平台耳嘴 + Claude 脑)

- **状态**:代码/机器侧 PASS(单测 226/226 + 真机三腿);P6 Annie 真人 FAIL
  (barge-in 风暴,defect ①去抖 ②文本 surface ③文字处理态,修复中)。
  **measurement run 待排 = 本包直接下游**(逐段暖脑延迟,池稳后)。
- **测法**:`e2e/eleven-staged.mjs`(leg 0 起一轮)+ `e2e/eleven-voice-loop.mjs`
  (`ELEVEN_LOOP_LEGS=mutex|audio`,**分进程跑**,见 §3 附录坑)。audio 腿覆盖
  注入 WAV→STT→claude 脑→TTS→VC 回放 + barge-in 停播(+0 bytes 尾巴)+ 存活
  (transcript 2→4)。latency 从 harness state 目录 jsonl 取
  `first_audio.sinceSpeechEndMs`(§1.3 全部基线数出自这里)。
- **验收剩余项**:P6 = Annie 真人 VC 对话(sonnet 档复听,Lead 定时段);
  barge-in 去抖修复后真人层复测。
- **复现指针**:`FLY-1006-eleven-product-e2e/evidence/m1-rig.md`(30 秒 rig 重建
  runbook)、`m2-staged-venue.md`(harness 全套复现命令 + env)、
  `m2-sonnet-latency.md`(换档对照 + venue 启停规矩)、qa-report.md §六(全步骤)。

### 2.4 /gemini-advanced — FLY-1018 建造 + FLY-1159 语音接线

- **状态**:default-off 代码 merged(Annie 面前不出现);FLY-1159 route A 机器层
  QA PASS,声学闭环 = Annie 真声 ⏳。**真启用被 Enablement 硬门挡住 —— 未过
  checklist 不 enable、不请 Annie**(qa-report §0,不可跳)。
- **Enablement checklist 摘要**(= 你排它的 measurement run 前的硬前置):
  FLY-882 池 claim 测试 bot(Tadashi 手续)→ 配 `~/.flywheel/gemini-agent.json`
  binding → 设 env(见 §4.4)→ 起 daemon → QA-6 Chrome-as-Annie 真机全链
  (派活/查状态/记 memory/ship 意愿呈报,截图留证)→ M4 scoped-token 403 取证
  → 审计 JSONL 抽查。全绿才许真启用。
- **测法**:`packages/gemini-agent/scripts/harness-delegate-replay.mjs`(文本驱动
  深链,需 GEMINI_API_KEY;曾抓到 mock 测不出的真 wire bug —— abortSignal 误进
  body 400)。即时 ACK 实测 8-12ms;深跑异步(几十秒到一两分钟),完成口播 +
  文字落地。
- **复现指针**:`FLY-1018-gemini-advanced-build/qa-report.md`(§0 checklist)、
  `harness-evidence.md`、`FLY-1159-gemini-advanced-voice/qa-report.md`(§3 Annie
  真机测试指引五步)。

## 3. runbook 没写的两坑(+ 附录小坑)

对照基线:`docs/RUNBOOK.md`(2026-03 Slack 时代,零 voice 内容)与各 issue
enable-runbook 均未收录以下内容。

### 坑 1:venue 与 staged harness 抢同一个 Discord voice session(必撞)

**同 bot 同房只能有一个语音客户端。** P6 live venue(Annie 试听用,常驻)在跑时
再起 staged harness,双方 supervisor 会互相把对方踢下线再自动重连 —— 症状是
探针进不了 STT、`Cannot perform IP discovery - socket closed`、ears 连接
ready↔signalling 打摆,**latency 测试直接假 FAIL**(FLY-1006 两次实录,当时
误猜了一轮换档原因才定位到)。

**规矩**:跑 staged harness 前 **先停 venue**(`kill $(pgrep -f p6-live-venue)`),
跑完**用捕获的原 env 原样重启** venue 并做健康检查(health 端口 ok、bots online、
ears 进房、命令注册)。FLY-1047 同款纪律:venue 开窗由 Lead 本人停,QA 不碰
venue 进程。

### 坑 2:staged/生产 env 隔离与 sourcing(配错 = 悄悄打生产或起不来)

三件事,每件都有实锤:

1. **跑 staged 前必须剥掉生产 `FLYWHEEL_BRIDGE_URL` / `FLYWHEEL_API_TOKEN`**
   (m2-staged-venue.md 复现命令原话「剥掉生产」;否则 staged 会话把事件打进
   生产 Bridge)。harness 侧有端口守卫兜底:`STAGED_HEALTH_PORT=9878`(生产)
   → exit 2 拒跑,隔离用 :9879+ —— 但守卫只护 health 端口,BRIDGE_URL 得自己剥。
2. **`GEMINI_API_KEY` 在 `~/.zshrc` 而不在 `~/.flywheel/.env`** —— launchd
   wrapper/daemon source 不到 zshrc,常驻程序直接起不来(FLY-545 部署清单实锤;
   deploy-kit.md 明确要求拷进 .env)。
3. **staged rig 的 env 走独立文件**:`~/.flywheel/qa-fly967-staged/.env.staged`
   (`set -a; source …; set +a`),别把生产 .env 和 staged env 混一个 shell。

### 附录:其余已实锤的小坑(一句话版)

- **ElevenLabs `custom_llm_extra_body` 是独立平台安全位**:
  `platform_settings.overrides.custom_llm_extra_body=true` 不开 → WS init 后立即
  close 1008,会话根本开不起来(980 runbook 缺口,m1-rig.md 补录;agent 重建
  必含这步)。
- **cloudflared quick tunnel URL 每次随机** → 隧道重启后必须重 patch agent 的
  custom_llm 指向,否则平台报 custom_llm generation failed。
- **shim 运行中不可对 worktree `git clean`** —— 会删掉它的 `out/` 日志目录,
  下一个请求 ENOENT 带崩 shim → 隧道 connection refused。
- **同进程双 boot 撞 @discordjs/voice 注册表** → ears 永远到不了 Ready;
  mutex 腿与 audio 腿**分进程**跑(harness 已内建 `ELEVEN_LOOP_LEGS` seam)。
- **Chrome-as-Annie 依赖 Annie 的 Discord 登录态**,缺了只能 park 等她登一次;
  claude-in-chrome 断连修法见 §1.1。
- **「cookie 刷新」澄清**:四条 voice 管线的文档 grep 零 cookie 命中 —— cookie
  刷新属 gemini web 图像/视频生成 skill 的域,**voice 管线不依赖 cookie**;
  唯一近亲是上一条的 Discord 登录态。别按 cookie 方向排查 voice 问题。

## 4. env / 凭据 / 进程依赖清单(敏感值打码,只给变量名 + 来源)

### 4.1 /glaw(FLY-545;部署尚未落地,以下即部署清单)

| 项 | 值/来源 | 说明 |
|----|---------|------|
| `HUDDLE_ORCH_BOT_TOKEN` | `~/.flywheel/discord-bot-pool/flywheel-pool-06/token` | 编排 bot;**pool-06 尚未入 guild,需 founder 点邀请链接**(见 deploy-kit.md §C) |
| `HUDDLE_EARS_BOT_TOKEN` | `~/.flywheel/discord-bot-pool/flywheel-pool-04/token` | 耳朵 bot(Note-taker,已在 guild) |
| `GEMINI_API_KEY` | 现仅 `~/.zshrc`,**须拷入 `~/.flywheel/.env`** | 坑 2-2 |
| projects.json `huddle` 块 | guildId `1485787271192907816` + voiceChannelId(#huddle VC 待定)+ leads[] 各自 botTokenEnv | schema 见 voice-bridge config.ts;参会 Lead 名单待 Tadashi 拍 |
| `FLYWHEEL_API_TOKEN` / `DISCORD_OWNER_USER_ID` | 已在 `~/.flywheel/.env` | 无需动 |
| 进程 | voice-bridge daemon(常驻) | 合并后由 Tadashi/ops 起 |

### 4.2 /gemini(FLY-967/1065;staged rig)

| 项 | 值/来源 | 说明 |
|----|---------|------|
| staged env 文件 | `~/.flywheel/qa-fly967-staged/.env.staged` | 含 `LINEAR_API_KEY` / `HUDDLE_EARS_BOT_TOKEN` / `HUDDLE_ORCH_BOT_TOKEN` / `FLYWHEEL_API_TOKEN` / `GEMINI_API_KEY`(变量名实测) |
| `INJECTOR_BOT_TOKEN` | `~/.flywheel/discord-bot-pool/flywheel-pool-06/token` | 探针/caption bot;不得与 `HUDDLE_ORCH_BOT_TOKEN` 同 bot —— 同 bot 同房只有一条语音 session,实测复现 `IP discovery socket closed` + `ready↔signalling` 打摆 |
| staged 场地 | guild `1485787271192907816`,VC `1485787273193853170`(#General) | 529 房 |
| 进程 | voice-bridge daemon + 隔离 staged bridge(历史 :9877/:9878 隔离语义)+ probe 脚本 | runner 守卫硬拒生产 :9876 |

### 4.3 /eleven(FLY-1006)

| 项 | 值/来源 | 说明 |
|----|---------|------|
| `ELEVENLABS_API_KEY` | `~/.flywheel/.env` | 平台 key,打码 |
| `FLY980_TOKEN` | `~/fly1006-eleven/.shim-token` | shim 鉴权 |
| `FLY980_BRAIN=claude` / `FLY980_RESUME=0` / `FLY980_MODEL=sonnet` | shim 启动 env | sonnet = 07-09 Annie 拍板换档 |
| shim | :8980(`engineering/spike/FLY-980-eleven/shim.mjs`) | 启动行确认 model 档;health `curl :8980/health` |
| 隧道 | cloudflared quick tunnel → :8980 | URL 每次随机,变了要重 patch agent(附录坑) |
| agent | `agent_2401kx1say3vf988f28x07bhbwkt`(fly1006-eleven-m1) | `tts.agent_output_audio_format=pcm_24000` + `overrides.custom_llm_extra_body=true`(附录坑) |
| staged harness env | `HUDDLE_ORCH_BOT_TOKEN`(06)/ `HUDDLE_EARS_BOT_TOKEN`(04)/ `INJECTOR_BOT_TOKEN`(05)/ `ELEVENLABS_AGENT_ID` / `STAGED_GUILD_ID` / `STAGED_VC_ID` / `PROBE_WAV` / `INTERRUPT_WAV`(48k stereo s16)/ `STAGED_HEALTH_PORT`(:9879 隔离,:9878 生产拒跑) | m2-staged-venue.md §复现命令 |
| venue(Annie 试听) | `e2e/p6-live-venue.mjs`,health :9885;talk 页 :8988(`FLY1006_AGENT_ID`/`FLY1006_PORT`) | 跑 harness 前先停(坑 1) |
| transcript 落盘 | `~/.flywheel/voice-eleven/flywheel/<sessionId>.jsonl` | latency 取数源 |
| 成本 | voice key `AIza…`(打码)→ nano-banana GCP project,**$20.80/mo** | Annie 已问过账,Tadashi 已答 |

### 4.4 /gemini-advanced(FLY-1018/1159;enablement 前置)

| 项 | 值/来源 | 说明 |
|----|---------|------|
| `FLYWHEEL_GEMINI_AGENT=1` | daemon env | feature flag,default-off |
| `GEMINI_API_KEY` | 同上(拷入 .env) | 深链模型;pin flash=`gemini-3.5-flash` / pro=`gemini-3.1-pro-preview` |
| `FLYWHEEL_BRIDGE_URL` | daemon env | Bridge 面 |
| `FLYWHEEL_GEMINI_AGENT_BRIDGE_TOKEN` | daemon env,**scoped token** | 与主 token 相同值会被 config fail-closed 拒启;越界打 reserved endpoint → 403(M4 已验) |
| bindings | `~/.flywheel/gemini-agent.json`(channelId / projectName / **leadId 必填** / identityPath / contextNote) | server-attach,模型幻觉面之外 |
| 测试 bot | FLY-882 池 claim(Tadashi 手续,只进测试 guild) | enablement checklist 第一步 |
| 进程 | `flywheel-gemini-agent daemon` | 从未在生产起过(QA 核查四项全空) |

## 5. 出处索引(全部在本仓 `engineering/doc/`)

| 主题 | 文件 |
|------|------|
| /glaw 判据/FAIL 时间线/复盘 | `FLY-545-huddle-mode/evidence/qa-verdict-opus.md`、`fly1158-evidence.txt` |
| /glaw 部署清单 | `FLY-545-huddle-mode/deploy-kit.md`、`evidence/bot-provisioning.md` |
| /gemini 时序锚点 + 真人复验 | `FLY-1047-gemini-bargein-opening-qa/evidence/qa-verdict.md` |
| /gemini staged Discord E2E | `FLY-1065-voice-transcript-panel/evidence/staged-discord-e2e.md`、`qa-report.md` |
| /eleven rig 重建 runbook | `FLY-1006-eleven-product-e2e/evidence/m1-rig.md` |
| /eleven harness + env + 事故 | `FLY-1006-eleven-product-e2e/evidence/m2-staged-venue.md` |
| /eleven 换档对照 + venue 规矩 | `FLY-1006-eleven-product-e2e/evidence/m2-sonnet-latency.md` |
| /eleven Annie 真人 FAIL 铁证 | `FLY-1006-eleven-product-e2e/evidence/m2-annie-p6-session.md` |
| /eleven QA 全步骤/负向对照 | `FLY-1006-eleven-product-e2e/qa-report.md` |
| /gemini-advanced enablement 硬门 | `FLY-1018-gemini-advanced-build/qa-report.md` §0 |
| /gemini-advanced 深链 harness | `FLY-1018-gemini-advanced-build/harness-evidence.md` |
| /gemini-advanced 真机指引 | `FLY-1159-gemini-advanced-voice/qa-report.md` §3 |
| Chrome-as-Annie standing rule | `FLY-1041-gate-binding-ambiguity/qa-evidence/inbound-234-chrome-as-annie.md` |
| 行业对标(背景) | `FLY-1178-voice-agent-ecosystem/findings.md`(F1.4 进度反馈是线三该抄的一页) |
