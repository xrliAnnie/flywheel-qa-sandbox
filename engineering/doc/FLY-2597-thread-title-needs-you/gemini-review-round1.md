# Design Review — plan.md (Round 1)

Date: 2026-09-15
Author: Gemini
Status: CHANGES REQUESTED

## Summary
The proposed design plan for FLY-2597 is exceptionally solid, highly structured, and shows a deep understanding of the local codebase, particularly in its handling of the single source of truth across the title refresher and the Epic attention page. However, there are two critical structural defects regarding the schema validation on the Epic attention page and status emoji splitting in `splitStatusEmoji` that will cause automated test suite failures and runtime crashes. Addressing these issues prior to execution is required.

## What's Good (Keep)
- **Single Source of Truth (`founder-attention`)**: The unification of the state derivation under `readFounderAttentionFacts` is excellent. It ensures absolute consistency between what is stamped on the Discord thread title and what is displayed on the Epic page.
- **Robust Settle Logic (`settleFounderAsksByThread`)**: The usage of `beforeMs` (timestamp gating) ensures that a founder message only settles asks created *prior* to their message, preventing race conditions where a concurrent ask in the same tick is prematurely settled.
- **Resilient Fallback Design**: Defensive error handling in `issue-display-refresher.ts` (e.g., catching errors inside the facts reader, using `busy_timeout 5s`, and warning instead of throwing) protects the critical thread-renaming loops from database-lock outages.
- **Audit Trails**: Implementing `founder_ask_lit` and `founder_ask_settled` event logs makes the system completely auditable.

## Issues & Recommendations

### 1. Epic Page Schema Validation Crash under `assertAttention`
- **Issue**: Any `statestore` provenance source (like the newly proposed `founder_ask` facts) added to the attention candidates is automatically bucketed under `"gates"` because `provenance.kind === "linear"` is false and `provenance.kind === "commdb"` is false. This increments `sourceCounts["gates"].size`. However, `reads.gates.value.count` is populated solely via `listAttentionGateFacts`, which only reads from `workflow_gate_holder`. This causes `reads.gates.value.count !== sourceCounts["gates"].size`, which triggers a validation failure in `assertAttention` and crashes the entire Epic page generation.
- **Why it matters**: Generation of the attention Epic page will crash with the error: `/attention_sources/gates: invalid attention.v1 value` as soon as any active `founder_ask` exists.
- **Suggested Fix**: Update `reads.gates.value.count` in `packages/teamlead/src/epic-page/attention-sources.ts` to include BOTH the count of `workflow_gate_holder` facts AND the count of open `founder_ask` facts.
- **File & line evidence**:
  - `packages/teamlead/src/epic-page/attention.ts` lines 611-617 (bucketing logic).
  - `packages/teamlead/src/epic-page/attention.ts` lines 685-692 (strict validation loop).
  - `packages/teamlead/src/epic-page/attention-sources.ts` lines 156-161 (where `reads.gates.value.count` is originally set).

### 2. Custom Title Splitting Defect with Manual `"🔔"` Prefixes
- **Issue**: The plan proposes registering `NEEDS_ANSWER_EMOJI = "🔔"` in `ALL_STATUS_EMOJI` and `EMOJI_TO_WORDS`. Doing so will cause `splitPrimaryStatusEmoji` to match `"🔔"` on any title starting with `"🔔"`.
- **Why it matters**: A manually curated title starting with a bare `"🔔"` (e.g., `"🔔 literal title"`) will have its `"🔔"` matched as a status emoji and stripped on the next re-stamp. This violates the existing invariant and breaks the unit test `expect(stripStatusEmojiPrefix("🔔 literal title")).toBe("🔔 literal title")`.
- **Suggested Fix**: Modify `splitPrimaryStatusEmoji` in `packages/teamlead/src/bridge/stage-utils.ts` to include a safeguard: if `emoji === "🔔"`, it must ONLY be treated as a status prefix if a valid word (like `"要你答"`) is successfully parsed immediately following the emoji. Otherwise, it should skip `"🔔"` and return `undefined` (letting `splitStatusEmoji` keep the prefix intact).
- **File & line evidence**:
  - `packages/teamlead/src/bridge/stage-utils.ts` lines 258-275 (`splitPrimaryStatusEmoji`).
  - `packages/teamlead/src/__tests__/stage-status-emoji.test.ts` line 114 (existing unit test verifying that manually curated `"🔔 literal title"` remains unchanged).

### 3. Missing Retention Registry Table Configuration
- **Issue**: The plan mentions creating the `founder_ask` table in `StateStore.ts` but does not explicitly document the creation of its retention table configuration JSON file.
- **Why it matters**: The automated test suite `fly-2413-retention-registry.test.ts` will fail if a table exists in `StateStore.ts` but is not registered under `scripts/lib/fly-2006-retention-tables/`.
- **Suggested Fix**: Explicitly include the creation of `scripts/lib/fly-2006-retention-tables/teamlead/founder_ask.json` under `C3` with content `{ "database": "teamlead", "table": "founder_ask", "classification": "protectedCurrentOrReference" }`.
- **File & line evidence**:
  - `scripts/lib/fly-2006-retention-tables/teamlead/` folder (location of all database schema metadata registrations).

### 4. Missing Authorization and Flag Guards for `/founder-ask/withdraw` Route
- **Issue**: The plan specifies a new `POST /api/chat-threads/founder-ask/withdraw` route, but does not explicitly reinforce that it must be gated behind the same security and flag mechanisms as `POST /api/chat-threads/send`.
- **Why it matters**: Without gating, the route would bypass auth or configuration checks, creating security vulnerabilities or executing logic while chat threads are disabled.
- **Suggested Fix**: Explicitly state in the plan that `/founder-ask/withdraw` must be guarded by `TEAMLEAD_API_TOKEN` and gates like `chatThreadsEnabled` and `replyByIssueEnabled`.
- **File & line evidence**:
  - `packages/teamlead/src/bridge/tools.ts` lines 720-726 (auth and flag gating on `/chat-threads/send`).

## Advisory (non-blocking)
- **Formatting Consistency**: In `C5 标题接线`, ensure `needs_answer` maps to `needsAnswerBadge(withWord)`. In emoji-only mode (where `withWord` is false), the plan states that the badge degenerates to `"🔔"`, which conflicts with the attention layer, so it is documented to not render. Ensure this is fully covered by the refresher test matrices.

## Verdict
CHANGES REQUESTED — address items above
