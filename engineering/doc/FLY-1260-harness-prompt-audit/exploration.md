# FLY-1260 Harness 实验室 #1：提示词/技能瘦身审计 — 探索

Issue: FLY-1260 (https://linear.app/geoforge3d/issue/FLY-1260/research-harness-实验室-1提示词技能瘦身审计-评测框架无评测数据不动生产提示词)
日期: 2026-07-14
基于: 无

> **形态变更（2026-07-14 17:53 PDT，Annie 直令，盖过本文档的执行范围）**：本单转**一段式**——本 session 产出即最终交付物；A/B pilot **本轮不执行**（评测框架降为提案章节）；交付物 = 可互动 HTML 审计报告发 issue thread，Annie 逐条批注后迭代；publish-report 投递为指令性例外（Lead 给定 channel 参数）。本文档 §4 的「12-run pilot 执行」「linked worktree」等描述为历史记录，执行以 plan.md 为准。

## 1. 问题定义

Flywheel 的提示词体系（runner 注入块、lead-rules、skills）大部分写于弱模型时代，风格是 step-by-step SOP、必填清单、防御性仪式（"NEVER…"、"MANDATORY…"、逐步命令模板）。两条证据线指向同一个怀疑：

1. **外部观察**：小红书 BB亲《GPT升级5.6后，skill和harness也脱胎换骨了》——强模型时代 harness 应从"教模型怎么做"转向"给模型目标+边界"；Superpowers skills 与 5.6 冲突的外部报告同源。
2. **今天实战（2026-07-14）**：Codex/Fable 在 design 首跑中的自主取证质量（少指令高发挥）好于被 SOP 束缚的表现；但同一天也有反例——生命周期契约层（安全/权限/审批）恰恰是靠死板指令才守住的。

**核心怀疑**：过度指令在强模型上不是无害冗余，而是主动压制判断力（模型花预算在服从仪式上，而不是解决问题上）。但砍错了层（安全/权限/协作协议）会直接出事故。

**Annie 铁律**：没有评测数据，不改任何生产提示词/skill。本单交付 = 审计 + 评测框架 + A/B 数据 + 建议，**零生产变更**。

## 2. 三层框架（分类的理论底座）

来自 #flywheel-engineer 2026-07-14 17:33 讨论，issue 参考区归纳：

| 层 | 内容 | 瘦身姿态 |
|---|---|---|
| **契约层**（lifecycle/safety） | 权限边界、merge 授权、gate 协议、founder-only 动作、审计要求 | **不砍**。这些是系统安全性的来源，与模型强弱无关 |
| **协作层**（protocol） | 跨 Agent 通信协议（flywheel-comm 命令形态、report-back 通道、stage 上报）、doc 落点约定 | 保语义、砍冗余重复与防御性穷举 |
| **方法论层**（how-to） | TDD 步骤教学、"先读 X 再读 Y"、通用操作步骤、假想边缘 case 穷举、模型本来就会的方法论 | **主要砍候选**。强模型自己会 |

Annie 公式（issue 原文）：
- **留** = 模型推断不出的经验 / 用户长期偏好 / 权限风险边界 / 跨 Agent 协作协议 / 真正改变结果的判断框架
- **砍候选** = 通用操作步骤 / 流程仪式 / 重复上下文 / 假想边缘穷举 / 模型本来就会的方法论

## 3. 方案选项

**A. 凭判断直接瘦身生产提示词** —— 违反铁律，直接排除。外部报告 + 一天实战不构成证据。

**B. 审计 + 评测框架 + 小规模 A/B pilot（选定）** —— 先把资产盘清楚、按公式标注，再用可复现的评测框架跑 12-run pilot 拿方向性数据。pilot 的目的是**验证评测框架本身**（rubric 能不能区分好坏、隔离环境是否干净），不是下最终结论。

**C. 全量大规模评测（每格子 N≥5 重复、覆盖全部任务类型）** —— token 成本与时长不成比例，且在 rubric 未经校准前大规模跑是浪费。作为 pilot 之后的 Harness 实验室 #2+ 候选。

## 4. Scope（brainstorm gate 已批，Lead 拍板规则）

1. **盘点三层**：Blueprint runner 提示词全部 instruction 块 + flywheel-skills 库 + lead-rules-base 全部 .md，逐块字数+用途。
2. **标注表**：每块归类（留/砍候选/部分砍）+ 理由 + 瘦身建议。
3. **评测框架**：3 个真实重放任务（小修复/设计/QA 各 1，取自近期已完成 issue，repo 回退到 pre-fix 状态）+ 5 指标（产出质量评分、来回轮数、token 消耗、需人工插手次数、审查 findings 数）。
4. **A/B pilot**：现版 vs 瘦身版 prompt，Fable + gpt-5.6 双模型，隔离环境（scratchpad worktree + comm stub，不连生产 Bridge/Linear/Discord），3 任务 × 2 变体 × 2 模型 = **12 runs 单次**。
   - pilot 跑完先看方向性信号；若瘦身版明显更差/更好，只对**决策相关格子**加 2-3 次重复（不均匀加，省 token）。
   - **模型维度保留双模型**——"瘦身对不同模型影响是否不同"正是 Annie 问题的核心。
   - Fable 腿排在 5h 配额窗口宽松时跑；codex exec 走订阅。
5. **建议报告**：HTML 素材整理好经 ask 交 Lead 投递 founder，Runner 不直接发（founder 物料铁律）。
6. 报告结论**分级**：强证据 / 方向性 / 不确定；方差 caveat 照实写。

## 5. 关键假设

1. 近期已完成 issue 可以重放：小修复类任务用 merge commit 的 parent 作起点、issue 文本作输入，与真实 merged fix 对照可行。设计/QA 类以 rubric 评分为主。
2. 隔离环境可行：claude CLI headless（隔离 CLAUDE_CONFIG_DIR 配方已有）+ codex exec，在无 CLAUDE.md/AGENTS.md 的裸 worktree 里由 harness 显式注入 prompt 变体，能控制住 prompt 表面（不被全局 rules/skills 污染）。
3. 瘦身版 prompt 由标注表推导（砍掉"砍候选"块、保契约层），不是随手删——避免稻草人变体。
4. token 计量可从 CLI 输出获取（claude -p 的 JSON usage / codex exec 的 token 统计）——research 阶段验证。

## 6. 风险

| 风险 | 应对 |
|---|---|
| 评测噪声 > 效应量（单次 run 方差大） | pilot 定位=验框架；结论分级；决策格子加重复 |
| 任务重放保真度不足（真实 runner 有 Lead 互动，重放没有） | comm stub 记录 gate/ask 调用作"需人工插手次数"指标，而非真等回复 |
| 瘦身变体构造偏差（砍太狠→稻草人；砍太轻→测不出差异） | 变体严格按标注表推导，规则透明写进 research/plan |
| prompt 表面污染（全局 rules/skills/CLAUDE.md 混入） | 裸 worktree + 隔离 config dir + 显式注入；research 阶段验证干净性 |
| 5h 配额窗口被 Fable 腿烧穿 | 排宽松窗口跑；单次 pilot 规模已压到 12 runs |

## 7. 结论

走方案 B。下一步 research.md：把三层资产的真实结构（Blueprint 块地图、lead-rules 清单、skills 清单）、重放任务候选、harness 技术可行性（CLI 参数/token 计量/隔离配方）调研清楚，再写 plan。
