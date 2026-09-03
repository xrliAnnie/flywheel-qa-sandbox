#!/usr/bin/env bash
# FLY-2270: hermetic contract for the slot-local report host and Bridge wrapper.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
STUB="$ROOT/scripts/lib/qa-report-host.mjs"
WRAPPER="$ROOT/scripts/lib/qa-report-host-bridge-wrapper.sh"
NODE="$(command -v node)"
BASH_BIN="$(command -v bash)"
TMP="$(mktemp -d /tmp/fly2270-report-host.XXXXXX)"
SLOT_BASE=$((30000 + ($$ % 10000)))
PIDS=()
SLOT_DIRS=()

cleanup() {
	for pid in "${PIDS[@]}"; do
		kill -TERM "$pid" 2>/dev/null || true
	done
	for pid in "${PIDS[@]}"; do
		wait "$pid" 2>/dev/null || true
	done
	for dir in "${SLOT_DIRS[@]}"; do
		rm -rf "$dir"
	done
	rm -rf "$TMP"
}
trap cleanup EXIT INT TERM

fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "PASS: $*"; }

remember_pid() { PIDS+=("$1"); }

make_root() {
	local slot="$1"
	local root="/tmp/flywheel-test-slot-${slot}/state/report-host"
	SLOT_DIRS+=("/tmp/flywheel-test-slot-${slot}")
	mkdir -p "$root"
	printf 'slot-token-%s\n' "$slot" > "$root/token"
	chmod 600 "$root/token"
	printf '%s\n' "$root"
}

wait_for_file() {
	local path="$1" attempts="${2:-100}"
	for ((i = 0; i < attempts; i++)); do
		[[ -s "$path" ]] && return 0
		sleep 0.05
	done
	return 1
}

wait_for_dead() {
	local pid="$1" attempts="${2:-60}"
	for ((i = 0; i < attempts; i++)); do
		kill -0 "$pid" 2>/dev/null || return 0
		sleep 0.05
	done
	return 1
}

wait_for_port_free() {
	local port="$1" attempts="${2:-60}"
	for ((i = 0; i < attempts; i++)); do
		[[ -z "$(lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null || true)" ]] && return 0
		sleep 0.05
	done
	return 1
}

assert_mutated_bytes() {
	local original="$1" mutant="$2" label="$3"
	cmp -s "$original" "$mutant" && fail "$label did not change artifact bytes"
	[[ "$(rg -c 'PARENT_GUARD_(START|POLL)' "$original")" == "2" ]] \
		|| fail "$label source guard count is not 2"
	if rg -q 'PARENT_GUARD_(START|POLL)' "$mutant"; then
		fail "$label did not remove both parent guards"
	fi
	pass "$label changes bytes and removes both parent guards"
}

start_parented_stub() {
	local stub="$1" root="$2"
	"$BASH_BIN" -c '
		node_bin="$1"; stub="$2"; root="$3"
		"$node_bin" "$stub" --root "$root" --expected-parent "$$" &
		exec sleep 60
	' _ "$NODE" "$stub" "$root" &
	PARENT_PID=$!
	remember_pid "$PARENT_PID"
	wait_for_file "$root/port" || fail "parented stub did not become ready"
	STUB_PORT="$(<"$root/port")"
	STUB_PID="$(lsof -nP -iTCP:"$STUB_PORT" -sTCP:LISTEN -t)"
	[[ "$STUB_PID" =~ ^[1-9][0-9]*$ ]] || fail "stub listener pid missing"
	remember_pid "$STUB_PID"
	curl -fsS -H "Authorization: Bearer $(<"$root/token")" \
		"http://127.0.0.1:${STUB_PORT}/v13/deployments/self-check" >/dev/null
}

[[ -f "$STUB" ]] || fail "missing $STUB"
[[ -x "$WRAPPER" ]] || fail "missing executable $WRAPPER"

# The real host reaches READY, then a real SIGKILL of its parent removes both
# process and listening socket within the three-second contract.
root="$(make_root "$SLOT_BASE")"
start_parented_stub "$STUB" "$root"
kill -KILL "$PARENT_PID"
wait "$PARENT_PID" 2>/dev/null || true
wait_for_dead "$STUB_PID" || fail "stub survived its Bridge parent"
wait_for_port_free "$STUB_PORT" || fail "stub port survived its Bridge parent"
pass "stub exits and releases its port after its parent dies"

