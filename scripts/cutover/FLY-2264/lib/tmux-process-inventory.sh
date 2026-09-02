#!/bin/bash
# FLY-2274: source-only exact tmux image and process inventory implementation.
# Callers provide die(), JQ_BIN, and real_path(). No top-level side effects.
# All single-quoted $names below are jq variables, never shell expansion.
# shellcheck disable=SC2016

extract_tmux_image() {
  local pid="$1" lines image="" count=0 candidate
  lines=$(lsof -a -p "$pid" -d txt -Fn 2>/dev/null) \
    || return 1
  while IFS= read -r candidate; do
    candidate="${candidate#n}"
    case "$candidate" in
      /usr/local/Cellar/tmux/*/bin/tmux|/opt/homebrew/Cellar/tmux/*/bin/tmux|*/.flywheel/backup/tmux-*/bin/tmux)
        image="$candidate"
        count=$((count + 1))
        ;;
    esac
  done <<< "$lines"
  (( count == 1 )) || return 1
  printf '%s\n' "$image"
}

tmux_filesystem_socket_from_row() {
  local row="$1" paths="" count=0
  paths="$(printf '%s' "$row" | "$JQ_BIN" -r '.sockets[] | select(startswith("/"))' | LC_ALL=C sort -u)" \
    || return 1
  count="$(printf '%s\n' "$paths" | awk 'NF {n++} END {print n+0}')"
  [ "$count" -eq 1 ] || return 1
  printf '%s\n' "$paths"
}

tmux_filesystem_socket_count_from_row() {
  local row="$1"
  printf '%s' "$row" | "$JQ_BIN" -r \
    '[.sockets[] | select(startswith("/"))] | unique | length'
}

tmux_filesystem_socket_for_pid() {
  local pid="$1" sockets row
  sockets="$(lsof -a -p "$pid" -U -Fn 2>/dev/null | sed -n 's/^n//p')" || return 1
  row="$("$JQ_BIN" -cn --arg sockets "$sockets" \
    '{sockets:($sockets|split("\n")|map(select(length>0)))}')" || return 1
  tmux_filesystem_socket_from_row "$row"
}

tmux_command_is_attach_client() {
  local command="$1"
  case " $command " in
    *' attach-session '*) return 0 ;;
    *) return 1 ;;
  esac
}

tmux_command_is_server_shape() {
  local command="$1"
  case " $command " in *' attach-session '*) return 1 ;; esac
  case " $command " in
    *' -D '*|*' -S '*|*' -L '*|*' new-session '*) return 0 ;;
    *) return 1 ;;
  esac
}

inventory_tmux_servers() {
  local pids rc pid incarnation image architecture sockets ppid parent_command entry inventory='[]' after
  set +e
  pids=$(pgrep -x tmux 2>/dev/null)
  rc=$?
  set -e
  (( rc == 0 || rc == 1 )) || die "cannot enumerate live tmux server processes"
  for pid in $pids; do
    [[ "$pid" =~ ^[0-9]+$ ]] || die "tmux process inventory returned an invalid pid: $pid"
    incarnation=$(TZ=UTC LC_ALL=C ps -o lstart= -p "$pid" 2>/dev/null | sed 's/^ *//')
    [ -n "$incarnation" ] || continue
    image=$(extract_tmux_image "$pid") || {
      [ -z "$(TZ=UTC LC_ALL=C ps -o lstart= -p "$pid" 2>/dev/null | sed 's/^ *//')" ] && continue
      die "cannot inspect executable image for stable tmux pid $pid"
    }
    architecture=$(file -b "$image") || {
      [ -z "$(TZ=UTC LC_ALL=C ps -o lstart= -p "$pid" 2>/dev/null | sed 's/^ *//')" ] && continue
      die "cannot inspect architecture for stable tmux pid $pid image $image"
    }
    sockets=$(lsof -a -p "$pid" -U -Fn 2>/dev/null | sed -n 's/^n//p') || {
      [ -z "$(TZ=UTC LC_ALL=C ps -o lstart= -p "$pid" 2>/dev/null | sed 's/^ *//')" ] && continue
      die "cannot inspect unix sockets for stable tmux pid $pid"
    }
    ppid=$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')
    if [[ ! "$ppid" =~ ^[0-9]+$ ]]; then
      [ -z "$(TZ=UTC LC_ALL=C ps -o lstart= -p "$pid" 2>/dev/null | sed 's/^ *//')" ] && continue
      die "stable tmux pid $pid has no parent identity"
    fi
    parent_command=$(ps -o command= -p "$ppid" 2>/dev/null || true)
    after=$(TZ=UTC LC_ALL=C ps -o lstart= -p "$pid" 2>/dev/null | sed 's/^ *//')
    [ -n "$after" ] || continue
    [ "$after" = "$incarnation" ] || die "tmux pid $pid changed identity during inventory"
    entry=$("$JQ_BIN" -n --argjson pid "$pid" --arg incarnation "$incarnation" \
      --arg image "$image" --arg architecture "$architecture" --arg sockets "$sockets" \
      --argjson parentPid "$ppid" --arg parentCommand "$parent_command" \
      '{pid:$pid,startIdentity:$incarnation,image:$image,architecture:$architecture,sockets:($sockets|split("\n")|map(select(length>0))),supervisor:{parentPid:$parentPid,parentCommand:$parentCommand}}')
    inventory=$(printf '%s' "$inventory" | "$JQ_BIN" -c --argjson entry "$entry" '. + [$entry]')
  done
  printf '%s\n' "$inventory"
}

# macOS launchd ownership authority for a live process. stdout: coalition label.
tmux_resource_coalition_name() {
  local pid="$1" out="" rc=0 name=""
  out="$(launchctl print "pid/${pid}" 2>&1)" || rc=$?
  (( rc == 0 )) || return 1
  name="$(printf '%s\n' "$out" | awk '
    /^[[:space:]]*resource coalition = \{[[:space:]]*$/ { in_resource=1; next }
    in_resource && /^[[:space:]]*name = / {
      line=$0
      sub(/^[[:space:]]*name = /, "", line)
      print line
      count++
      next
    }
    in_resource && /^[[:space:]]*\}[[:space:]]*$/ { in_resource=0 }
    END { if (count != 1) exit 1 }
  ')" || return 1
  [[ "$name" =~ ^[A-Za-z0-9._-]+$ ]] || return 1
  printf '%s\n' "$name"
}

# stdout: server-pid<TAB>normalized-socket
tmux_probe_socket_owner() {
  local client="$1" socket="$2" pid="" reported=""
  pid="$("$client" -S "$socket" display-message -p '#{pid}' 2>/dev/null)" || return 1
  reported="$("$client" -S "$socket" display-message -p '#{socket_path}' 2>/dev/null)" || return 1
  [[ "$pid" =~ ^[1-9][0-9]*$ && "$reported" == "$socket" ]] || return 1
  printf '%s\t%s\n' "$pid" "$reported"
}
