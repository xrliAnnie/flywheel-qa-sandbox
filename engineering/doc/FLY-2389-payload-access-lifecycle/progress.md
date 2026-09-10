---
issue: FLY-2389
phase: implement
phaseCursor: 6/6
updated: 2026-09-10T07:06:31.109Z
nextStep: Milestone last; one ordinary push and PR; freeze HEAD for Bridge
  request-review and CI14/14. Report externally then complete needs_review. No
  further progress commits while review is pending.
chunks: []
pointers: {}
handoff: |
  C1-C6 implementation and local verification finished; local full gate is NOT green. Lead answer 7272fc03-c4ad-481f-9f4a-0a651af6cd1e permits separate remaining-package receipts and exact-head CI14/14; no unrelated Vitest/test changes. Rescue failed before thread (sandbox_apply Operation not permitted, helper exit71); Lead answer 41996fff-2eed-44cb-8677-27e7bab16218 confirms Bridge exact-head review as runtime code gate. Endpoint91/91, key-cleanup21/21, structure23/23, pipeline42/42, promote4/4, customer E2E8/8, contract5suites, Worker dry-run/metafile green; lint/build green. Five remaining packages green; teamlead assertions12452 passed/7 skipped but RPC error. No real R2, deploy, merge, or QA dispatch.

  ## Local full gate R1: exit 1
  ```text
  packages/flywheel-comm test:run: ⎯⎯⎯⎯⎯⎯⎯ Failed Tests 4 ⎯⎯⎯⎯⎯⎯⎯
  packages/flywheel-comm test:run:  FAIL  src/commands/__tests__/adopt-inflight.test.ts > flywheel-comm adopt-inflight > runs the real CLI without opening the default path or ensuring schema
  packages/flywheel-comm test:run: Error: Test timed out in 5000ms.
  packages/flywheel-comm test:run: If this is a long-running test, pass a timeout value as the last argument or configure it globally with "testTimeout".
  packages/flywheel-comm test:run:  ❯ src/commands/__tests__/adopt-inflight.test.ts:125:2
  packages/flywheel-comm test:run:     123|  });
  packages/flywheel-comm test:run:     124| 
  packages/flywheel-comm test:run:     125|  it("runs the real CLI without opening the default path or ensuring sc…
  packages/flywheel-comm test:run:        |  ^
  packages/flywheel-comm test:run:     126|   const dbPath = join(root(), "comm.db");
  packages/flywheel-comm test:run:     127|   const defaultPath = join(root(), "must-not-open.db");
  packages/flywheel-comm test:run: ⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/4]⎯
  packages/flywheel-comm test:run:  FAIL  src/__tests__/cli.test.ts > CLI > runner-stopped > keeps qid on stdout and reports sent, duplicate, and stale on stderr
  packages/flywheel-comm test:run: Error: Test timed out in 5000ms.
  packages/flywheel-comm test:run: If this is a long-running test, pass a timeout value as the last argument or configure it globally with "testTimeout".
  packages/flywheel-comm test:run:  ❯ src/__tests__/cli.test.ts:186:3
  packages/flywheel-comm test:run:     184| 
  packages/flywheel-comm test:run:     185|  describe("runner-stopped", () => {
  packages/flywheel-comm test:run:     186|   it("keeps qid on stdout and reports sent, duplicate, and stale on st…
  packages/flywheel-comm test:run:        |   ^
  packages/flywheel-comm test:run:     187|    bindDefaultRunner();
  packages/flywheel-comm test:run:     188|    const runStop = (turnId: string, lastMessage: string) =>
  packages/flywheel-comm test:run: ⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[2/4]⎯
  packages/flywheel-comm test:run:  FAIL  src/__tests__/cli.test.ts > CLI > check > should output answer when responded
  packages/flywheel-comm test:run: Error: Test timed out in 5000ms.
  packages/flywheel-comm test:run: If this is a long-running test, pass a timeout value as the last argument or configure it globally with "testTimeout".
  packages/flywheel-comm test:run:  ❯ src/__tests__/cli.test.ts:495:3
  packages/flywheel-comm test:run:     493|   });
  packages/flywheel-comm test:run:     494| 
  packages/flywheel-comm test:run:     495|   it("should output answer when responded", () => {
  packages/flywheel-comm test:run:        |   ^
  packages/flywheel-comm test:run:     496|    bindDefaultRunner();
  packages/flywheel-comm test:run:     497|    const qId = runCli([
  packages/flywheel-comm test:run: ⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[3/4]⎯
  packages/flywheel-comm test:run:  FAIL  src/__tests__/cli.test.ts > CLI > check > should always exit 0 regardless of answer status
  packages/flywheel-comm test:run: Error: Test timed out in 5000ms.
  packages/flywheel-comm test:run: If this is a long-running test, pass a timeout value as the last argument or configure it globally with "testTimeout".
  packages/flywheel-comm test:run:  ❯ src/__tests__/cli.test.ts:518:3
  packages/flywheel-comm test:run:     516|   });
  packages/flywheel-comm test:run:     517| 
  packages/flywheel-comm test:run:     518|   it("should always exit 0 regardless of answer status", () => {
  packages/flywheel-comm test:run:        |   ^
  packages/flywheel-comm test:run:     519|    const qId = runCli([
  packages/flywheel-comm test:run:     520|     "ask",
  packages/flywheel-comm test:run: ⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[4/4]⎯
  packages/flywheel-comm test:run: ⎯⎯⎯⎯⎯⎯ Unhandled Errors ⎯⎯⎯⎯⎯⎯
  packages/flywheel-comm test:run: Vitest caught 1 unhandled error during the test run.
  packages/flywheel-comm test:run: This might cause false positive tests. Resolve unhandled errors to make sure your tests are not affected.
  packages/flywheel-comm test:run: ⎯⎯⎯⎯⎯⎯ Unhandled Error ⎯⎯⎯⎯⎯⎯⎯
  packages/flywheel-comm test:run: Error: [vitest-worker]: Timeout calling "onTaskUpdate"
  packages/flywheel-comm test:run:  ❯ Object.onTimeoutError ../../node_modules/.pnpm/vitest@3.2.4_@types+node@20.19.21_@vitest+ui@3.2.4_happy-dom@20.10.6_tsx@4.20.6_yaml@2.8.1/node_modules/vitest/dist/chunks/rpc.-pEldfrD.js:53:10
  packages/flywheel-comm test:run:  ❯ Timeout._onTimeout ../../node_modules/.pnpm/vitest@3.2.4_@types+node@20.19.21_@vitest+ui@3.2.4_happy-dom@20.10.6_tsx@4.20.6_yaml@2.8.1/node_modules/vitest/dist/chunks/index.B521nVV-.js:59:62
  packages/flywheel-comm test:run:  ❯ listOnTimeout node:internal/timers:605:17
  packages/flywheel-comm test:run:  ❯ processTimers node:internal/timers:541:7
  packages/flywheel-comm test:run: ⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯
  packages/flywheel-comm test:run:  Test Files  2 failed | 152 passed (154)
  packages/flywheel-comm test:run:       Tests  4 failed | 2186 passed | 2 skipped (2192)
  packages/flywheel-comm test:run:      Errors  1 error
  packages/flywheel-comm test:run:    Start at  23:40:34
  packages/flywheel-comm test:run:    Duration  79.08s (transform 17.76s, setup 16.28s, collect 142.02s, tests 413.59s, environment 94ms, prepare 78.14s)
  packages/flywheel-comm test:run: Failed
  /Users/xiaorongli/Dev/flywheel-FLY-2389/packages/flywheel-comm:
   ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL  flywheel-comm@0.1.0 test:run: `vitest run`
  Exit status 1
   ELIFECYCLE  Command failed with exit code 1.
  ```

  ## Local full gate R2 (bounded concurrency): exit 1
  ```text
  ⎯⎯⎯⎯⎯⎯ Unhandled Errors ⎯⎯⎯⎯⎯⎯

  Vitest caught 1 unhandled error during the test run.
  This might cause false positive tests. Resolve unhandled errors to make sure your tests are not affected.

  ⎯⎯⎯⎯⎯⎯ Unhandled Error ⎯⎯⎯⎯⎯⎯⎯
  Error: [vitest-worker]: Timeout calling "onTaskUpdate"
   ❯ Object.onTimeoutError ../../node_modules/.pnpm/vitest@3.2.4_@types+node@20.19.21_@vitest+ui@3.2.4_happy-dom@20.10.6_tsx@4.20.6_yaml@2.8.1/node_modules/vitest/dist/chunks/rpc.-pEldfrD.js:53:10
   ❯ Timeout._onTimeout ../../node_modules/.pnpm/vitest@3.2.4_@types+node@20.19.21_@vitest+ui@3.2.4_happy-dom@20.10.6_tsx@4.20.6_yaml@2.8.1/node_modules/vitest/dist/chunks/index.B521nVV-.js:59:62
   ❯ listOnTimeout node:internal/timers:605:17
   ❯ processTimers node:internal/timers:541:7

  ⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯


   Test Files  49 passed (49)
        Tests  1224 passed | 2 skipped (1226)
       Errors  1 error
     Start at  23:48:23
     Duration  245.25s (transform 1.09s, setup 0ms, collect 7.19s, tests 285.59s, environment 4ms, prepare 2.20s)

  /Users/xiaorongli/Dev/flywheel-FLY-2389/packages/claude-runner:
   ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL  flywheel-claude-runner@0.2.24 test:run: `vitest run`
  Exit status 1
   ELIFECYCLE  Command failed with exit code 1.
  ```

  ## Remaining six packages: exit 1 (five packages pass)
  ```text
  ⎯⎯⎯⎯⎯⎯ Unhandled Errors ⎯⎯⎯⎯⎯⎯

  Vitest caught 1 unhandled error during the test run.
  This might cause false positive tests. Resolve unhandled errors to make sure your tests are not affected.

  ⎯⎯⎯⎯⎯⎯ Unhandled Error ⎯⎯⎯⎯⎯⎯⎯
  Error: [vitest-worker]: Timeout calling "onTaskUpdate"
   ❯ Object.onTimeoutError ../../node_modules/.pnpm/vitest@3.2.4_@types+node@20.19.21_@vitest+ui@3.2.4_happy-dom@20.10.6_tsx@4.20.6_yaml@2.8.1/node_modules/vitest/dist/chunks/rpc.-pEldfrD.js:53:10
   ❯ Timeout._onTimeout ../../node_modules/.pnpm/vitest@3.2.4_@types+node@20.19.21_@vitest+ui@3.2.4_happy-dom@20.10.6_tsx@4.20.6_yaml@2.8.1/node_modules/vitest/dist/chunks/index.B521nVV-.js:59:62
   ❯ listOnTimeout node:internal/timers:605:17
   ❯ processTimers node:internal/timers:541:7

  ⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯


   Test Files  926 passed (926)
        Tests  12452 passed | 7 skipped (12459)
       Errors  1 error
     Start at  23:55:15
     Duration  585.57s (transform 11.47s, setup 7.04s, collect 382.51s, tests 547.19s, environment 1.04s, prepare 48.39s)


  Summary: 1 fails, 5 passes

  /Users/xiaorongli/Dev/flywheel-FLY-2389/packages/teamlead:
   ERROR  flywheel-teamlead@0.5.0 test:run: `vitest run`
  Exit status 1
  ```
