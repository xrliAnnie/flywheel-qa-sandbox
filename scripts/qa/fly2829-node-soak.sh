#!/bin/bash
# FLY-2829 C8: hermetic soak harness for the cmux node-presence watcher.
#
# Runs the REAL `flywheel-cmux-sync.sh --watch` against a production-sized
# stale node registry with every external boundary replaced: a cmux shim that
# keeps a faithful workspace model and logs every call, a Bridge fixture that
# serves the live/recent-terminal rosters, a private (or stub) tmux, and a
# private HOME so no production state file is touched. It samples the model
# every 30s and prints one verdict line per mode:
#
#   formal / smoke : FLY2829-SOAK <formal|smoke> <PASS|FAIL|INVALID> start=<n> end=<n> samples=<k> creates=<n>
#   negative       : FLY2829-SOAK negative <PASS|FAIL|INVALID> start=<n> end=<n> terminal=<n> node=<n> other=<n> samples=<k>
#   restart-budget : FLY2829-SOAK restart <PASS|FAIL|INVALID> instances=<n> creates=<n> max_burst=<n>/<s>s terms_ok=<n>/<n>
#
# Usage:
#   fly2829-node-soak.sh --registry <file> --minutes <N> [--script-dir <checkout>] [--baseline <commit>]
#       [--expect-growth] [--smoke] [--restart-every <sec>] [--live-fixture <json-file|count>] [--out <dir>]
#
# --baseline materialises the whole `scripts/` tree of <commit> with git archive
# and runs the watcher from there (the script sources sibling libraries by its
# own BASH_SOURCE). The negative control (--expect-growth) is the validity
# premise of every fixed-code verdict: if this harness cannot reproduce the
# unreceipted `Terminal N` flood on the pre-fix tree, its "no growth" on the fix
# is not evidence.
set -uo pipefail

usage() {
  sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
  exit 2
}

ROOT_DEFAULT="$(cd "$(dirname "$0")/../.." && pwd)"
REGISTRY=""; MINUTES=""; SCRIPT_DIR="$ROOT_DEFAULT"; BASELINE=""; EXPECT_GROWTH=0; SMOKE=0
RESTART_EVERY=0; LIVE_FIXTURE=3; OUT=""
SAMPLE_INTERVAL="${FLY2829_SOAK_SAMPLE_INTERVAL:-30}"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --registry) REGISTRY="${2:-}"; shift 2 ;;
    --minutes) MINUTES="${2:-}"; shift 2 ;;
    --script-dir) SCRIPT_DIR="${2:-}"; shift 2 ;;
    --baseline) BASELINE="${2:-}"; shift 2 ;;
    --expect-growth) EXPECT_GROWTH=1; shift ;;
    --smoke) SMOKE=1; shift ;;
    --restart-every) RESTART_EVERY="${2:-}"; shift 2 ;;
    --live-fixture) LIVE_FIXTURE="${2:-}"; shift 2 ;;
    --out) OUT="${2:-}"; shift 2 ;;
    -h|--help) usage ;;
    *) echo "unknown argument: $1" >&2; usage ;;
  esac
done
[[ -n "$REGISTRY" && ( -f "$REGISTRY" || "$REGISTRY" == /dev/null ) ]] || { echo "--registry must name a readable file (or /dev/null)" >&2; usage; }
case "$MINUTES" in ''|*[!0-9]*) echo "--minutes must be a positive integer" >&2; usage ;; esac
case "$RESTART_EVERY" in *[!0-9]*) echo "--restart-every must be an integer" >&2; usage ;; esac
case "$SAMPLE_INTERVAL" in ''|*[!0-9]*) SAMPLE_INTERVAL=30 ;; esac
(( SAMPLE_INTERVAL >= 5 )) || SAMPLE_INTERVAL=5

MODE=formal
if (( RESTART_EVERY > 0 )); then
  MODE=restart
  [[ "$SMOKE" == 1 ]] || { echo "--restart-every requires --smoke" >&2; usage; }
  (( RESTART_EVERY >= 20 )) || { echo "--restart-every must be >= 20 seconds" >&2; usage; }
