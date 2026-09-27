# FLY-2922 held 后统一恢复口 · 沙箱重派 — 探索
Issue: FLY-2922 (https://linear.app/geoforge3d/issue/FLY-2922/病根修复-8-held-回滚之后有出口只留一个统一恢复口放行必须真铸出派发关死体不连带终结-run9-张-37)
日期: 2026-09-27
基于: 无

## 这一轮 design 节点面对的真实情况

本 run（`5928c374-0a57-4dc3-adcb-078d2d9a07c4`，模板 `tpl_code`：eng_design → implement → qa → founder_gate → land）跑在 QA 沙箱 slot-2，仓库是 `xrliAnnie/flywheel-qa-sandbox`，工作分支 `project-slot-2-FLY-2922` 起点 = 沙箱 `origin/main@1855f7a1a`。

审计结论（详见 research.md）：

- 沙箱 main 里**没有**工作流 hold / recovery 子系统，没有 `StateStore` 的 workflow held 状态机、没有 dispatcher 账本；issue 描述的 9 张原单在这棵树上无法构造。
- FLY-2922 的完整设计已在生产仓完成并批准（gate `d9ab4f85`，计划提交 `c4d40fbed`，plan.md SHA-256 `7de9bef9…a1c5`；FLY-2921 合同补充 scoped gate `0f29f815` APPROVED），实现也已完成：分支 `flywheel-FLY-2922` 头 `2dd29e0276617cf21e31ce4bfe2a4df792d8cf0a`，同头代码复审 `92e28887` APPROVED（Lead 交接 2026-09-27 05:1x PDT）。该分支已镜像到沙箱 origin（`origin/flywheel-FLY-2922` 同一 SHA）。
- Lead 最新交接只要求一件事：拉分支核对头 = `2dd29e027`、树干净，然后直接 `complete --route needs_review` 交卷进 QA；⛔不改代码、不跑本地测试、不等 Lead。
- 但本 run 被重派到 eng_design 起步，design 节点不能替 implement 节点交卷，也不能跳过设计阶段的门与交付物。

所以本轮的设计对象不是「再设计一次 held 恢复」，而是把 **implement 节点要做的那一件事** 写成可机器核验、可照抄执行的合同，让后继节点在沙箱里也能按 Lead 原话完成，并让 QA 拿到明确的判据。

## 候选与取舍

| 方案 | 结果 | 处置 |
|---|---|---|
| 在沙箱 main 上重新设计并实现 held 恢复 | 沙箱树没有该子系统，属于重做 16k 文件量级的生产工作；与 Lead「⛔不重新设计、不重做已完成部分」直接冲突 | 拒绝 |
| 把生产分支的 exploration/research/plan 原样拷进本分支充当本轮交付 | 内容真但对本 run 无新增合同，且会产生与镜像分支重复的 doc 树；评审者无法从中得到「implement 节点具体做什么」 | 拒绝作为主交付；仅引用其 SHA/ID |
| **verify-then-submit 合同**：implement 节点只做机器核验（镜像头、树净、复审 ID、基线树）+ 交卷；QA 节点拿 Lead 给的三条判据 | 与 Lead 交接逐字一致；零代码改动；每条断言可照抄跑；失败路径明确 ask + 停 | **选择** |

## 不变量

- 已批准设计正文与已复审的实现头一个字节都不改：本轮所有文档只在 `engineering/doc/FLY-2922-unified-node-recovery/` 下新增，不触碰 `packages/`。
- 交卷引用的头必须是完整 40 位 SHA `2dd29e0276617cf21e31ce4bfe2a4df792d8cf0a`，核对对象是**镜像分支、生产 checkout、GitHub 远端三处**，任一不等即停；生产 checkout 只读（不 fetch）。
- 不伪造 PR、不在沙箱开一个「假装能合」的 PR：`origin/flywheel-FLY-2922` 与沙箱 main 的 `merge-tree` 冲突（两棵不同的树），这是已知事实，写进 QA 边界而不是掩盖。
- 沙箱 design 节点自身的硬门（design_review 绑定、Codex 评审、founder HTML、publish、report、`phase_design_complete`）一个都不跳。

## 未决事项（非阻塞）

问 Lead `0d73b791-401b-40a3-b14a-68207eecfd03`：① implement 交卷的 PR 证据用生产 PR #1374 还是要在沙箱另开 PR；② QA 节点在沙箱要验什么。无答复时按 ① = Lane A：交卷不传 `--pr`（R1 评审证实 `complete` 的 `--target-repo`/`--declare-pr` 不能指向沙箱 worktree 之外，生产 checkout 绑不进 completion 证据），生产 PR #1374 与复审 ID 写进 DONE 报告；② = Lead 交接原文三条判据写入 plan，full CI 取证放到生产仓上下文。slot-4 上一具 design 体的同类问题 `d26e7f85` 同样无答复，本轮不重复提问。
