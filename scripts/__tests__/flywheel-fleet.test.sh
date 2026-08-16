#!/bin/bash
# FLY-247 WI-3: flywheel-fleet.sh — plan/apply/rollback/recover.
#
# Scenario map (plan §WI-3 test list; Codex review round in brackets):
#   T1  plan: three-way drift table + read-only (zero writes)
#   T2  plan: "plist has model, config doesn't" form visible
#   T3  apply --dry-run: WOULD-APPLY printed, zero changes, wrapper untouched
#   T4  non-TTY without --yes → APPLICABLE leads declined, wrapper untouched
#   T5  codex three-direction matrix → all UNAPPLIED + non-zero,
#       wrapper byte-untouched [R1#3/R3#3]
#   T6  bespoke-running / not-installed lead → never created [R2#3]
#   T7  FLYWHEEL_PROJECTS set → fail-close [R1#7]
#   T8  --lead short-name ambiguity across projects → error [R1#9]
#   T9  lock held → refuse [R1#9]
#   T10 apply --yes success: Phase W once + staged commit + applied +
#       canonical plist gains model env + postImage recorded
#   T11 two leads: wrapper installed exactly once (call count) [R4#2]
#   T12 verify-fail rollback e2e: old plist HAS model + manifest没有 →
#       restore-first → plist bytes fully recovered [R1#2/R2#1]
#   T13 stop-timeout → manual-intervention + NO bootstrap [R2#2]
#   T14 TOCTOU: config edited after confirmation (during Phase W) →
#       zero bootout, lead unapplied [R5#3/R8#5]
#   T15 two leads, second fails → wrapper NOT rolled back, lead A untouched
#       by the failure, txn statuses correct [R2#5]
#   T16 rollback CAS: PID-only manifest rewrite allowed; newer txn blocks
#       older --txn; newest-first order works [R5#5/R6#2]
#   T17 manifest model tampering after apply → rollback rejected [R7#3]
#   T18 recover: kill-mid-commit txn → deterministic restore [R4#3/R6#3];
#       wrapper mid-phase → wrapper restored + txn terminated [R7#2];
#       plan with unfinished txn → report + exit 1 + zero mutation
#   T19 recover: absent originals → absence restored [R2#2]
#   T20 probe failure (launchctl missing) → management indeterminate →
#       UNAPPLIED, not external [R4#1]
#
# Hermetic: HOME sandboxed; launchctl/tmux stubbed via daemon env seams
# (inherited by the real daemon subprocess fleet delegates to).
set -uo pipefail

PASSED=0
FAILED=0
log_test() { echo "[TEST] $*"; }
pass() { PASSED=$((PASSED + 1)); log_test "✓ $1"; }
fail() { FAILED=$((FAILED + 1)); log_test "✗ $1"; }

command -v jq >/dev/null 2>&1 || { echo "ERROR: jq required"; exit 1; }
command -v node >/dev/null 2>&1 || { echo "ERROR: node required"; exit 1; }

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
FLEET="${REPO_ROOT}/scripts/flywheel-fleet.sh"

# Keep HOME short enough to exercise the real macOS tmux socket budget.
SANDBOX="$(mktemp -d /tmp/fly247-fleet.XXXXXX)"
LIVE_PIDS=()
cleanup() {
  for p in "${LIVE_PIDS[@]:-}"; do kill "$p" 2>/dev/null || true; done
  rm -rf "$SANDBOX"
}
trap cleanup EXIT

export HOME="$SANDBOX"
export FLYWHEEL_STATE_DIR="$HOME/.flywheel"
export FLYWHEEL_DIR="$HOME/Dev/flywheel"
# shellcheck source=../lib/lead-address.sh
source "$REPO_ROOT/scripts/lib/lead-address.sh"
CTL="$SANDBOX/ctl"
mkdir -p "$CTL" "$SANDBOX/.flywheel/manifests" "$SANDBOX/Library/LaunchAgents" \
  "$SANDBOX/.flywheel/bin" "$SANDBOX/Dev/flywheel/scripts" "$SANDBOX/proj/geo" "$SANDBOX/proj/joy"

# Fake v2 wrapper source for generated plist fixtures.
# FLY-954: fixture must PASS install_script_atomic's source sanity (≥1KB +
# substantive lines) — the 12-byte stub shape is exactly what installs refuse.
{
  echo '#!/bin/bash'
  echo '# fake wrapper for tests — leadBackend dispatch marker (FLY-224)'
  i=1; while [ "$i" -le 60 ]; do echo "echo sane-fixture-wrapper-line-$i >/dev/null"; i=$((i+1)); done
  echo 'exit 0'
} > "$SANDBOX/Dev/flywheel/scripts/flywheel-lead-wrapper-v2.sh"
chmod +x "$SANDBOX/Dev/flywheel/scripts/flywheel-lead-wrapper-v2.sh"
cp "$SANDBOX/Dev/flywheel/scripts/flywheel-lead-wrapper-v2.sh" \
  "$SANDBOX/Dev/flywheel/scripts/flywheel-lead-attach.sh"
mkdir -p "$SANDBOX/Dev/flywheel/scripts/lib"
{
  echo '#!/bin/bash'
  i=1; while [ "$i" -le 60 ]; do echo "echo sane-address-helper-line-$i >/dev/null"; i=$((i+1)); done
} > "$SANDBOX/Dev/flywheel/scripts/lib/lead-address.sh"
chmod +x "$SANDBOX/Dev/flywheel/scripts/flywheel-lead-wrapper-v2.sh" \
  "$SANDBOX/Dev/flywheel/scripts/flywheel-lead-attach.sh" \
  "$SANDBOX/Dev/flywheel/scripts/lib/lead-address.sh"

# launchctl / tmux stubs (same state machine as the daemon test).
cat > "$SANDBOX/launchctl-stub" <<'EOF'
#!/bin/bash
CTL="${LAUNCHCTL_STUB_CTL:?}"
echo "$1" >> "$CTL/calls.log"
case "$1" in
  print)
    if [ -f "$CTL/loaded" ]; then
      pid="$(cat "$CTL/pid.last" 2>/dev/null || echo 0)"
      if [ "$pid" != "0" ]; then echo "    pid = $pid"; fi
      exit 0
    fi
    echo "Could not find service" >&2
    exit 1 ;;
  bootout)   rm -f "$CTL/loaded"; exit 0 ;;
  bootstrap)
    rc="$(cat "$CTL/bootstrap_rc" 2>/dev/null || echo 0)"
    if [ "$rc" = "0" ]; then touch "$CTL/loaded"; fi
    echo "bootstrap $3" >> "$CTL/calls.log"
    exit "$rc" ;;
  *) exit 0 ;;
