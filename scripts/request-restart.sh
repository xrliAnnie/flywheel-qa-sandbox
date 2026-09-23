#!/usr/bin/env bash
# FLY-2654: publish either the existing founder-direct emergency request or one
# verified Lead closeout request under the active standing carve-out through the detached
# updater. This command never restarts services itself and never claims that
# the asynchronous restart ended.
set -uo pipefail

rr_standing_package_reject() {
  printf '[request-restart] standing-package-verification-failed reason=%s\n' "$1" >&2
  return 78
}

rr_enter_active_package_for_standing_request() {
  local arg="" has_request=0
  for arg in "$@"; do
    [[ "$arg" != --request ]] || has_request=1
  done
  [[ "$has_request" == 1 ]] || return 0

  local state_root="${FLYWHEEL_STANDING_AUTHORITY_STATE_DIR:-${HOME}/.flywheel/state/standing-authority}"
  local pointer="${state_root}/active-package.json" root="" package_digest=""
  local manifest="" cli_rel="packages/teamlead/dist/bin/standing-authority-package-cli.js"
  local cli="" expected_cli_digest="" actual_cli_digest="" verified_digest="" entry=""
  local current_script="" current_root="" receipt="" ledger="" recorded_digest=""
  local node_bin="${REQUEST_RESTART_NODE:-node}"
  if [[ "${FLYWHEEL_STANDING_PACKAGE_ACTIVE:-0}" == 1 ]]; then
    [[ -f "$pointer" && ! -L "$pointer" ]] || return 78
    root="$(jq -er '.immutableRoot | select(type == "string" and startswith("/") and (contains("..") | not))' "$pointer" 2>/dev/null)" || return 78
    package_digest="$(jq -er '.packageDigest | select(test("^[a-f0-9]{64}$"))' "$pointer" 2>/dev/null)" || return 78
    # FLY-2654 review R7 round 2: the pointer is a request, not authority. Read
    # the Bridge confirmation ledger back (outside the candidate package) and
    # require the row for the pointer's receipt to bind this package digest.
    receipt="$(jq -er '.activatedByReceiptId | select(type == "string" and test("^[a-f0-9]{64}$"))' "$pointer" 2>/dev/null)" || {
        rr_standing_package_reject active-package-receipt-invalid
        return 78
    }
    ledger="${TEAMLEAD_DB_PATH:-${HOME}/.flywheel/teamlead.db}"
    if [[ ! -f "$ledger" || -L "$ledger" ]]; then
        rr_standing_package_reject confirmation-ledger-unavailable
        return 78
    fi
    # Plain open on purpose: the StateStore is WAL and a clean Bridge close removes
    # the -wal/-shm sidecars; the sqlite3 CLI in read-only mode cannot recreate
    # them and fails with SQLITE_CANTOPEN (14) exactly when the Bridge is down.
    # The statement is a SELECT; same-uid sidecar creation is what better-sqlite3
    # readers do too.
    recorded_digest="$(sqlite3 "$ledger" "SELECT package_digest FROM standing_authority_confirmation WHERE receipt_id = '${receipt}' LIMIT 1;" 2>/dev/null)" || {
        rr_standing_package_reject confirmation-ledger-unavailable
        return 78
    }
    if [[ -z "$recorded_digest" ]]; then
        rr_standing_package_reject confirmation-record-missing
        return 78
    fi
    if [[ "$recorded_digest" != "$package_digest" ]]; then
        rr_standing_package_reject confirmation-record-mismatch
        return 78
    fi
    current_script="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
    current_root="$(cd -P "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
    [[ "${FLYWHEEL_STANDING_PACKAGE_ROOT:-}" == "$root" ]] || return 78
    [[ "$current_root" == "$root" && "$current_script" == "$root/scripts/request-restart.sh" ]] || return 78
    return 0
  fi
  [[ -e "$pointer" ]] || return 0
  if [[ ! -f "$pointer" || -L "$pointer" ]]; then
    printf '[request-restart] active standing package pointer is not a regular file\n' >&2
    return 78
  fi
  root="$(jq -er '.immutableRoot | select(type == "string" and startswith("/") and (contains("..") | not))' "$pointer" 2>/dev/null)" || return 78
  package_digest="$(jq -er '.packageDigest | select(test("^[a-f0-9]{64}$"))' "$pointer" 2>/dev/null)" || return 78
  # FLY-2654 review R7 round 2: the pointer is a request, not authority. Read
  # the Bridge confirmation ledger back (outside the candidate package) and
  # require the row for the pointer's receipt to bind this package digest.
  receipt="$(jq -er '.activatedByReceiptId | select(type == "string" and test("^[a-f0-9]{64}$"))' "$pointer" 2>/dev/null)" || {
      rr_standing_package_reject active-package-receipt-invalid
      return 78
  }
  ledger="${TEAMLEAD_DB_PATH:-${HOME}/.flywheel/teamlead.db}"
  if [[ ! -f "$ledger" || -L "$ledger" ]]; then
      rr_standing_package_reject confirmation-ledger-unavailable
      return 78
  fi
  # Plain open on purpose: the StateStore is WAL and a clean Bridge close removes
  # the -wal/-shm sidecars; the sqlite3 CLI in read-only mode cannot recreate
  # them and fails with SQLITE_CANTOPEN (14) exactly when the Bridge is down.
  # The statement is a SELECT; same-uid sidecar creation is what better-sqlite3
  # readers do too.
  recorded_digest="$(sqlite3 "$ledger" "SELECT package_digest FROM standing_authority_confirmation WHERE receipt_id = '${receipt}' LIMIT 1;" 2>/dev/null)" || {
      rr_standing_package_reject confirmation-ledger-unavailable
      return 78
  }
  if [[ -z "$recorded_digest" ]]; then
      rr_standing_package_reject confirmation-record-missing
      return 78
  fi
  if [[ "$recorded_digest" != "$package_digest" ]]; then
      rr_standing_package_reject confirmation-record-mismatch
      return 78
  fi
  manifest="${root}/standing-authority-package.json"
  cli="${root}/${cli_rel}"
  [[ -f "$manifest" && ! -L "$manifest" && -f "$cli" && ! -L "$cli" ]] || return 78
  [[ "$(jq -r '.packageDigest // empty' "$manifest" 2>/dev/null)" == "$package_digest" ]] || return 78
  expected_cli_digest="$(jq -er --arg path "$cli_rel" '[.files[] | select(.path == $path) | .sha256] | select(length == 1) | .[0]' "$manifest" 2>/dev/null)" || return 78
  actual_cli_digest="$(shasum -a 256 "$cli" 2>/dev/null | awk 'NF == 2 {print $1}')"
  [[ "$actual_cli_digest" == "$expected_cli_digest" ]] || return 78
  verified_digest="$("$node_bin" "$cli" verify --root "$root" --manifest "$manifest" 2>/dev/null | jq -er '.packageDigest')" || return 78
  [[ "$verified_digest" == "$package_digest" ]] || return 78
  entry="$("$node_bin" "$cli" resolve --root "$root" --manifest "$manifest" --path scripts/request-restart.sh 2>/dev/null)" || return 78
  exec env \
    FLYWHEEL_STANDING_PACKAGE_ACTIVE=1 \
    FLYWHEEL_STANDING_PACKAGE_ROOT="$root" \
    FLYWHEEL_DIR="${FLYWHEEL_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}" \
    REQUEST_RESTART_CLI="$root/packages/teamlead/dist/bin/restart-request.js" \
    REQUEST_RESTART_BOUNDED_RUN="$root/scripts/lib/bounded-run.sh" \
    REQUEST_RESTART_ALERT_CMD="$root/scripts/lead-alert.sh" \
    bash "$entry" "$@"
}

