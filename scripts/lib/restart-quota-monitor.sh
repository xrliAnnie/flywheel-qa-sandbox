#!/usr/bin/env bash
# FLY-2271: source-only convergence for a loaded quota-monitor runtime.

QUOTA_MONITOR_RESTART_STATE="${QUOTA_MONITOR_RESTART_STATE:-unverifiable}"
QUOTA_MONITOR_RESTART_DETAIL="${QUOTA_MONITOR_RESTART_DETAIL:-not checked}"

_rqm_set_outcome() {
  QUOTA_MONITOR_RESTART_STATE="$1"
  QUOTA_MONITOR_RESTART_DETAIL="$2"
}

_rqm_runtime_sha() {
  "${FLYWHEEL_RQM_RUNTIME_SHA_BIN:-${FLYWHEEL_DIR}/packages/teamlead/bin/flywheel-quota-monitor}" --runtime-tree-sha
}

_rqm_health_marker_path() {
  printf '%s\n' "${FLYWHEEL_QUOTA_HEALTH_MARKER:-${HOME}/.flywheel/quota-monitor.health.json}"
}

_rqm_pidfile_path() {
  printf '%s\n' "${FLYWHEEL_QUOTA_PIDFILE:-${HOME}/.flywheel/quota-monitor.pid}"
}

_rqm_launchctl() {
  "${FLYWHEEL_RQM_LAUNCHCTL_BIN:-launchctl}" "$@"
}

_rqm_process_start_time() {
  local value=""
  value=$("${FLYWHEEL_RQM_PS_BIN:-/bin/ps}" -o lstart= -p "$1") || return $?
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  [[ -n "$value" ]] || return 1
  printf '%s\n' "$value"
}

_rqm_now_ms() {
  "${FLYWHEEL_NODE_BIN:-node}" -e 'process.stdout.write(String(Date.now()))'
}

_rqm_sleep() {
  sleep "$1"
}

_rqm_read_record() {
  "${FLYWHEEL_NODE_BIN:-node}" - "$1" "${@:2}" <<'NODE'
const fs = require("node:fs");
const path = process.argv[2];
const fields = process.argv.slice(3);
try {
  const stat = fs.lstatSync(path);
  const uid = process.getuid?.();
  if (!stat.isFile() || stat.isSymbolicLink() || uid === undefined || stat.uid !== uid || (stat.mode & 0o777) !== 0o600 || stat.size <= 0 || stat.size > 64 * 1024) process.exit(2);
  const bytes = fs.readFileSync(path);
  const text = bytes.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(bytes)) process.exit(2);
  const value = JSON.parse(text);
  if (typeof value !== "object" || value === null || Array.isArray(value)) process.exit(2);
  const output = fields.map((field) => {
    const item = value[field];
    if (field === "pid" && (!Number.isInteger(item) || item <= 0)) process.exit(2);
    if (field === "processStartTime" && (typeof item !== "string" || item.length === 0 || item.length > 256 || /[\u0000-\u001f\u007f|]/.test(item))) process.exit(2);
    if (field === "runtimeTreeSha256" && (typeof item !== "string" || !/^[a-f0-9]{64}$/.test(item))) process.exit(2);
    if (field === "completedAt" && (!Number.isInteger(item) || item < 0)) process.exit(2);
    if (!["pid", "processStartTime", "runtimeTreeSha256", "completedAt"].includes(field)) process.exit(2);
    return String(item);
  });
  process.stdout.write(output.join("|"));
} catch {
  process.exit(2);
}
NODE
}

_rqm_read_pidfile() {
  _rqm_read_record "$(_rqm_pidfile_path)" pid processStartTime
}

_rqm_marker_is_trusted() {
  _rqm_read_record "$(_rqm_health_marker_path)" runtimeTreeSha256 pid processStartTime completedAt >/dev/null
}

_rqm_marker_field() {
  _rqm_read_record "$(_rqm_health_marker_path)" "$1"
}

