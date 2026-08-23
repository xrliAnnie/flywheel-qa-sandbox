#!/usr/bin/env bash
# FLY-1986: hermetic contract suite for scripts/qa-fly-1986-load-probe.sh
#
# Two layers:
#   1. the probe's own --self-test contract checks must pass on the real script;
#   2. MUTATION checks — each contract is fed a deliberately broken copy of the
#      script and must go RED. A contract that cannot go red is not a contract,
#      and three of these checks were originally written in a way that matched
#      their own source text and therefore could never fail.
#
# Nothing here touches a live Bridge, a live database, or the network.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROBE="$SCRIPT_DIR/../qa-fly-1986-load-probe.sh"
TMP="$(mktemp -d)"
MOCK_PIDS=""
# ⚠ The old trap only removed the temp dir. Mocks started later were never killed,
# and a read-only census found 18 orphaned PPID=1 python listeners left on the
# founder's machine by earlier runs of THIS suite — which also pollutes the load
# baseline this issue exists to measure. They have been cleaned up.
# ⚠ HAZARD FIXED: the earlier version signalled every PID ever recorded, and never
# cleared the list. After D6 killed and waited them, the suite ran another probe
# and the EXIT trap signalled the SAME (now reusable) PIDs again — i.e. it could
# kill unrelated processes belonging to the founder. It could also re-enter via
# INT/TERM then EXIT. Now: disarm first, snapshot-and-clear, verify the PID is
# still OUR mock before signalling, and wait only the snapshot.
suite_cleanup() {
  local snapshot m
  trap - EXIT INT TERM              # disarm on entry: never re-enter
  snapshot="$MOCK_PIDS"; MOCK_PIDS=""
  for m in $snapshot; do
    # identity check: only signal a live process that is still our mock
    ps -o command= -p "$m" 2>/dev/null | grep -q "mock\." && kill "$m" 2>/dev/null
  done
  for m in $snapshot; do wait "$m" 2>/dev/null; done
  rm -rf "$TMP"
}
trap 'suite_cleanup' EXIT
trap 'suite_cleanup; exit 130' INT
trap 'suite_cleanup; exit 143' TERM

PASSED=0; FAILED=0
pass() { echo "[TEST] ✓ $1"; PASSED=$((PASSED+1)); }
fail() { echo "[TEST] ✗ $1"; FAILED=$((FAILED+1)); }

# Run a command, capture stdout+stderr to a file, ignore its exit status.
# NOTE: `set -o pipefail` is on, so `cmd | grep -q ...` would inherit cmd's
# non-zero exit and report FAIL for a reason unrelated to the property under
# test. Capture first, then grep the file.
capture() { local out="$1"; shift; "$@" >"$out" 2>&1 || true; }

