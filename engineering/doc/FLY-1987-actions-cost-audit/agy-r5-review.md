> ⚠️ **历史留档 — 不是本单的评审依据。**
> founder 2026-08-22 直令:不再使用 Antigravity。本文件仅作过程留档保留,
> **不被 research.md / plan.md 引用为评审权威**。本单的评审记录本体是 **R5 = 真 Codex**(plan §4.1)。
> 其中已折入的两处校验器加固予以保留(它们本身是对的),但已被 R5 的重算式校验完全取代。

---

# Design Review — plan.md (Round 5, agy substitute)

## Summary
The research on CI costs (FLY-1987) is robust, and the discovery of the correctness hole (FLY-1996) is an excellent finding. The counterfactual ledger derivation accurately reflects the CI environment and job graphs. However, I attempted to mutate the ledger to test the robustness of the `aggregate.mjs` validator, and the validator failed to catch two structural integrity violations, meaning a maliciously mutated ledger could exaggerate both P1 and P3 savings without the script failing. 

## What's Good (Keep)
- The discovery of the `FLY-222-a0-a10-runbook.md` path security hole is correctly diagnosed and unequivocally proven by the test `launchd-units-manifest.test.sh`. It is exactly why path-based assumptions are risky without explicit validation constraints.
- The use of true run execution histories and PR file snapshots for computing the ledger provides an unassailable empirical baseline.
- The plan's founder-facing framing in §3 is extremely honest, deliberately framing projections as upper bounds and making it clear that cost savings will only be around 30%.
- The extraction rules in `derive.mjs` accurately match the true CI job names and topology (such as omitting `pnpm build` counting from the payload distribution job).

## Issues & Recommendations

1. **`aggregate.mjs` fails to restrict `3_P1_upper` bucket to `docs` or `chore_progress` commit labels**
   - **Severity**: HIGH
   - **Why it matters**: A core invariant of the P1 bucket is that the PR is inert because its current commit label is `docs` or `chore_progress`. However, the `aggregate.mjs` validation script only asserts that the baseline run is valid; it fails to assert that the current run's `commit_label` meets the criteria. A mutant ledger can label a `code` run as `3_P1_upper` (as long as it points to a valid baseline), and the validator will accept it, artificially inflating the P1 savings.
   - **Concrete suggested fix**: Add a requirement check in `aggregate.mjs` enforcing the `commit_label` invariant for P1 runs:
     ```javascript
     req(r.bucket !== '3_P1_upper' || ['docs', 'chore_progress'].includes(r.commit_label), 
         `run ${r.run_id}: bucket=3_P1_upper but commit_label is ${r.commit_label}`);
     ```

2. **`aggregate.mjs` allows `p3_upper_min` to be inflated regardless of `build_jobs`**
   - **Severity**: HIGH
   - **Why it matters**: `aggregate.mjs` only enforces that `p3_upper_min <= r.billed_min + 1e-9`. It completely misses the domain-specific invariant that P3 savings can only occur from actual duplicated build work. A mutant ledger could inflate `p3_upper_min` up to the total `billed_min` for runs that executed zero build jobs (`build_jobs === 0`), and the validator would accept it, leading to vastly overstated P3 savings.
   - **Concrete suggested fix**: Update the assertion in `aggregate.mjs` to restrict `p3_upper_min` using the 1.22-minute build multiple:
     ```javascript
     req(r.p3_upper_min <= Math.max(0, r.build_jobs - 1) * 1.22 + 1e-9, 
         `run ${r.run_id}: p3_upper_min ${r.p3_upper_min} exceeds (build_jobs-1)*1.22`);
     ```

## Verdict
CHANGES REQUESTED
