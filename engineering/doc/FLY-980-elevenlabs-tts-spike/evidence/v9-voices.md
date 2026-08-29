# FLY-980 V9 — 8-Lead 声线 audition（真机合成 + Gemini judge 初筛）

Issue: FLY-980
日期: 2026-07-08（PT 夜间）
基于: plan.md §S7；样句 zh 逐字沿用 s4b、en/mix 全 Lead 统一（D11'）

## Verdict：终选 8 声线成表；**D12'「一把声线中英通吃」= 大体成立但必须逐声线实测**

## 1. 方法

- 候选：8 Lead × 2 premade 候选（按 persona 表选 labels 匹配的英文 premade，
  multilingual 模型跨语言）；筛选档 eleven_flash_v2_5 × 3 句（zh/en/中英混），
  终选档 eleven_multilingual_v2 × zh+en；
- judge：Gemini（参数化版，逐样本可懂度 0-2 + persona 契合 + 跨 Lead
  可区分度 0-3；s4b 方法学，新写实现 —— Codex R1#5）；
- **终审权在 Annie**：以下是建议非定稿，全量 wav/mp3（66 clips + 终选 wav）
  留档 `~/fly980-eleven/audition/`（QA 验收前不删）。

## 2. 终选建议表（multilingual_v2 终判）

| Lead | persona 要求 | 建议 voice | 终判（zh+en） |
|------|--------------|-----------|----------------|
| Tadashi | 男声 Professional | Eric `cjVigY5qzO86Huf0OWal` | 双语男声一致，温暖专业 ✅ |
| Aunt Cass | 女声 Warm | Sarah `EXAVITQu4vr4xnSDxMaL` | 双语女声一致；中文发音有小瑕疵（judge 注） ✅ |
| Honey Lemon | 女声 Lively | Jessica `cgSgspJ2msm6clMCkdW9` | 双语女声一致，明亮 ✅ |
| Mufasa | 男声 沉稳导师 | George `JBFqnCBsd6RMkjVDRZzb` | 双语男声一致，广播质感 ✅ |
| Belle | 女声 Bright 辨识度 | **Alice `Xb7hH8MSUJpSbSDYk0k2`**（换选） | 双语女声 intel=2 ✅（原选 Lily 中文变男声 ❌ 弃） |
| Peter | 男声 Sunshine | Will `bIHbv24MWmeRgasZH58o` | 双语男声一致，稳重暖男向（"阳光"欠佳，Annie 终审注意） ✅ |
| Hiro | 男声 年轻感 | Harry `SOYHLrjzK2X1ezoPC6cr` | 双语男声一致，响亮年轻 ✅ |
| Simba | wildcard | River `SAz9YHcvj6GT2YYXdXww` | ⚠️ en 女声/zh 男声跨语言变声——judge 论证为 wildcard 辨识度特性，**留 Annie 拍** |

终选组整体可区分度：**3/3**（闭眼能分清）。

## 3. 关键发现：跨语言声线一致性是逐声线彩票

- **flash_v2_5 筛选档**：16 候选里 3 个（Jessica/Lily/River）在 zh 或 mix
  样本被判为异性 —— 英文 premade 声线说中文可能整个变声；
- **multilingual_v2 终选档**：修复了 Jessica，**没修复 Lily**（zh 仍男声）——
  升模型档不保证修复；
- ⇒ 产品化规则：**每把声线必须 zh+en 双语实测后才能上岗**（本 audition
  流程即可复用）；agent 实跑用 flash_v2_5（非英语 agent 约束），故上岗验证
  必须在 flash 档做。
- 中英混句（"帮我 check 一下 FLY-980 的 PR…"）：终选声线英文术语发音
  自然（R5 缓解，样本留档 Annie 终审）。

## 4. 与 edge-tts 基线对照

edge-tts（FLY-546 表）零成本但声线是"播音腔"且不可克隆扩展；ElevenLabs
premade 质感/自然度显著更好（judge intel 普遍 2/2），代价=credits
（本轮 audition 全程 ~1305 credits ≈ $0.18 等值）。

## 复现

```bash
node audition.mjs list                       # 拉声线表
node audition.mjs synth out/candidates.json  # 筛选档
node audition.mjs judge                      # Gemini 初筛
node audition.mjs synth out/final-picks.json --final  # 终选档
# judge 全量输出: out/audition-judge.json；音频: ~/fly980-eleven/audition/
```
