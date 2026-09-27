---
issue: FLY-2919
phase: implement
phaseCursor: 0/6
updated: 2026-09-27T03:46:32.402Z
nextStep: "B8 committed153320e79 and pushed8b63b9bac. B9 code d7089d4b1 COMPLETE
  AS CHECKPOINT ONLY: dispatcher uses synchronous shared body reader, no default
  window probe or terminal-first death gate. Current-generation immutable
  body_death + exact projected receipt survives sampling expiry and workflow
  slot handoff; registered-owner replacement revalidates proof/run/node/attempt
  and managed switch inside final transaction after awaits. Normal
  single-successor and disable/generation-race guards proved red/green. 19
  concrete files480pass/1existing skip; bounded related8files304pass/1skip plus
  direct-caller5files104pass. Build+dependencies, teamlead/voice-codex
  typechecks, lint final pass (26warnings incl1late-assignment advisory).
  Formatter-only type annotation wrap has explicit before/after hash proof and
  post-format18wiring tests;8source hashes archived with all diagnostics. NEXT
  DIRECT B10 server-loss/crash-reaper/zombie-scan: plugin
  ServerLossCoordinator.targetGone still maps missing window/dead_pin to death
  and migrate applies failed/forceStatus around161xx; crash-reaper still gates
  ownership on dead-pin/heartbeat age and terminalizes after window kill. Unify
  with common BodyObservation/C2 and separate window cleanup from death. Full
  approved A-F/nine-ticket objective remains: legacy binding/compatibility path,
  same-generation logical activation, ordinary/rework settlement/retirement, all
  direct importers, D/E/F and nine-case matrix, A9 original15s routes import
  timeout, final effective review/PR/frozen CI/handoff. No external pending
  gate, no blocked condition, no final completion."
chunks: []
pointers: {}
---

# FLY-2919 progress
**phase**: implement (0/6)
**next**: B8 committed153320e79 and pushed8b63b9bac. B9 code d7089d4b1 COMPLETE AS CHECKPOINT ONLY: dispatcher uses synchronous shared body reader, no default window probe or terminal-first death gate. Current-generation immutable body_death + exact projected receipt survives sampling expiry and workflow slot handoff; registered-owner replacement revalidates proof/run/node/attempt and managed switch inside final transaction after awaits. Normal single-successor and disable/generation-race guards proved red/green. 19 concrete files480pass/1existing skip; bounded related8files304pass/1skip plus direct-caller5files104pass. Build+dependencies, teamlead/voice-codex typechecks, lint final pass (26warnings incl1late-assignment advisory). Formatter-only type annotation wrap has explicit before/after hash proof and post-format18wiring tests;8source hashes archived with all diagnostics. NEXT DIRECT B10 server-loss/crash-reaper/zombie-scan: plugin ServerLossCoordinator.targetGone still maps missing window/dead_pin to death and migrate applies failed/forceStatus around161xx; crash-reaper still gates ownership on dead-pin/heartbeat age and terminalizes after window kill. Unify with common BodyObservation/C2 and separate window cleanup from death. Full approved A-F/nine-ticket objective remains: legacy binding/compatibility path, same-generation logical activation, ordinary/rework settlement/retirement, all direct importers, D/E/F and nine-case matrix, A9 original15s routes import timeout, final effective review/PR/frozen CI/handoff. No external pending gate, no blocked condition, no final completion.
