#!/usr/bin/env bash
# FLY-1929 — IPC-voucher watcher: kernel-panic recurrence + remediation health.
#
# WHAT ALREADY EXISTS (this file must never duplicate it)
#   The REMEDIATION is already in production and is not ours: the root
#   LaunchDaemon com.annie.voucher-guard runs /usr/local/sbin/voucher-guard.sh
#   every 60s and restarts ecosystemanalyticsd once bank_task passes 200000.
#   Verified 2026-08-20 in /var/log/voucher-guard.log — three firings
#   (51143->1056, 201218->1375, 204349->1154), roughly hourly.
#
#   The DELIVERY DURABILITY is already in production too: lead-alert.sh owns a
#   permanent receipt table (alert_deliveries), a spill queue, dead-lettering
#   and a drain. An earlier draft of this file rebuilt all of that on top of it
#   — its own outbox, episode sequences, generation ids, lock and state schema —
#   and half the review blockers grew inside that duplicated layer. So:
#
#     THIS SCRIPT KEEPS NO CROSS-TICK STATE.
#     The alert signature IS the state; lead-alert.sh's claims.db dedupes it.
#
#   That single decision removes the lock, the schema validation, the outbox and
#   the resumable parser, along with the failure modes each of them had.
#
# WHAT IT DOES, once a minute, bounded:
#   1. bank_task high-water   — the remediation is installed but not acting
#   2. remediation missing    — the daemon itself is gone
#   3. new voucher panic report — the recurrence the issue asks us to catch
#   4. appends raw telemetry, so the NEXT incident has a "before" baseline.
#      The 2026-08-20 panic had none, which is why "what changed" is unanswerable.
#
# WHY THE METRIC IS bank_task
#   Deliberately the SAME metric the root guard trips on, so an alert means
#   exactly "the remediation should already have acted and did not". Thresholds
#   sit well above its 200000 trigger, so a healthy hourly cycle (peaks ~204k)
#   never pages. Using bank_task+bank_account would page every single cycle:
#   at high occupancy bank_account is nearly EQUAL to bank_task, so that sum
#   sits near 407k on every healthy peak. That arithmetic is the difference
#   between a watcher and an alert storm.
#
# WHY PEAK, NOT RATE
#   xnu ipc_voucher.c: allocation takes from ivac_freelist and grows ONLY when
#   that list is empty; ivace_release returns entries to the freelist. Historical
#   table size consumes no present headroom — the panic condition is a max-sized
#   table with an empty freelist, i.e. LIVE concurrent occupancy.
#
# Injection uses VOUCHER_WATCH_* — not FLYWHEEL_* (which the flag registry
# governs) and not VOUCHER_GUARD_* (which belongs to the root daemon above).
set -uo pipefail

IVAC_ENTRIES_MAX=524288          # xnu osfmk/ipc/ipc_voucher.h
GUARD_TRIGGER=200000             # the root guard's own bank_task threshold
WARN_THRESHOLD=260000            # comfortably above it: it clearly did not act
SEVERE_THRESHOLD=350000          # deep into the danger band
PANIC_PREFIX_BYTES=262144        # panicString lives at the top of the report
MAX_REPORTS=20
ALERT_TIMEOUT_SECONDS=15
META_TIMEOUT_SECONDS=10      # meta-alert is best-effort but must never hang the tick
SEND_COOLDOWN_SECONDS=3600   # bounds the claims-db-outage fail-open amplification
ALERT_KIND="host_voucher_incident"
PANIC_MARKER='Cannot grow ipc space beyond IVAC_ENTRIES_MAX'

