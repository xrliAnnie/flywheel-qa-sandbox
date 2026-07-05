#!/bin/bash
# FLY-650: host-config.sh — the CORE/HOST config loader (D2=B core layer).
#
# Splits machine/platform/deployment config (host.json) from project config
# (projects.json). Today these machine concerns are hardcoded to one Mac
# (`~/Dev/flywheel`, launchd, the skills repo). This lib externalizes them so the
# SAME runtime/provisioning scripts run on Linux/WSL2 — by reading host.json with
# a precise, byte-compatible contract.
#
# Contract (plan §3.1):
#   - resolution precedence per field:  ENV var  >  host.json field  >  default
#   - missing host.json  → documented defaults == today's hardcoded values, so a
#     host with no host.json behaves EXACTLY as before (byte-compat).
#   - malformed JSON / unknown supervisorBackend|viewerBackend|platform → FAIL-CLOSED
#     (return non-zero, never silently fall back to a default that could start the
#     wrong checkout / wrong supervisor).
#   - non-empty `leadEnablement` → FAIL-LOUD ("not implemented; see follow-up").
#     absent/null/empty = today's behavior (all leads start).
#   - host.json carries NO secrets (capture scans it anyway).
#
# Exports (after host_config_load): FLYWHEEL_DIR, FLYWHEEL_STATE_DIR,
#   FLYWHEEL_SKILLS_REPO, FLYWHEEL_SUPERVISOR_BACKEND, FLYWHEEL_PLATFORM,
#   FLYWHEEL_VIEWER_BACKEND, FLYWHEEL_HOST_CONFIG (the resolved path, if present).
#
# Sourceable (guarded) so wrappers/provisioner + tests can use it directly.
[ -n "${HOST_CONFIG_SOURCED:-}" ] && return 0
HOST_CONFIG_SOURCED=1

_hc_err() { echo "[host-config] ERROR: $*" >&2; }

# _hc_expand_path <value> — expand a leading ~ against $HOME. Leaves absolute and
# relative paths otherwise untouched.
_hc_expand_path() {
  local v="$1"
  case "$v" in
    "~") printf '%s' "$HOME" ;;
    "~/"*) printf '%s' "$HOME/${v#\~/}" ;;
    *) printf '%s' "$v" ;;
  esac
}

# _hc_detect_platform — map `uname -s` to our platform id. FAIL-CLOSED on anything
# we don't support (so a surprise OS doesn't silently pick a backend).
_hc_detect_platform() {
  case "$(uname -s 2>/dev/null)" in
    Darwin) printf 'darwin' ;;
    Linux)  printf 'linux' ;;
    *)      printf '' ;;  # unknown → caller fails closed
  esac
}

