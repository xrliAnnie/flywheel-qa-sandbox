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
# Pure: no side effects beyond stdout (the ordered paths) / stderr (diagnostics).

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
      # FLY-369: status-relay + proactive patrol — backend-independent (loads on
      # both mailbox and commdb), unlike runner-messaging-rules above.
      _lrb_emit "${base}/runner-patrol-rules.md" 0 || return 10
      _lrb_emit "${base}/doc-flow-rules.md" 0 || return 10
      # FLY-579: auto-QA pipeline contract — code-review → independent QA →
      # founder-gate, encoded so no Lead has to remember to run QA.
      _lrb_emit "${base}/auto-qa-pipeline.md" 0 || return 10
      _lrb_emit "${base}/xiaohongshu-memory-rules.md" 0 || return 10
      ;;
    *)
      printf 'UNKNOWN_ROLE:%s\n' "$role" >&2
      return 2
      ;;
  esac

  # ── Universal governance (claude-lead.sh:1581-1617) ──
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
