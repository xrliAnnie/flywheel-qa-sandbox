#!/usr/bin/env bash
# FLY-2405: the room service owns physical locks until service reconciliation.
# A PID (including a dead PID or failure marker) never supersedes that claim.

qa_slot_has_service_claim() {
  [[ -e "$1/service-claim" || -L "$1/service-claim" ]]
}

qa_slot_service_claim_matches() {
  local lock="$1" token="${FLYWHEEL_QA_ROOM_CLAIM:-}"
  [[ -n "$token" && -d "$lock" && ! -L "$lock" \
    && -f "$lock/service-claim" && ! -L "$lock/service-claim" ]] || return 1
  jq -e --arg token "$token" '
    type == "object" and (.room_id | type == "string" and length > 0)
    and (.claim_token | type == "string" and length > 0)
    and .claim_token == $token
    and (.slots | type == "array" and length > 0)
    and all(.slots[]; type == "number" and floor == . and . > 0)
    and ((.slots | unique | length) == (.slots | length))
  ' "$lock/service-claim" >/dev/null 2>&1
}

qa_slot_claim_mismatch() {
  printf '[qa-slot-claim] claim_mismatch: %s\n' "$1" >&2
  return 1
}

# Deploy failure releases manual locks, but only marks the caller's service
# claim. Foreign/malformed claims are never removed or rewritten.
qa_release_slot_lock() {
  local lock="$1" marker="${2:-service-failed}" temp
  if qa_slot_has_service_claim "$lock"; then
    qa_slot_service_claim_matches "$lock" || { qa_slot_claim_mismatch "$lock"; return 1; }
    temp=$(mktemp "$lock/.service-pid.XXXXXX") || return 1
    if printf '%s\n' "$marker" > "$temp" && chmod 600 "$temp" && mv -f "$temp" "$lock/pid"; then
      return 0
    fi
    rm -f "$temp"
    return 1
  fi
  rm -rf "$lock"
}

# Read the full set from durable service ownership, which survives an early
# deploy failure and removal of SLOT_DIR. All locks must describe the same
# room, token, and ordered slot set (primary first). stdout lists those locks;
# no-env manual callers retain their existing manifest-based cleanup path.
qa_slot_teardown_claims() {
  local slot="$1" lock_root="${2:-/tmp}" claim room slots s lock
  [[ -n "${FLYWHEEL_QA_ROOM_CLAIM:-}" ]] || return 0
  [[ "$slot" =~ ^[1-9][0-9]*$ ]] || { qa_slot_claim_mismatch "$slot"; return 1; }
  lock="$lock_root/flywheel-test-slot-$slot.lock"
  qa_slot_service_claim_matches "$lock" || { qa_slot_claim_mismatch "$lock"; return 1; }
  claim="$lock/service-claim"
  jq -e --argjson slot "$slot" '.slots[0] == $slot' "$claim" >/dev/null 2>&1 \
    || { qa_slot_claim_mismatch "$claim"; return 1; }
  room=$(jq -r '.room_id' "$claim") || return 1
  slots=$(jq -c '.slots' "$claim") || return 1
  while IFS= read -r s; do
    lock="$lock_root/flywheel-test-slot-$s.lock"
    qa_slot_service_claim_matches "$lock" || { qa_slot_claim_mismatch "$lock"; return 1; }
    jq -e --arg room "$room" --argjson slots "$slots" \
      '.room_id == $room and .slots == $slots' "$lock/service-claim" >/dev/null 2>&1 \
      || { qa_slot_claim_mismatch "$lock"; return 1; }
  done < <(jq -r '.[]' <<< "$slots")
  while IFS= read -r s; do
    printf '%s\n' "$lock_root/flywheel-test-slot-$s.lock"
  done < <(jq -r '.[]' <<< "$slots")
}
