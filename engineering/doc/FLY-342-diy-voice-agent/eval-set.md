# FLY-342 中英混说 eval set — 语音管线选型实测口径

Issue: FLY-342 (https://linear.app/geoforge3d/issue/FLY-342)
日期: 2026-07-05
基于: plan.md Step 2（承 FLY-883 DR 行动项「用 Annie 真实说话风格自建 ~20 句 eval set」）

> **用途（一次做三处用）**：① TTS 念（合成质量 / 中英混排念对率）；② STT 转写
> （关键动作反转 / issue·PR 号 / 命令 token 准确率）；③ 留给 FLY-543 后续 realtime
> （Gemini Live / OpenAI Realtime）同口径对比。
>
> **风格提炼**：Flywheel 语音场景的真实指令 —— 派活、审批、跑命令、听播报，含数字 /
> issue 号 / 英文术语 / approve·ship 类高危短语。**高危 slot** = STT 听错会造成误动作
> 的词（把「不要 ship」听成「ship」= 直接淘汰该 STT）。

## Eval set（20 句，逐句标 slot）

| # | 句子 | 高危 slot（STT 听错=误动作） | 混排 token（TTS 念对 / STT 转对） |
|---|------|------------------------------|-----------------------------------|
| 1 | 把 FLY-342 派给 Tadashi | 无 | FLY-342, Tadashi |
| 2 | approve 那个 PR，可以 ship 了 | **approve / ship**（正向动作） | approve, PR, ship |
| 3 | 先别 ship，等 QA 过了再说 | **别 ship**（否定！听成 ship 就翻车） | ship, QA |
| 4 | 跑一下 pnpm lint 看看 CI 绿不绿 | 无 | pnpm lint, CI |
| 5 | 这个 PR 有 conflict，先 rebase 到 main | 无 | PR, conflict, rebase, main |
| 6 | 把 FLY-435 和 FLY-354 合并成一个 epic | 无 | FLY-435, FLY-354, epic |
| 7 | 不要 merge，我还没 review 完 | **不要 merge**（否定） | merge, review |
| 8 | Bridge 重启一下，Lead 好像掉线了 | 无 | Bridge, Lead |
| 9 | 给 CosyVoice 装个 MPS 版本，跑本地 TTS | 无 | CosyVoice, MPS, TTS |
| 10 | 让 Codex 跑一轮 code review，xhigh 档 | 无 | Codex, code review, xhigh |
| 11 | 这个 commit 的 hash 是 cd753eb9 | **hash 数字/字母串** | commit, hash, cd753eb9 |
| 12 | 把 model 切成 Fable，别用 Opus | 无（选择型） | model, Fable, Opus |
| 13 | Runner 卡在 awaiting review，帮我 verify 一下 | 无 | Runner, awaiting review, verify |
| 14 | 部署到生产之前先跑 E2E test | **部署到生产**（高危动作前提） | E2E test |
| 15 | 这个 feature 先 hold 住，别急着上线 | **hold / 别上线**（否定） | feature, hold |
| 16 | Groq 的 API key 过期了，换一个 | 无 | Groq, API key |
| 17 | whisper 大概三十秒能转完这段十分钟的音频 | **数字：30 秒 / 10 分钟** | whisper |
| 18 | 把 research.md 的实测结果全部填进去 | 无 | research.md |
| 19 | Discord 那个 bot token 别 commit 进去 | **别 commit**（安全否定） | Discord, bot token, commit |
| 20 | 明天早上八点给我一份 standup 报告 | **数字：8 点** | standup |

## 评分口径（对应 plan §3a / §3b 验收线）

**TTS 念（§3a）**：
- 混排念对率：英文术语 / 数字念错 ≤ 2/20 句 = 达标；
- 主观质量：≥ edge-tts 同句对照。

**STT 转（§3b）**：
- 关键动作反转（第 3/7/15/19 句的否定、第 2 句的正向）：**0 容忍**——任何一句把否定
  听成肯定或反之 = 该 STT 直接淘汰；
- issue/PR 号（1/2/5/6/11 句的 FLY-XXX / hash）：≥ 19/20 正确；
- 命令 token（4/5/10 句的 pnpm lint / rebase / xhigh 等）：≥ 18/20 正确；
- 整体 WER：记录作参考，不设硬线。

## 高危句子清单（0 容忍反转，单列强调）

- 第 3 句「先别 ship」← 绝不能转成「先 ship」
- 第 7 句「不要 merge」← 绝不能转成「要 merge」
- 第 15 句「先 hold 住，别急着上线」← 绝不能转成「上线」
- 第 19 句「别 commit 进去」← 绝不能转成「commit 进去」
- 第 2 句「approve…可以 ship」← 正向动作，approve/ship 必须都转对
