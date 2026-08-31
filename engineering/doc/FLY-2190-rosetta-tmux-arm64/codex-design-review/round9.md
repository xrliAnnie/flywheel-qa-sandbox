# Design Review — FLY-2190 plan.md (Round 9)

Date: 2026-08-30
Author: Codex
Reviewed blob: `af2b97be416adaf8b222fd565737a06c55e3bb30`
Status: APPROVED

## Summary

Blob `af2b97be416adaf8b222fd565737a06c55e3bb30` closes all three Round 8 findings. The header is status-neutral, the `npm` exercise is bounded and isolated from the default production staging path, and §1.5, A4/A4a, and §6 now agree on both the static non-carrier classification and the mandatory extra smoke. No correctness or safety defect remains.

## What's Good (Keep)

- The plan no longer embeds a self-referential approval claim; blob-bound verdicts can remain in the external review record and orchestration receipt.
- The `npm` reachability evidence remains unchanged and visible. Adding a Lead-directed smoke does not falsely promote the release tool into the carrier tree.
- A4 now makes the extra `npm` check executable and blocking: it specifies post-S1 resolution/version evidence, the real `shell-prepare` consumption path, bounded execution, output assertions, isolation from `~/.flywheel/publish-staging`, cleanup, and stop-on-failure behavior.
- §6 now matches A4 instead of reviving the old A4a/no-smoke disposition.
- Keeping the “carrier 树内” framing is acceptable. A4 grammatically describes the carrier set **plus** an explicitly labeled “非 carrier，Lead 加验” exception, so an implementer cannot reasonably mistake the smoke requirement for reachability evidence.
- The previously approved S0–S3 design and the four §4.5 implementation decisions remain intact.

## Issues & Recommendations

No blocking issues. Carry these as implementation notes:

1. `npm`, like `npx`, is a JavaScript entry script rather than a Mach-O binary. For A4’s before/after evidence, record the script identity and version plus the actual `node` interpreter path/architecture; mark architecture for the script itself as not applicable.
2. Bind `TMPDIR` to a directory beneath the outer `mktemp -d` root before running `shell-prepare`. The script creates its intermediate `fw-shell-pack-*` directory via `os.tmpdir()`; keeping that inside the outer root makes cleanup remain complete even on timeout or failure. Use a trap/finally cleanup path.

## Verdict

APPROVED — blob `af2b97be416adaf8b222fd565737a06c55e3bb30` is ready for the blob-bound receipt and orchestration gate.
