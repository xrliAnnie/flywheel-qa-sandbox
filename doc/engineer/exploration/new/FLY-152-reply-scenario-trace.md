# Reply Scenario Trace — FLY-152

**Issue**: FLY-152 (Lead reply discipline — shared channel default to cos)
**Date**: 2026-05-10
**Source**: `doc/engineer/plan/draft/v1.27.0-FLY-152-lead-reply-discipline.md` §6.2 (Layer 2 — Scenario trace)
**Status**: spec — doubles as manual QA checklist + Layer 3 E2E source-of-truth

> This doc lists the expected replier set for representative messages in `#geoforge3d-core` after FLY-152 ships. Layer 1 (unit) verifies the prompt files contain the new rules; Layer 3 (E2E) verifies the runtime behavior matches this table.

---

## Bot ID reference

| Lead | Role | Bot ID | Bot @-mention |
|------|------|--------|---------------|
| Simba | cos-lead | `1487339075563290745` | `<@1487339075563290745>` |
| Peter | product-lead | `1485896147951419434` | `<@1485896147951419434>` |
| Oliver | ops-lead | `1485899317850935316` | `<@1485899317850935316>` |
| Annie | operator (human) | `1138241636057481306` | `<@1138241636057481306>` |

## Reply legend

- **reply** — the Lead bot posts a response within ~30 s of the operator message.
- **abstain** — the Lead bot stays completely silent. No message, no emoji reaction, no thread reply, no DM.
- **reply (brief ack)** — the Lead bot posts a closed 1-line acknowledgment only (e.g. `"收到。"` or `"收到, 我先不动作。"`). It does NOT take any action, does NOT spawn a Runner, does NOT commit to follow-up work, does NOT ask a follow-up question that invites further conversation. Reserved for the past-tense / narrative boundary (B1). Phrases like `"还需要我做什么?"` are NOT acceptable — they invite the operator to feel obligated to reply.

---

## Section A — Single inbound operator message scenarios

This table lists messages posted by the operator (Annie) into `#geoforge3d-core` and the expected reply set for each. Each row is one isolated message; expected reply set is which bot(s) should post a response within ~60 s.

| # | Operator message in `#geoforge3d-core` | Simba | Peter | Oliver | Why |
|---|----------------------------------------|-------|-------|--------|-----|
| 1 | `我想做 GEO-371` | reply | abstain | abstain | No Lead named — Simba is the default handler. Peter / Oliver have neither their `@-mention` nor their literal name → MUST NOT REPLY. |
| 2 | `今天 standup 有什么进展?` | reply | abstain | abstain | Generic global question. Same as #1. |
| 3 | `product 那边怎样了?` | reply | abstain | abstain | Topic mentions "product" but contains no `@-mention` and no literal Lead name. **Topic ownership is NOT a reply trigger.** Simba is the default handler; if dept input is needed, Simba routes by `@-mentioning` the relevant dept Lead in a follow-up. Peter must stay silent here. |
| 4 | `Peter, 看下 GEO-XX` | abstain | reply | abstain | Simba sees text "Peter" → abstain (Half A — Simba ordered decision Step 2 fires). Peter sees text "Peter" → reply (Half B). Oliver sees nothing matching → silent. |
| 5 | `Oliver, 看下 GEO-YY` | abstain | abstain | reply | Mirror of #4. |
| 6 | `<@1485896147951419434> 看下 GEO-XX` (@ Peter) | abstain | reply | abstain | Simba sees an `@DEPT_LEAD` mention → abstain. Peter sees own `@-mention` → reply. |
| 7 | `<@1485899317850935316> 看下` (@ Oliver) | abstain | abstain | reply | Mirror of #6. |
| 8 | `Simba, 状态如何` | reply | abstain | abstain | Simba sees own name → reply. Peter / Oliver have no own name match → MUST NOT REPLY. |
| 9 | `<@1487339075563290745> 状态` (@ Simba) | reply | abstain | abstain | Mirror of #8 with `@-mention`. |
| 10 | `Peter 和 Oliver 看下 W` | abstain | reply | reply | Simba sees BOTH dept names → abstain (Step 2 priority over Step 3). Each dept Lead sees own name → reply. Two replies expected — Annie addressed both intentionally. Each Lead's reply should be **dept-specific** (own slice), not duplicate global analysis. |
| 11 | `<@1485896147951419434> <@1485899317850935316> 看下` (@ Peter + @ Oliver) | abstain | reply | reply | Mirror of #10 with `@-mentions`. |
| 12 | `刚 Peter 帮我搞了 GEO-XX` (past tense / narrative) | abstain | reply (brief ack — `收到。`) | abstain | Simba sees "Peter" → abstain. Peter sees own name → reply with a closed brief ack (B1 boundary: no action, no spawn, no question). The reply MUST NOT contain action verbs (`start runner`, `pushed`, `created`) or open-ended questions (`还需要我做什么?`). |
| 13 | `Simba 让 Peter 看下 GEO-XX` | reply (Simba part) | reply (Peter part) | abstain | Simba sees own name → reply (per Step 1, before reaching Step 2). Peter sees own name → reply. Each answers the slice addressed to them. |
| 14 | `Simba 帮我看下 backlog` | reply | abstain | abstain | Simba is the addressee, dept Leads silent. |

