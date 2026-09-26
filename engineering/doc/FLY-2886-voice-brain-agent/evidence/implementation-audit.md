# FLY-2886 implementation self-audit

Issue: FLY-2886
日期: 2026-09-26
基于: approved plan.md v10 and current shared implementation worktree; local source/caller inspection and focused tests. This is not the registered cross-family review, live QA, or deployment approval.

## Confirmed gap corrected during this audit: C5 / §6.3

Before correction, ThreadEventRouter extracted only spoken segments; Backend forwarded terminal unchanged; BrainCoordinator queued those segments without validateSpokenScript. The optional onItemCompleted callback was not connected in Backend. Therefore final-answer IDs could be spoken without any supporting tool output, and text-version material disappeared.

Corrected caller graph: process notification -> ThreadEventRouter completed item (stable itemId) -> Backend per-turn completed command aggregatedOutput / MCP result only -> completed terminal sources plus admitted context snapshot and trusted roster -> BrainCoordinator adds attached founder transcripts -> validateSpokenScript -> arbiter. Neither agent final messages nor text versions enter source C. Router now preserves text versions. Thread publication is awaited before pointer speech; failed publication and in-flight close retain material for minutes. Tell publication failures likewise retain original material after fallback speech. Session Journal snapshots remain fsynced before arbiter close.

Evidence: /tmp/fly2886-c5-red.log and /tmp/fly2886-c5-sources-red.log -> /tmp/fly2886-c5-green.log (6 files, 94 tests passed); /tmp/fly2886-c5-context-green.log (24 passed); /tmp/fly2886-c5-roster-green.log (authoritative roster assertion); /tmp/fly2886-c5-tell-minutes-red.log -> /tmp/fly2886-c5-tell-minutes-green.log. Voice tsc passed /tmp/fly2886-c5-final-types.log. Teamlead tsc at that instant reported only concurrent github.ts PullData.body work; container agent was notified.

## Remaining concrete gaps found (owners notified)

1. C9 actual admitted capability categories never reached the opening brief. voice-session-services.ts:363-367 supplies capabilityCategories:[] and a hard-coded reserved list. The comment promises a parent replacement, but CodexVoiceContainer used snapshot.realtimePrompt directly. Thus an admitted parent still advertises an unavailable tool list. speech_wiring now owns this correction; this audit does not certify its later edits.
2. C9 state-read failure aborts the whole context/session. voice-session-services.ts:309-315 catches generateBootstrap failure and throws context_state_unavailable; plan §5.4 requires truthful unavailable sections and usable fixed opening context. speech_wiring now owns the enabled-only fallback correction.
3. §4.5 founder-only denial workflow is not connected. lead-capability-proxy.ts:200 returns operation_not_in_manifest and broker.ts:183-186 returns reserved_operation, but there is no production founder_only_denied/unavailable/invalid classifier, attention-card lookup, or denial mailbox receipt path in voice-codex. Prompt-level prohibition and catalog exclusion prevent normal direct reserved tool use; they do not implement the specified factual spoken response/receipt flow. Root notified.
4. §3 repeat obligations do not yet carry prior obligation identity/ledger in an ordinary new background request. Backend.registerBackgroundHandoff stores only the current utterance/intent/current turn; failure fallback does include full session ledger, but a founder repeating an unconfirmed request is distinct from that fallback. BrainCoordinator stores only previous terminal turnId/time/write booleans. Newly-created write receipts now feed those booleans; the ledger has no durable turnId, so reused historical request IDs are not a proved per-turn association. Root should assess the approved repeat-reconciliation requirement before claiming complete coverage.

## C1-C12 source wiring check

| Component | Observed production wiring and boundary |
|---|---|
| C1 | Explicit voice-capability spawn profile retains managed capability env while admitting realtime API key. Container reads account.type=chatgpt, effective config, skills and MCP discovery before thread startup; thread receipt checks flywheel-lead-v2 and ephemeral/cwd/build. Actual 0.156.1 native tree collected and registered; canonical host baseline installation remains a deployment prerequisite, not performed here. |
| C2 | Voice parent uses separate activation and persistent session journal, auth/config sole constructor, begin/end delivery binding, shared broker facade. Root owns locks/reconciliation proof; this audit does not duplicate that review. |
| C3 | runtime-factory branches off to model-only egress proxy with no browser handlers/server; founder mode attaches upstream through BrowserWorker/facade/broker; isolated remains Seatbelt. Effective config and tools/list are mode checked. Browser webpage founder-only prevention remains rule-level; no structural claim. |
| C4 | GenericVoiceSession owns BrainCoordinator and SpeechArbiter; waiting cues and result/tell/fallback share that floor. Current C5 preserves pending async result material through close. |
| C5 | Corrected above; completed tool outputs/loaded snapshots/attached founder inputs support protected tokens; final answer/text version excluded. |
| C6 | Separate subscription scribe process, disabled tools config plus empty MCP discovery, ordinary startup rewrite, 15s interrupt and stale-result handling. Roster is now supplied from Bridge and merged into rewrite validation. |
| C7 | Router is process-level, independent of realtime generation; container installs begin/end context callbacks; Backend now wires completed items too. |
| C8 | Enabled speech uses best_effort and shared arbiter; disabled required verification remains. Spoken receipts are not inferred from text alone. |
| C9 | Trusted three-layer prompt/token budget/roster present; category admission and failed-state fallback findings assigned to speech_wiring. |
| C10 | Durable background ring/natural-generation reload present; live append remains disabled pending build-bound QA. No live-append production claim. |
| C11 | Parent actionLedger survives close; failure handoff carries successful/not-executed/unknown recovery policy; fsynced close snapshot + final minutes contain unplayed/action ledger. Root owns broker-to-Bridge durable mailbox action events. |
| C12 | StateStore claim three-state result is translated by route to non-claimable status; daemon claim exception continues to next outbound unless lease/session authority is lost (daemon.ts:906-918). |

## Limits

No production or external calls, no new model session, no formal review/gate, no commit or push. Existing rendered minutes are a 16k excerpt; full materials remain in durable JSON. Tests prove the local composed boundaries only; founder Chrome attachment, real-room speech and deployment prerequisites remain QA/deployment work.
