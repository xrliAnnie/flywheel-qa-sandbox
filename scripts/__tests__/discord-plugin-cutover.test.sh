#!/usr/bin/env bash
# FLY-1676: hermetic stop-all pointer cutover and reverse-transaction tests.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CUTOVER="$REPO_ROOT/scripts/discord-plugin/cutover-discord-plugin.sh"
PASSED=0
FAILED=0
TARGET_SHA="2222222222222222222222222222222222222222"
KNOWN_SHA="1111111111111111111111111111111111111111"

pass() { PASSED=$((PASSED + 1)); printf '[TEST] ✓ %s\n' "$1"; }
fail() { FAILED=$((FAILED + 1)); printf '[TEST] ✗ %s\n' "$1" >&2; }

if [[ ! -x "$CUTOVER" ]]; then
  fail "cutover script exists and is executable"
  printf '\nResults: %d passed, %d failed\n' "$PASSED" "$FAILED"
  exit 1
fi
pass "cutover script exists and is executable"

# Exercise the real preflight function against a production-shaped filesystem.
# Adapter-root evidence alone false-greens when Claude starts the MCP process
# but rejects the plugin at its channel allowlist. The stopped-fleet gate must
# therefore pin both the development-channel selector and FLY-1679's v2
# auto-confirm wiring before any Lead is allowed to start.
PREFLIGHT_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/fly1676-cutover-preflight.XXXXXX")"
PREFLIGHT_FUNCTION="$PREFLIGHT_ROOT/preflight-pointer.sh"
: > "$PREFLIGHT_FUNCTION"
for function_name in pointer_launcher_contract preflight_pointer; do
  awk -v signature="${function_name}() {" '
    $0 == signature { in_function = 1 }
    in_function { print }
    in_function && /^}$/ { exit }
  ' "$CUTOVER" >> "$PREFLIGHT_FUNCTION"
done

PREFLIGHT_HOME="$PREFLIGHT_ROOT/home"
PREFLIGHT_REPO="$PREFLIGHT_ROOT/repo"
PREFLIGHT_SOURCE_BIN="$PREFLIGHT_REPO/scripts/discord-plugin"
PREFLIGHT_LIVE_BIN="$PREFLIGHT_HOME/.flywheel/bin"
PREFLIGHT_INSTALL_PATH="$PREFLIGHT_HOME/.claude/plugins/cache/flywheel-plugins/discord/0.0.5"
PREFLIGHT_LAUNCHER="$PREFLIGHT_REPO/packages/teamlead/scripts/claude-lead.sh"
PREFLIGHT_SETTINGS="$PREFLIGHT_HOME/.claude/settings.json"
mkdir -p "$PREFLIGHT_SOURCE_BIN" "$PREFLIGHT_LIVE_BIN" \
  "$PREFLIGHT_INSTALL_PATH" "$(dirname "$PREFLIGHT_LAUNCHER")"
for script in check-discord-plugin.sh update-discord-plugin.sh \
    check-discord-plugin-legacy-overlay.sh update-discord-plugin-legacy-overlay.sh; do
  cat > "$PREFLIGHT_SOURCE_BIN/$script" <<'EOF'
#!/usr/bin/env bash
if [[ "${1:-}" == --print-install-path ]]; then
  printf '%s\n' "${PREFLIGHT_INSTALL_PATH}"
fi
exit 0
EOF
  cp "$PREFLIGHT_SOURCE_BIN/$script" "$PREFLIGHT_LIVE_BIN/$script"
  chmod +x "$PREFLIGHT_SOURCE_BIN/$script" "$PREFLIGHT_LIVE_BIN/$script"
done
jq -n '{enabledPlugins:{"discord@claude-plugins-official":false,"discord@flywheel-plugins":true}}' \
  > "$PREFLIGHT_SETTINGS"

