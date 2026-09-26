#!/usr/bin/env bash
# FLY-278 / qa-fly-259 — ISOLATED QA launcher for the FLY-259 ③ Codex Lead TUI.
#
# Brings up the daemon-WS + real `codex resume --remote` TUI runtime in a fully
# ISOLATED sandbox so S1–S10 (doc/qa/test-plans/FLY-259-codex-tui-qa-handoff.md)
# can be exercised WITHOUT touching the live production Mufasa.
#
# This is the rebuilt sibling of worker-fly-242's ephemeral /tmp launcher (wiped by
# the 2026-06-16 大重启). It is committed here so the QA is reproducible.
#
# ISOLATION (every axis distinct from production Mufasa AND from Annie's ~/.codex-242
# live-demo home — see handoff §2 "致命隐患修正"):
#   - CODEX_HOME  = ~/.codex-259-qa   (school account; OWN daemon socket)
#   - lead-id     = mufasa-tui-qa     (→ OWN hex state dir, OWN thread, OWN tmux window)
#   - Discord leg = slot-3 #ops-lead-test via TEST_BOT_TOKEN_3 (test bot, NOT MUFASA_BOT_TOKEN)
#
# It goes through the MERGED main-repo codex-lead.sh (FLY259_QA_REPO, default
# /Users/xiaorongli/Dev/flywheel) so QA exercises the shipped+built FLY-259 dist
# that a production cutover would actually run.
#
# Usage:
#   FLYWHEEL_LEAD_DRY_RUN=1 ./qa-fly259-mufasa-tui-slot.sh      # verify plan, nothing starts
#   ./qa-fly259-mufasa-tui-slot.sh                              # real bring-up (long-running)
#   FLYWHEEL_CODEX_LEAD_OUTBOUND=bridge \                       # S5: exactly-once (needs test Bridge)
#     FLYWHEEL_BRIDGE_URL=... FLYWHEEL_API_TOKEN=... ./qa-fly259-mufasa-tui-slot.sh
#
# RED LINE (baked in below as fail-closed guards): this launcher REFUSES to run if
# CODEX_HOME or the bot token would touch production Mufasa or Annie's live demo.
set -euo pipefail

# ── repo holding the merged FLY-259 dist (default: main; QA verifies shipped code) ──
REPO="${FLY259_QA_REPO:-/Users/xiaorongli/Dev/flywheel}"
CODEX_LEAD_SH="${REPO}/packages/teamlead/scripts/codex-lead.sh"
if [ ! -f "${CODEX_LEAD_SH}" ]; then
	echo "[qa-fly259] ERROR: codex-lead.sh not found at ${CODEX_LEAD_SH} (set FLY259_QA_REPO)." >&2
	exit 1
fi
TUI_RUNTIME="${REPO}/packages/teamlead/dist/lead-backends/codex/codex-lead-tui-runtime.js"
if [ ! -f "${TUI_RUNTIME}" ]; then
	echo "[qa-fly259] ERROR: TUI runtime not built at ${TUI_RUNTIME} — run: pnpm --filter flywheel-teamlead build" >&2
	exit 1
fi

# ── ISOLATED Codex home (school account; physically separate daemon socket) ──
export CODEX_HOME="${CODEX_HOME:-${HOME}/.codex-259-qa}"

# ── FAIL-CLOSED production-safety guards (handoff §1/§2 red lines) ──────────────
case "${CODEX_HOME}" in
	*/.codex-mufasa | */.codex-mufasa/)
		echo "[qa-fly259] REFUSING: CODEX_HOME=${CODEX_HOME} is PRODUCTION Mufasa. QA must use ~/.codex-259-qa." >&2
		exit 1 ;;
	*/.codex-242 | */.codex-242/)
		echo "[qa-fly259] REFUSING: CODEX_HOME=${CODEX_HOME} is Annie's live-demo home (shared daemon — S1 kill would break her). Use ~/.codex-259-qa." >&2
		exit 1 ;;
esac
if [ ! -d "${CODEX_HOME}" ]; then
	echo "[qa-fly259] ERROR: isolated CODEX_HOME ${CODEX_HOME} missing — provision it first (school auth + standalone install)." >&2
	exit 1
fi

