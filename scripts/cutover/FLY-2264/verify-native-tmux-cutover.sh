#!/bin/bash
# FLY-2274: read-only native tmux cutover acceptance verifier.
# Function definitions are source-safe so the architecture authority can be
# exercised hermetically. Production execution is dispatched at EOF.

fly2264_artifact_names() {
  printf '%s\n' \
    01-updater.json \
    02-lead-census.json \
    03-native-tmux.json \
    04-tmux-servers.json \
    05-lead-health.json \
    06-cmux.json \
    07-path.json
}

fly2264_verify_process_native() {
  local pid="$1" start_before identity flags flags_value txt line path
  local main_image="" main_count=0 architecture="" candidate_architecture start_after

  [[ "$pid" =~ ^[1-9][0-9]*$ ]] || {
    printf 'invalid pid: %s\n' "$pid" >&2
    return 1
  }
  start_before="$(TZ=UTC LC_ALL=C ps -o lstart= -p "$pid" 2>/dev/null | sed 's/^ *//')" || return 1
  [ -n "$start_before" ] || {
    printf 'missing start identity for pid %s\n' "$pid" >&2
    return 1
  }
  identity="$(ps -o pid=,flags= -p "$pid" 2>/dev/null)" || return 1
  # Deliberate field split: ps must yield exactly PID and flags.
  # shellcheck disable=SC2086
  set -- $identity
  [ "$#" -eq 2 ] && [ "$1" = "$pid" ] || {
    printf 'ambiguous flags identity for pid %s\n' "$pid" >&2
    return 1
  }
  flags="${2#0x}"
  [[ "$flags" =~ ^[0-9A-Fa-f]+$ ]] || {
    printf 'invalid process flags for pid %s\n' "$pid" >&2
    return 1
  }
  flags_value="$(python3 -c 'import sys; print(int(sys.argv[1], 16))' "$flags" 2>/dev/null)" || return 1
  if (( (flags_value & 0x00020000) != 0 )); then
    printf 'process pid %s is translated (flags=%s)\n' "$pid" "$flags" >&2
    return 1
  fi

  txt="$(lsof -a -p "$pid" -d txt -Fn 2>/dev/null)" || {
    printf 'cannot inspect text images for pid %s\n' "$pid" >&2
    return 1
  }
  while IFS= read -r line; do
    case "$line" in n*) path="${line#n}" ;; *) continue ;; esac
    case "$path" in
      *.aot|*.dylib|/usr/libexec/rosetta/*|/Library/Apple/usr/libexec/oah/*) continue ;;
    esac
    candidate_architecture="$(file -b "$path" 2>/dev/null)" || return 1
    case "$candidate_architecture" in
      *Mach-O*executable*)
        main_image="$path"
        architecture="$candidate_architecture"
        main_count=$((main_count + 1))
        ;;
    esac
  done <<<"$txt"
  [ "$main_count" -eq 1 ] || {
    printf 'process pid %s has %s candidate main images; expected exactly one\n' "$pid" "$main_count" >&2
    return 1
  }
  [ -f "$main_image" ] && [ ! -L "$main_image" ] || {
    printf 'main image is not a regular non-symlink file for pid %s: %s\n' "$pid" "$main_image" >&2
    return 1
  }
  case "$architecture" in *arm64*) ;; *)
    printf 'main image is not arm64-capable for pid %s: %s\n' "$pid" "$architecture" >&2
    return 1
  esac
  start_after="$(TZ=UTC LC_ALL=C ps -o lstart= -p "$pid" 2>/dev/null | sed 's/^ *//')" || return 1
  [ "$start_after" = "$start_before" ] || {
    printf 'process identity changed during verification for pid %s\n' "$pid" >&2
    return 1
  }

  jq -cn --argjson pid "$pid" --arg startIdentity "$start_before" \
    --arg flags "$flags" --arg mainImage "$main_image" --arg architecture "$architecture" \
    '{pid:$pid,startIdentity:$startIdentity,flags:$flags,translated:false,mainImage:$mainImage,architecture:$architecture,arm64Capable:true}'
}

fly2264_real_path() {
  python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$1"
}

fly2264_launchd_pid() {
  local label="$1" out="" pid_lines="" pid=""
  out="$(launchctl print "gui/$(id -u)/${label}" 2>&1)" || {
    printf 'launchd label is not loaded: %s\n' "$label" >&2
    return 1
  }
  printf '%s\n' "$out" | grep -Eq '^[[:space:]]*state = running[[:space:]]*$' || {
    printf 'launchd label is not running: %s\n' "$label" >&2
    return 1
  }
  pid_lines="$(printf '%s\n' "$out" | sed -n 's/^[[:space:]]*pid = \([1-9][0-9]*\)[[:space:]]*$/\1/p')"
  [ "$(printf '%s\n' "$pid_lines" | awk 'NF {n++} END {print n+0}')" -eq 1 ] || {
    printf 'launchd pid is missing or ambiguous: %s\n' "$label" >&2
    return 1
  }
  pid="$(printf '%s\n' "$pid_lines" | awk 'NF {print}')"
  printf '%s\n' "$pid"
}