# This unit is installed as a USER LaunchAgent (~/Library/LaunchAgents, see
# scripts/lib/converge-nonlead-daemons.sh), so launchd supplies HOME. But `set -u`
# would turn an absent HOME into an opaque "unbound variable" death before the first
# sample, which is undiagnosable from the outside — so say it plainly instead.
if [ -z "${VOUCHER_WATCH_LOG:-}" ] && [ -z "${HOME:-}" ]; then
  printf '[voucher-watch] FATAL: HOME is unset and VOUCHER_WATCH_LOG was not given.\n' >&2
  printf '[voucher-watch] This unit expects the user LaunchAgent domain. If it is ever\n' >&2
  printf '[voucher-watch] moved to a system LaunchDaemon, pass explicit paths instead.\n' >&2
  exit 1
fi
LOG_PATH="${VOUCHER_WATCH_LOG:-$HOME/Library/Logs/flywheel/voucher-watch.ndjson}"
ZPRINT_BIN="${VOUCHER_WATCH_ZPRINT:-zprint}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
MATCHER="${VOUCHER_WATCH_MATCHER:-$SCRIPT_DIR/lib/voucher-panic-match.py}"
ALERT_BIN="${VOUCHER_WATCH_ALERT_BIN:-$SCRIPT_DIR/lead-alert.sh}"
META_ALERT_BIN="${VOUCHER_WATCH_META_ALERT_BIN:-$SCRIPT_DIR/meta-alert.sh}"
PANIC_DIR="${VOUCHER_WATCH_PANIC_DIR:-/Library/Logs/DiagnosticReports}"
SEED_BASENAME="${VOUCHER_WATCH_SEED_BASENAME:-panic-full-2026-08-20-070924.0002.panic}"
PROJECT_NAME="${VOUCHER_WATCH_PROJECT:-flywheel}"
GUARD_LABEL="${VOUCHER_WATCH_GUARD_LABEL:-com.annie.voucher-guard}"
GUARD_PLIST="${VOUCHER_WATCH_GUARD_PLIST:-/Library/LaunchDaemons/com.annie.voucher-guard.plist}"

umask 077
log() { printf '[voucher-watch] %s\n' "$*" >&2; }
die() { log "FATAL: $*"; exit 1; }
now_epoch() { printf '%s' "${VOUCHER_WATCH_NOW:-$(date +%s)}"; }
today() { printf '%s' "${VOUCHER_WATCH_DAY:-$(date -u +%Y%m%d)}"; }

# Bounded child without relying on timeout(1), which macOS does not ship.
run_bounded() {
  local limit="$1"; shift
  local out rc pid waited
  out="$(mktemp "${TMPDIR:-/tmp}/vw.XXXXXX")" || return 1
  "$@" > "$out" 2>/dev/null &
  pid=$!
  waited=0
  while kill -0 "$pid" 2>/dev/null; do
    if [ "$waited" -ge "$limit" ]; then
      kill -TERM "$pid" 2>/dev/null; sleep 1; kill -KILL "$pid" 2>/dev/null
      wait "$pid" 2>/dev/null
      cat "$out"; rm -f "$out"; return 124
    fi
    sleep 1; waited=$((waited + 1))
  done
  wait "$pid" 2>/dev/null; rc=$?
  cat "$out"; rm -f "$out"
  return "$rc"
}

# A missing row or a non-numeric value FAILS LOUD. Treating either as 0 would
# mean the alarm never fires — the worst possible failure for a watcher.
zone_inuse() {
  local zone="$1" value
  value="$(printf '%s\n' "$ZPRINT_OUTPUT" | awk -v z="$zone" '$1==z {print $7; found=1} END{if(!found) print "__MISSING__"}')"
  case "$value" in
    __MISSING__|'') return 1 ;;
    *[!0-9]*)       return 1 ;;
  esac
  printf '%s' "$value"
}

# Either face counts as present: launchd is the runtime authority, the plist is
# the deployable artifact. Requiring both would page during a reinstall.
guard_present() {
  if launchctl print "system/$GUARD_LABEL" >/dev/null 2>&1; then printf 1; return 0; fi
  if [ -f "$GUARD_PLIST" ]; then printf 1; return 0; fi
  printf 0
}

