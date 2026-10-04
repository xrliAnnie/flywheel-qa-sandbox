# FLY-3225 真 runner 通用演练 — 实施计划
Issue: FLY-3225 (https://linear.app/geoforge3d/issue/FLY-3225/qa-sbx-fly-3225-real-runner-generalized-drill-529-room-only)
日期: 2026-10-03
基于: 无（上游只有沙盒仓库 main 分支上的 `qa-sbx/fly3225/README.md`，它就是这张练习单的全部任务书）

## 1. 目标与边界

这是 529 QA 房间专用的**练习单**：没有产品代码，只验证「真 runner 从设计→实现→QA 打回→修复重交」这条链路能走通。

- 唯一允许的改动：新建一个 markdown 文件 `qa-sbx/fly3225/project-slot-3-FLY-3225.md`（文件名 = `git branch --show-current` 的结果）。
- 不碰 Linear issue（不改状态、不评论、不加 label）。
- 不在演练内部署任何 QA 房间（529 room）。
- 不写研究文档（README 明确：一份短 plan 就够）；因此本文件夹只有 `plan.md`、`progress.md` 和给创始人看的设计 HTML。
- 本房间没有人类 Lead：一切信息都在 README 里，**不向 Lead 提问**、不等待人工答复；确有疑问时由演练驱动器（drill driver）按 README 的规则作答。

## 2. 实施步骤（给 implement 节点）

1. 读 `qa-sbx/fly3225/README.md`（沙盒仓库 main 分支）确认规则没变。
2. `git branch --show-current` 取分支名，创建 `qa-sbx/fly3225/<分支名>.md`，**恰好两行**：
   - 第 1 行：`QA-SBX FLY-3225 drill`
   - 第 2 行：首轮写 `AWAITING-QA`。
3. 若 prompt 带 `QA fix context` 且首行是 `QA verdict to fix: claim <id> ...`：把第 2 行改成 `FIXED-FOR-CLAIM <id>`（`<id>` 与 claim 逐字相同），其余不动，再次交付。
4. 提交信息用普通文字，例如 `docs(qa-sbx): FLY-3225 drill hand-in`。**绝不**带 `[skip ci]` / `[ci skip]` / `[no ci]` / `[skip actions]` / `[actions skip]` / `skip-checks:`（仓库历史里有这类提交，不能照抄；交付需要 CI 在确切的 head 上跑）。PR 标题同理。

## 3. QA 验收映射

**判轮依据**：只看本次 prompt。prompt 里**没有** `QA re-verification context` ＝ 首轮（`fixed-for-claim` 一定 fail）；有 `QA re-verification context` ＝ 复验轮（`<id>` 取自其中的 `Previous QA verdict: claim <id>`）。不要用历史轮次或分支上的旧提交来推断。

| 准则 id | 首轮预期 | 复验轮预期 |
|---|---|---|
| `file-shape` | pass：文件存在且第 1 行恰为 `QA-SBX FLY-3225 drill` | 同左 |
| `fixed-for-claim` | **一定 fail**，evidence = `round 1: no previous QA claim yet`（故意埋的失败，是本演练的目的） | pass 当且仅当第 2 行恰为 `FIXED-FOR-CLAIM <id>`，`<id>` 取自 `Previous QA verdict: claim <id>` |
| `e2e_529_exempt` | status `not_run`，`exempt_category: docs_only`，reason：纯 markdown 沙盒演练文件，无运行时代码，且演练规则禁止部署房间 | 同左 |

准则 title < 120 字符，evidence < 80 字符。

## 4. 验证（本地，implement 节点执行）

- `wc -l` 为 2；`sed -n 1p` 等于 `QA-SBX FLY-3225 drill`；`sed -n 2p` 等于期望的第 2 行。
- **实施范围**：以设计节点交付完成时的 HEAD 为实施基线 `<impl-base>`（`git rev-parse HEAD`，在开始实现之前取）。首次实现及之后每次修复，`git diff --name-only <impl-base>..HEAD` 必须**恰好**只有一行：`qa-sbx/fly3225/<git 分支名>.md`。其它任何路径（含 `engineering/doc/FLY-3225-real-runner-drill/` 下的设计文档、兄弟练习单 `qa-sbx/fly2167`/`fly3224`/`fly3226`…、各 README、代码目录）一律零改动；实现节点不新增实现说明，也不回改设计文档。
- 修复轮（`FIXED-FOR-CLAIM <id>`）相对首轮提交只改第 2 行：`git diff <首轮提交>..HEAD -- qa-sbx/fly3225/<分支名>.md` 只含第 2 行的一处替换。
- 提交信息与 PR 标题 grep 不到 skip-ci 标记。

## 5. 风险与回退

| 风险 | 应对 |
|---|---|
| 文件名与分支名不一致 | 一律用 `git branch --show-current` 现取，不硬编码 |
| 误把 `FIXED-FOR-CLAIM` 在首轮写进去 | 首轮只写 `AWAITING-QA`；没有 `QA fix context` 就不改第 2 行 |
| 复制了仓库历史里的 `[skip ci]` 提交风格 | 提交前 `git log -1 --format=%B \| grep -iE 'skip'` 必须无输出 |
| 越界改动 | 实施基线之后的改动文件列表恰好只有 `qa-sbx/fly3225/<分支名>.md` 一个文件（见 §4） |

回退：删除该 markdown 文件即可，无数据、无服务、无迁移。

## 6. 查询与索引

不适用：本演练不新增、不修改任何表、查询或索引，纯 markdown 文件改动。
