# FLY-2684 Ubicloud trial runbook

This runbook is the operational handoff for the manual canary and the later
one-week receipt. It does not authorize an account installation, a production
runner switch, a merge, or a deployment.

## Official-source findings (checked 2026-09-17)

1. **Managed-account concurrency: unverified.** Ubicloud's Quickstart, runner
   types, pricing, and GitHub Actions product pages do not publish a per-account
   managed-runner concurrency entitlement. Do not infer it from GitHub-hosted
   concurrency. After account authorization, retain the account quota/support
   receipt and run paired GitHub/Ubicloud capacity probes at 1, 8, 33, then 54.
   A completed level proves only the observed account capacity at that time.
2. **Private repositories: no explicit official guarantee found.** The
   [Quickstart](https://www.ubicloud.com/docs/github-actions-integration/quickstart)
   documents installing the GitHub App on repositories, but does not explicitly
   promise private-repository support. A successful checkout and payload run in
   the private `xrliAnnie/flywheel` repository is the required account-level
   evidence. Do not create a public mirror.
3. **A fresh, one-job VM: confirmed by Ubicloud.** The
   [security documentation](https://www.ubicloud.com/docs/github-actions-integration/security)
   says each job receives a clean ephemeral VM, its VM and block storage are
   decommissioned after completion, and a JIT runner performs at most one job.
   The fixed-path writer/reader jobs additionally test two real samples without
   claiming to prove physical media erasure.
4. **Comparable runner and label: confirmed.** The
   [runner-types documentation](https://www.ubicloud.com/docs/github-actions-integration/runner-types)
   defines `ubicloud-standard-2` as Ubuntu 24.04, x64, 2 vCPU, 8 GB RAM, and
   75 GB disk. It also lists 4/8/16/30-vCPU x64 variants and the optional
   `-ubuntu-2204`, `-ubuntu-2404`, and `-ubuntu-2604` suffixes. GitHub documents
   private-repository `ubuntu-latest` as 2 vCPU, 8 GB RAM, and 14 GB disk, so
   `ubicloud-standard-2` is the first comparison point, not a byte-identical
   image claim.
5. **Cache behavior: confirmed; paid expansion remains account evidence.** The
   [Ubicloud Cache documentation](https://www.ubicloud.com/docs/github-actions-integration/ubicloud-cache)
   says transparent cache is enabled by default, supports `actions/cache` and
   `actions/setup-*`, includes 30 GB per repository per week, evicts oldest
   entries over capacity, removes entries unused for seven days, and retains
   current/default-branch isolation by default. Keep the standard actions and
   branch protection. Do not cache HOME, credentials, sentinels, or the entire
   workspace.

The [pricing page](https://www.ubicloud.com/docs/about/pricing) lists 2-vCPU
standard at $0.00125/min and premium at $0.002/min, says new users default to
premium, and says premium can fall back to standard when premium capacity is
full. The Lead must disable premium in the console after account connection if
the trial is intended to measure the standard tier, then retain tier, credit,
cache, and invoice evidence. Usage Alerts are notification-only, not a hard
spend cap. The Lead-corrected proposed one-week line is $60 and is **not
founder-confirmed**; do not represent it as an enforced maximum.

GitHub's [current Actions billing documentation](https://docs.github.com/en/billing/concepts/product-billing/github-actions)
says self-hosted runner usage is free. Its
[December 2025 changelog](https://github.blog/changelog/2025-12-16-coming-soon-simpler-pricing-and-a-better-experience-for-github-actions/)
says the proposed $0.002/min self-hosted platform charge was postponed. Keep
account ticket #182186 and the actual GitHub invoice
as account-specific evidence in case that policy changes; do not silently add a
$0.002/min fee to this trial. The founder-directed comparison is gross spend:
do not subtract GitHub-hosted free allowance from the GitHub baseline.

## Current repository baseline

- `.github/workflows/ci.yml` consumes zero `secrets.*` values. Its only token
  expression is the scoped `${{ github.token }}` in `classify`. The canary's
  `UBICLOUD_CANARY_PROBE` is a new, random, no-production-authority test secret,
  not evidence that every production secret is compatible.
- The frozen PR-A source fixture is a committed full copy of `ci.yml` at
  `f0175458414f20f6f82ca7ea12cd6a6f64899eb3`; this keeps parity checks valid in
  Quick Gate's depth-1 checkout. It is intentionally a historical canary
  baseline, not a permanent assertion that live `ci.yml` must stay unchanged.
  When the canary payload is intentionally refreshed, copy the chosen
  `ci.yml` revision into `scripts/ci-ubicloud/fixtures/ci-source.yml`, update
  `sourceFixtureSha256` in the canary test, update the anchors below, and adapt
  the three selected canary jobs in the same change. Ordinary `ci.yml` changes
  do not require re-baselining this fixture.
- Correct source anchors at that fixture are: `classify` job/runner 27/29,
  `quick-gate` 50/52, `unit-tests` 191/197, `script-tests` 269/271,
  `script-tests-2` 504/506, `script-tests-3` 901/903,
  `script-tests-4` 1218/1220, `script-tests-5` 1324/1326,
  `payload-distribution` 1446/1448, and `ci-ok` 1576/1578.
- `.github/actionlint.yaml` is a defense-in-depth literal-label allowlist.
  Expression-based `runs-on` validation and the contract tests remain the
  primary guards; the allowlist is not treated as runtime coverage.

## Authorization and canary sequence

Do not dispatch the Ubicloud path until the founder has installed the Ubicloud
GitHub App for **only** `xrliAnnie/flywheel`, and the Lead has retained the
message ID, time, repository scope, account tier, cache settings, credit, and
account quota/support receipt. Dispatch only with `--ref main`. The workflow
rejects any non-default ref, but that rejected dispatch can still create checks
on the selected ref; the guard is not permission to try an open PR head.

The Lead then creates only the dedicated probe secret and canary enable switch,
and reads the variable back. Writing is not proof of effective state:

```sh
gh secret set UBICLOUD_CANARY_PROBE --repo xrliAnnie/flywheel
gh variable set UBICLOUD_CANARY_AUTHORIZED --repo xrliAnnie/flywheel --body true
test "$(gh variable get UBICLOUD_CANARY_AUTHORIZED --repo xrliAnnie/flywheel)" = true
```

Run the same merged revision serially. After **each** command, capture its exact
run ID and wait with `gh run watch <run-id> --exit-status`; do not dispatch the
next command while one is running or pending. GitHub concurrency keeps at most
one pending run for a group and may replace an older pending run even when
`cancel-in-progress` is false. Use A/B twice for each provider so the fixed
cache probe can show miss/save then restore, while recording an already warm
pnpm cache honestly as warm/unknown:

```sh
gh workflow run ci-ubicloud-canary.yml --repo xrliAnnie/flywheel --ref main -f runner=ubuntu-latest -f capacity=0
gh workflow run ci-ubicloud-canary.yml --repo xrliAnnie/flywheel --ref main -f runner=ubuntu-latest -f capacity=0
gh workflow run ci-ubicloud-canary.yml --repo xrliAnnie/flywheel --ref main -f runner=ubicloud-standard-2 -f capacity=0
gh workflow run ci-ubicloud-canary.yml --repo xrliAnnie/flywheel --ref main -f runner=ubicloud-standard-2 -f capacity=0
```

Before the first dispatch, diff the three frozen fixture jobs against the live
merged `ci.yml` and record any workload drift as a trial limitation; do not
silently call a historical payload current. Also save `gh cache list` before
and after each provider pair. That distinguishes Ubicloud's transparent cache
namespace from GitHub cache entries instead of assuming cache-hit provenance.

For every run, retain URL, run/attempt/job IDs, head SHA, start/end, actual
labels/runner name, cache hit, writer and reader success, and the log-scan result.
The reader being skipped is a failure. Secret review must output only a boolean
leak result; never print, encode, hash, upload, or preserve the probe value.
Delete the secret and authorization switch after the canary window.

Capacity is a separate mode with no checkout, secret, or cache. For each N,
run GitHub and Ubicloud controls using the same revision; confirm the previous
level and the current spend line before increasing N:

```sh
gh workflow run ci-ubicloud-canary.yml --repo xrliAnnie/flywheel --ref main -f runner=ubuntu-latest -f capacity=8
gh workflow run ci-ubicloud-canary.yml --repo xrliAnnie/flywheel --ref main -f runner=ubicloud-standard-2 -f capacity=8
```

Wait for each capacity run to complete before dispatching the next one. Repeat
for 1, 33, and 54 as authorized. Measure overlap using
`[started_at, completed_at)`; 54 completed jobs in batches do not prove 54-way
capacity. Record the GitHub account plan/quota separately. Ten minutes of queue
time means cancel and retain an unverified/insufficient result, not move up.

## PR B dependency and one-variable rollback

PR B is not part of PR A. It may start only after FLY-2681 is merged and its
merged SHA is an ancestor of the working branch. Freeze the resulting
`ci.yml` bytes, re-enumerate every `runs-on: ubuntu-latest`, and prove that
FLY-2681 offers a legitimate **same-head full-CI retrigger** on the Ubicloud
path. If same-head retrigger is absent, this advisory remains unverified and PR
B must not claim the three-provider comparison is complete.

PR B changes only each existing runner literal to
`${{ vars.CI_RUNNER_LABEL || 'ubuntu-latest' }}`. After it ships, the Lead owns
all repository-variable writes and must read each value back:

```sh
gh variable set CI_RUNNER_LABEL --repo xrliAnnie/flywheel --body ubicloud-standard-2
test "$(gh variable get CI_RUNNER_LABEL --repo xrliAnnie/flywheel)" = ubicloud-standard-2

# One-step rollback for future scheduling; cancel old affected runs and create a new event.
gh variable set CI_RUNNER_LABEL --repo xrliAnnie/flywheel --body ubuntu-latest
test "$(gh variable get CI_RUNNER_LABEL --repo xrliAnnie/flywheel)" = ubuntu-latest
```

Missing/empty must resolve to `ubuntu-latest`; unknown nonempty values are an
operator error and do not silently fall back. Required check names, merge/ship
gates, and branch protection remain unchanged. Record real full `CI OK` on the
same head for default GitHub, Ubicloud, and rollback GitHub before a production
trial. `CI Scope OK`, a reused green run, or a rerun that did not reread the
variable is not acceptance evidence.

## Atomic REST receipt collection

Use unique output directories and timestamps with an explicit `Z` or numeric
UTC offset. The collector normalizes that window to UTC before building the
GitHub query, validates the result count and workflow identifier,
rejects a window above 1,000 runs (split it into smaller UTC windows), retrieves
every attempt and its jobs, removes carried jobs that GitHub repeats in partial
rerun responses, writes into a staging directory, and atomically renames the
snapshot. It never overwrites an earlier receipt. `manifest.complete` is false
when any captured run or job is still unfinished; recollect a closed window
instead of treating that snapshot as a receipt:

```sh
node scripts/ci-ubicloud/collect-trial-data.mjs \
  --repo xrliAnnie/flywheel \
  --workflow ci.yml \
  --start 2026-09-10T00:00:00Z \
  --end 2026-09-17T00:00:00Z \
  --phase GH-before \
  --scope full \
  --output engineering/doc/FLY-2684-ubicloud-trial/data/gh-before-2026-09-10_17
```

Collect seven full UTC days before and after with the same scope rules. Join
the REST records to the Ubicloud invoice/console receipt without storing card
or personal data in the repository. Report runner minutes (unique executed jobs
across all attempts), cost gross/credit/net, first-real-full-`CI OK` time per head, observed
job wait plus schedulable-delay estimate, and failure/cancel/skip counts. Split
by full/scoped/docs/reused, provider/tier, job class, and cache state. Keep
FLY-2681 matrix savings separate from supplier-price savings. No full week,
invoice, or at least 10 comparable full heads means “insufficient evidence,”
not “savings verified.”

## Design-review advisory disposition

1. **Handled in PR A:** workflow is manual-only and default-branch-only; no
   canary job is named `CI OK`/`CI Scope OK` and no ship aggregator consumes it.
   Operators must still use `--ref main`, because a rejected wrong-ref dispatch
   can create checks on that ref.
2. **Handled in PR A:** Script Tests 2/5 is copied intact, including the 1020s
   elapsed tripwire, rather than the more comfortable Script 1/5.
3. **Handled in PR A/QA:** capacity mode supports paired equal-N GitHub and
   Ubicloud runs; account-plan/quota evidence is mandatory and attribution is
   not inferred from GitHub-hosted limits.
4. **Handled in PR A:** the full source fixture is committed and hash-pinned;
   absence or drift fails in a depth-1 checkout.
5. **Not applicable to PR A:** FLY-2681 has not merged. PR B must prove its
   same-head full-CI retrigger before claiming switch acceptance.
6. **Not applicable to PR A; mandatory for Lead/PR B:** every variable write is
   followed by an exact `gh variable get` readback.
7. **Handled in PR A:** actionlint label config is explicitly defensive; tests
   independently constrain the runner expression and choices.
8. **Handled in PR A:** current production `ci.yml` has zero repository-secret
   consumers; the dedicated canary probe is bounded and must not enter logs.
9. **Handled in PR A:** the REST collector publishes an atomic directory,
   marks open snapshots incomplete, deduplicates partial-rerun carry-over, and
   leaves no partial output on API, pagination, or validation failure.
10. **Handled in PR A:** corrected job/runs-on line pairs are recorded above;
    PR B must recalculate them from the post-FLY-2681 frozen baseline.
