#!/usr/bin/env bash
# FLY-569 — write the SHARED NON-TOKEN roundtable routing file.
#
# The Discord plugin (claude-plugins-official fork) now defaults reply-in-thread
# ON for ALL Claude leads, resolving the roundtable channel id from this file
# (~/.flywheel/roundtable.json) when the per-lead env does not set it. That lets
# token-isolated companion daemons (Belle/atlas/rafiki) — which deliberately
# `unset` all Flywheel env for token isolation — reply into the topic thread
# without any per-lead config and WITHOUT re-injecting any Flywheel token.
#
# SECURITY (hard): this file may carry ONLY a benign Discord channel snowflake.
# This helper validates `^[0-9]{15,21}$` and writes ONLY {"channelId": "<id>"}
# via jq — a snowflake whitelist is the structural leak guard, so a secret can
# never end up in the world-readable file even if it sits next to the id in .env.
#
# Usage:
#   scripts/setup-roundtable-config.sh [--out PATH] [--force]
#
# Channel id source (precedence): $FLYWHEEL_ROUNDTABLE_CHANNEL_ID, else the
# single `FLYWHEEL_ROUNDTABLE_CHANNEL_ID=` line in $FLYWHEEL_ENV_FILE
# (default ~/.flywheel/.env). Output path: --out, else
# $FLYWHEEL_ROUNDTABLE_CONFIG_FILE, else ~/.flywheel/roundtable.json.
set -euo pipefail

err() { echo "ERROR: $*" >&2; exit 1; }

command -v jq >/dev/null 2>&1 || err "jq is required"

ENV_FILE="${FLYWHEEL_ENV_FILE:-${HOME}/.flywheel/.env}"
OUT_FILE="${FLYWHEEL_ROUNDTABLE_CONFIG_FILE:-${HOME}/.flywheel/roundtable.json}"
FORCE=0

while (( $# > 0 )); do
  case "$1" in
    --out) OUT_FILE="${2:?--out requires a path}"; shift 2 ;;
    --force|--update) FORCE=1; shift ;;
    -h|--help)
      echo "Usage: setup-roundtable-config.sh [--out PATH] [--force]"; exit 0 ;;
    *) err "unknown argument: $1" ;;
  esac
done

SNOWFLAKE_RE='^[0-9]{15,21}$'

# ── Resolve the channel id (env wins; else extract from .env) ────────────────
CHANNEL_ID="${FLYWHEEL_ROUNDTABLE_CHANNEL_ID:-}"
if [[ -z "$CHANNEL_ID" ]]; then
  [[ -f "$ENV_FILE" ]] || err "no FLYWHEEL_ROUNDTABLE_CHANNEL_ID env and env file missing: $ENV_FILE"
  # Take ONLY exact `FLYWHEEL_ROUNDTABLE_CHANNEL_ID=` assignment lines (optionally
  # `export `-prefixed). Never copy the rest of the token-laden file.
  # Portable read loop (NOT `mapfile`, which is Bash 4+; macOS ships Bash 3.2 and
  # `#!/usr/bin/env bash` can select it — same hazard handled in lib/mcp-inherit.sh).
  _matches=()
  while IFS= read -r _line || [[ -n "$_line" ]]; do
    [[ -n "$_line" ]] && _matches+=("$_line")
  done < <(grep -E '^(export[[:space:]]+)?FLYWHEEL_ROUNDTABLE_CHANNEL_ID=' "$ENV_FILE" || true)
  (( ${#_matches[@]} == 1 )) || err "expected exactly one FLYWHEEL_ROUNDTABLE_CHANNEL_ID in ${ENV_FILE}, found ${#_matches[@]} (ambiguous/missing)"
  # Strip up to and including the first '='. A quoted/expanded/commented value
  # will then fail the snowflake check below (we do NOT silently unquote).
  CHANNEL_ID="${_matches[0]#*=}"
fi

[[ "$CHANNEL_ID" =~ $SNOWFLAKE_RE ]] \
  || err "'${CHANNEL_ID}' is not a Discord channel snowflake (^[0-9]{15,21}\$) — refusing to write"

# ── Stale guard: never silently overwrite a DIFFERENT routing ────────────────
if [[ -f "$OUT_FILE" && "$FORCE" -ne 1 ]]; then
  existing="$(jq -r '.channelId // empty' "$OUT_FILE" 2>/dev/null || true)"
  if [[ "$existing" == "$CHANNEL_ID" ]]; then
    echo "roundtable config already up to date (${OUT_FILE} → ${CHANNEL_ID})"
    exit 0
  fi
  err "existing ${OUT_FILE} has channelId '${existing:-<invalid>}' but target is '${CHANNEL_ID}' — re-run with --force to overwrite"
fi

# ── Write benign channelId-only JSON, atomically, 0644 (benign, agent-readable) ─
mkdir -p "$(dirname "$OUT_FILE")"
TMP="$(mktemp "${OUT_FILE}.XXXXXX")"
trap 'rm -f "$TMP"' EXIT
jq -n --arg channelId "$CHANNEL_ID" '{channelId: $channelId}' > "$TMP"
chmod 644 "$TMP"
mv -f "$TMP" "$OUT_FILE"
trap - EXIT
echo "wrote ${OUT_FILE} → channelId ${CHANNEL_ID}"
