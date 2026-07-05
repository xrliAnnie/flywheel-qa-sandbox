#!/usr/bin/env bash
#
# FLY-727 — daily fleet-wide completion digest.
# Asks the Bridge to render the completion digest (HTML) for the day that just
# ended → atomically writes it to $OUT → publishes it to the "Flywheel Notification"
# Discord channel via `flywheel-comm publish-report` (hosted URL + full-page
# screenshot + one Discord message; zero API cost, subscription path).
#
# Driven by launchd (com.flywheel.daily-digest.plist) at 00:35 PT — just after
# the 00:30 token report, sharing the dashboard channel. Single-writer via an
# atomic mkdir lock. Requires the Bridge to be up (renders from StateStore +
# deploy-state). Failures go to stderr with a non-zero exit.
#
# Env (loaded from ~/.flywheel/.env, then defaulted BELOW — R4 #3: source first):
#   FLYWHEEL_DIGEST_CHANNEL   Discord channel id to publish to (REQUIRED — unset → no-op)
#   FLYWHEEL_REPO             repo root (default: $HOME/Dev/flywheel)
#   FLYWHEEL_DIGEST_PROJECT   publish-report --project (default: flywheel)
#   BRIDGE_URL / FLYWHEEL_BRIDGE_URL   Bridge base URL (default: http://localhost:9876)
#   TEAMLEAD_API_TOKEN        if set, sent as `Authorization: Bearer` (matches Bridge auth)
#   DIGEST_OUT                HTML output path (default: /tmp/flywheel-daily-digest.html)
set -euo pipefail

log() { echo "[daily-digest] $*" >&2; }

# ── R4 #3: source the env file BEFORE deriving any vars ──────────────────────
# ENV_FILE is overridable (default = production ~/.flywheel/.env). FLY-727: sourcing
# with `set -a` lets the file CLOBBER pre-set vars, which broke pointing this script
# at a staging Bridge (the file's production values won over a caller's staging ones
# — QA FLY-739 / Codex R9). So we snapshot the caller's overrides BEFORE sourcing and
# restore them AFTER. Production is unchanged (nothing pre-set → every restore is a
# no-op). Two subtleties Codex R9 caught: (a) FLYWHEEL_BRIDGE_URL and BRIDGE_URL are
# ONE logical override — if the caller set EITHER, it must win over BOTH from .env, or
# a shipped .env FLYWHEEL_BRIDGE_URL would beat a caller's BRIDGE_URL=staging; (b) the
# CHANNEL must be snapshotted too, or once the digest ships (.env sets a prod
# FLYWHEEL_DIGEST_CHANNEL) a staging E2E would deliver to the PRODUCTION channel.
ENV_FILE="${ENV_FILE:-$HOME/.flywheel/.env}"
_ovr_bridge="${FLYWHEEL_BRIDGE_URL:-${BRIDGE_URL:-}}"
_ovr_token="${TEAMLEAD_API_TOKEN:-}"
_ovr_channel="${FLYWHEEL_DIGEST_CHANNEL:-}"
if [ -f "$ENV_FILE" ]; then
	set -a
	# shellcheck disable=SC1090
	. "$ENV_FILE"
	set +a
fi
if [ -n "$_ovr_bridge" ]; then
	FLYWHEEL_BRIDGE_URL="$_ovr_bridge"
	BRIDGE_URL="$_ovr_bridge"
fi
[ -n "$_ovr_token" ] && TEAMLEAD_API_TOKEN="$_ovr_token"
[ -n "$_ovr_channel" ] && FLYWHEEL_DIGEST_CHANNEL="$_ovr_channel"

REPO="${FLYWHEEL_REPO:-$HOME/Dev/flywheel}"
OUT="${DIGEST_OUT:-/tmp/flywheel-daily-digest.html}"
CHANNEL="${FLYWHEEL_DIGEST_CHANNEL:-}"
PROJECT="${FLYWHEEL_DIGEST_PROJECT:-flywheel}"
BRIDGE_URL="${FLYWHEEL_BRIDGE_URL:-${BRIDGE_URL:-http://localhost:9876}}"
COMM="$REPO/packages/flywheel-comm/dist/index.js"
LOCK_DIR="$HOME/.flywheel/daily-digest.lock"
RESTART_LOCK_DIR="$HOME/.flywheel/restart.lock.d"
MAX_HTML_BYTES=$((512 * 1024))

# FLY-727 (Codex R9): config-resolution testability seam. Print the resolved Bridge
# URL / channel / token-presence and exit BEFORE any lock/health/render/publish, so a
# shell regression can assert a caller's staging override beats a production .env.
# Never set in production.
if [ -n "${DIGEST_PRINT_CONFIG:-}" ]; then
	printf 'BRIDGE_URL=%s\nCHANNEL=%s\nTOKEN=%s\n' \
		"$BRIDGE_URL" "$CHANNEL" "${TEAMLEAD_API_TOKEN:-}"
	exit 0
