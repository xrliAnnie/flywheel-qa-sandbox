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

# ── State v3: independent down / degraded / stalled / disabled episodes ─────
read_state() {
  if [[ -f "$STATE_FILE" ]] && command -v jq >/dev/null 2>&1; then
    # Flat v1 and structured v2 keys are accepted and rewritten as v3.
    DOWN_COUNT="$(jq -r '.down.count // .downCount // 0' "$STATE_FILE" 2>/dev/null || echo 0)"
    DOWN_SINCE="$(jq -r '.down.since // .downSince // 0' "$STATE_FILE" 2>/dev/null || echo 0)"
    DOWN_ESCALATED="$(jq -r '.down.escalated // .escalated // false' "$STATE_FILE" 2>/dev/null || echo false)"
    LAST_OK_TS="$(jq -r '.down.lastOkTs // .lastOkTs // 0' "$STATE_FILE" 2>/dev/null || echo 0)"
    DEGRADED_COUNT="$(jq -r '.degraded.count // 0' "$STATE_FILE" 2>/dev/null || echo 0)"
    DEGRADED_SINCE="$(jq -r '.degraded.since // 0' "$STATE_FILE" 2>/dev/null || echo 0)"
    DEGRADED_ESCALATED="$(jq -r '.degraded.escalated // false' "$STATE_FILE" 2>/dev/null || echo false)"
    STALLED_COUNT="$(jq -r '.stalled.count // 0' "$STATE_FILE" 2>/dev/null || echo 0)"
    STALLED_ESCALATED="$(jq -r '.stalled.escalated // false' "$STATE_FILE" 2>/dev/null || echo false)"
    STALLED_MEMBERS="$(jq -c '.stalled.members // []' "$STATE_FILE" 2>/dev/null || echo '[]')"
    DISABLED_MEMBERS="$(jq -c '.disabled.members // []' "$STATE_FILE" 2>/dev/null || echo '[]')"
    DISABLED_LAST_NOTIFIED_AT="$(jq -r '.disabled.lastNotifiedAt // 0' "$STATE_FILE" 2>/dev/null || echo 0)"
  else
    DOWN_COUNT=0; DOWN_SINCE=0; DOWN_ESCALATED=false; LAST_OK_TS=0
    DEGRADED_COUNT=0; DEGRADED_SINCE=0; DEGRADED_ESCALATED=false
    STALLED_COUNT=0; STALLED_ESCALATED=false; STALLED_MEMBERS='[]'
    DISABLED_MEMBERS='[]'; DISABLED_LAST_NOTIFIED_AT=0
  fi
  [[ "$DOWN_COUNT" =~ ^[0-9]+$ ]] || DOWN_COUNT=0
  [[ "$DOWN_SINCE" =~ ^[0-9]+$ ]] || DOWN_SINCE=0
  [[ "$LAST_OK_TS" =~ ^[0-9]+$ ]] || LAST_OK_TS=0
  [[ "$DEGRADED_COUNT" =~ ^[0-9]+$ ]] || DEGRADED_COUNT=0
  [[ "$DEGRADED_SINCE" =~ ^[0-9]+$ ]] || DEGRADED_SINCE=0
  [[ "$STALLED_COUNT" =~ ^[0-9]+$ ]] || STALLED_COUNT=0
  jq -e 'type == "array"' <<<"$STALLED_MEMBERS" >/dev/null 2>&1 || STALLED_MEMBERS='[]'
  jq -e 'type == "array" and all(.[]; type == "string")' <<<"$DISABLED_MEMBERS" >/dev/null 2>&1 || DISABLED_MEMBERS='[]'
  [[ "$DISABLED_LAST_NOTIFIED_AT" =~ ^[0-9]+$ ]] || DISABLED_LAST_NOTIFIED_AT=0
}

write_state() {
  local tmp="${STATE_FILE}.tmp.$$"
  if jq -cn \
    --argjson downCount "$DOWN_COUNT" --argjson downSince "$DOWN_SINCE" \
    --argjson downEscalated "$DOWN_ESCALATED" --argjson lastOkTs "$LAST_OK_TS" \
    --argjson degradedCount "$DEGRADED_COUNT" --argjson degradedSince "$DEGRADED_SINCE" \
    --argjson degradedEscalated "$DEGRADED_ESCALATED" \
    --argjson stalledCount "$STALLED_COUNT" --argjson stalledEscalated "$STALLED_ESCALATED" \
    --argjson stalledMembers "$STALLED_MEMBERS" \
    --argjson disabledMembers "$DISABLED_MEMBERS" --argjson disabledLastNotifiedAt "$DISABLED_LAST_NOTIFIED_AT" \
    '{schemaVersion:3,down:{count:$downCount,since:$downSince,escalated:$downEscalated,lastOkTs:$lastOkTs},degraded:{count:$degradedCount,since:$degradedSince,escalated:$degradedEscalated},stalled:{count:$stalledCount,escalated:$stalledEscalated,members:$stalledMembers},disabled:{members:$disabledMembers,lastNotifiedAt:$disabledLastNotifiedAt}}' \
    > "$tmp" 2>/dev/null; then
    mv "$tmp" "$STATE_FILE"
  else
    rm -f "$tmp"
  fi
}

