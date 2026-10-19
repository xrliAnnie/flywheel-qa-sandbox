# FLY-202 沙箱夹具刷新 — 调研
Issue: FLY-202 (https://linear.app/geoforge3d/issue/FLY-202/qa-sandbox-fixture-slot-harness-real-runner-e2e-task-do-not-pick-up)
日期: 2026-09-26
基于: exploration.md（同文件夹）；全部数值为本轮对 HEAD `a50b4a63e` 的现场实测

---

## 1. Git / 分支 / PR 事实

| 事实 | 值 |
|---|---|
| 工作目录 | `/private/tmp/flywheel-test-slot-2/project-slot-2-FLY-202` |
| origin | `https://github.com/xrliAnnie/flywheel-qa-sandbox.git` |
| 当前分支 | `project-slot-2-FLY-202`；远端同名分支存在且 == 本地 HEAD（`a50b4a63e`） |
| 相对 origin/main | ahead=7 / behind=0；ahead 全是本 issue 的 docs/progress/merge-sync commit + 1 个探针 commit |
| PR #155 | OPEN，`main <- project-slot-2-FLY-202`；标题 `FLY-202: FLY-2182 QA replacement drill`；body 一句话，**无** `## Linear Issue` 段 |
| PR 文件 | `FLY-2182-drill.md`、`doc/FLY-202-qa-sandbox-fixture/{progress.md,workflow-output.json}`、`doc/qa/sandbox-notes.md` |
| CI | `Build & Test` pass（7m11s）、`FLY-1062 payload distribution` pass（39s） |

**结论**：不需要 Task 0 重锚；分支就是本轮 feature branch；PR 复用 #155，不新开。
PR 标题/body 是上一 campaign 留下的，与 FLY-202 五步合同不匹配 → implement 段用
`gh pr edit` 改成夹具合同形态（标题 + `## Linear Issue` + 变更摘要 + test plan），
这是元数据改动，不动分支历史。

## 2. 交付物现状（`doc/qa/sandbox-notes.md`，2026-09-13 刷新）

| section | 现状 | 本轮现场核验 |
|---|---|---|
| §1 用途说明 | 3 段英文 | 合同要求 2-3 段 ✓ |
| §2 顶层目录表 | 17 行 | `git ls-tree -d --name-only HEAD` = 17 个（`.claude .flywheel .github .lead .serena agents doc docs engineering fleet packages patches product qa-fly294 qa-fly310 scripts supabase`）✓ |
| §3 README 摘要 | 10 条 bullet | README 最后改动 `7049f7199` 2026-07-15 < notes 刷新日期 → 未过期 ✓ |
| §4 `ls -R doc/ \| head -50` | fenced `text` block，50 行 | 与现场输出 `diff` **IDENTICAL** ✓ |

**结论**：五步交付物完整且为当前快照。若 implement 段入场时四项复核仍全 ✓，
**不改文件、不落 no-op commit**（memory ⑦：no-op commit 会把 PR head 推离绿 CI 并制造
head 漂移死锁风险）。

## 3. 目录表口径：`git ls-tree` 而非 `ls`

- 2026-07 轮用 `find -maxdepth 1 -type d` 得 12 个可见目录；2026-08/09 轮改为
  `git ls-tree -d --name-only HEAD` 得 17 个（多出 5 个 tracked 隐藏目录 `.claude .flywheel
  .github .lead .serena`）。当前文件已是 17 行口径。
- issue 原文「every top-level directory in the repo」——tracked 隐藏目录也是仓库目录，
  且 `git ls-tree` 天然排除未跟踪杂散项（如历史上出现过的 `=` 文件、`node_modules`）。
- **本轮沿用 `git ls-tree` 口径**（与已提交内容一致，避免无意义 diff）。

## 4. `ls -R doc/` 稳定性分析（§4 快照能否保持不变）

`ls -R doc/ | head -50` 的前 50 行覆盖：`doc/` 顶层 9 项 → `doc/FLY-145-…`（10 文件）→
`doc/FLY-202-qa-sandbox-fixture`（13 文件）→ `doc/architecture`（9 项）→ `doc/architecture/archive` 首行。

- 本轮设计产物落 `engineering/doc/…`，**不在 `doc/` 树内** → 快照不受影响。
- `doc/FLY-202-qa-sandbox-fixture/` 若被增删文件，快照立刻失真 → 本轮**不碰**该文件夹。
- 若 implement 入场时 `origin/main` 又合并了改 `doc/` 的 PR 且 implement 做了 merge-sync，
  快照会变 → 这才是「需要刷新 §4」的合法触发条件。

## 5. `FLY-2182-drill.md` 探针文件

| 事实 | 值 |
|---|---|
| 内容 | 一行文本 `FLY-2182 QA replacement drill instrument` |
| 来源 commit | `01f30446f chore(FLY-202): FLY-2182 replacement drill instrument`（2026-09 slot-2 FLY-2182 drill） |
| 在 PR #155 里 | 是（4 文件之一） |
| 与五步合同关系 | 无；属上一 campaign 的 QA 探针（用来验证 529 real-codex replacement 时的 PR 存在性） |

处置选项：
- (a) 保留，如实上报，PR-diff 断言白名单化 —— **本轮选择**（BRANCH CONTINUITY：不回滚 preserved work；
  删除与否是 Lead/founder 的 ship 决策，非 runner 节点自决）。
- (b) implement 段删除 —— 仅当 Lead 在非阻塞 ask 中明确回复「删」才做。

## 6. 设计评审门与本轮 env

| 项 | 值 |
|---|---|
| `FLYWHEEL_BRIDGE_URL` | `http://localhost:19872`（slot-2 沙箱 Bridge，健康） |
| `FLYWHEEL_INGEST_TOKEN` | **已注入**（2026-08-29 轮缺失；本轮 await-codex-gate 有条件收口） |
| `FLYWHEEL_EXEC_ID` | `3adb1bf6-bcc2-4c5d-b1ec-1d39e8724c9f` |
| 作者族 | Claude → `request-review --type design` 会 409（reviewer-inversion 守卫）；走 `stage set design_review --plan` → mailbox manifest → `/codex-design-review` → `design-review.json` → `await-codex-gate design` |
| mmdc | `/opt/homebrew/bin/mmdc` 11.12.0，可本地渲染 SVG |
| publish-report | slot-2 历史上 401（runner env 无 reports apiToken）；按合同上报 `DESIGN-HTML publish-failed`，不重试循环 |

## 7. doc-flow 落点

- `.flywheel/config.yaml`：`doc_flow` 开启、`default_department: engineering`、`pipeline.three_stage: true`。
- 本轮全部设计产物（exploration/research/plan/progress/HTML/mmd/svg）→ `engineering/doc/FLY-202-sandbox-notes-e2e/`。
- `doc/FLY-202-qa-sandbox-fixture/` 保留原样（见 §4）。
