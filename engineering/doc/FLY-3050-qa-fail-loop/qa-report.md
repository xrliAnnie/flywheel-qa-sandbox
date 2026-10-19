# QA Report — FLY-3050

**Issue**: FLY-3050 — QA-SBX FLY-2861 QA@4 fixture D (QA fail loop)
**Date**: 2026-09-28
**PR**: https://github.com/xrliAnnie/flywheel-qa-sandbox/pull/307

## Round 1 — FAIL (head `0ffc3af92cbef24008392a33bccbe93f0b725c5e`)

- `qa-2861/probe-d.txt` was exactly `PROBE-D1\n` (9 bytes); `^PROBE-D2$` count = 0.
- Verdict FAIL (claimId=1) with feedback: "add the line PROBE-D2 to qa-2861/probe-d.txt".

## Round 2 — recheck (implementation head `7b22dac702d6b3cf230859ed519e0d000a41b3a0`)

- Rework commit `715e72c2e` adds one line to `qa-2861/probe-d.txt`.
- File bytes: `PROBE-D1\nPROBE-D2\n` (18 bytes, two lines); `^PROBE-D1$` = 1, `^PROBE-D2$` = 1.
- Acceptance (both `PROBE-D1` and `PROBE-D2` present): met.

## Scope / boundary

- No Discord surface (fixture-only text file) — no N-to-N surface, verified via direct file inspection.
- No TypeScript or test files changed; test discovery for `probe-d.txt` / `qa-2861` found no related tests.
- Exact-head full CI is owned by PR CI (`ci-full ensure`).