fly2264_process_path() {
  local pid="$1" raw="" value=""
  raw="$(ps eww -p "$pid" -o command= 2>/dev/null)" || return 1
  value="$(printf '%s\n' "$raw" | awk '
    {
      for (i=1; i<=NF; i++) if ($i ~ /^PATH=/) { value=substr($i,6); count++ }
    }
    END { if (count == 1 && value != "") print value; else exit 1 }
  ')" || {
    printf 'PATH is missing or ambiguous for pid %s\n' "$pid" >&2
    return 1
  }
  case "$value" in *$'\n'*|*$'\r'*) return 1 ;; esac
  printf '%s\n' "$value"
}

fly2264_assert_native_first_path() {
  local value="$1" segment index=0 native_index=-1 legacy_index=-1
  local old_ifs="$IFS"
  IFS=:
  for segment in $value; do
    [ "$segment" != /opt/homebrew/bin ] || {
      [ "$native_index" -eq -1 ] || return 1
      native_index="$index"
    }
    [ "$segment" != /usr/local/bin ] || {
      [ "$legacy_index" -eq -1 ] || return 1
      legacy_index="$index"
    }
    index=$((index + 1))
  done
  IFS="$old_ifs"
  [ "$native_index" -ge 0 ] && [ "$legacy_index" -ge 0 ] \
    && [ "$native_index" -lt "$legacy_index" ]
}

fly2264_bridge_path_wrapper() {
  local plist="$HOME/Library/LaunchAgents/com.flywheel.bridge.plist" wrapper=""
  [ -f "$plist" ] && [ ! -L "$plist" ] || return 1
  wrapper="$(python3 - "$plist" <<'PY'
import plistlib
import sys

try:
    with open(sys.argv[1], "rb") as handle:
        args = plistlib.load(handle).get("ProgramArguments")
except Exception:
    raise SystemExit(1)
if not isinstance(args, list) or len(args) != 2 or args[0] != "/bin/bash":
    raise SystemExit(1)
wrapper = args[1]
if not isinstance(wrapper, str) or not wrapper.startswith("/") or "\n" in wrapper or "\r" in wrapper:
    raise SystemExit(1)
print(wrapper)
PY
)" || return 1
  [ "$(basename "$wrapper")" = flywheel-bridge-wrapper.sh ] || return 1
  [ -f "$wrapper" ] && [ ! -L "$wrapper" ] && [ -x "$wrapper" ] || return 1
  # This is the literal reviewed wrapper contract, not shell interpolation.
  # shellcheck disable=SC2016
  grep -Fxq 'export PATH="${HOME}/.local/bin:${HOME}/.npm-global/bin:/opt/homebrew/bin:/usr/local/bin:${PATH}"' \
    "$wrapper" || return 1
  printf '%s\n' "$wrapper"
}

# stdout: launchd's default PATH. rc=2 means launchd exposes no PATH field;
# callers record that authority as explicitly unavailable instead of turning a
# proven wrapper prefix into a false cutover failure. Ambiguous output is rc=1.
fly2264_launchd_default_path() {
  local label="$1" out="" value="" rc=0
  out="$(launchctl print "gui/$(id -u)/${label}" 2>&1)" || return 1
  value="$(printf '%s\n' "$out" | awk '
    /^[[:space:]]*default environment = \{[[:space:]]*$/ { in_default=1; next }
    in_default && /^[[:space:]]*\}[[:space:]]*$/ { in_default=0; next }
    in_default && /^[[:space:]]*PATH => / {
      line=$0
      sub(/^[[:space:]]*PATH => /, "", line)
      value=line
      count++
    }
    END {
      if (count == 0) exit 2
      if (count != 1 || value == "") exit 1
      print value
    }
  ')" || rc=$?
  [ "$rc" -eq 0 ] || return "$rc"
  case "$value" in *$'\n'*|*$'\r'*) return 1 ;; esac
  printf '%s\n' "$value"
}

fly2264_bound_text() {
  LC_ALL=C head -c 1200 "$1" 2>/dev/null | tr '\r\n\t' '   '
}

fly2264_write_json_atomic() {
  local destination="$1" source="$2" tmp=""
  tmp="$(mktemp "${FLY2264_VERIFY_ARTIFACT_DIR}/.artifact.XXXXXX")" || return 1
  chmod 600 "$tmp" || { rm -f "$tmp"; return 1; }
  jq -e 'select(type == "object")' "$source" >"$tmp" || { rm -f "$tmp"; return 1; }
  mv "$tmp" "$destination"
}

