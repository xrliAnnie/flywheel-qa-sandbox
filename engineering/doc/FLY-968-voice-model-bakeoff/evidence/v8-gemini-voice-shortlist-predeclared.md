# FLY-968 V8-Gemini — 声线 sweep 预筛 shortlist（预先声明，先于任何听感/打分）

Issue: FLY-968
日期: 2026-07-07
基于: ../plan.md §3 P3a（Codex R2 rigor note：shortlist 必须在听/打分之前预先声明落
evidence，防止 top-3 看起来像事后择优）

## 声明时点

本文件在 `s4a-gemini-voice-sweep.mjs` **首次运行之前**提交定稿。选择依据 = 官方文档
的风格标签（ai.google.dev/gemini-api/docs/speech-generation，30 个 prebuilt voices
的 style 描述）+ per-Lead 人设覆盖需求（工程男声 / 产品女声 / 年轻男声 + 备选）。
预算按 <$5 上限收紧，先扫 10 个（30 全扫留作 fallback，若 shortlist 不足 3 个可用
再扩）。

## 预筛 shortlist（10 个，按人设桶）

| # | voice | 官方风格标签 | 预期人设桶 | 选择理由（听之前写死） |
|---|-------|-------------|-----------|------------------------|
| 1 | Charon | Informative | 工程 Lead（Tadashi 型） | 信息型稳重声，工程播报直觉匹配 |
| 2 | Sadaltager | Knowledgeable | 工程 Lead 备选 | 知性标签，第二工程声 |
| 3 | Iapetus | Clear | 工程/通用备选 | 清晰度优先 |
| 4 | Puck | Upbeat | 年轻活力（Hiro 型） | 活泼标签 |
| 5 | Fenrir | Excitable | 年轻活力备选 | 兴奋型，与稳重声拉开区分度 |
| 6 | Kore | Firm | 产品 Lead（Honey Lemon 型） | 坚定女声直觉 |
| 7 | Aoede | Breezy | 产品/轻快备选 | 轻快标签 |
| 8 | Leda | Youthful | 年轻声备选 | 年轻标签 |
| 9 | Sulafat | Warm | 温暖声备选 | 温暖标签，陪伴型 Lead 可用 |
| 10 | Gacrux | Mature | 成熟声备选 | 成熟标签，与年轻声拉开区分度 |

## 打分方法（同样先声明）

- 每声线同一句中文（U1 变体自报身份句），Live API（gemini-3.1-flash-live-preview，
  native audio）短 session 收 wav 落 `out/`，样本保留给 founder 终审。
- **中文可懂度 0-2**：自动化第一道 = 转写对照（Gemini generateContent 音频入转写 vs
  原句逐字比对；错字/漏字/洋腔调分级）；0=不可懂/明显外国口音，1=可懂有瑕疵，2=自然。
- **可区分度 0-3**：自动化第一道 = 声学特征描述（性别/音高/音色，model-as-judge）
  两两对比；0=与已选声线难分，3=一耳朵区分。
- 自动化打分**只做初筛**（本 Runner 无耳朵，如实标注 model-as-judge 方法学）；
  founder 听 wav 终审。判据：≥3 个「可懂度 ≥1 且互相可区分度 ≥2」→ §17 硬要求满足。
- **出口**：top 3 喂给 `s4-gemini-multisession.mjs`。
