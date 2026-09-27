---
issue: FLY-2919
phase: implement
phaseCursor: 0/6
updated: 2026-09-27T01:45:37.634Z
nextStep: "B6 checkpoint79c76da59: production common observer now protects
  current Codex recovery-eligible bindings before first claim, until durable
  current exhaustion; alive remains alive. Added read-only StateStore proof with
  revision/episode/reservation/settlement validation; pending-reservation active
  separated from expired-readiness. Existing budget/restart/owner admission and
  mutation-commit reset unchanged. 13 explicit files240 pass, bounded owning
  related9files212, affected deps build, teamlead/voice-codex typecheck and lint
  pass; evidence archived. NEXT DIRECTLY implement production Heartbeat
  declareZombie/reapOrphans and dispatcher C2 StateStore+CommDB convergence,
  removing pane/server/age death authority and parked exemption. Reuse B5
  bounded sampler, start/stop it and ensure same-pass death handling; invoke
  existing reowner on demand outside mutation lease when recovery has priority.
  Preserve completion-marker-first and death alert/duty replay. Sampler not
  started and Heartbeat main-account path still old. Full A-F/nine tickets,
  logical activation bridging, legacy binding, ordinary/rework settlement and
  other direct consumers remain. A9 routes original15s timeout unresolved. No
  review/PR/full CI/QA/handoff."
chunks: []
pointers: {}
---

# FLY-2919 progress
**phase**: implement (0/6)
**next**: B6 checkpoint79c76da59: production common observer now protects current Codex recovery-eligible bindings before first claim, until durable current exhaustion; alive remains alive. Added read-only StateStore proof with revision/episode/reservation/settlement validation; pending-reservation active separated from expired-readiness. Existing budget/restart/owner admission and mutation-commit reset unchanged. 13 explicit files240 pass, bounded owning related9files212, affected deps build, teamlead/voice-codex typecheck and lint pass; evidence archived. NEXT DIRECTLY implement production Heartbeat declareZombie/reapOrphans and dispatcher C2 StateStore+CommDB convergence, removing pane/server/age death authority and parked exemption. Reuse B5 bounded sampler, start/stop it and ensure same-pass death handling; invoke existing reowner on demand outside mutation lease when recovery has priority. Preserve completion-marker-first and death alert/duty replay. Sampler not started and Heartbeat main-account path still old. Full A-F/nine tickets, logical activation bridging, legacy binding, ordinary/rework settlement and other direct consumers remain. A9 routes original15s timeout unresolved. No review/PR/full CI/QA/handoff.
