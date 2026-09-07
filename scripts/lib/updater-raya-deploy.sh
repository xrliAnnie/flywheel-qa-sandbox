#!/usr/bin/env bash
# FLY-2385: source-only Raya deployment transaction for the existing updater.
# The caller owns the updater singleton. This library owns a narrower Raya lock
# and never installs or unloads launchd jobs.

RAYA_BRAIN_LABEL="com.xrli.raya.brain"
RAYA_VOICE_LABEL="com.xrli.raya.voice"
RAYA_SESSION_GRACE_SECONDS="${RAYA_SESSION_GRACE_SECONDS:-600}"
RAYA_SESSION_POLL_SECONDS="${RAYA_SESSION_POLL_SECONDS:-30}"
RAYA_HEALTH_TRIES="${RAYA_HEALTH_TRIES:-30}"
RAYA_HEALTH_INTERVAL_SECONDS="${RAYA_HEALTH_INTERVAL_SECONDS:-2}"
RAYA_FETCH_TIMEOUT_SECONDS="${RAYA_FETCH_TIMEOUT_SECONDS:-20}"
RAYA_INSTALL_TIMEOUT_SECONDS="${RAYA_INSTALL_TIMEOUT_SECONDS:-600}"
RAYA_BUILD_TIMEOUT_SECONDS="${RAYA_BUILD_TIMEOUT_SECONDS:-600}"

RAYA_LOCK_OWNED="${RAYA_LOCK_OWNED:-0}"
RAYA_LOCK_FAILURE="${RAYA_LOCK_FAILURE:-}"
RAYA_DEPLOY_STATE="${RAYA_DEPLOY_STATE:-not_run}"
RAYA_DEPLOY_DETAIL="${RAYA_DEPLOY_DETAIL:-}"
RAYA_CHECKOUT_BEFORE="${RAYA_CHECKOUT_BEFORE:-}"
RAYA_TARGET="${RAYA_TARGET:-}"
RAYA_NEW_HEAD="${RAYA_NEW_HEAD:-}"
RAYA_ROLLBACK_SHA="${RAYA_ROLLBACK_SHA:-}"
RAYA_LEDGER_STATE="${RAYA_LEDGER_STATE:-}"
RAYA_IDENTITY="${RAYA_IDENTITY:-}"
RAYA_NODE_BIN="${RAYA_NODE_BIN:-}"
RAYA_SESSION_GRACE="${RAYA_SESSION_GRACE:-}"
RAYA_SESSION_AT_CUTOVER="${RAYA_SESSION_AT_CUTOVER:-}"
RAYA_INTERRUPT_NOTICE="${RAYA_INTERRUPT_NOTICE:-}"
RAYA_PREFLIGHT_RC="${RAYA_PREFLIGHT_RC:-}"
RAYA_BRAIN_BEFORE_PID="${RAYA_BRAIN_BEFORE_PID:-}"
RAYA_BRAIN_BEFORE_START="${RAYA_BRAIN_BEFORE_START:-}"
RAYA_BRAIN_CUTOVER_PID="${RAYA_BRAIN_CUTOVER_PID:-}"
RAYA_BRAIN_AFTER_PID="${RAYA_BRAIN_AFTER_PID:-}"
RAYA_VOICE_BEFORE_PID="${RAYA_VOICE_BEFORE_PID:-}"
RAYA_VOICE_BEFORE_START="${RAYA_VOICE_BEFORE_START:-}"
RAYA_VOICE_CUTOVER_PID="${RAYA_VOICE_CUTOVER_PID:-}"
RAYA_VOICE_AFTER_PID="${RAYA_VOICE_AFTER_PID:-}"
RAYA_VOICE_RESULT="${RAYA_VOICE_RESULT:-}"
RAYA_GENERATION_BRAIN="${RAYA_GENERATION_BRAIN:-}"
RAYA_GENERATION_VOICE="${RAYA_GENERATION_VOICE:-}"
RAYA_FAILURE_CLASS="${RAYA_FAILURE_CLASS:-}"

raya_configure_runtime_paths() {
  local base="${FLYWHEEL_HOME:-${HOME}/.flywheel}"
  if [[ "${UPDATE_FLYWHEEL_SOURCED:-0}" == 1 ]]; then
    : "${RAYA_HOME:=${base}/raya}"
    : "${RAYA_CODE_DIR:=${RAYA_HOME}/code}"
    : "${RAYA_STATE_DIR:=${RAYA_HOME}/data/state}"
    : "${RAYA_METRICS_DIR:=${RAYA_HOME}/data/metrics}"
    : "${RAYA_DEPLOYED_SHA_FILE:=${RAYA_HOME}/deployed-sha}"
    : "${RAYA_DEPLOY_RECEIPT:=${RAYA_HOME}/deploy-receipt.json}"
    : "${RAYA_DEPLOY_LOCK_DIR:=${RAYA_HOME}/deploy.lock.d}"
    : "${RAYA_BRAIN_PID_FILE:=${RAYA_METRICS_DIR}/run/brain.pid}"
    : "${RAYA_VOICE_PID_FILE:=${RAYA_METRICS_DIR}/run/voice.pid}"
    : "${RAYA_PLIST_DIR:=${HOME}/Library/LaunchAgents}"
    return
  fi
  RAYA_HOME="${base}/raya"
  RAYA_CODE_DIR="${RAYA_HOME}/code"
  RAYA_STATE_DIR="${RAYA_HOME}/data/state"
  RAYA_METRICS_DIR="${RAYA_HOME}/data/metrics"
  RAYA_DEPLOYED_SHA_FILE="${RAYA_HOME}/deployed-sha"
  RAYA_DEPLOY_RECEIPT="${RAYA_HOME}/deploy-receipt.json"
  RAYA_DEPLOY_LOCK_DIR="${RAYA_HOME}/deploy.lock.d"
  RAYA_BRAIN_PID_FILE="${RAYA_METRICS_DIR}/run/brain.pid"
  RAYA_VOICE_PID_FILE="${RAYA_METRICS_DIR}/run/voice.pid"
  RAYA_PLIST_DIR="${HOME}/Library/LaunchAgents"
}

raya_log() {
  if declare -F log >/dev/null 2>&1; then
    log "raya: $*"
  else
    printf '[flywheel-updater] raya: %s\n' "$*"
  fi
}

