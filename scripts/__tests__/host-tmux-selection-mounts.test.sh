#!/bin/bash
# FLY-2190: real wrapper birth paths mount the converged host tmux gate.
set -uo pipefail

PASSED=0
FAILED=0
pass() { PASSED=$((PASSED + 1)); echo "[TEST] ✓ $1"; }
fail() { FAILED=$((FAILED + 1)); echo "[TEST] ✗ $1"; shift; [ "$#" -eq 0 ] || echo "        $*"; }

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SANDBOX="$(mktemp -d -t fly2190-host-tmux-mounts-XXXXXX)"
trap 'rm -rf "$SANDBOX"' EXIT
SHA="1111111111111111111111111111111111111111"

install_alert_fixture() {
  local root="$1" repo="$2"
  mkdir -p "$repo/scripts/lib"
  cp "$REPO_ROOT/scripts/lib/bounded-run.sh" "$repo/scripts/lib/"
  printf '%s\n' \
    '#!/bin/bash' \
    'printf "%s\n" "$*" >> "${HOST_TMUX_ALERT_CALL:?}"' \
    > "$root/meta-alert.sh"
  chmod +x "$repo/scripts/lib/bounded-run.sh" "$root/meta-alert.sh"
}

# Slice 1: a direct Bridge KeepAlive birth reaches the default converged gate
# and a held gate prevents the Bridge exec target from running.
BRIDGE_ROOT="$SANDBOX/bridge"
BRIDGE_HOME="$BRIDGE_ROOT/home"
BRIDGE_REPO="$BRIDGE_ROOT/repo"
BRIDGE_STATE="$BRIDGE_HOME/.flywheel"
mkdir -p "$BRIDGE_REPO/scripts" "$BRIDGE_STATE/bin" "$BRIDGE_HOME/.local/bin"
cp "$REPO_ROOT/scripts/flywheel-bridge-wrapper.sh" "$BRIDGE_REPO/scripts/"
install_alert_fixture "$BRIDGE_ROOT" "$BRIDGE_REPO"
: > "$BRIDGE_STATE/.env"
printf '%s\n' "$SHA" > "$BRIDGE_STATE/deployed-sha"

printf '%s\n' \
  '#!/bin/bash' \
  'printf "%s|%s|%s|%s|%s\n" "$*" "${FLYWHEEL_HOST_TMUX_TARGET_SHA:-}" "${FLYWHEEL_HOST_TMUX_BOUND_TRANSACTION:-}" "${FLYWHEEL_HOST_TMUX_MOUNT_POINT:-}" "${FLYWHEEL_STATE_DIR:-}" >> "${HOST_TMUX_GATE_CALL:?}"' \
  'case "${1:-}" in' \
  '  gate) exit 0 ;;' \
  '  verify) echo "receipt host does not match current host" >&2; exit 42 ;;' \
  '  *) exit 2 ;;' \
  'esac' \
  > "$BRIDGE_STATE/bin/host-tmux-selection-gate.sh"
chmod +x "$BRIDGE_STATE/bin/host-tmux-selection-gate.sh"

printf '%s\n' '#!/bin/bash' 'echo npx >> "${EXEC_CALLS:?}"' 'exit 0' \
  > "$BRIDGE_HOME/.local/bin/npx"
chmod +x "$BRIDGE_HOME/.local/bin/npx"
: > "$BRIDGE_ROOT/exec-calls"

BRIDGE_RC=0
env -i \
  HOME="$BRIDGE_HOME" \
  PATH="/usr/bin:/bin" \
  FLYWHEEL_DIR="$BRIDGE_REPO" \
  FLYWHEEL_STATE_DIR="$BRIDGE_STATE" \
  HOST_TMUX_GATE_CALL="$BRIDGE_ROOT/gate-call" \
  HOST_TMUX_ALERT_CALL="$BRIDGE_ROOT/alert-call" \
  FLYWHEEL_META_ALERT_BIN="$BRIDGE_ROOT/meta-alert.sh" \
  EXEC_CALLS="$BRIDGE_ROOT/exec-calls" \
  bash "$BRIDGE_REPO/scripts/flywheel-bridge-wrapper.sh" \
  > "$BRIDGE_ROOT/out.log" 2>&1 || BRIDGE_RC=$?

