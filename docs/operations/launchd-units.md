# Launchd unit operations

This runbook is the operational contract for Flywheel launchd units on macOS.
It separates local desired-state declaration, live-host census, fleet capture,
and explicit operator decisions. None of the commands below should be turned
into a batch enable or automatic zombie deletion path.

## Authority and delivery

[`scripts/launchd/units.manifest`](../../scripts/launchd/units.manifest) is the
local declaration used by convergence and census. It is a five-column TSV:

| Field | Meaning |
| --- | --- |
| `label` | Exact internal launchd `Label`; this is identity authority, not the plist filename. |
| `plist_source` | Repo plist basename, or `-` when another installer owns generation/delivery. |
| `policy` | One of `copy`, `setup`, `external`, `managed`, or `hold`. |
| `allowed_exit_codes` | Comma-separated accepted last-exit values, or `*` for informational external jobs. |
| `note` | Operator-readable ownership or exception evidence. |

The header has exactly one `host-prefix` and one or more `census-scope` rows.
`host-prefix` is the expected checkout prefix used when interpreting installed
program targets. Each `census-scope` is an owned label prefix for reverse
inventory; active plists in those namespaces are visible even when the manifest
forgot them. Keep scopes narrow enough that Flywheel does not claim unrelated
user agents.

Policies have distinct delivery semantics:

- `copy`: the repo plist is byte authority. Convergence may stage, validate,
  atomically install, and bootstrap it. Installed byte drift is anomalous.
- `setup`: a dedicated setup path generates or installs the plist. Convergence
  reports a missing setup-owned unit but does not invent its payload.
- `external`: Flywheel records and observes a separately owned unit. It enters
  the expected denominator only when an active plist is installed.
- `managed`: another lifecycle owns the unit. Flywheel must never bootstrap it;
  seeing it loaded is an anomaly.
- `hold`: intentionally not running. It is counted and named, but convergence
  performs no install, enable, or bootstrap action.

To deliver a new unit, first choose its owner. A repo-owned static plist belongs
under `scripts/launchd/` with a `copy` manifest row; a generated or credentialed
unit needs a named setup path and a `setup` row. Add its allowed exit behavior,
extend manifest/census tests, and run the five FLY-1814 CI suites before using
the normal restart/setup path on a host. Merely copying a plist to
`~/Library/LaunchAgents` is not delivery: the internal Label, program target,
enabled bit, domain state, and manifest declaration all have to agree.

The local declaration is intentionally different from
`fleet/manifest.json .launchdJobs[]`. `units.manifest` drives local convergence
and census policy. Fleet capture records installed `com.flywheel.*.plist` labels
as `lead` or `aux`; that JSON is capture/provision input used to narrate or
reproduce a host. It does not replace the local policy, exit-code, source, or
hold authority.

## Census and convergence

The same library exposes mutating non-Lead convergence and a read-only,
bidirectional census. It runs on three existing anchors, with no new timer or
daemon:

1. A normal full restart wave converges eligible non-Lead units, then records
   the census summary and details in restart evidence.
2. The updater's existing calendar/manual fallback supplies the 12-hour floor;
   it runs convergence and census before fetch/dirty-check exits unless a
   restart transaction is active.
3. Every production Lead start runs the read-only census child. Dry-run and
   `flywheel-test-*` Lead identities are excluded.

An anomaly alert uses the already registered `deploy_degraded` kind with
`--lead updater`, warning severity, no founder mention, and signature
`launchd-census-YYYYMMDD-<anomaly-set-sha256-16>`. The hash input is the sorted,
deduplicated set of actionable `category:name` pairs, and the signature uses its
first 16 hex characters; informational evidence is excluded. All three anchors
therefore deduplicate the same anomaly set rather than producing one alert per
Lead, while a different anomaly discovered later the same day still receives
its own delivery receipt.

Read `launchd: ...` as a denominator summary, then use `launchd-detail: ...` for
names. The summary currently reports:

```text
expected loaded converged skipped_disabled hold drift zombie unverifiable
live_failure informational_exit lead=loaded/expected manifestless
lead_disabled expected_unloaded managed_loaded unmanaged instrument_suspect
```