## Section B — Triage flow validation (multi-step cascade, not a single inbound)

The Simba-triage flow is a sequence: Annie sends a generic request → Simba posts a triage report that includes `@-mentions` to dept Leads → Peter and Oliver reply to Simba's triage post. This is **not** a single inbound message scenario, so it does not fit Section A's format. Validate the cascade step-by-step.

**Step 1**: Annie posts in `#geoforge3d-core`: `triage 报告` (or `triage`, `check backlog`, etc.).

- **Expected**: Simba is the sole replier (no name in message → Simba default handler). Peter and Oliver stay silent. Simba then enters its triage flow (existing Triage Execution Gate rule, unchanged by FLY-152).

**Step 2**: Simba then posts (typically several minutes later, after data collection) a triage report into `#geoforge3d-core` that includes `<@1485896147951419434> <@1485899317850935316> take a look ...`.

- **Expected**: Peter and Oliver each reply per the existing Triage Execution Gate rule (currently documented in their `identity.md` files). Each reply is a dept-input message (dependency / priority challenge / capacity report). Simba does not reply to its own triage post.
- **FLY-152 invariant**: Even though Peter and Oliver are bots and the triage post is bot-generated, the `<@PETER_BOT_ID>` and `<@OLIVER_BOT_ID>` mentions are the legitimate reply triggers in this flow. The Half B `MUST NOT REPLY` default still applies to any message that lacks a Lead's `@-mention` or literal name — but in this case the `@-mentions` are present, so Peter and Oliver correctly reply.

**Validation**: do not treat the triage report as a Section A row — Simba is the sender, and counting Simba as a "replier to its own post" is meaningless. Validate the cascade by checking (a) only Simba replied to step 1's `triage 报告`, and (b) Peter and Oliver both replied to step 2's triage post that `@-mentioned` them.

---

## How to validate (E2E procedure)

### Section A validation (single inbound rows)

For each row in Section A:

1. Compose the message exactly as shown in the "Operator message" column.
2. Post it from Annie's account (or the test operator account in the 4-slot test env) into `#geoforge3d-core` (or `dev-channel` in test env).
3. Wait 60 s.
4. Fetch the last 30 messages with Discord MCP `fetch_messages` for that channel.
5. Identify which bot accounts (Simba / Peter / Oliver) posted a response that references the original message (either as a reply or as a chronologically-following post addressing the operator).
6. Compare the observed reply set with the "Simba / Peter / Oliver" columns in the table.

**Pass criterion**: observed set === expected set for **every row**. No extras, no missing.

**Content check for scenario 12** (past-tense brief ack): Peter's reply must be a closed 1-line ack. If Peter's response body contains action verbs (`start runner`, `pushed`, `created`, `已 ship`, `要不要起`) or open-ended questions (`还需要我做什么?`, `要做什么?`), scenario 12 fails even though the replier set matched. Inspect the body, not just the count.

### Section B validation (triage cascade)

Run step 1 first, validate, then run step 2 from the trace doc Section B. Do not collapse into one inbound — they are different observations.

### Failure handling

If any scenario fails, capture: (a) the original message; (b) every bot response; (c) the relevant Lead daemon's tmux output around the message timestamp (`tmux capture-pane`). Escalate to Annie via Discord. Do not auto-retry — false-negative bugs in prompt rule are interesting and worth surfacing.

---

## Out of scope for this doc

- Messages in other channels (`product-chat`, `ops-chat`, `cos-lead-control`, etc.) — those follow each Lead's own `Channel Isolation Rules` and are unaffected by FLY-152.
- Bridge-driven events (Forum thread events, Standup channel pushes) — not relevant to inbound Discord reply discipline.
- DM behavior — out of scope.
- Reactions / typing indicators / edits — only outbound reply messages count.