# Interpret the strict-delivery stdout line AND the exit code together: the exit
# code alone conflates cases (queued_transient exits 2 but IS durably queued).
# Retry/dedup/dead-lettering all belong to lead-alert.sh; we only report.
# LOCAL SEND COOLDOWN — deliberately NOT a delivery record.
#
# De-duplication belongs to lead-alert.sh's claims.db. But when that DB is
# unusable it FAILS OPEN to a direct POST, so a per-minute producer like this one
# would post the same alert every 60s for the whole outage. This bounds that.
#
# Safety direction matters: losing this stamp can only cause an EXTRA send, never
# a missed one. That is why it is a stamp and not state we have to keep correct.
_cooldown_stamp_path() {
  local dir key
  dir="${VOUCHER_WATCH_COOLDOWN_DIR:-${TMPDIR:-/tmp}/flywheel-voucher-watch-cooldown}"
  [ -L "$dir" ] && return 1
  mkdir -p "$dir" 2>/dev/null || return 1
  # HASH, not character substitution. Squashing punctuation to "_" makes
  # distinct signatures collide onto one filename, so one alert's cooldown would
  # silence a DIFFERENT alert — a suppression bug is exactly what this must not
  # introduce. Fall back to the sanitized form only if no hasher exists, since a
  # coarse stamp still beats no bound at all.
  key="$(printf '%s' "$1" | shasum -a 256 2>/dev/null | awk '{print $1}')"
  [ -n "$key" ] || key="$(printf '%s' "$1" | tr -c 'a-zA-Z0-9._-' '_')"
  printf '%s/%s' "$dir" "$key"
}

# CHECK ONLY. The stamp is written after a CONFIRMED send (see send_alert):
# stamping before delivery would let one failed attempt suppress the retry for a
# whole hour, turning a transient failure into a silently withheld alert.
cooldown_ok() {
  local stamp last age
  stamp="$(_cooldown_stamp_path "$1")" || return 0
  [ -L "$stamp" ] && return 0
  [ -f "$stamp" ] || return 0
  last="$(cat "$stamp" 2>/dev/null || echo '')"
  # An unreadable or corrupt stamp must NEVER suppress: the safe direction is an
  # extra send, never a missed one.
  case "$last" in ''|*[!0-9]*) return 0 ;; esac
  age=$(( $(now_epoch) - last ))
  [ "$age" -lt 0 ] && return 0
  [ "$age" -lt "$SEND_COOLDOWN_SECONDS" ] && return 1
  return 0
}

cooldown_stamp() {
  local stamp
  stamp="$(_cooldown_stamp_path "$1")" || return 0
  # Refuse to write through a symlink or a non-regular path; and every failure
  # here is swallowed, because a cooldown problem must never abort the tick that
  # is doing the actual sampling.
  [ -L "$stamp" ] && return 0
  if [ -e "$stamp" ] && [ ! -f "$stamp" ]; then return 0; fi
  now_epoch > "$stamp" 2>/dev/null || true
  return 0
}

send_alert() {
  local severity="$1" signature="$2" title="$3" body="$4" out rc result
  if ! cooldown_ok "$signature"; then
    log "cooldown active, not re-sending: $signature"
    return 0
  fi
  out="$(run_bounded "$ALERT_TIMEOUT_SECONDS" "$ALERT_BIN" \
          --lead system --project "$PROJECT_NAME" \
          --kind "$ALERT_KIND" --severity "$severity" \
          --title "$title" --body "$body" \
          --signature "$signature" --strict-delivery)"
  rc=$?
  result="$(printf '%s' "$out" | tr -d '[:space:]')"
  case "${result}/${rc}" in
    sent/0|queued_transient/2) cooldown_stamp "$signature"; return 0 ;;
  esac
  # duplicate/0 is deliberately NOT treated as delivered. It can mean an active
  # delivery lease held elsewhere, and when the claims DB is unusable
  # lead-alert.sh fail-opens to a direct POST and still reports duplicate — so it
  # is not evidence that THIS invocation was sent or durably queued.
  # lead-alert.sh runs its system-route preflight BEFORE defining its own
  # meta-alert helper, so early config failures have no fallback there. This is
  # a LOCAL breadcrumb only — never evidence the eng channel received anything.
  run_bounded "$META_TIMEOUT_SECONDS" "$META_ALERT_BIN" "voucher-watch-delivery-degraded" \
    "voucher-watch alert delivery degraded" \
    "result=${result:-<empty>} rc=${rc} signature=${signature}" >/dev/null 2>&1 || true
  log "delivery degraded: result=${result:-<empty>} rc=${rc} signature=${signature}"
  return 1
}

