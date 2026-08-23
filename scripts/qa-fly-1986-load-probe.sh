#!/usr/bin/env bash
# FLY-1986 — read-only Bridge service probe (Phase 0 collector).
#
# WHAT THIS IS
#   The Phase-0 collector for engineering/doc/FLY-1986-load-stress-knee/plan.md.
#   It measures the plan's verdict quantity `b` = P(latency > SLO deadline) from a
#   fixed monotonic tick grid. Nothing else.
#
# WHAT THIS IS NOT
#   - It applies NO load. There is no stress generator here.
#   - It is read-only: GET endpoints only, and the one SQLite read uses
#     `sqlite3 -readonly` with a LITERAL filename so the engine itself refuses SQL
#     writes. ⚠ Deliberately NOT a `file:...?mode=ro` URI: a `#` anywhere in the
#     path starts a URI fragment, which both voids `mode=ro` and truncates the
#     target — reproduced as an 8 KiB database CREATED at the truncated path.
#     SCOPE: `-readonly` prevents LOGICAL mutation. It does NOT make a WAL database
#     byte-immutable — opening one touches the `-shm` coordination sidecar
#     (verified: main and `-wal` unchanged, `-shm` hash and mtime changed). The
#     guarantee is "no rows written, no logical DB mutation", NOT "not a single
#     byte on disk changes".
#   - No write path (send / mailbox ACK) is implemented.
#
# DELIBERATELY BORING (Lead ruling, 2026-08-23)
#   An earlier version grew A/A cadence alternation, a diagnostic mode, and a
#   persistent FIFO clock helper. Five consecutive review rounds each found a NEW
#   defect in that machinery — descriptors inherited by every subshell, a bearer
#   token resident in a long-lived child, trap ownership fights, PID reuse. None
#   of it was needed for the Phase-0 verdict quantity.
#
#   So A/A and diagnostics are GONE from the collector (they remain in the plan as
#   post-Phase-0 capabilities), and the clock is ONE FORK PER READING. That costs
#   more per tick, and the cost is DECLARED below rather than optimised away: the
#   whole class of defects then does not exist, rather than being fixed.
#
# DECLARED OVERHEAD (measured on this machine, 2026-08-23)
#   One monotonic reading costs a fork: perl p50 20.3 ms, python3 p50 47.3 ms.
#   The grid takes TWO readings per tick (start, end), so at the default 2 s L1
#   tick the probe's own clock cost is about 2.0% of one core with perl (4.7% with
#   python3). This is a fixed, disclosed part of the measurement apparatus and
#   must be carried into the methodology, not hidden.
#
# TOKEN HANDLING
#   The bearer token is read from the env var named by --token-env, captured into a
#   non-exported shell variable and the source var UNSET — both in pure shell and
#   before any external command runs. It never reaches argv, ps, logs or CSV.
#
# EXIT CODES
#   0 ok - 1 usage/precondition failure - 2 guard abort - 130 INT - 143 TERM

set -uo pipefail

# Pure shell: `basename` would be an external command running BEFORE the token is
# cleared, i.e. a child that inherits the secret.
SCRIPT_NAME="${0##*/}"

# ---------------------------------------------------------------- defaults ---
BRIDGE_URL="${BRIDGE_URL:-http://localhost:9876}"
OUT_DIR=""
BLOCK_SECONDS=300
BLOCKS=1
ENDPOINTS="L1"
TOKEN_ENV="FLYWHEEL_API_TOKEN"
DRY_RUN=0
SELF_TEST=""
TIMER_LATE_FRACTION=20   # percent of the grid interval
TIMER_LATE_VOID_PCT=2    # block voided above this percentage
# The repo's StateStore path variable. A different name would make a QA-slot probe
# read PRODUCTION's pressure hold while reporting the slot's latency.
STATE_DB="${TEAMLEAD_DB_PATH:-$HOME/.flywheel/teamlead.db}"
EXPECT_BUILD_SHA="${EXPECT_BUILD_SHA:-}"

BEARER_TOKEN=""
BRIDGE_PID=""
BRIDGE_IDENTITY=""
BUILD_SHA=""
SENTINEL_PIDS=""

# Per-endpoint contract: name|path|deadline_seconds|interval_seconds|auth
# Interval MUST be strictly greater than deadline, or a request cannot be
# cancelled at its deadline and may outlive its own tick.
ENDPOINT_L1="L1|/health|0.5|2|none"
ENDPOINT_L2="L2|/api/sessions|2|3|bearer"

# ⚠ printf, not a `cat` heredoc: `cat` is an EXTERNAL command, and --help and the
# unknown-argument path run before the token is captured and its exported source
# variable unset — so that child would inherit the secret (reproduced by shadowing
# cat with a recorder).
usage() {
  printf '%s\n' \
"$SCRIPT_NAME — FLY-1986 read-only Bridge probe (Phase 0)" \
"" \
"Usage: $SCRIPT_NAME --out DIR [options]" \
"" \
"  --out DIR          output directory (required)" \
"  --url URL          Bridge base URL (LOOPBACK ONLY)" \
"  --block-seconds N  measurement block length (default: 300)" \
"  --blocks N         number of blocks (default: 1)" \
"  --endpoints LIST   comma list of L1,L2 (default: L1)" \
"  --token-env NAME   env var holding the bearer token" \
"  --state-db PATH    StateStore path (default: \$TEAMLEAD_DB_PATH)" \
"  --expect-build-sha S  REQUIRED to collect: the buildSha this run certifies" \
"  --dry-run          validate preconditions only, collect nothing" \
"  --self-test        run the built-in contract checks and exit" \
"  -h | --help        this text" \
"" \
"Applies no load. Writes nothing. Sentinel collection only — A/A calibration and" \
"diagnostic sampling are post-Phase-0 capabilities, not part of this collector."
}

log()  { printf '[%s] %s\n' "$SCRIPT_NAME" "$*" >&2; }
die()  { log "ERROR: $*"; exit 1; }
abort(){ log "ABORT: $*"; exit 2; }

# `shift 2` FAILS (and shifts nothing) when only one argument remains, so a
# trailing flag would loop forever at 100% CPU on the machine we are measuring.
need_value() { [ "$1" -ge 2 ] || die "$2 requires a value"; }
require_pos_int() {
  case "$1" in ''|*[!0-9]*) die "$2 must be a positive integer (got: '$1')" ;; esac
  [ "$1" -gt 0 ] || die "$2 must be greater than zero (got: '$1')"
}