elif [[ "$EXPECT_GROWTH" == 1 ]]; then
  MODE=negative
  (( MINUTES >= 2 )) || { echo "negative control needs --minutes >= 2" >&2; usage; }
elif [[ "$SMOKE" == 1 ]]; then
  MODE=smoke
  (( MINUTES >= 2 && MINUTES <= 5 )) || { echo "--smoke needs --minutes 2..5" >&2; usage; }
else
  (( MINUTES >= 30 )) || { echo "formal soak needs --minutes >= 30 (use --smoke for 2..5)" >&2; usage; }
fi
if [[ "$MODE" == restart ]]; then
  (( MINUTES >= 2 && MINUTES <= 5 )) || { echo "restart-budget mode needs --minutes 2..5" >&2; usage; }
fi

TMP=$(mktemp -d -t fly2829-soak-XXXXXX) || exit 2
[[ -n "$OUT" ]] || OUT="$TMP/out"
mkdir -p "$OUT" || exit 2
echo "out=$OUT"
echo "tmp=$TMP mode=$MODE minutes=$MINUTES sample_interval=${SAMPLE_INTERVAL}s"

WATCHER_PID=""; BRIDGE_PID=""; SOCKET_PID=""; TMUX_SOCK="$TMP/tmux.sock"; REAL_TMUX=""
INVALID_REASON=""
cleanup() {
  if [[ -n "$WATCHER_PID" ]] && kill -0 "$WATCHER_PID" 2>/dev/null; then
    kill -TERM "$WATCHER_PID" 2>/dev/null || true
    wait "$WATCHER_PID" 2>/dev/null || true
  fi
  [[ -n "$BRIDGE_PID" ]] && { kill -TERM "$BRIDGE_PID" 2>/dev/null || true; wait "$BRIDGE_PID" 2>/dev/null || true; }
  [[ -n "$SOCKET_PID" ]] && { kill -TERM "$SOCKET_PID" 2>/dev/null || true; wait "$SOCKET_PID" 2>/dev/null || true; }
  [[ -n "$REAL_TMUX" && -S "$TMUX_SOCK" ]] && "$REAL_TMUX" -S "$TMUX_SOCK" kill-server 2>/dev/null || true
}
trap cleanup EXIT

# ── script tree ───────────────────────────────────────────────────────────
if [[ -n "$BASELINE" ]]; then
  mkdir -p "$TMP/baseline" || exit 2
  if ! git -C "$ROOT_DEFAULT" archive "$BASELINE" scripts | tar -x -C "$TMP/baseline"; then
    echo "FLY2829-SOAK $MODE INVALID reason=baseline-archive commit=$BASELINE"; exit 3
  fi
  SCRIPT_DIR="$TMP/baseline"
fi
WATCHER="$SCRIPT_DIR/scripts/flywheel-cmux-sync.sh"
[[ -f "$WATCHER" ]] || { echo "FLY2829-SOAK $MODE INVALID reason=no-script path=$WATCHER"; exit 3; }
echo "script=$WATCHER"

# ── hermetic layout ───────────────────────────────────────────────────────
HOME_DIR="$TMP/home"; STATE="$HOME_DIR/.flywheel/state"; BIN="$TMP/bin"
mkdir -p "$STATE" "$BIN" "$HOME_DIR/.flywheel/bin" "$TMP/view-wal" || exit 2
SHIM_STATE="$TMP/cmux-model.json"; CALLS_LOG="$OUT/calls.log"; : > "$CALLS_LOG"
printf '{"next":1,"rows":[]}\n' > "$SHIM_STATE"
if [[ "$REGISTRY" != /dev/null && -s "$REGISTRY" ]]; then
  cp "$REGISTRY" "$STATE/cmux-node-registry" || exit 2
fi
REGISTRY_START=$(grep -c . "$STATE/cmux-node-registry" 2>/dev/null || true)

