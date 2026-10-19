# FLY-202 沙箱夹具刷新 — 探索
Issue: FLY-202 (https://linear.app/geoforge3d/issue/FLY-202/qa-sandbox-fixture-slot-harness-real-runner-e2e-task-do-not-pick-up)
日期: 2026-09-26
基于: 无（本轮 design 节点入场审计；上一轮同文件夹文档 2026-07-19 版作历史参照）

---

## 1. 这个 issue 是什么

FLY-202 **不是产品需求，是 QA 基础设施的 fixture（测试夹具：一个专门给测试用的、内容固定的靶子）**。

test-slot E2E 框架（FLY-96 + FLY-115）不提供 synthetic 模式——每个 slot 必须 spawn 一个
**真 Runner** 走完整 pipeline。spawn 需要 `scripts/inject-linear-issue.sh`
（内部 `POST /api/runs/start`）拿到一个真实存在、PreHydrator（Bridge 里负责把 Linear issue
全文拉下来喂给 Runner 的组件）可见的 Linear issue。FLY-197 发现文档引用的 `FLY-SBX-1`
并不存在，FLY-202 就是填这个洞的常驻 fixture issue。

「do not pick up」是对**生产** Lead/Runner 的守卫；本 session 是 slot-2 harness 有意
spawn 的沙箱 Runner，属于该 issue 的预期消费者。

## 2. 本轮任务（issue 原文五步，不加戏）

1. 创建 `doc/qa/sandbox-notes.md`，2-3 段说明 `flywheel-qa-sandbox` 仓库的用途。
2. 追加一张表：仓库每个顶层**目录** + 一行描述。
3. 追加一节：`packages/qa-framework/README.md` 的 ~10 条 bullet 摘要。
4. 运行 `ls -R doc/ | head -50`，输出放进 fenced block。
5. 在 feature branch 上 commit，向 sandbox 仓库 main 开 PR。

任务刻意「小、稳、多步」——给 QA harness 一个可观测的 mid-work 窗口。

## 3. 本轮入场审计（2026-09-26，slot-2，exec `3adb1bf6`，run `0c34ae91`）

这是一次 **re-dispatch（重派）**：worktree 延续 `origin/project-slot-2-FLY-202@a50b4a6`，
带一个已开的 PR #155。按 BRANCH CONTINUITY 规则先盘点再动手，逐条机器核验：

| 核验项 | 结果 |
|---|---|
| 远端 | `xrliAnnie/flywheel-qa-sandbox`（沙箱仓，非生产仓） |
| 分支 | `project-slot-2-FLY-202`，HEAD `a50b4a63e` == 远端同名分支 == PR #155 head |
| 相对 `origin/main` | ahead=7 / behind=0（无漂移，无需 Task 0 重锚） |
| PR #155 | OPEN，base=main，CI 两个 job 全绿（Build & Test / FLY-1062 payload） |
| `doc/qa/sandbox-notes.md` | **已存在**（2026-09-13 刷新），四个 section 齐全 |
| §2 目录表 | 17 行 == `git ls-tree -d --name-only HEAD` 17 个 tracked 顶层目录 |
| §3 摘要 | 恰 10 条 bullet；README 最后改动 2026-07-15 早于 notes 刷新，摘要未过期 |
| §4 fenced block | 与本轮现场 `ls -R doc/ \| head -50` **逐字节相同** |
| PR diff vs main | 4 文件：`sandbox-notes.md`、上轮 doc 文件夹 progress/workflow-output、**`FLY-2182-drill.md`（仓库根一行）** |

**结论：五步交付物在分支上已经完工且仍是最新快照。** 本轮 design 的价值不是重新发明
五步，而是：① 把「重派续跑」的判定规则写成 implement 节点可机器执行的合同
（verify-then-refresh，无差异不落 no-op commit）；② 把本轮发现的两处「非合同内残留」
定性并交给 Lead；③ 按本轮 dispatch 合同补齐 doc-flow 落点与 founder HTML。

## 4. 两处需要定性的残留

### 4.1 `FLY-2182-drill.md`（仓库根，1 行）
来自 commit `01f30446f chore(FLY-202): FLY-2182 replacement drill instrument`，PR #155 标题
也是 `FLY-2182 QA replacement drill`。它是上一个 campaign（FLY-2182 529 real-codex replacement
drill）留下的**探针文件**，不是 FLY-202 五步合同的产物；但它是 preserved work，
BRANCH CONTINUITY 禁止回滚。

**本轮定性**：不删、不改、如实上报。是否在 ship 前剔除由 Lead 决定（非阻塞 ask）。
plan 里 PR-diff 断言从「docs-only」放宽为「docs-only + 已知探针文件白名单」，
白名单只有这一个文件，避免 QA 节点把它当 FAIL。

### 4.2 两套 FLY-202 设计文件夹并存
- `engineering/doc/FLY-202-sandbox-notes-e2e/`（2026-07-19 轮，doc-flow 规定落点，本文件夹）
- `doc/FLY-202-qa-sandbox-fixture/`（2026-08 至 09 轮，含上一版 design.html + 4 张 SVG）

本轮 dispatch 明确：Folder = `engineering/doc/FLY-202-<slug>/`，且**复用**已有 FLY-202- 前缀
文件夹 → 本轮全部产物落 `engineering/doc/FLY-202-sandbox-notes-e2e/`。
`doc/FLY-202-qa-sandbox-fixture/` 保持原样（preserved work，且它在 `ls -R doc/` 的前 50 行里，
删/改会连带让 §4 快照失真）。合并两套文件夹 = 单独的清理 issue，不在本节点范围。

## 5. 关键前提（相对 2026-07-19 轮的变化）

- `doc/qa/sandbox-notes.md` 从「不存在，干净新建」变为「存在且最新」→ implement 语义
  从 create 变为 **verify-then-refresh**。
- 本轮 runner env 已注入 `FLYWHEEL_INGEST_TOKEN`（2026-08-29 轮缺失导致 await-codex-gate
  过不了）→ 设计评审门有机会真正收口，plan 按正常流程走并保留 fail-closed 上报路径。
- `pipeline.three_stage: true`，本节点 = design 段；implement 段在同一分支继续；
  QA 段最后验证。本节点不实现、不 merge、不请求 ship。

## 6. 边界

- 一切写操作留在沙箱 clone（`/private/tmp/flywheel-test-slot-2/project-slot-2-FLY-202`）。
- 不碰生产资源；不 merge PR（ship 由 founder gate 决定，不属于任何 runner 节点）。
- 设计产物提交会推动 PR #155 head 前移并重跑一轮 CI——这是合同要求的必要代价
  （设计文档必须随分支进 PR），implement 节点不再额外制造 no-op commit。
