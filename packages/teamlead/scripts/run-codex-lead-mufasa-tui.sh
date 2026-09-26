#!/usr/bin/env bash
# FLY-259 PR-F — Mufasa-on-Codex ③ TUI cutover launcher (daemon-WS + real terminal).
#
# Runs Mufasa as a CODEX Lead with a REAL interactive `codex resume --remote` TUI
# pane in cmux (window `growth-mufasa-lead`) that shares the Lead's thread. Discord
# stays connected (same brain, same memory). Read-only companion — chat-only until
# FLY-245 (write-capable Codex Lead is fail-closed by the runtime).
#
# This is the TUI sibling of run-codex-lead-mufasa.sh (FLY-224 headless). The two
# differ ONLY where the TUI path requires it:
#   - execs codex-lead-tui-runtime.js (daemon-WS sidecar) instead of the headless
#     codex-lead-runtime.js;
#   - FLYWHEEL_CODEX_BIN points at the STANDALONE codex (daemon backend; npm codex
#     has no daemon backend);
#   - sets FLYWHEEL_CODEX_TUI_CWD (the founder's `-C`) + FLYWHEEL_CODEX_LEAD_MODE=tui;
#   - defaults outbound to DIRECT (team-lead: zero regression + preserves the
#     #leads-roundtable cross-dept channel Annie uses); `bridge` is a guarded
#     opt-in for exactly-once, mutually exclusive with cross-dept (guard below);
#   - ensures the isolated CODEX_HOME + remote-control daemon before start.
#
# MEMORY CONTINUITY (critical): pins the SAME state dir as the headless launcher
# (~/.flywheel/state/codex-lead/mufasa-lead). The thread-id lives at
# <stateDir>/thread-id, so reusing this dir makes the TUI runtime RESUME Mufasa's
# existing thread — no memory loss (SP-2). NOTE: this is why the cutover does NOT
# go through codex-lead.sh — that generic launcher computes a DIFFERENT hex state
# dir (growth__mufasa-lead-<hex>), which would point at an empty dir and start a
# FRESH thread → memory loss. The headless production launcher already bypasses
# codex-lead.sh for the same reason; this launcher follows that precedent.
#
#   Dry-run (verify the plan, nothing starts):  FLYWHEEL_LEAD_DRY_RUN=1 run-codex-lead-mufasa-tui.sh
#   Real run:                                    MUFASA_BOT_TOKEN=... FLYWHEEL_BRIDGE_URL=... FLYWHEEL_API_TOKEN=... run-codex-lead-mufasa-tui.sh
#
# NOT executed automatically. The production cutover is an irreversible action =
# ship, gated on Annie's explicit approval. See the runbook:
#   doc/engineer/implementation/FLY-259-mufasa-tui-cutover-runbook.md
#
# Rollback: stop this process, restore the headless launchd job (plist/wrapper),
# restart the headless Mufasa. See rollback-codex-lead-mufasa-tui.sh.
set -euo pipefail

WORKTREE="${FLY224_WORKTREE:-/Users/xiaorongli/Dev/flywheel}"
TUI_RUNTIME="${WORKTREE}/packages/teamlead/dist/lead-backends/codex/codex-lead-tui-runtime.js"
TUI_HOME_SH="${WORKTREE}/packages/teamlead/scripts/codex-lead-tui-home.sh"
if [ ! -f "${TUI_RUNTIME}" ]; then
	echo "codex-lead-tui-runtime.js not built — run: pnpm --filter flywheel-teamlead build" >&2
	exit 1
fi
if [ ! -f "${TUI_HOME_SH}" ]; then
	echo "codex-lead-tui-home.sh missing at ${TUI_HOME_SH}" >&2
	exit 1
fi

