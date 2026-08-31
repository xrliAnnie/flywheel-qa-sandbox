#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WRAPPER="$ROOT/scripts/flywheel-lead-wrapper-v2.sh"
TMP="$(mktemp -d /tmp/fly1726-wrapper.XXXXXX)"
trap 'rm -rf "$TMP"' EXIT

passed=0
failed=0
pass() { printf 'PASS: %s\n' "$1"; passed=$((passed + 1)); }
fail() { printf 'FAIL: %s\n' "$1"; failed=$((failed + 1)); }

mkdir -p "$TMP/home/.flywheel" "$TMP/project" "$TMP/bin" "$TMP/state"
cat > "$TMP/home/.flywheel/summary-config.json" <<'JSON'
{"schemaVersion":1,"granularity":"per-lead","setBy":"test","setAt":"2026-08-28T00:00:00.000Z"}
JSON
cat > "$TMP/home/.flywheel/projects.json" <<JSON
[
  {
    "projectName": "demo",
    "projectRoot": "$TMP/project",
    "generalChannel": "12345678901234567",
    "leads": [
      {
        "agentId": "eng-lead",
        "summaryRole": "producer",
        "chatChannel": "12345678901234567",
        "match": {"labels": ["Engineering"]},
        "botTokenEnv": "ENG_BOT_TOKEN",
        "botUserId": "22345678901234567",
        "discordStateDir": "$TMP/state"
      }
    ]
  }
]
JSON
cat > "$TMP/home/.flywheel/.env" <<'ENV'
ENG_BOT_TOKEN=canonical-token
DISCORD_BOT_TOKEN=wrong-global-token
ENV
cat > "$TMP/manifest.json" <<JSON
{
  "leadId": "eng-lead",
  "projectDir": "$TMP/project",
  "projectName": "demo",
  "projectsFile": "$TMP/home/.flywheel/projects.json",
  "workspace": "$TMP/project",
  "mcpExclude": "",
  "chromeEnabled": false,
  "launchEnvironment": {"FLYWHEEL_TEST_ONLY": "preserved"}
}
JSON
cat > "$TMP/bin/ps" <<'PS'
#!/bin/bash
printf 'Mon Aug 11 12:34:56 2026\n'
PS
cat > "$TMP/bin/tmux" <<TMUX
#!/bin/bash
if [[ "\$*" == *"has-session"* ]]; then exit 1; fi
if [[ " \$* " == *" -N "* ]]; then exit 1; fi
env | sort > "$TMP/server.env"
TMUX
chmod +x "$TMP/bin/ps" "$TMP/bin/tmux"

set +e
env -u LEAD_ID -u FLYWHEEL_LEAD_ID -u PROJECT_NAME -u FLYWHEEL_PROJECT_NAME -u DISCORD_STATE_DIR \
  HOME="$TMP/home" \
  PATH="$TMP/bin:/usr/bin:/bin:/usr/sbin:/sbin" \
  FLYWHEEL_STATE_DIR="$TMP/home/.flywheel" \
  FLYWHEEL_DIR="$ROOT" \
  FLYWHEEL_LEAD_V2_PS_BIN="$TMP/bin/ps" \
  FLYWHEEL_LEAD_V2_TMUX_BIN="$TMP/bin/tmux" \
  bash "$WRAPPER" "$TMP/manifest.json" >"$TMP/valid.out" 2>&1
