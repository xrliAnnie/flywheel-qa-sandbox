#!/usr/bin/env bash
# FLY-1501 QA M3 — a missing restart brake must never fail silently.
#
# Every supervised wrapper collapsed all non-zero gate exits into one quiet
# "held or refused" branch, so exit 126/127 (brake absent / not executable) was
# indistinguishable from a normal hold: the service never launches and nobody is
# told. Fail-closed is the approved direction; the silence was the defect.
#
# This drives the real gate-guard construct from each wrapper against a real
# missing binary, a real non-executable file, a real held brake and a real
# healthy brake, and asserts on the alert leg actually invoked.
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/qa-fly1501-brake-missing.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

PASSED=0
FAILED=0
pass() { PASSED=$((PASSED + 1)); echo "[TEST] ✓ $1"; }
fail() { FAILED=$((FAILED + 1)); echo "[TEST] ✗ $1 — $2"; }
eq() { if [ "$2" = "$3" ]; then pass "$1 ($2)"; else fail "$1" "want [$3] got [$2]"; fi; }
# Delivery must be SYNCHRONOUS: launchd kills the job process group on exit
# unless AbandonProcessGroup is set (these plists do not), so a backgrounded
# notifier could be killed before it writes anything. Asserting without polling
# is deliberate — a poll would let a regression to detachment pass.
wait_for_alert() { :; }

# Stub alert leg: records every invocation so we can assert on it.
ALERT_LOG="$WORK/alerts.log"
cat >"$WORK/meta-alert.sh" <<EOF
#!/bin/sh
# Mirror the real contract: reason/title/body all required, usage error otherwise.
if [ -z "\$1" ] || [ -z "\$2" ] || [ -z "\$3" ]; then
  echo "usage-error" >> "$ALERT_LOG"
  exit 2
fi
echo "meta \$1|\$2|\$3" >> "$ALERT_LOG"
EOF
chmod +x "$WORK/meta-alert.sh"
: >"$ALERT_LOG"

# Extract the guard verbatim from a wrapper so this test tracks the shipped
# code rather than a paraphrase of it.
extract_guard() {
  # The guard nests an if inside an if, so a naive range to the first `fi`
  # truncates it into unbalanced shell. Track depth and stop at the outer close.
  # Start at the RC initialiser, not the gate call: under the wrapper's own
  # `set -u` a guard extracted without it dies on an unbound variable, which the
  # positive control catches but which would otherwise look like "does not
  # launch" — i.e. a pass. End at the OUTER fi, tracking depth, because the
  # guard nests an if and a naive range truncates into unbalanced shell.
  awk '
    /^ *RESTART_STORM_RC=0$/ { grab = 1 }
    grab {
      print
      if ($0 ~ /^ *if /) depth++
      if ($0 ~ /^ *fi$/) { depth--; if (depth == 0) exit }
    }
  ' "$1"
}

run_guard() {
  # $1 = wrapper path, $2 = gate bin to use
  local wrapper="$1" gate_bin="$2" script="$WORK/guard.sh"
  # The harness MUST inherit the wrapper's own shell options. Codex R9 caught
  # this file faking 40/40 green because it omitted production `set -e`: under
  # errexit a bare non-zero gate call aborts the shell before the exit code is
  # captured, so the whole branch under test was unreachable in production
  # while the test happily exercised it. Take the options from the file.
  local opts
  opts="$(grep -m1 '^set -' "$wrapper" || echo 'set -uo pipefail')"
  {
    echo '#!/usr/bin/env bash'
    echo "$opts"
    echo 'log() { echo "log: $*"; }'
    # Must resolve to the real tree: the guard invokes scripts/lib/bounded-run.sh
    # through these. Only the alert binary itself is stubbed.
    echo "FLYWHEEL_DIR='$REPO'"
    echo "SELF_DIR='$REPO/scripts'"
    echo "RESTART_STORM_CHILD_KEY=lead.test-lead"
    echo "FLYWHEEL_META_ALERT_BIN='$WORK/meta-alert.sh'"
    echo "RESTART_STORM_GATE_BIN='$gate_bin'"
    extract_guard "$wrapper"
    echo 'echo "REACHED_LAUNCH"'
  } >"$script"
  bash "$script" 2>&1
}

WRAPPERS=(
  scripts/flywheel-bridge-wrapper.sh
  scripts/flywheel-voice-bridge-wrapper.sh
  scripts/flywheel-lead-wrapper.sh
  scripts/flywheel-quota-monitor-wrapper.sh
  scripts/flywheel-cmux-autostart.sh
)

