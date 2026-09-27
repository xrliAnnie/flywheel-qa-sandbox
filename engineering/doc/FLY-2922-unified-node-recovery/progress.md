---
issue: FLY-2922
phase: implement
phaseCursor: 0/6
updated: 2026-09-27T01:07:59.789Z
nextStep: "e3ae5cc0d adds bounded legacy_active_orphan discovery for
  active+pending+NULL execution only when an exact abandoned dispatch,
  cancellation, old rollback event, and matching hold_resumed chain uniquely
  agree. Canonical v2 apply mints ordinal+1, binds the node, remains active, and
  dispatcher starts it; missing release proof does not expose the synthetic
  recovery. Node recovery 10/10, dead-exec 30 pass/1 existing skip, holds 35/35,
  dispatcher 137/137, registry 4/4, package build GREEN. Next: recorded
  loop/idle decisions and historical supersession; FLY-2921 merge-order question
  c56a7e05 pending."
chunks: []
pointers: {}
---

# FLY-2922 progress
**phase**: implement (0/6)
**next**: e3ae5cc0d adds bounded legacy_active_orphan discovery for active+pending+NULL execution only when an exact abandoned dispatch, cancellation, old rollback event, and matching hold_resumed chain uniquely agree. Canonical v2 apply mints ordinal+1, binds the node, remains active, and dispatcher starts it; missing release proof does not expose the synthetic recovery. Node recovery 10/10, dead-exec 30 pass/1 existing skip, holds 35/35, dispatcher 137/137, registry 4/4, package build GREEN. Next: recorded loop/idle decisions and historical supersession; FLY-2921 merge-order question c56a7e05 pending.
