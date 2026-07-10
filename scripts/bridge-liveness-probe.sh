#!/usr/bin/env bash
# FLY-1082 (Task 3.3): the OUT-OF-PROCESS Bridge liveness probe.
#
# The 2026-07-09 incident's silent hole: every detection surface (LeadWatchdog /
# AlertChannelHub / AutoRepairBot) lives INSIDE the Bridge process — when the
# Bridge itself died, the whole detect→enqueue→repair plane died with it. The
# wrapper dirty-marker leg catches "died then respawned"; THIS probe catches
# "died and NEVER came back" (launchd wedged / crash-loop / port stuck) —
# deterministic code, deliberately NOT an LLM loop (a bot's chat loop cannot be
# trusted to remember a heartbeat).
#
# Deployment (FLY-1071's enable window — this issue delivers script + plist
# template + runbook entry only): installed in the CODEX Infra Bot's launchd
# domain ("nobody rescues their own side" — the Claude/Bridge side is watched
# from the Codex side), running every minute via StartInterval.
#
# Behavior:
#   - curl $BRIDGE_URL/health every invocation (launchd fires us per minute);
#   - consecutive-down state persists in $STATE_FILE (per-run process — the
#     counter must survive between invocations);
#   - down >= FLYWHEEL_BRIDGE_DOWN_ESCALATE_MIN (default 5) consecutive minutes
#     → ONE Discord page @Annie via the probe's OWN bot token (episode latch:
#     never re-pages inside one down episode);
#   - recovery → ONE all-clear message + latch reset.
#
# Env:
#   BRIDGE_URL                            (default http://localhost:9876)
#   FLYWHEEL_BRIDGE_DOWN_ESCALATE_MIN     (default 5)
#   FLYWHEEL_PROBE_STATE_FILE             (default ~/.flywheel/state/bridge-liveness-probe.json)
#   FLYWHEEL_PROBE_BOT_TOKEN_ENV          (env NAME holding the Discord bot token,
#                                          default CODEX_INFRA_BOT_TOKEN — the
#                                          Codex bot's token env per the C6
#                                          deployment contract)
#   FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID     (the #flywheel-alerts channel)
#   FLYWHEEL_FOUNDER_DISCORD_USER_ID      (the @Annie mention target; optional)
set -uo pipefail

BRIDGE_URL="${BRIDGE_URL:-http://localhost:9876}"
ESCALATE_MIN="${FLYWHEEL_BRIDGE_DOWN_ESCALATE_MIN:-5}"
STATE_FILE="${FLYWHEEL_PROBE_STATE_FILE:-${HOME}/.flywheel/state/bridge-liveness-probe.json}"
# Codex R1 HIGH-3: the default must match the C6 deployment contract's env
# name (CODEX_INFRA_BOT_TOKEN) — INFRA_BOT_TOKEN would silently never page.
TOKEN_ENV="${FLYWHEEL_PROBE_BOT_TOKEN_ENV:-CODEX_INFRA_BOT_TOKEN}"
CHANNEL_ID="${FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID:-}"
FOUNDER_ID="${FLYWHEEL_FOUNDER_DISCORD_USER_ID:-}"

mkdir -p "$(dirname "$STATE_FILE")" 2>/dev/null || true

# ── Seams (overridden in tests) ──────────────────────────────────────────────
_probe_curl() { curl -sf --max-time 5 "${BRIDGE_URL%/}/health" 2>/dev/null; }
_probe_now()  { date +%s; }
_probe_post() {
  # $1 = message content (mention allowed). Best-effort; rc mirrors curl.
  local token="${!TOKEN_ENV:-}"
  [[ -n "$token" && -n "$CHANNEL_ID" ]] || return 1
  command -v jq >/dev/null 2>&1 || return 1
  local mentions='{"parse":[]}'
  [[ -n "$FOUNDER_ID" ]] && mentions="{\"users\":[\"$FOUNDER_ID\"]}"
  curl -sf -X POST "https://discord.com/api/v10/channels/${CHANNEL_ID}/messages" \
    -H "Authorization: Bot ${token}" -H "Content-Type: application/json" \
    -d "$(jq -n --arg c "$1" --argjson m "$mentions" '{content:$c, allowed_mentions:$m}')" \
    --max-time 10 >/dev/null 2>&1
}

