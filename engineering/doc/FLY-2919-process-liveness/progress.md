---
issue: FLY-2919
phase: implement
phaseCursor: 0/6
updated: 2026-09-27T03:23:00.342Z
nextStep: "B8 pushed153320e79/8b63b9bac, verified14files273pass+related9files219
  coverage with owner-timeout retry, builds/types/lint green. B9 WIP
  uncommitted: durable projected body-death reader checks exact
  owner/generation/spawn/binding/terminal lifecycle/activation/ack; current
  workflow slot intentionally checked at replacement CAS not physical fact
  reader, so predecessor death remains readable after successor starts. Added
  synchronous cached/durable reader, plugin wiring and dispatcher removes
  terminal-first/default-window fallback. Registered-owner replacement now
  requires exact proof + synchronous managed-flag/currentness callback within
  transaction. Causal dispatcher5RED, CAS1RED actually returnedok:true when
  callbackfalse; C2 proof/CAS final20GREEN, reader5GREEN. Initial dispatcher
  green attempt hit missing test activation fixture and2original5s timeouts
  under hostload256; fixture corrected without production change or timeout
  changes. Active full dispatcher concrete-file verification session79987, log
  /tmp/fly2919-b9-dispatcher-full.log; inspect before starting another test. B9
  inventory archive14retained files exists, full
  selected/related/build/typechecks/lint still pending. Full A-F/nine
  tickets/legacy/direct consumers/ordinary-rework settlement/A9 routes timeout
  remain; no final review/PR/CI/QA/handoff."
chunks: []
pointers: {}
---

# FLY-2919 progress
**phase**: implement (0/6)
**next**: B8 pushed153320e79/8b63b9bac, verified14files273pass+related9files219 coverage with owner-timeout retry, builds/types/lint green. B9 WIP uncommitted: durable projected body-death reader checks exact owner/generation/spawn/binding/terminal lifecycle/activation/ack; current workflow slot intentionally checked at replacement CAS not physical fact reader, so predecessor death remains readable after successor starts. Added synchronous cached/durable reader, plugin wiring and dispatcher removes terminal-first/default-window fallback. Registered-owner replacement now requires exact proof + synchronous managed-flag/currentness callback within transaction. Causal dispatcher5RED, CAS1RED actually returnedok:true when callbackfalse; C2 proof/CAS final20GREEN, reader5GREEN. Initial dispatcher green attempt hit missing test activation fixture and2original5s timeouts under hostload256; fixture corrected without production change or timeout changes. Active full dispatcher concrete-file verification session79987, log /tmp/fly2919-b9-dispatcher-full.log; inspect before starting another test. B9 inventory archive14retained files exists, full selected/related/build/typechecks/lint still pending. Full A-F/nine tickets/legacy/direct consumers/ordinary-rework settlement/A9 routes timeout remain; no final review/PR/CI/QA/handoff.
