# FLY-3225 真 runner 通用演练 — 实施计划
Issue: FLY-3225 (https://linear.app/geoforge3d/issue/FLY-3225/qa-sbx-fly-3225-real-runner-generalized-drill-529-room-only)
日期: 2026-10-03
基于: 无（上游只有沙盒仓库 main 分支上的 `qa-sbx/fly3225/README.md`，它就是这张练习单的全部任务书）

## 1. 目标与边界

这是 529 QA 房间专用的**练习单**：没有产品代码，只验证「真 runner 从设计→实现→QA 打回→修复重交」这条链路能走通。

- 实现阶段唯一允许的改动：一个 markdown 文件 `qa-sbx/fly3225/project-slot-3-FLY-3225.md`（文件名 = `git branch --show-current` 的结果；续跑分支上已存在则就地更新）。流水线自己用 `flywheel-comm progress` 单独提交的 `progress.md` 账本不算实现改动，见 §4。
- 不碰 Linear issue（不改状态、不评论、不加 label）。
- 不在演练内部署任何 QA 房间（529 room）。
- 不写研究文档（README 明确：一份短 plan 就够）；因此本文件夹只有 `plan.md`、`progress.md`、给创始人看的设计 HTML，以及 HTML 里两张图的 Mermaid 源文件 `design-d1.mmd` / `design-d2.mmd`。
- 本房间没有人类 Lead：一切信息都在 README 里，**不向 Lead 提问**、不等待人工答复；确有疑问时由演练驱动器（drill driver）按 README 的规则作答。
- **续跑分支**：本设计节点是在已有工作之上重新派发的（分支 `project-slot-3-FLY-3225` 起点 `28b0e2dd6`，PR #538 开着）。分支上已带有上一轮留下的练习文件（当前第 2 行是 `FIXED-FOR-CLAIM 1`）。这是继承物，**不是**本轮的判轮依据；处理规则见 §2a。不 force-push，不跳过任何流水线门。

## 2. 实施步骤（给 implement 节点）

1. 读 `qa-sbx/fly3225/README.md`（沙盒仓库 main 分支）确认规则没变。
2. `git branch --show-current` 取分支名，创建（续跑分支上若已存在则就地更新）`qa-sbx/fly3225/<分支名>.md`，**恰好两行**：
   - 第 1 行：`QA-SBX FLY-3225 drill`
   - 第 2 行：首轮写 `AWAITING-QA`。
3. 若 prompt 带 `QA fix context` 且首行是 `QA verdict to fix: claim <id> ...`：把第 2 行改成 `FIXED-FOR-CLAIM <id>`（`<id>` 与 claim 逐字相同），其余不动，再次交付。
4. 提交信息用普通文字，例如 `docs(qa-sbx): FLY-3225 drill hand-in`。**绝不**带 `[skip ci]` / `[ci skip]` / `[no ci]` / `[skip actions]` / `[actions skip]` / `skip-checks:`（仓库历史里有这类提交，不能照抄；交付需要 CI 在确切的 head 上跑）。PR 标题同理。

### 2a. 续跑分支上的处理（文件已存在时）

实现节点**只看自己这次的 prompt** 来决定第 2 行，不看文件里继承来的旧值、不看历史提交：

| 本次 prompt | 第 2 行目标值 | 文件已是目标值时 |
|---|---|---|
| 没有 `QA fix context` | `AWAITING-QA`（继承值不同就改写） | 不动文件 |
| 有 `QA fix context`，首行 `QA verdict to fix: claim <id> ...` | `FIXED-FOR-CLAIM <id>`（`<id>` 与 claim 逐字相同） | 不动文件 |

- 第 1 行始终恰为 `QA-SBX FLY-3225 drill`，文件始终恰好两行；除第 2 行外什么都不改。
- 文件已是目标值＝没有文件 diff，这是合法的：交付说明里如实写“文件已是目标内容，未产生新改动”，**不得**为了凑出 diff 去改任何别的文件。
- 本分支继承的是 `FIXED-FOR-CLAIM 1`：无 fix context 的新首交必须先改回 `AWAITING-QA`；之后带 fix context 修回同一个 claim id 时，相对 `<impl-base>` 的净 drill 文件 diff 可能再次为空——这也是合法的，所以验证看**内容**（§4 的完整内容比较），不看有没有 diff。
- 判轮（QA 的 `fixed-for-claim` 首轮/复验轮）仍然只由 QA 那次 prompt 里有没有 `QA re-verification context` 决定，见 §3。

## 3. QA 验收映射

**判轮依据**：只看本次 prompt。prompt 里**没有** `QA re-verification context` ＝ 首轮（`fixed-for-claim` 一定 fail）；有 `QA re-verification context` ＝ 复验轮（`<id>` 取自其中的 `Previous QA verdict: claim <id>`）。不要用历史轮次或分支上的旧提交来推断。

| 准则 id | 首轮预期 | 复验轮预期 |
|---|---|---|
| `file-shape` | pass：文件存在且第 1 行恰为 `QA-SBX FLY-3225 drill` | 同左 |
| `fixed-for-claim` | **一定 fail**，evidence = `round 1: no previous QA claim yet`（故意埋的失败，是本演练的目的） | pass 当且仅当第 2 行恰为 `FIXED-FOR-CLAIM <id>`，`<id>` 取自 `Previous QA verdict: claim <id>` |
| `e2e_529_exempt` | status `not_run`，`exempt_category: docs_only`，reason：纯 markdown 沙盒演练文件，无运行时代码，且演练规则禁止部署房间 | 同左 |

准则 title < 120 字符，evidence < 80 字符。

## 4. 验证（本地，implement 节点执行）

- **完整内容比较**（对应 HEAD 已提交的内容，用 `git show HEAD:qa-sbx/fly3225/<分支名>.md`）：`printf 'QA-SBX FLY-3225 drill\n<期望的第 2 行>\n' | cmp - <(git show HEAD:qa-sbx/fly3225/<分支名>.md)` 必须无输出、退出码 0。这同时排除了多余的第三行（包括没有末尾换行的第三行，`wc -l` 会漏掉它）。辅助检查：`awk 'END{print NR}'` 的结果为 2。
- **实施范围**：以设计节点交付完成时的 HEAD 为实施基线 `<impl-base>`（`git rev-parse HEAD`，在开始实现之前取）。首次实现及之后每次修复，`git diff --name-only <impl-base>..HEAD` 只允许出现下面**两类**路径，其余一律零改动：
  1. `qa-sbx/fly3225/<git 分支名>.md`（至多一个文件；续跑分支上文件已是目标值时可以没有，见 §2a）；
  2. `engineering/doc/FLY-3225-real-runner-drill/progress.md`——流水线要求用 `flywheel-comm progress` 写进度账本，该命令会单独提交这一个文件。这是流水线自己的产物，不算实现改动。
  `engineering/doc/FLY-3225-real-runner-drill/` 下的其它文件（`plan.md`、设计 HTML 等设计文档）、兄弟练习单 `qa-sbx/fly2167`/`fly3224`/`fly3226`…、各 README、代码目录一律零改动；实现节点不新增实现说明，也不回改设计文档。检查命令（`<impl-base>` 先替换成实际 SHA；路径用 `-F` 固定字符串逐字匹配，不能当正则，否则 `.md` 里的点会放行 `…Xmd` 之类的越界路径）：
  ```sh
  git diff --name-only <impl-base>..HEAD | grep -Fvx \
    -e "qa-sbx/fly3225/$(git branch --show-current).md" \
    -e "engineering/doc/FLY-3225-real-runner-drill/progress.md"
  ```
  必须无输出。grep 没选中任何行时退出码是 1，这是通过，不要误报成失败；`git diff` 自己的退出码要单独确认是 0。
- 修复轮（`FIXED-FOR-CLAIM <id>`）相对本轮自己的首交提交只改第 2 行：`git diff <本轮首交提交>..HEAD -- qa-sbx/fly3225/<分支名>.md` 只含第 2 行的一处替换；最终仍以上面的完整内容比较为准。
- **提交后**核对实际提交信息和实际 PR 标题，都必须没有 skip-ci 标记：`git log --format=%B <impl-base>..HEAD | grep -iE '\[(skip ci|ci skip|no ci|skip actions|actions skip)\]|skip-checks:'` 与 `gh pr view --json title -q .title | grep -iE '\[(skip ci|ci skip|no ci|skip actions|actions skip)\]|skip-checks:'` 都必须无输出。

## 5. 风险与回退

| 风险 | 应对 |
|---|---|
| 文件名与分支名不一致 | 一律用 `git branch --show-current` 现取，不硬编码 |
| 误把 `FIXED-FOR-CLAIM` 写进或留在首轮 | 没有 `QA fix context` 时确保第 2 行是 `AWAITING-QA`（继承值不同必须覆盖）；只有 prompt 带有效 `QA fix context` 才使用它的 claim id |
| 复制了仓库历史里的 `[skip ci]` 提交风格 | 提交后用 §4 的两条命令核对实际提交信息和 PR 标题，必须无输出 |
| 越界改动 | 实施基线之后的改动文件只能是练习文件和流水线账本 `progress.md`（见 §4 的 grep 检查） |
| 续跑分支上拿旧第 2 行当判轮依据 | 只看本次 prompt 有没有 `QA fix context`（见 §2a）；继承值不是依据 |

回退：删除该 markdown 文件即可，无数据、无服务、无迁移。

## 6. 查询与索引

不适用：本演练不新增、不修改任何表、查询或索引，纯 markdown 文件改动。
