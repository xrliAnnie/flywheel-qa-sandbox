#!/usr/bin/env bash
# FLY-350 — Mufasa as a HEADLESS, FULL-ACCESS Codex Lead (= Claude-equal).
#
# The generic full-access cutover launcher: Mufasa runs like a Claude Lead —
# workspace-write + network ON + LOCAL gh/git — with NO gateway / broker / scoped
# GH_TOKEN / release-gate / confinement. The ONLY retained control is the team-wide
# founder-gate: the founder-only-authority rule bundle (assembled below via the
# shared resolver) + main branch protection. This is Annie's explicit, informed
# "Codex = Claude-equal" choice (plan v1.51.0 §3) — weaker than the (Z) structural
# no-merge, the SAME trust model every Claude Lead runs under.
#
# 🔴 FOUNDER-GATED: running this FLIPS production Mufasa to full-access. Do NOT run
#    it outside the founder cutover window (plan §7). Pre-cutover acceptance MUST
#    include the M-2 merge red line: from THIS launcher's env, the resolved `gh`
#    actor CANNOT merge a protected branch on the target repo
#    (scripts/verify-merge-actor-denied.sh). Rollback = stop this process and start
#    the prior (companion/TUI) launcher — plan §8. Memory thread 019eaf5d is
#    preserved (the pinned state dir below).
#
#   Dry-run (verify the plan; nothing starts / contacts anything):
#       FLYWHEEL_LEAD_DRY_RUN=1 MUFASA_BOT_TOKEN=... run-codex-lead-mufasa-fullaccess.sh
#
#   Real run (founder window; the wrapper sources ~/.flywheel/.env first so
#   flywheel-comm / Bridge / gh env are present):
#       MUFASA_BOT_TOKEN=... run-codex-lead-mufasa-fullaccess.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Headless runtime from the DEPLOYED main dist (not a worktree).
TEAMLEAD_ROOT="${FLYWHEEL_TEAMLEAD_ROOT:-/Users/xiaorongli/Dev/flywheel/packages/teamlead}"
RUNTIME="${TEAMLEAD_ROOT}/dist/lead-backends/codex/codex-lead-runtime.js"
if [ ! -f "${RUNTIME}" ]; then
	echo "runtime not built at ${RUNTIME} — run: pnpm --filter flywheel-teamlead build" >&2
	exit 1
fi

# ── Mufasa identity (from ~/.flywheel/projects.json: growth / mufasa-lead) ──
export FLYWHEEL_LEAD_ID="mufasa-lead"
export FLYWHEEL_PROJECT_NAME="growth"
export FLYWHEEL_LEAD_BOT_USER_ID="1499895683287748679"     # Mufasa's Discord bot
export FLYWHEEL_LEAD_CHAT_CHANNEL_ID="1500600400238084307" # #mufasa
# #leads-roundtable — discord_send "roundtable" alias + FLY-267 cross-dept inbound.
export FLYWHEEL_LEAD_CROSS_DEPT_CHANNEL_IDS="${FLYWHEEL_LEAD_CROSS_DEPT_CHANNEL_IDS:-1512578695468941333}"
# Memory continuity (codex R2 LOW): the SAME state dir the TUI/companion launcher
# pins, so the persisted thread id resolves and 019eaf5d resumes verbatim.
export FLYWHEEL_CODEX_LEAD_STATE_DIR="${HOME}/.flywheel/state/codex-lead/mufasa-lead"
export CODEX_HOME="${CODEX_HOME:-${HOME}/.codex-mufasa}"    # ISOLATED per-Lead auth
export FLYWHEEL_CODEX_BIN="${FLYWHEEL_CODEX_BIN:-$(command -v codex)}"

# ── full-access tier (= Claude-equal) ──
export FLYWHEEL_CODEX_LEAD_PROFILE="full-access"
export FLYWHEEL_CODEX_LEAD_SANDBOX="workspace-write"
# The project checkout the Lead works IN (cwd + the single writable root). Realpath-
# validated by the runtime (resolveFullAccessProjectRoot); must NOT overlap
# ~/.flywheel / the state dir / CODEX_HOME. Net ON + this writable root come from
# the runtime's buildFullAccessArgv.
export FLYWHEEL_CODEX_LEAD_PROJECT_DIR="${FLYWHEEL_CODEX_LEAD_PROJECT_DIR:-${HOME}/Dev/growth}"

