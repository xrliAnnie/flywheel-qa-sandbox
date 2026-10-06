# FLY-3224 真 Runner 通用演练（529 房间） — 探索
Issue: FLY-3224 (https://linear.app/geoforge3d/issue/FLY-3224/qa-sbx-fly-3224-real-runner-generalized-drill-529-room-only)
日期: 2026-10-06
基于: 无

## 当前证据

这是 `xrliAnnie/flywheel-qa-sandbox` 内的文档演练。本轮 run：`32e818f1-8770-4c3b-a036-ff762def687e`；设计 exec：`533d28a3-f535-41fc-b433-dfa3d672a373`。已取得 `yours phase=design epoch=1 node=eng_design attempt=1`；activation：`activation:533d28a3-f535-41fc-b433-dfa3d672a373:32e818f1-8770-4c3b-a036-ff762def687e:eng_design:1`。

- 取得 TURN 时分支落后新鲜 main `4b5f79840db9b24a9dead95680c582e7ce96a213`（只差 FLY-3225 文档），已做技术同步合并，未改演练内容。已逐条读取 `origin/main:qa-sbx/fly3224/README.md`，blob 为 `c4a1b3334b84d73b95cf4e2943c2c8f1474aef87`。
- 当前分支：`project-slot-2-FLY-3224`；演练文件：`qa-sbx/fly3224/project-slot-2-FLY-3224.md`。分支上继承的两行是 `QA-SBX FLY-3224 drill` / `AWAITING-QA`（上一轮首次交付的内容）；main 上仍是历史 `FIXED-FOR-CLAIM 1`，这个 1 不能当作本轮 QA 编号。
- 当前分支已有 OPEN PR #628（上一轮 run 018f025a 的首次交付，未合并，头 `bb791d72`）。原有 progress.md 属于上一轮；本轮复用该 PR，本轮进度重新绑定执行身份，历史 PR 与账本指针不代表本轮交付。后续实现需重新检查 PR 状态，不能沿用旧评审、旧 CI 或旧账本。
- 已读取 CLAUDE.md、项目声明的 onboarding、产品体验规范及架构概览。仓库配置中的旧 `test-slot-4` 身份不覆盖注入的 `test-slot-2` 和上述执行身份；不改配置，不访问生产存储。

## 方案与调研结论

采用 README 规定的两次交付：首次写 `AWAITING-QA`，首轮验收故意失败产生本轮编号；返工只写该编号，再独立重验。直接保留历史编号会跳过演练目的；增加程序、数据库、测试套件或部署会超出范围。

README 明确 “one short plan is enough. No research document.”，因此将本地调研结论写在本探索和 plan.md 内，不新增 research.md，也不进入无实际工作的 research 阶段。无需外部研究。

README 的单文件范围约束演练内容；注入的设计节点契约另外强制 DOC-FLOW、progress 账本和 founder HTML。此前轮次的范围问题回复已重申 README，并要求未覆盖事项取保守方案、在交付中说明，没有授予额外实现权限；本轮 README 写明不问 Lead，因此沿用该保守结论。因此仅复用本文件夹内已有的 exploration.md、plan.md、progress.md、design.html 与两份 Mermaid 图源、SVG 完成强制协议交付，不扩展演练内容或 QA criterion。设计阶段不修改演练文件；任何后续裁定由当时的 TURN 持有者处理。

## 边界与完成证据

不改 Linear 状态、评论或标签，不部署/拆除 529 房间，不改代码、表、查询或索引，不调度后继节点，不请求 shipping 权限，不合并 PR。下一节点的身份和能力以它自己的注入任务和 TURN 为准。

设计完成需本轮服务端有效 APPROVED、设计产物提交并普通推送、强制 HTML 成功发布并通过指定 structured report 回报，以及 `phase_design_complete` 回执。随后 park，保留 resident goal；阶段交棒不是整单完成。
