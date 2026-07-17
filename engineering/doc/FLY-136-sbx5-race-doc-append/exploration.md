# Exploration: FLY-SBX-5 — 5-spawn race 最小 doc 改动 — FLY-136

**Issue**: FLY-136 ([Sandbox] FLY-SBX-5 — dummy issue for FLY-128 5-spawn race testing)
**URL**: https://linear.app/xrli/issue/FLY-136
**Date**: 2026-07-17
**Status**: Complete
**基于**: sandbox 仓 `xrliAnnie/flywheel-qa-sandbox` @ `7049f719`,分支 `project-slot-3-FLY-136`

## 任务理解

FLY-136 是 QA 沙箱 issue(FLY-SBX-5),与 FLY-124(FLY-SBX-1)同族,专供 FLY-128
的 5-Runner 并发 spawn race 测试。issue 本体是 dummy,**真正被测的是管线本身**:
5 个 Runner 并发跑 onboard → design → implement → PR → approve → ship 全链。

Runner 侧的预期产出极简:在 sandbox 仓对 `README.md` 或 `CLAUDE.md` append 一行
(doc-only),开 PR,等 approve,ship + merge。

## 硬约束(issue DO-NOT 区)

1. **不关 issue** — FLY-136 永久保持 open,QA 套件复用。
2. **不做真实工作** — 改动仅限一行 doc append。
3. **不改 scope** — QA 依赖 spec 稳定,不扩写、不重构。

## 关键发现与选择

### README.md 已不存在 → 落点选 CLAUDE.md

issue 写的是 "append one line to README.md **or** CLAUDE.md"。仓库现状:
`README.md` 已被最新 commit `7049f719`(FLY-1286 E2E)删除,仓库根只剩
`CLAUDE.md`。issue 本身给了二选一,故落点定为 **CLAUDE.md**,无需向 Lead 升级
(不构成 major ambiguity)。

### 行内容形态:milestone 表行(跟随兄弟先例)

同族 sandbox 先例:

| 先例 | 改动 | 备注 |
|------|------|------|
| FLY-124 (SBX-1) `e03d7ae9` | README.md +1 行("Hi") | 当时 README 还在 |
| FLY-133/134/135/138 `3311814a` 等 | CLAUDE.md milestone 表 +1 行 | `| FLY-138: … — milestone record | ✅ Merged |` |

当前 CLAUDE.md(主仓镜像,342 行)存在 `| Milestone | Status |` 表(line 39 起)。
选择**在该表末尾插一行 milestone record**:与 4 个兄弟先例形态一致、审查友好
(approve gate 人眼一看即懂)、且表格数据行对 CLAUDE.md 的指令语义零影响
(相比在文件尾 append 裸文本,不会被后续 agent session 误读成指令)。

### 5-spawn race 下的 merge conflict 预案

5 个 sibling Runner(SBX-1..5)可能同时改同一文件同一区域,后 merge 的 PR 会撞
textual conflict。这不是本次要修的问题(race test 测的是 spawn,不是 merge),
处理方式写进 plan:**ship 前 rebase main,冲突时保留双方行(union),自己的行
维持插在表末**。先例 FLY-133/134/135/138 四连发就是这么依次落地的。

## 结论

设计收敛为单一最小方案,无备选歧义,直接进 plan(见 [plan.md](./plan.md))。