run_real_preflight() {
  env HOME="$PREFLIGHT_HOME" \
    REPO="$PREFLIGHT_REPO" \
    CHECKER="$PREFLIGHT_LIVE_BIN/check-discord-plugin.sh" \
    SETTINGS="$PREFLIGHT_SETTINGS" \
    PREFLIGHT_INSTALL_PATH="$PREFLIGHT_INSTALL_PATH" \
    bash -c 'set -euo pipefail; source "$1"; preflight_pointer' \
      _ "$PREFLIGHT_FUNCTION"
}

cat > "$PREFLIGHT_LAUNCHER" <<'EOF'
CLAUDE_ARGS+=(--channels "plugin:discord@flywheel-plugins")
_poll_dev_channels_dialog_v2 "$FLYWHEEL_DIALOG_TIMEOUT_SEC" &
EOF
if run_real_preflight >/dev/null 2>&1; then
  fail "preflight rejects the approved-channel selector that Claude silently skips"
else
  pass "preflight rejects the approved-channel selector that Claude silently skips"
fi

cat > "$PREFLIGHT_LAUNCHER" <<'EOF'
CLAUDE_ARGS+=(--dangerously-load-development-channels "plugin:discord@flywheel-plugins")
EOF
if run_real_preflight >/dev/null 2>&1; then
  fail "preflight requires FLY-1679 v2 cold-start auto-confirm wiring"
else
  pass "preflight requires FLY-1679 v2 cold-start auto-confirm wiring"
fi

cat > "$PREFLIGHT_LAUNCHER" <<'EOF'
CLAUDE_ARGS+=(--dangerously-load-development-channels "plugin:discord@flywheel-plugins")
if [ "$INBOX_MCP_ENABLED" = "true" ]; then
  _poll_dev_channels_dialog_v2 "$FLYWHEEL_DIALOG_TIMEOUT_SEC" &
fi
EOF
if run_real_preflight >/dev/null 2>&1; then
  fail "preflight rejects FLY-1679 wiring gated off for inbox-disabled Leads"
else
  pass "preflight rejects FLY-1679 wiring gated off for inbox-disabled Leads"
fi

cat > "$PREFLIGHT_LAUNCHER" <<'EOF'
CLAUDE_ARGS+=(--dangerously-load-development-channels "plugin:discord@flywheel-plugins")
_poll_dev_channels_dialog_v2 "$FLYWHEEL_DIALOG_TIMEOUT_SEC" &
EOF
if output="$(run_real_preflight 2>/dev/null)" \
    && [[ "$output" == "$PREFLIGHT_INSTALL_PATH" ]]; then
  pass "preflight admits the development-channel selector only with FLY-1679 wiring"
else
  fail "preflight admits the development-channel selector only with FLY-1679 wiring"
fi

SEAM_PROBE="$(mktemp -d "${TMPDIR:-/tmp}/fly1676-cutover-seam-probe.XXXXXX")"
if output="$(env HOME="$SEAM_PROBE" \
    FLYWHEEL_DISCORD_CUTOVER_AUTHORIZED=1 \
    FLYWHEEL_DISCORD_CUTOVER_FAIL_AT=deploy \
    bash "$CUTOVER" apply --target-sha "$TARGET_SHA" --known-good-sha "$KNOWN_SHA" 2>&1)"; then
  fail "production mode rejects hermetic mutation seams"
elif [[ "$output" == *"FLYWHEEL_DISCORD_CUTOVER_FAIL_AT is a hermetic-test seam"* ]] \
    && [[ ! -e "$SEAM_PROBE/.flywheel/restart.lock.d" ]]; then
  pass "production mode rejects hermetic mutation seams before acquiring the fleet lock"
else
  fail "production mode rejects hermetic mutation seams before acquiring the fleet lock"
fi

