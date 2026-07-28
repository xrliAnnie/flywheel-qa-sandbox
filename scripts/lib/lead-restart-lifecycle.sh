#!/bin/bash
# FLY-1507: launchd/carrier authority and fleet-candidate lifecycle helpers.
# Source-only; bash 3.2 safe; installs no traps or shell options.

lead_restart_launchctl_print() {
  launchctl print "$1" 2>&1
}

lead_restart_launchd_probe() {
  # stdout: loaded<TAB>pid | unloaded | error
  local target="$1" out="" rc=0 pid=""
  out="$(lead_restart_launchctl_print "$target")" || rc=$?
  if [ "$rc" -eq 0 ]; then
    pid="$(printf '%s\n' "$out" | grep -m1 'pid =' | awk '{print $NF}' || true)"
    case "$pid" in ''|*[!0-9]*) pid=0 ;; esac
    printf 'loaded\t%s\n' "$pid"
    return 0
  fi
  if printf '%s\n' "$out" | grep -qiE 'could not find service|no such process'; then
    printf 'unloaded\n'
    return 0
  fi
  printf 'error\n'
  return 0
}

lead_restart_file_digest() {
  local path="$1"
  [ -f "$path" ] && [ ! -L "$path" ] || return 1
  shasum -a 256 "$path" 2>/dev/null | awk '{print $1}'
}

lead_restart_process_start_identity() {
  LC_ALL=C ps -p "$1" -o lstart= 2>/dev/null \
    | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//'
}

lead_restart_process_alive() {
  kill -0 "$1" 2>/dev/null
}

lead_restart_process_table() {
  LC_ALL=C ps -axo pid=,command= 2>/dev/null
}

lead_restart_sleep() {
  sleep "$1"
}

_lead_restart_plist_json() {
  local plist="$1"
  [ -f "$plist" ] && [ ! -L "$plist" ] || return 1
  python3 - "$plist" 2>/dev/null <<'PY'
import json
import plistlib
import sys

with open(sys.argv[1], "rb") as handle:
    value = plistlib.load(handle)
label = value.get("Label")
argv = value.get("ProgramArguments")
if not isinstance(label, str) or not label or "\n" in label or "\t" in label:
    raise SystemExit(1)
if not isinstance(argv, list) or not argv:
    raise SystemExit(1)
if any(not isinstance(arg, str) or not arg or "\n" in arg or "\t" in arg for arg in argv):
    raise SystemExit(1)
print(json.dumps({"label": label, "argv": argv}, separators=(",", ":")))
PY
}

