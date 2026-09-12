# FLY-2393 项目 beta 分频 — 调研
Issue: FLY-2393 (https://linear.app/geoforge3d/issue/FLY-2393/1143b6-bridge-按项目分频独立泳道只阻塞-3每项目-beta-分频目标态不阻塞-flywheel-only-每周-release)
日期: 2026-09-10
基于: plan.md

## 设计交付证据

- 最终有效 reviewVerdict：APPROVED（R2）；request `97975305-bb76-435c-b0bb-100dd0484728`，question `9c9dff1e-394c-4874-8096-b0a9e1aedc68`。原文见 review-r2.json，5 条非阻塞建议按 Lead 指令仅归档 plan §12。
- 包含最终 HTML、SVG、审批记录的提交：`04547575e`，已推送 origin/flywheel-FLY-2393。
- HTML：`founder-design.html`；两份本地渲染 SVG 已内联且命名空间互不冲突；无占位图。
- 发布使用 `publish-report --publish-only`：没有频道消息，`messageId=null`、`publishOnly=true`、reportId=`7c2074b4b269e927ddf22bafa8f9efa3`。
- 托管页面：[FLY-2393 每项目 beta 分频设计](https://fw-reports-a53de2.vercel.app/r/7c2074b4b269e927ddf22bafa8f9efa3/)。已通过指定 `DESIGN-HTML ready` 格式向 flywheel-eng-lead 报告。
- 实际线上 GET：HTTP 200；50,617 bytes；nonce placeholder=0；脚本 nonce 被真实 CSP 授权；inline SVG style 被允许；HTML5 parse errors=0；2 SVG、7 评论框。DOM 评论交互检查见 validation.md，作者未获得完整浏览器截图，未冒称视觉截图验收。
- 边界：全部改动仅在本 issue 设计文档目录；没有实现调度代码、修改真实配置、发布 beta、部署或 dispatch 后继。GeoForge3D 的真实内部 beta workflow 仍为 Lead 已确认的激活前置；模拟调度不算双项目上线。
- 下一步：执行 `complete --route phase_design_complete`，成功后 park；DAG 控制器负责后继。
