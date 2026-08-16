#!/bin/bash
# FLY-247: fleet operations CLI — the clean cutover path for per-Lead
# model/backend config.
#
#   flywheel-fleet.sh plan   [--lead <key>] [--project <p>]
#   flywheel-fleet.sh apply  [--lead <key>] [--project <p>] [--yes] [--dry-run]
#   flywheel-fleet.sh apply  --lead <key> [--model <id|default>] [--effort <level|default>] [--backend <id>] --yes
#   flywheel-fleet.sh apply --rollback [--txn <id>] [--lead <key>] [--yes]
#   flywheel-fleet.sh recover --txn <id> [--lead <key>] --yes
#
# Single source of truth: ~/.flywheel/projects.json leads[].{model,backend}.
# Derived runtime artifacts: manifest (model, leadBackend.backendId) → plist env.
#
# Safety contract (Codex design review R1–R10, all enforced here):
#   - plan / --dry-run never mutate anything (non-terminal txns: report+exit 1)
#   - FLYWHEEL_PROJECTS set → fail-close (split-brain guard, F8)
#   - restart.lock.d mutex shared with restart-services.sh (R1#9)
#   - auto-apply ONLY model-only changes on confirmed-standard Claude leads;
#     any backend diff / codex / unknown / not-installed → UNAPPLIED (§2.3)
#   - immutable config snapshot + pre-bootout TOCTOU re-verification of
#     config, artifact pre-images AND the full evidence gate (R5#3 + R8#5)
#   - staged artifacts; canonical writes happen only inside the daemon's
#     staged install after the old PID exited (R3#2)
#   - recovery follows the §2.6 phase table via the daemon's JSON result
#     record (identity-bound, R10#3) — never by parsing stderr
#   - rollback = symmetric protocol with CAS (exact plist hash + semantic
#     manifest projection, R6#2/R7#3) and newest-first lineage (R5#5)
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Shared helpers (plist paths, launchd seams, staged install, runtime
# predicate, file_sha, generate_plist_to). Sourcing — not duplicating —
# keeps fleet and daemon classification logic from drifting.
export FLYWHEEL_DAEMON_SOURCED=1
# shellcheck disable=SC1091
if ! source "${SCRIPT_DIR}/flywheel-daemon.sh"; then
  echo "[fleet] ERROR: daemon helpers failed to load; refusing to continue with a partial control plane" >&2
  if [ "${BASH_SOURCE[0]}" != "$0" ]; then return 1; else exit 1; fi
fi
set +e  # daemon's set -e must not make fleet's probe negatives fatal

# FLY-247 inc2a: batch-mode libs (config-write flock, write-ahead journal, and
# the canonical-request/baseline/per-key primitives + fleet_batch_apply
# orchestration). Sourcing is side-effect-free — each guards its CLI/dispatch on
# BASH_SOURCE==$0.
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/flywheel-config-lock.sh"
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/flywheel-fleet-journal.sh"
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/flywheel-fleet-batch.sh"

PROJECTS_JSON="${FLYWHEEL_STATE_DIR}/projects.json"
FLEET_BACKUPS="${FLYWHEEL_STATE_DIR}/fleet-backups"
LOCK_DIR="${FLYWHEEL_STATE_DIR}/restart.lock.d"
DAEMON_BIN="${FLYWHEEL_FLEET_DAEMON_BIN:-${SCRIPT_DIR}/flywheel-daemon.sh}"
MODEL_POLICY_CLI="${FLYWHEEL_MODEL_POLICY_CLI:-${SCRIPT_DIR}/validate-model-policy.mjs}"

flog() { echo "[fleet] $*"; }
ferr() { echo "[fleet] ERROR: $*" >&2; }
die() { ferr "$*"; exit 1; }

validate_model_policy_value() {
  local value="$1"
  # projects.json absence is an authoritative Fable default, not account
  # inheritance. Validate the effective launch value while preserving absence
  # in the SSOT itself.
  if [ -z "$value" ] || [ "$value" = "null" ]; then
    value="claude-fable-5"
  fi
  node "$MODEL_POLICY_CLI" model "$value" lead >/dev/null
}

# ════════════════════════════════════════════════════════════════
# Guards
# ════════════════════════════════════════════════════════════════

guard_env_source() {
  # F8/R1#7: loadProjects() gives FLYWHEEL_PROJECTS priority over the file.
  # If it's set, this CLI could apply file A while the Bridge runs env B.
  if [ -n "${FLYWHEEL_PROJECTS:-}" ]; then
    die "FLYWHEEL_PROJECTS is set — the Bridge would read env config while fleet operates on ${PROJECTS_JSON} (split-brain). Unset it or run inside the env-owning context."
  fi
  [ -f "$PROJECTS_JSON" ] || die "Config not found: ${PROJECTS_JSON}"
  jq empty "$PROJECTS_JSON" 2>/dev/null || die "Config is not valid JSON: ${PROJECTS_JSON}"
}

acquire_lock() {
  if ! mkdir "$LOCK_DIR" 2>/dev/null; then
    local lock_mtime lock_age
    # CI fix: on GNU stat, -f means FILESYSTEM status (%m = mount point, exit
    # 0) — the BSD-first order returned a path string and blew up the
    # arithmetic under set -u. Try GNU -c first, then BSD -f, then sanitize.
    lock_mtime=$(stat -c %Y "$LOCK_DIR" 2>/dev/null || stat -f %m "$LOCK_DIR" 2>/dev/null || echo 0)
    case "$lock_mtime" in (''|*[!0-9]*) lock_mtime=0 ;; esac
    lock_age=$(( $(date +%s) - lock_mtime ))
    if (( lock_age > 7200 )); then
      flog "Stale lock (>2h) — taking over: ${LOCK_DIR}"
      rmdir "$LOCK_DIR" 2>/dev/null || true
      mkdir "$LOCK_DIR" 2>/dev/null || die "Could not acquire lock: ${LOCK_DIR}"
    else
      die "Another restart operation holds ${LOCK_DIR} (restart-services or fleet). Retry later."
    fi
  fi
  trap 'rmdir "$LOCK_DIR" 2>/dev/null || true' EXIT
}

# Detect unfinished transactions (any non-terminal lead phase OR wrapper
# mid-install). plan/--dry-run: report + exit 1. apply/rollback: refuse.
TERMINAL_PHASES='["pending","applied","rolled-back","manual-intervention","unapplied"]'
find_unfinished_txns() {
  local txn
  for txn in "$FLEET_BACKUPS"/*/transaction.json; do
    [ -f "$txn" ] || continue
    # R6#5: a truncated/corrupt journal is an UNKNOWN prior state — fail
    # CLOSED (treat as unfinished), never as "no unfinished transactions".
    if ! jq empty "$txn" 2>/dev/null; then
      echo "$(dirname "$txn")"
      continue
    fi
    local bad
    bad=$(jq -r --argjson term "$TERMINAL_PHASES" \
      '[(.leads // {}) | to_entries[] | select(.value.phase as $p | $term | index($p) | not) | .key]
       + (if (.wrapper.phase // "w-committed") | IN("w-committed", "w-rolled-back", "w-none") then [] else ["__wrapper__"] end)
       | length' "$txn" 2>/dev/null) || bad="ERR"
    if [ "$bad" = "ERR" ] || [ "${bad:-0}" -gt 0 ]; then
      echo "$(dirname "$txn")"
    fi
  done
}

# ════════════════════════════════════════════════════════════════
# Evidence (§2.4 — bash twin of the TS classification; conformance
# fixtures keep the two implementations aligned)
# ════════════════════════════════════════════════════════════════

# Desired backend with precedence: explicit leads[].backend > legacy
# (.flywheel/config.yaml roles.lead.backend, then FLYWHEEL_LEAD_BACKEND) >
# claude-code. Echoes "<backend> <source>".
desired_backend() {
  local snapshot="$1" project="$2" lead="$3" project_root="$4"
  local explicit
  explicit=$(jq -r --arg p "$project" --arg l "$lead" \
    '.[] | select(.projectName == $p) | .leads[] | select(.agentId == $l) | .backend // ""' \
    "$snapshot" 2>/dev/null)
  if [ -n "$explicit" ]; then
    # verbatim passthrough — classify_lead fail-closes unknown values (R4-H2)
    echo "$explicit explicit"
    return
  fi
  local legacy=""
  if [ -f "${project_root}/.flywheel/config.yaml" ]; then
    legacy=$(awk '/^roles:/{r=1;next} r&&/^[^ ]/{r=0} r&&/^  lead:/{l=1;next} l&&/^  [^ ]/{l=0} l&&/^    backend:/{print $2; exit}' \
      "${project_root}/.flywheel/config.yaml" 2>/dev/null | tr -d '"' || true)
  fi
  if [ -z "$legacy" ]; then
    legacy="${FLYWHEEL_LEAD_BACKEND:-}"
  fi
  if [ -n "$legacy" ]; then
    if [ "$legacy" = "codex-app-server" ] || [ "$legacy" = "codex-tmux" ] || [ "$legacy" = "codex" ]; then
      echo "codex-app-server legacy"
    else
      echo "claude-code legacy"
    fi
    return
  fi
  echo "claude-code default"
}

# Observed management axis (§2.4 bound evidence 1-4; structural only, R6#1).
# Echoes: standard-confirmed | external-confirmed | indeterminate
observed_management() {
  local key="$1"
  local manifest="${MANIFEST_DIR}/${key}.json"
  local plist
  plist=$(plist_path "$key")
  local label
  label=$(plist_label "$key")

  # Probe-tool availability → indeterminate, never external (R4#1)
  command -v "$LAUNCHCTL" >/dev/null 2>&1 || { echo "indeterminate"; return; }

  # 1. canonical manifest + plist exist with matching identity
  if [ ! -f "$manifest" ] || [ ! -f "$plist" ]; then
    echo "external-confirmed"; return
  fi
  if ! jq empty "$manifest" 2>/dev/null; then
    echo "indeterminate"; return
  fi
  # 1b. manifest identity fields must bind to THIS exact key (code-review H7:
  # a copied/renamed manifest must not lend standard-managed status).
  local m_ident
  m_ident=$(jq -r '(.projectName // "") + "-" + (.leadId // "")' "$manifest" 2>/dev/null || echo "")
  if [ "$m_ident" != "$key" ]; then
    echo "external-confirmed"; return
  fi
  # 2. plist points at the standard wrapper AND this canonical manifest
  local plist_carrier
  plist_carrier="$(classify_plist_lead_carrier "$plist")"
  if [ "$plist_carrier" = "unknown" ] \
    || ! grep -qF "<string>${manifest}</string>" "$plist" \
    || ! grep -qF "<string>${label}</string>" "$plist"; then
    echo "external-confirmed"; return
  fi
  # 3. exact label loaded with PID > 0 — TRI-STATE (R5#1): an erroring
  # launchctl must be indeterminate, never read as unloaded.
  local probe
  probe=$(launchd_probe "$key")
  if [ "$probe" = "error" ]; then
    echo "indeterminate"; return
  fi
  if [ "$probe" = "unloaded" ]; then
    echo "external-confirmed"; return
  fi
  local lpid="${probe##* }"
  if [ "$lpid" = "0" ] || [ -z "$lpid" ]; then
    echo "external-confirmed"; return
  fi
  # 4. launchd PID == manifest.pid and alive (manifest.pid alone is NOT
  #    evidence — residual Claude manifests / PID reuse, R7#1)
  local mpid
  mpid=$(jq -r '.pid // 0' "$manifest" 2>/dev/null || echo 0)
  if [ "$lpid" != "$mpid" ] || ! kill -0 "$lpid" 2>/dev/null; then
    echo "external-confirmed"; return
  fi
  echo "standard-confirmed"
}

# Observed runtime axis: claude-confirmed | no-claude-confirmed | indeterminate
observed_runtime() {
  local key="$1"
  local lpid
  lpid=$(get_launchd_pid "$key")
  command -v ps >/dev/null 2>&1 || { echo "indeterminate"; return; }
  command -v pgrep >/dev/null 2>&1 || { echo "indeterminate"; return; }
  if [ "$lpid" != "0" ] && [ -n "$lpid" ]; then
    runtime_claude_confirmed "$lpid" "$key"
    case $? in
      0) echo "claude-confirmed"; return ;;
      2) echo "indeterminate"; return ;;  # R5#5: probe error ≠ no-claude
    esac
  fi
  # No live standard PID: the canonical private pane may still exist. Pane
  # evidence comes from the shared daemon helper so fleet and daemon cannot
  # disagree about the v2 manifest/socket binding.
  claude_pane_evidence "$key"
  case $? in
    0) echo "claude-confirmed"; return ;;
    2) echo "indeterminate"; return ;;
  esac
  echo "no-claude-confirmed"
}

# Carrier + drift for one key. Echoes a JSON object on stdout.
collect_lead_state() {
  local snapshot="$1" project="$2" lead="$3" project_root="$4"
  local key="${project}-${lead}"
  local manifest="${MANIFEST_DIR}/${key}.json"
  local plist
  plist=$(plist_path "$key")

  local desired_model desired_effort
  desired_model=$(jq -r --arg p "$project" --arg l "$lead" \
    '.[] | select(.projectName == $p) | .leads[] | select(.agentId == $l) | .model // ""' \
    "$snapshot" 2>/dev/null)
  # FLY-671: desired effort (launch-affecting carrier, same as model).
  desired_effort=$(jq -r --arg p "$project" --arg l "$lead" \
    '.[] | select(.projectName == $p) | .leads[] | select(.agentId == $l) | .effort // ""' \
    "$snapshot" 2>/dev/null)
  local db
  db=$(desired_backend "$snapshot" "$project" "$lead" "$project_root")
  local d_backend d_source
  d_backend="${db%% *}"
  d_source="${db##* }"
  local m_model="" m_backend="" m_effort="" plist_model="" plist_effort="" plist_carrier="unknown" m_exists=false p_exists=false
  if [ -f "$manifest" ]; then
    m_exists=true
    m_model=$(jq -r '.model // ""' "$manifest" 2>/dev/null || echo "")
    m_backend=$(jq -r '.leadBackend.backendId // ""' "$manifest" 2>/dev/null || echo "")
    m_effort=$(jq -r '.effort // ""' "$manifest" 2>/dev/null || echo "")
  fi
  if [ -f "$plist" ]; then
    p_exists=true
    plist_carrier="$(classify_plist_lead_carrier "$plist")"
    # QA F-1: production hand-edited plists (FLY-241) put <key> and <string>
    # on SEPARATE lines — a single-line sed reads them as "no model" and the
    # migration runbook's seed-drift never appears. Armed scan handles both.
    plist_model=$(awk '
      /FLYWHEEL_LEAD_MODEL/ { armed=1 }
      armed && match($0, /<string>[^<]*<\/string>/) {
        print substr($0, RSTART+8, RLENGTH-17); exit
      }' "$plist")
    # FLY-671: mirror the armed scan for the effort carrier.
    plist_effort=$(awk '
      /FLYWHEEL_LEAD_EFFORT/ { armed=1 }
      armed && match($0, /<string>[^<]*<\/string>/) {
        print substr($0, RSTART+8, RLENGTH-17); exit
      }' "$plist")
  fi

  local mgmt runtime
  mgmt=$(observed_management "$key")
  runtime=$(observed_runtime "$key")

  jq -n \
    --arg project "$project" --arg lead "$lead" --arg key "$key" \
    --arg dModel "$desired_model" --arg dEffort "$desired_effort" --arg dBackend "$d_backend" --arg dSource "$d_source" \
    --arg mModel "$m_model" --arg mBackend "$m_backend" --arg mEffort "$m_effort" \
    --arg pModel "$plist_model" --arg pEffort "$plist_effort" --arg pCarrier "$plist_carrier" \
    --argjson mExists "$m_exists" --argjson pExists "$p_exists" \
    --arg mgmt "$mgmt" --arg runtime "$runtime" \
    '{project: $project, lead: $lead, key: $key,
      desired: {model: $dModel, effort: $dEffort, backend: $dBackend, source: $dSource},
      carrier: {manifestExists: $mExists, plistExists: $pExists,
                manifestModel: $mModel, manifestBackend: $mBackend, manifestEffort: $mEffort,
                plistModel: $pModel, plistEffort: $pEffort, plistCarrier: $pCarrier},
      observed: {management: $mgmt, runtime: $runtime}}'
}

# Classification (§2.3): echoes "APPLICABLE" | "IN-SYNC" | "UNAPPLIED <reason>"
classify_lead() {
  local state_json="$1"
  local d_model d_effort d_backend m_model m_backend m_effort p_model p_effort p_carrier m_exists p_exists mgmt runtime
  d_model=$(jq -r '.desired.model' <<< "$state_json")
  d_effort=$(jq -r '.desired.effort // ""' <<< "$state_json")
  d_backend=$(jq -r '.desired.backend' <<< "$state_json")
  m_model=$(jq -r '.carrier.manifestModel' <<< "$state_json")
  m_backend=$(jq -r '.carrier.manifestBackend' <<< "$state_json")
  m_effort=$(jq -r '.carrier.manifestEffort // ""' <<< "$state_json")
  p_model=$(jq -r '.carrier.plistModel' <<< "$state_json")
  p_effort=$(jq -r '.carrier.plistEffort // ""' <<< "$state_json")
  p_carrier=$(jq -r '.carrier.plistCarrier // "unknown"' <<< "$state_json")
  m_exists=$(jq -r '.carrier.manifestExists' <<< "$state_json")
  p_exists=$(jq -r '.carrier.plistExists' <<< "$state_json")
  mgmt=$(jq -r '.observed.management' <<< "$state_json")
  runtime=$(jq -r '.observed.runtime' <<< "$state_json")

  # Backend involvement of any kind → fail-close (the enum has two values,
  # so ANY backend transition involves codex on one side, §2.3).
  # R4-H2: UNKNOWN backend strings (hand-edited config bypassing the TS
  # validator, or future enum values) must also fail-close — never be
  # silently overwritten as Claude.
  if [ "$d_backend" = "codex-app-server" ]; then
    echo "UNAPPLIED codex-desired(FLY-250-manual-path)"; return
  fi
  if [ "$m_backend" = "codex-app-server" ]; then
    echo "UNAPPLIED codex-carrier(FLY-250-manual-path)"; return
  fi
  if [ "$d_backend" != "claude-code" ]; then
    echo "UNAPPLIED unknown-desired-backend(${d_backend})"; return
  fi
  if [ -n "$m_backend" ] && [ "$m_backend" != "claude-code" ]; then
    echo "UNAPPLIED unknown-carrier-backend(${m_backend})"; return
  fi
  # Not installed → apply must NEVER create/install a lead (an unseeded
  # bespoke Mufasa would otherwise be installed as a Claude double, R2#3).
  if [ "$m_exists" != "true" ] || [ "$p_exists" != "true" ]; then
    echo "UNAPPLIED not-installed(no-carrier)"; return
  fi
  [ "$p_carrier" = "v2" ] || { echo "UNAPPLIED unknown-observed-carrier(${p_carrier})"; return; }
  if [ "$mgmt" != "standard-confirmed" ]; then
    echo "UNAPPLIED management-${mgmt}"; return
  fi
  if [ "$runtime" != "claude-confirmed" ]; then
    echo "UNAPPLIED runtime-${runtime}"; return
  fi
  # Diff against both runtime artifacts (manifest + plist env, R1#2). FLY-671: a change in
  # EITHER model OR effort makes the lead APPLICABLE — an effort-only change must
  # not be skipped as in-sync.
  if [ "$d_model" = "$m_model" ] && [ "$d_model" = "$p_model" ] \
     && [ "$d_effort" = "$m_effort" ] && [ "$d_effort" = "$p_effort" ]; then
    echo "IN-SYNC"; return
  fi
  echo "APPLICABLE"
}

# R6#4: after a bootout where no trustworthy PID exists (loaded-without-PID),
# only a positive 'unloaded' probe within the timeout proves the stop.
wait_label_unloaded() {
  local key="$1" timeout="$2"
  local waited=0
  while [ "$waited" -lt "$timeout" ]; do
    [ "$(launchd_probe "$key")" = "unloaded" ] && return 0
    sleep "$POLL_INTERVAL"
    waited=$((waited + POLL_INTERVAL))
  done
  return 1
}

# R4-M5: schema + phase/outcome transition validation for daemon result
# records. Identity alone is not enough — a contradictory record (e.g.
# outcome stop_timeout with phase verifying, or a non-numeric pid) must
# fail-close instead of selecting a recovery branch.
validate_result_record() {
  local result="$1" txn_id="$2" key="$3" attempt="$4"
  jq -e --arg txn_id "$txn_id" --arg key "$key" --argjson att "$attempt" '
    (.version == 1 and .transactionId == $txn_id and .exactKey == $key and .attempt == $att)
    and ((.labelLoaded | type) == "boolean")
    and ((.runtimeState | type) == "string")
    and ((.oldPid == null) or ((.oldPid | type) == "number" and .oldPid >= 0))
    and ((.newPid == null) or ((.newPid | type) == "number" and .newPid >= 0))
    and (
      (.phase == "prepared" and (.outcome | IN(
        "prep_failed_missing_staged", "prep_failed_manifest_invalid",
        "prep_failed_plist_label_mismatch", "prep_failed_plist_wrapper_mismatch",
        "prep_failed_plist_manifest_arg_not_canonical", "prep_failed_probe_error",
        "prep_failed_txn_incomplete", "prep_failed_config_changed",
        "prep_failed_carrier_changed", "prep_failed_evidence_regate"))) or
      (.phase == "stopping"      and .outcome == "stop_timeout"
        and (.oldPid | type) == "number" and .labelLoaded == true) or
      (.phase == "committing"    and .outcome == "commit_failed") or
      (.phase == "bootstrapping" and .outcome == "bootstrap_failed") or
      (.phase == "verifying"     and .outcome == "verify_failed_not_started"
        and .newPid == null and .runtimeState == "not_started") or
      (.phase == "verifying"     and .outcome == "verify_failed_alive_unverified"
        and (.newPid | type) == "number" and .newPid > 0
        and .labelLoaded == true and .runtimeState == "alive-unverified") or
      (.phase == "applied"       and .outcome == "applied"
        and (.newPid | type) == "number" and .newPid > 0
        and .labelLoaded == true and .runtimeState == "claude-confirmed")
    )' "$result" >/dev/null 2>&1
}

# M6 (R4): atomic restore — same-dir temp + sha verify + rename. A crash
# mid-restore must never leave a truncated/mixed canonical carrier.
restore_file_atomic() {
  local src="$1" dst="$2" expected_sha="$3"
  [ -f "$src" ] || return 1
  local tmp="${dst}.restore.$$"
  cp "$src" "$tmp" || { rm -f "$tmp"; return 1; }
  if [ -n "$expected_sha" ] && [ "$(file_sha "$tmp")" != "$expected_sha" ]; then
    rm -f "$tmp"
    return 1
  fi
  mv "$tmp" "$dst"
}

# H3 (code-review R2): a zero bootstrap exit only means launchd accepted the
# job — the restored Lead must actually BOOT: launchd pid alive, wrapper-v2's
# runtime manifest binding (pid == launchd pid), and Claude runtime traits.
verify_booted() {
  local key="$1"
  local manifest="${MANIFEST_DIR}/${key}.json"
  local waited=0
  while [ "$waited" -lt "$VERIFY_TIMEOUT" ]; do
    local lpid
    lpid=$(get_launchd_pid "$key")
    if [ "$lpid" != "0" ] && [ -n "$lpid" ] && kill -0 "$lpid" 2>/dev/null; then
      local mpid
      mpid=$(jq -r '.pid // 0' "$manifest" 2>/dev/null || echo 0)
      if [ "$mpid" = "$lpid" ] && runtime_claude_confirmed "$lpid" "$key"; then
        return 0
      fi
    fi
    sleep "$POLL_INTERVAL"
    waited=$((waited + POLL_INTERVAL))
  done
  return 1
}

# Semantic manifest projection hash (R7#3): exact enumerated launch-affecting
# schema; runtime-only pid/socketPath are excluded. Canonical JSON then sha.
manifest_projection_sha() {
  local manifest="$1"
  # R3-M6: an unreadable/missing manifest yields a SENTINEL, not the hash of
  # empty input — otherwise two missing files (or missing staged vs missing
  # current) would compare equal and authorize a restore they shouldn't.
  if [ ! -f "$manifest" ] || ! jq empty "$manifest" 2>/dev/null; then
    echo "__absent-or-invalid__"
    return
  fi
  # Every launch-affecting manifest field must participate in rollback CAS.
  # launchEnvironment is the body's explicit process contract; omitting it
  # would make a stale runtime stamp that deletes the field invisible to recovery.
  jq -S -c '{leadId: (.leadId // null), projectName: (.projectName // null),
             projectDir: (.projectDir // null), subdir: (.subdir // null),
             workspace: (.workspace // null), projectsFile: (.projectsFile // null),
             mcpExclude: (.mcpExclude // null),
             # FLY-1806: retained as legacy manifest schema for rollback CAS;
             # the runtime flag is retired and false/missing both canonicalize to null.
             chromeEnabled: (.chromeEnabled // null),
             model: (.model // null), effort: (.effort // null),
             leadBackend: (.leadBackend // null),
             launchEnvironment: (.launchEnvironment // null)}' \
    "$manifest" 2>/dev/null | shasum -a 256 | awk '{print $1}'
}

# ════════════════════════════════════════════════════════════════
# plan
# ════════════════════════════════════════════════════════════════

enumerate_targets() {
  # stdout lines: "<project>\t<lead>\t<projectRoot>"
  local snapshot="$1" want_lead="$2" want_project="$3"
  jq -r '.[] | .projectName as $p | .projectRoot as $r | .leads[] | [$p, .agentId, $r] | @tsv' \
    "$snapshot" | while IFS=$'\t' read -r p l r; do
    if [ -n "$want_project" ] && [ "$p" != "$want_project" ]; then continue; fi
    if [ -n "$want_lead" ]; then
      local key="${p}-${l}"
      if [ "$key" != "$want_lead" ] && [ "$l" != "$want_lead" ]; then continue; fi
    fi
    printf '%s\t%s\t%s\n' "$p" "$l" "$r"
  done
}

check_lead_ambiguity() {
  # --lead short name matching >1 project → hard error (R1#9)
  local targets="$1" want_lead="$2"
  [ -n "$want_lead" ] || return 0
  local n
  n=$(echo "$targets" | grep -c . || true)
  if [ "$n" -gt 1 ]; then
    # ambiguous only if the query was a short lead name (not an exact key)
    local exact
    exact=$(echo "$targets" | awk -F'\t' -v q="$want_lead" '($1 "-" $2) == q' | grep -c . || true)
    if [ "$exact" -eq 0 ]; then
      die "--lead '${want_lead}' matches ${n} leads across projects. Use the exact {project}-{lead} key."
    fi
  fi
}

# R4-H4: operator-supplied --txn values are path components.
validate_txn_id() {
  case "$1" in
    *[!A-Za-z0-9._-]*|""|.|..|*/*) return 1 ;;
  esac
  return 0
}