# ------------------------------------------------------------- time source ---
# The grid MUST use a MONOTONIC clock that is SHARED ACROSS PROCESSES.
#   (a) wall clocks (EPOCHREALTIME, time.time, `date +%s`) let an NTP step corrupt
#       the grid — backwards extends the block, forwards turns the rest into a
#       burst of timer_late rows plus real load;
#   (b) `time.monotonic()` is only guaranteed monotonic WITHIN a process. On macOS
#       system Python 3.9 it is PROCESS-RELATIVE: a fresh interpreter returns
#       ~0.008 every time (measured), so a per-call fork would make now() constant
#       and the sleeps grow without bound.
# So a candidate must PROVE it is shared: read it from two separate processes
# across a known sleep and require it to have advanced.
CLOCK_KIND=""

_clock_read_perl()   { perl -MTime::HiRes -e 'printf("%.6f\n", Time::HiRes::clock_gettime(Time::HiRes::CLOCK_MONOTONIC()))' 2>/dev/null; }
_clock_read_python() { "$1" -c 'import time;print("%.6f"%time.monotonic())' 2>/dev/null; }

_clock_is_shared() {
  local reader="$1" arg="${2:-}" a b
  a="$("$reader" "$arg")" || return 1
  sleep 0.25
  b="$("$reader" "$arg")" || return 1
  case "$a" in ''|*[!0-9.]*) return 1 ;; esac
  case "$b" in ''|*[!0-9.]*) return 1 ;; esac
  awk -v a="$a" -v b="$b" 'BEGIN{ exit !((b - a) >= 0.10) }'
}

# perl first: measured 20.3 ms per reading against python3's 47.3 ms, and the grid
# pays this twice per tick.
detect_clock() {
  local py
  if command -v perl >/dev/null 2>&1 && _clock_is_shared _clock_read_perl; then
    CLOCK_KIND="perl"; return 0
  fi
  for py in python3 /usr/local/bin/python3 /opt/homebrew/bin/python3; do
    command -v "$py" >/dev/null 2>&1 || continue
    if _clock_is_shared _clock_read_python "$py"; then
      CLOCK_KIND="python:$py"; return 0
    fi
  done
  log "ERROR: no usable monotonic clock that is shared across processes"
  log "ERROR: (need perl Time::HiRes CLOCK_MONOTONIC, or a python3 whose"
  log "ERROR:  time.monotonic is not process-relative). Refusing to run."
  return 1
}

# ONE FORK PER READING. Deliberately boring: no persistent helper, therefore no
# inherited descriptors, no shared response stream, no long-lived child holding
# the bearer token, and no helper ownership to get wrong. Cost is declared above.
now() {
  local v
  case "$CLOCK_KIND" in
    perl)     v="$(_clock_read_perl)" ;;
    python:*) v="$(_clock_read_python "${CLOCK_KIND#python:}")" ;;
    *)        log "ERROR: clock not initialised"; return 1 ;;
  esac
  case "$v" in ''|*[!0-9.]*) log "ERROR: malformed clock reading: '$v'"; return 1 ;; esac
  printf '%s\n' "$v"
}

# Absolute epoch time, for reporting/correlation only — never for the grid.
wall_now() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# ------------------------------------------------------- endpoint contract ---
endpoint_spec() {
  case "$1" in
    L1) printf '%s\n' "$ENDPOINT_L1" ;;
    L2) printf '%s\n' "$ENDPOINT_L2" ;;
    *) return 1 ;;
  esac
}

validate_endpoint_names() {
  local name bad=0 seen=""
  for name in $(printf '%s' "$1" | tr ',' ' '); do
    endpoint_spec "$name" >/dev/null || { log "ERROR: unknown endpoint '$name' (known: L1 L2)"; bad=1; continue; }
    # ⚠ EVERY occurrence spawns another sentinel worker, so `--endpoints L1,L1,...`
    # would multiply HTTP traffic and clock forks against PRODUCTION without
    # bound — and the expected-tick guard only invalidates the result AFTER that
    # load has already landed. Refuse before starting any child.
    case " $seen " in
      *" $name "*) log "ERROR: endpoint '$name' is listed more than once — each occurrence would start another worker"; bad=1 ;;
      *) seen="$seen $name" ;;
    esac
  done
  [ "$bad" -eq 0 ]
}

# Validates the endpoints ACTUALLY SELECTED. A deadline of 0 would mean
# `curl --max-time 0`, which disables the timeout entirely.
validate_endpoint_grids() {
  local name spec deadline interval bad=0
  for name in $(printf '%s' "$1" | tr ',' ' '); do
    spec="$(endpoint_spec "$name")" || { bad=1; continue; }
    deadline="$(printf '%s\n' "$spec" | cut -d'|' -f3)"
    interval="$(printf '%s\n' "$spec" | cut -d'|' -f4)"
    if awk -v d="$deadline" 'BEGIN{exit !(d<=0)}'; then
      log "ERROR: $name has deadline $deadline — an endpoint with no deadline cannot be used on a sentinel grid"
      bad=1; continue
    fi
    if ! awk -v d="$deadline" -v i="$interval" 'BEGIN{exit !(i>d)}'; then
      log "ERROR: $name interval ($interval) must be strictly greater than deadline ($deadline)"
      bad=1
    fi
  done
  [ "$bad" -eq 0 ]
}

# Fail CLOSED when a selected endpoint needs a bearer token we do not have:
# otherwise every tick returns no-token and the block reports a fully-formed
# 100%-violation "verdict" caused purely by an unset env var.
validate_token_available() {
  local name spec auth needs=0
  for name in $(printf '%s' "$1" | tr ',' ' '); do
    spec="$(endpoint_spec "$name")" || continue
    auth="$(printf '%s\n' "$spec" | cut -d'|' -f5)"
    [ "$auth" = "bearer" ] && needs=1
  done
  if [ "$needs" -ne 1 ]; then BEARER_TOKEN=""; return 0; fi

  [ -n "$BEARER_TOKEN" ] || {
    log "ERROR: a selected endpoint needs a bearer token but \$$TOKEN_ENV was empty — refusing to run"
    return 1
  }
  # The value is interpolated into a `curl -K -` config line. A quote or newline
  # could add `url`/`output` directives, i.e. make curl fetch another URL or
  # truncate a chosen file. Restrict it to the bearer-token alphabet.
  case "$BEARER_TOKEN" in
    *[!A-Za-z0-9._~+/=-]*)
      log "ERROR: \$$TOKEN_ENV contains characters outside the bearer-token alphabet — refusing to use it"
      BEARER_TOKEN=""; return 1 ;;
  esac
  return 0
}

