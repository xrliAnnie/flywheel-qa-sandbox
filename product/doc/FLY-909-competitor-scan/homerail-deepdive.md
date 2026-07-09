# FLY-909 竞品深挖 #3 — homerail(小天fotos,原名『贾维斯 / Jarvis』)

Issue: FLY-909 (https://linear.app/geoforge3d/issue/FLY-909/竞品分析市面上别人怎么做-喂产品定位形态)
日期: 2026-07-08
基于: FLY-1004 homerail 竞品分析 + 扒开源代码(见 product/doc/FLY-1004-homerail-analysis/research.md,firsthand 读了 18 个源文件);对标 paperclip-deepdive.md / matrix-deepdive.md

> **为什么值得挖深**:Annie 2026-07-08 发现的新竞品 —— **跟我们高度相似且已开源**的『语音驱动多-Agent 编排系统』。它是目前跟我们**voice-agent + 编排内核撞得最狠、且代码可扒**的一个。FLY-1004 已 firsthand 扒了它的开源代码 → 提炼成给 Tadashi 的 eng-idea 清单(product/doc/FLY-1004-homerail-analysis/eng-idea-for-tadashi.md)。**本文只做竞品定位角度**,eng 借鉴细节在 FLY-1004。
> **定位口径**:大结论归 FLY-911;本文摆事实 + 差异候选,不硬下。
> 资料:github.com/xiaotianfotos/homerail(README/ROADMAP + 源码)+ XHS 笔记 6a4de258(作者本人)。UNKNOWN 处已标。

---

## 一句话定位
> **"Voice-first local agent orchestration runtime for auditable DAG workflows."**
> 通俗:**跑在你自己家硬件上(NAS/homelab)、语音进 / 生成式 UI 出、把一次性 agent 对话变成可审计可复用 DAG 工作流的编排 runtime。** 名字双关:**Home**(你自己的家用硬件)+ **Rail**(agent 沿 DAG 轨道 node→node 流动)。
> 核心哲学(ROADMAP 原话)= **"Attention is the scarcest resource"**:人这侧收窄(voice in / generated UI out),机器那侧铺开。**跟我们北极星 FLY-212『离屏也顺畅工作』同一句话。**

## 作者 & 势头(build-in-public)
- 作者 = **小天fotos**(国内独立开发者,XHS user `5b208f0511be100f9c278b53`,IP 陕西)。#buildinpublic #多Agent #Agent编排 #jarvis。
- repo = `xiaotianfotos/homerail`,TypeScript,**~191★**,clone 时 **3 小时前还在 push**(active,不是弃坑 demo)。
- 自述模型栈(笔记评论,作者本人)= "**glm max 年 + kimi 199 包年 + 每月 200 刀 codex**"(≈¥2000/月)。UI 疑似 codex 做的(评论区他人推测,⚠️ UNKNOWN,非作者确认)。
- 势头:XHS 笔记 102 赞 / 117 收藏 / 16 评论(2026-07-08 快照)—— 中等热度、开发者圈,**远不到 Paperclip(~70K★)/ OpenClaw(250K★)量级**;是"独立开发者认真做的个人 Jarvis",不是爆款品类领头。

## 目标用户 / 形态(跟我们比)
- **目标 = 单人 operator 跑自己家的 NAS**(voice-primary,未来手机/平板/TV/车)。跟 OpenClaw"跑你自己设备的个人 AI 助理"更像,跟我们"非技术 founder 指挥常驻 AI 组织"有别。
- **形态**:桌面 voice shell + 浏览器 UI(Vue)+ Manager/Node/Worker 三服务 + 每 DAG node 一个 Docker 容器。**编排基元 = 静态 DAG(YAML 模板)**,不是我们的"Linear issue → 三段式 → runner"。
- **界面赌注不同**:它赌桌面 + 未来多终端;我们赌手机原生 IM(Discord)。

## ⭐ 两个撞我们最狠、最该报 Annie 的战略点

### 战略点 1 — homerail 明确"不做软件工程" → 坐实我们"建并养真软件产品"是块空地(好消息)
ROADMAP 白纸黑字(`## What HomeRail is for` + `## Non-goals`,直译):
> "AI 能产出视频/报告/配置/软件,但这些**不一样好判断**。视频你看一眼就知道好坏;一段软件不是——'做完了'很含糊、质量有争议、提需求的人往往判断不了。HomeRail 就围绕这个不对称建,**瞄结果本身好判断的任务**(视频/报告/素材/配置/设计)……**所以 HomeRail 不为软件工程或开发自动化设计**……软件最难被人判断好坏,正好是这系统的错误目标。"

**含义(喂 FLY-911)**:
- 一个跟我们同构、认真做语音多-agent 编排的开源项目,**主动把软件划出去** → 我们那条差异候选『**替非技术的人建并养一个真软件产品**』是**没人正面占的空地**。
- ⚠️ 但它的理由也是**对我们的警告**:非技术 founder 判断不了软件质量 —— 所以我们"结果证明:一试真能跑、下周还能跑"(本 scan §③ 候选锚点)+ 工程纪律(PR/CI/review/QA 当底气)**更关键**。别人怕的地方,正是我们要把它做实的地方。

### 战略点 2 — homerail vendor-neutral、不自造 harness → 跟我们 executor-backend 独立撞车(方向验证)
ROADMAP Non-goal:"**HomeRail 不造 harness**,在现成 harness(Claude Agent SDK / Codex app server / Kimi Code)之上编排,不重造。" 代码上是一个干净的 `AgentClient` 注册表(`AGENT_BACKEND` → claude-sdk/codex/kimi)。
→ **跟我们 executor-backend(FLY-493 antigravity / FLY-494 kimi / FLY-350 codex)是独立收敛的同一决定**。两个团队独立撞到"编排层 vendor-neutral、不自造 harness"= 强信号,**我们方向对**。

## 我们跟它:重叠 / 差异(诚实)
- **重叠**:voice-first + 多-agent 编排 + vendor-neutral harness + SKILL.md symlink 分发 + "贵脑子便宜手"—— 骨架很像。
- **它做得比我们好的(可借鉴,细节见 FLY-1004 eng-idea)**:**语音层成熟** —— 双 TTS 通道(commentary 边干边说 / final 答案)、3 种 ASR 实时策略、生成式 UI 卡片让朗读短、执行前 task_draft 确认。**我们 voice 还在 PRD→实现阶段(FLY-542 树,STT 收音是风险)。**
- **我们做得比它好的**:**贴真实协作的 issue-driven 编排**(它是静态 DAG)、**常驻被协调的多部门组织 + 手机 IM**(它是单人跑自己 NAS)。⚠️ **记忆别当我们的优势**:我们 mem0+pgvector 基本没接、主力文件 markdown;它有结构化 experience/lesson 图谱(自动从 run 抽,可能反而更成熟)—— 两边都非活的语义检索。
- **差异候选(喂 FLY-911,不硬下)**:领域(建并养真软件 vs 它明确不做软件)/ 常驻组织 vs 单人 operator / 手机 IM vs 桌面。

## ⚠️ 诚实边界(UNKNOWN)
- **视频没转写**:XHS 那条是视频,没做语音转写;但视频讲的"能干啥/RoadMap"—— repo README+ROADMAP.md 已权威覆盖同一内容。
- **VAD** 位置未在服务端确认(大概客户端桌面 shell),UI 是否 codex 做的、star/更新时间均为 2026-07-08 快照 → UNKNOWN。
- **没实跑**:结论基于读码 + 文档,没 `hr start` 亲测运行体验。

## 一句话小结
homerail = 一个独立开发者认真做的、跟我们高度同构的**开源语音多-agent 编排 runtime**;**最值得我们借的是语音层**(FLY-1004 eng-idea 已提炼);**两个战略点对我们都是好消息**(它让出软件赛道 + 独立验证我们 vendor-neutral 方向对);它记忆走结构化 lesson 图谱(我们 pgvector 基本没接、主力 markdown,别说我们更强;两边互补)、界面/DAG 基元不适合我们。**热度中等,不是品类领头,但因为开源可扒 + 同栈,借鉴价值高。** 详细 code-grounded 报告(功能盘点 + 架构 + 对比)见 product/doc/FLY-1004-homerail-analysis/homerail-code-report.md。
