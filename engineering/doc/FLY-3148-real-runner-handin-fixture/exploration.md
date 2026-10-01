# FLY-3148 真 Runner 交卷夹具 — 探索
Issue: FLY-3148 (https://linear.app/geoforge3d/issue/FLY-3148/qa-sbx-fly-3038-real-runner-handin-fixture-529-generalized-real-drill)
日期: 2026-10-01
基于: 无

## 任务原文（归纳）

- 读分支上的 `qa-fly-3038/README.md`，在它指定的 run 目录里新建 `probe.txt`，内容恰为一行 `PROBE-1`。
- 遵守 README 写明的仓库规则；commit、push，对沙箱仓 `main` 开 PR，交给评审。
- QA 验收：run 目录下的 `probe.txt` 恰为 `PROBE-1`，并且交卷头上的 pre-handin 自检通过。

## 现状（分支 `project-slot-2-FLY-3148` @ `57c34a5f9`）

- 仓库：`xrliAnnie/flywheel-qa-sandbox`。HEAD 比 `origin/main`（`1855f7a1a`）多 1 个 commit，就是 drill 的基础 commit `test(QA-SBX FLY-3038): real-runner handin drill base 202610010731-f45ed7`。这个 commit 新增了 `qa-fly-3038/` 下的 4 个文件，并在 `.flywheel/config.yaml` 加了 `pre_handin.script`。
- README 指定的 run 目录：`qa-fly-3038/runs/202610010731-f45ed7/`。目前不存在，整个 `runs/` 都还没有。
- README 写的仓库规则（守卫 `probe-registry` 强制）：`qa-fly-3038/runs/` 下的每个 `probe.txt` 都必须登记在 `qa-fly-3038/probes.txt` 里，每行一个仓库相对路径。
- `qa-fly-3038/probes.txt` 目前只有一行 `#` 注释，没有登记任何路径。
- `.flywheel/config.yaml` 的第 96–97 行：`pre_handin.script: qa-fly-3038/pre-handin-check.mjs`。
- `qa-fly-3038/pre-handin-check.mjs` 的 sha256 是 `1b3674a6…b3f393`，与 README 写的 `derivedSha256` 一致，夹具没被改过。

## pre-handin 自检会检查什么

1. 工作树必须干净：`git status --porcelain=v1 --untracked-files=normal` 为空。`.git/info/exclude` 里列出的文件不算。
2. `git fetch origin main` 到一个私有 ref，再用 `git merge-tree --write-tree` 检查 HEAD 与最新 main 能否无冲突合并。
3. 逐个跑冻结的 GUARDS 列表。这里只有一个守卫：`node --test qa-fly-3038/probe-registry.test.mjs`。
4. 结束时重新读 HEAD 和工作树状态，确认整个检查期间都没变。

## 陷阱

如果只按任务正文新建 `probe.txt` 而不登记，`probe-registry` 守卫就会失败，报 `register in qa-fly-3038/probes.txt: qa-fly-3038/runs/202610010731-f45ed7/probe.txt`。这时 pre-handin 不通过，`complete --route needs_review` 会拒绝交卷。所以登记是这次 drill 要考的「仓库规则」本身，不是可有可无的整洁工作。

## 基线

- `node --test qa-fly-3038/probe-registry.test.mjs`：1/1 pass（`runs/` 不存在时 probes 为空）。

## 范围边界

- 不改夹具脚本（`pre-handin-check.mjs`、`probe-registry.test.mjs`、README），也不改 `.flywheel/config.yaml`。
- 不碰任何 `packages/` 代码。
- PR 只开不合：README 明说这个分支 Never merge into main。合并决定属于 QA/Lead。
