#!/usr/bin/env bash
# FLY-2007 — Phase-0 window wrapper.
#
# WHY THIS EXISTS AT ALL
#   The collector is not allowed to be modified, and it writes nothing before
#   preflight succeeds. So an attempt that dies in preflight leaves no trace, and
#   an attempt that is quietly abandoned leaves no trace either. Since the windows
#   that fail are exactly the ones where the machine was worst, "no trace" is a
#   survivor-bias machine: keep re-running until three good windows survive and
#   every certified result is conditioned on the machine having behaved.
#   So: every attempt is recorded BEFORE anything can fail.
#
# ALLOCATION AUTHORITY
#   The attempt DIRECTORY is the allocation authority - `mkdir` is atomic and
#   fails if it exists. Durable state lives INSIDE it. The top-level JSONL is a
#   rebuildable index, never a second source of truth. An earlier design appended
#   to the ledger and then created the directory: two durable objects, no single
#   rename can commit both, so either order leaves an orphan a crash can make
#   permanent.
#
# RECOVERY
#   Any attempt directory with no TERMINAL state whose lock is not held is closed
#   deterministically as `aborted`/`crash_before_terminal` and STILL COUNTED.
#   Census therefore always converges. (Voided is not vanished - FLY-1986 9-#15.)
#
# READ AUTHORITY (spec-baseline.md 9.1) - each field names its source, and uses
# the collector's own read so both see the same thing:
#   GET /health                 buildSha, bridge_started_at, ok, shuttingDown
#   sqlite3 -readonly <literal> pressure_hold           (NOT a file: URI: a `#`
#                                                        in the path starts a
#                                                        fragment, voiding
#                                                        mode=ro and truncating
#                                                        the target)
#   lsof + ps                   worker identity
#   uptime                      load1
#   plutil -p                   the CURRENT shuttle schedule, read live
# Nothing else. No other network call, no write method, no other database.

set -uo pipefail
SCRIPT_NAME="${0##*/}"

W_BRIDGE_URL="${BRIDGE_URL:-http://localhost:9876}"
W_EVIDENCE_DIR=""
WINDOW=""
FREEZE_COMMIT=""
W_FROZEN_BLOCKS=30
W_BLOCKS=30
W_BLOCK_SECONDS=300
W_ENDPOINTS="L1,L2"
W_TOKEN_ENV="TEAMLEAD_API_TOKEN"
W_STATE_DB="${TEAMLEAD_DB_PATH:-$HOME/.flywheel/teamlead.db}"
W_UPDATER_PLIST="${UPDATER_PLIST:-$HOME/Library/LaunchAgents/com.flywheel.updater.plist}"
W_PROBE="${PROBE:-scripts/qa-fly-1986-load-probe.sh}"
W_RECOVER_ONLY=0
W_DRY_RUN=0

log()  { printf '[%s] %s\n' "$SCRIPT_NAME" "$*" >&2; }
die()  { log "ERROR: $*"; exit 1; }

usage() {
  cat <<USAGE
$SCRIPT_NAME --evidence DIR --window N --freeze-commit SHA [options]

  --evidence DIR       evidence root holding attempt-NNN/ and ledger.jsonl
  --window N           window number this attempt is for (a ledger ATTRIBUTE,
                       never the directory name - re-runs must not reuse a name)
  --freeze-commit SHA  the freeze commit this attempt is bound to
  --blocks N           default 30 (the frozen design; 2.5h per window)
  --block-seconds N    default 300
  --endpoints LIST     default L1,L2
  --token-env NAME     default TEAMLEAD_API_TOKEN
  --recover-only       converge orphaned attempts and exit
  --dry-run            preflight and record, do not call the collector
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --evidence) W_EVIDENCE_DIR="${2:-}"; shift 2 ;;
    --window) WINDOW="${2:-}"; shift 2 ;;
    --freeze-commit) FREEZE_COMMIT="${2:-}"; shift 2 ;;
    --blocks) W_BLOCKS="${2:-}"; shift 2 ;;
    --block-seconds) W_BLOCK_SECONDS="${2:-}"; shift 2 ;;
    --endpoints) W_ENDPOINTS="${2:-}"; shift 2 ;;
    --token-env) W_TOKEN_ENV="${2:-}"; shift 2 ;;
    --recover-only) W_RECOVER_ONLY=1; shift ;;
    --dry-run) W_DRY_RUN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

