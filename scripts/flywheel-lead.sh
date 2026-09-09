#!/bin/bash
# FLY-2444: installable, repository-neutral Claude/Codex Lead launcher.
set -euo pipefail

# launchd supplies only the system PATH. The carrier owns the user and
# Homebrew toolchain prefixes so repository-neutral Codex Leads can resolve
# node, jq, and tmux after boot just as they do in an interactive preflight.
export PATH="${HOME}/.local/bin:${HOME}/.npm-global/bin:/opt/homebrew/bin:/usr/local/bin:${PATH:-/usr/bin:/bin:/usr/sbin:/sbin}"

log() { printf '[flywheel-lead] %s\n' "$*"; }
fail() {
  local message="$1" code="${2:-78}"
  printf '[flywheel-lead] ERROR: %s\n' "$message" >&2
  return "$code"
}

usage() {
  cat <<'EOF'
Usage:
  flywheel-lead.sh register <lead-registry add options>
  flywheel-lead.sh run <manifest>
  flywheel-lead.sh run --project <project> --lead <lead-id>
  flywheel-lead.sh preflight <manifest>
  flywheel-lead.sh recover
  flywheel-lead.sh install --project <project> --lead <lead-id>
  flywheel-lead.sh stop --project <project> --lead <lead-id>
  flywheel-lead.sh verify [--stage registered|installed|live] <manifest>

Passing one existing manifest as the only argument is equivalent to `run`.
EOF
}

_tool_path() {
  local installed="${FLYWHEEL_STATE_DIR}/bin/$1" source="${FLYWHEEL_DIR}/scripts/$1"
  if [ -f "$installed" ] && [ ! -L "$installed" ]; then
    printf '%s\n' "$installed"
  else
    printf '%s\n' "$source"
  fi
}

load_common() {
  local mode="${1:-strict}"
  local initial_state="${FLYWHEEL_STATE_DIR:-${HOME}/.flywheel}"
  local host_lib="${initial_state}/bin/lib/host-config.sh"
  if [ ! -f "$host_lib" ]; then
    host_lib="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/host-config.sh"
  fi
  if [ ! -f "$host_lib" ] && [ -n "${FLYWHEEL_DIR:-}" ]; then
    host_lib="${FLYWHEEL_DIR}/scripts/lib/host-config.sh"
  fi
  [ -f "$host_lib" ] || { fail "host-config.sh is missing" 78; return $?; }
  # shellcheck source=lib/host-config.sh
  # shellcheck disable=SC1091
  source "$host_lib"
  host_config_load >/dev/null || { fail "host.json is invalid" 78; return $?; }

  if [ "$FLYWHEEL_STATE_DIR" != "${HOME}/.flywheel" ]; then
    fail "this launcher requires FLYWHEEL_STATE_DIR=${HOME}/.flywheel (got ${FLYWHEEL_STATE_DIR})" 78
    return $?
  fi

  FLYWHEEL_COMM_CLI="${FLYWHEEL_COMM_CLI:-${FLYWHEEL_DIR}/packages/flywheel-comm/dist/index.js}"
  FLYWHEEL_TEAMLEAD_ROOT="${FLYWHEEL_TEAMLEAD_ROOT:-${FLYWHEEL_DIR}/packages/teamlead}"
  FLYWHEEL_TEAMLEAD_PROJECTS_VALIDATOR="${FLYWHEEL_TEAMLEAD_PROJECTS_VALIDATOR:-${FLYWHEEL_TEAMLEAD_ROOT}/dist/bin/validate-projects.js}"
  FLYWHEEL_BIN_DIR="${FLYWHEEL_STATE_DIR}/bin"
  PROJECTS_FILE="${HOME}/.flywheel/projects.json"
  RECEIPT_FILE="${HOME}/.flywheel/state/summary-registry/migration-receipt.json"
  INTENT_FILE="${RECEIPT_FILE}.lead-registry-intent.json"
  MANIFEST_DIR="${HOME}/.flywheel/manifests"
  ENV_FILE="${HOME}/.flywheel/.env"
  export FLYWHEEL_COMM_CLI FLYWHEEL_TEAMLEAD_PROJECTS_VALIDATOR

  local host_gate_lib="${FLYWHEEL_BIN_DIR}/lib/lead-host-tmux-gate.sh"
  [ -f "$host_gate_lib" ] || host_gate_lib="${FLYWHEEL_DIR}/scripts/lib/lead-host-tmux-gate.sh"
  [ -f "$host_gate_lib" ] || { fail "Lead host gate helper is missing: $host_gate_lib" 78; return $?; }
  # shellcheck source=lib/lead-host-tmux-gate.sh
  # shellcheck disable=SC1091
  source "$host_gate_lib"
  lead_host_tmux_gate_resolve || return 78
  [ "${HOST_TMUX_GATE_BIN##*/}" = "host-tmux-selection-gate.sh" ] \
    || { fail "resolved host gate is not host-tmux-selection-gate.sh: $HOST_TMUX_GATE_BIN" 78; return $?; }

  [ "$mode" = "paths-only" ] && return 0

  command -v jq >/dev/null 2>&1 || { fail "jq is required" 78; return $?; }
  command -v node >/dev/null 2>&1 || { fail "node is required" 78; return $?; }
  command -v tmux >/dev/null 2>&1 || { fail "tmux is required" 78; return $?; }
  [ -f "$FLYWHEEL_COMM_CLI" ] || { fail "flywheel-comm CLI is missing: $FLYWHEEL_COMM_CLI" 78; return $?; }
  [ -f "$FLYWHEEL_TEAMLEAD_PROJECTS_VALIDATOR" ] || { fail "TeamLead projects validator is missing: $FLYWHEEL_TEAMLEAD_PROJECTS_VALIDATOR" 78; return $?; }
  [ -x "$HOST_TMUX_GATE_BIN" ] || { fail "host tmux selection gate is missing: $HOST_TMUX_GATE_BIN" 78; return $?; }
}

read_manifest_identity() {
  local manifest="$1"
  if [ ! -f "$manifest" ] || [ -L "$manifest" ]; then
    fail "manifest must be a regular non-symlink file: $manifest" 78
    return $?
  fi
  RUN_PROJECT="$(jq -er '.projectName | select(type == "string" and length > 0)' "$manifest" 2>/dev/null || true)"
  RUN_LEAD="$(jq -er '.leadId | select(type == "string" and length > 0)' "$manifest" 2>/dev/null || true)"
  RUN_BACKEND="$(jq -er '.leadBackend.backendId // "claude-code"' "$manifest" 2>/dev/null || true)"
  [ -n "$RUN_PROJECT" ] && [ -n "$RUN_LEAD" ] || { fail "manifest is missing projectName or leadId" 78; return $?; }
  case "$RUN_BACKEND" in
    claude-code|codex-app-server) ;;
    *) fail "unsupported Lead backend in manifest: ${RUN_BACKEND:-<empty>}" 78; return $? ;;
  esac
}

