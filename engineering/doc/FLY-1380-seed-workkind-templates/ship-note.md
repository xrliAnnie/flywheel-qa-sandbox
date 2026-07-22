# FLY-1380 工作类型模板 — 发布说明
Issue: FLY-1380 (https://linear.app/geoforge3d/issue/FLY-1380/dagbuild-种-work-kind-binding1396-prd-落地-派发按活的类型选模板不再一律-tpl-eng-heavy)
日期: 2026-07-22
基于: plan.md

## 本次发布的效果

- 首次 Bridge warm 会创建并发布 6 个 dormant identity:`tpl_eng`、`tpl_eng_land_v1`、`tpl_product_v1`、`tpl_product_designer`、`tpl_product_prototype`、`tpl_generic`。
- 不新增、不修改任何 `workflow_category_binding`;默认 binding 集仍只有 legacy `*` / `light` / `trivial` 三项,且只给完全没有 binding authority 的新项目初始化。
- `FLYWHEEL_WORKFLOW_GENERALIZED_TEMPLATES=0` 仍会阻止 v2 selection/admission/submission;它不再阻止 bundled v2 seed 安装与发布。
- `tpl_ops_light` / `tpl_research_light` 不再由 bundle 自愈;已安装环境里的旧 DB 行本单不删除、不 retire,留给 activation-gated cutover。
- 新增 `retireWorkflowTemplate` 只是管理 seam,本单没有 caller,部署不会自动 retire 任何模板。

## 首次 warm 与后续 warm

首次 warm 的预期写入只有 6 组模板 identity/revision/publication 与 6 条 `seed_import` audit。这是批准过的「创建 + 发布」,不是 binding 激活。内容哈希相同的后续 warm 全部返回 `unchanged`,模板表和 audit 均不再写。

2026-07-22 在当前生产 `teamlead.db` 的 SQLite online backup 上执行两次完整 boot import + default-binding ensure,结果:

| 指标 | warm 前 | 首次 warm delta | 第二次 warm delta |
|---|---:|---:|---:|
| 项目数 | 6 | 0 | 0 |
| binding 行数 | 6 | 0 | 0 |
| `rebind` audit 数 | 6 | 0 | 0 |
| 模板 identity 数 | 6 | +6 | 0 |
| 全部模板 audit 数 | — | +6 | 0 |

首次新增 identity 精确为:`tpl_eng`、`tpl_eng_land_v1`、`tpl_generic`、`tpl_product_designer`、`tpl_product_prototype`、`tpl_product_v1`。两次 warm 前后排序后的 binding 逻辑行集逐行相等。

## 部署后核对

1. 记录排序后的 `workflow_category_binding(project, task_category, template_id, updated_by)` 与 `workflow_template_audit WHERE action='rebind'` 计数。
2. 重启 Bridge 一次,确认上述 binding 行集及 `rebind` 计数零变化。
3. 确认 6 个新 identity 都有 `current_published_revision=1` 且 `retired_at IS NULL`。
4. 再 warm 一次,确认模板 audit 总数零变化。

不要在本次部署写 work-kind binding、翻 `pipeline.work_kind`、翻 generalized flag 或执行 retire。那些动作属于后续一次性 cutover 及其 activation gate。
