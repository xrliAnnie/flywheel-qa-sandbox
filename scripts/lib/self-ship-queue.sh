#!/usr/bin/env bash
# FLY-270: self-hosting ship — durable queue + singleton-lock primitives.
#
# These helpers back the self-surgery control plane (Method B): a flywheel-repo
# Runner hands a merged ship to the detached launchd updater instead of running
# `restart-services.sh` inline (which would deadlock on its own active session
# and tear down the coordinating Eng Lead). Durability is provided by launchd
# `QueueDirectories` watching the pending dir; these helpers implement the
# directory state machine + at-least-once acknowledgement + a singleton lock
# that covers the git phase and survives crashes.
#
# Sourced by scripts/self-ship-restart.sh (handoff) and scripts/update-flywheel.sh
# (updater). Sourceable for unit tests via SELF_SHIP_QUEUE_SOURCED=1 (so the file
# never auto-runs). All directories are env-overridable for hermetic tests.
#
# Design contract (codex-design-review R1–R5, v1.47.0-FLY-270 §2.2):
#   • watched pending dir holds ONLY complete, actionable <sha>.<nonce>.json.
#     Temp is written OUTSIDE the watched dir then atomically mv'd in, so the
#     updater is never launched against a half-written marker.
#   • blocked / corrupt / unknown markers move to a SEPARATE dir that is NOT
#     watched by QueueDirectories — otherwise a permanently-failing marker keeps
#     the pending dir non-empty and launchd hot-loops the job forever.
#   • attempts / nextAttemptAt persist IN the marker (not shell memory) so they
#     survive launchd re-launches and actually reach the backoff threshold.
#   • the singleton lock reclaims a stale holder only when the owner PID is dead
#     OR its identity no longer matches the updater — never purely on age (a
#     long, legitimately-sleeping updater must not be evicted).

set -uo pipefail

# ── Directory layout (env-overridable for tests) ───────────────────────────
: "${FLYWHEEL_HOME:=${HOME}/.flywheel}"
SELF_SHIP_PENDING_DIR="${SELF_SHIP_PENDING_DIR:-${FLYWHEEL_HOME}/self-ship-pending.d}"
SELF_SHIP_BLOCKED_DIR="${SELF_SHIP_BLOCKED_DIR:-${FLYWHEEL_HOME}/self-ship-blocked.d}"
SELF_SHIP_TMP_DIR="${SELF_SHIP_TMP_DIR:-${FLYWHEEL_HOME}/self-ship-tmp}"
SELF_SHIP_LOCK_DIR="${SELF_SHIP_LOCK_DIR:-${FLYWHEEL_HOME}/self-ship-updater.lock.d}"

# Backoff policy (env-overridable for tests).
SELF_SHIP_MAX_ATTEMPTS="${SELF_SHIP_MAX_ATTEMPTS:-5}"      # deterministic-failure threshold → block
SELF_SHIP_BASE_BACKOFF="${SELF_SHIP_BASE_BACKOFF:-30}"      # seconds, doubled per attempt
SELF_SHIP_MAX_BACKOFF="${SELF_SHIP_MAX_BACKOFF:-1800}"      # 30 min cap per retry
SELF_SHIP_RESCAN_INTERVAL="${SELF_SHIP_RESCAN_INTERVAL:-60}" # max sleep between rescans (head-of-line guard)
SELF_SHIP_LOCK_STALE_AGE="${SELF_SHIP_LOCK_STALE_AGE:-7200}" # 2h secondary guard

# ── Small utilities ─────────────────────────────────────────────────────────

ssq_log() { echo "[self-ship-queue] $*" >&2; }

# Epoch seconds. Wrapper so tests can pin time via SELF_SHIP_NOW.
ssq_now() { echo "${SELF_SHIP_NOW:-$(date +%s)}"; }

ssq_is_sha40() { [[ "${1:-}" =~ ^[0-9a-f]{40}$ ]]; }

ssq_init_dirs() {
  local d
  for d in "$SELF_SHIP_PENDING_DIR" "$SELF_SHIP_BLOCKED_DIR" "$SELF_SHIP_TMP_DIR"; do
    mkdir -p "$d" 2>/dev/null || true
    chmod 700 "$d" 2>/dev/null || true
  done
}