append_ndjson() {
  local line="$1" dir
  dir="$(dirname "$LOG_PATH")"
  mkdir -p "$dir" 2>/dev/null || return 0
  [ -L "$LOG_PATH" ] && die "refusing to write telemetry through a symlink: $LOG_PATH"
  if [ -e "$LOG_PATH" ] && [ ! -f "$LOG_PATH" ]; then
    die "refusing to write a non-regular telemetry file: $LOG_PATH"
  fi
  # A failed append must never suppress an alert, so this is best-effort.
  printf '%s\n' "$line" >> "$LOG_PATH" 2>/dev/null || true
  return 0
}

probe_daemon() {
  EAD_COUNT=0; EAD_PID="null"
  local rows
  rows="$(ps -axo pid=,comm= 2>/dev/null | grep 'ecosystemanalyticsd' | grep -v grep || true)"
  [ -n "$rows" ] || return 0
  EAD_COUNT="$(printf '%s\n' "$rows" | awk 'END{print NR+0}')"
  EAD_PID="$(printf '%s\n' "$rows" | head -1 | awk '{print $1}')"
  return 0
}

scan_panics() {
  local f base reason rc n=0 listing ls_rc
  # Distinguish "legitimately empty" from "could not enumerate". `[ -d ]` only
  # proves the path is a directory; a mode-000 directory listed with `|| true`
  # looks exactly like an empty one, and that silence is the loss mode the
  # three-valued matcher exists to prevent — it just leaked one level up.
  listing="$(ls -t "$PANIC_DIR"/ 2>/dev/null)"
  ls_rc=$?
  if [ "$ls_rc" -ne 0 ]; then
    log "panic directory is not enumerable: $PANIC_DIR"
    run_bounded "$META_TIMEOUT_SECONDS" "$META_ALERT_BIN" "voucher-watch-panic-scan-blind" \
      "voucher-watch cannot enumerate the panic report directory" \
      "dir=$PANIC_DIR — kernel-panic recurrence detection is BLIND until this is fixed." \
      >/dev/null 2>&1 || true
    return 0
  fi

  # FAIRNESS: the cap must never permanently hide a report. Counting a budget
  # slot before knowing whether a file even matches lets unrelated panics starve
  # a real one — and with no cursor that starvation is forever, not one tick.
  # Newest-first alone only fixed the case where the voucher report is newest;
  # an OLDER voucher report behind newer clean ones stayed invisible.
  #
  # So the budget is spent on MATCH ATTEMPTS, and the attempt order rotates by
  # tick so that repeated ticks eventually examine every eligible report while
  # each individual tick stays bounded. The newest report is always attempted
  # first, because a fresh panic is the case that matters most.
  local eligible="" count=0
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    case "$f" in *.panic) ;; *) continue ;; esac
    [ -L "$PANIC_DIR/$f" ] && continue
    [ -f "$PANIC_DIR/$f" ] || continue
    [ "$f" = "$SEED_BASENAME" ] && continue
    eligible="$eligible$f
"
    count=$((count + 1))
  done <<EOF