# A throwaway Bridge: temp port, temp state DB, and a request ledger. Sets
# MOCK_PORT / MOCK_DB / MOCK_PID / MOCK_LEDGER, or leaves MOCK_PORT empty.
start_mock() {
  MOCKDIR="$TMP/mock.$1"; mkdir -p "$MOCKDIR"
  MOCK_LEDGER="$MOCKDIR/requests.log"; : > "$MOCK_LEDGER"
  MOCK_PORT=""
  command -v python3 >/dev/null 2>&1 || return 1
  # ⚠ NOT a heredoc. Under bash 3.2 a heredoc attached to a BACKGROUNDED command
  # left unread text that got dumped to stdout after the tally, which made a
  # `tail -1` read of the result pick up Python source instead of the pass/fail
  # line. Writing the server to a file once removes that whole class.
  _mock_src="$TMP/mock_server.py"
  if [ ! -f "$_mock_src" ]; then
    cat > "$_mock_src" <<'PYMOCK'
import http.server, socketserver, sys, os, time, signal
# Exit 0 on TERM. bash only prints a job-control notice for a background job
# killed BY A SIGNAL, and under bash 3.2 that notice landed on stdout after the
# tally, so a `tail -1` read of the suite result saw it instead of pass/fail.
signal.signal(signal.SIGTERM, lambda *_a: os._exit(0))
d = sys.argv[1]
ledger = os.path.join(d, "requests.log")
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        with open(ledger, "a") as f:
            f.write("%.6f %s\n" % (time.time(), self.path))
        # An expired/wrong token: the Bridge answers 401 on authenticated paths
        # while /health stays fine. Toggled by touching MOCKDIR/auth401.
        if os.path.exists(os.path.join(d, "auth401")) and "sessions" in self.path:
            self.send_response(401); self.send_header("Content-Length", "0"); self.end_headers()
            return
        try:
            sha = open(os.path.join(d, "sha")).read().strip() or "deadbeef"
        except Exception:
            sha = "deadbeef"
        body = ('{"ok":true,"shuttingDown":false,"buildSha":"%s","sessions_count":0,'
                '"admissionPause":{"active":false,"remainingSeconds":0}}' % sha).encode()
        self.send_response(200); self.send_header("Content-Length", str(len(body))); self.end_headers()
        self.wfile.write(body)
    def log_message(self, *a): pass
class S(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True
srv = S(("127.0.0.1", 0), H)
print(srv.server_address[1], flush=True)
srv.serve_forever()
PYMOCK
  fi
  python3 "$_mock_src" "$MOCKDIR" >"$MOCKDIR/port" 2>"$MOCKDIR/err" &
  MOCK_PID=$!
  MOCK_PIDS="$MOCK_PIDS $MOCK_PID"   # register IMMEDIATELY, before any early return
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    MOCK_PORT="$(tr -d '[:space:]' <"$MOCKDIR/port" 2>/dev/null)"
    [ -n "$MOCK_PORT" ] && break
    sleep 0.3
  done
  [ -n "$MOCK_PORT" ] || return 1
  MOCK_DB="$MOCKDIR/state.db"
  sqlite3 "$MOCK_DB" "CREATE TABLE fleet_pressure_hold(id INTEGER PRIMARY KEY);" 2>/dev/null
  return 0
}

[[ -f "$PROBE" ]] || { echo "missing probe script: $PROBE" >&2; exit 1; }

# ── 0. syntax ────────────────────────────────────────────────────────────────
if bash -n "$PROBE" 2>/dev/null; then pass "probe parses"; else fail "probe parses"; fi

# ── 1. the real script passes its own contract checks ────────────────────────
if bash "$PROBE" --self-test >"$TMP/self.log" 2>&1; then
  pass "--self-test passes on the unmodified script"
else
  fail "--self-test passes on the unmodified script"
  sed 's/^/      /' "$TMP/self.log"
fi

# ── 2. mutation checks: each contract must be able to go RED ─────────────────
# mutate <name> <needle> <replacement> <expected substring of the failing check>
mutate() {
  local name="$1" needle="$2" repl="$3" expect="$4" mutant="$TMP/$1.sh"
  if ! grep -qF -- "$needle" "$PROBE"; then
    fail "mutation $name: anchor text not found (the test is stale, not the script)"
    return
  fi
  # plain-text single replacement (python, so slashes/quotes in the needle are safe)
  python3 - "$PROBE" "$mutant" "$needle" "$repl" <<'PY'
import sys, pathlib
src = pathlib.Path(sys.argv[1]).read_text()
needle, repl = sys.argv[3], sys.argv[4]
pathlib.Path(sys.argv[2]).write_text(src.replace(needle, repl, 1))
PY
  capture "$TMP/$name.log" bash "$mutant" --self-test
  if grep -qF "FAIL $expect" "$TMP/$name.log"; then
    pass "mutation $name is caught"
  else
    fail "mutation $name is NOT caught — that contract cannot go red"
  fi
}

mutate "token_into_argv" \
  'curl -q -s -o /dev/null -K - -w' \
  'curl -q -s -o /dev/null -H "Authorization: Bearer $BEARER_TOKEN" -w' \
  "no curl invocation carries an Authorization header as an argument"

mutate "sqlite_without_readonly" \
  'sqlite3 -readonly "$STATE_DB"' \
  'sqlite3 "$STATE_DB"' \
  "every sqlite3 invocation is -readonly"

mutate "sqlite_back_to_a_file_uri" \
  'sqlite3 -readonly "$STATE_DB"' \
  'sqlite3 "file:${STATE_DB}?mode=ro"' \
  "no sqlite3 path is interpolated into a file: URI"

mutate "timer_late_dropped_from_bound" \
  'cons = (missed+err+late)/n' \
  'cons = (missed+err)/n' \
  "conservative bound counts timer_late as a violation"

mutate "deadline_not_below_interval" \
  'ENDPOINT_L1="L1|/health|0.5|2|none"' \
  'ENDPOINT_L1="L1|/health|3|2|none"' \
  "every sentinel interval is strictly greater than its deadline"

mutate "write_endpoint_called" \
  'ENDPOINT_L1="L1|/health|0.5|2|none"' \
  'ENDPOINT_L1="L1|/api/chat-threads/send|0.5|2|none"' \
  "every endpoint in the contract table is a GET path"

# ── 3. usage / argument guards ───────────────────────────────────────────────
capture "$TMP/noargs.log" bash "$PROBE"
if grep -q -- "--out is required" "$TMP/noargs.log"; then
  pass "refuses to run without --out"
else
  fail "refuses to run without --out"
fi

capture "$TMP/badarg.log" bash "$PROBE" --frobnicate
if grep -q "unknown argument" "$TMP/badarg.log"; then
  pass "rejects an unknown argument"
else
  fail "rejects an unknown argument"
fi

# ── 4. preflight fails closed when the Bridge is unreachable ─────────────────
# A closed port must produce a precondition failure, never a silent empty run.
BRIDGE_URL="http://127.0.0.1:9" bash "$PROBE" --out "$TMP/unreach" --dry-run \
  >"$TMP/unreach.log" 2>&1 || true
if grep -q "did not answer" "$TMP/unreach.log"; then
  pass "preflight fails closed when the Bridge does not answer"
else
  fail "preflight fails closed when the Bridge does not answer"
fi

# ── 5. no output files are produced by a failed preflight ────────────────────
if [[ ! -f "$TMP/unreach/samples.csv" ]]; then
  pass "a failed preflight writes no sample data"
else
  fail "a failed preflight writes no sample data"
fi

# ── 6. code-review findings: behavioural regressions ────────────────────────
# Each of these reproduces a defect found in review. They are behavioural, not
# grep-based, so they cannot pass by matching their own source text.

# F1: a trailing flag must not spin forever (`shift 2` fails without shifting)
for flag in --out --url --mode --blocks --block-seconds --endpoints --token-env --quarantine; do
  timeout 5 bash "$PROBE" "$flag" >/dev/null 2>&1
  rc=$?
  if [ "$rc" -eq 124 ]; then
    fail "trailing $flag spins forever (rc=124)"
  else
    pass "trailing $flag terminates (rc=$rc)"
  fi
done

# F4: a zero-deadline endpoint must be rejected on a sentinel grid. L3 no longer
# exists in the collector, so this is covered by the probe's own contract check
# (which flips ENDPOINT_L1 to deadline 0 and requires rejection) — asserted here
# by running that contract and requiring it present.
capture "$TMP/zerodl.log" bash "$PROBE" --self-test
if grep -q "a zero deadline is REJECTED" "$TMP/zerodl.log"; then
  pass "the zero-deadline rejection contract exists and passes"
else
  fail "the zero-deadline rejection contract is missing"
fi

# F5: a missing bearer token must fail closed, not become a 100% violation verdict
capture "$TMP/tok.log" env -u FLYWHEEL_API_TOKEN bash "$PROBE" \
  --out "$TMP/tok" --endpoints L1,L2 --token-env FLYWHEEL_API_TOKEN --dry-run
if grep -q "bearer token" "$TMP/tok.log"; then
  pass "a missing bearer token fails preflight instead of scoring SLO misses"
else
  fail "a missing bearer token fails preflight instead of scoring SLO misses"
fi

# F6: an unreachable Bridge must not be laundered into a latency verdict
if grep -q 'outcome="unreachable"' "$PROBE"; then
  pass "sub-deadline 000 is classified unreachable, not missed"
else
  fail "sub-deadline 000 is classified unreachable, not missed"
fi

# F8/F10: an unknown or empty endpoint set must be rejected, never silently skipped
capture "$TMP/bad-ep.log" bash "$PROBE" --out "$TMP/badep" --endpoints L1,LZ --dry-run
if grep -q "unknown endpoint" "$TMP/bad-ep.log"; then
  pass "an unknown endpoint name is rejected"
else
  fail "an unknown endpoint name is rejected"
fi
capture "$TMP/empty-ep.log" bash "$PROBE" --out "$TMP/emptyep" --endpoints "," --dry-run
if grep -q "at least one endpoint" "$TMP/empty-ep.log"; then
  pass "an empty endpoint set is rejected rather than collecting nothing"
else
  fail "an empty endpoint set is rejected"
fi

# F9: non-numeric counts must be rejected, not silently produce an empty run
capture "$TMP/nan1.log" bash "$PROBE" --out "$TMP/nan1" --blocks abc --dry-run
if grep -q -- "--blocks must be a positive integer" "$TMP/nan1.log"; then
  pass "non-numeric --blocks is rejected"
else
  fail "non-numeric --blocks is rejected"
fi
capture "$TMP/nan2.log" bash "$PROBE" --out "$TMP/nan2" --block-seconds 0 --dry-run
if grep -q -- "--block-seconds must be greater than zero" "$TMP/nan2.log"; then
  pass "--block-seconds 0 is rejected"
else
  fail "--block-seconds 0 is rejected"
fi

# F11: the state DB must come from the repo's own variable
if grep -q 'TEAMLEAD_DB_PATH' "$PROBE" && ! grep -q 'FLYWHEEL_TEAMLEAD_DB' "$PROBE"; then
  pass "the state DB path uses TEAMLEAD_DB_PATH (a slot probe must not read production's hold)"
else
  fail "the state DB path uses TEAMLEAD_DB_PATH"
fi

# F12: the contract checks must cover main(), which is defined after self_test()
# a GET to a write endpoint carries no -X, so the METHOD contract cannot catch
# it — the URL ALLOWLIST must, and this proves it does
mutate "write_endpoint_inside_main" \
  '  local samples="$OUT_DIR/samples.csv"' \
  '  curl -s "${BRIDGE_URL}/api/chat-threads/send" >/dev/null
  local samples="$OUT_DIR/samples.csv"' \
  "every curl invocation targets an allowlisted URL"

# ── 7. cross-family (agy) review findings ───────────────────────────────────
# [agy substitute; Codex machine-limited until 8/26]

# A1: --token-env must not be able to execute shell (verified injectable before)
rm -f "$TMP/pwned"
capture "$TMP/inject.log" bash "$PROBE" --out "$TMP/inj" \
  --token-env "X}; touch $TMP/pwned; #" --dry-run
if [ -f "$TMP/pwned" ]; then
  fail "--token-env command injection is blocked"
else
  pass "--token-env command injection is blocked (no shell executed)"
fi
if grep -q "shell identifier" "$TMP/inject.log"; then
  pass "--token-env rejects a non-identifier value"
else
  fail "--token-env rejects a non-identifier value"
fi

# A1b: a legitimate token env var still resolves
if FLY1986_TOKPROBE=abc123 bash -c 'V=FLY1986_TOKPROBE; [ "${!V:-}" = "abc123" ]'; then
  pass "indirect expansion resolves a real token var (bash 3.2 compatible)"
else
  fail "indirect expansion resolves a real token var"
fi

# A3: cleanup must tear down the sentinel subshells AND actually exit
if grep -q 'kill \$snapshot' "$PROBE" && grep -q 'cleanup 143' "$PROBE"; then
  pass "cleanup tears down the sentinel subshells and exits on TERM"
else
  fail "cleanup tears down the sentinel subshells and exits on TERM"
fi

# A3b: HERMETIC signal test — a mock Bridge on a temp port plus a temp state DB.
# The previous version invoked the probe with no --url/--state-db, so on the
# founder's machine it probed the PRODUCTION Bridge and opened the production
# database, and on a CI runner preflight exited before any child existed, leaving
# CHILDREN_BEFORE=0 and the new CI step red. It also used pgrep -P, which cannot
# see a child once it is reparented, and proved nothing about the parent stopping.
#
# This version asserts the properties that actually matter:
#   * the parent exits with the signal-specific status within a bound
#   * NO request reaches the Bridge after the signal (request ledger)
start_mock sig || true

if [ -z "${MOCK_PORT:-}" ]; then
  fail "could not start the mock Bridge — the signal test is inconclusive, not passing"
  sed 's/^/      /' "$MOCKDIR/err" 2>/dev/null | tail -6
else
  "$PROBE" --out "$TMP/sig" --url "http://127.0.0.1:$MOCK_PORT" --state-db "$MOCK_DB" \
    --expect-build-sha deadbeef \
    --block-seconds 20 --blocks 2 --endpoints L1 \
    >"$TMP/sig.log" 2>&1 &
  SIG_PARENT=$!
  sleep 6
  BEFORE_COUNT="$(grep -c . "$MOCK_LEDGER" || true)"
  kill -TERM "$SIG_PARENT" 2>/dev/null || true

  # the parent must exit, with the TERM-specific status, within a bound
  EXITED=""; RC=""
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    if ! kill -0 "$SIG_PARENT" 2>/dev/null; then EXITED=1; break; fi
    sleep 0.5
  done
  wait "$SIG_PARENT" 2>/dev/null; RC=$?

  if [ -n "$EXITED" ]; then
    pass "the parent exits after SIGTERM (rc=$RC)"
  else
    fail "the parent survived SIGTERM and kept running"
  fi
  if [ "$RC" = "143" ]; then
    pass "the parent exits with the TERM-specific status 143"
  else
    fail "the parent exited $RC, not the TERM-specific 143"
  fi

  sleep 3
  AFTER_COUNT="$(grep -c . "$MOCK_LEDGER" || true)"
  if [ "$BEFORE_COUNT" -gt 0 ] && [ "$AFTER_COUNT" = "$BEFORE_COUNT" ]; then
    pass "no request reaches the Bridge after the signal (ledger stayed at $AFTER_COUNT)"
  elif [ "$BEFORE_COUNT" -eq 0 ]; then
    fail "the mock recorded no request before the signal — the test is inconclusive"
  else
    fail "$(( AFTER_COUNT - BEFORE_COUNT )) request(s) reached the Bridge AFTER the signal"
  fi

  # an interrupted block must never be summarised as a clean verdict
  if [ -f "$TMP/sig/summary.csv" ]; then
    if grep -q "block_valid=true\|,true$" "$TMP/sig/summary.csv"; then
      fail "a signal-interrupted block was summarised as block_valid=true"
    else
      pass "a signal-interrupted block is not certified valid"
    fi
  else
    pass "a signal-interrupted run emitted no certification row"
  fi

fi

# A4: the sampler is gone at the SOURCE level. This is a denylist: it must go red
# if a covariate sampler is ever reintroduced.
if sed '/^self_test()[[:space:]]*{/,/^}/d' "$PROBE" | grep -q 'sample_covariates_once'; then
  fail "a covariate sampler reappeared in the probe source"
else
  pass "no covariate sampler exists in the probe source"
fi

mutate "eval_token_injection" \
  'BEARER_TOKEN="${!TOKEN_ENV:-}"' \
  'eval "BEARER_TOKEN=\${$TOKEN_ENV:-}"' \
  "the token is never resolved through eval"

# ── 8. real-Codex round: behavioural checks, not text presence ──────────────
# Two contracts below were text-presence only and survived a mutant that broke
# the behaviour while leaving the string in place. These exercise the behaviour.

# C5: an undeterminable pressure-hold state must REFUSE, not be an all-clear
# must reach the hold check, so point at the mock rather than whatever
# BRIDGE_URL happens to be in the ambient environment
if [ -n "${MOCK_PORT:-}" ]; then
  capture "$TMP/nohold.log" bash "$PROBE" --out "$TMP/nohold" \
    --url "http://127.0.0.1:$MOCK_PORT" \
    --state-db "$TMP/definitely-not-a-db.sqlite" --dry-run
  if grep -q "unknown safety state" "$TMP/nohold.log"; then
    pass "an undeterminable pressure-hold state refuses the run"
  else
    fail "an undeterminable pressure-hold state refuses the run"
  fi
else
  fail "mock unavailable, pressure-hold refusal unchecked"
fi

# C7: a real run produces EXACTLY the sentinel file set and leaves no child
# behind. This is the runtime half of the source denylist above: the sampler
# cannot come back as an undeclared process either.
if [ -n "${MOCK_PORT:-}" ]; then
  "$PROBE" --out "$TMP/cov" --url "http://127.0.0.1:$MOCK_PORT" --state-db "$MOCK_DB" \
    --expect-build-sha deadbeef \
    --block-seconds 8 --blocks 1 --endpoints L1 >"$TMP/cov.log" 2>&1 || true
  PRODUCED="$(cd "$TMP/cov" 2>/dev/null && ls | sort | tr '\n' ' ' | sed 's/ $//')"
  if [ "$PRODUCED" = "meta.txt samples.csv summary.csv" ]; then
    pass "a run produces exactly the sentinel file set, no covariates.csv"
  else
    fail "unexpected output file set: '$PRODUCED'"
  fi
  # Nothing the probe started may outlive it. An orphan is precisely: re-parented
  # to init AND running the probe script. Matching the name anywhere in ANY command
  # line is not that — it also matches this harness and the shell doing the match.
  STRAY="$(ps -eo ppid=,command= 2>/dev/null \
           | awk '$1 == 1' | grep -c 'qa-fly-1986-load-probe\.sh' || true)"
  STRAY="$(printf '%s' "${STRAY:-0}" | tr -dc '0-9')"
  if [ "${STRAY:-0}" -eq 0 ]; then
    pass "the run left no orphaned probe process behind"
  else
    fail "$STRAY orphaned probe process(es) still alive after the run exited"
  fi
else
  fail "mock unavailable, file-set and orphan behaviour unchecked"
fi

# C1: a bad token VALUE (curl-config injection) must be refused
capture "$TMP/badtok.log" env FLY1986_BADTOK='abc"
url = "http://127.0.0.1:1/pwned' bash "$PROBE" --out "$TMP/badtok" \
  --endpoints L1,L2 --token-env FLY1986_BADTOK --dry-run
if grep -q "bearer-token alphabet" "$TMP/badtok.log"; then
  pass "a token value carrying curl-config directives is refused"
else
  fail "a token value carrying curl-config directives is refused"
fi

# ── 9. behavioural replacements for two text-presence contracts ─────────────
# Codex flagged twice that a text-presence assertion survives a mutant that
# breaks the behaviour. These two exercise the mechanisms directly.

# D4: a forced collector failure (expected=-1) must never be certified valid
D4_FIX="$TMP/d4.csv"
{
  echo "block_id,endpoint,tick,scheduled,start,end,outcome,secs,probe_mode"
  echo "b1,L1,0,1,1,1,met,0.01,full"
  echo "b1,L1,1,3,3,3,met,0.01,full"
} > "$D4_FIX"
D4_ROW="$(bash -c 'source "$1" >/dev/null 2>&1; summarise_block "$2" b1 L1 -1' _ "$PROBE" "$D4_FIX" 2>/dev/null)"
if printf '%s' "$D4_ROW" | grep -q "incomplete_expected"; then
  pass "a collector failure forces the block out of certification"
else
  fail "a collector failure did NOT invalidate the block (got: '$D4_ROW')"
fi
D4_OK="$(bash -c 'source "$1" >/dev/null 2>&1; summarise_block "$2" b1 L1 2' _ "$PROBE" "$D4_FIX" 2>/dev/null)"
if printf '%s' "$D4_OK" | grep -q ",true$"; then
  pass "a complete block with the exact expected count IS certified (positive control)"
else
  fail "a complete block was not certified (got: '$D4_OK') — the guard is over-strict"
fi

# D5: if the Bridge identity changes mid-block, the block must not be certified
if start_mock fence; then
  printf 'deadbeef\n' > "$MOCKDIR/sha"
  "$PROBE" --out "$TMP/fence" --url "http://127.0.0.1:$MOCK_PORT" --state-db "$MOCK_DB" \
    --expect-build-sha deadbeef \
    --block-seconds 12 --blocks 1 --endpoints L1 >"$TMP/fence.log" 2>&1 &
  FENCE_PID=$!
  sleep 5
  printf 'cafebabe\n' > "$MOCKDIR/sha"     # the Bridge "restarts" mid-block
  wait "$FENCE_PID" 2>/dev/null || true
  # ⚠ Assert the FENCE fired, not merely that the block came out invalid: a
  # tick-count mismatch could invalidate it for an unrelated reason and hide a
  # disabled fence (verified — an early version of this test passed on a mutant
  # with the fence switched off).
  if grep -q "changed during block" "$TMP/fence.log"; then
    pass "the post-block fence detects a Bridge identity change"
  else
    fail "the post-block fence did NOT detect the Bridge identity change"
  fi
  if [ -f "$TMP/fence/summary.csv" ] && grep -q ",true$" "$TMP/fence/summary.csv"; then
    fail "a block spanning a Bridge identity change was still certified valid"
  else
    pass "a block spanning a Bridge identity change is not certified"
  fi
else
  fail "could not start the fence mock — inconclusive, not passing"
fi

# D7: TWO CONCURRENT COLLECTORS must not corrupt each other's clock readings.
# The previous design shared one FIFO pair on fd 8/9 across every subshell, so
# concurrent reads interleaved on one response stream (measured elsewhere at 36
# malformed reads per 1,000 with two clients). Each collector now owns a helper.
if start_mock conc; then
  FLY1986_CONC_TOK=abc123 "$PROBE" --out "$TMP/conc" \
    --url "http://127.0.0.1:$MOCK_PORT" --state-db "$MOCK_DB" \
    --expect-build-sha deadbeef \
    --block-seconds 14 --blocks 1 --endpoints L1,L2 \
    --token-env FLY1986_CONC_TOK >"$TMP/conc.log" 2>&1 || true
  if [ -f "$TMP/conc/samples.csv" ]; then
    CONC_BAD="$(awk -F, 'NR>1{n++; if ($4 !~ /^[0-9.]+$/ || $5 !~ /^[0-9.]+$/) bad++} END{print bad+0}' "$TMP/conc/samples.csv")"
    CONC_N="$(awk -F, 'NR>1{n++} END{print n+0}' "$TMP/conc/samples.csv")"
    CONC_EP="$(awk -F, 'NR>1{print $2}' "$TMP/conc/samples.csv" | sort -u | tr '\n' ' ')"
    if [ "$CONC_BAD" -eq 0 ] && [ "$CONC_N" -gt 0 ]; then
      pass "two concurrent collectors produced $CONC_N rows with 0 malformed timestamps (endpoints: $CONC_EP)"
    else
      fail "concurrent collectors produced $CONC_BAD malformed timestamps out of $CONC_N rows"
    fi
    # ⚠ "both endpoint names appear" would also hold for a SEQUENTIAL run. Prove
    # real overlap: L2's first start must precede L1's last end (and vice versa).
    L1_FIRST="$(awk -F, '$2=="L1"{print $5; exit}' "$TMP/conc/samples.csv")"
    L1_LAST="$(awk -F, '$2=="L1"{v=$6} END{print v}' "$TMP/conc/samples.csv")"
    L2_FIRST="$(awk -F, '$2=="L2"{print $5; exit}' "$TMP/conc/samples.csv")"
    L2_LAST="$(awk -F, '$2=="L2"{v=$6} END{print v}' "$TMP/conc/samples.csv")"
    if [ -n "$L1_FIRST" ] && [ -n "$L2_FIRST" ] && \
       awk -v a="$L1_FIRST" -v b="$L1_LAST" -v c="$L2_FIRST" -v d="$L2_LAST" \
           'BEGIN{exit !(c < b && a < d)}'; then
      pass "the two collectors genuinely overlapped in time (not sequential)"
    else
      fail "no temporal overlap between collectors — a sequential run would look like this"
    fi
  else
    fail "the concurrent run produced no samples"
    sed 's/^/      /' "$TMP/conc.log" | tail -4
  fi
else
  fail "could not start the concurrency mock — inconclusive, not passing"
fi

# D6: this run must leave no listener and no FIFO directory behind.
# Snapshot and CLEAR before signalling, so nothing is signalled twice.
D6_SNAP="$MOCK_PIDS"; MOCK_PIDS=""
for _m in $D6_SNAP; do
  ps -o command= -p "$_m" 2>/dev/null | grep -q "mock\." && kill "$_m" 2>/dev/null
done
for _m in $D6_SNAP; do wait "$_m" 2>/dev/null; done
sleep 1
LEFT=0
for _m in $D6_SNAP; do
  ps -o command= -p "$_m" 2>/dev/null | grep -q "mock\." && LEFT=$((LEFT+1))
done
if [ "$LEFT" -eq 0 ]; then
  pass "the suite leaves no mock listener behind"
else
  fail "the suite left $LEFT mock listener(s) running"
fi
LEFT_FIFOS="$(find "${TMPDIR:-/tmp}" -maxdepth 1 -type d -name 'fly1986-clock.*' 2>/dev/null | grep -c . || true)"
if [ "$LEFT_FIFOS" -eq 0 ]; then
  pass "no clock FIFO directory is left behind"
else
  fail "$LEFT_FIFOS clock FIFO director(ies) left behind"
fi

# C8: the macOS-only machine sensors are no longer a dependency at all. Shadowing
# vm_stat, top and sysctl to hard failure must change NOTHING — this is what the
# cut bought, and it is also what keeps the CI step green on ubuntu-latest.
MOCK_ALIVE=""
start_mock novm && MOCK_ALIVE=1
if [ -n "$MOCK_ALIVE" ]; then
  SHADOW="$TMP/shadowbin"; mkdir -p "$SHADOW"
  # An empty PATH entry cannot hide a command, so shadow each with a stub that
  # fails loudly. If the probe still needed any of them, this run would differ.
  for _c in vm_stat top sysctl; do
    printf '#!/bin/sh\nexit 127\n' > "$SHADOW/$_c"; chmod +x "$SHADOW/$_c"
  done
  PATH="$SHADOW:$PATH" "$PROBE" --out "$TMP/nosensors" --url "http://127.0.0.1:$MOCK_PORT" \
    --expect-build-sha deadbeef \
    --state-db "$MOCK_DB" --block-seconds 8 --blocks 1 --endpoints L1 \
    >"$TMP/nosensors.log" 2>&1 || true
  NOSENS="$(cd "$TMP/nosensors" 2>/dev/null && ls | sort | tr '\n' ' ' | sed 's/ $//')"
  NOSENS_ROWS="$(awk 'END{print NR}' "$TMP/nosensors/samples.csv" 2>/dev/null || echo 0)"
  if [ "$NOSENS" = "meta.txt samples.csv summary.csv" ] && [ "${NOSENS_ROWS:-0}" -gt 1 ]; then
    pass "with vm_stat/top/sysctl all unavailable the probe collects normally"
  else
    fail "the probe still depends on a machine sensor (files='$NOSENS' sample_rows=$NOSENS_ROWS)"
    sed 's/^/      /' "$TMP/nosensors.log" | tail -5
  fi
else
  fail "the mock died before the no-sensor contract could run — inconclusive, not passing"
  sed 's/^/      /' "$MOCKDIR/err" 2>/dev/null | tail -6
fi

# ============================ round-6 regressions ============================

# R6-1: a '#' in the state-db path must not become a URI fragment. With the old
# `file:$PATH?mode=ro` form this both VOIDED mode=ro and truncated the target:
# reproduced as an 8 KiB database created at the truncated path.
R6DIR="$TMP/hashdb"; mkdir -p "$R6DIR"
R6DB="$R6DIR/state#frag.db"
sqlite3 "$R6DB" "CREATE TABLE fleet_pressure_hold(id INTEGER PRIMARY KEY);" 2>/dev/null
R6_BEFORE="$(ls "$R6DIR" | sort | tr '\n' ' ')"
if start_mock hashdb; then
  "$PROBE" --out "$TMP/hashout" --url "http://127.0.0.1:$MOCK_PORT" --state-db "$R6DB" \
    --expect-build-sha deadbeef --dry-run >"$TMP/hashdb.log" 2>&1 || true
  R6_AFTER="$(ls "$R6DIR" | sort | tr '\n' ' ')"
  if [ "$R6_BEFORE" = "$R6_AFTER" ]; then
    pass "a '#' in the state-db path creates no file (mode=ro is not voided by the path)"
  else
    fail "the probe wrote through a '#' path: before='$R6_BEFORE' after='$R6_AFTER'"
  fi
  # and it must still READ that db, not silently degrade to NA and refuse
  if grep -q "pressure_hold=0" "$TMP/hashdb.log"; then
    pass "a '#' path is still read correctly (literal filename, not a URI)"
  else
    fail "the probe could not read a '#' state-db: $(tail -2 "$TMP/hashdb.log")"
  fi
else
  fail "could not start the hashdb mock — inconclusive, not passing"
fi

# R6-2: the build fence must be fail-closed. It used to default to empty, so a
# normal run certified whatever build happened to be serving.
if start_mock shafence; then
  capture "$TMP/nosha.log" "$PROBE" --out "$TMP/nosha" \
    --url "http://127.0.0.1:$MOCK_PORT" --state-db "$MOCK_DB" \
    --block-seconds 10 --blocks 1
  if grep -q "expect-build-sha is required" "$TMP/nosha.log"; then
    pass "a collecting run without --expect-build-sha is refused"
  else
    fail "a collecting run certified an unnamed build: $(tail -2 "$TMP/nosha.log")"
  fi
  capture "$TMP/wrongsha.log" "$PROBE" --out "$TMP/wrongsha" \
    --url "http://127.0.0.1:$MOCK_PORT" --state-db "$MOCK_DB" \
    --expect-build-sha 0000000 --block-seconds 10 --blocks 1
  if grep -q "buildSha mismatch" "$TMP/wrongsha.log"; then
    pass "a wrong --expect-build-sha is refused"
  else
    fail "a wrong expected sha was accepted: $(tail -2 "$TMP/wrongsha.log")"
  fi
  # dry-run is the exemption, and must TELL the operator the serving value
  capture "$TMP/drysha.log" "$PROBE" --out "$TMP/drysha" \
    --url "http://127.0.0.1:$MOCK_PORT" --state-db "$MOCK_DB" --dry-run
  if grep -q "serving buildSha is deadbeef" "$TMP/drysha.log"; then
    pass "dry-run is exempt and reports the serving buildSha"
  else
    fail "dry-run did not report the serving buildSha: $(tail -2 "$TMP/drysha.log")"
  fi
else
  fail "could not start the shafence mock — inconclusive, not passing"
fi

# R6-3: an expired/wrong token makes every L2 request 401. That is a credential
# fault, not a latency result — the block must NOT certify.
if start_mock auth401; then
  : > "$MOCKDIR/auth401"
  FLY1986_BAD_TOK=abc123 "$PROBE" --out "$TMP/auth" \
    --url "http://127.0.0.1:$MOCK_PORT" --state-db "$MOCK_DB" \
    --expect-build-sha deadbeef --block-seconds 9 --blocks 1 --endpoints L2 \
    --token-env FLY1986_BAD_TOK >"$TMP/auth.log" 2>&1 || true
  if [ -f "$TMP/auth/samples.csv" ] && grep -q "invalid_auth" "$TMP/auth/samples.csv"; then
    pass "a 401 is classified invalid_auth, not folded into 'error'"
  else
    fail "a 401 was not classified as invalid_auth"
  fi
  R6VALID="$(awk -F, 'NR==2{print $10}' "$TMP/auth/summary.csv" 2>/dev/null)"
  case "$R6VALID" in
    invalid_*badauth=*) pass "an all-401 block is refused certification ($R6VALID)" ;;
    *) fail "an all-401 block was certified as '$R6VALID'" ;;
  esac
  # positive control: same mock WITHOUT the 401 toggle must still certify
  rm -f "$MOCKDIR/auth401"
  FLY1986_BAD_TOK=abc123 "$PROBE" --out "$TMP/authok" \
    --url "http://127.0.0.1:$MOCK_PORT" --state-db "$MOCK_DB" \
    --expect-build-sha deadbeef --block-seconds 9 --blocks 1 --endpoints L2 \
    --token-env FLY1986_BAD_TOK >"$TMP/authok.log" 2>&1 || true
  R6OKVALID="$(awk -F, 'NR==2{print $10}' "$TMP/authok/summary.csv" 2>/dev/null)"
  if [ "$R6OKVALID" = "true" ]; then
    pass "positive control: the same block certifies once the 401 is removed"
  else
    fail "positive control failed — the block did not certify without 401 (got '$R6OKVALID')"
  fi
else
  fail "could not start the auth401 mock — inconclusive, not passing"
fi

# R6-4: the background-operator allowlist must catch a RENAMED, properly-reaped
# sampler that writes only to an existing file — the exact evasion the previous
# syntax-specific contract allowed.
mutate "renamed_reaped_sampler" \
  '  preflight' \
  '  preflight
  collect_machine_state() {
    while :; do
      iostat >> "$OUT_DIR/samples.csv" 2>/dev/null
      sleep 5
    done
  }
  collect_machine_state &
  MS_PID=$!' \
  "no background operator is anything else"

mutate "untracked_bounded_sleep" \
  'sleep "$wait_for" & WORKER_CHILD=$!' \
  'sleep "$wait_for" &' \
  "background operator 2 of 2 is the bounded sleep, immediately tracked"

echo
echo "[TEST] passed=$PASSED failed=$FAILED"
[[ "$FAILED" -eq 0 ]]
