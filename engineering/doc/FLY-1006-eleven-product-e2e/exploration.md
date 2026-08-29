# FLY-1006 /eleven 产品实测 — 探索

Issue: FLY-1006 (https://linear.app/geoforge3d/issue/FLY-1006/voiceelevenv1-eleven-产品实测-elevenlabs-agents-claude-custom-llm-真机)
日期: 2026-07-08
基于: 无（上游输入 = FLY-980 spike 全套 evidence + FLY-968 bakeoff + FLY-967 PR #501 音频修 + brainstorm gate Lead 确认）

## 1. 问题定义

FLY-980 spike 已用**脚本喂音**把 /eleven（ElevenLabs Agents 耳+嘴+turn-taking +
Claude 脑经 Custom LLM）的协议、延迟、打断、工具、多声线、成本全部真机验过，
结论**条件 GO**（PR #504 merged @ ef1b05ab）。但 980 没覆盖、也覆盖不了的是：

**真人用起来到底什么感觉。** 脚本喂 PCM 测不出 Annie 的体感——她说话的自然
节奏、垫话听着烦不烦、打断跟不跟手、声线像不像那个 Lead。本 issue 就是把
spike 变成**产品实测**：

- **M1 · 产品级真人实测**（立即可开）：重建 980 的 agent+rig → Annie 本人真
  麦克风实时对话（中英文真聊几轮 + 试打断 + 多声线切换）→ 她的体验结论落
  thread = 终验素材。顺手核一眼 ElevenLabs dashboard 有没有独立「分钟池」
  计数器（980 发现 API 侧无独立计数、实测直接扣 credits）。
- **M2 · Claude 当脑 + Discord VC 接入**：Custom LLM 指到 Claude（claude -p
  订阅路径，$0 脑）→ 接进 Discord VC（复用 545/967 voice-bridge 音频面）→
  真机 E2E：Annie 进房对话，延迟/质量/成本三维记录。

**产出**：与 /glaw（545，Gemini 耳+Claude 脑+edge-tts 嘴，免费）、/gemini
（967，纯 Gemini Live）、/gemini-advanced（997）横向对比数据 + founder 版
结论页，供 Annie 定 /eleven 去留。credits 用量记账。

## 2. 与已有工作的边界

| | FLY-980 spike（已完成） | 本 issue M1 | 本 issue M2 |
|--|--|--|--|
| 音频入口 | 脚本喂 16k PCM 文件 | **Annie 真麦克风**（浏览器） | **Discord VC**（voice-bridge） |
| 脑 | claude -p（shim） | 同 980（真形态） | 同 980（真形态） |
| 验的是什么 | 协议/延迟/机制可行性 | 产品体感（真人终验） | 产品形态全链（VC 房间） |
| 代码去向 | engineering/spike/（不碰 packages/） | 复用 spike 资产 + 极简网页 | **packages/voice-bridge 新增 eleven 模式**（v1 产品代码） |

与 FLY-967 的关系：/eleven 与 /gemini（967）/ /glaw（545）共用 voice-bridge
底盘（SessionSlot 单会话互斥、EarsReceiver、LeadSpeaker）；**M2 排在 967 音频
修落地后**（#501 头 e55beaf5，音频修 = 9a0a464c：deferReply 先应答 /
StreamType.Raw 出向 / isHuman REST 自愈入向）——eleven 模式直接按修好后的
音频面设计，不重踩同一批坑。

## 3. 现状审计（codebase ground truth）

### 3.1 FLY-980 spike 资产（engineering/spike/FLY-980-eleven/，main 已合）

全部可直接复用：

- **shim.mjs + lib/shim-core.mjs**：OpenAI 兼容 chat.completions SSE endpoint，
  包 HeadlessClaudeBrain（claude -p）；per-conversation persona 通路（平台下发
  的 system prompt → 临时 identity 文件 → --append-system-prompt-file）；
  483 行合同测试全绿。
- **create-agent.mjs / patch-agent.mjs / delete-agent.mjs**：agent 生命周期；
  鉴权唯一可用形状 = **workspace secret**（request_headers 是死路，运行时
  平台不送配置值——v10 runbook 逐字记录）；override 安全位 create 时一次设好。
- **e2e-session.mjs**：get-signed-url → WS → user_audio_chunk（base64 16k
  mono s16le）→ audio_event（base64 PCM）收流 + 打点——M2 的 WS 客户端参考
  实现。
- **usage.mjs / audition.mjs**：subscription 记账 + 声线 audition。
- **生产配方旋钮**（v2-v5 evidence 实测锁定）：cascade_timeout_seconds=15
  （默认 8 = 慢脑死刑）+ soft_timeout 3s 中文垫话 ×2 + turn_v3 +
  eleven_flash_v2_5。

### 3.2 voice-bridge 底盘（packages/voice-bridge/，545 PR-1 已合 + 967 #501 在途）

- **EarsReceiver**：VC 人类成员 → 解码/降混 → **16kHz mono s16le PCM 帧**
  （onFrame）+ backchannel 门限 350ms 的 onBargeIn——正好是 ElevenLabs WS
  user_audio_chunk 要的格式，**零转换直喂**。
- **LeadSpeaker**：串行播放队列（file/audio/text 源），stop() 同步清队 =
  barge-in 快路径。
- **SessionSlot**：常驻 VC 单会话互斥，mode 维度已通用化（/meet、/live 争
  同一坑位）——eleven 模式照常接入。
- **resample.ts**：StereoDownmixDecimator（48k→16k 入向）+
  **upsample24kMonoTo48kStereo**（24k→48k 出向，为 Gemini 24k 输出写的）——
  把 ElevenLabs agent 输出配成 pcm_24000 即可原样复用。
- **967 assistant/ 模块**（#501 分支）：AssistantSession 状态机（invoked→
  live→concluding→landing→teardown）、AssistantSpeaker（流式嘴，
  StreamType.Raw 教训）、GeminiCommand（slash + SessionSlot）、wiring——
  eleven 模式的**结构模板**。
- **967 staged venue**（#501 分支 e2e/）：~/.flywheel/qa-fly967-staged/ 隔离
  Bridge + sender-bot 推 WAV + 离线波形断言 + fail-closed verdict
  （e55beaf5）——M2 的 E2E 验证 rig **不重造，引用此模板**。

### 3.3 依赖现状

- ELEVENLABS_API_KEY 已在 ~/.flywheel/.env（issue 确认 + 本机核实）。
- Creator 订阅池：980 花掉 6,095 credits（≈3.8% 月池），剩余充裕；实测口径
  ≈177 credits/min。
- **#501 尚未 merge**（OPEN，头 e55beaf5）——M2 implement 的硬时序前置。
- V9 终选 8 声线表已成（evidence/v9-voices.md）；终审权在 Annie。

## 4. 设计空间

### M1 交互面（Annie 怎么对着麦克风说话）

| 路线 | 说明 | 判 |
|------|------|-----|
| **A（选定）：本地极简网页** | ElevenLabs 官方 JS SDK（@elevenlabs/client）+ signed URL + Lead 下拉（per-session override 切声线/persona，980 V8 已验通路） | 真麦克风/扬声器/打断全有；能打点；能切声线；key 全程 server-side（gate 确认③） |
| B：dashboard 试聊 | ElevenLabs dashboard 内置 test 面板 | 零代码但**切声线要改 agent 配置**、无法打点、需要 Annie 登 dashboard——降级为 fallback |
| C：直接跳过 M1 做 M2 | 只在 VC 里测 | 违背 issue 拆 M1/M2 的用意（M1 立即可开、不等 #501） |

### M1 脑形态

| 路线 | 判 |
|------|-----|
| **真 /eleven 形态（选定）**：Custom LLM shim + claude -p + 980 生产配方 | Annie 的体验结论必须基于真产品形态（gate 确认①）；垫话/慢脑体感正是要她评的 |
| 平台内置脑（gpt-4o-mini） | 延迟好看但测的不是我们的产品——只在 shim 故障时作应急对照，报告如实标注 |

### M2 接入形态

| 路线 | 判 |
|------|-----|
| **voice-bridge 新增 eleven 模式（选定）**：packages/voice-bridge/src/eleven/ + /eleven 命令，对齐 967 把 /gemini 建在同底盘的形态 | v1 产品代码（gate 确认②）；SessionSlot/EarsReceiver/LeadSpeaker 全复用 |
| spike 脚本级 VC 桥（一次性） | 测完即扔，三线拍板后如果 /eleven 赢还得重写——假节约 |
| 等三线拍板再接 VC | issue 明确 M2 就是要 VC 真机 E2E 数据供拍板——因果倒置 |

shim/tunnel/agent 继续用 spike 资产**不产品化**：三线拍板前不值得把 shim 挪进
packages/；eleven 模式经 WS 连 agent，与 shim 无代码耦合（shim 是平台侧回调的
另一端），产品化留 /eleven 胜出后的 follow-up。

## 5. 关键设计决策（gate 已确认 + Lead 四条输入）

| # | 决策 | 来源 |
|---|------|------|
| D1 | M1 用真 /eleven 形态（shim + claude -p + 生产配方），不用平台内置脑 | gate 确认① |
| D2 | M1 交互面 = 本地极简网页（SDK + signed URL + Lead 下拉 override），dashboard fallback；**key 全程 server-side，不进浏览器/repo** | gate 确认② + Lead 输入 3 |
| D3 | 声线只铺 3 Lead：Tadashi（Eric）/ Cass（Sarah）/ Belle（Alice），男女+辨识度覆盖；V9 终选表其余不铺 | gate 确认③ |
| D4 | M2 = packages/voice-bridge/src/eleven/ 模式 + /eleven 命令，结构对齐 967 assistant/；按 9a0a464c 修好后的音频面设计（speaker 直接吃 StreamType.Raw 教训、入向 human-gating 复用 makeIsHuman 同判定） | gate 确认 + Lead 输入 1 |
| D5 | M2 E2E 验证 rig 复用 967 staged venue 模板（隔离 Bridge + sender-bot 推 WAV + 离线波形断言），不重造 | Lead 输入 2 |
| D6 | credits 记账延续 980 口径（~177 credits/min），M1 每 session 前后 usage 快照 | Lead 输入 4 |
| D7 | 时序：M1 立即；M2 implement 排在 #501 merge 后 | gate 确认 |
| D8 | agent 输出音频配 pcm_24000 → 复用 upsample24kMonoTo48kStereo（零新重采样代码） | 审计 §3.2 |
| D9 | 本单三阶段 pipeline：design 只出三件套，实现归 Implement 阶段（同分支） | pipeline 约束 |

## 6. 成功判据

- **M1**：Annie 用真麦克风与 ≥2 个 Lead 声线各真聊数轮（中英文）+ 至少一次
  打断实测 → 她的体验结论（好用/不好用/哪里硌手）落 [FLY-1006] thread；
  dashboard 分钟池核查结论落 evidence。
- **M2**：Annie 进 Discord VC 与 /eleven 对话全链跑通；延迟（speech-end→
  垫话首音 / 真答案首音双口径）、质量（STT 准确性/声线/打断体感）、成本
  （credits/min 实测）三维数据落 evidence。
- **产出**：四线对比表（/glaw(545)、/gemini(967)、/gemini-advanced(997)、
  /eleven——引用 968 bakeoff + 967 + 980 + 本单实测；/gemini-advanced 列引
  FLY-997 产出，未出数据标 pending）+ founder 结论页 publish-report 到
  [FLY-1006] thread。
- credits 全程记账，每步可归因。
