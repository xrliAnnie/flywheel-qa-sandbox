#!/usr/bin/env bash
# FLY-1330 — install the daily log janitor after an operator-reviewed first run.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT_RAW="${FLYWHEEL_REPO:-$HOME/Dev/flywheel}"
REPO_ROOT=""
TEMPLATE="$SCRIPT_DIR/com.flywheel.log-janitor.plist"
LABEL="com.flywheel.log-janitor"
STATE_DIR="${FLYWHEEL_JANITOR_STATE_DIR:-$HOME/.flywheel/state/log-janitor}"
FIRST_APPLY_MARKER="$STATE_DIR/first-apply-ok"
LAUNCH_AGENTS="$HOME/Library/LaunchAgents"
DEST="$LAUNCH_AGENTS/$LABEL.plist"
LOG_DIR="$HOME/Library/Logs/flywheel"
FORCE=0
RENDERED=""
DEST_TMP=""

log() { printf '[install-log-janitor] %s\n' "$*" >&2; }
die() { log "ERROR: $*"; exit 2; }

cleanup() {
  [[ -z "$RENDERED" ]] || rm -f "$RENDERED" 2>/dev/null || true
  [[ -z "$DEST_TMP" ]] || rm -f "$DEST_TMP" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

usage() {
  printf 'install-log-janitor.sh [--force]\n' >&2
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --force) FORCE=1 ;;
    -h|--help) usage; exit 0 ;;
    *) usage; die "unknown argument: $1" ;;
  esac
  shift
done

