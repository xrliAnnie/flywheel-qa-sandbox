# Design Review — plan.md (FLY-1501) (Round 7)

Date: 2026-07-27
Author: Codex
Status: CHANGES REQUESTED

## Summary

Round 7 correctly makes canonical quarantine share the gate’s child lock and revalidates the exact pre-validation bytes under that lock; it also makes plan W3/W2-reconcile the unambiguous normative source. Two engineering contracts are still missing: a digest-mismatch result has no guaranteed production retry path, and the canonical-basename language used to choose the lock class is not yet frozen or shared with the gate writer.

## What's Good (Keep)

- Canonical spool quarantine now takes the same `<child_key>.lock` as gate/mark-applied, while names that cannot be a legal gate target use the separate root `_quarantine.lock`; this is the correct lock-domain split.
- Passing the SHA-256 captured from the bytes used for pre-validation, then re-reading and hashing inside the helper-held lock, closes the Round 6 check/use race without requiring TS to mutate spool files.
- A digest mismatch leaves the newly published file untouched, and the diagnostic event records the original digest; the historical diagnostic therefore still describes the bytes that failed validation.
- A12 now includes the real two-process interleaving where gate replaces the bad file under the child lock and advances to attempted.
- plan.md:49 declares W3/W2-reconcile as the sole normative contract, and research.md:114 explicitly inventories the superseded O_EXCL, alert-leg, subcommand and wrapper-count statements. This resolves the prior competing-contract problem without rewriting the archived exploration prose.

## Issues & Recommendations

1. **[HIGH] `digest mismatch → exit 0` has no guaranteed reconcile continuation, so the protected legal spool can remain unprojected indefinitely.** plan.md:41 says a mismatch is a successful no-op and relies on “下轮 reconcile” to process the replacement. That outcome is indistinguishable at the frozen process interface from “moved” and “already gone,” while the only production call timing currently documented is kernel-service startup (research.md:177; batch-3 wiring), not a periodic loop. In the exact A12 interleaving, the current invocation has already rejected the old bytes and inserted zero obligations; gate then advances to `held_alert_attempted`, so it will not republish; helper preserves the replacement and returns 0. If the kernel stays up, no component is contractually required to invoke reconciliation again, leaving the live valid spool without an obligation. Freeze a nonterminal handoff: either give digest mismatch a distinct result (exit code or typed stdout) that makes the same `reconcileRestartStormSpool` invocation re-read/revalidate that basename in a bounded loop, or place restart-spool reconcile on an explicitly owned periodic single-instance tick with a maximum retry delay. If using the loop, define the churn bound and leave the file retryable after exhaustion. A12 should assert convergence without restarting the kernel or relying on an ad-hoc second test invocation.

2. **[MEDIUM] The predicate “basename can safely derive child/episode” is not an implementable shared contract yet, so a real canonical corrupt file can still be assigned the root lock.** plan.md:41 does not freeze the accepted child-key grammar, the canonical `window_start` encoding, the inverse filename parser, or a requirement that gate publishing and quarantine classification use the same routine. This matters most for invalid JSON, where payload fields cannot help classification: misclassifying a basename that gate can actually publish recreates the Round 6 race because `_quarantine.lock` does not fence the child writer. Current dynamic Lead inputs are constrained by `ProjectConfig.ts:387/402/595`, but the Python gate CLI and the four static child keys need one explicit cross-language/filesystem contract rather than an inferred regex. Define one canonical encoder/decoder (for example, a child-key grammar excluding the episode delimiter plus one exact UTC timestamp form), require the gate CLI to reject child keys that cannot round-trip through it, and have both ensure-spool and quarantine call the same Python parser. Add round-trip/rejection tests and make the A12 invalid-JSON interleaving assert that the helper actually contends on the expected child lock, not merely that the final state happened to converge.

## Verdict

CHANGES REQUESTED — address items above
