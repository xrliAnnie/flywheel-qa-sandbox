#!/bin/bash
# FLY-350 H-2: shared role-aware Lead rule-bundle resolver.
#
# Single source of truth for WHICH base governance / role rule files a Lead loads,
# and in what ORDER. A full-access Codex Lead (= Claude-equal) must run under the
# SAME founder-only-authority contract + role rules as the corresponding Claude
# Lead. `codex-lead.sh` sources this to build FLYWHEEL_LEAD_SYSTEM_PROMPT_FILES
# (→ Codex `baseInstructions`).
#
# Parity with claude-lead.sh's inline assembly (claude-lead.sh:1448-1617) is held
# by lead-rules-bundle.test.ts: the resolver's per-role ordered output is asserted
# AGAINST the exact BASE rule files claude-lead.sh references, so the two cannot
# drift even though claude-lead.sh keeps its proven inline block (every Claude Lead
# runs through it — refactoring it is out of scope; the parity test is the bind).
#
# This resolver covers the BASE (project-AGNOSTIC) governance/role layer only —
# NOT the project `.lead/shared` concrete-data layer (channel ids, dept→Lead name
# maps), which stays launcher/project-specific (a Codex Lead carries that concrete
# context in its identity.md persona instead).
#
# The resolver functions are pure (ordered paths on stdout, diagnostics on
# stderr). The FLY-1402 materializer below writes one caller-selected bundle.

# Emit <path> on stdout iff it exists + is readable. When <required>=1 and the file
# is missing, print MISSING_REQUIRED:<path> to stderr and return 10 (fail-closed).
_lrb_emit() {
  local path="$1" required="${2:-0}"
  if [ -f "$path" ] && [ -r "$path" ]; then
    printf '%s\n' "$path"
    return 0
  fi
  if [ "$required" = "1" ]; then
    printf 'MISSING_REQUIRED:%s\n' "$path" >&2
    return 10
  fi
  return 0
}

# FLY-1402: collect the exact ordered rule sources selected by claude-lead.sh.
# Explicit initialization is required for bash 3.2 callers running with set -u.
rules_bundle_reset() {
  RULES_BUNDLE_FILES=()
  RULES_BUNDLE_LABELS=()
}

# rules_bundle_add <absolute-source-path> <layer-label>
rules_bundle_add() {
  RULES_BUNDLE_FILES+=("$1")
  RULES_BUNDLE_LABELS+=("$2")
  # Emergency compatibility valve: preserve today's argv byte-for-byte while
  # still recording the selected sources for the active receipt/truth checker.
  # CLAUDE_ARGS is owned by the sourcing launcher (bash dynamic/global scope).
  if [ "${RULES_BUNDLE_MODE:-bundle}" = "legacy" ]; then
    CLAUDE_ARGS+=(--append-system-prompt-file "$1")
  fi
}

