# Design Review — plan.md (FLY-1224, Round 6)

Date: 2026-07-13
Author: Codex
Status: APPROVED

## Summary

Round 6 resolves all four Round 5 findings: C10 now defines the complete durable review loop, T13 proves the exact authority-to-Claude-session audit chain, the legacy unstamped exception is accurately bounded, and xhigh is wired through a single typed default with production-seam coverage. The founder's bidirectional cross-review requirement is feasible with the existing FLY-1188 architecture and is now complete enough to implement without a new review framework or an unsafe same-family fallback.

## What's Good (Keep)

- The Blueprint contract now covers the coordinator's real three-result state machine. `APPROVED` and the governance-only `SKIPPED` outcome can advance, while `CHANGES_REQUESTED` explicitly requires fixes on a new head, a fresh `review_code` question, and a fresh request; the coordinator's existing round counter and persisted reviewer UUID provide the intended resumed Claude review.
- Registration and reviewer failures remain fail-closed. The prompt forbids entering approve-to-ship, the coordinator writes a durable failed job, and the existing FLY-863 Codex-hold path eventually exposes an unresolved gate without licensing a Codex-reviews-Codex fallback.
- The audit record now names the actual `codex_review_job` table and proves more than field presence. T13 joins the approval record to a code job through `request_id`, checks the same execution and frozen head, requires a completed approved verdict, and ties the persisted reviewer UUID to the UUID supplied to the Claude subprocess.
- Treating an empty findings array as valid is correct: the durable session UUID is the review-conversation anchor, while `findings_json`, the frozen head, and the request-bound verdict preserve the structured audit result.
- The grandfathered record behavior now matches `crossFamilyReviewSatisfied` exactly. Stamped same-family approvals fail in both directions; an unstamped Codex-author approval fails closed; only the pre-FLY-1188 Claude-author historical shape remains accepted.
- The exception is acceptably bounded for this ticket. Direct source inspection shows the two production approval writers—`AutoQaCoordinator` and `ReviewRequestCoordinator`—both derive/stamp the author and reviewer families server-side, so new authority does not depend on runner-supplied identity.
- T13 now locks both stamped same-family directions through both gate consumers, plus the two unstamped sentinels. That is the right mutation surface for a bidirectional invariant and prevents the Bridge predicate from drifting away from `verify-approval`.
- Effort ownership is clear: `DEFAULT_REVIEW_EFFORT: RoleEffort = "xhigh"` lives at the Claude runner boundary, with the coordinator forwarding a typed override on every round. Testing both argv construction and the coordinator invocation closes the production-wiring hole from Round 5.
- The selected mechanism is valid on the installed Claude Code 2.1.207 CLI, which advertises `--effort` values including `xhigh`; the existing Opus model default remains unchanged.
- Keeping C10/T13 in commit 1 preserves deployment safety: the Codex-default vendor flip, its required Claude review lane, and the review effort contract ship and revert together.

## Issues & Recommendations

1. **Non-blocking editorial cleanup:** §0 still stops at “R5 复审” rather than recording the Round 5 changes and Round 6 disposition. Research §9's final gap description also still says `--effort` should be tested during implementation, while C10 correctly records that local CLI support has already been verified. Synchronize those two historical notes before archiving; neither affects implementation approval.

## Verdict

APPROVED — ready to implement
