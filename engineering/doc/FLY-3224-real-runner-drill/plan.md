# FLY-3224 真 Runner 通用演练（529 房间） — 实施计划
Issue: FLY-3224 (https://linear.app/geoforge3d/issue/FLY-3224/qa-sbx-fly-3224-real-runner-generalized-drill-529-room-only)
日期: 2026-10-06
基于: exploration.md

## 目标与范围

在 529 sandbox 完成一次真实的首轮失败 → 按失败记录编号返工 → 独立重验。每个节点先取得注入的 TURN，读 inbox 与新鲜 main 的 `qa-sbx/fly3224/README.md`；只在 `yours` 时写共享工作树。本轮 run 是 `d20eedd9-be9c-4af0-9b8b-4e54051b4f09`；后续节点使用自己的 exec、activation、gate 与交付身份。

演练内容只允许 `qa-sbx/fly3224/project-slot-2-FLY-3224.md`，分支名必须为 `project-slot-2-FLY-3224`。设计契约要求的协议产物仅复用 `engineering/doc/FLY-3224-real-runner-drill/` 已有文件；后续节点只更新自身契约要求的账本/证据。README 明确不需要 research.md，调研证据见 exploration.md。范围回复未覆盖强制文档的细节，按保守方案交付既有协议产物并说明，不新增研究或演练实现。

设计起点 main：`c21de8cbb5a40582366999230e7a8bf5c2bd96b2`（分支头即 main，无需同步）；README blob：`c4a1b3334b84d73b95cf4e2943c2c8f1474aef87`。目标文件在分支与 main 上都是上一轮返工写入并已经 PR #636 合并的 `FIXED-FOR-CLAIM 1`，本轮首次交付会把第二行改回 `AWAITING-QA`。同分支没有 OPEN PR；实现节点新建 PR，本轮首次交付 SHA 取实现节点核对后的 PR 头，旧评审、旧 CI 不作本轮证据。

## 第一次交付（实现节点）

- [ ] 取得 TURN；`git status` 必须单独赋值并成功（失败即停止，不写文件），工作树非空先核对归属，不覆盖他人或恢复中未提交的内容。记录本轮起点 SHA（提交版本的唯一编号）。没有 `QA fix context` 时写入精确两行，已有相同内容则跳过重复内容提交。

```bash
(
  set -eu
  DRILL_STATUS=$(git status --porcelain)
  test -z "$DRILL_STATUS"
  test "$(git branch --show-current)" = project-slot-2-FLY-3224
  printf 'QA-SBX FLY-3224 drill\nAWAITING-QA\n' > qa-sbx/fly3224/project-slot-2-FLY-3224.md
  printf 'QA-SBX FLY-3224 drill\nAWAITING-QA\n' | cmp - qa-sbx/fly3224/project-slot-2-FLY-3224.md
  git diff --check
)
```

- [ ] 只暂存演练文件，提交 `docs(qa-sbx): FLY-3224 drill hand-in`，按自己的注入契约更新 progress 并普通推送。再次查询同分支 OPEN PR：有则复用，无则创建以 main 为 base 的 PR。多行正文写临时文件并用 `--body-file`。
- [ ] 按实现节点的注入命令取得评审、最终 SHA 的 CI（每次提交后自动运行的检查）和交付回执。任何新增账本或修订提交后重新冻结、推送并核对最终 PR 头和对应 CI。提交信息和 PR 标题不含 README 禁止的跳过 CI 标记。记录本轮首次交付 SHA，供返工核验；历史绿色检查不作本轮证据。

## 本轮返工（实现节点）

- [ ] 编号唯一来源是注入首行 `QA verdict to fix: claim <id> ...`；保留原样，不从历史文件或本计划猜测。编号缺失、包含空白或换行则停止写入，走本节点注入的失败/问题通道。先核对本轮首次交付 SHA 是当前头祖先，且该 SHA 的第二行是 `AWAITING-QA`。
- [ ] 将该编号赋给 `DRILL_CLAIM`。已有精确相同内容则跳过重复写入；否则在干净工作树中只替换第二行：

```bash
(
  set -eu
  DRILL_STATUS=$(git status --porcelain)
  test -z "$DRILL_STATUS"
  test "$(git branch --show-current)" = project-slot-2-FLY-3224
  test -n "$DRILL_CLAIM"
  case "$DRILL_CLAIM" in *[[:space:]]*) exit 1 ;; esac
  printf 'QA-SBX FLY-3224 drill\nFIXED-FOR-CLAIM %s\n' "$DRILL_CLAIM" > qa-sbx/fly3224/project-slot-2-FLY-3224.md
  printf 'QA-SBX FLY-3224 drill\nFIXED-FOR-CLAIM %s\n' "$DRILL_CLAIM" | cmp - qa-sbx/fly3224/project-slot-2-FLY-3224.md
  git diff --check
)
```

- [ ] 提交、更新账本、普通推送，更新同一 OPEN PR，重新取得本轮最终头的评审、CI 与 handoff 回执。首次到返工交付之间的演练文件 patch 恰为 `-AWAITING-QA` / `+FIXED-FOR-CLAIM <本轮编号>`；第一行及两行 LF 形状不变。

## 独立 QA 验收

每轮读取该轮最终交付 SHA 的文件；有无 `QA re-verification context` 决定分轮。criterion id 固定如下，每条 title 少于 120 字符，evidence 少于 80 字符。

| criterion id | 首轮 | 重验 |
|---|---|---|
| `file-shape` | 文件存在，第一行精确为 `QA-SBX FLY-3224 drill` | 同左 |
| `fixed-for-claim` | 恒为 `fail`，evidence 精确为 `round 1: no previous QA claim yet` | 第二行仅在逐字等于 `FIXED-FOR-CLAIM <id>` 时 pass；编号来自 `Previous QA verdict: claim <id>` |
| `e2e_529_exempt` | `not_run`，`exempt_category: docs_only`，reason `Markdown-only drill; no room deployment` | 同左 |

编号缺失不猜测。范围分两层核对：(1) **本轮提交**（从设计起点 `c21de8cbb` 之后）排除注入要求的协议文档（本文件夹与 `engineering/doc/milestones/FLY-3224.md`）后只能改目标演练文件；(2) **整个新 PR 相对 main** 同样只能含目标演练文件与上述协议文档；`fly2966-qa-negative.txt` 已在 main 上，实现节点不得修改或删除它。本链路不 merge。演练文件本身若本轮编号碰巧为 1，最终内容可能与 main 相同，仍须保留本轮首次交付及返工之间的 patch 和 QA 回执。检查精确两行、范围及编号；无程序或测试文件改动，不新增测试套件。本地遵守 local-test-policy/v2，只运行明确文件和注入固定 smoke；只有 frozen-head CI OK 是全套证据。

## 查询与索引

不适用：只修改两行 Markdown 及强制设计协议产物，不新增或修改表、查询、索引，没有数据库扫描或热查询。

## 恢复、回滚与边界

恢复以本轮身份、TURN、QA context 和交付摘要为准，旧账本不是当前批准。必要的 main 同步不需要 ship 权限，但同步后必须重新核对文件、范围、最终头与回执；有冲突先保留归属，不覆盖其他节点产物。撤销仅限本轮授权提交，不重写共享历史。

不改 Linear 状态、评论、标签，不部署/拆除房间，不改代码、配置或数据库。设计只交付探索、短计划、账本和含本地 Mermaid 图的 HTML，不改演练文件、不创建 PR、不调度后继节点、不请求 shipping 权限、不合并。获得本轮有效 APPROVED、提交推送、发布并报告 HTML 后，运行注入的 `phase_design_complete`，再 park 并保留 resident goal。