make_fixture() {
  local sb="$1" home bin state
  home="$sb/home"
  bin="$sb/bin"
  state="$sb/launch-state"
  mkdir -p "$home/.flywheel/bin" "$home/.flywheel/manifests" \
    "$home/.claude/plugins" "$home/Library/LaunchAgents" "$bin"
  jq -n '{enabledPlugins:{"discord@claude-plugins-official":true}}' \
    > "$home/.claude/settings.json"
  for pair in "flywheel:eng-lead" "growth:growth-lead"; do
    project="${pair%%:*}"; lead="${pair#*:}"
    label="com.flywheel.lead.${project}-${lead}"
    jq -n --arg p "$project" --arg l "$lead" \
      '{projectName:$p,leadId:$l,leadBackend:{backendId:"claude-code"}}' \
      > "$home/.flywheel/manifests/${project}-${lead}.json"
    printf '<plist/>\n' > "$home/Library/LaunchAgents/${label}.plist"
    printf '%s\n' "$label" >> "$state"
  done
  jq -n '{projectName:"growth",leadId:"mufasa-lead"}' \
    > "$home/.flywheel/manifests/growth-mufasa-lead.json"
  printf '<plist/>\n' > "$home/Library/LaunchAgents/com.flywheel.lead.growth-mufasa-lead.plist"
  printf 'com.flywheel.lead.growth-mufasa-lead\n' >> "$state"
  # Real-fleet asymmetries: one loaded plist has no manifest, while one QA-slot
  # plist/manifest must remain outside the production cutover census.
  printf '<plist/>\n' > "$home/Library/LaunchAgents/com.flywheel.lead.flywheel-codex-infra-bot-lead.plist"
  printf 'com.flywheel.lead.flywheel-codex-infra-bot-lead\n' >> "$state"
  jq -n '{projectName:"test-slot-3",leadId:"flywheel-test-3"}' \
    > "$home/.flywheel/manifests/test-slot-3-flywheel-test-3.json"
  printf '<plist/>\n' > "$home/Library/LaunchAgents/com.flywheel.lead.test-slot-3-flywheel-test-3.plist"
  printf 'com.flywheel.lead.test-slot-3-flywheel-test-3\n' >> "$state"
  printf 'com.flywheel.bridge\n' >> "$state"
  cat > "$home/Library/LaunchAgents/com.flywheel.bridge.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>com.flywheel.bridge</string>
<key>ProgramArguments</key><array>
<string>/bin/bash</string>
<string>$REPO_ROOT/scripts/flywheel-bridge-wrapper.sh</string>
</array></dict></plist>
EOF

  # True pre-cutover state: only the two active legacy overlay scripts exist.
  # The checker is read-only. The updater represents the unsafe historical
  # developer-clone reset and must never be called by an automatic rollback.
  cat > "$home/.flywheel/bin/check-discord-plugin.sh" <<'EOF'
#!/usr/bin/env bash
printf 'legacy-check\n' >> "${EVENT_LOG}"
exit 0
EOF
  cat > "$home/.flywheel/bin/update-discord-plugin.sh" <<'EOF'
#!/usr/bin/env bash
printf 'UNSAFE-LEGACY-UPDATE\n' >> "${EVENT_LOG}"
exit 99
EOF
  chmod +x "$home/.flywheel/bin/check-discord-plugin.sh" \
    "$home/.flywheel/bin/update-discord-plugin.sh"

  cat > "$bin/launchctl" <<'EOF'
#!/usr/bin/env bash
target="${2:-}"
label="${target##*/}"
case "$1" in
  print) grep -Fxq "$label" "${LAUNCH_STATE}" ;;
  bootout)
    [[ "${CUTOVER_STOP_FAIL_LABEL:-}" != "$label" ]] || exit 1
    grep -Fxv "$label" "${LAUNCH_STATE}" > "${LAUNCH_STATE}.new" || true
    mv "${LAUNCH_STATE}.new" "${LAUNCH_STATE}"
    printf 'bootout %s\n' "$label" >> "${EVENT_LOG}"
    ;;
  bootstrap)
    label="$(basename "$3" .plist)"
    grep -Fxq "$label" "${LAUNCH_STATE}" || printf '%s\n' "$label" >> "${LAUNCH_STATE}"
    printf 'bootstrap %s\n' "$label" >> "${EVENT_LOG}"
    ;;
  *) exit 64 ;;
