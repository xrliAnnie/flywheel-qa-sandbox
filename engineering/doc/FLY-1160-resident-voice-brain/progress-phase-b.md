---
issue: FLY-1160
phase: implement (COMBINED — /glaw §4.1 + /eleven §4.2 resident brain, one PR)
updated: 2026-07-11T13:05:00.000Z
belt: yours (3c199365, implement, epoch 10)
branch: flywheel-FLY-1160-phase-b (from 545 head 1fc98a99)
mergeBase: c0214b3b (merged origin/main 8d5e205f — Phase A resident-brain components in)
contract: plan.md §4.1 (/glaw) + §4.2 (/eleven) — Tadashi fold-in plan (msg 42a76adc / 2c16fa84)
combinedHead: 918fa5f5 (merge of bf87d3ae Phase B + 93d33ba1 Phase C) — FROZEN (Codex APPROVED + FLY-827 satisfied)
siblingPR: "#552 (/eleven Phase C) FOLDED into #555 + CLOSED — one combined PR, one QA"
---

# FLY-1160 Phase B (/glaw 接常驻大脑) — progress

## DONE
- Branch `flywheel-FLY-1160-phase-b` off 545 head `1fc98a99`; merged `origin/main` (Phase A in) → merge commit `c0214b3b`.
- 3 merge conflicts resolved per plan §5 (keep BOTH 545 fixes + Phase A additions):
  - `voice-core/src/types.ts`: VoiceErrorCode keeps 545's `connection-closed` + Phase A's `resource-exhausted`.
  - `voice-bridge/src/config.ts`: keeps 545 `DEFAULT_COMMAND="glaw"` + all 545 config fields + Phase A brain defaults + `...(brain?{brain}:{})`.
  - `voice-bridge/src/cli.ts`: imports merged (genai + ResidentBrainManager); `brainManager`+`brainPort` declared alongside 545 `activeMeeting`; two-phase shutdown (Phase A) with 545 `activeMeeting?.dispose()` folded into Phase-2 budget.
- typechecks clean (voice-core + voice-bridge + teamlead); voice-core 314 tests green; voice-bridge 495/502 green.

## DONE (cont.)
- §4.1-3 TextTurnMouth `d0a4e531` — resident /glaw mouth: sentence-buffer over LeadSpeaker text-queue, turn gate, endTurn tail flush, barge-in flush(), fail-loud onError. 8 tests. READY for §4.1-5 (addressed respond → TextTurnMouth).

## DONE (§4.1 core — post-compact block, TDD units on flywheel-FLY-1160-phase-b)
- **Unit 1 (a1bf6b06)** — fixed the 7 red Phase-A daemon tests. Root cause = merge-integration:
  the merged 545 cli wires the FULL /glaw meeting face at startup (deps.tivPort at cli.ts:246)
  and the merged resolver requires 545 tokens. Fix = fixture-alignment with the PROVEN sibling
  tests (daemon-health.test.ts / assistant-wiring.test.ts ALREADY boot the full daemon with a
  complete fakeDeps): completed daemon-brain-port fakeDeps + brain-config ENV. NOT a production
  band-aid (that would be deps.tivPort?.() in cli.ts). JUDGMENT CALL vs Tadashi's literal
  "meeting seam / wireGlawMode extraction" steer — chose fixture-completion because the seam
  already exists (sibling tests) and an extraction purely to gate a test = over-engineering.
  Flagged to Tadashi.
- **Unit 2 (9329c978)** — config knob huddle.brain.mode "gemini"|"resident" (default gemini,
  absent = byte-compat; present-but-invalid fails loud). mode only appears in the resolved brain
  object when set, so the resolved shape stays byte-identical.
- **Unit 3 (13ee091e)** — ResidentLineDriver: pumps brain.respond(text) stream -> TextTurnMouth
  (beginTurn/feed/endTurn), serial turns; barge-in stops mouth SYNC then aborts + brain.interrupt;
  onSpeaking/onAnswer(full text)/onError callbacks; cancelled turns silent, real failures fail-loud.
- **Unit 4 (725deb97)** — HuddleSession resident-mode support (additive; gemini path byte-identical).
  speakThrough(line,prompt) + interruptLine(line) seams; non-switched founder turn kicks off
  addressed resident.respond; handleResidentSpeaking/Answer/Error mirror the Gemini response flow.
  522/522 suite green; the 19 gemini-path huddle/wire-meeting tests unchanged.

Design lock: mode="gemini" (default) keeps the whole shipped 545 path byte-identical; mode="resident"
is the §4.1 flip, isolated behind the `resident` handle on each HuddleLine.