---

# FLY-2389 progress
**phase**: implement (6/6)
**next**: Milestone last; one ordinary push and PR; freeze HEAD for Bridge request-review and CI14/14. Report externally then complete needs_review. No further progress commits while review is pending.

**handoff**: C1-C6 implementation and local verification finished; local full gate is NOT green. Lead answer 7272fc03-c4ad-481f-9f4a-0a651af6cd1e permits separate remaining-package receipts and exact-head CI14/14; no unrelated Vitest/test changes. Rescue failed before thread (sandbox_apply Operation not permitted, helper exit71); Lead answer 41996fff-2eed-44cb-8677-27e7bab16218 confirms Bridge exact-head review as runtime code gate. Endpoint91/91, key-cleanup21/21, structure23/23, pipeline42/42, promote4/4, customer E2E8/8, contract5suites, Worker dry-run/metafile green; lint/build green. Five remaining packages green; teamlead assertions12452 passed/7 skipped but RPC error. No real R2, deploy, merge, or QA dispatch.

## Local full gate R1: exit 1
```text
packages/flywheel-comm test:run: ⎯⎯⎯⎯⎯⎯⎯ Failed Tests 4 ⎯⎯⎯⎯⎯⎯⎯
packages/flywheel-comm test:run:  FAIL  src/commands/__tests__/adopt-inflight.test.ts > flywheel-comm adopt-inflight > runs the real CLI without opening the default path or ensuring schema
packages/flywheel-comm test:run: Error: Test timed out in 5000ms.
packages/flywheel-comm test:run: If this is a long-running test, pass a timeout value as the last argument or configure it globally with "testTimeout".
packages/flywheel-comm test:run:  ❯ src/commands/__tests__/adopt-inflight.test.ts:125:2
packages/flywheel-comm test:run:     123|  });
packages/flywheel-comm test:run:     124| 
packages/flywheel-comm test:run:     125|  it("runs the real CLI without opening the default path or ensuring sc…
packages/flywheel-comm test:run:        |  ^
packages/flywheel-comm test:run:     126|   const dbPath = join(root(), "comm.db");
packages/flywheel-comm test:run:     127|   const defaultPath = join(root(), "must-not-open.db");
packages/flywheel-comm test:run: ⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/4]⎯
packages/flywheel-comm test:run:  FAIL  src/__tests__/cli.test.ts > CLI > runner-stopped > keeps qid on stdout and reports sent, duplicate, and stale on stderr
packages/flywheel-comm test:run: Error: Test timed out in 5000ms.
packages/flywheel-comm test:run: If this is a long-running test, pass a timeout value as the last argument or configure it globally with "testTimeout".
packages/flywheel-comm test:run:  ❯ src/__tests__/cli.test.ts:186:3
packages/flywheel-comm test:run:     184| 
packages/flywheel-comm test:run:     185|  describe("runner-stopped", () => {
packages/flywheel-comm test:run:     186|   it("keeps qid on stdout and reports sent, duplicate, and stale on st…
packages/flywheel-comm test:run:        |   ^
packages/flywheel-comm test:run:     187|    bindDefaultRunner();
packages/flywheel-comm test:run:     188|    const runStop = (turnId: string, lastMessage: string) =>
packages/flywheel-comm test:run: ⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[2/4]⎯
packages/flywheel-comm test:run:  FAIL  src/__tests__/cli.test.ts > CLI > check > should output answer when responded
packages/flywheel-comm test:run: Error: Test timed out in 5000ms.
packages/flywheel-comm test:run: If this is a long-running test, pass a timeout value as the last argument or configure it globally with "testTimeout".
packages/flywheel-comm test:run:  ❯ src/__tests__/cli.test.ts:495:3
packages/flywheel-comm test:run:     493|   });
packages/flywheel-comm test:run:     494| 
packages/flywheel-comm test:run:     495|   it("should output answer when responded", () => {
packages/flywheel-comm test:run:        |   ^
packages/flywheel-comm test:run:     496|    bindDefaultRunner();
packages/flywheel-comm test:run:     497|    const qId = runCli([
packages/flywheel-comm test:run: ⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[3/4]⎯
packages/flywheel-comm test:run:  FAIL  src/__tests__/cli.test.ts > CLI > check > should always exit 0 regardless of answer status
packages/flywheel-comm test:run: Error: Test timed out in 5000ms.
packages/flywheel-comm test:run: If this is a long-running test, pass a timeout value as the last argument or configure it globally with "testTimeout".
packages/flywheel-comm test:run:  ❯ src/__tests__/cli.test.ts:518:3
packages/flywheel-comm test:run:     516|   });
packages/flywheel-comm test:run:     517| 
packages/flywheel-comm test:run:     518|   it("should always exit 0 regardless of answer status", () => {
packages/flywheel-comm test:run:        |   ^
packages/flywheel-comm test:run:     519|    const qId = runCli([
packages/flywheel-comm test:run:     520|     "ask",
packages/flywheel-comm test:run: ⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[4/4]⎯
packages/flywheel-comm test:run: ⎯⎯⎯⎯⎯⎯ Unhandled Errors ⎯⎯⎯⎯⎯⎯
packages/flywheel-comm test:run: Vitest caught 1 unhandled error during the test run.
packages/flywheel-comm test:run: This might cause false positive tests. Resolve unhandled errors to make sure your tests are not affected.
packages/flywheel-comm test:run: ⎯⎯⎯⎯⎯⎯ Unhandled Error ⎯⎯⎯⎯⎯⎯⎯
packages/flywheel-comm test:run: Error: [vitest-worker]: Timeout calling "onTaskUpdate"
packages/flywheel-comm test:run:  ❯ Object.onTimeoutError ../../node_modules/.pnpm/vitest@3.2.4_@types+node@20.19.21_@vitest+ui@3.2.4_happy-dom@20.10.6_tsx@4.20.6_yaml@2.8.1/node_modules/vitest/dist/chunks/rpc.-pEldfrD.js:53:10
packages/flywheel-comm test:run:  ❯ Timeout._onTimeout ../../node_modules/.pnpm/vitest@3.2.4_@types+node@20.19.21_@vitest+ui@3.2.4_happy-dom@20.10.6_tsx@4.20.6_yaml@2.8.1/node_modules/vitest/dist/chunks/index.B521nVV-.js:59:62
packages/flywheel-comm test:run:  ❯ listOnTimeout node:internal/timers:605:17
packages/flywheel-comm test:run:  ❯ processTimers node:internal/timers:541:7
packages/flywheel-comm test:run: ⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯
packages/flywheel-comm test:run:  Test Files  2 failed | 152 passed (154)
packages/flywheel-comm test:run:       Tests  4 failed | 2186 passed | 2 skipped (2192)
packages/flywheel-comm test:run:      Errors  1 error
packages/flywheel-comm test:run:    Start at  23:40:34
packages/flywheel-comm test:run:    Duration  79.08s (transform 17.76s, setup 16.28s, collect 142.02s, tests 413.59s, environment 94ms, prepare 78.14s)
packages/flywheel-comm test:run: Failed
/Users/xiaorongli/Dev/flywheel-FLY-2389/packages/flywheel-comm:
 ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL  flywheel-comm@0.1.0 test:run: `vitest run`
Exit status 1
 ELIFECYCLE  Command failed with exit code 1.
```

