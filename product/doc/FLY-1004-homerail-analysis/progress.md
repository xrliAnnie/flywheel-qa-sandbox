---
issue: FLY-1004
phase: ship
phaseCursor: 6/6
updated: 2026-07-08
round: 4 (Annie 批注 → 每块画图+用户视角+grounded 对比+事实校正)
nextStep: Annie 批准 9e025761 → 收尾 ship;跑 827 codex → 冻 head → approve gate → Tadashi merge
---

## round-4(Annie 详细批注:5 图 + 用户视角 + grounded 对比我们 + 事实校正)
- [done] grep 我们 codebase 核实:没 Docker(tmux+worktree)/ pgvector 没接主力 markdown / dag-resolver 严格无环 / Claude --resume 原生 / Bridge replay
- [done] HTML v4:5 张内联 SVG 图(DAG/双TTS/3ASR/Docker/记忆图谱)+ 每块用户视角 benefit + grounded 对比 + 事实校正框
- [done] publish --channel 1524471882428973176 直发 FLY-1004 thread(带 screenshot);curl 验过(nonce 0 残留 / 8 textarea / 6 SVG / 0 内联 handler)
- [done] 全文校正 pgvector 优越性错误说法(research/eng-idea/code-report)
- URL: https://fw-reports-a53de2.vercel.app/r/ecd93d46c1706285cf064920e1eaa43a/

# FLY-1004 progress — homerail 竞品分析 + 扒开源代码

## round-1(已 PR #507)
- [done] 溯源 repo = xiaotianfotos/homerail;brainstorm gate 过;exploration/research/plan/eng-idea/deepdive/909 fold

## round-2(Annie 反馈:"你现在做的还太概括" → 看代码不看视频,盘功能 + 细架构)
- [done] 深挖 30+ 文件 + 48 张表 + CLI + WS/JSON-RPC 协议 + provider 全量 + scorecard checks + 安全层 + experience 图谱
- [done] **homerail-code-report.md**(新主交付物):GitHub 链接置顶 + 功能盘点(~15 域,逐条 code-grounded)+ 工程架构(6 包/请求生命周期/协议/48 表/API 面,带 mermaid)+ 它的优势/我们学什么/我们更好/折不折进定位建议
- [done] **修正上一版的错**:曾说"homerail 没跨-run 记忆"→ 错,它有 experience/lesson 结构化图谱(非语义向量)。已同步修 research.md §6+表 / eng-idea D+新增 B6 / deepdive
- [done] 规模实测:~95K 行,6 包(agent-ui 41K Vue),真工程项目非 demo
- [todo] commit + push v2 → CI 绿 → 重新请 approve gate(founder-gated,不自 ship)

## 关键结论(报 Annie)
- 功能:~15 个域(DAG 编排/语音/生成式 UI/7 家中国模型+计费/harness/经验图谱/scorecard+审计+eval/安全/多节点容器/MCP+git/CLI 28 域/Vue UI)
- 架构:Manager(28K,协调+持久化 48 表+REST/WS)/ Node(起容器)/ Worker(harness+DAG tools+audit)/ protocol(契约)+ agent-ui
- **建议:borrow 它的 eng(语音/质量闸/安全),别 adopt 它的 positioning**(单人 operator 跑自己 NAS 做易判断的活 ≠ 我们非技术 founder 手机指挥建软件);折不折进定位 Annie/FLY-911 拍,本文给足细节支撑
- 三个 Runner 能学的重点:语音双通道+生成式 UI+执行前确认 / runtime 内置 scorecard 质量闸 / 凭据加密+mount 白名单

## 诚实边界
VAD 位置/experience 图谱与生成式 UI 真实成熟度/UI 是否 codex 做/star 数 = UNKNOWN;没实跑;视频没转写(README/ROADMAP 已覆盖)
