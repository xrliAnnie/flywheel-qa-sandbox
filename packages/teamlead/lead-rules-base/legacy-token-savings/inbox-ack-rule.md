# Inbox Channel Acknowledgement (flywheel-inbox)

---

## 🔒 Reply Discipline (FLY-162 — applies BEFORE everything else)

For **every** inbound message — Discord OR flywheel-inbox — execute this mechanical algorithm BEFORE doing anything else. Topic / intent / tone of the message is NOT an input.

```
STEP 1. Extract Linear issue tokens. Regex: \b[A-Z]{2,}-\d+\b
        TOKENS = distinct matches in inbound text. N = |TOKENS|.

STEP 2. Route by N:
        N == 0 → mcp__plugin_discord_discord__reply(chat_id=$CHAT_CHANNEL, …)
        N == 1 → POST /api/chat-threads/send  with issueIdentifier=TOKENS[0]
        N ≥ 2  → POST /api/chat-threads/send  N times, once per token,
                 content split per issue. Exactly N HTTP calls. Not 1.

STEP 3. On /send 4xx/5xx → fall back to discord.reply($CHAT_CHANNEL) for
        ONLY the failed token, prefix text with [FLY-XXX]. Other tokens'
        successful /send calls stand.
```

You do NOT pre-query `/api/sessions`. You do NOT pre-query `/api/chat-threads/by-thread`. `/send` auto-creates the thread on first call. The presence/absence of a Runner session has **nothing to do with** the per-issue chat thread.

**Topic does NOT change routing.** "Status question" vs "prioritization question" vs "comparison" vs "meta" vs "which one first" — all run the same algorithm. If `N >= 1`, `/send` runs `N` times. Categorization of the *intent* of the message is forbidden as a routing input — it only affects the *content text* of each `/send` body.

**Anti-pattern caught in QA 2026-05-21 cycle 1 — DO NOT repeat**:
> "Annie asked about FLY-159. I checked `/api/sessions`, found no active session for FLY-159, concluded 'no thread exists', replied at top-level via `discord.reply(chat_id=$CHAT_CHANNEL)`."

Wrong. Algorithm has no session-check step. `/send` auto-creates threads.

**Anti-pattern caught in QA 2026-05-22 cycle 1 — DO NOT repeat**:
> "Annie asked `FLY-A 和 FLY-B 哪个先做？`. I made **one** `/send` call with `issueIdentifier=FLY-A` and packed both issues' content into that single thread. FLY-B's thread received nothing."

Wrong. N=2 ⇒ 2 `/send` calls, content split. Algorithm has no "combine bodies" branch.

**Anti-pattern caught in QA 2026-05-22 cycle 2 — DO NOT repeat (most recent)**:
> "Annie asked `FLY-159 和 FLY-161 哪个先做？`. I read it as a meta-prioritization question (not per-issue status), so I quote-replied at top-level via `discord.reply(chat_id=$CHAT_CHANNEL)` and made **zero** `/send` calls. Both threads received nothing."

Wrong, and the worst failure of the three. "Meta-prioritization" is not a category in the algorithm. N=2 ⇒ 2 `/send` calls. The comparative *nature* of the question affects only the body text of each call (each one references the other for context); it does NOT change the route. Both threads MUST receive a `/send`.

Fallback to `discord.reply(chat_id=$CHAT_CHANNEL)` is ONLY allowed when:
- `/send` returns HTTP 404 (route flag off), 502 (Discord/Linear transient — after one retry), or 503 (Bridge missing token / Linear key / ChatThreadCreator), OR
- STEP 1 produced N == 0 (no Linear issue identifier — pure chat / greeting / cross-Lead routing).

In every fallback case, prefix the reply with `[FLY-XXX]` so context survives. For N ≥ 2 partial-fail: each issue's `/send` is independent — fall back only the failed token, not the whole answer.

Full reference (curl template, status code map, partial-fail recovery, reverse-lookup): §"Issue-Bound Reply (FLY-162)" in your role's base rules file (`packages/teamlead/lead-rules-base/{department,cos}-lead-rules.md`) and (for projects that ship it) project `common-rules.md`.

---

When you receive a channel message from **flywheel-inbox** (these arrive through
the MCP channel `notifications/claude/channel`, NOT through Discord), you MUST
acknowledge it exactly once after you have processed it:

Every instruction notification starts with a
**`[mailbox-batch <batch_id> | ...]`** header. Process every message in the
batch, then call **`flywheel_inbox_ack_batch`** exactly once with
`{ batch_id: "<batch_id>" }`. An unacked batch holds one of the three in-flight
slots and is re-delivered under the same durable batch id when its lease expires.
Unknown batch ids return a structured error; verify the header instead of
guessing an id.

Discord messages arrive through a different path and do NOT require this ack.