# Live fixture: integer → N running windowless executions; otherwise a file.
LIVE_JSON="$TMP/live.json"
case "$LIVE_FIXTURE" in
  ''|*[!0-9]*) [[ -f "$LIVE_FIXTURE" ]] || { echo "--live-fixture must be a count or a JSON file" >&2; exit 2; }; cp "$LIVE_FIXTURE" "$LIVE_JSON" ;;
  *) python3 - "$LIVE_FIXTURE" > "$LIVE_JSON" <<'PY'
import json,sys
n=int(sys.argv[1])
rows=[{"execution_id":"soak-live-%d"%i,"status":"running","identifier":"FLY-SOAK-%d"%i,"session_role":"implement",
       "adapter_type":"remote-control","issue_title":"soak live %d"%i} for i in range(1,n+1)]
print(json.dumps({"count":len(rows),"sessions":rows}))
PY
  ;;
esac
LIVE_COUNT=$(python3 -c 'import json,sys; print(len(json.load(open(sys.argv[1]))["sessions"]))' "$LIVE_JSON") || exit 2

# ── cmux shim (bash entry + python model) ─────────────────────────────────
cat > "$BIN/cmux-shim.py" <<'PY'
import fcntl, json, os, sys, time, uuid
state = os.environ["FLY2829_SHIM_STATE"]; log = os.environ["FLY2829_SHIM_LOG"]
args = sys.argv[1:]
verb = None; want_json = False; rest = []
i = 0
while i < len(args):
    a = args[i]
    if a == "--socket": i += 2; continue
    if a == "--json": want_json = True; i += 1; continue
    if a == "--id-format": i += 2; continue
    if verb is None and not a.startswith("--"): verb = a; i += 1; continue
    rest.append(a); i += 1
inst = os.environ.get("FLY2829_WATCHER_INSTANCE", "-")
lock = open(state + ".lock", "a"); fcntl.flock(lock, fcntl.LOCK_EX)
with open(log, "a") as f:
    f.write("%d|%s|%s|%s\n" % (int(time.time()), inst, verb or "-", " ".join(rest)))
try:
    m = json.load(open(state))
except Exception:
    m = {"next": 1, "rows": []}
def save():
    tmp = state + ".tmp"
    with open(tmp, "w") as f: json.dump(m, f)
    os.replace(tmp, state)
def opt(name):
    if name in rest:
        j = rest.index(name)
        return rest[j + 1] if j + 1 < len(rest) else None
    return None
def find(ref):
    for r in m["rows"]:
        if r["ref"] == ref: return r
    return None
if verb == "ping":
    print("PONG")
elif verb == "list-workspaces":
    if want_json:
        print(json.dumps({"workspaces": [{"ref": r["ref"], "id": r["id"], "title": r["title"]} for r in m["rows"]]}))
    else:
        for r in m["rows"]: print("%s\t%s" % (r["ref"], r["title"]))
elif verb == "new-workspace":
    n = m["next"]; m["next"] = n + 1
    r = {"ref": "workspace:%d" % n, "id": str(uuid.uuid4()), "title": "Terminal %d" % n, "surface": opt("--command") or "zsh"}
    m["rows"].append(r); save(); print("OK %s" % r["ref"])
elif verb in ("rename-workspace", "rename-tab"):
    r = find(opt("--workspace"))
    if r is None or not rest: sys.exit(1)
    r["title" if verb == "rename-workspace" else "surface"] = rest[-1]; save(); print("OK")
elif verb == "close-workspace":
    ref = opt("--workspace")
    if find(ref) is None: sys.exit(1)
    m["rows"] = [x for x in m["rows"] if x["ref"] != ref]; save(); print("OK")
elif verb == "list-pane-surfaces":
    r = find(opt("--workspace"))
    if r is None: sys.exit(1)
    print(json.dumps({"surfaces": [{"title": r["surface"]}]}))
elif verb == "read-screen":
    print("")
else:
    print("OK")