esac
EOF
  cat > "$bin/deploy" <<'EOF'
#!/usr/bin/env bash
printf 'deploy %s\n' "$1" >> "${EVENT_LOG}"
EOF
  cat > "$bin/build" <<'EOF'
#!/usr/bin/env bash
printf 'build\n' >> "${EVENT_LOG}"
EOF
  cat > "$bin/installer" <<'EOF'
#!/usr/bin/env bash
printf 'install-ops\n' >> "${EVENT_LOG}"
for script in check-discord-plugin.sh update-discord-plugin.sh; do
  cat > "${HOME}/.flywheel/bin/$script" <<'INNER'
#!/usr/bin/env bash
if [[ "${1:-}" == --print-install-path ]]; then printf '%s\n' "${POINTER_INSTALL_PATH}"; fi
exit 0
INNER
  chmod +x "${HOME}/.flywheel/bin/$script"
done
for script in check-discord-plugin-legacy-overlay.sh update-discord-plugin-legacy-overlay.sh; do
  cat > "${HOME}/.flywheel/bin/$script" <<'INNER'
#!/usr/bin/env bash
printf 'legacy recovery\n'
exit 0
INNER
  chmod +x "${HOME}/.flywheel/bin/$script"
done
EOF
  cat > "$bin/claude" <<'EOF'
#!/usr/bin/env bash
printf 'claude %s\n' "$*" >> "${EVENT_LOG}"
registry="${HOME}/.claude/plugins/installed_plugins.json"
if [[ "$*" == "plugin install discord@flywheel-plugins --scope user" ]]; then
  mkdir -p "$(dirname "$registry")"
  jq -n --arg path "${POINTER_INSTALL_PATH}" \
    '{plugins:{"discord@flywheel-plugins":[{scope:"user",installPath:$path}]}}' > "$registry"
fi
if [[ "$*" == "plugin uninstall discord@flywheel-plugins --scope user" \
    && "${CUTOVER_UNINSTALL_FAIL:-0}" == 1 ]]; then
  exit 1
fi
if [[ "$*" == "plugin uninstall discord@flywheel-plugins --scope user" ]]; then
  jq 'del(.plugins["discord@flywheel-plugins"])' "$registry" > "${registry}.new"
  mv "${registry}.new" "$registry"
fi
exit 0
EOF
  cat > "$bin/ps" <<'EOF'
#!/usr/bin/env bash
if [[ "$*" != "axww -o pid= -o ppid= -o command=" ]]; then
  exec /bin/ps "$@"
fi
if [[ "${CUTOVER_PS_MODE:-quiet}" == "sensor-fail" ]]; then
  exit 42
fi
# Real host shape: QA, Runner, and headless Claude sessions all use the shared
# production cache path. They survive the Lead launchd stop and must not count
# as production Lead adapters merely because their path contains discord.
printf '700 1 claude --agent flywheel-test-3 --channels plugin:discord@claude-plugins-official\n'
printf '702 700 bun %s/.claude/plugins/cache/claude-plugins-official/discord/0.0.4/server.ts\n' "${HOME}"
printf '710 1 claude --agent-id runner-review@flywheel-eng-lead --channels plugin:discord@claude-plugins-official\n'
printf '711 710 bun %s/.claude/plugins/cache/claude-plugins-official/discord/0.0.4/server.ts\n' "${HOME}"
printf '720 1 claude -p CROSS-FAMILY-REVIEWER --channels plugin:discord@claude-plugins-official\n'
printf '721 720 bun %s/.claude/plugins/cache/claude-plugins-official/discord/0.0.4/server.ts\n' "${HOME}"
if grep -Fq 'com.flywheel.lead.test-slot-3-flywheel-test-3' "${LAUNCH_STATE}"; then
  : # The QA process above is intentionally independent of production inventory.
