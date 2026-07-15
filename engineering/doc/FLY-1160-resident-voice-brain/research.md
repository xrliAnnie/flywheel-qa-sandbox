# FLY-1160 常驻 Claude Session 语音大脑 — 调研

Issue: FLY-1160 (https://linear.app/geoforge3d/issue/FLY-1160/voice架构-统一常驻-claude-session-大脑-每场对话一个持久-session仅-glaw-eleven-会后纪要落地)
日期: 2026-07-10
基于: exploration.md

## 0. Verdict

**常驻机制成立，四个承重结论全部真机实测坐实**（本机 spike，evidence/
spike-resident-stream-json.mjs + spike-run-sonnet.log）。但延迟叙事必须诚实修正：
常驻的**主要收益是生命周期根治 + 防止全量历史重注入随会议时长恶化 + 会话连贯 +
纪要质量**；纯「首 token」收益有限——硬地板是模型 API TTFT（FLY-980 V4 已证），
好消息是常驻 + prompt cache 实测把 sonnet 热轮 TTFT 压进了 ~1.9s（旧基准 3.2s+）。

## 1. Spike 实测（2026-07-10 晚，load ~9.7/18 核，sonnet，语音短句 register）

命令形态（= 设计将采用的常驻形态）：

    claude -p --input-format stream-json --output-format stream-json
      --include-partial-messages --verbose --tools "" --strict-mcp-config
      --append-system-prompt <persona/voice-context> [--model sonnet]

| 验证项 | 结果 | 数据 |
|--------|------|------|
| 一进程多轮（零 per-turn spawn） | **PASS** | 同一进程连续 4 轮 + 1 中断轮 |
| 热轮 TTFT | **PASS** | turn2=1911ms, turn4=1852ms（turn1 冷=3457ms；--resume 重生首轮=3424ms） |
| 全轮耗时（一句话回复） | — | 热轮 2.8-3.1s |
| session_id 捕获 | **PASS** | 流内 top-level session_id，跨事件稳定 |
| in-band 中断 | **PASS** | 写入 control_request{subtype:"interrupt"} → control_response success → 该轮以 result subtype=error_during_execution 收束 → **进程存活**，下一轮 1852ms 正常 |
| 崩溃恢复 | **PASS** | SIGKILL 旧进程 → 新进程 +--resume <session_id> → 会话记忆完好（记得「青色」） |
| 干净退出 | **PASS** | stdin EOF → 进程自然退出 |

### 协议级发现（实现必须遵守）

1. **init 事件在首条 user 消息写入之前不会出现** —— 常驻实现不得阻塞等 init
   （spike 第一版就栽在这里，进程互相干等）。正确姿势：spawn 后立即可写首轮，
   init/session_id 在流里到了就记。
2. user 消息 wire 格式：`{"type":"user","message":{"role":"user","content":[{"type":"text","text":...}]}}`，一行一条。
3. 中断 wire 格式：`{"type":"control_request","request_id":...,"request":{"subtype":"interrupt"}}`；
   响应 `control_response`（含 still_queued，说明 CLI 有输入队列语义）。
4. **被中断的轮以 result subtype=error_during_execution 收束** —— 这是预期路径，
   不是故障，watchdog/错误分类必须白名单它。
5. `--tools "" --strict-mcp-config` / `--append-system-prompt(-file)` 在常驻模式下
   照常生效（与 HeadlessClaudeBrain 的 S0.1 冻结参数一致）；`--resume <id>` 与常驻
   模式可组合（崩溃恢复路径）。
6. text_delta 解析与现有 `parseStreamLine`（HeadlessClaudeBrain）同形 —— 解析层可复用。

## 2. 与 FLY-980 V4 先验的对账（诚实的延迟叙事）

FLY-980 V4（doc/FLY-980-elevenlabs-tts-spike/evidence/v4-brain-latency-local.md，
2026-07-07）测过**完全相同的 persistent 形态**，当时结论「常驻不改善首 token
（3294ms vs baseline 3159ms），地板 = API TTFT；CLI 冷启动只占 0.8-1.0s」。

本次 spike 热轮 1.9s 优于该基准，差异归因（不宣称跨代改善，QA 再验）：
- 常驻同进程 + 同 system prefix → **prompt cache 命中**（980 的 bench 每轮独立
  messages，缓存收益不同）；
- 会话内只发新 turn（无全量历史重注入的 token 增长）；
- 机器/时段方差。

**设计对 Annie 的承诺口径**（进 plan 验收线）：
- 结构性承诺（硬）：**任何一轮都不再付进程 spawn/teardown**；不再有「7 分钟无声
  卡死」类生命周期病（超时/崩溃 → 有界重启 + fail-loud 可见 cue）；会话连贯不靠
  每轮重注入。
- 延迟承诺（实测口径，宁保守）：脑侧热轮 TTFT 中位 **≤2.5s**（sonnet，≥5 轮），
  对照现状 /eleven 每轮 5-10s（980 矩阵 fresh 全轮中位 6.2s-10.6s + 平台侧）。
  换模型档是 founder 旋钮（980 结论:sonnet 反而比 haiku 快——haiku 每轮先吐
  thinking；opus 5-7s 不适合语音）。
- 全链（speech-end→首音）另计耳/嘴分量：/glaw = Gemini 端点判定 + 脑 TTFT +
  edge-tts 首包 ~0.66s（FLY-342 实测）；/eleven = 平台 STT/TTS ~0.7s + 隧道。
  全链验收线在 plan §QA 给出。

## 2.5 一手取证补充（Lead 转交 /glaw 修复 runner 3dcb1b94 的只读侦察，2026-07-10）

FLY-1158「冻 ~7min 自愈、零 cue」的精确根因（修正本文早先仅归因 Gemini 连接层的
说法——两者都真，这条是脑侧主凶）：

1. **HeadlessClaudeBrain 每轮 spawn 新 claude 且 timeoutMs 未传 = 无超时** →
   高负载下 hung child 无限冻。→ 本设计的单轮 watchdog **默认必须非零**
   （plan §3.1 行为 5），这不是优化是修根因。
2. 连接半途死时 mouth PassThrough/player 变僵尸，beginTurn/rotation 不重置流 →
   重连后音频写进死流 = 静音（嘴侧病，归 545 修复线）。

3dcb1b94 同时做了持久 session 可行性冒烟：一进程连续两轮，turn2 零二次冷启动
（+5.7s vs turn1 7.8s 含冷启动），用现有 ProcessRunner 抽象、无新依赖——与本
spike 互证。分工：545 先落 per-turn 超时/死亡检测的**防御版**；本 issue 的常驻
session 是彻底干掉 per-turn spawn 的**正解**。

## 3. Gemini「耳朵化」可行性（/glaw）

- FLY-545 branch 的 genaiConnector 已配 `inputAudioTranscription: {}`（user 转写
  事件已存在，HuddleSession 的 founder-utterance commit 管线整套可复用——debounce/
  aggregate 对账/路由都不用动）。
- 当前 `responseModalities: [Modality.AUDIO]`（Gemini 音频直出喂 GeminiTurnMouth）。
  Live API **必须**声明一个响应模态（不能「只转写」），故耳朵化 = 模态切
  `Modality.TEXT` + **丢弃其文本响应流** + system instruction 压到最短输出
  （省 token；即便它说话也没人听——响应流不再接嘴）。genaiConnector 需要一个模态
  配置 seam（545 exploration 本就预留「genaiConnector 需加响应模态配置(小改)」）。
- 回话链变为：Gemini 转写（VAD/端点照旧）→ founder utterance 文本 → 常驻脑 →
  文本流 → edge-tts（EdgeTts.synthesize 首包 ~0.66s）→ addressed Lead bot 嘴播。
  AddressRouter/speaking-grant/一次一嘴的既有机制全部保留，只是「line 的脑」从
  Gemini session 换成 resident brain。
- 直接结构收益：FLY-1158 P0（socket 重连成功但会话层 7 分钟不恢复）不再可能——
  Gemini 断连只影响耳朵（既有 rejoin ~5.6s + F1/F2 cue 修复管），脑与它零耦合。
- ask_lead 工具消亡（脑本来就是 Claude）；issue_status 类只读查询由脑的
  Read/Grep/Glob + 既有 Bridge Linear 只读 proxy 承接（接线细节 plan 定）。

## 4. /eleven 接入事实

- 平台每轮 POST /v1/chat/completions 带 `elevenlabs_extra_body.conversation_id`
  （shim-core.mjs:63-68 已解析，FLY-980 v10 配置 custom_llm_extra_body 已验真）——
  **daemon 回环脑口的路由键成立**。
- shim 现状：FLY980_RESUME=0 → 每轮 fresh claude -p + 全量历史重注入（7-10s/轮的
  主体）。resume 之前被弃是因为「平台不带会话 id 会串味」——实际上 conversation_id
  存在，当时弃的是 per-conversation resume 的复杂度；常驻方案按 conversation_id
  路由天然不串味。
- voice-bridge daemon 已有 127.0.0.1 HTTP health 口（cli.ts:123 createServer +
  healthPort）——回环脑口有现成宿主形态（同机 loopback + token 门）。
- /eleven 缺立项 issue + 纪要（ElevenCommand 注释原话「minus the kickoff issue」）
  —— 复用 GeminiCommand.createIssue 形态 + AssistantLanding 落地形态（收据幂等/
  失败序语义照搬）。

## 5. 会话内 context 增长（exploration Q3）

语音轮次短（一句话级）：1 小时会 ≈ 60-120 轮 × ~50-100 token ≈ 1-2 万 token +
persona/preamble——远低于上下文上限，**不需要会中 compact**。防御性上限：单会
session 生命周期硬顶（默认 3h，超时走正常 landing + fail-loud），交给 plan。

## 6. 迁移面清单（plan 的输入）

| 位置 | 现状 | 目标 |
|------|------|------|
| voice-core `brain/HeadlessClaudeBrain.ts` | per-turn spawn（--resume 续会话） | 保留不动（fallback + shim 兼容），新增 `ResidentClaudeBrain`（同 BrainAdapter 契约 + start/interrupt/dispose/health 生命周期面） |
| voice-core `types.ts` BrainAdapter | respond() only | 加可选生命周期接口（向后兼容,消费者渐进采用） |
| voice-bridge（545 分支）`huddle/wireMeeting.ts` | line 脑 = Gemini session,createBrain= ask_lead | line 脑 = resident brain（per Lead persona）;Gemini 模态 TEXT + 响应流丢弃 |
| voice-bridge（545 分支）`cli.ts summarize` | 会后 fresh claude -p + journal 注入 | host 的 resident session 终轮生成（journal snapshot 仍作 crash 兜底材料） |
| voice-bridge（1006 分支）`eleven/` + shim | shim 每轮 fresh claude -p;无 issue/纪要 | shim 薄化→daemon 回环脑口（conversation_id 路由）;ElevenCommand 补 createIssue;landing 复用 AssistantLanding 形态 |
| /gemini(-advanced) | 不动 | 组件可被 FLY-1159 委派机制将来接入（BrainAdapter 同契约） |

## 7. 风险与开放项

1. **模型档 = founder 决定**（980 Lead 指示原文）：数据支持 sonnet（快于 haiku，
   haiku 每轮先吐 thinking）；plan 以 sonnet 做默认 + config 旋钮，报告里给 Annie
   拍板。
2. 热轮 1.9s 是单次 spike（≥5 轮中位由 QA 复测）；验收线取保守 ≤2.5s。
3. 全局 settings 继承（alwaysThinkingEnabled/effortLevel xhigh）对 sonnet 语音短答
   无影响（980 已排查:sonnet 不出 thinking），但 resident 启动参数仍显式
   `--settings` 收紧以防漂移（plan 定）。
4. 多常驻进程内存驻留：每进程 idle ~百 MB 级;SessionSlot 限 1 场会 + 全局硬上限
   兜底（本机 OOM/load 事故史）。
5. 545/1006 均未合并——组件落 main 后两分支 rebase 接线（gate 已批的拆法）;
   时序协调交 Lead（545 正在修 F1/F2/F3,1006 在 QA）。
