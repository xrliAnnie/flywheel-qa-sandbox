#!/bin/bash
# FLY-1507 QA — real body-swap drill (founder direct order, 2026-07-27).
#
# Runs the REAL restart_lead() from BOTH main and the FLY-1507 branch against an
# IDENTICAL orphan fixture, on a REAL launchd job and a REAL tmux server.
# Nothing is stubbed except the Lead's own workload: the "body" is a sleeping
# process wearing the production `claude --agent …` argv, because the identity
# contract — not Claude itself — is what the restart path reads.
#
# Blast radius: throwaway launchd label com.flywheel.lead.fly1507qa-drill-lead,
# own tmux socket, own fake HOME. Touches no production Lead/plist/window/process.
#
# Usage: bash bodyswap-drill.sh
set -uo pipefail

ART="$HOME/.flywheel/qa-artifacts/FLY-1507"
SB="$ART/sandbox"
H="$SB/home"
SOCKET="$SB/s.sock"                       # kept short: AF_UNIX sun_path is 104B
PROJECT="fly1507qa"
LEAD="drill-lead"
WINDOW="${PROJECT}-${LEAD}"
LABEL="com.flywheel.lead.${PROJECT}-${LEAD}"
TARGET="gui/$(id -u)/${LABEL}"
PLIST="$H/Library/LaunchAgents/${LABEL}.plist"
MANIFEST="$H/.flywheel/manifests/${PROJECT}-${LEAD}.json"
WRAPPER="$H/.flywheel/bin/flywheel-lead-wrapper.sh"
PIDFILE="$H/.flywheel/pids/${PROJECT}-${LEAD}.pid"
BUNDLE="$H/.flywheel/lead-rules-bundles/${PROJECT}-${LEAD}.md"
WORKTREE="$(cd "$(dirname "$0")" >/dev/null && pwd)"
WORKTREE="/Users/xiaorongli/Dev/flywheel-FLY-1507"
STALE_MODEL="claude-opus-4-8[1m]"
GOOD_MODEL="claude-fable-5"

PASS=0; FAIL=0
pass() { echo "  ✓ $1"; PASS=$((PASS+1)); }
fail() { echo "  ✗ $1"; FAIL=$((FAIL+1)); }

qa_tmux() { tmux -S "$SOCKET" "$@"; }

teardown() {
  launchctl bootout "$TARGET" >/dev/null 2>&1 || true
  qa_tmux kill-server >/dev/null 2>&1 || true
  if [ -f "$SB/bodies" ]; then
    while read -r p; do [ -n "$p" ] && kill -KILL "$p" 2>/dev/null || true; done < "$SB/bodies"
  fi
}
trap teardown EXIT

rm -rf "$SB"
mkdir -p "$H/.flywheel/manifests" "$H/.flywheel/bin" "$H/.flywheel/pids" \
         "$H/.flywheel/lead-rules-bundles" "$H/Library/LaunchAgents" "$H/Dev"
ln -sfn "$WORKTREE" "$H/Dev/flywheel"
: > "$BUNDLE"
: > "$SB/bodies"

cat > "$MANIFEST" <<EOF
{"leadId":"$LEAD","projectName":"$PROJECT","projectDir":"$WORKTREE",
 "botTokenEnv":"FLY1507QA_TOKEN","resolvedModel":"$GOOD_MODEL"}
EOF
cat > "$H/.flywheel/projects.json" <<EOF
[{"projectName":"$PROJECT","leads":[{"agentId":"$LEAD","backend":"claude-code"}]}]
EOF

# ── stand-in supervisor: mirrors claude-lead.sh's ADOPTION behaviour, which is
#    precisely what makes an orphan body immortal across a restart.
cat > "$WRAPPER" <<EOF
#!/bin/bash
SOCKET="$SOCKET"; WINDOW="$WINDOW"; LEAD="$LEAD"; BUNDLE="$BUNDLE"
PIDFILE="$PIDFILE"; MANIFEST="\$1"; BODIES="$SB/bodies"
t() { /usr/local/bin/tmux -S "\$SOCKET" "\$@"; }
echo \$\$ > "\$PIDFILE"
live=\$(t list-panes -s -t =flywheel -F '#{window_name} #{pane_dead}' 2>/dev/null \\
        | awk -v w="\$WINDOW" '\$1==w && \$2=="0"{c++} END{print c+0}')