# R4-H4: every enumerated key must satisfy the safe grammar and be globally
# unique — "a-b"+"c" and "a"+"b-c" both produce exact key "a-b-c" and would
# share carrier/result paths.
guard_target_keys() {
  local targets="$1"
  local seen=""
  local p l r
  while IFS=$'\t' read -r p l r; do
    [ -n "$p" ] || continue
    local key="${p}-${l}"
    if ! validate_key_grammar "$p" || ! validate_key_grammar "$l"; then
      die "unsafe project/lead identifier in config: '${p}' / '${l}' (R4-H4)"
    fi
    case " $seen " in
      *" $key "*) die "exact-key collision: '${key}' is produced by more than one (project, lead) pair — rename one (R4-H4)" ;;
    esac
    seen="$seen $key"
  done <<< "$targets"
}

cmd_plan() {
  local want_lead="" want_project=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --lead) [ -n "${2:-}" ] || die "--lead requires a value"; want_lead="$2"; shift 2 ;;
      --project) [ -n "${2:-}" ] || die "--project requires a value"; want_project="$2"; shift 2 ;;
      *) die "plan: unknown argument $1" ;;
    esac
  done
  guard_env_source

  local unfinished
  unfinished=$(find_unfinished_txns)
  if [ -n "$unfinished" ]; then
    ferr "Unfinished transaction(s) detected (plan never auto-recovers):"
    echo "$unfinished" >&2
    ferr "Run: flywheel-fleet.sh recover --txn <id> --yes"
    exit 1
  fi

  local targets
  targets=$(enumerate_targets "$PROJECTS_JSON" "$want_lead" "$want_project")
  check_lead_ambiguity "$targets" "$want_lead"
  [ -n "$targets" ] || die "No leads matched."
  guard_target_keys "$(enumerate_targets "$PROJECTS_JSON" "" "")"

  printf '\n%-30s %-22s %-22s %-14s %-28s %s\n' "KEY" "DESIRED(model@backend)" "MANIFEST(model@bid)" "PLIST(model)" "OBSERVED(mgmt/runtime)" "STATE"
  local p l r
  while IFS=$'\t' read -r p l r; do
    [ -n "$p" ] || continue
    local st cls
    st=$(collect_lead_state "$PROJECTS_JSON" "$p" "$l" "$r")
    cls=$(classify_lead "$st")
    local dm db ds mm mb pm mg rt
    dm=$(jq -r '.desired.model // "-"' <<< "$st"); dm="${dm:--}"
    db=$(jq -r '.desired.backend' <<< "$st")
    ds=$(jq -r '.desired.source' <<< "$st")
    mm=$(jq -r '.carrier.manifestModel // "-"' <<< "$st"); mm="${mm:--}"
    mb=$(jq -r '.carrier.manifestBackend // "-"' <<< "$st"); mb="${mb:--}"
    pm=$(jq -r '.carrier.plistModel // "-"' <<< "$st"); pm="${pm:--}"
    mg=$(jq -r '.observed.management' <<< "$st")
    rt=$(jq -r '.observed.runtime' <<< "$st")
    local src_note=""
    [ "$ds" = "legacy" ] && src_note=" [legacy:migrate]"
    printf '%-30s %-22s %-22s %-14s %-28s %s%s\n' \
      "${p}-${l}" "${dm}@${db}" "${mm}@${mb}" "${pm}" "${mg}/${rt}" "$cls" "$src_note"
  done <<< "$targets"
  echo ""
  flog "plan is read-only — nothing was changed."
}

