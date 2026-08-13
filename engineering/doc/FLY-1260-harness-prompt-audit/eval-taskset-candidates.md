# FLY-1260 评测任务集 · 三方向候选 issue（给 Annie 圈选） — 任务集候选

Issue: FLY-1260 (https://linear.app/geoforge3d/issue/FLY-1260)
日期: 2026-07-15
基于: eval-plan-annie-r1.md（评测设计，Annie R2 拍板：pipeline=YES / 处理面=BOTH / 列候选=YES）

> Annie R2：三方向各试——**小修复 / 偏设计 / 偏 QA**。**实际跑 A/B 推迟到本轮收完+批量重启之后**；现在只把候选清单列好给她圈。
> 每方向从近期已完成 issue 里选真实副本；圈定后**跑前逐个复核**（改动规模合适 / 起点不含答案文档 / 晚于模型 knowledge cutoff——全部 2026-07，cutoff 后，天然满足最后一条）。

---

## ✅ 最终圈选（Annie 定 · 2026-07-15）

A/B 评测的两个真实任务副本（A/B 只做两方向；QA 方向已砍）：

| 方向 | 圈定 issue | 是什么 |
|---|---|---|
| 方向一 · 小修复 | **FLY-272** | cmux Runner 窗名用 Linear identifier（窗名 raw UUID → FLY-XX）|
| 方向二 · 中等偏设计 | **FLY-560** | Discord issue 状态可视化（stage_changed 自动打 thread 标题状态前缀）|

> **执行边界（Annie 令）**：此刻只记档。**跑前复核（改动规模 / 起点不含答案文档 / 造干净副本）+ 造副本 + 529 房跑 A/B，全部留到批量重启之后。** 红线不变：动生产提示词前必须先有评测数据。

---

## 选法
- 每方向圈 **1 个**（偏 QA 可不圈——Annie 说「可能不需要」）。
- 圈定后我对每个候选做**跑前适配复核**（下方「复核清单」），不合适就从同方向候选里替补。

## 方向 1 · 小修复（真实小 bug / config 改）
> ⚠️ 诚实提醒：本仓「真·小修复」稀缺——近期 fix 类 commit 普遍带重测试行李（报告 §局限已记）。以下按「改动最集中、边界最清」排序。

| 候选 | 是什么 | 为什么适合「小修复」 | 复核要点 |
|---|---|---|---|
| **FLY-272** | cmux Runner 窗名用 Linear identifier（而非 raw UUID）| 单点可读性修，改动面最小、无契约层 | 确认 diff 小、无重测试行李 |
| **FLY-239** | 停 Bridge 精准杀（按 port+进程树，不裸 pattern sweep）| 边界清晰的行为修，防误杀 QA-slot bridge | 确认起点不含「怎么修」的方案文档 |
| **FLY-218** | 529 临时限流误判 usage_limit 修复（LeadWatchdog classify 短路）| 纯识别逻辑小修 | 有多轮 Codex review 行李，偏中等——次选 |

## 方向 2 · 中等偏设计（R2 修订 — Annie 圈选反馈）
> Annie R2：第一版候选「都太小了」；特别大的（FLY-510/493/529 那种量级）不要，要**中等规模、偏设计**——有设计文档 + 多文件改动，但**一个 runner 一天内能完**。

| 候选 | 是什么 | 为什么适合「中等偏设计」 | 复核要点 |
|---|---|---|---|
| **FLY-560** | Discord issue 状态可视化（stage_changed 自动打 thread 标题状态前缀）| 有设计（状态如何映射到标题）+ Bridge 多文件改，day-sized | 确认起点是需求、不是方案定稿 |
| **FLY-863** | StateStore stuck-hold 列 + reconcileStuckCodexHolds | 有设计（schema + 对账策略）+ 多文件（StateStore / plugin.ts / 测试），day-sized | 确认起点不含 schema 定稿 |
| **FLY-267** | Codex Lead 跨部门频道参与（#leads-roundtable）| 有设计（mention-gating + 回复路由）+ 多文件，day-sized | 确认起点是问题、不是设计方案 |

## 方向 3 · 偏 QA — 已砍（R2 修订）
> Annie R2：「QA 方向不用专门测，砍掉。」→ **A/B 只做两方向**（小修复 + 中等偏设计）。

---

## 复核清单（圈定后逐个跑前做）
1. **改动规模**：小修复方向 diff 要真小（不带成套新测试）；否则失去「小修复」代表性 → 换同方向候选。
2. **起点不含答案**：dispatch 时的 issue 描述 / 关联 doc 不能已含「怎么做」的方案 —— 否则模型是在抄，不是在干。
3. **晚于 cutoff**：全部 2026-07，模型 knowledge cutoff 之后，天然满足。
4. **可复现副本**：能在 529 房造一个干净 issue 副本（起点 commit + 干净分支）。

---

**下一步（推迟到本轮收完+批量重启后）**：Annie 圈定 → 我逐个复核 → 造副本 → 529 房跑 A/B（现版 vs 大清理版 × Fable+gpt-5.6）→ scorecard → 建议。**红线不变：此刻及圈选阶段仍零生产变更。**
