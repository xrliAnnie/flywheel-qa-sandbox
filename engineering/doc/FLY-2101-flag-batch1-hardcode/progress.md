---
issue: FLY-2101
phase: qa
phaseCursor: 6/6
updated: 2026-08-28T23:23:00Z
nextStep: push the authorized rebased head, then request new-head review and QA revalidation
chunks: []
pointers: {}
---

# FLY-2101 progress
**phase**: qa (rebase conflict audit complete)
**next**: push the authorized rebased head, then request new-head review and QA revalidation

## 2026-08-28 conflict-rework audit

- Base: `origin/main` `6f81b753a` (includes #973 / FLY-2097 and #970 / FLY-2102).
- Rebase: one manual pass; no `ours` / `theirs` resolution commands.
- Conflicts: 12 files across config ledgers/exports, CLI fixtures, `StateStore`, and flag route/toggle tests.
- Resolution invariant: preserve FLY-2100 project-store + `alert_system`; union FLY-2102's 9 startup/CLI removals with FLY-2101's 13 runtime removals.
- Resulting registry/baseline: 16 registry specs / 9 legacy-unmanaged entries; deleted B1 env tokens remain absent from `packages` and `scripts`.
- FLY-2102 historical ledger integration: mark the 13 FLY-2101 entries `constantizedBy: "FLY-2101"` without retaining deleted env-token strings.
- QA tree audit correction: replace the removed B1 view fixture with surviving unmanaged `checkpoint_enabled`; the first manual resolution had selected FLY-2102-retired `voice_qa_presence_override`.
- Focused proof before full QA: config 87/87, teamlead routes/toggle 27/27, flywheel-comm CLI 13/13.
- Full QA: lint and build pass; config 680/680; core 219/219 excluding the host-only Terminal/HIServices test; Teamlead 9,600 assertions pass with 15 unrelated timeout-only fixtures under the constrained whole-package run; every timeout/race fixture sampled alone passes.
- Final guards: flag truth 3/3, FLY-1674 residue 59/59, FLY-2102 freeze 46/46, milestone layout 32/32, and the 13 deleted B1 env tokens have zero source matches outside `dist`.
