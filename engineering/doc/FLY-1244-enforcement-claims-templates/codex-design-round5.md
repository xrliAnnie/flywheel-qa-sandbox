# Design Review — FLY-1244 plan.md (Round 5)
Date: 2026-07-14
Author: Codex
Status: CHANGES REQUESTED

## Summary

Round 5 closes the substantive Option B security and rollout contradictions from Round 4. The decision-capability token and submission credential now have honest persistence contracts; passive harvest is described as blast-radius reduction rather than isolation; the actual production rollout is READ off plus FORCE; and future production READ explicitly requires both fresh-spawn E2E and peer-credential/separate-principal hardening. I accept that governance and threat model.

The credential schema, composite binding FK, head-authority endpoint, phase-safe re-QA flow, template triggers/override allowlist, projector direction, and doc-first umbrella/research changes are also materially stronger. The overall architecture is feasible with the current packages and no further governance decision is needed.

The plan is still not internally consistent enough to approve, though. One authorization-critical term—“current admitted QA attempt”—has no schema field or exact derivation in the current StateStore, so the supposedly executable stale-execution predicate stops one step short of an implementable query. The template audit CHECK rejects the required run-override audit action, and merging `skip` into a snapshot conflicts with the manifest's unknown-key rule. Finally, several projector and closed-decision lines that the Round 5 summary says were removed remain verbatim in the plan and contradict the new contracts.

These are four compact, bounded edits. They do not reopen the architecture, transport decision, or scope split.

## What's Good (Keep)

- Keep the corrected persistence vocabulary: only the decision-capability token is memory-only; Option B submission plaintext may appear in shell snapshots.
- Keep the precise passive-harvest statement and the explicit TTL-window PASS-forgery limitation.
- Keep production READ disabled in this sub-issue and FORCE as its actual deployment path; keep peer-credential hardening as a future production-READ prerequisite.
- Keep the Option B-only credential table, non-null hash, composite FK, capability/claim linkage, and exact replay transaction.
- Keep the immutable execution-binding table and the requirement that both claim attempt and issuer execution match the current authorized execution.
- Keep the Bridge-owned head resolver, comparison-only CLI head, per-sink integration matrix, and H1-vs-authoritative-H2 test.
- Keep founder challenge-generation validation at USE time and the phase-safe design/implement/QA rollout classifications.
- Keep executable template triggers/CHECKs, the restricted override allowlist, full post-override validation, resolved-family comparator, and generic-node deferral.
- Keep TURN project/issue disposition in commit A, canonical digest in `flywheel-config`, and the named umbrella/research doc-first changes.

## Issues & Recommendations

1. **[HIGH] “Current admitted QA attempt” is still not an executable authority or migration contract.**

   **Issue:** Section 4.2b requires the binding attempt to equal “the run's current admitted QA attempt (run-side recorded),” but neither the shown new DDL nor the current `workflow_run` schema contains such a record. Current `workflow_run` has `current_node_id` and `claims_read_enrolled`; `workflow_run_node` has per-attempt rows but no current/admitted marker. The text does not choose a derivation such as the maximum admitted QA attempt. It therefore cannot yet express the promised exact join or tell the two resolver implementations which attempt is authoritative. The migration preflight also says any existing duplicate/null `workflow_run_node.execution_id` fails loud, although that column is nullable by schema and legacy/non-enrolled rows must remain byte-compatible.

   **Why it matters:** This is the read-switch's identity boundary. Choosing the wrong “current” row can let an old execution consume a newer claim or strand the current execution. A global null preflight can also turn a default-off migration into a Bridge startup failure for legitimate legacy rows.

   **Suggested fix:** Choose one executable source of truth. Either add a run-level `current_qa_attempt`/current QA execution field updated atomically by admission, or define the exact SQL derivation from `workflow_run_node` (including allowed state, `MAX(attempt)`, full binding tuple, and projection `execution_id` equality). Require the selected claim's `attempt` and `issuer_execution_id` to equal that result in both implementations. Scope duplicate/null preflight only to rows being enrolled/backfilled; ignore legitimate legacy/non-enrolled nulls. Put the exact query and same-attempt replacement/new-attempt cases in BIND.

2. **[MED] The executable template DDL and override schema reject their own required audit/snapshot shape.**

   **Issue:** Section 5.4 requires every per-run override and reason to land in snapshot plus audit, but `workflow_template_audit.action` permits only `seed_import|publish|rebind|create`; a `run_override` audit insert violates its CHECK. The normative manifest node schema does not contain `skip`, while the override schema adds `nodes.<id>.skip` and then says the merged snapshot is rerun through §5.3, whose nested unknown-key rule would reject it. The “executable” migration SQL also omits `IF NOT EXISTS` from its tables/triggers even though StateStore migrations run again on Bridge restart.

   **Why it matters:** M3 cannot pass against the shown SQL/schema, and a literal implementation can fail on the second startup after a successful first migration.

   **Suggested fix:** Add `run_override` to the audit action domain (and record run id in a column or canonical detail), define whether `skip` lives in an effective-snapshot node schema or remains a separate overlay consumed before manifest validation, and make all migration DDL idempotent with `IF NOT EXISTS`. Keep the current field allowlist and full semantic revalidation.

3. **[MED] The old TURN projector contract remains after the new A/B-decoupled contract.**

   **Issue:** Section 3.3 first correctly says commit A always uses `target_run_id=NULL`, writes no `workflow_run_event`, and returns a project-history disposition. The retained lines immediately afterward again require freezing a target run via §4.2b, repeat the `grantTurn` instruction, and describe `applyWorkflowSourceEvent` as always writing a claim/run event and returning only `{applied, claim_id}`.

   **Why it matters:** Commit A is again ambiguous about whether it depends on B and whether a null-run TURN replay creates a run event. That is the exact sequencing/cross-DB ambiguity Round 4 was meant to remove.

   **Suggested fix:** Delete the retained §4.2b and duplicate `grantTurn` bullets. Replace the old generic return description with an explicit tagged union, for example founder `{kind:'founder_claim', claimId}` versus TURN `{kind:'turn_project_history'}`, with applied/replayed status and no run event for the latter.

4. **[LOW] Closed choices still appear as alternatives in the acceptance/file matrices.**

   **Issue:** Section 4.3b selects the Bridge head-authority endpoint and then still offers a preflight-authority alternative. L1 still describes Option A versus Option B even though this issue now tests Option B only. Section 9 still says canonical digest moves to `packages/config` “or a new low-level util,” contradicting §3.3's selected `flywheel-config` home.

   **Why it matters:** These residual forks are small, but they undermine the “no open items” handoff and can send implementation down a path that was explicitly closed.

   **Suggested fix:** Keep only the Bridge endpoint, make L1 Option-B-specific with the accepted residual, and name `packages/config`/`flywheel-config` without an alternative. The peer-credential Option A evidence correctly belongs only to its follow-up.

## Verdict

CHANGES REQUESTED.

The governance decision and main architecture are accepted. Approval now requires only an exact current-QA-attempt authority, the two template schema corrections, removal of the retained TURN contract, and deletion of the last closed-choice alternatives.
