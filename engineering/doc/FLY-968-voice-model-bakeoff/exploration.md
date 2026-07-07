# FLY-968 实时语音模型选型横评 — 探索

Issue: FLY-968 (https://linear.app/geoforge3d/issue/FLY-968/voiceresearch-实时语音模型选型横评-openai-realtime-vs-gemini-live-vs-其他-multi)
日期: 2026-07-07
基于: 无（上游输入 = FLY-883 research、FLY-545 S1 spike 证据、FLY-906 PRD，见 §2）

## 1. 问题定义

FLY-545 S1 spike（2026-07-07，`flywheel-FLY-545` 分支
`engineering/doc/FLY-545-huddle-mode/evidence/s1-gemini-text-modality.md`）实测：
**当前所有 Gemini Live（bidiGenerateContent）模型服务端拒绝 `responseModalities:[TEXT]`**，
半级联一代（曾支持 TEXT 的 gemini-live-2.5-flash-preview / 2.0-flash-live-001）已全部退役。
545 原 B 设计主线「Gemini TEXT 出文本 → TurnRouter 剥 speaker 标签 → per-Lead edge-tts
分声线」物理不可行；同场量出的混合路线（audio 丢弃 + output transcription → edge-tts）
全链 2.4-3.2s，破 PRD §15（首音 >1.5s 算破）。

Annie 两问（2026-07-07 12:46 PT，545 thread）：

1. **真的不能用 multiple Gemini Live 吗？** 每 Lead 一个 session、各选一个内置 prebuilt
   voice（Gemini 有 ~8-10 个），从而绕开 TEXT 模态缺失、仍拿到 per-Lead 声线。
2. **要不要研究 Gemini Live 的替代者？** OpenAI Realtime 会不会更好？还有谁？

本 issue = 纯研究 + 最小真机验证，回答这两问并产出横评表 + 对 /meet(545)、/live(967)
的选型建议 + founder 一页结论。**不写产品代码**，结论回灌 545/967 后续迭代。

## 2. 已知事实盘点（别把已验证的当未知重新研究）

| 来源 | 事实 | 对本研究的意义 |
|------|------|----------------|
| FLY-545 S1 spike（2026-07-07 真机） | Gemini Live 全系拒 TEXT 模态；AUDIO 模态首 chunk 797-1017ms；输入转写照常下发；输出转写与首 audio 同帧到达；混合路线 2.4-3.2s | Track 1 的单 session 延迟基线已有，不用重测；「转写→edge-tts」这条路已死，横评表直接引用 |
| FLY-883 research（2026-07-05 DR，25 citations） | Gemini Live ~$0.0115/min（约 OpenAI 1/4）；OpenAI Realtime ~$0.048/min；OpenAI 10 内置声线、单会话 60min；Gemini 连接 ~10min/纯音频 15min 需 resumption；OpenAI 打断语义文档化最强；两家均支持混合架构（嘴耳+外部脑） | 价格/会话时限/声线数的文档级底座已有，本研究只做**增量核实 + 真机补缺**，不重跑 DR |
| FLY-960 spike（GO） | @discordjs/voice 0.19.2 在强制 DAVE 下真机收音可靠，per-speaker 分轨成立 | Discord 传输层不再是未知数；横评只管「模型侧」 |
| FLY-543 voice-core（merged） | 可插拔 backend registry（edge-tts announce 面 + gemini-live converse 面）已建成；`GEMINI_API_KEY` 真机连通 | 新后端（OpenAI 等）有现成接口合同可对标；spike 结论直接映射到「加一个 backend 的工程量」 |
| FLY-959（merged） | 现役模型 = `gemini-3.1-flash-live-preview`；模型退役/404 是 Gemini Live 的常态运维风险 | preview 波动要进横评的「生态成熟度」维度 |
| FLY-906 PRD | §15 延迟合同（首音 ≤800ms 好 / ≤1.2s 可接受 / >1.5s 破；ack ≤1s；barge-in <100ms）；**§17 把 per-agent 不同声线列为硬能力要求**（不报身份也能听辨谁在说） | 横评的硬判据轴；per-Lead 声线不是 nice-to-have |
| 本机 key 现状（2026-07-07 查证，只看名字不看值） | 有：`GOOGLE_API_KEY`/`GEMINI_API_KEY`、`OPENAI_API_KEY`、`ELEVENLABS*`；无：Hume / xAI / AWS | Gemini、OpenAI、ElevenLabs 可真机；Nova Sonic / Hume / xAI 默认文档级（注册账号是 founder 的活，不阻塞研究主线） |

## 3. 解题空间 — per-Lead 声线的全部路线枚举

Annie 的两问背后是同一个产品需求（PRD §17 硬要求）：**多 agent 语音要靠声线辨身份**。
把所有能到达它的路线摆全，横评才不会漏：

| 路线 | 机制 | 现状 |
|------|------|------|
| R1. 单 session TEXT + edge-tts（545 原 B 主线） | realtime 模型出文字，本地 TTS 按 Lead 换声线 | Gemini：**死**（S1）；OpenAI：**待验证**（text-out 支持与否 = Track 2 核心问题） |
| R2. 单 session 输出转写 + edge-tts | audio 丢弃、拿 output transcription 喂 TTS | **死**（S1 实测 2.4-3.2s 破 §15，且双倍烧 token） |
| R3. **多 session、每 session 一内置声线**（Annie 问①） | 每 Lead 一条 realtime 连接，voice 参数各配一个 prebuilt voice | Gemini/OpenAI 都理论可行，**编排/成本/隔离未验证** = Track 1 核心问题 |
| R4. 单 session 内置声线切换 | 同一连接 per-response 换 voice 参数 | 先验（FLY-883 DR + OpenAI 文档惯例）：voice 在首次 audio 输出后锁定、不可换；2026 版是否放开**待真机复核**（若放开 = 最便宜的多声线路线，值得一测） |
| R5. 自拼管线：DAVE 耳（960）+ Claude 脑 + edge-tts 嘴 | 完全不用 realtime 模型，STT→LLM→TTS | 天然任意声线 + 脑在 repo；代价 = 延迟全靠自己调（v0.4 老路）。**作横评对照行**（baseline），不深挖 |
| R6. 换厂商 dark horse（Annie 问②） | Nova Sonic / Hume EVI / ElevenLabs Conversational / xAI / 国产（Qwen-Omni realtime 等） | 浅扫：只按 text-out / 声线数 / 价格 / 工具 / 中文 / 成熟度收敛「有没有值得深挖的」 |

框架性观察：**「per-Lead 声线」和「最低延迟单声线」是两个不同消费者**——前者是
/meet(545 B) 和 §17 离屏推送，后者是 /live(967 A)。横评结论必须分别对这两个消费者
给建议，不能一刀切。

## 4. 三条 research track（映射 issue 的研究范围 1/2/3）

### Track 1 — Multiple Gemini Live sessions（Annie 问①，真机）

以 3 条并发 session（≈ 1 founder + 3 Leads 的典型会议规模）为实验规模：

- **T1-a 并发可行性**：同 key 同时开 3 条 Live 连接、各配不同 prebuilt voice，是否被
  配额/限流拒绝（Live API 并发 session 配额按 tier 有文档值，真机验证以文档为准再实测）。
- **T1-b 编排语义（谁答谁 unmute）**：三种喂音频策略——
  ① all-listen：把 founder 音频同时推给全部 N session → 谁都想答，怎么压制未点名者
  （system prompt 约束「没点你名就保持沉默」是否真管用 = 关键实验）；
  ② input-gating：只把音频推给被点名的 session → 其他 Lead「没听见会议」，上下文断片；
  ③ gated + transcript 补喂：未点名 session 不喂音频，会后/轮后把输入转写以文本注入
  （Live API 支持文本注入，成本近零）→ 上下文连续性与成本的折中。
  产出 = 三种策略的行为实录 + 推荐。
- **T1-c 成本表**：all-listen = N× 音频输入计费；gated ≈ 1× 音频 + N× 文本。按 883 的
  单价算 3-Lead 一小时会议的真实美元数，做成表。
- **T1-d 上下文隔离**：session 间彼此听不到对方的 audio 回答（各自独立连接）→ Lead A
  的回答要不要转写后喂给 B/C？不喂会怎样（B 答非所问的实录）。
- **T1-e 延迟**：并发 3 session 下被点名者的首 audio chunk 是否仍在 S1 的 0.8-1.0s 带内。

Go/no-go 判据（写死在 plan）：①3 并发被拒 → no-go；②没有任何喂音频策略能同时满足
「只有被点名者出声 + 未点名者不丢会议上下文 + 成本 ≤ 2× 单 session」→ 降级为
「可用但有明确代价」的 qualified-go，代价逐条列出。

### Track 2 — OpenAI Realtime API（Annie 问②主候选，真机）

- **T2-a text-out 验证（本 track 核心）**：gpt-realtime 系现役模型
  `modalities/output_modalities` 是否接受 text-only。若支持 → **R1 在 OpenAI 上复活**：
  OpenAI 当耳+turn 管理、文字出、per-Lead edge-tts 分声线，单 session 就拿到任意声线。
  同场量：语音入 → 首 text token 延迟（+ 叠 edge-tts 首包 = 全链首音估算，对照 §15）。
- **T2-b voice 锁定语义**：单 session 首次 audio 输出后能否 per-response 换 voice
  （R4 路线）。先验是锁死，真机复核 2026 现役模型。
- **T2-c 多 session 形态**（对称 Track 1）：若 T2-a/b 都不理想，OpenAI 版 R3 的并发
  可行性——不必重做全部 T1 实验，验连通 + 声线配置 + 单点延迟即可。
- **T2-d 基础面**：~10 内置声线逐个听感（中文表现！）、function calling 一次真调用、
  输入转写质量（中英混说样本沿用 545 S1 的问话 + 883 建议的 eval 思路）、barge-in
  （response.cancel 语义）、价格核实（883 数字是 2026-07-05 的，只做增量核对）。
- **会话时限**：60min/session 对 /meet（会议 30-60min）意味着什么；对比 Gemini 10-15min
  需 resumption 的工程税。

### Track 3 — 其他玩家浅扫（文档级 + 顺手真机）

每家时间盒 ≤ 1 小时，按统一维度收：response modality（text-out?）/ 声线数与自定义 /
价格 / function calling / 输入转写 / 中文与中英混说 / 生态成熟度（SDK、GA 状态）：

- Amazon Nova Sonic（无 key → 文档级）
- Hume EVI（无 key → 文档级；其「情绪」卖点对我们权重低）
- ElevenLabs Conversational AI（**有 key → 顺手真机**；声线库是其强项，且它本质是
  编排层——STT/LLM/TTS 可组合，可能是 R5 自拼管线的托管版，值得多看一眼）
- xAI（Grok voice：API 开放度存疑 → 文档级）
- 国产一线扫一眼（Qwen3-Omni realtime / MiniMax / 豆包，中文优势但合规/生态另算）

出口 = 「有无 dark horse 值得开 follow-up issue 深挖」一句话结论/家。

## 5. 判定框架（研究结论怎么落成建议）

三个消费场景为轴，§15/§17 为硬判据：

| 消费者 | 需要什么 | 候选路线 |
|--------|----------|----------|
| /meet（545 B）：多 Lead 各自声线+各自脑 | per-Lead 声线 + tool call 回各 Lead 的 Claude 脑 + 首音 ≤1.2s | R3(multi-Gemini / multi-OpenAI)、R1-OpenAI(text+edge-tts)、R5(对照) |
| /live(967 A)：单声线最低延迟助理 | 最低首音 + function calling + 简报注入 | Gemini AUDIO 单 session（S1 已证 0.8-1.0s）vs OpenAI 单 session（本研究补数字） |
| §17 离屏推送（异步、非会议） | per-agent 声线播报（推送形态，延迟宽松） | edge-tts 播报面（543 已有）就够 —— 横评只需确认这点，不新增工程 |

输出物 = ①横评表（延迟/声线/text-out/工具/转写/价格/会话时限/生态成熟度 × 各家）；
②multi-Gemini-Live go/no-go + 成本表（Annie 问①的直接回答）；③OpenAI text-out
verdict + 若复活 B 线的架构含义（Annie 问②）；④对 545/967 的具体选型建议；
⑤founder 一页 HTML（publish-report 到本 issue thread）。

## 6. 边界与资源

- **不写产品代码**。spike 脚本 = throwaway，放 `engineering/spike/FLY-968-voice-bakeoff/`
  （545 S1 同款模式：README + 复现命令，事件日志不进 git）。
- **花费上限**：全部真机验证目标 < $5 API credit（Gemini 按 883 单价、3 session × 分钟级
  实验 = 美分级；OpenAI 贵 4 倍但同样分钟级；ElevenLabs 走现有额度）。超上限先停手报 Lead。
- **key 缺失的厂商不阻塞**：Nova/Hume/xAI 文档级结论 + 「若要真机需 founder 注册」标注。
- 与 967 design 并行不冲突：967 的 A 线用单 session Gemini（S1 已证可行），本研究的
  Track 1/2 结论只影响 545 B 线与 967 的**后续迭代**选型。

## 7. 开放问题（brainstorm gate 已确认，2026-07-07 Tadashi）

1. ✅ 三 track + 3-session 实验规模 + <$5 上限认可。已知事实不重测的纪律确认。
2. ✅ T1 go/no-go 判据认可；Tadashi 强调「成本 ≤2× 单 session」这条要卡严——3 session
   天真实现就是 3×，qualified-go 必须靠喂音频策略把有效成本压下来才算数。
3. ✏️ 修正：founder HTML 由本 Runner **直接 publish-report --channel 1524139853313216544**
   投进本 issue thread（545 runner 已验证 runner 可直投，不经 Lead 转投）。
4. ➕ T2 增补（Tadashi）：若 OpenAI text-out 成立，除「545 原 B 复活」结论外，**顺手评估
   迁移成本量级**——voice-core 的 connector 面要动多少（Annie 决策时必问「换的话要多久」）。