if [ "$BRIDGE_RC" -eq 0 ] \
  && grep -Fqx "gate bridge|$SHA|keepalive:bridge|scripts/flywheel-bridge-wrapper.sh|$BRIDGE_STATE" "$BRIDGE_ROOT/gate-call" \
  && grep -Fqx "verify bridge|$SHA|keepalive:bridge|scripts/flywheel-bridge-wrapper.sh|$BRIDGE_STATE" "$BRIDGE_ROOT/gate-call" \
  && grep -Fq 'host_tmux_selection_gate_unavailable_bridge' "$BRIDGE_ROOT/alert-call" \
  && [ ! -s "$BRIDGE_ROOT/exec-calls" ]; then
  pass "Bridge KeepAlive birth refuses exec when receipt host verification fails"
else
  fail "Bridge host-mismatch refusal (rc=$BRIDGE_RC gate=$(cat "$BRIDGE_ROOT/gate-call" 2>/dev/null) exec=$(cat "$BRIDGE_ROOT/exec-calls" 2>/dev/null))" \
    "$(tail -20 "$BRIDGE_ROOT/out.log")"
fi

# The remaining carrier classes use a receipt-verification failure to isolate
# their birth-path mount without running carrier-specific prerequisites.
printf '%s\n' \
  '#!/bin/bash' \
  'printf "%s|%s|%s|%s|%s\n" "$*" "${FLYWHEEL_HOST_TMUX_TARGET_SHA:-}" "${FLYWHEEL_HOST_TMUX_BOUND_TRANSACTION:-}" "${FLYWHEEL_HOST_TMUX_MOUNT_POINT:-}" "${FLYWHEEL_STATE_DIR:-}" >> "${HOST_TMUX_GATE_CALL:?}"' \
  'case "${1:-}" in' \
  '  gate) exit 0 ;;' \
  '  verify) echo "receipt host does not match current host" >&2; exit 42 ;;' \
  '  *) exit 2 ;;' \
  'esac' \
  > "$BRIDGE_STATE/bin/host-tmux-selection-gate.sh"
chmod +x "$BRIDGE_STATE/bin/host-tmux-selection-gate.sh"

# Slice 2: voice-bridge has an independent KeepAlive birth and must make the
# same decision before its health-port preflight or exec target.
VOICE_ROOT="$SANDBOX/voice"
VOICE_HOME="$VOICE_ROOT/home"
VOICE_REPO="$VOICE_ROOT/repo"
VOICE_STATE="$VOICE_HOME/.flywheel"
mkdir -p "$VOICE_REPO/scripts" "$VOICE_STATE/bin" "$VOICE_HOME/.local/bin"
cp "$REPO_ROOT/scripts/flywheel-voice-bridge-wrapper.sh" "$VOICE_REPO/scripts/"
install_alert_fixture "$VOICE_ROOT" "$VOICE_REPO"
: > "$VOICE_STATE/.env"
printf '%s\n' "$SHA" > "$VOICE_STATE/deployed-sha"
cp "$BRIDGE_STATE/bin/host-tmux-selection-gate.sh" "$VOICE_STATE/bin/"
printf '%s\n' '#!/bin/bash' 'echo npx >> "${EXEC_CALLS:?}"' 'exit 0' \
  > "$VOICE_HOME/.local/bin/npx"
chmod +x "$VOICE_HOME/.local/bin/npx"
: > "$VOICE_ROOT/exec-calls"