esac
EOF
chmod +x "$SANDBOX/launchctl-stub"
cat > "$SANDBOX/tmux-stub" <<'EOF'
#!/bin/bash
CTL="${LAUNCHCTL_STUB_CTL:?}"
if [ "${1:-}" = "-S" ]; then
  cat "$CTL/tmux_out" 2>/dev/null || true
  exit 0
fi
cat "$CTL/tmux_out" 2>/dev/null || true
EOF
chmod +x "$SANDBOX/tmux-stub"

# Linux CI's `plutil` cannot convert Apple's XML plist to JSON. Fleet delegates
# that conversion to flywheel-daemon.sh, so keep this suite hermetic just like
# launchctl/tmux: lint succeeds and conversion parses the generated fixture
# without depending on the host implementation.
cat > "$SANDBOX/plutil-stub" <<'EOF'
#!/bin/bash
case "${1:-}" in
  -lint)
    exit 0
    ;;
  -convert)
    [ "${2:-}" = json ] && [ "${3:-}" = -o ] && [ "${4:-}" = - ] \
      && [ -f "${5:-}" ] || exit 64
    "${FLY247_NODE_BIN:?}" - "$5" <<'NODE'
const fs = require("node:fs");

const xml = fs.readFileSync(process.argv[2], "utf8");
const decode = (value) =>
  value
    .replaceAll("&apos;", "'")
    .replaceAll("&quot;", '"')
    .replaceAll("&gt;", ">")
    .replaceAll("&lt;", "<")
    .replaceAll("&amp;", "&");
const block = xml.match(
  /<key>\s*EnvironmentVariables\s*<\/key>\s*<dict>([\s\S]*?)<\/dict>/,
);
const environment = {};
if (block) {
  const pair = /<key>([\s\S]*?)<\/key>\s*<string>([\s\S]*?)<\/string>/g;
  for (const match of block[1].matchAll(pair)) {
    environment[decode(match[1])] = decode(match[2]);
  }
}
process.stdout.write(`${JSON.stringify({ EnvironmentVariables: environment })}\n`);
NODE
    ;;
  *)
    exit 64
    ;;
esac
EOF
chmod +x "$SANDBOX/plutil-stub"

# Enhanced stub for SUCCESS-path scenarios: bootout kills the recorded old
# process (like real launchd) and bootstrap brings up next_pid (the "new
# Lead"). The basic stub above keeps processes alive → exercises stop-timeout.
cat > "$SANDBOX/launchctl-stub2" <<'EOF'
#!/bin/bash
CTL="${LAUNCHCTL_STUB_CTL:?}"
echo "$1" >> "$CTL/calls.log"
case "$1" in
  print)
    if [ -f "$CTL/loaded" ]; then
      pid="$(cat "$CTL/pid.last" 2>/dev/null || echo 0)"
      if [ "$pid" != "0" ]; then echo "    pid = $pid"; fi
      exit 0
    fi
    echo "Could not find service" >&2
    exit 1 ;;
  bootout)
    rm -f "$CTL/loaded"
    kill "$(cat "$CTL/kill_on_bootout" 2>/dev/null)" 2>/dev/null
    echo 0 > "$CTL/pid.last"
    exit 0 ;;
  bootstrap)
    touch "$CTL/loaded"
    # next_pid is a POP QUEUE: each bootstrap consumes one line (lets one
    # scenario script different outcomes for successive bootstraps, e.g.
    # staged-boot fails then recovery-boot succeeds).
    if [ -s "$CTL/next_pid" ]; then
      head -1 "$CTL/next_pid" > "$CTL/pid.last"
      tail -n +2 "$CTL/next_pid" > "$CTL/next_pid.rest" && mv "$CTL/next_pid.rest" "$CTL/next_pid"
    fi
    # wrapper-v2 booted-pid manifest stamp (runtime binding evidence)
    if [ -f "$CTL/manifest_path" ]; then
      mp="$(cat "$CTL/manifest_path")"
      np="$(cat "$CTL/pid.last" 2>/dev/null || echo 0)"
      if [ -f "$mp" ] && [ "$np" != "0" ]; then
        socket="$(cat "$CTL/socket_path" 2>/dev/null || true)"
        jq --argjson pid "$np" --arg socket "$socket" \
          '.pid = $pid | if $socket == "" then . else .socketPath = $socket end' \
          "$mp" > "$mp.stubtmp" && mv "$mp.stubtmp" "$mp"
      fi
    fi
    echo "bootstrap $3" >> "$CTL/calls.log"
    exit 0 ;;
  *) exit 0 ;;
esac
EOF
chmod +x "$SANDBOX/launchctl-stub2"

export LAUNCHCTL_STUB_CTL="$CTL"
export FLYWHEEL_DAEMON_LAUNCHCTL="$SANDBOX/launchctl-stub"
export FLYWHEEL_DAEMON_TMUX="$SANDBOX/tmux-stub"
FLY247_NODE_BIN="$(command -v node)"
export FLY247_NODE_BIN
export FLYWHEEL_DAEMON_PLUTIL="$SANDBOX/plutil-stub"
export FLYWHEEL_DAEMON_STOP_TIMEOUT=1
export FLYWHEEL_DAEMON_VERIFY_TIMEOUT=2
export FLYWHEEL_DAEMON_POLL_INTERVAL=1
export FLYWHEEL_DAEMON_SKIP_PS_SELF_PROBE=1

PROJECTS="$SANDBOX/.flywheel/projects.json"
KEY="geo-product-lead"
MANIFEST="$SANDBOX/.flywheel/manifests/${KEY}.json"
PLIST="$SANDBOX/Library/LaunchAgents/com.flywheel.lead.${KEY}.plist"
BACKUPS="$SANDBOX/.flywheel/fleet-backups"

write_projects() {
  # write_projects <model-json> [<backend-json>]
  local model="$1" backend="${2:-null}"
  jq -n --argjson model "$model" --argjson backend "$backend" \
    '[{projectName: "geo", projectRoot: "'"$SANDBOX"'/proj/geo",
       leads: [({agentId: "product-lead", chatChannel: "1", match: {labels: ["Product"]}}
               + (if $model != null then {model: $model} else {} end)
               + (if $backend != null then {backend: $backend, companion: true, canSpawnRunners: false} else {} end))]}]' \
    > "$PROJECTS"
}

spawn_live() {
  # stdout/stderr redirected away: a backgrounded child holding the
  # command-substitution pipe would block $(setup_running_lead) for 300s
  # and leave every later scenario with a DEAD manifest pid.
  sleep 300 </dev/null >/dev/null 2>&1 &
  local pid=$!
  LIVE_PIDS+=("$pid")
  echo "$pid"
}

