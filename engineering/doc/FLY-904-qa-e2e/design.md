# Design: FLY-887 R2 real-machine 529 Room verification — FLY-904

**Issue**: FLY-904 (QA E2E scratch — FLY-887 R2 real-machine 529 Room verification, FLY-902 disposable)
**Issue URL**: https://linear.app/geoforge3d/issue/FLY-904/qa-e2e-scratch-fly-887-r2-real-machine-529-room-verification-fly-902
**Date**: 2026-07-06
**基于**: 沙箱快照 `1201eec`(FLY-887 R2 approved @ d3faf54e,分支 `project-slot-2-FLY-904`)、FLY-895/FLY-896 前例(`engineering/doc/FLY-895-qa-e2e/design.md` @ 分支 `project-slot-2-FLY-895`)、`engineering/doc/FLY-887-phase-session-keepalive/`
**Status**: brainstorm-gate approved(Lead flywheel-test-2,四点合同确认)+ design review self-approved(理由见下)

## Design(合并 exploration / research / plan,最小档)

- **目的**:FLY-904 是 FLY-902 独立 QA 建的一次性 scratch issue,在隔离的 529 QA Testing Room slot-2 驱动一次真机三阶段 pipeline E2E,验证 FLY-887 的 keep-alive fix-loop、design-redo、ship-cleanup 三个场景。真正的交付物是 pipeline 行为本身,仓库改动刻意最小。
- **Implement 合同(最小真实改动)**:本快照没有 `doc/qa/sandbox-notes.md`(FLY-895 的改动不在此 orphan 快照里)——新建该文件,含 `## E2E run log` 节 + 单行条目:`2026-07-06 — FLY-904 slot-2 FLY-887 R2 real-machine 529 Room verification (FLY-902 independent QA).`。单文件、doc-only、一次 commit,在共享分支 `project-slot-2-FLY-904` 上开 PR 到沙箱 main。
- **QA 合同**:结构性验证条目存在且准确(节名 `## E2E run log` + 日期 `2026-07-06` + issue 号 `FLY-904`/`FLY-902`);如 harness 指示,按 FLY-895/FLY-202 先例插入一轮 deliberate FAIL→wake→fix→re-test→PASS 的 fix-loop。
- **流程裁剪(Lead 已批)**:Codex design review self-approve;doc-only 无运行时 UI → founder-UX gate N/A;TDD 豁免(无运行时面),以 QA 结构性检查代替。
- **三阶段协议**:Design/Implement/QA 全部在共享分支 `project-slot-2-FLY-904` 上;Design 阶段只提交本文档 + progress.md,然后 `complete --route phase_design_complete` → `park` 停驻为设计上下文持有者,Bridge 在 ship 后关闭。

## Self-approve rationale

Doc-only、单行级沙箱 fixture 改动,无架构面与运行时面;brainstorm gate 中 Lead(flywheel-test-2)已明确批准跳过 Codex design review,self-approved。