# Positive control: remove exactly both parent checks from a copied artifact.
# The same scenario must now leave an orphan, or the preceding test is vacuous.
mutant="$TMP/qa-report-host-no-parent-guard.mjs"
cp "$STUB" "$mutant"
sed -i.bak '/PARENT_GUARD_START/d; /PARENT_GUARD_POLL/d' "$mutant"
rm -f "$mutant.bak"
assert_mutated_bytes "$STUB" "$mutant" "parent-death mutant"
root="$(make_root $((SLOT_BASE + 1)))"
start_parented_stub "$mutant" "$root"
kill -KILL "$PARENT_PID"
wait "$PARENT_PID" 2>/dev/null || true
sleep 3
kill -0 "$STUB_PID" 2>/dev/null \
	|| fail "positive control did not produce an orphan after parent death"
[[ "$(lsof -nP -iTCP:"$STUB_PORT" -sTCP:LISTEN -t 2>/dev/null)" == "$STUB_PID" ]] \
	|| fail "positive-control orphan stopped listening"
kill -TERM "$STUB_PID"
wait_for_dead "$STUB_PID" || fail "could not clean positive-control orphan"
pass "parent-death positive control produces an orphan"

# Wrapper exports the loopback URL and execs the Bridge in the same pid.
fake_bridge="$TMP/fake-bridge.sh"
cat > "$fake_bridge" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$$" > "${FAKE_BRIDGE_PID_FILE:?}"
env | LC_ALL=C sort > "${FAKE_BRIDGE_ENV_FILE:?}"
exec sleep 60
EOF
chmod +x "$fake_bridge"
root="$(make_root $((SLOT_BASE + 2)))"
FAKE_BRIDGE_PID_FILE="$root/../bridge.pid" \
	FAKE_BRIDGE_ENV_FILE="$root/../bridge-env.txt" \
	"$WRAPPER" "$root" "$NODE" -- "$fake_bridge" &
wrapper_pid=$!
remember_pid "$wrapper_pid"
wait_for_file "$root/port" || fail "wrapper did not publish a ready port"
wait_for_file "$root/../bridge.pid" || fail "fake Bridge did not start"
port="$(<"$root/port")"
stub_pid="$(lsof -nP -iTCP:"$port" -sTCP:LISTEN -t)"
remember_pid "$stub_pid"
[[ "$(<"$root/../bridge.pid")" == "$wrapper_pid" ]] \
	|| fail "wrapper did not exec the Bridge in-place"
[[ "$(lsof -a -p "$stub_pid" -d cwd -F pR | sed -n 's/^R//p')" == "$wrapper_pid" ]] \
	|| fail "stub parent is not the Bridge pid"
rg -q "^FLYWHEEL_REPORT_HOST_OVERRIDE_URL=http://127.0.0.1:${port}$" \
	"$root/../bridge-env.txt" || fail "wrapper did not export report host URL"
kill -TERM "$wrapper_pid"
wait "$wrapper_pid" 2>/dev/null || true
wait_for_dead "$stub_pid" || fail "wrapper child survived fake Bridge"
pass "wrapper binds stub lifetime and URL to the Bridge pid"

# A stub-side validation failure must take the wrapper's explicit exit-70 path
# and must never run the Bridge command.
root="$(make_root $((SLOT_BASE + 3)))"
chmod 644 "$root/token"
set +e
FAKE_BRIDGE_PID_FILE="$root/../bridge.pid" \
	FAKE_BRIDGE_ENV_FILE="$root/../bridge-env.txt" \
	"$WRAPPER" "$root" "$NODE" -- "$fake_bridge" \
	>"$TMP/wrapper-failure.out" 2>"$TMP/wrapper-failure.err"
rc=$?
set -e
[[ "$rc" == "70" ]] || fail "wrapper failure returned $rc instead of 70"
rg -q 'did not become ready' "$TMP/wrapper-failure.err" \
	|| fail "wrapper failure was not loud"
[[ ! -e "$root/../bridge.pid" ]] || fail "wrapper ran Bridge after stub failure"
[[ -z "$(pgrep -f "qa-report-host.mjs --root $root" 2>/dev/null || true)" ]] \
	|| fail "wrapper failure left a stub process"
pass "stub startup failure is loud and never starts Bridge"