fi
if [[ "${CUTOVER_PS_MODE:-quiet}" == "resurrect" ]]; then
  printf '999 1 /bin/bash packages/teamlead/scripts/claude-lead.sh eng-lead /repo flywheel\n'
elif [[ "${CUTOVER_PS_MODE:-quiet}" == "orphan" ]]; then
  printf '998 1 bun /prod/plugins/cache/flywheel-plugins/discord/0.0.5/server.ts\n'
fi
loaded_claude=0
for label in com.flywheel.lead.flywheel-eng-lead com.flywheel.lead.growth-growth-lead; do
  if grep -Fxq "$label" "${LAUNCH_STATE}"; then
    loaded_claude=$((loaded_claude + 1))
    lead="${label##*.lead.}"
    lead="${lead#*-}"
    case "$label" in
      com.flywheel.lead.flywheel-eng-lead) lead=eng-lead ;;
      com.flywheel.lead.growth-growth-lead) lead=growth-lead ;;
    esac
    printf '%s 1 claude --agent %s --dangerously-load-development-channels plugin:discord@flywheel-plugins\n' \
      "$((800 + loaded_claude * 10))" "$lead"
  fi
done
if (( loaded_claude > 0 )); then
  count_file="${PS_READY_COUNT_FILE}"
  count="$(cat "$count_file" 2>/dev/null || echo 0)"
  count=$((count + 1)); printf '%s\n' "$count" > "$count_file"
  if (( count >= ${POINTER_READY_AFTER:-1} )); then
    n=0
    while (( n < loaded_claude )); do
      printf '%s %s bun %s/server.ts\n' "$((900 + n))" "$((810 + n * 10))" "${POINTER_INSTALL_PATH}"
      n=$((n + 1))
    done
  fi
fi
EOF
  cat > "$bin/health" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
  cat > "$bin/preflight" <<'EOF'
#!/usr/bin/env bash
if [[ "${1:-}" == --target-sha ]]; then
  printf 'target-preflight %s\n' "${2:-}" >> "${EVENT_LOG}"
  [[ "${TARGET_PREFLIGHT_FAIL:-0}" != 1 ]]
  exit
fi
printf '%s\n' "${POINTER_INSTALL_PATH}"
EOF
  cat > "$bin/alert" <<'EOF'
#!/usr/bin/env bash
printf 'alert %s\n' "$*" >> "${EVENT_LOG}"
exit 0
EOF
  chmod +x "$bin/"*
  mkdir -p "$home/.claude/plugins/cache/flywheel-plugins/discord/0.0.5"
  printf 'allowBots\n[reply-guard]\nChatReceiptRuntime\n' \
    > "$home/.claude/plugins/cache/flywheel-plugins/discord/0.0.5/server.ts"
}

run_cutover() {
  local sb="$1" mode="$2"; shift 2
  env HOME="$sb/home" PATH="$sb/bin:/usr/bin:/bin" \
    FLYWHEEL_DISCORD_CUTOVER_AUTHORIZED=1 \
    FLYWHEEL_DISCORD_CUTOVER_TEST_SEAMS=1 \
    FLYWHEEL_DISCORD_CUTOVER_REPO="$REPO_ROOT" \
    FLYWHEEL_DISCORD_CUTOVER_LAUNCHCTL="$sb/bin/launchctl" \
    FLYWHEEL_DISCORD_CUTOVER_DEPLOY_CMD="$sb/bin/deploy" \
    FLYWHEEL_DISCORD_CUTOVER_BUILD_CMD="$sb/bin/build" \
    FLYWHEEL_DISCORD_CUTOVER_INSTALLER="$sb/bin/installer" \
    FLYWHEEL_DISCORD_CUTOVER_CLAUDE="$sb/bin/claude" \
    FLYWHEEL_DISCORD_CUTOVER_HEALTH_CMD="$sb/bin/health" \
    FLYWHEEL_DISCORD_CUTOVER_PREFLIGHT_CMD="$sb/bin/preflight" \
    FLYWHEEL_DISCORD_CUTOVER_ALERT="$sb/bin/alert" \
    FLYWHEEL_DISCORD_CUTOVER_STATE_DIR="$sb/cutover-state" \
    FLYWHEEL_DISCORD_CUTOVER_LOCK_DIR="$sb/restart.lock.d" \
    FLYWHEEL_LAUNCHD_DIR="$sb/home/Library/LaunchAgents" \
    LAUNCH_STATE="$sb/launch-state" EVENT_LOG="$sb/events.log" \
    PS_READY_COUNT_FILE="$sb/ps-ready.count" \
    POINTER_INSTALL_PATH="$sb/home/.claude/plugins/cache/flywheel-plugins/discord/0.0.5" \
    "$@" bash "$CUTOVER" "$mode" \
      --target-sha "${RUN_TARGET_SHA:-$TARGET_SHA}" \
      --known-good-sha "${RUN_KNOWN_SHA:-$KNOWN_SHA}"
}

