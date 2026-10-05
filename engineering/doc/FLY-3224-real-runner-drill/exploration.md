# FLY-3224 真 Runner 通用演练（529 房间） — 探索
Issue: FLY-3224 (https://linear.app/geoforge3d/issue/FLY-3224/qa-sbx-fly-3224-real-runner-generalized-drill-529-room-only)
日期: 2026-10-05
基于: 无

## 当前证据

这是 `xrliAnnie/flywheel-qa-sandbox` 内的文档演练。本轮 run：`8794dd59-6028-4df4-895b-1d0124bf0cb1`；设计 exec：`ecabec65-e3b0-47c1-905b-1104ef56a4b9`。已取得 `yours phase=design epoch=1 node=eng_design attempt=1`；activation：`activation:ecabec65-e3b0-47c1-905b-1104ef56a4b9:8794dd59-6028-4df4-895b-1d0124bf0cb1:eng_design:1`。

- 新鲜拉取的 main 与分支起点均为 `62a604d441b959318623292e07bf8af9ebdc28b3`。已逐条读取 `origin/main:qa-sbx/fly3224/README.md`，blob 为 `c4a1b3334b84d73b95cf4e2943c2c8f1474aef87`。
- 当前分支：`project-slot-2-FLY-3224`；演练文件：`qa-sbx/fly3224/project-slot-2-FLY-3224.md`。继承的两行是 `QA-SBX FLY-3224 drill` / `FIXED-FOR-CLAIM 1`；这个 1 是历史内容，不能当作本轮 QA 编号。
- 查询当前分支的 OPEN PR 返回空列表。旧 PR #571 已在 main 历史内；本轮实现需重新检查 PR 状态，不能沿用旧评审、旧 CI 或旧账本。
- 已读取 CLAUDE.md、项目声明的 onboarding、产品体验规范及架构概览。仓库配置中的旧 `test-slot-4` 身份不覆盖注入的 `test-slot-2` 和上述执行身份；不改配置，不访问生产存储。

## 方案与调研结论

采用 README 规定的两次交付：首次写 `AWAITING-QA`，首轮验收故意失败产生本轮编号；返工只写该编号，再独立重验。直接保留历史编号会跳过演练目的；增加程序、数据库、测试套件或部署会超出范围。

README 明确 “one short plan is enough. No research document.”，因此将本地调研结论写在本探索和 plan.md 内，不新增 research.md，也不进入无实际工作的 research 阶段。无需外部研究或 Lead 问题。

README 的单文件范围约束演练内容；注入的设计节点契约另外强制 DOC-FLOW、progress 账本和 founder HTML。协议产物仅复用本文件夹：exploration.md、plan.md、progress.md、design.html 与已有两份 Mermaid 图源、SVG；它们不参与演练 QA criterion。设计阶段不修改演练文件。

## 边界与完成证据

不改 Linear 状态、评论或标签，不部署/拆除 529 房间，不改代码、表、查询或索引，不调度后继节点，不请求 shipping 权限，不合并 PR。下一节点的身份和能力以它自己的注入任务和 TURN 为准。

设计完成需本轮服务端有效 APPROVED、设计产物提交并普通推送、强制 HTML 成功发布并通过指定 structured report 回报，以及 `phase_design_complete` 回执。随后 park，保留 resident goal；阶段交棒不是整单完成。
