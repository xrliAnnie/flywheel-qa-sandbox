# FLY-2863 语音播报只播四类、Lead 消化后对话 — 实施记录
Issue: FLY-2863 (https://linear.app/geoforge3d/issue/FLY-2863/语音v7-播报内容只播三类lead-主动说的-待批-受阻lead-消化后用对话口吻一件一件跟她过内部排队10)
日期: 2026-09-24
基于: plan.md（Codex 设计评审 3 轮 APPROVED，blob `d457a1632d47`，本轮**未改动** plan.md）

## 0. 基底与合入顺序

- 本分支先合入 `origin/flywheel-FLY-2798@aec9c805b`（引擎 A，其中已含 FLY-2796 模式层的一次合并）。
- 合入顺序必须是 **#1309（FLY-2796）→ #1312（FLY-2798）→ #1314（本单）**。在 #1309、#1312 合入 main 之前，本 PR 的 diff 里会带着它们的改动；它们合入后本分支再合一次 main 即可。
- 没有合入 FLY-2796 的最新头（它在 2798 合并之后又走了 78 个提交，和 2798 在 `voice-handoff-routes.ts` 等处有冲突）。那是 2796/2798 之间的冲突，按顺序合入时由 2798 解决，本单不复制、不代解。

## 1. founder 拍板（覆盖 plan.md 里相反的写法）

| 拍板（2026-09-24） | plan.md 原写法 | 实现 |
|---|---|---|
| thread 标题的「要你答」**要播** | R1-1：默认不播，`agenda.includeThreadAnswer=false` | 新增第四类 `needs_answer`，与「待批」「受阻」同源（标题判定），**没有开关**。默认顺序：受阻 → 待批 → 要你答 → Lead 主动说的 |
| 耳机模式跟她说话的是 Raya，用 Raya 的声线；会议用对应 Lead 的声线；禁用 edge-tts | §5.1/§5.2 | 说话人 = 会话 Lead（`rg` 会话在生产里就是 raya）。Live 前台和播报器都用该 Lead 在 projects.json 的 `realtimeVoice`（FLY-2866 已写入 Tadashi=verse、Honey Lemon=alloy，raya=marin） |
| 各 Lead 声线写进配置 | §5.3 | 由 FLY-2866 完成，本单只读 |

## 2. 施工合同 → 代码

| plan | 落点 |
|---|---|
| §2 来源（只取四类，不回放历史） | `teamlead/src/bridge/voice-agenda-source.ts`：标题三类直接调用 `readFounderAttentionFacts` + `founderAttentionLevel` + `readIssueTitleState`，判定顺序与 `issue-display-refresher` 的标题一致；Lead 主动说的 = 收件箱 `origin_class=lead_authored`、只看 Lead 主频道、晚于她在该频道最后一次发言、晚于上线基线、24h 窗口内；窗口外只给条数 |
| §2.3 收件箱 `originClass` | `headphone-collector.ts` 在采集时用 `AUTOMATED_MESSAGE_PREFIX` 与 voice-core `VOICE_ECHO_PREFIXES` 判定；`voice_headphone_source.founder_last_message_at` 记录 founder 回复水位 |
| §2.1 `GET /api/voice/agenda` 与逐来源 `sourceStatus` | `voice-agenda-routes.ts`；served items 记入 `voice_agenda_items`，客户端之后只能按 key 引用 |
| §3.1 议程请求（不是用户 handoff） | `POST /api/voice/agenda/requests` → `voice_handoffs.request_kind='agenda_brief'`（CHECK：只有 agenda_brief 可以没有 transcript），走同一个投递/对账/结果流 |
| §3.2 `voice agenda say/close` | `flywheel-comm voice agenda say|close --key` → `POST /api/voice/agenda/lead/results`，结果写进 `voice_handoff_results`（新增 `agenda_say`/`agenda_close` 与 `agenda_json`，旧表一次性重建） |
| §3.3 runbook | `teamlead/lead-rules-base/runbooks/voice-agenda.md`；请求正文本身写明「不是 founder 说的话」、这一件要她做什么、要跑的命令 |
| §3.4/§3.5 机械校验、过渡句、兜底句 | `voice-core/src/agenda/speech.ts` + conductor 的两段超时 |
| §4 AgendaConductor | `voice-core/src/agenda/AgendaConductor.ts`（Q1–Q9、U1/U2、报平安、R-T1..R-T5、CAS 持久化） |
| §4.4 R-T2 服务端 turn 绑定 | `POST /api/voice/agenda/turns` + `voice_agenda_turns`；用户 handoff 的 wire/parser 一字未改，绑定由 Bridge 查表派生，经 `voiceHandoff.agenda` 附加字段投递给 Lead |
| §4.5 两种模式 | `HeadphoneSession(mode)`；`rg`→headphone（全部项目/Lead），meeting→只含会议 Lead |
| §4.6 引擎 A | `live-lead-adapter.ts`：回合开始即绑定；议程回合压住前台音频与字幕、不说「我问下 Lead」；Live delegation 与强制封口两条路径按 utterance 去重，只交一次；该回合的回答归议程，不走前台 readback |
| §4.8 三样分开记 | `voice_agenda_dispositions`（resolved 必须有 evidence，CHECK 兜底）；播放回执沿用 SpeakReceipt；旧收件箱 ack 议程不写 |
| §5 GPT 声线 | `voice-core/src/backends/openai-tts/OpenAiTts.ts`（`gpt-4o-mini-tts`，PCM 24kHz，只允许 api.openai.com）；`verifyOpenAiLiveComponents` 只接受 `openai-tts`，配成 edge-tts 启动失败；环境变量声线与注册表不一致启动失败 |

## 3. 实现细化（合同没写死的地方，按合同意图落地）

1. **逐来源证明移除。** 合同允许「任一来源不完整就整体不移除」的简单做法，但收件箱采集是 5 秒一页、上百个来源轮转，Lead 主频道几乎不可能每次都在 60 秒新鲜度内，整体规则会让「她点了批准、标题已变」的待批永远关不掉。实现改为：一件只有在**它自己的来源**完整时才能被证明已不在（`AgendaItem.sourceKey`）。不完整的来源仍然不能证明任何移除，R1-6 的意图不变。
2. **U1 标记写在消息里。** Lead 主频道消息的发送路径有两条（Codex 的 capability outbound、Claude 的 Discord 插件，后者在仓库外）。实现为：Lead 在自己主频道发的消息以 `🚨[urgent:<枚举原因>]` 开头，收件箱采集器识别后持久化（`voice_agenda_urgent`，按 messageId 关联）；读议程时只认**该频道所属 Lead 自己的 bot** 写的标记。身份由 Discord 作者证明，不信任何请求体（Codex 代码审查 R1 HIGH）。
3. **say/close 的鉴权。** 共享 token（master 或 ingest）只算传输凭证；每个议程请求、每个绑定了议程回合的 handoff 都由 Bridge 生成一个 answer key，只放在投递给**这个 Lead** 的那条信箱消息里。`voice agenda say|close` 必须带上它（常数时间比较），另要求会话仍 live、generation 未变，并先写一行 CommDB `response` 审计记录。另一个 Lead 即使拿到请求 id 和共享 token，没有那条投递也写不进来（Codex 代码审查 R1 HIGH）。Lead 直接回复那条语音消息（已认证的 outbound 路径）也会作为 say 播出，但不能结束一件。
4. **议程请求的作者。** 投递信封要求作者是 Discord snowflake：用会话的语音 bot（缺省时用 Bridge bot），绝不是 founder。对账按记录里存的同一作者核对。
5. **刷新节奏。** 收件箱没有推送，所以 Q9 的「每次变更触发」落为：Lead 的回话经 SSE 立即唤醒，来源变化靠 30 秒轮询。
6. **报平安间隔可配置**：`FLYWHEEL_VOICE_AGENDA_CHECKIN_INTERVAL_MS`，默认 600000（她定的数）。
7. **她在议程件里说的话怎么交出去**（Codex 代码审查 R1–R4）：只有 Bridge 已持久的状态才算数。committed：交出；Bridge 已持久的 ambiguous：交给载体的只读对账，保持登记等回答；提交前失败（落盘、turn 绑定）或明确拒绝（HTTP 4xx、rejected）：让她听到「你再说一次」。其余都是**结果不明**（网络丢失、单次提交超时、authorized/dispatching 迟迟不收敛、needs_human）：如实告诉她「这句我还在确认有没有交到 Lead，先别重复说」，绝不让她重说（重说是新的 handoff，动作可能执行两次），也不静默登记一个 Bridge 没有的 handoff；同一个幂等请求继续在后台收敛（不占播报队列，会话关闭即中止），收敛到 committed/ambiguous 才登记。每次提交都有 10 秒上限且可中止；一旦有过结果不明的尝试，之后再收到的 4xx 也只按「不明」处理（它只说明那次重试被拒，不能证明前一次没到）。迟到收敛的旧回合不会覆盖她已经在说的新回合（回合按开始时间单调排序）。Bridge 端：卡在 dispatching 超过 30 秒的 handoff（进程在邮箱写入与 finishDispatch 之间退出）由对账定时器提升为 ambiguous，进入只读对账，迟到的 finishDispatch 被 attempt token 挡住。对账证明逐项核对议程字段与合法 answer key，简报正文必须带着它；旧的无 key 记录永不判为已投递。U1 标记与收件箱页、游标同一事务提交。

## 4. 没做的与留给 Lead 决定的

- **引擎 B（FLY-2799）未接。** 2799 不在本单基底（Lead 指定基于 2796/2798），B 还没有模式层。`AgendaConductor` 只依赖 V1 会话接口，B 接上 `HeadphoneSession` 即可用；B 的 `realtimePrompt` 去掉状态罗列（连同 manifest/digest）要在 2799 合入后另开实现轮。验收「B 修好后同一组场景在 B 上重跑」保留。
- **死代码清单（未删除，交 Lead 决定）**：`voice-core` 的 `HeadphoneMode`（生产不再有调用方）、`InboxReader`（两种模式都不再用来朗读；类和测试保留）、`voice-speech-brief.md` runbook（不再用于朗读）、引擎 A 不再使用的 `EdgeTts`/`FfmpegPcmDecoder` 接线（类本身仍被其他路径导出）。
- **Lead 回话没有超时。** 她在议程件里说了话、Lead 迟迟不答时，模式层不代答；10 分钟报平安会兜住「还在」。

## 5. 验证证据（本机只跑相关测试，全量交 PR CI）

| 范围 | 结果 |
|---|---|
| `voice-core` agenda-conductor / openai-tts / config / composite-speech / gpt-live-backend | 30 + 4 + 14 + 5 + 8 通过 |
| `teamlead` voice-agenda-source / routes / store / route-order + 2796 回归（headphone-inbox、headphone-routes、voice-handoff-*、voice-lead-result-producer、voice-handoff-transcript）+ 保留表登记三件套 | 11 + 12 + 6 + 2，41，36 + 4 通过 |
| `flywheel-comm` voice-agenda / discord-chat-ingest / cli / message-status | 5 + 36 + 62 + 6 通过 |
| `voice-headphone` session / bridge-client | 5 + 20 通过 |
| `voice-codex` live-lead-adapter（含 4 条 §4.4 必测与改写后的抢话用例）/ engine-a-composition / config / live-reply-events | 37 + 4 + 26 + 3 通过 |
| `voice-bridge` related | 62 通过 |
| config 漂移守卫（feature-flags-drift / flag-truth / fly1981） | 68 通过 |
| `pnpm lint`（0 error）、受影响包构建、四个包的全部依赖方 typecheck | 通过 |
| 负对照 | 去掉议程回合去重守卫，「不重复交给 Lead」用例失败；恢复后通过 |
| S0 真接口探针 | 同一段中文用 marin / verse / alloy 各合成一次：PCM 24kHz、每块偶数字节、首字节 1.5 / 0.8 / 1.5 秒、RMS 2.7k / 2.6k / 3.7k，约 70% 帧有声。音频在 `~/.flywheel/artifacts/FLY-2863/s0-gpt-voice/` |

测试中发现并修掉的真实问题：`INSERT OR IGNORE` 会吞掉 CHECK（无 evidence 的 resolved 会被静默丢弃）；投递信封要求 snowflake 作者；通用 `/api` 鉴权把 Lead 命令的 ingest token 拦在 401；报平安请求发出后 1ms 反复重排。

## 6. QA@1 返工（QA d519329c 在头 41cc8d96c 判 FAIL，2026-09-25）

QA 在真 slot-3 Bridge + 真 Codex Lead + 生产引擎 A 组合上确认了四类过滤、逐件、排队尾、U1 插播、10 分钟报平安、marin 声线与 0 次 edge-tts，同时提出 3 个阻塞项和 1 个高优先级项。逐条处理如下：

| QA 项 | 根因 | 修法 | 回归证据 |
|---|---|---|---|
| B1a Quick Gate retention consumer | `voice-agenda-store.ts` 读 `chat_threads` 没登记 | 按精确 file/relation/baseTable/usage 登记为 `candidate_guarded`（只读未归档 thread）；B4 新增的 `session_events` 读取同样登记 | 守卫 `ok:true`，node 测试 10/10 |
| B1b teamlead schema 测试 | 期望的 `voice_%` 表清单漏了 7 张议程表 | 按字母序补齐 | 4/4 |
| B1c 墙钟阈值守卫 | R4 新测试用 `Date.now()` 断言 close 耗时 < 1s | 改成状态证明：close 能返回（阻塞会撞测试超时）、所有尝试的 signal 已 abort、close 后不再重发 | 守卫 + 两条用例通过 |
| B2 开场被静默丢弃 | Bridge 只校验 `--order` 是不是完整排列；模式层却要求不带 `--order` 时 `--item` 必须是默认队首，于是 Bridge 回 200、模式层按 matrix 拒收，Lead 不知道 | ①模式层：开场点名的那件（开场简报里的任意一件）直接成为当前件，其余保持原序（隐式重排）；②Bridge 在 say 时按同一套静态规则校验（开场件必须在开场简报内、item 请求只能说本件、报平安只能 `--item none`、机械校验 URL/markdown/代码/长度），不合规回 400，附 `reason` 和中文 `hint`，CLI 原样打印；③被拒的结果不再算「已回答」，过渡句和兜底句照常触发 | conductor 3 条、routes 3 条新用例 |
| B3 收尾那句从来播不出 | 真 Lead 把要对她说的话写进 `close --reason`，模式层从不念 reason | `close` 新增必填 `--say`：她拍完马上听到的那句，念完才进下一件，也是结果 `text`；`--reason` 只进台账，不念。Bridge 缺 `--say` 回 400 `say_required`，`--say` 同样过机械校验 | conductor 2 条、routes 1 条、CLI 2 条新用例 |
| B4（高）简报没有素材 | 简报每件只有键、类别、单号、标题、thread 链接 | Bridge 给每件附 `material`（只给 Lead 读、不念、发给语音客户端的快照里剥掉）：她被问的原话（Lead 在 thread 里问她的 excerpt，或待答问题原文）、该单最近一次 QA 结论摘要和报告链接、受阻的阶段和记录的错误、PR 号。每项读取都是尽力而为，读不到就缺省。开场简报给精简版（问题 ≤200 字、QA 摘要 ≤300 字），单件简报给完整版。无 session 的「要你答」thread 也能报出单号。runbook 与简报指引改为「依据看 material，没有的不编，直说详情在讨论串里」 | source 3 条、routes 1 条新用例 |
| ④ 小瑕疵：报平安连说两次 | Lead 24 秒才回，先播兜底句，4 秒后又播 Lead 的话 | 兜底句播出前先把这次报平安请求退役，迟到的 Lead 回话不再念 | conductor 1 条新用例；负对照：去掉退役这一步，该用例失败 |

不在本轮做：QA 的非阻塞观察（换件等待 60–75 秒、Lead 之间 @ 对话会被当成对她说的、slot shell 缺 Bridge 地址）与设计稿一致或属于环境差异，留给 Lead 定；R6 MEDIUM（turnOrder 用墙钟）仍按 Lead 裁定留在 PR Follow-ups。

本轮本机验证（只跑相关测试）：voice-core related 48（agenda-conductor 42）；teamlead 直接消费者 6 个文件 50 条（voice-agenda-routes 19、voice-agenda-source 14、voice-agenda-store、voice-runtime-route-order、StateStore.voice-session-schema、required-wall-clock-thresholds），`plugin.ts` 是 hub，`vitest related` 会展开成接近整包，未跑，只改了一个薄的 `readQuestionText` 接线，由 source 用例覆盖依赖；retention 守卫 node 测试 10/10 + 生产守卫 `ok:true`；flywheel-comm voice-agenda 6；voice-headphone session 5 + bridge-client 20；voice-codex live-lead-adapter 47 + engine-a-composition/config 30。根 `pnpm lint` 0 error；`flywheel-teamlead...`、`flywheel-voice-codex...`、`flywheel-voice-headphone...` 构建通过；voice-core、flywheel-comm、voice-headphone 的全部依赖方 typecheck 通过。exact-head full CI 与真房复测交 QA。

**返工后的 Codex 复审 R7**（同线程，xhigh，头 `3e24ffeae`）提出 1 HIGH、2 MEDIUM，都出在本轮新改的模式层，均已修复：

- HIGH：收尾句被她打断、TTS 失败或会话关闭时直接进下一件，close 已落盘，这句永久丢失。改为收尾句与 close 同一次提交存进 `AgendaState.closing`，**她听完才进下一件**；她打断不算失败，下个安全边界（间隔 8 秒）换新 pendingKey 重念；真失败两次就丢弃并记录，议程不会卡死；重启或新 generation 先念它。开新件、urgent 插播、报平安都等它；如果它自己的清除写入失败，就搭在下一次成功写入上一起清掉。
- MEDIUM：拒收结果的写入失败或 CAS 冲突时，Lead 计时器没有恢复。改为无论写没写成，都按当前状态重新计时。
- MEDIUM：报平安退役写入失败时仍播兜底句，迟到的 Lead 回话还会再念。改为确认退役后才播兜底句；否则只念 Lead 那一句。

回归：conductor 7 条新用例（打断重念、失败两次丢弃、重启先念、拒收写失败 ×2、报平安退役失败 ×2），另加路由用例锁住 `closing` 原样往返。负对照：去掉「收尾句待念时不开新件」的守卫，打断用例失败。复跑：voice-core related 55、voice-codex 77、voice-headphone 25、teamlead 议程 34，根 lint 0 error，`flywheel-voice-core...` 等构建与 voice-core 全部依赖方 typecheck 通过。

**Codex 复审 R8**（头 `dee20e614`）提出 1 HIGH、1 MEDIUM，均已修复：

- HIGH：`state.closing` 由语音客户端写入，Bridge 没有校验，持有 master+lease 的一方可以塞一句任意文本，重启后被念出来，绕过 answer key。改为 PUT state 校验它的精确形状与边界，且必须与**本会话一条已提交、已认证的 `agenda_close` 结果**逐项一致（同一 handoff 会话与项目、同一件、同一处置、同一句 say 与结果正文），否则 400。新增 8 种伪造负例（改文本、改处置、改件、伪造结果 id、别的请求、负计数、多余字段、缺字段）。
- MEDIUM：「收尾句待念时不开新件」的守卫只加在上层包装函数，R-T5 迟到回复的分支会直接调 `request()`。守卫下沉到 `request()` 本身，收尾句念完后由 `finishClosing()` 推进。新增 urgent 收尾被打断 + 旧回合迟到回复的回归用例（先复现出多发一个请求，修后通过）。

复跑：voice-core related 56、teamlead 议程 46、voice-codex 77、voice-headphone 25，根 lint 0 error，构建与 voice-core 全部依赖方 typecheck 通过。
