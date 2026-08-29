#!/usr/bin/env bash
# FLY-247 inc2a (§2.1): batch-mode helpers for `flywheel-fleet.sh apply
# --changes-file`. Sourced by flywheel-fleet.sh (which provides file_sha via
# flywheel-daemon.sh); standalone-testable with a local file_sha fallback.
#
# This file holds the model-only batch's STRUCTURAL validation + the
# authorization-TOCTOU baseline gate (R2 #1): the founder confirmed a specific
# from→to transition, so before any mutation the engine re-verifies, under the
# config-write lock, that (a) the whole config SHA still equals the reviewed
# expectedConfigSha AND (b) every key's current model still equals its reviewed
# `from`. Any mismatch → reject the WHOLE batch, zero mutation.
#
# inc2a is model-only: a `backend` field anywhere in the request is rejected
# (managed backend switch = FLY-264). A `to.model` must be a string or JSON null
# (null = account default). batchId must match the safe txn-id grammar.

# Local file_sha fallback (the real one comes from flywheel-daemon.sh when this
# is sourced inside flywheel-fleet.sh).
if ! declare -f file_sha >/dev/null 2>&1; then
  file_sha() { shasum -a 256 "$1" 2>/dev/null | awk '{print $1}'; }
fi

FLEET_BATCH_SAFE_ID='^[A-Za-z0-9][A-Za-z0-9._-]*$'

