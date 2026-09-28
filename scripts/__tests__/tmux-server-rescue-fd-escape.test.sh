#!/bin/bash
# FLY-2965: the bounded probe must end with its managed child, never with the
# last holder of the child's output descriptors.
#
# On 2026-09-27 the shuttle's Python probe wrapper outlived its 3s budget for
# nine hours. A tmux client hands its stdio descriptors to whatever answers
# the socket (SCM_RIGHTS); when that peer is not a tmux server it may keep
# them. The old wrapper collected output through pipes and waited for EOF, so
# killing the client could not finish the probe while the peer lived.
#
# The peer here is a real Unix-socket server that receives and keeps the
# descriptors with recvmsg(SCM_RIGHTS). The deterministic child passes its own
# stdout/stderr exactly the way a tmux client does, so the regression does not
# depend on a tmux binary; a real tmux client case runs when tmux exists.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LIB="$SCRIPT_DIR/../lib/tmux-server-rescue.sh"
# Unix socket paths are limited to ~104 bytes; keep the fixture root short.
TEST_ROOT="$(mktemp -d /tmp/f2965-fd.XXXXXX)" || exit 1
trap 'chmod -R u+rwx "$TEST_ROOT" 2>/dev/null; rm -rf "$TEST_ROOT"' EXIT

PASSED=0
FAILED=0
pass() { PASSED=$((PASSED + 1)); echo "  ✓ $*"; }
fail() { FAILED=$((FAILED + 1)); echo "  ✗ $*" >&2; }

if [[ ! -x /usr/bin/python3 ]]; then
  fail "the bounded probe requires /usr/bin/python3"
  echo "[tmux-server-rescue-fd-escape.test] passed=$PASSED failed=$FAILED"
  exit 1
fi

# Child used by the peer-retention cases: optionally write, hand stdout and
# stderr to the peer over SCM_RIGHTS, then linger or exit.
cat > "$TEST_ROOT/pass-fds.py" <<'PY'
import array, os, socket, sys, time
path, out, err, action = sys.argv[1:5]
os.write(1, out.encode()); os.write(2, err.encode())
client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
client.connect(path)
client.sendmsg([b"fds"], [(socket.SOL_SOCKET, socket.SCM_RIGHTS, array.array("i", [1, 2]))])
client.close()
if action == "linger":
    time.sleep(60)
elif action == "pause":
    # Stay alive while the peer appends through the shared description.
    time.sleep(0.5)
PY

# Driver: start a descriptor-keeping peer, run the real probe, and report how
# the probe ended. The peer releases the descriptors only after RELEASE_AFTER
# seconds; a probe that waited for them could therefore only return after the
# release, so "the peer still held them when the probe returned" is an
# ordering proof that needs no wall-clock bound (and bounds the pre-fix run).
cat > "$TEST_ROOT/driver.py" <<'PY'
import array, json, os, socket, subprocess, sys, threading, time
lib, sock_path, release_after, budget = sys.argv[1], sys.argv[2], float(sys.argv[3]), sys.argv[4]
mode = sys.argv[5]
argv = sys.argv[6:]
held, lock = [], threading.Lock()
stop = threading.Event()
result = {"peerAppendBytes": 0}
server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
server.bind(sock_path); server.listen(4); server.settimeout(0.05)

def serve():
    while not stop.is_set():
        try:
            conn, _ = server.accept()
        except socket.timeout:
            continue
        conn.settimeout(0.05)
        while not stop.is_set():
            try:
                data, ancillary, _flags, _addr = conn.recvmsg(4096, socket.CMSG_SPACE(64))
            except socket.timeout:
                continue
            except OSError:
                break
            for level, kind, payload in ancillary:
                if level == socket.SOL_SOCKET and kind == socket.SCM_RIGHTS:
                    fds = array.array("i"); fds.frombytes(payload[: len(payload) - len(payload) % fds.itemsize])
                    with lock:
                        held.extend(fds)
            if not data:
                break
        with lock:
            held.append(conn.detach())

def append_forever():
    # Keep writing through the retained stdout description after the child
    # exits; a probe that follows the file to EOF would never finish.
    while not stop.is_set():
        with lock:
            fd = held[0] if held else None
        if fd is not None:
            try:
                os.write(fd, b"Z" * 64)
                result["peerAppendBytes"] += 64
            except OSError:
                pass
        time.sleep(0.01)

def release():
    with lock:
        for fd in held:
            try:
                os.close(fd)
            except OSError:
                pass
        held.clear()

threading.Thread(target=serve, daemon=True).start()
if mode == "append":
    threading.Thread(target=append_forever, daemon=True).start()
timer = threading.Timer(release_after, release); timer.start()
started = time.monotonic()
probe = subprocess.run(
    ["/bin/bash", "-c", 'source "$1"; shift; tmux_rescue_probe "$@"', "probe", lib, budget] + argv,
    capture_output=True, timeout=release_after + 30,
)
result["elapsed"] = round(time.monotonic() - started, 3)
# The peer thread may still be draining the handoff when a fast child exits.
settle = time.monotonic() + 1
while time.monotonic() < settle:
    with lock:
        if len(held) >= 2:
            break
    time.sleep(0.02)
