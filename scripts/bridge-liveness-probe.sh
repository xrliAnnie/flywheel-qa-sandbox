#!/usr/bin/env bash
# FLY-1082 (Task 3.3): the OUT-OF-PROCESS Bridge liveness probe.
#
# The 2026-07-09 incident's silent hole: every detection surface (the Lead-pane alert loop /
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
BRIDGE_LOG_STATE_DIR="${FLYWHEEL_STATE_DIR:-${HOME}/.flywheel}/state"
BRIDGE_MAIN_LOG="${FLYWHEEL_BRIDGE_LOG_PATH:-/tmp/flywheel-bridge.log}"
BRIDGE_STARTUP_LOG="${FLYWHEEL_BRIDGE_RAW_STARTUP_LOG:-${BRIDGE_LOG_STATE_DIR}/bridge-startup.log}"
BRIDGE_ROTATION_ERROR_MARKER="${FLYWHEEL_BRIDGE_LOG_ERROR_MARKER:-${BRIDGE_LOG_STATE_DIR}/bridge-log-rotation-error.json}"

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

# ── State v4: independent down/degraded/stalled/disabled/rotation episodes ──
read_state() {
  if [[ -f "$STATE_FILE" ]] && command -v jq >/dev/null 2>&1; then
    # Flat v1 and structured v2/v3 keys are accepted and rewritten as v4.
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
    ROTATION_SIGNATURE="$(jq -r '.rotation.signature // ""' "$STATE_FILE" 2>/dev/null || echo '')"
    ROTATION_LAST_NOTIFIED_AT="$(jq -r '.rotation.lastNotifiedAt // 0' "$STATE_FILE" 2>/dev/null || echo 0)"
  else
    DOWN_COUNT=0; DOWN_SINCE=0; DOWN_ESCALATED=false; LAST_OK_TS=0
    DEGRADED_COUNT=0; DEGRADED_SINCE=0; DEGRADED_ESCALATED=false
    STALLED_COUNT=0; STALLED_ESCALATED=false; STALLED_MEMBERS='[]'
    DISABLED_MEMBERS='[]'; DISABLED_LAST_NOTIFIED_AT=0
    ROTATION_SIGNATURE=''; ROTATION_LAST_NOTIFIED_AT=0
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
  [[ "$ROTATION_LAST_NOTIFIED_AT" =~ ^[0-9]+$ ]] || ROTATION_LAST_NOTIFIED_AT=0
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
    --arg rotationSignature "$ROTATION_SIGNATURE" --argjson rotationLastNotifiedAt "$ROTATION_LAST_NOTIFIED_AT" \
    '{schemaVersion:4,down:{count:$downCount,since:$downSince,escalated:$downEscalated,lastOkTs:$lastOkTs},degraded:{count:$degradedCount,since:$degradedSince,escalated:$degradedEscalated},stalled:{count:$stalledCount,escalated:$stalledEscalated,members:$stalledMembers},disabled:{members:$disabledMembers,lastNotifiedAt:$disabledLastNotifiedAt},rotation:{signature:$rotationSignature,lastNotifiedAt:$rotationLastNotifiedAt}}' \
    > "$tmp" 2>/dev/null; then
    mv "$tmp" "$STATE_FILE"
  else
    rm -f "$tmp"
  fi
}

# FLY-1560 刀 6: /health renamed its manifest key `watchdogs` → `liveness` and
# bumped schema_version 1 → 2. Read BOTH keys everywhere: probe and Bridge cross
# a deploy boundary in either order, and a key-only miss would otherwise read as
# "manifest missing" and page the founder for a healthy Bridge.
_manifest_filter='((.liveness // .watchdogs) // {})'

