# FLY-2383 语音并发半小时实测 — 探索

Issue: FLY-2383 (https://linear.app/geoforge3d/issue/FLY-2383/raya语音实测-prd-1850-73-未量的那一半真实-runner-编排在跑-语音在流-半小时量级-不挂-founder工程自测)
日期: 2026-09-06
基于: 无

---

## 0. 这单在问什么(逐字照抄口径,⛔ 不许改写)

PRD FLY-1850 v1.0 §7.2 已量过一次,结论逐字是:

> **「最糟的失败模式(整段被占住)已排除;真正那条仍未量。」**
> ⛔ **不许写成「可以同时做」。**

§7.3 列出「还要量什么」,三个条件**缺一不可**:

| # | 条件 | 上一次(FLY-1911,2026-08-20)的状态 |
|---|---|---|
| ① | **真实 agent turn** 在语音在流时能否完成 | 未量(当时归因 401,后更正为「单纯没做」) |
| ② | **半小时**量级 | 只有 **14 秒**(13.8s / 14.4s 两个窗) |
| ③ | **真实 runner 编排在跑** | 单机单进程,**不涉及编排** |

§11.2 交付声明把它列在「⬜ 未被测到的」一档,并写明:
**「并发:半小时量级 + 真实编排 —— ⛔ 不是被阻塞,是没做」**。

另有一条同族的半格(§11.2「⬜ 未被测到的」表):
**「持续等待音会不会干扰【它听她说话】」—— 已量的只有「不会盖住它说话」那一半。**
本单一并量另一半(等待音期间它还听不听得见)。

**归属**:§7.3 明写「挂在谁身上 = **工程实测**,⛔ **不挂她**」。所以本单是工程自测,不安排 founder 参与。

---

## 1. 上一次是怎么量的(读证据,不是读结论)

`product/doc/FLY-1911-codex-voice-prototype/evidence/` 里有两份原始 manifest:

- `C2a-no-voice-manifest.json` / `C2b-with-voice-manifest.json` —— **§7.2 那张表的出处**
- `concurrency.mjs` —— C1 探针(它其实做的是「语音在流时另开一条 thread 跑真 turn」)

`C2b` 的自述边界写在 manifest 里,**跟 PRD 的口径一致**:

```
"probe":    "语音流式播放期间进程还理不理别的请求(RTT)"
"boundary": "量的是进程/传输层是否仍即时应答;不等于能完成一次真正的 agent turn"
"windowSec": 13.8
```

12 次 RTT,中位 687 ms,超时 0/12,期间音频包 166。

### 1.1 上一次的形状,决定了它为什么只算半个

```
codex app-server(单进程)
 ├── thread A ── realtime 语音会话(一直在说话)
 └── thread B ── 发一条请求,量 RTT
```

- 它证明的是:**同一个进程在推音频时,事件循环没有被饿死**。
- 它**没有**证明:一次真正的 agent turn(会跑工具、会等网络、会写文件)能在语音在流时完成。
- 它**更没有**碰到:Bridge 上真的有 runner 在被编排时,这条链路是什么样。

⇒ §7.1 给的两条硬证据说明为什么③不能省:
「HL 自己的入站信箱堵了约 50 分钟他没发现」+「系统里 founder 没有优先通道,
所有 Discord 聊天硬编码同一个优先级,和 runner 事件挤同一个队」。
**堵在文字上她看不出来;堵在语音上就是电话里没声音。**

---

## 2. 今天手上有什么(2026-09-06 实地探过,不是推测)

### 2.1 529 房 harness(FLY-2126)—— 载体在,是活的

| 件 | 位置 | 状态 |
|---|---|---|
| Flywheel 侧入口 | `scripts/qa-raya-voice.sh` | 在;合同版本 `raya-voice-529/v1` |
| Raya 侧 harness | `~/.flywheel/raya/code/scripts/qa/raya-voice-529.mjs` | 在(560 行)+ `lib/` 7 个模块 |
| 被测 Raya 构建 | `~/.flywheel/raya/code/apps/voice/dist` | 已构建;HEAD = `b1b5a64` (FLY-2249 barge-in v2) |
| QA 双 bot 凭据 | `~/.flywheel/.env` 的 `TEST_BOT_TOKEN_1..4` | 4 个都在 |
| 槽位映射 | `~/.flywheel/test-slots.json` | 在;slot1/slot2 是不同 bot id |
| 历史证据包 | `~/.flywheel/raya/qa/FLY-2126-runs/` | 18 场,最近含 `fly2178-*` |

允许的房间只有两个(harness 硬校验):
`voice-test-2` = `1542708795720081408`,`voice-test-3` = `1542709028742893699`(默认)。

### 2.2 真实编排在跑 —— 现成就有

```
GET localhost:9876/health
→ {"ok":true, "sessions_count":9, "buildSha":"b198edcf...", "admissionPause":{"active":false}}
```

**Bridge 现在挂着 9 个 session**。③「真实 runner 编排在跑」不需要我们造,只需要
**在观测窗内把它记下来**(并证明窗内它确实是忙的,不是恰好空转)。

### 2.3 语音进程自己吐的遥测 —— 比我们外挂探针准

`apps/voice/src/` 里 `evidence.record({kind: ...})` 有 100+ 种 kind,落在
被测 worktree 的 `<state>/voice-evidence/events.jsonl`。跟本单直接相关的:

| kind | 能回答 | 出处 |
|---|---|---|
| `realtime_transcript` (role=user/assistant, final) | **识别率**、它听没听见 | `runtime.ts:1750` |
| `audio_clock_stall` | 上行音频时钟卡顿(**实时**吐,上限 100 条) | `runtime.ts:2045` |
| `audio_counters` | 音频计数总账 —— ⚠️ **只在 finish() 时吐一次** | `runtime.ts:2170` |
| `uplink_gate_utterance` / `uplink_pcm_fingerprint` | 她那一侧的话有没有真进去 | `runtime.ts:643 / 1334` |
| `meeting_container_starting` / `_live` / `voice_exit` | **掉线/重连**、会话世代 | `runtime.ts:551/658/787` |
| `speech_injected` / `speech_dropped_not_live` | 注入腿有没有掉 | `runtime.ts:587/452` |
| `barge_*`(FLY-2249) | 打断路径 | 多处 |

🔴 **一条已知的量法陷阱**:`audio_counters` **只在进程收尾时吐一次**。
⇒ **「音频包连续性」不能靠它按分钟切片** —— 得另找尺子(见 §3)。

### 2.4 语音进程没有空闲自动退出

`apps/voice/src` 里 grep 不到 `idleTimeout` / `maxSessionMs` / `inactivity` 一类。
⇒ **一次连续 30 分钟的会话在形态上是可能的**,不用跟一个内建超时打架。

---

## 3. 三个还没有答案的量法问题(本单真正的技术含量)

### 3.1 「半小时」是一场连续的,还是 30–45 分钟的挂钟?

FLY-2126 的 full run 是 **15 个真实 voice 生命周期,约 30–45 分钟**。
它挂钟够半小时,但**语音会话是反复重启的**。

她的原话是「**我跟你开半小时的会**」⇒ **一场连续的会**才是忠实读法。
⛔ 把 15 段拼起来叫「半小时」,是把「半小时量级」这一格用挂钟糊过去。

⇒ **倾向:一场连续 ≥30 分钟的会话。** 这也意味着 529 的既有 criteria 跑法
(每场 `--session-timeout-ms` 默认 180s)**不能直接复用**,需要一个「soak」形态。

### 3.2 音频包连续性用谁的尺子?

两个候选:

| 尺子 | 优点 | 缺点 |
|---|---|---|
| 被测进程自报 `audio_counters` | 零外挂 | **只有收尾一个总数**,切不了片 |
| **QA emitter bot 在房里当耳朵**,按 Discord receiver 计包 | 能按秒切片;**是「她听到的」那一端** | 要写代码;FLY-1911 的 `AN1-ear-perspeaker.mjs` 已有先例 |

⇒ **倾向:耳朵端**。理由:§7.1 的失败模式定义就是「**电话里没声音**」——
那是**听者**的事实,不是进程内计数器的事实。

### 3.3 「等待音期间的识别率」怎么算才不是自欺?

FLY-1850 已量的那半是:**等待音响时地板 182 / 它说话时 0.00** ⇒ 尺子看得见等待音,
且等待音**没盖住它说话**。⛔ 没量的那半是「**等待音响着时,它还听不听得见她**」。

要不自欺,需要一个**阳性对照在同一场里**(PRD §11「同一份录音里的阳性对照」那条规矩):
- 等待音**响着**时注入 N 句 → 数 `realtime_transcript(role=user, final)` 命中几句;
- 等待音**没响**时注入同样 N 句 → 同样数法。
- **两组都在同一场、同一条链路上**,否则数字不可比。

---

## 4. 边界(本单⛔不做的)

| ⛔ | 为什么 |
|---|---|
| 不改语音管线(`apps/voice/src`) | issue 明写;且改了就不是「量现状」 |
| 不动生产 Raya 身份 / 不做 launchd mutation | 529 场景本来就走专用 QA 身份 |
| **不设阈值** | PRD §8.2 原则;结论只写「量到了什么」 |
| 不把「founder 优先通道」在本单做掉 | 验收明写:**只记录 + 开设计题给 founder** |
| 不外推 | 量到的窗多长就写多长,⛔ 不许从 30 分钟推「一小时也行」 |

---

## 5. 待研究(进 research.md)

1. 529 harness 的 `runVoiceSession` 能不能被 soak 形态复用,还是必须在 Flywheel 侧另起一个 driver?
   —— 跨仓边界:harness 在 Raya repo,本单 PR 在 flywheel repo。
2. 一场连续 30 分钟里,**怎么持续制造真实 agent turn**(注入什么问题、多久一次、
   怎么保证它是「真 turn」而不是复述)。
3. 「真实编排在跑」的**窗内证据**长什么样 —— Bridge 哪个只读端点能证明窗内它确实忙。
4. 耳朵端计包的具体实现路径(Discord receiver / opus 包 / 每秒切片)。
5. 30 分钟真跑一场的**成本与失败模式**(Realtime 额度、房间被第三人闯入、机器休眠)。