# ------------------------------------------------------------- bridge pid -----
# ⚠ The host matters, not just the port. Discarding it meant
# `--url http://remote-host:9876` measured the REMOTE host while attributing the
# process identity to the LOCAL listener on 9876 — and with L2 it would have sent
# the production bearer token off-box.
target_host() {
  local url="$1" hostport
  hostport="${url#*://}"; hostport="${hostport%%/*}"
  # A bracketed IPv6 authority ([::1]:9876) must not be truncated at the first
  # colon — doing so returned "[" and made the advertised [::1] form unusable.
  case "$hostport" in
    \[*\]*) printf '%s\n' "${hostport%%\]*}]" ;;
    *) printf '%s\n' "${hostport%%:*}" ;;
  esac
}

# The probe correlates HTTP latency with the identity, CPU and memory of a LOCAL
# process, so a non-loopback target is incoherent by construction as well as a
# secret-egress risk. Refuse it.
validate_loopback_url() {
  local url="$1" host
  case "$url" in
    http://*|https://*) ;;
    *) log "ERROR: --url must be http(s) (got: '$url')"; return 1 ;;
  esac
  case "${url#*://}" in
    *@*) log "ERROR: --url must not contain userinfo"; return 1 ;;
  esac
  host="$(target_host "$url")"
  case "$host" in
    localhost|127.0.0.1|[::1]|'[::1]') return 0 ;;
    *) log "ERROR: --url must be loopback (localhost / 127.0.0.1 / [::1]) — got '$host'. This probe resolves the Bridge worker PID from the LOCAL listener and fences the run to that process identity, and an off-box URL would also send a bearer token off-box."; return 1 ;;
  esac
}

target_port() {
  local url="$1" hostport
  hostport="${url#*://}"; hostport="${hostport%%/*}"
  case "$hostport" in
    \[*\]:*) printf '%s\n' "${hostport##*:}" ;;
    \[*\]) case "$url" in https://*) printf '443\n' ;; *) printf '80\n' ;; esac ;;
    *:*) printf '%s\n' "${hostport##*:}" ;;
    *) case "$url" in https://*) printf '443\n' ;; *) printf '80\n' ;; esac ;;
  esac
}

# AUTHORITATIVE: the process LISTENING on the port we probe is, by definition, the
# Bridge whose latency we measure. `pgrep -f run-bridge` is NOT the selector — it
# matches any process whose argv merely contains the string (verified with a decoy
# that sorted first), and it cannot tell production from a QA slot; the port can.
resolve_bridge_worker_pid() {
  local port listeners count selected
  port="$(target_port "$BRIDGE_URL")"
  command -v lsof >/dev/null 2>&1 || { log "ERROR: lsof is required to identify the Bridge on port $port"; return 1; }
  listeners="$(lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null | sort -u)"
  count="$(printf '%s\n' "$listeners" | grep -c '[0-9]' || true)"
  if [ -z "$listeners" ] || [ "$count" -eq 0 ]; then
    log "ERROR: nothing is listening on port $port"; return 1
  fi
  if [ "$count" -gt 1 ]; then
    log "ERROR: $count processes listen on port $port — ambiguous, refusing to guess"; return 1
  fi
  selected="$(printf '%s\n' "$listeners" | head -1)"
  if ! pgrep -f 'run-bridge' 2>/dev/null | grep -qx "$selected"; then
    log "WARNING: pid $selected serves port $port but does not match 'run-bridge'"
  fi
  printf '%s\n' "$selected"
}

process_identity() { ps -o lstart=,command= -p "$1" 2>/dev/null | tr -s ' ' | head -1; }

# ------------------------------------------------------------- curl helper ---
# Auth goes through a stdin config so the token never reaches argv or ps output.
curl_timed() {
  local url="$1" max_time="$2" auth="$3"
  if [ "$auth" = "bearer" ]; then
    [ -n "$BEARER_TOKEN" ] || { printf 'NOTOKEN 0\n'; return 0; }
    printf 'header = "Authorization: Bearer %s"\n' "$BEARER_TOKEN" | \
      curl -q -s -o /dev/null -K - -w '%{http_code} %{time_total}\n' \
        --noproxy '*' --proto '=http,https' \
        --no-keepalive --max-time "$max_time" "$url" 2>/dev/null \
      || printf '000 %s\n' "$max_time"
  else
    curl -q -s -o /dev/null -w '%{http_code} %{time_total}\n' \
      --noproxy '*' --proto '=http,https' \
      --no-keepalive --max-time "$max_time" "$url" 2>/dev/null \
      || printf '000 %s\n' "$max_time"
  fi
}

# ---------------------------------------------------------------- health -----
# ONE predicate, used by preflight AND the post-block fence.
# A MISSING shuttingDown field means the Bridge cannot report draining state at
# all — an unknown, which a fail-closed predicate must refuse. Requiring an
# explicit false is deliberate.
health_is_serving() {
  case "$1" in *'"ok":true'*) ;; *) return 1 ;; esac
  case "$1" in *'"shuttingDown":false'*) ;; *) return 1 ;; esac
  return 0
}

# ⚠ NOT a `file:...?mode=ro` URI. Interpolating a path into a URI is unsafe: a `#`
# in the path starts a URI FRAGMENT, so `?mode=ro` lands inside the fragment and is
# never applied, and the path is truncated at the `#`. Reproduced — the combination
# CREATED an 8 KiB database at the truncated path through what read as a read-only
# open. `-readonly` takes a literal filename, so no character in it can change the
# open mode or the target. (Verified it still refuses writes: "attempt to write a
# readonly database".)
read_pressure_hold() {
  [ -f "$STATE_DB" ] || { printf 'NA\n'; return 0; }
  command -v sqlite3 >/dev/null 2>&1 || { printf 'NA\n'; return 0; }
  sqlite3 -readonly "$STATE_DB" "SELECT count(*) FROM fleet_pressure_hold;" 2>/dev/null || printf 'NA\n'
}