VOICE_RC=0
env -i \
  HOME="$VOICE_HOME" \
  PATH="/usr/bin:/bin" \
  FLYWHEEL_DIR="$VOICE_REPO" \
  FLYWHEEL_STATE_DIR="$VOICE_STATE" \
  HOST_TMUX_GATE_CALL="$VOICE_ROOT/gate-call" \
  HOST_TMUX_ALERT_CALL="$VOICE_ROOT/alert-call" \
  FLYWHEEL_META_ALERT_BIN="$VOICE_ROOT/meta-alert.sh" \
  EXEC_CALLS="$VOICE_ROOT/exec-calls" \
  bash "$VOICE_REPO/scripts/flywheel-voice-bridge-wrapper.sh" \
  > "$VOICE_ROOT/out.log" 2>&1 || VOICE_RC=$?

if [ "$VOICE_RC" -eq 0 ] \
  && grep -Fqx "gate voice-bridge|$SHA|keepalive:voice-bridge|scripts/flywheel-voice-bridge-wrapper.sh|$VOICE_STATE" "$VOICE_ROOT/gate-call" \
  && grep -Fqx "verify voice-bridge|$SHA|keepalive:voice-bridge|scripts/flywheel-voice-bridge-wrapper.sh|$VOICE_STATE" "$VOICE_ROOT/gate-call" \
  && grep -Fq 'host_tmux_selection_gate_unavailable_voice-bridge' "$VOICE_ROOT/alert-call" \
  && [ ! -s "$VOICE_ROOT/exec-calls" ]; then
  pass "voice-bridge KeepAlive birth verifies the receipt before exec"
else
  fail "voice-bridge gate mount (rc=$VOICE_RC gate=$(cat "$VOICE_ROOT/gate-call" 2>/dev/null) exec=$(cat "$VOICE_ROOT/exec-calls" 2>/dev/null))" \
    "$(tail -20 "$VOICE_ROOT/out.log")"
fi

# Slice 3: quota-monitor is another direct launchd supervisor class. The host
# gate must run before quota-specific config/artifact validation.
QUOTA_ROOT="$SANDBOX/quota"
QUOTA_HOME="$QUOTA_ROOT/home"
QUOTA_REPO="$QUOTA_ROOT/repo"
QUOTA_STATE="$QUOTA_HOME/.flywheel"
mkdir -p "$QUOTA_REPO/scripts" "$QUOTA_STATE/bin"
cp "$REPO_ROOT/scripts/flywheel-quota-monitor-wrapper.sh" "$QUOTA_REPO/scripts/"
install_alert_fixture "$QUOTA_ROOT" "$QUOTA_REPO"
: > "$QUOTA_STATE/.env"
printf '%s\n' "$SHA" > "$QUOTA_STATE/deployed-sha"
cp "$BRIDGE_STATE/bin/host-tmux-selection-gate.sh" "$QUOTA_STATE/bin/"

QUOTA_RC=0
env -i \
  HOME="$QUOTA_HOME" \
  PATH="/usr/bin:/bin" \
  FLYWHEEL_DIR="$QUOTA_REPO" \
  FLYWHEEL_STATE_DIR="$QUOTA_STATE" \
  HOST_TMUX_GATE_CALL="$QUOTA_ROOT/gate-call" \
  HOST_TMUX_ALERT_CALL="$QUOTA_ROOT/alert-call" \
  FLYWHEEL_META_ALERT_BIN="$QUOTA_ROOT/meta-alert.sh" \
  bash "$QUOTA_REPO/scripts/flywheel-quota-monitor-wrapper.sh" \
  > "$QUOTA_ROOT/out.log" 2>&1 || QUOTA_RC=$?

if [ "$QUOTA_RC" -eq 0 ] \
  && grep -Fqx "gate quota-monitor|$SHA|keepalive:quota-monitor|scripts/flywheel-quota-monitor-wrapper.sh|$QUOTA_STATE" "$QUOTA_ROOT/gate-call" \
  && grep -Fqx "verify quota-monitor|$SHA|keepalive:quota-monitor|scripts/flywheel-quota-monitor-wrapper.sh|$QUOTA_STATE" "$QUOTA_ROOT/gate-call" \
  && grep -Fq 'host_tmux_selection_gate_unavailable_quota-monitor' "$QUOTA_ROOT/alert-call"; then
  pass "quota-monitor KeepAlive birth verifies the receipt before config validation"
