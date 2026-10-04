# FLY-3224 真 Runner 通用演练（529 房间） — 探索
Issue: FLY-3224 (https://linear.app/geoforge3d/issue/FLY-3224/qa-sbx-fly-3224-real-runner-generalized-drill-529-room-only)
日期: 2026-10-04
基于: 无

## 任务与当前证据

本次只设计 README 规定的两行文档演练，不设计 Flywheel 功能。已读取新鲜拉取的 `origin/main:qa-sbx/fly3224/README.md`：main 为 `e6513c9b6867e3773a9bd69b17522cad9d9b828d`，README blob 为 `c4a1b3334b84d73b95cf4e2943c2c8f1474aef87`。

- 当前分支：`project-slot-2-FLY-3224`。目标文件：`qa-sbx/fly3224/project-slot-2-FLY-3224.md`。
- 起点文件已有两行：`QA-SBX FLY-3224 drill` / `FIXED-FOR-CLAIM 1`。这是 main 留下的历史内容，不是本轮 QA 结果；实现第一次交付必须恢复 `AWAITING-QA`。
- `gh pr list --head project-slot-2-FLY-3224 --state open` 返回空列表；远端同名分支查询也为空。旧计划中的 PR 553、run 18c10fbd 和交付指针全部失效。
- 本轮 run：`cb1aa71a-8686-466e-90a6-ddca7f324c7e`；设计 exec：`f08ad580-f90d-4546-af89-f754ccd0426d`；TURN 为 design / epoch 1 / eng_design / attempt 1。
- 已阅读 CLAUDE.md、声明的 onboarding 材料、产品体验与架构概要。旧的生产路径、Linear 更新与部署要求不适用于本演练。注入的节点契约和本次 README 约束优先。

## 文档范围与取舍

README 明确“one short plan is enough. No research document.”，所以不创建 research.md，也不宣称进入 research 阶段。本探索将已有证据直接交给 plan.md。

README 的单文件限制用于演练内容；注入的设计节点契约另要求 DOC-FLOW 文档、进度账本及提交/发布设计 HTML。为同时满足两者，协议文档只落在本文件夹；不参与 QA criterion，不改变演练内容。设计阶段只更新 exploration.md、plan.md、progress.md、design.html 与本页两份 Mermaid 图源及本地 SVG。实现/QA 的内容改动仍只有演练 Markdown，另允许各自注入契约要求的 progress.md。没有额外 research 文档、代码、数据库或部署产物。

采用两次交付：先 AWAITING-QA，首轮故意失败产生本轮编号，再按返工提示复制编号并重验。直接沿用旧编号会掩盖演练目的；增加程序、测试文件或新存储会超出 README 范围。

## 约束与设计验收

不改 Linear 状态、评论或标签；不部署/拆除 529 房间；不调度后续节点；不请求 shipping 权限。当前设计不改目标文件。完成证据为本轮有效 APPROVED 设计评审、已推送的设计文档、已发布并通过 structured report 报给指定 Lead 的 HTML，以及 phase_design_complete 的服务端回执。完成设计阶段后保留 resident goal，等待控制器。
