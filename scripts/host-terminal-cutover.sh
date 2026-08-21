#!/usr/bin/env bash
# FLY-1944: founder-gated tmux host cutover transaction helper.
#
# This tool prepares and verifies receipts; it never schedules a cutover on its
# own. Mutating host commands are accepted only through `run-step`, after an
# active pause receipt has enough monotonic budget for that step plus rollback.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RECEIPT="${FLYWHEEL_HOST_CUTOVER_RECEIPT:-$HOME/.flywheel/state/host-terminal-cutover.json}"
BRIDGE_URL="${FLYWHEEL_BRIDGE_URL:-http://127.0.0.1:6411}"
CURL_BIN="${CUTOVER_CURL_BIN:-curl}"
JQ_BIN="${CUTOVER_JQ_BIN:-jq}"
PYTHON_BIN="${CUTOVER_PYTHON_BIN:-python3}"
BOUNDED_RUN="${CUTOVER_BOUNDED_RUN_BIN:-$ROOT/scripts/lib/bounded-run.sh}"
QUIESCENCE_INTERVAL_SECONDS="${CUTOVER_QUIESCENCE_INTERVAL_SECONDS:-2}"

ROLLBACK_BUDGET_SECONDS=900
BRIDGE_BOOT_MIN_SECONDS=180
# Initial pause covers steps through Bridge bootstrap. Post-bootstrap renewal
# establishes a fresh budget for service bootstrap + automated verification.
INITIAL_NORMAL_BUDGET_SECONDS=870
INITIAL_MINIMUM_SECONDS=$((INITIAL_NORMAL_BUDGET_SECONDS + ROLLBACK_BUDGET_SECONDS))

die() { printf '[host-terminal-cutover] FAIL: %s\n' "$*" >&2; exit 1; }
log() { printf '[host-terminal-cutover] %s\n' "$*" >&2; }

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "required command unavailable: $1"
}

monotonic_seconds() {
  "$PYTHON_BIN" -c 'import time; print(int(time.monotonic()))'
}

wall_seconds() {
  date +%s
}

ensure_receipt_parent() {
  local parent
  parent="$(dirname "$RECEIPT")"
  mkdir -p "$parent"
  chmod 700 "$parent" 2>/dev/null || true
  if [[ -L "$RECEIPT" ]]; then
    die "receipt path is a symlink: $RECEIPT"
  fi
  if [[ -e "$RECEIPT" && ! -f "$RECEIPT" ]]; then
    die "receipt path is not a regular file: $RECEIPT"
  fi
}

initialize_receipt() {
  ensure_receipt_parent
  [[ -f "$RECEIPT" ]] && return 0
  local tmp
  tmp=$(mktemp "${RECEIPT}.XXXXXX") || die "cannot create receipt temp file"
  "$JQ_BIN" -n '{schemaVersion:1,status:"preparatory",events:[]}' > "$tmp"
  chmod 600 "$tmp"
  mv "$tmp" "$RECEIPT"
}

receipt_update() {
  local filter="$1"
  shift
  initialize_receipt
  "$JQ_BIN" -e . "$RECEIPT" >/dev/null || die "receipt is invalid JSON"
  local tmp
  tmp=$(mktemp "${RECEIPT}.XXXXXX") || die "cannot create receipt temp file"
  if ! "$JQ_BIN" "$@" "$filter" "$RECEIPT" > "$tmp"; then
    rm -f "$tmp"
    die "receipt update failed"
  fi
  chmod 600 "$tmp"
  mv "$tmp" "$RECEIPT"
}

append_event() {
  local event_json="$1"
  receipt_update '.events = ((.events // []) + [$event])' --argjson event "$event_json"
}

require_api() {
  [[ -n "${TEAMLEAD_API_TOKEN:-}" ]] || die "TEAMLEAD_API_TOKEN is required"
  need_cmd "$CURL_BIN"
  need_cmd "$JQ_BIN"
}

api_get() {
  local path="$1"
  "$CURL_BIN" -fsS --connect-timeout 5 --max-time 20 \
    -H "Authorization: Bearer ${TEAMLEAD_API_TOKEN}" \
    "${BRIDGE_URL%/}${path}"
}