fly2264_run_producer() {
  local artifact="$1" producer="$2" started finished rc=0 status evidence='{}'
  local scratch out err record producer_pid=""
  scratch="$(mktemp -d -t fly2264-producer.XXXXXX)" || return 1
  out="$scratch/out"
  err="$scratch/err"
  started="$(date +%s)"
  trap '[ -z "$producer_pid" ] || { kill "$producer_pid" 2>/dev/null || true; wait "$producer_pid" 2>/dev/null || true; }; exit 143' TERM INT
  ( "$producer" ) >"$out" 2>"$err" &
  producer_pid=$!
  wait "$producer_pid" || rc=$?
  producer_pid=""
  trap - TERM INT
  finished="$(date +%s)"
  status=fail
  if [ "$rc" -eq 0 ] && jq -e 'type == "object"' "$out" >/dev/null 2>&1; then
    status=pass
    evidence="$(cat "$out")"
  elif [ "$rc" -eq 0 ]; then
    rc=65
  fi
  record="$scratch/record"
  jq -n --arg artifact "$artifact" --arg status "$status" \
    --argjson exitCode "$rc" --argjson durationSeconds "$((finished - started))" \
    --arg error "$(fly2264_bound_text "$err")" --argjson evidence "$evidence" \
    '{schemaVersion:1,artifact:$artifact,status:$status,exitCode:$exitCode,durationSeconds:$durationSeconds,error:$error,evidence:$evidence}' \
    >"$record" || { rm -rf "$scratch"; return 1; }
  fly2264_write_json_atomic "$FLY2264_VERIFY_ARTIFACT_DIR/$artifact" "$record" || {
    rm -rf "$scratch"
    return 1
  }
  rm -rf "$scratch"
  [ "$status" = pass ]
}

fly2264_expected_supervisors() {
  local generated
  generated="$(mktemp -t fly2264-labels.XXXXXX)" || return 1
  "$FLY2264_VERIFY_SELF_DIR/generate-supervisor-labels.sh" \
    "$HOME/Library/LaunchAgents" >"$generated" || { rm -f "$generated"; return 1; }
  cmp -s "$generated" "$FLY2264_VERIFY_SELF_DIR/supervisor-labels.txt" || {
    printf 'installed supervisor sample differs from fresh census\n' >&2
    rm -f "$generated"
    return 1
  }
  cat "$generated"
  rm -f "$generated"
}

fly2264_verify_updater() {
  local status_file="$HOME/.flywheel/leads-restart-status.json"
  local deployed_file="$HOME/.flywheel/deployed-sha" health=""
  [ -f "$status_file" ] && [ ! -L "$status_file" ] || return 1
  [ -f "$deployed_file" ] && [ ! -L "$deployed_file" ] || return 1
  jq -e --arg sha "$FLY2264_VERIFY_CUTOVER_SHA" '
    .schemaVersion == 1 and .reason == "updater"
    and .leadsRestartStatus == "healthy"
    and .failed == 0
    and (.skipped | type == "number" and floor == . and . >= 0)
    and (.total | type == "number" and floor == . and . == 16)
    and .codeDeployedSha == $sha' "$status_file" >/dev/null || return 1
  [ "$(cat "$deployed_file")" = "$FLY2264_VERIFY_CUTOVER_SHA" ] || return 1
  health="$(curl -fsS --max-time 5 http://localhost:9876/health)" || return 1
  printf '%s' "$health" | jq -e --arg sha "$FLY2264_VERIFY_CUTOVER_SHA" '
    .ok == true and .buildSha == $sha and .artifactBuildSha == $sha' >/dev/null || return 1
  jq -n --arg sha "$FLY2264_VERIFY_CUTOVER_SHA" \
    --argjson restart "$(jq -c '{reason,leadsRestartStatus,failed,skipped,total,codeDeployedSha}' "$status_file")" \
    --argjson bridge "$(printf '%s' "$health" | jq -c '{ok,buildSha,artifactBuildSha}')" \
    '{cutoverSha:$sha,restart:$restart,deployedSha:$sha,bridge:$bridge}'
}

