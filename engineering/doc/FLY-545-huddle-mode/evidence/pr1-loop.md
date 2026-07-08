# FLY-545 P5 证据 — PR-1 真机收发闭环(验收 A3)
Issue: FLY-545 (URL 不可得,只写 issue 号)
日期: 2026-07-07
基于: plan.md §7 P5 + §8 A3;驱动脚本 = packages/voice-bridge/e2e/pr1-loop.mjs(可复跑)

## 结论:PASS(全三场景,verdict.pass=true)

环境:生产 guild General VC(1485787271192907816 / 1485787273193853170,FLY-960 同一授权
通道);耳朵 = Note-taker(pool-04),扬声 = pool-05(经 `allowUserIds` QA seam 订阅——
生产只订真人,该 seam 让 sender bot 在 rig 里顶替真人,信号路径与生产完全一致:被订阅成员
的 speaking 事件 → backchannel 门 → LeadSpeaker.stop());**驱动的是 dist 真实模块**
(BotRegistry/EarsReceiver/LeadSpeaker/discordWiring),非 mock。

### 场景 A — 收音全链(真实 edge-tts mp3 → opus → 解码 → 降混 16k)

| 指标 | 值 |
|------|----|
| 播放启动(play→Playing) | 207ms(mp3→ffmpeg 转码→opus 编码完整依赖链,A3 要求的真 mp3) |
| 收到 16k mono PCM | 125,440 bytes = **3.92s**(源音频 3.8s,含尾部拖尾帧) |
| Gemini 转写(收到的音频) | 「帮我看一下，hat do模式今天能不能用？」 |

原文「帮我看一下,Huddle 模式今天能不能用?」——中文逐字全对;唯一 miss =「Huddle」
(zh-TTS 读英文专名,FLY-960 校准基线同类问题,非采集链路损伤)。

### 场景 B — backchannel 双证之一(短促附和不打断)

164ms speaking 突发(<350ms):**门未触发** ✓;**speaking start 与 end 事件都被观测到**
✓✓ —— Codex R2 非阻塞护栏 ③(`receiver.speaking` end 事件真机可靠性)在 PR-1 内定死:
**start/end 事件对可靠,无需切 PCM 能量 fallback**。

### 场景 C — barge-in 双证之二(持续说话打断)

| 指标 | 值 | 预算 |
|------|----|----|
| speaking-start → 门触发 | **351ms** | 配置 350ms(1ms 抖动) |
| 门触发 → 停播完成(speak() resolve cancelled) | **0ms** | <100ms(PRD §15) |
| 4s 音频实际播出 | 509ms 即被切断 | — |

### 真机首坑(本闭环抓出的真 bug,已修)

`@discordjs/voice` 的连接注册表按 **(group, guildId)** 键控,group 缺省 `"default"`——
**同一进程内 N 个 bot join 同一 guild 会互相顶掉连接**(FLY-960 spike 是两个独立进程,
没踩到;voice-bridge 单进程多 bot 一上来就全聋:op5 speaking 包 0、opus 包 0)。修复 =
`discordWiring.joinVoice` 传 `group: client.user.id`(每 bot 自成组)。这正是 PR-1 真机
闭环存在的意义——mock 永远抓不到这一层。

## 复现

```bash
cd packages/voice-bridge && npx tsc   # 构建 dist
# clips(真实 edge-tts 产物):
edge-tts --voice zh-CN-XiaoxiaoNeural --file ../../engineering/spike/FLY-545-huddle/ref/s1-question.txt --write-media out/long.mp3
edge-tts --voice zh-CN-XiaoxiaoNeural --text "嗯" --write-media out/en-full.mp3 && ffmpeg -y -i out/en-full.mp3 -t 0.25 out/short.mp3
FLY545_EARS_TOKEN="$(cat ~/.flywheel/discord-bot-pool/flywheel-pool-04/token)" \
FLY545_SPEAKER_TOKEN="$(cat ~/.flywheel/discord-bot-pool/flywheel-pool-05/token)" \
FLY545_GUILD_ID=1485787271192907816 FLY545_CHANNEL_ID=1485787273193853170 \
FLY545_SPEAKER_BOT_ID=1523230048243417178 \
node e2e/pr1-loop.mjs out/long.mp3 out/short.mp3
# 转写(可懂度):
ffmpeg -y -f s16le -ar 16000 -ac 1 -i out/a-received-16k.pcm out/a-received.wav
(cd ../../engineering/spike/FLY-960-dave-stt && GEMINI_API_KEY=... node transcribe.mjs .../out/a-received.wav)
```

事件级日志 out/pr1-loop-events.jsonl(gitignored,复跑即得)。QA 独立复跑要求:自己跑
自己转写,不拿本档的数字当自己的证据。