api_post() {
  local path="$1" body="$2"
  "$CURL_BIN" -fsS --connect-timeout 5 --max-time 20 -X POST \
    -H "Authorization: Bearer ${TEAMLEAD_API_TOKEN}" \
    -H 'Content-Type: application/json' \
    --data "$body" "${BRIDGE_URL%/}${path}"
}

bounded_json() {
  local value="$1"
  (( ${#value} <= 65536 )) || die "Bridge response exceeded 64KiB"
  printf '%s' "$value" | "$JQ_BIN" -e . >/dev/null || die "Bridge returned invalid JSON"
}

step_budget_seconds() {
  case "$1" in
    bootout-supervisors) printf '120\n' ;;
    authoritative-census) printf '60\n' ;;
    stop-old-servers) printf '120\n' ;;
    brew-upgrade) printf '300\n' ;;
    rollback-rehearsal) printf '60\n' ;;
    phase-b-link) printf '30\n' ;;
    bridge-bootstrap) printf '180\n' ;;
    services-bootstrap) printf '180\n' ;;
    automated-verification) printf '120\n' ;;
    *) return 1 ;;
  esac
}

verify_budget() {
  local step="$1" mode="${2:-normal}"
  initialize_receipt
  [[ "$("$JQ_BIN" -r '.status // ""' "$RECEIPT")" == "paused" ]] \
    || die "receipt does not prove an active pause"
  local monotonic_expiry wall_expiry monotonic_now wall_now monotonic_remaining wall_remaining remaining required budget
  monotonic_expiry=$("$JQ_BIN" -er '.pause.expiryMonotonicSeconds | numbers' "$RECEIPT") \
    || die "receipt has no monotonic pause expiry"
  wall_expiry=$("$JQ_BIN" -er '.pause.expiryWallClockEpochSeconds | numbers' "$RECEIPT") \
    || die "receipt has no wall-clock pause expiry"
  monotonic_now=$(monotonic_seconds)
  wall_now=$(wall_seconds)
  monotonic_remaining=$((monotonic_expiry - monotonic_now))
  wall_remaining=$((wall_expiry - wall_now))
  remaining=$monotonic_remaining
  (( wall_remaining < remaining )) && remaining=$wall_remaining
  if [[ "$mode" == "rollback" ]]; then
    required=$BRIDGE_BOOT_MIN_SECONDS
    budget=0
  else
    budget=$(step_budget_seconds "$step") || die "unknown cutover step: $step"
    required=$((budget + ROLLBACK_BUDGET_SECONDS))
  fi
  (( remaining >= required )) \
    || die "insufficient pause budget for $step: remaining=${remaining}s required=${required}s"
  "$JQ_BIN" -n \
    --arg step "$step" \
    --arg mode "$mode" \
    --argjson remaining "$remaining" \
    --argjson required "$required" \
    --argjson budget "$budget" \
    '{ok:true,step:$step,mode:$mode,remainingSeconds:$remaining,requiredSeconds:$required,stepBudgetSeconds:$budget}'
}

