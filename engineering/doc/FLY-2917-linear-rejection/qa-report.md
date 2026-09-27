# FLY-2917 Linear rejection — QA 验证报告
Issue: FLY-2917 (https://linear.app/geoforge3d/issue/FLY-2917/病根bridge-崩溃-linear-sdk-的fetch-failed未被接住-unhandledrejection-把整个-bridge)
日期: 2026-09-25
基于: verification.md

## Verdict

**QA FAIL** on reviewed PR head `8934255394d99973131d2b3d340771179ed9e256`
(PR #1350). The original Linear `Fetch failed` fallback path is covered and
passes locally, but the reviewed head has red exact-head full CI and does not
satisfy the issue's second-incident acceptance requirements.

## Blocking findings

### 1. Exact-head full CI is red

`ci-full ensure --pr 1350 --head 8934255394d99973131d2b3d340771179ed9e256 --json`
returns exit 1 / `full_failed` for run
https://github.com/xrliAnnie/flywheel/actions/runs/36222514878.

The deterministic PR-caused failure is:

- `src/bridge/__tests__/fly1560-teardown-guard.test.ts` rejects the new literal
  `child boot watchdog expired` in
  `linear-transport-rejection-guard.test.ts:36`.
- Independent local reproduction: 1 failed, 6 passed. The same offender and
  line are reported.

The run also contains `required-wall-clock-thresholds.test.ts` failing with
`spawnSync git ENOBUFS`, plus an unrelated 5-second timeout in
`bridge.test.ts`. Regardless of flake classification for those two, the
deterministic residue failure and failed aggregate `CI OK` prohibit PASS.

### 2. The second incident's source-level repair is absent

The updated acceptance requires the timeout abort in
`packages/teamlead/src/bridge/strength-two-probes.ts:436` to be owned at its
source and converted to a probe-failure outcome. That file is byte-identical to
`origin/main` in this PR; no changed test constructs the reported record-probe
abort/unhandled-rejection process case.

The existing `strength-two-probes.test.ts` suite passes 32/32, but its timeout
coverage is for the site/body path and does not prove that the reported
record-probe abort cannot escape or terminate the Bridge. This acceptance item
therefore has no implementation or regression evidence.

### 3. The process-level behavior contradicts the updated acceptance

The updated acceptance says any unhandled Promise rejection must be logged
with a stack and must not exit the Bridge. The new guard is intentionally
Linear-only and rethrows every other rejection. Its own tests prove the
contradiction: `ordinary fetch Error` and all non-Linear/unknown rejection
cases exit 1, and explicit Node strict mode remains fatal.

Relevant local command result: the guard plus existing strength-two suite pass
57/57, including the assertions that ordinary/non-Linear unhandled rejections
terminate. Passing this suite confirms the implemented behavior, not the
updated product requirement.

## Passing evidence

- Original reported path: `createFetchIssue`, `DirectEventSink`, and
  `ChatThreadCreator` pass 147/147. This includes a rejected Linear issue fetch
  falling back to StateStore and completing the real thread-creation path.
- The PR contains a Linear SDK call-point inventory in `verification.md` and
  the PR body.
- `git diff --check origin/main...893425539...` additionally reports four
  trailing-whitespace lines in `progress.md`; this is secondary to the blocking
  findings above.

Local runtime: Node `v25.6.1`, pnpm `10.13.1`. Exact-head full CI supplies the
required Node 22 evidence and is red.

## Real-machine / Discord boundary

The change is Discord-capable because the original acceptance covers Bridge
survival through chat-thread creation. A 529 real-Discord N-to-N run was not
started: QA failed earlier at the mandatory exact-head full-CI gate and at two
explicit acceptance requirements. No ship report was published because FAIL
does not open the founder ship gate.

## Required repair before re-verification

1. Restore exact-head full CI, including the deterministic FLY-1560 residue
   failure introduced by the new test.
2. Add the source-level `strength-two-probes.ts` abort ownership fix and a
   process-level regression that constructs the reported timeout.
3. Align the global unhandled-rejection policy with the updated acceptance, or
   obtain an explicit spec change; the current narrow guard is observably not
   equivalent.
4. Dispatch QA on a new reviewed head. QA must re-fetch it, obtain green
   exact-head full CI, rerun both crash scenarios, and then complete the
   mandatory isolated 529 N-to-N before PASS.