# ── State (json: downCount / downSince / escalated / lastOkTs) ───────────────
read_state() {
  if [[ -f "$STATE_FILE" ]] && command -v jq >/dev/null 2>&1; then
    DOWN_COUNT="$(jq -r '.downCount // 0' "$STATE_FILE" 2>/dev/null || echo 0)"
    DOWN_SINCE="$(jq -r '.downSince // 0' "$STATE_FILE" 2>/dev/null || echo 0)"
    ESCALATED="$(jq -r '.escalated // false' "$STATE_FILE" 2>/dev/null || echo false)"
    LAST_OK_TS="$(jq -r '.lastOkTs // 0' "$STATE_FILE" 2>/dev/null || echo 0)"
  else
    DOWN_COUNT=0; DOWN_SINCE=0; ESCALATED=false; LAST_OK_TS=0
  fi
  [[ "$DOWN_COUNT" =~ ^[0-9]+$ ]] || DOWN_COUNT=0
  [[ "$DOWN_SINCE" =~ ^[0-9]+$ ]] || DOWN_SINCE=0
  [[ "$LAST_OK_TS" =~ ^[0-9]+$ ]] || LAST_OK_TS=0
}

write_state() {
  printf '{"downCount":%s,"downSince":%s,"escalated":%s,"lastOkTs":%s}\n' \
    "$DOWN_COUNT" "$DOWN_SINCE" "$ESCALATED" "$LAST_OK_TS" > "$STATE_FILE" 2>/dev/null || true
}

probe_once() {
  read_state
  local now; now="$(_probe_now)"
  if _probe_curl >/dev/null; then
    if [[ "$ESCALATED" == "true" ]]; then
      local mins=$(( DOWN_SINCE > 0 ? (now - DOWN_SINCE) / 60 : 0 ))
      _probe_post "✅ Bridge 恢复了 — 之前连续 down 约 ${mins} 分钟(外部心跳探针,FLY-1082)。" || true
    fi
    DOWN_COUNT=0; DOWN_SINCE=0; ESCALATED=false; LAST_OK_TS="$now"
    write_state
    echo "ok"
    return 0
  fi
  # Down this minute.
  (( DOWN_COUNT == 0 )) && DOWN_SINCE="$now"
  DOWN_COUNT=$(( DOWN_COUNT + 1 ))
  if (( DOWN_COUNT >= ESCALATE_MIN )) && [[ "$ESCALATED" != "true" ]]; then
    local last_ok="从未见过健康响应"
    (( LAST_OK_TS > 0 )) && last_ok="$(date -r "$LAST_OK_TS" '+%H:%M:%S' 2>/dev/null || echo "$LAST_OK_TS")"
    local mention="Annie"
    [[ -n "$FOUNDER_ID" ]] && mention="<@${FOUNDER_ID}>"
    if _probe_post "🚨 ${mention} Bridge 连续 down ≥ ${ESCALATE_MIN} 分钟且没有活过来(外部心跳探针)。最后一次健康响应:${last_ok}。建议:bash ~/Dev/flywheel/scripts/restart-services.sh;若起不来看 /tmp/flywheel-bridge.log + lsof -ti:9876。"; then
      ESCALATED=true
    fi
    # Delivery failed → escalated stays false → retried next minute (never
    # silently swallowed; the episode latch only arms on a DELIVERED page).
  fi
  write_state
  echo "down ${DOWN_COUNT}"
  return 0
}

# Sourced by tests (they override the seams then call probe_once); executed
# directly by launchd.
if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  probe_once
fi
