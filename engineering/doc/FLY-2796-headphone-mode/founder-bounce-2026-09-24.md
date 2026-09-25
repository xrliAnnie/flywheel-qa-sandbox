# FLY-2796 founder 打回修复 — 实施说明
Issue: FLY-2796 (URL 不可得,只写 issue 号)
日期: 2026-09-24
基于: plan.md

## 1. 打回原话与现象

founder 在两间真人房（车上 e2f65d70、家里 cac78575）里遇到三件事：

1. 一句话送到 Lead 后没有回话，等待音一直响（家里约 4 分钟）。
2. 等待音响着的时候她开口说话，等待音不停，打断不了。
3. 房里只有她一个人，清晰的话被悄悄丢掉（车上 7 段丢 3 段、家里丢 1 段），证据里记为 `skipped_unknown`。

全部发生在默认引擎 `openai_realtime_direct`，也就是 voice-codex 的 `GenericVoiceSession` + `RealtimeFrontend` 这条路径。

## 2. 根因

| 现象 | 根因（代码位置） |
|------|------------------|
| 等待音不停 | `session.ts` 收到转写就 `setWaiting(true)`，只有 `speak()` 会置回 false。Lead 不回、投递失败（`capture` 返回 false）、Lead 回了空内容（daemon 走 `notify`）这三种情况都不会关掉等待音，`WaitingMouth` 本身也没有超时。 |
| 打断不了 | 会话没订阅房间的说话事件，她开口时没有任何代码去停等待音。 |
| 单人房丢句 | `realtime.ts` 的 `ownerForRange` 要求一次服务端断句里只有一个 Discord utterance、中间没有空洞。她说完马上接着说时，Discord 会切成两个 utterance；句中停顿会在中间留下时钟补的静音帧。这两种情况都会让归属为空，于是这句按 `skipped_unknown` 被丢掉。前端「请再说一遍」的 `onStatus` 在 `cli.ts` 里也没接上。 |

## 3. 修法（只改 voice-codex 默认引擎路径；不改 RoomIO / 房间层，不改 2798/2799 引擎代码）

```mermaid
stateDiagram-v2
    [*] --> Idle
    Idle --> Waiting: 转写送出（启动计时）
    Waiting --> Idle: Lead 回话 speak()
    Waiting --> Idle: 空回答 notify() → 念「没有可朗读内容」
    Waiting --> Idle: 投递失败 → 念「有一句可能没送到」
    Waiting --> Idle: 到上限 → 念「回话暂时不通，你可以再说一遍」
    Waiting --> Muted: 她开口（barge start/sustained）
    Muted --> Waiting: 她停下（barge end）且仍在等回话
    Muted --> Idle: 到上限 → 念提示
```

1. **等待音上限**：每送出一句都会启动一个等待计时，新的一句会重新计时。上限是 `FLYWHEEL_VOICE_REPLY_WAIT_MS`，默认 15000。这个默认值是工程起步值，等她用过以后再定，已经登记进 `truth.ts` 的数值调参 allowlist。
   - 到上限时先停等待音，再在线程里发「📻 回话暂时不通，你可以再说一遍」，同时把这句念出来。
   - 投递失败时立刻停，念「有一句可能没送到，请再说一遍」。文字提示 delivery 已经发过，这里不重复发。
   - Lead 回了空内容（daemon 的 `notify`）时立刻停，把「没有可朗读内容，请看文字」念出来。
   - Lead 的回话一开始念，等待就结束，之后不会再补超时提示。
2. **等待音期间可打断**：订阅 RoomIO 已经在发的 `onBargeIn` 事件（Silero 门控确认的人声）。
   - 收到 start/sustained：只要她在说话，等待音就静音。
   - 收到 end：如果还在等回话，恢复等待音。
   - 她说的话照常走转写 → 投递。等待计时不会因为她说话而停。
3. **不悄悄丢句**：人数来源是新增的 `room-headcount.ts`（`ChannelHeadcount`）。
   - 每次判定时同步读 gateway 的 `guild.voiceStates.cache`，数频道里的占用者。只排除本 bot 和已确认是 bot 的成员；身份没解析出来的占用者一律算作「可能是真人」；缓存读不到时结果为未知。
   - client 句柄取自房间自己订阅 deps 时传入的那个，RoomIO 不改。
   - 为什么不用现成的计数，Codex 复审前两轮各指出一处（都是 HIGH）：
     - R1：RoomIO 的 `humanCount` 只在 founder 自己进出时刷新，别人进来后会过期。
     - R2：deps 的进出事件要先等 REST 查完成员信息才发出，查不到就直接丢弃；`voiceChannelHumanCount` 还会漏数没解析出来的成员。
     - 这些计数在「判断还有没有人」时是 fail-closed，拿来判断「是不是只剩她一人」时反而成了 fail-open。
   - 单人房归给她要同时满足四条：她在房里；可能真人数恰好为 1；这段话里所有有声帧都属于她；至少有一帧有声。满足时这句归给她，证据记 `attribution: "sole_human"`。
   - 其它情况一律拒绝：段里出现别的已捕获说话人、整段只有静音、或者多人房。被拒的句子走前端 `onStatus`，文字发到线程，同时把「有一句话没能确认说话人，请再说一遍」念出来。
   - 多人房**不做**猜测归属。
