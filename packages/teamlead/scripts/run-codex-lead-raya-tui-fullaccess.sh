#!/usr/bin/env bash
# FLY-2131 — Raya as a windowed, full-access Codex Lead.
# Activation is a deployment action; this launcher only composes and validates
# the canonical registry identity, isolated CODEX_HOME, external workspace, and
# prompt/memory/governance chain. Use FLYWHEEL_LEAD_DRY_RUN=1 before cutover.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEAMLEAD_ROOT="${FLYWHEEL_TEAMLEAD_ROOT:-/Users/xiaorongli/Dev/flywheel/packages/teamlead}"
TUI_RUNTIME="${TEAMLEAD_ROOT}/dist/lead-backends/codex/codex-lead-tui-runtime.js"
TUI_HOME_SH="${TEAMLEAD_ROOT}/scripts/codex-lead-tui-home.sh"
FLYWHEEL_PACKAGES_ROOT="$(cd "${TEAMLEAD_ROOT}/.." && pwd)"
export FLYWHEEL_COMM_CLI="${FLYWHEEL_COMM_CLI:-${FLYWHEEL_PACKAGES_ROOT}/flywheel-comm/dist/index.js}"

if [ ! -f "${TUI_RUNTIME}" ]; then
	echo "codex-lead-tui-runtime.js not built at ${TUI_RUNTIME}" >&2
	exit 1
fi
if [ ! -f "${TUI_HOME_SH}" ]; then
	echo "codex-lead-tui-home.sh missing at ${TUI_HOME_SH}" >&2
	exit 1
fi

. "${TEAMLEAD_ROOT}/scripts/lib/canonical-lead-identity.sh"
canonical_lead_identity_resolve "raya" "raya"

export FLYWHEEL_COMM_DB="${FLYWHEEL_COMM_DB:-${HOME}/.flywheel/comm/raya/comm.db}"
export FLYWHEEL_LEAD_CHAT_CHANNEL_ID="${FLYWHEEL_LEAD_CHAT_CHANNEL_ID:-1542079099928059987}"
export FLYWHEEL_LEAD_CROSS_DEPT_CHANNEL_IDS="${FLYWHEEL_LEAD_CROSS_DEPT_CHANNEL_IDS:-1512578695468941333}"
export FLYWHEEL_CODEX_LEAD_STATE_DIR="${HOME}/.flywheel/state/codex-lead/raya"
export CODEX_HOME="${CODEX_HOME:-${HOME}/.flywheel/raya/codex-home}"
export FLYWHEEL_CODEX_BIN="${FLYWHEEL_CODEX_BIN:-${CODEX_HOME}/packages/standalone/current/codex}"
export FLYWHEEL_CODEX_LEAD_MODE=tui

RAYA_CODE_ROOT="${RAYA_CODE_ROOT:-${HOME}/.flywheel/raya/code}"
RAYA_LEAD_WORKSPACE="${RAYA_LEAD_WORKSPACE:-${HOME}/Dev/raya-lead-workspace}"
RAYA_IDENTITY_FILE="${RAYA_CODE_ROOT}/IDENTITY.md"
RAYA_MEMORY_FILE="${RAYA_LEAD_WORKSPACE}/memory/MEMORY.md"
export RAYA_METRICS_DIR="${RAYA_METRICS_DIR:-${HOME}/.flywheel/raya/data/metrics}"

for required_file in "${RAYA_IDENTITY_FILE}" "${RAYA_MEMORY_FILE}"; do
	if [ ! -r "${required_file}" ]; then
		echo "required Raya prompt file is not readable: ${required_file}" >&2
		exit 1
	fi
done
for required_dir in "${RAYA_LEAD_WORKSPACE}" "${RAYA_LEAD_WORKSPACE}/state" "${RAYA_METRICS_DIR}"; do
	if [ ! -d "${required_dir}" ]; then
		echo "required Raya runtime directory is missing: ${required_dir}" >&2
		exit 1
	fi
done

export FLYWHEEL_CODEX_LEAD_PROFILE=full-access
export FLYWHEEL_CODEX_LEAD_SANDBOX=workspace-write
export FLYWHEEL_CODEX_LEAD_PROJECT_DIR="${RAYA_LEAD_WORKSPACE}"
export FLYWHEEL_CODEX_TUI_CWD="${FLYWHEEL_CODEX_LEAD_PROJECT_DIR}"
export FLYWHEEL_LEAD_ACTIONS_MAIN_JS="${TEAMLEAD_ROOT}/dist/lead-backends/codex/lead-actions/lead-actions-main.js"
export FLYWHEEL_LEAD_ACTIONS_NODE_BIN="${FLYWHEEL_LEAD_ACTIONS_NODE_BIN:-$(command -v node || echo node)}"
export FLYWHEEL_LEAD_ACTIONS_STATE_DIR="${FLYWHEEL_CODEX_LEAD_STATE_DIR}"
export FLYWHEEL_CODEX_LEAD_OUTBOUND="${FLYWHEEL_CODEX_LEAD_OUTBOUND:-direct}"

if [ "${FLYWHEEL_LEAD_DRY_RUN:-0}" != "1" ] && [ ! -f "${FLYWHEEL_LEAD_ACTIONS_MAIN_JS}" ]; then
	echo "lead-actions MCP not built at ${FLYWHEEL_LEAD_ACTIONS_MAIN_JS}" >&2
	exit 1
fi

export FLYWHEEL_LEAD_SYSTEM_PROMPT_FILES="${RAYA_IDENTITY_FILE},${RAYA_MEMORY_FILE}"
. "${SCRIPT_DIR}/lead-rules-bundle.sh"
if ! assemble_full_access_governance "${FLYWHEEL_LEAD_ID}" "${TEAMLEAD_ROOT}/lead-rules-base"; then
	echo "[run-codex-lead-raya-tui-fullaccess] FATAL: governance bundle incomplete" >&2
	exit 1
fi

if [ "${FLYWHEEL_LEAD_DRY_RUN:-0}" != "1" ]; then
	if [ ! -x "${FLYWHEEL_CODEX_BIN}" ]; then
		echo "standalone codex not executable at ${FLYWHEEL_CODEX_BIN}" >&2
		exit 1
	fi
	if [ ! -d "${CODEX_HOME}" ]; then
		echo "CODEX_HOME ${CODEX_HOME} missing" >&2
		exit 1
	fi
	FLYWHEEL_CODEX_TUI_HOME="${CODEX_HOME}" \
		FLYWHEEL_CODEX_TUI_CWD="${FLYWHEEL_CODEX_TUI_CWD}" \
		/bin/bash "${TUI_HOME_SH}" ensure-home
fi

echo "[run-codex-lead-raya-tui-fullaccess] WINDOWED FULL-ACCESS | model=${FLYWHEEL_LEAD_MODEL:-default} effort=${FLYWHEEL_LEAD_EFFORT:-default} context=${FLYWHEEL_LEAD_MODEL_CONTEXT_WINDOW:-default} workspace=${RAYA_LEAD_WORKSPACE} dryRun=${FLYWHEEL_LEAD_DRY_RUN:-0}"
exec node "${TUI_RUNTIME}"