else
  fail "quota-monitor gate mount (rc=$QUOTA_RC gate=$(cat "$QUOTA_ROOT/gate-call" 2>/dev/null))" \
    "$(tail -20 "$QUOTA_ROOT/out.log")"
fi

# Slice 4: the generic Claude Lead carrier must gate every launchd-owned tmux
# server birth before manifest identity resolution can reach tmux selection.
LEAD_ROOT="$SANDBOX/lead"
LEAD_HOME="$LEAD_ROOT/home"
LEAD_REPO="$LEAD_ROOT/repo"
LEAD_STATE="$LEAD_HOME/.flywheel"
mkdir -p "$LEAD_REPO/scripts/lib" "$LEAD_STATE/bin"
cp "$REPO_ROOT/scripts/flywheel-lead-wrapper-v2.sh" "$LEAD_REPO/scripts/"
install_alert_fixture "$LEAD_ROOT" "$LEAD_REPO"
cp "$REPO_ROOT/scripts/lib/lead-address.sh" "$LEAD_REPO/scripts/lib/"
: > "$LEAD_STATE/.env"
printf '%s\n' "$SHA" > "$LEAD_STATE/deployed-sha"
cp "$BRIDGE_STATE/bin/host-tmux-selection-gate.sh" "$LEAD_STATE/bin/"
printf '%s\n' '{}' > "$LEAD_ROOT/manifest.json"

LEAD_RC=0
env -i \
  HOME="$LEAD_HOME" \
  PATH="/usr/bin:/bin" \
  FLYWHEEL_DIR="$LEAD_REPO" \
  FLYWHEEL_STATE_DIR="$LEAD_STATE" \
  HOST_TMUX_GATE_CALL="$LEAD_ROOT/gate-call" \
  HOST_TMUX_ALERT_CALL="$LEAD_ROOT/alert-call" \
  FLYWHEEL_META_ALERT_BIN="$LEAD_ROOT/meta-alert.sh" \
  bash "$LEAD_REPO/scripts/flywheel-lead-wrapper-v2.sh" "$LEAD_ROOT/manifest.json" \
  > "$LEAD_ROOT/out.log" 2>&1 || LEAD_RC=$?

if [ "$LEAD_RC" -eq 0 ] \
  && grep -Fqx "gate lead|$SHA|keepalive:lead|scripts/flywheel-lead-wrapper-v2.sh|$LEAD_STATE" "$LEAD_ROOT/gate-call" \
  && grep -Fqx "verify lead|$SHA|keepalive:lead|scripts/flywheel-lead-wrapper-v2.sh|$LEAD_STATE" "$LEAD_ROOT/gate-call" \
  && grep -Fq 'host_tmux_selection_gate_unavailable_lead' "$LEAD_ROOT/alert-call"; then
  pass "generic Lead KeepAlive birth verifies the receipt before tmux selection"
else
  fail "generic Lead gate mount (rc=$LEAD_RC gate=$(cat "$LEAD_ROOT/gate-call" 2>/dev/null))" \
    "$(tail -20 "$LEAD_ROOT/out.log")"
fi

# Slice 5: Mufasa's production plist selects a distinct full-access Codex
# wrapper. Its exact carrier shape must be source-controlled and independently
# gated; the generic Lead wrapper cannot stand in for this birth path.
MUFASA_ROOT="$SANDBOX/mufasa"
MUFASA_HOME="$MUFASA_ROOT/home"
MUFASA_REPO="$MUFASA_ROOT/repo"
MUFASA_STATE="$MUFASA_HOME/.flywheel"
MUFASA_WRAPPER="$REPO_ROOT/scripts/flywheel-codex-lead-wrapper-mufasa-tui-fullaccess.sh"
mkdir -p "$MUFASA_REPO" "$MUFASA_STATE/bin"
install_alert_fixture "$MUFASA_ROOT" "$MUFASA_REPO"
: > "$MUFASA_STATE/.env"
printf '%s\n' "$SHA" > "$MUFASA_STATE/deployed-sha"
cp "$BRIDGE_STATE/bin/host-tmux-selection-gate.sh" "$MUFASA_STATE/bin/"

