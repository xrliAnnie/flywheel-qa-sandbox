# FLY-2248 通用投递合同 — 设计更正
Issue: FLY-2248
日期: 2026-09-02
基于: plan.md

## 权威与生效范围

`plan.md` 是已通过设计审查并固定的历史设计，不再改写。Lead Tadashi 于 2026-09-02 在实现期批准范围
更正：本 PR 只交付 M1 通用欠条生命周期、超时升级，以及已经接入的 carrier completion 安全核销缝；
M2 转移/改派与 M4 冻结正门整体移交 FLY-2278。M3 工人常驻收信仍由 FLY-2268 承接。

## 废除概念

- 废除“本 PR 同时交付 M1、M2、M4”的实现期口径；它只保留在 pinned plan 中作为获批设计的历史记录。
- 废除“本 PR 回放 6 起事故”的实现期口径。本 PR 的回放床收口为 #1、#4、#6 三起。
- #2、#5、#7 随 M2/M4 移交 FLY-2278；不得把这些未交付机制记成本 PR 已通过的验收项。
- 本更正不授权重新设计机制，也不扩大当前 PR 的代码范围。

## 保留器官

- #1：通用 minted 阶段超时能够生成确定性 episode，并按 warning / severe 两级升级。
- #4：`phase_wake` 未 push 的 minted 欠条按时告警；真实 push 成功落 `first_push_at` 后进入 sent，未超期
  对照臂不告警。
- #6：runner-ship carrier completion 覆盖 `superseded_by_completion`、`carrier_delivery_settled`、缺行
  fail-closed 与事务回滚，并证明该 invariant 不作用于 `land` / `engine_terminal` authority。
- 通用 watch、projector、attempt 台账、episode 恢复、unbound durable Lead inbox 路由及 carrier completion
  seam 继续保留。

## Lead 指令原文引用

> [lead-instruction fe431494-dded-4601-8bd8-fe16da56b311] ③ plan.md §0 note: M2/M4 moved to FLY-2278, decision Lead Tadashi date 2026-09-02, replay bed 6→3 (#1/#4/#6), #2/#5/#7 transferred with M2/M4.

> [lead-instruction 980e4679-86c7-4386-8305-eb7b50c3d139] 补充(与我 fe431494 第③条一致但落点改准):pinned plan 不改。「M2/M4 决定移出→FLY-2278(Lead 决定,2026-09-02)」与「回放床 6→3(#1/#4/#6)的决定」写进同目录 design-correction.md(废除概念/保留器官/Lead 指令原文引用)+ implementation-notes.md + PR body,不动 plan.md 本体。若已改了 plan.md,还原并按此落点。

后一条指令修正前一条指令的文档落点；范围决定本身不变。
