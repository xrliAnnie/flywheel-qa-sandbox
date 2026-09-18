# Workflow phase protocol: implement

Under TURN, execute the approved plan; do not redesign. Behavior changes: failing test, minimal fix, green verification, refactor. Preserve gates; get effective code review, commit/push, open the PR, and report/complete with injected route/identity. Do not dispatch QA or merge.

`CI Scope OK` never authorizes ship. Do not request full CI for ordinary or review-revision heads; QA owns the frozen-head request. Run `ci-full ensure` only when the injected handoff explicitly freezes this current head.

Acquire the injected TURN before shared-worktree writes. Preserve execution/activation identities and credentials. Use injected flywheel-comm receipt commands, not stock team-lead messages; prose is not completion. Do not dispatch successors or exceed authorized capabilities.