[ -n "$W_EVIDENCE_DIR" ] || { usage; exit 1; }
mkdir -p "$W_EVIDENCE_DIR" || die "cannot create $W_EVIDENCE_DIR"
LEDGER="$W_EVIDENCE_DIR/ledger.jsonl"
LOCK_DIR="$W_EVIDENCE_DIR/.wrapper.lock"

# ------------------------------------------------------------------- locking --
# mkdir is the portable atomic test-and-set. Two wrappers racing must not both
# think they own attempt-007.
acquire_lock() {
  local waited=0 holder holder_start
  while ! mkdir "$LOCK_DIR" 2>/dev/null; do
    # ⚠ A wrapper that dies holding the lock used to block every later recovery
    # FOREVER: the old loop just retried for 60s and then refused. Break a lock
    # whose holder is provably gone - identified by pid AND start time, because
    # pids are reused.
    holder="$(cut -d' ' -f1 "$LOCK_DIR/pid" 2>/dev/null)"
    holder_start="$(cut -d' ' -f2- "$LOCK_DIR/pid" 2>/dev/null)"
    if [ -n "$holder" ]; then
      local now; now="$(ps -o lstart= -p "$holder" 2>/dev/null | tr -s ' ')"
      if [ -z "$now" ] || [ "$now" != "$holder_start" ]; then
        log "breaking a stale lock held by pid $holder (no longer alive with that start time)"
        rm -rf "$LOCK_DIR" 2>/dev/null || true
        continue
      fi
    fi
    waited=$((waited + 1))
    [ "$waited" -le 60 ] || die "another wrapper has held the lock for 60s and is alive; refusing to race"
    sleep 1
  done
  printf '%s %s\n' "$$" "$(ps -o lstart= -p $$ 2>/dev/null | tr -s ' ')" > "$LOCK_DIR/pid"
}
release_lock() { rm -rf "$LOCK_DIR" 2>/dev/null || true; }

# --------------------------------------------------------- atomic state write --
write_state() {
  local dir="$1" state="$2" body="$3" tmp
  tmp="$dir/.state.$$"
  printf '%s\n' "$body" > "$tmp" || die "cannot write $tmp"
  # flush before the rename so a crash cannot leave a renamed-but-empty file
  if command -v sync >/dev/null 2>&1; then sync; fi
  mv -f "$tmp" "$dir/state.json" || die "cannot commit state for $dir"
  # fence the DIRECTORY too: renaming a durable file into a directory whose entry
  # is not itself durable can lose the name after a crash
  if command -v sync >/dev/null 2>&1; then sync; fi
  log "attempt $(basename "$dir"): state=$state"
}
read_state_field() { sed -n "s/.*\"$2\"[[:space:]]*:[[:space:]]*\"\{0,1\}\([^\",}]*\)\"\{0,1\}.*/\1/p" "$1/state.json" 2>/dev/null | head -1; }
# ⚠ The attempt id comes from the DIRECTORY NAME, which is the allocation
# authority, never from a state file that may not exist yet. Reading it from
# state.json meant a crash landing between `mkdir` and the first state write
# produced `{"attempt_id":,...}` - invalid JSON, written by the very code whose
# job is to converge that crash, and returned with status 0.
attempt_id_of() { local b="${1##*/}"; b="${b#attempt-}"; printf '%s' "$((10#$b))"; }

# An attempt is OWNED while its wrapper is alive. Without this, a second wrapper
# starting while the first is mid-run would "converge" the live attempt as an
# orphan and terminalise a window that is still collecting.
claim_owner() { printf '%s %s\n' "$$" "$(ps -o lstart= -p $$ 2>/dev/null | tr -s ' ')" > "$1/owner"; }
owner_alive() {
  local f="$1/owner" pid started now
  [ -f "$f" ] || return 1
  pid="$(cut -d' ' -f1 "$f" 2>/dev/null)"
  started="$(cut -d' ' -f2- "$f" 2>/dev/null)"
  [ -n "$pid" ] || return 1
  now="$(ps -o lstart= -p "$pid" 2>/dev/null | tr -s ' ')"
  [ -n "$now" ] || return 1
  # pid alone is not identity: pids are reused. Compare the start time too.
  [ "$now" = "$started" ]
}

