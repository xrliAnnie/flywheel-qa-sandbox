# FLY-2007 Capacity Stress Execution — Design Review R12 (exact-head freeze confirmation)

VERDICT: CHANGES REQUESTED

## Exact-head snapshot and review boundary

- This review is bound to branch `flywheel-FLY-2007`, commit **`e8d0d28a9983c7010c00aa6b7a058f129f1700b3`** (`e8d0d28a9`). I resolved HEAD myself at the beginning and again immediately before writing this report; it did not move. The repository worktree was clean both times.
- The R12 commit changes only the archived R11 report plus the analyser, simulator, and focused test. The four requested design docs and the wrapper are byte-unchanged from R11.
- I rechecked only the R11 applicability closure and the permitted blocking class: an authoritative A/N without required pre-registration evidence, or an attempt failure disappearing from the record. I did not reopen the Lead rulings, the honestly labelled weak `n=3` parameter-coverage gate, B's documentation-only status, `delta=2.5pp`, the B exposure definition, or `J=30`.
- No repository file was modified, staged, committed, or pushed. Diagnostic mutations and outputs were confined to `/tmp`.

## 1. R11 blocking finding: CLOSED

The precise R11 counterexample is closed at this exact head.

- `analyze.mjs:1021-1033` now computes, for every discovered window × endpoint, the block-rate mean, sample variance, and lag-1 autocorrelation. `varRate` is produced by the real CLI path, not only by a direct unit test.
- `simulate.mjs:356-360,400-414` refuses any non-finite mean or variance with the named reason `block-rate mean or variance is not computable`; it checks mean and variance against the frozen grid; it checks autocorrelation when finite; and when autocorrelation is undefined it requires `degenerate_windows > 0` in the frozen grid.
- A fresh direct probe at the stated 1,920-window grid size (`m=120`) produced **123 degenerate windows out of 1,920**. The same constant all-violation window passed with the real grid, while forcing `degenerate_windows=0` made the gate fail with the explicit out-of-domain reason. Separate non-finite-mean and non-finite-variance probes both failed with the named uncomputable-statistic reason.
- The fresh full CLI suite proved both sides end to end: the frozen-M all-violation fixture still reached authoritative A, while the forced no-degenerate-grid case was refused. Thus the fix does not make the clearest failing baseline unusable.
- `eligibility()` consumes the gate fail-closed (`analyze.mjs:664-671`), and `analyse()` assigns U before entering either authoritative A or N branch (`:757-789`). The old path in which all six ACF values serialized as `null`, all applicability checks skipped, and A was released with no usable applicability statistic no longer exists.

## 2. REMAINING BLOCKER

### HIGH — the freeze-blob checks validate a caller-selected copy, not the bytes actually executing; a drifted analyser can still release authoritative A under the frozen commit identity

This is inside the only allowed blocking class. The in-process statistical evidence can be generated and consumed by code whose bytes are not the pre-registered bytes, while the output claims the frozen commit and contains no freeze failure.

#### Exact-head code path

- The analyser accepts caller-supplied `--repo-root` (`analyze.mjs:982-984`).
- `freezeDriftProblems()` hashes `repoRoot/<frozen file>` (`:608-618`); it never proves that `repoRoot/scripts/qa-fly-2007-phase0-analyze.mjs` is the file represented by `import.meta.url`, nor that the sibling simulator it hashes is the module actually imported by the running analyser.
- The wrapper has the same class of gap on the collection side: `PROBE` is environment-selected (`run-window.sh:53`) and `W_REPO` is derived from the probe path rather than from the executing wrapper (`:220`); the four hashes at `:227-237` therefore attest that selected repo, not necessarily the wrapper bytes currently running.
- Both sides also accept a movable revision such as literal `HEAD`: the wrapper only asks whether `${FREEZE_COMMIT}^{commit}` resolves, and the analyser passes it to `rev-parse`. A fresh probe returned zero drift problems for both `HEAD` and the full hash. A ref that moves after START is not a frozen commit identity.

#### Executed counterexample

I copied the analyser/simulator from exact HEAD to `/tmp`, changed only the executing analyser's frozen `SLO` constant from `0.05` to `0.01`, and left a hermetic freeze repository holding the original exact-head analyser blob. I then ran the drifted analyser's real CLI against the suite's valid three-window, all-violation fixture at frozen M while pointing `--repo-root` at that clean freeze repository.

The actual result was:

```json
{"authoritative_outcome":"A","freeze_commit":"436f817d760ccc16b93b8d733b24895b456360b7","SLO":0.01,"freeze_reasons":[]}
```

