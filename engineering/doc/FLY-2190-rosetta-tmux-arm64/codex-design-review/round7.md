# Design Review — FLY-2190 plan.md (Round 7)

Date: 2026-08-30
Author: Codex
Status: APPROVED

## Summary

Round 7 closes the remaining correctness and safety defects. The fail-closed A0 census now makes coverage of every live plist-selected carrier a machine-enforced prerequisite, the gate has an explicit packaged-runtime closure, and the plan accurately limits S0 to point-in-time protection backed by operational controls between checks. S0–S2 are ready to implement while S3 remains honestly parked behind P1–P7.

## What's Good (Keep)

- §1.6.1 converts the two unmanaged production wrappers from a hidden fleet hole into an explicit, blocking disposition. A0 cannot pass unless every live Lead plist maps to registered source, deployed bytes, and an S0 mount; unknown or drifted wrappers fail closed.
- Requiring atomic deployed-byte updates before any affected restart preserves the intended ordering for the two exceptional Lead classes.
- The packaged deployment story is now complete enough to implement: the gate is included in the package manifest and audit, asserted in both payload shapes, and covered by copy-closure and drift/mode tests when installed under the state bin.
- The temporal claim is now correct. S0 proves selection at checked birth/deployment boundaries; it does not claim to stop later host drift from changing bare `tmux` calls in already-running processes.
- The receipt schema, production override restriction, and placement rule close the ambiguity around standalone KeepAlive births and wrapper-specific startup layouts.
- The upstream correction is now in the operative exploration text, so the withdrawn rolling conclusion is not recoverable by ignoring a banner.
- P1–P7 still cover the known S3 blocker classes. No eighth blocker class is evident from this review.

## Issues & Recommendations

The following are non-blocking implementation notes, not correctness or safety defects:

1. Reconcile the old inventory counts after choosing the two exceptional wrappers' disposition. §1.1 still says “10 production sites,” its v2-wrapper row still describes all 16 Leads, and §1.4, §2.2, and A1 retain the old 10+1 framing. Update the registry, RED/GREEN expectations, and acceptance counts to the final managed carrier set.
2. Make the §1.6.1 choice before implementation begins. Prefer bringing reviewed versions of the two actual live wrapper shapes under source control with a tested install/converge authority; migrating them onto another carrier is a broader backend-sensitive change and should be selected only with equivalent-behavior proof.
3. Pin one literal production lookup path for `host-tmux-selection-gate.sh`. The plan currently requires a fixed default but still leaves the state-bin copy closure conditional. Select the monorepo/prebuilt path or the state-bin path and make its packaging/converge tests unconditional for that choice.
4. Define the single receipt file's overwrite semantics. Because multiple carrier births write the same path, state explicitly that it represents only the latest successful check, or use per-carrier receipts if later acceptance or audit needs simultaneous evidence for all mounts.

## Verdict

APPROVED — ready to implement
