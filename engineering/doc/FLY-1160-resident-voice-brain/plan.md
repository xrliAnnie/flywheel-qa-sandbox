# FLY-1160 常驻 Claude Session 语音大脑 — 实施计划

Issue: FLY-1160 (https://linear.app/geoforge3d/issue/FLY-1160/voice架构-统一常驻-claude-session-大脑-每场对话一个持久-session仅-glaw-eleven-会后纪要落地)
日期: 2026-07-10
基于: research.md（Codex design review R1 全 8 项 + R2 全 4 项 + R3 全 2 项已并入,r4）

## 0. 一句话

每场语音对话起**一个常驻 claude 子进程**（`--input-format stream-json` 持久模式，
spike 已全项 PASS），/glaw 与 /eleven 的每轮思考和会后纪要都走它；组件落 main，
两个消费者的接线落各自未合并分支（brainstorm gate 已批的拆法）。

## 1. Scope（gate 已确认）

- **In**: voice-core 常驻脑组件 + 生命周期 manager + daemon 回环脑口（默认关）；
  /glaw（FLY-545 分支）与 /eleven（FLY-1006 分支）的接线规格与补丁；/eleven 补
  立项 issue + 纪要落地；真机 QA。
- **Out**: /gemini 与 /gemini-advanced（Lead 明确：它俩背后**没有 Claude 对话脑**
  ——/gemini 纯 Gemini Live；/gemini-advanced 是 Gemini 对话脑 + 深活异步委派，
  **不需要**持久对话 session。组件仍是通用 BrainAdapter 实现，但不预设它们接入）；
  /glaw 的 F1/F2/F3 体验缺陷（归 FLY-545）；语音安全边界变更（只读白名单不动）。

## 2. 目标架构

```mermaid
graph TB
    subgraph "voice-bridge daemon(脑的唯一 owner)"
        M[ResidentBrainManager<br/>key → session,全局硬上限,收尸]
        P[BrainPort 127.0.0.1<br/>token 门,默认 OFF]
        G[/glaw wiring<br/>545 分支/]
        E[/eleven wiring<br/>1006 分支/]
    end
    subgraph "voice-core(组件,本 PR 落 main)"
        R1[ResidentClaudeBrain<br/>1 场会×1 Lead persona = 1 进程]
    end
    SHIM[eleven shim<br/>薄化:按 conversation_id 转发] -->|loopback HTTP| P
    P --> M
    G --> M
    E --> M
    M --> R1
    R1 -->|claude -p --input-format stream-json<br/>只读白名单(不可覆盖)| CLI[(claude CLI 子进程)]
```

回话链（目标）：
- /glaw：Gemini Live 保持 **AUDIO 模态**（真机证据 s1-gemini-text-modality.md:
  当前全部 Live 模型服务端拒绝 TEXT——TEXT 路线物理不存在;genai-config.test 的
  AUDIO 回归钉死不动）+ `inputAudioTranscription` 照旧。**Gemini 的 response
  audio 与 output transcript 全部丢弃,永不进嘴**;system instruction 压到最短
  回复以降低被丢弃的生成成本。founder utterance 文本（既有 commit 管线不动）→
  resident brain → 文本流 → 句级 edge-tts → addressed Lead bot 嘴。
  AddressRouter/speaking-grant/一次一嘴保留。
- /eleven：平台 STT → shim（薄）→ BrainPort（conversation_id 路由）→ resident
  brain → 文本流 → shim SSE → 平台 TTS。

## 3. 组件规格（Phase A，本分支 → main）

### 3.0 共享流解析（先行，回归哨兵）

`parseStreamLine` 从 HeadlessClaudeBrain 抽出为共享模块，且**结果携带事件种类**：
`{ kind: "delta" | "assistant-final" | "result" | "control" | "system" | "other",
text?, sessionId?, resultSubtype? }`。真机已证（FLY-1006 shim S2 轮 C，
dedupeFinalEcho 注释原文）：stream-json 同时发 partial text_delta **和** 最终完整
assistant message——两个都 yield 会让 TTS 把全文再说一遍。Resident 的轮内产出规则：
**只 yield delta；该轮无任何 delta 时（例如 partial 事件缺失）才 yield
assistant-final 的文本**。HeadlessClaudeBrain 改用共享模块后既有测试**字节不变**
通过（回归哨兵）。

### 3.1 voice-core: `ResidentClaudeBrain`（新文件 `src/brain/ResidentClaudeBrain.ts`）

实现既有 `BrainAdapter`（respond 签名不变）+ 生命周期面。**安全 flags 是内部常量，
不可被调用方覆盖**（Codex R1 #7）：

```ts
// 内部常量,不出现在 options 里:
//   -p --input-format stream-json --output-format stream-json
//   --include-partial-messages --verbose
//   --tools "Read,Grep,Glob" --strict-mcp-config
//   --settings '{"alwaysThinkingEnabled":false}'   // 防全局 settings 漂移
export interface ResidentBrainOptions {
  claudeBin: string;
  identityFile: string;            // persona(--append-system-prompt-file)
  voiceContext?: string;           // 语音 register,走 stdin 首轮注入,不走 argv
  sessionPreamble?: string;        // 会议上下文(issue/参会人),同上
  readOnlyRoot?: string;           // cwd(锚只读工具)
  model?: string;                  // allowlist 化的 typed 选项(仅 model/effort)
  effort?: "low" | "medium" | "high";
  turnTimeoutMs?: number;          // 默认 60_000;构造期强制 >0(FLY-1158 根因①)
  interruptGraceMs?: number;       // interrupt→terminal result 等待,默认 3_000
  eofGraceMs?: number;             // dispose: closeStdin(EOF)→自然退出等待,默认 2_000
  termGraceMs?: number;            // dispose: SIGTERM→SIGKILL 等待,默认 2_000
  maxLifetimeMs?: number;          // 默认 3h;到点只发事件,不由 core 收尾
  maxRespawns?: number;            // 默认 2 次/5min 滑窗
  runner?: ProcessRunner;          // 测试 seam
  onEvent?(e: ResidentBrainEvent): void;  // 状态/lifetime-expiry/respawn 事件
}
export type ResidentBrainEvent =
  | { type: "state"; state: "starting"|"idle"|"thinking"|"recovering"|"failed"|"closed"; detail?: string }
  | { type: "lifetime-expiry" }            // 消费者决定 degraded landing
  | { type: "respawned"; attempt: number }
  | { type: "context-drained"; upToSeq: number };  // 见 appendContext ack 合同

export class ResidentClaudeBrain implements BrainAdapter {
  respond(turn, {signal}): AsyncIterable<string>;
  appendContext(text: string): { accepted: boolean; seq?: number };
                                       // R1 #4 + R2 #2 + R3 #2:静默上下文,只缓存;
                                       // 下一次 respond 时作为标记 context 块与
                                       // founder turn 一起送入(绝不单独触发回答)。
                                       // 缓存有界(默认 256KB):满则 accepted:false
                                       // ——调用方(FeedPipeline 适配层)据此 HOLD
                                       // cursor 不前移,事实绝不静默丢。
                                       // **ack 点 = 该轮正常 terminal result**,
                                       // 不是 stdin drain(drain 只证 bytes 交给
                                       // 子进程,不证 session 已持久):随轮送入的
                                       // context 保留为该轮 unacked snapshot,
                                       // 正常 result 才清除并发 context-drained
                                       // {upToSeq};interrupted/error/crash/timeout
                                       // 一律保留、下一真实轮**重注入**(条目带
                                       // 稳定 seq,重注入以 seq 标记去重——宁可
                                       // 显式重复,不可静默丢)。
  interrupt(): Promise<void>;          // barrier:resolve 于该轮 terminal result
  dispose(): Promise<void>;            // closeStdin(EOF)→eofGraceMs 等自然退出
                                       // →SIGTERM→termGraceMs→SIGKILL→awaitExit
                                       // (顺序与预算逐字实现,fake-timer 哨兵)
  health(): { state; pid?; turns: number; sessionId? };
}
```

**轮状态机（显式合同，Codex R1 #3）**：

- 每轮唯一 turnId。**一次只允许一轮 in-flight**：新 `respond()` 在旧轮 terminal
  result（含被中断轮）前 await——绝不并发写两条 user 消息（CLI 的输入队列语义不作
  依赖）。
- `interrupt()` 写 control_request 后**等待该轮 terminal result 才 resolve**
  （interruptGraceMs 内不 resolve → kill+respawn 路径）。被中断轮以
  `result subtype=error_during_execution` 收束（spike 实证），白名单为正常收束。
- **watchdog**：turnTimeoutMs 超时 → interrupt()（cue 由消费者渲染）→
  interruptGraceMs 仍无 terminal → kill → respawn。turnTimeoutMs 构造期强制非零
  （FLY-1158 根因① = timeoutMs 未传 = hung child 无限冻）。
- **crash 语义（不自动重放）**：子进程意外 exit：
  - 轮外 → 后台 respawn（有 sessionId 用 `--resume`；**无 sessionId（首轮就崩）→
    fresh 进程 + persona/preamble/appendContext 缓存重注入**——HeadlessClaudeBrain
    的历史重注入 fallback 同型）。
  - 轮中 → 该轮 respond() **抛 VoiceError("subprocess-failed")**，消费者收
    `state=recovering`（TIV「脑重连中」+ mouth flush 由消费者做）；respawn 完成后
    消费者决定是否请 founder 重说（545 已有「请再说一遍」形态）。**不盲目 replay**
    ——半句已播的轮重放会双播（Codex R1 #3 判定采纳）。
  - 滑窗内超 maxRespawns → `state=failed` fail-loud，**绝不无声**。
- `maxLifetimeMs` 到点只发 `lifetime-expiry` 事件——landing 归 orchestrator
  （voice-core 不拥有 landing）。
- `dispose()` 与 in-flight 轮：dispose 优先，先 interrupt-barrier 再关（有界）。
- AbortSignal（respond opts）→ 等价 interrupt()（进程存活；区别于
  HeadlessClaudeBrain 的 SIGKILL——那是 per-turn 形态的正确语义）。
- spawn 后**不等 init**（spike 协议发现:首条 user 消息前无 init 事件）。

### 3.1b process seam 扩展（Codex R1 #2）

`ProcessRunner/ProcessHandle`（voice-core src/process.ts）现只有
write/onStdout/onExit/kill——one-shot 够用，常驻不够。**加性扩展**（既有调用面
字节不变）：`onError(cb)`（spawn ENOENT/stdin EPIPE）、`write` 返回背压布尔 +
`onDrain`、`closeStdin()`、`awaitExit(timeoutMs)`。fakes.ts 同步升级。

**背压/wedge 判定三分开（Codex R2 #2——`write(false)` 是正常 highWaterMark 背压，
不是 child 卡死）**：
- 单条 wire payload：大 frame **分块写**，`write(false)` 后等 `onDrain` 再续——
  payload 自身大小**永不**触发 kill。
- Writable 内部 buffer：交给 Node 背压语义，等 drain。
- 应用层待写队列：只统计 **drain 等待期间又到达、尚未交给 Writable** 的后续数据；
  该队列上限（默认 64KB）超限才视为 wedged → kill+respawn。
测试：>64KB 单条 context+turn frame 正常分块写完、无 respawn；drain 停滞 + 新数据
堆积超限才触发 respawn。

### 3.2 voice-core: `ResidentBrainManager`（新文件 `src/brain/ResidentBrainManager.ts`）

```ts
open(key, opts): ResidentClaudeBrain   // 幂等:同 key 返回既有
get(key) / close(key) / closeAll() / stats()
forceKillAll(): void                   // 同步 SIGKILL 全部登记 PID(shutdown 硬计时器路径)
```

- key 约定：`<issueIdentifier>:<leadId>`（/glaw per-line）/ `eleven:<conversation_id>`。
- **全局硬上限**（默认 4）：超限 open 抛 **`VoiceError("resource-exhausted")`**
  （VoiceErrorCode 加一枚新码——"unsupported" 语义是 backend 能力缺失，不混用；
  加码是 additive，既有 switch 不受影响）。fail-loud 不排队。
- **收尸铁律**：every open 登记 PID；close/closeAll 确认进程退出（awaitExit +
  SIGKILL 兜底）；FLY-1148 教训：谁 spawn 谁收尸，且只有 daemon spawn。

### 3.3 voice-bridge: `BrainPort`（新文件 `src/brain/BrainPort.ts`，默认 OFF）

**安全合同（Codex R1 #5）**：

- 配置：projects.json 只存 `huddle.brain.port`（数字）。token env 名**硬钉为
  `FLYWHEEL_BRAIN_PORT_TOKEN`**（Codex R2 #4b:可配 tokenEnv 会让 daemon 与 shim
  两端读到不同 secret——不留这个自由度）。port 配置存在 + env 有值才监听，否则
  **服务器不启动**（byte-compat）。secret 值绝不进 URL/query/argv/日志/
  projects.json。
- 监听：仅 `127.0.0.1` bind。**所有** `/brain/*` 端点（含 health）Bearer 鉴权，
  constant-time 比较。
- 端点：`POST /brain/turn` {key,text} → chunked text 流；`POST /brain/interrupt`
  {key}；`GET /brain/health`（只回 `{ok,active:<数字>}`——**不回 keys/issue**）。
- 校验与错误映射：key 字符集白名单 `[A-Za-z0-9:_-]{1,128}`；text ≤ 16KB(413)；
  Content-Type application/json(415)；body read timeout 5s(408)；未绑定 key
  404；同 key 已有 in-flight 轮 → 新 turn **supersede**：先走 interrupt barrier
  再开新轮（语音 barge-in 语义）,barrier 失败 503；未授权 401。
- **client disconnect = interrupt**：turn 响应流的 socket 断开 → 对该轮
  interrupt()（平台 abort in-flight 请求是已知行为，FLY-1006 research）。
- **装配（cli.ts 任务，Phase A 内完成）**：daemon 启动序 = 构造 singleton
  ResidentBrainManager →（配置齐备时）起 BrainPort → Discord 装配；Discord 装配
  失败的回滚路径关 BrainPort + manager.closeAll()。/brain 绑定/解绑不走 port——
  只有 daemon 内部 wiring 能 open/close（shim 拿不到 spawn 权）。
- **两阶段 shutdown 合同（Codex R2 #1——现有 cli.ts 是 10s Promise.race + 12s
  硬退,race 超时不取消内部 promise,可能在 child 未收尸/receipt 未写完时
  process.exit）**：
  1. **Phase 1（立即）**：停止接新请求/新 turn（BrainPort 拒 503、命令下架）、
     消费者停嘴、冻结 journal。
  2. **Phase 2（landing，独立有界预算，默认 8s）**：active meeting 的 artifact
     landing 只能用这个预算。**deadline 是真取消，不是停止等待（Codex R3 #1——
     Promise.race 留下的 slow-success 会在 Phase 3 后继续写 Linear/receipt）**：
     - 预算携带 AbortController + finalizing generation token；resident 终轮与
       Linear client 的 fetch 都接 signal（LandingLinear 合同扩展:接受
       AbortSignal;545 的 BridgeLinearClient 现无 timeout/signal——接线 PR 补）。
     - AssistantLanding 形态在**每个 await/每次外部写前后**检查 deadline;
       aborted 后绝不再发下一步、不写 success receipt、不渲染成功 TIV。
     - deadline 路径只**原子写 durable pending state**，不再二次尝试 Linear。
       **pending schema = stage-aware continuation（Codex R4 #1——landing 是
       summary comment → N 个 transcript comment → close 三类独立 mutation，
       unknown 的判定各不相同），且必须是 restart-self-contained 的版本化
       envelope（Codex R5 #1——成功 receipt 里的 issueId 恰在「服务端已提交、
       client 超时/重启」窗口里还没写出,pending 自己必须带全恢复所需）**：
       `{version, issueId, sessionId, outcome: "not_started"|
       "mutation_outcome_unknown", stage}` + stage 判别联合
       `summary:{marker} | transcript:{chunkIndex, marker} | close:{closeTarget}`
       （无 closeTarget 的 close/无 chunkIndex 的 transcript 不是合法状态；daemon
       将来多项目则再带 project binding）。startup 对未知 version/缺字段：
       **保留 pending + fail-loud，绝不发 Linear mutation**。
       reconciliation 对 unknown 的判定：summary/每个 transcript chunk 用各自
       **确定性 marker**（既有 comment 体内「assistant-summary <sessionId>」/
       「assistant-transcript <sessionId> chunk i/n」标记行,list 该 issue
       comments 分页查到命中或 EOF）；close 用 issue 当前 status 读回判定。
       确认已落 → 跳过续下一 stage;未落 → 续发。**不盲重试**。
     - **读口是新能力（当前 Bridge 链路没有）**：scoped Bearer-auth 的
       comments-list（分页）+ issue-status read 加入 545/1006 接线 PR 的
       Bridge route + BridgeLinearClient/LandingLinear 合同与测试;所有 fetch
       接 AbortSignal。
     - 测试:comment 在 deadline 后才 resolve → 不得 late-success/close;
       summary/transcript chunk/close 三类「服务端已提交但 client 超时/重启」
       → reconciliation 均不重复 mutation 且正确完成 receipt/TIV;
       **真 cold-start**:清内存 Session、无 summary receipt,scanner 只凭
       pending envelope + journal/config 定位正确 issue、查 marker、续后续
       stages 且不重复 summary。
  3. **Phase 3（不可跳过的 finally）**：并行 `manager.closeAll()`，每个 PID
     确认 exit 后 runtime.close 才 resolve。
  4. **外层硬计时器**触发时：先调用同步可达的 `manager.forceKillAll()`
     （SIGKILL 全部登记 PID）再 `process.exit(1)`——绝不带着活 child 退出。
  Phase A 交付 manager 的 closeAll/forceKillAll + cli.ts（main 上的 /gemini 链）
  挂接；545/1006 在接线 PR 里把各自 finalizer 挂进同一合同。fake-timer 测试：
  summary 永挂/Linear 永挂/4 child 同时退——deadline 后所有 PID 已退且未完成
  landing 不报成功。

### 3.4 测试（Phase A，TDD）

- 共享 parser：kind 标注/delta-only 产出/无 delta 时 final fallback/**final-echo
  不双播**（真机事件序列重放:init→delta×N→assistant-final→result）；
  HeadlessClaudeBrain 既有测试字节不变（回归哨兵）。
- ResidentClaudeBrain（fake ProcessRunner）：多轮串行/新轮等旧轮 barrier/中断
  白名单/interrupt-barrier 超时→kill/watchdog 强制非零/轮外崩溃 --resume 重生/
  首轮崩溃 fresh+重注入/轮中崩溃抛错+recovering 事件+不重放/respawn 限流→failed/
  lifetime-expiry 只发事件/dispose 优先级 + **EOF→eofGrace→TERM→termGrace→KILL
  顺序 fake-timer 哨兵**/appendContext 有界缓存(accepted:false 满)+**ack=正常
  terminal result 才发 context-drained{upToSeq}**+interrupt/crash/timeout 保留
  重注入(seq 去重标记)/frame 已 drain→SIGKILL→下一轮携带同 context→正常 result
  后才清/**>64KB 单条 frame 分块写不触发 respawn**/AbortSignal→interrupt。
- process seam：ENOENT/EPIPE/write 背压+onDrain/write-after-exit/分片 JSON/无尾
  换行/stderr 上限/awaitExit 超时（既有 one-shot 用例字节不变）。
- Manager：幂等 open/上限 resource-exhausted/closeAll 收尸(每 PID exit 确认)/
  forceKillAll 同步可达/PID 登记。
- 两阶段 shutdown（fake-timer）：summary 永挂/Linear 永挂/多 child 同时退——
  deadline 后所有 PID 已退，未完成 landing 不报成功。
- 公共导出：package-root import 新组件编译通过（Codex R2 #4c 哨兵）。
- BrainPort（vitest 真 http loopback）：未配置不监听（byte-compat 哨兵:health
  JSON/监听端口集/argv 全比对）/401/404/413/415/408/supersede-interrupt/
  disconnect-interrupt/health 不泄 key/token constant-time。
- 真 CLI 冒烟（`RESIDENT_SPIKE=1` 门）：既有 spike 断言化 + **轮中 SIGKILL**
  场景（补 spike:mid-turn crash → respond 抛错 → --resume 后记忆仍在）。

## 4. 接线规格（Phase B/C，落各自分支；本 plan 是它们的合同）

### 4.1 /glaw（FLY-545 分支）

1. `wireMeeting.ts`：`ports.createBrain` 改出 resident brain（manager.open，
   key=`<issue>:<leadId>`，persona=该 Lead identity.md，readOnlyRoot=projectRoot），
   在 GlawCommand 立项成功后、assembling 窗口内 open（首轮即热）。
2. Gemini line：**AUDIO 模态不动**（见 §2;TEXT 已被真机否定）+
   `inputAudioTranscription` 照旧；response audio / output transcript **丢弃**
   （不再接 GeminiTurnMouth）；system instruction 压到最短回复。新增回归测试：
   AUDIO 模态不变、输入转写仍进 resident 链、Gemini 音频永不进 speaker。
3. **嘴 = 文本队列形态**（Codex R1 #4:GeminiTurnMouth 是 24k PCM 上采样合同，
   与 EdgeTts.synthesize 的整段 MP3 输出物理不兼容）：新增 `TextTurnMouth`
   （或复用 LeadSpeaker 的 text queue 形态）：句级缓冲（标点/长度切句）→
   EdgeTts.synthesize 串行 → 播放序保持 → final flush → 失败 fail-loud 到 TIV
   → barge-in `stop()` 清队。
4. **FeedPipeline 保留一等合同**（Codex R1 #4 + R2 #2 + R3 #2）：非 addressed
   Lead 的会议事实经 resident 的 `appendContext()` 投递（替代 Gemini line 的
   injectContext）。适配层合同：`accepted:false` → **HOLD cursor 不前移**（feed
   的既有 lag/retry 语义照用）；收到 `context-drained{upToSeq}` 事件（= 该轮
   **正常 terminal result** 已确认,非 stdin drain）→ `feed.retry()` 追平——
   长会大 backlog 无损、无 respawn loop、mid-turn crash 不丢事实（>64KB
   backlog→handoff + drain 后 SIGKILL→下轮重注入 端到端单测）。context 只缓存、
   随下一真实轮注入，绝不自触发回答。
5. `handleFounderUtterance` 路由后：addressed line 的 resident brain.respond(text)
   → TextTurnMouth。**barge-in 顺序（Codex R2 #4a）**：`mouth.stop()` **先同步**
   执行（founder 打断的当 tick 静音——LeadSpeaker stop() 的同步清音红线），然后
   异步 `brain.interrupt()`；**下一轮 respond 等待该 barrier**，不阻塞停嘴。
6. `cli.ts summarize`：改为 host 的 resident session 终轮「整理纪要(summary+
   action items,引用原话带时间戳)」；journal snapshot 仍传入作 crash 后重生
   session 的兜底材料。ConclusionPipeline 失败序语义不动。
7. teardown/release：manager.close(所有本会 key)；`lifetime-expiry` 事件 →
   host 走 degraded landing（既有降级路径）。
8. onEvent → TIV：recovering=「脑重连中」，failed=「脑掉线了,会继续但答不了」
   （与 545 F2 cue 体系合并）；545 先落的 per-turn 超时防御版在本接线 PR 里退役。

### 4.2 /eleven（FLY-1006 分支）

1. 配置：`huddle.eleven.leadId`（启动时验证存在于 leads 配置,缺失 fail-loud）——
   persona 来源（当前 /eleven 无 lead 参数）。
2. `ElevenCommand`：补立项 issue（复用 GeminiCommand.createIssue 形态 + kickoff
   标题格式）；失败 = 命令 fail-loud（no issue, no meeting）。
3. **时序（消 404 race，Codex R1 #6）**：daemon 已自产 conversation_id UUID 并经
   `custom_llm_extra_body` 传给平台 → 严格排序 `slot acquire → kickoff issue →
   manager.open(key=eleven:<daemon UUID>) 预热 → WS connect`。
   `conversation_initiation_metadata` 只作**一致性 gate**（回传 id ≠ 本地 id →
   fail-loud 终止会话）。`issueId/sessionId/brainKey` 贯穿 ElevenCommand/Session。
4. **`stop(reason)` = exactly-once 异步 finalizer**（manual stop / WS 异常 /
   start failure / daemon shutdown / no-show 五路归一）。**严格顺序（Codex R2
   #3——先静默链路再终轮,否则旧 turn 的 disconnect-interrupt/supersede 会和
   minutes 轮互相取消）**：
   ① CAS 进入 finalizing（重复 stop 幂等返回同一 promise）→
   ② 停收 ears/新 shim turn（BrainPort 对该 key 拒 503）+ 关 WS →
   ③ mouth/cue **同步停** →
   ④ interrupt 当前 brain turn 并 **await barrier** →
   ⑤ 冻结并落盘带时间戳 journal →
   ⑥ 按 reason 分支：start failure 走 GeminiCommand 的 abort-close 形态（**不跑
   minutes**）；其余 → 同一 resident 终轮生成纪要（brain failed → journal 直落
   + degraded 标记）→
   ⑦ AssistantLanding 形态落 issue（收据幂等/失败序照搬）→
   ⑧ **finally**：manager.close + slot release，无论 landing 成败。
   **no-show 信号源**：复用 /gemini assistant wiring 的 founder voice-presence
   分类（classifyVoiceState）+ 启动时 userVoiceChannelId 初始探测（967 initial-
   check 同型）；超时值沿 assemble 窗口默认 10min；founder join 即 disarm。
   **retry 面**：landing 失败写 durable `pending-landing.json`（receipt 相邻，
   §3.3 的 stage-aware continuation schema）+ **daemon 启动 reconciliation**
   （boot 扫 pending → unknown 按 stage 用 §3.3 的 marker/status 读回确认后续发
   → 从 journal 重建 degraded minutes 落地——不需要已关的 brain）。测试：active-turn manual stop / WS close
   during turn / founder already present / 真 no-show / comment 挂起 / 重启后
   reconciliation / 重复 stop。
5. shim：`FLY980_BRAIN_URL` + `FLYWHEEL_BRAIN_PORT_TOKEN` 双 env 齐备才走转发档
   （404/断连 fail-loud 报平台，**不静默降级**回本地 spawn；未设 = 现行为字节
   不变）。resident 档的 shim `/health` 联动探测 BrainPort 可达性（防 /eleven
   preflight 在脑口已坏时假绿）。平台 abort in-flight → shim 断开下游 socket →
   BrainPort disconnect-interrupt（§3.3）。

### 4.3 时序、完成门与分支漂移（Codex R1 #8）

- **Phase A**（本分支 → main）：交付物精确清单 = voice-core
  `src/brain/{ResidentClaudeBrain,ResidentBrainManager,stream-parse}.ts` +
  `src/process.ts` 加性扩展 + `src/types.ts`（VoiceErrorCode 加 resource-exhausted）
  + **`src/index.ts`（公共导出:新组件逐项 export;既有 parseStreamLine re-export
  路径不断——否则 545/1006 无法从 flywheel-voice-core 导入,Codex R2 #4c）**
  + voice-bridge `src/brain/BrainPort.ts` + `cli.ts` 装配（含两阶段 shutdown）
  + `config.ts`（huddle.brain 解析）+ 全部测试。
  **Phase A 合入只是组件 milestone，不结单。**
- **Phase B**（/glaw）：545 分支 rebase 到**包含 Phase A 的明确 main commit**
  后按 §4.1 实施。冲突必须保留 545 侧：HeadlessClaudeBrain cwd 支持、types.ts
  的 injectContext/connection-error 增量、genaiConnector 重连改动。
- **Phase C**（/eleven）：1006 分支同法 rebase 后按 §4.2 实施。冲突必须保留
  1006 侧：transcript 类型增量、VoiceRoomRuntime 底盘。
- 每个消费分支独立跑 voice-core + voice-bridge typecheck/test + 未启用模式
  reverse-compat 哨兵。
- **FLY-1160 完成条件**：A/B/C 三个 landed commit/PR 均可追踪 + /glaw 与 /eleven
  两条真机 QA 均 PASS + 最后一次跨分支整体验证。B/C 归属（545/1006 在飞 Runner
  或本 issue 续跑）由 Lead 调度，本 plan §4 是实现合同。

## 5. 配置面（三个解析面拆清，全部默认现状）

| 面 | 键 | 默认 | 解析位置 |
|----|----|------|----------|
| daemon(main, Phase A) | huddle.brain.port(token env 名硬钉 FLYWHEEL_BRAIN_PORT_TOKEN,不可配) | port 未配或 env 无值=BrainPort 不监听 | voice-bridge config.ts |
| daemon(main, Phase A) | huddle.brain.model / maxSessions | "sonnet" / 4 | 同上(founder 旋钮:980 数据 sonnet>haiku>opus,haiku 每轮先吐 thinking) |
| /glaw(545, Phase B) | huddle.brain.mode: "gemini"\|"resident" | "gemini"(现状) | 545 wireMeeting 解析 |
| shim(1006, Phase C) | FLY980_BRAIN_URL + FLYWHEEL_BRAIN_PORT_TOKEN | 未设=现行为 | shim env(不读 projects.json) |

byte-compat 哨兵：不加任何新配置时——health JSON、监听端口集、注册的 guild 命令、
claude 子进程 argv、shim SSE/错误行为——全部字节不变（测试断言，非口头）。

## 6. QA 验收（真机，issue 交付 3 的具象化）

结构性（硬）：
- ≥3 轮连续对话不掉线，**任何一轮不付进程 spawn**（ps 证据:全程同 PID）；
  回答不双播（final-echo 哨兵在真机链上复验）。
- 主动断连恢复：会中 kill -9 脑进程 → recovering cue → --resume 重生 → 下一轮
  记忆完好；重生 ≤10s。
- Gemini 断连注入（/glaw）：耳朵 rejoin 期间脑不受影响——FLY-1158 式 7 分钟死寂
  不可复现。
- 纪要真落对应 issue thread（summary+原话引用）+ 关单；/eleven 立项 issue 真建、
  五路退出都能落（至少验 manual stop + WS 异常两路）。
- 会后零孤儿：teardown 后 ps 无本会 claude 残留。

延迟（实测口径，research §2 的诚实叙事）：
- 脑侧热轮 TTFT 中位 ≤2.5s（sonnet，≥5 轮；spike 实测 1.85-1.9s，留方差余量）。
- 全链 speech-end→首音中位：/glaw ≤4.5s、/eleven ≤5.5s；等待期必须有 cue
  （cue 本体归 545 F2/eleven waiting-cue）。
- **不承诺 1-2s**：API TTFT 硬地板（980 V4 + 本 spike 双证）；此口径进给 Annie
  的报告，不超卖。

QA 方法：Chrome-as-Annie 真机 E2E（voice-QA 既定 pattern）+ 脑侧 jsonl 打点。

## 7. 风险与缓解

| 风险 | 缓解 |
|------|------|
| 545/1006 在飞,接线时序冲突 | §4.3 完成门:明确 rebase 基点 + 冲突必保清单 + 每分支独立验证;545 防御版超时在接线 PR 退役 |
| 模型档拍板延迟 | 默认 sonnet 带数据呈 Annie;config 一键换 |
| 常驻进程内存/负载 | 上限 4 + slot 限 1 会 + closeAll + 收尸校验 |
| CLI 持久模式行为漂移 | 协议断言进单测(init 不前置/中断白名单/final-echo/EOF);真 CLI 冒烟 RESIDENT_SPIKE 门 |
| shim 转发新故障点 | 404/断连 fail-loud 不静默;未配 env 字节不变可回退;shim health 联动探测 |
| 被丢弃的 Gemini 生成浪费 | 最短回复 system instruction;成本有界(每轮一句);TEXT 模态若未来模型恢复支持,再走独立 spike+plan 修订 |
| resume 后丢最后半轮上下文 | 纪要终轮附 journal snapshot 兜底(§4.1-6/§4.2-4) |

## 8. 实施顺序（implement 阶段,TDD）

1. 共享 parser（kind 标注 + final-echo 抑制;HeadlessClaudeBrain 回归哨兵先行）。
2. process seam 加性扩展 + fakes 升级（既有用例字节不变）。
3. ResidentClaudeBrain（RED→GREEN:状态机全项,§3.4 清单）。
4. ResidentBrainManager（上限/收尸/幂等）。
5. BrainPort + cli.ts 装配 + config 解析（默认不监听哨兵先行）。
6. 真 CLI 冒烟断言化（含 mid-turn SIGKILL 补 spike）;全仓 lint+test;PR（落 main）。
7. （Phase B/C 按 §4 合同,Lead 调度归属后执行。）
