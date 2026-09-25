# FLY-2884 Discord 真人接 WebRTC 订阅实时会话 — 探索
Issue: FLY-2884 (https://linear.app/geoforge3d/issue/FLY-2884/语音bprototype-接-discord-真人说话把-webrtc-订阅的实时会话接进测试语音房opus-直转量真人延迟-插话-环境声)
日期: 2026-09-25
基于: 无(上游证据: FLY-2881 第五版 commit 542f9f475)

## 1. 要回答的问题

FLY-2881 第五版已证实:本机 Node(werift + opusscript)照 Codex CLI `/voice` 同参数(webrtc / v3)连上
`codex app-server 0.157.0` 的实时语音,全程走 ChatGPT 订阅,无 API key。说话方是本机合成语音。

本单是「核心·连接层 / 核心·大脑」的**闸门**:把同一条会话接进 Discord 语音房后,真人场景下还成立吗?
具体要量:

| 维度 | 判据 |
|------|------|
| 听得到并回答 | 真人在 Discord 房里说话 → 模型听到并口语回答(录音 + 转写) |
| 说完→开口延迟 | 5 次以上,每次值 + 均值 |
| 插话 | 模型说话时人插话,模型是否停下;成功率 |
| 环境声 | 只放环境声(不说话)时,误触发次数 |
| 10 分钟稳定 | 连续一场 10 分钟:无断线、无卡死 |
| 后台只读回合 | 在 Discord 场景里走通「我去看一下 → 查完口语讲结果」 |
| 额度 | 每场前后 `account/rateLimits/read` 读数 |

## 2. 现状盘点

- **生产语音代码**:`packages/voice-codex`(引擎 B,WebSocket + API key 路线)与 `packages/voice-bridge`(Discord 收发、DAVE、AudioPlayer)。
  这些是生产路径,本单**不改**;只借鉴其 Discord 收发做法(`discordWiring.ts`:`receiver.subscribe(userId, {end: Manual})`、
  `createAudioPlayer({behaviors:{maxMissedFrames:250}})`、`daveEncryption` / `decryptionFailureTolerance`)。
- **FLY-2881 实验脚本** `evidence-webrtc/webrtc-exp.mjs`:app-server JSON-RPC、WebRTC offer/answer、
  `clientManagedHandoffs:true` 下的后台回合与 `appendSpeech` 交回——本单直接以它为底。
- **529 测试语音房**:QA 分类下有 `voice-test-1/2/3` 三个语音频道。开工时 slot 2(FLY-2799 founder 房)
  与 slot 4(FLY-2711)在用;slot 1、3 空闲。`voice-test-3`(1542709028742893699)对应 slot 3。
- **测试 bot**:`TEST_BOT_TOKEN_1..4`(`~/.flywheel/.env`)。一个 bot 在一个 guild 同时只能在一个语音频道,
  所以原型 bot 与「说话人」bot 必须是两个身份,且都不能是在飞房间正在用语音的 bot。

## 3. 方案候选

### A. 独立原型进程(推荐)
一个 Node 进程同时做三件事:
1. discord.js 登录 bot3,加入 `voice-test-3`,订阅指定说话人的 Opus 包;
2. 把这些 Opus 包**原样**塞进 WebRTC 上行 RTP(20ms 时钟,空档补预编码的 Opus 静音帧);
3. WebRTC 下行 RTP 的 Opus 负载**原样**推进 Discord `AudioPlayer`(`StreamType.Opus`)。

另起一个「说话人」进程(bot1),把合成人声 / 环境声 WAV 编成 Opus 在同一频道里播放,当作真人替身;
最后一场换 founder 本人进房。

- 优点:零生产代码改动,不需要 Bridge / Lead / 529 部署,失败面小;直接量出连接层本身的数字。
- 缺点:不含 Lead 身份、记忆、thread 文字镜像——这些本就属于后续「核心·大脑」单。

### B. 接进 529 全套房(fly2655-voice-room.mjs + slot Lead)
要改 voice-codex 引擎走 WebRTC,等于提前做「核心·连接层」,且动生产包、要起 Bridge,违反本单边界。**否决**。

### C. 重新编码(Discord PCM → 重编 Opus)
仅作为 A 的兜底:若直转出现无法解码 / 声道不匹配 / DAVE 帧问题,再加最小转码,并在结论页写明原因。

## 4. 假设(需验证)

1. `@discordjs/voice` 0.19.2 接收端给出的是 DAVE 解密后的纯 Opus 包,可直接作为 RTP 负载(PT 111)。
2. OpenAI 端协商 `opus/48000/2`;Discord 客户端发的 Opus 包(TOC 立体声标志随客户端)在 opus/48000/2 下可直接解码。
3. WebRTC 下行是按实时节奏发送的连续 RTP(第五版里连接后立即有包),推进 AudioPlayer 不会积压。
4. 插话由服务端 VAD 处理(WebRTC 模式下服务端自己截断输出);我们只要保证本地播放缓冲小,插话就能在 Discord 里听出来。
5. `account/rateLimits/read` 能读到订阅额度;但 school 号被所有 Codex Lead 共用,前后差值会混入别人的消耗——要在报告里标明,并量一段「空闲漂移」作为对照。

## 5. 不做

- 不改 `flywheel-FLY-2799` 分支,不改 `packages/voice-*`。
- 不做 Lead 声线 / 身份 / 记忆 / 工具接入(属后续单)。
- 不做多人混音:原型只转发一个指定说话人(多人要解码混音再编码,另议)。
