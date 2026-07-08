# FLY-960 STT spike — verdict 报告

Issue: FLY-960 ([voice·②·闸] STT spike — bot 在 Discord VC 强制 DAVE 加密收音 go/no-go)
日期: 2026-07-07
基于: plan.md

## Verdict:**GO**

选型 = **路径 A**(@discordjs/voice 生态)。真机验证:耳朵 bot 在强制 DAVE 端到端加密的
Discord 语音频道里**能可靠收音**——一天内(实际数小时)在路径 A 上即达成全部 GO 判据,无需
落到 B/C。这确认了 research.md 的先验判断(0.19.2 的 #11449 修复真实有效),且不是「看起来
修了」而是**真机跑通 + 真人客户端在场**。

> **判据⑤(DAVE 真在场)以 bot 侧 DAVE 证据收(Tadashi 拍,lead-instruction 872cd365)**:
> `dave_protocol_version=1`(session_description)+ davey MLS 会话/epoch 全链日志,外加**最强的
> 一条**——耳朵 bot **成功解密了 Annie 的真人语音(14/15 关键词)**。强制 DAVE 下非加密会话
> 直接 close code 4017 断连,根本不存在可降级的明文流;能连上并解出可懂音频,本身就是 DAVE
> E2EE 在场的权威证明。**如实标注**:founder 客户端可见的 E2EE 锁标未定位(Annie 界面里
> Discord UI 未显著暴露锁图标,属 nice-to-have、非阻塞);两张截图(通话平铺 + 频道侧栏)确认
> 真人 Annie 与「耳朵bot·借用中」真实共处同一语音频道。

## 选型 pin

- `@discordjs/voice` **0.19.2**(当前 npm latest;含 #11449 padding 修复)
- `@snazzah/davey` **0.1.12**
- `discord.js` 14.26.4
- opus 解码:`prism.opus.Decoder`(prism-media 1.3.5);opusscript 纯 JS 兜底,**无需**原生
  `@discordjs/opus`(本机 Node 25 无 prebuild,不影响收音——bot 只收原始 opus,解码在收流管线)
- STT(spike 工具,非选型对象):Gemini 2.5-flash 文件转写

## 判据逐条证据表

| 判据 | 结果 | 证据文件(evidence/ 相对路径) |
|------|------|-------------------------------|
| ① 可懂解密音频 | ✅ | `a-1-capture/a-take1.wav`(收音 wav,人耳/STT 均可懂) |
| ② STT 中英混说可辨认 | ✅ | `a-1-capture/a-take1.txt`(收音转写 14/15 ≥ TTS 基线 12/15);`a-5-annie-realvoice/annie-script.txt`(真人语音 vs 已知脚本近逐字,英文 pangram 一字不差) |
| ③ ≥10min 稳定 + rejoin/重连 | ✅ | `a-4-stability/a-4-stability.md`(14min 窗口、24 loop、3 次扰动全过、首尾无退化) |
| ④ per-speaker 分离 | ✅ | `a-5-annie-realvoice/`(Annie 音轨落她自己 user id 文件,与 bot 文件天然分开) |
| ⑤ DAVE 真在场 | ✅(bot 侧) | `a-4-stability/a-dave-proof.jsonl`(`dave_protocol_version=1`)+ `a-4-stability/a-debug-extract.txt`(davey MLS session/epoch 全链,secret 已 redact)+ 耳朵 bot 成功解密 Annie 真声(`a-5-annie-realvoice/`);`a-5-annie-realvoice/e2ee-client-screenshots.md`(founder 客户端截图说明,视觉锁标未定位、如实标注) |

## 给 FLY-545 子范围 A 的实现约束

1. **per-speaker 形态**:`conn.receiver.subscribe(userId)` 按 SSRC→user 天然分轨,每说话人一
   独立 opus 流。VAD 抖动会把同一人的连续发声切成多段——**speaking-start 会重复触发,必须
   去重**(spike 加了 activeCaptures Set:同一 user 有活跃订阅时不重开,否则重叠文件 + 多路
   解码白烧 CPU)。FLY-545 bridge 需按 user id 聚合分段。
2. **重连与 session 重建行为**:
   - 受控 destroy + rejoin:~5.6s 恢复,`entersState(Ready, 15s)` 足够;capture 同 loop 内续。
   - 成员进出(MLS epoch 轮换):不影响已连接 receiver 的收音,ears bot 全程不掉线。
   - **首坑(FLY-545 必踩)**:`joinVoiceChannel` 必须在 `clientReady` 之后调,否则静默卡死
     在 signalling 状态(gateway shard 未 ready 时 voice 握手不启动)。probe-join.mjs 实测坐实。
3. **依赖 pin**:见上「选型 pin」。
4. **已知残余风险**:audio receive 非 Discord 官方文档化(FLY-883 DR 已证)——0.19.2 修好不改
   变这个长期地位,是 FLY-545 要背的**运维预算**,不是本 spike 的 gate。zh-TTS 读英文专名的
   发音误听是 STT+TTS 固有上限(收音链路无损),真人真声(Annie)转写质量明显更高。

## 复现配方(QA 独立复跑,从 README 摘)

```bash
cd engineering/spike/FLY-960-dave-stt
npm install
export FLY960_EARS_TOKEN="$(cat ~/.flywheel/discord-bot-pool/flywheel-pool-04/token)"
export FLY960_SENDER_TOKEN="$(cat ~/.flywheel/discord-bot-pool/flywheel-pool-05/token)"
eval "$(grep '^export GOOGLE_API_KEY=' ~/.zshrc)"; export GEMINI_API_KEY="$GOOGLE_API_KEY"
# 参考音频(一次性):
edge-tts --voice zh-CN-XiaoxiaoNeural --rate=-20% --file ref/ref-script.txt --write-media ref/ref-slow.mp3
ffmpeg -y -i ref/ref-slow.mp3 -ar 48000 -ac 2 ref/ref-48k-slow.wav
# 收音轮(两终端,同一 VC);guildId=1485787271192907816 channelId=1485787273193853170:
DISCORD_TOKEN=$FLY960_EARS_TOKEN   node ears-a.mjs   <guildId> <channelId>
DISCORD_TOKEN=$FLY960_SENDER_TOKEN node sender.mjs   <guildId> <channelId> ref/ref-48k-slow.wav
# 转写比对(PCM→wav→transcribe):
ffmpeg -y -f s16le -ar 48000 -ac 2 -i out/a-<senderId>-<t>.pcm -ar 16000 -ac 1 out/a-take1.wav
node transcribe.mjs out/a-take1.wav
```

QA 独立复跑要求见 plan §7:自己起 bot、自己录、自己转写,不拿 implement 的 wav 当证据;
核 DAVE 三件套 + diff 无生产代码改动 + pnpm workspace 未吸入 spike 包。

## 下一步(下游,非本 spike)

- **③ Huddle 模式开工**(FLY-545):按上「实现约束」用选型 A 建 voice bridge。
- 回填:FLY-545 评论「② spike GO,收音选型 = A(@discordjs/voice 0.19.2 + davey 0.1.12),
  实现约束见本报告」。
- spike 收尾清单(Annie 拍):清两 bot 的 guild 昵称 + bot 退出测试 guild、release pool。