4. **会话串行朗读**：Lead 回话和会话自己要说的提示走同一条 FIFO 队列。提示正在念的时候，Lead 回话排在后面，不会像以前那样直接返回 `failed`。同一句提示还在排队时，不会再重复入队。提示念完后不会补发「已念完」。

## 4. 证据字段（给 QA 真房对照）

- `reply_wait_ended`：`reason` 取 `reply` / `reply_unspeakable` / `delivery_failed` / `timeout` 之一。
- `voice_prompt_spoken`：`text` 是念出的原文，`receipt` 取 `confirmed` / `unconfirmed` / `failed` 之一。
- `waiting_interrupted`：她开口时等待音被静音的那一刻。
- `realtime_input_terminal`：新增 `attribution: "sole_human"` 字段，只在单人房归属补救生效时出现。

## 5. 刻意不做

- Lead 回话播放期间被她打断（取消 Lead 语音）属于第二批「打断」，这次不做。本次只处理等待音。
- 不改 Bridge 侧：Lead 不回话、Lead 会话卡死这类情况，由第 1 条的上限兜底。
- 两句重叠时，第一句的回话会把两句的等待一起结束。这是因为 outbound 条目不带对应转写的 id，没法按句对应。

## 6. 二次返工：去掉等待音，计时只算安静（2026-09-24 23:44 PDT founder 裁定 + QA r7 FAIL）

founder 原话要点：「在静默的时候，我理解的是如果没有 update 就没有声音……我们可能不需要等待音」。QA r7（头 4169e41e4，真房 fcfbaaa9 + 台架 S4）发现的阻塞缺陷是：Lead 已经回了，但回话还在念或还在排队，15 秒计时照样到点，于是「回话暂时不通」插到了两条回话之间，甚至插进一条回话的两段中间。

第 3 节的第 1、2 条由本节取代：

```mermaid
stateDiagram-v2
    [*] --> Quiet
    Quiet --> Owed: 转写送出（计时开始，满额）
    Owed --> Paused: 房间开始念东西（回话或提示）
    Paused --> Owed: 房间念完、安静下来（计时从满额重新开始）
    Owed --> Quiet: 一条回话的第 1 段开始排队 speak(part=0)
    Paused --> Quiet: 一条新回话的第 1 段 speak(part=0)
    Owed --> Quiet: 空回答 notify() / 投递失败（念原因）
    Owed --> Quiet: 安静满额到点 → 念「回话暂时不通，你可以再说一遍」
```

1. **没有等待音**：会话不再调用 `setWaiting`，也不再处理房间的 `onBargeIn`（它只服务于等待音）；「等待音关掉 / 等待音打开」不再作为本地命令截下，按普通的话送给 Lead。没有新消息时房间就是安静的。「长时间无话报平安」属于耳机模式层（`HeadphoneSession` 的存活信号），不受影响。
2. **计时只算安静**：`GenericVoiceSession` 的朗读队列里有东西在念、或者还有东西在排队时，等待计时暂停；房间安静下来那一刻，计时从满额（`FLYWHEEL_VOICE_REPLY_WAIT_MS`，默认 15000，仍是待她用过再定的起步值）重新开始。所以提示只会在一段完整的安静之后出现，不会插进回话中间。daemon 两次拉取 outbound 的间隔约 4 秒（`FLYWHEEL_VOICE_LEASE_RENEW_MS`），远小于上限，已经发出的下一条回话会在计时到点之前被取到。
3. **续段不算新回答**：`prepareReplySpeech` 给每段标上 `part`（从 0 开始）。只有第 0 段会结束等待；同一条回话的后续段只是把这条回话念完。这样她在回话播放期间说的话仍然欠一个回答：Lead 不回，房间安静满额之后她会听到「回话暂时不通」（founder 打回第 4 条：送达 Lead 就要有回音）。
4. **「现在有什么新情况」**：不加新机制。在 Lead 规则（`department-lead-rules.md`，ON/OFF 两份逐字相同）的「自身语音会话」一节补一句：她随时可能这样问，Lead 按当前状态口头简答，没有新情况就直接说没有。

先红后绿（`session.test.ts`）：QA S4 形状（两段长回话播放中她又说一句，第二条回话在第一条念完之后才到）→ 既不出现「回话暂时不通」，第二段也紧跟第一段；同形状但 Lead 不回 → 念完后安静满额才出提示；「请再说一遍」正在念时不计时；全程 `setWaiting` 未被调用。

证据字段变化：`waiting_interrupted` 不再产生；`reply_wait_ended` 的 `reason` 不变。

第 5 节最后一条随之收窄：现在只有一条回话的第 0 段会结束等待，续段不会；但 outbound 条目仍不带对应转写的 id，所以两句都在等时，下一条新回话仍会把等待一起结束。

**本节留下、未删除的死代码**（房间层本单不动，删之前先问）：`discord-room.ts` 的 `setWaiting` / `setBedEnabled` 适配方法、`RoomIO.setWaiting` / `setBedEnabled`、`WaitingMouth` 的等待 bed 分支。生产上已没有调用方。