_lead_restart_manifest_identity() {
  local manifest="$1"
  jq -er '
    (.projectName // "") as $project |
    (.leadId // "") as $lead |
    if ($project|type) == "string" and ($project|length) > 0
       and ($lead|type) == "string" and ($lead|length) > 0
       and ($project|contains("\t")|not) and ($project|contains("\n")|not)
       and ($lead|contains("\t")|not) and ($lead|contains("\n")|not)
    then [$project,$lead] | @tsv
    else error("invalid manifest identity")
    end
  ' "$manifest" 2>/dev/null
}

lead_restart_project_backend() {
  local projects_file="$1" project="$2" lead_id="$3"
  jq -er --arg project "$project" --arg lead "$lead_id" '
    [
      .[] |
      select(.projectName == $project) |
      (.leads // [])[] |
      select(.agentId == $lead)
    ] |
    if length == 1
    then (.[0].backend // "claude-code")
    else error("project lead identity is missing or ambiguous")
    end
  ' "$projects_file" 2>/dev/null
}

_lead_restart_config_identity_for_key() {
  local projects_file="$1" key="$2"
  jq -er --arg key "$key" '
    [
      .[] as $project |
      ($project.leads // [])[] |
      select(($project.projectName + "-" + .agentId) == $key) |
      [$project.projectName, .agentId]
    ] |
    if length == 1 then .[0] | @tsv
    else error("candidate identity is missing or ambiguous")
    end
  ' "$projects_file" 2>/dev/null
}

LEAD_RESTART_BACKEND=""
LEAD_RESTART_PROJECT=""
LEAD_RESTART_LEAD_ID=""
LEAD_RESTART_LABEL=""
LEAD_RESTART_MANIFEST_FILE=""
LEAD_RESTART_PLIST_FILE=""
LEAD_RESTART_PROJECTS_FILE=""
LEAD_RESTART_MANIFEST_DIGEST=""
LEAD_RESTART_PLIST_DIGEST=""
LEAD_RESTART_PROJECTS_DIGEST=""

_lead_restart_validate_authority_once() {
  local manifest="$1" plist="$2" projects_file="$3" expected_label="$4"
  local identity project lead_id plist_json label argc arg0 wrapper arg2=""
  local wrapper_base manifest_backend project_backend backend
  identity="$(_lead_restart_manifest_identity "$manifest")" || return 1
  project="${identity%%$'\t'*}"
  lead_id="${identity#*$'\t'}"
  plist_json="$(_lead_restart_plist_json "$plist")" || return 1
  label="$(printf '%s' "$plist_json" | jq -er '.label')" || return 1
  [ "$label" = "$expected_label" ] || return 1
  [ "$label" = "com.flywheel.lead.${project}-${lead_id}" ] || return 1
  argc="$(printf '%s' "$plist_json" | jq -er '.argv | length')" || return 1
  arg0="$(printf '%s' "$plist_json" | jq -er '.argv[0]')" || return 1
  wrapper="$(printf '%s' "$plist_json" | jq -er '.argv[1]')" || return 1
  [ "$arg0" = "/bin/bash" ] || return 1
  wrapper_base="${wrapper##*/}"
  manifest_backend="$(jq -er '.leadBackend.backendId // ""' "$manifest" 2>/dev/null)" || return 1
  project_backend="$(lead_restart_project_backend "$projects_file" "$project" "$lead_id")" || return 1

  case "$wrapper_base" in
    flywheel-lead-wrapper.sh)
      [ "$argc" -eq 3 ] || return 1
      arg2="$(printf '%s' "$plist_json" | jq -er '.argv[2]')" || return 1
      [ "$arg2" = "$manifest" ] || return 1
      [ "$project_backend" = "claude-code" ] || return 1
      case "$manifest_backend" in ""|claude-code) ;; *) return 1 ;; esac
      backend="claude-code"
      ;;
    flywheel-codex-lead-wrapper-mufasa-tui-fullaccess.sh)
      [ "$argc" -eq 2 ] || return 1
      [ "$project" = "growth" ] && [ "$lead_id" = "mufasa-lead" ] || return 1
      [ "$project_backend" = "codex-app-server" ] || return 1
      case "$manifest_backend" in ""|codex-app-server) ;; *) return 1 ;; esac
      backend="codex-app-server"
      ;;
    flywheel-codex-lead-wrapper-codex-infra-bot.sh)
      [ "$argc" -eq 2 ] || return 1
      [ "$project" = "flywheel" ] && [ "$lead_id" = "codex-infra-bot-lead" ] || return 1
      [ "$project_backend" = "codex-app-server" ] || return 1
      case "$manifest_backend" in ""|codex-app-server) ;; *) return 1 ;; esac
      backend="codex-app-server"
      ;;
    *)
      # Includes the retired mufasa-tui.sh carrier and any future carrier not
      # explicitly reviewed for destructive restart authority.
      return 1
      ;;
  esac

  LEAD_RESTART_BACKEND="$backend"
  LEAD_RESTART_PROJECT="$project"
  LEAD_RESTART_LEAD_ID="$lead_id"
  LEAD_RESTART_LABEL="$label"
  return 0
}

lead_restart_validate_authority() {
  local manifest="$1" plist="$2" projects_file="$3" expected_label="$4"
  local manifest_digest plist_digest projects_digest
  [ -f "$manifest" ] && [ ! -L "$manifest" ] || return 1
  [ -f "$projects_file" ] && [ ! -L "$projects_file" ] || return 1
  manifest_digest="$(lead_restart_file_digest "$manifest")" || return 1
  plist_digest="$(lead_restart_file_digest "$plist")" || return 1
  projects_digest="$(lead_restart_file_digest "$projects_file")" || return 1
  _lead_restart_validate_authority_once "$manifest" "$plist" "$projects_file" "$expected_label" || return 1
  LEAD_RESTART_MANIFEST_FILE="$manifest"
  LEAD_RESTART_PLIST_FILE="$plist"
  LEAD_RESTART_PROJECTS_FILE="$projects_file"
  LEAD_RESTART_MANIFEST_DIGEST="$manifest_digest"
  LEAD_RESTART_PLIST_DIGEST="$plist_digest"
  LEAD_RESTART_PROJECTS_DIGEST="$projects_digest"
  return 0
}

