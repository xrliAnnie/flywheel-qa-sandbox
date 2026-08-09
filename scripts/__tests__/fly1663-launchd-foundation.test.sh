#!/usr/bin/env bash
# FLY-1663 foundation contracts: deterministic per-Lead sockets and
# versioned launchd carriers. This suite is hermetic and never calls launchctl.
set -uo pipefail

PASSED=0
FAILED=0
pass() { PASSED=$((PASSED + 1)); echo "[TEST] ✓ $1"; }
fail() { FAILED=$((FAILED + 1)); echo "[TEST] ✗ $1"; }

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SANDBOX="$(mktemp -d "${TMPDIR:-/tmp}/fly1663-foundation.XXXXXX")"
SHORT_STATE="$(mktemp -d /tmp/fly1663-sock.XXXXXX)"
trap 'rm -rf "$SANDBOX" "$SHORT_STATE"' EXIT

export HOME="$SANDBOX/home"
mkdir -p "$HOME/.flywheel/manifests" "$HOME/.flywheel/bin" "$HOME/Library/LaunchAgents"

# shellcheck source=../lib/lead-address.sh
source "$REPO_ROOT/scripts/lib/lead-address.sh"

# S1: one exact key always resolves to one bounded absolute socket path.
socket_a="$(derive_lead_socket "flywheel-eng-lead" "$SHORT_STATE")"
socket_a_again="$(derive_lead_socket "flywheel-eng-lead" "$SHORT_STATE")"
if [ "$socket_a" = "$socket_a_again" ] \
  && [[ "$socket_a" =~ ^${SHORT_STATE}/sock/fw-[a-z0-9-]+-[0-9a-f]{16}\.sock$ ]] \
  && [ "${#socket_a}" -lt 90 ]; then
  pass "S1 deterministic bounded absolute socket path"
else
  fail "S1 bad socket path: $socket_a"
fi

# S2: cross-project same lead id must not collide.
socket_b="$(derive_lead_socket "geoforge-eng-lead" "$SHORT_STATE")"
if [ "$socket_a" != "$socket_b" ]; then
  pass "S2 exact-key hash prevents cross-project collisions"
else
  fail "S2 distinct exact keys collided"
fi

# The project/Lead boundary is part of the hash input. Hyphenated pairs that
# collide under plain `${project}-${lead}` concatenation must stay distinct.
socket_pair_a="$(derive_lead_socket "geo-forge/product-lead" "$SHORT_STATE")"
socket_pair_b="$(derive_lead_socket "geo/forge-product-lead" "$SHORT_STATE")"
if [ "$socket_pair_a" != "$socket_pair_b" ]; then
  pass "S2b structured project/Lead key prevents concatenation ambiguity"
else
  fail "S2b structured project/Lead keys collided"
fi

# S3: overlong HOME/state roots fail loudly before tmux sees sun_path.
long_root="$SANDBOX/$(printf 'x%.0s' {1..100})"
if ! derive_lead_socket "flywheel-eng-lead" "$long_root" >/dev/null 2>&1; then
  pass "S3 overlong socket path fails closed"
else
  fail "S3 overlong socket path was accepted"
fi

# S4: secure socket directory is created 0700 and symlinks are rejected.
state_dir="$SANDBOX/state"
if ensure_lead_socket_dir "$state_dir" \
  && [ "$(stat -f '%Lp' "$state_dir/sock" 2>/dev/null || stat -c '%a' "$state_dir/sock")" = "700" ]; then
  pass "S4a secure socket directory created with mode 0700"
else
  fail "S4a secure socket directory contract failed"
fi
rm -rf "$state_dir/sock"
mkdir -p "$SANDBOX/elsewhere"
ln -s "$SANDBOX/elsewhere" "$state_dir/sock"
if ! ensure_lead_socket_dir "$state_dir" >/dev/null 2>&1; then
  pass "S4b symlink socket directory rejected"
else
  fail "S4b symlink socket directory accepted"
fi

# Plist carrier selection is explicit. Absent remains v1 during the mixed
# fleet; v2 selects the immutable new wrapper; unknown fails closed.
export FLYWHEEL_DAEMON_SOURCED=1
PLUTIL_STUB="$SANDBOX/plutil"
printf '#!/bin/bash\nexit 0\n' > "$PLUTIL_STUB"
chmod +x "$PLUTIL_STUB"
export FLYWHEEL_DAEMON_PLUTIL="$PLUTIL_STUB"
# shellcheck source=../flywheel-daemon.sh
source "$REPO_ROOT/scripts/flywheel-daemon.sh"

manifest="$MANIFEST_DIR/flywheel-eng-lead.json"
mkdir -p "$(dirname "$manifest")"
jq -n '{leadId:"eng-lead",projectDir:"/tmp/flywheel",projectName:"flywheel"}' > "$manifest"