source_runtime_env() {
  [ -f "$ENV_FILE" ] && [ ! -L "$ENV_FILE" ] || { fail "environment file is missing or unsafe: $ENV_FILE" 78; return $?; }
  local saved_home="$HOME" saved_dir="$FLYWHEEL_DIR" saved_state="$FLYWHEEL_STATE_DIR"
  local saved_cli="$FLYWHEEL_COMM_CLI" saved_validator="$FLYWHEEL_TEAMLEAD_PROJECTS_VALIDATOR"
  local saved_teamlead="$FLYWHEEL_TEAMLEAD_ROOT" saved_bin="$FLYWHEEL_BIN_DIR" saved_path="$PATH"
  local allexport_was_on=0 source_rc=0
  [[ "$-" == *a* ]] && allexport_was_on=1
  set -a
  # shellcheck source=/dev/null
  source "$ENV_FILE" || source_rc=$?
  [ "$allexport_was_on" -eq 1 ] || set +a
  HOME="$saved_home"
  FLYWHEEL_DIR="$saved_dir"
  FLYWHEEL_STATE_DIR="$saved_state"
  FLYWHEEL_COMM_CLI="$saved_cli"
  FLYWHEEL_TEAMLEAD_PROJECTS_VALIDATOR="$saved_validator"
  FLYWHEEL_TEAMLEAD_ROOT="$saved_teamlead"
  FLYWHEEL_BIN_DIR="$saved_bin"
  PATH="$saved_path"
  export HOME PATH FLYWHEEL_DIR FLYWHEEL_STATE_DIR FLYWHEEL_COMM_CLI \
    FLYWHEEL_TEAMLEAD_PROJECTS_VALIDATOR FLYWHEEL_TEAMLEAD_ROOT FLYWHEEL_BIN_DIR
  lead_host_tmux_gate_resolve || return 78
  if [ "$source_rc" -ne 0 ]; then
    fail "environment file could not be sourced: $ENV_FILE" 78
    return $?
  fi
}

sanitize_codex_child_env() {
  if [ -n "${FLYWHEEL_LEAD_CROSS_DEPT_CHANNEL_IDS:-}" ]; then
    log "ignoring FLYWHEEL_LEAD_CROSS_DEPT_CHANNEL_IDS until the Bridge outbound contract permits it"
  fi
  unset FLYWHEEL_LEAD_CROSS_DEPT_CHANNEL_IDS \
    FLYWHEEL_ROUNDTABLE_REPLY_IN_THREAD FLYWHEEL_ROUNDTABLE_CHANNEL_ID \
    FLYWHEEL_ROUNDTABLE_ENABLED FLYWHEEL_ROUNDTABLE_GUILD_ID \
    FLYWHEEL_LEAD_CORE_CHANNEL_ID FLYWHEEL_LEAD_MENTION_PATTERNS
}

compose_codex_child_env() {
  local selector="$1" project_root="$2" address_lib

  address_lib="${FLYWHEEL_BIN_DIR}/lib/lead-address.sh"
  [ -f "$address_lib" ] || address_lib="${FLYWHEEL_DIR}/scripts/lib/lead-address.sh"
  [ -f "$address_lib" ] || { fail "Lead address helper is missing: $address_lib" 78; return $?; }
  # shellcheck source=lib/lead-address.sh
  # shellcheck disable=SC1091
  source "$address_lib"

  export FLYWHEEL_PROJECTS_FILE="$PROJECTS_FILE"
  export FLYWHEEL_LEAD_EXPECTED_PROJECTS_DIGEST
  FLYWHEEL_LEAD_EXPECTED_PROJECTS_DIGEST="$(jq -er '.projectsDigest' <<<"$selector")"
  export FLYWHEEL_CODEX_LEAD_MODE=tui
  export FLYWHEEL_CODEX_LEAD_PROFILE=full-access
  export FLYWHEEL_CODEX_LEAD_SANDBOX=workspace-write
  export FLYWHEEL_LEAD_CHAT_CHANNEL_ID
  FLYWHEEL_LEAD_CHAT_CHANNEL_ID="$(jq -er '.chatChannel' <<<"$selector")"
  export FLYWHEEL_CODEX_LEAD_PROJECT_DIR="$project_root"
  export FLYWHEEL_CODEX_TUI_CWD="$project_root"
  export FLYWHEEL_CODEX_LEAD_HOME_KEY="$RUN_LEAD"
  CODEX_HOME="$(derive_codex_lead_home "$FLYWHEEL_CODEX_LEAD_HOME_KEY")" || return $?
  export CODEX_HOME
  export FLYWHEEL_CODEX_BIN="${CODEX_HOME}/packages/standalone/current/codex"
  export FLYWHEEL_COMM_DB="${HOME}/.flywheel/comm/${RUN_PROJECT}/comm.db"
  export FLYWHEEL_LEAD_ACTIONS_MAIN_JS="${FLYWHEEL_TEAMLEAD_ROOT}/dist/lead-backends/codex/lead-actions/lead-actions-main.js"
  export FLYWHEEL_LEAD_ACTIONS_NODE_BIN
  FLYWHEEL_LEAD_ACTIONS_NODE_BIN="$(command -v node)"
  unset FLYWHEEL_LEAD_ACTIONS_STATE_DIR FLYWHEEL_CODEX_LEAD_STATE_DIR
  export FLYWHEEL_LEAD_SYSTEM_PROMPT_FILES="${project_root}/.lead/${RUN_LEAD}/identity.md"
  export FLYWHEEL_ROOT="$FLYWHEEL_DIR"
  export FLYWHEEL_TEAMLEAD_ROOT
  export FLYWHEEL_CODEX_LEAD_OUTBOUND=bridge
  export FLYWHEEL_BRIDGE_URL="${FLYWHEEL_BRIDGE_URL:-${BRIDGE_URL:-http://localhost:9876}}"
  FLYWHEEL_API_TOKEN="${FLYWHEEL_API_TOKEN:-${TEAMLEAD_API_TOKEN:-}}"
  [ -n "$FLYWHEEL_API_TOKEN" ] \
    || { fail "FLYWHEEL_API_TOKEN or TEAMLEAD_API_TOKEN is required" 78; return $?; }
  export FLYWHEEL_API_TOKEN

  # The backend resolver is the sole identity owner. A caller may itself be a
  # resident Lead/Runner, so inherited identity must never become a second
  # authority for the selected target.
  unset FLYWHEEL_LEAD_ID LEAD_ID FLYWHEEL_PROJECT_NAME PROJECT_NAME \
    FLYWHEEL_LEAD_KEY FLYWHEEL_LEAD_BACKEND FLYWHEEL_LEAD_MODEL \
    FLYWHEEL_LEAD_EFFORT FLYWHEEL_LEAD_MODEL_CONTEXT_WINDOW \
    FLYWHEEL_LEAD_ROLE FLYWHEEL_LEAD_SUMMARY_ROLE \
    FLYWHEEL_LEAD_HAS_SUMMARY_DUTY FLYWHEEL_SUMMARY_GRANULARITY \
    FLYWHEEL_SUMMARY_ASSIGNMENT_DIGEST DISCORD_STATE_DIR \
    DISCORD_EXPECTED_BOT_USER_ID DISCORD_IDENTITY_MODE \
    FLYWHEEL_LEAD_IDENTITY_DIGEST FLYWHEEL_CANONICAL_IDENTITY_RESOLVED \
    DISCORD_BOT_TOKEN

  CODEX_LAUNCHER="${FLYWHEEL_TEAMLEAD_ROOT}/scripts/codex-lead.sh"
  [ -x "$CODEX_LAUNCHER" ] \
    || { fail "Codex Lead backend launcher is missing: $CODEX_LAUNCHER" 78; return $?; }
}

