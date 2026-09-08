# FLY-1850 实测附录 — §7.3「并发」那一格(FLY-2383)

Issue: FLY-2383 (https://linear.app/geoforge3d/issue/FLY-2383/raya语音实测-prd-1850-73-未量的那一半真实-runner-编排在跑-语音在流-半小时量级-不挂-founder工程自测)
日期: 2026-09-06
基于: prd.md §7.1–§7.3 / §11.2,engineering/doc/FLY-2383-voice-concurrency-30min/{research,plan,run-log}.md

---

## 0. 先读这一段:这份附录**只写量到了什么**

PRD §8.2 的原则:**不设阈值**。这份附录里没有一个 PASS/FAIL,
也没有「够不够快」「稳不稳」的判断 —— 那些要她自己听了才算。

⛔ **§7.2 那句口径仍然有效,本附录不推翻它、也不改写它**:

> ### 「最糟的失败模式(整段被占住)已排除;真正那条仍未量。」

本附录能做的,是把 §7.3 那三格从 ⬜ 改成「**量了,量到 X**」。
⛔ **仍然不许写成「可以同时做」。**

### 0.1 🔴 本场的**测量范围** —— 首页就说清楚,⛔ 不许读超出这两行

| # | 本场量的是 | ⛔ 本场**不是**在量 |
|---|---|---|
| 1 | **工具在跑的时候**,她还听不听得见 | 「它没在推进的时候会不会有声音陪着她」<br>**等待音只在有 Codex item 在跑时响,她「在想」不算** —— 实测她为一道题想了 **22.7 秒**,耳朵端整段只收到 **8 帧**低能量音频(详见 §2.1) |
| 2 | **耳朵端**看见的等待音 | 被测进程自己报的等待音时长 —— **它报不出来**:`Downlink.ts:211-214` 对所有非 voice 帧一律记 `silence`,**`audio_counters` 里没有 bed 这一档**(详见 §5.3) |

---

---

### 0.2 🔴 头部限制 —— **引用本附录任何数字之前必须先读这三条**

**① 两臂不是完全同环境**(Lead 2026-09-07 定稿口径,逐字):

> 臂 B 跑在 `1b96c05b` 且 flywheel 工作区 **dirty**,臂 A 在 `ec300f3b` **clean**;
> 经核对两臂 **7 个 collector 文件 content hash 与阈值 blob 逐字节相同** ⇒ **尺子未变**,
> 但**不能声称「完全同环境」**。

**② 尺子有一个 ~1 秒的盲区**:

> 回答窗内实测到**最长 960ms 的连续「不拦截」段**
> ⇒ **一次 1 秒量级以内的抢话,有可能整段落在这样一段里而不被窗级判据拦下。**
> ⛔ **不许说「短抢话已被排除」**;⛔ **也不给任何漏判概率**(相邻帧强相关,粗窗不是 speech-on 标注)。

**③ 本场回避了抢话**(测量范围,非崩溃规避):只在 Raya 无 voice 帧时注入
⇒ **抢话下的半小时未量**。

---

### 0.3 附录里的**每一个数字都可复核**

| 来源 | 怎么保证 |
|---|---|
| §3 标定表 | **由 `scripts/qa-voice-soak-calibrate.mjs --markdown` 生成**,带「请勿手改」标记 |
| §5 数据块 | **由 `scripts/qa-voice-soak-report.mjs --markdown` 生成**,同上 |
| 其余正文里引用的数字 | **逐条对着证据校验过**:`engineering/doc/FLY-2383-voice-concurrency-30min/verification/verify-appendix-numbers.py` |

该校验脚本把附录正文声称的 **42 个数字**逐个与
`run-summary.json` / `calibration-report.json` / 原始 `frames.jsonl` / `events.jsonl` 比对:

```
checked 42 claimed numbers; MISMATCHES: 0
```

⛔ **凡是拿不出生成物或校验的数字,就不该写在这份附录里。**

---

## 1. 这次的载体与出处(⛔ 换了任何一项,下面的数就不再适用)

```js
// scripts/lib/voice-soak/constants.mjs —— driver 里唯一的跨仓常量块
EXPECTED_CONTRACT_VERSION: "raya-voice-529/v1"
EXPECTED_RAYA_SHA:         "b1b5a64f2f060349b95f39c6cf4b05b453a6a7f1"
IMPORTS: {
  orchestrator: "scripts/qa/lib/orchestrator.mjs",
  envCompose:   "scripts/qa/lib/env-compose.mjs",
  session:      "scripts/qa/lib/session.mjs",
  ttsFixture:   "scripts/qa/lib/tts-fixture.mjs",
  scenario:     "scripts/qa/raya-voice-529.mjs",
  emitter:      "probes/c9-voice-emitter.mjs",
  contracts:    "packages/contracts/dist/index.js",
}
PRISM_ANCHOR: "apps/voice/package.json"
```

- 载体 = **529 房**(FLY-2126 的 Raya 语音 harness),QA 专用双 bot 身份,
  **不碰生产 Raya**(实测时 `com.xrli.raya.voice` 本来就没在跑)。
- harness 与 subject **两仓都必须 clean 且 HEAD 等于上面那个完整 SHA**,否则 driver 拒跑(exit 78)。
  理由:`CONTRACT_VERSION` 只版本化 529 **场景协议**,挡不住我们直接 import 的那些**内部函数**的语义漂移。
- 尺子:`scripts/qa-voice-concurrency-soak.mjs`(观测)· `qa-voice-soak-calibrate.mjs`(标定)·
  `qa-voice-soak-report.mjs`(出表)。
- ⚠️ 本场是 **TTS 回归尺**,**不是真人声、不含 founder 听感**(529 场景自述如此)。

---

## 2. 🔴 边界 —— **必须和数字一起读,⛔ 不许单独引用下面的表**

| 量不到 | 为什么 |
|---|---|
| **抢话下的半小时** | 本场**只测不抢话的注入**:注入前要求连续 3 秒无 `voice`、无 `unknown` 帧。<br>⛔ 这是**测量范围**,不是崩溃规避 —— FLY-2249 那条 `developer message` 崩溃在本 SHA 上**已经修了**(`runtime.ts:1095` 现为 `appendText(note, "user", …)`)。<br>回避抢话的两条理由:①barge 命中会 cancel 她当前 response,同时污染 turn 完成率的分子和分母;②抢话的**语义**正确性仍未在真房验过,那是 FLY-2249 的地盘 |
| 「她开外放、麦克风把**等待音回灌**」 | emitter 的上行是**干净音频文件**,等待音走下行,永远进不了上行。<br>FLY-1911 `decisions.md` 标过同一条边界,本场没有推进它 |
| 产品内部的 **reconnect** 逻辑 | 本场看的是「**进程退没退出 / 传输断没断**」。<br>`meeting_container_*` 在非 meeting 场是 **N/A** ⇒ ⛔ **不许读成「掉线 0 次」**;<br>receiver stream error 公开 API 不暴露 ⇒ 我们**没有**这个 guard,附录里也**不会**出现「stream error: 0」这一行 |
| 真人声 / founder 听感 | 全程 macOS `say` 合成音 |
| **超过 30 分钟** | 量到多长写多长。⛔ **不外推。** |

### 2.1 关于「等待音」这一格,先说清楚它到底回答了什么

实测发现(见 run-log §3):**等待音只在「有 Codex item 在跑」时响,她「在想」不算。**

```
Coordinator.ts:495-507   busy 由 ItemStarted 置位、ItemCompleted 清除
runtime.ts:2077-2090     busy 连续超过 minBusyMs(默认 1000ms)才 setBedActive(true)
```

一次读文件几十毫秒就结束,够不到 1 秒门槛 —— 所以她为一道题「想」了 22.7 秒的那次,
耳朵端整段只收到 **8 帧**低能量音频。

⇒ 本场的等待音轮是**先请她跑一件真花时间的活**(`sleep 30`),再把探针句注进那个窗。

> ### 🔑 **⇒ 下面那格「忙窗探针识别」回答的是:【工具在跑的时候】她还听不听得见。**
> ### ⛔ **不是**「它没在推进的时候会不会有声音陪着她」。

---

## 3. 尺子怎么立住的(标定与对照)

「等待音在响」这句话必须先有一把能看见它的尺子,而这把尺子**不能靠调阈值调出来**。

### 3.1 四档,`unknown` 是一等公民

```
energy < silenceFloor                        → silence
安静 且 tonalRatio ≥ bedTonalMin              → bed      （BoxB 五音的 Goertzel 能量占比）
energy > bedEnergyMax                        → voice
其余(安静但不成调)                            → unknown  ← 守卫按「可能是 voice」处理
```

⛔ **不许为了凑样本把 `unknown` 强行归档。** 大量 `unknown` 可以接受、要如实报。

### 3.2–3.4 标定产物(**由 `qa-voice-soak-calibrate.mjs` 生成,⛔ 非手抄**)

<!-- 由 scripts/qa-voice-soak-calibrate.mjs 生成,请勿手改 -->
<!-- policy: fly2383/window-level/v3 -->

**冻结的阈值**(⛔ 尺子的标定,不是产品阈值):

```json
{
  "calibrated": true,
  "silenceFloor": 0.0010164,
  "bedTonalMin": 0.9,
  "bedEnergyMax": 0.026788999999999997,
  "voiceEnergyMin": 0.026788999999999997,
  "voiceTonalMax": 1
}
```

**holdout(未参与定阈值的窗)—— 政策上限 vs 实测值**:

| 窗 | 帧 | voice | bed | silence | unknown | 政策 | 实测 | 结果 |
|---|---:|---:|---:|---:|---:|---|---|---|
| silence | 228 | 0 | 0 | 228 | 0 | maxBedShare=0.01, maxVoiceShare=0.01 | bed 0.00% / voice 0.00% | ✓ |
| bed | 120 | 0 | 120 | 0 | 0 | minBedShare=0.5, maxVoiceShare=0.02 | bed 100.00% / voice 0.00% | ✓ |
| voice | 481 | 282 | 1 | 99 | 99 | maxBedShare=0.05, minVoiceShare=0.3 | bed 0.21% / voice 58.63% | ✓ |
| transition | 185 | 144 | 2 | 10 | 29 | minVoiceShare=0.5, maxBedShare=0.05 | bed 1.08% / voice 77.84% | ✓ |

**负对照(bed-OFF 臂的忙窗)**:

```
忙窗帧 405 → bed 0 帧(bedShare 0.00%),passed=true
分类: {"voice":0,"bed":0,"silence":405,"unknown":0}
```

**标定窗的样本量**:

```
{"silence":760,"voice":1603,"bed":400,"transition":185}
```


⚠️ **`qualificationPolicyId` 必须和阈值一起读**:同一组阈值在**不同的合格规则**下结论不同。

🔴 **两件事要分清,⛔ 不许合并**:

| | |
|---|---|
| **A-r5 / B-r3 运行时用的** | 一份**没有** policy 字段的旧 threshold blob(sha256 `2878d1d0…`,manifest 里记的就是它)。那两场**当时并不知道** v3 这个 id |
| **本附录引用的** | 同一组五个阈值**逐字节相同**,但用当前代码在 **v3(窗级)** 下**事后**取得合格认定 |

⇒ 结论成立的依据是:**五个阈值与 `classifyFrame()` 都没变**。
⛔ **不许说「那两场当时就绑定了 v3」** —— 它们没有。规则的三步演变见 §6b。

> ### 🔑 上表的 **`政策` 列与 `实测` 列是两件事**:
> ### 例如 voice 窗的政策上限是 `maxBedShare=0.05`,**实测是 0.21%**。
> ### ⛔ **不许把它读成「voice 不许被读成 bed」** —— 政策允许到 5%。

### 3.5 🔑 负对照为什么是关键

上表最后一块:**等待音关掉之后,同一个检测器在 405 帧忙窗里认出 0 帧 bed。**
这才是「它看见的确实是等待音」的证据 —— 不是它的噪声门限在抖。

---

## 4. 观测条件核对表 —— **三条件,每格指向一条收据**

| §7.3 条件 | 臂 A 事实 | 收据 |
|---|---|---|
| ① **真实 agent turn** 在语音在流时完成 | 10 轮全部拿到回答且播放窗未被污染;**8 轮**在事先定的 deadline 内逐字回出该轮独有的六位口令(另 1 轮迟到但正确,1 轮她把末位数字念丢了)。工具轮的口令**只存在于隔离 workspace 的文件里** ⇒ 工具确实执行了 | `manifest.turns[*]` · 每轮 `nonce` / `fixtureSha256` · `events.jsonl` 里的 assistant 转写 |
| ② **半小时**量级 | **1,802,534 ms**(单调钟,`[T0, T1)`,**T1 在任何 teardown 之前冻结**;teardown 的 720 ms 单独报) | `timing.t0MonoMs` / `t1MonoMs` / `monotonicDurationMs` |
| ③ **真实 runner 编排在跑** | **60 个采样点**全部拿到 `status=executing` 且 `session_status=running` 的**非本场** runner;0 次仪器故障 | **`bridge-receipts.jsonl` 60 行原始 list + status body**(可逐条复算) |

> ### ⇒ **三条件同时成立,`allSatisfied: true`,verdict `VALID`(无作废原因)。**
> ### 这是 §7.3 那一格**第一次**被真正量到。

⚠️ ③ 的措辞:**「60 / 60 个采样点」**,⛔ **不是「窗内始终」** —— 那是 30 秒一次的离散采样。

---

## 5. 数据

<!-- 由 scripts/qa-voice-soak-report.mjs 生成,请勿手改 -->
<!-- generatedAt: 2026-09-07T05:54:20.399Z -->

### 两臂概览

| | 臂 A(bed 开,默认) | 臂 B(bed 关,对照) |
|---|---|---|
| run-id | `fly2383-main-arm-a-r5` | `fly2383-main-arm-b-r3` |
| 观测窗(单调钟,[T0,T1)) | 1802534 ms | 901423 ms |
| teardown(**不计入观测窗**) | 720 ms | 609 ms |
| verdict | **VALID** | **VALID** |
| 三条件全部成立 | **是** | 否(对照臂本就不是半小时) |

### agent turn

| | 臂 A | 臂 B |
|---|---|---|
| 尝试 | 10 | 5 |
| **完成**(assistant 回出本轮口令) | **8** | 5 |
| 播放窗未被抢话/采样不足污染 | 10 | 5 |

### 往返(playback 开始 → 含本轮口令的 assistant final)

> ⛔ 分类型读。工具轮大部分时间是**它在跑命令**,不是语音慢。

| 类型 | 臂 A n / min / 中位 / max (ms) | 臂 B n / min / 中位 / max (ms) |
|---|---|---|
| 纯问答 | 4 / 8415 / 8546 / 8914 | 3 / 8149 / 8223 / 8608 |
| 带工具 | 4 / 18618 / 20734 / 24968 | 2 / 17698 / 24648 / 24648 |
| 忙窗探针 | 4 / 4915 / 5941 / 6266 | 3 / 5762 / 5899 / 6101 |

### 下行 Opus 包(**含 voice / bed / 编码静音**)

| | 臂 A | 臂 B |
|---|---|---|
| 每分钟包数(格数,min – max) | 29 格,2057 – 3456 | 14 格,2884 – 3104 |
| 窗内总帧(20ms/帧) | 90145 | 45063 |
| 逐秒桶空洞 | 68 | 12 |

⛔ 这一格证明**下行传输还在**,**不是**「电话里一直有声音」。

### 分类器看到的内容(窗内秒数)

| | 臂 A | 臂 B |
|---|---|---|
| `voice` | 49.98 s(2.77%) | 33.78 s(3.75%) |
| `bed` | 84.6 s(4.69%) | 0.6 s(0.07%) |
| `silence` | 1616.62 s(89.67%) | 853.84 s(94.74%) |
| `unknown` | 51.7 s(2.87%) | 13.04 s(1.45%) |

### 掉线 / 断档

| 观测项 | 臂 A | 臂 B |
|---|---|---|
| **观测窗内**的 `voice_exit` | 0 | 0 |
| 收尾时的 `voice_exit`(正常结束) | 1 | 1 |
| driver 旁路监听到的 decoder error | 1 | 0 |
| `audio_clock_stall` **窗内** | 4 | 0 |
| `audio_clock_stall` 窗前 / 窗后 | 0 / 17 | 0 / 13 |
| cleanup 错误 | 0 | 0 |

⛔ `meeting_container_*` 在非 meeting 场是 **N/A**,本表不含。
⛔ receiver stream error 公开 API **不暴露**,本表不报 —— 那是「没观测」,不是 0。

### 忙窗探针识别(等待音那半格)

| | 臂 A(bed confirmed) | 臂 B(bed absent confirmed) |
|---|---|---|
| attempted | 5 | 3 |
| **audio-eligible** | 2 | 3 |
| hit | 2 | 3 |
| **miss** | 0 | 0 |
| ineligible:`ambiguous_audio` | 3 | 0 |

> 🔴 **N 太小,⛔ 不许比较两臂的命中【率】。** 只读这几个数本身。

### 窗内编排(条件③)

| | 臂 A | 臂 B |
|---|---|---|
| 原始 Bridge 收据已落盘 | 是 | 是 |
| 采样点 | 60 | 30 |
| 其中 `executing` 的采样点 | 60 | 30 |
| 仪器故障 | 0 | 0 |

⛔ 这是**离散采样点**,不是「窗内始终」。

### provenance

⚠️ **两臂的执行物不一定相同**,逐臂列出;⛔ 不要只读臂 A 那一列。

```
── fly2383-main-arm-a-r5 ──
flywheel   ec300f3b0193256a8dff177e472fb6c0a15f7570  dirty=false
harness    b1b5a64f2f060349b95f39c6cf4b05b453a6a7f1  dirty=false
subject    b1b5a64f2f060349b95f39c6cf4b05b453a6a7f1  dirty=false
subject cli sha256 7d675d33556f8b8a6fbdbbb25911767faf5772d17c686648301afe8e30175f00
thresholds (运行时) engineering/doc/FLY-2383-voice-concurrency-30min/calibration/thresholds.json  2878d1d00ac31a381da042ff5576a75af75fdbed7c5fced90515d116fb5cae4c
cross-repo scripts/qa/lib/orchestrator.mjs  a95404424cdb0529920ffe5a0472b65b979665255d69c364d6c06a591b48b77b
cross-repo scripts/qa/lib/env-compose.mjs  28d844076039d40548399b9bf55aa0fc2a80582ec658aa35e61fff091c6c420a
cross-repo scripts/qa/lib/session.mjs  b53988de8342b14f825973ffcc32d74a2fdbc7eaa96b95d90f569f96a99d2a77
cross-repo scripts/qa/lib/tts-fixture.mjs  e6bf12df199e4832627d014a37d716dae7c57a9bd84cd079c62c8c1f8e693e43
cross-repo scripts/qa/raya-voice-529.mjs  21ab22561cc3c157919f3632b8b3fb633120c80d4d1f2dd19a6aca05fdf5fc94
cross-repo probes/c9-voice-emitter.mjs  546b2937be7c981bffb86ba557aced11e638d6b46ebe163b8014949babee5a13
cross-repo packages/contracts/dist/index.js  44ddfdbb3cf42157fd82625eb2e34b6830ffd46fb736302dc811f388124516a4
collector  scripts/qa-voice-concurrency-soak.mjs  c1536016b57b25d3a27bad5e952578171fd14cf2ee5ebb8bed5ddc3908fd1bc6
collector  scripts/lib/voice-soak/constants.mjs  a2731b3def64f6f4c60ff9b4d222704cadf6d9b7fc01a93d8a637e605b3f7ce0
collector  scripts/lib/voice-soak/audio-classify.mjs  80a482cead7500b6120a38aa79689f326f42003da26e854ebc7573dbc18e4df8
collector  scripts/lib/voice-soak/eligibility.mjs  96431445da03075c78610ac2f8ec2954cc1aef0b4885963ac2dcdd758f5e5a96
collector  scripts/lib/voice-soak/bridge-orchestration.mjs  3836825c1fe64a4c04ffececc91c057711a486a91f42eb7c3c858016bd73ac56
collector  scripts/lib/voice-soak/receipts.mjs  e10e7e061b2bf62cf297a81c5e02f8377806cca197181232ea2d1babd5ada05d
collector  scripts/lib/voice-soak/manifest.mjs  9001f9814a1638821c8ea65712a8a5240008a29a3a63c6f5e1709ac84b379293
artifact   frames.jsonl  e398ea89f0ba9182e274ec656fe83684c850aa182ff40e447fb5fe3333c926d8
artifact   bridge-receipts.jsonl  7a39ddedfc4fc1bb1d82d39944ebecaf27321c47295d032dbf7928a2719d3ea6
artifact   session/state/voice-evidence/events.jsonl  622c91910b85dcd7dabd6b3e3831aa25eaff09b645adf46054a126e3e51a1975

── fly2383-main-arm-b-r3 ──
flywheel   1b96c05bcab7394021b891b99a1a09f1040f4006  dirty=true
harness    b1b5a64f2f060349b95f39c6cf4b05b453a6a7f1  dirty=false
subject    b1b5a64f2f060349b95f39c6cf4b05b453a6a7f1  dirty=false
subject cli sha256 7d675d33556f8b8a6fbdbbb25911767faf5772d17c686648301afe8e30175f00
thresholds (运行时) engineering/doc/FLY-2383-voice-concurrency-30min/calibration/thresholds.json  2878d1d00ac31a381da042ff5576a75af75fdbed7c5fced90515d116fb5cae4c
cross-repo scripts/qa/lib/orchestrator.mjs  a95404424cdb0529920ffe5a0472b65b979665255d69c364d6c06a591b48b77b
cross-repo scripts/qa/lib/env-compose.mjs  28d844076039d40548399b9bf55aa0fc2a80582ec658aa35e61fff091c6c420a
cross-repo scripts/qa/lib/session.mjs  b53988de8342b14f825973ffcc32d74a2fdbc7eaa96b95d90f569f96a99d2a77
cross-repo scripts/qa/lib/tts-fixture.mjs  e6bf12df199e4832627d014a37d716dae7c57a9bd84cd079c62c8c1f8e693e43
cross-repo scripts/qa/raya-voice-529.mjs  21ab22561cc3c157919f3632b8b3fb633120c80d4d1f2dd19a6aca05fdf5fc94
cross-repo probes/c9-voice-emitter.mjs  546b2937be7c981bffb86ba557aced11e638d6b46ebe163b8014949babee5a13
cross-repo packages/contracts/dist/index.js  44ddfdbb3cf42157fd82625eb2e34b6830ffd46fb736302dc811f388124516a4
collector  scripts/qa-voice-concurrency-soak.mjs  c1536016b57b25d3a27bad5e952578171fd14cf2ee5ebb8bed5ddc3908fd1bc6
collector  scripts/lib/voice-soak/constants.mjs  a2731b3def64f6f4c60ff9b4d222704cadf6d9b7fc01a93d8a637e605b3f7ce0
collector  scripts/lib/voice-soak/audio-classify.mjs  80a482cead7500b6120a38aa79689f326f42003da26e854ebc7573dbc18e4df8
collector  scripts/lib/voice-soak/eligibility.mjs  96431445da03075c78610ac2f8ec2954cc1aef0b4885963ac2dcdd758f5e5a96
collector  scripts/lib/voice-soak/bridge-orchestration.mjs  3836825c1fe64a4c04ffececc91c057711a486a91f42eb7c3c858016bd73ac56
collector  scripts/lib/voice-soak/receipts.mjs  e10e7e061b2bf62cf297a81c5e02f8377806cca197181232ea2d1babd5ada05d
collector  scripts/lib/voice-soak/manifest.mjs  9001f9814a1638821c8ea65712a8a5240008a29a3a63c6f5e1709ac84b379293
artifact   frames.jsonl  0fdcfbd5d37582cd94ef96cef34fa2aa15325b01371c9b6d954ef848629dc346
artifact   bridge-receipts.jsonl  2280b78df196e53ece47eaca6deebfff1ec3e3d5ed6fe82b2e11fcb598b955ea
artifact   session/state/voice-evidence/events.jsonl  0f847c9bfd3a286e9e9626ee31c3f28fba60e84a273f4ffbd12174c6c6b3cf9e

```


### 5.0 两臂的执行快照**不完全相同** —— 先说清楚

生成的 provenance 表逐臂列出,读的时候会看到:

| | 臂 A(`a-r5`) | 臂 B(`b-r3`) |
|---|---|---|
| flywheel commit | `ec300f3b…` | **`1b96c05b…`** |
| flywheel 工作区 | clean | **dirty** |
| harness / subject | `b1b5a64…` clean | 同 |
| 运行时 thresholds blob | `2878d1d0…` | 同 |
| **7 个 collector/lib 文件的 content hash** | — | **与臂 A 逐字节相同(已核)** |

⇒ **两臂用的是同一把尺子**(collector 内容哈希一致、阈值 blob 一致、classifyFrame 一致),
只是臂 B 跑在一个**更晚且未提交**的 flywheel 工作区上。
⛔ **不能因此说两臂"完全同环境"** —— 但**能**说:**尺子本身没变**,
因为绑定的是**文件内容哈希**,不是 commit。

---

### 5.1 关于 ① 的两个例外,逐个说清楚

| 轮次 | 发生了什么 | 怎么记 |
|---|---|---|
| 第 1 轮(纯问答) | 口令 `616670`,她回的是「口令是 **6 1 6 6 7**」—— **末位 `0` 念丢了** | **算未完成**。这是真实的读回失败 |
| 第 12 轮(带工具) | 口令 `269294`,她回的是「文件里的数字是 **2、6、9、2、9、4**」—— **完全正确**,但落在 **37,916 ms**,超过事先定的 **28,114 ms** deadline | **不算完成**,单列为「迟到但正确」 |

> ### 🔑 **为什么不把 deadline 放宽到 40 秒**:那是**看完数据再挑边界**。
> ### deadline 事先写死,迟到的就如实记成迟到。

### 5.2 臂 A 那 3 次 `ambiguous_audio` 的成因

被判 `unknown` 的帧,能量落在 bed 区间内,但 `tonalRatio` 很低 ——
那是**等待音自己的衰减尾巴和音符间隙**:够安静、但那一刻不成调。
`unknown` 按设计 fail-closed(当它可能是 voice),于是整窗被排除。

> ### ⇒ **等待音的存在本身会压低「等待音臂」的可用样本数。**
> ### ⇒ 两臂 eligible 数天然不对称,⛔ **不是「臂 A 表现差」。**

---

## 6. 尺子的**已知上限**:回答窗内 1.12% 的帧被判成等待音

这一节是**方法学的自我否定**,不是免责声明。⛔ 读下面任何一个数之前先读它。

### 6.1 怎么量的(可复算)

| | |
|---|---|
| 窗口定义 | 每条 assistant final 转写之后 **0.4 – 4.0 s** 的**粗窗** |
| ⚠️ **这个窗不是逐帧的「她在说话」标注** | 它是**回答窗**:里面**必然含真实的字间停顿**。⛔ 因此下面所有比率都是**「回答窗内的帧」**的比率,**不是**「连续说话时的帧」的比率 |
| 样本 | 校准场 `fly2383-pilot-on-r7`,`frames.jsonl` + `events.jsonl` |
| n | **1,603 帧** |
| 两仓 SHA | `b1b5a64f2f060349b95f39c6cf4b05b453a6a7f1`(harness 与 subject 同) |
| 阈值 | `calibration/thresholds.json`(见 §3.2,未改动) |

**分布**:

```
voice 965 · unknown 343 · silence 277 · bed 18
                                        ↑ 误判率 18 / 1603 = 1.12%
```

那 18 帧的 `tonalRatio` **最高到 1.0** —— 与 BoxB 音符**完全一样**。

### 6.2 这些帧在两维特征上与等待音**同区**

⚠️ **先说清楚这一节【不能】说什么**:回答窗是粗窗,**没有帧级 speech-on 标注**
⇒ ⛔ **不能断言这 18 帧「就是持续元音」**,也 ⛔ **不能断言「她说话与等待音不可分」**。
能说的只是:**这 18 帧落在与 BoxB 音符相同的 `(energy, tonalRatio)` 区域里**,
因此**在这两维上无法把它们与等待音分开**:

```
误判帧样本 (energy, tonalRatio):
  (0.00175, 0.9959)  (0.01029, 1.0)  (0.00885, 0.9774)  (0.02295, 1.0)
  (0.00366, 1.0)     (0.01815, 0.9736)  (0.02300, 0.9198)  (0.00120, 1.0)
```

> ### ⛔ **提高 `bedTonalMin` 对这 18 帧无效** —— 它们的 `tonalRatio` 本身就是 **1.0**。
> ### 在**这两维**上不存在能把它们与等待音分开的阈值。
> ⚠️ 要判断它们**究竟是不是语音**,需要帧级标注 + 更多特征,**本轮没做**。

### 6.3 余量:**只报观测到的,⛔ 不报概率**

> 🔴 **这一节的第一版是错的,原样交代**:我曾在这里放过一张
> `P(整段漏判) = (1-0.816)^k` 的表,并写「200ms 抢话漏判概率 4.5 × 10⁻⁸」。
> **那个推导不成立** —— 它把相邻的 20ms 帧当成**独立样本**,而语音帧天然强相关;
> 那 1,603 帧又取自「assistant final 之后 0.4–4.0s」的**粗窗**,里面本就含真实停顿,
> **不是「每帧都在连续说话」的标注**。⇒ **表和那两个概率已全部删除。**

**当前证据只支持这三句话**:

| 能说的 | 数 |
|---|---|
| **回答窗内**被判成 `bed` 的帧 | **18 / 1,603(1.12%)** |
| **回答窗内**会触发窗级拒绝(`voice` 或 `unknown`)的帧 | **1,308 / 1,603(81.6%)** |
| **回答窗内**实测到的最长连续「不拦截」段 | 见下表 |

⚠️ **这三行都受限于同一件事**:窗是粗的。⛔ 不能把它们读成「她连续说话时」的比率。

**逐窗实测的最长连续 `silence｜bed` 段**(9 个**回答窗**):

```
320ms · 220ms · 440ms · 460ms · 100ms · 440ms · 960ms · 200ms · 200ms
                                          ↑ 最长
```

> ### 🔴 **实测到最长 960ms 的连续「不拦截」段。**
> ### ⇒ **一次 1 秒量级以内的抢话,有可能整段落在这样一段里而不被窗级判据拦下。**
> ### ⛔ **不许说「短抢话已被排除」。** ⛔ **也不许由此反推一个漏判概率** ——
> ### 要给概率,得另做**帧级的连续 speech-on 标注**,并用能处理时间相关性的估计方法。

⚠️ 这些「不拦截」段**大多是 `silence`**,也就是字与字之间的停顿 ——
所以它们**既不能证明尺子不安全,也不能证明它安全**。**粗窗给不出这个结论。**
⇒ 要判断「一次真抢话会不会被拦下」,需要**帧级的连续 speech-on 标注**,本轮没有做。

### 6.4 ⬜ follow-up(**不开新单**,记录在此)

若将来要做**帧级**区分,需要:①**帧级的连续 speech-on 标注**(本轮缺的正是它);
②引入 **谐波结构 / 频谱通量** 一类特征并**重新标定**。
本轮**不做** —— 它换不来任何一次已观测判定的改变。

---

## 6b. 与 plan 的偏离 —— **规则改过两次,三步都留在账上**

| 步 | 规则 | 结局 |
|---|---|---|
| **①** plan §1.5.3 原文 | 「已知 bed→assistant 起音的过渡帧**只能判 `voice` 或 `unknown`**,落成 `bed`/`silence` 即 `INSTRUMENT_FAIL`」 | 实测:onset 后 400ms 的 185 帧里有 **2 bed + 10 silence**。那 10 帧 silence 是**字与字之间真实的停顿** ⇒ 按字面永远无法通过,且失败原因与它要防的风险无关 |
| **②** Lead 2026-09-07 03:0x 收紧 | 「**`bed` 必须逐帧为 0(严格)**,`silence` 作为真实字间停顿放行」 | 按新规则重跑标定 —— **仍不通过**(2/185 判 bed)。深挖后发现是 §6.2 的**特征集天花板**,不是标定问题 |
| **③** Lead 2026-09-07 04:19 **裁定 A,并作废 ②** | 保护判定的是**窗级**(整窗无 `voice` 且无 `unknown`),不是帧级;帧级混淆率**作为尺子的已知上限如实公布**(§6) | **本附录采用**。Lead 原话:「你用实测把我的规则证伪了,这正是我要的做法」 |

> ### 🔑 **为什么把这三步全留着**:
> ### 一条被数据推翻的规则,**它被推翻的过程本身就是证据**。
> ### 只写最终规则,读的人无从判断这条规则是**想清楚的**还是**试出来的**。

---

## 7. 场次账(⛔ 含全部作废场次)

| 场次 | 结果 | 原因 |
|---|---|---|
| `fly2383-main-arm-a-r1` | **作废** | 系统内存不足被 SIGKILL(~11 分钟),无 manifest |
| `fly2383-main-arm-a-r2` | **作废** | 同上(<1 分钟),并把两个 QA bot 落在语音房里 |
| `fly2383-main-arm-a-r3` | **作废** | 前置守卫正确拒跑:`QA voice room is not empty`(r2 的残留) |
| `fly2383-main-arm-a-r4` | **作废** | 跑完且三条件成立,但**代码评审判定尺子有 5 处 P0**(窗口边界含 teardown、Bridge 原始收据未落盘、采样覆盖率 fail-open 等)⇒ **数据不采信,重跑** |
| `fly2383-main-arm-b-r1` | **作废** | 同 r4(同一批 P0) |
| `fly2383-smoke-r2` | 有效(4 分钟) | **修完 collector 后的验证短跑**,确认 T1 冻结、收据落盘、provenance 完整 |
| `fly2383-main-arm-b-r2` | **作废** | **新加的空洞守卫正确拒收**:101 个空洞 / 902 秒 = 11.2% > 10% 上限 |
| **`fly2383-main-arm-a-r5`** | **有效** | 三条件全部成立 |
| **`fly2383-main-arm-b-r3`** | **有效** | 对照臂 |

另有 9 场校准/试跑(含 3 场因**尺子本身量法站不住**而作废),逐场记在
`engineering/doc/FLY-2383-voice-concurrency-30min/run-log.md`。

> ### 🔑 **只留跑通的那次,等于在制造一个不存在的稳定性。**
> ⚠️ **r4 / b-r1 是「跑通了但不采信」** —— 尺子当时是错的,数据再好看也不能用。

---

## 8. 这次量到了什么 —— **只写这些**

1. **一次同时满足三条件的 30 分钟观测已经存在、可查**:窗长 **1,802,534 ms**;
   窗内 10 轮 agent turn 全部拿到回答、播放窗全部未被污染,其中 8 轮在 deadline 内逐字回令
   (含 4 次真跑工具、从隔离文件里读出口令);**60 个编排采样点全部** `executing`,原始收据可复算。
2. **观测窗内没有观察到进程退出**:窗内 `voice_exit` **0** 次(收尾时那次是正常结束,单列);
   下行每分钟包数始终非零。
   ⚠️ **但不是「一切正常」**:窗内有 **68 个采样不足的秒**(3.8%)、**4 次** `audio_clock_stall`,
   以及 **1 次** driver 旁路观察到的 decoder error(`Decode error: Invalid packet`)——
   ⚠️ **该收据没有时间戳,无法判定它落在窗前/窗内/窗后**,故不并入任何一栏。
3. **等待音是可被独立观测到的,并且关掉之后几乎消失**:
   开着 **84.60 s(4.69%)** → 关掉 **0.60 s(0.07%)**。
   ⚠️ **不是 0**:对照臂仍有 0.60 秒被判成 bed,且它们**没有**落在任何探针窗内。
4. **等待音只在「有工具在跑」时响** —— 她「在想」的时候不响(§0.1、§2.1)。
5. 忙窗探针:臂 A **2 / 2 命中**,臂 B **3 / 3 命中**。⛔ **N 太小,不许由此谈率。**
6. **尺子有已知上限**:**回答窗内** **1.12%** 的帧被判成等待音(§6),
   且**回答窗内**实测到**最长 960ms 的连续「不拦截」段**(⚠️ 回答窗是粗窗,含真实字间停顿)。
   ⇒ **一次 1 秒量级以内的抢话有可能不被窗级判据拦下。**
   ⛔ **本附录不给任何漏判概率** —— 相邻帧强相关,粗窗也不是连续 speech-on 标注。


---

## 9. 🔴 这把尺子自己被抓错过 —— **每一类都留一行**

Lead 的要求(逐字):「**这份附录将来是给 founder 判断「这套尺子可不可信」用的,过程比结论更有说服力。**」

代码评审 6 轮,前 5 轮抓到 16 条,**每一条都是「数字比证据强」**。分类留档:

| # | 曾经错在哪 | 后果(若没抓到) | 现在怎么防 |
|---|---|---|---|
| 1 | **观测窗含 teardown** | `voice_exit` 落在我报的窗内,却写成「0 次掉线」 | T1 在**任何 teardown 之前**冻结;窗内/收尾的 exit 分开报 |
| 2 | 条件③的 **60 份原始收据没落盘** | 「60/60 executing」**无法复现**,而附录声称引用了原始收据 | 每次采样把 raw list + raw status **落盘**;report 从它**重算** |
| 3 | **静默守卫 fail-open** | 实测有一轮「3 秒静默窗」**只有最后 48ms 有观测** ⇒ 「注入前无人说话」没被证明 | 量**覆盖率**与**最大未观测间隔**;不足即 `sampling_fault` |
| 4 | **provenance 绑不住实际执行物** | 被 raya `.gitignore` 的 `contracts/dist` **不在任何 commit 里** | 所有跨仓 import + collector 文件**按内容哈希** |
| 5 | **附录 6 处说过头**(含自相矛盾) | §5.5 写「仍有 0.60s bed」、§8 写「关掉就消失」 | 数据块**由脚本生成**;结论逐句对齐生成表 |
| 6 | **往返时间测的是我自己的 sleep** | 每轮都落在同一个 26–28s band,**看着像测量** | 从 assistant 转写**自己的时间戳**重算 |
| 7 | **概率推导假设帧独立** | 「200ms 抢话漏判 4.5×10⁻⁸」——**被 960ms 实测直接反证** | **整段删除**;只报观测到的最长不拦截段 |
| 8 | **伪造的 status body 能过关** | 收据可以指向 raw list **没选中**的 runner | 逐条**重新选候选**,并要求 `candidates[0].id === status.id` |
| 9 | **manifest 可以宣称它自己收据否认的事** | 60 条全 not-executing,manifest 仍写三条件成立 | 三条件**从证据重建**并与 manifest 做结构化 diff |
| 10 | **半小时由可改的派生字段自证** | 改一个数就能把 15 分钟对照场说成半小时 | 唯一权威时长 = **T1 − T0**;与 aggregate 对账 |
| 11 | **generation 校验 fail-open** | 歧义时「接受一切」;`heard` 根本没过滤 | 全场唯一有限值才可用,否则**阻断出表**;三条路径都过滤 |
| 12 | **report 不重判 verdict** | 已被空洞守卫拒收的 B-r2,只改 verdict 字段就变 VALID | 从重算的 holes/duration/guards/failures **重建 verdict** |
| 13 | **复制一条 round 就能加一个 hit** | 不碰任何帧即可抬高命中数 | `roundId` 与 `nonce` **各自**不得重复 |
| 14 | **标定 CLI 静默吞坏行** | 可能在**有缺口**的数据上签发 `calibrated:true` | 严格解析,只容忍**最后一行** torn record |
| 15 | **secret 扫描后又把原文写回** | rescan 通过 → 再写回含密 manifest → 宣称已清除 | 命中后**先脱敏再写**;**扫描是最后一步** |
| 16 | **政策上限被写成逐帧保证** | 「voice 不许被读成 bed」——政策其实允许到 5% | 「政策上限 vs 实测值」两列并排 |

> ### 🔑 **两条一直没被推翻的**:
> ### ①**两臂的原始数据**(artifacts 全 match、drift clean、收据可逐条重算);
> ### ②**三条件成立**这个结论本身。
> ### 被推翻的**全部是我描述它的方式**,以及**尺子能不能证明自己**。

⚠️ **仍未做(记录,不在本单)**:抗任意伪造的证据设施(JSON 输出路径的 fail-closed 顺序、
frame seq 完整性校验、round 的 append-only 收据等)——
那属于「要不要把这把尺子转成常设 QA 设施」的另一张单。

---

### ⛔ 本附录**不**支持的说法

> ### **「可以同时做」** —— ⛔ **仍然不许写。**
> 本场**回避了抢话**、**没有真人声**、**没有 founder 听感**、**没有量回灌**,
> 且只有**一次** 30 分钟观测。

§7.2 的口径**原样保留**:「最糟的失败模式(整段被占住)已排除;真正那条仍未量。」
—— 现在可以在它后面补一句**同样克制**的:

> ### **「一次【真实编排在跑 + 语音在流】的半小时观测已经取得;
> ### 其中 10 轮 agent turn 全部得到回答、8 轮在事先定的 deadline 内逐字回令,
> ### 观测窗内链路未断。抢话与真人听感仍未量。」**