# ------------------------------------------------------- sentinel collector ---
# One endpoint, one monotonic grid, in-flight budget of exactly 1: the loop is
# serial and each request is cancelled at its deadline, so it cannot span the next
# scheduled tick.
run_sentinel_endpoint() {
  local name="$1" block_id="$2" duration="$3" out="$4"
  # ⚠ Killing the worker SHELL does not kill whatever bounded command it is
  # currently blocked in (sleep, curl, perl). Those are all bounded — curl by
  # --max-time, sleep by the interval, perl returns immediately — but "bounded"
  # is not "gone", so take the current child down explicitly on a signal.
  WORKER_CHILD=""
  trap 'if [ -n "$WORKER_CHILD" ]; then kill "$WORKER_CHILD" 2>/dev/null; fi; exit 143' TERM
  trap 'if [ -n "$WORKER_CHILD" ]; then kill "$WORKER_CHILD" 2>/dev/null; fi; exit 130' INT
  local spec path deadline interval auth url
  spec="$(endpoint_spec "$name")" || return 1
  path="$(printf '%s\n' "$spec" | cut -d'|' -f2)"
  deadline="$(printf '%s\n' "$spec" | cut -d'|' -f3)"
  interval="$(printf '%s\n' "$spec" | cut -d'|' -f4)"
  auth="$(printf '%s\n' "$spec" | cut -d'|' -f5)"
  url="${BRIDGE_URL}${path}"

  local base tick=0 scheduled start end code secs outcome late_limit last wait_for
  base="$(now)" || { log "ERROR: could not read the clock at block start ($name)"; return 1; }
  late_limit="$(awk -v i="$interval" -v f="$TIMER_LATE_FRACTION" 'BEGIN{printf "%.6f", i*f/100}')"
  last="$base"

  while :; do
    scheduled="$(awk -v b="$base" -v t="$tick" -v i="$interval" 'BEGIN{printf "%.6f", b+t*i}')"
    awk -v s="$scheduled" -v b="$base" -v d="$duration" 'BEGIN{exit !((s-b)<d)}' || break

    # TWO clock readings per tick (start, end). The wait is computed from the
    # previous tick's end, so we do not pay a third fork.
    wait_for="$(awk -v s="$scheduled" -v n="$last" 'BEGIN{d=s-n; if(d<0)d=0; printf "%.3f", d}')"
    if awk -v w="$wait_for" 'BEGIN{exit !(w>0)}'; then
      sleep "$wait_for" & WORKER_CHILD=$!
      wait "$WORKER_CHILD" 2>/dev/null
      WORKER_CHILD=""
    fi

    start="$(now)" || { log "ERROR: clock failed mid-block ($name)"; return 1; }
    # timer_late = the scheduler itself slipped. Host load causes it, so this is
    # informative missingness: recorded, never silently dropped.
    if awk -v s="$start" -v sc="$scheduled" -v l="$late_limit" 'BEGIN{exit !((s-sc)>l)}'; then
      outcome="timer_late"; code="NA"; secs="NA"
    else
      read -r code secs <<CURL_EOF
$(curl_timed "$url" "$deadline" "$auth")
CURL_EOF
      if [ "$code" = "200" ]; then
        outcome="met"
      elif [ "$code" = "NOTOKEN" ]; then
        outcome="no_token"
      elif [ "$code" = "000" ]; then
        # Connection refused, DNS failure and TLS error all return 000 too. Only a
        # 000 that consumed the deadline is a latency miss; one that returned well
        # under it means the Bridge was UNREACHABLE (e.g. it died mid-block),
        # which must not be laundered into a latency verdict.
        if awk -v t="${secs:-0}" -v d="$deadline" 'BEGIN{exit !(t >= d*0.8)}'; then
          outcome="missed"
        else
          outcome="unreachable"
        fi
      elif [ "$code" = "401" ] || [ "$code" = "403" ]; then
        # An expired or wrong token makes EVERY authenticated request fail. Folding
        # that into `error` produced a certified block whose number described the
        # credential, not the service. It is a configuration fault, like no_token.
        outcome="invalid_auth"
      else
        outcome="error"
      fi
    fi
    end="$(now)" || { log "ERROR: clock failed mid-block ($name)"; return 1; }
    last="$end"
    printf '%s,%s,%s,%s,%s,%s,%s,%s\n' \
      "$block_id" "$name" "$tick" "$scheduled" "$start" "$end" "$outcome" "${secs:-NA}" >> "$out" \
      || { log "ERROR: could not append a sample row ($name) — aborting this collector"; return 1; }
    tick=$((tick + 1))
  done
}

# How many ticks a block is SUPPOSED to deliver. Used to reject short blocks.
expected_ticks() {
  local name="$1" duration="$2" spec interval
  spec="$(endpoint_spec "$name")" || { printf '0\n'; return 0; }
  interval="$(printf '%s\n' "$spec" | cut -d'|' -f4)"
  awk -v d="$duration" -v i="$interval" 'BEGIN{ n=0; while (n*i < d) n++; print n }'
}

# --------------------------------------------------------------- summarise ---
# Two bounds, deliberately:
#   conservative — timer_late counted as a violation. This is the certification
#                  number, because scheduler lateness is caused by the very load
#                  under study; dropping those ticks would preferentially remove
#                  the harmful observations.
#   best_case    — timer_late excluded. Descriptive only.
summarise_block() {
  local csv="$1" block_id="$2" endpoint="$3" expected="${4:-0}"
  awk -F, -v b="$block_id" -v e="$endpoint" -v voidpct="$TIMER_LATE_VOID_PCT" -v expected="$expected" '
    $1==b && $2==e {
      n++
      if ($7=="met") met++
      else if ($7=="missed") missed++
      else if ($7=="error") err++
      else if ($7=="timer_late") late++
      else if ($7=="no_token") notok++
      else if ($7=="unreachable") unreach++
      else if ($7=="invalid_auth") badauth++
    }
    END{
      if (n==0) { print b","e",0,0,0,0,0,NA,NA,unknown"; exit }
      # expected<0 is an explicit "this block is void" signal from the caller:
      # a collector failed, or the Bridge identity changed mid-block.
      if (expected<0 || (expected>0 && n!=expected)) {
        printf "%s,%s,%d,%d,%d,%d,%d,NA,NA,incomplete_expected=%d\n", b,e,n,met,missed,err,late,expected
        exit
      }
      # a missing OR REJECTED token is a configuration fault and an unreachable
      # Bridge an availability fault; none of them is a latency result
      if (notok>0 || unreach>0 || badauth>0) {
        printf "%s,%s,%d,%d,%d,%d,%d,NA,NA,invalid_notoken=%d_unreachable=%d_badauth=%d\n", b,e,n,met,missed,err,late,notok,unreach,badauth
        exit
      }
      cons = (missed+err+late)/n
      denom = n-late
      best = (denom>0) ? (missed+err)/denom : 0
      latepct = 100*late/n
      valid = (latepct > voidpct) ? "false" : "true"
      printf "%s,%s,%d,%d,%d,%d,%d,%.4f,%.4f,%s\n", b,e,n,met,missed,err,late,cons,best,valid
    }' "$csv"
}

