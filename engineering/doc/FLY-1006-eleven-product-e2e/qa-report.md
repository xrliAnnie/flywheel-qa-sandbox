# FLY-1006 /eleven 产品实测 — QA 验收报告

Issue: FLY-1006 (URL 不可得,只写 issue 号)
日期: 2026-07-09
基于: plan.md §6/§7、evidence/*.md、PR #529 @ f4528918

## 结论（RE-TEST round 3 · 2026-07-10 · head 8bc01122 → 需 doc kickback）

本轮 implement 改动 = 纯文档 + rig 换档（脑 haiku→sonnet），无 src 代码改。
**代码/机制侧 PASS**：无 src 改 → 单测 226/226 仍绿；被收编的 `e2e/p6-live-venue.mjs`
lint 清；sonnet 机制确认为真（shim env `FLY980_MODEL=sonnet`）；qa-report ③ 音频证据
收窄我认同。**但发现一处 founder 面 doc 不准 → 按 Lead 指示走 doc kickback**：

### 独立复测 sonnet 延迟（VC 空出来后补测；FLY-1065 并发 QA 停后）

`e2e/eleven-voice-loop.mjs` audio 腿（同 529 房、同 agent、同探针、shim=sonnet），
session `conv_8801kx71kpvqfe2vsd5mag8ajkqp`，first_audio.sinceSpeechEndMs 逐轮：

| 来源 | speech-end→首音（ms） | 中位 | load |
|------|----------------------|------|------|
| implement（founder-report 依据） | 3913 / 9540 / 3034 / 3377 | ~3.6s | ~5.8 |
| **QA 独立复测（本轮）** | **6089 / 4519 / 4741 / 5589** | **~5.2s** | **~16** |

**结论**：核心成立——sonnet（4.5-6s）确比 haiku（8-10s）快近一半，机制真实，audio 腿
全 PASS。**但 sonnet 延迟对机器 load 敏感**：implement 的「典型 3-4s」是低 load(~5.8)
下的乐观数，正常 load(~16) 下实测中位 ~5.2s。Annie 的 #1 抱怨就是慢——报告数不能比她
终验体验乐观。

### Doc kickback（Lead bcc7b4dc 后续指示：pre-ship 硬改）

`founder-report.html` 现写「典型 3-4 秒（偶发长尾）」→ **须改为如实标 load 依赖**：
「低 load 3-4s / 正常 load ~5s，都约为 haiku(8-10s) 的一半」。同处的延迟对照表/预期管理
文案一并对齐。**代码层 PASS 不动**；implement 只改这一句 doc → QA 复验 doc → 放行。

> P6 状态：Annie 首场（haiku）已发生、结论「非常非常慢」；sonnet 复听（终验）由 Lead
> 定时段（她在忙 fleet 复活，暂缓）。venue 保活中（pid 20451、:9885 ok、Jason+cue）。

---

## 结论（RE-TEST round 2 · 2026-07-10 · head 85b507a8）

**PASS（代码侧）** —— round 1 的两个 Blocker（waiting-cue B1/B2）已由 implement 修好
（commit `6639d82e`），我在**新 head 真机复验**通过：cue 每次都在 speech_end 后响、
每个 cue_stop 都配对到 barge-in 或真答案、agent 音频没被掐；单测 226/226（我的 2 条
RED 测试转绿 + implement 补的 7 条）；lint 清（唯二 error 是别的 runner 的
`.flywheel/runs/*/land-status.json` 运行时产物，git-ignored、不进 CI）。round 1 我标的
两个低优先项（credits 台账缺口、founder 报告 cue 说法）implement 也一并修了。

**仍未满足（非代码，Lead/founder 项）**：**P6 = Annie 本人进 VC 真机对话**（M2 的
体验验收主体）尚未发生，`evidence/m2-vc-e2e.md` 不存在。plan §6 明确「Annie 体感结论
不代验，终审在她」——所以这条 PASS 是**代码/机器可验全链**的 PASS；Annie 在语音房的
真实体验 + /eleven 去留决策，是她在 approve gate 上的事。全链本身我已真机跑通两遍
（VC→平台听写→Claude 脑→TTS 回放→打断，见下），三维数据在 evidence + founder 报告。

> round 1 的 FAIL 详情保留在下方「一、二」节作为历史；round 2 的复验见「零」节。

## 零、RE-TEST round 2 — cue 修复真机复验（head 85b507a8）

### implement 的修法（我核对过 diff）

- **B1**：`onSpeakingEnd` 的 cue 门去掉了 `!suppressed`（cue 改用独立 `cueOn` 状态）。
  `suppressed` 的语义是「丢弃死 turn 的迟到 chunk」，本就不该门掉「founder 说完在等
  答案」的等待音——这是根因修法，不是打补丁。
- **B2**：`stopCue()` 挪进 `onAudio` 的「首帧」分支（`!turnOpen`）且加 `cueOn` 守卫，
  不再每帧都 `player.stop()`；wiring 新增 `makeWaitingCue`，用 player 的 `idle` 事件
  让 1.4s clip **循环**填满 ~9s 等待（plan §4 的循环要求），`on` 守卫保证 stop 后不再
  重播。cue 与嘴共用 player，但 stop 只在 cue 自己 on 时碰 player——结构性安全。

### 单测（我的 RED 测试现在转绿）

| 测试 | round 1 | round 2 |
|------|---------|---------|
| `qa-fly1006-waiting-cue.test.ts` D1（真 EarsReceiver 驱动一句 2s 话→cue.starts===1） | RED | **GREEN** |
| `qa-fly1006-waiting-cue.test.ts` D2（真 AssistantSpeaker 共享 player→turn 中途不 stop） | RED | **GREEN** |
| voice-bridge 全套 | 217/217 | **226/226**（+我 2 +implement 7） |

### 真机复验（新 head，`e2e/qa-cue-verify.mjs`，开启 waitingCuePath）

生成一段 1.4s 双 blip cue clip，跑真 VC 会话、注入中文探针，从 session jsonl 断言
（fail-closed，回合感知）。跑了两轮，VAD 把探针切成 1~2 段说话、cue 回合数随之不同，
**两轮行为都正确**：

| 捕获 | jsonl 事件序（节选） | 判定 |
|------|---------------------|------|
| run 1（1 回合） | `speech_end cue_start user_transcript cue_stop first_audio` | cue 覆盖整段等待、真答案一到即停 ✓ |
| run 2（2 回合） | `speech_end cue_start cue_stop⟨被再次 barge-in 停⟩ … speech_end cue_start user_transcript cue_stop first_audio` | 两次等待各起一次 cue，一次被 barge-in 停、一次被答案停 ✓ |

三条断言全过：**① B1** cue 每次都在 speech_end 后响（新 head 上 `suppressed` 不再门掉
它）；**② B2** 每个 cue_stop 都配对 barge-in 或答案、答案侧 cue_stop 紧邻 first_audio；
**③** 录播 VC 音频 3.8MB / 4.9MB（rms 0.056/0.064）非静音。留档 `~/fly1006-eleven/`
外 + `/tmp/fly1006-qa/cue-verify*.log` + 两份 session jsonl（`fly1006-cue-state-*`）。

> 证据口径收窄（implement 阶段代注，Codex 增量 review R2 LOW）：③ 的录音含 cue
> 自身的声音，总字节/rms **不能独立证明** agent 回答没被掐——「B2 不掐音频」的硬证
> 据是 ② 的 jsonl 事件序（每个 cue_stop 配对 barge-in 或紧邻 first_audio，答案播放
> 期间零 cue 事件）+ D2 单测；③ 仅作「房间里确实有声音」的辅证。

> 复现（cue 开启）：`CUE_WAV=<clip> ...（其余 env 同 m2-staged-venue.md）node e2e/qa-cue-verify.mjs`。
> 注：第一轮我的断言假设「单回合」误判 2 回合运行为 mistimed——那是我断言过严，非
> 代码缺陷；已改成回合感知，对两份真机 jsonl 离线复核均 PASS，harness 随本报告提交。

### 无回归

- mutex 腿新 head 复跑 PASS：/gemini 持房→/eleven founder-facing 拒入
  （「有一场 /gemini 正在进行(9e2e1cc7-…),先结束它再开新的。」）。
- cue-verify 本身即一条完整音频腿（探针→平台听写→Claude 脑→TTS→VC 回放→barge-in），
  在新 head 上真跑两遍，非 cue 路径行为未变。

---

## （以下为 round 1 历史记录）

round 1 结论：**FAIL(kickback)** —— 机器可验的那一半(P5)独立复跑全绿、fail-closed 负向
对照真红;但 waiting-cue 代码坏了(B1 永不响 + B2 开启掐音频),两个缺陷 RED 测试钉死。
详情见下。P6 当时同样未发生（round 2 仍未发生，见「结论」节）。

## 一、独立复跑:真机 S8 staged venue(P5)—— 全绿

全部在真 Discord 529 房、真 ElevenLabs agent、真 shim + 隧道 + claude 脑上跑,
exit code 为准。rig 复用 m1-rig.md 的 `agent_2401kx1say3vf988f28x07bhbwkt`,
GET 回读逐字核对通过(custom_llm→隧道、`tts.agent_output_audio_format=pcm_24000`、
`soft_timeout_config.timeout_seconds=-1`、`platform_settings.overrides.custom_llm_extra_body=true`)。

| harness | 覆盖 | exit | 结果 |
|---------|------|------|------|
| `e2e/eleven-staged.mjs`(leg 0) | 真 bots + 真 daemon + /eleven autostart 起一轮 | 0 | PASS |
| `e2e/eleven-voice-loop.mjs` `LEGS=mutex` | /gemini 持房 → /eleven founder-facing 拒入 | 0 | PASS |
| `e2e/eleven-voice-loop.mjs` `LEGS=audio` | 注入 WAV→STT→claude 脑→TTS→VC 回放 + barge-in 停播 + 存活 | 0 | PASS |

- mutex 腿真落频道的话术:「有一场 /gemini 正在进行(a661b95a-…),先结束它再开新的。」
- 音频腿:`leg 1 IN` 1 条 user_transcript;`leg 1 OUT` 1,820,160 bytes,rms=0.0772(非静音);
  `leg 2 STOP` barge-in 后 **+0 bytes** 尾巴;`leg 2 SURVIVAL` transcript 2→4。
- 平台会话 `conv_1101kx4hev62eaztj615x9y5xya2`,M2 硬门断言实报
  `agentOutputAudioFormat=pcm_24000` + `userInputAudioFormat=pcm_16000`;
  `droppedLateChunks=0`;`turn_end reason=gap` 兜底真跑。
- 延迟(speech-end→真答案首音,冷 claude -p,无垫话配置):9089 / 8173 / 9377 / 10582 ms
  (n=4,中位 ~9.2s)。取证时 load ~51(GUI 侧 WindowServer/tmux 占大头),
  比实现阶段的 load ~6-7 慢约 1s,量级一致。

**fail-closed 负向对照(证明 harness 不会假绿)**:

| 注入的故障 | 期望 | 实测 |
|-----------|------|------|
| `ELEVEN_SHIM_HEALTH_URL` 指死地址 | exit 1 + VERDICT FAIL | exit **1**,`VERDICT: FAIL — no live /eleven session evidence (live=false metadata=false)` |
| `STAGED_HEALTH_PORT=9878`(生产端口) staged | exit 2 拒跑 | exit **2** |
| `STAGED_HEALTH_PORT=9878` voice-loop | exit 2 拒跑 | exit **2** |

留档:`/tmp/fly1006-qa/`(leg0/mutex/audio/负向对照 全量日志 + 录播 PCM + session jsonl)。

## 二、缺陷(FAIL 的理由)

### B1 [Blocker] 「处理中音效」在语音房永远不会响(D1)

`EarsReceiver` 的 backchannel 闸门在**任何**持续 >350ms 的说话里都会打
`onBargeIn` —— 它并不知道 agent 有没有在说话。`/eleven` 把它接到
`interrupt("local")`,于是 `ElevenSession.suppressed = true`;而 `suppressed` **只**
由平台的 `user_transcript` 清除,那条消息比 speaking-end 晚约 9 秒到。所以

```ts
opts.ears.onSpeakingEnd(() => { … if (!this.turnOpen && !this.suppressed) opts.cue?.start(); })
```

里的 `!this.suppressed` 在生产里恒为 false,`cue.start()` 永不执行。

**真机铁证**(本次音频腿 session `dc290a0f` 的 jsonl,时间轴):

```
+ 0.0s  session_live
+ 5.8s  interruption source=local     ← 她第一次开口就触发(此刻 agent 从没出过声)
+ 7.5s  speech_end                    ← cue.start() 在这里被 suppressed 门掉
+18.4s  user_transcript "帮我看一下,哈豆模式今天能不能用?"   ← suppressed 到这才清
+18.5s  first_audio sinceSpeechEndMs=9089
```

整段 trace 里**每一个** `speech_end` 前面都先有一条 `interruption source=local`。

现有单测 `eleven-session.test.ts:84`「speaking-end → waiting cue」之所以绿,是因为
它单独触发 speakingEnd、不触发 barge-in —— 这个顺序在生产里不存在。

### B2 [Blocker] 音效一旦打开,会把 agent 的声音掐断(D2)

`eleven/wiring.ts` 让音效和嘴共用同一个 player:

```ts
const speaker = new AssistantSpeaker({ player: deferredPlayer.player, … });
const cue = { start: () => deferredPlayer.player.play(…), stop: () => deferredPlayer.player.stop() };
```

而 `ElevenSession.onAudio()` 对**每一个** audio chunk 都调 `cue?.stop()`:

```ts
this.opts.cue?.stop();          // ← 每帧都 player.stop()
if (!this.turnOpen) { this.opts.speaker.beginTurn(); … }
this.opts.speaker.feed(chunk);  // 第一帧才 player.play(turn stream)
```

第 1 帧开流播放,第 2 帧起 `player.stop()` 就把刚起的 turn stream 停掉,
`AssistantSpeaker` 还在往一个没人读的 PassThrough 里写 —— 结果是 agent 只出一瞬
的声音。今天没炸,**只因为没有任何配置设了 `waitingCuePath`**(`cue === undefined`,
`cue?.stop()` 是 no-op)。但 `e2e/eleven-staged.mjs:86` 已经把 `STAGED_WAITING_CUE`
env 开口暴露出去了 —— 这是个上膛的枪,不是惰性的接口。

### 复现

```bash
pnpm --filter flywheel-voice-bridge exec vitest run src/__tests__/qa-fly1006-waiting-cue.test.ts
# D1: expected 1, received 0            (cue 永不 start)
# D2: expected [ 'stop', 'stop' ] not to include 'stop'   (turn stream 起播后又被 stop)
```

### 修法建议(implement 阶段决定,QA 不代改)

两个方向二选一,别留半成品:

1. **修好**:① cue 的门改成「turn 未开 且 本轮还没起过 cue」,不要复用
   `suppressed`(它的语义是「丢弃死 turn 的迟到 chunk」,和「founder 说完了在等答案」
   是两件事);② `cue.stop()` 只在 `!this.turnOpen` 的那一帧调(或让 cue 走独立
   player / 让 `AssistantSpeaker.beginTurn()` 自己负责停 cue)。
   ③ 顺带:plan §4 要求音效**循环**至真答案 onset,现在 `player.play(file)` 是一次性的,
   1.4s 的 clip 填不满 ~9s 的等待 —— 循环形态要一起定。
2. **拆掉**:config 的 `waitingCuePath`、wiring 的 cue、`STAGED_WAITING_CUE`、
   `eleven-session.test.ts` 里那条会误导人的 cue 断言,一起删干净,
   founder report 的 follow-up 条目改成「未接线」。

我倾向 (1):S9 是 Annie 的验收会话,而「说完话到听到回答 ~9 秒的干等」正是她
反馈② 的原话。这一轮把它修对,S9 才有意义。

## 三、P6 / M2 验收缺口(非代码缺陷)

- issue 的验收写明「M2 = VC 真机 E2E 全链跑通 + 三维数据报告」。
- plan §S9 的 evidence 落点 `evidence/m2-vc-e2e.md` **不存在**;progress.md 自述
  「S9 Annie VC held by Lead (OOM recovery), rig kept alive」。
- 所以:机器可验的 P5 我已复跑全绿,但 **P6 未发生 ⇒ M2 验收未满足**。
  这条不由 QA 代验(plan §6:「Annie 体感结论不代验,终审在她」),但必须如实标出来。
- rig 现在是活的(shim :8980 健康、cloudflared 隧道通、agent 配置回读一致),
  Annie 随时可以开 S9。

## 四、其余验收项 —— 全部 PASS

| 项 | 判据 | 实测 |
|----|------|------|
| 单测 | voice-bridge 全绿 | 217/217 PASS(含 eleven 33 条) |
| 单测 | voice-core 零回归 | 196/196 PASS |
| 单测 | spike(talk 页) | 14/14 PASS |
| lint | 全仓 biome | 本分支代码零 error/零 unused import。唯一 1 个 error 落在 `.flywheel/runs/fe4f9333-…/land-status.json` —— 别的 runner 的运行时产物、被 `.git/info/exclude` 排除、不进 CI |
| CI | PR #529 | `Build & Test: SUCCESS`,`mergeable=MERGEABLE state=CLEAN` |
| P1/P2 M1 talk 页抽验 | 三个 Lead 各真 mint 一次 signed-url | 3/3 `http:200`,host=`api.elevenlabs.io`;voiceId 与 m1-rig.md 逐字一致(Eric/Sarah/Alice);persona prompt 非空(210/208/184 字) |
| 安全 | key 绝不外泄 | signed-url 响应体内无 key;`GET /` 页面内无 key;非法 lead → `400` |
| P4 分钟池 | API 侧独立复现 | 本次快照 `convai_characters_per_minute: null` —— 坐实「单一 credits 池」。dashboard 视觉核查仍待 Annie 一瞥(m1-minutes-pool.md 已如实标注) |
| byte-compat | /eleven 关闭时不改变 967 行为 | `cli.ts` 的 `if (assistant \|\| eleven)` 守卫成立:两者皆 off ⇒ 不挂 ears;`assistant-wiring.test.ts` 有 `assistant: null keeps the daemon byte-compatible` + 「shared room ⇒ NO second ears」用例 |
| S5b 结构性重构 | /gemini 行为保持 | /gemini 现有全部用例零红;`onBargeIn` 对 /gemini 仍是无消费者的 no-op |

## 五、低优先(不阻塞,记账)

1. **credits 台账有缺口**(P8「每步可归因」):`credits-ledger.md` 最后一行 `s8-post = 13,958`,
   但我开跑前的实测快照是 **14,458**(+500 未记账)—— 那是实现阶段 15:29「Codex R1 修复后
   复跑」真花的 credits,m2-staged-venue.md 用散文写了、台账没进表。
   本次 QA 复跑再花 **+998**(14,458 → 15,456)。
   实际累计 = 15,456 − 7,451 = **8,005**(占 1.5 万预算 53.4%),仍在预算内。
   建议补两行,并在 founder 页把 6,507 更新为实数。
2. **`ElevenCommand` 里的重复 release**:`startSession` 抛错时 `ElevenSession.stop()` 已经
   `slot.release()` 过一次,`ElevenCommand` 的 catch 又 release 一次。当前无害
   (`SessionSlot.release()` 按 mode+holder 精确匹配,第二次返回 false),但语义上是把
   「谁拥有 slot」写成了两处。属可读性/健壮性,非缺陷。
3. **`suppressed` 只由 `user_transcript` 解除**:若某次 local barge-in 之后平台把那段音频当
   噪声丢掉、始终不出 `user_transcript`,session 会一直丢 agent 音频(`droppedLateChunks`
   持续增长)直到下一次被识别的说话。单人场景下本次真机 4 轮全部正常自愈;多人混流
   (plan R8,本单 out of scope)下值得警惕。

## 六、复现命令(全部 QA 步骤)

```bash
# rig 核对(不打印 key)
set -a; . ~/.flywheel/.env; set +a
curl -s -H "xi-api-key: $ELEVENLABS_API_KEY" \
  https://api.elevenlabs.io/v1/convai/agents/agent_2401kx1say3vf988f28x07bhbwkt | jq '.conversation_config.tts'
