# Design Review — FLY-997 plan.md (Round 1)
Date: 2026-07-08
Author: Codex
Status: CHANGES REQUESTED

## Summary
The plan is directionally right: the spike is scoped as throwaway research, the S1→S2 sequencing protects the highest-value reliability data, and the current repo does expose the needed seams for voice tools, Bridge dispatch, memory, and founder-gated ship authority. I would not implement it as written yet because several plan claims are not true against the current checkout, and those gaps would make the spike data easy to overclaim for FLY-996.

## What's Good (Keep)
- Keep the issue boundary: `engineering/spike/FLY-997-gemini-agent/` plus `findings.md`, not a production `packages/gemini-agent` build.
- Keep S1 before the matrix. If the Gemini function-call loop is not protocol-clean, every downstream reliability number is noise.
- Keep N1/N3 as the priority scenarios. They directly test the PRD north stars and the safety behavior that matters.
- Keep the guardrail framing as a product-form boundary. Current `verify-approval` really is the ship authority chain, and FLY-245's gateway pattern is the right precedent for "model can request, runtime/founder gate executes."
- Keep the "mock Bridge + real Gemini API" choice for the core matrix. It is the right way to isolate model/tool-loop reliability from production Runner/Linear side effects.

## Issues & Recommendations
1. **S3 is not executable as written.**

   The plan says to use the existing `flywheel-voice-poc talk` CLI plus `extraTools` to register a delegate tool. The seam exists in `ConversationOptions.extraTools` and `GeminiLiveBackend`, but the current CLI never exposes or passes `extraTools`; `runTalk()` builds the conversation with only `brain`, `voice`, `systemHint`, `transcriptSink`, and `resumeHandle`. Also, the real `genaiConnector.ts` ignores the scheduling argument when sending tool responses, while the Live docs say async behavior requires `behavior: NON_BLOCKING` on the function declaration and `response.scheduling` in the function response; the same docs currently note async function calling is not supported in Gemini 3.1 Flash Live.

   **Suggested fix:** rewrite S3 to use a spike-local Live harness that imports voice-core APIs and passes `extraTools`, or explicitly make a CLI extension part of the spike. Split the test into two modes: immediate delegate ACK with background loop, and true Live async scheduling only if the current model/SDK supports it. Do not let "when_idle" pass based only on the unit-test seam.

2. **The mock tool schemas are not 1:1 with production routes.**

   The plan says `create_issue` requires `title/description/team/labels`, but production `/api/linear/create-issue` only always requires `title`; `description`, `priority`, `labels`, `team`, `project`, and `projectName` are optional or conditional. Memory is also underspecified: `/api/memory/search` requires `query`, `project_name`, and `user_id`, while `agent_id` is optional; `/api/memory/add` requires `messages`, `project_name`, `agent_id`, and `user_id`. `query_status` should mirror concrete routes like `/api/sessions/:id/status`, not generic `GET /api/*`.

   **Suggested fix:** add a production-contract table to the plan before implementation, including required fields, optional fields, status codes, and representative error bodies for `create_issue`, `dispatch_runner`, memory add/search, and status. If the spike intentionally uses stricter product schemas, label them as spike/product schemas rather than "1:1 mock" of Bridge.

3. **Production side-effect protection needs an executable guard, not just prose.**

   The plan says no production Bridge/Linear/Runner writes, but it does not require the spike client to reject real `BRIDGE_URL`, `FLYWHEEL_BRIDGE_URL`, or `TEAMLEAD_API_TOKEN`, and the repo contains production write routes behind the normal API token. A typo in the tool client base URL would invalidate the "mock only" guarantee.

   **Suggested fix:** add a sandbox invariant to the plan: the spike tool client only accepts `localhost`/`127.0.0.1` mock URLs, fails closed if production Bridge env vars are present, never imports `@linear/sdk` or `flywheel-comm`, and records each outbound HTTP origin in evidence. D4 Linear commenting can remain, but keep it explicitly outside the experiment harness.

4. **V8 currently overclaims guardrail evidence.**

   The mock's lack of a merge tool proves model behavior in the toy surface; it does not prove the build architecture "structurally enforces" ship safety. In production, the current Bridge token can reach reserved routes like `/api/actions/*`, close endpoints, and the founder-consent gate route; the real structural boundary only becomes service-side with an S-b downgraded token or equivalent endpoint allowlist. `verify-approval` also documents the same-host DB integrity caveat and the `DECISION_MODE=enforce` caveat.

   **Suggested fix:** change V8's claim to "behavior observation + tool-registry red-line proof inside the spike." Add a static guardrail audit deliverable for the proposed build shape: no raw DB/CLI access, no reserved endpoints in the HTTP client, no merge/GitHub token, and S-b downgraded token listed as required for the PRD/build issue if the PRD wants a true structural guarantee.

5. **The SDK/API choice is not pinned tightly enough for a 2026 spike.**

   Official docs now mark the Interactions API as generally available/recommended and the generateContent function-calling page as the previous API. The plan hardcodes an own-loop on `generateContent` and says to disable automatic function calling, but the implementation contract should explicitly decide whether the spike is testing legacy generateContent or the current Interactions API surface. Locally, `voice-core/package.json` says `@google/genai` `^1.16.0`, but `pnpm-lock.yaml` resolves `1.44.0`, and existing spike package-locks have resolved newer versions again.

   **Suggested fix:** make S1 record the exact SDK version, Node version, API surface, automatic-function-calling setting/probe, and exact model IDs. If generateContent remains the choice, state why it is intentionally preferred over Interactions for this spike's manual dispatch loop.

6. **Raw evidence/log hygiene is underspecified.**

   The plan writes structured audit lines with full tool args and raw matrix JSONL under `evidence/`. That is useful, but tool args can include issue descriptions, memory contents, or prompt text. Existing voice spikes usually put high-volume raw outputs under gitignored `out/` and summarize committed evidence elsewhere.

   **Suggested fix:** define what goes into committed `evidence/` versus gitignored `out/`, redact tokens/URLs/secrets and sensitive memory contents, and include a manifest in `findings.md` that points to raw files without requiring sensitive data to be committed.

## Verdict
CHANGES REQUESTED — address items above before implementation.
