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
  LEAD_LEASE_FRESH=0
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
  # This preserves distinct HOLD/bound-body states and rejects impossible pairs.
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
    acquired|idempotent) LEAD_LEASE_FRESH=1 ;;
  esac
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

# FLY-1697: launchd-native (v2) body identity step. The body process is its
# own supervisor and holder, so acquire and bind happen back-to-back before
# any session or receipt side effect.
# rc 0: bound; LEAD_LEASE_KEY/LEAD_LEASE_GENERATION carry the claim.
# rc 1: degraded store; launch may proceed without a claim.
# rc 2: held; LEAD_LEASE_HOLD_REASON describes the retry reason.
lead_identity_v2_acquire_bind() {
  local lead_id="$1" project="$2" body_pid="$3" body_start="$4"
  local prepare_rc=0 bind_rc=0 verify_rc=0

  if [ -z "$body_start" ]; then
    LEAD_LEASE_KEY=""
    LEAD_LEASE_GENERATION=""
    LEAD_LEASE_DEGRADED="store_error"
    LEAD_LEASE_HOLD_REASON=""
    LEAD_LEASE_FRESH=0
    return 1
  fi

  lead_identity_prepare_lease "$lead_id" "$project" "$body_pid" "$body_start" \
    || prepare_rc=$?
  case "$prepare_rc" in
    0)
      if [ -n "$LEAD_LEASE_KEY" ] && [ -n "$LEAD_LEASE_GENERATION" ]; then
        lead_identity_bind_lease \
          "$LEAD_LEASE_KEY" "$LEAD_LEASE_GENERATION" \
          "$body_pid" "$body_start" "$body_pid" "$body_start" || bind_rc=$?
        [ "$bind_rc" -ne 0 ] || return 0
        if [ "$bind_rc" -eq 2 ]; then
          LEAD_LEASE_HOLD_REASON="v2_bind_store_error"
          return 2
        fi

        # The bind transaction may have committed before its CLI response was
        # lost. Resolve that ambiguity with an exact read-back before holding.
        lead_identity_v2_verify_bound \
          "$LEAD_LEASE_KEY" "$LEAD_LEASE_GENERATION" \
          "$body_pid" "$body_start" || verify_rc=$?
        case "$verify_rc" in
          0) return 0 ;;
          2) LEAD_LEASE_HOLD_REASON="v2_bind_verify_store_error" ;;
          *) LEAD_LEASE_HOLD_REASON="v2_bind_unverified" ;;
        esac
        return 2
      fi
      return 1
      ;;
    4)
      # A one-shot body cannot adopt a foreign legacy pane. Hold until that
      # holder exits, then the next acquire can advance the generation.
      LEAD_LEASE_HOLD_REASON="denied_holder_alive"
      return 2
      ;;
    5)
      # Recovery after a bind commit whose response was lost: prepare reports
      # our exact already-bound tuple. Never accept a foreign holder tuple.
      if [ "$LEAD_LEASE_ORPHAN_HOLDER_PID" = "$body_pid" ] \
        && [ "$LEAD_LEASE_ORPHAN_HOLDER_START" = "$body_start" ]; then
        return 0
      fi
      LEAD_LEASE_HOLD_REASON="denied_holder_alive"
      return 2
      ;;
    *)
      [ -n "${LEAD_LEASE_HOLD_REASON:-}" ] \
        || LEAD_LEASE_HOLD_REASON="v2_unexpected_prepare_rc_${prepare_rc}"
      return 2
      ;;
  esac
}

# Read-after-write disambiguation for a bind whose CLI response was lost.
# rc 0 only when the current store row is bound to this exact body tuple and
# generation; rc 2 means store/CLI failure, rc 1 is a definite mismatch.
lead_identity_v2_verify_bound() {
  local lead_key="$1" expected_generation="$2" body_pid="$3" body_start="$4"
  local output="" rc=0 status="" generation=""
  output="$(lead_identity_cli verify-bound \
    --lead-key "$lead_key" \
    --supervisor-pid "$body_pid" \
    --supervisor-start "$body_start" \
    --holder-pid "$body_pid" \
    --holder-start "$body_start" \
    --json)" || rc=$?
  [ "$rc" -ne 2 ] || return 2
  status="$(printf '%s' "$output" | lead_identity_json_field status 2>/dev/null || true)"
  generation="$(printf '%s' "$output" | lead_identity_json_field generation 2>/dev/null || true)"
  [ "$rc" -eq 0 ] \
    && [ "$status" = "verified" ] \
    && [ "$generation" = "$expected_generation" ]
}

# Pure alert classifier for the v2 HOLD loop. The first definite bind mismatch
# gets one silent retry; a repeated identical mismatch must become visible.
lead_identity_v2_hold_alert_kind() {
  local reason="$1" count="${2:-1}"
  case "$reason" in
    denied_holder_alive) printf 'lead_dual_active\n' ;;
    denied_sensor_degraded) printf 'lead_dual_active_sensor_degraded\n' ;;
    v2_bind_store_error|v2_bind_verify_store_error) printf 'lead_lease_store_broken\n' ;;
    v2_bind_unverified)
      [ "$count" -lt 2 ] || printf 'lead_identity_source_broken\n'
      ;;
    *) printf 'lead_identity_source_broken\n' ;;
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
