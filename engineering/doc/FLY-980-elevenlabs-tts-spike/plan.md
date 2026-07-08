# FLY-980 /eleven 完整一条线 spike — 实施计划

Issue: FLY-980 (https://linear.app/geoforge3d/issue/FLY-980/voicespike-elevenlabs-tts-实测-真机合成-per-lead-声线-质量延迟成本-voice-core-可插拔)
日期: 2026-07-07
基于: exploration.md（r3 gate 放行版）+ research.md

## 0. 范围与不做

**做**：/eleven（ElevenLabs Agents 全栈 + Claude 脑经 Custom LLM）真机可行性
spike —— 协议打通、延迟阶梯、成本记账、中英声线、打断/工具、founder go/no-go。

**不做**：生产集成（不碰 `packages/`，D8'）；语音克隆；多 agent 编排；
Discord VC 桥接；TTS-only 组件路线（Annie 已否，报告一句带过）。

**三阶段边界**：本 plan 由 implement 阶段执行（spike 代码 + 真机 evidence +
founder 报告）；QA 阶段独立复验关键命题（QA 不得复用 implement 的会话记录，
须至少重跑 V2/V4 各 2 轮 + 核对记账）。

## 1. 交付物

| 类型 | 路径 |
|------|------|
| spike 代码 | `engineering/spike/FLY-980-eleven/`（standalone npm 包，`type: module`，模式同 FLY-968 spike；**过全仓 biome lint** —— FLY-977 教训） |
| evidence | `engineering/doc/FLY-980-elevenlabs-tts-spike/evidence/*.md`（每命题一文件，含复现命令 + 取证日期） |
| 音频留档 | `~/fly980-eleven/`（全量 wav/mp3，本地，Annie 终审用 —— FLY-546 audition 同款；**QA 验收前不得删**）；evidence 只记文件清单 + sha256 |
| founder 报告 | 一页 HTML，publish-report 到 [FLY-980] issue thread（终选样本 data-URI 内嵌试听；托管 CSP 拒 media data-URI 则退回「报告 + 本地文件夹指引」） |
| 对比表 | bakeoff 三线表（/glaw、/gemini、/eleven）进 evidence + founder 报告 |

## 2. 命题表（verdict 索引，evidence 逐条对应）

| # | 命题 | 判据 |
|---|------|------|
| V1 | shim 合同：OpenAI chat.completions SSE 本地合同测试全绿 | 流式 chunk + [DONE]、tools 数组容错、Bearer 401、client abort 清理（子进程 kill）4 组用例 |
| V2 | echo 脑 E2E：真机握手 + 平台/隧道基线延迟 | agent(custom-llm) 真机对话 ≥5 轮，speech-end→首音中位数落表 |
| V3 | Anthropic API 脑延迟（haiku + sonnet 两档） | 各 ≥5 轮中位数；= 纯思考延迟下界参照（非生产选择，D10'） |
| V4 | **claude -p 脑延迟（主命题）**：haiku/sonnet × resume/全量注入 × 空 cwd | 各组合 ≥5 轮；shim 侧「请求到达→首 text_delta」+ 全链 speech-end→首音双口径；Opus 1-2 轮铁证；判据带 ≤1.2s 优 / ≤2s 可用 / >3s 难用 |
| V5a | turn-taking 端点行为：turn_timeout 只管「用户静默后多久接话」 | turn_timeout 7s vs 15s 对照，确认其语义边界（非慢脑等待控制） |
| V5b | **慢脑行为（go/no-go 关键）**：平台等慢 LLM 的机制 = Soft timeout（垫话继续等） | 人为 8s+ 延迟注入 × soft timeout 开/关对照，记录垫话/挂断/静默行为 + 用户体感链路 |
| V6 | 打断：barge-in 时 in-flight 请求行为 | 答中打断 ≥3 次：平台是否 abort HTTP、shim 是否正确杀子进程、后续轮次是否正常 |
| V7 | 工具通路：(a) language_detection function call 真机走通（或文档级判死）；(b) shim 内消化演示（mock issue_status 数据注入→口头回答） | (a) 一次完整 tool call 往返 event 链；(b) 一轮问答含注入事实 |
| V8 | 单 agent + per-session override 承载多 Lead | 同一 agent 两次会话分别用两个 Lead 的 voice_id + persona override，声线/自称均切换；Security 启用位 API 可设性一并记录（R3） |
| V9 | 8-Lead 声线：中英一把声线 audition + 终选 | 每 Lead ≥2 候选 × zh+en 双语样句；s4b judge（可懂度 0-2/可区分度 0-3）初筛；终选 8 声线各留 zh+en 双样本 wav（D12'）；与 edge-tts 基线（FLY-546 表）同句对照 |
| V10 | 成本记账 | 每步 subscription usage 前后差（分钟池 + credits 池分列）；$/min 订阅内（275min 池）/超池（$0.08）两条线；脑侧订阅 $0 边际注记 |

## 3. 步骤

### S0 预检 + key 协调（半天内）

1. `flywheel-comm stage set implement`；建 `engineering/spike/FLY-980-eleven/`
   （package.json 同 FLY-968 模式：private、type module、依赖 ws +
   `@anthropic-ai/sdk`（仅 V3 参照档用））。
2. **key**：检查 `~/.flywheel/.env` 有无 ELEVENLABS_API_KEY；无则
   `flywheel-comm ask` 请 Lead 协调 Annie 放入（0600、不进 argv/Discord），
   **不阻塞**：S1-S2 本地无 key 可做，key 到位再进 S3。
3. **必做**（fresh checkout 缺的资产，Codex R1#4）：
   - `pnpm --filter flywheel-voice-core build` —— `packages/voice-core/dist/`
     当前**不存在**，shim 相对路径 import
     `../../../packages/voice-core/dist/index.js` 之前必须先 build；
   - `engineering/spike/FLY-968-voice-bakeoff/ref/*.pcm` 被 gitignore ——
     跑 `gen-ref-audio.sh` 重新生成 u1/u2，并同法新增英文语料
     u3-en（合成或录制，16k s16le PCM）；
   - 8-Lead persona 表**已内联本 plan §S7**（来源 = PR #496 未合并的
     `scripts/voice-audition-fly546.mjs`，fresh checkout 无此文件，不得引用）。
4. 预检 cloudflared 在机（`brew install cloudflared` 备用）。

### S1 shim（TDD，先合同测试后实现）

`shim.mjs`：node http 服务，`POST /v1/chat/completions`。

- 鉴权：启动时生成随机 Bearer token（stdout 打印一次，不落盘）；校验失败 401。
- 请求解析：`{messages, model, stream, tools, elevenlabs_extra_body}`；
  messages 原文全量落 jsonl（V2 时取证平台注入的 system prompt，R7）。
- **OpenAI messages → BrainAdapter 适配器（确定性规格，Codex R1#1）**：
  - `messages` 最后一条 user = `turn.text`；其余 user/assistant 按序映射
    `Turn[]` history；system 消息**不进 history**，单独处理（下条）；
  - **persona 通路（V8 的成败点）**：平台把（可被 override 的）system prompt
    随 messages 下发 —— shim 为每个会话把收到的 system 消息写入
    per-conversation 临时 identity 文件，作为该会话 brain 实例的
    `identityFile` —— 这使 per-session persona override 端到端真实生效，
    而不是被固定 identityFile 吞掉；
  - **会话隔离**：brain 实例按会话键分桶（键优先取请求可辨识字段 ——
    `user_id` / `elevenlabs_extra_body` 内的会话 id，echo 档 R7 取证确认
    实际有什么字段；都没有则 spike 明确「单活跃会话」假设并落 evidence）——
    **禁止单例 resume session 跨 ElevenLabs 会话串味**；
  - `FLY980_RESUME=0` = 每轮 fresh 实例 + `useResume:false`（全量历史再注入
    是真实条件）；`=1` = per-conversation 实例持 session_id。
- 脑选择 env `FLY980_BRAIN=echo|api|claude`：
  - echo：固定短句立即流出（两语言版本）；
  - api：`@anthropic-ai/sdk` messages streaming，system=同上 persona 通路，
    model 由 `FLY980_MODEL` 定（haiku/sonnet）；
  - claude：`HeadlessClaudeBrain`（voice-core dist import），
    `claudeBin=claude`、identityFile=per-conversation persona（同上）、
    `extraArgs=["--model", $FLY980_MODEL]`；
  - **cwd = 空目录**（`~/fly980-eleven/cwd-empty/`）：
    `HeadlessClaudeBrainOptions` **没有 cwd 参数**（Codex R1#2）——
    经 `runner` 注入 spike 侧 `ProcessRunner` 包装（转发
    `spawn(cmd, args, {cwd: emptyDir})`，`process.ts` 的 spawn 本就支持
    cwd 选项），不改 voice-core（守 D8'）；空 cwd 生效与否作为 V4
    evidence 独立一行验证（claude -p 输出的 cache token 量佐证）。
- 响应：brain 的 AsyncIterable<string> → OpenAI SSE chunk（role 首帧 +
  content delta + finish_reason + [DONE]）；tools 数组存在且模型需调用时
  按 OpenAI function call 格式回（V7a 用）。
- 打点：`t_req_arrival / t_first_delta / t_done / aborted` 全落 jsonl。
- 中断：req close/abort → AbortController → brain 子进程 kill（V1/V6 判据）。

`shim.test.mjs`（node --test，无外部依赖）：V1 的 4 组用例 + adapter 层用例
（Codex R2 建议，烧配额前拦住最可能的实现滑跤）：messages→Turn[] 映射、
system 消息落 per-conversation identity 文件、两个会话键不共享 resume brain、
`FLY980_RESUME=0` 每轮 fresh 实例、cwd 包装器转发 {cwd}。**先写测试
（RED）→ 实现（GREEN）**；spike 不进 CI，但本地必须全绿 + 全仓 `pnpm lint` 过。

### S2 本地合同验证（无 ElevenLabs）

curl 回放三类请求（纯文本 / 带 tools / 中途断开），V1 verdict 落
`evidence/v1-shim-contract.md`。

### S3 隧道 + agent 建立（fail-closed 验证，Codex R1#6）

- `cloudflared tunnel --url http://localhost:<port>` 拿随机公网 URL。
- `create-agent.mjs` **建最小 agent → 立即 GET 回读 → 脱敏 config 快照落
  evidence**（public API reference 只把 conversation_config 暴露为 object，
  `custom_llm.request_headers` 嵌套形状未见公开文档 —— 以 GET 回读的实际
  接受形状为准，不以文档猜测为准）：
  - 首选 `custom_llm={url, request_headers:{Authorization: Bearer <token>}}`；
    被拒则退 `api_key`（workspace secret）配置；再不行 dashboard 手工一次，
    **实际可用形状逐字记进 evidence/runbook**；
  - 其余配置：`prompt.llm="custom-llm"`、`agent.language="zh"` +
    additional languages en、`tts.model_id="eleven_flash_v2_5"`、
    `tts.voice_id` 先用默认、`turn.turn_model="turn_v3"`、
    `turn.turn_timeout=7`、soft timeout 特性位（V5b 用，API 字段以 GET
    回读确认）。
- override Security 启用位尝试 API 设置（agent PATCH / platform_settings），
  设不了则 dashboard 手工一次并记 runbook（R3）；**未确认启用前 V8 不开跑**
  （fail-closed）。
- 配 `delete-agent.mjs` 清理脚本；agent id 落 evidence，用后即删（V10 记账后）。

### S4 E2E 延迟阶梯（V2→V5，s5 骨架改造）

`e2e-session.mjs`（s5-elevenlabs-agent.mjs 改造）：get-signed-url → WS →
起始帧（可带 conversation_config_override）→ 喂 u1/u2 PCM + 新录/合成英文
语料 → 打点 speech-end→首 audio event。

轮次矩阵（每格 ≥5 轮，Opus 格 1-2 轮）：

| 档 | 变量 |
|----|------|
| echo | —（平台+隧道基线） |
| api | haiku / sonnet |
| claude -p | haiku / sonnet × resume / 全量注入；Opus×resume 1-2 轮 |

V5a：turn_timeout 7s vs 15s 对照，取证其「用户静默端点」语义（**它不管慢
LLM**——Codex R1#3 纠正）。V5b（go/no-go 关键）：claude 档天然慢样本 +
人为 sleep 注入，**Soft timeout 开/关对照** —— 平台等慢 LLM 的官方机制是
soft timeout 垫话（conversation-flow 文档），记录垫话/挂断/静默 + 体感链路。
evidence：`v2-v5-latency-ladder.md`（中位数表 + 分解归因：平台基线 /
脑首 token / 差值）。

### S5 打断 + 工具（V6/V7）

- V6：长答案 prompt + 答中喂打断语音 ≥3 次；shim jsonl 的 aborted 记录 +
  平台 event 链落 `evidence/v6-interruption.md`。
- V7a：agent 加 language_detection 系统工具，中途换语言说话，验 shim 收到
  tools 数组 + 回 function call + 平台执行切换；V7b：shim 内 mock
  issue_status 注入。落 `evidence/v7-tools.md`。

### S6 override 多 Lead（V8）

同一 agent 两次会话：Tadashi（男声终选 + Tadashi persona）vs Cass
（女声终选 + Cass persona），录音 + 转写证声线/自称切换。落
`evidence/v8-override-multilead.md`。

### S7 声线 audition（V9，可与 S4 并行）

`audition.mjs`：TTS API 合成（独立于 agent 会话，credits 计费）——

**8-Lead persona 表（需求输入，内联自 PR #496 提案 —— 该 PR 未合并，
fresh checkout 无源文件；edge-tts 列 = 对照基线）**：

| Lead | persona 要求 | edge-tts 基线 |
|------|--------------|---------------|
| Tadashi (Eng Lead) | 男声，Professional，工程口吻 | zh-CN-YunyangNeural |
| Aunt Cass (CoS) | 女声，Warm，总管温和 | zh-CN-XiaoxiaoNeural |
| Honey Lemon (Product) | 女声，Lively，产品共创活泼 | zh-CN-XiaoyiNeural |
| Mufasa (growth 陪练) | 男声，沉稳导师 | zh-CN-YunjianNeural rate -10% |
| Belle (生活助理) | 女声，Bright，辨识度高 | zh-CN-shaanxi-XiaoniNeural |
| Peter (GeoForge3D product) | 男声，Sunshine | zh-CN-YunxiNeural |
| Hiro (Joy-Con) | 男声，年轻感 | zh-CN-YunxiaNeural |
| Simba (GeoForge3D cos) | wildcard，不报身份也能听辨 | zh-CN-liaoning-XiaobeiNeural |

- 声线来源：GET /v2/voices（premade 优先）+ shared library 搜索补缺
  （加库占 My Voices slot，Creator 30 上限，节制使用）；按上表选每 Lead
  ≥2 候选（multilingual 系声线优先，D12'）。
- 样句三组（zh 句 **逐字沿用 s4b 的句子**保跨厂商可比；en / 中英混各一句，
  全 Lead 统一）；模型：候选筛选用 flash_v2_5（0.5 credit/字符），终选双语
  长样句加 multilingual_v2（1 credit/字符）高质量档。
- **judge 层新写参数化版本（Codex R1#5）**：s4b 只是方法学先例（单句硬编码 +
  全局 top-3，不可即插）——`audition.mjs` 内置 judge 接受 {leadId, voiceId,
  language, expectedSentence} 逐样本打分（可懂度 0-2 / 可区分度 0-3），
  输出 per-Lead 排名与终选建议。
- 终选表（8 Lead × voice_id × zh/en 双样本）→ 全量 wav 落
  `~/fly980-eleven/audition/`；judge 分 + 终选理由落
  `evidence/v9-voices.md`；**终审权在 Annie**（报告里明说是建议非定稿）。

### S8 记账 + 对比表 + founder 报告（V10）

- 每步前后 GET /v1/user/subscription 快照（分钟池 + credits 池）落
  `evidence/v10-cost.md`；$/min 两条线换算。
- bakeoff 三线表（/glaw、/gemini、/eleven）：延迟（口径注明）/成本（订阅内+
  超池）/声线数/中文/中英混/打断/工具/工程量 —— /glaw、/gemini 列引用
  FLY-968 数据。
- founder 一页 HTML（中文、Apple-style light、mobile-first）：go/no-go 推荐 +
  三线表 + 终选声线试听（data-URI mp3；CSP 拒则指引本地文件夹）+
  「哪些场景用」。publish-report 到 [FLY-980] thread（**发 thread 不发
  core room**）。
- 清理：删 spike agent、撤隧道；报 Lead（DONE 报告走 flywheel-comm ask）。

## 4. 测试与验收策略

- shim = spike 里唯一有单测的组件（V1 合同测试，node --test 本地跑）；
  其余命题以真机 evidence 为验收 —— 每条 evidence 附完整复现命令。
- 全仓 `pnpm lint`（biome 覆盖 spike .mjs，FLY-977 教训）+
  `pnpm --filter flywheel-voice-core test`（确认 import 未破坏 dist 契约，
  应零改动零红）。
- QA 阶段（独立会话）：重跑 V2/V4 各 ≥2 轮核延迟量级、核 V10 记账、
  听抽 V9 样本、验 founder 报告链接在 thread 可开。

## 5. 风险与回退

research.md §10 R1-R7 全承接。最坏情形预案：

- **R1 兑现（claude -p 全配方 >3s）**：报告如实给「难用带」结论 +
  API 脑档数据作「如果换 API 形态能到多少」的参照 —— go/no-go 交 Annie
  （订阅 vs 延迟的取舍是产品决策，不是工程决策）。
- **Custom LLM 在 Creator 层被拒**（research 未见此限制但未证伪）：
  文档级判死记录 + 报告如实呈现，spike 提前收束。
- **中英混 TTS 质量差（R5）**：per-Lead 双声线（zh 主 en 辅）作 fallback
  方案写进报告（违背 D12' 一把声线理想，如实呈现给 Annie 拍）。

## 6. PR 形态与版本

- 本 issue 为 spike/eval：**不 bump doc/VERSION**（先例：FLY-968 #494、
  FLY-960 #489 均无版本号）。
- PR = 设计三件套 + spike 代码 + evidence + founder 报告发布记录，
  commit 前缀 `spike(FLY-980):`。
- 后续：若 Annie 拍 GO，生产化（voice-core elevenlabs backend /
  /eleven 编排 / Discord 桥）另开 issue（本 issue 边界）。
