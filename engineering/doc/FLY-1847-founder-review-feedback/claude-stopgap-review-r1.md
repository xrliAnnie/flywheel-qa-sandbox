# FLY-1847 plan.md — Claude Stopgap Design Review (Round 1)
Date: 2026-08-18
Author: Claude (stopgap reviewer — Codex quota-blocked, Gemini CLI dead)
Status: CHANGES REQUESTED

## Summary

The diagnosis is right and the direction is right: the founder_review channel's "else = kickback" binary at `founder-review-response.ts:26-46` plus the write-and-close-in-one-transaction at `db.ts:1749-1796` is exactly the mechanism behind all seven instances, and inverting the default to a fail-closed third state mirrors the codebase's own ship-side precedent (`text-approval-source.ts:8` unclear → WAKE-only; `founder-ship-approval-classifier.ts:84-88` fail-closed rules). The zero-new-infra choice (reuse `deliverAmbiguousToLead` at `founder-reply-deliverer.ts:705-733`, reuse `checkReactionConfirmation({emoji})` at `founder-confirmation.ts:122-131`, reuse `reactToFounderMessage` at `founder-ack.ts:35`, reuse `insertEvent`'s UNIQUE-event_id dedup at `StateStore.ts:5584-5611` / schema `:2700`) is verified feasible against real code — every one of those seams exists as described.

However, the plan has one genuinely dangerous hole and one caller-enumeration gap, both in the fall-through mechanics it changes:

1. Making "neither" fall through the existing legs sends review-round traffic into the **ship-approval Tier-2 exact allowlist**, which contains bare `可以` / `同意` / `批准` / `ship` (`tier2-allowlist.ts:22-34`) and approves with **zero AI and zero fail-closed protection**. A message the founder aims at the review round can deterministically ship a PR when a ship gate coexists in the same thread — and the plan itself makes review rounds long-lived, widening exactly that coexistence window. Today the same message is merely mis-recorded as review feedback; after the plan it can merge code.
2. The Chunk 5 write-boundary guard, as specced, silently breaks the **deferred-approval drain** (a parked, classifier-confirmed founder reject would become `neutral_not_written` and expire at TTL). The plan enumerates two of the six production callers of `writeGateResponseAndRunPostWrite`; the other four need explicit dispositions.

Both are fixable inside the plan's own structure without new mechanisms. With those plus the ordering/TTL/copy items below, this becomes approvable.

## What's Good (Keep)

- **Correct root-cause and correct inversion.** "Kickback must be explicit; default is the third state" is the structural fix (删的比加的多), not a detector. It matches Annie's simplicity rule and the approval-signal fail-closed precedent already in the tree.
- **Every cited seam checked out.** I verified essentially every file:line claim in research.md against the working tree (§Correctness notes in Issue 13). The research is unusually honest about its own shelf life (§6 re-grep table) — keep that.
- **Pass whitelist untouched, Lead-cannot-write-verdict untouched, write-and-close untouched.** All three are the right non-negotiables; `respond.ts:42-46` (founder_review is founder-bound) and `founder-attribution.ts:27-43` stay intact.
- **The explainer dedup mechanism is real.** `session_events.event_id TEXT UNIQUE NOT NULL` (StateStore.ts:2700) + `insertEvent` returning `false` on UNIQUE violation (:5602-5608) supports the `fr_neither_explainer:<questionId>` conditional insert exactly as planned, durable across Bridge restarts, naturally reset per round (new round = new questionId).
- **Receipt carriers are all feasible with in-scope credentials.** The deliverer has `ctx.botToken` (`founder-reply-deliverer.ts:69`); GatePoller's reaction section has `botToken` + `fetchImpl` in closure (`gate-poller.ts:2999, 3034`); the pass-receipt PUT reaction is naturally idempotent (same emoji, same message → no visible dup), which quietly solves receipt idempotency for the pass leg.
- **❌ leg is genuinely zero-new-mechanism.** `checkReactionConfirmation` takes `emoji` (`founder-confirmation.ts:128-131`); the poller already special-cases `founder_review` at `gate-poller.ts:3087-3096`.
- **Card copy fix is overdue and the three-way split is right.** The contradictory pair at `founder-thread-notifier.ts:154-155` is verbatim as quoted; the 【别用复制按钮】warning encodes the `reference_founder_review_pass_is_exact_match_vs_copy_button` lesson.
- **No new env flags, no DB migration, revert-clean rollback** — consistent with FLY-1808 discipline.
- **Honest boundaries section** (§5) explicitly rejects the auto-return infra and the LLM classifier with reasons that survive scrutiny (CSP `default-src 'none'` at `report-registry.ts:66` is real; the residual after five explicit signals genuinely doesn't need a model).

## Issues & Recommendations

### 1. HIGH — "Neither" fall-through leaks review-round traffic into the ship-approval legs; Tier-2 exact allowlist can deterministically ship from a review-round message

**Evidence.** `processFounderMessage` control flow (`founder-reply-deliverer.ts:598-613`): today, when a founder_review gate matches, the classify+write happens and `if (written.written) return { ok: true }` — the ship legs below never see the message. Under Chunk 2, every "neither" message skips the write and falls through. The ship leg then binds plain messages to a sole pending ship gate: `messageGate = cardGate ?? (shipGates.length === 1 ? shipGates[0] : undefined)` (:647-648) and feeds the text to `tryFounderShipApproval` → `evaluateTextSource` → **Tier-2 exact allowlist before any classifier** (`text-approval-source.ts:72-80`), whose phrase set includes bare `"可以"`, `"同意"`, `"批准"`, `"ship"` (`tier2-allowlist.ts:22-34`).

**Concrete failure.** Thread has an open founder_review round (design review) AND a pending approve_to_ship gate (implement node). Founder replies `可以` meaning "可以(继续/我看了)" toward the review card. `可以` is NOT in the review pass whitelist (`可以了` is; `可以` is not — `founder-review-response.ts:36-42`), so Chunk 1 classifies it `neither` → falls through → single ship gate → Tier-2 exact match → `{approved:true}` written, PR ships. **Zero AI, zero fail-closed guard on this path.** Today the same message is harmlessly mis-recorded as review feedback; the plan turns it into an autonomous merge. Worse: the message can even be a **Discord reply to the review card** and still land on the ship gate, because the `messageGate` fallback does not require the reply to reference the ship card (:647-648 — `cardGate` is only preferred, not required).

**Why the window is real, not theoretical.** The plan itself extends round lifetimes indefinitely (neither never closes the round), so "open review round coexists with a later ship gate in the same issue thread" goes from rare to normal.

**Fix (structural, one rule).** When a founder_review gate matched the message (card-reply binding at :586-592 OR the sole-open-round binding at :593-597), a `neither` classification — and equally a pass/kickback whose write failed — must terminate gate processing and go **directly** to `deliverAmbiguousToLead`. Review-bound traffic never continues into the ship legs. Consequence to accept explicitly: during coexistence, plain-text ship approvals degrade to the two unambiguous ship actions (reply-to-ship-card, ✅ on ship card) — which still work, since a reply to the ship card never matches the review binding. Add coexistence tests both ways: (a) `可以` with both gates open → Lead, nothing written anywhere; (b) plain `ship` with NO review round open → still approves (regression guard for the untouched pure-ship flow).

### 2. HIGH — Chunk 5's write-boundary guard breaks the deferred-approval drain (and the plan hasn't enumerated the boundary's callers)

**Evidence.** `writeGateResponseAndRunPostWrite` has six production callers (grep verified): `gate-response-router.ts:301`, `founder-ship-approval-handler.ts:556/653`, `deferred-approval.ts:629`, `actions.ts:327`, `voice-routes.ts:486`, `founder-reaction-approval-handler.ts:188`. The plan wires explicit kickback intent for exactly two (direct handler, Lead relay). But the **deferred drain** writes parked rejects as `JSON.stringify({approved:false, feedback: row.content})` (`deferred-approval.ts:610-613, 646`) with no marker, no 打回, no prefix — these are classifier-confirmed founder rejects parked during a hold. Under the guard they return the new `neutral_not_written`, which the drain's outcome machine treats as "other writer guard refusals … keep active — next pass re-classifies; TTL bounds it" (`deferred-approval.ts:696-701`) → infinite re-drain until the deferral TTL, then the founder's explicit reject **silently evaporates**. That is a regression of exactly the class this issue exists to kill.

**Fix.** Enumerate all six callers in the plan with an explicit disposition each: deferred drain passes `intent:"kickback"` derived from `row.decision === "reject"` (the decision was classifier-explicit at park time); actions/voice/reaction are approve-only today (`actions.ts:336`, `voice-routes.ts:497` — verified `'{"approved":true}'` only; the dashboard reject action bypasses the boundary entirely via FSM at `actions.ts:560-597`) — state that and pin it with a test so a future non-approve caller can't silently hit the guard. Also specify how each caller handles the new `neutral_not_written` disposition value — `rejectBoundaryResult` in the router currently 409s anything not written/already_applied (`gate-response-router.ts:349-364`), and the plan's "HTTP 响应写明原因与正路" needs to be that special case, not a generic 409.

### 3. MEDIUM — Marker paste arriving after the round closed still falls into the ship legs, where Tier-3 can mint a ship kickback from review-page feedback

**Evidence.** Once a round is closed (e.g. ❌ observed first, then she pastes the summary — the plan's own Chunk 2 receipt explicitly invites this sequence), the review gate is no longer pending → `founderReviewGates` is empty → the marker paste goes straight to the ship legs when a ship gate is open. A long feedback list is plausibly classified `reject` by Tier-3 ("changes needed" — `founder-ship-approval-classifier.ts:86`), and under Chunk 5 classifier-reject carries `intent:"kickback"` → a FLY-1772 rework cycle is minted on the **ship** gate (card voided, new card, founder re-approval burden) from feedback that was aimed at the review page. The plan's own Chunk 2 text ("关门后迟到的粘贴 … 落 deliverAmbiguousToLead") is only true when no ship gate is pending.

**Fix.** Hoist marker detection to the top of `processFounderMessage`: any message carrying the `【页面意见汇总】` marker is review-page traffic **categorically** — if the current round is open and latest, write kickback; otherwise route directly to Lead. It must never enter the ship legs. This is one guard, not a detector — it's the routing meaning of the marker the plan itself introduces.

### 4. MEDIUM — 72h question TTL vs. long-lived open rounds: the third state resurrects the "she acted and nothing was recorded and nobody told her" class at day 3

**Evidence.** Questions default to a +72h TTL (`db.ts:1216-1218, 1232-1234`); `getPendingQuestions` filters expired rows (`gate.ts:123, 342`); both response legs only see pending questions — the deliverer's `matching` set (`founder-reply-deliverer.ts:357-379`) and the reaction poller's `reactionGates` (`gate-poller.ts:3008-3016`). Today rounds die young because any text closes them. Under the plan a round in "she's asking questions" mode stays open for days — Annie's actual multi-day PRD cadence (FLY-1846) — and at hour 73 her eventual ✅ or `都可以了` silently stops binding: no write, no receipt, no explainer (the round no longer matches), message → Lead as ambiguous at best. The runner's verdict resolves `response_missing` → not passed, forever.

**Fix (pick one, state it in the plan).** (a) Open founder_review questions with a much longer explicit `ttlSeconds` (the hook exists — `insertQuestion` opts, `db.ts:1219`); or (b) an expiry note in-thread telling her the round lapsed and the runner will re-open (there is deliberately no in-process patrol for no-block gates — `gate.ts:218-232` — so this needs a Bridge-side observation, which cuts against the no-new-patrol grain); (a) is the boring fix. Either way, add the TTL interplay to Chunk 6 fixtures.

### 5. MEDIUM — ✅-over-❌ on contradictory reactions resolves ambiguity toward the irreversible direction, against the codebase's own precedent, and invisibly

**Evidence.** Plan Chunk 3: both reactions present → pass, audit-only `both_reactions_present`. The approval-signal precedent the plan itself cites resolves contradiction/ambiguity toward *no action* (`text-approval-source.ts:8`; `founder-ship-approval-handler.ts:453-456` — "NEVER a 已存着 reply for unclear"; `founder-confirmation.ts:12-15` fail-closed discipline). Pass is the dangerous direction: it closes the round and licenses `complete` (`complete.ts:366-374`); a wrong pass costs a shipped stage, a wrong kickback costs one founder ✅. And an audit event is not founder-visible — the invariant "每条被处理的 founder 消息都有可见结果" is violated by its own tie-break (reaction-pass has no receipt at all; the ❌-clicker never learns the ✅ won).

**Fix.** Both-present → write nothing, round stays open, post one explainer ("你同时点了 ✅ 和 ❌,我没有记任何一个——去掉一个再看一眼"). That is the same third-state philosophy the plan is built on. If the team insists on ✅-priority, it must at minimum post a visible in-thread receipt naming the winner — but I recommend against it.

### 6. MEDIUM — Chunk 5's model of the Lead-relay leg is wrong for the production default; the guard must be re-derived from the actual mechanism

**Evidence.** Research §2 asserts the relay leg "落到 `isApproval=false` = feedback kickback … 必然铸成 kickback". Trace it: relay writes go through `writeThroughBoundary(leadId)` in pass-through mode (`gate-response-router.ts:383-391` — `DECISION_MODE=off` is the production default per FLY-175 Phase 0). `leadId` fails `isTrustedApprovalAttribution` (`founder-attribution.ts:37-43`), so neither `trustedFounderMessage` nor `trustedFounderDecision` fires (`write-gate-response.ts:499-510`) and the answer lands via plain `insertResponse` (:584-592) — **no `workflow_source_event`, therefore no `founder_feedback` kickback minted by that write** (`db.ts:1990-1993` only runs inside `insertFounderApprovalResponseWithSource`/`trustedFounderGateResponse`). The relay-leg failure mode in off-mode is more likely "gate consumed with nothing minted → run stalls," not a kickback. Only in enforce mode (actor `bridge-founder-consent`, :456-457) does the relay leg mint source events. The plan already schedules the production-DB forensic on instance 4's `classification` field (研究 §2 末, plan Chunk 5 实施前置) — good — but the plan text currently commits to a guard design derived from a mechanism that doesn't hold in the default mode.

**Fix.** Make the forensic a hard gate before Chunk 5's design freezes (not just "确保回归测试用真实形状"), and have the guard cover both actual paths: (a) enforce-mode trusted writes (source-event minting — the kickback path), and (b) off-mode plain writes (the gate-consumed-silently path — where refusing the write with `neutral_not_written` is arguably an independent bug fix, and should be claimed as such).

### 7. MEDIUM — Truth-in-time ordering of the neither explainer is unspecified: it can tell her "已转给 Lead" before (or without) the handoff succeeding

**Evidence.** The explainer text promises "已转给 Lead", but the Lead handoff happens at the end of the generic leg and can fail or be dead-lettered (`founder-reply-deliverer.ts:716-732`; retry ledger + `deadLetterNow` at :141-176). The codebase's receipt discipline is explicit: never claim a state that wasn't reached (`founder-ship-approval-handler.ts:453-456`; `deferred-approval.ts:225-227` — "已存着 notice lands in the same durable transaction"). The plan doesn't pin when the explainer posts relative to `deliverAmbiguousToLead`, and the event-uid insert consumes the once-per-round budget even if the post then fails.

**Fix.** Specify: explainer posts only after `deliverAmbiguousToLead` returns true; the event-uid insert happens immediately before the post (post-failure → audit `fr_neither_explainer_failed`, accept the consumed budget — same best-effort discipline as `founder_ack_failed`). Also note the explainer logic lives in the generic leg but is keyed by the *matched review questionId* threaded down from the review branch — say so, or implementers will hang it in the wrong place.

### 8. MEDIUM — Blueprint step 6 still teaches runners the two-state protocol; Chunk 4 edits the adjacent lines but not this one

**Evidence.** `Blueprint.ts:907`: "Any reply other than an exact pass phrase (都可以了 / 可以了 / 通过 / LGTM / approved) is revision feedback. Apply it, commit … republish, and open a NEW founder_review round." Under three-state this is false — a neither reply is not revision feedback, arrives via Lead relay (not via `check`), and must not trigger a republish cycle. Steps 5-6 (:906-907) and the HONEST COMMENT RETURN line (:909) all need the same pass as the comment-layer marker addition the plan already makes in this file. Left stale, runners will republish new rounds off Lead-relayed questions.

**Fix.** Add `founderProductReviewLines` (:897-910) to Chunk 4's edit list: revision feedback arrives either as a written kickback (check) or as Lead relay; questions/chat leave the round open; only kickback/relay feedback triggers the revise-republish-new-round loop.

### 9. LOW — Discord 2000-char limit fragments long summary pastes; only part 1 carries the marker; the kickback receipt overclaims completeness

A heavy review round's copy-all output exceeds one Discord message. Part 1 (marker) → kickback with partial feedback + receipt "你的意见已交给 runner"; parts 2+ (no marker) → neither → Lead. Feedback is split across two channels and the receipt claims completeness. Cheap mitigations: Blueprint contract instructs the copy button to emit the marker on every ~1800-char chunk, and/or the receipt says "已收到 N 字;若你分了多条,其余会经 Lead 转达".

### 10. LOW — Marker carries `<issue-identifier>` but the classifier ignores it; a cross-issue paste records as this round's kickback

Chunk 1 rule 3 matches the marker prefix only. The deliverer ctx has `issueId` (`founder-reply-deliverer.ts:66`); when the identifier in the marker line is present and mismatched, prefer `neither` (→ Lead) over kickback. One conditional, no new signature if passed as an optional arg.

### 11. LOW — Pre-deploy cards keep the contradictory copy for their whole lifetime

Rounds opened before deploy still show "直接回复这条卡片 = 打回" for days. The neither-explainer teaches the new protocol on first contact, which is adequate — but say it in §4 so the ship checklist doesn't get surprised, and confirm Lead stops the manual per-card disclaimer only for post-deploy cards.

### 12. LOW — `both_reactions_present` requires a second reactions GET even on ✅-confirmed rounds; keep it inside the existing per-qid throttle

The current throttle is one reactions GET per qid per 15s interval (`gate-poller.ts:3058-3064, 2971-2973`). The ❌ probe (and the both-present audit, if kept) should share that budget, not add an unthrottled second fetch. Trivial, but the plan's Chunk 3 doesn't mention it.

### 13. Correctness — file:line claims checked (research.md + plan.md)

Confirmed exact: `founder-review-response.ts:26` classifier and else-kickback shape (:43-45, empty-text no-feedback); `:49` shared writer; `:85-101` stale_round guard; `:126` reaction path; `founder-reply-deliverer.ts:585-613` founder_review branch; `:593-597` sole-open-round binding incl. verbatim comment; `:705-733` transport-only comment + `deliverAmbiguousToLead`; `founder-thread-notifier.ts:154-155` contradictory copy (verbatim); `gate-poller.ts:3088` reaction call; `founder-confirmation.ts:22` `FOUNDER_CONFIRM_EMOJI`, `:122-131` emoji param; `db.ts:1749` `insertResponseIfGateOpen` (same-tx `markQuestionTerminalDisposed` at :1792), `:1798` review wrapper, `:1939` `insertFounderApprovalResponseWithSource` (kind = founder_feedback when `approved !== true`, :1988-1993); `founder-review.ts:376-448` verdict resolution; `complete.ts:139-155` block reason, `:360-374` both `process.exit(1)` branches; `write-gate-response.ts:498` `isApproval` binary boundary, feedback payloads :531-536/:562-567; `gate-materializer.ts:191` two-way card copy; `Blueprint.ts:869-874` comment layer, `:909` honest comment return; `approval-intent.ts:3` three-state enum; `gate-response-router.ts:260-267` Lead-approve 403; `deferred-approval.ts:225-227` 已存着 truth-in-time; `founder-ship-approval-handler.ts:453-456` unclear never replies; `text-approval-source.ts:8` unclear → WAKE-only. Callers of `classifyFounderReviewReply` / `writeTrustedFounderReviewResponse`: only the deliverer and the reaction path — the plan misses no callers on the review side.

**Wrong/overstated:** research §2's claim that the relay leg "必然铸成 kickback" (Issue 6 — attribution gating means plain response, no source event, in the production-default off mode). Research §1.2's "`founder-reply-deliverer.ts:529-613`" for `processFounderMessage` is slightly off (function spans :529-733) — cosmetic.

### 14. Risk & blast radius (requested assessment)

- **Chunk 2 is the riskiest.** `processFounderMessage` is the single ingress for ALL founder text — review rounds, ship gates, brainstorm gates, plain chat. A fall-through bug here doesn't degrade one feature; it mis-routes the founder's only approval channel (Issue 1 is exactly such a bug already visible in the spec). It needs the coexistence matrix in tests, not just the seven-instance fixtures.
- **Chunk 5 second.** The write boundary has six callers and existing byte-frozen conflict semantics (`response-guard.ts:5`); a wrong guard strands parked decisions (Issue 2) or 409s the Lead relay in a new way.
- **Chunks 1/3/4 are low risk** (pure function; poller addition behind existing throttle; copy/contract text). Chunk 4's Blueprint edits only affect newly spawned runners (prompt read at spawn), so no live-runner hazard.
- **Rollback claim is accurate**: no migration, no flag; revert restores byte behavior. The one soft residue is founder-visible copy/receipts changing back — acceptable.

### 15. Sequencing & scope (requested assessment)

- Chunk order 1→2→3→4 is right; 6 (TDD) должен precede as red tests per project discipline — the plan says so.
- **Chunk 5 deferral is only half-safe.** The direct text leg is already three-state (classifier unclear → WAKE-only, verified), so instance-7-shaped questions on the direct leg are already guarded today; but instance 4 happened anyway, which means it came through a leg the classifier doesn't guard (forensic pending). Until Chunk 5 lands, that leg stays open. If Chunk 5 splits to PR-2, the plan must state FLY-1847's acceptance ("提问/讨论不触发状态变更" — covering ship cards) is NOT met until PR-2 merges, and the forensic (Issue 6) must complete before PR-2's design freezes.
- **Scope is proportionate** — no over-engineering found. Every added piece (marker, ❌ leg, receipts, explainer, guard) maps to an acceptance row; nothing is a detector bolted onto a broken structure; the rejected alternatives are genuinely rejected for cause. The `--kickback` CLI flag is justified by the issue's "Lead 确认" requirement and the plumbing is realistic (verified: `respond.ts:66-84` → `/api/founder-consent/runner-gate-response` → `gate-response-router.ts:299-348` → write args; four layers, one repo, deploys atomically).

## Verdict

CHANGES REQUESTED

Blocking: Issues 1 and 2 (plus 6's forensic-before-design-freeze for Chunk 5). Strongly recommended before implementation: 3, 4, 5, 7, 8. The rest are notes the implementer can fold in. The core design — fail-closed three-state with five explicit verdict signals, receipts at the verdict moment, and the copy/contract rewrite — is sound and should proceed once the fall-through boundary and the write-boundary caller matrix are pinned.
