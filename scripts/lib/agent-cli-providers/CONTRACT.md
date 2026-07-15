# AgentCliProvider contract (FLY-1023 M0)

An agent-CLI provider is a **bash module** at
`scripts/lib/agent-cli-providers/<id>.sh` that the onboarding layer (bootstrap
script + Buddy shell) sources to manage ONE vendor's agent CLI (install /
login / headless "brain" invocation). Providers keep the product
vendor-agnostic (PRD FLY-910 red line 5): swapping `FLYWHEEL_AGENT_CLI`
swaps the whole surface without touching any caller.

- MVP implementation: `claude.sh` (Claude Code, subscription login, no key).
- `codex.sh` ships as an HONEST not-implemented placeholder (production Codex
  Leads are windowed-TUI-only per project CLAUDE.md; a Buddy-grade codex
  adapter is a scoped follow-up, PRD §12 BI-1).

## Selection

`FLYWHEEL_AGENT_CLI` (default `claude`) names the module file. Callers source
`scripts/lib/agent-cli-providers/${FLYWHEEL_AGENT_CLI}.sh` and call the
functions below. A missing module file is a fail-closed error.

## Function surface

Every function:

- prints **exactly one JSON line on stdout** — `{ok:bool, …}` as specified
  below; all human/progress output goes to **stderr** (callers capture it);
- returns a **semantic exit code**: `0` success · `1` failure ·
  `3` needs-guidance (a human has to do something in a browser/UI first);
- **never** prints, logs, or takes secrets via argv/env — login flows run the
  vendor CLI's own interactive flow on the caller's TTY.

| function | purpose | success JSON (minimum) |
|---|---|---|
| `provider_id` | echo the provider id | `{ok:true, provider:"<id>"}` |
| `provider_detect` | is the CLI installed? never installs | found: `{ok:true, provider, found:true, version:"…"}` · not found: exit 1, `{ok:false, provider, found:false, error_code:"not_found"}` |
| `provider_install` | install the CLI (idempotent; re-run safe) | `{ok:true, provider, version}` · exit 3 + `error_code:"manual_install_required"` when only a guided path exists |
| `provider_login_guide` | drive the vendor's OWN login flow in the foreground (caller owns the TTY; the CLI opens the browser). No tokens collected | logged in: `{ok:true, provider, login:"ok"}` · needs the human: exit 3, `{ok:false, error_code:"login_pending", hint}` |
| `provider_smoke` | one minimal REAL invocation proving auth works (runs on the user's subscription) | `{ok:true, provider, smoke:"ok"}` |
| `provider_start_buddy` | one headless "brain" call: `provider_start_buddy <persona-file> <prompt-file>` → the model's reply. Session continuity is provider-internal (`brain_session_id` round-trips via `provider_resume`) | `{ok:true, provider, reply:"…", session_id:"…"}` |
| `provider_resume` | `provider_resume <session-id> <prompt-file>` — continue a prior brain session | same shape as `provider_start_buddy` |
| `provider_repair` | detect a broken login (expired/refused) and re-drive `provider_login_guide` | `{ok:true, provider, repaired:bool}` |

Notes:

- `<persona-file>` / `<prompt-file>` are **paths** (0600, caller-owned) — file
  transport keeps long prompts and persona text out of argv (TmuxAdapter
  `--append-system-prompt-file` precedent).
- `provider_start_buddy` / `provider_resume` are the ONLY model-invoking
  calls; everything the model sees comes from those two files plus the
  caller's prompt — a provider must never add credentials or machine state
  to the model context.
- Contract compliance is executable: `scripts/__tests__/agent-cli-provider-contract.test.sh`
  runs every function against a stubbed PATH and asserts the JSON/exit
  surface. New providers must pass it unchanged.
