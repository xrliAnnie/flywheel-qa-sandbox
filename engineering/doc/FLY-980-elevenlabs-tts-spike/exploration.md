# FLY-980 /eleven 完整一条线 spike — 探索

Issue: FLY-980 (https://linear.app/geoforge3d/issue/FLY-980/voicespike-elevenlabs-tts-实测-真机合成-per-lead-声线-质量延迟成本-voice-core-可插拔)
日期: 2026-07-07
基于: 无（本 issue 首篇；上游输入 = FLY-968 bakeoff.md + evidence/v10-elevenlabs.md、FLY-546 PR #496 voice 面、Lead 定向指令 2c6914ff）

> **方向修订记录**：本文档 r1 按 issue 原文写成「裸 TTS 后端实测」；brainstorm gate
> 上 Lead 传达 Annie 拍板：**只当 TTS 不值（edge-tts/Gemini 已够），要用就用
> ElevenLabs 自己的 Agent 完整栈** —— 本 r2 围绕 **/eleven 完整一条线** 重写。
> 裸 TTS-only 组件路线已否，正文只保留一句带过。

## 1. 问题定义

**/eleven** = 三条语音产品线之三（命名定稿，gate r3 Annie 拍板）：
① **/glaw** = Gemini 耳 + Claude 脑；② **/gemini** = Gemini 全包（原 /live）；
③ **/eleven = ElevenLabs Conversational AI 全栈 + Claude 当脑**。三个名字 =
founder 分辨「背后连的是哪个模型组合」的心智模型：

- **耳**：ElevenLabs 内置 STT（scribe_realtime，V10 已验中文 + 英文术语全对）
- **嘴**：ElevenLabs 声线库（海量 + per-Lead 差异化）
- **turn-taking / 打断**：平台 turn_v3 模型托管
- **脑**：**Flywheel 自己的 Claude 脑**（Lead 人格 + ask_lead / issue_status 一类
  工具），通过 ElevenLabs **Custom LLM** 接入 —— 给平台一个 OpenAI-兼容
  endpoint，它把每轮对话转发过来。**不是裸 Claude 模型。**

本 spike 用真机回答 founder go/no-go：**/eleven 这条线可行吗？延迟、成本、
中文表现、打断/工具各是什么水平？**

五个子问题（Lead 定向指令原文顺序）：

1. **Custom LLM 接法**：能不能把我们的 Claude 脑包成 OpenAI-兼容 endpoint？
   确切协议（请求/流式响应形状、鉴权、超时、会话状态谁持有）是什么？
2. **端到端延迟**：说话 → STT → Claude → TTS → 出声，全链首音多少？外接脑比
   V10 内置脑（gpt-4o-mini，717-737ms）贵多少毫秒？和 Gemini Live
   （797-1017ms）比在哪个带？
3. **成本**：$/min 实测（Custom LLM 形态下平台侧只剩会话费，脑费在我们侧）。
4. **中文 STT + 声线**：中文/中英混 STT 可懂度（V10 已有初证，扩样本）+
   per-Lead 声线在 ElevenLabs 库里的可选性与可区分度。
5. **打断 / 工具调用**：barge-in 在外接脑形态下怎么走（平台会不会中止对我们
   endpoint 的请求）？工具调用（ask_lead / issue_status）在 Custom LLM 协议里
   怎么落（平台工具面 vs endpoint 内部消化）？

## 2. 与已有工作的边界

| | FLY-968 V10（已测） | 本 issue /eleven spike |
|--|--|--|
| 形态 | Agents + **平台内置脑**（gpt-4o-mini） | Agents + **Custom LLM 外接 Claude 脑** |
| 已验 | 建 agent、WS 裸 PCM 进出、中文 STT、首音 717ms、turn_v3 | —— |
| 未验（V10 留的坑，本 spike 主战场） | 外接脑往返的延迟惩罚；per-Lead 多声线怎么切；工具/打断在外接形态的行为 | ①-⑤ 全部 |
| TTS-only 组件路线 | —— | **已否**（Annie：edge-tts/Gemini 已够，只当 TTS 不值）——一句带过，不测 |

与 /meet（FLY-545，PR #495 进行中）、/live（FLY-967）的关系：**平行产品线候选，
不改它们的代码**。本 spike 结论供一个月三线 bake-off 拍板用。

## 3. 现状审计（codebase ground truth）

### 3.1 Claude 脑已存在 —— `HeadlessClaudeBrain`（main 已合）

`packages/voice-core/src/brain/HeadlessClaudeBrain.ts`（FLY-543 落地、FLY-959 修过）：

- `claude -p` 无头子进程；Lead 人格 = `--append-system-prompt-file <identity.md>`；
  `--resume <session_id>` 跨轮保持会话（人格随 session 保留，不重注历史）。
- 流式：`--output-format stream-json --include-partial-messages` → 只取
  `text_delta` → `BrainAdapter.respond()` 产出 `AsyncIterable<string>`。
- POC 安全边界：**零工具**（`--tools "" --strict-mcp-config`），voice-context
  明说「不能执行、只能讨论」——批准/ship 只会得到口头回复。
- **这就是要包进 OpenAI-兼容 endpoint 的现成脑**：`respond()` 的
  AsyncIterable<string> → OpenAI SSE `chat.completion.chunk` 是一层薄适配。

已知风险（spike 要实测的核心变量）：`claude -p` 每轮 spawn 子进程 +
`--resume` 加载，**首 token 延迟先验在秒级** —— 可能吃掉全链延迟预算。对照组
（直连 Anthropic API + identity.md 当 system prompt）能给出延迟下界，但形态上
「不是裸 Claude 模型」的要求意味着 claude -p 是主测形态、API 直连是延迟
参照/生产备选形态（各自的订阅 vs 按 token 计费差异写进成本节）。

### 3.2 FLY-968 可复用资产

- `engineering/spike/FLY-968-voice-bakeoff/s5-elevenlabs-agent.mjs`：**建
  agent + WS 会话 + 喂 PCM + 收 audio event + 时间戳日志**的完整参考实现
  —— /eleven 原型的会话驱动侧直接改造它。
- `ref/u1-16k.pcm / u2-16k.pcm`：中文/中英混参考语料（与 V10 同口径可比）。
- `s4b-voice-judge.mjs`：Gemini model-as-judge（逐字转写 + 可懂度 0-2 /
  可区分度 0-3，wav 留 founder 终审）——声线初筛方法学照搬。
- Gemini Live / OpenAI 对照数据：bakeoff.md 全表直接引用，不再花钱重测。

### 3.3 FLY-546 PR #496 —— per-Lead 声线需求输入

`scripts/voice-audition-fly546.mjs` 的 8-Lead persona 表（Tadashi=专业男声 /
Cass=温暖女声 / Honey Lemon=活泼女声 / Mufasa=沉稳男声 / Belle=口音辨识位 /
Peter=阳光男声 / Hiro=年轻男声 / Simba=wildcard）——**/eleven 每个 Lead 也要有
声线**，这张表是 ElevenLabs 选声线的需求输入 + edge-tts 对照基线。

### 3.4 依赖缺口（已验证）

- `~/.flywheel/.env` 无 ELEVENLABS_API_KEY —— 真调那步 Lead 协调 Annie 放入
  安全配置（不进 Discord、不进 argv，env 文件读取）。
- **公网可达性**：Custom LLM 要求 ElevenLabs 云能 POST 到我们的 endpoint ——
  本机 spike 需要隧道（cloudflared quick tunnel / ngrok 一类）。endpoint 必须
  带鉴权（Bearer key），隧道 URL 不落文档、会话结束即撤 —— research 定具体方案。

## 4. 设计空间（3 条路线 + 推荐）

### 路线 A（推荐）：真机最小原型 + 阶梯式脑形态

一条最小 /eleven 原型链真机跑通，脑形态按延迟阶梯测三档：

1. **echo 脑**（endpoint 直接回固定文本）→ 测出「平台 + 隧道往返」的纯开销
   下界，把 Custom LLM 协议先跑通；
2. **Anthropic API 脑**（identity.md 当 system prompt，流式）→ 延迟下界的
   真实脑参照；
3. **HeadlessClaudeBrain 脑**（claude -p + resume，真 Flywheel 形态）→ 主测。

配套：声线选配用 TTS 合成做 audition（8 Lead × 2-3 候选 + judge 初筛 + wav 留
Annie 终审 —— 这是声线选配工具，不是 TTS-only 路线复活）；打断/工具真机各测
一组；成本从 subscription usage 前后差实测。

优点：五个子问题全覆盖；三档脑形态把「延迟惩罚」拆成可归因的分量（平台/隧道 vs
脑本体）；echo 档保证协议先通再上真脑，失败可归因。
缺点：比单档脑多 ~10 分钟会话额度 —— 换来的归因价值远超。

### 路线 B（最小）：只测 HeadlessClaudeBrain 一档

直接上真脑跑 E2E。省额度，但延迟超标时无法归因（是 claude -p 慢还是平台等
首 token 的缓冲策略慢），go/no-go 报告说服力弱。**不推荐**。

### 路线 C（最大）：加生产化预研（Bridge 集成、多 agent 编排、Discord 桥）

把 /eleven 接 Discord VC / Bridge scope 一起预研。范围蔓延 —— issue 边界明写
「评估 + 真机实测为主，不做完整生产集成」；三线 bake-off 拍板前不动生产面。
**不推荐**（写 follow-up 建议即可）。

## 5. 关键设计决策（自决 + 理由，gate 上呈 Lead）

| # | 决策 | 理由 |
|---|------|------|
| D1' | 测 Agents + Custom LLM 全栈；TTS-only 一句带过 | Annie 拍板（2c6914ff 取代 issue 原文范围） |
| D2' | 脑形态三档阶梯（echo / API / claude -p），claude -p 是主测形态 | 延迟惩罚可归因；「不是裸 Claude」= claude -p 才是 /eleven 真形态 |
| D3' | per-Lead 声线：TTS audition（8 Lead）+ 原型 agent 只配终选 2-3 个 Lead 声线实跑 | audition 便宜且方法学现成；多 agent vs 单 agent 声线切换是 research 问题，原型不铺 8 个 agent |
| D4' | Gemini Live / OpenAI 对照列引用 FLY-968 数据 | <24h 新鲜；省额度；口径差表内注明 |
| D5' | 工具调用 spike 只验一条最小通路（研究定：平台工具面 or endpoint 内消化），不建全工具集 | go/no-go 只需要「这套里工具怎么走」的机制答案 |
| D6' | 额度无硬上限（gate r3 Annie 拍板）：本月 $22 配额可用到 100%，原则 = 不无谓浪费，每脚本跑完读 subscription usage 记账 | Annie 本月不做 social media，额度闲置；§6 估算仅作参考，不设熔断 |
| D7' | founder 报告 = publish-report 到 issue thread；音频样本内嵌试听，CSP 拒则本地 audition 文件夹兜底 | issue 原文要求保留；FLY-546 同款兜底 |
| D8' | spike 代码全部落 engineering/spike/FLY-980-eleven/，不碰 packages/ | 评估性质；三线拍板前不动生产面 |
| D9' | 脑模型 = 快档为主测（claude -p --model sonnet / haiku）；Opus 只跑 1-2 轮留延迟铁证 | founder 明确要求（gate r2）：接 Claude 要换快模型，Opus 对话会很慢 —— 延迟阶梯加「模型档」维度 |
| D10' | **脑用订阅不用 API**（gate r3 Annie 拍板）：生产形态 = claude -p（订阅零边际成本）；Anthropic API 档只做「纯思考延迟下界参照」，非生产选择；成本主报订阅口径 | founder 指令原文；成本表脑侧一列写 $0（订阅内） |
| D11' | **中英都测**（gate r3）：STT 语料 + 声线样句都出中文、英文两组数据（中文为重点） | founder 指令：原理一样、一并出数据 |
| D12' | **一把声线中英通吃真机验**（gate r3）：multilingual 模型应是一个 voice ID 说多语言 —— 逐 Lead 验「同一 voice ID 中英两条样本都好听」，wav 留 Annie 终审 | founder 指令：确认「一个 Lead 一把声线、中英通吃」再选 |

## 6. 额度预算估算（D6' 依据）

| 项 | 估算 |
|----|------|
| 协议打通（echo 脑）：~5 轮短会话 | ~3 min 会话额度 |
| 延迟测量：3 档脑 × ≥5 轮 | ~15 min |
| 打断 + 工具通路各一组 | ~5 min |
| 声线实跑（2-3 Lead agent 各几轮） | ~5 min |
| TTS audition：8 Lead × 3 候选 × ~70 字符（flash 0.5/字符） | ~840 credits |
| judge 长样句（终选 8 × ~200 字符 × multilingual 1.0） | ~1,600 credits |
| 余量 ×1.5 | 会话估算 ~40 min；TTS 估算 ~1 万 credits |

无熔断（D6'，gate r3）：以上仅是参考估算 —— 本月配额可用到 100%。纪律 =
每个脚本跑完读一次 subscription usage 记账进 evidence，不无谓浪费（比如同一
样句不重复合成、失败先查原因再重试），但不设硬停线。

## 7. 成功判据

- Custom LLM 协议契约文档化（请求/SSE 响应形状、鉴权、超时、状态归属）+
  echo 脑真机握手通过。
- 三档脑形态各 ≥5 轮「speech-end → 首音」实测中位数，与 V10 内置脑 717ms、
  Gemini Live 797-1017ms 同口径对比。
- $/min 实测（subscription usage 前后差）+ 计费口径换算；脑侧成本主报订阅
  口径（claude -p = 订阅内 $0 边际，D10'；API 档仅作延迟参照顺带记 token 价）。
- STT 转写样本中文、英文、中英混各 ≥5 轮（D11'）；8-Lead 声线终选表：每 Lead
  同一 voice ID 出中文 + 英文两条样本（D12' 中英通吃验证），wav 留档 + judge 分。
- 打断：外接脑形态下 barge-in 真机行为记录（endpoint 请求是否被中止）。
- 工具：一条最小工具通路真机走通或文档级判死（附机制说明）。
- founder 一页 go/no-go HTML 发 [FLY-980] issue thread：/eleven 三线对比表 +
  推荐 + 「哪些场景用」。
