# Design Review — plan.md (FLY-1501) (Round 10)

Date: 2026-07-27
Author: Codex
Status: CHANGES REQUESTED

## Summary

Round 10 closes the two Round 9 findings for regular files: `validate` now returns the complete same-byte projection record, and its expected absence/retryable-I/O outcomes have explicit caller behavior. One race remains underspecified in the newly added non-regular sentinel path; without a frozen transition when the entry becomes regular under the quarantine lock, the design can again preserve a valid replacement without projecting it.

## What's Good (Keep)

- The success record now includes `count`, and TS is explicitly forbidden from reopening the spool; projection fields and digest therefore come from one validated byte buffer.
- Positive-integer bounds for `seq` and `count`, plus the non-default-count acceptance case, close the projection-shape gap.
- Exit 7 correctly models an expected enumerate→move race as an idempotent skip with zero obligation and zero bogus diagnostic.
- Exit 75 separates retryable filesystem failures from usage/corruption and leaves the durable live entry untouched.
- A12 now covers the real two-process disappearance race and verifies the caller mapping rather than only testing the helper in isolation.
- Classifying symlinks/directories with `lstat`-style non-regular semantics and rechecking under the mutation lock is the right safety direction.

## Issues & Recommendations

1. **[HIGH] The non-regular sentinel is not integrated into the frozen `quarantine` argument and state-transition contract.** plan.md:41 and plan.md:49 still define `quarantine --digest <sha256>` and the ordinary lock-in comparison as “recompute digest: match→move, mismatch→6.” plan.md:52 newly passes sentinel `-` for a symlink/directory and only says “仍非常规才移”; it does not say that `-` is a legal `--digest` value or define the result when the entry is now a regular file. That change is an expected protocol race: `validate` can classify a canonical-name symlink as non-regular, then gate can take the same child lock, quarantine it and publish a valid regular spool before TS invokes `quarantine`. Returning 0/no-op in that case would skip same-invocation revalidation and can leave the valid spool unprojected; moving it would destroy the valid replacement. Freeze a typed fingerprint union (for example `sha256:<hex> | nonregular`, rather than documenting the argument as SHA-256 only) and its lock-in state machine: absent→0; expected nonregular + still nonregular→durable move/0; expected nonregular + now regular→6 so the caller immediately re-enters `validate`; lstat/read retryable error→the chosen retry code; regular SHA mismatch→6 as already specified. State explicitly that non-regular checks do not follow symlinks. Add an A12 two-process case that pauses after sentinel validation, lets gate replace the entry with a valid same-basename regular spool, then proves `quarantine` returns 6 and the same reconcile invocation projects and marks applied without moving the replacement.

## Verdict

CHANGES REQUESTED — address items above
