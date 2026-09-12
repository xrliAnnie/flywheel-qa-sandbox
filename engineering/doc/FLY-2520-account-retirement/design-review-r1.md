# FLY-2520 账号到期排序 — 调研
Issue: FLY-2520 (https://linear.app/geoforge3d/issue/FLY-2520)
日期: 2026-09-11
基于: plan.md

Design review R1: CHANGES_REQUESTED
Request: 88a8aad0-5834-4fe6-bfb1-588994a910cf
Gate: 7a6d9693-0c35-4164-8887-b0fe050ce045

Lead governance question: 9e2f53f0-a27b-4d5f-b3d7-7abc71d4d601. Active-seat trigger proposal conflicts with explicit scope; awaiting ruling before fresh review.

## HIGH active-seat-retirement-unhandled

Retirement guard covers only candidates; the active account at its own retiresAt is never rotated away

Every guard the plan specifies applies to non-active accounts only: verifyAndRankCandidates skips `name === snapshot.activeName` (account-candidate-selector.ts:179) and selectNextAccount filters `account.name === input.currentName` (account-store.ts:512, 534). Meanwhile the feature's whole purpose — rank by min(resetMs, retiresAtMs) — deterministically steers the fleet ONTO the soon-retiring account and keeps it there, so by construction that account is the ACTIVE seat at the retirement instant.

No switch trigger in pollOnce keys on store state: triggers are 5h/weekly pct on the active account, model caps, dead-liveness probe, and manual (quota-monitor.ts:1503+). Verified failure path: once business's credential stops working, `fetchUsage` returns `unauthorized` -> `emitBlind` -> warning alert and `return finish("blind")` with NO switch (quota-monitor.ts:1757-1766, 278-292). A switch only happens if `activeUnreadableStreak >= deadProbeStreak` (default 2, base poll 20 min) AND `probeActiveLiveness` classifies it `dead`; classifyAccountLiveness returns `unknown` for `forbidden_unconfirmed` / `profile_missing` / `free_org_unconfirmed` (account-liveness.ts:28-42), in which case the monitor stays blind indefinitely while every runner on that account fails.

Failure scenario: business retires 2026-09-14T00:00:00-07:00 as the plan's own default; the ranking has kept business active since Friday; at 00:00 PT Sunday every runner starts failing, the monitor emits `quota_read_blind` warnings and does not rotate for at least ~40 minutes, and possibly never if the profile probe returns unknown. exploration.md states the requirement as "已到期账号不可用" — the plan does not make a retired account unusable when it holds the active seat.

The plan must either (a) add `retiresAt <= now` on the active account as a switch trigger in pollOnce (and/or a pre-retirement proactive rotation window), or (b) explicitly scope it out with a stated founder runbook plus a pre-retirement warning alert. Silence is not an option here because the instant is scheduled and known in advance.

## MEDIUM retiresat-parse-accepts-offsetless

"带时区的 ISO 时间" is not enforced by Date.parse; offset-less strings silently shift the boundary by hours

Item 1 requires a timezone-bearing ISO instant but specifies validation only as "有效返回毫秒，无效安全拒绝", i.e. Date.parse. Date.parse("2026-09-14") is valid and means UTC midnight (= 2026-09-13T17:00-07:00); Date.parse("2026-09-14T00:00:00") is valid and means host-local midnight. Both parse cleanly, so "无效安全拒绝" never fires, and the retirement moment lands up to 7-24h away from what the operator intended.

Failure scenario: Lead writes `"retiresAt": "2026-09-14"` into claude-accounts.json. business is treated as retired from Sunday 17:00 PT on 9-13 — a full workday of capacity silently discarded, and the ranking flips relative to school's Monday 09:00 PT reset, which is exactly the sub-24h margin the calendar-ruling.md ordering turns on. Recommend a regex requiring an explicit offset or Z (e.g. /T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:\d{2})$/) before Date.parse, and a test pinning that date-only and offset-less strings are rejected.

## MEDIUM strict-read-whole-store-rejection

Rejecting the whole store on one invalid retiresAt has a blast radius no other date field has

Item 1 says "严格读取拒绝无效配置". readStoreStrict currently type-checks quotaExhaustedUntil / weeklyResetAt / switchCooldownUntil as strings only — it never Date.parses them (account-store.ts:700-713). retiresAt would become the only date field whose malformation returns null for the ENTIRE store.

Failure scenario: one typo in one account's retiresAt makes readStoreStrict return null, so recordObservationInStore returns "invalid_store" for every account (quota observations stop persisting), syncActiveAccountInStore / syncFreshenedActiveAccountInStore return "invalid_store" (active-profile reconciliation stops), and the capacity snapshot drops the whole Claude quota cell as "transient: account_store_unreadable" (capacity-snapshot.ts:360-367) — which is also mislabeled transient, since bad config does not heal itself. One bad character disables account self-heal pool-wide. Prefer per-entry fail-closed handling (that entry is ineligible and reported) over whole-store rejection, or at minimum state explicitly that whole-store rejection is the intended blast radius and add the structural (not transient) unavailable token.

## MEDIUM earliest-reset-not-retirement-aware

earliestReset is not in scope, so the "all accounts exhausted" founder message can quote a retired account's reset

The plan lists capacity snapshot, patrol line and panorama as the display surfaces but never mentions earliestReset (account-store.ts:865-894), which iterates ALL store accounts with no auth/retirement filter and returns the soonest future quotaExhaustedUntil / switchCooldownUntil / weeklyResetAt.

Failure scenario: business is retired and everything else is exhausted. switch-executor returns no_account with earliestReset = business's future weeklyResetAt (switch-executor.ts:1038), and account-switch-repair.ts:246-252 renders to the founder: "所有 Claude 账号都已用尽，最早 reset: <business 的周一 reset>。需要你处理(等 reset / 手动 login)". The founder waits for a reset that can never restore that account. quota-guard-cli.ts:750 has the same shape. Either exclude retired accounts from earliestReset or state why the stale advice is acceptable.

## MEDIUM no-configuration-path-for-retiresat

No validated write path for the new field — the plan defers production config to hand-editing a lock-protected file

The plan adds a read-side field but no CLI, no schema doc, and no validation tool, and defers the production write to "QA/Lead 在有授权的 host 轮完成". writeStore's contract is explicit: "Callers MUST hold ~/.flywheel/claude-accounts.lock across read->mutate->write (C5)" (account-store.ts:820-823). A hand edit takes no lock, and the daemon does a full read-modify-write of the file on every observation.

Failure scenario: Lead edits claude-accounts.json in an editor while the quota daemon is running; a concurrent recordObservationInStore rewrite lands between the editor's read and its save (or vice versa) and the retiresAt line vanishes. Nothing reports this — the feature simply never activates, and combined with finding retiresat-parse-accepts-offsetless there is no feedback at all that the config was wrong or lost. Add a small lock-respecting setter (e.g. a `flywheel-account-retire <name> <iso>` path or an explicit documented `scripts/` recipe that takes the lock and validates the string) so the handoff step is verifiable.

## LOW sweep-candidates-not-retirement-aware

sweepCandidates keeps probing credentials and recording observations for retired accounts

The plan names verifyAndRankCandidates and selectNextAccount but not sweepCandidates (quota-monitor.ts:364-420), the third place that iterates config.order + poolAccounts. It only skips entries with `unavailable !== undefined`, so a retired account keeps getting a credential read and a usage API call every candidateSweepMinutes (default 60) and keeps having observations projected onto it.

Failure scenario: after business retires, every sweep makes a pointless credential+usage round trip against a dead account, and the recorded observation keeps refreshing its lastObservedAt so it never shows as stale in the capacity line — the patrol row for a dead account looks freshly observed. Harmless but noisy; add the retirement guard to the sweep skip condition or note it as deliberately out of scope.

## LOW patrol-pt-date-has-no-timezone-source

Patrol line "PT 日期" is unspecified — hook-payload has no timezone input and renders every instant as UTC ISO

Item 4 asks for a PT date such as `business(9-14 到期)` in the patrol quota line, but hook-payload's renderer normalizes every timestamp through capacityInstant -> new Date(x).toISOString() (hook-payload.ts:702-710) and takes no timezone parameter; the only timezone plumbing in this area is switch-executor.ts:620 (`context?.founderTimezone ?? "America/Los_Angeles"`) and account-switch-notification's `timezone` argument.

Failure scenario: the implementer hardcodes America/Los_Angeles inside a pure renderer that until now has been timezone-free, and a test authored on a non-PT host or after a DST shift renders `9-13` instead of `9-14`. State where the zone comes from (constant vs. injected) and pin the DST-boundary case in the test.

## LOW retirement-vs-existing-canceled-liveness

Plan does not reconcile retiresAt with the existing live-detected cancellation signal

classifyAccountLiveness already treats `profile.subscription.status === "canceled"` as `dead` (account-liveness.ts:34-36), which routes to handleAccountDead and marks the account terminally `unavailable`. The plan introduces a second, operator-configured source of truth for "this account is gone" without saying how the two interact — notably that the reactive path writes a persistent unavailable mark while retiresAt writes nothing.

Failure scenario: the reactive path fires first and marks business unavailable; retiresAt is then dead config that nobody clears, and a later operator who removes the unavailable mark to reuse the slot silently re-enables the retirement exclusion with no panorama trail distinguishing the two causes. One sentence in the plan stating the precedence (retiresAt = scheduled/pre-emptive, profile_canceled = reactive/terminal) removes the ambiguity.