# Kill the wrapper before a delayed node shim execs the host. The real host
# notices that its expected parent is already gone before listen().
slow_node="$TMP/slow-node"
cat > "$slow_node" <<EOF
#!/usr/bin/env bash
sleep 2
exec "$NODE" "\$@"
EOF
chmod +x "$slow_node"
root="$(make_root $((SLOT_BASE + 4)))"
"$WRAPPER" "$root" "$slow_node" -- "$fake_bridge" \
	>"$TMP/pre-ready.out" 2>"$TMP/pre-ready.err" &
wrapper_pid=$!
remember_pid "$wrapper_pid"
sleep 0.5
kill -KILL "$wrapper_pid"
wait "$wrapper_pid" 2>/dev/null || true
sleep 3
[[ ! -e "$root/port" ]] || fail "pre-ready parent death still wrote a port"
[[ -z "$(pgrep -f "qa-report-host.mjs --root $root" 2>/dev/null || true)" ]] \
	|| fail "pre-ready parent death left a stub process"
pass "listen-time parent guard closes the pre-ready orphan window"

# The pre-ready positive control uses a copied wrapper beside the mutated host,
# proving that the wrapper resolves and runs the changed artifact bytes.
mutant_lib="$TMP/mutant-lib"
mkdir -p "$mutant_lib"
cp "$WRAPPER" "$mutant_lib/qa-report-host-bridge-wrapper.sh"
cp "$STUB" "$mutant_lib/qa-report-host.mjs"
sed -i.bak '/PARENT_GUARD_START/d; /PARENT_GUARD_POLL/d' \
	"$mutant_lib/qa-report-host.mjs"
rm -f "$mutant_lib/qa-report-host.mjs.bak"
assert_mutated_bytes "$STUB" "$mutant_lib/qa-report-host.mjs" \
	"pre-ready mutant"
root="$(make_root $((SLOT_BASE + 5)))"
"$mutant_lib/qa-report-host-bridge-wrapper.sh" "$root" "$slow_node" -- \
	"$fake_bridge" >"$TMP/pre-ready-mutant.out" 2>"$TMP/pre-ready-mutant.err" &
wrapper_pid=$!
remember_pid "$wrapper_pid"
sleep 0.5
kill -KILL "$wrapper_pid"
wait "$wrapper_pid" 2>/dev/null || true
wait_for_file "$root/port" 100 || fail "pre-ready mutant did not produce an orphan"
port="$(<"$root/port")"
stub_pid="$(lsof -nP -iTCP:"$port" -sTCP:LISTEN -t)"
[[ "$stub_pid" =~ ^[1-9][0-9]*$ ]] || fail "pre-ready mutant orphan not listening"
remember_pid "$stub_pid"
kill -TERM "$stub_pid"
wait_for_dead "$stub_pid" || fail "could not clean pre-ready mutant orphan"
pass "pre-ready positive control produces an orphan"

# Wrapper validation happens before its only filesystem mutation (port reset).
outside="$TMP/outside"
mkdir -p "$outside"
printf 'sentinel\n' > "$outside/port"
printf 'token\n' > "$outside/token"
chmod 600 "$outside/token"
root_link="/tmp/flywheel-test-slot-$((SLOT_BASE + 6))/state/report-host"
SLOT_DIRS+=("/tmp/flywheel-test-slot-$((SLOT_BASE + 6))")
mkdir -p "$(dirname "$root_link")"
ln -s "$outside" "$root_link"
set +e
"$WRAPPER" "$root_link" "$NODE" -- "$fake_bridge" >/dev/null 2>&1
rc=$?
set -e
[[ "$rc" == "64" && "$(<"$outside/port")" == "sentinel" ]] \
	|| fail "symlinked wrapper root mutated its target"
root="$(make_root $((SLOT_BASE + 7)))"
rm "$root/token"
ln -s "$outside/token" "$root/token"
set +e
"$WRAPPER" "$root" "$NODE" -- "$fake_bridge" >/dev/null 2>&1
rc=$?
set -e
[[ "$rc" == "64" ]] || fail "wrapper accepted a symlink token"
pass "wrapper validates root and token before resetting port"

# Both node launch sites use an empty environment except explicit HOME/PATH.
node_recorder="$TMP/node-recorder"
cat > "$node_recorder" <<EOF
#!/usr/bin/env bash
name="\${1##*/}"
env | LC_ALL=C sort > "$TMP/env-seen-\${name}.txt"
exec "$NODE" "\$@"
EOF
chmod +x "$node_recorder"
VERCEL_TOKEN=leak FOO=bar env -i HOME="$HOME" PATH="$PATH" \
	"$node_recorder" -e 'process.stdout.write("minted")' >/dev/null
