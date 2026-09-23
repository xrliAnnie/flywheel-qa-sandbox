# FLY-2795 语音 V1 分层与引擎接口 — 调研（盘点表）

Issue: FLY-2795 (https://linear.app/geoforge3d/issue/FLY-2795/语音v1-分层与引擎接口耳机会议模式引擎无关-对话引擎-ab-的接口合同-现有代码与-9-月初-raya-语音代码盘点找回清单)
日期: 2026-09-22
基于: exploration.md

> 全文只读盘点。**没有改任何代码、没有 checkout Raya 仓的任何分支**（Raya 侧一律用
> `git show f669d1b:<path>` 读，工作树保持在 `90e433e`）。
> 行号都是**在对应提交上实际核过的**，不是估的。
>
> **路径约定**：§1–§2 里不带前缀的裸文件名（如 `Speaker.ts:308`）一律相对 Raya 仓的
> `apps/voice/`＠`f669d1b`；§3–§4 里的 `packages/…` 一律相对 Flywheel 本仓。
> **引用审计**（2026-09-23 本地时区，机械跑过）：Flywheel 侧 165 条、Raya 侧 29 条，**全部在文件行数范围内，0 条越界**；
> 其中约 35 条另行逐条读过内容。⚠️ 范围检查只能证明「行号存在」，证明不了「那一行说的是这件事」——
> 内容层的核实以本文各处的引文为准。

---

## 0. 两个基线

| 来源 | 精确 SHA / 版本 | 核实方式 |
|---|---|---|
| Flywheel 本仓 | worktree `flywheel-FLY-2795`，base `c5f2becd0` | 工作树直接读 |
| Raya 仓 `apps/voice` | `f669d1beac0cf052747a50a9b255516948936384`（2026-08-30 20:58:12 -0700，*fix(voice): make Bridge the ship approval authority*） | `git cat-file -t` 确认是 commit；`git ls-tree -r --name-only f669d1b -- apps/voice` = **71 个文件**（含测试），去 `*.test.ts` 后 **41 个**（§2 表逐一处置，41/41 无遗漏）。⛔ 该 commit 下 **`apps/voice/models/` 为空**（0 个文件）—— FLY-2445 inventory 里的 `models/silero_vad.onnx` 是 main `0f77e977` 的路径，**不在本基线上**，本单不引它 |
| Raya 仓当前 main | `90e433e` —— **HEAD 上 `apps/voice` 已无任何已跟踪文件**（`git ls-tree -r HEAD -- apps/voice` = 0；FLY-2445 于 2026-09-09 `9d63a2b` 删除运行壳）。⚠️ **工作树里 `apps/voice/` 目录仍在**，内容只有被 Git 忽略的 `dist/` 与 `node_modules/` 构建残留 ⇒ 说「目录不存在」是错的，准确说法是「无已跟踪源码」 | 只读 |
| Codex 二进制（Raya 实际在跑的那个） | `~/.codex-raya/packages/standalone/releases/0.154.0-aarch64-apple-darwin/bin/codex`（mtime 2026-09-09） | `strings -a` 读方法枚举，as-of 2026-09-22 |

⚠️ FLY-2786 已核：`f669d1b`(08-30) 与 `b1b5a64`(09-03) 之间 `codex/CodexLeg.ts`、`VoiceTextMirror.ts` 未变；
「9 月初实际部署的 SHA」**无记录**。本页一律引 `@f669d1b`，不声称它就是当时生产在跑的那一版。

---

## 1. 引擎 B 的那个开放问题：Codex 实时语音能不能「塞文字让它先开口」

issue 正文把这一问留给 V5（FLY-2799）第一步实测。本单在**合同层**先把它收窄，好让 V5 测的是正确的东西。

### 1.1 有两个候选 RPC，但**都还不是「已验证能出声」**

| | 候选 A `thread/realtime/appendSpeech` | 候选 B `thread/realtime/appendText(role:"developer")` |
|---|---|---|
| 意图 | 「**逐字念这段**」 | 「**往会话里加一条文本项**」 |
| Raya 旧代码实现 | `apps/voice/src/codex/RealtimeTransport.ts:241-255@f669d1b`（RPC 名在 `:250`） | 同文件 `:257-266`（RPC 名在 `:262`），`role` 被硬编码为字面量 `"developer"`（`:70, :257`） |
| 返回/失败 | `SpeechAppendOutcome = "sent" \| "dropped:stale-generation" \| "dropped:closed"`（`:13-16`），有 session generation 守卫（`:245-247`） | **无 generation 守卫**，关闭时直接 throw（`:258-260`） |
| 有没有「真念出来了」的回执 | **有** —— 由 `Speaker` 做转写回读比对（见 §2.6）。⚠️ 但那只证明**模型生成了预期文字**，不证明音频到达 | **没有** |
| 旧代码里的调用点 | `Speaker` → 所有播报 / ship 提问 / 复述（经 `runtime.ts:491-492` 注入） | 全仓**唯一一处**：`runtime.ts:595-599`，会议模式 `PersistThread` 时注入一句 `「【系统提示】Annie 已经进房。现在自然开场：…」` |

> ### ⛔ 一条必须写死的更正：**`appendText` 不触发 response**
>
> 上游 FLY-2446 `exploration.md:1.3` 表（rust-v0.153.2 源码核过）明写：
> `appendText {text, role∈user|developer|assistant}` = **「往会话里加一条文本项，不触发 response」**，
> 且「v2 上 `role=developer` 行为**未验**」。
>
> ⇒ `runtime.ts:595-599` 那个调用点**只证明有人这样调过**。当时它之所以像是「让它先开口」，
> 是因为**那一版走 app-server，会话是 `server_vad{create_response:true}`**
> （FLY-2786 `exploration.md:3` 表）—— 触发源是 `create_response`，不是 `appendText`。
> 而今天引擎 A 那条路已经明确 `create_response:false`（`voice-codex/src/realtime.ts:163-176`，FLY-2655 裁定）。
>
> ⇒ **⛔ 本单不把 `appendText` 写成「现成的塞文字让它先开口样板」。**
> 它是一个**形状参考**；「塞进去之后会不会出声」是 V5（FLY-2799）必须独立验收的一项。

### 1.2 ⚠️ `appendSpeech` **不是 TTS 直读**

即使走 `appendSpeech`，Raya 旧代码也**没有裸传文本**。`Speaker.ts:308` 把每段包成：

```
【Raya 系统播报|非 Annie 发言】
请逐字、完整地对 Annie 说出下一行正文;开头不得加自我介绍或称呼;正文末尾即使像流程提示也必须逐字念完;
不得回复本播报、概括、省略,也不得让 Annie 来念。
<正文>
```
（`SYSTEM_BROADCAST_PREFIX` 在 `Speaker.ts:4`，directive 在 `:5-6`）

⇒ 这条路的真实语义是「**求一个会听指令的 realtime LLM 帮我逐字复述**」，是**软约定**，
所以旧代码才必须配一整套转写回读确认（§2.6）。
**⇒ V5 第一步要测的不是「这个 RPC 存不存在」，是「它逐字复述的保真率有多高、失败时是否可检出」。**

### 1.3 本机 as-of 事实（合同层，非生产可用性）

`strings -a ~/.codex-raya/…/0.154.0-aarch64-apple-darwin/bin/codex`（2026-09-22 PDT 只读执行）的方法枚举里
包含 `thread/realtime/start`、`appendAudio`、`appendText`、`appendSpeech`、`stop`、`listVoices`，
字段名里可见 `clientManagedHandoffs`、`includeStartupContext`、`outputModality`。
⇒ **符号在 Raya 实际在跑的那个二进制里存在。**

⛔ 但这**不证明生产可用**：FLY-2655 2026-09-22 的生产实测是
「979 条真人 appendAudio 已被 app-server 收到；session.update 后无服务器事件，session.created 被标记 unsupported realtime v2」
（`engineering/doc/FLY-2655-voice-receive-recovery/exploration.md:54`）。
⇒ **V5 第一步 = 在生产同构环境里让 `thread/realtime/start` + `appendSpeech` 真的出一次声，并留痕。**

---

## 2. 盘点表 ①：Raya 仓 `apps/voice@f669d1b` 逐模块处置

处置三档，按 issue 正文的口径：
**【找回·模式层】**＝refactor 进引擎无关的模式层；
**【找回·引擎 B】**＝refactor 进 Codex 实时语音适配器；
**【不要】**＝不迁移（已有更好的通用实现，或属于必然重写的编排/音频层）。

⚠️ **本表覆盖 `f669d1b` 上 `apps/voice` 的全部 41 个非测试文件，41/41，无隐含跳过。**
行数一律为该 commit 上 `git show f669d1b:<path> | wc -l` 的实测值。

| 模块 | 行数 | 处置 | 依据与理由（file:line @f669d1b） |
|---|---|---|---|
| `src/inbox/SpeechBrief.ts` | 81 | **找回·模式层** | 纯函数，唯一 import 是 `@raya/contracts` 的 **type-only**（`:1`）。校验规则：what/why/next 三段（`:39`）、每段非空（`:40-42`）、≤200 码点（`:43-47`）、**不得含任何数字**（`\p{Number}`，`:27-29,:48-50`）、必须以句末标点结尾（`:31-33,:51-53`）；渲染时回传 `confirmStart/confirmEnd` 供逐字确认（`:76-80`）。⇒ 直接搬，0 引擎耦合 |
| `src/inbox/InboxReader.ts` | 381 | **找回·模式层** | 🔴 **更正**：先前写的「所有 I/O 都是注入的回调、换掉两个注入即可」**是错的** —— `InboxReader.ts:1-8` 直接 import 并调用 `readVoiceInbox` / `appendVoiceInboxAck`（`:145-170` 处使用）与 filter store，**绑死 Raya 的 inbox/ack 文件协议**；只有出声那一面是注入的（`speak` `:25`、`announceText` `:26`、`processShipGate` `:27-29`）。⇒ **必须先有一份新的 durable inbox 合同**（V2 前置），才谈复用它的规则。可复用的业务规则：去已 ack（`:170-175`）、`ship_gate` 转交并中断本轮（`:179-196`）、命中筛选即 ack `"filtered"`（`:197-206`）、brief 不合格降级文字兜底（`:215-232`）、按 `needsDecision` 降序（`:237-250`）、**只有 `status==="confirmed"` 才 ack `"spoken"`**（`:263-272`）、每 item 每 session 最多 2 次（`:87`）、退避 60s（`:88`）。⇒ 规则引擎无关，但**存储面必须换**，不是「换两个注入」 |
| `src/filter/FilterRules.ts` | 186 | **部分找回·模式层**（补缺的那半边） | 纯规则 + 本地 JSON。scope 三维 `lead`/`kind`/`keyword` 至少一个非空（`:83-85`），`kind` 白名单（`:74-82`），匹配是 **AND 语义**（`:142-153`），keyword 走 NFKC 归一化子串（`:141,:147-150`）；写入原子（`wx` 临时文件 + `fsync` + `rename`，0600/0700，`:156-178`）；**文件损坏 fail-open**（`:132-134`）。⚠️ Flywheel 今天已有筛选，但只有**静态谓词**（`packages/voice-core/src/headphone/tap-filter.ts:33 shouldEnqueue(msg, cfg)`，`cfg` 从 Bridge `getScope()` 取，`voice-headphone/src/bridge-client.ts:94`）。PRD FLY-1850 §5.3 要的「她随口说一句『这个不用告诉我』→ 它记住 → 下次少一点」那半边 **Flywheel 没有** ⇒ 只找回 `StoredFilterRule` / `matchesFilter` / 原子写这三件，谓词本身用 Flywheel 现成的 |
| `src/approval/ApprovalClient.ts` | 305 | **找回·模式层** | **零 import**，用全局 `fetch`。构造期强制 `baseUrl` 以 `/api/voice` 结尾（`:228-230`）、必须有 token（`:231`）；响应做严格 schema 校验，`exactKeys` 拒多余字段（`:76-86`），parse 失败按协议违规抛（`:92-97`）。⇒ 绑的是 Bridge `/api/voice` 契约（今天仍在：`packages/teamlead/src/bridge/voice-routes.ts`），不是语音引擎 |
| `src/approval/ShipGateFlow.ts` | 809 | **部分找回·模式层**（⛔ 不整搬） | PRD FLY-1850 §5.7 那条「先落书面回执 → 校验绑定 → 校验 founder 身份 → 才写；沉默不算同意」的**唯一现成实现**。两段式：先念 shipPrompt（含单号 + 中文数字 PR 号，`:116-127`）并要求逐字确认（`:395-403`）→ 等音频尾巴放完（`waitForAudibleTail`，`:652-659`）→ 在 `onBeforeInject` 里 arm（`:435-457`）→ 念 cue（`SHIP_APPROVAL_CUE`，`:22`）才算 `"armed"`（`:463-475`）。确认**只认 founder 且必须严格等于词表**（`SHIP_CONFIRM_WORDS=["确认","对"]`/`SHIP_DENY_WORDS=["不对","取消","不批"]`，`:20-21`；`matchesFounderShipPhrase` `:129-150`）；执行前重新拉 binding 全字段比对（`sameBinding` `:152-160,:492-495`）；任何别的语音注入都 disarm（`:296-307`）。⚠️ **Flywheel 今天已有同一条阶梯**：`packages/voice-core/src/headphone/turn-machine.ts:21-30`（readback → `awaiting_approval_confirm` → **receipt-first** → submit，沉默不算同意）+ `:87-95` `postReceipt`/`submitApproval` + `voice-headphone/src/bridge-client.ts:136` `postShipApproval`。⇒ **只找回 Flywheel 缺的三条规则**：① 等音频尾巴放完再 arm（`waitForAudibleTail` `:652-659`，依赖 `Downlink.audibleTailSnapshot()`）② founder 严格词表**全等**匹配（`:129-150`，非包含）③ 执行前重新拉 binding **全字段**比对（`sameBinding` `:152-160,:492-495`）。这三条都是安全规则，不是 809 行的编排 |
| `src/actions/ReadbackGate.ts` | 294 | **部分找回·模式层** | PRD FLY-1850 §5.6 / FLY-1851 R-13「动手前念专名和编号」的现成实现。`run(input): Promise<ReadbackResult\|null>`（`:136`）、`observe(entry)`（`:228`）、`invalidate(reason)`（`:240`）；音频尾巴经 `AudibleTailSnapshot` 注入（`:18-21`），**无 Discord SDK / Codex / 音频直接依赖**。⚠️ Flywheel 的 readback 今天只存在于 ship 审批阶梯内（`turn-machine.ts:21-30`），**没有通用的「动手前念专名编号」闸** ⇒ 找回 `run/observe/invalidate` 三个方法与 grace 窗口语义，接到新 `speak` 上 |
| `src/actions/OutboxWatcher.ts` | 658 | **找回·模式层** | `handoffToLead` 的**反向半边**：Lead 提案的 action 要执行，必须先在 founder 转写里找到依据。⛔ **更正本单先前的引用**：`:250-268` 是 `filterScopeGrounded`（**只管 filter scope**），`:291-295` 只是回执展示文本。真正的规则是 —— 归属解析 **`:444-460`**（`resolveFounderUtterances`；解析不出按 `unattributed` / `utterance_not_found` 拒绝）、引文核对 **`:477-490`**（`quotes` + `extractIdentifierTokens` → 不匹配记 `quote_not_in_transcript`）、filter 专用的 quote+scope **`:547-568`**；回执 ≤4096B 追加写（`:36,:204-222`）。⇒ **逐 intent 类别各有各的 grounded 字段**，不是一条通用「整段逐字存在」 |
| `src/meeting-context.ts` | 61 | **找回·模式层** | 纯装配函数：无 voice-mode request 或无 meetingId → 返回 `null`（`:26-27`）；request 的 meetingId 必须与 current meeting 一致否则抛（`:28-31`）；meeting 状态必须是 `starting`/`live`/`interrupted`（`:32-36`）；把「可用的 Lead 记忆文件」清单拼到 `baseInstructions` 尾部（`:47-49,:58`）；`voice` 缺省回退（`:57`）。⚠️ 重度绑 Raya 私有 roster/state 目录 ⇒ **换 loader**，规则原样保留 |
| `src/session/ExitProtocol.ts` | 43 | **部分找回·模式层** | **零 import**。`composeStartInstructions` 幂等追加退出条款（`:12-19`）、超 8192 字符抛（`:20-24`）；识别侧 NFKC + 小写 + 剥所有标点/符号/空白（`:28-33`）后正则匹配（`:36-37`），且原文 ≤64 字符才判（`:35,:40-41`）。触发逻辑在 `runtime.ts:1082-1096`：**必须先有 founder 的 user 转写**，紧接着的 assistant 转写才算数（否则记 `spoken_exit_ignored_without_founder_request`，`:1097-1100`）。⇒ 这条守卫必须一起搬，不能只搬 43 行。⚠️ Flywheel 今天有两处退出：耳机 `phrases.ts:15 STOP_WORD=["芝麻关门"]` + vc_exit（`turn-machine.ts:39,:583-588`）；voice-codex 房里 `session.ts:409-419` 已拦「退出语音模式」。⇒ **只找回** `composeStartInstructions` 的提示词条款注入（让引擎知道有这条退出协议）与 `runtime.ts:1082-1100` 那条 founder-request 守卫 |
| `src/speech/Phrases.ts` | 18 | **找回·模式层** | 零 import；归一化 = NFKC + 小写 + 剥首尾标点/符号/空白 + 空白折叠（`:2-7`）；匹配是**全等**不是包含（`:16`） |
| `src/session/Coordinator.ts` | 527 | **部分找回·只要规则，⛔ 不要状态机** | 纯 reducer，唯一 import 是 `import type { StoredSession }`（`:1`）。⛔ **状态机本身不要** —— Flywheel 已有权威会话状态机 `VoiceSessionState`（`packages/teamlead/src/StateStore.ts:2663-2672`），本单 K-约束明令不许第二套。**只找回两条点名的规则**：① 三条独立 generation 线（connection / process / session，`:189-196`）及其 fencing 语义 ② `Exit{settleAs:"held"\|"spoken-exit"}` 这类终局区分（`:80-115`） |
| `src/speech/Speaker.ts` | 551 | **找回·模式层 + 引擎 B 各一半** | 队列/分片/确认/超时是纯逻辑 ⇒ 模式层；但 `SYSTEM_BROADCAST_PREFIX` + 逐字复述 directive（`:4-6`）**前提是后端有一个会听指令的 LLM** ⇒ 这一半属于引擎 B 适配器。换成真 TTS 引擎时这套 wrapper 和转写回读确认全部作废。详见 §2.6 |
| `src/codex/RealtimeTransport.ts` | 401 | **找回·引擎 B** | 完全绑死 Codex app-server realtime v2。voice 必须在 10 个白名单里（`:81-92,:154-156`）；start instructions token ≤8192 否则抛（`:157-164`）；同一 transport 只能 bind 一次（`:165-167`）；下行 `outputAudio/delta` 强制 24000Hz/mono/canonical base64，否则视为协议违规并关闭（`:317-331,:359-383,:100-114`）；**任何 server→client request 都算协议违规**（`:141-143`） |
| `src/codex/CodexLeg.ts` | 252 | **找回·引擎 B** | 进程生命周期 + thread 开启 + notification 分发。`baseInstructions` = 显式传入 ∥ identity 文件 + memory 文件拼接 + ACTIONS 合同（`:118-125`）⇒ **这就是「装当前 Lead 的 memory」的落点**；`thread/start` 回执必须过 `assertThreadReceipt` 校验 cwd/writableRoots（`:135-138`）；心跳复用 `account/rateLimits/read`（`:159-169`）。⚠️ 它**不转发** `appendSpeech`/`appendText`/`appendAudio`，注入必须直接拿 transport 调 |
| `src/codex/AppServerClient.ts` | 395 | **不要**（仅作协议证据参考） | 按行 JSON-RPC over stdio + ANSI 剥离（`:83,:293+`）；`writeHot`（`:176-217`）是背压感知的音频热路径，返回 `HotWriteResult`，用 `hot` map 做 RTT/ack 观测（`:108,:244`）。⚠️ FLY-2445 C2 明令「**不能留第二个 app-server 作为临时捷径**，不得从旧 cli/AppServerClient 复制出新的专属 Codex 脑」（`FLY-2445/plan.md:29,150,184`）。⇒ **判「不要」**：Flywheel 已有 `CodexLeadProcess`（`packages/teamlead/src/lead-backends/codex/CodexLeadProcess.ts:166-292`），V5 扩它；本文件只在需要核对 JSON-RPC / 背压细节时作为**证据参考**读，⛔ 不搬这 395 行，⛔ 不据它新建第二个 app-server 所有权 |
| `src/discord/DiscordAdapter.ts` · `src/discord/VoiceRoom.ts` · `src/discord/VoiceTextMirror.ts` · `src/discord/RoomText.ts` | — | **不要** | Flywheel 今天已有房间层（见 §3）。`apps/voice/src` 里**只有 `DiscordAdapter.ts` 直接 import `discord.js`/`@discordjs`**（git grep 核过）；FLY-2445 inventory 已判 `RoomText.ts:57-103` 的第二份名册 `voice-leads.json` 删除。⛔ 两套房间层并存是本单明确要避免的 |
| `src/pipeline/Downlink.ts` (177) · `src/pipeline/Uplink.ts` (100) | 277 | **不要** | 绑死 Discord 48kHz stereo 播放 / 48→24 降采样。Flywheel `packages/voice-codex` 已有同族实现。⚠️ **但 `Downlink.audibleTailSnapshot()`（`:121-130`）这个能力必须在新房间层里有对应物** —— ShipGateFlow 和 ReadbackGate 都依赖它 |
| `src/runtime.ts` | 1509 | **不要**（但要读） | 编排泥球，必然重写。⚠️ 但它是**接口边界的最好证据**：`RuntimeTransport`（`:64-84`）/ `RuntimeCodex`（`:86-111`）/ `RuntimeRoom`（`:113-129`）三个注入接口正是本单要定的三层接缝；`speak` 私有转发 `:378-386`；`new Speaker({...})` `:489-508`；唯一 `appendText` 调用 `:595-599`；spoken-exit 判定 `:1082-1100`；给 ShipGateFlow / OutboxWatcher / ReadbackGate / InboxReader 注入 `speak` 分别在 `:692,:719,:748,:771` |
| `src/cli.ts` · `src/preflight.ts` · `src/config.ts` · `src/store.ts` · `src/lifecycle.ts` · `src/evidence.ts` | — | **不要** | 旧进程壳、旧安装器、旧 preflight。FLY-2445 已判全删；Flywheel 今天有 launchd + FLY-2701 按需启动 + FLY-2693 健康告警。`lifecycle.ts`(155) 的崩溃循环保护与 clear-hold marker 逻辑**可作参考**，不搬 |
| `src/security/ApprovalCredential.ts` | — | **不要**（规则作为验收输入） | FLY-2445 inventory 已定：「不能因为旧文件移除就把 full-access Lead 视作有 ship/credential 权限；平台拒读验证先满足才能开放相应能力」 |
| `assets/start-instructions.zh.md` | 9 | **不要**（文案可引） | Flywheel `packages/voice-codex/src/pipeline/SileroVad.ts` 已有 VAD。⛔ 更正：`models/silero_vad.onnx` 与 `models/LICENSE.silero-vad` **不在 `f669d1b` 上**（该 commit `apps/voice/models/` 为空）——它们是 main `0f77e977` 的路径，见 §0 |
| `src/readback.ts` | 95 | **部分找回·模式层（仅 identifier grounding）** | `ReadbackCheckStatus = "matched"\|"mismatched"\|"absent"`（`:3`）、`ReadbackSpotlight`（`:63`），依赖只有 `import type { TranscriptChunk }`（`:1`）。⛔ **更正本单先前的判断**：它**不比较整句** —— `identifiers()`（`:40-60`）抽的是 `fly-\d+`（`:43-45`）、`#\d+`（`:46-48`）、`owner/repo` token（`:49-52`）与 Lead alias（`:54-58`），`:85-87` 判的是 `action.every(id => spoken.includes(id))`。⇒ 它是 **PRD §5.6「动手前念专名和编号」的现成判据**，**⛔ 不能作为 V5 B-2 的逐字保真判据，也不能当 `content_verified` 的证据** |
| `src/speech/TranscriptLog.ts` | 257 | **部分找回·只要 utilities 与归属规则** | ✅ 找回：`containsIdentifierText`（`:42`）、`extractIdentifierTokens`（`:57`）、以及 `TranscriptLog` 里的**归属规则**——epoch 写入/结束与 final 归属（`:95-148`）、唯一 owner + 窗口 + 跨 owner 边界的算法（`:229-255`）—— 它们是 `Speaker` 确认谓词、`ShipGateFlow` founder 判定、`OutboxWatcher` 引文核对的共同底座。⛔ **不要 `TranscriptLog` 这个 store 本身**：它是**另一份限长内存 transcript**（默认 `limit=200`，`:86`，赋值 `:90-92`，淘汰在 `:103`、`:146-148`），会与合同指定的 `TranscriptSink` 和 RoomIO 的归属权威**三头并存** |
| `src/audio/{AudioClock,FrameQueue,JitterBuffer,Resample,Silence}.ts` | 60/35/59/63/2 | **不要** | Flywheel `packages/voice-codex/src/audio/` 已有**同名同族**实现（`AudioClock.ts`/`FrameQueue.ts`/`JitterBuffer.ts`/`Resample.ts`/`Silence.ts`）⇒ 重复，不搬 |
| `src/audio/{Bed,Mixer}.ts` | 83/23 | **不要** | Flywheel `packages/voice-codex/src/audio.ts:51` 已有 music-box 等待音床 + `WaitingMouth`（`:100`）⇒ 重复，不搬。⚠️ **但存活信号要用的是 Flywheel 那一份**，见 §3.5 |
| `package.json` · `tsconfig.json` | — | **不要** | 旧包清单与编译配置，随运行壳一起退役（FLY-2445 已判）|

### 2.6 ⭐ `Speaker.ts` 的接口形状 —— 本单接口合同的最重要输入

旧代码**已经有** `speak`，而且不是 `speak(text)`：

```ts
// apps/voice/src/speech/Speaker.ts:139
speak(request: SpeechRequest): Promise<SpeakerResult>

// :26-33
interface SpeechRequest {
  pendingKey: string;                                  // 幂等键，同 key 并发复用同一 Promise（:159-160）
  text: string;
  confirmTimeoutMs?: number;
  waitForUserAfterMs?: number;
  onBeforeInject?: () => void;                         // ShipGateFlow 用它来 arm（:435-457）
  confirm?: (ctx: SpeechConfirmationContext) => boolean; // 调用方自定义「算不算念到了」
}

// :42-46
interface SpeakerResult {
  pendingKey: string;
  status: "confirmed" | "unconfirmed" | "failed" | "dropped";
  chunks: SpeakerChunkResult[];                        // :35-40 每段带 afterId / confirmed / confirmedById
}
```

**它没有 `kind` 枚举。** 旧代码用 `pendingKey` 的命名空间 + 自定义 `confirm` 谓词**隐式**表达类别：

| 语义类别 | pendingKey 形状 | 出处 |
|---|---|---|
| inbox 播报 | `inbox:<itemId>` | `InboxReader.ts:243` |
| ship 提问 | `ship:<itemId>:prompt` | `ShipGateFlow.ts:393` |
| ship 批准提示音 | `ship:<itemId>:approval-cue` | `ShipGateFlow.ts:430` |
| ship 卡片变化 | `ship:<itemId>:changed` | `ShipGateFlow.ts:493,512` |
| ship 拒绝叙述 | `ship:<itemId>:rejected:<transcriptId>` | `ShipGateFlow.ts:769` |

⇒ **本单把它显式化为 `kind`**（理由见 exploration §2.3 第 1 条：存活信号/复述/正文的可打断性与回执要求不同），
但 `pendingKey`、`confirm` 谓词、`onBeforeInject`、四态 `status` **全部原样保留** —— 它们都是被 PRD 条款逼出来的，不是偶然设计。

「真的念出来了」的三层确认（`Speaker.ts`）：
1. **注入层加系统前缀**（`:308`，前缀 `:4`，directive `:5-6`），chunk 切分为 wrapper 预留空间（`:7-11,:420-431`），不够在构造期抛（`:121-128`）；
2. **转写回读比对**：注入前记 `afterId = transcripts.latestId("assistant")`（`:296`），新转写进 `observe`（`:184`）必须 `sessionGen` 匹配且 `isAfter(afterId)`（`:194-203`），再交 `confirm` 谓词（`:206-212`）；默认谓词只要求「是 assistant」（`:264-267`），ShipGateFlow 传的更严（要求 `entry.text.includes(chunk)`，`ShipGateFlow.ts:396,459`）；
3. **超时 / 失败降级**：`confirmTimeoutMs` 到点判 timeout（`:483-487`）；`appendSpeech` 非 `"sent"` 或抛错 → `failed`（`:327-355`）；`invalidate()` → `dropped`（`:223-235`）；非 `Live` phase 直接 drop 并记 `speech_dropped_not_live`（`:161-167`）。


---

## 3. 盘点表 ②：Flywheel 现有通用代码已有什么

包体量（`*.ts`，去测试）：`voice-bridge` 13,343 行 · `voice-codex` 9,078 行 · `voice-core` 5,773 行 · `voice-headphone` 1,291 行。

### 3.1 房间层

> ⚠️ 两者不是同一抽象层级：① 是**一个完整的房间实现**；② 是 **package 级的一套**，其中
> `VoiceRoomRuntime.ts` 本身**只是回调路由器 + `SessionSlot`**（文件头 `:1-15` 自述：把 `/gemini` 私有的
> slot 与帧路由提升为一个共享 runtime），**不进房、不验身份、不放音**；物理连接在 CLI/wiring，耳朵在 `roomEars.ts`。

| 能力 | 实现 ①（voice-codex，**生产在跑**） | 实现 ②（voice-bridge 一套，**未加载**） |
|---|---|---|
| 进房 + 身份校验 | `voice-codex/src/discord-room.ts:189` `registry.start`；`:195` `lead_bot_identity_mismatch` 断言；`:200` `registry.join({guildId,channelId,selfMute:false,selfDeaf:false}, signal)` | **不在 `VoiceRoomRuntime`**；物理连接在 CLI/wiring（`bots/discordWiring.ts`），⛔ 无等价的 bot 身份断言 |
| 房间选项/回调合同 | `discord-room.ts:57-74` `DiscordVoiceRoomOptions{ onAudio(frame, RealtimeAudioOwner), onFounderPresence(present), onReceiveHealth, onError, assertLease }` | `VoiceRoomRuntime.ts:21-96`：消费面 `onFrame/onSpeakingStart/onSpeakingEnd/onBargeIn/onDown/onUp`，入站面 `routeFrame(frame, format)/routeSpeakingStart/…`。⚠️ **`routeFrame` 不携带说话人** |
| 收音（Opus 订阅 + 解码 + 逐说话人） | `discord-room.ts:363 startCapture`、`:347 speakingStart`、`:435 speakingEnd`、`:456 captureNoPcm`；重试梯 `:49 RECEIVE_RETRY_DELAYS_MS=[250,1000,3000]` | `roomEars.ts:42 wireRoomEars`，出 16k mono PCM（`:53-58`）；`audio/EarsReceiver.ts`（backchannel 门 350ms、barge-in holdoff 1000ms，默认值 `:69-71`）。🔴 **`roomEars.ts:53-58` 把说话人身份丢掉了** —— `routeFrame` 只收 `(frame, format)`，`userId` 只出现在 `onError`（`:62`）⇒ ②**今天满足不了本单 §4 的归属要求** |
| VAD + 上行分帧 | `discord-room.ts:153`（`UplinkSpeechGate`/silero）、`:169`（`Uplink`）；`pipeline/Uplink.ts:48`、`pipeline/SileroVad.ts` | 同上（EarsReceiver 内） |
| 放音 | `discord-room.ts:212 WaitingMouth`、`:272 playSpeech(speechId, pcm24Mono)`、`:279 cancelSpeech`、`:283 setWaiting`、`:287 setBedEnabled`；嘴本体 `audio.ts:100/:138/:173/:177` | — |
| presence（她在不在房） | `discord-room.ts:239-252` `onVoiceStateUpdate → onFounderPresence(true/false)`；`:254-260` 初始快照 | `VoiceConnSupervisor.ts:1-16`（`mode:"supervise"\|"observe"`） |
| **DAVE** | **仓内不解密** —— 解密在 `@discordjs/voice` 0.19.2 + `@snazzah/davey`。仓内有的是**诊断解析**：`voice-bridge/src/bots/discordWiring.ts:277-322`（`[NW] [DAVE] …` / `decrypt_failures` / `decrypt_reinitializing` / `Session downgraded` 正则），策略 `:159-170`（`daveEncryption`、`decryptionFailureTolerance`），版本钉 `:210`；voice-codex 经 `discord-room.ts:647 receiveDiagnostic` 消费 | 同一份（就住在 voice-bridge） |
| 收听健康状态机 | `voice-core/src/receive-health.ts:1-23`（`ReceiveState`/`ReceiveReason`，含 `"dave_decrypt"`）+ `voice-codex/src/receive-health.ts` | 无等价物 |
| 单会话互斥 | 租约 `voice-codex/src/bridge-client.ts:92 VoiceLease`、claim `:291`、renew `:322` | `SessionSlot.ts:32-67` `acquire(mode,holder)/release/current` |
| 会话生命周期 | `voice-codex/src/session.ts:89 GenericVoiceSession`、`:380 stop(outcome)`、状态 `:386-391 ready/live/interrupted/ended`；会议信号文件 `meeting-voice-signal.ts:21-28` | — |
| 健康/恢复/告警 | `voice-codex/src/health.ts:300 VoiceHealthReporter`、`recovery.ts:12 abandonVoiceJournal`、`startup-alert.ts:5 StartupRefusal` | — |
| 预约/按需启停（FLY-2701） | `packages/teamlead/src/StateStore.ts:2731-2738 VoiceScheduleState = scheduled\|prewarming\|ready\|live\|ended\|cancelled\|failed`，落库 CHECK 约束 `:10246`；Bridge 路由 `bridge/voice-schedule-routes.ts:200,:219` | — |

> ⚠️ 两套房间层**只共用 `BotRegistry`/`DiscordDeps`**（`voice-codex/src/discord-room.ts:2-7` 从 `flywheel-voice-bridge` import）。
> 选型建议见 exploration.md §3.4。

### 3.2 引擎抽象（**已存在**，覆盖 5 个引擎里的 2 个）

`packages/voice-core/src/types.ts`：

| 接口 | 行号 | 关键方法（逐字） |
|---|---|---|
| `VoiceBackend` | `:151-164` | `readonly id`（`"edge-tts"\|"gemini-live"\|"openai-realtime"\|"cosyvoice"\|(string&{})`）、`readonly capabilities`、`createAnnouncer?(opts)`、`createConversation?(opts)` |
| `VoiceBackendCapabilities` | `:56-70` | `announce`、`converse`、`bargeIn`、`toolCallScheduling`、`transcriptGranularity`、`supportsResume`、`sessionLimits`、`voiceCloning`、`audioOut`、`audioIn` |
| `AnnouncerSession` | `:178-184` | `speak(text: string, opts?: { signal?: AbortSignal }): Promise<SpeakResult>`、`interrupt()`、`close()` |
| `ConversationSession` | `:212-247` | `sendAudio(frame, format)`、`sendText(text)`、**`injectContext(text)`**、`endUserTurn()`、`interrupt()`、`injectToolResult(r, sched?)`、`on<E>(e, h): () => void`、`close(): Promise<ResumeHandle\|undefined>` |
| `ConversationEventMap` | `:186-210` | `transcript:[{role:"user"\|"assistant"; text; final; interrupted?}]`、`speech-started`、`speech-stopped`、`response-started`、`response-audio:[Buffer, AudioFormat]`、`response-done`、`response-cancelled`、`tool-call:[{callId,name,args}]`、`session-expiring:[{inSec}]`、`error:[VoiceError]` |
| `BrainAdapter` | `:249-254` | `respond(turn:{text,history}, opts:{signal}): AsyncIterable<string>` |
| `TtsEngine` | `:257-263` | `synthesize(text, voice, opts): Promise<{audio, format, ttsFirstByteMs}>` |
| `TranscriptSink` / `TranscriptEntry` | `:265-282` | `append(entry)`；entry 带 `{ts, sessionId, backendId, face:"announce"\|"converse", role, text, final, interrupted?}` |
| registry | `backends/registry.ts:27-53` | `register(id, factory)`、`has`、`ids`、`create(id)`；face/method 一致性断言 `:12-25` |

**谁实现了：**

| 引擎 | 实现 `VoiceBackend`？ | 依据 |
|---|---|---|
| Edge-TTS | ✅ announce-only | `backends/edge-tts/EdgeTtsBackend.ts:39 implements VoiceBackend`、`:45 createAnnouncer`、会话 `:69 implements AnnouncerSession` |
| Gemini Live | ✅ converse-only | `backends/gemini/GeminiLiveBackend.ts:93 implements VoiceBackend`、`:100 createConversation`、capabilities 由钉住的 model 推导 `:132-152`、会话 `:154 implements ConversationSession` |
| **OpenAI realtime（今天的引擎 A）** | ❌ | `voice-codex/src/realtime.ts:221 export class RealtimeFrontend` —— **没有 `implements`**；自有 options/callback 合同 `:20-55`，被本地结构型 `FrontendLike`（`session.ts:34-40`）消费。voice-codex 只从 voice-core import `ReceiveHealth` 与 `scrubTranscript`，**零 `VoiceBackend`/registry 使用** |
| **Codex realtime（引擎 B）** | ❌ 不存在实现 | Flywheel 本仓无 Codex realtime 客户端；只有 Lead 文字侧的 `packages/teamlead/src/lead-backends/codex/CodexLeadProcess.ts:166-292` |
| ElevenLabs | ❌ | `voice-bridge/src/eleven/ElevenSession.ts:185`（无 `implements`）；WS 面只有 `ElevenWsLike{ sendAudio(frame16k); flushAudio(); close() }`（`:40-44`，实现 `ElevenWs.ts:226/235/246`） |
| 常驻 Claude 脑 | ⚠️ 只实现 `BrainAdapter` | `voice-core/src/brain/ResidentClaudeBrain.ts:207`、`HeadlessClaudeBrain.ts:63` —— 是「想」，不是「嘴」 |

`factory.ts:102-116 buildRegistry` **只注册 edge-tts 与（有条件的）gemini-live**。
⚠️ `voice-codex/src/adapters.ts` 名字虽叫 adapters，**不是引擎抽象** —— 是 `DiscordMirrorClient`（`:4`）+ `FlywheelCommDelivery`（`:89`）。

### 3.3 「说一段指定文字」的现有五条路

| # | 机制 | 签名（file:line） | 绑哪个引擎 | 有逐字保证？ |
|---|---|---|---|---|
| 1 | Edge-TTS announcer | `voice-core/src/types.ts:181 speak(text, opts?)`；实现 `backends/edge-tts/EdgeTtsBackend.ts:69` | edge-tts | 是（真 TTS） |
| 2 | `LeadSpeaker`（会议嘴，串行队列） | `voice-bridge/src/audio/LeadSpeaker.ts:126 speak(source: SpeakSource): Promise<LeadSpeakerResult>`；`SpeakSource` `:28-31` = `{kind:"file",path}\|{kind:"audio",audio}\|{kind:"text",text}`；`:140 stop()` 同步 barge-in | text 分支需注入 `TtsEngine`（`:56`）⇒ edge-tts；file/audio 分支无引擎 | 是 |
| 3 | `TextTurnMouth`（流式文本 → 断句 → 出声） | `voice-bridge/src/audio/TextTurnMouth.ts:22-28 TextTurnSpeaker{ speak(text): Promise<{cancelled}>; stop() }`；嘴 `:70`；断句 `:52 splitSentences(buf, maxChars)` | 常驻 Claude 脑 + edge-tts | 是 |
| 4 | **OpenAI Realtime 逐字朗读**（⚠️ **legacy / 今天生产在跑的那条**，不是 founder 新定的 `gpt-live-1`；作为**规则资产**移植） | `voice-codex/src/realtime.ts:349 async appendSpeech(speech: PreparedSpeech)` → `response.create`，`instructions: "Read the following text aloud, verbatim, with no additions…"`（`:381-383`）；切段 `voice-codex/src/speech.ts:174 prepareReplySpeech(rawText, configuredMax = 80)`；**回读校验** `speech.ts:167 isFiniteSpeechEquivalent(expected, actual)`，在 `realtime.ts:1017-1019` 强制；会话级入口 `voice-codex/src/session.ts:349 async speak(speech: PreparedSpeech): Promise<SpeechReceipt>` | OpenAI realtime | **逐字：是，带回读校验** —— 全仓唯一。⚠️ **回执语义见下方红框** |
| 5 | Gemini 控制提示（**转述，不是逐字**） | `ConversationSession.sendText(text)`（`types.ts:222`）；调用点 `assistant/AssistantSession.ts:301`（开场）、`:435`（收尾），提示词 `:116-120`；会议 `huddle/HuddleSession.ts:1105 speakThrough(line, prompt)` → `:1119 line.session.sendText(prompt)` | gemini-live | **否** |
| — | `AssistantSpeaker` | `assistant/AssistantSpeaker.ts:55/64/99/109 beginTurn()/feed(chunk)/endTurn()/flush()`、`:120 noteToolCall()` | 只吃模型 PCM（24k mono）；能放预合成片段 `:141 playClip`，**不能说任意字符串** | — |
| — | **ElevenLabs** | **没有任何「说这段字」的路** —— `ElevenWs.ts:226/235/246` 只有 `sendAudio`/`flushAudio`/`close` | — | — |

> ⭐ **第 4 条 = 本单 `speak` 合同最接近的现成实现**（⚠️ 它属于 **legacy OpenAI Realtime**；
> founder 2026-09-23 06:17Z 已把引擎 A 定为 `gpt-live-1`，⇒ 这里能带走的是**规则**，不是那条链路）：
> 它已经有「逐字指令 + 切段 + 回读校验 + 三态回执」。
> ⛔ **但更正本单先前的写法「只需加 `kind` 和接口壳」** —— `RealtimeFrontend`（`realtime.ts:221`）既不是
> `VoiceBackend` factory（无 `createConversation`）也不满足 `ConversationSession`（无 `sessionId`、
> 无 `sendAudio`/`sendText`/`injectContext`/`endUserTurn`/`on`/`close`），今天喂它的 `FrontendLike`
> （`session.ts:34-40`）是另一种 lifecycle。⇒ V4 的范围是 **backend factory + session adapter**，见 plan.md。

> ### 🔴 `SpeechReceipt` 的真实语义（本单先前写错过，这里是更正）
>
> - **只有三态**：`type SpeechReceipt = "confirmed" | "unconfirmed" | "failed"`（`voice-codex/src/session.ts:87`）。
>   **没有 `dropped`。** 非 live / 忙 / 正在停止时返回的是 `"failed"`（`session.ts:349-351`）。
>   （`"dropped"` 存在于另一处：daemon 对「没有可朗读内容」的出站聚合回执，`daemon.ts:894-918`，不是 `session.speak` 的状态。）
> - **`confirmed` ≠ 她听见了。** 它在 `room.playSpeech(...)` 的 Promise resolve 之后置位
>   （`session.ts:457-466`），证据名就叫 **`realtime_playback_submitted`** ——
>   含义是**本地 PCM 已提交给播放器**。它不证明 Discord 远端交付，更不证明人耳。
> - Raya 旧 `Speaker` 的 `confirmed`（四态，`Speaker.ts:42-46`）语义又不同：它是**转写回读比对通过**，
>   只证明**模型生成了预期文字**，同样不证明音频到达；`audibleTail`（`Downlink.ts:121-130`）是**估算**的播放尾部。
>
> ⇒ §4 的 `speak` 合同据此改写为**可观测阶段**，⛔ 不设任何名为「她听见了」的状态。

### 3.4 「她说了什么」的上行 —— 今天有**四种互不兼容的形状**

| 来源 | 形状 | file:line |
|---|---|---|
| voice-core 规范事件 | `transcript: [{role:"user"\|"assistant"; text; final; interrupted?}]` + 8 个同族事件 | `voice-core/src/types.ts:186-210`；订阅 `:241-244`；emitter `emitter.ts:5` |
| voice-codex | `onTranscript({ itemId, contentIndex, text, ownerUserId, speakerName, utteranceId })` | `voice-codex/src/realtime.ts:38-45`，镜像在 `session.ts:338-345 FrontendHandlers`；处理 `session.ts:400`，语音口令拦截 `:409-419`（`退出语音模式`、`等待音关掉/打开`），然后 `:421 delivery.capture({transcriptId, speakerUserId, speakerName, rawText, ts})` |
| ElevenLabs | `ElevenWsHandlers{ onAudio, onInterruption, onUserTranscript?(text), onAgentResponse?(text), onMetadata?, onError, onClose? }` | `eleven/ElevenSession.ts:47-52` |
| 耳机 | `TurnEvent` 里的 `{ type:"utterance"; text }` | `voice-core/src/headphone/turn-machine.ts:69-77` |
| 持久留痕 | `TranscriptSink{ append(entry) }`；`TranscriptEntry{ts, sessionId, backendId, face, role, text, final, interrupted?}`；实现 `transcript.ts:35 JsonlTranscriptSink`、`:75 MemoryTranscriptSink` | `voice-core/src/types.ts:265-282` |
| 说话人归属 | `voice-codex/src/speaker-attribution.ts:17 class SpeakerAttribution`；消费点 `discord-room.ts:267 speaker()`、`pipeline/Uplink.ts:21-24 UplinkFrameMetadata{ownerUserId, utteranceId}` | —— ⚠️ 归不上的整句被丢弃（FLY-2786 实测 03:07:11–16 那段） |

🔴 **一个必须写明的 schema 缺口**：`ConversationEventMap.transcript`（`types.ts:186-210`）与
`TranscriptEntry`（`:272-282`）**都没有** `transcriptId` / `utteranceId` / 说话人归属字段。
⇒ 「同一份 utterance 写进 `TranscriptSink`」**今天按现有 schema 落不了地**；
V1 合同必须把这两个类型的扩展列为显式改造项（见 §4.1 ②），⛔ 不能当成现成能力。

⚠️ 另一处语义差：`ConversationSession.injectContext`（`types.ts:223-231`）是**运行中的静默上下文喂食**，
注释明写「**必须永不触发出声**」且「**不写进 transcript sink**（这是纪要，不是新对话）」。
⇒ 它**不是** `sessionContext`（开场注入）的同义词，§4.1 ⑤ 把两者拆开。

⇒ **V1 合同取 `voice-core` 的 `ConversationEventMap.transcript` 为规范形状**，另加 voice-codex 已有的
`ownerUserId`/`utteranceId`（说话人归属是 PRD §5.7 用嘴批的前提，不能丢）—— 但这需要**扩类型**，不是直接用。

### 3.5 模式层现状（逐能力）

**耳机模式**（规则层在 `voice-core/src/headphone/`，**引擎无关**；音频面在 `voice-headphone/`，**只有桌面 dry-run**）

| 能力 | 有没有 | 位置 | 引擎绑定 |
|---|---|---|---|
| 进来播报 | ⚠️ **没有开场播报** | 开模式只是开始拉队列：`voice-headphone/src/daemon-core.ts:149-153`（`芝麻开门` → `handleEvent({type:"start"})`）→ `voice-core/src/headphone/turn-machine.ts:230-236` → `:258 nextItem()`。**presence 恢复**那条是真的：`:225 case "presence"`，宽限恢复 `:614-670` 按 `itemPhase` 重播 | 无关 |
| 新消息主动念 | ✅ | `turn-machine.ts:228 queue_pushed` → `:276 announce(item)`（长正文走两级摘要 `:279-287`）；队列 `headphone/queue.ts:10` | 无关（声音来自 `HeadphoneIO.speak`） |
| 存活信号 | ⚠️ **耳机侧没有** | 等待音床只在 voice-codex 房：`voice-codex/src/audio.ts:100 WaitingMouth`、`:173 setWaiting`、`:177 setBedEnabled`（music-box B 床 `:51`），语音口令切换 `session.ts:415-418`。voice-bridge 侧只有提示音 `audio/defaultCues.ts:73-92` 与 TIV 状态行 `huddle/huddleTiv.ts`。日志级心跳 `voice-codex/src/health.ts:494-496` | 床绑 voice-codex 房 |
| 筛选 | ✅（静态） | `voice-core/src/headphone/tap-filter.ts:33 shouldEnqueue(msg: TapMessage, cfg: TapConfig): boolean`，配置 `:20-32`，scope 从 Bridge 取 `voice-headphone/src/bridge-client.ts:94 getScope()` | 无关（纯谓词）。⚠️ 缺 PRD §5.3 的「学」那半边 |
| 用嘴批 | ✅ | 词表 `headphone/phrases.ts:31-36 APPROVE_INTENT`；阶梯 `turn-machine.ts:21-30`（readback → `awaiting_approval_confirm` → **receipt-first** → submit，沉默不算同意）；IO `:87-95 postReceipt(item, transcript)` + `submitApproval(item, transcript, receiptMessageId)`；HTTP `voice-headphone/src/bridge-client.ts:136 postShipApproval(body)`，请求体 `:46-57`，结果 `:60-67` | 无关 |
| 退出 | ✅ | 主路径＝离开语音房 `turn-machine.ts:39` + `:583-588 onModeOff({processed, remaining, reason:"vc_exit"\|"spoken_exit"})`；口令 `phrases.ts:15 STOP_WORD=["芝麻关门"]` → confirm_exit；收尾摘要以文字发出 `voice-headphone/src/daemon.ts:180-190` | 无关 |
| **音频面** | ❌ **只有 dry-run** | 唯一 `HeadphoneIO` 实现 `voice-headphone/src/null-audio-io.ts:55 NullAudioIO implements HeadphoneIO`，经 edge-tts 念到 Mac 扬声器（`local-announcer.ts:13-22`，`daemon.ts:129`）；文件头 `:1-7` 自己写着 VC 音频产品路径**未实现**。逐 agent 音色 `headphone/voice-directory.ts:8 VoiceDirectory.resolve(agentId)` | edge-tts + 桌面 |

**会议模式**（在 `voice-bridge/src/huddle/`，**控制口绑 gemini**）

| 能力 | 有没有 | 位置 | 引擎绑定 |
|---|---|---|---|
| 起会 | ✅ ×3 | `/glaw` `huddle/GlawCommand.ts:1-16`（解析 @Leads → host、开立项 issue、Join-link 按钮、@ping、MOVE_MEMBERS）；`/gemini` `assistant/GeminiCommand.ts:1-12`；装配 `huddle/wireMeeting.ts:1-10`，会话启动 `huddle/HuddleSession.ts:221` | Discord 通用；但 `wireMeeting.ts:14-25` 写死用 `TalkSessionRotator` + `GeminiTurnMouth` 造 Gemini 会话 |
| 会议上下文 | ✅ ×2 | 静默扇入 `huddle/FeedPipeline.ts:1-26`，注入接缝 `:39`（`ConversationSession.injectContext`），`:99 transcriptSnapshot`；预生成简报 `assistant/BriefingEngine.ts:1-12`、`:23-31 BriefingConfig`，作为 `systemPreamble` 注入（`voice-core/src/types.ts:126`） | `injectContext` 是 `ConversationSession` 的方法 ⇒ 实际只有 gemini 有 |
| 带节奏 | ✅ | 黏性寻址 `huddle/AddressRouter.ts:1-17`；发言权 `HuddleSession.ts:1211 grantTo(leadId)`，未授权者被打断 `:1124 interruptLine`；barge-in `:312 handleBargeIn`；思考看门狗 `:383 armThinkingWatchdog`（口头提示 `:389-393`）；host 提示 `:303 promptHost(text)`；动作分级 `huddle/ConfirmationLadder.ts:1-21`（tier c **结构上就没有执行路径**） | 逻辑多数无关；但 `speakThrough` 在 `:1119` 分叉到 `sendText`（gemini）或常驻驱动 `huddle/ResidentLineDriver.ts:1-22` |
| 结束 | ✅ | `HuddleSession.ts:984 startConcluding()` → 控制提示 `:989`；`/gemini` `assistant/AssistantSession.ts:435`（`RECAP_PROMPT` `:118`）、确认 `:444`；拆场 `HuddleSession.ts:1061` | 控制提示走 `sendText` ⇒ 绑 gemini |
| 纪要 | ✅ ×3 | `/glaw` `huddle/ConclusionPipeline.ts:96 land(input): Promise<LandOutcome>`（顺序：总结评论 → worktree → Done → TIV 卡；marker `:75`）；常驻变体 `huddle/residentMinutes.ts:12-24` + 原始 journal 兜底 `:24`；`/gemini`+`/eleven` `assistant/AssistantLanding.ts:1-16`（总结 → 逐字转写分块 → 收尾，回执幂等），持久重试 `eleven/landing.ts:1-16` | `summarize` 是注入的 `(journalSnapshot) => Promise<string>`（`ConclusionPipeline.ts:53`）⇒ **无关** |
| **voice-codex 侧的会议** | ❌ 无逻辑 | `voice-codex/src/meeting-voice-signal.ts:21-28` 只是一个状态文件合同 `MeetingVoiceSignal{schemaVersion, meetingId, state, at, bootId, reason?}` | — |

⚠️ 已退役：`assistant/advanced.ts:19-24 buildAdvancedDelegateTool` 现在直接抛（FLY-2105）。

#### 🔴 会议模式「已有」≠「已满足 PRD FLY-1851」—— 未覆盖清单

上表证明的是**即时起会 + 会中编排 + 会后 landing 三段有代码**，⛔ **不等于产品闭环已成立**。
逐条对 PRD，以下**没有**实现：

| PRD 条款 | 要求 | 现状 |
|---|---|---|
| R-4 / R-5 / R-6 / R-8 / R-10 | 提前**安排**会议；到点各自进房；**只有她没进来时**提醒她一嘴；提醒**必须带 link**；link 是主路径 | huddle 只有**即时** `/glaw`、`/gemini` 起会。预约侧另有 FLY-2701 的 `voice_schedules`，但**两者没有接起来** |
| R-2b | 预约时长 | 无 |
| R-22 / R-23 / R-27 | 会后一份**可互动 HTML**（讨论总结 + action items）；**action items 逐条互动**；复用现有卡片形状 | landing 只产出 **Linear 评论 + worktree**（`ConclusionPipeline.ts:96+`）与逐字转写分块（`AssistantLanding.ts`），**没有互动 HTML，没有逐条互动** |
| R-24 | 她逐条答完 → **这条 issue 才算结** | 🔴 **冲突**：`ConclusionPipeline.ts:1-15` 的落地合同是「summary comment → worktree → **Done** → TIV 卡，**Done 是最后一步**」——它在**会议一结束**就把立项 issue 置 Done，早于她逐条批 action items |
| R-25 | notes + 最终 action items **ship 进 repo 归档** | 只 create worktree（`:28-39`），无归档/合入闭环 |
| R-21（§41 修订后） | note taker **不在场、会后读转写** | 现有 landing 是**会中脑**顺手总结（`ReadOnlyLeadBrain` / resident），不是「会后读转写的 runner」 |

⇒ **plan.md 的 V3 据此改写**：不写「已有完整一套，纪要不动」，改为逐条 capability 清单 + 明确 defer；
⛔ 且**不得**把会提前 Done 的 landing 当作 R-24 的合规实现。

⚠️ 另一条范围提醒：PRD FLY-1851 的 V1 是**单 AI 一场会**。huddle 整套带多 Lead 的
发言权/黏性寻址（`AddressRouter.ts`、`grantTo`、`interruptLine`）⇒ V3 应**抽取其中引擎无关的策略**，
⛔ 不是默认把整套多 Lead 编排当模式层基底。

### 3.6 handoff 到 Lead —— 今天四种形状，没有共同合同

| # | 路径 | 关键调用 |
|---|---|---|
| 1 | **voice-codex：听到的话 → Lead 邮箱**（两跳） | `session.ts:421` → `delivery.ts:72 capture(input: CapturedTranscript)`（类型 `:12-18`，scrub + 1800 字截断 `:73-75`，journal `:83`，`:91 deliver(pending)`）。跳 1 镜像进 thread：`adapters.ts:17 post(channelId, text, nonce): Promise<{messageId}>`（`enforce_nonce:true`、`allowed_mentions:{parse:[]}`）。跳 2 进队列：`adapters.ts:103 ingest({leadId, voiceSessionId, threadId, messageId, authorId, authorName, text, ts}): Promise<{lane, deliveryId}>` —— 起子进程 `flywheel comm chat-ingest --origin voice --content-stdin`（`:107-146`），lane 枚举 `delivery.ts:5-11`；回读 `adapters.ts:163 read(deliveryId)` |
| 2 | **voice-codex：Lead 回复 → 出声**（回程） | `bridge-client.ts:438 outbound`、`:456 claimOutbound(sessionId, seq, leaseToken, lease)`、`:476 receipt(…, status)`；驱动循环 `daemon.ts:894-931`（`prepareReplySpeech` → `session.speak` → `receipt(status)`，status ∈ `confirmed\|unconfirmed\|failed\|dropped`） |
| 3 | **耳机：口头批准 → Bridge → gate** | `turn-machine.ts:87-95`（`postReceipt` **先于** `submitApproval`，receipt-first 是硬闸）→ `null-audio-io.ts:117` → `bridge-client.ts:136 postShipApproval(body)` → `POST /api/voice/ship-approval`，body `{gateMessageId, questionId, prHeadSha, transcript:{id,text,atMs,founderUserId}, receiptMessageId}`（`:46-57`），结果 `:60-67`。口述回复走 Discord 文字：`turn-machine.ts:83 sendReply(item, text)` → `null-audio-io.ts:67` |
| 4 | **会议：意图 → Linear 产物（只在会后）** | `huddle/ConclusionPipeline.ts:96 land({issue, confirmed, journalSnapshot, transcriptPath?})` → `ConclusionLinear.comment/​setStatus(issueId,"Done")`（`:19-27`）+ `ConclusionWorktree.create(...)`（`:28-39`） |

⛔ **会中没有实时派发**：`ConclusionPipeline.ts:13-16` 注释写明「no live dispatching mid-meeting …
Per-Lead thread fan-out is a **seam (`dispatchActionItems`) the wiring may extend later**」。
全仓 grep：`dispatchActionItems` **只出现在那条注释里，没有对应代码**。
会中唯一的实时动作是**只读工具**：`assistant/tools.ts:35 buildAssistantTools(deps): LiveToolSpec[]` → `lookup_issue`（`:43`）、`board_snapshot`（`:92`）；
会议脑结构上只读：`huddle/ReadOnlyLeadBrain.ts:17-21 READ_ONLY_TOOL_ARGS = ["--tools","Read,Grep,Glob","--strict-mcp-config"]`。

### 3.7 现有代码的十一个缺口（本单据以定 V2–V6 范围）

1. 引擎抽象**不覆盖** Codex realtime、OpenAI realtime、ElevenLabs（`factory.ts:102-116` 只注册两个）。
2. **没有跨引擎的「说这段字」能力**：逐字 + 校验只有 OpenAI realtime 一条（`realtime.ts:381`，校验 `:1017`）；ElevenLabs 一条都没有。
3. **没有共同的转写事件总线**（四种形状，§3.4）。
4. **两套独立房间层**，只共用 `BotRegistry`/`DiscordDeps`。
5. **耳机模式没有语音房音频面**（只有桌面 dry-run，`null-audio-io.ts:1-7`）。
6. **耳机开模式没有进来播报**；**耳机/bridge 两栈都没有存活信号**（等待音床只在 voice-codex 房）。
7. **会议没有会中的逐 Lead 实时派发**（`dispatchActionItems` 是注释不是代码）。
8. **转写事件与留痕 schema 缺字段**：`ConversationEventMap.transcript`（`types.ts:186-210`）与 `TranscriptEntry`（`:272-282`）**都没有** `transcriptId` / `utteranceId` / 说话人归属 ⇒ §4.1 ② 的合同今天落不了地。
9. **两套房间层都没有暴露 `audibleTail`（估算）** ⇒ ship arming 与 readback grace 窗在 Flywheel 侧目前无实现基础（Raya `Downlink.ts:121-130` 是形状参考）。
10. **没有通用的 `handoffToLead` 载体**：只有整句邮箱投递（`adapters.ts:103`）与 ship 专用 mutation（`voice-headphone/src/bridge-client.ts:136`）两条专用路。
11. **会议模式未覆盖 PRD FLY-1851 的预约/提醒/互动 HTML/逐条 action item/归档五段**，且现有 landing **会在她批 action items 之前就把 issue 置 Done**（见 §3.5 红框）。

---

## 4. 接口合同（一页）

> 口径：**`speak` / `onUtterance` / `injectContext` / 会话起止＝扩 `packages/voice-core/src/types.ts`
> 已有的 `VoiceBackend` / `ConversationSession`，不新建一套。**
> ⛔ **`handoffToLead` 是例外** —— 今天只有整句邮箱投递与 ship 专用 mutation 两条专用路，
> 通用的 request/receipt carrier **要新建**（§4.1 ③、§4.4），引擎 A 的 Live delegation **也不是**它。
> 下面写的是 V1 定稿的**语义合同**；确切的 TypeScript 由 V4/V5 落，本单不写实现代码。
>
> 🔴 **一条贯穿全文的纪律**：合同里**不许出现任何名为「她听见了」的状态**。
> 今天全栈能观测到的最远一档是「**本地 PCM 已 submitted 给播放器**」（§3.3 红框、§4.1 ①）——
> ⛔ **连「本地播放队列已排空」都还不是**：`audio.ts:216-228` 写完最后一帧就 resolve，不等 drain。
> 播放尾部只有 `audibleTail()` 的**估算**。再往外是未验证格。

### 4.1 五项合同

```
模式层  ──speak / onUtterance / initialSessionContext+injectContext / 会话起止──▶  VoiceEngine（A / B 适配器）
   │                                                                                    │
   └────────────────── handoffToLead(intent) ──────────────▶ Lead 本体（现有 comm 通路）   │
                                                                                        │
                        RoomIO（带说话人的收音帧 / 放音+取消 / presence / 健康 / audibleTail 估算 / lease）
```

#### ① `speak(text, kind, opts) → SpeakReceipt`

| 项 | 合同 |
|---|---|
| `kind` | `"brief"`（正文播报）· `"question"`（要她决定）· `"readback"`（动手前念专名编号）· `"heartbeat"`（存活信号）· `"cue"`（提示，如 ship arming 那句）· `"control"`（**不要求逐字**，只给引擎意图） |
| 幂等 + **请求绑定** | 必须带 `pendingKey` **和** `requestDigest = hash(sessionId, sessionGeneration, text, kind, verification, 影响内容的 voice/format 字段)`。<br>· 同 key **且**同 digest ⇒ 复用同一 Promise；<br>· 同 key **不同** digest ⇒ **必须返回 `{outcome:"rejected", reason:"pending_key_conflict"}`**。<br>🔴 **更正**：Raya `Speaker.ts:159-160@f669d1b` 只按 key 返回已有 Promise、**不比较 `text`** ⇒ 照搬会让第二个调用（不同文本/不同 `verification`）拿到第一个调用的正向 proof，**arm 发现不了它根本没被念出来**。<br>· `SpeakReceipt` **必须回带 `pendingKey` 与 `requestDigest`**；arm 时与本次待授权动作的**期望 digest 等值比较** |
| **回执＝ discriminated union，⛔ 不是字段的笛卡尔积** | `SpeakReceipt = { pendingKey; requestDigest } & R`，其中 `R` 是下面三选一：<br>① `{ outcome:"rejected"; reason; transport:"none"; contentProof:"none" }`<br>② `{ outcome:"failed"; transport:"none"\|"submitted"; contentProof:"none"\|"deterministic_tts"\|"transcript_equivalent" }`<br>③ `{ outcome:"completed"; transport:"submitted"\|"playback_drained"; contentProof:"none"\|"deterministic_tts"\|"transcript_equivalent" }`<br>🔴 **更正**：先前写「三个正交必填字段」并称「不可构造非法组合」是**错的** —— 笛卡尔积仍能构造出 `{rejected, playback_drained, transcript_equivalent}` 这种荒谬值 ⇒ 改成 union。<br>· `rejected` = 前置不满足（非 live / 忙 / 停止中）⇒ 必然 `{none, none}`，**一个字都没送出去**<br>· **`verification:"required"` 却拿不到 proof ⇒ 必须以 `outcome:"failed"` 终结**，⛔ 不许 `completed`<br>· **失败时 `transport` / `contentProof` 照样保留** —— 「已 submitted 之后超时」与「压根没送出去」必须可区分（这正是今天 `session.ts:349-351` 把两者折成同一个 `failed` 的问题）<br>· `transport` 只表示**搬运走到哪**、`contentProof` 只表示**内容被证明到什么程度**，两者**互不蕴含** ——「没经过内容校验但已送出」是合法组合，而它**过不了 arm**<br>· **三个字段都必填** —— ⛔ 不做可选：可选字段会让 `!== "none"` 这类负向检查在缺字段时恒为真，安全闸就被绕过了 |
| `contentProof` 的两个正值 | `deterministic_tts` —— 真 TTS，生成即确定（edge-tts 这类）<br>`transcript_equivalent` —— LLM 回读比对（A：`speech.ts:167 isFiniteSpeechEquivalent`，强制点 `realtime.ts:1017-1019`；Raya：`Speaker.ts:296,:206-212`）<br>⚠️ 原名 `generated_verbatim` 已弃用 —— 它把真 TTS 排除在外了 |
| `transport: "submitted"` vs `"playback_drained"` | 🔴 **更正本单先前的说法** —— 今天的 `confirmed`（`session.ts:457-466`）**不是 drain**：`WaitingMouth`（`packages/voice-codex/src/audio.ts:216-228`）把最后一帧 `stream.write()` 进 `PassThrough` 之后就 resolve；即使 `write()` 返回 `false`，它只是置 `writeBlocked` 并挂一个 `once("drain")` 回调，**同一 tick 仍然 resolve**，既没等 stream drain，也没等播放器消费。证据名 `realtime_playback_submitted` 正好说的就是 **submitted**。<br>⇒ `playback_drained` **只有在 RoomIO 对输出 sink / 尾部提供了单独可等待的证明之后才允许产生**；在那之前，A 的最高档是 `submitted` |
| 🔴 **没有第四个 transport 值** | 「Discord 远端已交付」「她听见了」**都不可观测**，⛔ 合同不设这两档，任何文档也不许这样描述上面任何一档 |
| 与今天的差 | A 今天是 `"confirmed"\|"unconfirmed"\|"failed"` 三态（`session.ts:87`）。映射：<br>`confirmed → {completed, **submitted**, transcript_equivalent}` —— ⚠️ **不是 `playback_drained`**，理由见上一行<br>`unconfirmed → {failed, submitted, none}` —— ⚠️ **更正**：它来自 **speech timeout**（`session.ts:473-490`，状态行就是「📻 这段未朗读，请看文字」）⇒ **不是 completed**<br>`failed → {failed, ?, none}`<br>`rejected` 今天被并进 `failed`（`session.ts:349-351`）⇒ **V4 要拆出来** |
| **逐字要求＝逐次调用的 `verification` 参数，⛔ 不从 `kind` 推导** | `speak(text, kind, { verification })`，`verification ∈ "required" \| "best_effort" \| "none"`：<br>· `required` —— 必须拿到 `contentProof ∈ {deterministic_tts, transcript_equivalent}`，否则该动作 fail closed<br>· `best_effort` —— 尽量校验，拿不到照样出声，但**不得**作为任何副作用的依据<br>· `none` —— 不校验（`control` 用）<br>**默认值按 `kind`**：`readback`/`question`/`cue` ⇒ `required`；`heartbeat` ⇒ `none`；`control` ⇒ `none`；`brief` ⇒ `best_effort`<br>⚠️ **`brief` 的默认可被逐次覆盖** —— 进来播报要 ack `spoken` 那一路必须显式传 `required`（承 Raya `InboxReader.ts:263-272`「只有确认才 ack」）。这消掉了「`kind` 一刀切」与 §4.3 的矛盾 |
| ship / readback 的 arm 条件（**唯一权威谓词**） | ```receipt.outcome === "completed"
&& (receipt.contentProof === "deterministic_tts" || receipt.contentProof === "transcript_equivalent")
&& receipt.pendingKey === expectedPendingKey
&& receipt.requestDigest === expectedDigest
&& roomIO.audibleTail().drained === true```<br>🔴 **`expectedPendingKey` / `expectedDigest` 必须由当前待授权动作独立重算**，⛔ 不许信 receipt 自报；若同一段朗读文案可能对应不同 `authorityBinding`，**期望 key/digest 也要绑该动作身份**（否则同文案、另一个动作的 receipt 能过闸）。<br>🔴 **⛔ 谓词里不放 `transport`** —— 今天最高只能到 `submitted`（见上两行），把 `playback_drained` 写进谓词会让 legacy A **永远 arm 不了**，下游为了过闸就会把 `playSpeech()` 的 resolve 再冒充成 drain（那正是 R4 改掉的错）。播放侧只由 `audibleTail()` 的**估算**把关；将来 RoomIO 真能给出独立 drain 证明时，它是**更强证据**，⛔ 不是今天的必需值。<br>⚠️ **正向枚举 `contentProof`，⛔ 不用 `!== "none"` 的负向检查**（负向检查在字段缺失时会放行）<br>⛔ 不许写成「她已听见」；⚠️ `audibleTail` 是**估算**（estimate），这三个字每次提及都要带 |

**A 怎么实现**（⚠️ founder 2026-09-23 06:17Z 定了「用 GPT Live」，A 的前台换成 `gpt-live-1`）：
`session.commentary.append` 的文字**能触发开口**（FLY-2799 `gpt-live-handoff.md`＠`15fe2c875`「给 FLY-2798 用」，单场实测）。
⇒ A 的 `speak` 走这条，**不是**今天生产那条 `response.create`（`voice-codex/src/realtime.ts:349,:381-383`）。
⚠️ 今天生产在跑的是**直连 OpenAI Realtime**（`create_response:false`，FLY-2655 裁定）；
`realtime.ts` 那套「逐字 instructions + 切段 + 回读校验 + 三态回执」是**形状与规则的现成资产**，
但 `contentProof` 在 Live 上**要重新取证**（Live 那一场没有做逐字保真校验）。
**B 怎么实现**：`thread/realtime/appendSpeech` 承 `kind ≠ "control"`；`kind === "control"` 的映射
**是 V5 的待验项**（`appendText` 不触发 response，§1.1）。
⇒ **B 的 `capabilities.verbatim` 在 V5 给出「每一次都有可检出的逐句 proof」之前只能是 `false`。**
⚠️ 纪律：`verbatim:true` 的含义是**逐 utterance 可证明、失败可检出**，
⛔ **不是「抽样 n 次里有多少次对」** —— 比例只说明可用性，不能把一个安全 capability 置 true。

#### ② `onUtterance(u: Utterance)`

| 项 | 合同 |
|---|---|
| 分工 | **引擎只发规范转写事件；意图识别在模式层。**（换引擎不该影响「芝麻关门」「确认/不批」认不认得；既有做法见 `voice-core/src/headphone/phrases.ts`） |
| 基底 | `ConversationEventMap.transcript`（`types.ts:186-210`）的 `{role, text, final, interrupted?}` |
| **必须扩的字段** | `sessionId`、稳定的 `utteranceId` 与 `transcriptId`、时间戳、顺序/去重键、来源。🔴 这些**今天不在** `ConversationEventMap` / `TranscriptEntry`（`types.ts:272-282`）里 ⇒ V4 的显式改造项，⛔ 不是现成能力 |
| **归属＝可判别 union** | `attribution: { kind:"known"; speakerUserId: string } \| { kind:"unknown"; reason: string }`。<br>⛔ 引擎**不得**自行丢弃 `unknown` 的整句（今天 `realtime.ts:739-761` 会丢，2026-09-23 03:05Z 实测吃掉她一段约 5 秒的话）<br>⛔ `kind==="unknown"` 时**禁止**任何有副作用的动作（批 ship、开单、改配置）—— fail closed |
| 副作用门 | 只有 **`final` + `attribution.kind==="known"` 且 `speakerUserId ∈ founderUserIds` + 已取得可等待的持久化回执**的 user utterance 才能作为副作用依据。⚠️ 最后一项**今天拿不到**（`TranscriptSink.append` 返回 `void`，JSONL 实现吞写错，见 §4.4）⇒ 它是显式改造项，⛔ 不是形容词 |
| 留痕 | 同一份 utterance 必须写进 `TranscriptSink`（`types.ts:265-282`），schema 对 A/B 一致，并定义 `flush` 语义 —— **纪要（PRD FLY-1851 §41 会后读转写）只依赖这一条** |
| ⚠️ 不是同一件事 | `injectContext`（`types.ts:223-231`）**明确不写 transcript sink**，它不产生 utterance |

**A（`gpt-live-1`）**：🔴 **归属未验，未声明前 fail closed**。`realtime.ts:38-45` 的 `ownerUserId`/`utteranceId` 属于 **legacy Realtime**，只能当**形状参考**；新 A 要靠 RoomIO 的说话事件与 Live 事件关联后才能声明。去掉丢弃行为（K3）照旧要做。
**B**：Codex realtime 的 `transcript/*`（Raya `RealtimeTransport.ts:333-356`）**不带 ownerUserId** ⇒ B 必须由 RoomIO 的说话事件补归属，否则 `attribution` 恒为 `unknown`，用嘴批在 B 上 fail closed（V5 B-3）。

#### ③ `handoffToLead(intent) → HandoffReceipt`

| 项 | 合同 |
|---|---|
| 什么进 | **只有「要动手的事」**：开单 / 批 ship / 改优先级 / 派 Runner。⛔ 不是「她说的每一句话」 |
| 什么不进 | 闲聊、问答、确认、筛选偏好（「这个不用告诉我」）—— 引擎自己答、模式层自己记 |
| 异步 | **允许慢** —— 不在「她说完 → 听到第一个字」的关键路径上 |
| 请求形状 | `{ intentKind, payload, sessionId, transcriptId, 原话, idempotencyKey, authorityBinding }` |
| 回执形状 | **只有一个** `HandoffReceipt`，形状与 state enum 以 §4.4 为准：`{ handoffId, state, idempotencyKey, requestDigest, reason? }`，`state` 取 §4.4 的状态机取值。⛔ **不要第二套 `{status:"accepted"\|…}`**（本单先前写过，已废）。⛔ 不许把 `ambiguous` 折叠成 `failed`，**也不许把它当终局** |
| **溯源（逐 intent 类别定，⛔ 不一刀切）** | 更正本单先前的引用：Raya `OutboxWatcher.ts:250-268` **只是 filter scope grounding**，不是通用规则。真正的通用归属解析在 **`:444-460`**（`resolveFounderUtterances`；解析不出时按 `unattributed` / `utterance_not_found` 拒绝），引文核对在 **`:477-490`**（`quotes` + `extractIdentifierTokens`，不匹配则 `quote_not_in_transcript`），filter 专用的 quote+scope 在 **`:547-568`**。⇒ 合同按类别声明各自必须 grounded 的字段，⛔ 不写成「整段 action 逐字存在」 |
| 副作用纪律 | **receipt-first**（先落可持久回执再做 mutation，承 `headphone/turn-machine.ts:21-30` 的既有硬闸）+ mutation 时重新校验 binding 并 fencing（承 Raya `ShipGateFlow.ts:152-160,:492-495`）+ 幂等去重 |
| 🔴 **引擎 A：用 Live 自带的 client delegation 当接缝，⛔ 不另造函数工具 —— 但它不是 `handoffToLead` 本身** | founder 2026-09-23 06:17Z 定「用 GPT Live」。连 `wss://api.openai.com/v1/live/sessions`，`session.start` 指定 `gpt-live-1` + `delegation.type=client` ⇒ 模型发出 `target=client` 的委托事件（带 **`delegation.id`**），应用做完事按同一 id 用 `session.commentary.append` 回送，模型把结果说出来（FLY-2799 `gpt-live-handoff.md`＠`15fe2c875`，单场实测已跑通）。<br>🔴 **但要把两件事分开**（⛔ 不是同一件）：<br>· **delegation 事件是「模型 → 应用」的 inbound 请求 + 一个相关联句柄**；探针原始事件只有 `{id, type, target}`（`session.delegation.created`，`duplex-live.jsonl@15fe2c875`），**不含完整任务文本**<br>· **`handoffToLead(intent)` 是「模式层 → Lead」的 outbound**，其 `intentKind` / `payload` / `transcriptId` / 原话 / `authorityBinding` 仍由**模式层从已持久、已归属的 utterance 构造并校验**（§4.1 ②），用**自己的 `handoffId` / `idempotencyKey`** 经真正的 Lead carrier 派发<br>· **`session.commentary.append` 只是把最终结果回给 Live 让它说出来，⛔ 不是业务 commit**<br>⇒ 落地要求：持久化 **`delegation.id ↔ handoffId ↔ transcriptId/requestDigest`** 的绑定。⛔ 没有证据表明 `delegation.id` 可跨重连查询、可当业务幂等键 ⇒ **不得拿它当 `idempotencyKey`**<br>⚠️ 那一场**没有**调真实 Lead、没有执行业务动作；信箱送达、Lead 消费、动作授权、纪要回投**均未验**。⇒ 表述上「**协议回环已跑通**」≠「`handoffToLead` 已跑通」|
| 🔴 **通用载体仍然没有 —— A 也不例外** | 更正本单先前的写法「不新建通路，收窄入口」：今天只有**两条专用路**——`voice-codex/src/adapters.ts:103 ingest(...)` 是**整句邮箱投递**（不是 intent），`voice-headphone/src/bridge-client.ts:136 postShipApproval(...)` 是**ship 专用权限 mutation**。⇒ **通用 `handoffToLead` 需要新定义 request/receipt 合同**，再分别映射到通用 comm 与 ship 专用两条实现 |
| ⚠️ 前提 | 「引擎自己答」**部分推翻** founder 2026-09-08 的 F2/F3 与 FLY-2655 的「Realtime 不得独立回答」。本单**只把两条路在接口上分开**，默认哪条开着**由她拍板**（FLY-2786 讨论页第 10 区块已交给她） |

#### ④ 会话起止

| 项 | 合同 |
|---|---|
| 🔴 **权威（本单先前写错，这里是更正）** | **实际会话状态的权威是 `VoiceSessionState`**（`packages/teamlead/src/StateStore.ts:2663-2672`：`provisioning\|desired\|claimed\|warming\|live\|ending\|ended\|cancelled\|failed`）。`VoiceScheduleState`（`:2731-2738`，CHECK `:10246`）是 **FLY-2701 的「未来会议预约」记录**，`session_id` 可空，**即时 rg / 耳机会话根本不要求有 schedule** ⇒ ⛔ 不能拿它当所有会话的权威 |
| 三层职责 | `voice_sessions` 管**实际会话**；`voice_schedules` 只管**预约**并可关联到 session；**模式状态机**只管 item / meeting flow（耳机 `turn-machine.ts`、会议 huddle）。⛔ 三者不得互相冒充，⛔ 不许第四套 |
| 引擎侧 | 引擎只暴露 `open(ctx) / close()`，**不拥有调度**。⚠️ `VoiceSessionState` **没有 `ready`**（那是 `VoiceScheduleState` 的值，`ready_at` 只是行字段）⇒ 准确写法是 `warming` = 进房成功且引擎就绪，`live` = 她本人在房（`discord-room.ts:239-260` 的 presence） |
| `speak` 的门 | 只有 `live` 才允许 `speak`；其余返回 `{pendingKey, requestDigest, outcome:"rejected", reason:"not_live", transport:"none", contentProof:"none"}` 并留痕（union 要求的字段一个不少） |
| 退出 | 两条触发：离开语音房（`headphone/turn-machine.ts:583-588` `vc_exit`）与口头退出（`phrases.ts:15` / Raya `ExitProtocol.ts:39`）。⚠️ 口头退出**必须先有 founder 的 user 转写**才认（Raya `runtime.ts:1082-1100`），否则记 `spoken_exit_ignored_without_founder_request` |
| 会议 R-39 | 她退房，Lead **也退，不留在房里等**（PRD FLY-1851 `prd.md:655-663`） |

#### ⑤ 上下文：`initialSessionContext`（开场）与 `injectContext`（运行中）**是两件事**

| | `initialSessionContext(ctx)` | `injectContext(text)` |
|---|---|---|
| 时机 | `open()` 时一次 | 会话运行中，任意次 |
| 语义 | 决定这个会话「是谁、知道什么、遵守什么」 | **静默**补事实；`types.ts:223-231` 明写**必须永不触发出声**，且**不写 transcript sink** |
| 内容 | Lead 身份 + memory + 模式 + 会议议题/上一场 notes + 退出协议条款 | 会中它没听到的事实（huddle 给未被点名的 Lead 喂的那种） |
| 上限 | 必须有显式上限并在超限时**抛错而非静默截断**（Raya `ExitProtocol.ts:2` 8192 字符、`RealtimeTransport.ts:157-164` token 估算；Flywheel `types.ts:126 systemPreamble`）。**单位要写明**（字符 vs token，A/B 不同） | 同样要有上限与失败/重试语义 |
| A 的落点 | Realtime 会话 instructions | `sendText` 之外的静默通路 —— ⚠️ A 今天**没有** `injectContext` 实现，V4 要补或声明不支持 |
| B 的落点 | `thread/start` 的 `baseInstructions`（Raya `CodexLeg.ts:118-134`）。⚠️ **显式传入会替换掉默认的 identity+memory 拼接**（`:118-125`）⇒ B 必须定义「如何在给显式上下文时**不丢** identity / memory / ACTIONS 合同」，⛔ 不能只写「memory 指针」 | 待 V5 验（Codex realtime 是否有静默注入） |
| 会议上下文 | 复用 `BriefingEngine.ts:23-31` + Raya `meeting-context.ts:20-25` 的**规则**（meetingId 一致性 `:28-31`、状态白名单 `:32-36`、记忆文件清单拼接 `:47-49`），loader 换掉 | 复用 `FeedPipeline.ts:39` |

### 4.2 A / B 逐项对照

**引擎身份（founder 2026-09-23 06:17Z 定，Lead 2026-09-22 转达）**：

| | 引擎 A | 引擎 B |
|---|---|---|
| 前台模型 | **`gpt-live-1`**（backend id 为稳定的 `openai-live`，见 §4.2b），公开接口 `wss://api.openai.com/v1/live/sessions`，`session.start` + `delegation.type=client` | **Codex 0.156.1 V2** + `gpt-realtime-2.1` |
| 后台 | Lead 本体（经 client delegation 回送） | Codex 容器自带（装当前 Lead 的 memory） |
| 事实来源 | FLY-2799 `engineering/doc/FLY-2799-codex-voice-container/gpt-live-handoff.md`＠`15fe2c875`「给 FLY-2798 用」 | 同文件 |

⚠️ **公开 Live 不是「把旧 Realtime 的模型字符串换一下」** —— 它是**新的入口与会话协议**（同上文件）。
⚠️ Codex 0.156.1 **V3** 指定 `gpt-live-1` 返回 `Voice session access denied`，那是**另一条接入路径**，
⛔ 不能据此说密钥不能用 Live（同上文件）。

| 合同项 | 引擎 A（`gpt-live-1` 前台 + 后台 Lead） | 引擎 B（Codex 0.156.1 V2 + `gpt-realtime-2.1`） |
|---|---|---|
| `speak`（`verification:"required"` 的那几路） | ✅ 开口机制已跑通：`session.commentary.append` 触发（单场实测）。⚠️ **`contentProof` 要重新取证** —— 那一场没做逐字保真校验；`realtime.ts:349,:381-383,:1017-1019` 的逐字 instructions + 回读校验是**规则资产**，要移植到 Live | ⚠️ `thread/realtime/appendSpeech`；逐字是**软约定**，每次是否可检出待 V5 实测 |
| `speak` 的音频面 | ✅ 外部 **24 kHz 单声道 PCM** 能持续送入（单场实测） | ⚠️ 24kHz mono（Raya `RealtimeTransport.ts:26-31`） |
| `turnCancelOrSuppress`（≠ R-12 本身，见 §4.3） | 🔴 **未证**：那一场 **Live 没有与 Realtime 等价的取消事件**（Realtime 对照在插话第一帧后 167.7ms 明确取消旧响应）。且 `discord-room.ts:279-281 cancelSpeech` 只 flush 本地嘴 ⇒ **V4 必须自建 adapter 侧 suppression generation/token** | ❌ **未验** |
| `onUtterance` | 🔴 **A 的归属＝未验，且 fail closed**（`attribution.kind==="unknown"` 时禁止一切副作用，见 §4.1 ②）。`realtime.ts:38-45` 的 `ownerUserId`/`utteranceId` 是 **legacy / 今天生产那条 OpenAI Realtime** 的能力，**不是 `gpt-live-1` 的** —— 探针只证明 Live 的输入/输出转写**可并发**（时间区间重叠 200ms），**没有**证明它给出说话人归属。⇒ A 的 `attribution` 要靠 **RoomIO 的说话事件与 Live 事件关联**之后才能声明。<br>⚠️ 200ms 重叠**只推得出**「不能假设输入输出串行、⛔ 不能只靠时间区间互斥判 turn」；⛔ **推不出「出现了重复项」** —— dedup 规则要等观测到重复 id/内容再定 | ⚠️ `transcript/delta`+`/done`（Raya `RealtimeTransport.ts:333-356`）**不带归属** ⇒ 必须由 RoomIO 补 |
| `initialSessionContext` | `session.start` 的会话参数 | `thread/start` baseInstructions（`CodexLeg.ts:118-134`），⚠️ 显式传入会覆盖默认 identity+memory |
| `injectContext` | ⚠️ 未验（`commentary.append` 会触发开口 ⇒ **不能**直接当静默注入用） | ❌ 未验 |
| 会话起止 | 由 `voice_sessions` 驱动，引擎只 open/close | 同；⚠️ 多一层 Codex 子进程生命周期（`CodexLeg.ts:107/:171`） |
| `handoffToLead` | ⚠️ **协议回环已跑通 ≠ handoff 已跑通**。Live 的 client delegation（`delegation.id` 往返）只是 **inbound 触发 + 相关句柄**；outbound 的 `handoffToLead(intent)` 仍要模式层构造并经真正的 Lead carrier 派发（§4.1 ③、§4.4）。⚠️ 委托事件**只有元数据**；真实 Lead 那一段（信箱送达、Lead 消费、动作授权、纪要回投）**全未验** | Codex 实时模型自带 `background_agent` 是**另一条** handoff ⇒ V5 要定谁优先，⛔ 不许两条都开着让她收到两份回执 |
| 生产可用性 | ⚠️ **协议已跑通，产品链路未验**：没接真实房间的扬声器/麦克风/播放队列，⛔ 不宣称真人打断手感或播放缓冲清空已通过 | ❌ FLY-2655 2026-09-22 实测：app-server realtime v2 在生产收不到回话 |
| 额度/权限失败 | 🔴 **必须明确报「语音不可用」，⛔ 不得静默切引擎**（FLY-2799 同上文件的明示约束） | 同 |

⚠️ **那三个单场数字（开口 1175.0ms / 插话后新答案 4772.5ms / 后台结果 3016.8ms）是文字到达时间，
⛔ 不是人耳听到的延迟，⛔ 不是性能排名**，每种配置只跑了一场。V6 不得拿它当基线。

### 4.2b 模型与端点是**配置项**，不是常量

| 配置键 | 取值示例 | 纪律 |
|---|---|---|
| **backend id**（适配器身份，**稳定**） | `openai-live`（A）/ `codex-realtime`（B） | 由 `VoiceBackend.id` + registry 按**实现**选择（`types.ts:151-159`、`backends/registry.ts:27-53`）。🔴 **⛔ 不要把 `gpt-live-1` 写成 backend id** —— 那是模型版本，写进 id 就破坏了「模型可换、适配器身份稳定」 |
| 端点 | `wss://api.openai.com/v1/live/sessions`（A） | ⛔ 不硬编码在模式层 |
| **语音模型**（可换） | A：`gpt-live-1`；B：`gpt-realtime-2.1` | **可配置**（Lead 2026-09-22 明示）；⛔ 模式层不感知 |
| 音色 | 已有 `LeadConfig.voice`（`packages/teamlead/src/ProjectConfig.ts:231`） | 沿用，⛔ 不新建第二处 |
| **协议与模型必须匹配** | —— | ⛔ 不许只换模型字符串就复用旧入口；配置不匹配 ⇒ 启动即报「语音不可用」 |

### 4.3 capability × 模式 的准入矩阵（**未满足即 fail closed，⛔ 不许笼统「降级」**）

🔴 **先更正两条本单先前写错的 capability 语义**（`types.ts:56-70`）：

| capability | 真实含义（已核） | 本单先前写错的地方 |
|---|---|---|
| `bargeIn: boolean` | **「她一开口能不能打断模型正在说的那一轮」** —— `GeminiLiveBackend.ts:139` 把它传给 transport，`genaiConnector.ts:81-83` 在 `bargeIn===false` 时钉 `activityHandling:"NO_INTERRUPTION"`，注释明写「a live response cannot be cancelled by server VAD」 | 先前写成「Lead 能不能主动插话」—— **反了**。Lead 主动带节奏是**模式策略**，不需要任何 capability |
| `audioOut: AudioFormat[]` | 是**格式集合**，不是布尔 | 先前当布尔用 |

⚠️ `verbatim` / `attribution` 两个字段**今天不存在**，V4 要加（§3.7 缺口）。

**R-12「她一插话，Lead 立刻停」不是一个 capability，是三件的最小组合 —— 而且第三件是本轮补上的**：

| 组成 | 归谁 | 今天有没有 |
|---|---|---|
| ① `roomDetectsBargeIn` —— 经过 backchannel / 能量门的**持续发言**检测 | **RoomIO** | ① voice-codex：❌ **没有** —— `discord-room.ts:347 speakingStart` 只是开始收音与归属，`DiscordVoiceRoomOptions`（`:57-74`）**没有 `onBargeIn` 回调、也没有 backchannel gate**；② voice-bridge：✅ `audio/EarsReceiver.ts` —— 默认值 `:69-71`（backchannel 350ms / holdoff 1000ms / minRms 0）、构造赋值 `:96-100`、1000ms silence holdoff 执行 `:144-160`、gate 触发 `:164-184` |
| ② `localPlaybackCancel` —— 立刻掐掉本地在播的音频 | **RoomIO** | ① `discord-room.ts:279-281 cancelSpeech`（转发给 `mouth.cancelSpeech`）；② 未查 |
| ③ 🔴 **`turnCancelOrSuppress` —— 对被取消的那一轮建立持久 fence**，丢弃其后全部 audio / transcript / tool 效果，直到该轮明确终结 | **引擎适配器**（可由 server-native cancel 实现，**也可**由 adapter 侧的 suppression generation/token 实现） | gemini-live ✅ —— `GeminiLiveBackend.ts:208-214,:245-263,:299-360` 的 `turnCancelled` 即便在 `bargeIn:false` 下也持久抑制该轮后续；voice-codex ❌ **没有**；**A（`gpt-live-1`）🔴 未证** —— FLY-2799 单场实测里 Live **没有与 Realtime 等价的取消事件**；B **未验** |

🔴 **更正本单先前的写法「前两件就够」** —— 不够。
`cancelSpeech` **只 flush 当前 `WaitingMouth` 的 buffer**，它**不阻止同一 response 的后续 chunk / tool call / 重新入队**，
结果是「她插了话、静了一下，旧答案又冒出来」—— 这不是 R-12 的产品语义。
仓内的正确样板是 huddle：`HuddleSession.ts:1122-1136 interruptLine` 做的是
**`session.interrupt()` + `mouth.flush()` 两件**（resident 分支是 `resident.bargeIn()` + 清掉在飞 turn），不是只 flush 嘴。

⇒ **R-12 成立需要 ①②③ 三件齐**；③ 缺失时该格 **fail closed**（会议模式的硬要求），⛔ 不许只做前两件就宣称满足。

⚠️ **`turnCancelOrSuppress` 是「有效会话行为」，不是静态 backend capability。**
Gemini 的 `deriveCapabilities` 恒 `bargeIn:true`，但调用方可以传 `bargeIn:false`
（`GeminiLiveBackend.ts:116`，`genaiConnector.ts:81-83` 钉 `NO_INTERRUPTION`）⇒
**V6 必须核对最终会话配置后的有效能力**，⛔ 不能只读静态 capability 表。

**模式准入矩阵**：

| 模式能力 | 需要的最小条件 | 不满足时 |
|---|---|---|
| 用嘴批 ship | `verbatim` + `attribution` + `audioOut` 与 RoomIO 格式可协商（非空交集） | **整格关闭**，明确告诉她「这条我这里不能批」（`headphone/turn-machine.ts:21` 已有这句话的位置） |
| 复述兜底（专名/编号） | `verbatim`（判据用 Raya `readback.ts` 的 **identifier** 匹配，`:85-87`） | 关闭**依赖复述的那类动作**，不是静默跳过复述 |
| 进来播报 / 新消息主动念 | `audioOut` 非空且可协商 | 无法出声即整模式不可用 |
| 存活信号 | `audioOut` 非空 | 退回等待音床（RoomIO 提供） |
| 她一插话 Lead 停（R-12） | `roomDetectsBargeIn` + `localPlaybackCancel`（**RoomIO**）+ `turnCancelOrSuppress`（**引擎适配器的有效会话行为**）三件齐 | **整格关闭**并明确告知 —— 这是会议模式的硬要求。⚠️ 只做前两件 = 旧答案会再冒出来，⛔ 不算满足 |
| Lead 主动插话 | 无 capability 要求（模式策略） | —— |

### 4.4 `handoffToLead` 的持久状态机（R3 重写：从原则改成可实现的合同）

🔴 **更正本单先前把 `unknown` 写成「一等终局态」** —— 外部 mutation 超时/丢响应时它的含义是
「**可能已经提交了**」，⛔ 不是可以不管的终局。盲重试会重复，永不对账会永久丢真实结果。

⚠️ 用词说明：仓内确有 `VoiceOutboundPhase."ambiguous"`（`packages/teamlead/src/StateStore.ts:2673-2680`），
但它管的是 **`voice_outbound` 的音频消息**，且现实现只是在 session settle 时把 `claimed` 直接改成 `ambiguous`
（`StateStore.ts:5852-5862`）—— ⛔ **它只是词汇来源，不是 handoff reconciliation 的机制证据**。

#### 两个分开命名的形状

| 形状 | 什么时候返回 | 内容 |
|---|---|---|
| `HandoffReceipt`（**即时**） | `handoffToLead()` 返回时 | `{ handoffId, state, idempotencyKey, requestDigest }` |
| `HandoffExecutionReceipt`（**后续**） | reconciler 收敛后 | `{ handoffId, finalState, providerOperationId?, at, evidence }` |

#### 状态机

```
authorized ──► dispatching ──► dispatched ──► committed
     │              │                │     └─► rejected
     │              │                └──────► ambiguous ──► committed
     │              └── 崩溃/超时 ──► ambiguous      │     ├─► rejected
     └─► rejected                                   │     └─► needs_human  ← 持久终态
```

🔴 **`dispatching` 是 R4 补上的 —— 少了它就有不可恢复的崩溃窗口。**
先写 `dispatched` 再调用 ⇒ 崩溃后**虚报已派发**；先调用再写 ⇒ 外部已接受而本地崩溃时**没有 ambiguous 记录**。

| 状态 | 含义 | 进入条件 |
|---|---|---|
| `authorized` | 她的授权已**持久落盘**（书面回执已写成功并可回读） | 见下方「durable 的判据」 |
| `dispatching` | **即将**发起外部调用 —— 原子落盘之后、I/O 之前 | 写入 `idempotencyKey` + `requestDigest` + `authorityBinding` + `attemptToken` 之后。⛔ 未落盘不得发起任何 I/O |
| `dispatched` | 已拿到**可证明的 provider ack** | provider 返回可核对的受理凭据（`providerOperationId` 等），拿到即写 |
| （恢复时）`dispatching` 是 stale | 调用超时，或重启后发现停在 `dispatching` | ⇒ 一律进 `ambiguous`，只读查询 |
| `ambiguous` | 外部调用超时或响应丢失 ⇒ **可能已提交** | ⛔ 不得盲重放；只能按 `idempotencyKey` / `providerOperationId` 做**只读查询** |
| `committed` / `rejected` | 已证明的终局 | 只读查询回读到确定结果 |
| `needs_human` | **持久终态**：退避用尽仍无法证明结果 | ⛔ 不许因为「查不到」就当作没提交 |

#### 必须持久化的字段

`handoffId` · `intentKind` · `idempotencyKey` · `requestDigest` · `authorityBinding`（questionId / prHeadSha / issueId …）·
`transcriptDurabilityReceipt` · `providerOperationId`（拿到即写）· `attemptToken` · `lastReconcileAt` / `nextReconcileAt` ·
`reconcilerOwner` · **`claimToken`** · **`leaseExpiresAt`** · **`stateVersion`** · `terminalReason`。

🔴 **并发与恢复纪律**（R4 补）：
- **所有状态迁移走 CAS / fence**（比对 `stateVersion`），⛔ 不许两个恢复者同时推进同一条；
- 对账认领要有 **lease**（`claimToken` + `leaseExpiresAt`），过期才允许他人接管；
- 重启后 reconciler 按 `nextReconcileAt` 接管；⛔ 不依赖内存状态。

🔴 **dispatch 的前置 capability**（R5 收紧）：自动 reconciliation 的真正前置是
**「可用的查询键在发起 I/O 之前就已持久化」**，即二选一：
① provider 支持按**调用前已落盘、并随请求发出的 client `idempotencyKey`** 查询；或
② `providerOperationId` **可由客户端预分配**并在 I/O 前落盘。

⛔ **「只支持事后返回的 operation id」不够** —— 那个 id 要等 provider ack 才拿到（状态机的 `dispatched` 一步）；
若 provider 已提交、进程在收到/写入 ack 之前崩溃，本地就只剩 client 侧的键，
按 operation id 查根本查不了。

⇒ 两个条件都不满足时，该类 intent **二选一，⛔ 不许两头都占**：
（a）**dispatch 前 fail closed**（根本不发）；或
（b）明确标为 **human-recovery-only**，其 `ambiguous` 直接进 `needs_human`。
⛔ **不得同时把它称作「可自动对账」。**

#### 🔴 「durable utterance」今天落不了地 —— 判据也要写死

`TranscriptSink.append()` 返回 `void`（`types.ts:267`，注释虽写「failures throw explicitly」）；
但 `JsonlTranscriptSink`（`transcript.ts:49-65`）把写失败 **catch 住**、置 `failed=true` 并**丢弃后续写入**，
`flush()` 返回的 tail **不会 reject**（`:69-71`）。⇒ 今天拿不到 per-entry 的持久化证明，
且接口注释与实现**不一致**。

⇒ 合同要求：`transcriptDurabilityReceipt` 的判据是
**`flush()` 之后按 `sessionId` + 稳定 `transcriptId` + `contentDigest` 三者一起回读到那一条**
（⛔ 是「且」不是「或」—— 只按内容 digest 会被重复的同一句话撞上），
⛔ **不是「文件可读」**，也不是「`flush()` 没抛」。拿不到 ⇒ **fail closed**，该 intent 停在 `authorized` 之前。
