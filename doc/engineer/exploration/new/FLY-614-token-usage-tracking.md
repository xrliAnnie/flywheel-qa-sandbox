# Exploration: 细粒度 Token Usage Tracking — FLY-614

**Issue**: FLY-614 ([token] 细粒度 token usage tracking — per project / runner / task-type，省钱前先看得见)
**Date**: 2026-06-28
**Status**: Draft（plan-first，等 Annie brainstorm 定方向）

---

## 1. Problem / Motivation

Annie 2026-06-26/27 的痛点：token 用量恐怖 —— 新的 $200 account 一天就烧掉 50% 的 weekly 额度。她要灰度采用降本插件（ponytail），但「省钱之前先得看得见」：

- 现在没有任何工具能回答「**谁在烧 token、烧多少**」。
- 没有 baseline，就量不出 ponytail 到底省了多少 → 灰度无从评估。

本 issue = token 三件套里的 **① 监控（地基）**，必须先做。另外两件（② per-project 开关、③ evaluation）不在本 issue 范围。

> ⚠️ Annie 强制要求（FLY-598）：implement 前必须先跟她 back-and-forth brainstorm，把「到底想要什么效果 / 监控 UX 长啥样」聊清楚。本文档即为该 brainstorm 的载体。

---

## 2. 目标（一句话）

按 **项目 / runner / 任务类型** 拆出细粒度 token 账，让 Annie 一眼看出「谁烧多少」，并能在 ponytail 前后做可比对照。

---

## 3. 关键发现：地基基本现成（详见 research 文档）

- **CC 日志就是数据源**：每条 assistant 记录都带 `cwd` / `gitBranch` / `model` / `usage`(input/output/cache) / `timestamp`。
- **归属是免费的**：目录/cwd 路径天然编码了 项目 + issue + 角色：
  - `Dev/flywheel-FLY-614` → 项目 flywheel · issue FLY-614 · runner
  - `Dev/geoforge3d-GEO-381-qa` → 项目 GeoForge3D · issue GEO-381 · 角色 qa
  - `lead-workspace/mufasa-lead` → 某个 Lead
- **不用在 runner 里加任何埋点** —— 纯事后分析。
- **自写 jsonl 扫描比 ccusage 更准**：ccusage 会把 subagent / workflow 的 token 塌进一个项目盲的桶（约占 11% / $4k），而那些 jsonl 行其实带着父项目的真 cwd。自写扫描总量与 ccusage 误差 < 0.01%，但能正确归属 subagent。

**真实数字（全量 baseline，给方向感）**：约 $37.9k 估算 / 48B token。
- **按模型：Opus 占 90%（$34k）**、Fable $3.2k、Haiku $22 → **Opus 是绝对成本大头，ponytail 该打的靶子**。
- 按项目：flywheel $15k · 各 Lead 合计 $14.4k · geoforge3d $1.7k · sub $1.6k。
- 按角色：Lead $14.4k(14 场) · runner $10.6k(257 场) · 主仓交互 $8.6k(2 场，单场极重)。

> 这些数字本身就是「看得见」的雏形 —— 它已经能告诉 Annie：钱主要烧在 Opus、烧在 Lead 和主仓交互上。

---

## 4. 设计空间 — 三个需要 Annie 拍的决策点

### 决策 A：核心数字看哪个？

| 选项 | 含义 | 优点 | 缺点 |
|------|------|------|------|
| **A1 估算 USD（推荐）** | ccusage 按公开 API 定价折算 | 现成、跨项目可比、能量 ponytail 前后差 | 不是真账单（订阅制不按 token 付费），只是「重量代理」 |
| A2 原始 token | input/output/cache 分列 | 最「真」、可比 | 没有「还剩多少额度」的体感 |
| A3 占 weekly 套餐额度 % | 直接对应「一天烧 50% weekly」 | 最贴痛点 | **CC 日志没有「套餐剩余」这个数**，Anthropic 不直接给 → 只能估，容易不准 |

**推荐**：主显 A1（USD 估算当重量计）+ 并列 A2（原始 token）。A3 暂不硬做，除非 Annie 认为「占额度%」才是她唯一想看的。

### 决策 B：「任务类型」具体指什么？

能免费拿到的拆分轴：**项目 / 每个 runner(issue) / 角色(runner·lead·qa·main·subagent) / 模型(opus·fable·haiku)**。
「任务类型」最可能指 **角色** 或 **模型**，也可能指 **工序**(brainstorm / implement / review / QA)。
- 角色 / 模型：免费、立刻可得。
- 工序：需要 join StateStore（session_role / stage）或日志启发式，成本更高、覆盖不全。

**待 Annie 明确原意**。推荐先以「角色 + 模型」两轴交付，工序作为后续增强。

### 决策 C：在哪看、长啥样？

| 选项 | 形态 | 适配场景 |
|------|------|----------|
| **C1 按需 HTML 报告（推荐）** | `flywheel-comm` 一条命令 → 托管链接 + Discord 截图（Apple 卡片风，复用 FLY-203 publish-report） | 同 Annie 现在收的 triage/fleet 报告，最直观，适合 ponytail 前后对比 |
| C2 每周 Discord 摘要 | 定时推一条 top-burners 摘要 | 被动盯成本趋势 |
| C3 实时 dashboard 面板 | 注入现有 Bridge SSE dashboard | 实时观察，但实现最重 |

**推荐**：C1 按需 HTML 为主，可选叠加 C2 每周摘要。C3 暂不做。

### 决策 D：范围确认

本 issue = **只做「看得见」（监控 + 报表）**，不碰 ② per-project 开关、③ evaluation。请 Annie 确认。

---

## 5. 架构判断：Core 层 vs Surface 层分离

无论 Annie 选哪个 surface（HTML / 摘要 / dashboard），**底层都是同一套**：
扫描 jsonl → 去重 → 按 cwd 分类 → 按 {项目, issue, 角色, 模型, 日期} 聚合 → 折算成本。

→ 把**账目 Core 层（方向无关）**和**展示 Surface 层（依赖决策 C）**解耦。
Core 层可以先实现并测试，Surface 层在 Annie 定向后落地。这降低了「等方向」对进度的阻塞。

---

## 6. Open Questions（已通过 brainstorm gate 发给 Annie，等回复）

1. 决策 A：核心数字看 USD 估算 / 原始 token / 占额度%？
2. 决策 B：「任务类型」=角色 / 模型 / 工序 / label？
3. 决策 C：按需 HTML / 每周摘要 / 实时 dashboard？
4. 决策 D：范围只做监控，确认？

定向后 → 落 research（已基本完成）+ finalize plan → Tadashi review → 实现。
