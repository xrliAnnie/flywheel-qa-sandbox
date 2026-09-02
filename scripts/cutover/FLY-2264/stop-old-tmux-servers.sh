#!/bin/bash
# FLY-2274: stop reviewed old tmux tuples, exempting only atlas-growth.
set -euo pipefail

SELF_DIR="$(cd "$(dirname "$0")" && pwd)"
JQ_BIN="jq"
export JQ_BIN
EXEMPT_COALITION="com.xiaorongli.atlas-growth"
die() { printf 'stop-old-tmux-servers: %s\n' "$*" >&2; exit 1; }
real_path() { python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$1"; }
# Runtime source path is anchored to this installed script.
# shellcheck disable=SC1091
source "$SELF_DIR/lib/tmux-process-inventory.sh"

[ "$#" -eq 2 ] || die "usage: $0 <tmux-union.json> <absolute-old-tmux>"
union_file="$1"
old_tmux="$2"
case "$union_file" in /*) ;; *) die "union path must be absolute" ;; esac
case "$old_tmux" in /*) ;; *) die "OLD_TMUX must be absolute" ;; esac
[ -f "$union_file" ] && [ ! -L "$union_file" ] || die "union must be a regular non-symlink file"
[ -f "$old_tmux" ] && [ ! -L "$old_tmux" ] && [ -x "$old_tmux" ] \
  || die "OLD_TMUX must be an executable regular non-symlink file"
[ "$("$old_tmux" -V 2>/dev/null)" = 'tmux 3.5a' ] || die "OLD_TMUX is not tmux 3.5a"
old_real="$(real_path "$old_tmux")" || die "cannot resolve OLD_TMUX"

jq -e '
  type == "array" and length > 0
  and all(.[];
    (keys == ["architecture","image","pid","sockets","startIdentity","supervisor"])
    and (.pid | type == "number" and floor == . and . > 0)
    and (.startIdentity | type == "string" and length > 0)
    and (.image | type == "string" and startswith("/"))
    and (.architecture | type == "string" and length > 0)
    and (.sockets | type == "array" and length > 0 and all(.[]; type == "string" and length > 0))
    and (.supervisor | type == "object" and keys == ["parentCommand","parentPid"])
    and (.supervisor.parentPid | type == "number" and floor == . and . >= 0)
    and (.supervisor.parentCommand | type == "string"))
  and ([.[].pid] | unique | length == length)
  and ([.[] | [.pid,.startIdentity]] | unique | length == length)
' "$union_file" >/dev/null || die "tmux union schema/uniqueness is invalid"

while IFS= read -r image; do
  [ "$(real_path "$image")" = "$old_real" ] || die "union contains a non-OLD_TMUX image: $image"
done < <(jq -r '.[].image' "$union_file")

tmp="$(mktemp -d -t fly2264-stop-old.XXXXXX)"
trap 'rm -rf "$tmp"' EXIT
initial="$(inventory_tmux_servers)" || die "initial exact tmux census failed"
: >"$tmp/records.jsonl"
: >"$tmp/errors"
: >"$tmp/vanished"

classify_row() {
  local row="$1" pid start image socket_count socket probe server_pid reported command coalition scope
  pid="$(printf '%s' "$row" | jq -er '.pid')" || return 1
  start="$(printf '%s' "$row" | jq -er '.startIdentity')" || return 1
  image="$(printf '%s' "$row" | jq -er '.image')" || return 1
  command="$(ps -o command= -p "$pid" 2>/dev/null)" \
    || { printf 'command unreadable for pid %s\n' "$pid" >&2; return 1; }
  [ -n "$command" ] || { printf 'command unreadable for pid %s\n' "$pid" >&2; return 1; }
  socket_count="$(tmux_filesystem_socket_count_from_row "$row")" || return 1
  if ! tmux_command_is_server_shape "$command"; then
    if [ "$socket_count" -ne 0 ] || ! tmux_command_is_attach_client "$command"; then
      printf 'tmux command/socket shape is unreviewed pid %s\n' "$pid" >&2
      return 1
    fi
    jq -cn --argjson pid "$pid" --arg startIdentity "$start" --arg image "$image" \
      '{pid:$pid,startIdentity:$startIdentity,image:$image,socket:"n/a",serverPid:null,role:"client",coalition:"n/a",scope:"client_info"}'
    return
  fi
  [ "$socket_count" -eq 1 ] \
    || { printf 'server socket ownership ambiguous for pid %s\n' "$pid" >&2; return 1; }
  socket="$(tmux_filesystem_socket_from_row "$row")" || return 1
  probe="$(tmux_probe_socket_owner "$old_tmux" "$socket")" \
    || { printf 'socket probe failed for pid %s socket %s\n' "$pid" "$socket" >&2; return 1; }
  IFS=$'\t' read -r server_pid reported <<<"$probe"
  [ "$reported" = "$socket" ] || return 1
  [ "$server_pid" -eq "$pid" ] \
    || { printf 'filesystem socket belongs to a different server pid=%s owner=%s\n' "$pid" "$server_pid" >&2; return 1; }
  coalition="$(tmux_resource_coalition_name "$pid")" \
    || { printf 'ownership unknown for server pid %s\n' "$pid" >&2; return 1; }
  scope="in_scope"
  [ "$coalition" != "$EXEMPT_COALITION" ] || scope="atlas_exempt"
  jq -cn --argjson pid "$pid" --arg startIdentity "$start" --arg image "$image" \
    --arg socket "$socket" --argjson serverPid "$server_pid" \
    --arg coalition "$coalition" --arg scope "$scope" \
    '{pid:$pid,startIdentity:$startIdentity,image:$image,socket:$socket,serverPid:$serverPid,role:"server",coalition:$coalition,scope:$scope}'
}

while IFS= read -r row; do
  [ -n "$row" ] || continue
  record="$(classify_row "$row")" || { printf 'classification failed for live inventory row\n' >>"$tmp/errors"; continue; }
  printf '%s\n' "$record" >>"$tmp/records.jsonl"
  pid="$(printf '%s' "$record" | jq -r '.pid')"
  start="$(printf '%s' "$record" | jq -r '.startIdentity')"
  scope="$(printf '%s' "$record" | jq -r '.scope')"
  [ "$scope" != client_info ] || continue
  union_rows="$(jq -c --argjson pid "$pid" '[.[] | select(.pid == $pid)]' "$union_file")"
  if [ "$(printf '%s' "$union_rows" | jq 'length')" -eq 0 ]; then
    [ "$scope" = atlas_exempt ] \
      || printf 'union-external in-scope tmux pid=%s\n' "$pid" >>"$tmp/errors"
    continue
  fi
  union_start="$(printf '%s' "$union_rows" | jq -r '.[0].startIdentity')"
  [ "$start" = "$union_start" ] \
    || printf 'PID reuse pid=%s expected=%s actual=%s\n' "$pid" "$union_start" "$start" >>"$tmp/errors"
  current_real="$(real_path "$(printf '%s' "$record" | jq -r '.image')")"
  [ "$current_real" = "$old_real" ] \
    || printf 'image drift pid=%s image=%s\n' "$pid" "$current_real" >>"$tmp/errors"
  socket="$(printf '%s' "$record" | jq -r '.socket')"
  printf '%s' "$union_rows" | jq -e --arg socket "$socket" '.[0].sockets | index($socket) != null' >/dev/null \
    || printf 'socket drift pid=%s socket=%s\n' "$pid" "$socket" >>"$tmp/errors"
done < <(printf '%s' "$initial" | jq -c '.[]')

while IFS=$'\t' read -r pid start; do
  if ! printf '%s\n' "$initial" | jq -e --argjson pid "$pid" --arg start "$start" \
      '.[] | select(.pid == $pid and .startIdentity == $start)' >/dev/null; then
    if printf '%s\n' "$initial" | jq -e --argjson pid "$pid" '.[] | select(.pid == $pid)' >/dev/null; then
      printf 'PID reuse pid=%s expected=%s\n' "$pid" "$start" >>"$tmp/errors"
    else
      printf '%s\t%s\n' "$pid" "$start" >>"$tmp/vanished"
    fi
  fi
done < <(jq -r '.[] | [.pid,.startIdentity] | @tsv' "$union_file")

if [ -s "$tmp/errors" ]; then
  sed 's/^/stop-old-tmux-servers: /' "$tmp/errors" >&2
  exit 1
fi

reprove_server() {
  local record="$1" pid expected_start expected_image expected_socket expected_coalition
  local actual_start image socket socket_rc probe coalition
  pid="$(printf '%s' "$record" | jq -r '.pid')"
  expected_start="$(printf '%s' "$record" | jq -r '.startIdentity')"
  expected_image="$(printf '%s' "$record" | jq -r '.image')"
  expected_socket="$(printf '%s' "$record" | jq -r '.socket')"
  expected_coalition="$(printf '%s' "$record" | jq -r '.coalition')"
  actual_start="$(TZ=UTC LC_ALL=C ps -o lstart= -p "$pid" 2>/dev/null | sed 's/^ *//')" || true
  [ -n "$actual_start" ] || return 2
  [ "$actual_start" = "$expected_start" ] || die "PID reuse before kill pid=$pid"
  image="$(extract_tmux_image "$pid")" || die "image reproof failed pid=$pid"
  [ "$(real_path "$image")" = "$(real_path "$expected_image")" ] || die "image changed before kill pid=$pid"
  socket_rc=0
  socket="$(tmux_filesystem_socket_for_pid "$pid")" || socket_rc=$?
  [ "$socket_rc" -eq 0 ] || die "socket reproof failed pid=$pid"
  [ "$socket" = "$expected_socket" ] || die "socket changed before kill pid=$pid"
  probe="$(tmux_probe_socket_owner "$old_tmux" "$expected_socket")" \
    || die "socket probe reproof failed pid=$pid"
  [ "${probe%%$'\t'*}" = "$pid" ] || die "socket server pid changed before kill pid=$pid"
  coalition="$(tmux_resource_coalition_name "$pid")" || die "coalition reproof failed pid=$pid"
  [ "$coalition" = "$expected_coalition" ] || die "coalition changed before kill pid=$pid"
  return 0
}

