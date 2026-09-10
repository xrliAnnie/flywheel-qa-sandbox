# FLY-2461 中文批准 — 实施进度
Issue: FLY-2461 (https://linear.app/geoforge3d/issue/FLY-2461/founder-ux静默失败-批准只认英文approve-look-good-to-me打回却认中文打回-founder)
日期: 2026-09-09
基于: 无

## Current evidence

- Implement TURN acquired: run eb7ac1ef-73f1-4a2d-ba41-963d7147d8c1, epoch 1, execution 28e1710e-db7e-4709-89d1-b104567de879.
- Initial checkout HEAD: 04ff8800a. Working tree initially clean; no FLY-2461 documentation folder, approved plan, or progress ledger existed.
- Onboarding read project CLAUDE.md, product experience specification, project memory index, and architecture reference materials. Root AGENTS.md absent; injected runner contract applies.
- workflow-rework-hint.ts approval helper recognizes only approve / look good to me. Both founder-review-response.ts and approval-signal/text-approval-source.ts consume it.
- founder-reply-deliverer.ts checks Discord reply type, thread, and immutable card binding before writing a founder review response. Unanchored messages fall through to Lead delivery.
- The existing founder review explainer is conditioned on founderReviewContextGate, which equals the anchored founderReviewGate. Thus unanchored approvals receive no automatic missing-anchor explanation from this path. Existing explainer copy also lists only English approval tokens.
- Historical Discord message 1547103548284600420 reply metadata has not been verified; no conclusion about its anchor is warranted.

## Pending handoff

Lead question 480461de-f3bb-47d6-91eb-fe382ed41ec5 requests the pinned plan/blob or confirmation to prepare missing design docs under the injected DOC-FLOW and obtain design review before code changes. Latest check: not yet. No implementation code or tests changed. No gates claimed passed.

## Remaining

Obtain design authority; execute approved scope with strict red/green tests covering Chinese vocabulary, bilingual coverage, anchored approval and missing-anchor feedback/negative guards; run full repository gates; exact-head review; final milestone commit and PR; report and needs_review completion route.

## Design preparation and baseline — 2026-09-09

- Under the injected DOC-FLOW, prepared exploration/research/plan at 64af038f7. Design gate 5875f150-64d8-477d-baa4-44500666d57c; accepted request 08718c49-463f-4b08-9460-91c7d8b7a519. Await verdict before behavior changes; upstream handoff question remains unanswered.
- Initial test invocation failed because dependencies were absent. Installed with pnpm install --frozen-lockfile (exit 0), then built workspace exports with pnpm -r build (exit 0; /tmp/FLY-2461-baseline-build.log). No tracked dependency files changed.
- Baseline focused suite after build: six files, 113 tests passed, exit 0 (/tmp/FLY-2461-baseline-tests.log): workflow-rework-hint, founder-review-response, text-approval-source, founder-reply-deliverer, founder-thread-notifier, gate-materializer. This is not the full package test gate.
- Additional wiring evidence: emitFounderReplyDeliveryForThread supplies a default postFounderReviewThreadReply when no callback is injected (lines 494 onward). Thus the planned missing-sender guard is defensive; the meaningful production absence/failure test must exercise default HTTP POST failure, not assume an omitted injected callback means no sender.

## Lead confirmation and QA contract

- Lead answered 480461de-f3bb-47d6-91eb-fe382ed41ec5: no upstream pinned plan; 64af038f7 is the simple_code plan. Wait for design APPROVED, then TDD, exactly one push, one code review, needs_review to QA. No FLY-1919 changes. Acknowledged via report 7379292e-f7af-4bfc-89fe-a1bcc1c2e47e.
- Read current Linear FLY-2461 description through read-only GraphQL. State In Progress. QA criteria: all five Chinese tokens equal English on review and ship, anchored only; unanchored visible guidance and retry without resolving; unchanged Chinese kickback regression; non-founder regression; at least three out-of-list synonym negatives; bilingual card copy; exact-head CI 14/14.
- QA also requires a real-card test in a test/529 room: reply-to 「通过」 resolves the gate, bare 「通过」 prompts without resolving. That remains QA-phase evidence, not proven by implementation fixture tests; do not claim it or dispatch QA from this phase.

## Implementation batches — 2026-09-09

- R2 design APPROVED: gate 2910f0d4-9e70-4f59-bb5d-1573ae4bc8ab, request 537446a1-7049-4216-a773-c5c019ef03eb. Pinned plan-r2.md unchanged. Advisory report 216fd078-5c59-42ca-a429-50483307a704 covers stale founder-review explanation, superseded-card insertion ordering, Blueprint test target, exact-word limitations, GUI exclusion.
- Lead ruling 9cb9573d-ab9f-4b8f-8267-1648c84acd96: full package gate mandatory with sole exclusion tmux-viewer.macos.test.ts because it opens real Terminal GUI; run it if changed. No other exclusions; disclose in PR. No such file changes planned.
- 0d1d73a19 vocabulary: first 「通过」 test failed as false, then passed with minimal token addition. Remaining four tokens + normalization/language matrix produced nine expected failures, then green after finite list update. Logs /tmp/FLY-2461-vocabulary-red.log, /tmp/FLY-2461-all-tokens-red.log, /tmp/FLY-2461-vocabulary-green.log. Final three-file batch 102 tests passed. FLY-1847 legacy negative retains all variants except deliberately superseded exact 「通过」.
- 041f67e7e ingress: six unanchored approval cases failed for absent prompt, plus false/throw failure-audit cases failed before implementation. After minimal best-effort feedback, 35 ingress tests pass, including same-batch later anchored approval after prompt failure. Logs /tmp/FLY-2461-feedback-red.log, /tmp/FLY-2461-feedback-failure-red.log, /tmp/FLY-2461-feedback-green.log.
- Remaining: old/superseded and stale-review prompts; default HTTP POST failure; persistent cursor replay; additional ingress guards/ship coverage; bilingual card and Blueprint copy; full gates; single consolidated push/code review; milestone/PR/needs_review. These batch passes are not full completion or real-room evidence.
