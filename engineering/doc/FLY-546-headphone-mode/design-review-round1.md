# Design Review — FLY-546 plan.md (Round 1)

Date: 2026-07-07
Author: Codex
Status: CHANGES REQUESTED

## Summary
The overall architecture is feasible: the plan correctly keeps the queue/FSM in `voice-core`, reuses the existing approval-signal write path, and defers actual VC wiring until the FLY-545 five-interface contract exists. I would not approve implementation yet because the voice ship-approval route is not fail-closed under the current `/api` auth semantics, and the daemon/tap design does not yet guarantee durable FIFO coverage across crash/restart.

## What's Good (Keep)
- The FLY-545 decoupling is sound: M-A/M-B1/M-B2/M-B3 can be built with injected I/O, and M-B4 is explicitly gated on an ask to Tadashi before importing or adapting the parallel branch.
- The `voice-core` extension seam is real. `AnnouncerOptions.voice` and `TtsEngine.synthesize(text, voice, opts)` currently take a string, while `EdgeTtsEngine` only appends `--voice`; adding `VoiceSpec` plus optional `--rate/--pitch` is a small, testable extension.
- The approval reuse direction is correct. `ApprovalSignal` already reserves `source: "voice"`, and `writeGateResponseAndRunPostWrite` is the right single write primitive because it re-checks the approve_to_ship checkpoint, live review binding, status, and idempotency.
- `leads[].voice` belongs in `ProjectConfig`; the existing validator style already supports optional, non-normalized fields with precise `leads[i]` error messages.
- The v1 product discipline is mostly preserved: exact phrase matching, pure FIFO, no NLP classifier for voice approval, default-off voice approval, and no priority system.

## Issues & Recommendations
1. **Voice ship-approval auth is not fail-closed if `TEAMLEAD_API_TOKEN` / `config.apiToken` is absent.**

   Why it matters: the plan says to mount `/api/voice/*` inside the `/api` Bearer middleware, but in current code `tokenAuthMiddleware(config.apiToken)` is a no-op when the token is unset (`packages/teamlead/src/bridge/plugin.ts:600-603`). That is acceptable for some legacy read-ish routes, but `POST /api/voice/ship-approval` writes founder authority. The existing founder-consent gate-response route already handles this exact problem by returning 503 when no api token is configured (`plugin.ts:1429-1445`).

   Suggested fix: make `ship-approval` require both `FLYWHEEL_VOICE_APPROVAL=1` and a configured api token. No token should return 503/disabled before any body processing, even if the voice flag is enabled. Add tests for: no bearer -> 401 when token exists; no configured token -> 503; voice flag off -> 403; token + flag + valid binding -> write path. The daemon should also fail-fast if `bridgeTokenEnv` is missing when voice approval is enabled.

2. **Daemon crash/restart handling is not durable enough for the "all Lead messages, FIFO" contract.**

   Why it matters: B2 only describes live `messageCreate -> queue.push -> persist` and `daemon restart -> restore snapshot` (`plan.md:232-236`). A gateway tap does not receive messages posted while the daemon is down, so those messages are silently lost. Separately, a crash after `sendReply`, `postReceipt`, or `submitApproval` but before queue state advances can duplicate founder-proxy replies or receipt cards on restart. The approval write itself is mostly idempotent, but the surrounding Discord side effects are not specified.

   Suggested fix: add a recovery ledger before implementation. Persist per-channel `lastSeenMessageId` / snowflake cursor and backfill Discord history for every scoped channel/thread on startup and reconnect. Persist state atomically (`tmp + fsync + rename`, 0600, schema version, corrupt-state quarantine/fail-loud). Track each queue item's side-effect phase and ids (`sentMessageId`, `receiptMessageId`, `approvalAttemptId`) so restart resumes or suppresses duplicates deterministically. Add crash-point tests around reply, receipt, and approval.

3. **The ship-gate FSM branch does not yet line up cleanly with PRD §17's worked example.**

   Why it matters: PRD §17 says every item is one full turn and gives the c档 flow as message -> Annie says "ship 吧" -> system readback -> Annie says "确认" (`prd.md:415-429`). The plan table jumps a `ship_gate` item from `announce_done` directly to readback / `awaiting_approval_confirm` (`plan.md:174-185`). That may be a valid simplification if a bound gate message is treated as the approval prompt, but then the plan's "PRD §17 逐字 worked example" test is not actually testing the PRD example. The table also introduces long-message "要听全文吗?" behavior without rows for the detail/decline branch.

   Suggested fix: choose one contract and write it explicitly. Either model c档 as `awaiting_disposition -> APPROVE_INTENT -> readback -> CONFIRM`, with exact phrase sets for `APPROVE_INTENT`, or state that bound ship-gate messages bypass generic "要回吗?" and require only the final exact `CONFIRM`. Then update the §17 worked-example test text to match. Add table rows for long-message detail handling, unclear utterances in approval confirm, stop-word during approval confirm, and "暂停/待会" deferral if it remains in scope.

4. **The tap allow-set is underspecified for founder-facing gate/system messages.**

   Why it matters: B1's filter includes Lead bot IDs in scope channels, @founder fallback, optional roundtable, and self-exclusion (`plan.md:136-140`). Most normal Lead messages fit that, and gate-poller usually posts fallback ship-gate messages using `lead.botToken ?? discordBotToken` (`gate-poller.ts:1479-1484`). The fallback matters: if a project lacks a per-Lead bot token or a future founder-facing system/announcer message is in scope, the current filter can miss it. Missing a ship-gate notification means the c档 voice approval branch never appears.

   Suggested fix: define a Bridge-provided source/scope contract instead of having the daemon infer it ad hoc. Include per-Lead bot user IDs, any global fallback/announcer bot IDs that post founder-facing gate messages, scoped channel/thread IDs, and whether roundtable is included. For gate messages, prefer classification by durable `gateMessageId` binding even if the author is not in `leadBotIds`. Add tests for per-Lead bot, fallback global bot, bound ship-gate message, @founder fallback, roundtable default-off/on, and self echo exclusion.

5. **`/api/voice/context` needs a sharper lookup contract for thread vs top-level channels.**

   Why it matters: `StateStore` has usable thread reverse lookup (`getChatThreadByThreadId`) and legacy phase lookup, but the current converged model says `chat_threads` is the primary source and `phase_chat_threads` is legacy (`StateStore.ts:4004-4008`, `4040-4087`). A raw `channelId` can be a Discord thread id, a Lead top-level `chatChannel`, `generalChannel`, or roundtable. Only the thread id case can reliably produce issue/stage context; top-level channels may only identify a Lead/channel, not an issue.

   Suggested fix: specify the endpoint semantics as `channelId` + optional `parentChannelId` / Discord channel type. Return a typed context such as `{kind:"issue_thread", ...}` vs `{kind:"lead_channel", agentId}` vs `{kind:"unknown"}` rather than overloading 404. Keep the daemon's "context miss still enqueue with degraded header" behavior, but make that degradation explicit and test it.

## Verdict
CHANGES REQUESTED — address items above