# host_config_load [host-json-path]
#   Resolve + validate + export the host config. Returns non-zero on any
#   fail-closed condition (malformed JSON, unknown enum, unsupported platform,
#   non-empty leadEnablement).
host_config_load() {
  command -v jq >/dev/null 2>&1 || { _hc_err "jq required"; return 2; }

  local state_dir_for_lookup="${FLYWHEEL_STATE_DIR:-$HOME/.flywheel}"
  local host_json="${1:-${FLYWHEEL_HOST_CONFIG:-$state_dir_for_lookup/host.json}}"

  # Parse host.json if present. Missing = empty config (defaults apply).
  local cfg='{}'
  if [ -f "$host_json" ]; then
    if ! jq empty "$host_json" >/dev/null 2>&1; then
      _hc_err "malformed host.json (not valid JSON): $host_json"
      return 1   # fail-closed — do NOT silently use defaults
    fi
    cfg="$(cat "$host_json")"
    FLYWHEEL_HOST_CONFIG="$host_json"
  fi

  # Type-check scalar fields (Codex R1 MED): a present field MUST be a string —
  # reject flywheelDir:{} / stateDir:123 / skillsRepo:[] etc. fail-closed rather
  # than exporting a stringified object/number.
  local _f
  for _f in platform flywheelDir stateDir skillsRepo supervisorBackend viewerBackend; do
    if [ "$(jq -r --arg k "$_f" 'if (.[$k]==null) then "ok" elif (.[$k]|type)=="string" then "ok" else "bad" end' <<<"$cfg" 2>/dev/null)" = "bad" ]; then
      _hc_err "host.json field '$_f' must be a string, got $(jq -c --arg k "$_f" '.[$k]' <<<"$cfg" 2>/dev/null)"
      return 1
    fi
  done

  local _get  # _get <jsonField> → value or empty
  _get() { jq -r --arg k "$1" '.[$k] // empty' <<<"$cfg" 2>/dev/null; }

  # ── platform: ENV > host.json > uname ──
  local platform="${FLYWHEEL_PLATFORM:-}"
  [ -z "$platform" ] && platform="$(_get platform)"
  [ -z "$platform" ] && platform="$(_hc_detect_platform)"
  case "$platform" in
    darwin|linux) ;;
    *) _hc_err "unsupported/unknown platform: '${platform:-<empty>}' (need darwin|linux)"; return 1 ;;
  esac

  # platform-derived defaults
  local def_supervisor def_viewer
  case "$platform" in
    darwin) def_supervisor="launchd";      def_viewer="cmux" ;;
    linux)  def_supervisor="systemd-user"; def_viewer="tmux-only" ;;
  esac

  # ── per-field: ENV > host.json > default ──
  local flywheel_dir="${FLYWHEEL_DIR:-}"
  [ -z "$flywheel_dir" ] && flywheel_dir="$(_get flywheelDir)"
  [ -z "$flywheel_dir" ] && flywheel_dir="$HOME/Dev/flywheel"

  local state_dir="${FLYWHEEL_STATE_DIR:-}"
  [ -z "$state_dir" ] && state_dir="$(_get stateDir)"
  [ -z "$state_dir" ] && state_dir="$HOME/.flywheel"

  local skills_repo="${FLYWHEEL_SKILLS_REPO:-}"
  [ -z "$skills_repo" ] && skills_repo="$(_get skillsRepo)"
  [ -z "$skills_repo" ] && skills_repo="xrliAnnie/flywheel-skills"

  local supervisor="${FLYWHEEL_SUPERVISOR_BACKEND:-}"
  [ -z "$supervisor" ] && supervisor="$(_get supervisorBackend)"
  [ -z "$supervisor" ] && supervisor="$def_supervisor"
  case "$supervisor" in
    launchd|systemd-user|container) ;;
    *) _hc_err "unknown supervisorBackend: '$supervisor' (need launchd|systemd-user|container)"; return 1 ;;
  esac

  local viewer="${FLYWHEEL_VIEWER_BACKEND:-}"
  [ -z "$viewer" ] && viewer="$(_get viewerBackend)"
  [ -z "$viewer" ] && viewer="$def_viewer"
  case "$viewer" in
    cmux|terminal-app|tmux-only|none) ;;
    *) _hc_err "unknown viewerBackend: '$viewer' (need cmux|terminal-app|tmux-only|none)"; return 1 ;;
  esac

  # ── leadEnablement: absent/null/empty OK; non-empty → fail-loud (FLY-650 §3.6) ──
  local le
  le="$(jq -r '
    (.leadEnablement) as $e
    | if $e == null then "ok"
      elif ($e|type)=="object" and ($e|length)==0 then "ok"
      elif ($e|type)=="array"  and ($e|length)==0 then "ok"
      else "set" end' <<<"$cfg" 2>/dev/null)"
  if [ "$le" = "set" ]; then
    _hc_err "host.json 'leadEnablement' is set but NOT implemented in FLY-650 (reserved interface; see the per-machine lead-enablement follow-up issue). Remove it or leave it null/empty."
    return 1
  fi

  # ── expand + export ──
  export FLYWHEEL_PLATFORM="$platform"
  export FLYWHEEL_DIR="$(_hc_expand_path "$flywheel_dir")"
  export FLYWHEEL_STATE_DIR="$(_hc_expand_path "$state_dir")"
  export FLYWHEEL_SKILLS_REPO="$skills_repo"
  export FLYWHEEL_SUPERVISOR_BACKEND="$supervisor"
  export FLYWHEEL_VIEWER_BACKEND="$viewer"
  [ -n "${FLYWHEEL_HOST_CONFIG:-}" ] && export FLYWHEEL_HOST_CONFIG

  return 0
}
