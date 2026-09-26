# FLY-2917 Linear rejection — 验证记录
Issue: FLY-2917 (https://linear.app/geoforge3d/issue/FLY-2917/病根bridge-崩溃-linear-sdk-的fetch-failed未被接住-unhandledrejection-把整个-bridge)
日期: 2026-09-25
基于: plan.md

> Current policy: the Lead-authorized QA rework below supersedes the original narrow Linear-only guard and strict-mode limitation. Earlier results remain historical evidence.

## Baseline and reproduced failures

- Initial SHA `923d7a551`; locked install and `pnpm --filter "flywheel-teamlead..." build` passed. Logs: `/tmp/FLY-2917-install.log`, `/tmp/FLY-2917-build.log`.
- Baseline targeted `createFetchIssue.test.ts`, `linear-issue-finalizer.test.ts`, `linear-issue-starter.test.ts`: 3 files / 41 tests pass (73.75s), `/tmp/FLY-2917-baseline-tests.log`.
- Pinned SDK `Issue` with rejecting injected request, labels stubbed successfully, and `LinearClient.prototype.issue` replaced locally: current `createFetchIssue` prints StateStore fallback and then Node exits 1 before the 20ms survival timer. The fatal stack identifies the first project getter at built run-infra.js:300. No production API was called. `/tmp/FLY-2917-baseline-reproduction.log`.
- Starter cancellation: the mocked issue request queues an AbortController abort between the helper's post-await check and its caller's continuation. Current code reads the state getter once, returns `linear_start_aborted`, then exits 1 on the orphan `Fetch failed`. `/tmp/FLY-2917-starter-abort-reproduction.log`. This confirms the audit finding rather than assuming a race from static code.

## SDK call inventory (baseline line numbers)

| Calls | Rejection owner / disposition |
| --- | --- |
| run-infra.ts:521 `issue.project` | Confirmed detached truthiness request; eliminate via synchronous projectId. Existing issue/labels catch at :525 preserves StateStore fallback. |
| linear-issue-finalizer.ts:83 `issue.state` | Confirmed double getter; await once. Existing first/second fresh-read catches :89/:125 preserve fail-closed no-write. |
| linear-issue-starter.ts:95,118,144 `state` | Confirmed eager promise before abort check; make getter lazy inside awaitUnlessAborted. Preserve no writes after abort. |
| actions.ts:895-896 issue/labels; :1503 retry comment | :910 catch keeps stored labels; comment local :1504 plus caller :1439-1445 catch. |
| tools.ts:505,613,625,845,863,1240,1287 issue/labels/search | Awaited; catches :510,639,877,1253,1294 return HTTP errors or best-effort misses. |
| runs-route.ts:1923,1940 issue/labels | Labels catch :1942; route catch :1987 returns 502. |
| plugin.ts:4694,4753,4775,4803,4882,4894 teams/projects/labels/create/payload | Entire create route caught at :4914. |
| plugin.ts:5002-5005,5023,5058 issue/team/states/update; :5227,5231 comments | Update catch :5060; comment catch :5236 returns 502. |
| plugin.ts:7949-7950 fresh issue/state arbitration | Returned callback awaited by land-linear-arbitration.ts:18,27; :32 catch degrades. |
| plugin.ts:9761-9762 lifecycle issue/state | lifecycle-closeout.ts:862 and :884-892 catch read failures. |
| plugin.ts:13211 resume description | Local catch :13220 returns unavailable. |
| linear-query.ts:126,235,303 rawRequest | Awaited races; catches :140,246,318 convert to LinearUpstreamError; route/fallback callers own propagation. |
| linear-attention-query.ts:145 rawRequest | Awaited race caught :153; outer catch :220 returns missing-source result. |
| linear-epic-query.ts:272 rawRequest | Race catch :290 wraps; owned by dependency routes, lead-note :160, summary activity :150, epic-page-refresher :156-162, residual scan :207/:262, page route :365, intake scheduler :322-325. |
| dependency-route.ts:613,665,671,680,689,690 raw/relation/comment/payload | Awaited route catches :1133,1282,1394,1518; serialized mutation tail :1112-1115 consumes rejection; ambiguous writes remain unknown. |
| lead-capability-read.ts:231,240 issue/team/project/labels | Awaited race helper :205-218 and route catch :785. |
| lead-capability-discord.ts:397,432,435 issue/relations | Awaited reads/Promise.all; :771 catch preserves rejected/unknown outcomes. |
| lead-capability-report.ts:135,138 issue/relations | Awaited race :174; catch :183 denies scope. |
| lead-capabilities/handlers/linear.ts:58,80,199,243,253,299,301,318,326,339,344 | Awaited/returned scope/projection/search/mutation/payload work. Broker authorization :243-252 and execution race/catch :310,354-371 own failure. |
| lead-capabilities/handlers/linear-provider.ts:107-127 metadata | Awaited helper/Promise.all; same broker ownership. |
| lead-capabilities/linear-client.ts:49-62 custom transport | Awaited fetch race; catch :99 translates failure; cleanup catches and shutdown allSettled own tails. |
| plugin.ts:5394 `issue.state` | Plain mapped LinearIssue field from lookupLinearIssueByIdentifier, not a lazy SDK getter; unchanged. |
| DirectEventSink.emitStarted / ChatThreadCreator.ensureChatThread | Creator has no Linear SDK calls; sink awaits it in catch. Linear starter fire-and-forget work has explicit catch and timeout ownership. Validate fallback→real thread creation. |

The process guard is a last resort for SDK-typed transport failures. Raw rawRequest TypeErrors and capability wrapper errors intentionally remain outside it, relying on the explicit local ownership above. It neither retries unknown writes nor claims their success.

## Gates

Design round 1 `b8d7ea1e-033d-4600-8445-875d78658736` / request `0e7e5eab-c355-4875-a486-aeb110ea6eb5`: CHANGES_REQUESTED for packaged-bridge-guard-path. Revised plan commit `8f7478bbb` puts guard in teamlead and covers SDK identity, both entrypoints, and package rewriting.

Design round 2 `53914b92-2d82-4c23-8ac4-b02739d1aba0` / request `5a301feb-290a-46da-bcb4-4b6d97ee7e72`: effective APPROVED. Nonblocking advisory: pre-existing compiled isolation-bootstrap path remains outside this change; compiled entry coverage uses production, non-isolation boot.

## Causal TDD

Design round 2 effective APPROVED was read before code changes. Causal red command:
`pnpm --filter flywheel-teamlead exec vitest run src/__tests__/createFetchIssue.test.ts src/bridge/__tests__/linear-issue-finalizer.test.ts src/bridge/__tests__/linear-issue-starter.test.ts`.

- RED: 6 expected failures / 43 pass, including duplicate project getter (2 instead of 0), duplicate finalizer state reads ([1,1] and [1,1,3,3]), and all 3 starter abort windows. Vitest also reported 5 unhandled rejections. `/tmp/FLY-2917-causal-red.log`.
- Minimal fix: synchronous projectId; single awaited finalizer state; lazy starter state inside abort helper. No schema/public interface changes.
- GREEN, identical command: 3 files / 49 tests pass, no unhandled errors (54.92s). `/tmp/FLY-2917-causal-green.log`. Includes real DirectEventSink/ChatThreadCreator + in-memory StateStore + mocked Discord transport after SDK issue or labels failure. Commit `4e0478d53`.

## Process guard and entry coverage

- Causal RED: a no-op installer leaves the SDK Fetch failed child exiting 1 instead of surviving. `/tmp/fly2917-guard-causal-red.log`.
- GREEN: 25 real Node child-process tests, including actual teamlead-resolved SDK request rejection, typed network failures, GraphQL/auth/input/ordinary/non-Error negative guards, strict mode, synchronous exceptions, safe logging, side-effect-free import and listener disposal. `/tmp/fly2917-guard-green-async.log` (26.48s).
- The initial synchronous child harness timed out under host load and starved Vitest RPC. It was replaced with asynchronous execFile, bounded boot/process/test deadlines, and test-only stackTraceLimit=0. Production timeouts and fatal behavior were not changed.
- Existing `run-bridge-isolation-boot.test.sh` passes source script, teamlead CLI, actual payload compiler path rewriting plus compiled production boot, and isolation fences. Its guard module is a wiring stub; real classification is covered separately with the teamlead SDK. `/tmp/fly2917-boot-green.log`.
- Other SDK versions and untyped rawRequest/capability errors are not broadly recognized. Local call ownership is primary. The guard neither retries work nor declares it successful. Default Node throw mode recovers the narrow transport class; explicit strict mode still terminates. Nontransport errors are rethrown with their identity retained; monitor origin changes to uncaughtException. Logs use a fixed marker without SDK payloads.

## Consumer selection and scope correction

`consumer-audit.json.gz` is the complete `git grep -lF` manifest: full paths, filenames, parent directories, and emitted .js filenames for the 11 changed code/test paths. It records 4,453 matching files with individual run/exclude decisions and reasons, plus 11 retained tests/scripts. Read with `gzip -dc engineering/doc/FLY-2917-linear-rejection/consumer-audit.json.gz`.

Retained teamlead tests: createFetchIssue, linear-issue-finalizer, linear-issue-starter, linear-transport-rejection-guard, DirectEventSink, ChatThreadCreator, post-ship-finalization. Other retained tests: edge-worker PreHydrator; run-bridge-isolation-boot, package-onboard, flywheel-log-rotate shell scripts. The broad package-onboard-smoke real pack/install/all-import/HTTP test is left to QA; bounded compiler and compiled boot coverage runs locally.

An initial related invocation supplied 1,579 exact `--exclude` paths to retain those 7 teamlead tests. Child projects in the repository Vitest configuration override exclusions, so it unexpectedly expanded to unrelated consumers. This was stopped on discovery (exit 130), reported to Lead (`655c54b4-8dbb-42cf-9a09-2264bd23dc35`), and is not counted as successful scope or full-suite evidence. Before interruption the log records completed post-ship-finalization (58), DirectEventSink (67), and unintended lead-capability-read (20), HeartbeatService.zombie-reconcile (39), HeartbeatService (23), fly2662-predeploy-replay (2), HeartbeatService.monitor-loss (22). Another capability test was in progress. Original log and exact arguments: `/tmp/FLY-2917-related.log`, `/tmp/FLY-2917-related-args.json`.

Corrected related verification uses an external temporary configuration importing the owning package config, retaining its setup/env/pool, clearing `test.projects`, and setting `test.include` to the seven retained paths. `vitest list --filesOnly` was checked for exact equality with the seven-file allowlist before execution. Artifacts: `/tmp/FLY-2917-vitest.config.mts`, `/tmp/FLY-2917-related-discovery.log`, `/tmp/FLY-2917-related-bounded-args.json`, `/tmp/FLY-2917-related-bounded.log`. The command is `pnpm exec vitest related <changed TypeScript paths> --run --config /tmp/FLY-2917-vitest.config.mts`, from packages/teamlead. Repository Vitest configuration is unchanged.

Corrected related result: **6 files / 199 tests pass**, no unhandled errors (151.32s). ChatThreadCreator is a behavioral consumer rather than a dependency selected by related; explicit `pnpm --filter flywheel-teamlead exec vitest run src/__tests__/ChatThreadCreator.test.ts` passes **73 tests** (54.35s), `/tmp/FLY-2917-chat-thread.log`.

## Additional checks

- Edge-worker PreHydrator: 11 tests pass (`/tmp/FLY-2917-prehydrator.log`).
- package-onboard shell: 36 pass, 0 fail (`/tmp/FLY-2917-package-onboard.log`).
- flywheel-log-rotate shell: 14 pass, 0 fail (`/tmp/FLY-2917-log-rotate.log`).
- `pnpm lint`: exit 0, 25 baseline warnings (`/tmp/FLY-2917-lint-final.log`). Final touched-file Biome check: 3 files, no fixes/errors (`/tmp/FLY-2917-lint-changed-final.log`).
- `pnpm --filter "flywheel-teamlead..." build` initially caught guard Error narrowing after all dependency packages passed. Response validation was moved before instanceof narrowing, without changing acceptance; `pnpm --filter flywheel-teamlead build` then passed including native helper (`/tmp/FLY-2917-build-final.log`, `/tmp/FLY-2917-build-teamlead-retry.log`).
- Independent built-code probe using the real pinned SDK, without any unhandledRejection listener: project hydration retains project-id with **0** relation requests; rejecting finalizer state creates **1** owned request and returns state_unreadable_fail_closed; aborted starter reads state **0** times and returns linear_start_aborted. Process survives the timer and exits 0. `/tmp/FLY-2917-causal-built-green.mjs`, `/tmp/FLY-2917-causal-built-green.log`.
- `pnpm --filter "...flywheel-teamlead" typecheck`: teamlead passes; voice-codex initially fails because its separate sibling flywheel-voice-bridge has no built declarations. After `pnpm --filter flywheel-voice-bridge build`, `pnpm --filter flywheel-voice-codex typecheck` passes. No voice source changes. Logs: `/tmp/FLY-2917-typecheck.log`, `/tmp/FLY-2917-build-voice-bridge.log`, `/tmp/FLY-2917-typecheck-voice-retry.log`.

No schema/data migration is required. Listener installation occurs at process boot; a new process does not retain prior listeners and importing the library has no process side effects. Existing mutation fail-closed/replay behavior is covered by finalizer/starter and post-ship tests. Reverting the code restores the prior behavior without data rollback. No production restart, production survival observation, full CI, QA acceptance, or ship is claimed.

## QA rework from 490c91150 (2026-09-26)

Lead explicitly authorized three repairs; plan.md records that requirement override.
The inherited Linear ownership changes and SDK inventory above remain unchanged.

### Root cause and TDD

- FLY-1560 residue reproduced: 1 failed / 6 passed, identifying the child boot
  diagnostic in the guard test. Reworded only that diagnostic; the detector and
  its allowlist were not changed. `/tmp/FLY-2917-rework-residue-red.log`.
- New record child tests run **without** installing any process guard. A real
  ReadableStream errors with `signal.reason` when the actual probe timer aborts.
  Baseline exits 1 with `AbortError: This operation was aborted` and the exact
  `strength-two-probes.ts:436` frame from the incident. The read catch already
  maps timeout correctly; its detached `reader.cancel()` rejects on the errored
  stream, escaping that catch. A second test rejects body-size cancellation.
- Guard acceptance tests changed before implementation: 26 failures / 2 pass.
  `/tmp/FLY-2917-rework-red.log`. Both cleanup branches now consume cancellation
  rejection while retaining the primary timeout/body-too-large outcome. No retry,
  success, or registry-invariant behavior changed.
- First green attempt: 66 pass, 1 assertion failure. Synchronous exceptions still
  terminate, but throwing from the strict-mode exception listener yields Node
  exit 7 rather than the old exact exit 1. The assertion now checks nonzero exit
  and original error, in both throw and strict modes. This changes no production
  policy. `/tmp/FLY-2917-rework-green.log`.

### Current global policy and tradeoffs

Both existing entrypoints keep the same explicit installer. Every unhandled
Promise rejection logs `[Bridge] unhandledRejection source=process` plus original
call-site stack frames; reasons without readable frames receive an observation
stack. SDK message/query/variables/raw payload are not serialized. Non-Error and
hostile stack getters are covered. The retained historical module/export name
avoids package path churn; runtime SDK classification is removed.

Node strict mode emits uncaughtException with origin=unhandledRejection before
its Promise event. A narrowly origin-checked listener lets that event proceed;
synchronous exceptions rethrow and remain fatal. The disposer removes both of
its own listeners and leaves other listeners alone. Import remains side-effect
free. Existing uncaughtExceptionMonitor diagnostics are unchanged.

This accepts the Lead's availability-over-restart tradeoff: an orphaned invariant,
authentication, GraphQL, or programmer rejection keeps the process alive. It does
not retry or mark the failed operation successful, and logging does not prove the
Bridge's application state is healthy. Source-level catches remain primary.
Revert the two source changes to roll back; no schema migration or data rollback.

### Bounded consumer selection

`rework-consumer-audit.json.gz` records full-path, filename, parent-directory and
emitted-js-name `git grep -lF` searches, all 1,029 matched files, and a per-file
retain/exclude reason. Four direct caller suites cover the route, judgment runtime,
QA source and runtime collection. The allowlist also retains the guard, probes,
residue, and original fetch/thread path (10 total files). A temporary config keeps
the owning package setup/env/pool, clears child projects, and sets that exact
include list. `vitest list --filesOnly` confirmed all 10 before the related run.
No local full-package suite or full-CI request was run.

Commands and logs:
- `pnpm --filter "flywheel-teamlead..." build`: `/tmp/FLY-2917-rework-build.log`.
- `pnpm lint`: exit 0, 25 existing warnings, `/tmp/FLY-2917-rework-lint.log`.
- Owning-package `vitest related src/bridge/strength-two-probes.ts src/bridge/linear-transport-rejection-guard.ts src/bridge/__tests__/linear-transport-rejection-guard.test.ts --run --config /tmp/FLY-2917-rework-vitest.config.mts`: `/tmp/FLY-2917-rework-related.log`.
- Source/CLI/compiled boot: `/tmp/FLY-2917-rework-boot.log`.
- Package-onboard: `/tmp/FLY-2917-rework-package.log`.

No exported interface/types changed. Original QA's full-CI failure is historical;
new-head full CI, both crash scenarios in QA, and real Discord N-to-N acceptance
remain QA-owned. No production restart, merge, or deploy performed.

### Final local results for this revision

- Bounded related: **7 files / 96 tests pass**, no unhandled errors.
- Explicit related-graph exclusions (DirectEventSink, ChatThreadCreator, residue):
  **3 files / 147 tests pass**, `/tmp/FLY-2917-rework-direct.log`.
  Combined: **10 files / 243 tests pass**. Original fetch/thread path totals
  147 passing tests across related + explicit runs.
- Affected package and dependency build: exit 0. Startup source/CLI/compiled
  checks pass; package-onboard **36 pass / 0 fail**.
- Changed-file Biome check passed; full lint exit 0 with baseline warnings.
- Historical design gate 53914b92-2d82-4c23-8ac4-b02739d1aba0 was re-read and is
  effective APPROVED; the current Lead instruction explicitly overrides the
  earlier narrow global policy. New code review is requested on the pushed head.
