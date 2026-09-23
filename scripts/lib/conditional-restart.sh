#!/usr/bin/env bash
# FLY-2654: final fail-closed guard for Lead closeout standing-authority waves
# and already-started v2 recovery. Scheduled, manual, and founder-direct waves
# are deliberately unchanged.

conditional_restart_is_sha40() { [[ "${1:-}" =~ ^[0-9a-f]{40}$ ]]; }

conditional_restart_final_check() {
    local ticket="${FLYWHEEL_URGENT_RESTART_TICKET:-}"
    local target="${FLYWHEEL_URGENT_RESTART_TARGET_SHA:-}"
    local from="${FLYWHEEL_URGENT_RESTART_FROM_SHA:-}"
    local pre_merge="${FLYWHEEL_URGENT_RESTART_PRE_MERGE_HEAD:-}"
    local trigger="${FLYWHEEL_URGENT_RESTART_TRIGGER_SHA:-}"
    local wave_id="${FLYWHEEL_URGENT_RESTART_WAVE_ID:-}"
    local index="${FLYWHEEL_URGENT_RESTART_INDEX:-${HOME}/.flywheel/restart-request-index.json}"
    local node_bin="${FLYWHEEL_URGENT_RESTART_NODE:-node}"
    local cli="${FLYWHEEL_URGENT_RESTART_CLI:-${FLYWHEEL_DIR}/packages/teamlead/dist/bin/restart-request.js}"
    local head="" remote="" deployed="" request_id="" digest="" schema="" state="" ticket_wave=""

    [[ -n "$ticket" ]] || return 0
    [[ -f "$ticket" && ! -L "$ticket" && -f "$index" && ! -L "$index" ]] || return 1
    conditional_restart_is_sha40 "$target" && conditional_restart_is_sha40 "$from" \
        && conditional_restart_is_sha40 "$pre_merge" && conditional_restart_is_sha40 "$trigger" || return 1
    [[ -n "$wave_id" && -f "$cli" && ! -L "$cli" ]] || return 1
    head="$(git -C "$FLYWHEEL_DIR" rev-parse HEAD 2>/dev/null)" || return 1
    remote="$(git -C "$FLYWHEEL_DIR" rev-parse origin/main 2>/dev/null)" || return 1
    IFS= read -r deployed < "$DEPLOYED_SHA_FILE" || return 1
    [[ "$head" == "$target" && "$remote" == "$target" && "$deployed" == "$from" ]] || return 1
    [[ -z "$(git -C "$FLYWHEEL_DIR" status --porcelain 2>/dev/null)" ]] || return 1
    git -C "$FLYWHEEL_DIR" merge-base --is-ancestor "$trigger" "$target" 2>/dev/null || return 1
    schema="$(jq -er .schemaVersion "$ticket" 2>/dev/null)" || return 1
    case "$schema" in
      3)
        request_id="$(jq -er .decisionId "$ticket" 2>/dev/null)" || return 1
        ticket_wave="$(jq -er '.waveId | select(type == "string" and length > 0)' "$ticket" 2>/dev/null)" || return 1
        [[ "$ticket_wave" == "$wave_id" ]] || return 1
        ;;
      2)
        request_id="$(jq -er .requestId "$ticket" 2>/dev/null)" || return 1
        ;;
      *) return 1 ;;
    esac
    digest="$(jq -er .requestDigest "$ticket" 2>/dev/null)" || return 1
    state="$("$node_bin" "$cli" intent-state --ticket "$ticket" --index "$index" 2>/dev/null)" || return 1
    if [[ "$schema" == 3 ]]; then
        [[ "$state" == prepared ]] || return 1
        "$node_bin" "$cli" verify --ticket "$ticket" --home "$HOME" \
            --deployed-sha "$from" --remote-sha "$target" \
            --pre-merge-head "$pre_merge" --contains-trigger >/dev/null || return 1
        # This is the only v3 prepared -> started boundary. It runs after every
        # mutable source was re-enumerated and immediately before stop_bridge.
        "$node_bin" "$cli" transition --ticket "$ticket" --index "$index" \
            --state started --wave-id "$wave_id" \
            --at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >/dev/null || return 1
    else
        [[ "$state" == started ]] || return 1
        "$node_bin" "$cli" verify --ticket "$ticket" --home "$HOME" \
            --deployed-sha "$from" --remote-sha "$target" \
            --pre-merge-head "$pre_merge" --contains-trigger \
            --allow-started-v2-recovery --index "$index" >/dev/null || return 1
    fi
    jq -e --arg request_id "$request_id" --arg digest "$digest" --arg wave "$wave_id" '
        .schemaVersion == 1 and
        ([.intents[] | select(.requestId == $request_id and .requestDigest == $digest and .state == "started" and .waveId == $wave)] | length) == 1
    ' "$index" >/dev/null 2>&1
}

conditional_restart_restore_premerge() {
    local target="${FLYWHEEL_URGENT_RESTART_TARGET_SHA:-}"
    local from="${FLYWHEEL_URGENT_RESTART_FROM_SHA:-}"
    local pre_merge="${FLYWHEEL_URGENT_RESTART_PRE_MERGE_HEAD:-}"
    local head="" deployed=""
    conditional_restart_is_sha40 "$target" && conditional_restart_is_sha40 "$from" \
        && conditional_restart_is_sha40 "$pre_merge" || return 1
    head="$(git -C "$FLYWHEEL_DIR" rev-parse HEAD 2>/dev/null)" || return 1
    IFS= read -r deployed < "$DEPLOYED_SHA_FILE" || return 1
    [[ "$head" == "$target" && "$deployed" == "$from" ]] || return 1
    [[ -z "$(git -C "$FLYWHEEL_DIR" status --porcelain 2>/dev/null)" ]] || return 1
    git -C "$FLYWHEEL_DIR" cat-file -e "${pre_merge}^{commit}" 2>/dev/null || return 1
    git -C "$FLYWHEEL_DIR" reset --hard "$pre_merge" >/dev/null
}