# ════════════════════════════════════════════════════════════════
# apply
# ════════════════════════════════════════════════════════════════

confirm() {
  local prompt="$1" yes="$2"
  if [ "$yes" = "true" ]; then return 0; fi
  if [ ! -t 0 ]; then
    ferr "Non-interactive without --yes → abort (nothing changed)."
    return 1
  fi
  local reply
  read -r -p "${prompt} [y/N] " reply
  [ "$reply" = "y" ] || [ "$reply" = "Y" ]
}

txn_update() {
  # txn_update <txn.json> <jq-program> [jq args...]
  local txn="$1"; shift
  local prog="$1"; shift
  local tmp="${txn}.tmp.$$"
  jq "$@" "$prog" "$txn" > "$tmp" && jq empty "$tmp" 2>/dev/null && mv "$tmp" "$txn"
}

txn_has_retired_carrier_state() {
  jq -e '[.. | objects | select(has("carrier") or has("projectCarrier") or has("projectCarrierTouched"))]
         | length > 0' "$1" >/dev/null 2>&1
}

# FLY-247 inc2a (§2.1): batch model-only apply driver. Validates the canonical
# request, ensures the launching journal exists (the console API normally
# creates it before spawn; create-if-absent keeps the CLI self-sufficient), then
# runs fleet_batch_apply against the live config. env-pinned / baseline / lock
# outcomes are journaled by fleet_batch_apply (not a hard die) so the console can
# reconcile them.
cmd_apply_batch() {
  local cf="$1"
  [ -f "$cf" ] || die "changes-file not found: $cf"
  local vmsg
  if ! vmsg=$(fleet_batch_validate_request "$cf" 2>&1); then
    die "invalid changes-file: ${vmsg}"
  fi
  local batch_id; batch_id=$(jq -r '.batchId' "$cf")
  if [ ! -f "$(batch_journal_path "$batch_id")" ]; then
    local pre_sha; pre_sha=$(file_sha "$PROJECTS_JSON")
    batch_journal_create "$batch_id" "$cf" "$pre_sha" \
      || die "could not create batch journal for ${batch_id}"
  fi
  fleet_batch_apply "$cf" "$PROJECTS_JSON"
}

