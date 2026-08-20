# Design Review — FLY-1905 plan.md (Round 1)
Date: 2026-08-19
Author: Claude (independent cross-family reviewer)
Status: CHANGES REQUESTED

## Summary

The core design is sound and I verified its factual base against the real tree: the three apt sites exist exactly where claimed (`.github/workflows/ci.yml:146-147`, `209-210`, `401-402`), no other workflow uses apt, the `sudo timeout N apt-get` ordering rationale is correct, the argv-not-env choice cleanly sidesteps FLY-1455 flag governance, and the guard flip direction (require helper, forbid bare apt-get) is the right shape. The enumeration claim in §3.5 checks out against `ci-shell-suite-enumeration.test.sh`.

However, the plan's change list is **incomplete**: I found three additional files that pin the current apt step text/name and are not in §3. Two of them hard-fail CI under the planned ci.yml (`packages/teamlead/src/__tests__/fly-889-ci-workflow-timeout-guard.test.ts` — which directly contradicts the plan's "零 packages 改动" claim — and `scripts/__tests__/test-worktree-removal-contract.test.sh`), and one goes silently vacuous (`scripts/cycle-time/__tests__/wiring.test.mjs`). Separately, the hermetic test strategy as written (§4 "PATH 前置 stub 目录") cannot actually produce the "missing rg" scenarios on CI — where the very shard running the suite installs real rg/tmux/lsof/sqlite3 first — and the mirror-swap path has no injectable file seam, so T5/T8 as specified are untestable without root. These must be fixed in the plan before implementation.

## What's Good (Keep)

- **Verified factual base.** ci.yml apt sites at 146-147 / 209-210 / 401-402 as claimed; `grep -rn apt-get .github/workflows/` confirms only ci.yml; research.md's log evidence (mirrorlist `file:/etc/apt/apt-mirrors.txt` at Get:1) confirms the mirror-swap target file exists on the runner.
- **Net-deletion shape.** 7 update+install → 0 updates + probe-first single-package install matches the incident evidence (all hangs in the `apt-get update` fetch phase) and the simplicity doctrine.
- **`sudo timeout N apt-get` ordering** (timeout as root, so it can signal root's apt) is correct, and `--kill-after` for TERM-ignoring stalls is the right belt.
- **Argv-only injection (`--timeout-secs`)** deliberately avoids creating a new FLY-1455 flag-governance surface — good, keep this principle for the additional seam item 4 requires.
- **Guard flip direction** (helper-required + bare-apt-forbidden + step-level `timeout-minutes`) is the correct anti-regression polarity, and the fail-closed terminal probe preserves FLY-1759's "missing lsof/tmux is a hard failure" semantics (ci.yml:141-145 comment).
- **Honest boundary §8** (trigger not curable; amplifier is ours) is well supported by research §3-§5; the DPkg::Lock::Timeout item is correctly labeled defensive, not curative.
- **Enumeration claim verified**: `ci-shell-suite-enumeration.test.sh:15-21` picks up any `scripts/__tests__/*.test.sh` and requires it in ci.yml's literal enumeration — adding the suite to a ci.yml step satisfies it (and it must NOT also be listed in `ci-shell-suite-manual-only.txt`, or the overlap check at line 38/55 fails; the plan's default of not touching that file is correct).

## Issues & Recommendations

1. **[BLOCKER] Missing dependent: `packages/teamlead/src/__tests__/fly-889-ci-workflow-timeout-guard.test.ts` hard-fails under the new ci.yml — and the plan explicitly claims zero packages changes.**
   Lines 73-95 assert, for each of `script-tests`/`script-tests-2`: `expect(updateSteps).toHaveLength(1)` where `updateSteps` matches `/apt-get\s+update/` in step run text, plus `\btmux\b|\blsof\b|\bsqlite3\b` in that step. After the plan removes all `apt-get update` run text, `updateSteps` is length 0 → red. This test runs in the teamlead unit shards (Vitest), so the PR's own CI fails. Plan §3.5 says "无 packages/ 代码改动" and §6 says "零 packages 改动,预期不受影响" — both are false as written.
   **Fix**: add this file to §3's change list; rewrite the "merged apt-get" test into the flipped invariant (exactly one `bash scripts/ci-apt-install.sh` step per script shard, zero `apt-get update` run text), mirroring the ci-structure flip. Correct the §3.5/§6 scope claims.

