#!/usr/bin/env bash
# FLY-1671: best-effort Lead body provenance breadcrumbs.
# Source-only on macOS Bash 3.2. These records are observational: callers must
# never use them to decide restart success or Lead liveness.

LEAD_BODY_EVIDENCE_DIR="${LEAD_BODY_EVIDENCE_DIR:-${HOME}/.flywheel/state/lead-body-evidence}"

_lbe_safe_key() {
  [[ "${1:-}" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]]
}

_lbe_safe_start() {
  local value="${1:-}"
  [[ -n "$value" && "$value" != *$'\t'* && "$value" != *$'\n'* && "$value" != *$'\r'* ]]
}

lbe_record() (
  local project="${1:-}" lead="${2:-}" provenance="${3:-}"
  local body_pid="${4:-}" body_start="${5:-}"
  local carrier_pid="${6:-}" carrier_start="${7:-}"
  local now="${LEAD_BODY_EVIDENCE_NOW:-}" target="" tmp=""

  _lbe_safe_key "$project" && _lbe_safe_key "$lead" || return 1
  [[ "$provenance" == launched || "$provenance" == adopted ]] || return 1
  [[ "$body_pid" =~ ^[1-9][0-9]*$ && "$carrier_pid" =~ ^[1-9][0-9]*$ ]] || return 1
  _lbe_safe_start "$body_start" && _lbe_safe_start "$carrier_start" || return 1
  command -v jq >/dev/null 2>&1 || return 1

  [[ -n "$now" ]] || now="$(date +%s 2>/dev/null)"
  [[ "$now" =~ ^[0-9]+$ ]] || return 1
  [[ ! -L "$LEAD_BODY_EVIDENCE_DIR" ]] || return 1
  umask 077
  mkdir -p "$LEAD_BODY_EVIDENCE_DIR" || return 1
  [[ -d "$LEAD_BODY_EVIDENCE_DIR" && ! -L "$LEAD_BODY_EVIDENCE_DIR" ]] || return 1
  chmod 700 "$LEAD_BODY_EVIDENCE_DIR" 2>/dev/null || return 1

  target="${LEAD_BODY_EVIDENCE_DIR}/${project}-${lead}.json"
  tmp="${target}.tmp.$$"
  if jq -n \
      --arg projectName "$project" \
      --arg leadId "$lead" \
      --arg provenance "$provenance" \
      --argjson bodyPid "$body_pid" \
      --arg bodyStart "$body_start" \
      --argjson carrierPid "$carrier_pid" \
      --arg carrierStart "$carrier_start" \
      --argjson ts "$now" \
      '{schemaVersion:1, projectName:$projectName, leadId:$leadId,
        provenance:$provenance, bodyPid:$bodyPid, bodyStart:$bodyStart,
        carrierPid:$carrierPid, carrierStart:$carrierStart, ts:$ts}' \
      > "$tmp" \
    && chmod 600 "$tmp" \
    && mv "$tmp" "$target"; then
    return 0
  fi
  rm -f "$tmp" 2>/dev/null || true
  return 1
)

lbe_read_matching() {
  local project="${1:-}" lead="${2:-}" carrier_pid="${3:-}" carrier_start="${4:-}"
  local target=""
  _lbe_safe_key "$project" && _lbe_safe_key "$lead" || return 1
  [[ "$carrier_pid" =~ ^[1-9][0-9]*$ ]] || return 1
  _lbe_safe_start "$carrier_start" || return 1
  command -v jq >/dev/null 2>&1 || return 1
  target="${LEAD_BODY_EVIDENCE_DIR}/${project}-${lead}.json"
  [[ -f "$target" && ! -L "$target" ]] || return 1
  jq -er --arg project "$project" --arg lead "$lead" \
    --argjson carrierPid "$carrier_pid" --arg carrierStart "$carrier_start" '
      select(.schemaVersion == 1)
      | select(.projectName == $project and .leadId == $lead)
      | select(.carrierPid == $carrierPid and .carrierStart == $carrierStart)
      | select(.bodyPid | type == "number")
      | select(.bodyStart | type == "string" and length > 0)
      | .provenance
      | select(. == "launched" or . == "adopted")
    ' "$target" 2>/dev/null
}
