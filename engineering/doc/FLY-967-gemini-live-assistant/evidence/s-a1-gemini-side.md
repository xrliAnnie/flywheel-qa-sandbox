# FLY-967 S-A1(Gemini 侧)— 声线 / 简报注入 / sendText 控制口 真机证据
Issue: FLY-967
日期: 2026-07-07
基于: plan.md §7 P0-S-A1(部分——Gemini 侧;全链部分等 545 PR-1,见 §4)

复现:`engineering/spike/FLY-967-live-assistant/`(throwaway,不进包);模型
`gemini-3.1-flash-live-preview`(voice-core config 默认),**直接 import 本分支
voice-core dist** —— 即 P1 三个增量(systemPreamble / sendText / voiceName speechConfig)
的真机集成验证,不是裸 SDK。

## 1. 结果矩阵(每声线两轮:开场控制提示 + board 问题)

| 声线 | 开场首音(sendText→首 chunk) | 答题首音 | 简报事实召回 |
|------|------|------|------|
| default(模型默认) | 926ms | 793ms | ✅ 15:00 + In Progress + /live |
| Kore | 706ms | 1147ms | ✅ 全对 |
| Puck | 712ms | 1154ms | ✅ 全对(转写把 Discord 拼成 Dicord,口播无碍) |
| Aoede | 769ms | 1275ms | ✅ 全对 |
| Charon | 709ms | **2479ms**(单次离群) | ✅ 全对 |
| Leda | 914ms | 1126ms | ✅ 全对 |

- **首音带:706-1275ms(排除 Charon 单次 2479ms 离群)**——与 545 S1 同管线基线
  (797-1017ms)吻合;文字控制提示与音频输入的模型侧生成延迟同源。
- 音频产物:`engineering/spike/FLY-967-live-assistant/out/audition-<voice>-<n>.wav`
  (gitignored,本机留档供 Annie/QA 试听选型)。

## 2. 三个 P1 增量的真机判定

1. **speechConfig voiceName**:6 个 prebuilt 声线(含缺省)全部被服务端接受并出音,
   无 languageCode、无连接错误 —— P1 的「只发 voiceName」形状正确。
2. **systemPreamble 简报注入**:~6k chars 简报(board 快照 + 最近决策 + 文档要点 + 填充)
   注入后,模型在**每个声线**上都准确引用:简报生成时间 15:00、FLY-967=In Progress、
   命令定名 /live、「纯 Gemini Live 语音助理」——**她零科普的机制成立**。
3. **sendText 控制口**:文字提示可靠触发模型原生语音回应(开场/收尾 recap 的唯一
   控制通道可用);控制提示不落 user transcript(单测已断言,真机行为一致)。

## 3. 声线选型(暂定,终选靠人耳)

数据面 Kore / Puck / Aoede 首音最稳;转写观感 Kore/Leda 中文断句自然。
**暂定 config 默认 = Kore**(与 plan §4 示例一致);wav 留档,Annie/QA 试听后可改
(`assistant.voice` 一键换)。

## 4. 本 spike 明确不覆盖(等 545 PR-1 后补全链 S-A1)

- 全链首音(她停话→Discord bot 出声):需要耳朵 bot + AssistantSpeaker 播放管线;
  545 S1 同管线实测 0.9-1.3s 作为预期带。
- 打断延迟(开口→停播)与 localBargeIn 默认值判定。
- 同步 function calling 的 earcon/filler 体感。
