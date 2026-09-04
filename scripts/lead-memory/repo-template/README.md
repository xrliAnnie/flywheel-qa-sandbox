# Lead memory repository

This private repository is the off-machine copy of Claude Lead memory. It has
one top-level folder per Lead. Every Lead can read the whole working tree, while
each ordinary commit may change only the acting Lead's folder.

The canonical working tree is `~/.claude/agent-memory`. Do not replace it with
a symlink and do not nest the repository at another path: Claude Code writes
Lead memory to this exact directory.

## Access model

- Repository visibility is private. GitHub access controls who can clone or
  read it.
- All Leads on the authorized machine use the same GitHub account and may read
  all twelve folders.
- `FLYWHEEL_LEAD_ID=<lead-name>` permits a staged commit only when every changed
  path is below `<lead-name>/`.
- The `prepare-commit-msg` hook adds exactly one
  `Memory-Owner: <lead-name>` trailer. The pre-push hook rechecks every new
  commit, refuses merges, branch deletion, non-fast-forward updates, missing or
  duplicate trailers, and any owner/path mismatch.
- `FLYWHEEL_MEMORY_ACTOR=sync` is for the automated A2 writer. It still permits
  only one Lead folder per commit and derives the owner from that folder.
- `FLYWHEEL_MEMORY_ACTOR=admin` is reserved for the first import and explicit
  repository-wide maintenance. Admin and sync allows must be written to the
  audit log or they fail closed.

Audit rows are stored at
`${FLYWHEEL_STATE_DIR:-$HOME/.flywheel}/state/lead-memory/audit.log`.

These hooks are accident guards and audit controls, not a server-side security
boundary. A process can deliberately bypass client hooks or claim the admin
actor. GitHub sees one account and cannot enforce directory-level write access
between Leads. CI independently detects invalid pushed commits and reports
admin commits, but it can only turn the push red after the bytes reach GitHub.

## Required tools

- Git and GitHub CLI (`gh`), authenticated for `xrliAnnie/lead-memory`
- Python 3
- gitleaks exactly `8.30.1` for bootstrap and every commit
- trufflehog exactly `3.97.2` for a first-import scan

There is no skip flag or environment-variable bypass for scanning or hook
installation.

## Bootstrap

For the first import, use the two explicit phases from the Flywheel checkout:

```sh
# Optional read-only fallback when the canonical directory cannot yet be written:
scripts/lead-memory/preflight-mirror.sh

scripts/lead-memory/first-import.sh --prepare
# Review every value-free finding and all 36 blob-bound sample rows.
scripts/lead-memory/first-import.sh --publish
```

`--prepare` accepts the normal starting state where `agent-memory` is an
ordinary child of the enclosing `~/.claude` repository. It creates a
repository at the exact target without changing existing Lead-folder bytes,
installs the canonical HTTPS origin and `.githooks`, adds exactly one
`agent-memory/` ignore line to the enclosing repository, and performs the
immutable dual scan. It never commits or pushes. `--publish` reruns the entire
scan, requires all finding dispositions and three current-blob sample reviews
per Lead, proves the staged twelve-folder tree equals the terminal scanned
tree, then creates and pushes the admin-owned root commit. The first push
creates `main`; the script then sets and verifies it as GitHub's default branch
and re-verifies private visibility.

`preflight-mirror.sh` never initializes or writes the canonical source. It
copies it into a mode-private temporary directory, runs the same immutable
dual scan, preserves the value-free ledger in private Flywheel state, and
deletes the sensitive mirror on exit. It is preliminary evidence only;
`--publish` always rescans the exact staged source tree.

The private prepare and publish receipts are stored below
`${FLYWHEEL_STATE_DIR:-$HOME/.flywheel}/state/lead-memory/first-import/`.
If a read-only mirror review produced the private value-free
`state/lead-memory/preflight/manual-review.tsv`, `--publish` applies its 36
decisions only when every path and blob OID still matches the terminal scan;
one changed sample fails closed instead of inheriting the earlier review.
Before a successful push, rollback removes only the target-owned `.git`; remove
the enclosing `agent-memory/` ignore line only when `prepare.txt` records that
the line did not predate the run. Never delete the twelve Lead folders.

