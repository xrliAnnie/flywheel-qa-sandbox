# FLY-2697 summary presentation 迁移受管入口 — 设计修正
Issue: FLY-2697 (https://linear.app/geoforge3d/issue/FLY-2697/raya-并仓m0-code-fly-2619-summary-presentation-迁移的受管入口wrapper只部署不执行幂等-校验)
日期: 2026-09-17
基于: plan.md(v6 → v7)

## 修正 1:A4 阶段「生产 DB 完全不触碰」→「不改任何行、只做 schema-only 列补齐」

- **来源**:Codex 设计评审 R4 #5 指出,S4(FLY-2696)§4.3 要求的 `completed_at_ms` 列若按既有 `ensureColumn` 模式放进 `SummaryPresentationStore.migrate()`,会在本单代码部署后随 Bridge 的每次 `StateStore.create` 自动执行一次 `ALTER TABLE summary_presentation_migration ADD COLUMN completed_at_ms INTEGER`(`packages/teamlead/src/StateStore.ts:3899-3903` → `:6813-6817`),与 wrapper 是否被调用无关。这与母方案 FLY-2680 §10.2 A4「生产 DB 未被触碰」的字面表述冲突。
- **裁定**:Lead(Tadashi)2026-09-18 对 ask `fbd706d8-2bce-4d28-915b-1cca516e5fe6` 的回复,原文:
  > 裁定:(1) DDL 时机选方案 a——nullable、schema-only 的 completed_at_ms 随 A4 的 ensureColumn 自动执行,与 FLY-2619 的 stale_alerted_at_ms 同一模式;不改任何行、COUNT(*) 不变。

  这是 **Lead 裁定,不是 founder 直令**。founder 2026-09-17 23:25Z「不应该搞常驻的模式」一语与本条无关(Lead 明示不适用),此处不引用为依据。
- **废弃的概念**:「A4 阶段生产 DB 完全不触碰」。
- **保留的器官**:A4 **不改任何行、不执行迁移、只加一列 nullable 列**;A4 的验证命令 `SELECT COUNT(*) FROM summary_presentation_migration` 仍必须等于 A0 记录值;`ensureColumn` 幂等,`git revert` 后旧代码忽略该列。
- **落点**:plan.md §11 第一、二条按上述措辞重写;§13 L7 保留为已知的生产 schema 变化;FLY-2680 A4 行的同步更正由 Lead 在 FLY-2680 上留评论记录,本单不改母方案文件。

## 修正 2:评审收口路径(记录,不改设计)

Lead 同一回复的第 (2) 条:允许一次 R5,严格限定为 R4 五条(R3 #5 残留 + 四条 v5 自引入回归)的验证轮;自引入回归必须经验证,不能用裁定盖掉;R5 若仍在同一 findingKey 上推广新形状则停下报 Lead 以 review-ruling 记 follow-up,不开 R6;design-review.json 只写真实 verdict。
