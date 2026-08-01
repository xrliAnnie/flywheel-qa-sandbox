# FLY-1590 承接 1581 落地 generalized node 失败出口调研 — 实施计划

Issue: FLY-1590 (https://linear.app/geoforge3d/issue/FLY-1590/承接-1581-落地-generalized-node-失败出口调研-5-份文档-862-行产出已完成只差写入)
日期: 2026-08-01
基于: exploration.md / research.md

## 0. 一句话

把 FLY-1581 已完成的五份文档(865 行)从 Lead 的 evidence 备份搬进 git 并开 PR。
**零生产代码改动,零内容改写。**

## 1. 改动清单

| # | 动作 | 路径 |
| - | -- | -- |
| 1 | 五份文档逐字落地 | `engineering/doc/FLY-1581-generalized-node-failure-exit/preserved-by-FLY-1590/{exploration,research,plan,follow-ups,progress}.md` |
| 2 | 落地来源说明 | `.../preserved-by-FLY-1590/LANDED-BY-FLY-1590.txt` |
| 3 | 目录首屏指路 + 「只有一代」裁定 | `engineering/doc/FLY-1581-generalized-node-failure-exit/README.md` |
| 4 | 本单 doc-flow 过程文档 | `engineering/doc/FLY-1590-land-1581-deliverables/{exploration,research,plan,progress}.md` |

**路径选择的理由见 `exploration.md §3`**:落 canonical 的 `FLY-1581-*/`(未来实施
节点会按 `ls engineering/doc/ | grep FLY-1581` 找),但快照封进
`preserved-by-FLY-1590/` 子目录 —— 因为 **FLY-1581 已被重新 dispatch,新 runner
正在往同一目录的同名文件写第二代内容**(Codex R1 HIGH 查出,`research.md §1.3b`)。
占用根目录文件名会让两代撞成 **add/add conflict**:git 拒绝自动合并、必须人工
resolution,选错边就丢掉这份 865 行的调研。换落点是为了**不让这次取舍发生在
merge 现场**。

`packages/` 零改动。`doc/` 零改动。

## 2. 逐字保真怎么保证

1. **源选 evidence 备份**,不选 worktree —— worktree 的第一代内容在落地当时已被
   回收(`research.md §1.3`)。**reset 那一刻备份是仅存的一份**,也是这份内容的
   **唯一独立恢复来源**。
2. **落地前** `diff -r` 对过 worktree vs evidence:零内容差异(00:52,worktree
   尚存活)。
3. **落地后** 五份逐份 SHA256 核对 evidence:全相等(`research.md §1.4`)。
4. **不采用** evidence 侧那两个 `*.STALE-*.bak` 中间态 —— FLY-1581 runner 自己
   标注「旧 plan.md 少 37 行且残留已撤销的 PR-B 方案,照它实施会建错」。
5. **不修** `progress.md:3` 那条写坏的 Linear URL。搬运不是修订。

## 3. 执行顺序 —— 诚实说明:先落盘,后补过程文档

标准 doc-flow full tier 是 exploration → research → plan → design_review → 实施。
**本单倒置了:先把五份文档 commit + push,再补本单的过程文档。**

理由,以及为什么这个判断是对的:

* 本单的「实施」= 一次 `cp` + `commit`。它没有需要预先设计的技术决策 ——
  唯一的判断(路径选 A 还是 B)在读完两个候选后 30 秒内就能拍。
* 交付物**只存在于一份备份里**,且已经有一个副本在当晚蒸发过。任何拖延都是拿
  「已经死过四次的产出」赌第五次。
* 实测坐实了这个判断:**源 worktree 在本单开工后几分钟内就被 reset,第一代内容
  从磁盘消失**(reflog 记录 `00:53:59`,而本单 `00:52` 才读到它;落地源改用
  evidence 备份才没受影响,见 `research.md §1.3`)。若先花 20 分钟写过程文档再
  落盘,能否赶上是运气问题。

⇒ 过程文档的价值是**留痕**,不是**门禁**。对一个零代码、零设计决策的搬运单,
  让留痕挡在保全前面是本末倒置。此项判断已随 DONE 报告一并交 Lead 复核。

实际顺序:

```
1. diff -r 核一致性                        ✅ 00:52
2. 复制五份 + 写 LANDED 说明 + SHA256 核    ✅ 00:54
3. commit + push  ← 交付物永久保全,风险解除  ✅ 00:55
4. 补本单 exploration / research / plan     ✅
5. 开 PR
6. progress ledger + 报 Lead
```

## 4. 验收(逐条对 dispatch)

| # | dispatch 要求 | 落点 |
| - | -- | -- |
| 1 | 5 份文档进 git,开出 PR | `git log` + PR link |
| 2 | 内容与 evidence 备份逐字一致 | SHA256 五份全等(`research.md §1.4`) |
| 3 | 4 条 follow-up 草稿一并带过来,不丢 | `follow-ups.md` F1–F4 齐全(`research.md §1.2`) |
| 4 | merge / ship 不动 —— founder 的门 | 本节点 `complete --route needs_review --pr <N>`,不 merge |

## 5. 明确不做

* ❌ 实施 `preserved-by-FLY-1590/plan.md` 描述的修复 —— 那是未来实施节点的活
* ❌ 把 F1–F4 建成 Linear issue —— 不在验收里,且有 founder-facing 副作用
* ❌ 改写 / 修订 / 「顺手优化」任何一个字
* ❌ 碰 FLY-1578 / 1579 / 1580(1580 已由 1587 救回,1579 由 1586 在跑)
* ❌ merge —— founder-gated

## 6. 风险

| 风险 | 处置 |
| -- | -- |
| evidence 备份本身不是最终态 | 已核:FLY-1581 的 `progress.md` 明写「Lead 的预防性备份我已刷新到最终态,旧版另存 `*.STALE-*.bak`」;且落地前 `diff -r` 对过尚存活的 worktree,零差异 |
| **与那批同名文档抢文件名 → merge 时 add/add conflict** | **Codex R1 HIGH 查出的真实碰撞**(非理论):快照封进 `preserved-by-FLY-1590/`,不占根目录文件名。git 会拒绝自动合并而非静默覆盖,但取舍不该发生在 merge 现场。**换落点的决定在那批产物事后被裁定为未授权误派之后依然正确** —— 它规避的是一次真实冲突 |
| 未来实施节点找不到 plan.md | 仍在 canonical 前缀下,`ls engineering/doc/ \| grep FLY-1581` 可见;根目录 `README.md` 首屏指路 |
| 读者误把 plan.md 当「已完成的工作」 | 四处明写:根 `README.md` 首屏第 1 条、`LANDED-BY-FLY-1590.txt`、commit message、PR body |
| 读者误以为存在两版可比对的 FLY-1581 调研 | **原处置(摆差异、不替读者判定)已被推翻**:Lead 裁定那批是未授权误派产物、已停,**只留本 PR 这一份**。`README.md §3` 已改为明确否定,首屏第 2 条同步 |
| 过程文档倒置被读成流程违规 | §3 逐条说明,并随 DONE 报告交 Lead 复核 |