# ------------------------------------------------------------ preconditions ---
preflight() {
  local missing="" t
  for t in curl awk ps; do command -v "$t" >/dev/null 2>&1 || missing="$missing $t"; done
  [ -z "$missing" ] || die "missing required tools:$missing"

  validate_loopback_url "$BRIDGE_URL" || die "refusing a non-loopback target"
  validate_endpoint_names "$ENDPOINTS" || die "unknown endpoint name"
  validate_endpoint_grids "$ENDPOINTS" || die "endpoint grid contract violated"
  validate_token_available "$ENDPOINTS" || die "bearer token unavailable for a selected endpoint"

  local health
  health="$(curl -q -s --noproxy '*' --proto '=http,https' --max-time 90 "${BRIDGE_URL}/health" 2>/dev/null || true)"
  [ -n "$health" ] || die "Bridge did not answer ${BRIDGE_URL}/health"
  health_is_serving "$health" || die "/health is not serving (needs ok:true and an explicit shuttingDown:false) — refusing to measure"

  BUILD_SHA="$(printf '%s' "$health" | sed -n 's/.*"buildSha":"\([0-9a-f]*\)".*/\1/p')"
  [ -n "$BUILD_SHA" ] || die "/health carries no buildSha — cannot record which build was measured"
  # ⚠ Fail-closed. This used to be optional with an empty default, which made it a
  # criterion satisfied by DOING NOTHING: a normal invocation certified whatever
  # build happened to be serving. A block is only meaningful against a NAMED
  # deployment, so a collecting run must say which one it expects. --dry-run is
  # exempt precisely because it is how an operator discovers the serving value.
  if [ -z "$EXPECT_BUILD_SHA" ]; then
    if [ "$DRY_RUN" -eq 1 ]; then
      log "dry-run: serving buildSha is $BUILD_SHA — pass --expect-build-sha $BUILD_SHA to collect against it"
    else
      die "--expect-build-sha is required for a collecting run (serving buildSha is $BUILD_SHA) — refusing to certify an unnamed build"
    fi
  elif [ "$BUILD_SHA" != "$EXPECT_BUILD_SHA" ]; then
    die "buildSha mismatch: serving $BUILD_SHA, expected $EXPECT_BUILD_SHA"
  fi

  BRIDGE_PID="$(resolve_bridge_worker_pid)" || die "could not resolve the Bridge worker pid"
  BRIDGE_IDENTITY="$(process_identity "$BRIDGE_PID")"
  [ -n "$BRIDGE_IDENTITY" ] || die "could not read identity for pid $BRIDGE_PID"

  # NA means "could not determine". Accepting it would turn an unknown safety
  # state into an implicit all-clear.
  local hold; hold="$(read_pressure_hold)"
  case "$hold" in
    0) ;;
    NA) die "cannot determine fleet_pressure_hold (state db: $STATE_DB) — unknown safety state, refusing to run" ;;
    *) die "fleet_pressure_hold is set ($hold) — the machine is already in an alert state" ;;
  esac

  log "bridge worker pid=$BRIDGE_PID  buildSha=$BUILD_SHA  clock=$CLOCK_KIND  pressure_hold=$hold"
}