2. **[BLOCKER] Missing dependent: `scripts/__tests__/test-worktree-removal-contract.test.sh:63-71` requires the literal `apt-get install -y lsof` in the unit-tests section of ci.yml.**
   `unit_section=$(sed -n '/^  unit-tests:/,/^  script-tests:/p' "$ci")` then `grep -q 'apt-get install -y lsof' <<< "$unit_section"` → FAIL branch "CI is missing lsof or an explicit FLY-1759 shell-suite invocation". This suite runs in CI (script-tests step "Test — FLY-1759 reap-first worktree teardown", ci.yml:228-231), so it reds the same PR. The FLY-1759 intent (lsof provisioning stays visible in the unit job) must be preserved against the new form.
   **Fix**: add to §3; change the anchor to the new invocation (e.g. grep the unit section for `scripts/ci-apt-install.sh` + `\blsof\b`).

3. **[MEDIUM] Silent vacuous-green: `scripts/cycle-time/__tests__/wiring.test.mjs:19` loses its teeth after the step rename.**
   `assert.ok(preflight > ci.indexOf("Install tmux/lsof/sqlite3"))` — the plan renames the step to "Ensure tmux/lsof/sqlite3/ripgrep (FLY-1905 hardened)", so `indexOf` returns −1 and the assertion passes vacuously forever (any positive `preflight` index > −1). The FLY-1327 ordering guard (sqlite3 provisioned before its `sqlite3 --version` preflight at ci.yml:247) is silently disabled — exactly the 空过绿 class this repo's conventions forbid.
   **Fix**: add to §3; anchor on the new step name (or on the helper invocation string) and assert `indexOf(...) >= 0` explicitly so a future rename fails loud instead of going vacuous.

4. **[BLOCKER — test validity] The §4 hermetic strategy cannot produce the "missing binary" scenarios, and the mirror swap has no testable seam.**
   (a) *PATH-prepend cannot simulate absence.* T2/T3/T4/T5/T7/T8 all require "缺 rg". The plan says "PATH 前置 stub 目录", but the probe is `command -v` over PATH — on CI the suite runs inside a script shard that has already installed real `rg`/`tmux`/`lsof`/`sqlite3` into `/usr/bin`, and on dev Macs `sqlite3`/`lsof` ship in `/usr/bin`. With prepend, the probe finds the real binaries, the helper exits 0 at the probe stage, and every "missing" case silently stops testing what it claims to. The suite must use a **sealed PATH** built from a curated stub dir (symlinks to the specific real tools the helper needs — `timeout` etc. — plus per-case fake/absent package binaries); precedent: `scripts/__tests__/flywheel-setup-services.test.sh:207` (`export PATH="$STUB7"  # sealed`).
   (b) *Mirror file path is hardcoded.* The helper's fallback checks/overwrites `/etc/apt/apt-mirrors.txt`. T5 asserts "fixture apt-mirrors.txt 被覆写" — impossible hermetically: the fake `sudo` exec's the remaining argv, so a `sudo tee /etc/apt/apt-mirrors.txt` would write (or fail on) the **real** `/etc` of the dev/CI machine. The helper contract (§2 usage line) needs an injectable seam, e.g. `--mirror-file <path>` defaulting to `/etc/apt/apt-mirrors.txt` — argv, consistent with the plan's own no-env principle. T8 then points it at a nonexistent path.
   **Fix**: amend §2 contract (add `--mirror-file`) and §4 (sealed PATH, not prepend; state which real tools get curated symlinks).

5. **[MEDIUM] `timeout(1)` availability is assumed but unversioned — the suite must run on macOS dev machines too.**
   macOS does not ship `timeout`; it happens to exist on this machine only via coreutils (`/usr/local/bin/timeout`). The helper (CI-only, ubuntu-24.04) is fine, but the hermetic suite executes the helper, whose stall cases (T3) *require a real working `timeout`* to prove non-hang — it cannot be stubbed as passthrough without hanging the test. And with the sealed PATH from item 4, `timeout` must be explicitly resolved and linked in.
   **Fix**: (a) helper must invoke `timeout` via PATH, never a hardcoded `/usr/bin/timeout`; (b) the suite preflights `command -v timeout` (accepting `gtimeout` or failing closed with an explicit environment diagnosis) — repo precedent for tool preflights: ci.yml:247 (`sqlite3 --version`) and ci.yml:687-688 (`command -v python3` / `command -v rg`).

