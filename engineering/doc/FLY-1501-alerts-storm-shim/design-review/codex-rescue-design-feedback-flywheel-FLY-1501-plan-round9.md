# Design Review — plan.md (FLY-1501) (Round 9)

Date: 2026-07-27
Author: Codex
Status: CHANGES REQUESTED

## Summary

Round 9 closes the four Round 8 findings at the mechanism-placement level: the config boundary now seals the gate grammar, Python owns canonical validation, diagnostics are content-versioned, and ledger seq makes episode identity collision-free across same-second resume. The new `validate` subprocess contract still omits one field required for projection and does not exhaustively define ordinary file-race/I/O outcomes, so implementation would still have to invent behavior at a durability boundary.

## What's Good (Keep)

- Right-anchored `<child>__<timestamp>__<seq>` decoding is unambiguous even when the case-preserved child key itself contains `__`.
- Adding the derived restart-child-key invariant at ProjectConfig/manifest materialization prevents a config accepted upstream from becoming a permanently gate-rejected service.
- The pre-deployment enumeration of all existing fleet keys and the uppercase/`__`/over-limit acceptance cases appropriately cover compatibility and rejection.
- `validate` places canonical filename/schema/payload validation before `kernel.write`, while its digest cleanly anchors the later quarantine race decision.
- Digest-versioned invalid event IDs preserve same-content replay idempotency while retaining distinct corrupt versions; the separate exhaustion event makes bounded retry observable.
- Including the window-first ledger seq in the episode key faithfully extends v13’s seq authority and closes the same-second post-resume collision.

## Issues & Recommendations

1. **[HIGH] `validate` does not return all data needed to build the frozen projection from the bytes it validated.** plan.md:52 freezes success stdout as `{child_key, episode_key, window_start, seq, digest}`, but the restart-storm obligation payload includes `{window_start,count}` (research.md:177), and plan.md:40 requires exact spool validation before the transaction. TS therefore has no validated `count` to insert. Reopening/parsing the file in TS would violate the “single Python validator” placement and could consume bytes different from the digest/canonical fields already approved; deriving a constant count would lose the actual replayed threshold count. Make `validate` return a typed, complete projection record from the same byte buffer—at minimum `{child_key, episode_key, window_start, seq, count, digest}`, plus any other immutable spool fields that the obligation upsert validates—and require TS to build the transaction exclusively from that stdout record without reopening the spool. Freeze numeric/type bounds for `count` and `seq`. Add an acceptance case with a non-default count that proves the obligation payload exactly matches the helper-validated bytes.

2. **[MEDIUM] The new read-only command’s exit table is not exhaustive for races that are expected under the plan’s own concurrency model.** plan.md:49 defines only 0=valid, 5=invalid-with-reason-and-digest and 4=escape/usage. After TS enumerates a basename, gate can quarantine an invalid destination before `validate` opens it; ENOENT then has no bytes and cannot satisfy either the success JSON or the invalid-with-digest JSON contract. Read errors and non-regular entries are likewise unspecified. Freeze typed outcomes and caller behavior: for example, absent/already-moved is an idempotent skip with zero DB rows, retryable I/O leaves the live entry untouched for a later reconcile, and an actually readable-but-invalid file returns 5 with its digest for diagnostic+quarantine. Do not collapse an expected disappearance into usage error 4. Add a two-process test that pauses after enumeration, lets gate move the file, then resumes `validate` and asserts zero obligation, no bogus invalid event, and clean completion; add the chosen retryable-read-error case to the CLI table and A12.

## Verdict

CHANGES REQUESTED — address items above
