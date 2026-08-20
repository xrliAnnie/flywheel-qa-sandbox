# FLY-1847 plan.md — Claude Stopgap Design Review (Round 2)
Date: 2026-08-19
Author: Claude (stopgap reviewer — Codex quota-blocked, Gemini CLI dead)
Status: CHANGES REQUESTED

## Summary

Fold verification against commit `ff41daa02`. **Both R1 blockers and the M-6 hard gate are genuinely addressed** — I checked the folded text against the plan's own invariants and against the real code, not charitably:

- **HIGH-1 (review traffic → ship Tier-2)**: resolved. The §1 invariant "review-bound 消息永不进 ship 腿" (plan :29) defines review-bound correctly (review-card reply / sole-open-round plain message / any marker message), names the actual hazard (Tier-2 bare `可以/同意/批准/ship`, zero AI, zero fail-closed), and states the accepted coexistence cost explicitly. Chunk 2's routing hard rules (:51-53) put the marker intercept at the top of `processFounderMessage` and — critically — route **failed writes** (stale_round etc.) directly to `deliverAmbiguousToLead` too, closing the pre-existing leak I flagged, not just the new one. The Chunk 6 coexistence matrix (:108) tests exactly the three cases I demanded, including the `可以`-with-both-gates zero-write case and the pure-ship non-regression control.
- **HIGH-2 (six-caller boundary)**: resolved. The Chunk 5 table (:96-102) enumerates all six production callers with correct dispositions. I independently re-verified the two "已核" claims rather than trusting them: `founder-reaction-approval-handler.ts:200` writes only `'{"approved": true}'` ✓; `voice-routes.ts:497` ✓; `actions.ts:336` ✓ (dashboard reject bypasses the boundary via FSM at :560-597, so it can't hit the guard). The deferred-drain intent derivation from `row.decision === "reject"` covers both park paths (`defer()` and `parkForConvergence()` drain through the same write at `deferred-approval.ts:629`). The router's `neutral_not_written` special-case (not the generic 409 at `gate-response-router.ts:349-364`) is specified, with a matching Chunk 6 test (:112).
- **M-6 (forensic hard gate + relay-leg mechanism)**: resolved. Plan :92-94 makes the FLY-1833 forensic a design-freeze precondition and requires the guard to cover both real paths; research §2:48 now states the off-mode mechanism I traced (untrusted leadId → plain `insertResponse` at `write-gate-response.ts:584-592` → no `workflow_source_event` → silent gate consumption), the §2 conclusion (:50) and the §6 shelf-life row (:91) are consistent with it, and the off-mode refusal is claimed as an independent fix — all accurate.

All other folds (M-3/4/5/7/8, L-9/10/11/12) are present where claimed and I found no contradiction between them and the rest of the plan — with three exceptions. The folds themselves introduced three new defects that a literal implementation would ship: a leftover "marker = ship-kickback signal" in Chunk 5 that contradicts the marker's categorical review-traffic meaning; a both-reactions explainer with no dedup on a 15s poll loop (founder-visible spam storm); and a **verified-false factual claim** in the L-10 fold — the issue identifier is NOT on the deliverer ctx (I checked: `ctx.issueId = session.issue_id`, `gate-poller.ts:2489`; `issue_identifier` is a distinct, nullable column, `StateStore.ts:2715-2716, :650`), and implementing the comparison against `ctx.issueId` silently kills the entire marker path. Each fix is a one-to-two-sentence spec edit; no structural change is needed. R3 should be a diff check.

## What's Good (Keep)

- The HIGH-1 fold is stronger than my R1 ask: it also closes the pre-existing failed-write fall-through (today `stale_round`/`gate_not_open` messages leak into the ship legs; the folded rule sends them to Lead), and Chunk 6 :109 pins that with a test.
- The M-5 reversal (both-reactions → write NOTHING, dropped ✅-priority) is the right call and is stated twice consistently (§1 :30, Chunk 3 :70) with the rationale recorded.
- Research §2's correction is honest about what it overturned ("推翻本节初稿的…") and keeps the wrong claim's tombstone visible instead of silently rewriting — matches the project's attribution-chain discipline.
- The Chunk 5 PR-2 escape hatch now carries the acceptance-criteria caveat (:104) — FLY-1847 is explicitly not done until PR-2 lands.
- L-9's per-chunk marker (:84) composes correctly with the HIGH-1 routing: chunk 1 writes + closes; chunks 2..N hit the closed gate and flow to Lead via the marker-after-close rule; the receipt wording (:58) doesn't overclaim. I walked the ordering (deliverer processes oldest-first) — deterministic.

## Issues & Recommendations

### 1. MEDIUM — Chunk 5's explicit-signal list still contains "marker 粘贴" as a ship-kickback signal, contradicting the marker's categorical meaning

**Evidence.** Plan :95: ship-side explicit kickback signals = 「打回」/ prefixes / **marker 粘贴** / `intent:"kickback"`. But §1 :29 and Chunk 2 :52 define the marker as *categorically review traffic that must never produce ship-side effects*. The deliverer side is now sealed (marker intercepted at top), but the write boundary is reachable via the Lead relay: review round closed → founder pastes the marker summary → Bridge routes it to Lead → Lead relays it as the answer on the open **ship** gate via `respond` *without* `--kickback` → under :95 the marker counts as an explicit signal → a ship `founder_feedback_kickback` is minted from review-page feedback (card voided, rework cycle, founder re-approval) — the exact instance-4-shaped churn this chunk exists to kill, now reachable through the plan's own signal list.

**Fix.** Delete "marker 粘贴" from the ship-side signal list. Ship kickbacks are minted by 「打回」/ prefixes / `intent:"kickback"` only; a marker-bearing answer at the ship boundary should be `neutral_not_written` with the HTTP response pointing the Lead at the review channel (or at `--kickback` if a ship kickback is truly intended). Add one Chunk 6 case: relay of marker text without flag → `neutral_not_written`.

### 2. MEDIUM — The both-reactions explainer has no dedup; the 15s reaction poll will re-post it every pass while ✅+❌ persist

**Evidence.** Chunk 3 :70 posts the explainer whenever both reactions are observed, and the reaction check re-runs per qid every ~15s (`gate-poller.ts:3058-3064`, kept by L-12 fold :72). Reactions persist until she removes one — which may be hours. The neither-explainer's `fr_neither_explainer:<questionId>` dedup (:61) does not cover this new explainer; nothing else does. Literal implementation = an explainer message every 15s into her thread — the FLY-218/220 alert-storm class, self-inflicted, on the founder's primary channel.

**Fix.** Same mechanism, one line: `event_id = fr_both_reactions_explainer:<questionId>` conditional insert, once per round (round supersede resets it, same as the neither key). Add to the Chunk 6 reaction-leg tests: second poll pass with both reactions still present → zero new posts.

### 3. MEDIUM — L-10's data source is factually wrong: the issue identifier is NOT on the deliverer ctx; comparing against `ctx.issueId` silently kills the whole marker path

**Evidence.** Chunk 1 :44: "分类器接可选 `issueIdentifier` 参数(**deliverer ctx 里有**)". Verified false: the ctx is built with `issueId: session.issue_id` (`gate-poller.ts:2489`), and sessions carry `issue_id` and `issue_identifier` as **distinct columns** (`StateStore.ts:2715-2716`; `issue_identifier: string | null` at :650). The marker line carries the human identifier (`FLY-XXXX`, Chunk 4 :84). This codebase has already been burned by exactly this id-vs-identifier split (FLY-270's dual-thread bug). If implemented as written — compare marker identifier against `ctx.issueId` — every legitimate paste mismatches → `neither` → the categorical intercept still routes to Lead, so it fails *safe*, but the kickback-with-feedback path, the instance-1-3 fix, and the marker's entire purpose are silently dead, while the classifier unit tests (which inject the identifier directly) stay green.

**Fix.** Pin the source: `store.getSession(executionId)?.issue_identifier`, threaded into the deliverer (or onto `PendingQuestionForThread`); `null`/absent identifier → skip the check (accept the marker), never reject on missing data. Add one integration-shaped Chunk 6 case through `processFounderMessage` with a store-backed session where `issue_id ≠ issue_identifier`, asserting a matching-identifier paste writes kickback — this is the positive control that catches the UUID mistake; the unit-level fixtures cannot.

### 4. LOW — Two-open-rounds edge: a plain message is not "review-bound" when `founderReviewGates.length === 2`, so the Tier-2 exposure survives in that (abnormal) state

Per the §1 definition, review-bound requires the *sole*-open-round binding (`founder-reply-deliverer.ts:593-597`). With two open rounds in one thread (a leaked round from a dead/canceled run — `gate.ts:152-168` retires prior rounds per-runId only), a plain `可以` binds to neither round → enters the ship legs → Tier-2. This exposure **pre-exists the plan and is not widened by it** (verified: today's code behaves identically), so it is not a fold regression — but the invariant's wording ("永不进 ship 腿") overclaims slightly. Cheap tightening, if wanted: plain text never enters ship legs while ANY founder_review gate is pending in the thread (ship then requires card-reply or ✅ — the same degradation the plan already accepts for the 1-round case, at zero extra cost). At minimum, note the boundary honestly in §1.

### 5. LOW — Marker-after-close paste gets no visible receipt, and the preceding kickback receipt promises "我会转给 runner" while the actual route is Lead relay

Chunk 2 :59's no-feedback-kickback receipt tells her to paste the summary and "我会转给 runner"; the paste then arrives after close → direct Lead (:52) → silence. The §1 invariant (:31) promises every processed founder message a visible result; this path has none specified (the neither-explainer can't fire — no open round to key it). One line fixes both: on marker-after-close → Lead, post "本轮已关,这份汇总我已转给 Lead 并入返工", and soften :59's promise to match ("我会转给 Lead/并入返工").

### 6. LOW — The M-4 TTL edit lands in `flywheel-comm` `gate.ts` (question creation), not the deliverer chunk where it's filed, and §4's impact list omits that surface

The 7-day `ttlSeconds` must be passed where the founder_review question is inserted — `gate.ts:191-197` (`insertQuestion` opts; the `ttlSeconds` hook exists, `db.ts:1219`, but gate.ts does not pass it today). That is runner-side CLI code (dist deploy), yet the fold sits under Chunk 2's `founder-reply-deliverer.ts` header (:55) and §4 (:131) lists the flywheel-comm surface as "respond 旗标" only. File it under its own bullet and add the gate-open path to §4's impact/deploy list so the ship checklist knows the runner CLI changes too.

## Verdict

CHANGES REQUESTED

The R1 blockers (HIGH-1, HIGH-2) and the M-6 hard gate are genuinely and accurately folded — no residue on those three. The remaining asks are three surgical spec amendments introduced by the folds themselves (Issues 1-3: one deleted list item, one dedup key, one corrected data source + positive-control test) plus three notes (4-6). No structural change is requested; Round 3 can be a pure diff check of those six edits.