The actionable anomaly total is `expected_unloaded + managed_loaded + drift +
zombie + unverifiable + live_failure + lead_unloaded`. `skipped_disabled`,
`hold`, `informational_exit`, and `unmanaged` remain visible but do not by
themselves page. Interpret the main findings as follows:

- `expected_unloaded`: declared, enabled work is absent from the domain.
- `drift`: a `copy` plist differs from repo byte authority.
- `zombie`: an owned active plist resolves to a missing program target.
- `unverifiable`: identity, program, manifest, or probe output could not be
  proven safely; do not convert this to absence.
- `live_failure`: the last exit is outside the row's allowed contract.
- `managed_loaded`: a unit that Flywheel is forbidden to launch is loaded.
- `instrument_suspect=1`: `print-disabled`, `launchctl list`, or its positive
  control was unreliable. Negative absence findings are suppressed; repair the
  instrument/probe before acting on apparent dropouts.

The Lead denominator comes from the restart lifecycle candidate authority plus
active Lead-plist complements. Invalid identities, QA/test slots, and explicitly
disabled Leads are excluded (`lead_disabled` remains visible); manifestless live
Leads are counted separately. `lead=A/B` means B expected production Leads and A
proven loaded, not simply the number of plist files on disk.

## Canonical retirement

Retirement is one operation with three required parts:

1. `launchctl bootout gui/$UID/<label>` and prove the label is absent;
2. move the exact active plist to
   `~/Library/LaunchAgents/retired-YYYYMMDD/` without overwrite; and
3. delete its `units.manifest` row, or change policy to `hold` when the decision
   is to preserve a declared but intentionally inactive unit.

`launchctl disable` alone is **not retirement**. It leaves the installed payload
and identity in place and is why deliberately disabled rows are counted rather
than silently treated as gone. Do not delete retired plists; the dated move is
the rollback/audit evidence.

## Explicit operator tools

Both FLY-1814 tools default to dry-run. Dry-run is safe in a non-interactive
shell, performs no mutation, sends no audit, and prints the exact intended
target and commands. Apply requires both an interactive stdin/stdout TTY and
the literal `--i-am-operator` flag. Before the first mutation, the tool sends an
audit through `lead-alert.sh --strict-delivery` using the registered
`deploy_degraded`/updater route and continues only on exact `sent` delivery
confirmation. There is never a founder mention. A queue, dead letter,
configuration error, unconfirmed duplicate, TTY failure, or identity mismatch
means no mutation.

The audit signature is the UTC day plus a portable SHA-256 of the canonical
intent: action, label, exact decision row/target, prior disabled/domain state,
and the archive destination or other mutation-driving paths/state. Retrying the
identical action and pre-state on the same day therefore reuses its correlation
identity; strict delivery may return the existing durable `sent` receipt. A
changed decision, target, pre-state, or destination has a different signature
and must be delivered independently. A same-intent retry that receives an
unconfirmed duplicate or any result other than exact `sent` still fails closed;
deduplication never substitutes for delivery proof.

### Retire the exact qa528 zombie

Preview only:

```bash
bash scripts/fly1814-cleanup-zombie.sh
```

After reviewing its Label, resolved missing temporary target, remaining
references, domain state, and archive path, an operator may explicitly apply:

```bash
bash scripts/fly1814-cleanup-zombie.sh --apply --i-am-operator
```

The script is hardcoded to
`com.xiaohongshu-deep-learning.qa528`. It accepts only an active plist whose
internal Label matches exactly and whose ProgramArguments resolve to the
missing `/var/folders/.../T/.../com.xiaohongshu-deep-learning.qa528-scheduled.sh`
shape observed in the incident: exactly two characters below `folders`, one
temporary segment, `T`, one temporary segment, and the exact filename, with no
empty, dot, traversal, or extra-depth segments. It reports references before
archiving and fails closed if that scan is incomplete. Apply revalidates the
active regular non-symlink plist, Label, exact resolved missing target, safe
archive directory, and absent destination after the audit and immediately
before bootout. It also re-probes the signed launchd domain state after audit;
any difference from the audited pre-state aborts before directory creation,
bootout, archive publication, or compensation.