stopped='[]'
while IFS= read -r record; do
  [ -n "$record" ] || continue
  pid="$(printf '%s' "$record" | jq -r '.pid')"
  socket="$(printf '%s' "$record" | jq -r '.socket')"
  reproof_rc=0
  reprove_server "$record" || reproof_rc=$?
  [ "$reproof_rc" -ne 2 ] || continue
  [ "$reproof_rc" -eq 0 ] || exit "$reproof_rc"
  "$old_tmux" -S "$socket" kill-server || die "kill-server failed pid=$pid socket=$socket"
  gone=false
  for _ in $(seq 1 50); do
    actual="$(TZ=UTC LC_ALL=C ps -o lstart= -p "$pid" 2>/dev/null | sed 's/^ *//' || true)"
    if [ -z "$actual" ]; then gone=true; break; fi
    [ "$actual" = "$(printf '%s' "$record" | jq -r '.startIdentity')" ] \
      || die "PID reuse while waiting for killed server pid=$pid"
    sleep 0.2
  done
  [ "$gone" = true ] || die "server tuple did not exit pid=$pid"
  stopped="$(printf '%s' "$stopped" | jq -c --argjson pid "$pid" '. + [$pid]')"
done < <(jq -c 'select(.scope == "in_scope" and .role == "server")' "$tmp/records.jsonl" | LC_ALL=C sort)

final="$(inventory_tmux_servers)" || die "final exact tmux census failed"
out_of_scope='[]'
clients='[]'
while IFS= read -r row; do
  [ -n "$row" ] || continue
  record="$(classify_row "$row")" || die "final tmux ownership unknown"
  if [ "$(printf '%s' "$record" | jq -r '.role')" = client ]; then
    clients="$(printf '%s' "$clients" | jq -c --argjson entry "$record" '. + [$entry]')"
    continue
  fi
  if [ "$(printf '%s' "$record" | jq -r '.scope')" != atlas_exempt ]; then
    die "new or surviving in-scope tmux process pid=$(printf '%s' "$record" | jq -r '.pid')"
  fi
  out_of_scope="$(printf '%s' "$out_of_scope" | jq -c --argjson entry "$record" '. + [$entry]')"
done < <(printf '%s' "$final" | jq -c '.[]')

jq -n --argjson stopped "$stopped" --argjson vanished "$(wc -l <"$tmp/vanished" | tr -d ' ')" \
  --argjson outOfScope "$out_of_scope" --argjson clients "$clients" \
  '{status:"pass",stoppedServerPids:$stopped,satisfiedVanished:$vanished,outOfScope:$outOfScope,clientInfo:$clients}'
