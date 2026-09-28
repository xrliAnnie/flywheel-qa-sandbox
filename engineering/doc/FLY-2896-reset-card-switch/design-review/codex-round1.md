# Design Review — plan.md (Round 1)
Date: 2026-09-25 / Author: Codex / Status: CHANGES REQUESTED

## Summary

Plan v2 has the right overall boundary: the daemon owns reset-card state and the irreversible API call; Bridge only presents consent; direct candidates retain priority; approval is episode- and fact-bound; the existing switch path and FLY-2830 generation-driven full re-read are reused. However, the current state machine can still (a) misclassify a card that was already spent after an unconfirmed POST, (b) spend against stale consent facts or a stale active-account witness, and (c) lose the successful outcome if the process dies after `switchAccount()` commits. Those are correctness and at-most-once/consent failures, so the plan is not ready to implement yet.

## What's Good (Keep)

- Keep the daemon/Bridge authority split, exact founder-ID filtering, fail-closed unreadable/timeout behavior, and the rule that Bridge never calls Anthropic or mutates the proposal file.
- Keep the two thresholds distinct: solicit consent at 85%, but redeem/switch only at the existing 5h 90% or weekly 100% switch line.
- Keep healthy direct candidates ahead of card candidates, while excluding accounts that merely have low headroom (at or above the trigger).
- Keep the 30-minute driving-window suppression, natural-recovery ordering, card-count tie-break, and deterministic account-name tie-break.
- Keep the request ID durably recorded before POST, the immediate no-retry rule for an unconfirmed response, and the bounded retry budget.
- Keep the existing `switchAccount()` path and generation increment as the FLY-2830 full-re-read trigger; do not create a parallel account-switch implementation.
- Keep dependency injection for cedar/reset endpoints and the explicit prohibition on production Keychain and real-card access in tests.

## Issues & Recommendations

1. **[BLOCKING] The retry/result matrix is not aware of a prior ambiguous POST, and “usage cleared” is not proof that a card was spent.**

   **Issue:** Plan §5.4 steps 6a–6c classify `already_used`, `not_limited`, `cooldown`, `ineligible`, and other refusals as terminal failure regardless of whether this is the first POST or the one allowed retry. It also treats either `resetsLeft -1` **or** exhausted usage falling below threshold as proof of `reset`. The extracted Claude client does the opposite for a pending request: `already_used` means the earlier reset went through; `not_limited` can mean limits are now clear; and cooldown/ineligible/rate-limit responses say the earlier reset may still be processing (`cedar-ember-excerpts.txt:400-447`, with the same pattern at `531-558`). Usage can also clear naturally while `resetsLeft` remains unchanged when `recoveryAt` passes.

   **Why:** A first request can spend the card but lose its response. The second request can then return `already_used` or `cooldown`; the proposed matrix records failure, leaves the account card-cooled, and reports the wrong outcome. Conversely, a natural window reset can be falsely audited and messaged as a consumed card.

   **Fix:** Make response interpretation depend on `attempt` and prior ambiguity. After any ambiguous first POST, never infer “not spent” from a later refusal alone. Re-read cedar plus usage and distinguish at least: `redeemed_confirmed` (`resetsLeft` decreased), `recovered_without_proven_redeem` (usage recovered but counter did not), and `redeem_ambiguous` (neither proves an outcome). Do not resend after natural recovery. Only a deterministic first-attempt refusal may be terminal “not spent.” Add second-attempt tests for `already_used`, `not_limited`, `cooldown`, 429, 401, counter decrement, and crossing `recoveryAt` with an unchanged counter.

2. **[BLOCKING] There is no recoverable commit point after redemption verification and around the existing switch transaction.**

   **Issue:** Plan §5.4 persists `executing` before POST, but after redemption verification it calls `switchAccount()`, then settles/refetches/audits, and only afterward makes the proposal terminal. `switchAccount()` commits `activeAccount`, generation, and `lastSwitch` atomically in AccountStore (`switch-executor.ts:1224-1239`). A crash immediately after that commit leaves the proposal `executing`/`redeem_unconfirmed`; after restart, the lightweight check sees a changed active/generation and can cancel it as `active_changed`. The plan has not persisted enough switch intent/trigger data to reconstruct settlement either. Disabling `resetCardEnabled` after such a crash would also skip the needed reconciliation.

   **Why:** The card and switch may both have succeeded, yet audit, Discord outcome, settlement/revive state, cooldown clearing, and the proposal terminal state can be missing or wrong. This is precisely a restart boundary, not an exotic API failure.

   **Fix:** Persist explicit post-POST/switch phases and the data needed to resume idempotently (verified redemption outcome, switch intent, trigger/scope/reset time, expected from/to account and generation) before each irreversible transition. On restart, reconcile AccountStore `activeAccount`/generation/`lastSwitch` and the existing transition journal; a matching `noop_already_switched` must be completed as success, not cancelled. In-flight `executing` records must receive read-only reconciliation even when the feature flag is turned off; the flag may stop new proposals/actions, not erase an already-started outcome. Add crash-injection tests after redemption verification, after switch-store commit, after settlement, and before audit/terminal persistence.