valid_rc=$?
set -e
if [ "$valid_rc" -eq 0 ] \
    && grep -qF 'FLYWHEEL_LEAD_ID=eng-lead' "$TMP/server.env" \
    && grep -qF 'LEAD_ID=eng-lead' "$TMP/server.env" \
    && grep -qF 'FLYWHEEL_PROJECT_NAME=demo' "$TMP/server.env" \
    && grep -qF 'PROJECT_NAME=demo' "$TMP/server.env" \
    && grep -qF "DISCORD_STATE_DIR=$TMP/state" "$TMP/server.env" \
    && grep -qF 'DISCORD_EXPECTED_BOT_USER_ID=22345678901234567' "$TMP/server.env" \
    && grep -qF 'DISCORD_IDENTITY_MODE=managed' "$TMP/server.env" \
    && grep -qF 'DISCORD_BOT_TOKEN=canonical-token' "$TMP/server.env" \
    && grep -Eq '^FLYWHEEL_LEAD_IDENTITY_DIGEST=[a-f0-9]{64}$' "$TMP/server.env" \
    && grep -qF 'FLYWHEEL_LEAD_SUMMARY_ROLE=producer' "$TMP/server.env" \
    && grep -qF 'FLYWHEEL_LEAD_HAS_SUMMARY_DUTY=1' "$TMP/server.env" \
    && grep -qF 'FLYWHEEL_SUMMARY_GRANULARITY=per-lead' "$TMP/server.env" \
    && grep -Eq '^FLYWHEEL_SUMMARY_ASSIGNMENT_DIGEST=[a-f0-9]{64}$' "$TMP/server.env" \
    && grep -qF 'FLYWHEEL_TEST_ONLY=preserved' "$TMP/server.env" \
    && ! grep -q '^ENG_BOT_TOKEN=' "$TMP/server.env" \
    && ! grep -q '^FLYWHEEL_PROJECTS=' "$TMP/server.env"; then
  pass "wrapper projects one canonical identity tuple through env -i"
else
  fail "wrapper canonical projection"
  cat "$TMP/valid.out" 2>/dev/null || true
  cat "$TMP/server.env" 2>/dev/null || true
fi

set +e
env -u FLYWHEEL_LEAD_ID -u PROJECT_NAME -u FLYWHEEL_PROJECT_NAME -u DISCORD_STATE_DIR \
  HOME="$TMP/home" \
  LEAD_ID="foreign-lead" \
  PATH="$TMP/bin:/usr/bin:/bin:/usr/sbin:/sbin" \
  FLYWHEEL_STATE_DIR="$TMP/home/.flywheel" \
  FLYWHEEL_DIR="$ROOT" \
  FLYWHEEL_LEAD_V2_DRY_RUN=1 \
  bash "$WRAPPER" "$TMP/manifest.json" >"$TMP/ambient.out" 2>&1
ambient_rc=$?
set -e
if [ "$ambient_rc" -ne 0 ] && grep -qF 'identity_env_conflict' "$TMP/ambient.out"; then
  pass "wrapper rejects inherited bare Lead identity before Discord startup"
else
  fail "wrapper inherited identity conflict"
  cat "$TMP/ambient.out" 2>/dev/null || true
fi

jq '. + {botTokenEnv:"FOREIGN_TOKEN"}' "$TMP/manifest.json" > "$TMP/manifest-top-level.json"
set +e
env -u LEAD_ID -u FLYWHEEL_LEAD_ID -u PROJECT_NAME -u FLYWHEEL_PROJECT_NAME -u DISCORD_STATE_DIR \
  HOME="$TMP/home" \
  PATH="$TMP/bin:/usr/bin:/bin:/usr/sbin:/sbin" \
  FLYWHEEL_STATE_DIR="$TMP/home/.flywheel" \
  FLYWHEEL_DIR="$ROOT" \
  FLYWHEEL_LEAD_V2_DRY_RUN=1 \
  bash "$WRAPPER" "$TMP/manifest-top-level.json" >"$TMP/top-level.out" 2>&1
top_level_rc=$?
set -e
if [ "$top_level_rc" -ne 0 ] && grep -qF 'identity_manifest_field_conflict' "$TMP/top-level.out"; then
  pass "wrapper compare-and-rejects a conflicting legacy token selector"
else
  fail "wrapper legacy token selector conflict"
  cat "$TMP/top-level.out" 2>/dev/null || true