root="$(make_root $((SLOT_BASE + 8)))"
VERCEL_TOKEN=leak FOO=bar \
	FAKE_BRIDGE_PID_FILE="$root/../bridge.pid" \
	FAKE_BRIDGE_ENV_FILE="$root/../bridge-env.txt" \
	"$WRAPPER" "$root" "$node_recorder" -- \
	"$fake_bridge" >/dev/null 2>&1 &
wrapper_pid=$!
remember_pid "$wrapper_pid"
wait_for_file "$root/port" || fail "recording wrapper did not start"
wait_for_file "$TMP/env-seen-qa-report-host.mjs.txt" \
	|| fail "stub node environment was not recorded"
for env_file in "$TMP/env-seen--e.txt" "$TMP/env-seen-qa-report-host.mjs.txt"; do
	[[ -f "$env_file" ]] || fail "missing environment record $env_file"
	! rg -q '^(VERCEL_TOKEN|FOO)=' "$env_file" \
		|| fail "isolated node launch inherited ambient secrets"
	rg -q "^HOME=${HOME}$" "$env_file" || fail "isolated node launch lost HOME"
	rg -q "^PATH=${PATH}$" "$env_file" || fail "isolated node launch lost PATH"
done
kill -TERM "$wrapper_pid"
wait "$wrapper_pid" 2>/dev/null || true
pass "stub and token-mint node launches inherit only explicit environment"

# Direct host HTTP contract.
root="$(make_root $((SLOT_BASE + 9)))"
"$NODE" "$STUB" --root "$root" --expected-parent "$$" &
stub_pid=$!
remember_pid "$stub_pid"
wait_for_file "$root/port" || fail "direct stub did not become ready"
port="$(<"$root/port")"
base="http://127.0.0.1:${port}"
token="$(<"$root/token")"
[[ "$(lsof -nP -iTCP:"$port" -sTCP:LISTEN | awk 'NR==2 {print $8}')" == "TCP" ]] \
	|| fail "stub listener not found"

status="$(curl -sS -o "$TMP/unauthorized" -w '%{http_code}' \
	-X POST "$base/v13/deployments" -H 'content-type: application/json' -d '{}')"
[[ "$status" == "401" ]] || fail "missing bearer returned $status"
status="$(curl -sS -o "$TMP/wrong-token" -w '%{http_code}' \
	-X POST "$base/v13/deployments" -H 'Authorization: Bearer wrong' \
	-H 'content-type: application/json' -d '{}')"
[[ "$status" == "401" ]] || fail "wrong bearer returned $status"
[[ -z "$(find "$root/sites" -type f -print)" ]] \
	|| fail "unauthorized deploy changed sites"

body1="$TMP/deploy-1.json"
jq -nc '{name:"fw-reports-abc",target:"production",files:[{file:"robots.txt",data:"User-agent: *",encoding:"utf-8"},{file:"r/t1/index.html",data:"<html>one</html>",encoding:"utf-8"}],projectSettings:{framework:null}}' > "$body1"
status="$(curl -sS -o "$TMP/deploy-1.out" -w '%{http_code}' \
	-X POST "$base/v13/deployments" -H "Authorization: Bearer $token" \
	-H 'content-type: application/json' --data-binary "@$body1")"
[[ "$status" == "200" ]] || fail "valid deploy returned $status"
deployment_id="$(jq -r .id "$TMP/deploy-1.out")"
[[ "$deployment_id" =~ ^dpl_[0-9a-f]{12}$ ]] \
	|| fail "invalid deployment id"
[[ "$(jq -r .readyState "$TMP/deploy-1.out")" == "READY" ]] \
	|| fail "valid deploy was not READY"
[[ "$(curl -fsS "$base/fw-reports-abc/r/t1/")" == "<html>one</html>" ]] \
	|| fail "deployed HTML was not served"
[[ "$(curl -fsS -o /dev/null -w '%{content_type}' "$base/fw-reports-abc/r/t1/")" == "text/html; charset=utf-8" ]] \
	|| fail "deployed HTML content type is wrong"
curl -fsS "$base/fw-reports-abc/robots.txt" >/dev/null
[[ "$(curl -fsS -H "Authorization: Bearer $token" \
	"$base/v13/deployments/$deployment_id" | jq -r .readyState)" == "READY" ]] \
	|| fail "known deployment status missing"