rr_enter_active_package_for_standing_request "$@" || exit $?

_RR_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FLYWHEEL_DIR="${FLYWHEEL_DIR:-$(cd "${_RR_DIR}/.." && pwd)}"
: "${FLYWHEEL_HOME:=${HOME}/.flywheel}"
SELF_SHIP_URGENT_DIR="${SELF_SHIP_URGENT_DIR:-${FLYWHEEL_HOME}/self-ship-urgent.d}"
SELF_SHIP_LAUNCHCTL="${SELF_SHIP_LAUNCHCTL:-launchctl}"
SELF_SHIP_UPDATER_LABEL="${SELF_SHIP_UPDATER_LABEL:-com.flywheel.updater}"
REQUEST_RESTART_GIT="${REQUEST_RESTART_GIT:-git}"
REQUEST_RESTART_NODE="${REQUEST_RESTART_NODE:-node}"
REQUEST_RESTART_CLI="${REQUEST_RESTART_CLI:-${FLYWHEEL_DIR}/packages/teamlead/dist/bin/restart-request.js}"
REQUEST_RESTART_BOUNDED_RUN="${REQUEST_RESTART_BOUNDED_RUN:-${_RR_DIR}/lib/bounded-run.sh}"
REQUEST_RESTART_ALERT_CMD="${REQUEST_RESTART_ALERT_CMD:-${_RR_DIR}/lead-alert.sh}"
REQUEST_RESTART_REMOTE_TIMEOUT_SECONDS="${REQUEST_RESTART_REMOTE_TIMEOUT_SECONDS:-10}"
REQUEST_RESTART_DEPLOYED_SHA_FILE="${REQUEST_RESTART_DEPLOYED_SHA_FILE:-${FLYWHEEL_HOME}/deployed-sha}"
REQUEST_RESTART_SCOPE_ROOT="${REQUEST_RESTART_SCOPE_ROOT:-${FLYWHEEL_HOME}/state/restart-scope}"
RESTART_REQUEST_AUDIT_DIR="${RESTART_REQUEST_AUDIT_DIR:-${FLYWHEEL_HOME}/restart-request-audit}"
RESTART_REQUEST_INDEX="${RESTART_REQUEST_INDEX:-${FLYWHEEL_HOME}/restart-request-index.json}"
RESTART_WAVE_ACTIVE_TICKET="${RESTART_WAVE_ACTIVE_TICKET:-${FLYWHEEL_HOME}/restart-wave-active-ticket.json}"
RESTART_WAVE_REVOCATION_DIR="${RESTART_WAVE_REVOCATION_DIR:-${RESTART_REQUEST_AUDIT_DIR}/restart-wave-revocations}"
RESTART_WAVE_QUEUE_BASENAME=active-restart-wave.urgent.json
RR_CLOSEOUT_REJECTION_ARMED=0
RR_CLOSEOUT_REJECTION_DRY_RUN=0
RR_CLOSEOUT_REJECTION_REQUEST=""
RR_CLOSEOUT_REJECTION_DECISION=""
RR_CLOSEOUT_REJECTION_TARGET=""
RR_CLOSEOUT_REJECTION_REASON=""

rr_log() { printf '[request-restart] %s\n' "$*" >&2; }
rr_is_sha40() { [[ "${1:-}" =~ ^[0-9a-fA-F]{40}$ ]]; }

rr_remote_main_sha() {
  local output="" sha="" ref="" extra="" error_file="" error_line="" rc=0
  if [ ! -x "$REQUEST_RESTART_BOUNDED_RUN" ]; then
    rr_log "origin main lookup unavailable: bounded runner is not executable: $REQUEST_RESTART_BOUNDED_RUN"
    return 1
  fi
  error_file="$(mktemp "${TMPDIR:-/tmp}/flywheel-request-restart.XXXXXX")" || {
    rr_log "origin main lookup unavailable: could not allocate a diagnostic file"
    return 1
  }
  output="$(GIT_TERMINAL_PROMPT=0 \
    "$REQUEST_RESTART_BOUNDED_RUN" "$REQUEST_RESTART_REMOTE_TIMEOUT_SECONDS" \
    "$REQUEST_RESTART_GIT" -C "$FLYWHEEL_DIR" ls-remote origin refs/heads/main \
    2>"$error_file")" || rc=$?
  while IFS= read -r error_line; do
    [ -z "$error_line" ] || rr_log "origin main lookup: $error_line"
  done < "$error_file"
  rm -f "$error_file"
  if [ "$rc" -ne 0 ]; then
    rr_log "origin main lookup command failed (rc=$rc)"
    return 1
  fi
  [[ -n "$output" && "$output" != *$'\n'* ]] || return 1
  IFS=$'\t' read -r sha ref extra <<< "$output"
  [[ -z "$extra" && "$ref" == refs/heads/main ]] || return 1
  rr_is_sha40 "$sha" || return 1
  printf '%s\n' "$sha"
}

