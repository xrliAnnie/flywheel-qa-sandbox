#!/usr/bin/env bash
# FLY-2204: kernel peer-credential enforcement must run before the writer handler.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SOURCE="$ROOT/scripts/calendar-isolation/raya-calendar-peer-proxy.c"
TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/fly2204-peer-proxy.XXXXXX")"
trap '[[ -z "${PROXY_PID:-}" ]] || kill "$PROXY_PID" 2>/dev/null || true; rm -rf "$TMP_ROOT"' EXIT
PASS=0
FAIL=0
pass() { PASS=$((PASS + 1)); printf 'PASS %s\n' "$1"; }
fail() { FAIL=$((FAIL + 1)); printf 'FAIL %s\n' "$1" >&2; }

if [[ ! -f "$SOURCE" ]]; then
	fail "peer proxy source exists"
	printf '%s passed, %s failed\n' "$PASS" "$FAIL"
	exit 1
fi

CC_BIN="$(command -v cc 2>/dev/null || true)"
if [[ -z "$CC_BIN" ]]; then
	fail "C compiler is available"
	printf '%s passed, %s failed\n' "$PASS" "$FAIL"
	exit 1
fi

PROXY="$TMP_ROOT/raya-calendar-peer-proxy"
if "$CC_BIN" -std=c11 -Wall -Wextra -Werror -O2 "$SOURCE" -o "$PROXY"; then
	pass "P1 peer proxy compiles cleanly"
else
	fail "P1 peer proxy compilation"
	printf '%s passed, %s failed\n' "$PASS" "$FAIL"
	exit 1
fi

HANDLER="$TMP_ROOT/handler.sh"
HANDLER_CALLS="$TMP_ROOT/handler.calls"
cat > "$HANDLER" <<'EOF'
#!/usr/bin/env bash
IFS= read -r request
printf '%s\n' "$request" >> "$HANDLER_CALLS"
printf '%s\n' '{"ok":true}'
EOF
chmod 700 "$HANDLER"

wait_for_socket() {
	local socket="$1"
	for _ in $(seq 1 100); do
		[[ -S "$socket" ]] && return 0
		sleep 0.02
	done
	return 1
}

call_proxy() {
	local socket="$1"
	SOCKET_PATH="$socket" node - <<'NODE'
const net = require("node:net");
const socket = net.createConnection(process.env.SOCKET_PATH);
const timer = setTimeout(() => {
	console.error("client timeout");
	socket.destroy();
	process.exitCode = 2;
}, 2000);
let response = "";
socket.setEncoding("utf8");
socket.on("connect", () => socket.end('{"operation":"sync"}\n'));
socket.on("data", (chunk) => { response += chunk; });
socket.on("end", () => {
	clearTimeout(timer);
	process.stdout.write(response);
});
socket.on("error", (error) => {
	clearTimeout(timer);
	console.error(error.message);
	process.exitCode = 3;
});
NODE
}

inspect_rejection() {
	local socket="$1"
	SOCKET_PATH="$socket" node - <<'NODE'
const net = require("node:net");
const socket = net.createConnection(process.env.SOCKET_PATH);
const timer = setTimeout(() => {
	console.error("client timeout");
	socket.destroy();
	process.exitCode = 2;
}, 2000);
let response = "";
socket.setEncoding("utf8");
socket.on("data", (chunk) => { response += chunk; });
socket.on("end", () => {
	clearTimeout(timer);
	process.stdout.write(response);
});
socket.on("error", (error) => {
	clearTimeout(timer);
	console.error(error.message);
	process.exitCode = 3;
});
NODE
}

socket_mode() {
	if stat -f '%Lp' "$1" >/dev/null 2>&1; then
		stat -f '%Lp' "$1"
	else
		stat -c '%a' "$1"
	fi
}

SOCKET="$TMP_ROOT/authorized.sock"
HANDLER_CALLS="$HANDLER_CALLS" "$PROXY" "$SOCKET" "$(id -u)" "$HANDLER" \
	>"$TMP_ROOT/authorized.out" 2>"$TMP_ROOT/authorized.err" &
PROXY_PID=$!
if wait_for_socket "$SOCKET" \
	&& [[ "$(socket_mode "$SOCKET")" == 660 ]] \
	&& [[ "$(call_proxy "$SOCKET")" == '{"ok":true}' ]] \
	&& grep -q '"operation":"sync"' "$HANDLER_CALLS"; then
	pass "P2 authorized peer reaches handler through a group-only socket"
else fail "P2 authorized peer path"; fi
kill "$PROXY_PID" 2>/dev/null || true
wait "$PROXY_PID" 2>/dev/null || true
PROXY_PID=""

: > "$HANDLER_CALLS"
SOCKET="$TMP_ROOT/denied.sock"
HANDLER_CALLS="$HANDLER_CALLS" "$PROXY" "$SOCKET" "$(( $(id -u) + 1 ))" "$HANDLER" \
	>"$TMP_ROOT/denied.out" 2>"$TMP_ROOT/denied.err" &
PROXY_PID=$!
response=""
if wait_for_socket "$SOCKET"; then
	response="$(inspect_rejection "$SOCKET")"
fi
if [[ "$response" == '{"ok":false,"error":"unauthorized peer"}' ]] \
	&& [[ ! -s "$HANDLER_CALLS" ]]; then
	pass "P3 unauthorized peer is rejected before handler execution"
else fail "P3 unauthorized peer guard"; fi

printf '%s passed, %s failed\n' "$PASS" "$FAIL"
exit "$FAIL"