raya_is_sha40() { [[ "${1:-}" =~ ^[0-9a-fA-F]{40}$ ]]; }
raya_is_pid() { [[ "${1:-}" =~ ^[1-9][0-9]*$ ]]; }
raya_host_capable() { [[ -f "$RAYA_PLIST_DIR/$RAYA_BRAIN_LABEL.plist" ]]; }
raya_now() { date +%s; }
raya_sleep() { sleep "$1"; }
raya_git() { git -C "$RAYA_CODE_DIR" "$@"; }
raya_git_fetch_bounded() {
  local runner="${UPDATER_BOUNDED_RUN:-${SCRIPT_DIR:-}/lib/bounded-run.sh}"
  [[ -x "$runner" ]] || return 127
  GIT_TERMINAL_PROMPT=0 "$runner" "$RAYA_FETCH_TIMEOUT_SECONDS" \
    git -C "$RAYA_CODE_DIR" fetch origin \
    '+refs/heads/main:refs/remotes/origin/main' --quiet 2>/dev/null
}
raya_run_bounded_in_checkout() {
  local timeout_seconds="$1" runner="${UPDATER_BOUNDED_RUN:-${SCRIPT_DIR:-}/lib/bounded-run.sh}"
  shift
  [[ -x "$runner" ]] || return 127
  (cd "$RAYA_CODE_DIR" && "$runner" "$timeout_seconds" "$@")
}
raya_pnpm_install() { raya_run_bounded_in_checkout "$RAYA_INSTALL_TIMEOUT_SECONDS" pnpm install --frozen-lockfile; }
raya_pnpm_build() { raya_run_bounded_in_checkout "$RAYA_BUILD_TIMEOUT_SECONDS" pnpm build; }
raya_preflight() {
  local runner="${UPDATER_BOUNDED_RUN:-${SCRIPT_DIR:-}/lib/bounded-run.sh}"
  [[ -x "$runner" && -x "$RAYA_NODE_BIN" ]] || return 127
  RAYA_ENV_FILE="${RAYA_HOME}/raya.env" "$runner" 120 \
    "$RAYA_NODE_BIN" "$RAYA_CODE_DIR/apps/brain/dist/cli.js" preflight
}
raya_launchd_print() { launchctl print "gui/$(id -u)/$1" 2>/dev/null; }
raya_plist_program_arguments() {
  plutil -extract ProgramArguments json -o - "$RAYA_PLIST_DIR/$1.plist" 2>/dev/null
}
raya_kickstart() { launchctl kickstart -k "gui/$(id -u)/$1"; }
raya_process_start() {
  LC_ALL=C ps -o lstart= -p "$1" 2>/dev/null \
    | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//'
}
raya_alert() {
  if declare -F raya_alert_dispatch >/dev/null 2>&1; then
    raya_alert_dispatch "$@"
  else
    raya_log "$1 $2: $4"
  fi
}
raya_notify_interruption() {
  local new8="$1" channel="" payload="" token="${CLAUDE_INFRA_BOT_TOKEN:-}" rc=0
  channel="$(raya_env_single_value RAYA_DISCORD_TEXT_CHANNEL_ID 2>/dev/null || true)"
  [[ "$channel" =~ ^[A-Za-z0-9_-]+$ && -n "$token" ]] || return 1
  case "$token" in
    *$'\n'*|*$'\r'*|*'"'*|*\\*) return 1 ;;
  esac
  payload="$(jq -nc --arg content "🔄 Flywheel 班车正在重启 Raya（部署 ${new8}），当前语音/会议会话会中断，抱歉。" \
    '{content:$content}')" || return 1
  printf 'header = "Authorization: Bot %s"\n' "$token" \
    | curl -sf -X POST "https://discord.com/api/v10/channels/${channel}/messages" \
      -H 'Content-Type: application/json' -d "$payload" --max-time 5 -K - >/dev/null || rc=$?
  return "$rc"
}

raya_lock_clear() {
  rm -f "$RAYA_DEPLOY_LOCK_DIR/pid" "$RAYA_DEPLOY_LOCK_DIR/start" \
    "$RAYA_DEPLOY_LOCK_DIR/created" 2>/dev/null || true
  rmdir "$RAYA_DEPLOY_LOCK_DIR" 2>/dev/null
}

raya_lock_write_owner() {
  local start=""
  start="$(raya_process_start "$$" 2>/dev/null || true)"
  [[ -n "$start" ]] || return 1
  printf '%s\n' "$$" > "$RAYA_DEPLOY_LOCK_DIR/pid" || return 1
  printf '%s\n' "$start" > "$RAYA_DEPLOY_LOCK_DIR/start" || return 1
  raya_now > "$RAYA_DEPLOY_LOCK_DIR/created" || return 1
}

raya_lock_acquire() {
  local owner="" recorded="" actual="" stale=0
  RAYA_LOCK_FAILURE=""
  mkdir -p "$RAYA_HOME" || { RAYA_LOCK_FAILURE=home; return 75; }
  if mkdir "$RAYA_DEPLOY_LOCK_DIR" 2>/dev/null; then
    if raya_lock_write_owner; then RAYA_LOCK_OWNED=1; return 0; fi
    raya_lock_clear || true
    RAYA_LOCK_FAILURE=state
    return 75
  fi
  owner="$(sed -n '1p' "$RAYA_DEPLOY_LOCK_DIR/pid" 2>/dev/null || true)"
  recorded="$(sed -n '1p' "$RAYA_DEPLOY_LOCK_DIR/start" 2>/dev/null || true)"
  if ! raya_is_pid "$owner" || ! kill -0 "$owner" 2>/dev/null; then
    stale=1
  else
    actual="$(raya_process_start "$owner" 2>/dev/null || true)"
    if [[ -n "$actual" && "$actual" != "$recorded" ]]; then stale=1; fi
  fi
  if (( stale == 1 )); then
    raya_log "reclaiming stale deploy lock owner=${owner:-unknown}"
    raya_lock_clear || return 75
    if mkdir "$RAYA_DEPLOY_LOCK_DIR" 2>/dev/null && raya_lock_write_owner; then
      RAYA_LOCK_OWNED=1
      return 0
    fi
    raya_lock_clear || true
    RAYA_LOCK_FAILURE=state
    return 75
  fi
  RAYA_LOCK_FAILURE=live
  return 75
}

raya_lock_release() {
  local owner=""
  owner="$(sed -n '1p' "$RAYA_DEPLOY_LOCK_DIR/pid" 2>/dev/null || true)"
  if [[ "$RAYA_LOCK_OWNED" == 1 && "$owner" == "$$" ]]; then raya_lock_clear || true; fi
  RAYA_LOCK_OWNED=0
}

raya_launchd_value() {
  local text="$1" key="$2"
  printf '%s\n' "$text" | awk -v key="$key" '
    index($0, key " = ") == 1 || index($0, "\t" key " = ") == 1 {
      sub("^.*" key " = ", ""); print; exit
    }
  '
}

