# FLY-1578 cmux 会话分组 — 落地说明（读正文之前先读这页）

Issue: FLY-1578 (https://linear.app/geoforge3d/issue/FLY-1578/运维修复-14-个-lead-的-cmux-会话被-group-在一起-每个-lead-看到的是别人的窗口)
日期: 2026-08-01
基于: 无（本页由 FLY-1591 承接单写，正文四份文档为 FLY-1578 原件逐字保全）

---

## 1. 这个文件夹是怎么来的

FLY-1578 的 runner 把调研做完了（986 行：exploration / research / plan / progress），
但它的 run 走的是**无写权限**的设计节点，产出留在 worktree 里**从未被 git 跟踪**，
分支上只有 5 个 `chore(progress)` 提交、没有 PR。

FLY-1591 承接单只做一件事：**把那份已完成的产出搬进 git，一个字不改。**
调研没有重做，结论没有改写，措辞没有润色。

逐字保全的四份原件：

| 文件 | 行数 | sha256（落地时核过，与 evidence 备份逐字一致） |
|---|---|---|
| `exploration.md` | 222 | `60c790f4521a9a34b797b01bf6f41865e5548d12def55d84267bc86e02165449` |
| `research.md` | 191 | `81718d0cc89bbe7c822e61c07b591171b1d6969883fa9f62b89851b0671d30c0` |
| `plan.md` | 560 | `a6e8a08f6f5b54b7515bae268581a6a2f5ac5aa652daa2476ce0aacdc3cfe365` |
| `progress.md` | 13 | （FLY-1578 run 的原始游标，记录它停在哪、为什么停） |

备份来源：`~/.flywheel/evidence/FLY-1578-stranded-deliverable-20260801/`

---

## 2. ⚠️ plan.md **不是** 已批准的实施计划

这一条必须先说清楚，否则很容易误读成「可以直接 /implement」。

- Codex design review 跑了 **5 轮（xhigh）**，34 项 findings **全部接受、零驳回**，
  但**终局仍是 `CHANGES REQUESTED`**，没有到零 finding。
- 原 runner **没有伪造 APPROVED**，也没有写 gate 结果文件 —— 这一点它做得对。
- plan.md 的 v6 定位是：**交付诊断 + 已验证的方案形态 + 精确的实现前置条件**，
  不是「照着做就能落地」的施工图。

**未闭合项的完整清单在 `plan.md` §17.2**（R5#1–R5#7，七条），
每一条都已经从「本 plan 的措辞问题」下沉到**既有共享基建的缺陷**
（keeper inventory writer 的 stale lock、construction recovery 无驱动者、
settlement predicate 缺失、workspace construction 子 WAL、逐 effect 证据、
C0–C5 分类器不可达分支、G3 不可证伪）。

---

## 3. 拿了就能用的部分（不依赖上述任何前置）

`plan.md` §17.4 已经诚实划过线，摘要在这里：

- **§1 根因诊断** —— 完整、有铁证、独立复核过（含 belle-lead 健康对照组）。
  一句话：*巡检每 ~60 秒正确抓到「这个 Lead 看得见别人的窗口」，但因为一个自锁的授权条件永远不动手。*
- **§2 三条红线** —— 每条都有仓库里的哨兵测试或生产实证撑着，任何方案都必须尊重。
- **§6 B1/B3、§8.1 mock 模型、§9 删回滚拉杆** —— 与迁移路径解耦，可独立推进。
- **§4.3 三个 gate** —— 走哪条路都需要。

---

## 4. 下一个节点最高杠杆的问题（`plan.md` §17.3）

原 runner 留下的建议，值得原样转达：

> **S0 spike 应该先回答一个此前没问过的问题：有没有非破坏性的解法？**
> 能否在**不关闭 cmux workspace**、也不 kill 会话的前提下，把一个 grouped view
> 变成只看得见自己那一个窗口（例如把该 view 里其余窗口逐个 `unlink-window`）？

- 可行 → §5 整段（manifest / 迁移 WAL / close / rebuild / 全部崩溃安全面）大部分可以不做，本单回到一个小改动。
- 不可行 → 记录 tmux 侧的确切限制，再按 §17.2 的顺序补前置基建。

原文明确标注：**这是待验证的假设，不是结论** —— 原 runner 没有验证这条路。

---

## 5. 本单没做什么

- 没有实现任何修复。FLY-1578 描述的故障（13 个 Lead 的 cmux view 仍然 grouped）**依旧存在**。
- 没有重跑 design review，没有把 `CHANGES REQUESTED` 改成别的状态。
- 没有动 `scripts/flywheel-cmux-sync.sh` 或任何生产代码 —— 本 PR 零代码改动。