3. **[BLOCKING] Execution re-checks do not reproduce the consent-bearing selection facts and explicitly allow early redemption.**

   **Issue:** Plan §5.4 step 4 checks that the original target/grant is still usable and that no healthy direct candidate exists, but it does not rerun bounded discovery and selection across all eligible card accounts. The target's natural recovery, card count, grant properties, exhausted set, another target becoming the correct latest-recovery choice, or the active driving window can change without changing the grant ID. The same step permits execution when the target is no longer limited if `useRequiresLimit=false`, conflicting with the founder requirement (“among exhausted accounts”) and §10’s statement that this feature does not proactively early-redeem.

   **Why:** Founder approval is for the displayed account/card/recovery/runway facts, not merely for a grant ID. The current check can spend a valid card for a choice the selection algorithm would no longer make, or spend against a naturally recovered target.

   **Fix:** Define the exact execution-facts digest and the explicitly allowed drift (for example, active utilization advancing from the ask threshold to the switch line). At execution, rerun bounded direct-candidate and card-candidate discovery, rebuild the selection/consent facts, and require the selected target/grant/exhausted set/natural recovery/card count and other consent-bearing fields to match that digest. Any material change cancels this approval and creates a fresh proposal if still warranted. Always require the target to remain exhausted for this feature, regardless of `useRequiresLimit`. Test same grant ID with changed recovery/cards/clears, a newly preferable target, target natural recovery, and changed active driving window.

4. **[BLOCKING] The active-account witness is too old when the irreversible POST occurs.**

   **Issue:** The proposed execution performs multiple external reads (profile, cedar, usage, candidate scans) and only then persists `executing` and POSTs. Existing `readCandidateCredential()` validates the active/generation witness under the account lock before returning a credential (`quota-monitor.ts:330-370`), but network work happens after that witness. A manual or ordinary switch can change the active account/generation during those reads. The plan also proposes clearing cooldown fields without specifying an expected-generation/observation CAS.

   **Why:** The daemon can consume a card for an obsolete episode after authority moved to another active account; a stale recovery write can also erase a newer cooldown written by a concurrent switch.

   **Fix:** After all external reads and immediately before the point of no return, reacquire the accounts lock and revalidate active account, generation, credential witness, current approved proposal, config, and selection digest. Persist the durable `executing + requestId` record as that linearization point before releasing the lock and POSTing. Make cooldown clearing conditional on expected generation/account and on the observation that proved recovery. Add races that switch/generation-bump between GET and `executing`, and between recovery observation and cooldown clearing.

5. **[BLOCKING] The persistence contract is not strong enough for the at-most-once safety claim.**

   **Issue:** Invariant I7 promises temp → fsync → rename, but omits fsync of the parent directory, so the rename itself is not guaranteed durable across a host crash before the POST. The JSONL audit contract likewise does not require syncing the successful append before the proposal becomes terminal, and does not say how a truncated/malformed line or a tail read beginning mid-line affects deduplication.

   **Why:** Losing the pre-POST `executing/requestId` record allows the same episode to create a new proposal after restart; losing or silently skipping the audit record can defeat the “grant already used” guard. Both can lead to a second spend attempt.

   **Fix:** Specify and test file fsync, atomic rename, and parent-directory fsync before POST. Fsync/fdatasync the audit append before marking the proposal terminal. Define strict parsing/tail-boundary behavior: corruption that can conceal a relevant successful/ambiguous grant must fail closed and raise an operator-visible alert, not be ignored. Inject filesystem operations in tests and assert the exact ordering, including restart from every boundary.