# rules_bundle_materialize <output-path> <role> <lead-id> <project>
# On success stdout contains only the final path. Diagnostics are stderr-only so
# callers may safely capture the result with command substitution.
rules_bundle_materialize() {
  local out_path="$1" role="$2" lead_id="$3" project="$4"
  local count="${#RULES_BUNDLE_FILES[@]}"
  [ "$count" -eq 0 ] && return 0

  local out_dir body_tmp final_tmp sha generated_at
  out_dir="$(dirname "$out_path")" || return 1
  if ! mkdir -p "$out_dir" || ! chmod 0700 "$out_dir"; then
    return 1
  fi
  body_tmp="$(mktemp "${out_dir}/.rules-bundle-body.XXXXXX")" || return 1
  final_tmp=""

  local i path label basename last_byte
  i=0
  while [ "$i" -lt "$count" ]; do
    path="${RULES_BUNDLE_FILES[$i]}"
    label="${RULES_BUNDLE_LABELS[$i]}"
    basename="${path##*/}"
    if ! printf '═══ RULE SOURCE [%s/%s]: %s/%s ═══\n' \
      "$((i + 1))" "$count" "$label" "$basename" >>"$body_tmp" ||
      ! cat "$path" >>"$body_tmp"; then
      rm -f "$body_tmp"
      return 1
    fi
    last_byte="$(tail -c 1 "$path" 2>/dev/null | od -An -t u1 | tr -d '[:space:]')"
    if [ "$last_byte" = "10" ]; then
      printf '\n' >>"$body_tmp" || {
        rm -f "$body_tmp"
        return 1
      }
    else
      printf '\n\n' >>"$body_tmp" || {
        rm -f "$body_tmp"
        return 1
      }
    fi
    i=$((i + 1))
  done

  if command -v shasum >/dev/null 2>&1; then
    sha="$(shasum -a 256 "$body_tmp" | awk '{print $1}')" || {
      rm -f "$body_tmp"
      return 1
    }
  elif command -v sha256sum >/dev/null 2>&1; then
    sha="$(sha256sum "$body_tmp" | awk '{print $1}')" || {
      rm -f "$body_tmp"
      return 1
    }
  else
    sha="unavailable"
    printf 'WARNING: no SHA-256 tool available; rules bundle sentinel is unavailable\n' >&2
  fi

  generated_at="$(date -u '+%Y-%m-%dT%H:%M:%SZ')" || {
    rm -f "$body_tmp"
    return 1
  }
  final_tmp="$(mktemp "${out_dir}/.rules-bundle-final.XXXXXX")" || {
    rm -f "$body_tmp"
    return 1
  }
  if ! {
    printf '# Flywheel Lead Rules Bundle (FLY-1402)\n'
    printf 'RULES_BUNDLE_SHA=%s FILES=%s\n' "$sha" "$count"
    printf 'ROLE=%s LEAD_ID=%s PROJECT=%s GENERATED_AT=%s\n' \
      "$role" "$lead_id" "$project" "$generated_at"
    printf 'MANIFEST:\n'
    i=0
    while [ "$i" -lt "$count" ]; do
      path="${RULES_BUNDLE_FILES[$i]}"
      label="${RULES_BUNDLE_LABELS[$i]}"
      basename="${path##*/}"
      printf '  %s. %s/%s — %s\n' "$((i + 1))" "$label" "$basename" "$path"
      i=$((i + 1))
    done
    printf 'PROBE: If asked to read back your rules bundle sentinel, quote the\n'
    printf 'RULES_BUNDLE_SHA line above verbatim (the whole line, exactly).\n\n'
    cat "$body_tmp"
  } >"$final_tmp"; then
    rm -f "$body_tmp" "$final_tmp"
    return 1
  fi
  if ! chmod 0600 "$final_tmp" || ! mv "$final_tmp" "$out_path"; then
    rm -f "$body_tmp" "$final_tmp"
    return 1
  fi
  rm -f "$body_tmp"
  printf '%s\n' "$out_path"
}

# FLY-1402 launcher lifecycle helpers. They intentionally consume caller-owned
# globals (selected arrays, role/mode/path, lease start identity, Lead ids) so
# claude-lead.sh can keep the ownership commit at its real pre-launch seam while
# this source-only library remains independently harnessable.
_rules_bundle_start_hash() {
  local value="$1"
  if command -v shasum >/dev/null 2>&1; then
    printf '%s' "$value" | shasum -a 256 | awk '{print substr($1, 1, 16)}'
  elif command -v sha256sum >/dev/null 2>&1; then
    printf '%s' "$value" | sha256sum | awk '{print substr($1, 1, 16)}'
  else
    printf '%s' "$value" | cksum | awk '{print $1}'
  fi
}

_rules_bundle_random_nonce() {
  od -An -N12 -tx1 /dev/urandom 2>/dev/null | tr -d '[:space:]'
}

_rules_bundle_uncommitted_cleanup() {
  if [ "${_RULES_BUNDLE_COMMITTED:-0}" != "1" ] \
    && [ "${RULES_BUNDLE_MODE:-bundle}" = "bundle" ] \
    && [ -n "${RULES_BUNDLE_PATH:-}" ]; then
    rm -f -- "$RULES_BUNDLE_PATH" 2>/dev/null || true
  fi
}

_rules_bundle_selected_sources_json() {
  local result='[]' i=0 path label basename
  while [ "$i" -lt "${#RULES_BUNDLE_FILES[@]}" ]; do
    path="${RULES_BUNDLE_FILES[$i]}"
    label="${RULES_BUNDLE_LABELS[$i]}"
    basename="${path##*/}"
    result="$(printf '%s' "$result" | jq \
      --arg label "$label" --arg basename "$basename" --arg path "$path" \
      '. + [{label:$label, basename:$basename, path:$path}]')" || return 1
    i=$((i + 1))
  done
  printf '%s\n' "$result"
}

