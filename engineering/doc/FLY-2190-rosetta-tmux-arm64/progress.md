---
issue: FLY-2190
phase: implement
phaseCursor: 6/6
updated: 2026-08-31T18:34:32.023Z
nextStep: Commit the required milestone as the literal last commit, push, open
  PR, and run needs_review completion route
chunks: []
pointers: {}
---

# FLY-2190 progress
**phase**: implement (6/6)
**next**: Commit the required milestone as the literal last commit, push, open PR, and run needs_review completion route

## Completed S1/S2 evidence (2026-08-31)

- S1 changed all 12 production carrier declarations plus the 1 QA carrier to put `/opt/homebrew/bin` before `/usr/local/bin`; the prior 10-point RED baseline became GREEN. `qa-result.ts` now resolves `gh` native-first through a deterministic tested candidate list.
- S2 adds `check-global-path-hygiene.sh --source-tree <root>` with explicit registered declarations, full locked file/shebang enumeration, exact exceptions/priority lists, and fail-closed missing/unregistered handling. A real production-declaration reversal failed with its filename, then passed after restoration.
- Overlap sweep: 373 shared basenames, 372 different realpaths, 1,440 enumerated non-test source files. Actual command overlaps remain `python3`, `npx`, `gh`, `ffmpeg`, `ffplay`, `npm`, `openssl`, and `brew`; the four carrier-critical overlaps match the approved plan.
- Hermetic smokes selected native `python3`, `npx`/`node`, `gh`, `ffmpeg`, and `npm`; representative bridge/voice bootstraps, GitHub operations, audio validation/transcode, and shell artifact preparation passed.
- `pnpm lint` PASS; `pnpm -r build` PASS. Changed tests: claude-runner 50/50, teamlead 23/23, qa-result 92/92, path-hygiene 21/21, S1 host selection 2/2, tmux rescue 47/47, restart-storm 58/58, QA restart gate 66/66.
- `pnpm test:packages:run` reached only the two pre-existing real Terminal.app Apple Events failures in unchanged core files. Rerunning the remaining packages exposed one unrelated unchanged `TmuxAdapter` shared-state flake; its exact isolated test passed.
- Request-driven `codex:rescue` code review round 1 (`2bc8a94c-77f7-45be-93f7-7995604b6456`) APPROVED exact head `f8039490471923ae4bdc4b1b5e1d9c0084cb1e77`, with no blocking findings. Six MEDIUM/LOW advisories were reported to the Lead for follow-up.
- tmux deliberately remains `/usr/local/bin/tmux` 3.5a x86_64; `/opt/homebrew/bin/tmux` is absent. No `brew link`, launchd mutation, server restart, merge, deployment, or S3 action was performed.

## S3 P1–P7 read-only audit (2026-08-31)

All seven blockers remain unresolved, as required by the approved S1+S2-only scope. FLY-2190 must remain open (or have an explicit blocking successor) until S3 is separately designed, reviewed, founder-authorized, and executed.

| Blocker | Status | Missing exit condition |
| --- | --- | --- |
| P1 rolling transaction guarantee | unresolved | No tested whole-host/per-batch state machine with restart-safe re-entry. |
| P2 complete server ownership/disposition | unresolved | No authoritative current all-server census with owner/supervisor disposition; process census is unavailable in this sandbox. |
| P3 executable mixed-state rollback | unresolved | `~/.flywheel/backup/tmux-3.5a-closure` is absent; no ordered production rollback transaction. |
| P4 mixed-version production command gate | unresolved | No fail-closed 3.7c-client/3.5a-server production command-surface gate. |
| P5 runtime client convergence | unresolved | S1 is not merged/deployed/converged across long-lived clients; no native tmux is linked. |
| P6 complete consumer matrix | unresolved | No exact-3.7c or protocol-independence proof for every version-sensitive consumer family. |
| P7 launch provenance / CPU preference | unresolved | No pre-destructive per-supervisor child-slice proof; `~/.flywheel/state/host-terminal-cutover.json` is absent. |