# ------------------------------------------------------------------ recovery --
# Deterministic, not "the analyser will go red": an unconverged orphan would keep
# eligibility poisoned forever.
converge_orphans() {
  local d st id
  for d in "$W_EVIDENCE_DIR"/attempt-*; do
    [ -d "$d" ] || continue
    st="$(read_state_field "$d" state)"
    [ "$st" = "TERMINAL" ] && continue
    if owner_alive "$d"; then
      log "attempt $(basename "$d") is still owned by a live wrapper; leaving it alone"
      continue
    fi
    id="$(attempt_id_of "$d")"
    log "converging orphan $(basename "$d") (state=${st:-<none before first write>})"
    write_state "$d" TERMINAL "{\"attempt_id\":$id,\"dir\":\"$(basename "$d")\",\"state\":\"TERMINAL\",\"disposition\":\"aborted\",\"reason\":\"crash_before_terminal\"}"
  done
  rebuild_index
}

rebuild_index() {
  local d
  : > "$LEDGER.tmp" || die "cannot write $LEDGER.tmp"
  for d in $(ls -d "$W_EVIDENCE_DIR"/attempt-* 2>/dev/null | sort); do
    if [ ! -f "$d/state.json" ]; then
      # a directory with no state at all is itself a crash record, not a gap
      printf '{"attempt_id":%s,"dir":"%s","state":"TERMINAL","disposition":"aborted","reason":"no_state_written"}\n' \
        "$(attempt_id_of "$d")" "$(basename "$d")" >> "$LEDGER.tmp"
      continue
    fi
    # never copy unparseable state into the index: the index is derived, so a
    # bad row here would look like a data problem instead of a writer problem
    if ! node -e 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))' "$d/state.json" >/dev/null 2>&1; then
      die "attempt $(basename "$d") has unparseable state.json - refusing to build an index over it"
    fi
    tr -d '\n' < "$d/state.json" >> "$LEDGER.tmp"
    printf '\n' >> "$LEDGER.tmp"
  done
  mv -f "$LEDGER.tmp" "$LEDGER" || die "cannot commit $LEDGER"
}

if [ "$W_RECOVER_ONLY" -eq 1 ]; then
  acquire_lock; trap release_lock EXIT
  converge_orphans
  log "recovery complete; index rebuilt at $LEDGER"
  exit 0
fi

# The frozen design fixes these. Allowing them to be overridden meant an attempt
# could silently collect something other than what was pre-registered.
[ "$W_BLOCK_SECONDS" = "300" ] || die "--block-seconds must be 300 (frozen design), got $W_BLOCK_SECONDS"
[ "$W_ENDPOINTS" = "L1,L2" ] || die "--endpoints must be L1,L2 (frozen design), got $W_ENDPOINTS"
[ "$W_BLOCKS" = "$W_FROZEN_BLOCKS" ] || die "--blocks must be $W_FROZEN_BLOCKS (frozen design), got $W_BLOCKS"
[ -n "$WINDOW" ] || die "--window is required"
[ -n "$FREEZE_COMMIT" ] || die "--freeze-commit is required"
# a non-empty string is not a commit. The whole pre-registration rests on being
# able to prove which frozen code produced this attempt.
W_REPO="$(cd "$(dirname "$W_PROBE")/.." && pwd)"
git -C "$W_REPO" cat-file -e "${FREEZE_COMMIT}^{commit}" 2>/dev/null \
  || die "--freeze-commit '$FREEZE_COMMIT' is not a commit in this repository"
