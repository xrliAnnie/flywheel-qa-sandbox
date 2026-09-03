#!/bin/bash
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TMP="$(mktemp -d /tmp/f2301-mutants.XXXXXX)"
trap 'rm -rf "$TMP"' EXIT
passed=0
failed=0
pass() { printf 'PASS: %s\n' "$1"; passed=$((passed + 1)); }
fail() { printf 'FAIL: %s\n' "$1"; failed=$((failed + 1)); }

copy_mirror() {
  local mirror="$1"
  mkdir -p "$mirror/scripts/__tests__"
  cp -R "$ROOT/scripts/lib" "$mirror/scripts/lib"
  cp -R "$ROOT/scripts/__tests__/fixtures" "$mirror/scripts/__tests__/fixtures"
  cp "$ROOT/scripts/test-deploy.sh" "$mirror/scripts/test-deploy.sh"
  cp "$ROOT/scripts/flywheel-lead-wrapper-v2.sh" \
    "$mirror/scripts/flywheel-lead-wrapper-v2.sh"
}

mutate_once() {
  local path="$1" old="$2" new="$3"
  python3 - "$path" "$old" "$new" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
old, new = sys.argv[2:]
body = path.read_text()
if body.count(old) != 1:
    raise SystemExit(f"mutation target count was {body.count(old)}, expected 1: {old!r}")
path.write_text(body.replace(old, new))
PY
}

# Render every frozen carrier surface from the mirrored producers. A mutant is
# discriminating only when its named surface differs and every other surface
# remains byte-identical.
render_surface_results() (
  local mirror="$1" work="$2" fixtures="$mirror/scripts/__tests__/fixtures/fly2301"
  mkdir -p "$work/runtime" "$work/home" "$work/state"
  export HOME="$work/home"
  export FLYWHEEL_DIR="$mirror"
  export FLYWHEEL_STATE_DIR="$work/state"
  log() { printf '[mutant] %s\n' "$*" >&2; }
  # shellcheck disable=SC1090
  source "$mirror/scripts/lib/qa-multilead.sh"
  # shellcheck disable=SC1090
  source "$mirror/scripts/lib/qa-lead-artifacts.sh"
  # shellcheck disable=SC1090
  source "$mirror/scripts/lib/qa-launchd-lead.sh"

  local wrapper="$mirror/scripts/flywheel-lead-wrapper-v2.sh"
  local manifest_input="$work/runtime/manifest.json"
  local projects="$work/runtime/projects.json" env_input="$work/runtime/.env"
  local lead_log="$work/runtime/lead.log" claude_plist="$work/runtime/claude.plist"
  local codex_wrapper="$work/runtime/codex-wrapper.sh" codex_plist="$work/runtime/codex.plist"
  printf '%s\n' '#!/bin/bash' 'exit 0' > "$codex_wrapper"
  chmod +x "$codex_wrapper"
  printf '%s\n' '{}' > "$manifest_input"
  printf '%s\n' '[]' > "$projects"
  : > "$env_input"

  qa_launchd_render_plist "$claude_plist" com.flywheel.qa.lead.slot-7.qa-lead \
    "$wrapper" "$manifest_input" "$HOME" "$FLYWHEEL_STATE_DIR" "$projects" \
    "$env_input" "$lead_log" "$work/runtime/identity-home" >/dev/null 2>&1
  sed -e "s#${work}#@TMP@#g" -e "s#${mirror}#@ROOT@#g" \
    "$claude_plist" > "$work/claude.normalized"
  if cmp -s "$fixtures/claude-lead.plist" "$work/claude.normalized"; then
    printf 'claude-plist=ok\n'
  else
    printf 'claude-plist=fail\n'
  fi

  qa_launchd_render_codex_plist "$codex_plist" \
    com.flywheel.qa.lead.slot-7.qa-lead "$codex_wrapper" "$HOME" \
    "$FLYWHEEL_STATE_DIR" "$lead_log" "$work" >/dev/null 2>&1
  sed -e "s#${work}#@TMP@#g" -e "s#${mirror}#@ROOT@#g" \
    "$codex_plist" > "$work/codex.normalized"
  if cmp -s "$fixtures/codex-lead.plist" "$work/codex.normalized"; then
    printf 'codex-plist=ok\n'
  else
    printf 'codex-plist=fail\n'
  fi

  local launch_env
  launch_env=$(qa_slot_launch_env_json \
    'DISCORD_GUILD_ID=guild-1' 'BRIDGE_URL=http://localhost:4242' \
    'AGENT_SOURCE=/tmp/flywheel-test-slot-7/test-identity.md' 'TEAMLEAD_API_TOKEN=' \
    'FLYWHEEL_PROJECTS_FILE=/tmp/flywheel-test-slot-7/q/7/projects.json' \
    'TEAMLEAD_DB_PATH=/tmp/flywheel-test-slot-7/teamlead.db' \
    'FLYWHEEL_STATE_DIR=/tmp/flywheel-test-slot-7/q/7' \
    'FLYWHEEL_WRAPPER_ENV_FILE=/tmp/flywheel-test-slot-7/q/7/.env' \
    'FLYWHEEL_DELIVERY_SECRET_PATH=/tmp/flywheel-test-slot-7/state/delivery-secret' \
    'LEAD_WORKSPACE=/tmp/flywheel-test-slot-7/lead-workspace')

  qa_lead_write_env "$work/lead.env" TEST_BOT_TOKEN_7 "tok'en with spaces"
  if cmp -s "$fixtures/claude-lead.env" "$work/lead.env"; then
    printf 'env=ok\n'
  else
    printf 'env=fail\n'
  fi

  qa_lead_write_manifest "$work/manifest.json" flywheel-test-7 \
    /tmp/flywheel-test-slot-7/project-slot-7 test-slot-7 \
    /tmp/flywheel-test-slot-7/q/7/projects.json \
    /tmp/flywheel-test-slot-7/lead-workspace '' "$launch_env"
  if cmp -s "$fixtures/claude-lead-manifest.json" "$work/manifest.json"; then
    printf 'manifest=ok\n'
  else
    printf 'manifest=fail\n'
  fi

  qa_lead_write_launch_manifest "$work/launch-manifest.json" 1234 deadbeef main slot \
    '' '' '[]' launchd-v2 /tmp/flywheel-test-slot-7/launchd-leads.json \
    com.flywheel.qa.lead.slot-7.flywheel-test-7 /tmp/flywheel-test-7.sock
  if cmp -s "$fixtures/claude-launch-manifest.json" "$work/launch-manifest.json"; then
    printf 'launch-manifest=ok\n'
  else
    printf 'launch-manifest=fail\n'
  fi

  qa_lead_render_stdout_json \
    7 slot false '' 4242 flywheel-test-7 test-slot-7 channel-7 TEST_BOT_TOKEN_7 \
    1234 /tmp/flywheel-test-slot-7/launchd/flywheel-test-7/pid launchd-v2 \
    com.flywheel.qa.lead.slot-7.flywheel-test-7 /tmp/flywheel-test-7.sock \
    /tmp/flywheel-test-slot-7/launchd-leads.json /tmp/flywheel-test-slot-7 main \
    xrliAnnie/flywheel-qa-sandbox /tmp/flywheel-test-slot-7/project-slot-7 \
    qa-slot-7 deadbeef origin/main /tmp/flywheel-test-slot-7/teamlead.db \
    /tmp/flywheel-test-slot-7/bridge.log /tmp/flywheel-test-slot-7/bridge-launch.json \
    /tmp/flywheel-test-slot-7/tmp /tmp/flywheel-test-slot-7/state/reports null \
    /tmp/flywheel-test-slot-7/lead.log /tmp/flywheel-test-slot-7/flywheel-projects.json \
    /tmp/flywheel-test-slot-7/launch-manifest.json '' '' '' '[]' '' > "$work/stdout.json"
  if cmp -s "$fixtures/claude-stdout.json" "$work/stdout.json"; then
    printf 'stdout=ok\n'
  else
    printf 'stdout=fail\n'
  fi

  if [[ "$(qa_lead_log_launchd_label com.flywheel.qa.lead.slot-7.flywheel-test-7 /tmp/flywheel-test-7.sock)" == \
      'Lead launchd label: com.flywheel.qa.lead.slot-7.flywheel-test-7; private socket: /tmp/flywheel-test-7.sock' ]]; then
    printf 'log=ok\n'
  else
    printf 'log=fail\n'
  fi
)

