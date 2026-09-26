# FLY-202 QA 沙箱 fixture 笔记 — 探索
Issue: FLY-202 (https://linear.app/geoforge3d/issue/FLY-202/qa-sandbox-fixture-slot-harness-real-runner-e2e-task-do-not-pick-up)
日期: 2026-09-26
基于: 无（本轮 re-dispatch 任务描述 + 分支 `origin/project-slot-4-FLY-202@2ba0c9e` + PR #194）

---

## 1. 这个 issue 是什么

FLY-202 **不是产品需求，是 QA 基础设施的 fixture（测试夹具）**。test-slot E2E 框架
（FLY-96 + FLY-115）没有 synthetic 模式——每个 slot 必须 spawn 一个真 Runner 走完整
pipeline，而 spawn 需要一个真实存在、PreHydrator 可见的 Linear issue
（`scripts/inject-linear-issue.sh` → `POST /api/runs/start`）。FLY-197 发现文档里的
`FLY-SBX-1` 并不存在，FLY-202 就是补这个洞的常驻 fixture。

「do not pick up」约束的是**生产** Lead/Runner；本 session 是 test-slot-4 harness 有意
spawn 的沙箱 Runner（exec `814e38bd`，DAG 节点 `eng_design`），属于预期消费者。

## 2. 任务（issue 原文五步）

1. 新建 `doc/qa/sandbox-notes.md`，2-3 段说明 `flywheel-qa-sandbox` 的用途。
2. 追加表格：仓库每个顶层**目录** + 一行描述。
3. 追加一节：`packages/qa-framework/README.md` 的 ~10 条 bullet 摘要。
4. 跑 `ls -R doc/ | head -50`，输出放进 fenced block。
5. 在 feature branch 上 commit，向 sandbox 仓库 main 开 PR。

## 3. 本轮的关键前提：这是「续跑」，不是「从零做」

| 事实 | 值 |
|---|---|
| 分支 | `project-slot-4-FLY-202`，继承 `origin/...@2ba0c9e` |
| 开放 PR | #194 `docs(FLY-202): refresh QA sandbox fixture notes (do not merge)` |
| 相对 main 的 diff | 3 文件：`doc/qa/sandbox-notes.md`、`doc/FLY-202-qa-sandbox-fixture/{progress.md,workflow-output.json}` |
| 产物现状 | `sandbox-notes.md` 已含全部四个 section，五步都已落地 |

也就是说前一轮（implement 4/4）已经把五步做完并开了 PR。本轮 design 节点的价值是：
**证明现有产物在当前 tip 上仍然成立**，并给 implement 节点一份「先验证、只在漂移时
修改」的执行合同，而不是重写一遍制造无意义的 diff。

## 4. 发现的两个需要设计决定的点

1. **两个 FLY-202 文档文件夹并存**：main 上有旧的 `doc/FLY-202-qa-sandbox-fixture/`
   （早期轮次，含旧 design HTML）和 doc-flow 规范位置
   `engineering/doc/FLY-202-sandbox-notes-e2e/`（`doc_flow.default_department: engineering`）。
   DOC-FLOW 规则要求复用 `engineering/doc/FLY-202-*` → 本轮所有过程文档落后者。
2. **`ls -R doc/` 自我干扰**：step 4 的快照覆盖 `doc/` 前 50 行，而旧文件夹
   `doc/FLY-202-qa-sandbox-fixture/` 恰好在这 50 行里。任何节点往 `doc/` 下**新增文件**
   都会让快照过期。把新过程文档放在 `engineering/doc/` 正好避开这个坑。

## 5. 边界

- 所有写操作限于沙箱 clone（`/private/tmp/flywheel-test-slot-4/project-slot-4-FLY-202`）。
- 不碰生产资源；不 merge、不请求 ship、不 force-push；不 dispatch 后继节点。
- design 节点不改 `doc/qa/sandbox-notes.md`（那是 implement 的事）。
