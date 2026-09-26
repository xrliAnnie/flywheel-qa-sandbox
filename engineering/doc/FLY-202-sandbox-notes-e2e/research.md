# FLY-202 QA 沙箱 fixture 笔记 — 调研
Issue: FLY-202 (https://linear.app/geoforge3d/issue/FLY-202/qa-sandbox-fixture-slot-harness-real-runner-e2e-task-do-not-pick-up)
日期: 2026-09-26
基于: exploration.md

---

所有事实均于 2026-09-26 在分支 tip `2ba0c9e`（+ design 节点自己的 progress commit）上实测。

## 1. Git / PR 状态

| 事实 | 值 |
|---|---|
| origin | `https://github.com/xrliAnnie/flywheel-qa-sandbox.git` |
| 分支 | `project-slot-4-FLY-202`，与 `origin/project-slot-4-FLY-202` 同步，工作区 clean |
| origin/main tip | `1855f7a1a` Merge #162（FLY-2164 清理 FLY-202 design fixture 残留） |
| 分支领先 main | 8 个 commit（progress ledger + drill marker + notes 刷新 + handoff） |
| PR #194 | OPEN、非 draft、base=`main`、head=`project-slot-4-FLY-202`、MERGEABLE |
| PR CI | `Build & Test` SUCCESS；`FLY-1062 payload distribution` SUCCESS |

## 2. 产物逐项核验（`doc/qa/sandbox-notes.md`）

| issue 步骤 | 核验方法 | 结果 |
|---|---|---|
| 1 用途 2-3 段 | 统计 `## Top-level` 之前的非空非标题行 | 3 段 ✅ |
| 2 顶层目录表 | 表格行 vs `git ls-tree -d --name-only HEAD` vs `find . -mindepth 1 -maxdepth 1 -type d` | 17 = 17 = 17，集合一致 ✅ |
| 3 README 摘要 | `## packages…summary` 下 `- ` 行数 | 10 条 ✅ |
| 4 `ls -R doc/` 快照 | 抽出 ```text 块与现场 `ls -R doc/ \| head -50` 做 `diff` | 零差异 ✅ |
| 5 commit + PR | PR #194 状态 | OPEN、未 merge ✅ |

补充观察：
- 目录表包含 5 个点目录（`.claude/ .flywheel/ .github/ .lead/ .serena/`）。issue 说
  「every top-level directory」，点目录也是目录，收录是正确的；已 tracked，不是本地噪音。
- 顶层还有一个名为 `=` 的杂散**文件**以及若干普通文件（`CLAUDE.md`、`memory.db` 等），
  均不是目录，正确地未进表。
- 文件末尾有一行 `- FLY-2456 drill marker r1 B1`，来自继承的 commit `06a6d4b7f`
  （另一个 drill 的标记）。PR #194 描述明确「retain the inherited FLY-2456 drill marker」。
  它不破坏任何一项验收（不在 README 摘要节内——它在 ```text 块之后），按分支连续性保留。

## 3. README 源文件

`packages/qa-framework/README.md`：316 行，最近修改 `7049f7199`（#58），此后未变。
主要 section：Architecture / Quick Start / 5-Step Protocol / Config Schema / Examples /
Test Slot Framework (FLY-115) / FLY-60 Hard Gate E2E / Mirror Mode (FLY-153) /
Roundtable Mirror (FLY-529) / Alert Mirror (FLY-529) / Contracts。
现有 10 条 bullet 覆盖了所有这些 section（FLY-529 两节合并在第 9 条）→ 无漂移。

## 4. 快照自我干扰分析

`ls -R doc/ | head -50` 的前 50 行覆盖：`doc/` 顶层 9 项、
`doc/FLY-145-s6-retry-product-test/`（10 文件）、`doc/FLY-202-qa-sandbox-fixture/`（13 文件）、
`doc/architecture/` 开头。

- **往这些目录新增/删除文件 → 快照过期。** 修改已有文件内容（比如 progress.md）不影响。
- 旧 ledger `doc/FLY-202-qa-sandbox-fixture/progress.md` 与 `workflow-output.json` 已存在，
  继续原地改写不会改变列表。
- 本轮 design 节点把所有新文件（含 HTML、`.mmd`、`.svg`）放在
  `engineering/doc/FLY-202-sandbox-notes-e2e/`，位于 `doc/` 之外 → 零干扰。

## 5. 配置事实

- `.flywheel/config.yaml`：`doc_flow.enabled: true`、`default_department: engineering`、
  `qa.auto: true`。
- 可用 comm 命令：`turn`（TURN 自检，本节点得到 `yours phase=design`）、`progress`、
  `stage`、`await-codex-gate`、`workflow-output`、`publish-report`、`complete`。