# Mufasa's real config (from ~/.flywheel/projects.json: growth / mufasa-lead).
export FLYWHEEL_LEAD_ID="mufasa-lead"
export FLYWHEEL_PROJECT_NAME="growth"
export FLYWHEEL_LEAD_BOT_USER_ID="1499895683287748679"   # reuse Mufasa's Discord bot
export FLYWHEEL_LEAD_CHAT_CHANNEL_ID="1500600400238084307"  # #mufasa
# MEMORY-PRESERVING state dir pin — SAME path as the headless launcher so the TUI
# runtime resumes Mufasa's existing thread (thread-id file). HARD-pinned (NOT
# env-overridable): the wrapper sources the shared ~/.flywheel/.env, and a stray
# FLYWHEEL_CODEX_LEAD_STATE_DIR there must NEVER silently redirect Mufasa onto a
# fresh thread (= memory loss). Codex R1 HIGH — a `:-` default would defeat the
# whole continuity guarantee.
export FLYWHEEL_CODEX_LEAD_STATE_DIR="${HOME}/.flywheel/state/codex-lead/mufasa-lead"
export CODEX_HOME="${CODEX_HOME:-${HOME}/.codex-mufasa}"   # ISOLATED per-Lead (School auth copy)
# TUI/daemon backend REQUIRES the standalone codex; npm codex has no daemon backend.
export FLYWHEEL_CODEX_BIN="${FLYWHEEL_CODEX_BIN:-${CODEX_HOME}/packages/standalone/current/codex}"
# The founder's interactive TUI working dir (`codex resume --remote -C <cwd>`).
export FLYWHEEL_CODEX_TUI_CWD="${FLYWHEEL_CODEX_TUI_CWD:-${HOME}/Dev/growth}"
# Mode marker (informational; this launcher execs the TUI runtime directly).
export FLYWHEEL_CODEX_LEAD_MODE=tui

# Outbound: DIRECT by default (team-lead decision) — Mufasa's current production
# mode, ZERO regression, and it preserves #leads-roundtable (FLY-267 cross-dept,
# which Annie actively uses). Trade-off: direct has process-local dedup only, so a
# restart window can double-send (acceptable for a read-only companion). `bridge`
# gives durable cross-process exactly-once (D3a) BUT is mutually exclusive with
# cross-dept (guard below) → opt in only after the bridge-vs-direct call at cutover.
# The real fix that removes the trade-off entirely = FLY-267 server-side
# cross-dept-over-bridge (follow-up). Bridge mode REQUIRES FLYWHEEL_BRIDGE_URL +
# FLYWHEEL_API_TOKEN (the runtime parser also fail-louds; we check early for clarity
# + so a misconfig never reaches the side-effecting ensures).
export FLYWHEEL_CODEX_LEAD_OUTBOUND="${FLYWHEEL_CODEX_LEAD_OUTBOUND:-direct}"
# Codex R2 MED: validate the value explicitly. The runtime parser treats EVERY
# non-"bridge" string as "direct", so a typo like "bridg" would silently fall to
# direct AND bypass the bridge guards below — fail loud instead.
case "${FLYWHEEL_CODEX_LEAD_OUTBOUND}" in
	direct | bridge) ;;
	*)
		echo "[run-codex-lead-mufasa-tui] ERROR: FLYWHEEL_CODEX_LEAD_OUTBOUND='${FLYWHEEL_CODEX_LEAD_OUTBOUND}' invalid — must be 'direct' or 'bridge'." >&2
		exit 1
		;;
esac
if [ "${FLYWHEEL_CODEX_LEAD_OUTBOUND}" = "bridge" ]; then
	# Codex R1 HIGH: bridge outbound is MUTUALLY EXCLUSIVE with FLY-267 cross-dept
	# channels — the runtime hard-throws on `crossDept>0 && bridge` (a shared-channel
	# reply would 403 in bridge mode; server-side cross-dept-over-bridge is a FLY-267
	# follow-up). Mufasa's production .env carries FLYWHEEL_LEAD_CROSS_DEPT_CHANNEL_IDS
	# (#leads-roundtable, which Annie actively uses), so a bridge cutover would fail to
	# start AND drop roundtable. Surface the conflict HERE (clear, actionable) instead
	# of a cryptic runtime crash — the bridge-vs-direct choice is a runbook decision.
	if [ -n "${FLYWHEEL_LEAD_CROSS_DEPT_CHANNEL_IDS:-}" ]; then
		echo "[run-codex-lead-mufasa-tui] ERROR: outbound=bridge is INCOMPATIBLE with cross-dept channels (FLYWHEEL_LEAD_CROSS_DEPT_CHANNEL_IDS is set)." >&2
		echo "  The runtime rejects cross-dept + bridge (shared-channel replies 403 in bridge mode)." >&2
		echo "  Choose ONE for the cutover (see the runbook §Outbound decision):" >&2
		echo "    • keep #leads-roundtable → FLYWHEEL_CODEX_LEAD_OUTBOUND=direct (accept the exactly-once restart-window caveat), OR" >&2
		echo "    • bridge exactly-once → unset FLYWHEEL_LEAD_CROSS_DEPT_CHANNEL_IDS for this Lead (drops roundtable until server-side cross-dept-over-bridge lands)." >&2
		exit 1
	fi
	if [ -z "${FLYWHEEL_BRIDGE_URL:-}" ] || [ -z "${FLYWHEEL_API_TOKEN:-}" ]; then
		echo "[run-codex-lead-mufasa-tui] ERROR: outbound=bridge requires FLYWHEEL_BRIDGE_URL and FLYWHEEL_API_TOKEN." >&2
		echo "  Set them (the wrapper sources ~/.flywheel/.env), confirm the Bridge has a mufasa-lead outbound route," >&2
		echo "  or set FLYWHEEL_CODEX_LEAD_OUTBOUND=direct (documented fallback — NOT exactly-once across restarts)." >&2
		echo "  See doc/engineer/implementation/FLY-259-mufasa-tui-cutover-runbook.md §Prerequisites." >&2
		exit 1
	fi