run_apply() {
  local sb="$1"; shift
  run_cutover "$sb" apply "$@"
}

SB_TARGET_PREFLIGHT="$(mktemp -d "${TMPDIR:-/tmp}/fly1676-cutover-target-preflight.XXXXXX")"
make_fixture "$SB_TARGET_PREFLIGHT"
if run_apply "$SB_TARGET_PREFLIGHT" TARGET_PREFLIGHT_FAIL=1 >/dev/null 2>&1; then
  fail "target dependency preflight rejects before any fleet or repository mutation"
elif grep -Eq '^(bootout|deploy|build|install-ops|claude plugin)' "$SB_TARGET_PREFLIGHT/events.log"; then
  fail "target dependency preflight rejects before any fleet or repository mutation"
else
  pass "target dependency preflight rejects before any fleet or repository mutation"
fi

SB_SUCCESS="$(mktemp -d "${TMPDIR:-/tmp}/fly1676-cutover-success.XXXXXX")"
make_fixture "$SB_SUCCESS"
if run_apply "$SB_SUCCESS" \
    && jq -e '.enabledPlugins["discord@claude-plugins-official"] == false and .enabledPlugins["discord@flywheel-plugins"] == true' \
      "$SB_SUCCESS/home/.claude/settings.json" >/dev/null \
    && grep -Fq "deploy $TARGET_SHA" "$SB_SUCCESS/events.log" \
    && grep -Fq 'claude plugin install discord@flywheel-plugins --scope user' "$SB_SUCCESS/events.log" \
    && grep -Fxq 'com.flywheel.lead.growth-mufasa-lead' "$SB_SUCCESS/launch-state" \
    && grep -Fxq 'com.flywheel.lead.flywheel-codex-infra-bot-lead' "$SB_SUCCESS/launch-state" \
    && grep -Fxq 'com.flywheel.lead.test-slot-3-flywheel-test-3' "$SB_SUCCESS/launch-state" \
    && [[ ! -d "$SB_SUCCESS/restart.lock.d" ]]; then
  pass "apply reconciles asymmetric inventory, ignores QA, waits for Claude adapters, and releases the lock"
else
  fail "apply reconciles asymmetric inventory, ignores QA, waits for Claude adapters, and releases the lock"
fi

before_mismatch="$(cksum "$SB_SUCCESS/events.log")"
if RUN_KNOWN_SHA="3333333333333333333333333333333333333333" \
    run_cutover "$SB_SUCCESS" rollback >/dev/null 2>&1; then
  fail "rollback rejects caller SHAs that do not match the durable pre-image"
elif [[ "$(cksum "$SB_SUCCESS/events.log")" == "$before_mismatch" ]]; then
  pass "rollback rejects mismatched caller SHAs before authority or deploy mutation"
else
  fail "rollback mismatch rejection happened after mutation"
fi