# ---------------------------------------------------------------- self test ---
self_test() {
  local fails=0
  t_assert() { if eval "$2"; then echo "  ok   $1"; else echo "  FAIL $1"; fails=$((fails+1)); fi; }

  echo "FLY-1986 probe contract checks"

  # Exclude ONLY this function's body. An earlier version truncated the source at
  # self_test(), leaving every contract blind to main(), defined after it.
  code_only()   { sed '/^self_test()[[:space:]]*{/,/^}/d' "$0"; }
  # `set -o pipefail` is on: `code_only | grep -q X` lets grep exit at the first
  # match, SIGPIPEs sed, and the pipeline reports failure even though the pattern
  # was found. `grep -c` consumes all input.
  code_has()    { [ "$(code_only | grep -cE "$1")" -gt 0 ]; }
  # Every `&` used as a BACKGROUND operator, in any position on the line. Excludes
  # `&&` and redirections like `2>&1`.
  bg_ops()      { code_only | grep -E '(^|[^&>])&([[:space:]]|$)' | grep -vE '&&'; }
  # real sqlite3 invocations: not comments, not the `command -v` availability probe
  sqlite_calls() { code_only | grep -E '(^|[^-[:alnum:]_])sqlite3 ' \
                     | grep -vE '^[[:space:]]*#' | grep -vE 'command -v sqlite3'; }
  code_lacks()  { [ "$(code_only | grep -cE "$1")" -eq 0 ]; }
  code_joined() { code_only | awk '{ if (sub(/\\$/,"")) { printf "%s ", $0 } else { print } }'; }
  curl_lines()  { code_joined | grep -vE '^[[:space:]]*(#|log )' | grep -E '(^|[^_[:alnum:]])curl -'; }
  main_body()   { code_only | awk '/^main\(\) \{/,/^}/'; }
  cleanup_body(){ code_only | awk '/^  cleanup\(\) \{/,/^  }/'; }

  # ---- scope: the cut machinery must be GONE (Lead ruling 2026-08-23) ----
  t_assert "A/A cadence alternation is not in the collector" \
    'code_lacks "SPARSE_FACTOR" && code_lacks "probe_mode"'
  t_assert "diagnostic mode is not in the collector" \
    'code_lacks "run_diagnostic_block" && code_lacks "diagnostic_not_a_verdict"'
  t_assert "no persistent clock helper (no inherited fds, no resident child)" \
    'code_lacks "start_clock_helper" && code_lacks "mkfifo"'
  t_assert "no --mode flag remains to select removed modes" 'code_lacks "[-][-]mode\)"'
  t_assert "the declared per-fork clock cost is recorded in the header" \
    'code_has "perl p50 20.3 ms"'

  # ---- endpoint grid ----------------------------------------------------
  t_assert "every sentinel interval is strictly greater than its deadline" \
    'validate_endpoint_grids "L1,L2"'
  local saved="$ENDPOINT_L1"
  ENDPOINT_L1="L1|/health|3|2|none"
  t_assert "a deadline >= interval is REJECTED (negative control)" '! validate_endpoint_grids "L1"'
  ENDPOINT_L1="L1|/health|0|2|none"
  t_assert "a zero deadline is REJECTED (curl --max-time 0 disables the timeout)" \
    '! validate_endpoint_grids "L1"'
  ENDPOINT_L1="$saved"
  t_assert "an unknown endpoint name is rejected" '! validate_endpoint_names "L1,LZ"'

  # ---- clock ------------------------------------------------------------
  t_assert "the clock reader quotes its program argument (no word-splitting)" \
    'code_has "_clock_read_python.. [{] .[$]1. -c"'
  t_assert "a process-relative clock is rejected by an advance test, no uptime assumption" \
    'code_has "\(b - a\) >= 0.10" && code_lacks "a > 1000"'
  t_assert "main aborts when no usable clock is found" 'code_has "no usable monotonic clock"'
  t_assert "the clock actually reads and advances across separate processes" \
    'detect_clock && _a=$(now) && sleep 0.3 && _b=$(now) && awk -v a="$_a" -v b="$_b" "BEGIN{exit !(b>a)}"'

  # ---- health predicate (behavioural) -----------------------------------
  t_assert "health predicate accepts a serving Bridge" \
    'health_is_serving "{\"ok\":true,\"shuttingDown\":false}"'
  t_assert "health predicate rejects a draining Bridge" \
    '! health_is_serving "{\"ok\":true,\"shuttingDown\":true}"'
  t_assert "health predicate rejects ok:false" \
    '! health_is_serving "{\"ok\":false,\"shuttingDown\":false}"'
  t_assert "health predicate rejects a MISSING shuttingDown (unknown = refuse)" \
    '! health_is_serving "{\"ok\":true}"'
  t_assert "health predicate rejects malformed input" '! health_is_serving "not json"'

  # ---- summarise (behavioural) ------------------------------------------
  local tmp; tmp="$(mktemp)"
  {
    echo "b1,L1,0,1,1,1,met,0.01"
    echo "b1,L1,1,3,3,3,met,0.01"
    echo "b1,L1,2,5,5,5,timer_late,NA"
    echo "b1,L1,3,7,7,7,missed,NA"
  } > "$tmp"
  local row; row="$(summarise_block "$tmp" b1 L1 4)"
  t_assert "conservative bound counts timer_late as a violation (2/4=0.5)" \
    '[ "$(printf "%s" "$row" | cut -d, -f8)" = "0.5000" ]'
  t_assert "best-case bound excludes timer_late (1/3=0.3333)" \
    '[ "$(printf "%s" "$row" | cut -d, -f9)" = "0.3333" ]'
  t_assert "a block with 25% timer_late is marked invalid" \
    '[ "$(printf "%s" "$row" | cut -d, -f10)" = "false" ]'
  t_assert "a short block is rejected by the expected-tick guard" \
    'printf "%s" "$(summarise_block "$tmp" b1 L1 9)" | grep -q incomplete_expected'
  t_assert "expected<0 forces the block out of certification" \
    'printf "%s" "$(summarise_block "$tmp" b1 L1 -1)" | grep -q incomplete_expected'
  t_assert "expected_ticks matches the grid (300s at 2s = 150)" \
    '[ "$(expected_ticks L1 300)" = "150" ]'
  rm -f "$tmp"

  # ---- secrets ----------------------------------------------------------
  t_assert "no curl invocation carries an Authorization header as an argument" \
    'code_lacks "^[^#]*curl.*Authorization"'
  t_assert "bearer auth is fed through a stdin config (-K -)" 'code_has "[-]K [-]"'
  t_assert "the token is never resolved through eval" 'code_lacks "^[^#]*eval[^#]*TOKEN_ENV"'
  t_assert "the token uses indirect expansion" 'code_has "BEARER_TOKEN=.*!TOKEN_ENV"'
  t_assert "--token-env is validated as a shell identifier" 'code_has "must be a shell identifier"'
  t_assert "the token VALUE is restricted to the bearer-token alphabet" 'code_has "bearer-token alphabet"'
  t_assert "main clears the token env var before running any external command" \
    '[ "$(main_body | grep -n "unset ..TOKEN_ENV" | head -1 | cut -d: -f1)" -lt "$(main_body | grep -n "detect_clock" | head -1 | cut -d: -f1)" ]'
  t_assert "SCRIPT_NAME is pure shell (no basename fork before sanitisation)" \
    'code_has "SCRIPT_NAME=..[{]0##[*]/[}]" && code_lacks "^[^#]*basename"'

  # ---- round-4 (post-cut) findings --------------------------------------
  t_assert "a non-loopback URL is refused" '! validate_loopback_url "http://example.test:9876"'
  t_assert "a URL with userinfo is refused" '! validate_loopback_url "http://u:p@127.0.0.1:9876"'
  t_assert "a non-http scheme is refused" '! validate_loopback_url "ftp://127.0.0.1:9876"'
  t_assert "loopback URLs are accepted" \
    'validate_loopback_url "http://localhost:9876" && validate_loopback_url "http://127.0.0.1:9911"'
  t_assert "the host is parsed, not discarded" '[ "$(target_host http://127.0.0.1:9876)" = "127.0.0.1" ]'
  t_assert "every curl ignores ambient config and proxies (-q, --noproxy, --proto)" \
    '[ "$(curl_lines | grep -c .)" = "$(curl_lines | grep -c -- "-q .*--noproxy")" ]'
  t_assert "the sample append is checked" \
    'code_has "could not append a sample row" && code_has "aborting this collector"'
  t_assert "the run refuses to reuse a dirty output directory" \
    'code_has "from a previous run"'
  t_assert "a worker takes its bounded foreground child down on a signal" \
    'code_has "WORKER_CHILD"'

  # ---- round-5 (convergence) findings ------------------------------------
  t_assert "duplicate endpoints are rejected before any worker starts" \
    '! validate_endpoint_names "L1,L1"'
  t_assert "a legitimate two-endpoint list is still accepted" 'validate_endpoint_names "L1,L2"'
  t_assert "bracketed IPv6 authority is parsed, not truncated at the first colon" \
    '[ "$(target_host "http://[::1]:9876")" = "[::1]" ] && [ "$(target_port "http://[::1]:9876")" = "9876" ]'
  t_assert "the advertised [::1] loopback form is actually usable" \
    'validate_loopback_url "http://[::1]:9876"'
  t_assert "a non-loopback IPv6 host is refused" '! validate_loopback_url "http://[2001:db8::1]:9876"'

  # ---- read-only --------------------------------------------------------
  # ⚠ Must match INVOCATIONS only: counting every line containing "sqlite3 " also
  # counted this file's own comments and the `command -v sqlite3` probe.
  t_assert "every sqlite3 invocation is -readonly" \
    '[ -z "$(sqlite_calls | grep -v -- "-readonly")" ]'
  t_assert "there is at least one sqlite3 invocation to constrain (not vacuous)" \
    '[ "$(sqlite_calls | grep -c .)" -ge 1 ]'
  t_assert "no sqlite3 path is interpolated into a file: URI (a '#' voids mode=ro)" \
    'code_lacks "sqlite3 .file:"'
  t_assert "no curl in code selects a non-GET method" \
    '[ -z "$(curl_lines | grep -E "( -X | --request | --data| -d | --form | -T | --upload-file )")" ]'
  t_assert "every endpoint in the contract table is a GET path" \
    '[ -z "$(code_only | grep -E "^ENDPOINT_L[0-9]=" | grep -vE "\|/(health|api/sessions)")" ]'
  t_assert "every curl invocation targets an allowlisted URL" \
    '[ -z "$(curl_lines | grep -vE "([\$]url|[\$]\{BRIDGE_URL\}/health)")" ]'

  # ---- subject fencing --------------------------------------------------
  t_assert "the measured pid comes from the listening socket on the probed port" \
    'code_has "lsof -nP -iTCP:.*-sTCP:LISTEN -t"'
  t_assert "pgrep is never the selector for the measured pid" 'code_lacks "selected=.*pgrep"'
  t_assert "the port is never taken by naive URL suffix stripping" 'code_lacks "BRIDGE_URL##[*]:"'
  t_assert "the subject is re-verified after collection, before certifying" \
    'code_has "ident_after" && code_has "sha_after"'
  t_assert "an unknown pressure-hold state is a refusal, not an all-clear" \
    'code_has "unknown safety state"'
  t_assert "port parsing handles an explicit port" '[ "$(target_port http://localhost:9876)" = "9876" ]'
  t_assert "port parsing distinguishes a QA slot port" '[ "$(target_port http://127.0.0.1:9911)" = "9911" ]'

  # ---- lifecycle --------------------------------------------------------
  t_assert "cleanup exits — a trap that only kills lets the parent resume the loop" \
    '[ "$(cleanup_body | grep -c "exit ")" -ge 1 ]'
  t_assert "INT and TERM route to cleanup with signal-specific exit codes" \
    'code_has "cleanup 130" && code_has "cleanup 143"'
  t_assert "cleanup disarms its own trap (idempotent, cannot re-enter)" \
    'code_has "trap - EXIT INT TERM"'
  t_assert "cleanup snapshots and clears the pid set before signalling" \
    'code_has "snapshot=..SENTINEL_PIDS"'
  t_assert "collector failure is not swallowed" 'code_has "COLLECTOR_FAILED=1"'
  t_assert "a reaped collector pid is removed from the live set" 'code_has "grep -vx"'

  # ---- no sampler at all (Lead ruling, 2026-08-23) -----------------------
  # These are DENYLIST contracts: they must go red if a sampler ever grows back.
  t_assert "no covariate sampler exists" 'code_lacks "sample_covariates_once"'
  t_assert "no background sampling loop exists" 'code_lacks "while :; do.*sleep"'
  # ⚠ EXACT ALLOWLIST, not a count of one shape. The previous version matched only
  # a line ENDING in ") &", which (a) missed the mid-line `sleep ... & WORKER_CHILD=`
  # entirely and (b) would not have seen a bare `collect_machine_state &`. Every
  # background operator must be enumerated here by name, so ANY new one is red.
  t_assert "the collector has exactly two background operators" \
    '[ "$(bg_ops | grep -c .)" = "2" ]'
  t_assert "background operator 1 of 2 is the sentinel worker spawn" \
    '[ "$(bg_ops | grep -c run_sentinel_endpoint)" = "1" ]'
  t_assert "background operator 2 of 2 is the bounded sleep, immediately tracked" \
    '[ "$(bg_ops | grep -cE "sleep .* & WORKER_CHILD=\\\$!")" = "1" ]'
  t_assert "no background operator is anything else" \
    '[ "$(bg_ops | grep -vE "run_sentinel_endpoint|sleep .* & WORKER_CHILD=" | grep -c .)" = "0" ]'
  t_assert "no covariate CSV is produced" 'code_lacks "covariates.csv"'
  t_assert "the machine sensors the sampler used are no longer invoked" \
    'code_lacks "vm_stat" && code_lacks "top -l" && code_lacks "sysctl -n vm.loadavg"'
  t_assert "meta records where the comparison data actually comes from" \
    'code_has "FLY-1995"'

  echo
  if [ "$fails" -eq 0 ]; then echo "all contract checks passed"; return 0; fi
  echo "$fails check(s) failed"; return 1
}

