# FLY-2917 Linear rejection — 调研
Issue: FLY-2917 (https://linear.app/geoforge3d/issue/FLY-2917/病根bridge-崩溃-linear-sdk-的fetch-failed未被接住-unhandledrejection-把整个-bridge)
日期: 2026-09-25
基于: exploration.md

## Mechanism

Pinned SDK `@linear/sdk@60.0.0/dist/index-es.js:140851,140905` implements `Issue.project` and `Issue.state` with `new ...Query(this._request).fetch(...)`. Accessing a getter is a network operation; testing the promise's truthiness does not attach a rejection handler. `await issue.project` also works when the optional relation is absent.

SDK `parseLinearError` preserves an existing LinearError, maps 5xx (except 500) to NetworkLinearError, and maps a response-less fetch exception to UnknownLinearError. The wrapper retains `raw`, status, and GraphQL errors. Therefore `instanceof NetworkLinearError` alone misses the observed `Fetch failed`; matching any Error by message alone would wrongly swallow other subsystems' failures.

The current entry point installs only `uncaughtExceptionMonitor`, conditional on rotating stdio. This records an error without preventing default process termination. See [Node process documentation](https://nodejs.org/api/process.html#event-unhandledrejection) and [Linear error source](https://github.com/linear/linear/blob/master/packages/sdk/src/error.ts); pinned local SDK code remains authoritative for implementation.

## Options and tradeoff

1. Fix only the two relation reads (using synchronous projectId where only the id is needed): smallest causal repair, but another overlooked Linear transport promise can still take Bridge down.
2. Fix the reads plus a narrow SDK-typed transport-only process guard: chosen to satisfy issue item 3. Keep local catch/retry behavior primary. Record a fixed diagnostic without serializing request variables, GraphQL contents, or credentials. The guard does not retry unknown operations or mark them successful.
3. Catch every unhandled rejection: rejected because programmer, authorization, and invariant errors would leave the daemon running in uncertain state.

The guard accepts a NetworkLinearError without GraphQL errors, or an UnknownLinearError with no HTTP status/GraphQL errors whose raw Error is exactly `fetch failed` (case insensitive). Everything else is rethrown. Real child processes will prove both continued liveness and fatal negative cases. Node strict rejection mode intentionally remains fatal; the guard targets the deployed default throw mode and will not install an uncaughtException recovery handler.

## Audit

Read-only audit starts at all `@linear/sdk` imports/constructors in `packages/teamlead/src/bridge`, plus the bridge's lead-capability SDK adapter/handlers. The final inventory will record all boundaries and changes in `verification.md` and the PR. No unrelated promise cleanup or SDK upgrade is in scope.

## Review-verified runtime boundaries

The guard belongs to teamlead, since packaged payloads can have root SDK 64 plus teamlead SDK 60. A scripts-relative module would both miss package-onboard import rewriting and classify the wrong SDK instance. Both entrypoints install explicitly; library imports have no global side effects. Plain rawRequest transport TypeErrors and capability `linear_provider_unavailable` wrappers intentionally remain fatal if orphaned; all such calls must retain local awaited ownership. Unknown/non-Error rethrows report uncaughtException monitor origin; non-Error reasons receive an unhandled-rejection Error wrapper. No full local graph run is allowed for the run-infra hub.
