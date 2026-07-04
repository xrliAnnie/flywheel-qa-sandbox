# Integration Test Suite — FLY-161 `runner_question` Bridge Event

**Feature**: Validate that `flywheel-comm ask` (non-blocking Runner question) flows end-to-end through the GatePoller → `runner_question` event → Lead inbox → Annie chat thread, including the completed-session edge case.

**Plan**: `doc/engineer/plan/inprogress/v1.28.1-FLY-161-runner-question-event.md` (Codex APPROVED Round 6)

**Tool**: Chrome Discord observation (Claude-in-Chrome MCP — Annie's Discord session is the only source of truth for what the Lead actually surfaced) + direct CommDB inspection + `pnpm bridge:logs` tail.

**Environment**: 4-slot test slot infrastructure (`scripts/test-deploy.sh`), sandbox repo `xrliAnnie/flywheel-qa-sandbox`, sandbox issue `FLY-SBX-1`.

## Scope (Annie-confirmed pre-implement)

- **A scope**: validate the NEW `runner_question` flow shipped in v1.28.1
- **Manual trigger**: Annie or a test conductor spawns this QA agent (no auto-trigger via PR / `:cool:`)
- **Coverage**: 1 happy path + 1 edge case (completed-session ask)
- **0 framework changes** outside this suite spec

## Prerequisites

- 1 free test slot (1–4) — `~/.flywheel/test-slots.json`. Slot 3 (lead-test-3) recommended for parity with the mirror-channel infrastructure (FLY-153).
- v1.28.1+ Bridge deployed to the slot. Confirm `doc/VERSION == v1.28.1` in the source tree and the slot's `bridge.log` shows `[GatePoller] Started`.
- A test Lead daemon running for `lead-test-{N}`.
- A real Runner spawn in the slot's F1 sub-slot (see FLY-115 framework).
- Annie's Chrome logged in to Discord; the QA conductor has access to the slot's chat channel (`chat-test-{N}`).
- `flywheel-comm` available as a CLI shim inside the Runner shell (Blueprint should inject `node ${commCliPath} ask` — verify by `grep "ask --lead" ${SLOT_DIR}/runner-*.log`).

## Channel & Execution Map (per slot, identical to FLY-60)

| Entity | Location |
|--------|----------|
| Test Lead | `lead-test-{N}` Discord identity |
| Test chat channel | `chat-test-{N}` (per-slot, from `test-slots.json`) |
| StateStore | `${SLOT_DIR}/teamlead.db` |
| CommDB | `~/.flywheel/comm/test-slot-{N}/comm.db` |
| Bridge log | `${SLOT_DIR}/bridge.log` |
| Lead supervisor log | `${SLOT_DIR}/lead.log` |
| Runner tmux | `runner-{slot-project-name}` |

## Scenario HP — Happy Path: ask while Runner is alive

1. Spawn a real Runner in F1 against `FLY-SBX-1`. Wait for the brainstorm gate to clear and the Runner to enter the implement phase (so the session is in `running`).
2. In the Runner pane, run:
   ```
   node $FLYWHEEL_COMM_CLI ask --lead lead-test-{N} --exec-id ${EXEC_ID} "FLY-161 QA: should the sandbox README write the timestamp in UTC or local time?"
   ```
   Then **immediately** continue with a dummy file edit (the Runner must keep working — this is the non-blocking contract).
3. Within ~3s (one GatePoller tick), verify a `runner_question` row appears in the Bridge state store:
   ```
   sqlite3 ${SLOT_DIR}/teamlead.db "SELECT seq, event_type, event_id FROM lead_events WHERE event_type = 'runner_question' ORDER BY seq DESC LIMIT 1;"
   ```
   Expected: `event_type = runner_question`, `event_id LIKE 'runner_q_%'`, `delivered_at IS NOT NULL`.
4. Tail `${SLOT_DIR}/bridge.log` and confirm:
   - NO `skipping gate_question` warnings for this `qid` (sanity that we routed via the runner branch).
   - NO `orphan question` warnings.
5. **Chrome Discord observation** (mandatory — feedback_qa_must_use_claude_in_chrome): open `chat-test-{N}` in the chat thread for `FLY-SBX-1`. The test Lead should post (within ~5–10s of step 3):
   > `💬 FLY-SBX-1 Runner 在问：should the sandbox README write the timestamp in UTC or local time?（Runner 继续干活中）`
   Verify the emoji `💬` and the `继续干活中` framing — this is the non-blocking phrasing required by `department-lead-rules.md`.
6. As the test conductor (acting as Annie), reply in the same chat thread: `use UTC`.
7. The Lead should run `flywheel-comm respond --db ~/.flywheel/comm/test-slot-{N}/comm.db --lead lead-test-{N} <qid> "use UTC"`. Verify with:
   ```
   sqlite3 ~/.flywheel/comm/test-slot-{N}/comm.db "SELECT content FROM messages WHERE type = 'response' AND parent_id = '<qid>';"
   ```
   Expected: `use UTC`.
8. In the Runner pane, `node $FLYWHEEL_COMM_CLI check <qid>` should print `use UTC`.

## Scenario EC1 — Edge Case: ask, then Runner completes

This validates the Codex R1 / R2 fix: completed-session `ask` must survive in the Lead inbox (and in the bootstrap snapshot).

1. Spawn a fresh Runner in F1 against `FLY-SBX-1`. Allow brainstorm to pass.
2. Runner runs ask:
   ```
   node $FLYWHEEL_COMM_CLI ask --lead lead-test-{N} --exec-id ${EXEC_ID} "FLY-161 EC1: post-completion ask test"
   ```
3. **Before** the Lead/Annie answers, the Runner runs:
   ```
   node $FLYWHEEL_COMM_CLI complete --route success --summary "ec1 test"
   ```
   Session transitions to `completed`.
4. Within ~3s, verify a `runner_question` row was still emitted (the GatePoller picks up the question without depending on active-session state):
   ```
   sqlite3 ${SLOT_DIR}/teamlead.db "SELECT event_type, payload FROM lead_events WHERE event_id LIKE 'runner_q_%' ORDER BY seq DESC LIMIT 1;"
   ```
5. **Restart the Bridge** (`scripts/test-deploy.sh restart {N}` or equivalent). Inspect the bootstrap snapshot that the Lead receives — confirm the `### Pending Runner Questions` section lists the `FLY-161 EC1: post-completion ask test` content with the right `Chat-Thread` hint (when chat threads are enabled in the slot config).
6. Test conductor replies in chat: `noted`. Verify `flywheel-comm respond` was invoked AND `flywheel-comm check <qid>` from any shell returns `noted` (even though the Runner session is `completed` — `respond` still writes the CommDB response row).

## Failure modes to catch

- **a**: Runner ask, but Lead never receives → GatePoller filter regression OR active-session blind spot returned. Check `bridge.log` for `[GatePoller]` errors.
- **b**: Lead surfaces `runner_question` as a hard checkpoint (e.g. `[BRAINSTORM]` tag, "Runner is waiting" phrasing) → formatter regression in `mailbox-lead-runtime.ts` / `commdb-lead-runtime.ts`.
- **c**: Dedup failure — same `runner_question` chat message appears twice → `isLeadEventDelivered` short-circuit broken OR the GatePoller re-emitted with a fresh `event_id`.
- **d**: Cos-lead receives a `runner_question` (multi-lead deployment) but doesn't notify Annie → `cos-lead-rules.md` rule not deployed; check `~/.flywheel/lead-workspace/cos-*/CLAUDE.md`.
- **e**: Chat-thread hint points at the WRONG Lead's channel (cross-lead mis-route) → R4 Issue 1 regression in `bootstrap-generator.ts` `pendingRunnerQuestions` path.

## Evidence bundle

Each scenario should attach:

- `bridge.log` slice covering the ask → emit window
- `sqlite3` query output for the `lead_events` row
- Chrome screenshot of the Lead's chat-thread post (Discord)
- `flywheel-comm check` stdout from the Runner shell

## Exit criteria

- HP all 8 steps PASS
- EC1 all 6 steps PASS
- No `skipping gate_question` or `orphan question` warnings in `bridge.log` for the scenario questions
- No Discord-level cross-thread leakage (all Lead chat messages stay in the FLY-SBX-1 thread)
