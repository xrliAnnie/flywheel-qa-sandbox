# FLY-1004 homerail 竞品分析 + 开源代码借鉴 — 探索

Issue: FLY-1004 (https://linear.app/geoforge3d/issue/FLY-1004/homerail-竞品分析-开源代码借鉴-语音多-agent-编排-ex-jarvis)
日期: 2026-07-08
基于: 无(本 issue 为起点);关联 FLY-909 competitor-scan / FLY-906 voice PRD

> 一句话:Annie 2026-07-08 发现一个跟我们**高度相似且已开源**的竞品 —— homerail(原名『贾维斯 / Jarvis』,作者 = 国内独立开发者 小天fotos)。她要两件:**(1) 竞品分析;(2) 扒它的开源代码,提炼成给 Tadashi 的 eng-idea 清单**(她据此开 eng issue)。本文是探索(框定问题 + 方法 + 诚实边界),findings 在 research.md,交付物在 eng-idea-for-tadashi.md + FLY-909 fold。

---

## 1. 为什么这个竞品值得单独研究(不是又一个 Jarvis clone)

市面上叫 "Jarvis" 的语音助手一抓一大把(GitHub 上几十个)。homerail 特殊在**三点同时成立**,正好全撞我们:

1. **语音驱动**(voice-first)—— 撞我们 voice-agent(FLY-906/996)。
2. **多-Agent 编排**(orchestration)—— 撞我们的 Lead/Runner 编排内核。
3. **开源、TypeScript、还在active更新** —— 跟我们同一技术栈,而且**代码可扒**(Annie 的核心诉求)。

绝大多数 "Jarvis" 只满足 1;满足 1+2 的多是 Python demo;1+2+3 且 TS 且认真做产品的,homerail 是我们目前撞得最狠的一个。

## 2. 已核实的身份(避免找错项目)

- **repo = `xiaotianfotos/homerail`**(GitHub)。一句话定位:*"Voice-first local agent orchestration runtime for auditable DAG workflows."*
- TypeScript,~191★,clone 时看到 **3 小时前还在 push**(active,不是弃坑 demo)。
- 作者 = 小天fotos(XHS user `5b208f0511be100f9c278b53`),从 issue 里给的 XHS 笔记 `6a4de258...`(标题《我的贾维斯开源了,语音交互,多Agent编排》)顺藤找到。
- 改名缘由(笔记原文):"不过改名叫homerail"。名字双关:**Home**(跑你自己家的 NAS/homelab)+ **Rail**(agent 沿 DAG 轨道 node→node 流动)。
- 作者自述模型栈(笔记评论区,作者本人回复):"glm max 年和 kimi 199 包年,每个月还有 200 刀的 codex"(≈¥2000/月)。UI 疑似 codex 做的(评论区他人推测,非作者确认 → 标 UNKNOWN)。

## 3. 研究问题(issue 的 4 个重点 → 我怎么答)

| # | 问题 | 怎么答 |
|---|------|--------|
| 1 | homerail 是什么(形态/能干啥不能干啥/RoadMap/repo) | 读 README + ROADMAP.md + 顶层结构(firsthand) |
| 2 | 它 vs 我们(voice-agent + 编排)撞哪、好/差在哪 | 逐子系统对照 Flywheel 现状 |
| 3 | ⭐ 扒代码:架构 / 语音层 / 多-agent 编排 / memory / prompt → eng-idea 清单 | clone repo,firsthand 读 ~18 个核心源文件 |
| 4 | 对我们 voice 设计 / 定位的启发 | 折进 research §9 + eng-idea voice 专节 + FLY-909 |

## 4. 方法(怎么保证"有出处、不瞎编")

- **不只看 README**:把 repo clone 到本地,firsthand 读了 18 个核心源文件(manager prompt / adapter factory / DAG engine / voice.ts / codex-appserver adapter / manager-agent tools / audit / scorecard / skills / provider-catalog / Dockerfile / dag-tools handoff·send·receive 等)。eng-idea 每条都带 repo 文件出处。
- **交付物按 Lead 指令定形**(brainstorm gate 已确认):
  - 折进 FLY-909 = **轻改**:表 A 加 1 行 + 独立 `homerail-deepdive.md` + 一小段观察,**不动** Annie 已逐轮收敛的定位叙事。
  - `eng-idea-for-tadashi.md` = 主交付物,每条『它怎么做(带出处)→ 我们能怎么用 → 值不值』。
  - 两个战略发现写透 + 单独标给 Annie。

## 5. 诚实边界(UNKNOWN,不瞎编)

- **视频没转写**:XHS 那条是视频,我没做视频语音转写。但视频讲的"能干啥/RoadMap"—— repo 的 README + ROADMAP.md 已**权威覆盖同一内容**(而且更准),所以这块不影响结论。
- **VAD 位置未在服务端确认**:源码服务端只见 ASR/TTS,VAD 大概在客户端(桌面 shell / agent-ui),没 100% 落实 → research 里标 UNKNOWN。
- **star / 更新时间**:191★ 与"3 小时前更新"是 clone 当时(2026-07-08)的快照,会随时间变。
- **UI 是不是 codex 做的**:评论区推测,非作者确认 → 标 UNKNOWN。
- **没跑起来**:没实际 `hr start` 跑一遍(需要配 glm/kimi/codex + Docker),结论基于**读码 + 官方文档**,非亲测运行体验。
