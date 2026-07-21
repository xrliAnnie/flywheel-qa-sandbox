---
issue: FLY-1395
phase: qa
phaseCursor: 8/8
updated: 2026-07-20T18:20:00.000Z
nextStep: code-review kickback — implement phase fixes Finding 1 (HIGH cred residue) + 3 (MEDIUM probe), QA re-verifies
chunks: []
pointers: {}
---

# FLY-1395 progress
**phase**: qa (8/8) — behavioral PASS, but Codex code-review HARD GATE = CHANGES REQUESTED
**next**: implement phase fixes Finding 1 (HIGH: cred residue, codex-home.ts:576-615 provision
non-atomic → GH_TOKEN residue on matt cpSync failure, outside adapter scrub try/finally) +
Finding 3 (MEDIUM: Blueprint probe under-validates matt frontmatter → hard-fail not fallback_superpowers).
Finding 2 (prompt byte-compat) REBUTTED (intentional per plan Task 4). QA re-verifies after fix.

Behavioral QA evidence intact: real-machine codex A/B/C 12/0; config 527/527, codex-home 47/47,
CodexTmuxAdapter 59/59, Blueprint 234/234, off-sentinel 2/2; biome clean; drift-guard added.
approve gate NOT opened (ship gate held on the two confirmed findings).
