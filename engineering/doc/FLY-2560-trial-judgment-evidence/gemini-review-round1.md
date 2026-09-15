# plan.md — FLY-2560 (Gemini Design Review, Round 1)

Date: 2026-09-14
Author: Gemini
Status: APPROVED

## Summary
The proposed implementation plan for issue **FLY-2560** is a highly thorough, mathematically sound, and architecturally elegant solution to the "0 repository/everything undetermined" failure of the initial trial run. The plan addresses the root causes of slug casing mismatch, bridges missing design review references across runs via issue-alias mapping, shifts model semantic evaluation to a non-blocking "veto/override" layer, and maps QA verdicts to the authoritative claims database. It also guarantees backward compatibility and includes a robust offline replay framework for 12 historical cards to prove correctness.

## What's Good (Keep)
1. **Source Casing Normalization (`readShipJudgmentRepositories`)**: Transforming slugs to lowercase at the database query boundary (`StateStore.ts`) ensures absolute compatibility with lowercased binding rows while maintaining the integrity of config schemas. This is an exceptionally clean solution that completely avoids modifying multiple downstream layers.
2. **Deterministic Evidence Priority & Semantic Layer as a Veto**: Decoupling the deterministic machine/process checks (design, code, git merge, QA claims) from the LLM-based semantic review is a major improvement. Allowing the semantic review to act strictly as a "veto" ensures that a slow, failed, or budget-exhausted model call never blocks a card with fully valid deterministic machine evidence.
3. **Cross-Run Design Review Aliasing**: Querying design approvals by `issue_id IN (?...)` (using the aliases from `workflow_run_issue_alias`) instead of scoping strictly to the current `run_id` correctly resolves the cross-run mismatch where design and implementation are done under different executions.
4. **Authoritative QA Claim Retrieval**: Hooking into `workflow_claims` (filtered by Precise Git Head and attempting execution verification) rather than relying on the empty `strength_two_evidence_record` table ensures the real DAG-based QA verdicts are captured.
5. **Robust Schema and Budget Guardrails**: Providing a mathematical proof of the 4-layer schema size boundary (Zod parsing, SQLite DB checks, and Discord rendering lengths) ensures that the database constraints (`<=49152` bytes) and Discord message budget (`<=2000` chars) are strictly respected.
6. **Isolated and Safe Offline Replay**: Backing up the DB using `.backup` to avoid locks on the active WAL database, ensuring `asOf` consistency, and restricting filesystem access away from the real `~/.flywheel` paths ensures an extremely clean, safe, and robust validation environment.

## Issues & Recommendations

The overall plan is excellent and has **no blocking issues**. The following low-severity recommendations will help harden the implementation:

### 1. [LOW] Re-creating `ship_judgment_opinion` triggers explicitly
- **Issue**: During table recreation (`ship_judgment_opinion_new`), the triggers `ship_judgment_opinion_no_update`, `ship_judgment_opinion_no_delete`, and `ship_judgment_opinion_history_dirty` must be dropped and recreated. If any trigger name is mismatched, it might break the immutability guarantees.
- **Why it matters**: Ensuring strict append-only immutability of opinions is a key constraint of the ledger architecture.
- **Suggested Fix**: Verify that the exact trigger definitions from `StateStore.ts` (lines ~5568-5582) are mirrored during trigger reconstruction.

### 2. [LOW] Defensive truncation of evidence/repo IDs in rendering budget
- **Issue**: Although the rendering logic uses total size thresholds (cumulative length check before appending elements, e.g., `<=1900` chars), an extremely long or corrupted database ID/path could hypothetically exhaust the budget in a single line.
- **Why it matters**: A crash in `renderJudgmentMessage` due to a thrown `judgment_message_budget_exceeded` error would block card rendering entirely.
- **Suggested Fix**: Ensure that individual dynamic strings (such as `repo_identity` and target file `path`) are defensively truncated using the `text(value, limit)` helper before being compiled into the card template (e.g., matching the `overlaps` logic).

### 3. [LOW] Duplicate QA attempt handling in replay
- **Issue**: In Chunk D (offline replay), when matching historical QA attempts at `asOf`, it's possible that a single run had multiple nodes or retries.
- **Why it matters**: Replaying with incorrect attempt bounds might cause stale QA verdicts to be matched.
- **Suggested Fix**: Ensure that the replay query mirrors the exact two-step QA attempt selection specified in Chunk B/Section 3.3, ordering by `attempt DESC` and picking the latest attempt before or at `asOf`.

## Verdict
APPROVED — ready to implement
