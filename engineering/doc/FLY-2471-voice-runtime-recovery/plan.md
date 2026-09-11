# FLY-2471 语音运行恢复 — 实施计划
Issue: FLY-2471 (https://linear.app/geoforge3d/issue/FLY-2471)
日期: 2026-09-10
基于: research.md

## Bounded contract

Address only the two assigned MEDIUM follow-ups. Preserve public voice routes, durable schema, provisioning epoch/nonce recovery, poll cadence and Discord status text. Other PR #1140 advisories remain outside scope. No production mutation, restart, merge or QA dispatch.

## 1. Provisioning isolation

- Extend runtime provision callback with an AbortSignal. Give each runtime attempt a 30-second total deadline (internal injectable timeout for deterministic tests), catch/log failures per session and continue remaining work. This is a bounded latency policy, not a measured Discord percentile: it matches the existing 30-second root nonce window and is below the 120-second stale takeover delay. A slow chain can exhaust this budget.
- Race the callback against the deadline so an abort-ignoring dependency cannot retain the runtime lock. Clear deadline timers in finally and consume late rejection. Keep the existing outer tick finally and overlap guard.
- Catch/deadline ownership stays exclusively in voice-session-runtime.ts. Services continues propagating errors to the HTTP router. Pass the optional signal from services to runVoiceProvisioner and a per-attempt fetch wrapper. Combine it with any helper request signal; reject before starting a new fetch after cancellation.
- Add optional signal to the reducer; check before claim/each step and at error handlers before writing failure state or retrying. A successful awaited external mutation must first persist its completed step/receipt through existing updateVoiceProvisioning with the same epoch and expected-step guards, THEN honor cancellation before another effect or finalization. This includes rootMessageId, threadId and memberAddedAt. Existing cancellation receipt salvage remains active. A late success may record this one completed step; it must not initiate the next effect or make the session desired. A stale owner cannot override a new epoch.
- captureCursor is a read and explicitly excluded from salvage. If aborted while awaiting captureCursor, throw before the reserved-to-root_requested write: leave the row reserved, root_requested_at null, and no provisioning nonce/orphan candidate added. Stale takeover may recapture the cursor and proceed normally. The possible later cursor is an accepted limitation; never arm a root retry window for a root request that cannot be started.
- Not every timed-out root is recoverable: when abort yields no root receipt, the outcome is unknown. Preserve the frozen 30-second nonce safety window and orphanCandidates behavior; after 120-second stale takeover, an unresolved root fails as provisioning_root_unknown rather than reposting. No reaper, retry-window extension or ownership bypass. A late successful root receipt received while the epoch is current advances to thread_requested before stopping, so takeover resumes without reposting that known root.
- TDD: throwing first candidate does not starve later work or the next tick; never-settling candidate aborts by deadline and releases lock; timers clean up on fast success/failure; late reject is handled. Cancellation before start and during failure/cancel cleanup must not commit terminal failure; late successful mutations salvage guarded receipts before stopping. Test reserved-step timeout followed by stale takeover reaching desired, without a premature root window or phantom orphan. Test both known-root replay under a fresh epoch and unknown-root conservative failure. Verify real fetch receives cancellation.

## 2. Poll failure status backoff

- voice-session-runtime.ts owns the catch and process-local map with one record per actively leased session: latest reason, next notification deadline and next delay. Services retains the unchanged reporter effect.
- First failure reports immediately; repeats send no more often than 30s, 60s, 120s, 240s, then 300s maximum spacing. Poll execution itself continues every tick.
- Success clears the record; changed reason updates the record but preserves backoff because the rendered status text is identical; prune sessions no longer actively leased. Runtime restart starts a fresh rate-control epoch.
- Reserve cooldown before reporting; catch/log report rejection so it cannot abort other sessions or bypass backoff. Preserve session state and existing status content.
- TDD: repeated reason suppression, exact delay boundaries and cap, changed reason, success/reset, independent sessions, expired session cleanup, reporter rejection and continued polling. All tests use injected clocks/effects and temporary stores.

## 3. Verification and handoff

Run src/bridge/__tests__/voice-session-runtime.test.ts and voice-session-provisioner.test.ts including existing replay/epoch/cancellation tests. Add voice-session-services.test.ts for actual runtime-to-fetch cancellation wiring and preserved HTTP error propagation; this file does not yet exist. Record RED then GREEN for each behavior batch. No schema migration or rollback migration is needed; reverting the code restores prior behavior, and unchanged durable rows remain readable across restart.

Run exact full gates: pnpm lint; pnpm -r build; pnpm test:packages:run; every newly added scripts/__tests__/*.test.sh (none planned). Record unrelated failures honestly and ask Lead for disposition when required. No rendered surface changes, so no visual proof is claimed.

Commit small batches and update the progress ledger. Register review_code gate and request-review through the injected runner route; fix blocking findings and obtain a fresh approval. Follow codex:rescue role requirements where available, never raw codex exec. Add engineering/doc/milestones/FLY-2471.md as the literal final commit, push the feature branch normally, open the PR, and bind required review to its final HEAD. Report evidence to Lead and complete --route needs_review --pr <number>; phase keep-alive then parks as directed by the completion response.

## Review-round clarifications

Runtime-only signal propagation is necessary for this timeout. The HTTP provision/preflight path remains unbounded as an explicitly deferred advisory. Provision pre-claim log coalescing remains outside the two assigned fixes; no extra terminal state policy is added. On this shared macOS host, full test execution requires excluding **/tmux-viewer.macos.test.ts to avoid real Terminal.app effects. Request Lead authorization for that exact-gate exception and retain the receipt rather than representing an excluded run as the unmodified full gate.

## Follow-ups (Lead-only documentation addendum after R3 approval)

The approved implementation scope is the plan blob in commit 6fbe41ca1. This addendum records Lead instruction 94bc78ca-125b-4ca3-83e8-ca656ade7c6d; it adds no implementation work and opens no issues. All seven R2 advisories below are deferred:

- deadline-stall-tripled-for-live-polling: sequential candidate deadlines can delay live polling by candidate count times 30 seconds.
- cancel-cleanup-abort-duplicates-notice: an interrupted cancellation cleanup can repeat its notice on takeover.
- member-failure-branch-not-an-error-handler: the !added branch needs cancellation scrutiny; no separate transient-member policy is authorized.
- deadline-clock-starts-before-root-window: equal duration does not align the attempt and root-window start times.
- services-test-reads-production-voice-host-config: retain hermetic test fixtures; no production config redesign.
- late-salvage-ratchets-takeover-clock: successful late receipts refresh updated_at and delay subsequent takeover.
- provision-failure-no-coalescing: pre-claim configuration errors can retry/log every tick.
