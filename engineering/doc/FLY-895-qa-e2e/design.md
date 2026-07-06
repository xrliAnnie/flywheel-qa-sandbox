# Design: FLY-887 three-stage keepalive Discord narrative redo — FLY-895

**Issue**: FLY-895 ([QA-E2E artifact] FLY-887 three-stage keepalive Discord narrative redo — do not pick up)
**Date**: 2026-07-05
**基于**: 沙箱快照 `c34b230`（分支 `project-slot-2-FLY-895`）、FLY-202 先例（`doc/qa/FLY-202-sandbox-notes/` + PR #49）、`engineering/doc/FLY-887-phase-session-keepalive/`

## Design（3-5 bullets）

- **目的**：FLY-895 是 FLY-887 三阶段 keep-alive E2E 的 timing-controlled redo，真正的交付物是给 Annie 看的那条完整 Discord 叙事线（Design→Implement→QA→fix-loop→Bridge-restart→ship），仓库改动本身刻意最小。
- **Implement 合同（最小真实改动）**：在 `doc/qa/sandbox-notes.md` 末尾追加一节 `## E2E run log`（若无则创建该节），加一行本次 re-run 条目：`2026-07-05 — FLY-895 slot-2 redo of the FLY-887 keep-alive E2E (Discord narrative)`。单文件、doc-only、一次 commit，然后按共享分支开 PR 到 sandbox main。
- **QA 合同**：结构性验证该条目存在且内容准确（章节名 + 日期 + issue 号）；如 harness 指示，再按 FLY-202 先例走一轮 deliberate FAIL→wake→fix→re-test→PASS 的 fix-loop。
- **流程裁剪**：跳过多轮 brainstorm 与 Codex design review（self-approve，理由见下）；纯沙箱 doc 任务不触发 founder-UX gate；TDD 豁免（无运行时面），以 QA 结构性检查代替。
- **三阶段协议**：Design/Implement/QA 全部在共享分支 `project-slot-2-FLY-895` 上；各阶段之间按 FLY-887 park 协议停驻（`complete --route phase_design_complete` → `park`），Bridge 在 ship 后关闭。

## Self-approve rationale

Doc-only、单行级沙箱 fixture 改动，无架构面与运行时面；per team-lead timing 指令跳过 Codex design review，self-approved。