# ⚠ "that commit exists" is NOT "the bytes about to run are that commit". Codex R7
# demonstrated the gap by handing a stale-but-real commit to a wrapper running
# newer code and having it accepted. Compare the frozen blobs BEFORE the first
# START record, so a drifted attempt is never even reserved.
for _f in scripts/qa-fly-2007-phase0-analyze.mjs \
          scripts/qa-fly-2007-phase0-simulate.mjs \
          scripts/qa-fly-2007-phase0-run-window.sh \
          engineering/doc/FLY-2007-capacity-stress-execution/spec-baseline.md; do
  _frozen="$(git -C "$W_REPO" rev-parse "${FREEZE_COMMIT}:${_f}" 2>/dev/null)" \
    || die "frozen file $_f does not exist at $FREEZE_COMMIT"
  _now="$(git -C "$W_REPO" hash-object "$W_REPO/$_f" 2>/dev/null)" \
    || die "cannot hash $_f in the working tree"
  [ "$_frozen" = "$_now" ] \
    || die "$_f has drifted from the freeze commit ($_frozen -> $_now) — refusing to collect against unfrozen code"
done
log "freeze check: 4 frozen files match $FREEZE_COMMIT"

# ----------------------------------------------------- 1: reserve (in the lock) --
acquire_lock
trap release_lock EXIT
converge_orphans

NEXT=1
for d in "$W_EVIDENCE_DIR"/attempt-*; do
  [ -d "$d" ] || continue
  n="${d##*attempt-}"; n="${n#0}"; n="${n#0}"
  [ "$n" -ge "$NEXT" ] 2>/dev/null && NEXT=$((n + 1))
done
ATTEMPT_ID="$NEXT"
ATTEMPT_DIR="$W_EVIDENCE_DIR/attempt-$(printf '%03d' "$ATTEMPT_ID")"
mkdir "$ATTEMPT_DIR" 2>/dev/null || die "attempt directory already exists: $ATTEMPT_DIR (directories are never reused)"
claim_owner "$ATTEMPT_DIR"
write_state "$ATTEMPT_DIR" START "{\"attempt_id\":$ATTEMPT_ID,\"dir\":\"$(basename "$ATTEMPT_DIR")\",\"window\":$WINDOW,\"state\":\"START\",\"freeze_commit\":\"$FREEZE_COMMIT\",\"started_at\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}"
rebuild_index
release_lock; trap - EXIT

finish() {
  local disposition="$1" reason="$2" rc="${3:-0}" hashes=""
  # artifact hashes make the terminal record self-describing: a later reader can
  # tell whether the bundle it is holding is the one this attempt produced.
  for f in samples.csv summary.csv meta.txt receipt.json; do
    if [ -f "$ATTEMPT_DIR/$f" ]; then
      hashes="$hashes\"$f\":\"$(shasum -a 256 "$ATTEMPT_DIR/$f" 2>/dev/null | cut -d' ' -f1)\","
    fi
  done
  hashes="${hashes%,}"
  acquire_lock
  write_state "$ATTEMPT_DIR" TERMINAL "{\"attempt_id\":$ATTEMPT_ID,\"dir\":\"$(basename "$ATTEMPT_DIR")\",\"window\":$WINDOW,\"state\":\"TERMINAL\",\"disposition\":\"$disposition\",\"reason\":\"$reason\",\"exit_code\":$rc,\"freeze_commit\":\"$FREEZE_COMMIT\",\"artifacts\":{$hashes}}"
  rm -f "$ATTEMPT_DIR/owner"
  rebuild_index
  release_lock
  exit "$rc"
}
trap 'finish aborted signal 143' TERM
trap 'finish aborted signal 130' INT

