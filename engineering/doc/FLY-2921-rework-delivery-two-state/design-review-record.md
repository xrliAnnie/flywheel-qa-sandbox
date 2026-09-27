# FLY-2921 返工投递收成两态 — 设计评审记录
Issue: FLY-2921 (https://linear.app/geoforge3d/issue/FLY-2921/病根修复-6-返工投递收成两态送达-失败交还-lead投给死体改投替身不再把整条-run-打-held6-张-46)
日期: 2026-09-27
基于: plan.md

有效评审：Codex `gpt-6-astra` xhigh（Bridge design-review manifest 指定），线程 `01a0e3ea-955a-7753-bb33-98d4a4589a33`。每轮都在评审后立即用 `flywheel-comm review-round design` 写回 Bridge（model 与 required 均匹配）。

| 轮次 | Bridge requestId / plan blob | 结论 | 处理 | 原文 |
|---|---|---|---|---|
| R1 | `27b5088c` / `6eef82bb` | CHANGES REQUESTED：1 BLOCKER、1 MAJOR | #1 `three_stage_turn_stuck → freezeWorkflowDelivery` 绕过 C4 冻 run → 新增 C4.7 冻结入口归属守卫；#2 Lead 重投时准入前替身无可执行出口 → C2 b 拆准入前 / 准入后 | codex-review-r1.md |
| R2 | `a339a33f` / `fec4fd3c` | CHANGES REQUESTED：1 MAJOR（R1 #1 关闭） | 准入前放弃与换体分两笔事务留有迟到准入窗口 → 合成 `replaceWorkflowReworkActor` 同一事务 + 持久取消围栏 + 两种顺序与崩溃注入测试 | codex-review-r2.md |
| R3 | `c8aea457` / `40b219ea` | CHANGES REQUESTED：1 MAJOR（R2 #1 关闭） | R2 新加的准入守卫过宽会误拒 wake 模式活体返工 → 收窄为精确取消围栏 / 明确 `abandoned`，补正向对照 | codex-review-r3.md |
| R4 | `75da1970` / `cc13d895` | **APPROVED**（无新增问题） | Bridge `await-codex-gate design` 通过（turn `01a0e3fe-0fd2-7740-9dbe-f05204b1977a`） | codex-review-r4.md |

- Codex 批准的 plan blob 是 `cc13d8951eda1bfb5e1b5ca9fba1c3ca0f72ceea`（提交 `347554621`）。批准之后 plan.md **不再改动**；R4 结论记在本文件，不回写 plan §10。
- 每轮 Codex 都以只读方式对照主仓基线 `d52df7841` 核验（本沙箱不含相关源码），未修改主仓、未运行测试。
- **给实现体的提示**（R2 #1）：主仓实现头 `5357dd5c` 的 `abandonUnadmittedReworkReplacementLaunch` 与 `replaceActor` 是两笔事务，存在 R2 指出的迟到准入窗口；应按 plan C2 b 合并为一笔（或补围栏 + 精确准入检查）并加两种顺序的竞争测试。
- 本机 Codex 账号：评审跑在 `shopping` profile（Plus），未撞额度。
