#!/usr/bin/env bash
# FLY-398 — Mufasa as a WINDOWED (cmux TUI) FULL-ACCESS Codex Lead (= Claude-equal).
#
# The Annie-mandated combination (Option A): Mufasa is BOTH windowed (visible in cmux,
# a real `codex resume --remote` pane the founder can watch/drive) AND full-access
# (workspace-write + network ON + local gh/git, NO gateway/broker/release-gate). The
# ONLY retained control is the team-wide founder-gate: the founder-only-authority rule
# bundle + main branch protection — the SAME trust model every Claude Lead runs under.
#
# This is the TUI sibling of run-codex-lead-mufasa-fullaccess.sh (headless app-server):
# the two share the full-access tier + governance, and differ ONLY where the TUI path
# requires it (standalone codex daemon backend, FLYWHEEL_CODEX_TUI_CWD, the §10 config
# gate runs against config.toml instead of `-c` argv, the runtime OWNS the daemon
# stop/start so a stale read-only daemon can never satisfy a full-access boot).
#
# 🔴 FOUNDER-GATED: running this FLIPS production Mufasa to windowed full-access. Do NOT
#    run it outside the founder cutover window. Pre-cutover acceptance MUST include the
#    M-2 merge red line (scripts/verify-merge-actor-denied.sh) recorded as exactly one
#    of MERGE_RED_LINE_PASS_NON_ADMIN or ADMIN_EXCEPTION_ACCEPTED_BY_FOUNDER. Rollback =
#    stop this process and start the prior launcher (headless full-access OR read-only
#    TUI). Memory thread 019eaf5d is preserved (the pinned state dir below).
#
#   Dry-run (verify the plan; nothing starts / contacts anything):
#       FLYWHEEL_LEAD_DRY_RUN=1 MUFASA_BOT_TOKEN=... run-codex-lead-mufasa-tui-fullaccess.sh
#
#   Real run (founder window; the wrapper sources ~/.flywheel/.env first so
#   flywheel-comm / Bridge / gh env are present):
#       MUFASA_BOT_TOKEN=... run-codex-lead-mufasa-tui-fullaccess.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# TUI runtime + home script from the DEPLOYED main dist (not a worktree).
TEAMLEAD_ROOT="${FLYWHEEL_TEAMLEAD_ROOT:-/Users/xiaorongli/Dev/flywheel/packages/teamlead}"
export FLYWHEEL_ROOT="$(cd "${TEAMLEAD_ROOT}/../.." && pwd)"
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

# ── Mufasa identity: selectors in launcher, coordinates from registry ──
. "${TEAMLEAD_ROOT}/scripts/lib/canonical-lead-identity.sh"
canonical_lead_identity_resolve "growth" "mufasa-lead"
. "${FLYWHEEL_ROOT}/scripts/lib/lead-address.sh"
# FLY-1597 audit finding: the codex lead runtime now hard-requires FLYWHEEL_COMM_DB
# (same derivation claude-lead.sh:481 uses). These launchers predate that change —
# Mufasa + codex-infra-bot crash-looped 205 times each on "missing required env".
export FLYWHEEL_COMM_DB="${FLYWHEEL_COMM_DB:-${HOME}/.flywheel/comm/${FLYWHEEL_PROJECT_NAME}/comm.db}"
export FLYWHEEL_LEAD_CHAT_CHANNEL_ID="1500600400238084307" # #mufasa
# #leads-roundtable — discord_send "roundtable" alias + FLY-267 cross-dept inbound.
export FLYWHEEL_LEAD_CROSS_DEPT_CHANNEL_IDS="${FLYWHEEL_LEAD_CROSS_DEPT_CHANNEL_IDS:-1512578695468941333}"
# Memory continuity: the SAME state dir the headless/TUI launchers pin, so the
# persisted thread id resolves and 019eaf5d resumes verbatim. HARD-pinned (NOT
# env-overridable): a stray FLYWHEEL_CODEX_LEAD_STATE_DIR in the sourced .env must
# never silently redirect Mufasa onto a fresh thread (= memory loss).
export FLYWHEEL_CODEX_LEAD_STATE_DIR="${HOME}/.flywheel/state/codex-lead/mufasa-lead"
export FLYWHEEL_CODEX_LEAD_HOME_KEY=mufasa
codex_home_default="$(derive_codex_lead_home "$FLYWHEEL_CODEX_LEAD_HOME_KEY")" || exit $?
export CODEX_HOME="${CODEX_HOME:-$codex_home_default}"    # ISOLATED per-Lead auth
# TUI/daemon backend REQUIRES the standalone codex; npm codex has no daemon backend.
export FLYWHEEL_CODEX_BIN="${FLYWHEEL_CODEX_BIN:-${CODEX_HOME}/packages/standalone/current/codex}"
# The founder's interactive TUI working dir (`codex resume --remote -C <cwd>`) = the
# full-access project root (writable_roots = [this]).
export FLYWHEEL_CODEX_TUI_CWD="${FLYWHEEL_CODEX_TUI_CWD:-${HOME}/Dev/growth}"
export FLYWHEEL_CODEX_LEAD_MODE=tui