if run_cutover "$SB_SUCCESS" rollback \
    && jq -e '.enabledPlugins["discord@claude-plugins-official"] == true and .enabledPlugins["discord@flywheel-plugins"] == false' \
      "$SB_SUCCESS/home/.claude/settings.json" >/dev/null \
    && grep -Fq "deploy $KNOWN_SHA" "$SB_SUCCESS/events.log" \
    && grep -Fq 'claude plugin uninstall discord@flywheel-plugins --scope user' "$SB_SUCCESS/events.log" \
    && ! grep -Fq 'UNSAFE-LEGACY-UPDATE' "$SB_SUCCESS/events.log" \
    && grep -Fxq 'com.flywheel.bridge' "$SB_SUCCESS/launch-state" \
    && [[ "$(grep -c '^com.flywheel.lead' "$SB_SUCCESS/launch-state")" == 5 ]] \
    && [[ ! -e "$SB_SUCCESS/home/.flywheel/bin/check-discord-plugin-legacy-overlay.sh" ]] \
    && [[ ! -e "$SB_SUCCESS/home/.flywheel/bin/update-discord-plugin-legacy-overlay.sh" ]]; then
  pass "explicit post-cutover rollback reacquires the gate and restores the durable legacy pre-image"
else
  fail "explicit post-cutover rollback reacquires the gate and restores the durable legacy pre-image"
fi

for failpoint in deploy install-ops install-plugin settings preflight; do
  SB_FAIL="$(mktemp -d "${TMPDIR:-/tmp}/fly1676-cutover-${failpoint}.XXXXXX")"
  make_fixture "$SB_FAIL"
  if run_apply "$SB_FAIL" FLYWHEEL_DISCORD_CUTOVER_FAIL_AT="$failpoint" >/dev/null 2>&1; then
    fail "$failpoint failure returns non-zero after reverse transaction"
  elif grep -Fq "deploy $KNOWN_SHA" "$SB_FAIL/events.log" \
      && jq -e '.enabledPlugins["discord@claude-plugins-official"] == true and .enabledPlugins["discord@flywheel-plugins"] == false' \
        "$SB_FAIL/home/.claude/settings.json" >/dev/null \
      && grep -Fxq 'com.flywheel.bridge' "$SB_FAIL/launch-state" \
      && [[ "$(grep -c '^com.flywheel.lead' "$SB_FAIL/launch-state")" == 5 ]]; then
    pass "$failpoint failure restores legacy code/settings/plugin and the whole loaded fleet"
  else
    fail "$failpoint failure restores legacy code/settings/plugin and the whole loaded fleet"
  fi
done

SB_DELAY="$(mktemp -d "${TMPDIR:-/tmp}/fly1676-cutover-delayed-adapter.XXXXXX")"
make_fixture "$SB_DELAY"
if run_apply "$SB_DELAY" POINTER_READY_AFTER=3 >/dev/null 2>&1 \
    && (( $(cat "$SB_DELAY/ps-ready.count") >= 3 )); then
  pass "root proof retries until every expected Claude adapter reaches the pointer path"
else
  fail "root proof retries until every expected Claude adapter reaches the pointer path"
fi

SB_NO_INSTALL="$(mktemp -d "${TMPDIR:-/tmp}/fly1676-cutover-no-install.XXXXXX")"
make_fixture "$SB_NO_INSTALL"
if run_apply "$SB_NO_INSTALL" FLYWHEEL_DISCORD_CUTOVER_FAIL_AT=deploy \
    CUTOVER_UNINSTALL_FAIL=1 >/dev/null 2>&1; then
  fail "pre-install failure returns non-zero after a recoverable reverse transaction"
elif [[ "$(cat "$SB_NO_INSTALL/cutover-state/status")" == rolled-back ]] \
    && ! grep -Fq 'UNSAFE-LEGACY-UPDATE' "$SB_NO_INSTALL/events.log" \
    && [[ "$(grep -c '^com.flywheel.lead' "$SB_NO_INSTALL/launch-state")" == 5 ]] \
    && jq -e '.enabledPlugins["discord@claude-plugins-official"] == true and .enabledPlugins["discord@flywheel-plugins"] == false' \
      "$SB_NO_INSTALL/home/.claude/settings.json" >/dev/null; then
  pass "reverse transaction treats an absent pointer plugin as already uninstalled"