# fleet_batch_validate_request <changes_file>
#   Structural validation only (no config access). Echoes a reason + non-zero
#   on failure.
fleet_batch_validate_request() {
  local cf="$1"
  [ -f "$cf" ] || { echo "changes-file not found: $cf" >&2; return 2; }
  jq empty "$cf" 2>/dev/null || { echo "changes-file is not valid JSON" >&2; return 2; }

  local batch_id
  batch_id=$(jq -r '.batchId // ""' "$cf")
  if ! printf '%s' "$batch_id" | grep -Eq "$FLEET_BATCH_SAFE_ID"; then
    echo "invalid batchId (must match ${FLEET_BATCH_SAFE_ID}): '${batch_id}'" >&2
    return 1
  fi
  if [ -z "$(jq -r '.expectedConfigSha // ""' "$cf")" ]; then
    echo "missing expectedConfigSha" >&2
    return 1
  fi
  # changes must be a non-empty array.
  if [ "$(jq -r '(.changes | type) // "null"' "$cf")" != "array" ] ||
     [ "$(jq -r '.changes | length' "$cf")" -eq 0 ]; then
    echo "changes must be a non-empty array" >&2
    return 1
  fi
  # Reject any backend field (inc2a is model-only; backend switch = FLY-264).
  if [ "$(jq -r '[.changes[] | (has("from") and (.from|has("backend"))),
                  (has("to") and (.to|has("backend"))), has("backend")]
                 | any' "$cf")" = "true" ]; then
    echo "backend changes are not supported in inc2a (managed backend switch = FLY-264)" >&2
    return 1
  fi
  # Each change: key matches grammar; to.model is string|null. FLY-671: when a
  # change touches effort (`to`/`from` has the key), it must be null or a valid
  # CLI level — the engine writes projects.json BEFORE cutover, so a bogus effort
  # must fail pre-accept, never reach the file (Codex design review R2 MEDIUM-4).
  local bad
  bad=$(jq -r --arg re "$FLEET_BATCH_SAFE_ID" '
    def okeffort($e): ($e == null) or (["low","medium","high","xhigh","max"] | index($e) != null);
    [ .changes[]
      | if (.key | type) != "string" then "non-string key"
        elif (.key | test($re) | not) then ("bad key grammar: " + (.key | tostring))
        elif (has("to") | not) then ("missing to: " + (.key | tostring))
        elif ((.to.model | type) as $t | ($t != "string" and $t != "null"))
          then ("to.model must be string|null: " + (.key | tostring))
        elif ((.to | has("effort")) and ((.to.effort | type) as $t | ($t != "string" and $t != "null")))
          then ("to.effort must be string|null: " + (.key | tostring))
        elif ((.to | has("effort")) and (okeffort(.to.effort) | not))
          then ("to.effort not a valid level: " + (.key | tostring))
        elif ((.from? // {} | has("effort")) and (okeffort(.from.effort) | not))
          then ("from.effort not a valid level: " + (.key | tostring))
        else empty end ] | (.[0] // "")' "$cf" 2>/dev/null)
  if [ -n "$bad" ]; then echo "$bad" >&2; return 1; fi

  # Duplicate keys within the batch are illegal.
  local n uniq
  n=$(jq -r '.changes | length' "$cf")
  uniq=$(jq -r '[.changes[].key] | unique | length' "$cf")
  if [ "$n" != "$uniq" ]; then
    echo "duplicate key(s) in changes" >&2
    return 1
  fi
  return 0
}

# fleet_batch_current_model <projects_json> <exact_key>
#   Echoes the lead's current model id, or the literal "null" if absent/missing.
fleet_batch_current_model() {
  local pj="$1" key="$2"
  jq -r --arg key "$key" '
    [ .[] | .projectName as $p | .leads[]
      | select(($p + "-" + .agentId) == $key) | (.model // null) ]
    | (.[0] // null) | if . == null then "null" else . end' "$pj" 2>/dev/null
}

# fleet_batch_write_key_model <projects_json> <exact_key> <model>
#   Atomically set (or delete, when <model> == "null") ONE lead's model field,
#   preserving everything else. MUST be called while holding the config-write
#   lock. Same-dir temp + validate + rename (no torn config). Echoes nothing;
#   non-zero on failure (config left untouched).
fleet_batch_write_key_model() {
  local pj="$1" key="$2" model="$3"
  local tmp="${pj}.write.$$"
  if jq --arg key "$key" --arg model "$model" '
        map( .projectName as $p
             | .leads |= map(
                 if ($p + "-" + .agentId) == $key
                 then (if $model == "null" then del(.model) else .model = $model end)
                 else . end ) )' "$pj" >"$tmp" 2>/dev/null &&
     jq empty "$tmp" 2>/dev/null; then
    # Preserve the original file mode across the rename.
    chmod "$(_fleet_batch_file_mode "$pj")" "$tmp" 2>/dev/null || true
    mv "$tmp" "$pj"
  else
    rm -f "$tmp"
    echo "failed to write model for ${key}" >&2
    return 1
  fi
}

# fleet_batch_current_effort <projects_json> <exact_key>
#   Echoes the lead's current effort, or the literal "null" if absent (FLY-671).
fleet_batch_current_effort() {
  local pj="$1" key="$2"
  jq -r --arg key "$key" '
    [ .[] | .projectName as $p | .leads[]
      | select(($p + "-" + .agentId) == $key) | (.effort // null) ]
    | (.[0] // null) | if . == null then "null" else . end' "$pj" 2>/dev/null
}

# fleet_batch_write_key_fields <pj> <key> <model> <touch_effort> <effort>
#   FLY-671 COMPOSITE atomic write (Codex design review R2 BLOCKER-2): set/delete
#   model AND (when <touch_effort> = "1") set/delete effort in ONE jq + temp +
#   rename — never two independent writes (a crash between them would leave a
#   half-mutated config with no symmetric restore). When <touch_effort> = "0",
#   effort is left exactly as-is (the model-only path; byte-identical jq output to
#   fleet_batch_write_key_model). "null" means delete that field. MUST hold the lock.
fleet_batch_write_key_fields() {
  local pj="$1" key="$2" model="$3" touch_effort="$4" effort="${5:-null}"
  local tmp="${pj}.write.$$"
  if jq --arg key "$key" --arg model "$model" \
        --arg touch "$touch_effort" --arg effort "$effort" '
        map( .projectName as $p
             | .leads |= map(
                 if ($p + "-" + .agentId) == $key
                 then (if $model == "null" then del(.model) else .model = $model end)
                      | (if $touch == "1"
                         then (if $effort == "null" then del(.effort) else .effort = $effort end)
                         else . end)
                 else . end ) )' "$pj" >"$tmp" 2>/dev/null &&
     jq empty "$tmp" 2>/dev/null; then
    chmod "$(_fleet_batch_file_mode "$pj")" "$tmp" 2>/dev/null || true
    mv "$tmp" "$pj"
  else
    rm -f "$tmp"
    echo "failed to write fields for ${key}" >&2
    return 1
  fi
}

# fleet_batch_restore_key_fields <pj> <key> <written_model> <orig_model> \
#                                <touch_effort> <written_effort> <orig_effort>
#   FLY-671 COMPOSITE conditional restore: restore BOTH original values ONLY if
#   the current state still equals what THIS batch wrote (model, AND effort when
#   touched). If an external writer changed either, do NOT clobber → return 2
#   (config-restore-conflict). One atomic write. MUST hold the lock.
fleet_batch_restore_key_fields() {
  local pj="$1" key="$2" written_model="$3" orig_model="$4"
  local touch_effort="$5" written_effort="${6:-null}" orig_effort="${7:-null}"
  local cur_model cur_effort
  cur_model=$(fleet_batch_current_model "$pj" "$key")
  if [ "$cur_model" != "$written_model" ]; then
    echo "config-restore-conflict for ${key}: model current='${cur_model}' != written='${written_model}'" >&2
    return 2
  fi
  if [ "$touch_effort" = "1" ]; then
    cur_effort=$(fleet_batch_current_effort "$pj" "$key")
    if [ "$cur_effort" != "$written_effort" ]; then
      echo "config-restore-conflict for ${key}: effort current='${cur_effort}' != written='${written_effort}'" >&2
      return 2
    fi
  fi
  fleet_batch_write_key_fields "$pj" "$key" "$orig_model" "$touch_effort" "$orig_effort"
}

# fleet_batch_restore_key <projects_json> <exact_key> <written_to> <original_from>
#   Conditional restore (R2 #4): restore the key's model to <original_from> ONLY
#   if its current value still equals <written_to> (i.e. THIS batch's write is
#   still in place). If an external writer changed it, do NOT clobber — return 2
#   (config-restore-conflict). MUST hold the config-write lock.
fleet_batch_restore_key() {
  local pj="$1" key="$2" written_to="$3" original_from="$4"
  local cur; cur=$(fleet_batch_current_model "$pj" "$key")
  if [ "$cur" != "$written_to" ]; then
    echo "config-restore-conflict for ${key}: current='${cur}' != written='${written_to}'" >&2
    return 2
  fi
  fleet_batch_write_key_model "$pj" "$key" "$original_from"
}

# Portable file-mode reader (GNU stat -c, BSD stat -f).
_fleet_batch_file_mode() {
  stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1" 2>/dev/null || echo 600
}

# fleet_batch_verify_baseline <changes_file> <projects_json>
#   The authorization-TOCTOU gate (R2 #1). MUST be called while holding the
#   config-write lock. Verifies whole-config SHA == expectedConfigSha AND every
#   change's current model == its reviewed `from.model`. Reject → non-zero +
#   reason; zero mutation either way (read-only).
fleet_batch_verify_baseline() {
  local cf="$1" pj="$2"
  [ -f "$pj" ] || { echo "projects.json not found: $pj" >&2; return 2; }

  local expected actual
  expected=$(jq -r '.expectedConfigSha' "$cf")
  actual=$(file_sha "$pj")
  if [ "$expected" != "$actual" ]; then
    echo "config changed since stage (expected ${expected:0:12}…, got ${actual:0:12}…) — re-confirm" >&2
    return 1
  fi

  # Per-key from-value re-check (defense in depth even with the SHA match).
  local i count
  count=$(jq -r '.changes | length' "$cf")
  for ((i = 0; i < count; i++)); do
    local key from cur
    key=$(jq -r --argjson i "$i" '.changes[$i].key' "$cf")
    from=$(jq -r --argjson i "$i" '.changes[$i].from.model // null
            | if . == null then "null" else . end' "$cf")
    cur=$(fleet_batch_current_model "$pj" "$key")
    if [ "$from" != "$cur" ]; then
      echo "baseline mismatch for ${key}: reviewed model from='${from}' but current='${cur}'" >&2
      return 1
    fi
    # FLY-671: check the effort baseline ONLY when the reviewed `from` carries the
    # effort key (a model-only change has no from.effort → skip; three-state).
    local has_from_effort
    has_from_effort=$(jq -r --argjson i "$i" '.changes[$i].from | has("effort")' "$cf")
    if [ "$has_from_effort" = "true" ]; then
      local from_e cur_e
      from_e=$(jq -r --argjson i "$i" '.changes[$i].from.effort // null
                | if . == null then "null" else . end' "$cf")
      cur_e=$(fleet_batch_current_effort "$pj" "$key")
      if [ "$from_e" != "$cur_e" ]; then
        echo "baseline mismatch for ${key}: reviewed effort from='${from_e}' but current='${cur_e}'" >&2
        return 1
      fi
    fi
  done
  return 0
}

# ════════════════════════════════════════════════════════════════
# Orchestration (§2.1): assemble the primitives into a batch apply.
# ════════════════════════════════════════════════════════════════

# Path to THIS lib (for re-invoking locked ops as a subprocess under the flock).
_FLEET_BATCH_LIB="${BASH_SOURCE[0]}"

# Default per-key cutover: reuse inc1's single-key apply (acquires its own
# restart.lock.d, does the staged plist/bootout/bootstrap/verify, rolls back on
# failure). Overridable via FLEET_BATCH_CUTOVER_CMD for tests.
_fleet_batch_default_cutover() {
  local key="$1"
  "${FLEET_FLEET_BIN:-${_FLEET_BATCH_LIB%/*}/flywheel-fleet.sh}" \
    apply --lead "$key" --yes
}

# fleet_batch_apply <changes_file> <projects_json>
#   Drives the model-only batch. The launching journal record must already
#   exist (the API creates it before spawn). Requires config_write_locked
#   (lock lib) and batch_journal_* (journal lib) to be sourced.
fleet_batch_apply() {
  local cf="$1" pj="$2"
  local batch_id; batch_id=$(jq -r '.batchId' "$cf")
  local lock="${FLEET_CONFIG_LOCK_FILE:-${pj}.cfglock}"
  local deadline="${FLEET_CONFIG_LOCK_DEADLINE:-5}"
  local cutover="${FLEET_BATCH_CUTOVER_CMD:-_fleet_batch_default_cutover}"

  # env-pinned reject — pre-accept, zero mutation (R8 #4 audit/journal kept).
  if [ -n "${FLYWHEEL_PROJECTS:-}" ]; then
    batch_journal_set_status "$batch_id" rejected
    echo "FLYWHEEL_PROJECTS is set — refusing batch (split-brain)" >&2
    return 1
  fi

  # Claim ownership FIRST, FAIL-CLOSED (Codex R3 HIGH-2a): establishes engine
  # liveness for startup reconciliation BEFORE any mutation. This is the linchpin
  # that closes the recover-vs-CAS race: the engine only proceeds past this point
  # with a published owner sidecar, so reconcile always sees it alive and never
  # recovers it — a concurrent recover→rejected therefore cannot race the CAS
  # below. If ownership can't be published, abort with zero mutation.
  if ! batch_journal_claim_owner "$batch_id" "$$"; then
    batch_journal_set_status "$batch_id" rejected
    echo "could not claim batch ownership for ${batch_id} — aborting, zero mutation" >&2
    return 1
  fi

  # Pre-accept baseline authorization gate, under the config-write lock. First
  # config-lock contention here is whole-batch 'rejected' (still launching).
  if ! config_write_locked "$lock" "$deadline" \
        bash "$_FLEET_BATCH_LIB" verify-baseline "$cf" "$pj"; then
    batch_journal_set_status "$batch_id" rejected
    return 1
  fi

  # Pre-accept gate passed → CAS launching → running. If a concurrent recover
  # already moved this batch off launching (e.g. → rejected), abort with zero
  # mutation rather than overwriting that decision (Codex R2 HIGH-2).
  if ! batch_journal_cas_running "$batch_id"; then
    echo "batch ${batch_id} no longer launching (concurrent recover?) — aborting, zero mutation" >&2
    return 1
  fi

  local n i stop=0
  n=$(jq -r '.changes | length' "$cf")
  for ((i = 0; i < n; i++)); do
    local key to from touch_effort to_e from_e
    key=$(jq -r --argjson i "$i" '.changes[$i].key' "$cf")
    to=$(jq -r --argjson i "$i" '.changes[$i].to.model // null
          | if . == null then "null" else . end' "$cf")
    from=$(jq -r --argjson i "$i" '.changes[$i].from.model // null
          | if . == null then "null" else . end' "$cf")
    # FLY-671 three-state: touch effort ONLY when `to` carries the key.
    touch_effort=$(jq -r --argjson i "$i" 'if .changes[$i].to | has("effort") then "1" else "0" end' "$cf")
    to_e=$(jq -r --argjson i "$i" '.changes[$i].to.effort // null | if . == null then "null" else . end' "$cf")
    from_e=$(jq -r --argjson i "$i" '.changes[$i].from.effort // null | if . == null then "null" else . end' "$cf")

    if [ "$stop" = "1" ]; then
      batch_key_set_status "$batch_id" "$key" skipped
      continue
    fi

    # ① write-ahead config-writing → composite (model + effort) write under lock.
    batch_key_set_status "$batch_id" "$key" config-writing
    if ! config_write_locked "$lock" "$deadline" \
          bash "$_FLEET_BATCH_LIB" write-key-fields "$pj" "$key" "$to" "$touch_effort" "$to_e"; then
      # Per-key forward-write contention (already accepted) → unapplied, stop.
      batch_key_set_status "$batch_id" "$key" unapplied
      stop=1
      continue
    fi
    batch_key_set_status "$batch_id" "$key" config-written

    # ② cutover (delegated; reuses inc1 single-key apply in production).
    batch_key_set_status "$batch_id" "$key" applying
    if "$cutover" "$key"; then
      batch_key_set_status "$batch_id" "$key" applied
      continue
    fi

    # ③ cutover failed → composite conditional restore under the lock, then stop.
    batch_key_set_status "$batch_id" "$key" config-restoring
    config_write_locked "$lock" "$deadline" \
      bash "$_FLEET_BATCH_LIB" restore-key-fields "$pj" "$key" "$to" "$from" "$touch_effort" "$to_e" "$from_e"
    case $? in
      0)  batch_key_set_status "$batch_id" "$key" failed-restored ;;
      2)  batch_key_set_status "$batch_id" "$key" config-restore-conflict ;;
      *)  batch_key_set_status "$batch_id" "$key" manual-intervention ;;
    esac
    stop=1
  done

  # Terminal reduction (all→applied / mixed→partially-applied / zero→failed).
  batch_journal_reduce "$batch_id" >/dev/null
  [ "$(batch_journal_status "$batch_id")" = "applied" ]
}

# Internal locked-op dispatch: config_write_locked invokes `bash <lib> <op>...`
# so each critical section runs (and releases the lock) as a short subprocess.
# Guard strictly on executed-vs-sourced (BASH_SOURCE==$0) — do NOT gate on an
# env var, which a parent could export and accidentally disable the dispatch in
# the locked-op subprocess.
if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
  _op="${1:-}"; shift || true
  case "$_op" in
    verify-baseline)    fleet_batch_verify_baseline "$@" ;;
    write-key)          fleet_batch_write_key_model "$@" ;;
    restore-key)        fleet_batch_restore_key "$@" ;;
    write-key-fields)   fleet_batch_write_key_fields "$@" ;;   # FLY-671 composite
    restore-key-fields) fleet_batch_restore_key_fields "$@" ;; # FLY-671 composite
    *) echo "flywheel-fleet-batch.sh: unknown op '${_op}'" >&2; exit 64 ;;
  esac
  exit $?
fi

# ════════════════════════════════════════════════════════════════
# Recovery (§2.1/§2.5): reconcile an interrupted batch after a crash.
# ════════════════════════════════════════════════════════════════

# fleet_batch_reconcile_key <projects_json> <batch_id> <key>
#   Reconcile ONE non-terminal key using config presence + journaled status.
fleet_batch_reconcile_key() {
  local pj="$1" bid="$2" key="$3"
  local path st to from cur touch_effort to_e from_e cur_e
  path="$(batch_journal_path "$bid")"
  st=$(batch_key_status "$bid" "$key")
  to=$(jq -r --arg k "$key" '.keys[$k].to.model // null | if .==null then "null" else . end' "$path")
  from=$(jq -r --arg k "$key" '.keys[$k].from.model // null | if .==null then "null" else . end' "$path")
  cur=$(fleet_batch_current_model "$pj" "$key")
  # FLY-671 composite: recover the effort dimension too, three-state.
  touch_effort=$(jq -r --arg k "$key" 'if .keys[$k].to | has("effort") then "1" else "0" end' "$path")
  to_e=$(jq -r --arg k "$key" '.keys[$k].to.effort // null | if .==null then "null" else . end' "$path")
  from_e=$(jq -r --arg k "$key" '.keys[$k].from.effort // null | if .==null then "null" else . end' "$path")
  cur_e=$(fleet_batch_current_effort "$pj" "$key")
  case "$st" in
    applied|failed-restored|config-restore-conflict|skipped|unapplied|manual-intervention)
      : ;; # already terminal — leave as-is
    pending)
      # never started its write → safe to skip.
      batch_key_set_status "$bid" "$key" skipped ;;
    config-writing)
      # crashed around the forward write: did the (atomic) composite write land?
      # The write set model AND (when touched) effort in ONE op, so "landed" means
      # BOTH match what THIS batch intended.
      local landed=1
      [ "$cur" = "$to" ] || landed=0
      if [ "$touch_effort" = "1" ] && [ "$cur_e" != "$to_e" ]; then landed=0; fi
      if [ "$landed" = "1" ]; then
        # config ahead of the carrier (cutover never confirmed) → needs a human
        # / the inner inc1 recover; surface it, don't silently claim applied.
        batch_key_set_status "$bid" "$key" manual-intervention
      else
        batch_key_set_status "$bid" "$key" unapplied
      fi ;;
    config-written|applying)
      # config written, cutover state unknown → manual intervention.
      batch_key_set_status "$bid" "$key" manual-intervention ;;
    config-restoring)
      # finish the composite conditional restore if THIS batch's values are still present.
      if fleet_batch_restore_key_fields "$pj" "$key" "$to" "$from" "$touch_effort" "$to_e" "$from_e" 2>/dev/null; then
        batch_key_set_status "$bid" "$key" failed-restored
      else
        batch_key_set_status "$bid" "$key" config-restore-conflict
      fi ;;
  esac
}

