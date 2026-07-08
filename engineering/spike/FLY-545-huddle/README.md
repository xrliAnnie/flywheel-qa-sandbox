# FLY-545 Huddle spike — S1(Gemini Live 模态 + 延迟)复现说明

Issue: FLY-545
日期: 2026-07-07
基于: ../../doc/FLY-545-huddle-mode/plan.md §7 P0-S1

时间盒 spike:验证 D1-B 前提(Gemini Live TEXT 响应模态 + inputAudioTranscription 并用)
并量全链延迟。**非产品代码**,不进 pnpm workspace,零生产代码改动。

## 结论

见 `../../doc/FLY-545-huddle-mode/evidence/s1-gemini-text-modality.md` —
**TEXT 模态被当前全部 Live 模型服务端拒绝(D1-B 不可行)**;AUDIO 模态首 chunk
797-1017ms(D1-A 可行,落 PRD ≤1.2s 可接受带)。

## 复现

```bash
npm install
# 生成测试问话(一次性;ref/*.txt 已入库,音频产物 gitignored):
edge-tts --voice zh-CN-XiaoxiaoNeural --file ref/s1-question.txt --write-media ref/s1-question.mp3
ffmpeg -y -i ref/s1-question.mp3 -f s16le -ar 16000 -ac 1 ref/s1-question-16k.pcm

eval "$(grep '^export GOOGLE_API_KEY=' ~/.zshrc)"
GEMINI_API_KEY="$GOOGLE_API_KEY" node s1-text-modality.mjs ref/s1-question-16k.pcm 3
GEMINI_API_KEY="$GOOGLE_API_KEY" node s1-audio-modality.mjs ref/s1-question-16k.pcm 3
```

事件级日志落 `out/*.jsonl`(gitignored,复跑即得)。