# Build a healthy "standard-confirmed × claude-confirmed" running lead.
setup_running_lead() {
  local model_in_manifest="$1"   # json string or null
  local live_pid socket_path
  live_pid=$(spawn_live)
  socket_path=$(derive_lead_socket "geo/product-lead" "$FLYWHEEL_STATE_DIR")
  jq -n --argjson model "$model_in_manifest" --argjson pid "$live_pid" --arg socket "$socket_path" \
    '{leadId:"product-lead",projectDir:"'"$SANDBOX"'/proj/geo",projectName:"geo",
      subdir:"",workspace:"'"$SANDBOX"'/proj/geo",botTokenEnv:"DISCORD_BOT_TOKEN",
      mcpExclude:"",chromeEnabled:false,pid:$pid,socketPath:$socket}
     | (if $model != null then . + {model: $model} else . end)' > "$MANIFEST"
  # canonical plist via the daemon generator (correct wrapper/manifest/label)
  FLYWHEEL_DAEMON_SOURCED=1 bash -c "
    source '$REPO_ROOT/scripts/flywheel-daemon.sh'
    generate_plist '$KEY' '$MANIFEST'" >/dev/null
  echo "$live_pid" > "$CTL/pid.last"
  touch "$CTL/loaded"
  printf '0\tmain\tmain\t0\tclaude\n' > "$CTL/tmux_out"
  echo "$live_pid"
}

reset_world() {
  rm -rf "$BACKUPS" "$CTL"/* "$MANIFEST" "$PLIST" "$SANDBOX/proj/geo/.flywheel"
  echo 0 > "$CTL/pid.last"
}

# ── T1/T2: plan — three-way drift, read-only ──────────────────────────────
reset_world
write_projects '"claude-fable-5"'
LIVE=$(setup_running_lead null)
OUT=$(bash "$FLEET" plan 2>&1)
if echo "$OUT" | grep -q "APPLICABLE" && echo "$OUT" | grep -q "claude-fable-5@claude-code" \
  && [ ! -d "$BACKUPS" ]; then
  pass "T1: plan shows model drift as APPLICABLE; zero writes"
else
  fail "T1: $OUT"
fi
kill "$LIVE" 2>/dev/null || true

reset_world
write_projects null
LIVE=$(setup_running_lead '"claude-fable-5"')
OUT=$(bash "$FLEET" plan 2>&1)
if echo "$OUT" | grep -q "claude-fable-5" && echo "$OUT" | grep -q "APPLICABLE"; then
  pass "T2: 'manifest/plist have model, config does not' drift visible"
else
  fail "T2: $OUT"
fi
kill "$LIVE" 2>/dev/null || true

# ── T3: dry-run — zero changes ────────────────────────────────────────────
reset_world
write_projects '"claude-fable-5"'
LIVE=$(setup_running_lead null)
PLIST_SHA=$(shasum -a 256 "$PLIST" | awk '{print $1}')
OUT=$(bash "$FLEET" apply --dry-run 2>&1)
if echo "$OUT" | grep -q "WOULD-APPLY" \
  && [ "$(shasum -a 256 "$PLIST" | awk '{print $1}')" = "$PLIST_SHA" ] \
  && [ ! -d "$BACKUPS" ]; then
  pass "T3: --dry-run prints WOULD-APPLY and changes nothing"
else
  fail "T3: $OUT"
fi
kill "$LIVE" 2>/dev/null || true

# ── T4: non-TTY without --yes → declined, wrapper untouched ───────────────
reset_world
write_projects '"claude-fable-5"'
LIVE=$(setup_running_lead null)
OUT=$(bash "$FLEET" apply < /dev/null 2>&1)
if echo "$OUT" | grep -qE "DECLINED|abort" && [ ! -d "$BACKUPS" ]; then
  pass "T4: non-interactive without --yes → no destructive action"
else
  fail "T4: $OUT"
fi
kill "$LIVE" 2>/dev/null || true

# ── T5: codex three-direction matrix → all UNAPPLIED ───────────────────
reset_world
# (a) desired codex (Claude → Codex)
write_projects null '"codex-app-server"'
LIVE=$(setup_running_lead null)
OUT_A=$(bash "$FLEET" apply --yes 2>&1); RC_A=$?
# (b) carrier codex (Codex → Claude): manifest carries codex backendId
jq '. + {leadBackend: {backendId: "codex-app-server"}}' "$MANIFEST" > "$MANIFEST.n" && mv "$MANIFEST.n" "$MANIFEST"
write_projects '"claude-fable-5"'
OUT_B=$(bash "$FLEET" apply --yes 2>&1); RC_B=$?
# (c) codex model-only: desired codex + model
write_projects '"o3-pro"' '"codex-app-server"'
OUT_C=$(bash "$FLEET" apply --yes 2>&1); RC_C=$?
if echo "$OUT_A" | grep -q "UNAPPLIED codex-desired" && [ "$RC_A" -ne 0 ] \
  && echo "$OUT_B" | grep -q "UNAPPLIED codex-carrier" && [ "$RC_B" -ne 0 ] \
  && echo "$OUT_C" | grep -q "UNAPPLIED codex-desired" && [ "$RC_C" -ne 0 ]; then
  pass "T5: codex matrix (→codex / codex→ / codex model-only) all UNAPPLIED + non-zero"
else
  fail "T5: A($RC_A)=$(echo "$OUT_A" | grep product-lead | head -1) B($RC_B)=$(echo "$OUT_B" | grep product-lead | head -1) C($RC_C)"
fi
kill "$LIVE" 2>/dev/null || true

# ── T6: not-installed lead never created ──────────────────────────────────
reset_world
write_projects '"claude-fable-5"'
OUT=$(bash "$FLEET" apply --yes 2>&1); RC=$?
if echo "$OUT" | grep -q "UNAPPLIED not-installed" && [ "$RC" -ne 0 ] \
  && [ ! -f "$MANIFEST" ] && [ ! -f "$PLIST" ]; then
  pass "T6: lead without carrier is never installed/created by apply"
else
  fail "T6: rc=$RC $OUT"
fi

# ── T7: FLYWHEEL_PROJECTS env → fail-close ────────────────────────────────
reset_world
write_projects '"claude-fable-5"'
OUT=$(FLYWHEEL_PROJECTS='[]' bash "$FLEET" plan 2>&1); RC=$?
if [ "$RC" -ne 0 ] && echo "$OUT" | grep -q "split-brain"; then
  pass "T7: FLYWHEEL_PROJECTS set → fail-close"
else
  fail "T7: rc=$RC $OUT"
fi

# ── T8: --lead ambiguity across projects ──────────────────────────────────
reset_world
jq -n '[{projectName:"geo",projectRoot:"'"$SANDBOX"'/proj/geo",leads:[{agentId:"product-lead",chatChannel:"1",match:{labels:["P"]}}]},
        {projectName:"joy",projectRoot:"'"$SANDBOX"'/proj/joy",leads:[{agentId:"product-lead",chatChannel:"2",match:{labels:["P"]}}]}]' > "$PROJECTS"
OUT=$(bash "$FLEET" plan --lead product-lead 2>&1); RC=$?
if [ "$RC" -ne 0 ] && echo "$OUT" | grep -q "matches 2 leads"; then
  pass "T8: short --lead matching two projects → hard error"
else
  fail "T8: rc=$RC $OUT"
fi

# ── T9: lock held → refuse ────────────────────────────────────────────────
reset_world
write_projects '"claude-fable-5"'
mkdir -p "$SANDBOX/.flywheel/restart.lock.d"
OUT=$(bash "$FLEET" apply --yes 2>&1); RC=$?
rmdir "$SANDBOX/.flywheel/restart.lock.d"
if [ "$RC" -ne 0 ] && echo "$OUT" | grep -q "restart operation holds"; then
  pass "T9: restart.lock.d held → refuse"
else
  fail "T9: rc=$RC $OUT"
fi

# ── T10: success path — full staged chain ─────────────────────────────────
reset_world
write_projects '"claude-fable-5"'
LIVE=$(setup_running_lead null)
NEXT=$(spawn_live)
echo "$LIVE" > "$CTL/kill_on_bootout"
echo "$NEXT" > "$CTL/next_pid"
echo "$MANIFEST" > "$CTL/manifest_path"
OUT=$(FLYWHEEL_DAEMON_LAUNCHCTL="$SANDBOX/launchctl-stub2" bash "$FLEET" apply --yes 2>&1); RC=$?
TXN_DIR=$(ls -1d "$BACKUPS"/*/ 2>/dev/null | head -1)
if [ "$RC" -eq 0 ] && echo "$OUT" | grep -q "APPLIED" \
  && grep -q "<key>FLYWHEEL_LEAD_MODEL</key><string>claude-fable-5</string>" "$PLIST" \
  && [ "$(jq -r '.model' "$MANIFEST")" = "claude-fable-5" ] \
  && [ "$(jq -r '.leads["'"$KEY"'"].original.projectModel' "${TXN_DIR}transaction.json")" = "null" ] \
  && [ "$(jq -r '.leads["'"$KEY"'"].original.projectPreimageSource' "${TXN_DIR}transaction.json")" = "manifest" ] \
  && [ "$(jq -r '.leads["'"$KEY"'"].phase' "${TXN_DIR}transaction.json")" = "applied" ] \
  && [ "$(jq -r '.leads["'"$KEY"'"].postImage.plistSha' "${TXN_DIR}transaction.json")" != "null" ]; then
  pass "T10: apply --yes → staged commit + model env in plist + postImage"
