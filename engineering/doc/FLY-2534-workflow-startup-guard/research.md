# FLY-2534 Workflow 启动守卫 — 调研
Issue: FLY-2534 (https://linear.app/geoforge3d/issue/FLY-2534)
日期: 2026-09-13
基于: exploration.md

## Root cause

actionlint 1.7.12 reports payload-beta-release.yml:91:30: context "runner" is not allowed here. The job-level env TRUSTED_BETA_ROOT uses runner.temp. GitHub permits runner in step env/run, but not job env. Initialize TRUSTED_BETA_ROOT via RUNNER_TEMP and GITHUB_ENV in a preceding step instead, preserving the path across later steps and frozen checkout.

The existing beta structure test parses YAML and embedded scripts but does not validate expression context availability. The run-name parses successfully; it is not the reproduced error.

## Validator compatibility

1.7.12 is the current published actionlint release. Across all repository workflows, disabling optional shellcheck/pyflakes and ignoring only its exact unsupported concurrency queue key diagnostic leaves only the beta job-env error. GitHub supports queue: max since May 2026; removing queue would change required B6 behavior. Add explicit queue validation alongside this narrow compatibility exception (max value, cancellation false/absent) so malformed queue settings cannot hide behind the exception.

## Sources

- https://github.com/xrliAnnie/flywheel/actions/runs/34716013503
- https://docs.github.com/en/actions/reference/workflows-and-actions/contexts (job env versus step contexts)
- https://github.blog/changelog/2026-05-07-github-actions-concurrency-groups-now-allow-larger-queues/
- https://github.com/rhysd/actionlint/blob/v1.7.12/docs/usage.md

Static validation is a pre-merge syntax/context guard, not proof of a production release. Exact-head CI startup and later QA/ship production evidence remain separate.