else
  fail "reverse transaction treats an absent pointer plugin as already uninstalled"
fi

for mode in resurrect orphan sensor-fail; do
  SB_CENSUS="$(mktemp -d "${TMPDIR:-/tmp}/fly1676-cutover-${mode}.XXXXXX")"
  make_fixture "$SB_CENSUS"
  if run_apply "$SB_CENSUS" CUTOVER_PS_MODE="$mode" >/dev/null 2>&1; then
    fail "$mode runtime evidence blocks mutation"
  elif ! grep -q '^deploy ' "$SB_CENSUS/events.log" \
      && grep -Fxq 'com.flywheel.bridge' "$SB_CENSUS/launch-state" \
      && [[ "$(grep -c '^com.flywheel.lead' "$SB_CENSUS/launch-state")" == 5 ]]; then
    pass "$mode runtime evidence aborts pre-mutation and restores the legacy fleet"
  else
    fail "$mode runtime evidence aborts pre-mutation and restores the legacy fleet"
  fi
done

SB_STOP="$(mktemp -d "${TMPDIR:-/tmp}/fly1676-cutover-stop.XXXXXX")"
make_fixture "$SB_STOP"
if run_apply "$SB_STOP" CUTOVER_STOP_FAIL_LABEL=com.flywheel.lead.flywheel-eng-lead >/dev/null 2>&1; then
  fail "bootout failure blocks mutation"
elif ! grep -q '^deploy ' "$SB_STOP/events.log" \
    && grep -Fxq 'com.flywheel.bridge' "$SB_STOP/launch-state" \
    && [[ "$(grep -c '^com.flywheel.lead' "$SB_STOP/launch-state")" == 5 ]]; then
  pass "bootout failure runs pre-mutation recovery and restores every loaded authority"
else
  fail "bootout failure runs pre-mutation recovery and restores every loaded authority"
fi

SB_LOCK="$(mktemp -d "${TMPDIR:-/tmp}/fly1676-cutover-lock.XXXXXX")"
make_fixture "$SB_LOCK"; mkdir "$SB_LOCK/restart.lock.d"
if run_apply "$SB_LOCK" >/dev/null 2>&1; then
  fail "shared lock contention fails before any mutation"
elif [[ ! -s "$SB_LOCK/events.log" ]]; then
  pass "shared lock contention fails before any mutation"
else
  fail "shared lock contention fails before any mutation"
fi

SB_WRONG_REPO="$(mktemp -d "${TMPDIR:-/tmp}/fly1676-cutover-wrong-repo.XXXXXX")"
make_fixture "$SB_WRONG_REPO"
python3 - "$SB_WRONG_REPO/home/Library/LaunchAgents/com.flywheel.bridge.plist" \
  "$REPO_ROOT/scripts/flywheel-bridge-wrapper.sh" \
  /opt/not-deployed/scripts/flywheel-bridge-wrapper.sh <<'PY'
import sys

path, old, new = sys.argv[1:]
with open(path, encoding="utf-8") as handle:
    content = handle.read()
with open(path, "w", encoding="utf-8") as handle:
    handle.write(content.replace(old, new))
PY
if run_apply "$SB_WRONG_REPO" >/dev/null 2>&1; then
  fail "cutover rejects a checkout that is not pinned by the Bridge plist"
elif [[ ! -e "$SB_WRONG_REPO/events.log" ]] \
    && [[ "$(grep -c '^com.flywheel.lead' "$SB_WRONG_REPO/launch-state")" == 5 ]]; then
  pass "deployed-checkout proof fails before authority or repository mutation"
else
  fail "deployed-checkout proof failed after mutation"
fi

printf '\nResults: %d passed, %d failed\n' "$PASSED" "$FAILED"
(( FAILED == 0 ))
