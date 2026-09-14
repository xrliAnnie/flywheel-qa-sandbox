# FLY-2544 确定性 hold 测试 — 调研
Issue: FLY-2544 (https://linear.app/geoforge3d/issue/FLY-2544/flake-tmuxadaptertestts-ensurerunnersessionfly-758-deadlinems1-计时竞态让)
日期: 2026-09-14
基于: exploration.md

TmuxAdapter.ts checks Date.now() before entering the helper loop. The catch exits immediately when deadlineMs <= 1. Increasing the deadline alone instead permits retries. The adjacent invalid-helper-output test already fixes Date.now() at 1000 and restores its spy in finally. Adopt this existing pattern for the saturated case.

Reproduction: temporarily inject a Date.now spy returning 1000 once then 1001 into the unchanged target test. This deterministically models the reported pre-loop scheduling delay; retain failing output, then remove the injection. No production edits.

## Controlled red receipt

Before the fix, temporarily injected the specified advancing Date.now spy in the target test. Focused Vitest command exited 1: 1 failed / 171 filtered out, expected `{ kind: "saturated" }`, received `TmuxSessionHoldError { kind: "unknown" }`. Duration 2.46s, test 5ms. Log: `/tmp/FLY-2544-red.log`. The injection was removed immediately afterward; production source unchanged. This is controlled scheduling reproduction, not a claim of naturally occurring local flakiness.

Locked dependency install and `pnpm -r build` both exited 0. Correction from approved design review: the GUI test resides in core; voice-codex exclusion does not protect it. Local full-suite invocation must explicitly append `--exclude '**/tmux-viewer.macos.test.ts'`. CI heavy matrix command is `pnpm --filter flywheel-claude-runner --filter flywheel-comm --filter flywheel-edge-worker test:run`.

## Fixed-test verification

Target command: `pnpm --filter flywheel-claude-runner exec vitest run test/TmuxAdapter.test.ts -t "fails closed with a typed hold instead of falling back to plain create"`. Shell loop `for i in {1..20}; do <command> > "/tmp/FLY-2544-green/$i.log" 2>&1 || exit $?; echo "PASS $i/20"; done` completed with exit 0 and PASS 20/20 (all 20 invocations passed).

Whole file: `pnpm --filter flywheel-claude-runner exec vitest run test/TmuxAdapter.test.ts`, exit 0, 172/172 passed, 11.53s (`/tmp/FLY-2544-file.log`). Post-fix `pnpm lint` exited 0 with 18 existing warnings; `pnpm -r build` exited 0 (`/tmp/FLY-2544-lint-final.log`, `/tmp/FLY-2544-build-final.log`).

Design gate fd2000e1-0ea1-4211-9468-0850040fb73b returned effective APPROVED. GUI exclusion advisory applied to local aggregate invocation; optional assertions deferred to retain the minimal approved test change.
