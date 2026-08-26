# FLY-2007 Phase-0 Design Review R13

**VERDICT: APPROVED**

## Review snapshot and boundary

- Branch: `flywheel-FLY-2007`
- HEAD: `b276919fd03df025848b4b1dae7970f0845f4a56`
- Worktree: clean before and after review
- Method: read the five requested files, R12, the exact HEAD delta, and direct call sites; then ran only the existing focused test suite. No adversarial input was constructed and no repository file was modified.

## 1. R12 freeze-root issue

**Closed on the verdict-producing path.**

- `selfRepoRoot()` resolves `import.meta.url` with `realpathSync()` and takes two parents, binding the root to the checkout containing the executing analyser (`qa-fly-2007-phase0-analyze.mjs:608-616`).
- `eligibility()` does not read a root from `opts`; it calls `freezeDriftProblems(opts.freezeCommit, selfRepoRoot())` (`:661-665`).
- The simulator is dynamically imported by the analyser through the relative sibling path `./qa-fly-2007-phase0-simulate.mjs` (`:1024-1029`), so the executing analyser and loaded simulator are under that same derived root. The wrapper and spec are hashed under that bound root as well (`:602-629`).
- `--repo-root` is no longer an input: the CLI prints an error and exits 1 before analysis (`:991-997`).

Therefore a caller cannot substitute a clean surrogate checkout for the files checked by an authoritative `analyse()` run. The exported helper retains an optional explicit `repoRoot` parameter for direct helper/test calls, but the only production verdict call site supplies `selfRepoRoot()` itself; that helper-only seam cannot alter `eligibility()` or an A/N outcome.

## 2. Eligibility, outcomes, and aborted service failures

No remaining route was found for either prohibited state.

- `eligibility()` derives `eligible` exactly as `reasons.length === 0` (`:661-717`).
- `analyse()` enters A/N/B evaluation only in the `else` branch of `if (!elig.eligible)`; an ineligible result is assigned U first (`:726-798`). Thus A or N cannot coexist with a non-empty eligibility `reasons` array.
- In `censusProblems()`, every terminal non-completed/non-dry-run row is classified. An `aborted` row whose reason is in `SERVICE_HOST_REASONS`, matches a service prefix, or is `signal` appends the explicit service/host problem and cannot be replaced (`:414-447`). A non-terminal or malformed row also adds a reason before classification. Consequently an aborted service failure cannot disappear from eligibility.

## 3. Existing test suite

Command:

```text
bash scripts/__tests__/qa-fly-2007-phase0-analyze.test.sh
```

Result: **84 passed, 0 failed; exit 0**.

The suite includes checks that `--repo-root` is refused, the root is derived from the analyser path, a surrogate checkout is not substituted, service/host failures force U and remain named, and the frozen-M valid path can still emit A.

## 4. Freeze judgment

Within the requested R13 boundary, no defect remains that must be fixed before freeze. Commit `b276919fd03df025848b4b1dae7970f0845f4a56` is sound to freeze as the pre-registered baseline.

VERDICT: APPROVED

---

## ⚠ Scope caveat on this approval (added by the implementer, not the reviewer)

**The first R13 attempt was killed by a content filter** on the reviewer's side
when it began constructing adversarial fixtures; it produced no report. This
report comes from a **re-run under a deliberately narrowed, read-only framing**:
the reviewer was asked to confirm the R12 fix by reading, to trace the verdict
paths in `eligibility()` and `analyse()`, and to run the existing suite — and was
explicitly asked *not* to build attack inputs.

⇒ The reviewer's own wording is "**within the requested R13 boundary**". That is
accurate and must not be quoted as an unrestricted approval.

**What that means concretely:**

| | |
|---|---|
| Confirmed this round | the R12 fix (self-derived freeze root), the verdict paths by reading, 84/84 |
| **NOT performed this round** | the adversarial sweep that R5–R12 each ran, and which found a real bypass every single time |

⚠ **Every previous round that built its own counterexamples found something.**
The honest reading of this approval is therefore: *no defect was found by reading*,
not *no defect exists*. It is recorded here so that nobody later reads round 13 as
carrying the same weight as rounds 5 through 12.
