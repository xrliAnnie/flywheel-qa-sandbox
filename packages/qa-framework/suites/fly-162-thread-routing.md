# Integration Test Suite — FLY-162 Lead Reply-by-Issue (Thread Routing)

**Feature**: Lead `reply.by_issue` — Bridge auto-routes issue-bound replies to the canonical chat thread for `(issueId, chatChannel)`.
**PR**: Flywheel #192 + GeoForge3D #217 (Lead rules)
**Tool**: Chrome Discord observation (Claude-in-Chrome MCP) — see `feedback_qa_must_use_claude_in_chrome.md`
**Environment**: GeoForge3D Discord (or test slot with `TEST_REPLY_BY_ISSUE=1`)

## Prerequisites

- Both PRs merged. Flywheel deployed with `TEAMLEAD_REPLY_BY_ISSUE_ENABLED=true` AND `TEAMLEAD_API_TOKEN` set.
- All 3 Leads (Peter, Oliver, Simba) restarted so `claude-lead.sh` picks up new rules.
- Chrome Discord session with Annie's account (so we can observe).
- For test-slot runs: `TEST_REPLY_BY_ISSUE=1 ./scripts/test-deploy.sh <N>` (this is the Codex R3 #1 + R4 LOW #2 path — injects the API token and the two flags into both Bridge AND Lead env via process env, not via `.env` files).

## Channel Map

| Lead | Channel | Channel ID |
|------|---------|------------|
| Peter — Product Lead | #geoforge3d-product-chat | 1485787822894878955 |
| Oliver — Ops Lead | #geoforge3d-ops-chat | 1485789342541680661 |
| Simba — Chief of Staff | #geoforge3d-core | 1487340532610109520 |

---

## TC-01: Two issue-bound replies route to two distinct threads (zero cross-talk)

**Precondition**: Two threads exist (or will be auto-created) for distinct issues in Peter's chatChannel — e.g. FLY-A and FLY-B.

**Steps**:
1. In #geoforge3d-product-chat top-level, post (as Annie):
   `@Peter FLY-A 现在进度怎么样？`
2. Wait for Peter to respond (10-30s).
3. In the same channel, post:
   `@Peter FLY-B brainstorm 阶段卡住了吗？`
4. Wait for Peter to respond (10-30s).

**Expected**:
- Peter's FLY-A reply lands inside the FLY-A thread (or a newly created FLY-A thread). Nothing about FLY-A in the FLY-B thread or in chatChannel top-level.
- Peter's FLY-B reply lands inside the FLY-B thread. Nothing about FLY-B in the FLY-A thread.
- Main channel sees **at most** one new `🧵 FLY-A — …` and one `🧵 FLY-B — …` ChatThreadCreator notification per *new* thread (no duplicates per send).

**How to verify (Chrome Discord)**:
1. Screenshot main channel after step 4 — confirm at most 2 🧵 notifications (or 0 if both threads pre-existed).
2. Open FLY-A thread → confirm Peter's response to message #1 is there.
3. Open FLY-B thread → confirm Peter's response to message #3 is there.
4. Cross-check: FLY-A thread does NOT contain FLY-B response and vice versa.

**Pass criterion (AC1+AC2)**: 0 cross-thread leakage. **Observable lookup-first signal**: when both threads already pre-existed (no creation expected), `#geoforge3d-product-chat` main channel gets **zero** new `🧵 FLY-… — …` notifications between steps 1 and 4 — that notification is only emitted by `ChatThreadCreator.ensureChatThread()`, so its absence proves the reuse path skipped `ensureChatThread`. (Earlier drafts of this suite asked QA to inspect `bridge.log`; HTTP request logging is not currently emitted for these routes, so we use Discord's main-channel state instead — same signal, observable in Chrome.)

---

## TC-02: Cross-issue reply uses two explicit `send` calls

**Precondition**: Both FLY-A and FLY-B already have threads.

**Steps**:
1. In #geoforge3d-product-chat, post:
   `@Peter FLY-A 和 FLY-B 哪个先做？`
2. Wait for Peter (15-30s).

**Expected** (per common-rules.md §"Issue-Bound Reply / Cross-issue case"):
- Peter issues **two** `POST /api/chat-threads/send` calls — one with `issueIdentifier=FLY-A`, one with `issueIdentifier=FLY-B`.
- Each thread sees Peter's part of the answer that's relevant to it. Neither response leaks to the other thread or top-level.

**How to verify (observable Discord state, not log scraping)**:
1. Open FLY-A thread — has Peter's relevant response.
2. Open FLY-B thread — has Peter's relevant response.
3. Cross-check: each thread only contains text relevant to its own issue (no "FLY-A and FLY-B" pasted into a single thread).
4. Main channel: no new 🧵 notifications (both pre-existed).

**Pass criterion**: Two distinct thread responses, no top-level leakage, no combined-into-one-thread message.

---

## TC-02b: Layer 2 reply-guard DETERMINISTICALLY blocks issue content at top level

**Why this is separate from TC-02**: TC-02 verifies the Lead *chooses* to route correctly (rules/judgment). Layer 1 rules-only FAILED this 100% of the time in 3 QA cycles — the Lead quote-replied the cross-issue answer at chatChannel top level instead of calling `/send`. TC-02b verifies the **preventive guard** (forked plugin `reply`/`edit_message` → Bridge `POST /api/discord/reply-guard`) makes that leak *impossible* regardless of Lead judgment.

**Precondition**: Test slot with `TEST_REPLY_BY_ISSUE=1` (enables `TEAMLEAD_REPLY_GUARD_ENABLED=true`), the **forked** Discord plugin with the guard deployed to BOTH cache and marketplace runtime paths (verify with `check-discord-plugin.sh`), and `TEAMLEAD_ISSUE_PREFIXES` covering the issues used (default `FLY,GEO`).

**Steps**:
1. In Peter's chatChannel top-level, post: `@Peter FLY-A 和 FLY-B 哪个先做？`
2. Wait for Peter (15-30s). (Peter may attempt a top-level reply containing `FLY-A`/`FLY-B`.)

**Expected**:
- If Peter attempts `discord.reply(chat_id=$CHAT_CHANNEL, text="…FLY-A…FLY-B…")`, the plugin's guard call returns `allow:false reason=issue_at_top_level` → the tool result is `BLOCKED by routing guard (issue_at_top_level)…` (NOTHING posted at top level).
- Peter then routes via `POST /api/chat-threads/send` per issue → answers land in the FLY-A and FLY-B threads.

**How to verify (Chrome Discord — the deterministic signal)**:
1. **chatChannel top-level contains ZERO Peter messages mentioning any FLY-/GEO- token** for this exchange — this is the hard guarantee. Even if Peter "wanted" to leak, the guard prevented the post.
2. The substantive answers appear inside the FLY-A / FLY-B threads.
3. (Optional, bridge.log) the guard deny is logged; a `BLOCKED by routing guard` tool result may be visible in Peter's tmux pane.

**Negative control**: a pure free-form top-level reply (TC-03, zero issue tokens) is NOT blocked — confirms the guard only gates issue-bearing top-level posts.

**Pass criterion**: 0 issue-token-bearing Peter messages at chatChannel top level — deterministic, independent of whether Peter's prose judgment was correct.

---

## TC-03: Free-form chatChannel message uses `discord.reply`, NOT `send`

**Precondition**: Peter is online.

**Steps**:
1. In #geoforge3d-product-chat top-level, post:
   `@Peter 你今天怎么样？`
2. Wait for Peter (10-30s).

**Expected**:
- Peter replies in chatChannel top-level via `mcp__plugin_discord_discord__reply`.
- No issue reference in the message → no thread should be touched (no existing thread receives a copy of this reply).

**Pass criterion (classification table row 3)**: response visible at top-level of chatChannel; no thread (FLY-A / FLY-B / any other) gets a new Peter message attributable to this question.

---

## TC-04: Inbound reverse-lookup correctly identifies issue

**Precondition**: A FLY-X thread exists. Annie writes inside the thread, not at top-level.

**Steps**:
1. Open the FLY-X thread in #geoforge3d-product-chat.
2. Post (inside thread): `@Peter 这个 PR 哪个文件主要改了？`
3. Wait for Peter (10-30s).

**Expected**:
- Peter (per common-rules.md §"Inbound — Reverse-lookup") calls `GET /api/chat-threads/by-thread/<THREAD_ID>` first, sees `issueIdentifier=FLY-X`, then issues `POST /api/chat-threads/send` with `issueIdentifier=FLY-X` → response lands in the same thread.

**How to verify (observable)**:
1. Peter's response appears inside the FLY-X thread (NOT at top-level, NOT in any other thread).
2. The response references FLY-X by identifier or by what the answer is about — confirms Peter resolved the thread back to FLY-X (vs. guessing or replying without context). If Peter says "我不知道这是哪个 issue", reverse-lookup failed.

**Pass criterion (AC5+AC8)**: response lands in the correct thread with semantic awareness of which issue it is.

---

## TC-05: Failure path — flag off → graceful top-level fallback with issue identifier in text

**Precondition**: Restart Bridge with `TEAMLEAD_REPLY_BY_ISSUE_ENABLED=false` (or unset). Lead rules still loaded.

**Steps**:
1. In #geoforge3d-product-chat top-level, post: `@Peter FLY-A 现在跑到哪了？`
2. Wait for Peter (15-30s).

**Expected** (per common-rules.md §"Status code map" 404 row):
- Peter's first `POST /api/chat-threads/send` returns `404 { error: "reply.by_issue not enabled" }`.
- Peter falls back to `mcp__plugin_discord_discord__reply(chat_id=$CHAT_CHANNEL, …)` and includes `[FLY-A]` (or `FLY-A`) in the text.
- No cross-talk; no silent failure.

**Pass criterion**: Top-level fallback contains issue identifier; Annie still has context.

---

## Mixed-message scenario (Annie sign-off)

Run TC-01 → TC-04 in sequence in a single ~15-minute session. After all PASS (all signals observable in Chrome Discord; no log scraping needed):
- 0 cross-thread messages
- 0 ghost `🧵` notifications in main channel for reuse paths (presence of 🧵 only when a thread is **created**, not on reuse)
- `allowed_mentions: { parse: [] }` is enforced by unit tests for both the route helper and `ChatThreadCreator`, so QA does not need to verify on Discord — but if Annie posts a message containing `@everyone` to a Lead and the bot's reply does NOT ping the channel, that's the live confirmation.
- Partial-fail recovery is unit-tested; observable in QA only if Discord rate-limits during the session (rare) — then Peter should resend only the remaining suffix, not the whole text.

QA gatekeeper + Annie sign off before flipping prod flag.