fly2264_verify_lead_census() {
  local labels candidates label key pid census counts receipts='[]' carrier receipt failed=0
  local carrier_spec carrier_count
  labels="$(mktemp -t fly2264-census-labels.XXXXXX)" || return 1
  candidates="$(mktemp -t fly2264-census-candidates.XXXXXX)" || { rm -f "$labels"; return 1; }
  fly2264_expected_supervisors >"$labels" || { rm -f "$labels" "$candidates"; return 1; }
  : >"$candidates"
  while IFS= read -r label; do
    case "$label" in com.flywheel.lead.*) ;; *) continue ;; esac
    pid="$(fly2264_launchd_pid "$label")" || { failed=1; break; }
    key="${label#com.flywheel.lead.}"
    printf '%s\t-\t-\t-\trestart\tplist\n' "$key" >>"$candidates"
  done <"$labels"
  [ "$failed" -eq 0 ] || { rm -f "$labels" "$candidates"; return 1; }
  [ "$(wc -l <"$candidates" | tr -d ' ')" -eq 16 ] || { rm -f "$labels" "$candidates"; return 1; }
  census="$("$FLY2264_VERIFY_LIVE_REPO/scripts/host-tmux-selection-gate.sh" census "$candidates" 2>&1)" \
    || { printf '%s\n' "$census" >&2; rm -f "$labels" "$candidates"; return 1; }
  [[ "$census" =~ census[[:space:]]pass[[:space:]]plists=16[[:space:]]generic=([0-9]+)[[:space:]]codex-mufasa=([0-9]+)[[:space:]]codex-infra-bot=([0-9]+)[[:space:]]codex-raya=([0-9]+)$ ]] \
    || { printf 'unparseable census result: %s\n' "$census" >&2; rm -f "$labels" "$candidates"; return 1; }
  counts="${BASH_REMATCH[1]} ${BASH_REMATCH[2]} ${BASH_REMATCH[3]} ${BASH_REMATCH[4]}"
  # Deliberate split of the four regex-captured integer counters.
  # shellcheck disable=SC2086
  set -- $counts
  [ $(( $1 + $2 + $3 + $4 )) -eq 16 ] || { rm -f "$labels" "$candidates"; return 1; }
  for carrier_spec in "lead:$1" "codex-mufasa:$2" "codex-infra-bot:$3" "codex-raya:$4"; do
    carrier="${carrier_spec%%:*}"
    carrier_count="${carrier_spec#*:}"
    [ "$carrier_count" -gt 0 ] || continue
    receipt="$HOME/.flywheel/state/host-tmux/${carrier}.json"
    [ -f "$receipt" ] && [ ! -L "$receipt" ] || { rm -f "$labels" "$candidates"; return 1; }
    jq -e --arg sha "$FLY2264_VERIFY_CUTOVER_SHA" --arg carrier "$carrier" '
      .schemaVersion == 1 and .carrier == $carrier and .targetSha == $sha
      and .tmuxVersion == "tmux 3.7c"
      and (.architecture | type == "string" and contains("arm64"))
      and .verdict == "pass"' "$receipt" >/dev/null || { rm -f "$labels" "$candidates"; return 1; }
    receipts="$(printf '%s' "$receipts" | jq -c --arg carrier "$carrier" '. + [$carrier]')"
  done
  rm -f "$labels" "$candidates"
  jq -n --arg census "$census" --argjson generic "$1" --argjson mufasa "$2" \
    --argjson infra "$3" --argjson raya "$4" --argjson receipts "$receipts" \
    '{loadedLeads:16,census:$census,counts:{generic:$generic,codexMufasa:$mufasa,codexInfraBot:$infra,codexRaya:$raya},carrierReceipts:$receipts}'
}

fly2264_verify_native_tmux() {
  local linked="$FLY2264_VERIFY_LINKED_TMUX" canonical version architecture pinned
  [ -x "$linked" ] || return 1
  canonical="$(fly2264_real_path "$linked")" || return 1
  [ "$canonical" = "$FLY2264_VERIFY_NATIVE_TMUX" ] || return 1
  [ -f "$canonical" ] && [ ! -L "$canonical" ] || return 1
  version="$("$linked" -V 2>/dev/null)" || return 1
  [ "$version" = 'tmux 3.7c' ] || return 1
  architecture="$(file -b "$canonical" 2>/dev/null)" || return 1
  case "$architecture" in *arm64*) ;; *) return 1 ;; esac
  pinned="$("$FLY2264_VERIFY_BREW" list --pinned 2>/dev/null)" || return 1
  printf '%s\n' "$pinned" | grep -Fxq tmux || return 1
  jq -n --arg linked "$linked" --arg canonical "$canonical" --arg version "$version" \
    --arg architecture "$architecture" '{linkedPath:$linked,canonicalPath:$canonical,version:$version,architecture:$architecture,pinned:true}'
}