restart_quota_monitor() {
  local label="com.flywheel.quota-monitor" domain="gui/$(id -u)"
  local disk_sha="" tuple="" live_pid="" live_start="" live_observed=""
  local marker_sha="" marker_pid="" marker_start="" reason="" rc=0
  local kick_at_ms="" i=0 new_tuple="" new_pid="" new_start="" new_observed=""
  local completed_at=""
  _rqm_set_outcome unverifiable "quota-monitor restart did not run"

  if ! _rqm_launchctl print "${domain}/${label}" >/dev/null 2>&1; then
    _rqm_set_outcome not_loaded "job not in domain; left to convergence"
    return 0
  fi
  disk_sha=$(_rqm_runtime_sha) || rc=$?
  if (( rc != 0 )) || [[ ! "$disk_sha" =~ ^[a-f0-9]{64}$ ]]; then
    _rqm_set_outcome unverifiable "runtime tree sha unavailable"
    return 0
  fi

  rc=0
  tuple=$(_rqm_read_pidfile) || rc=$?
  if (( rc != 0 )); then
    reason="pidfile unreadable or malformed (rc=$rc)"
  else
    live_pid="${tuple%%|*}"
    live_start="${tuple#*|}"
    if ! _rqm_marker_is_trusted; then
      reason="marker unsafe or missing"
    else
      rc=0; marker_sha=$(_rqm_marker_field runtimeTreeSha256) || rc=$?
      (( rc == 0 )) || marker_sha=""
      rc=0; marker_pid=$(_rqm_marker_field pid) || rc=$?
      (( rc == 0 )) || marker_pid=""
      rc=0; marker_start=$(_rqm_marker_field processStartTime) || rc=$?
      (( rc == 0 )) || marker_start=""
      if [[ "$marker_sha" != "$disk_sha" ]]; then
        reason="runtime tree differs from disk"
      elif [[ "$marker_pid" != "$live_pid" || "$marker_start" != "$live_start" ]]; then
        reason="marker does not describe the pidfile process"
      else
        rc=0; live_observed=$(_rqm_process_start_time "$live_pid" 2>/dev/null) || rc=$?
        if (( rc != 0 )) || [[ "$live_observed" != "$live_start" ]]; then
          reason="pidfile process is not alive with the recorded start time"
        fi
      fi
    fi
  fi
  if [[ -z "$reason" ]]; then
    _rqm_set_outcome current "marker matches live process and disk build"
    return 0
  fi
  if [[ "${DRY_RUN:-false}" == "true" ]]; then
    _rqm_set_outcome planned "dry-run: would kickstart ($reason)"
    return 0
  fi

  rc=0; kick_at_ms=$(_rqm_now_ms) || rc=$?
  if (( rc != 0 )) || [[ ! "$kick_at_ms" =~ ^[0-9]+$ ]]; then
    _rqm_set_outcome unverifiable "clock unavailable ($reason)"
    return 0
  fi
  rc=0
  _rqm_launchctl kickstart -k "${domain}/${label}" || rc=$?
  if (( rc != 0 )); then
    _rqm_set_outcome degraded "kickstart failed rc=$rc ($reason)"
    return 0
  fi

  for (( i = 0; i < 60; i++ )); do
    _rqm_sleep 0.5 || true
    rc=0; new_tuple=$(_rqm_read_pidfile) || rc=$?
    (( rc == 0 )) || continue
    new_pid="${new_tuple%%|*}"
    new_start="${new_tuple#*|}"
    rc=0; new_observed=$(_rqm_process_start_time "$new_pid" 2>/dev/null) || rc=$?
    (( rc == 0 )) || continue
    [[ "$new_observed" == "$new_start" ]] || continue
    if [[ -n "$live_pid" ]]; then
      [[ "$new_pid" != "$live_pid" || "$new_start" != "$live_start" ]] || continue
      _rqm_set_outcome restarted "$reason; pid $live_pid -> $new_pid"
      return 0
    fi
    _rqm_marker_is_trusted || continue
    rc=0; marker_sha=$(_rqm_marker_field runtimeTreeSha256) || rc=$?
    (( rc == 0 )) || continue
    rc=0; marker_pid=$(_rqm_marker_field pid) || rc=$?
    (( rc == 0 )) || continue
    rc=0; marker_start=$(_rqm_marker_field processStartTime) || rc=$?
    (( rc == 0 )) || continue
    rc=0; completed_at=$(_rqm_marker_field completedAt) || rc=$?
    (( rc == 0 )) || continue
    [[ "$completed_at" =~ ^[0-9]+$ ]] || continue
    if [[ "$marker_sha" == "$disk_sha" && "$marker_pid" == "$new_pid" && "$marker_start" == "$new_start" ]] \
      && (( completed_at > kick_at_ms )); then
      _rqm_set_outcome restarted "$reason; fresh marker from pid $new_pid after kick"
      return 0
    fi
  done
  _rqm_set_outcome degraded "no conclusive post-kick process evidence within 30s ($reason)"
  return 0
}