_rules_bundle_append_targets_json() {
  local result='[]' i=0
  if [ "$RULES_BUNDLE_MODE" = "bundle" ]; then
    jq -n --arg path "$RULES_BUNDLE_PATH" '[$path]'
    return
  fi
  while [ "$i" -lt "${#RULES_BUNDLE_FILES[@]}" ]; do
    result="$(printf '%s' "$result" | jq --arg path "${RULES_BUNDLE_FILES[$i]}" \
      '. + [$path]')" || return 1
    i=$((i + 1))
  done
  printf '%s\n' "$result"
}

_rules_bundle_write_receipt() {
  local selected append_targets generated_at tmp bundle_path_json sha_json
  selected="$(_rules_bundle_selected_sources_json)" || return 1
  append_targets="$(_rules_bundle_append_targets_json)" || return 1
  generated_at="$(date -u '+%Y-%m-%dT%H:%M:%SZ')" || return 1
  mkdir -p "$RULES_BUNDLE_STATE_DIR" || return 1
  chmod 0700 "$RULES_BUNDLE_STATE_DIR" || return 1
  tmp="$(mktemp "${RULES_BUNDLE_STATE_DIR}/.active-receipt.XXXXXX")" || return 1
  if [ "$RULES_BUNDLE_MODE" = "bundle" ]; then
    bundle_path_json="$(jq -n --arg value "$RULES_BUNDLE_PATH" '$value')" || {
      rm -f "$tmp"
      return 1
    }
    sha_json="$(jq -n --arg value "$RULES_BUNDLE_SHA" '$value')" || {
      rm -f "$tmp"
      return 1
    }
  else
    bundle_path_json="null"
    sha_json="null"
  fi
  if [ -n "$RULES_BUNDLE_PROCESS_START" ]; then
    if ! jq -n \
      --arg mode "$RULES_BUNDLE_MODE" \
      --argjson bundlePath "$bundle_path_json" \
      --argjson pid "$$" \
      --arg supervisorStart "$RULES_BUNDLE_PROCESS_START" \
      --argjson sha "$sha_json" \
      --arg role "$RULES_BUNDLE_ROLE" \
      --arg generatedAt "$generated_at" \
      --argjson selectedSources "$selected" \
      --argjson appendTargets "$append_targets" \
      --argjson files "${#RULES_BUNDLE_FILES[@]}" \
      '{mode:$mode,bundlePath:$bundlePath,pid:$pid,supervisorStart:$supervisorStart,sha:$sha,role:$role,generatedAt:$generatedAt,selectedSources:$selectedSources,appendTargets:$appendTargets,files:$files}' \
      > "$tmp"; then
      rm -f "$tmp"
      return 1
    fi
  else
    if ! jq -n \
      --arg mode "$RULES_BUNDLE_MODE" \
      --argjson bundlePath "$bundle_path_json" \
      --argjson pid "$$" \
      --argjson supervisorStart null \
      --arg generationNonce "$RULES_BUNDLE_GENERATION_NONCE" \
      --argjson sha "$sha_json" \
      --arg role "$RULES_BUNDLE_ROLE" \
      --arg generatedAt "$generated_at" \
      --argjson selectedSources "$selected" \
      --argjson appendTargets "$append_targets" \
      --argjson files "${#RULES_BUNDLE_FILES[@]}" \
      '{mode:$mode,bundlePath:$bundlePath,pid:$pid,supervisorStart:$supervisorStart,generationNonce:$generationNonce,sha:$sha,role:$role,generatedAt:$generatedAt,selectedSources:$selectedSources,appendTargets:$appendTargets,files:$files}' \
      > "$tmp"; then
      rm -f "$tmp"
      return 1
    fi
  fi
  if ! chmod 0600 "$tmp" || ! mv "$tmp" "$RULES_BUNDLE_RECEIPT_PATH"; then
    rm -f "$tmp"
    return 1
  fi
}

