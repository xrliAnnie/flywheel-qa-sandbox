#!/bin/bash
# FLY-1663: isolated launchd-v2 carrier helpers for 529 QA room slots.
# All persistent artifacts belong to the slot directory; no production plist,
# projects file, state root, socket, or delivery secret is shared.

qa_launchd_err() { printf '[qa-launchd] ERROR: %s\n' "$*" >&2; }

# Cold real-Lead starts measured about 20-30 seconds in the 529 room. Preserve
# a 60-second observation envelope without hammering the machine that is also
# trying to start the Lead. PID discovery keeps its faster cadence below;
# topology verification deliberately probes only once per second.
QA_LAUNCHD_LEAD_VERIFY_POLLS_DEFAULT=60
QA_LAUNCHD_LEAD_VERIFY_INTERVAL_DEFAULT=1

qa_launchd_domain() {
  printf '%s\n' "${FLYWHEEL_QA_LAUNCHD_DOMAIN:-gui/$(id -u)}"
}

qa_launchd_label() {
  local slot="$1" agent="$2"
  [[ "$slot" =~ ^[1-9][0-9]*$ ]] || { qa_launchd_err "invalid slot: $slot"; return 1; }
  [[ "$agent" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] \
    || { qa_launchd_err "invalid agent id: $agent"; return 1; }
  printf 'com.flywheel.qa.lead.slot-%s.%s\n' "$slot" "$agent"
}

qa_launchd_xml_escape() {
  sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' \
    -e 's/"/\&quot;/g' -e "s/'/\&apos;/g"
}

qa_launchd_require_absolute() {
  case "$1" in
    /*) return 0 ;;
    *) qa_launchd_err "path must be absolute: $1"; return 1 ;;
  esac
}

qa_launchd_plist_open() {
  printf '%s\n' '<?xml version="1.0" encoding="UTF-8"?>'
  printf '%s\n' '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">'
  printf '%s\n' '<plist version="1.0"><dict>'
  printf '<key>Label</key><string>%s</string>\n' "$1"
}

qa_launchd_plist_argv_claude() {
  printf '<key>ProgramArguments</key><array><string>%s</string><string>%s</string></array>\n' "$1" "$2"
}

qa_launchd_plist_env_claude() {
  local x_home="$1" x_path="$2" x_state="$3" x_projects="$4"
  local x_env="$5" x_summary_config_home="$6"
  printf '%s\n' '<key>EnvironmentVariables</key><dict>'
  printf '<key>HOME</key><string>%s</string>\n' "$x_home"
  printf '<key>PATH</key><string>%s</string>\n' "$x_path"
  printf '<key>FLYWHEEL_DIR</key><string>%s</string>\n' "$(printf '%s' "${FLYWHEEL_DIR:?}" | qa_launchd_xml_escape)"
  printf '<key>FLYWHEEL_STATE_DIR</key><string>%s</string>\n' "$x_state"
  printf '<key>FLYWHEEL_PROJECTS_FILE</key><string>%s</string>\n' "$x_projects"
  printf '<key>FLYWHEEL_WRAPPER_ENV_FILE</key><string>%s</string>\n' "$x_env"
  if [ -n "$x_summary_config_home" ]; then
    printf '<key>FLYWHEEL_SUMMARY_CONFIG_HOME</key><string>%s</string>\n' "$x_summary_config_home"
  fi
  printf '%s\n' '</dict>'
}

qa_launchd_plist_close() {
  local x_log="$1"
  printf '%s\n' '<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>'
  printf '%s\n' '<key>ThrottleInterval</key><integer>3</integer>'
  printf '<key>StandardOutPath</key><string>%s</string>\n' "$x_log"
  printf '<key>StandardErrorPath</key><string>%s</string>\n' "$x_log"
  printf '%s\n' '</dict></plist>'
}

# Args: plist label wrapper manifest home state projects env log [summaryConfigHome]
qa_launchd_render_plist() {
  local plist="$1" label="$2" wrapper="$3" manifest="$4" home="$5"
  local state="$6" projects="$7" env_file="$8" log_file="$9"
  local summary_config_home="${10:-}"
  local value tmp
  [[ "$label" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] \
    || { qa_launchd_err "invalid label: $label"; return 1; }
  for value in "$plist" "$wrapper" "$manifest" "$home" "$state" \
    "$projects" "$env_file" "$log_file"; do
    qa_launchd_require_absolute "$value" || return 1
    [[ "$value" != *$'\n'* && "$value" != *$'\r'* ]] \
      || { qa_launchd_err "control character in path"; return 1; }
  done
  if [ -n "$summary_config_home" ]; then
    qa_launchd_require_absolute "$summary_config_home" || return 1
    [[ "$summary_config_home" != *$'\n'* && "$summary_config_home" != *$'\r'* ]] \
      || { qa_launchd_err "control character in path"; return 1; }
  fi
  [ -x "$wrapper" ] || { qa_launchd_err "wrapper is not executable: $wrapper"; return 1; }
  [ -f "$manifest" ] || { qa_launchd_err "manifest missing: $manifest"; return 1; }

  local x_label x_wrapper x_manifest x_home x_state x_projects x_env x_log x_path x_summary_config_home
  x_label=$(printf '%s' "$label" | qa_launchd_xml_escape)
  x_wrapper=$(printf '%s' "$wrapper" | qa_launchd_xml_escape)
  x_manifest=$(printf '%s' "$manifest" | qa_launchd_xml_escape)
  x_home=$(printf '%s' "$home" | qa_launchd_xml_escape)
  x_state=$(printf '%s' "$state" | qa_launchd_xml_escape)
  x_projects=$(printf '%s' "$projects" | qa_launchd_xml_escape)
  x_env=$(printf '%s' "$env_file" | qa_launchd_xml_escape)
  x_log=$(printf '%s' "$log_file" | qa_launchd_xml_escape)
  x_summary_config_home=$(printf '%s' "$summary_config_home" | qa_launchd_xml_escape)
  x_path=$(printf '%s' "${FLYWHEEL_QA_LAUNCHD_PATH:-${home}/.local/bin:${home}/.npm-global/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin}" \
    | qa_launchd_xml_escape)
  tmp="${plist}.tmp.$$"
  mkdir -p "$(dirname "$plist")" || return 1
  umask 077
  if ! {
    qa_launchd_plist_open "$x_label"
    qa_launchd_plist_argv_claude "$x_wrapper" "$x_manifest"
    qa_launchd_plist_env_claude "$x_home" "$x_path" "$x_state" \
      "$x_projects" "$x_env" "$x_summary_config_home"
    qa_launchd_plist_close "$x_log"
  } > "$tmp"; then
    rm -f "$tmp"
    qa_launchd_err "failed to render plist: $plist"
    return 1
  fi
  if chmod 600 "$tmp" && mv "$tmp" "$plist"; then
    return 0
  fi
  rm -f "$tmp"
  qa_launchd_err "failed to render plist: $plist"
  return 1
}

qa_launchd_lead_pid() {
  local label="$1" launchctl_bin="${FLYWHEEL_QA_LAUNCHCTL:-launchctl}" out
  out=$("$launchctl_bin" print "$(qa_launchd_domain)/${label}" 2>/dev/null) || return 1
  printf '%s\n' "$out" | awk '/pid =/{print $NF; exit}' | grep -E '^[1-9][0-9]*$'
}

# Bootstrap one unique label and print the live launchd job PID.
qa_launchd_lead_start() {
  local label="$1" plist="$2" launchctl_bin="${FLYWHEEL_QA_LAUNCHCTL:-launchctl}"
  local domain pid
  domain=$(qa_launchd_domain) || return 1
  if "$launchctl_bin" print "${domain}/${label}" >/dev/null 2>&1; then
    qa_launchd_err "label already loaded: $label"
    return 1
  fi
  "$launchctl_bin" bootstrap "$domain" "$plist" \
    || { qa_launchd_err "bootstrap failed: $label"; return 1; }
  for _ in $(seq 1 "${FLYWHEEL_QA_LAUNCHD_PID_POLLS:-50}"); do
    pid=$(qa_launchd_lead_pid "$label" || true)
    if [[ "$pid" =~ ^[1-9][0-9]*$ ]]; then
      printf '%s\n' "$pid"
      return 0
    fi
    sleep "${FLYWHEEL_QA_LAUNCHD_POLL_INTERVAL:-0.1}"
  done
  "$launchctl_bin" bootout "${domain}/${label}" >/dev/null 2>&1 || true
  qa_launchd_err "job never published a PID: $label"
  return 1
}

qa_launchd_lead_stop() {
  local label="$1" launchctl_bin="${FLYWHEEL_QA_LAUNCHCTL:-launchctl}" domain
  domain=$(qa_launchd_domain) || return 1
  if "$launchctl_bin" print "${domain}/${label}" >/dev/null 2>&1; then
    "$launchctl_bin" bootout "${domain}/${label}"
  fi
}

# Verify positive topology evidence, not merely process existence.
# Args: label manifest
qa_launchd_lead_verify() {
  local label="$1" manifest="$2" tmux_bin="${FLYWHEEL_QA_TMUX:-tmux}"
  local launch_pid="" manifest_pid="" socket="" manifest_topology=""
  for _ in $(seq 1 "${FLYWHEEL_QA_LEAD_VERIFY_POLLS:-$QA_LAUNCHD_LEAD_VERIFY_POLLS_DEFAULT}"); do
    manifest_topology=$(jq -er '
      select((.pid | type) == "number" and .pid > 0)
      | select((.socketPath | type) == "string" and (.socketPath | length) > 0)
      | [(.pid | tostring), .socketPath]
      | @tsv
    ' "$manifest" 2>/dev/null || true)
    if [[ -n "$manifest_topology" ]]; then
      IFS=$'\t' read -r manifest_pid socket <<<"$manifest_topology"
      launch_pid=$(qa_launchd_lead_pid "$label" || true)
      if [[ -n "$launch_pid" && "$manifest_pid" == "$launch_pid" ]] \
          && "$tmux_bin" -S "$socket" has-session -t '=main' >/dev/null 2>&1; then
        printf '%s\t%s\n' "$launch_pid" "$socket"
        return 0
      fi
    fi
    sleep "${FLYWHEEL_QA_LEAD_VERIFY_INTERVAL:-$QA_LAUNCHD_LEAD_VERIFY_INTERVAL_DEFAULT}"
  done
  qa_launchd_err "topology verification failed: label=$label launchPid=${launch_pid:-} manifestPid=${manifest_pid:-} socket=${socket:-}"
  return 1
}

# Registry is the only teardown authority for KeepAlive jobs.
# Args: registry label plist manifest
qa_launchd_register() {
  local registry="$1" label="$2" plist="$3" manifest="$4" tmp
  tmp="${registry}.tmp.$$"
  mkdir -p "$(dirname "$registry")" || return 1
  if [ -f "$registry" ]; then
    jq --arg label "$label" --arg plist "$plist" --arg manifest "$manifest" \
      '. + [{label:$label, plist:$plist, manifest:$manifest}] | unique_by(.label)' \
      "$registry" > "$tmp"
  else
    jq -n --arg label "$label" --arg plist "$plist" --arg manifest "$manifest" \
      '[{label:$label, plist:$plist, manifest:$manifest}]' > "$tmp"
  fi
  if jq -e 'type == "array"' "$tmp" >/dev/null 2>&1 \
      && chmod 600 "$tmp" && mv "$tmp" "$registry"; then
    return 0
  fi
  rm -f "$tmp"
  return 1
}

qa_launchd_stop_registry() {
  local registry="$1" label
  [ -f "$registry" ] || return 0
  while IFS= read -r label; do
    [ -z "$label" ] || qa_launchd_lead_stop "$label" || return 1
  done < <(jq -r '.[].label' "$registry")
}
