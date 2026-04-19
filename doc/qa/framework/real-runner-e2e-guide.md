# Real Runner E2E Guide — FLY-115

**Audience**: Annie + QA agents
**When to read**: before running `scripts/test-deploy.sh` for the first time, and as a reference during QA.

---

## 1. Pre-flight checklist (once per machine)

All of the following must be true or `scripts/test-deploy.sh` will fail fast (exit 2) at pre-flight.

1. **Sandbox fork exists**:
   ```
   gh repo fork xrliAnnie/flywheel --fork-name flywheel-qa-sandbox --clone=false
   ```
   See `doc/qa/framework/sandbox-sync-guide.md` for ongoing sync.

2. **`gh` CLI authed with push access**:
   ```
   gh auth status
   gh api repos/xrliAnnie/flywheel-qa-sandbox --jq .permissions.push   # expect: true
   ```
   `test-deploy.sh` re-runs the `.permissions.push` check at preflight and fails
   fast (exit 2) if it's not `true` — Runner's `git push` + `gh pr create` flow
   depends on this.

3. **`~/.flywheel/.env` contains**:
   ```
   FLYWHEEL_SANDBOX_REMOTE_URL=git@github.com:xrliAnnie/flywheel-qa-sandbox.git
   ```

4. **`LINEAR_API_KEY` exported in shell** (already in `~/.zshrc` for prod).

5. **Sandbox `main` in sync** (see sandbox-sync-guide).

---

## 2. Push the branch under test to sandbox

