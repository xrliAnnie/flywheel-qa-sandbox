#!/usr/bin/env bash
# Start the slot-1 Bridge from tmux so its Lead-inbox adapter can write the
# real Claude inbox path. A Bridge descended from the managed Codex shell
# cannot write that path and would turn patrol deliveries into dead letters.
set -euo pipefail

slot_dir="/tmp/flywheel-test-slot-1"
repo_root="/Users/xiaorongli/Dev/flywheel-FLY-1439"
env_file="${HOME}/.flywheel/.env"
projects="$(<"${slot_dir}/flywheel-projects.json")"

set -a
# shellcheck disable=SC1090
source "$env_file"
set +a

bot_token="${TEST_BOT_TOKEN_1:?TEST_BOT_TOKEN_1 is required}"
runner_start="$(git -C "$repo_root" rev-parse HEAD)"
bridge_pid="$$"
printf '%s\n' "$bridge_pid" >"${slot_dir}/bridge.pid"
printf '%s\n' "$bridge_pid" >"/tmp/flywheel-test-slot-1.lock/pid"

exec env \
  -u TEAMLEAD_API_TOKEN \
  -u TEAMLEAD_REPLY_BY_ISSUE_ENABLED \
  -u TEAMLEAD_REPLY_GUARD_ENABLED \
  -u TEAMLEAD_CHAT_THREADS_ENABLED \
  TEAMLEAD_PORT=19871 \
  DISCORD_BOT_TOKEN="$bot_token" \
  TEST_BOT_TOKEN_1="$bot_token" \
  TEAMLEAD_DB_PATH="${slot_dir}/teamlead.db" \
  TEAMLEAD_URL="http://localhost:19871" \
  FLYWHEEL_PROJECTS="$projects" \
  LINEAR_API_KEY="${LINEAR_API_KEY:-}" \
  FLYWHEEL_RUNNER_START_POINT="$runner_start" \
  FLYWHEEL_BIN_DIR="${slot_dir}/bin" \
  FLYWHEEL_HOOKS_DIR="${slot_dir}/hooks" \
  FLYWHEEL_RECEIPT_WINDOW_P0_MIN=2 \
  FLYWHEEL_RECEIPT_WINDOW_P1_MIN=2 \
  "$repo_root/node_modules/.bin/tsx" "$repo_root/scripts/run-bridge.ts" \
  >"${slot_dir}/bridge.log" 2>&1