rr_local_main_sha() {
  local sha=""
  sha="$("$REQUEST_RESTART_GIT" -C "$FLYWHEEL_DIR" rev-parse origin/main 2>/dev/null)" \
    || return 1
  rr_is_sha40 "$sha" || return 1
  printf '%s\n' "$sha"
}

rr_updater_loaded() {
  local target="gui/$(id -u)/${SELF_SHIP_UPDATER_LABEL}"
  "$SELF_SHIP_LAUNCHCTL" print "$target" >/dev/null 2>&1
}

rr_updater_enabled() {
  local domain="gui/$(id -u)" output="" line=""
  output="$("$SELF_SHIP_LAUNCHCTL" print-disabled "$domain" 2>/dev/null)" || return 1
  line="$(printf '%s\n' "$output" | grep -F "\"${SELF_SHIP_UPDATER_LABEL}\"" | tail -1)"
  if [[ -z "$line" ]]; then return 0; fi
  case "$line" in
    *'=> true'*|*'=> disabled'*) return 1 ;;
    *'=> false'*|*'=> enabled'*) return 0 ;;
    *) return 1 ;;
  esac
}

rr_read_exact_sha() {
  local path="$1" sha="" extra=""
  [[ -f "$path" && ! -L "$path" ]] || return 1
  IFS= read -r sha < "$path" || return 1
  extra="$(sed -n '2p' "$path")"
  [[ -z "$extra" ]] || return 1
  rr_is_sha40 "$sha" || return 1
  printf '%s\n' "$sha"
}

rr_write_audit() {
  local ticket="$1" request_id="$2" final="" tmp=""
  mkdir -p "$RESTART_REQUEST_AUDIT_DIR" || return 1
  [[ ! -L "$RESTART_REQUEST_AUDIT_DIR" ]] || return 1
  chmod 700 "$RESTART_REQUEST_AUDIT_DIR" || return 1
  final="${RESTART_REQUEST_AUDIT_DIR}/${request_id}.prepared.json"
  if [[ -e "$final" ]]; then
    [[ -f "$final" && ! -L "$final" ]] || return 1
    cmp -s "$ticket" "$final" || return 1
    printf '%s\n' "$final"
    return 0
  fi
  tmp="$(mktemp "${RESTART_REQUEST_AUDIT_DIR}/.prepared.XXXXXX")" || return 1
  if ! cp "$ticket" "$tmp" || ! chmod 600 "$tmp" || ! mv "$tmp" "$final"; then
    rm -f "$tmp"
    return 1
  fi
  printf '%s\n' "$final"
}

rr_prepare_ticket() {
  local request="$1" remote="$2" deployed="$3" pre_merge="$4"
  "$REQUEST_RESTART_NODE" "$REQUEST_RESTART_CLI" prepare \
    --request "$request" \
    --home "$HOME" \
    --scope-root "$REQUEST_RESTART_SCOPE_ROOT" \
    --deployed-sha "$deployed" \
    --remote-sha "$remote" \
    --pre-merge-head "$pre_merge" \
    --contains-trigger
}

rr_mark_prepared() {
  local ticket="$1" created_at="$2"
  "$REQUEST_RESTART_NODE" "$REQUEST_RESTART_CLI" transition \
    --ticket "$ticket" \
    --index "$RESTART_REQUEST_INDEX" \
    --state prepared \
    --at "$created_at" \
    --zero-side-effects >/dev/null
}

rr_mark_revoked() {
  local ticket="$1"
  "$REQUEST_RESTART_NODE" "$REQUEST_RESTART_CLI" transition \
    --ticket "$ticket" \
    --index "$RESTART_REQUEST_INDEX" \
    --state revoked \
    --at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >/dev/null
}

rr_ticket_kind() {
  jq -er '
    if .schemaVersion == 1 and .kind == "founder-urgent-restart" then .kind
    elif .schemaVersion == 2 and .kind == "authorized-urgent-restart" then .kind
    elif .schemaVersion == 3 and .kind == "lead-closeout-restart" then .kind
    else empty end
  ' "$1" 2>/dev/null
}

rr_ticket_target() {
  jq -er '.targetSha | select(type == "string" and test("^[0-9a-f]{40}$"))' "$1" 2>/dev/null
}

rr_ticket_request_id() {
  jq -c 'if .schemaVersion == 3 then .decisionId elif .schemaVersion == 2 then .requestId else null end' "$1" 2>/dev/null
}