6. **[MEDIUM] `Acquire::http(s)::Timeout=15` is not literal apt syntax, and apt makes the mistake silent.**
   The §2 mermaid shows `-o Acquire::http(s)::Timeout=15`. apt accepts arbitrary unknown `-o` keys without error, so a literal transcription sets a junk config key `Acquire::http(s)::Timeout` and the real timeouts silently never apply — the exact failure mode this issue is about would survive with green tests, because T2's argv assertion only checks `DPkg::Lock::Timeout=60`, `Acquire::Retries`, `--no-install-recommends`.
   **Fix**: spell both options in the plan (`-o Acquire::http::Timeout=15 -o Acquire::https::Timeout=15`) and extend T2's argv assertion to require **both** literal keys. Same treatment for `--kill-after` placement: it is an option and must precede the duration (`timeout --kill-after=10 "$N" apt-get …`) — state it once so the implementer doesn't put it after the command.

7. **[MEDIUM] §3.4 guard-flip list is incomplete: registering the new suite as a named step requires updating `expected_shard_tests`.**
   `ci-structure.test.sh:401-411` asserts each shard's post-setup step names equal `expected_shard_tests[job_id]` exactly, in order (`script-tests-2` inventory at lines 347-386). §3.3 says to add `ci-apt-install.test.sh` "到 script-tests 某 shard 的枚举步骤" but §3.4 only lists expected_setup rename + the apt-block swap — following §3.4 literally leaves the guard red. Decide and state the form: either (a) a new named step + add its name to `expected_shard_tests` (preferred — keeps step-seconds accounting per FLY-1870 comments), or (b) append the bash line to an existing step's run block. Also: implement the new assertion #1 against the literal token `bash scripts/ci-apt-install.sh` (not a loose `ci-apt-install` substring) so the test-suite path `scripts/__tests__/ci-apt-install.test.sh` in the same job can't double-count.

8. **[LOW] Make the expected-failure control flow explicit in the helper contract.**
   §3.1 mandates `set -euo pipefail`, and §2's flowchart shows fast-install failure → fallback and probe-miss → install — but under `set -e` both `command -v <missing>` and a failing `sudo timeout … apt-get` abort the script unless guarded (`if ! …` / explicit rc capture). Since the whole point is "fast path is ALLOWED to fail", write one contract line: "probe misses and fast-install failure are expected control flow and must be invoked in guarded form; only fallback failure and the final probe are fatal." Cheap to state; expensive to debug if an implementer discovers it via T5 hanging red.

9. **[LOW] Internal inconsistency: §5-① "ci.yml `grep -c apt-get` = 0" (whole file) vs §3.4-3 (run-text only).**
   The current ci.yml has `apt-get` in YAML comments (ci.yml:207-208) which are not run text; §3.3 rewrites those comments, but nothing stops a future comment from legitimately mentioning apt-get. Align the acceptance check with the guard's parse-based run-text assertion (which is the durable one), or explicitly commit to keeping the whole file free of the literal — pick one and say so.

10. **[LOW] Acceptance should require positive evidence that the fast path (no update) actually works on the real image, not just a green shard.**
    The "baked index is usable for `apt-get install ripgrep` without update" claim is plausible (research §6's no-superseding-version argument is sound) but unproven until the PR runs. If the image ships with empty/cleaned `/var/lib/apt/lists`, the fast path fails **every** run and the helper silently succeeds via mirror-swap + update each time — green CI, but now every run overwrites the mirrorlist and does a full update against archive.ubuntu.com, which is strictly worse than today's normal-path azure mirror. Strengthen §5's 真机自证 to: "the PR run's helper stderr must show `phase=fast-install` success and zero `phase=fallback-*` lines in the script shards". (Minor related note: an outage-window fallback that *succeeds* slowly adds ~2-3min to a ~10.4-10.9min shard — still comfortably under the FLY-1870 tripwire's 85%-of-20min budget per `ci-job-elapsed-tripwire.sh:63-80`, so no structural change needed there.)

## Verdict

CHANGES REQUESTED — address items above