# Persona injection (companion warmth retained in the voice). The full-access
# GOVERNANCE bundle (founder-only-authority + role rules) is appended AFTER persona
# by assemble_full_access_governance below — fail-closed.
PERSONA_IDENTITY="${HOME}/Dev/growth/.lead/mufasa-lead/identity.md"
export FLYWHEEL_LEAD_SYSTEM_PROMPT_FILES="${FLYWHEEL_LEAD_SYSTEM_PROMPT_FILES:-${PERSONA_IDENTITY}}"

# ── FLY-350 H-2: founder-gate governance (the SAME contract a Claude Lead loads) ──
# This launcher execs the runtime DIRECTLY (bypassing codex-lead.sh), so it must
# assemble the governance bundle itself — via the SHARED resolver (one SSOT).
# shellcheck source=lead-rules-bundle.sh
. "${SCRIPT_DIR}/lead-rules-bundle.sh"
if ! assemble_full_access_governance "${FLYWHEEL_LEAD_ID}" "${TEAMLEAD_ROOT}/lead-rules-base"; then
	echo "[run-codex-lead-mufasa-fullaccess] FATAL: governance bundle incomplete (missing founder-only-authority) — refusing to start full-access without its founder-gate contract (fail-closed)" >&2
	exit 1
fi

# ── secrets / Discord (Claude-equal). The runtime posts to Discord directly (direct
#     outbound, no Bridge), so DISCORD_BOT_TOKEN is the only secret this launcher
#     sets. The model shell's flywheel-comm uses TEAMLEAD_API_TOKEN — sourced from
#     ~/.flywheel/.env by the wrapper, the SAME name a Claude pane uses (NOT the
#     FLYWHEEL_API_TOKEN alias). buildFullAccessEnv (H-1) bounds the app-server child
#     to {Claude-pane env ∪ gh-auth} — a full-access Lead never gets MORE secrets in
#     its env than a Claude pane. gh authenticates via the on-disk ~/.config/gh
#     keyring (HOME), the SAME path Claude uses — NO GH_TOKEN required in the env. ──
if [ "${FLYWHEEL_LEAD_DRY_RUN:-}" = "1" ]; then
	export DISCORD_BOT_TOKEN="${MUFASA_BOT_TOKEN:-DRYRUN_PLACEHOLDER}"
else
	export DISCORD_BOT_TOKEN="${MUFASA_BOT_TOKEN:?MUFASA_BOT_TOKEN must be set}"
	if [ -z "${FLYWHEEL_CODEX_BIN}" ]; then echo "codex CLI not found on PATH" >&2; exit 1; fi
	if [ ! -d "${CODEX_HOME}" ]; then echo "CODEX_HOME ${CODEX_HOME} missing" >&2; exit 1; fi
	if [ ! -d "${FLYWHEEL_CODEX_LEAD_PROJECT_DIR}" ]; then echo "project dir ${FLYWHEEL_CODEX_LEAD_PROJECT_DIR} missing" >&2; exit 1; fi
fi

# FLY-398 launcher-layer guard (NON-breaking warning): the HEADLESS app-server form is
# NOT the production Codex Lead deployment form. Annie's hard rule (CLAUDE.md → "Codex
# Lead Deployment — Windowed (TUI), Never Headless"): production Codex Leads must be
# WINDOWED (cmux-visible) → use run-codex-lead-mufasa-tui-fullaccess.sh. This headless
# launcher is kept as a low-level capability for tests / QA / rollback only.
echo "[run-codex-lead-mufasa-fullaccess] ⚠️  HEADLESS app-server form — NOT the production Lead deployment form (Annie's rule: production Codex Leads are WINDOWED/TUI). Use run-codex-lead-mufasa-tui-fullaccess.sh for production; this headless launcher is for tests/QA/rollback only (FLY-398)." >&2
echo "[run-codex-lead-mufasa-fullaccess] FULL-ACCESS (= Claude-equal) | runtime=${RUNTIME} projectDir=${FLYWHEEL_CODEX_LEAD_PROJECT_DIR} role=${FLY350_FULL_ACCESS_ROLE:-dept} dryRun=${FLYWHEEL_LEAD_DRY_RUN:-0}"
exec node "${RUNTIME}"