PY
printf '%s\n' '#!/bin/bash' 'exec python3 "$(dirname "$0")/cmux-shim.py" "$@"' > "$BIN/cmux"
printf '%s\n' '#!/bin/bash' 'exit 1' > "$BIN/pgrep"
printf '%s\n' '#!/bin/bash' 'exit 1' > "$BIN/lsof"
printf '%s\n' '#!/bin/bash' 'printf "%s\n" "$*" >> "${FLY2829_ALERT_LOG}"' > "$BIN/alert-log"
printf '%s\n' '#!/bin/bash' \
  'export FLY2829_WATCHER_INSTANCE="$1-$$"' \
  'export FLYWHEEL_CMUX_PROCESS_INCARNATION_OVERRIDE="fly2829-soak-$1-$$"' \
  'exec /bin/bash "$2" --watch' > "$BIN/watcher-wrapper"
chmod +x "$BIN/cmux" "$BIN/pgrep" "$BIN/lsof" "$BIN/alert-log" "$BIN/watcher-wrapper"

# ── tmux: private server when available, exit-0 stub otherwise ───────────
TMUX_MODE="${FLY2829_SOAK_TMUX:-auto}"
if [[ "$TMUX_MODE" == auto ]]; then command -v tmux >/dev/null 2>&1 && TMUX_MODE=real || TMUX_MODE=stub; fi
if [[ "$TMUX_MODE" == real ]]; then
  REAL_TMUX=$(command -v tmux)
  printf '%s\n' '#!/bin/bash' "exec env -u TMUX '$REAL_TMUX' -S '$TMUX_SOCK' \"\$@\"" > "$BIN/tmux"
  chmod +x "$BIN/tmux"
  "$REAL_TMUX" -S "$TMUX_SOCK" new-session -d -s soak-keepalive -n keep 'sleep 86400' 2>"$OUT/tmux-start.err" \
    || { echo "FLY2829-SOAK $MODE INVALID reason=tmux-start $(head -1 "$OUT/tmux-start.err")"; exit 3; }
else
  printf '%s\n' '#!/bin/bash' 'case "${1:-}" in has-session) exit 1 ;; *) exit 0 ;; esac' > "$BIN/tmux"
  chmod +x "$BIN/tmux"
fi
echo "tmux=$TMUX_MODE"

# ── cmux socket file (stat + -S) ──────────────────────────────────────────
python3 -c '
import socket, sys, time
s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM); s.bind(sys.argv[1]); s.listen(1)
time.sleep(int(sys.argv[2]))
' "$TMP/cmux.sock" $((MINUTES * 60 + 600)) &
SOCKET_PID=$!
for _ in $(seq 1 50); do [[ -S "$TMP/cmux.sock" ]] && break; sleep 0.1; done
[[ -S "$TMP/cmux.sock" ]] || { echo "FLY2829-SOAK $MODE INVALID reason=socket"; exit 3; }

# ── Bridge fixture ────────────────────────────────────────────────────────
TOKEN="fly2829-soak-token"
python3 - "$LIVE_JSON" "$TOKEN" "$TMP/bridge.port" <<'PY' &
import http.server, json, socketserver, sys, urllib.parse
fixture_path, token, port_file = sys.argv[1:4]
live = open(fixture_path).read()
class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        if u.path != "/api/sessions":
            self.send_response(404); self.end_headers(); return
        if self.headers.get("Authorization") != "Bearer " + token:
            self.send_response(401); self.end_headers(); return
        mode = (urllib.parse.parse_qs(u.query).get("mode") or [""])[0]
        if mode == "live": body = live
        elif mode == "recent_terminal": body = '{"count":0,"sessions":[]}'
        else:
            self.send_response(400); self.end_headers(); return
        data = body.encode()
        self.send_response(200); self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data))); self.end_headers(); self.wfile.write(data)
class S(socketserver.TCPServer):
    allow_reuse_address = True