lead_restart_authority_unchanged() {
  local backend="$LEAD_RESTART_BACKEND" project="$LEAD_RESTART_PROJECT"
  local lead_id="$LEAD_RESTART_LEAD_ID" label="$LEAD_RESTART_LABEL"
  local manifest_digest plist_digest projects_digest
  [ -n "$LEAD_RESTART_MANIFEST_FILE" ] && [ -n "$LEAD_RESTART_PLIST_FILE" ] \
    && [ -n "$LEAD_RESTART_PROJECTS_FILE" ] || return 1
  manifest_digest="$(lead_restart_file_digest "$LEAD_RESTART_MANIFEST_FILE")" || return 1
  plist_digest="$(lead_restart_file_digest "$LEAD_RESTART_PLIST_FILE")" || return 1
  projects_digest="$(lead_restart_file_digest "$LEAD_RESTART_PROJECTS_FILE")" || return 1
  [ "$manifest_digest" = "$LEAD_RESTART_MANIFEST_DIGEST" ] || return 1
  [ "$plist_digest" = "$LEAD_RESTART_PLIST_DIGEST" ] || return 1
  [ "$projects_digest" = "$LEAD_RESTART_PROJECTS_DIGEST" ] || return 1
  _lead_restart_validate_authority_once \
    "$LEAD_RESTART_MANIFEST_FILE" "$LEAD_RESTART_PLIST_FILE" \
    "$LEAD_RESTART_PROJECTS_FILE" "$label" || return 1
  [ "$LEAD_RESTART_BACKEND" = "$backend" ] \
    && [ "$LEAD_RESTART_PROJECT" = "$project" ] \
    && [ "$LEAD_RESTART_LEAD_ID" = "$lead_id" ] \
    && [ "$LEAD_RESTART_LABEL" = "$label" ]
}

lead_restart_old_tuple_dead() {
  local pid="$1" expected_start="$2" actual_start
  case "$pid" in ""|0) return 0 ;; *[!0-9]*) return 1 ;; esac
  lead_restart_process_alive "$pid" || return 0
  actual_start="$(lead_restart_process_start_identity "$pid")" || return 1
  [ "$actual_start" != "$expected_start" ]
}

_lead_restart_claude_supervisor_present() {
  local project="$1" lead_id="$2" snapshot line_pid command had_noglob token
  snapshot="$(lead_restart_process_table)" || return 2
  while read -r line_pid command; do
    case "$line_pid" in ""|*[!0-9]*) continue ;; esac
    had_noglob=0
    case "$-" in *f*) had_noglob=1 ;; *) set -f ;; esac
    # shellcheck disable=SC2086
    set -- $command
    [ "$had_noglob" -eq 1 ] || set +f
    while [ "$#" -gt 0 ]; do
      token="${1##*/}"
      shift
      if [ "$token" = "claude-lead.sh" ]; then
        [ "${1:-}" = "$lead_id" ] && [ "${3:-}" = "$project" ] && return 0
        break
      fi
    done
  done <<EOF
$snapshot
EOF
  return 1
}

_lead_restart_codex_assertion_quiet() {
  local assertion_file="$1" key="$2" pid lstart actual
  [ -e "$assertion_file" ] || return 0
  [ -f "$assertion_file" ] && [ ! -L "$assertion_file" ] || return 2
  pid="$(jq -er --arg key "$key" '
    select(.schemaVersion == 1 and .leadKey == $key)
    | .pid | select(type == "number" and . > 0 and (floor == .))
  ' "$assertion_file" 2>/dev/null)" || return 2
  lstart="$(jq -er '.lstart | select(type == "string" and length > 0)' "$assertion_file" 2>/dev/null)" || return 2
  lead_restart_process_alive "$pid" || return 0
  actual="$(lead_restart_process_start_identity "$pid")" || return 2
  [ "$actual" != "$lstart" ]
}

lead_restart_wait_quiescent() {
  local target="$1" old_pid="$2" old_start="$3" backend="$4"
  local project="$5" lead_id="$6" assertion_file="$7"
  local attempts="${LEAD_RESTART_QUIESCENCE_ATTEMPTS:-${LEAD_QUIESCENCE_ATTEMPTS:-30}}"
  local interval="${LEAD_RESTART_QUIESCENCE_INTERVAL:-${LEAD_QUIESCENCE_INTERVAL:-1}}"
  local count=0 probe supervisor_rc assertion_rc
  while [ "$count" -lt "$attempts" ]; do
    probe="$(lead_restart_launchd_probe "$target")"
    [ "$probe" = "error" ] && return 2
    if [ "$probe" = "unloaded" ] && lead_restart_old_tuple_dead "$old_pid" "$old_start"; then
      if [ "$backend" = "claude-code" ]; then
        supervisor_rc=0
        _lead_restart_claude_supervisor_present "$project" "$lead_id" || supervisor_rc=$?
        [ "$supervisor_rc" -eq 2 ] && return 2
        [ "$supervisor_rc" -eq 1 ] && return 0
      else
        assertion_rc=0
        _lead_restart_codex_assertion_quiet "$assertion_file" "${project}-${lead_id}" || assertion_rc=$?
        [ "$assertion_rc" -eq 2 ] && return 2
        [ "$assertion_rc" -eq 0 ] && return 0
      fi
    fi
    lead_restart_sleep "$interval"
    count=$((count + 1))
  done
  return 1
}