# FLY-709 P4.2: single-Lead value-flags sugar — the command the console's
# copy-paste text emits. Builds a canonical changes-file byte-aligned with
# buildCanonicalRequest (to.model ALWAYS present — filled with the current
# model on effort-only calls; effort keys ONLY when --effort was given, the
# FLY-671 three-state contract) and drives the same cmd_apply_batch machinery
# (journal + baseline SHA + per-key transactional cutover all inherited).
# A --backend that differs from the current backend fail-closes: a Lead
# backend switch is a manual cutover (FLY-264 not built; FLY-350/398 runbook).
cmd_apply_lead_flags() {
  local key="$1" model_set="$2" model_val="$3" effort_set="$4" effort_val="$5" \
        backend_set="$6" backend_val="$7" yes="$8"
  [ -n "$key" ] || die "--model/--effort/--backend require --lead <exact {project}-{lead} key>"
  guard_env_source

  local matches
  matches=$(jq -r --arg key "$key" '
    [ .[] | .projectName as $p | .leads[]
      | select(($p + "-" + .agentId) == $key) ] | length' "$PROJECTS_JSON")
  [ "$matches" = "1" ] || die "--lead '${key}' matches ${matches} leads — use the exact {project}-{lead} key"

  local cur_backend
  cur_backend=$(jq -r --arg key "$key" '
    [ .[] | .projectName as $p | .leads[]
      | select(($p + "-" + .agentId) == $key) | (.backend // "claude-code") ]
    | .[0]' "$PROJECTS_JSON")
  if [ "$backend_set" = "true" ] && [ "$backend_val" != "$cur_backend" ]; then
    die "backend switch ${cur_backend} → ${backend_val} needs a MANUAL cutover (managed Lead-backend switch = FLY-264, not built; see the FLY-350/398 runbooks). Nothing was changed."
  fi

  local cur_model cur_effort
  cur_model=$(fleet_batch_current_model "$PROJECTS_JSON" "$key")
  cur_effort=$(fleet_batch_current_effort "$PROJECTS_JSON" "$key")

  local to_model="$cur_model"
  if [ "$model_set" = "true" ]; then
    if [ "$model_val" = "default" ]; then to_model="null"; else to_model="$model_val"; fi
  fi
  local to_effort="$cur_effort"
  if [ "$effort_set" = "true" ]; then
    if [ "$effort_val" = "default" ]; then to_effort="null"; else to_effort="$effort_val"; fi
  fi
  if [ "$model_set" != "true" ] && [ "$effort_set" != "true" ]; then
    flog "nothing to apply for ${key} (backend already ${cur_backend}; no --model/--effort given)"
    return 0
  fi

  if [ "$yes" != "true" ]; then
    flog "WOULD-APPLY ${key}: model ${cur_model} -> ${to_model}$( [ "$effort_set" = "true" ] && echo ", effort ${cur_effort} -> ${to_effort}" )"
    flog "re-run with --yes to apply"
    return 1
  fi

  local batch_id sha cf
  batch_id="cli-${key}-$(date +%s)"
  sha=$(file_sha "$PROJECTS_JSON")
  cf=$(mktemp "${TMPDIR:-/tmp}/fleet-lead-flags.XXXXXX")
  jq -n --arg key "$key" --arg batch "$batch_id" --arg sha "$sha" \
     --arg fromModel "$cur_model" --arg toModel "$to_model" \
     --arg touchEffort "$( [ "$effort_set" = "true" ] && echo true || echo false )" \
     --arg fromEffort "$cur_effort" --arg toEffort "$to_effort" '
    def val($s): if $s == "null" then null else $s end;
    { batchId: $batch, expectedConfigSha: $sha,
      changes: [ { key: $key,
        from: ({ model: val($fromModel) }
               + (if $touchEffort == "true" then { effort: val($fromEffort) } else {} end)),
        to:   ({ model: val($toModel) }
               + (if $touchEffort == "true" then { effort: val($toEffort) } else {} end)) } ] }
  ' >"$cf" || { rm -f "$cf"; die "could not build the changes-file for ${key}"; }

  cmd_apply_batch "$cf"
  local rc=$?
  rm -f "$cf"
  return $rc
}

cmd_apply() {
  local want_lead="" want_project="" yes=false dry_run=false rollback=false txn_id_arg="" changes_file=""
  local flag_model_set=false flag_model="" flag_effort_set=false flag_effort="" flag_backend_set=false flag_backend=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --lead) [ -n "${2:-}" ] || die "--lead requires a value"; want_lead="$2"; shift 2 ;;
      --project) [ -n "${2:-}" ] || die "--project requires a value"; want_project="$2"; shift 2 ;;
      --changes-file) [ -n "${2:-}" ] || die "--changes-file requires a value"; changes_file="$2"; shift 2 ;;
      --model) [ -n "${2:-}" ] || die "--model requires a value (model id or 'default')"; flag_model_set=true; flag_model="$2"; shift 2 ;;
      --effort) [ -n "${2:-}" ] || die "--effort requires a value (level or 'default')"; flag_effort_set=true; flag_effort="$2"; shift 2 ;;
      --backend) [ -n "${2:-}" ] || die "--backend requires a value"; flag_backend_set=true; flag_backend="$2"; shift 2 ;;
      --yes) yes=true; shift ;;
      --dry-run) dry_run=true; shift ;;
      --rollback) rollback=true; shift ;;
      --txn) [ -n "${2:-}" ] || die "--txn requires a value"; txn_id_arg="$2"; shift 2 ;;
      *) die "apply: unknown argument $1" ;;
    esac
  done

  # FLY-709 P4.2: single-Lead value-flags sugar (see cmd_apply_lead_flags).
  if [ "$flag_model_set" = "true" ] || [ "$flag_effort_set" = "true" ] || [ "$flag_backend_set" = "true" ]; then
    [ -z "$changes_file" ] || die "value flags cannot be combined with --changes-file"
    [ "$rollback" = "false" ] || die "value flags cannot be combined with --rollback"
    cmd_apply_lead_flags "$want_lead" \
      "$flag_model_set" "$flag_model" \
      "$flag_effort_set" "$flag_effort" \
      "$flag_backend_set" "$flag_backend" \
      "$yes"
    return $?
  fi

  # FLY-247 inc2a: batch model-only apply. The console API created the launching
  # journal before spawn; here we validate the canonical request and drive the
  # batch. The batch does NOT hold restart.lock.d — each per-key cutover (inc1
  # single-key apply, a subprocess) acquires it itself (per-key granularity).
  if [ -n "$changes_file" ]; then
    cmd_apply_batch "$changes_file"
    return $?
  fi

  if [ "$rollback" = "true" ]; then
    cmd_rollback "$want_lead" "$txn_id_arg" "$yes"
    return $?
  fi

  guard_env_source
  acquire_lock

  local unfinished
  unfinished=$(find_unfinished_txns)
  if [ -n "$unfinished" ]; then
    ferr "Unfinished transaction(s) — refusing to start a new one:"
    echo "$unfinished" >&2
    ferr "Run: flywheel-fleet.sh recover --txn <id> --yes"
    exit 1
  fi

  # ── Step 1: immutable config snapshot ────────────────────────────────
  # R5#4: hash the SNAPSHOT COPY, not the live file — hashing and copying in
  # two unchecked reads of a mutating file lets an A→B→A race confirm
  # snapshot B while every later boundary check compares against live A.
  local snapshot_tmp
  # CI fix: GNU mktemp requires X's in -t templates (BSD treats -t as a bare
  # prefix). Use an explicit path template that both implementations accept.
  snapshot_tmp=$(mktemp "${TMPDIR:-/tmp}/fleet-config-snapshot.XXXXXX")
  cp "$PROJECTS_JSON" "$snapshot_tmp" || die "config snapshot copy failed"
  jq empty "$snapshot_tmp" 2>/dev/null || { rm -f "$snapshot_tmp"; die "config snapshot is not valid JSON"; }
  local config_sha
  config_sha=$(file_sha "$snapshot_tmp")
  if [ "$(file_sha "$PROJECTS_JSON")" != "$config_sha" ]; then
    rm -f "$snapshot_tmp"
    die "projects.json changed while snapshotting — retry"
  fi

  local targets
  targets=$(enumerate_targets "$snapshot_tmp" "$want_lead" "$want_project")
  check_lead_ambiguity "$targets" "$want_lead"
  [ -n "$targets" ] || { rm -f "$snapshot_tmp"; die "No leads matched."; }
  guard_target_keys "$(enumerate_targets "$snapshot_tmp" "" "")"

  # Classify + confirm every target BEFORE any mutation (R3#3).
  local applicable=() summaries=()
  local p l r
  while IFS=$'\t' read -r p l r; do
    [ -n "$p" ] || continue
    local key="${p}-${l}"
    local st cls
    st=$(collect_lead_state "$snapshot_tmp" "$p" "$l" "$r")
    cls=$(classify_lead "$st")
    case "$cls" in
      APPLICABLE)
        local dm mm
        dm=$(jq -r '.desired.model // ""' <<< "$st")
        mm=$(jq -r '.carrier.manifestModel // ""' <<< "$st")
        local policy_error
        if ! policy_error=$(validate_model_policy_value "$dm" 2>&1); then
          summaries+=("${key}: UNAPPLIED-MODEL-POLICY (${policy_error})")
          continue
        fi
        if [ "$dry_run" = "true" ]; then
          summaries+=("${key}: WOULD-APPLY model '${mm:-<none>}' → '${dm:-<none>}' (restart required)")
        elif confirm "Restart Lead ${key} to apply model '${mm:-<none>}' → '${dm:-<none>}'?" "$yes"; then
          applicable+=("${p}"$'\t'"${l}"$'\t'"${r}")
          summaries+=("${key}: CONFIRMED")
        else
          summaries+=("${key}: DECLINED (untouched)")
        fi
        ;;
      IN-SYNC)
        summaries+=("${key}: IN-SYNC") ;;
      UNAPPLIED*)
        summaries+=("${key}: ${cls}") ;;
    esac
  done <<< "$targets"

  local has_unapplied=false
  printf '%s\n' "${summaries[@]}"
  printf '%s\n' "${summaries[@]}" | grep -q "UNAPPLIED" && has_unapplied=true

  if [ "$dry_run" = "true" ]; then
    rm -f "$snapshot_tmp"
    flog "--dry-run: nothing was changed."
    [ "$has_unapplied" = "true" ] && exit 1 || exit 0
  fi

  # ── Step 2: zero applicable+confirmed → stop ────────────────────────
  if [ "${#applicable[@]}" -eq 0 ]; then
    rm -f "$snapshot_tmp"
    flog "No APPLICABLE+confirmed leads — exiting without touching anything."
    [ "$has_unapplied" = "true" ] && exit 1 || exit 0
  fi

  # ── Step 3: create transaction.json ─────────────────────────────────
  local txn_id
  txn_id="$(date +%Y%m%d-%H%M%S)-$$"
  local txn_dir="${FLEET_BACKUPS}/${txn_id}"
  mkdir -p "${txn_dir}/staged" "${txn_dir}/backup"
  cp "$snapshot_tmp" "${txn_dir}/config-snapshot.json"
  rm -f "$snapshot_tmp"
  local snapshot="${txn_dir}/config-snapshot.json"
  local txn="${txn_dir}/transaction.json"

  jq -n --arg txnId "$txn_id" --arg configSha "$config_sha" \
    '{transactionId: $txnId, configSha: $configSha, leads: {}}' > "$txn"

  local entry
  for entry in "${applicable[@]}"; do
    IFS=$'\t' read -r p l r <<< "$entry"
    local key="${p}-${l}"
    local cm="${MANIFEST_DIR}/${key}.json" cp_
    cp_=$(plist_path "$key")
    local m_sha p_sha proj_sha
    m_sha=$(file_sha "$cm"); p_sha=$(file_sha "$cp_"); proj_sha=$(manifest_projection_sha "$cm")
    local pre_project_model pre_project_effort pre_project_touch_effort
    local project_preimage_source
    if [ "${FLEET_PROJECT_PREIMAGE_MODEL+x}" = "x" ]; then
      # The batch/value-flags path writes projects.json itself, so it can pass
      # the exact reviewed SSOT value from before that write.
      [ "${FLEET_PROJECT_PREIMAGE_EFFORT+x}" = "x" ] \
        && [ "${FLEET_PROJECT_PREIMAGE_TOUCH_EFFORT+x}" = "x" ] \
        || die "incomplete fleet project pre-image evidence for ${key}"
      pre_project_model="$FLEET_PROJECT_PREIMAGE_MODEL"
      pre_project_effort="$FLEET_PROJECT_PREIMAGE_EFFORT"
      pre_project_touch_effort="$FLEET_PROJECT_PREIMAGE_TOUCH_EFFORT"
      project_preimage_source="batch-journal"
    else
      # Plain `apply` reconciles an already-edited projects.json snapshot to
      # the currently running artifacts. The snapshot is therefore the
      # post-image, not a rollback pre-image. The raw manifest fields are the
      # materializer/fleet-owned applied-state witness; a physical body launch
      # reads projects.json and never rewrites them. This is rollback evidence
      # only — it must never re-enter model resolution. Missing fields in a
      # valid, identity-bound manifest are
      # preserved as the literal "null" deletion marker; an absent, malformed,
      # or copied witness fails closed instead of guessing.
      jq -e --arg key "$key" \
        'type == "object"
         and (((.projectName // "") + "-" + (.leadId // "")) == $key)' \
        "$cm" >/dev/null 2>&1 \
        || die "${key}: manifest rollback witness is missing, malformed, or identity-mismatched"
      pre_project_model=$(jq -er '
        if (has("model") | not) or .model == null or .model == ""
        then "null"
        elif (.model | type) == "string" then .model
        else error("manifest model is not a string")
        end' "$cm") || die "${key}: cannot capture manifest model pre-image"
      pre_project_effort=$(jq -er '
        if (has("effort") | not) or .effort == null or .effort == ""
        then "null"
        elif (.effort | type) == "string" then .effort
        else error("manifest effort is not a string")
        end' "$cm") || die "${key}: cannot capture manifest effort pre-image"
      pre_project_touch_effort=true
      project_preimage_source="manifest"
    fi
    txn_update "$txn" \
      '.leads[$key] = {attempt: 1, phase: "pending",
        original: {manifestExisted: true, plistExisted: true,
                   manifestSha: $mSha, plistSha: $pSha, manifestProjSha: $projSha,
                   projectModel: $preProjectModel,
                   projectEffort: $preProjectEffort,
                   projectEffortTouched: ($preProjectTouchEffort == "1" or $preProjectTouchEffort == "true"),
                   projectPreimageSource: $projectPreimageSource},
        desired: {model: $dModel, effort: $dEffort}}' \
      --arg key "$key" --arg mSha "$m_sha" --arg pSha "$p_sha" \
      --arg projSha "$proj_sha" \
      --arg preProjectModel "$pre_project_model" \
      --arg preProjectEffort "$pre_project_effort" \
      --arg preProjectTouchEffort "$pre_project_touch_effort" \
      --arg projectPreimageSource "$project_preimage_source" \
      --arg dModel "$(jq -r --arg pp "$p" --arg ll "$l" '.[] | select(.projectName==$pp) | .leads[] | select(.agentId==$ll) | .model // ""' "$snapshot")" \
      --arg dEffort "$(jq -r --arg pp "$p" --arg ll "$l" '.[] | select(.projectName==$pp) | .leads[] | select(.agentId==$ll) | .effort // ""' "$snapshot")"
  done

  # ── Step 4-7: per-lead staged transactions ───────────────────────────
  local overall_rc=0
  local stop_remaining=false
  for entry in "${applicable[@]}"; do
    IFS=$'\t' read -r p l r <<< "$entry"
    local key="${p}-${l}"
    if [ "$stop_remaining" = "true" ]; then
      flog "${key}: SKIPPED (earlier failure stopped the transaction)"
      txn_update "$txn" '.leads[$key].phase = "unapplied"' --arg key "$key"
      overall_rc=1
      continue
    fi

    # TOCTOU re-verification (R5#3 + R8#5): config bytes, artifact
    # pre-images, full evidence gate — all immediately before bootout.
    if [ "$(file_sha "$PROJECTS_JSON")" != "$config_sha" ]; then
      ferr "${key}: projects.json changed since confirmation — stopping (partial)."
      txn_update "$txn" '.leads[$key].phase = "unapplied"' --arg key "$key"
      stop_remaining=true; overall_rc=1; continue
    fi
    local cm="${MANIFEST_DIR}/${key}.json" cpl
    cpl=$(plist_path "$key")
    local pre_m pre_p
    pre_m=$(jq -r '.leads[$key].original.manifestSha' --arg key "$key" "$txn")
    pre_p=$(jq -r '.leads[$key].original.plistSha' --arg key "$key" "$txn")
    if [ "$(file_sha "$cm")" != "$pre_m" ] || [ "$(file_sha "$cpl")" != "$pre_p" ]; then
      ferr "${key}: launch artifacts changed since classification — stopping (partial)."
      txn_update "$txn" '.leads[$key].phase = "unapplied"' --arg key "$key"
      stop_remaining=true; overall_rc=1; continue
    fi
    local st cls
    st=$(collect_lead_state "$snapshot" "$p" "$l" "$r")
    cls=$(classify_lead "$st")
    if [ "$cls" != "APPLICABLE" ]; then
      ferr "${key}: evidence gate re-run says '${cls}' — stopping (partial)."
      txn_update "$txn" '.leads[$key].phase = "unapplied"' --arg key "$key"
      stop_remaining=true; overall_rc=1; continue
    fi

    # Staging (§2.6 step 1): desired manifest = current canonical with
    # model/backendId updated; desired plist via the daemon helper with the
    # CANONICAL runtime path (R5#4). Canonical untouched here.
    local d_model d_effort
    d_model=$(jq -r '.leads[$key].desired.model' --arg key "$key" "$txn")
    # FLY-671: stage effort too, so generate_plist_to emits
    # FLYWHEEL_LEAD_EFFORT into the regenerated plist (empty = delete the field).
    d_effort=$(jq -r '.leads[$key].desired.effort // ""' --arg key "$key" "$txn")
    local staged_m="${txn_dir}/staged/${key}.manifest.json"
    local staged_p="${txn_dir}/staged/${key}.plist"
    local launch_environment
    launch_environment="$(read_plist_environment_json "$cpl")" || {
      ferr "${key}: existing plist EnvironmentVariables are unreadable or invalid — lead untouched, stopping."
      txn_update "$txn" '.leads[$key].phase = "unapplied"' --arg key "$key"
      stop_remaining=true; overall_rc=1; continue
    }
    local updated_launch_environment
    updated_launch_environment="$(jq -c --arg model "$d_model" --arg effort "$d_effort" '
      (if $model != "" then .FLYWHEEL_LEAD_MODEL = $model else del(.FLYWHEEL_LEAD_MODEL) end)
      | (if $effort != "" then .FLYWHEEL_LEAD_EFFORT = $effort else del(.FLYWHEEL_LEAD_EFFORT) end)' \
      <<<"$launch_environment")" || {
      ferr "${key}: launch environment staging failed — lead untouched, stopping."
      txn_update "$txn" '.leads[$key].phase = "unapplied"' --arg key "$key"
      stop_remaining=true; overall_rc=1; continue
    }
    launch_environment="$updated_launch_environment"
    if ! jq --arg model "$d_model" --arg effort "$d_effort" \
      --argjson launchEnvironment "$launch_environment" \
      '(if $model != "" then . + {model: $model} else del(.model) end)
       | (if $effort != "" then . + {effort: $effort} else del(.effort) end)
       | . + {leadBackend: {backendId: "claude-code"}, launchEnvironment: $launchEnvironment}' \
      "$cm" > "$staged_m" 2>/dev/null || ! jq empty "$staged_m" 2>/dev/null; then
      ferr "${key}: staging manifest failed — lead untouched, stopping."
      txn_update "$txn" '.leads[$key].phase = "unapplied"' --arg key "$key"
      stop_remaining=true; overall_rc=1; continue
    fi
    if ! generate_plist_to "$key" "$staged_m" "$cm" "$staged_p" >/dev/null 2>&1; then
      ferr "${key}: staging plist failed (lint?) — lead untouched, stopping."
      txn_update "$txn" '.leads[$key].phase = "unapplied"' --arg key "$key"
      stop_remaining=true; overall_rc=1; continue
    fi
    # R6#2: bind the staged artifacts to the transaction — the daemon
    # verifies these hashes at its boundary so staged files modified after
    # confirmation can never be committed.
    if ! txn_update "$txn" \
      '.leads[$key].staged = {manifestSha: $smSha, plistSha: $spSha}' \
      --arg key "$key" --arg smSha "$(file_sha "$staged_m")" --arg spSha "$(file_sha "$staged_p")"; then
      ferr "${key}: journal write failed — lead untouched, stopping."
      stop_remaining=true; overall_rc=1; continue
    fi
    # Backups (before any destructive action). R5#3: an unchecked failed cp
    # or journal write would void the promised automatic recovery path —
    # verify backup bytes and REQUIRE the journal advance before proceeding.
    if ! cp "$cm" "${txn_dir}/backup/${key}.manifest.json" \
      || ! cp "$cpl" "${txn_dir}/backup/${key}.plist" \
      || [ "$(file_sha "${txn_dir}/backup/${key}.manifest.json")" != "$(file_sha "$cm")" ] \
      || [ "$(file_sha "${txn_dir}/backup/${key}.plist")" != "$(file_sha "$cpl")" ]; then
      ferr "${key}: backup creation failed — lead untouched, stopping."
      txn_update "$txn" '.leads[$key].phase = "unapplied"' --arg key "$key"
      stop_remaining=true; overall_rc=1; continue
    fi
    if ! txn_update "$txn" '.leads[$key].phase = "prepared"' --arg key "$key"; then
      ferr "${key}: journal write failed — lead untouched, stopping."
      stop_remaining=true; overall_rc=1; continue
    fi

    # Delegate the destructive window to the hardened daemon (R3#2).
    "$DAEMON_BIN" install "$key" --staged-dir "$txn_dir"
    local rc=$?
    local result="${txn_dir}/result-${key}.json"
    local expected_attempt
    expected_attempt=$(jq -r --arg key "$key" '.leads[$key].attempt // 1' "$txn")
    if [ "$rc" -eq 0 ]; then
      # R2-H2: exit code 0 alone is NOT authoritative — require the
      # identity-bound applied record AND fresh probes before declaring
      # success (a wrapper/daemon mixup or stale binary returning 0 must
      # not mint an applied state).
      local ok_rec=false
      if validate_result_record "$result" "$txn_id" "$key" "$expected_attempt" \
        && [ "$(jq -r '.outcome' "$result" 2>/dev/null)" = "applied" ]; then
        ok_rec=true
      fi
      if [ "$ok_rec" != "true" ] || ! verify_booted "$key"; then
        ferr "${key}: daemon exited 0 but applied record/fresh probes do not confirm — manual intervention."
        txn_update "$txn" '.leads[$key].phase = "manual-intervention"' --arg key "$key"
        overall_rc=1
        stop_remaining=true
        continue
      fi
      # Record post-image for rollback CAS lineage (R5#5/R6#2).
      txn_update "$txn" \
        '.leads[$key].phase = "applied"
         | .leads[$key].postImage = {manifestSha: $mSha, plistSha: $pSha, manifestProjSha: $projSha}' \
        --arg key "$key" --arg mSha "$(file_sha "$cm")" --arg pSha "$(file_sha "$cpl")" \
        --arg projSha "$(manifest_projection_sha "$cm")"
      flog "${key}: APPLIED"
      continue
    fi

    # Recovery (§2.6 phase table; facts from the daemon's result record)
    overall_rc=1
    stop_remaining=true
    # Identity-bind the result record (R10#3 / code-review H2): a stale,
    # cross-key, cross-transaction or cross-attempt record must never choose
    # the recovery branch. Reject → fail-close to manual intervention.
    local rec_ok=false
    validate_result_record "$result" "$txn_id" "$key" "$expected_attempt" && rec_ok=true
    if [ "$rec_ok" != "true" ]; then
      ferr "${key}: daemon result record missing or identity mismatch — manual intervention (no blind recovery)."
      txn_update "$txn" '.leads[$key].phase = "manual-intervention"' --arg key "$key"
      continue
    fi
    local outcome new_pid
    outcome=$(jq -r '.outcome // "unknown"' "$result" 2>/dev/null || echo unknown)
    new_pid=$(jq -r '.newPid // empty' "$result" 2>/dev/null || true)
    case "$outcome" in
      stop_timeout)
        ferr "${key}: old process did not exit — NO bootstrap, manual intervention required."
        txn_update "$txn" '.leads[$key].phase = "manual-intervention"' --arg key "$key"
        ;;
      prep_failed*)
        flog "${key}: prep failed before any destructive action — canonical untouched."
        txn_update "$txn" '.leads[$key].phase = "unapplied"' --arg key "$key"
        ;;
      *)
        # bootstrap/verify/commit failures. R3-H2: take a FRESH probe before
        # EVERY branch — a process may have started after the result record
        # was written; restoring/bootstrapping beneath a live PID would
        # overwrite its carriers and double-bootstrap.
        local fresh_probe fresh_pid
        fresh_probe=$(launchd_probe "$key")
        if [ "$fresh_probe" = "error" ]; then
          ferr "${key}: launchd probe error during recovery — manual intervention (R5#1)."
          txn_update "$txn" '.leads[$key].phase = "manual-intervention"' --arg key "$key"
          continue
        fi
        fresh_pid=$([ "${fresh_probe%% *}" = "loaded" ] && echo "${fresh_probe##* }" || echo 0)
        # R6#4: loaded-without-PID is still LOADED — only alive_unverified
        # (which bootouts below) may proceed past a loaded label.
        if [ "${fresh_probe%% *}" = "loaded" ] && [ "$outcome" != "verify_failed_alive_unverified" ]; then
          ferr "${key}: outcome '${outcome}' but the label is loaded (pid ${fresh_pid}) — manual intervention."
          txn_update "$txn" '.leads[$key].phase = "manual-intervention"' --arg key "$key"
          continue
        fi
        if [ "$outcome" = "verify_failed_alive_unverified" ] && [ -n "$new_pid" ]; then
          # Record/probe agreement (R2-H2) before booting out based on it.
          if [ "$fresh_pid" != "0" ] && [ "$fresh_pid" != "$new_pid" ]; then
            ferr "${key}: result record newPid (${new_pid}) disagrees with fresh launchd probe (${fresh_pid}) — manual intervention."
            txn_update "$txn" '.leads[$key].phase = "manual-intervention"' --arg key "$key"
            continue
          fi
          flog "${key}: new process alive but unverified — stopping it before restore."
          "$LAUNCHCTL" bootout "${GUI_DOMAIN}/$(plist_label "$key")" 2>/dev/null || true
          if ! wait_pid_exit "$new_pid" "$STOP_TIMEOUT" || ! wait_label_unloaded "$key" "$STOP_TIMEOUT"; then
            ferr "${key}: failed NEW process would not exit — manual intervention."
            txn_update "$txn" '.leads[$key].phase = "manual-intervention"' --arg key "$key"
            continue
          fi
        elif [ "$fresh_pid" != "0" ] && [ -n "$fresh_pid" ] && kill -0 "$fresh_pid" 2>/dev/null; then
          # not_started/bootstrap_failed/commit_failed/unknown but a process
          # IS live now → the record is stale relative to reality. Fail-close.
          ferr "${key}: outcome '${outcome}' but a live process (${fresh_pid}) holds the label — manual intervention."
          txn_update "$txn" '.leads[$key].phase = "manual-intervention"' --arg key "$key"
          continue
        fi
        # Restore-first, bootstrap-second (R2#1); atomic per file (R4-M6);
        # journal 'restoring' first so a crash between the two renames is a
        # recognizable, finishable state (R5#7).
        txn_update "$txn" '.leads[$key].phase = "restoring"' --arg key "$key"
        if ! restore_file_atomic "${txn_dir}/backup/${key}.manifest.json" "$cm" "$pre_m" \
          || ! restore_file_atomic "${txn_dir}/backup/${key}.plist" "$cpl" "$pre_p"; then
          ferr "${key}: atomic restore failed hash verification — manual intervention."
          txn_update "$txn" '.leads[$key].phase = "manual-intervention"' --arg key "$key"
          continue
        fi
        if ! "$LAUNCHCTL" bootstrap "$GUI_DOMAIN" "$cpl" 2>/dev/null \
          || ! verify_booted "$key"; then
          ferr "${key}: backup plist bootstrap/boot-verify FAILED — Lead is down; manual intervention (not rolled-back)."
          txn_update "$txn" '.leads[$key].phase = "manual-intervention"' --arg key "$key"
          continue
        fi
        flog "${key}: ROLLED-BACK (backup plist bootstrapped, never regenerated)."
        txn_update "$txn" '.leads[$key].phase = "rolled-back"' --arg key "$key"
        ;;
    esac
  done

  echo ""
  flog "Transaction ${txn_id} complete. Summary:"
  jq -r '.leads | to_entries[] | "  \(.key): \(.value.phase)"' "$txn"
  [ "$has_unapplied" = "true" ] && overall_rc=1
  exit "$overall_rc"
}

