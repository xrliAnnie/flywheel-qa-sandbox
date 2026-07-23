#!/usr/bin/env bash
# Exact fallback for FLY-1439 after test-teardown correctly refused to race the
# production cmux watcher. This script does not create/kill/select tmux windows.
set -euo pipefail

slot_dir="/tmp/flywheel-test-slot-1"
slot_lock="/tmp/flywheel-test-slot-1.lock"
comm_dir="${HOME}/.flywheel/comm/test-slot-1"
session_file="${HOME}/.flywheel/claude-sessions/test-slot-1-flywheel-test-1.session-id"
manifest_file="${HOME}/.flywheel/manifests/test-slot-1-flywheel-test-1.json"
pid_file="${HOME}/.flywheel/pids/test-slot-1-flywheel-test-1.pid"
lead_workspace="${HOME}/.flywheel/lead-workspace/flywheel-test-1"
claude_json="${HOME}/.claude.json"
claude_lock="${claude_json}.lock"
quarantine="/tmp/fly1439-q6-slot-only-quarantine-7af14cc5"
output="/Users/xiaorongli/Dev/flywheel-FLY-1439/engineering/doc/FLY-1439-receipt-producer-acceptance/evidence/q6-slot-only-cleanup.txt"

[[ "$(realpath "$slot_dir")" == "/private/tmp/flywheel-test-slot-1" ]]
[[ -d "$slot_lock" && -d "$comm_dir" ]]
[[ ! -e "$quarantine" ]]

if tmux list-windows -t flywheel -F '#{window_name}' 2>/dev/null |
  grep -q '^test-slot-1-flywheel-test-1$'; then
  printf 'refusing: slot Lead window is still present\n' >&2
  exit 1
fi
if lsof -nP -iTCP:19871 -sTCP:LISTEN 2>/dev/null | grep -q .; then
  printf 'refusing: slot Bridge port 19871 is still listening\n' >&2
  exit 1
fi
if [[ -f "$slot_dir/bridge.pid" ]]; then
  bridge_pid="$(<"$slot_dir/bridge.pid")"
  if [[ "$bridge_pid" =~ ^[1-9][0-9]*$ ]] &&
    ps -p "$bridge_pid" >/dev/null 2>&1; then
    printf 'refusing: slot Bridge pid %s is still alive\n' "$bridge_pid" >&2
    exit 1
  fi
fi

host_repo="$slot_dir/project-slot-1"
if [[ -d "$host_repo/.git" ]]; then
  foreign="$(
    git -C "$host_repo" worktree list --porcelain |
      awk '/^worktree /{print $2}' |
      grep -v '^/private/tmp/flywheel-test-slot-1/project-slot-1$' || true
  )"
  if [[ -n "$foreign" ]]; then
    printf 'refusing: foreign slot worktree remains: %s\n' "$foreign" >&2
    exit 1
  fi
fi

mkdir "$quarantine"
trust_before=0
trust_after=0
claude_before="MISSING"
claude_after="MISSING"
if [[ -f "$claude_json" ]]; then
  trust_before="$(
    jq -r '[
      ((.projects // {}) | keys[]) |
      select(
        startswith("/tmp/flywheel-test-slot-1") or
        startswith("/private/tmp/flywheel-test-slot-1")
      )
    ] | length' "$claude_json"
  )"
  claude_before="$(shasum -a 256 "$claude_json" | awk '{print $1}')"
  waited=0
  while ! mkdir "$claude_lock" 2>/dev/null; do
    (( waited < 300 )) || {
      printf 'refusing: timed out acquiring %s\n' "$claude_lock" >&2
      exit 1
    }
    sleep 0.1
    waited=$((waited + 1))
  done
  trap 'rmdir "$claude_lock" 2>/dev/null || true' EXIT
  tmp="$(mktemp "${claude_json}.fly1439.XXXXXX")"
  mode="$(stat -f '%Lp' "$claude_json")"
  jq '
    .projects = (
      (.projects // {}) |
      with_entries(
        select(
          (
            (.key | startswith("/tmp/flywheel-test-slot-1")) or
            (.key | startswith("/private/tmp/flywheel-test-slot-1"))
          ) | not
        )
      )
    )
  ' "$claude_json" >"$tmp"
  chmod "$mode" "$tmp"
  mv "$tmp" "$claude_json"
  rmdir "$claude_lock"
  trap - EXIT
  trust_after="$(
    jq -r '[
      ((.projects // {}) | keys[]) |
      select(
        startswith("/tmp/flywheel-test-slot-1") or
        startswith("/private/tmp/flywheel-test-slot-1")
      )
    ] | length' "$claude_json"
  )"
  claude_after="$(shasum -a 256 "$claude_json" | awk '{print $1}')"
  [[ "$trust_after" == "0" ]]
fi

move_if_present() {
  local source="$1" name="$2"
  if [[ -e "$source" ]]; then
    mv "$source" "$quarantine/$name"
  fi
}
move_if_present "$slot_dir" slot-dir
move_if_present "$slot_lock" slot-lock
move_if_present "$comm_dir" comm-test-slot-1
move_if_present "$session_file" standard-session-id
move_if_present "$manifest_file" standard-manifest
move_if_present "$pid_file" standard-pid
move_if_present "$lead_workspace" global-test-lead-workspace

for path in \
  "$slot_dir" \
  "$slot_lock" \
  "$comm_dir" \
  "$session_file" \
  "$manifest_file" \
  "$pid_file" \
  "$lead_workspace"; do
  [[ ! -e "$path" ]]
done

{
  printf 'method=slot-only-manual-after-cmux-lease-refusal\n'
  printf 'slot_lead_window_present=false\n'
  printf 'bridge_port_19871_listening=false\n'
  printf 'foreign_slot_worktrees=0\n'
  printf 'trust_entries_before=%s\n' "$trust_before"
  printf 'trust_entries_after=%s\n' "$trust_after"
  printf 'claude_json_sha256_before=%s\n' "$claude_before"
  printf 'claude_json_sha256_after=%s\n' "$claude_after"
  printf 'standard_paths_absent=true\n'
  printf 'quarantine=%s\n' "$quarantine"
  find "$quarantine" -mindepth 1 -maxdepth 1 -print |
    sed 's#^.*/#quarantined=#' |
    sort
} >"$output"

# All required evidence lives in the repository. Remove the exact, validated
# quarantine only after the standard paths and trust cleanup have been proven.
find "$quarantine" -depth -delete
[[ ! -e "$quarantine" ]]
printf 'quarantine_deleted=true\n' >>"$output"