v1_plist="$SANDBOX/v1.plist"
v2_plist="$SANDBOX/v2.plist"
generate_plist_to "flywheel-eng-lead" "$manifest" "$manifest" "$v1_plist" "v1"
generate_plist_to "flywheel-eng-lead" "$manifest" "$manifest" "$v2_plist" "v2"
if grep -qF "$FLYWHEEL_BIN/flywheel-lead-wrapper.sh" "$v1_plist" \
  && grep -qF "$FLYWHEEL_BIN/flywheel-lead-wrapper-v2.sh" "$v2_plist"; then
  pass "C1 plist renders the explicit v1/v2 carrier"
else
  fail "C1 plist did not select versioned wrappers"
fi

if ! generate_plist_to "flywheel-eng-lead" "$manifest" "$manifest" "$SANDBOX/bad.plist" "bespoke" >/dev/null 2>&1; then
  pass "C2 unknown carrier fails closed"
else
  fail "C2 unknown carrier was accepted"
fi

FLYWHEEL_DIR="$REPO_ROOT"
install_wrapper >/dev/null
if [ -x "$FLYWHEEL_BIN/flywheel-lead-wrapper.sh" ] \
  && [ -x "$FLYWHEEL_BIN/flywheel-lead-wrapper-v2.sh" ] \
  && [ -x "$FLYWHEEL_BIN/flywheel-lead-attach.sh" ] \
  && [ -x "$FLYWHEEL_BIN/lib/lead-address.sh" ]; then
  pass "C3 carrier install publishes the complete v1/v2/display closure"
else
  fail "C3 mixed-carrier install closure is incomplete"
fi

# restart-services must recognize v2 authority and use only launchd's native
# replacement path; an unowned manifest can never spawn an orphan body.
# shellcheck source=../lib/lead-restart-lifecycle.sh
source "$REPO_ROOT/scripts/lib/lead-restart-lifecycle.sh"
projects="$SANDBOX/projects.json"
jq -n '{projectName:"flywheel",leads:[{agentId:"eng-lead",carrier:"v2"}]}' \
  | jq -s '.' > "$projects"
if lead_restart_validate_authority \
    "$manifest" "$v2_plist" "$projects" "com.flywheel.lead.flywheel-eng-lead" \
    && [ "$LEAD_RESTART_CARRIER" = "v2" ]; then
  pass "C4 restart authority recognizes the canonical v2 carrier"
else
  fail "C4 v2 restart authority rejected"
fi

restart_block="$(sed -n '/^restart_lead()/,/^}/p' "$REPO_ROOT/scripts/restart-services.sh")"
if grep -q 'LEAD_RESTART_CARRIER.*v2' <<< "$restart_block" \
    && grep -q 'launchctl kickstart -k' <<< "$restart_block" \
    && ! grep -qE 'nohup env|Legacy path: manual nohup' <<< "$restart_block"; then
  pass "C5 Lead restart has a native v2 path and no orphan fallback"
else
  fail "C5 Lead restart still carries a manual body creation path"
fi

ci="$REPO_ROOT/.github/workflows/ci.yml"
ci_ok=true
for suite in fly1663-launchd-foundation.test.sh fly1663-lead-v2-runtime.test.sh \
  fly1663-cmux-v2.test.sh fly1663-bridge-launchd.test.sh; do
  grep -qF "scripts/__tests__/$suite" "$ci" || ci_ok=false
done
if [ "$ci_ok" = true ]; then
  pass "C6 every FLY-1663 shell suite is registered in CI"
else
  fail "C6 FLY-1663 shell suite missing from CI"
fi

export FLYWHEEL_STATE_DIR="$SHORT_STATE"
socket_v2="$(derive_lead_socket "flywheel/eng-lead" "$FLYWHEEL_STATE_DIR")"
jq --arg socketPath "$socket_v2" '. + {socketPath: $socketPath}' \
  "$manifest" > "$manifest.tmp" && mv "$manifest.tmp" "$manifest"
cp "$v2_plist" "$PLIST_DIR/com.flywheel.lead.flywheel-eng-lead.plist"
cat > "$SANDBOX/tmux-private-stub" <<'TMUX'
#!/bin/bash
printf '%s\n' "$*" > "${FLY1663_TMUX_ARGS:?}"
printf '0\tmain\tmain\t0\tclaude\n'
TMUX
chmod +x "$SANDBOX/tmux-private-stub"
TMUX_BIN="$SANDBOX/tmux-private-stub"
export FLY1663_TMUX_ARGS="$SANDBOX/tmux-private.args"
if claude_pane_evidence "flywheel-eng-lead" \
    && grep -qF -- "-S $socket_v2 list-panes -t %0" "$FLY1663_TMUX_ARGS"; then
  pass "C7 daemon runtime evidence follows the canonical v2 private socket"
else
  fail "C7 daemon runtime evidence ignored the v2 private socket"
fi

echo "=================================="
echo "FLY-1663 foundation: ${PASSED} passed, ${FAILED} failed"
[ "$FAILED" -eq 0 ]
