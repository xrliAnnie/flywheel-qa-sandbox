# FLY-968 P4.5 — 无 key 厂商文档级刷新

Issue: FLY-968
日期: 2026-07-07（全部当日查证）
基于: ../plan.md §3 P4.5（时间盒 ≤1.5h；Codex R1 #4）

| 厂商 | 查证来源(2026-07-07) | text-out | 声线/克隆 | 工具调用 | 中文 | 公开价格 | 结论 |
|------|---------------------|----------|-----------|----------|------|----------|------|
| **Amazon Nova 2 Sonic**(2025-12-02 发布) | docs.aws.amazon.com/bedrock model-card-amazon-nova-2-sonic + nova2-userguide sonic-language-support + aws.amazon.com/blogs 发布文 | **有**（Speech+Text 双输出模态，textOutput 事件） | polyglot 声线（如 Tiffany 跨语言） | 有 | **官方 7 语言 = EN/FR/IT/DE/ES/PT/HI，无中文**（社区称"能出声"但无质量保证） | Bedrock 计价，~$0.015/min 量级 | **watch**（从"出局"升半级：text-out+1M context 意外强，但中文第一权重仍不满足；另有 8min 连接上限、需 AWS key/区域） |
| **Hume EVI 4** | dev.hume.ai speech-to-speech-evi overview/voice/custom-language-model + hume.ai/pricing | CLM 通道有文本流 | 100+ 声线 + voice-by-description + 克隆 | 有 | **11 语言无中文**（官方称扩至 20+ 中） | 订阅制，超量 ~$0.07/min | **ignore**（中文缺位 + 情绪卖点权重低；等中文上线再看） |
| **xAI Grok Voice Agent API** | docs.x.ai voice-agent + x.ai/news grok-voice-agent-api | 兼容 OpenAI Realtime 规范（待真机验 text-only） | 内置声线(少) | 有（+实时 X 数据） | 数十语言（中文具体质量待验） | **$0.05/min** 语音（含声线） | **watch = 第二供应商**：`wss://api.x.ai/v1/realtime` 换 base URL 即接（事件名有差异，如 transcription **updated 累积式** ≠ OpenAI delta 增量式——adapter 要留兼容垫片，不是零成本是"近零成本"） |
| **Qwen3.5-Omni-Realtime**(2026-03-30 发布) | alibabacloud.com/help/model-studio realtime + qwen-omni-voice-cloning | 待验 | 有 + **realtime 会话内可用克隆声线**（plus/flash 档） | **有**（realtime 工具调用） | **先验最强**（Qwen 系中文 + 新加坡/美东 region） | 国产价位（flash 档低） | **follow-up 观察名单第一位**：per-Lead 克隆声线 + OpenAI 兼容 + WebSocket/WebRTC，中文后备路线成型（接棒 883 CosyVoice 战略位） |
| **MiniMax Realtime** | minimax.io/news/realtime-api + models/speech | 待验 | 40+ 语言 zero-shot 克隆 | 有 | 强 | 未细查 | **watch 一行**：Speech 2.6 端到端 ~250ms 宣称，声线克隆强；生态/合规另算 |
| **豆包 Doubao Realtime** | seed.bytedance.com/special/realtime_voice | 待验 | 有 | 有 | 强（方言强项） | 未细查 | **watch 一行**：端到端 S2S ~700ms 宣称、全双工；国内生态锁定，不适合我们部署形态 |

**结论**：没有推翻主航道的 dark horse。两条增量情报值得记录——
① Nova 2 Sonic 意外支持 text-out（若未来加中文，B 线架构直接适用）；
② xAI 作为 OpenAI-Realtime 兼容第二供应商成立，但事件语义有差异，openai backend
写 adapter 时留 vendor 垫片位。ElevenLabs 保持唯一非主线真机厂商（见 v10）。
