#!/bin/bash
# FLY-83: Independent Lead alert emitter.
#
# Bridge-independent shell alert pipeline. Lives in
# shell so it works even when the Bridge (Node.js) is down.
#
# Responsibilities:
#   1. Resolve alert channel + bot token from ~/.flywheel/projects.json.
#   2. Generate eventId = sha1(projectName|leadId|kind|signature).
#      - signature defaults to today's date (YYYYMMDD) so a crash-looping
#        Lead alerts at most once per day per (project, lead, kind).
#      - --signature lets callers override (e.g., a pane content hash for
#        future kinds that mirror the Bridge-side alert-kind-copy formula).
#   3. Claim dedup via ~/.flywheel/alerts/claims.db (single sqlite3 tx,
#      BEGIN IMMEDIATE + INSERT OR IGNORE + SELECT changes()) — the SAME
#      table the Bridge `LeadAlertNotifier.claimsClaimer` writes to.
#   4. Post to Discord; on failure spill to ~/.flywheel/alert-queue/.
#
# Usage:
#   lead-alert.sh \
#     --lead <lead-id> --project <project-name> \
#     --kind <rate_limit|usage_limit|login_expired|permission_blocked|crash_loop|pane_hash_stuck|companion_config_error|external_config_error|rules_bundle_legacy|tui_window_lost|codex_lead_residency_stalled|restart_guard_bypass|calendar_wild_write|quota_guard_bypassed|bin_integrity_drift|notify_digest_failed|deploy_failed|deploy_degraded> \
#     --severity <info|warning|severe> \
#     --title <string> --body <string> \
#     [--signature <string>] [--strict-delivery] [--mention-user <snowflake>] \
#     [--plain-message]
#
# Exit codes:
#   0 — posted or already claimed (both are success: no double-alert)
#   1 — unrecoverable config error (missing projects.json, unknown lead, etc.)
#   2 — Discord POST failed, payload queued for later drain
#
# --strict-delivery (FLY-913): print ONE machine-readable result line on stdout
#   (`sent|duplicate|queued_transient|dead_lettered|config_error`) so callers
#   can distinguish "transient failure, queued and WILL drain" from "permanently
#   undeliverable" — exit 2 alone conflates the two (Codex R1 #1). Without the
#   flag, behavior (stdout/stderr/exit codes) is byte-for-byte unchanged.
set -euo pipefail

log() {
  echo "[lead-alert] $(date '+%H:%M:%S') $*" >&2
}