[[ "$HOME" == /* ]] || die "HOME must be absolute"
[[ "$REPO_ROOT_RAW" == /* && -d "$REPO_ROOT_RAW" && ! -L "$REPO_ROOT_RAW" ]] \
  || die "FLYWHEEL_REPO must be an absolute, non-symlink directory: $REPO_ROOT_RAW"
REPO_ROOT="$(cd -P "$REPO_ROOT_RAW" 2>/dev/null && pwd -P)" \
  || die "cannot resolve production repo root: $REPO_ROOT_RAW"
[[ -f "$TEMPLATE" && ! -L "$TEMPLATE" ]] || die "missing or unsafe plist template: $TEMPLATE"
[[ -x "$REPO_ROOT/scripts/flywheel-log-janitor.sh" ]] \
  || die "production janitor script is not executable: $REPO_ROOT/scripts/flywheel-log-janitor.sh"
[[ -f "$REPO_ROOT/packages/flywheel-comm/dist/index.js" \
  && ! -L "$REPO_ROOT/packages/flywheel-comm/dist/index.js" ]] \
  || die "production flywheel-comm is not built: $REPO_ROOT/packages/flywheel-comm/dist/index.js"
command -v jq >/dev/null 2>&1 || die "jq is required"

if [[ "$FORCE" -ne 1 ]]; then
  [[ -f "$FIRST_APPLY_MARKER" && ! -L "$FIRST_APPLY_MARKER" ]] \
    || die "missing $FIRST_APPLY_MARKER; run janitor --cycle once (or review --dry-run, then --apply) before installing"
fi

if [[ -n "${FLYWHEEL_JANITOR_LAUNCHCTL:-}" ]]; then
  LAUNCHCTL="$FLYWHEEL_JANITOR_LAUNCHCTL"
else
  LAUNCHCTL="$(command -v launchctl 2>/dev/null || true)"
fi
[[ -n "$LAUNCHCTL" && -x "$LAUNCHCTL" ]] || die "launchctl is unavailable"
DOMAIN="gui/$(id -u)"

mkdir -p "$LAUNCH_AGENTS" "$LOG_DIR" || die "cannot create launchd/log directories"
[[ ! -L "$DEST" ]] || die "refusing to replace symlink plist: $DEST"
[[ ! -e "$DEST" || -f "$DEST" ]] || die "plist destination is not a regular file: $DEST"

escape_sed_replacement() {
  printf '%s' "$1" | sed 's/[&|]/\\&/g'
}

escaped_repo="$(escape_sed_replacement "$REPO_ROOT")"
escaped_home="$(escape_sed_replacement "$HOME")"
RENDERED="$(mktemp "${TMPDIR:-/tmp}/flywheel-log-janitor-plist.XXXXXX")" \
  || die "cannot allocate plist staging file"
sed \
  -e "s|__REPO_ROOT__|$escaped_repo|g" \
  -e "s|__HOME__|$escaped_home|g" \
  "$TEMPLATE" > "$RENDERED" || die "cannot render plist"
if command -v plutil >/dev/null 2>&1; then
  plutil -lint "$RENDERED" >/dev/null || die "rendered plist is invalid"
fi

DEST_TMP="$DEST.tmp.$$"
cp "$RENDERED" "$DEST_TMP" || die "cannot stage plist copy"
chmod 644 "$DEST_TMP" || die "cannot set plist permissions"
mv -f "$DEST_TMP" "$DEST" || die "cannot atomically install plist"
DEST_TMP=""
[[ -f "$DEST" && ! -L "$DEST" ]] || die "installed plist failed regular-file verification"

"$LAUNCHCTL" bootout "$DOMAIN/$LABEL" >/dev/null 2>&1 || true
"$LAUNCHCTL" bootstrap "$DOMAIN" "$DEST" >/dev/null 2>&1 \
  || die "launchctl bootstrap failed for $LABEL"
"$LAUNCHCTL" print "$DOMAIN/$LABEL" >/dev/null 2>&1 \
  || die "launchctl accepted bootstrap but $LABEL is not loaded"

persist_claude_cleanup_period() {
  local claude_dir="$HOME/.claude" settings="$HOME/.claude/settings.json"
  local input tmp mode
  mkdir -p "$claude_dir" || { log "WARNING: cannot create $claude_dir"; return 0; }
  if [[ -e "$settings" && ( -L "$settings" || ! -f "$settings" ) ]]; then
    log "WARNING: settings.json is not a regular file; cleanupPeriodDays was not changed"
    return 0
  fi
  if [[ -f "$settings" ]]; then
    jq -e 'type == "object"' "$settings" >/dev/null 2>&1 || {
      log "WARNING: settings.json is invalid; cleanupPeriodDays was not changed"
      return 0
    }
    if jq -e 'has("cleanupPeriodDays")' "$settings" >/dev/null 2>&1; then
      log "settings.json already declares cleanupPeriodDays; left unchanged"
      return 0
    fi
    input="$settings"
    mode="$(stat -c %a "$settings" 2>/dev/null || stat -f %Lp "$settings" 2>/dev/null || printf '600\n')"
  else
    input=""
    mode="600"
  fi
  tmp="$(mktemp "$claude_dir/.settings.json.XXXXXX")" || {
    log "WARNING: cannot stage settings.json"; return 0;
  }
  if [[ -n "$input" ]]; then
    jq '. + {cleanupPeriodDays: 30}' "$input" > "$tmp" 2>/dev/null
  else
    jq -n '{cleanupPeriodDays: 30}' > "$tmp" 2>/dev/null
  fi
  if ! jq -e '.cleanupPeriodDays == 30' "$tmp" >/dev/null 2>&1; then
    log "WARNING: settings.json merge failed; original left unchanged"
    rm -f "$tmp"
    return 0
  fi
  chmod "$mode" "$tmp" 2>/dev/null || chmod 600 "$tmp" 2>/dev/null || true
  if ! mv -f "$tmp" "$settings"; then
    log "WARNING: cannot install merged settings.json; original left unchanged"
    rm -f "$tmp" 2>/dev/null || true
    return 0
  fi
  [[ "$(jq -r '.cleanupPeriodDays' "$settings" 2>/dev/null)" == "30" ]] \
    || log "WARNING: cleanupPeriodDays verification failed after write"
}

persist_claude_cleanup_period
log "installed and verified $LABEL at $DEST"