$listing
EOF
  [ "$count" -gt 0 ] || return 0

  local ordered offset step rest
  if [ "$count" -le "$MAX_REPORTS" ]; then
    ordered="$eligible"
  else
    # The newest report permanently occupies one slot (a fresh panic is the case
    # that matters most), and the REMAINING budget steps through the rest in
    # DISJOINT windows: advancing by one row per tick made consecutive windows
    # overlap by 19 entries, so 100 reports reached only 27 unique entries in 8
    # ticks while the comment claimed 5. Stepping by the window size makes the
    # bound real: every eligible report is attempted within
    # ceil((count-1)/(MAX_REPORTS-1)) ticks. Verified for count=21/26/40/100.
    step=$((MAX_REPORTS - 1))
    rest=$((count - 1))
    # RANDOM, not clock-derived. A clock-derived offset advances by step*P per
    # firing, so whenever step*P is a multiple of `rest` the window never moves
    # and those reports are starved FOREVER — and P is not ours to control:
    # launchd skips a StartInterval whenever the previous run is still going.
    # A random start cannot be locked into that resonance. The guarantee is
    # therefore probabilistic rather than a hard bound: each tick attempts
    # step/rest of the set, so the chance a given report is still unexamined
    # after k ticks is (1 - step/rest)^k — for 100 reports that is under 2% by
    # the 20th tick, i.e. twenty minutes.
    offset="${VOUCHER_WATCH_ROTATION_OFFSET:-$(( RANDOM % rest ))}"
    ordered="$(printf '%s' "$eligible" | awk -v off="$offset" -v rest="$rest" -v step="$step" '
      { rows[NR] = $0 }
      END {
        print rows[1]
        for (i = 0; i < step; i++) print rows[((off + i) % rest) + 2]
      }')"
  fi

  while IFS= read -r base; do
    [ -n "$base" ] || continue
    [ "$n" -ge "$MAX_REPORTS" ] && break
    n=$((n + 1))
    f="$PANIC_DIR/$base"
    reason="$(head -c "$PANIC_PREFIX_BYTES" "$f" 2>/dev/null | python3 "$MATCHER" "$PANIC_MARKER" 2>/dev/null)"
    rc=$?
    case "$rc" in
      0) ;;                      # match
      1) continue ;;             # a COMPLETE top-level panicString lacking the marker
      *)
        # UNKNOWN: truncated, unparseable, missing matcher, unreadable file.
        # Never silently equate this with "not a recurrence".
        log "panic report undetermined (rc=$rc): $base"
        run_bounded "$META_TIMEOUT_SECONDS" "$META_ALERT_BIN" "voucher-watch-panic-undetermined" \
          "voucher-watch could not classify a panic report" \
          "report=$base rc=$rc — could not read or parse its panicString. Recurrence detection is degraded for this report; inspect it by hand." \
          >/dev/null 2>&1 || true
        continue
        ;;
    esac
    [ -n "$reason" ] || continue
    # Signature = basename. lead-alert.sh's permanent receipt makes this
    # exactly-once for all time, with no state of our own.
    send_alert severe "panic:$base" \
      "Host kernel panic recurred (IPC voucher exhaustion)" \
      "source=panic report=$base reason=$reason — a NEW voucher panic report appeared. Reports land hours after the panic itself (the 2026-08-20 one landed 5h34m late), so read the timestamp accordingly. Check whether $GUARD_LABEL is alive; see the FLY-1929 runbook." || true
  done <<EOF
$ordered
EOF
  return 0
}