# ------------------------------------------------- 2: PREFLIGHT (per-field) ----
# The collector is SOURCED, not re-implemented. spec-baseline.md 9.1 requires
# each field to use "the collector's own read" so both see the same thing, and a
# first draft proved why: it guessed `SELECT value FROM fleet_pressure_hold`
# where the collector uses `SELECT count(*)`, and took the listener pid straight
# from lsof instead of the collector's ambiguity-refusing resolver. Two reads,
# two answers, and the receipt would have certified a different Bridge than the
# one measured.
#
# ⚠ The source happens in a SUBSHELL. Sourcing it directly clobbers this
# wrapper's own variables - the collector assigns BLOCKS, BLOCK_SECONDS,
# ENDPOINTS, TOKEN_ENV and DRY_RUN unconditionally at top level. The first
# version of this file did exactly that, and a live test caught it: --dry-run
# silently became 0 and it ran a real 300-second block with the collector's
# default endpoints instead of stopping at preflight.
read_preflight() {
  BRIDGE_URL="$W_BRIDGE_URL" TEAMLEAD_DB_PATH="$W_STATE_DB" \
  bash -c '
    set -uo pipefail
    # shellcheck source=/dev/null
    . "$1" || exit 3
    h="$(curl -q -s --noproxy "*" --proto "=http,https" --max-time 90 "${BRIDGE_URL}/health" 2>/dev/null || true)"
    [ -n "$h" ] || exit 4
    health_is_serving "$h" || exit 5
    printf "build_sha=%s\n" "$(printf "%s" "$h" | sed -n "s/.*\"buildSha\":\"\([0-9a-f]*\)\".*/\1/p")"
    printf "bridge_started_at=%s\n" "$(printf "%s" "$h" | sed -n "s/.*\"bridge_started_at\":\"\([^\"]*\)\".*/\1/p")"
    printf "pressure_hold=%s\n" "$(read_pressure_hold)"
    # ⚠ NO single quotes in here: this whole block is inside bash -c '...', so a
    # single quote closes the outer string. The first version used grep -q '"ok":true'
    # and the recorded receipt said health_ok=false while the serving gate had
    # just passed - a receipt that contradicted the check it sat next to.
    if printf "%s" "$h" | grep -q "\"ok\":true"; then printf "health_ok=true\n"; else printf "health_ok=false\n"; fi
    if printf "%s" "$h" | grep -q "\"shuttingDown\":false"; then printf "shutting_down=false\n"; else printf "shutting_down=true\n"; fi
    pid="$(resolve_bridge_worker_pid 2>/dev/null || printf unresolved)"
    printf "worker_pid=%s\n" "$pid"
    if [ "$pid" != "unresolved" ]; then printf "worker_identity=%s\n" "$(process_identity "$pid")"; else printf "worker_identity=unresolved\n"; fi
  ' _ "$W_PROBE"
}

PF="$(read_preflight)"; PF_RC=$?
case "$PF_RC" in
  0) ;;
  3) finish aborted cannot_source_collector 1 ;;
  4) finish aborted health_unreachable 1 ;;
  5) finish aborted health_not_serving 1 ;;
  *) finish aborted "preflight_failed_$PF_RC" 1 ;;
esac
pf() { printf '%s\n' "$PF" | sed -n "s/^$1=//p" | head -1; }
BUILD_SHA="$(pf build_sha)"
STARTED_AT="$(pf bridge_started_at)"
PRESSURE_HOLD="$(pf pressure_hold)"
WORKER_PID="$(pf worker_pid)"
WORKER_IDENTITY="$(pf worker_identity)"
HEALTH_OK="$(pf health_ok)"
SHUTTING_DOWN="$(pf shutting_down)"
# spec-baseline.md 9.1 lists ok and shuttingDown as PREFLIGHT fields. The first
# version checked them and then threw them away, so the receipt could not show
# what was actually observed.
[ -n "$STARTED_AT" ] || finish aborted bridge_started_at_missing 1
# The serving gate already passed upstream, so these two MUST agree with it. If
# they do not, the recorder disagrees with the checker and neither can be trusted.
[ "$HEALTH_OK" = "true" ] && [ "$SHUTTING_DOWN" = "false" ] \
  || finish aborted "receipt_contradicts_serving_gate_ok=${HEALTH_OK}_shutting=${SHUTTING_DOWN}" 1
[ -n "$BUILD_SHA" ] || finish aborted health_no_build_sha 1

LOAD1="$(uptime | sed -n 's/.*load averages\{0,1\}: \([0-9.]*\).*/\1/p')"
[ -n "$LOAD1" ] || LOAD1="unknown"
SHUTTLE="unknown"
if command -v plutil >/dev/null 2>&1 && [ -f "$W_UPDATER_PLIST" ]; then
  SHUTTLE="$(plutil -p "$W_UPDATER_PLIST" 2>/dev/null | awk '/"Hour"/{printf "%s ", $3}' | tr -s ' ')"
fi