# ════════════════════════════════════════════════════════════════
# rollback (R4#4 symmetric protocol + R5#5/R6#2 CAS)
# ════════════════════════════════════════════════════════════════

latest_txn_with_commits() {
  local dirs=() d
  for d in "$FLEET_BACKUPS"/*/; do
    [ -d "$d" ] && dirs+=("$d")
  done
  local i
  for (( i=${#dirs[@]}-1; i>=0; i-- )); do
    local t="${dirs[$i]}transaction.json"
    [ -f "$t" ] || continue
    if jq -e '[.leads // {} | to_entries[] | select(.value.phase == "applied")] | length > 0' "$t" >/dev/null 2>&1; then
      basename "${dirs[$i]}"
      return 0
    fi
  done
  return 1
}

cmd_rollback() {
  local want_lead="$1" txn_id="$2" yes="$3"
  guard_env_source
  acquire_lock

  # Unfinished-transaction reconcile first (R6#3) — refuse to skip.
  local unfinished
  unfinished=$(find_unfinished_txns)
  if [ -n "$unfinished" ]; then
    ferr "Unfinished transaction(s) must be recovered before rollback:"
    echo "$unfinished" >&2
    exit 1
  fi

  if [ -n "$txn_id" ] && ! validate_txn_id "$txn_id"; then
    die "unsafe --txn value (R4-H4)"
  fi
  if [ -z "$txn_id" ]; then
    txn_id=$(latest_txn_with_commits) || die "No transaction with applied commits found in ${FLEET_BACKUPS}."
  fi
  local txn_dir="${FLEET_BACKUPS}/${txn_id}"
  local txn="${txn_dir}/transaction.json"
  [ -f "$txn" ] || die "Transaction not found: ${txn}"
  if txn_has_retired_carrier_state "$txn" || jq -e 'has("wrapper")' "$txn" >/dev/null 2>&1; then
    die "rollback preflight rejected with zero changes: legacy carrier transaction is no longer executable"
  fi

  local keys
  if [ -n "$want_lead" ]; then
    keys="$want_lead"
  else
    keys=$(jq -r '.leads | to_entries[] | select(.value.phase == "applied") | .key' "$txn")
  fi
  [ -n "$keys" ] || die "No applied leads in transaction ${txn_id}."

  # FLY-1496: WHOLE-ROLLBACK policy/SSOT preflight. Do this before the first
  # confirmation, journal transition, bootout, or artifact write so a legacy
  # transaction or an unresolvable pre-image cannot produce a partial rollback.
  #
  # projectModel/projectEffort are literal string markers ("null" means field
  # absent). They were captured from projects.json, the SSOT, rather than from
  # the derived manifest. Old journals without these fields cannot prove a safe
  # SSOT rollback and therefore fail closed.
  local preflight_error=""
  local preflight_key
  for preflight_key in $keys; do
    if ! validate_key_grammar "$preflight_key"; then
      preflight_error="unsafe key '${preflight_key}' in transaction data"
      break
    fi
    if [ "$(jq -r --arg key "$preflight_key" '.leads[$key].phase // "missing"' "$txn")" != "applied" ]; then
      preflight_error="${preflight_key}: transaction phase is not applied"
      break
    fi
    local preflight_newer="" preflight_nd
    for preflight_nd in "$FLEET_BACKUPS"/*/; do
      [ -d "$preflight_nd" ] || continue
      local preflight_nid
      preflight_nid=$(basename "$preflight_nd")
      if [[ "$preflight_nid" > "$txn_id" ]] \
        && jq -e --arg key "$preflight_key" \
          '.leads[$key].phase == "applied"' "${preflight_nd}transaction.json" >/dev/null 2>&1; then
        preflight_newer="${preflight_newer}${preflight_nid} "
      fi
    done
    if [ -n "$preflight_newer" ]; then
      preflight_error="${preflight_key}: newer applied transaction(s) exist (${preflight_newer}) — roll those back first"
      break
    fi
    if ! jq -e --arg key "$preflight_key" \
      '.leads[$key].original
       | type == "object"
         and has("projectModel")
         and has("projectEffort")
         and has("projectEffortTouched")' "$txn" >/dev/null 2>&1; then
      preflight_error="${preflight_key}: transaction lacks projects.json pre-image fields; refusing unsafe legacy rollback"
      break
    fi

    local preflight_original_model preflight_policy_model
    preflight_original_model=$(jq -r --arg key "$preflight_key" \
      '.leads[$key].original.projectModel' "$txn")
    # An absent Lead model now resolves to the built-in safe Lead default.
    # Validate that effective value while preserving the exact absent marker
    # for the later SSOT restore.
    preflight_policy_model="$preflight_original_model"
    [ "$preflight_policy_model" = "null" ] && preflight_policy_model="claude-fable-5"
    local preflight_policy_message
    if ! preflight_policy_message=$(validate_model_policy_value "$preflight_policy_model" 2>&1); then
      preflight_error="${preflight_key}: rollback pre-image violates current model policy (${preflight_policy_message})"
      break
    fi

    local preflight_desired_model preflight_current_model
    preflight_desired_model=$(jq -r --arg key "$preflight_key" \
      '.leads[$key].desired.model
       | if . == null or . == "" then "null" else . end' "$txn")
    preflight_current_model=$(fleet_batch_current_model "$PROJECTS_JSON" "$preflight_key")
    if [ "$preflight_current_model" != "$preflight_desired_model" ]; then
      preflight_error="${preflight_key}: projects.json model changed since apply (current='${preflight_current_model}', transaction='${preflight_desired_model}')"
      break
    fi

    local preflight_touch_effort
    preflight_touch_effort=$(jq -r --arg key "$preflight_key" \
      '.leads[$key].original.projectEffortTouched' "$txn")
    if [ "$preflight_touch_effort" = "true" ]; then
      local preflight_desired_effort preflight_current_effort
      preflight_desired_effort=$(jq -r --arg key "$preflight_key" \
        '.leads[$key].desired.effort
         | if . == null or . == "" then "null" else . end' "$txn")
      preflight_current_effort=$(fleet_batch_current_effort "$PROJECTS_JSON" "$preflight_key")
      if [ "$preflight_current_effort" != "$preflight_desired_effort" ]; then
        preflight_error="${preflight_key}: projects.json effort changed since apply (current='${preflight_current_effort}', transaction='${preflight_desired_effort}')"
        break
      fi
    fi
  done
  if [ -n "$preflight_error" ]; then
    die "rollback preflight rejected with zero changes: ${preflight_error}"
  fi

  local overall_rc=0
  local key
  for key in $keys; do
    # R6#8: keys read from transaction data are a path boundary too — a
    # corrupt/crafted journal must not direct file operations outside the
    # key directory.
    if ! validate_key_grammar "$key"; then
      ferr "unsafe key '${key}' in transaction data — skipping (manual intervention)."
      overall_rc=1; continue
    fi
    local phase
    phase=$(jq -r --arg key "$key" '.leads[$key].phase // "missing"' "$txn")
    if [ "$phase" != "applied" ]; then
      ferr "${key}: phase is '${phase}' (not applied) — skipping."
      overall_rc=1; continue
    fi

    local cm="${MANIFEST_DIR}/${key}.json" cpl
    cpl=$(plist_path "$key")

    # CAS preconditions (R5#5 + R6#2): plist exact hash; manifest SEMANTIC
    # projection (claude-lead.sh rewrites pid at every boot — whole-file CAS
    # would reject every legitimate rollback). Transaction must be this
    # lead's newest non-rolled-back commit.
    local post_p post_proj
    post_p=$(jq -r --arg key "$key" '.leads[$key].postImage.plistSha // ""' "$txn")
    post_proj=$(jq -r --arg key "$key" '.leads[$key].postImage.manifestProjSha // ""' "$txn")
    if [ "$(file_sha "$cpl")" != "$post_p" ]; then
      ferr "${key}: current plist does not match transaction post-image — a newer change exists. Roll back newer transactions first."
      overall_rc=1; continue
    fi
    if [ "$(manifest_projection_sha "$cm")" != "$post_proj" ]; then
      ferr "${key}: manifest launch-affecting fields changed since this transaction — refusing (would overwrite an operator change)."
      overall_rc=1; continue
    fi
    # Fail-close on non-standard runtime/management (R5#5 / code-review H4):
    # indeterminate → refuse; a LIVE process whose binding is not standard
    # (label loaded but pid/identity divergent — e.g. a bespoke takeover or
    # FLY-250 path) → refuse, do not bootout someone else's Lead. An
    # UNLOADED lead is safe: CAS already pinned the on-disk carriers.
    local mgmt
    mgmt=$(observed_management "$key")
    if [ "$mgmt" = "indeterminate" ]; then
      ferr "${key}: management evidence indeterminate — refusing rollback."
      overall_rc=1; continue
    fi
    local rb_probe
    rb_probe=$(launchd_probe "$key")
    if [ "$rb_probe" = "error" ]; then
      ferr "${key}: launchd probe error — refusing rollback (R5#1)."
      overall_rc=1; continue
    fi
    if [ "$mgmt" = "external-confirmed" ] && [ "${rb_probe%% *}" = "loaded" ]; then
      ferr "${key}: a live non-standard-bound process holds this label — refusing rollback (would take over an externally managed Lead)."
      overall_rc=1; continue
    fi
    # R2-H1: runtime axis must also fail-close — a manual/nohup Claude can be
    # alive with the label UNLOADED; bootstrapping another Lead on top of it
    # would double-run. Only standard-confirmed management may coexist with a
    # live Claude runtime (that's the Lead we are about to stop ourselves).
    local rt
    rt=$(observed_runtime "$key")
    if [ "$rt" = "indeterminate" ]; then
      ferr "${key}: runtime evidence indeterminate — refusing rollback."
      overall_rc=1; continue
    fi
    if [ "$rt" = "claude-confirmed" ] && [ "$mgmt" != "standard-confirmed" ]; then
      ferr "${key}: a live Claude process exists without standard binding (manual/nohup?) — refusing rollback."
      overall_rc=1; continue
    fi

    if ! confirm "Roll back Lead ${key} to transaction ${txn_id} pre-image (restart required)?" "$yes"; then
      flog "${key}: declined — zero action."
      continue
    fi

    # stop → wait → restore → verify → bootstrap (R2#1/R4#4).
    # R6#3: journal the destructive intent BEFORE bootout — a crash mid-stop
    # must be recognizable ('restoring' recovery fail-closes on a loaded
    # label and finishes the restore otherwise).
    if ! txn_update "$txn" '.leads[$key].phase = "restoring"' --arg key "$key"; then
      ferr "${key}: journal write failed — refusing destructive rollback."
      overall_rc=1; continue
    fi
    local cur_pid
    cur_pid=$([ "${rb_probe%% *}" = "loaded" ] && echo "${rb_probe##* }" || echo 0)
    "$LAUNCHCTL" bootout "${GUI_DOMAIN}/$(plist_label "$key")" 2>/dev/null || true
    if ! wait_pid_exit "$cur_pid" "$STOP_TIMEOUT" || ! wait_label_unloaded "$key" "$STOP_TIMEOUT"; then
      ferr "${key}: current process would not exit — NO bootstrap, manual intervention."
      txn_update "$txn" '.leads[$key].phase = "manual-intervention"' --arg key "$key"
      overall_rc=1; continue
    fi

    # Restore the authoritative projects.json pre-image under the same
    # config-write lock used by forward fleet writes. This happens only after
    # the current Lead is stopped, and before restoring/bootstrapping derived
    # artifacts, so the next physical launch derives from the restored SSOT.
    local original_project_model original_project_effort original_project_touch_effort
    original_project_model=$(jq -r --arg key "$key" \
      '.leads[$key].original.projectModel' "$txn")
    original_project_effort=$(jq -r --arg key "$key" \
      '.leads[$key].original.projectEffort' "$txn")
    original_project_touch_effort=$(jq -r --arg key "$key" \
      'if .leads[$key].original.projectEffortTouched then "1" else "0" end' "$txn")
    if ! config_write_locked "${FLEET_CONFIG_LOCK_FILE:-${PROJECTS_JSON}.cfglock}" 30 \
      bash "$_FLEET_BATCH_LIB" write-key-fields "$PROJECTS_JSON" "$key" \
        "$original_project_model" "$original_project_touch_effort" "$original_project_effort"; then
      ferr "${key}: projects.json pre-image restore failed — Lead remains down; manual intervention."
      txn_update "$txn" '.leads[$key].phase = "manual-intervention"' --arg key "$key"
      overall_rc=1; continue
    fi

    local orig_m orig_p
    orig_m=$(jq -r --arg key "$key" '.leads[$key].original.manifestSha' "$txn")
    orig_p=$(jq -r --arg key "$key" '.leads[$key].original.plistSha' "$txn")
    txn_update "$txn" '.leads[$key].phase = "restoring"' --arg key "$key"
    if ! restore_file_atomic "${txn_dir}/backup/${key}.manifest.json" "$cm" "$orig_m" \
      || ! restore_file_atomic "${txn_dir}/backup/${key}.plist" "$cpl" "$orig_p"; then
      ferr "${key}: atomic restore failed hash verification — manual intervention."
      txn_update "$txn" '.leads[$key].phase = "manual-intervention"' --arg key "$key"
      overall_rc=1; continue
    fi
    if ! "$LAUNCHCTL" bootstrap "$GUI_DOMAIN" "$cpl" 2>/dev/null \
      || ! verify_booted "$key"; then
      ferr "${key}: backup plist bootstrap/boot-verify FAILED — Lead is down; manual intervention (not rolled-back)."
      txn_update "$txn" '.leads[$key].phase = "manual-intervention"' --arg key "$key"
      overall_rc=1; continue
    fi
    txn_update "$txn" '.leads[$key].phase = "rolled-back"' --arg key "$key"
    flog "${key}: ROLLED-BACK to pre-${txn_id} state (backup plist bootstrapped, never regenerated)."
  done
  exit "$overall_rc"
}

# ════════════════════════════════════════════════════════════════
# recover (R6#3: first-class entry for mutating recovery)
# ════════════════════════════════════════════════════════════════

cmd_recover() {
  local txn_id="" want_lead="" yes=false batch_id=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --txn) [ -n "${2:-}" ] || die "--txn requires a value"; txn_id="$2"; shift 2 ;;
      --batch) [ -n "${2:-}" ] || die "--batch requires a value"; batch_id="$2"; shift 2 ;;
      --lead) [ -n "${2:-}" ] || die "--lead requires a value"; want_lead="$2"; shift 2 ;;
      --yes) yes=true; shift ;;
      *) die "recover: unknown argument $1" ;;
    esac
  done

  # FLY-247 inc2a: batch recovery. Reconciles an interrupted `--changes-file`
  # batch (launching → rejected; running → per-key reconcile → recover-required
  # or terminal reduction). Echoes the resulting BatchStatus.
  if [ -n "$batch_id" ]; then
    validate_txn_id "$batch_id" || die "unsafe --batch value"
    [ "$yes" = "true" ] || die "recover is mutating — requires explicit --yes"
    guard_env_source
    fleet_batch_recover "$PROJECTS_JSON" "$batch_id"
    return $?
  fi

  [ -n "$txn_id" ] || die "recover requires --txn <id> (or --batch <id>)"
  validate_txn_id "$txn_id" || die "unsafe --txn value (R4-H4)"
  [ "$yes" = "true" ] || die "recover is mutating — requires explicit --yes"
  guard_env_source

  local txn_dir="${FLEET_BACKUPS}/${txn_id}"
  local txn="${txn_dir}/transaction.json"
  [ -f "$txn" ] || die "Transaction not found: ${txn}"
  if txn_has_retired_carrier_state "$txn" || jq -e 'has("wrapper")' "$txn" >/dev/null 2>&1; then
    die "recovery rejected with zero changes: legacy carrier transaction is no longer executable"
  fi
  acquire_lock

  local keys
  if [ -n "$want_lead" ]; then
    keys="$want_lead"
  else
    keys=$(jq -r --argjson term "$TERMINAL_PHASES" \
      '.leads | to_entries[] | select(.value.phase as $p | $term | index($p) | not) | .key' "$txn")
  fi
  [ -n "$keys" ] || { flog "Nothing to recover in ${txn_id}."; exit 0; }

  local recover_rc=0
  local key
  for key in $keys; do
    if ! validate_key_grammar "$key"; then
      ferr "unsafe key '${key}' in transaction data — skipping (manual intervention, R6#8)."
      recover_rc=1; continue
    fi
    local phase cm cpl
    phase=$(jq -r --arg key "$key" '.leads[$key].phase' "$txn")
    cm="${MANIFEST_DIR}/${key}.json"
    cpl=$(plist_path "$key")
    local orig_m orig_p
    orig_m=$(jq -r --arg key "$key" '.leads[$key].original.manifestSha' "$txn")
    orig_p=$(jq -r --arg key "$key" '.leads[$key].original.plistSha' "$txn")
    flog "${key}: reconciling non-terminal phase '${phase}' (§2.6 table)"
    case "$phase" in
      prepared)
        # Nothing destructive happened — verify canonical untouched.
        if [ "$(file_sha "$cm")" = "$orig_m" ] && [ "$(file_sha "$cpl")" = "$orig_p" ]; then
          txn_update "$txn" '.leads[$key].phase = "rolled-back"' --arg key "$key"
          flog "${key}: canonical untouched — marked rolled-back."
        else
          txn_update "$txn" '.leads[$key].phase = "manual-intervention"' --arg key "$key"
          ferr "${key}: canonical differs at 'prepared' — manual intervention."
          recover_rc=1
        fi
        ;;
      stopping)
        # R8#1 + R3-H1: ALWAYS treat as unfinished stop — idempotent
        # re-bootout + wait on the JOURNAL-persisted old PID (written
        # atomically with 'stopping'; the result record may not exist if the
        # crash hit before it). A journal entry WITHOUT oldPid is a protocol
        # violation → manual intervention; oldPid=0 is a valid recorded
        # value meaning "was not running at stop time".
        local old_pid
        old_pid=$(jq -r --arg key "$key" 'if (.leads[$key].oldPid | type) == "number" and .leads[$key].oldPid >= 0 then .leads[$key].oldPid else "invalid" end' "$txn" 2>/dev/null || echo invalid)
        if [ "$old_pid" = "invalid" ] || [ -z "$old_pid" ]; then
          txn_update "$txn" '.leads[$key].phase = "manual-intervention"' --arg key "$key"
          ferr "${key}: journal has 'stopping' but no persisted oldPid — manual intervention."
          recover_rc=1
          continue
        fi
        "$LAUNCHCTL" bootout "${GUI_DOMAIN}/$(plist_label "$key")" 2>/dev/null || true
        if ! wait_pid_exit "$old_pid" "$STOP_TIMEOUT"; then
          txn_update "$txn" '.leads[$key].phase = "manual-intervention"' --arg key "$key"
          ferr "${key}: old PID still alive after re-bootout — manual intervention."
          recover_rc=1
          continue
        fi
        # fallthrough to stopped handling
        recover_restore_and_bootstrap "$txn_dir" "$txn" "$key" "$cm" "$cpl" "$orig_m" "$orig_p" || recover_rc=1
        ;;
      restoring)
        # R5#7: crash inside the rollback window. R6#6: a LOADED label here
        # can be the legitimate post-bootstrap crash state — if the restored
        # Lead fully verifies, the rollback in fact completed; mark it.
        local rest_probe
        rest_probe=$(launchd_probe "$key")
        if [ "$rest_probe" = "error" ]; then
          txn_update "$txn" '.leads[$key].phase = "manual-intervention"' --arg key "$key"
          ferr "${key}: cannot finish interrupted restore (probe error) — manual intervention."
          recover_rc=1
          continue
        fi
        if [ "${rest_probe%% *}" = "loaded" ]; then
          if [ "$(file_sha "$cm" 2>/dev/null)" = "$orig_m" ] \
            && [ "$(file_sha "$cpl" 2>/dev/null)" = "$orig_p" ] \
            && verify_booted "$key"; then
            txn_update "$txn" '.leads[$key].phase = "rolled-back"' --arg key "$key"
            flog "${key}: restore had completed and the Lead is verified — rolled-back."
            continue
          fi
          txn_update "$txn" '.leads[$key].phase = "manual-intervention"' --arg key "$key"
          ferr "${key}: label loaded mid-restore without a verified restored Lead — manual intervention."
          recover_rc=1
          continue
        fi
        recover_restore_and_bootstrap "$txn_dir" "$txn" "$key" "$cm" "$cpl" "$orig_m" "$orig_p" || recover_rc=1
        ;;
      stopped|committing|committed)
        # R3-H3: a LIVE PID during these phases is INCONSISTENT — the daemon
        # only bootstraps after 'bootstrapping' is journaled, so anything
        # running here is an external takeover or a protocol violation.
        # Fail-close; never bootout a process we cannot account for.
        local rec_probe lpid
        rec_probe=$(launchd_probe "$key")
        if [ "$rec_probe" = "error" ]; then
          txn_update "$txn" '.leads[$key].phase = "manual-intervention"' --arg key "$key"
          ferr "${key}: launchd probe error during recovery — manual intervention (R5#1)."
          recover_rc=1
          continue
        fi
        if [ "${rec_probe%% *}" = "loaded" ]; then
          # R6#4: loaded-without-PID counts — anything HOLDING the label
          # during these phases is protocol-impossible. Fail-close.
          txn_update "$txn" '.leads[$key].phase = "manual-intervention"' --arg key "$key"
          ferr "${key}: label loaded during phase '${phase}' (impossible for this protocol) — manual intervention."
          recover_rc=1
          continue
        fi
        recover_restore_and_bootstrap "$txn_dir" "$txn" "$key" "$cm" "$cpl" "$orig_m" "$orig_p" || recover_rc=1
        ;;
      bootstrapping|verifying)
        # §2.6 table: a live, FULLY VERIFIED Lead here means the apply
        # actually succeeded before the crash → mark applied (do not stop a
        # healthy Lead). A live-but-unverified one is stopped, then restored.
        local rec_probe2 lpid
        rec_probe2=$(launchd_probe "$key")
        if [ "$rec_probe2" = "error" ]; then
          txn_update "$txn" '.leads[$key].phase = "manual-intervention"' --arg key "$key"
          ferr "${key}: launchd probe error during recovery — manual intervention (R5#1)."
          recover_rc=1
          continue
        fi
        lpid=$([ "${rec_probe2%% *}" = "loaded" ] && echo "${rec_probe2##* }" || echo 0)
        if [ "${rec_probe2%% *}" = "loaded" ] && { [ "$lpid" = "0" ] || ! kill -0 "$lpid" 2>/dev/null; }; then
          # R6#4: loaded-without-(live)-PID — bootout and require a positive
          # unloaded probe before restoring beneath the label.
          "$LAUNCHCTL" bootout "${GUI_DOMAIN}/$(plist_label "$key")" 2>/dev/null || true
          if ! wait_label_unloaded "$key" "$STOP_TIMEOUT"; then
            txn_update "$txn" '.leads[$key].phase = "manual-intervention"' --arg key "$key"
            ferr "${key}: label would not unload — manual intervention."
            recover_rc=1
            continue
          fi
        elif [ "$lpid" != "0" ] && [ -n "$lpid" ] && kill -0 "$lpid" 2>/dev/null; then
          if verify_booted "$key"; then
            txn_update "$txn" \
              '.leads[$key].phase = "applied"
               | .leads[$key].postImage = {manifestSha: $mSha, plistSha: $pSha, manifestProjSha: $projSha}' \
              --arg key "$key" --arg mSha "$(file_sha "$cm")" --arg pSha "$(file_sha "$cpl")" \
              --arg projSha "$(manifest_projection_sha "$cm")"
            flog "${key}: live Lead verified during recovery — marked applied (not stopped)."
            continue
          fi
          "$LAUNCHCTL" bootout "${GUI_DOMAIN}/$(plist_label "$key")" 2>/dev/null || true
          if ! wait_pid_exit "$lpid" "$STOP_TIMEOUT"; then
            txn_update "$txn" '.leads[$key].phase = "manual-intervention"' --arg key "$key"
            ferr "${key}: live unverified process would not exit — manual intervention."
            recover_rc=1
            continue
          fi
        fi
        recover_restore_and_bootstrap "$txn_dir" "$txn" "$key" "$cm" "$cpl" "$orig_m" "$orig_p" || recover_rc=1
        ;;
      *)
        flog "${key}: terminal phase '${phase}' — nothing to do."
        ;;
    esac
  done
  exit "$recover_rc"
}

