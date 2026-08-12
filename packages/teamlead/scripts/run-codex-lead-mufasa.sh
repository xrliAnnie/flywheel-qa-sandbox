#!/usr/bin/env bash
# FLY-224 Phase 7 — Mufasa-on-Codex first-test launcher (direct outbound, no Bridge).
#
# Starts Mufasa as a CODEX Lead (resident codex app-server) reusing Mufasa's existing
# Discord bot + an ISOLATED CODEX_HOME (~/.codex-mufasa, a copy of the School profile
# auth). Outbound is DIRECT to Discord with Mufasa's own bot token — NO Bridge route,
# so the production Bridge (:9876) and every other Lead are untouched.
#
#   Dry-run (verify the plan, nothing starts):  FLYWHEEL_LEAD_DRY_RUN=1 run-codex-lead-mufasa.sh
#   Real run:                                    MUFASA_BOT_TOKEN=... run-codex-lead-mufasa.sh
#
# Rollback: stop this process, restart Claude Mufasa (manifest backendId → claude-code).
set -euo pipefail

WORKTREE="${FLY224_WORKTREE:-/Users/xiaorongli/Dev/flywheel/worktrees/fly-224-vendor-pluggable-lead}"
RUNTIME="${WORKTREE}/packages/teamlead/dist/lead-backends/codex/codex-lead-runtime.js"
# This launcher bypasses claude-lead.sh, so bind the founder-time rule's CLI
# authority explicitly instead of relying on an ambient shell variable.
export FLYWHEEL_COMM_CLI="${FLYWHEEL_COMM_CLI:-${WORKTREE}/packages/flywheel-comm/dist/index.js}"
if [ ! -f "${RUNTIME}" ]; then
	echo "codex-lead-runtime.js not built — run: pnpm --filter flywheel-teamlead build" >&2
	exit 1
fi

# Mufasa selectors only; registry is the identity authority.
. "${WORKTREE}/packages/teamlead/scripts/lib/canonical-lead-identity.sh"
canonical_lead_identity_resolve "growth" "mufasa-lead"
# FLY-1597 audit finding: the codex lead runtime now hard-requires FLYWHEEL_COMM_DB
# (same derivation claude-lead.sh:481 uses). These launchers predate that change —
# Mufasa + codex-infra-bot crash-looped 205 times each on "missing required env".
export FLYWHEEL_COMM_DB="${FLYWHEEL_COMM_DB:-${HOME}/.flywheel/comm/${FLYWHEEL_PROJECT_NAME}/comm.db}"
export FLYWHEEL_LEAD_CHAT_CHANNEL_ID="1500600400238084307"  # #mufasa
export FLYWHEEL_CODEX_LEAD_STATE_DIR="${HOME}/.flywheel/state/codex-lead/mufasa-lead"
export CODEX_HOME="${CODEX_HOME:-${HOME}/.codex-mufasa}"   # ISOLATED per-Lead (School auth copy)
export FLYWHEEL_CODEX_BIN="${FLYWHEEL_CODEX_BIN:-$(command -v codex)}"
# Outbound: direct (default) → no Bridge env required. (Set FLYWHEEL_CODEX_LEAD_OUTBOUND=bridge
# only for the later production exactly-once path.)

# Persona injection (FLY-244): identity.md (Mufasa's companion persona) + the
# companion-safety-contract → thread baseInstructions. The runtime SKIPS any file
# it can't read (byte-compat). companion-safety-contract isn't in this worktree
# until 224 merges, so fall back to the fly-231 copy if present.
PERSONA_IDENTITY="${HOME}/Dev/growth/.lead/mufasa-lead/identity.md"
PERSONA_COMPANION="${WORKTREE}/packages/teamlead/lead-rules-base/companion-safety-contract.md"
if [ ! -f "${PERSONA_COMPANION}" ]; then
	PERSONA_COMPANION="${HOME}/Dev/flywheel/worktrees/fly-231-onboard-mufasa-belle/packages/teamlead/lead-rules-base/companion-safety-contract.md"
fi
FOUNDER_LOCAL_TIME_RULE="${WORKTREE}/packages/teamlead/lead-rules-base/founder-local-time.md"
export FLYWHEEL_LEAD_SYSTEM_PROMPT_FILES="${FLYWHEEL_LEAD_SYSTEM_PROMPT_FILES:-${PERSONA_IDENTITY},${PERSONA_COMPANION},${FOUNDER_LOCAL_TIME_RULE}}"

# Bot token: the SAME env var Claude Mufasa uses (MUFASA_BOT_TOKEN). In dry-run we
# tolerate it being unset (the report redacts it and contacts nothing).
if [ "${FLYWHEEL_LEAD_DRY_RUN:-}" != "1" ]; then
	if [ -z "${FLYWHEEL_CODEX_BIN}" ]; then echo "codex CLI not found on PATH" >&2; exit 1; fi
	if [ ! -d "${CODEX_HOME}" ]; then
		echo "CODEX_HOME ${CODEX_HOME} missing — copy the School profile auth there first" >&2
		exit 1
	fi
fi

echo "[run-codex-lead-mufasa] runtime=${RUNTIME} CODEX_HOME=${CODEX_HOME} dryRun=${FLYWHEEL_LEAD_DRY_RUN:-0}"
exec node "${RUNTIME}"