with lock:
    result["peerHeldAtReturn"] = len(held)
    if mode == "offset" and held:
        try:
            result["peerOffset"] = os.lseek(held[0], 0, os.SEEK_CUR)
        except OSError as error:
            result["peerOffset"] = "unseekable:%d" % error.errno
stop.set(); timer.cancel(); release(); server.close()
result["rc"] = probe.returncode
result["stdout"] = probe.stdout.decode("latin-1")
result["stderr"] = probe.stderr.decode("latin-1")
print(json.dumps(result))
PY

run_driver() {
  local name="$1" release_after="$2" budget="$3" mode="$4"
  shift 4
  /usr/bin/python3 "$TEST_ROOT/driver.py" "$LIB" "$TEST_ROOT/$name.sock" \
    "$release_after" "$budget" "$mode" "$@"
}

echo "Test: FLY-2965 timeout ends with the managed child while the peer keeps its output"
out="$(run_driver linger 20 1 hold /usr/bin/python3 "$TEST_ROOT/pass-fds.py" \
  "$TEST_ROOT/linger.sock" partial-out partial-err linger)"
if jq -e '.rc == 124 and .peerHeldAtReturn >= 2
    and .stdout == "partial-out" and .stderr == "partial-err"' <<<"$out" >/dev/null; then
  pass "budget expiry returns 124 with partial output while the peer still holds the descriptors"
else
  fail "retained descriptors pinned the timed-out probe: $out"
fi

echo "Test: FLY-2965 a finished child is not held open by a descriptor-keeping peer"
out="$(run_driver exited 20 5 hold /usr/bin/python3 "$TEST_ROOT/pass-fds.py" \
  "$TEST_ROOT/exited.sock" done warn exit)"
if jq -e '.rc == 0 and .peerHeldAtReturn >= 2
    and .stdout == "done" and .stderr == "warn"' <<<"$out" >/dev/null; then
  pass "a completed child returns its own status and bytes while the peer still holds them"
else
  fail "completed child waited for the peer: $out"
fi

echo "Test: FLY-2965 replay reads a fixed length instead of following peer appends"
out="$(run_driver append 20 5 append /usr/bin/python3 "$TEST_ROOT/pass-fds.py" \
  "$TEST_ROOT/append.sock" A '' pause)"
if jq -e '.rc == 0 and .peerHeldAtReturn >= 2 and (.stdout | test("^AZ+$"))
    and .peerAppendBytes > 0' <<<"$out" >/dev/null; then
  pass "the probe returns a bounded prefix while the peer keeps appending"
else
  fail "replay followed or lost the peer-shared output: $(jq -c 'del(.stdout)' <<<"$out" 2>/dev/null || echo "$out")"
fi

echo "Test: FLY-2965 replay never moves the offset shared with the peer"
out="$(run_driver offset 20 5 offset /usr/bin/python3 "$TEST_ROOT/pass-fds.py" \
  "$TEST_ROOT/offset.sock" ABCD '' exit)"
if jq -e '.rc == 0 and .stdout == "ABCD" and .peerOffset == 4' <<<"$out" >/dev/null \
  && grep -q 'os.pread(' "$LIB" && ! grep -q '\.seek(' "$LIB"; then
  pass "positional reads leave the shared description offset where the child left it"
else
  fail "replay disturbed the shared offset: $out"
fi

echo "Test: FLY-2965 real tmux client against a descriptor-keeping non-tmux socket"
if command -v tmux >/dev/null 2>&1; then
  tmux_bin="$(command -v tmux)"
  out="$(unset TMUX; export HOME="$TEST_ROOT"; run_driver real 20 1 hold \
    "$tmux_bin" -S "$TEST_ROOT/real.sock" -N list-sessions -F '#{session_name}')"
  if jq -e '.rc == 124 and .peerHeldAtReturn >= 1' <<<"$out" >/dev/null; then
    pass "a real tmux client probe ends within its budget while the peer keeps its descriptors"
  else
    fail "real tmux probe outlived its budget: $out"
  fi
else
  echo "  - SKIP: tmux not installed; deterministic SCM_RIGHTS cases above still ran"
fi

probe() { /bin/bash -c 'source "$1"; shift; tmux_rescue_probe "$@"' probe "$LIB" "$@"; }

echo "Test: FLY-2965 ordinary output, status, and signal mapping are unchanged"
rc=0; stdout="$(probe 5 /bin/sh -c 'printf out; printf err >&2; exit 3' 2>"$TEST_ROOT/c1.err")" || rc=$?
[[ "$rc" == 3 && "$stdout" == out && "$(cat "$TEST_ROOT/c1.err")" == err ]] \
  && pass "stdout/stderr bytes and a nonzero status replay exactly" \
  || fail "ordinary replay mismatch rc=$rc stdout=[$stdout] stderr=[$(cat "$TEST_ROOT/c1.err")]"
