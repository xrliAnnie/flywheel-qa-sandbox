# Design Review — plan.md (FLY-960 STT/DAVE spike) (Round 1)
Date: 2026-07-07
Author: Codex
Status: CHANGES REQUESTED

## Summary
The plan has the right shape for a timeboxed spike: it keeps production code out of scope, uses real-machine evidence, and correctly treats DAVE receive as the go/no-go gate for Huddle. I am not approving it as written because several runbook details can block the implement runner or produce an under-supported false verdict, especially around credentials, DAVE proof capture, and the B-path fallback.

Live upstream refresh could not be verified from this environment (`gh api` cannot connect to `api.github.com`), so the implement-stage refresh step remains mandatory and should record success or failure as evidence.

## What's Good (Keep)
- Clear spike boundary: plan.md limits edits to `engineering/spike/FLY-960-dave-stt/**` and `engineering/doc/FLY-960-stt-dave-spike/**`, and explicitly excludes `packages/voice-core` and production code (`plan.md:25-30`). This matches exploration's engineering boundary (`exploration.md:86-92`).
- A→B→C ordering is justified by the current research doc: A has a published 0.19.2 fix while B is only an unreleased branch (`research.md:12-29`, `research.md:160-174`).
- The core GO criteria are aligned with exploration: audible decrypted audio, STT recognizability, 10-minute/rejoin stability, per-speaker separation, and DAVE-present evidence (`exploration.md:48-60`, `plan.md:34-37`).
- The repo boundary checks mostly support the plan: `pnpm-workspace.yaml` includes only `packages/*`, so `engineering/spike/` will not be absorbed (`pnpm-workspace.yaml:1-2`).
- The C-path premise is grounded in existing code: `MicCapture` really uses ffmpeg avfoundation with a configurable `device` (`packages/voice-core/src/audio/MicCapture.ts:36-50`).
- The QA phase is appropriately independent: it requires a fresh rerun of the selected path rather than reusing implement artifacts (`plan.md:363-372`).

## Issues & Recommendations
1. Credential and environment bootstrap is not executable enough as written.

   Why it matters: `discord-bot-pool.sh claim` only marks local pool state (`scripts/lib/discord-bot-pool-lib.sh:400-415`), and `invite-url` only prints an OAuth URL (`scripts/lib/discord-bot-pool-lib.sh:361-373`). The plan's bot code expects `DISCORD_TOKEN` (`plan.md:162`, `plan.md:206`), but no step safely exports the claimed slot token from `~/.flywheel/discord-bot-pool/<slot>/token`. Separately, current shell has no `GEMINI_API_KEY`, and `~/.flywheel/.env` has no matching Gemini key name; existing voice-core evidence also recorded this exact gap (`packages/voice-core/evidence/poc-converse.md:12-13`). Without a concrete bootstrap, Task 1/2 can fail before testing DAVE.

   Suggested fix: add explicit commands to `verify` pool-04/05, export each token from its token file without printing it, and record only slot names/masked verification in `evidence/00-env.md`. Add a hard `GEMINI_API_KEY` resolution step: check shell, source `~/.flywheel/.env`, optionally map an approved alternate env var, and if still missing ask Tadashi before Task 1. Make `transcribe.mjs` fail fast with a clear message when the key or wav arg is absent.

2. Path B still contains a real placeholder and has working-directory bugs.

   Why it matters: Step 3.2 says `pip install "py-cord[voice] @ git+https://github.com/Pycord-Development/pycord@<#3159 的分支引用>"` (`plan.md:268-274`), which is not directly runnable despite the self-review claiming all code blocks can run (`plan.md:404-405`). It also `cd`s into `ears-b` without creating it (`plan.md:270`), and `ears_b.py` writes `out/b-...wav` relative to that directory (`plan.md:292-296`) even though the shared `out/` is created at the spike root. If A fails, B is exactly when the runner has least time to debug path/setup drift.

   Suggested fix: replace the placeholder with a concrete current PR head SHA or a bounded command that resolves and records it, for example `PYCORD_REF=$(gh api ... --jq .head.sha)` with a documented fallback if GitHub is unavailable. Add `mkdir -p engineering/spike/FLY-960-dave-stt/ears-b engineering/spike/FLY-960-dave-stt/out`, write B outputs to `../out/...` or an absolute spike-root path, and call `audio.file.seek(0)` before reading to avoid zero-byte sink artifacts.

3. DAVE-present evidence is required, but the capture method is not concrete enough.

   Why it matters: The plan correctly requires `dave_protocol_version > 0`, davey/E2EE session logs, and a client E2EE screenshot (`plan.md:34-37`, `plan.md:367-368`; research refines this at `research.md:168-169`). But Step 2.4 relies on grepping debug text and says to "console.log networking layer session description" if debug lacks DAVE lines (`plan.md:234-241`) without naming the exact object/event to instrument. That can burn the A timebox or, worse, allow a GO based on audible audio plus a UI screenshot without the server session-description proof.

   Suggested fix: make DAVE proof a first-class output of `ears-a.mjs`: write JSONL for raw voice session description, selected `dave_protocol_version`, and davey/MLS epoch or commit events. If the library does not expose this cleanly, the plan should specify the exact temporary monkey patch or debug hook to use and require the report to say "DAVE proof unavailable" rather than infer it.

4. The stability/rejoin test is underspecified relative to the GO claim.

   Why it matters: Step 2.6 requires a 10-minute run with human client join/leave and an ears-bot destroy/rejoin (`plan.md:246-249`), but the `ears-a.mjs` skeleton has no timer, signal handler, or command path to perform a controlled rejoin (`plan.md:171-202`). The sender also inserts 3-second playback gaps (`plan.md:220`) while the receiver ends streams after 1.5 seconds of silence (`plan.md:193-195`), so the stability evidence will be many short files unless the plan defines what "continuous" means.

   Suggested fix: add an explicit `--rejoin-after-sec` or `SIGUSR1` handler to `ears-a.mjs`, log connection close codes/state transitions, and define the stability artifact as a timeline: expected sender loops, capture files per loop, transcript samples before and after epoch changes, and allowed/forbidden gaps. Tie this to the FLY-545 output constraint for reconnect/session rebuild behavior (`research.md:172-174`).

5. The plan assumes live network/tool availability without a bounded fallback.

   Why it matters: The plan tells the runner to refresh upstream with `gh api` before implement (`plan.md:40-43`) and later uses GitHub again for B (`plan.md:265-267`). In this checkout, bounded `gh api` calls to `api.github.com` fail with a connection error, and `npm view` also hangs under network restriction. The repo has a `.node-version` of 22, but current shell is Node 25.6.1, which raises avoidable native-install risk for `@discordjs/opus`; `flywheel-comm` exists as a package bin (`packages/flywheel-comm/package.json:24-25`) but is not currently on PATH.

   Suggested fix: add a Task 0 preflight that records `node --version`, enforces repo Node 22 or an approved LTS, checks `flywheel-comm` availability or gives the exact `pnpm --filter flywheel-comm ...` fallback, and bounds all network refresh commands. If GitHub/npm are unavailable, the runner should record that fact in `progress.md`/`00-env.md` and continue with the already-audited research path rather than blocking before the real-machine DAVE test.

## Verdict
CHANGES REQUESTED — address the runbook gaps above before handing this to the implement-phase runner.