raya_launchd_env_value() {
  local text="$1" key="$2"
  printf '%s\n' "$text" | awk -v key="$key" '
    /^[[:space:]]*environment = \{/ { inside=1; next }
    inside && /^[[:space:]]*\}/ { exit }
    inside {
      line=$0
      sub(/^[[:space:]]+/, "", line)
      if (index(line, key " => ") == 1) {
        sub("^" key " => ", "", line)
        print line
        exit
      }
    }
  '
}

raya_launchd_arguments() {
  printf '%s\n' "$1" | awk '
    /^[[:space:]]*arguments = \{/ { inside=1; next }
    inside && /^[[:space:]]*\}/ { exit }
    inside { gsub(/^[[:space:]]+|[[:space:]]+$/, ""); print }
  '
}

RAYA_OBS_STATE=""
RAYA_OBS_PID=""
RAYA_OBS_START=""
raya_observe_job() {
  local label="$1" text="" state="" pid="" start=""
  text="$(raya_launchd_print "$label" 2>/dev/null)" || return 1
  state="$(raya_launchd_value "$text" state)"
  pid="$(raya_launchd_value "$text" pid)"
  RAYA_OBS_STATE="$state" RAYA_OBS_PID="" RAYA_OBS_START=""
  if [[ "$state" == running ]]; then
    raya_is_pid "$pid" || return 2
    start="$(raya_process_start "$pid" 2>/dev/null || true)"
    RAYA_OBS_PID="$pid" RAYA_OBS_START="$start"
  fi
}

raya_env_single_value() {
  local key="$1" file="$RAYA_HOME/raya.env" count="" value=""
  [[ -f "$file" ]] || return 1
  count="$(grep -c "^${key}=" "$file" 2>/dev/null || true)"
  [[ "$count" == 1 ]] || return 1
  value="$(grep "^${key}=" "$file" | sed -n '1s/^[^=]*=//p')"
  printf '%s\n' "$value"
}

raya_validate_launchd_identity() {
  local label="" app="" text="" program="" cwd="" env_file="" args="" plist=""
  local arg0="" arg1="" arg2="" arg3="" first_program="" value="" observe_rc=0
  RAYA_IDENTITY=""
  for label in "$RAYA_BRAIN_LABEL" "$RAYA_VOICE_LABEL"; do
    [[ "$label" == "$RAYA_BRAIN_LABEL" ]] && app=brain || app=voice
    text="$(raya_launchd_print "$label" 2>/dev/null)" || {
      RAYA_IDENTITY="drift:$label"; RAYA_DEPLOY_DETAIL="$label:not-loaded"; return 1;
    }
    program="$(raya_launchd_value "$text" program)"
    cwd="$(raya_launchd_value "$text" 'working directory')"
    env_file="$(raya_launchd_env_value "$text" RAYA_ENV_FILE)"
    args="$(raya_launchd_arguments "$text")"
    arg0="$(printf '%s\n' "$args" | sed -n '1p')"
    arg1="$(printf '%s\n' "$args" | sed -n '2p')"
    arg2="$(printf '%s\n' "$args" | sed -n '3p')"
    arg3="$(printf '%s\n' "$args" | sed -n '4p')"
    plist="$(raya_plist_program_arguments "$label" 2>/dev/null)" || plist=""
    if [[ -z "$program" || ! -x "$program" || "$program" != "$arg0" \
      || -n "$arg3" || "$arg1" != "$RAYA_CODE_DIR/apps/$app/dist/cli.js" \
      || "$arg2" != run || "$cwd" != "$RAYA_CODE_DIR" \
      || "$env_file" != "$RAYA_HOME/raya.env" ]] \
      || ! jq -e --arg p "$program" --arg e "$RAYA_CODE_DIR/apps/$app/dist/cli.js" \
        '. == [$p,$e,"run"]' <<< "$plist" >/dev/null 2>&1; then
      RAYA_IDENTITY="drift:$label"
      RAYA_DEPLOY_DETAIL="$label:argv-or-path-mismatch"
      return 1
    fi
    if [[ -z "$first_program" ]]; then first_program="$program"; elif [[ "$program" != "$first_program" ]]; then
      RAYA_IDENTITY="drift:$label"; RAYA_DEPLOY_DETAIL="$label:program-mismatch"; return 1
    fi
    raya_observe_job "$label"
    observe_rc=$?
    if (( observe_rc != 0 )); then
      if (( observe_rc == 2 )); then
        RAYA_IDENTITY="observe_failed:$label"; RAYA_DEPLOY_DETAIL="$label:running-without-pid"; return 2
      fi
      RAYA_IDENTITY="drift:$label"; RAYA_DEPLOY_DETAIL="$label:unreadable"; return 1
    fi
  done
  value="$(raya_env_single_value RAYA_HOME 2>/dev/null || true)"
  [[ "$value" == "$RAYA_HOME" ]] || { RAYA_IDENTITY="drift:raya.env"; RAYA_DEPLOY_DETAIL="raya.env:RAYA_HOME"; return 1; }
  value="$(raya_env_single_value RAYA_METRICS_DIR 2>/dev/null || true)"
  [[ "$value" == "$RAYA_METRICS_DIR" ]] || { RAYA_IDENTITY="drift:raya.env"; RAYA_DEPLOY_DETAIL="raya.env:RAYA_METRICS_DIR"; return 1; }
  if grep -q '^RAYA_STATE_DIR=' "$RAYA_HOME/raya.env" 2>/dev/null; then
    value="$(raya_env_single_value RAYA_STATE_DIR 2>/dev/null || true)"
    [[ "$value" == "$RAYA_STATE_DIR" ]] || { RAYA_IDENTITY="drift:raya.env"; RAYA_DEPLOY_DETAIL="raya.env:RAYA_STATE_DIR"; return 1; }
  fi
  RAYA_NODE_BIN="$first_program"
  RAYA_IDENTITY=ok
}

RAYA_ASSERT_DETAIL=""
raya_assert_checkout() {
  local expected="$1" branch="" status="" head=""
  branch="$(raya_git symbolic-ref --short HEAD 2>/dev/null || true)"
  [[ "$branch" == main ]] || { RAYA_ASSERT_DETAIL="branch:${branch:-detached}"; return 1; }
  status="$(raya_git status --porcelain --untracked-files=no 2>/dev/null)" || {
    RAYA_ASSERT_DETAIL="status-unreadable"; return 1;
  }
  [[ -z "$status" ]] || { RAYA_ASSERT_DETAIL="tracked-dirty"; return 1; }
  head="$(raya_git rev-parse HEAD 2>/dev/null || true)"
  [[ "$head" == "$expected" ]] || { RAYA_ASSERT_DETAIL="head:${head:-unreadable}"; return 1; }
  RAYA_ASSERT_DETAIL=ok
}

