# Runbook: a project's runner won't start (`No runtime` / `project_unknown`) — FLY-534

**Issue**: FLY-534 (Bridge rejects `POST /api/runs/start` for a project — runner can't start)
**Date**: 2026-06-24
**Status**: ships with the FLY-534 projectName case-normalization fix

## What FLY-534 actually was

`POST /api/runs/start {projectName:"Sub"}` failed for project `sub`. Root cause
(confirmed by a dual-casing probe, see below): **projectName lookups were
case-SENSITIVE**. The caller sent `"Sub"`; config + cron use the canonical
`"sub"`. Every lookup on the runs path — the dispatcher's
`blueprintsByProject.get(name)`, the dept-scope / lead-scope `=== projectName`,
the CommDB path, the tmux session name — missed on the casing, surfacing as
`DEPT_SCOPE_REJECT project_unknown` (uppercase reaches dept-scope first) or
`No runtime for project: <name>`.

`sub` was **never dropped** from the dispatcher — every Bridge startup logs
`N/N project(s) ready` with no `Skipping runtime`. This was a casing bug, not a
lost registration.

**The fix** canonicalizes `projectName` once at the `runs-route` boundary
(`resolveCanonicalProjectName`), so any casing resolves to the configured exact
name and flows consistently to every downstream surface. After it ships,
`"Sub"`/`"SUB"`/`"sub"` all work.

## Step 1 — diagnose: is it casing, or a genuinely-missing runtime?

### Safe self-check probe (zero side effects — does NOT start a runner)

Use a **real** project issue + a deliberately **invalid** `agentName`. The route
runs `validateAgentName` (zero side effects) before any `start()`:

```bash
TOKEN=$(grep -E '^export TEAMLEAD_API_TOKEN=' ~/.flywheel/.env | cut -d= -f2-)
probe() {  # probe <projectName-casing> <real-issue-UUID>
  curl -s -w '\n[HTTP %{http_code}]\n' -X POST http://127.0.0.1:9876/api/runs/start \
    -H 'Content-Type: application/json' -H "Authorization: Bearer ${TOKEN}" \
    -d "{\"issueId\":\"$2\",\"projectName\":\"$1\",\"leadId\":\"$1-lead\",\"agentName\":\"__probe_invalid__\"}"
}
probe sub <real-sub-issue-UUID>   # lowercase / canonical
probe Sub <real-sub-issue-UUID>   # the caller's casing
```

Interpretation:

| Response | Meaning |
|----------|---------|
| `400 INVALID_AGENT_NAME` + `available:[...]` | runtime resolved — this casing is fine |
| `DEPT_SCOPE_REJECT` `project_unknown` (uppercase) | **casing mismatch** (the FLY-534 bug) — fixed by this PR; pre-fix workaround: use the canonical lowercase name |
| `404 "Project \"X\" is not registered with the Bridge runtime"` | runtime genuinely missing (rare — see Step 2) |
| `404 "Issue ... not found"` | not a real issue for that project — use a real one |
| `409 ... already has an active session` | that issue has an active session — use one without |
| `429 ... admission deferred` | load too high — retry when load drops |

> Why a **real** issue: the route validates the Linear issue + dept-scope BEFORE
> `validateAgentName`. A fake UUID dies at the Linear check and never reveals
> runtime state.

### Also confirm from the startup log

```bash
grep -aE "project\(s\) ready|<project> ready|RuntimeRegistry: [0-9]|Failed to setup" /tmp/flywheel-bridge.log | tail -10
```

Expect `<project> ready` + `N/N project(s) ready` with no `Failed to setup`.

## Step 2 — genuinely-missing runtime (rare; the latent FLY-538 case)

If the probe shows the canonical-cased name returns `not registered` AND the
startup log shows `Failed to setup <project>` / a gap in `N/N ready`, the
project's setup threw at startup and was skipped (the latent risk tracked by
**FLY-538** — has never been observed in production). Recover by restarting the
central Bridge so `setupRunInfrastructure` rebuilds the dispatcher map:

```bash
launchctl kickstart -k gui/$(id -u)/com.flywheel.bridge
```

**Safe for parked / awaiting_review runners** (their state is persistent in
`~/.flywheel/teamlead.db`; startup prune/scrub only touches non-running /
non-awaiting_review sessions; Bridge restart does NOT restart Leads/runners).
Blinks the central Bridge ~30s for ALL projects — **coordinate the restart
timing with the Eng Lead first**, and stop the Bridge with precise targeting
(port + run-bridge process tree, FLY-239), never a bare pattern sweep.

## Related

- **FLY-538** — defense-in-depth: auto-retry a project whose setup throws at
  startup (so Step 2's manual kickstart becomes unnecessary). Latent / never
  triggered.
- **FLY-540** — cron tick wait+retry, for the orthogonal risk of a daily-loop
  tick firing during a Bridge restart window (neither casing nor FLY-538 covers
  that — the Bridge isn't accepting during the window).
