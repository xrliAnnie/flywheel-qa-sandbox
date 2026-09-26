#!/usr/bin/env bash
#
# FLY-614 / FLY-744 — daily token-usage report.
# Aggregates a rolling window from CC logs → persists daily aggregates (Supabase, or
# local SQLite fallback) → renders yesterday's HTML report (with the before/after
# comparison hero) → publishes it to a dedicated Discord channel via
# `flywheel-comm publish-report`.
#
# Driven by launchd (com.flywheel.token-usage-daily.plist). Single-writer via an
# atomic mkdir lock. Loads creds from ~/.flywheel/.env. Failures go to stderr.
#
# FLY-744: env-backed config (FLYWHEEL_TOKEN_USAGE_CHANNEL / FLYWHEEL_REPO /
# TOKEN_USAGE_* etc.) is resolved AFTER sourcing ~/.flywheel/.env, so the documented
# deployment path of putting the channel id in .env actually takes effect.
#
# Env (optional; may be set in the plist OR in ~/.flywheel/.env):
#   FLYWHEEL_REPO                  repo root (default: $HOME/Dev/flywheel)
#   FLYWHEEL_TOKEN_USAGE_CHANNEL   Discord channel id to publish to (unset → write HTML only)
#   FLYWHEEL_TOKEN_USAGE_PROJECT   publish-report --project (default: flywheel)
#   TOKEN_USAGE_OUT                HTML output path (default: /tmp/flywheel-token-usage-daily.html)
#   TOKEN_USAGE_TIMEZONE           report timezone (default: America/Los_Angeles)
set -euo pipefail

# Only $HOME-derived paths may be resolved before sourcing .env (the .env location
# itself and the single-writer lock). Everything env-backed is resolved afterward.
ENV_FILE="$HOME/.flywheel/.env"
LOCK_DIR="$HOME/.flywheel/token-usage.lock"

log() { echo "[token-usage-daily] $*" >&2; }

# Single-writer lock (atomic mkdir).
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
	log "another run holds the lock ($LOCK_DIR); exiting"
	exit 0
fi
trap 'rmdir "$LOCK_DIR" 2>/dev/null || true' EXIT

# Load ~/.flywheel/.env for creds + config defaults, but PROCESS ENV (the launchd plist,
# or an explicit caller) MUST WIN over stale .env values — a leftover .env channel/repo
# must not override the plist and publish to the wrong channel or run from the wrong
# checkout (Codex R1 HIGH). `set -a; . .env` clobbers already-exported vars, so:
# snapshot the process values → source .env (fills Supabase creds + any unset config)
# → restore the snapshots so process env wins. .env-only vars (Supabase creds) survive.
_PROCESS_WINS="FLYWHEEL_REPO TOKEN_USAGE_OUT FLYWHEEL_TOKEN_USAGE_CHANNEL FLYWHEEL_TOKEN_USAGE_PROJECT TOKEN_USAGE_TIMEZONE TOKEN_USAGE_ROLLOUT_DATE TOKEN_USAGE_WINDOW_DAYS TOKEN_USAGE_BACKFILL_DAYS TOKEN_USAGE_LINEAR_WORKSPACE TOKEN_USAGE_PRICING_FILE"
for _v in $_PROCESS_WINS; do
	if [ -n "${!_v:-}" ]; then eval "_SNAP_${_v}=\${${_v}}"; fi
done
if [ -f "$ENV_FILE" ]; then
	set -a
	# shellcheck disable=SC1090
	. "$ENV_FILE"
	set +a
fi
for _v in $_PROCESS_WINS; do
	_s="_SNAP_${_v}"
	if [ -n "${!_s:-}" ]; then export "${_v}=${!_s}"; fi
done

# Resolve config: process env wins → .env → hardcoded default.
REPO="${FLYWHEEL_REPO:-$HOME/Dev/flywheel}"
OUT="${TOKEN_USAGE_OUT:-/tmp/flywheel-token-usage-daily.html}"
CHANNEL="${FLYWHEEL_TOKEN_USAGE_CHANNEL:-}"
PROJECT="${FLYWHEEL_TOKEN_USAGE_PROJECT:-flywheel}"
COMM="$REPO/packages/flywheel-comm/dist/index.js"

if [ ! -f "$COMM" ]; then
	log "flywheel-comm not built at $COMM — run 'pnpm -r build' first"
	exit 1
fi

# FLY-929 C2 / FLY-1243: fail-loud — a failing pipeline step raises a
# notify_digest_failed alert via lead-alert.sh (claims-deduped, Bridge-independent).
# The FLYWHEEL_NOTIFY_DIGEST_EXPECT gate is retired (固化 default-on) — the alert
# always fires on failure. Best-effort ('|| true'): the alert must never mask the
# original exit code.
fail_loud() {
	local step="$1" code="$2"
	local alert_sh="${REPO}/scripts/lead-alert.sh"
	if [ -f "$alert_sh" ]; then
		bash "$alert_sh" \
			--lead codex-infra-bot-lead --project flywheel \
			--kind notify_digest_failed --severity warning \
			--title "token report 发送失败" \
			--body "step=${step} exit=${code} log=/tmp/flywheel-token-usage-daily.err" \
			|| true
	else
		log "WARNING: lead-alert.sh not found at $alert_sh — fail-loud alert skipped"
	fi
	exit "$code"
}

# Aggregate the rolling window (default 14 days) and render yesterday's report to HTML.
log "aggregating + rendering daily report → $OUT"
rc=0
node "$COMM" token-report daily --out "$OUT" || rc=$?
if [ "$rc" -ne 0 ]; then fail_loud "token-report daily" "$rc"; fi

# Publish to the dedicated channel if configured (best-effort).
if [ -n "$CHANNEL" ]; then
	# FLY-929 B1: ask the token-report CLI (the tz-aware date authority) for the
	# report day and forward it so the Bridge can write the delivery receipt.
	# An old/failed CLI ⇒ no flags (byte-compat body; receipt simply not written).
	EXPECTED_DATE=$(node "$COMM" token-report report-day 2>/dev/null || true)
	RECEIPT_ARGS=()
	if [[ "$EXPECTED_DATE" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]]; then
		RECEIPT_ARGS=(--kind token_report --expected-date "$EXPECTED_DATE")
	else
		log "WARNING: token-report report-day returned '$EXPECTED_DATE' — publishing without receipt fields"
	fi
	log "publishing to channel $CHANNEL"
	rc=0
	node "$COMM" publish-report --html "$OUT" --project "$PROJECT" --channel "$CHANNEL" --title "每日 Token 用量报告" \
		${RECEIPT_ARGS[@]+"${RECEIPT_ARGS[@]}"} || rc=$?
	if [ "$rc" -ne 0 ]; then fail_loud "publish-report" "$rc"; fi
else
	log "WARNING: FLYWHEEL_TOKEN_USAGE_CHANNEL is unset — report NOT delivered to Discord."
	log "         Set it in the plist or in $ENV_FILE to auto-publish (see token-usage-setup-channel.sh)."
	log "         HTML written to $OUT (not published)."
fi

log "done"