else
  fail "T10: rc=$RC $OUT"
fi
kill "$LIVE" 2>/dev/null || true
T10_TXN_DIR="$TXN_DIR"

# ── T16/T17 (build on T10 state): rollback CAS lineage ────────────────────
# PID-only rewrite (claude-lead.sh boot) must NOT block rollback (R6#2).
NEWPID=$(spawn_live)
jq --argjson pid "$NEWPID" '.pid = $pid' "$MANIFEST" > "$MANIFEST.n" && mv "$MANIFEST.n" "$MANIFEST"
echo "$NEWPID" > "$CTL/pid.last"
# T17 first: tamper model by hand → rollback must refuse.
jq '.model = "hand-edited"' "$MANIFEST" > "$MANIFEST.n" && mv "$MANIFEST.n" "$MANIFEST"
OUT=$(bash "$FLEET" apply --rollback --yes 2>&1); RC=$?
if [ "$RC" -ne 0 ] && echo "$OUT" | grep -q "launch-affecting fields changed"; then
  pass "T17: hand-tampered manifest model → rollback refused (CAS)"
else
  fail "T17: rc=$RC $OUT"
fi
# restore the applied model; now only pid differs from post-image → allowed.
jq '.model = "claude-fable-5"' "$MANIFEST" > "$MANIFEST.n" && mv "$MANIFEST.n" "$MANIFEST"
echo "$NEWPID" > "$CTL/kill_on_bootout"
NEXT_RB=$(spawn_live)
echo "$NEXT_RB" > "$CTL/next_pid"
OUT=$(FLYWHEEL_DAEMON_LAUNCHCTL="$SANDBOX/launchctl-stub2" bash "$FLEET" apply --rollback --yes 2>&1); RC=$?
if [ "$RC" -eq 0 ] && echo "$OUT" | grep -q "ROLLED-BACK" \
  && ! grep -q "FLYWHEEL_LEAD_MODEL" "$PLIST" \
  && ! jq -e 'has("model")' "$MANIFEST" >/dev/null \
  && ! jq -e '.[0].leads[0] | has("model")' "$PROJECTS" >/dev/null \
  && grep -q "bootstrap" "$CTL/calls.log"; then
  pass "T16a: PID-only rewrite tolerated; rollback restores pre-image plist (no model env) via backup bootstrap"
else
  fail "T16a: rc=$RC $OUT"
fi
kill "$NEWPID" 2>/dev/null || true

# T16b: two transactions → --txn T1 blocked while T2 applied is newer.
reset_world
write_projects '"claude-fable-5"'
LIVE=$(setup_running_lead null)
NEXT=$(spawn_live)
echo "$LIVE" > "$CTL/kill_on_bootout"
echo "$NEXT" > "$CTL/next_pid"
echo "$MANIFEST" > "$CTL/manifest_path"
FLYWHEEL_DAEMON_LAUNCHCTL="$SANDBOX/launchctl-stub2" bash "$FLEET" apply --yes >/dev/null 2>&1
TXN1=$(basename "$(ls -1d "$BACKUPS"/*/ | head -1)")
sleep 1
write_projects '"claude-opus-5"'
# manifest pid was self-written to $NEXT by the stub bootstrap (binding holds)
NEXT2=$(spawn_live)
echo "$NEXT" > "$CTL/kill_on_bootout"
echo "$NEXT2" > "$CTL/next_pid"
printf '0\tmain\tmain\t0\tclaude\n' > "$CTL/tmux_out"
FLYWHEEL_DAEMON_LAUNCHCTL="$SANDBOX/launchctl-stub2" bash "$FLEET" apply --yes >/dev/null 2>&1
OUT=$(bash "$FLEET" apply --rollback --txn "$TXN1" --yes 2>&1); RC=$?
if [ "$RC" -ne 0 ] && echo "$OUT" | grep -qE "newer applied transaction|does not match transaction post-image"; then
  pass "T16b: --txn T1 refused while newer applied T2 exists"
else
  fail "T16b: rc=$RC $OUT"
