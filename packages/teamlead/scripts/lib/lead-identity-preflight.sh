#!/bin/bash
# FLY-1309: source-only Lead identity lease + exact process preflight helpers.
# Bash 3.2 compatible; intentionally installs no traps and changes no shell opts.

lead_identity_json_field() {
  local field="$1"
  node -e '
    let raw = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { raw += chunk; });
    process.stdin.on("end", () => {
      try {
        const value = JSON.parse(raw)[process.argv[1]];
        if (typeof value === "string" || typeof value === "number") {
          process.stdout.write(String(value));
        }
      } catch {
        process.exitCode = 1;
      }
    });
  ' "$field"
}

# Overridable test seam. Production always invokes the built flywheel-comm CLI.
lead_identity_cli() {
  node "$FLYWHEEL_COMM_CLI" lead-lease "$@"
}

lead_identity_prepare_lease() {
  local lead_id="$1" project="$2" supervisor_pid="$3" supervisor_start="$4"
  local resolution="" resolve_rc=0 status="" canonical_project="" expected_key=""
  local acquisition="" acquire_rc=0 generation="" acquired_key=""
  local holder_pid="" holder_start="" old_supervisor_pid="" old_supervisor_start=""

  LEAD_LEASE_KEY=""
  LEAD_LEASE_GENERATION=""
  LEAD_LEASE_DEGRADED=""
  LEAD_LEASE_HOLD_REASON=""
  LEAD_LEASE_ORPHAN_HOLDER_PID=""
  LEAD_LEASE_ORPHAN_HOLDER_START=""
  LEAD_LEASE_ORPHAN_OLD_SUP_PID=""
  LEAD_LEASE_ORPHAN_OLD_SUP_START=""

  if [ -z "${FLYWHEEL_COMM_CLI:-}" ] || [ ! -f "$FLYWHEEL_COMM_CLI" ]; then
    LEAD_LEASE_HOLD_REASON="identity_cli_unavailable"
    return 3
  fi

  resolution="$(lead_identity_cli resolve --lead "$lead_id" --project "$project" --json)" \
    || resolve_rc=$?
  status="$(printf '%s' "$resolution" | lead_identity_json_field status 2>/dev/null || true)"
  case "$status" in
    ok)
      [ "$resolve_rc" -eq 0 ] || {
        LEAD_LEASE_HOLD_REASON="identity_source_error"
        return 3
      }
      canonical_project="$(printf '%s' "$resolution" | lead_identity_json_field canonicalProject 2>/dev/null || true)"
      expected_key="$(printf '%s' "$resolution" | lead_identity_json_field leadKey 2>/dev/null || true)"
      if [ "$canonical_project" != "$project" ] || [ -z "$expected_key" ]; then
        LEAD_LEASE_HOLD_REASON="identity_project_mismatch"
        return 3
      fi
      ;;
    valid_but_lead_absent)
      [ "$resolve_rc" -eq 0 ] || {
        LEAD_LEASE_HOLD_REASON="identity_source_error"
        return 3
      }
      expected_key="${project}-${lead_id}"
      ;;
    ambiguous|source_error)
      LEAD_LEASE_HOLD_REASON="identity_${status}"
      return 3
      ;;
    *)
      LEAD_LEASE_HOLD_REASON="identity_invalid_response"
      return 3
      ;;
  esac

  acquisition="$(lead_identity_cli acquire \
    --lead "$lead_id" \
    --project "$project" \
    --supervisor-pid "$supervisor_pid" \
    --supervisor-start "$supervisor_start" \
    --acquired-by "claude-lead.sh:${supervisor_pid}" \
    --json)" || acquire_rc=$?
  status="$(printf '%s' "$acquisition" | lead_identity_json_field status 2>/dev/null || true)"

  # Route by the typed status before interpreting the shared exit-code classes.
  # This preserves distinct HOLD/adoption states and rejects impossible pairs.
  case "$status" in
    denied_holder_alive|denied_sensor_degraded)
      if [ "$acquire_rc" -ne 3 ]; then
        LEAD_LEASE_HOLD_REASON="identity_acquire_invalid_response"
      else
        LEAD_LEASE_HOLD_REASON="$status"
      fi
      return 3
      ;;
    acquired|idempotent|holder_orphaned|idempotent_adopted)
      if [ "$acquire_rc" -ne 0 ]; then
        LEAD_LEASE_HOLD_REASON="identity_acquire_invalid_response"
        return 3
      fi
      ;;
    ''|error)
      if [ "$acquire_rc" -eq 2 ]; then
        # Lock/store faults fail open at launch only. No key/generation is
        # exported, so enforce-mode writes remain fail closed.
        LEAD_LEASE_DEGRADED="store_error"
        return 0
      fi
      LEAD_LEASE_HOLD_REASON="identity_acquire_rejected"
      return 3
      ;;
    *)
      LEAD_LEASE_HOLD_REASON="identity_acquire_invalid_response"
      return 3
      ;;
  esac

  generation="$(printf '%s' "$acquisition" | lead_identity_json_field generation 2>/dev/null || true)"
  acquired_key="$(printf '%s' "$acquisition" | lead_identity_json_field leadKey 2>/dev/null || true)"
  case "$generation" in ''|*[!0-9]*|0)
    LEAD_LEASE_HOLD_REASON="identity_acquire_invalid_generation"
    return 3
    ;;
  esac
  if [ "$acquired_key" != "$expected_key" ]; then
    LEAD_LEASE_HOLD_REASON="identity_acquire_key_mismatch"
    return 3
  fi
  LEAD_LEASE_KEY="$expected_key"
  LEAD_LEASE_GENERATION="$generation"
  case "$status" in
    holder_orphaned|idempotent_adopted)
      holder_pid="$(printf '%s' "$acquisition" | lead_identity_json_field holderPid 2>/dev/null || true)"
      holder_start="$(printf '%s' "$acquisition" | lead_identity_json_field holderStart 2>/dev/null || true)"
      case "$holder_pid" in ''|*[!0-9]*|0)
        LEAD_LEASE_HOLD_REASON="identity_acquire_invalid_response"
        return 3
        ;;
      esac
      if [ -z "$holder_start" ]; then
        LEAD_LEASE_HOLD_REASON="identity_acquire_invalid_response"
        return 3
      fi
      LEAD_LEASE_ORPHAN_HOLDER_PID="$holder_pid"
      LEAD_LEASE_ORPHAN_HOLDER_START="$holder_start"
      ;;
  esac
  if [ "$status" = "holder_orphaned" ]; then
    old_supervisor_pid="$(printf '%s' "$acquisition" | lead_identity_json_field supervisorPid 2>/dev/null || true)"
    old_supervisor_start="$(printf '%s' "$acquisition" | lead_identity_json_field supervisorStart 2>/dev/null || true)"
    case "$old_supervisor_pid" in ''|*[!0-9]*|0)
      LEAD_LEASE_HOLD_REASON="identity_acquire_invalid_response"
      return 3
      ;;
    esac
    if [ -z "$old_supervisor_start" ]; then
      LEAD_LEASE_HOLD_REASON="identity_acquire_invalid_response"
      return 3
    fi
    LEAD_LEASE_ORPHAN_OLD_SUP_PID="$old_supervisor_pid"
    LEAD_LEASE_ORPHAN_OLD_SUP_START="$old_supervisor_start"
    return 4
  fi
  [ "$status" = "idempotent_adopted" ] && return 5
  return 0
}

