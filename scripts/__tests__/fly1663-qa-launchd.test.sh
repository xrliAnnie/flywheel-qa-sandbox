#!/bin/bash
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TMP="$(mktemp -d /tmp/f1663-q.XXXXXX)"
trap 'rm -rf "$TMP"' EXIT
export HOME="$TMP/home"
export FLYWHEEL_DIR="$ROOT"
export FLYWHEEL_STATE_DIR="$TMP/state"
export FLYWHEEL_QA_LAUNCHD_DOMAIN="gui/test"
export FLYWHEEL_QA_LAUNCHD_POLL_INTERVAL=0
export FLYWHEEL_QA_LEAD_VERIFY_POLLS=1

passed=0; failed=0
pass() { printf 'PASS: %s\n' "$1"; passed=$((passed + 1)); }
fail() { printf 'FAIL: %s\n' "$1"; failed=$((failed + 1)); }

# shellcheck source=../lib/qa-launchd-lead.sh
source "$ROOT/scripts/lib/qa-launchd-lead.sh"

if [ "${QA_LAUNCHD_LEAD_VERIFY_POLLS_DEFAULT:-0}" = 60 ] \
    && [ "${QA_LAUNCHD_LEAD_VERIFY_INTERVAL_DEFAULT:-0}" = 1 ]; then
  pass "default topology verification uses a 60-second low-frequency budget"
else
  fail "default topology verification must avoid the 10 Hz probe storm"
fi

mkdir -p "$HOME" "$FLYWHEEL_STATE_DIR" "$TMP/bin" "$TMP/runtime"
manifest="$TMP/runtime/manifest.json"
projects="$TMP/runtime/projects.json"
env_file="$TMP/runtime/.env"
log_file="$TMP/runtime/lead.log"
plist="$TMP/runtime/lead.plist"
registry="$TMP/runtime/launchd-leads.json"
summary_home="$TMP/runtime/identity-home"
printf '%s\n' '{"leadId":"qa-lead","projectDir":"/tmp/project","projectName":"test-slot-7"}' > "$manifest"
printf '%s\n' '[]' > "$projects"
: > "$env_file"

label="$(qa_launchd_label 7 qa-lead)"
if [ "$label" = com.flywheel.qa.lead.slot-7.qa-lead ] \
    && ! qa_launchd_label 0 qa-lead >/dev/null 2>&1 \
    && ! qa_launchd_label 7 '../qa' >/dev/null 2>&1; then
  pass "slot-scoped launchd labels are deterministic and validated"
else
  fail "launchd label contract"
fi

if qa_launchd_render_plist "$plist" "$label" "$ROOT/scripts/flywheel-lead-wrapper-v2.sh" \
    "$manifest" "$HOME" "$FLYWHEEL_STATE_DIR" "$projects" "$env_file" "$log_file" "$summary_home" \
    && grep -qF '<key>KeepAlive</key><true/>' "$plist" \
    && grep -qF '<key>FLYWHEEL_STATE_DIR</key>' "$plist" \
    && grep -qF "$FLYWHEEL_STATE_DIR" "$plist" \
    && grep -qF '<key>FLYWHEEL_SUMMARY_CONFIG_HOME</key>' "$plist" \
    && grep -qF "$summary_home" "$plist" \
    && ! grep -qF "$HOME/.flywheel" "$plist"; then
  pass "ephemeral plist owns one v2 wrapper with slot-local state"
else
  fail "QA launchd plist render"
fi

launchctl_state="$TMP/launchctl-state"
launchctl_calls="$TMP/launchctl-calls"
launchctl_stub="$TMP/bin/launchctl"
cat > "$launchctl_stub" <<'LAUNCHCTL'
#!/bin/bash
printf '%s\n' "$*" >> "$FLY1663_QA_LAUNCHCTL_CALLS"
case "$1" in
  print)
    [ -f "$FLY1663_QA_LAUNCHCTL_STATE" ] || exit 113
    printf 'pid = 4242\n'
    ;;
  bootstrap)
    : > "$FLY1663_QA_LAUNCHCTL_STATE"
    ;;
  bootout)
    unlink "$FLY1663_QA_LAUNCHCTL_STATE" 2>/dev/null || true
    ;;
  *) exit 64 ;;