pause_admission() {
  require_api
  local duration=3600 minimum=$INITIAL_MINIMUM_SECONDS reason="tmux 3.7c host cutover"
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --duration) duration="${2:-}"; shift 2 ;;
      --minimum) minimum="${2:-}"; shift 2 ;;
      --reason) reason="${2:-}"; shift 2 ;;
      *) die "unknown pause-admission argument: $1" ;;
    esac
  done
  [[ "$duration" =~ ^[0-9]+$ && "$minimum" =~ ^[0-9]+$ ]] \
    || die "duration and minimum must be integers"
  (( minimum >= INITIAL_MINIMUM_SECONDS )) \
    || die "minimum must preserve the fixed ${INITIAL_MINIMUM_SECONDS}s initial cutover budget"
  (( duration >= minimum )) || die "requested duration is below the required minimum"
  local body response remaining monotonic_now monotonic_expiry wall_now wall_expiry
  body=$("$JQ_BIN" -n --argjson duration "$duration" --arg reason "$reason" \
    '{durationSeconds:$duration,reason:$reason}')
  response=$(api_post /api/admission/pause "$body") || die "pause request failed"
  bounded_json "$response"
  printf '%s' "$response" | "$JQ_BIN" -e \
    --argjson minimum "$minimum" \
    '.ok == true and .admissionPause.active == true and (.admissionPause.remainingSeconds >= $minimum)' \
    >/dev/null || die "Bridge did not grant the required active pause"
  remaining=$(printf '%s' "$response" | "$JQ_BIN" -r '.admissionPause.remainingSeconds')
  monotonic_now=$(monotonic_seconds)
  monotonic_expiry=$((monotonic_now + remaining))
  wall_now=$(wall_seconds)
  wall_expiry=$((wall_now + remaining))
  receipt_update \
    '.status="paused" | .pause={startedMonotonicSeconds:$monotonicNow,expiryMonotonicSeconds:$monotonicExpiry,startedWallClockEpochSeconds:$wallNow,expiryWallClockEpochSeconds:$wallExpiry,remainingSeconds:$remaining,minimumSeconds:$minimum,reason:$reason} | .budgets={rollbackSeconds:$rollback,bridgeBootMinimumSeconds:$bridgeBoot,initialNormalSeconds:$initialNormal}' \
    --argjson monotonicNow "$monotonic_now" --argjson monotonicExpiry "$monotonic_expiry" \
    --argjson wallNow "$wall_now" --argjson wallExpiry "$wall_expiry" --argjson remaining "$remaining" \
    --argjson minimum "$minimum" --arg reason "$reason" \
    --argjson rollback "$ROLLBACK_BUDGET_SECONDS" \
    --argjson bridgeBoot "$BRIDGE_BOOT_MIN_SECONDS" \
    --argjson initialNormal "$INITIAL_NORMAL_BUDGET_SECONDS"
  append_event "$("$JQ_BIN" -n --argjson at "$monotonic_now" --argjson remaining "$remaining" \
    '{kind:"pause",atMonotonicSeconds:$at,remainingSeconds:$remaining}')"
  printf '%s\n' "$response"
}

inspect_admission() {
  require_api
  local response
  response=$(api_get /api/admission/pause) || die "pause inspection failed"
  bounded_json "$response"
  printf '%s' "$response" | "$JQ_BIN" -e '.ok == true' >/dev/null \
    || die "pause inspection was not authoritative"
  printf '%s\n' "$response"
}

resume_admission() {
  require_api
  local response now
  response=$(api_post /api/admission/resume '{}') || die "resume request failed"
  bounded_json "$response"
  printf '%s' "$response" | "$JQ_BIN" -e \
    '.ok == true and .admissionPause.active == false' >/dev/null \
    || die "Bridge did not prove active=false"
  now=$(monotonic_seconds)
  receipt_update '.status="resumed"'
  append_event "$("$JQ_BIN" -n --argjson at "$now" \
    '{kind:"resume",atMonotonicSeconds:$at,active:false}')"
  printf '%s\n' "$response"
}

quiescence() {
  require_api
  local first second now
  first=$(api_get /api/admission/quiescence) || die "first quiescence snapshot failed"
  bounded_json "$first"
  printf '%s' "$first" | "$JQ_BIN" -e \
    '.ok == true and .admissionPause.active == true and .quiescent == true and .total == 0' \
    >/dev/null || die "first quiescence snapshot is non-zero"
  sleep "$QUIESCENCE_INTERVAL_SECONDS"
  second=$(api_get /api/admission/quiescence) || die "second quiescence snapshot failed"
  bounded_json "$second"
  printf '%s' "$second" | "$JQ_BIN" -e \
    '.ok == true and .admissionPause.active == true and .quiescent == true and .total == 0' \
    >/dev/null || die "second quiescence snapshot is non-zero"
  now=$(monotonic_seconds)
  append_event "$("$JQ_BIN" -n --argjson at "$now" --argjson snapshot "$second" \
    '{kind:"quiescence",atMonotonicSeconds:$at,stableZero:true,snapshot:$snapshot}')"
  printf '%s\n' "$second"
}