[[ "$(curl -sS -o /dev/null -w '%{http_code}' \
	-H "Authorization: Bearer $token" "$base/v13/deployments/unknown")" == "404" ]] \
	|| fail "unknown deployment id did not 404"
pass "authenticated deploy, static serving, and status endpoints work"

fingerprint_sites() {
	find "$root/sites" -type f -print | LC_ALL=C sort | while IFS= read -r file; do
		printf '%s ' "${file#"$root/sites/"}"
		shasum -a 256 "$file" | awk '{print $1}'
	done
}

before="$(fingerprint_sites)"
bad_bodies=(
	'{"name":"BAD","target":"production","files":[{"file":"a","data":"x","encoding":"utf-8"}]}'
	'{"name":"good","target":"preview","files":[{"file":"a","data":"x","encoding":"utf-8"}]}'
	'{"name":"good","target":"production","files":[]}'
	'{"name":"good","target":"production","files":"bad"}'
	'{"name":"good","target":"production","files":[{"file":"../x","data":"x","encoding":"utf-8"}]}'
	'{"name":"good","target":"production","files":[{"file":"/x","data":"x","encoding":"utf-8"}]}'
	'{"name":"good","target":"production","files":[{"file":"x\\y","data":"x","encoding":"utf-8"}]}'
	'{"name":"good","target":"production","files":[{"file":"x\u0000y","data":"x","encoding":"utf-8"}]}'
	'{"name":"good","target":"production","files":[{"file":"x","encoding":"utf-8"}]}'
	'{"name":"good","target":"production","files":[{"file":"x","data":"x","encoding":"base64"}]}'
)
for bad in "${bad_bodies[@]}"; do
	status="$(curl -sS -o /dev/null -w '%{http_code}' -X POST \
		"$base/v13/deployments" -H "Authorization: Bearer $token" \
		-H 'content-type: application/json' --data-binary "$bad")"
	[[ "$status" == "400" ]] || fail "invalid deployment schema returned $status"
	[[ "$(fingerprint_sites)" == "$before" ]] \
		|| fail "invalid deployment schema changed sites"
done
jq -nc '{name:"good",target:"production",files:[range(0;201)|{file:(tostring),data:"x",encoding:"utf-8"}]}' > "$TMP/too-many.json"
[[ "$(curl -sS -o /dev/null -w '%{http_code}' -X POST \
	"$base/v13/deployments" -H "Authorization: Bearer $token" \
	-H 'content-type: application/json' --data-binary "@$TMP/too-many.json")" == "400" ]] \
	|| fail "more than 200 files was accepted"
[[ "$(fingerprint_sites)" == "$before" ]] \
	|| fail "too-many-files request changed sites"
pass "invalid deployment schemas fail before any site mutation"

body2="$TMP/deploy-2.json"
jq -nc '{name:"fw-reports-abc",target:"production",files:[{file:"r/t2/index.html",data:"<html>two</html>",encoding:"utf-8"}]}' > "$body2"
curl -fsS -X POST "$base/v13/deployments" -H "Authorization: Bearer $token" \
	-H 'content-type: application/json' --data-binary "@$body2" >/dev/null
[[ "$(curl -sS -o /dev/null -w '%{http_code}' "$base/fw-reports-abc/r/t1/")" == "404" ]] \
	|| fail "full replacement retained an old report"
[[ "$(curl -fsS "$base/fw-reports-abc/r/t2/")" == "<html>two</html>" ]] \
	|| fail "full replacement did not serve the new report"
jq -nc '{name:"site-one",target:"production",files:[{file:"index.html",data:"one",encoding:"utf-8"}]}' > "$TMP/site-one.json"
jq -nc '{name:"site-two",target:"production",files:[{file:"index.html",data:"two",encoding:"utf-8"}]}' > "$TMP/site-two.json"
curl -fsS -X POST "$base/v13/deployments" -H "Authorization: Bearer $token" -H 'content-type: application/json' --data-binary "@$TMP/site-one.json" >/dev/null &
p1=$!
curl -fsS -X POST "$base/v13/deployments" -H "Authorization: Bearer $token" -H 'content-type: application/json' --data-binary "@$TMP/site-two.json" >/dev/null &
p2=$!
wait "$p1"; wait "$p2"
[[ "$(curl -fsS "$base/site-one/index.html")" == "one" ]] \
	|| fail "concurrent deploy lost site one"
[[ "$(curl -fsS "$base/site-two/index.html")" == "two" ]] \
	|| fail "concurrent deploy lost site two"