Required for every QA run that uses `--from-branch <br>` (i.e., anything that isn't testing sandbox `main`):

```
git push git@github.com:xrliAnnie/flywheel-qa-sandbox.git <branch>:<branch>
```

If you skip this step, `test-deploy.sh` will fail at clone with a pointer back to this section.

---

## 3. Deploy a slot

```
scripts/test-deploy.sh --from-branch <branch> <N>
```

`<N>` is the slot number (1–4). `--from-branch` is optional; default is sandbox `main`.

On success, stdout is JSON with:

```
{
  "slot": 2,
  "fromBranch": "feat/v1.24.0-FLY-115-qa-real-runner-support",
  "sandbox": "xrliAnnie/flywheel-qa-sandbox",
  "hostRepo": "/tmp/flywheel-test-slot-2/project-slot-2",
  "tempBranch": "qa-slot-2-1712345678",
  "branchSha": "abcdef0123…",
  "runnerStartPoint": "refs/remotes/origin/feat/v1.24.0-FLY-115-qa-real-runner-support",
  "dbPath": "/tmp/flywheel-test-slot-2/teamlead.db",
  "bridgeLog": "/tmp/flywheel-test-slot-2/bridge.log",
  ...
}
```

Keep `branchSha` handy — you'll use it to verify the Runner worktree HEAD.

---

## 4. Inject a Linear issue

```
scripts/inject-linear-issue.sh <N> <FLY-XXX>
```

This POSTs to the slot's Bridge `/api/runs/start` and spawns a real Runner. The issue must exist in Linear (Bridge runs PreHydrator to verify).

Exit codes:

| Code | Meaning |
|------|---------|
| 0 | `/api/runs/start` accepted (200/201/202) |
| 2 | HTTP 404 — Linear reports the issue does not exist (bad ID spelling / not visible to this API key) |
| 3 | HTTP 409 — a run for this project/role is already live (FLY-59 dedup) |
| 4 | HTTP 502 — Linear API call failed (network / auth / Linear 5xx) |
| 5 | HTTP 503 — Bridge can't init PreHydrator (LINEAR_API_KEY missing from Bridge env) |
| 6 | Unexpected HTTP code — tail `${SLOT_DIR}/bridge.log` |

---

## 5. Observe

**Discord** — the test slot's bot posts session_started / completed / failed to its dedicated channel. Always check Chrome Discord end-to-end; API-level 200 is not a pass.

**SQLite**:

```
sqlite3 /tmp/flywheel-test-slot-<N>/teamlead.db \
  "SELECT id, project_name, role, status, worktree_path FROM sessions ORDER BY created_at DESC LIMIT 5"
```

Verifies FLY-108 S4 session chain. `worktree_path` should be under `/tmp/flywheel-test-slot-<N>/`.

**Runner tmux**:

```
tmux attach -t runner-test-slot-<N>
```

Live Runner pane.

**Bridge log**:

```
tail -f /tmp/flywheel-test-slot-<N>/bridge.log
```

Look for `[RunDispatcher] ran in worktree <path>`.

**Runner worktree HEAD**:

FLY-95 worktrees are created as siblings of the slot's host clone. The host
clone basename is slot-unique (`project-slot-<N>`) so two slots running the
same issue don't push the same branch name to the sandbox remote. Concrete
path: `/tmp/flywheel-test-slot-<N>/project-slot-<N>-<ISSUE>`.

```
git -C /tmp/flywheel-test-slot-<N>/project-slot-<N>-<ISSUE> rev-parse HEAD
```

Must equal the deploy output's `branchSha`. If it equals sandbox `origin/main` instead, the §3.1 env hook is not wired — tail `bridge.log` for `FLYWHEEL_RUNNER_START_POINT`.

**Sandbox PRs**:

```
gh pr list -R xrliAnnie/flywheel-qa-sandbox
```

---

## 6. Teardown

```
scripts/test-teardown.sh <N>
```

Order of operations (test-teardown.sh):

1. Kill Runner tmux (`runner-test-slot-<N>`).
2. Kill Lead supervisor, wait, SIGKILL fallback.
3. Kill Lead tmux window.
4. Delete session-id file.
5. Kill Bridge process.
5b. Remove every FLY-95 Runner worktree under `/tmp/flywheel-test-slot-<N>/` (sibling of `project-slot-<N>`), delete slot-local branches, `git worktree prune`.
6. `rm -rf /tmp/flywheel-test-slot-<N>` + `~/.flywheel/comm/test-slot-<N>/` + Lead workspace.
7. Release slot lock.

Sandbox remote branches are NEVER touched. If the Runner pushed a branch + opened a PR, those live until you explicitly clean them up (step 7 below).

---

## 7. (Optional) Clean up sandbox remote branch

```
git push git@github.com:xrliAnnie/flywheel-qa-sandbox.git :<branch>
```

Close stale PRs on sandbox:

```
gh pr list -R xrliAnnie/flywheel-qa-sandbox --state open
gh pr close <number> -R xrliAnnie/flywheel-qa-sandbox
```

---

## 8. Troubleshooting quick map

| Symptom | Likely cause | Next step |
|---------|--------------|-----------|
| Pre-flight exit 2: "LINEAR_API_KEY not set" | Shell env missing key | `export LINEAR_API_KEY=...` (or fix `~/.zshrc`) |
| Pre-flight exit 2: "gh CLI not authenticated" | gh token expired | `gh auth refresh` |
| Pre-flight exit 2: "sandbox repo missing" | Fork not created | `gh repo fork xrliAnnie/flywheel --fork-name flywheel-qa-sandbox --clone=false` |
| Pre-flight exit 2: "preflight failed (...rebuild...)" | `better-sqlite3` build or edge-worker tsc failed under preflight lock | `pnpm -r install`, then re-run deploy |
| Pre-flight exit 2: "no push permission on ..." | gh token lacks push scope on sandbox, or fork owned by a different account | `gh auth refresh -s repo`, confirm `gh api repos/<slug> --jq .permissions.push` returns `true` |
| Pre-flight exit 2: "preflight lock busy > 300s" | Stale `/tmp/flywheel-qa-rebuild.lock` from a crashed deploy | Check holder PID in `${lock}/pid`; if dead, `rm -rf /tmp/flywheel-qa-rebuild.lock` |
| Inject exit 2 (404) | Linear reports the issue doesn't exist | Check ID spelling; confirm the issue is visible to the LINEAR_API_KEY's workspace |
| `git clone --branch <br>` fails | Branch not pushed to sandbox | `git push git@github.com:xrliAnnie/flywheel-qa-sandbox.git <br>:<br>` |
| Inject exit 3 (409) | Previous run still live | `scripts/test-teardown.sh <N>` and redeploy, or wait for session to end |
| Inject exit 4 (502) | Linear API call failed (network / auth / Linear 5xx) | Check LINEAR_API_KEY on Bridge env, network reachability to linear.app, and Linear status |
| Inject exit 5 (503) | LINEAR_API_KEY missing on Bridge env | Redeploy the slot |
| Runner worktree HEAD == sandbox origin/main instead of branchSha | §3.1 env hook not wired | Confirm `FLYWHEEL_RUNNER_START_POINT` in Bridge env; verify `dist/WorktreeManager.js` contains the env var string |
| `runner-test-slot-<N>` tmux didn't start | TmuxAdapter error | `tail /tmp/flywheel-test-slot-<N>/bridge.log` |

---

## 9. Cross-references

- Sandbox lifecycle: `doc/qa/framework/sandbox-sync-guide.md`
- Plan: `doc/engineer/plan/inprogress/v1.24.0-FLY-115-qa-real-runner-support.md`
- Scripts: `scripts/test-deploy.sh`, `scripts/test-teardown.sh`, `scripts/inject-linear-issue.sh`
- Runner start point hook: `packages/edge-worker/src/WorktreeManager.ts`
