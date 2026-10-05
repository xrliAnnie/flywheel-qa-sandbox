# FLY-3224 真 Runner 通用演练（529 房间） — 实施计划
Issue: FLY-3224 (https://linear.app/geoforge3d/issue/FLY-3224/qa-sbx-fly-3224-real-runner-generalized-drill-529-room-only)
日期: 2026-10-04
基于: exploration.md（README 明确不需要 research 文档）

## 范围与权威

每个节点先取得自己的 TURN，再读 `origin/main:qa-sbx/fly3224/README.md`。本轮 run 为 `278e6c90-e543-4846-ba3f-d20495ae0ad8`。本计划只安排 README 的两行 Markdown 演练；节点的评审、CI、交付与等待身份由各自注入提示词提供，不复用设计 exec 或旧 run 的回执。

演练文件由当前分支名确定：`qa-sbx/fly3224/project-slot-2-FLY-3224.md`。只改这个演练文件；协议文档例外限于 `engineering/doc/FLY-3224-real-runner-drill/`，来源是注入的 DOC-FLOW、PROGRESS LEDGER、强制设计 HTML 契约，且不属于 QA criterion。设计节点更新该文件夹，实现/QA 节点仅更新自身契约要求的 progress.md，不编辑其他设计文档。README 规定无需 research.md。本轮设计不实现演练、不建 PR、不运行演练 CI。

当前 main 为 `c68c2b7d4639ed9a1019faa05dc4414c340d3396`；README blob 为 `c4a1b3334b84d73b95cf4e2943c2c8f1474aef87`。分支继承上一轮 run `bdb3fbec` 的提交，演练文件第二行是上一轮返工留下的 `FIXED-FOR-CLAIM 1`（与 main 相同）；同分支 PR #571 仍 OPEN，头 `2ee7e48b969a35f063e53eaf2580d0f3dec274d9`。本轮尚无 QA claim。实现节点复用 #571，但其旧评审、旧 CI、旧 claim 1 和旧 progress 指针均不作为本轮证据；后续节点重新读取当前状态。

## 实现：第一次交付

- [ ] 取得注入 TURN 并读取 inbox；只在 `yours` 时写共享工作树。先确认工作树干净，记录本轮起点 SHA。
- [ ] 无 `QA fix context` 时，将文件写成下面的精确两行，每行以 LF 换行结尾。如果本轮恢复后已经精确一致，则不重复写入或制造空提交。

```text
QA-SBX FLY-3224 drill
AWAITING-QA
```

```bash
(
  set -eu
  test -z "$(git status --porcelain)"
  DRILL_BRANCH=$(git branch --show-current)
  test "$DRILL_BRANCH" = project-slot-2-FLY-3224
  DRILL_FILE="qa-sbx/fly3224/$DRILL_BRANCH.md"
  printf 'QA-SBX FLY-3224 drill\nAWAITING-QA\n' > "$DRILL_FILE"
  printf 'QA-SBX FLY-3224 drill\nAWAITING-QA\n' | cmp - "$DRILL_FILE"
  git diff --check
  git diff -- "$DRILL_FILE"
)
```

预期：工作树非空时第一条断言退出，文件不被覆盖。工作树干净时 `cmp` 和 `diff --check` 成功；在当前起点上，patch 只把第二行从历史固定编号改为 AWAITING-QA。

- [ ] 只暂存目标文件，提交 `docs(qa-sbx): FLY-3224 drill hand-in`。按实现节点注入身份运行 `progress`，该命令只提交账本；记录最终交付 SHA，普通 `git push -u origin HEAD`。检查远端 SHA 一致。
- [ ] 查同分支 OPEN PR，存在则复用，不存在则开指向 main 的 PR。本轮检查结果和完整 SHA 写入临时正文文件，使用 `gh pr create/edit --body-file`；标题与提交信息不含任何 skip-CI 标记。
- [ ] 按实现节点注入的评审、exact-head CI 和交付回执命令执行。任何账本/修订提交后都重新冻结 SHA、推送并核对 PR 头及该头 CI，旧 CI 不作本轮证据。将本轮首次交付 SHA 记入交付摘要，供返工核验。

## 实现：收到本轮 QA 返工后

- [ ] 只从返工提示首行 `QA verdict to fix: claim <id> ...` 读取本轮编号，原样使用；不得猜测或从旧文件/历史计划取值。交付编号缺失则走注入的失败/问题通道，不提交推测值。
- [ ] 核对本轮第一次交付 SHA 是当前头的祖先，其文件第二行为 AWAITING-QA。将第二行改为下面的值，第一行及文件范围保持不变。恢复重试时若已精确匹配本轮编号，则跳过重复内容提交。

```text
QA-SBX FLY-3224 drill
FIXED-FOR-CLAIM <id>
```

`<id>` 是提示词提供的失败记录编号，不能把尖括号或示例编号写入文件。赋给 `DRILL_CLAIM` 后执行：

```bash
(
  set -eu
  test -z "$(git status --porcelain)"
  test -n "$DRILL_CLAIM"
  case "$DRILL_CLAIM" in *[[:space:]]*) exit 1 ;; esac
  DRILL_BRANCH=$(git branch --show-current)
  test "$DRILL_BRANCH" = project-slot-2-FLY-3224
  DRILL_FILE="qa-sbx/fly3224/$DRILL_BRANCH.md"
  printf 'QA-SBX FLY-3224 drill\nFIXED-FOR-CLAIM %s\n' "$DRILL_CLAIM" > "$DRILL_FILE"
  printf 'QA-SBX FLY-3224 drill\nFIXED-FOR-CLAIM %s\n' "$DRILL_CLAIM" | cmp - "$DRILL_FILE"
  git diff --check
  git diff -- "$DRILL_FILE"
)
```

- [ ] 只提交该第二行修改，更新节点账本，普通推送，更新同一个 OPEN PR；再次取得本轮评审、最终头 CI 和 handoff 回执。验证第一次交付到本次交付的 fixture patch 恰为 `-AWAITING-QA` / `+FIXED-FOR-CLAIM <本轮编号>`。

## 范围、恢复与证据

排除上述协议文档文件夹后，PR 三点 diff 只允许空或目标演练文件一个路径；交付头的文件必须逐字节等于当轮预期两行。空 diff 仅在合并基上的文件也已精确等于当轮预期时合法。例如本轮新编号恰为 1 时，修复后可能与 main 的历史文件相同；仍须保留本轮首次 AWAITING-QA 交付及后续第二行修改的区间 patch，证明真实返工。

恢复时以注入 run、TURN、QA context 和本轮交付摘要为准。不要从旧账本猜编号。仅在注入契约或实际 PR 冲突要求时同步 main；普通 merge 不需要 shipping 权限。冲突在协议文件夹内时只做保留本轮内容的必要处理，并记来源 SHA；冲突涉及演练文件或其他范围则中止合并并走失败通道。同步会产生新头，必须重核文件、范围、评审/CI 与交付回执。

## QA 验收

分轮只看本轮提示词是否有 `QA re-verification context`；读取本次交付头的目标文件。

| criterion id | 首轮 | 重验 |
|---|---|---|
| `file-shape` | 文件存在，第一行精确为 `QA-SBX FLY-3224 drill` | 同左 |
| `fixed-for-claim` | 恒为 `fail`；evidence 精确为 `round 1: no previous QA claim yet` | 第二行仅在精确等于 `FIXED-FOR-CLAIM <id>` 时 pass；编号来自 `Previous QA verdict: claim <id>` |
| `e2e_529_exempt` | `not_run`；`exempt_category: docs_only`；reason `Markdown-only drill; no room deployment` | 同左 |

每条 title 少于 120 字符、evidence 少于 80 字符。首轮故意失败是演练要求，不能因历史文件已固定编号而放行。重验编号缺失走失败通道。没有新增/改动代码或测试文件，不新增测试套件；本地只检查明确文件形状与 diff，并遵守注入的固定 smoke 与本地文件选择政策。只有 frozen-head CI OK 能作为全套通过证据。

## 查询与索引

不适用：本设计只安排一个两行 Markdown 文件及设计协议文档，不新增或修改表、查询或索引，没有热查询或数据库行扫描。

## 边界与回滚

本设计覆盖 529 sandbox 的真执行会话 fail → fix → re-verify 编号传递；不验证生产 Flywheel 实现。Linear 的状态、评论、标签均保持原样；不部署/拆除房间，不改程序或配置，不 dispatch 后继节点，不请求 shipping 权限，不合并 PR。回滚只能撤销本轮有权修改的提交，不覆盖其他节点产物。设计阶段提交并发布 HTML、报告给指定 Lead、获得本轮有效设计 APPROVED 后，使用注入的 `phase_design_complete` 回执交棒并保持 resident goal。
