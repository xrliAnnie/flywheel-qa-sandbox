#!/bin/bash
# FLY-143: Helper library — generate the user-scope MCP inheritance fragment
# for Lead daemon `.mcp.json`.
#
# This file is meant to be `source`d (provides functions). It does not run
# logic on its own. The two public functions are:
#
#   build_user_mcp_fragment <user_claude_json> <reserved_names_csv> [<blacklist_csv>] [<exclude_csv>]
#     stdout: a JSON object suitable for jq merge (`{name: cfg, ...}`).
#     env: respects FLYWHEEL_LEAD_MCP_LOG_PREFIX (default: "[lead]") for log lines on stderr.
#
#   write_atomic_mcp_config <out_path> <user_mcp_json> <terminal_json> <inbox_json> <gbrain_json>
#     Writes `{mcpServers: (user + terminal + inbox + gbrain)}` to <out_path>
#     atomically with mode 0600 (mktemp + chmod + mv + trap cleanup).
#
# Design rationale: documented in
#   doc/engineer/exploration/new/FLY-143-lead-mcp-scope-audit.md
#
# Trust model: read only `~/.claude.json.mcpServers` top-level (never
# `.projects[*].mcpServers` — those carry per-project secrets like the local
# `slack` server's bot token). Per-server env gate uses Claude-compatible
# `${VAR}` and `${VAR:-default}` semantics: if any required (no-default) `${VAR}`
# is unset, skip that single server with a warning rather than emit an
# unresolvable Bearer placeholder that breaks the entire MCP config parse.
#
# Reserved names always win — Annie's user-scope server with the same name
# as a Flywheel infra MCP is logged + skipped, never silently overridden.
set -euo pipefail

# ── Logger helper (stderr only — stdout is JSON output) ─────────────
_mcp_inherit_log() {
  echo "${FLYWHEEL_LEAD_MCP_LOG_PREFIX:-[lead]} $(date '+%H:%M:%S') $*" >&2
}

