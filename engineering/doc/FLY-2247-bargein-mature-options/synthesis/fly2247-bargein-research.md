# FLY-2247 barge-in — 外部报告核验 + Raya 链路接入面分析(合成建议)

Issue: FLY-2247 · 日期: 2026-09-02 · 作者: runner-815c477c
基于:
- `~/.flywheel/artifacts/fly2247-dr-report.md`(founder 亲手导出的 ChatGPT Deep Research 全文,421 行,29 引用;URL 列表未随复制带出)
- 我方独立代码审计(PR #1029,`engineering/doc/FLY-2247-bargein-mature-options/`,经六轮独立设计评审)
- 世界:`codex-oss` HEAD `49025589` · 装机 `codex-cli 0.152.1` · raya `origin/fly-2178-2205-integration-c907f5dc-v2` 头 `cac1d1c`

> 本文**不复述**外部综述(Lead 指令 ①)。它做三件事:**核验报告的关键断言**、**把报告的推荐架构映射到 Raya 现有链路**、**给迁移步骤**。
> 成色:✅ = 我亲手核过原件(附行号/命令);🤝 = 报告与我方独立证据**互相印证**;📖 = 只有报告一方,我未独立核;⬜ = 未验。

---

## 0. 一句话

**报告推荐的那套架构是对的,但它今天在我们的链路上跑不起来 —— 它对 OpenAI 侧提出的四个要求,全部被 `codex app-server` 这一层挡死了。**

报告假设我们直连 OpenAI Realtime。我们不是:Raya 走 `codex app-server` 的 `thread/realtime/*`。报告推荐架构的四个 OpenAI 侧前提,逐条对照我们的实际可达性:

| 报告要求 | 我们的状态 | 证据 |
|---|---|---|
| `interrupt_response: false`(**别让 VAD 做破坏性决定**) | ⛔ **不可配**,硬编码 `true` | `methods_v2.rs:94-105` ✅ |
| 确认后再发 `response.cancel` | ⛔ **出站消息枚举里没有这个变体** | `protocol.rs:51-84` ✅ |
| 按真实播出毫秒发 `conversation.item.truncate` | ⛔ 我们发不出;Codex 自己那条也走不到(item_id 判等恒假) | `RealtimeTransport.ts` + `realtime_conversation.rs:2151-2176` ✅ |
| `semantic_vad` 管轮次结束 | ⛔ `TurnDetectionType` 枚举只有 `ServerVad`;装机二进制 0 命中 | `protocol.rs:190-194` + `strings` ✅ |

⇒ **报告里那句"最关键的工程选择"—— 第一阶段只在本地停声、不立刻毁掉 OpenAI 的 response —— 恰恰是我们今天做不到的那一件事。** 服务端在我们收到任何通知之前就已经按 `interrupt_response: true` 取消了。

⇒ 这把上游请求从"可选优化"提到了**架构前提**:没有它,报告的可逆两段式只能实现一半(本地那一半)。

---

## 1. 核验报告的三条关键断言(Lead 指令 ①)

### 1.1 「`semantic_vad` 不是 backchannel-aware 的打断分类器」— 🤝 **证实**

- 报告依据:OpenAI 文档把 semantic VAD 定义为**语义化的"用户说完了没有"**分类器,并未声称它在**语音起点**区分"真插话 vs 附和"。
- 我方独立取证:官方 VAD 文档原文 —— semantic_vad「uses a semantic classifier to detect **when the user has finished speaking**」;`eagerness` 只有 `low/medium/high/auto`,`auto`≡`medium`。✅
- 报告补的那步推理很有力,我认同:**「yeah」本身在语义上就是一个完整话语**,所以"语义完整性"跟"打断意图"根本不是同一件事。
- 我方额外一条报告没有的证据:**这条路在我们这里连"要不要用"都轮不到** —— Codex 枚举里没有它(§0)。
- ⚠️ 我此前引过一条社区报告(开 semantic_vad 后 `speech_started` 不再发),**至今没有版本/样本/官方确认**。报告也未提及。⇒ **仍是待验证假设,不作为排除理由。**

**⇒ 结论一致:不要把 semantic_vad 当 barge-in 分类器用。我方补充:也别为它推上游,优先级排在 §5 那三个台阶之后。**

### 1.2 「LiveKit / Pipecat / Vapi / Deepgram / Retell 的三层拆分」— 🤝 **部分独立证实,其余采信报告**

| 栈 | 报告断言 | 我方独立核验 |
|---|---|---|
| **LiveKit** | `interruption.mode="adaptive"` 是 context-aware barge-in 模型,`"vad"` 是退化路径;`false_interruption_timeout` 2.0s、`resume_false_interruption` 默认 True;`min_interruption_duration` 0.5s | 🤝 **我独立核过全部四项**(官方文档),与报告一致 |
| **Pipecat** | 打断必须同时清掉已排队播放,只 cancel 生成不够;Krisp IP 在 VAD 之后 | 🤝 前半我独立核过;Krisp IP 细节 📖 采信报告 |
| **Vapi** | VAD 50–100ms vs 转写 200–500ms;`voiceSeconds:0.2`;`acknowledgementPhrases` | 📖 **未独立核** |
| **Deepgram** | `UserStartedSpeaking` → 立刻 flush;Flux ~260ms EOT | 📖 **未独立核** |
| **Retell** | `interruption_sensitivity` 0–1;分类器内部未公开 | 📖 **未独立核** |

**⇒ 三层拆分(声学快门 / 意图确认 / 会话态去留)在我独立核过的两家(LiveKit、Pipecat)上成立;另三家采信报告。这个结论对本单足够 —— 五家一致与两家一致导出的架构建议相同。**

⚠️ **报告有一处比我准,我据此修正**:我在 PR #1029 里写「成熟栈把规则砍到一个阈值,判别力全在 VAD 里」,后来经评审改成「它们换了更强的检测器」。报告说得更准:**它们是在 VAD 之上加了一层专门的打断分类器**,而不是把 VAD 换得更好就完事。⇒ 判别力的位置是「VAD 之上多一层」,不是「VAD 内部更强」。

### 1.3 「本地 Silero ~100ms 可逆停口架构」— 🤝 **规格证实;时延是工程预算而非 SLA(报告自己也这么标)**

- Silero 规格我独立核过:JIT ~2MB、30ms+ chunk **<1ms** 单核、8/16kHz、MIT、v5 要 **512 样本 @16k = 32ms 定帧**。✅ 与报告一致。
- ROC-AUC 表(WebRTC 0.73 / TEN 0.93 / Silero v5 0.96 / v6 0.97)📖 **我未独立核**,且**报告自己标明这是 Silero 自家维护的基准**,并说"deserves validation on your Discord corpus"。⇒ **不能当成第三方结论用**,但量级足以支持"别再用能量/密度"。
- 「~100–150ms 本地可听停口」报告明说是 **pipeline calculation, not a Silero latency SLA**。⇒ 我采信为**设计目标**,不是可承诺的数字。

**⇒ 三条断言全部通过核验。报告没有需要我推翻的地方 —— 只有一处它比我准(§1.2 那条),已采纳。**

### 1.4 报告独立证实了我方两条评审期间才纠正过来的结论

这两条我是被独立设计评审逼出来的,报告给了外部佐证,值得记一笔:

1. **`prefix_padding_ms` 不是误触控制面。** 报告表格原文:「useful for ASR/model context, **not primarily an interruption-latency control**」。我在第五轮才改对(此前把它和 `threshold` 并列成"都能降误触率")。🤝
2. **通用 LLM 不进"让声音停下来"的热路径。** 报告:「I found little current primary-source evidence that major production frameworks put an ordinary general-purpose LLM call between VAD and 'stop speaker output now.'」🤝 与我方 R4 一致。

---

## 2. 报告点破了我们那次故障的根因,而且比我说得更准

报告在 Discord 一节里有两句话,直接命中 FLY-2178 attempt-17 的失败:

> - **「Discord suppresses audio transmission during silence」** ⇒「没收到 RTP 包」≠「检测器收到了 300ms 的零值 PCM」。
> - **「Do not use Discord packet density itself as your barge-in feature.」** 静默抑制、抖动、Opus 帧长可变、包聚合、丢包**全都污染 density**。

我方 QA 实测的失败形态(📖 FLY-2178 `rework-vad-research.md`):旧 `BargeGate` 把**网络到达抖动**当语音连续性(`MAX_CONTINUITY_GAP_MS=40ms` 在常见 55ms 抖动下反复清零),6 次样本 4 次 >1s、最慢 2351ms。

**⇒ 这是同一个根因的两种说法,报告的更普适。** attempt-18 用「定帧 + 按已处理帧数计时长」修掉了它 —— 这一步方向是对的、应保留。

⚠️ 报告还有一条我们**没做**的:**「Do VAD per speaker, not after mixing」**。Raya 的 `Uplink` 是**单 owner**(`speakingStart` 认领,`Uplink.ts:44-63` ✅),所以事实上已经是 per-speaker 了 —— 但那是"只听一个人",不是"每个人各一套状态机"。多人房里第三人说话时的行为 ⬜ 未验,列入 §6。

---

## 3. 接入面:报告推荐管线 → Raya 现有链路逐段映射(Lead 指令 ②)

报告推荐:
```
Discord Opus → 解码/抖动缓冲 → 本地神经 VAD → 立即暂停/duck 本地播放
   → 声学/partial-ASR 意图确认 → 或恢复播放,或 response.cancel + truncate
```

逐段对照 Raya `cac1d1c`:

| 段 | 报告要求 | Raya 现状 | 差距 | 改动面 |
|---|---|---|---|---|
| **Discord 入口** | per-speaker Opus 解码 + 小抖动缓冲 | `Uplink` 单 owner 认领 + jitter ✅ | 基本符合;多人策略未定 | 无(除非要多人策略) |
| **帧化** | 定长媒体帧,按媒体时间戳而非到达节奏 | attempt-18 已改成 20ms 定帧 + 按已处理帧计时 ✅ | ✅ **已符合** | 无 |
| **快速语音门** | **Silero v6 @16kHz** | `WebRtcSpeechDetector` mode 3 @48k→单声道 | 换模型 + 48k→16k 重采样 + **32ms 定帧**(现 20ms) | **中**:`WebRtcSpeechDetector` 换实现 + 新增重采样 + 重组帧;`onnxruntime-node` 原生依赖 |
| **规则层** | 短迟滞窗(多帧正 → 触发) | `BargeGate` **6 组手调常数**(密度 7/10、犹豫窗 800ms、连续段 80ms、锚段 240ms、`sustainMs` 350、`yieldGrace` 1000) | 报告要的是"多帧确认",不是六组形态规则 | **中**:删 5 组常数,只留 `sustainMs`(量级对齐 LiveKit 0.5s / Vapi 0.2s) |
| **立即反应** | **暂停/duck 本地播放,可逆,保留有界缓冲** | ⛔ **`interruptVoice()` 是破坏性的**:flush FrameQueue + `stream.end()` + 重建 resource | 🔴 **最大结构差距,见 §4** | **中**:`Downlink` 加一个可逆暂停态 |
| **意图确认窗** | 100–300ms 声学/partial-ASR 证据 | `bargeInArbitrationWindowMs` **默认 2500ms**,等的是 **user final 转写** | 我们等的是 final(1–3s),不是 partial | **中–大**:要 partial 才能压到 100–300ms |
| **真打断提交** | `response.cancel` + 按真实播出 ms `truncate` | ⛔ **两个都发不出** | 🔴 **上游阻塞** | **上游**(§5 台阶 2/3) |
| **假打断恢复** | 恢复本地缓冲的助手音频 | ⛔ **没有可恢复的音频**(见 §4);只能重念 inbox 条目 | 🔴 见 §4 | 随 §4 一起 |
| **别让平台自动毁掉 response** | `interrupt_response: false` | ⛔ 硬编码 `true` | 🔴 **上游阻塞** | **上游**(§5 台阶 3) |
| **下行缓冲要浅** | 每多 100ms 缓冲 = 多说 100ms | `downlinkTargetFrames` 5(=100ms 目标深度),但 **`FrameQueue` 无上界** | 目标深度 OK,积压无界 | **小**:给 FrameQueue 上界 |
| **可观测性** | 分开测 false-barge / missed-barge / stop 时延 / resume 时延 | 有 `barge_yield_local` 等事件族,但**没有按这四类分开的指标** | 指标口径 | **小**:evidence 事件补字段 |

---

## 4. 一个此前没解释的现象,报告给了它根因

**现象**(独立设计评审第二轮抓到,我核过源码):Raya 的"假打断恢复"**只覆盖 inbox 念读条目**,普通对话轮次被误掐就是没了。
`Speaker.suspendInbox()` 显式要求 `pendingKey.startsWith("inbox:")`(`Speaker.ts:237-248` ✅)。

**此前我只把它归因为「机制只对 inbox 建过」。读完报告再回去看 `Downlink`,发现更深一层的根因:**

```ts
// Downlink.ts:91-95  ✅
pushPcm24Mono(chunk, gen) {
  ...
  if (this.voiceSuppressed) { this.suppressedDeltas += 1; return; }   // ← 丢弃,不是缓冲
  this.queue.push(...)
}
```

`suppressVoice()` 期间到达的助手音频 **被丢弃并只计数**(`suppressedDeltas`),不进任何缓冲。而 `releaseVoiceSuppression()` 只是清标志位、返回那个计数。

⇒ **Raya 根本没有"可逆暂停"这个原语。** 现有 yield 路径是:
```
BargeGate 命中 → interruptVoice()（破坏性 flush）→ suppressVoice()（后续 delta 丢弃）
              → 仲裁窗 2500ms → 假触发 → releaseVoiceSuppression()（没有东西可恢复）
```

⇒ 所以「恢复」在架构上**只能**靠重新注入源文本 —— 而唯一有源文本的就是 inbox 条目。**普通对话轮次没有源文本、也没有 resume handle,于是无解。**

**这不是"少建了一个功能",是"缺了一个原语"。** 报告要的正是这个原语:
> keep accepting a **bounded** amount of OpenAI output audio into a **reversible** buffer … 200–400ms confirmation window … if false, **resume the buffer**.

⚠️ **但补上这个原语只解决一半。** 即便本地可逆了,服务端仍按 `interrupt_response: true` 在我们收到通知前就取消了生成 ⇒ 缓冲里只有"已经到达的那一小段",恢复后很快撞到静音。
**⇒ 本地可逆缓冲(我们能做)与 `interrupt_response: false`(上游阻塞)是一对,缺一不可。** 这是整份分析里耦合最紧的一处。

---

## 5. 迁移步骤(标注哪些不依赖上游)

### 阶段 A —— 完全不依赖上游,现在就能做

| # | 动作 | 改动面 | 为什么先做 |
|---|---|---|---|
| **A1** | `Downlink` 增加**可逆暂停**原语:`pausePlayout()` 停止喂 Discord player 但**保留**队列(有界,建议 300–400ms);`resumePlayout()` 续播;`abandonPlayout()` = 现 `interruptVoice()` | 中,**单文件** `Downlink.ts` + runtime 调用点 | §4 的缺失原语。**它是后面一切可逆行为的地基**,且不需要上游任何东西 |
| **A2** | 给 `FrameQueue` 上界(现无上界) | 小 | 报告:"Do not let it grow without bound";也是 P2 探针要量的那个上界 |
| **A3** | yield 路径改为 `pausePlayout()` 优先,只有仲裁判真才 `abandonPlayout()` | 小(runtime `:955-961`、`:1165-1180`) | 把"破坏性优先"翻成"可逆优先" |
| **A4** | 接上 `thread/realtime/itemAdded` 的 `speech_started`,**只记 evidence** | 小(~10 行) | 第一次看见平台在做什么;也是探针的必要前置(现成 debug tap 只写 method 名,分不出它) |
| **A5** | 指标按报告口径拆开:false-barge / missed-barge / onset→本地停声 / onset→提交 / resume 成功率 | 小 | 没有这组数,后面任何阈值调整都是盲调 |
| **A6** | 采 Discord 真实语料评测集(报告列的清单:清晰打断、轻声打断、"等一下/不/停"、长附和、短"嗯/哈"、游戏麦呼吸、键盘声、咳嗽、第三人说话、丢包、游戏音漏进麦) | 中(人工采集) | **它是 Silero 该不该换、阈值定多少的唯一裁判**;也是 c-full 那一档探针的素材 |

### 阶段 B —— 依赖 A6 的数据

| # | 动作 | 条件 |
|---|---|---|
| **B1** | `WebRtcSpeechDetector` → Silero(ONNX,16kHz,512 样本定帧) | A6 数据显示 WebRTC mode 3 在我们语料上确实弱 |
| **B2** | 删 `BargeGate` 5 组手调常数,只留 `sustainMs`(量级对齐 0.2–0.5s) | 与 B1 **成对**做(报告 §1.2 更正:判别力要有地方去) |
| **B3** | 意图确认层:先上**词表 + 词数规则**(Vapi 式:附和词表 + ≥2 词 + "等/不/停/哈"高意图单词直通),不上 LLM | 需要 partial 转写(见 §6 未验项) |

### 阶段 C —— 上游阻塞,按台阶推 Codex

| 台阶 | 要什么 | 前置 | 没有它会怎样 |
|---|---|---|---|
| **C1** | 暴露 `server_vad.threshold` | 无 | 平台误触率无法调。⚠️ 调高是**拿漏检换误触抑制**,调完要用 A6 语料重测两个率 |
| **C2** | 透传 `response.cancel` | 无(可独立交付,不拆现有 fallback) | 本地判真之后无法停生成 |
| **C3** | `interrupt_response` 可配 | **必须先有 C2** | **报告的可逆架构做不完整**:服务端仍在我们之前毁掉 response,本地缓冲恢复后撞静音 |
| **C4** | `conversation.item.truncate` 透传 | C2 | 打断后模型的听感上下文一直是错的(它以为自己讲完了) |

⇒ **C3 是报告那套架构的真正开关。** C1 是止痛药(降误触率),C2/C4 是把控制权拿回来的必要条件。

---

## 6. 这份合成相对 PR #1029 的**修正**(必须明说)

PR #1029 的 `plan.md` 给了一个"去留矩阵":平台事件若**可靠**且**误触更少** ⇒ `BargeGate` 可以删。

**报告让我意识到那个矩阵漏了一个维度:延迟结构。**

平台事件必须走完 `appendAudio` → app-server → OpenAI WS → 判决 → 通知原路返回。报告在"什么不要做"里明写:
> ⛔ **Wait for OpenAI `speech_started` before muting output**

理由是本地 VAD 比远端快 150–200ms 级(Pipecat 文档),而我们的目标是**可听停声 <300ms**。

⇒ **修正后的结论**:
- **`BargeGate`(或其 Silero 继任者)应当保留,并且是快路的主角** —— 不是因为平台信号不可靠,而是因为它**在结构上不可能是快路**。
- **平台事件的角色降为:佐证 + 可观测性 + 兜底**,不是主触发器。
- ⇒ 原矩阵里"平台事件更准就删掉本地层"那一格,**在延迟维度上不成立**;更准只说明该用它去**否决/确认**,不说明该用它去**触发**。

**这是外部报告带来的最有价值的一次修正,我把它明确记在这里,并将 PR #1029 的对应结论视为被本文取代。**

---

## 7. 未核验项 / 边界(诚实标注)

| 项 | 状态 |
|---|---|
| Vapi / Deepgram / Retell 的具体数字与行为 | 📖 只有报告一方,我未独立核 |
| Silero ROC-AUC 对比表 | 📖 **Silero 自家基准**(报告自己标了),需用 A6 语料复现 |
| 「~100–150ms 本地可听停口」 | 📖 报告明说是 pipeline 预算,不是 SLA |
| Raya 是否拿得到 **partial** 转写、多早 | ⬜ **从未量过**。B3 与"确认窗压到 100–300ms"都押在这上面 |
| 多人房里第三人说话时 Raya 的行为 | ⬜ 未验(`Uplink` 单 owner,但没有 per-speaker 状态机) |
| 服务端**实际**是否在真实链路上按 `interrupt_response:true` 取消 | ⬜ 只有官方合同 + 旧版本 n=2 探针;她实测过的「排队不丢」与之矛盾,未裁决 |
| 「开 semantic_vad 后 speech_started 不再发」 | ⬜ 社区报告,无版本/样本/官方确认。**待验证假设,不作排除理由** |
| 报告的引用 | ⚠️ **URL 未随 founder 的复制带出**:全文 **53 处 citation 标记**,形如 `cite⟨sep⟩turn15search0⟨sep⟩turn17search0`(内部 turn 令牌),**全文 `http` 出现 0 次** ✅(`grep -c http` = 0)⇒ 我**无法逐条回溯原始出处**。上表标 🤝 的是我另行独立取证过的,标 📖 的只能追到报告本身 |
| 本文的 A/B/C 步骤 | ⬜ **未经独立设计评审**(PR #1029 的正文经过六轮,本文是其后按 Lead 新指令增补的) |