run_manifest() {
  local manifest="$1" selector wrapper token_env project_root target_sha gate_rc
  load_common || return $?
  require_registry_intent_clear || return $?
  read_manifest_identity "$manifest" || return $?
  if [ "$RUN_BACKEND" = "codex-app-server" ]; then
    source_runtime_env || return $?
  fi
  selector="$(selector_for "$RUN_PROJECT" "$RUN_LEAD")" || return $?
  validate_manifest_binding "$manifest" "$RUN_PROJECT" "$RUN_LEAD" "$selector" || return $?

  if [ "$RUN_BACKEND" = "claude-code" ]; then
    wrapper="${FLYWHEEL_BIN_DIR}/flywheel-lead-wrapper-v2.sh"
    [ -x "$wrapper" ] && [ ! -L "$wrapper" ] || { fail "installed Claude wrapper-v2 is missing: $wrapper" 78; return $?; }
    exec /bin/bash "$wrapper" "$manifest"
  fi

  [ "$(jq -r '.codexProfile // ""' <<<"$selector")" = "full-access" ] \
    || { fail "Codex launcher supports only codexProfile=full-access" 78; return $?; }
  token_env="$(jq -er '.botTokenEnv | select(test("^[A-Za-z_][A-Za-z0-9_]*$"))' <<<"$selector")" \
    || { fail "Codex selector has an invalid botTokenEnv" 78; return $?; }
  [ -n "${!token_env:-}" ] || { fail "$token_env is unset or empty" 78; return $?; }

  sanitize_codex_child_env

  target_sha="$(lead_host_tmux_target_sha)"
  export FLYWHEEL_HOST_TMUX_TARGET_SHA="$target_sha"
  export FLYWHEEL_HOST_TMUX_BOUND_TRANSACTION="keepalive:codex-generic:${RUN_PROJECT}-${RUN_LEAD}"
  export FLYWHEEL_HOST_TMUX_MOUNT_POINT="scripts/flywheel-lead.sh"
  gate_rc=0
  "$HOST_TMUX_GATE_BIN" gate codex-generic || gate_rc=$?
  if [ "$gate_rc" -eq 0 ]; then
    "$HOST_TMUX_GATE_BIN" verify codex-generic || gate_rc=$?
  fi
  if [ "$gate_rc" -ne 0 ]; then
    fail "host tmux selection gate refused codex-generic (exit $gate_rc)" 78
    return $?
  fi

  project_root="$(resolved_project_dir "$(jq -er '.projectRoot' <<<"$selector")")"
  project_root="$(cd "$project_root" 2>/dev/null && pwd -P)" \
    || { fail "project root is missing or unreadable" 78; return $?; }
  compose_codex_child_env "$selector" "$project_root" || return $?
  exec /bin/bash "$CODEX_LAUNCHER" "$RUN_LEAD" "$project_root" "$RUN_PROJECT"
}

run_lead() {
  local manifest=""
  if [ "$#" -eq 1 ]; then
    manifest="$1"
  elif [ "$#" -eq 4 ]; then
    local project lead
    project="$(option_value --project "$@" || true)"
    lead="$(option_value --lead "$@" || true)"
    [ -n "$project" ] && [ -n "$lead" ] || { fail "run requires a manifest or --project P --lead L" 64; return $?; }
    load_common || return $?
    manifest="${MANIFEST_DIR}/${project}-${lead}.json"
  else
    fail "run requires a manifest or --project P --lead L" 64
    return $?
  fi
  run_manifest "$manifest"
}

PREFLIGHT_FAILURES=0
preflight_pass() { printf 'PASS %s\n' "$1"; }
preflight_fail() {
  PREFLIGHT_FAILURES=$((PREFLIGHT_FAILURES + 1))
  printf 'FAIL %s\n' "$1" >&2
}

preflight_executable() {
  if [ -x "$1" ] && [ ! -L "$1" ]; then
    preflight_pass "$2"
  else
    preflight_fail "$2 missing or unsafe: $1"
  fi
}

