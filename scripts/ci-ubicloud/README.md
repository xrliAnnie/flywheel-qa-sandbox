# FLY-2746 runner variable runbook

FLY-2793 retired the manual Ubicloud canary and its trial collector. This file
now documents only the existing `CI_RUNNER` and `SHIP_RUNNER` controls. It does
not authorize changing either repository variable, dispatching a release, or
merging a pull request.

## Separate CI and ship controls

Every job in `ci.yml` uses `${{ vars.CI_RUNNER || 'ubuntu-latest' }}` and every
job in `ship-on-comment.yml` uses
`${{ vars.SHIP_RUNNER || 'ubuntu-latest' }}`. The two controls are deliberately
separate: `issue_comment` workflows load from the default branch, and no
`ci.yml` job proves the ship path's hard dependencies (`gh`, `jq`, `timeout`,
and `actions/github-script`) on another runner.

Missing or empty variables resolve to `ubuntu-latest`; an unknown nonempty
value is an operator error and does not silently fall back. Required check
names, merge/ship gates, and branch protection are unchanged.

A read-only check on 2026-09-22 found both repository variables set to
`ubicloud-standard-2` (`CI_RUNNER` at 03:00:25Z and `SHIP_RUNNER` at 03:45:05Z).
That snapshot is evidence, not authority to change either value. Never infer
one control's state from the other; any authorized rollback must handle and
read back each control independently.

The Lead owns all repository-variable writes and must read each value back.
For example, an authorized `CI_RUNNER` change is not complete until the exact
value is returned:

```sh
gh variable set CI_RUNNER --repo xrliAnnie/flywheel --body ubicloud-standard-2
test "$(gh variable get CI_RUNNER --repo xrliAnnie/flywheel)" = ubicloud-standard-2
```

Rollback affects only future scheduling. Delete the variable, prove it is
absent, cancel queued runs already bound to the old selection, and create a
fresh PR or labeled event. Never use a rerun as rollback evidence:

```sh
gh variable delete CI_RUNNER --repo xrliAnnie/flywheel
repo_variables="$(gh variable list --repo xrliAnnie/flywheel --json name --jq '.[].name')"
if printf '%s\n' "$repo_variables" | grep -Fxq CI_RUNNER; then
  printf '%s\n' 'CI_RUNNER still exists after rollback' >&2
  exit 1
fi

gh run list --repo xrliAnnie/flywheel --status queued --limit 100 \
  --json databaseId --jq '.[].databaseId' |
while IFS= read -r queued_run_id; do
  queued_ubicloud_jobs="$(
    gh api --paginate \
      "repos/xrliAnnie/flywheel/actions/runs/$queued_run_id/jobs?filter=all&per_page=100" \
      --jq '[.jobs[] | select(.status == "queued" and (.labels | index("ubicloud-standard-2")))] | length'
  )"
  if [ "$queued_ubicloud_jobs" -gt 0 ]; then
    gh run cancel "$queued_run_id" --repo xrliAnnie/flywheel
  fi
done
```

Policy permits `SHIP_RUNNER` to be set only after the target runner has an
independent receipt for `gh --version`, `jq --version`, `timeout --version`,
and one `actions/github-script@v7` step. Changing `CI_RUNNER` alone must never
be treated as changing or rolling back the ship path.
FLY-2793 did not audit or recreate that prerequisite receipt; its existence is
outside this cleanup's evidence.

Full acceptance evidence is a fresh exact-head `CI OK`. `CI Scope OK`, a reused
green run, or a rerun that did not reread the variable is not full evidence.
