#!/usr/bin/env bash
# FLY-1573 — sourceable deployment readiness barrier helpers.
# State/env mutations are delegated to the built TypeScript core so deploy,
# Bridge direct-toggle, and operator rollback all contend on the same .env.lock.

MQB_ENV_FILE="${MQB_ENV_FILE:-${ENV_FILE:-${HOME}/.flywheel/.env}}"
MQB_MARKER_FILE="${MQB_MARKER_FILE:-${HOME}/.flywheel/state/mailbox-queue-deploy-barrier.json}"
MQB_CLI="${MQB_CLI:-${FLYWHEEL_DIR}/packages/teamlead/dist/bridge/mailbox-queue-deploy-barrier-cli.js}"
MQB_ACK_PROBE="${MQB_ACK_PROBE:-${FLYWHEEL_DIR}/packages/teamlead/dist/bridge/mailbox-queue-ack-readiness-probe.js}"
MQB_OWNED=false
MQB_TOKEN=""
MQB_ACTIVE=false

mqb_log() {
    if declare -F log >/dev/null 2>&1; then log "$*"; else echo "[mailbox-queue-barrier] $*" >&2; fi
}

mqb_target_has_queue() {
    local sha="$1"
    [[ "$sha" =~ ^[0-9a-f]{40}$ ]] || return 1
    git -C "$FLYWHEEL_DIR" show "${sha}:packages/config/src/feature-flags/registry.ts" 2>/dev/null \
        | grep -q 'name: "mailbox_queue"'
}

# First capability rollout only, plus any interrupted marker for this target.
mqb_upgrade_requires_barrier() {
    local old_sha="$1" target_sha="$2"
    if [[ -r "$MQB_MARKER_FILE" ]] \
      && jq -e --arg sha "$target_sha" '.targetSha == $sha and .phase != "operator_override"' \
        "$MQB_MARKER_FILE" >/dev/null 2>&1; then
        return 0
    fi
    mqb_target_has_queue "$target_sha" || return 1
    mqb_target_has_queue "$old_sha" && return 1
    return 0
}

mqb_begin() {
    local target_sha="$1" result
    [[ -f "$MQB_CLI" ]] || { mqb_log "ERROR: barrier CLI missing: $MQB_CLI"; return 1; }
    if ! result=$(node "$MQB_CLI" begin --env "$MQB_ENV_FILE" --target "$target_sha"); then
        mqb_log "ERROR: readiness barrier begin failed: $result"
        return 1
    fi
    MQB_OWNED=$(jq -r '.owned // false' <<<"$result")
    MQB_TOKEN=$(jq -r '.token // ""' <<<"$result")
    MQB_ACTIVE=true
    if [[ "$MQB_OWNED" == "true" ]]; then
        [[ -n "$MQB_TOKEN" ]] || { mqb_log "ERROR: owned barrier returned no token"; return 1; }
        export FLYWHEEL_MAILBOX_QUEUE=0
        mqb_log "Mailbox queue held OFF by deploy-owned readiness barrier"
    elif jq -e '.operatorOff == true' <<<"$result" >/dev/null 2>&1; then
        export FLYWHEEL_MAILBOX_QUEUE=0
        mqb_log "Mailbox queue already operator-OFF; deploy will not auto-release it"
    else
        mqb_log "Mailbox queue barrier already released for this target"
    fi
}

mqb_hold() {
    local target_sha="$1" reason="$2" result
    [[ "$MQB_OWNED" == "true" ]] || return 0
    if ! result=$(node "$MQB_CLI" hold --env "$MQB_ENV_FILE" --target "$target_sha" \
        --token "$MQB_TOKEN" --message "$reason"); then
        mqb_log "ERROR: could not persist readiness hold: $result"
        return 1
    fi
    export FLYWHEEL_MAILBOX_QUEUE=0
    mqb_log "Mailbox queue remains OFF: $reason"
}

mqb_probe_ack_tools() {
    [[ -f "$MQB_ACK_PROBE" ]] || {
        mqb_log "ERROR: ACK readiness probe missing: $MQB_ACK_PROBE"
        return 1
    }
    node "$MQB_ACK_PROBE"
}

mqb_mark_ready() {
    local target_sha="$1" evidence="$2" result
    [[ "$MQB_OWNED" == "true" ]] || return 0
    if ! result=$(node "$MQB_CLI" ready --env "$MQB_ENV_FILE" --target "$target_sha" \
        --token "$MQB_TOKEN" --message "$evidence"); then
        mqb_log "ERROR: could not mark readiness: $result"
        return 1
    fi
}

mqb_release_via_bridge() {
    local target_sha="$1" bridge_url="$2" origin payload response
    [[ "$MQB_OWNED" == "true" ]] || return 0
    origin="${bridge_url%/}"
    payload=$(jq -n --arg targetSha "$target_sha" --arg ownershipToken "$MQB_TOKEN" \
        '{targetSha: $targetSha, ownershipToken: $ownershipToken}') || return 1
    if ! response=$(curl -sf -X POST "${origin}/api/fleet/mailbox-queue-barrier/release" \
        -H "Origin: ${origin}" -H "Content-Type: application/json" \
        --max-time 10 --data-binary @- <<<"$payload"); then
        mqb_log "ERROR: Bridge readiness release request failed"
        return 1
    fi
    if ! jq -e '.ok == true and .released == true' <<<"$response" >/dev/null; then
        mqb_log "ERROR: Bridge denied readiness release: $response"
        return 1
    fi
    unset FLYWHEEL_MAILBOX_QUEUE
    MQB_OWNED=false
    mqb_log "Mailbox queue readiness barrier released; default-ON is live and persisted"
}

# Out-of-band runbook primitive. Call this before restart-services.sh when the
# Bridge/console is unavailable. It revokes a deploy owner even for OFF→OFF.
mqb_operator_off() {
    local reason="${1:-out-of-band operator rollback}" result
    [[ -f "$MQB_CLI" ]] || return 1
    if ! result=$(node "$MQB_CLI" operator-off --env "$MQB_ENV_FILE" --message "$reason"); then
        mqb_log "ERROR: operator OFF failed: $result"
        return 1
    fi
    export FLYWHEEL_MAILBOX_QUEUE=0
    mqb_log "Mailbox queue operator OFF persisted"
}