_rules_bundle_cleanup_stale_generations() {
  local candidate name generation pid suffix actual_start actual_hash
  [ "$RULES_BUNDLE_MODE" = "bundle" ] || return 0
  # PROJECT_NAME and LEAD_ID are launcher-owned globals in this sourced library.
  # shellcheck disable=SC2153
  for candidate in "${RULES_BUNDLE_STATE_DIR}/${PROJECT_NAME}-${LEAD_ID}."*.md; do
    [ -f "$candidate" ] && [ ! -L "$candidate" ] || continue
    [ "$candidate" != "$RULES_BUNDLE_PATH" ] || continue
    name="$(basename "$candidate")"
    generation="${name#"${PROJECT_NAME}"-"${LEAD_ID}".}"
    generation="${generation%.md}"
    pid="${generation%%-*}"
    suffix="${generation#*-}"
    case "$pid" in ''|*[!0-9]*) continue ;; esac
    case "$suffix" in
      lstart-*)
        actual_start="$(LC_ALL=C ps -p "$pid" -o lstart= 2>/dev/null || true)"
        if [ -z "$actual_start" ]; then
          rm -f -- "$candidate" 2>/dev/null || true
          continue
        fi
        actual_hash="$(_rules_bundle_start_hash "$actual_start")"
        if [ "$suffix" != "lstart-${actual_hash}" ]; then
          rm -f -- "$candidate" 2>/dev/null || true
        fi
        ;;
      # No lstart proof exists for nonce generations; PID-only deletion is
      # forbidden because it can erase a different launcher after PID reuse.
      nonce-*) ;;
    esac
  done
}

_rules_bundle_legacy_alert() {
  [ -x "${LEAD_ALERT_SH:-}" ] || return 0
  "$LEAD_ALERT_SH" \
    --lead "$LEAD_ID" --project "$PROJECT_NAME" \
    --kind rules_bundle_legacy --severity warning \
    --title "Lead rules bundle legacy mode" \
    --body "${PROJECT_NAME}/${LEAD_ID} launched with FLYWHEEL_LEAD_RULES_BUNDLE=legacy; Claude CLI last-one-wins semantics mean only the final repeated rules file is effective. Remove the compatibility override and restart." \
    || log "WARNING: rules_bundle_legacy alert failed"
}

_rules_bundle_commit_once() {
  [ "$_RULES_BUNDLE_COMMITTED" = "1" ] && return 0
  _rules_bundle_write_receipt || return 1
  if [ "$RULES_BUNDLE_MODE" = "bundle" ]; then
    trap - EXIT
  fi
  _RULES_BUNDLE_COMMITTED=1
  _rules_bundle_cleanup_stale_generations
  if [ "$RULES_BUNDLE_MODE" = "legacy" ]; then
    _rules_bundle_legacy_alert
  fi
}

# compute_lead_rule_bundle <role> <base_rules_dir> <comm_backend> <governance_required>
#   role:                companion | cos | dept
#   base_rules_dir:      absolute path to the shipped lead-rules-base dir
#   comm_backend:        commdb | <other>  (commdb skips runner-messaging-rules,
#                        mirroring claude-lead.sh's FLYWHEEL_COMM_BACKEND guard)
#   governance_required: 1 = founder-only-authority.md is REQUIRED (Codex full-access,
#                        fail-closed); 0 = optional (Claude pre-FLY-175 backward-compat)
# stdout: one absolute rule file path per line, in load order (existing+readable).
# return: 0 ok; 2 unknown role; 10 a REQUIRED file is missing (MISSING_REQUIRED on stderr).
compute_lead_rule_bundle() {
  local role="$1" base="$2" comm_backend="$3" governance_required="${4:-0}"

  case "$role" in
    companion)
      # A companion's ONLY hard behavioral boundary — REQUIRED (claude-lead.sh
      # fail-STOPs without it). It skips the 20KB founder-only-authority + html
      # delivery; its short safety contract covers the boundary.
      _lrb_emit "${base}/companion-safety-contract.md" 1 || return 10
      ;;
    cos)
      _lrb_emit "${base}/cos-lead-rules.md" 0 || return 10
      ;;
    dept)
      _lrb_emit "${base}/department-lead-rules.md" 0 || return 10
      # runner-messaging-rules only on the mailbox path (NOT commdb rollback) —
      # mirrors claude-lead.sh's normalize_comm_backend guard.
      if [ "$comm_backend" != "commdb" ]; then
        _lrb_emit "${base}/runner-messaging-rules.md" 0 || return 10
      fi
      _lrb_emit "${base}/executor-routing.md" 0 || return 10
      # FLY-728: the Lead is the difficulty sorter — judge difficulty at dispatch
      # and pass a model tier on /api/runs/start. Every dispatch-capable Lead
      # (incl. full-access Codex) needs it, so it lives in the shared bundle too.
      _lrb_emit "${base}/model-routing.md" 0 || return 10
      _lrb_emit "${base}/stuck-runner-remanage.md" 0 || return 10
      _lrb_emit "${base}/runner-reengage-rules.md" 0 || return 10
      _lrb_emit "${base}/doc-flow-rules.md" 0 || return 10
      _lrb_emit "${base}/xiaohongshu-memory-rules.md" 0 || return 10
      # FLY-369/FLY-2080: backend-independent patrol. Keep this after the
      # role-specific dept list, matching claude-lead.sh's common block.
      _lrb_emit "${base}/runner-patrol-rules.md" 0 || return 10
      ;;
    *)
      printf 'UNKNOWN_ROLE:%s\n' "$role" >&2
      return 2
      ;;
  esac

  # ── Universal governance (claude-lead.sh:1581-1617) ──
  # Founder-local time is universal for companion + cos + dept. It is a short
  # time-interpretation contract, not an engineering-role rule.
  _lrb_emit "${base}/founder-local-time.md" 0 || return 10
  # founder-only-authority + html-delivery: cos + dept (companion skips both).
  if [ "$role" != "companion" ]; then
    _lrb_emit "${base}/founder-only-authority.md" "$governance_required" || return 10
    _lrb_emit "${base}/founder-html-delivery.md" 0 || return 10
  fi
  # cross-dept channel rules: ALL roles (companion included).
  _lrb_emit "${base}/cross-dept-channel-rules.md" 0 || return 10
  return 0
}

