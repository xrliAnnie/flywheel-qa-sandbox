# Sandbox Sync Guide — `xrliAnnie/flywheel-qa-sandbox`

**Audience**: Annie (operator)
**When to read**: before any ship-blocking QA run; after non-trivial changes to `flywheel` `main`.

---

## 1. Why a sandbox fork

Real-Runner QA (FLY-115) needs a push target that:

1. The test Runner can safely `git push` + `gh pr create` against without polluting the real `xrliAnnie/flywheel` history.
2. Has a `main` that matches production closely enough that spin.md, worktree setup, and build steps behave the same as prod.

`xrliAnnie/flywheel-qa-sandbox` is that fork.

---

## 2. One-time setup

Done once per machine / account. Pre-deploy checklist in `scripts/test-deploy.sh` fails with a pointer back here if this is missing.

```
gh repo fork xrliAnnie/flywheel --fork-name flywheel-qa-sandbox --clone=false
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

GitHub can sync a fork from its upstream branch-for-branch with a single API call. For the default branch:

```
gh repo sync xrliAnnie/flywheel-qa-sandbox --source xrliAnnie/flywheel --branch main
```

This is a fast-forward merge on GitHub's side. No clone, no rebase required.

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

**Sync reports conflicts**
`gh repo sync` will refuse to force-merge. If sandbox `main` has diverged (it shouldn't — no one should be committing to sandbox), reset it to the upstream ref explicitly:

```
git clone git@github.com:xrliAnnie/flywheel-qa-sandbox.git /tmp/sandbox-reset
cd /tmp/sandbox-reset
git fetch origin
git remote add upstream git@github.com:xrliAnnie/flywheel.git
git fetch upstream
git reset --hard upstream/main
git push --force origin main
rm -rf /tmp/sandbox-reset
```

This is destructive to sandbox `main` history — it's fine because sandbox has no independent history of record; it's a throwaway mirror.

**`gh` auth expired**

```
gh auth refresh
```

**`gh repo sync` not available**

Upgrade `gh`: `brew upgrade gh`. Minimum version supporting `gh repo sync` is 2.8.

---

## 6. Cross-references

- Pre-deploy checklist + per-branch push: `doc/qa/framework/real-runner-e2e-guide.md`
- `test-deploy.sh` pre-flight that depends on this fork being present: `scripts/test-deploy.sh` §4.2
- FLY-115 plan: `doc/engineer/plan/inprogress/v1.24.0-FLY-115-qa-real-runner-support.md`
