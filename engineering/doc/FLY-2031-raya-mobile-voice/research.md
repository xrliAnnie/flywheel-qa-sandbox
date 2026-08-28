# FLY-2031 随身语音(B):常开流 + 念读筛选 + 用嘴批 ship — 调研
Issue: FLY-2031 (https://linear.app/geoforge3d/issue/FLY-2031/rayav3-随身语音b常开流-念读筛选-用嘴批-ship)
日期: 2026-08-27
基于: exploration.md

> 本文只记**能被重跑或重读核实的事实**,每条带出处;方案取舍在 §6。
> 世界标记同 exploration §0:[main] = raya `origin/main` b7abff4;[flywheel] = 主仓 `e33f87d70`;[1911] = `product/doc/FLY-1911-codex-voice-prototype/`。

---

## 1. Codex realtime v2:文字怎么进去、话怎么出来

### 1.1 `appendSpeech` 进线程的真实形状 [1911 / raya probes]

P5 探针(`probes/p5-busy.mjs`)用 `thread/realtime/appendSpeech {text}` 提问,线程侧收到的是:

```json
{"method":"thread/realtime/itemAdded","params":{"item":{"type":"message","status":"completed","role":"user",
  "content":[{"type":"input_text","text":"[BACKEND] 请必须使用终端工具运行 pwd，然后用一句中文告诉我目录。不要凭记忆回答。"}]}}}
```
出处:`probes/evidence/P5-busy/P5-busy.jsonl`(2026-08-26T09:46:01.079Z)。

| 事实 | 成色 |
|---|---|
| `appendSpeech` 的文本作为 **`role:"user"`** 消息进入 realtime 对话,Codex 自己加了 `[BACKEND] ` 前缀(探针发的原文没有这个前缀,`c0-lib.mjs:330`) | ✅ 原件可核 |
| 模型对它**会回答**(P3/P4「记随机校验词 → 回答记住了」;P5 → 交办后台跑 `pwd` 再答)| ✅ research-2074 §7.5–7.6 |
| 1911 原型用 `appendSpeech("我上线了，现在可以跟我说话。")` 让它**先开口打招呼**(v2 独有;v3 没有文字触发口) | ✅ `bridge-hl.mjs:1383–1388`;她在 8-20/8-21 的真机场里听到过这个开场 |
| 模型会不会把播报前缀理解成「念给她」而不是「她在说」 | ⬜ **没人量过** ⇒ exploration P1 |
| `appendSpeech` 有没有长度上限 | ⬜ 未知(schema 不导出请求定义,research-2074 §1.1)⇒ 分批发,每批 🔶 ≤ 1,500 字,超了先验 |

⇒ **它是 v2 里唯一的会话中文字入口**,而且已经被当「触发它开口」用过。本单所有「代码要它说」的动作(开场积压、会话中新条目、存活信号、念回执)都只能走它。

### 1.2 交办给后台 Codex 的链路 [raya probes]

P5 原件里的顺序(同一秒内):

```
itemAdded  user message  "[BACKEND] …"                         ← appendSpeech 落地
itemAdded  function_call name:"background_agent" in_progress   ← realtime 模型决定交办
itemAdded  handoff_request {handoff_id, item_id, input_transcript:"…", active_transcript:[{role,text}]}
item/started  commandExecution … (backend turn)                ← 后台 Codex 真跑
item/agentMessage/delta ×23 → item/completed → turn/completed
transcript/done role=assistant                                 ← 念出来
```

| 事实 | 出处 |
|---|---|
| 交办走 realtime 模型的工具 `background_agent`;后台拿到的是 **`input_transcript`(ASR 原文)+ `active_transcript`** | P5-busy.jsonl 第 2/3 条 itemAdded |
| 后台线程 = `thread/start` 那个线程:`sandbox: workspace-write`,`writable_roots = RAYA_WORKSPACE_ROOTS_JSON`,`network_access: true`,`approvalPolicy: never` | `packages/contracts/src/codex-session.ts:51–66`;回执由 `assertThreadReceipt` 钉死 |
| 后台线程的 `baseInstructions` = `IDENTITY.md` + `MEMORY.md` 拼接 | `apps/voice/src/codex/CodexLeg.ts:83–92` |
| 后台在忙 = keyed `item/started|completed`;它开口 = `transcript/done role=assistant` | `runtime.ts:593–600`, `638–648` |
| 生产 writable roots = `~/.flywheel/raya/code` + `~/.flywheel/raya/memory`;cwd = code | `~/.flywheel/raya/raya.env`(非密钥行) |
| 后台 Codex **写不了** `RAYA_STATE_DIR` / metrics / CODEX_HOME / identity —— 配置层禁止 workspace 与它们重叠 | `apps/voice/src/config.ts:200–212` |

⇒ **模型能「动手」的唯一面是:在 writable roots 里写文件 / 跑命令。** 要让 voice 进程看见它的动作,只能在 writable root 里放一个 outbox。

### 1.3 开场指令会被忘掉 —— 内容必须跟着触发走 [1911]

`bridge-hl.mjs:790–793`(逐字):
> 实测 5 场,起会话→首问间隔 24/34/38 秒都读得到议题,510/798 秒都读不到。

| 推论 | 成色 |
|---|---|
| `realtimeStartInstructions` 适合装**规则**(怎么念、什么情况交办),不适合装**内容**(念什么)—— 几分钟后模型就答不上里面的具体条目 | 🔶 从上面 5 场推的;方向和 B §12.1「语音侧 startup context 有 5,300 token 预算」一致 |
| 开场积压必须在 `RealtimeStarted` 后**立刻**以 `appendSpeech` 喂,并且正文在 `appendSpeech` 里 | 🔶 ⇒ exploration Q1 已按此更正 |
| `startInstructions` 上限 8,192 字,超了 `realtime/start` 直接拒 | ✅ `RealtimeTransport.ts:144–148` |

### 1.4 转写事件的形状 [main]

| 事实 | 出处 |
|---|---|
| `thread/realtime/transcript/delta|done {threadId, role: user|assistant, text}` —— **没有 item id** | `RealtimeTransport.ts:301–320`;research-2074 §1.3 |
| runtime 只在 `final` 时记 evidence `realtime_transcript {role, text, generation}`;不上屏、不保留 | `runtime.ts:639–648` |
| 说话人归属:`Uplink.owner` = 当前持有上行的授权用户 id(只有一个人能同时占上行) | `pipeline/Uplink.ts:39–63`;`runtime.ts:521–563` |

⇒ 本单要给每条 user/assistant final 转写编一个会话内 id(`u-<sessionGen>-<seq>` / `a-…`)并保留一个小环形缓冲 —— 「念了没有」「她原词是什么」「谁说的」三件事都从这里取,**不从模型的文件里取**。

---

## 2. Discord 腿:能发什么、发到哪 [main]

| 事实 | 出处 |
|---|---|
| `DiscordAdapter.announce(text)` 只会发到 `RAYA_DISCORD_TEXT_CHANNEL_ID`(`#raya`);拿不到 channel 就 throw | `discord/DiscordAdapter.ts:280–289` |
| voice 的 Discord client intents = `Guilds + GuildVoiceStates`;**没有** `GuildMessages/MessageContent`(它不读文字) | `DiscordAdapter.ts:107` |
| brain 的 client 有 `Guilds + GuildMessages + MessageContent`,但处理器只接受 `#raya` 的两句精确短语 | `apps/brain/src/voice-mode.ts:15–18, 231–234` |
| 发消息失败的处理:announce 重试 `announceRetryTimes`(默认 3)× `fatalDrainMs` 超时,失败只记 `announce_failed` evidence,不杀会话 | `runtime.ts:737–776` |
| Discord 单条消息上限约 2,000 字;1911/voice-bridge 用 1,800 截断 | `packages/voice-bridge/src/discord/TivPresenter.ts:44` |
| bot 的 OAuth 权限 = `ViewChannel + SendMessages + Connect + Speak + UseVAD`(36703232),没有 ManageChannels | FLY-2074 plan §14.1 |

⇒ 本单需要给 adapter 加一个 **`send(channelId, text)`**(guild 内、channelId 只能来自 Raya 自己的目录文件或 inbox 条目的 `refs`;越界拒发),`announce` 不动。bot 权限够用:发消息到它能看到的频道/线程即可,**不需要新权限**(⚠️ 线程要 bot 有 ViewChannel;私有线程要它被加入 —— 验收时核)。

---

## 3. Flywheel Bridge 的语音批准面 [flywheel]

`packages/teamlead/src/bridge/voice-routes.ts`(FLY-546 B3-2),挂在 `/api/voice`,`tokenAuthMiddleware` 后面。

### 3.1 `POST /api/voice/ship-approval` 的请求体与守卫顺序(`voice-routes.ts:322–535`)

```jsonc
{ "gateMessageId": "<ship 卡的 Discord message id>",
  "questionId":    "<gate question id>",
  "prHeadSha":     "<PR head>",
  "transcript":    { "id": "<转写 id>", "text": "确认", "atMs": 0, "founderUserId": "<说话人 Discord id>" },
  "receiptMessageId": "<先发出去的书面回执消息 id>" }
```

| 级 | 拒绝 | 说明 |
|---|---|---|
| ⓪ | 503 `api_token_required` | Bridge 没配 token 就拒 |
| ① | 403 `disabled_by_kill_switch` | `FLYWHEEL_VOICE_APPROVAL="0"`;**默认 ON**(:332–334 注释:Annie ②) |
| ⑤ | 400 `receipt_required` | `receiptMessageId` 非空字符串即可 —— **Bridge 不去核这条消息**(它是「文字是收据」的诚实要求,不是校验) |
| ② | 400 `missing_required_fields` | 五个字段 |
| ③ | 409 `binding_mismatch` | `gateMessageId ↔ questionId ↔ prHeadSha` 必须对上**当前唯一**绑定(`resolveBindingByMessageId`, fail-closed) |
| ④ | 403 `canonical_founder_id_unresolved` / `speaker_not_founder` | `transcript.founderUserId` 必须 = Bridge 的 canonical founder id |
| ⑥ | `{written:false, kind:"unclear"|"reject"}` | `evaluateVoiceSource`:**只认精确** `确认`/`对`(approve)、`不对`/`取消`/`不批`(reject),其余 unclear;⛔ 没有分类器(`voice-approval-source.ts:17–18`) |
| ⑦ | `{written:false, kind:"held"}` | 评审/QA 没绿(FLY-1041) |
| ✓ | `{written, kind:"approve", reason, retrySafe}` | 写入 = `writeGateResponseAndRunPostWrite`,和文字/表情批准同一原语(`write-gate-response.ts:1–20`) |

### 3.2 配套只读端点

| 端点 | 用途 | 本单用不用 |
|---|---|---|
| `GET /gate-binding?messageId=` | messageId → `{bound, questionId, prHeadSha, issueId, prNumber}` | ✅ 用:inbox 里的 `ship_gate` 条目只带 `gateMessageId`,三元组在批之前**现查**(防 2030 吸收时过期) |
| `GET /scope` / `GET /context` | Lead bot 清单 / 频道上下文 | ⛔ 不用(那是状态吸收,归 2030;而且它把 Raya 绑到 flywheel 部署) |

### 3.3 文字通道是怎么认批准的(用来说清「同路」)

`text-approval-source.ts:30–86`:必须是 **founder 本人** (`authorId === canonicalFounderId`) **回复当前卡片**(`replyToCard`)+ 固定词;否则 unclear → Tier-3 Haiku 分类器(`founder-ship-approval-classifier.ts`)只在**真歧义**时跑。
⇒ **Raya bot 发的文字永远进不了这条路**(身份不对)。语音批准要「同路」,只能走 §3.1 那个面 —— 它最后落到同一个 `writeGateResponseAndRunPostWrite`。

---

## 4. 文件契约现状 [main]

| 契约 | 谁写 | 谁读 | 形式 |
|---|---|---|---|
| `RAYA_STATE_DIR/voice-mode.requested` | brain(文字触发) | voice `run` 启动时;brain sampler | 0600,temp+rename 原子写(`contracts/voice-mode.ts`) |
| `RAYA_STATE_DIR/voice-session.json` | voice | voice | 原子写(`store.ts`) |
| `RAYA_STATE_DIR/voice-evidence/events.jsonl` | voice | 人 | append(`evidence.ts`) |
| `RAYA_METRICS_DIR/*.jsonl`, `run/*.pid` | 两边 | 两边 | append / claim |
| `RAYA_VOICE_OPTIONS_JSON` | 运营者 | voice | 一个 JSON 对象,`numberOption` 逐项校验(`config.ts:214–372`) |

⇒ 本单新增的 inbox / outbox / 规则文件都按**同一族**写:owner-private、原子写、append-only、fail-closed 校验。

**outbox 放哪(三选一)**:

| 选项 | 部署变更 | 反面 |
|---|---|---|
| a. 新 env `RAYA_OUTBOX_DIR` + 加进 `RAYA_WORKSPACE_ROOTS_JSON` | 改 0600 env 两行;contracts 加 optional key;`config.ts` 加重叠检查 | 多一个 writable root;但**显式、可审**,`assertThreadReceipt` 会核 Codex 真拿到了它 |
| b. memory 仓里 gitignored 子目录 `.voice-outbox/` | 零 env 变更 | 把瞬时队列塞进「只放蒸馏记忆」的仓(`MEMORY.md` 合同第 1 条);`git status` 永远脏一格 |
| c. 让 Codex 写 `RAYA_STATE_DIR` | 去掉 config 的重叠禁令 | ⛔ 那条禁令是「会话不能改写自己的状态」的安全边界 |

⇒ 取 **a**。

---

## 5. 数(拿来定尺子,⛔ 不拿来定阈值)

| 量 | 值 | 出处 | 本单怎么用 |
|---|---|---|---|
| 上行帧 | 20 ms / 960 B / 24 kHz mono | `audio/Silence.ts`, `Uplink.ts` | P0 判据:`audio_counters.sent ≈ 时长 / 20 ms` |
| 开场指令上限 | 8,192 字 | `RealtimeTransport.ts:144` | 只装规则;代码算余量 |
| 开场指令能被读到的窗口 | 24/34/38 s 能;510/798 s 不能(n=5) | `bridge-hl.mjs:791` | 内容不放里面 |
| 交办到它说出「我打算干什么」 | 7.8 s(1 次) | B §6.4.0b | 不定阈值;只说明 commentary 是可念的 |
| Discord 消息上限 | ≈2,000 字(1,800 截) | TivPresenter | relay / 回执卡预算 |
| 语音批准词表 | 确认 / 对;不对 / 取消 / 不批 | `voice-approval-source.ts:17–18` | 它念完编号后**只**认这几个词;其余 unclear 不写 |
| P-6c(v2 + Discord 30 min 静默) | 过(n=1),但**桥侧一直在送静音** | B §3.1d | P0 是它没测到的那格 |

---

## 6. 方案对比(按部件;⭐ = 取向;反面照写)

| 部件 | 候选 | 取向与理由 |
|---|---|---|
| 状态进耳机 | A1 brain→文件 inbox / A2 voice 读 Discord / A3 voice 调 Bridge | ⭐ A1:同族契约;2030 未落地时 fixture 可喂;A2 抢 2030 的活;A3 寄生 flywheel |
| 它开口 | 全走 `appendSpeech`(内容随触发) / 开场走 startInstructions | ⭐ 前者:§1.3 的衰减证据;后者几分钟后就忘 |
| 存活信号触发 | 代码定时器 → appendSpeech / 模型自觉 / 只响 bed | ⭐ 代码定时器:「没说话」和「死了」必须由模型之外的东西区分;bed 只作旁证 |
| 筛选规则存储 | memory 仓 JSON(代码应用)/ MEMORY.md 散文(模型自觉)/ state dir | ⭐ memory 仓 JSON:可测、可审、不绑 vendor、她能改;散文 = 检测器自证 |
| 她的话落地 | outbox+回执+代码发 Discord / 模型自己 gh·curl 发 / Bridge mailbox | ⭐ outbox:核对在模型够不着的一侧(1911 `verify()` 形状);后两者要么自证「已转告」,要么她看不见 |
| 念专名编号的门 | 代码核转写(user)+ 核念出(assistant)/ 提示词叫它念 | ⭐ 代码核:提示词版是表演(B §5.6.4) |
| 用嘴批 ship | 可选端点适配器 → Bridge `/api/voice/ship-approval` / Raya 发文字让 Bridge 认 / 直改 CommDB | ⭐ 适配器:同一写入原语;文字路身份不对;直改绕过原语 |
| outbox 位置 | 新 writable root / memory 仓 gitignored / state dir | ⭐ 新 root(§4) |
| 模型的动作接口 | 写 outbox 文件(shell)/ 给 Codex 挂 MCP server | ⭐ 文件:1911 验过、零新进程;MCP = 新进程 + socket 通信,本单不需要 |

---

## 7. 会过期的结论

| 结论 | as-of | 重核 |
|---|---|---|
| `appendSpeech` 落地为 `[BACKEND]` 前缀的 user 消息 | Codex 0.149.1,P5 2026-08-26 | 重跑 `probes/p5-busy.mjs`,看 itemAdded 第一条 |
| 交办工具名 `background_agent`;`handoff_request` 带 `input_transcript` | 同上 | 同上 |
| 开场指令 8 分钟后读不到 | 1911 8-21,v2,n=5 | 有更新的 Codex 版本时,用 `bridge-hl.mjs` 的 5 场方法重跑一次 |
| Bridge 守卫顺序与词表 | flywheel `e33f87d70` | `sed -n '322,520p' packages/teamlead/src/bridge/voice-routes.ts`;`voice-approval-source.ts:17–18` |
| voice Discord client 没有 MessageContent intent;`announce` 只到 `#raya` | raya `b7abff4` | `grep -n Intent apps/voice/src/discord/DiscordAdapter.ts` |
| 生产 writable roots = code + memory | raya.env 2026-08-27 | `grep WORKSPACE ~/.flywheel/raya/raya.env` |
| FLY-2030 尚无代码 | 2026-08-27 17:30 PT | `git -C ~/.flywheel/raya/worktrees/raya-FLY-2030 log --oneline origin/main..HEAD` |