fly2264_verify_tmux_servers() {
  local inventory rows='[]' atlas='[]' clients='[]' row pid image socket_count socket probe server_pid reported
  local command coalition canonical architecture entry
  inventory="$(inventory_tmux_servers)" || return 1
  while IFS= read -r row; do
    [ -n "$row" ] || continue
    pid="$(printf '%s' "$row" | jq -er '.pid')" || return 1
    image="$(printf '%s' "$row" | jq -er '.image')" || return 1
    command="$(ps -o command= -p "$pid" 2>/dev/null)" || return 1
    [ -n "$command" ] || return 1
    canonical="$(fly2264_real_path "$image")" || return 1
    architecture="$(printf '%s' "$row" | jq -er '.architecture')" || return 1
    socket_count="$(tmux_filesystem_socket_count_from_row "$row")" || return 1
    if ! tmux_command_is_server_shape "$command"; then
      if [ "$socket_count" -ne 0 ] || ! tmux_command_is_attach_client "$command"; then
        return 1
      fi
      entry="$(jq -cn --argjson pid "$pid" --arg image "$image" --arg canonical "$canonical" \
        --arg architecture "$architecture" \
        '{pid:$pid,image:$image,canonicalImage:$canonical,socket:"n/a",serverPid:null,role:"client",coalition:"n/a",architecture:$architecture}')" \
        || return 1
      clients="$(printf '%s' "$clients" | jq -c --argjson entry "$entry" '. + [$entry]')" || return 1
      continue
    fi
    [ "$socket_count" -eq 1 ] || return 1
    socket="$(tmux_filesystem_socket_from_row "$row")" || return 1
    probe="$(tmux_probe_socket_owner "$image" "$socket")" || return 1
    IFS=$'\t' read -r server_pid reported <<<"$probe"
    [ "$reported" = "$socket" ] && [ "$server_pid" -eq "$pid" ] || return 1
    coalition="$(tmux_resource_coalition_name "$pid")" || return 1
    entry="$(jq -cn --argjson pid "$pid" --arg image "$image" --arg canonical "$canonical" \
      --arg socket "$socket" --argjson serverPid "$server_pid" \
      --arg coalition "$coalition" --arg architecture "$architecture" \
      '{pid:$pid,image:$image,canonicalImage:$canonical,socket:$socket,serverPid:$serverPid,role:"server",coalition:$coalition,architecture:$architecture}')" || return 1
    if [ "$coalition" = com.xiaorongli.atlas-growth ]; then
      atlas="$(printf '%s' "$atlas" | jq -c --argjson entry "$entry" '. + [$entry]')"
      continue
    fi
    [ "$canonical" = "$FLY2264_VERIFY_NATIVE_TMUX" ] || return 1
    case "$architecture" in *arm64*) ;; *) return 1 ;; esac
    case "$command" in *'/usr/local/bin/tmux'*|*'3.5a'*) return 1 ;; esac
    rows="$(printf '%s' "$rows" | jq -c --argjson entry "$entry" '. + [$entry]')"
  done < <(printf '%s' "$inventory" | jq -c '.[]')
  jq -n --arg nativeTmux "$FLY2264_VERIFY_NATIVE_TMUX" --argjson inScope "$rows" \
    --argjson atlasExempt "$atlas" --argjson clients "$clients" \
    '{nativeTmux:$nativeTmux,inScope:$inScope,atlasExempt:$atlasExempt,clients:$clients}'
}

fly2264_verify_lead_health() {
  local labels label pid child parent again evidence='[]' lead_json child_json control
  labels="$(fly2264_expected_supervisors)" || return 1
  while IFS= read -r label; do
    case "$label" in com.flywheel.lead.*) ;; *) continue ;; esac
    pid="$(fly2264_launchd_pid "$label")" || return 1
    lead_json="$(fly2264_verify_process_native "$pid")" || return 1
    child="$(pgrep -P "$pid" 2>/dev/null | LC_ALL=C sort -n | head -1)" || return 1
    [[ "$child" =~ ^[1-9][0-9]*$ ]] || return 1
    parent="$(ps -o ppid= -p "$child" 2>/dev/null | tr -d ' ')" || return 1
    [ "$parent" = "$pid" ] || return 1
    child_json="$(fly2264_verify_process_native "$child")" || return 1
    again="$(fly2264_launchd_pid "$label")" || return 1
    [ "$again" = "$pid" ] || return 1
    evidence="$(printf '%s' "$evidence" | jq -c --arg label "$label" \
      --argjson lead "$lead_json" --argjson child "$child_json" \
      '. + [{label:$label,lead:$lead,representativeChild:$child}]')" || return 1
  done <<<"$labels"
  [ "$(printf '%s' "$evidence" | jq 'length')" -eq 16 ] || return 1
  # $1 is intentionally expanded by the child shell, not this shell.
  # shellcheck disable=SC2016
  control="$("$FLY2264_VERIFY_NATIVE_CONTROL_SHELL" -c \
    '"$1" -n sysctl.proc_translated' _ "$FLY2264_VERIFY_SYSCTL" 2>/dev/null)" || return 1
  [ "$control" = 0 ] || return 1
  jq -n --argjson leads "$evidence" --argjson nativeControlTranslated "$control" \
    '{leadCount:($leads|length),leads:$leads,nativeControlTranslated:$nativeControlTranslated}'
}

fly2264_file_age_seconds() {
  local path="$1" now mtime
  now="$(date +%s)" || return 1
  if mtime="$(stat -c %Y "$path" 2>/dev/null)" && [[ "$mtime" =~ ^[0-9]+$ ]]; then
    :
  elif mtime="$(stat -f %m "$path" 2>/dev/null)" && [[ "$mtime" =~ ^[0-9]+$ ]]; then
    :
  else
    return 1
  fi
  [ "$now" -ge "$mtime" ] || return 1
  printf '%s\n' "$((now - mtime))"
}