srv = S(("127.0.0.1", 0), H)
open(port_file, "w").write(str(srv.server_address[1]))
srv.serve_forever()
PY
BRIDGE_PID=$!
for _ in $(seq 1 50); do [[ -s "$TMP/bridge.port" ]] && break; sleep 0.1; done
[[ -s "$TMP/bridge.port" ]] || { echo "FLY2829-SOAK $MODE INVALID reason=bridge-fixture"; exit 3; }
BRIDGE_PORT=$(cat "$TMP/bridge.port")
printf 'FLYWHEEL_BRIDGE_URL=http://127.0.0.1:%s\nTEAMLEAD_API_TOKEN=%s\n' "$BRIDGE_PORT" "$TOKEN" > "$TMP/flywheel.env"

# ── watcher environment (every state path lives under $TMP) ───────────────
# Nothing inherited may point the watcher at production: the operator shell
# commonly exports FLYWHEEL_BRIDGE_URL (the real Bridge) and FLYWHEEL_CMUX_*
# overrides. Drop them all, then export the fixture's values explicitly.
for inherited in $(env | sed -n 's/^\(FLYWHEEL_CMUX_[A-Za-z0-9_]*\)=.*/\1/p'); do
  case "$inherited" in
    FLYWHEEL_CMUX_CREATE_*|FLYWHEEL_CMUX_WORKSPACE_CEILING) ;;   # the knobs under test stay
    *) unset "$inherited" ;;
  esac
done
unset FLYWHEEL_BRIDGE_URL TEAMLEAD_PORT TEAMLEAD_API_TOKEN FLYWHEEL_BRIDGE_MARKER TMUX
export FLYWHEEL_BRIDGE_URL="http://127.0.0.1:$BRIDGE_PORT"
export HOME="$HOME_DIR"
export PATH="$BIN:$PATH"
export CMUX_SOCKET_PATH="$TMP/cmux.sock"
export FLYWHEEL_ENV_FILE="$TMP/flywheel.env"
export FLYWHEEL_CMUX_WATCHER_LOCK_DIR="$TMP/watcher.lock"
export FLYWHEEL_CMUX_MAINTENANCE_MARKER="$TMP/cmux-maintenance"
export FLYWHEEL_CMUX_VIEW_WAL_DIR="$TMP/view-wal"
export FLYWHEEL_CMUX_TMUX_GENERATION="fly2829-soak-generation"
export FLYWHEEL_CMUX_SUPERVISED=0
export FLYWHEEL_CMUX_NODE_STATUS_BIN="$SCRIPT_DIR/scripts/flywheel-node-status.sh"
export FLYWHEEL_CMUX_ALERT_BIN="$BIN/alert-log"
export FLY2829_ALERT_LOG="$OUT/alerts.log"; : > "$FLY2829_ALERT_LOG"
export FLY2829_SHIM_STATE="$SHIM_STATE" FLY2829_SHIM_LOG="$CALLS_LOG"
export EVENT_FILE="$TMP/events" CLEANUP_PENDING="$TMP/cleanup-pending" STALE_STATE="$TMP/stale.state"
export HEAL_STATE="$TMP/heal.state" CREATE_STATE="$TMP/create.state" ORPHAN_PIN_STATE="$TMP/orphan-pin.state"
export FLYWHEEL_CMUX_CLOSE_REQUEST_FILE="$TMP/close-requested" CMUX_SOCK_IDENT_FILE="$TMP/sock-ident"
export FLYWHEEL_CMUX_WATCHER_HEARTBEAT="$STATE/cmux-watcher-heartbeat"
[[ -x "$FLYWHEEL_CMUX_NODE_STATUS_BIN" ]] || chmod +x "$FLYWHEEL_CMUX_NODE_STATUS_BIN" 2>/dev/null || true
BURST_MAX="${FLYWHEEL_CMUX_CREATE_BURST_MAX:-20}"; BURST_SECONDS="${FLYWHEEL_CMUX_CREATE_BURST_SECONDS:-60}"
case "$BURST_MAX" in ''|*[!0-9]*) BURST_MAX=20 ;; esac
case "$BURST_SECONDS" in ''|*[!0-9]*) BURST_SECONDS=60 ;; esac