cmd_tick() {
  ZPRINT_OUTPUT="$(run_bounded 10 "$ZPRINT_BIN")"
  local bank_task bank_acct vouchers gpresent day
  gpresent="$(guard_present)"
  day="$(today)"
  probe_daemon

  # Panic scanning first-class and independent of the sampler: a broken zprint
  # must never cost us the recurrence alert.
  scan_panics

  if [ "$gpresent" = "0" ]; then
    send_alert severe "guard-absent:$day" \
      "IPC-voucher remediation daemon is missing" \
      "source=guard_health The root LaunchDaemon $GUARD_LABEL (restarts ecosystemanalyticsd above bank_task=$GUARD_TRIGGER) is neither loaded nor installed. Without it BANK voucher occupancy climbs unbounded toward IVAC_ENTRIES_MAX=$IVAC_ENTRIES_MAX and the host kernel-panics. This watcher only observes; it cannot remediate. See the FLY-1929 runbook." || true
  fi

  bank_task="$(zone_inuse bank_task)"    || die "zprint: bank_task row missing or non-numeric"
  bank_acct="$(zone_inuse bank_account)" || die "zprint: bank_account row missing or non-numeric"
  vouchers="$(zone_inuse ipc.vouchers)"  || vouchers=0

  append_ndjson "{\"ts\":$(now_epoch),\"bank_task\":$bank_task,\"bank_account\":$bank_acct,\"ipc_vouchers\":$vouchers,\"envelope\":$((bank_task + bank_acct)),\"guard_present\":$gpresent,\"ead_count\":$EAD_COUNT,\"ead_pid\":$EAD_PID}"

  local level="" severity=""
  if [ "$bank_task" -ge "$SEVERE_THRESHOLD" ]; then level="severe"; severity="severe"
  elif [ "$bank_task" -ge "$WARN_THRESHOLD" ]; then level="warn"; severity="warning"
  fi
  if [ -n "$level" ]; then
    # Signature carries the level and the day: one page per level per day, which
    # is the right granularity for "is the remediation alive", and is enforced by
    # claims.db rather than by state we would have to keep correct ourselves.
    send_alert "$severity" "bank-task-high:$level:$day" \
      "IPC-voucher remediation not keeping up: bank_task=$bank_task" \
      "source=pressure bank_task=$bank_task threshold=$([ "$level" = severe ] && printf '%s' "$SEVERE_THRESHOLD" || printf '%s' "$WARN_THRESHOLD") root_guard_trigger=$GUARD_TRIGGER bank_account=$bank_acct ipc_vouchers=$vouchers guard_present=$gpresent ead_count=$EAD_COUNT. The root guard $GUARD_LABEL should already have restarted ecosystemanalyticsd at $GUARD_TRIGGER and has not. Check that it is alive. Note bank_account is nearly equal to bank_task at high occupancy, so the upper envelope on live ivac entries is roughly double this number. See the FLY-1929 runbook." || true
  fi
  return 0
}

cmd_status() {
  ZPRINT_OUTPUT="$("$ZPRINT_BIN" 2>/dev/null)"
  local bt ba iv
  bt="$(zone_inuse bank_task)"    || { echo "bank_task: unreadable"; return 0; }
  ba="$(zone_inuse bank_account)" || { echo "bank_account: unreadable"; return 0; }
  iv="$(zone_inuse ipc.vouchers)" || iv="?"
  probe_daemon
  printf 'bank_task=%s   (root guard trips at %s; warn %s; severe %s)\n' \
    "$bt" "$GUARD_TRIGGER" "$WARN_THRESHOLD" "$SEVERE_THRESHOLD"
  printf 'bank_account=%s ipc.vouchers=%s   upper envelope %s / %s\n' \
    "$ba" "$iv" "$((bt + ba))" "$IVAC_ENTRIES_MAX"
  printf 'ecosystemanalyticsd count=%s pid=%s\n' "$EAD_COUNT" "$EAD_PID"
  printf 'remediation %s present=%s\n' "$GUARD_LABEL" "$(guard_present)"
  return 0
}

cmd_mark() {
  local label="${1:-}"
  [ -n "$label" ] || die "mark requires a label"
  label="$(printf '%s' "$label" | tr -d '"\\' | cut -c1-120)"
  append_ndjson "{\"ts\":$(now_epoch),\"kind\":\"mark\",\"label\":\"$label\"}"
  return 0
}

case "${1:-tick}" in
  tick|sample|panic-scan) cmd_tick ;;
  status)                 cmd_status ;;
  mark)                   shift; cmd_mark "${1:-}" ;;
  *) log "usage: $0 [tick|status|mark <label>]"; exit 2 ;;
esac
