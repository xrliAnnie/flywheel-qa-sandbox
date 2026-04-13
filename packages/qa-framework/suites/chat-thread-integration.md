# Integration Test Suite — FLY-91 Discord Chat Thread Per Issue

**Feature**: System-level Discord thread creation per Linear issue
**PR**: #135 (Flywheel) + GeoForge3D #183
**Tool**: Chrome Discord observation (Claude-in-Chrome MCP)
**Environment**: claude's server (Discord)

## Prerequisites

- Bridge deployed with ChatThreadCreator + thread auto-add member
- At least 2 Leads online (Peter + Simba minimum)
- Annie account logged into Discord (for auto-add member verification)
- Chrome browser with Claude-in-Chrome extension active
- No circuit-breaker hook installed on Runner (removed in FLY-91 fix)

## Channel Map

| Lead | Channel | Channel ID |
|------|---------|------------|
| Peter - Product Lead | #geoforge3d-product-chat | 1485787822894878955 |
| Oliver - Ops Lead | #geoforge3d-ops-chat | 1485789342541680661 |
| Simba - Chief of Staff | #geoforge3d-core | 1487340532610109520 |

---

## TC-01: Thread Creation on New Issue

**Precondition**: A Linear issue (e.g., GEO-349) has never been assigned to this Lead before. No existing thread for this issue in the target channel.

**Steps**:
1. Assign a new Linear issue to Peter (via Linear delegation or `@Peter` in Discord)
2. Wait for Peter to process the issue (10-30s)
3. Observe #geoforge3d-product-chat main channel

**Expected**:
- Peter posts a `🧵 ISSUE-ID — Title` message in main channel with a thread link (🧶)
- A new thread is created with title format `[ISSUE-ID] Title` (e.g., `[GEO-349] [Backend] Post-processing 适配两产品线`)
- Thread appears in left sidebar under the channel
- Thread ID is registered in ChatThreadCreator's dedup map

**How to verify (Chrome Discord)**:
1. Navigate to #geoforge3d-product-chat
2. Screenshot main channel — confirm 🧵 message with thread link visible
3. Click thread link or sidebar entry — confirm thread title matches `[ISSUE-ID] Title`
4. Check thread member list — confirm Annie auto-added (Online count >= 2)

---

## TC-02: Thread Reuse on Same Issue

**Precondition**: TC-01 completed — a thread already exists for the target issue.

**Steps**:
1. Trigger the same issue again (e.g., ask Peter about GEO-349 again, or Runner posts update)
2. Wait for Peter to respond (10-30s)
3. Check #geoforge3d-product-chat main channel and thread

