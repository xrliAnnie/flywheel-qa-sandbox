# FLY-2498 Gemini 设计评审 R1 原文 — 评审记录

Issue: FLY-2498 (https://linear.app/geoforge3d/issue/FLY-2498/病根-eng-design-交接后-bridge-会话已-completedcommdb-sessions-行仍-statusrunning)
日期: 2026-09-11
基于: plan.md(commit 17c06331d,manifest rev 2 blob f2f058f1)

运行方式(Lead 指令 485216c1):gemini-cli 0.59.0,隔离 HOME,`security.auth.selectedType=gemini-api-key`,`GEMINI_API_KEY` 取本机 NANOBANANA 付费 key;`gemini -p <prompt> -y --output-format text`,prompt 与 Codex R1 同构(onboarding + 全文 plan + 代码核验指令)。Gemini 拒绝写 /tmp 文件,按 prompt 约定把完整反馈作为最终消息打印;以下为 stdout 原文,一字未改。

处置:无 BLOCKING;两条 ADVISORY 入 plan.md §5 follow-ups。Codex 评审未跑(池全灭,见 exploration §5 / design-review.json residue)。

---

# FLY-2498 plan.md (Gemini Design Review, Round 1)

Date: 2026-09-11
Author: Gemini
Status: APPROVED

## Summary
The proposed implementation plan for **FLY-2498** is exceptionally well-researched, highly elegant, and technically sound. It addresses the root cause of CommDB registration rows remaining in the `running` state after design handovers by introducing window-name-independent absence proof and sealing the rows on close-tmux/reconciliation. By leveraging existing, robust database transactions and death proof primitives, the plan achieves complete correctness with zero schema migrations, zero flags, and minimal risk.

All file paths, function signatures, dependencies, and imports proposed in the plan have been verified against the current state of the workspace.

## What's Good (Keep)
1. **Window-Name Independence**: Distinguishing between registered name liveness and absolute execution liveness (using daemon socket checks, execution markers, and host process checks via `probeExecutionAbsenceBeyondTarget`) perfectly bypasses the stale-mapping traps of **FLY-1319** while maintaining the protective vetoes of **FLY-1329**.
2. **Re-use of Existing Primitives**: Utilizing `finalizePaneLossResidue` and `finalizeCommDbSession` ensures that all related mailbox obligations and asks are retired correctly via established, safe transaction routines without duplicating logic.
3. **Symmetric Execution Coverage**: Having two paths—an immediate, proactive closeout in the `close-tmux` API handler (A) and a periodic reconcile sweep backstop in the residue harvester (B)—is highly comprehensive and robust against any failure state.
4. **Strong Fail-Safe / Fail-Open Defaults**: Wrapping the finalize blocks in try/catch clauses with `console.warn` guarantees that any failure to clean up stale rows will never disrupt the primary execution pipelines or crash the Bridge during boot.

## Issues & Recommendations

### 1. ESM Circular Dependency Risk (ADVISORY)
* **Issue**: Importing `RECONCILE_DELETABLE_STATES` from `commdb-fsm-reconcile.ts` into `commdb-session-prune.ts` creates a circular dependency, as `commdb-fsm-reconcile.ts` already imports `resolveCommDbPath` and `FinalizeCommDbResult` from `commdb-session-prune.ts`.
* **Why it matters**: In ES Modules (ESM), circular constant references can result in uninitialized `undefined` values during module evaluation, potentially leading to boot-time runtime reference errors.
* **Suggested Fix**: Move the declaration of `RECONCILE_DELETABLE_STATES` directly into `packages/teamlead/src/bridge/close-runner.ts`. Since `close-runner.ts` is already a leaf module in this dependency graph and is imported by both `commdb-fsm-reconcile.ts` and `commdb-session-prune.ts`, both files can import it safely from `close-runner.js` without any circular reference risks.

### 2. Dynamic Import of Run Quiescence (ADVISORY)
* **Issue**: The plan mentions dynamic `await import` as an option for introducing `probeExecutionAbsenceBeyondTarget` in `packages/teamlead/src/bridge/plugin.ts`.
* **Why it matters**: Keeping the huge router file `plugin.ts` free of heavy top-level static imports keeps startup fast and avoids complex reference cascades.
* **Suggested Fix**: Explicitly choose the dynamic import pattern inside the reconcile closures in `plugin.ts`, mirroring the pattern already established at line 7564 for `probeRunExecutionLiveness`:
  ```ts
  executionAbsence: async (executionId, project) => {
      const { probeExecutionAbsenceBeyondTarget } = await import("./run-quiescence.js");
      return probeExecutionAbsenceBeyondTarget(store.getSession(executionId), executionId, project);
  }
  ```

## Verdict
**APPROVED** — The implementation plan is complete, correct, and ready to implement. No blocking issues found. Moving `RECONCILE_DELETABLE_STATES` to `close-runner.ts` is highly recommended as a low-risk optimization.
