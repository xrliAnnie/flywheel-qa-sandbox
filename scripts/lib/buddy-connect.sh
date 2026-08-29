#!/usr/bin/env bash
# FLY-1023 M4: JIT business-system connection (PRD step 6 / spec §3).
#
# buddy_connect_jit <state-dir> <proposal-json>
#   proposal.systems_needed → the MINIMAL set, connected ONE AT A TIME:
#   wording → connector_connect (hidden input happens inside this process on
#   the TTY) → probe → on success record connected_systems + PREFETCH a
#   non-sensitive summary cache (the ≤60s first-output budget: the Captain
#   assembles from cache + one model pass instead of N live pulls).
#   Unsupported systems take the HONEST path: recorded under
#   requested_systems, never faked. Two failures on one system → offer to
#   skip (the Buddy shell's escalation ladder owns the harder cases).
#
# Connector contract (scripts/lib/buddy-connectors/<id>.sh):
#   connector_id / connector_connect / connector_probe / connector_pull —
#   one JSON line on stdout, 0 ok / 1 fail / 3 needs-guidance. Modules use
#   the base wizard's fs_ask_secret/fs_env_get/fs_env_upsert (sourced seam),
#   so secrets live ONLY in the hidden TTY read → 0600 .env pipeline.
#
# Demo channel: FLYWHEEL_BUDDY_DEMO=1 short-circuits connect/probe/pull with
# committed fixtures — QA/demo ONLY; the production north star never counts
# a demo cache as success (PRD Codex R2#4), and the cache is marked demo.

_BC_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
_BC_CONNECTOR_DIR="${FLYWHEEL_BUDDY_CONNECTOR_DIR:-$_BC_SCRIPT_DIR/buddy-connectors}"
_BC_FIXTURE_DIR="$_BC_SCRIPT_DIR/../buddy/fixtures"

# map a proposal system name → connector module id ("" = unsupported)
_bc_module_for() {
  case "$1" in
    shopify) printf 'shopify' ;;
    veeqo) printf 'veeqo' ;;
    ordoro) printf 'ordoro' ;;
    email|imap|gmail) printf 'imap' ;;
    *) printf '' ;;
  esac
}

_bc_refuse_secret_injection() {
  [ "${FLYWHEEL_BUDDY_ALLOW_ANSWER_INJECTION:-0}" = "1" ] && return 0
  env | grep -qE '^FLYWHEEL_SETUP_ANSWER_[A-Z0-9_]*(TOKEN|API_KEY|SECRET|PASSWORD|PASSWD)[A-Z0-9_]*=' && {
    fb_say "等等 —— 检测到密钥类的自动注入,这在正式使用里是关着的,咱们走安全输入。"
    return 1
  }
  return 0
}

# _bc_cache_write <state-dir> <sys> <json> — 0600 prefetch cache. The cache
# holds ONLY what connector_pull already reduced to non-sensitive summaries;
# a secret-looking payload is refused outright (belt over braces).
_bc_cache_write() {
  local state_dir="$1" sys="$2" json="$3"
  local dir="$state_dir/buddy-cache"
  mkdir -p "$dir" 2>/dev/null; chmod go-w "$dir" 2>/dev/null || true
  if ! scan_string_for_secrets "$json" >/dev/null 2>&1; then
    echo "[buddy-connect] refusing to cache a secret-looking payload for $sys" >&2
    return 1
  fi
  ( umask 077; printf '%s\n' "$json" > "$dir/$sys.json" )
}

# _bc_run <module> <fn> — run one connector function in a subshell with the
# setup seam loaded (state dir inherited). stdout = the connector's JSON.
_bc_run() {
  local module="$1" fn="$2" state_dir="$3"
  (
    export FLYWHEEL_SETUP_SOURCED=1
    export FLYWHEEL_SETUP_STATE_DIR="$state_dir"
    # shellcheck disable=SC1090
    source "$_BC_SCRIPT_DIR/../flywheel-setup.sh" || exit 97
    # shellcheck disable=SC1090
    source "$_BC_CONNECTOR_DIR/$module.sh" || exit 97
    "$fn"
  )
}

