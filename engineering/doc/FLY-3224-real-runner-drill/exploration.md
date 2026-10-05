# FLY-3224 真 Runner 通用演练（529 房间） — 探索
Issue: FLY-3224 (https://linear.app/geoforge3d/issue/FLY-3224/qa-sbx-fly-3224-real-runner-generalized-drill-529-room-only)
日期: 2026-10-04
基于: 无

## 任务与当前证据

本次只设计 README 规定的两行文档演练，不设计 Flywheel 功能。已读取新鲜拉取的 `origin/main:qa-sbx/fly3224/README.md`：main 为 `c68c2b7d4639ed9a1019faa05dc4414c340d3396`，README blob 为 `c4a1b3334b84d73b95cf4e2943c2c8f1474aef87`。

- 当前分支：`project-slot-2-FLY-3224`。目标文件：`qa-sbx/fly3224/project-slot-2-FLY-3224.md`。
- 起点文件已有两行：`QA-SBX FLY-3224 drill` / `FIXED-FOR-CLAIM 1`（分支头与 main 同内容）。这是上一轮 run 的返工结果，不是本轮 QA 结果；实现第一次交付必须恢复 `AWAITING-QA`。
- 分支继承上一轮 run `bdb3fbec` 的提交，PR #571（base main）仍 OPEN，头 `2ee7e48b969a35f063e53eaf2580d0f3dec274d9`。本轮复用这个 PR，但它的旧评审、旧 CI、旧 claim 1 都不作本轮证据。分支比 main 落后一个只改 FLY-3225 文件夹的提交，与本单无重叠。
- 本轮 run：`278e6c90-e543-4846-ba3f-d20495ae0ad8`；设计 exec：`a472d2a8-fa45-479f-b412-308231865c79`；TURN 为 design / epoch 1 / eng_design / attempt 1。
- 已阅读 CLAUDE.md、声明的 onboarding 材料、产品体验与架构概要。旧的生产路径、Linear 更新与部署要求不适用于本演练。注入的节点契约和本次 README 约束优先。

## 文档范围与取舍

README 明确“one short plan is enough. No research document.”，所以不创建 research.md，也不宣称进入 research 阶段。本探索将已有证据直接交给 plan.md。

README 的单文件限制用于演练内容；注入的设计节点契约另要求 DOC-FLOW 文档、进度账本及提交/发布设计 HTML。为同时满足两者，协议文档只落在本文件夹；不参与 QA criterion，不改变演练内容。设计阶段只更新 exploration.md、plan.md、progress.md、design.html 与本页两份 Mermaid 图源及本地 SVG。实现/QA 的内容改动仍只有演练 Markdown，另允许各自注入契约要求的 progress.md。没有额外 research 文档、代码、数据库或部署产物。

采用两次交付：先 AWAITING-QA，首轮故意失败产生本轮编号，再按返工提示复制编号并重验。直接沿用旧编号会掩盖演练目的；增加程序、测试文件或新存储会超出 README 范围。

## 约束与设计验收

不改 Linear 状态、评论或标签；不部署/拆除 529 房间；不调度后续节点；不请求 shipping 权限。当前设计不改目标文件。完成证据为本轮有效 APPROVED 设计评审、已推送的设计文档、已发布并通过 structured report 报给指定 Lead 的 HTML，以及 phase_design_complete 的服务端回执。完成设计阶段后保留 resident goal，等待控制器。