recover_restore_and_bootstrap() {
  local txn_dir="$1" txn="$2" key="$3" cm="$4" cpl="$5" orig_m="$6" orig_p="$7"
  # Absence semantics (R2#2): if the originals never existed, recovery means
  # restoring ABSENCE — delete this transaction's artifacts, stay unloaded.
  # Never assume there is always a bootstrappable backup.
  local m_existed
  # NOTE: jq's // treats false as empty (false // true == true) — must test
  # strict equality, not a default-fallback read.
  m_existed=$(jq -r --arg key "$key" '.leads[$key].original.manifestExisted == false' "$txn")
  if [ "$m_existed" = "true" ]; then
    # R3-M6: only delete carriers we can account for — current bytes must be
    # absent or THIS transaction's staged artifacts. Unknown bytes mean
    # someone recreated the lead after the crash; deleting would destroy it.
    local sm sp cmx cpx
    sm=$(file_sha "${txn_dir}/staged/${key}.manifest.json" 2>/dev/null || echo "__none__")
    sp=$(file_sha "${txn_dir}/staged/${key}.plist" 2>/dev/null || echo "__none__")
    cmx=$([ -f "$cm" ] && file_sha "$cm" || echo "__absent__")
    cpx=$([ -f "$cpl" ] && file_sha "$cpl" || echo "__absent__")
    local m_ok=false p_ok=false
    { [ "$cmx" = "__absent__" ] || [ "$cmx" = "$sm" ]; } && m_ok=true
    { [ "$cpx" = "__absent__" ] || [ "$cpx" = "$sp" ]; } && p_ok=true
    if [ "$m_ok" != "true" ] || [ "$p_ok" != "true" ]; then
      txn_update "$txn" '.leads[$key].phase = "manual-intervention"' --arg key "$key"
      ferr "${key}: absence restore refused — current carriers are not this transaction's artifacts; manual intervention."
      return 1
    fi
    rm -f "$cm" "$cpl"
    txn_update "$txn" '.leads[$key].phase = "rolled-back"' --arg key "$key"
    flog "${key}: originals were absent — restored absence (artifacts removed, left unloaded)."
    return 0
  fi
  # PHASE-SPECIFIC hash reconciliation BEFORE overwriting (code-review R2-H4):
  # each journal phase admits only the states the fixed manifest→plist commit
  # order can actually produce. Impossible combinations (e.g. staged bytes
  # while still 'stopped', or plist-staged with manifest-original during
  # 'committing') mean someone else touched the files — fail-close.
  local phase
  phase=$(jq -r --arg key "$key" '.leads[$key].phase' "$txn")
  local staged_m_sha staged_p_sha cur_m_sha cur_p_sha
  staged_m_sha=$(file_sha "${txn_dir}/staged/${key}.manifest.json" 2>/dev/null || echo "__none__")
  staged_p_sha=$(file_sha "${txn_dir}/staged/${key}.plist" 2>/dev/null || echo "__none__")
  cur_m_sha=$(file_sha "$cm" 2>/dev/null || echo "__absent__")
  cur_p_sha=$(file_sha "$cpl" 2>/dev/null || echo "__absent__")
  local combo_ok=false
  case "$phase" in
    restoring)
      # mid-restore: each file is either already restored (orig) or still
      # the staged/committed bytes — any per-file mix of the two is legal.
      # R6#6: a manifest whose PROJECTION matches staged (pid self-written
      # by the briefly-booted Lead) is the staged state too.
      local m_ok2=false p_ok2=false
      { [ "$cur_m_sha" = "$orig_m" ] || [ "$cur_m_sha" = "$staged_m_sha" ]; } && m_ok2=true
      if [ "$m_ok2" != "true" ] && [ -f "${txn_dir}/staged/${key}.manifest.json" ] \
        && [ "$(manifest_projection_sha "$cm")" != "__absent-or-invalid__" ] \
        && [ "$(manifest_projection_sha "$cm")" = "$(manifest_projection_sha "${txn_dir}/staged/${key}.manifest.json")" ]; then
        m_ok2=true
      fi
      { [ "$cur_p_sha" = "$orig_p" ] || [ "$cur_p_sha" = "$staged_p_sha" ]; } && p_ok2=true
      [ "$m_ok2" = "true" ] && [ "$p_ok2" = "true" ] && combo_ok=true
      ;;
    stopping|stopped)
      # commit never began: both carriers must still be the originals
      [ "$cur_m_sha" = "$orig_m" ] && [ "$cur_p_sha" = "$orig_p" ] && combo_ok=true
      ;;
    committing)
      # fixed order manifest→plist: (orig,orig) | (staged,orig) | (staged,staged)
      if [ "$cur_m_sha" = "$orig_m" ] && [ "$cur_p_sha" = "$orig_p" ]; then combo_ok=true; fi
      if [ "$cur_m_sha" = "$staged_m_sha" ] && [ "$cur_p_sha" = "$orig_p" ]; then combo_ok=true; fi
      if [ "$cur_m_sha" = "$staged_m_sha" ] && [ "$cur_p_sha" = "$staged_p_sha" ]; then combo_ok=true; fi
      ;;
    committed|bootstrapping|verifying)
      # commit finished before the crash: both must be the staged artifacts.
      # EXCEPTION: a bootstrapped Lead may have begun running and self-written
      # its pid into the manifest — accept a manifest whose PROJECTION matches
      # the staged one (pid is the only legal divergence).
      if [ "$cur_p_sha" = "$staged_p_sha" ]; then
        if [ "$cur_m_sha" = "$staged_m_sha" ]; then
          combo_ok=true
        elif [ -f "${txn_dir}/staged/${key}.manifest.json" ] \
          && [ "$(manifest_projection_sha "$cm")" != "__absent-or-invalid__" ] \
          && [ "$(manifest_projection_sha "$cm")" = "$(manifest_projection_sha "${txn_dir}/staged/${key}.manifest.json")" ]; then
          combo_ok=true
        fi
      fi
      ;;
  esac
  if [ "$combo_ok" != "true" ]; then
    txn_update "$txn" '.leads[$key].phase = "manual-intervention"' --arg key "$key"
    ferr "${key}: canonical bytes are not a state phase '${phase}' can produce — refusing blind restore; manual intervention."
    return 1
  fi
  txn_update "$txn" '.leads[$key].phase = "restoring"' --arg key "$key"
  if ! restore_file_atomic "${txn_dir}/backup/${key}.manifest.json" "$cm" "$orig_m" \
    || ! restore_file_atomic "${txn_dir}/backup/${key}.plist" "$cpl" "$orig_p"; then
    txn_update "$txn" '.leads[$key].phase = "manual-intervention"' --arg key "$key"
    ferr "${key}: atomic restore failed hash verification — manual intervention."
    return 1
  fi
  if ! "$LAUNCHCTL" bootstrap "$GUI_DOMAIN" "$cpl" 2>/dev/null \
    || ! verify_booted "$key"; then
    txn_update "$txn" '.leads[$key].phase = "manual-intervention"' --arg key "$key"
    ferr "${key}: backup plist bootstrap/boot-verify FAILED during recovery — Lead is down; manual intervention."
    return 1
  fi
  txn_update "$txn" '.leads[$key].phase = "rolled-back"' --arg key "$key"
  flog "${key}: restored backups + bootstrapped backup plist → rolled-back."
}