fi

jq 'del(.projectsFile) + {botTokenEnv:"ENG_BOT_TOKEN",leadBackend:{backendId:"claude-code"}}' \
  "$TMP/manifest.json" > "$TMP/manifest-legacy.json"
set +e
env -u LEAD_ID -u FLYWHEEL_LEAD_ID -u PROJECT_NAME -u FLYWHEEL_PROJECT_NAME -u DISCORD_STATE_DIR \
  HOME="$TMP/home" \
  PATH="$TMP/bin:/usr/bin:/bin:/usr/sbin:/sbin" \
  FLYWHEEL_STATE_DIR="$TMP/home/.flywheel" \
  FLYWHEEL_DIR="$ROOT" \
  FLYWHEEL_LEAD_V2_DRY_RUN=1 \
  bash "$WRAPPER" "$TMP/manifest-legacy.json" >"$TMP/legacy.out" 2>&1
legacy_rc=$?
set -e
if [ "$legacy_rc" -eq 0 ]; then
  pass "wrapper accepts a matching legacy token/backend witness and default projects path"
else
  fail "wrapper legacy manifest migration compatibility"
  cat "$TMP/legacy.out" 2>/dev/null || true
fi

jq '. + {leadBackend:{backendId:"codex-app-server"}}' \
  "$TMP/manifest.json" > "$TMP/manifest-backend-conflict.json"
set +e
env -u LEAD_ID -u FLYWHEEL_LEAD_ID -u PROJECT_NAME -u FLYWHEEL_PROJECT_NAME -u DISCORD_STATE_DIR \
  HOME="$TMP/home" \
  PATH="$TMP/bin:/usr/bin:/bin:/usr/sbin:/sbin" \
  FLYWHEEL_STATE_DIR="$TMP/home/.flywheel" \
  FLYWHEEL_DIR="$ROOT" \
  FLYWHEEL_LEAD_V2_DRY_RUN=1 \
  bash "$WRAPPER" "$TMP/manifest-backend-conflict.json" >"$TMP/backend-conflict.out" 2>&1
backend_conflict_rc=$?
set -e
if [ "$backend_conflict_rc" -ne 0 ] \
    && grep -qF 'identity_manifest_field_conflict' "$TMP/backend-conflict.out"; then
  pass "wrapper compare-and-rejects a conflicting legacy backend witness"
else
  fail "wrapper legacy backend witness conflict"
  cat "$TMP/backend-conflict.out" 2>/dev/null || true
fi

jq '.launchEnvironment.DISCORD_STATE_DIR="/tmp/foreign-state"' "$TMP/manifest.json" > "$TMP/manifest-conflict.json"
set +e
env -u LEAD_ID -u FLYWHEEL_LEAD_ID -u PROJECT_NAME -u FLYWHEEL_PROJECT_NAME -u DISCORD_STATE_DIR \
  HOME="$TMP/home" \
  PATH="$TMP/bin:/usr/bin:/bin:/usr/sbin:/sbin" \
  FLYWHEEL_STATE_DIR="$TMP/home/.flywheel" \
  FLYWHEEL_DIR="$ROOT" \
  FLYWHEEL_LEAD_V2_DRY_RUN=1 \
  bash "$WRAPPER" "$TMP/manifest-conflict.json" >"$TMP/launch-env.out" 2>&1
launch_env_rc=$?
set -e
if [ "$launch_env_rc" -ne 0 ] && grep -qF 'identity_launch_env_conflict' "$TMP/launch-env.out"; then
  pass "wrapper compare-and-rejects conflicting launchEnvironment identity"
else
  fail "wrapper launchEnvironment identity conflict"
  cat "$TMP/launch-env.out" 2>/dev/null || true
fi

printf 'fly1726-lead-identity-wrapper: %s passed, %s failed\n' "$passed" "$failed"
[ "$failed" -eq 0 ]