# ── csv_to_array <csv> — splits "a, b ,c" → ("a" "b" "c") (trim whitespace) ─
csv_to_array() {
  local raw="$1"
  local out=()
  if [ -n "$raw" ]; then
    local IFS=','
    # shellcheck disable=SC2206
    local parts=($raw)
    local x
    for x in "${parts[@]}"; do
      # Trim leading/trailing whitespace
      x="${x#"${x%%[![:space:]]*}"}"
      x="${x%"${x##*[![:space:]]}"}"
      [ -n "$x" ] && out+=("$x")
    done
  fi
  printf '%s\n' "${out[@]+"${out[@]}"}"
}

# ── _required_env_missing <cfg_json> ─────────────────────────────────
# Walk all string leaves of cfg_json. For each `${VAR}` (without `:-default`)
# whose VAR is unset in the environment, echo VAR and return success.
# Returns the FIRST missing var so callers can report a concrete name.
# `${VAR:-default}` is treated as satisfied (Claude expander applies the default).
# Literal `$$VAR` and bare `$VAR` (no braces) are not treated as references.
#
# Note: env expansion is intentionally one-pass — if `${FOO}` resolves to
# `${BAR}` we do NOT recursively require `BAR`, matching Claude Code's
# `envExpansion.ts` semantics.
_required_env_missing() {
  local cfg_json="$1"
  local vars
  # jq filter:
  #   1. [.. | strings] — all string leaves
  #   2. scan with negative lookbehind to skip `$$VAR` literal escape
  #   3. capture group 1 = name, group 2 = `:-default` (or null)
  #   4. select where group 2 is null (no default → required)
  #   5. emit just the name
  vars=$(echo "$cfg_json" | jq -r '
    [.. | strings]
    | .[]?
    | scan("(?<!\\$)\\$\\{([A-Za-z_][A-Za-z0-9_]*)(:-[^}]*)?\\}")
    | select(.[1] == null)
    | .[0]
  ' 2>/dev/null | sort -u || true)

  local var
  while IFS= read -r var; do
    [ -z "$var" ] && continue
    if [ -z "${!var:-}" ]; then
      echo "$var"
      return 0
    fi
  done < <(printf '%s\n' "$vars")
  return 1
}

# ── list_required_envs <mcp_config_file>
# Walk all string leaves of <mcp_config_file>'s mcpServers (final merged
# `.mcp.json`), extract every `${VAR}` placeholder without `:-default`, and
# print one unique var name per line on stdout. Used by claude-lead.sh
# `_launch_claude` to plumb just-in-time required env vars through tmux's
# `new-window -e` arg list — `tmux new-window -e` does NOT inherit the
# launcher's env, so anything referenced in `.mcp.json` (e.g. linear-api's
# `Bearer ${LINEAR_API_KEY}`) must be passed explicitly or the Lead session
# sees it as undefined and Claude marks the server "needs authentication".
#
# Same regex semantics as `_required_env_missing`:
#   - `${VAR}` → required (output VAR)
#   - `${VAR:-default}` → optional (skipped)
#   - `$$VAR` → literal escape (skipped — negative lookbehind)
#   - bare `$VAR` (no braces) → not a Claude placeholder (skipped)
#
# Returns 0 always (empty output is OK). Errors silently ignored to keep
# the launcher booting even if jq trips on unexpected JSON.
list_required_envs() {
  local mcp_file="$1"
  [ ! -f "$mcp_file" ] && return 0
  jq -r '
    [.mcpServers // {} | .. | strings]
    | .[]?
    | scan("(?<!\\$)\\$\\{([A-Za-z_][A-Za-z0-9_]*)(:-[^}]*)?\\}")
    | select(.[1] == null)
    | .[0]
  ' "$mcp_file" 2>/dev/null | sort -u
}

# ── build_user_mcp_fragment <user_claude_json> <reserved_csv> [<blacklist_csv>] [<exclude_csv>]
# Outputs JSON object on stdout. Empty `{}` if nothing to inherit. Never aborts
# the caller — every failure path is warn-and-continue.
build_user_mcp_fragment() {
  local user_claude_json="$1"
  local reserved_csv="${2:-}"
  local blacklist_csv="${3:-}"
  local exclude_csv="${4:-}"

  if [ ! -f "$user_claude_json" ]; then
    _mcp_inherit_log "User MCP inheritance: skip (~/.claude.json missing)"
    echo '{}'
    return 0
  fi
  if ! jq -e '.mcpServers? | objects' "$user_claude_json" >/dev/null 2>&1; then
    _mcp_inherit_log "User MCP inheritance: skip (~/.claude.json missing top-level mcpServers object or malformed)"
    echo '{}'
    return 0
  fi

  # Read whitelist arrays — macOS ships bash 3.2 without `mapfile`,
  # so build arrays via a portable while-read loop.
  local reserved=() blacklist=() excludes=()
  local _line
  while IFS= read -r _line; do
    [ -n "$_line" ] && reserved+=("$_line")
  done < <(csv_to_array "$reserved_csv")
  while IFS= read -r _line; do
    [ -n "$_line" ] && blacklist+=("$_line")
  done < <(csv_to_array "$blacklist_csv")
  while IFS= read -r _line; do
    [ -n "$_line" ] && excludes+=("$_line")
  done < <(csv_to_array "$exclude_csv")

  local user_mcp='{}'
  local server_names
  server_names=$(jq -r '.mcpServers | keys[]' "$user_claude_json" 2>/dev/null || true)

  local srv blocked ex reserved_name skip cfg missing_var
  while IFS= read -r srv; do
    [ -z "$srv" ] && continue
    skip=false

    # 1. Reserved-name collision — Flywheel infra always wins, but log it.
    for reserved_name in "${reserved[@]+"${reserved[@]}"}"; do
      if [ "$srv" = "$reserved_name" ]; then
        _mcp_inherit_log "WARNING: User MCP '${srv}' shadowed by Flywheel infra MCP — user config ignored"
        skip=true
        break
      fi
    done
    [ "$skip" = "true" ] && continue

    # 2. Class-based blacklist (default: audible, future personal/media).
    for blocked in "${blacklist[@]+"${blacklist[@]}"}"; do
      if [ "$srv" = "$blocked" ]; then
        _mcp_inherit_log "User MCP skipped (blacklist): ${srv}"
        skip=true
        break
      fi
    done
    [ "$skip" = "true" ] && continue

    # 3. Per-Lead exclude (manifest-driven via FLYWHEEL_LEAD_MCP_EXCLUDE).
    for ex in "${excludes[@]+"${excludes[@]}"}"; do
      if [ "$srv" = "$ex" ]; then
        _mcp_inherit_log "User MCP skipped (per-Lead exclude): ${srv}"
        skip=true
        break
      fi
    done
    [ "$skip" = "true" ] && continue

    # 4. Read cfg (compact JSON).
    cfg=$(jq -c --arg name "$srv" '.mcpServers[$name]' "$user_claude_json" 2>/dev/null || echo "")
    if [ -z "$cfg" ] || [ "$cfg" = "null" ]; then
      continue
    fi

    # 5. Per-server env gate. Skip server if any required `${VAR}` (without
    #    default) is unset, so we never write a placeholder that breaks the
    #    Claude Code MCP config parse.
    if missing_var=$(_required_env_missing "$cfg"); then
      _mcp_inherit_log "WARNING: User MCP '${srv}' requires env \$${missing_var} (unset) — skip"
      continue
    fi

    # 6. Add to fragment (unique by name).
    user_mcp=$(echo "$user_mcp" | jq --arg name "$srv" --argjson cfg "$cfg" '. + {($name): $cfg}')
    _mcp_inherit_log "User MCP inherited: ${srv}"
  done < <(printf '%s\n' "$server_names")

  echo "$user_mcp"
}

# ── write_atomic_mcp_config <out_path> <user_json> <terminal_json> <inbox_json> <gbrain_json>
# Writes `{mcpServers: (user + terminal + inbox + gbrain)}` to <out_path>
# with mode 0600. Uses mktemp + chmod + mv to avoid:
#   - Inherited 0644 mode from a pre-existing file
#   - Partial-read race during shell stdout redirect
write_atomic_mcp_config() {
  local out="$1"
  local user_json="$2"
  local terminal_json="$3"
  local inbox_json="$4"
  local gbrain_json="$5"

  local out_dir
  out_dir=$(dirname "$out")
  mkdir -p "$out_dir" 2>/dev/null || true

  local tmp
  tmp="$(mktemp "${out}.tmp.XXXXXX")"
  # Trap inside subshell-free function — clean up tmp on early failure.
  local _cleanup_tmp="$tmp"
  trap '[ -n "${_cleanup_tmp:-}" ] && [ -f "${_cleanup_tmp}" ] && rm -f "${_cleanup_tmp}"' RETURN

  (
    umask 077
    jq -n \
      --argjson user "$user_json" \
      --argjson terminal "$terminal_json" \
      --argjson inbox "$inbox_json" \
      --argjson gbrain "$gbrain_json" \
      '{mcpServers: ($user + $terminal + $inbox + $gbrain)}' \
      > "$tmp"
  )
  chmod 600 "$tmp" 2>/dev/null || true
  mv -f "$tmp" "$out"
  _cleanup_tmp=""   # tmp is now the live file — don't delete it
  trap - RETURN
}
