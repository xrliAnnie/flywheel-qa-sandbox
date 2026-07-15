# FLY-968 V8-Gemini — 声线 sweep 结果（P3a）

Issue: FLY-968
日期: 2026-07-07
基于: v8-gemini-voice-shortlist-predeclared.md（shortlist 与打分方法先于本次运行
声明；两文件同会话产出，声明文件写定在 sweep 脚本首跑之前）

## Verdict

**V8-Gemini = PASS**：预筛 shortlist 10 个声线（30 个 prebuilt 中按预声明规则选出）
全部在 gemini-3.1-flash-live-preview 上出音，自动初筛可懂度 10/10 满分，
**§17 硬要求（≥3 个中文可用且可区分声线）满足**。

**Top 3（喂给 s4 多 session 实验）= Fenrir（低沉男）/ Sulafat（甜美女）/ Puck（磁性男）**
——judge 两两可区分度 2/3，性别+音色拉开。

## 实测（同句中文，与 OpenAI sweep 同句，跨厂商可比）

| voice | 可懂度(0-2) | 性别/音高 | 逐字 | 音色 |
|-------|------------|-----------|------|------|
| Charon | 2 | 男/中 | 完全一致 | 清晰，语速适中 |
| Sadaltager | 2 | 男/中 | 完全一致 | 清晰洪亮，略带鼻音 |
| Iapetus | 2 | 男/中 | 完全一致 | 清晰响亮，标准男声 |
| Puck | 2 | 男/中 | 完全一致 | 清晰略带磁性，专业 |
| Fenrir | 2 | 男/中 | 完全一致 | 清晰沉稳，略低 |
| Kore | 2 | 女/中 | 轻微出入 | 清晰沉稳女声 |
| Aoede | 2 | 男*/中 | 完全一致 | 清晰沉稳 |
| Leda | 2 | 女/中 | 轻微出入 | 清晰明亮，略带共鸣 |
| Sulafat | 2 | 女/中 | 完全一致 | 清晰稳定，略甜 |
| Gacrux | 2 | 女/中 | 完全一致 | 清晰明亮 |

*judge 对 Aoede 判男（文档标签 Breezy 常被归女声）——初筛性别判读仅供参考，
founder 听 wav 终审。

方法学注记：打分 = model-as-judge 初筛（无人耳），逐字转写全对/轻微出入 +
零口音标注是硬信号；「可区分度」主观维度弱信号，top3 选择以性别/音高/音色
描述差异为准。wav 样本 `out/s4a-voice-*.wav` 保留供 founder 终审。

## 复现

```bash
cd engineering/spike/FLY-968-voice-bakeoff
GEMINI_API_KEY=... node s4a-gemini-voice-sweep.mjs
GEMINI_API_KEY=... node s4b-voice-judge.mjs out/s4a-voice- gemini
```