# ── isolated Discord leg: slot-3 #ops-lead-test (NON-production, NON-Annie) ──
# Pull ONLY TEST_BOT_TOKEN_3 from the shared env file — do NOT `source` the whole
# file: it carries production wiring (FLYWHEEL_LEAD_CROSS_DEPT_CHANNEL_IDS =
# #leads-roundtable, FLYWHEEL_BRIDGE_URL, ...) that would leak the QA instance onto
# production channels. Extract the single var by name, value never echoed.
if [ -z "${TEST_BOT_TOKEN_3:-}" ] && [ -f "${HOME}/.flywheel/.env" ]; then
	TEST_BOT_TOKEN_3="$(grep -E '^[[:space:]]*(export[[:space:]]+)?TEST_BOT_TOKEN_3=' "${HOME}/.flywheel/.env" | tail -1 | sed -E 's/^[^=]*=//; s/^"(.*)"$/\1/; s/^'"'"'(.*)'"'"'$/\1/')"
fi
QA_BOT_TOKEN="${TEST_BOT_TOKEN_3:-}"
# Hard-drop any production cross-dept wiring — the QA instance touches ONLY
# #ops-lead-test (S1–S10 predate FLY-267; QA must not poll the real roundtable).
unset FLYWHEEL_LEAD_CROSS_DEPT_CHANNEL_IDS
if [ "${FLYWHEEL_LEAD_DRY_RUN:-0}" != "1" ] && [ -z "${QA_BOT_TOKEN}" ]; then
	echo "[qa-fly259] ERROR: TEST_BOT_TOKEN_3 not found (set it or add to ~/.flywheel/.env)." >&2
	exit 1
fi
# Guard: the QA token must NOT be the production Mufasa bot token.
if [ -n "${MUFASA_BOT_TOKEN:-}" ] && [ "${QA_BOT_TOKEN}" = "${MUFASA_BOT_TOKEN}" ]; then
	echo "[qa-fly259] REFUSING: QA bot token equals production MUFASA_BOT_TOKEN. Use the slot-3 test bot." >&2
	exit 1
fi
export DISCORD_BOT_TOKEN="${QA_BOT_TOKEN:-DRYRUN_PLACEHOLDER}"
export FLYWHEEL_LEAD_BOT_USER_ID="${FLYWHEEL_LEAD_BOT_USER_ID:-1493075160025272452}"   # flywheel-test-3 (ops-lead-test)
export FLYWHEEL_LEAD_CHAT_CHANNEL_ID="${FLYWHEEL_LEAD_CHAT_CHANNEL_ID:-1493080995862413439}" # #ops-lead-test

# ── TUI runtime wiring (mirrors the production launcher, isolated values) ──
# Mode override: default tui. `FLYWHEEL_CODEX_LEAD_MODE=headless` brings up the
# FLY-224 headless runtime on the SAME state dir — used by SP-2 (reverse-compat:
# headless app-server resumes a thread the TUI daemon advanced).
export FLYWHEEL_CODEX_LEAD_MODE="${FLYWHEEL_CODEX_LEAD_MODE:-tui}"
export FLYWHEEL_CODEX_TUI_CWD="${FLYWHEEL_CODEX_TUI_CWD:-${HOME}/Dev/growth}"
export FLYWHEEL_CODEX_BIN="${FLYWHEEL_CODEX_BIN:-${CODEX_HOME}/packages/standalone/current/codex}"
# Persona (same files production uses) → thread baseInstructions (S8).
PERSONA_IDENTITY="${HOME}/Dev/growth/.lead/mufasa-lead/identity.md"
PERSONA_COMPANION="${REPO}/packages/teamlead/lead-rules-base/companion-safety-contract.md"
export FLYWHEEL_LEAD_SYSTEM_PROMPT_FILES="${FLYWHEEL_LEAD_SYSTEM_PROMPT_FILES:-${PERSONA_IDENTITY},${PERSONA_COMPANION}}"
# Outbound default direct (matches production); bridge is opt-in for S5.
export FLYWHEEL_CODEX_LEAD_OUTBOUND="${FLYWHEEL_CODEX_LEAD_OUTBOUND:-direct}"

# lead-id override (default mufasa-tui-qa). S6 uses distinct ids (…-s6a/…-s6b) so its
# thread-id manipulation never touches the main QA state dir.
QA_LEAD_ID="${QA_LEAD_ID:-mufasa-tui-qa}"
echo "[qa-fly259] repo=${REPO} CODEX_HOME=${CODEX_HOME} lead-id=${QA_LEAD_ID} mode=${FLYWHEEL_CODEX_LEAD_MODE} cwd=${FLYWHEEL_CODEX_TUI_CWD} outbound=${FLYWHEEL_CODEX_LEAD_OUTBOUND} dryRun=${FLYWHEEL_LEAD_DRY_RUN:-0}"
exec /bin/bash "${CODEX_LEAD_SH}" "${QA_LEAD_ID}" "${FLYWHEEL_CODEX_TUI_CWD}" growth