fi
# Roll back newest first, then T1 becomes legal.
echo "$NEXT2" > "$CTL/kill_on_bootout"
NEXT3=$(spawn_live)
echo "$NEXT3" > "$CTL/next_pid"
FLYWHEEL_DAEMON_LAUNCHCTL="$SANDBOX/launchctl-stub2" bash "$FLEET" apply --rollback --yes >/dev/null 2>&1
echo "$NEXT3" > "$CTL/kill_on_bootout"
NEXT4=$(spawn_live)
echo "$NEXT4" > "$CTL/next_pid"
OUT=$(FLYWHEEL_DAEMON_LAUNCHCTL="$SANDBOX/launchctl-stub2" bash "$FLEET" apply --rollback --txn "$TXN1" --yes 2>&1); RC=$?
if [ "$RC" -eq 0 ] && echo "$OUT" | grep -q "ROLLED-BACK" \
  && ! jq -e '.[0].leads[0] | has("model")' "$PROJECTS" >/dev/null; then
  pass "T16c: after rolling back T2, --txn T1 succeeds (newest-first lineage)"
else
  fail "T16c: rc=$RC $OUT"
fi
kill "$LIVE" 2>/dev/null || true

# ── T12: verify-fail rollback e2e (old plist HAS model, manifest doesn't) ──
reset_world
write_projects '"claude-opus-5"'
LIVE=$(setup_running_lead null)
# Hand-edit the canonical plist to carry a model env the manifest lacks —
# the exact FLY-241 production form this issue root-cures (R1#2).
TMPM=$(mktemp); jq '. + {model: "hand-fable"}' "$MANIFEST" > "$TMPM"
FLYWHEEL_DAEMON_SOURCED=1 bash -c "
  source '$REPO_ROOT/scripts/flywheel-daemon.sh'
  generate_plist_to '$KEY' '$TMPM' '$MANIFEST' '$PLIST'" >/dev/null
PRE_PLIST_SHA=$(shasum -a 256 "$PLIST" | awk '{print $1}')
# Make verify fail: after bootout+commit+bootstrap, the new PID never appears.
kill "$LIVE" 2>/dev/null; wait "$LIVE" 2>/dev/null
echo 0 > "$CTL/pid.last"
# management still standard-confirmed? pid in manifest is dead now → mgmt
# would be external. Keep a live manifest pid for classification, then have
# the stub report 0 for the NEW pid after bootstrap. manifest pid == print pid
# during classification:
LIVE2=$(spawn_live)
jq --argjson pid "$LIVE2" '.pid = $pid' "$MANIFEST" > "$MANIFEST.n" && mv "$MANIFEST.n" "$MANIFEST"
# Re-make the hand-model plist AFTER manifest edit (manifest hash must match
# what apply snapshots; plist content unchanged form)
TMPM2=$(mktemp); jq '. + {model: "hand-fable"}' "$MANIFEST" > "$TMPM2"
FLYWHEEL_DAEMON_SOURCED=1 bash -c "
  source '$REPO_ROOT/scripts/flywheel-daemon.sh'
  generate_plist_to '$KEY' '$TMPM2' '$MANIFEST' '$PLIST'" >/dev/null
PRE_PLIST_SHA=$(shasum -a 256 "$PLIST" | awk '{print $1}')
echo "$LIVE2" > "$CTL/pid.last"
touch "$CTL/loaded"
printf '0\tmain\tmain\t0\tclaude\n' > "$CTL/tmux_out"
# next_pid pop-queue: the STAGED bootstrap pops 0 (new PID never appears →
# verify_failed_not_started, which is the point); the RECOVERY bootstrap
# pops a live pid so the restored Lead truly boots (R2-H3 verify_booted).
echo "$LIVE2" > "$CTL/kill_on_bootout"
LIVE3=$(spawn_live)
printf '0\n%s\n' "$LIVE3" > "$CTL/next_pid"
echo "$MANIFEST" > "$CTL/manifest_path"
OUT=$(FLYWHEEL_DAEMON_LAUNCHCTL="$SANDBOX/launchctl-stub2" bash "$FLEET" apply --yes 2>&1); RC=$?
POST_PLIST_SHA=$(shasum -a 256 "$PLIST" | awk '{print $1}')
TXN_DIR=$(ls -1dr "$BACKUPS"/*/ | head -1)
if [ "$RC" -ne 0 ] && echo "$OUT" | grep -q "ROLLED-BACK" \
  && [ "$POST_PLIST_SHA" = "$PRE_PLIST_SHA" ] \
  && grep -q "FLYWHEEL_LEAD_MODEL</key><string>hand-fable" "$PLIST" \
  && grep -q "bootstrap ${PLIST}" "$CTL/calls.log" \
  && [ "$(jq -r '.leads["'"$KEY"'"].phase' "${TXN_DIR}transaction.json")" = "rolled-back" ]; then
  pass "T12: verify-fail → restore-first rollback; hand-edited plist model bytes fully recovered"
else
  fail "T12: rc=$RC post==pre:$([ "$POST_PLIST_SHA" = "$PRE_PLIST_SHA" ] && echo yes || echo no) $OUT"
fi

# ── T13: stop-timeout → manual-intervention + NO bootstrap ────────────────
reset_world
write_projects '"claude-opus-5"'
LIVE=$(setup_running_lead null)
# default stub: bootout does NOT kill the process → stop-timeout in daemon
OUT=$(bash "$FLEET" apply --yes 2>&1); RC=$?
TXN_DIR=$(ls -1dr "$BACKUPS"/*/ | head -1)
if [ "$RC" -ne 0 ] && echo "$OUT" | grep -q "manual intervention" \
  && ! grep -q "bootstrap" "$CTL/calls.log" \
  && [ "$(jq -r '.leads["'"$KEY"'"].phase' "${TXN_DIR}transaction.json")" = "manual-intervention" ]; then
  pass "T13: stop-timeout → manual-intervention, NEVER bootstraps"
else
  fail "T13: rc=$RC $OUT calls=$(tr '\n' ',' < "$CTL/calls.log")"
fi
kill "$LIVE" 2>/dev/null || true

# ── T20: probe failure → indeterminate (not external) → UNAPPLIED ─────────
reset_world
write_projects '"claude-opus-5"'
LIVE=$(setup_running_lead null)
OUT=$(FLYWHEEL_DAEMON_LAUNCHCTL="/nonexistent/launchctl" bash "$FLEET" apply --yes 2>&1); RC=$?
if [ "$RC" -ne 0 ] && echo "$OUT" | grep -q "UNAPPLIED management-indeterminate"; then
  pass "T20: launchctl probe failure → indeterminate (fail-close, not external)"
else
  fail "T20: rc=$RC $OUT"
fi
kill "$LIVE" 2>/dev/null || true