# FAIL-CLOSED, matching the collector: an unreadable pressure hold is an UNKNOWN
# safety state, not a safe one. FLY-1986's first review round caught exactly this
# ("pressure_hold=NA treated as safe"), and FLY-1142 records it wedging every
# admission for eight hours.
case "$PRESSURE_HOLD" in
  0) ;;
  NA|'') finish aborted pressure_hold_unknown 1 ;;
  *)     finish aborted "pressure_hold_set_$PRESSURE_HOLD" 1 ;;
esac
[ "$WORKER_PID" != "unresolved" ] || finish aborted worker_pid_unresolved 1

cat > "$ATTEMPT_DIR/receipt.json" <<RECEIPT
{
  "attempt_id": $ATTEMPT_ID,
  "window": $WINDOW,
  "freeze_commit": "$FREEZE_COMMIT",
  "preflight": {
    "build_sha": "$BUILD_SHA",
    "bridge_started_at": "$STARTED_AT",
    "bridge_worker_pid": "$WORKER_PID",
    "bridge_identity": "$WORKER_IDENTITY",
    "health_ok": "$HEALTH_OK",
    "shutting_down": "$SHUTTING_DOWN",
    "pressure_hold": "$PRESSURE_HOLD",
    "load1": "$LOAD1",
    "shuttle_hours": "$SHUTTLE",
    "read_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  }
}
RECEIPT
write_state "$ATTEMPT_DIR" PREFLIGHT "{\"attempt_id\":$ATTEMPT_ID,\"dir\":\"$(basename "$ATTEMPT_DIR")\",\"window\":$WINDOW,\"state\":\"PREFLIGHT\",\"freeze_commit\":\"$FREEZE_COMMIT\",\"build_sha\":\"$BUILD_SHA\",\"pressure_hold\":\"$PRESSURE_HOLD\",\"load1\":\"$LOAD1\"}"
acquire_lock; rebuild_index; release_lock

log "preflight: buildSha=$BUILD_SHA started_at=$STARTED_AT worker=$WORKER_PID pressure_hold=$PRESSURE_HOLD load1=$LOAD1 shuttle_hours=$SHUTTLE"

# ⚠ A window that straddles a deploy shuttle will change the Bridge underneath
# it and void the whole attempt (the collector aborts on identity change). The
# shuttle hours were being READ and then ignored; unknown must refuse, not pass.
[ "$SHUTTLE" != "unknown" ] && [ -n "$SHUTTLE" ] || finish aborted shuttle_schedule_unknown 1
WINDOW_SECS=$((W_BLOCKS * W_BLOCK_SECONDS))
NOW_EPOCH="$(date +%s)"
END_EPOCH=$((NOW_EPOCH + WINDOW_SECS))
for hh in $SHUTTLE; do
  # next occurrence of that local hour, today or tomorrow
  today="$(date -j -f '%Y-%m-%d %H:%M:%S' "$(date +%Y-%m-%d) $(printf '%02d' "$hh"):00:00" +%s 2>/dev/null || echo 0)"
  [ "$today" -eq 0 ] && continue
  for cand in "$today" $((today + 86400)); do
    if [ "$cand" -gt "$NOW_EPOCH" ] && [ "$cand" -le "$END_EPOCH" ]; then
      finish aborted "window_would_straddle_shuttle_at_${hh}00" 1
    fi
  done
done
log "shuttle check: window of ${WINDOW_SECS}s does not straddle any of [$SHUTTLE]"

if [ "$W_DRY_RUN" -eq 1 ]; then finish dry_run preflight_only 0; fi

# ------------------------------------------------------ 3: run the collector ---
bash "$W_PROBE" --out "$ATTEMPT_DIR" --endpoints "$W_ENDPOINTS" \
  --block-seconds "$W_BLOCK_SECONDS" --blocks "$W_BLOCKS" \
  --token-env "$W_TOKEN_ENV" --expect-build-sha "$BUILD_SHA"
RC=$?
case "$RC" in
  0) finish completed collector_ok 0 ;;
  2) finish aborted collector_guard_abort 2 ;;
  *) finish aborted "collector_exit_$RC" "$RC" ;;
esac