preflight_manifest() {
  local manifest="$1" selector token_env project_root identity_file
  local check_plugin update_plugin installed_wrapper source_wrapper
  local address_lib codex_home codex_bin codex_launcher state_dir link_truth
  local actions_main tui_runtime root_preflight target_sha probe_rc probe_output
  local activation_rc activation_output runtime_rc runtime_output
  PREFLIGHT_FAILURES=0
  load_common paths-only || return $?
  if command -v jq >/dev/null 2>&1; then preflight_pass "jq"; else preflight_fail "jq executable is missing"; fi
  if command -v node >/dev/null 2>&1; then preflight_pass "node"; else preflight_fail "node executable is missing"; fi
  if command -v tmux >/dev/null 2>&1; then preflight_pass "tmux"; else preflight_fail "tmux executable is missing"; fi
  if [ -f "$FLYWHEEL_COMM_CLI" ] && [ ! -L "$FLYWHEEL_COMM_CLI" ]; then
    preflight_pass "flywheel-comm CLI"
  else
    preflight_fail "flywheel-comm CLI missing or unsafe: $FLYWHEEL_COMM_CLI"
  fi
  if [ -f "$FLYWHEEL_TEAMLEAD_PROJECTS_VALIDATOR" ] && [ ! -L "$FLYWHEEL_TEAMLEAD_PROJECTS_VALIDATOR" ]; then
    preflight_pass "TeamLead projects validator"
  else
    preflight_fail "TeamLead projects validator missing or unsafe: $FLYWHEEL_TEAMLEAD_PROJECTS_VALIDATOR"
  fi
  if [ -x "$HOST_TMUX_GATE_BIN" ] && [ ! -L "$HOST_TMUX_GATE_BIN" ]; then
    preflight_pass "host tmux gate"
  else
    preflight_fail "host tmux gate missing or unsafe: $HOST_TMUX_GATE_BIN"
  fi
  if ! command -v jq >/dev/null 2>&1 || ! command -v node >/dev/null 2>&1 \
    || [ ! -f "$FLYWHEEL_COMM_CLI" ]; then
    printf '[flywheel-lead] ERROR: preflight failed with %s finding(s)\n' "$PREFLIGHT_FAILURES" >&2
    return 78
  fi
  read_manifest_identity "$manifest" || return $?
  if [ -f "$ENV_FILE" ] && [ ! -L "$ENV_FILE" ]; then
    if ! source_runtime_env; then
      preflight_fail ".env could not be loaded safely: $ENV_FILE"
    else
      preflight_pass ".env"
    fi
  else
    preflight_fail ".env missing or unsafe: $ENV_FILE"
  fi
  selector="$(selector_for "$RUN_PROJECT" "$RUN_LEAD")" || return $?
  validate_manifest_binding "$manifest" "$RUN_PROJECT" "$RUN_LEAD" "$selector" || return $?
  preflight_pass "manifest binding"

  activation_rc=0
  activation_output="$(node "$FLYWHEEL_COMM_CLI" summary-registry verify-activation \
    --projects-file "$PROJECTS_FILE" --receipt-file "$RECEIPT_FILE" 2>&1)" || activation_rc=$?
  if [ "$activation_rc" -eq 0 ]; then
    preflight_pass "summary registry activation"
  else
    preflight_fail "summary registry activation failed: $activation_output"
  fi

  if [ -L "$INTENT_FILE" ]; then
    preflight_fail "recovery intent is a symlink: $INTENT_FILE"
  elif [ -e "$INTENT_FILE" ]; then
    if [ -f "$INTENT_FILE" ] && [ "$(jq -r '.phase // "invalid"' "$INTENT_FILE" 2>/dev/null)" = "done" ]; then
      preflight_pass "registry recovery intent done"
    else
      preflight_fail "registry recovery is required: $INTENT_FILE"
    fi
  else
    preflight_pass "registry recovery intent clear"
  fi

  token_env="$(jq -er '.botTokenEnv | select(test("^[A-Za-z_][A-Za-z0-9_]*$"))' <<<"$selector" 2>/dev/null || true)"
  if [ -n "$token_env" ] && [ -n "${!token_env:-}" ]; then
    preflight_pass "bot token selector"
  else
    preflight_fail "${token_env:-bot token env} is unset or invalid"
  fi

  project_root="$(resolved_project_dir "$(jq -er '.projectRoot' <<<"$selector")")"
  identity_file="${project_root}/.lead/${RUN_LEAD}/identity.md"
  if [ -r "$identity_file" ] && [ ! -L "$identity_file" ]; then
    preflight_pass "identity.md"
  else
    preflight_fail "identity.md missing or unsafe: $identity_file"
  fi
  if [ "$RUN_BACKEND" = "claude-code" ]; then
    if command -v claude >/dev/null 2>&1; then
      preflight_pass "Claude CLI"
    else
      preflight_fail "claude executable is missing"
    fi
    check_plugin="${FLYWHEEL_BIN_DIR}/check-discord-plugin.sh"
    update_plugin="${FLYWHEEL_BIN_DIR}/update-discord-plugin.sh"
    if [ -x "$check_plugin" ] && [ ! -L "$check_plugin" ]; then
      if [ "$("$check_plugin" --print-contract 2>/dev/null || true)" = "discord@flywheel-plugins/v1" ]; then
        preflight_pass "Claude Discord checker contract"
      else
        preflight_fail "check-discord-plugin.sh contract mismatch"
      fi
      if "$check_plugin" >/dev/null 2>&1; then
        preflight_pass "Claude Discord plugin"
      else
        preflight_fail "check-discord-plugin.sh verification failed"
      fi
    else
      preflight_fail "check-discord-plugin.sh missing or unsafe: $check_plugin; from a Flywheel source checkout run: bash scripts/install-discord-plugin-ops.sh"
    fi
    if [ -x "$update_plugin" ] && [ ! -L "$update_plugin" ]; then
      preflight_pass "update-discord-plugin.sh"
    else
      preflight_fail "update-discord-plugin.sh missing or unsafe: $update_plugin; from a Flywheel source checkout run: bash scripts/install-discord-plugin-ops.sh"
    fi
    installed_wrapper="${FLYWHEEL_BIN_DIR}/flywheel-lead-wrapper-v2.sh"
    source_wrapper="${FLYWHEEL_DIR}/scripts/flywheel-lead-wrapper-v2.sh"
    if [ -x "$installed_wrapper" ] && [ ! -L "$installed_wrapper" ] \
      && [ -f "$source_wrapper" ] && cmp -s "$installed_wrapper" "$source_wrapper"; then
      preflight_pass "Claude wrapper-v2 deployed bytes"
    else
      preflight_fail "installed flywheel-lead-wrapper-v2.sh differs from $source_wrapper"
    fi
  else
    if [ "$(jq -r '.codexProfile // ""' <<<"$selector")" = "full-access" ]; then
      preflight_pass "Codex full-access profile"
    else
      preflight_fail "Codex profile must be full-access"
    fi
    address_lib="${FLYWHEEL_BIN_DIR}/lib/lead-address.sh"
    [ -f "$address_lib" ] || address_lib="${FLYWHEEL_DIR}/scripts/lib/lead-address.sh"
    if [ -f "$address_lib" ]; then
      # shellcheck source=lib/lead-address.sh
      # shellcheck disable=SC1091
      source "$address_lib"
      codex_home="$(derive_codex_lead_home "$RUN_LEAD" 2>/dev/null || true)"
    else
      codex_home=""
      preflight_fail "Lead address helper is missing: $address_lib"
    fi
    codex_bin="${codex_home}/packages/standalone/current/codex"
    if [ -n "$codex_home" ] && [ -d "$codex_home" ] && [ ! -L "$codex_home" ]; then
      preflight_pass "Codex home"
    else
      preflight_fail "Codex home missing or unsafe: ${codex_home:-<unresolved>}"
    fi
    preflight_executable "$codex_bin" "standalone Codex"
    if [ -f "${codex_home}/auth.json" ] && [ ! -L "${codex_home}/auth.json" ]; then
      preflight_pass "Codex auth.json"
    else
      preflight_fail "Codex auth.json missing or unsafe: ${codex_home}/auth.json"
    fi
    link_truth="${FLYWHEEL_BIN_DIR}/codex-home-link-truth.sh"
    [ -x "$link_truth" ] || link_truth="${FLYWHEEL_DIR}/scripts/codex-home-link-truth.sh"
    if [ -x "$link_truth" ] && [ ! -L "$link_truth" ] \
      && "$link_truth" --lead "${RUN_PROJECT}/${RUN_LEAD}" "$codex_home" >/dev/null 2>&1; then
      preflight_pass "Codex home link truth"
    else
      preflight_fail "codex-home-link-truth.sh verification failed"
    fi
    actions_main="${FLYWHEEL_TEAMLEAD_ROOT}/dist/lead-backends/codex/lead-actions/lead-actions-main.js"
    tui_runtime="${FLYWHEEL_TEAMLEAD_ROOT}/dist/lead-backends/codex/codex-lead-tui-runtime.js"
    root_preflight="${FLYWHEEL_TEAMLEAD_ROOT}/dist/bin/preflight-codex-project-root.js"
    if [ -f "$actions_main" ] && [ ! -L "$actions_main" ]; then
      preflight_pass "Codex lead-actions runtime"
    else
      preflight_fail "Codex lead-actions runtime missing: $actions_main"
    fi
    if [ -f "$tui_runtime" ] && [ ! -L "$tui_runtime" ]; then
      preflight_pass "Codex TUI runtime"
    else
      preflight_fail "Codex TUI runtime missing: $tui_runtime"
    fi

    codex_launcher="${FLYWHEEL_TEAMLEAD_ROOT}/scripts/codex-lead.sh"
    if [ -x "$codex_launcher" ]; then
      state_dir="$(FLYWHEEL_STATE_DIR="$FLYWHEEL_STATE_DIR" /bin/bash "$codex_launcher" --print-state-dir "$RUN_LEAD" "$RUN_PROJECT" 2>/dev/null || true)"
    else
      state_dir=""
      preflight_fail "Codex Lead backend launcher missing: $codex_launcher"
    fi
    if [ -n "$state_dir" ]; then
      preflight_pass "Codex state directory resolution"
    else
      preflight_fail "Codex state directory resolution failed"
    fi
    if [ -f "$root_preflight" ] && [ ! -L "$root_preflight" ] \
      && node "$root_preflight" --project-root "$project_root" --state-dir "$state_dir" --codex-home "$codex_home" >/dev/null 2>&1; then
      preflight_pass "Codex project root"
    else
      preflight_fail "Codex project root rejected by runtime validator"
    fi

    target_sha="$(lead_host_tmux_target_sha)"
    probe_rc=0
    probe_output="$(FLYWHEEL_HOST_TMUX_TARGET_SHA="$target_sha" \
      FLYWHEEL_HOST_TMUX_BOUND_TRANSACTION="preflight:codex-generic:${RUN_PROJECT}-${RUN_LEAD}" \
      FLYWHEEL_HOST_TMUX_MOUNT_POINT="scripts/flywheel-lead.sh" \
      "$HOST_TMUX_GATE_BIN" probe codex-generic 2>&1)" || probe_rc=$?
    if [ "$probe_rc" -eq 0 ]; then
      preflight_pass "host tmux probe"
    else
      preflight_fail "host tmux probe failed (exit $probe_rc): $probe_output"
    fi
    if [ -n "${FLYWHEEL_API_TOKEN:-${TEAMLEAD_API_TOKEN:-}}" ]; then
      preflight_pass "Bridge API token"
    else
      preflight_fail "FLYWHEEL_API_TOKEN or TEAMLEAD_API_TOKEN is required"
    fi

    runtime_rc=0
    runtime_output="$(
      sanitize_codex_child_env
      compose_codex_child_env "$selector" "$project_root" || exit $?
      FLYWHEEL_LEAD_DRY_RUN=1 /bin/bash "$CODEX_LAUNCHER" \
        "$RUN_LEAD" "$project_root" "$RUN_PROJECT" 2>&1
    )" || runtime_rc=$?
    if [ "$runtime_rc" -eq 0 ]; then
      preflight_pass "Codex runtime configuration"
    else
      preflight_fail "Codex runtime configuration rejected: $runtime_output"
    fi
  fi

  if [ "$PREFLIGHT_FAILURES" -ne 0 ]; then
    printf '[flywheel-lead] ERROR: preflight failed with %s finding(s)\n' "$PREFLIGHT_FAILURES" >&2
    return 78
  fi
  printf 'PASS preflight complete for %s/%s\n' "$RUN_PROJECT" "$RUN_LEAD"
}