# ── T18: recover — mid-commit txn, legacy txn rejection, plan refusal ────
reset_world
write_projects '"m1"'
LIVE=$(setup_running_lead null)
# Hand-craft an unfinished mid-commit transaction: backups present,
# canonical = mixed generation (manifest committed, plist old).
TXN_ID="20990101-000000-1"
TXN_DIR="$BACKUPS/$TXN_ID"
mkdir -p "$TXN_DIR/staged" "$TXN_DIR/backup"
cp "$MANIFEST" "$TXN_DIR/backup/${KEY}.manifest.json"
cp "$PLIST" "$TXN_DIR/backup/${KEY}.plist"
ORIG_M_SHA=$(shasum -a 256 "$MANIFEST" | awk '{print $1}')
ORIG_P_SHA=$(shasum -a 256 "$PLIST" | awk '{print $1}')
# REAL mid-commit state (code-review H5 reconciliation): the canonical
# manifest equals THIS transaction's staged artifact (first rename landed),
# the plist is still the original (second rename never happened).
jq '. + {model: "half-committed"}' "$MANIFEST" > "$TXN_DIR/staged/${KEY}.manifest.json"
cp "$TXN_DIR/staged/${KEY}.manifest.json" "$MANIFEST"
cp "$PLIST" "$TXN_DIR/staged/${KEY}.plist.unused" # staged plist absent is fine (sha="")
# mid-commit crash semantics: the fleet/daemon process died; nothing loaded
rm -f "$CTL/loaded"
echo 0 > "$CTL/pid.last"
jq -n --arg m "$ORIG_M_SHA" --arg p "$ORIG_P_SHA" \
  '{transactionId: "'"$TXN_ID"'", configSha: "x",
    leads: {"'"$KEY"'": {attempt: 1, phase: "committing",
      original: {manifestExisted: true, plistExisted: true, manifestSha: $m, plistSha: $p, manifestProjSha: "y"},
      desired: {model: "m1"}}}}' > "$TXN_DIR/transaction.json"
# plan must report + exit 1 + zero mutation
PRE=$(shasum -a 256 "$MANIFEST" | awk '{print $1}')
OUT=$(bash "$FLEET" plan 2>&1); RC=$?
if [ "$RC" -ne 0 ] && echo "$OUT" | grep -q "Unfinished transaction" \
  && [ "$(shasum -a 256 "$MANIFEST" | awk '{print $1}')" = "$PRE" ]; then
  pass "T18a: plan with unfinished txn → report + exit 1 + zero mutation"
else
  fail "T18a: rc=$RC $OUT"
fi
# apply must refuse
OUT=$(bash "$FLEET" apply --yes 2>&1); RC=$?
if [ "$RC" -ne 0 ] && echo "$OUT" | grep -q "refusing to start"; then
  pass "T18b: apply refuses while unfinished txn exists"
else
  fail "T18b: rc=$RC $OUT"
fi
# recover restores backups deterministically (recovery bootstrap truly boots)
LIVE3=$(spawn_live)
echo "$LIVE3" > "$CTL/next_pid"
echo "$MANIFEST" > "$CTL/manifest_path"
printf '0\tmain\tmain\t0\tclaude\n' > "$CTL/tmux_out"
OUT=$(FLYWHEEL_DAEMON_LAUNCHCTL="$SANDBOX/launchctl-stub2" bash "$FLEET" recover --txn "$TXN_ID" --yes 2>&1); RC=$?
REST_M_PROJ=$(jq -S 'del(.pid)' "$MANIFEST" | shasum -a 256 | awk '{print $1}')
ORIG_M_PROJ=$(jq -S 'del(.pid)' "$TXN_DIR/backup/${KEY}.manifest.json" | shasum -a 256 | awk '{print $1}')
if [ "$RC" -eq 0 ] \
  && [ "$REST_M_PROJ" = "$ORIG_M_PROJ" ] \
  && [ "$(jq -r '.leads["'"$KEY"'"].phase' "$TXN_DIR/transaction.json")" = "rolled-back" ]; then
  pass "T18c: recover mid-commit → backups restored, phase rolled-back"
else
  fail "T18c: rc=$RC $OUT"
fi
kill "$LIVE" 2>/dev/null || true

# Historical wrapper transaction → reject without restoring an executable path.
reset_world
write_projects '"m1"'
LEGACY_ENTRY="$SANDBOX/.flywheel/bin/retired-entry.sh"
echo "RETIRED-BYTES" > "$LEGACY_ENTRY"
TXN_ID="20990101-000001-1"
TXN_DIR="$BACKUPS/$TXN_ID"
mkdir -p "$TXN_DIR/backup"
jq -n '{transactionId: "'"$TXN_ID"'", configSha: "x",
  wrapper: {phase: "w-installing", existed: true, sha: "s", mode: "755"},
  leads: {"'"$KEY"'": {attempt: 1, phase: "pending",
    original: {manifestExisted: true, plistExisted: true, manifestSha: "m", plistSha: "p", manifestProjSha: "y"},
    desired: {model: "m1"}}}}' > "$TXN_DIR/transaction.json"
OUT=$(bash "$FLEET" recover --txn "$TXN_ID" --yes 2>&1); RC=$?
if [ "$RC" -ne 0 ] && [ "$(cat "$LEGACY_ENTRY")" = "RETIRED-BYTES" ] \
  && [ "$(jq -r '.wrapper.phase' "$TXN_DIR/transaction.json")" = "w-installing" ] \
  && echo "$OUT" | grep -q "legacy carrier transaction"; then
  pass "T18d: legacy wrapper transaction rejected without mutation"
else
  fail "T18d: rc=$RC legacy=$(cat "$LEGACY_ENTRY") $OUT"
fi

# ── T19: recover with absent originals → absence restored ─────────────────
reset_world
write_projects '"m1"'
TXN_ID="20990101-000002-1"
TXN_DIR="$BACKUPS/$TXN_ID"
mkdir -p "$TXN_DIR/backup" "$TXN_DIR/staged"
# artifacts created by the dead txn == its staged files (the absence-restore
# guard only deletes carriers it can account for, R3-M6)
echo '{"leadId":"x"}' > "$TXN_DIR/staged/${KEY}.manifest.json"
echo 'plist' > "$TXN_DIR/staged/${KEY}.plist"
cp "$TXN_DIR/staged/${KEY}.manifest.json" "$MANIFEST"
cp "$TXN_DIR/staged/${KEY}.plist" "$PLIST"
jq -n '{transactionId: "'"$TXN_ID"'", configSha: "x",
  leads: {"'"$KEY"'": {attempt: 1, phase: "committed",
    original: {manifestExisted: false, plistExisted: false, manifestSha: "", plistSha: "", manifestProjSha: ""},
    desired: {model: "m1"}}}}' > "$TXN_DIR/transaction.json"