## Local full gate R2 (bounded concurrency): exit 1
```text
⎯⎯⎯⎯⎯⎯ Unhandled Errors ⎯⎯⎯⎯⎯⎯

Vitest caught 1 unhandled error during the test run.
This might cause false positive tests. Resolve unhandled errors to make sure your tests are not affected.

⎯⎯⎯⎯⎯⎯ Unhandled Error ⎯⎯⎯⎯⎯⎯⎯
Error: [vitest-worker]: Timeout calling "onTaskUpdate"
 ❯ Object.onTimeoutError ../../node_modules/.pnpm/vitest@3.2.4_@types+node@20.19.21_@vitest+ui@3.2.4_happy-dom@20.10.6_tsx@4.20.6_yaml@2.8.1/node_modules/vitest/dist/chunks/rpc.-pEldfrD.js:53:10
 ❯ Timeout._onTimeout ../../node_modules/.pnpm/vitest@3.2.4_@types+node@20.19.21_@vitest+ui@3.2.4_happy-dom@20.10.6_tsx@4.20.6_yaml@2.8.1/node_modules/vitest/dist/chunks/index.B521nVV-.js:59:62
 ❯ listOnTimeout node:internal/timers:605:17
 ❯ processTimers node:internal/timers:541:7

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯


 Test Files  49 passed (49)
      Tests  1224 passed | 2 skipped (1226)
     Errors  1 error
   Start at  23:48:23
   Duration  245.25s (transform 1.09s, setup 0ms, collect 7.19s, tests 285.59s, environment 4ms, prepare 2.20s)

/Users/xiaorongli/Dev/flywheel-FLY-2389/packages/claude-runner:
 ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL  flywheel-claude-runner@0.2.24 test:run: `vitest run`
Exit status 1
 ELIFECYCLE  Command failed with exit code 1.
```

