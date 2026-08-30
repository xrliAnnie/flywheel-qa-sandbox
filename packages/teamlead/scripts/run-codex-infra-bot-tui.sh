#!/usr/bin/env bash
# FLY-871 R2/C6 — Codex Infra Bot as a WINDOWED (cmux TUI) FULL-ACCESS Codex Lead.
#
# The FLY-696 cross self-heal architecture's Codex half: a low-frequency infra bot
# that watches the 4 Claude accounts, executes the account switch (via the audited
# /api/account-switch route), and rescues kicked-out sessions (flywheel-rescue-lead
# / Bridge rescue-retry, fenced by the founder-only-authority R3 carve-out). It runs
# on the ChatGPT account pool — deliberately OUTSIDE the Claude account system it
# guards ("账号体系外").
#
# 🔴 FLY-398 HARD RULE: production Codex leads MUST be windowed (a real
#    `codex resume --remote` TUI pane the founder can watch in cmux) — NEVER the
#    headless app-server form. This launcher is the windowed form. Modeled on
#    run-codex-lead-mufasa-tui-fullaccess.sh (same full-access tier + governance;
#    differs only in identity / channels / isolated CODEX_HOME).
#
# 🔴 FOUNDER-GATED: needs a Discord bot Annie created (token in ~/.flywheel/.env as
#    CODEX_INFRA_BOT_TOKEN) + the projects.json entry + the infra-bot role/permissions
#    + FLYWHEEL_ACCOUNT_SELF_HEAL=1. See the C6 deployment runbook. Do NOT run outside
#    the enable window.
#
#   Dry-run (verify the plan; nothing starts / contacts anything):
#       FLYWHEEL_LEAD_DRY_RUN=1 CODEX_INFRA_BOT_TOKEN=... run-codex-infra-bot-tui.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# TUI runtime + home script from the DEPLOYED main dist (not a worktree).
TEAMLEAD_ROOT="${FLYWHEEL_TEAMLEAD_ROOT:-/Users/xiaorongli/Dev/flywheel/packages/teamlead}"
TUI_RUNTIME="${TEAMLEAD_ROOT}/dist/lead-backends/codex/codex-lead-tui-runtime.js"
TUI_HOME_SH="${TEAMLEAD_ROOT}/scripts/codex-lead-tui-home.sh"
# This launcher bypasses claude-lead.sh, so bind the founder-time rule's CLI
# authority explicitly instead of relying on an ambient shell variable.
FLYWHEEL_PACKAGES_ROOT="$(cd "${TEAMLEAD_ROOT}/.." && pwd)"
export FLYWHEEL_COMM_CLI="${FLYWHEEL_COMM_CLI:-${FLYWHEEL_PACKAGES_ROOT}/flywheel-comm/dist/index.js}"
if [ ! -f "${TUI_RUNTIME}" ]; then
	echo "codex-lead-tui-runtime.js not built at ${TUI_RUNTIME} — run: pnpm --filter flywheel-teamlead build" >&2
	exit 1
fi
if [ ! -f "${TUI_HOME_SH}" ]; then
	echo "codex-lead-tui-home.sh missing at ${TUI_HOME_SH}" >&2
	exit 1
fi

# FLY-871 §12 W2 — repo root, so the dist TUI runtime can resolve
# scripts/lead-alert.sh for its silent-no-pane guard (the runtime runs from
# dist/... and cannot guess the repo root from cwd; claude-lead.sh precedent).
# Derived from the DEPLOYED main dist so the resolved script matches production.
FLYWHEEL_ROOT="$(cd "${TEAMLEAD_ROOT}/../.." && pwd)"
export FLYWHEEL_ROOT
# ── Infra Bot identity: selectors in launcher, coordinates from registry ──
. "${TEAMLEAD_ROOT}/scripts/lib/canonical-lead-identity.sh"
canonical_lead_identity_resolve "flywheel" "codex-infra-bot-lead"
# FLY-1597 audit finding: the codex lead runtime now hard-requires FLYWHEEL_COMM_DB
# (same derivation claude-lead.sh:481 uses). These launchers predate that change —
# Mufasa + codex-infra-bot crash-looped 205 times each on "missing required env".
export FLYWHEEL_COMM_DB="${FLYWHEEL_COMM_DB:-${HOME}/.flywheel/comm/${FLYWHEEL_PROJECT_NAME}/comm.db}"
# The private channel remains runtime routing config; bot id/token are registry identity.
export FLYWHEEL_LEAD_CHAT_CHANNEL_ID="${FLYWHEEL_INFRA_BOT_CHAT_CHANNEL_ID:?FLYWHEEL_INFRA_BOT_CHAT_CHANNEL_ID must be set (#codex-infra-bot)}"
# Alerts channel = the cross-dept mention-gated channel (Codex R1#3: chat channels
# have NO mention gate, so Alerts is wired as cross-dept → only an explicit <@botId>
# assignment post wakes the bot; it never consumes the Bridge status stream).
export FLYWHEEL_LEAD_CROSS_DEPT_CHANNEL_IDS="${FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID:?FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID must be set (the Alerts channel)}"
# Memory continuity: HARD-pinned state dir (a stray .env value must never redirect
# the bot onto a fresh thread = memory loss).
export FLYWHEEL_CODEX_LEAD_STATE_DIR="${HOME}/.flywheel/state/codex-lead/codex-infra-bot-lead"
export CODEX_HOME="${CODEX_HOME:-${HOME}/.codex-infra-bot}"     # ISOLATED per-Lead auth
export FLYWHEEL_CODEX_BIN="${FLYWHEEL_CODEX_BIN:-${CODEX_HOME}/packages/standalone/current/codex}"
export FLYWHEEL_CODEX_LEAD_MODE=tui

