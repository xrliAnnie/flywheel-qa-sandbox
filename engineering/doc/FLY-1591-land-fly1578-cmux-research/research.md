# FLY-1591 承接 FLY-1578 搁浅调研 — 调研

Issue: FLY-1591 (https://linear.app/geoforge3d/issue/FLY-1591/承接-1578-落地-14-个-lead-的-cmux-会话分组修复调研-986-行产出已完成只差写入)
日期: 2026-08-01
基于: exploration.md

---

## 1. 调研目标

搬运单的调研不是「研究 cmux 怎么修」，是**证明搬的东西是对的、完整的、没被改过**。
四个问题：

1. 两份产出（worktree / evidence 备份）是否逐字一致？以哪份为准？
2. 「986 行」这个数字对得上吗？
3. 落地路径上有没有已存在的文件会被覆盖？
4. 这份 plan 处于什么审阅状态 —— 能不能被下游误读成「已批准可实施」？

---

## 2. 两个副本的一致性（问题 1、2）

```
$ diff -q <evidence>/<f> <worktree>/engineering/doc/FLY-1578-cmux-lead-session-grouping/<f>
exploration.md  IDENTICAL
research.md     IDENTICAL
plan.md         IDENTICAL
```

三份实质产出**逐字一致**，取哪份都一样。本单以 **evidence 备份为源**
（`~/.flywheel/evidence/FLY-1578-stranded-deliverable-20260801/`）——
worktree 是活的、可能被后续动作改动，evidence 是冻结的。

行数核对：

| 文件 | 行数 |
|---|---|
| exploration.md | 222 |
| research.md | 191 |
| plan.md | 560 |
| progress.md | 13 |
| **合计** | **986** |

派工正文的「986 行」对得上：三份实质产出 973 行 + progress.md 13 行。

sha256（落地前后各核一次，见 `FLY-1578-.../LANDING-NOTE.md` §1 的表）：

```
60c790f4521a9a34b797b01bf6f41865e5548d12def55d84267bc86e02165449  exploration.md
81718d0cc89bbe7c822e61c07b591171b1d6969883fa9f62b89851b0671d30c0  research.md
a6e8a08f6f5b54b7515bae268581a6a2f5ac5aa652daa2476ce0aacdc3cfe365  plan.md
```

## 3. 落地路径无碰撞（问题 3）

```
$ ls engineering/doc/ | grep -iE 'FLY-(1578|1580|1587|1591)'
FLY-1587-design-errata-landing
```

`engineering/doc/FLY-1578-cmux-lead-session-grouping/` 在 main 上**不存在** ——
本 PR 是纯新增，不覆盖任何既有文件。

`git worktree list` 也确认 `~/Dev/flywheel-FLY-1578` 那个 worktree 仍在
（`6f812646 [flywheel-FLY-1578]`），产出没有因为清理而丢失 —— 但它一天都没进过 git，
这正是本单存在的理由。

## 4. plan 的真实审阅状态（问题 4 —— 最容易出事的一条）

`plan.md` §17.1 的原话：

> 五轮 Codex design review（xhigh），**34 项 findings 全部接受、零驳回**，仍是 `CHANGES REQUESTED`。
> **没有伪造 APPROVED，也没有写 gate 结果文件。**

⇒ **这份 plan 不是可施工的实施计划。** 它的 v6 定位是
「交付诊断 + 已验证的方案形态 + 精确的实现前置条件」。

风险很具体：文件名叫 `plan.md`、躺在 doc-flow 的标准位置，
下游节点很容易当成 `/implement` 的输入。§17 藏在 560 行的尾部，不会被先读到。

**处置**：在同文件夹加一页 `LANDING-NOTE.md`，把「未 APPROVED」「未闭合项在 §17.2」
「可直接用的部分在 §17.4」提到最前面。原件一个字不改 —— 警示写在旁边，不写进正文。

## 5. §17.2 的七项未闭合项都不是措辞问题

R5 的结论值得在这里复述一遍，因为它决定了下一单该派给谁：

| # | 阻塞项 | 性质 |
|---|---|---|
| R5#2 | `_inventory_upsert` 的 `mkdir .lock` → `mv` → `rmdir`，SIGKILL 落中间留 stale lock，之后每次 M4/M6 与 `reconcile_keeper_inventory()` 永久失败 | 既有基建缺陷 |
| R5#6 | M7 委派的 construction recovery **没有驱动者**，crash 后两侧互相挡住 | 真死锁 |
| R5#5 | `handoff_to_reconcile` 没证明外部状态已到 watcher 可安全接管点，反例可完整复现原始死锁 | 需可执行 settlement predicate |
| R5#1 | M8 把 `create_workspace_for_window` 当单一 effect，内部仍有崩溃窗；且它会调 `self_heal_workspace_ref()` 打字，违反「verify 纯只读」 | 需 workspace construction 子 WAL |
| R5#3 | M3/M5/C3b 的恢复证据弱于 exact known effect transform | 需逐 effect 定义允许变化的字段 |
| R5#4 | C0–C5 按 first-match 实现时 C5 不可达 | 需改分阶段矩阵 |
| R5#7 | G3 的「实证短 ref 同代次不复用」不可证伪 | 拿不到稳定 API 合同就 block migration |

⇒ **下一单不是「继续写 FLY-1578 的 plan」**，而是 §17.3 那个 S0 spike：
先问有没有非破坏性解法（不关 workspace，逐个 `unlink-window`）。
可行就绕开上面整张表；不可行再按顺序补基建。

## 6. 先例形态比对（FLY-1587 / PR #745）

```
engineering/doc/FLY-1587-design-errata-landing/
├── exploration.md / research.md / plan.md / progress.md   ← 它自己的
├── three-hunk-check.sh                                     ← 它自己的验尺工具
└── upstream-FLY-1580/{WHY-THIS-EXISTS.txt,exploration,plan,progress,research}.md
```

FLY-1587 **有主交付物**（`doc/messaging-rework/design.md` 两处更正，实质 2 hunk），
上游 FLY-1580 的文档对它是**参考材料** —— 所以进 `upstream-` 子目录合理。

本单没有主交付物，搬运就是全部。照抄那个形态会把 FLY-1578 的文档
钉在一个与 doc-flow 约定冲突的二等路径上。**先例不同形，不照搬**（决策见 exploration.md §4）。