# fleet_batch_recover <projects_json> <batch_id>
#   Reconcile an interrupted batch. Echoes the resulting BatchStatus.
#   launching (pre-accept, zero mutation) → rejected; running/recover-required →
#   per-key reconcile then recover-required (if any key needs a human) else
#   terminal reduction. Terminal batches are returned unchanged.
fleet_batch_recover() {
  local pj="$1" bid="$2"
  local path; path="$(batch_journal_path "$bid")"
  [ -f "$path" ] || { echo "no batch journal: ${bid}" >&2; return 1; }
  local st; st=$(batch_journal_status "$bid")
  case "$st" in
    applied|partially-applied|failed|rejected)
      printf '%s' "$st"; return 0 ;;
    launching)
      batch_journal_set_status "$bid" rejected; printf 'rejected'; return 0 ;;
    running|recover-required)
      local k
      while IFS= read -r k; do
        [ -n "$k" ] && fleet_batch_reconcile_key "$pj" "$bid" "$k"
      done < <(jq -r '.keys | keys[]' "$path")
      if [ "$(jq -r '[.keys[].status]
                     | any(. == "manual-intervention" or . == "config-restore-conflict")' "$path")" = "true" ]; then
        batch_journal_set_status "$bid" recover-required; printf 'recover-required'
      else
        batch_journal_reduce "$bid"
      fi
      return 0 ;;
    *)
      echo "unknown batch status: ${st}" >&2; return 1 ;;
  esac
}