Archive publication uses an atomic same-filesystem create-if-absent link before
removing the active name, so a raced destination is never overwritten. The
transaction captures device/inode identity, proves the source and archive are
the same exact expected plist before unlink, and rechecks that identity before
every rollback restore/use/removal. The original audited source inode remains
rollback authority even if archive publication never succeeds: a foreign
same-payload active plist is preserved but is never bootstrapped or reported as
restored. If another actor replaces the archive path,
the tool neither uses nor deletes those operator bytes and reports
`rollback-failed`. Likewise, a same-Label/same-target active plist is not enough
to authorize rollback: it must retain the captured archive inode and remain the
same file as the owned archive link. A foreign active replacement and the owned
archive are both preserved, with no bootstrap or deletion. A newly created dated
directory is also identity-owned and is removed on rollback only while still
empty and unchanged. If publication,
source removal, or the final absence probe fails after bootout, the tool restores
the active name, removes only its proven archive link, and bootstraps the
original only when it was loaded before the attempt. A verified restoration is
reported separately from `rollback-failed`, which requires operator attention.
Already absent/retired or already unloaded states are honest idempotent outcomes;
changed identity, a live/replaced target, probe uncertainty, or an archive
collision fails closed.

### Decide and recover one auxiliary label

[`scripts/launchd/fly1814-aux-decisions.tsv`](../../scripts/launchd/fly1814-aux-decisions.tsv)
is the approval artifact. Its fields are label, status, `approved_target`,
purpose, provenance, recommendation, and evidence. `approved_target` records the
exact payload resolved from the installed plist when this checklist was
created; approval covers that label/target pair, not merely the label. All eight
rows initially remain `pending`:

| Label | Provenance |
| --- | --- |
| `com.flywheel.growth-improve` | `bak-fly886` |
| `com.flywheel.growth-learn` | `bak-fly886` |
| `com.flywheel.growth-report` | `bak-fly886` |
| `com.flywheel.growth-retro` | `bak-fly886` |
| `com.flywheel.sub-create-nightly` | `bak-fly886` |
| `com.flywheel.sub-daily-loop` | `bak-fly886` |
| `com.flywheel.skills-update` | `unknown` |
| `com.flywheel.token-usage-daily` | `unknown` |

Annie's per-row checkbox is recorded by changing only that row's `status` from
`pending` to `approved` or `hold`, with recommendation/evidence updated to the
decision. Before approving, compare `approved_target` with the intended payload;
if the payload legitimately changes, update that target and evidence as part of
the approval review. Approval is per label and exact target: never approve or
execute the eight as a batch.
Preview a selected row and its live state with:

```bash
bash scripts/fly1814-enable-aux-job.sh com.flywheel.growth-learn
```

Only an explicitly `approved` row can pass apply:

```bash
bash scripts/fly1814-enable-aux-job.sh com.flywheel.growth-learn \
  --apply --i-am-operator
```

The exact allowlist is the eight rows above. Apply uses the production plist
resolver, requires a resolved existing target equal to `approved_target`, and
prints it with the prior disabled/domain state. Immediately after the exact
audit receipt it rereads the decision artifact and requires the selected row to
be byte-identical, still `approved`, and bound to the same target. It then
revalidates the active plist, internal Label, resolved target, and target
existence, then re-probes both signed disabled-override and domain states. Any
pre-state drift aborts without enable, bootstrap, or compensation. Only then
does it enable `gui/$UID/<label>`. It bootstraps that
exact plist only if unloaded, re-probes loaded/enabled state, and reports
before/after evidence. If an enable/bootstrap/final-probe attempt fails, it
restores and verifies the prior override/domain state; `rollback-failed` is a
distinct operator-attention outcome. An already-enabled label is never disabled
as invented compensation. Already enabled and loaded is an audited idempotent
success. `pending` and `hold` refuse mutation.
For a `hold` decision, update the corresponding `units.manifest` policy to
`hold`; the operator tool deliberately never edits manifest policy for you.

After each approved recovery, run the census and verify the selected label left
`skipped_disabled`; after qa528 retirement, verify `zombie=0` for that label.

## Restart timing and rollback

Normal deployment calls the Lead restart wave in `stagger` mode: four restart
attempts per batch with a 60-second pause before the next batch, while successful
Lead verification timing is appended to completion evidence. Emergency rollback
calls the same candidate/result logic in `immediate` mode with no batch sleeps.
This distinction is deliberate: normal rollout limits cold-start pressure;
rollback restores known-good service as quickly as possible.