liveness_manifest_valid() {
  jq -e --arg _ "" "
    ${_manifest_filter} as \$m |
    (\$m.schema_version == 1 or \$m.schema_version == 2) and
    (\$m.components.w1_process_liveness | type == \"object\" and .wired == true and (.effective_enabled | type == \"boolean\")) and
    (\$m.components.w2_delivery_loop | type == \"object\" and .wired == true and (.effective_enabled | type == \"boolean\")) and
    (\$m.components.w2_delivery_loop.leads |
      type == \"array\" and
      all(.[];
        type == \"object\" and
        (.lead_id | type == \"string\") and
        (.lead_id | length > 0) and
        (.freshness == \"fresh\" or .freshness == \"stale\")
      )
    ) and
    (\$m.components.w3_external_drift | type == \"object\" and .wired == true and (.effective_enabled | type == \"boolean\") and .observation == \"static_contract\") and
    ((\$m.retiring // []) | all(.effective_enabled != true)) and
    (if \$m.schema_version >= 2 then
      (\$m.components.w1_process_liveness |
        (.switch == \"required\") and
        (.freshness == \"not_started\" or .freshness == \"fresh\" or .freshness == \"stale\" or .freshness == \"in_flight\") and
        ((.in_flight_age_ms | type == \"number\") or .in_flight_age_ms == null)
      )
     else true end)
  " >/dev/null 2>&1
}

# FLY-1560 §2.7 receiving end. schema v2 publishes the W-1 tracker state from
# the HeartbeatService reconcileMonitorLoss → reapOrphans span. `fresh` is the
# only healthy state:
#   - `not_started` is legitimate only while the Bridge is still inside boot
#     grace (the first pass fires one W-1 cadence after boot);
#   - `stale` means the last pass completed too long ago;
#   - `in_flight` past the grace window means the owner is HUNG — the manifest
#     deliberately refuses to claim `fresh` there, so a probe that ignored it
#     would turn a hung liveness owner back into the silent green this teardown
#     exists to remove.
# Unhealthy W-1 feeds the EXISTING degraded episode (no new route), so the
# probe's own grace/consecutive-count hysteresis applies on top of the window
# below before anything pages.
w1_liveness_unhealthy_reason() {
  local grace_sec="$1" body="$2"
  local schema freshness age uptime
  schema="$(jq -r "${_manifest_filter} | (.schema_version // 1)" <<<"$body" 2>/dev/null || echo 1)"
  [[ "$schema" =~ ^[0-9]+$ ]] || schema=1
  (( schema < 2 )) && return 0

  freshness="$(jq -r "${_manifest_filter} | (.components.w1_process_liveness.freshness // \"\")" <<<"$body" 2>/dev/null || echo "")"
  age="$(jq -r "${_manifest_filter} | (.components.w1_process_liveness.in_flight_age_ms // 0)" <<<"$body" 2>/dev/null || echo 0)"
  age="${age%%.*}"; [[ "$age" =~ ^[0-9]+$ ]] || age=0
  # Bridge uptime as the manifest itself reports it — self-consistent even if
  # the probe host clock disagrees with the Bridge host clock.
  uptime="$(jq -r "
    ${_manifest_filter} as \$m |
    ((\$m.generated_at // \"\") | sub(\"[.][0-9]+\"; \"\")) as \$g |
    ((\$m.bridge_started_at // \"\") | sub(\"[.][0-9]+\"; \"\")) as \$b |
    if (\$g | length) == 0 or (\$b | length) == 0 then -1
    else ((\$g | fromdateiso8601) - (\$b | fromdateiso8601)) end" <<<"$body" 2>/dev/null || echo -1)"
  uptime="${uptime%%.*}"; [[ "$uptime" =~ ^-?[0-9]+$ ]] || uptime=-1

  case "$freshness" in
    fresh) ;;
    not_started)
      if (( uptime < 0 || uptime > grace_sec )); then
        printf 'W-1 liveness 从未完成过一轮(Bridge 已启动 %ss)' "$uptime"
      fi ;;
    stale)
      printf 'W-1 liveness 上一轮完成过久(freshness=stale)' ;;
    in_flight)
      if (( age > grace_sec * 1000 )); then
        printf 'W-1 liveness pass 挂起 %sms 未完成' "$age"
      fi ;;
    *)
      printf 'W-1 liveness freshness 缺失或非法(%s)' "${freshness:-<empty>}" ;;
  esac
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
      if _probe_post "🚨 ${mention} Bridge 连续 down ≥ ${ESCALATE_MIN} 分钟且没有活过来(外部心跳探针)。最后一次健康响应:${last_ok}。建议:bash ~/Dev/flywheel/scripts/restart-services.sh;若起不来看 ${BRIDGE_MAIN_LOG}、${BRIDGE_STARTUP_LOG}、${BRIDGE_ROTATION_ERROR_MARKER} + lsof -ti:9876。"; then
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

  # FLY-2049: log rotation is availability-advisory. A stalled/failed adapter
  # leaves Bridge online and a bounded marker behind; this independent probe
  # turns that durable marker into an immediate page plus hourly reminders.
  local rotation_reminder_min="${FLYWHEEL_LOG_ROTATION_REMINDER_MIN:-60}"
  [[ "$rotation_reminder_min" =~ ^[0-9]+$ ]] || rotation_reminder_min=60
  local observed_rotation_signature=""
  if [[ -e "$BRIDGE_ROTATION_ERROR_MARKER" || -L "$BRIDGE_ROTATION_ERROR_MARKER" ]]; then
    if [[ -f "$BRIDGE_ROTATION_ERROR_MARKER" && ! -L "$BRIDGE_ROTATION_ERROR_MARKER" ]]; then
      observed_rotation_signature="$(jq -r '(.message // "unknown_rotation_error") | tostring | gsub("[\\r\\n]"; " ")' "$BRIDGE_ROTATION_ERROR_MARKER" 2>/dev/null || echo invalid_rotation_marker)"
    else
      observed_rotation_signature="unsafe_rotation_marker_path"
    fi
    if [[ "$observed_rotation_signature" != "$ROTATION_SIGNATURE" ]] \
      || (( ROTATION_LAST_NOTIFIED_AT == 0 || now - ROTATION_LAST_NOTIFIED_AT >= rotation_reminder_min * 60 )); then
      if _probe_post "⚠️ Bridge 在线,但日志轮转已停用:${observed_rotation_signature}。主日志仍以 short-FD 续写;请检查 ${BRIDGE_ROTATION_ERROR_MARKER} 与 ${BRIDGE_MAIN_LOG}(每 ${rotation_reminder_min}m 重醒)。"; then
        ROTATION_SIGNATURE="$observed_rotation_signature"
        ROTATION_LAST_NOTIFIED_AT="$now"
      fi
    fi
  elif [[ -n "$ROTATION_SIGNATURE" ]]; then
    if _probe_post "✅ Bridge 日志轮转告警已恢复;marker 已清除(FLY-2049)。"; then
      ROTATION_SIGNATURE=''
      ROTATION_LAST_NOTIFIED_AT=0
    fi
  fi

  local grace_min="${FLYWHEEL_LIVENESS_MANIFEST_GRACE_MIN:-5}"
  local degraded_min="${FLYWHEEL_LIVENESS_MANIFEST_DEGRADED_MIN:-3}"
  [[ "$grace_min" =~ ^[0-9]+$ ]] || grace_min=5
  [[ "$degraded_min" =~ ^[0-9]+$ ]] || degraded_min=3

  local degraded_reason=""
  if ! liveness_manifest_valid <<<"$body"; then
    degraded_reason="liveness manifest 缺失或不完整"
  else
    local w1_reason
    w1_reason="$(w1_liveness_unhealthy_reason "$(( grace_min * 60 ))" "$body")"
    [[ -n "$w1_reason" ]] && degraded_reason="$w1_reason"
  fi

  if [[ -n "$degraded_reason" ]]; then
    (( DEGRADED_COUNT == 0 || DEGRADED_SINCE == 0 )) && DEGRADED_SINCE="$now"
    DEGRADED_COUNT=$(( DEGRADED_COUNT + 1 ))
    if (( now - DEGRADED_SINCE >= grace_min * 60 && DEGRADED_COUNT >= degraded_min )) \
      && [[ "$DEGRADED_ESCALATED" != "true" ]]; then
      if _probe_post "🚨 Bridge 可达,但 ${degraded_reason} — 安静不能证明没事(FLY-1393)。"; then
        DEGRADED_ESCALATED=true
      fi
    fi
    write_state
    echo "degraded ${DEGRADED_COUNT}"
    return 0
  fi

  if [[ "$DEGRADED_ESCALATED" == "true" ]]; then
    _probe_post "✅ liveness manifest 恢复 — 最小集重新可观测(FLY-1393)。" || true
  fi
  DEGRADED_COUNT=0; DEGRADED_SINCE=0; DEGRADED_ESCALATED=false

  local disabled_reminder_min="${FLYWHEEL_LIVENESS_DISABLED_REMINDER_MIN:-1440}"
  [[ "$disabled_reminder_min" =~ ^[0-9]+$ ]] || disabled_reminder_min=1440
  local disabled_members disabled_csv
  disabled_members="$(jq -c "[${_manifest_filter}.components | to_entries[] | select(.value.effective_enabled == false) | .key] | unique | sort" <<<"$body" 2>/dev/null || echo '[]')"
  disabled_csv="$(jq -r 'join(",")' <<<"$disabled_members" 2>/dev/null || true)"
  if [[ "$disabled_members" == "[]" ]]; then
    if [[ "$DISABLED_MEMBERS" != "[]" ]]; then
      local previous_disabled
      previous_disabled="$(jq -r 'join(",")' <<<"$DISABLED_MEMBERS" 2>/dev/null || true)"
      if _probe_post "✅ liveness lanes re-enabled: ${previous_disabled} (FLY-1393)."; then
        DISABLED_MEMBERS='[]'; DISABLED_LAST_NOTIFIED_AT=0
      fi
    fi
  elif [[ "$disabled_members" != "$DISABLED_MEMBERS" ]] \
    || (( DISABLED_LAST_NOTIFIED_AT == 0 || now - DISABLED_LAST_NOTIFIED_AT >= disabled_reminder_min * 60 )); then
    if _probe_post "⚠️ liveness lanes disabled: ${disabled_csv} (supported kill switch; quiet does not prove these lanes healthy; reminder every ${disabled_reminder_min}m, FLY-1393)."; then
      DISABLED_MEMBERS="$disabled_members"; DISABLED_LAST_NOTIFIED_AT="$now"
    fi
  fi

  local stalled_min="${FLYWHEEL_LIVENESS_STALLED_ESCALATE_MIN:-2}"
  local observed
  observed="$(jq -c "[${_manifest_filter}.components.w2_delivery_loop.leads[]? | select(.freshness == \"stale\") | .lead_id] | unique | sort" <<<"$body" 2>/dev/null || echo '[]')"
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
