#!/usr/bin/env bash
#
# FLY-614 — daily token-usage report.
# Aggregates today+yesterday from CC logs → persists daily aggregates (Supabase, or
# local SQLite fallback) → renders yesterday's HTML report → publishes it to a
# dedicated Discord channel via `flywheel-comm publish-report`.
#
# Driven by launchd (com.flywheel.token-usage-daily.plist). Single-writer via an
# atomic mkdir lock. Loads Supabase creds from ~/.flywheel/.env. Failures go to stderr.
#
# Env (optional):
#   FLYWHEEL_REPO                  repo root (default: $HOME/Dev/flywheel)
#   FLYWHEEL_TOKEN_USAGE_CHANNEL   Discord channel id to publish to (unset → write HTML only)
#   FLYWHEEL_TOKEN_USAGE_PROJECT   publish-report --project (default: flywheel)
#   TOKEN_USAGE_OUT                HTML output path (default: /tmp/flywheel-token-usage-daily.html)
#   TOKEN_USAGE_TIMEZONE           report timezone (default: America/Los_Angeles)
set -euo pipefail

REPO="${FLYWHEEL_REPO:-$HOME/Dev/flywheel}"
ENV_FILE="$HOME/.flywheel/.env"
LOCK_DIR="$HOME/.flywheel/token-usage.lock"
OUT="${TOKEN_USAGE_OUT:-/tmp/flywheel-token-usage-daily.html}"
CHANNEL="${FLYWHEEL_TOKEN_USAGE_CHANNEL:-}"
PROJECT="${FLYWHEEL_TOKEN_USAGE_PROJECT:-flywheel}"
COMM="$REPO/packages/flywheel-comm/dist/index.js"

log() { echo "[token-usage-daily] $*" >&2; }

# Single-writer lock (atomic mkdir).
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
	log "another run holds the lock ($LOCK_DIR); exiting"
	exit 0
fi
trap 'rmdir "$LOCK_DIR" 2>/dev/null || true' EXIT

# Load Supabase + other creds (so the primary store is used, not the local fallback).
if [ -f "$ENV_FILE" ]; then
	set -a
	# shellcheck disable=SC1090
	. "$ENV_FILE"
	set +a
fi

if [ ! -f "$COMM" ]; then
	log "flywheel-comm not built at $COMM — run 'pnpm -r build' first"
	exit 1
fi

# Aggregate today+yesterday and render yesterday's report to HTML.
log "aggregating + rendering daily report → $OUT"
node "$COMM" token-report daily --out "$OUT"

# Publish to the dedicated channel if configured (best-effort).
if [ -n "$CHANNEL" ]; then
	log "publishing to channel $CHANNEL"
	node "$COMM" publish-report --html "$OUT" --project "$PROJECT" --channel "$CHANNEL" --title "每日 Token 用量报告"
else
	log "FLYWHEEL_TOKEN_USAGE_CHANNEL unset; HTML written to $OUT (not published)"
fi

log "done"
