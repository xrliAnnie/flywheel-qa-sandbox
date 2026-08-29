# FLY-1269 529 E2E — QA round-4 runtime evidence
host: MacBook-Pro.local | node: v25.6.1 | updated UTC: 2026-07-15T13:46:44Z
tested source commit: 864303e2c959a3cdaf364f414524ae6ae5ac714f | branch: project-slot-2-FLY-1286

## StateStore sessions (test-slot-2 teamlead.db)
[{"execution_id":"464064c0-a711-4aa7-9426-5633dcef590d","status":"design_done","adapter_type":"codex-tmux","chat_thread_role":"design","runner_model":"gpt-5.6-sol","heartbeat_at":"2026-07-15 13:25:04"},
{"execution_id":"1ba0f0f1-928c-4aaa-aa5f-5782a54a37ad","status":"awaiting_review","adapter_type":"codex-tmux","chat_thread_role":"implement","runner_model":"gpt-5.6-sol","heartbeat_at":"2026-07-15 13:25:04"},
{"execution_id":"aad2f2a7-ad02-4e34-b933-7ae539af1dfa","status":"running","adapter_type":"claude-tmux","chat_thread_role":"qa","runner_model":"claude-opus-4-8","heartbeat_at":"2026-07-15 13:25:02"}]

## three_stage_turn (FLY-1286)
[{"phase":"qa","holder_exec_id":"aad2f2a7-ad02-4e34-b933-7ae539af1dfa","epoch":7}]

## declared_states
[{"execution_id":"1ba0f0f1-928c-4aaa-aa5f-5782a54a37ad","kind":"parked","reason":"three-stage implement parked after QA FIX round 1; QA owns TURN epoch 7"},
{"execution_id":"464064c0-a711-4aa7-9426-5633dcef590d","kind":"parked","reason":"FLY-1286 WAKE_PROBE handled; three-stage design parked until ship"}]

## phaseHold (session.json)
464064c0-a711-4aa7-9426-5633dcef590d {"schemaVersion":1,"role":"design","enteredAt":"2026-07-15T11:27:00.624Z","deadlineRemainingMs":86399995,"hardDeadlineRemainingMs":173241918,"state":"paused"}
1ba0f0f1-928c-4aaa-aa5f-5782a54a37ad {"schemaVersion":1,"role":"implement","enteredAt":"2026-07-15T13:05:23.365Z","deadlineRemainingMs":86399995,"hardDeadlineRemainingMs":170585106,"state":"paused"}

## native goals (paused, frozen budget; authoritative live reads)

Both samples used `sqlite3 -readonly <live goals_1.sqlite> "PRAGMA query_only=1; SELECT ... FROM thread_goals ..."`.
No sample used `immutable=1`. The recovered Design DB had no active WAL owner, so a temporary
SQLite connection was kept open with `PRAGMA query_only=1` only to establish WAL shared-memory;
the two evidence queries themselves were separate `-readonly` connections against the live DB.

- sample A `2026-07-15T13:44:19Z`
  - design: `paused`, tokens `565978`, time `3156`, updated_at_ms `1784114820643`
  - implement: `paused`, tokens `949749`, time `5843`, updated_at_ms `1784122323318`
- sample B `2026-07-15T13:45:32Z`
  - design: `paused`, tokens `565978`, time `3156`, updated_at_ms `1784114820643`
  - implement: `paused`, tokens `949749`, time `5843`, updated_at_ms `1784122323318`

## Implement xhigh (argv on socket 6d3a98f097b21829)
model_reasoning_effort="xhigh"
TUI: gpt-5.6-sol xhigh · …project-slot-2… Goal paused (captured live)

## Observer regression (full committed 529 harness, 19 tests)

- RED evidence: the prior committed short-deadline harness produced `13/19`; the six failures were
  `cleanup_not_observed` / `observer did not exit` timeout artifacts on the loaded 529 host.
- Commits `3b183e70` and `864303e2c959a3cdaf364f414524ae6ae5ac714f` raise only fixture
  observer/wait/exit/test deadlines, including the explicit lifecycle-cleanup case identified by
  round-6 review. They do not change observer production defaults, probe behavior, or assertions.
- Exact committed command:
  `node --test engineering/doc/FLY-1269-codex-phase-keepalive/qa/529-terminal-observer.test.mjs`
- Final exact-source run window: `2026-07-15T13:54:28Z` → `2026-07-15T13:55:28Z`; Node duration
  `60139.824833ms`; result `19 pass / 0 fail`.
- C1/C2/C3 tests (fail-closed indeterminate, transient retry / bounded fail-close, timestamped
  holder evidence) are included in those 19 committed tests and all passed.

## 73s two-sample freeze (13:44:19 -> 13:45:32)

- design: authoritative readonly goal values stayed `paused / 565978 / 3156 / 1784114820643`;
  heartbeat advanced `13:44:20` → `13:45:30`; socket holder stayed pid `88885`.
- implement: authoritative readonly goal values stayed `paused / 949749 / 5843 / 1784122323318`;
  heartbeat advanced `13:44:19` → `13:45:29`; socket holder stayed pid `54044`.
- Observer source: `/tmp/fly1286-terminal-ec8f6b7e-epoch7.jsonl`, samples at
  `2026-07-15T13:44:20.140Z` and `2026-07-15T13:45:33.235Z`.
