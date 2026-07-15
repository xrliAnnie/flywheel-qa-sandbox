---
issue: FLY-1269
phase: implement
phaseCursor: 8/8
updated: 2026-07-15T19:15:00.000Z
nextStep: A7 defects fixed + Codex R1 findings addressed. Codex incremental
  cross-family review on the new head, then independent QA 436dea86 (Monitor
  auto-opens on head change). Do NOT re-run the 529 E2E; do NOT touch the 529
  slot; do NOT pnpm install while swap is tight (CI runs the vitest specs).
chunks:
  - id: task7
    order: 7
    deps: []
    done: Implementation and local verification complete
    status: done
pointers:
  pr: https://github.com/xrliAnnie/flywheel/pull/604
---

# FLY-1269 progress
**phase**: implement (8/8)
**next**: Codex incremental cross-family review on the new head, then independent QA 436dea86 (Monitor auto-opens on head change). Do NOT re-run the 529 E2E and do NOT touch the 529 slot.

## chunks
- ✅ task7 — Implementation and local verification complete
- ✅ task8 — A7 adjudicated defects fixed (see below)

## task8 — the two A7 defects (adjudicated, fixed)

**(a) `codex-phase-shutdown.ts` handed out direct cleanup on a LIVE pane.**
At both heartbeat checks (`:192-195`, `:291-300`) every not-alive liveness has
already returned above, so liveness there is *only ever* `alive`. Both still
returned `direct` on a stale / non-advancing heartbeat — contradicting the
file's own header contract (`:7-9`, "backstop only when the controller is
provably absent; uncertainty fails closed"). Both now fail closed. The tmux
identity probe (`target_gone` / `dead_pin` / `absent`) is the sole authority
for culling. The two heartbeat-derived `DirectReason` values are kept but are
now unreachable by design (they are still referenced by the mocked caller tests
in `close-runner.test.ts` / `post-merge.test.ts`).

**(b) `qa/529-terminal-observer` reported DELETED windows as alive.**
`tmux display-message -p -t <session>:=<id>` resolves an unknown target against
the *current* window and exits 0, so a deleted window printed a live window's id
and read ALIVE — `terminal()` never held, which is the A7 timeout. Replaced with
a `list-panes -a` identity snapshot (no `-t`, nothing to mis-resolve). Pure
rules split into `qa/target7-pane-identity.mjs` so they are unit-testable.

**Evidence (before/after, same harness, real code — not self-report):**
`node --experimental-strip-types` against the ORIGINAL `00453c71b` reproduces
both defects (`direct:controller_lease_stale`, `direct:controller_heartbeat_stopped`,
3 FAILED); against the fix: ALL GREEN, while probe-proven absence still culls
(no over-blocking) and `claude-tmux` stays `not_applicable`. The observer rules
were mutation-verified with plain node — degrading the identity match back to the
display-message fallback reproduces the A7 false-alive (`got true, want false`).

**Not yet run here:** `pnpm install` / vitest / lint — swap was ~1.5GB free and
the Lead forbade installing. The new vitest specs
(`codex-phase-shutdown.test.ts`, `target7-pane-identity.test.ts`) are written but
must be run by CI / a load-safe follow-up.