OUT=$(bash "$FLEET" recover --txn "$TXN_ID" --yes 2>&1); RC=$?
if [ "$RC" -eq 0 ] && [ ! -f "$MANIFEST" ] && [ ! -f "$PLIST" ] \
  && [ "$(jq -r '.leads["'"$KEY"'"].phase' "$TXN_DIR/transaction.json")" = "rolled-back" ] \
  && ! grep -q "bootstrap" "$CTL/calls.log"; then
  pass "T19: absent originals → absence restored (artifacts removed, no bootstrap)"
else
  fail "T19: rc=$RC $OUT"
fi

# ── T11/T15: two leads — second fails → A untouched ─────────────────────
reset_world
KEY2="geo-ops-lead"
MANIFEST2="$SANDBOX/.flywheel/manifests/${KEY2}.json"
PLIST2="$SANDBOX/Library/LaunchAgents/com.flywheel.lead.${KEY2}.plist"
jq -n '[{projectName: "geo", projectRoot: "'"$SANDBOX"'/proj/geo",
   leads: [{agentId: "product-lead", chatChannel: "1", match: {labels: ["P"]}, model: "claude-fable-5"},
           {agentId: "ops-lead", chatChannel: "2", match: {labels: ["O"]}, model: "claude-opus-5"}]}]' > "$PROJECTS"
# Keyed-state launchctl stub: per-label loaded/pid files — two leads can be
# simultaneously loaded with DIFFERENT pids (single-state stubs cannot model
# this; lead B's evidence re-run would misread lead A's state).
cat > "$SANDBOX/launchctl-stub3" <<'EOF'
#!/bin/bash
CTL="${LAUNCHCTL_STUB_CTL:?}"
echo "$1" >> "$CTL/calls.log"
key_from_label() { local s="${1##*/}"; echo "${s#com.flywheel.lead.}"; }
case "$1" in
  print)
    k=$(key_from_label "$2")
    if [ -f "$CTL/loaded.$k" ]; then
      pid="$(cat "$CTL/pid.$k" 2>/dev/null || echo 0)"
      if [ "$pid" != "0" ]; then echo "    pid = $pid"; fi
      exit 0
    fi
    echo "Could not find service" >&2
    exit 1 ;;
  bootout)
    k=$(key_from_label "$2")
    rm -f "$CTL/loaded.$k"
    kill "$(cat "$CTL/kill_on_bootout.$k" 2>/dev/null)" 2>/dev/null
    echo 0 > "$CTL/pid.$k"
    exit 0 ;;
  bootstrap)
    b="$(basename "$3" .plist)"; k="${b#com.flywheel.lead.}"
    touch "$CTL/loaded.$k"
    if [ -s "$CTL/next_pid.$k" ]; then
      head -1 "$CTL/next_pid.$k" > "$CTL/pid.$k"
      tail -n +2 "$CTL/next_pid.$k" > "$CTL/next_pid.$k.rest" && mv "$CTL/next_pid.$k.rest" "$CTL/next_pid.$k"
    fi
    if [ -f "$CTL/manifest_path.$k" ]; then
      mp="$(cat "$CTL/manifest_path.$k")"
      np="$(cat "$CTL/pid.$k" 2>/dev/null || echo 0)"
      if [ -f "$mp" ] && [ "$np" != "0" ]; then
        jq --argjson pid "$np" '.pid = $pid' "$mp" > "$mp.stubtmp" && mv "$mp.stubtmp" "$mp"
      fi
    fi
    echo "bootstrap $3" >> "$CTL/calls.log"
    exit 0 ;;
  *) exit 0 ;;
esac
EOF
chmod +x "$SANDBOX/launchctl-stub3"
LIVE_A=$(spawn_live)
LIVE_B=$(spawn_live)
NEXT_A=$(spawn_live)
jq -n --argjson pid "$LIVE_A" --arg socket "$(derive_lead_socket "geo/product-lead" "$FLYWHEEL_STATE_DIR")" '{leadId:"product-lead",projectDir:"'"$SANDBOX"'/proj/geo",projectName:"geo",subdir:"",workspace:"'"$SANDBOX"'/proj/geo",botTokenEnv:"D",mcpExclude:"",chromeEnabled:false,pid:$pid,socketPath:$socket}' > "$MANIFEST"
jq -n --argjson pid "$LIVE_B" --arg socket "$(derive_lead_socket "geo/ops-lead" "$FLYWHEEL_STATE_DIR")" '{leadId:"ops-lead",projectDir:"'"$SANDBOX"'/proj/geo",projectName:"geo",subdir:"",workspace:"'"$SANDBOX"'/proj/geo",botTokenEnv:"D",mcpExclude:"",chromeEnabled:false,pid:$pid,socketPath:$socket}' > "$MANIFEST2"
FLYWHEEL_DAEMON_SOURCED=1 bash -c "
  source '$REPO_ROOT/scripts/flywheel-daemon.sh'
  generate_plist '$KEY' '$MANIFEST'
  generate_plist '$KEY2' '$MANIFEST2'" >/dev/null
echo "$LIVE_A" > "$CTL/pid.$KEY"
echo "$LIVE_B" > "$CTL/pid.$KEY2"
touch "$CTL/loaded.$KEY" "$CTL/loaded.$KEY2"
echo "$LIVE_A" > "$CTL/kill_on_bootout.$KEY"
echo "$NEXT_A" > "$CTL/next_pid.$KEY"
echo "$MANIFEST" > "$CTL/manifest_path.$KEY"
NEXT_B=$(spawn_live)
echo "$NEXT_B" > "$CTL/next_pid.$KEY2"
echo "$MANIFEST2" > "$CTL/manifest_path.$KEY2"
printf '0\tmain\tmain\t0\tclaude\n' > "$CTL/tmux_out"
# Daemon shim: product-lead passes through to the real daemon (keyed stub);
# ops-lead is forced to fail with a result record.
cat > "$SANDBOX/daemon-shim2" <<EOF
#!/bin/bash
CTL="$CTL"
if [ "\$1" = "install" ] && [ "\$2" = "$KEY2" ]; then
  # honest failure simulation: the real daemon bootouts the old process and
  # waits for its exit BEFORE verify can fail — mirror that state (the fleet
  # fresh-probe guard rejects records inconsistent with a live label, R3-H2)
  kill "\$(cat "\$CTL/pid.$KEY2" 2>/dev/null)" 2>/dev/null
  rm -f "\$CTL/loaded.$KEY2"
  echo 0 > "\$CTL/pid.$KEY2"
  # identity-bound record (R10#3): fleet rejects mismatched txn/key records
  real_txn=\$(jq -r '.transactionId' "\$4/transaction.json")
  jq -n --arg txn "\$real_txn" '{version:1, transactionId: \$txn, exactKey:"$KEY2", attempt:1, phase:"verifying",
          outcome:"verify_failed_not_started", oldPid:null, newPid:null,
          labelLoaded:false, runtimeState:"not_started"}' > "\$4/result-$KEY2.json"
  exit 41
