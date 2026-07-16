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

  LEAD_LEASE_KEY=""
  LEAD_LEASE_GENERATION=""
  LEAD_LEASE_DEGRADED=""
  LEAD_LEASE_HOLD_REASON=""

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

  if [ "$status" = "denied_holder_alive" ] || [ "$acquire_rc" -eq 3 ]; then
    LEAD_LEASE_HOLD_REASON="denied_holder_alive"
    return 3
  fi
  if [ "$acquire_rc" -eq 2 ]; then
    # Lock/store faults fail open at launch only. No key/generation is exported,
    # so enforce-mode writes remain fail closed while the scanner still watches.
    LEAD_LEASE_DEGRADED="store_error"
    return 0
  fi
  if [ "$acquire_rc" -ne 0 ]; then
    LEAD_LEASE_HOLD_REASON="identity_acquire_rejected"
    return 3
  fi
  case "$status" in acquired|idempotent) ;; *)
    LEAD_LEASE_HOLD_REASON="identity_acquire_invalid_response"
    return 3
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