watchdog_manifest_valid() {
  jq -e '
    .watchdogs.schema_version == 1 and
    (.watchdogs.components.w1_process_liveness | type == "object" and .wired == true and (.effective_enabled | type == "boolean")) and
    (.watchdogs.components.w2_delivery_loop | type == "object" and .wired == true and (.effective_enabled | type == "boolean")) and
    (.watchdogs.components.w2_delivery_loop.leads |
      type == "array" and
      all(.[];
        type == "object" and
        (.lead_id | type == "string") and
        (.lead_id | length > 0) and
        (.freshness == "fresh" or .freshness == "stale")
      )
    ) and
    (.watchdogs.components.w3_external_drift | type == "object" and .wired == true and (.effective_enabled | type == "boolean") and .observation == "static_contract") and
    (.watchdogs.components.w4_lead_blocked | type == "object" and .wired == true and (.effective_enabled | type == "boolean")) and
    (.watchdogs.components.w4_runner_blocked | type == "object" and .wired == true and (.effective_enabled | type == "boolean")) and
    ((.watchdogs.retiring // []) | all(.effective_enabled != true))
  ' >/dev/null 2>&1
}

probe_once() {
  read_state
  local now body; now="$(_probe_now)"
  if ! body="$(_probe_curl)" || ! jq -e '.ok == true' <<<"$body" >/dev/null 2>&1; then
    # Bridge down: advance ONLY the down episode. The last known degraded and
    # stalled evidence is frozen because an unavailable observer cannot prove
    # either recovery or new failure.
    (( DOWN_COUNT == 0 )) && DOWN_SINCE="$now"
    DOWN_COUNT=$(( DOWN_COUNT + 1 ))
    if (( DOWN_COUNT >= ESCALATE_MIN )) && [[ "$DOWN_ESCALATED" != "true" ]]; then
      local last_ok="从未见过健康响应"
      (( LAST_OK_TS > 0 )) && last_ok="$(date -r "$LAST_OK_TS" '+%H:%M:%S' 2>/dev/null || echo "$LAST_OK_TS")"
      local mention="Annie"
      [[ -n "$FOUNDER_ID" ]] && mention="<@${FOUNDER_ID}>"
      if _probe_post "🚨 ${mention} Bridge 连续 down ≥ ${ESCALATE_MIN} 分钟且没有活过来(外部心跳探针)。最后一次健康响应:${last_ok}。建议:bash ~/Dev/flywheel/scripts/restart-services.sh;若起不来看 /tmp/flywheel-bridge.log + lsof -ti:9876。"; then
        DOWN_ESCALATED=true
      fi
    fi
    write_state
    echo "down ${DOWN_COUNT}"
    return 0
  fi

  # Reachable and explicitly ok: resolve the independent down episode.
  if [[ "$DOWN_ESCALATED" == "true" ]]; then
    local mins=$(( DOWN_SINCE > 0 ? (now - DOWN_SINCE) / 60 : 0 ))
    _probe_post "✅ Bridge 恢复了 — 之前连续 down 约 ${mins} 分钟(外部心跳探针,FLY-1082)。" || true
  fi
  DOWN_COUNT=0; DOWN_SINCE=0; DOWN_ESCALATED=false; LAST_OK_TS="$now"

  local grace_min="${FLYWHEEL_WATCHDOG_MANIFEST_GRACE_MIN:-5}"
  local degraded_min="${FLYWHEEL_WATCHDOG_MANIFEST_DEGRADED_MIN:-3}"
  [[ "$grace_min" =~ ^[0-9]+$ ]] || grace_min=5
  [[ "$degraded_min" =~ ^[0-9]+$ ]] || degraded_min=3

  if ! watchdog_manifest_valid <<<"$body"; then
    (( DEGRADED_COUNT == 0 || DEGRADED_SINCE == 0 )) && DEGRADED_SINCE="$now"
    DEGRADED_COUNT=$(( DEGRADED_COUNT + 1 ))
    if (( now - DEGRADED_SINCE >= grace_min * 60 && DEGRADED_COUNT >= degraded_min )) \
      && [[ "$DEGRADED_ESCALATED" != "true" ]]; then
      if _probe_post "🚨 Bridge 可达,但 watchdog manifest 缺失或不完整 — 安静不能证明没事(FLY-1393)。"; then
        DEGRADED_ESCALATED=true
      fi
    fi
    write_state
    echo "degraded ${DEGRADED_COUNT}"
    return 0
  fi

  if [[ "$DEGRADED_ESCALATED" == "true" ]]; then
    _probe_post "✅ watchdog manifest 恢复 — 最小集重新可观测(FLY-1393)。" || true
  fi
  DEGRADED_COUNT=0; DEGRADED_SINCE=0; DEGRADED_ESCALATED=false

  local disabled_reminder_min="${FLYWHEEL_WATCHDOG_DISABLED_REMINDER_MIN:-1440}"
  [[ "$disabled_reminder_min" =~ ^[0-9]+$ ]] || disabled_reminder_min=1440
  local disabled_members disabled_csv
  disabled_members="$(jq -c '[.watchdogs.components | to_entries[] | select(.value.effective_enabled == false) | .key] | unique | sort' <<<"$body" 2>/dev/null || echo '[]')"
  disabled_csv="$(jq -r 'join(",")' <<<"$disabled_members" 2>/dev/null || true)"
  if [[ "$disabled_members" == "[]" ]]; then
    if [[ "$DISABLED_MEMBERS" != "[]" ]]; then
      local previous_disabled
      previous_disabled="$(jq -r 'join(",")' <<<"$DISABLED_MEMBERS" 2>/dev/null || true)"
      if _probe_post "✅ watchdog minimum-set lanes re-enabled: ${previous_disabled} (FLY-1393)."; then
        DISABLED_MEMBERS='[]'; DISABLED_LAST_NOTIFIED_AT=0
      fi
    fi
  elif [[ "$disabled_members" != "$DISABLED_MEMBERS" ]] \
    || (( DISABLED_LAST_NOTIFIED_AT == 0 || now - DISABLED_LAST_NOTIFIED_AT >= disabled_reminder_min * 60 )); then
    if _probe_post "⚠️ watchdog minimum-set lanes disabled: ${disabled_csv} (supported kill switch; quiet does not prove these lanes healthy; reminder every ${disabled_reminder_min}m, FLY-1393)."; then
      DISABLED_MEMBERS="$disabled_members"; DISABLED_LAST_NOTIFIED_AT="$now"
    fi
  fi

  local stalled_min="${FLYWHEEL_WATCHDOG_STALLED_ESCALATE_MIN:-2}"
  local observed
  observed="$(jq -c '[.watchdogs.components.w2_delivery_loop.leads[]? | select(.freshness == "stale") | .lead_id] | unique | sort' <<<"$body" 2>/dev/null || echo '[]')"
  if [[ "$observed" == "[]" ]]; then
    if [[ "$STALLED_ESCALATED" == "true" ]]; then
      if _probe_post "✅ Lead inbox stalled 集合全部恢复(FLY-1393 W-2)。"; then
        STALLED_ESCALATED=false; STALLED_MEMBERS='[]'; STALLED_COUNT=0
      fi
    else
      STALLED_MEMBERS='[]'; STALLED_COUNT=0
    fi
  else
    STALLED_COUNT=$(( STALLED_COUNT + 1 ))
    if [[ "$STALLED_ESCALATED" != "true" ]] && (( STALLED_COUNT >= stalled_min )); then
      if _probe_post "🚨 Lead inbox loop stalled: $(jq -r 'join(",")' <<<"$observed")(FLY-1393 W-2 独立探针)。"; then
        STALLED_ESCALATED=true; STALLED_MEMBERS="$observed"
      fi
    elif [[ "$STALLED_ESCALATED" == "true" && "$observed" != "$STALLED_MEMBERS" ]]; then
      if _probe_post "⚠️ Lead inbox stalled 集合更新: $(jq -r 'join(",")' <<<"$observed")(故障仍在)。"; then
        STALLED_MEMBERS="$observed"
      fi
    fi
  fi

  write_state
  if [[ -n "$disabled_csv" ]]; then
    # A documented kill switch is not structural degradation. Keep evaluating
    # every independent leg, then expose and periodically remind on the state.
    echo "ok disabled=${disabled_csv}"
  else
    echo "ok"
  fi
  return 0
}

# Sourced by tests (they override the seams then call probe_once); executed
# directly by launchd.
if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  probe_once
fi