raya_session_active() {
  local meeting="$RAYA_STATE_DIR/meeting.json" state="" observe_rc=0
  [[ ! -e "$RAYA_STATE_DIR/voice-mode.requested" ]] || return 0
  if [[ -e "$meeting" ]]; then
    jq -e '.status | type == "string"' "$meeting" >/dev/null 2>&1 || return 2
    if jq -e '.status | IN("starting","live","interrupted")' "$meeting" >/dev/null 2>&1; then return 0; fi
  fi
  raya_observe_job "$RAYA_VOICE_LABEL"
  observe_rc=$?
  if (( observe_rc != 0 )); then
    (( observe_rc != 2 )) || return 2
    return 2
  fi
  [[ "$RAYA_OBS_STATE" != running ]] || return 0
  return 1
}

raya_wait_for_session() {
  local elapsed=0 rc=0
  RAYA_SESSION_GRACE=none
  raya_session_active; rc=$?
  (( rc != 2 )) || return 2
  (( rc == 0 )) || return 0
  while (( elapsed < RAYA_SESSION_GRACE_SECONDS )); do
    raya_sleep "$RAYA_SESSION_POLL_SECONDS"
    elapsed=$((elapsed + RAYA_SESSION_POLL_SECONDS))
    raya_session_active; rc=$?
    (( rc != 2 )) || return 2
    if (( rc != 0 )); then RAYA_SESSION_GRACE="waited:$elapsed"; return 0; fi
  done
  RAYA_SESSION_GRACE="exhausted:${RAYA_SESSION_GRACE_SECONDS}"
}

raya_capture_generation() {
  if ! raya_observe_job "$RAYA_BRAIN_LABEL"; then return 1; fi
  RAYA_BRAIN_BEFORE_PID="$RAYA_OBS_PID" RAYA_BRAIN_BEFORE_START="$RAYA_OBS_START"
  if [[ "$RAYA_OBS_STATE" == running && -z "$RAYA_OBS_START" ]]; then return 1; fi
  if ! raya_observe_job "$RAYA_VOICE_LABEL"; then return 1; fi
  RAYA_VOICE_BEFORE_PID="$RAYA_OBS_PID" RAYA_VOICE_BEFORE_START="$RAYA_OBS_START"
  if [[ "$RAYA_OBS_STATE" == running && -z "$RAYA_OBS_START" ]]; then return 1; fi
}

raya_wait_for_replacement() {
  local app="$1" before="$2" label="$RAYA_BRAIN_LABEL" pidfile="$RAYA_BRAIN_PID_FILE"
  local i=1 last="" stable=0 file_pid=""
  if [[ "$app" == voice ]]; then label="$RAYA_VOICE_LABEL"; pidfile="$RAYA_VOICE_PID_FILE"; fi
  while (( i <= RAYA_HEALTH_TRIES )); do
    if raya_observe_job "$label" && [[ "$RAYA_OBS_STATE" == running ]] && raya_is_pid "$RAYA_OBS_PID"; then
      file_pid="$(sed -n '1p' "$pidfile" 2>/dev/null || true)"
      if [[ "$file_pid" == "$RAYA_OBS_PID" && ( -z "$before" || "$RAYA_OBS_PID" != "$before" ) ]]; then
        if [[ "$last" == "$RAYA_OBS_PID" ]]; then stable=$((stable + 1)); else stable=1; fi
        last="$RAYA_OBS_PID"
        if (( stable >= 2 )); then
          [[ "$app" == brain ]] && RAYA_BRAIN_AFTER_PID="$RAYA_OBS_PID" || RAYA_VOICE_AFTER_PID="$RAYA_OBS_PID"
          return 0
        fi
      else
        stable=0
        last=""
      fi
    else
      stable=0
      last=""
    fi
    (( i < RAYA_HEALTH_TRIES )) && raya_sleep "$RAYA_HEALTH_INTERVAL_SECONDS"
    i=$((i + 1))
  done
  return 1
}

raya_previous_deployed_sha() {
  local value=""
  value="$(jq -r '.deployed_sha // empty' "$RAYA_DEPLOY_RECEIPT" 2>/dev/null || true)"
  if ! raya_is_sha40 "$value"; then
    value="$(sed -n '1{s/^[[:space:]]*//;s/[[:space:]]*$//;p;}' \
      "$RAYA_DEPLOYED_SHA_FILE" 2>/dev/null || true)"
  fi
  raya_is_sha40 "$value" && printf '%s\n' "$value"
}

raya_receipt_outcome() {
  case "$1" in
    current|deployed|rolled_back) printf '%s\n' "$1" ;;
    failed|rollback_blocked_mutation) printf 'failed\n' ;;
    *) printf 'refused\n' ;;
  esac
}