# ════════════════════════════════════════════════════════════════
# Main
# ════════════════════════════════════════════════════════════════

fleet_usage() {
  cat <<'EOF'
Usage: flywheel-fleet.sh <command> [options]

Commands:
  plan   [--lead <key>] [--project <p>]
         Read-only three-way drift report (config / manifest / plist +
         observed management×runtime). Never mutates.
  apply  [--lead <key>] [--project <p>] [--yes] [--dry-run]
  apply  --lead <key> [--model <id|default>] [--effort <level|default>] [--backend <id>] --yes
         FLY-709 Path C single-Lead sugar over the batch engine (backend diff = manual cutover, fail-close)
         Apply model-only changes to confirmed-standard Claude leads via a
         staged transaction (confirm → backup → daemon staged install →
         verify → auto-rollback on failure). Anything codex / unknown /
         not-installed is UNAPPLIED (fail-close).
  apply --rollback [--txn <id>] [--lead <key>] [--yes]
         Symmetric rollback of an applied transaction (CAS-guarded).
  recover --txn <id> [--lead <key>] --yes
         Deterministic recovery of an unfinished transaction (§2.6 table).
EOF
}

if [ "${FLYWHEEL_FLEET_SOURCED:-0}" = "1" ]; then
  return 0 2>/dev/null || true
fi

FLEET_COMMAND="${1:-}"
shift || true

case "$FLEET_COMMAND" in
  plan)    cmd_plan "$@" ;;
  apply)   cmd_apply "$@" ;;
  recover) cmd_recover "$@" ;;
  -h|--help|help|"") fleet_usage ;;
  *) die "Unknown command: ${FLEET_COMMAND}" ;;
esac
