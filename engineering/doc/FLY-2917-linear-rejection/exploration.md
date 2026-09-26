# FLY-2917 Linear rejection — 探索
Issue: FLY-2917 (https://linear.app/geoforge3d/issue/FLY-2917/病根bridge-崩溃-linear-sdk-的fetch-failed未被接住-unhandledrejection-把整个-bridge)
日期: 2026-09-25
基于: 无

## Scope and evidence

Implement TURN: epoch 2, activation `activation:438e82cb-163c-4bd7-913f-307746f1cab8:7649ac47-6b6b-414e-9ee2-a79344421106:implement:1`.
Initial branch `flywheel-FLY-2917`, clean at `923d7a551`. No upstream FLY-2917 documents were present; Lead question `3f922e5a-2fdc-4881-ba82-bdffa83dfcad` asks for any missing approved plan. This document supplies the injected full DOC-FLOW before implementation.

The live log at `/tmp/flywheel-bridge.log:105959-105971` contains the reported fallback, thread-create start, Linear SDK `Fetch failed` unhandled rejection, and fresh Bridge startup. The stack identifies the SDK error parser, not its application caller; it cannot uniquely attribute the historical promise.

`ChatThreadCreator.ensureChatThread` contains Discord and StateStore work, no Linear call. `DirectEventSink.emitStarted` awaits it inside a catch. Upstream `createFetchIssue` in `bridge/run-infra.ts:521` evaluates `issue.project ? (await issue.project)?.id : undefined`. SDK 60.0.0's lazy relation getter creates a fresh request per access. Its first promise is discarded; its second is awaited and caught. This explains how StateStore fallback can succeed before the discarded request kills the process during Discord I/O. A deterministic regression must demonstrate this mechanism before claiming the fix.

The same pattern occurs in `bridge/linear-issue-finalizer.ts:83` for `issue.state`. Existing plain-promise mocks conceal the duplicated request.

## Required result

- One owned promise per relation read, preserving StateStore fallback and finalizer fail-closed guards.
- SDK fetch rejection followed by real chat-thread creation, without an unhandled rejection or process exit.
- Audit remaining Bridge SDK calls and list callers/catch boundaries in the PR.
- Evaluate a narrow process guard for recognized Linear transport errors; unrelated unhandled failures remain fatal.
- Targeted local verification, effective code review, PR, registered `needs_review` completion. No service restart, deployment, QA dispatch, or merge.