option_value() {
  local wanted="$1"
  shift
  while [ "$#" -gt 0 ]; do
    if [ "$1" = "$wanted" ]; then
      [ "$#" -ge 2 ] || return 1
      printf '%s\n' "$2"
      return 0
    fi
    shift
  done
  return 1
}

resolved_project_dir() {
  case "$1" in
    /*) printf '%s\n' "$1" ;;
    *) printf '%s/%s\n' "$HOME" "$1" ;;
  esac
}

selector_for() {
  node "$FLYWHEEL_COMM_CLI" lead-registry selector \
    --project "$1" --lead "$2" --projects-file "$PROJECTS_FILE"
}

require_registry_intent_clear() {
  if [ -L "$INTENT_FILE" ]; then
    fail "registry recovery intent is a symlink: $INTENT_FILE" 78
    return $?
  fi
  if [ -e "$INTENT_FILE" ] \
    && { [ ! -f "$INTENT_FILE" ] \
      || [ "$(jq -r '.phase // "invalid"' "$INTENT_FILE" 2>/dev/null)" != "done" ]; }; then
    fail "registry recovery is required before launch: $INTENT_FILE" 78
    return $?
  fi
}

validate_manifest_binding() {
  local manifest="$1" project="$2" lead="$3" selector="$4"
  if [ ! -f "$manifest" ] || [ -L "$manifest" ]; then
    fail "manifest must be a regular non-symlink file: $manifest" 78
    return $?
  fi
  local expected_root expected_backend actual_project actual_lead actual_root actual_projects actual_backend
  expected_root="$(resolved_project_dir "$(jq -er '.projectRoot' <<<"$selector")")"
  expected_backend="$(jq -er '.backend' <<<"$selector")"
  actual_project="$(jq -er '.projectName' "$manifest" 2>/dev/null || true)"
  actual_lead="$(jq -er '.leadId' "$manifest" 2>/dev/null || true)"
  actual_root="$(jq -er '.projectDir' "$manifest" 2>/dev/null || true)"
  actual_projects="$(jq -er '.projectsFile' "$manifest" 2>/dev/null || true)"
  actual_backend="$(jq -er '.leadBackend.backendId // "claude-code"' "$manifest" 2>/dev/null || true)"
  if [ "$actual_project" != "$project" ] || [ "$actual_lead" != "$lead" ] \
    || [ "$actual_root" != "$expected_root" ] || [ "$actual_projects" != "$PROJECTS_FILE" ] \
    || [ "$actual_backend" != "$expected_backend" ]; then
    fail "manifest identity differs from projects.json; remove $manifest and rerun register" 78
    return $?
  fi
}

register_lead() {
  local project lead lock_script materializer result selector manifest arg flag
  for arg in "$@"; do
    case "$arg" in
      --projects-file|--projects-file=*|--receipt-file|--receipt-file=*|--summary-config-home|--summary-config-home=*)
        flag="${arg%%=*}"
        fail "$flag is not supported by flywheel-lead register" 64
        return $?
        ;;
    esac
  done
  project="$(option_value --project-name "$@" || true)"
  lead="$(option_value --lead-id "$@" || true)"
  [ -n "$project" ] && [ -n "$lead" ] || { fail "register requires --project-name and --lead-id" 64; return $?; }
  load_common || return $?

  lock_script="$(_tool_path flywheel-config-lock.sh)"
  materializer="${FLYWHEEL_LEAD_MATERIALIZER:-$(_tool_path materialize-lead-manifests.sh)}"
  [ -f "$lock_script" ] || { fail "config lock helper is missing: $lock_script" 78; return $?; }
  [ -x "$materializer" ] || { fail "manifest materializer is missing: $materializer" 78; return $?; }
  # shellcheck source=flywheel-config-lock.sh
  # shellcheck disable=SC1091
  FLYWHEEL_CONFIG_LOCK_SOURCED=1 source "$lock_script"
  result="$(config_write_locked "${PROJECTS_FILE}.cfglock" 5 \
      env FLYWHEEL_SUMMARY_CONFIG_LOCK_HELD=1 \
      FLYWHEEL_TEAMLEAD_PROJECTS_VALIDATOR="$FLYWHEEL_TEAMLEAD_PROJECTS_VALIDATOR" \
      node "$FLYWHEEL_COMM_CLI" lead-registry add "$@")" || return $?
  printf '%s\n' "$result"
  if jq -e '.dryRun == true' >/dev/null 2>&1 <<<"$result"; then
    return 0
  fi

  "$materializer" --home "$HOME" --projects "$PROJECTS_FILE" --manifests-dir "$MANIFEST_DIR" || {
    fail "registration committed but manifest materialization failed; rerun the same register command" 78
    return 78
  }
  selector="$(selector_for "$project" "$lead")" || return $?
  manifest="${MANIFEST_DIR}/${project}-${lead}.json"
  validate_manifest_binding "$manifest" "$project" "$lead" "$selector" || return $?
  jq -nc --arg leadKey "${project}-${lead}" --arg projectsFile "$PROJECTS_FILE" \
    --arg receiptFile "$RECEIPT_FILE" \
    '{ok:true,leadKey:$leadKey,projectsFile:$projectsFile,receiptFile:$receiptFile,effectiveAt:"next-bridge-restart"}'
}

recover_registry() {
  [ "$#" -eq 0 ] || { fail "recover takes no arguments" 64; return $?; }
  load_common || return $?
  local lock_script
  lock_script="$(_tool_path flywheel-config-lock.sh)"
  [ -f "$lock_script" ] || { fail "config lock helper is missing: $lock_script" 78; return $?; }
  # shellcheck source=flywheel-config-lock.sh
  # shellcheck disable=SC1091
  FLYWHEEL_CONFIG_LOCK_SOURCED=1 source "$lock_script"
  config_write_locked "${PROJECTS_FILE}.cfglock" 5 \
    env FLYWHEEL_SUMMARY_CONFIG_LOCK_HELD=1 \
    FLYWHEEL_TEAMLEAD_PROJECTS_VALIDATOR="$FLYWHEEL_TEAMLEAD_PROJECTS_VALIDATOR" \
    node "$FLYWHEEL_COMM_CLI" lead-registry recover
}

load_supervisor() {
  local supervisor_lib="${FLYWHEEL_BIN_DIR}/lib/supervisor.sh"
  [ -f "$supervisor_lib" ] && [ ! -L "$supervisor_lib" ] \
    || supervisor_lib="${FLYWHEEL_DIR}/scripts/lib/supervisor.sh"
  [ -f "$supervisor_lib" ] && [ ! -L "$supervisor_lib" ] \
    || { fail "supervisor helper is missing or unsafe: $supervisor_lib" 78; return $?; }
  # shellcheck source=lib/supervisor.sh
  # shellcheck disable=SC1091
  source "$supervisor_lib"
  [ "$(supervisor_backend)" = "launchd" ] \
    || { fail "Lead install and stop currently require the launchd supervisor" 78; return $?; }
}

resolve_lifecycle_target() {
  local project lead selector
  [ "$#" -eq 4 ] \
    || { fail "lifecycle command requires --project P --lead L" 64; return $?; }
  project="$(option_value --project "$@" || true)"
  lead="$(option_value --lead "$@" || true)"
  [ -n "$project" ] && [ -n "$lead" ] \
    || { fail "lifecycle command requires --project P --lead L" 64; return $?; }
  case "$project:$lead" in
    *[!A-Za-z0-9._:-]*) fail "project and Lead ids contain unsupported characters" 64; return $? ;;
  esac
  LIFECYCLE_MANIFEST="${MANIFEST_DIR}/${project}-${lead}.json"
  read_manifest_identity "$LIFECYCLE_MANIFEST" || return $?
  [ "$RUN_PROJECT" = "$project" ] && [ "$RUN_LEAD" = "$lead" ] \
    || { fail "manifest identity does not match requested Lead" 78; return $?; }
  selector="$(selector_for "$project" "$lead")" || return $?
  validate_manifest_binding "$LIFECYCLE_MANIFEST" "$project" "$lead" "$selector" \
    || return $?
  LIFECYCLE_PROJECT="$project"
  LIFECYCLE_LEAD="$lead"
  LIFECYCLE_NAME="lead.${project}-${lead}"
  LIFECYCLE_LABEL="com.flywheel.${LIFECYCLE_NAME}"
  LIFECYCLE_PLIST="${FLYWHEEL_LAUNCHD_DIR:-${HOME}/Library/LaunchAgents}/${LIFECYCLE_LABEL}.plist"
  case "$RUN_BACKEND" in
    claude-code) LIFECYCLE_CARRIER="${FLYWHEEL_BIN_DIR}/flywheel-lead-wrapper-v2.sh" ;;
    codex-app-server) LIFECYCLE_CARRIER="${FLYWHEEL_BIN_DIR}/flywheel-lead.sh" ;;
    *) fail "unsupported lifecycle backend: $RUN_BACKEND" 78; return $? ;;
  esac
}

plist_matches_lifecycle_target() {
  local plist="$1"
  [ -f "$plist" ] && [ ! -L "$plist" ] || return 1
  python3 - "$plist" "$LIFECYCLE_LABEL" "$LIFECYCLE_CARRIER" \
    "$LIFECYCLE_MANIFEST" <<'PY'
import plistlib
import sys

path, expected_label, carrier, manifest = sys.argv[1:]
try:
    with open(path, "rb") as handle:
        value = plistlib.load(handle)
except (OSError, plistlib.InvalidFileException):
    raise SystemExit(1)
if value.get("Label") != expected_label:
    raise SystemExit(1)
if value.get("ProgramArguments") != ["/bin/bash", carrier, manifest]:
    raise SystemExit(1)
PY
}

assert_lifecycle_carrier() {
  local source_carrier
  [ -x "$LIFECYCLE_CARRIER" ] && [ ! -L "$LIFECYCLE_CARRIER" ] \
    || { fail "installed Lead carrier is missing or unsafe: $LIFECYCLE_CARRIER" 78; return $?; }
  source_carrier="${FLYWHEEL_DIR}/scripts/${LIFECYCLE_CARRIER##*/}"
  if [ ! -f "$source_carrier" ] || [ -L "$source_carrier" ] \
    || ! cmp -s "$source_carrier" "$LIFECYCLE_CARRIER"; then
    fail "installed Lead carrier bytes differ from $source_carrier" 78
    return $?
  fi
}

