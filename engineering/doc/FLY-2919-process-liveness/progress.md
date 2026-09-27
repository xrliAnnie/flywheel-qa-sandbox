---
issue: FLY-2919
phase: implement
phaseCursor: 0/6
updated: 2026-09-27T02:45:56.295Z
nextStep: "B8 WIP after1c4b1a8ca: implemented independent runtime over sole B5
  sampler cache. Plugin starts5s sampling after boot reown barrier,
  Heartbeat/C2/terminal-sweep read cached original observation; 2 lifecycle
  consumers run separately from 8-per-pass/2-OS-worker budget, stop drains.
  Added owner scheduling inventory including business-terminal rows until
  closed+drained; duty replay every pass. C2 retries lease_held at25/75ms only,
  each attempt rechecks all fences outside wait.
  Sampler13/runtime8/owner37/wiring17/C2integration16 passed individually and
  affected dependencies build passed. C2 real fresh-heartbeat test proves both
  ledgers close with one sample. B8 final related/guards/typechecks/lint not yet
  collected; changes uncommitted. NEXT finish B8 verification/checkpoint then
  DIRECT dispatcher durable death receipt/current generation reader plus cached
  hot-tick consumption: sampler observations invalidate on death CAS, so old
  terminal-first window probe cannot merely be swapped to read(). Full A-F/nine
  tickets and server-loss/crash-reaper/other consumers, logical activation
  bridging, legacy, ordinary/rework settlement, A9 original15s timeout still
  remain. No final review/PR/CI/QA/handoff."
chunks: []
pointers: {}
---

# FLY-2919 progress
**phase**: implement (0/6)
**next**: B8 WIP after1c4b1a8ca: implemented independent runtime over sole B5 sampler cache. Plugin starts5s sampling after boot reown barrier, Heartbeat/C2/terminal-sweep read cached original observation; 2 lifecycle consumers run separately from 8-per-pass/2-OS-worker budget, stop drains. Added owner scheduling inventory including business-terminal rows until closed+drained; duty replay every pass. C2 retries lease_held at25/75ms only, each attempt rechecks all fences outside wait. Sampler13/runtime8/owner37/wiring17/C2integration16 passed individually and affected dependencies build passed. C2 real fresh-heartbeat test proves both ledgers close with one sample. B8 final related/guards/typechecks/lint not yet collected; changes uncommitted. NEXT finish B8 verification/checkpoint then DIRECT dispatcher durable death receipt/current generation reader plus cached hot-tick consumption: sampler observations invalidate on death CAS, so old terminal-first window probe cannot merely be swapped to read(). Full A-F/nine tickets and server-loss/crash-reaper/other consumers, logical activation bridging, legacy, ordinary/rework settlement, A9 original15s timeout still remain. No final review/PR/CI/QA/handoff.