raya_write_receipt() {
  local state="$1" detail="$2" outcome="" deployed="" failure="null" generation="null"
  local tmp="${RAYA_DEPLOY_RECEIPT}.tmp.$$" now=""
  outcome="$(raya_receipt_outcome "$state")"
  now="$(raya_now)" || return 1
  case "$state" in
    deployed) deployed="$RAYA_NEW_HEAD" ;;
    current) deployed="$RAYA_TARGET" ;;
    rolled_back) deployed="$RAYA_ROLLBACK_SHA" ;;
    *) deployed="$(raya_previous_deployed_sha || true)" ;;
  esac
  [[ "$outcome" == current || "$outcome" == deployed ]] || failure="$(jq -Rn --arg v "$detail" '$v')"
  if [[ "$state" == rolled_back && -n "$RAYA_GENERATION_BRAIN" && -n "$RAYA_GENERATION_VOICE" ]]; then
    generation="$(jq -nc --arg b "$RAYA_GENERATION_BRAIN" --arg v "$RAYA_GENERATION_VOICE" '{brain:$b,voice:$v}')"
  fi
  mkdir -p "$(dirname "$RAYA_DEPLOY_RECEIPT")" || return 1
  jq -n \
    --argjson checked "$now" --arg outcome "$outcome" --arg state "$state" \
    --argjson failure "$failure" --arg checkout "$RAYA_CHECKOUT_BEFORE" \
    --arg head "$(raya_git rev-parse HEAD 2>/dev/null || true)" --arg origin "$RAYA_TARGET" \
    --arg ledger "$RAYA_LEDGER_STATE" --arg rollback "$RAYA_ROLLBACK_SHA" \
    --arg deployed "$deployed" --arg identity "$RAYA_IDENTITY" \
    --arg grace "$RAYA_SESSION_GRACE" --arg cutover "$RAYA_SESSION_AT_CUTOVER" \
    --argjson generation "$generation" \
    --arg gen_brain_pid "$RAYA_BRAIN_BEFORE_PID" --arg gen_brain_start "$RAYA_BRAIN_BEFORE_START" \
    --arg gen_voice_pid "$RAYA_VOICE_BEFORE_PID" --arg gen_voice_start "$RAYA_VOICE_BEFORE_START" \
    --arg brain_before "$RAYA_BRAIN_CUTOVER_PID" \
    --arg brain_after "$RAYA_BRAIN_AFTER_PID" \
    --arg voice "$RAYA_VOICE_RESULT" --arg voice_before "$RAYA_VOICE_CUTOVER_PID" \
    --arg voice_after "$RAYA_VOICE_AFTER_PID" \
    --arg node "$RAYA_NODE_BIN" \
    --arg preflight "$RAYA_PREFLIGHT_RC" --arg notice "$RAYA_INTERRUPT_NOTICE" '
      def nullable: if . == "" then null else . end;
      def number_or_null: if . == "" then null else tonumber end;
      {
        schemaVersion: 1,
        checked_at: $checked,
        outcome: $outcome,
        state: $state,
        failure: $failure,
        checkout_before: ($checkout | nullable),
        head: ($head | nullable),
        origin_main: ($origin | nullable),
        ledger: ($ledger | nullable),
        rollback_sha: ($rollback | nullable),
        deployed_sha: ($deployed | nullable),
        identity: ($identity | nullable),
        session_grace: ($grace | nullable),
        session_at_cutover: ($cutover | nullable),
        generation: $generation,
        gen_before: (if $gen_brain_pid == "" and $gen_voice_pid == "" then null else {
          brain: (if $gen_brain_pid == "" then null else {pid:($gen_brain_pid|tonumber),start:($gen_brain_start|nullable)} end),
          voice: (if $gen_voice_pid == "" then null else {pid:($gen_voice_pid|tonumber),start:($gen_voice_start|nullable)} end)
        } end),
        interrupt_notice: ($notice | nullable),
        brain_pid: (if $brain_before == "" and $brain_after == "" then null else {
          before:($brain_before|number_or_null),after:($brain_after|number_or_null)
        } end),
        voice: ($voice | nullable),
        voice_pid: (if $voice_before == "" and $voice_after == "" then null else {
          before:($voice_before|number_or_null),after:($voice_after|number_or_null)
        } end),
        node_bin: ($node | nullable),
        preflight_rc: ($preflight | number_or_null)
      }
    ' > "$tmp" || { rm -f "$tmp"; return 1; }
  mv "$tmp" "$RAYA_DEPLOY_RECEIPT"
}

raya_write_deployed_sha() {
  local tmp="${RAYA_DEPLOYED_SHA_FILE}.tmp.$$"
  printf '%s\n' "$1" > "$tmp" || { rm -f "$tmp"; return 1; }
  mv "$tmp" "$RAYA_DEPLOYED_SHA_FILE"
}

raya_finish() {
  local state="$1" detail="$2" rc="$3"
  RAYA_DEPLOY_STATE="$state" RAYA_DEPLOY_DETAIL="$detail"
  if [[ "$RAYA_LOCK_OWNED" == 1 && "$state" != missing && "$state" != locked ]]; then
    if ! raya_write_receipt "$state" "$detail"; then
      RAYA_DEPLOY_STATE=failed RAYA_DEPLOY_DETAIL="ledger-write-failed:$state"
      raya_alert severe raya-ledger-write-failed "Raya deploy failed" "$RAYA_DEPLOY_DETAIL"
      rc=3
    elif [[ "$state" == deployed ]] && ! raya_write_deployed_sha "$RAYA_NEW_HEAD"; then
      RAYA_DEPLOY_STATE=failed RAYA_DEPLOY_DETAIL="deployed-sha-write-failed"
      raya_alert severe raya-ledger-write-failed "Raya deploy failed" "$RAYA_DEPLOY_DETAIL"
      rc=3
    fi
  fi
  raya_lock_release
  raya_log "$RAYA_DEPLOY_STATE $RAYA_DEPLOY_DETAIL"
  return "$rc"
}

raya_refuse() {
  local state="$1" detail="$2" rc="${3:-1}" severity="${4:-warning}" class="${5:-raya-deploy-refused}"
  RAYA_FAILURE_CLASS="$class"
  raya_alert "$severity" "$class" "Raya deploy degraded" "$detail"
  raya_finish "$state" "$detail" "$rc"
}

raya_capture_known_good() {
  local ledger="" rc=0
  RAYA_LEDGER_STATE=missing RAYA_ROLLBACK_SHA=""
  ledger="$(sed -n '1{s/^[[:space:]]*//;s/[[:space:]]*$//;p;}' \
    "$RAYA_DEPLOYED_SHA_FILE" 2>/dev/null || true)"
  [[ -n "$ledger" ]] || return 0
  if ! raya_is_sha40 "$ledger" || ! raya_git cat-file -e "${ledger}^{commit}" 2>/dev/null; then
    RAYA_LEDGER_STATE=invalid
    return 0
  fi
  raya_git merge-base --is-ancestor "$ledger" "$RAYA_TARGET" 2>/dev/null
  rc=$?
  case "$rc" in
    0) RAYA_LEDGER_STATE=ok; RAYA_ROLLBACK_SHA="$ledger" ;;
    1) RAYA_LEDGER_STATE=not_ancestor ;;
    *) RAYA_LEDGER_STATE=probe_error; return 2 ;;
  esac
}

raya_rebuild() {
  raya_pnpm_install && raya_pnpm_build
}