# assemble_full_access_governance <lead_id> <base_rules_dir>
#
# The full-access entry-point helper used by BOTH codex-lead.sh AND the Mufasa
# full-access launcher (which execs the runtime directly, bypassing codex-lead.sh)
# — ONE assembly path so the two cannot drift. Computes the fail-closed governance
# bundle (founder-only-authority REQUIRED) and EXPORTS it onto
# FLYWHEEL_LEAD_SYSTEM_PROMPT_FILES, AFTER any existing persona/identity files
# (persona establishes identity first, rules extend it — claude-lead.sh order).
# return: 0 ok; non-zero = a required governance file is missing (caller fail-STOPs).
assemble_full_access_governance() {
  local lead_id="$1" base_rules_dir="$2"
  # role: a full-access Lead is never a companion (ProjectConfig rejects the mix);
  # cos when LEAD_ID/role says so, else dept (mirrors claude-lead.sh role detection).
  local role="dept"
  if [ "${FLYWHEEL_LEAD_ROLE:-}" = "cos" ] || [ "$lead_id" = "cos-lead" ]; then
    role="cos"
  fi
  # comm backend (lenient parse, mirrors claude-lead.sh normalize_comm_backend):
  # commdb skips runner-messaging-rules; anything else (default) keeps it.
  local comm
  comm="$(printf '%s' "${FLYWHEEL_COMM_BACKEND:-}" | tr -d '[:space:]' | tr '[:upper:]' '[:lower:]')"
  local bundle
  if ! bundle="$(compute_lead_rule_bundle "$role" "$base_rules_dir" "$comm" 1)"; then
    return 1
  fi
  local csv
  csv="$(printf '%s' "$bundle" | tr '\n' ',' | sed 's/,$//')"
  [ -z "$csv" ] && return 0
  if [ -n "${FLYWHEEL_LEAD_SYSTEM_PROMPT_FILES:-}" ]; then
    export FLYWHEEL_LEAD_SYSTEM_PROMPT_FILES="${FLYWHEEL_LEAD_SYSTEM_PROMPT_FILES},${csv}"
  else
    export FLYWHEEL_LEAD_SYSTEM_PROMPT_FILES="${csv}"
  fi
  # expose the assembled role + bundle for the caller's log line (read by
  # codex-lead.sh + the full-access launcher in the SAME shell after sourcing).
  # shellcheck disable=SC2034  # consumed cross-file by the sourcing caller
  FLY350_FULL_ACCESS_ROLE="$role"
  # shellcheck disable=SC2034  # consumed cross-file by the sourcing caller
  FLY350_FULL_ACCESS_BUNDLE="$csv"
  return 0
}
