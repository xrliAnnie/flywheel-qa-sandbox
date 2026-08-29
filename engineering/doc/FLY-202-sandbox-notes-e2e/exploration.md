# Exploration: QA Sandbox Fixture — slot-2 real-Runner E2E（sandbox-notes 重建轮）— FLY-202

**Issue**: FLY-202 — https://linear.app/geoforge3d/issue/FLY-202/qa-sandbox-fixture-slot-harness-real-runner-e2e-task-do-not-pick-up
**Date**: 2026-07-19
**基于**: 本轮 dispatch 任务描述 + 历史轮次（sandbox PR #29/#30/#57、exec 48a781ff 等）设计文档

---

## 1. 这个 issue 是什么

FLY-202 **不是产品需求，是 QA 基础设施的 fixture（测试夹具）**。

test-slot E2E 框架（FLY-96 + FLY-115）不支持 synthetic 模式——每个 slot 必须 spawn 一个
**real Runner** 走完整 pipeline。spawn 需要 `scripts/inject-linear-issue.sh`
（内部 `POST /api/runs/start`）拿到一个真实存在、PreHydrator 可见的 Linear issue。
FLY-197 发现文档引用的 `FLY-SBX-1` 并不存在，FLY-202 就是填这个洞的常驻 fixture issue。

「do not pick up」是对**生产** Lead/Runner 的守卫；本 session 是 slot-2 harness 有意
spawn 的沙箱 Runner，属于该 issue 的预期消费者。

## 2. 本轮的具体任务（issue 原文五步）

1. 创建 `doc/qa/sandbox-notes.md`，2-3 段说明 `flywheel-qa-sandbox` 仓库的用途。
2. 追加一张表：仓库每个顶层**目录** + 一行描述。
3. 追加一节：`packages/qa-framework/README.md` 的 ~10 条 bullet 摘要。
4. 运行 `ls -R doc/ | head -50`，输出放进 fenced block。
5. 在 feature branch 上 commit，向 sandbox 仓库 main 开 PR。

任务刻意「小、稳、多步」——给 QA harness 一个可观测的 mid-work 窗口。

## 3. 关键前提变化（相对上一轮）

- `doc/qa/sandbox-notes.md` 在当前分支 tip（`7049f719`）**不存在**：#29 创建、#30 刷新，
  随后 #58（FLY-1286 大规模 tree 同步）把它移除了。所以本轮 step 1 是**干净新建**，
  不是刷新——无合并冲突包袱。
- 本 sandbox clone 现在带 `.flywheel/config.yaml`，`doc_flow.enabled: true`、
  department=engineering → 过程文档落 `engineering/doc/FLY-202-sandbox-notes-e2e/`
  （旧轮次的 `doc/qa/exploration/FLY-202/`、`docs/superpowers/plans/` 位置已过时）。

## 4. 边界

- 一切写操作留在沙箱 clone（`/private/tmp/flywheel-test-slot-2/project-slot-2-FLY-202`）。
- 不碰生产资源；不 merge PR（ship 由 founder gate 决定，不属于任何 runner 节点）。
- 三段式:本文档属 design 段;implement 段在同一分支继续;QA 段最后验证。