install_lead() {
  load_common paths-only || return $?
  load_supervisor || return $?
  resolve_lifecycle_target "$@" || return $?
  if [ -e "$LIFECYCLE_PLIST" ] || [ -L "$LIFECYCLE_PLIST" ]; then
    plist_matches_lifecycle_target "$LIFECYCLE_PLIST" \
      || { fail "existing plist does not match an owned Lead carrier: $LIFECYCLE_PLIST" 78; return $?; }
  fi
  (preflight_manifest "$LIFECYCLE_MANIFEST") || return $?
  assert_lifecycle_carrier || return $?
  [ ! -L "${FLYWHEEL_STATE_DIR}/logs" ] \
    || { fail "Lead log directory must not be a symlink" 78; return $?; }
  mkdir -p "${FLYWHEEL_STATE_DIR}/logs" || return 70
  local spec
  spec="$(jq -nc \
    --arg name "$LIFECYCLE_NAME" \
    --arg command "/bin/bash $LIFECYCLE_CARRIER $LIFECYCLE_MANIFEST" \
    --arg stdout "${FLYWHEEL_STATE_DIR}/logs/lead-${LIFECYCLE_PROJECT}-${LIFECYCLE_LEAD}.log" \
    '{name:$name,kind:"service",exec:$command,keepAlive:true,throttleInterval:30,stdout:$stdout}')" \
    || return 70
  FLYWHEEL_SUPERVISOR_DARWIN_INSTALL=1 supervisor_install "$spec" || return $?
  plist_matches_lifecycle_target "$LIFECYCLE_PLIST" \
    || { fail "installed plist does not match the requested Lead carrier" 70; return $?; }
  log "installed ${LIFECYCLE_LABEL}; run preflight and verify before live traffic"
}

