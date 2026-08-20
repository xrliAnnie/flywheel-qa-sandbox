# Design Review — plan.md (Round 17)

Date: 2026-08-20
Author: Codex
Status: APPROVED

## Summary

Round 17 closes all four Round 16 findings and both deletion candidates. `7270491` is the current HEAD; the authoritative plan changed by 24 additions / 20 deletions relative to `6689dea`, and the worktree version is byte-identical to the committed plan.

The narrowed design is now coherent and ready to implement. P0 retains the existing lifecycle authority fence and bounded teardown contract; P1 has capability-based acceptance plus a non-clobbering three-way rollback; P2 is a consumer-free, audit-only census with candidate-relevant health and measurable 14-day coverage; P3 is a one-shot quarantine operation whose post-rename uncertainty stops all further profile mutation and leaves recovery to an operator. The classifier has one source, four supported shapes and only the two callers that need it. Nothing removed by the R15 scope cut is needed by the remaining legs.

I found no HIGH or MEDIUM issue. One LOW, non-blocking documentation cleanup remains: the §9 P1 risk summary still abbreviates divergent-SHA rollback as “只恢复该 key”, omitting the third-value conflict branch that §5.2 and its tests define unambiguously. The census TDD labels also appear in 6b / 6d / 6c order. Neither gives the implementation an unresolved safety choice because the normative table and terminal-state tests are explicit.

## Verified against code

| claim | verdict | evidence |
|---|---|---|
| `7270491` is the authoritative Round 17 plan | VERIFIED | Current HEAD is `7270491c22938f3b458c0091b1ceb9e135a63a02`; `git diff 7270491..HEAD -- plan.md` is empty; `git diff --check 6689dea..7270491 -- plan.md` passes. |
| Round 16 HIGH-1: automatic rename-back is gone | CLOSED | `plan.md:429-436,453-466,478-490,631` has no `race_rolled_back` action. Post-rename hit/error records `operator_required`, prints exact recovery context, stops later entries, exits nonzero and performs no automatic rename-back. A repository-wide plan grep finds no stale `race_rolled_back`. |
| The reason for deleting rename-back matches macOS semantics | VERIFIED | The local `rename(2)` man page states that an existing target is first removed and that `RENAME_EXCL` is the no-replace variant. `plan.md:464` now records the check-absent/rename TOCTOU and deliberately avoids adding a native helper. |
| P3 post-check and final deletion remain fail-closed | VERIFIED | `plan.md:429-450,483-490` preserves the existing recursive `lsof +D` rule, stops on hit/error, and requires exact path, canonical root, non-symlink, owner, ledger and empty lsof before `--delete-quarantine`. The lsof emptiness semantics match `flywheel-log-janitor.sh:795-829`. |
| Round 16 MEDIUM-2: divergent-SHA rollback is a key-level three-way decision | CLOSED | `plan.md:545-553` defines: current key equals applied value → restore receipt preimage; equals preimage → no-op; third value/type mismatch → `rollback_conflict`, zero writes, nonzero. Repeated apply is a no-op that preserves the first receipt. Four terminal states are pinned by tests. |
| P1 writer still reuses the established file defenses | VERIFIED | `setup-mcp-on-demand.sh:21-68` provides the cited symlink refusal, corrupt-JSON refusal, change-only backup, mode preservation and same-directory atomic replacement pattern. Round 17 adds no new public writer mode. |
| Round 16 MEDIUM-3: census health is candidate-relevant | CLOSED | `plan.md:277-288,363-376` makes whole-batch sensor failure, plausible target-row join loss and cache-version reader failure unknown, while unrelated cross-pass PID churn remains ok. Tests separately cover target-field loss and a non-empty unrelated-short-lived-PID fixture. |
| Candidate-relevant health is necessary against the current implementation seam | VERIFIED | `chrome-session-reaper.ts:153-267` obtains comm, cmd/ppid and age/lstart through three independent `ps` passes; primary failure currently returns an empty result at `:492-508`. The new census module therefore correctly owns a separate health status instead of inheriting legacy empty-on-failure behavior. |
| Census remains structurally unable to signal or alert | VERIFIED | `plan.md:277-287,369-375,655` keeps a separate `playwright-orphan-census.ts` with only read-only sample/clock/version/ledger capabilities, a summary-only periodic return and a static guard over imports/signature/call site. `StateStore.insertEvent()` still only inserts/saves (`StateStore.ts:5584-5611`); JSONL remains a separate consumer-free domain. |
| Round 16 LOW-4: classifier callers and shapes are consistent | CLOSED | `plan.md:269,301-335,653-655` says four shapes and P0/P3 only; operator `--once` uses the Chrome census parser/sweep-health entry. Grep finds no stale five-shape, three-caller or “same classifier” claim. |
| The lexical/canonical classifier rule still matches this machine | VERIFIED | The installed `.bin/playwright-mcp` is still the package-local symlink `../@playwright/mcp/cli.js`; realpath resolves to the same `@playwright/mcp` package, version 0.0.79. The official playwright plugin identity remains enabled; Round 17 does not alter it. |
| P0 authority and fail-closed lifecycle dependency remain intact | VERIFIED | Current source still has `McpReapDeps.authorityCheck` and sticky loss in `mcp-descendant-reaper.ts:137-204`; `close-runner.ts:673-698` passes `authorityLostReason()` and blocks outer teardown when the reaper observes loss. `plan.md:76,110,138-145` preserves this contract. |
| P1 acceptance remains capability-based | VERIFIED | `plan.md:232-249,494-531` still requires target Chrome PID layer-0 on-screen windows = 0, founder Chrome positive control > 0 and session UA corroboration, with separately preregistered WebGL validation. It does not regress to argv substring or env-presence acceptance. |
| R15 scope cut and reopen criteria remain falsifiable | VERIFIED | `plan.md:353-376,663-688` requires P0 deployment, 14 daily ok coverage rows and a numeric multi-day candidate rule (or explicit operator sign-off), while retaining the six-item descope record and forbidding automatic resurrection of those mechanisms. |

