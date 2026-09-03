#!/usr/bin/env bash
# FLY-2274: hermetic old-tmux stop, ownership, and closure tests.
set -u

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SCRIPT="$ROOT/scripts/cutover/FLY-2264/stop-old-tmux-servers.sh"
TMP="$(mktemp -d -t fly2264-stop-tmux.XXXXXX)"
TMP="$(python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$TMP")"
trap 'rm -rf "$TMP"' EXIT
STATE="$TMP/state"
BIN="$TMP/bin"
OLD="$TMP/.flywheel/backup/tmux-3.5a/bin/tmux"
LEDGER="$TMP/kill-ledger"
mkdir -p "$STATE" "$BIN" "$(dirname "$OLD")"
PASS=0
FAIL=0
pass() { PASS=$((PASS + 1)); printf '  ✓ %s\n' "$1"; }
fail() { FAIL=$((FAIL + 1)); printf '  ✗ %s\n' "$1"; }

add_process() {
  local pid="$1" start="$2" socket="$3" command="$4" coalition="$5" role="$6" server_pid="$7"
  jq -n --argjson pid "$pid" --arg start "$start" --arg image "$OLD" \
    --arg socket "$socket" --arg command "$command" --arg coalition "$coalition" \
    --arg role "$role" --argjson serverPid "$server_pid" \
    '{pid:$pid,startIdentity:$start,image:$image,architecture:"Mach-O 64-bit executable x86_64",sockets:(if $role == "server" then [$socket,("->0x"+($pid|tostring))] else [("->0x"+($pid|tostring))] end),supervisor:{parentPid:1,parentCommand:"launchd"},command:$command,coalition:$coalition,role:$role,serverPid:$serverPid}' \
    >"$STATE/$pid.json"
}

write_union() {
  jq -s '[.[] | {pid,startIdentity,image,architecture,sockets,supervisor}]' "$STATE"/[0-9]*.json >"$TMP/union.json"
}

cat >"$BIN/pgrep" <<'STUB'
#!/usr/bin/env bash
set -u
include_ancestors=0
[ "$*" != '-a -x tmux' ] || include_ancestors=1
files=("${FLY2264_STOP_STATE:?}"/[0-9]*.json)
[[ -e "${files[0]}" ]] || exit 1
for file in "${files[@]}"; do
  pid="$(basename "$file" .json)"
  if [ "$include_ancestors" -ne 1 ] && [ -f "${FLY2264_STOP_STATE:?}/ancestor-pids" ] \
      && grep -Fxq "$pid" "${FLY2264_STOP_STATE:?}/ancestor-pids"; then
    continue
  fi
  printf '%s\n' "$pid"
done | sort -n
STUB
cat >"$BIN/ps" <<'STUB'
#!/usr/bin/env bash
set -u
format=""; pid=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    -o) format="${2:-}"; shift 2 ;;
    -p) pid="${2:-}"; shift 2 ;;
    *) shift ;;
  esac
done
if [[ "$pid" == 1 && "$format" == command=* ]]; then printf 'launchd\n'; exit 0; fi
file="${FLY2264_STOP_STATE:?}/$pid.json"
[[ -f "$file" ]] || exit 1
case "$format" in
  lstart=) jq -r '.startIdentity' "$file" ;;
  ppid=) printf '1\n' ;;
  command=) jq -r '.command' "$file" ;;
  *) printf 'unexpected ps format: %s\n' "$format" >&2; exit 64 ;;
