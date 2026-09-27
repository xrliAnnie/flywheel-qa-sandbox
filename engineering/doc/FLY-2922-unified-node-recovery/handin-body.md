## FLY-2922 · design-node verify-then-submit contract (sandbox docs only)

This PR carries **documents only** (`engineering/doc/FLY-2922-unified-node-recovery/`). It does **not** carry the FLY-2922 implementation.

- Implementation head: `2dd29e0276617cf21e31ce4bfe2a4df792d8cf0a` on `flywheel-FLY-2922` — production PR https://github.com/xrliAnnie/flywheel/pull/1374 (mirrored here as `origin/flywheel-FLY-2922`).
- Effective code review on that exact head: `92e28887` APPROVED (2026-09-27 12:09:19Z).
- Sandbox main and the implementation branch are different trees; this PR is not a landing vehicle for the implementation.
- Merge order: FLY-2921 lands first (candidate `5357dd5ce` already merged into the implementation branch); the later branch resyncs `main` keeping `pending + new preferred actor`.
- Lead advisory dispositions (see the production PR body "Lead advisory disposition"): carveout landed; merge order stated; shared-materializer preconditions landed; rework-replacement context preflight landed (stage/apply 409, digest rechecked in transaction).
- LOW follow-ups stay in the production PR body ("Follow-ups", "Follow-ups from effective code review round 4").

## Linear Issue
FLY-2922: 病根修复 #8 held / 回滚之后有出口
https://linear.app/geoforge3d/issue/FLY-2922

🤖 Generated with [Claude Code](https://claude.com/claude-code)