ws_count() { python3 -c 'import json,sys; print(len(json.load(open(sys.argv[1]))["rows"]))' "$SHIM_STATE" 2>/dev/null || echo NA; }
registry_rows() { grep -c . "$STATE/cmux-node-registry" 2>/dev/null || true; }
ledger_rows() { grep -c . "$STATE/cmux-node-create-ledger" 2>/dev/null || true; }
latch_state() { [[ -e "$STATE/cmux-node-runaway" ]] && echo 1 || echo 0; }

INSTANCE=0
TERMS_TOTAL=0; TERMS_OK=0
launch_watcher() {
  INSTANCE=$((INSTANCE + 1))
  "$BIN/watcher-wrapper" "$INSTANCE" "$WATCHER" > "$OUT/watcher-$INSTANCE.log" 2>&1 &
  WATCHER_PID=$!
  echo "launched instance=$INSTANCE pid=$WATCHER_PID"
  local i
  for i in $(seq 1 100); do
    kill -0 "$WATCHER_PID" 2>/dev/null || { INVALID_REASON="watcher-${INSTANCE}-died-at-start"; return 1; }
    [[ -f "$FLYWHEEL_CMUX_WATCHER_LOCK_DIR/owner" ]] && return 0
    sleep 0.1
  done
  kill -0 "$WATCHER_PID" 2>/dev/null || { INVALID_REASON="watcher-${INSTANCE}-died-at-start"; return 1; }
  return 0
}
terminate_watcher() {
  local rc=0 i
  TERMS_TOTAL=$((TERMS_TOTAL + 1))
  kill -TERM "$WATCHER_PID" 2>/dev/null || true
  for i in $(seq 1 300); do kill -0 "$WATCHER_PID" 2>/dev/null || break; sleep 0.1; done
  if kill -0 "$WATCHER_PID" 2>/dev/null; then
    kill -KILL "$WATCHER_PID" 2>/dev/null || true
    wait "$WATCHER_PID" 2>/dev/null || true
    echo "instance=$INSTANCE pid=$WATCHER_PID survived TERM for 30s; killed"
    WATCHER_PID=""
    return 1
  fi
  wait "$WATCHER_PID" 2>/dev/null || rc=$?
  echo "instance=$INSTANCE pid=$WATCHER_PID exited rc=$rc"
  WATCHER_PID=""
  [[ "$rc" == 143 ]] && { TERMS_OK=$((TERMS_OK + 1)); return 0; }
  return 1
}

SAMPLES="$OUT/samples.tsv"
printf 'epoch\telapsed\tworkspaces\tregistry_rows\tledger_rows\tlatch\twatcher_alive\tinstance\n' > "$SAMPLES"
START_WS=$(ws_count)
START_EPOCH=$(date +%s)
END_EPOCH=$((START_EPOCH + MINUTES * 60))
EXPECTED_SAMPLES=$((MINUTES * 60 / SAMPLE_INTERVAL + 1))
SAMPLE_COUNT=0
take_sample() {
  local now alive=0 elapsed
  now=$(date +%s); elapsed=$((now - START_EPOCH))
  [[ -n "$WATCHER_PID" ]] && kill -0 "$WATCHER_PID" 2>/dev/null && alive=1
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$now" "$elapsed" "$(ws_count)" "$(registry_rows)" "$(ledger_rows)" "$(latch_state)" "$alive" "$INSTANCE" >> "$SAMPLES"
  SAMPLE_COUNT=$((SAMPLE_COUNT + 1))
  if [[ "$alive" != 1 && -z "$INVALID_REASON" ]]; then INVALID_REASON="watcher-${INSTANCE}-dead-at-${elapsed}s"; fi
}