On another machine, run the Flywheel copy of the bootstrap script:

```sh
scripts/lead-memory/bootstrap.sh --clone
```

The clone is built in a private sibling directory first. Only a successful,
validated clone is swapped into the canonical path. If an old memory directory
exists and its working-tree content differs from the repository snapshot, the
script warns that the directory may contain newer live state and requires the
operator to type `REPLACE` before any swap. EOF or any other response cancels,
removes the temporary clone, and leaves the old directory unchanged. An
approved replacement preserves the old directory as
`agent-memory.pre-clone-<UTC>-<pid>`; it does not merge the two trees. A failed
swap restores the preserved directory. A machine without a Flywheel checkout
can first make an authorized temporary clone, then run that clone's
`bootstrap.sh --clone`.

## First-import secret review

Run from the Flywheel checkout:

```sh
scripts/lead-memory/scan.sh "$HOME/.claude/agent-memory"
```

The scanner stages the twelve Lead folders, reconstructs one synthetic Git
tree, materializes that immutable tree in a private state directory, and scans
the snapshot with both tools. Each run first plants eight deterministic,
format-valid controls and requires every expected gitleaks and TruffleHog
mapping. A zero-result run without passing controls is not accepted.

Private raw reports live below
`${FLYWHEEL_STATE_DIR:-$HOME/.flywheel}/state/lead-memory/scan/<UTC-date>/<run-id>/`.
`SCAN-LEDGER.md` contains only value-free fingerprints. Review each result:

- A real credential must be rotated and removed or replaced with a redaction;
  it must disappear from the next full scan.
- A gitleaks false positive must be added to `.gitleaksignore` using the real
  report fingerprint and documented in the ledger.
- A retained TruffleHog result must have a value-free `false-positive:` or
  `non-secret:` disposition, reviewer, and date in the ledger.
- Review the three generated sample paths for every Lead folder and fill in a
  `reviewed: <short conclusion>` disposition, reviewer, and date. Each review
  row includes the exact Git blob OID. If that file changes, the next scan
  resets its row to `REVIEW_REQUIRED` instead of carrying a stale review
  forward.

After any remediation, rerun the complete scan. The import is allowed only when
gitleaks has zero raw findings, every current TruffleHog result has a permitted
reviewed disposition, no historical result remains pending, and the staged
twelve-folder synthetic tree still equals the terminal scan tree.

## Ordinary Lead write

```sh
cd "$HOME/.claude/agent-memory"
./write-memory.sh
```

The Lead environment supplies `FLYWHEEL_LEAD_ID`. `write-memory.sh` is the only
ordinary write entry point. It takes the repository's retained kernel writer
lock, waits up to 660 seconds for an automated writer, and bounds its own Git
sequence to 600 seconds. It uses non-interactive Git, commits only that Lead's
folder, preserves another actor's staged paths, runs every hook and scan, and
returns success only when a fresh remote read says `main` contains the current
commit. Before mutation it also requires the canonical private origin, branch
`main`, and no in-progress rebase. A noncanonical origin is status 10; an unsafe
branch/rebase state is fail-closed status 6. Status 75 means deferred: leave the
local memory in place and retry. Do not set another Lead's ID and do not use
`--no-verify`.

## A2 automation (FLY-2146)

The Flywheel checkout implements the A2 contract in
`scripts/lead-memory/sync.sh`:

1. Its first remote mutation is a bounded fetch. A failed fetch forbids rebase
   and push in that run.
2. It scans only valid top-level Lead folders and performs one explicit-path
   `commit --only` per changed folder. Commit verification rejects merges,
   cross-folder paths, or a wrong `Memory-Owner` trailer.
3. Each hook-bearing automated commit and push declares
   `FLYWHEEL_MEMORY_ACTOR=sync`; the hooks and gitleaks still run.
