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
7. **她在议程件里说的话怎么交出去**（Codex 代码审查 R1/R2）：只有 Bridge 确认已提交才算交出；提交前失败（落盘、turn 绑定）或被明确拒绝，让她听到「你再说一次」；提交后没拿到 Bridge 已持久的状态（网络丢失、authorized/dispatching）就用**同一个请求**继续重发（Bridge 按 handoff id 幂等，重发即查询），直到拿到 committed、Bridge 已持久的 ambiguous（交给载体对账，保持登记、不让她重说，避免动作执行两次）、明确拒绝（4xx / rejected / needs_human，提示重说）；60 秒内仍收敛不了，就明说没交出去、请她重说，绝不静默登记一个 Bridge 根本没有的 handoff。对账证明还要求记录里有合法 answer key、简报正文确实带着它，旧的无 key 记录永不判为已投递。对账时逐项核对议程字段和 answer key，缺一不算已投递。U1 标记与收件箱页、游标同一事务提交，写失败游标不前进。

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
