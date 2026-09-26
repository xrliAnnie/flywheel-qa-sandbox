#!/usr/bin/env bash
# FLY-350 (Z) unit 6 — Mufasa as a HEADLESS, net-off WRITE-CAPABLE Codex Lead.
#
# This is the (Z) cutover launcher: Mufasa goes TUI→headless and gains the
# write-capable tier — a workspace-write shell that is NET-OFF (no shell network,
# no GH_TOKEN in the shell) plus the gateway's git_push / open_pr / discord_send.
# The model can WRITE files + make LOCAL commits and REQUEST a push/PR through the
# gateway; it can NOT merge (no :cool:/merge tool, no shell token/network), so the
# merge red line stays structural.
#
# 🔴 FOUNDER-GATED: running this FLIPS production Mufasa to write-capable. Do NOT
#    run it outside the founder cutover window (see plan §7). Rollback = stop this
#    process and start run-codex-lead-mufasa-tui.sh (FLY-278 TUI) — plan §8.
#
#   Dry-run (verify the release plan; nothing starts / contacts anything):
#       FLYWHEEL_LEAD_DRY_RUN=1 \
#       MUFASA_BOT_TOKEN=... MUFASA_GH_TOKEN=... \
#       run-codex-lead-mufasa-writecapable.sh
#
#   Real run (founder window):
#       MUFASA_BOT_TOKEN=... MUFASA_GH_TOKEN=... run-codex-lead-mufasa-writecapable.sh
set -euo pipefail

# Headless runtime from the DEPLOYED main dist (not a worktree — the trusted
# control-plane root the release gate forbids the scratch from overlapping).
TEAMLEAD_ROOT="${FLYWHEEL_TEAMLEAD_ROOT:-/Users/xiaorongli/Dev/flywheel/packages/teamlead}"
RUNTIME="${TEAMLEAD_ROOT}/dist/lead-backends/codex/codex-lead-runtime.js"
GATEWAY_ENTRY="${TEAMLEAD_ROOT}/dist/lead-backends/codex/gateway/gateway-main.js"
if [ ! -f "${RUNTIME}" ] || [ ! -f "${GATEWAY_ENTRY}" ]; then
	echo "runtime/gateway not built at ${TEAMLEAD_ROOT}/dist — run: pnpm --filter flywheel-teamlead build" >&2
	exit 1
fi

# ── Mufasa identity (from ~/.flywheel/projects.json: growth / mufasa-lead) ──
export FLYWHEEL_LEAD_ID="mufasa-lead"
export FLYWHEEL_PROJECT_NAME="growth"
export FLYWHEEL_LEAD_BOT_USER_ID="1499895683287748679"     # Mufasa's Discord bot
export FLYWHEEL_LEAD_CHAT_CHANNEL_ID="1500600400238084307" # #mufasa
# #leads-roundtable — discord_send "roundtable" alias + FLY-267 cross-dept inbound.
export FLYWHEEL_LEAD_CROSS_DEPT_CHANNEL_IDS="${FLYWHEEL_LEAD_CROSS_DEPT_CHANNEL_IDS:-1512578695468941333}"
export FLYWHEEL_CODEX_LEAD_STATE_DIR="${HOME}/.flywheel/state/codex-lead/mufasa-lead"
export CODEX_HOME="${CODEX_HOME:-${HOME}/.codex-mufasa}"    # ISOLATED per-Lead auth
export FLYWHEEL_CODEX_BIN="${FLYWHEEL_CODEX_BIN:-$(command -v codex)}"

