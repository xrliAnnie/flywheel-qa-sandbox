# FLY-1006 /eleven 产品实测 — 实施计划

Issue: FLY-1006 (https://linear.app/geoforge3d/issue/FLY-1006/voiceelevenv1-eleven-产品实测-elevenlabs-agents-claude-custom-llm-真机)
日期: 2026-07-08
基于: research.md

## 0. 范围与不做

**做**：M1 真人麦克风产品实测（980 rig 重建 + talk 页 + Annie 体验终验 +
dashboard 分钟池核查）；M2 eleven 模式接 Discord VC（packages/voice-bridge
v1 产品代码 + staged venue 机器验证 + Annie VC 真机 E2E）；横向对比（四线：
/glaw(545)、/gemini(967)、/gemini-advanced(997)、/eleven）+ founder 结论页 +
credits 记账。

**不做**：shim/agent 生命周期产品化（继续 spike 资产 + runbook）；
BriefingEngine / read-only tools / landing 引擎（/gemini 的助理功能面，
不在 E2E 数据边界内）；多人 VC 混流（R8）；stale-answer 丢弃设计（R6，
follow-up）；8-Lead 全声线铺开（只铺 3）；/eleven 去留决策本身（Annie 拍）。

**三阶段边界**：本 plan 由 Implement 阶段执行；QA 阶段独立复验（§7）。
Annie 参与的两场真人会话是**验收主体**，实测时段由 Lead 与 Annie 在
[FLY-1006] thread 约定，Implement 阶段负责让 rig 处于「随时可开」状态。

## 1. 交付物

| 类型 | 路径 |
|------|------|
| M1 talk 页 + signed-url 服务 | `engineering/spike/FLY-1006-eleven/`（standalone，复用 `../FLY-980-eleven/lib/` 与脚本；过全仓 biome lint） |
| M2 产品代码 | `packages/voice-bridge/src/eleven/`（ElevenWs / ElevenSession / ElevenCommand / config / wiring + `__tests__/`） |
| evidence | `engineering/doc/FLY-1006-eleven-product-e2e/evidence/*.md`（每命题一文件，含复现命令 + 取证日期） |
| 音频/数据留档 | `~/fly1006-eleven/`（会话 wav/jsonl/usage 快照；QA 验收前不删） |
| founder 结论页 | 一页 HTML（中文、Apple-style light、mobile-first），publish-report 到 **[FLY-1006] issue thread**（不发 core room） |
| credits 台账 | `evidence/credits-ledger.md`（每 session 前后快照，~177 credits/min 基准对照） |

## 2. 命题表（verdict 索引）

| # | 命题 | 判据 |
|---|------|------|
| P1 | M1 rig 重建可用 | 980 生产配方 agent + shim(claude 档) + 隧道 + talk 页，操作者自测 ≥2 轮通话正常 |
| P2 | per-session 声线/persona 切换真人可用 | talk 页切 3 Lead（Eric/Sarah/Alice），各开一会话，声线+自称随选切换 |
| P3 | **Annie 真人体验（M1 终验）** | 中英文各真聊数轮 + ≥1 次打断 + ≥2 声线；她的结论落 [FLY-1006] thread |
| P4 | dashboard 分钟池 | 有/无独立 Agents 分钟计数器，二选一坐实，截图/描述落 evidence |
| P5 | eleven 模式机器可验链路 | `e2e/eleven-staged.mjs` + `e2e/eleven-voice-loop.mjs`：注入 WAV → agent 音频回放（波形断言）→ 打断停播 → slot 互斥，fail-closed verdict 全绿 |
| P6 | **Annie VC 真机 E2E（M2 终验）** | Annie 进 VC 用 /eleven 对话全链跑通；延迟双口径 + 质量 + 成本三维落表 |
| P7 | 横向对比 + founder 结论页 | /glaw /gemini /gemini-advanced /eleven 四线对比表（口径注明；/gemini-advanced 列引 FLY-997，未出数据标 pending）+ 结论页发 thread |
| P8 | credits 记账 | 全程台账，每步可归因，总量 <1.5 万 credits 预期内 |

## 3. M1 步骤（立即可开）

### S1 预检 + rig 重建（P1）

1. `stage set implement`；建 `engineering/spike/FLY-1006-eleven/`
   （package.json 同 980 模式：private、type module）。
2. 预检：ELEVENLABS_API_KEY 在 `~/.flywheel/.env`；`pnpm --filter
   flywheel-voice-core build`（shim 的 dist import 前置，980 S0 教训）；
   cloudflared 在机。
3. 重建 agent —— **create + patch + 回读三步显式做**（Codex R1#1：
   create-agent.mjs 只设 workspace secret 鉴权 + override 安全位 +
   `tts.model_id=flash_v2_5` + `turn_model=turn_v3`，生产旋钮它**不设**）：
   - create：`create-agent.mjs <tunnel-url>`（FLY980_TOKEN 走 env）；
   - patch（`patch-agent.mjs`，注意 v10 runbook §7 的 **PATCH 陷阱**：
     prompt 子对象整体替换，必须带全 `llm`+`prompt`+`custom_llm`）：
     `prompt.cascade_timeout_seconds=15`、`turn.soft_timeout_config`
     （3s、中文垫话×2、randomize、max 2）、
     **`tts.agent_output_audio_format="pcm_24000"`**（M2 复用同一 agent）；
   - GET 回读逐字核对上述全部字段，快照落 evidence。agent_id 落 evidence。
   - **M2 硬门**：首次会话的 `conversation_initiation_metadata` 断言
     `agent_output_audio_format=pcm_24000` + `user_input_audio_format=
     pcm_16000`，不符即 fail-loud 停测（上采样假设的运行时守卫）。
4. 起 shim（`FLY980_BRAIN=claude FLY980_RESUME=0`，research §1.2 理由）+
   隧道 + patch agent 指到隧道 URL；`e2e-session.mjs` 喂 u1 一轮冒烟。

### S2 talk 页（P2；TDD 尽力，页面逻辑薄）

- `serve.mjs`：127.0.0.1-only http 服务。`GET /` 出静态页；
  `GET /api/signed-url?lead=<id>` → 读 env key → get_signed_url REST →
  回 **`{signedUrl, lead:{voiceId, prompt}}`**（Codex R1#4：页面要 voiceId
  与 persona prompt 才能拼 overrides——这两样非机密，随响应下发；**key 本身
  不出进程**）。lead 表内置（Tadashi=Eric `cjVigY5qzO86Huf0OWal` /
  Cass=Sarah `EXAVITQu4vr4xnSDxMaL` / Belle=Alice `Xb7hH8MSUJpSbSDYk0k2`）。
- **persona 文件入库**（Codex R1#4：980 spike 目录里没有 tracked persona
  文件，V8 用的是临时素材）：`engineering/spike/FLY-1006-eleven/personas/
  {tadashi,cass,belle}.md`，内容按 980 §S7 persona 表要求新写（自称 +
  角色口吻，中文为主），serve.mjs 启动时读入。
- `talk.html`：`@elevenlabs/client` 的 `Conversation.startSession({signedUrl,
  overrides:{agent:{prompt:{prompt}},tts:{voiceId}}})`（research §1.1 已核
  形状）；开始/结束按钮、Lead 下拉、状态灯（onModeChange）、会话计时、
  conversation_id 展示。SDK 引入方式：esm.sh/unpkg ESM import 或本地
  vendored bundle——**页面永不内嵌 key**。
- 单测（node --test）：serve.mjs 的 signed-url 路由（fake fetch 注入：
  key 只出现在 upstream 请求头、响应含 signedUrl+lead 且不含 key）、
  lead 表校验（3 个 lead 均有非空 prompt + voiceId）、非法 lead 400、
  persona 文件缺失时启动 fail-loud。
- 操作者自测 ≥2 轮通话 + 3 Lead 各一会话（P1/P2 verdict），记
  `evidence/m1-rig.md`。

### S3 Annie 真人实测（P3，验收主体）

1. rig 就绪后报 Lead（flywheel-comm ask），Lead 与 Annie 约时段；
   开测前记机器 load（980 教训：load 20-35 时延迟绝对值偏悲观，落 evidence
   备注）。
2. 建议脚本（页面上方给 Annie 提示，不强制）：中文闲聊 2-3 轮 → 英文 1-2 轮
   → 中英混 1 轮 → 答中打断 1-2 次 → 切 Lead 再来一轮。
3. 每 session 前后 usage 快照（P8）；shim jsonl + 页面粗时间戳留档
   `~/fly1006-eleven/`。
4. Annie 的体验结论（好用/不好用/哪里硌手）由她本人或 Lead 代录落
   [FLY-1006] thread —— **这条 thread 消息 = M1 验收物**。
   `evidence/m1-annie-live.md` 记会话清单 + 指标 + 结论引用。

### S4 dashboard 分钟池核查（P4，顺手）

Claude-in-Chrome 只读打开 elevenlabs.io dashboard usage 页（Annie Chrome
已登录前提；未登录改请 Annie 瞥一眼）。**只读，不碰任何设置**。结论 +
截图路径落 `evidence/m1-minutes-pool.md`。

## 4. M2 步骤（前置：#501 merge）

> **M2 追加要求（Annie M1 终验反馈，Lead 指示 bc366532，2026-07-08）**：
> ④ **Claude 脑必须接真 Lead 脑**——人格 + 记忆 + issue 上下文注入，
> claude -p 走 Lead identity 路径（M1 薄人设被 Annie 判「角色/项目认知
> 空洞」，persona+context 是她的决策主轴——这是 M2 正菜不是 nice-to-have；
> 实现位点在 shim 脑侧：per-Lead identityFile 指向真 Lead identity/memory，
> M2 开工时定具体注入形状。**延迟主战场同此处**：M1 拆段实测 brain 首
> token 中位 6.5s（冷 claude -p haiku，n=10）远肥于 STT ~1-3s 与 TTS
> <1s——warm 实例/持久会话与真 Lead 脑注入**一起设计**，一个改动吃两个
> 收益）。
> ②③（Annie 二次拍板，cbd5208c）**垫话从『说话』改『声效』**：用户说完
> → 立即循环轻量「处理中」音效 → 真答案 onset 停。语言无关，②③ 一次
> 解决；spoken 垫话降级为可选配置（agent soft_timeout_config 保留、
> timeout_seconds=-1 禁用）。M1 talk 页已实现（WebAudio）；**M2 
> ElevenSession 原生实现**（onSpeakingEnd 起效、首 audio_event 停，走
> 流式嘴同层）。
> ① 声线对比加「中文口音干净度」维度；Tadashi 备选（George/Will/Harry）
> 已上 talk 页待 Annie 拍。

### S5 前置检查（硬门）

`git log origin/main` 确认 FLY-967 PR #501 已 merge（音频修 9a0a464c +
harness e55beaf5 在 main）→ 本分支 merge origin/main。**未 merge 则 hold：
报 Lead 后先完成 M1/报告侧工作，不 fork 旧音频面硬做**（research R4）。

### S5b 共享 room runtime 提升（Codex R1#2；M2 第一刀，先于 eleven 模块）

#501 的 `wireAssistantMode` 把 `SessionSlot` 与 `EarsReceiver` **私建在
/gemini wiring 内部**（`assistant/wiring.ts`）——/eleven 若各建一套，两个
模式会同时自认持房（slot 失效）+ 重复订阅收音。修法：

- 把单一 `SessionSlot` + 单一 ears 路由提升为 `VoiceRoomRuntime`（由
  `runVoiceBridge` 拥有），/gemini 与 /eleven wiring 均以注入方式消费；
  `onFrame`/`onBargeIn` 只派发给当前 active session。
- **行为保持**：/gemini 现有全部测试零红（这是对已 merge 代码的结构性
  重构，不是功能改动）。
- 新测试：/gemini 持锁拒 /eleven、/eleven 持锁拒 /gemini、frame/bargeIn
  只达 active session、release 后另一方可入。

### S6 ElevenWs（TDD；净新增最大件，~200 行级）

`packages/voice-bridge/src/eleven/ElevenWs.ts`：

- 职责：get-signed-url REST（key 从 env，绝不落参数/日志）→ WS 连接 →
  起始帧（`conversation_config_override` Lead 声线+persona +
  **强制唯一 `custom_llm_extra_body:{conversation_id}`**——980 v10 取证：
  平台默认不带任何会话辨识字段，缺了它 shim 会塌回 single-session 键串味；
  Codex R1#5）→ 双向消息编解码 + **平台 `ping` → 应答 `pong`**（980
  e2e-session.mjs 已有此处理，长会话缺它会 flaky；Codex R1#5）。
- 对外事件：`onAudio(Buffer /*24k mono s16le*/)`、`onInterruption()`、
  `onUserTranscript(text)`、`onAgentResponse(text)`、`onMetadata(formats)`、
  `onClose/onError`；对内 `sendAudio(frame16k)`（内部 ~100-250ms 聚包）。
- **注入 seam**（voice-core transport-injection 惯例）：WS 构造器与 fetch
  可注入 → 单测全离线。用例：起始帧形状（override + **非空唯一
  conversation_id** 断言）、ping→pong 应答、user_audio_chunk base64 聚包
  边界、audio_event 解码、interruption 触发、metadata 格式断言（收到非
  pcm_24000 → fail-loud error 事件）、close/error 清理幂等。**先 RED 后
  GREEN**。M2 真机 evidence 须含 shim jsonl 一行证明 `elevenlabs_extra_body.
  conversation_id` 真到达。

### S7 ElevenSession + ElevenCommand（TDD）

- **播放走流式嘴，不走 LeadSpeaker 离散队列**（Codex R1#3：LeadSpeaker
  每个 audio buffer 起一条新 resource 串行排队，逐 audio_event 排队会有
  爆音/积压/打断后残播；967 的 `AssistantSpeaker` 正是为连续 chunk 流建的
  ——每 turn 一条 PassThrough，raw PCM 修在 resource factory 层）：直接
  复用 `AssistantSpeaker`（其 begin/feed/end 模型与 eleven 事件模型吻合
  即用），不吻合再写同形薄 `ElevenSpeaker`（beginTurn/feed/endTurn/flush）。
  **事件→turn 映射**：某 response 的首个 `audio_event` = beginTurn；同
  response 后续 audio_event 连续 feed；`agent_response_complete`（或音频
  间隙 >1.5s 兜底）= endTurn；`interruption`/本地 barge-in = flush + turn
  关闭，**关闭后迟到的 chunk 丢弃并计数**（late-chunk drop）。
- `ElevenSession.ts`：薄状态机 invoked→live→teardown。接线：
  EarsReceiver.onFrame→ElevenWs.sendAudio；ElevenWs.onAudio→
  `upsample24kMonoTo48kStereo`→流式嘴 feed（**StreamType.Raw**，走
  resource factory 同层）；onInterruption + EarsReceiver.onBargeIn 双路→
  flush；transcript 事件落 jsonl；度量打点（onSpeakingEnd→首 audio_event，
  段间隙 >1.5s 分垫话/真答案，research §2.5）。teardown：WS close +
  订阅解除 + slot release，幂等。
- `ElevenCommand.ts`：/eleven 命令。**deferReply 先应答**（9a0a464c）→
  preflight（agent GET 可达 + shim 健康探针 + key 在位，缺则 fail-loud
  editReply 报因）→ 共享 slot `acquire("eleven")`（busy 回 founder-facing
  话术）→ 起 ElevenSession；/eleven stop → teardown。
- 入向 human-gating 复用 967 `makeIsHuman`（含 REST 自愈）。
- 单测：状态机迁移全覆盖、**每 response 单一 raw stream / interruption
  flush / late-chunk drop / backpressure 告警**（流式嘴四件）、slot 互斥
  （S5b 的跨模式用例：/glaw /gemini /eleven 争锁——SessionSlot mode 字符串
  以代码实际注册值为准）、preflight 各缺项 fail-loud、teardown 幂等。config
  进 `config.ts`（agent_id、lead 声线表、shim 探针 URL），wiring 进
  `wiring.ts`（对齐 967 形态，消费 S5b 共享 runtime）。

### S8 staged venue 机器验证（P5）

复用 967 staged venue 的**模式**（隔离 Bridge + sender-bot 推 WAV + 离线
波形断言 + fail-closed verdict），但 967 harness 是 Gemini 专用（autostart
/gemini、扫 Gemini transcript、Gemini 转写）——**/eleven 要自己的两个具名
脚本**（Codex R1#6，模型 = 967 的 staged runner + voice-loop）：

- `packages/voice-bridge/e2e/eleven-staged.mjs`：起隔离 Bridge + /eleven
  autostart。env 契约：`ELEVENLABS_AGENT_ID`、shim 健康 URL、staged Bridge
  端口；**生产端口拒跑**（bf8369b1 同款 prod-port refusal）+ SIGTERM 清理。
- `packages/voice-bridge/e2e/eleven-voice-loop.mjs`：三腿断言——
  1. 注入 u1 中文 WAV → agent 音频回放落 VC（录播波形非静音断言）+
     **transcript 源 = ElevenSession jsonl 的 user_transcript/agent_response
     事件**（不需要第三方转写，平台自带）；
  2. 播放中注入第二段人声 → 停播断言（barge-in 路径）+ 会话存活再答一轮；
  3. /eleven 占坑时 /gemini 拒入 + 反向（S5b 互斥真机面）。
- **任何断言红 = exit 1**（e55beaf5 fail-closed 模式）。verdict 落
  `evidence/m2-staged-venue.md`（含复现命令）。

### S9 Annie VC 真机 E2E（P6，验收主体）

runbook：起 shim + 隧道 + patch agent → 起（或确认）staged/生产 voice-bridge
→ Lead 约 Annie 进 VC → /eleven → 中英文真聊 + 打断 + （可选）切 Lead 重开
一会话 → /eleven stop。三维记录：

- 延迟：双口径逐轮表（speech-end→垫话首音 / →真答案首音）+ shim jsonl 归因；
- 质量：STT 转写核对 + 声线/打断体感（Annie 原话）；
- 成本：session 前后 usage 快照 → credits/min。

落 `evidence/m2-vc-e2e.md`；Annie 体感结论落 [FLY-1006] thread（M2 验收物
之一）。

## 5. 报告（P7/P8）

- 四线对比表：/glaw(545)、/gemini(967)、/gemini-advanced(997)、/eleven ——
  **第一维度 = Lead persona/context 注入能力**（Annie 2026-07-08 于 967
  thread 拍的决策轴：她不要 generic 助理，要「跟特定 Lead 聊特定事」，
  persona+context 注入 > 声线，声线统一可接受。/eleven=选 Lead+人设 ✓ /
  /glaw=Lead Claude 脑 ✓ / /gemini=通用+简报 ✗——这比延迟表更接近她的
  决策轴）；其后 延迟（口径注明）/成本（订阅内现金 + 等值）/声线 /中文
  /打断 /工具通路 /工程量；/glaw //gemini 列引用 FLY-968/967 数据，
  /gemini-advanced 列引 FLY-997 产出（未出数据标 pending），/eleven 列 =
  980 + 本单实测。
- founder 结论页：中文一页 HTML（Apple-style light、mobile-first），
  含 M1/M2 体验摘要 + 四线表 + 「哪些场景用 /eleven」+ credits 台账摘要；
  publish-report 到 **[FLY-1006] thread**。去留推荐写「建议」，**决策权
  在 Annie**。
- 清理纪律：实测全部完成 + QA 验收后删 spike agent + workspace secret、
  撤隧道（delete-agent.mjs）；`~/fly1006-eleven/` 留档不删；声线定稿后
  释放 My Voices 里不用的 fly1006-* 候选坑（Lead 指示，加库可逆）。

## 6. 测试与验收策略

- **TDD**：S2/S6/S7 全部先测后码；voice-bridge 新增用例进
  `packages/voice-bridge/src/__tests__/` 或 `src/eleven/__tests__/`
  （vitest，仓库现约定）；spike 侧 node --test。
- 全仓 `pnpm lint`（biome 覆盖 spike .mjs，FLY-977 教训）+
  `pnpm --filter flywheel-voice-bridge test` + `pnpm --filter
  flywheel-voice-core test`（确认零回归）。
- **行为保持断言**：对既有文件的改动**只允许 S5b 共享 runtime 提升**
  （结构性重构，/gemini 全部现有测试零红作行为保持证明）+ wiring 注册点；
  EarsReceiver/LeadSpeaker/SessionSlot **类本体**零修改（有缺口先报 Lead，
  不擅自改公共件）。
- **QA 阶段（独立会话）**：重跑 S8 staged venue 全绿、抽验 M1 talk 页
  （QA 自己开一轮会话）、核 credits 台账加法、验 founder 页链接在 thread
  可开;Annie 体感结论不代验（终审在她）。

## 7. 风险与回退

research §4 R1-R8 全承接。最坏情形预案：

- **真人会话体验差**（延迟/垫话烦人）：这本身就是有效结论——如实记录
  + 对比页呈现，去留 Annie 拍（工程不粉饰）。
- **#501 长期不 merge**：M1 + 报告侧先交，M2 拆后续（Lead 决定是否单独
  PR 先落 M1——见 §8）。
- **平台行为漂移**（980 配方失效，如 secret 鉴权形状变更）：以 GET 回读
  实况为准更新 runbook，evidence 记差异。

## 8. PR 形态与版本

- 默认**单 PR**（本 issue 单分支三阶段）：设计三件套 + M1 spike 资产 +
  M2 voice-bridge 代码 + evidence + founder 报告发布记录。commit 前缀
  M1/文档用 `spike(FLY-1006):` / `docs(FLY-1006):`，M2 产品代码用
  `feat(voice-bridge): FLY-1006 …`。
- 若 #501 明显延迟（>数日），报 Lead 拆 PR-1（M1+报告）先行——不让已完成
  的真人实测证据被时序扣押。
- `doc/VERSION`：M2 含 packages/ 产品代码，**ship 时取空号 bump**（近期
  多 PR 待 ship，版本号 ship 窗分配——FLY-494 先例）；若最终拆成纯 M1 PR
  则不 bump（spike/evidence 先例 FLY-968/980）。
- 后续 follow-up（本单不做，报告里列出）：shim 产品化（挪出 spike）、
  stale-answer 丢弃、多人混流、8-Lead 声线全铺、/eleven 常驻运维面
  （tunnel/agent 生命周期托管）。
