#!/usr/bin/env bash
# FLY-1663 foundation contracts: deterministic per-Lead sockets and
# v2-only launchd carrier. This suite is hermetic and never calls launchctl.
set -uo pipefail

PASSED=0
FAILED=0
pass() { PASSED=$((PASSED + 1)); echo "[TEST] ✓ $1"; }
fail() { FAILED=$((FAILED + 1)); echo "[TEST] ✗ $1"; }

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SANDBOX="$(mktemp -d /tmp/f1663-f.XXXXXX)"
SHORT_STATE="$SANDBOX/s"
trap 'rm -rf "$SANDBOX"' EXIT

export HOME="$SANDBOX/home"
export FLYWHEEL_STATE_DIR="$HOME/.flywheel"
export FLYWHEEL_DIR="$REPO_ROOT"
mkdir -p "$FLYWHEEL_STATE_DIR/manifests" "$FLYWHEEL_STATE_DIR/bin" \
  "$HOME/Library/LaunchAgents" "$SHORT_STATE"

assert_sandbox_write_path() {
  local path="$1"
  case "$path" in
    "$SANDBOX"|"$SANDBOX"/*) return 0 ;;
    *)
      echo "[TEST] FATAL: writable test path escaped sandbox: $path" >&2
      exit 99
      ;;
  esac
}

# shellcheck source=../lib/lead-address.sh
source "$REPO_ROOT/scripts/lib/lead-address.sh"

# GNU stat accepts -f as a filesystem-report flag and exits zero, so a
# Darwin-first fallback silently returns prose instead of uid/mode on Linux.
stat() {
  case "${1:-}:${2:-}" in
    -c:%u) printf '1234\n' ;;
    -c:%a) printf '700\n' ;;
    -f:*) printf 'GNU filesystem report that must not be parsed\n' ;;
    *) return 1 ;;
  esac
}
gnu_uid="$(_lead_socket_stat_uid /unused)"
gnu_mode="$(_lead_socket_stat_mode /unused)"
unset -f stat
if [ "$gnu_uid" = 1234 ] && [ "$gnu_mode" = 700 ]; then
  pass "S0 GNU stat uses explicit field output instead of filesystem prose"
else
  fail "S0 GNU stat parsing failed: uid=[$gnu_uid] mode=[$gnu_mode]"
fi

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
  && [ "$(_lead_socket_stat_mode "$state_dir/sock")" = "700" ]; then
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

# Plist generation defaults to the immutable v2 wrapper; unknown input fails closed.
export FLYWHEEL_DAEMON_SOURCED=1
PLUTIL_STUB="$SANDBOX/plutil"
printf '#!/bin/bash\nexit 0\n' > "$PLUTIL_STUB"
chmod +x "$PLUTIL_STUB"
export FLYWHEEL_DAEMON_PLUTIL="$PLUTIL_STUB"
# shellcheck source=../flywheel-daemon.sh
source "$REPO_ROOT/scripts/flywheel-daemon.sh"

# Fail before any fixture or generated artifact can touch the resident fleet.
for writable_path in \
  "$HOME" "$FLYWHEEL_STATE_DIR" "$MANIFEST_DIR" "$PLIST_DIR" \
  "$FLYWHEEL_BIN" "$PID_DIR" "$SHORT_STATE"; do
  assert_sandbox_write_path "$writable_path"
done

manifest="$MANIFEST_DIR/flywheel-eng-lead.json"
mkdir -p "$(dirname "$manifest")"
jq -n '{leadId:"eng-lead",projectDir:"/tmp/flywheel",projectName:"flywheel"}' > "$manifest"

v2_plist="$SANDBOX/v2.plist"
generate_plist_to "flywheel-eng-lead" "$manifest" "$manifest" "$v2_plist"
if grep -qF "$FLYWHEEL_BIN/flywheel-lead-wrapper-v2.sh" "$v2_plist"; then
  pass "C1 plist renders the v2 carrier"
else
  fail "C1 plist did not select wrapper-v2"
fi

# The routine daemon install path must remain v2 when projects.json omits the
# retired carrier selector.
jq -n '{projectName:"flywheel",leads:[{agentId:"eng-lead"}]}' \
  | jq -s '.' > "$FLYWHEEL_STATE_DIR/projects.json"
generate_plist "flywheel-eng-lead" "$manifest" >/dev/null
installed_plist="$(plist_path "flywheel-eng-lead")"
if grep -qF "$FLYWHEEL_BIN/flywheel-lead-wrapper-v2.sh" "$installed_plist"; then
  pass "C1b routine plist generation defaults to v2"
else
  fail "C1b routine plist generation did not use v2"
fi

launchctl_state="$SANDBOX/launchctl-state"
launchctl_calls="$SANDBOX/launchctl-calls"
launchctl_stub="$SANDBOX/launchctl-stub"
cat > "$launchctl_stub" <<'STUB'
#!/bin/bash
printf '%s\n' "$*" >> "$FLY1663_LAUNCHCTL_CALLS"
case "$1" in
  print)
    [ -f "$FLY1663_LAUNCHCTL_STATE" ] || exit 1
    echo '    pid = 4242'
    ;;
  bootstrap) touch "$FLY1663_LAUNCHCTL_STATE" ;;
  bootout) rm -f "$FLY1663_LAUNCHCTL_STATE" ;;
esac
STUB
chmod +x "$launchctl_stub"
export FLY1663_LAUNCHCTL_STATE="$launchctl_state"
export FLY1663_LAUNCHCTL_CALLS="$launchctl_calls"
LAUNCHCTL="$launchctl_stub"
rm -f "$installed_plist" "$launchctl_state" "$launchctl_calls"
sleep() { :; }
install_one_manifest "$manifest" >/dev/null
unset -f sleep
if grep -qF "$FLYWHEEL_BIN/flywheel-lead-wrapper-v2.sh" "$installed_plist" \
  && grep -q '^bootstrap ' "$launchctl_calls"; then
  pass "C1c daemon install bootstraps the v2 carrier"
else
  fail "C1c daemon install did not preserve v2"
fi

if ! generate_plist_to "flywheel-eng-lead" "$manifest" "$manifest" "$SANDBOX/bad.plist" "bespoke" >/dev/null 2>&1; then
  pass "C2 unknown carrier fails closed"
else
  fail "C2 unknown carrier was accepted"
fi

ambiguous_plist="$SANDBOX/ambiguous.plist"
cp "$installed_plist" "$ambiguous_plist"
sed -i.bak 's#</dict>#<key>LEGACY_NOTE</key><string>/opt/flywheel-codex-lead-wrapper-mufasa.sh</string></dict>#' "$ambiguous_plist"
rm -f "$ambiguous_plist.bak"
if [ "$(classify_plist_lead_carrier "$ambiguous_plist")" = "unknown" ]; then
  pass "C2b a plist carrying v2 plus a bespoke Codex wrapper reference is ambiguous"
else
  fail "C2b ambiguous wrapper evidence normalized to v2"
fi

FLYWHEEL_DIR="$REPO_ROOT"
install_wrapper >/dev/null
if [ -x "$FLYWHEEL_BIN/flywheel-lead-wrapper-v2.sh" ] \
  && [ -x "$FLYWHEEL_BIN/flywheel-lead-attach.sh" ] \
  && [ -x "$FLYWHEEL_BIN/lib/lead-address.sh" ]; then
  pass "C3 carrier install publishes the v2/display closure"
else
  fail "C3 v2 carrier install closure is incomplete"
fi

relocated_state="$SANDBOX/relocated-state"
jq -n --arg state "$relocated_state" '{stateDir:$state}' > "$HOME/.flywheel/host.json"
fleet_paths="$(
  env -u FLYWHEEL_STATE_DIR -u FLYWHEEL_DIR \
    HOME="$HOME" FLYWHEEL_FLEET_SOURCED=1 \
    bash -c 'source "$1"; printf "%s\n%s\n%s\n" "$PROJECTS_JSON" "$FLEET_BACKUPS" "$LOCK_DIR"' \
    _ "$REPO_ROOT/scripts/flywheel-fleet.sh"
)"
if grep -qxF "$relocated_state/projects.json" <<<"$fleet_paths" \
  && grep -qxF "$relocated_state/fleet-backups" <<<"$fleet_paths" \
  && grep -qxF "$relocated_state/restart.lock.d" <<<"$fleet_paths" \
  && ! grep -qF '${HOME}/.flywheel/projects.json' "$REPO_ROOT/scripts/flywheel-daemon.sh"; then
  pass "C3b fleet and daemon share the relocated state root"
else
  fail "C3b split state-root paths: $fleet_paths"
fi

invalid_home="$SANDBOX/invalid-host-home"
mkdir -p "$invalid_home/.flywheel"
printf '{not-json\n' > "$invalid_home/.flywheel/host.json"
if invalid_source_out="$(
    env -u FLYWHEEL_STATE_DIR -u FLYWHEEL_DIR \
      HOME="$invalid_home" FLYWHEEL_FLEET_SOURCED=1 \
      bash -c 'source "$1"' _ "$REPO_ROOT/scripts/flywheel-fleet.sh" 2>&1
  )"; then
  invalid_source_rc=0
else
  invalid_source_rc=$?
fi
if [ "$invalid_source_rc" -ne 0 ] \
  && grep -qF 'daemon helpers failed to load' <<<"$invalid_source_out" \
  && ! grep -qF 'command not found' <<<"$invalid_source_out"; then
  pass "C3c fleet fails once and clearly when daemon host config is invalid"
else
  fail "C3c invalid host config left a partial daemon source: rc=$invalid_source_rc $invalid_source_out"
fi

manifest_without_env="$SANDBOX/manifest-without-env.json"
manifest_with_env="$SANDBOX/manifest-with-env.json"
jq 'del(.launchEnvironment)' "$manifest" > "$manifest_without_env"
jq '.launchEnvironment = {FLYWHEEL_LEAD_ROLE:"cos"}' "$manifest" > "$manifest_with_env"
projection_without_env="$(
  FLYWHEEL_FLEET_SOURCED=1 bash -c \
    'source "$1"; manifest_projection_sha "$2"' \
    _ "$REPO_ROOT/scripts/flywheel-fleet.sh" "$manifest_without_env"
)"
projection_with_env="$(
  FLYWHEEL_FLEET_SOURCED=1 bash -c \
    'source "$1"; manifest_projection_sha "$2"' \
    _ "$REPO_ROOT/scripts/flywheel-fleet.sh" "$manifest_with_env"
)"
if [ "$projection_without_env" != "$projection_with_env" ]; then
  pass "C3d rollback CAS includes the launch environment"
else
  fail "C3d launchEnvironment mutation was invisible to rollback CAS"
fi

# restart-services must recognize v2 authority and use only launchd's native
# replacement path; an unowned manifest can never spawn an orphan body.
# shellcheck source=../lib/lead-restart-lifecycle.sh
source "$REPO_ROOT/scripts/lib/lead-restart-lifecycle.sh"
projects="$SANDBOX/projects.json"
jq -n '{projectName:"flywheel",leads:[{agentId:"eng-lead"}]}' \
  | jq -s '.' > "$projects"
if lead_restart_validate_authority \
    "$manifest" "$v2_plist" "$projects" "com.flywheel.lead.flywheel-eng-lead" \
    && [ "$LEAD_RESTART_BACKEND" = "claude-code" ]; then
  pass "C4 restart authority recognizes the canonical v2 carrier"
else
  fail "C4 v2 restart authority rejected"
fi

restart_block="$(sed -n '/^restart_lead()/,/^}/p' "$REPO_ROOT/scripts/restart-services.sh")"
if grep -q '\[\[ "\$backend" == "claude-code" \]\]' <<< "$restart_block" \
    && grep -q 'launchctl kickstart -k' <<< "$restart_block" \
    && ! grep -qE 'nohup env|Legacy path: manual nohup' <<< "$restart_block"; then
  pass "C5 Lead restart has a native v2 path and no orphan fallback"
else
  fail "C5 Lead restart still carries a manual body creation path"
fi

ci="$REPO_ROOT/.github/workflows/ci.yml"
ci_ok=true
for suite in fly1663-launchd-foundation.test.sh fly1663-lead-v2-runtime.test.sh \
  fly1663-cmux-v2.test.sh fly1663-bridge-launchd.test.sh fly1663-qa-launchd.test.sh; do
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
