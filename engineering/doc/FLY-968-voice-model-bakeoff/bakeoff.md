# FLY-968 实时语音模型选型横评 — 定稿

Issue: FLY-968
日期: 2026-07-07
基于: research.md + evidence/（V1-V10 全部真机 verdict，各命题复现命令见对应 evidence 文件）

## 0. Annie 两问的直接回答

### 问①：真的不能用 multiple Gemini Live 吗（每 Lead 一 session、各配内置声线）？

**能用——GO**（gated 编排形态）。三条并发 session 各配一个声线真机跑通，被点名者
延迟 727-1138ms（median 831ms，和单 session 一样，**并发不加延迟税**），成本
≈ 单 session 的 **1.05 倍**（不是天真的 3 倍）。两个关键实验事实：

1. **不能 all-listen**（把你的话同时喂给所有 Lead）：没点名的 Lead 会抢答——
   10 轮里 8 轮有人插嘴，system prompt 压不住。这条路死。
2. **要 gated + 静默补喂**：话只喂给被点名的 Lead，其他 Lead 用文本注入补上下文。
   真机验证了 Gemini 3.1 有一条**不触发说话的注入通路**（`sendClientContent`
   turnComplete:false——这推翻了我们自己 research 阶段的文档级先验），注入后
   Lead 能正确引用会议事实和别的 Lead 说过的话；负对照（不注入就瞎编）证明
   补喂是必要机制。

代价（GO 的附带工程，545 后续迭代做）：点名路由器 + 15 分钟音频时限 ×3 的重连
工程 + preview 模型退役风险 ×3。成本表见 §2。

### 问②：要不要研究替代者？OpenAI 会不会更好？还有谁？

**OpenAI Realtime 把 545 死掉的原 B 设计真机复活了**：`gpt-realtime-2.1` 接受
`output_modalities:["text"]`，3/3 轮语音进→纯文本出、零音频帧。这意味着
「一条 session 当耳朵 + 文本出 → 每个 Lead 用本地 TTS 配声线」重新成立，
单 session 就拿到任意多声线。但全链首音实测 1.5-2.0s，**卡点在本地 edge-tts
的冷启动，不在 OpenAI**（模型侧首 token 只要 0.4-0.7s）；换常驻/流式 TTS
可压到 ~1.0-1.3s（缓解路径已写明，545 迭代的活）。迁移成本 = 加一个
backend 目录（voice-core 已预留 `openai-realtime` 接口位），不是重写。

**其他玩家没有推翻主航道的 dark horse**：ElevenLabs Agents 值得开 follow-up
（托管编排 + 脑可外接 + 首音 717ms 实测，但 $4.8/小时 = Gemini gated 的 7 倍）；
xAI 确认兼容 OpenAI Realtime 规范（写好 openai backend 后近零成本多一家供应商）；
Qwen3.5-Omni-Realtime（realtime 会话内克隆声线 + 中文最强先验）进观察名单第一位；
Nova 2 Sonic / Hume 官方语言列表仍无中文，出局。

## 1. 横评表定稿（实测列 = 本 issue spike；E 级同 research.md 图例）