lead_identity_bind_lease() {
  local lead_key="$1" generation="$2" supervisor_pid="$3" supervisor_start="$4"
  local pane_pid="$5" pane_start="$6" output="" rc=0 status=""
  output="$(lead_identity_cli bind \
    --lead-key "$lead_key" \
    --generation "$generation" \
    --supervisor-pid "$supervisor_pid" \
    --supervisor-start "$supervisor_start" \
    --pane-pid "$pane_pid" \
    --pane-start "$pane_start" \
    --json)" || rc=$?
  [ "$rc" -eq 0 ] || return "$rc"
  status="$(printf '%s' "$output" | lead_identity_json_field status 2>/dev/null || true)"
  [ "$status" = "bound" ]
}

lead_identity_adopt_lease() {
  local lead_id="$1" project="$2" supervisor_pid="$3" supervisor_start="$4"
  local holder_pid="$5" holder_start="$6" old_supervisor_pid="$7"
  local old_supervisor_start="$8" output="" rc=0 status=""
  output="$(lead_identity_cli adopt \
    --lead "$lead_id" \
    --project "$project" \
    --supervisor-pid "$supervisor_pid" \
    --supervisor-start "$supervisor_start" \
    --holder-pid "$holder_pid" \
    --holder-start "$holder_start" \
    --old-supervisor-pid "$old_supervisor_pid" \
    --old-supervisor-start "$old_supervisor_start" \
    --acquired-by "claude-lead.sh:${supervisor_pid}" \
    --json)" || rc=$?
  status="$(printf '%s' "$output" | lead_identity_json_field status 2>/dev/null || true)"
  case "$status:$rc" in
    adopted:0|idempotent_adopted:0) return 0 ;;
    lost_race:3) return 3 ;;
    *) return 2 ;;
  esac
}

# Exact token matcher for the production Claude launch shape. It deliberately
# checks the executable basename before inspecting flags, preventing a wrapper,
# prompt, --agent-id, or substring from impersonating a Lead process.
lead_identity_command_matches() {
  local command="$1" lead_id="$2" executable="" token="" matched=1 had_noglob=0
  case "$-" in *f*) had_noglob=1 ;; *) set -f ;; esac
  # ps(1) renders argv separated by spaces. Lead IDs cannot contain spaces, so
  # exact flag-token matching is stable for the identity-bearing arguments.
  # shellcheck disable=SC2086
  set -- $command
  [ "$had_noglob" -eq 1 ] || set +f
  [ "$#" -gt 0 ] || return 1
  executable="${1##*/}"
  shift
  case "$executable" in claude|claude-code) ;; *) return 1 ;; esac

  while [ "$#" -gt 0 ]; do
    token="$1"
    shift
    case "$token" in
      --agent)
        if [ "$#" -gt 0 ] && [ "$1" = "$lead_id" ]; then matched=0; break; fi
        [ "$#" -gt 0 ] && shift
        ;;
      --agent=*)
        [ "${token#--agent=}" = "$lead_id" ] && matched=0 && break
        ;;
    esac
  done
  return "$matched"
}

