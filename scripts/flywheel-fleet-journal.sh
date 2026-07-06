#!/usr/bin/env bash
# FLY-247 inc2a (§2.1, §2.5): write-ahead batch journal for `apply --changes-file`.
#
# One durable record per batch at ${FLEET_TXN_DIR}/batch-<id>.json. The API
# exclusive-creates it in `launching` BEFORE spawning the engine (no pre-journal
# window, R6 #4); the engine attaches and advances it. Every destructive step
# journals its phase BEFORE acting (write-ahead, aligned with inc1's
# pre-destructive-boundary journaling).
#
# Two independent enums (R8 #3):
#   BatchStatus: launching | running | applied | partially-applied | failed
#                | rejected | recover-required
#                (transitions: launching→{running|rejected}, R13;
#                 running→{applied|partially-applied|failed|recover-required})
#   KeyStatus:   pending | config-writing | config-written | applying | applied
#                | config-restoring | failed-restored | config-restore-conflict
#                | manual-intervention | skipped | unapplied

FLEET_TXN_DIR="${FLEET_TXN_DIR:-${HOME}/.flywheel/fleet-txns}"

batch_journal_path() { printf '%s/batch-%s.json' "$FLEET_TXN_DIR" "$1"; }

# Atomic JSON update: read with a jq filter (extra args after --), write to a
# same-dir temp, validate, rename. Never leaves a torn journal.
_batch_atomic_jq() {
  local path="$1"; shift
  [ -f "$path" ] || { echo "journal not found: $path" >&2; return 1; }
  local tmp="${path}.tmp.$$"
  if jq "$@" "$path" >"$tmp" 2>/dev/null && jq empty "$tmp" 2>/dev/null; then
    mv "$tmp" "$path"
  else
    rm -f "$tmp"
    echo "journal update failed: $path" >&2
    return 1
  fi
}

# batch_journal_create <batchId> <changes_file> <preImageSha>
#   Exclusive-create the launching record. Fails if a journal already exists for
#   this batchId (no silent overwrite).
batch_journal_create() {
  local batch_id="$1" cf="$2" pre_sha="$3"
  mkdir -p "$FLEET_TXN_DIR"
  local path; path="$(batch_journal_path "$batch_id")"
  local record
  record=$(jq -n \
    --arg id "$batch_id" \
    --arg sha "$pre_sha" \
    --argjson pid "$$" \
    --arg created "$(date +%s)" \
    --slurpfile req "$cf" \
    '{
       batchId: $id,
       batchStatus: "launching",
       owner: { pid: $pid, created: ($created | tonumber) },
       preImageSha: $sha,
       canonicalRequest: $req[0],
       keys: ( $req[0].changes
               | map({ (.key): { from: (.from // {model:null}),
                                 to: .to, status: "pending" } })
               | add )
     }') || { echo "failed to build launching record" >&2; return 1; }
  # Exclusive create via noclobber — fail if the journal already exists.
  if ! (set -o noclobber; printf '%s\n' "$record" >"$path") 2>/dev/null; then
    echo "batch journal already exists: $path" >&2
    return 1
  fi
}

batch_journal_status() { jq -r '.batchStatus' "$(batch_journal_path "$1")" 2>/dev/null; }

# Owner liveness sidecar (Codex R2 HIGH-2): a SEPARATE file from the journal,
# shared with the TS console (which reads `owner-<id>.json` for pid liveness).
batch_owner_path() { printf '%s/owner-%s.json' "$FLEET_TXN_DIR" "$1"; }

# batch_journal_claim_owner <batchId> <pid>
#   The engine claims ownership as its FIRST action so a Bridge crash in the gap
#   before the parent publishes the sidecar can't make startup recover a live
#   engine. Atomic temp+rename; {pid,created} matches the TS sidecar reader.
batch_journal_claim_owner() {
  local batch_id="$1" pid="$2"
  mkdir -p "$FLEET_TXN_DIR"
  local op tmp
  op="$(batch_owner_path "$batch_id")"
  tmp="${op}.tmp.$$"
  if printf '{"pid":%d,"created":%d}\n' "$pid" "$(date +%s)" >"$tmp" 2>/dev/null; then
    mv "$tmp" "$op"
  else
    rm -f "$tmp"
    return 1
  fi
}

# batch_journal_cas_running <batchId>
#   Transition launching → running ONLY if still launching (best-effort CAS via
#   atomic rename). Non-zero if the batch was concurrently moved off launching
#   (e.g. a recover set it to rejected) → the engine must abort zero-mutation.
batch_journal_cas_running() {
  local path; path="$(batch_journal_path "$1")"
  _batch_atomic_jq "$path" \
    'if .batchStatus=="launching" then .batchStatus="running" else . end' || return 1
  [ "$(batch_journal_status "$1")" = "running" ]
}
batch_key_status() {
  jq -r --arg k "$2" '.keys[$k].status // "unknown"' "$(batch_journal_path "$1")" 2>/dev/null
}

# batch_journal_set_status <batchId> <BatchStatus>
batch_journal_set_status() {
  _batch_atomic_jq "$(batch_journal_path "$1")" --arg s "$2" '.batchStatus = $s'
}

# batch_key_set_status <batchId> <key> <KeyStatus> [intendedPostSha]
#   Write-ahead: call this BEFORE the destructive step it names.
batch_key_set_status() {
  local batch_id="$1" key="$2" status="$3" post_sha="${4:-}"
  _batch_atomic_jq "$(batch_journal_path "$batch_id")" \
    --arg k "$key" --arg s "$status" --arg ps "$post_sha" \
    '.keys[$k].status = $s
     | if $ps != "" then .keys[$k].intendedPostSha = $ps else . end'
}

# batch_journal_reduce <batchId>
#   Compute + set the terminal BatchStatus from per-key statuses (R10 #3):
#   all applied → applied; ≥1 applied & ≥1 not → partially-applied; zero applied
#   → failed. Echoes the chosen status.
batch_journal_reduce() {
  local path; path="$(batch_journal_path "$1")"
  local reduced
  reduced=$(jq -r '
    ([.keys[].status] | length) as $n
    | ([.keys[].status] | map(select(. == "applied")) | length) as $ok
    | if $ok == $n then "applied"
      elif $ok > 0 then "partially-applied"
      else "failed" end' "$path" 2>/dev/null) || return 1
  _batch_atomic_jq "$path" --arg s "$reduced" '.batchStatus = $s' || return 1
  printf '%s' "$reduced"
}