run_step() {
  local name="" timeout=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --name) name="${2:-}"; shift 2 ;;
      --timeout) timeout="${2:-}"; shift 2 ;;
      --) shift; break ;;
      *) die "unknown run-step argument: $1" ;;
    esac
  done
  [[ -n "$name" && "$timeout" =~ ^[0-9]+$ && "$timeout" -gt 0 && $# -gt 0 ]] \
    || die "usage: run-step --name <known-step> --timeout <seconds> -- <command...>"
  local budget
  budget=$(step_budget_seconds "$name") || die "unknown cutover step: $name"
  (( timeout <= budget )) || die "timeout ${timeout}s exceeds enforced budget ${budget}s for $name"
  verify_budget "$name" normal >/dev/null
  [[ -x "$BOUNDED_RUN" ]] || die "bounded runner unavailable: $BOUNDED_RUN"
  local rc=0 status now
  "$BOUNDED_RUN" "$timeout" "$@" || rc=$?
  case "$rc" in
    0) status="completed" ;;
    124) status="timeout" ;;
    *) status="failed" ;;
  esac
  now=$(monotonic_seconds)
  append_event "$("$JQ_BIN" -n --arg name "$name" --arg status "$status" \
    --argjson at "$now" --argjson timeout "$timeout" --argjson rc "$rc" \
    '{kind:"run-step",name:$name,status:$status,atMonotonicSeconds:$at,timeoutSeconds:$timeout,exitCode:$rc}')"
  return "$rc"
}

extract_tmux_image() {
  local pid="$1" lines image="" count=0 candidate
  lines=$(lsof -a -p "$pid" -d txt -Fn 2>/dev/null) \
    || die "cannot inspect executable image for tmux pid $pid"
  while IFS= read -r candidate; do
    candidate="${candidate#n}"
    case "$candidate" in
      /usr/local/Cellar/tmux/*/bin/tmux|/opt/homebrew/Cellar/tmux/*/bin/tmux|*/.flywheel/backup/tmux-*/bin/tmux)
        image="$candidate"
        count=$((count + 1))
        ;;
    esac
  done <<< "$lines"
  (( count == 1 )) \
    || die "tmux pid $pid has ${count} recognized executable images; expected exactly one"
  printf '%s\n' "$image"
}

prove_image_extractor() {
  local binary="$1" tmp socket session pid extracted expected tries=0
  tmp=$(mktemp -d -t fly1944-tmux-extractor.XXXXXX)
  socket="$tmp/control.sock"
  session="fly1944-extractor-proof-$$"
  cleanup_extractor_proof() {
    "$binary" -S "$socket" kill-server >/dev/null 2>&1 || true
    rm -rf "$tmp"
  }
  trap cleanup_extractor_proof EXIT RETURN
  "$binary" -S "$socket" new-session -d -s "$session" -n proof 'sleep 30'
  pid=$("$binary" -S "$socket" display-message -p '#{pid}')
  [[ "$pid" =~ ^[0-9]+$ ]] || die "extractor positive-control pid is invalid"
  extracted=""
  while (( tries < 20 )); do
    extracted=$(extract_tmux_image "$pid" 2>/dev/null || true)
    [[ -n "$extracted" ]] && break
    sleep 0.1
    tries=$((tries + 1))
  done
  [[ -n "$extracted" ]] || die "extractor positive control could not identify tmux pid $pid"
  expected=$(real_path "$binary")
  [[ "$(real_path "$extracted")" == "$expected" ]] \
    || die "extractor positive control returned $extracted instead of $expected"
  cleanup_extractor_proof
  trap - EXIT RETURN
  "$JQ_BIN" -n --argjson pid "$pid" --arg expected "$expected" --arg extracted "$extracted" \
    '{pid:$pid,expectedImage:$expected,extractedImage:$extracted,passed:true}'
}

