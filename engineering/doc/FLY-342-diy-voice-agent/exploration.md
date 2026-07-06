# FLY-342 真人 DIY voice agent 做法 · 接 883 DR — 探索

Issue: FLY-342 (https://linear.app/geoforge3d/issue/FLY-342/voiceresearchextend-真人-diy-voice-agent-做法-接-883-drtts-管线-vs-gemini)
日期: 2026-07-05
基于: 无（上游输入 = engineering/doc/FLY-883-realtime-voice-research/research.md + dr-report.md）

## 1. 问题定义

FLY-883 的 ChatGPT Deep Research 是纯技术选型（三后端对比 + 架构 + Discord 集成）。
Annie 要 **extend**：去扒真人公开分享的 DIY voice agent 做法，接到 DR 结论上，
「TTS 管线」和「Gemini Live」两条路都做、给出对比。要回答的四问（Annie 原话提炼）：

1. **最便宜可行的 STT→Claude→TTS 管线**怎么搭：STT（Whisper 等）+ 脑（Claude 本体）
   + TTS（本地 CosyVoice ≈ 免费 / Microsoft TTS 便宜）。
2. **CosyVoice 真实效果 / 极限**：够不够好用？本地系统搭出来长什么样？
3. **两条路都做 + 对比**：TTS 管线（默认、省钱、回合制）vs Gemini Live（realtime、贵、
   随时打断）——效果差距在哪、各自适配哪些场景。
4. 结论：定「**默认 TTS 管线、特殊场合 realtime**」这个方向的具体配置 → 喂给 FLY-543。

交付物：**research.md**（真实做法提炼 + 接 DR + 两路对比 + 场景矩阵 + 推荐配置）
→ 报 Tadashi → 转 Annie。

## 2. 关键校准点（brainstorm gate 已确认，2026-07-05）

**883 DR 推荐「默认 Gemini Live」；Annie 本 issue 明确方向是「默认 TTS 管线、特殊场合
realtime」。本研究以 Annie 方向为纲**：

- DR 结论**降级**为 realtime 那条路的证据底座（不推翻、不照搬）；
- 本研究**补齐 DR 没深挖的便宜管线路线**（DR 表格里的 C 列「本地 CosyVoice 栈」只有
  组件级证据，没有端到端成本账、没有真人搭建形态、没有实测）；
- 产出**场景矩阵**说清何时才值得切 realtime。

Tadashi gate 回复原话要点：「理解全对，校准点尤其对——以 Annie 方向为纲……这正是她要的」。

## 3. 输入源梳理

| 来源 | 内容 | 对本研究的角色 |
|------|------|---------------|
| FLY-883 research.md + dr-report.md（2026-07-05，25 citations） | 三后端对比、混合架构推荐、Discord 集成风险（DAVE）、可插拔接口清单 | realtime 路线的证据底座；接口抽象直接复用 |
| XHS 笔记 ①（本 issue 342 来源）：车机外置 mic 语音 Agent「牛马」 | Harmony 格式 + TTS 架构；旅行/碎片时间外置 mic 控制 agent | TTS 管线路线的真人实证（结构化对话格式 + TTS） |
| XHS 笔记 ②（FLY-435）：龙虾/阿里本地 CosyVoice 300m LAN 系统 | OpenClaw agent 框架 + 本地 CosyVoice TTS 自动播报，作者「最满意」 | CosyVoice 真实效果的第一手实证；服务化解耦形态 |
| XHS 笔记 ③（FLY-354）：牛马语音 Agent 长任务体验 | 播报通道 + 运行时纠偏 + DAG 生成式 UI | 语音管线的**体验层**做法（长任务播报是回合制管线的主场） |
| 网上真人 DIY 分享（web 检索补充） | Whisper/Claude/CosyVoice 或类似组合的公开搭建 | 补样本量，避免只看 3 条笔记以偏概全 |
| FLY-543（下游消费者） | 全 Lead 共用、可插拔 realtime 后端的 voice skill | 本研究结论的落点：具体配置要它能直接消费 |
| v0.4-voice-interface.md（GEO-150 exploration，2026-03） | 当年按 STT→LLM→TTS 管线 + 状态机设计 | 管线路线的既有内部设计资产（push/pull 模式、风险清单仍有效） |

## 4. 方向选项（已决策）

- **(a) Design 阶段只写 plan，全部 research 留给 Implement** —— 拒绝。research 是本
  issue 的主交付物，纸面部分（真人做法提炼、成本账、两路对比、场景矩阵、配置草案）
  设计阶段就该做实，否则 design review 无实质内容可审。
- **(b) CosyVoice 实测也放 Design 阶段** —— 拒绝。三段式纪律：动手实验归 Implement。
- **(c) ⭐已选：Design = exploration + research.md（纸面定稿）+ plan.md（实测计划）；
  Implement = CosyVoice 本地实测 + 用实测数据定稿推荐配置 + 交付。**

## 5. 阶段切分与验收

| 阶段 | 产出 | 验收 |
|------|------|------|
| Design（本次） | exploration.md、research.md（真人做法 + 接 DR + 两路对比 + 场景矩阵 + 推荐配置**草案**，其中依赖实测的数字标注「待实测」）、plan.md（Implement 实测计划） | Codex design review APPROVED；commit 到本分支；phase_design_complete |
| Implement（同分支下一段） | CosyVoice 本地实测记录 + research.md 定稿（回填实测结论）+ 报 Tadashi 转 Annie | 实测有真机证据；推荐配置无「待实测」占位 |
| QA（同分支第三段） | 独立核查 research 声称 vs 证据 | 按三段式常规 |

## 6. 假设与风险

- **实测机器 = Annie 的 Mac（M 系列）**。883 DR 指出 CosyVoice 的 Apple Silicon 文档薄
  （Linux/CUDA 是低风险路径）→ plan.md 写清失败兜底：modelscope 在线 demo / Docker。
  （gate 已确认此假设。）
- **XHS MCP 与 Annie 同账号，并发登录会互相踢下线**（Tadashi gate 提醒）→ 深读笔记时
  先 check_login_status、低频调用、一次拿全不反复拉。
- 价格/模型名时效敏感（DR 同款警告）：research.md 里所有数字带日期，实施前复核。
- FLY-342 与 FLY-354 的 XHS 笔记可能同源（同一「牛马」作者《用旅行碎片时间帮我干活的
  语音Agent：牛马》）→ research 阶段核对，避免把一条笔记当两条独立证据。
