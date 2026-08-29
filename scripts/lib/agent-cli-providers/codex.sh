#!/usr/bin/env bash
# FLY-1023 M1: AgentCliProvider — Codex placeholder (HONESTLY not implemented).
#
# A Buddy-grade Codex adapter is a scoped follow-up (PRD FLY-910 §12 BI-1
# default: post-MVP). Two reasons this is a placeholder and not a quick port:
#   1. Project hard rule (CLAUDE.md "Codex Lead Deployment"): production
#      Codex agents run WINDOWED (TUI) — the headless app-server form is not
#      a production deployment shape, so a headless Buddy brain on codex
#      needs its own design pass, not a copy of claude.sh.
#   2. The onboarding red lines (no keys in argv/env, subscription login,
#      bounded headless calls) must be re-verified against the codex CLI's
#      real auth + exec surface before we claim support.
#
# Every function answers the SAME contract shape with error_code
# "not_implemented" so callers (bootstrap/Buddy shell) can give the user an
# honest "codex isn't wired up yet — claude is" instead of a crash.

_acp_codex_stub() {
  jq -nc '{ok:false, provider:"codex", error_code:"not_implemented",
           hint:"the codex agent CLI is not supported by onboarding yet — use FLYWHEEL_AGENT_CLI=claude (default)"}'
  return 1
}

provider_id()          { jq -nc '{ok:true, provider:"codex"}'; }
provider_detect()      { _acp_codex_stub; }
provider_install()     { _acp_codex_stub; }
provider_login_guide() { _acp_codex_stub; }
provider_smoke()       { _acp_codex_stub; }
provider_start_buddy() { _acp_codex_stub; }
provider_resume()      { _acp_codex_stub; }
provider_repair()      { _acp_codex_stub; }
