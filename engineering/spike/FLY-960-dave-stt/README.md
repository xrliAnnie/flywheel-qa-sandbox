# FLY-960 DAVE STT spike — 复现说明(QA 用)

Issue: FLY-960
日期: 2026-07-07
基于: ../../doc/FLY-960-stt-dave-spike/plan.md

时间盒 spike:验证耳朵 bot 在 Discord 强制 DAVE E2EE 下能否可靠收音。
**非产品代码**,不进 pnpm workspace,零生产代码改动。

## 依赖 pin(实测生效)

| 包 | 版本 |
|----|------|
| discord.js | 14.26.4 |
| @discordjs/voice | 0.19.2(pin) |
| @snazzah/davey | 0.1.12 |
| prism-media | 1.3.5 |
| opusscript | 0.0.8(plan 原写 ^0.1.1,与 prism-media 1.3.5 peer 冲突,降到其支持线) |
| opus decoder 实际生效 | opusscript(@discordjs/opus 无 Node 25/v141 prebuild;路径 A 采集不在 bot 内解码——原始 opus 直接写 Ogg,解码在 ffmpeg 端,故无影响) |

Node:本机 v25.6.1(repo 钉 22,机器无版本管理器 — 偏差已记 evidence/00-env.md)。

## 文件

- `ref/ref-script.txt` — 中英混说 5 句参考脚本(ground truth)
- `ref/ref-48k.wav` — TTS 生成的参考音频(48kHz 立体声)
- `transcribe.mjs` — Gemini 文件转写器(收音是被验对象,STT 用现成)
- `ears-a.mjs` — 路径 A 耳朵 bot(@discordjs/voice 0.19.2 收音)
- `sender.mjs` — 发送 bot(参考音源,发送侧已知安全)
- `out/` — 运行产物(录音/日志/transcript,关键件拷进 evidence/)

## STT 上限校准结果(2026-07-07)

正式参考音频 = `ref/ref-48k-slow.wav`(edge-tts rate=-20%;常速版基线更低已弃用)。
校准 transcript 存 `out/ref-calibration-slow.txt`(evidence 同步归档)。

基线命中:**宽松口径 12/15(80%),严格口径 10/15(67%)** — miss 集中在 zh-CN TTS 读英文
专名的发音(voice bridge/worktree/Tadashi),非 STT 或音频链路问题。

**判据②的实际口径(按 plan §8「以基线打折比较」)**:
1. **主口径(相对)**:收音轮 transcript vs 校准 transcript 逐句比对——同一音频、同一
   STT,差异即采集链路损伤;关键词命中 ≥ 基线命中的 80%(宽松口径 ≥10/12)判过。
2. 副口径(绝对):关键词表命中数直接记录,报告里两个口径都写。

## 关键词比对表(判据②副口径)

| 句 | 关键词 1 | 关键词 2 | 关键词 3 |
|----|----------|----------|----------|
| 1 | FLY-545 | voice bridge | smoke test |
| 2 | PR | CI | ship |
| 3 | Huddle | latency | 八百毫秒 |
| 4 | DAVE | 解密失败 | fallback |
| 5 | Tadashi | worktree | TDD |

## 复现命令序列(路径 A)

```bash
cd engineering/spike/FLY-960-dave-stt
npm install                      # opusscript 纯 JS 兜底;原生 opus 可选
# token 装载(不回显):
export FLY960_EARS_TOKEN="$(cat ~/.flywheel/discord-bot-pool/flywheel-pool-04/token)"
export FLY960_SENDER_TOKEN="$(cat ~/.flywheel/discord-bot-pool/flywheel-pool-05/token)"
# GEMINI key(本机 ~/.zshrc 有 GOOGLE_API_KEY / NANOBANANA_GEMINI_API_KEY):
eval "$(grep '^export GOOGLE_API_KEY=' ~/.zshrc)"; export GEMINI_API_KEY="$GOOGLE_API_KEY"

# 参考音频(一次性):
edge-tts --voice zh-CN-XiaoxiaoNeural --file ref/ref-script.txt --write-media ref/ref.mp3
ffmpeg -y -i ref/ref.mp3 -ar 48000 -ac 2 ref/ref-48k.wav
node transcribe.mjs ref/ref-48k.wav        # STT 上限校准:5 句关键词应全中

# 收音轮(两个终端,同一 VC):
DISCORD_TOKEN=$FLY960_EARS_TOKEN   node ears-a.mjs <guildId> <channelId>
DISCORD_TOKEN=$FLY960_SENDER_TOKEN node sender.mjs <guildId> <channelId> ref/ref-48k.wav

# 转写比对(ears-a.mjs 写的是 s16le PCM,非 ogg):
ffmpeg -y -f s16le -ar 48000 -ac 2 -i out/a-<senderId>-<t>.pcm -ar 16000 -ac 1 out/a-take1.wav
node transcribe.mjs out/a-take1.wav | tee out/a-take1.txt
```

DAVE 证据取证、稳定轮(≥10min + 扰动注入)见 plan.md Task 2.4–2.6。
QA 独立复跑要求见 plan.md §7:自己录、自己转写,不拿 implement 的 wav 当证据。
