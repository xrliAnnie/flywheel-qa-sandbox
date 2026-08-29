# FLY-1004 学习记录 + 交接(homerail 研究收尾)

Issue: FLY-1004 (https://linear.app/geoforge3d/issue/FLY-1004/homerail-竞品分析-开源代码借鉴-语音多-agent-编排-ex-jarvis)
日期: 2026-07-08
基于: homerail-code-report.md · eng-idea-for-tadashi.md · research.md(同文件夹)

> **收尾说明(Annie 2026-07-08 拍板 ship)**:homerail 研究收敛。这份是**学习记录 + 交接清单** —— 把 1004 拆出来的东西喂给下游 issue 出 PRD,别丢。做出来后给 **Typeless** 继续推进。

---

## 一、我们从 homerail 学到了什么(key learnings · 都 code-grounded)

homerail(`github.com/xiaotianfotos/homerail`,开源 TS ~95K 行,语音多-agent DAG 编排 runtime,单人跑自己 NAS)。**总判断:借鉴工程,不 adopt 定位。**

1. **DAG 运行时能力** —— loop / **inject(中途插话)** / **fork(岔分支重试)** / **profile(每步配模型)** / replay(重启确定性重建)。核心是"跑中干预 + 恢复"能力,我们目前没有。
2. **语音双通道 + ASR 主备降级** —— 双 TTS(报进度旁白 commentary + 报结论 final);ASR native_realtime 主 / emulated_batch(说完批量转)备胎。
3. **Docker Worker 隔离** —— ExecutionProvider 抽象(shell 到 docker CLI,可换 podman/远程)+ mount 白名单 + 非 root + 凭据加密。
4. **经验图谱** —— run 完自动抽 FailureRootCause/Lesson/Signal 进结构化图谱(自动复盘)。
5. **vendor-neutral harness 注册表** —— 跟我们 executor-backend 独立撞车(方向验证)。

**⭐ 两个最大洞察(Annie 的)**:
- **"我们的 Session 就是 DAG"**,且分**两层**:第一层 = 每类 issue 一套薄 DAG 模板(乐高,Eng≠Designer,底层积木同、编排随任务变)≈ homerail;第二层 = 自动编排引擎(分诊 + 决定做哪些 issue + proactive 派活)。
- **诚实边界(Annie flag + 采纳)**:模板要做**薄、可覆盖、不束缚模型推理**;价值在"人"这侧(控制/信任/验收),不是让模型更强;随模型变强该越来越松绑 —— **别过度工程化**。

## 二、交接清单 —— 1004 拆出来的东西喂给谁(别丢)

| 拆出来的内容 | → 目标 issue | 喂什么 |
|---|---|---|
| **低层 DAG**:每类 issue 一套薄模板 + inject/fork/profile 跑中能力 | **FLY-1020**(新建,出 PRD) | homerail 的 DAG 运行时机制 + 薄模板不束缚模型的度 |
| **高层 DAG**:自动编排引擎(CoS 分诊 + 决定做哪些 issue + proactive 派) | **FLY-353**(架构进化,出 PRD) | 第二层引擎理念 + homerail Manager Agent 挑模板/起 run 的做法 |
| **语音**:双 TTS 通道 + ASR 主备批量转写降级 | **FLY-906** round-2 backlog | 双通道 filler + Discord 收音风险(FLY-544)的批量转写 MVP 降级 |
| **Docker Worker**:容器沙箱 + 凭据加密 + mount 白名单 + ExecutionProvider 抽象 | **FLY-1005**(多机,接沙箱 FLY-346) | 隔离/生命周期工程细节 + provider 抽象(多机每机一个) |
| **经验图谱**:自动从 run 抽结构化 lesson | **FLY-347** | 自动复盘机制(vs 我们现在人工 markdown) |
| **生成式 UI** | — | **not-now**(commodity,Claude Code 已带;agent-agnostic 时再议) |
| **定位信号(2 条)** | **FLY-911**(不改定位主体) | ①它让出软件赛道→印证我们空地;②vendor-neutral→印证 executor-backend |

**后续**:FLY-1020 + FLY-353 出 PRD → 给 **Typeless** 继续推进。

## 三、诚实边界(留档)
- 视频没转写(README/ROADMAP 已覆盖);VAD 位置 / experience 图谱与生成式 UI 真实成熟度 / UI 是否 codex 做 = UNKNOWN;没实跑 `hr start`。
- 我们自己的事实(grep 核实):没用 Docker(tmux+worktree);mem0+pgvector 代码在但基本没接、主力文件 markdown;DAG = dag-resolver(严格无环 issue 级);fork 靠 Claude 原生 `--resume`。