fly2264_verify_cmux() {
  local watcher_pid owner_file owner_before owner_after owner_pid owner_start owner_mode owner_nonce
  local actual_start heartbeat_file heartbeat heartbeat_pid age sidebar
  watcher_pid="$(fly2264_launchd_pid com.flywheel.cmux-watcher)" || return 1
  owner_file="$FLY2264_VERIFY_CMUX_OWNER_FILE"
  heartbeat_file="$FLY2264_VERIFY_CMUX_HEARTBEAT_FILE"
  [ -f "$owner_file" ] && [ ! -L "$owner_file" ] || return 1
  [ -f "$heartbeat_file" ] && [ ! -L "$heartbeat_file" ] || return 1
  owner_before="$(cat "$owner_file")" || return 1
  IFS='|' read -r owner_pid owner_start owner_mode owner_nonce <<<"$owner_before"
  [ "$owner_pid" = "$watcher_pid" ] && [ "$owner_mode" = watch ] \
    && [ -n "$owner_start" ] && [ -n "$owner_nonce" ] || return 1
  actual_start="$(TZ=UTC LC_ALL=C ps -o lstart= -p "$watcher_pid" 2>/dev/null | sed 's/^ *//')" || return 1
  [ "$actual_start" = "$owner_start" ] || return 1
  heartbeat="$(cat "$heartbeat_file")" || return 1
  heartbeat_pid="${heartbeat%%|*}"
  [ "$heartbeat_pid" = "$watcher_pid" ] || return 1
  age="$(fly2264_file_age_seconds "$heartbeat_file")" || return 1
  [ "$age" -le 120 ] || return 1
  sidebar="$("$FLY2264_VERIFY_LIVE_REPO/scripts/flywheel-cmux-sync.sh" --verify-sidebar --json)" || return 1
  printf '%s' "$sidebar" | jq -e '.status == "pass" and .exit_code == 0' >/dev/null || return 1
  owner_after="$(cat "$owner_file")" || return 1
  [ "$owner_after" = "$owner_before" ] || return 1
  [ "$(TZ=UTC LC_ALL=C ps -o lstart= -p "$watcher_pid" 2>/dev/null | sed 's/^ *//')" = "$actual_start" ] || return 1
  jq -n --argjson pid "$watcher_pid" --arg startIdentity "$actual_start" \
    --argjson heartbeatAgeSeconds "$age" --argjson sidebar "$sidebar" \
    '{watcherPid:$pid,startIdentity:$startIdentity,heartbeatAgeSeconds:$heartbeatAgeSeconds,sidebar:$sidebar}'
}

fly2264_verify_paths() {
  local labels label pid value wrapper launchd_path launchd_path_status path_rc
  local paths='[]' hygiene scratch rc=0
  labels="$(fly2264_expected_supervisors)" || return 1
  scratch="$(mktemp -t fly2264-hygiene.XXXXXX)" || return 1
  while IFS= read -r label; do
    case "$label" in com.flywheel.bridge|com.flywheel.lead.*) ;; *) continue ;; esac
    pid="$(fly2264_launchd_pid "$label")" || { rm -f "$scratch"; return 1; }
    if [ "$label" = com.flywheel.bridge ]; then
      wrapper="$(fly2264_bridge_path_wrapper)" || { rm -f "$scratch"; return 1; }
      launchd_path=""
      launchd_path_status=available
      path_rc=0
      launchd_path="$(fly2264_launchd_default_path "$label")" || path_rc=$?
      case "$path_rc" in
        0) ;;
        2) launchd_path_status=unavailable ;;
        *) rm -f "$scratch"; return 1 ;;
      esac
      value="${HOME}/.local/bin:${HOME}/.npm-global/bin:/opt/homebrew/bin:/usr/local/bin"
      [ "$launchd_path_status" != available ] || value="${value}:${launchd_path}"
      fly2264_assert_native_first_path "$value" || { rm -f "$scratch"; return 1; }
      paths="$(printf '%s' "$paths" | jq -c --arg label "$label" --argjson pid "$pid" \
        --arg wrapper "$wrapper" --arg launchdPathStatus "$launchd_path_status" \
        '. + [{label:$label,pid:$pid,nativeBeforeLegacy:true,authority:"launchd-wrapper-contract",wrapper:$wrapper,launchdDefaultPathStatus:$launchdPathStatus}]')" \
        || { rm -f "$scratch"; return 1; }
    else
      value="$(fly2264_process_path "$pid")" || { rm -f "$scratch"; return 1; }
      fly2264_assert_native_first_path "$value" || { rm -f "$scratch"; return 1; }
      paths="$(printf '%s' "$paths" | jq -c --arg label "$label" --argjson pid "$pid" \
        '. + [{label:$label,pid:$pid,nativeBeforeLegacy:true,authority:"process-environment"}]')" \
        || { rm -f "$scratch"; return 1; }
    fi
  done <<<"$labels"
  [ "$(printf '%s' "$paths" | jq 'length')" -eq 17 ] || { rm -f "$scratch"; return 1; }
  bash "$FLY2264_VERIFY_LIVE_REPO/scripts/check-global-path-hygiene.sh" \
    --source-tree "$FLY2264_VERIFY_LIVE_REPO" >"$scratch" 2>&1 || rc=$?
  [ "$rc" -eq 0 ] || { fly2264_bound_text "$scratch" >&2; rm -f "$scratch"; return 1; }
  hygiene="$(fly2264_bound_text "$scratch")"
  rm -f "$scratch"
  jq -n --argjson processes "$paths" --arg hygiene "$hygiene" \
    '{processCount:($processes|length),processes:$processes,pathHygiene:{status:"pass",summary:$hygiene}}'
}

