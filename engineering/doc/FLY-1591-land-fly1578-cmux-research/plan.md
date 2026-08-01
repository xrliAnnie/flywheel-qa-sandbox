# FLY-1591 承接 FLY-1578 搁浅调研 — 实施计划

Issue: FLY-1591 (https://linear.app/geoforge3d/issue/FLY-1591/承接-1578-落地-14-个-lead-的-cmux-会话分组修复调研-986-行产出已完成只差写入)
日期: 2026-08-01
基于: exploration.md, research.md

---

## 0. 一句话

**把 FLY-1578 的 986 行产出逐字搬进 git，加一页防误读的落地说明，开 PR，停在 founder 的门前。零代码改动。**

## 1. 变更清单

| # | 路径 | 动作 | 内容 |
|---|---|---|---|
| 1 | `engineering/doc/FLY-1578-cmux-lead-session-grouping/exploration.md` | 新增 | FLY-1578 原件，**逐字** 222 行 |
| 2 | `engineering/doc/FLY-1578-cmux-lead-session-grouping/research.md` | 新增 | FLY-1578 原件，**逐字** 191 行 |
| 3 | `engineering/doc/FLY-1578-cmux-lead-session-grouping/plan.md` | 新增 | FLY-1578 原件，**逐字** 560 行 |
| 4 | `engineering/doc/FLY-1578-cmux-lead-session-grouping/progress.md` | 新增 | FLY-1578 原始游标，**逐字** 13 行 |
| 5 | `engineering/doc/FLY-1578-cmux-lead-session-grouping/LANDING-NOTE.md` | 新增 | 本单写的防误读页（provenance + 未 APPROVED 警示 + §17 导航） |
| 6 | `engineering/doc/FLY-1591-land-fly1578-cmux-research/{exploration,research,plan,progress}.md` | 新增 | 本单的 doc-flow 记录 |

**1–4 项一个字节都不改。** 5–6 项是本单新写的。

`engineering/doc/FLY-1578-*` 在 main 上不存在（research.md §3 已核），纯新增无覆盖。

## 2. 明确不做

- **不实现 cmux 分组修复**。FLY-1578 的故障（13 个 Lead 的 view 仍 grouped）本单跑完依旧存在。
- **不重做调研**（派工正文原话）。不重跑 design review，不动那个 `CHANGES REQUESTED`。
- **不改任何生产代码**。`scripts/flywheel-cmux-sync.sh` 一行不碰。
- **不 merge / 不 ship** —— founder 的门。PR 开完就停。
- 不清理 `~/Dev/flywheel-FLY-1578` worktree 或它的分支 —— 不在授权范围。

## 3. 执行顺序

1. 从 evidence 备份（冻结源）复制四份原件到目标路径
2. `cmp` 逐文件核对拷贝后仍逐字一致 ✅（已跑，四个 OK）
3. 写 `LANDING-NOTE.md` + 本单三份 doc-flow 文档
4. `git add` **显式路径**（禁 `git add -A` / `git add .` —— 现场有 `=` 空文件等杂物）
5. commit（Conventional Commit）→ push → `gh pr create`
6. `flywheel-comm complete --route needs_review --pr <N>`

## 4. 验收标准

| # | 标准 | 判据 |
|---|---|---|
| ① | 产出进 git，开出 PR | `git show --stat` 列出 986 行原件 + PR URL |
| ② | 内容与 evidence 备份逐字一致 | `git show HEAD:<path> \| cmp - <evidence>/<f>` 四份全过 |
| ③ | merge / ship 不动 | 本节点不点 `:cool:`、不 `gh pr merge` |
| ④ | 下游不会把 plan.md 误读成已批准 | `LANDING-NOTE.md` 与 plan.md 同目录，§2 首屏就写「不是已批准的实施计划」；PR 正文**开头第一个块**是同内容的警示 |

验收② 的核法**必须从 git 对象读**（`git show HEAD:<path>`），不能核工作树文件 ——
工作树对得上只证明拷贝对了，git 里存的才是 PR 里的东西。

## 5. 风险

| 风险 | 处置 |
|---|---|
| 搬运时手滑改了原件（换行、编码、trailing space） | 验收② 用 `cmp` 而非 `diff` 眼看；且从 git 对象读 |
| 下游把 `plan.md` 当施工图 → 撞上 §17.2 七项基建缺陷 | `LANDING-NOTE.md`；且本 PR 正文开头第一个块是「⚠️ 先读这条」警示，写明未 APPROVED |
| `git add -A` 把现场杂物（`=`、`memory.db`）混进 PR | 只用显式路径 add，push 前 `git show --stat` 复核文件清单 |
| 落地路径与将来接手 FLY-1578 的节点冲突 | 选的就是 doc-flow 约定位 `<ISSUE>-<slug>/`，接手节点直接 REUSE 这个文件夹即可 |

## 6. 交给下一个节点的东西

本单落地之后，FLY-1578 的下一步**不是**继续写它的 plan，而是 `plan.md` §17.3 的 S0 spike：

> 有没有非破坏性的解法？能否不关 cmux workspace、不 kill 会话，
> 把 grouped view 变成只看得见自己那一个窗口（逐个 `unlink-window`）？

可行 → §5 整段崩溃安全面大部分不做，回到一个小改动。
不可行 → 记录 tmux 侧确切限制，再按 §17.2 顺序补前置基建。