| 维度 | Gemini Live (3.1-flash-live-preview) | OpenAI Realtime (gpt-realtime-2.1) | ElevenLabs Agents | R5 自拼对照(960+883) |
|------|--------------------------------------|-------------------------------------|-------------------|---------------------|
| 延迟(speech-end→首音,实测) | **797-1017ms**(S1 单 session)/**727-1138ms**(3 并发,本 issue) | audio 模式未测*;text 模式首 token **392-720ms**+TTS | **717-737ms**(含内置 TTS) | v0.4 老路 ~2-3s(883) |
| text-out | **无**(全系拒 TEXT,S1) | **有,真机 3/3**(V1) | 天然(脑层文本可得) | 天然 |
| 声线 | 30 prebuilt,**10/10 中文可懂**(V8);per-session 一声线 | 10 prebuilt,**10/10 中文可懂**(V8);首音后锁定 | 海量库+克隆 | edge-tts 任意 |
| per-Lead 声线路线 | **多 session gated(GO,V3-V7)** | 单 session text→edge-tts(复活)或多 session | 多 agent(未验) | 天然 |
| function calling | 有(543 已用) | **真机全事件链,speech-end→call 710ms**(V9) | 平台层有 | 自己写 |
| 输入转写(中英混说) | 内置;"Huddle"→「哈豆」(S1) | 内置;**英文词全对**,"FLY-968"→"flight968"(V1/V9) | 内置 scribe;**英文词全对**,"FLY-968"→"Fly968"(V10) | Whisper 系(960) |
| barge-in | 有(S1 观察) | **speech_started→cancel 34ms**(实测最快) | 平台 turn_v3 托管 | 自己写 |
| 价格(60min 会议口径) | 单 $0.66;**gated×3 ≈$0.68** | text-out 模式:audio-in $1.15+text-out 美分级 ≈**$1.2-1.3**;audio-out 模式 ≈$2.7 | **~$4.8**(+外接脑另算) | edge-tts 免费+STT/LLM |
| 会话时限 | **15min 音频**(重连税×N) | **60min**(/meet 一场一连) | 平台托管 | 无 |
| 生态成熟度 | preview 波动(FLY-959 退役常态) | GA 命名也在漂(gpt-realtime→2.1) | 平台成熟,编排托管 | 全自控 |

*OpenAI audio 模式延迟未单测（时间盒给了 text-out 主线）；883 DR 口径 ~500-800ms，
545 迭代若走 OpenAI audio 模式需补一发单点实测。

## 2. multi-Gemini 成本表（问①配套，V7 实测口径）

| 策略 | 60min 会议估算 | 相对单 session | 判 |
|------|---------------|----------------|-----|
| 单 session | ~$0.66 | 1× | 967 A 形态基线 |
| all-listen ×3 | ~$1.67(实测抢答输出≈2.2×名义) | ~2.5× | **不可用**(服从性 8/10 轮违规) |
| **gated+静默补喂 ×3** | **~$0.68** | **~1.05×** | **推荐** |

## 3. 对 /meet(545) 的建议

1. **B 线两条活路，按延迟合同二选一（或并行小步验证后拍）**：
   - **B-Gemini-multi（主推）**：gated 多 session + `sendClientContent(turnComplete:false)`
     静默补喂。延迟已实测达标（≤1.2s 带），成本 1.05×，声线 30 选 N。
     TurnRouter/LeadSpeaker 合同改动 = 点名路由（音频只进被点名 session）+
     补喂管线（其余 session cc 注入转写）+ ×N 重连管理。
   - **B-OpenAI-text（备选，声线上限更高）**：单 session text-out + per-Lead
     本地 TTS。**前提 = 换常驻/流式 TTS**（edge-tts CLI 冷启动是唯一破线项）；
     好处 = 单连接、60min 时限、per-response 可混 text/audio 模态、声线不受
     内置数限制。545 plan 里的「response-text 事件」小扩展直接 retarget。
2. **补喂可靠性要当一等公民设计**：负对照显示不补喂时模型会自信瞎编
   （Hiro 编了个「疾风」代号）——补喂管线丢消息比没有补喂更危险。
3. 迁移成本口径（Tadashi 增补问）：OpenAI backend = 三件套 ≈600 行照 gemini
   模式 + spike 已验证的事件映射表（v1-v2 evidence 附）——**一个 backend 目录
   + 一轮真机 spike 的量级，非架构迁移**。

## 4. 对 /live(967) 的建议

**A 线维持 Gemini 单 session，不换**。理由：延迟实测最优带（0.8-1.0s）、成本
1/2-1/4、967 不需要 per-Lead 多声线。两个已知税照旧管理：15min 重连（543 已有
resumption 位）+ preview 退役监控（FLY-959 模式）。OpenAI 作 fallback 供应商
写进 backend 路线图（xAI 兼容层使同一 backend 未来可指三家）。

## 5. 花费实报

| 项 | 实耗 |
|----|------|
| OpenAI（s2/s3 全部轮次） | <$0.15 |
| Gemini（sweep+多 session+judge 全部） | <$0.10 |
| ElevenLabs | Creator 订阅内 ~1.5min 会话额度（现金 $0） |
| **合计** | **<$0.30**（上限 $5，用了 6%） |

单轮 >$0.50 熔断线全程未触发。

## 6. Verdict 索引

| 命题 | verdict | evidence |
|------|---------|----------|
| V1 OpenAI text-out | PASS | v1-v2-openai-text-out.md |
| V2 全链首音 | FAIL(现配方)/缓解明确 | v1-v2-openai-text-out.md |
| V3 三并发连通 | PASS | v3-v7-gemini-multisession.md |
| V4 all-listen 服从性 | FAIL(8/10) | v3-v7-gemini-multisession.md |
| V5 gated+补喂 | PASS(cc 通路) | v3-v7-gemini-multisession.md |
| V6 并发延迟 | PASS(median 831ms) | v3-v7-gemini-multisession.md |
| V7 成本实测 | PASS(gated 1.05×) | v3-v7-gemini-multisession.md |
| V8 双厂商声线 | PASS×2 | v8-gemini-voice-sweep.md / v8-v9-openai-basics.md |
| V9 工具+混说转写 | PASS | v8-v9-openai-basics.md |
| V10 ElevenLabs | 值得 follow-up | v10-elevenlabs.md |
| P4.5 文档刷新 | 无 dark horse | vendor-doc-refresh.md |