fi
exec env FLYWHEEL_DAEMON_LAUNCHCTL="$SANDBOX/launchctl-stub3" bash "$REPO_ROOT/scripts/flywheel-daemon.sh" "\$@"
EOF
chmod +x "$SANDBOX/daemon-shim2"
OUT=$(FLYWHEEL_FLEET_DAEMON_BIN="$SANDBOX/daemon-shim2" FLYWHEEL_DAEMON_LAUNCHCTL="$SANDBOX/launchctl-stub3" bash "$FLEET" apply --yes 2>&1); RC=$?
TXN_DIR=$(ls -1dr "$BACKUPS"/*/ | head -1)
if [ "$RC" -ne 0 ] \
  && [ "$(jq -r '.leads["'"$KEY"'"].phase' "${TXN_DIR}transaction.json")" = "applied" ] \
  && [ "$(jq -r '.leads["'"$KEY2"'"].phase' "${TXN_DIR}transaction.json")" = "rolled-back" ] \
  && [ "$(jq -r '.model' "$MANIFEST")" = "claude-fable-5" ] \
  && ! jq -e 'has("model")' "$MANIFEST2" >/dev/null; then
  pass "T11+T15: A applied stays applied; B failure rolled back"
else
  fail "T11+T15: rc=$RC A=$(jq -r '.leads["'"$KEY"'"].phase' "${TXN_DIR}transaction.json" 2>/dev/null) B=$(jq -r '.leads["'"$KEY2"'"].phase' "${TXN_DIR}transaction.json" 2>/dev/null) $OUT"
fi
kill "$LIVE_A" "$LIVE_B" "$NEXT_A" 2>/dev/null || true

# ── T21-T23: QA findings F-1/F-2/F-3 regressions ──────────────────────────
reset_world
write_projects '"claude-fable-5"'
# Source the fleet functions directly to pin the shared evidence helpers.
# shellcheck disable=SC1090
FLYWHEEL_FLEET_SOURCED=1 source "$REPO_ROOT/scripts/flywheel-fleet.sh"

# FLY-1806: retiring the runtime Chrome flag must not silently change the
# legacy manifest projection schema used by rollback CAS. In jq, false and a
# missing key both canonicalize through `// null`, so both fixtures share the
# historical golden hash.
CHROME_PROJECTION_WITH="$SANDBOX/chrome-projection-with.json"
CHROME_PROJECTION_WITHOUT="$SANDBOX/chrome-projection-without.json"
printf '%s\n' '{"leadId":"lead","projectName":"proj","projectDir":"/repo","subdir":"","workspace":"/repo","projectsFile":"/projects.json","mcpExclude":"","chromeEnabled":false,"model":"m","effort":"medium","leadBackend":{"backendId":"claude-code"},"launchEnvironment":{"A":"B"}}' > "$CHROME_PROJECTION_WITH"
printf '%s\n' '{"leadId":"lead","projectName":"proj","projectDir":"/repo","subdir":"","workspace":"/repo","projectsFile":"/projects.json","mcpExclude":"","model":"m","effort":"medium","leadBackend":{"backendId":"claude-code"},"launchEnvironment":{"A":"B"}}' > "$CHROME_PROJECTION_WITHOUT"
CHROME_PROJECTION_GOLDEN="66d747b54b2ead7f2d70d29358166df3783a2bb1ebcb8dee800c52bf78ebceb8"
if [ "$(manifest_projection_sha "$CHROME_PROJECTION_WITH")" = "$CHROME_PROJECTION_GOLDEN" ] \
  && [ "$(manifest_projection_sha "$CHROME_PROJECTION_WITHOUT")" = "$CHROME_PROJECTION_GOLDEN" ]; then
  pass "FLY-1806: legacy chromeEnabled projection keeps its golden CAS hash"
else
  fail "FLY-1806: legacy chromeEnabled projection hash drifted"
fi
set +e

# T21 (QA F-2): a DEAD claude pane is NOT runtime evidence (production had a
# SIGTERM'd Claude-Mufasa pane still reporting "claude" as its command).
LIVE=$(setup_running_lead null)
printf '1\tmain\tmain\t0\tclaude\n' > "$CTL/tmux_out"
claude_pane_evidence "$KEY"
rc=$?
if [ "$rc" -eq 1 ]; then
  pass "T21: dead claude pane is not claude evidence (F-2)"
else
  fail "T21: rc=$rc (expected 1)"
fi

# T22 (QA F-3): healthy production Claude panes report a bare VERSION NUMBER
# as pane_current_command — the pane PID's process tree is the real signal.
CLAUDE_NAMED=$(bash -c 'exec -a claude-lead-test sleep 300' </dev/null >/dev/null 2>&1 & echo $!)
LIVE_PIDS+=("$CLAUDE_NAMED")
printf '0\tmain\tmain\t%s\t2.1.170\n' "$CLAUDE_NAMED" > "$CTL/tmux_out"
if ! ps -o command= -p "$CLAUDE_NAMED" >/dev/null 2>&1; then
  pass "T22: process-table assertion skipped (sandbox denies ps)"
else
  claude_pane_evidence "$KEY"
  rc=$?
  if [ "$rc" -eq 0 ]; then
    pass "T22: version-number pane command + claude process tree → evidence (F-3)"
  else
    fail "T22: rc=$rc (expected 0)"
  fi
fi
kill "$CLAUDE_NAMED" 2>/dev/null || true
kill "$LIVE" 2>/dev/null || true

# T23 (QA F-1): hand-edited MULTI-LINE plist (production FLY-241 format) —
# the model must be readable so the migration runbook's seed drift appears.
LIVE=$(setup_running_lead null)
cat > "$PLIST" <<HANDEOF
<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.flywheel.lead.${KEY}</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>FLYWHEEL_LEAD_MODEL</key>
        <string>claude-fable-5</string>
    </dict>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>${SANDBOX}/.flywheel/bin/flywheel-lead-wrapper-v2.sh</string>
        <string>${MANIFEST}</string>
    </array>
</dict>
</plist>
HANDEOF
ST=$(collect_lead_state "$PROJECTS" "geo" "product-lead" "$SANDBOX/proj/geo")
PM=$(jq -r '.carrier.plistModel' <<< "$ST")
if [ "$PM" = "claude-fable-5" ]; then
  pass "T23: multi-line hand-edited plist model read correctly (F-1)"
else
  fail "T23: plistModel='$PM' (expected claude-fable-5)"
fi
kill "$LIVE" 2>/dev/null || true

echo ""
echo "Results: ${PASSED} passed, ${FAILED} failed"
[ "$FAILED" -eq 0 ] || exit 1
