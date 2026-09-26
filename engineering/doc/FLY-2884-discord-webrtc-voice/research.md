# FLY-2884 Discord 真人接 WebRTC 订阅实时会话 — 调研
Issue: FLY-2884 (https://linear.app/geoforge3d/issue/FLY-2884/语音bprototype-接-discord-真人说话把-webrtc-订阅的实时会话接进测试语音房opus-直转量真人延迟-插话-环境声)
日期: 2026-09-25
基于: exploration.md

## R1. Discord 接收端给的是什么(证据:`@discordjs/voice@0.19.2` dist/index.js)

- `VoiceReceiver.parsePacket`(:2093)顺序:传输层解密(aead)→ 去 RTP 头扩展 → **DAVE 解密**(:2109,`daveSession.decrypt(packet, userId)`)→ 推进该用户的 `AudioReceiveStream`。
- 所以 `receiver.subscribe(userId, {end:{behavior: Manual}})` 读到的每个 chunk 就是**一包纯 Opus 负载(20ms)**,可直接当 RTP PT111 负载。
- 包上**不带时间戳**,只有到达时刻;用户不说话时 Discord 客户端停发(发 5 个 `F8 FF FE` 静音帧后停)。
- DAVE 解密失败按 `decryptionFailureTolerance` 容忍;生产在 `discordWiring.ts:buildVoiceJoinOptions` 显式传 `daveEncryption` / `decryptionFailureTolerance`,原型照抄。

## R2. Discord 播放端怎么吃 Opus(同文件 :613-660)

- `AudioPlayer._stepPrepare` 每 20ms `resource.read()` 一包;读到就(DAVE 加密后)发出,读不到就发 `SILENCE_FRAME` 并 `missedFrames++`,到 `maxMissedFrames`(默认 5)停播。
- `createAudioResource(readable, {inputType: StreamType.Opus})` 接受逐包的 Opus 对象流 → **下行不需要解码/重编码**。
- 生产把 `maxMissedFrames` 调到 250(FLY-967:默认值会在网络空档把流杀掉),原型同样放大。
- DAVE 加密在 `encrypt()`(:937)里对 Opus 帧整体做,跟我们给的是哪家编码器产出的 Opus 无关。

## R3. WebRTC 端(FLY-2881 第五版实测 + codex 0.157.0 二进制方法表)

- SDP answer:`m=audio … 111`,`a=rtpmap:111 opus/48000/2`,`a=ice-lite`;连接后下行 RTP 立即连续到达(第五版 `first_rtp_in` 在 `pc_connected` 后 0.6s),即服务端**连续发包**(含静音)。
- app-server 实时通知全集(二进制字符串):`started / itemAdded / item/started / item/transcript/delta / item/completed / transcript/delta / transcript/done / outputAudio/delta / sdp / error / closed`。
  WebRTC 下音频不走 `outputAudio/delta`,走 RTP。
- 请求:`start / appendAudio / appendText / appendSpeech / stop / listVoices`;额度:`account/rateLimits/read`、`account/usage/read`。
- 客户端在 offer 里建了 `oai-events` data channel;第五版只记了 open/closed,**没记里面的事件**——本次要记,它可能带
  `input_audio_buffer.speech_started` / `output_audio_buffer.*` 等服务端事件,用来判插话时刻。

## R4. Opus 直转的兼容性

- Opus 包自描述(TOC 字节含声道标志、帧长),`opus/48000/2` 协商下解码器可解单声道或立体声包 ⇒ Discord 客户端的包原样上行,理论可解。
- 上行节奏:WebRTC 接收端(服务端)按 RTP 时间戳做抖动缓冲。Discord 空档时我们若停发,时间戳会跳;
  做法:20ms 本地时钟**每拍必发一包**——队列里有 Discord 包就发它,没有就发一个**预编码的 Opus 静音帧**
  (启动时 opusscript 编码一次,不是对人声重编码)。队列上限 5 包(100ms),超了丢最旧的,防止延迟累积。
- 下行:RTP 负载直接 push 进 AudioPlayer 的对象流;若服务端发 DTX 小包,也照推(Discord 客户端能解)。

## R5. 插话

- WebRTC 模式下服务端自己知道播放进度,VAD 判到用户开口会截断回复、停止下行语音。
- 本地唯一的延迟来源是 AudioPlayer 前的缓冲:下行按实时节奏到达 ⇒ 缓冲 ≈ 1–3 包;原型持续记录队列深度,若超过 10 包(200ms)就截断。
- 判定插话成功:说话人开口后 N 秒内下行音频 RMS 落到静音 **且** 模型回复被截断(`transcript/done` 文本明显短于同题正常回复,或 data channel 出现 `response.cancelled`/`output_audio_buffer.cleared`)。

## R6. 额度读数

- `account/rateLimits/read` 返回 primary/secondary 窗口的 `usedPercent`(FLY-2688 `rate-limit-detail.ts` 同款解析)。
- school 号被所有 Codex Lead 共用 ⇒ 前后差值混入别人消耗;对策:每场前后各读一次 + 开场前 10 分钟做一次「空闲漂移」读数作对照;报告写明是**上界**。
- 若读数粒度为整数百分比,10 分钟一场可能读不出变化——如实记「<1%」。

## R7. 真人替身

- 「说话人」= 另一个 bot(bot1)进同一语音频道,用 AudioPlayer 播放 `say -v Tingting` 合成的中文句子(opusscript 编码成 Opus)。
- Discord 转发 bot 的声音与真人一样走 SFU;原型 bot 订阅 bot1 的 userId 即可——路径与真人完全相同,只是声源不同。
- 环境声:用 ffmpeg 生成风扇(brown noise)、键盘敲击(短脉冲)、远处人声(低音量合成语音 + 噪声),各 60s。
- 最后一场由 founder 本人进房(约 5 分钟),先把邀请原文交 Lead 过目。

## R8. 登录与安全

- 临时 `CODEX_HOME=/tmp/fly2884-proto/home`,`auth.json` 软链到 `~/.codex/auth.json`;不 login/logout;
  每场前后记 auth.json mtime + email(id_token 里的 email 字段,不打印任何 token)。
- 子进程 env 去掉 `OPENAI_API_KEY` / `CODEX_API_KEY`(与第五版一致)。
- 日志 redaction 沿用第五版正则;bot token 只在进程内存,不写日志。
