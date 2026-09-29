# FLY-3033 N-to-N 重启探针 — 设计阶段演练记录
Issue: FLY-3033 (https://linear.app/geoforge3d/issue/FLY-3033/529-合成单勿派-fly-2920-真房-n-to-n-codex-实现体重启负载演练用)
日期: 2026-09-28
基于: plan.md

## 方法

`bash dry-run/run.sh <plan.md>`（需要真实 `FLYWHEEL_COMM_CLI` 环境变量，用来定位真实 `dist/commands/progress.js`；临时产物全部落在 `$TMPDIR/fly3033-dry.*`，不进仓库）用 awk 从 plan.md **逐字抽出** §1 常量块与 Task 0–4、5a、5b、6、6b 代码块，每块 = §1 + 该块，作为一次独立 `/bin/sh` 执行。每个场景新建一个世界：

- 临时仓（与生产 slot 同形态：主工作树 + linked worktree）：主工作树在 `main` = 本仓 `origin/main:README.md`（44 字节）+ 一个无关文件；`git worktree add` 出的 linked worktree 在分支 `project-slot-2-FLY-3033` = 设计文档 commit，已推到本地 bare origin，所有块都在这个 linked worktree 里执行；`core.hooksPath` 指向 `.../state/push-guard/hooks`；`.flywheel/runs/` 写进 `info/exclude`（与真实 common exclude 一致）。
- 桩（`dry-run/stubs.sh`）：`git` 包装（只改写 `remote get-url origin` 为沙箱 GitHub URL，可注入 `git show` 失败）；`gh`（PR 状态存文件，`pr list/create/edit/view/checks`）；`flywheel-comm`（`turn` / `progress`（按真实 frontmatter 写并 `git commit --only`，`HANG=1` 时挂住模拟存活写者）/ `gate`（每次新建 `q-<n>`）/ `request-review`（记录 requestId）/ `check` / `ask` / `complete`，可注入退出码）。
- **真实 progress 崩溃**（`dry-run/progress-crash.mjs`，Codex R1 的复现方法）：调用真实 `runProgress`（只替换 session 查询），在「拿锁后 / rename 前 / rename 后 / commit 后」四个切点对自己 SIGKILL。
- 真实 `git`、真实 `lsof`、真实 `ps`、真实 push 到 bare origin。

「final OK」= README 74 字节且目标行 1 次、`origin/main..HEAD` 恰 1 个 README commit、milestone 为 HEAD、远端头 = HEAD、工作区（含未跟踪）干净、PR OPEN；同时打印 ask / complete / PR 创建 / gate / request-review 次数与账本 commit 序列。

## 结果（2026-09-28，31 个场景全部符合预期）

| 场景 | 模拟 | 结果 |
|---|---|---|
| A 全流程 + 完工后换体全部重跑 | Task 0→6，再全部重跑 | PASS：两次 final OK；第二遍 Task 0 打印 FROZEN、所有写入 no-op、HEAD 不变；gate 1 次、request-review 1 次；commit 序列 = README → implement 1/3 → 2/3 → 3/3 → milestone |
| M 未冻结就评审 / 交卷 | Task 3 后直接跑 5a、5b、6 | PASS：三处 `STOP: 未冻结` |
| B / B2 追加后被杀（未暂存 / 已暂存） | 跑 0、1（B2 再 `git add`）后弃体 | PASS：不重复追加，final OK |
| C milestone 写入并暂存后被杀 | Task 3 后放一个暂存的垃圾 milestone | PASS：Task 0 放行，账本不倒退，Task 4 覆写后提交，final OK |
| C2 `gh pr create` 成功后被杀 | 预置 1 个 OPEN PR | PASS：走 `edit`，`pr create` 0 次，final OK |
| D milestone 已提交、push 失败 | pre-receive 拒绝 → Task 4 STOP；恢复后全跑 | PASS：FROZEN，所有写入 no-op，final OK |
| E / E2 越界提交 / 越界未跟踪文件 | `foo.txt` 提交 / `junk.txt` 未跟踪 | PASS：Task 0 分别 STOP |
| L 私有 `index.lock` 残留 | 5 分钟前的 worktree 私有 `index.lock` → Task 2 STOP；主工作树里放一个存活的真实 `git` 进程后新体全跑 | PASS：私有锁只查本工作树，照常回收，final OK |
| L2 新鲜锁 | 刚创建的 `index.lock` | PASS：STOP，锁保留 |
| S 共享 ref 锁 + 兄弟工作树活 git（Codex R2 负例） | 5 分钟前的 common 目录 `refs/remotes/origin/<BR>.lock`，主工作树里有存活 `git` | PASS：`STOP: 锁 … 的作用域内仍有 1 个存活的 git 进程`，锁保留；兄弟 git 退出后回收，final OK |
| S2 共享 ref 锁、无活 git | 5 分钟前的 `refs/heads/<BR>.lock` | PASS：回收，final OK |
| LC 共享 `config.lock` | 5 分钟前的 common 目录 `config.lock`，跑 0→3 | PASS：不回收、不受影响（`push` 不带 `-u`，不写 config） |
| P[after-lock] 真实 progress 拿锁后被杀 | 残留 `?? progress.md.lock` | PASS：残留刚产生时 Task 0 STOP（<2 分钟）；变旧后回收，final OK，账本 1/3→2/3→3/3 不重复 |
| P[before-rename] | 残留锁 + `progress.md.tmp-<pid>` | PASS：两者都回收，final OK |
| P[after-rename] | 残留锁 + ` M progress.md`（未提交的 1/3） | PASS：回收锁并把账本还原到 HEAD，`prog 1/3` 重新补写，final OK |
| P[after-commit] | 1/3 已提交，只剩锁 | PASS：回收锁，`prog 1/3` 按已提交游标跳过，final OK |
| P-fresh 残留刚产生 | 崩溃后立刻跑 Task 0 | PASS：STOP，残留保留 |
| P-live 仍有存活的 progress 写者 | 旧锁 + 一个挂住的 `node <CLI> progress` 进程 | PASS：`STOP: 仍有 1 个存活的 progress 进程`，残留保留；写者退出后回收，final OK |
| F 冻结后才出现账本锁残留 | 冻结后放旧锁，跑 0、4、5a、5b、6 | PASS：回收锁，HEAD 不变，final OK |
| V1 注册完成后换体重跑 | 5a 后全部重跑 | PASS：沿用同一 questionId / requestId，gate 1 次、request-review 1 次 |
| V2 开门后、记 questionId 前被杀 | 记录只有 `head` + `gateOpening` | PASS：`STOP: 前体开门途中被杀…不开第二个门`，gate 0 次 |
| V3 记 requestId 后注册失败 | `request-review` 返回 1，再重跑 5a | PASS：重试用同一个 requestId（2 次调用、1 个不同 ID），final OK |
| V4 记录头与冻结头不同 | 预置 `head=deadbeef` 的记录 | PASS：5a、5b 都 STOP，不沿用旧身份 |
| V5 CHANGES_REQUESTED | `check` 返回 CHANGES_REQUESTED | 5b 只打印裁决（按 plan 由执行体读 `reviewVerdict` 后 STOP + ask，不进 Task 6） |
| T TURN not-yours | 桩 `turn` 返回 not-yours | PASS：Task 0 STOP，无写入 |
| G CI 失败 | 桩 `gh pr checks` 返回 1 | PASS：Task 6 STOP，ask / complete 0 次 |
| K complete exit 3 | 再单跑 6b | PASS：6b 交卷，ask 1 次 |
| R 冻结后 `git show` 失败 | 注入 `git show` exit 128，跑 Task 2、5a | PASS：两处 STOP，未调 progress，HEAD 不变 |
| N 无临时目录 | `TMPDIR=/nonexistent` 下全跑 | PASS：final OK |

演练发现并已修复的问题：

1. 第一版：换体重放 Task 2 时 `prog 1/3` 会把已到 `2/3` 的账本拉回（`progress` 每次都写 `updated` 时间戳，总会落 commit）。→ `prog` 加「账本已在本游标或更后则 no-op」。
2. Codex R1（high）：真实 `progress` 在内部切点被杀会留下锁 / 临时文件 / 未提交改写，旧 Task 0 一律拒绝 → 永久卡住。→ Task 0 增加账本残留回收（TURN + ≥2 分钟 + `ps` 无存活写者），`prog` 改读**已提交**账本游标。
3. Codex R1 探针顺带验证：`git push -u` 途中被杀会留下 `config.lock`。第一次修法把它加进回收列表；Codex R2 在「主仓 + linked worktree」里真实复现这会删掉兄弟工作树活写者的共享锁（high）。→ 最终修法：`pushbr` 去掉 `-u`（本单不写 config），**不回收** `config.lock`；common 目录里的 `refs/…` 锁改为检查全仓所有工作树内的存活 git 进程，演练世界改成 linked worktree 形态并加 S 负例。
4. Codex R1（medium）：Task 5 重放会新开 gate / 新 requestId。→ 改为先落 `.flywheel/runs/$EXEC/code-review.rec` 记录、沿用原身份、开门窗口中断则 STOP 求助。

## 诚实边界

- 「前体 shell 已死、git 子进程仍在」与「lsof 枚举失败 / 不完整」两类 git 锁场景未在本单重演：lsof 哨兵与枚举方式与 FLY-3030 R1–R3 评审并演练通过的版本相同，本单只把作用域从「本工作树」按锁位置扩展为「本工作树 / 全仓所有工作树」。
- Task 5 的 `gate` / `request-review` / `check` 是桩：演练证明的是「记录先行、沿用原身份、不开第二个门」的控制流，不证明 Bridge 端对重复 `--request-id` 的处理（以 `request-review` 自身「retry with --request-id」的提示为依据）；`bridge_restart_retired` 恢复命令需执行体按 5b 的说明读 `check` 输出执行，未演练。
- 真实 GitHub push / PR / CI 只在实现节点发生；`gh` 在演练中是桩。