# A healthy brake that always allows launch, and one that always holds.
printf '#!/bin/sh\nexit 0\n' >"$WORK/gate-ok.py"; chmod +x "$WORK/gate-ok.py"
printf '#!/bin/sh\nexit 3\n' >"$WORK/gate-held.py"; chmod +x "$WORK/gate-held.py"
printf 'not executable\n' >"$WORK/gate-noexec.py"; chmod 644 "$WORK/gate-noexec.py"

for rel in "${WRAPPERS[@]}"; do
  w="$REPO/$rel"
  name="$(basename "$rel" .sh)"

  # 1. Missing binary → must NOT launch, and MUST alert.
  : >"$ALERT_LOG"
  out="$(run_guard "$w" "$WORK/definitely-absent-gate.py")"
  eq "$name: missing brake does not launch" "$(echo "$out" | grep -c REACHED_LAUNCH)" "0"
  wait_for_alert
  eq "$name: missing brake alerts" "$(grep -c '^meta restart_storm_gate_unavailable' "$ALERT_LOG")" "1"
  eq "$name: alert carries reason|title|body" "$(grep -c '^meta [^|]*|[^|]\+|[^|]\+$' "$ALERT_LOG")" "1"
  eq "$name: no usage error from the alert leg" "$(grep -c '^usage-error' "$ALERT_LOG")" "0"

  # 2. Present but not executable → same treatment.
  : >"$ALERT_LOG"
  out="$(run_guard "$w" "$WORK/gate-noexec.py")"
  eq "$name: non-executable brake does not launch" "$(echo "$out" | grep -c REACHED_LAUNCH)" "0"
  wait_for_alert
  eq "$name: non-executable brake alerts" "$(grep -c '^meta restart_storm_gate_unavailable' "$ALERT_LOG")" "1"

  # 3. Genuine hold → must NOT launch and must stay QUIET (this is the
  #    expected steady state; alerting here would recreate FLY-220 spam).
  : >"$ALERT_LOG"
  out="$(run_guard "$w" "$WORK/gate-held.py")"
  eq "$name: held brake does not launch" "$(echo "$out" | grep -c REACHED_LAUNCH)" "0"
  eq "$name: held brake stays quiet" "$(grep -c '^meta ' "$ALERT_LOG")" "0"

  # 4. Positive control — a healthy brake still lets the service through, so
  #    the three "does not launch" assertions above mean something.
  : >"$ALERT_LOG"
  out="$(run_guard "$w" "$WORK/gate-ok.py")"
  eq "$name: healthy brake launches" "$(echo "$out" | grep -c REACHED_LAUNCH)" "1"
  eq "$name: healthy brake stays quiet" "$(grep -c '^meta ' "$ALERT_LOG")" "0"
done

# --- the bound itself -------------------------------------------------------
# A hung notifier must not pin the launch path. Uses the real watchdog with a
# short override so the assertion is about the mechanism, not about waiting 15s.
HANG_ALERT="$WORK/meta-alert-hang.sh"
printf '#!/bin/sh\nsleep 120\n' >"$HANG_ALERT"
chmod +x "$HANG_ALERT"

hang_guard() {
  local wrapper="$1" script="$WORK/guard-hang.sh" opts
  opts="$(grep -m1 '^set -' "$wrapper" || echo 'set -uo pipefail')"
  {
    echo '#!/usr/bin/env bash'
    echo "$opts"
    echo 'log() { echo "log: $*"; }'
    # Must resolve to the real tree: the guard invokes scripts/lib/bounded-run.sh
    # through these. Only the alert binary itself is stubbed.
    echo "FLYWHEEL_DIR='$REPO'"
    echo "SELF_DIR='$REPO/scripts'"
    echo "RESTART_STORM_CHILD_KEY=lead.test-lead"
    echo "FLYWHEEL_META_ALERT_BIN='$HANG_ALERT'"
    echo "FLYWHEEL_META_ALERT_TIMEOUT_S=2"
    echo "RESTART_STORM_GATE_BIN='$WORK/definitely-absent-gate.py'"
    extract_guard "$wrapper"
    echo 'echo "REACHED_LAUNCH"'
  } >"$script"
  bash "$script" >/dev/null 2>&1
}

for rel in "${WRAPPERS[@]}"; do
  w="$REPO/$rel"
  name="$(basename "$rel" .sh)"
  start=$(date +%s)
  hang_guard "$w"
  elapsed=$(( $(date +%s) - start ))
  if [ "$elapsed" -lt 10 ]; then
    pass "$name: hung notifier is bounded (${elapsed}s < 10s)"
  else
    fail "$name: hung notifier is bounded" "took ${elapsed}s — the launch path was pinned"
  fi
done

echo
echo "[qa-fly1501-brake-missing-alert] passed=$PASSED failed=$FAILED"
[ "$FAILED" -eq 0 ]