fly2264_write_timeout_artifact() {
  local artifact="$1" scratch
  [ -f "$FLY2264_VERIFY_ARTIFACT_DIR/$artifact" ] && return 0
  scratch="$(mktemp -t fly2264-timeout.XXXXXX)" || return 1
  jq -n --arg artifact "$artifact" \
    '{schemaVersion:1,artifact:$artifact,status:"fail",exitCode:124,durationSeconds:110,error:"shared verification deadline exceeded",evidence:{}}' \
    >"$scratch"
  fly2264_write_json_atomic "$FLY2264_VERIFY_ARTIFACT_DIR/$artifact" "$scratch"
  rm -f "$scratch"
}

fly2264_wait_workers() {
  local pending="$1" deadline="$2" now pids item pid
  FLY2264_WAIT_FAILED=false
  FLY2264_WAIT_PENDING="$pending"
  while [ -n "$FLY2264_WAIT_PENDING" ]; do
    now="$(date +%s)"
    [ "$now" -lt "$deadline" ] || break
    pids=''
    for item in $FLY2264_WAIT_PENDING; do
      pid="${item%%:*}"
      if kill -0 "$pid" 2>/dev/null; then
        pids="${pids}${pids:+ }${item}"
      else
        wait "$pid" || FLY2264_WAIT_FAILED=true
      fi
    done
    FLY2264_WAIT_PENDING="$pids"
    [ -z "$FLY2264_WAIT_PENDING" ] || sleep 1
  done
  if [ -n "$FLY2264_WAIT_PENDING" ]; then
    FLY2264_WAIT_FAILED=true
    for item in $FLY2264_WAIT_PENDING; do kill "${item%%:*}" 2>/dev/null || true; done
    for _ in 1 2 3 4 5; do
      pids=''
      for item in $FLY2264_WAIT_PENDING; do
        kill -0 "${item%%:*}" 2>/dev/null && pids="${pids}${pids:+ }${item}"
      done
      FLY2264_WAIT_PENDING="$pids"
      [ -z "$FLY2264_WAIT_PENDING" ] && break
      sleep 1
    done
    for item in $FLY2264_WAIT_PENDING; do kill -KILL "${item%%:*}" 2>/dev/null || true; done
    for item in $FLY2264_WAIT_PENDING; do wait "${item%%:*}" 2>/dev/null || true; done
  fi
}

fly2264_verify_run() {
  local overall_started deadline pid artifact producer item all_pass=true
  local pids='' specs summary_tmp summary='[]' sha status duration
  umask 077
  overall_started="$(date +%s)"
  deadline=$((overall_started + 110))
  for artifact in $(fly2264_artifact_names) verification-summary.json; do
    rm -f "$FLY2264_VERIFY_ARTIFACT_DIR/$artifact" || return 1
  done

  # The sidebar verifier takes two internally-consistent snapshots and runs
  # alone; process-wide checks start only after that read-only observation.
  fly2264_run_producer 06-cmux.json fly2264_verify_cmux &
  pid=$!
  fly2264_wait_workers "$pid:06-cmux.json" "$deadline"
  [ "$FLY2264_WAIT_FAILED" = false ] || all_pass=false
  if [ -n "$FLY2264_WAIT_PENDING" ]; then
    fly2264_write_timeout_artifact 06-cmux.json || return 1
  fi

  if [ "$(date +%s)" -lt "$deadline" ]; then
    specs='01-updater.json|fly2264_verify_updater
02-lead-census.json|fly2264_verify_lead_census
03-native-tmux.json|fly2264_verify_native_tmux
04-tmux-servers.json|fly2264_verify_tmux_servers
05-lead-health.json|fly2264_verify_lead_health
07-path.json|fly2264_verify_paths'
    while IFS='|' read -r artifact producer; do
      fly2264_run_producer "$artifact" "$producer" &
      pid=$!
      pids="${pids}${pids:+ }${pid}:${artifact}"
    done <<<"$specs"
    fly2264_wait_workers "$pids" "$deadline"
    [ "$FLY2264_WAIT_FAILED" = false ] || all_pass=false
  fi

  for artifact in $(fly2264_artifact_names); do
    fly2264_write_timeout_artifact "$artifact" || return 1
    status="$(jq -er '.status' "$FLY2264_VERIFY_ARTIFACT_DIR/$artifact")" || return 1
    [ "$status" = pass ] || all_pass=false
    sha="$(shasum -a 256 "$FLY2264_VERIFY_ARTIFACT_DIR/$artifact" | awk '{print $1}')" || return 1
    duration="$(jq -er '.durationSeconds' "$FLY2264_VERIFY_ARTIFACT_DIR/$artifact")" || return 1
    summary="$(printf '%s' "$summary" | jq -c --arg artifact "$artifact" --arg status "$status" \
      --arg sha256 "$sha" --argjson durationSeconds "$duration" \
      '. + [{artifact:$artifact,status:$status,sha256:$sha256,durationSeconds:$durationSeconds}]')" || return 1
  done
  summary_tmp="$(mktemp -t fly2264-summary.XXXXXX)" || return 1
  jq -n --arg status "$([ "$all_pass" = true ] && printf pass || printf fail)" \
    --arg cutoverSha "$FLY2264_VERIFY_CUTOVER_SHA" --argjson artifacts "$summary" \
    --argjson durationSeconds "$(($(date +%s) - overall_started))" \
    '{schemaVersion:1,status:$status,cutoverSha:$cutoverSha,durationSeconds:$durationSeconds,artifacts:$artifacts}' \
    >"$summary_tmp" || { rm -f "$summary_tmp"; return 1; }
  fly2264_write_json_atomic "$FLY2264_VERIFY_ARTIFACT_DIR/verification-summary.json" "$summary_tmp" || {
    rm -f "$summary_tmp"
    return 1
  }
  cat "$summary_tmp"
  rm -f "$summary_tmp"
  [ "$all_pass" = true ]
}

