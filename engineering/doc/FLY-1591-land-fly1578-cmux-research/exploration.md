# FLY-1591 承接 FLY-1578 搁浅调研 — 探索

Issue: FLY-1591 (https://linear.app/geoforge3d/issue/FLY-1591/承接-1578-落地-14-个-lead-的-cmux-会话分组修复调研-986-行产出已完成只差写入)
日期: 2026-08-01
基于: 无

---

## 1. 这单的边界

**只做一件事：把 FLY-1578 已经完成的 986 行产出落地成 PR。**

明确不做：
- 不重做调研（派工正文原话：「不重做调研」）
- 不实现 cmux 分组修复本身
- 不 merge / 不 ship —— founder 的门

## 2. 为什么会有这一单

FLY-1578 的 runner 自述「已完成，无待办」，但产出进不了 git。

`~/.flywheel/evidence/FLY-1578-stranded-deliverable-20260801/WHY-THIS-EXISTS.txt` 记的现场：

```
2026-08-01 02:47:12  session completed / design_review · edge → founder_gate · 无 PR
分支有 5 个提交,但全部是 chore(progress),只动 progress.md 共 13 行。
真正的交付 (exploration / plan / research) 全部【未被 git 跟踪】。

⚠️ 比零提交更阴:分支上有提交,粗看会以为它干了活。
判据应为「有没有非 progress 的实质提交」,不是「有没有提交」。
```

同族搁浅：FLY-1579 / FLY-1580；缺陷记录见 FLY-1584。
FLY-1580 已由 FLY-1587（PR #745）承接落地，是本单的先例。

## 3. 写权限这一层已经不需要覆盖了

派工正文提醒「必须照抄 FLY-1587 那个写权限覆盖，否则会再次搁浅」，
并注明「PR #748 修好 generic 能力位并合并之后，这条覆盖就不再必要」。

**核过：PR #748 已经在 main 上**（`2ed08e54 feat: give generic nodes the capabilities to land their work`，
本分支的 merge-base 之内）。本节点开工时 Write / Edit / Bash 全部可用，
文件确实写进了工作树 —— 不是靠 dispatch 覆盖，是能力位本身修好了。

所以本单**没有依赖**那条覆盖，也不需要它。

## 4. 唯一需要判断的事：文档落在哪个路径

两个候选：

| 方案 | 形态 | 取舍 |
|---|---|---|
| A. 落在 `engineering/doc/FLY-1578-cmux-lead-session-grouping/` | 原件的 doc-flow 规范位 | 文件抬头本来就写 `Issue: FLY-1578`；将来谁接 FLY-1578，在约定路径直接找得到 |
| B. 落在 `engineering/doc/FLY-1591-*/upstream-FLY-1578/` | 抄 FLY-1587 先例 | 先例成立是因为 FLY-1587 **本身有主交付物**（design.md 两处更正），上游文档对它是**参考材料** |

**选 A。** FLY-1591 除了搬运没有别的交付物，把 FLY-1578 的文档塞进 FLY-1591 的子目录
会让它落在一个与 doc-flow 约定（`<ISSUE>-<slug>/`）冲突的二等位置。
FLY-1587 的形态与本单不同形，先例不照搬。

代价：本单自己的 doc-flow 文件夹（就是这里）只装落地记录，不装 cmux 内容。可接受。