if [ "\${live:-0}" -eq 0 ]; then
  model=\$(sed -n 's/.*"resolvedModel":"\\([^"]*\\)".*/\\1/p' "\$MANIFEST" | head -1)
  t new-session -d -s flywheel -n scratch "while :; do sleep 1; done" 2>/dev/null
  t new-window -t flywheel -n "\$WINDOW" \\
    "exec -a claude /bin/sh -c 'while :; do sleep 1; done' claude --agent \$LEAD --permission-mode bypassPermissions --append-system-prompt-file \$BUNDLE --model '\$model'" 2>/dev/null
  sleep 1
  t list-panes -s -t =flywheel -F '#{window_name} #{pane_pid}' 2>/dev/null \\
    | awk -v w="\$WINDOW" '\$1==w{print \$2}' >> "\$BODIES"
fi
cleanup() {
  p=\$(t list-panes -s -t =flywheel -F '#{window_name} #{pane_pid}' 2>/dev/null | awk -v w="\$WINDOW" '\$1==w{print \$2}')
  for x in \$p; do kill -TERM "\$x" 2>/dev/null; done
  wid=\$(t list-panes -s -t =flywheel -F '#{window_id} #{window_name}' 2>/dev/null | awk -v w="\$WINDOW" '\$2==w{print \$1;exit}')
  [ -n "\$wid" ] && t kill-window -t "=\$wid" 2>/dev/null
  exit 0
}
trap cleanup TERM INT
while :; do sleep 1 & wait \$!; done
EOF
chmod +x "$WRAPPER"

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${LABEL}</string>
<key>ProgramArguments</key><array>
<string>/bin/bash</string><string>${WRAPPER}</string><string>${MANIFEST}</string>
</array>
<key>EnvironmentVariables</key><dict><key>PATH</key><string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string></dict>
<key>RunAtLoad</key><true/>
</dict></plist>
EOF

# ── build sourceable function-only prefixes of BOTH real scripts ──
mk_funcs() {   # <source-file> <out>
  local n; n=$(grep -n 'log "Starting full restart' "$1" | head -1 | cut -d: -f1)
  [ -n "$n" ] || return 1
  head -n $((n - 1)) "$1" > "$2"
}
git -C "$WORKTREE" show main:scripts/restart-services.sh > "$SB/main-restart.sh" || exit 1
mk_funcs "$SB/main-restart.sh" "$SB/funcs-main.sh" || exit 1
mk_funcs "$WORKTREE/scripts/restart-services.sh" "$SB/funcs-branch.sh" || exit 1

# Driver: sources the real prefix, neutralises outbound alerts, calls the real
# restart_lead(). Alerts are captured to a file so we can assert on them without
# paging anyone.
cat > "$SB/driver.sh" <<'DRV'
#!/bin/bash
set -uo pipefail
FUNCS="$1"; MANIFEST="$2"
# The real script parses "$@" at load time; sourcing it must not inherit ours.
set --
# shellcheck disable=SC1090
source "$FUNCS"
alert_warning() { echo "ALERT_WARNING|$1|$2|$3" >> "$ALERT_LOG"; }
alert_severe()  { echo "ALERT_SEVERE|$1|$2|$3"  >> "$ALERT_LOG"; }
notify_routine() { :; }
rc=0
restart_lead "$MANIFEST" || rc=$?
echo "RESTART_LEAD_RC=$rc"
exit 0
DRV
chmod +x "$SB/driver.sh"

run_driver() {   # <funcs> -> stdout of the real restart_lead
  HOME="$H" \
  FLY1507QA_TOKEN="drill-token" \
  FLYWHEEL_TMUX_SOCKET_OVERRIDE="$SOCKET" \
  ALERT_LOG="$SB/alerts.log" \
  RESTART_LEAD_STOP_WAIT_SECONDS=2 \
  RESTART_LEAD_QUIESCENCE_ATTEMPTS=30 RESTART_LEAD_QUIESCENCE_INTERVAL=1 \
  RESTART_LEAD_VERIFY_ATTEMPTS=8 RESTART_LEAD_VERIFY_INTERVAL=1 \
    bash "$SB/driver.sh" "$1" "$MANIFEST" 2>&1
}

body_ps() {   # pid -> "lstart | model"
  ps -p "$1" -o lstart=,command= 2>/dev/null \
    | sed -n 's/^\(.*[0-9]\{4\}\) *\(.*\)$/\1 :: \2/p' \
    | sed -n 's/\(.*\) :: .*--model \([^ ]*\).*/\1 | model=\2/p'
}
current_body_pid() {
  qa_tmux list-panes -s -t =flywheel -F '#{window_name} #{pane_pid} #{pane_dead}' 2>/dev/null \
    | awk -v w="$WINDOW" '$1==w && $3=="0"{print $2; exit}'
}