6. **[BLOCKING] The plan admits eight cedar limit types but can only verify two usage windows.**

   **Issue:** `UsableResetGrant.clears`/`exhausted` accepts `five_hour`, `seven_day`, `seven_day_opus`, `seven_day_sonnet`, `cowork`, `omelette`, `oauth_apps`, and `extra_usage`; §5.4 step 7 requires every proposed exhausted window to recover. The current usage API validates and returns only `fiveHour` and `sevenDay` (`quota-usage-api.ts:16-27,119-125,213-227`), and §5.2’s `naturalRecovery` is also computed only from those two windows.

   **Why:** A scoped weekly/cowork/etc. limit can drive cedar `atLimit` while the plan neither ranks its natural recovery correctly nor proves it cleared before switching. That can spend a card and activate an account that remains unusable.

   **Fix:** Either constrain v1 proposals to an exhausted set wholly representable as `{five_hour, seven_day}` and fail closed on every other limit key, or add authoritative parsing, recovery time, percentage, and post-reset verification for each supported key. Add fixtures for `seven_day_opus`, `cowork`, and mixed exhausted sets.

7. **[BLOCKING] Two independent reaction reads do not yet define a safe decision linearization.**

   **Issue:** Plan §5.6 requires ✅ `confirmed` and ❌ `not_yet`, but does not prescribe read order or a final reject check. Two concurrent requests (or checking ❌ first) allow this interleaving: ❌ is observed absent, founder adds ❌, then ✅ is observed present, and Bridge durably approves even though the explicit reject now exists. `checkReactionConfirmation()` is a paginated point read, not an atomic two-emoji snapshot (`founder-confirmation.ts:122-161`).

   **Why:** An explicit ❌ is binding “not approved”; this race can authorize a card spend contrary to the founder’s final reaction state.

   **Fix:** Define a linearization rule that reads affirmative first and performs the reject check last, immediately before the durable state transition; any unreadable page or any observed reject fails closed. Recheck expiry/founder binding after the final read. Add an interleaving test where ❌ appears between the two reads and prove no approval is written.

8. **[BLOCKING] Audit deduplication is keyed too broadly by grant ID alone.**

   **Issue:** Plan §5.3/§5.7 says the audit tail blocks a proposal when the `grant id` was previously used, although audit records already include `target.name`. The cedar contract only constrains the grant-ID string; it does not establish global uniqueness across accounts. The observed sample ID is campaign-like (`opus55-launch-promax-20260921`), while the related research says multiple accounts can each have a reset card.

   **Why:** Redeeming a campaign grant on one account can permanently suppress a distinct card on another account if they share an ID, breaking the requested multi-account selection behavior.

   **Fix:** Key redemption safety by a non-secret stable account identity plus grant ID (at minimum `(target.name, grant.id)` under the existing account-name validation), with proposal/request ID used for attempt idempotency. Test same grant ID on two accounts (both independently eligible) and repeated grant ID on the same account (blocked).

9. **[ADVISORY] Make the GatePoller failure isolation concrete in §5.6.**

   **Issue:** The plan says reset-card processing must not depend on `landOperationTick()` succeeding, but also says not to change the surrounding structure. Today `await this.landOperationTick()` is outside the `try/finally` that guarantees scheduler progress (`bridge/plugin.ts:12877-12885`).

   **Why:** A land-operation exception can prevent the consent tick from running despite the stated contract.

   **Fix:** Show the intended outer `try/finally` (or equivalent per-subsystem isolation) explicitly and test that both reset-card processing and `scheduler.tick()` still run when `landOperationTick()` throws.

10. **[ADVISORY] Strengthen the degraded-path acceptance tests.**

    **Issue:** §6 checks zero POST on reject/timeout/unreadable and says the degraded switch continues, but it does not assert that the existing low-headroom switch candidate is actually attempted, nor that reset-card proposal failures never turn the daemon into monitor-only.

    **Why:** A test can pass with zero redemption while accidentally returning early before today’s degraded switch behavior.

    **Fix:** In each reject/timeout/unreadable/invalid-proposal case, assert both zero reset POST and the expected existing `switchAccount()` call/result. Also inject proposal/audit I/O failures and verify the ordinary switch path and polling loop remain live.

## Verdict

CHANGES REQUESTED

Resolve the eight blocking state-machine, concurrency, crash-recovery, verification, and identity issues above before implementation. The high-level ownership split and reuse of the existing switch path should remain unchanged.