## Remaining six packages: exit 1 (five packages pass)
```text
⎯⎯⎯⎯⎯⎯ Unhandled Errors ⎯⎯⎯⎯⎯⎯

Vitest caught 1 unhandled error during the test run.
This might cause false positive tests. Resolve unhandled errors to make sure your tests are not affected.

⎯⎯⎯⎯⎯⎯ Unhandled Error ⎯⎯⎯⎯⎯⎯⎯
Error: [vitest-worker]: Timeout calling "onTaskUpdate"
 ❯ Object.onTimeoutError ../../node_modules/.pnpm/vitest@3.2.4_@types+node@20.19.21_@vitest+ui@3.2.4_happy-dom@20.10.6_tsx@4.20.6_yaml@2.8.1/node_modules/vitest/dist/chunks/rpc.-pEldfrD.js:53:10
 ❯ Timeout._onTimeout ../../node_modules/.pnpm/vitest@3.2.4_@types+node@20.19.21_@vitest+ui@3.2.4_happy-dom@20.10.6_tsx@4.20.6_yaml@2.8.1/node_modules/vitest/dist/chunks/index.B521nVV-.js:59:62
 ❯ listOnTimeout node:internal/timers:605:17
 ❯ processTimers node:internal/timers:541:7

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯


 Test Files  926 passed (926)
      Tests  12452 passed | 7 skipped (12459)
     Errors  1 error
   Start at  23:55:15
   Duration  585.57s (transform 11.47s, setup 7.04s, collect 382.51s, tests 547.19s, environment 1.04s, prepare 48.39s)


Summary: 1 fails, 5 passes

/Users/xiaorongli/Dev/flywheel-FLY-2389/packages/teamlead:
 ERROR  flywheel-teamlead@0.5.0 test:run: `vitest run`
Exit status 1
```