lead_restart_recovery_bootstrap_allowed() {
  local backend="$1" old_tuple_dead="$2" sweep_safe="$3"
  [ "$old_tuple_dead" = "true" ] || return 1
  case "$backend" in
    claude-code) return 0 ;;
    codex-app-server) [ "$sweep_safe" = "true" ] ;;
    *) return 1 ;;
  esac
}

_lead_restart_candidate_add() {
  local file="$1" key="$2" project="$3" lead_id="$4" manifest="$5" classification="$6" source="$7"
  [ -n "$project" ] || project="-"
  [ -n "$lead_id" ] || lead_id="-"
  [ -n "$manifest" ] || manifest="-"
  printf '%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$key" "$project" "$lead_id" "$manifest" "$classification" "$source" >> "$file"
}

_lead_restart_plist_key_and_manifest() {
  local plist="$1" json label argc manifest="-"
  json="$(_lead_restart_plist_json "$plist")" || return 1
  label="$(printf '%s' "$json" | jq -er '.label')" || return 1
  case "$label" in com.flywheel.lead.*) ;; *) return 1 ;; esac
  argc="$(printf '%s' "$json" | jq -er '.argv | length')" || return 1
  if [ "$argc" -ge 3 ]; then
    manifest="$(printf '%s' "$json" | jq -er '.argv[2]')" || return 1
  fi
  printf '%s\t%s\n' "${label#com.flywheel.lead.}" "$manifest"
}

_lead_restart_parse_legacy_identity() {
  local command="$1" token had_noglob=0
  case "$-" in *f*) had_noglob=1 ;; *) set -f ;; esac
  # shellcheck disable=SC2086
  set -- $command
  [ "$had_noglob" -eq 1 ] || set +f
  while [ "$#" -gt 0 ]; do
    token="${1##*/}"
    shift
    if [ "$token" = "claude-lead.sh" ]; then
      [ "$#" -ge 3 ] || return 1
      printf '%s\t%s\n' "$3" "$1"
      return 0
    fi
  done
  return 1
}

_lead_restart_normalize_candidates() {
  local raw="$1" out="$2"
  awk -F '\t' '
    function priority(c) {
      if (c == "probe-error" || c == "config-drift") return 5
      if (c == "restart") return 4
      if (c == "manifestless") return 3
      if (c == "skip-test") return 1
      return 0
    }
    NF >= 6 {
      key=$1
      if (!(key in seen)) {
        seen[key]=++count; order[count]=key
        project[key]=$2; lead[key]=$3; manifest[key]=$4
        class[key]=$5; sources[key]=$6
      } else {
        if (manifest[key] == "-" && $4 != "-") manifest[key]=$4
        if (project[key] == "-" && $2 != "-") project[key]=$2
        if (lead[key] == "-" && $3 != "-") lead[key]=$3
        if (sources[key] !~ ("(^|,)" $6 "(,|$)")) sources[key]=sources[key] "," $6
        if (priority($5) > priority(class[key])) class[key]=$5
      }
      if ($3 ~ /^flywheel-test-/ || $5 == "skip-test") isqa[key]=1
    }
    END {
      for (i=1; i<=count; i++) {
        key=order[i]
        if (isqa[key]) class[key]="skip-test"
        print key "\t" project[key] "\t" lead[key] "\t" manifest[key] "\t" class[key] "\t" sources[key]
      }
    }
  ' "$raw" | sort > "$out"
}

