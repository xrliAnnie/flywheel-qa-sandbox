# QA-surfaced findings during FLY-228/229/222 E2E — verdicts (worker-fly-228)

**Issue**: FLY-228 (+ FLY-229, FLY-222 #1)
**Date**: 2026-06-08
**Author**: worker-fly-228
**Status**: investigation complete — verdicts below (committed because chat relay to team-lead was dropping)

---

## TL;DR

| Finding | Verdict | Action |
|---|---|---|
| **E** (folder-trust blocks first prompt) | **harness-specific** (NOT a production bug) | record harness limitation + 1 follow-up for a latent gap |
| **K** (lead-close a terminal no_code runner → flips `blocked`) | **REAL ship-blocker — FIXED in this PR** (`085eab2`) | terminal-immunity guard in DirectEventSink |
| **I** (raw-kill a parked-alive completed runner → flips `blocked`) | **same mechanism as K — ALSO FIXED by the K guard** | covered by `085eab2` |

**Finding K (the ship-blocker) is FIXED + Codex-APPROVED (×2).** Code HEAD:
`085eab2`. Codex code review **APPROVED** — multi-round on the base + the
Finding-K fix reviewed **twice** (2026-06-08 and 2026-06-09 re-confirm), zero
findings each. teamlead suite **1724/1724 (serial)**, `pnpm -r typecheck` green,
biome clean, real-machine E2E **FINAL PASS** (pre-K).

**Batch-ship gate status (228 side): CLEAR pending only (a) qa-fly-228 +
qa-fly-222 re-verify on `085eab2`, (b) Annie's ship-go.** Code-only — no merge /
no prod / no restart performed.

> Update (2026-06-09): Finding I was initially scoped as "separate/follow-up", but
> qa-fly-222's Finding K showed the SAME flip happens on the **sanctioned**
> `lead_close_runner` path (breaking no_code end-to-end), so it became in-scope and
> is fixed here. The single terminal-immunity guard covers both the raw-kill (I)
> and lead-close (K) variants.

---

## Finding E — folder-trust blocks the Runner's first task → HARNESS-SPECIFIC

**Mechanism (audited):**
- Claude Code folder-trust is gated by a **global** flag
  `~/.claude.json:hasTrustDialogAccepted` (keyed via `CLAUDE_CONFIG_DIR`), **not
  per-worktree** (`claude-lead.sh:793`).
- The Runner's task prompt is **baked into the `claude <prompt>` launch args**
  (`TmuxAdapter.ts:546`), not injected post-launch.

**Why production is fine:** production Runners inherit the machine's global
`~/.claude.json` (via `CLAUDE_CONFIG_DIR`) where `hasTrustDialogAccepted=true` is
already set → no trust dialog on a new worktree → the launch-arg prompt runs
immediately. That's why prod Runners reliably get their first task.

**Why the slot harness hit it:** the slot ran with an isolated/test config dir
lacking that global flag → trust dialog appeared → blocked. (Plus the slot's
window was `:1`-indexed with a stale `:pending` CommDB lookup, a harness
window-registration divergence — production `TmuxAdapter.registerSession`
overwrites `:pending` with the real `@window_id` immediately after `new-window`.)
qa-222's pre-trust clean-run fixed it.

**Latent gap worth a follow-up (not currently firing):** `TrustPromptHandler`
exists exactly for "new-worktree trust dialog blocks the Runner" but is **wired
into nothing** (only its own file + test + an unused export — no live spawn-path
caller). Production safety rests entirely on the inherited global flag; a fresh
machine / new `CLAUDE_CONFIG_DIR` would hit the same block with nothing to
auto-dismiss. Fix = wire `TrustPromptHandler` into spawn OR seed/assert the trust
flag at Runner spawn.

## Finding I — killing a parked-alive `completed`/`no_code` Runner flips it to `blocked` → REAL, PRE-EXISTING, separate from this PR

**NOT FLY-172 `reconcileMonitorLoss`** (the original hypothesis): its candidate
set is `getOrphanSessions(threshold)` = `WHERE status='running'` ONLY, so terminal
`completed`/`no_code` sessions are categorically excluded.

**Actual chain:** a `no_code`/`completed` session is terminal in StateStore but the
Runner process is still alive (parked-alive), so `TmuxAdapter.waitForCompletion`
keeps polling. Killing the tmux → pane dies → `settle(false)` (`TmuxAdapter.ts:801/869`)
→ `waitForCompletion` returns → the in-process runtime re-emits `session_completed`
with a Decision-Layer route of `blocked` (no PR/merge + abrupt death) →
`DirectEventSink` writes it via `upsertSession`, and the monotonic-terminal guard
(`StateStore.ts:598`) only blocks `terminal → running` (NOT `terminal → blocked`),
and `DirectEventSink` does not use `applyTransition` (no FSM edge guard). So
`completed → blocked` is written. The not-killed Runner kept its pane alive → no
re-emission → stayed `completed`. (HTTP `event-route` path is protected — it uses
`applyTransition`, which would reject `completed→blocked`.)

**Fix — DONE in this PR (`085eab2`), via the Finding K guard (see below).** Both
the raw-kill (I) and lead-close (K) variants share the exact same mechanism and
are covered by one terminal-immunity guard in `DirectEventSink`.

---

## Finding K — lead_close_runner of a terminal no_code runner flips it `blocked` → REAL ship-blocker, FIXED in `085eab2`

**Live repro** (qa-fly-222, slot3 session `bcaf491a`): `complete --route no_code`
→ `running→completed` (terminal reached) → `lead_close_runner` (correct, kills
tmux) → a spurious 2nd `session_completed` → `status=blocked`.

**Root cause (traced in the exact paths team-lead asked about):**
- `closeRunner` / `lead_close_runner` (`close-runner.ts`) emits ONLY
  `lead_close_runner*` audit events — it does NOT emit `session_completed`.
- `RunDispatcher.then/.catch` (`run-dispatcher.ts:514-535`) only LOG ("resolved
  with failure: unknown") + cleanup pre-registration — they do NOT emit or flip.
- The flip is the **in-process `DirectEventSink`** (bridge.log line 267:
  `[DirectEventSink] … session_completed … status=blocked`): killing the
  parked-alive runner's tmux makes `Blueprint.run` resolve `success=false`; the
  runtime re-emits `session_completed` with Decision-Layer route=`blocked`;
  `DirectEventSink` writes via `upsertSession`, whose monotonic guard only blocks
  `terminal→running` (NOT `completed→blocked`) and which (unlike the HTTP
  `/events` sink) does NOT go through `applyTransition`. → `completed→blocked`.
  (The audit row's `payload=null` is just how DirectEventSink logs the audit
  event; the actual computed route was `blocked`.)

**Assessment: SMALL fix, folded into this PR (not a separate big investment).**

**Fix (`085eab2`):** `DirectEventSink.emitCompleted`, after computing the new
status and before the upsert, refuses to move a session already in a NO-OUT-EDGE
terminal state (`WORKFLOW_TRANSITIONS[status].length === 0` →
completed/terminated/shelved/approved) when the computed status differs — logs +
`return`s (no status change, no `decision_route` overwrite). Mirrors the HTTP
sink's `applyTransition` rejection. Verified safe: same-status re-completion
(FLY-208/210), `approved_to_ship`, `awaiting_review`, and all legit out-edges are
unaffected (they have out-edges / same status). Tests: the exact `bcaf491a` repro
+ all 4 terminal states. Codex incremental review APPROVED.

**(B) the false 583-file diff** on the no_code completion = the learning Runner's
worktree base (HEAD far off `origin/main`) — cosmetic (no_code → completed ignores
evidence) and NOT the flip cause. FLY-222 worktree-setup domain, not fixed here.

---

## Recommended follow-up issues (FLY / Flywheel)
1. **Finding I** — terminal-state immunity to pane-death re-emission (real bug).
2. **Finding E** — wire `TrustPromptHandler` into Runner spawn / seed trust flag (latent gap).
3. (already filed) **FLY-232** — `complete --route blocked` from `awaiting_review` silently rejected by FSM.