pass "deployments replace one site atomically and serialize concurrent writes"

mkdir -p "$root/sites-evil"
printf 'outside\n' > "$root/sites-evil/x.html"
for attack in \
	'/fw-reports-abc/../../etc/passwd' \
	'/fw-reports-abc/r/%2e%2e/%2e%2e/token' \
	'/../sites-evil/x.html'
do
	status="$(curl --path-as-is -sS -o /dev/null -w '%{http_code}' "$base$attack")"
	[[ "$status" == "404" ]] || fail "traversal $attack returned $status"
done
listener="$(lsof -nP -iTCP:"$port" -sTCP:LISTEN | awk 'NR==2 {print $9}')"
[[ "$listener" == "127.0.0.1:${port}" ]] \
	|| fail "stub listener is not bound only to IPv4 loopback: $listener"
pass "static serving rejects traversal and binds only IPv4 loopback"

dd if=/dev/zero bs=1048576 count=17 2>/dev/null | tr '\0' x > "$TMP/oversize"
[[ "$(curl -sS -o /dev/null -w '%{http_code}' -X POST \
	"$base/v13/deployments" -H "Authorization: Bearer $token" \
	-H 'content-type: application/json' --data-binary "@$TMP/oversize")" == "413" ]] \
	|| fail "oversized request did not return 413"
"$NODE" -e '
	const net = require("node:net");
	const socket = net.connect(Number(process.argv[1]), "127.0.0.1", () => {
		socket.write("POST /v13/deployments HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 100\r\n\r\n{");
		socket.destroy();
	});
' "$port"
curl -fsS -H "Authorization: Bearer $token" \
	"$base/v13/deployments/self-check" >/dev/null
pass "body limit and partial-body abort do not wedge later requests"

kill -TERM "$stub_pid"
wait "$stub_pid" 2>/dev/null || true

# Direct-start filesystem and argument guards reject before writing a port or
# changing any external directory.
assert_stub_exit_64() {
	local root_arg="$1" token_mode="$2" sites_mode="$3" label="$4"
	local case_dir="$TMP/$label" external_dir="$TMP/$label-external"
	mkdir -p "$case_dir" "$external_dir"
	printf 'sentinel\n' > "$external_dir/sentinel"
	if [[ "$root_arg" == "symlink" ]]; then
		ln -s "$case_dir" "$TMP/$label-root"
		case_dir="$TMP/$label-root"
	fi
	if [[ "$token_mode" == "symlink" ]]; then
		printf 'token\n' > "$external_dir/token"
		chmod 600 "$external_dir/token"
		ln -s "$external_dir/token" "$case_dir/token"
	else
		printf 'token\n' > "$case_dir/token"
		chmod 600 "$case_dir/token"
	fi
	if [[ "$sites_mode" == "symlink" ]]; then
		ln -s "$external_dir" "$case_dir/sites"
	fi
	set +e
	"$NODE" "$STUB" --root "$case_dir" --expected-parent "$$" \
		>"$TMP/$label.out" 2>"$TMP/$label.err"
	rc=$?
	set -e
	[[ "$rc" == "64" ]] || fail "$label exited $rc instead of 64"
	[[ ! -e "$case_dir/port" ]] || fail "$label wrote a port"
	expected_external="$external_dir/sentinel"
	if [[ "$token_mode" == "symlink" ]]; then
		expected_external+=$'\n'"$external_dir/token"
	fi
	[[ "$(find "$external_dir" -maxdepth 1 -type f -print | LC_ALL=C sort)" == \
		"$expected_external" ]] || fail "$label changed external directory"
}

assert_stub_exit_64 symlink regular absent root-symlink
assert_stub_exit_64 real symlink absent token-symlink
assert_stub_exit_64 real regular symlink sites-symlink
for args in \
	"--root $TMP/missing-parent" \
	"--root $TMP/missing-parent --expected-parent nope"
do
	mkdir -p "$TMP/missing-parent"
	printf 'token\n' > "$TMP/missing-parent/token"
	chmod 600 "$TMP/missing-parent/token"
	set +e
	# shellcheck disable=SC2086
	"$NODE" "$STUB" $args >/dev/null 2>&1
	rc=$?
	set -e
	[[ "$rc" == "64" ]] || fail "invalid arguments exited $rc instead of 64"
done
pass "stub rejects symlink roots, tokens, sites, and invalid parent arguments"

echo "qa-report-host tests passed"
