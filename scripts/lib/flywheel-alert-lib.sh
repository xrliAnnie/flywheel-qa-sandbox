#!/bin/bash
# Shared, best-effort shell alert adapter. Hosts choose the executable through
# FLYWHEEL_ALERT_BIN before sourcing this file; delivery can never fail a host.

flywheel_alert() {
  local kind="$1" severity="$2" title="$3" body="$4" signature="$5"
  local alert_bin="${FLYWHEEL_ALERT_BIN:-}"
  local rc=0
  if [[ -z "$alert_bin" || ! -x "$alert_bin" ]]; then
    printf '[flywheel-alert] WARN: alert executable unavailable: %s\n' "${alert_bin:-<unset>}" >&2
    return 0
  fi
  "$alert_bin" \
    --project flywheel \
    --lead flywheel-eng-lead \
    --kind "$kind" \
    --severity "$severity" \
    --title "$title" \
    --body "$body" \
    --signature "$signature" </dev/null >/dev/null || rc=$?
  if [[ "$rc" -ne 0 ]]; then
    printf '[flywheel-alert] WARN: delivery failed kind=%s rc=%s\n' "$kind" "$rc" >&2
  fi
  return 0
}
