# Sandbox Sync Guide — `xrliAnnie/flywheel-qa-sandbox`

**Audience**: Annie (operator)
**When to read**: before any ship-blocking QA run; after non-trivial changes to `flywheel` `main`.

---

## 1. Why a sandbox repo

Real-Runner QA (FLY-115) needs a push target that:

1. The test Runner can safely `git push` + `gh pr create` against without polluting the real `xrliAnnie/flywheel` history.
2. Has a `main` that matches production closely enough that spin.md, worktree setup, and build steps behave the same as prod.

`xrliAnnie/flywheel-qa-sandbox` is a **standalone repo** seeded from flywheel main. GitHub does not allow a user to fork their own repo to the same account, so the sandbox is not a true fork — it's an independent repo kept in sync manually (§3).

---

## 2. One-time setup

Done once per machine / account. Pre-deploy checklist in `scripts/test-deploy.sh` fails with a pointer back here if this is missing.

> **Note**: GitHub does NOT allow a user to fork their own repo to the same account. So sandbox is a **standalone repo seeded from flywheel main**, not a true fork. The QA test flow is identical — only the sync mechanism differs (see §3).

```
gh repo create xrliAnnie/flywheel-qa-sandbox --public --description "FLY-115 QA sandbox for real-Runner E2E"
git clone git@github.com:xrliAnnie/flywheel.git /tmp/sandbox-seed
cd /tmp/sandbox-seed
git remote set-url origin git@github.com:xrliAnnie/flywheel-qa-sandbox.git
git push origin main
cd - && rm -rf /tmp/sandbox-seed
gh auth status
gh api repos/xrliAnnie/flywheel-qa-sandbox --jq .permissions.push   # expect: true
```

Add to `~/.flywheel/.env`:

```
FLYWHEEL_SANDBOX_REMOTE_URL=git@github.com:xrliAnnie/flywheel-qa-sandbox.git
```

`LINEAR_API_KEY` is already expected in the shell env (exported via `~/.zshrc` for prod). `test-deploy.sh` re-verifies it at preflight.

---

## 3. Sync flow

Since sandbox is a standalone repo (not a fork), `gh repo sync` does NOT work. Use manual git fetch + force push:

```
git clone git@github.com:xrliAnnie/flywheel-qa-sandbox.git /tmp/sandbox-sync
cd /tmp/sandbox-sync
git remote add upstream git@github.com:xrliAnnie/flywheel.git
git fetch upstream main
git reset --hard upstream/main
git push --force origin main
cd - && rm -rf /tmp/sandbox-sync
```

This is destructive to sandbox `main` history — it's fine because sandbox has no independent history of record; it's a throwaway mirror.

---

## 4. When to sync

| Event | Sync? |
|-------|-------|
| Before a ship-blocking QA run | ✅ always |
| After a substantial `main` merge that touches Bridge / Lead / Runner / spin.md | ✅ |
| Opportunistically (weekly cadence is fine) | ✅ |
| Running QA on a feature branch and only care about the branch content | ❌ not required; `--from-branch <br>` pins the clone to the branch ref |

If the real-Runner E2E guide's §2 ("push the branch under test to sandbox") is always respected, sandbox `main` drifting behind is rarely the cause of a failed QA run. But sync before ship-gated runs as a matter of hygiene.

---

## 5. Troubleshooting

**Sync reports conflicts or push rejected**
The §3 procedure uses `--force` so conflicts shouldn't occur. If force-push is rejected (branch protection on sandbox `main`), disable the rule: `gh api repos/xrliAnnie/flywheel-qa-sandbox/branches/main/protection -X DELETE`. Sandbox has no independent history of record — protection is not useful.

**`gh` auth expired**

```
gh auth refresh
```

---

## 6. Cross-references

- Pre-deploy checklist + per-branch push: `doc/qa/framework/real-runner-e2e-guide.md`
- `test-deploy.sh` pre-flight that depends on this fork being present: `scripts/test-deploy.sh` §4.2
- FLY-115 plan: `doc/engineer/plan/inprogress/v1.24.0-FLY-115-qa-real-runner-support.md`
