# Design: FLY-SBX-5 — 5-Spawn Race Sandbox Fixture — FLY-136

**Issue**: FLY-136 ([Sandbox] FLY-SBX-5 — dummy issue for FLY-128 5-spawn race testing)
**Date**: 2026-07-23
**Status**: Complete
**Phase**: design (three-stage node, exec 913ec87f)

## 一句话总结

本 issue 是 QA 竞态测试的沙盒占位:设计产出 = 一次**最小 doc-only 变更**(向 sandbox 仓 README.md 追加一行带 issue 标识的记录行),用来让 FLY-128 的 5-Runner 并发 spawn 测试有真实可走的 brainstorm → PR → approve → ship 全链路。

## 背景与约束(来自 issue,scope 不可改)

- FLY-136 = FLY-SBX-5,是 FLY-124(FLY-SBX-1)的兄弟沙盒,**永久保持 open**。
- FLY-60 Hard Gate E2E QA suite / FLY-128 5-spawn Terminal race test 依赖它的 spec 稳定。
- 禁止:关闭 issue、分配真实工作、修改 scope。

## 设计决策

### 变更目标

向 sandbox 仓(`xrliAnnie/flywheel-qa-sandbox`)的 **README.md 末尾追加一行**:

```
FLY-136 (FLY-SBX-5) design-node pass — 5-spawn race fixture run, 2026-07-23
```

选 README.md 而不是 CLAUDE.md:CLAUDE.md 是所有 agent session 的注入指令面,反复追加测试行会污染后续 session 的 prompt;README.md 是惰性文档,追加零副作用。

### 冲突面(5-spawn race 关键考量)

5 个 Runner 并发跑 FLY-SBX-1..5,每个各自开 PR。若都改同一文件同一位置,后 merge 的 4 个 PR 会连环冲突,把 race test 变成 merge-conflict test。因此每个 SBX issue 的追加行**必须带自己的 issue 标识**(本 issue = `FLY-136`),行内容互不相同;追加(append)而非改写任何已有行,把冲突面压到最低(仅文件尾部同位置追加时 git 需要 rebase,不产生语义冲突)。

### 实现节点的完整步骤(handoff 合同)

1. 在本 branch(`project-slot-2-FLY-136`)向 README.md 末尾追加上面那一行(1 行 diff)。
2. commit(`docs(FLY-136): append SBX-5 race fixture line`)+ push。
3. 开 PR(base = main),PR body 链接 FLY-136。
4. `complete --route awaiting_review` 等 approve;approve 后 ship + merge。
5. 不 touch 其它文件;不写测试(doc-only,QA suite 本身就是这个变更的"测试")。

## 取舍与被否方案

| 方案 | 结论 | 理由 |
|------|------|------|
| 追加 README.md 一行(选定) | ✅ | 最小、可重复、冲突面最低、与 issue spec 逐字一致 |
| 追加 CLAUDE.md | ❌ | CLAUDE.md 是 prompt 注入面,测试行会污染后续所有 session |
| 每次跑建独立新文件 | ❌ | 偏离 issue spec("append one line to README.md or CLAUDE.md");文件数随测试次数膨胀 |
| 真实功能性变更 | ❌ | issue 明令 "Do not assign real work" |

## 诚实边界

- 本设计**只**覆盖 QA fixture 的一行追加,不为 sandbox 仓引入任何功能、测试或结构变化。
- 不解决 5-PR 并发 merge 的排队/rebase 问题——那是 FLY-128 race test 本身要观察的行为,不是本 fixture 要"修"的东西。
- issue 保持 open,本设计可被后续每轮 race test 重复复用(仅日期/行内容随轮次变化)。
