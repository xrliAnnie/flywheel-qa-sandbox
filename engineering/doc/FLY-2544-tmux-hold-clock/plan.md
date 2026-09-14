# FLY-2544 确定性 hold 测试 — 实施计划
Issue: FLY-2544 (https://linear.app/geoforge3d/issue/FLY-2544/flake-tmuxadaptertestts-ensurerunnersessionfly-758-deadlinems1-计时竞态让)
日期: 2026-09-14
基于: research.md

Goal: eliminate host wall-clock dependence in the typed saturated-hold test without production behavior changes.

1. Reproduce red using a temporary Date.now spy: `vi.spyOn(Date, "now").mockReturnValueOnce(1_000).mockReturnValue(1_001)` in the target case. Run `pnpm --filter flywheel-claude-runner exec vitest run test/TmuxAdapter.test.ts -t "fails closed with a typed hold instead of falling back to plain create"`; require saturated expected / unknown actual, then remove temporary injection.
2. Only edit that case in packages/claude-runner/test/TmuxAdapter.test.ts: `const clock = vi.spyOn(Date, "now").mockReturnValue(1_000);`, wrap existing body in try/finally with `clock.mockRestore()`. Add a comment explaining pre-loop 1ms exhaustion. Keep the original deadline, retry delay and assertion unchanged. This mirrors its adjacent validation test and ensures the mocked rejection exits through deadlineMs <= 1.
3. Run the focused command in 20 consecutive invocations, stopping at first failure and recording the count. Run the full TmuxAdapter file to exercise cleanup against neighboring cases.
4. Run exact repository gates `pnpm lint`, `pnpm -r build`, `pnpm test:packages:run`. No new shell tests planned. Preserve non-green receipts for known host onTaskUpdate/timeouts and isolate failures; CI remains authoritative. On macOS append `--exclude "**/tmux-viewer.macos.test.ts"` to the aggregate command because the GUI test is in core, not voice-codex.
5. Update progress and milestone engineering/doc/milestones/FLY-2544.md before the final code push; milestone must be in the last commit. Open PR and register effective code review through injected gate/request-review. Do not push documentation after review. Any blocking fix requires new head and review.
6. Obtain two consecutive green relevant heavy shard runs on the exact frozen head (rerun the same workflow without head movement). Retain run/attempt/job identities in external handoff receipts. Only the named flake with untouched source permits one failed-job rerun; unrelated failures need evidence.
7. Report scope, red/20-green evidence, local gate receipts, exact-head CI and review through ask --report. Complete `--route needs_review --pr <number>` and park; no QA dispatch, merge or deploy.
