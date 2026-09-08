# FLY-2383 语音并发半小时实测 — 跑场日志

Issue: FLY-2383 (https://linear.app/geoforge3d/issue/FLY-2383/raya语音实测-prd-1850-73-未量的那一半真实-runner-编排在跑-语音在流-半小时量级-不挂-founder工程自测)
日期: 2026-09-06
基于: plan.md

> **这份日志记录【每一场】,包括作废的。**
> 只留跑通的那次,等于在制造一个不存在的稳定性。

---

## 1. 场次总账

| 场次 | 配置 | 时长 | 结果 | 为什么 |
|---|---|---|---|---|
| `fly2383-pilot-on-r1` | ON,校准 | — | **作废** | 尺子 bug:`runSubjectPreflight` 自己会校验收据,但我没把 `voiceBotId`/`channelId` 传给它 ⇒ 报 identity mismatch |
| `fly2383-pilot-on-r2` | ON,校准 | — | **作废** | 尺子 bug:写锁收据缺 `subjectCliPath` 字段 |
| `fly2383-pilot-on-r3` | ON,校准 | 49.7s | **作废** | 尺子 bug:**把自己的阻塞当成了机器休眠** —— 注入轮在主循环里跑,单轮 ~28s > 15s 的 lag 上限,误判 `clock_anomaly`。顺带 cleanup census 只查一次就判「身份没退干净」 |
| `fly2383-pilot-on-r4` | ON,校准 | 303s | **有效**(但尺子还不准) | 通了。发现 ①nonce 用十六进制串**过不了 TTS→ASR**(`kestrel-abcf042` 被听成 `castra b c f 042`);②工具轮没有 canary 文件可读;③manifest 的秒桶是从**内存环**算的,不是全量流 ⇒ 245 个假空洞 |
| `fly2383-pilot-on-r5` | ON,校准 | 333s | **有效** | 改六位数字口令 + 逐位念 + 只按数字匹配后,**6 轮里 5 轮拿到逐字回令**,含一次真读文件。第 6 轮工具题她**答了缓存值没重读** |
| `fly2383-pilot-on-r6` | ON,校准 | — | **标定用** | 加了 T0 的 wall/mono 锚点。发现**等待音几乎没响** |
| `fly2383-pilot-off-r1` | OFF,校准 | — | **标定用** | 与 r6 对照,确认 r6 那几簇低能量帧确实只在 ON 出现 |
| `fly2383-pilot-on-r7` | ON,校准 | 420s | **标定基准** | 改成「先给她一件真花时间的活」之后,等待音窗终于有连续内容 |
| `fly2383-pilot-off-r2` | OFF,校准 | 420s | **负对照** | 同协议、只关 `bedEnabled` |
| `fly2383-main-arm-a-r1` | ON,正场 | **~11 分钟被杀** | **作废** | **系统内存不足**,driver 连同语音进程一起被 kill(SIGKILL ⇒ 走不到 finally,没有 manifest)。详见 §7 |
| `fly2383-main-arm-a-r2` | ON,正场 | **<1 分钟被杀** | **作废** | 同上。**这一次留下了后遗症**:两个 QA bot 被卡在 voice-test-3 里(见 §7.2) |
| `fly2383-main-arm-a-r3` | ON,正场 | 0s | **作废** | `QA voice room is not empty before spawn` —— 前置守卫**正确地**拒跑,因为 r2 的残留 bot 还占着房 |
| `fly2383-main-arm-a-r4` | ON,正场 | 1,802,202 ms | **作废** | 跑完且三条件成立,但**代码评审判尺子 5 处 P0** ⇒ 数据不采信(见 §9) |
| `fly2383-main-arm-b-r1` | OFF,对照 | 902,613 ms | **作废** | 同上 |
| `fly2383-smoke-r2` | ON,验证 | 240,649 ms | 有效 | 修完 collector 后的 4 分钟短跑,确认 T1 冻结 / 收据落盘 / provenance 完整 |
| `fly2383-main-arm-b-r2` | OFF,对照 | 901,875 ms | **作废** | **新加的空洞守卫正确拒收**:101 空洞 / 902 秒 = 11.2% > 10% 上限 |
| **`fly2383-main-arm-a-r5`** | ON,正场 | **1,802,534 ms** | **有效** | 三条件全部成立,60 份原始 Bridge 收据已落盘 |
| **`fly2383-main-arm-b-r3`** | OFF,对照 | 901,423 ms | **有效** | 12 个空洞,verdict VALID |

---

## 2. 尺子在跑通之前错了三次 —— 都记下来

三次都不是「代码写崩了」,是**量法本身站不住**:

1. **把自己的阻塞当成机器休眠**(r3)。注入轮同步跑在采样主循环里,一轮 28 秒,
   于是 lag 检查看到一个 33 秒的「跳变」。
   ⇒ 改成注入与采样并发,且**只计时那一次 `sleep`**,不计自己干活的时间。
2. **秒桶从内存环算**(r4)。内存只留最近一分钟,于是 303 秒里报了 245 个「空洞」。
   ⇒ 秒桶必须从落盘的全量帧流算。
3. **口令过不了语音链路**(r4)。这条最要紧:
   ```
   我发的      kestrel-abcf042
   她听到的    castra b c f 042
   ```
   ⇒ 十六进制串在 TTS→ASR 上不可靠;**数字可靠**。改成六位数字、逐位念、只按数字匹配。
   同理**文件名不能念**:`canary.txt` 回来是 `panory_tx7` / `panary.txT`,
   她于是去找一个不存在的文件。改成「你当前工作目录里唯一的那个文本文件」。

---

## 3. 🔴 实测发现:**等待音只在「有 Codex item 在跑」时响,思考不算**

这条是跑 r6 才发现的,它**改变了等待音那半格能问什么**。

### 3.1 现象

r6 里她为一道工具题忙了 **22.7 秒**(user final 152.1s → assistant final 174.8s),
但耳朵端在整个忙窗里只收到 **8 帧** 低能量音频(~160ms)。

### 3.2 原因(读源码,不是猜)

```
Coordinator.ts:495-507   busy 由 ItemStarted 置位、ItemCompleted 清除
runtime.ts:2077-2090     busy 持续超过 minBusyMs(默认 1000ms)才 setBedActive(true)
```

⇒ **「item」是一次工具执行,不是一次思考。** 读一个文件几十毫秒就结束,
**够不到 1 秒的门槛**;她「在想」的那 20 秒里,`busy` 是空的,等待音不响。

### 3.3 对本单的后果

⛔ 不能拿「问一道题→她忙→等待音响」当默认前提。
⇒ 等待音轮改成**两段**:先请她跑一件真花时间的活(`sleep 30`),
待 item 起来、她也说完话之后,再把探针句注进去。

改完之后,等待音窗从 8 帧变成 **163/200、200/200 帧有内容**。

> ### 🔑 **这条本身就是给 PRD 的答案的一部分**:
> ### **等待音回答的是「工具在跑」,不是「它在想」。**
> ⛔ 不许把它读成「它没在推进的时候会有声音陪着她」。

---

## 4. 🔴 实测发现:**Raya 自报的 `audio_counters` 里没有 bed 这一档**

两场收尾计数(ON / OFF)几乎一模一样:

```
ON  {"silence":17209,"voice":1750,"sent":18695,"clock:stall":13, ...}
OFF {"silence":17275,"voice":1730,"sent":18795,"clock:stall":13, ...}
```

`Downlink.ts:211-214` 对**所有非 voice 帧一律记 `silence`** ⇒ **bed 没有独立计数器**。

⇒ **被测进程自己说不出等待音响了多久。** 只有耳朵端能看见它。
(这条 Codex 在第 2 轮评审就指出过,实测印证。)

---

## 5. 分类器标定 —— **负对照是它成立的原因**

标签**不取自分类器自己**:

| 标签 | 锚点 |
|---|---|
| `silence` | T0+2s → 第一次注入前 1s(什么都还没问) |
| `voice` | assistant final 之后 0.4–4.0s ——(实测:**音频簇在该转写行之后数百毫秒内起来**,不是说完才写行)⚠️ **这是回答窗,含真实字间停顿,不是帧级 speech-on 标注** |
| `bed` | driver 自己记录的「她在跑活」那段窗 |
| onset(过渡) | 用**与阈值无关**的锚点定位:超过 bed 窗最大能量的第一帧,之后 400ms |

### 5.1 冻结的阈值

```json
{ "silenceFloor": 0.0010164, "bedTonalMin": 0.9,
  "bedEnergyMax": 0.026789, "voiceEnergyMin": 0.026789, "voiceTonalMax": 1 }
```

分档规则(四档,`unknown` 是一等公民):

```
energy < silenceFloor                     → silence
quiet 且 tonalRatio ≥ 0.9                 → bed        （BoxB 五音的 Goertzel 能量占比）
energy > bedEnergyMax                     → voice
其余(安静但不成调)                        → unknown    ← 守卫按「可能是 voice」处理
```

### 5.2 holdout(**未参与定阈值**的窗)

| 窗 | 帧 | voice | bed | silence | unknown |
|---|---:|---:|---:|---:|---:|
| silence | 228 | 0 | 0 | 228 | 0 |
| bed | 120 | 0 | **120** | 0 | 0 |
| voice | 481 | 282 | **1** | 99 | 99 |
| onset | 185 | **144** | 2 | 10 | 29 |

判据是**方向性**的,不是逐帧准确率 —— `unknown` 在哪都允许。
⚠️ **政策上限 vs 实测值**(⛔ 不是逐帧保证):
voice 窗 `bedShare ≤ 5%` 政策 / **0.21%** 实测;
transition anchor 窗 `bedShare ≤ 5%` 政策 / 1.08% 实测、`voiceShare ≥ 50%` 政策 / 77.8% 实测;
bed 窗 `bedShare ≥ 50%` 政策 / **100%** 实测。

### 5.3 🔑 负对照

```
bed-OFF 臂的「她在跑活」窗:405 帧 → bed 0 帧(100% silence)
```

> ### **同一个检测器,在等待音关掉之后一帧都找不到。**
> ### 这才是「它看见的确实是等待音」的证据 —— 不是它的噪声门限在抖。

---

## 6. 一条顺带看见的产品行为(⛔ 不在本单处置)

r5 第 6 轮工具题,她答的是**上一轮缓存的数字**(「文件里的数字**还是** 1 7 1 6 3 8」),
而那时文件内容已经换了。

⚠️ **成色**:N=1,未复现,**不是本单的判据**。只记录。


---

## 7. 正场第一次跑砸:**被系统按内存杀掉**

`fly2383-main-arm-a-r1` 跑到 ~11 分钟(约 645 / 1800 秒)时,
后台任务返回 `killed —— system is running low on memory`。

- SIGKILL **不经过 finally** ⇒ **没有 manifest**,这一场**没有任何可用结论**。
- 善后实测:**没有孤儿语音进程**(进程组随父进程一起走了);
  `.raya-voice-529.lock` 留了一份 owner pid 已消失的**陈旧收据** ——
  下一场 `acquireScenarioLock` 会识别并接管,不用手工清。
- ⛔ **不许把这 11 分钟当成「半小时的一部分」。** 按 plan §2.1:中断 ⇒ 本场 INVALID,**整场重跑**。

### 7.1 顺带查出我自己代码里的一个内存缺陷(与被杀无关,但会加重它)

`buildManifest` 原本用 `readFrameStream()` 把**整个 `frames.jsonl` 读成数组**再分桶。
半小时 ≈ **9 万帧** ⇒ 那是整场最大的一次分配,而且**正好发生在收尾写 manifest 的时刻**。

⇒ 改成**增量折叠**:`createSecondBucketAccumulator` 边读边归桶,读完即弃;
文件按 1 MB 分块读,不一次性 `readFileSync`。

> 🔑 **它不是被杀的原因**(被杀时离收尾还有 19 分钟),
> **但它会让最需要内存的那一刻最缺内存。** 重跑之前先修掉。

### 7.2 r2 被杀的后遗症:两个 QA bot 卡在房里

r3 起跑即被前置守卫拦下:`QA voice room is not empty before spawn`。
⇒ **守卫是对的** —— 房里确实有人:

```
voice-test-3 members: [1493068669444427927 flywheel-test-1, 1493072948683341976 product-lead-test]
```

SIGKILL 不走 `leave()`,Discord 那侧的 voice state 属于**已经死掉的 gateway session**,不会自己立刻消失。

清理试了三种,只有第三种有效:

| 办法 | 结果 |
|---|---|
| 新开 gateway 连接发 OP4 `channel_id: null` | **无效** —— 新 session 本来就没有 voice state,那条陈旧状态挂在旧 session 上 |
| REST `PATCH /guilds/{g}/members/{u}` `{channel_id:null}` | **403 Missing Permissions** —— QA bot 没有 Move Members |
| **各自用自己的 token 重新 join 一次、再干净地 leave** | ✅ **有效** —— join 会**顶替**掉那条陈旧 voice state,destroy 再把它清干净 |

清完复核:两个 QA 房 members 都是 `[]`。

> 🔑 **值得记住的一条**:被 SIGKILL 打断的 529 场次,**不会自己把房腾出来**;
> 下一场会被前置守卫挡住(这是**好事**,不是 bug)。
> 复位办法是**让同一个身份重新进一次再正常退出**,不是去要 Move Members 权限。


---

## 8. 正场跑完之后又抓出两个量法错误(**都是从留存证据重算的,没有重跑半小时**)

### 8.1 🔴 「往返」原本是假的 —— 它测的是我自己的那段 sleep

driver 里原本这么写:

```js
round.rttPlaybackToAssistantMs = round.turnCompleted
  ? Math.round(nowMono() - round.playbackStartedAtMonoMs)   // ← 取在 await sleep(20s) 之后
  : null;
```

⇒ 每一轮都被压进 **26–28 秒**的同一个 band,**无论她实际答得多快**。

```
原始(假)   26,024 / 26,212 / 26,219 / 28,105 / 28,111 / 28,118 …   ← 全是 20s sleep + 开销
重算(真)   纯问答 8.1–14.6s · 带工具 19.3–21.5s · 忙窗探针 5.7–5.9s
```

**改法**:从 assistant 转写行**自己的时间戳**算(证据里本来就有 `ts`,
manifest 里也有 T0 的 wall/mono 锚点)⇒ 不用重跑,直接重算。
driver 也已改成同一算法。

> ### 🔑 **一个「看着像测量、其实是自己那段等待」的数字,比没有数字更糟。**

### 8.2 普通 turn 被拿等待音的规矩去判

`judgeAudioEligibility` 的 `arm` 只有 `on` / `off` 两档,而它们**都要求 bed** ——
于是 10 次普通 turn 全被判成 `not_in_bed_window`:**一个对它们根本不适用的理由**。

⇒ 加第三档 `arm: "turn"`:**不对 bed 作任何要求**,只查「她有没有抢在我们播放时开口」。
重算结果:**10 / 10 未被污染**。

### 8.3 顺带看清了臂 A 那 3 次 `ambiguous_audio` 是怎么来的

被判 `unknown` 的帧,能量落在 bed 区间内(0.008–0.021),但 `tonalRatio` 只有 0.03–0.14 ——
**那是等待音自己的衰减尾巴和音符间隙**:够安静,但那一刻不成调。
`unknown` 按设计 fail-closed ⇒ 整窗被排除。

> ### ⇒ **等待音的存在本身会压低「等待音臂」的可用样本数。**
> ### ⇒ 两臂 eligible 数天然不对称(2 vs 3),⛔ **不是「臂 A 表现差」。**


---

## 9. 代码评审判 5 处 P0 ⇒ r4 / b-r1 **跑通了也不采信**

评审结论是硬的:**本单的产品是数据,不是 driver**。尺子当时有 5 处会让数字比证据强:

| # | 问题 | 实际后果 |
|---|---|---|
| 1 | 观测窗**结束点取在 cleanup 之后** | duration / 帧数 / 空洞都含 teardown 尾巴;更糟的是 `voice_exit` 落在 T0+1,801,922ms,**早于**我报的窗口结束 ⇒ 我在一个**包含它自己退出**的窗口上写「0 次 voice_exit」 |
| 2 | 条件③的 **60 份 Bridge 原始收据根本没落盘** | 「60/60 executing」**无法复现**,而附录却写着「每次 /status 原始收据」 |
| 3 | 静默守卫 / eligibility 在**采样稀疏时 fail-open** | 实测有一轮的「3 秒静默窗」**只有最后 48ms 有观测**,前 2.9 秒是瞎的 |
| 4 | provenance 没绑住实际执行物 | 尤其 `packages/contracts/dist/index.js` 被 raya `.gitignore`,**不在任何 commit 里** |
| 5 | 附录 6 处说过头 | 含**自相矛盾**:§5.5 写「臂 B 仍有 0.60s bed」,§8 写「关掉就消失」;以及「表由 script 生成非手抄」—— **script 当时只出 JSON,markdown 是手写的** |

⇒ 全部修在 collector 里,**重跑**,不事后打补丁(P0-2 的原始收据不可再生)。

---

## 10. 🔴 标定的天花板:**回答窗内有一批帧与等待音同区**

Lead 批准把 transition 规则收紧成「**bed 逐帧为 0**」。按新规则重跑标定 —— **不通过**:

```
transition 185 帧 → 2 帧判 bed(1.08%)
   energy 0.02423  tonal 1.0
   energy 0.00744  tonal 0.9488
```

放大到**回答窗**(assistant final 后 0.4–4.0s;⚠️ **粗窗,含真实字间停顿,不是帧级 speech-on 标注**)量一遍:

```
n = 1603  →  voice 965 / unknown 343 / silence 277 / bed 18
bed 误判率 1.12%,这 18 帧的 tonalRatio 最高到 1.0 —— 和 BoxB 音符完全一样
```

> ### 🔑 **回答窗里有一批又轻又强烈成调的帧,落在与 BoxB 音符相同的 (energy, tonalRatio) 区域,
> ### 在这两维上无法与等待音分开。⛔ 提高 `bedTonalMin` 对它们无效 —— tonal 就是 1.0。**
> ⚠️ ⛔ **不能据此断言「它们是持续元音」或「她说话与等待音不可分」** —— 缺帧级 speech-on 标注。

**窗级判据仍在工作**:臂 A 10 轮全部 uncontaminated,3 次被排除的探针**都是被 `unknown` 挡下的**
(fail-closed 正常工作)。

> 🔴 **但⛔ 不能由此说「真抢话不会整窗漏判」** —— 那句话我写过,**已删**:
> 回答窗内实测到**最长 960ms 的连续「不拦截」段**,直接反证了它。
> **本轮无法判断一次真实抢话会不会被拦下**,那需要帧级 speech-on 标注。

⇒ 已把这条**连同 1.12% 的数字**报给 Lead 裁定(A:写成尺子的已知上限 / B:加特征重标定重跑 / C:放弃这半格)。
⛔ **在裁定之前不发附录** —— 不让一份「自己规则都没过」的标定去支撑数据。