raya_generation_proof_after_restore() {
  local brain_pid="" brain_start="" voice_pid="" voice_start="" voice_was_running=no
  if ! raya_observe_job "$RAYA_BRAIN_LABEL"; then return 1; fi
  brain_pid="$RAYA_OBS_PID" brain_start="$RAYA_OBS_START"
  if [[ "$RAYA_OBS_STATE" == running && -z "$brain_start" ]]; then return 1; fi
  if [[ -n "$RAYA_BRAIN_BEFORE_PID" && "$brain_pid" == "$RAYA_BRAIN_BEFORE_PID" \
    && "$brain_start" == "$RAYA_BRAIN_BEFORE_START" ]]; then
    RAYA_GENERATION_BRAIN=unchanged
  else
    raya_validate_launchd_identity || return 1
    raya_assert_checkout "$RAYA_ROLLBACK_SHA" || return 1
    raya_kickstart "$RAYA_BRAIN_LABEL" || return 1
    raya_wait_for_replacement brain "$brain_pid" || return 1
    RAYA_GENERATION_BRAIN=replaced
  fi
  if ! raya_observe_job "$RAYA_VOICE_LABEL"; then return 1; fi
  voice_pid="$RAYA_OBS_PID" voice_start="$RAYA_OBS_START"
  [[ "$RAYA_OBS_STATE" == running ]] && voice_was_running=yes
  if [[ "$RAYA_OBS_STATE" == running && -z "$voice_start" ]]; then return 1; fi
  if [[ -n "$RAYA_VOICE_BEFORE_PID" && "$voice_pid" == "$RAYA_VOICE_BEFORE_PID" \
    && "$voice_start" == "$RAYA_VOICE_BEFORE_START" ]]; then
    RAYA_GENERATION_VOICE=unchanged
  elif [[ "$RAYA_OBS_STATE" != running && ! -e "$RAYA_STATE_DIR/voice-mode.requested" ]]; then
    RAYA_GENERATION_VOICE=stopped_by_user
  else
    raya_validate_launchd_identity || return 1
    raya_assert_checkout "$RAYA_ROLLBACK_SHA" || return 1
    raya_kickstart "$RAYA_VOICE_LABEL" || return 1
    raya_wait_for_replacement voice "$voice_pid" || return 1
    [[ "$voice_was_running" == yes ]] && RAYA_GENERATION_VOICE=replaced || RAYA_GENERATION_VOICE=recovered
  fi
}

raya_rollback_blocked() {
  local detail="$1"
  raya_alert severe raya-rollback-blocked-mutation "Raya deploy failed" "$detail"
  raya_finish rollback_blocked_mutation "$detail" 3
}

raya_rollback_before_cutover() {
  local reason="$1"
  if [[ -z "$RAYA_ROLLBACK_SHA" ]]; then
    raya_alert severe raya-deploy-failed-no-known-good "Raya deploy failed" "$reason:no-known-good"
    raya_finish failed "$reason:no-known-good" 3
    return
  fi
  raya_assert_checkout "$RAYA_NEW_HEAD" || { raya_rollback_blocked "$reason:$RAYA_ASSERT_DETAIL"; return; }
  raya_git reset --hard "$RAYA_ROLLBACK_SHA" >/dev/null 2>&1 || {
    raya_alert severe raya-deploy-rollback-failed "Raya deploy failed" "$reason:reset-failed"
    raya_finish failed "$reason:reset-failed" 3; return;
  }
  if ! raya_rebuild; then
    raya_alert severe raya-deploy-rollback-failed "Raya deploy failed" "$reason:rebuild-failed"
    raya_finish failed "$reason:rebuild-failed" 3; return
  fi
  raya_assert_checkout "$RAYA_ROLLBACK_SHA" || { raya_rollback_blocked "$reason:$RAYA_ASSERT_DETAIL"; return; }
  if ! raya_generation_proof_after_restore; then
    raya_alert severe raya-brain-down-after-rollback "Raya deploy failed" "$reason:generation-proof-failed"
    RAYA_GENERATION_BRAIN="" RAYA_GENERATION_VOICE=""
    raya_finish failed "$reason:generation-proof-failed" 3; return
  fi
  raya_assert_checkout "$RAYA_ROLLBACK_SHA" || { raya_rollback_blocked "$reason:$RAYA_ASSERT_DETAIL"; return; }
  raya_alert severe raya-deploy-rolled-back "Raya deploy failed" "$reason:rolled-back"
  raya_finish rolled_back "$reason:rolled-back" 0
}

raya_rollback_after_cutover() {
  local reason="$1" voice_required="${2:-no}" before_brain="" before_voice="" voice_observe_rc=0
  if [[ "$voice_required" != yes ]]; then
    raya_observe_job "$RAYA_VOICE_LABEL"
    voice_observe_rc=$?
    if (( voice_observe_rc != 0 )) || [[ "$RAYA_OBS_STATE" == running \
      || -e "$RAYA_STATE_DIR/voice-mode.requested" ]]; then
      voice_required=yes
    fi
  fi
  if [[ -z "$RAYA_ROLLBACK_SHA" ]]; then
    if ! raya_validate_launchd_identity || ! raya_assert_checkout "$RAYA_NEW_HEAD"; then
      raya_alert severe raya-brain-down-after-rollback "Raya deploy failed" "$reason:recovery-preflight-failed"
      raya_finish failed "$reason:recovery-preflight-failed" 3
      return
    fi
    raya_observe_job "$RAYA_BRAIN_LABEL" || true
    before_brain="$RAYA_OBS_PID"
    if ! raya_kickstart "$RAYA_BRAIN_LABEL" || ! raya_wait_for_replacement brain "$before_brain"; then
      raya_alert severe raya-brain-down-after-rollback "Raya deploy failed" "$reason:brain-replace-failed"
      raya_finish failed "$reason:brain-replace-failed" 3
      return
    fi
    if [[ "$voice_required" == yes ]]; then
      if ! raya_assert_checkout "$RAYA_NEW_HEAD" || ! raya_validate_launchd_identity; then
        raya_alert severe raya-voice-down-after-rollback "Raya deploy failed" "$reason:voice-recovery-preflight-failed"
        raya_finish failed "$reason:voice-recovery-preflight-failed" 3
        return
      fi
      raya_observe_job "$RAYA_VOICE_LABEL" || true
      before_voice="$RAYA_OBS_PID"
      if ! raya_kickstart "$RAYA_VOICE_LABEL" || ! raya_wait_for_replacement voice "$before_voice"; then
        raya_alert severe raya-voice-down-after-rollback "Raya deploy failed" "$reason:voice-replace-failed"
        raya_finish failed "$reason:voice-replace-failed" 3
        return
      fi
    fi
    raya_alert severe raya-deploy-failed-no-known-good "Raya deploy failed" "$reason:no-known-good"
    raya_finish failed "$reason:no-known-good" 3
    return
  fi
  raya_assert_checkout "$RAYA_NEW_HEAD" || { raya_rollback_blocked "$reason:$RAYA_ASSERT_DETAIL"; return; }
  raya_git reset --hard "$RAYA_ROLLBACK_SHA" >/dev/null 2>&1 || {
    raya_alert severe raya-deploy-rollback-failed "Raya deploy failed" "$reason:reset-failed"
    raya_finish failed "$reason:reset-failed" 3; return;
  }
  raya_rebuild || {
    raya_alert severe raya-deploy-rollback-failed "Raya deploy failed" "$reason:rebuild-failed"
    raya_finish failed "$reason:rebuild-failed" 3; return;
  }
  raya_assert_checkout "$RAYA_ROLLBACK_SHA" || { raya_rollback_blocked "$reason:$RAYA_ASSERT_DETAIL"; return; }
  raya_validate_launchd_identity || {
    raya_alert severe raya-brain-down-after-rollback "Raya deploy failed" "$reason:identity-drift"
    raya_finish failed "$reason:identity-drift" 3; return;
  }
  raya_assert_checkout "$RAYA_ROLLBACK_SHA" || { raya_rollback_blocked "$reason:$RAYA_ASSERT_DETAIL"; return; }
  raya_observe_job "$RAYA_BRAIN_LABEL" || true
  local before_brain="$RAYA_OBS_PID"
  if ! raya_kickstart "$RAYA_BRAIN_LABEL" || ! raya_wait_for_replacement brain "$before_brain"; then
    raya_alert severe raya-brain-down-after-rollback "Raya deploy failed" "$reason:brain-replace-failed"
    raya_finish failed "$reason:brain-replace-failed" 3; return
  fi
  if [[ "$voice_required" == yes ]]; then
    raya_assert_checkout "$RAYA_ROLLBACK_SHA" || { raya_rollback_blocked "$reason:$RAYA_ASSERT_DETAIL"; return; }
    raya_observe_job "$RAYA_VOICE_LABEL" || true
    local before_voice="$RAYA_OBS_PID"
    if ! raya_kickstart "$RAYA_VOICE_LABEL" || ! raya_wait_for_replacement voice "$before_voice"; then
      raya_alert severe raya-voice-down-after-rollback "Raya deploy failed" "$reason:voice-replace-failed"
      raya_finish failed "$reason:voice-replace-failed" 3; return
    fi
  fi
  raya_assert_checkout "$RAYA_ROLLBACK_SHA" || { raya_rollback_blocked "$reason:$RAYA_ASSERT_DETAIL"; return; }
  raya_alert severe raya-deploy-rolled-back "Raya deploy failed" "$reason:rolled-back"
  raya_finish rolled_back "$reason:rolled-back" 0
}