# --------------------------------------------------------------------- main ---
main() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --out) need_value $# "--out"; OUT_DIR="$2"; shift 2 ;;
      --url) need_value $# "--url"; BRIDGE_URL="$2"; shift 2 ;;
      --block-seconds) need_value $# "--block-seconds"; BLOCK_SECONDS="$2"; shift 2 ;;
      --blocks) need_value $# "--blocks"; BLOCKS="$2"; shift 2 ;;
      --endpoints) need_value $# "--endpoints"; ENDPOINTS="$2"; shift 2 ;;
      --state-db) need_value $# "--state-db"; STATE_DB="$2"; shift 2 ;;
      --expect-build-sha) need_value $# "--expect-build-sha"; EXPECT_BUILD_SHA="$2"; shift 2 ;;
      --token-env)
        need_value $# "--token-env"
        # This used to be interpolated into an eval, so a crafted value executed
        # arbitrary shell (verified). Reject anything that is not an identifier.
        case "$2" in
          ''|*[!A-Za-z0-9_]*|[0-9]*) die "--token-env must be a shell identifier (got: '$2')" ;;
        esac
        TOKEN_ENV="$2"; shift 2 ;;
      --dry-run) DRY_RUN=1; shift ;;
      --self-test) SELF_TEST=1; shift ;;
      -h|--help) usage; exit 0 ;;
      *) usage; die "unknown argument: $1" ;;
    esac
  done

  # Capture the token and clear the source env var IMMEDIATELY, in pure shell,
  # before ANY external command runs — including on the --self-test path, which
  # used to run clock detection first and hand the ambient token to a child.
  BEARER_TOKEN="${!TOKEN_ENV:-}"
  unset "$TOKEN_ENV" 2>/dev/null || true

  if [ -n "$SELF_TEST" ]; then self_test; exit $?; fi

  [ -n "$OUT_DIR" ] || { usage; die "--out is required"; }
  require_pos_int "$BLOCKS" "--blocks"
  require_pos_int "$BLOCK_SECONDS" "--block-seconds"
  [ -n "$(printf '%s' "$ENDPOINTS" | tr -d ' ,')" ] || die "--endpoints must name at least one endpoint"

  detect_clock || die "no usable monotonic clock — refusing to run"

  # The trap must exist before anything is started, so a failed preflight or a
  # dry-run cannot leave a child behind.
  cleanup() {
    local rc="${1:-0}" snapshot
    trap - EXIT INT TERM          # idempotent: never re-enter
    snapshot="$SENTINEL_PIDS"; SENTINEL_PIDS=""
    # shellcheck disable=SC2086
    [ -n "$snapshot" ] && { kill $snapshot 2>/dev/null; wait $snapshot 2>/dev/null; }
    exit "$rc"
  }
  trap 'cleanup 130' INT
  trap 'cleanup 143' TERM
  trap 'cleanup $?' EXIT

  mkdir -p "$OUT_DIR" || die "cannot create $OUT_DIR"
  # ⚠ Refuse to write into a directory that already holds a previous run: a failed
  # truncation would otherwise leave OLD rows with the exact expected count, which
  # summarise_block would certify as current data.
  for _f in samples.csv summary.csv meta.txt; do
    [ -e "$OUT_DIR/$_f" ] && die "$OUT_DIR already contains $_f from a previous run — refusing to overwrite or mix results"
  done
  preflight

  if [ "$DRY_RUN" -eq 1 ]; then
    log "dry-run: blocks=$BLOCKS block_seconds=$BLOCK_SECONDS endpoints=$ENDPOINTS"
    log "dry-run: no samples collected, nothing written"
    exit 0
  fi

  local samples="$OUT_DIR/samples.csv"
  local summary="$OUT_DIR/summary.csv"
  local meta="$OUT_DIR/meta.txt"

  # ⚠ Every write is checked. An unchecked append let a collector report success
  # after its write had failed (reproduced against a closed descriptor).
  echo "block_id,endpoint,tick,scheduled,start,end,outcome,secs" > "$samples" || die "cannot write $samples"
  echo "block_id,endpoint,n,met,missed,error,timer_late,violation_upper_conservative,violation_best_case,block_valid" > "$summary" || die "cannot write $summary"
  {
    echo "url=$BRIDGE_URL"
    echo "blocks=$BLOCKS block_seconds=$BLOCK_SECONDS endpoints=$ENDPOINTS"
    echo "clock=$CLOCK_KIND (shared monotonic, one fork per reading)"
    echo "clock_overhead=2 readings/tick; measured p50 per reading: perl 20.3ms, python3 47.3ms"
    echo "bridge_worker_pid=$BRIDGE_PID"
    echo "bridge_identity=$BRIDGE_IDENTITY"
    echo "build_sha=$BUILD_SHA"
    echo "started_at=$(wall_now)"
    echo "note: the conservative bound counts timer_late as a violation"
    echo "covariates: NOT sampled here — comparison data comes from the Bridge's own instrumentation (FLY-1995) and the machine-watermark sensor; see plan.md §Methodology"
  } > "$meta" || die "cannot write $meta"

  local i=1
  while [ "$i" -le "$BLOCKS" ]; do
    local block_id="b$i" name pids="" COLLECTOR_FAILED="" exp_ticks _p
    local ident_now; ident_now="$(process_identity "$BRIDGE_PID")"
    if [ "$ident_now" != "$BRIDGE_IDENTITY" ]; then
      abort "Bridge worker identity changed before block $block_id — this run's data is not comparable"
    fi

    log "block $block_id: sentinel ${BLOCK_SECONDS}s endpoints=$ENDPOINTS"
    for name in $(printf '%s' "$ENDPOINTS" | tr ',' ' '); do
      ( trap - EXIT
        run_sentinel_endpoint "$name" "$block_id" "$BLOCK_SECONDS" "$samples" ) &
      pids="$pids $!"
      SENTINEL_PIDS="$SENTINEL_PIDS $!"
    done
    [ -n "$(printf '%s' "$pids" | tr -d ' ')" ] || die "no sentinel endpoint was started"
    for _p in $pids; do
      wait "$_p" 2>/dev/null || COLLECTOR_FAILED=1
      # Remove it from the live set the moment it is reaped: leaving reaped PIDs
      # there means a later INT/TERM could signal a RECYCLED pid.
      SENTINEL_PIDS="$(printf '%s' "$SENTINEL_PIDS" | tr ' ' '\n' | grep -vx "$_p" | tr '\n' ' ')"
    done

    # Identity used to be checked only BEFORE a block, so a restart during it
    # could mix two Bridge instances and still produce a valid summary.
    local ident_after health_after sha_after pid_after
    ident_after="$(process_identity "$BRIDGE_PID")"
    health_after="$(curl -q -s --noproxy '*' --proto '=http,https' --max-time 90 "${BRIDGE_URL}/health" 2>/dev/null || true)"
    sha_after="$(printf '%s' "$health_after" | sed -n 's/.*"buildSha":"\([0-9a-f]*\)".*/\1/p')"
    pid_after="$(resolve_bridge_worker_pid 2>/dev/null || true)"
    if [ "$ident_after" != "$BRIDGE_IDENTITY" ] || [ "$pid_after" != "$BRIDGE_PID" ] || [ "$sha_after" != "$BUILD_SHA" ]; then
      log "WARNING: the Bridge under test changed during block $block_id — this block cannot be certified"
      COLLECTOR_FAILED=1
    fi
    if ! health_is_serving "$health_after"; then
      log "WARNING: the Bridge stopped serving during block $block_id — this block cannot be certified"
      COLLECTOR_FAILED=1
    fi

    for name in $(printf '%s' "$ENDPOINTS" | tr ',' ' '); do
      exp_ticks="$(expected_ticks "$name" "$BLOCK_SECONDS")"
      [ -n "$COLLECTOR_FAILED" ] && exp_ticks=-1
      summarise_block "$samples" "$block_id" "$name" "$exp_ticks" >> "$summary" \
        || die "cannot append to $summary"
    done
    i=$((i + 1))
  done

  log "done: $OUT_DIR"
  log "reminder: the conservative column is the certification number; blocks with block_valid=false are NOT certified safe and must cap the threshold below their achieved load"
}

# Standard "not sourced" guard — lets a test source this file and call a single
# function directly, instead of re-implementing the expected output in the test.
# No new env var, so nothing to register with the flag census.
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  main "$@"
fi
