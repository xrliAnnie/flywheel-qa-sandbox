# Flywheel 里程碑账本 — 一 issue 一文件

Issue: FLY-2045 (https://linear.app/geoforge3d/issue/FLY-2045/repo流程-claudemd-里程碑表顶部插入-并行-pr-100percent-互斥每合一单全舰-dirty分支失去-ci-能力8-25)
日期: 2026-08-25
基于: engineering/doc/FLY-2045-milestone-table-conflict/plan.md

## 为什么不是一张表

里程碑本来是 `CLAUDE.md` 里的一张表,每个 PR 往**表头正下方**插一行。
两个并行分支从同一个 base 切出来,就都在**同一个 hunk 的同一位置**做加性修改 ——
git 无法自动决定谁在上,所以**冲突率是 100%,不是偶尔**。

而 PR 一旦冲突,GitHub 算不出 merge commit,`pull_request` 工作流**根本不排队**,
分支**失去 CI 能力**。于是每合一单,其余所有在飞分支同时进入「不可测量」状态。

现在改成一 issue 一文件:两个 PR 各新建一个**不同路径**的文件。
这不是「冲突概率低」,是**没有可冲突的对象**。

> 实测顺带否掉了一个看起来更省事的做法:**追加到表底部同样 100% 冲突**
> —— 两边都在 EOF 追加,与顶部插入完全同构,与「是否同刻」无关。
> `engineering/doc/FLY-2045-milestone-table-conflict/merge-evidence.md` 有原始输出。

## 怎么加一条

ship 时新建一个文件,**不要改 `CLAUDE.md`**:

```
engineering/doc/milestones/<ID>.md
```

文件名规则(守卫会检查,与 `scripts/__tests__/fly2045-milestone-layout.test.sh` 的 G5 一致):

```
^(FLY|GEO)-[0-9]+\.md$
```

`GEO-` 也接受不是历史包袱:Flywheel 自己的历史 issue 有一部分就在 GEO team 下,
`orchestrator.md` 的 `ISSUE_ID` 也明确写了 `FLY-{XX}` **或** `GEO-{XX}`。
只认 `FLY-` 会让 GEO 单要么被守卫拒、要么退回去改旧表 —— 两条都破坏这里的保证。

内容格式:

```markdown
# <ID> — <短标题>

**Status**: ⏳ Pending ship
**PR**: #NNN
**Date**: YYYY-MM-DD

<正文:原先写在 Milestone 列里的那一段>
```

`Status` 用 `✅` / `⏳` / `⛔` / `⚠️` / `↪` 之一开头,后面跟空格和正文。

## <a id="FLY-2045-SINGLE-WRITER"></a>单写者合同(FLY-2045-SINGLE-WRITER)

**一个 issue 的里程碑文件,只由该 issue 自己的 ship PR 写。**

- **owner** = 该 issue 的 ship PR;
- **primary creator** = executor(在 PR 的最后一个 commit 里建);
- `orchestrator.md` 的 A0 是**不覆盖的 last-mile ensure**:base 里已有 ⇒ fail(canonical ID 撞车);
  本分支自己刚加的 ⇒ 校验后 handoff,**绝不覆盖**;两者皆无 ⇒ 补建并 `git add`。

**状态更新**(`⏳ Pending ship` → `✅ Merged (PR #NNN)`)也只能由该 issue 自己的后续 PR 串行做。
**不要在你的 PR 里顺手改别人的里程碑文件** —— 那会把冲突面重新引回来。

**唯一的例外是 FLY-2045 自己的 cutover PR**,而且它已经用完了:cutover 当天 `origin/main` 上有两条
里程碑(FLY-2026 / FLY-2027)是在这套机制存在**之前**由旧表合入的,它们的 ship PR 不可能建这个文件,
所以由 cutover PR 代建 `FLY-2026.md` / `FLY-2027.md`。**这不是先例** —— 此后任何「替别人建/改里程碑
文件」都按上面的合同走人工。

## 三种**不**保证无冲突的情况

「冲突为零」的成立域是:**不同 canonical issue ID 的里程碑记账**。以下三种要走人工:

| 情况 | 结果 |
| -- | -- |
| 同一个 issue 的两个 PR 各建同名文件 | add/add 冲突 —— 人工合并,不自动改名 |
| 同一个文件的并发 status 更新 | 冲突 —— 见上面的单写者合同 |
| revert 之后重加 / 改已归档文件 | add/add 或 modify/delete —— 历史文件默认 immutable |

## 历史在哪

FLY-2045 之前的 179 条在 `ARCHIVE-pre-FLY-2045.md`,**逐字节冻结**,两个哨兵之间有
sha256 + 字节数双 pin。那个文件不再接受新条目,也不要「顺手修好」它的格式。

「179 条」是 **cutover 时刻 `origin/main` 的表**,不是搬迁草稿开始时的那张(那时是 177 条)。
搬迁进行中 founder 又合了两单,旧表又多了两行 —— pin 的权威始终是 **source**,所以以合入时刻的
`origin/main` 重新派生。这两行同时在 `FLY-2026.md` / `FLY-2027.md` 里有活入口。