# ── full-access tier (= Claude-equal), WINDOWED via the TUI runtime ──
export FLYWHEEL_CODEX_LEAD_PROFILE="full-access"
export FLYWHEEL_CODEX_LEAD_SANDBOX="workspace-write"
# The project checkout the Lead works IN (cwd + the single writable root). Realpath-
# validated by the runtime (resolveFullAccessProjectRoot); must NOT overlap
# ~/.flywheel / the state dir / CODEX_HOME.
export FLYWHEEL_CODEX_LEAD_PROJECT_DIR="${FLYWHEEL_CODEX_LEAD_PROJECT_DIR:-${HOME}/Dev/growth}"
# Codex R1 HIGH-2: SINGLE SOURCE OF TRUTH for the full-access root. The founder TUI cwd,
# the daemon's config.toml writable_roots, and the runtime-validated project root MUST be
# the same path — so the founder TUI cwd is DERIVED from the project root (not an
# independent var). The runtime additionally asserts config.toml's writable_roots equals
# the realpath-validated project root (assertFullAccessSandboxConfig), so any divergence
# fails closed before the daemon starts.
export FLYWHEEL_CODEX_TUI_CWD="${FLYWHEEL_CODEX_LEAD_PROJECT_DIR}"

# ── proactive discord_send (lead_actions MCP via config.toml; token by NAME, no broker) ──
export FLYWHEEL_LEAD_ACTIONS_MAIN_JS="${TEAMLEAD_ROOT}/dist/lead-backends/codex/lead-actions/lead-actions-main.js"
export FLYWHEEL_LEAD_ACTIONS_NODE_BIN="${FLYWHEEL_LEAD_ACTIONS_NODE_BIN:-$(command -v node || echo node)}"
export FLYWHEEL_LEAD_ACTIONS_STATE_DIR="${FLYWHEEL_CODEX_LEAD_STATE_DIR}"
if [ "${FLYWHEEL_LEAD_DRY_RUN:-}" != "1" ] && [ ! -f "${FLYWHEEL_LEAD_ACTIONS_MAIN_JS}" ]; then
	echo "lead-actions MCP not built at ${FLYWHEEL_LEAD_ACTIONS_MAIN_JS} — run: pnpm --filter flywheel-teamlead build" >&2
	exit 1
fi

# Outbound: DIRECT (Mufasa's production mode) — preserves #leads-roundtable (FLY-267
# cross-dept) and bypasses Bridge outbound authorization (the original roundtable-403
# fix). Bridge mode is mutually exclusive with cross-dept (the runtime fail-louds).
export FLYWHEEL_CODEX_LEAD_OUTBOUND="${FLYWHEEL_CODEX_LEAD_OUTBOUND:-direct}"

# ── persona + founder-gate governance (the SAME contract a Claude Lead loads) ──
# Persona first (identity.md), then the SHARED resolver appends the full-access
# GOVERNANCE bundle (founder-only-authority + role rules) — fail-closed.
PERSONA_IDENTITY="${HOME}/Dev/growth/.lead/mufasa-lead/identity.md"
export FLYWHEEL_LEAD_SYSTEM_PROMPT_FILES="${FLYWHEEL_LEAD_SYSTEM_PROMPT_FILES:-${PERSONA_IDENTITY}}"
# shellcheck source=lead-rules-bundle.sh
. "${SCRIPT_DIR}/lead-rules-bundle.sh"
if ! assemble_full_access_governance "${FLYWHEEL_LEAD_ID}" "${TEAMLEAD_ROOT}/lead-rules-base"; then
	echo "[run-codex-lead-mufasa-tui-fullaccess] FATAL: governance bundle incomplete (missing founder-only-authority) — refusing to start full-access without its founder-gate contract (fail-closed)" >&2
	exit 1
fi

# ── secrets / prerequisites ──
if [ "${FLYWHEEL_LEAD_DRY_RUN:-}" != "1" ]; then
	if [ ! -x "${FLYWHEEL_CODEX_BIN}" ]; then
		echo "standalone codex not executable at ${FLYWHEEL_CODEX_BIN} — the remote-control daemon requires it (npm codex has no daemon backend)." >&2
		exit 1
	fi
	if [ ! -d "${CODEX_HOME}" ]; then echo "CODEX_HOME ${CODEX_HOME} missing" >&2; exit 1; fi
	if [ ! -d "${FLYWHEEL_CODEX_LEAD_PROJECT_DIR}" ]; then echo "project dir ${FLYWHEEL_CODEX_LEAD_PROJECT_DIR} missing" >&2; exit 1; fi
	# Assemble/validate the isolated home (writes the full-access config.toml +
	# lead_actions MCP block). DEFER ensure-daemon to the runtime (pin ⑤): the runtime
	# owns daemon stop/start so a stale read-only daemon can never satisfy a full-access
	# boot, and the daemon env is the H-1 positive allowlist (not this launcher's raw env).
	FLYWHEEL_CODEX_TUI_HOME="${CODEX_HOME}" FLYWHEEL_CODEX_TUI_CWD="${FLYWHEEL_CODEX_TUI_CWD}" \
		/bin/bash "${TUI_HOME_SH}" ensure-home
fi

echo "[run-codex-lead-mufasa-tui-fullaccess] WINDOWED FULL-ACCESS (= Claude-equal TUI) | runtime=${TUI_RUNTIME} projectDir=${FLYWHEEL_CODEX_LEAD_PROJECT_DIR} cwd=${FLYWHEEL_CODEX_TUI_CWD} outbound=${FLYWHEEL_CODEX_LEAD_OUTBOUND} role=${FLY350_FULL_ACCESS_ROLE:-dept} dryRun=${FLYWHEEL_LEAD_DRY_RUN:-0}"
exec node "${TUI_RUNTIME}"
