# FLY-1847 plan.md — Claude Stopgap Design Review (Round 3)
Date: 2026-08-19
Author: Claude (stopgap reviewer — Codex quota-blocked, Gemini CLI dead)
Status: APPROVED

## Summary

Pure diff check of `ff41daa02..e503901a3`, as agreed in R2. All six R2 residuals are folded exactly as claimed, and nothing else in the design regressed. Changed-file set for the range is exactly: `plan.md` (the six folds), `claude-stopgap-review-r2.md` (my own R2 text, committed verbatim), and `progress.md` (phase-cursor bookkeeping only — verified, no design content). `research.md` untouched — correct, since the M-6 correction was already in at `ff41daa02` and no R2 residual required research edits.

Per-fold verification against the diff:

1. **R2-1 (marker out of ship signals)** ✓ — "marker 粘贴" deleted from the Chunk 5 signal list (:95); replaced with the explicit negative rule ("marker 粘贴不是 ship 侧信号", marker at the ship boundary → `neutral_not_written` + HTTP guidance back to the review channel or `--kickback`); Chunk 6 gains the relay-marker-without-flag → `neutral_not_written` case. Cross-checked for contradiction: §1's "五条显式信号" list (which keeps marker) is the *review*-channel verdict list and correctly unchanged — the two lists are now cleanly disjoint in meaning.
2. **R2-2 (both-reactions dedup)** ✓ — `event_id = fr_both_reactions_explainer:<questionId>` conditional insert, once per round, with the FLY-218/220 rationale recorded (:70); Chunk 6 gains the second-poll-pass-zero-new-posts case. Latch direction checked: after the one explainer, persistence → silence (recoverable by her single emoji removal, which the explainer taught) — safe, not spam.
3. **R2-3 (identifier source)** ✓ — pinned to `store.getSession(executionId)?.issue_identifier` with the two-column split and the UUID-comparison failure mode documented in place; null/missing → skip check, accept marker (never reject on missing data); Chunk 6 gains the integration-shaped positive control through real `processFounderMessage` with `issue_id ≠ issue_identifier`. Coherence checked: the top-of-function marker intercept only needs the identifier on the write path (where a matched gate supplies `executionId`); the closed-round path goes to Lead regardless — no ordering hole.
4. **R2-4 (invariant tightened)** ✓ — §1 :29 now reads "thread 里只要有任一 pending founder_review gate,普通纯文本消息一律不进 ship 腿", covering the two-open-rounds edge and honestly labeling it a pre-existing exposure being closed. Card-reply ship approval and ✅-on-ship-card are explicitly preserved. (One advisory below on chunk-level encoding.)
5. **R2-5 (close-path receipt + wording)** ✓ — marker-after-close now posts "本轮已关,这份汇总我已转给 Lead 并入返工" with the invariant rationale; the no-feedback-kickback receipt's promise softened to "转给 Lead 并入返工". Checked the asymmetry is deliberate and correct: the kickback-**with**-feedback receipt still says "交给 runner" — that one is true (the feedback is the response content enqueued to the runner's mailbox), while the softened wording applies only to the future paste, which really does route via Lead.
6. **R2-6 (TTL surface)** ✓ — the TTL bullet now names `flywheel-comm gate.ts` at question creation (`insertQuestion` `ttlSeconds` hook, `db.ts:1219`, gate.ts doesn't pass it today — matches my R1 verification) and the runner-CLI/dist deploy surface; §4's impact list names both flywheel-comm surfaces. It remains physically filed under Chunk 2's header, but the text is explicit that the edit is not in the deliverer file — cosmetic only.

## What's Good (Keep)

- The fold quality is high: each edit carries its provenance tag (R2-N), the reasoning, and a matching Chunk 6 test — the plan is now self-documenting about *why* each guard exists, which is what will keep the next editor from "simplifying" one of them away.
- The R2-5 wording asymmetry (runner vs Lead) shows the truth-in-time discipline was applied with understanding, not mechanically.
- §6's review record honestly states R2's verdict shape (blockers resolved zero-residue + six fold-introduced corrections) rather than compressing it to "approved".

## Issues & Recommendations

Two non-blocking advisories for the implementer; neither changes the design and neither warrants a fourth round.

### 1. LOW — R2-4 lives in the §1 invariant but is not encoded in Chunk 2's routing rules or the Chunk 6 matrix

Chunk 2's 路由硬规则 (:51-53) implement two conditions (marker intercept; review-bound neither/failed-write → Lead). The tightened invariant's third condition — *any* pending founder_review gate in the thread ⇒ plain (non-card-reply) text never enters the ship legs, which is what closes the two-open-rounds edge — has no corresponding Chunk 2 bullet and no Chunk 6 fixture (the coexistence matrix at :108 tests only single-round states). An implementer working from the chunk bullets literally would leave the two-round edge at today's behavior. Worst case is status quo ante on an abnormal leaked-round state — a non-regression — which is why this is advisory, not blocking. During implementation: generalize Chunk 2's second bullet to key on `founderReviewGates.length > 0` (plain messages), and add one two-open-rounds fixture (plain `可以` + ship gate + two review rounds → Lead, zero writes).

### 2. LOW — Apply the M-7 truth-in-time ordering to the new marker-after-close receipt as well

The R2-5 receipt claims "已转给 Lead", but its ordering relative to `deliverAmbiguousToLead` is not pinned (the M-7 ordering rule at :62 is written for the neither-explainer specifically). At-least-once retry makes a premature claim eventually true in most paths, but the dead-letter path would leave a false receipt standing. Same one-line discipline: post this receipt only after the handoff returns true.

## Verdict

APPROVED

All six R2 residuals are folded faithfully; no regressions elsewhere in the range; the two R1 blockers and the M-6 hard gate remain resolved as verified in R2. The two LOW advisories above are implementation-time notes (one chunk-bullet generalization + one fixture; one receipt-ordering line) and do not require another design round. Reminder of the two standing implementation-phase gates already in the plan: the Chunk 5 forensic (FLY-1833 `workflow_source_event.classification`) must complete before Chunk 5's design freeze, and if Chunk 5 splits to PR-2, FLY-1847's acceptance is not met until PR-2 merges (:92, :104).
