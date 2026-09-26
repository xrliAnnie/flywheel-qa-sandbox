# Browser modes, pinned baseline, and close ledger evidence
Issue: FLY-2886 (https://linear.app/geoforge3d/issue/FLY-2886)
日期: 2026-09-26
基于: ../plan.md

Local focused evidence only; no production session, founder Chrome action, commit, push, or full package test suite was run by this subtask.

## Browser and parent

- Browser modes founder_chrome / isolated / off propagate through the facade, manifest, effective MCP config and lifecycle. Off retains model egress restriction. Founder Chrome attaches with --auto-connect --channel=stable; founder-only webpage prohibitions remain rule-level, not structural guarantees.
- Six browser-related files: 49 passed. Log: /tmp/fly2886-browser-modes-green.log. Actual founder upstream tools/list inventory verified with a temporary HOME; no browser tool invocation or founder Chrome smoke.
- Codex 0.156.1 baseline was collected from the actual installed aarch64 binary using app-server with stdin EOF and empty temporary HOME/CODEX_HOME. No auth, model turn, or production config mutation. 60 resource files and six SKILL source hashes matched the registered tree.
- Capture: /private/tmp/fly2886-native-01561-0htvb3q3/capture.json and codex-home/skills/.system (made read-only). Verification: /tmp/fly2886-native-origin-canary.log. The canonical production baseline origin was not materialized; deployment still needs that existing prerequisite. 0.157.0 is not admitted.
- Parent owns fresh home auth symlink/config and durable stateDir/voice-capability/sessionId/journal.db. beginTurn/endTurn maintain durable observed-turn context; no frontend playback proof is fabricated. Parent/native focused 13 passed: /tmp/fly2886-parent-native-green.log.

## Action ledger and minutes

- receipts.listByActivation scopes project, Lead and activation; projection includes writes only, preserves requestId/operationId/targetKey/state/errorCode, and maps outcomes to succeeded/not_executed/unknown. Parent getter freezes a final snapshot before DB close and remains callable afterwards.
- Background failed/interrupted/session-error fallback carries the original durable authorized utterance plus full action ledger and explicit recovery policy. Success must not repeat; unknown must reconcile first. Repeated failure callbacks do not send duplicate handoffs.
- Session freezes active/queued/rewrite-pending speech and unfinished obligations, fsyncs close_snapshot to the existing session journal before aborting the arbiter, then final minutes collects the quiescent action ledger after container close. Snapshot survives failed finalization. No delivery state is fabricated.
- Existing rendered minutes remain a 16k excerpt; full ledger and unplayed snapshots remain in durable JSON. Oversized payload validation remains fail-closed.

## Red / green

- /tmp/fly2886-action-ledger-red.log, /tmp/fly2886-action-outcomes-red.log -> /tmp/fly2886-action-ledger-green.log (7 passed).
- /tmp/fly2886-failure-ledger-red.log -> /tmp/fly2886-ledger-room-green.log (25 passed); handoff payload tests passed in the combined run.
- /tmp/fly2886-unplayed-red.log, /tmp/fly2886-session-freeze-red.log -> /tmp/fly2886-ledger-close-green.log (five files / 68 passed; that run also recorded one room sync-regression subsequently fixed and all 25 room tests rerun green).
- /tmp/fly2886-preclose-journal-red.log -> /tmp/fly2886-preclose-journal-green.log (focused close-failure retention test passed).
- /tmp/fly2886-ledger-final-teamlead-types.log and /tmp/fly2886-ledger-final-voice-types.log: typechecks passed.
- Biome check of 17 files and git diff --check passed. Shared C6 cue/repeat changes were implemented by speech_wiring and preserved.
