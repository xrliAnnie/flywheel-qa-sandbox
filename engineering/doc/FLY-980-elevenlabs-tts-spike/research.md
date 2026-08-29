# FLY-980 /eleven 完整一条线 spike — 调研

Issue: FLY-980 (https://linear.app/geoforge3d/issue/FLY-980/voicespike-elevenlabs-tts-实测-真机合成-per-lead-声线-质量延迟成本-voice-core-可插拔)
日期: 2026-07-07
基于: exploration.md（r3，gate 放行版）

## 1. Custom LLM 契约（官方文档取证，2026-07-07）

来源: elevenlabs.io/docs/eleven-agents/customization/llm/custom-llm +
api-reference/agents/create。

**我们要暴露的 endpoint**（二选一，选 chat_completions —— 生态最通用）：

- OpenAI 兼容 `POST /v1/chat/completions`，响应 SSE
  （`Content-Type: text/event-stream`，`data: {json}\n\n` 流式 chunk，
  `data: [DONE]\n\n` 收尾）。
- 平台每轮下发：`messages`（**全量对话历史**，含平台注入的 system prompt）、
  `model`、`temperature` / `max_tokens` / `stream`、`elevenlabs_extra_body`
  （自定义透传参数）、配置了系统工具时的 `tools` 数组（OpenAI 格式）。

**⇒ 关键架构事实：endpoint 可以完全无状态** —— 平台持有会话历史，每轮全量下发。
这与 `HeadlessClaudeBrain` 的两种模式都吻合：
- history 再注入模式（brain 已有 fallback）：每轮 fresh `claude -p` + 全量历史进
  prompt —— 无状态、直接映射，但每轮重付 persona/上下文 token；
- resume 模式：endpoint 持 session_id、只喂最后一轮 —— 有状态但省 token、
  FLY-543 实测 resume 轮显著快于首轮。spike 两种都测（§2 延迟阶梯的子变量）。

**agent 侧配置**（create-agent API 已确认字段）：

- `conversation_config.agent.prompt.llm = "custom-llm"`
- `conversation_config.agent.prompt.custom_llm = { url, model_id?, api_key?
  ({secret_id} 或 {env_var_label}), request_headers?, api_type: "chat_completions" }`
- 公网 URL 必须（官方文档自己举 ngrok 为例）；鉴权经 `api_key`（workspace
  secret）或 `request_headers` 自定义 Bearer 头。
- TTS: `conversation_config.tts.voice_id` + `tts.model_id`；
  语言: `agent.language`；转轮: `turn.turn_timeout`（默认 **7s**，1-30 可调）、
  `turn.turn_eagerness`（patient/normal/eager）、`turn.turn_model`
  （turn_v2 / turn_v3 —— V10 报的 turn_v3 得到 API enum 确认）。

## 2. 延迟先验与预算

| 数据点 | 值 | 来源 |
|--------|-----|------|
| V10 内置脑（gpt-4o-mini）speech-end→首音 | **717-737ms** | FLY-968 v10 真机 |
| Gemini Live 单 session 同口径 | 797-1017ms | FLY-968 S1 |
| OpenAI Realtime text 模式首 token | 392-720ms | FLY-968 V1 |
| claude -p 首轮全轮耗时（Opus、满项目上下文、~134k token cache 建立） | **25.7s** | FLY-543 spike-phase0 |
| claude -p resume 轮全轮耗时（同环境） | **6.5s** | FLY-543 spike-phase0 |

**claude -p 是 /eleven 全链延迟的最大风险源**，但 FLY-543 的数字是最坏口径
（Opus + 项目目录满上下文 + 全轮而非首 token）。spike 的可归因变量：

1. **cwd 隔离**：空目录跑 claude -p（不吃项目 CLAUDE.md/.mcp.json 上下文）；
2. **模型档**：--model haiku / sonnet 主测（D9'），Opus 1-2 轮留证；
3. **口径**：测「请求到达 shim → 首 text_delta」（真正卡 TTS 的量），
   不是全轮；
4. **resume vs 全量历史再注入**（§1 两模式）。

**全链判据带**（founder 报告用）：≤1.2s 优（与 Gemini/内置脑同带）/ ≤2s 可用 /
>3s 口语对话难用。参照分解：全链 ≈ V10 平台开销（STT+TTS ≈ 717ms 里的大头）+
脑首 token + 隧道往返（echo 档直接量出「平台+隧道」基线）。

**慢脑等待机制（design review R1 更正）**：`turn_timeout` 管的是**用户静默后
多久接话**（端点语义），不是等慢 LLM 的控制面；平台等慢 LLM 响应的官方机制是
**Soft timeout**（先说垫话、继续等真实回答，conversation-flow 文档）——
慢脑行为实测（V5b）以 soft timeout 开/关为对照变量，turn_timeout 仅作
端点语义取证（V5a）。

## 3. 计费口径（2026-07 现价，官方 pricing 页 + 降价公告）

- Creator $22/月 = **121k credits（TTS/合成侧）+ Agents 通话 275 分钟/月 +
  10 并发**。**Agents 按分钟计费、独立于 credits 池**（这推翻了 V10 时
  「会话烧 credits」的记账猜测 —— V10 的 ~1.5min 走的是分钟池）。
- 超额 $0.08/min（超并发 burst $0.16/min）。
- **Custom LLM 形态下平台侧只剩会话分钟费**；脑侧 = claude -p 订阅内
  **$0 边际成本**（D10'）。API 档只作延迟参照，顺带记 token 价。
- TTS credits：flash/turbo v2.5 = 0.5 credit/字符，multilingual_v2 = 1 credit/字符。
- 60 分钟会议口径对照（bakeoff 表延伸）：/eleven 订阅内 = $0 边际（275 min 池内），
  超额后 $4.8/小时；multi-Gemini gated ≈ $0.68；OpenAI text-out ≈ $1.2-1.3。
  **founder 报告要给「订阅内」和「超池后」两条线** —— Annie 现有订阅下
  每月 275 分钟内 /eleven 的现金成本是 $0，这改变 V10「贵 7 倍」的叙事框架。

## 4. per-Lead 多声线架构（V10 未验项的文档级答案）

来源: docs/eleven-agents/customization/personalization/overrides。

- **per-session override** 支持覆盖：voice_id、system prompt、language、LLM、
  first message、stability/speed/similarity —— 需先在 agent **Security tab
  逐字段启用**（默认全关）。
- 传递方式：会话起始帧 `conversation_initiation_client_data` 的
  `conversation_config_override`（WS 形态；s5 脚本已有该起始帧通路位）：
  `{ agent: { prompt: {...}, language }, tts: { voice_id, ... } }`。
- **⇒ 单 agent + per-session override 即可承载 8 个 Lead**：每次会话 =
  该 Lead 的 voice_id + persona prompt override。不必 8 个 agent。
  备选（每 Lead 一 agent）管理面更重、无计费差（并发同池）——spike 只验
  单 agent + override 路线，多 agent 写 follow-up。
- spike 待确认项：Security tab 的启用位能否经 API 设置（create/patch agent
  的 platform_settings / security 字段），否则建 agent 后需一次 dashboard
  手工操作（记进 runbook）。

## 5. 中英 + 一把声线（D11' / D12'）

- **multilingual 系模型（multilingual v2 / turbo v2.5 / flash v2.5）跨语言保持
  同一声线特征** —— 一个 voice ID 中英通吃是官方口径（voice library 有
  multilingual 声线专区）。
- agent 侧：`additional languages` 预设 + `language_detection` **系统工具**
  实现会话内自动切语言 —— 注意该工具经 custom LLM 的 OpenAI `tools` 数组下发，
  **我们的 shim 必须正确回 function call 才能用它**（顺带成为工具通路的
  真机验证载体，一石二鸟）。
- 单句内中英混（code-switch，Flywheel 高频形态「FLY-980 的 PR 过了」）：
  V10 已证 zh agent + flash v2.5 的 STT 混说全对；**TTS 混说输出质量**（英文
  术语发音自然度）是 spike 实测项。
- 非英语 agent 的 TTS 模型约束：V10 实证「非英语 agent 必须 turbo/flash v2.5」
  （agents 的 TTS enum 里 multilingual_v2 是否可选，spike 时从 API 校验错误信息
  确认）；**独立 TTS audition 侧无此约束** —— audition 可用 multilingual_v2
  出高质量档样本，agent 实跑用 flash v2.5，同 voice ID 两档都留 wav。

## 6. 打断（barge-in）语义

来源: docs/eleven-agents/customization/conversation-flow。

- interruption = client event，agent Advanced tab 可开关（默认形态待 spike 确认）。
- **文档未写打断时对 custom LLM in-flight HTTP 请求是否中止** —— spike 必测：
  我们的 shim 要正确处理连接中断（AbortSignal → 杀 claude -p 子进程，
  HeadlessClaudeBrain 已有该通路），并打点记录「打断后平台是否断开/复用连接」。
- turn_v3 已是 API enum（§1），平台托管 turn-taking，无需自建 VAD。

## 7. 工具调用（ask_lead / issue_status 一类）

两条路，spike 选 (b) 为主 + (a) 借 language_detection 验通路：

- **(a) 平台工具面**：系统工具（end_call / language_detection / skip_turn…）
  经 OpenAI `tools` 数组下发给我们的 shim，shim 需产出 OpenAI 格式 function
  call 响应。自定义 client/server tools 也走平台面，但执行位在平台/客户端。
- **(b) endpoint 内消化（推荐主线）**：ask_lead / issue_status 在 shim 内部
  执行（拿数据、拼进回答文本），对平台完全不可见 —— 工具权限/安全边界留在
  我们侧，贴 Flywheel 安全模型（founder-only-authority 不外泄执行面）。
- 与 HeadlessClaudeBrain **零工具 POC 边界**的调和：spike 的 (b) 用
  「shim 层数据注入」形态（shim 拦截/预取数据塞进 prompt 或后处理），
  **不改 brain 的零工具合同**；真工具化（brain 带 MCP 工具）是生产化议题，
  写 follow-up。
- spike 验收：(a) language_detection 一条 function call 真机走通（或平台
  拒绝 custom LLM 用系统工具的文档级判死记录）；(b) 一条「问 issue 状态 →
  shim 注入 mock 数据 → 口头回答」演示。

## 8. 隧道与安全（spike 期）

- 公网 URL：**cloudflared quick tunnel** 首选（免费、无账号、随机
  trycloudflare.com URL、单命令）；ngrok 备选。
- shim 鉴权：随机 Bearer token（spike 启动时生成）→ 配进 agent 的
  `custom_llm.request_headers`；shim 校验失败一律 401。隧道 URL + token
  不落 git/文档，会话后撤（agent 删除或 URL 失效）。
- ELEVENLABS_API_KEY：真调步由 Lead 协调 Annie 放 `~/.flywheel/.env`
  （0600，脚本 env 读取，不进 argv/Discord —— FLY-510 同款纪律）。
- spike agent 用后即删（V10 同款清理纪律）。

## 9. 复用资产映射

| 资产 | 用途 |
|------|------|
| `spike/FLY-968-voice-bakeoff/s5-elevenlabs-agent.mjs` | 会话驱动侧骨架（get-signed-url → WS → PCM 喂音 → audio event 打点）；扩展：起始帧带 conversation_config_override + 打断注入 |
| `spike/FLY-968-voice-bakeoff/ref/`（.pcm 被 gitignore，跑 `gen-ref-audio.sh` 重新生成） | 中文/中英混语料 u1/u2（与 V10 同口径可比）；英文语料 u3-en 同法新增（D11'） |
| `spike/FLY-968-voice-bakeoff/s4b-voice-judge.mjs` | 声线 judge 方法学（逐字转写 + 可懂度 0-2 / 可区分度 0-3；wav 留 founder 终审） |
| `packages/voice-core` (`flywheel-voice-core`, main=dist) | `HeadlessClaudeBrain` + `BrainAdapter` —— spike 不进 workspace（pnpm-workspace.yaml 只含 packages/*），shim 用**相对路径 import dist**（`../../../packages/voice-core/dist/index.js`），跑前必须 `pnpm --filter flywheel-voice-core build`（fresh checkout 无 dist） |
| 8-Lead persona 表（**已内联 plan §S7**；来源 PR #496 未合并，fresh checkout 无该脚本文件） | ElevenLabs 选声线的需求输入 + edge-tts 对照基线 |
| FLY-968 bakeoff.md 全表 | Gemini/OpenAI 对照列直接引用，不再花钱 |

## 10. 风险清单

| # | 风险 | 处置 |
|---|------|------|
| R1 | claude -p 慢（6.5s 全轮先验）→ 平台等慢 LLM 的体感未知 | 空 cwd + haiku/sonnet + 首 token 口径实测；Soft timeout 开/关对照（慢脑等待的正确控制面，见 §2 更正）；慢脑时平台行为专门记录 |
| R2 | 打断时 in-flight 请求行为未文档化 | shim 打点 + 真机打断注入实测（§6） |
| R3 | override 的 Security 启用位可能 API 设不了 | spike 确认；不行则 dashboard 一次手工 + runbook 记录 |
| R4 | agents 平台/文档迭代快（docs URL 已换过一次，preview 波动是 FLY-959 常态） | 每个契约点 spike 落 evidence 带日期；报告注明取证时间 |
| R5 | 中英混单句 TTS 发音质量未知 | audition 样句专设混说句；judge + Annie 终审 |
| R6 | Creator 并发 10 上限 | spike 无压力；多 Lead 常驻场景写进产品化考量 |
| R7 | 平台注入的 system prompt 与我们 persona override 的拼接顺序/冲突 | echo 档打印收到的 messages 原文取证 |

## 11. 结论（研究阶段判断，待真机验证）

文档级无死刑项：Custom LLM 契约清晰且与 HeadlessClaudeBrain 的
AsyncIterable 面天然吻合；单 agent + override 解决 per-Lead 声线；
一把声线中英通吃有官方口径；计费比 V10 认知友好（订阅内 275 min 边际 $0）。
**全案成败集中在一个数字上：claude -p 快模型 + 空 cwd 的首 token 延迟** ——
它决定 /eleven 是「≤2s 可用带」还是「>3s 难用带」。spike 的设计（三档脑
阶梯 + 双会话模式 + 双模型档）就是为把这个数字测准并给出最优配方。