updater_raya_pass() {
  local identity_rc=0 branch="" dirty="" remote="" attempt=1 fetch_rc=0 relation_rc=0
  local session_rc=0 voice_cutover=no
  RAYA_DEPLOY_STATE=not_run RAYA_DEPLOY_DETAIL="" RAYA_LOCK_OWNED=0
  RAYA_CHECKOUT_BEFORE="" RAYA_TARGET="" RAYA_NEW_HEAD="" RAYA_ROLLBACK_SHA="" RAYA_LEDGER_STATE=""
  RAYA_IDENTITY="" RAYA_NODE_BIN="" RAYA_SESSION_GRACE="" RAYA_SESSION_AT_CUTOVER=""
  RAYA_INTERRUPT_NOTICE="" RAYA_PREFLIGHT_RC="" RAYA_BRAIN_BEFORE_PID="" RAYA_BRAIN_BEFORE_START=""
  RAYA_BRAIN_CUTOVER_PID="" RAYA_BRAIN_AFTER_PID="" RAYA_VOICE_BEFORE_PID=""
  RAYA_VOICE_BEFORE_START="" RAYA_VOICE_CUTOVER_PID="" RAYA_VOICE_AFTER_PID=""
  RAYA_VOICE_RESULT="" RAYA_GENERATION_BRAIN="" RAYA_GENERATION_VOICE=""

  if [[ ! -d "$RAYA_CODE_DIR/.git" ]]; then
    raya_alert warning raya-checkout-missing "Raya deploy degraded" "checkout-missing:$RAYA_CODE_DIR"
    raya_finish missing "checkout-missing:$RAYA_CODE_DIR" 1
    return
  fi
  if ! raya_lock_acquire; then
    case "$RAYA_LOCK_FAILURE" in
      home)
        raya_alert warning raya-home-unwritable "Raya deploy degraded" "home-unwritable"
        raya_finish locked "home-unwritable" 1
        ;;
      state)
        raya_alert warning raya-lock-state-failed "Raya deploy degraded" "lock-owner-state-unwritable"
        raya_finish locked "lock-owner-state-unwritable" 1
        ;;
      *)
        raya_alert warning raya-deploy-locked "Raya deploy degraded" "live-or-uninspectable-owner"
        raya_finish locked "live-or-uninspectable-owner" 1
        ;;
    esac
    return
  fi
  raya_validate_launchd_identity; identity_rc=$?
  if (( identity_rc != 0 )); then
    if (( identity_rc == 2 )); then
      raya_refuse observe_failed "$RAYA_DEPLOY_DETAIL" 1 severe raya-launchd-observe-failed
    else
      raya_refuse identity_drift "$RAYA_DEPLOY_DETAIL" 1 severe raya-launchd-identity-drift
    fi
    return
  fi
  branch="$(raya_git symbolic-ref --short HEAD 2>/dev/null || true)"
  [[ "$branch" == main ]] || { raya_refuse wrong_branch "branch:${branch:-detached}" 1 severe raya-wrong-branch; return; }
  dirty="$(raya_git status --porcelain --untracked-files=no 2>/dev/null)" || {
    raya_refuse dirty status-unreadable 1 warning raya-checkout-dirty; return;
  }
  [[ -z "$dirty" ]] || { raya_refuse dirty tracked-dirty 1 warning raya-checkout-dirty; return; }
  RAYA_CHECKOUT_BEFORE="$(raya_git rev-parse HEAD 2>/dev/null || true)"
  raya_is_sha40 "$RAYA_CHECKOUT_BEFORE" || { raya_refuse wrong_branch head-unreadable 1 severe raya-wrong-branch; return; }
  remote="$(raya_git remote get-url origin 2>/dev/null || true)"
  case "$remote" in
    https://github.com/xrliAnnie/raya.git|git@github.com:xrliAnnie/raya.git) ;;
    file://*|/*) [[ "${UPDATE_FLYWHEEL_SOURCED:-0}" == 1 ]] \
      || { raya_refuse remote_mismatch "origin:$remote" 1 severe raya-remote-mismatch; return; } ;;
    *) raya_refuse remote_mismatch "origin:$remote" 1 severe raya-remote-mismatch; return ;;
  esac
  while (( attempt <= 3 )); do
    raya_git_fetch_bounded; fetch_rc=$?
    (( fetch_rc == 0 )) && break
    (( fetch_rc == 127 )) && break
    (( attempt < 3 )) && raya_sleep 1
    attempt=$((attempt + 1))
  done
  (( fetch_rc == 0 )) || {
    raya_refuse fetch_failed "fetch-rc:$fetch_rc" 2 warning raya-fetch-failed; return;
  }
  RAYA_TARGET="$(raya_git rev-parse origin/main 2>/dev/null || true)"
  raya_is_sha40 "$RAYA_TARGET" || { raya_refuse fetch_failed origin-main-unreadable 2 warning raya-fetch-failed; return; }
  raya_assert_checkout "$RAYA_CHECKOUT_BEFORE" || {
    raya_refuse mutated "post-fetch:$RAYA_ASSERT_DETAIL" 1 severe raya-checkout-mutated; return;
  }
  raya_capture_known_good; relation_rc=$?
  (( relation_rc != 2 )) || { raya_refuse ledger_probe_error ledger-probe-error 1 severe raya-ledger-probe-error; return; }
  if [[ "$RAYA_CHECKOUT_BEFORE" == "$RAYA_TARGET" ]]; then
    relation_rc=0
  else
    raya_git merge-base --is-ancestor "$RAYA_CHECKOUT_BEFORE" "$RAYA_TARGET" 2>/dev/null
    relation_rc=$?
    (( relation_rc == 0 )) || { raya_refuse diverged "head-not-ancestor-of-origin" 1 severe raya-diverged; return; }
  fi
  if [[ "$RAYA_CHECKOUT_BEFORE" == "$RAYA_TARGET" && "$RAYA_ROLLBACK_SHA" == "$RAYA_CHECKOUT_BEFORE" ]]; then
    RAYA_NEW_HEAD="$RAYA_CHECKOUT_BEFORE"
    raya_finish current ledger-equals-head 0
    return
  fi
  raya_wait_for_session; session_rc=$?
  (( session_rc != 2 )) || { raya_refuse session_state_unreadable session-state-unreadable 1 warning raya-session-state-unreadable; return; }
  raya_capture_generation || { raya_refuse observe_failed generation-unreadable 1 severe raya-launchd-observe-failed; return; }
  raya_assert_checkout "$RAYA_CHECKOUT_BEFORE" || {
    raya_refuse mutated "post-grace:$RAYA_ASSERT_DETAIL" 1 severe raya-checkout-mutated; return;
  }
  if [[ "$RAYA_CHECKOUT_BEFORE" != "$RAYA_TARGET" ]]; then
    raya_git merge --ff-only "$RAYA_TARGET" --quiet || {
      raya_refuse mutated merge-failed 1 severe raya-checkout-mutated; return;
    }
  fi
  RAYA_NEW_HEAD="$(raya_git rev-parse HEAD 2>/dev/null || true)"
  if [[ "$RAYA_NEW_HEAD" != "$RAYA_TARGET" ]]; then
    raya_refuse mutated target-mismatch 1 severe raya-checkout-mutated; return
  fi
  if ! raya_pnpm_install; then raya_rollback_before_cutover install-failed; return; fi
  if ! raya_pnpm_build; then raya_rollback_before_cutover build-failed; return; fi
  raya_preflight; RAYA_PREFLIGHT_RC=$?
  if (( RAYA_PREFLIGHT_RC != 0 )); then raya_rollback_before_cutover "preflight-rc:$RAYA_PREFLIGHT_RC"; return; fi
  raya_assert_checkout "$RAYA_NEW_HEAD" || { raya_rollback_before_cutover "post-build:$RAYA_ASSERT_DETAIL"; return; }
  raya_validate_launchd_identity; identity_rc=$?
  if (( identity_rc != 0 )); then raya_rollback_after_cutover identity-recheck-failed no; return; fi
  raya_observe_job "$RAYA_BRAIN_LABEL" || { raya_rollback_before_cutover brain-observe-failed; return; }
  RAYA_BRAIN_CUTOVER_PID="$RAYA_OBS_PID"
  raya_observe_job "$RAYA_VOICE_LABEL" || { raya_rollback_before_cutover voice-observe-failed; return; }
  RAYA_VOICE_CUTOVER_PID="$RAYA_OBS_PID"
  [[ "$RAYA_OBS_STATE" == running ]] && voice_cutover=yes || voice_cutover=no
  raya_session_active; session_rc=$?
  if (( session_rc == 2 )); then
    RAYA_SESSION_AT_CUTOVER=unreadable
    raya_rollback_before_cutover session-state-unreadable
    return
  elif (( session_rc == 0 )); then
    RAYA_SESSION_AT_CUTOVER=active
    if raya_notify_interruption "${RAYA_NEW_HEAD:0:8}"; then RAYA_INTERRUPT_NOTICE=sent; else
      RAYA_INTERRUPT_NOTICE=failed
      raya_alert warning raya-interrupt-notice-failed "Raya deploy degraded" "notification-failed"
    fi
  else
    RAYA_SESSION_AT_CUTOVER=inactive RAYA_INTERRUPT_NOTICE=skipped
  fi
  raya_assert_checkout "$RAYA_NEW_HEAD" || { raya_rollback_before_cutover "brain-fence:$RAYA_ASSERT_DETAIL"; return; }
  if ! raya_kickstart "$RAYA_BRAIN_LABEL" || ! raya_wait_for_replacement brain "$RAYA_BRAIN_CUTOVER_PID"; then
    raya_rollback_after_cutover brain-replace-failed "$voice_cutover"
    return
  fi
  if [[ "$voice_cutover" == yes ]]; then
    raya_assert_checkout "$RAYA_NEW_HEAD" || { raya_rollback_after_cutover "voice-fence:$RAYA_ASSERT_DETAIL" yes; return; }
    raya_validate_launchd_identity || { raya_rollback_after_cutover voice-identity-recheck-failed yes; return; }
    if ! raya_kickstart "$RAYA_VOICE_LABEL" || ! raya_wait_for_replacement voice "$RAYA_VOICE_CUTOVER_PID"; then
      raya_rollback_after_cutover voice-replace-failed yes
      return
    fi
    RAYA_VOICE_RESULT=replaced
  else
    RAYA_VOICE_RESULT='untouched:not_running'
  fi
  raya_assert_checkout "$RAYA_NEW_HEAD" || { raya_rollback_blocked "ledger-fence:$RAYA_ASSERT_DETAIL"; return; }
  raya_finish deployed "${RAYA_CHECKOUT_BEFORE:0:8}->${RAYA_NEW_HEAD:0:8}" 0
}