# ── Enqueue (handoff side) ──────────────────────────────────────────────────
# ssq_enqueue <40hex-merge-sha> <pr-number> [nonce]
# Writes a complete marker to a temp file OUTSIDE the watched dir, then renames
# it into the pending dir (atomic on same fs). Refuses non-40hex SHAs (fail-close
# — a feature HEAD or empty value must never become a marker that can never ack).
# Echoes the final marker path on success.
ssq_enqueue() {
  # FLY-727: optional 4th arg `issue` (e.g. FLY-727) is recorded in the marker so
  # the self-ship ack point can report a high-fidelity deployment event. Backward
  # compatible: old 2-3 arg callers still work; markers without `issueIdentifier`
  # are still deployable and ack a PR-only deployment event.
  local sha="${1:-}" pr="${2:-}" nonce="${3:-}" issue="${4:-}"
  if ! ssq_is_sha40 "$sha"; then
    ssq_log "refusing enqueue: target sha '$sha' is not 40-hex (fail-close)"
    return 64
  fi
  ssq_init_dirs
  local auto_nonce=0
  [[ -z "$nonce" ]] && { auto_nonce=1; nonce="$$-$(ssq_now)-${RANDOM}"; }
  local now tmp final
  now="$(ssq_now)"
  tmp="$(mktemp "${SELF_SHIP_TMP_DIR}/marker.XXXXXX")" || { ssq_log "mktemp failed"; return 1; }
  # jq builds the JSON so quoting/encoding is safe.
  if ! jq -n \
        --arg sha "$sha" --arg pr "$pr" --arg issue "$issue" \
        --argjson now "$now" \
        '{targetSha:$sha, prNumber:$pr, issueIdentifier:$issue, schemaVersion:2, attempts:0, nextAttemptAt:$now, lastErrorClass:null, createdAt:$now}' \
        > "$tmp"; then
    rm -f "$tmp"; ssq_log "jq marker build failed"; return 1
  fi
  # Atomic NO-CLOBBER publish: hard-link into the watched dir (fails with EEXIST
  # if the name already exists — never overwrite an existing request). Retry with
  # fresh entropy only when the nonce was auto-generated (LOW-6).
  local tries=0
  while :; do
    final="${SELF_SHIP_PENDING_DIR}/${sha}.${nonce}.json"
    if ln "$tmp" "$final" 2>/dev/null; then rm -f "$tmp"; echo "$final"; return 0; fi
    if (( auto_nonce == 1 )) && (( tries < 5 )); then
      tries=$((tries + 1)); nonce="$$-$(ssq_now)-${RANDOM}-${tries}"; continue
    fi
    rm -f "$tmp"; ssq_log "atomic no-clobber publish failed (dest exists: $final)"; return 1
  done
}

# ── Marker reads ────────────────────────────────────────────────────────────
ssq_marker_field() { jq -r --arg f "$2" '.[$f] // empty' "$1" 2>/dev/null; }