## What's Good (Keep)

- Keep P0's three-way pre-signal conjunction, sticky lifecycle authority loss, `pid+lstart+command`, three bounded phases and `confirmedGone` terminal semantics.
- Keep P1 limited to `PLAYWRIGHT_MCP_HEADLESS`, with CoreGraphics capability acceptance, positive control, WebGL preregistration and receipt-aware two-entry writer.
- Keep the census in a separate consumer-free module with no store/notifier/signal/kill capability, daily coverage heartbeat, explicit unknown rows and candidate-relevant joins.
- Keep P3 one-shot and operator-reviewed: committed manifest, narrow mtime gate, pre/post-rename lsof, stop-on-uncertainty, default no deletion and guarded explicit delete mode.
- Keep the four-shape classifier only for P0 and P3, with a real symlink fixture and built-dist freshness check.
- Keep `--isolated`, official-plugin replacement, supervisor/barrier/shim/content-hash machinery and janitor integration out of scope.

## Issues & Recommendations

1. **LOW (non-blocking) — synchronize two summary/editorial lines with the already-correct normative contract.**

   **Issue:** `plan.md:623` still summarizes divergent-SHA rollback as “不符只恢复该 key 的 preimage 值”, while `plan.md:548,553` correctly adds the no-op and `rollback_conflict` branches. Census TDD labels are ordered 6b, 6d, 6c at `plan.md:371-373`.

   **Why it matters:** This does not leave an implementation decision open—the normative table and tests are precise—but keeping summaries exact will make later reviews and operational reading cheaper.

   **Concrete fix:** When next touching the document, change the §9 shorthand to “SHA 分叉后按 key 三方比较：applied→restore、preimage→no-op、third→conflict” and reorder the labels to 6b, 6c, 6d. No implementation or scope change is required.

## Deletion candidates

None. The unsafe automatic rename-back and the stale census/classifier coupling are gone. The remaining census health/heartbeat, guarded quarantine deletion, dist freshness, P1 rollback receipt and WebGL QA each close a real stated-scope hole; deleting any of them would reopen an accepted contract. None of the six R15-cut mechanisms should return.

## Verdict

APPROVED — ready to implement
