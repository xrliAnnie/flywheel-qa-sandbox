---
issue: FLY-2836
phase: implement
phaseCursor: 5/5
updated: 2026-09-24T08:58:04.886Z
nextStep: code review + PR
chunks: []
pointers: {}
---

# FLY-2836 progress
**phase**: implement (5/5)
**next**: code review + PR

**Issue**: FLY-2836 — QA · FLY-2802 — 529 test-discipline synthetic cell A (QA@8)

## Cursor

Phase `implement`, 5/5 — implementation complete, PR open.

## Chunks

| id | chunk | status |
|----|-------|--------|
| c1 | Discovery: `git grep -lF` old/new literal, changed paths, test selection | done |
| c2 | RED: migrate exact assertions in the 6 owning test files | done |
| c3 | GREEN: migrate the 4 model source files | done |
| c4 | Verify: 7 retained test files individually + `vitest related` + `verify.mjs` + `pnpm lint` | done |
| c5 | Code review + PR | done |

## Test selection (local-test-policy/v1)

Discovery commands:

- `git grep -lF -- 'claude-opus-5'` → 13 files, all under
  `packages/runner-test-discipline-fixture`.
- `git grep -lF -- 'claude-opus-5.5'` → 0 files (new literal absent before the change).
- Changed-path search (full path / file name / parent directory) surfaced no test
  file outside the fixture package.

Retained and run one concrete file at a time under the owning package
(`pnpm --filter @flywheel/runner-test-discipline-fixture exec vitest run <file>`):

1. `src/alpha/__tests__/model.test.ts`
2. `src/beta/__tests__/model.test.ts`
3. `src/delta/__tests__/model.test.ts`
4. `src/gamma/__tests__/model.test.ts`
5. `src/__tests__/literal-only.test.ts`
6. `src/__tests__/static-dependency.test.ts`
7. `src/__tests__/unrelated.test.ts`

Excluded test matches: none. `src/__tests__/unrelated.test.ts` matched discovery only
as a substring (`claude-opus-50`) rather than the exact label, but it was retained
rather than excluded because it is the negative guard proving the near value and the
unrelated label were not rewritten.

No full-repository or full-package suite was run.

## Next

Await code review and the QA/ship nodes. This node does not merge.
