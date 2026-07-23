#!/usr/bin/env bash
# Keep the standard Lead's fixed session-id/manifest displaced while the
# companion probe runs. The trap restores both on normal exit or interruption.
set -euo pipefail

slot_dir="/tmp/flywheel-test-slot-1"
state_dir="${slot_dir}/s4-state"
session_file="${HOME}/.flywheel/claude-sessions/test-slot-1-flywheel-test-1.session-id"
manifest_file="${HOME}/.flywheel/manifests/test-slot-1-flywheel-test-1.json"
session_backup="${state_dir}/standard.session-id"
manifest_backup="${state_dir}/standard.manifest.json"
companion_session="${state_dir}/companion.session-id"
companion_manifest="${state_dir}/companion.manifest.json"
restored=0

mkdir -p "$state_dir"
if [[ ! -f "$session_file" || ! -f "$manifest_file" ]]; then
  printf 'standard session or manifest missing\n' >&2
  exit 1
fi
if [[ -e "$session_backup" || -e "$manifest_backup" ]]; then
  printf 'refusing existing S4 state backup\n' >&2
  exit 1
fi

restore() {
  if (( restored )); then
    return
  fi
  restored=1
  if [[ -f "$session_file" ]]; then
    mv "$session_file" "$companion_session"
  fi
  if [[ -f "$manifest_file" ]]; then
    mv "$manifest_file" "$companion_manifest"
  fi
  if [[ -f "$session_backup" ]]; then
    mv "$session_backup" "$session_file"
  fi
  if [[ -f "$manifest_backup" ]]; then
    mv "$manifest_backup" "$manifest_file"
  fi
  printf 'restored_at=%s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" \
    >"${state_dir}/restore.txt"
}
trap restore EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

mv "$session_file" "$session_backup"
mv "$manifest_file" "$manifest_backup"
{
  printf 'prepared_at=%s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  shasum -a 256 "$session_backup" "$manifest_backup"
} >"${state_dir}/prepared.txt"
printf 'S4_STATE_GUARD_READY\n'

while IFS= read -r command; do
  case "$command" in
    restore)
      exit 0
      ;;
    status)
      printf 'S4_STATE_GUARD_ACTIVE\n'
      ;;
    *)
      printf 'unknown command: %s\n' "$command" >&2
      ;;
  esac
done
