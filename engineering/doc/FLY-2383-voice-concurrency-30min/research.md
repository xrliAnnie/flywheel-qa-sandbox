# FLY-2383 语音并发半小时实测 — 调研

Issue: FLY-2383 (https://linear.app/geoforge3d/issue/FLY-2383/raya语音实测-prd-1850-73-未量的那一半真实-runner-编排在跑-语音在流-半小时量级-不挂-founder工程自测)
日期: 2026-09-06
基于: exploration.md

---

## 0. as-of 表(所有数字都会过期,读的时候先看这里)

| 探点 | 值 | 探于 |
|---|---|---|
| Bridge | `ok:true`,`sessions_count: 9`,`buildSha b198edcf`,`admissionPause.active:false` | 2026-09-06 ~23:22Z |
| Bridge 只读会话端点 | `GET /api/sessions?mode=live` 需 `Authorization: Bearer $TEAMLEAD_API_TOKEN`;无 token → `{"error":"unauthorized"}` | 同上 |
| 生产 Raya 语音 | `launchctl list` 里 `com.xrli.raya.voice` **PID 为 `-`(没在跑)**;`com.xrli.raya.brain` 在跑(pid 19544) | 同上 |
| Raya 主 checkout | `~/.flywheel/raya/code`,分支 `main`,HEAD `b1b5a64`(= FLY-2249 barge-in v2,#14) | 同上 |
| `apps/voice/dist` | 已构建 | 同上 |
| macOS `say` | 可用:`say -v Tingting -r 180 -o t.aiff` → `estimated duration 2.98 sec`,`audio bytes 131408` | 同上 |
| QA 凭据 | `TEST_BOT_TOKEN_1..4` 四个都在 `~/.flywheel/.env`;`test-slots.json` slot1≠slot2 | 同上 |
| RAYA_ENV_FILE | `~/.flywheel/raya/raya.env`(0600),含 `RAYA_OPENAI_API_KEY` 等 14 个必填键 | 同上 |

---

## 1. 载体判定:529 房能量三个条件里的哪几个

### 1.1 ① 真实 agent turn —— **能**

529 的 criterion 路径本身就是一次真 turn:
`emitter.play(<say 渲染的 aiff>)` → Raya 听见 → 回答 → 一条 `realtime_transcript(role=assistant)`
证据行(`scripts/qa/lib/session.mjs:346-360`)。

> ⚠️ **落盘的 row 里没有 `final` 字段** —— `runtime.ts:1740-1760` 只在 final chunk 时才写这条 row,
> 所以它**本来就是 final-only**。⛔ **不许按 `(role=assistant, final)` 去筛,会一条都筛不到。**
> 关联靠 `kind / role / generation / 文本里的 nonce`(见 plan §1.7)。C4 那一档更硬:Raya 要**读隔离 workspace 里的文件**
才能答出 nonce ⇒ **带工具的真 turn**,不是复述。

⇒ soak 里应当**混两种 turn**:纯问答 + 读文件(带工具)。只跑纯问答会把
「它能不能干活」这一格量成「它能不能张嘴」——那正是 §7.2 已经犯过一次的错。

### 1.2 ② 半小时量级 —— **能,但不能用现成 criteria 跑法**

- Raya 语音进程**没有空闲自动退出**(`apps/voice/src` 里 grep 不到
  `idleTimeout` / `maxSessionMs` / `inactivity`)⇒ 一场连续 30 分钟在形态上成立。
- 但 529 的 full run 是 **15 个独立 voice 生命周期、约 30–45 分钟**,
  每场 `--session-timeout-ms` 默认 **180s**(`orchestrator.mjs:146`)。
  **挂钟够,连续性不够。**

> 🔴 **判定(本单据此设计)**:她的原话是「**我跟你开半小时的会**」。
> **一场连续的会**才是忠实读法。⛔ **把 15 段拼起来叫「半小时」,是用挂钟糊过 §7.3 那一格。**

### 1.3 ③ 真实 runner 编排在跑 —— **能,而且不用我们造**

Bridge 现在就挂着 9 个 session(其中 FLY-2380/2381/2382/2383 都是活的 runner)。
本单要做的不是**制造**编排,而是**在窗内把它记成证据**,并且证明窗内它是**忙的**:

```
GET /api/sessions?mode=live   →  execution_id / status / started_at / last_activity_at
```

> 🔴 **2026-09-06 评审更正(v2→v3)**:我原先写的是「`last_activity_at` 在动才叫忙」——**不够**。
> `mode=live` 的集合含 `pending / ship_parked / awaiting_review / design_done / approved_to_ship`
> (`packages/teamlead/src/operational-terminal-status.ts:15-22`)⇒
> **一个 parked 会话的 `last_activity_at` 在动,不是「编排在跑」。**

⇒ 正确契约(见 plan §1.9):

```
mode=live                 只做【候选发现】,候选筛 candidate.status === "running"
/api/sessions/:id/status  存原始 receipt
合格重叠                   receipt.session_status === "running" && receipt.status === "executing"
```

⚠️ **字段名是两套**:列表响应的 `Session` 只有 `status`(`StateStore.ts:1228-1239`);
`session_status` **只在单会话 `/status` 响应里被追加**(`tools.ts:362-370`)。
⛔ 拿 `session_status` 去筛列表会得到**零候选**。

---

## 2. 等待音那半格:**在 529 载体上是可量的**(这一条推翻了我开工时的假设)

`apps/voice/src/audio/Bed.ts`:

```ts
const BOX_B_NOTES = [261.63, 293.66, 329.63, 392, 440];
/**
 * Annie's approved Honey Lemon prototype waiting sound: music box B,
 * "更疏、更慢、最安静". This is a direct TypeScript port of
 * product/doc/FLY-1911-codex-voice-prototype/prototype/beds.mjs.
 */
export class BoxBBed { ... }
```

⇒ **PRD 里那个「音色 B『更疏更慢-最安静』」的等待音,已经原样移植进 Raya 了。**

| 事实 | 出处 |
|---|---|
| 默认**开** | `config.ts:622` `enabled: voiceOptions.bedEnabled !== false` |
| 可用配置关掉(**不是改代码**) | `RAYA_VOICE_OPTIONS_JSON: {"bedEnabled": false}` |
| 忙够 `minBusyMs`(默认 1000ms)才响 | `config.ts:624` + `runtime.ts:2077 updateBusyBed` |
| 走**下行**(她听的那条),`Downlink.setBedActive` | `pipeline/Downlink.ts:104` |

### 2.1 ⇒ A/B 怎么搭才不是自欺

**两场**、同一条链路、同一批句子、同一配对顺序,只差启动配置 `bedEnabled`
(⚠️ `bedEnabled` 是**启动期**配置 ⇒ ⛔ **切不了同一场内的 A/B**,见 §7 第 5 行):

```
臂 ON (默认)   Raya 忙 → 等待音响着 → 注入 N 句 → 数 realtime_transcript(role=user) 证据行里
                                                    含本轮 nonce 的命中
臂 OFF (对照)  bedEnabled=false → 同样忙、同样 N 句、同一配对顺序 → 同样数法
```

### 2.2 🔴 这个 A/B 量不到的那半,**必须和数字一起写**

等待音走**下行**;而 529 里 emitter 的**上行是一个干净的音频文件**。
⇒ **「她开外放、麦克风把等待音收回去」那条回灌路径,本场仍然量不到。**
这正是 FLY-1911 `decisions.md` 自己标过的边界(「所以它测不到…那种情况」),
本单**不许**用「等待音不影响识别」把它盖过去。

**本单能给的**是:*等待音在下行响着时,上行的话还进不进得来*。⛔ 不多不少。

---

## 3. 🔴 抢话这条路:**FLY-2249 的那个必崩前提,在当前 HEAD 上已经不成立**

> ⚠️ **本节是 2026-09-06 设计评审后的更正。** 更正前我写的是「F1 在当前 HEAD 上仍然带电」——
> **那是错的**,我只核了配置默认值,没核那次 `appendText` 的角色参数。逐字留下这条更正,
> 因为**错的那一版会把本单的观测范围缩窄成「只测不抢话」,还让人以为那是技术必需。**

### 3.1 事实

`engineering/doc/FLY-2249-bargein-v2-platform-trigger/qa-report.md` 的 F1 是:

```
14:43:14.721 barge_heard_note_appended            <- appendText(note, "developer")
14:43:15.402 voice_exit code=1 reason="realtime:Developer messages are not supported for realtime sessions."
```

当前 `main` HEAD `b1b5a64` 上,那一行**已经是 `"user"`**:

| 位置 | 当前内容 |
|---|---|
| `apps/voice/src/runtime.ts:1095-1099` | `this.dependencies.transport.appendText(note, "user", generation)` |
| `apps/voice/dist/runtime.js:748` | `appendText(note, "user", generation)`(构建产物一致) |

`bargeInHeardPositionNote` 默认仍是 `true`(`config.ts:464` / `dist/config.js:260`)——
**但它现在发的是 user message,不是 developer message。**

⇒ **那条确定性崩溃已经修掉了。** ⛔ **不许再拿它当「必须回避抢话」的理由。**

### 3.2 那么本场为什么**仍然**只测不抢话 —— 这是**范围**,不是**规避**

两条理由,都跟崩溃无关:

1. **抢话会污染 turn 测量。** barge 命中会 cancel Raya 当前 response
   (`barge_response_cancelled`)⇒ 那一次 turn 既不算完成也不算超时,把它混进
   「agent turn 完成率」会同时污染分子和分母。
2. **抢话的语义正确性本来就未验。** FLY-2249 那份 QA 报告自己写明:
   `user` 角色只证明了**传输层不报错**,**语义安全性未在真房验过**。
   那是 FLY-2249 的地盘,⛔ 不是本单要顺手结掉的格子。

> ### ⇒ 报告里必须逐字写:**「本场只测不抢话的注入;抢话下的半小时未量。」**
> ⛔ **不许写成「半小时稳定」。** ⛔ **也不许写成「因为会崩所以没测」。**

### 3.3 落地:注入前的静默守卫(仍然要,但理由换了)

barge 只在 Raya **手上有 voice 帧**时才 acted(`runtime.ts:1178`
`else if (!this.hasInterruptibleAudio()) reason = "no_interruptible_audio"`;
`hasInterruptibleAudio` 见 `:1254`,bed 帧**不**置 `lastVoiceFrameAtMs`,已核 `Downlink.ts:200-209`)。

⇒ 只要注入落在 Raya **没有 voice 帧**的窗口里,就不会触发 barge,turn 测量就干净。

🔴 **但「怎么知道它没在说话」比我原先想的难得多** —— 见 §4.1。

### 3.4 仍然先跑 pilot

理由不变(30 分钟跑砸代价大),内容变了:pilot 除了验通,还要**标定尺子**(§4.1)。

---

## 4. 尺子:耳朵端,但**不能只数包**

`probes/c9-voice-emitter.mjs` 的 `createRayaAudioObserver` 给了现成的耳朵:

| API | 语义 |
|---|---|
| `arm(userId, {decodePcm, maxPcmFrames})` | **把 packets/bytes/pcm 全部归零**并订阅该 user |
| `wait(userId, timeoutMs)` | 返回**自 arm 起累计**的 `{packets, bytes, speakingStarts}`(**不重置**) |
| `rayaPcmFrames(userId)` | 带 `atMs` 的解码 PCM 帧环形缓冲(仅 `decodePcm:true`) |

### 4.1 🔴 「数包」量不到「它在说话」——本单最容易犯的口径错误

> ⚠️ **这一节是 2026-09-06 设计评审推翻我第一版量法后重写的。**

`Downlink.ts:188-210` 每个 tick 都往 Discord 写一帧,内容三选一:

```
voice    Raya 真在说         →  置 lastVoiceFrameAtMs
bed      等待音(BoxB)      →  不置
silence  PCM 静音            →  不置
```

⇒ **Discord 那一端收到的是连续流,三种内容都编成 Opus 包。**
`c9-voice-emitter.mjs:185-195` 对每个 chunk 无差别 `packets += 1`,该文件 `:241-243`
自己也写着「Raya sends a continuous stream」。

> ### ⇒ **两条推论,都是硬的**:
> 1. **`packets` 增量为 0 ≠ Raya 静默。** bed 响着、甚至纯静音,包都在涨。
>    ⇒ 我第一版设计的「连续 3 秒 packets 增量为 0 才注入」**永远不会成立**,
>    结果会是**每一次注入都被跳过**,再报一个「Raya 一直在说」的假象。
> 2. **`packets > 0` 只证明【下行传输还在】,不证明【电话里有声音】。**
>    ⇒ 附录里这个指标**必须**叫「下行 Opus 包(含 voice/bed/编码静音)」,
>    ⛔ **不许叫「声音连续」或「没有静音」。**

### 4.2 另一个会毁掉数据的坑:**两条采样线抢同一个 observer**

observer 只有**一组**共享状态(`armedUserId / packets / bytes / pcm / resolveAudio`),
`arm()` 在 `:229-240` 把它们全部清零并换掉 Promise
(现有单测 `c9-voice-emitter.test.mjs:215` 就是在验这个 reset)。

⇒ 我第一版设计里「每分钟 arm 一次切片」和「每次注入前 arm 一次守卫」
**会互相清零**,30 格序列和守卫判定**同时报废**。

### 4.3 ⇒ 现行设计:**旁路解码器 → 精确 PCM framer → seq/单调钟 → 有界 sink → 特征分类**

> 🔴 **这一节写过两版错的,都留在 §4.3x 的纠错块里,⛔ 不许把纠错抹掉。**
> 下面这一版是**当前方案**(plan v4 §1.5)。

```
启动时   arm(rayaBotId, { decodePcm: true, maxPcmFrames: 50 })      ← 全场唯一一次
         注入自造 decoder:decoder.pipe(createPcmFrameTap(onFrame))
onFrame  恰好 3,840 字节(= 960 个 48kHz 立体声采样 = 20ms)
         → 分配 driver 独占的严格递增 seq + performance.now()
         → 立刻抽特征(energy + tonalRatio),【只留特征,不留 PCM】
每 60 秒 wait(rayaBotId, 0) → 累计 packets/bytes 差分 → 「每分钟下行 Opus 包」
```

| 件 | 出处 | 为什么非它不可 |
|---|---|---|
| `createPcmFrameTap(onFrame)` | `c9-voice-emitter.mjs:34-54`,**已导出** | decoder 的 `data` chunk **不承诺**等于一帧(可能含多帧,也可能切在半帧上);它跨 chunk 累积,只在满 3,840 字节时回调。自带 split/coalesced 测试(`c9-voice-emitter.test.mjs:288-305`) |
| `dependencies.createAudioObserver` | `c9-voice-emitter.mjs:371` | 注入点,让 driver 能塞自己的 decoder |
| `options.createDecoder` | `c9-voice-emitter.mjs:131-134` | 同上 |
| `prism-media` 从 **raya dependency root** 解析 | `c9-voice-emitter.mjs:15-31` 的写法 | **flywheel 根 `require.resolve("prism-media")` 是 NOT_FOUND**(评审实测)⇒ 必须 `createRequire(<harnessRoot>/apps/voice/package.json)` |

- ⛔ **永不调用 `rayaPcmFrames()`** —— 那个环形缓冲正是游标问题的来源。
- `wait()` **不重置**,只有 `arm()` 才重置 ⇒ 两条线互不干扰。
- **立体声必须先定死**:3,840 字节是 interleaved stereo(L,R,…,960 采样/声道)。
  取**一路 960 采样的 mono 序列**;Goertzel 采样率 48,000 Hz、N = 960。
  ⛔ **不许把 1,920 个交错采样当 48kHz mono** —— 五个目标频率的解释会直接错。

**分类四档,`unknown` 是一等公民**(⛔ 不许强行三分):

```
energy < silenceFloor                                  → silence
tonalRatio ≥ bedTonalMin  且 energy ≤ bedEnergyMax      → bed
energy ≥ voiceEnergyMin  且 tonalRatio ≤ voiceTonalMax  → voice
其余                                                    → unknown       ← 守卫按「可能是 voice」处理
```

`tonalRatio` = 对 BoxB 五音 `[261.63, 293.66, 329.63, 392, 440] Hz`(`Bed.ts:2`)做 Goertzel 的能量占比。

标定 / holdout / 负对照 / **mixed-duck 过渡** / quiet-voice 见 plan §1.5.3。

#### 4.3x 纠错留痕(⛔ 不许删)

| 版本 | 我当时写的 | 为什么错 |
|---|---|---|
| **v1** | 每 60 秒 `arm→睡→wait` 切片;「连续 3 秒 packets 增量为 0 才注入」 | ①下行是**连续流**,bed 和编码静音同样计包 ⇒ 「增量为 0」**永不成立**,每次注入都会被跳过;②每分钟的 `arm` 和守卫的 `arm` **会互相清零** |
| **v2** | 每 3 秒 `rayaPcmFrames()` + 按 `atMs` 游标去重;单一 RMS 三档 | ①帧上**没有序号**,`atMs` 默认是 `Date.now`(`:127-130`),**既不唯一也不单调** ⇒ `>` 丢帧、`>=` 重复,**都不报错**;②BoxB 有衰减包络、`Mixer` 还会 duck bed ⇒ **RMS 区间会重叠**,quiet voice 会被判成 bed/silence |
| **v3** | 在 `decoder.on("data")` 里 `seq++`,把 chunk 叫「一帧」 | Node stream **不保证** chunk 边界 = 帧边界;`frameSize:960` 是解码器配置,不是回调契约 |

### 4.4 连接生命周期:只报**真能观测到**的

⚠️ **两条「看起来有、其实没有」的证据,已被评审剔除**:

| 曾经写过 | 为什么剔除 |
|---|---|
| `meeting_container_starting` / `_live` | 只在 **meeting 配置路径**产生(`runtime.ts:548-668`)。标准 529 场没有 meeting context ⇒ **N/A**。⛔ **把「没出现」记成「掉线 0 次」是凭空造稳定性** |
| receiver stream error / end | `audioError` 是 `createRayaAudioObserver` 的**私有变量**,`loginDiscordEmitter` **不暴露**;且 `packets>0` 后 `wait()` 会先返回 snapshot(`:246-256`),后续 error 根本走不到那个检查 ⇒ **我们没有这个 guard**,⛔ 不许声称有 |

**本场真能用的**:

| 证据 | 读出什么 |
|---|---|
| 本次 boot 的 fresh `voice-session.json` Live receipt | 会话真的起来了(含 `processGeneration`) |
| child 进程 lifetime / `voice_exit` (`code`/`reason`) | **退没退出**(`runtime.ts:786-790`) |
| Discord voice-state join/leave(emitter 订阅) | 谁进谁出 |
| **driver 旁路监听到的 decoder error** | 解码链断没断(这是我们**自己**挂的,所以看得见) |
| **packet / PCM 停止推进 + 逐秒桶空洞** | 传输有没有断档 —— **fail closed 的主判据** |
| `audio_clock_stall` (`reason`/`outcome`) | 上行时钟卡顿,**实时吐**(上限 100 条) |

⚠️ 且要写清楚:本场观测的是「**进程退没退出 / 传输断没断**」,
**不是**产品内部的 reconnect 逻辑。⛔ 两者不许合成一个「掉线/重连」数字。

### 4.5 被测进程自报的 `audio_counters` 仍然要收,但只当**总账**

`runtime.ts:2170` 的 `audio_counters` **只在 `finish()` 收尾时吐一次** ⇒ 切不了片。
> 🔴 **2026-09-06 评审更正**:我原先写它是「voice/bed/silence 的成分总账」——**错的**。
> `Downlink.ts:211-214` 对**所有非 voice 帧一律记 `silence`**,**bed 没有独立 counter**。
> ⇒ 它最多是 **voice vs 非 voice** 的总账,⛔ **验证不了 bed 的秒数**。

它仍然要收,但只当**voice / 非 voice 的总账**,和耳朵端互为对照:

```
耳朵端   连续性(她那一端听到的传输有没有断)+ 四档分类(voice/bed/silence/unknown)
自报账   voice vs 非 voice 的总帧账 —— ⛔ 不含 bed 的独立计数
```

---

## 5. 仓库边界(**已 ask Lead,question c9d638ee;默认走 A 不停工**)

driver 需要 raya 仓的三样:
`scripts/qa/lib/env-compose.mjs`(组 env)、`scripts/qa/lib/session.mjs`(`spawnVoiceProcess`)、
`probes/c9-voice-emitter.mjs`(`loginDiscordEmitter` = 耳朵)。

| 方案 | 好处 | 代价 |
|---|---|---|
| **A(默认)** driver 放 flywheel `scripts/`,用 `--harness-root` 动态 import,沿用 `CONTRACT_VERSION` 握手 fail-closed | 单 PR;**raya 一行不改**(符合「不改语音管线/不动生产 Raya」) | 跨仓 import raya 内部模块,raya 改结构会漂 |
| B driver 放 raya `probes/`(P-6 / fly2178 / fly2031 的既有家),flywheel 只出文档 | 家更正;有 FLY-2249 先例(raya #14 + flywheel 锚 PR #1035) | 两个 PR,本节点 `complete` 只收一个 PR 号 |

**2026-09-06 评审已裁:走 A。** 逐字:「lifecycle parity 要求的是**运行契约等价**,
不要求 driver 物理上住在 Raya 仓」。

> 🔴 **但我原先这句话说过强了,更正在此**:
> ~~「soak driver 沿用同一道握手,握手不上就 exit 78,不会静默跑在漂过的 harness 上」~~
>
> `CONTRACT_VERSION` 是 **529 场景协议**的版本,**不保证**我们直接 import 的那些**内部函数**
> 在语义调整时一定 bump。路径 / 导出被删会 import 失败,
> **但签名兼容下的语义漂移不会被握手挡住。**

⇒ **A 的附加条件(plan §1.10)**:preflight 阶段锁定 harness 与 subject 的
realpath、**完整 git SHA**、dirty bit、dist SHA-256;
**两者必须 clean 且 HEAD == 预期完整 SHA(本单 = `b1b5a64`),否则 exit 78**;
要跑别的 SHA 必须显式传 `--expected-*-sha`。⛔ 不许只在事后 manifest 里发现跑错了 SHA。

---

## 6. 最接近的先例:**P-6 就是「静的那一场」**

`~/.flywheel/raya/code/probes/p6-lifetime-concurrency.mjs`(185 行)——
PRD §7.3 里那句「**P-6 那场半小时【不算】,它是静的**」指的就是它。

它做了什么:

```js
const durationMs = Number(process.env.PROBE_DURATION_MS ?? 1_800_000);  // 30 分钟
scheduleAudio();                       // 每 20ms 灌一帧【静音】
heartbeatTimer = setInterval(heartbeat, 30_000);
brainTimer     = setInterval(brainCheck, 30_000);
await ask("start", "请只回答:P6开始。不要执行工具。");
// ... 等到剩 60 秒 ...
await ask("final", "请只回答:P6三十分钟后仍正常。不要执行工具。");
```

### 6.1 P-6 与本单的逐格差

| | P-6(不算) | FLY-2383(要算) |
|---|---|---|
| 时长 | 30 分钟 ✅ | 30 分钟 ✅ |
| 送的音频 | **静音帧** | **真房里的真语音**(Raya 下行 + emitter 上行) |
| turn | **2 次**,且逐字写「**不要执行工具**」 | **周期性真 turn,含带工具的** |
| 房间 | **没有 Discord 房** | **529 房** |
| 编排 | **无** | **live 候选 + `/status` 出现 `executing` 的窗内重叠** |
| 等待音 | 无 | **bed ON/OFF 双臂** |

> ### 🔑 **P-6 的形状是对的,内容是空的。** 本单 = **P-6 的骨架 + 忙的内容**。
> ⇒ 这也解释了为什么 §7.3 明写「静的半小时不算」——**不是挑刺,是 P-6 真的把工具关掉了。**

---

## 7. 还剩的未知(带进 plan,不假装已知)

| # | 未知 | 打算怎么办 |
|---|---|---|
| 1 | 一场 30 分钟里 Realtime 会不会自己断(平台侧 session 上限) | pilot 只能验 5 分钟;正场若断,**断了就如实记**,这本身就是 §7.3 要的答案之一 |
| 2 | 注入间隔取多少 | 先按 ~90–120s 一次,pilot 后按实际答复时长调;**间隔要写进报告**,⛔ 不许事后调 |
| 3 | 机器休眠 | 正场前确认 `caffeinate` 或电源设置;跑砸就重跑,不外推 |
| 4 | 第三人闯房中止 | 529 房是 QA 房;guard 触发就作废重跑,**不许把半场当整场** |
| 5 | bed OFF 臂要不要单独一场 | 同一场内切不了(`bedEnabled` 是启动期配置)⇒ **OFF 臂必然是第二场**;两场必须写明是两场 |