inventory_tmux_servers() {
  local pids rc pid incarnation image architecture sockets ppid parent_command entry inventory='[]'
  set +e
  pids=$(pgrep -x tmux 2>/dev/null)
  rc=$?
  set -e
  (( rc == 0 || rc == 1 )) || die "cannot enumerate live tmux server processes"
  for pid in $pids; do
    [[ "$pid" =~ ^[0-9]+$ ]] || die "tmux process inventory returned an invalid pid: $pid"
    incarnation=$(TZ=UTC LC_ALL=C ps -o lstart= -p "$pid" 2>/dev/null | sed 's/^ *//')
    [[ -n "$incarnation" ]] || die "tmux pid $pid has no start-identity"
    image=$(extract_tmux_image "$pid")
    architecture=$(file -b "$image") || die "cannot inspect architecture for $image"
    sockets=$(lsof -a -p "$pid" -U -Fn 2>/dev/null | sed -n 's/^n//p') \
      || die "cannot inspect unix sockets for tmux pid $pid"
    ppid=$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')
    [[ "$ppid" =~ ^[0-9]+$ ]] || die "tmux pid $pid has no parent identity"
    parent_command=$(ps -o command= -p "$ppid" 2>/dev/null || true)
    entry=$("$JQ_BIN" -n --argjson pid "$pid" --arg incarnation "$incarnation" \
      --arg image "$image" --arg architecture "$architecture" --arg sockets "$sockets" \
      --argjson parentPid "$ppid" --arg parentCommand "$parent_command" \
      '{pid:$pid,startIdentity:$incarnation,image:$image,architecture:$architecture,sockets:($sockets|split("\n")|map(select(length>0))),supervisor:{parentPid:$parentPid,parentCommand:$parentCommand}}')
    inventory=$(printf '%s' "$inventory" | "$JQ_BIN" --argjson entry "$entry" '. + [$entry]')
  done
  printf '%s\n' "$inventory"
}

preflight_receipt() {
  need_cmd "$JQ_BIN"
  need_cmd "$PYTHON_BIN"
  need_cmd file
  need_cmd lsof
  need_cmd pgrep
  local old_bin="${FLYWHEEL_TMUX_3_5A_BIN:-/usr/local/Cellar/tmux/3.5a/bin/tmux}"
  local new_bin="${FLYWHEEL_TMUX_3_7C_BIN:-/opt/homebrew/Cellar/tmux/3.7c/bin/tmux}"
  local intel_brew="${FLYWHEEL_INTEL_BREW_BIN:-/usr/local/bin/brew}"
  local arm_brew="${FLYWHEEL_ARM_BREW_BIN:-/opt/homebrew/bin/brew}"
  [[ -x "$old_bin" ]] || die "old tmux recovery binary missing: $old_bin"
  [[ -x "$new_bin" ]] || die "exact tmux 3.7c binary missing: $new_bin"
  [[ "$($old_bin -V)" == "tmux 3.5a" ]] || die "old recovery binary is not tmux 3.5a"
  [[ "$($new_bin -V)" == "tmux 3.7c" ]] || die "new binary is not tmux 3.7c"
  [[ -x "$intel_brew" && -x "$arm_brew" ]] || die "both Homebrew binaries are required"
  initialize_receipt
  [[ "$("$JQ_BIN" -r '.status // ""' "$RECEIPT")" != "paused" ]] \
    || die "refusing to replace an active pause receipt with preparatory evidence"

  local which_tmux process_inventory extractor_proof link_inventory bottle_manifest="" missing=0 brew prefix deps formula cache
  which_tmux=$(which -a tmux 2>/dev/null || true)
  extractor_proof=$(prove_image_extractor "$old_bin")
  process_inventory=$(inventory_tmux_servers)
  link_inventory=$(ls -ld /usr/local/bin/tmux /opt/homebrew/bin/tmux 2>/dev/null || true)
  for brew in "$intel_brew" "$arm_brew"; do
    prefix=$($brew --prefix)
    deps=$($brew deps --formula tmux) || die "cannot enumerate tmux dependencies with $brew"
    for formula in tmux $deps; do
      cache=$($brew --cache "$formula") || die "cannot resolve bottle cache for $formula with $brew"
      if [[ -f "$cache" ]]; then
        bottle_manifest+="${prefix}|${formula}|${cache}|present"$'\n'
      else
        bottle_manifest+="${prefix}|${formula}|${cache}|missing"$'\n'
        missing=$((missing + 1))
      fi
    done
  done
  local now
  now=$(monotonic_seconds)
  receipt_update \
    '.status="preparatory" | .preflight={atMonotonicSeconds:$at,oldBinary:$old,newBinary:$new,whichTmux:$which,extractorPositiveControl:$extractorProof,processInventory:$processes,linkInventory:$links,bottleManifest:$bottles,missingBottleCount:$missing}' \
    --argjson at "$now" --arg old "$old_bin" --arg new "$new_bin" \
    --arg which "$which_tmux" --argjson extractorProof "$extractor_proof" \
    --argjson processes "$process_inventory" \
    --arg links "$link_inventory" --arg bottles "$bottle_manifest" \
    --argjson missing "$missing"
  (( missing == 0 )) \
    || die "$missing dependency bottle artifact(s) missing; run both brew fetch --deps tmux commands before opening the window"
  "$JQ_BIN" '.preflight' "$RECEIPT"
}