MUFASA_RC=0
env -i \
  HOME="$MUFASA_HOME" \
  PATH="/usr/bin:/bin" \
  FLYWHEEL_DIR="$MUFASA_REPO" \
  FLYWHEEL_STATE_DIR="$MUFASA_STATE" \
  HOST_TMUX_GATE_CALL="$MUFASA_ROOT/gate-call" \
  HOST_TMUX_ALERT_CALL="$MUFASA_ROOT/alert-call" \
  FLYWHEEL_META_ALERT_BIN="$MUFASA_ROOT/meta-alert.sh" \
  bash "$MUFASA_WRAPPER" > "$MUFASA_ROOT/out.log" 2>&1 || MUFASA_RC=$?

if [ "$MUFASA_RC" -eq 0 ] \
  && grep -Fqx "gate codex-mufasa|$SHA|keepalive:codex-mufasa|scripts/flywheel-codex-lead-wrapper-mufasa-tui-fullaccess.sh|$MUFASA_STATE" "$MUFASA_ROOT/gate-call" \
  && grep -Fqx "verify codex-mufasa|$SHA|keepalive:codex-mufasa|scripts/flywheel-codex-lead-wrapper-mufasa-tui-fullaccess.sh|$MUFASA_STATE" "$MUFASA_ROOT/gate-call" \
  && grep -Fq 'host_tmux_selection_gate_unavailable_codex-mufasa' "$MUFASA_ROOT/alert-call"; then
  pass "Mufasa Codex KeepAlive birth is source-controlled and verifies the receipt"
else
  fail "Mufasa Codex gate mount (rc=$MUFASA_RC gate=$(cat "$MUFASA_ROOT/gate-call" 2>/dev/null))" \
    "$(tail -20 "$MUFASA_ROOT/out.log" 2>/dev/null)"
fi

# Slice 6: Raya's production plist selects a fixed resident Codex wrapper.
RAYA_ROOT="$SANDBOX/raya"
RAYA_HOME="$RAYA_ROOT/home"
RAYA_REPO="$RAYA_ROOT/repo"
RAYA_STATE="$RAYA_HOME/.flywheel"
RAYA_WRAPPER="$REPO_ROOT/scripts/flywheel-codex-lead-wrapper-raya-tui-fullaccess.sh"
mkdir -p "$RAYA_REPO" "$RAYA_STATE/bin"
install_alert_fixture "$RAYA_ROOT" "$RAYA_REPO"
: > "$RAYA_STATE/.env"
printf '%s\n' "$SHA" > "$RAYA_STATE/deployed-sha"
cp "$BRIDGE_STATE/bin/host-tmux-selection-gate.sh" "$RAYA_STATE/bin/"

RAYA_RC=0
env -i \
  HOME="$RAYA_HOME" \
  PATH="/usr/bin:/bin" \
  FLYWHEEL_DIR="$RAYA_REPO" \
  FLYWHEEL_STATE_DIR="$RAYA_STATE" \
  HOST_TMUX_GATE_CALL="$RAYA_ROOT/gate-call" \
  HOST_TMUX_ALERT_CALL="$RAYA_ROOT/alert-call" \
  FLYWHEEL_META_ALERT_BIN="$RAYA_ROOT/meta-alert.sh" \
  bash "$RAYA_WRAPPER" > "$RAYA_ROOT/out.log" 2>&1 || RAYA_RC=$?

