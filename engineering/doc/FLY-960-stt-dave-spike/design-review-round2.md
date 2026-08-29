# Design Review — plan.md (FLY-960 STT/DAVE spike) (Round 2)
Date: 2026-07-07
Author: Codex
Status: CHANGES REQUESTED

## Summary
Round 2 materially improves the plan: the spike boundary, evidence model, A-path stability protocol, B-path working directory, and fail-closed DAVE proof rule are now much stronger. I still cannot approve it as written because a few newly added commands are not executable on this macOS worktree, and the Gemini/native-Opus fallback steps can still fail before the real DAVE test begins.

## What's Good (Keep)
- The Round 1 evidence gaps are mostly closed: tokens are loaded without printing, `transcribe.mjs` now fails fast, B writes to the spike-root `out/`, and `ears-a.mjs` has a controlled `SIGUSR1` rejoin path (`plan.md:55-89`, `plan.md:146-173`, `plan.md:337-375`, `plan.md:242-248`).
- The stability criterion is now quantitative enough for QA to challenge: expected loop count, disturbance windows, recovery threshold, transcript sampling, and state-log reconciliation are explicit (`plan.md:308-316`).
- The DAVE proof rule is directionally correct and fail-closed: no complete protocol-version / epoch-event / screenshot chain means the report must say `DAVE proof unavailable`, not infer GO from audible audio (`plan.md:280-303`).
- The B path is no longer a pure placeholder; it uses `refs/pull/3159/head` and records a lock file when the network is available (`plan.md:332-347`).
- The workspace boundary remains sound: spike code is outside `packages/*`, so it will not be pulled into the pnpm workspace (`pnpm-workspace.yaml:1-2`).

## Issues & Recommendations
1. `timeout` is not available on this macOS machine, and one use can create false evidence.

   Why it matters: Round 2 added `timeout 20 ...` in the upstream refresh and B-path SHA lock commands (`plan.md:40-45`, `plan.md:332-344`), but `command -v timeout` returns missing here. For the refresh commands this will be recorded as a failure and continue, which is acceptable. The B lock command is worse: `timeout 20 git ls-remote ... | tee pycord-ref.lock` can leave an empty `pycord-ref.lock` while `tee` exits 0 if pipefail is not set, so the report may claim SHA evidence that was never captured.

   Suggested fix: replace `timeout` with a macOS-available wrapper, for example a small `bounded()` shell function using `/usr/bin/perl` alarm, or require `gtimeout` only after checking it exists. For the pip ref lock, use `set -o pipefail` and explicitly validate `pycord-ref.lock` contains a 40-hex SHA before treating it as evidence; if unavailable, write `pycord-ref.lock` with a clear `UNRESOLVED refs/pull/3159/head` marker.

2. The `flywheel-comm` full path is stale/worktree-unsafe.

   Why it matters: The plan says every `flywheel-comm` call means `node /Users/xiaorongli/Dev/flywheel/packages/flywheel-comm/dist/index.js ...` (`plan.md:47-49`). That file exists in the main checkout, but not in this `flywheel-FLY-960` worktree; `packages/flywheel-comm/dist/index.js` is missing here. Using the main checkout can silently run stale code from another branch, and using the current checkout path will fail unless the package is built.

   Suggested fix: define a repo-local `FWCOMM` in Task 0, for example: `pnpm --filter flywheel-comm build` then `FWCOMM="node $PWD/packages/flywheel-comm/dist/index.js"`, or a `pnpm --filter flywheel-comm exec ...` form that is verified in this worktree. Record the resolved command in `evidence/00-env.md`, then use `$FWCOMM ask/check/progress` throughout.

3. The Gemini alias resolution step still does not actually resolve aliases.

   Why it matters: Step 0.3 checks shell and `~/.flywheel/.env`, but the alias command only prints matching variable names and does not export any value to `GEMINI_API_KEY` (`plan.md:82-86`). It also checks `FLYWHEEL_VOICE_GEMINI_KEY`, while the repo config uses `FLYWHEEL_VOICE_GEMINI_KEY_ENV` as the name of the env var to read (`packages/voice-core/src/config.ts:102-105`), and prior evidence named `NANOBANANA_GEMINI_API_KEY` as the actual borrowed key (`packages/voice-core/evidence/poc-converse.md:12-13`). This can still block Step 2.3 even when a usable key exists.

   Suggested fix: replace that line with explicit resolution logic: include `GEMINI_API_KEY`, `GOOGLE_API_KEY`, `NANOBANANA_GEMINI_API_KEY`, and if `FLYWHEEL_VOICE_GEMINI_KEY_ENV` is set, dereference the env var it names. After alias resolution, run `test -n "$GEMINI_API_KEY" && node transcribe.mjs ref/ref-48k.wav` as the proof, and record only the source label, never the value.

4. `opusscript` is added, but `@discordjs/opus` is still a hard install dependency.

   Why it matters: Step 0.3 says if Node cannot be switched to 22, rely on the pure-JS `opusscript` fallback (`plan.md:75-80`), and Step 1.1 adds both `@discordjs/opus` and `opusscript` to `dependencies` (`plan.md:111-116`). If `@discordjs/opus` has no prebuild and native build fails on the active Node, `npm install` can fail before the fallback smoke check runs (`plan.md:120-123`). Then the spike never reaches A.

   Suggested fix: either make Node 22 mandatory before `npm install`, or make native Opus optional by installing it separately after the base package install: install `discord.js`, `@discordjs/voice`, `prism-media`, `opusscript` first, then `npm install @discordjs/opus || echo "native opus unavailable; using opusscript"`. The evidence should record which decoder path was actually active.

## Verdict
CHANGES REQUESTED — close the remaining command portability and env-resolution gaps, then this is ready for implement.