# A watched-dir entry is "valid" only if it is a *.json with parseable JSON, a
# 40-hex targetSha, AND well-typed state fields. Anything else (temp leftovers,
# .DS_Store, corrupt, or a marker whose attempts/nextAttemptAt/createdAt are not
# numbers) is junk — quarantined, never acted on. Validating the numeric schema
# here is what prevents a malformed `nextAttemptAt:"abc"` from crashing the
# arithmetic in ssq_due_markers/ssq_earliest_due under `set -u` and looping
# forever in the watched dir (code-review R2 HIGH-2).
ssq_marker_is_valid() {
  local f="$1"
  [[ "$f" == *.json ]] || return 1
  jq -e . "$f" >/dev/null 2>&1 || return 1
  ssq_is_sha40 "$(ssq_marker_field "$f" targetSha)" || return 1
  # attempts/nextAttemptAt/createdAt must be absent or JSON numbers (integers).
  jq -e '
    (.attempts? // 0)      as $a |
    (.nextAttemptAt? // 0) as $n |
    (.createdAt? // 0)     as $c |
    ($a|type=="number") and ($a == ($a|floor)) and
    ($n|type=="number") and ($n == ($n|floor)) and
    ($c|type=="number") and ($c == ($c|floor))
  ' "$f" >/dev/null 2>&1
}

# ── Backoff / failure classification ────────────────────────────────────────
# Error classes: "transient" (network/fetch) retry with backoff; "deterministic"
# (dirty checkout, invalid sha, repeated build/health/lead failure) counts toward
# the block threshold.
ssq_record_failure() {
  local f="$1" class="${2:-transient}"
  local attempts now next backoff
  attempts="$(ssq_marker_field "$f" attempts)"; attempts="${attempts:-0}"
  attempts=$((attempts + 1))
  now="$(ssq_now)"
  backoff=$(( SELF_SHIP_BASE_BACKOFF * (1 << (attempts - 1)) ))
  (( backoff > SELF_SHIP_MAX_BACKOFF )) && backoff=$SELF_SHIP_MAX_BACKOFF
  next=$(( now + backoff ))
  local tmp; tmp="$(mktemp "${SELF_SHIP_TMP_DIR}/upd.XXXXXX")" || return 1
  if jq --argjson a "$attempts" --argjson n "$next" --arg c "$class" \
        '.attempts=$a | .nextAttemptAt=$n | .lastErrorClass=$c' "$f" > "$tmp" 2>/dev/null; then
    mv -f "$tmp" "$f"
  else
    rm -f "$tmp"; return 1
  fi
  # deterministic failures past the threshold → block (move out of watched dir).
  if [[ "$class" == "deterministic" ]] && (( attempts >= SELF_SHIP_MAX_ATTEMPTS )); then
    return 10  # caller blocks
  fi
  return 0
}

# Move a marker out of the watched dir so launchd stops re-launching for it.
ssq_block() {
  local f="$1" reason="${2:-blocked}"
  ssq_init_dirs
  local base; base="$(basename "$f")"
  mv -f "$f" "${SELF_SHIP_BLOCKED_DIR}/${base}" 2>/dev/null || { ssq_log "block mv failed for $f"; return 1; }
  ssq_log "blocked marker $base ($reason) → $SELF_SHIP_BLOCKED_DIR"
}

# Quarantine an invalid/corrupt watched-dir entry (also out of the watched dir).
ssq_quarantine() { ssq_block "$1" "quarantine-invalid"; }

# ── Acknowledgement ─────────────────────────────────────────────────────────
# A marker is satisfied once its target merge SHA is an ancestor-or-equal of the
# deployed SHA (the deployed code includes the merge). Returns 0 + deletes the
# marker; non-zero means "not yet" (target object missing or not yet deployed).
# FLY-727 (Codex design review R2#1): split the destructive ack into a
# non-destructive check + an explicit delete, so callers can persist a
# deployment event BEFORE deleting the only marker that can retry it.
#   ssq_is_satisfied <marker> <deployed> [repo] → 0 iff target ancestor-of deployed (NO delete)
#   ssq_delete_ack   <marker>                    → delete the acked marker
ssq_is_satisfied() {
  local f="$1" deployed="$2" repo="${3:-${HOME}/Dev/flywheel}"
  local target; target="$(ssq_marker_field "$f" targetSha)"
  ssq_is_sha40 "$target" || return 2
  ssq_is_sha40 "$deployed" || return 1
  git -C "$repo" cat-file -e "${target}^{commit}" 2>/dev/null || return 1   # object not present yet
  git -C "$repo" merge-base --is-ancestor "$target" "$deployed" 2>/dev/null
}

ssq_delete_ack() { rm -f "$1"; }

# Backward-compatible wrapper (check + delete in one) for existing callers.
# Capture ssq_is_satisfied's exit code explicitly — a bare `return $?` after an
# `if` whose condition is FALSE returns the if-statement's exit (0), not the
# condition's, which would wrongly ack a never-deployed target (T7c).
ssq_try_ack() {
  ssq_is_satisfied "$1" "$2" "${3:-${HOME}/Dev/flywheel}"
  local rc=$?
  (( rc == 0 )) && ssq_delete_ack "$1"
  return $rc
}

# Is the marker's target an ancestor-or-equal of origin/main? Used after a
# SUCCESSFUL deploy to tell apart "deploy lagging behind a real merge" (target
# IS on origin/main → transient, retry) from "bad/foreign target SHA that will
# NEVER acknowledge" (target absent or not on origin/main → deterministic, block
# now instead of retrying forever — §2.3 step 8 / code-review R1). Returns 0 if
# on origin/main.
ssq_target_on_origin() {
  local f="$1" repo="${2:-${HOME}/Dev/flywheel}"
  local target; target="$(ssq_marker_field "$f" targetSha)"
  ssq_is_sha40 "$target" || return 1
  git -C "$repo" cat-file -e "${target}^{commit}" 2>/dev/null || return 1
  git -C "$repo" merge-base --is-ancestor "$target" origin/main 2>/dev/null
}

# ── Due-time scheduling ─────────────────────────────────────────────────────
# Echo paths of due markers (nextAttemptAt <= now, or absent). Invalid entries
# are quarantined as a side effect so they never gate the queue.
ssq_due_markers() {
  local now; now="$(ssq_now)"
  shopt -s nullglob
  local f next
  for f in "${SELF_SHIP_PENDING_DIR}"/*; do
    if ! ssq_marker_is_valid "$f"; then ssq_quarantine "$f"; continue; fi
    next="$(ssq_marker_field "$f" nextAttemptAt)"
    if [[ -z "$next" || "$next" -le "$now" ]]; then echo "$f"; fi
  done
  shopt -u nullglob
}

# Echo the earliest nextAttemptAt among NOT-due markers (empty if none/empty dir).
ssq_earliest_due() {
  local now; now="$(ssq_now)"
  shopt -s nullglob
  local f next best=""
  for f in "${SELF_SHIP_PENDING_DIR}"/*; do
    ssq_marker_is_valid "$f" || continue
    next="$(ssq_marker_field "$f" nextAttemptAt)"
    [[ -z "$next" || "$next" -le "$now" ]] && continue
    if [[ -z "$best" || "$next" -lt "$best" ]]; then best="$next"; fi
  done
  shopt -u nullglob
  echo "$best"
}

# Quarantine every invalid/corrupt entry out of the watched dir. The updater must
# call this BEFORE deciding the queue is empty — otherwise a watched dir holding
# ONLY invalid entries reads as pending==0, the updater exits, the junk stays, and
# launchd's QueueDirectories re-runs the job forever (code-review R2 HIGH-1).
ssq_sweep_invalid() {
  # dotglob so stray dotfiles (.DS_Store, editor temp) are ALSO quarantined —
  # otherwise they keep the watched dir non-empty and QueueDirectories hot-loops.
  shopt -s nullglob dotglob
  local f
  for f in "${SELF_SHIP_PENDING_DIR}"/*; do
    ssq_marker_is_valid "$f" || ssq_quarantine "$f"
  done
  shopt -u nullglob dotglob
}

# Count valid markers still in the watched dir.
ssq_pending_count() {
  local n=0 f
  shopt -s nullglob
  for f in "${SELF_SHIP_PENDING_DIR}"/*; do ssq_marker_is_valid "$f" && n=$((n + 1)); done
  shopt -u nullglob
  echo "$n"
}

# Bounded, TERM-interruptible sleep until the earliest due marker (capped by
# RESCAN_INTERVAL so a freshly-enqueued due marker is never starved behind a
# far-future one — head-of-line guard, R5 LOW#1). Returns immediately if a
# marker is already due.
ssq_sleep_until_due() {
  local now earliest delta
  now="$(ssq_now)"
  earliest="$(ssq_earliest_due)"
  [[ -z "$earliest" ]] && return 0          # nothing deferred → caller rescans now
  delta=$(( earliest - now ))
  (( delta <= 0 )) && return 0
  (( delta > SELF_SHIP_RESCAN_INTERVAL )) && delta=$SELF_SHIP_RESCAN_INTERVAL
  # Save the caller's INT/TERM traps (e.g. the updater's lock-release) and restore
  # them after — do NOT clear them, or a signal after the first sleep would skip
  # lock release (code-review R2 LOW-5).
  local prev_int prev_term
  prev_int="$(trap -p INT)"; prev_term="$(trap -p TERM)"
  sleep "$delta" &
  local sp=$!
  trap 'kill "$sp" 2>/dev/null' TERM INT
  wait "$sp" 2>/dev/null
  # Restore prior traps (or clear if none were set).
  if [[ -n "$prev_int" ]]; then eval "$prev_int"; else trap - INT; fi
  if [[ -n "$prev_term" ]]; then eval "$prev_term"; else trap - TERM; fi
}

# ── Singleton lock (covers the git phase; survives crashes) ─────────────────
# mkdir-based mutex. The lock dir stores the owner PID. A held lock is reclaimed
# ONLY when the owner PID is dead, OR alive but its identity no longer matches
# the updater (R5 LOW#1 — never evict a living, legitimately-sleeping updater
# purely on age; age is only a last-resort guard for an unidentifiable holder).
# Pass an identity regex matched against the owner's `ps -o command=`.
_ssq_lock_write_owner() {
  echo "$$" > "${SELF_SHIP_LOCK_DIR}/pid"
  echo "${1:-update-flywheel}" > "${SELF_SHIP_LOCK_DIR}/ident"
  ssq_now > "${SELF_SHIP_LOCK_DIR}/created"
}

ssq_lock_acquire() {
  local ident="${1:-update-flywheel}"
  if mkdir "$SELF_SHIP_LOCK_DIR" 2>/dev/null; then
    _ssq_lock_write_owner "$ident"
    return 0
  fi
  local owner; owner="$(cat "${SELF_SHIP_LOCK_DIR}/pid" 2>/dev/null || echo "")"
  local stale=0
  if [[ -z "$owner" ]] || ! kill -0 "$owner" 2>/dev/null; then
    stale=1                                   # owner dead (or unknown) → reclaim
  else
    # Owner PID is ALIVE. Decide stale by IDENTITY, never by age alone (R5/code-review R1 HIGH-1).
    local cmd; cmd="$(ps -o command= -p "$owner" 2>/dev/null || echo "")"
    local stored_ident; stored_ident="$(cat "${SELF_SHIP_LOCK_DIR}/ident" 2>/dev/null || echo "")"
    if [[ -n "$cmd" && "$cmd" != *"$ident"* ]]; then
      # Reliable mismatch: PID alive, inspectable, and its command is NOT the
      # updater → the PID was reused by an unrelated process → reclaim.
      stale=1
    fi
    # Alive but UNINSPECTABLE (ps denied/empty — common in sandboxes): NEVER
    # reclaim (code-review R1/R2 HIGH: never evict a live, possibly-legitimate
    # holder when we cannot prove a mismatch — a missing `created`/`ident` is not
    # proof of staleness). A truly abandoned lock from a reused-PID process is a
    # rare case cleared by reboot / operator, not worth risking a live eviction.
    # Alive + cmd matches ident → a live updater holds it → NOT stale.
    : "${stored_ident:-}"  # retained for diagnostics only
  fi
  if (( stale == 1 )); then
    ssq_log "reclaiming stale updater lock (owner='${owner}')"
    rm -rf "$SELF_SHIP_LOCK_DIR" 2>/dev/null || true
    if mkdir "$SELF_SHIP_LOCK_DIR" 2>/dev/null; then _ssq_lock_write_owner "$ident"; return 0; fi
  fi
  return 75   # EX_TEMPFAIL — a live updater holds it (or could not reclaim)
}

ssq_lock_release() {
  local owner; owner="$(cat "${SELF_SHIP_LOCK_DIR}/pid" 2>/dev/null || echo "")"
  [[ "$owner" == "$$" ]] && rm -rf "$SELF_SHIP_LOCK_DIR" 2>/dev/null || true
}

# Auto-run guard: this file is a library. Tests/consumers source it after setting
# SELF_SHIP_QUEUE_SOURCED=1; there is no executable entrypoint here.
if [[ "${SELF_SHIP_QUEUE_SOURCED:-0}" != "1" && "${BASH_SOURCE[0]}" == "${0}" ]]; then
  echo "self-ship-queue.sh is a sourced library; set SELF_SHIP_QUEUE_SOURCED=1 and source it." >&2
  exit 64
fi