if [ "$RAYA_RC" -eq 0 ] \
  && grep -Fqx "gate codex-raya|$SHA|keepalive:codex-raya|scripts/flywheel-codex-lead-wrapper-raya-tui-fullaccess.sh|$RAYA_STATE" "$RAYA_ROOT/gate-call" \
  && grep -Fqx "verify codex-raya|$SHA|keepalive:codex-raya|scripts/flywheel-codex-lead-wrapper-raya-tui-fullaccess.sh|$RAYA_STATE" "$RAYA_ROOT/gate-call" \
  && grep -Fq 'host_tmux_selection_gate_unavailable_codex-raya' "$RAYA_ROOT/alert-call"; then
  pass "Raya resident Codex KeepAlive birth is source-controlled and verifies the receipt"
else
  fail "Raya Codex gate mount (rc=$RAYA_RC gate=$(cat "$RAYA_ROOT/gate-call" 2>/dev/null))" \
    "$(tail -20 "$RAYA_ROOT/out.log" 2>/dev/null)"
fi

# Slice 7: InfraBot's production plist selects another distinct Codex wrapper.
INFRA_ROOT="$SANDBOX/infra"
INFRA_HOME="$INFRA_ROOT/home"
INFRA_REPO="$INFRA_ROOT/repo"
INFRA_STATE="$INFRA_HOME/.flywheel"
INFRA_WRAPPER="$REPO_ROOT/scripts/flywheel-codex-lead-wrapper-codex-infra-bot.sh"
mkdir -p "$INFRA_REPO" "$INFRA_STATE/bin"
install_alert_fixture "$INFRA_ROOT" "$INFRA_REPO"
: > "$INFRA_STATE/.env"
printf '%s\n' "$SHA" > "$INFRA_STATE/deployed-sha"
cp "$BRIDGE_STATE/bin/host-tmux-selection-gate.sh" "$INFRA_STATE/bin/"

INFRA_RC=0
env -i \
  HOME="$INFRA_HOME" \
  PATH="/usr/bin:/bin" \
  FLYWHEEL_DIR="$INFRA_REPO" \
  FLYWHEEL_STATE_DIR="$INFRA_STATE" \
  HOST_TMUX_GATE_CALL="$INFRA_ROOT/gate-call" \
  HOST_TMUX_ALERT_CALL="$INFRA_ROOT/alert-call" \
  FLYWHEEL_META_ALERT_BIN="$INFRA_ROOT/meta-alert.sh" \
  bash "$INFRA_WRAPPER" > "$INFRA_ROOT/out.log" 2>&1 || INFRA_RC=$?

if [ "$INFRA_RC" -eq 0 ] \
  && grep -Fqx "gate codex-infra-bot|$SHA|keepalive:codex-infra-bot|scripts/flywheel-codex-lead-wrapper-codex-infra-bot.sh|$INFRA_STATE" "$INFRA_ROOT/gate-call" \
  && grep -Fqx "verify codex-infra-bot|$SHA|keepalive:codex-infra-bot|scripts/flywheel-codex-lead-wrapper-codex-infra-bot.sh|$INFRA_STATE" "$INFRA_ROOT/gate-call" \
  && grep -Fq 'host_tmux_selection_gate_unavailable_codex-infra-bot' "$INFRA_ROOT/alert-call"; then
  pass "InfraBot Codex KeepAlive birth is source-controlled and verifies the receipt"
else
  fail "InfraBot Codex gate mount (rc=$INFRA_RC gate=$(cat "$INFRA_ROOT/gate-call" 2>/dev/null))" \
    "$(tail -20 "$INFRA_ROOT/out.log" 2>/dev/null)"
fi

# Slice 8: first packaged birth happens before converge has populated state-bin.
# A carrier must use the gate in its installed runtime tree, and a prebuilt tree
# with no .git/deployed-sha must bind the immutable package build identity.
FALLBACK_ROOT="$SANDBOX/prebuilt-fallback"
FALLBACK_HOME="$FALLBACK_ROOT/home"
FALLBACK_REPO="$FALLBACK_ROOT/runtime"
FALLBACK_STATE="$FALLBACK_HOME/.flywheel"
FALLBACK_SHA="2222222222222222222222222222222222222222"
mkdir -p \
  "$FALLBACK_REPO/scripts" \
  "$FALLBACK_REPO/packages/teamlead/scripts" \
  "$FALLBACK_STATE/bin"