launch_watcher || true
take_sample
NEXT_SAMPLE=$((START_EPOCH + SAMPLE_INTERVAL))
NEXT_RESTART=$(( RESTART_EVERY > 0 ? START_EPOCH + RESTART_EVERY : 0 ))
while [[ -z "$INVALID_REASON" ]]; do
  now=$(date +%s)
  (( now >= END_EPOCH )) && break
  if (( NEXT_RESTART > 0 && now >= NEXT_RESTART )); then
    terminate_watcher || true
    launch_watcher || break
    sleep 10
    kill -0 "$WATCHER_PID" 2>/dev/null || { INVALID_REASON="replacement-${INSTANCE}-not-alive-after-10s"; break; }
    NEXT_RESTART=$((NEXT_RESTART + RESTART_EVERY))
  fi
  if (( now >= NEXT_SAMPLE )); then
    take_sample
    NEXT_SAMPLE=$((NEXT_SAMPLE + SAMPLE_INTERVAL))
  fi
  sleep 1
done
# The window's closing sample (t = minutes*60) is taken before the watcher is
# terminated so the expected sample count is reachable.
[[ -n "$INVALID_REASON" ]] || take_sample
FINAL_TERM_OK=1
if [[ -n "$WATCHER_PID" ]]; then terminate_watcher || FINAL_TERM_OK=0; fi
END_WS=$(ws_count)
REGISTRY_END=$(registry_rows)
cp "$SHIM_STATE" "$OUT/cmux-model-final.json" 2>/dev/null || true
cp "$STATE/cmux-node-registry" "$OUT/registry-final" 2>/dev/null || true
cp "$STATE/cmux-node-registry.pre-FLY-2829" "$OUT/registry-backup" 2>/dev/null || true
cp "$STATE/cmux-node-ledger" "$OUT/node-ledger-final" 2>/dev/null || true
cp "$STATE/cmux-node-create-ledger" "$OUT/create-ledger-final" 2>/dev/null || true
echo "samples=$SAMPLE_COUNT expected=$EXPECTED_SAMPLES start_ws=$START_WS end_ws=$END_WS registry=${REGISTRY_START}->${REGISTRY_END} terms_ok=$TERMS_OK/$TERMS_TOTAL"

# ── verdict ───────────────────────────────────────────────────────────────
[[ "$FINAL_TERM_OK" == 1 || -n "$INVALID_REASON" ]] || INVALID_REASON="final-term-rc-not-143"
(( SAMPLE_COUNT >= EXPECTED_SAMPLES - 1 )) || [[ -n "$INVALID_REASON" ]] || INVALID_REASON="samples-${SAMPLE_COUNT}-lt-expected-${EXPECTED_SAMPLES}"

FLY2829_MODE="$MODE" FLY2829_SAMPLES="$SAMPLES" FLY2829_CALLS="$CALLS_LOG" FLY2829_MODEL="$SHIM_STATE" \
FLY2829_NODE_LEDGER="$STATE/cmux-node-ledger" FLY2829_LIVE="$LIVE_COUNT" FLY2829_BURST_MAX="$BURST_MAX" \
FLY2829_BURST_SECONDS="$BURST_SECONDS" FLY2829_START_WS="$START_WS" FLY2829_END_WS="$END_WS" \
FLY2829_REGISTRY_END="$REGISTRY_END" FLY2829_INVALID="$INVALID_REASON" FLY2829_INSTANCES="$INSTANCE" \
FLY2829_TERMS_OK="$TERMS_OK" FLY2829_TERMS_TOTAL="$TERMS_TOTAL" FLY2829_SAMPLE_INTERVAL="$SAMPLE_INTERVAL" \
python3 - <<'PY'
import json, os, sys
E = os.environ
mode = E["FLY2829_MODE"]; invalid = E["FLY2829_INVALID"]
live = int(E["FLY2829_LIVE"]); burst_max = int(E["FLY2829_BURST_MAX"]); burst_s = int(E["FLY2829_BURST_SECONDS"])
start_ws = E["FLY2829_START_WS"]; end_ws = E["FLY2829_END_WS"]; reg_end = int(E["FLY2829_REGISTRY_END"] or 0)
samples = []
with open(E["FLY2829_SAMPLES"]) as f:
    next(f)
    for line in f:
        p = line.rstrip("\n").split("\t")
        if len(p) >= 8 and p[2] != "NA":
            samples.append({"elapsed": int(p[1]), "ws": int(p[2]), "alive": p[6]})