esac
LAUNCHCTL
chmod +x "$launchctl_stub"
export FLYWHEEL_QA_LAUNCHCTL="$launchctl_stub"
export FLY1663_QA_LAUNCHCTL_STATE="$launchctl_state"
export FLY1663_QA_LAUNCHCTL_CALLS="$launchctl_calls"
: > "$launchctl_calls"

if [ "$(qa_launchd_lead_start "$label" "$plist")" = 4242 ] \
    && grep -qF "bootstrap gui/test $plist" "$launchctl_calls" \
    && ! qa_launchd_lead_start "$label" "$plist" >/dev/null 2>&1; then
  pass "bootstrap returns launchd PID and refuses a duplicate loaded label"
else
  fail "QA launchd bootstrap/singleton"
fi

tmux_stub="$TMP/bin/tmux"
cat > "$tmux_stub" <<'TMUX'
#!/bin/bash
[[ "$1" == -S && "$3" == has-session && "$4" == -t && "$5" == =main ]]
TMUX
chmod +x "$tmux_stub"
export FLYWHEEL_QA_TMUX="$tmux_stub"
jq '. + {pid:4242,socketPath:"/tmp/private-qa.sock"}' "$manifest" > "$TMP/manifest.next" \
  && mv "$TMP/manifest.next" "$manifest"
if [ "$(qa_launchd_lead_verify "$label" "$manifest")" = $'4242\t/tmp/private-qa.sock' ]; then
  pass "topology gate requires launchd PID = manifest PID plus live private socket"
else
  fail "QA launchd topology verification"
fi

# A pending cold start must not inherit the 100ms PID-discovery cadence. The
# old verifier ran launchctl + two jq processes ten times per second and could
# starve the Lead that was trying to publish this manifest in the 529 room.
jq 'del(.pid, .socketPath)' "$manifest" > "$TMP/manifest.pending" \
  && mv "$TMP/manifest.pending" "$manifest"
verify_sleeps="$TMP/verify-sleeps"
: > "$verify_sleeps"
prints_before=$(grep -c '^print ' "$launchctl_calls" || true)
sleep() { printf '%s\n' "$1" >> "$verify_sleeps"; }
export FLYWHEEL_QA_LEAD_VERIFY_POLLS=2
unset FLYWHEEL_QA_LEAD_VERIFY_INTERVAL
qa_launchd_lead_verify "$label" "$manifest" >/dev/null 2>&1 || true
unset -f sleep
export FLYWHEEL_QA_LEAD_VERIFY_POLLS=1
prints_after=$(grep -c '^print ' "$launchctl_calls" || true)
if [ -s "$verify_sleeps" ] \
    && ! grep -Ev '^1$' "$verify_sleeps" >/dev/null \
    && [ "$prints_after" = "$prints_before" ]; then
  pass "pending topology probes are paced and defer launchctl until publication"
else
  fail "pending topology verifier still creates a process probe storm"
fi

if qa_launchd_register "$registry" "$label" "$plist" "$manifest" \
    && qa_launchd_register "$registry" "$label" "$plist" "$manifest" \
    && [ "$(jq length "$registry")" = 1 ] \
    && qa_launchd_stop_registry "$registry" \
    && grep -qF "bootout gui/test/$label" "$launchctl_calls"; then
  pass "registry is idempotent and bootout is the KeepAlive teardown authority"
else
  fail "QA launchd registry/teardown"
fi

printf '\n%d passed, %d failed\n' "$passed" "$failed"
[ "$failed" -eq 0 ]