run_mutant() {
  local id="$1" relpath="$2" old="$3" new="$4" expected="$5"
  local mirror="$TMP/$id/repo" work="$TMP/$id/work" results fail_count
  copy_mirror "$mirror"
  if ! mutate_once "$mirror/$relpath" "$old" "$new"; then
    fail "$id mutation was not applied exactly once"
    return
  fi
  results=$(render_surface_results "$mirror" "$work") || {
    fail "$id mirrored producers did not render"
    return
  }
  fail_count=$(printf '%s\n' "$results" | grep -c '=fail' || true)
  if [[ "$fail_count" == 1 ]] \
      && grep -Fxq "${expected}=fail" <<<"$results"; then
    pass "$id changes only the ${expected} frozen surface"
  else
    fail "$id was non-discriminating or changed another surface: ${results//$'\n'/, }"
  fi
}

run_mutant claude-argv scripts/lib/qa-launchd-lead.sh \
  '<key>ProgramArguments</key><array><string>%s</string><string>%s</string></array>' \
  '<key>ProgramArguments</key><array><string>%s</string><string>--mutant</string><string>%s</string></array>' \
  claude-plist
run_mutant claude-env scripts/lib/qa-launchd-lead.sh \
  '<key>FLYWHEEL_SUMMARY_CONFIG_HOME</key><string>%s</string>' \
  '<key>FLYWHEEL_SUMMARY_CONFIG_HOME_MUTANT</key><string>%s</string>' \
  claude-plist
run_mutant codex-argv scripts/lib/qa-launchd-lead.sh \
  '<key>ProgramArguments</key><array><string>/bin/bash</string><string>%s</string></array>' \
  '<key>ProgramArguments</key><array><string>/bin/zsh</string><string>%s</string></array>' \
  codex-plist
run_mutant env-writer scripts/lib/qa-lead-artifacts.sh \
  "printf '%s=%q\\n'" "printf '%s=%s\\n'" env
run_mutant manifest-key scripts/lib/qa-lead-artifacts.sh \
  'launchEnvironment:$launchEnvironment}' 'launchEnvironmentMutant:$launchEnvironment}' manifest
run_mutant launch-manifest-key scripts/lib/qa-lead-artifacts.sh \
  'mainLeadLabel:$label,mainLeadSocket:$socket' \
  'mainLeadLabelMutant:$label,mainLeadSocket:$socket' launch-manifest
run_mutant stdout-key scripts/lib/qa-lead-artifacts.sh \
  '"leadSocket": "${lead_socket}"' '"leadSocketMutant": "${lead_socket}"' stdout
run_mutant log-text scripts/lib/qa-lead-artifacts.sh \
  'private socket: %s' 'private socket MUTANT: %s' log

printf '\n%d passed, %d failed\n' "$passed" "$failed"
[[ "$failed" -eq 0 ]]
