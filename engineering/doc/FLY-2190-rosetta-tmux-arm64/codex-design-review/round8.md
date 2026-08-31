# Design Review — FLY-2190 plan.md (Round 8)

Date: 2026-08-30
Author: Codex
Reviewed blob: `a8b2fd6daa03f2d8dc6e492cfd51bca3e3d1263a`
Status: CHANGES REQUESTED

## Summary

The current worktree and committed `plan.md` both resolve to the requested blob, and §4.5 faithfully preserves the four R7 implementation notes. Promoting `npm` to the smoke set is conservative and compatible with the sweep evidence, but the promotion is incomplete and internally contradictory in the current document; the blob therefore does not yet merit APPROVED.

## What's Good (Keep)

- §4.5 accurately carries all four R7 notes and correctly keeps them as pre-implementation decisions rather than reopening the S0–S3 design.
- Keeping the evidence that `npm` is not carrier-reachable is correct. A discretionary smoke does not change that reachability result; it simply adds assurance beyond the risk classification.
- The requested `npm` check is cheap enough to be proportionate to this issue, provided the real release-path exercise is isolated from production state.
- No previously approved S0, S1, S2, or S3 safety conclusion was weakened by the substantive additions.

## Issues & Recommendations

1. **BLOCKER — the `npm` promotion is not reflected in the executable acceptance contract.** §1.5 still titles category one “carrier 树内” even though `npm` is explicitly outside that tree; the category-one bullet list omits `npm`; A4 still enumerates only `python3`, `npx`, `gh`, and `ffmpeg`; and §6 still says `npm` belongs to A4a and receives no smoke. A4a simultaneously says it moved to A4. An implementer can therefore satisfy the literal A4 row without running the Lead-required check, or follow §6 and intentionally skip it. Rename category one/A4 to the evidence-neutral “必须冒烟” set (with carrier-reachable commands plus the Lead-directed `npm` exception), add an explicit `npm` bullet and A4 entry, and update §6 to point to A4.
2. **The proposed exact-path `npm` check is not read-only as written.** `scripts/release/shell-prepare.mjs:64` runs `npm pack`, then writes a staged tarball to its output directory. If the requirement is to exercise the actual release path, specify a bounded hermetic run using an isolated temporary `--out` directory (and the existing placeholder override only if required), assert the emitted tuple/tarball, and clean up; describe it as isolated local staging, not read-only. If the requirement must remain literally read-only, use an appropriate `npm pack --dry-run` probe and state honestly that it does not execute the full `shell-prepare.mjs` path.
3. **The blob embeds an approval claim that belongs in the external blob-bound receipt.** The diff contains a header change saying the current document is “Codex design review APPROVED,” although R7 approved blob `1fb95b1c…`, not this blob. That claim is false for the present CHANGES REQUESTED object and creates a self-referential re-review loop whenever the plan changes. Make the header status-neutral—e.g. say it has absorbed R1–R7 feedback—and keep blob-specific approval in the committed review record/orchestration receipt.

## Verdict

CHANGES REQUESTED — make the `npm` smoke contract internally consistent, define its safe execution shape, and remove the stale in-blob approval claim.
