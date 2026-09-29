# FLY-3033 N-to-N 重启探针 — 设计阶段演练记录
Issue: FLY-3033 (https://linear.app/geoforge3d/issue/FLY-3033/529-合成单勿派-fly-2920-真房-n-to-n-codex-实现体重启负载演练用)
日期: 2026-09-28
基于: plan.md

## 方法

`bash dry-run/run.sh <plan.md>`（临时产物全部落在 `$TMPDIR/fly3033-dry.*`，不进仓库）用 awk 从 plan.md **逐字抽出** §1 常量块与 Task 0–6、6b 代码块，每块 = §1 + 该块，作为一次独立 `/bin/sh` 执行。每个场景新建一个世界：

- 临时仓：`main` = 本仓 `origin/main:README.md`（44 字节）+ 一个无关文件；分支 `project-slot-2-FLY-3033` = 设计文档 commit，已推到本地 bare origin；`core.hooksPath` 指向 `.../state/push-guard/hooks`。
- 桩（`dry-run/stubs.sh`）：`git` 包装（只改写 `remote get-url origin` 为沙箱 GitHub URL，可注入 `git show` 失败）；`gh`（PR 状态存文件，`pr list/create/edit/view/checks`）；`flywheel-comm`（`turn` / `progress` 按真实格式写 frontmatter 并 `git commit --only` / `ask` / `complete`，可注入退出码）。
- 真实 `git`、真实 `lsof`、真实 push 到 bare origin。

「final OK」= README 74 字节且目标行 1 次、`origin/main..HEAD` 恰 1 个 README commit、milestone 为 HEAD、远端头 = HEAD、工作区干净、PR OPEN。

## 结果（2026-09-28，15 场景全部符合预期）

| 场景 | 模拟 | 结果 |
|---|---|---|
| A 全流程 + 完工后换体全部重跑 | Task 0→6，再从 Task 0 全部重跑 | PASS：两次 final OK；第二遍 Task 0 打印 FROZEN、所有写入 no-op、HEAD 不变；commit 序列 = README → implement 1/3 → 2/3 → 3/3 → milestone；PR 只创建 1 次 |
| M 未冻结就评审 / 交卷 | Task 3 后直接跑 Task 5、6 | PASS：两处 `STOP: 未冻结` |
| B 追加后被杀（未暂存） | 跑 0、1 后弃体，新体 0→6 | PASS：不重复追加，final OK |
| B2 追加并 `git add` 后被杀 | 同上但 README 已暂存 | PASS：Task 0 放行 `M  README.md`，final OK |
| C milestone 写入并暂存后被杀 | Task 3 后放一个暂存的垃圾 milestone，新体 0→6 | PASS：Task 0 放行 `A  <MS>`，Task 2/3 账本不倒退，Task 4 覆写后提交，final OK |
| C2 `gh pr create` 成功后被杀 | 预置 1 个 OPEN PR，新体 0→6 | PASS：走 `edit` 分支，`pr create` 0 次，final OK |
| D milestone 已提交、push 失败 | bare origin pre-receive 拒绝 → Task 4 STOP；恢复后新体 0→6 | PASS：Task 0 打印 FROZEN，所有写入 no-op，final OK |
| E 越界提交 | 提交 `foo.txt` 后跑 Task 0 | PASS：`STOP: diff 超出白名单： foo.txt` |
| E2 越界未跟踪文件 | 工作区放 `junk.txt` | PASS：`STOP: 工作区有白名单外的未提交改动： [?? junk.txt]` |
| L 5 分钟前的孤儿 `index.lock` | 追加后放旧锁 → Task 2 STOP；新体 0→6 | PASS：Task 0 回收孤儿锁，final OK |
| L2 新鲜锁 | 刚创建的 `index.lock` | PASS：Task 0 STOP，锁保留 |
| T TURN not-yours | 桩 `turn` 返回 not-yours | PASS：Task 0 STOP，HEAD 与工作区不变 |
| G CI 失败 | 桩 `gh pr checks` 返回 1 | PASS：Task 6 STOP，`ask`/`complete` 0 次 |
| K complete exit 3 | Task 6 `complete` 返回 3，再单跑 6b | PASS：6b 重新推导 PR 并交卷，`ask` 1 次 |
| R 冻结后 `git show` 失败 | 冻结后注入 `git show` exit 128，跑 Task 2、5 | PASS：两处 `STOP: 读取 HEAD:… 失败`，未调用 progress，HEAD 不变 |
| N 无临时目录 | `TMPDIR=/nonexistent` 下 0→6 | PASS：final OK（无 here-doc / 临时文件依赖） |

演练第一版抓到一个真问题：换体重放 Task 2 时 `prog 1/3` 会把已到 `2/3` 的账本拉回（`progress` 每次都写 `updated` 时间戳，总会落 commit，没有单调校验）。已在 `prog` 里加「账本已在本游标或更后则 no-op」，重跑后 C 场景 PASS。

## 诚实边界

- 「前体 shell 已死、git 子进程仍在」与「lsof 枚举失败 / 不完整」两类锁场景未在本单重演：锁回收块与 FLY-3030 R1–R3 评审并演练通过的版本逐字相同（只换了分支名常量）。
- Task 5 的评审门命令由实现节点注入，演练只跑了前置（冻结头推导）。
- 真实 GitHub push / PR / CI 只在实现节点发生；`gh` 在演练中是桩。