rc=0; probe 5 /usr/bin/python3 -c 'import signal; signal.raise_signal(signal.SIGTERM)' >/dev/null 2>&1 || rc=$?
[[ "$rc" == 143 ]] && pass "a signalled child maps to 128+signal" || fail "signal mapping rc=$rc"
rc=0; stdout="$(probe 5 /bin/sh -c 'exit 0')" || rc=$?
[[ "$rc" == 0 && -z "$stdout" ]] && pass "empty output stays empty" || fail "empty output rc=$rc [$stdout]"
rc=0; stdout="$(probe 5 /bin/cat)" || rc=$?
[[ "$rc" == 0 && -z "$stdout" ]] && pass "stdin stays /dev/null" || fail "stdin was not /dev/null rc=$rc"
rc=0
probe 5 /usr/bin/python3 -c 'import sys; sys.stdout.buffer.write(bytes(range(256)) * 4)' > "$TEST_ROOT/binary.out" || rc=$?
/usr/bin/python3 -c 'import sys; sys.stdout.buffer.write(bytes(range(256)) * 4)' > "$TEST_ROOT/binary.expected"
[[ "$rc" == 0 ]] && cmp -s "$TEST_ROOT/binary.out" "$TEST_ROOT/binary.expected" \
  && pass "binary output with NUL bytes replays byte-for-byte" || fail "binary replay mismatch rc=$rc"
rc=0
probe 20 /usr/bin/python3 -c 'import sys; sys.stdout.buffer.write(b"x" * (8 << 20))' > "$TEST_ROOT/large.out" || rc=$?
[[ "$rc" == 0 && "$(wc -c < "$TEST_ROOT/large.out" | tr -d ' ')" == "$((8 << 20))" ]] \
  && pass "8 MiB output completes without a pipe-capacity stall" || fail "large output rc=$rc"
rc=0; stdout="$(probe 1 /bin/sh -c 'printf partial; exec sleep 30')" || rc=$?
[[ "$rc" == 124 && "$stdout" == partial ]] \
  && pass "timeout keeps the bytes produced before expiry" || fail "timeout partial rc=$rc [$stdout]"

echo "Test: FLY-2965 capture infrastructure failures are 125, never a child status"
marker="$TEST_ROOT/child-ran"
rc=0; TMPDIR="$TEST_ROOT/missing" probe 5 /usr/bin/touch "$marker" >/dev/null 2>&1 || rc=$?
[[ "$rc" == 125 && ! -e "$marker" ]] && pass "missing TMPDIR fails 125 before spawning" \
  || fail "missing TMPDIR rc=$rc ran=$([[ -e "$marker" ]] && echo yes || echo no)"
mkdir -p "$TEST_ROOT/readonly"; chmod 500 "$TEST_ROOT/readonly"
rc=0; TMPDIR="$TEST_ROOT/readonly" probe 5 /usr/bin/touch "$marker" >/dev/null 2>&1 || rc=$?
[[ "$rc" == 125 && ! -e "$marker" ]] && pass "unwritable TMPDIR fails 125 before spawning" \
  || fail "unwritable TMPDIR rc=$rc"
rc=0; (cd "$TEST_ROOT" && TMPDIR=relative probe 5 /usr/bin/touch "$marker" >/dev/null 2>&1) || rc=$?
[[ "$rc" == 125 && ! -e "$marker" && ! -e "$TEST_ROOT/relative" ]] \
  && pass "a relative TMPDIR never falls back to the working directory" || fail "relative TMPDIR rc=$rc"
rc=0; probe 5 "$TEST_ROOT/no-such-binary" >/dev/null 2>&1 || rc=$?
[[ "$rc" == 125 ]] && pass "an unspawnable command is 125, not Python's default 1" || fail "spawn failure rc=$rc"

echo "Test: FLY-2965 captured output is owner-only and already unlinked"
mkdir -p "$TEST_ROOT/capture"
rc=0
stdout="$(TMPDIR="$TEST_ROOT/capture" probe 5 /usr/bin/python3 -c '
import os, stat, sys
listing = os.listdir(sys.argv[1])
mode = stat.S_IMODE(os.fstat(1).st_mode)
sys.stdout.write("secret-token-f2965 mode=%o entries=%d" % (mode, len(listing)))
' "$TEST_ROOT/capture")" || rc=$?
[[ "$rc" == 0 && "$stdout" == "secret-token-f2965 mode=600 entries=0" \
    && -z "$(ls -A "$TEST_ROOT/capture")" ]] \
  && pass "capture files are 0600, unlinked before the child runs, and leave no residue" \
  || fail "capture file exposure rc=$rc [$stdout] residue=[$(ls -A "$TEST_ROOT/capture")]"

echo
echo "[tmux-server-rescue-fd-escape.test] passed=$PASSED failed=$FAILED"
[[ "$FAILED" -eq 0 ]]