# ── (Z) write-capable tier ──
export FLYWHEEL_CODEX_LEAD_PROFILE="write-capable"
export FLYWHEEL_CODEX_LEAD_SANDBOX="workspace-write"
# Net-off + writableRoots=ONLY this scratch is enforced by the runtime's
# buildConfinementArgv (network_access=false) + resolveLeadWorkspace (rejects any
# overlap with ~/.flywheel / state / CODEX_HOME / the teamlead+gateway control
# plane). The scratch MUST be a dedicated dir outside all of those.
export FLYWHEEL_CODEX_LEAD_WORKSPACE="${FLYWHEEL_CODEX_LEAD_WORKSPACE:-${HOME}/.flywheel/scratch/mufasa-lead}"
mkdir -p "${FLYWHEEL_CODEX_LEAD_WORKSPACE}"
# Release-gate inputs (assertWriteCapableRelease, plan §7):
export FLYWHEEL_FOUNDER_DISCORD_USER_ID="${FLYWHEEL_FOUNDER_DISCORD_USER_ID:-1138241636057481306}" # Annie
export FLYWHEEL_CODEX_CLI_VERSION_ALLOWLIST="${FLYWHEEL_CODEX_CLI_VERSION_ALLOWLIST:-0.141.0}"
export FLYWHEEL_GATEWAY_ENTRY="${GATEWAY_ENTRY}"
export FLYWHEEL_GATEWAY_CONFIRM_CHANNEL_ID="${FLYWHEEL_GATEWAY_CONFIRM_CHANNEL_ID:-${FLYWHEEL_LEAD_CHAT_CHANNEL_ID}}"

# ── gateway-proxied PR scope (unit 4/5) ──
# owner/repo the gateway scopes git_push/open_pr to.
export FLYWHEEL_GATEWAY_PROJECT_REPO="${FLYWHEEL_GATEWAY_PROJECT_REPO:-xrliAnnie/growth}"
# Outbound: DIRECT (cross-dept + bridge mode fail-loud until FLY-274 lands).
# (FLYWHEEL_CODEX_LEAD_OUTBOUND defaults to direct — do NOT set bridge here.)

# Persona injection (companion warmth retained — write-capable ≠ companion flag,
# but the persona prose still shapes the voice).
PERSONA_IDENTITY="${HOME}/Dev/growth/.lead/mufasa-lead/identity.md"
PERSONA_COMPANION="${TEAMLEAD_ROOT}/lead-rules-base/companion-safety-contract.md"
export FLYWHEEL_LEAD_SYSTEM_PROMPT_FILES="${FLYWHEEL_LEAD_SYSTEM_PROMPT_FILES:-${PERSONA_IDENTITY},${PERSONA_COMPANION}}"

# ── secrets (broker-served into the gateway ONLY; the runtime washes the
#     app-server env of *TOKEN*/*SECRET*/*KEY* so NEITHER reaches the model shell) ──
if [ "${FLYWHEEL_LEAD_DRY_RUN:-}" = "1" ]; then
	export DISCORD_BOT_TOKEN="${MUFASA_BOT_TOKEN:-DRYRUN_PLACEHOLDER}"
	export FLYWHEEL_API_TOKEN="${FLYWHEEL_API_TOKEN:-DRYRUN_PLACEHOLDER}"
	export FLYWHEEL_GATEWAY_GITHUB_TOKEN="${MUFASA_GH_TOKEN:-DRYRUN_PLACEHOLDER}"
else
	export DISCORD_BOT_TOKEN="${MUFASA_BOT_TOKEN:?MUFASA_BOT_TOKEN must be set}"
	export FLYWHEEL_API_TOKEN="${FLYWHEEL_API_TOKEN:?FLYWHEEL_API_TOKEN must be set (gateway → Bridge action endpoints)}"
	export FLYWHEEL_GATEWAY_GITHUB_TOKEN="${MUFASA_GH_TOKEN:?MUFASA_GH_TOKEN (fine-grained: contents:write + pull_requests:write) must be set}"
	if [ -z "${FLYWHEEL_CODEX_BIN}" ]; then echo "codex CLI not found on PATH" >&2; exit 1; fi
	if [ ! -d "${CODEX_HOME}" ]; then echo "CODEX_HOME ${CODEX_HOME} missing" >&2; exit 1; fi
fi

echo "[run-codex-lead-mufasa-writecapable] (Z) headless write-capable | runtime=${RUNTIME} workspace=${FLYWHEEL_CODEX_LEAD_WORKSPACE} repo=${FLYWHEEL_GATEWAY_PROJECT_REPO} dryRun=${FLYWHEEL_LEAD_DRY_RUN:-0}"
exec node "${RUNTIME}"