fly2264_verify_main() {
  [ "$#" -eq 1 ] || { printf 'usage: %s <CUTOVER_SHA>\n' "$0" >&2; return 64; }
  [[ "$1" =~ ^[0-9a-f]{40}$ ]] || { printf 'CUTOVER_SHA must be 40 lowercase hex characters\n' >&2; return 64; }
  FLY2264_VERIFY_CUTOVER_SHA="$1"
  FLY2264_VERIFY_SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)" || return 1
  FLY2264_VERIFY_LIVE_REPO="${LIVE_REPO:-$HOME/Dev/flywheel}"
  case "$FLY2264_VERIFY_LIVE_REPO" in /*) ;; *) printf 'LIVE_REPO must be absolute\n' >&2; return 1 ;; esac
  FLY2264_VERIFY_LINKED_TMUX=/opt/homebrew/bin/tmux
  FLY2264_VERIFY_NATIVE_TMUX=/opt/homebrew/Cellar/tmux/3.7c/bin/tmux
  FLY2264_VERIFY_BREW=/opt/homebrew/bin/brew
  FLY2264_VERIFY_NATIVE_CONTROL_SHELL=/bin/bash
  FLY2264_VERIFY_SYSCTL=/usr/sbin/sysctl
  FLY2264_VERIFY_CMUX_OWNER_FILE=/tmp/flywheel-cmux-watcher.lock/owner
  FLY2264_VERIFY_CMUX_HEARTBEAT_FILE="$HOME/.flywheel/state/cmux-watcher-heartbeat"
  FLY2264_VERIFY_ARTIFACT_DIR="$FLY2264_VERIFY_SELF_DIR/verification-artifacts"
  export FLY2264_VERIFY_CUTOVER_SHA FLY2264_VERIFY_SELF_DIR FLY2264_VERIFY_LIVE_REPO
  export FLY2264_VERIFY_LINKED_TMUX FLY2264_VERIFY_NATIVE_TMUX FLY2264_VERIFY_BREW
  export FLY2264_VERIFY_NATIVE_CONTROL_SHELL FLY2264_VERIFY_SYSCTL
  export FLY2264_VERIFY_CMUX_OWNER_FILE FLY2264_VERIFY_CMUX_HEARTBEAT_FILE
  export FLY2264_VERIFY_ARTIFACT_DIR JQ_BIN
  [ -d "$FLY2264_VERIFY_LIVE_REPO" ] && [ ! -L "$FLY2264_VERIFY_LIVE_REPO" ] || return 1
  if [ -e "$FLY2264_VERIFY_ARTIFACT_DIR" ] || [ -L "$FLY2264_VERIFY_ARTIFACT_DIR" ]; then
    [ -d "$FLY2264_VERIFY_ARTIFACT_DIR" ] && [ ! -L "$FLY2264_VERIFY_ARTIFACT_DIR" ] || return 1
  else
    mkdir -m 700 "$FLY2264_VERIFY_ARTIFACT_DIR" || return 1
  fi
  chmod 700 "$FLY2264_VERIFY_ARTIFACT_DIR" || return 1
  fly2264_verify_run
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  set -euo pipefail
  FLY2264_VERIFY_SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  JQ_BIN=jq
  export JQ_BIN
  die() { printf 'verify-native-tmux-cutover: %s\n' "$*" >&2; exit 1; }
  # Runtime source path is anchored to this installed script.
  # shellcheck disable=SC1091
  source "$FLY2264_VERIFY_SELF_DIR/lib/tmux-process-inventory.sh"
  fly2264_verify_main "$@"
fi
