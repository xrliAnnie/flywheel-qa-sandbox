# Design Review — FLY-1914 plan.md (Round 2)

Date: 2026-08-19
Author: Codex
Status: CHANGES REQUESTED

## Summary

All six Round 1 findings are substantively addressed, and the revised preflight, drift state machine, receipt binding, milestone corrections, and executable gates are materially stronger. Two deployment-order gaps remain: the final execution summary now places the fork merge before the checker-first Phase A, and the new main-repository co-deploy audit can go stale before `restart-services.sh` fetches and deploys latest main.

## What's Good (Keep)

- The two-pass P1-P3 model plus the fork-main write freeze closes the original PR-head TOCTOU gap without changing the approved plugin bytes.
- P2 now distinguishes transient GitHub state, policy/check failures, invalid PR identity, head drift, and genuine conflicts; only the genuine conflict path rebases.
- The commands are executable and currently produce the expected predicates: fork main `49c8c478542532cb37df0a6d39af62f09c0897d8`, PR #23 OPEN/MERGEABLE/CLEAN at `a3117e1cfef448304cf16d461d87ec5a874afbea`, successful check rollup, and fork manifest `0.0.4`.
- F17 is correctly repaired. PR #821 is merged at `e08c8d0a609e0c0a556a4ebafb7ab27393595cbe`, that commit is an ancestor of production `deployed-sha`, and the census rationale now correctly covers surviving pre-existing/not-restarted adapters.
- F20 and Delta-4 make the current main deployment gap explicit instead of assuming the FLY-1730-era restart surface is unchanged.
- Delta-5 correctly uses existing evidence: `.reason == "updater"`, exact request-marker consumption, and absence of a wave-scoped degraded alert supplement the original SHA/time/health/plugin-byte gates.
- B1's timestamp and unreadable-root disclosure rule prevents a missing cache from being reported as a clean sweep; B2 now repairs the three stale milestone rows alongside the new FLY-1914 row.

## Issues & Recommendations

1. **The final execution order reverses the checker-first safety invariant.** Plan §8.3 says `fork PR #23 merge → runbook §4 (Delta-1 first)`, but inherited FLY-1730 §4 requires Phase A step 2 (install and verify the dual-marker checker against live 0.0.4) **before** Phase B step 4 merges the fork PR. Following §8.3 literally changes fork main while the live checker still requires `ChatReceiptRuntime`; the Phase-A main-repo updater wave can then install 0.0.5 and fail its old-checker recheck before Delta-1 is reached. Rewrite the canonical sequence as: co-deploy audit/holds → main-doc PR merge and managed convergence → install and verify the dual checker against 0.0.4 → pre-wave census → final P1-P3 and fork freeze → fork PR #23 merge and freeze its SHA/version → fork-main re-read → Phase-B enqueue/receipts → census/archive/QA. Make §8 the authoritative expansion of inherited Phase A→B→C so there is no competing interpretation.

2. **Delta-4 still has a main-branch freshness/TOCTOU gap.** `git log <deployed-sha>..origin/main` does not fetch remote truth, and both `update-flywheel.sh` and `restart-services.sh` fetch/pull the latest main after enqueue. A main PR landing after the audit can therefore be co-deployed; the existing exact `codeDeployedSha` receipt detects this only after mutation, which does not satisfy “no silent co-deploy.” Resolve this with the same process discipline used for the fork: query/fetch and record a full remote-main SHA, verify the deployed SHA is its ancestor, audit that exact range plus the approved FLY-1914 docs change, then hold main writes/merges (with the FLY-1914 merge as the recorded exception) through the Phase-B terminal receipt. Re-read remote main immediately before each restart enqueue and require it to equal the audited/frozen SHA; mismatch stops before mutation.

## Verdict

CHANGES REQUESTED — address items above