**Expected**:
- Peter posts a new 🧵 reference in main channel linking to the **same** thread
- Thread ID remains unchanged (same as TC-01's thread ID)
- No duplicate thread created
- New content appears inside the existing thread

**How to verify (Chrome Discord)**:
1. Screenshot main channel — confirm new 🧵 reference message
2. Click into thread — confirm Thread ID in URL matches TC-01 (e.g., `1493095219791532124`)
3. Scroll to bottom of thread — confirm new messages appended after TC-01's content

---

## TC-03: Thread Message Routing (Zero Main-Channel Leakage)

**Precondition**: Runner is actively working on an issue that has a thread.

**Steps**:
1. Start a Runner on an issue with existing thread (e.g., GEO-349)
2. Wait for Runner to go through lifecycle stages: start → brainstorm → blocked/gate → complete
3. Monitor main channel during entire Runner lifecycle

**Expected**:
- All Runner status notifications (🚀 start, 🌿 brainstorm gate, 🚧 blocked, ✅ completed) appear **only inside the thread**
- Main channel shows **only** the 🧵 thread reference link posted by the Lead
- Annie's manual messages in main channel remain in main channel (not redirected)

**How to verify (Chrome Discord)**:
1. Navigate to main channel (#geoforge3d-product-chat)
2. Screenshot — confirm no Runner notification messages (no 🚀, 🌿, 🚧, ✅ in main channel body)
3. Only 🧵 reference links from Peter should be visible
4. Click into thread — confirm all Runner notifications are inside thread

---

## TC-04: Thread Auto-Add Member

**Precondition**: Bridge deployed with thread auto-add member feature enabled. Annie account is online.

**Steps**:
1. Trigger a new thread creation (via TC-01 or new issue)
2. Wait for thread to be created (10-30s)
3. Check thread member list and sidebar

**Expected**:
- Annie is automatically added as a thread member
- Thread appears in Annie's Discord sidebar (left panel, under the channel)
- Member count shows >= 2 (Annie + Lead bot)

**How to verify (Chrome Discord)**:
1. Click into the newly created thread
2. Check "Online — N" member list on right side — Annie should be listed
3. Check left sidebar — thread title should appear under the channel without manual joining
4. Zoom into member list area if needed for verification

---

## TC-05: Thread Archive on Ship (Session Completed)

**Precondition**: A Runner has completed work on an issue and the session is marked completed/shipped.

**Steps**:
1. Wait for a Runner session to complete (or simulate by shipping a PR)
2. Observe the thread after session completion
3. Check left sidebar for thread visibility

**Expected**:
- Thread is archived by the Lead after session completion
- Thread disappears from active threads in sidebar
- Thread content remains accessible via search or direct link
- Main channel shows completion status (if applicable)

**How to verify (Chrome Discord)**:
1. After session completes, check left sidebar — thread should no longer appear under active threads
2. Use Discord search (`in:#channel [ISSUE-ID]`) to confirm thread still exists but is archived
3. Direct link to thread should still load content

**Note**: This scenario was not fully tested in the current QA round. Thread archival depends on session completion flow which was not triggered (Runner was in brainstorm gate waiting state). Mark as **partial** — needs verification in a dedicated ship flow test.

---

## TC-06: Simba Triage → Multi-Lead Thread Full Flow

**Precondition**: Simba (Chief of Staff) is online in #geoforge3d-core. Peter and Oliver are online in their respective channels. At least 2 unassigned issues exist in Linear backlog (1 product-type, 1 ops-type).

**Steps**:
1. Navigate to #geoforge3d-core
2. Send `@Simba PM Triage` to trigger triage
3. Wait for Simba to respond with triage assignments (30-60s)
4. Navigate to #geoforge3d-product-chat — wait for Peter to create thread for assigned issue
5. Wait for Peter's Runner to start and post lifecycle notifications in thread (start → brainstorm → gate/implement)
6. Navigate to #geoforge3d-ops-chat — wait for Oliver to create thread for assigned issue
7. Wait for Oliver's Runner to start and post lifecycle notifications in thread
8. Monitor both threads through full Runner lifecycle (brainstorm → implement → PR → complete)

**Expected**:
- Simba triage assigns product issues to Peter, ops issues to Oliver
- Peter creates a `[ISSUE-ID] Title` thread in #product-chat for assigned issue
- Oliver creates a `[ISSUE-ID] Title` thread in #ops-chat for assigned issue
- Runner start notification (✅ "开始跑了" / 🚀 "Runner 启动了") may appear in main channel as the initial trigger message
- All **subsequent** Runner lifecycle notifications (🌿 brainstorm gate → 🔨 implement → PR → ✅ complete) stay **inside the thread**
- No cross-channel thread leakage (Peter's Runner output never appears in #ops-chat, and vice versa)
- If thread is newly created: main channel shows a 🧵 reference link. If thread already exists (reuse): start info may appear inline in main channel without 🧵 reference

**Note**: Full lifecycle requires Annie to approve brainstorm gates for each Runner. Budget ~30-60 minutes for a complete E2E run.

**How to verify (Chrome Discord)**:
1. Screenshot #geoforge3d-core — confirm Simba triage with Peter/Oliver assignments
2. Navigate to #product-chat — screenshot main channel. Acceptable content: 🧵 reference links and/or Runner start notification. No brainstorm/implement/PR content should appear.
3. Click Peter's thread — confirm brainstorm gate and subsequent lifecycle messages inside thread
4. Navigate to #ops-chat — screenshot main channel (same check as step 2)
5. Click Oliver's thread — confirm brainstorm gate and subsequent lifecycle messages inside thread
6. Cross-check: search Peter's issue ID in #ops-chat — zero results (no leakage)

---

## TC-07: Direct Assignment → Thread Full E2E Flow

**Precondition**: Peter is online in #geoforge3d-product-chat. A Linear issue (e.g., GEO-XXX) is available for assignment.

**Steps**:
1. Navigate to #geoforge3d-product-chat
2. Check sidebar under #geoforge3d-product-chat — confirm no `[GEO-XXX]` thread exists for the target issue. If a thread already exists, this test becomes a reuse + E2E flow test (TC-02 combined).
3. Send `Peter, run GEO-XXX` (direct message in channel — `@` mention is optional)
4. Wait for Peter to respond and start Runner (10-30s)
5. Check sidebar — a `[GEO-XXX] Title` thread should appear
6. Click into the thread and monitor through the Runner lifecycle:
   - ✅ Runner start notification (may also appear in main channel — see Expected)
   - 🌿 Brainstorm Gate (code research + design proposal)
   - **Annie must approve** the brainstorm gate to continue (reply in thread or via Lead)
   - 🔨 Implementation phase (code changes, test writing)
   - PR creation notification
   - ✅ Session completed / 🚢 Ship notification
7. After completion, return to main channel and check for leakage

**Note**: Full lifecycle from start to completion requires Annie to approve the brainstorm gate. Budget ~30-60 minutes for a complete E2E run. If testing thread creation only, steps 1-5 are sufficient (~2-5 minutes).

**Expected**:
- **New thread**: Peter creates `[GEO-XXX] Title` thread and posts a 🧵 reference link in main channel
- **Reused thread** (thread already existed): Peter may post Runner start info directly in main channel without 🧵 reference; thread reappears in sidebar
- Runner start notification (✅ "开始跑了" / 🚀 "Runner 启动了") may appear in **main channel** as the initial trigger
- All **subsequent** lifecycle notifications (🌿 brainstorm gate → 🔨 implement → PR → ✅ complete) appear **only inside the thread**
- Main channel should have no brainstorm content, implementation details, or PR links — only start notification and/or 🧵 reference
- Thread is reused if Runner restarts or retries (same Thread ID in URL)
- On session completion, thread is archived and disappears from sidebar

**How to verify (Chrome Discord)**:
1. Screenshot main channel before and after — acceptable content: 🧵 reference links and/or Runner start notification. No brainstorm/implement/PR content.
2. Click into thread — scroll through entire conversation
3. Verify lifecycle stages have notification messages inside thread:
   - Search for Runner start indicators: 🚀 / ✅ / "开始跑了" / "Runner 启动了"
   - Search for brainstorm: 🌿 / ⚠️ / "Brainstorm Gate"
   - Search for implementation: 🔨 / "implement" / "PR #"
   - Search for completion: ✅ / 🚢 / "completed" / "shipped"
4. Verify Thread ID in URL stays consistent throughout (no duplicate threads created)
5. After completion: check sidebar — thread should be archived (no longer in active list)
6. After completion: direct link to thread should still load all content

---

## Test Results Summary (QA Round — 2026-04-13)

| TC | Description | Result | Notes |
|----|-------------|--------|-------|
| TC-01 | Thread Creation | **PASS** | Thread `[GEO-349]` created with correct title format |
| TC-02 | Thread Reuse | **PASS** | Same Thread ID `1493095219791532124` reused across 7 runs |
| TC-03 | Thread Routing | **PASS** | All Runner notifications in thread, main channel clean |
| TC-04 | Auto-Add Member | **PASS** | Annie in Online-2 member list, thread in sidebar |
| TC-05 | Thread Archive | **NOT TESTED** | Runner in brainstorm gate, no completed session to test |
| TC-06 | Multi-Lead Thread Full Flow | **PARTIAL** | Simba triage works, Peter thread created, Oliver non-responsive — full lifecycle not completed |
| TC-07 | Direct Assignment Thread E2E | **PARTIAL** | Thread created + reused, brainstorm gate reached, full lifecycle (implement→PR→complete) not reached |

**Overall**: 4 PASS, 2 PARTIAL, 1 NOT TESTED

**Blockers Resolved**:
- Circuit-breaker hook causing Runner crash → deleted, Runner stable after fix
- Simba channel routing confusion → documented correct channel map above

**Known Issues**:
- Oliver Lead non-responsive (not FLY-91 related) — blocks TC-06 full verification
- TC-05 (Thread Archive) needs dedicated test when ship flow is exercised
- TC-06 and TC-07 need a full Runner lifecycle completion (through implement → PR → ship) to fully pass