creates = []  # (epoch, instance)
with open(E["FLY2829_CALLS"]) as f:
    for line in f:
        p = line.rstrip("\n").split("|", 3)
        if len(p) == 4 and p[2] == "new-workspace":
            creates.append((int(p[0]), p[1]))
k = len(samples)
def non_increasing(rows):
    return all(b["ws"] <= a["ws"] for a, b in zip(rows, rows[1:]))
verdict = "FAIL"
if mode in ("formal", "smoke"):
    if invalid:
        verdict = "INVALID"
    elif mode == "smoke":
        # Founder A removed node cards. A live fixture may remain in the
        # internal registry, but it must never add a workspace.
        late = [s for s in samples if s["elapsed"] >= 60]
        if k >= 3 and len(late) >= 1 and max(s["ws"] for s in samples) <= int(start_ws) \
           and len(creates) == 0:
            verdict = "PASS"
    else:
        tail = [s for s in samples if s["elapsed"] >= 300]
        early = [s for s in samples if s["elapsed"] < 300]
        climb_ok = all(s["ws"] <= int(start_ws) for s in early)
        if len(tail) >= 2 and non_increasing(tail) and climb_ok and len(creates) == 0 and reg_end <= live + 30:
            verdict = "PASS"
    print("FLY2829-SOAK %s %s start=%s end=%s samples=%d creates=%d%s" % (
        mode, verdict, start_ws, end_ws, k, len(creates), (" reason=" + invalid) if invalid else ""))
elif mode == "negative":
    m = json.load(open(E["FLY2829_MODEL"]))
    receipted = set()
    try:
        for line in open(E["FLY2829_NODE_LEDGER"]):
            p = line.rstrip("\n").split("|")
            if len(p) == 5: receipted.add(p[2])
    except FileNotFoundError:
        pass
    import re
    terminal = node = other = 0
    for r in m["rows"]:
        if re.fullmatch(r"Terminal [0-9]+", r["title"]) and r["ref"] not in receipted: terminal += 1
        elif r["title"].startswith("node:"): node += 1
        else: other += 1
    if invalid: verdict = "INVALID"
    elif terminal >= 20 and node <= live and other == 0: verdict = "PASS"
    print("FLY2829-SOAK negative %s start=%s end=%s terminal=%d node=%d other=%d samples=%d%s" % (
        verdict, start_ws, end_ws, terminal, node, other, k, (" reason=" + invalid) if invalid else ""))
else:
    epochs = sorted(e for e, _ in creates)
    max_burst = 0
    for i, e in enumerate(epochs):
        j = i
        while j < len(epochs) and epochs[j] < e + burst_s: j += 1
        max_burst = max(max_burst, j - i)
    per_instance = {}
    for _, inst in creates: per_instance[inst] = per_instance.get(inst, 0) + 1
    terms_ok = int(E["FLY2829_TERMS_OK"]); terms_total = int(E["FLY2829_TERMS_TOTAL"])
    if invalid or terms_ok != terms_total:
        verdict = "INVALID"
    elif int(E["FLY2829_INSTANCES"]) >= 2 and max_burst == 0 and len(creates) == 0:
        verdict = "PASS"
    print("FLY2829-SOAK restart %s instances=%s creates=%d max_burst=%d/%ds terms_ok=%d/%d%s" % (
        verdict, E["FLY2829_INSTANCES"], len(creates), max_burst, burst_s, terms_ok, terms_total,
        (" reason=" + invalid) if invalid else ""))
sys.exit(0 if verdict == "PASS" else (3 if verdict == "INVALID" else 1))
PY
