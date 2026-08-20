# Design Review — FLY-1905 plan.md (Round 2)
Date: 2026-08-19
Author: Claude (independent cross-family reviewer)
Status: APPROVED

## Summary

I re-read plan.md v2 in full and re-verified every Round 1 item against the actual file text (not the coordinator's summary) and against the real dependents I mapped in Round 1. All 10 findings are genuinely folded in, with the correct substance — not cosmetic acknowledgments:

- **R1-1/2/3 (missing pins)**: new §3.5 table names all three files with exact line refs and correct failure modes (fly-889 "硬红", worktree-contract "硬红", wiring "静默空过绿"), each with a concrete flipped-invariant rewrite. §1 and §6 now honestly scope the packages-side change to exactly one CI-guard test file. §1 goal 4 correctly counts 4 pin sites.
- **R1-4 (test validity)**: §4 now mandates sealed PATH (`export PATH="$STUB"`, citing the flywheel-setup-services.test.sh:207 precedent) with the correct reasoning (CI shard installs real rg/tmux/lsof/sqlite3 into /usr/bin before the suite runs; macOS ships sqlite3/lsof in /usr/bin); §2 contract gains `--mirror-file PATH` as an argv seam (default `/etc/apt/apt-mirrors.txt`), the mermaid F-node now keys off `--mirror-file`, and T5/T8 use sandbox fixture paths.
- **R1-5**: `timeout` PATH-resolved never hardcoded (§2:52); suite preflights `timeout || gtimeout` fail-closed with explicit environment diagnosis and links the real binary into the sealed PATH; T3 explicitly forbids stubbing timeout.
- **R1-6**: mermaid line 40 spells both `-o Acquire::http::Timeout=15` and `-o Acquire::https::Timeout=15`; §2:53 documents the silent-unknown-key trap; T2 requires both literal keys AND `--kill-after=10 2` option-before-duration ordering, observable through the recording fake sudo.
- **R1-7**: registration form pinned — new named step `Test — FLY-1905 CI apt-install helper` in script-tests-2 + `expected_shard_tests["script-tests-2"]` append (§3.3/§3.4) + step-seconds accounting; §3.4-1 uses the literal token `bash scripts/ci-apt-install.sh`, which I verified does NOT substring-match the test-suite run line `bash scripts/__tests__/ci-apt-install.test.sh`.
- **R1-8**: §2:54 states the guarded-control-flow contract (probe miss + fast-install failure expected; only fallback failure and final probe fatal).
- **R1-9**: §5-① and §3.4-3 now share the parse-based run-text-zero criterion; comments exempted.
- **R1-10**: §5 真机自证 requires `phase=fast-install` success + zero `phase=fallback-*` lines in the PR's own script shards, with explicit refute-and-re-decide semantics ("比现状还差,不许静默接受"); §7 adds the lists-empty risk row and the tripwire-budget note; §8 honestly flags the baked-index assumption as unproven until the PR run.

No new issues were introduced by the edits. One low-severity residual below — implementable without another review round.

## What's Good (Keep)

- §3.5's table format (file / current failure mode / fix) makes the lockstep-change contract explicit and reviewable; the "guard 翻转漏改导致 CI 自锁" risk row now covers all four pin sites.
- §5's loud-failure clause for the baked-index assumption is the right shape: it converts a plausible-but-unproven research claim into a hard PR-CI acceptance instead of a silent behavioral downgrade.
- The token-matching discipline in §3.4-1 (full literal `bash scripts/ci-apt-install.sh`) preempts the double-count trap I flagged.
- §9's honest note that the Codex design review is still owed (quota exhaustion) rather than quietly skipping it.

## Issues & Recommendations

1. **[LOW, non-blocking] §3.5 row 3 (wiring.test.mjs) leaves the anchor choice ambiguous, and one of the permitted choices silently weakens the guard.**
   The fix says "锚点改为新 step 名/helper 调用串". If the implementer anchors on the bare helper path `scripts/ci-apt-install.sh`, `indexOf` will first match the **unit-tests** invocation (`bash scripts/ci-apt-install.sh tmux lsof`, ~ci.yml:147) — which precedes `sqlite3 --version` (ci.yml:247) so the assertion passes, but that step does not provision sqlite3, so the FLY-1327 "sqlite3 provisioned before its preflight" intent is anchored to the wrong step. The original anchor never had this collision (the unit step was named "Install lsof/tmux…"). Note this survives the new `assert.ok(idx >= 0)` — it is a semantic weakening, not a red.
   **Fix (one line in §3.5)**: pin the anchor to a string unique to the script-shard provisioning — either the 4-package invocation `bash scripts/ci-apt-install.sh tmux lsof sqlite3 ripgrep` or the new script-shard step name `Ensure tmux/lsof/sqlite3/ripgrep (FLY-1905 hardened)`.
   (Adjacent remark, no plan change needed: `expected_shard_tests` is order-sensitive (ci-structure.test.sh:407-411), so the "追加" position must match the actual step placement in script-tests-2 — any mismatch fails loud in the §6 local run, so it self-catches.)

## Verdict

APPROVED — ready to implement

(Scope note: this approval is the independent cross-family review only; per §9 the Codex design review required by the FLY-137 manifest is still pending quota recovery and is not substituted by this verdict.)
