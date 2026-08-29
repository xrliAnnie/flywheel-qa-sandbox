# FLY-1006 M2 P6 — Annie 真人语音房终验（QA-FAIL 证据）

Issue: FLY-1006 (URL 不可得,只写 issue 号)
日期: 2026-07-11
基于: p6-live-venue.mjs 真机会话 conv_3501kx4s55v1e13rq2aea9ajdv8h（session jsonl 36686daf）

## 结论

**QA-FAIL（kickback → implement，3 条 defect）**。干净 WAV 预验（6.4s 中位）没暴露
的缺陷，被 Annie 真人语音 + 她亲自的反馈暴露了 —— 这正是真机真人测的价值。链路
本身通（STT 逐字准、cue 处理音响、回话连贯、零 error、droppedLateChunks=0），但她
提出 3 条（见「缺陷」节）：① 延迟从 round 1 的 1.5s 级联雪崩到 round 2 的 28.5s
（barge-in 风暴，「你说话真的很慢」）；② 文本对话在 Discord 看不到；③ 等待期缺
「正在处理」文字状态。三条都修完 + 复验干净才算 PASS。

## 缺陷（defect，可执行）—— 3 条（Annie 亲自补充,Lead 0cac83f7 扩围）

三条都修完 + 复验干净才算 PASS。②③ 与 /glaw(545) F2 的『音效 + 文字提示,
founder 永远能分清坏了 vs 在想』**同一条统一标准**,/eleven 照搬。

### ① barge-in 去抖 + 误打断干净恢复

**真人语音的自然停顿/呼吸被误判成 local barge-in（单场 8+ 次），打断进行中的
claude -p 推理 → 每轮延迟从 ~1.5s 级联恶化到 28s+。**

根因链：`EarsReceiver` 的 backchannel 闸只用「持续说话 >350ms」判 barge-in，把
Annie 说话中的自然停顿/换气/半句停顿都当成新的说话起止 → 反复触发
`onBargeIn` → `ElevenSession.interrupt("local")` 打断正在跑的 claude -p 推理 →
turn 状态在「打断→重开→再打断」间反复，脑请求排队/重启,延迟累积。

**需要**：
- VAD / barge-in **去抖**：静音时长阈值 + 最小连续语音时长 + debounce，让自然停顿
  /呼吸不算一次新打断（真打断 = 用户明显、持续地插话，而非半句停顿）。
- 被误打断后**干净恢复、不堆积**：一次被打断的 claude -p 请求应能干净取消/收敛，
  下一轮从零开始,不让延迟在轮间累积雪崩。

### ② 文本对话不显示（transcript 落了文件但没 surface 给 founder）

Annie 原话：『为什么我和 Eleven 的对话在文本那边没有显示?』

现状：session transcript 确实落盘（`~/.flywheel/voice-eleven/flywheel/<sessionId>.jsonl`
含 user_transcript + agent_response），但**只写文件、没 surface 给她**——她在
Discord 里看不到对话文本。

**需要**：把她的话（STT / user_transcript）+ Eleven 的回话（agent_response）落到
**Discord 文本可见**（panel / thread / 文字频道消息），不是只写一个 jsonl 文件。

### ③ 等待缺「正在处理」文字状态（不能只有音效）

Annie 原话：『它在等待的时候也应该给我显示一个正在处理的状态,这样我就知道现在
是什么情况,而不至于觉得是它坏掉了。』

现状：等待期只有 cue 处理音效（②的修复里 cue 是响的），但**没有文字状态**——她
无法从文本上分清「在想」还是「坏了」（尤其 ① 的延迟雪崩到 28s+ 时，光有音效
不够）。

**需要**：等待/处理期给一个**文字『正在处理』状态**（同 ② 的 Discord 文本面），
音效 + 文字双通道,让 founder 永远能分清「坏了 vs 在想」。= /glaw(545) F2 同款标准。

## 逐轮 timeline（证据）

session_live +0.0s → metadata（pcm_24000/pcm_16000，conv_3501kx4s…）

| 时刻 | 事件 | 说明 |
|------|------|------|
| +14.6 ~ +35.7s | **interruption src=local ×8** + 交替 speech_end/cue_start/cue_stop | 她还没说完第一句,自然停顿/呼吸已被误判成 8+ 次 barge-in |
| +37.2s | user_transcript「Hola，有人听见我说话吗？」+ **first_audio 1474ms** | **Round 1 = 1.5s,快！** STT 逐字准（含西语） |
| +41.8s | agent_response「听得到，你好啊。我是 Flywheel 的语音助手…」 | 回话连贯 |
| +45.3 ~ +48.4s | interruption src=local + speech_end + cue_start | 她接着说,又被误打断 |
| +48.4 → +148.7s | cue_start … **cue_stop（~100 秒！）** | **脑卡~100 秒**,cue 处理音一直响、没答案 |
| +151.2s | speech_end + cue_start | |
| +179.7s | user_transcript「帅，你说话真的很慢，你是每天听我说话吗？还是怎么回事？」+ **first_audio 28467ms** | **Round 2 = 28.5s!** |
| +184.4s | agent_response「我不是每天都在听你…说话慢的话我可以加快…」 | |
| +600.7s | session_ended，droppedLateChunks=0 | 她测满 10 分钟退房 |

**所有 first_audio 延迟**：1474ms（R1 clean）/ 28467ms（R2，前置 ~100s stall）。
**barge-in（local）计数**：单场 8+。**error**：0。

## 环境（排除环境因素）

- load 全程 <12（起 venue 时 10-11，无 40 止损触发）；venue health 全绿
  （pid 22176、:9885 ok、note-taker 常驻、flap=0）。
- shim=sonnet、tunnel 通。
- 所以这是**真实产品缺陷,不是环境/load**。

## 对照（为什么预验没抓到）

| | 预验（bot-injector 干净 WAV） | Annie 真人语音 |
|---|---|---|
| 输入 | 短、干净、无自然停顿 | 带停顿/呼吸/半句 |
| local barge-in | 极少 | 单场 8+ |
| 延迟 | 中位 6.4s（4.3-7.5） | R1 1.5s → R2 28.5s 雪崩 |

预验证明了「管道通 + 理想输入下延迟」;真人测暴露了「真实语音下 barge-in 风暴
→ 延迟雪崩」。两者都需要,缺一不可。

## 复现

venue（p6-live-venue.mjs）起好后真人进 VC 说带自然停顿的话 ≥2 轮,观察
session jsonl（~/.flywheel/voice-eleven/flywheel/<sessionId>.jsonl）的
interruption(src=local) 计数 + first_audio.sinceSpeechEndMs 逐轮走势。