esac
STUB
cat >"$BIN/lsof" <<'STUB'
#!/usr/bin/env bash
set -u
args=" $* "
pid=""
while [[ $# -gt 0 ]]; do
  [[ "$1" == -p ]] && { pid="${2:-}"; shift 2; continue; }
  shift
done
file="${FLY2264_STOP_STATE:?}/$pid.json"
[[ -f "$file" ]] || exit 1
if [[ "$args" == *' -d txt '* ]]; then
  if [[ "$pid" == "${FLY2264_STOP_VANISH_PID:-}" ]]; then
    rm -f "$file"
    exit 1
  fi
  printf 'p%s\nn%s\n' "$pid" "$(jq -r '.image' "$file")"
else
  printf 'p%s\n' "$pid"
  if [[ "$(jq -r '.role' "$file")" == server ]]; then
    printf 'n%s\n' "$(jq -r '.sockets[0]' "$file")"
  fi
  # Real macOS lsof adds connected peer endpoints to servers and exposes only
  # a peer endpoint for clients. The extractor must normalize both shapes to
  # the command's exact -S socket path.
  printf 'n->0x%s\n' "$pid"
fi
STUB
cat >"$BIN/file" <<'STUB'
#!/usr/bin/env bash
printf 'Mach-O 64-bit executable x86_64\n'
STUB
cat >"$BIN/launchctl" <<'STUB'
#!/usr/bin/env bash
set -u
[[ "${1:-}" == print && "${2:-}" == pid/* ]] || exit 64
pid="${2#pid/}"
file="${FLY2264_STOP_STATE:?}/$pid.json"
[[ -f "$file" ]] || exit 1
coalition="$(jq -r '.coalition' "$file")"
[[ "$coalition" != UNKNOWN ]] || { printf 'pid/%s = { resource coalition = { } }\n' "$pid"; exit 0; }
printf 'pid/%s = {\n\tresource coalition = {\n\t\tname = %s\n\t}\n}\n' "$pid" "$coalition"
STUB
cat >"$BIN/sleep" <<'STUB'
#!/usr/bin/env bash
exit 0
STUB
chmod +x "$BIN/pgrep" "$BIN/ps" "$BIN/lsof" "$BIN/file" "$BIN/launchctl" "$BIN/sleep"

cat >"$OLD" <<'STUB'
#!/usr/bin/env bash
set -u
[[ "${1:-}" != -V ]] || { printf 'tmux 3.5a\n'; exit 0; }
[[ "${1:-}" == -S ]] || exit 64
socket="${2:-}"; verb="${3:-}"
server_file=""
for file in "${FLY2264_STOP_STATE:?}"/[0-9]*.json; do
  [[ -f "$file" ]] || continue
  if [[ "$(jq -r '.role' "$file")" == server && "$(jq -r '.sockets[0]' "$file")" == "$socket" ]]; then
    server_file="$file"
    break
  fi
done
[[ -n "$server_file" ]] || exit 1
server_pid="$(jq -r '.pid' "$server_file")"
case "$verb" in
  display-message)
    [ "${4:-}" = -p ] || exit 64
    case "${5:-}" in
      '#{pid}') printf '%s\n' "$server_pid" ;;
      '#{socket_path}') printf '%s\n' "$socket" ;;
      *) exit 64 ;;
    esac
    ;;
  kill-server)
    printf 'kill %s %s\n' "$server_pid" "$socket" >>"${FLY2264_STOP_LEDGER:?}"
    [[ "${FLY2264_STOP_KILL_FAIL:-0}" != 1 ]] || exit 9
    rm -f "$server_file"
    if [[ "${FLY2264_STOP_LEAVE_CLIENTS:-0}" != 1 ]]; then
      for file in "${FLY2264_STOP_STATE:?}"/[0-9]*.json; do
        [[ -f "$file" ]] || continue
        [[ "$(jq -r '.serverPid' "$file")" != "$server_pid" ]] || rm -f "$file"
      done
    fi
    ;;
  *) exit 64 ;;
esac
STUB
chmod +x "$OLD"

export PATH="$BIN:$PATH"
export FLY2264_STOP_STATE="$STATE"
export FLY2264_STOP_LEDGER="$LEDGER"

make_base() {
  rm -f "$STATE"/*.json "$STATE/ancestor-pids" "$LEDGER"
  : >"$LEDGER"
  add_process 101 'Mon Sep  2 15:00:00 2026' "$TMP/default.sock" "$OLD -S $TMP/default.sock" com.flywheel.bridge server 101
  add_process 102 'Mon Sep  2 15:00:01 2026' "$TMP/fly1869.sock" "$OLD -S $TMP/fly1869.sock" com.flywheel.lead.geoforge3d-ops-lead server 102
  add_process 103 'Mon Sep  2 15:00:02 2026' "$TMP/atlas.sock" "$OLD -S $TMP/atlas.sock" com.xiaorongli.atlas-growth server 103
  add_process 201 'Mon Sep  2 15:00:03 2026' "$TMP/default.sock" "$OLD attach-session -t =cmux-fixture" application.com.cmuxterm.app.1 client 101
  write_union
}

echo "Test: in-scope servers stop, socket-less cmux client is informational, atlas is reported"
make_base
rc=0
FLY2264_STOP_LEAVE_CLIENTS=1 "$SCRIPT" "$TMP/union.json" "$OLD" >"$TMP/golden.out" 2>"$TMP/golden.err" || rc=$?
if [ "$rc" -eq 0 ] \
    && [ "$(wc -l <"$LEDGER" | tr -d ' ')" -eq 2 ] \
    && grep -qF "kill 101 $TMP/default.sock" "$LEDGER" \
    && grep -qF "kill 102 $TMP/fly1869.sock" "$LEDGER" \
    && ! grep -qF 'kill 103 ' "$LEDGER" \
    && [ -f "$STATE/103.json" ] && [ -f "$STATE/201.json" ] \
    && grep -qF 'com.xiaorongli.atlas-growth' "$TMP/golden.out" \
    && jq -e '.clientInfo[] | select(.pid == 201 and .role == "client" and .socket == "n/a")' "$TMP/golden.out" >/dev/null; then
  pass "only servers are stopped and the socket-less attach client does not block"
else
  fail "golden stop rc=$rc ledger=$(tr '\n' ';' <"$LEDGER") err=$(tr '\n' ' ' <"$TMP/golden.err") union=$(jq -c . "$TMP/union.json")"
fi

echo "Test: a tmux server in the caller ancestry remains in the exact stop census"
make_base
add_process 104 'Mon Sep  2 15:00:04 2026' "$TMP/ancestor.sock" "$OLD -S $TMP/ancestor.sock" com.flywheel.bridge server 104
write_union
printf '104\n' >"$STATE/ancestor-pids"
ancestor_rc=0
"$SCRIPT" "$TMP/union.json" "$OLD" >"$TMP/ancestor.out" 2>"$TMP/ancestor.err" || ancestor_rc=$?
if [ "$ancestor_rc" -eq 0 ] && grep -qF "kill 104 $TMP/ancestor.sock" "$LEDGER"; then
  pass "ancestor-inclusive pgrep keeps the caller's tmux server in scope"
else
  fail "ancestor tmux escaped stop census rc=$ancestor_rc ledger=$(tr '\n' ';' <"$LEDGER") err=$(tr '\n' ' ' <"$TMP/ancestor.err")"
fi

echo "Test: unknown ownership and union-external in-scope servers fail before mutation"
make_base
add_process 104 'Mon Sep  2 15:00:04 2026' "$TMP/unknown.sock" "$OLD -S $TMP/unknown.sock" UNKNOWN server 104
if "$SCRIPT" "$TMP/union.json" "$OLD" >"$TMP/unknown.out" 2>"$TMP/unknown.err"; then
  fail "stop accepted unknown ownership"
elif [ -s "$LEDGER" ]; then
  fail "stop killed before closing unknown ownership"
elif grep -qF 'ownership unknown' "$TMP/unknown.err"; then
  pass "unknown ownership is a named zero-mutation failure"
else
  fail "unknown ownership diagnostic missing"
fi

echo "Test: PID reuse fails before mutation"
make_base
jq '.startIdentity = "Tue Sep  3 15:00:00 2026"' "$STATE/101.json" >"$STATE/101.next"
mv "$STATE/101.next" "$STATE/101.json"
if "$SCRIPT" "$TMP/union.json" "$OLD" >"$TMP/reuse.out" 2>"$TMP/reuse.err"; then
  fail "stop accepted PID reuse"
elif [ -s "$LEDGER" ]; then
  fail "stop killed after PID reuse"
elif grep -qF 'PID reuse' "$TMP/reuse.err"; then
  pass "PID reuse is rejected before the first kill"
else
  fail "PID reuse diagnostic missing"
fi

echo "Test: a PID that exits during census is recorded as vanished"
make_base
if FLY2264_STOP_VANISH_PID=101 "$SCRIPT" "$TMP/union.json" "$OLD" >"$TMP/vanished.out" 2>"$TMP/vanished.err" \
    && jq -e '.status == "pass" and .satisfiedVanished == 1 and (.stoppedServerPids == [102])' "$TMP/vanished.out" >/dev/null; then
  pass "mid-census exit is skipped without weakening stable-server closure"
else
  fail "mid-census exit was not handled: $(tr '\n' ' ' <"$TMP/vanished.err")"
fi

echo "Test: a socket-owning server is never exempted by an attach token in argv"
make_base
jq --arg command "$OLD -S $TMP/default.sock new-session -d -s fixture 'sleep 60 attach foo'" \
  '.command = $command' "$STATE/101.json" >"$STATE/101.next"
mv "$STATE/101.next" "$STATE/101.json"
if FLY2264_STOP_LEAVE_CLIENTS=1 "$SCRIPT" "$TMP/union.json" "$OLD" >"$TMP/attach-token.out" 2>"$TMP/attach-token.err" \
    && grep -qF "kill 101 $TMP/default.sock" "$LEDGER"; then
  pass "filesystem socket authority keeps attach-token argv in the server branch"
else
  fail "socket-owning attach-token server escaped closure"
fi

echo "Test: only reviewed server shapes and attach-session clients are classified"
make_base
jq --arg command "$OLD display-message attach" '.command = $command' \
  "$STATE/101.json" >"$STATE/101.next"
mv "$STATE/101.next" "$STATE/101.json"
shape_fail=0
if "$SCRIPT" "$TMP/union.json" "$OLD" >"$TMP/unknown-shape.out" 2>"$TMP/unknown-shape.err"; then
  shape_fail=1
elif [ -s "$LEDGER" ]; then
  shape_fail=1
fi
make_base
jq --arg command "$OLD attach -t =cmux-fixture" '.command = $command' \
  "$STATE/201.json" >"$STATE/201.next"
mv "$STATE/201.next" "$STATE/201.json"
if "$SCRIPT" "$TMP/union.json" "$OLD" >"$TMP/attach-alias.out" 2>"$TMP/attach-alias.err"; then
  shape_fail=1
elif [ -s "$LEDGER" ]; then
  shape_fail=1
fi
if [ "$shape_fail" -eq 0 ]; then
  pass "unknown server argv and attach alias both fail before mutation"
else
  fail "unreviewed command shape escaped classification"
fi

echo "Test: kill failures are red while non-reaping attach clients stay informational"
make_base
if FLY2264_STOP_KILL_FAIL=1 "$SCRIPT" "$TMP/union.json" "$OLD" >"$TMP/kill.out" 2>"$TMP/kill.err"; then
  fail "stop accepted kill-server failure"
elif ! grep -qF 'kill-server failed' "$TMP/kill.err"; then
  fail "kill failure diagnostic missing"
else
  make_base
  if FLY2264_STOP_LEAVE_CLIENTS=1 "$SCRIPT" "$TMP/union.json" "$OLD" >"$TMP/client.out" 2>"$TMP/client.err" \
      && [ -f "$STATE/201.json" ] \
      && jq -e '.clientInfo[] | select(.pid == 201 and .socket == "n/a")' "$TMP/client.out" >/dev/null; then
    pass "kill failure turns red and a surviving attach client remains informational"
  else
    fail "socket-less attach client incorrectly blocked closure"
  fi
fi

if [ -f "$SCRIPT" ] && ! grep -Eq '\bpkill[[:space:]]+tmux\b' "$SCRIPT"; then
  pass "production stop script never uses pkill tmux"
else
  fail "production stop script is missing or uses pkill tmux"
fi

echo "Test: runbook pins a neutral operator seat and the updater park/reload lifecycle"
RUNBOOK="$ROOT/engineering/doc/FLY-2264-arm64-tmux-gate/cutover-runbook.md"
pre_ship_line="$(grep -nF '### 1.1 ship 前 park updater' "$RUNBOOK" | cut -d: -f1)"
ship_line="$(grep -nF '## 2. Founder ship' "$RUNBOOK" | cut -d: -f1)"
restore_section="$(sed -n '/^### 5\.5 /,/^## 6\./p' "$RUNBOOK")"
ticket_section="$(sed -n '/^## 6\./,/^## 7\./p' "$RUNBOOK")"
if [ -f "$RUNBOOK" ] \
    && grep -Fq 'founder 必须从普通 macOS Terminal.app 窗口执行' "$RUNBOOK" \
    && grep -Fq '不得从 cmux、Lead pane 或任何 tmux session 执行' "$RUNBOOK" \
    && grep -Fq '开窗前先退出 founder 自己通过 `tmux new -s ...` 创建的会话' "$RUNBOOK" \
    && grep -Fq 'export WINDOW_DIR="$HOME/.flywheel/state/FLY-2264-window-FLY-2279"' "$RUNBOOK" \
    && grep -Fq '原 `$HOME/.flywheel/state/FLY-2264-window` 仅作为只读历史证据保留' "$RUNBOOK" \
    && [[ "$pre_ship_line" =~ ^[0-9]+$ && "$ship_line" =~ ^[0-9]+$ ]] \
    && [ "$pre_ship_line" -lt "$ship_line" ] \
    && grep -Fq '$HOME/.flywheel/self-ship-urgent.d' "$RUNBOOK" \
    && grep -Fq 'launchctl bootout "gui/${window_uid}/com.flywheel.updater"' "$RUNBOOK" \
    && grep -Fq 'launchctl bootstrap "gui/${window_uid}" "$HOME/Library/LaunchAgents/com.flywheel.updater.plist"' "$RUNBOOK" \
    && grep -Fq 'fly2264_assert_updater_safe "$window_uid"' "$RUNBOOK" \
    && grep -Fq 'fly2264_assert_updater_state_safe "$window_uid"' "$RUNBOOK" \
    && grep -Fq '先发完全部 19 个 `launchctl bootout`' "$RUNBOOK" \
    && grep -Fq '共用一个最多 90 秒的截止时间' "$RUNBOOK" \
    && grep -Fq '120 秒的 run-step 预算覆盖整个脚本' "$RUNBOOK" \
    && grep -Fq "bash -euo pipefail <<'BASH'" <<<"$restore_section" \
    && grep -Fxq 'BASH' <<<"$restore_section" \
    && grep -Fq "bash -euo pipefail <<'BASH'" <<<"$ticket_section" \
    && grep -Fxq 'BASH' <<<"$ticket_section" \
    && ! grep -Fq '`com.flywheel.updater` 必须保持 loaded+enabled' "$RUNBOOK"; then
  pass "runbook fixes operator ancestry, durable evidence isolation, and updater sequencing"
else
  fail "runbook is missing one or more FLY-2279 window invariants"
fi

printf '\nResults: %d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