lead_restart_collect_candidates() {
  local manifest_dir="$1" plist_dir="$2" projects_file="$3" out_file="$4"
  local raw="${out_file}.raw.$$" manifest identity project lead_id key class
  : > "$raw" || return 2
  if [ ! -f "$projects_file" ] || [ -L "$projects_file" ] \
    || ! jq -e 'type == "array"' "$projects_file" >/dev/null 2>&1; then
    rm -f "$raw"
    return 2
  fi

  local old_nullglob
  old_nullglob="$(shopt -p nullglob || true)"
  shopt -s nullglob
  local manifests=("$manifest_dir"/*.json)
  local plists=("$plist_dir"/com.flywheel.lead.*.plist)
  eval "$old_nullglob"

  for manifest in ${manifests[@]+"${manifests[@]}"}; do
    identity="$(_lead_restart_manifest_identity "$manifest")" || {
      key="${manifest##*/}"; key="${key%.json}"
      _lead_restart_candidate_add "$raw" "$key" "-" "-" "$manifest" "config-drift" "manifest"
      continue
    }
    project="${identity%%$'\t'*}"
    lead_id="${identity#*$'\t'}"
    key="${project}-${lead_id}"
    case "$lead_id" in
      flywheel-test-*) class="skip-test" ;;
      *) lead_restart_project_backend "$projects_file" "$project" "$lead_id" >/dev/null 2>&1 \
           && class="restart" || class="config-drift" ;;
    esac
    _lead_restart_candidate_add "$raw" "$key" "$project" "$lead_id" "$manifest" "$class" "manifest"
  done

  local plist pair target probe candidate_manifest
  for plist in ${plists[@]+"${plists[@]}"}; do
    pair="$(_lead_restart_plist_key_and_manifest "$plist")" || {
      key="${plist##*/}"; key="${key#com.flywheel.lead.}"; key="${key%.plist}"
      target="gui/$(id -u)/com.flywheel.lead.${key}"
      probe="$(lead_restart_launchd_probe "$target")"
      [ "$probe" = "unloaded" ] && continue
      class="config-drift"
      [ "$probe" = "error" ] && class="probe-error"
      _lead_restart_candidate_add "$raw" "$key" "-" "-" "-" "$class" "plist"
      continue
    }
    key="${pair%%$'\t'*}"
    candidate_manifest="${pair#*$'\t'}"
    target="gui/$(id -u)/com.flywheel.lead.${key}"
    probe="$(lead_restart_launchd_probe "$target")"
    [ "$probe" = "unloaded" ] && continue
    if [ "$probe" = "error" ]; then
      _lead_restart_candidate_add "$raw" "$key" "-" "-" "-" "probe-error" "plist"
      continue
    fi
    identity=""
    if [ "$candidate_manifest" != "-" ] && [ -f "$candidate_manifest" ]; then
      identity="$(_lead_restart_manifest_identity "$candidate_manifest" 2>/dev/null || true)"
    fi
    [ -n "$identity" ] || identity="$(_lead_restart_config_identity_for_key "$projects_file" "$key" 2>/dev/null || true)"
    if [ -z "$identity" ]; then
      _lead_restart_candidate_add "$raw" "$key" "-" "-" "-" "config-drift" "plist"
      continue
    fi
    project="${identity%%$'\t'*}"
    lead_id="${identity#*$'\t'}"
    case "$lead_id" in
      flywheel-test-*) class="skip-test" ;;
      *)
        if [ "$candidate_manifest" != "-" ] && [ -f "$candidate_manifest" ]; then
          class="restart"
        else
          class="manifestless"
        fi
        ;;
    esac
    _lead_restart_candidate_add "$raw" "$key" "$project" "$lead_id" \
      "$([ -f "$candidate_manifest" ] && printf '%s' "$candidate_manifest" || printf '-')" \
      "$class" "plist"
  done

  local snapshot="" snapshot_rc=0 line_pid command legacy_identity
  snapshot="$(lead_restart_process_table)" || snapshot_rc=$?
  if [ "$snapshot_rc" -ne 0 ]; then
    rm -f "$raw"
    return 2
  fi
  while read -r line_pid command; do
    case "$line_pid" in ""|*[!0-9]*) continue ;; esac
    legacy_identity="$(_lead_restart_parse_legacy_identity "$command" 2>/dev/null || true)"
    [ -n "$legacy_identity" ] || continue
    project="${legacy_identity%%$'\t'*}"
    lead_id="${legacy_identity#*$'\t'}"
    key="${project}-${lead_id}"
    case "$lead_id" in
      flywheel-test-*) class="skip-test" ;;
      *) lead_restart_project_backend "$projects_file" "$project" "$lead_id" >/dev/null 2>&1 \
           && class="manifestless" || class="config-drift" ;;
    esac
    _lead_restart_candidate_add "$raw" "$key" "$project" "$lead_id" "-" "$class" "process"
  done <<EOF
$snapshot
EOF

  _lead_restart_normalize_candidates "$raw" "$out_file"
  rm -f "$raw"
  return 0
}