curl -s -m 3 http://127.0.0.1:8980/health           # shim
curl -s -o /dev/null -w '%{http_code}\n' https://rear-taken-ted-everybody.trycloudflare.com/health  # 隧道

# 单测 / lint / build
pnpm --filter flywheel-voice-core build && pnpm --filter flywheel-voice-bridge build
pnpm --filter flywheel-voice-bridge test          # 217/217
pnpm --filter flywheel-voice-core test            # 196/196
(cd engineering/spike/FLY-1006-eleven && node --test)   # 14/14
pnpm lint

# RED 测试(本报告的 B1/B2)
pnpm --filter flywheel-voice-bridge exec vitest run src/__tests__/qa-fly1006-waiting-cue.test.ts

# 真机三腿 + 负向对照(env 同 m2-staged-venue.md,记得 unset 生产 FLYWHEEL_BRIDGE_URL/API_TOKEN)
node e2e/eleven-staged.mjs
ELEVEN_LOOP_LEGS=mutex node e2e/eleven-voice-loop.mjs
ELEVEN_LOOP_LEGS=audio node e2e/eleven-voice-loop.mjs
ELEVEN_SHIM_HEALTH_URL=http://127.0.0.1:59999/health STAGED_HOLD_MS=15000 node e2e/eleven-staged.mjs  # 期望 exit 1
STAGED_HEALTH_PORT=9878 node e2e/eleven-staged.mjs                                                   # 期望 exit 2

# M1 talk 页抽验
cd engineering/spike/FLY-1006-eleven
FLY1006_AGENT_ID=agent_2401kx1say3vf988f28x07bhbwkt FLY1006_PORT=8996 node serve.mjs &
curl -s "http://127.0.0.1:8996/api/signed-url?lead=tadashi" | jq '{host: (.signedUrl|split("/")[2]), voiceId: .lead.voiceId}'
```
