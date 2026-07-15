# Design Review — FLY-1251 plan.md (Round 4)
Date: 2026-07-14
Author: Codex
Status: CHANGES REQUESTED

## Summary

Round 4 gets the classifier, role-scoped exception boundary, late-hold response direction, and missing FLY-1244 seam description into much stronger shape. The plan is still not implementation-ready because the detailed card algorithm on disk retains the old ambiguous-POST and marker ordering, its expanded posting-card scanner can grey-edit a card that later becomes active, and a reaction rejected during posting/hold can silently become an approval when the unchanged reaction is polled after activation/release.

## What's Good (Keep)

- The execution-local scope and run/generation follow-up boundary remain precise and honest.
- PR-1 still mechanically blocks the original `qa_required=0` + zero-record code-PR incident while preserving server-computed docs-only as the sole exemption.
- The snapshot DDL now contains `base_oid`, and the Git Trees contract verifies both sides of every operation, including removed and modified paths. Requiring `blob + 100644`, complete tree data, and conservative handling of every other mode closes the prior symlink/gitlink/executable escape paths.
- The role-scoped exception boundary is coherent: main sessions convert store failures to `qa_evidence_unknown`, while non-main behavior remains unchanged for the E12 compatibility boundary.
- The public coordinator-owned manual-spawn admission and bounded dead-runner revival remain feasible and race-aware.
- The plan now states the FLY-1244 reality accurately in §4: commit A `35a04f510` exists without the required seam, §4.3 is blocked on a distinct follow-up commit, and the four required sibling changes are enumerated.
- The proposed seam deliverables are the right ones: route-source propagation, injectable typed authority, the full hold-reason union, and NEVER-deferrable disposition mapping.
- Replacing the active-held silent reaction short-circuit with a visible typed response is the correct UX and safety direction. Keeping the same card active-but-blocked is viable if rejected reactions are prevented from carrying forward.
- `grey_edit_done` is now correctly only a frequency-tier marker, and unresolved `posting+NULL message_id` rows are explicitly excluded from generic channel-down retirement.

## Issues & Recommendations

1. **[HIGH] The detailed send sequence on disk still contains the two Round-3 bugs the summary says were removed.**
   - **Why it matters:** §4.2 step 2 still says every POST API failure performs `posting→retired(post_failed)`. There is no detailed classification for timeout, connection loss, 5xx, or malformed successful response, so an implementer following the numbered algorithm can still discard the correlation row after Discord accepted the message. The same sequence still lists the activation marker as step 5 and `posting→active` as step 6, despite saying the marker is written only after activation. The top-of-document review summary is not an executable replacement for the contradictory normative steps.
   - **Suggested fix:** Rewrite §4.2 itself, not only the change log: definitive pre-send/config/explicit-4xx failures may retire; ambiguous outcomes stay `posting+NULL` and enter complete nonce reconciliation; a successful response with an unparseable ID follows the same path. Order the remaining steps as persist ID → bind → verify channel/authority prerequisites → CAS active → write activation marker. Update E7 with accepted-then-timeout, 5xx ambiguity, malformed success body, and crash after active before marker.

2. **[HIGH] The new posting-card observation query races with activation and can turn a grey “not effective” card into an active authorization surface.**
   - **Why it matters:** §4.4 adds `posting+message_id` rows to the high-frequency scan, then says the entire high-frequency set retries grey edit and sets `grey_edit_done=1`. Concurrent §4.2b can repair that same row’s binding and CAS it active. The result can be an active card whose Discord content was edited to an expired/not-effective state; the low-frequency query also lacks a state restriction and can continue treating that active row as stale. Separately, §4.5 handles only active cards during channel failure. A known `posting+ID` row can therefore be activated by §4.2b while the reaction channel is unhealthy, then retired on a later tick—creating an avoidable active window on a dead channel.
   - **Suggested fix:** Split observation from edit eligibility. Scan `posting+ID` for reactions, but only retry grey edit for `retiring|retired`; restrict the low-frequency set to those terminalizing states as well. For channel-down, either retire a known `posting+ID` row immediately (its message is identifiable) or leave it posting while making channel health a mandatory just-in-time precondition of `posting→active`. Add CAS-race tests for scanner-versus-activation and channel-down-versus-activation.

3. **[HIGH] A rejected ✅ can carry forward and authorize automatically after posting/hold state clears.**
   - **Why it matters:** Discord reactions are persistent state. If the founder clicks while a card is `posting+ID`, §4.4 replies “not yet effective” but leaves the ✅ on the message. When the row becomes active, the ordinary reaction poll sees that same ✅ and writes approval without a new click. The active-held design has the same flaw: it sends a blocked reason while held, keeps the card active, then the unchanged reaction is accepted as soon as the hold self-clears. That is park-then-auto-apply under a different storage mechanism and contradicts the explicit “not effective/not accepted” response.
   - **Suggested fix:** Define a durable rejected-reaction consumption protocol scoped to card attempt + founder + emoji + hold/reason generation. After a blocked observation, authorization must remain disabled while that reaction is still present. Either remove the founder’s reaction and verify absence, or require a durably observed absent→present edge before the card may authorize; if neither can be proven, retire/repost the card. The active authority path must consult this tombstone/edge state. Add adversarial tests: posting click → activation with reaction still present writes zero; held click → hold clears with reaction still present writes zero; only a verified fresh re-add after release may approve.

4. **[MED] The seam and acceptance sections still contradict the now-correct §4 prerequisite and omit the new mandatory tests.**
   - **Why it matters:** Architecture decision #8 and the §8 integration matrix still call commit A itself the PR-2 prerequisite, even though §4 and §11 correctly say commit A has no seam and a later pinned commit is required. The current FLY-1244 branch still has no `cardAuthority`/route-source seam. E6 and §3.5 still refer to Contents API tests, while E7/§4.7 omit the ambiguous-send/channel-down cases and E13 omits the five active-held cases claimed in the prose. A separate implement session will naturally use the matrices and ordered RED list as its checklist.
   - **Suggested fix:** Replace every remaining “commit A prerequisite” reference with “pinned seam follow-up commit,” and update the integration row once that hash exists. Rename the classifier tests to Git-tree unavailable/truncated/mode-transition cases. Add the exact Round-4 POST, posting-race, and five late-hold cases to E7/E11/E13 and §4.7. Keep §4.3 blocked until the pinned cross-branch compile fixture is green.

## Verdict

CHANGES REQUESTED — address items above