rr_find_active_ticket() {
  local path="" claim_dir=""
  if [[ -f "$RESTART_WAVE_ACTIVE_TICKET" && ! -L "$RESTART_WAVE_ACTIVE_TICKET" ]]; then
    printf '%s\n' "$RESTART_WAVE_ACTIVE_TICKET"
    return 0
  fi
  for path in "$SELF_SHIP_URGENT_DIR"/*.urgent.json; do
    [[ -f "$path" && ! -L "$path" ]] || continue
    printf '%s\n' "$path"
    return 0
  done
  # Queue entries only move in this direction. Scanning the watched queue
  # before claim directories leaves no rename gap in which an active wave can
  # be mistaken for an empty lifecycle.
  for claim_dir in "$FLYWHEEL_HOME"/.urgent-claim.*; do
    [[ -d "$claim_dir" && ! -L "$claim_dir" ]] || continue
    for path in "$claim_dir"/*.urgent.json; do
      [[ -f "$path" && ! -L "$path" ]] || continue
      printf '%s\n' "$path"
      return 0
    done
  done
  return 1
}

rr_write_duplicate_audit() {
  local proposed="$1" active="$2" dir="" tmp="" now=""
  local proposed_kind="" proposed_target="" proposed_id=""
  local active_kind="" active_target="" active_id=""
  proposed_kind="$(rr_ticket_kind "$proposed")" || return 1
  proposed_target="$(rr_ticket_target "$proposed")" || return 1
  proposed_id="$(rr_ticket_request_id "$proposed")" || return 1
  active_kind="$(rr_ticket_kind "$active")" || return 1
  active_target="$(rr_ticket_target "$active")" || return 1
  active_id="$(rr_ticket_request_id "$active")" || return 1
  dir="${RESTART_REQUEST_AUDIT_DIR}/restart-wave-duplicates"
  mkdir -p "$dir" || return 1
  [[ ! -L "$dir" ]] || return 1
  chmod 700 "$dir" || return 1
  tmp="$(mktemp "${dir}/.duplicate.XXXXXX")" || return 1
  now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  if ! jq -n \
      --arg occurredAt "$now" \
      --arg proposedKind "$proposed_kind" \
      --arg proposedTargetSha "$proposed_target" \
      --argjson proposedRequestId "$proposed_id" \
      --arg activeKind "$active_kind" \
      --arg activeTargetSha "$active_target" \
      --argjson activeRequestId "$active_id" \
      '{schemaVersion:1,event:"restart-wave-duplicate",result:"deduplicated-existing-ticket",occurredAt:$occurredAt,proposed:{kind:$proposedKind,targetSha:$proposedTargetSha,requestId:$proposedRequestId},active:{kind:$activeKind,targetSha:$activeTargetSha,requestId:$activeRequestId}}' \
      > "$tmp"; then
    rm -f "$tmp"
    return 1
  fi
  chmod 600 "$tmp" || { rm -f "$tmp"; return 1; }
  mv "$tmp" "${dir}/duplicate.$(date +%s).$$.${RANDOM}.json"
}

rr_machine_result() {
  local result="$1" ticket="${2:-}" queue="${3:-}"
  jq -nc --arg result "$result" --arg ticket "$ticket" --arg queueEntry "$queue" \
    '{result:$result,ticket:(if $ticket == "" then null else $ticket end),queueEntry:(if $queueEntry == "" then null else $queueEntry end)}'
}

rr_claim_wave() {
  local ticket="$1" active=""
  if active="$(rr_find_active_ticket)"; then
    RR_EXISTING_ACTIVE_TICKET="$active"
    return 10
  fi
  mkdir -p "$FLYWHEEL_HOME" || return 1
  [[ ! -L "$FLYWHEEL_HOME" ]] || return 1
  chmod 700 "$FLYWHEEL_HOME" || return 1
  if ln "$ticket" "$RESTART_WAVE_ACTIVE_TICKET" 2>/dev/null; then
    chmod 600 "$RESTART_WAVE_ACTIVE_TICKET" || {
      rm -f "$RESTART_WAVE_ACTIVE_TICKET"
      return 1
    }
    return 0
  fi
  active="$(rr_find_active_ticket)" || return 1
  RR_EXISTING_ACTIVE_TICKET="$active"
  return 10
}

rr_release_wave() {
  local ticket="$1"
  if [[ -f "$RESTART_WAVE_ACTIVE_TICKET" ]] \
    && cmp -s "$ticket" "$RESTART_WAVE_ACTIVE_TICKET"; then
    rm -f "$RESTART_WAVE_ACTIVE_TICKET"
  fi
}

rr_deduplicate_wave() {
  local proposed="$1" active="$2"
  if ! rr_write_duplicate_audit "$proposed" "$active"; then
    rr_log "FATAL: active restart wave exists, but duplicate audit could not be written"
    return 1
  fi
  rr_log "已有一轮紧急重启处于 pending/active；本次请求已合并，不会创建第二轮。"
  rr_machine_result deduplicated-existing-ticket "$active"
}

rr_write_founder_direct_audit() {
  local sha="$1" now="" tmp="" final=""
  now="$(date +%s)"
  mkdir -p "$RESTART_REQUEST_AUDIT_DIR" || return 1
  [[ ! -L "$RESTART_REQUEST_AUDIT_DIR" ]] || return 1
  chmod 700 "$RESTART_REQUEST_AUDIT_DIR" || return 1
  tmp="$(mktemp "${RESTART_REQUEST_AUDIT_DIR}/.founder-direct.XXXXXX")" || return 1
  if ! jq -n --arg sha "$sha" --argjson now "$now" \
      '{schemaVersion:1,kind:"founder-urgent-restart",targetSha:$sha,createdAt:$now}' \
      > "$tmp"; then
    rm -f "$tmp"
    return 1
  fi
  chmod 600 "$tmp" || { rm -f "$tmp"; return 1; }
  final="${RESTART_REQUEST_AUDIT_DIR}/founder-direct.${sha}.${now}.$$-${RANDOM}.prepared.json"
  mv "$tmp" "$final" || { rm -f "$tmp"; return 1; }
  printf '%s\n' "$final"
}

rr_write_closeout_rejection() {
  local request="$1" decision_id="$2" target_sha="$3" reason="$4"
  local dir="" tmp="" final="" now="" now_epoch="" request_digest="" intent_ref="null" audit_id=""
  [[ -f "$request" && ! -L "$request" ]] || return 1
  request_digest="$(rr_ticket_fingerprint "$request")" || return 1
  intent_ref="$(jq -c '
    .intent.messageRef |
    select(.channelId | type == "string") |
    select(.messageId | type == "string") |
    {channelId,messageId}' "$request" 2>/dev/null)" || intent_ref="null"
  now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  now_epoch="$(date +%s)"
  audit_id="closeout-rejection:${decision_id}:${now_epoch}:$$:${RANDOM}"
  dir="${RESTART_REQUEST_AUDIT_DIR}/closeout-rejections"
  mkdir -p "$dir" || return 1
  [[ ! -L "$dir" ]] || return 1
  chmod 700 "$dir" || return 1
  tmp="$(mktemp "${dir}/.rejection.XXXXXX")" || return 1
  if ! jq -n \
      --arg auditId "$audit_id" --arg occurredAt "$now" --argjson rejectedAtEpoch "$now_epoch" \
      --arg decisionId "$decision_id" --arg targetSha "$target_sha" --arg reason "$reason" \
      --arg requestDigest "$request_digest" --argjson intentRef "$intent_ref" \
      '{schemaVersion:1,event:"lead-closeout-restart-rejected",auditId:$auditId,occurredAt:$occurredAt,rejectedAtEpoch:$rejectedAtEpoch,decisionId:$decisionId,targetSha:(if $targetSha == "" then null else $targetSha end),reason:$reason,requestDigest:$requestDigest,intentRef:$intentRef}' \
      > "$tmp"; then
    rm -f "$tmp"
    return 1
  fi
  chmod 600 "$tmp" || { rm -f "$tmp"; return 1; }
  final="${dir}/rejection.${now_epoch}.$$-${RANDOM}.json"
  mv "$tmp" "$final" || { rm -f "$tmp"; return 1; }
  printf '%s\n' "$final"
}

rr_write_possible_closeout_fallback() {
  local founder_audit="$1" target_sha="$2" dir="" rejection_dir="" path="" latest=""
  local latest_epoch=0 rejected_at=0 now=0 age=0 tmp="" final="" rejection_digest=""
  [[ -f "$founder_audit" && ! -L "$founder_audit" ]] || return 1
  rejection_dir="${RESTART_REQUEST_AUDIT_DIR}/closeout-rejections"
  [[ -d "$rejection_dir" && ! -L "$rejection_dir" ]] || return 0
  now="$(date +%s)"
  for path in "$rejection_dir"/*.json; do
    [[ -f "$path" && ! -L "$path" ]] || continue
    rejected_at="$(jq -er '.rejectedAtEpoch | select(type == "number" and floor == .)' "$path" 2>/dev/null)" || continue
    [[ "$rejected_at" =~ ^[0-9]{10}$ ]] || continue
    age=$((now - rejected_at))
    if (( age >= 0 && age <= 1800 && rejected_at >= latest_epoch )); then
      latest="$path"
      latest_epoch="$rejected_at"
    fi
  done
  [[ -n "$latest" ]] || return 0
  rejection_digest="$(rr_ticket_fingerprint "$latest")" || return 1
  dir="${RESTART_REQUEST_AUDIT_DIR}/possible-closeout-fallback"
  mkdir -p "$dir" || return 1
  [[ ! -L "$dir" ]] || return 1
  chmod 700 "$dir" || return 1
  tmp="$(mktemp "${dir}/.fallback.XXXXXX")" || return 1
  if ! jq -n \
      --arg occurredAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg targetSha "$target_sha" \
      --arg founderDirectAudit "$founder_audit" --arg rejectionDigest "$rejection_digest" \
      --slurpfile rejection "$latest" \
      '{schemaVersion:1,event:"possible-closeout-fallback",occurredAt:$occurredAt,targetSha:$targetSha,linkedRejection:{auditId:$rejection[0].auditId,decisionId:$rejection[0].decisionId,reason:$rejection[0].reason,occurredAt:$rejection[0].occurredAt,digest:$rejectionDigest},founderDirectTicketAudit:$founderDirectAudit,singleAuthorizationRef:null,anomaly:"missing-single-authorization-reference"}' \
      > "$tmp"; then
    rm -f "$tmp"
    return 1
  fi
  chmod 600 "$tmp" || { rm -f "$tmp"; return 1; }
  final="${dir}/fallback.${now}.$$-${RANDOM}.json"
  mv "$tmp" "$final" || { rm -f "$tmp"; return 1; }
  printf '%s\n' "$final"
}

rr_alert_possible_closeout_fallback() {
  local receipt="$1" decision_id="" audit_id=""
  [[ -x "$REQUEST_RESTART_ALERT_CMD" && ! -L "$REQUEST_RESTART_ALERT_CMD" ]] || return 1
  decision_id="$(jq -er '.linkedRejection.decisionId' "$receipt" 2>/dev/null)" || return 1
  audit_id="$(jq -er '.linkedRejection.auditId' "$receipt" 2>/dev/null)" || return 1
  "$REQUEST_RESTART_ALERT_CMD" \
    --project flywheel --lead updater \
    --kind deploy_degraded --severity warning \
    --title "Possible closeout restart fallback" \
    --body "A bare founder-direct restart followed rejected closeout decision ${decision_id} within 30 minutes without an explicit single-authorization reference. Audit ${audit_id}; inspect the fallback receipt before treating the v1 ticket as AUTH-CANON(A)." \
    --signature "possible-closeout-fallback-${audit_id}" >/dev/null 2>&1 || return 1
}

rr_publish_urgent_token() {
  local ticket="$1" sha="$2" request_id="$3" final=""
  [[ -f "$ticket" && ! -L "$ticket" ]] || return 64
  rr_is_sha40 "$sha" || return 64
  [[ -z "$request_id" || "$request_id" =~ ^[0-9a-fA-F-]{36}$ ]] || return 64
  mkdir -p "$FLYWHEEL_HOME" "$SELF_SHIP_URGENT_DIR" || return 1
  [[ ! -L "$FLYWHEEL_HOME" && ! -L "$SELF_SHIP_URGENT_DIR" ]] || return 1
  chmod 700 "$FLYWHEEL_HOME" "$SELF_SHIP_URGENT_DIR" || return 1
  final="${SELF_SHIP_URGENT_DIR}/${RESTART_WAVE_QUEUE_BASENAME}"
  [[ -f "$RESTART_WAVE_ACTIVE_TICKET" ]] || return 1
  [[ ! -e "$final" ]] || return 1
  ln "$RESTART_WAVE_ACTIVE_TICKET" "$final" || return 1
  printf '%s\n' "$final"
}

rr_ticket_fingerprint() {
  shasum -a 256 "$1" | awk '{print $1}'
}

rr_find_matching_claim() {
  local ticket="$1" claim_dir="" path=""
  for claim_dir in "$FLYWHEEL_HOME"/.urgent-claim.*; do
    [[ -d "$claim_dir" && ! -L "$claim_dir" ]] || continue
    for path in "$claim_dir"/*.urgent.json; do
      [[ -f "$path" && ! -L "$path" ]] || continue
      if cmp -s "$ticket" "$path"; then
        printf '%s\n' "$path"
        return 0
      fi
    done
  done
  return 1
}

rr_write_revocation_audit() {
  local ticket="$1" result="$2" deterministic="${3:-0}"
  local fingerprint="" target="" kind="" request_id="" now="" tmp="" final=""
  fingerprint="$(rr_ticket_fingerprint "$ticket")" || return 1
  target="$(rr_ticket_target "$ticket")" || return 1
  kind="$(rr_ticket_kind "$ticket")" || return 1
  request_id="$(rr_ticket_request_id "$ticket")" || return 1
  mkdir -p "$RESTART_WAVE_REVOCATION_DIR" || return 1
  [[ ! -L "$RESTART_WAVE_REVOCATION_DIR" ]] || return 1
  chmod 700 "$RESTART_WAVE_REVOCATION_DIR" || return 1
  now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  if [[ "$deterministic" == 1 ]]; then
    final="${RESTART_WAVE_REVOCATION_DIR}/${fingerprint}.revoked.json"
    [[ ! -e "$final" ]] || { printf '%s\n' "$final"; return 0; }
  else
    final="${RESTART_WAVE_REVOCATION_DIR}/${fingerprint}.${result}.$(date +%s).$$.${RANDOM}.json"
  fi
  tmp="$(mktemp "${RESTART_WAVE_REVOCATION_DIR}/.revocation.XXXXXX")" || return 1
  if ! jq -n \
      --arg occurredAt "$now" --arg result "$result" --arg fingerprint "$fingerprint" \
      --arg kind "$kind" --arg targetSha "$target" --argjson requestId "$request_id" \
      '{schemaVersion:1,event:"restart-wave-revocation",result:$result,occurredAt:$occurredAt,ticketFingerprint:$fingerprint,ticket:{kind:$kind,targetSha:$targetSha,requestId:$requestId}}' \
      > "$tmp"; then
    rm -f "$tmp"
    return 1
  fi
  chmod 600 "$tmp" || { rm -f "$tmp"; return 1; }
  mv "$tmp" "$final" || { rm -f "$tmp"; return 1; }
  printf '%s\n' "$final"
}

rr_revoke_ticket() {
  local ticket="$1" kind="" fingerprint="" receipt="" queue="" claim=""
  local quarantine="" claimed=""
  if [[ "$ticket" != /* || ! -f "$ticket" || -L "$ticket" ]]; then
    rr_log "restart-request-evidence-required: --revoke --request needs one absolute regular prepared ticket"
    return 64
  fi
  kind="$(rr_ticket_kind "$ticket")" || {
    rr_log "restart-request-evidence-required: revoke input is not a supported restart ticket"
    return 64
  }
  rr_ticket_target "$ticket" >/dev/null || return 64
  fingerprint="$(rr_ticket_fingerprint "$ticket")" || return 1
  receipt="${RESTART_WAVE_REVOCATION_DIR}/${fingerprint}.revoked.json"
  if [[ -f "$receipt" && ! -L "$receipt" ]]; then
    rr_log "该紧急票已经在起飞前撤销；重复撤销保持幂等。"
    rr_machine_result already-revoked "$ticket"
    return 0
  fi

  queue="${SELF_SHIP_URGENT_DIR}/${RESTART_WAVE_QUEUE_BASENAME}"
  if [[ -f "$queue" && ! -L "$queue" ]] && cmp -s "$ticket" "$queue"; then
    quarantine="$(mktemp -d "${FLYWHEEL_HOME}/.restart-revoke.XXXXXX")" || return 1
    claimed="${quarantine}/${RESTART_WAVE_QUEUE_BASENAME}"
    if ! mv "$queue" "$claimed"; then
      rmdir "$quarantine" 2>/dev/null || true
      claimed=""
    fi
  fi
  if [[ -z "$claimed" ]]; then
    claim="$(rr_find_matching_claim "$ticket")" || claim=""
    if [[ -n "$claim" ]]; then
      rr_write_revocation_audit "$ticket" too-late-wave-started >/dev/null || true
      rr_log "撤销来不及：updater 已经 claim 此票，重启波可能正在执行。"
      rr_machine_result too-late-wave-started "$ticket" "$claim"
      return 75
    fi
    if [[ -f "$RESTART_WAVE_ACTIVE_TICKET" ]] \
      && cmp -s "$ticket" "$RESTART_WAVE_ACTIVE_TICKET"; then
      # The producer may have established the lifecycle marker just before
      # queue publication. With no queue and no claim this is still pre-start.
      claimed="$ticket"
    else
      rr_log "FATAL: ticket is not the pending or active restart wave"
      rr_machine_result ticket-not-active "$ticket"
      return 69
    fi
  fi

  if [[ "$kind" == authorized-urgent-restart || "$kind" == lead-closeout-restart ]]; then
    if ! rr_mark_revoked "$claimed"; then
      rr_log "FATAL: restart intent could not enter revoked; queue entry stays quarantined and cannot execute"
      return 1
    fi
  fi
  if ! rr_write_revocation_audit "$claimed" revoked-before-start 1 >/dev/null; then
    rr_log "FATAL: restart was stopped, but its revocation audit could not be persisted"
    return 1
  fi
  rr_release_wave "$claimed"
  if [[ -n "$quarantine" ]]; then
    rm -f "$claimed"
    rmdir "$quarantine" 2>/dev/null || true
  fi
  rr_log "紧急票已在 updater 起飞前撤销；未执行重启。"
  rr_machine_result revoked-before-start "$ticket"
  return 0
}

rr_kickstart_updater() {
  local target="gui/$(id -u)/${SELF_SHIP_UPDATER_LABEL}"
  "$SELF_SHIP_LAUNCHCTL" kickstart "$target" >/dev/null 2>&1
}

rr_main() {
  local dry_run=0 revoke=0 request="" target_sha="" from_sha="" trigger_sha=""
  local remote_sha="" deployed_sha="" pre_merge_head="" request_id=""
  local created_at="" ticket_tmp="" audit="" token="" claim_rc=0 fallback_audit=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --dry-run) dry_run=1; shift ;;
      --revoke) revoke=1; shift ;;
      --request)
        [[ $# -ge 2 && -n "$2" ]] || {
          rr_log "restart-request-evidence-required: --request needs one absolute JSON path"
          return 64
        }
        request="$2"
        shift 2
        ;;
      *) rr_log "unknown arg '$1'"; return 64 ;;
    esac
  done

  if (( revoke == 1 )); then
    if (( dry_run == 1 )) || [[ -z "$request" ]]; then
      rr_log "restart-request-evidence-required: --revoke requires --request <absolute prepared ticket> and cannot be combined with --dry-run"
      return 64
    fi
    rr_revoke_ticket "$request"
    return $?
  fi

  if [[ -z "$request" ]]; then
    if ! target_sha="$(rr_remote_main_sha)"; then
      rr_log "WARNING: origin main lookup failed or returned an invalid shape; falling back to the validated local origin/main ref"
      if ! target_sha="$(rr_local_main_sha)"; then
        rr_log "FATAL: neither remote main nor local origin/main produced one 40-hex SHA"
        return 69
      fi
    fi
    if (( dry_run == 1 )); then
      rr_log "DRY RUN: would publish one founder urgent token for ${target_sha} and nudge ${SELF_SHIP_UPDATER_LABEL}; no repository, queue, or Flywheel state was written"
      return 0
    fi
    if ! rr_updater_loaded; then
      rr_log "FATAL: updater '$SELF_SHIP_UPDATER_LABEL' is not loaded; refusing to publish an unconsumable urgent request"
      return 69
    fi
    if ! rr_updater_enabled; then
      rr_log "FATAL: updater '$SELF_SHIP_UPDATER_LABEL' is disabled or its enabled state is unreadable; refusing urgent request"
      return 69
    fi
    if ! audit="$(rr_write_founder_direct_audit "$target_sha")"; then
      rr_log "FATAL: founder urgent ticket audit publication failed; updater was not kickstarted"
      return 1
    fi
    if ! fallback_audit="$(rr_write_possible_closeout_fallback "$audit" "$target_sha")"; then
      rr_log "FATAL: possible-closeout-fallback audit failed; updater was not kickstarted"
      return 1
    fi
    if [[ -n "$fallback_audit" ]]; then
      rr_log "WARNING possible-closeout-fallback: a bare founder-direct ticket followed a rejected closeout request within 30 minutes; no single authorization reference was supplied. Audit: $fallback_audit"
      if ! rr_alert_possible_closeout_fallback "$fallback_audit"; then
        rr_log "FATAL: possible-closeout-fallback Lead alert failed; updater was not kickstarted"
        return 1
      fi
    fi
    RR_EXISTING_ACTIVE_TICKET=""
    rr_claim_wave "$audit"
    claim_rc=$?
    if (( claim_rc == 10 )); then
      rr_deduplicate_wave "$audit" "$RR_EXISTING_ACTIVE_TICKET"
      return $?
    fi
    if (( claim_rc != 0 )); then
      rr_log "FATAL: global restart-wave admission failed; updater was not kickstarted"
      return 1
    fi
    if ! token="$(rr_publish_urgent_token "$audit" "$target_sha" "")"; then
      rr_release_wave "$audit"
      rr_log "FATAL: founder urgent token publication failed; updater was not kickstarted"
      return 1
    fi
    if ! rr_kickstart_updater; then
      rr_log "FATAL: kickstart failed after durable token publication. The token remains at $token; do not submit blindly. Check /tmp/flywheel-updater.log before deciding whether another票 is needed."
      return 69
    fi
    rr_log "已受理 founder 直接紧急票: updater 将收敛 origin/main 后执行一次全量重启。这里不代表重启完成；完成以 updater 日志和 reason=updater 的播报为准。"
    rr_machine_result accepted "$audit" "$token"
    return 0
  fi

  if [[ "$request" != /* || ! -f "$request" || -L "$request" ]]; then
    rr_log "restart-request-evidence-required: pass --request with one absolute regular JSON file"
    return 64
  fi
  jq -e '
    .schemaVersion == 3 and .kind == "lead-closeout-restart" and
    .authority.kind == "standing-carve-out" and
    .authority.entryId == "lead-closeout-restart/v1"
  ' "$request" >/dev/null 2>&1 || {
    rr_log "retired-conditional-authority: --request accepts only lead-closeout-restart/v3"
    return 64
  }
  request_id="$(jq -er '.decisionId | select(type == "string")' "$request" 2>/dev/null)" || {
    rr_log "restart-request-evidence-required: decisionId missing"
    return 64
  }
  RR_CLOSEOUT_REJECTION_ARMED=1
  RR_CLOSEOUT_REJECTION_DRY_RUN="$dry_run"
  RR_CLOSEOUT_REJECTION_REQUEST="$request"
  RR_CLOSEOUT_REJECTION_DECISION="$request_id"
  RR_CLOSEOUT_REJECTION_REASON="request-evidence-invalid"
  target_sha="$(jq -er '.targetSha | select(type == "string")' "$request" 2>/dev/null)" || {
    RR_CLOSEOUT_REJECTION_REASON="target-sha-invalid"
    return 64
  }
  RR_CLOSEOUT_REJECTION_TARGET="$target_sha"
  from_sha="$(jq -er '.fromDeployedSha | select(type == "string")' "$request" 2>/dev/null)" || {
    RR_CLOSEOUT_REJECTION_REASON="from-deployed-sha-invalid"
    return 64
  }
  trigger_sha="$target_sha"
  created_at="$(jq -er '.createdAt | select(type == "string")' "$request" 2>/dev/null)" || {
    RR_CLOSEOUT_REJECTION_REASON="created-at-invalid"
    return 64
  }
  rr_is_sha40 "$target_sha" && rr_is_sha40 "$from_sha" && rr_is_sha40 "$trigger_sha" || {
    rr_log "restart-request-evidence-required: version evidence invalid"
    RR_CLOSEOUT_REJECTION_REASON="version-evidence-invalid"
    return 64
  }
  if ! remote_sha="$(rr_remote_main_sha)"; then
    rr_log "FATAL: fresh origin/main lookup failed; refusing to fall back to a local ref"
    RR_CLOSEOUT_REJECTION_REASON="remote-main-unavailable"
    return 69
  fi
  [[ "$remote_sha" == "$target_sha" ]] || {
    rr_log "FATAL: targetSha no longer equals fresh origin/main"
    RR_CLOSEOUT_REJECTION_REASON="target-main-drift"
    return 69
  }
  deployed_sha="$(rr_read_exact_sha "$REQUEST_RESTART_DEPLOYED_SHA_FILE")" || {
    rr_log "FATAL: deployed-sha is missing or invalid"
    RR_CLOSEOUT_REJECTION_REASON="deployed-sha-unavailable"
    return 69
  }
  [[ "$deployed_sha" == "$from_sha" ]] || {
    rr_log "FATAL: fromDeployedSha no longer matches deployed-sha"
    RR_CLOSEOUT_REJECTION_REASON="deployed-sha-drift"
    return 69
  }
  pre_merge_head="$("$REQUEST_RESTART_GIT" -C "$FLYWHEEL_DIR" rev-parse HEAD 2>/dev/null)" || {
    rr_log "FATAL: current checkout HEAD is unavailable"
    RR_CLOSEOUT_REJECTION_REASON="checkout-head-unavailable"
    return 69
  }
  rr_is_sha40 "$pre_merge_head" || {
    RR_CLOSEOUT_REJECTION_REASON="checkout-head-invalid"
    return 69
  }
  "$REQUEST_RESTART_GIT" -C "$FLYWHEEL_DIR" cat-file -e "${trigger_sha}^{commit}" 2>/dev/null \
    && "$REQUEST_RESTART_GIT" -C "$FLYWHEEL_DIR" merge-base --is-ancestor "$trigger_sha" "$target_sha" 2>/dev/null || {
      rr_log "FATAL: trigger fix is not proven inside targetSha"
      RR_CLOSEOUT_REJECTION_REASON="trigger-not-in-target"
      return 69
    }

  if (( dry_run == 0 )); then
    if ! rr_updater_loaded; then
      rr_log "FATAL: updater '$SELF_SHIP_UPDATER_LABEL' is not loaded; refusing to publish an unconsumable urgent request"
      RR_CLOSEOUT_REJECTION_REASON="updater-not-loaded"
      return 69
    fi
    if ! rr_updater_enabled; then
      rr_log "FATAL: updater '$SELF_SHIP_UPDATER_LABEL' is disabled or its enabled state is unreadable; refusing urgent request"
      RR_CLOSEOUT_REJECTION_REASON="updater-not-enabled"
      return 69
    fi
  fi

  ticket_tmp="$(mktemp "${TMPDIR:-/tmp}/flywheel-restart-ticket.XXXXXX")" || return 1
  chmod 600 "$ticket_tmp" || { rm -f "$ticket_tmp"; return 1; }
  if ! rr_prepare_ticket "$request" "$remote_sha" "$deployed_sha" "$pre_merge_head" > "$ticket_tmp"; then
    rm -f "$ticket_tmp"
    rr_log "FATAL: restart request evidence verification failed"
    RR_CLOSEOUT_REJECTION_REASON="evidence-verification-failed"
    return 69
  fi
  jq -e --arg request_id "$request_id" --arg target "$target_sha" \
    '.schemaVersion == 3 and .kind == "lead-closeout-restart" and
     .authority.kind == "standing-carve-out" and
     .authority.entryId == "lead-closeout-restart/v1" and
     .decisionId == $request_id and
     .targetSha == $target and (.requestDigest | test("^[0-9a-f]{64}$"))' \
    "$ticket_tmp" >/dev/null 2>&1 || {
      rm -f "$ticket_tmp"
      rr_log "FATAL: verifier returned an invalid ticket"
      RR_CLOSEOUT_REJECTION_REASON="verifier-ticket-invalid"
      return 69
    }

  if (( dry_run == 1 )); then
    rm -f "$ticket_tmp"
    RR_CLOSEOUT_REJECTION_ARMED=0
    rr_log "DRY RUN: verified one Lead closeout request under standing authority for $target_sha; no audit, index, queue, repository, channel, launchd, or service state was written"
    return 0
  fi

  if ! audit="$(rr_write_audit "$ticket_tmp" "$request_id")"; then
    rm -f "$ticket_tmp"
    rr_log "FATAL: prepared request audit publication failed"
    RR_CLOSEOUT_REJECTION_REASON="prepared-audit-publication-failed"
    return 1
  fi
  rm -f "$ticket_tmp"
  RR_EXISTING_ACTIVE_TICKET=""
  rr_claim_wave "$audit"
  claim_rc=$?
  if (( claim_rc == 10 )); then
    RR_CLOSEOUT_REJECTION_ARMED=0
    rr_deduplicate_wave "$audit" "$RR_EXISTING_ACTIVE_TICKET"
    return $?
  fi
  if (( claim_rc != 0 )); then
    rr_log "FATAL: global restart-wave admission failed; no queue entry was published"
    RR_CLOSEOUT_REJECTION_REASON="restart-wave-admission-failed"
    return 1
  fi
  if ! rr_mark_prepared "$audit" "$created_at"; then
    rr_release_wave "$audit"
    rr_log "FATAL: one-use restart intent could not be recorded; no queue entry was published"
    RR_CLOSEOUT_REJECTION_REASON="intent-index-publication-failed"
    return 1
  fi
  if ! token="$(rr_publish_urgent_token "$audit" "$target_sha" "$request_id")"; then
    rr_release_wave "$audit"
    rr_log "FATAL: urgent token publication failed; updater was not kickstarted"
    RR_CLOSEOUT_REJECTION_REASON="queue-publication-failed"
    return 1
  fi
  RR_CLOSEOUT_REJECTION_ARMED=0
  if ! rr_kickstart_updater; then
    rr_log "FATAL: kickstart failed after durable token publication. The token remains at $token; do not submit blindly. Check /tmp/flywheel-updater.log before deciding whether another票 is needed."
    return 69
  fi
  rr_log "已受理 Lead 收尾重启票（standing carve-out）: updater 将在最终停服闸门重新核验冻结 targetSha、在飞体快照与执行包。这里不代表重启完成；完成以 updater 日志和 reason=updater 的播报为准。"
  rr_machine_result accepted "$audit" "$token"
  return 0
}

rr_execute() {
  local rc=0 rejection_audit=""
  rr_main "$@" || rc=$?
  if (( rc != 0 && RR_CLOSEOUT_REJECTION_ARMED == 1 && RR_CLOSEOUT_REJECTION_DRY_RUN == 0 )); then
    if ! rejection_audit="$(rr_write_closeout_rejection \
        "$RR_CLOSEOUT_REJECTION_REQUEST" \
        "$RR_CLOSEOUT_REJECTION_DECISION" \
        "$RR_CLOSEOUT_REJECTION_TARGET" \
        "$RR_CLOSEOUT_REJECTION_REASON")"; then
      rr_log "FATAL: rejected closeout request could not be audited"
      return 1
    fi
    rr_log "Lead closeout request rejection audited: $rejection_audit"
  fi
  return "$rc"
}

if [[ "${REQUEST_RESTART_SOURCED:-0}" != 1 ]]; then
  rr_execute "$@"
  exit $?
fi