# stdin rows: "<pid><space><full command>". Prints the first exact conflict as
# "pid<TAB>command" and returns 0; no match returns 1.
lead_identity_first_conflict() {
  local lead_id="$1" pid="" command=""
  while read -r pid command; do
    case "$pid" in ''|*[!0-9]*) continue ;; esac
    if lead_identity_command_matches "$command" "$lead_id"; then
      printf '%s\t%s\n' "$pid" "$command"
      return 0
    fi
  done
  return 1
}

lead_identity_preflight_first_conflict() {
  local lead_id="$1" snapshot="" ps_rc=0
  snapshot="$(LC_ALL=C ps -axo pid=,command= 2>/dev/null)" || ps_rc=$?
  [ "$ps_rc" -eq 0 ] || return 2
  printf '%s\n' "$snapshot" | lead_identity_first_conflict "$lead_id"
}

lead_identity_process_table() {
  # Emit the ps helper's real PID edge before exec. Bash 3.2 keeps $$ pinned
  # across command substitutions, so the table alone cannot distinguish the
  # census invocation shells (which inherit claude-lead.sh argv) from a foreign
  # supervisor. The marker lets the caller prove the exact sensor ancestry.
  LC_ALL=C /bin/sh -c '
    printf "#sensor %s %s\n" "$$" "$PPID"
    exec ps -axo pid=,ppid=,command=
  ' 2>/dev/null
}

LEAD_IDENTITY_SENSOR_CHAIN=""
lead_identity_build_sensor_chain() {
  local snapshot="$1" sensor_pid="$2" sensor_parent="$3" self_pid="$4"
  local current="$sensor_pid" parent="$sensor_parent" chain="" depth=0
  local row_pid row_ppid row_command
  LEAD_IDENTITY_SENSOR_CHAIN=""
  while [ "$depth" -lt 64 ]; do
    case "$current" in ''|*[!0-9]*) return 2 ;; esac
    case " $chain " in *" $current "*) return 2 ;; esac
    chain="${chain}${current} "
    if [ "$current" = "$self_pid" ]; then
      LEAD_IDENTITY_SENSOR_CHAIN="$chain"
      return 0
    fi
    case "$parent" in ''|*[!0-9]*|0|1) return 2 ;; esac
    current="$parent"
    parent=""
    while read -r row_pid row_ppid row_command; do
      [ "$row_pid" = "$current" ] || continue
      parent="$row_ppid"
      break
    done <<EOF
$snapshot
EOF

    depth=$((depth + 1))
  done
  return 2
}

lead_identity_supervisor_command_matches() {
  local command="$1" lead_id="$2" project="$3" token had_noglob=0
  case "$-" in *f*) had_noglob=1 ;; *) set -f ;; esac
  # shellcheck disable=SC2086
  set -- $command
  [ "$had_noglob" -eq 1 ] || set +f
  while [ "$#" -gt 0 ]; do
    token="${1##*/}"
    shift
    if [ "$token" = "claude-lead.sh" ]; then
      [ "${1:-}" = "$lead_id" ] && [ "${3:-}" = "$project" ]
      return
    fi
  done
  return 1
}

# Prints exact foreign claude-lead.sh supervisors as pid<TAB>command. An empty
# successful result proves census absence; rc 2 means the process table could
# not be measured and callers must HOLD.
lead_identity_supervisor_census() {
  local lead_id="$1" project="$2" self_pid="${3:-$$}"
  local snapshot="" snapshot_rc=0 line_pid line_ppid line_command
  local sensor_pid="" sensor_parent="" sensor_markers=0
  snapshot="$(lead_identity_process_table)" || snapshot_rc=$?
  [ "$snapshot_rc" -eq 0 ] || return 2
  while read -r line_pid line_ppid line_command; do
    [ "$line_pid" = "#sensor" ] || continue
    sensor_markers=$((sensor_markers + 1))
    sensor_pid="$line_ppid"
    sensor_parent="$line_command"
  done <<EOF
$snapshot
EOF
  [ "$sensor_markers" -eq 1 ] || return 2
  lead_identity_build_sensor_chain \
    "$snapshot" "$sensor_pid" "$sensor_parent" "$self_pid" || return 2
  while read -r line_pid line_ppid line_command; do
    case "$line_pid" in ''|*[!0-9]*) continue ;; esac
    lead_identity_supervisor_command_matches "$line_command" "$lead_id" "$project" \
      || continue
    # Exclude only the proven ps invocation ancestry, not every descendant of
    # the supervisor. This covers the outer and inner Bash 3.2 command-
    # substitution shells without hiding a separate same-identity child.
    case " $LEAD_IDENTITY_SENSOR_CHAIN " in *" $line_pid "*) continue ;; esac
    printf '%s\t%s\n' "$line_pid" "$line_command"
  done <<EOF
$snapshot
EOF
}