# ── full-access tier (= Claude-equal), WINDOWED via the TUI runtime ──
export FLYWHEEL_CODEX_LEAD_PROFILE="full-access"
export FLYWHEEL_CODEX_LEAD_SANDBOX="workspace-write"
# The single writable root / cwd — the flywheel checkout the infra bot operates from.
export FLYWHEEL_CODEX_LEAD_PROJECT_DIR="${FLYWHEEL_CODEX_LEAD_PROJECT_DIR:-${HOME}/Dev/flywheel}"
export FLYWHEEL_CODEX_TUI_CWD="${FLYWHEEL_CODEX_LEAD_PROJECT_DIR}"

# ── proactive discord_send (lead_actions MCP via config.toml; token by NAME, no broker) ──
export FLYWHEEL_LEAD_ACTIONS_MAIN_JS="${TEAMLEAD_ROOT}/dist/lead-backends/codex/lead-actions/lead-actions-main.js"
export FLYWHEEL_LEAD_ACTIONS_NODE_BIN="${FLYWHEEL_LEAD_ACTIONS_NODE_BIN:-$(command -v node || echo node)}"
export FLYWHEEL_LEAD_ACTIONS_STATE_DIR="${FLYWHEEL_CODEX_LEAD_STATE_DIR}"
if [ "${FLYWHEEL_LEAD_DRY_RUN:-}" != "1" ] && [ ! -f "${FLYWHEEL_LEAD_ACTIONS_MAIN_JS}" ]; then
	echo "lead-actions MCP not built at ${FLYWHEEL_LEAD_ACTIONS_MAIN_JS} — run: pnpm --filter flywheel-teamlead build" >&2
	exit 1
fi

# Outbound: DIRECT — preserves the cross-dept (Alerts) mention channel and bypasses
# Bridge outbound authorization (mutually exclusive with cross-dept; the runtime fail-louds).
export FLYWHEEL_CODEX_LEAD_OUTBOUND="${FLYWHEEL_CODEX_LEAD_OUTBOUND:-direct}"

# ── persona + founder-gate governance (the SAME contract a Claude Lead loads, incl the
#    FLY-871 R3 infra self-heal carve-out) ──
PERSONA_IDENTITY="${FLYWHEEL_CODEX_LEAD_PROJECT_DIR}/.lead/codex-infra-bot-lead/identity.md"
export FLYWHEEL_LEAD_SYSTEM_PROMPT_FILES="${FLYWHEEL_LEAD_SYSTEM_PROMPT_FILES:-${PERSONA_IDENTITY}}"
# shellcheck source=lead-rules-bundle.sh
. "${SCRIPT_DIR}/lead-rules-bundle.sh"
if ! assemble_full_access_governance "${FLYWHEEL_LEAD_ID}" "${TEAMLEAD_ROOT}/lead-rules-base"; then
	echo "[run-codex-infra-bot-tui] FATAL: governance bundle incomplete (missing founder-only-authority) — refusing to start full-access without its founder-gate contract (fail-closed)" >&2
	exit 1
fi

# ── secrets / prerequisites ──
if [ "${FLYWHEEL_LEAD_DRY_RUN:-}" != "1" ]; then
	if [ ! -x "${FLYWHEEL_CODEX_BIN}" ]; then
		echo "standalone codex not executable at ${FLYWHEEL_CODEX_BIN} — the remote-control daemon requires it." >&2
		exit 1
	fi
	if [ ! -d "${CODEX_HOME}" ]; then echo "CODEX_HOME ${CODEX_HOME} missing" >&2; exit 1; fi
	if [ ! -d "${FLYWHEEL_CODEX_LEAD_PROJECT_DIR}" ]; then echo "project dir ${FLYWHEEL_CODEX_LEAD_PROJECT_DIR} missing" >&2; exit 1; fi
	FLYWHEEL_CODEX_TUI_HOME="${CODEX_HOME}" FLYWHEEL_CODEX_TUI_CWD="${FLYWHEEL_CODEX_TUI_CWD}" \
		/bin/bash "${TUI_HOME_SH}" ensure-home
fi

echo "[run-codex-infra-bot-tui] WINDOWED FULL-ACCESS Codex Infra Bot | runtime=${TUI_RUNTIME} projectDir=${FLYWHEEL_CODEX_LEAD_PROJECT_DIR} outbound=${FLYWHEEL_CODEX_LEAD_OUTBOUND} dryRun=${FLYWHEEL_LEAD_DRY_RUN:-0}"
exec node "${TUI_RUNTIME}"