stop_lead() {
  load_common paths-only || return $?
  load_supervisor || return $?
  resolve_lifecycle_target "$@" || return $?
  plist_matches_lifecycle_target "$LIFECYCLE_PLIST" \
    || { fail "existing plist does not match an owned Lead carrier: $LIFECYCLE_PLIST" 78; return $?; }
  supervisor_stop "$LIFECYCLE_NAME" service || return $?
  rm -f "$LIFECYCLE_PLIST" || return 70
  log "stopped ${LIFECYCLE_LABEL}; Bridge still pumps this registered Lead; unregister manually per the runbook"
}

verify_pass() {
  printf 'PASS #%s %s\n' "$1" "$2"
}

verify_fail() {
  printf 'FAIL #%s %s\n' "$1" "$2" >&2
  return 1
}

verify_lead() {
  local stage="live" message_id="" manifest="" value
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --stage|--message-id)
        [ "$#" -ge 2 ] || { fail "$1 requires a value" 64; return $?; }
        value="$2"
        if [ "$1" = "--stage" ]; then stage="$value"; else message_id="$value"; fi
        shift 2
        ;;
      --*) fail "unknown verify option: $1" 64; return $? ;;
      *)
        [ -z "$manifest" ] || { fail "verify requires exactly one manifest" 64; return $?; }
        manifest="$1"
        shift
        ;;
    esac
  done
  [ -n "$manifest" ] || { fail "verify requires exactly one manifest" 64; return $?; }
  case "$stage" in registered|installed|live) ;; *) fail "verify stage must be registered, installed, or live" 64; return $? ;; esac
  if [ -n "$message_id" ]; then
    [ "$stage" = "live" ] \
      || { fail "--message-id requires --stage live" 64; return $?; }
    [[ "$message_id" =~ ^[0-9]{16,20}$ ]] \
      || { fail "--message-id must be a Discord snowflake" 64; return $?; }
  fi

  load_common paths-only || return 1
  read_manifest_identity "$manifest" || return 1

  local intent_output identity identity_backend activation_output preflight_output
  intent_output="$(require_registry_intent_clear 2>&1)" \
    || { verify_fail 1 "registry recovery intent: $intent_output"; return 1; }
  verify_pass 1 "registry recovery intent clear"

  identity="$(node "$FLYWHEEL_COMM_CLI" lead-identity resolve \
    --projects-file "$PROJECTS_FILE" --project "$RUN_PROJECT" --lead "$RUN_LEAD" 2>&1)" \
    || { verify_fail 2 "Lead identity resolution: $identity"; return 1; }
  identity_backend="$(jq -er '.backend' <<<"$identity" 2>/dev/null || true)"
  [ "$identity_backend" = "$RUN_BACKEND" ] \
    || { verify_fail 2 "resolved backend differs from manifest: ${identity_backend:-missing} != $RUN_BACKEND"; return 1; }
  verify_pass 2 "Lead identity backend=$identity_backend"

  activation_output="$(node "$FLYWHEEL_COMM_CLI" summary-registry verify-activation \
    --projects-file "$PROJECTS_FILE" --receipt-file "$RECEIPT_FILE" 2>&1)" \
    || { verify_fail 3 "summary registry activation: $activation_output"; return 1; }
  verify_pass 3 "summary registry activation"

  preflight_output="$(preflight_manifest "$manifest" 2>&1)" \
    || { printf '%s\n' "$preflight_output" >&2; verify_fail 4 "preflight"; return 1; }
  printf '%s\n' "$preflight_output"
  verify_pass 4 "preflight"
  [ "$stage" != "registered" ] || return 0

  source_runtime_env || { verify_fail 5 "environment load"; return 1; }
  local bridge_url health build_sha bridge_token escaped_token payload nudge_status
  bridge_url="${FLYWHEEL_BRIDGE_URL:-${BRIDGE_URL:-http://localhost:9876}}"
  case "$bridge_url" in
    http://*|https://*) ;;
    *) verify_fail 5 "Bridge URL must use http or https"; return 1 ;;
  esac
  case "$bridge_url" in *$'\n'*|*$'\r'*) verify_fail 5 "Bridge URL must be one line"; return 1 ;; esac
  bridge_url="${bridge_url%/}"
  health="$(curl -q -sS --max-time 5 "${bridge_url}/health" 2>&1)" \
    || { verify_fail 5 "Bridge health request failed: $health"; return 1; }
  build_sha="$(jq -er '.buildSha | select(type == "string" and length > 0)' <<<"$health" 2>/dev/null || true)"
  if ! jq -e '.ok == true' <<<"$health" >/dev/null 2>&1 || [ -z "$build_sha" ]; then
    verify_fail 5 "Bridge health is not ok or lacks buildSha"
    return 1
  fi
  verify_pass 5 "Bridge health buildSha=$build_sha"

  bridge_token="${FLYWHEEL_API_TOKEN:-${TEAMLEAD_API_TOKEN:-}}"
  [ -n "$bridge_token" ] \
    || { verify_fail 6 "Bridge API token is missing"; return 1; }
  case "$bridge_token" in *$'\n'*|*$'\r'*) verify_fail 6 "Bridge API token must be one line"; return 1 ;; esac
  escaped_token="${bridge_token//\\/\\\\}"
  escaped_token="${escaped_token//\"/\\\"}"
  payload="$(jq -nc --arg leadId "$RUN_LEAD" --arg project "$RUN_PROJECT" \
    '{leadId:$leadId,project:$project}')" || return 1
  nudge_status="$(printf 'header = "Authorization: Bearer %s"\n' "$escaped_token" \
    | curl -q -sS --config - --max-time 5 -X POST \
      -H 'content-type: application/json' --data-binary "$payload" \
      -o /dev/null -w '%{http_code}' "${bridge_url}/api/lead-inbox/nudge" 2>&1)" \
    || { verify_fail 6 "Lead inbox nudge request failed: $nudge_status"; return 1; }
  case "$nudge_status" in
    202) verify_pass 6 "Lead inbox pump mounted" ;;
    404) verify_fail 6 "registration succeeded; Bridge has not restarted, so the Lead inbox pump is absent"; return 1 ;;
    *) verify_fail 6 "Lead inbox nudge returned HTTP $nudge_status"; return 1 ;;
  esac
  [ "$stage" != "installed" ] || return 0

  local launch_output pid_count pid label state_dir codex_launcher inbox_dir
  label="com.flywheel.lead.${RUN_PROJECT}-${RUN_LEAD}"
  launch_output="$(launchctl print "gui/$(id -u)/${label}" 2>&1)" \
    || { verify_fail 7 "launchd job is not loaded: $label"; return 1; }
  pid_count="$(grep -Ec '^[[:space:]]*pid = [0-9]+[[:space:]]*$' <<<"$launch_output" || true)"
  if [ "$(grep -Ec '^[[:space:]]*state = running[[:space:]]*$' <<<"$launch_output" || true)" -ne 1 ] \
    || [ "$pid_count" -ne 1 ]; then
    verify_fail 7 "launchd must report state=running and exactly one pid"
    return 1
  fi
  pid="$(awk -F '= ' '/^[[:space:]]*pid = [0-9]+[[:space:]]*$/ { gsub(/[[:space:]]/, "", $2); print $2 }' <<<"$launch_output")"
  verify_pass 7 "launchd running pid=$pid"

  if [ "$RUN_BACKEND" = "codex-app-server" ]; then
    codex_launcher="${FLYWHEEL_TEAMLEAD_ROOT}/scripts/codex-lead.sh"
    state_dir="$(FLYWHEEL_STATE_DIR="$FLYWHEEL_STATE_DIR" /bin/bash "$codex_launcher" \
      --print-state-dir "$RUN_LEAD" "$RUN_PROJECT" 2>/dev/null || true)"
    [ -n "$state_dir" ] && [ -S "$state_dir/lead-inbox.sock" ] \
      || { verify_fail 8 "Codex inbox socket is absent"; return 1; }
    verify_pass 8 "Codex inbox socket $state_dir/lead-inbox.sock"
  else
    inbox_dir="${HOME}/.claude/teams/${RUN_LEAD}/inboxes"
    [ -d "$inbox_dir" ] && [ ! -L "$inbox_dir" ] \
      || { verify_fail 8 "Claude inbox directory is absent or unsafe: $inbox_dir"; return 1; }
    verify_pass 8 "Claude inbox $inbox_dir"
  fi
  [ -n "$message_id" ] || return 0

  local delivery_id message_status delivered_at
  delivery_id="chat:${RUN_LEAD}:${message_id}"
  message_status="$(node "$FLYWHEEL_COMM_CLI" message-status "$delivery_id" \
    --db "${HOME}/.flywheel/comm/${RUN_PROJECT}/comm.db" --json 2>&1)" \
    || { verify_fail 9 "mailbox delivery is absent: $delivery_id ($message_status)"; return 1; }
  delivered_at="$(jq -er '.stamps.delivered_at | select(type == "string" and length > 0)' \
    <<<"$message_status" 2>/dev/null || true)"
  if [ "$(jq -r '.state // ""' <<<"$message_status" 2>/dev/null)" != "ACKED" ] \
    || [ -z "$delivered_at" ]; then
    verify_fail 9 "mailbox delivery is not ACKED: $delivery_id"
    return 1
  fi
  verify_pass 9 "mailbox state=ACKED delivered_at=$delivered_at delivery_id=$delivery_id"

  if [ "$RUN_BACKEND" = "codex-app-server" ]; then
    local inspector inspector_output entry_id idempotency_key outbound_message_id
    inspector="${FLYWHEEL_TEAMLEAD_ROOT}/dist/bin/inspect-lead-outbound.js"
    [ -f "$inspector" ] && [ ! -L "$inspector" ] \
      || { verify_fail 10 "Codex outbound inspector is missing or unsafe: $inspector"; return 1; }
    inspector_output="$(node "$inspector" \
      --state-dir "$state_dir" \
      --delivery-id "$delivery_id" \
      --dedup-db "${HOME}/.flywheel/codex-lead-outbound-dedup.db" 2>&1)" \
      || { verify_fail 10 "Codex outbound evidence: $inspector_output"; return 1; }
    entry_id="$(jq -er '.entryId | select(type == "string" and length > 0)' \
      <<<"$inspector_output" 2>/dev/null || true)"
    idempotency_key="$(jq -er '.idempotencyKey | select(type == "string" and length > 0)' \
      <<<"$inspector_output" 2>/dev/null || true)"
    outbound_message_id="$(jq -er '.messageId | select(type == "string" and length > 0)' \
      <<<"$inspector_output" 2>/dev/null || true)"
    if [ -z "$entry_id" ] || [ -z "$idempotency_key" ] || [ -z "$outbound_message_id" ]; then
      verify_fail 10 "Codex outbound inspector returned an incomplete receipt: $inspector_output"
      return 1
    fi
    verify_pass 10 "Codex outbound delivery_id=$delivery_id entry_id=$entry_id idempotency_key=$idempotency_key message_id=$outbound_message_id"
  fi
  return 0
}

main() {
  local command="${1:-}"
  case "$command" in
    -h|--help) usage ;;
    register) shift; register_lead "$@" ;;
    run) shift; run_lead "$@" ;;
    preflight)
      shift
      [ "$#" -eq 1 ] || { fail "preflight requires exactly one manifest" 64; return $?; }
      preflight_manifest "$1"
      ;;
    recover) shift; recover_registry "$@" ;;
    install) shift; install_lead "$@" ;;
    stop) shift; stop_lead "$@" ;;
    verify) shift; verify_lead "$@" ;;
    *)
      if [ "$#" -eq 1 ] && [ -f "$1" ]; then
        run_lead "$1"
      else
        usage >&2
        return 64
      fi
      ;;
  esac
}

main "$@"
