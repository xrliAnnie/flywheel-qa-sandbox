# Design Review — FLY-1905 plan.md v3 (Codex Round 1)

Date: 2026-08-19
Author: Codex
Status: CHANGES REQUESTED

## Summary

The architecture and scope are sound: remove seven routine `apt-get update` executions, verify preinstalled tools before skipping installation, isolate the remaining network path in one helper, and flip the repository guards in the same PR.

I verified the three workflow sites at `.github/workflows/ci.yml:146-147`, `:209-210`, and `:401-402`, plus all four guard/pin sites described by §3.4/§3.5. No additional runtime code under `.github/` or `scripts/` depends on CI having run `apt-get update`; other apt references are fleet provisioning paths or hermetic test stubs.

The sealed-PATH approach is feasible on Ubuntu CI and macOS. The apt option spellings and `sudo timeout --kill-after=10 "$N" apt-get ...` ordering are correct.

Two blockers remain. First, the installed-but-broken recovery path does not faithfully model apt behavior. Second, T3 can itself hang until the 20-minute job limit if the timeout behavior being tested regresses.

## What's Good (Keep)

- Keep the shared helper and the three workflow replacements. This is substantially simpler than rewriting every `rg` consumer or maintaining a custom runner image.
- Keep verify-then-skip, including command execution and minimum-version checks.
- Keep the fail-closed package allowlist and final verification.
- Keep fast install without update, followed by one bounded mirror/update fallback.
- Keep the literal HTTP and HTTPS timeout options and the external GNU timeout.
- Keep sealed PATH and the `--mirror-file` seam.
- Keep all listed lockstep guard edits. The current pins exist at:
  - `scripts/__tests__/ci-structure.test.sh:318-410,653-669`
  - `packages/teamlead/src/__tests__/fly-889-ci-workflow-timeout-guard.test.ts:73-95`
  - `scripts/__tests__/test-worktree-removal-contract.test.sh:63-71`
  - `scripts/cycle-time/__tests__/wiring.test.mjs:17-20`

## Issues & Recommendations

1. **[BLOCKER] Installed-but-broken recovery is not faithful to apt behavior, and failed fast-path verification cannot reach fallback.**

   Plan lines 53-60 route a successful fast install directly to terminal verification. Plain `apt-get install <pkg>` may return success without reinstalling a package apt already considers current; `--reinstall` exists for that case ([Ubuntu apt-get manpage](https://manpages.ubuntu.com/manpages/jammy/man8/apt-get.8.html)).

   A corrupt or deleted binary can therefore produce:

   `probe fails → apt succeeds without changing anything → verification fails → no fallback`

   A low version has a similar hole when the baked index has no newer candidate but an update would reveal one.

   Recommended changes:

   - Retain the set of packages that failed probing and install only that set.
   - Use reinstall semantics for the failing set. Do not reinstall every requested package, or the normal “only rg missing” path will redownload tmux/lsof/sqlite3.
   - Verify immediately after fast install.
   - Treat either apt failure or failed post-fast verification as a reason to run mirror swap → update → reinstall.
   - Make only post-fallback verification terminal.
   - Make T9’s apt stub leave an already-installed broken binary unchanged unless reinstall semantics are present.
   - Add a stale-index case where fast install returns 0 without upgrading, while fallback update exposes the required version.
   - Assert healthy packages are absent from install argv.

2. **[BLOCKER — test validity] T3 can reproduce the original 20-minute hang.**

   T3 invokes a TERM-ignoring infinite stub and checks elapsed time only after the helper returns. Its only bound is the helper behavior under test. If timeout is omitted or malformed, the assertion is never reached and `script-tests-2` consumes its full job timeout.

   Wrap the T3 helper invocation in an independent harness watchdog using the pre-resolved GNU timeout. Give it a ceiling slightly above the helper’s legitimate worst case and distinguish:

   - helper returned a structured nonzero failure — expected;
   - outer watchdog killed the helper — test failure.

   Also assert the apt call log proves the stall path was entered. A small step-level timeout on the new test step is useful defense in depth.

3. **[MEDIUM] `--timeout-secs` is an unvalidated safety boundary.**

   Arbitrary `N` is accepted. GNU `timeout` treats zero as disabling the timeout, while large values invalidate the stated ~6.5-minute maximum.

   Require a positive decimal and either cap it at 120 or explicitly validate it against the step budget. Reject zero, negatives, nonnumeric values, missing option values, unknown options, and an empty package list before any sudo/apt call. Add negative tests asserting zero apt invocations.

4. **[MEDIUM] The minimum-version table is not design-complete.**

   Plan line 44 leaves the rationale to implementation. The current values are bands below today’s image versions, not compatibility floors tied to repository behavior.

   Before implementation, tie each floor to:

   - the oldest version supporting the exact commands/options used by the relevant suites; or
   - an explicit supported-runner policy.

   Add a fail-closed test for a probe that exits 0 but emits an unparseable version. Include realistic formats such as `tmux 3.5a` and lsof’s stderr `revision:` line.

5. **[LOW] Make macOS Bash 3.2 compatibility and sealed-PATH dependencies explicit.**

   A knowledge-table implementation may naturally use associative arrays, which fail under macOS `/bin/bash` 3.2. Require Bash-3.2-compatible constructs and run the suite plus `bash -n` with the intended shell.

   The sealed PATH must expose every external command used by the helper and harness—not only timeout and package stubs. Invoke the helper through the existing `$BASH` or provide a Bash link, and expose the utility used for safe mirror-file writing, such as `tee`.

## Verdict

CHANGES REQUESTED — address items above