# _bc_connect_one <state-dir> <sys> <module> — connect+probe+prefetch. The
# CALLER (Buddy shell) already printed the per-system wording.
_bc_connect_one() {
  local state_dir="$1" sys="$2" module="$3"
  if [ "${FLYWHEEL_BUDDY_DEMO:-0}" = "1" ] && [ -f "$_BC_FIXTURE_DIR/$module.json" ]; then
    fb_say "(演示模式:用样例数据接「${sys}」,不算真接入)"
    _bc_cache_write "$state_dir" "$sys" "$(jq -c '. + {demo:true}' "$_BC_FIXTURE_DIR/$module.json")"
    return 0
  fi
  local fails=0 out rc
  while [ "$fails" -lt 2 ]; do
    out="$(_bc_run "$module" connector_connect "$state_dir" 2>>"$state_dir/buddy-steps.log")"
    rc=$?
    if [ "$rc" -eq 0 ]; then
      if out="$(_bc_run "$module" connector_probe "$state_dir" 2>>"$state_dir/buddy-steps.log")"; then
        fb_say "✓ 「${sys}」接好了,当场试了一下,能读到。"
        # prefetch — a failed prefetch is not a failed connection.
        local pulled
        if pulled="$(_bc_run "$module" connector_pull "$state_dir" 2>>"$state_dir/buddy-steps.log")"; then
          _bc_cache_write "$state_dir" "$sys" "$pulled" || true
        fi
        return 0
      fi
    fi
    fails=$((fails+1))
    local hint
    hint="$(jq -r '.hint // empty' <<<"$out" 2>/dev/null)"
    fb_say "「${sys}」这次没接上${hint:+ —— $hint}"
    if [ "$fails" -lt 2 ]; then
      fb_ask "(回车再试一次,输入「跳过」先放一放)"
      case "$FB_INPUT" in 跳过|skip) return 2 ;; esac
    fi
  done
  fb_say "「${sys}」先放一放 —— 我记下来了,不影响其它的接着走。"
  return 1
}

# buddy_connect_jit <state-dir> <proposal-json>
buddy_connect_jit() {
  local state_dir="$1" proposal="$2"
  _bc_refuse_secret_injection || return 1
  local -a needed=()
  while IFS= read -r s; do [ -n "$s" ] && needed+=("$s"); done \
    < <(jq -r '.systems_needed[]?' <<<"$proposal" 2>/dev/null)
  if [ "${#needed[@]}" -eq 0 ]; then
    fb_say "这件事不用接别的东西,直接往下走。"
    return 0
  fi
  local sys module connected='[]' requested='[]'
  for sys in "${needed[@]}"; do
    module="$(_bc_module_for "$sys")"
    if [ -z "$module" ]; then
      fb_say "「${sys}」我这儿还没有现成的接法 —— 先记下让工程同学看能不能加,咱先用能接的做。"
      requested="$(jq -c --arg s "$sys" '. + [$s]' <<<"$requested")"
      continue
    fi
    fb_gap
    fb_copy "step6-connect-$module" 2>/dev/null || fb_say "来接「${sys}」——我一步步带你。"
    if _bc_connect_one "$state_dir" "$sys" "$module"; then
      connected="$(jq -c --arg s "$sys" '. + [$s]' <<<"$connected")"
    fi
  done
  [ "$connected" != "[]" ] && fb_state_set connected_systems "$connected"
  [ "$requested" != "[]" ] && fb_state_set requested_systems "$requested"
  fb_gap
  fb_say "要接的都处理完了,咱继续。"
  return 0
}

# buddy_install_first_output_skill <state-dir> <project> — put the Captain's
# first-output skill into the project workspace (project-level skill dir the
# Lead session reads). Idempotent overwrite of OUR file only.
buddy_install_first_output_skill() {
  local state_dir="$1" project="$2"
  local pj="$state_dir/projects.json" root tpl
  tpl="$_BC_SCRIPT_DIR/../buddy/first-output-skill.md"
  [ -f "$tpl" ] || return 1
  [ -f "$pj" ] || return 1
  root="$(jq -r --arg p "$project" '.[] | select(.projectName == $p) | .projectRoot // empty' "$pj" 2>/dev/null | head -1)"
  [ -n "$root" ] && [ -d "$root" ] || return 1
  mkdir -p "$root/.claude/skills/first-output"
  cp "$tpl" "$root/.claude/skills/first-output/SKILL.md"
}