# FLY-1319: resolve Annie's current timezone without trusting `TZ=bad date`.
# macOS date silently renders UTC and exits 0 for an invalid TZ, so every named
# candidate must be a traversal-free IANA path present under a zoneinfo root.
valid_founder_timezone() {
  local candidate="$1" root
  [ -n "$candidate" ] || return 1
  case "$candidate" in
    /*|*..*) return 1 ;;
  esac
  local old_ifs="$IFS"
  IFS=':'
  for root in ${FLYWHEEL_ZONEINFO_ROOTS:-/var/db/timezone/zoneinfo:/usr/share/zoneinfo}; do
    if [ -f "${root%/}/${candidate}" ]; then
      IFS="$old_ifs"
      return 0
    fi
  done
  IFS="$old_ifs"
  return 1
}

resolve_founder_timezone() {
  local candidate="${FLYWHEEL_FOUNDER_TZ:-}" localtime target
  if [ -n "$candidate" ]; then
    if valid_founder_timezone "$candidate"; then
      printf '%s\n' "$candidate"
      return
    fi
    log "WARNING: invalid FLYWHEEL_FOUNDER_TZ='${candidate}', falling back to host timezone"
  fi

  localtime="${FLYWHEEL_LOCALTIME_PATH:-/etc/localtime}"
  if [ -e "$localtime" ] && [ ! -L "$localtime" ]; then
    # Copy-style /etc/localtime: no IANA name is recoverable, so let host date
    # use the operating system's live local timezone.
    printf '%s\n' '__HOST__'
    return
  fi
  target=$(readlink "$localtime" 2>/dev/null || true)
  case "$target" in
    *zoneinfo/*) candidate="${target##*zoneinfo/}" ;;
    *) candidate="" ;;
  esac
  if valid_founder_timezone "$candidate"; then
    printf '%s\n' "$candidate"
    return
  fi
  printf '%s\n' 'America/Los_Angeles'
}

founder_ticket_clock() {
  local timezone
  timezone=$(resolve_founder_timezone)
  if [ "$timezone" = "__HOST__" ]; then
    date '+%H:%M %Z'
  else
    TZ="$timezone" date '+%H:%M %Z'
  fi
}

usage() {
  sed -n '3,40p' "$0" >&2
  exit 1
}

LEAD_ID=""
PROJECT_NAME=""
KIND=""
SEVERITY="warning"
TITLE=""
BODY=""
SIGNATURE=""
STRICT_DELIVERY=0
MENTION_USER=""
PLAIN_MESSAGE=0

# FLY-1256 mirror of LeadAlertNotifier.INFORMATIONAL_KINDS. These kinds still
# post a root message, but never render the unified ticket header.
INFORMATIONAL_KINDS="account_switched model_cap_switched model_cap_unknown quota_switch_confirmation quota_blocked_recovered workflow_route_input_rejected flag_scan_failed flag_scan_handoff flag_scan_no_clock"
is_informational_kind() {
  case " ${INFORMATIONAL_KINDS} " in
    *" $1 "*) return 0 ;;
    *) return 1 ;;
  esac
}

is_quota_switch_kind() {
  case "$1" in
    account_switched|account_switch_degraded|quota_switch_confirmation) return 0 ;;
    *) return 1 ;;
  esac
}

# FLY-913: machine-readable delivery result on stdout, ONLY under
# --strict-delivery. log() writes to stderr, so this is the sole stdout line.
emit_result() {
  if [ "$STRICT_DELIVERY" = "1" ]; then
    printf '%s\n' "$1"
  fi
}

while [ $# -gt 0 ]; do
  case "$1" in
    --lead)      LEAD_ID="${2:?--lead requires a value}"; shift 2 ;;
    --project)   PROJECT_NAME="${2:?--project requires a value}"; shift 2 ;;
    --kind)      KIND="${2:?--kind requires a value}"; shift 2 ;;
    --severity)  SEVERITY="${2:?--severity requires a value}"; shift 2 ;;
    --title)     TITLE="${2:?--title requires a value}"; shift 2 ;;
    --body)      BODY="${2:?--body requires a value}"; shift 2 ;;
    --signature) SIGNATURE="${2:?--signature requires a value}"; shift 2 ;;
    --strict-delivery) STRICT_DELIVERY=1; shift ;;
    --mention-user) MENTION_USER="${2:?--mention-user requires a value}"; shift 2 ;;
    --plain-message) PLAIN_MESSAGE=1; shift ;;
    -h|--help)   usage ;;
    *)
      log "ERROR: unknown flag '$1'"
      emit_result "config_error"
      usage
      ;;
  esac
done

if [ -z "$LEAD_ID" ] || [ -z "$PROJECT_NAME" ] || [ -z "$KIND" ] || [ -z "$TITLE" ] || [ -z "$BODY" ]; then
  log "ERROR: --lead, --project, --kind, --title, --body are all required"
  emit_result "config_error"
  usage
fi

case "$KIND" in
  # FLY-871 §12 W2: tui_window_lost — the windowed Codex Lead's silent-no-pane
  # guard fires this via lead-alert.sh (Discord-independent path). Kept in the TS
  # AlertEventType union too (LeadAlertNotifier.ts) so the shared type face has no drift.
  # FLY-913: restart_guard_bypass — the flywheel-restart-guard PreToolUse hook's
  # mandatory bypass alert (every bypass MUST ring; the hook fail-closes on
  # anything but sent/queued_transient). Same TS-union parity convention.
  # FLY-927 (D4): bridge_wrapper_fail — the Bridge launchd wrapper's fail-loud
  # Discord leg routes through this script (unified channel + sender gating +
  # claims dedup); direct-curl core-channel kept as its fallback. Same TS-union
  # parity convention (LeadAlertNotifier.ts ALERT_EVENT_TYPES).
  # FLY-954: bin_integrity_drift — converge-flywheel-bin.sh 检出 <state>/bin 与
  # repo 源漂移(修复成功/失败/源坏拒修均响)。Same TS-union parity convention.
  # FLY-929: notify_digest_failed — the daily token report failed in place
  # (token-usage-daily.sh fail-loud) or left no receipt (Bridge expect tick).
  # FLY-1081: deploy_failed / deploy_degraded — restart-services.sh /
  # update-flywheel.sh 🚨/⚠️ deploy notices (system identity --lead deploy /
  # --lead updater; shell-only kinds, the Bridge never emits them). Same
  # TS-union parity convention (LeadAlertNotifier.ts ALERT_EVENT_TYPES).
  # FLY-1082: the 5 fleet-failure kinds. bridge_abnormal_exit is LOAD-BEARING
  # on this leg (the wrapper preflight dirty-marker page fires while the Bridge
  # is down); the other four are added for face parity with the TS union
  # (kind-contract.test.ts is the drift guard on both faces).
  # FLY-1929: host_voucher_incident — the voucher guard's host-level page.
  # Shell-only kind (the Bridge never emits it), same TS-union parity convention.
  # Covers BOTH sources; pressure vs panic is encoded in the body + signature,
  # because a validated occupancy climb and a fresh panic report are the same
  # incident class with the same (absent) remediation posture.
  rate_limit|usage_limit|login_expired|permission_blocked|crash_loop|pane_hash_stuck|companion_config_error|external_config_error|rules_bundle_legacy|workflow_route_input_rejected|tui_window_lost|restart_guard_bypass|calendar_wild_write|restart_storm_hold|quota_guard_bypassed|bridge_wrapper_fail|bin_integrity_drift|discord_plugin_integrity_failed|notify_digest_failed|deploy_failed|deploy_degraded|swap_pressure_high|tmux_server_lost|tmux_hold|tmux_split_brain|bridge_abnormal_exit|infra_bot_down|zombie_session_backlog|three_stage_takeover_failed|account_switched|account_switch_degraded|machine_account_conflict|model_config|model_cap_switched|model_cap_unknown|model_cap_persistent_unknown|model_bench_malformed|quota_choice|quota_switch_confirmation|quota_no_target|quota_blocked_recovered|quota_read_blind|account_switch_failed|account_identity_mismatch|quota_revive_stuck|quota_monitor_down|lead_dual_active|lead_dual_active_sensor_degraded|lead_lease_store_broken|lead_lease_bypass_used|lead_lease_would_block|lead_lease_control_broken|lead_identity_source_broken|lead_backend_drift|cmux_cleanup|cmux_watcher_stalled|codex_lead_residency_stalled|cmux_watcher_unrecovered|tmux_rescue_hold|flag_scan_failed|flag_scan_handoff|flag_scan_no_clock|meeting_notes_failed|host_voucher_incident) ;;
  *)
    log "ERROR: unknown --kind '$KIND'"
    emit_result "config_error"
    exit 1
    ;;
esac

case "$SEVERITY" in
  info|warning|severe) ;;
  *)
    log "ERROR: unknown --severity '$SEVERITY' (must be info|warning|severe)"
    emit_result "config_error"
    exit 1
    ;;
esac

# FLY-2051: ordinary-message rendering is a narrow capability, not a generic
# way for alert producers to bypass ticket/alert framing.
if [ "$PLAIN_MESSAGE" = "1" ] && ! is_quota_switch_kind "$KIND"; then
  log "ERROR: --plain-message is allowed only for the quota switch family"
  emit_result "config_error"
  exit 1
fi

# FLY-1081: opt-in explicit @-mention (deploy_failed → founder). A malformed id
# degrades to no-ping (alert still delivers) rather than failing the alert or
# producing a Discord-rejected mentions body. Unset ⇒ byte-compat.
if [ -n "$MENTION_USER" ] && ! printf '%s' "$MENTION_USER" | grep -Eq '^[0-9]{17,20}$'; then
  log "WARNING: --mention-user '$MENTION_USER' invalid, ignoring"
  MENTION_USER=""
fi

# The restart guard and resident cmux watcher can run without an interactive
# shell. Read only the three values their unified route needs from the trusted
# env in isolated subshells. Inherited values win, and unrelated secrets never
# enter this process environment or its curl child.
system_alert_env_value() {
  local -r _system_alert_requested_name="$1"
  (
    set +a
    source "$SYSTEM_ALERT_ENV_FILE" >/dev/null 2>&1 || exit 1
    printf '%s' "${!_system_alert_requested_name:-}"
  )
}

trusted_alert_env_valid() {
  local path="$1" metadata owner mode
  [ -e "$path" ] || { log "ERROR: watcher alert env is missing: $path"; return 1; }
  [ ! -L "$path" ] || { log "ERROR: watcher alert env is a symlink: $path"; return 1; }
  [ -f "$path" ] || { log "ERROR: watcher alert env is not a regular file: $path"; return 1; }
  metadata=$(stat -c '%u %a' "$path" 2>/dev/null || stat -f '%u %Lp' "$path" 2>/dev/null) || {
    log "ERROR: watcher alert env metadata is unreadable: $path"
    return 1
  }
  owner=${metadata%% *}
  mode=${metadata##* }
  [ "$owner" = "$(id -u)" ] && [ "$mode" = "600" ] || {
    log "ERROR: watcher alert env must be owned by uid $(id -u) with mode 0600: $path"
    return 1
  }
  /bin/bash -n "$path" >/dev/null 2>&1 || {
    log "ERROR: watcher alert env has invalid shell syntax: $path"
    return 1
  }
}

if [ "$LEAD_ID" = "system" ] || [ "${FLYWHEEL_CMUX_SUPERVISED:-0}" = "1" ]; then
  SYSTEM_ALERT_ENV_FILE="${FLYWHEEL_SYSTEM_ALERT_ENV_FILE:-${HOME}/.flywheel/.env}"
  TRUSTED_ALERT_ENV_OK=1
  if [ -n "${FLYWHEEL_ALERT_SENDER_TOKEN_ENV:-}" ] \
      && [[ ! "$FLYWHEEL_ALERT_SENDER_TOKEN_ENV" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then
    log "ERROR: watcher alert sender token selector is not a valid env name"
    TRUSTED_ALERT_ENV_OK=0
  fi
  if [ -z "${FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID:-}" ] \
      || [ -z "${FLYWHEEL_ALERT_SENDER_TOKEN_ENV:-}" ] \
      || [ -z "${!FLYWHEEL_ALERT_SENDER_TOKEN_ENV:-}" ]; then
    trusted_alert_env_valid "$SYSTEM_ALERT_ENV_FILE" || TRUSTED_ALERT_ENV_OK=0
    if [ "$TRUSTED_ALERT_ENV_OK" = "1" ] && [ -z "${FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID:-}" ]; then
      FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID="$(system_alert_env_value FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID)" || {
        log "ERROR: watcher alert env is unreadable: $SYSTEM_ALERT_ENV_FILE"
        TRUSTED_ALERT_ENV_OK=0
      }
    fi
    if [ "$TRUSTED_ALERT_ENV_OK" = "1" ] && [ -z "${FLYWHEEL_ALERT_SENDER_TOKEN_ENV:-}" ]; then
      FLYWHEEL_ALERT_SENDER_TOKEN_ENV="$(system_alert_env_value FLYWHEEL_ALERT_SENDER_TOKEN_ENV)" || {
        log "ERROR: watcher alert env is unreadable: $SYSTEM_ALERT_ENV_FILE"
        TRUSTED_ALERT_ENV_OK=0
      }
    fi
    if [ "$TRUSTED_ALERT_ENV_OK" = "1" ] \
        && [[ ! "$FLYWHEEL_ALERT_SENDER_TOKEN_ENV" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then
      log "ERROR: watcher alert sender token selector is not a valid env name"
      TRUSTED_ALERT_ENV_OK=0
    fi
    if [ "$TRUSTED_ALERT_ENV_OK" = "1" ] \
        && [ -z "${!FLYWHEEL_ALERT_SENDER_TOKEN_ENV:-}" ]; then
      _system_alert_token="$(system_alert_env_value "$FLYWHEEL_ALERT_SENDER_TOKEN_ENV")" || {
        log "ERROR: watcher alert env is unreadable: $SYSTEM_ALERT_ENV_FILE"
        TRUSTED_ALERT_ENV_OK=0
      }
      if [ "$TRUSTED_ALERT_ENV_OK" = "1" ]; then
        printf -v "$FLYWHEEL_ALERT_SENDER_TOKEN_ENV" '%s' "$_system_alert_token"
        export -n "$FLYWHEEL_ALERT_SENDER_TOKEN_ENV" 2>/dev/null || true
      fi
      unset _system_alert_token
    fi
  fi
  if [ "$LEAD_ID" = "system" ] && { [ "$TRUSTED_ALERT_ENV_OK" != "1" ] \
      || [ -z "${FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID:-}" ] \
      || [ -z "${FLYWHEEL_ALERT_SENDER_TOKEN_ENV:-}" ] \
      || [ -z "${!FLYWHEEL_ALERT_SENDER_TOKEN_ENV:-}" ]; }; then
    log "ERROR: system alert route requires unified channel + sender token"
    emit_result "config_error"
    exit 1
  fi
fi

# ── Tool preflight ──────────────────────────────────────────
for tool in jq sqlite3 curl shasum node; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    log "ERROR: required tool '$tool' not found in PATH"
    emit_result "config_error"
    exit 1
  fi
done

# ── Discord-INDEPENDENT meta-alert escape (FLY-182 §4.5.1) ──
# Resolve our own dir early so the meta-alert escape is reachable from EVERY
# failure branch — including unknown-lead, which exits before the later
# dead_letter() definition. meta-alert.sh self-debounces per reason and
# OVERWRITES its marker, so repeated calls neither spam nor grow unbounded.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
fire_meta_alert() {
  # $1 = reason, $2 = title, $3 = body. Best-effort; never breaks the caller.
  if [ -x "${SCRIPT_DIR}/meta-alert.sh" ]; then
    "${SCRIPT_DIR}/meta-alert.sh" "$1" "$2" "$3" || true
  fi
}

# Escape single quotes for sqlite3 string literals (parity with the TS
# sqlString() claimer). sqlite3-over-stdin can't bind params, so we double any
# embedded single quote to avoid breaking the claim transaction / local DB.
sql_quote() { printf '%s' "$1" | sed "s/'/''/g"; }

# ── FLY-927 (D3): unified-channel + single-sender-identity overrides ─────────
# lead-alert.sh is the Bridge-independent alert channel (FLY-954 alignment) —
# the unified alert channel + the D2 single sender identity must be first-class
# here too. When BOTH are set, projects.json is not needed at all (system-level
# callers like the bridge wrapper pass the conventional identity
# `--project flywheel --lead bridge`, which has no projects.json entry).
# All env unset ⇒ the per-lead projects.json path below, byte-for-byte.
UNIFIED_CHANNEL="${FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID:-}"
SENDER_TOKEN_ENV="${FLYWHEEL_ALERT_SENDER_TOKEN_ENV:-}"

# ── Config resolution (projects.json SSOT) ──────────────────
ALERT_CHANNEL=""
FALLBACK_TO_CORE=""
GENERAL_CHANNEL=""
ALERT_BOT_TOKEN_ENV=""
LEAD_BOT_TOKEN_ENV=""
if [ -n "$UNIFIED_CHANNEL" ] && [ -n "$SENDER_TOKEN_ENV" ]; then
  : # channel + identity fully env-driven — skip projects.json entirely
else
PROJECTS_JSON="${FLYWHEEL_PROJECTS_FILE:-${HOME}/.flywheel/projects.json}"
if [ ! -f "$PROJECTS_JSON" ]; then
  log "ERROR: projects.json not found at $PROJECTS_JSON"
  # FLY-231 (Codex code-review HIGH-1): the companion fail-STOP path calls this
  # exactly when projects.json is missing/unreadable. Without a Discord-INDEPENDENT
  # meta-alert here, the alert is silently lost (the channel can't be resolved from
  # the very file that's gone). Surface it so Annie still learns a Lead won't start.
  fire_meta_alert \
    "alert_dead_lettered" \
    "LeadAlert dropped (shell path)" \
    "projects.json not found at ${PROJECTS_JSON}; alert (lead=${LEAD_ID} project=${PROJECT_NAME} kind=${KIND}) dropped — config missing."
  emit_result "config_error"
  exit 1
fi

# Capture jq failure (corrupt/unreadable JSON) explicitly — under `set -e` a bare
# `VAR=$(jq ...)` would abort BEFORE the emptiness check below, skipping the
# meta-alert (Codex code-review HIGH-1). `if ! VAR=$(...)` suppresses set -e and
# lets us route corrupt config to the Discord-independent escape too.
if ! LEAD_CFG=$(jq -c --arg p "$PROJECT_NAME" --arg l "$LEAD_ID" '
  .[] | select(.projectName == $p) as $proj
  | $proj.leads[] | select(.agentId == $l)
  | { alertChannel: .alertChannel,
      alertBotTokenEnv: .alertBotTokenEnv,
      alertDmUserId: .alertDmUserId,
      alertFallbackToCore: (.alertFallbackToCore // false),
      botTokenEnv: .botTokenEnv,
      generalChannel: $proj.generalChannel }' "$PROJECTS_JSON" 2>/dev/null); then
  log "ERROR: failed to parse projects.json at $PROJECTS_JSON (corrupt?)"
  fire_meta_alert \
    "alert_dead_lettered" \
    "LeadAlert dropped (shell path)" \
    "projects.json unreadable/corrupt at ${PROJECTS_JSON}; alert (lead=${LEAD_ID} project=${PROJECT_NAME} kind=${KIND}) dropped — config parse error."
  emit_result "config_error"
  exit 1
fi

if [ -z "$LEAD_CFG" ] || [ "$LEAD_CFG" = "null" ]; then
  log "ERROR: lead '$LEAD_ID' not found in project '$PROJECT_NAME' (projects.json)"
  # FLY-182: unknown-lead is a PERMANENT failure (config drift / renamed lead).
  # Surface it via the Discord-independent meta-alert so it never goes silent —
  # parity with LeadAlertNotifier, which dead-letters unknown-lead.
  fire_meta_alert \
    "alert_dead_lettered" \
    "LeadAlert dropped (shell path)" \
    "Lead '${LEAD_ID}' not found in project '${PROJECT_NAME}' (projects.json). Alert (kind=${KIND}) dropped — config drift or renamed lead."
  emit_result "config_error"
  exit 1
fi

ALERT_CHANNEL=$(printf '%s' "$LEAD_CFG" | jq -r '.alertChannel // ""')
FALLBACK_TO_CORE=$(printf '%s' "$LEAD_CFG" | jq -r '.alertFallbackToCore')
GENERAL_CHANNEL=$(printf '%s' "$LEAD_CFG" | jq -r '.generalChannel // ""')
ALERT_BOT_TOKEN_ENV=$(printf '%s' "$LEAD_CFG" | jq -r '.alertBotTokenEnv // ""')
LEAD_BOT_TOKEN_ENV=$(printf '%s' "$LEAD_CFG" | jq -r '.botTokenEnv // ""')
fi # end projects.json resolution (skipped when unified channel + sender env set)

# Resolve channel: FLY-927 unified channel env wins; else
# alertChannel → generalChannel (if alertFallbackToCore) — the legacy path.
CHANNEL_ID=""
if [ -n "$UNIFIED_CHANNEL" ]; then
  CHANNEL_ID="$UNIFIED_CHANNEL"
elif [ -n "$ALERT_CHANNEL" ]; then
  CHANNEL_ID="$ALERT_CHANNEL"
elif [ "$FALLBACK_TO_CORE" = "true" ] && [ -n "$GENERAL_CHANNEL" ]; then
  CHANNEL_ID="$GENERAL_CHANNEL"
  log "WARNING: no alertChannel configured, falling back to generalChannel ($CHANNEL_ID)"
fi

# Resolve token: FLY-927 (D2) sender identity env wins — and when it is set but
# UNRESOLVABLE the script fail-closes into the no-token dead-letter below,
# deliberately NOT falling back to the per-lead token (gating semantics: better
# a dead-letter than an unauthorized sender). Else the legacy per-lead chain:
# alertBotTokenEnv → botTokenEnv (fallback warned once).
TOKEN=""
if [ -n "$SENDER_TOKEN_ENV" ]; then
  TOKEN="${!SENDER_TOKEN_ENV:-}"
  if [ -z "$TOKEN" ]; then
    log "ERROR: FLYWHEEL_ALERT_SENDER_TOKEN_ENV='$SENDER_TOKEN_ENV' does not resolve — refusing per-lead fallback"
  fi
else
  if [ -n "$ALERT_BOT_TOKEN_ENV" ]; then
    TOKEN="${!ALERT_BOT_TOKEN_ENV:-}"
  fi
  if [ -z "$TOKEN" ] && [ -n "$LEAD_BOT_TOKEN_ENV" ]; then
    TOKEN="${!LEAD_BOT_TOKEN_ENV:-}"
    if [ -n "$TOKEN" ]; then
      log "WARNING: alert token env '$ALERT_BOT_TOKEN_ENV' empty, using '$LEAD_BOT_TOKEN_ENV'"
    fi
  fi
fi

# ── Event ID (Fix 3: signature-based) ──────────────────────
# Formula: sha1(projectName|leadId|kind|signature).
# MUST match Bridge-side `computeEventId` in bridge/alert-kind-copy.ts (pipe
# separators, same field order, lowercase hex output) so cross-process
# dedup actually works.
#
# Default signature = today's date (UTC, YYYYMMDD). For crash-loop alerts
# this collapses repeated supervisor escalations within a day to one alert.
# Callers may pass --signature to mirror Bridge's pane-content-hash
# signature for kinds that have rich pane context (rare from shell side).
if [ -z "$SIGNATURE" ]; then
  SIGNATURE=$(LC_ALL=C date -u +%Y%m%d)
fi

EVENT_ID=$(LC_ALL=C printf '%s|%s|%s|%s' "$PROJECT_NAME" "$LEAD_ID" "$KIND" "$SIGNATURE" \
  | LC_ALL=C shasum -a 1 \
  | awk '{print $1}')
if [ -z "$EVENT_ID" ]; then
  log "ERROR: shasum failed to produce EVENT_ID (project=$PROJECT_NAME lead=$LEAD_ID kind=$KIND signature=$SIGNATURE)" >&2
  emit_result "config_error"
  exit 3
fi

# ── Cross-process claim + delivery lease via claims.db ───────────────────────
# alert_claims intentionally remains the shared four-column compatibility
# table. alert_deliveries is a companion receipt table: a bare claim never
# proves delivery, while sent/queued receipts do. A stale lease may be taken
# over, preserving at-least-once delivery if a process dies after claiming.
CLAIMS_DB="${FLYWHEEL_CLAIMS_DB:-${HOME}/.flywheel/alerts/claims.db}"
mkdir -p "$(dirname "$CLAIMS_DB")"

LEASE_SECONDS="${FLYWHEEL_ALERT_DELIVERY_LEASE_SECONDS:-60}"
case "$LEASE_SECONDS" in
  *[!0-9]*|'') LEASE_SECONDS=60 ;;
esac
if [ "$LEASE_SECONDS" -lt 1 ] || [ "$LEASE_SECONDS" -gt 3600 ]; then
  LEASE_SECONDS=60
fi
LEASE_NOW=$(date +%s)
LEASE_UNTIL=$((LEASE_NOW + LEASE_SECONDS))
LEASE_TOKEN="${LEASE_NOW}-$$-${RANDOM}"

CLAIM_SQL=$(cat <<SQL
.timeout 5000
CREATE TABLE IF NOT EXISTS alert_claims (
  event_id TEXT PRIMARY KEY,
  lead_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  claimed_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS alert_deliveries (
  event_id TEXT PRIMARY KEY,
  state TEXT NOT NULL CHECK (state IN ('leased','sent','queued','dead_lettered')),
  lease_token TEXT,
  lease_until INTEGER,
  attempt_count INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_error TEXT
);
BEGIN IMMEDIATE;
INSERT OR IGNORE INTO alert_claims VALUES ('${EVENT_ID}', '$(sql_quote "$LEAD_ID")', '${KIND}', strftime('%s','now'));
INSERT OR IGNORE INTO alert_deliveries
  (event_id, state, lease_token, lease_until, attempt_count, updated_at, last_error)
  VALUES ('${EVENT_ID}', 'leased', '${LEASE_TOKEN}', ${LEASE_UNTIL}, 1, ${LEASE_NOW}, NULL);
UPDATE alert_deliveries
   SET state='leased', lease_token='${LEASE_TOKEN}', lease_until=${LEASE_UNTIL},
       attempt_count=attempt_count+1, updated_at=${LEASE_NOW}, last_error=NULL
 WHERE event_id='${EVENT_ID}' AND state='leased'
   AND lease_until <= ${LEASE_NOW} AND lease_token <> '${LEASE_TOKEN}';
SELECT state || '|' || COALESCE(lease_token,'')
  FROM alert_deliveries WHERE event_id='${EVENT_ID}';
COMMIT;
SQL
)

DELIVERY_DB_OK=1
CLAIM_RESULT=$(sqlite3 "$CLAIMS_DB" <<<"$CLAIM_SQL" 2>&1) || {
  log "WARNING: sqlite3 delivery lease failed: $CLAIM_RESULT"
  # Fall through and try to deliver, but strict callers receive no positive
  # receipt and must retain/replay their outbox.
  DELIVERY_DB_OK=0
  CLAIM_RESULT="leased|${LEASE_TOKEN}"
}

# Last non-empty stdout line is the companion delivery state and lease owner.
DELIVERY_ROW=$(printf '%s\n' "$CLAIM_RESULT" | awk 'NF' | tail -n 1)
DELIVERY_STATE=${DELIVERY_ROW%%|*}
DELIVERY_TOKEN=${DELIVERY_ROW#*|}
case "$DELIVERY_STATE" in
  sent)
    log "delivery receipt already sent event_id=$EVENT_ID"
    emit_result "sent"
    exit 0
    ;;
  queued)
    log "delivery receipt already durably queued event_id=$EVENT_ID"
    emit_result "queued_transient"
    exit 2
    ;;
  dead_lettered)
    log "delivery receipt is dead-lettered event_id=$EVENT_ID"
    emit_result "dead_lettered"
    exit 2
    ;;
  leased)
    if [ "$DELIVERY_TOKEN" != "$LEASE_TOKEN" ]; then
      log "active delivery lease event_id=$EVENT_ID, skipping this attempt"
      emit_result "duplicate"
      exit 0
    fi
    ;;
  *)
    log "WARNING: invalid delivery receipt '$DELIVERY_ROW'; delivering without proof"
    DELIVERY_DB_OK=0
    ;;
esac

record_delivery() {
  # $1 = sent|queued|dead_lettered, $2 = optional reason
  local state="$1" reason="${2:-}" result changed
  [ "$DELIVERY_DB_OK" = "1" ] || return 1
  result=$(sqlite3 "$CLAIMS_DB" <<SQL 2>&1
.timeout 5000
BEGIN IMMEDIATE;
UPDATE alert_deliveries
   SET state='${state}', lease_token=NULL, lease_until=NULL,
       updated_at=strftime('%s','now'), last_error='$(sql_quote "$reason")'
 WHERE event_id='${EVENT_ID}' AND state='leased'
   AND lease_token='${LEASE_TOKEN}';
SELECT changes();
COMMIT;
SQL
  ) || {
    log "WARNING: failed to persist delivery receipt state=${state}: $result"
    return 1
  }
  changed=$(printf '%s\n' "$result" | awk 'NF' | tail -n 1)
  [ "$changed" = "1" ]
}

# ── Build Discord message payload ──────────────────────────
case "$SEVERITY" in
  severe)  EMOJI="🚨" ;;
  warning) EMOJI="⚠️" ;;
  info|*)  EMOJI="ℹ️" ;;
esac

if [ "$PLAIN_MESSAGE" = "1" ]; then
  CONTENT="$BODY"
else
  CONTENT=$(printf '%s **%s** (%s / %s)\n%s' "$EMOJI" "$TITLE" "$LEAD_ID" "$KIND" "$BODY")
fi
# FLY-927 (Task 1.7): 🎫 ticket header, SAME shape as the TS formatContent —
# in unified-channel mode. Shell side always renders
# `owner — · 状态 NEW` (owner @ is the Bridge's job; drain does not rewrite).
if [ "$PLAIN_MESSAGE" != "1" ] && [ -n "$UNIFIED_CHANNEL" ] && ! is_informational_kind "$KIND"; then
  CONTENT=$(printf '%s **%s** (%s / %s)\n🎫 %s · 首见 %s · owner — · 状态 NEW\n%s' \
    "$EMOJI" "$TITLE" "$LEAD_ID" "$KIND" "$PROJECT_NAME" "$(founder_ticket_clock)" "$BODY")
fi
# FLY-1081: explicit mention prefixes the content — Discord only truly pings an
# id that appears in BOTH the content and allowed_mentions.users (see BODY_JSON
# below). Applied after both content shapes so plain + 🎫 forms get it alike.
if [ -n "$MENTION_USER" ]; then
  CONTENT="<@${MENTION_USER}> ${CONTENT}"
fi

# Spill to queue for later drain. Keep fields aligned with LeadAlertNotifier.
# FLY-529: FLYWHEEL_ALERT_QUEUE_DIR isolates the QA Testing Room's shell-side
# alert queue to a slot-local dir so test alerts never land in the production
# queue the live Bridge drains. Unset → production default (byte-compat).
QUEUE_DIR="${FLYWHEEL_ALERT_QUEUE_DIR:-${HOME}/.flywheel/alert-queue}"
mkdir -p "$QUEUE_DIR"
# FLY-1081 (Codex R1#6): embed an EVENT_ID prefix so two same-second alerts with
# DIFFERENT signatures never overwrite each other's record. Consumers
# (drainQueue / operators) scan `*.json` and never parse the filename.
QUEUE_PATH="${QUEUE_DIR}/$(date -u +%Y%m%dT%H%M%SZ)-${LEAD_ID}-${KIND}-${EVENT_ID:0:12}.json"

write_record() {
  # $1 = target path, $2 = reason
  # FLY-1081: mentionUserId is OPTIONAL — the key is omitted entirely when no
  # (valid) --mention-user was passed, so pre-existing record shape is
  # byte-compatible. Drain re-posts carry the real ping (LeadAlertNotifier).
  # FLY-2051: the switch family carries its resolved primary channel through a
  # transient queue. Every other kind omits the key to retain its legacy shape.
  local mention_args=() mention_expr="" route_args=() route_expr="" style_args=() style_expr=""
  if [ -n "$MENTION_USER" ]; then
    mention_args=(--arg mentionUserId "$MENTION_USER")
    mention_expr=', mentionUserId: $mentionUserId'
  fi
  if is_quota_switch_kind "$KIND"; then
    route_args=(--arg deliveryChannelId "$CHANNEL_ID")
    route_expr=', deliveryChannelId: $deliveryChannelId'
  fi
  if [ "$PLAIN_MESSAGE" = "1" ]; then
    style_args=(--arg deliveryStyle "plain")
    style_expr=', deliveryStyle: $deliveryStyle'
  fi
  jq -n \
    --arg leadId "$LEAD_ID" \
    --arg projectName "$PROJECT_NAME" \
    --arg eventId "$EVENT_ID" \
    --arg eventType "$KIND" \
    --arg title "$TITLE" \
    --arg body "$BODY" \
    --arg severity "$SEVERITY" \
    --arg queuedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --arg queueReason "$2" \
    ${mention_args[@]+"${mention_args[@]}"} \
    ${route_args[@]+"${route_args[@]}"} \
    ${style_args[@]+"${style_args[@]}"} \
    "{leadId: \$leadId, projectName: \$projectName, eventId: \$eventId,
      eventType: \$eventType, title: \$title, body: \$body,
      severity: \$severity, queuedAt: \$queuedAt, queueReason: \$queueReason${mention_expr}${route_expr}${style_expr}}" \
    > "$1"
}

atomic_write_record() {
  # $1 = target path, $2 = reason. Same-directory 0600 temp + fsync + rename.
  local target="$1" reason="$2" tmp="${1}.tmp.$$"
  rm -f "$tmp"
  if ! (umask 077; write_record "$tmp" "$reason") \
    || ! chmod 600 "$tmp" \
    || ! node -e 'const fs=require("fs"); const fd=fs.openSync(process.argv[1],"r"); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }' "$tmp" \
    || ! mv "$tmp" "$target"; then
    rm -f "$tmp"
    return 1
  fi
}

enqueue() {
  if ! atomic_write_record "$QUEUE_PATH" "$1"; then
    log "ERROR: durable queue write failed for $QUEUE_PATH (reason=$1)"
    return 1
  fi
  log "queued to $QUEUE_PATH (reason=$1)"
}

# FLY-182 §4.5.1: PERMANENT failures (config gap, bad token, permanent 4xx)
# must NOT be queued for blind retry — that was the 1667-backlog root cause.
# Dead-letter (audit) + fire a Discord-INDEPENDENT meta-alert so the silent
# failure surfaces even when the Bridge is down.
DEAD_LETTER_DIR="${FLYWHEEL_ALERT_DEADLETTER_DIR:-${HOME}/.flywheel/alert-deadletter}"
dead_letter() {
  local reason="$1"
  mkdir -p "$DEAD_LETTER_DIR"
  # FLY-1081 (Codex R1#6): same EVENT_ID-suffixed shape as QUEUE_PATH.
  local dl_path="${DEAD_LETTER_DIR}/$(date -u +%Y%m%dT%H%M%SZ)-${LEAD_ID}-${KIND}-${EVENT_ID:0:12}.json"
  if atomic_write_record "$dl_path" "$reason"; then
    log "dead-lettered to $dl_path (reason=$reason)"
  else
    log "ERROR: dead-letter audit write failed for $dl_path (reason=$reason)"
  fi
  fire_meta_alert \
    "alert_dead_lettered" \
    "LeadAlert dropped (shell path)" \
    "Lead '${LEAD_ID}' alert dead-lettered (reason=${reason}, kind=${KIND}). Discord alert path misconfigured/down."
}

if [ -z "$CHANNEL_ID" ]; then
  dead_letter "no-channel"
  record_delivery "dead_lettered" "no-channel" || true
  emit_result "config_error"
  exit 2
fi
if [ -z "$TOKEN" ]; then
  dead_letter "no-token"
  record_delivery "dead_lettered" "no-token" || true
  emit_result "config_error"
  exit 2
fi

# ── FLY-927 (T1): per-minute rate approximation ─────────────
# When FLYWHEEL_ALERT_RATE_PER_MIN is set and this minute's shell-side counter
# is at the cap, skip the direct POST and queue the record — the Bridge drain
# delivers it under its own token bucket (dedup already done by claims.db).
# Unset ⇒ no counting, byte-compat.
RATE_LIMIT="${FLYWHEEL_ALERT_RATE_PER_MIN:-}"
if [ -n "$RATE_LIMIT" ]; then
  RATE_STAMP=$(date -u +%Y%m%d%H%M)
  RATE_FILE="${QUEUE_DIR}/.rate-${RATE_STAMP}"
  # Opportunistic cleanup of stale minute counters (queue drain ignores non-.json).
  find "$QUEUE_DIR" -maxdepth 1 -name '.rate-*' ! -name ".rate-${RATE_STAMP}" -delete 2>/dev/null || true
  RATE_COUNT=$(cat "$RATE_FILE" 2>/dev/null || echo 0)
  case "$RATE_COUNT" in (*[!0-9]*|'') RATE_COUNT=0 ;; esac
  if [ "$RATE_COUNT" -ge "$RATE_LIMIT" ] 2>/dev/null; then
    if enqueue "rate-limited"; then
      if record_delivery "queued" "rate-limited"; then
        emit_result "queued_transient"
      else
        emit_result "duplicate"
      fi
    else
      dead_letter "queue-write-failed"
      record_delivery "dead_lettered" "queue-write-failed" || true
      emit_result "dead_lettered"
    fi
    exit 2
  fi
  echo $((RATE_COUNT + 1)) > "$RATE_FILE"
fi

# ── POST to Discord ────────────────────────────────────────
# FLY-927 (Codex R1 #7): mentions fully suppressed on the shell path (content
# can carry ids/titles that Discord would otherwise resolve), and the bot token
# rides a curl stdin config (`-K -`) so it never appears in argv (FLY-510
# notion.sh precedent).
# FLY-1081: a validated --mention-user is the ONE explicit exception — only
# that id is whitelisted (`users: [id]`), everything else stays suppressed
# (keeps the FLY-927 R1#7 intent: suppress ACCIDENTAL ids, not explicit ones).
if [ -n "$MENTION_USER" ]; then
  BODY_JSON=$(jq -n --arg c "$CONTENT" --arg m "$MENTION_USER" \
    '{content: $c, allowed_mentions: {users: [$m]}}')
else
  BODY_JSON=$(jq -n --arg c "$CONTENT" '{content: $c, allowed_mentions: {parse: []}}')
fi
post_discord() {
  curl -s -o "/tmp/lead-alert-$$.out" -w '%{http_code}' \
    --max-time 15 \
    -X POST "https://discord.com/api/v10/channels/${CHANNEL_ID}/messages" \
    -H "Content-Type: application/json" \
    -d "$BODY_JSON" \
    -K - <<CURLCFG
header = "Authorization: Bot ${TOKEN}"
CURLCFG
}
# FLY-1577: `$(post_discord || echo 000)` CONCATENATED on real network failure.
# curl -w '%{http_code}' already prints `000` when the connection never lands,
# and it also exits non-zero (7 on connection-refused), so the `|| echo 000`
# appended a second one and HTTP_CODE became `000000`. That matches neither the
# `000` transient case below nor any 5xx, so a plain network blip was classified
# PERMANENT: dead-lettered instead of queued, and never retried once the network
# came back. The alert was durably recorded and durably never delivered.
# Normalize on the command's exit status instead of concatenating onto whatever
# it printed.
if ! HTTP_CODE=$(post_discord 2>/dev/null); then
  HTTP_CODE="000"
fi
case "$HTTP_CODE" in
  ''|*[!0-9]*) HTTP_CODE="000" ;;   # any non-numeric residue is a failed send
esac

if [ "$HTTP_CODE" -ge 200 ] && [ "$HTTP_CODE" -lt 300 ] 2>/dev/null; then
  rm -f /tmp/lead-alert-$$.out
  log "sent lead=$LEAD_ID kind=$KIND channel=$CHANNEL_ID (HTTP $HTTP_CODE)"
  if record_delivery "sent"; then
    emit_result "sent"
  else
    # POST may have landed, but without a durable receipt the daemon must keep
    # its outbox and replay. A duplicate post is preferable to silent loss.
    emit_result "duplicate"
  fi
  exit 0
fi

RESP_BODY=$(cat /tmp/lead-alert-$$.out 2>/dev/null || true)
rm -f /tmp/lead-alert-$$.out
log "Discord POST failed HTTP=$HTTP_CODE body=$RESP_BODY"

# Keep the claim — it marks "someone took responsibility for this eventId".
# Classify the failure (FLY-182 §4.2 parity with LeadAlertNotifier):
#   5xx / 429 / 000(network) → TRANSIENT → queue for Bridge drainQueue retry.
#   other 4xx (401/403/404 — bad token, forbidden, channel gone) → PERMANENT
#     → dead-letter + meta-alert (retry is pointless).
if [ "$HTTP_CODE" -ge 500 ] 2>/dev/null \
  || [ "$HTTP_CODE" = "429" ] || [ "$HTTP_CODE" = "000" ]; then
  if enqueue "discord-${HTTP_CODE}"; then
    if record_delivery "queued" "discord-${HTTP_CODE}"; then
      emit_result "queued_transient"
    else
      emit_result "duplicate"
    fi
  else
    dead_letter "queue-write-failed"
    record_delivery "dead_lettered" "queue-write-failed" || true
    emit_result "dead_lettered"
  fi
  exit 2
fi
dead_letter "discord-${HTTP_CODE}"
record_delivery "dead_lettered" "discord-${HTTP_CODE}" || true
emit_result "dead_lettered"
exit 2