## DONE (§4.1 core COMPLETE — all 8 points)
- **Unit 5 (4049fb52)** — wireMeeting resident branch: mode:"resident" builds each line as
  resident brain + TextTurnMouth (edge-tts) + ResidentLineDriver; Gemini = STT-only (response
  discarded); FeedPipeline→appendContext (accepted:false throws→hold; context-drained→retry);
  onEvent→TIV recovering/failed + host lifetime-expiry→degraded land. createResidentLine seam
  keeps EdgeTts/LeadSpeaker/brainManager in cli. 3 wire-meeting-resident tests; gemini path
  byte-identical (6 gemini tests unchanged).
- **Unit 6 (37f41aec)** — cli.ts daemon wiring: mode plumbing + createResidentLine (brainManager.open
  + LeadSpeaker/EdgeTts, FLYWHEEL_VOICE_EDGE_TTS overridable) + §4.1-6 summarize→host resident
  final turn (journal fallback) + §4.1-7 release→manager.close(keys) + §4.1-8 (ask_lead per-turn
  timeout simply not wired in resident mode). Gemini mode untouched.

§4.1 checklist: 1✅(createBrain→resident) 2✅(STT-only, response discarded) 3✅(TextTurnMouth)
4✅(appendContext+context-drained→retry) 5✅(respond→mouth + sync barge-in) 6✅(host resident
summarize) 7✅(manager.close teardown + lifetime-expiry degraded land) 8✅(onEvent→TIV + per-turn
timeout retired by mode).

Full verification: voice-bridge 525/525 + voice-core 314 green; tsc + biome clean across
voice-core/voice-bridge; teamlead untouched by Phase B.

## DONE: Phase B PR #555 + Codex code review APPROVED
- PR #555 (flywheel-FLY-1160-phase-b → main), head 1a978ff3.
- Codex code review (xhigh, gpt-5.6): **5 rounds → APPROVED**. R1 3 HIGH → R2 3 HIGH → R3 1 HIGH →
  R4 1 HIGH → R5 clean. Every finding fixed with a regression:
  - barge-in ownership: sync AbortController + inFlight Set (R2H1); residentFloor for the
    pre-delta/mouth-drain window (R1H1/R2H2); landing no-op scoped to RESIDENT targets so the
    gemini path stays byte-compat (R4).
  - resident brain leak on assembly failure: opened-key reap via closeResidentLine port +
    cli defense-in-depth (R1H2).
  - summary fallback: clean-only landing (R1H3); disposed flag closes the daemon-shutdown
    clean-interrupt vector → raw journal never a partial (R3).
- FLY-827 code-review.json written (reviewedHeadSha===1a978ff3) + await-codex-gate code PASSED.
- CI: Build & Test IN_PROGRESS (flywheel-land polling).
- 538 voice-bridge + 38 voice-core resident/manager tests; tsc + biome clean both packages.

## DONE: fold-in complete — ONE combined PR #555 (Tadashi plan 42a76adc / 2c16fa84)
- Merged `origin/flywheel-FLY-1160-phase-c` (93d33ba1) into phase-b → merge commit `918fa5f5`
  (clean, NO textual conflicts). Parents = the two already-approved heads bf87d3ae + 93d33ba1.
- Stale voice-core/dist fixed (`pnpm --filter flywheel-voice-core build`) so voice-bridge tsc reads
  the merged ResidentBrainManager.suspend surface. All suites green on combined head:
  voice-bridge 573 · voice-core 315 · teamlead linear-comments 7; tsc + Biome + diff-check clean.