: > "$FALLBACK_STATE/.env"
printf '%s\n' '1.0.0-test' > "$FALLBACK_REPO/.flywheel-prebuilt"
printf '%s\n' "$FALLBACK_SHA" > "$FALLBACK_REPO/.flywheel-build-sha"
printf '%s\n' \
  '#!/bin/bash' \
  'printf "%s|%s|%s\n" "$*" "${FLYWHEEL_HOST_TMUX_TARGET_SHA:-}" "${FLYWHEEL_STATE_DIR:-}" >> "${HOST_TMUX_GATE_CALL:?}"' \
  'exit 0' \
  > "$FALLBACK_REPO/scripts/host-tmux-selection-gate.sh"
chmod +x "$FALLBACK_REPO/scripts/host-tmux-selection-gate.sh"
printf '%s\n' \
  '#!/bin/bash' \
  'printf "started\n" > "${CARRIER_STARTED:?}"' \
  > "$FALLBACK_REPO/packages/teamlead/scripts/run-codex-infra-bot-tui.sh"
chmod +x "$FALLBACK_REPO/packages/teamlead/scripts/run-codex-infra-bot-tui.sh"

FALLBACK_RC=0
env -i \
  HOME="$FALLBACK_HOME" \
  PATH="/usr/bin:/bin" \
  FLYWHEEL_DIR="$FALLBACK_REPO" \
  FLYWHEEL_STATE_DIR="$FALLBACK_STATE" \
  HOST_TMUX_GATE_CALL="$FALLBACK_ROOT/gate-call" \
  CARRIER_STARTED="$FALLBACK_ROOT/carrier-started" \
  bash "$INFRA_WRAPPER" > "$FALLBACK_ROOT/out.log" 2>&1 || FALLBACK_RC=$?

FALLBACK_DECLARATIONS=0
for wrapper in \
  scripts/flywheel-bridge-wrapper.sh \
  scripts/flywheel-quota-monitor-wrapper.sh \
  scripts/flywheel-lead-wrapper-v2.sh \
  scripts/flywheel-voice-bridge-wrapper.sh \
  scripts/flywheel-codex-lead-wrapper-mufasa-tui-fullaccess.sh \
  scripts/flywheel-codex-lead-wrapper-raya-tui-fullaccess.sh \
  scripts/flywheel-codex-lead-wrapper-codex-infra-bot.sh; do
  grep -Fq '${FLYWHEEL_DIR}/scripts/host-tmux-selection-gate.sh' \
    "$REPO_ROOT/$wrapper" && FALLBACK_DECLARATIONS=$((FALLBACK_DECLARATIONS + 1))
done
if [ "$FALLBACK_RC" -eq 0 ] \
  && [ "$FALLBACK_DECLARATIONS" -eq 7 ] \
  && [ ! -e "$FALLBACK_STATE/bin/host-tmux-selection-gate.sh" ] \
  && grep -Fqx "gate codex-infra-bot|$FALLBACK_SHA|$FALLBACK_STATE" \
    "$FALLBACK_ROOT/gate-call" \
  && grep -Fqx "verify codex-infra-bot|$FALLBACK_SHA|$FALLBACK_STATE" \
    "$FALLBACK_ROOT/gate-call" \
  && grep -Fqx 'started' "$FALLBACK_ROOT/carrier-started"; then
  pass "prebuilt carrier first birth uses checkout gate and packaged SHA before state-bin convergence"
else
  fail "prebuilt first-birth fallback failed (rc=$FALLBACK_RC declarations=$FALLBACK_DECLARATIONS)" \
    "$(tail -30 "$FALLBACK_ROOT/out.log" 2>/dev/null)"
fi

echo ""
echo "host-tmux-selection-mounts: PASSED=$PASSED FAILED=$FAILED"
[ "$FAILED" -eq 0 ] || exit 1
