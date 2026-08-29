# FLY-967 spike — S-A1 Gemini 侧(声线 + 简报注入 + 控制口)

Issue: FLY-967
日期: 2026-07-07
基于: ../../doc/FLY-967-gemini-live-assistant/plan.md §7 P0-S-A1

时间盒 spike:**非产品代码**,不进 pnpm workspace。545 PR-1(voice-bridge 底座)未落地时,
先把 S-A1 里**不依赖 Discord 管线**的三件事测掉:

1. **speechConfig voiceName 真机可用**(直接验 voice-core P1 增量:prebuilt 声线逐个连接,
   服务端接受 + 出音,存 wav 供试听选型);
2. **简报注入答题**(~6k chars systemPreamble → 问 board 问题,验 outputTranscription 里
   模型引用简报事实);
3. **sendText 控制口真机可用** + 文字提示→首音延迟(开场/收尾控制通道就是它)。

**全链首音(她停话→bot 出声)与打断延迟仍属真机 S-A1,等 545 PR-1 落地后在 Discord
管线上量**——545 S1 已给同管线基线(首 chunk 797-1017ms,全链 0.9-1.3s)。

## 结论

见 `../../doc/FLY-967-gemini-live-assistant/evidence/s-a1-gemini-side.md`。

## 复现

```bash
# 从 repo 根:pnpm install && pnpm -r build(spike 直接 import voice-core dist)
eval "$(grep '^export GOOGLE_API_KEY=' ~/.zshrc)"
GEMINI_API_KEY="$GOOGLE_API_KEY" node s-a1-gemini-side.mjs
# 每声线 wav 落 out/(gitignored),事件日志 out/*.jsonl
```