- Pushed `918fa5f5` → origin/flywheel-FLY-1160-phase-b (PR #555 head).
- **Codex coexistence re-review** (resumed thread 019f50df, xhigh, gpt-5.6): **APPROVED, no findings**
  @ 918fa5f5. Verified merge topology / cli.ts hunk-by-hunk preservation / shared single
  ResidentBrainManager / shutdown ordering (activeMeeting.dispose → assistant close → /eleven
  close-with-signal → brainManager.closeAll) / key-namespace disjoint / config coexistence /
  byte-compat. Posted to PR #555 (gh api sandbox-blocked → posted via gh pr comment).
- **FLY-827 gate**: code-review.json rewritten (reviewedHeadSha=918fa5f5, rounds=7) +
  `await-codex-gate code` → APPROVED @ 918fa5f5. HEAD now FROZEN.
- **#552 CLOSED** as folded-in (fold note + bidirectional link #552↔#555). Every Phase C commit
  preserved in 918fa5f5 history; §4.2 Codex approval @ 93d33ba1 still stands.
- **PR #555 retitled + rebodied** to the combined /glaw+/eleven resident-brain description.
- CI (Build & Test) IN_PROGRESS on 918fa5f5.

NOTE: this ledger update is held UNCOMMITTED to keep HEAD frozen at the Codex-reviewed 918fa5f5
(a ledger commit would drift HEAD off the FLY-827-bound sha). It folds into the next natural head
movement (QA fixes) or the pre-ship-gate commit, with an incremental Codex re-review at that point.

## NEXT: report Tadashi (先别 complete — his instruction). He orchestrates the ONE combined QA
(B+C together, Discord E2E via Claude-in-Chrome). After QA passes, open the approve gate; both
PRs stop at founder ship gate. Nothing ships without Annie's verified verify-approval.

## (superseded) REMAINING
2. **§4.1 (remaining) — wireMeeting resident branch + cli.ts wiring**:
   1. `huddle/wireMeeting.ts`: `ports.createBrain` → resident (`manager.open`, key=`<issue>:<leadId>`, persona=lead identity.md, readOnlyRoot=projectRoot), open in assembling window.
   2. Gemini line stays AUDIO (TEXT rejected by real-machine); response audio + output transcript DISCARDED (no GeminiTurnMouth); input transcription still feeds resident.
   3. New `TextTurnMouth` (EdgeTts.synthesize text queue — GeminiTurnMouth 24k PCM incompatible w/ EdgeTts MP3):句级 buffer → serial synth → play-order → final flush → fail-loud TIV → barge-in stop() clears queue.
   4. FeedPipeline via resident `appendContext()` (replaces Gemini injectContext); `accepted:false`→HOLD cursor; `context-drained{upToSeq}`→`feed.retry()`.
   5. `handleFounderUtterance`: addressed → `brain.respond(text)`→TextTurnMouth; barge-in `mouth.stop()` sync THEN async `brain.interrupt()`; next respond awaits barrier.
   6. `cli.ts summarize`: host resident final-turn minutes; journal snapshot as crash-fallback.
   7. teardown: `manager.close(all keys)`; `lifetime-expiry`→degraded landing; thread the phase-2 signal into `WiredMeeting.dispose(signal)` (cli.ts already calls dispose() — add the signal param in §4.1).
   8. onEvent→TIV recovering/failed; **retire ONLY the resident-replaced defensive timeouts (45s brain timeout + watchdog); KEEP 545 presence/noise-gate/reconnection**.
3. Codex code review → then **B+C complete together** → one QA covering #552 + this PR → both stop at founder ship gate.

## §4.1 ARCHITECTURE NOTE (read wireMeeting.ts — key insight for continuation)
**The big flip**: current /glaw = **Gemini-thinks** (Gemini Live is the conversational engine — hears audio, thinks, responds with audio → GeminiTurnMouth; `ports.createBrain`/ReadOnlyLeadBrain is only the `ask_lead` TOOL Gemini calls for facts). §4.1 flips to **resident-Claude-thinks**: Gemini kept for AUDIO only (input transcription = STT feeds resident; **response audio/output DISCARDED** — do NOT route `response-audio`→mouth), the RESIDENT brain does the thinking (respond to founder text) → **TextTurnMouth** (§4.1-3, done).

Files to rewire (the core, all interdependent):
- `wireMeeting.ts`: line ~138 `new GeminiTurnMouth` → `TextTurnMouth` (over a LeadSpeaker); line ~145 `ports.createBrain` → resident (`manager.open(key=<issue>:<leadId>)`, persona=lead identity.md); line ~228 `response-audio`→mouth routing REMOVED (discard); keep `transcript` (input STT) → feeds resident.
- `HuddleSession.ts` (the conductor): currently routes Gemini `response-audio`→mouth + `response-started/done/cancelled`. §4.1-5: `handleFounderUtterance`(addressed) → `brain.respond(text)` stream → `TextTurnMouth.feed/endTurn`; barge-in: `mouth.flush()` SYNC first, then async `brain.interrupt()`; next respond awaits barrier. READ HuddleSession.ts first on continuation.
- `MeetingPorts`: `createBrain` return type changes (resident brain w/ respond/interrupt/appendContext), or add a `createResidentBrain`. The daemon (cli.ts) builds it from `brainManager` (already declared post-merge).
- §4.1-4 FeedPipeline: `injectContext`(Gemini) → resident `appendContext()`; `accepted:false`→HOLD cursor; `context-drained{upToSeq}`→`feed.retry()`.
- §4.1-6 ConclusionPipeline `summarize` → host resident final-turn minutes (journal snapshot fallback).
- §4.1-7 dispose → `manager.close(all keys)`; thread phase-2 signal into `WiredMeeting.dispose(signal)`.
- §4.1-8 onEvent→TIV recovering/failed; retire ONLY 45s brain timeout + watchdog (keep 545 presence/noise-gate/reconnect).
- The 7 daemon-startup tests: the `wireMeeting` seam (a fake `createResidentBrain` / gate the meeting startup when no orchestrator) fixes them here.

Gemini stays AUDIO (TEXT rejected real-machine, s1-gemini-text-modality.md). `bargeIn:false` on Gemini stays (our EarsReceiver is the interrupt authority).
