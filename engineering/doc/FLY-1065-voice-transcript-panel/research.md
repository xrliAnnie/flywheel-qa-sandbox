# FLY-1065 /gemini 文本面板双向转写 + 会话记录持久化 — 调研
Issue: FLY-1065 (https://linear.app/geoforge3d/issue/FLY-1065/voice-gemini-文本面板双向转写-会话记录持久化annie-真机验收反馈)
日期: 2026-07-09
基于: exploration.md(brainstorm gate 已过:三问全批——等 #501 merge 后 rebase / voice-core final 修复进 scope / Linear comment 持久化 + 会后 TIV 发带链接短消息)

> 所有代码引用基于 PR #501 head `683418b4`(flywheel-FLY-967 分支)。本分支(main 基线)上没有这些文件,implement 前 rebase 到含 #501 的 main。

## 1. 转写事件链——逐层事实

### 1.1 Gemini SDK 层(@google/genai ≥1.16)

- `LiveServerContent.inputTranscription` / `.outputTranscription`,类型 `Transcription { text?: string; finished?: boolean }` —— `finished`:「the bool indicates the end of the transcription」。**这是官方的转写结束信号**。
- SDK 注释:「The transcription is independent to the model turn — it doesn't imply any ordering between transcription and model turn」——**user 转写与 model turn 无顺序保证**,聚合边界不能只依赖 turn 事件。
- `turnComplete` 语义 = 模型本轮生成完;`generationComplete` = 生成完(播放前);`interrupted` = 客户端(她说话)打断了生成。
- 转写分片是 **delta**(增量文本),整轮文本 = 分片拼接——967 的 s-a1 spike 就是这么消费的(`transcript.push(t.text)` 后 join,evidence 记录模型答题正确)。

### 1.1b 语言合同(Annie 2026-07-09 补充需求:中英混说必须都工作)

SDK `AudioTranscriptionConfig.languageCodes?: string[]`——官方注释:「**If not set, the transcription will be in the language detected by the model**」。967 现行 connect config 对 input/output 转写传的都是空 `{}`(genaiConnector.ts:50-51)⇒ **多语言自动识别已经是现状默认**。设计动作不是加功能,是把它钉成显式合同:① 绝不引入 languageCodes(不 pin 语言),config 测试断言两处仍为 `{}`;② 渲染/记录/scrub 全链对中英混排文本语言无关(字符级处理,无 CJK 特判);③ QA 验收矩阵加中英混说场景。

### 1.2 transport 层:genaiConnector.mapMessage(问题根源)

```ts
// packages/voice-core/src/backends/gemini/genaiConnector.ts (~155)
if (sc?.inputTranscription?.text) {
  emit({ type: "transcript", role: "user", text: sc.inputTranscription.text,
         final: !!sc.turnComplete });   // ❌ finished 字段被无视
}
```

`turnComplete` 几乎从不与转写分片同帧 ⇒ `final:true` 事实上从不发生。connect config 里 `outputAudioTranscription: {}` + `inputAudioTranscription: {}` 双向已开(genaiConnector.ts:50-51),数据一直在流,只是永远standing在 `final:false`。

### 1.3 session 层:GeminiLiveSession(voice-core)

- `onServerEvent` 的 `transcript` case:透传事件 + `if (e.final) this.writeTranscript(...)` ⇒ **sink 从没被写过**;
- cancel 语义已有:`interrupted` → `cancelCurrentTurn()`;cancel 后 assistant 转写被抑制(`turnCancelled` guard),user 转写始终放行;
- `endUserTurn()` → `conn.endAudioStream()`(round-6:Discord 静音抑制没有尾部静音,client 手动 commit 她的轮);
- `sendText()`(控制提示)不写 transcript——**控制提示永不入记录**,这个纪律保持;
- `TalkSessionRotator` 会在 goAway 时轮换 session:**同一场会 = 多个 GeminiLiveSession(sessionId 各异),共享一个 transcriptSink**(sink 在 factory 里建一次)。聚合 buffer 生命周期在 session 内,轮换时旧 session close——close 前需 flush 残余。

### 1.4 消费层:AssistantSession(voice-bridge)

`wireConversation` 只消费 `final:true`(AssistantSession.ts:340 附近):
- `tiv.caption(t.role, t.text)` — 全部 final 转写;
- `role==="user"` → `onFounderLine`:quotes 采集 + END_WORDS(「结束/就这样/收尾/到这里」)检测 + concluding 确认(AFFIRMATIVES);
- concluding 中 assistant final → `recapText` 累积。

⇒ **修好 final,这一层零改动就全部复活**(caption 拿到的就是整轮文本)。生产铁证(exploration §2)证明这条链当前全死:12 场 0 JSONL、FLY-1068 空纪要。

### 1.5 渲染层:tiv(wiring.ts)

```ts
const tiv = {
  status: (line) => void deps.sendMessage(orchestratorClient, config.voiceChannelId, line)...,
  caption: (role, text) => log(`[caption:${role}] ${text}`),   // ❌ v1 故意 log-only
  card: (text) => void deps.sendMessage(...),
  error: (text) => void deps.sendMessage(..., `⚠️ ${text}`),
};
```

- **status 刷屏实锤**:每次状态变化 = 一条新 Discord 消息。AssistantSession 每轮循环调 status ≥2 次(💬 speaking → 🎙 listening,工具轮再加 🧠 thinking)——十轮会 = 二三十条状态消息,零内容。
- caption 注释指明等 545 PR-2 的共享 TivPresenter(545 plan §代码地图:`packages/voice-bridge/src/discord/TivPresenter.ts`,「状态行单消息 edit(≥1s 节流合并)+ 字幕 + 结论卡片」)。545 PR-2 未落地 ⇒ 我们先立,后来者复用(GeminiCommand 头注释已有「谁后落谁抽」纪律)。

### 1.6 Discord 依赖面:DiscordDeps(discordWiring.ts:14)

现有 `sendMessage(client, channelId, text): Promise<void>` ——**不返回 message id,没有 edit**。status 单消息 edit-in-place 需要 additive 扩展:
- `sendMessageForId(...): Promise<{ messageId: string }>`(或改 sendMessage 返回值——改返回值对现有 caller 兼容,void 消费者不受影响,但测试 fake 都要跟;倾向新增独立方法,零触碰现有 caller);
- `editMessage(client, channelId, messageId, text): Promise<void>`。
真实现走 discord.js `TextChannel.messages.edit` / `Message.edit`;失败(消息被删)→ 重发新消息并更新 id(自愈)。

### 1.7 落地层:AssistantLanding

- `buildSummary()` = 纪要 + 原话引用;receipt(`{issueId, sessionId, commentAt}`)保证 comment 幂等;失败顺序法则:comment 失败 → issue 保持打开 + 提示 transcriptPath;close 失败 → receipt 保住,重跑只补 close。
- **transcriptPath 断链**:landing 收 `<stateDir>/${sessionId}.jsonl`,真实 sink 写 `conversation-<randomUUID()>.jsonl`(wiring.ts makeRealConversationFactory)——兜底提示指向永不存在的文件。修法:sink 路径改由 assistant sessionId 决定。**接线现状**:`createConversation(systemPreamble)` 工厂在 wireAssistantMode 顶层建一次,签名不带 sessionId ⇒ 需把签名扩成 `createConversation(systemPreamble, opts: { sessionId })`(内部签名,#501 merge 后改无兼容问题;test seam 同步)。

### 1.8 kickoff issue 生命周期(持久化落点)

每场 /gemini 建独立 kickoff issue(如 FLY-1068,GeminiCommand.handle → linear.createIssue),落地时 comment 纪要 + closeIssue("Done")。逐字记录 comment 落同一 issue = 摘要+逐字同处。Bridge Linear proxy 已有 comment/closeIssue/create-issue 三条路由(wiring.ts makeLinearClient),**无需新 Bridge 路由**。

## 2. 设计要点推演

### 2.1 turn 聚合(层 1,voice-core GeminiLiveSession)

- transport `LiveServerEvent` transcript 事件**加可选 `finished?: boolean`**(connector 透传 `sc.inputTranscription.finished` / `sc.outputTranscription.finished`);
- GeminiLiveSession 维护 `userBuf` / `assistantBuf`:
  - 分片到达:append buffer + 照旧发 `final:false` 分片事件(向后兼容,消费者无感);
  - **flush 成 final**(聚合全文,发 `final:true` 事件 + 写 sink),触发条件按优先级:
    1. 该 role 的 `finished === true`(主信号);
    2. `turn-complete`:先 flush userBuf 再 flush assistantBuf(兜底);
    3. `interrupted` / manual `interrupt()`:flush assistantBuf,事件加 `interrupted: true`(user buffer 保留——打断即她在说话);
    4. `close()`:flush 双向残余(rotator 轮换时不丢尾巴);
  - flush 只在 buffer 非空时发(finished + turnComplete 双到不产生双 final);
  - cancel 抑制语义微调:cancel 后 assistant **分片**照旧抑制,但 cancel 时机的 flush(带 interrupted 标)先于抑制发生——被打断的话已说出一半,记录要如实留痕;
- `ConversationEventMap` transcript 事件加可选 `interrupted?: boolean`;`TranscriptEntry` 同步加(JSONL 里可见)。全部 additive,既有测试(gemini-live.test.ts 等 79+)必须不改自绿。

### 2.2 finished 字段真机风险

`finished` 是 optional 字段,服务端是否稳定回传需真机验证。**设计不赌单一信号**:finished 是快路径,turnComplete/interrupted/close 三层兜底保证「最坏也是轮末聚合」。implement 阶段先跑一个 s-a1 形态的 mini-spike(GEMINI_API_KEY 在机,spike harness 现成)录 evidence:确认 finished 行为 + 分片 delta 假设。若 finished 不回传,主信号自动退化为兜底信号,功能不损(边界从「转写完」退到「轮完」,对 caption 体验无感)。

> **续跑注记(2026-07-09)**:mini-spike 已跑完(前任 implement runner,OOM 前)——`finished` **双向不回传**,且 `turnComplete` 比 `generationComplete` 晚 10.2s(「对 caption 体验无感」的假设不成立:轮末聚合 = 字幕晚约十秒)。修订后的信号链(user=首个 assistant 输出 / assistant=generation-complete / turnComplete 终兜底)见 plan §6b + evidence/finished-flag-probe.md。本节原文保留作设计推演记录。

### 2.3 caption 渲染(层 2,voice-bridge TivPresenter)

- 新文件 `packages/voice-bridge/src/discord/TivPresenter.ts`(545 计划路径,后来者直接复用):
  - `caption(role, text)`:每个 final 轮发**一条新消息**——`🗣️ **Annie**:…` / `💬 **助理**:…`(founderName 来自 config;role=assistant 显示名用命令名或「助理」);interrupted 轮加「(被打断)」尾注;>1800 字符截断 +「…(截断,完整见会后记录)」;
  - `status(line)`:**单消息 edit-in-place**,≥1s 节流合并(窗口内只保留最新),消息不存在/被删则重发并记新 id;
  - `card` / `error`:独立新消息(现行为)。
- 速率:轮节奏天然 ≥ 数秒/条,远低于 Discord bot 限速;status edit 节流后 ≤1 次/秒。
- 现 tiv 对象(wiring.ts)整体换成 TivPresenter 实例;AssistantSession 的 TivSurface 接口不变(caption/status/card/error 四方法签名原样)。
- 开关:`assistant.captions !== false` 默认开(byte-compat:不开 /gemini 的项目零变化;假如 caption 出观感问题一键回 log-only)。

### 2.4 逐字记录落地(层 3)

- **数据源** = 本场 JSONL(sink 路径对齐后 `<stateDir>/<assistant-sessionId>.jsonl`,天然跨 rotator 轮换聚合全场);landing 读文件重建逐轮记录(ts + role + text + interrupted 标);
- **形态** = kickoff issue 上独立于纪要的第二条 comment:「## 逐字对话记录(/gemini 助理)」+ 逐轮 `- [HH:MM:SS] **Annie**:…` / `**助理**:…`;
- **分段**:单条 comment ≤ ~20k 字符,最多 3 条(超出在末条注明「更长部分见本机 <jsonl 路径>」——Linear comment 尺寸上限未公开文档化,20k 保守值 implement 时用真 API 验证);
- **幂等**:receipt 扩成 `{issueId, sessionId, commentAt, transcriptAt?}`(旧 receipt 无 transcriptAt = 视为未发,只补逐字段;字段 additive 兼容旧文件);
- **失败顺序法则扩展**(维持 967 既有法则形态):summary comment 失败 → 同现状(issue 开 + 报 JSONL 路径);summary 成功但 transcript comment 失败 → issue 保持打开,receipt 记 commentAt,重跑跳过 summary 直补 transcript;两者成功 → close。JSONL 为空/缺失(如 0 轮会议)→ 跳过 transcript comment,不算失败;
- **Discord 入口**(Tadashi gate 补充):landing 成功卡片扩为「✅ 会议纪要 + 📝 逐字记录已存 <issueId>\n<commentUrl>」——一条消息带链接,Annie 从 Discord 一键到达,不另发第二条(别刷屏纪律)。

### 2.5 scrubTranscript(红线)

- voice-core 新增纯函数 `scrubTranscript(text: string): string`:常见凭证形态 → `[redacted]`——`sk-…`/`ghp_…`/`github_pat_…`/`gho_…`/`xox[baprs]-…`/`AIza…`/`Bearer <tok>`/`<NAME>_TOKEN|_KEY|_SECRET=<val>`/长 base64/hex(≥32)连串;
- **应用点 = final 聚合出口**(GeminiLiveSession flush 时,发事件前):下游(caption/quotes/recap/JSONL/Linear comment)全部拿到干净文本,单点收口;
- 已知边界:`final:false` 分片事件不 scrub(跨分片的 token 无法整段匹配;v1 无消费者展示/落盘分片——文档明示这个边界,545/1018 未来消费分片时自行负责);
- 口语转写命中率极低是预期,scrub 是防「助理复述工具输出里带凭证」的护栏,宁可白跑。

### 2.6 与 967 既有行为的回归面(gate 约束:增强不是回归)

final 复活后行为变化点(全部是「从不工作 → 按设计工作」):
1. END_WORDS 语音收尾开始真正触发(以前只有 founder-leave);
2. recap/quotes 开始有内容(FLY-1068 型空纪要消失);
3. JSONL 开始落盘。
回归覆盖:967 既有单测(assistant-session/landing/wiring 等)全绿不改;新增测试断言上述三点的**新行为**;staged E2E(gemini-staged.mjs 形态)跑一轮验证 caption 消息真出现在 TIV。

## 3. 依赖与排序

| 项 | 状态 | 处理 |
|----|------|------|
| PR #501(FLY-967) | OPEN,在 Annie ship gate 上 | **implement 开工前提**:rebase 本分支到含 #501 的 main(Tadashi 批,不 stack 967 分支) |
| FLY-545 PR-2(TivPresenter) | 未落地 | 我们先立 `discord/TivPresenter.ts`,545 复用(「谁后落谁抽」) |
| FLY-1018(gemini-agent) | In Progress(PR #518) | 无耦合;voice-core final 修复对它免费受益 |
| Bridge 路由 | 已有 comment/closeIssue | 零新增 |

## 4. 测试面(plan 里落细)

- **voice-core 单测**:聚合(finished 主路/turnComplete 兜底/interrupted 标记/close flush/双信号不双发/空 buffer 不发)、scrub(每类凭证形态 + 中文口语原样)、transport finished 透传、既有 79+ 测试字节不动全绿;
- **voice-bridge 单测**:TivPresenter(status 节流合并/edit 失败自愈/caption 截断/开关)、landing v2(receipt 两阶段幂等/分段/失败顺序三组/空 JSONL 跳过)、wiring(sink 路径 = sessionId/tiv 换 presenter);
- **真机**:① mini-spike 录 finished 行为 evidence;② staged E2E:autostart 一轮,断言 TIV 出现 caption 消息 + status 只有一条(edit);③ QA 阶段真 /gemini 轮(founder 验收前的独立 QA);
- **byte-compat 哨兵**:captions 开关关闭 = caption 回 log-only;不配 huddle.assistant 的项目零行为变化。