# ── fixture: a loaded job whose supervisor is killed WITHOUT cleanup, leaving a
#    live body nothing owns. This is the production shape from the issue.
make_orphan_fixture() {
  local model="$1"
  launchctl bootout "$TARGET" >/dev/null 2>&1 || true
  qa_tmux kill-server >/dev/null 2>&1 || true
  : > "$SB/bodies"
  sed -i '' "s/\"resolvedModel\":\"[^\"]*\"/\"resolvedModel\":\"$model\"/" "$MANIFEST"
  launchctl bootstrap "gui/$(id -u)" "$PLIST" >/dev/null 2>&1 || return 1
  local tries=0 pid=""
  while [ "$tries" -lt 60 ]; do
    pid="$(current_body_pid)"; [ -n "$pid" ] && break
    sleep 0.5; tries=$((tries+1))
  done
  [ -n "$pid" ] || return 1
  # orphan it: SIGKILL the supervisor so its TERM cleanup never runs
  local sup; sup="$(cat "$PIDFILE" 2>/dev/null)"
  kill -KILL "$sup" 2>/dev/null || true
  sleep 1
  printf '%s\n' "$pid"
}

echo "═══════════════════════════════════════════════════════════"
echo "FLY-1507 real body-swap drill — real launchd + real tmux"
echo "label=$LABEL   worktree=$WORKTREE"
echo "═══════════════════════════════════════════════════════════"

# ════════════════════════════════════════════════════════════
# BEFORE — main's restart_lead against the orphan
# ════════════════════════════════════════════════════════════
echo
echo "── BEFORE (main @ $(git -C "$WORKTREE" rev-parse --short main)) ──"
sed -i '' "s/\"resolvedModel\":\"[^\"]*\"/\"resolvedModel\":\"$GOOD_MODEL\"/" "$MANIFEST"
ORPHAN="$(make_orphan_fixture "$STALE_MODEL")"
if [ -z "$ORPHAN" ]; then echo "FIXTURE FAILED"; exit 1; fi
echo "  orphan body BEFORE: pid=$ORPHAN  $(body_ps "$ORPHAN")"
echo "$ORPHAN" >> "$SB/bodies"
: > "$SB/alerts.log"
MAIN_OUT="$(run_driver "$SB/funcs-main.sh")"
sleep 1
MAIN_BODY_AFTER="$(current_body_pid)"
echo "$MAIN_OUT" | sed 's/^/    main| /' | grep -Ei "restart|ERROR|WARNING|RC=" | head -12
echo "  orphan AFTER main: alive=$(kill -0 "$ORPHAN" 2>/dev/null && echo YES || echo no)  window_body=$MAIN_BODY_AFTER"

if echo "$MAIN_OUT" | grep -q "responsive session verified" && kill -0 "$ORPHAN" 2>/dev/null; then
    pass "BEFORE: main reports SUCCESS while orphan pid $ORPHAN ($STALE_MODEL) is still alive — FLY-1507 false positive reproduced on real launchd"
    echo "$MAIN_OUT" > "$ART/evidence-before-main.txt"
    { echo "orphan_pid=$ORPHAN"; echo "orphan_ps=$(body_ps "$ORPHAN")"; } >> "$ART/evidence-before-main.txt"
else
    fail "BEFORE: could not reproduce the false positive (orphan_alive=$(kill -0 "$ORPHAN" 2>/dev/null && echo yes || echo no))"
    echo "$MAIN_OUT" | tail -20
fi

# ════════════════════════════════════════════════════════════
# AFTER — the FLY-1507 branch's restart_lead, identical fixture
# ════════════════════════════════════════════════════════════
echo
echo "── AFTER (branch @ $(git -C "$WORKTREE" rev-parse --short HEAD)) ──"
ORPHAN2="$(make_orphan_fixture "$STALE_MODEL")"
if [ -z "$ORPHAN2" ]; then echo "FIXTURE FAILED"; exit 1; fi
BEFORE_PS="$(body_ps "$ORPHAN2")"
echo "  orphan body BEFORE: pid=$ORPHAN2  $BEFORE_PS"
echo "$ORPHAN2" >> "$SB/bodies"
# the manifest now declares the CORRECT model, exactly like FLY-1496 post-fix
sed -i '' "s/\"resolvedModel\":\"[^\"]*\"/\"resolvedModel\":\"$GOOD_MODEL\"/" "$MANIFEST"
: > "$SB/alerts.log"
BR_OUT="$(run_driver "$SB/funcs-branch.sh")"
sleep 1
NEW_BODY="$(current_body_pid)"
AFTER_PS="$(body_ps "${NEW_BODY:-0}")"
echo "$BR_OUT" | sed 's/^/    branch| /' | grep -Ei "restarted|ERROR|WARNING|RC=" | head -12
echo "  orphan AFTER branch: alive=$(kill -0 "$ORPHAN2" 2>/dev/null && echo YES || echo no)"
echo "  new body: pid=${NEW_BODY:-none}  $AFTER_PS"

