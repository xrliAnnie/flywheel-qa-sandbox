# flywheel-gemini-agent

FLY-1018 `/gemini-advanced` — a tool-using Gemini agent: own agent loop on the
`@google/genai` Interactions API (pinned **2.10.0** — experimental surface, no `^`),
6-tool Bridge HTTP surface, 3-layer guardrails. Text (Discord slash command) and
voice (delegate `LiveToolSpec`) entries are thin shells over one `runAgentSession()`.

## Package boundary

- **Depends on**: `@google/genai` (pinned), `discord.js`, `flywheel-voice-core`
  (**type-only** import of `LiveToolSpec`).
- **Forbidden** (CI-enforced by `scripts/gemini-agent-guard.sh`): `@linear/sdk`,
  `flywheel-comm`, any `packages/teamlead` deep-import, reserved endpoint strings
  (`/api/actions`, `/actions/`, `close-tmux`, `close-runner`, `founder-consent`),
  and privileged credentials (`TEAMLEAD_API_TOKEN`, `GH_TOKEN`, `GITHUB_TOKEN`).
- The agent's only Bridge credential is `FLYWHEEL_GEMINI_AGENT_BRIDGE_TOKEN`.

## Guardrails (structural, not behavioral)

1. **Registry has no merge/ship tool** — the only ship-shaped surface is
   `request_ship_approval`, a REQUEST that files a `ship_approval_request` lead
   event via `POST /api/ship-approval-request`. Nothing is merged by this call;
   founder approval + the owning runner's verified ship flow stay authoritative.
2. **Dispatch three-stage gate** — audit line written to disk BEFORE dispatch;
   unknown tool names are never executed (whitelist); schema validation rejects
   missing/unknown/blank args. All failures feed back to the model as error
   results — the loop never throws on tool failure.
3. **Process holds no merge credentials** — see forbidden list above. After M4,
   the Bridge additionally enforces a scoped-token reachability set server-side.

### Production config red line

`FLYWHEEL_GEMINI_AGENT_BRIDGE_TOKEN` in production must ONLY ever hold the scoped
token (`TEAMLEAD_GEMINI_AGENT_TOKEN` value on the Bridge side, M4). Never put the
master `TEAMLEAD_API_TOKEN` into the agent process env — pre-M4 that combination
is acceptable in test environments only.

## Clean-room statement

The design follows concept-level principles (single main loop with explicit
State and structured Terminal, dispatch-layer validation, audit-before-call,
errors-as-messages, injectable model surface) distilled during the FLY-1018
design phase. The implementation is written clean-room against
`engineering/doc/FLY-1018-gemini-advanced-build/plan.md` only — no third-party
proprietary source was open or referenced while writing this package.

## Standalone extraction criteria

This stays a monorepo package until ALL three hold: (1) a non-Flywheel consumer
exists; (2) release cadence conflicts with the monorepo; (3) it needs a
process-level trust domain separate from the Bridge deployment.

## Entry points

- `flywheel-gemini-agent run "<instruction>" [--project X] [--lead Y] [--resume <sid>]` — CLI (test/E2E).
- `flywheel-gemini-agent daemon` — Discord slash-command daemon (M2).
- `createDelegateTool(opts)` — voice-core `LiveToolSpec` for the two-layer voice
  architecture (M3): Live delegates → text loop executes → completion is announced.

All entries refuse to start unless `FLYWHEEL_GEMINI_AGENT=1` (default-off flag).
