# FLY-1059 Designer 首次 dogfood — FLY-1038 统一管理 dashboard concept 方向轮

Issue: FLY-1059 (https://linear.app/geoforge3d/issue/FLY-1059/add-a-designer-agent-role-mockup-first-design-concept-images-founder)
日期: 2026-07-09
基于: plan.md(同文件夹)· 被设计对象 = FLY-1038(统一管理 dashboard,PR #517 是 Annie 判「不够清晰」的那版)

> 这是新 Designer 角色的**第一次真跑(dogfood)**:用 mockup-first 工作流给 FLY-1038 出概念方向轮 A/B/C。**本 PR = 概念方向轮(证据)**;founder-pick(设计门)+ 高保真 = 交 Annie 的 follow-up 真跑(交互 + 要 founder 在场,headless 跑不完整轮)。

## Step 0 — mockup 类型(已确认 = 真 UI 增量)

工作流第 0 步是**必答 gate**:确认「一次性静态方向图」vs「必须落真 app 的 UI 增量」。**Lead 转达 founder 已确认 = 真 UI 增量**——重设计要长在现有 Fleet 控制台上(localhost UI,http://127.0.0.1:9877),不是扔掉的静态图。所以 A/B/C 是「真 app 上这块该长什么样」的方向探索;选定方向后出高保真,**生产 wiring / 真数据 / tests / PR 交 implement(engineer)** 落到真 Fleet console。

## 被设计对象(FLY-1038 需求)

Founder **自管**用的统一 dashboard(不是 runtime 监控):
- 整合现有 instance/model-config Dashboard(哪个实例用哪个模型 + 大量 config)。
- 加新的 **DAG-注册视图**(FLY-1020:哪些 DAG 模板、注册到哪个实例)。
- 核心痛点:实例越来越多,容易忘「哪个实例用哪个」,需要 UI 梳理清楚。

## Annie 反馈(经 Lead relay,已折进每个方向)

1. **DAG-role 显示** — per-category workflow(每类任务的 DAG)· per-node model(每节点模型)。
2. **左竖 nav**(left vertical navigation)。
3. **Feature Flag 单 tab**(不散落,一个 tab 收拢)。
4. **Codex 后端出 Codex 型号**(Codex-backed 实例显示 Codex 模型名,而非 Claude 名)。
5. **删「外部托管」**(external hosting)整块。

## 三个方向(同需求,不同信息架构)

| 方向 | 骨架 | 何时更好 |
|---|---|---|
| **A — 实例树优先** | 左竖 nav + 主区一棵可展开**实例树**;展开某实例露出它的 Lead 模型 + 注册的 DAG 模板(Design→Implement→QA,每节点模型徽章) | 实例数多、层级关系(实例→模型→DAG)是主心智时最直观——直击「忘了哪个实例用哪个」 |
| **B — 主从分栏** | 左竖 nav + 中间实例列表 + 右侧详情(tab: Models / DAG / **Feature Flags 单 tab**);DAG tab 是竖向 DAG-role 节点链,每节点带模型 | 单实例配置深、要频繁改某一个实例时;详情区容纳复杂 config |
| **C — 卡片网格** | 左竖 nav + 顶栏含 Feature Flags 单 tab + 主区实例**卡片网格**;每卡片:模型 chip + 横向 DAG-role 条(🎨→🔨→🧪 每段模型) | 想一眼扫全部实例状态、实例数中等、偏概览时 |

三个方向都满足:左竖 nav ✓ · DAG-role 显示(per-category workflow + per-node model)✓ · Feature Flag 单 tab ✓ · Codex 后端显示 Codex 型号 ✓ · 无「外部托管」✓。

## 双模型(招牌动作)

每个方向用 **codex-image ∥ gemini-image 并行**出图,让 Annie 对比两种模型的取向(codex 对 UI/可读文字更强,gemini 对质感更强):
- A:`directionA-codex.png` + `directionA-gemini.png`
- B:`directionB-codex.png` + `directionB-gemini.png`
- C:`directionC-codex.png`(codex 对结构化 UI 最强,C 以 codex 为准)

图存 `1038-concepts/`。founder 卡(A/B/C 并排 + 每方向留反应位)= `1038-concepts/founder-card.html`,**publish 不带 --channel**,URL 交 Lead 投递给 Annie(Runner 绝不直投 founder 物料)。

## 下一步(follow-up 真跑 = 交 Annie 的设计门)

1. Lead 把 founder 卡投给 Annie → **设计门**:Annie 点一个方向(A/B/C)。都不满意 → 再出一轮(设计门可循环)。
2. 选定方向 → `frontend-design` 出**高保真 HTML**(真观感 + mock 数据)。
3. Handoff = 被批准的高保真本体 + 一页真数据/交互说明 → 交 implement(engineer)落到真 Fleet console(FLY-1038 type b)。

> Peter ④「验 role 接线」= 已由测试证明(label→designer;三段式 UI design-phase→mockup-first;见 plan §7 验证命令)。本概念轮是 role 的**副产品演示**,不是接线证明。
