# FLY-2550 常驻 Lead 线程轮换 — 实施验证
Issue: FLY-2550
日期: 2026-09-15
基于: plan.md; follow-ups.md

## Implement scope

C0–C8 implemented under scheduling ruling
`98fab9f8-af97-4f9b-b1e2-a4e8ad20d6d8`. No new dependency. TUI runtime only;
headless retains its read behavior and shares the atomic thread-id writer.
Four Codex memory gates, pinning, and production launchers remain unchanged.

## Red → green evidence

| Chunk | Initial failure | Green |
|---|---|---|
| C0 | measurement prerequisite | 590.55 / 865.26 ms, completed; isolated 0.154.0, 7,096,220 B rollout |
| C5 | 3 assertions: void teardown result | 16 tests |
| C1 | missing new rotation module | 73 tests |
| C2 | 2 failures: pause method absent | 28 tests |
| C3 | 3 failures: count method absent | 41 tests across SQLite and journal suites |
| C4 | 2 failures: rebuild request method absent | 14 tests |
| C6 | founder start callback absent | 30 TUI config/demux tests |
| C7 | 20 failed / 2 passed initially | 40 production assembly tests with controlled external adapters |

Final focused command (2026-09-15 01:50 UTC):

```sh
VITEST_MAX_FORKS=1 pnpm --filter flywheel-teamlead exec vitest run \
  src/lead-backends/codex/__tests__/codex-lead-thread-rotation.test.ts \
  src/lead-backends/codex/__tests__/codex-lead-tui-runtime.rotation.test.ts \
  src/lead-backends/codex/__tests__/LeadInputRouter.test.ts \
  src/lead-backends/codex/__tests__/LeadJournal.test.ts \
  src/lead-backends/codex/__tests__/SqliteJournalStore.test.ts \
  src/lead-backends/codex/__tests__/DaemonConnectionSupervisor.test.ts \
  src/lead-backends/codex/__tests__/codex-lead-tui-runtime.test.ts \
  src/lead-backends/codex/__tests__/codex-lead-runtime.test.ts \
  src/lead-backends/codex/__tests__/tui-window.test.ts
```

Result: **9 files, 369 tests passed**, 15.12s, exit 0.
Includes headless regression, strict ids/schema, replay across W1–W5, actual
W1 fenced handoff with durable accepted-input recovery, attempt-marker ordering,
atomic replacement, fence timeout/rollback, persistent-write failures, 6h
backoff, readiness recovery, off-switch guards, bootstrap, and turnless repair.

## Build and lint

- `pnpm install --frozen-lockfile`: exit 0. Initial missing-vitest result was
  environment setup failure, not a behavioral red test.
- `pnpm --filter flywheel-teamlead typecheck`: exit 0 after wiring fixes.
- `pnpm -r build`: exit 0 (all workspace packages).
- `pnpm lint`: initially failed one touched-file formatting check after removal
  of an unused import; formatted the file and reran: exit 0, 3,729 files checked. Existing unrelated
  warnings were left intact.
- No new shell test files. `tmux-viewer.macos.test.ts` was not run.

## Remaining independent gates

Per Lead ruling, no host full package suite. Full package verification is the
exact-head CI gate; focused green does not substitute for it. Code review, CI,
QA room E1–E6, and production week E7–E8 are separate receipts. At this document's
commit, review and CI are pending; no deployment, production rotation, or true
summary acceptance is claimed. QA dispatch and shipping belong to the controller.

The new count queries the Lead's independent journal.db, not StateStore or
session_events; FLY-2006's teamlead.db/comm.db deletion targets do not apply.

## R1 correction (2026-09-15)

Authority: `design-correction.md` records Lead decisions f3eca09f and b8bef3ea.
R1 effective code review APPROVED on c6c376f02; CI run 34919031532 failed
real assertions in flag registration and kill inventory. All four Teamlead
shards and five shell groups passed in that run; aggregate remained red.

The replacement project flag `codex_lead_thread_rotation` uses the existing
SQLite registry, default-on codec and named wrapper. Project overrides precede
`*`, then the registered default. Every generation reads through a readonly
StateStore handle and closes it immediately; absent/unreadable DB disables
rotation without creating a DB or consuming pending/readiness. There is no env
switch or exemption. Existing stage/apply routes enforce scope and reason.

Two Lead-selected MEDIUM fixes: an absent pane satisfies shutdown; exceptions
inside the fence record `rotation_failed:fence_error`, clear pending and restore
input/pane with six-hour backoff. An uncleared durable pending keeps its safety
fence. The three LOW suggestions remain in follow-ups.md by Lead decision.

Red evidence: new named flag reader initially absent (one failing assertion);
new pane-absent and journal-throw tests initially failed. Green verification:

- Six focused Teamlead suites (flag-store-runtime, flag-routes, rotation helpers,
  rotation assembly, TUI config/demux, tui-window): **228 passed**, 61.68s.
- Config registry and drift/read-site gates: **69 passed**, 24.09s.
- Mechanically regenerated kill inventory: **5 passed**, 12.69s; count 683,
  exactly one added qa-only entry (the rotation fixture's mock kill).
- `pnpm -r build`: exit 0, all packages.
- `pnpm lint`: exit 0, existing 18 warnings; no new shell test files.
- Final journal-failure recovery assertion submits a real router input and
  requires one `turn/start` after recovery; focused rerun recorded below.

Fresh exact-head code review and CI remain required after the combined push.
This document does not claim QA, production rollout_summary creation or ship.

Final recovery-only rerun: **1 passed / 42 unselected**, 9.25s, exit 0;
`-t 'journal exception'` selects the enhanced regression. It verifies a submitted
input reaches `turn/start`, rather than relying only on router idle state.

## Final docs-only follow-up

Code HEAD `cd769c4f70be97ac1006fd3076abd0fa274b55ed`: R2 effective APPROVED
(gate `8d382a1a-ff83-471d-a209-cbf2ea79f948`) and CI
[34921055559](https://github.com/xrliAnnie/flywheel/actions/runs/34921055559)
completed **success**, including every package and shell group.

Lead response `78dacdf5-c82f-417e-9e83-74ed1a2e8cc5` requires only the founder
rollback documentation correction, publication and final-head CI; no new review
round for this docs-only delta. The two residual code advisories are recorded in
follow-ups.md without code changes.

Founder template and d3 source/SVG now show project SQLite
`codex_lead_thread_rotation=0`, effective next generation. Local mmdc could not
launch Chromium (OS MachPortRendezvous permission denial), so the existing SVG
text layer was updated directly with geometry/edges preserved, validated as XML,
and embedded using `_build_founder.py`. All four artifacts were checked for the
new flag and absence of the removed env switch.

Publish-only receipt (no Discord delivery):
[corrected founder page](https://fw-reports-624a39.vercel.app/r/6413589e77927e316f52a251aee8898a/).
Hosted verification: HTTP 200, SQLite rollback in table and diagram, zero old
switch/nonce placeholders, one resolved script nonce matching the CSP header.
Final docs HEAD still requires its own CI before completion.