if ! kill -0 "$ORPHAN2" 2>/dev/null; then
    pass "AFTER: the orphan body ($ORPHAN2, $STALE_MODEL) was really terminated"
else
    fail "AFTER: orphan $ORPHAN2 survived the new restart path"
fi

if [ -n "$NEW_BODY" ] && [ "$NEW_BODY" != "$ORPHAN2" ]; then
    pass "AFTER: a genuinely new body was born (pid $NEW_BODY, was $ORPHAN2)"
else
    fail "AFTER: no new body (got '${NEW_BODY:-none}')"
fi

if echo "$AFTER_PS" | grep -q "model=$GOOD_MODEL"; then
    pass "AFTER: the new body carries the manifest-derived model ($GOOD_MODEL), not the frozen $STALE_MODEL"
else
    fail "AFTER: new body model wrong — $AFTER_PS"
fi

if echo "$BR_OUT" | grep -q "RESTART_LEAD_RC=0" \
   && echo "$BR_OUT" | grep -q "body PID $NEW_BODY" \
   && echo "$BR_OUT" | grep -q "model $GOOD_MODEL"; then
    pass "AFTER: success is reported only with real body evidence (PID + born + model in the log line)"
else
    fail "AFTER: success log lacks body evidence: $(echo "$BR_OUT" | grep -i restarted | head -2)"
fi

{
  echo "=== FLY-1507 body-swap drill evidence ==="
  echo "branch head: $(git -C "$WORKTREE" rev-parse HEAD)"
  echo "--- BEFORE (orphan, stale model) ---"
  echo "pid=$ORPHAN2  $BEFORE_PS"
  echo "--- AFTER (post-restart) ---"
  echo "pid=${NEW_BODY:-none}  $AFTER_PS"
  echo "orphan_alive_after=$(kill -0 "$ORPHAN2" 2>/dev/null && echo YES || echo no)"
  echo "--- restart_lead output ---"
  echo "$BR_OUT"
  echo "--- alerts raised ---"
  cat "$SB/alerts.log" 2>/dev/null
} > "$ART/evidence-after-branch.txt"

# ════════════════════════════════════════════════════════════
# Healthy path — no orphan: a normal restart must still succeed
# ════════════════════════════════════════════════════════════
echo
echo "── HEALTHY (no orphan; false-negative check) ──"
launchctl bootout "$TARGET" >/dev/null 2>&1 || true
qa_tmux kill-server >/dev/null 2>&1 || true
sleep 1
launchctl bootstrap "gui/$(id -u)" "$PLIST" >/dev/null 2>&1
tries=0; H_OLD=""
while [ "$tries" -lt 60 ]; do H_OLD="$(current_body_pid)"; [ -n "$H_OLD" ] && break; sleep 0.5; tries=$((tries+1)); done
echo "$H_OLD" >> "$SB/bodies"
echo "  healthy body before: pid=$H_OLD  $(body_ps "$H_OLD")"
: > "$SB/alerts.log"
HEALTHY_OUT="$(run_driver "$SB/funcs-branch.sh")"
sleep 1
H_NEW="$(current_body_pid)"
echo "$H_NEW" >> "$SB/bodies"
echo "$HEALTHY_OUT" | sed 's/^/    healthy| /' | grep -Ei "restarted|ERROR|RC=" | head -6
if echo "$HEALTHY_OUT" | grep -q "RESTART_LEAD_RC=0" && [ -n "$H_NEW" ] \
   && [ "$H_NEW" != "$H_OLD" ] && ! kill -0 "$H_OLD" 2>/dev/null; then
    pass "HEALTHY: an ordinary Lead still restarts cleanly — old body $H_OLD gone, new body $H_NEW born (no false negative)"
else
    fail "HEALTHY: rc/body mismatch old=$H_OLD new=$H_NEW alive=$(kill -0 "$H_OLD" 2>/dev/null && echo yes || echo no)"
fi

echo
echo "═══════════════════════════════════════"
echo "Results: $PASS passed, $FAIL failed"
echo "evidence: $ART/evidence-*.txt"
echo "═══════════════════════════════════════"
[ "$FAIL" -eq 0 ]