The freeze repository's analyser blob was **`e72c34fc92cea5f3c2b51be016113891b7d0a152`**, exactly the analyser blob at reviewed commit `e8d0d28a9983c7010c00aa6b7a058f129f1700b3`; the analyser that actually emitted A was **`bbba67e4a1c5b4f24e3b1abdc36f412f345cdb25`**. The hashes differ, yet no freeze reason was recorded and authoritative A was released.

A second direct probe used the literal reviewed hash `e8d0d28a9983c7010c00aa6b7a058f129f1700b3` and the real clean repository as `--repo-root`; a drifted executing analyser again recorded that exact hash and no freeze reason while emitting the drifted SLO. The full-A hermetic fixture above proves that the same unbound check sits on an actual authoritative release path, not merely a helper-function path.

This defeats the pre-registration's purpose: after START, a changed analyser or simulator can use an unchanged checkout merely as an attestation surrogate. In-process simulation and canonical evidence discovery do not repair that, because the wrong in-process code is deciding what the evidence means.

#### Minimum closure

1. **Bind the analysis check to the executing bytes.** Derive the canonical repo from `realpath(fileURLToPath(import.meta.url))`, hash the actual analyser file and the actual sibling simulator module, and either remove `--repo-root` or reject any supplied root that is not that same canonical repo. Hash the spec and wrapper from that bound repo.
2. **Bind the collection check to the executing wrapper.** Derive the repo from canonical `BASH_SOURCE[0]`, not `PROBE`; require the collector to be the expected file in that same repo (or separately attest its explicitly frozen path).
3. **Canonicalize the freeze identity.** Resolve once to a full 40-hex commit hash before START, store that resolved hash in state/receipt/output, and refuse movable names such as `HEAD` or branch refs.
4. Add executable negative tests: a drifted analyser pointed at a clean frozen clone must refuse with a named executable-byte mismatch; a drifted wrapper with `PROBE` pointed at a clean clone must refuse before reserving an attempt; a movable `HEAD` must be refused or persisted only as its resolved immutable full hash.

## 3. Failure-retention recheck

No additional path was found by which an attempt failure disappears from the record.

- Completed bundles are discovered only from canonical `attempt-*/state.json`; the caller cannot select a bundle/ledger/sensitivity artifact into authority.
- The analyser rebuilds its ledger view from those same state files, performs the two-way completed-attempt census, requires all four terminal artifact hashes, and rejects missing or malformed bundles.
- Service/host failures always add an eligibility reason and cannot be replaced. Replaceable failures remain recorded and require one explicit same-window `replacement_of` edge; omission is named `silent re-run` and forces U.
- The wrapper converges ownerless non-terminal attempts to durable `aborted/crash_before_terminal` records rather than deleting them. The fresh suite again exercised the orphan, service/host, non-replaceability, and silent-rerun paths.

The blocker above is therefore a false-authority release path, not a reopened failure-retention path.

## 4. Fresh verification ledger

- `bash scripts/__tests__/qa-fly-2007-phase0-analyze.test.sh` → **82 passed, 0 failed**, exit 0.
- `node --check` on analyser and simulator; `bash -n` on wrapper and focused test → all exit 0.
- CI wiring verified at `.github/workflows/ci.yml:863-864`; exact ordered step inventory verified at `scripts/__tests__/ci-structure.test.sh:398`.
- Direct grid probes:
  - `m=40`: 46 / 640 degenerate windows;
  - `m=120`: **123 / 1,920** degenerate windows;
  - `m=400`: 357 / 6,400 degenerate windows.
- Forced `degenerate_windows=0` refused the constant window with the named reason; real grid accepted it; non-finite mean and variance each refused with the named uncomputable reason.
- Executable-binding counterexample produced authoritative A from a non-frozen analyser blob while recording no freeze failure, as detailed above.
- Final `git rev-parse HEAD` → `e8d0d28a9983c7010c00aa6b7a058f129f1700b3`; final branch → `flywheel-FLY-2007`; final `git status --short` → empty.

## 5. Freeze judgment

**R11 is CLOSED, but commit `e8d0d28a9983c7010c00aa6b7a058f129f1700b3` is NOT approved for freeze and Window 1 must not start yet.**

The refusal is based only on one executed authoritative-A path in the permitted blocking class: the current freeze check can attest a clean surrogate checkout while different analyser bytes actually decide and release A. No advisory, naming convention, disclosed weak gate, or previously settled Lead ruling is being used to withhold approval.

VERDICT: CHANGES REQUESTED
