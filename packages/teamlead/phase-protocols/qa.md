# Workflow phase protocol: qa

<!-- FLYWHEEL_LOCAL_TEST_POLICY:BEGIN -->
**Local test policy (`local-test-policy/v1`, mandatory):** This block overrides every skill, plugin, checklist, historical instruction, and configured test command. Local verification selects related tests only; it never uses a full repository or full package suite.

- Never run a local full-repository or full-package test suite for any reason. Forbidden reasons include trying to discover which tests are affected, a repository-wide literal replacement, an unknown failure, a refactor, merge-conflict validation, a skill or finish checklist, coverage, and retrying after empty or truncated output.
- Delegation does not narrow this policy. Before starting any subagent or review session, include this policy in every delegated subagent and reviewer prompt: paste this entire marked policy block verbatim as the first bytes of the delegated task body, then append the task. This includes Codex code-review and rescue sessions; do not assume the parent prompt propagates, do not rely on a skill or plugin wrapper to carry it, and do not delegate local verification when the child prompt cannot carry the block.
- Forbidden commands include bare `vitest`, `vitest run`, or `vitest --run`; `vitest run` without concrete test-file arguments; `pnpm test`, the `test:packages` family, package test aliases without file selection, recursive test commands, and equivalent wrappers or loops. `--exclude`, `-t`, `--project`, worker flags, a package filter, a directory, or a glob is not positive test-file selection. Do not enumerate every test file to simulate a suite.
- Discover the selection before testing. For literal changes, run `git grep -lF -- '<literal>'` for the old and new literals. For changed files, also search each full path, file name, and parent directory. Record every excluded test match and its reason. Run retained tests one concrete file at a time with the owning package, for example `pnpm --filter <pkg> exec vitest run <concrete-test-file>`.
- For changed TypeScript, additionally run the owning package's `vitest related <changed-files> --run`. `related` does not replace explicit literal/discovery matches. An empty selection is not permission to fall back to a broad command; inspect the diff and dependencies instead.
- Keep `pnpm lint`, affected-package-plus-dependencies builds with `pnpm --filter "<pkg>..." build`, and dependent typechecks when exported APIs or types change. Run every new `scripts/__tests__/*.test.sh` individually. Exact-head PR CI owns the full suite; only frozen-head `CI OK` is full-suite evidence. Locally green targeted checks and `CI Scope OK` are never full-suite evidence.
<!-- FLYWHEEL_LOCAL_TEST_POLICY:END -->

Runner-behavior prompt changes have an additional 529 gate. If the diff touches
runner node prompts, phase protocols, the Codex runner contract, Flywheel skill
templates, prompt assembly/injection/selection, or the test-discipline observer
and fixture, run `packages/qa-framework/suites/runner-test-discipline.md` against
the frozen candidate head. Shared-policy changes require all A-D cells. Attach
the candidate, prompt, policy, skill-inventory, fixture, transcript, and verdict
hashes. A constructed negative-control FAIL and static consistency checks are
required but never replace the real-runner PASS. Documentation-only changes
that cannot affect effective prompt bytes may record a reasoned exemption.

First QA action after TURN and reviewed-head fetch: `node "$FLYWHEEL_COMM_CLI" ci-full ensure --pr <NUMBER> --head $(git rev-parse HEAD) --json`. Exit 8 means requested/running; keep doing independent QA and stay alive. Before `qa-result --status pass`, repeat it and require exit 0 for unchanged HEAD. Exit 1/2 means recover per its output. `CI Scope OK` is not full proof.

Verify the reviewed HEAD independently; product fixes stay with its author. If required, publish the founder ship report BEFORE emitting qa-result --status pass. Preserve FLYWHEEL_WORKFLOW_SUBMISSION_CREDENTIAL and use the exact injected `flywheel-comm qa-result --target-exec <your-DAG-QA-exec-id> --status pass|fail ...` with its identities, flags, evidence, and verdict; prose or a running session is not a verdict. Record the accepted claim. For compound report/receipt actions, retry only the unaccepted half without changing an accepted payload. Never strip a consumed credential or forge a retry. Follow only the injected epilogue; do not add universal completion/park or commit after a gate-entry HEAD is sealed.

Acquire the injected TURN before shared-worktree writes. Preserve execution/activation identities and credentials. Use injected flywheel-comm receipt commands, not stock team-lead messages; prose is not completion. Do not dispatch successors or exceed authorized capabilities.