4. The sync actor cannot create or publish an admin-owned commit.
5. Audit, hook, scan, rebase, fetch, and push results stay distinct. In
   particular, status 7 means the bytes arrived remotely even though a remote
   command returned nonzero; that command failure is not hidden as success.
6. The terminal verdict always executes a new bounded `git ls-remote` and
   compares remote `main` with the frozen expected local SHA. Push output and
   local logs never set `arrived=true`.
7. Before rebase, staged or tracked-dirty paths anywhere in the repository
   defer publication with status 3. Pure untracked structural residue remains
   ignored because it does not prevent Git from rebasing.

The writer runs hourly at minute 17 under
`com.flywheel.lead-memory-sync`. It shares the same retained kernel lock with
`write-memory.sh`, waits 60 seconds, and caps the complete held-lock sequence at
600 seconds. Each non-contentious result writes a private
`last-receipt.json` and one `runs.tsv` row under
`${FLYWHEEL_STATE_DIR:-$HOME/.flywheel}/state/lead-memory/sync/`.

`scripts/lead-memory/arrival-check.sh` runs independently at minute 40 under
`com.flywheel.lead-memory-arrival-check`. It never trusts the writer's
`arrived` field or logs and never fetches. It reads remote `main` itself, ages
pending Lead memory, and maintains separate `stale`, `writer_silent`,
`unfetched`, `remote_unreachable`, and `structural` episodes. Notifications
contain no memory text or paths. A failed notification is persisted as
`post_status=failed` and returns status 10 so launchd can distinguish alert
delivery failure from a healthy observation.

The repository's `.github/workflows/remote-observe.yml` is the off-machine
daily witness. Only natural first-attempt `schedule` runs on `main` count.
From the Flywheel checkout, `freshness-report.sh --remote-observations` lists
those runs, `--freeze` binds a dedicated daily marker after day D's
observation, and `--check-visible` proves the marker absent in D's remote tree
and present in D+1's. Manual dispatch is only a workflow smoke test and never
counts toward the multi-day acceptance window.

## Deployment and retirement

After an approved Flywheel change is deployed, synchronize the repository
template and publish exactly `README.md`, `.github/workflows/remote-observe.yml`,
and executable `write-memory.sh` in one admin-owned commit. The two launchd
plists are byte-owned by the Flywheel launch-unit manifest and are installed by
the existing daemon convergence path.

Retirement is operator-only, audited, interactive, and limited to the two exact
production labels. From the Flywheel checkout run, once per label:

```sh
scripts/lead-memory/retire-units.sh --apply --i-am-operator \
  com.flywheel.lead-memory-sync
scripts/lead-memory/retire-units.sh --apply --i-am-operator \
  com.flywheel.lead-memory-arrival-check
```

The command proves byte identity, then disables, boots out, hard-link archives,
and identity-safely removes the installed plist. Disable must happen first:
otherwise normal convergence will copy and launch the unit again. To restore a
unit, first restore its source plist and manifest row, then run `--enable` for
the exact label and execute `scripts/lib/converge-nonlead-daemons.sh` through
the normal deployment convergence path.

## A2 recovery

If the scheduled receipt reports status 8, stop automated writes and inspect
the repository index and rebase state before retrying. A reason of
`interrupted_recovery_failed` means the interrupted writer could not remove
only its own staged paths; preserve the worktree and index for an operator.
Status 4 means a rebase failed but was aborted and restored. Status 5 means the
fresh remote observation did not contain the expected SHA. Status 6 is a
fail-closed preflight, while status 9 means the outcome evidence itself could
not be persisted. Never clear these by disabling hooks or rewriting history.

## Recovery

Before the first push, removing only the target-owned `.git` directory returns
the memory path to its prior shape. Remove the enclosing ignore entry only when
the private prepare receipt says it was not already present; memory files are
never deleted. After a push, repository removal or archival is a separate
GitHub owner action. Disabling `core.hooksPath` is an emergency local recovery
action only; CI continues to audit pushed history.