fi

# This launcher is intentionally the read-only companion path. Pin both fields so
# an ambient profile cannot silently select a different tier.
export FLYWHEEL_CODEX_LEAD_PROFILE="companion"
export FLYWHEEL_CODEX_LEAD_SANDBOX="read-only"

# Persona injection (FLY-244): identity.md (Mufasa's warm persona) + a safety
# contract → thread baseInstructions. The runtime SKIPS any file it can't read
# (byte-compat), but fails closed if NONE is readable.
PERSONA_IDENTITY="${HOME}/Dev/growth/.lead/mufasa-lead/identity.md"
PERSONA_COMPANION="${WORKTREE}/packages/teamlead/lead-rules-base/companion-safety-contract.md"
export FLYWHEEL_LEAD_SYSTEM_PROMPT_FILES="${FLYWHEEL_LEAD_SYSTEM_PROMPT_FILES:-${PERSONA_IDENTITY},${PERSONA_COMPANION}}"

# Bot token: the SAME env var Claude/headless Mufasa uses (MUFASA_BOT_TOKEN). In
# dry-run we tolerate it being unset (the report redacts it and contacts nothing).
if [ "${FLYWHEEL_LEAD_DRY_RUN:-}" = "1" ]; then
	export DISCORD_BOT_TOKEN="${MUFASA_BOT_TOKEN:-DRYRUN_PLACEHOLDER}"
else
	export DISCORD_BOT_TOKEN="${MUFASA_BOT_TOKEN:?MUFASA_BOT_TOKEN must be set for the real run}"
	if [ ! -x "${FLYWHEEL_CODEX_BIN}" ]; then
		echo "standalone codex not executable at ${FLYWHEEL_CODEX_BIN} — the remote-control daemon requires it (npm codex has no daemon backend). See the runbook §Prerequisites." >&2
		exit 1
	fi
	if [ ! -d "${CODEX_HOME}" ]; then
		echo "CODEX_HOME ${CODEX_HOME} missing — provision the isolated Codex home first (auth + standalone install)." >&2
		exit 1
	fi
	# TUI prerequisites: assemble/validate the isolated home (config.toml pins,
	# standalone, auth) then idempotently ensure the remote-control daemon. These
	# are side effects, so they NEVER run in dry-run (parity with codex-lead.sh).
	FLYWHEEL_CODEX_TUI_HOME="${CODEX_HOME}" FLYWHEEL_CODEX_TUI_CWD="${FLYWHEEL_CODEX_TUI_CWD}" \
		/bin/bash "${TUI_HOME_SH}" ensure-home
	FLYWHEEL_CODEX_TUI_HOME="${CODEX_HOME}" \
		/bin/bash "${TUI_HOME_SH}" ensure-daemon
fi

echo "[run-codex-lead-mufasa-tui] runtime=${TUI_RUNTIME} CODEX_HOME=${CODEX_HOME} stateDir=${FLYWHEEL_CODEX_LEAD_STATE_DIR} outbound=${FLYWHEEL_CODEX_LEAD_OUTBOUND} dryRun=${FLYWHEEL_LEAD_DRY_RUN:-0}"
exec node "${TUI_RUNTIME}"