real_path() {
  "$PYTHON_BIN" -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$1"
}

build_closure() {
  need_cmd otool
  need_cmd shasum
  local old_bin="${FLYWHEEL_TMUX_3_5A_BIN:-/usr/local/Cellar/tmux/3.5a/bin/tmux}"
  local closure="${FLYWHEEL_TMUX_CLOSURE_DIR:-$HOME/.flywheel/backup/tmux-3.5a-closure}"
  initialize_receipt
  "$JQ_BIN" -e '.preflight.missingBottleCount == 0' "$RECEIPT" >/dev/null \
    || die "successful preflight receipt is required before building the rollback closure"
  [[ -x "$old_bin" ]] || die "old tmux recovery binary missing: $old_bin"
  [[ ! -e "$closure" && ! -L "$closure" ]] || die "closure target already exists: $closure"
  mkdir -p "$(dirname "$closure")"
  local stage queue seen index=1 current dep resolved leaf target deps_output
  stage=$(mktemp -d "${closure}.staging.XXXXXX") || die "cannot create closure staging directory"
  mkdir -p "$stage/bin" "$stage/lib"
  cp "$old_bin" "$stage/bin/tmux"
  queue="$stage/.queue"
  seen="$stage/.seen"
  : > "$queue"; : > "$seen"
  printf '%s\n' "$old_bin" >> "$queue"
  while current=$(sed -n "${index}p" "$queue") && [[ -n "$current" ]]; do
    index=$((index + 1))
    if ! deps_output=$(otool -L "$current"); then
      rm -rf "$stage"
      die "cannot inspect rollback dependency closure for $current"
    fi
    while IFS= read -r dep; do
      [[ "$dep" == /usr/local/* ]] || continue
      resolved=$(real_path "$dep")
      [[ -f "$resolved" ]] || { rm -rf "$stage"; die "dependency missing: $dep"; }
      grep -qxF "$resolved" "$seen" && continue
      printf '%s\n' "$resolved" >> "$seen"
      printf '%s\n' "$resolved" >> "$queue"
      leaf=$(basename "$resolved")
      target="$stage/lib/$leaf"
      if [[ -e "$target" ]]; then
        [[ "$(shasum -a 256 "$resolved" | awk '{print $1}')" == "$(shasum -a 256 "$target" | awk '{print $1}')" ]] \
          || { rm -rf "$stage"; die "dependency basename collision: $leaf"; }
      else
        cp "$resolved" "$target"
      fi
    done < <(printf '%s\n' "$deps_output" | tail -n +2 | awk '{print $1}')
  done
  cat > "$stage/tmux-3.5a" <<'WRAPPER'
#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
export DYLD_LIBRARY_PATH="$HERE/lib${DYLD_LIBRARY_PATH:+:$DYLD_LIBRARY_PATH}"
exec "$HERE/bin/tmux" "$@"
WRAPPER
  chmod 755 "$stage/tmux-3.5a" "$stage/bin/tmux"
  (cd "$stage" && shasum -a 256 bin/tmux lib/* > manifest.sha256)
  rm -f "$queue" "$seen"
  mv "$stage" "$closure"
  local now manifest
  now=$(monotonic_seconds)
  manifest=$(cat "$closure/manifest.sha256")
  append_event "$("$JQ_BIN" -n --argjson at "$now" --arg closure "$closure" --arg manifest "$manifest" \
    '{kind:"build-closure",atMonotonicSeconds:$at,path:$closure,manifest:$manifest}')"
  printf '%s\n' "$closure"
}

rehearse_rollback() {
  local closure="${FLYWHEEL_TMUX_CLOSURE_DIR:-$HOME/.flywheel/backup/tmux-3.5a-closure}"
  local wrapper="$closure/tmux-3.5a"
  [[ -x "$wrapper" ]] || die "closure wrapper is unavailable: $wrapper"
  local tmp socket session pid incarnation now
  tmp=$(mktemp -d -t fly1944-tmux-rollback.XXXXXX)
  socket="$tmp/rehearsal.sock"
  session="fly1944-rollback-rehearsal-$$"
  cleanup_rehearsal() {
    "$wrapper" -S "$socket" kill-server >/dev/null 2>&1 || true
    rm -rf "$tmp"
  }
  trap cleanup_rehearsal EXIT RETURN
  "$wrapper" -S "$socket" new-session -d -s "$session" -n proof 'sleep 30'
  "$wrapper" -S "$socket" list-panes -t "=$session" >/dev/null
  printf 'detach-client\n' | "$wrapper" -S "$socket" -C attach-session -t "=$session" >/dev/null 2>&1 \
    || die "closure attach rehearsal failed"
  pid=$("$wrapper" -S "$socket" display-message -p '#{pid}')
  [[ "$pid" =~ ^[0-9]+$ ]] || die "rehearsal server pid is invalid"
  incarnation=$(TZ=UTC LC_ALL=C ps -o lstart= -p "$pid" | sed 's/^ *//')
  [[ -n "$incarnation" ]] || die "rehearsal server incarnation is unavailable"
  "$wrapper" -S "$socket" kill-server
  local tries=0 observed
  while (( tries < 20 )); do
    observed=$(TZ=UTC LC_ALL=C ps -o lstart= -p "$pid" 2>/dev/null | sed 's/^ *//' || true)
    [[ "$observed" != "$incarnation" ]] && break
    sleep 0.1
    tries=$((tries + 1))
  done
  [[ "$observed" != "$incarnation" ]] || die "rehearsal server tuple survived kill-server"
  now=$(monotonic_seconds)
  append_event "$("$JQ_BIN" -n --argjson at "$now" --argjson pid "$pid" --arg incarnation "$incarnation" \
    '{kind:"rollback-rehearsal",atMonotonicSeconds:$at,pid:$pid,incarnation:$incarnation,confirmedGone:true}')"
  cleanup_rehearsal
  trap - EXIT RETURN
  log "rollback closure started, attached, stopped, and passed tuple disappearance proof"
}

usage() {
  cat >&2 <<'USAGE'
usage: host-terminal-cutover.sh <command> [args]
  preflight-receipt
  build-closure
  rehearse-rollback
  pause-admission [--duration S] [--minimum S] [--reason TEXT]
  inspect-admission
  quiescence
  verify-receipt --step NAME [--rollback]
  run-step --name NAME --timeout S -- COMMAND [ARGS...]
  resume-admission
USAGE
  exit 2
}

command_name="${1:-}"
[[ -n "$command_name" ]] || usage
shift
case "$command_name" in
  preflight-receipt) [[ $# -eq 0 ]] || usage; preflight_receipt ;;
  build-closure) [[ $# -eq 0 ]] || usage; build_closure ;;
  rehearse-rollback) [[ $# -eq 0 ]] || usage; rehearse_rollback ;;
  pause-admission) pause_admission "$@" ;;
  inspect-admission) [[ $# -eq 0 ]] || usage; inspect_admission ;;
  quiescence) [[ $# -eq 0 ]] || usage; quiescence ;;
  resume-admission) [[ $# -eq 0 ]] || usage; resume_admission ;;
  run-step) run_step "$@" ;;
  verify-receipt)
    step=""; mode="normal"
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --step) step="${2:-}"; shift 2 ;;
        --rollback) mode="rollback"; shift ;;
        *) usage ;;
      esac
    done
    [[ -n "$step" ]] || usage
    if [[ "$mode" == "rollback" && "$step" != "bridge-bootstrap" ]]; then
      die "rollback verification is reserved for bridge-bootstrap"
    fi
    verify_budget "$step" "$mode"
    ;;
  *) usage ;;
esac
