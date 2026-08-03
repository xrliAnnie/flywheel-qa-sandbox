#!/usr/bin/env bash
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/fly1602-daemon-refusal.XXXXXX")"
trap 'rm -rf "$TMP_ROOT"' EXIT
CALLS="$TMP_ROOT/launchctl.calls"
LAUNCHCTL="$TMP_ROOT/launchctl"
cat > "$LAUNCHCTL" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$CALLS"
EOF
chmod +x "$LAUNCHCTL"

PASS=0
FAIL=0
for target in --all eng-lead; do
  rc=0
  output="$(HOME="$TMP_ROOT/home" FLYWHEEL_DAEMON_LAUNCHCTL="$LAUNCHCTL" \
    bash "$ROOT/scripts/flywheel-daemon.sh" restart "$target" 2>&1)" || rc=$?
  if [[ "$rc" -eq 1 ]] \
    && grep -q 'restart-services.sh' <<<"$output" \
    && [[ ! -s "$CALLS" ]]; then
    PASS=$((PASS + 1))
    printf '[TEST] ok - restart %s refuses the unsafe Lead lifecycle shortcut\n' "$target"
  else
    FAIL=$((FAIL + 1))
    printf '[TEST] FAIL - restart %s rc=%s output=%s calls=%s\n' \
      "$target" "$rc" "$output" "$(cat "$CALLS" 2>/dev/null || true)" >&2
  fi
done

printf 'Results: %s passed, %s failed\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
