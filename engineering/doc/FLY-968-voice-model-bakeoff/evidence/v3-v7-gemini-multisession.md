# FLY-968 V3-V7 — multi-Gemini-Live 编排真机验证（问①核心）+ T1 verdict

Issue: FLY-968
日期: 2026-07-07
基于: ../plan.md §3 P3（model = gemini-3.1-flash-live-preview；声线 = P3a top3：
Tadashi=Fenrir / Honey Lemon=Sulafat / Hiro=Puck；每 session 人设 +「只有被点名
才说话」铁律 system prompt）

## T1 verdict（plan §3 P3 矩阵拍板）

> ## **GO**（gated + sendClientContent 静默补喂编排；all-listen 策略不可用）

| 硬门 | 实测 | 判 |
|------|------|-----|
| V3 三并发连通 | 3 条同时 Ready（Promise.all 并发建立 241ms），声线互异自报身份 wav 齐 | PASS |
| V5 补喂（含跨 agent + 负对照） | cc 方法：补喂全程 **0 字节出声**、founder 事实与跨 agent 事实均正确引用、负对照证明补喂必要 | PASS |
| V6 延迟 ≤1.2s（§15 硬门） | 3 并发下被点名者 speech-end→首 audio 727-1138ms，median **831ms**，10/10 轮 ≤1.2s（与 S1 单 session 797-1017ms 同带，**无并发退化**） | PASS |
| V8-Gemini ≥3 中文可用可区分声线（§17 硬门） | 10/10 可懂满分，top3 性别/音色拉开（见 v8-gemini-voice-sweep.md） | PASS |
| 成本 ≤2× 单 session | gated ≈ **1.05×**（audio-in 1× + 文本补喂美分级）；all-listen 实测 ≈2.5×（含抢答废话输出）且体验崩 | PASS（gated） |

**GO 附带的工程前提**（不是 blocker，是 545 后续迭代要做的活）：
①点名路由器（谁被点名→音频路由给谁+其余 session cc 补喂）；②15min 音频时限 ×3
的 resumption 工程；③preview 模型退役风险 ×3（FLY-959 已知运维税）。

## T3-a 连通（V3）

3 条 Live 连接并发建立 241ms 全 Ready，零限流错误。各自报身份（自报内容正确、
声线互异，wav 落 `out/s4-intro-*.wav`）。Tier1 配额远够 3-5 session 的量级。

## T3-b all-listen 服从性（V4）= **不可用**

点名句 ×10 轮（u3a/u3b/u3c 轮转）全量推 3 条 session：

- 被点名者 10/10 轮正确应答（namedMiss=0）——**点名理解本身没问题**。
- 未点名者出声 **8/10 轮**（阈值 >3/10 即不可用；Honey Lemon/Sulafat 7 轮违规，
  是主要抢答者）。system prompt「没点你名保持完全沉默」在 3.1 上压不住——
  3.1 无 proactive audio（模型自主决定不回的原生机制只在 2.5 系 v1alpha），
  VAD commit 后模型总要生成点什么。
- 按 plan 纪律：只记录，不调参救（调参救活是 545 后续迭代的活）。

## T3-c gated + 补喂（V5）= **PASS，且抓到关键 API 行为差异**

**首跑（sendRealtimeInput text，3.1）**：补喂**必触发出声**（Tadashi 补喂期间
50KB 音频 ≈1s 说话；对 Honey 注入同样触发）——「静默补喂」用这条 API 在 3.1 上死。

**对照矩阵（s4c，同人设单 session，注入含事实「发布时间周五下午三点」）**：

| 格 | 模型 + API | 补喂时出声 | 事后点名引用 |
|----|-----------|-----------|--------------|
| A（主实验实录） | 3.1 + sendRealtimeInput(text) | **是**（破静默） | 对 |
| B | 3.1 + **sendClientContent(turnComplete:false)** | **否** | **对** |
| C | 2.5-na-12-2025 + sendClientContent | 否 | 错（幻觉「明天上午」，单样本） |
| D | 2.5-na-12-2025 + sendRealtimeInput(text) | 否 | 对 |

**B 格推翻文档级先验**（research §2.3 曾记「3.1 的 send_client_content 仅限连接时
seeding」）：3.1 会话中 `sendClientContent(turnComplete:false)` 实测可用，静默入
上下文、事后可引用——**这就是 gated 编排要的静默补喂原语**。

**cc 方法整链重跑（3 session 全新上下文）**：
- 场景①founder 补喂：5 段会议记录注入 Tadashi，**0 字节出声**；点名问发布时间 →
  「发布时间定在周五下午三点。」✅
- 场景②跨 agent：问 Tadashi 代号 →「内部代号是『蓝鲸七号』」（人设埋的唯一事实）；
  其答案转写注入 Honey Lemon（注入 payload 逐字在 `out/s4-multisession.jsonl`
  `t3c-inject` 事件）→ 点名问 Honey →「内部代号是"蓝鲸七号"。」✅
- **负对照**：Hiro 不注入、同问 → 首跑答「没留意他说代号的事」，cc 轮瞎编「疾风」
  ——两种失败形态都证明**补喂是必要机制**（且不补喂时模型可能自信幻觉，
  比「答不知道」更危险，编排层必须保证补喂可靠性）。

## T3-d 延迟（V6）

10 轮被点名者 speech-end→首 audio chunk（3 并发下）：
`[951, 831, 727, 1138, 838, 761, 783, 907, 777, 831]` ms — median 831ms，
全部 ≤1.2s。与 S1 单 session 基线（797-1017ms）同带 → **并发本身不加延迟税**。

## T3-e 成本（V7）

usageMetadata 实测（含 modality 分解）已捕获（`out/s4-multisession-results-run1-rt.json`）。
60 分钟 3-Lead 会议外推（883 单价口径：$0.005/min 音频入、$0.018/min 音频出）：

| 策略 | 音频入 | 音频出 | 文本补喂 | 估算/小时 | 相对单 session |
|------|--------|--------|----------|-----------|----------------|
| 单 session（967 A 形态） | $0.30 | $0.36 | — | ~$0.66 | 1× |
| all-listen ×3 | $0.90 | 实测抢答使输出 ≈2.2× 名义值 ≈$0.77 | — | **~$1.67** | ~2.5×（且体验崩） |
| **gated + cc 补喂 ×3** | $0.30（音频只进被点名者） | $0.36 | 60min 转写 ≈24k tok，<$0.02 | **~$0.68** | **~1.05×** |

实测佐证：t3b all-listen 40s 会议音频下，输出 = named 24.1s + 抢答者 40.5s
（Honey 一人抢出全场最大输出）——all-listen 的成本惩罚主要来自**抢答输出**而非
输入 ×3。

## 复现

```bash
cd engineering/spike/FLY-968-voice-bakeoff
GEMINI_API_KEY=... node s4-gemini-multisession.mjs all                       # 首跑(rt 补喂)
GEMINI_API_KEY=... FLYWHEEL_FEED_METHOD=cc node s4-gemini-multisession.mjs c # cc 静默补喂
GEMINI_API_KEY=... node s4c-feed-comparison.mjs                              # 两代模型对照矩阵
```

结果 json：`out/s4-multisession-results-run1-rt.json`（a+b+c 首跑）、
`out/s4-multisession-results-run2-cc.json`（cc 重跑）、
`out/s4c-feed-comparison-results.json`。
