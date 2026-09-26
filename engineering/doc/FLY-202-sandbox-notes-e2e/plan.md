# FLY-202 沙箱夹具刷新 — 实施计划
Issue: FLY-202 (https://linear.app/geoforge3d/issue/FLY-202/qa-sandbox-fixture-slot-harness-real-runner-e2e-task-do-not-pick-up)
日期: 2026-09-26
基于: research.md（同文件夹；事实以 research 现场实测为准）

> **For Flywheel Runner (implement 节点):** 在当前 resident session 内逐项执行；
> 不派发 subagent；不 merge、不 approve、不请求 ship。route 由 dispatch 指定。

**Goal:** 在延续分支 `project-slot-2-FLY-202`（PR #155）上，按 **verify-then-refresh**
合同保证 `doc/qa/sandbox-notes.md` 满足 FLY-202 五步要求并与当前仓库快照一致；
把 PR #155 元数据改为夹具合同形态；无内容差异时不制造 no-op commit。

**Architecture:** 只改 Markdown 与 PR 元数据。主交付物固定路径 `doc/qa/sandbox-notes.md`；
过程文档在 `engineering/doc/FLY-202-sandbox-notes-e2e/`。目录表以 `git ls-tree -d --name-only HEAD`
为准；`ls -R doc/ | head -50` 以本次 checkout 实时输出为准。

**Tech Stack:** Markdown、POSIX shell、Git、GitHub CLI (`gh`)、flywheel-comm

---

## 总则

- 分支：直接用 `project-slot-2-FLY-202`（= 本轮 feature branch），不另建；PR 复用 #155，不新开。
- 全部写操作限于沙箱 clone；零 `packages/` 代码改动；不碰 `doc/FLY-202-qa-sandbox-fixture/`。
- 每完成一个 Task 用 `flywheel-comm progress --phase implement --cursor n/5` 更新账本
  （从仓库根跑；账本 commit 只含 progress.md）。
- 任何 push 失败、gh 失败：重试一次；仍失败 → `flywheel-comm ask` 上报 Lead，不静默。

## Task 0 — 基线核对（硬前置，第一笔 commit 之前）

```bash
git fetch origin main --quiet
git rev-list --count origin/main..HEAD   # ahead：只应含本 issue 的 docs/progress/merge-sync commit + 探针 commit 01f30446f
git rev-list --count HEAD..origin/main   # behind
git ls-remote origin "refs/heads/$(git branch --show-current)"
```

| 情形 | 动作 |
|---|---|
| behind=0，ahead 只含本 issue commit（本轮 design 实测：ahead=7/behind=0） | 直接进 Task 1 |
| behind>0 | `git merge origin/main`（技术同步，不需 ship 审批）；冲突只可能出现在本 issue 文件，按当前分支版本解决 |
| ahead 含大量无关 commit（task#55 形态） | 远端分支**已存在**（本轮实测存在）→ **绝不重写**；`ask` Lead 等裁决（FORCE-PUSH GUARD） |

验收：`git status` clean；behind=0。

## Task 1 — 采集当前快照

```bash
git ls-tree -d --name-only HEAD | sort > /tmp/fly202-dirs.txt          # 预期 17 行（以现场为准）
ls -R doc/ | head -50 > /tmp/fly202-ls.txt                            # 预期 50 行
git log -1 --format='%h %cd' --date=short -- packages/qa-framework/README.md
git log -1 --format='%h %cd' --date=short -- doc/qa/sandbox-notes.md
```

验收：两个快照文件存在；记录 README 与 notes 的最后改动日期。

## Task 2 — 校验现有交付物（verify）

对 `doc/qa/sandbox-notes.md` 跑四项断言（脚本形态，输出 `PASS`/`FAIL <reason>`）：

| # | 断言 | 方法 |
|---|---|---|
| V1 | §1 恰 2-3 段正文 | 首个 `## ` 之前的非空、非标题行按空行分段计数 ∈ {2,3} |
| V2 | §2 表格行集合 == Task 1 目录集合 | 提取 `\| \`name/\` \|` 首列去反引号与尾斜杠，`sort`，与 `/tmp/fly202-dirs.txt` `diff` 为空 |
| V3 | §3 bullet 数 ∈ [8,12]；且 README 最后改动日期 ≤ notes 最后改动日期 | 计数 `^- ` 行；日期比较 |
| V4 | §4 fenced `text` block 内容 == `/tmp/fly202-ls.txt` | `awk` 抽取 block，`diff` 为空 |

分支：
- **四项全 PASS** → 跳到 Task 4（**不改文件、不 commit**）。
- **任一 FAIL** → Task 3 只刷新失败的 section（最小 diff）。

验收：脚本输出明确的 PASS/FAIL 清单，贴进 progress `--next` 或 PR body。

## Task 3 — 条件刷新（只在 Task 2 有 FAIL 时）

- V1 FAIL：重写 §1 为 3 段（要点：隔离靶仓/真 Runner 无 synthetic 模式；安全爆炸半径与 slot
  隔离；一次性基础设施、走 deploy/inject/teardown 脚本、生产不得 pick up）。
- V2 FAIL：按 `/tmp/fly202-dirs.txt` 重建表格，每目录一行英文描述；新增目录须读其内容再写描述。
- V3 FAIL：通读 `packages/qa-framework/README.md`（section：Architecture / Quick Start /
  5-Step Protocol / Config Schema / Test Slot Framework FLY-115 / FLY-60 / Mirror FLY-153 /
  Roundtable + Alert Mirror FLY-529 / Contracts）后重写为 10 条。
- V4 FAIL：用 `/tmp/fly202-ls.txt` 原样替换 fenced block（保留 `Command:` 标签行）。
- 刷新后**重跑 Task 2**，必须四项 PASS。
- 提交：`git add doc/qa/sandbox-notes.md && git commit -m "docs(FLY-202): refresh QA sandbox notes to current snapshot"`。

验收：`git diff --check` 无输出；Task 2 全 PASS。

## Task 4 — PR #155 元数据对齐（不动分支历史）

```bash
gh pr edit 155 --title "docs(FLY-202): QA sandbox fixture notes — slot-2 real-Runner E2E" --body-file <body.md>
```

body 必含：
1. `## Linear Issue` — `FLY-202: QA sandbox fixture — slot harness real-Runner E2E task (do not pick up)` + URL。
2. `## Summary` — 五步交付物状态（本轮是 verify 通过还是 refresh 了哪些 section）。
3. `## Known non-contract file` — `FLY-2182-drill.md`：上一 campaign 探针，保留待 Lead/founder 决定
   （若 Lead 对 design 轮的 ask `ce5d3cd1` 回复「删」，则在 Task 3 位置追加一笔
   `chore(FLY-202): drop FLY-2182 drill probe` 并把本段改为「已剔除」）。
4. `## Test plan` — V1–V4 断言 + 「QA 段重跑 `ls -R doc/ | head -50` 比对」。
5. 尾注 `🤖 Generated with [Claude Code](https://claude.com/claude-code)`。

验收：`gh pr view 155 --json title,body` 含上述段落；base=main、head=project-slot-2-FLY-202 不变。

## Task 5 — push + 收尾

- 若 Task 3 产生了 commit 或账本有新 commit：`git push origin project-slot-2-FLY-202`（fast-forward）。
- 校验 `git rev-parse HEAD` == `gh pr view 155 --json headRefOid --jq .headRefOid`；不等则再 push 一次并复核。
- 等 CI：`gh pr checks 155 --watch`（刚 push 时会先报 no checks，约 1 分钟后出现）。
- 按 dispatch 指定的 route 完成本节点并回报 PR URL；**不 merge、不 approve、不请求 ship**。

验收：HEAD == PR head；CI 绿；节点 complete 输出确认。

## PR-diff 断言（给 QA 节点）

`gh pr view 155 --json files --jq '.files[].path'` 的每一项必须匹配白名单：

```
doc/qa/sandbox-notes.md
doc/FLY-202-qa-sandbox-fixture/**        # 上轮 preserved 设计产物
engineering/doc/FLY-202-sandbox-notes-e2e/**   # 本轮设计产物 + progress
FLY-2182-drill.md                        # 已知探针（除非 Lead 指示剔除）
```

任何 `packages/**`、`scripts/**` 等生产路径出现 = FAIL。

## 风险与对策

| 风险 | 对策 |
|---|---|
| implement 入场时 origin/main 已改 `doc/` 树 | Task 0 merge-sync 后 Task 2 V4 会 FAIL → Task 3 合法刷新 §4 |
| 误把 no-op 当成「必须有产出」再落 commit | Task 2 全 PASS 明确规定跳过 commit；账本 `--next` 写明「verify PASS, no refresh needed」 |
| `gh pr edit` 权限失败 | 重试一次；失败 → ask Lead，PR 内容保持旧版不阻塞 complete |
| Lead 回复「删」探针文件迟到 | implement 每个 Task 边界跑 `flywheel-comm check ce5d3cd1`；complete 前最后查一次 |
| 三段式 QA 节点把 `FLY-2182-drill.md` 判 FAIL | 本 plan 白名单 + PR body 显式声明 |

## QA 段可验证断言（handoff）

1. `doc/qa/sandbox-notes.md` 存在，V1–V4 全 PASS（QA 现场重跑 Task 1 + Task 2）。
2. PR #155 open、base=main、head=分支 HEAD、CI 绿、未 merge。
3. PR 文件全部命中白名单；零生产代码路径。
4. PR body 含 `## Linear Issue` 段与 FLY-202 URL。