fi

# Explicit enablement (R3 #1): no channel → no-op (never falls back to the cost env).
if [ -z "$CHANNEL" ]; then
	log "FLYWHEEL_DIGEST_CHANNEL unset — digest disabled; exiting."
	exit 0
fi

# Single-writer lock (atomic mkdir).
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
	log "another run holds the lock ($LOCK_DIR); exiting"
	exit 0
fi
trap 'rmdir "$LOCK_DIR" 2>/dev/null || true' EXIT

if [ ! -f "$COMM" ]; then
	log "flywheel-comm not built at $COMM — run 'pnpm -r build' first"
	exit 1
fi

# ── Bridge liveness (renders from the Bridge's StateStore) ───────────────────
# If a deploy is in progress (restart lock held), wait for it to finish; then
# require a healthy Bridge. We do NOT self-start the Bridge (kept simple/safe —
# missing one day's digest is low-stakes; a wrong start is not).
bridge_healthy() { curl -sf "$BRIDGE_URL/health" >/dev/null 2>&1; }

elapsed=0
while [ -d "$RESTART_LOCK_DIR" ] && [ "$elapsed" -lt 120 ]; do
	log "restart.lock.d held (deploy in progress); waiting…"
	sleep 5
	elapsed=$((elapsed + 5))
done

elapsed=0
until bridge_healthy; do
	if [ "$elapsed" -ge 60 ]; then
		log "Bridge not healthy at $BRIDGE_URL after ${elapsed}s — skipping digest."
		exit 1
	fi
	sleep 5
	elapsed=$((elapsed + 5))
done

# ── (0) Drain any spooled deployment events BEFORE rendering (Codex code-review
# R4 HIGH#4). report-deployed only drains opportunistically on its next call; if a
# deploy spooled while the Bridge was down and nothing reported since, the digest
# would miss it. Draining here (Bridge is now healthy) makes the digest see them.
# Pass the resolved Bridge URL explicitly — report-deployed reads it from the env
# and $BRIDGE_URL is a local (not exported) here (Codex code-review R5 #1).
FLYWHEEL_BRIDGE_URL="$BRIDGE_URL" node "$COMM" report-deployed --drain-only >/dev/null 2>&1 || \
  log "deployment-event spool drain returned non-zero (continuing)"

# ── (1) Render the digest HTML from the Bridge (text/html) → atomic $OUT ─────
TMP_OUT="$(mktemp "${OUT}.XXXXXX")"
trap 'rm -f "$TMP_OUT" 2>/dev/null; rmdir "$LOCK_DIR" 2>/dev/null || true' EXIT

# Codex code-review R1 LOW: keep TEAMLEAD_API_TOKEN out of the curl argv (visible
# via `ps`). When a token is configured, pass the Authorization header through a
# `--config -` file read from stdin instead of `-H` on the command line.
log "rendering digest via $BRIDGE_URL/api/digest/render"
render() {
	if [ -n "${TEAMLEAD_API_TOKEN:-}" ]; then
		printf 'header = "Authorization: Bearer %s"\n' "$TEAMLEAD_API_TOKEN" |
			curl -sf --config - -X POST "$BRIDGE_URL/api/digest/render" \
				-H "Content-Type: application/json" -d '{}' -o "$TMP_OUT"
	else
		curl -sf -X POST "$BRIDGE_URL/api/digest/render" \
			-H "Content-Type: application/json" -d '{}' -o "$TMP_OUT"
	fi
}
if ! render; then
	log "digest render request failed"
	exit 1
fi

# Validate: non-empty + within the 512 KiB publish-report cap.
BYTES=$(wc -c <"$TMP_OUT" | tr -d ' ')
if [ "$BYTES" -eq 0 ]; then
	log "digest render returned an empty body"
	exit 1
fi
if [ "$BYTES" -gt "$MAX_HTML_BYTES" ]; then
	log "digest HTML is ${BYTES} bytes (> ${MAX_HTML_BYTES}) — exceeds publish-report cap"
	exit 1
fi
mv -f "$TMP_OUT" "$OUT"
log "wrote digest HTML → $OUT (${BYTES} bytes)"

# ── (2) Publish to the "Flywheel Notification" channel (hosted + screenshot + Discord) ─
# Pass the resolved Bridge URL + token to the publish-report child EXPLICITLY (Codex
# R9): a post-`set +a` reassignment of an unexported var would not reach the child, so
# a staging run must not fall through to publish-report's own localhost default / a
# stale production FLYWHEEL_BRIDGE_URL from .env.
log "publishing to channel $CHANNEL"
FLYWHEEL_BRIDGE_URL="$BRIDGE_URL" TEAMLEAD_API_TOKEN="${TEAMLEAD_API_TOKEN:-}" \
	node "$COMM" publish-report \
	--html "$OUT" \
	--project "$PROJECT" \
	--channel "$CHANNEL" \
	--title "每日上线 Digest"

log "done"
